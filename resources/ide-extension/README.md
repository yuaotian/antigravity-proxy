# Antigravity Proxy

Companion extension for **Antigravity IDE on Windows**.

It shows the proxy/patch status, egress IP and ISP, Gemini/Antigravity reachability, live logs and a visual
`config.json` editor. If an IDE update removes the proxy patch, the extension restores it from its bundled
payload on the next start.

Using Antigravity via **ACP** in JetBrains, Zed or VS Code? Click **ACP Proxy for Other Editors** in the
sidebar: the extension finds `agy acp` / the ACP Registry `agy_acp_server.exe`, deploys the `agy-acp-proxy.exe`
launcher and writes (JetBrains) or copies (Zed / VS Code) the agent config so those agents use the proxy too.

## Screenshots

| English | 简体中文 | Русский |
|:--:|:--:|:--:|
| ![English UI](https://raw.githubusercontent.com/yuaotian/antigravity-proxy/main/docs/images/ide-extension/logview.png) | ![简体中文界面](https://raw.githubusercontent.com/yuaotian/antigravity-proxy/main/docs/images/ide-extension/logview.zh-cn.png) | ![Русский интерфейс](https://raw.githubusercontent.com/yuaotian/antigravity-proxy/main/docs/images/ide-extension/logview.ru.png) |

## Install

### From Open VSX (recommended for x64)

Open [Antigravity Proxy on Open VSX](https://open-vsx.org/extension/yuaotian/antigravity-proxy), or run:

```powershell
& "$env:LOCALAPPDATA\Programs\Antigravity IDE\bin\antigravity-ide.cmd" --install-extension yuaotian.antigravity-proxy
```

> **Windows ARM64 / x86 note**: Open VSX distributes the **x64** package only. Native Windows ARM64 or 32-bit x86 Antigravity IDE users should install `antigravity-proxy-vX-ide-extension-win-arm64.vsix` (or `win-x86.vsix`) from [GitHub Releases](https://github.com/yuaotian/antigravity-proxy/releases) — the extension verifies executable architecture before writing `version.dll`.

If the IDE search index has not caught up yet, download the VSIX from the Open VSX page and use
**Extensions → … → Install from VSIX**.

### From VSIX

Download the VSIX matching your IDE architecture (`win-x64`, `win-x86`, or `win-arm64`) from
[GitHub Releases](https://github.com/yuaotian/antigravity-proxy/releases) or the Open VSX page (`x64` only), then:

```powershell
& "$env:LOCALAPPDATA\Programs\Antigravity IDE\bin\antigravity-ide.cmd" --install-extension .\antigravity-proxy-2.6.3.vsix --force
```

Reload the IDE window after installation.

## 简体中文

**Antigravity IDE 的代理配套插件（Windows）。** 提供补丁/代理/连通状态、出口 IP 与运营商、Gemini/Antigravity
可用性、实时日志、可视化配置，以及 IDE 更新后自动恢复 `version.dll`。

在 JetBrains / Zed / VS Code 里经 **ACP** 使用 Antigravity？点击侧栏「外部编辑器 ACP 代理」，插件会自动检测
`agy acp` 与 ACP Registry 版 `agy_acp_server.exe`，部署 `agy-acp-proxy.exe` 并一键写入（JetBrains）或复制（Zed / VS Code）
Agent 配置，让这些编辑器里的 Antigravity 也走代理，全程无需终端。

**安装（Open VSX · 仅 x64）：**

```powershell
& "$env:LOCALAPPDATA\Programs\Antigravity IDE\bin\antigravity-ide.cmd" --install-extension yuaotian.antigravity-proxy
```

> **选包提示**：Open VSX 仅分发 **x64** 包。原生 **Windows ARM64** 或 **x86** 版 Antigravity IDE 请勿直接安装市场包，请从 [GitHub Releases](https://github.com/yuaotian/antigravity-proxy/releases) 下载对应架构的 `*-ide-extension-win-arm64.vsix` / `*-win-x86.vsix`（插件恢复 `version.dll` 前会校验目标主程序架构，不匹配会拒绝写入）。

也可以打开 [Open VSX 页面](https://open-vsx.org/extension/yuaotian/antigravity-proxy)（`x64`）或 [GitHub Releases](https://github.com/yuaotian/antigravity-proxy/releases) 下载对应架构的 VSIX，在扩展视图右上角
`…` → 「从 VSIX 安装」。安装后执行 `Reload Window`。

## Русский

**Сопутствующее расширение для прокси в Antigravity IDE (Windows).** Показывает состояние патча/прокси,
внешний IP и провайдера, доступность Gemini/Antigravity, живой журнал, визуальные настройки и восстанавливает
`version.dll` после обновления IDE.

Используете Antigravity через **ACP** в JetBrains, Zed или VS Code? Нажмите «ACP-прокси для других редакторов»
на боковой панели: расширение найдёт `agy acp` / `agy_acp_server.exe` из ACP Registry, развернёт обёртку
`agy-acp-proxy.exe` и запишет (JetBrains) или скопирует (Zed / VS Code) настройки агента, чтобы он тоже шёл через прокси.

**Установка из Open VSX (только x64):**

```powershell
& "$env:LOCALAPPDATA\Programs\Antigravity IDE\bin\antigravity-ide.cmd" --install-extension yuaotian.antigravity-proxy
```

> **Выбор пакета**: в Open VSX публикуется только пакет **x64**. Для нативной **Windows ARM64** или 32-разрядной **x86** Antigravity IDE скачайте `*-ide-extension-win-arm64.vsix` / `*-win-x86.vsix` из [GitHub Releases](https://github.com/yuaotian/antigravity-proxy/releases) — перед записью `version.dll` расширение проверяет архитектуру IDE.

Либо скачайте VSIX для вашей архитектуры со [страницы Open VSX](https://open-vsx.org/extension/yuaotian/antigravity-proxy) (`x64`) или из [GitHub Releases](https://github.com/yuaotian/antigravity-proxy/releases) и выберите
**Extensions → … → Install from VSIX**. После установки выполните `Reload Window`.

## Links

- Repository: https://github.com/yuaotian/antigravity-proxy
- Documentation: https://github.com/yuaotian/antigravity-proxy/blob/main/docs/ide-extension.md
- Issues: https://github.com/yuaotian/antigravity-proxy/issues
- License: BSD-2-Clause (see `LICENSE.txt`; `win-arm64` packages also bundle Microsoft Detours under MIT in `THIRD_PARTY_DETOURS_LICENSE.md`)
