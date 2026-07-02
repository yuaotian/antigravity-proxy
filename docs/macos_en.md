# macOS Guide

The Windows build works by loading `version.dll` and using MinHook to intercept Winsock calls. macOS cannot reuse that DLL injection path directly, especially for signed Electron apps and their child processes.

The macOS support in this repository uses a launcher instead:

- Adds Chromium/Electron `--proxy-server` flags to the Antigravity main process.
- Passes `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `GRPC_PROXY`, and `NO_PROXY` to child processes such as `language_server`.
- Optionally switches Clash Verge from TUN mode to macOS System Proxy.

This is not socket-level transparent proxying. It only affects Antigravity processes started through this script.

## Quick Start

First make sure Clash Verge or Mihomo is running:

```bash
./scripts/macos-antigravity-proxy.sh doctor
```

For Clash Verge Rev, the script reads:

- `~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/clash-verge.yaml` for `mixed-port`
- `~/Library/Application Support/io.github.clash-verge-rev.clash-verge-rev/verge.yaml` for `verge_mixed_port`

Start Antigravity through the proxy launcher:

```bash
./scripts/macos-antigravity-proxy.sh restart
```

For `/Applications/Antigravity IDE.app`:

```bash
./scripts/macos-antigravity-proxy.sh doctor --app ide
./scripts/macos-antigravity-proxy.sh restart --app ide
```

If the app does not quit cleanly:

```bash
./scripts/macos-antigravity-proxy.sh restart --force-kill
```

## Use System Proxy Instead of TUN

To update Clash Verge app settings:

```bash
./scripts/macos-antigravity-proxy.sh clash-verge use-system-proxy
```

This backs up and updates `verge.yaml`:

- `enable_tun_mode: false`
- `enable_system_proxy: true`
- `enable_proxy_guard: true`

If `/tmp/verge/verge-mihomo.sock` exists, the script also tries to disable runtime Mihomo TUN through the local controller API.

To write the proxy into macOS network services:

```bash
./scripts/macos-antigravity-proxy.sh system-proxy on
```

To roll back macOS System Proxy:

```bash
./scripts/macos-antigravity-proxy.sh system-proxy off
```

## Custom Paths or Ports

Use a custom proxy endpoint:

```bash
ANTIGRAVITY_PROXY_HOST=127.0.0.1 \
ANTIGRAVITY_PROXY_PORT=7890 \
./scripts/macos-antigravity-proxy.sh restart
```

Use a custom app path:

```bash
./scripts/macos-antigravity-proxy.sh restart --app "/path/to/Antigravity.app"
```

Environment variable alternatives:

```bash
ANTIGRAVITY_APP=ide ./scripts/macos-antigravity-proxy.sh restart
ANTIGRAVITY_APP_PATH="/Applications/Antigravity IDE.app" ./scripts/macos-antigravity-proxy.sh restart
```

## Verify

```bash
./scripts/macos-antigravity-proxy.sh doctor
./scripts/macos-antigravity-proxy.sh doctor --app ide
```

Expected signals:

- `Detected proxy: 127.0.0.1:<port>`
- `Proxy HTTP CONNECT test: ok`
- the Antigravity process command line contains `--proxy-server=http://127.0.0.1:<port>`

Logs are written to:

```text
~/Library/Logs/antigravity-proxy-macos/
```

## Notes

- If Antigravity still reports `User location is not supported for the API use.`, the proxy may be working but the egress IP is rejected by the service.
- Already-running Antigravity processes do not inherit new environment variables. Use `restart`.
- Starting Antigravity directly from Finder or Dock bypasses this script unless you create a local launcher that calls it.
