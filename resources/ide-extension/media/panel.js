// @ts-check
/* global acquireVsCodeApi */
/**
 * Antigravity Proxy 配置面板（Webview 前端）
 *
 * 结构：Schema 驱动渲染 → 编辑时增量更新（校验/修改标记/保存态），不整页重绘以保持焦点；
 * 纯逻辑（默认值/规范化/导出/校验）全部来自共享模块 AGPConfigCore，与独立配置页一致。
 * 状态：loading（骨架屏）→ ready | empty（无配置文件）| error（读取/解析失败）。
 */
(function () {
  "use strict";

  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  /** @type {any} */
  const Core = /** @type {any} */ (window).AGPConfigCore;
  const app = /** @type {HTMLElement} */ (document.getElementById("app"));
  const ICON_SRC = app.dataset.icon || "";

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
  // Schema：分区与设置项（标题/说明/控件类型），驱动渲染与错误定位
  // ============================================================
  const opt = (/** @type {string} */ v, /** @type {string} */ label) => ({ v, label });
  const SECTIONS = [
    {
      id: "proxy", title: "代理", icon: "globe",
      rows: [
        { path: "proxy.type", title: "类型", kind: "segmented", options: [opt("socks5", "SOCKS5"), opt("http", "HTTP")], desc: "本地代理软件提供的协议；Clash / Mihomo 的混合端口两种都支持。" },
        { path: "proxy.host", title: "地址", kind: "text", width: "w-m", placeholder: "127.0.0.1", desc: "代理软件监听的地址，本机通常为 127.0.0.1。" },
        { path: "proxy.port", title: "端口", kind: "port", desc: "代理软件监听的端口；0 表示禁用代理（全部直连）。", presets: [[7890, "Clash"], [7897, "Clash Verge"], [10808, "v2rayN"], [1080, "SOCKS"]] },
        { id: "proxy.auth", title: "认证", kind: "group", desc: "仅当上游代理开启账号认证时填写（SOCKS5 RFC 1929 / HTTP Basic）。", fields: [
          { path: "proxy.username", label: "用户名", kind: "text", width: "w-s", placeholder: "可选" },
          { path: "proxy.password", label: "密码", kind: "password", width: "w-s", placeholder: "可选" },
        ] },
        { id: "probe", title: "连通测试", kind: "probe", desc: "使用当前填写的设置（无需先保存）建立到 www.gstatic.com:443 的隧道，验证端口、协议与认证。" },
      ],
    },
    {
      id: "network", title: "网络策略", icon: "shield",
      rows: [
        { path: "proxy_rules.allowed_ports", title: "代理端口白名单", kind: "tags", itemKind: "port", placeholder: "输入端口后回车，如 443", desc: "只有发往这些目标端口的连接走代理，其余直连。" },
        { path: "proxy_rules.dns_mode", title: "DNS 解析", kind: "select", options: [opt("direct", "direct — 本机解析"), opt("proxy", "proxy — 交给代理解析")], desc: "域名由本机解析，或交给代理解析。" },
        { path: "proxy_rules.ipv6_mode", title: "IPv6 连接", kind: "select", options: [opt("proxy", "proxy — 走代理"), opt("direct", "direct — 直连"), opt("block", "block — 阻断")], desc: "发往 IPv6 地址的连接如何处理。" },
        { path: "proxy_rules.udp_mode", title: "UDP / QUIC", kind: "select", options: [opt("auto", "auto — SOCKS5 时代理，否则按回退"), opt("proxy", "proxy — SOCKS5 UDP 代理"), opt("direct", "direct — 直连"), opt("block", "block — 阻断（回落 TCP）")], desc: "UDP 流量（含 QUIC/HTTP3）的处理方式。" },
        { path: "proxy_rules.udp_fallback", title: "UDP 回退", kind: "select", options: [opt("block", "block — 阻断"), opt("direct", "direct — 直连")], desc: "UDP 无法经代理转发时的处理方式（udp_mode 为 auto / proxy 时生效）。" },
        { path: "fake_ip.enabled", title: "FakeIP", kind: "check", label: "启用 FakeIP", desc: "为域名分配虚拟 IP，连接时还原域名交给代理，避免本地 DNS 污染。" },
        { path: "fake_ip.cidr", title: "FakeIP 地址池", kind: "text", width: "w-m", placeholder: "198.18.0.0/15", desc: "虚拟 IP 所用的 IPv4 网段，需避开真实网络。" },
      ],
    },
    {
      id: "routing", title: "路由规则", icon: "list-tree",
      rows: [
        { path: "proxy_rules.routing.enabled", title: "路由", kind: "check", label: "启用路由规则", desc: "按规则决定每条连接走代理还是直连。" },
        { path: "proxy_rules.routing.default_action", title: "默认动作", kind: "select", options: [opt("proxy", "proxy — 走代理"), opt("direct", "direct — 直连")], desc: "未命中任何规则时的处理方式。" },
        { path: "proxy_rules.routing.priority_mode", title: "匹配顺序", kind: "select", options: [opt("order", "order — 按列表顺序"), opt("number", "number — 按优先级数值")], desc: "多条规则同时命中时如何取舍。" },
        { path: "proxy_rules.routing.use_default_private", title: "内网直连", kind: "check", label: "局域网与保留地址始终直连", desc: "自动将回环、局域网等私有网段视为直连。" },
        { path: "proxy_rules.routing.rules", title: "规则列表", kind: "rules", desc: "按域名、IP 段与端口匹配连接。" },
      ],
    },
    {
      id: "injection", title: "进程注入", icon: "symbol-event",
      rows: [
        { path: "child_injection", title: "子进程注入", kind: "check", label: "注入 IDE 启动的子进程", desc: "让后端进程（IDE 2.6+ 为 agy.exe）也走代理；关闭后通常无法登录或对话。" },
        { path: "child_injection_mode", title: "注入范围", kind: "select", options: [opt("filtered", "filtered — 仅目标进程"), opt("inherit", "inherit — 全部子进程")], desc: "filtered 只注入下方目标进程；inherit 注入全部子进程（排除列表除外）。" },
        { path: "target_processes", title: "目标进程", kind: "tags", itemKind: "text", placeholder: "进程名，如 agy.exe", desc: "支持不带 .exe 的名称片段匹配。" },
        { path: "child_injection_exclude", title: "排除进程", kind: "tags", itemKind: "text", placeholder: "永不注入的进程名", desc: "优先级高于目标进程列表。" },
      ],
    },
    {
      id: "advanced", title: "高级", icon: "tools",
      rows: [
        { path: "log_level", title: "日志级别", kind: "select", options: [opt("debug", "debug — 调试"), opt("info", "info — 信息"), opt("warn", "warn — 警告"), opt("error", "error — 错误")], desc: "DLL 日志（安装目录 logs\\）的详细程度，排障时可临时改为 debug。" },
        { id: "timeout", title: "超时", kind: "group", desc: "连接代理、发送与接收的超时时间（毫秒）。", fields: [
          { path: "timeout.connect", label: "连接", kind: "number", width: "w-s" },
          { path: "timeout.send", label: "发送", kind: "number", width: "w-s" },
          { path: "timeout.recv", label: "接收", kind: "number", width: "w-s" },
        ] },
        { path: "traffic_logging", title: "流量日志", kind: "check", label: "记录每条连接的收发统计", desc: "会显著增加日志量，仅排障时开启。" },
        { path: "diagnostics.agent_ip_probe", title: "出口 IP 诊断", kind: "check", label: "启动时探测代理出口 IP 与地区", desc: "用于排查 “User location is not supported”。" },
        { path: "updates.enabled", title: "更新检查", kind: "check", label: "后台检查 DLL 新版本", desc: "发现新版本时提示；不会自动替换文件。" },
        { id: "updates.timing", title: "更新检查时机", kind: "group", desc: "启动后延迟与请求超时（毫秒）。", fields: [
          { path: "updates.check_delay_ms", label: "延迟", kind: "number", width: "w-s" },
          { path: "updates.timeout_ms", label: "超时", kind: "number", width: "w-s" },
        ] },
        { id: "updates.flags", title: "更新提示", kind: "group", desc: "", fields: [
          { path: "updates.notify_once", label: "同一版本只提示一次", kind: "check" },
          { path: "updates.allow_insecure_mirrors", label: "允许证书不受信任的镜像", kind: "check" },
        ] },
        { path: "updates.mirrors", title: "下载镜像", kind: "tags", itemKind: "text", placeholder: "https://…", desc: "GitHub 加速镜像，必须为 https。" },
      ],
    },
  ];

  // 路径 → 行 id（错误/修改标记定位用）
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
    saving: false,
    drawer: !!persisted.drawer,
    drawerMode: persisted.drawerMode || "changes",
    showSecret: false,
    /** @type {Set<string>} */ expandedRules: new Set(),
    activeSection: "proxy",
    /** @type {null | { kind: string, text: string }} */ banner: null,
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
      case "meta": S.meta = m.meta; return renderStatusband();
      case "saved": return onSaved(m);
      case "probeResult": S.probe = { status: m.result.ok ? "ok" : "fail", result: m.result }; renderProbe(); renderStatusband(); return;
      case "imported": return onImported(m.raw);
      case "toast": return toast(m.kind, m.text);
      default: return;
    }
  });

  /** @param {any} m */
  function onInit(m) {
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
    render();
    if (S.phase === "ready" && S.form.proxy.port > 0 && S.probe.status === "idle") runProbe();
  }

  /** @param {any} m */
  function onSaved(m) {
    S.saving = false;
    if (m.ok) {
      S.baseRaw = exportCurrent();
      S.saved = clone(S.form);
      if (m.meta) S.meta = m.meta;
      S.banner = { kind: "info", text: "已保存。代理 DLL 在进程启动时读取配置，重启 IDE 后生效。" };
    } else {
      S.banner = { kind: "error", text: `保存失败：${m.error}` };
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
    toast("info", "已导入到编辑区，确认无误后点击“保存”写入 config.json");
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
    return h("div", { class: "skeleton", "aria-busy": "true", "aria-label": "正在加载配置" },
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

    R.dirty = h("span", { class: "dirty-badge", hidden: true }, h("span", { class: "dot" }), "未保存");
    R.errCount = h("button", { class: "error-count", hidden: true, on: { click: jumpToFirstError } });
    R.btnRevert = h("button", { class: "btn secondary", on: { click: revert }, title: "放弃未保存的修改" }, icon("discard"), "还原");
    R.btnSave = h("button", { class: "btn primary", on: { click: save }, title: "保存到 config.json（Ctrl+S）" }, icon("save"), "保存");
    R.btnJson = h("button", { class: "icon-btn", "aria-pressed": String(S.drawer), title: "JSON 预览与变更（Ctrl+J）", "aria-label": "JSON 预览与变更", on: { click: toggleDrawer } }, icon("json"));
    return h("header", { class: "topbar" }, brand,
      h("div", { class: "actions" }, R.errCount, R.dirty, R.btnRevert, R.btnSave, R.btnJson, renderMenu(true)));
  }

  /** @param {boolean} ready */
  function renderMenu(ready) {
    const items = [
      ["go-to-file", "在编辑器中打开 config.json", () => post({ type: "openConfigFile" })],
      ["folder-opened", "打开日志目录", () => post({ type: "openLogs" })],
      null,
      ["cloud-download", "导入配置…", () => post({ type: "import" })],
      ready ? ["file-add", "导出配置…", () => post({ type: "export", raw: exportCurrent() })] : undefined,
      ready ? ["history", "恢复默认值（未保存）", resetDefaults] : undefined,
      null,
      ["refresh", "从磁盘重新加载", () => post({ type: "reload" })],
    ].filter((x) => x !== undefined);
    const menu = h("div", { class: "menu", role: "menu", hidden: true });
    const btn = h("button", { class: "icon-btn", "aria-haspopup": "menu", "aria-expanded": "false", "aria-label": "更多操作", title: "更多操作" }, icon("ellipsis"));
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
    return h("div", { class: "state-card", role: "region", "aria-label": "未找到配置文件" },
      icon("file-add", "big"),
      h("h2", { text: "未找到 config.json" }),
      h("p", { class: "mono", text: S.meta?.configPath || "" }),
      h("p", { text: "代理 DLL 需要与 version.dll 同目录的 config.json。可以用默认配置创建，或导入已有配置。" }),
      h("div", { class: "state-actions" },
        h("button", { class: "btn primary", on: { click: () => post({ type: "createDefault" }) } }, icon("add"), "使用默认配置创建"),
        h("button", { class: "btn secondary", on: { click: () => post({ type: "import" }) } }, icon("cloud-download"), "导入配置文件…")));
  }

  function renderError() {
    const title = S.readStatus === "invalid" ? "配置文件无法解析" : "读取配置文件失败";
    return h("div", { class: "state-card error", role: "alert" },
      icon("error", "big"),
      h("h2", { text: title }),
      h("p", { text: S.readError }),
      h("p", { class: "mono", text: S.meta?.configPath || "" }),
      h("div", { class: "state-actions" },
        h("button", { class: "btn primary", on: { click: () => post({ type: "openConfigFile" }) } }, icon("go-to-file"), "在编辑器中修复"),
        h("button", { class: "btn secondary", on: { click: () => post({ type: "reload" }) } }, icon("refresh"), "重新加载"),
        h("button", { class: "btn secondary", on: { click: () => post({ type: "createDefault" }) }, title: "原文件会自动备份到插件存储目录" }, icon("history"), "用默认配置覆盖")));
  }

  // ============================================================
  // 状态带：补丁 / 待重启 / 连通 / 配置
  // ============================================================
  function renderStatusbandEl() {
    R.band = h("section", { class: "statusband", "aria-label": "代理状态" });
    return R.band;
  }

  function renderStatusband() {
    if (!R.band || !S.meta) return;
    const chips = [];
    const p = S.meta.patch || {};
    if (!p.dllExists) {
      chips.push(chip("err", "error", "补丁缺失（version.dll）", h("button", { class: "link-btn", on: { click: () => post({ type: "repair" }) } }, "修复")));
    } else if (p.dllLoaded === true) {
      chips.push(chip("ok", "pass-filled", "补丁已生效"));
    } else if (p.dllLoaded === false) {
      chips.push(chip("warn", "sync", "补丁文件就绪，重启后生效"));
    } else {
      chips.push(chip("muted", "info", "补丁文件就绪"));
    }
    if (S.meta.pendingRestart) {
      chips.push(chip("warn", "debug-restart", "配置已更新，待重启生效", h("button", { class: "link-btn", on: { click: () => post({ type: "restart" }) } }, "立即重启")));
    }
    if (S.form && S.form.proxy.port === 0) {
      chips.push(chip("muted", "circle-slash", "代理已禁用（端口 0）"));
    } else if (S.probe.status === "running") {
      chips.push(chip("muted", "loading", "正在测试连通性…", null, "codicon-modifier-spin"));
    } else if (S.probe.status === "ok") {
      chips.push(chip("ok", "pass-filled", `代理可用 · ${S.probe.result.latencyMs} ms`));
    } else if (S.probe.status === "fail") {
      chips.push(chip("err", "debug-disconnect", "代理不可用", h("button", { class: "link-btn", on: { click: () => scrollToRow("probe") } }, "详情")));
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
    R.toc = h("nav", { class: "toc", "aria-label": "设置分区" });
    R.content = h("main", { class: "content", tabindex: "-1" });
    for (const s of SECTIONS) {
      R.toc.append(h("a", { href: `#sec-${s.id}`, dataset: { sec: s.id }, on: { click: (/** @type {Event} */ e) => { e.preventDefault(); scrollToSection(s.id); } } },
        icon(s.icon), h("span", { text: s.title }), h("span", { class: "toc-count", hidden: true })));
      const sec = h("section", { class: "section", id: `sec-${s.id}`, "aria-labelledby": `sec-title-${s.id}` },
        h("h2", { class: "section-title", id: `sec-title-${s.id}` }, icon(s.icon), s.title));
      for (const row of s.rows) sec.append(renderRow(s, row));
      R.content.append(sec);
    }
    R.drawer = h("aside", { class: "drawer", hidden: !S.drawer, "aria-label": "JSON 预览" });
    renderDrawer();
    return h("div", { class: "body" }, R.toc, R.content, R.drawer);
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
        R.probeBtn = h("button", { class: "btn secondary", on: { click: runProbe } }, icon("plug"), "测试连接");
        R.probeOut = h("span", { class: "probe-result", role: "status" });
        control.append(R.probeBtn, R.probeOut);
        renderProbe();
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
    const eye = h("button", { class: "icon-btn", title: "显示/隐藏", "aria-label": "显示或隐藏密码", "aria-pressed": String(S.showSecret) }, icon(S.showSecret ? "eye-closed" : "eye"));
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
    R.presets = h("span", { class: "presets", role: "group", "aria-label": "常用端口" });
    for (const [port, name] of row.presets) {
      R.presets.append(h("button", {
        class: "preset", title: `${name} 常用端口`, dataset: { port: String(port) },
        on: { click: () => {
          const input = /** @type {HTMLInputElement} */ (document.querySelector('[data-path="proxy.port"]'));
          input.value = String(port);
          setValue("proxy.port", port);
          syncPresets();
        } },
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

  /** @param {any} row */
  function renderSegmented(row) {
    const wrap = h("div", { class: "segmented", role: "radiogroup", "aria-label": row.title });
    const sync = () => {
      for (const b of wrap.querySelectorAll("button")) b.setAttribute("aria-checked", String(b.dataset.v === Core.getPath(S.form, row.path)));
    };
    for (const o of row.options) {
      wrap.append(h("button", { dataset: { v: o.v }, role: "radio", on: { click: () => { setValue(row.path, o.v); sync(); } } }, o.label));
    }
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
          h("button", { "aria-label": `删除 ${v}`, on: { click: (/** @type {Event} */ e) => { e.stopPropagation(); const next = [...get()]; next.splice(i, 1); set(next); paint(); } } }, icon("close"))));
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
          if (!Number.isInteger(n) || n < 1 || n > 65535) { toast("warn", `端口需为 1-65535 的整数：${p}`); continue; }
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
      R.probeOut.replaceChildren(h("span", { text: "尚未测试" }));
    } else if (p.status === "running") {
      R.probeOut.className = "probe-result";
      R.probeOut.replaceChildren(icon("loading", "codicon-modifier-spin"), "正在建立隧道…");
    } else {
      const ok = p.status === "ok";
      R.probeOut.className = `probe-result ${ok ? "ok" : "fail"}`;
      R.probeOut.replaceChildren(icon(ok ? "pass-filled" : "error"), h("span", { text: p.result.message }),
        h("span", { class: "probe-latency", text: `${p.result.latencyMs} ms` }));
    }
  }

  // ---------- 路由规则 ----------
  const rules = () => S.form.proxy_rules.routing.rules;

  function renderRules() {
    if (!R.rules) return;
    R.rules.replaceChildren();
    const list = rules();
    if (!list.length) {
      R.rules.append(h("div", { class: "empty-inline" }, icon("list-tree"),
        h("span", { text: `暂无规则，全部连接按默认动作（${S.form.proxy_rules.routing.default_action}）处理。` })));
    }
    list.forEach((/** @type {any} */ r, /** @type {number} */ i) => R.rules.append(renderRule(r, i)));
    R.rules.append(h("div", {}, h("button", { class: "btn secondary", on: { click: addRule } }, icon("add"), "添加规则")));
  }

  /** @param {any} r @param {number} i */
  function renderRule(r, i) {
    const prefix = `proxy_rules.routing.rules[${i}]`;
    const expanded = S.expandedRules.has(r.__ui_id);
    const ruleErrors = Object.entries(S.errors).filter(([k]) => k === prefix || k.startsWith(`${prefix}.`));
    const ruleWarns = Object.entries(S.warnings).filter(([k]) => k === prefix || k.startsWith(`${prefix}.`));
    const condSummary = (/** @type {any} */ x) => [x.domains.length && `域名 ${x.domains.length}`, x.ip_cidrs_v4.length && `IPv4 ${x.ip_cidrs_v4.length}`, x.ip_cidrs_v6.length && `IPv6 ${x.ip_cidrs_v6.length}`, x.ports.length && `端口 ${x.ports.length}`].filter(Boolean).join(" · ") || "无匹配条件";
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
      h("button", { class: "icon-btn", "aria-expanded": String(expanded), "aria-label": expanded ? "收起" : "展开", on: { click: () => { expanded ? S.expandedRules.delete(r.__ui_id) : S.expandedRules.add(r.__ui_id); renderRules(); } } }, icon(expanded ? "chevron-down" : "chevron-right")),
      nameEl,
      summaryEl,
      h("span", { class: `pill ${r.action}`, text: r.action }),
      (() => {
        const cb = /** @type {HTMLInputElement} */ (h("input", { type: "checkbox", checked: !!r.enabled, "aria-label": "启用此规则" }));
        cb.addEventListener("change", () => update((x) => { x.enabled = cb.checked; }, true));
        return h("label", { class: "check", title: "启用" }, cb, h("span", { class: "box" }, icon("check")));
      })(),
      h("button", { class: "icon-btn", title: "上移", "aria-label": "上移", disabled: i === 0, on: { click: () => move(-1) } }, icon("arrow-up")),
      h("button", { class: "icon-btn", title: "下移", "aria-label": "下移", disabled: i === rules().length - 1, on: { click: () => move(1) } }, icon("arrow-down")),
      h("button", { class: "icon-btn", title: "删除", "aria-label": "删除规则", on: { click: () => { const next = clone(rules()); next.splice(i, 1); setValue("proxy_rules.routing.rules", next, true); } } }, icon("trash")));

    const card = h("div", { class: `rule${r.enabled ? "" : " disabled"}${ruleErrors.length ? " has-error" : ""}` }, head);
    if (!expanded) return card;

    const nameInput = /** @type {HTMLInputElement} */ (h("input", { class: "input w-m", value: r.name, "aria-label": "规则名称" }));
    nameInput.addEventListener("input", () => update((x) => { x.name = nameInput.value; }));
    nameInput.addEventListener("change", () => renderRules());
    const action = /** @type {HTMLSelectElement} */ (h("select", { class: "select", "aria-label": "动作" }, h("option", { value: "proxy" }, "proxy — 走代理"), h("option", { value: "direct" }, "direct — 直连")));
    action.value = r.action;
    action.addEventListener("change", () => update((x) => { x.action = action.value; }, true));
    const prio = /** @type {HTMLInputElement} */ (h("input", { class: "input w-s", type: "number", value: String(r.priority), "aria-label": "优先级" }));
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
      h("label", { text: "名称" }), nameInput,
      h("label", { text: "动作" }), action,
      S.form.proxy_rules.routing.priority_mode === "number" ? [h("label", { text: "优先级" }), prio] : null,
      ...tagRow("domains", "域名", "如 *.google.com", "text"),
      ...tagRow("ip_cidrs_v4", "IPv4 网段", "如 10.0.0.0/8", "text"),
      ...tagRow("ip_cidrs_v6", "IPv6 网段", "如 fd00::/8", "text"),
      ...tagRow("ports", "端口", "443 或 8000-9000", "portRange"),
      ...tagRow("protocols", "协议", "tcp", "text"),
      (ruleErrors.length || ruleWarns.length)
        ? h("div", { class: "rule-errors" },
          ...ruleErrors.map(([k, v]) => h("div", { class: "msg-err" }, icon("error"), `${k.slice(prefix.length) || "规则"}：${v}`)),
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
    const v = Core.validateForm(S.form);
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
        ref.msg.replaceChildren(msgs.err.length ? h("div", { class: "msg-err" }, icon("error"), `规则中有 ${msgs.err.length} 处错误，已标红`) : "");
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
    R.errCount.textContent = `${n} 个错误`;
    R.btnSave.disabled = !dirty || n > 0 || S.saving;
    R.btnRevert.disabled = !dirty || S.saving;
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
      toast("error", `存在 ${errorCount()} 个错误，请先修正`);
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
    toast("info", "已恢复默认值（代理连接信息保留），保存后生效");
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
      h("div", { class: "tabs", role: "tablist" }, tab("changes", "变更"), tab("full", "完整 JSON")),
      h("button", { class: "icon-btn", title: "复制 JSON", "aria-label": "复制 JSON", on: { click: () => post({ type: "copy", text: current }) } }, icon("copy")),
      h("button", { class: "icon-btn", title: "关闭（Esc）", "aria-label": "关闭预览", on: { click: toggleDrawer } }, icon("close")));
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
      R.drawer.replaceChildren(head, h("div", { class: "drawer-empty" }, icon("pass"), " 与磁盘上的 config.json 一致，没有未保存的变更"));
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
    const dismiss = h("button", { class: "icon-btn", "aria-label": "关闭", on: { click: () => { S.banner = null; renderBanner(); } } }, icon("close"));
    R.banner.replaceChildren(
      icon(b.kind === "error" ? "error" : "info"),
      h("span", { class: "banner-text", text: b.text }),
      b.kind === "error"
        ? h("button", { class: "btn secondary", on: { click: save } }, icon("refresh"), "重试")
        : h("button", { class: "btn primary", on: { click: () => post({ type: "restart" }) } }, icon("debug-restart"), "立即重启 IDE"),
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
    app.replaceChildren(h("div", { class: "state-card error" }, icon("error", "big"), h("h2", { text: "缺少共享配置核心 config-core.js" }), h("p", { text: "插件打包不完整，请重新安装插件。" })));
    return;
  }
  render();
  post({ type: "ready" });
})();
