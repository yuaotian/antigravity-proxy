#pragma once

namespace IdeExtension {
    // 仅在 Antigravity IDE 主进程中运行：DLL 同目录存在 antigravity-proxy.vsix 且插件尚未安装时，
    // 后台线程延迟询问用户是否安装；同意后调用 IDE 自带命令行（--install-extension）安装，
    // 运行中的 IDE 会自动加载新插件，无需重启。每个 DLL 版本最多询问一次。
    // protocolLaunch：本次为 --open-url 协议启动（OAuth 回调等）时不打扰。
    void MaybePromptInstallAsync(bool protocolLaunch);
}
