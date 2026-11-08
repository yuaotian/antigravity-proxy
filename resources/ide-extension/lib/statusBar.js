// @ts-check
"use strict";

/**
 * 底部状态栏（单一职责：把状态模型渲染为状态栏文本/配色/动效/悬浮提示；不做任何 IO）。
 *
 * 三个条目（从右到左）：
 * 1) 主状态（priority 100）：补丁/配置/代理/连通，按"影响程度"只展示最需要处理的一项；
 * 2) 出口 IP（priority 99）：ipinfo 查到的代理出口 IP + 运营商（需求 3）；
 * 3) Gemini（priority 98）：Gemini/Antigravity 可用性结论（需求 4 的状态栏联动）。
 *
 * 主状态优先级不变；新增两项可分别用 antigravityProxy.statusBar.showEgress / showGemini 关闭，
 * 避免小屏幕状态栏过挤。
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

    this.egressItem = vscode.window.createStatusBarItem("antigravityProxy.egress", vscode.StatusBarAlignment.Right, 99);
    this.egressItem.name = "Antigravity Proxy · Egress IP";
    this.egressItem.command = "antigravityProxy.focusSidebar";

    this.geminiItem = vscode.window.createStatusBarItem("antigravityProxy.gemini", vscode.StatusBarAlignment.Right, 98);
    this.geminiItem.name = "Antigravity Proxy · Gemini";
    this.geminiItem.command = "antigravityProxy.checkGemini";
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
    const egress = m.egress;
    if (egress && egress.status === "ok" && egress.data) {
      md.appendMarkdown(`| ${t("sb.rowEgress")} | \`${escapeMd(egress.data.ip)}\` ${escapeMd([egress.data.asn, egress.data.orgName].filter(Boolean).join(" "))} |\n`);
    }
    const gem = m.gemini;
    if (gem && gem.result) {
      md.appendMarkdown(`| ${t("sb.rowGemini")} | ${geminiIcon(gem.result.state)} ${escapeMd(geminiText(gem.result.state, t))} |\n`);
    }
    if (m.update && m.update.status === "available") {
      md.appendMarkdown(`| ${t("sb.rowUpdate")} | $(cloud-download) ${escapeMd(t("sb.updateAvailable", { latest: m.update.latestTag }))} |\n`);
    }
    md.appendMarkdown(`\n[$(settings-gear) ${t("sb.linkSettings")}](command:antigravityProxy.openSettings)`);
    md.appendMarkdown(` · [$(search) ${t("sb.linkScan")}](command:antigravityProxy.scanProxy)`);
    md.appendMarkdown(` · [$(plug) ${t("sb.linkTest")}](command:antigravityProxy.testProxy)`);
    md.appendMarkdown(` · [$(folder-opened) ${t("sb.linkLogs")}](command:antigravityProxy.openLogs)`);
    if (egress && egress.status === "ok") md.appendMarkdown(` · [$(globe) ${t("sb.linkSidebar")}](command:antigravityProxy.focusSidebar)`);
    if (!m.patch.dllExists) md.appendMarkdown(` · [$(cloud-download) ${t("sb.linkRepair")}](command:antigravityProxy.repairPatch)`);
    if (missingTargets.length > 0) md.appendMarkdown(` · [$(wrench) ${t("sb.linkFixTargets")}](command:antigravityProxy.fixTargets)`);
    if (m.pendingRestart || m.patch.needsRestart) md.appendMarkdown(` · [$(debug-restart) ${t("sb.linkRestart")}](command:antigravityProxy.restartIde)`);
    this.item.tooltip = md;
    this.item.show();

    this.renderEgress(m);
    this.renderGemini(m);
  }

  /** @param {StatusModel} m */
  renderEgress(m) {
    const { ThemeColor, MarkdownString } = this.vscode;
    const t = this.t;
    const cfg = this.vscode.workspace.getConfiguration("antigravityProxy");
    const enabled = cfg.get("statusBar.showEgress", true) !== false;
    const state = m.egress;
    if (!enabled || !state || (state.status !== "ok" && state.status !== "loading")) {
      this.egressItem.hide();
      return;
    }
    if (state.status === "loading") {
      this.egressItem.text = `$(globe~spin) ${t("side2.ipLoading")}`;
      this.egressItem.tooltip = t("side2.ipLoading");
      this.egressItem.backgroundColor = undefined;
      this.egressItem.show();
      return;
    }
    const data = state.data || {};
    const shortOrg = String(data.orgName || "").split(/\s+/)[0] || "";
    this.egressItem.text = `$(globe) ${data.ip || "—"}${shortOrg ? ` · ${shortOrg}` : ""}`;
    this.egressItem.backgroundColor = data.datacenter ? new ThemeColor("statusBarItem.warningBackground") : undefined;
    this.egressItem.accessibilityInformation = {
      label: t("sb.egressA11y", { ip: data.ip || "", org: [data.asn, data.orgName].filter(Boolean).join(" ") || "" }),
      role: "button",
    };
    const md = new MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: ["antigravityProxy.focusSidebar", "antigravityProxy.refreshIp", "antigravityProxy.checkGemini"] };
    md.appendMarkdown(`**${t("side2.ipTitle")}**\n\n| | |\n|:--|:--|\n`);
    md.appendMarkdown(`| ${t("side2.ipAddress")} | \`${escapeMd(data.ip || "")}\` |\n`);
    md.appendMarkdown(`| ${t("side2.ipIsp")} | ${escapeMd([data.asn, data.orgName].filter(Boolean).join(" ") || t("side2.ipUnknown"))} |\n`);
    md.appendMarkdown(`| ${t("side2.ipLocation")} | ${escapeMd([data.city, data.region, data.country].filter(Boolean).join(" · "))} |\n`);
    md.appendMarkdown(`| ${t("side2.ipSource")} | ${state.via === "proxy" ? t("side2.ipViaProxy") : t("side2.ipViaDirect")} |\n`);
    if (data.datacenter) md.appendMarkdown(`\n$(warning) ${t("side2.ipDatacenterHint")}\n`);
    md.appendMarkdown(`\n[$(refresh) ${t("side2.ipRefresh")}](command:antigravityProxy.refreshIp) · [$(beaker) ${t("sb.linkGemini")}](command:antigravityProxy.checkGemini) · [$(window) ${t("sb.linkSidebar")}](command:antigravityProxy.focusSidebar)`);
    this.egressItem.tooltip = md;
    this.egressItem.show();
  }

  /** @param {StatusModel} m */
  renderGemini(m) {
    const { ThemeColor, MarkdownString } = this.vscode;
    const t = this.t;
    const cfg = this.vscode.workspace.getConfiguration("antigravityProxy");
    const enabled = cfg.get("statusBar.showGemini", true) !== false;
    const gem = m.gemini;
    if (!enabled || !gem || (!gem.result && !gem.checking)) {
      this.geminiItem.hide();
      return;
    }
    if (gem.checking) {
      this.geminiItem.text = `$(sync~spin) ${t("sb.geminiChecking")}`;
      this.geminiItem.backgroundColor = undefined;
      this.geminiItem.tooltip = t("side2.geminiChecking");
      this.geminiItem.show();
      return;
    }
    const result = gem.result;
    const kind = result.state;
    /** @type {Record<string, { icon: string, text: string, bg?: string }>} */
    const map = {
      ok: { icon: "pass-filled", text: t("sb.geminiOk") },
      blocked: { icon: "warning", text: t("sb.geminiBlocked"), bg: "statusBarItem.warningBackground" },
      inconclusive: { icon: "question", text: t("sb.geminiInconclusive") },
      error: { icon: "error", text: t("sb.geminiError"), bg: "statusBarItem.warningBackground" },
      "proxy-error": { icon: "warning", text: t("sb.geminiProxyError"), bg: "statusBarItem.warningBackground" },
    };
    const view = map[kind] || map.inconclusive;
    this.geminiItem.text = `$(${view.icon}) ${view.text}`;
    this.geminiItem.backgroundColor = view.bg ? new ThemeColor(view.bg) : undefined;
    this.geminiItem.accessibilityInformation = { label: `${t("side2.geminiTitle")}: ${view.text}`, role: "button" };
    const md = new MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: ["antigravityProxy.checkGemini", "antigravityProxy.focusSidebar"] };
    md.appendMarkdown(`**${t("side2.geminiTitle")}** — ${view.text}\n\n| | |\n|:--|:--|\n`);
    md.appendMarkdown(`| ${t("side2.geminiNetwork")} | ${result.network && result.network.ok ? "$(pass-filled) " + escapeMd(String(result.network.status)) : "$(error) " + escapeMd((result.network && result.network.error) || "")} |\n`);
    md.appendMarkdown(`| ${t("side2.geminiApi")} | ${geminiIcon(result.geminiApi && result.geminiApi.state)} ${escapeMd(geminiLayerText(result.geminiApi && result.geminiApi.state, t))} |\n`);
    md.appendMarkdown(`| ${t("side2.geminiAntigravity")} | ${geminiIcon(result.antigravity && result.antigravity.state)} ${escapeMd(geminiLayerText(result.antigravity && result.antigravity.state, t))} |\n`);
    if (result.logEvidence && result.logEvidence.matched) md.appendMarkdown(`\n$(warning) ${escapeMd(t("side2.geminiLogMatched", { time: "" }))}\n`);
    md.appendMarkdown(`\n[$(beaker) ${t("side2.geminiCheck")}](command:antigravityProxy.checkGemini) · [$(window) ${t("sb.linkSidebar")}](command:antigravityProxy.focusSidebar)`);
    this.geminiItem.tooltip = md;
    this.geminiItem.show();
  }

  hide() {
    this.item.hide();
    this.egressItem.hide();
    this.geminiItem.hide();
  }

  dispose() {
    this.item.dispose();
    this.egressItem.dispose();
    this.geminiItem.dispose();
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

/** @param {string} state @param {Translate} t */
function geminiLayerText(state, t) {
  return {
    ok: t("side2.geminiLayerOk"),
    blocked: t("side2.geminiLayerBlocked"),
    inconclusive: t("side2.geminiLayerUnknown"),
    error: t("side2.geminiLayerError"),
  }[/** @type {any} */ (state)] || t("side2.geminiLayerUnknown");
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
