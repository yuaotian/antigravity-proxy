// @ts-check
"use strict";

/**
 * 代理出口 IP / 运营商查询（单一职责：经代理访问 ipinfo.io、解析结果、给出机房特征判断）。
 *
 * 为什么要经代理：用户关心的是「Antigravity 看到的出口」而不是本机网卡地址；
 * 走本地代理查询才能得到与 Gemini/Antigravity 实际链路一致的出口。若代理不可达，
 * 才回退直连并在结果里明确标注 via=direct，避免把直连出口误当成代理出口。
 *
 * 数据来源：https://ipinfo.io/json（样例字段 ip/city/region/country/org/timezone）。
 */

const { request, describeNetworkError } = require("./httpClient");
const I18n = require("../media/i18n");

const IPINFO_URL = "https://ipinfo.io/json";
/** 结果缓存：ipinfo 免费额度有限，默认 30 分钟内复用（与 UI 的刷新间隔解耦） */
const CACHE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8000;

/** 机房/托管关键字：与 DLL 的诊断保持一致（src/hooks/Hooks.cpp:493-505），避免两边结论不一致 */
const DATACENTER_KEYWORDS = Object.freeze([
  "g-core", "digitalocean", "linode", "vultr", "hetzner", "ovh", "leaseweb",
  "contabo", "choopa", "scaleway", "oracle cloud", "google cloud", "azure",
  "amazon", "aws", "alibaba cloud", "tencent cloud", "cloudflare", "datacenter",
  "data center", "hosting", "colo", "colocation", "server",
]);

const DEFAULT_T = I18n.createT("zh-cn");

/**
 * 拆分 ipinfo 的 org 字段："AS4657 StarHub Ltd" → { asn: "AS4657", orgName: "StarHub Ltd" }。
 * 没有 AS 前缀时原样作为 orgName。
 * @param {string} raw
 */
function splitOrg(raw) {
  const org = String(raw ?? "").trim();
  const m = /^AS(\d+)\s+(.*)$/i.exec(org);
  if (!m) return { asn: "", orgName: org };
  return { asn: `AS${m[1]}`, orgName: m[2].trim() };
}

/** @param {string} org */
function isDatacenterOrg(org) {
  const lower = String(org ?? "").toLowerCase();
  return DATACENTER_KEYWORDS.some((keyword) => lower.includes(keyword));
}

/** IPv4 /24 前缀（与 DLL 日志里的 prefix 对齐）；IPv6 或异常返回空串 */
function ipv4Prefix24(ip) {
  const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(String(ip ?? ""));
  return m ? `${m[1]}.0/24` : "";
}

/**
 * 解析 ipinfo 响应。缺少 ip 字段视为无效响应（抛出可读错误）。
 * @param {any} json
 */
function parseIpInfo(json) {
  if (!json || typeof json !== "object" || typeof json.ip !== "string" || !json.ip.trim()) {
    throw new Error("ipinfo response has no ip field");
  }
  const orgRaw = typeof json.org === "string" ? json.org.trim() : "";
  const { asn, orgName } = splitOrg(orgRaw);
  return {
    ip: json.ip.trim(),
    city: typeof json.city === "string" ? json.city : "",
    region: typeof json.region === "string" ? json.region : "",
    country: typeof json.country === "string" ? json.country : "",
    loc: typeof json.loc === "string" ? json.loc : "",
    timezone: typeof json.timezone === "string" ? json.timezone : "",
    postal: typeof json.postal === "string" ? json.postal : "",
    org: orgRaw,
    asn,
    orgName,
    datacenter: isDatacenterOrg(orgRaw),
    prefix24: ipv4Prefix24(json.ip.trim()),
  };
}

/**
 * 出口信息查询服务：缓存 + 并发去重 + 代理优先/直连兜底。
 * 事件：onDidChange(cb) 在状态变化时触发（UI 只读 state）。
 */
class IpInfoService {
  /**
   * @param {{ getProxy: () => ({ host: string, port: number, type?: string, username?: string, password?: string } | null), t?: (key: string, params?: Record<string, any>) => string, now?: () => number, timeoutMs?: number }} deps
   */
  constructor(deps) {
    this.getProxy = deps.getProxy;
    this.t = deps.t || DEFAULT_T;
    this.now = deps.now || Date.now;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    /** @type {{ status: "idle" | "loading" | "ok" | "error", data: any, via: "proxy" | "direct" | "", checkedAt: number, error: string, proxyError: string }} */
    this.state = { status: "idle", data: null, via: "", checkedAt: 0, error: "", proxyError: "" };
    /** @type {Set<(state: any) => void>} */
    this.listeners = new Set();
    /** @type {Promise<any> | null} */
    this.inflight = null;
  }

  /**
   * 订阅状态变化。
   * 返回 VS Code 风格的 Disposable（调用方会直接放进 context.subscriptions；
   * 若返回裸函数，扩展停用时 dispose() 会抛 AggregateError）。
   * @param {(state: any) => void} cb
   */
  onDidChange(cb) {
    this.listeners.add(cb);
    return { dispose: () => { this.listeners.delete(cb); } };
  }

  emit() {
    for (const cb of this.listeners) {
      try { cb(this.state); } catch { /* 单个订阅者异常不影响其它订阅者 */ }
    }
  }

  /**
   * 取当前出口信息：缓存有效且非强制刷新时直接返回。
   * @param {{ force?: boolean }} [opts]
   */
  async get(opts = {}) {
    const fresh = this.state.status === "ok" && this.now() - this.state.checkedAt < CACHE_TTL_MS;
    if (!opts.force && fresh) return this.state;
    if (this.inflight) return this.inflight;
    this.state = { ...this.state, status: "loading", error: "" };
    this.emit();
    this.inflight = this.fetchOnce().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async fetchOnce() {
    const proxy = this.getProxy();
    const t = this.t;
    /** @type {{ status: "ok" | "error", data: any, via: "proxy" | "direct" | "", checkedAt: number, error: string, proxyError: string }} */
    let result;

    if (proxy) {
      try {
        const r = await request(IPINFO_URL, { proxy, timeoutMs: this.timeoutMs });
        const data = parseIpInfo(JSON.parse(r.body.toString("utf8")));
        result = { status: "ok", data, via: "proxy", checkedAt: this.now(), error: "", proxyError: "" };
      } catch (e) {
        // 代理失败不直接判死：再试直连，但把代理错误保留给 UI（用户需要知道是代理问题还是网络问题）
        const proxyError = describeNetworkError(e, t);
        try {
          const r = await request(IPINFO_URL, { proxy: null, timeoutMs: this.timeoutMs });
          const data = parseIpInfo(JSON.parse(r.body.toString("utf8")));
          result = { status: "ok", data, via: "direct", checkedAt: this.now(), error: "", proxyError };
        } catch (e2) {
          result = { status: "error", data: null, via: "", checkedAt: this.now(), error: describeNetworkError(e2, t), proxyError };
        }
      }
    } else {
      try {
        const r = await request(IPINFO_URL, { timeoutMs: this.timeoutMs });
        const data = parseIpInfo(JSON.parse(r.body.toString("utf8")));
        result = { status: "ok", data, via: "direct", checkedAt: this.now(), error: "", proxyError: "" };
      } catch (e) {
        result = { status: "error", data: null, via: "", checkedAt: this.now(), error: describeNetworkError(e, t), proxyError: "" };
      }
    }

    this.state = result;
    this.emit();
    return this.state;
  }
}

module.exports = {
  IpInfoService,
  parseIpInfo,
  splitOrg,
  isDatacenterOrg,
  ipv4Prefix24,
  DATACENTER_KEYWORDS,
  IPINFO_URL,
  CACHE_TTL_MS,
};
