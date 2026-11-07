#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>

#include <cwctype>
#include <mutex>
#include <string>

namespace {

HMODULE g_shimModule = nullptr;
HMODULE g_systemDbgHelp = nullptr;
HMODULE g_proxyModule = nullptr;
std::once_flag g_systemDbgHelpOnce;
std::once_flag g_proxyModuleOnce;

std::wstring GetModuleDirectory(HMODULE module) {
    wchar_t path[MAX_PATH] = {};
    const DWORD len = GetModuleFileNameW(module, path, MAX_PATH);
    if (len == 0 || len >= MAX_PATH) return L"";

    std::wstring result(path, len);
    const size_t slash = result.find_last_of(L"\\/");
    return slash == std::wstring::npos ? L"" : result.substr(0, slash);
}

std::wstring GetCurrentProcessBaseName() {
    wchar_t path[MAX_PATH] = {};
    const DWORD len = GetModuleFileNameW(nullptr, path, MAX_PATH);
    if (len == 0 || len >= MAX_PATH) return L"";

    std::wstring result(path, len);
    const size_t slash = result.find_last_of(L"\\/");
    if (slash != std::wstring::npos) result = result.substr(slash + 1);
    for (wchar_t& ch : result) ch = static_cast<wchar_t>(std::towlower(ch));
    return result;
}

bool IsAntigravityCliProcess() {
    const std::wstring name = GetCurrentProcessBaseName();
    return name == L"agy.exe" || name == L"antigravity-cli.exe";
}

void EnsureProxyLoadedForCli() {
    if (!IsAntigravityCliProcess()) return;

    std::call_once(g_proxyModuleOnce, []() {
        const std::wstring directory = GetModuleDirectory(g_shimModule);
        if (directory.empty()) return;

        // CLI 使用唯一 DLL 名称，避免系统 version.dll 已加载时发生同名模块冲突。
        const std::wstring path = directory + L"\\antigravity_proxy.dll";
        g_proxyModule = LoadLibraryExW(path.c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
    });
}

HMODULE LoadSystemDbgHelp() {
    std::call_once(g_systemDbgHelpOnce, []() {
        wchar_t systemDirectory[MAX_PATH] = {};
        const UINT len = GetSystemDirectoryW(systemDirectory, MAX_PATH);
        if (len == 0 || len >= MAX_PATH) return;

        const std::wstring path = std::wstring(systemDirectory, len) + L"\\dbghelp.dll";
        g_systemDbgHelp = LoadLibraryExW(path.c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
    });
    return g_systemDbgHelp;
}

template <typename Function>
Function ResolveSystemExport(const char* name) {
    EnsureProxyLoadedForCli();
    const HMODULE module = LoadSystemDbgHelp();
    if (!module) return nullptr;

    const FARPROC address = GetProcAddress(module, name);
    if (!address) SetLastError(ERROR_PROC_NOT_FOUND);
    return reinterpret_cast<Function>(address);
}

#define RESOLVE_OR_RETURN(name, type, fallback) \
    const auto function = ResolveSystemExport<type>(#name); \
    if (!function) return fallback

}  // namespace

extern "C" BOOL WINAPI DbgHelpProxy_SymFromAddr(HANDLE process, DWORD64 address, DWORD64* displacement, void* symbol) {
    using Function = BOOL(WINAPI*)(HANDLE, DWORD64, DWORD64*, void*);
    RESOLVE_OR_RETURN(SymFromAddr, Function, FALSE);
    return function(process, address, displacement, symbol);
}

extern "C" BOOL WINAPI DbgHelpProxy_SymFromAddrW(HANDLE process, DWORD64 address, DWORD64* displacement, void* symbol) {
    using Function = BOOL(WINAPI*)(HANDLE, DWORD64, DWORD64*, void*);
    RESOLVE_OR_RETURN(SymFromAddrW, Function, FALSE);
    return function(process, address, displacement, symbol);
}

extern "C" BOOL WINAPI DbgHelpProxy_SymFromName(HANDLE process, PCSTR name, void* symbol) {
    using Function = BOOL(WINAPI*)(HANDLE, PCSTR, void*);
    RESOLVE_OR_RETURN(SymFromName, Function, FALSE);
    return function(process, name, symbol);
}

extern "C" BOOL WINAPI DbgHelpProxy_SymFromNameW(HANDLE process, PCWSTR name, void* symbol) {
    using Function = BOOL(WINAPI*)(HANDLE, PCWSTR, void*);
    RESOLVE_OR_RETURN(SymFromNameW, Function, FALSE);
    return function(process, name, symbol);
}

extern "C" BOOL WINAPI DbgHelpProxy_SymInitialize(HANDLE process, PCSTR searchPath, BOOL invadeProcess) {
    using Function = BOOL(WINAPI*)(HANDLE, PCSTR, BOOL);
    RESOLVE_OR_RETURN(SymInitialize, Function, FALSE);
    return function(process, searchPath, invadeProcess);
}

extern "C" BOOL WINAPI DbgHelpProxy_SymInitializeW(HANDLE process, PCWSTR searchPath, BOOL invadeProcess) {
    using Function = BOOL(WINAPI*)(HANDLE, PCWSTR, BOOL);
    RESOLVE_OR_RETURN(SymInitializeW, Function, FALSE);
    return function(process, searchPath, invadeProcess);
}

extern "C" BOOL WINAPI DbgHelpProxy_SymCleanup(HANDLE process) {
    using Function = BOOL(WINAPI*)(HANDLE);
    RESOLVE_OR_RETURN(SymCleanup, Function, FALSE);
    return function(process);
}

extern "C" DWORD WINAPI DbgHelpProxy_SymGetOptions() {
    using Function = DWORD(WINAPI*)();
    RESOLVE_OR_RETURN(SymGetOptions, Function, 0);
    return function();
}

extern "C" DWORD WINAPI DbgHelpProxy_SymSetOptions(DWORD options) {
    using Function = DWORD(WINAPI*)(DWORD);
    RESOLVE_OR_RETURN(SymSetOptions, Function, 0);
    return function(options);
}

extern "C" BOOL WINAPI DbgHelpProxy_SymGetSearchPath(HANDLE process, PSTR path, DWORD pathLength) {
    using Function = BOOL(WINAPI*)(HANDLE, PSTR, DWORD);
    RESOLVE_OR_RETURN(SymGetSearchPath, Function, FALSE);
    return function(process, path, pathLength);
}

extern "C" BOOL WINAPI DbgHelpProxy_SymGetSearchPathW(HANDLE process, PWSTR path, DWORD pathLength) {
    using Function = BOOL(WINAPI*)(HANDLE, PWSTR, DWORD);
    RESOLVE_OR_RETURN(SymGetSearchPathW, Function, FALSE);
    return function(process, path, pathLength);
}

extern "C" BOOL WINAPI DbgHelpProxy_SymSetSearchPath(HANDLE process, PCSTR path) {
    using Function = BOOL(WINAPI*)(HANDLE, PCSTR);
    RESOLVE_OR_RETURN(SymSetSearchPath, Function, FALSE);
    return function(process, path);
}

extern "C" BOOL WINAPI DbgHelpProxy_SymSetSearchPathW(HANDLE process, PCWSTR path) {
    using Function = BOOL(WINAPI*)(HANDLE, PCWSTR);
    RESOLVE_OR_RETURN(SymSetSearchPathW, Function, FALSE);
    return function(process, path);
}

extern "C" DWORD64 WINAPI DbgHelpProxy_SymLoadModuleEx(
    HANDLE process, HANDLE file, PCSTR imageName, PCSTR moduleName,
    DWORD64 baseOfDll, DWORD dllSize, void* data, DWORD flags) {
    using Function = DWORD64(WINAPI*)(HANDLE, HANDLE, PCSTR, PCSTR, DWORD64, DWORD, void*, DWORD);
    RESOLVE_OR_RETURN(SymLoadModuleEx, Function, 0);
    return function(process, file, imageName, moduleName, baseOfDll, dllSize, data, flags);
}

extern "C" DWORD64 WINAPI DbgHelpProxy_SymLoadModuleExW(
    HANDLE process, HANDLE file, PCWSTR imageName, PCWSTR moduleName,
    DWORD64 baseOfDll, DWORD dllSize, void* data, DWORD flags) {
    using Function = DWORD64(WINAPI*)(HANDLE, HANDLE, PCWSTR, PCWSTR, DWORD64, DWORD, void*, DWORD);
    RESOLVE_OR_RETURN(SymLoadModuleExW, Function, 0);
    return function(process, file, imageName, moduleName, baseOfDll, dllSize, data, flags);
}

extern "C" BOOL WINAPI DbgHelpProxy_SymUnloadModule64(HANDLE process, DWORD64 baseOfDll) {
    using Function = BOOL(WINAPI*)(HANDLE, DWORD64);
    RESOLVE_OR_RETURN(SymUnloadModule64, Function, FALSE);
    return function(process, baseOfDll);
}

extern "C" BOOL WINAPI DbgHelpProxy_SymRefreshModuleList(HANDLE process) {
    using Function = BOOL(WINAPI*)(HANDLE);
    RESOLVE_OR_RETURN(SymRefreshModuleList, Function, FALSE);
    return function(process);
}

extern "C" BOOL WINAPI DbgHelpProxy_SymGetLineFromAddr64(
    HANDLE process, DWORD64 address, DWORD* displacement, void* line) {
    using Function = BOOL(WINAPI*)(HANDLE, DWORD64, DWORD*, void*);
    RESOLVE_OR_RETURN(SymGetLineFromAddr64, Function, FALSE);
    return function(process, address, displacement, line);
}

extern "C" BOOL WINAPI DbgHelpProxy_SymGetLineFromAddrW64(
    HANDLE process, DWORD64 address, DWORD* displacement, void* line) {
    using Function = BOOL(WINAPI*)(HANDLE, DWORD64, DWORD*, void*);
    RESOLVE_OR_RETURN(SymGetLineFromAddrW64, Function, FALSE);
    return function(process, address, displacement, line);
}

extern "C" void* WINAPI DbgHelpProxy_SymFunctionTableAccess64(HANDLE process, DWORD64 address) {
    using Function = void*(WINAPI*)(HANDLE, DWORD64);
    RESOLVE_OR_RETURN(SymFunctionTableAccess64, Function, nullptr);
    return function(process, address);
}

extern "C" DWORD64 WINAPI DbgHelpProxy_SymGetModuleBase64(HANDLE process, DWORD64 address) {
    using Function = DWORD64(WINAPI*)(HANDLE, DWORD64);
    RESOLVE_OR_RETURN(SymGetModuleBase64, Function, 0);
    return function(process, address);
}

extern "C" BOOL WINAPI DbgHelpProxy_SymGetModuleInfo64(HANDLE process, DWORD64 address, void* moduleInfo) {
    using Function = BOOL(WINAPI*)(HANDLE, DWORD64, void*);
    RESOLVE_OR_RETURN(SymGetModuleInfo64, Function, FALSE);
    return function(process, address, moduleInfo);
}

extern "C" BOOL WINAPI DbgHelpProxy_SymGetModuleInfoW64(HANDLE process, DWORD64 address, void* moduleInfo) {
    using Function = BOOL(WINAPI*)(HANDLE, DWORD64, void*);
    RESOLVE_OR_RETURN(SymGetModuleInfoW64, Function, FALSE);
    return function(process, address, moduleInfo);
}

extern "C" BOOL WINAPI DbgHelpProxy_StackWalk64(
    DWORD machineType, HANDLE process, HANDLE thread, void* stackFrame, void* context,
    void* readMemory, void* functionTable, void* moduleBase, void* translateAddress) {
    using Function = BOOL(WINAPI*)(DWORD, HANDLE, HANDLE, void*, void*, void*, void*, void*, void*);
    RESOLVE_OR_RETURN(StackWalk64, Function, FALSE);
    return function(machineType, process, thread, stackFrame, context, readMemory, functionTable, moduleBase, translateAddress);
}

extern "C" BOOL WINAPI DbgHelpProxy_EnumerateLoadedModules64(HANDLE process, void* callback, void* context) {
    using Function = BOOL(WINAPI*)(HANDLE, void*, void*);
    RESOLVE_OR_RETURN(EnumerateLoadedModules64, Function, FALSE);
    return function(process, callback, context);
}

extern "C" BOOL WINAPI DbgHelpProxy_EnumerateLoadedModulesW64(HANDLE process, void* callback, void* context) {
    using Function = BOOL(WINAPI*)(HANDLE, void*, void*);
    RESOLVE_OR_RETURN(EnumerateLoadedModulesW64, Function, FALSE);
    return function(process, callback, context);
}

extern "C" BOOL WINAPI DbgHelpProxy_SymEnumSymbols(
    HANDLE process, ULONG64 baseOfDll, PCSTR mask, void* callback, void* context) {
    using Function = BOOL(WINAPI*)(HANDLE, ULONG64, PCSTR, void*, void*);
    RESOLVE_OR_RETURN(SymEnumSymbols, Function, FALSE);
    return function(process, baseOfDll, mask, callback, context);
}

extern "C" BOOL WINAPI DbgHelpProxy_SymEnumSymbolsW(
    HANDLE process, ULONG64 baseOfDll, PCWSTR mask, void* callback, void* context) {
    using Function = BOOL(WINAPI*)(HANDLE, ULONG64, PCWSTR, void*, void*);
    RESOLVE_OR_RETURN(SymEnumSymbolsW, Function, FALSE);
    return function(process, baseOfDll, mask, callback, context);
}

extern "C" BOOL WINAPI DbgHelpProxy_SymRegisterCallback64(HANDLE process, void* callback, ULONG64 context) {
    using Function = BOOL(WINAPI*)(HANDLE, void*, ULONG64);
    RESOLVE_OR_RETURN(SymRegisterCallback64, Function, FALSE);
    return function(process, callback, context);
}

extern "C" BOOL WINAPI DbgHelpProxy_SymRegisterCallbackW64(HANDLE process, void* callback, ULONG64 context) {
    using Function = BOOL(WINAPI*)(HANDLE, void*, ULONG64);
    RESOLVE_OR_RETURN(SymRegisterCallbackW64, Function, FALSE);
    return function(process, callback, context);
}

extern "C" DWORD WINAPI DbgHelpProxy_UnDecorateSymbolName(PCSTR name, PSTR output, DWORD outputLength, DWORD flags) {
    using Function = DWORD(WINAPI*)(PCSTR, PSTR, DWORD, DWORD);
    RESOLVE_OR_RETURN(UnDecorateSymbolName, Function, 0);
    return function(name, output, outputLength, flags);
}

extern "C" DWORD WINAPI DbgHelpProxy_UnDecorateSymbolNameW(PCWSTR name, PWSTR output, DWORD outputLength, DWORD flags) {
    using Function = DWORD(WINAPI*)(PCWSTR, PWSTR, DWORD, DWORD);
    RESOLVE_OR_RETURN(UnDecorateSymbolNameW, Function, 0);
    return function(name, output, outputLength, flags);
}

extern "C" BOOL WINAPI DbgHelpProxy_MiniDumpWriteDump(
    HANDLE process, DWORD processId, HANDLE file, DWORD dumpType,
    const void* exceptionInfo, const void* userStreams, const void* callbackInfo) {
    using Function = BOOL(WINAPI*)(HANDLE, DWORD, HANDLE, DWORD, const void*, const void*, const void*);
    RESOLVE_OR_RETURN(MiniDumpWriteDump, Function, FALSE);
    return function(process, processId, file, dumpType, exceptionInfo, userStreams, callbackInfo);
}

extern "C" BOOL WINAPI DbgHelpProxy_MiniDumpReadDumpStream(
    void* dump, ULONG streamNumber, void** directory, void** stream, ULONG* streamSize) {
    using Function = BOOL(WINAPI*)(void*, ULONG, void**, void**, ULONG*);
    RESOLVE_OR_RETURN(MiniDumpReadDumpStream, Function, FALSE);
    return function(dump, streamNumber, directory, stream, streamSize);
}

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        g_shimModule = module;
        DisableThreadLibraryCalls(module);
        // 在 DLL 注入阶段同步装载 CLI 代理主体。
        // agy.exe 正常运行期间不会主动调用 SymFromAddr 等符号导出，
        // 若依赖导出函数懒加载会导致 antigravity_proxy.dll 永远无法被装载 (Issue #149)。
        EnsureProxyLoadedForCli();
    }
    return TRUE;
}
