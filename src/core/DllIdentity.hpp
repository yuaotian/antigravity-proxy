#pragma once

// 当前 DLL 的“构建身份”（路径 + 大小 + 修改时间）：用于“同一版本只提示一次”的标记文件比对。
// 加载提示与 IDE 插件安装提示共用，避免两处实现不一致。

#include <windows.h>
#include <sstream>
#include <string>

namespace Core {

inline std::string GetDllIdentity() {
    char modulePath[MAX_PATH] = {0};
    HMODULE hModule = NULL;
    if (!GetModuleHandleExA(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            reinterpret_cast<LPCSTR>(&GetDllIdentity),
            &hModule)) {
        return "unknown-module";
    }
    const DWORD len = GetModuleFileNameA(hModule, modulePath, MAX_PATH);
    if (len == 0 || len >= MAX_PATH) {
        return "unknown-module";
    }

    WIN32_FILE_ATTRIBUTE_DATA data{};
    std::ostringstream oss;
    oss << modulePath;
    if (GetFileAttributesExA(modulePath, GetFileExInfoStandard, &data)) {
        oss << "|size=" << data.nFileSizeHigh << ":" << data.nFileSizeLow
            << "|mtime=" << data.ftLastWriteTime.dwHighDateTime << ":" << data.ftLastWriteTime.dwLowDateTime;
    }
    return oss.str();
}

}  // namespace Core
