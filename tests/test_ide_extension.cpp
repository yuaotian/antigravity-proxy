// IDE 配套插件检测纯逻辑回归测试（Release 下也必须执行断言）。
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <string>

#include "ide/IdeExtensionLogic.hpp"

int main() {
    using namespace IdeExtension;

    // 主进程判定：只认 Antigravity IDE.exe 且命令行无 --type=，Node 模式（命令行工具）排除
    assert(IsIdeMainProcess(L"Antigravity IDE.exe", L"\"C:\\x\\Antigravity IDE.exe\" --new-window", false));
    assert(IsIdeMainProcess(L"antigravity ide.EXE", L"\"C:\\x\\Antigravity IDE.exe\"", false));
    assert(!IsIdeMainProcess(L"Antigravity IDE.exe", L"\"C:\\x\\Antigravity IDE.exe\" --type=renderer", false));
    assert(!IsIdeMainProcess(L"Antigravity IDE.exe", L"\"C:\\x\\Antigravity IDE.exe\" cli.js --install-extension a.vsix", true));
    assert(!IsIdeMainProcess(L"Antigravity.exe", L"\"C:\\x\\Antigravity.exe\"", false));
    assert(!IsIdeMainProcess(L"agy.exe", L"agy.exe --hub", false));

    // 参数读取：= 形式、空格分隔形式、带引号含空格路径
    const std::wstring cmd =
        L"\"C:\\Program Files\\Antigravity IDE\\Antigravity IDE.exe\" --user-data-dir=\"C:\\a b\\ud\" "
        L"--extensions-dir \"D:\\ext dir\" --new-window";
    assert(GetArgValue(cmd, L"--user-data-dir") == L"C:\\a b\\ud");
    assert(GetArgValue(cmd, L"--extensions-dir") == L"D:\\ext dir");
    assert(GetArgValue(cmd, L"--locale").empty());
    // 参数名前缀相同但不是同一参数时不误匹配
    assert(GetArgValue(L"x.exe --extensions-dir-other=1", L"--extensions-dir").empty());

    // product.json 解析：正常值、缺失回退、非法目录名回退
    assert(ParseDataFolderName("{\"nameShort\":\"Antigravity IDE\",\"dataFolderName\": \".antigravity-ide\"}") == ".antigravity-ide");
    assert(ParseDataFolderName("{}") == ".antigravity-ide");
    assert(ParseDataFolderName("{\"dataFolderName\":\"..\\\\evil\"}") == ".antigravity-ide");

    // extensions.json：按带引号的完整标识匹配，大小写不敏感，不被前缀相同的其它插件误判
    assert(ExtensionsJsonHasId("[{\"identifier\":{\"id\":\"Yuaotian.Antigravity-Proxy\"}}]", ExtensionId()));
    assert(!ExtensionsJsonHasId("[{\"identifier\":{\"id\":\"yuaotian.antigravity-proxy-lite\"}}]", ExtensionId()));
    assert(!ExtensionsJsonHasId("[]", ExtensionId()));

    // PowerShell 单引号转义：普通单引号与 PowerShell 视为单引号的弯引号都要写两次，$ 原样保留
    assert(QuotePsSingle(L"C:\\a b\\x") == L"'C:\\a b\\x'");
    assert(QuotePsSingle(L"C:\\it's\\$env") == L"'C:\\it''s\\$env'");
    assert(QuotePsSingle(L"a\x2019" L"b") == L"'a\x2019\x2019" L"b'");

    // 在线安装命令：只含单引号（可放进 -Command "..."），可选参数为空时不出现
    const std::wstring basic = BuildOnlineInstallCommand(L"C:\\Program Files\\Antigravity IDE", L"", L"", L"Press Enter");
    assert(basic.find(L'"') == std::wstring::npos);
    assert(basic.find(L"-ExtensionOnly -InstallDir 'C:\\Program Files\\Antigravity IDE'") != std::wstring::npos);
    assert(basic.find(L"-ExtensionsDir") == std::wstring::npos);
    assert(basic.find(L"-UserDataDir") == std::wstring::npos);
    assert(basic.find(OnlineScriptUrl()) != std::wstring::npos);
    assert(basic.size() > 13 && basic.substr(basic.size() - 13) == L"'Press Enter'");
    const std::wstring custom = BuildOnlineInstallCommand(L"D:\\IDE", L"D:\\ext dir", L"D:\\ud", L"x");
    assert(custom.find(L" -ExtensionsDir 'D:\\ext dir' -UserDataDir 'D:\\ud' }") != std::wstring::npos);
    return 0;
}
