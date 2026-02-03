# 项目上下文信息

- 用户说明：当前提供的长日志为“对方/朋友那台无法成功代理的机器”的运行日志（非用户自己机器）。
- 排障上下文：目标程序为 `Antigravity.exe` 与 `language_server_windows_x64.exe`；在国内环境必须走代理。对方机器移除本项目 DLL 后改用 Clash TUN 模式可正常访问，说明网络/Clash 本身可用，问题集中在 DLL Hook 代理路径（当前未代理 UDP/QUIC 的可能性很高）。
