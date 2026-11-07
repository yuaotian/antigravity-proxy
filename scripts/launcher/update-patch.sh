#!/usr/bin/env bash
# ============================================================================
# Antigravity-Proxy Linux / WSL 一键在线更新脚本 (update-patch.sh)
# ============================================================================
# 支持两种更新模式:
# 1. 若当前位于 Git 仓库中，自动走本地代理 git pull 拉取最新代码与脚本
# 2. 自动查询 GitHub Releases API (或镜像源)，拉取最新 Release 资产并更新本地 Patch/ 或 ide/ 目录
#    同时智能保留用户原有的 config.json 代理端口设置
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$SCRIPT_DIR"
if [[ "$(basename "$SCRIPT_DIR")" == "launcher" || "$(basename "$SCRIPT_DIR")" == "scripts" ]]; then
    ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

echo "============================================================"
echo "  Antigravity-Proxy 一键在线更新工具 (Linux / WSL)"
echo "============================================================"

# 1. 读取本地 config.json 代理配置
PATCH_DIR="$ROOT_DIR/Patch"
[[ ! -d "$PATCH_DIR" && -d "$ROOT_DIR/ide" ]] && PATCH_DIR="$ROOT_DIR/ide"
mkdir -p "$PATCH_DIR"

PROXY_HOST="127.0.0.1"
PROXY_PORT="7890"
PROXY_TYPE="socks5"
LOCAL_VER="未知"

if [[ -f "$PATCH_DIR/config.json" ]] && command -v python3 >/dev/null 2>&1; then
    read -r LOCAL_VER PROXY_HOST PROXY_PORT PROXY_TYPE < <(python3 -c "
import json
try:
    with open('$PATCH_DIR/config.json', 'r', encoding='utf-8') as f:
        data = json.load(f)
        p = data.get('proxy', {})
        print(data.get('_version', '未知'), p.get('host', '127.0.0.1'), p.get('port', 7890), p.get('type', 'socks5'))
except Exception:
    print('未知 127.0.0.1 7890 socks5')
" 2>/dev/null || echo "未知 127.0.0.1 7890 socks5")
fi

echo "[*] 当前本地版本: $LOCAL_VER"
echo "[*] 当前代理配置: ${PROXY_TYPE}://${PROXY_HOST}:${PROXY_PORT}"

# 2. 如果当前目录是 Git 仓库，支持一键 git pull
if [[ -d "$ROOT_DIR/.git" ]] && command -v git >/dev/null 2>&1; then
    echo "[*] 检测到本地 Git 仓库，正在通过代理同步最新代码..."
    git -C "$ROOT_DIR" -c "http.proxy=http://${PROXY_HOST}:${PROXY_PORT}" -c "https.proxy=http://${PROXY_HOST}:${PROXY_PORT}" pull --rebase || true
fi

# 3. 请求 GitHub Releases Latest API
API_URL="https://api.github.com/repos/yuaotian/antigravity-proxy/releases/latest"
RESP="$(curl -fsSL -x "http://${PROXY_HOST}:${PROXY_PORT}" "$API_URL" 2>/dev/null || curl -fsSL "https://ghproxy.net/${API_URL}" 2>/dev/null || curl -fsSL "$API_URL" 2>/dev/null || true)"

if [[ -z "$RESP" ]]; then
    echo "[✗] 无法连接 GitHub Releases API，请检查网络连接或代理端口 (${PROXY_PORT})。"
    exit 1
fi

read -r REMOTE_TAG DOWNLOAD_URL < <(python3 -c "
import json, sys
data = json.loads('''$RESP''')
tag = data.get('tag_name', '')
url = ''
for a in data.get('assets', []):
    name = a.get('name', '')
    if 'ide-win-x64.zip' in name or 'win-x64.zip' in name:
        url = a.get('browser_download_url', '')
        break
print(tag, url)
")

REMOTE_VER="${REMOTE_TAG#v}"
echo "[✓] 最新官方 Release: ${REMOTE_TAG}"

if [[ "$LOCAL_VER" == "$REMOTE_VER" && "${1:-}" != "--force" ]]; then
    echo "[✓] 当前已是最新版本 (${LOCAL_VER})，无需更新！"
    exit 0
fi

if [[ -n "$DOWNLOAD_URL" ]]; then
    TMP_DIR="$(mktemp -d)"
    TMP_ZIP="$TMP_DIR/release.zip"
    echo "[*] 正在下载最新补丁包: $DOWNLOAD_URL ..."
    curl -fL -x "http://${PROXY_HOST}:${PROXY_PORT}" "$DOWNLOAD_URL" -o "$TMP_ZIP" 2>/dev/null || \
        curl -fL "https://ghproxy.net/${DOWNLOAD_URL}" -o "$TMP_ZIP"

    unzip -q -o "$TMP_ZIP" -d "$TMP_DIR/extracted"
    SRC_DIR="$TMP_DIR/extracted"
    [[ -d "$SRC_DIR/ide" ]] && SRC_DIR="$SRC_DIR/ide"

    cp -f "$SRC_DIR/version.dll" "$PATCH_DIR/version.dll" 2>/dev/null || true
    if [[ -f "$SRC_DIR/config.json" ]]; then
        python3 -c "
import json
with open('$SRC_DIR/config.json', 'r', encoding='utf-8') as f:
    cfg = json.load(f)
cfg.setdefault('proxy', {})['host'] = '$PROXY_HOST'
cfg['proxy']['port'] = int('$PROXY_PORT')
cfg['proxy']['type'] = '$PROXY_TYPE'
with open('$PATCH_DIR/config.json', 'w', encoding='utf-8') as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
"
    fi
    rm -rf "$TMP_DIR"
    echo "[✓] 已成功升级至 ${REMOTE_TAG} 并保留原有代理端口配置！"
fi

[[ -x "$SCRIPT_DIR/antigravity-launcher.sh" ]] && "$SCRIPT_DIR/antigravity-launcher.sh" --sync-only || true
