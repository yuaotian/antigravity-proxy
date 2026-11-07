// 防止 windows.h 自动包含 winsock.h (避免与 winsock2.h 冲突)
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>
#include <cwchar>
#include <fstream>
#include <memory>
#include <sstream>
#include <string>
#include "core/Config.hpp"
#include "core/DllIdentity.hpp"
#include "core/Logger.hpp"
#include "hooks/ProcessName.hpp"
#include "ide/IdeExtensionPrompt.hpp"
#include "update/UpdateChecker.hpp"

// 前向声明
namespace Hooks {
    void Install(bool enableNetworkHooks);
    void Uninstall();
}

namespace VersionProxy {
    bool Initialize();
    void Uninitialize();
}

namespace {
    static bool IsCommandLineWhitespace(wchar_t value) {
        return value == L' ' || value == L'\t' || value == L'\r' || value == L'\n';
    }

    static bool IsOpenUrlArgument(const wchar_t* begin, const wchar_t* end) {
        constexpr wchar_t kOpenUrlSwitch[] = L"--open-url";
        const wchar_t* cursor = begin;
        for (const wchar_t* expected = kOpenUrlSwitch; *expected != L'\0'; ++expected) {
            while (cursor < end && *cursor == L'"') ++cursor;
            if (cursor == end || *cursor != *expected) return false;
            ++cursor;
        }

        while (cursor < end && *cursor == L'"') ++cursor;
        return cursor == end || *cursor == L'=';
    }

    static bool IsOpenUrlProtocolLaunch() {
        // 只按参数边界检查启动标记，不复制、保存或记录可能包含 URL、查询参数及令牌的内容。
        const wchar_t* cursor = GetCommandLineW();
        if (cursor == nullptr) return false;

        while (*cursor != L'\0') {
            while (IsCommandLineWhitespace(*cursor)) ++cursor;
            if (*cursor == L'\0') break;

            const wchar_t* argumentBegin = cursor;
            bool inQuotes = false;
            unsigned int precedingBackslashes = 0;
            while (*cursor != L'\0') {
                const wchar_t value = *cursor;
                if (value == L'\\') {
                    ++precedingBackslashes;
                    ++cursor;
                    continue;
                }
                if (value == L'"' && (precedingBackslashes % 2) == 0) {
                    inQuotes = !inQuotes;
                } else if (!inQuotes && IsCommandLineWhitespace(value)) {
                    break;
                }
                precedingBackslashes = 0;
                ++cursor;
            }

            if (IsOpenUrlArgument(argumentBegin, cursor)) return true;
        }
        return false;
    }

    static std::string GetCurrentProcessBaseName() {
        char processPath[MAX_PATH] = {0};
        const DWORD len = GetModuleFileNameA(NULL, processPath, MAX_PATH);
        if (len == 0 || len >= MAX_PATH) return "Unknown";
        return Hooks::ExtractBaseNameFromPathLike(processPath);
    }

    static bool IsChromiumNetworkServiceProcess() {
        const wchar_t* commandLine = GetCommandLineW();
        return commandLine != nullptr &&
               std::wcsstr(commandLine, L"--utility-sub-type=network.mojom.NetworkService") != nullptr;
    }

    struct LoadNotifyPayload {
        bool success;
        bool askOpenLogs;
        std::wstring message;
    };

    static std::wstring Utf8ToWideLocal(const std::string& input) {
        if (input.empty()) return L"";
        int len = MultiByteToWideChar(CP_UTF8, 0, input.c_str(), -1, NULL, 0);
        if (len <= 0) return L"";
        std::wstring result(len, L'\0');
        MultiByteToWideChar(CP_UTF8, 0, input.c_str(), -1, &result[0], len);
        if (!result.empty() && result.back() == L'\0') result.pop_back();
        return result;
    }

    static std::string GetLoadNotifyMarkerPath(const std::string& logDir) {
        if (logDir.empty()) return "";
        return logDir + "\\load-notify-success.marker";
    }

    static bool HasShownSuccessForCurrentBuild(const std::string& markerPath, const std::string& identity) {
        if (markerPath.empty()) return false;
        std::ifstream f(markerPath);
        if (!f.is_open()) return false;
        std::string saved;
        std::getline(f, saved);
        return saved == identity;
    }

    static void MarkSuccessForCurrentBuild(const std::string& markerPath, const std::string& identity) {
        if (markerPath.empty()) return;
        std::ofstream f(markerPath, std::ios::out | std::ios::trunc);
        if (f.is_open()) {
            f << identity << "\n";
        }
    }

    static void OpenLogDirectoryIfNeeded(HMODULE shell32, const std::string& logDir) {
        if (!shell32 || logDir.empty()) return;
        using ShellExecuteWFn = HINSTANCE (WINAPI*)(HWND, LPCWSTR, LPCWSTR, LPCWSTR, LPCWSTR, INT);
        auto shellExecuteW = reinterpret_cast<ShellExecuteWFn>(GetProcAddress(shell32, "ShellExecuteW"));
        if (!shellExecuteW) return;
        const std::wstring wideDir = Utf8ToWideLocal(logDir);
        if (wideDir.empty()) return;
        shellExecuteW(NULL, L"open", wideDir.c_str(), NULL, NULL, SW_SHOWNORMAL);
    }

    DWORD WINAPI LoadNotifyThreadProc(LPVOID param) {
        std::unique_ptr<LoadNotifyPayload> payload(reinterpret_cast<LoadNotifyPayload*>(param));
        if (!payload) return 0;

        // 延迟到 DllMain 返回后再按需加载 user32，避免默认导入 UI 库并降低加载期行为面。
        Sleep(800);
        HMODULE user32 = LoadLibraryW(L"user32.dll");
        if (!user32) return 0;

        using MessageBoxWFn = int (WINAPI*)(HWND, LPCWSTR, LPCWSTR, UINT);
        auto messageBoxW = reinterpret_cast<MessageBoxWFn>(GetProcAddress(user32, "MessageBoxW"));
        if (!messageBoxW) {
            FreeLibrary(user32);
            return 0;
        }

        UINT flags = MB_TOPMOST | MB_SETFOREGROUND | (payload->success ? MB_ICONINFORMATION : MB_ICONERROR);
        flags |= payload->askOpenLogs ? MB_YESNO : MB_OK;
        int result = messageBoxW(
            NULL,
            payload->message.c_str(),
            L"Antigravity-Proxy 加载状态",
            flags
        );

        if (payload->askOpenLogs && result == IDYES) {
            HMODULE shell32 = LoadLibraryW(L"shell32.dll");
            if (shell32) {
                OpenLogDirectoryIfNeeded(shell32, Core::Logger::GetLogDirectoryPath());
                FreeLibrary(shell32);
            }
        }
        FreeLibrary(user32);
        return 0;
    }

    void MaybeShowLoadNotifyAsync(bool success) {
        const auto& config = Core::Config::Instance();
        if (config.uiLoadNotify == "none") return;

        const std::string logDir = Core::Logger::GetLogDirectoryPath();
        const std::string markerPath = GetLoadNotifyMarkerPath(logDir);
        const std::string identity = Core::GetDllIdentity();
        const bool onceMode = config.uiLoadNotify == "once";
        if (success && onceMode && HasShownSuccessForCurrentBuild(markerPath, identity)) {
            return;
        }

        auto* payload = new LoadNotifyPayload{};
        payload->success = success;
        payload->askOpenLogs = true;
        if (success) {
            payload->message =
                L"Antigravity-Proxy 已加载成功，配置读取成功，API Hook 安装流程已执行。\n\n"
                L"后续同一版本成功加载不会继续弹窗；更新到新版 DLL 后会再次提示一次。\n\n"
                L"是否打开日志目录，查看加载与代理排障信息？";
        } else {
            payload->message =
                L"Antigravity-Proxy 已加载，但配置读取失败，当前已进入 BYPASS 模式（不安装 Hooks）。\n\n"
                L"请检查 config.json 与日志告警信息。\n\n"
                L"是否打开日志目录进行排查？";
        }

        HANDLE hThread = CreateThread(NULL, 0, LoadNotifyThreadProc, payload, 0, NULL);
        if (hThread) {
            CloseHandle(hThread);
            if (success && onceMode) {
                MarkSuccessForCurrentBuild(markerPath, identity);
            }
        } else {
            delete payload;
            Core::Logger::Warn("加载提示线程启动失败, err=" + std::to_string(GetLastError()));
        }
    }
}

BOOL WINAPI DllMain(HINSTANCE hinstDLL, DWORD fdwReason, LPVOID lpvReserved) {
    switch (fdwReason) {
    case DLL_PROCESS_ATTACH: {
        DisableThreadLibraryCalls(hinstDLL);
        
        // ============================================================================
        // VersionProxy 采用懒加载模式 (Lazy Initialization)
        // Initialize() 现在是空操作，真正的系统 version.dll 会在导出函数首次被调用时加载
        // 这样可以避免在 DllMain 中调用 LoadLibraryW 导致的 Loader Lock 问题
        // （可能触发 0xc0000022 STATUS_ACCESS_DENIED 错误）
        // ============================================================================
        VersionProxy::Initialize();  // 空操作，保持接口兼容
        
        Core::Logger::Info("Antigravity-Proxy DLL 已加载 (模拟 version.dll)");
        Core::Logger::Info(IsOpenUrlProtocolLaunch()
            ? "启动类型：协议启动"
            : "启动类型：普通启动");
        
        // 加载配置
        const bool loaded = Core::Config::Instance().Load("config.json");
        
        // WARN-4: 必须检查 Load() 返回值。若加载失败则进入 BYPASS 模式，避免“坏配置导致全局网络不可用”。
        if (!loaded) {
            Core::Logger::Error("配置加载失败：已进入 BYPASS 模式（不安装 Hooks）。请检查 config.json 与日志告警信息。");
            MaybeShowLoadNotifyAsync(false);
            break;
        }

        // 诊断构建：只旁路 Chromium NetworkService，用于区分宿主进程角色对本地 TLS 的影响。
        const std::string processName = GetCurrentProcessBaseName();
        const bool bypassNetworkService =
            Hooks::IsAntigravityHostProcessName(processName) && IsChromiumNetworkServiceProcess();
        const bool enableNetworkHooks = !bypassNetworkService;
        Core::Logger::Info(enableNetworkHooks
            ? "当前进程 " + processName + " 使用全量模式：安装网络与进程创建 Hook"
            : "当前进程 " + processName + " 使用 NetworkService 旁路模式：仅安装进程创建 Hook");
        Hooks::Install(enableNetworkHooks);
        MaybeShowLoadNotifyAsync(true);
        // IDE 主进程：检测配套插件是否安装，未安装时后台询问并一键安装（其它进程内部直接返回）
        IdeExtension::MaybePromptInstallAsync(IsOpenUrlProtocolLaunch());
        // 更新检查默认关闭；启用后也只在后台异步提示，不阻塞 Hook 安装主流程。
        UpdateChecker::StartAsync();
        break;
    }
        
    case DLL_PROCESS_DETACH: {
        if (lpvReserved != nullptr) {
            // 进程终止时其他模块和线程状态不可控；仅保留一次日志作为原因证据，不执行复杂清理。
            Core::Logger::TryInfoAtProcessDetach("进程终止，DLL 随当前进程分离：已跳过 Hooks 与版本代理清理");
            break;
        }

        // lpvReserved 为空表示动态卸载，或 DLL 加载失败后的回滚；此时保留必要清理。
        Hooks::Uninstall();
        VersionProxy::Uninitialize();
        Core::Logger::Info("DLL 被显式释放或加载失败回滚：已完成 Hooks 与版本代理清理");
        break;
    }
    }
    return TRUE;
}
