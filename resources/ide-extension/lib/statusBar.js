// @ts-check
"use strict";

/**
 * 底部状态栏（单一职责：把状态模型渲染为状态栏文本/配色/悬浮提示；不做任何 IO）。
 * 点击 → 打开配置面板。按“影响程度”只展示最需要处理的一项，避免信息过载。
 */

/**
 * @typedef {Object} StatusModel
 * @property {import("./patchGuard").PatchStatus} patch
 * @property {"ok" | "missing" | "invalid" | "error"} configStatus
 * @property {{ host: string, port: number, type: string } | null} proxy
 * @property {import("./proxyProbe").ProbeResult | null} reach
 * @property {boolean} pendingRestart
 */

class ProxyStatusBar {
  /** @param {typeof import("vscode")} vscode */
  constructor(vscode) {
    this.vscode = vscode;
    this.item = vscode.window.createStatusBarItem("antigravityProxy.status", vscode.StatusBarAlignment.Right, 100);
    this.item.name = "Antigravity Proxy";
    this.item.command = "antigravityProxy.openSettings";
  }

  /** @param {StatusModel} m */
  render(m) {
    const { ThemeColor, MarkdownString } = this.vscode;
    const port = m.proxy ? m.proxy.port : 0;
    /** @type {{ text: string, bg?: string, summary: string }} */
    let view;
    if (!m.patch.dllExists) {
      view = { text: "$(error) 代理补丁缺失", bg: "statusBarItem.errorBackground", summary: "version.dll 不在安装目录（常见于 IDE 自动更新后），点击修复。" };
    } else if (m.configStatus !== "ok") {
      view = { text: "$(warning) 代理配置异常", bg: "statusBarItem.warningBackground", summary: m.configStatus === "missing" ? "缺少 config.json。" : "config.json 无法解析。" };
    } else if (m.pendingRestart || m.patch.needsRestart) {
      view = { text: "$(sync) 代理 · 待重启", bg: "statusBarItem.warningBackground", summary: "配置或补丁已更新，重启 IDE 后生效。" };
    } else if (port === 0) {
      view = { text: "$(circle-slash) 代理已禁用", summary: "proxy.port=0，全部连接直连。" };
    } else if (m.reach && !m.reach.ok) {
      view = { text: `$(debug-disconnect) 代理 ${port} 不可达`, bg: "statusBarItem.warningBackground", summary: m.reach.message };
    } else {
      view = { text: `$(globe) 代理 ${port}`, summary: "代理补丁已生效。" };
    }

    this.item.text = view.text;
    this.item.backgroundColor = view.bg ? new ThemeColor(view.bg) : undefined;
    // 明确的无障碍名称与角色：读屏可朗读完整状态，也便于 UI 自动化定位
    this.item.accessibilityInformation = {
      label: `Antigravity Proxy：${view.text.replace(/\$\([^)]+\)\s*/g, "")}。${view.summary} 点击打开代理设置`,
      role: "button",
    };

    const md = new MarkdownString(undefined, true);
    md.isTrusted = {
      enabledCommands: [
        "antigravityProxy.openSettings",
        "antigravityProxy.testProxy",
        "antigravityProxy.repairPatch",
        "antigravityProxy.restartIde",
      ],
    };
    md.appendMarkdown(`**Antigravity Proxy** — ${view.summary}\n\n`);
    md.appendMarkdown("| | |\n|:--|:--|\n");
    md.appendMarkdown(`| 补丁 | ${patchText(m.patch)} |\n`);
    md.appendMarkdown(`| 配置 | ${configText(m.configStatus)} |\n`);
    if (m.proxy) md.appendMarkdown(`| 代理 | \`${m.proxy.type}://${m.proxy.host}:${m.proxy.port}\` |\n`);
    if (m.reach) md.appendMarkdown(`| 连通 | ${m.reach.ok ? "$(pass-filled) 可达" : "$(warning) " + escapeMd(m.reach.message)} |\n`);
    md.appendMarkdown("\n[$(settings-gear) 打开设置](command:antigravityProxy.openSettings)");
    md.appendMarkdown(" · [$(plug) 测试连接](command:antigravityProxy.testProxy)");
    if (!m.patch.dllExists) md.appendMarkdown(" · [$(cloud-download) 修复补丁](command:antigravityProxy.repairPatch)");
    if (m.pendingRestart || m.patch.needsRestart) md.appendMarkdown(" · [$(debug-restart) 重启 IDE](command:antigravityProxy.restartIde)");
    this.item.tooltip = md;
    this.item.show();
  }

  hide() {
    this.item.hide();
  }

  dispose() {
    this.item.dispose();
  }
}

/** @param {import("./patchGuard").PatchStatus} p */
function patchText(p) {
  if (!p.dllExists) return "$(error) 缺失";
  if (p.dllLoaded === true) return "$(pass-filled) 已生效";
  if (p.dllLoaded === false) return "$(sync) 文件就绪，待重启";
  return "$(info) 文件就绪";
}

/** @param {string} s */
function configText(s) {
  return { ok: "$(pass-filled) 正常", missing: "$(warning) 缺失", invalid: "$(warning) 无法解析", error: "$(error) 读取失败" }[s] || s;
}

/** @param {string} s */
function escapeMd(s) {
  return String(s).replace(/[|*_`[\]\\]/g, (c) => `\\${c}`);
}

module.exports = { ProxyStatusBar };
