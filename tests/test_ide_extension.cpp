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
    return 0;
}
