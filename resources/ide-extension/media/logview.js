// @ts-check
/* global acquireVsCodeApi */
/**
 * 实时日志窗口前端（底部面板 / 编辑器标签页共用）。
 *
 * 功能：级别筛选（全部/调试/信息/警告/错误）、关键字搜索高亮、暂停/继续、自动换行、
 *       清空视图、复制可见内容、打开日志文件/目录；底部显示当前文件与统计。
 * 约束：CSP 禁止内联脚本/样式；只使用 --vscode-* 主题变量；渲染上限 1000 行。
 */
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  /** @type {any} */
  const I18n = /** @type {any} */ (window).AGPI18n;
  const app = /** @type {HTMLElement} */ (document.getElementById("app"));

  let LANG = app.dataset.lang || "zh-cn";
  /** @type {(key: string, params?: Record<string, any>) => string} */
  let T = I18n ? I18n.createT(LANG) : (k) => k;

  const state = {
    /** @type {{id:number, ts:string, level:string, text:string, source:string, pid?:number}[]} */
    lines: [],
    /** @type {{level:string, query:string}} */
    filter: { level: "all", query: "" },
    paused: false,
    wrap: true,
    autoScroll: true,
    file: "",
    dropped: 0,
    /** 底部面板环境条：{ proxy, egress, gemini } */
    env: null,
  };

  try {
    const saved = vscode.getState();
    if (saved) {
      if (saved.filter) state.filter = { level: saved.filter.level || "all", query: saved.filter.query || "" };
      state.paused = !!saved.paused;
      state.wrap = saved.wrap !== false;
    }
  } catch { /* 忽略损坏状态 */ }

  const saveState = () => {
    try { vscode.setState({ filter: state.filter, paused: state.paused, wrap: state.wrap }); } catch { /* 忽略 */ }
  };

  const post = (/** @type {any} */ msg) => vscode.postMessage(msg);
  /** @param {string} id */
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

  /**
   * @param {string} tag @param {Record<string, any>} [props] @param {...any} children
   * @returns {HTMLElement}
   */
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, /** @type {any} */ (fn));
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k === "value") /** @type {any} */ (el).value = v;
      else if (k === "checked") /** @type {any} */ (el).checked = v;
      else if (k === "hidden") /** @type {any} */ (el).hidden = v;
      else if (k === "title") /** @type {any} */ (el).title = v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  /** @param {string} name */
  const icon = (name) => h("i", { class: `codicon codicon-${name}`, "aria-hidden": "true" });

  const LEVEL_CLASS = { debug: "lv-debug", info: "lv-info", warn: "lv-warn", error: "lv-error" };
  const MAX_LINES = 3000;
  const MAX_RENDERED = 1000;

  /** @param {any} line */
  function matchesFilter(line) {
    if (state.filter.level !== "all" && line.level !== state.filter.level) return false;
    const query = state.filter.query.toLowerCase();
    if (query && !`${line.ts} ${line.text}`.toLowerCase().includes(query)) return false;
    return true;
  }

  /** @param {HTMLElement} parent @param {string} text */
  function appendHighlighted(parent, text) {
    const query = state.filter.query;
    if (!query) {
      parent.append(document.createTextNode(text));
      return;
    }
    const lower = text.toLowerCase();
    const q = query.toLowerCase();
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(q, from);
      if (idx < 0) break;
      if (idx > from) parent.append(document.createTextNode(text.slice(from, idx)));
      parent.append(h("mark", { text: text.slice(idx, idx + q.length) }));
      from = idx + q.length;
    }
    if (from < text.length) parent.append(document.createTextNode(text.slice(from)));
  }

  /** @param {any} line */
  function renderRow(line) {
    const time = (line.ts || "").split(" ")[1] || "";
    const lvl = String(line.level || "info").toUpperCase();
    const msg = h("span", { class: "msg" });
    if (line.source === "plugin") msg.append(h("span", { class: "src", text: T("logs.sourcePlugin") }));
    appendHighlighted(msg, line.text);
    return h("div", { class: `row ${LEVEL_CLASS[line.level] || ""}` },
      h("span", { class: "t", text: time }),
      h("span", { class: "lvl", text: lvl }),
      line.pid ? h("span", { class: "pid", text: String(line.pid) }) : null,
      msg,
    );
  }

  /** @param {boolean} [force] */
  function renderAll(force = false) {
    const list = $("lv-list");
    if (!list) return;
    const filtered = state.lines.filter(matchesFilter);
    const shown = filtered.slice(-MAX_RENDERED);
    list.textContent = "";
    const frag = document.createDocumentFragment();
    for (const line of shown) frag.append(renderRow(line));
    list.append(frag);
    updateCounts();
    if (!state.paused && state.autoScroll) list.scrollTop = list.scrollHeight;
    if (force) state.autoScroll = true;
  }

  function updateCounts() {
    /** @type {Record<string, number>} */
    const counts = { all: state.lines.length, debug: 0, info: 0, warn: 0, error: 0 };
    for (const line of state.lines) if (counts[line.level] !== undefined) counts[line.level] += 1;
    for (const [level, n] of Object.entries(counts)) {
      const el = document.querySelector(`[data-count="${level}"]`);
      if (el) el.textContent = String(n);
    }
    const stats = $("lv-stats");
    if (stats) {
      stats.textContent = T("logs.stats", { shown: state.lines.filter(matchesFilter).length, total: state.lines.length, dropped: state.dropped || 0 });
    }
    const file = $("lv-file");
    if (file) {
      const base = state.file ? state.file.split(/[\\/]/).pop() : "";
      file.textContent = base || T("logs.noFile");
      file.title = state.file || "";
    }
  }

  /** @param {any[]} incoming */
  function appendLines(incoming) {
    if (!Array.isArray(incoming) || incoming.length === 0) return;
    state.lines.push(...incoming);
    if (state.lines.length > MAX_LINES) state.lines.splice(0, state.lines.length - MAX_LINES);
    if (state.paused) return;
    const list = $("lv-list");
    if (!list) return;
    const added = incoming.filter(matchesFilter);
    if (added.length === 0) { updateCounts(); return; }
    const frag = document.createDocumentFragment();
    for (const line of added) frag.append(renderRow(line));
    list.append(frag);
    while (list.childElementCount > MAX_RENDERED) list.firstElementChild?.remove();
    updateCounts();
    if (state.autoScroll) list.scrollTop = list.scrollHeight;
  }

  /** @param {any} snapshot */
  function applySnapshot(snapshot) {
    state.lines = Array.isArray(snapshot?.lines) ? snapshot.lines.slice(-MAX_LINES) : [];
    state.file = String(snapshot?.file || "");
    state.dropped = Number(snapshot?.dropped || 0);
    if (snapshot?.dirs) state.dirs = snapshot.dirs;
    state.autoScroll = true;
    renderAll(true);
  }

  /** @type {NodeJS.Timeout | undefined} */
  let searchTimer;

  function build() {
    document.documentElement.lang = (I18n && I18n.HTML_LANG[LANG]) || "en";
    app.textContent = "";

    const levels = [
      ["all", "logs.levelAll"],
      ["debug", "logs.levelDebug"],
      ["info", "logs.levelInfo"],
      ["warn", "logs.levelWarn"],
      ["error", "logs.levelError"],
    ];
    const levelBar = h("div", { class: "lv-levels", role: "tablist" },
      levels.map(([value, key]) => h("button", {
        class: `lv-chip${state.filter.level === value ? " active" : ""}`,
        "data-level": value,
        title: T(key),
        on: {
          click: () => {
            state.filter.level = value;
            saveState();
            for (const btn of levelBar.querySelectorAll(".lv-chip")) btn.classList.toggle("active", btn.getAttribute("data-level") === value);
            renderAll(true);
          },
        },
      }, h("span", { text: T(key).split(" ")[0] }), h("span", { class: "cnt", "data-count": value, text: "0" }))),
    );

    const search = /** @type {HTMLInputElement} */ (h("input", { class: "lv-search", type: "search", placeholder: T("logs.searchPh"), value: state.filter.query }));
    search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.filter.query = search.value.trim();
        saveState();
        renderAll(true);
      }, 140);
    });

    const pauseBtn = h("button", { class: "lv-btn", title: T("logs.pause") }, icon(state.paused ? "debug-continue" : "debug-pause"), h("span", { text: state.paused ? T("logs.resume") : T("logs.pause") }));
    pauseBtn.addEventListener("click", () => {
      state.paused = !state.paused;
      saveState();
      pauseBtn.title = state.paused ? T("logs.resume") : T("logs.pause");
      pauseBtn.lastElementChild.textContent = state.paused ? T("logs.resume") : T("logs.pause");
      pauseBtn.firstElementChild.className = `codicon codicon-${state.paused ? "debug-continue" : "debug-pause"}`;
      if (!state.paused) renderAll(true);
    });

    const wrapBtn = h("button", { class: "lv-btn", title: T("logs.wrap"), "aria-pressed": state.wrap ? "true" : "false" }, icon("word-wrap"), h("span", { text: T("logs.wrap") }));
    wrapBtn.addEventListener("click", () => {
      state.wrap = !state.wrap;
      saveState();
      wrapBtn.setAttribute("aria-pressed", state.wrap ? "true" : "false");
      document.body.classList.toggle("nowrap", !state.wrap);
    });

    const clearBtn = h("button", { class: "lv-btn", title: T("logs.clear"), on: { click: () => { state.lines = []; renderAll(true); } } }, icon("clear-all"), h("span", { text: T("logs.clear") }));

    const copyBtn = h("button", { class: "lv-btn", title: T("logs.copy"), on: {
      click: () => {
        const text = state.lines.filter(matchesFilter).map((l) => `${l.ts} [${l.level}] ${l.text}`).join("\n");
        post({ type: "copy", text });
      },
    } }, icon("copy"), h("span", { text: T("logs.copy") }));

    const openFileBtn = h("button", { class: "lv-btn", title: T("logs.openFile"), on: { click: () => post({ type: "openFile" }) } }, icon("go-to-file"), h("span", { text: T("logs.openFile") }));
    const openDirBtn = h("button", { class: "lv-btn", title: T("logs.openDir"), on: { click: () => post({ type: "openDir" }) } }, icon("folder-opened"), h("span", { text: T("logs.openDir") }));

    const list = h("div", { class: "lv-body", id: "lv-list", role: "log", "aria-live": "polite" });
    list.addEventListener("scroll", () => {
      state.autoScroll = list.scrollTop + list.clientHeight >= list.scrollHeight - 16;
    });

    const fileEl = h("span", { class: "lv-file", id: "lv-file", text: T("logs.noFile") });
    const envEl = h("span", { class: "lv-env", id: "lv-env", text: "" });
    const statsEl = h("span", { class: "lv-stats", id: "lv-stats", text: "" });

    app.append(h("div", { class: "lv" },
      h("div", { class: "lv-toolbar" }, levelBar, search, h("div", { class: "lv-actions" }, pauseBtn, wrapBtn, clearBtn, copyBtn, openFileBtn, openDirBtn)),
      list,
      h("div", { class: "lv-foot" }, fileEl, envEl, statsEl),
      h("div", { class: "toast", id: "toast", hidden: true }),
    ));
    document.body.classList.toggle("nowrap", !state.wrap);
    renderAll(true);
    renderEnv();
  }

  /** 底部环境条：代理地址 + 出口 IP/运营商 + Gemini 结论（需求 3/4） */
  function renderEnv() {
    const el = $("lv-env");
    if (!el) return;
    const env = state.env;
    if (!env) {
      el.textContent = "";
      el.title = "";
      return;
    }
    const proxy = env.proxy;
    const proxyText = proxy && proxy.port > 0 ? `${proxy.type || "socks5"}://${proxy.host}:${proxy.port}` : T("sb.disabled");
    const egress = env.egress && env.egress.status === "ok" ? env.egress.data || {} : {};
    const gem = env.gemini && env.gemini.result;
    const gemText = gem
      ? ({
          ok: T("sb.geminiOk"),
          blocked: T("sb.geminiBlocked"),
          inconclusive: T("sb.geminiInconclusive"),
          error: T("sb.geminiError"),
          "proxy-error": T("sb.geminiProxyError"),
        }[/** @type {any} */ (gem.state)] || "")
      : env.gemini && env.gemini.checking
        ? T("side2.geminiChecking")
        : T("side2.geminiIdle");
    el.textContent = T("logs.env", {
      proxy: proxyText,
      ip: egress.ip || "—",
      org: [egress.asn, egress.orgName].filter(Boolean).join(" "),
      gemini: gemText,
    });
    el.title = el.textContent;
  }

  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    switch (msg.type) {
      case "init":
        if (msg.lang) LANG = msg.lang;
        T = I18n ? I18n.createT(LANG) : T;
        state.env = msg.env || null;
        build();
        applySnapshot(msg.snapshot || null);
        break;
      case "env":
        state.env = msg.env || null;
        renderEnv();
        break;
      case "lang":
        if (!msg.lang) break;
        LANG = msg.lang;
        T = I18n ? I18n.createT(LANG) : T;
        build();
        break;
      case "append":
        appendLines(msg.lines);
        break;
      case "reset":
        applySnapshot(msg.snapshot || null);
        break;
      case "toast": {
        const toast = /** @type {any} */ ($("toast"));
        if (!toast) break;
        toast.hidden = false;
        toast.className = `toast ${msg.kind || "info"}`;
        toast.textContent = msg.text || "";
        setTimeout(() => { toast.hidden = true; }, 3000);
        break;
      }
      default:
        break;
    }
  });

  // Ctrl/Cmd+F 聚焦搜索框（不抢占 IDE 自身的查找快捷键以外的键）
  window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
      const input = /** @type {HTMLInputElement | null} */ (document.querySelector(".lv-search"));
      if (input) {
        event.preventDefault();
        input.focus();
        input.select();
      }
    }
  });

  post({ type: "ready" });
})();
