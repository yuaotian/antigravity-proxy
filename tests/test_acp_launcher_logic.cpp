// 回归测试在 Release 构建下也必须执行断言。
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <string>

#include "launcher/AcpProxyLauncherLogic.hpp"

int main() {
    using AcpLauncher::ExtractFirstToken;
    using AcpLauncher::GetParentDirectory;
    using AcpLauncher::ProxyDllCandidates;
    using AcpLauncher::SkipFirstCommandLineToken;

    // 带引号、含空格的包装器路径：剩余部分原样保留（包括目标程序的引号）。
    assert(SkipFirstCommandLineToken(
               L"\"C:\\Program Files\\AGP\\agy-acp-proxy.exe\" \"C:\\Users\\a b\\.gemini\\bin\\agy.exe\" acp") ==
           L"\"C:\\Users\\a b\\.gemini\\bin\\agy.exe\" acp");

    // 无引号路径：遇到第一个空白结束。
    assert(SkipFirstCommandLineToken(L"agy-acp-proxy.exe agy acp --sandbox") == L"agy acp --sandbox");

    // 多个空白与制表符被跳过，但目标参数内部的空白与转义保持不变。
    assert(SkipFirstCommandLineToken(L"agy-acp-proxy.exe \t  agy.exe --add-dir \"D:\\my code\\\"") ==
           L"agy.exe --add-dir \"D:\\my code\\\"");

    // 没有目标程序：返回空串（包装器据此输出用法并退出）。
    assert(SkipFirstCommandLineToken(L"agy-acp-proxy.exe").empty());
    assert(SkipFirstCommandLineToken(L"\"C:\\x y\\agy-acp-proxy.exe\"   ").empty());
    assert(SkipFirstCommandLineToken(L"").empty());
    assert(SkipFirstCommandLineToken(L"   ").empty());

    // 引号未闭合：整行视为 argv[0]，没有剩余参数。
    assert(SkipFirstCommandLineToken(L"\"C:\\broken agy-acp-proxy.exe agy acp").empty());

    // argv[0] 前的前导空白（极少见）也能正确处理。
    assert(SkipFirstCommandLineToken(L"  agy-acp-proxy.exe agy acp") == L"agy acp");

    // 目标程序提取：只取第一个参数并去掉外层引号（日志不记录后续可能含密钥的参数）。
    assert(ExtractFirstToken(L"\"C:\\Users\\a b\\agy_acp_server.exe\" --flag secret") ==
           L"C:\\Users\\a b\\agy_acp_server.exe");
    assert(ExtractFirstToken(L"agy acp") == L"agy");
    assert(ExtractFirstToken(L"agy.exe") == L"agy.exe");

    // DLL 候选顺序：CLI 包名优先，其次与 IDE 共用的 version.dll。
    assert(ProxyDllCandidates().size() == 2);
    assert(ProxyDllCandidates()[0] == L"antigravity_proxy.dll");
    assert(ProxyDllCandidates()[1] == L"version.dll");

    assert(GetParentDirectory(L"C:\\a\\b\\agy-acp-proxy.exe") == L"C:\\a\\b");
    assert(GetParentDirectory(L"C:/a/agy-acp-proxy.exe") == L"C:/a");
    assert(GetParentDirectory(L"agy-acp-proxy.exe").empty());

    return 0;
}
