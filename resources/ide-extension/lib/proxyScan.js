// @ts-check
"use strict";

/**
 * 本机代理扫描（单一职责：发现候选代理端点并逐一验证；不依赖 vscode API，便于单元测试）。
 *
 * 候选来源（按可信度排序）：当前配置 → IDE http.proxy → Windows 系统代理 → 环境变量 → 常用端口。
 * 每个端点先做快速 TCP 检测（过滤未监听端口），开放后再分别以 SOCKS5 / HTTP 建立到目标站点的完整隧道；
 * 两种协议都可用时优先 SOCKS5（支持 UDP 转发）。只读探测，不修改任何系统设置。
 */

const { execFile } = require("child_process");
const { probeProxy } = require("./proxyProbe");

/** 常用本地代理端口：与 scripts/doctor.ps1 的 CommonProxyPorts 保持一致 */
const COMMON_PORTS = Object.freeze([7890, 7897, 7891, 10808, 10809, 1080, 8118]);
const SOURCE_RANK = Object.freeze({ current: 0, ide: 1, system: 2, env: 3, port: 4 });
const ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
const INTERNET_SETTINGS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

/**
 * @typedef {"current" | "ide" | "system" | "env" | "port"} ScanSource
 * @typedef {{ host: string, port: number, hint?: "socks5" | "http" }} Endpoint
 * @typedef {{ host: string, port: number, type: "socks5" | "http", sources: ScanSource[], latencyMs: number, message: string }} ScanCandidate
 * @typedef {{ candidates: ScanCandidate[], scanned: number }} ScanResult
 */

/**
 * 解析代理 URL：支持 http://user:pass@host:port、socks5://host:port、host:port。
 * @param {string | undefined | null} value
 * @returns {Endpoint | null}
 */
function parseProxyUrl(value) {
  const s = String(value ?? "").trim();
  if (!s) return null;
  const m = /^(?:([a-z0-9]+):\/\/)?(?:[^@/]*@)?(\[[^\]]+\]|[^:/]+):(\d{1,5})(?:\/.*)?$/i.exec(s);
  if (!m) return null;
  const port = Number(m[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const scheme = (m[1] || "").toLowerCase();
  /** @type {Endpoint} */
  const ep = { host: m[2].replace(/^\[|\]$/g, ""), port };
  if (scheme.startsWith("socks")) ep.hint = "socks5";
  else if (scheme.startsWith("http")) ep.hint = "http";
  return ep;
}

/**
 * 解析 Windows 系统代理 ProxyServer：可能是 "host:port"，也可能是 "http=h:p;https=h:p;socks=h:p"。
 * @param {string | undefined | null} value
 * @returns {Endpoint[]}
 */
function parseWindowsProxyServer(value) {
  const s = String(value ?? "").trim();
  if (!s) return [];
  /** @type {Endpoint[]} */
  const out = [];
  for (const part of s.split(";")) {
    const eq = part.indexOf("=");
    const proto = eq >= 0 ? part.slice(0, eq).trim().toLowerCase() : "";
    const ep = parseProxyUrl(eq >= 0 ? part.slice(eq + 1) : part);
    if (!ep) continue;
    if (proto === "socks") ep.hint = "socks5";
    else if (proto === "http" || proto === "https") ep.hint = "http";
    out.push(ep);
  }
  return out;
}

/**
 * 读取 Windows 当前用户的系统代理（仅在 ProxyEnable=1 时返回 ProxyServer）。
 * @returns {Promise<string | null>}
 */
function readWindowsSystemProxy() {
  if (process.platform !== "win32") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("reg", ["query", INTERNET_SETTINGS_KEY], { windowsHide: true, timeout: 3000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const enabled = /ProxyEnable\s+REG_DWORD\s+0x0*1\b/i.test(stdout);
      const m = /ProxyServer\s+REG_SZ\s+(\S.*)$/im.exec(stdout);
      resolve(enabled && m ? m[1].trim() : null);
    });
  });
}

/**
 * 扫描本机可用代理。
 * @param {{
 *   current?: { host: string, port: number, type?: string, username?: string, password?: string } | null,
 *   ideProxy?: string,
 *   env?: Record<string, string | undefined>,
 *   systemProxy?: string | null,
 *   ports?: readonly number[],
 *   tcpTimeoutMs?: number,
 *   probeTimeoutMs?: number,
 *   target?: { host: string, port: number },
 *   t?: (key: string, params?: Record<string, any>) => string,
 * }} [opts]
 * @returns {Promise<ScanResult>}
 */
async function scanLocalProxies(opts = {}) {
  const env = opts.env ?? process.env;
  const systemProxy = opts.systemProxy !== undefined ? opts.systemProxy : await readWindowsSystemProxy();

  /** @type {Map<string, { host: string, port: number, sources: Set<ScanSource> }>} */
  const endpoints = new Map();
  /** @param {Endpoint | null} ep @param {ScanSource} source */
  const add = (ep, source) => {
    if (!ep || !ep.host || !Number.isInteger(ep.port) || ep.port <= 0 || ep.port > 65535) return;
    const key = `${ep.host.toLowerCase()}:${ep.port}`;
    if (!endpoints.has(key)) endpoints.set(key, { host: ep.host, port: ep.port, sources: new Set() });
    endpoints.get(key)?.sources.add(source);
  };

  const current = opts.current && opts.current.port > 0 ? opts.current : null;
  if (current) add({ host: current.host, port: current.port }, "current");
  add(parseProxyUrl(opts.ideProxy), "ide");
  for (const ep of parseWindowsProxyServer(systemProxy)) add(ep, "system");
  for (const k of ENV_KEYS) add(parseProxyUrl(env[k]), "env");
  for (const p of opts.ports ?? COMMON_PORTS) add({ host: "127.0.0.1", port: p }, "port");

  const tcpTimeoutMs = opts.tcpTimeoutMs ?? 800;
  const probeTimeoutMs = opts.probeTimeoutMs ?? 4000;
  const base = { t: opts.t, target: opts.target };

  const checked = await Promise.all([...endpoints.values()].map(async (ep) => {
    const tcp = await probeProxy({ host: ep.host, port: ep.port, type: "socks5" }, { ...base, tcpOnly: true, timeoutMs: tcpTimeoutMs });
    if (!tcp.ok) return null;
    // 仅“当前配置”端点携带账密，避免把用户凭据发给其它端口
    const creds = ep.sources.has("current") && current ? { username: current.username || "", password: current.password || "" } : {};
    const [s5, http] = await Promise.all([
      probeProxy({ host: ep.host, port: ep.port, type: "socks5", ...creds }, { ...base, timeoutMs: probeTimeoutMs }),
      probeProxy({ host: ep.host, port: ep.port, type: "http", ...creds }, { ...base, timeoutMs: probeTimeoutMs }),
    ]);
    const ok = s5.ok ? { type: /** @type {"socks5"} */ ("socks5"), r: s5 } : http.ok ? { type: /** @type {"http"} */ ("http"), r: http } : null;
    if (!ok) return null;
    /** @type {ScanCandidate} */
    const c = {
      host: ep.host,
      port: ep.port,
      type: ok.type,
      sources: [...ep.sources].sort((a, b) => SOURCE_RANK[a] - SOURCE_RANK[b]),
      latencyMs: ok.r.latencyMs,
      message: ok.r.message,
    };
    return c;
  }));

  const candidates = /** @type {ScanCandidate[]} */ (checked.filter(Boolean)).sort((a, b) =>
    (SOURCE_RANK[a.sources[0]] - SOURCE_RANK[b.sources[0]]) || (a.latencyMs - b.latencyMs));
  return { candidates, scanned: endpoints.size };
}

module.exports = { scanLocalProxies, parseProxyUrl, parseWindowsProxyServer, readWindowsSystemProxy, COMMON_PORTS };
