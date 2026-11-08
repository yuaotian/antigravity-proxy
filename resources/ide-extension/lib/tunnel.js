// @ts-check
"use strict";

/**
 * 代理隧道底层实现（单一职责：把一条到本地代理的 TCP 连接升级为到目标主机的透明隧道）。
 *
 * 为什么需要它：Node 没有内置 SOCKS 客户端，而「检查插件更新 / 查询出口 IP / 检测 Gemini」
 * 都必须真正经过 config.json 里的本地代理——否则在 DLL 尚未生效或未注入本进程时，
 * 请求会变成直连，结论就会失真（看起来"通"，其实走的不是代理）。
 *
 * 支持：
 * - SOCKS5（RFC 1928，目标用域名形式；可选 RFC 1929 账号密码认证）
 * - HTTP CONNECT（可选 Basic 代理认证）
 *
 * 失败时抛出 TunnelError：code 为稳定标识（便于上层翻译成三语文案），message 为英文兜底。
 */

const net = require("net");
const { once } = require("events");

/** 代理握手默认超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 8000;

class TunnelError extends Error {
  /**
   * @param {string} code 稳定错误码（connect / timeout / socks_auth_failed / socks_rep_5 / http_407 ...）
   * @param {string} message 英文兜底描述
   */
  constructor(code, message) {
    super(message);
    this.name = "TunnelError";
    this.code = code;
  }
}

/**
 * 极简流读取器：按需读取 N 字节或读到分隔符，不抢占 socket 上其它监听器。
 * 目标握手报文的长度都是确定的，因此不需要完整 HTTP 解析器。
 * @param {net.Socket} socket
 */
function createReader(socket) {
  let buffer = Buffer.alloc(0);
  /** @type {null | (() => void)} */
  let waiter = null;
  /** @type {Error | null} */
  let failure = null;
  const wake = () => {
    const w = waiter;
    waiter = null;
    if (w) w();
  };
  const onData = (/** @type {Buffer} */ chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    wake();
  };
  const onError = (/** @type {Error} */ e) => {
    failure = failure || e;
    wake();
  };
  const onEnd = () => {
    failure = failure || new Error("connection closed by proxy");
    wake();
  };
  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("end", onEnd);
  socket.on("close", onEnd);

  return {
    /** @param {number} n */
    async readN(n) {
      while (buffer.length < n) {
        if (failure) throw failure;
        await new Promise((resolve) => { waiter = resolve; });
      }
      const out = buffer.subarray(0, n);
      buffer = buffer.subarray(n);
      return out;
    },
    /** @param {string} delim @param {number} max */
    async readUntil(delim, max) {
      for (;;) {
        const idx = buffer.indexOf(delim);
        if (idx >= 0) {
          const out = buffer.subarray(0, idx + delim.length);
          buffer = buffer.subarray(idx + delim.length);
          return out;
        }
        if (buffer.length > max) throw new Error("proxy response too long");
        if (failure) throw failure;
        await new Promise((resolve) => { waiter = resolve; });
      }
    },
    dispose() {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      socket.off("close", onEnd);
    },
  };
}

/**
 * SOCKS5 握手 + CONNECT（目标以域名交给代理解析，避免本地 DNS 污染）。
 * @param {net.Socket} socket
 * @param {{ readN: (n: number) => Promise<Buffer> }} reader
 * @param {{ username?: string, password?: string }} proxy
 * @param {{ host: string, port: number }} target
 */
async function socks5Connect(socket, reader, proxy, target) {
  const hasAuth = !!(proxy.username || proxy.password);
  const methods = hasAuth ? [0x00, 0x02] : [0x00];
  socket.write(Buffer.from([0x05, methods.length, ...methods]));

  const greet = await reader.readN(2);
  if (greet[0] !== 0x05) throw new TunnelError("socks_not_socks5", "proxy is not SOCKS5");
  if (greet[1] === 0xff) {
    throw new TunnelError(
      hasAuth ? "socks_auth_rejected" : "socks_auth_required",
      "proxy rejected all authentication methods",
    );
  }
  if (greet[1] === 0x02) {
    if (!hasAuth) throw new TunnelError("socks_auth_required", "proxy requires username/password");
    const user = Buffer.from(proxy.username || "", "utf8");
    const pass = Buffer.from(proxy.password || "", "utf8");
    if (user.length > 255 || pass.length > 255) throw new TunnelError("socks_auth_failed", "credentials too long");
    socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
    const authResp = await reader.readN(2);
    if (authResp[1] !== 0x00) throw new TunnelError("socks_auth_failed", "username or password rejected");
  }

  const host = Buffer.from(target.host, "utf8");
  if (host.length === 0 || host.length > 255) throw new TunnelError("socks_target_invalid", "invalid target host");
  socket.write(Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
    host,
    Buffer.from([(target.port >> 8) & 0xff, target.port & 0xff]),
  ]));

  const rep = await reader.readN(4);
  if (rep[1] !== 0x00) {
    throw new TunnelError(`socks_rep_${rep[1]}`, `proxy could not connect to target (REP=${rep[1]})`);
  }
  // 消费 BND.ADDR + BND.PORT，保证隧道建立后 socket 里没有残留握手字节
  const atyp = rep[3];
  let addrLen = 0;
  if (atyp === 0x01) addrLen = 4;
  else if (atyp === 0x04) addrLen = 16;
  else if (atyp === 0x03) addrLen = (await reader.readN(1))[0];
  else throw new TunnelError("socks_rep_invalid", `unsupported address type ${atyp}`);
  if (addrLen > 0) await reader.readN(addrLen);
  await reader.readN(2);
}

/**
 * HTTP CONNECT 握手（可选 Proxy-Authorization: Basic）。
 * @param {net.Socket} socket
 * @param {{ readUntil: (delim: string, max: number) => Promise<Buffer> }} reader
 * @param {{ username?: string, password?: string }} proxy
 * @param {{ host: string, port: number }} target
 */
async function httpConnect(socket, reader, proxy, target) {
  const hostPort = `${target.host}:${target.port}`;
  let req = `CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\nProxy-Connection: Keep-Alive\r\n`;
  if (proxy.username || proxy.password) {
    const token = Buffer.from(`${proxy.username || ""}:${proxy.password || ""}`, "utf8").toString("base64");
    req += `Proxy-Authorization: Basic ${token}\r\n`;
  }
  socket.write(req + "\r\n");

  const head = (await reader.readUntil("\r\n\r\n", 16384)).toString("latin1");
  const m = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(head);
  if (!m) throw new TunnelError("http_not_http", "proxy did not answer with HTTP");
  const code = Number(m[1]);
  if (code === 407) throw new TunnelError("http_407", "proxy authentication required (HTTP 407)");
  if (code !== 200) throw new TunnelError(`http_${code}`, `proxy refused CONNECT with HTTP ${code}`);
}

/**
 * 建立到 target 的代理隧道，返回已就绪的原始 TCP socket。
 *
 * 注意：调用方负责在失败时销毁 socket；本函数成功返回后不再设置 socket 超时，
 * 由上层（httpClient）按请求需要重新设置。
 *
 * @param {{ host: string, port: number, type?: string, username?: string, password?: string }} proxy
 * @param {{ host: string, port: number }} target
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {Promise<net.Socket>}
 */
async function createTunnel(proxy, target, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!proxy || !proxy.host || !Number.isInteger(proxy.port) || proxy.port <= 0 || proxy.port > 65535) {
    throw new TunnelError("config", "invalid proxy address");
  }
  if (!target || !target.host || !Number.isInteger(target.port) || target.port <= 0) {
    throw new TunnelError("config", "invalid target");
  }

  /** @type {net.Socket} */
  const socket = net.connect({ host: proxy.host, port: proxy.port });
  socket.setNoDelay(true);
  /** @type {NodeJS.Timeout} */
  const timer = setTimeout(() => {
    socket.destroy(new Error("proxy tunnel timeout"));
  }, timeoutMs);

  try {
    await once(socket, "connect");
  } catch (e) {
    clearTimeout(timer);
    socket.destroy();
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    throw new TunnelError(err.code || "connect", `cannot connect to proxy ${proxy.host}:${proxy.port}: ${err.message}`);
  }

  const reader = createReader(socket);
  try {
    const type = String(proxy.type || "socks5").toLowerCase();
    if (type === "http") await httpConnect(socket, reader, proxy, target);
    else await socks5Connect(socket, reader, proxy, target);
  } catch (e) {
    clearTimeout(timer);
    reader.dispose();
    socket.destroy();
    if (e instanceof TunnelError) throw e;
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    throw new TunnelError(err.code || "handshake", `proxy handshake failed: ${err.message}`);
  }
  reader.dispose();
  clearTimeout(timer);
  socket.setTimeout(0);
  return socket;
}

module.exports = { createTunnel, TunnelError, DEFAULT_TIMEOUT_MS };
