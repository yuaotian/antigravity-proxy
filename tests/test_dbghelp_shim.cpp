#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>

#include <array>
// 回归测试在 Release 构建下也必须执行断言。
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <string>

int wmain(int argc, wchar_t** argv) {
    assert(argc == 2);
    const HMODULE shim = LoadLibraryW(argv[1]);
    assert(shim != nullptr);
    // agy.exe 注入 dbghelp.dll 时（DLL_PROCESS_ATTACH 阶段）即应加载同目录代理主体，
    // 避免因 agy.exe 正常运行期间不主动调用导出符号而导致代理主体无法装载 (Issue #149)。
    assert(GetModuleHandleW(L"antigravity_proxy.dll") != nullptr);

    constexpr std::array<const char*, 12> requiredExports = {
        "MiniDumpWriteDump",
        "StackWalk64",
        "SymCleanup",
        "SymFromAddr",
        "SymFunctionTableAccess64",
        "SymGetModuleBase64",
        "SymGetOptions",
        "SymInitialize",
        "SymLoadModuleEx",
        "SymRefreshModuleList",
        "SymSetOptions",
        "UnDecorateSymbolName",
    };
    for (const char* name : requiredExports) {
        assert(GetProcAddress(shim, name) != nullptr);
    }

    using SymGetOptionsFn = DWORD(WINAPI*)();
    const auto getOptions =
        reinterpret_cast<SymGetOptionsFn>(GetProcAddress(shim, "SymGetOptions"));
    assert(getOptions != nullptr);
    (void)getOptions();
    assert(GetModuleHandleW(L"antigravity_proxy.dll") != nullptr);

    using UnDecorateSymbolNameFn = DWORD(WINAPI*)(PCSTR, PSTR, DWORD, DWORD);
    const auto undecorate = reinterpret_cast<UnDecorateSymbolNameFn>(
        GetProcAddress(shim, "UnDecorateSymbolName"));
    assert(undecorate != nullptr);
    char output[256] = {};
    assert(undecorate("?CompatibilityProbe@@YAXXZ", output, sizeof(output), 0) > 0);

    FreeLibrary(shim);
    return 0;
}
