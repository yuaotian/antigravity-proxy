// @ts-check
/* global acquireVsCodeApi */
/**
 * Antigravity Proxy 配置面板（Webview 前端）
 *
 * 结构：Schema 驱动渲染 → 编辑时增量更新（校验/修改标记/保存态），不整页重绘以保持焦点；
 * 纯逻辑（默认值/规范化/导出/校验）全部来自共享模块 AGPConfigCore，与独立配置页一致；
 * 界面文案来自共享词条 AGPI18n（简体中文 / English / Русский），语言由宿主下发。
 * 状态：loading（骨架屏）→ ready | empty（无配置文件）| error（读取/解析失败）。
 */
(function () {
  "use strict";

  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  /** @type {any} */
  const Core = /** @type {any} */ (window).AGPConfigCore;
  /** @type {any} */
  const I18n = /** @type {any} */ (window).AGPI18n;
  const app = /** @type {HTMLElement} */ (document.getElementById("app"));
  const ICON_SRC = app.dataset.icon || "";

  // 当前界面语言与翻译函数（首帧取 data-lang，之后以宿主 init/lang 消息为准）
  let LANG = app.dataset.lang || "zh-cn";
  /** @type {(key: string, params?: Record<string, any>) => string} */
  let T = I18n ? I18n.createT(LANG) : (k) => k;
  /** @param {string} lang */
  const setLang = (lang) => {
    if (!lang || !I18n) return;
    LANG = lang;
    T = I18n.createT(lang);
    document.documentElement.lang = I18n.HTML_LANG[lang] || "en";
    SECTIONS = buildSections();
  };

  // ============================================================
  // 工具
  // ============================================================
  /**
   * 轻量元素构造：h("div", { class, on: { click }, attrs }, ...children)
   * @param {string} tag @param {Record<string, any>} [props] @param {...any} children
   * @returns {HTMLElement}
   */
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k === "value") /** @type {any} */ (el).value = v;
      else if (k === "checked") /** @type {any} */ (el).checked = v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  /** @param {string} name @param {string} [extra] */
  const icon = (name, extra = "") => h("i", { class: `codicon codicon-${name} ${extra}`.trim(), "aria-hidden": "true" });
  const stable = (/** @type {any} */ v) => JSON.stringify(v);
  const clone = (/** @type {any} */ v) => Core.deepClone(v);
  /** @param {Function} fn @param {number} ms */
  const debounce = (fn, ms) => {
    /** @type {any} */ let t;
    return (/** @type {any[]} */ ...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };
  const post = (/** @type {any} */ msg) => vscode.postMessage(msg);

  // ============================================================
  // Schema：分区与设置项（标题/说明/控件类型），驱动渲染与错误定位；随语言重建
  // ============================================================
  /** 下拉选项：值保持配置原文，说明随语言翻译 */
  const opt = (/** @type {string} */ v, /** @type {string} */ key) => ({ v, label: `${v} — ${T(key)}` });
  const buildSections = () => [
    {
      id: "proxy", title: T("sec.proxy"), icon: "globe",
      rows: [
        { path: "proxy.type", title: T("row.proxyType"), kind: "segmented", options: [{ v: "socks5", label: "SOCKS5" }, { v: "http", label: "HTTP" }], desc: T("row.proxyTypeDesc") },
        { path: "proxy.host", title: T("row.proxyHost"), kind: "text", width: "w-m", placeholder: "127.0.0.1", desc: T("row.proxyHostDesc") },
        { path: "proxy.port", title: T("row.proxyPort"), kind: "port", desc: T("row.proxyPortDesc"), presets: [[7890, "Clash"], [7897, "Clash Verge"], [10808, "v2rayN"], [1080, "SOCKS"]] },
        { id: "proxy.auth", title: T("row.proxyAuth"), kind: "group", desc: T("row.proxyAuthDesc"), fields: [
          { path: "proxy.username", label: T("row.username"), kind: "text", width: "w-s", placeholder: T("common.optional") },
          { path: "proxy.password", label: T("row.password"), kind: "password", width: "w-s", placeholder: T("common.optional") },
        ] },
        { id: "probe", title: T("row.probe"), kind: "probe", desc: T("row.probeDesc") },
        { id: "scan", title: T("row.scan"), kind: "scan", desc: T("row.scanDesc") },
      ],
    },
    {
      id: "network", title: T("sec.network"), icon: "shield",
      rows: [
        { path: "proxy_rules.allowed_ports", title: T("row.allowedPorts"), kind: "tags", itemKind: "port", placeholder: T("row.allowedPortsPh"), desc: T("row.allowedPortsDesc") },
        { path: "proxy_rules.dns_mode", title: T("row.dnsMode"), kind: "select", options: [opt("direct", "opt.localResolve"), opt("proxy", "opt.proxyResolve")], desc: T("row.dnsModeDesc") },
        { path: "proxy_rules.ipv6_mode", title: T("row.ipv6Mode"), kind: "select", options: [opt("proxy", "opt.viaProxy"), opt("direct", "opt.direct"), opt("block", "opt.block")], desc: T("row.ipv6ModeDesc") },
        { path: "proxy_rules.udp_mode", title: T("row.udpMode"), kind: "select", options: [opt("auto", "opt.udpAuto"), opt("proxy", "opt.udpProxy"), opt("direct", "opt.direct"), opt("block", "opt.udpBlock")], desc: T("row.udpModeDesc") },
        { path: "proxy_rules.udp_fallback", title: T("row.udpFallback"), kind: "select", options: [opt("block", "opt.block"), opt("direct", "opt.direct")], desc: T("row.udpFallbackDesc") },
        { path: "fake_ip.enabled", title: T("row.fakeIp"), kind: "check", label: T("row.fakeIpLabel"), desc: T("row.fakeIpDesc") },
        { path: "fake_ip.cidr", title: T("row.fakeIpCidr"), kind: "text", width: "w-m", placeholder: "198.18.0.0/15", desc: T("row.fakeIpCidrDesc") },
      ],
    },
    {
      id: "routing", title: T("sec.routing"), icon: "list-tree",
      rows: [
        { path: "proxy_rules.routing.enabled", title: T("row.routing"), kind: "check", label: T("row.routingLabel"), desc: T("row.routingDesc") },
        { path: "proxy_rules.routing.default_action", title: T("row.defaultAction"), kind: "select", options: [opt("proxy", "opt.viaProxy"), opt("direct", "opt.direct")], desc: T("row.defaultActionDesc") },
        { path: "proxy_rules.routing.priority_mode", title: T("row.priorityMode"), kind: "select", options: [opt("order", "opt.orderList"), opt("number", "opt.orderNumber")], desc: T("row.priorityModeDesc") },
        { path: "proxy_rules.routing.use_default_private", title: T("row.privateDirect"), kind: "check", label: T("row.privateDirectLabel"), desc: T("row.privateDirectDesc") },
        { path: "proxy_rules.routing.rules", title: T("row.rules"), kind: "rules", desc: T("row.rulesDesc") },
      ],
    },
    {
      id: "injection", title: T("sec.injection"), icon: "symbol-event",
      rows: [
        { path: "child_injection", title: T("row.childInjection"), kind: "check", label: T("row.childInjectionLabel"), desc: T("row.childInjectionDesc") },
        { path: "child_injection_mode", title: T("row.injectionMode"), kind: "select", options: [opt("filtered", "opt.injectFiltered"), opt("inherit", "opt.injectInherit")], desc: T("row.injectionModeDesc") },
        { path: "target_processes", title: T("row.targetProcesses"), kind: "tags", itemKind: "text", placeholder: T("row.targetProcessesPh"), desc: T("row.targetProcessesDesc") },
        { path: "child_injection_exclude", title: T("row.excludeProcesses"), kind: "tags", itemKind: "text", placeholder: T("row.excludeProcessesPh"), desc: T("row.excludeProcessesDesc") },
      ],
    },
    {
      id: "advanced", title: T("sec.advanced"), icon: "tools",
      rows: [
        { path: "log_level", title: T("row.logLevel"), kind: "select", options: [opt("debug", "opt.logDebug"), opt("info", "opt.logInfo"), opt("warn", "opt.logWarn"), opt("error", "opt.logError")], desc: T("row.logLevelDesc") },
        { id: "timeout", title: T("row.timeout"), kind: "group", desc: T("row.timeoutDesc"), fields: [
          { path: "timeout.connect", label: T("row.timeoutConnect"), kind: "number", width: "w-s" },
          { path: "timeout.send", label: T("row.timeoutSend"), kind: "number", width: "w-s" },
          { path: "timeout.recv", label: T("row.timeoutRecv"), kind: "number", width: "w-s" },
        ] },
        { path: "traffic_logging", title: T("row.trafficLogging"), kind: "check", label: T("row.trafficLoggingLabel"), desc: T("row.trafficLoggingDesc") },
        { path: "diagnostics.agent_ip_probe", title: T("row.ipProbe"), kind: "check", label: T("row.ipProbeLabel"), desc: T("row.ipProbeDesc") },
        { path: "updates.enabled", title: T("row.updates"), kind: "check", label: T("row.updatesLabel"), desc: T("row.updatesDesc") },
        { id: "updates.timing", title: T("row.updatesTiming"), kind: "group", desc: T("row.updatesTimingDesc"), fields: [
          { path: "updates.check_delay_ms", label: T("row.updatesDelay"), kind: "number", width: "w-s" },
          { path: "updates.timeout_ms", label: T("row.updatesTimeout"), kind: "number", width: "w-s" },
        ] },
        { id: "updates.flags", title: T("row.updatesFlags"), kind: "group", desc: "", fields: [
          { path: "updates.notify_once", label: T("row.notifyOnce"), kind: "check" },
          { path: "updates.allow_insecure_mirrors", label: T("row.insecureMirrors"), kind: "check" },
        ] },
        { path: "updates.mirrors", title: T("row.mirrors"), kind: "tags", itemKind: "text", placeholder: "https://…", desc: T("row.mirrorsDesc") },
      ],
    },
  ];
  let SECTIONS = buildSections();

  // 路径 → 行 id（错误/修改标记定位用；路径与语言无关，构建一次即可）
  /** @type {Map<string, string>} */
  const ROW_OF_PATH = new Map();
  for (const s of SECTIONS) {
    for (const r of /** @type {any[]} */ (s.rows)) {
      const rowId = r.id || r.path;
      if (r.path) ROW_OF_PATH.set(r.path, rowId);
      for (const f of r.fields || []) ROW_OF_PATH.set(f.path, rowId);
    }
  }
  /** @param {string} errPath */
  const rowIdOf = (errPath) => {
    if (errPath.startsWith("proxy_rules.routing.rules")) return "proxy_rules.routing.rules";
    const base = errPath.replace(/\[\d+\].*$/, "");
    return ROW_OF_PATH.get(base) || "";
  };
  /** @param {string} rowId */
  const sectionOfRow = (rowId) => SECTIONS.find((s) => s.rows.some((/** @type {any} */ r) => (r.id || r.path) === rowId))?.id;

  // ============================================================
  // 状态
  // ============================================================
  const persisted = vscode.getState() || {};
  const S = {
    phase: "loading",
    /** @type {any} */ meta: null,
    readStatus: "",
    readError: "",
    /** @type {any} */ baseRaw: {},
    /** @type {any} */ saved: null,
    /** @type {any} */ form: null,
    /** @type {Record<string, string>} */ errors: {},
    /** @type {Record<string, string>} */ warnings: {},
    /** @type {{ status: string, result?: any }} */ probe: { status: "idle" },
    /** @type {{ status: "idle" | "running" | "done", result?: any, applied?: boolean }} */ scan: { status: "idle" },
    onboarding: false,
    attention: false,
    saving: false,
    drawer: !!persisted.drawer,
    drawerMode: persisted.drawerMode || "changes",
    showSecret: false,
    /** @type {Set<string>} */ expandedRules: new Set(),
    activeSection: "proxy",
    /** @type {null | { kind: string, key: string, params?: Record<string, any> }} */ banner: null,
  };
  const persist = () => vscode.setState({ drawer: S.drawer, drawerMode: S.drawerMode });

  /** 当前表单导出对象（写入 config.json 的最终内容） */
  const exportCurrent = () => Core.exportObject(S.form, S.baseRaw, S.form?._version);
  const exportSaved = () => Core.exportObject(S.saved, S.baseRaw, S.saved?._version);
  const isDirty = () => S.saved && stable(exportCurrent()) !== stable(exportSaved());
  const errorCount = () => Object.keys(S.errors).length;

  // DOM 引用（ready 阶段创建）
  /** @type {Record<string, any>} */
  const R = { rows: new Map() };

  // ============================================================
  // 消息
  // ============================================================
  window.addEventListener("message", (e) => {
    const m = e.data || {};
    switch (m.type) {
      case "init": return onInit(m);
      case "lang":
        setLang(m.lang);
        render();
        // 连通测试结果由宿主按旧语言生成，切换语言后重新测试一次以统一语言
        if (S.phase === "ready" && S.probe.status !== "idle" && S.form.proxy.port > 0) runProbe();
        return;
      case "meta": S.meta = m.meta; return renderStatusband();
      case "saved": return onSaved(m);
      case "probeResult": S.probe = { status: m.result.ok ? "ok" : "fail", result: m.result }; renderProbe(); renderStatusband(); return;
      case "scanResult": return onScanResult(m.result);
      case "imported": return onImported(m.raw);
      case "toast": return toast(m.kind, m.text);
      default: return;
    }
  });

  /** @param {any} m */
  function onInit(m) {
    setLang(m.lang);
    S.meta = m.meta;
    S.readStatus = m.read.status;
    S.readError = m.read.error || "";
    if (m.read.status === "ok") {
      S.baseRaw = m.read.raw;
      S.saved = Core.normalizeForm(m.read.raw, m.read.raw?._version);
      S.form = clone(S.saved);
      S.phase = "ready";
      S.banner = null;
    } else {
      S.phase = m.read.status === "missing" ? "empty" : "error";
    }
    // 首次引导 / 扫描命令：显示引导说明并自动扫描本机代理
    const wantScan = S.phase === "ready" && (m.intent === "onboarding" || m.intent === "scan");
    if (wantScan) {
      S.onboarding = m.intent === "onboarding";
      S.attention = S.onboarding;
      S.activeSection = "proxy";
    }
    render();
    if (S.phase === "ready" && S.form.proxy.port > 0 && S.probe.status === "idle") runProbe();
    if (wantScan) {
      scrollToSection("proxy");
      runScan();
    }
  }

  /** @param {any} m */
  function onSaved(m) {
    S.saving = false;
    if (m.ok) {
      S.baseRaw = exportCurrent();
      S.saved = clone(S.form);
      if (m.meta) S.meta = m.meta;
      S.banner = { kind: "info", key: "ui.savedBanner" };
      // 保存成功即完成引导：撤下引导说明与高亮
      S.onboarding = false;
      setAttention(false);
      R.btnSave?.classList.remove("attention");
      R.onboard?.remove();
    } else {
      S.banner = { kind: "error", key: "ui.saveFailed", params: { error: m.error } };
    }
    refreshAll();
    renderStatusband();
    renderBanner();
  }

  /** @param {any} raw */
  function onImported(raw) {
    if (S.phase !== "ready") {
      S.baseRaw = {};
      S.saved = Core.normalizeForm({});
    }
    S.form = Core.normalizeForm(raw, raw?._version);
    S.phase = "ready";
    render();
    toast("info", T("ui.imported"));
  }

  // ============================================================
  // 渲染：外壳
  // ============================================================
  function render() {
    app.dataset.phase = S.phase;
    app.replaceChildren();
    R.rows = new Map();
    if (S.phase === "loading") return app.append(renderSkeleton());
    if (S.phase === "empty") return app.append(renderTopbar(false), renderEmpty());
    if (S.phase === "error") return app.append(renderTopbar(false), renderError());
    app.append(renderTopbar(true), renderStatusbandEl(), renderBody(), renderBannerEl(), h("div", { class: "toasts", role: "status", "aria-live": "polite", id: "toasts" }));
    refreshAll();
    renderStatusband();
    renderBanner();
    setupScrollSpy();
  }

  function renderSkeleton() {
    // 不使用 style 属性：Webview CSP（style-src 仅允许插件资源）会拦截内联样式
    const row = () => h("div", { class: "sk-row" }, h("div", { class: "sk short" }), h("div", { class: "sk line" }), h("div", { class: "sk input" }));
    return h("div", { class: "skeleton", "aria-busy": "true", "aria-label": T("ui.loading") },
      h("div", { class: "sk title" }), row(), row(), row(), row());
  }

  /** @param {boolean} ready */
  function renderTopbar(ready) {
    const brand = h("div", { class: "brand" },
      ICON_SRC ? h("img", { src: ICON_SRC, alt: "" }) : null,
      h("div", { class: "brand-text" },
        h("h1", { text: "Antigravity Proxy" }),
        h("span", { class: "path mono", title: S.meta?.configPath || "", text: S.meta?.configPath || "" })));
    if (!ready) return h("header", { class: "topbar" }, brand, h("div", { class: "actions" }, renderMenu(false)));

    R.dirty = h("span", { class: "dirty-badge", hidden: true }, h("span", { class: "dot" }), T("ui.unsaved"));
    R.errCount = h("button", { class: "error-count", hidden: true, on: { click: jumpToFirstError } });
    R.btnRevert = h("button", { class: "btn secondary", on: { click: revert }, title: T("ui.revertTitle") }, icon("discard"), T("ui.revert"));
    R.btnSave = h("button", { class: "btn primary", on: { click: save }, title: T("ui.saveTitle") }, icon("save"), T("ui.save"));
    R.btnJson = h("button", { class: "icon-btn", "aria-pressed": String(S.drawer), title: T("ui.jsonTitle"), "aria-label": T("ui.jsonAria"), on: { click: toggleDrawer } }, icon("json"));
    return h("header", { class: "topbar" }, brand,
      h("div", { class: "actions" }, R.errCount, R.dirty, R.btnRevert, R.btnSave, R.btnJson, renderMenu(true)));
  }

  /** @param {boolean} ready */
  function renderMenu(ready) {
    const items = [
      ["go-to-file", T("ui.menuOpenConfig"), () => post({ type: "openConfigFile" })],
      ["folder-opened", T("ui.menuOpenLogs"), () => post({ type: "openLogs" })],
      null,
      ["cloud-download", T("ui.menuImport"), () => post({ type: "import" })],
      ready ? ["file-add", T("ui.menuExport"), () => post({ type: "export", raw: exportCurrent() })] : undefined,
      ready ? ["history", T("ui.menuDefaults"), resetDefaults] : undefined,
      null,
      ["refresh", T("ui.menuReload"), () => post({ type: "reload" })],
    ].filter((x) => x !== undefined);
    const menu = h("div", { class: "menu", role: "menu", hidden: true });
    const btn = h("button", { class: "icon-btn", "aria-haspopup": "menu", "aria-expanded": "false", "aria-label": T("ui.menuMore"), title: T("ui.menuMore") }, icon("ellipsis"));
    const close = () => { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); };
    for (const it of items) {
      if (!it) { menu.append(h("hr")); continue; }
      const [ic, label, fn] = /** @type {[string, string, Function]} */ (it);
      menu.append(h("button", { role: "menuitem", on: { click: () => { close(); fn(); } } }, icon(ic), label));
    }
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = menu.hidden;
      menu.hidden = !open;
      btn.setAttribute("aria-expanded", String(open));
      if (open) /** @type {HTMLElement | null} */ (menu.querySelector("button"))?.focus();
    });
    menu.addEventListener("keydown", (e) => {
      const list = /** @type {HTMLElement[]} */ ([...menu.querySelectorAll("button")]);
      const i = list.indexOf(/** @type {HTMLElement} */ (document.activeElement));
      if (e.key === "ArrowDown") { e.preventDefault(); list[(i + 1) % list.length].focus(); }
      if (e.key === "ArrowUp") { e.preventDefault(); list[(i - 1 + list.length) % list.length].focus(); }
      // 阻止冒泡：Esc 只关闭菜单，不连带关闭 JSON 抽屉
      if (e.key === "Escape") { e.stopPropagation(); close(); btn.focus(); }
    });
    // 全局点击关闭只注册一次（见底部），这里登记当前菜单，避免每次重绘累积监听器
    R.menuEl = menu;
    R.menuClose = close;
    return h("div", { class: "menu-wrap" }, btn, menu);
  }

  function renderEmpty() {
    return h("div", { class: "state-card", role: "region", "aria-label": T("ui.emptyAria") },
      icon("file-add", "big"),
      h("h2", { text: T("ui.emptyTitle") }),
      h("p", { class: "mono", text: S.meta?.configPath || "" }),
      h("p", { text: T("ui.emptyText") }),
      h("div", { class: "state-actions" },
        h("button", { class: "btn primary", on: { click: () => post({ type: "createDefault" }) } }, icon("add"), T("ui.createDefault")),
        h("button", { class: "btn secondary", on: { click: () => post({ type: "import" }) } }, icon("cloud-download"), T("ui.importFile"))));
  }

  function renderError() {
    const title = T(S.readStatus === "invalid" ? "ui.errorInvalid" : "ui.errorRead");
    return h("div", { class: "state-card error", role: "alert" },
      icon("error", "big"),
      h("h2", { text: title }),
      h("p", { text: S.readError }),
      h("p", { class: "mono", text: S.meta?.configPath || "" }),
      h("div", { class: "state-actions" },
        h("button", { class: "btn primary", on: { click: () => post({ type: "openConfigFile" }) } }, icon("go-to-file"), T("ui.fixInEditor")),
        h("button", { class: "btn secondary", on: { click: () => post({ type: "reload" }) } }, icon("refresh"), T("ui.reload")),
        h("button", { class: "btn secondary", on: { click: () => post({ type: "createDefault" }) }, title: T("ui.overwriteDefaultTitle") }, icon("history"), T("ui.overwriteDefault"))));
  }

  // ============================================================
  // 状态带：补丁 / 待重启 / 连通 / 配置
  // ============================================================
  function renderStatusbandEl() {
    R.band = h("section", { class: "statusband", "aria-label": T("ui.bandAria") });
    return R.band;
  }

  function renderStatusband() {
    if (!R.band || !S.meta) return;
    const chips = [];
    const p = S.meta.patch || {};
    if (!p.dllExists) {
      chips.push(chip("err", "error", T("ui.chipPatchMissing"), h("button", { class: "link-btn", on: { click: () => post({ type: "repair" }) } }, T("ui.repair"))));
    } else if (p.dllLoaded === true) {
      chips.push(chip("ok", "pass-filled", T("ui.chipPatchActive")));
    } else if (p.dllLoaded === false) {
      chips.push(chip("warn", "sync", T("ui.chipPatchPending")));
    } else {
      chips.push(chip("muted", "info", T("ui.chipPatchReady")));
    }
    if (S.meta.pendingRestart) {
      chips.push(chip("warn", "debug-restart", T("ui.chipPending"), h("button", { class: "link-btn", on: { click: () => post({ type: "restart" }) } }, T("common.restartNow"))));
    }
    if (S.form && S.form.proxy.port === 0) {
      chips.push(chip("muted", "circle-slash", T("ui.chipDisabled")));
    } else if (S.probe.status === "running") {
      chips.push(chip("muted", "loading", T("ui.chipTesting"), null, "codicon-modifier-spin"));
    } else if (S.probe.status === "ok") {
      chips.push(chip("ok", "pass-filled", T("ui.chipProxyOk", { ms: S.probe.result.latencyMs })));
    } else if (S.probe.status === "fail") {
      chips.push(chip("err", "debug-disconnect", T("ui.chipProxyFail"), h("button", { class: "link-btn", on: { click: () => scrollToRow("probe") } }, T("ui.details"))));
    }
    R.band.replaceChildren(...chips);
  }

  /**
   * @param {string} tone @param {string} ic @param {string} text @param {HTMLElement | null} [action] @param {string} [iconExtra]
   */
  function chip(tone, ic, text, action = null, iconExtra = "") {
    return h("span", { class: `chip ${tone}` }, icon(ic, iconExtra), h("span", { class: "chip-text", text }), action);
  }

  // ============================================================
  // 主体
  // ============================================================
  function renderBody() {
    R.toc = h("nav", { class: "toc", "aria-label": T("ui.tocAria") });
    R.content = h("main", { class: "content", tabindex: "-1" });
    R.onboard = null;
    for (const s of SECTIONS) {
      R.toc.append(h("a", { href: `#sec-${s.id}`, dataset: { sec: s.id }, on: { click: (/** @type {Event} */ e) => { e.preventDefault(); scrollToSection(s.id); } } },
        icon(s.icon), h("span", { text: s.title }), h("span", { class: "toc-count", hidden: true })));
      const sec = h("section", { class: `section${s.id === "proxy" && S.attention ? " attention" : ""}`, id: `sec-${s.id}`, "aria-labelledby": `sec-title-${s.id}` },
        h("h2", { class: "section-title", id: `sec-title-${s.id}` }, icon(s.icon), s.title));
      if (s.id === "proxy") {
        R.proxySection = sec;
        // 首次引导说明：告诉用户为什么自动打开了设置，以及接下来会发生什么
        if (S.onboarding) {
          R.onboard = h("div", { class: "onboard-note", role: "status" },
            icon("info"), h("div", {}, h("strong", { text: T("ui.onboardTitle") }), h("span", { text: T("ui.onboardText") })));
          sec.append(R.onboard);
        }
      }
      for (const row of s.rows) sec.append(renderRow(s, row));
      R.content.append(sec);
    }
    R.drawer = h("aside", { class: "drawer", hidden: !S.drawer, "aria-label": T("ui.drawerAria") });
    renderDrawer();
    return h("div", { class: "body" }, R.toc, R.content, R.drawer);
  }

  /** 【代理】区域引导高亮：呼吸描边 3 次后保持静态描边（减少动态效果时只显示静态描边） @param {boolean} on */
  function setAttention(on) {
    S.attention = on;
    if (!R.proxySection) return;
    R.proxySection.classList.remove("attention");
    if (on) {
      void R.proxySection.offsetWidth; // 强制回流，确保再次触发时动画重新播放
      R.proxySection.classList.add("attention");
    }
  }

  /** @param {any} sec @param {any} row */
  function renderRow(sec, row) {
    const rowId = row.id || row.path;
    const descId = `desc-${rowId.replace(/[^a-z0-9]/gi, "-")}`;
    const msg = h("div", { class: "setting-msg", "aria-live": "polite" });
    const control = h("div", { class: "setting-control" });
    const el = h("div", { class: "setting", id: `row-${rowId}`, dataset: { row: rowId } },
      h("div", { class: "setting-head" },
        h("div", { class: "setting-title" }, h("span", { class: "cat", text: `${sec.title} › ` }), row.title),
        row.path ? h("span", { class: "setting-key mono", text: row.path }) : null),
      row.desc ? h("div", { class: "setting-desc", id: descId, text: row.desc }) : null,
      control, msg);

    const paths = row.path ? [row.path] : (row.fields || []).map((/** @type {any} */ f) => f.path);
    R.rows.set(rowId, { el, msg, paths, row });

    switch (row.kind) {
      case "text":
      case "password":
      case "number":
        control.append(renderInput(row, descId));
        break;
      case "port":
        control.append(renderInput({ ...row, kind: "number", width: "w-s" }, descId), renderPresets(row));
        break;
      case "segmented":
        control.append(renderSegmented(row));
        break;
      case "select":
        control.append(renderSelect(row, descId));
        break;
      case "check":
        control.append(renderCheck(row));
        break;
      case "group":
        for (const f of row.fields) {
          control.append(f.kind === "check" ? renderCheck(f) : h("label", { class: "field-inline" }, f.label, renderInput(f, descId)));
        }
        break;
      case "tags":
        control.append(renderTags(row.path, row.itemKind, row.placeholder));
        break;
      case "probe":
        R.probeBtn = h("button", { class: "btn secondary", on: { click: runProbe } }, icon("plug"), T("ui.testConnection"));
        R.probeOut = h("span", { class: "probe-result", role: "status" });
        control.append(R.probeBtn, R.probeOut);
        renderProbe();
        break;
      case "scan":
        R.scanBtn = h("button", { class: "btn secondary", on: { click: runScan } }, icon("search"), T("ui.scanButton"));
        R.scanOut = h("div", { class: "scan-result", role: "status", "aria-live": "polite" });
        control.append(h("div", { class: "scan-wrap" }, R.scanBtn, R.scanOut));
        renderScan();
        break;
      case "rules":
        R.rules = h("div", { class: "rules" });
        control.append(R.rules);
        renderRules();
        break;
      default:
        break;
    }
    return el;
  }

  // ---------- 基础控件 ----------
  /** @param {any} f @param {string} descId */
  function renderInput(f, descId) {
    const isNum = f.kind === "number";
    const value = Core.getPath(S.form, f.path);
    const input = /** @type {HTMLInputElement} */ (h("input", {
      class: `input ${f.width || "w-m"}`,
      type: f.kind === "password" && !S.showSecret ? "password" : isNum ? "number" : "text",
      value: Number.isFinite(value) || typeof value === "string" ? String(value) : "",
      placeholder: f.placeholder || "",
      "aria-label": f.label || f.title,
      "aria-describedby": descId,
      dataset: { path: f.path },
      spellcheck: "false",
      autocomplete: "off",
      min: isNum ? "0" : undefined,
    }));
    input.addEventListener("input", () => {
      setValue(f.path, isNum ? Core.normalizeInt(input.value, NaN) : input.value);
      if (f.path === "proxy.port") syncPresets();
    });
    if (f.kind !== "password") return input;
    const eye = h("button", { class: "icon-btn", title: T("ui.toggleSecret"), "aria-label": T("ui.toggleSecretAria"), "aria-pressed": String(S.showSecret) }, icon(S.showSecret ? "eye-closed" : "eye"));
    eye.addEventListener("click", () => {
      S.showSecret = !S.showSecret;
      input.type = S.showSecret ? "text" : "password";
      eye.setAttribute("aria-pressed", String(S.showSecret));
      eye.replaceChildren(icon(S.showSecret ? "eye-closed" : "eye"));
      renderDrawer();
    });
    return h("span", { class: "secret-wrap" }, input, eye);
  }

  /** @param {any} row */
  function renderPresets(row) {
    R.presets = h("span", { class: "presets", role: "group", "aria-label": T("ui.presetsAria") });
    for (const [port, name] of row.presets) {
      R.presets.append(h("button", {
        class: "preset", title: T("preset.title", { name }), dataset: { port: String(port) },
        on: { click: () => setProxyField("proxy.port", port) },
      }, `${port} · ${name}`));
    }
    syncPresets();
    return R.presets;
  }

  function syncPresets() {
    if (!R.presets) return;
    for (const b of R.presets.querySelectorAll("button")) {
      b.setAttribute("aria-pressed", String(Number(b.dataset.port) === S.form.proxy.port));
    }
  }

  /**
   * 以编程方式修改代理字段并同步对应控件（端口预设、扫描结果填入共用）。
   * @param {"proxy.host" | "proxy.port" | "proxy.type"} path @param {any} value
   */
  function setProxyField(path, value) {
    setValue(path, value);
    if (path === "proxy.type") {
      /** @type {any} */ (document.querySelector('.segmented[data-path="proxy.type"]'))?.sync?.();
      return;
    }
    const input = /** @type {HTMLInputElement | null} */ (document.querySelector(`input[data-path="${path}"]`));
    if (input) input.value = String(value);
    if (path === "proxy.port") syncPresets();
  }

  /** @param {any} row */
  function renderSegmented(row) {
    const wrap = h("div", { class: "segmented", role: "radiogroup", "aria-label": row.title, dataset: { path: row.path } });
    const sync = () => {
      for (const b of wrap.querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.v === Core.getPath(S.form, row.path)));
    };
    for (const o of row.options) {
      wrap.append(h("button", { dataset: { v: o.v }, role: "radio", on: { click: () => { setValue(row.path, o.v); sync(); } } }, o.label));
    }
    /** @type {any} */ (wrap).sync = sync;
    sync();
    return wrap;
  }

  /** @param {any} row @param {string} descId */
  function renderSelect(row, descId) {
    const sel = /** @type {HTMLSelectElement} */ (h("select", { class: "select", "aria-label": row.title, "aria-describedby": descId, dataset: { path: row.path } },
      ...row.options.map((/** @type {any} */ o) => h("option", { value: o.v }, o.label))));
    sel.value = Core.getPath(S.form, row.path);
    sel.addEventListener("change", () => setValue(row.path, sel.value));
    return sel;
  }

  /** @param {any} f */
  function renderCheck(f) {
    const input = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", dataset: { path: f.path }, checked: !!Core.getPath(S.form, f.path) }));
    input.addEventListener("change", () => setValue(f.path, input.checked));
    return h("label", { class: "check" }, input, h("span", { class: "box" }, icon("check")), h("span", { text: f.label }));
  }

  // ---------- 标签列表 ----------
  /**
   * @param {string} path 数组路径（可为规则内路径，通过 getter/setter 读写）
   * @param {"text" | "port" | "portRange"} itemKind
   * @param {string} placeholder
   * @param {{ get: () => any[], set: (v: any[]) => void, errPrefix: string }} [bind]
   */
  function renderTags(path, itemKind, placeholder, bind) {
    const get = bind ? bind.get : () => Core.getPath(S.form, path) || [];
    const set = bind ? bind.set : (/** @type {any[]} */ v) => setValue(path, v);
    const errPrefix = bind ? bind.errPrefix : path;
    const box = h("div", { class: "tags", dataset: { tags: errPrefix } });
    const input = /** @type {HTMLInputElement} */ (h("input", { placeholder, "aria-label": placeholder, spellcheck: "false" }));
    // 只替换标签节点、保留输入框节点不动：校验刷新时不会让正在输入的输入框失焦
    const paint = () => {
      box.querySelectorAll(".tag").forEach((t) => t.remove());
      const frag = document.createDocumentFragment();
      get().forEach((/** @type {any} */ v, /** @type {number} */ i) => {
        const err = S.errors[`${errPrefix}[${i}]`];
        frag.append(h("span", { class: `tag${err ? " invalid" : ""}`, title: err || String(v) },
          h("span", { class: "tag-text", text: String(v) }),
          h("button", { "aria-label": T("ui.removeTag", { value: v }), on: { click: (/** @type {Event} */ e) => { e.stopPropagation(); const next = [...get()]; next.splice(i, 1); set(next); paint(); } } }, icon("close"))));
      });
      box.insertBefore(frag, input);
    };
    box.append(input);
    const commit = () => {
      const parts = input.value.split(/[\s,，;；]+/).map((s) => s.trim()).filter(Boolean);
      if (!parts.length) return;
      const next = [...get()];
      for (const p of parts) {
        if (itemKind === "port") {
          const n = Core.normalizeInt(p, NaN);
          if (!Number.isInteger(n) || n < 1 || n > 65535) { toast("warn", T("ui.badPort", { value: p })); continue; }
          if (!next.includes(n)) next.push(n);
        } else if (!next.includes(p)) {
          next.push(p);
        }
      }
      input.value = "";
      set(next);
      paint();
      input.focus();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === ",") { e.preventDefault(); commit(); }
      else if (e.key === "Backspace" && !input.value && get().length) { const next = [...get()]; next.pop(); set(next); paint(); input.focus(); }
    });
    input.addEventListener("blur", commit);
    box.addEventListener("click", () => input.focus());
    /** @type {any} */ (box).repaint = paint;
    paint();
    return box;
  }

  // ---------- 连通测试 ----------
  function runProbe() {
    if (!S.form) return;
    S.probe = { status: "running" };
    renderProbe();
    renderStatusband();
    post({ type: "probe", proxy: clone(S.form.proxy) });
  }

  function renderProbe() {
    if (!R.probeOut) return;
    const p = S.probe;
    R.probeBtn.disabled = p.status === "running";
    if (p.status === "idle") {
      R.probeOut.className = "probe-result";
      R.probeOut.replaceChildren(h("span", { text: T("ui.notTested") }));
    } else if (p.status === "running") {
      R.probeOut.className = "probe-result";
      R.probeOut.replaceChildren(icon("loading", "codicon-modifier-spin"), T("ui.testing"));
    } else {
      const ok = p.status === "ok";
      R.probeOut.className = `probe-result ${ok ? "ok" : "fail"}`;
      R.probeOut.replaceChildren(icon(ok ? "pass-filled" : "error"), h("span", { text: p.result.message }),
        h("span", { class: "probe-latency", text: `${p.result.latencyMs} ms` }));
    }
  }

  // ---------- 本机代理扫描 ----------
  function runScan() {
    if (!S.form || S.scan.status === "running") return;
    S.scan = { status: "running" };
    renderScan();
    post({ type: "scan", proxy: clone(S.form.proxy) });
  }

  /** @param {any} c */
  const sameAsForm = (c) => S.form && c.host === S.form.proxy.host && c.port === S.form.proxy.port && c.type === S.form.proxy.type;

  /** @param {any} result */
  function onScanResult(result) {
    S.scan = { status: "done", result };
    const list = result?.candidates || [];
    const others = list.filter((/** @type {any} */ c) => !sameAsForm(c));
    // 当前配置不可用且只找到一个可用代理：自动填入（不自动保存），并高亮保存按钮
    if (list.length === 1 && others.length === 1 && S.probe.status !== "ok") {
      applyCandidate(others[0]);
      S.scan.applied = true;
    }
    if (!list.length) {
      // 一个都没找到：保持【代理】区域高亮，并把焦点交给端口输入框，引导手动填写
      setAttention(true);
      /** @type {HTMLInputElement | null} */ (document.querySelector('input[data-path="proxy.port"]'))?.focus({ preventScroll: true });
    }
    renderScan();
  }

  /** 填入扫描到的代理；该端点已完成隧道验证，直接标记为可用 @param {any} c */
  function applyCandidate(c) {
    setProxyField("proxy.host", c.host);
    setProxyField("proxy.port", c.port);
    setProxyField("proxy.type", c.type);
    S.probe = { status: "ok", result: { ok: true, message: c.message, latencyMs: c.latencyMs } };
    renderProbe();
    renderStatusband();
    R.btnSave?.classList.add("attention");
    renderScan();
  }

  function renderScan() {
    if (!R.scanOut) return;
    const sc = S.scan;
    R.scanBtn.disabled = sc.status === "running";
    if (sc.status === "idle") {
      R.scanOut.className = "scan-result";
      R.scanOut.replaceChildren(h("span", { class: "muted", text: T("ui.scanIdle") }));
      return;
    }
    if (sc.status === "running") {
      R.scanOut.className = "scan-result";
      R.scanOut.replaceChildren(h("span", {}, icon("loading", "codicon-modifier-spin"), " ", T("ui.scanning")));
      return;
    }
    const list = sc.result?.candidates || [];
    if (!list.length) {
      R.scanOut.className = "scan-result warn";
      R.scanOut.replaceChildren(h("div", { class: "msg-warn" }, icon("warning"), h("span", { text: T("ui.scanNone") })));
      return;
    }
    R.scanOut.className = "scan-result ok";
    const head = sc.applied
      ? h("div", { class: "msg-ok" }, icon("pass-filled"), h("span", { text: T("ui.scanFoundOne") }))
      : h("div", { class: "muted", text: T("ui.scanFoundMany", { n: list.length }) });
    const chips = h("div", { class: "scan-list" });
    for (const c of list) {
      const current = sameAsForm(c);
      const sources = c.sources.map((/** @type {string} */ s) => T(`scan.source${s[0].toUpperCase()}${s.slice(1)}`)).join(" / ");
      chips.append(h("button", {
        class: `scan-chip${current ? " current" : ""}`,
        "aria-pressed": String(current),
        title: c.message,
        on: { click: () => applyCandidate(c) },
      },
      icon(current ? "pass-filled" : "plug"),
      h("span", { class: "mono", text: `${c.host}:${c.port}` }),
      h("span", { class: "scan-type", text: c.type.toUpperCase() }),
      h("span", { class: "muted", text: `${sources} · ${c.latencyMs} ms` }),
      h("span", { class: "scan-action", text: current ? T("ui.scanInUse") : T("ui.scanUse") })));
    }
    R.scanOut.replaceChildren(head, chips);
  }

  // ---------- 路由规则 ----------
  const rules = () => S.form.proxy_rules.routing.rules;

  function renderRules() {
    if (!R.rules) return;
    R.rules.replaceChildren();
    const list = rules();
    if (!list.length) {
      R.rules.append(h("div", { class: "empty-inline" }, icon("list-tree"),
        h("span", { text: T("ui.noRules", { action: S.form.proxy_rules.routing.default_action }) })));
    }
    list.forEach((/** @type {any} */ r, /** @type {number} */ i) => R.rules.append(renderRule(r, i)));
    R.rules.append(h("div", {}, h("button", { class: "btn secondary", on: { click: addRule } }, icon("add"), T("ui.addRule"))));
  }

  /** @param {any} r @param {number} i */
  function renderRule(r, i) {
    const prefix = `proxy_rules.routing.rules[${i}]`;
    const expanded = S.expandedRules.has(r.__ui_id);
    const ruleErrors = Object.entries(S.errors).filter(([k]) => k === prefix || k.startsWith(`${prefix}.`));
    const ruleWarns = Object.entries(S.warnings).filter(([k]) => k === prefix || k.startsWith(`${prefix}.`));
    const condSummary = (/** @type {any} */ x) => [
      x.domains.length && T("ui.sumDomains", { n: x.domains.length }),
      x.ip_cidrs_v4.length && T("ui.sumIpv4", { n: x.ip_cidrs_v4.length }),
      x.ip_cidrs_v6.length && T("ui.sumIpv6", { n: x.ip_cidrs_v6.length }),
      x.ports.length && T("ui.sumPorts", { n: x.ports.length }),
    ].filter(Boolean).join(" · ") || T("ui.sumNone");
    const summaryEl = h("span", { class: "rule-summary", text: condSummary(r) });
    const nameEl = h("span", { class: "rule-name", text: r.name });
    const update = (/** @type {(rule: any) => void} */ fn, repaintAll = false) => {
      const next = clone(rules());
      fn(next[i]);
      setValue("proxy_rules.routing.rules", next, repaintAll);
      // 原地刷新卡片头部摘要，不重绘卡片，避免打断正在编辑的输入框
      if (!repaintAll) {
        summaryEl.textContent = condSummary(rules()[i]);
        nameEl.textContent = rules()[i].name;
      }
    };
    const move = (/** @type {number} */ d) => {
      const next = clone(rules());
      const [it] = next.splice(i, 1);
      next.splice(i + d, 0, it);
      setValue("proxy_rules.routing.rules", next, true);
    };

    const head = h("div", { class: "rule-head" },
      h("button", { class: "icon-btn", "aria-expanded": String(expanded), "aria-label": T(expanded ? "ui.collapse" : "ui.expand"), on: { click: () => { expanded ? S.expandedRules.delete(r.__ui_id) : S.expandedRules.add(r.__ui_id); renderRules(); } } }, icon(expanded ? "chevron-down" : "chevron-right")),
      nameEl,
      summaryEl,
      h("span", { class: `pill ${r.action}`, text: r.action }),
      (() => {
        const cb = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: !!r.enabled, "aria-label": T("ui.enableRule") }));
        cb.addEventListener("change", () => update((x) => { x.enabled = cb.checked; }, true));
        return h("label", { class: "check", title: T("ui.enabled") }, cb, h("span", { class: "box" }, icon("check")));
      })(),
      h("button", { class: "icon-btn", title: T("ui.moveUp"), "aria-label": T("ui.moveUp"), disabled: i === 0, on: { click: () => move(-1) } }, icon("arrow-up")),
      h("button", { class: "icon-btn", title: T("ui.moveDown"), "aria-label": T("ui.moveDown"), disabled: i === rules().length - 1, on: { click: () => move(1) } }, icon("arrow-down")),
      h("button", { class: "icon-btn", title: T("ui.delete"), "aria-label": T("ui.deleteRule"), on: { click: () => { const next = clone(rules()); next.splice(i, 1); setValue("proxy_rules.routing.rules", next, true); } } }, icon("trash")));

    const card = h("div", { class: `rule${r.enabled ? "" : " disabled"}${ruleErrors.length ? " has-error" : ""}` }, head);
    if (!expanded) return card;

    const nameInput = /** @type {HTMLInputElement} */ (h("input", { class: "input w-m", value: r.name, "aria-label": T("ui.ruleName") }));
    nameInput.addEventListener("input", () => update((x) => { x.name = nameInput.value; }));
    nameInput.addEventListener("change", () => renderRules());
    const action = /** @type {HTMLSelectElement} */ (h("select", { class: "select", "aria-label": T("ui.action") },
      h("option", { value: "proxy" }, `proxy — ${T("opt.viaProxy")}`), h("option", { value: "direct" }, `direct — ${T("opt.direct")}`)));
    action.value = r.action;
    action.addEventListener("change", () => update((x) => { x.action = action.value; }, true));
    const prio = /** @type {HTMLInputElement} */ (h("input", { class: "input w-s", type: "number", value: String(r.priority), "aria-label": T("ui.priority") }));
    prio.addEventListener("input", () => update((x) => { x.priority = Core.normalizeInt(prio.value, 0); }));

    /** @param {string} key @param {string} label @param {string} ph @param {"text"|"portRange"} kind */
    const tagRow = (key, label, ph, kind) => [
      h("label", { text: label }),
      renderTags(`${prefix}.${key}`, kind, ph, {
        get: () => rules()[i][key],
        set: (v) => update((x) => { x[key] = v; }),
        errPrefix: `${prefix}.${key}`,
      }),
    ];

    const body = h("div", { class: "rule-body" },
      h("label", { text: T("ui.name") }), nameInput,
      h("label", { text: T("ui.action") }), action,
      S.form.proxy_rules.routing.priority_mode === "number" ? [h("label", { text: T("ui.priority") }), prio] : null,
      ...tagRow("domains", T("ui.domains"), T("ui.domainsPh"), "text"),
      ...tagRow("ip_cidrs_v4", T("ui.ipv4"), T("ui.ipv4Ph"), "text"),
      ...tagRow("ip_cidrs_v6", T("ui.ipv6"), T("ui.ipv6Ph"), "text"),
      ...tagRow("ports", T("ui.ports"), T("ui.portsPh"), "portRange"),
      ...tagRow("protocols", T("ui.protocols"), "tcp", "text"),
      (ruleErrors.length || ruleWarns.length)
        ? h("div", { class: "rule-errors" },
          ...ruleErrors.map(([k, v]) => h("div", { class: "msg-err" }, icon("error"), T("ui.fieldMsg", { field: k.slice(prefix.length) || T("ui.rule"), msg: v }))),
          ...ruleWarns.map(([, v]) => h("div", { class: "msg-warn" }, icon("warning"), v)))
        : null);
    card.append(body);
    return card;
  }

  function addRule() {
    const next = clone(rules());
    const r = Core.defaultRoutingRule(next.length);
    next.push(r);
    S.expandedRules.add(r.__ui_id);
    setValue("proxy_rules.routing.rules", next, true);
  }

  // ============================================================
  // 编辑 → 校验 → 增量刷新
  // ============================================================
  /** @param {string} path @param {any} value @param {boolean} [repaintRules] */
  function setValue(path, value, repaintRules = false) {
    Core.setPath(S.form, path, value);
    if (path === "proxy_rules.routing.priority_mode" || path === "proxy_rules.routing.default_action") repaintRules = true;
    if (repaintRules) renderRules();
    refreshSoon();
  }

  const refreshSoon = debounce(() => refreshAll(), 120);

  function refreshAll() {
    if (S.phase !== "ready") return;
    const v = Core.validateForm(S.form, LANG);
    S.errors = v.errors;
    S.warnings = v.warnings;

    /** @type {Map<string, {err: string[], warn: string[]}>} */
    const byRow = new Map();
    const push = (/** @type {string} */ k, /** @type {string} */ msg, /** @type {"err"|"warn"} */ kind) => {
      const id = rowIdOf(k);
      if (!id) return;
      if (!byRow.has(id)) byRow.set(id, { err: [], warn: [] });
      byRow.get(id)?.[kind].push(msg);
    };
    for (const [k, m] of Object.entries(S.errors)) push(k, m, "err");
    for (const [k, m] of Object.entries(S.warnings)) if (!k.startsWith("proxy_rules.routing.rules")) push(k, m, "warn");

    /** @type {Record<string, number>} */
    const secErr = {};
    for (const [id, ref] of R.rows) {
      const modified = ref.paths.some((/** @type {string} */ p) => stable(Core.getPath(S.form, p)) !== stable(Core.getPath(S.saved, p)));
      ref.el.classList.toggle("modified", modified);
      const msgs = byRow.get(id) || { err: [], warn: [] };
      if (id === "proxy_rules.routing.rules") {
        ref.msg.replaceChildren(msgs.err.length ? h("div", { class: "msg-err" }, icon("error"), T("ui.ruleErrors", { n: msgs.err.length })) : "");
      } else {
        ref.msg.replaceChildren(
          ...msgs.err.map((m) => h("div", { class: "msg-err" }, icon("error"), m)),
          ...msgs.warn.map((m) => h("div", { class: "msg-warn" }, icon("warning"), m)));
      }
      for (const p of ref.paths) {
        const input = ref.el.querySelector(`[data-path="${p}"]`);
        if (input) input.setAttribute("aria-invalid", String(Object.keys(S.errors).some((k) => k === p)));
      }
      ref.el.querySelectorAll("[data-tags]").forEach((/** @type {any} */ t) => t.repaint && t.repaint());
      if (msgs.err.length) {
        const sec = sectionOfRow(id);
        if (sec) secErr[sec] = (secErr[sec] || 0) + msgs.err.length;
      }
    }
    // 规则卡片内的错误需随校验结果刷新（仅在错误集合变化时重绘，避免打断输入）
    const ruleErrKey = stable(Object.keys(S.errors).filter((k) => k.startsWith("proxy_rules.routing.rules")));
    if (R.lastRuleErrKey !== undefined && ruleErrKey !== R.lastRuleErrKey && !R.rules?.contains(document.activeElement)) renderRules();
    R.lastRuleErrKey = ruleErrKey;

    for (const a of R.toc?.querySelectorAll("a") || []) {
      const n = secErr[a.dataset.sec] || 0;
      const badge = a.querySelector(".toc-count");
      badge.hidden = n === 0;
      badge.textContent = String(n);
    }

    const dirty = isDirty();
    const n = errorCount();
    R.dirty.hidden = !dirty;
    R.errCount.hidden = n === 0;
    R.errCount.textContent = T("ui.errorCount", { n });
    R.btnSave.disabled = !dirty || n > 0 || S.saving;
    R.btnRevert.disabled = !dirty || S.saving;
    if (!dirty) R.btnSave.classList.remove("attention");
    renderDrawer();
    renderStatusband();
  }

  // ============================================================
  // 保存 / 还原 / 默认值
  // ============================================================
  function save() {
    if (S.phase !== "ready" || S.saving) return;
    refreshAll();
    if (errorCount() > 0) {
      toast("error", T("ui.fixErrorsFirst", { n: errorCount() }));
      jumpToFirstError();
      return;
    }
    if (!isDirty()) return;
    S.saving = true;
    R.btnSave.disabled = true;
    post({ type: "save", raw: exportCurrent() });
  }

  function revert() {
    S.form = clone(S.saved);
    S.banner = null;
    render();
  }

  function resetDefaults() {
    const keep = clone(S.form.proxy);
    S.form = Core.defaultForm(S.form._version);
    S.form.proxy = keep; // 代理端口等连接信息保留，避免“恢复默认”后立即断网
    render();
    toast("info", T("ui.defaultsRestored"));
  }

  function jumpToFirstError() {
    const first = Object.keys(S.errors)[0];
    if (!first) return;
    const id = rowIdOf(first);
    if (id === "proxy_rules.routing.rules") {
      const m = /rules\[(\d+)\]/.exec(first);
      if (m) { const r = rules()[Number(m[1])]; if (r) { S.expandedRules.add(r.__ui_id); renderRules(); } }
    }
    scrollToRow(id);
  }

  // ============================================================
  // 导航 / 抽屉 / 横幅 / 提示
  // ============================================================
  /** @param {string} id */
  function scrollToSection(id) {
    document.getElementById(`sec-${id}`)?.scrollIntoView({ block: "start" });
    setActiveSection(id);
  }

  /** @param {string} rowId */
  function scrollToRow(rowId) {
    const el = document.getElementById(`row-${rowId}`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    /** @type {HTMLElement | null} */ (el.querySelector("input, select, button"))?.focus({ preventScroll: true });
  }

  /** @param {string} id */
  function setActiveSection(id) {
    S.activeSection = id;
    for (const a of R.toc?.querySelectorAll("a") || []) a.classList.toggle("active", a.dataset.sec === id);
  }

  function setupScrollSpy() {
    if (!("IntersectionObserver" in window) || !R.content) return;
    const io = new IntersectionObserver((entries) => {
      const visible = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]) setActiveSection(visible[0].target.id.replace("sec-", ""));
    }, { root: R.content, rootMargin: "0px 0px -70% 0px" });
    R.content.querySelectorAll(".section").forEach((/** @type {Element} */ s) => io.observe(s));
    setActiveSection(S.activeSection);
  }

  function toggleDrawer() {
    S.drawer = !S.drawer;
    persist();
    R.drawer.hidden = !S.drawer;
    R.btnJson.setAttribute("aria-pressed", String(S.drawer));
    renderDrawer();
  }

  /** 预览中默认遮挡密码，复制/导出仍使用真实内容 */
  const maskSecret = (/** @type {string} */ text) => S.showSecret ? text : text.replace(/("password":\s*")([^"]+)(")/g, "$1••••••$3");

  function renderDrawer() {
    if (!R.drawer || R.drawer.hidden || !S.form) return;
    const current = JSON.stringify(exportCurrent(), null, 2);
    const tab = (/** @type {string} */ mode, /** @type {string} */ label) => h("button", { class: "tab", role: "tab", "aria-selected": String(S.drawerMode === mode), on: { click: () => { S.drawerMode = mode; persist(); renderDrawer(); } } }, label);
    const head = h("div", { class: "drawer-head" },
      h("div", { class: "tabs", role: "tablist" }, tab("changes", T("ui.tabChanges")), tab("full", T("ui.tabFull"))),
      h("button", { class: "icon-btn", title: T("ui.copyJson"), "aria-label": T("ui.copyJson"), on: { click: () => post({ type: "copy", text: current }) } }, icon("copy")),
      h("button", { class: "icon-btn", title: T("ui.closeEsc"), "aria-label": T("ui.closePreview"), on: { click: toggleDrawer } }, icon("close")));
    const pre = h("pre", { class: "code", tabindex: "0" });
    if (S.drawerMode === "full") {
      for (const line of maskSecret(current).split("\n")) pre.append(h("span", { class: "ln", text: line || " " }));
      R.drawer.replaceChildren(head, pre);
      return;
    }
    const before = maskSecret(JSON.stringify(exportSaved(), null, 2)).split("\n");
    const after = maskSecret(current).split("\n");
    const diff = lineDiff(before, after);
    if (!diff.some((d) => d.t !== " ")) {
      R.drawer.replaceChildren(head, h("div", { class: "drawer-empty" }, icon("pass"), " ", T("ui.noChanges")));
      return;
    }
    // 只展示变更行及上下 2 行上下文
    const keep = new Set();
    diff.forEach((d, i) => { if (d.t !== " ") for (let k = i - 2; k <= i + 2; k++) keep.add(k); });
    let gap = false;
    diff.forEach((d, i) => {
      if (!keep.has(i)) { if (!gap) pre.append(h("span", { class: "ln gap", text: "⋯" })); gap = true; return; }
      gap = false;
      pre.append(h("span", { class: `ln${d.t === "+" ? " add" : d.t === "-" ? " del" : ""}` }, h("span", { class: "mark", text: d.t === " " ? "" : d.t }), d.s || " "));
    });
    R.drawer.replaceChildren(head, pre);
  }

  /**
   * 行级 LCS 差异（配置文件规模在数百行内，O(n·m) 足够）
   * @param {string[]} a @param {string[]} b
   * @returns {{ t: " " | "+" | "-", s: string }[]}
   */
  function lineDiff(a, b) {
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    /** @type {{ t: " " | "+" | "-", s: string }[]} */
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push({ t: " ", s: a[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: "-", s: a[i++] }); }
      else { out.push({ t: "+", s: b[j++] }); }
    }
    while (i < n) out.push({ t: "-", s: a[i++] });
    while (j < m) out.push({ t: "+", s: b[j++] });
    return out;
  }

  function renderBannerEl() {
    R.banner = h("div", { class: "banner", role: "status", hidden: true });
    return R.banner;
  }

  function renderBanner() {
    if (!R.banner) return;
    const b = S.banner;
    R.banner.hidden = !b;
    if (!b) return;
    R.banner.className = `banner${b.kind === "error" ? " error" : ""}`;
    const dismiss = h("button", { class: "icon-btn", "aria-label": T("common.close"), on: { click: () => { S.banner = null; renderBanner(); } } }, icon("close"));
    R.banner.replaceChildren(
      icon(b.kind === "error" ? "error" : "info"),
      h("span", { class: "banner-text", text: T(b.key, b.params) }),
      b.kind === "error"
        ? h("button", { class: "btn secondary", on: { click: save } }, icon("refresh"), T("ui.retry"))
        : h("button", { class: "btn primary", on: { click: () => post({ type: "restart" }) } }, icon("debug-restart"), T("ui.restartIde")),
      dismiss);
  }

  /** @param {string} kind @param {string} text */
  function toast(kind, text) {
    const host = document.getElementById("toasts") || document.body;
    const el = h("div", { class: `toast ${kind}` }, icon(kind === "error" ? "error" : kind === "warn" ? "warning" : "info"), h("span", { text }));
    host.append(el);
    setTimeout(() => el.remove(), kind === "error" ? 6000 : 3500);
  }

  // ============================================================
  // 键盘
  // ============================================================
  document.addEventListener("click", (e) => {
    if (R.menuEl && !R.menuEl.hidden && !R.menuEl.contains(/** @type {Node} */ (e.target))) R.menuClose?.();
  });
  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); save(); }
    else if (mod && e.key.toLowerCase() === "j") { e.preventDefault(); if (S.phase === "ready") toggleDrawer(); }
    else if (e.key === "Escape" && S.drawer && S.phase === "ready" && !document.querySelector(".menu:not([hidden])")) toggleDrawer();
  });

  // ============================================================
  // 启动
  // ============================================================
  if (!Core) {
    app.replaceChildren(h("div", { class: "state-card error" }, icon("error", "big"), h("h2", { text: T("ui.coreMissingTitle") }), h("p", { text: T("ui.coreMissingText") })));
    return;
  }
  render();
  post({ type: "ready" });
})();
