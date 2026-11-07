// @ts-check
"use strict";

/**
 * 代理连通性探测（单一职责：网络探测，不依赖 vscode API，便于单元测试）。
 *
 * 两种模式：
 * - tcpOnly：仅检测端口是否可连（状态栏周期检测，开销极小）
 * - 端到端：按 proxy.type 完成 SOCKS5（含 RFC 1929 账密）或 HTTP CONNECT 握手，
 *   并真正建立到目标（默认 www.gstatic.com:443）的隧道，能区分“端口不通 / 协议不匹配 / 认证失败 / 隧道失败”。
 *
 * 说明：扩展宿主进程中已注入代理 DLL；本地回环与代理自身地址在 DLL 中会被旁路，不会被二次代理。
 */

const net = require("net");
const I18n = require("../media/i18n");

const DEFAULT_TARGET = Object.freeze({ host: "www.gstatic.com", port: 443 });
// 未传入翻译函数时使用简体中文（与单元测试、历史行为一致）
const DEFAULT_T = I18n.createT("zh-cn");

/** @typedef {(key: string, params?: Record<string, any>) => string} Translate */

/**
 * @typedef {Object} ProxySettings
 * @property {string} host
 * @property {number} port
 * @property {string} type        socks5 | http
 * @property {string} [username]
 * @property {string} [password]
 *
 * @typedef {Object} ProbeResult
 * @property {boolean} ok
 * @property {"config" | "tcp" | "handshake" | "auth" | "tunnel"} stage  失败（或成功）所处阶段
 * @property {number} latencyMs
 * @property {string} message
 */

/** 简单的按需读取器：把 socket 数据流转换为“读满 N 字节 / 读到分隔符”的 Promise */
class SocketReader {
  /** @param {net.Socket} socket @param {Translate} t */
  constructor(socket, t) {
    this.t = t;
    this.buf = Buffer.alloc(0);
    /** @type {null | (() => void)} */
    this.waiter = null;
    /** @type {Error | null} */
    this.error = null;
    socket.on("data", (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.wake();
    });
    socket.on("end", () => this.fail(new Error(this.t("probe.closedByProxy"))));
    socket.on("error", (e) => this.fail(e));
  }
  /** @param {Error} e */
  fail(e) {
    if (!this.error) this.error = e;
    this.wake();
  }
  wake() {
    const w = this.waiter;
    this.waiter = null;
    if (w) w();
  }
  /** @param {(buf: Buffer) => number} need 返回可消费字节数，-1 表示继续等待 */
  async take(need) {
    for (;;) {
      const n = need(this.buf);
      if (n >= 0) {
        const out = this.buf.subarray(0, n);
        this.buf = this.buf.subarray(n);
        return out;
      }
      if (this.error) throw this.error;
      await new Promise((resolve) => { this.waiter = /** @type {() => void} */ (resolve); });
    }
  }
  /** @param {number} n */
  readBytes(n) {
    return this.take((b) => (b.length >= n ? n : -1));
  }
  /** @param {string} delim @param {number} max */
  readUntil(delim, max) {
    return this.take((b) => {
      const i = b.indexOf(delim);
      if (i >= 0) return i + delim.length;
      if (b.length > max) throw new Error(this.t("probe.responseTooLong"));
      return -1;
    });
  }
}

/**
 * @param {ProxySettings} proxy
 * @param {{ tcpOnly?: boolean, timeoutMs?: number, target?: { host: string, port: number }, t?: Translate }} [opts]
 * @returns {Promise<ProbeResult>}
 */
function probeProxy(proxy, opts = {}) {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 6000;
  const target = opts.target ?? DEFAULT_TARGET;
  const t = opts.t ?? DEFAULT_T;
  /** @param {boolean} ok @param {ProbeResult["stage"]} stage @param {string} message */
  const result = (ok, stage, message) => ({ ok, stage, latencyMs: Date.now() - started, message });

  if (!proxy || !proxy.host || !Number.isInteger(proxy.port) || proxy.port <= 0 || proxy.port > 65535) {
    return Promise.resolve(result(false, "config", t(proxy?.port === 0 ? "probe.disabled" : "probe.invalid")));
  }

  return new Promise((resolve) => {
    /** @type {ProbeResult["stage"]} */
    let stage = "tcp";
    let settled = false;
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    /** @param {ProbeResult} r */
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => {
      finish(result(false, stage, stage === "tcp"
        ? t("probe.connectTimeout", { host: proxy.host, port: proxy.port })
        : t("probe.stageTimeout", { stage: stageName(stage, t) })));
    }, timeoutMs);
    const reader = new SocketReader(socket, t);

    socket.once("connect", async () => {
      if (opts.tcpOnly) {
        finish(result(true, "tcp", t("probe.tcpOk", { host: proxy.host, port: proxy.port })));
        return;
      }
      try {
        stage = "handshake";
        const type = String(proxy.type || "socks5").toLowerCase();
        const r = type === "http"
          ? await httpConnect(socket, reader, proxy, target, (s) => { stage = s; }, t)
          : await socks5Connect(socket, reader, proxy, target, (s) => { stage = s; }, t);
        finish(result(r.ok, r.ok ? "tunnel" : stage, r.message));
      } catch (e) {
        finish(result(false, stage, t("probe.stageFailed", { stage: stageName(stage, t), error: /** @type {Error} */ (e).message })));
      }
    });
    socket.once("error", (e) => {
      if (stage === "tcp") {
        const code = /** @type {NodeJS.ErrnoException} */ (e).code;
        const hint = code === "ECONNREFUSED" ? t("probe.refusedHint") : "";
        finish(result(false, "tcp", t("probe.connectFailed", { host: proxy.host, port: proxy.port, code: code || e.message, hint })));
      }
    });
  });
}

/** @param {string} stage @param {Translate} t */
function stageName(stage, t) {
  const key = { tcp: "probe.stageTcp", handshake: "probe.stageHandshake", auth: "probe.stageAuth", tunnel: "probe.stageTunnel", config: "probe.stageConfig" }[stage];
  return key ? t(key) : stage;
}

/**
 * @param {net.Socket} socket @param {SocketReader} reader @param {ProxySettings} proxy
 * @param {{host: string, port: number}} target @param {(s: ProbeResult["stage"]) => void} setStage
 * @param {Translate} t
 */
async function socks5Connect(socket, reader, proxy, target, setStage, t) {
  const hasAuth = !!(proxy.username || proxy.password);
  const methods = hasAuth ? [0x00, 0x02] : [0x00];
  socket.write(Buffer.from([0x05, methods.length, ...methods]));
  const greet = await reader.readBytes(2);
  if (greet[0] !== 0x05) {
    return { ok: false, message: t("probe.notSocks5") };
  }
  if (greet[1] === 0xff) {
    return { ok: false, message: t(hasAuth ? "probe.allAuthRejected" : "probe.authRequired") };
  }
  if (greet[1] === 0x02) {
    setStage("auth");
    if (!hasAuth) return { ok: false, message: t("probe.authNotConfigured") };
    const u = Buffer.from(proxy.username || "", "utf8");
    const p = Buffer.from(proxy.password || "", "utf8");
    if (u.length > 255 || p.length > 255) return { ok: false, message: t("probe.credTooLong") };
    socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
    const authResp = await reader.readBytes(2);
    if (authResp[1] !== 0x00) return { ok: false, message: t("probe.authFailed") };
  }
  setStage("tunnel");
  const host = Buffer.from(target.host, "utf8");
  socket.write(Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
    host,
    Buffer.from([(target.port >> 8) & 0xff, target.port & 0xff]),
  ]));
  const rep = await reader.readBytes(4);
  if (rep[1] !== 0x00) {
    const text = rep[1] >= 1 && rep[1] <= 8 ? t(`probe.rep${rep[1]}`) : t("probe.unknownError");
    return { ok: false, message: t("probe.socksRep", { target: `${target.host}:${target.port}`, rep: rep[1], text }) };
  }
  return { ok: true, message: t("probe.socksOk", { target: `${target.host}:${target.port}` }) };
}

/**
 * @param {net.Socket} socket @param {SocketReader} reader @param {ProxySettings} proxy
 * @param {{host: string, port: number}} target @param {(s: ProbeResult["stage"]) => void} setStage
 * @param {Translate} t
 */
async function httpConnect(socket, reader, proxy, target, setStage, t) {
  const hostPort = `${target.host}:${target.port}`;
  let req = `CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n`;
  if (proxy.username || proxy.password) {
    const token = Buffer.from(`${proxy.username || ""}:${proxy.password || ""}`, "utf8").toString("base64");
    req += `Proxy-Authorization: Basic ${token}\r\n`;
  }
  socket.write(req + "\r\n");
  const head = (await reader.readUntil("\r\n\r\n", 8192)).toString("latin1");
  const m = /^HTTP\/\d\.\d\s+(\d{3})([^\r\n]*)/.exec(head);
  if (!m) {
    return { ok: false, message: t("probe.notHttp") };
  }
  const code = Number(m[1]);
  if (code === 407) {
    setStage("auth");
    return { ok: false, message: t("probe.http407") };
  }
  setStage("tunnel");
  if (code !== 200) return { ok: false, message: t("probe.httpFail", { code, reason: m[2] }) };
  return { ok: true, message: t("probe.httpOk", { target: hostPort }) };
}

module.exports = { probeProxy, DEFAULT_TARGET };
