// @ts-check
"use strict";

/**
 * 轻量 HTTPS/HTTP 客户端（单一职责：在「直连 / SOCKS5 / HTTP CONNECT」三种链路上发请求）。
 *
 * 设计动机：
 * - Node 原生 https 不支持 SOCKS5，而插件的更新检查、出口 IP、Gemini 检测都必须真正走本地代理；
 * - 不能依赖 DLL 的透明代理是否已注入本进程（补丁可能待重启/缺失），否则会把"直连"误判成"经代理"。
 *
 * 约定：
 * - 只做 GET/POST 这类简单请求；自动跟随 3xx（最多 5 次），保留 307/308 的方法与 body；
 * - 响应体有上限（默认 4MB），下载大文件请用 downloadToFile（流式 + 边下边算 SHA256）；
 * - 证书始终校验（不提供跳过校验的开关）；
 * - 返回 viaProxy 便于 UI/日志区分"经代理/直连"。
 */

const http = require("http");
const https = require("https");
const tls = require("tls");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const zlib = require("zlib");

const { createTunnel } = require("./tunnel");

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const USER_AGENT = "antigravity-proxy-ide-extension";
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * @typedef {{ host: string, port: number, type?: string, username?: string, password?: string }} ProxySettings
 * @typedef {{ status: number, headers: Record<string, string | string[] | undefined>, body: Buffer, viaProxy: boolean, url: string }} HttpResponse
 * @typedef {{ timeoutMs?: number, proxy?: ProxySettings | null, maxBytes?: number, allowHttp?: boolean }} RequestOptions
 */

/** 规范化代理对象：端口为 0 / 空地址视为未配置 */
function normalizeProxy(proxy) {
  if (!proxy || !proxy.host || !Number.isInteger(proxy.port) || proxy.port <= 0 || proxy.port > 65535) return null;
  return proxy;
}

/** @param {import("net").Socket} socket @param {string} servername @param {number} timeoutMs */
function tlsWrap(socket, servername, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const tlsSocket = tls.connect({ socket, servername, ALPNProtocols: ["http/1.1"] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = Object.assign(new Error("TLS handshake timeout"), { code: "timeout" });
      tlsSocket.destroy(err);
      reject(err);
    }, timeoutMs);
    tlsSocket.once("secureConnect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(tlsSocket);
    });
    tlsSocket.once("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
  });
}

/**
 * 把已经建好的（TLS）socket 交给 http(s).request 使用。
 * Node 的 request options 里没有公开的 createConnection 入口，直接传会被忽略并退回直连；
 * 这里用一个一次性 Agent 覆写 createConnection，确保请求真的走隧道。
 * @param {"http:" | "https:"} protocol
 * @param {import("net").Socket} socket
 */
function createSocketAgent(protocol, socket) {
  const BaseAgent = protocol === "https:" ? https.Agent : http.Agent;
  class OneShotAgent extends BaseAgent {
    createConnection() {
      return socket;
    }
  }
  return new OneShotAgent({ keepAlive: false, maxSockets: 1 });
}

/** 统一的请求头（GitHub API 强制要求 User-Agent，否则 403） */
function buildHeaders(opts, body) {
  /** @type {Record<string, string>} */
  const headers = {
    "user-agent": opts.userAgent || USER_AGENT,
    accept: opts.accept || "*/*",
    "accept-encoding": "identity",
    connection: "close",
    ...(opts.headers || {}),
  };
  if (body !== undefined && body !== null) headers["content-length"] = String(Buffer.byteLength(body));
  return headers;
}

/**
 * 发一次请求（不跟随重定向），返回可读流。
 * @param {URL} urlObj
 * @param {{ method: string, body?: string | Buffer, proxy?: ProxySettings | null, timeoutMs: number, headers?: Record<string, string> }} opts
 */
async function send(urlObj, opts) {
  const isHttps = urlObj.protocol === "https:";
  const host = urlObj.hostname;
  const port = Number(urlObj.port || (isHttps ? 443 : 80));
  const reqPath = `${urlObj.pathname || "/"}${urlObj.search || ""}`;
  const headers = buildHeaders(opts, opts.body);

  const proxy = normalizeProxy(opts.proxy);
  /** @type {import("net").Socket | null} */
  let socket = null;
  if (proxy) {
    socket = await createTunnel(proxy, { host, port }, { timeoutMs: Math.min(opts.timeoutMs, 10000) });
    if (isHttps) socket = await tlsWrap(socket, host, opts.timeoutMs);
  }

  return new Promise((resolve, reject) => {
    const mod = isHttps ? https : http;
    /** @param {import("http").IncomingMessage} res */
    const onResponse = (res) => {
      clearTimeout(killTimer);
      resolve({
        status: res.statusCode || 0,
        headers: res.headers,
        stream: res,
        viaProxy: !!proxy,
        destroy: () => {
          res.destroy();
          if (socket) socket.destroy();
        },
      });
    };
    const reqOpts = proxy
      ? {
          host,
          port,
          method: opts.method,
          path: reqPath,
          headers,
          agent: createSocketAgent(isHttps ? "https:" : "http:", /** @type {any} */ (socket)),
        }
      : { hostname: host, port, method: opts.method, path: reqPath, headers };

    /** @type {import("http").ClientRequest} */
    const req = mod.request(/** @type {any} */ (reqOpts), onResponse);
    const killTimer = setTimeout(() => {
      const err = Object.assign(new Error("request timeout"), { code: "timeout" });
      req.destroy(err);
      if (socket) socket.destroy();
    }, opts.timeoutMs);
    req.setTimeout(opts.timeoutMs, () => {
      req.destroy(Object.assign(new Error("request timeout"), { code: "timeout" }));
    });
    req.on("error", (e) => {
      clearTimeout(killTimer);
      if (socket) socket.destroy();
      reject(e);
    });
    if (opts.body !== undefined && opts.body !== null) req.write(opts.body);
    req.end();
  });
}

/** 读取最多 maxBytes，并按需要解压 */
async function readAll(stream, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += /** @type {Buffer} */ (chunk).length;
    if (size > maxBytes) {
      const err = Object.assign(new Error("response too large"), { code: "too_large" });
      throw err;
    }
    chunks.push(/** @type {Buffer} */ (chunk));
  }
  let body = Buffer.concat(chunks);
  // 正常请求不带 Accept-Encoding，但代理/中间层仍可能压缩；这里做兜底解压
  const enc = String(/** @type {any} */ (stream).headers?.["content-encoding"] || "").toLowerCase();
  if (enc.includes("gzip")) body = zlib.gunzipSync(body);
  else if (enc.includes("deflate")) body = zlib.inflateSync(body);
  return body;
}

/**
 * 发起请求并跟随重定向。
 * @param {string} url
 * @param {RequestOptions & { method?: string, body?: string | Buffer, headers?: Record<string, string>, accept?: string, userAgent?: string }} [opts]
 * @returns {Promise<HttpResponse>}
 */
async function request(url, opts = {}) {
  let current = new URL(url);
  let method = (opts.method || "GET").toUpperCase();
  let body = opts.body;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== "https:" && !opts.allowHttp) {
      throw Object.assign(new Error(`refusing non-https URL: ${current.toString()}`), { code: "insecure_url" });
    }
    const res = await send(current, { method, body, proxy: opts.proxy, timeoutMs, headers: opts.headers });
    if (REDIRECT_STATUS.has(res.status) && res.headers.location) {
      res.destroy();
      const next = new URL(String(res.headers.location), current);
      // 303 与 301/302 的 POST 按浏览器语义降级为 GET；307/308 保持原方法
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
      current = next;
      continue;
    }
    /** @type {Buffer} */
    let payload;
    try {
      payload = await readAll(/** @type {any} */ (res.stream), maxBytes);
    } catch (e) {
      // 读取失败（超限/解压失败）时显式销毁，避免隧道 socket 悬挂
      res.destroy();
      throw e;
    }
    return { status: res.status, headers: res.headers, body: payload, viaProxy: res.viaProxy, url: current.toString() };
  }
  throw Object.assign(new Error("too many redirects"), { code: "redirect_loop" });
}

/**
 * 下载到本地文件：流式写入，同时计算 SHA256；返回实际字节数与摘要。
 * @param {string} url
 * @param {string} filePath
 * @param {RequestOptions & { headers?: Record<string, string>, onProgress?: (bytes: number) => void, maxBytes?: number }} [opts]
 * @returns {Promise<{ status: number, bytes: number, sha256: string, viaProxy: boolean, url: string }>}
 */
async function downloadToFile(url, filePath, opts = {}) {
  const maxBytes = opts.maxBytes ?? 100 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 60000;
  let current = new URL(url);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== "https:" && !opts.allowHttp) {
      throw Object.assign(new Error(`refusing non-https URL: ${current.toString()}`), { code: "insecure_url" });
    }
    const res = await send(current, { method: "GET", proxy: opts.proxy, timeoutMs, headers: opts.headers });
    if (REDIRECT_STATUS.has(res.status) && res.headers.location) {
      res.destroy();
      current = new URL(String(res.headers.location), current);
      continue;
    }
    if (res.status !== 200) {
      res.destroy();
      throw Object.assign(new Error(`download failed with HTTP ${res.status}`), { code: `http_${res.status}`, status: res.status });
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const hash = crypto.createHash("sha256");
    const out = fs.createWriteStream(filePath);
    let bytes = 0;
    try {
      for await (const chunk of /** @type {any} */ (res.stream)) {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          throw Object.assign(new Error("download too large"), { code: "too_large" });
        }
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
        if (opts.onProgress) opts.onProgress(bytes);
      }
      await new Promise((resolve, reject) => out.end((/** @type {any} */ err) => (err ? reject(err) : resolve())));
    } catch (e) {
      out.destroy();
      try { fs.unlinkSync(filePath); } catch { /* 清理失败不覆盖主错误 */ }
      res.destroy();
      throw e;
    }
    return { status: 200, bytes, sha256: hash.digest("hex"), viaProxy: res.viaProxy, url: current.toString() };
  }
  throw Object.assign(new Error("too many redirects"), { code: "redirect_loop" });
}

/**
 * 把网络错误转成当前语言的可读文案（未知错误保留原始 message，便于排查）。
 * @param {any} error
 * @param {(key: string, params?: Record<string, any>) => string} t
 */
function describeNetworkError(error, t) {
  const code = String(error?.code || "");
  const raw = String(error?.message || error || "");
  if (code.startsWith("socks_rep_")) {
    return t("net.socksRep", { rep: code.slice("socks_rep_".length) });
  }
  /** @type {Record<string, string>} */
  const map = {
    timeout: "net.timeout",
    ETIMEDOUT: "net.timeout",
    ENOTFOUND: "net.dnsFailed",
    EAI_AGAIN: "net.dnsFailed",
    ECONNREFUSED: "net.refused",
    ECONNRESET: "net.reset",
    EPIPE: "net.reset",
    insecure_url: "net.insecureUrl",
    too_large: "net.tooLarge",
    redirect_loop: "net.redirectLoop",
    http_407: "net.http407",
    socks_not_socks5: "net.notSocks5",
    socks_auth_required: "net.authRequired",
    socks_auth_failed: "net.authFailed",
    socks_auth_rejected: "net.authRejected",
    connect: "net.proxyUnreachable",
    handshake: "net.proxyHandshake",
  };
  const key = map[code] || "net.failed";
  return t(key, { error: raw });
}

module.exports = {
  request,
  downloadToFile,
  describeNetworkError,
  USER_AGENT,
  DEFAULT_TIMEOUT_MS,
};
