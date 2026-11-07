/*
 * Antigravity-Proxy 配置核心逻辑（共享模块）
 *
 * 设计意图：
 * - 唯一事实来源：默认值 / 规范化 / 导出 / 校验 只保留这一份，供以下三处复用，避免字段漂移：
 *   1) resources/config-web/index.html（独立配置页，构建时内联为单文件）
 *   2) IDE 插件 Webview 配置面板（浏览器环境）
 *   3) IDE 插件 Host 侧（Node 环境：读写 config.json、单元测试）
 * - 纯函数、零依赖、UMD 导出；语义对齐 src/core/Config.hpp 的解析与回退规则。
 * - 本文件从原 config-web 内联脚本中逐函数迁移，行为保持一致（含错误/警告文案）。
 */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.AGPConfigCore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // -------------------------
  // Utils
  // -------------------------
  const deepClone = (obj) => {
    try {
      // 现代运行时优先（浏览器 / Node 17+）
      return structuredClone(obj);
    } catch (_) {
      return JSON.parse(JSON.stringify(obj ?? {}));
    }
  };

  const pad2 = (n) => String(n).padStart(2, "0");
  const formatNow = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  };

  const trim = (s) => (typeof s === "string" ? s.trim() : "");
  const toLower = (s) => (typeof s === "string" ? s.toLowerCase() : "");

  const getPath = (obj, path) => {
    const parts = String(path || "").split(".").filter(Boolean);
    let cur = obj;
    for (const k of parts) {
      if (!cur || typeof cur !== "object") return undefined;
      cur = cur[k];
    }
    return cur;
  };

  const setPath = (obj, path, value) => {
    const parts = String(path || "").split(".").filter(Boolean);
    if (!parts.length) return;
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const k = parts[i];
      if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
      cur = cur[k];
    }
    cur[parts[parts.length - 1]] = value;
  };

  const normalizeBool = (v, fallback) => {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (["1", "true", "yes", "y", "on"].includes(s)) return true;
      if (["0", "false", "no", "n", "off"].includes(s)) return false;
    }
    return !!fallback;
  };

  const normalizeInt = (v, fallback) => {
    if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
    if (typeof v === "string") {
      const s = v.trim();
      if (!s) return fallback;
      const n = Number(s);
      if (Number.isFinite(n)) return Math.trunc(n);
    }
    return fallback;
  };

  const normalizeEnum = (v, allowed, fallback) => {
    const s = toLower(trim(v));
    return allowed.includes(s) ? s : fallback;
  };

  const normalizeStringArray = (v) => {
    if (!Array.isArray(v)) return [];
    return v
      .map((x) => (typeof x === "string" ? x : String(x ?? "")))
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
  };

  const normalizePortArray = (v) => {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const x of v) {
      const n = normalizeInt(x, NaN);
      if (!Number.isFinite(n)) continue;
      if (n <= 0 || n > 65535) continue;
      out.push(n);
    }
    return out;
  };

  // -------------------------
  // Validators（尽量对齐后端语义）
  // -------------------------
  const isValidIPv4 = (ip) => {
    const s = trim(ip);
    const parts = s.split(".");
    if (parts.length !== 4) return false;
    for (const p of parts) {
      if (!p.length || p.length > 3) return false;
      if (!/^[0-9]+$/.test(p)) return false;
      const n = Number(p);
      if (!Number.isInteger(n) || n < 0 || n > 255) return false;
    }
    return true;
  };

  // IPv6 校验：支持 :: 压缩、v4-embedded
  const isValidIPv6 = (ip) => {
    const s0 = trim(ip);
    if (!s0) return false;
    // 去掉 zone id（如 fe80::1%eth0）
    const s = s0.split("%")[0];
    if (!s) return false;
    if (s.includes(":::")) return false;

    const hasDc = s.includes("::");
    if (hasDc && s.indexOf("::") !== s.lastIndexOf("::")) return false;

    const splitSide = (side) => (side ? side.split(":") : []);
    const [leftStr, rightStr] = hasDc ? s.split("::") : [s, ""];
    const left = splitSide(leftStr);
    const right = splitSide(rightStr);

    const parseWord = (w) => /^[0-9a-fA-F]{1,4}$/.test(w);
    const isV4Token = (t) => t.includes(".");
    const countWords = (arr) => {
      let c = 0;
      for (let i = 0; i < arr.length; i++) {
        const token = arr[i];
        if (!token) return { ok: false, words: 0 };
        if (isV4Token(token)) {
          // v4 embedded 必须是最后一个 token
          if (i !== arr.length - 1) return { ok: false, words: 0 };
          if (!isValidIPv4(token)) return { ok: false, words: 0 };
          c += 2;
        } else {
          if (!parseWord(token)) return { ok: false, words: 0 };
          c += 1;
        }
      }
      return { ok: true, words: c };
    };

    const cl = countWords(left);
    if (!cl.ok) return false;
    const cr = countWords(right);
    if (!cr.ok) return false;

    if (hasDc) {
      // :: 至少压缩 1 段
      return cl.words + cr.words < 8;
    }
    return cl.words === 8;
  };

  const parseCidr = (cidr, family) => {
    const s = trim(cidr);
    const idx = s.indexOf("/");
    if (idx <= 0) return { ok: false, reason: "缺少 / 前缀长度" };
    const ip = s.slice(0, idx).trim();
    const bitsStr = s.slice(idx + 1).trim();
    if (!bitsStr || !/^[0-9]+$/.test(bitsStr)) return { ok: false, reason: "前缀长度非法" };
    const bits = Number(bitsStr);
    if (!Number.isInteger(bits)) return { ok: false, reason: "前缀长度非法" };

    if (family === 4) {
      if (bits < 0 || bits > 32) return { ok: false, reason: "IPv4 前缀需 0-32" };
      if (!isValidIPv4(ip)) return { ok: false, reason: "IPv4 地址非法" };
      return { ok: true };
    }
    if (family === 6) {
      if (bits < 0 || bits > 128) return { ok: false, reason: "IPv6 前缀需 0-128" };
      if (!isValidIPv6(ip)) return { ok: false, reason: "IPv6 地址非法" };
      return { ok: true };
    }
    return { ok: false, reason: "unknown family" };
  };

  const parsePortRange = (token) => {
    const t = String(token ?? "").replace(/\s+/g, "");
    if (!t) return { ok: false, reason: "为空" };
    const dash = t.indexOf("-");
    const parsePort = (s) => {
      if (!/^[0-9]+$/.test(s)) return null;
      const n = Number(s);
      if (!Number.isInteger(n) || n < 1 || n > 65535) return null; // UI 端严格 1-65535
      return n;
    };
    if (dash < 0) {
      const p = parsePort(t);
      return p == null ? { ok: false, reason: "端口需 1-65535" } : { ok: true, start: p, end: p };
    }
    const a = t.slice(0, dash);
    const b = t.slice(dash + 1);
    if (!a || !b) return { ok: false, reason: "范围格式非法" };
    const pa = parsePort(a);
    const pb = parsePort(b);
    if (pa == null || pb == null) return { ok: false, reason: "端口需 1-65535" };
    return { ok: true, start: Math.min(pa, pb), end: Math.max(pa, pb) };
  };

  // -------------------------
  // 枚举取值（UI 下拉与校验共用，避免多处硬编码）
  // -------------------------
  const ENUMS = Object.freeze({
    log_level: ["debug", "info", "warn", "error"],
    "proxy.type": ["socks5", "http"],
    "proxy_rules.dns_mode": ["direct", "proxy"],
    "proxy_rules.ipv6_mode": ["proxy", "direct", "block"],
    "proxy_rules.udp_mode": ["auto", "block", "direct", "proxy"],
    "proxy_rules.udp_fallback": ["block", "direct"],
    child_injection_mode: ["filtered", "inherit"],
    "proxy_rules.routing.priority_mode": ["order", "number"],
    "proxy_rules.routing.default_action": ["proxy", "direct"],
    "rule.action": ["proxy", "direct"],
  });

  // -------------------------
  // Defaults（对齐 build.ps1 生成的 config.json 结构）
  // -------------------------
  const DEFAULT_VERSION = "1.7";

  const defaultForm = (version) => ({
    _comment: "Antigravity-Proxy 配置文件",
    _version: typeof version === "string" && version ? version : DEFAULT_VERSION,
    _build: {
      date: formatNow(),
      config: "Release",
      arch: "x64",
    },
    log_level: "info",
    proxy: { host: "127.0.0.1", port: 7890, type: "socks5", username: "", password: "" },
    fake_ip: { enabled: true, cidr: "198.18.0.0/15" },
    timeout: { connect: 5000, send: 5000, recv: 5000 },
    updates: {
      enabled: false,
      check_delay_ms: 15000,
      timeout_ms: 5000,
      notify_once: true,
      allow_insecure_mirrors: true,
      mirrors: [
        "https://wget.la/",
        "https://rapidgit.jjda.de5.net/",
        "https://fastgit.cc/",
        "https://gitproxy.mrhjx.cn/",
        "https://github.boki.moe/",
        "https://github.ednovas.xyz/",
      ],
    },
    traffic_logging: false,
    diagnostics: {
      agent_ip_probe: false,
    },
    child_injection: true,
    child_injection_mode: "filtered",
    child_injection_exclude: [],
    target_processes: ["agy.exe", "language_server.exe", "language_server_windows", "Antigravity.exe", "Antigravity IDE.exe", "node.exe"],
    proxy_rules: {
      allowed_ports: [80, 443],
      dns_mode: "direct",
      ipv6_mode: "proxy",
      udp_mode: "auto",
      udp_fallback: "block",
      routing: {
        enabled: true,
        priority_mode: "order",
        default_action: "proxy",
        use_default_private: true,
        rules: [],
      },
    },
  });

  const newRuleId = () => {
    const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
    return c && typeof c.randomUUID === "function"
      ? c.randomUUID()
      : `rule_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  };

  const defaultRoutingRule = (idx = 0) => ({
    __ui_id: newRuleId(),
    name: `rule-${idx + 1}`,
    enabled: true,
    action: "proxy",
    priority: 0,
    ip_cidrs_v4: [],
    ip_cidrs_v6: [],
    domains: [],
    ports: [],
    protocols: ["tcp"],
  });

  // -------------------------
  // Normalize（对齐后端：统一小写 + 枚举回退）
  // -------------------------
  const normalizeLogLevel = (v) => {
    const s = toLower(trim(v));
    if (!s) return "info";
    if (["debug", "d", "trace", "verbose", "调试"].includes(s)) return "debug";
    if (["info", "i", "信息"].includes(s)) return "info";
    if (["warn", "warning", "w", "警告"].includes(s)) return "warn";
    if (["error", "err", "e", "错误"].includes(s)) return "error";
    return "info";
  };

  const normalizeForm = (raw, version) => {
    const base = defaultForm(version);
    const j = raw && typeof raw === "object" ? raw : {};
    const out = deepClone(base);

    // meta
    out._comment = typeof j._comment === "string" ? j._comment : base._comment;
    out._version = typeof j._version === "string" ? j._version : base._version;
    out._build = (j._build && typeof j._build === "object") ? { ...base._build, ...j._build } : base._build;
    out._build.date = typeof out._build.date === "string" && trim(out._build.date) ? out._build.date : formatNow();
    out._build.config = ["Release", "Debug"].includes(String(out._build.config)) ? String(out._build.config) : base._build.config;
    out._build.arch = ["x64", "x86"].includes(String(out._build.arch)) ? String(out._build.arch) : base._build.arch;

    // log_level：仅当导入 JSON 明确提供该字段时才覆盖默认值（默认模板需对齐 build.ps1）
    if (Object.prototype.hasOwnProperty.call(j, "log_level")) {
      out.log_level = normalizeLogLevel(j.log_level);
    }

    // proxy
    const p = j.proxy && typeof j.proxy === "object" ? j.proxy : {};
    out.proxy.host = trim(typeof p.host === "string" ? p.host : base.proxy.host) || base.proxy.host;
    out.proxy.type = normalizeEnum(p.type, ["socks5", "http"], base.proxy.type);
    {
      const port = normalizeInt(p.port, base.proxy.port);
      // 对齐后端：允许 0（禁用代理）；<0 或 >65535 回退 7890
      out.proxy.port = port < 0 || port > 65535 ? base.proxy.port : port;
    }
    out.proxy.username = typeof p.username === "string" ? p.username : (typeof p.user === "string" ? p.user : "");
    out.proxy.password = typeof p.password === "string" ? p.password : (typeof p.pass === "string" ? p.pass : "");

    // fake_ip
    const fip = j.fake_ip && typeof j.fake_ip === "object" ? j.fake_ip : {};
    out.fake_ip.enabled = normalizeBool(fip.enabled, base.fake_ip.enabled);
    out.fake_ip.cidr = trim(typeof fip.cidr === "string" ? fip.cidr : base.fake_ip.cidr) || base.fake_ip.cidr;

    // timeout
    const t = j.timeout && typeof j.timeout === "object" ? j.timeout : {};
    out.timeout.connect = normalizeInt(t.connect, base.timeout.connect);
    out.timeout.send = normalizeInt(t.send, base.timeout.send);
    out.timeout.recv = normalizeInt(t.recv, base.timeout.recv);
    if (out.timeout.connect <= 0) out.timeout.connect = base.timeout.connect;
    if (out.timeout.send <= 0) out.timeout.send = base.timeout.send;
    if (out.timeout.recv <= 0) out.timeout.recv = base.timeout.recv;

    // updates
    const upd = j.updates && typeof j.updates === "object" ? j.updates : {};
    out.updates.enabled = normalizeBool(upd.enabled, base.updates.enabled);
    out.updates.check_delay_ms = normalizeInt(upd.check_delay_ms, base.updates.check_delay_ms);
    out.updates.timeout_ms = normalizeInt(upd.timeout_ms, base.updates.timeout_ms);
    out.updates.notify_once = normalizeBool(upd.notify_once, base.updates.notify_once);
    out.updates.allow_insecure_mirrors = normalizeBool(upd.allow_insecure_mirrors, base.updates.allow_insecure_mirrors);
    out.updates.mirrors = Array.isArray(upd.mirrors)
      ? normalizeStringArray(upd.mirrors)
      : deepClone(base.updates.mirrors);
    if (out.updates.check_delay_ms < 0) out.updates.check_delay_ms = base.updates.check_delay_ms;
    if (out.updates.timeout_ms <= 0) out.updates.timeout_ms = base.updates.timeout_ms;

    // phase2/3
    out.traffic_logging = normalizeBool(j.traffic_logging, base.traffic_logging);
    const diagnostics = j.diagnostics && typeof j.diagnostics === "object" ? j.diagnostics : {};
    out.diagnostics.agent_ip_probe = normalizeBool(diagnostics.agent_ip_probe, base.diagnostics.agent_ip_probe);
    out.child_injection = normalizeBool(j.child_injection, base.child_injection);
    out.child_injection_mode = normalizeEnum(j.child_injection_mode, ["filtered", "inherit"], base.child_injection_mode);
    out.child_injection_exclude = Array.isArray(j.child_injection_exclude)
      ? normalizeStringArray(j.child_injection_exclude)
      : deepClone(base.child_injection_exclude);
    out.target_processes = Array.isArray(j.target_processes)
      ? normalizeStringArray(j.target_processes)
      : deepClone(base.target_processes);

    // proxy_rules
    const pr = j.proxy_rules && typeof j.proxy_rules === "object" ? j.proxy_rules : {};
    out.proxy_rules.allowed_ports = Array.isArray(pr.allowed_ports)
      ? normalizePortArray(pr.allowed_ports)
      : deepClone(base.proxy_rules.allowed_ports);
    out.proxy_rules.dns_mode = normalizeEnum(pr.dns_mode, ["direct", "proxy"], base.proxy_rules.dns_mode);
    out.proxy_rules.ipv6_mode = normalizeEnum(pr.ipv6_mode, ["proxy", "direct", "block"], base.proxy_rules.ipv6_mode);
    out.proxy_rules.udp_mode = normalizeEnum(pr.udp_mode, ["auto", "block", "direct", "proxy"], base.proxy_rules.udp_mode);
    out.proxy_rules.udp_fallback = normalizeEnum(pr.udp_fallback, ["block", "direct"], base.proxy_rules.udp_fallback);

    const rt = pr.routing && typeof pr.routing === "object" ? pr.routing : {};
    out.proxy_rules.routing.enabled = normalizeBool(rt.enabled, base.proxy_rules.routing.enabled);
    out.proxy_rules.routing.priority_mode = normalizeEnum(rt.priority_mode, ["order", "number"], base.proxy_rules.routing.priority_mode);
    out.proxy_rules.routing.default_action = normalizeEnum(rt.default_action, ["proxy", "direct"], base.proxy_rules.routing.default_action);
    out.proxy_rules.routing.use_default_private = normalizeBool(rt.use_default_private, base.proxy_rules.routing.use_default_private);
    const rulesIn = Array.isArray(rt.rules) ? rt.rules : base.proxy_rules.routing.rules;
    out.proxy_rules.routing.rules = rulesIn.map((r, idx) => {
      const rr = (r && typeof r === "object") ? r : {};
      const rule = { ...defaultRoutingRule(idx), ...rr };
      rule.name = trim(rule.name) || `rule-${idx + 1}`;
      rule.enabled = normalizeBool(rule.enabled, true);
      rule.action = normalizeEnum(rule.action, ["proxy", "direct"], out.proxy_rules.routing.default_action);
      rule.priority = normalizeInt(rule.priority, 0);
      rule.ip_cidrs_v4 = normalizeStringArray(rule.ip_cidrs_v4);
      rule.ip_cidrs_v6 = normalizeStringArray(rule.ip_cidrs_v6);
      rule.domains = normalizeStringArray(rule.domains);
      rule.ports = normalizeStringArray(rule.ports);
      rule.protocols = normalizeStringArray(rule.protocols);
      return rule;
    });

    return out;
  };

  // -------------------------
  // Export（保留未知字段：对象级覆盖已知字段）
  // -------------------------
  const ensureObjIn = (obj, key) => {
    if (!obj || typeof obj !== "object") return {};
    if (!obj[key] || typeof obj[key] !== "object" || Array.isArray(obj[key])) obj[key] = {};
    return obj[key];
  };

  const exportObject = (form, baseRaw, version) => {
    const out = deepClone(baseRaw || {});

    // top-level meta
    out._comment = String(form._comment ?? "Antigravity-Proxy 配置文件");
    out._version = String(form._version ?? (version || DEFAULT_VERSION));
    const outBuild = ensureObjIn(out, "_build");
    outBuild.date = String(form?._build?.date ?? formatNow());
    outBuild.config = String(form?._build?.config ?? "Release");
    outBuild.arch = String(form?._build?.arch ?? "x64");

    // scalar
    out.log_level = form.log_level;
    out.traffic_logging = !!form.traffic_logging;
    const outDiagnostics = ensureObjIn(out, "diagnostics");
    outDiagnostics.agent_ip_probe = !!form.diagnostics.agent_ip_probe;
    out.child_injection = !!form.child_injection;
    out.child_injection_mode = form.child_injection_mode;
    out.child_injection_exclude = deepClone(form.child_injection_exclude);
    out.target_processes = deepClone(form.target_processes);

    // proxy
    const outProxy = ensureObjIn(out, "proxy");
    outProxy.host = form.proxy.host;
    outProxy.port = form.proxy.port;
    outProxy.type = form.proxy.type;
    outProxy.username = form.proxy.username ?? "";
    outProxy.password = form.proxy.password ?? "";

    // fake_ip
    const outFakeIp = ensureObjIn(out, "fake_ip");
    outFakeIp.enabled = !!form.fake_ip.enabled;
    outFakeIp.cidr = form.fake_ip.cidr;

    // timeout
    const outTimeout = ensureObjIn(out, "timeout");
    outTimeout.connect = form.timeout.connect;
    outTimeout.send = form.timeout.send;
    outTimeout.recv = form.timeout.recv;

    // updates
    const outUpdates = ensureObjIn(out, "updates");
    outUpdates.enabled = !!form.updates.enabled;
    outUpdates.check_delay_ms = form.updates.check_delay_ms;
    outUpdates.timeout_ms = form.updates.timeout_ms;
    outUpdates.notify_once = !!form.updates.notify_once;
    outUpdates.allow_insecure_mirrors = !!form.updates.allow_insecure_mirrors;
    outUpdates.mirrors = deepClone(form.updates.mirrors);

    // proxy_rules
    const outPr = ensureObjIn(out, "proxy_rules");
    outPr.allowed_ports = deepClone(form.proxy_rules.allowed_ports);
    outPr.dns_mode = form.proxy_rules.dns_mode;
    outPr.ipv6_mode = form.proxy_rules.ipv6_mode;
    outPr.udp_mode = form.proxy_rules.udp_mode;
    outPr.udp_fallback = form.proxy_rules.udp_fallback;

    const outRt = ensureObjIn(outPr, "routing");
    outRt.enabled = !!form.proxy_rules.routing.enabled;
    outRt.priority_mode = form.proxy_rules.routing.priority_mode;
    outRt.default_action = form.proxy_rules.routing.default_action;
    outRt.use_default_private = !!form.proxy_rules.routing.use_default_private;
    outRt.rules = (form.proxy_rules.routing.rules || []).map((r) => {
      const rr = deepClone(r || {});
      delete rr.__ui_id;
      return rr;
    });

    return out;
  };

  // -------------------------
  // Validation（返回 { errors, warnings }，键为字段路径）
  // 注意：config-web 的结构漂移自检会扫描本函数源码中的字段标记，新增字段时请同步补充校验。
  // -------------------------
  const validateForm = (form) => {
    const errors = {};
    const warnings = {};

    const err = (path, msg) => {
      errors[path] = msg;
    };
    const warn = (path, msg) => {
      warnings[path] = msg;
    };

    // meta
    if (!trim(form._comment)) warn("_comment", "_comment 为空（不影响功能，但建议保留说明）");
    if (!trim(form._version)) warn("_version", "_version 为空（建议填写版本号，便于追踪）");
    if (!trim(form?._build?.date)) warn("_build.date", "_build.date 为空（建议刷新）");
    if (!["Release", "Debug"].includes(String(form?._build?.config || ""))) {
      err("_build.config", "_build.config 必须为 Release/Debug");
    }
    if (!["x64", "x86"].includes(String(form?._build?.arch || ""))) {
      err("_build.arch", "_build.arch 必须为 x64/x86");
    }

    // log_level
    if (!["debug", "info", "warn", "error"].includes(form.log_level)) {
      err("log_level", "log_level 必须为 debug/info/warn/error");
    }

    // proxy
    if (!trim(form.proxy.host)) err("proxy.host", "proxy.host 不能为空");
    const pp = form.proxy.port;
    if (!Number.isInteger(pp) || pp < 0 || pp > 65535) err("proxy.port", "proxy.port 必须为 0-65535 的整数");
    if (Number.isInteger(pp) && pp === 0) warn("proxy.port", "proxy.port=0 将禁用代理（全部直连）");
    if (!["socks5", "http"].includes(form.proxy.type)) err("proxy.type", "proxy.type 必须为 socks5/http");

    // fake ip
    if (typeof form.fake_ip.enabled !== "boolean") err("fake_ip.enabled", "必须为布尔值");
    const cidr = trim(form.fake_ip.cidr);
    if (!cidr) err("fake_ip.cidr", "fake_ip.cidr 不能为空");
    else {
      const rc = parseCidr(cidr, 4);
      if (!rc.ok) err("fake_ip.cidr", `CIDR 格式错误：${rc.reason}`);
    }

    // timeout
    for (const k of ["connect", "send", "recv"]) {
      const v = form.timeout[k];
      if (!Number.isInteger(v) || v <= 0) err(`timeout.${k}`, "必须为正整数（毫秒）");
    }

    // updates
    if (typeof form.updates.enabled !== "boolean") err("updates.enabled", "必须为布尔值");
    if (typeof form.updates.notify_once !== "boolean") err("updates.notify_once", "必须为布尔值");
    if (typeof form.updates.allow_insecure_mirrors !== "boolean") err("updates.allow_insecure_mirrors", "必须为布尔值");
    if (!Number.isInteger(form.updates.check_delay_ms) || form.updates.check_delay_ms < 0) {
      err("updates.check_delay_ms", "必须为 0 或正整数（毫秒）");
    }
    if (!Number.isInteger(form.updates.timeout_ms) || form.updates.timeout_ms <= 0) {
      err("updates.timeout_ms", "必须为正整数（毫秒）");
    }
    (form.updates.mirrors || []).forEach((s, i) => {
      const v = trim(s);
      if (!v) err(`updates.mirrors[${i}]`, "代理站不能为空");
      if (v && !/^https:\/\//i.test(v)) err(`updates.mirrors[${i}]`, "代理站必须使用 https://");
    });

    // phase2/3 scalar
    if (typeof form.traffic_logging !== "boolean") err("traffic_logging", "必须为布尔值");
    if (typeof form.diagnostics.agent_ip_probe !== "boolean") {
      err("diagnostics.agent_ip_probe", "必须为布尔值");
    }
    if (typeof form.child_injection !== "boolean") err("child_injection", "必须为布尔值");

    // child injection mode
    if (!["filtered", "inherit"].includes(form.child_injection_mode)) {
      err("child_injection_mode", "必须为 filtered/inherit");
    }

    // arrays (top-level)
    form.child_injection_exclude.forEach((s, i) => {
      if (!trim(s)) err(`child_injection_exclude[${i}]`, "不能为空");
    });
    form.target_processes.forEach((s, i) => {
      if (!trim(s)) err(`target_processes[${i}]`, "不能为空");
    });

    // proxy_rules.allowed_ports
    const seenPorts = new Set();
    form.proxy_rules.allowed_ports.forEach((p, i) => {
      if (!Number.isInteger(p) || p < 1 || p > 65535) err(`proxy_rules.allowed_ports[${i}]`, "端口必须 1-65535");
      if (p === 0) err(`proxy_rules.allowed_ports[${i}]`, "端口不能为 0");
      const key = String(p);
      if (seenPorts.has(key)) warn(`proxy_rules.allowed_ports[${i}]`, "重复端口（后端会排序去重）");
      seenPorts.add(key);
    });

    // enums
    if (!["direct", "proxy"].includes(form.proxy_rules.dns_mode)) err("proxy_rules.dns_mode", "必须为 direct/proxy");
    if (!["proxy", "direct", "block"].includes(form.proxy_rules.ipv6_mode)) err("proxy_rules.ipv6_mode", "必须为 proxy/direct/block");
    if (!["auto", "block", "direct", "proxy"].includes(form.proxy_rules.udp_mode)) err("proxy_rules.udp_mode", "必须为 auto/block/direct/proxy");
    if (!["block", "direct"].includes(form.proxy_rules.udp_fallback)) err("proxy_rules.udp_fallback", "必须为 block/direct");
    if (!["auto", "proxy"].includes(form.proxy_rules.udp_mode) && form.proxy_rules.udp_fallback !== "block") {
      warn("proxy_rules.udp_fallback", "仅 udp_mode=auto/proxy 时生效；当前该设置不会生效");
    }
    if (form.proxy_rules.udp_mode === "auto" && form.proxy.type !== "socks5") {
      warn("proxy_rules.udp_mode", `auto 在 HTTP 代理下会按 udp_fallback=${form.proxy_rules.udp_fallback} 处理`);
    }
    if (form.proxy_rules.udp_mode === "proxy" && form.proxy.type !== "socks5") {
      warn("proxy_rules.udp_mode", "proxy 模式依赖 SOCKS5 UDP Associate；当前代理类型不匹配");
    }

    // routing bools
    if (typeof form.proxy_rules.routing.enabled !== "boolean") err("proxy_rules.routing.enabled", "必须为布尔值");
    if (typeof form.proxy_rules.routing.use_default_private !== "boolean") err("proxy_rules.routing.use_default_private", "必须为布尔值");

    // routing enums
    if (!["order", "number"].includes(form.proxy_rules.routing.priority_mode)) err("proxy_rules.routing.priority_mode", "必须为 order/number");
    if (!["proxy", "direct"].includes(form.proxy_rules.routing.default_action)) err("proxy_rules.routing.default_action", "必须为 proxy/direct");

    // routing rules
    const rules = form.proxy_rules.routing.rules || [];
    rules.forEach((r, idx) => {
      const prefix = `proxy_rules.routing.rules[${idx}]`;
      if (!trim(r.name)) err(`${prefix}.name`, "name 不能为空");
      if (typeof r.enabled !== "boolean") err(`${prefix}.enabled`, "enabled 必须为布尔值");
      if (!["proxy", "direct"].includes(toLower(r.action))) err(`${prefix}.action`, "action 必须为 proxy/direct");
      if (!Number.isInteger(r.priority)) warn(`${prefix}.priority`, "priority 建议为整数");

      // matchable conditions
      if (!r.domains?.length && !r.ip_cidrs_v4?.length && !r.ip_cidrs_v6?.length) {
        warn(prefix, "该规则没有 domains/CIDR 条件，可能永远无法命中");
      }

      (r.ip_cidrs_v4 || []).forEach((c, i) => {
        const rc = parseCidr(c, 4);
        if (!rc.ok) err(`${prefix}.ip_cidrs_v4[${i}]`, `IPv4 CIDR 无效：${rc.reason}`);
      });
      (r.ip_cidrs_v6 || []).forEach((c, i) => {
        const rc = parseCidr(c, 6);
        if (!rc.ok) err(`${prefix}.ip_cidrs_v6[${i}]`, `IPv6 CIDR 无效：${rc.reason}`);
      });
      (r.domains || []).forEach((d, i) => {
        if (!trim(d)) err(`${prefix}.domains[${i}]`, "域名不能为空");
      });
      (r.ports || []).forEach((p, i) => {
        const rc = parsePortRange(p);
        if (!rc.ok) err(`${prefix}.ports[${i}]`, `端口范围无效：${rc.reason}`);
      });
      (r.protocols || []).forEach((p, i) => {
        const s = toLower(trim(p));
        if (!s) err(`${prefix}.protocols[${i}]`, "协议不能为空");
        else if (s !== "tcp") warn(`${prefix}.protocols[${i}]`, "当前主要支持 tcp；其它值可能无法命中");
      });
    });

    return { errors, warnings };
  };

  // -------------------------
  // JSONC 容错解析：兼容注释、尾逗号与 UTF-8 BOM（用户手写或旧版导出可能带注释）
  // 先严格解析；失败时再做“字符串感知”的注释/尾逗号剥离，避免误伤字符串中的 // 与 /*。
  // -------------------------
  const stripJsonc = (text) => {
    let out = "";
    let i = 0;
    let inStr = false;
    while (i < text.length) {
      const ch = text[i];
      const next = text[i + 1];
      if (inStr) {
        out += ch;
        if (ch === "\\") {
          out += next ?? "";
          i += 2;
          continue;
        }
        if (ch === "\"") inStr = false;
        i++;
        continue;
      }
      if (ch === "\"") {
        inStr = true;
        out += ch;
        i++;
        continue;
      }
      if (ch === "/" && next === "/") {
        while (i < text.length && text[i] !== "\n") i++;
        continue;
      }
      if (ch === "/" && next === "*") {
        i += 2;
        while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
        i += 2;
        continue;
      }
      out += ch;
      i++;
    }
    // 去除对象/数组闭合前的尾逗号（此时已无注释，字符串内容不受影响的近似处理：仅匹配逗号后紧跟空白与 } ]）
    return out.replace(/,(\s*[}\]])/g, "$1");
  };

  const parseJsonc = (text) => {
    const src = String(text ?? "").replace(/^﻿/, "");
    try {
      return JSON.parse(src);
    } catch (strictErr) {
      try {
        return JSON.parse(stripJsonc(src));
      } catch (_) {
        throw strictErr;
      }
    }
  };

  return Object.freeze({
    // utils
    deepClone,
    formatNow,
    trim,
    toLower,
    getPath,
    setPath,
    normalizeBool,
    normalizeInt,
    normalizeEnum,
    normalizeStringArray,
    normalizePortArray,
    // validators
    isValidIPv4,
    isValidIPv6,
    parseCidr,
    parsePortRange,
    // schema
    ENUMS,
    DEFAULT_VERSION,
    defaultForm,
    defaultRoutingRule,
    normalizeLogLevel,
    normalizeForm,
    exportObject,
    validateForm,
    // io helpers
    parseJsonc,
  });
});
