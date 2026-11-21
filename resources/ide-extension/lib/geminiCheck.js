// @ts-check
"use strict";

/**
 * Gemini / Antigravity 可用性检测（单一职责：发出少量只读探测 + 汇总成可解释的结论）。
 *
 * 为什么不能只测"端口通不通"：
 * - Google 对 Gemini API 与 Antigravity 都按「出口 IP 的实时地理位置/网络类型」判定，
 *   机房/托管出口即使 TCP 能连也会返回 FAILED_PRECONDITION: User location is not supported；
 * - 而 Antigravity agent 链路还有独立的资格门（daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist
 *   返回 403 PERMISSION_DENIED / UNSUPPORTED_LOCATION / error_number 1008），它与 Gemini API 是否可用
 *   并不等价（官方论坛案例：Gemini API 正常但 Antigravity 被拒）。
 *
 * 因此结论拆成三层，UI 必须分开展示，不能用一个对勾概括：
 *   network        —— 经代理能否到达 Google（gstatic 204）
 *   geminiApi      —— Gemini API 的区域闸门（用无效 key 探测，错误信息可区分"地区不支持"与"key 无效"）
 *   antigravity    —— 账号能否真正登录/使用 Antigravity：
 *                     ① 优先读 agy（IDE 2.6+ 后端）自己的登录日志 ~/.gemini/antigravity/log/cli-*.log，
 *                        它记录了 Google 对「这个账号」的资格判定（failure_kind=ineligible / valid=true）；
 *                     ② 没有 agy 日志时（旧版 IDE）才回退到 IDE 日志目录里的 location 命中 / 登录标记。
 *
 * 顶部总结论必须"两层都确认可用"才显示可用：匿名 API 放行 ≠ 账号能登录 Antigravity
 * （2026-11-21 实测：Gemini API 探测放行，但 agy 登录被 Google 以 ineligible 拒绝）。
 *
 * 日志证据可能来自旧会话，所以 UI 同时展示命中时间，避免把历史问题当成当前故障。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { request, describeNetworkError } = require("./httpClient");
const I18n = require("../media/i18n");

const DEFAULT_TIMEOUT_MS = 8000;
const REACH_URL = "https://www.gstatic.com/generate_204";
/** 故意使用无效 key：地区受限时 Google 先返回 location 错误，地区放行时返回 key 无效 —— 两者都是可判定的信号 */
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models?key=AGP_PROBE_INVALID_KEY";
const LOAD_CODE_ASSIST_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const DEFAULT_LOG_MAX_BYTES = 256 * 1024;

/** Antigravity 日志里代表"地区不支持"的标记（大小写不敏感） */
const LOCATION_MARKERS = Object.freeze([
  /User location is not supported/i,
  /UNSUPPORTED_LOCATION/i,
  /not currently available in your location/i,
  /error_number\D{0,8}1008/i,
]);
/** Gemini API 的 "key 无效" 标记：能走到校验 key 这一步，说明地区闸门已放行 */
const API_KEY_MARKERS = Object.freeze([
  /API key not valid/i,
  /API_KEY_INVALID/i,
  /invalid API key/i,
]);
/** loadCodeAssist 的错误码标记（与论坛实测 403 UNSUPPORTED_LOCATION / error_number 1008 对齐） */
const DENIED_LOCATION_MARKERS = Object.freeze([
  /UNSUPPORTED_LOCATION/i,
  /not currently available in your location/i,
  /error_number\D{0,8}1008/i,
]);
/**
 * Antigravity 已登录/已拿到项目 ID 的强证据（来自 IDE 自己的日志，不是我们的匿名探测）：
 * - CredentialStorage: ProjectId updated for <email>
 * - CloudCode:AuthorizedQuota / Authorized quota source active（带 OAuth token 的配额检查）
 * - Access token updated/refreshed
 * 注意：不把裸 "POST loadCodeAssist" 当作证据，避免把匿名/失败请求误判为已登录。
 */
const SESSION_LOGIN_MARKERS = Object.freeze([
  /ProjectId updated for /i,
  /\[CloudCode:AuthorizedQuota\][^\r\n]*loadCodeAssist/i,
  /Authorized quota source active/i,
  /Access token (?:updated|refreshed)/i,
  /Synced .+ to legacy key/i,
]);

/** agy 登录日志：~/.gemini/antigravity/log/cli-YYYYMMDD_HHMMSS.log（多个 agy 实例各写一个文件） */
const AGY_LOG_FILE_RE = /^cli-(\d{4})(\d{2})\d{2}_\d{6}\.log$/i;
/** 只看最近几个 agy 日志文件：足以覆盖"上一次登录成功"到"现在"，又不会每次扫上百个历史文件 */
const AGY_LOG_MAX_FILES = 6;
/** glog 行首时间戳：I1121 14:31:38.583275（无年份，年份取自文件名） */
const GLOG_TIME_RE = /^[IWEF](\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?/;
/**
 * agy 对"账号资格被拒"的结论（认证级标记，2026-11-21 实测）：
 * - [auth-login] ... failure_kind=ineligible ... outcome=error
 * - [auth-status] ... reason=ineligible rpc=get_auth_status valid=false
 * 注意：刻意不使用 LOCATION_NOT_ELIGIBLE / error_number 1008。它们来自 "AICode FetchConfig failed"，
 * 这是实验配置拉取接口，在登录正常、可用的会话里也会每分钟出现一次（11-13～11-20 的日志均如此），
 * 当作"被拒"会把正常会话误报为受限。
 */
const AGY_INELIGIBLE_MARKERS = Object.freeze([
  /failure_kind=ineligible\b/i,
  /\breason=ineligible\b/i,
]);
/** agy 确认登录有效：[auth-status] rpc=get_auth_status valid=true（has_token=true 不算，令牌存在也可能资格被拒） */
const AGY_SIGNED_IN_MARKERS = Object.freeze([
  /rpc=get_auth_status valid=true\b/i,
]);
/** agy 未登录：没有令牌 / 明确提示未登录 */
const AGY_SIGNED_OUT_MARKERS = Object.freeze([
  /has_token=false\b/i,
  /You are not logged into Antigravity/i,
]);
/** Google 在错误响应里给出的检测地区（Detected location: CN / "detected_location": "CN"），仅作为附加诊断信息 */
const DETECTED_LOCATION_RE = /Detected location:\s*([A-Z]{2})\b|detected_location\W{0,8}([A-Z]{2})\b/;
/**
 * 检测地区的"近期"时间窗：出口 IP 有问题时 agy 每分钟都会收到一次带 Detected location 的 403，
 * 30 分钟足以覆盖；又能排除几小时前的旧记录（2026-11-21 实测：14:36 的 CN 不应算到 17:58 那次被拒上）。
 */
const LOCATION_RECENT_WINDOW_MS = 30 * 60 * 1000;

const DEFAULT_T = I18n.createT("zh-cn");

/** @param {RegExp[]} patterns @param {string} text */
function matchesAny(patterns, text) {
  return patterns.some((re) => re.test(text));
}

/**
 * Gemini API 响应分类（纯函数）。
 * @param {number} status
 * @param {string} text
 * @returns {{ state: "ok" | "blocked" | "inconclusive", reason: string }}
 */
function classifyGeminiApi(status, text) {
  const body = String(text ?? "");
  if (matchesAny(LOCATION_MARKERS, body)) return { state: "blocked", reason: "location" };
  if (matchesAny(API_KEY_MARKERS, body)) return { state: "ok", reason: "region-ok" };
  if (status === 200) return { state: "ok", reason: "http-200" };
  return { state: "inconclusive", reason: `http-${status}` };
}

/**
 * loadCodeAssist 响应分类（纯函数）：只有明确命中 location 标记才判 blocked，401/其它一律"无法判定"。
 * @param {number} status
 * @param {string} text
 * @returns {{ state: "ok" | "blocked" | "inconclusive", reason: string }}
 */
function classifyLoadCodeAssist(status, text) {
  const body = String(text ?? "");
  if (matchesAny(DENIED_LOCATION_MARKERS, body)) return { state: "blocked", reason: "unsupported-location" };
  if (status === 200) return { state: "ok", reason: "http-200" };
  if (status === 401) return { state: "inconclusive", reason: "auth-required" };
  return { state: "inconclusive", reason: `http-${status}` };
}

/**
 * 读取文件尾部若干字节（日志可能很大，只关心最近内容）。
 * @param {string} filePath
 * @param {number} maxBytes
 */
function readTailText(filePath, maxBytes) {
  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    if (length > 0) fs.readSync(fd, buffer, 0, length, start);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 扫描一个日志文件：同时找"地区不支持"和"已登录/已拿到 ProjectId"的最后一次命中。
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {{ available: boolean, matched: boolean, line: string, loggedIn: boolean, loginLine: string }}
 */
function scanLogFileForEvidence(filePath, maxBytes = DEFAULT_LOG_MAX_BYTES) {
  try {
    const text = readTailText(filePath, maxBytes);
    const lines = text.split(/\r?\n/);
    /** @type {string} */
    let matchedLine = "";
    /** @type {string} */
    let loginLine = "";
    for (let i = lines.length - 1; i >= 0 && (!matchedLine || !loginLine); i--) {
      const line = lines[i];
      if (!matchedLine && matchesAny(LOCATION_MARKERS, line)) matchedLine = line.trim();
      if (!loginLine && matchesAny(SESSION_LOGIN_MARKERS, line)) loginLine = line.trim();
    }
    return { available: true, matched: !!matchedLine, line: matchedLine, loggedIn: !!loginLine, loginLine };
  } catch {
    return { available: false, matched: false, line: "", loggedIn: false, loginLine: "" };
  }
}

/**
 * 兼容旧接口：只关心 location 命中。
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {{ available: boolean, matched: boolean, line: string }}
 */
function scanLogFileForLocation(filePath, maxBytes = DEFAULT_LOG_MAX_BYTES) {
  const e = scanLogFileForEvidence(filePath, maxBytes);
  return { available: e.available, matched: e.matched, line: e.line };
}

/**
 * 收集一个日志根目录下最近 3 个会话目录里的 .log 文件（限制深度/数量，避免遍历整个 exthost 输出）。
 * @param {string} root
 * @returns {{ path: string, mtimeMs: number }[]}
 */
function collectRecentLogFiles(root) {
  /** @type {{ path: string, mtimeMs: number }[]} */
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return out;
  }
  const recent = dirs
    .map((e) => {
      const p = path.join(root, e.name);
      try { return { path: p, mtimeMs: fs.statSync(p).mtimeMs }; } catch { return { path: p, mtimeMs: 0 }; }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 3);

  const walk = (dir, depth) => {
    if (depth > 4 || out.length >= 60) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= 60) return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (/^(node_modules|cache|CachedData)$/i.test(e.name)) continue;
        walk(p, depth + 1);
      } else if (/\.log$/i.test(e.name)) {
        try { out.push({ path: p, mtimeMs: fs.statSync(p).mtimeMs }); } catch { /* ignore */ }
      }
    }
  };
  for (const d of recent) walk(d.path, 0);
  return out;
}

/**
 * 找到最新的 Antigravity 会话日志，并区分：
 * - location 错误（被服务端拒绝）
 * - 已登录证据（ProjectId updated / AuthorizedQuota / token refreshed）
 *
 * 兼容两个日志根目录：
 * - %APPDATA%\Antigravity\logs（老版本/桌面版）
 * - %APPDATA%\Antigravity IDE\logs（当前 IDE；cloudcode.log、Antigravity Cockpit 输出都在这里）
 *
 * 只有当 location 命中不早于最近的登录证据时才判定为当前 blocked；
 * 否则旧会话里的历史错误不应盖过刚刚成功的登录。
 *
 * @param {{ appDataDir?: string, now?: number }} [opts]
 * @returns {{
 *   available: boolean, matched: boolean, path: string, line: string, mtimeMs: number,
 *   loggedIn: boolean, loginPath: string, loginLine: string, loginMtimeMs: number,
 *   locationPath: string, locationLine: string, locationMtimeMs: number, filesScanned: number
 * }}
 */
function findAntigravityLogEvidence(opts = {}) {
  const appData = opts.appDataDir || process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const roots = [
    path.join(appData, "Antigravity", "logs"),
    path.join(appData, "Antigravity IDE", "logs"),
  ];
  /** @type {{ path: string, mtimeMs: number }[]} */
  const files = [];
  for (const root of roots) files.push(...collectRecentLogFiles(root));
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const candidates = files.slice(0, 24);

  /** @type {{ path: string, line: string, mtimeMs: number } | null} */
  let location = null;
  /** @type {{ path: string, line: string, mtimeMs: number } | null} */
  let login = null;
  let available = false;
  for (const f of candidates) {
    const ev = scanLogFileForEvidence(f.path);
    if (!ev.available) continue;
    available = true;
    if (ev.matched && (!location || f.mtimeMs > location.mtimeMs)) {
      location = { path: f.path, line: ev.line, mtimeMs: f.mtimeMs };
    }
    if (ev.loggedIn && (!login || f.mtimeMs > login.mtimeMs)) {
      login = { path: f.path, line: ev.loginLine, mtimeMs: f.mtimeMs };
    }
  }

  // 旧日志里的历史 location 错误不能盖过更新的登录成功
  const matched = !!location && (!login || location.mtimeMs >= login.mtimeMs);
  return {
    available,
    matched,
    path: matched && location ? location.path : (login ? login.path : ""),
    line: matched && location ? location.line : (login ? login.line : ""),
    mtimeMs: matched && location ? location.mtimeMs : (login ? login.mtimeMs : 0),
    loggedIn: !!login,
    loginPath: login ? login.path : "",
    loginLine: login ? login.line : "",
    loginMtimeMs: login ? login.mtimeMs : 0,
    locationPath: location ? location.path : "",
    locationLine: location ? location.line : "",
    locationMtimeMs: location ? location.mtimeMs : 0,
    filesScanned: candidates.length,
  };
}

/**
 * 解析 glog 行首时间戳为本地时间毫秒；不是 glog 行返回 0。
 * glog 不带年份：取文件名里的年份，事件月份小于文件月份时视为跨年（12 月的会话写到 1 月）。
 * @param {string} line
 * @param {number} year 文件名中的年份
 * @param {number} fileMonth 文件名中的月份（1-12）
 */
function parseGlogTime(line, year, fileMonth) {
  const m = GLOG_TIME_RE.exec(line);
  if (!m) return 0;
  const month = Number(m[1]);
  const y = month < fileMonth ? year + 1 : year;
  const ms = Math.floor(Number((m[6] || "0").padEnd(6, "0")) / 1000);
  return new Date(y, month - 1, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), ms).getTime();
}

/** @param {string} line @returns {"blocked" | "signed-in" | "signed-out" | ""} */
function classifyAgyLine(line) {
  if (matchesAny(AGY_INELIGIBLE_MARKERS, line)) return "blocked";
  if (matchesAny(AGY_SIGNED_IN_MARKERS, line)) return "signed-in";
  if (matchesAny(AGY_SIGNED_OUT_MARKERS, line)) return "signed-out";
  return "";
}

/**
 * 读取 agy（~/.gemini/bin/agy.exe，IDE 2.6+ 后端）自己的登录日志，给出"账号能否登录 Antigravity"的结论。
 *
 * 为什么以它为准：登录是否成功、Google 是否判定账号不符合资格，只有 agy 自己知道；
 * 第三方扩展（如 Antigravity Cockpit）有独立的 OAuth 账号，它的日志不能代表 IDE 的登录状态。
 *
 * 判定规则（多个 agy 实例的日志按事件时间合并后）：
 * - 最近一次"资格被拒"不早于最近一次"登录有效" → blocked
 *   （被拒之后出现的大量"未登录"不会覆盖它：被拒本来就意味着登不进去）
 * - 否则最近一次"登录有效"不早于最近一次"未登录" → signed-in
 * - 否则出现过"未登录" → signed-out
 * - 一个认证事件都没有 → none（由调用方回退到旧的 IDE 日志逻辑）
 *
 * detectedLocation（Google 对 agy 真实流量给出的检测地区，用于区分 IP / 账号原因）：
 * - blocked：取"被拒前 30 分钟起"最近的一条——被拒时出口 IP 是否也有问题；
 * - signed-in：取"登录之后且最近 30 分钟内"最近的一条——已登录但仍有请求从受限地区出口（提前提醒）；
 * - 其余状态为空。
 *
 * @param {{ homeDir?: string, maxBytes?: number, now?: number }} [opts]
 * @returns {{
 *   available: boolean, state: "blocked" | "signed-in" | "signed-out" | "none",
 *   at: number, path: string, line: string, detectedLocation: string, filesScanned: number
 * }}
 */
function findAgyAuthEvidence(opts = {}) {
  const homeDir = opts.homeDir || os.homedir();
  const maxBytes = opts.maxBytes ?? DEFAULT_LOG_MAX_BYTES;
  const dir = path.join(homeDir, ".gemini", "antigravity", "log");
  /** @type {ReturnType<typeof findAgyAuthEvidence>} */
  const none = { available: false, state: "none", at: 0, path: "", line: "", detectedLocation: "", filesScanned: 0 };

  /** @type {string[]} */
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => AGY_LOG_FILE_RE.test(n));
  } catch {
    return none;
  }
  const files = names
    .map((name) => {
      const p = path.join(dir, name);
      try { return { name, path: p, mtimeMs: fs.statSync(p).mtimeMs }; } catch { return null; }
    })
    .filter((f) => f !== null)
    .sort((a, b) => /** @type {any} */ (b).mtimeMs - /** @type {any} */ (a).mtimeMs)
    .slice(0, AGY_LOG_MAX_FILES);

  /** @type {{ kind: string, at: number, line: string, path: string, location: string }[]} */
  const events = [];
  let available = false;
  for (const f of /** @type {{ name: string, path: string, mtimeMs: number }[]} */ (files)) {
    let text = "";
    try {
      text = readTailText(f.path, maxBytes);
    } catch {
      continue;
    }
    available = true;
    const nm = AGY_LOG_FILE_RE.exec(f.name);
    const year = nm ? Number(nm[1]) : new Date(f.mtimeMs).getFullYear();
    const fileMonth = nm ? Number(nm[2]) : 1;
    for (const raw of text.split(/\r?\n/)) {
      const kind = classifyAgyLine(raw);
      const loc = DETECTED_LOCATION_RE.exec(raw);
      if (!kind && !loc) continue;
      const at = parseGlogTime(raw, year, fileMonth);
      if (!at) continue;
      events.push({ kind, at, line: raw.trim().slice(0, 500), path: f.path, location: loc ? (loc[1] || loc[2] || "") : "" });
    }
  }
  if (!available) return none;

  // 稳定排序：同一时间戳保持文件内原有顺序
  events.sort((a, b) => a.at - b.at);
  /** @type {Record<string, { at: number, line: string, path: string } | null>} */
  const last = { blocked: null, "signed-in": null, "signed-out": null };
  /** @type {{ at: number, location: string } | null} 时间上最近的一条检测地区 */
  let lastLocation = null;
  for (const e of events) {
    if (e.kind) last[e.kind] = { at: e.at, line: e.line, path: e.path };
    if (e.location) lastLocation = { at: e.at, location: e.location };
  }

  const { blocked, "signed-in": signedIn, "signed-out": signedOut } = last;
  /** @type {"blocked" | "signed-in" | "signed-out" | "none"} */
  let state = "none";
  /** @type {{ at: number, line: string, path: string } | null} */
  let pick = null;
  if (blocked && (!signedIn || blocked.at >= signedIn.at)) { state = "blocked"; pick = blocked; }
  else if (signedIn && (!signedOut || signedIn.at >= signedOut.at)) { state = "signed-in"; pick = signedIn; }
  else if (signedOut) { state = "signed-out"; pick = signedOut; }

  // 只认"近期"的检测地区：几小时前的旧记录不能拿来解释当前的结论（见 LOCATION_RECENT_WINDOW_MS）
  const now = opts.now ?? Date.now();
  let since = Infinity;
  if (state === "blocked" && blocked) since = blocked.at - LOCATION_RECENT_WINDOW_MS;
  else if (state === "signed-in" && signedIn) since = Math.max(signedIn.at, now - LOCATION_RECENT_WINDOW_MS);
  const detectedLocation = lastLocation && lastLocation.at >= since ? lastLocation.location : "";

  return {
    available,
    state,
    at: pick ? pick.at : 0,
    path: pick ? pick.path : "",
    line: pick ? pick.line : "",
    detectedLocation,
    filesScanned: files.length,
  };
}

/**
 * Antigravity 会话层结论（纯函数）。
 * 优先级：匿名 loadCodeAssist 明确命中地区错误 > agy 登录日志 > 旧版 IDE 日志（Cockpit 等标记）兜底。
 * @param {{
 *   lcaVerdict: { state: string },
 *   agy: ReturnType<typeof findAgyAuthEvidence>,
 *   logEvidence: ReturnType<typeof findAntigravityLogEvidence>,
 * }} input
 * @returns {{ state: "ok" | "blocked" | "signed-out" | "inconclusive" | "unknown", source: "loadCodeAssist" | "agy" | "ide-log" | "", loggedIn: boolean, detectedLocation: string, at: number }}
 */
function resolveAntigravityState({ lcaVerdict, agy, logEvidence }) {
  const base = { loggedIn: false, detectedLocation: "", at: 0 };
  if (lcaVerdict.state === "blocked") return { ...base, state: "blocked", source: "loadCodeAssist" };

  // agy 有任何认证事件时以它为准：避免第三方扩展的登录标记把真实的"资格被拒"盖掉
  if (agy && agy.state !== "none") {
    const at = agy.at;
    if (agy.state === "blocked") return { ...base, state: "blocked", source: "agy", detectedLocation: agy.detectedLocation, at };
    // 已登录时也带上近期检测地区：用于"已登录但仍有请求从受限地区出口"的提前提醒
    if (agy.state === "signed-in") return { ...base, state: "ok", source: "agy", loggedIn: true, detectedLocation: agy.detectedLocation, at };
    return { ...base, state: "signed-out", source: "agy", at };
  }

  // 旧版 IDE（没有 agy 日志）兜底：沿用原有 IDE 日志目录的判定
  if (logEvidence.matched) return { ...base, state: "blocked", source: "ide-log", at: logEvidence.mtimeMs };
  if (logEvidence.loggedIn) return { ...base, state: "ok", source: "ide-log", loggedIn: true, at: logEvidence.loginMtimeMs };
  if (lcaVerdict.state === "ok") return { ...base, state: "ok", source: "loadCodeAssist" };
  if (logEvidence.available) return { ...base, state: "inconclusive", source: "ide-log" };
  return { ...base, state: "unknown", source: "" };
}

/**
 * "资格被拒"的原因诊断（纯函数，排除法）。
 *
 * Google 不会在客户端日志里说明被拒是因为 IP 还是账号（agy 只记 failure_kind=ineligible），
 * 官方答复称 Antigravity 按「账号《服务条款》关联地区」判定资格；但出口 IP 不受支持同样会被拒。
 * 因此用 Google 自己给出的 IP 判定信号做排除：
 * - ip：近期 Google 对 agy 流量给出了检测地区（LOCATION_NOT_ELIGIBLE），或 Gemini API 探测判定出口地区不支持；
 *       匿名 loadCodeAssist 命中地区错误同理（请求不带账号，只可能是 IP）
 * - account：近期没有任何地区拒绝，且 Gemini API 放行了出口 IP → 疑似账号关联地区 / 账号类型 / 年龄验证
 * - unknown：信号不足（如 API 探测失败），无法排除
 * 非 agy / loadCodeAssist 来源（旧版 IDE 日志）不做诊断，返回空串以保持原有展示。
 *
 * @param {{ source: string, detectedLocation: string, apiState: string }} input
 * @returns {"ip" | "account" | "unknown" | ""}
 */
function diagnoseIneligibleCause({ source, detectedLocation, apiState }) {
  if (source === "loadCodeAssist") return "ip";
  if (source !== "agy") return "";
  if (detectedLocation || apiState === "blocked") return "ip";
  if (apiState === "ok") return "account";
  return "unknown";
}

/**
 * 顶部总结论（纯函数）：任一层被拒即"受限"；只有 API 层与 Antigravity 会话层都确认可用才算"可用"。
 * @param {{ allFailed: boolean, proxyFailedOnly: boolean, apiState: string, antigravityState: string }} input
 * @returns {"ok" | "blocked" | "inconclusive" | "error" | "proxy-error"}
 */
function resolveOverallState({ allFailed, proxyFailedOnly, apiState, antigravityState }) {
  if (allFailed) return "error";
  if (proxyFailedOnly) return "proxy-error";
  if (apiState === "blocked" || antigravityState === "blocked") return "blocked";
  // 匿名 API 放行只说明出口 IP 能过 Gemini API 的地区闸门，不代表账号能登录 Antigravity
  if (apiState === "ok" && antigravityState === "ok") return "ok";
  return "inconclusive";
}

/**
 * 单次 HTTP 探测：先代理、失败再直连；两种结果都保留，方便区分"代理坏了"和"目标被拒"。
 * @param {string} url
 * @param {{ proxy?: any, method?: string, body?: string, timeoutMs?: number, headers?: Record<string, string>, t?: (key: string, params?: Record<string, any>) => string }} opts
 */
async function httpProbe(url, opts) {
  const t = opts.t || DEFAULT_T;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const proxy = opts.proxy && opts.proxy.port > 0 ? opts.proxy : null;
  /** @type {string} */
  let proxyError = "";

  if (proxy) {
    const started = Date.now();
    try {
      const r = await request(url, { proxy, timeoutMs, method: opts.method, body: opts.body, headers: opts.headers, maxBytes: 64 * 1024 });
      return { ok: true, via: "proxy", status: r.status, text: r.body.toString("utf8"), latencyMs: Date.now() - started, error: "", proxyError: "" };
    } catch (e) {
      proxyError = describeNetworkError(e, t);
    }
  }

  const started = Date.now();
  try {
    const r = await request(url, { proxy: null, timeoutMs, method: opts.method, body: opts.body, headers: opts.headers, maxBytes: 64 * 1024 });
    return { ok: true, via: "direct", status: r.status, text: r.body.toString("utf8"), latencyMs: Date.now() - started, error: "", proxyError };
  } catch (e) {
    return { ok: false, via: "", status: 0, text: "", latencyMs: Date.now() - started, error: describeNetworkError(e, t), proxyError };
  }
}

/**
 * 执行一次完整检测（三路探测并行 + 本地日志证据）。
 * homeDir 仅用于定位 agy 登录日志（默认 os.homedir()），测试时可注入临时目录。
 * @param {{ proxy?: any, appDataDir?: string, homeDir?: string, timeoutMs?: number, t?: (key: string, params?: Record<string, any>) => string, now?: number }} [opts]
 */
async function checkGemini(opts = {}) {
  const started = Date.now();
  const t = opts.t || DEFAULT_T;
  const proxy = opts.proxy && opts.proxy.port > 0 ? opts.proxy : null;

  const [reach, api, lca] = await Promise.all([
    httpProbe(REACH_URL, { proxy, timeoutMs: opts.timeoutMs, t }),
    httpProbe(GEMINI_API_URL, { proxy, timeoutMs: opts.timeoutMs, t, headers: { accept: "application/json" } }),
    httpProbe(LOAD_CODE_ASSIST_URL, {
      proxy,
      timeoutMs: opts.timeoutMs,
      t,
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json", accept: "application/json" },
    }),
  ]);

  const apiVerdict = api.ok ? classifyGeminiApi(api.status, api.text) : { state: "error", reason: api.error || "network" };
  const lcaVerdict = lca.ok ? classifyLoadCodeAssist(lca.status, lca.text) : { state: "error", reason: lca.error || "network" };
  const logEvidence = findAntigravityLogEvidence({ appDataDir: opts.appDataDir, now: opts.now });
  // agy 登录日志：账号资格的权威证据（IDE 2.6+）
  const agyEvidence = findAgyAuthEvidence({ homeDir: opts.homeDir, now: opts.now });
  const anti = resolveAntigravityState({ lcaVerdict, agy: agyEvidence, logEvidence });
  // 被拒时用排除法区分 IP / 账号原因（Google 不在日志里说明具体原因）
  const cause = anti.state === "blocked"
    ? diagnoseIneligibleCause({ source: anti.source, detectedLocation: anti.detectedLocation, apiState: apiVerdict.state })
    : "";

  const probes = [reach, api, lca];
  const anySuccess = probes.some((p) => p.ok);
  const proxySuccess = probes.some((p) => p.ok && p.via === "proxy");
  const allFailed = probes.every((p) => !p.ok);

  const state = resolveOverallState({
    allFailed,
    proxyFailedOnly: !!proxy && !proxySuccess && anySuccess,
    apiState: apiVerdict.state,
    antigravityState: anti.state,
  });

  /** @type {{ code: string, ok: boolean }[]} */
  const reasons = [];
  if (apiVerdict.state === "blocked") reasons.push({ code: "gemini-api-location", ok: false });
  if (lcaVerdict.state === "blocked") reasons.push({ code: "loadcodeassist-location", ok: false });
  if (anti.source === "agy") {
    // 记录 agy 的结论来源，便于日志/排查时区分"被拒"与"未登录"
    reasons.push({ code: `agy-${agyEvidence.state}`, ok: agyEvidence.state === "signed-in" });
  } else {
    if (logEvidence.matched) reasons.push({ code: "antigravity-log-location", ok: false });
    if (logEvidence.loggedIn && anti.state !== "blocked") reasons.push({ code: "antigravity-session-ok", ok: true });
  }
  if (cause) reasons.push({ code: `ineligible-cause-${cause}`, ok: false });
  if (apiVerdict.reason === "region-ok") reasons.push({ code: "region-ok", ok: true });

  return {
    checkedAt: Date.now(),
    durationMs: Date.now() - started,
    state,
    proxyConfigured: !!proxy,
    proxyError: probes.map((p) => p.proxyError).find(Boolean) || "",
    network: {
      ok: reach.ok && (reach.status === 204 || reach.status === 200),
      via: reach.via,
      status: reach.status,
      latencyMs: reach.latencyMs,
      error: reach.ok ? "" : reach.error,
      proxyError: reach.proxyError,
    },
    geminiApi: { ok: api.ok, via: api.via, status: api.status, state: apiVerdict.state, reason: apiVerdict.reason, error: api.ok ? "" : api.error, proxyError: api.proxyError },
    loadCodeAssist: { ok: lca.ok, via: lca.via, status: lca.status, state: lcaVerdict.state, reason: lcaVerdict.reason, error: lca.ok ? "" : lca.error, proxyError: lca.proxyError },
    antigravity: { state: anti.state, source: anti.source, cause, reasons, loggedIn: anti.loggedIn, detectedLocation: anti.detectedLocation, at: anti.at },
    agyEvidence,
    logEvidence,
  };
}

module.exports = {
  checkGemini,
  classifyGeminiApi,
  classifyLoadCodeAssist,
  findAntigravityLogEvidence,
  findAgyAuthEvidence,
  resolveAntigravityState,
  resolveOverallState,
  diagnoseIneligibleCause,
  scanLogFileForLocation,
  REACH_URL,
  GEMINI_API_URL,
  LOAD_CODE_ASSIST_URL,
};
