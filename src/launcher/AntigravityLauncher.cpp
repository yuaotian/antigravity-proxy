// ============================================================================
// AntigravityLauncher.cpp
// 专为 Antigravity-Proxy 设计的零黑框、毫秒级防更新覆盖原生 Win32 GUI 启动器
// ============================================================================
// 功能特性:
// 1. 采用 WIN32 GUI 子系统 (wWinMain)，天然零 CMD 黑框、零闪烁，彻底替代易被弃用和误报的 VBS 脚本
// 2. 自动探测 Antigravity.exe 与 agy.exe 安装路径（配置文件 -> 常见目录 -> 注册表 -> 文件选择对话框）
// 3. 每次启动前自动校验并增量恢复 ide/ (version.dll, config.json) 与 cli/ 补丁，彻底免疫客户端自动更新覆盖
// 4. 完整透传命令行参数，支持固定到任务栏 (Taskbar)、开始菜单 (Start Menu) 与桌面快捷方式
// ============================================================================

#include <windows.h>
#include <shlobj.h>
#include <commdlg.h>
#include <shellapi.h>
#include <string>
#include <vector>
#include <fstream>

#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "comdlg32.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "user32.lib")

namespace {

enum class AppLang { Zh, Ru, En };

AppLang DetectAppLang() {
    LANGID lang = GetUserDefaultUILanguage();
    WORD pri = PRIMARYLANGID(lang);
    if (pri == LANG_CHINESE) return AppLang::Zh;
    if (pri == LANG_RUSSIAN) return AppLang::Ru;
    return AppLang::En;
}

const wchar_t* GetMsgNotFound(AppLang lang) {
    switch (lang) {
        case AppLang::Zh: return L"未能定位到 Antigravity.exe 安装目录，启动已取消。";
        case AppLang::Ru: return L"Не удалось найти директорию Antigravity.exe. Запуск отменен.";
        default: return L"Failed to locate Antigravity.exe installation directory. Launch aborted.";
    }
}

const wchar_t* GetMsgLaunchFail(AppLang lang) {
    switch (lang) {
        case AppLang::Zh: return L"无法启动主程序：\n";
        case AppLang::Ru: return L"Не удалось запустить программу:\n";
        default: return L"Failed to launch executable:\n";
    }
}

const wchar_t* GetMsgDialogTitle(AppLang lang) {
    switch (lang) {
        case AppLang::Zh: return L"请选择 Antigravity.exe 所在位置（仅首次需要）";
        case AppLang::Ru: return L"Выберите расположение Antigravity.exe";
        default: return L"Please select Antigravity.exe location (First time only)";
    }
}

const wchar_t* GetMsgBoxTitle(AppLang lang) {
    switch (lang) {
        case AppLang::Zh: return L"Antigravity-Proxy 启动守护";
        case AppLang::Ru: return L"Запуск и защита Antigravity-Proxy";
        default: return L"Antigravity-Proxy Launcher Guard";
    }
}

std::wstring GetExecutableDir() {
    wchar_t buffer[MAX_PATH] = {0};
    GetModuleFileNameW(nullptr, buffer, MAX_PATH);
    std::wstring path(buffer);
    size_t pos = path.find_last_of(L"\\/");
    return (pos != std::wstring::npos) ? path.substr(0, pos) : L".";
}

bool FileExists(const std::wstring& path) {
    DWORD attr = GetFileAttributesW(path.c_str());
    return (attr != INVALID_FILE_ATTRIBUTES) && !(attr & FILE_ATTRIBUTE_DIRECTORY);
}

bool DirExists(const std::wstring& path) {
    DWORD attr = GetFileAttributesW(path.c_str());
    return (attr != INVALID_FILE_ATTRIBUTES) && (attr & FILE_ATTRIBUTE_DIRECTORY);
}

std::wstring JoinPath(const std::wstring& base, const std::wstring& sub) {
    if (base.empty()) return sub;
    if (base.back() == L'\\' || base.back() == L'/') return base + sub;
    return base + L"\\" + sub;
}

std::wstring GetParentDir(const std::wstring& path) {
    size_t pos = path.find_last_of(L"\\/");
    return (pos != std::wstring::npos) ? path.substr(0, pos) : L"";
}

std::wstring GetEnvVar(const wchar_t* name) {
    wchar_t buffer[MAX_PATH] = {0};
    DWORD len = GetEnvironmentVariableW(name, buffer, MAX_PATH);
    return (len > 0 && len < MAX_PATH) ? std::wstring(buffer, len) : L"";
}

std::wstring Trim(const std::wstring& str) {
    size_t first = str.find_first_not_of(L" \t\r\n\"");
    if (first == std::wstring::npos) return L"";
    size_t last = str.find_last_not_of(L" \t\r\n\"");
    return str.substr(first, (last - first + 1));
}

std::wstring ReadUtf8FileFirstLine(const std::wstring& filePath) {
    HANDLE hFile = CreateFileW(filePath.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr,
                               OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (hFile == INVALID_HANDLE_VALUE) return L"";

    char buf[2048] = {0};
    DWORD bytesRead = 0;
    ReadFile(hFile, buf, sizeof(buf) - 1, &bytesRead, nullptr);
    CloseHandle(hFile);
    if (bytesRead == 0) return L"";

    // Skip UTF-8 BOM if present
    const char* start = buf;
    if (bytesRead >= 3 &&
        static_cast<unsigned char>(buf[0]) == 0xEF &&
        static_cast<unsigned char>(buf[1]) == 0xBB &&
        static_cast<unsigned char>(buf[2]) == 0xBF) {
        start += 3;
    }

    int wlen = MultiByteToWideChar(CP_UTF8, 0, start, -1, nullptr, 0);
    if (wlen <= 0) return L"";
    std::wstring wstr(wlen, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, start, -1, &wstr[0], wlen);
    if (!wstr.empty() && wstr.back() == L'\0') wstr.pop_back();
    return Trim(wstr);
}

void WriteUtf8File(const std::wstring& filePath, const std::wstring& content) {
    int u8len = WideCharToMultiByte(CP_UTF8, 0, content.c_str(), -1, nullptr, 0, nullptr, nullptr);
    if (u8len <= 1) return;
    std::string u8str(u8len - 1, '\0');
    WideCharToMultiByte(CP_UTF8, 0, content.c_str(), -1, &u8str[0], u8len - 1, nullptr, nullptr);

    HANDLE hFile = CreateFileW(filePath.c_str(), GENERIC_WRITE, 0, nullptr,
                               CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (hFile != INVALID_HANDLE_VALUE) {
        DWORD written = 0;
        WriteFile(hFile, u8str.data(), static_cast<DWORD>(u8str.size()), &written, nullptr);
        CloseHandle(hFile);
    }
}

// 判断源文件是否需要同步到目标文件（目标不存在，或者大小/修改时间不一致）
bool ShouldSyncFile(const std::wstring& srcPath, const std::wstring& dstPath) {
    WIN32_FILE_ATTRIBUTE_DATA srcInfo = {0};
    if (!GetFileAttributesExW(srcPath.c_str(), GetFileExInfoStandard, &srcInfo)) {
        return false;
    }
    WIN32_FILE_ATTRIBUTE_DATA dstInfo = {0};
    if (!GetFileAttributesExW(dstPath.c_str(), GetFileExInfoStandard, &dstInfo)) {
        return true; // 目标文件被更新删除或不存在，立即恢复
    }

    // 保护用户的配置文件：如果目标 config.json 已经存在，保留现有配置，不覆盖
    size_t lastSlash = dstPath.find_last_of(L"\\/");
    std::wstring fileName = (lastSlash != std::wstring::npos) ? dstPath.substr(lastSlash + 1) : dstPath;
    if (_wcsicmp(fileName.c_str(), L"config.json") == 0) {
        return false;
    }

    if (srcInfo.nFileSizeHigh != dstInfo.nFileSizeHigh ||
        srcInfo.nFileSizeLow != dstInfo.nFileSizeLow) {
        return true; // 文件大小变化（例如更新了版本或修改了补丁）
    }
    // 如果源文件比目标文件新，则同步覆盖
    if (CompareFileTime(&srcInfo.ftLastWriteTime, &dstInfo.ftLastWriteTime) > 0) {
        return true;
    }
    return false;
}

void SyncFileIfNeeded(const std::wstring& srcPath, const std::wstring& dstPath) {
    if (ShouldSyncFile(srcPath, dstPath)) {
        CopyFileW(srcPath.c_str(), dstPath.c_str(), FALSE);
    }
}

// 同步目录中的所有补丁文件
void SyncDirectoryFiles(const std::wstring& srcDir, const std::wstring& dstDir) {
    if (!DirExists(srcDir) || !DirExists(dstDir)) return;

    std::wstring searchPattern = JoinPath(srcDir, L"*");
    WIN32_FIND_DATAW findData;
    HANDLE hFind = FindFirstFileW(searchPattern.c_str(), &findData);
    if (hFind == INVALID_HANDLE_VALUE) return;

    do {
        const std::wstring name = findData.cFileName;
        if (name == L"." || name == L"..") continue;

        std::wstring sPath = JoinPath(srcDir, name);
        std::wstring dPath = JoinPath(dstDir, name);

        if (findData.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            CreateDirectoryW(dPath.c_str(), nullptr);
            SyncDirectoryFiles(sPath, dPath);
        } else {
            SyncFileIfNeeded(sPath, dPath);
        }
    } while (FindNextFileW(hFind, &findData));

    FindClose(hFind);
}

// 从注册表 Uninstall 项探测 Antigravity 安装目录
std::wstring FindAppInRegistry(HKEY hRootKey, const wchar_t* subKey) {
    HKEY hKey = nullptr;
    if (RegOpenKeyExW(hRootKey, subKey, 0, KEY_READ, &hKey) != ERROR_SUCCESS) {
        return L"";
    }

    wchar_t keyName[256];
    DWORD index = 0;
    DWORD keyNameLen = 256;
    std::wstring result;

    while (RegEnumKeyExW(hKey, index++, keyName, &keyNameLen, nullptr, nullptr, nullptr, nullptr) == ERROR_SUCCESS) {
        HKEY hItem = nullptr;
        if (RegOpenKeyExW(hKey, keyName, 0, KEY_READ, &hItem) == ERROR_SUCCESS) {
            wchar_t displayName[256] = {0};
            DWORD size = sizeof(displayName);
            RegQueryValueExW(hItem, L"DisplayName", nullptr, nullptr, reinterpret_cast<LPBYTE>(displayName), &size);

            if (wcsstr(displayName, L"Antigravity") != nullptr) {
                wchar_t installLoc[MAX_PATH] = {0};
                DWORD locSize = sizeof(installLoc);
                if (RegQueryValueExW(hItem, L"InstallLocation", nullptr, nullptr, reinterpret_cast<LPBYTE>(installLoc), &locSize) == ERROR_SUCCESS) {
                    std::wstring candidate = Trim(installLoc);
                    if (!candidate.empty() && FileExists(JoinPath(candidate, L"Antigravity.exe"))) {
                        result = candidate;
                        RegCloseKey(hItem);
                        break;
                    }
                }
            }
            RegCloseKey(hItem);
        }
        keyNameLen = 256;
    }

    RegCloseKey(hKey);
    return result;
}

// 自动探测 Antigravity.exe 主程序目录
std::wstring DetectAntigravityDir(const std::wstring& rootDir) {
    std::wstring configFile = JoinPath(rootDir, L"app_path.txt");
    if (FileExists(configFile)) {
        std::wstring saved = ReadUtf8FileFirstLine(configFile);
        if (!saved.empty() && FileExists(JoinPath(saved, L"Antigravity.exe"))) {
            return saved;
        }
    }

    std::vector<std::wstring> candidates = {
        JoinPath(GetEnvVar(L"LOCALAPPDATA"), L"Programs\\Antigravity"),
        JoinPath(GetEnvVar(L"LOCALAPPDATA"), L"Antigravity"),
        JoinPath(GetEnvVar(L"ProgramFiles"), L"Antigravity"),
        JoinPath(GetEnvVar(L"ProgramFiles(x86)"), L"Antigravity")
    };

    for (const auto& dir : candidates) {
        if (!dir.empty() && FileExists(JoinPath(dir, L"Antigravity.exe"))) {
            return dir;
        }
    }

    // 注册表检索
    std::wstring regDir = FindAppInRegistry(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall");
    if (!regDir.empty()) return regDir;
    regDir = FindAppInRegistry(HKEY_LOCAL_MACHINE, L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall");
    if (!regDir.empty()) return regDir;
    regDir = FindAppInRegistry(HKEY_LOCAL_MACHINE, L"Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall");
    if (!regDir.empty()) return regDir;

    // 兜底：弹出系统文件选择框
    wchar_t filePath[MAX_PATH] = {0};
    OPENFILENAMEW ofn = {0};
    ofn.lStructSize = sizeof(ofn);
    ofn.lpstrFilter = L"Antigravity 主程序 (Antigravity.exe)\0Antigravity.exe\0所有可执行文件 (*.exe)\0*.exe\0";
    ofn.lpstrFile = filePath;
    ofn.nMaxFile = MAX_PATH;
    ofn.lpstrTitle = L"请选择 Antigravity.exe 所在位置（仅首次需要）";
    ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_HIDEREADONLY;

    if (GetOpenFileNameW(&ofn)) {
        std::wstring selectedDir = GetParentDir(filePath);
        if (FileExists(JoinPath(selectedDir, L"Antigravity.exe"))) {
            WriteUtf8File(configFile, selectedDir);
            return selectedDir;
        }
    }

    return L"";
}

// 定位补丁源目录（兼容官方 Release 结构的 ide/ 目录以及用户自定义的 Patch/ 目录）
std::wstring FindPatchSourceDir(const std::wstring& exeDir) {
    std::wstring parentDir = GetParentDir(exeDir);
    std::vector<std::wstring> searchDirs = {
        JoinPath(exeDir, L"ide"),
        JoinPath(parentDir, L"ide"),
        JoinPath(exeDir, L"Patch"),
        JoinPath(parentDir, L"Patch"),
        exeDir
    };

    for (const auto& dir : searchDirs) {
        if (FileExists(JoinPath(dir, L"version.dll"))) {
            return dir;
        }
    }
    return L"";
}

// 可选：如果存在 cli/ 补丁且检测到本机安装了 Antigravity CLI (agy.exe)，同步守护 CLI 补丁
void TrySyncCliPatch(const std::wstring& exeDir, const std::wstring& appDir) {
    std::wstring parentDir = GetParentDir(exeDir);
    std::wstring cliSrc;
    if (FileExists(JoinPath(JoinPath(exeDir, L"cli"), L"dbghelp.dll"))) {
        cliSrc = JoinPath(exeDir, L"cli");
    } else if (FileExists(JoinPath(JoinPath(parentDir, L"cli"), L"dbghelp.dll"))) {
        cliSrc = JoinPath(parentDir, L"cli");
    }
    if (cliSrc.empty()) return;

    // 检查常见 CLI 目录（注意：不可与 IDE 的 version.dll 同目录混装，仅当 agy.exe 在独立 bin 目录时同步）
    std::vector<std::wstring> cliTargets = {
        JoinPath(appDir, L"resources\\app\\extensions\\antigravity\\bin"),
        JoinPath(GetEnvVar(L"LOCALAPPDATA"), L"Programs\\Antigravity CLI")
    };
    for (const auto& target : cliTargets) {
        if (FileExists(JoinPath(target, L"agy.exe")) && !FileExists(JoinPath(target, L"Antigravity.exe"))) {
            SyncDirectoryFiles(cliSrc, target);
        }
    }
}

} // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, LPWSTR lpCmdLine, int) {
    std::wstring exeDir = GetExecutableDir();
    std::wstring rootDir = exeDir;
    // 如果启动器位于 launcher/ 子目录下，根目录为其父目录
    if (!FileExists(JoinPath(exeDir, L"app_path.txt")) &&
        (DirExists(JoinPath(GetParentDir(exeDir), L"ide")) || DirExists(JoinPath(GetParentDir(exeDir), L"Patch")))) {
        rootDir = GetParentDir(exeDir);
    }

    AppLang lang = DetectAppLang();
    std::wstring appDir = DetectAntigravityDir(rootDir);
    if (appDir.empty()) {
        MessageBoxW(nullptr,
                    GetMsgNotFound(lang),
                    GetMsgBoxTitle(lang),
                    MB_ICONERROR | MB_OK);
        return 1;
    }

    std::wstring patchDir = FindPatchSourceDir(exeDir);
    if (!patchDir.empty()) {
        SyncDirectoryFiles(patchDir, appDir);
    }

    TrySyncCliPatch(exeDir, appDir);

    // 启动主程序并完整透传命令行参数
    std::wstring targetExe = JoinPath(appDir, L"Antigravity.exe");
    std::wstring cmdArgs = (lpCmdLine != nullptr) ? lpCmdLine : L"";

    SHELLEXECUTEINFOW sei = {0};
    sei.cbSize = sizeof(sei);
    sei.fMask = SEE_MASK_NOASYNC;
    sei.lpVerb = L"open";
    sei.lpFile = targetExe.c_str();
    sei.lpParameters = cmdArgs.empty() ? nullptr : cmdArgs.c_str();
    sei.lpDirectory = appDir.c_str();
    sei.nShow = SW_SHOWNORMAL;

    if (!ShellExecuteExW(&sei)) {
        MessageBoxW(nullptr,
                    (std::wstring(GetMsgLaunchFail(lang)) + targetExe).c_str(),
                    GetMsgBoxTitle(lang),
                    MB_ICONERROR | MB_OK);
        return 1;
    }

    return 0;
}
