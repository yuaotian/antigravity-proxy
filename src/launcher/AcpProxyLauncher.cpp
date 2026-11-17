// agy-acp-proxy.exe —— 让 ACP Agent 走 Antigravity-Proxy 的启动包装器（Issue #164）
//
// 用法：agy-acp-proxy.exe <目标程序> [参数...]
//   Zed / JetBrains / VS Code 等 ACP 客户端把本程序配置为 Agent 命令，参数里写真正的 Agent：
//     agy-acp-proxy.exe C:\Users\<你>\.gemini\bin\agy.exe acp
//     agy-acp-proxy.exe <Registry 安装目录>\agy_acp_server.exe
//
// 工作流程：
//   1. 挂起创建目标进程，stdin/stdout/stderr 直接继承（不读写、不解析 ACP 的 JSON-RPC 流量）；
//   2. 注入同目录下的代理 DLL（antigravity_proxy.dll 优先，其次 version.dll）；
//   3. 恢复目标进程，等待结束并透传退出码。
//   之后的子进程（PyInstaller 主体、localharness 引擎、agy 工作进程）由 DLL 的 CreateProcess Hook 继续注入。
//
// 约束：本程序绝不向 stdout 写任何内容（stdout 属于 ACP 协议通道），提示只写 stderr 与日志文件。

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>

#include <string>
#include <vector>

#include "../core/Logger.hpp"
#include "../injection/ProcessInjector.hpp"
#include "AcpProxyLauncherLogic.hpp"

namespace {

std::string WideToUtf8(const std::wstring& text) {
    if (text.empty()) return std::string();
    const int size = WideCharToMultiByte(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
    if (size <= 0) return std::string();
    std::string result(static_cast<size_t>(size), '\0');
    WideCharToMultiByte(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), &result[0], size, nullptr, nullptr);
    return result;
}

std::wstring Utf8ToWide(const std::string& text) {
    if (text.empty()) return std::wstring();
    const int size = MultiByteToWideChar(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), nullptr, 0);
    if (size <= 0) return std::wstring();
    std::wstring result(static_cast<size_t>(size), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, text.c_str(), static_cast<int>(text.size()), &result[0], size);
    return result;
}

// 只写 stderr：控制台用 WriteConsoleW 保证中文显示，管道（ACP 客户端日志）写 UTF-8 字节。
void WriteStderrLine(const std::wstring& text) {
    const HANDLE handle = GetStdHandle(STD_ERROR_HANDLE);
    if (handle == NULL || handle == INVALID_HANDLE_VALUE) return;
    const std::wstring line = L"[agy-acp-proxy] " + text + L"\r\n";
    DWORD written = 0;
    DWORD mode = 0;
    if (GetConsoleMode(handle, &mode)) {
        WriteConsoleW(handle, line.c_str(), static_cast<DWORD>(line.size()), &written, nullptr);
        return;
    }
    const std::string utf8 = WideToUtf8(line);
    WriteFile(handle, utf8.data(), static_cast<DWORD>(utf8.size()), &written, nullptr);
}

// 同一条信息同时写 stderr（客户端可见）与日志文件（事后排障）。
void ReportError(const std::wstring& text) {
    WriteStderrLine(text);
    Core::Logger::Error("[ACP 包装器] " + WideToUtf8(text));
}

std::wstring GetSelfDirectory() {
    std::vector<wchar_t> buffer(32768, L'\0');
    const DWORD len = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (len == 0 || len >= buffer.size()) return L"";
    return AcpLauncher::GetParentDirectory(std::wstring(buffer.data(), len));
}

bool IsRegularFile(const std::wstring& path) {
    const DWORD attrs = GetFileAttributesW(path.c_str());
    return attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

std::wstring FindProxyDll(const std::wstring& directory) {
    if (directory.empty()) return L"";
    for (const auto& name : AcpLauncher::ProxyDllCandidates()) {
        const std::wstring candidate = directory + L"\\" + name;
        if (IsRegularFile(candidate)) return candidate;
    }
    return L"";
}

// 确保标准句柄可被子进程继承；伪控制台句柄等设置失败时忽略（不影响管道场景）。
HANDLE PrepareInheritableStdHandle(DWORD stdHandleId) {
    const HANDLE handle = GetStdHandle(stdHandleId);
    if (handle == INVALID_HANDLE_VALUE) return NULL;
    if (handle != NULL) {
        SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    }
    return handle;
}

// Job 对象：包装器退出（含被 ACP 客户端强制结束）时，整棵 Agent 进程树一起结束，避免遗留孤儿进程。
// 允许子进程用 CREATE_BREAKAWAY_FROM_JOB 主动脱离，兼容需要常驻的后台工具。
HANDLE CreateKillOnCloseJob() {
    HANDLE job = CreateJobObjectW(nullptr, nullptr);
    if (job == NULL) return NULL;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
        CloseHandle(job);
        return NULL;
    }
    return job;
}

void PrintUsage() {
    WriteStderrLine(L"用法: agy-acp-proxy.exe <目标程序> [参数...]");
    WriteStderrLine(L"示例: agy-acp-proxy.exe C:\\Users\\<你>\\.gemini\\bin\\agy.exe acp");
    WriteStderrLine(L"说明: 代理 DLL（antigravity_proxy.dll 或 version.dll）与 config.json 需与本程序放在同一目录。");
}

}  // namespace

int wmain() {
    using namespace AcpLauncher;

    // Ctrl+C 交给目标进程自行处理（例如 `agy acp --login` 终端登录），包装器等待其退出后再透传退出码。
    SetConsoleCtrlHandler(nullptr, TRUE);

    const std::wstring childCommandLine = SkipFirstCommandLineToken(GetCommandLineW());
    if (childCommandLine.empty()) {
        PrintUsage();
        return kExitUsage;
    }
    const std::wstring target = ExtractFirstToken(childCommandLine);

    const std::wstring selfDir = GetSelfDirectory();
    const std::wstring dllPath = FindProxyDll(selfDir);
    if (dllPath.empty()) {
        ReportError(L"未在包装器目录找到代理 DLL（antigravity_proxy.dll / version.dll）: " + selfDir);
        return kExitDllMissing;
    }

    const HANDLE job = CreateKillOnCloseJob();
    if (job == NULL) {
        Core::Logger::Warn("[ACP 包装器] 创建 Job 对象失败，包装器退出时可能遗留子进程, err=" + std::to_string(GetLastError()));
    }

    STARTUPINFOW startupInfo = {};
    startupInfo.cb = sizeof(startupInfo);
    startupInfo.dwFlags = STARTF_USESTDHANDLES;
    startupInfo.hStdInput = PrepareInheritableStdHandle(STD_INPUT_HANDLE);
    startupInfo.hStdOutput = PrepareInheritableStdHandle(STD_OUTPUT_HANDLE);
    startupInfo.hStdError = PrepareInheritableStdHandle(STD_ERROR_HANDLE);

    // CreateProcessW 可能改写命令行缓冲区，必须传可写副本；lpApplicationName 为空时按系统规则搜索 PATH。
    std::vector<wchar_t> commandBuffer(childCommandLine.begin(), childCommandLine.end());
    commandBuffer.push_back(L'\0');

    PROCESS_INFORMATION processInfo = {};
    if (!CreateProcessW(nullptr, commandBuffer.data(), nullptr, nullptr, TRUE, CREATE_SUSPENDED,
                        nullptr, nullptr, &startupInfo, &processInfo)) {
        const DWORD err = GetLastError();
        ReportError(L"启动目标程序失败: " + target + L", GetLastError=" + std::to_wstring(err) +
                    L"（2/3=路径不存在，5=权限不足，193=架构不符）");
        if (job != NULL) CloseHandle(job);
        return kExitCreateFailed;
    }

    if (job != NULL && !AssignProcessToJobObject(job, processInfo.hProcess)) {
        Core::Logger::Warn("[ACP 包装器] 目标进程加入 Job 失败（可能已在不允许嵌套的 Job 中）, err=" +
                           std::to_string(GetLastError()));
    }

    std::string injectFailure;
    if (!Injection::ProcessInjector::InjectDll(processInfo.hProcess, dllPath, &injectFailure)) {
        // 宁可明确失败，也不让 Agent 在用户以为“已走代理”时悄悄直连
        TerminateProcess(processInfo.hProcess, kExitInjectFailed);
        CloseHandle(processInfo.hThread);
        CloseHandle(processInfo.hProcess);
        ReportError(L"注入代理 DLL 失败，已结束目标进程: " + target + L", 原因: " + Utf8ToWide(injectFailure));
        if (job != NULL) CloseHandle(job);
        return kExitInjectFailed;
    }

    Core::Logger::Info("[ACP 包装器] 已注入并启动目标: " + WideToUtf8(target) +
                       ", pid=" + std::to_string(processInfo.dwProcessId) + ", dll=" + WideToUtf8(dllPath));

    ResumeThread(processInfo.hThread);
    CloseHandle(processInfo.hThread);

    WaitForSingleObject(processInfo.hProcess, INFINITE);
    DWORD exitCode = 0;
    if (!GetExitCodeProcess(processInfo.hProcess, &exitCode)) exitCode = 1;
    CloseHandle(processInfo.hProcess);

    Core::Logger::Info("[ACP 包装器] 目标进程已退出: " + WideToUtf8(target) + ", exit=" + std::to_string(exitCode));
    // 关闭 Job 句柄：KILL_ON_JOB_CLOSE 会顺带清理仍残留的孙进程
    if (job != NULL) CloseHandle(job);
    return static_cast<int>(exitCode);
}
