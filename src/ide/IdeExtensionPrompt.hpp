#pragma once

namespace IdeExtension {
    // 仅在 Antigravity IDE 主进程中运行：插件尚未安装时，后台线程延迟弹出系统通知（每个 DLL 版本最多一次）。
    // 点击通知后：DLL 同目录有 antigravity-proxy.vsix 时用 IDE 自带命令行（--install-extension）本地安装；
    // 只装了 DLL 时确认后在可见的 PowerShell 窗口运行在线安装脚本（-ExtensionOnly，代理可连时注入本 DLL 走代理）。
    // 运行中的 IDE 会自动加载新插件，无需重启。protocolLaunch：本次为 --open-url 协议启动（OAuth 回调等）时不打扰。
    void MaybePromptInstallAsync(bool protocolLaunch);
}
