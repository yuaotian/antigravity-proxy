// @ts-check
/* global acquireVsCodeApi */
/**
 * 左侧活动栏 Webview 前端：状态卡片 + 出口 IP + Gemini + 实时日志 + 快捷操作。
 *
 * 设计约束：
 * - CSP 禁用内联脚本/样式，所有交互用 addEventListener + postMessage；
 * - 只使用 --vscode-* 主题变量与 codicons，保证深色/浅色/高对比度主题一致；
 * - 状态更新不整页重绘（保留搜索框焦点与滚动位置），只有语言切换才重建骨架；
 * - 日志只保留最近 1500 行（宿主另有 3000 行环形缓冲），渲染上限 400 行，避免侧栏卡顿。
 */
(function () {
  "use strict";

  const vscode = acquireVsCodeApi();
  /** @type {any} */
  const I18n = /** @type {any} */ (window).AGPI18n;
  const app = /** @type {HTMLElement} */ (document.getElementById("app"));
  const ICON = app.dataset.icon || "";
  const VERSION = app.dataset.version || "";

  let LANG = app.dataset.lang || "zh-cn";
  /** @type {(key: string, params?: Record<string, any>) => string} */
  let T = I18n ? I18n.createT(LANG) : (k) => k;

  /** 本地状态（宿主模型 + 日志缓冲 + 过滤条件） */
  const state = {
    /** @type {any} */
    model: null,
    /** @type {{id:number, ts:string, level:string, text:string, source:string}[]} */
    logs: [],
    filter: { level: "all", query: "" },
    paused: false,
    autoScroll: true,
    /** @type {Record<string, any>} */
    settings: {},
  };

  // 恢复上次的过滤/暂停状态（视图隐藏后重新打开仍保持）
  try {
    const saved = vscode.getState();
    if (saved) {
      if (saved.filter) state.filter = { level: saved.filter.level || "all", query: saved.filter.query || "" };
      state.paused = !!saved.paused;
    }
  } catch { /* 忽略损坏状态 */ }

  const saveState = () => {
    try {
      vscode.setState({ filter: state.filter, paused: state.paused });
    } catch { /* 忽略 */ }
  };

  const post = (/** @type {any} */ msg) => vscode.postMessage(msg);
  /** @param {string} id */
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

  /**
   * 轻量元素构造（与配置面板同一套约定，避免引入框架）。
   * @param {string} tag @param {Record<string, any>} [props] @param {...any} children
   * @returns {HTMLElement}
   */
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k === "html") el.innerHTML = v;
      else if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, /** @type {any} */ (fn));
      else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k === "value") /** @type {any} */ (el).value = v;
      else if (k === "checked") /** @type {any} */ (el).checked = v;
      else if (k === "hidden") /** @type {any} */ (el).hidden = v;
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

  /**
   * 状态点 + 行：左标签、右值、可选详情（tooltip）。
   * @param {string} label
   * @returns {{ root: HTMLElement, dot: HTMLElement, value: HTMLElement }}
   */
  function kvRow(label) {
    const dot = h("span", { class: "dot idle" });
    const value = h("span", { class: "kv-value" });
    const root = h("div", { class: "kv" }, dot, h("span", { class: "kv-key", text: label }), value);
    return { root, dot, value };
  }

  /** @param {HTMLElement} dot @param {"ok" | "warn" | "err" | "idle" | "spin"} kind */
  function setDot(dot, kind) {
    dot.className = `dot ${kind}`;
  }

  // ============================================================
  // 骨架
  // ============================================================
  /** @type {Record<string, HTMLElement>} */
  const refs = {};

  function buildSkeleton() {
    document.documentElement.lang = (I18n && I18n.HTML_LANG[LANG]) || "en";
    app.textContent = "";

    const head = h("header", { class: "sb-head" },
      ICON ? h("img", { class: "sb-logo", src: ICON, alt: "" }) : icon("shield"),
      h("div", { class: "sb-name" },
        h("span", { class: "sb-title", text: "Antigravity Proxy" }),
        h("span", { class: "sb-ver", text: VERSION ? `v${VERSION}` : "" }),
      ),
      h("span", { class: "chip idle", id: "chip-patch", text: "—" }),
    );

    // ---- 状态卡片 ----
    const statusCard = h("section", { class: "card" },
      h("div", { class: "card-head" }, h("span", { text: T("side2.statusTitle") })),
    );
    for (const [key, labelKey] of [
      ["patch", "sb.rowPatch"],
      ["config", "sb.rowConfig"],
      ["proxy", "sb.rowProxy"],
      ["reach", "sb.rowReach"],
    ]) {
      const row = kvRow(T(labelKey));
      tagRow(key, row);
      refs[`row-${key}`] = row.root;
      refs[`dot-${key}`] = row.dot;
      refs[`val-${key}`] = row.value;
      statusCard.append(row.root);
    }
    const missing = h("div", { class: "hint warn", id: "row-missing", hidden: true });
    statusCard.append(missing);
    refs["row-missing"] = missing;

    // ---- 出口 IP 卡片 ----
    const ipCard = h("section", { class: "card" },
      h("div", { class: "card-head" },
        h("span", { text: T("side2.ipTitle") }),
        h("button", { class: "mini", title: T("side2.ipRefresh"), on: { click: () => post({ type: "action", action: "refreshIp" }) } }, icon("refresh")),
      ),
    );
    const ipMain = h("div", { class: "ip-main" },
      h("span", { class: "ip-addr", id: "ip-addr", text: "—" }),
      h("span", { class: "badge", id: "ip-badge", hidden: true }),
    );
    const ipOrg = h("div", { class: "ip-org", id: "ip-org", text: T("side2.ipUnknown") });
    const ipLoc = h("div", { class: "ip-loc", id: "ip-loc", text: "" });
    const ipMeta = h("div", { class: "meta", id: "ip-meta", text: "" });
    refs["ip-addr"] = /** @type {any} */ (ipMain.firstElementChild);
    refs["ip-org"] = ipOrg;
    refs["ip-loc"] = ipLoc;
    refs["ip-meta"] = ipMeta;
    refs["ip-badge"] = /** @type {any} */ (ipMain.lastElementChild);
    ipCard.append(ipMain, ipOrg, ipLoc, ipMeta);

    // ---- Gemini 卡片 ----
    const gemCard = h("section", { class: "card" },
      h("div", { class: "card-head" },
        h("span", { text: T("side2.geminiTitle") }),
        h("span", { class: "badge idle", id: "gem-badge", text: T("side2.geminiIdle") }),
        h("button", { class: "mini", title: T("side2.geminiCheck"), on: { click: () => post({ type: "action", action: "checkGemini" }) } }, icon("beaker")),
      ),
    );
    const gemRows = [
      ["network", "side2.geminiNetwork"],
      ["api", "side2.geminiApi"],
      ["anti", "side2.geminiAntigravity"],
    ];
    for (const [key, labelKey] of gemRows) {
      const row = kvRow(T(labelKey));
      tagRow(`gem-${key}`, row);
      refs[`gem-${key}`] = row.root;
      refs[`gemdot-${key}`] = row.dot;
      refs[`gemval-${key}`] = row.value;
      gemCard.append(row.root);
    }
    const gemMeta = h("div", { class: "meta", id: "gem-meta", text: "" });
    const gemLog = h("div", { class: "hint", id: "gem-log", hidden: true });
    refs["gem-meta"] = gemMeta;
    refs["gem-log"] = gemLog;
    gemCard.append(gemMeta, gemLog);

    // ---- 更新卡片 ----
    const updCard = h("section", { class: "card" },
      h("div", { class: "card-head" },
        h("span", { text: T("side2.updateTitle") }),
        h("span", { class: "badge idle", id: "upd-badge", text: "" }),
      ),
    );
    const updStatus = h("div", { class: "upd-status", id: "upd-status", text: T("side2.updateIdle") });
    const updActions = h("div", { class: "upd-actions" },
      h("button", { class: "btn ghost", id: "upd-check", on: { click: () => post({ type: "action", action: "checkUpdate" }) } }, icon("cloud-download"), T("side2.updateCheck")),
      h("button", { class: "btn primary", id: "upd-apply", hidden: true, on: { click: () => post({ type: "action", action: "applyUpdate" }) } }, T("side2.updateApply")),
      h("button", { class: "btn primary", id: "upd-reload", hidden: true, on: { click: () => post({ type: "action", action: "reloadWindow" }) } }, T("side2.updateReload")),
    );
    refs["upd-badge"] = /** @type {any} */ (updCard.querySelector("#upd-badge"));
    refs["upd-status"] = updStatus;
    refs["upd-check"] = /** @type {any} */ (updActions.children[0]);
    refs["upd-apply"] = /** @type {any} */ (updActions.children[1]);
    refs["upd-reload"] = /** @type {any} */ (updActions.children[2]);
    updCard.append(updStatus, updActions);

    // ---- 日志 ----
    const levelSelect = /** @type {HTMLSelectElement} */ (h("select", { class: "log-level", id: "log-level", title: T("side2.logLevel") },
      h("option", { value: "all", text: T("logs.levelAll") }),
      h("option", { value: "debug", text: T("logs.levelDebug") }),
      h("option", { value: "info", text: T("logs.levelInfo") }),
      h("option", { value: "warn", text: T("logs.levelWarn") }),
      h("option", { value: "error", text: T("logs.levelError") }),
    ));
    levelSelect.value = state.filter.level;
    levelSelect.addEventListener("change", () => {
      state.filter.level = levelSelect.value;
      saveState();
      renderLogs(true);
    });

    const search = /** @type {HTMLInputElement} */ (h("input", { class: "log-search", id: "log-search", type: "search", placeholder: T("logs.searchPh"), value: state.filter.query }));
    let searchTimer;
    search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.filter.query = search.value.trim();
        saveState();
        renderLogs(true);
      }, 160);
    });

    const pauseBtn = h("button", { class: "mini", id: "log-pause", title: state.paused ? T("logs.resume") : T("logs.pause"), on: {
      click: () => {
        state.paused = !state.paused;
        saveState();
        pauseBtn.title = state.paused ? T("logs.resume") : T("logs.pause");
        pauseBtn.classList.toggle("active", state.paused);
        post({ type: "action", action: "refreshLogs" });
        if (!state.paused) renderLogs(true);
      },
    } }, icon(state.paused ? "debug-pause" : "debug-continue"));

    const logsList = h("div", { class: "logs-list", id: "logs-list", role: "log" });
    logsList.addEventListener("scroll", () => {
      state.autoScroll = logsList.scrollTop + logsList.clientHeight >= logsList.scrollHeight - 12;
    });

    const logsCard = h("section", { class: "card logs-card" },
      h("div", { class: "card-head" },
        h("span", { text: T("side2.logsTitle") }),
        h("button", { class: "mini", title: T("logs.openPanel"), on: { click: () => post({ type: "action", action: "openLogWindow" }) } }, icon("window")),
      ),
      h("div", { class: "logs-tools" }, levelSelect, search, pauseBtn),
      logsList,
      h("div", { class: "logs-foot" },
        h("span", { class: "log-file", id: "log-file", text: T("logs.noFile") }),
        h("span", { class: "log-count", id: "log-count", text: "" }),
      ),
    );
    refs["logs-list"] = logsList;
    refs["log-file"] = /** @type {any} */ (logsCard.querySelector("#log-file"));
    refs["log-count"] = /** @type {any} */ (logsCard.querySelector("#log-count"));

    // ---- 快捷操作 ----
    const actions = [
      ["openSettings", "settings-gear", "side.openSettings"],
      ["scanProxy", "search", "side.scanProxy"],
      ["testProxy", "plug", "side.testProxy"],
      ["repairPatch", "shield", "side.repairPatch"],
      ["restartIde", "debug-restart", "side.restartIde"],
      ["openLogs", "folder-opened", "side.openLogs"],
    ];
    const actionGrid = h("section", { class: "actions" },
      actions.map(([action, ic, labelKey]) =>
        h("button", { class: "act", "data-action": action, title: T(labelKey), on: { click: () => post({ type: "action", action }) } },
          icon(ic), h("span", { text: T(labelKey) }),
        )),
    );

    app.append(h("div", { class: "sb" },
      head,
      h("div", { class: "sb-scroll" }, statusCard, ipCard, gemCard, updCard, logsCard, actionGrid),
      h("div", { class: "toast", id: "toast", hidden: true }),
    ));

    // 重新缓存节点引用（骨架重建后旧引用失效）
    refs["chip-patch"] = /** @type {any} */ (app.querySelector("#chip-patch"));
    refs["row-missing"] = /** @type {any} */ (app.querySelector("#row-missing"));
    refs["ip-addr"] = /** @type {any} */ (app.querySelector("#ip-addr"));
    refs["ip-org"] = /** @type {any} */ (app.querySelector("#ip-org"));
    refs["ip-loc"] = /** @type {any} */ (app.querySelector("#ip-loc"));
    refs["ip-meta"] = /** @type {any} */ (app.querySelector("#ip-meta"));
    refs["ip-badge"] = /** @type {any} */ (app.querySelector("#ip-badge"));
    refs["gem-badge"] = /** @type {any} */ (app.querySelector("#gem-badge"));
    refs["gem-meta"] = /** @type {any} */ (app.querySelector("#gem-meta"));
    refs["gem-log"] = /** @type {any} */ (app.querySelector("#gem-log"));
    refs["upd-badge"] = /** @type {any} */ (app.querySelector("#upd-badge"));
    refs["upd-status"] = /** @type {any} */ (app.querySelector("#upd-status"));
    refs["upd-check"] = /** @type {any} */ (app.querySelector("#upd-check"));
    refs["upd-apply"] = /** @type {any} */ (app.querySelector("#upd-apply"));
    refs["upd-reload"] = /** @type {any} */ (app.querySelector("#upd-reload"));
    refs["logs-list"] = /** @type {any} */ (app.querySelector("#logs-list"));
    refs["log-file"] = /** @type {any} */ (app.querySelector("#log-file"));
    refs["log-count"] = /** @type {any} */ (app.querySelector("#log-count"));

    // 状态行引用也要重建
    for (const key of ["patch", "config", "proxy", "reach"]) {
      refs[`row-${key}`] = /** @type {any} */ (app.querySelector(`#row-${key}`));
      refs[`dot-${key}`] = /** @type {any} */ (app.querySelector(`#dot-${key}`));
      refs[`val-${key}`] = /** @type {any} */ (app.querySelector(`#val-${key}`));
    }
    for (const key of ["network", "api", "anti"]) {
      refs[`gem-${key}`] = /** @type {any} */ (app.querySelector(`#gem-${key}`));
      refs[`gemdot-${key}`] = /** @type {any} */ (app.querySelector(`#gemdot-${key}`));
      refs[`gemval-${key}`] = /** @type {any} */ (app.querySelector(`#gemval-${key}`));
    }
  }

  /**
   * 给 kv 行绑定唯一 id（骨架里按 key 生成，方便语言切换后重新查找）。
   * 说明：kvRow 内部没有 id，这里在 append 前统一补齐。
   * @param {string} key @param {{ root: HTMLElement, dot: HTMLElement, value: HTMLElement }} row
   */
  function tagRow(key, row) {
    row.root.id = `row-${key}`;
    row.dot.id = `dot-${key}`;
    row.value.id = `val-${key}`;
  }

  // ============================================================
  // 模型渲染
  // ============================================================
  /** @param {any} model */
  function applyModel(model) {
    state.model = model;
    if (!model) return;

    // 补丁
    const patch = model.patch || {};
    /** @type {"ok" | "warn" | "err" | "idle"} */
    let patchKind = "idle";
    let patchText = T("sb.patchStateReady");
    if (!patch.dllExists) {
      patchKind = "err";
      patchText = T("sb.patchStateMissing");
    } else if (patch.dllLoaded === true && !model.pendingRestart) {
      patchKind = "ok";
      patchText = T("sb.patchStateActive");
    } else if (model.pendingRestart || patch.needsRestart || patch.dllLoaded === false) {
      patchKind = "warn";
      patchText = T("sb.patchStatePending");
    }
    setText(refs["val-patch"], patchText);
    setDot(refs["dot-patch"], patchKind);
    const chip = refs["chip-patch"];
    if (chip) {
      chip.className = `chip ${patchKind}`;
      chip.textContent = patchText;
      chip.title = patchKind === "err" ? T("sb.patchMissingSummary") : "";
    }

    // 配置
    const cfg = model.configStatus || "error";
    /** @type {Record<string, { kind: "ok" | "warn" | "err", key: string }>} */
    const cfgMap = {
      ok: { kind: "ok", key: "sb.configStateOk" },
      missing: { kind: "warn", key: "sb.configStateMissing" },
      invalid: { kind: "warn", key: "sb.configStateInvalid" },
      error: { kind: "err", key: "sb.configStateError" },
    };
    const cfgView = cfgMap[cfg] || cfgMap.error;
    setText(refs["val-config"], T(cfgView.key));
    setDot(refs["dot-config"], cfgView.kind);

    // 代理
    const proxy = model.proxy;
    if (!proxy || proxy.port === 0) {
      setText(refs["val-proxy"], T("sb.disabled"));
      setDot(refs["dot-proxy"], "idle");
    } else {
      setText(refs["val-proxy"], `${proxy.type}://${proxy.host}:${proxy.port}`);
      setDot(refs["dot-proxy"], "ok");
    }

    // 连通
    if (model.probing) {
      setText(refs["val-reach"], T("sb.probing", { port: proxy ? proxy.port : "" }));
      setDot(refs["dot-reach"], "spin");
    } else if (model.reach) {
      const ok = !!model.reach.ok;
      const ms = Number(model.reach.latencyMs) > 0 ? T("sb.reachOkLatency", { ms: model.reach.latencyMs }) : T("sb.reachOk");
      setText(refs["val-reach"], ok ? ms : model.reach.message);
      refs["val-reach"].title = model.reach.message || "";
      setDot(refs["dot-reach"], ok ? "ok" : "warn");
    } else {
      setText(refs["val-reach"], "—");
      setDot(refs["dot-reach"], "idle");
    }

    // 缺少目标进程
    const missing = model.missingTargets || [];
    const missEl = refs["row-missing"];
    if (missEl) {
      if (missing.length > 0) {
        missEl.hidden = false;
        missEl.textContent = T("sb.targetsMissingSummary", { names: missing.join(", ") });
      } else {
        missEl.hidden = true;
        missEl.textContent = "";
      }
    }

    // 出口 IP
    applyEgress(model.egress);
    // Gemini
    applyGemini(model.gemini);
    // 更新
    applyUpdate(model.update, model.version);
  }

  /** @param {HTMLElement | null} el @param {string} text */
  function setText(el, text) {
    if (el) el.textContent = text ?? "";
  }

  /** @param {any} egress */
  function applyEgress(egress) {
    const addr = refs["ip-addr"];
    const org = refs["ip-org"];
    const loc = refs["ip-loc"];
    const meta = refs["ip-meta"];
    const badge = refs["ip-badge"];
    if (!egress) {
      setText(addr, "—");
      setText(org, T("side2.ipUnknown"));
      setText(loc, "");
      setText(meta, "");
      if (badge) badge.hidden = true;
      return;
    }
    if (egress.status === "idle") {
      setText(addr, "—");
      setText(org, T("side2.ipUnknown"));
      setText(loc, "");
      setText(meta, "");
      if (badge) badge.hidden = true;
      return;
    }
    if (egress.status === "loading") {
      setText(addr, T("side2.ipLoading"));
      setText(org, T("side2.ipLoading"));
      setText(loc, "");
      setText(meta, "");
      return;
    }
    if (egress.status === "error") {
      setText(addr, "—");
      setText(org, egress.error || T("side2.ipError"));
      setText(loc, "");
      setText(meta, egress.proxyError || "");
      if (badge) badge.hidden = true;
      return;
    }
    const data = egress.data || {};
    setText(addr, data.ip || "—");
    setText(org, [data.asn, data.orgName].filter(Boolean).join(" ") || T("side2.ipUnknown"));
    setText(loc, [data.city, data.region, data.country].filter(Boolean).join(" · "));
    const via = egress.via === "proxy" ? T("side2.ipViaProxy") : T("side2.ipViaDirect");
    setText(meta, `${via} · ${formatTime(egress.checkedAt)}${egress.proxyError ? ` · ${T("side2.ipProxyFallback")}` : ""}`);
    if (badge) {
      if (data.datacenter) {
        badge.hidden = false;
        badge.className = "badge warn";
        badge.textContent = T("side2.ipDatacenter");
        badge.title = T("side2.ipDatacenterHint");
      } else {
        badge.hidden = true;
      }
    }
  }

  /** @param {any} gem */
  function applyGemini(gem) {
    const badge = refs["gem-badge"];
    const meta = refs["gem-meta"];
    const logEl = refs["gem-log"];
    if (!gem || (!gem.result && !gem.checking)) {
      if (badge) {
        badge.className = "badge idle";
        badge.textContent = T("side2.geminiIdle");
      }
      setText(meta, T("side2.geminiNever"));
      if (logEl) logEl.hidden = true;
      for (const key of ["network", "api", "anti"]) {
        setDot(refs[`gemdot-${key}`], "idle");
        setText(refs[`gemval-${key}`], "—");
      }
      return;
    }
    if (gem.checking) {
      if (badge) {
        badge.className = "badge spin";
        badge.textContent = T("side2.geminiChecking");
      }
    }
    const result = gem.result;
    if (!result) return;

    const stateMap = {
      ok: { kind: "ok", text: T("side2.geminiOk") },
      blocked: { kind: "err", text: T("side2.geminiBlocked") },
      inconclusive: { kind: "warn", text: T("side2.geminiInconclusive") },
      error: { kind: "err", text: T("side2.geminiError") },
      "proxy-error": { kind: "warn", text: T("side2.geminiProxyError") },
    };
    const view = stateMap[result.state] || stateMap.inconclusive;
    if (badge && !gem.checking) {
      badge.className = `badge ${view.kind}`;
      badge.textContent = view.text;
    }

    // 网络
    const net = result.network || {};
    const netOk = !!net.ok;
    setDot(refs["gemdot-network"], netOk ? "ok" : "err");
    setText(refs["gemval-network"], netOk
      ? `${net.status} · ${net.via === "proxy" ? T("side2.ipViaProxy") : T("side2.ipViaDirect")} · ${net.latencyMs}ms`
      : (net.error || T("side2.geminiError")));

    // Gemini API
    const api = result.geminiApi || {};
    const apiKind = api.state === "ok" ? "ok" : api.state === "blocked" ? "err" : "warn";
    setDot(refs["gemdot-api"], apiKind);
    setText(refs["gemval-api"], api.state === "ok" ? T("side2.geminiApiOk")
      : api.state === "blocked" ? T("side2.geminiApiBlocked")
      : api.state === "error" ? (api.error || T("side2.geminiError"))
      : T("side2.geminiApiUnknown"));

    // Antigravity 真实链路
    const anti = result.antigravity || {};
    const antiKind = anti.state === "blocked" ? "err" : anti.state === "ok" ? "ok" : "warn";
    setDot(refs["gemdot-anti"], antiKind);
    setText(refs["gemval-anti"], anti.state === "blocked" ? T("side2.geminiAntiBlocked")
      : anti.state === "ok" ? T("side2.geminiAntiOk")
      : T("side2.geminiAntiUnknown"));

    const interval = Number(state.settings.geminiIntervalSeconds) || 0;
    setText(meta, `${T("side2.geminiLastChecked", { time: formatTime(result.checkedAt) })}${interval > 0 ? ` · ${T("side2.geminiInterval", { seconds: interval })}` : ""}`);

    if (logEl) {
      const evidence = result.logEvidence || {};
      if (evidence.matched) {
        logEl.hidden = false;
        logEl.className = "hint err";
        logEl.textContent = T("side2.geminiLogMatched", { time: formatTime(evidence.mtimeMs) });
        logEl.title = `${evidence.path}\n${evidence.line}`;
      } else {
        logEl.hidden = true;
        logEl.textContent = "";
      }
    }
  }

  /** @param {any} upd @param {string} version */
  function applyUpdate(upd, version) {
    const badge = refs["upd-badge"];
    const status = refs["upd-status"];
    const applyBtn = refs["upd-apply"];
    const reloadBtn = refs["upd-reload"];
    const checkBtn = refs["upd-check"];
    if (!upd) {
      setText(status, T("side2.updateIdle"));
      return;
    }
    const tag = upd.latestTag || "";
    /** @type {Record<string, { kind: string, text: string }>} */
    const map = {
      disabled: { kind: "idle", text: T("side2.updateDisabled") },
      idle: { kind: "idle", text: T("side2.updateIdle") },
      checking: { kind: "spin", text: T("side2.updateChecking") },
      uptodate: { kind: "ok", text: T("side2.updateUptodate", { version: upd.currentVersion || version }) },
      available: { kind: "warn", text: T("side2.updateAvailable", { current: upd.currentVersion || version, latest: tag }) },
      downloading: { kind: "spin", text: T("side2.updateDownloading", { latest: tag }) },
      installing: { kind: "spin", text: T("side2.updateInstalling") },
      installed: { kind: "ok", text: T("side2.updateInstalled", { latest: tag }) },
      error: { kind: "err", text: upd.error || T("side2.updateError") },
    };
    const view = map[upd.status] || map.idle;
    if (badge) {
      badge.className = `badge ${view.kind}`;
      badge.textContent = view.kind === "ok" ? "OK" : view.kind === "err" ? "!" : view.kind === "warn" ? "↑" : view.kind === "spin" ? "…" : "";
    }
    setText(status, view.text);
    if (applyBtn) applyBtn.hidden = upd.status !== "available";
    if (reloadBtn) reloadBtn.hidden = upd.status !== "installed";
    if (checkBtn) checkBtn.disabled = upd.status === "checking" || upd.status === "downloading" || upd.status === "installing";
  }

  // ============================================================
  // 日志渲染
  // ============================================================
  const LEVEL_CLASS = { debug: "lv-debug", info: "lv-info", warn: "lv-warn", error: "lv-error" };
  const MAX_WEBVIEW_LINES = 1500;
  const MAX_RENDERED = 400;

  /** @param {any} line */
  function matchesFilter(line) {
    if (state.filter.level !== "all" && line.level !== state.filter.level) return false;
    const query = state.filter.query.toLowerCase();
    if (query && !`${line.ts} ${line.text}`.toLowerCase().includes(query)) return false;
    return true;
  }

  /** @param {HTMLElement} parent @param {string} text @param {string} query */
  function appendHighlighted(parent, text, query) {
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

  /** @param {any} line @param {string} query */
  function renderLine(line, query) {
    const time = (line.ts || "").split(" ")[1] || "";
    const row = h("div", { class: `log-row ${LEVEL_CLASS[line.level] || ""}` },
      h("span", { class: "log-time", text: time }),
      h("span", { class: "log-lv", text: line.level.toUpperCase().slice(0, 4) }),
      h("span", { class: "log-text" }),
    );
    const textEl = /** @type {any} */ (row.lastElementChild);
    if (line.source === "plugin") textEl.append(h("span", { class: "log-src", text: T("logs.sourcePlugin") }));
    appendHighlighted(textEl, line.text, query);
    return row;
  }

  /** @param {boolean} [force] 强制整表重建（过滤条件变化时） */
  function renderLogs(force = false) {
    const list = refs["logs-list"];
    if (!list) return;
    const filtered = state.logs.filter(matchesFilter).slice(-MAX_RENDERED);
    list.textContent = "";
    const frag = document.createDocumentFragment();
    for (const line of filtered) frag.append(renderLine(line, state.filter.query));
    list.append(frag);
    const count = refs["log-count"];
    if (count) {
      count.textContent = T("logs.count", { shown: filtered.length, total: state.logs.length });
    }
    if (!state.paused && state.autoScroll) list.scrollTop = list.scrollHeight;
    if (force) state.autoScroll = true;
  }

  /** @param {any[]} lines */
  function appendLogs(lines) {
    if (!Array.isArray(lines) || lines.length === 0) return;
    state.logs.push(...lines);
    if (state.logs.length > MAX_WEBVIEW_LINES) state.logs.splice(0, state.logs.length - MAX_WEBVIEW_LINES);
    if (state.paused) return;
    const list = refs["logs-list"];
    if (!list) return;
    const added = lines.filter(matchesFilter);
    if (added.length === 0) return;
    const frag = document.createDocumentFragment();
    for (const line of added) frag.append(renderLine(line, state.filter.query));
    list.append(frag);
    while (list.childElementCount > MAX_RENDERED) list.firstElementChild?.remove();
    const count = refs["log-count"];
    if (count) count.textContent = T("logs.count", { shown: list.childElementCount, total: state.logs.length });
    if (state.autoScroll) list.scrollTop = list.scrollHeight;
  }

  /** @param {any} snapshot */
  function resetLogs(snapshot) {
    state.logs = Array.isArray(snapshot?.lines) ? snapshot.lines.slice(-MAX_WEBVIEW_LINES) : [];
    const file = refs["log-file"];
    if (file) {
      const pathText = String(snapshot?.file || "");
      file.textContent = pathText ? pathText.split(/[\\/]/).pop() : T("logs.noFile");
      file.title = pathText;
    }
    state.autoScroll = true;
    renderLogs(true);
  }

  /** @param {number} ms */
  function formatTime(ms) {
    if (!ms) return "—";
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  // ============================================================
  // 消息
  // ============================================================
  window.addEventListener("message", (event) => {
    const msg = event.data || {};
    switch (msg.type) {
      case "init": {
        if (msg.lang && msg.lang !== LANG) LANG = msg.lang;
        T = I18n ? I18n.createT(LANG) : T;
        state.settings = msg.settings || {};
        state.model = msg.model || null;
        buildSkeleton();
        applyModel(state.model);
        resetLogs(msg.logs || null);
        break;
      }
      case "lang": {
        if (!msg.lang) break;
        LANG = msg.lang;
        T = I18n ? I18n.createT(LANG) : T;
        buildSkeleton();
        applyModel(state.model);
        renderLogs(true);
        break;
      }
      case "model":
        applyModel(msg.model);
        break;
      case "logsAppend":
        appendLogs(msg.lines);
        break;
      case "logsReset":
        resetLogs(msg.snapshot);
        break;
      case "toast":
        showToast(msg.kind, msg.text);
        break;
      default:
        break;
    }
  });

  /** @type {NodeJS.Timeout | undefined} */
  let toastTimer;
  /** @param {string} kind @param {string} text */
  function showToast(kind, text) {
    const toast = /** @type {any} */ (app.querySelector("#toast"));
    if (!toast) return;
    toast.hidden = false;
    toast.className = `toast ${kind || "info"}`;
    toast.textContent = text || "";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 3000);
  }

  // 事件委托只注册一次：骨架重建不会重复绑定（否则会重复 postMessage）
  app.addEventListener("click", (/** @type {any} */ ev) => {
    const target = ev.target instanceof Element ? ev.target.closest("[data-action]") : null;
    if (!target) return;
    const action = target.getAttribute("data-action");
    if (action) post({ type: "action", action });
  });

  post({ type: "ready" });
})();
