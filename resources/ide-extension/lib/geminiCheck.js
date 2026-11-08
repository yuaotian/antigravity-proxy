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
 *   antigravity    —— loadCodeAssist 的 403/1008 证据 + Antigravity 自己的 ls-main.log 命中记录
 *
 * 最后一条是"真实会话"的硬证据：日志里出现过 location 限制，说明当时确实被服务端拒绝；
 * 但它可能来自旧会话，所以 UI 同时展示命中时间，避免把历史问题当成当前故障。
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
 * 在指定日志文件里找"地区不支持"的最后一次命中。
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {{ available: boolean, matched: boolean, line: string }}
 */
function scanLogFileForLocation(filePath, maxBytes = DEFAULT_LOG_MAX_BYTES) {
  try {
    const text = readTailText(filePath, maxBytes);
    const lines = text.split(/\r?\n/);
    /** @type {string} */
    let matchedLine = "";
    for (let i = lines.length - 1; i >= 0; i--) {
      if (matchesAny(LOCATION_MARKERS, lines[i])) {
        matchedLine = lines[i].trim();
        break;
      }
    }
    return { available: true, matched: !!matchedLine, line: matchedLine };
  } catch {
    return { available: false, matched: false, line: "" };
  }
}

/**
 * 找到最新的 Antigravity 会话日志并检查 location 错误。
 * 目录规则与 DLL 诊断一致（src/hooks/Hooks.cpp:649-688）：%APPDATA%\Antigravity\logs\<最新目录>\ls-main.log，
 * 同时兼容新版本可能出现的 language_server.log。
 *
 * @param {{ appDataDir?: string, now?: number }} [opts]
 * @returns {{ available: boolean, matched: boolean, path: string, line: string, mtimeMs: number }}
 */
function findAntigravityLogEvidence(opts = {}) {
  const appData = opts.appDataDir || process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const logsRoot = path.join(appData, "Antigravity", "logs");
  /** @type {{ available: boolean, matched: boolean, path: string, line: string, mtimeMs: number }} */
  const empty = { available: false, matched: false, path: "", line: "", mtimeMs: 0 };
  let entries = [];
  try {
    entries = fs.readdirSync(logsRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return empty;
  }
  const dirs = entries
    .map((e) => {
      const p = path.join(logsRoot, e.name);
      try {
        return { path: p, mtimeMs: fs.statSync(p).mtimeMs };
      } catch {
        return { path: p, mtimeMs: 0 };
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 3);

  /** @type {{ available: boolean, matched: boolean, path: string, line: string, mtimeMs: number }} */
  let newest = empty;
  for (const dir of dirs) {
    for (const name of ["ls-main.log", "language_server.log"]) {
      const filePath = path.join(dir.path, name);
      if (!fs.existsSync(filePath)) continue;
      const scan = scanLogFileForLocation(filePath);
      if (!scan.available) continue;
      if (!newest.available) {
        newest = { available: true, matched: false, path: filePath, line: "", mtimeMs: dir.mtimeMs };
      }
      if (scan.matched) {
        return { available: true, matched: true, path: filePath, line: scan.line, mtimeMs: dir.mtimeMs };
      }
    }
  }
  return newest;
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
 * @param {{ proxy?: any, appDataDir?: string, timeoutMs?: number, t?: (key: string, params?: Record<string, any>) => string, now?: number }} [opts]
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

  const antigravityBlocked = lcaVerdict.state === "blocked" || logEvidence.matched;
  const antigravityState = antigravityBlocked ? "blocked" : lcaVerdict.state === "ok" ? "ok" : "inconclusive";

  const probes = [reach, api, lca];
  const anySuccess = probes.some((p) => p.ok);
  const proxySuccess = probes.some((p) => p.ok && p.via === "proxy");
  const allFailed = probes.every((p) => !p.ok);

  /** @type {"ok" | "blocked" | "inconclusive" | "error" | "proxy-error"} */
  let state;
  if (allFailed) state = "error";
  else if (proxy && !proxySuccess && anySuccess) state = "proxy-error";
  else if (apiVerdict.state === "blocked" || antigravityBlocked) state = "blocked";
  else if (apiVerdict.state === "ok") state = "ok";
  else state = "inconclusive";

  /** @type {{ code: string, ok: boolean }[]} */
  const reasons = [];
  if (apiVerdict.state === "blocked") reasons.push({ code: "gemini-api-location", ok: false });
  if (lcaVerdict.state === "blocked") reasons.push({ code: "loadcodeassist-location", ok: false });
  if (logEvidence.matched) reasons.push({ code: "antigravity-log-location", ok: false });
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
    antigravity: { state: antigravityState, reasons },
    logEvidence,
  };
}

module.exports = {
  checkGemini,
  classifyGeminiApi,
  classifyLoadCodeAssist,
  findAntigravityLogEvidence,
  scanLogFileForLocation,
  REACH_URL,
  GEMINI_API_URL,
  LOAD_CODE_ASSIST_URL,
};
