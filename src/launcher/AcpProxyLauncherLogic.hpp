#pragma once

// agy-acp-proxy.exe 的纯逻辑部分（不调用任何 Win32 API，便于单元测试）。
// 背景见 docs/acp.md：ACP 客户端（JetBrains / Zed / VS Code 等）以子进程方式启动 Agent，
// 包装器负责把代理 DLL 注入到真正的 Agent 进程，stdio 只做句柄继承、不解析任何协议内容。

#include <string>
#include <vector>

namespace AcpLauncher {

inline bool IsCommandLineBlank(wchar_t ch) {
    return ch == L' ' || ch == L'\t';
}

// 去掉命令行中的第一个参数（包装器自身路径），其余部分原样返回。
// argv[0] 的切分规则与 CommandLineToArgvW 一致：
// - 以双引号开头时，直到下一个双引号为止（argv[0] 不处理反斜杠转义）；
// - 否则直到第一个空格或制表符为止。
// 剩余部分不做任何重新拼接，保证目标程序收到的参数转义与 ACP 客户端传入的完全一致。
inline std::wstring SkipFirstCommandLineToken(const std::wstring& commandLine) {
    size_t pos = 0;
    const size_t len = commandLine.size();
    while (pos < len && IsCommandLineBlank(commandLine[pos])) ++pos;
    if (pos >= len) return L"";

    if (commandLine[pos] == L'"') {
        const size_t closing = commandLine.find(L'"', pos + 1);
        // 引号未闭合时整行都属于 argv[0]，没有剩余参数
        if (closing == std::wstring::npos) return L"";
        pos = closing + 1;
    } else {
        while (pos < len && !IsCommandLineBlank(commandLine[pos])) ++pos;
    }

    while (pos < len && IsCommandLineBlank(commandLine[pos])) ++pos;
    return commandLine.substr(pos);
}

// 取命令行中的第一个参数（去掉外层引号），仅用于日志与报错提示。
// 只记录目标程序，不记录后续参数，避免把可能含有密钥的参数写进日志。
inline std::wstring ExtractFirstToken(const std::wstring& commandLine) {
    const std::wstring rest = SkipFirstCommandLineToken(commandLine);
    std::wstring token = commandLine.substr(0, commandLine.size() - rest.size());
    size_t begin = 0;
    size_t end = token.size();
    while (begin < end && IsCommandLineBlank(token[begin])) ++begin;
    while (end > begin && IsCommandLineBlank(token[end - 1])) --end;
    token = token.substr(begin, end - begin);
    if (token.size() >= 2 && token.front() == L'"' && token.back() == L'"') {
        token = token.substr(1, token.size() - 2);
    }
    return token;
}

// 注入用代理 DLL 的候选文件名（按优先级）：
// - antigravity_proxy.dll：CLI 发布包（output\cli）与 agy.exe 目录部署时的名称；
// - version.dll：IDE 插件把包装器部署到 IDE 安装目录时，与 IDE 共用同一份 DLL 和 config.json。
inline const std::vector<std::wstring>& ProxyDllCandidates() {
    static const std::vector<std::wstring> candidates = {
        L"antigravity_proxy.dll",
        L"version.dll",
    };
    return candidates;
}

// 取路径所在目录（不含末尾分隔符）；没有分隔符时返回空串。
inline std::wstring GetParentDirectory(const std::wstring& path) {
    const size_t slash = path.find_last_of(L"\\/");
    return slash == std::wstring::npos ? L"" : path.substr(0, slash);
}

// 包装器退出码约定（目标程序正常运行时透传其自身退出码）。
enum ExitCode : int {
    kExitUsage = 2,          // 未提供目标程序
    kExitDllMissing = 3,     // 包装器同目录下找不到代理 DLL
    kExitCreateFailed = 4,   // 目标程序启动失败（路径错误 / 权限 / 架构不符）
    kExitInjectFailed = 5,   // 注入失败（已结束目标进程，避免“悄悄直连”）
};

}  // namespace AcpLauncher
