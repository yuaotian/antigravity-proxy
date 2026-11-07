// IDE 配套插件安装提示：DLL 在 Antigravity IDE 主进程中检测插件是否安装，未安装时用系统通知轻提示。
//
// 设计要点：
// - 只在 IDE 主进程运行（排除 Electron 子进程、ELECTRON_RUN_AS_NODE 命令行模式、--open-url 协议启动）；
// - 后台线程延迟执行，不阻塞 DllMain 与 Hook 安装；user32 / shell32 按需动态加载（version.dll 不静态依赖它们）；
// - 提示方式为系统通知（托盘气泡，Win10/11 显示为通知卡片），不抢焦点、不打断操作；点击通知才继续，忽略视为暂不安装；
// - 每个 DLL 版本最多提示一次（标记文件写在日志目录，与加载提示同机制）；每一步都写日志，便于排查；
// - DLL 同目录有 VSIX：点击通知即视为同意，复用 IDE 自带命令行 bin\antigravity-ide.cmd --install-extension 本地静默安装，
//   实测运行中的 IDE 会自动加载新安装的插件，无需重启；插件随即接管首次引导（检测/扫描代理）；
// - 只装了 DLL（同目录无 VSIX）：点击通知后弹确认框展示将执行的完整命令，用户同意后在可见的 PowerShell 窗口中运行
//   在线安装脚本 install-online.ps1 -ExtensionOnly（只装插件，不动 DLL 与配置；系统自带的 Windows PowerShell 5.1 即可）。

#include "ide/IdeExtensionPrompt.hpp"

#include <windows.h>
#include <shellapi.h>

#include <algorithm>
#include <cwchar>
#include <fstream>
#include <memory>
#include <string>
#include <vector>

#include "core/DllIdentity.hpp"
#include "core/Logger.hpp"
#include "ide/IdeExtensionLogic.hpp"
#include "injection/ProcessInjector.hpp"

namespace IdeExtension {
namespace {

enum class UiLang { Zh, En, Ru };

// 提示语言跟随系统界面语言（与原生启动器一致）
UiLang DetectUiLang() {
    switch (PRIMARYLANGID(GetUserDefaultUILanguage())) {
    case LANG_CHINESE: return UiLang::Zh;
    case LANG_RUSSIAN: return UiLang::Ru;
    default: return UiLang::En;
    }
}

std::string WideToUtf8(const std::wstring& w) {
    if (w.empty()) return "";
    const int len = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
    if (len <= 0) return "";
    std::string out(static_cast<size_t>(len), '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), &out[0], len, nullptr, nullptr);
    return out;
}

std::wstring Utf8ToWide(const std::string& s) {
    if (s.empty()) return L"";
    const int len = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), nullptr, 0);
    if (len <= 0) return L"";
    std::wstring out(static_cast<size_t>(len), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), &out[0], len);
    return out;
}

std::wstring GetModulePathW(HMODULE module) {
    std::vector<wchar_t> buf(MAX_PATH);
    for (;;) {
        const DWORD n = GetModuleFileNameW(module, buf.data(), static_cast<DWORD>(buf.size()));
        if (n == 0) return L"";
        if (n < buf.size()) return std::wstring(buf.data(), n);
        if (buf.size() >= 32768) return L"";
        buf.resize(buf.size() * 2);
    }
}

std::wstring DirName(const std::wstring& path) {
    const size_t i = path.find_last_of(L"\\/");
    return i == std::wstring::npos ? L"" : path.substr(0, i);
}

std::wstring BaseName(const std::wstring& path) {
    const size_t i = path.find_last_of(L"\\/");
    return i == std::wstring::npos ? path : path.substr(i + 1);
}

std::wstring GetEnvW(const wchar_t* name) {
    const DWORD n = GetEnvironmentVariableW(name, nullptr, 0);
    if (n == 0) return L"";
    std::wstring value(n, L'\0');
    const DWORD got = GetEnvironmentVariableW(name, &value[0], n);
    value.resize(got);
    return value;
}

bool FileExistsW(const std::wstring& path) {
    const DWORD attr = GetFileAttributesW(path.c_str());
    return attr != INVALID_FILE_ATTRIBUTES && (attr & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

// 用 Win32 API 读取小文件（兼容 MinGW：其 std::ifstream 不支持宽字符路径）
std::string ReadSmallFile(const std::wstring& path, DWORD maxBytes) {
    HANDLE h = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                           nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return "";
    std::string out;
    char buf[8192];
    DWORD read = 0;
    while (out.size() < maxBytes && ReadFile(h, buf, sizeof(buf), &read, nullptr) && read > 0) {
        out.append(buf, read);
    }
    CloseHandle(h);
    return out;
}

struct Payload {
    HMODULE module;        // 本 DLL 模块（注册通知窗口类）
    std::wstring exePath;  // IDE 主程序路径（通知图标取自主程序）
    std::wstring exeDir;   // IDE 安装目录（主程序所在目录）
    std::wstring vsix;     // DLL 同目录的插件包；为空表示只装了 DLL，走在线安装
    std::wstring cmdLine;  // IDE 主进程命令行（读取 --extensions-dir / --user-data-dir）
};

// 扩展目录：命令行 --extensions-dir > 便携模式 VSCODE_PORTABLE > %USERPROFILE%\<dataFolderName>\extensions
std::wstring ResolveExtensionsDir(const Payload& p, bool* custom) {
    const std::wstring arg = GetArgValue(p.cmdLine, L"--extensions-dir");
    if (!arg.empty()) {
        *custom = true;
        return arg;
    }
    *custom = false;
    const std::wstring portable = GetEnvW(L"VSCODE_PORTABLE");
    if (!portable.empty()) return portable + L"\\extensions";
    const std::string product = ReadSmallFile(p.exeDir + L"\\resources\\app\\product.json", 1u << 20);
    return GetEnvW(L"USERPROFILE") + L"\\" + Utf8ToWide(ParseDataFolderName(product)) + L"\\extensions";
}

// 插件是否已安装：优先查 extensions.json 清单，缺失时退回目录匹配
bool IsInstalled(const std::wstring& extDir) {
    const std::string json = ReadSmallFile(extDir + L"\\extensions.json", 16u << 20);
    if (!json.empty()) return ExtensionsJsonHasId(json, ExtensionId());
    WIN32_FIND_DATAW fd{};
    HANDLE h = FindFirstFileW((extDir + L"\\" + Utf8ToWide(ExtensionId()) + L"-*").c_str(), &fd);
    if (h == INVALID_HANDLE_VALUE) return false;
    bool found = false;
    do {
        if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            found = true;
            break;
        }
    } while (FindNextFileW(h, &fd));
    FindClose(h);
    return found;
}

std::string MarkerPath() {
    const std::string dir = Core::Logger::GetLogDirectoryPath();
    return dir.empty() ? "" : dir + "\\ide-extension-prompt.marker";
}

bool AskedForThisBuild(const std::string& marker, const std::string& identity) {
    if (marker.empty()) return false;
    std::ifstream f(marker);
    std::string saved;
    return f.is_open() && std::getline(f, saved) && saved == identity;
}

void MarkAsked(const std::string& marker, const std::string& identity) {
    if (marker.empty()) return;
    std::ofstream f(marker, std::ios::out | std::ios::trunc);
    if (f.is_open()) f << identity << "\n";
}

int ShowMessage(const std::wstring& text, UINT flags) {
    HMODULE user32 = LoadLibraryW(L"user32.dll");
    if (!user32) return 0;
    using MessageBoxWFn = int(WINAPI*)(HWND, LPCWSTR, LPCWSTR, UINT);
    auto messageBoxW = reinterpret_cast<MessageBoxWFn>(GetProcAddress(user32, "MessageBoxW"));
    const int result = messageBoxW ? messageBoxW(nullptr, text.c_str(), L"Antigravity Proxy", flags | MB_TOPMOST | MB_SETFOREGROUND) : 0;
    FreeLibrary(user32);
    return result;
}

// ---------------------------------------------------------------------------
// 系统通知（托盘气泡）：后台线程内建消息窗口 + 消息循环，点击通知或托盘图标视为同意，到截止时间未点击视为忽略
// ---------------------------------------------------------------------------

enum class NotifyResult { Clicked, Ignored, Failed };

constexpr UINT kNotifyCallbackMsg = WM_APP + 1;
constexpr UINT_PTR kNotifyTimerId = 1;
constexpr int kQuitClicked = 1;
// 通知有效期：Win10/11 的通知卡片约 5 秒后收进通知中心，托盘图标保留到截止时间，期间从通知中心或托盘图标点击仍有效
constexpr UINT kNotifyLifetimeMs = 90000;

// 动态导入的 user32 / shell32 函数（version.dll 只静态链接 ws2_32 / winhttp，避免给每个被注入的进程引入 user32）
struct NotifyApi {
    HMODULE user32 = nullptr;
    HMODULE shell32 = nullptr;
    decltype(&RegisterClassExW) registerClassExW = nullptr;
    decltype(&UnregisterClassW) unregisterClassW = nullptr;
    decltype(&CreateWindowExW) createWindowExW = nullptr;
    decltype(&DestroyWindow) destroyWindow = nullptr;
    decltype(&DefWindowProcW) defWindowProcW = nullptr;
    decltype(&GetMessageW) getMessageW = nullptr;
    decltype(&DispatchMessageW) dispatchMessageW = nullptr;
    decltype(&PostQuitMessage) postQuitMessage = nullptr;
    decltype(&SetTimer) setTimer = nullptr;
    decltype(&LoadIconW) loadIconW = nullptr;
    decltype(&DestroyIcon) destroyIcon = nullptr;
    decltype(&Shell_NotifyIconW) shellNotifyIconW = nullptr;
    decltype(&ExtractIconExW) extractIconExW = nullptr;

    NotifyApi() = default;
    NotifyApi(const NotifyApi&) = delete;
    NotifyApi& operator=(const NotifyApi&) = delete;
    ~NotifyApi() {
        if (shell32) FreeLibrary(shell32);
        if (user32) FreeLibrary(user32);
    }
};

template <typename Fn>
bool LoadFn(HMODULE module, const char* name, Fn* out) {
    *out = module ? reinterpret_cast<Fn>(GetProcAddress(module, name)) : nullptr;
    return *out != nullptr;
}

bool LoadNotifyApi(NotifyApi* api) {
    api->user32 = LoadLibraryW(L"user32.dll");
    api->shell32 = LoadLibraryW(L"shell32.dll");
    HMODULE u = api->user32;
    HMODULE s = api->shell32;
    return LoadFn(u, "RegisterClassExW", &api->registerClassExW) && LoadFn(u, "UnregisterClassW", &api->unregisterClassW) &&
           LoadFn(u, "CreateWindowExW", &api->createWindowExW) && LoadFn(u, "DestroyWindow", &api->destroyWindow) &&
           LoadFn(u, "DefWindowProcW", &api->defWindowProcW) && LoadFn(u, "GetMessageW", &api->getMessageW) &&
           LoadFn(u, "DispatchMessageW", &api->dispatchMessageW) && LoadFn(u, "PostQuitMessage", &api->postQuitMessage) &&
           LoadFn(u, "SetTimer", &api->setTimer) && LoadFn(u, "LoadIconW", &api->loadIconW) &&
           LoadFn(u, "DestroyIcon", &api->destroyIcon) && LoadFn(s, "Shell_NotifyIconW", &api->shellNotifyIconW) &&
           LoadFn(s, "ExtractIconExW", &api->extractIconExW);
}

// 窗口过程无法携带上下文；每个进程只有一个提示线程，用文件内静态变量即可
const NotifyApi* g_notifyApi = nullptr;
// 实测「气泡收起」事件会连续到达两次，只记一次日志
bool g_balloonHiddenLogged = false;

LRESULT CALLBACK NotifyWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    if (msg == kNotifyCallbackMsg) {
        // 未调用 NIM_SETVERSION（旧版回调约定）：lParam 即事件
        const UINT event = static_cast<UINT>(lParam);
        if (event == NIN_BALLOONUSERCLICK || event == WM_LBUTTONUP) {
            g_notifyApi->postQuitMessage(kQuitClicked);
        } else if (event == NIN_BALLOONTIMEOUT && !g_balloonHiddenLogged) {
            g_balloonHiddenLogged = true;
            Core::Logger::Info("IDE 配套插件安装通知已收起（超时或被关闭）；截止前从通知中心或托盘图标点击仍可安装");
        }
        return 0;
    }
    if (msg == WM_TIMER && wParam == kNotifyTimerId) {
        g_notifyApi->postQuitMessage(0);
        return 0;
    }
    return g_notifyApi->defWindowProcW(hwnd, msg, wParam, lParam);
}

void CopyTruncated(wchar_t* dst, size_t cap, const std::wstring& src) {
    const size_t n = std::min(src.size(), cap - 1);
    wmemcpy(dst, src.data(), n);
    dst[n] = L'\0';
}

NotifyResult ShowNotification(HMODULE module, const std::wstring& exePath, const std::wstring& title, const std::wstring& text) {
    NotifyApi api;
    if (!LoadNotifyApi(&api)) return NotifyResult::Failed;
    g_notifyApi = &api;
    g_balloonHiddenLogged = false;

    const wchar_t* kClass = L"AntigravityProxyIdeExtensionNotify";
    WNDCLASSEXW wc{};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = NotifyWndProc;
    wc.hInstance = module;
    wc.lpszClassName = kClass;
    if (!api.registerClassExW(&wc)) {
        g_notifyApi = nullptr;
        return NotifyResult::Failed;
    }
    // 仅消息窗口（HWND_MESSAGE）：不可见、不出现在任务栏，只接收托盘回调与定时器
    HWND hwnd = api.createWindowExW(0, kClass, L"", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr, module, nullptr);

    NotifyResult result = NotifyResult::Failed;
    if (hwnd) {
        // 托盘图标取 IDE 主程序图标，让用户一眼看出通知来自 IDE；取不到时用系统信息图标
        HICON icon = nullptr;
        const bool ownIcon = api.extractIconExW(exePath.c_str(), 0, nullptr, &icon, 1) > 0 && icon != nullptr;
        if (!ownIcon) icon = api.loadIconW(nullptr, MAKEINTRESOURCEW(32516) /* IDI_INFORMATION */);

        NOTIFYICONDATAW nid{};
        nid.cbSize = sizeof(nid);
        nid.hWnd = hwnd;
        nid.uID = 1;
        nid.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_INFO;
        nid.uCallbackMessage = kNotifyCallbackMsg;
        nid.hIcon = icon;
        nid.dwInfoFlags = NIIF_INFO;
        CopyTruncated(nid.szTip, ARRAYSIZE(nid.szTip), title);
        CopyTruncated(nid.szInfoTitle, ARRAYSIZE(nid.szInfoTitle), title);
        CopyTruncated(nid.szInfo, ARRAYSIZE(nid.szInfo), text);
        if (api.shellNotifyIconW(NIM_ADD, &nid)) {
            api.setTimer(hwnd, kNotifyTimerId, kNotifyLifetimeMs, nullptr);
            MSG msg{};
            BOOL got = FALSE;
            while ((got = api.getMessageW(&msg, nullptr, 0, 0)) > 0) api.dispatchMessageW(&msg);
            result = (got == 0 && msg.wParam == static_cast<WPARAM>(kQuitClicked)) ? NotifyResult::Clicked : NotifyResult::Ignored;
            // 删除托盘图标，通知中心里对应的通知随之移除
            api.shellNotifyIconW(NIM_DELETE, &nid);
        }
        if (ownIcon) api.destroyIcon(icon);
        api.destroyWindow(hwnd);
    }
    api.unregisterClassW(kClass, module);
    g_notifyApi = nullptr;
    return result;
}

// ---------------------------------------------------------------------------
// 文案（简体中文 / English / Русский）
// ---------------------------------------------------------------------------

// 通知标题上限 63 字符、正文上限 255 字符（NOTIFYICONDATAW），超出会被截断
std::wstring NotifyTitle(UiLang lang) {
    switch (lang) {
    case UiLang::Zh: return L"建议安装 Antigravity Proxy 配套插件";
    case UiLang::Ru: return L"Установите расширение Antigravity Proxy";
    default: return L"Install the Antigravity Proxy companion extension";
    }
}

std::wstring NotifyText(UiLang lang, bool local) {
    switch (lang) {
    case UiLang::Zh:
        return std::wstring(L"方便管理代理配置：状态栏显示代理状态、可视化设置、IDE 更新后自动修复补丁。") +
               (local ? L"点击此通知立即安装（本地安装，无需重启）。" : L"点击此通知在线安装（执行前会先确认）。");
    case UiLang::Ru:
        return std::wstring(L"Удобное управление прокси: статус в строке состояния, визуальные настройки, "
                            L"восстановление патча после обновлений IDE. ") +
               (local ? L"Нажмите, чтобы установить (локально, без перезапуска)." : L"Нажмите, чтобы установить онлайн (сначала будет подтверждение).");
    default:
        return std::wstring(L"Manage proxy settings easily: status bar indicator, visual settings, patch repair after IDE updates. ") +
               (local ? L"Click to install now (local, no restart)." : L"Click to install online (you'll confirm first).");
    }
}

std::wstring ConfirmOnlineText(UiLang lang, const std::wstring& command) {
    switch (lang) {
    case UiLang::Zh:
        return L"将打开一个 PowerShell 窗口，在线安装 Antigravity Proxy 配套插件：\n\n"
               L"• 安装脚本经 wget.la 镜像获取；插件安装包从 GitHub Release 下载（直连失败自动换镜像），并做 SHA256 校验\n"
               L"• 下载流量与 IDE 一样走 config.json 中的代理\n"
               L"• 只安装插件，不修改 version.dll 与 config.json\n"
               L"• 运行中的 IDE 会自动加载插件，无需重启\n\n"
               L"将执行的命令：\n" + command + L"\n\n是否继续？（选择「否」后本版本不再提示）";
    case UiLang::Ru:
        return L"Откроется окно PowerShell для онлайн-установки расширения Antigravity Proxy:\n\n"
               L"• скрипт установки загружается через зеркало wget.la; пакет расширения — из GitHub Release "
               L"(при сбое прямого соединения — через зеркала) с проверкой SHA256\n"
               L"• загрузка идёт через прокси из config.json, как и у IDE\n"
               L"• устанавливается только расширение, version.dll и config.json не изменяются\n"
               L"• запущенная IDE загрузит расширение автоматически, без перезапуска\n\n"
               L"Будет выполнена команда:\n" + command +
               L"\n\nПродолжить? (Если выбрать «Нет», для этой версии вопрос больше не появится.)";
    default:
        return L"A PowerShell window will open to install the Antigravity Proxy companion extension online:\n\n"
               L"• The install script is fetched via the wget.la mirror; the extension package is downloaded from GitHub Release "
               L"(falling back to mirrors) and verified with SHA256\n"
               L"• Downloads go through the proxy in config.json, same as the IDE\n"
               L"• Only the extension is installed; version.dll and config.json are not modified\n"
               L"• A running IDE loads the extension automatically, no restart needed\n\n"
               L"Command to run:\n" + command + L"\n\nContinue? (If you choose \"No\", you won't be asked again for this version.)";
    }
}

std::wstring ClosePromptText(UiLang lang) {
    switch (lang) {
    case UiLang::Zh: return L"执行结束，按回车键关闭此窗口";
    case UiLang::Ru: return L"Завершено. Нажмите Enter, чтобы закрыть окно";
    default: return L"Finished. Press Enter to close this window";
    }
}

std::wstring LaunchFailText(UiLang lang, DWORD err, const std::wstring& command) {
    const std::wstring code = std::to_wstring(err);
    switch (lang) {
    case UiLang::Zh:
        return L"无法打开 PowerShell 窗口（错误 " + code + L"）。\n\n可手动打开 PowerShell 执行：\n" + command;
    case UiLang::Ru:
        return L"Не удалось открыть окно PowerShell (ошибка " + code + L").\n\nОткройте PowerShell вручную и выполните:\n" + command;
    default:
        return L"Could not open a PowerShell window (error " + code + L").\n\nOpen PowerShell manually and run:\n" + command;
    }
}

std::wstring FailText(UiLang lang, const std::wstring& reason, const std::wstring& vsix) {
    switch (lang) {
    case UiLang::Zh:
        return L"插件安装失败（" + reason + L"）。\n\n可在 IDE 中手动安装：扩展视图 → 右上角「…」→「从 VSIX 安装…」，选择：\n" + vsix;
    case UiLang::Ru:
        return L"Не удалось установить расширение (" + reason + L").\n\nУстановите его вручную: представление «Расширения» → меню «…» → «Установить из VSIX…», затем выберите:\n" + vsix;
    default:
        return L"Failed to install the extension (" + reason + L").\n\nYou can install it manually: Extensions view → \"…\" menu → \"Install from VSIX…\", then choose:\n" + vsix;
    }
}

// ---------------------------------------------------------------------------
// 安装
// ---------------------------------------------------------------------------

// 子进程环境：剔除 IDE 内部变量（ELECTRON_* / VSCODE_* / CHROME_CRASHPAD_*），
// 避免命令行工具以错误模式运行或连接到当前实例的 IPC
std::vector<wchar_t> BuildSanitizedEnvironment() {
    std::vector<wchar_t> out;
    LPWCH env = GetEnvironmentStringsW();
    if (!env) return out;
    for (LPCWSTR p = env; *p; p += wcslen(p) + 1) {
        const std::wstring kv(p);
        const std::wstring name = kv.substr(0, kv.find(L'=', 1));
        auto startsWith = [&](const wchar_t* prefix) {
            const std::wstring pre(prefix);
            return name.size() >= pre.size() && EqualsIgnoreCase(name.substr(0, pre.size()), pre);
        };
        if (startsWith(L"ELECTRON_") || startsWith(L"VSCODE_") || startsWith(L"CHROME_CRASHPAD_")) continue;
        out.insert(out.end(), kv.begin(), kv.end());
        out.push_back(L'\0');
    }
    out.push_back(L'\0');
    FreeEnvironmentStringsW(env);
    return out;
}

// 调用 IDE 自带命令行安装插件；返回 Win32 错误码（ERROR_SUCCESS 表示进程正常结束，退出码见 exitCode）
DWORD RunInstall(const Payload& p, const std::wstring& extDir, bool customExtDir, DWORD* exitCode) {
    const std::wstring cli = p.exeDir + L"\\bin\\antigravity-ide.cmd";
    if (!FileExistsW(cli)) return ERROR_FILE_NOT_FOUND;

    std::wstring args = L"\"" + cli + L"\" --install-extension \"" + p.vsix + L"\" --force";
    // 便携/多配置用户：沿用主进程的扩展目录与用户数据目录，装到当前实例实际使用的位置
    if (customExtDir) args += L" --extensions-dir \"" + extDir + L"\"";
    const std::wstring userDataDir = GetArgValue(p.cmdLine, L"--user-data-dir");
    if (!userDataDir.empty()) args += L" --user-data-dir \"" + userDataDir + L"\"";

    std::wstring cmdExe = GetEnvW(L"ComSpec");
    if (cmdExe.empty()) {
        wchar_t sys[MAX_PATH] = {0};
        GetSystemDirectoryW(sys, MAX_PATH);
        cmdExe = std::wstring(sys) + L"\\cmd.exe";
    }
    // /s：去掉最外层引号后原样执行整条命令，路径中的空格与引号不会被二次解析
    std::wstring cmd = L"\"" + cmdExe + L"\" /d /s /c \"" + args + L"\"";
    std::vector<wchar_t> cmdBuf(cmd.begin(), cmd.end());
    cmdBuf.push_back(L'\0');
    std::vector<wchar_t> env = BuildSanitizedEnvironment();

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    if (!CreateProcessW(nullptr, cmdBuf.data(), nullptr, nullptr, FALSE,
                        CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
                        env.empty() ? nullptr : env.data(), p.exeDir.c_str(), &si, &pi)) {
        return GetLastError();
    }
    const DWORD wait = WaitForSingleObject(pi.hProcess, 180000);
    DWORD code = 1;
    if (wait == WAIT_OBJECT_0) GetExitCodeProcess(pi.hProcess, &code);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    if (wait != WAIT_OBJECT_0) return WAIT_TIMEOUT;
    *exitCode = code;
    return ERROR_SUCCESS;
}

// DLL 同目录有 VSIX：本地静默安装（不联网）
void InstallFromLocalVsix(const Payload& p, const std::wstring& extDir, bool customExtDir, UiLang lang) {
    Core::Logger::Info("开始本地安装 IDE 配套插件：" + WideToUtf8(p.vsix));
    DWORD exitCode = 1;
    const DWORD err = RunInstall(p, extDir, customExtDir, &exitCode);
    if (err == ERROR_SUCCESS && exitCode == 0 && IsInstalled(extDir)) {
        Core::Logger::Info("IDE 配套插件安装成功：" + WideToUtf8(extDir) + "（运行中的 IDE 会自动加载，无需重启）");
        return;
    }
    const std::wstring reason = err != ERROR_SUCCESS
        ? (err == ERROR_FILE_NOT_FOUND ? L"bin\\antigravity-ide.cmd not found" : L"error " + std::to_wstring(err))
        : L"exit code " + std::to_wstring(exitCode);
    Core::Logger::Warn("IDE 配套插件安装失败：" + WideToUtf8(reason));
    ShowMessage(FailText(lang, reason, p.vsix), MB_OK | MB_ICONWARNING);
}

// 在可见的 PowerShell 窗口中执行命令。固定使用系统自带的 Windows PowerShell 5.1（Win10/11 内置），不依赖 PowerShell 7。
// 只装了 DLL 的用户多数没开系统代理，powershell.exe 又不在注入目标内：实测直连 GitHub 超时、镜像不代理 API 请求，安装必然失败。
// 因此挂起创建后主动注入本 DLL，让下载流量与 IDE 一样走 config.json 中的代理（SOCKS5 / HTTP 均可），再恢复运行
DWORD LaunchVisiblePowerShell(const std::wstring& workDir, const std::wstring& psCommand, PROCESS_INFORMATION* pi) {
    wchar_t sys[MAX_PATH] = {0};
    const UINT n = GetSystemDirectoryW(sys, MAX_PATH);
    if (n == 0 || n >= MAX_PATH) return ERROR_PATH_NOT_FOUND;
    const std::wstring ps = std::wstring(sys, n) + L"\\WindowsPowerShell\\v1.0\\powershell.exe";
    if (!FileExistsW(ps)) return ERROR_FILE_NOT_FOUND;

    // 命令内只含单引号（见 BuildOnlineInstallCommand），可直接包进 -Command "..."
    const std::wstring cmd = L"\"" + ps + L"\" -NoProfile -Command \"" + psCommand + L"\"";
    std::vector<wchar_t> cmdBuf(cmd.begin(), cmd.end());
    cmdBuf.push_back(L'\0');
    std::vector<wchar_t> env = BuildSanitizedEnvironment();

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    if (!CreateProcessW(ps.c_str(), cmdBuf.data(), nullptr, nullptr, FALSE,
                        CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
                        env.empty() ? nullptr : env.data(), workDir.c_str(), &si, pi)) {
        return GetLastError();
    }
    // 调用方已要求挂起的进程，CreateProcess Hook 不做注入（见 DetourCreateProcessW），这里自行注入；
    // 注入失败不阻断：照常运行，下载退回直连 / 系统代理
    std::string reason;
    const std::wstring dllPath = Injection::ProcessInjector::GetCurrentDllPath();
    if (!dllPath.empty() && Injection::ProcessInjector::InjectDll(pi->hProcess, dllPath, &reason)) {
        Core::Logger::Info("在线安装窗口已注入代理补丁，下载走 config.json 中的代理");
    } else {
        Core::Logger::Warn("在线安装窗口注入代理补丁失败（" + (reason.empty() ? std::string("DLL 路径未知") : reason) +
                           "），下载将直连或走系统代理");
    }
    ResumeThread(pi->hThread);
    return ERROR_SUCCESS;
}

// 只装了 DLL：确认后在可见终端运行在线安装脚本（只装插件），并在窗口关闭后记录结果
void InstallOnline(const Payload& p, const std::wstring& extDir, bool customExtDir, UiLang lang) {
    const std::wstring command = BuildOnlineInstallCommand(p.exeDir, customExtDir ? extDir : L"",
                                                           GetArgValue(p.cmdLine, L"--user-data-dir"), ClosePromptText(lang));
    if (ShowMessage(ConfirmOnlineText(lang, command), MB_YESNO | MB_ICONQUESTION) != IDYES) {
        Core::Logger::Info("用户取消在线安装 IDE 配套插件（本版本不再提示）");
        return;
    }
    Core::Logger::Info("用户确认在线安装 IDE 配套插件，打开 PowerShell 窗口执行：" + WideToUtf8(command));

    PROCESS_INFORMATION pi{};
    const DWORD err = LaunchVisiblePowerShell(p.exeDir, command, &pi);
    if (err != ERROR_SUCCESS) {
        Core::Logger::Warn("在线安装窗口启动失败, err=" + std::to_string(err));
        ShowMessage(LaunchFailText(lang, err, command), MB_OK | MB_ICONWARNING);
        return;
    }
    Core::Logger::Info("在线安装窗口已启动, pid=" + std::to_string(pi.dwProcessId));
    // 窗口末尾等待用户按回车；最多等 30 分钟，之后只记录当前安装状态
    const DWORD wait = WaitForSingleObject(pi.hProcess, 30 * 60 * 1000);
    const DWORD waitErr = wait == WAIT_FAILED ? GetLastError() : 0;
    DWORD exitCode = 0;
    if (wait == WAIT_OBJECT_0) GetExitCodeProcess(pi.hProcess, &exitCode);
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    // 记录窗口如何结束（关闭/超时/等待失败），便于区分“用户提前关窗”与“安装失败”
    const std::string state = wait == WAIT_OBJECT_0 ? "窗口已关闭, 退出码=" + std::to_string(exitCode)
                            : wait == WAIT_TIMEOUT  ? std::string("窗口 30 分钟未关闭, 停止等待")
                                                    : "等待窗口失败, err=" + std::to_string(waitErr);
    if (IsInstalled(extDir)) {
        Core::Logger::Info("在线安装完成：IDE 配套插件已安装（" + state + "；运行中的 IDE 会自动加载，无需重启）");
    } else {
        Core::Logger::Warn("在线安装未检测到 IDE 配套插件（" + state + "；失败原因见窗口输出）");
    }
}

DWORD WINAPI PromptThreadProc(LPVOID param) {
    std::unique_ptr<Payload> p(static_cast<Payload*>(param));
    // 等 IDE 主窗口出现后再检测/提示，避免通知出现在启动画面之前
    Sleep(8000);

    bool customExtDir = false;
    const std::wstring extDir = ResolveExtensionsDir(*p, &customExtDir);
    if (IsInstalled(extDir)) {
        Core::Logger::Info("IDE 配套插件已安装，跳过安装提示");
        return 0;
    }
    const std::string marker = MarkerPath();
    const std::string identity = Core::GetDllIdentity();
    if (AskedForThisBuild(marker, identity)) {
        Core::Logger::Info("IDE 配套插件未安装：当前 DLL 版本已提示过，不再提示");
        return 0;
    }

    const bool local = !p->vsix.empty();
    const UiLang lang = DetectUiLang();
    Core::Logger::Info(std::string("IDE 配套插件未安装，显示系统通知（") +
                       (local ? "DLL 同目录有安装包，点击即本地安装" : "DLL 同目录无安装包，点击后确认在线安装") +
                       "，" + std::to_string(kNotifyLifetimeMs / 1000) + " 秒内点击有效）");
    const NotifyResult notified = ShowNotification(p->module, p->exePath, NotifyTitle(lang), NotifyText(lang, local));
    if (notified == NotifyResult::Failed) {
        // 不写标记：通知区域不可用（如资源管理器未运行）时下次启动再提示
        Core::Logger::Warn("IDE 配套插件安装通知显示失败（系统通知区域不可用），下次启动再提示");
        return 0;
    }
    MarkAsked(marker, identity);
    if (notified == NotifyResult::Ignored) {
        Core::Logger::Info("IDE 配套插件安装通知未被点击（已忽略或超时），本 DLL 版本不再提示");
        return 0;
    }
    Core::Logger::Info("用户点击了 IDE 配套插件安装通知");
    if (local) {
        InstallFromLocalVsix(*p, extDir, customExtDir, lang);
    } else {
        InstallOnline(*p, extDir, customExtDir, lang);
    }
    return 0;
}

}  // namespace

void MaybePromptInstallAsync(bool protocolLaunch) {
    if (protocolLaunch) return;
    const std::wstring exePath = GetModulePathW(nullptr);
    const wchar_t* rawCmd = GetCommandLineW();
    const std::wstring cmdLine = rawCmd ? rawCmd : L"";
    if (!IsIdeMainProcess(BaseName(exePath), cmdLine, !GetEnvW(L"ELECTRON_RUN_AS_NODE").empty())) return;

    HMODULE self = nullptr;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                            reinterpret_cast<LPCWSTR>(&MaybePromptInstallAsync), &self)) {
        return;
    }
    // 同目录没有安装包（只装了 DLL）时不再跳过，改为提示在线安装
    const std::wstring vsixPath = DirName(GetModulePathW(self)) + L"\\antigravity-proxy.vsix";
    const std::wstring vsix = FileExistsW(vsixPath) ? vsixPath : L"";

    auto* payload = new Payload{self, exePath, DirName(exePath), vsix, cmdLine};
    HANDLE thread = CreateThread(nullptr, 0, PromptThreadProc, payload, 0, nullptr);
    if (thread) {
        CloseHandle(thread);
    } else {
        delete payload;
        Core::Logger::Warn("IDE 配套插件检测线程启动失败, err=" + std::to_string(GetLastError()));
    }
}

}  // namespace IdeExtension
