#!/usr/bin/env bash
# ============================================================================
# Antigravity-Proxy Linux / WSL 启动守护与自动防覆盖恢复脚本 (antigravity-launcher.sh)
# ============================================================================
# 核心功能:
# 1. 自动读取同级 config.json 中的代理配置 (proxy.host / proxy.port / proxy.type)
# 2. 自动检测 Linux 原生端及 WSL 下的 language_server_linux_x64 是否因版本更新被重置为原始 ELF
#    若发现客户端更新覆盖了包装层，自动在毫秒内重新备份并挂载代理包装 (支持 graftcp / proxychains4 / 环境变量)
# 3. 启动 Antigravity 主程序并自动注入 Chromium --proxy-server 与全局环境变量
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$SCRIPT_DIR"
if [[ "$(basename "$SCRIPT_DIR")" == "launcher" || "$(basename "$SCRIPT_DIR")" == "scripts" ]]; then
    ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

# 1. 定位并解析 config.json
CONFIG_FILE=""
for candidate in "$ROOT_DIR/ide/config.json" "$ROOT_DIR/Patch/config.json" "$ROOT_DIR/config.json" "$SCRIPT_DIR/config.json"; do
    if [[ -f "$candidate" ]]; then
        CONFIG_FILE="$candidate"
        break
    fi
done

PROXY_HOST="127.0.0.1"
PROXY_PORT="7890"
PROXY_TYPE="socks5"

if [[ -n "$CONFIG_FILE" ]]; then
    if command -v python3 >/dev/null 2>&1; then
        read -r PROXY_HOST PROXY_PORT PROXY_TYPE < <(python3 -c "
import json, sys
try:
    with open('$CONFIG_FILE', 'r', encoding='utf-8') as f:
        d = json.load(f).get('proxy', {})
        print(d.get('host', '127.0.0.1'), d.get('port', 7890), d.get('type', 'socks5'))
except Exception:
    print('127.0.0.1 7890 socks5')
" 2>/dev/null || echo "127.0.0.1 7890 socks5")
    fi
fi

PROXY_URL="${PROXY_TYPE}://${PROXY_HOST}:${PROXY_PORT}"
HTTP_PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"

# 2. 自动守护并恢复因自动更新被覆盖的 language_server_linux_x64 (Linux & WSL2)
heal_language_server_binary() {
    local bin_path="$1"
    [[ ! -f "$bin_path" ]] && return 0

    # 检查文件头是否为原始 ELF 二进制（若已被更新还原为 ELF，而不是我们的 #! 包装脚本，则自动重新包装）
    if head -c 4 "$bin_path" 2>/dev/null | grep -q $'\x7fELF'; then
        local orig_path="${bin_path}.orig"
        cp -f "$bin_path" "$orig_path"
        chmod +x "$orig_path"

        cat > "$bin_path" <<EOF
#!/usr/bin/env bash
export ALL_PROXY="${PROXY_URL}"
export HTTPS_PROXY="${HTTP_PROXY_URL}"
export HTTP_PROXY="${HTTP_PROXY_URL}"
export all_proxy="${PROXY_URL}"
export https_proxy="${HTTP_PROXY_URL}"
export http_proxy="${HTTP_PROXY_URL}"
export NO_PROXY="localhost,127.0.0.1,::1"

if command -v graftcp >/dev/null 2>&1; then
    exec graftcp "${orig_path}" "\$@"
elif command -v proxychains4 >/dev/null 2>&1; then
    exec proxychains4 -q "${orig_path}" "\$@"
else
    exec "${orig_path}" "\$@"
fi
EOF
        chmod +x "$bin_path"
    fi
}

# 扫描常见 Linux & WSL2 Server 目录下的 language_server_linux_x64
for search_root in \
    "$HOME/.antigravity-server" \
    "$HOME/.antigravity" \
    "/opt/Antigravity" \
    "/usr/share/antigravity" \
    "$HOME/.local/share/antigravity"; do
    if [[ -d "$search_root" ]]; then
        while IFS= read -r -d '' ls_bin; do
            heal_language_server_binary "$ls_bin"
        done < <(find "$search_root" -maxdepth 6 -type f -name "language_server_linux*" ! -name "*.orig" -print0 2>/dev/null || true)
    fi
done

# 若仅作为后台更新修复守护运行 (--sync-only)
if [[ "${1:-}" == "--sync-only" ]]; then
    echo "[✓] Linux / WSL 代理包装层自检与修复完成 (当前代理: ${PROXY_URL})"
    exit 0
fi

# 3. 探测 Linux 桌面版 Antigravity 主程序路径
APP_BIN=""
if [[ -f "$ROOT_DIR/app_path_linux.txt" ]]; then
    SAVED_BIN="$(head -n 1 "$ROOT_DIR/app_path_linux.txt" | tr -d '\r\n')"
    [[ -x "$SAVED_BIN" ]] && APP_BIN="$SAVED_BIN"
fi

if [[ -z "$APP_BIN" ]]; then
    for candidate in \
        "/usr/bin/antigravity" \
        "/opt/Antigravity/antigravity" \
        "/opt/antigravity/antigravity" \
        "/usr/local/bin/antigravity" \
        "$HOME/.local/bin/antigravity"; do
        if [[ -x "$candidate" ]]; then
            APP_BIN="$candidate"
            break
        fi
    done
fi

if [[ -z "$APP_BIN" ]] && command -v antigravity >/dev/null 2>&1; then
    APP_BIN="$(command -v antigravity)"
fi

if [[ -z "$APP_BIN" ]]; then
    echo "[!] 未检测到 Linux 桌面版 Antigravity 主程序，仅已完成 WSL/Server 端 language_server 守护修复。"
    exit 0
fi

# 4. 注入代理环境变量与 Chromium 代理参数启动 Antigravity
export ALL_PROXY="${PROXY_URL}"
export HTTPS_PROXY="${HTTP_PROXY_URL}"
export HTTP_PROXY="${HTTP_PROXY_URL}"
export NO_PROXY="localhost,127.0.0.1,::1"

exec "$APP_BIN" --proxy-server="${PROXY_URL}" "$@"
