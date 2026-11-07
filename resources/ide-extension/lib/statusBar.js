// @ts-check
"use strict";

/**
 * 底部状态栏（单一职责：把状态模型渲染为状态栏文本/配色/悬浮提示；不做任何 IO）。
 * 点击 → 打开配置面板。按“影响程度”只展示最需要处理的一项，避免信息过载。
 * 文案经翻译函数输出（简体中文 / English / Русский），codicon 图标标记与文案分离。
 */

/**
 * @typedef {Object} StatusModel
 * @property {import("./patchGuard").PatchStatus} patch
 * @property {"ok" | "missing" | "invalid" | "error"} configStatus
 * @property {{ host: string, port: number, type: string } | null} proxy
 * @property {import("./proxyProbe").ProbeResult | null} reach
 * @property {boolean} pendingRestart
 */

/** @typedef {(key: string, params?: Record<string, any>) => string} Translate */

class ProxyStatusBar {
  /** @param {typeof import("vscode")} vscode @param {Translate} t */
  constructor(vscode, t) {
    this.vscode = vscode;
    this.t = t;
    this.item = vscode.window.createStatusBarItem("antigravityProxy.status", vscode.StatusBarAlignment.Right, 100);
    this.item.name = "Antigravity Proxy";
    this.item.command = "antigravityProxy.openSettings";
  }

  /** @param {StatusModel} m */
  render(m) {
    const { ThemeColor, MarkdownString } = this.vscode;
    const t = this.t;
    const port = m.proxy ? m.proxy.port : 0;
    /** @type {{ icon: string, text: string, bg?: string, summary: string }} */
    let view;
    if (!m.patch.dllExists) {
      view = { icon: "error", text: t("sb.patchMissing"), bg: "statusBarItem.errorBackground", summary: t("sb.patchMissingSummary") };
    } else if (m.configStatus !== "ok") {
      view = { icon: "warning", text: t("sb.configBad"), bg: "statusBarItem.warningBackground", summary: t(m.configStatus === "missing" ? "sb.configMissingSummary" : "sb.configInvalidSummary") };
    } else if (m.pendingRestart || m.patch.needsRestart) {
      view = { icon: "sync", text: t("sb.pending"), bg: "statusBarItem.warningBackground", summary: t("sb.pendingSummary") };
    } else if (port === 0) {
      view = { icon: "circle-slash", text: t("sb.disabled"), summary: t("sb.disabledSummary") };
    } else if (m.reach && !m.reach.ok) {
      view = { icon: "debug-disconnect", text: t("sb.unreachable", { port }), bg: "statusBarItem.warningBackground", summary: m.reach.message };
    } else {
      view = { icon: "globe", text: t("sb.ok", { port }), summary: t("sb.okSummary") };
    }

    this.item.text = `$(${view.icon}) ${view.text}`;
    this.item.backgroundColor = view.bg ? new ThemeColor(view.bg) : undefined;
    // 明确的无障碍名称与角色：读屏可朗读完整状态，也便于 UI 自动化定位
    this.item.accessibilityInformation = {
      label: t("sb.a11y", { text: view.text, summary: view.summary }),
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
    md.appendMarkdown(`**Antigravity Proxy** — ${escapeMd(view.summary)}\n\n`);
    md.appendMarkdown("| | |\n|:--|:--|\n");
    md.appendMarkdown(`| ${t("sb.rowPatch")} | ${patchText(m.patch, t)} |\n`);
    md.appendMarkdown(`| ${t("sb.rowConfig")} | ${configText(m.configStatus, t)} |\n`);
    if (m.proxy) md.appendMarkdown(`| ${t("sb.rowProxy")} | \`${m.proxy.type}://${m.proxy.host}:${m.proxy.port}\` |\n`);
    if (m.reach) md.appendMarkdown(`| ${t("sb.rowReach")} | ${m.reach.ok ? `$(pass-filled) ${t("sb.reachOk")}` : "$(warning) " + escapeMd(m.reach.message)} |\n`);
    md.appendMarkdown(`\n[$(settings-gear) ${t("sb.linkSettings")}](command:antigravityProxy.openSettings)`);
    md.appendMarkdown(` · [$(plug) ${t("sb.linkTest")}](command:antigravityProxy.testProxy)`);
    if (!m.patch.dllExists) md.appendMarkdown(` · [$(cloud-download) ${t("sb.linkRepair")}](command:antigravityProxy.repairPatch)`);
    if (m.pendingRestart || m.patch.needsRestart) md.appendMarkdown(` · [$(debug-restart) ${t("sb.linkRestart")}](command:antigravityProxy.restartIde)`);
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

/** @param {import("./patchGuard").PatchStatus} p @param {Translate} t */
function patchText(p, t) {
  if (!p.dllExists) return `$(error) ${t("sb.patchStateMissing")}`;
  if (p.dllLoaded === true) return `$(pass-filled) ${t("sb.patchStateActive")}`;
  if (p.dllLoaded === false) return `$(sync) ${t("sb.patchStatePending")}`;
  return `$(info) ${t("sb.patchStateReady")}`;
}

/** @param {string} s @param {Translate} t */
function configText(s, t) {
  const map = {
    ok: `$(pass-filled) ${t("sb.configStateOk")}`,
    missing: `$(warning) ${t("sb.configStateMissing")}`,
    invalid: `$(warning) ${t("sb.configStateInvalid")}`,
    error: `$(error) ${t("sb.configStateError")}`,
  };
  return /** @type {Record<string, string>} */ (map)[s] || s;
}

/** @param {string} s */
function escapeMd(s) {
  return String(s).replace(/[|*_`[\]\\]/g, (c) => `\\${c}`);
}

module.exports = { ProxyStatusBar };
