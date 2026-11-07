// IDE 配套插件安装提示：DLL 在 Antigravity IDE 主进程中检测插件是否安装，未安装则询问并一键安装。
//
// 设计要点：
// - 只在 IDE 主进程运行（排除 Electron 子进程、ELECTRON_RUN_AS_NODE 命令行模式、--open-url 协议启动）；
// - 后台线程延迟执行，不阻塞 DllMain 与 Hook 安装，user32 按需动态加载（与加载提示一致）；
// - 每个 DLL 版本最多询问一次（标记文件写在日志目录，与加载提示同机制）；
// - 安装复用 IDE 自带命令行 bin\antigravity-ide.cmd --install-extension（VS Code 标准机制），
//   实测运行中的 IDE 会自动加载新安装的插件，无需重启；插件随即接管首次引导（检测/扫描代理）。

#include "ide/IdeExtensionPrompt.hpp"

#include <windows.h>

#include <fstream>
#include <memory>
#include <string>
#include <vector>

#include "core/DllIdentity.hpp"
#include "core/Logger.hpp"
#include "ide/IdeExtensionLogic.hpp"

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
    std::wstring exeDir;   // IDE 安装目录（主程序所在目录）
    std::wstring vsix;     // DLL 同目录的插件包
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

std::wstring AskText(UiLang lang) {
    switch (lang) {
    case UiLang::Zh:
        return L"检测到尚未安装 Antigravity Proxy 配套插件。\n\n"
               L"插件提供：\n"
               L"• 底部状态栏显示代理状态\n"
               L"• 可视化代理设置（可自动检测本机代理）\n"
               L"• IDE 更新后自动修复补丁\n\n"
               L"是否立即安装？\n（安装后立即生效，无需重启；选择「否」后本版本不再提示）";
    case UiLang::Ru:
        return L"Сопутствующее расширение Antigravity Proxy не установлено.\n\n"
               L"Оно добавляет:\n"
               L"• состояние прокси в строке состояния\n"
               L"• визуальные настройки прокси (с автопоиском локального прокси)\n"
               L"• автоматическое восстановление патча после обновлений IDE\n\n"
               L"Установить сейчас?\n(Начнёт работать сразу, без перезапуска. Если выбрать «Нет», для этой версии вопрос больше не появится.)";
    default:
        return L"The Antigravity Proxy companion extension is not installed.\n\n"
               L"It adds:\n"
               L"• Proxy status in the status bar\n"
               L"• Visual proxy settings (with local proxy auto-detection)\n"
               L"• Automatic patch repair after IDE updates\n\n"
               L"Install it now?\n(It works immediately without a restart. If you choose \"No\", you won't be asked again for this version.)";
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

DWORD WINAPI PromptThreadProc(LPVOID param) {
    std::unique_ptr<Payload> p(static_cast<Payload*>(param));
    // 等 IDE 主窗口出现后再检测/提示，避免对话框出现在启动画面之前
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
        Core::Logger::Info("IDE 配套插件未安装：当前 DLL 版本已询问过，不再提示");
        return 0;
    }

    const UiLang lang = DetectUiLang();
    const int answer = ShowMessage(AskText(lang), MB_YESNO | MB_ICONQUESTION);
    MarkAsked(marker, identity);
    if (answer != IDYES) {
        Core::Logger::Info("用户选择暂不安装 IDE 配套插件（本版本不再提示）");
        return 0;
    }

    DWORD exitCode = 1;
    const DWORD err = RunInstall(*p, extDir, customExtDir, &exitCode);
    if (err == ERROR_SUCCESS && exitCode == 0 && IsInstalled(extDir)) {
        Core::Logger::Info("IDE 配套插件安装成功：" + WideToUtf8(extDir) + "（运行中的 IDE 会自动加载，无需重启）");
        return 0;
    }
    const std::wstring reason = err != ERROR_SUCCESS
        ? (err == ERROR_FILE_NOT_FOUND ? L"bin\\antigravity-ide.cmd not found" : L"error " + std::to_wstring(err))
        : L"exit code " + std::to_wstring(exitCode);
    Core::Logger::Warn("IDE 配套插件安装失败：" + WideToUtf8(reason));
    ShowMessage(FailText(lang, reason, p->vsix), MB_OK | MB_ICONWARNING);
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
    const std::wstring vsix = DirName(GetModulePathW(self)) + L"\\antigravity-proxy.vsix";
    if (!FileExistsW(vsix)) {
        Core::Logger::Info("DLL 同目录未找到 antigravity-proxy.vsix，跳过 IDE 配套插件检测");
        return;
    }

    auto* payload = new Payload{DirName(exePath), vsix, cmdLine};
    HANDLE thread = CreateThread(nullptr, 0, PromptThreadProc, payload, 0, nullptr);
    if (thread) {
        CloseHandle(thread);
    } else {
        delete payload;
        Core::Logger::Warn("IDE 配套插件检测线程启动失败, err=" + std::to_string(GetLastError()));
    }
}

}  // namespace IdeExtension
