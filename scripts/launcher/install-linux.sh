#!/usr/bin/env bash
# ============================================================================
# Antigravity-Proxy Linux / WSL 快捷方式与自动防覆盖安装向导 (install-linux.sh)
# ============================================================================
# 支持安装位置:
# 1. 桌面快捷方式 (Desktop: ~/Desktop/Antigravity.desktop 或 ~/桌面)
# 2. 系统应用菜单 / 开始菜单 (Application Menu: ~/.local/share/applications/antigravity-proxy.desktop)
# 3. 任务栏 / Dock 固定 (GNOME Shell Favorites / KDE Plasma)
# 4. WSL2 / Linux Server 自动防覆盖守护钩子 (~/.bashrc / ~/.profile)
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCHER_SH="${SCRIPT_DIR}/antigravity-launcher.sh"
chmod +x "$LAUNCHER_SH" 2>/dev/null || true

GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${CYAN}============================================================${NC}"
echo -e "${CYAN}  Antigravity-Proxy (Linux / WSL) 快捷方式与防覆盖安装工具${NC}"
echo -e "${CYAN}============================================================${NC}"

# 定位图标
ICON_PATH="antigravity"
for candidate in \
    "/opt/Antigravity/resources/app/resources/linux/code.png" \
    "/usr/share/pixmaps/antigravity.png" \
    "${SCRIPT_DIR}/../../img/antigravity_logo.png"; do
    if [[ -f "$candidate" ]]; then
        ICON_PATH="$(cd "$(dirname "$candidate")" && pwd)/$(basename "$candidate")"
        break
    fi
done

generate_desktop_entry() {
    local target_file="$1"
    mkdir -p "$(dirname "$target_file")"
    cat > "$target_file" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=Antigravity (Proxy Guard)
Name[zh_CN]=Antigravity (免TUN防覆盖代理)
Comment=Launch Antigravity with transparent proxy and auto-update self-healing
Comment[zh_CN]=自动恢复代理补丁并启动 Antigravity
Exec="${LAUNCHER_SH}" %F
Icon=${ICON_PATH}
Terminal=false
StartupNotify=true
StartupWMClass=Antigravity
Categories=Development;IDE;
EOF
    chmod +x "$target_file"
    if command -v gio >/dev/null 2>&1; then
        gio set "$target_file" metadata::trusted true 2>/dev/null || true
    fi
}

install_desktop_shortcut() {
    local desktop_dir="$HOME/Desktop"
    if command -v xdg-user-dir >/dev/null 2>&1; then
        desktop_dir="$(xdg-user-dir DESKTOP)"
    elif [[ -d "$HOME/桌面" ]]; then
        desktop_dir="$HOME/桌面"
    fi
    local file="${desktop_dir}/antigravity-proxy.desktop"
    generate_desktop_entry "$file"
    echo -e "${GREEN}[✓] 已创建【桌面快捷方式】: ${file}${NC}"
}

install_app_menu_shortcut() {
    local app_dir="$HOME/.local/share/applications"
    local file="${app_dir}/antigravity-proxy.desktop"
    generate_desktop_entry "$file"
    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database "$app_dir" 2>/dev/null || true
    fi
    echo -e "${GREEN}[✓] 已添加到【系统开始菜单 / 应用启动器】: ${file}${NC}"
}

install_dock_pin() {
    install_app_menu_shortcut
    if command -v gsettings >/dev/null 2>&1; then
        local current_favs
        current_favs="$(gsettings get org.gnome.shell favorite-apps 2>/dev/null || true)"
        if [[ -n "$current_favs" && "$current_favs" != *"antigravity-proxy.desktop"* ]]; then
            local new_favs="${current_favs%]*}, 'antigravity-proxy.desktop']"
            gsettings set org.gnome.shell favorite-apps "$new_favs" 2>/dev/null || true
            echo -e "${GREEN}[✓] 已将 Antigravity 固定到 GNOME 任务栏 (Dock)！${NC}"
            return
        fi
    fi
    echo -e "${GREEN}[✓] 应用菜单项已就绪，您可在应用启动器中右键选择【固定到任务栏/Dock】。${NC}"
}

install_wsl_guard() {
    "$LAUNCHER_SH" --sync-only
    local rc_file="$HOME/.bashrc"
    local hook_line="[[ -x \"${LAUNCHER_SH}\" ]] && \"${LAUNCHER_SH}\" --sync-only >/dev/null 2>&1 &"
    if ! grep -Fq "antigravity-launcher.sh" "$rc_file" 2>/dev/null; then
        echo "" >> "$rc_file"
        echo "# Antigravity-Proxy Auto-Update Self-Healing Guard" >> "$rc_file"
        echo "$hook_line" >> "$rc_file"
    fi
    echo -e "${GREEN}[✓] 已激活 WSL / Linux Server 自动防覆盖守护（每次客户端升级后自动重挂载代理包装）${NC}"
}

uninstall_all() {
    rm -f "$HOME/Desktop/antigravity-proxy.desktop" "$HOME/桌面/antigravity-proxy.desktop"
    rm -f "$HOME/.local/share/applications/antigravity-proxy.desktop"
    echo -e "${GREEN}[✓] 已移除 Linux 桌面与应用菜单快捷方式${NC}"
}

MODE="${1:-interactive}"
if [[ "$MODE" == "--all" ]]; then
    install_desktop_shortcut
    install_app_menu_shortcut
    install_dock_pin
    install_wsl_guard
    exit 0
elif [[ "$MODE" == "--uninstall" ]]; then
    uninstall_all
    exit 0
fi

echo ""
echo "请选择安装模式："
echo "  [1] 🚀 一键全套安装（推荐：桌面快捷方式 + 开始菜单 + Dock任务栏固定 + 自动防覆盖）"
echo "  [2] 🖥️ 仅创建【桌面快捷方式】(Desktop)"
echo "  [3] 📂 仅添加到【系统开始菜单 / 应用列表】(App Menu)"
echo "  [4] 📌 固定到【任务栏 / Dock 栏】"
echo "  [5] 🐧 仅激活 WSL2 / Server 自动防覆盖守护"
echo "  [6] 🗑️ 卸载所有快捷方式"
echo ""
read -rp "请输入选项 [默认 1]: " choice
choice="${choice:-1}"

case "$choice" in
    1)
        install_desktop_shortcut
        install_app_menu_shortcut
        install_dock_pin
        install_wsl_guard
        ;;
    2) install_desktop_shortcut ;;
    3) install_app_menu_shortcut ;;
    4) install_dock_pin ;;
    5) install_wsl_guard ;;
    6) uninstall_all ;;
    *) echo "已退出。" ;;
esac
