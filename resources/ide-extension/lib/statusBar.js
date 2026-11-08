// @ts-check
"use strict";

/**
 * 底部状态栏（单一职责：把状态模型渲染为状态栏文本/配色/动效/悬浮提示；不做任何 IO）。
 *
 * 设计（2026-11-08 按用户反馈调整）：
 * - 只保留 **一个** 状态栏条目，按"影响程度"只展示最需要处理的一项（补丁/配置/后端进程/待重启/端口/连通）；
 * - 出口 IP·运营商、Gemini/Antigravity 结论、插件更新全部合并到同一个悬浮卡片里，不再额外占用底部空间；
 * - 右侧侧栏与日志窗口仍完整展示这些信息，需要常驻查看时打开侧栏即可。
 */

/**
 * @typedef {Object} StatusModel
 * @property {import("./patchGuard").PatchStatus} patch
 * @property {"ok" | "missing" | "invalid" | "error"} configStatus
 * @property {{ host: string, port: number, type: string } | null} proxy
 * @property {import("./proxyProbe").ProbeResult | null} reach
 * @property {boolean} pendingRestart
 * @property {boolean} [probing] 是否正在执行连通性探测（用于触发状态栏旋转动效）
 * @property {string[]} [missingTargets] 配置缺少的 IDE 后端目标进程（如 agy.exe）
 * @property {any} [egress] IpInfoService.state
 * @property {any} [gemini] { checking: boolean, result: any }
 * @property {any} [update] ExtensionUpdater.state
 * @property {string} [version] 插件版本
 */

/** @typedef {(key: string, params?: Record<string, any>) => string} Translate */

/** 本地时间 HH:mm:ss（悬浮卡片里的"上次检测"用） */
function clock(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

class ProxyStatusBar {
  /**
   * @param {typeof import("vscode")} vscode
   * @param {Translate} t
   * @param {import("vscode").Uri} [iconUri] 插件彩色图标 URI（用于悬浮卡片头部徽章展示）
   */
  constructor(vscode, t, iconUri) {
    this.vscode = vscode;
    this.t = t;
    this.iconUri = iconUri;
    this.item = vscode.window.createStatusBarItem("antigravityProxy.status", vscode.StatusBarAlignment.Right, 100);
    this.item.name = "Antigravity Proxy";
    this.item.command = "antigravityProxy.openSettings";
  }

  /** @param {StatusModel} m */
  render(m) {
    const { ThemeColor, MarkdownString } = this.vscode;
    const t = this.t;
    const port = m.proxy ? m.proxy.port : 0;
    const missingTargets = m.missingTargets || [];
    /** @type {{ icon: string, text: string, bg?: string, fg?: string, summary: string }} */
    let view;
    if (!m.patch.dllExists) {
      view = { icon: "error", text: t("sb.patchMissing"), bg: "statusBarItem.errorBackground", summary: t("sb.patchMissingSummary") };
    } else if (m.configStatus !== "ok") {
      view = { icon: "warning", text: t("sb.configBad"), bg: "statusBarItem.warningBackground", summary: t(m.configStatus === "missing" ? "sb.configMissingSummary" : "sb.configInvalidSummary") };
    } else if (missingTargets.length > 0) {
      // 缺少后端进程时代理对 IDE 后端无效，优先级高于“待重启”；只做状态栏轻提示，补齐入口在悬浮提示里
      const names = missingTargets.join(", ");
      view = { icon: "warning", text: t("sb.targetsMissing", { names }), bg: "statusBarItem.warningBackground", summary: t("sb.targetsMissingSummary", { names }) };
    } else if (m.pendingRestart || m.patch.needsRestart) {
      // 待重启生效：启用 sync~spin 旋转动效温和提醒用户重启 IDE
      view = { icon: "sync~spin", text: t("sb.pending"), bg: "statusBarItem.warningBackground", summary: t("sb.pendingSummary") };
    } else if (port === 0) {
      view = { icon: "circle-slash", text: t("sb.disabled"), summary: t("sb.disabledSummary") };
    } else if (m.probing) {
      view = { icon: "sync~spin", text: t("sb.probing", { port }), summary: t("sb.probingSummary") };
    } else if (m.reach && !m.reach.ok) {
      view = { icon: "debug-disconnect", text: t("sb.unreachable", { port }), bg: "statusBarItem.warningBackground", summary: m.reach.message };
    } else {
      const hasMs = m.reach && m.reach.ok && Number(m.reach.latencyMs) > 0;
      const text = hasMs ? t("sb.okLatency", { port, ms: m.reach.latencyMs }) : t("sb.ok", { port });
      view = { icon: "agp-shield", text, summary: t("sb.okSummary") };
    }

    this.item.text = `$(${view.icon}) ${view.text}`;
    this.item.backgroundColor = view.bg ? new ThemeColor(view.bg) : undefined;
    this.item.color = view.fg ? new ThemeColor(view.fg) : undefined;
    this.item.accessibilityInformation = {
      label: t("sb.a11y", { text: view.text, summary: view.summary }),
      role: "button",
    };

    const md = new MarkdownString(undefined, true);
    md.isTrusted = {
      enabledCommands: [
        "antigravityProxy.openSettings",
        "antigravityProxy.scanProxy",
        "antigravityProxy.testProxy",
        "antigravityProxy.repairPatch",
        "antigravityProxy.restartIde",
        "antigravityProxy.fixTargets",
        "antigravityProxy.openLogs",
        "antigravityProxy.focusSidebar",
        "antigravityProxy.checkGemini",
        "antigravityProxy.refreshIp",
        "antigravityProxy.checkUpdate",
      ],
    };
    const badge = this.iconUri ? `![](${this.iconUri.toString()}|width=16,height=16) ` : "$(agp-shield) ";
    md.appendMarkdown(`${badge}**Antigravity Proxy** — ${escapeMd(view.summary)}\n\n`);
    md.appendMarkdown("| | |\n|:--|:--|\n");
    md.appendMarkdown(`| ${t("sb.rowPatch")} | ${patchText(m.patch, t)} |\n`);
    md.appendMarkdown(`| ${t("sb.rowConfig")} | ${configText(m.configStatus, t)} |\n`);
    if (m.proxy) md.appendMarkdown(`| ${t("sb.rowProxy")} | \`${m.proxy.type}://${m.proxy.host}:${m.proxy.port}\` |\n`);
    if (m.probing) {
      md.appendMarkdown(`| ${t("sb.rowReach")} | $(sync~spin) ${escapeMd(t("sb.probingSummary"))} |\n`);
    } else if (m.reach) {
      const okStr = Number(m.reach.latencyMs) > 0
        ? t("sb.reachOkLatency", { ms: m.reach.latencyMs })
        : t("sb.reachOk");
      md.appendMarkdown(`| ${t("sb.rowReach")} | ${m.reach.ok ? `$(pass-filled) ${okStr}` : "$(warning) " + escapeMd(m.reach.message)} |\n`);
    }

    // ---- 以下三项只在悬浮卡片里展示，不再单独占状态栏位置 ----
    const egress = m.egress;
    if (egress && egress.status === "ok" && egress.data) {
      const via = egress.via === "proxy" ? t("side2.ipViaProxy") : t("side2.ipViaDirect");
      const time = clock(egress.checkedAt);
      md.appendMarkdown(`| ${t("side2.ipTitle")} | \`${escapeMd(egress.data.ip || "")}\` ${escapeMd([egress.data.asn, egress.data.orgName].filter(Boolean).join(" "))}${time ? ` · ${escapeMd(t("side2.geminiLastChecked", { time }))}` : ""} · ${via} |\n`);
    }
    const gem = m.gemini;
    if (gem && gem.checking) {
      md.appendMarkdown(`| ${t("side2.geminiTitle")} | $(sync~spin) ${escapeMd(t("side2.geminiChecking"))} |\n`);
    } else if (gem && gem.result) {
      const time = clock(gem.result.checkedAt);
      md.appendMarkdown(`| ${t("side2.geminiTitle")} | ${geminiIcon(gem.result.state)} ${escapeMd(geminiText(gem.result.state, t))}${time ? ` · ${escapeMd(t("side2.geminiLastChecked", { time }))}` : ""} |\n`);
    }
    if (m.update && m.update.status === "available") {
      md.appendMarkdown(`| ${t("sb.rowUpdate")} | $(cloud-download) ${escapeMd(t("sb.updateAvailable", { latest: m.update.latestTag }))} |\n`);
    }

    md.appendMarkdown(`\n[$(settings-gear) ${t("sb.linkSettings")}](command:antigravityProxy.openSettings)`);
    md.appendMarkdown(` · [$(search) ${t("sb.linkScan")}](command:antigravityProxy.scanProxy)`);
    md.appendMarkdown(` · [$(plug) ${t("sb.linkTest")}](command:antigravityProxy.testProxy)`);
    md.appendMarkdown(` · [$(folder-opened) ${t("sb.linkLogs")}](command:antigravityProxy.openLogs)`);
    md.appendMarkdown(` · [$(window) ${t("sb.linkSidebar")}](command:antigravityProxy.focusSidebar)`);
    if (!m.patch.dllExists) md.appendMarkdown(` · [$(cloud-download) ${t("sb.linkRepair")}](command:antigravityProxy.repairPatch)`);
    if (missingTargets.length > 0) md.appendMarkdown(` · [$(wrench) ${t("sb.linkFixTargets")}](command:antigravityProxy.fixTargets)`);
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

/** @param {string} state @param {Translate} t */
function geminiText(state, t) {
  return {
    ok: t("sb.geminiOk"),
    blocked: t("sb.geminiBlocked"),
    inconclusive: t("sb.geminiInconclusive"),
    error: t("sb.geminiError"),
    "proxy-error": t("sb.geminiProxyError"),
  }[/** @type {any} */ (state)] || state;
}

/** @param {string} state */
function geminiIcon(state) {
  return { ok: "$(pass-filled)", blocked: "$(warning)", inconclusive: "$(question)", error: "$(error)", "proxy-error": "$(warning)" }[/** @type {any} */ (state)] || "$(question)";
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
