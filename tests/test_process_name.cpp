// 回归测试在 Release 构建下也必须执行断言。
#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <string>

#include "hooks/ProcessName.hpp"

int main() {
    using Hooks::GetCreateProcessTargetBaseNameA;
    using Hooks::IsAntigravityHostProcessName;
    using Hooks::IsLanguageServerProcessName;

    // lpApplicationName 明确给出路径时，不按空格截断文件名。
    assert(GetCreateProcessTargetBaseNameA(
               "C:\\Users\\test\\AppData\\Local\\Programs\\Antigravity\\Antigravity IDE.exe",
               nullptr) == "Antigravity IDE.exe");

    // 命令行带引号时，保留引号内完整 exe 路径，再提取文件名。
    assert(GetCreateProcessTargetBaseNameA(
               nullptr,
               "\"C:\\Users\\test\\AppData\\Local\\Programs\\Antigravity\\Antigravity IDE.exe\" --type=renderer") ==
           "Antigravity IDE.exe");

    // 命令行未加引号但包含 .exe 时，优先截到 .exe，避免参数污染进程名。
    assert(GetCreateProcessTargetBaseNameA(
               nullptr,
               "C:\\Users\\test\\AppData\\Local\\Programs\\Antigravity\\resources\\bin\\language_server.exe --stdio") ==
           "language_server.exe");

    // 普通无空格路径保持历史行为。
    assert(GetCreateProcessTargetBaseNameA(nullptr, "node.exe --inspect") == "node.exe");

    // 新旧 language server 命名都要触发窄范围 node 子进程兼容。
    assert(IsLanguageServerProcessName("language_server.exe"));
    assert(IsLanguageServerProcessName("language_server"));
    assert(IsLanguageServerProcessName("language_server_windows_x64.exe"));
    assert(!IsLanguageServerProcessName("Antigravity IDE.exe"));

    // 保留宿主进程名分类工具的稳定行为；运行时策略在 main.cpp 中统一启用全量 Hook。
    assert(IsAntigravityHostProcessName("Antigravity.exe"));
    assert(IsAntigravityHostProcessName("ANTIGRAVITY IDE.EXE"));
    assert(!IsAntigravityHostProcessName("language_server.exe"));
    assert(!IsAntigravityHostProcessName("node.exe"));

    // Issue #164：ACP Registry 版服务端进程名识别（大小写不敏感，带/不带扩展名）。
    using Hooks::IsAcpServerChainChildName;
    using Hooks::IsAgyAcpServerProcessName;
    assert(IsAgyAcpServerProcessName("agy_acp_server.exe"));
    assert(IsAgyAcpServerProcessName("AGY_ACP_SERVER.EXE"));
    assert(IsAgyAcpServerProcessName("agy_acp_server"));
    // agy.exe（CLI）不是 ACP Registry 服务端，不应触发 ACP 进程链兼容规则。
    assert(!IsAgyAcpServerProcessName("agy.exe"));
    assert(!IsAgyAcpServerProcessName("language_server.exe"));

    // 兼容规则只放行 PyInstaller 主体与 localharness 引擎，工具子进程保持 filtered 行为。
    assert(IsAcpServerChainChildName("agy_acp_server.exe"));
    assert(IsAcpServerChainChildName("localharness_external.exe"));
    assert(IsAcpServerChainChildName("LocalHarness_External.EXE"));
    assert(!IsAcpServerChainChildName("powershell.exe"));
    assert(!IsAcpServerChainChildName("git.exe"));
    assert(!IsAcpServerChainChildName("node.exe"));

    // 回归：带空格路径下的 ACP 服务端也能正确提取进程名。
    assert(GetCreateProcessTargetBaseNameA(
               nullptr,
               "\"C:\\Users\\test\\AppData\\Local\\JetBrains\\acp agents\\antigravity-acp\\1.5.0\\agy_acp_server.exe\"") ==
           "agy_acp_server.exe");
    assert(GetCreateProcessTargetBaseNameA(
               nullptr,
               "C:\\Users\\test\\AppData\\Local\\Temp\\_MEI12345\\localharness_external.exe --uid=") ==
           "localharness_external.exe");

    return 0;
}
