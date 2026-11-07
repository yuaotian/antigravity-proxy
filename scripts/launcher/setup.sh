#!/usr/bin/env bash
# ============================================================================
# Antigravity-Proxy Setup & Management Entry (Linux)
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_SCRIPT=""

if [[ -f "$SCRIPT_DIR/launcher/install-linux.sh" ]]; then
    TARGET_SCRIPT="$SCRIPT_DIR/launcher/install-linux.sh"
elif [[ -f "$SCRIPT_DIR/scripts/launcher/install-linux.sh" ]]; then
    TARGET_SCRIPT="$SCRIPT_DIR/scripts/launcher/install-linux.sh"
elif [[ -f "$SCRIPT_DIR/install-linux.sh" ]]; then
    TARGET_SCRIPT="$SCRIPT_DIR/install-linux.sh"
fi

if [[ -z "$TARGET_SCRIPT" ]]; then
    echo "[Error] Linux installer script not found."
    exit 1
fi

chmod +x "$TARGET_SCRIPT"
bash "$TARGET_SCRIPT" "$@"
