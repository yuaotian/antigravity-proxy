# macOS 使用指南

Windows 版本通过 `version.dll` 劫持和 MinHook 拦截 Winsock 调用。macOS 不能直接复用这套 DLL 注入链路，尤其是 Electron 应用和子进程会受到签名、SIP、hardened runtime 等限制。

本项目的 macOS 方案改为“代理化启动 Antigravity”：

- 给 Antigravity 主进程添加 Chromium/Electron `--proxy-server` 参数。
- 给 Antigravity 子进程继承 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`GRPC_PROXY`、`NO_PROXY` 等环境变量。
- 可选开启 macOS System Proxy，并关闭 Clash Verge TUN。

这不会在 socket 层透明劫持所有程序，只影响通过该脚本启动的 Antigravity 及其子进程；对 Antigravity 的 Electron 网络栈、Go `language_server` 的 `net/http`/gRPC 链路更贴近实际有效路径。

## 快速开始

先确保 Clash Verge 已启动，并且本地混合端口可用：

```bash
./scripts/macos-antigravity-proxy.sh doctor
```

如果你使用 Clash Verge Rev，脚本会优先读取：

- `~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/clash-verge.yaml` 的 `mixed-port`
- `~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/verge.yaml` 的 `verge_mixed_port`

例如 Clash Verge Rev 常见配置是 `127.0.0.1:7897`。

只让 Antigravity 走代理：

```bash
./scripts/macos-antigravity-proxy.sh restart
```

如果你用的是 `/Applications/Antigravity IDE.app`：

```bash
./scripts/macos-antigravity-proxy.sh doctor --app ide
./scripts/macos-antigravity-proxy.sh restart --app ide
```

如果 Antigravity 无法正常退出，可以改用：

```bash
./scripts/macos-antigravity-proxy.sh restart --force-kill
```

## 不走 TUN，改用系统代理

关闭 Clash Verge TUN、打开 System Proxy 的配置可以用：

```bash
./scripts/macos-antigravity-proxy.sh clash-verge use-system-proxy
```

该命令会备份并修改 Clash Verge 的 `verge.yaml`：

- `enable_tun_mode: false`
- `enable_system_proxy: true`
- `enable_proxy_guard: true`

如果 `/tmp/verge/verge-mihomo.sock` 可用，脚本还会通过 Mihomo 本地控制接口立即关闭运行态 TUN。若 Clash Verge UI 仍显示旧状态，可以重启 Clash Verge，或在 UI 里重新切换一次 System Proxy。

也可以直接让脚本写入 macOS 网络服务代理：

```bash
./scripts/macos-antigravity-proxy.sh system-proxy on
```

回滚系统代理：

```bash
./scripts/macos-antigravity-proxy.sh system-proxy off
```

## 自定义端口

如果你的 Clash/Mihomo 不是默认路径或端口：

```bash
ANTIGRAVITY_PROXY_HOST=127.0.0.1 \
ANTIGRAVITY_PROXY_PORT=7890 \
./scripts/macos-antigravity-proxy.sh restart
```

如果 Antigravity 不在 `/Applications/Antigravity.app`：

```bash
./scripts/macos-antigravity-proxy.sh restart --app "/path/to/Antigravity.app"
```

也可以用环境变量：

```bash
ANTIGRAVITY_APP=ide ./scripts/macos-antigravity-proxy.sh restart
ANTIGRAVITY_APP_PATH="/Applications/Antigravity IDE.app" ./scripts/macos-antigravity-proxy.sh restart
```

## 验证

查看代理和运行状态：

```bash
./scripts/macos-antigravity-proxy.sh doctor
```

你应该能看到：

- `Detected proxy: 127.0.0.1:<port>`
- `Proxy HTTP CONNECT test: ok`
- Antigravity 进程命令行里有 `--proxy-server=http://127.0.0.1:<port>`
- 对 Antigravity IDE，命令改为 `./scripts/macos-antigravity-proxy.sh doctor --app ide`

脚本启动日志在：

```text
~/Library/Logs/antigravity-proxy-macos/
```

## 注意事项

- 如果 Antigravity 日志仍出现 `User location is not supported for the API use.`，这通常是代理出口 IP 被服务端策略拒绝，不是本地代理没有生效。优先换出口 IP。
- 已经运行中的 Antigravity 不会自动继承新的环境变量，所以需要通过 `restart` 重新启动。
- Finder 直接双击 Antigravity 不会经过本脚本，也就不会带上这些代理环境变量。
