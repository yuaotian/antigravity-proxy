// @ts-check
"use strict";

/**
 * GitHub Release 相关的纯逻辑（单一职责：解析/比较/选资产/拼镜像，不做任何 IO，便于单测）。
 *
 * 约定与仓库现有实现保持一致：
 * - Release API 与 DLL 的 UpdateChecker 使用同一个地址（src/update/UpdateChecker.cpp:25）；
 * - 镜像按「前缀 + 原始 URL」拼接（同 src/update/UpdateChecker.cpp 的 JoinMirrorUrl 与
 *   scripts/install-online.ps1 的 Get-Routes），因此镜像必须能转发 https://api.github.com/...；
 * - 只接受 https 镜像，避免把可执行安装包的下载降级成明文。
 */

/** @type {string} */
const REPO = "yuaotian/antigravity-proxy";
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASE_PAGE = `https://github.com/${REPO}/releases/latest`;
/** VSIX 资产里的架构标记（process.arch → 资产名片段） */
const ARCH_TAG = Object.freeze({ x64: "x64", ia32: "x86" });

/**
 * @typedef {{ name: string, size: number, url: string }} ReleaseAsset
 * @typedef {{ tag: string, version: string, name: string, body: string, htmlUrl: string, publishedAt: string, assets: ReleaseAsset[] }} ReleaseInfo
 */

/** 去掉前缀 v/V 与首尾空白 */
function normalizeVersion(version) {
  return String(version ?? "").trim().replace(/^[vV]/, "");
}

/**
 * 把版本拆成最多 4 段数字（"2.6.1" → [2,6,1]）；非数字部分忽略。
 * @param {string} version
 * @returns {number[]}
 */
function parseVersionParts(version) {
  const text = normalizeVersion(version);
  /** @type {number[]} */
  const parts = [];
  const re = /\d+/g;
  let m;
  while ((m = re.exec(text)) && parts.length < 4) parts.push(Number(m[0]));
  return parts;
}

/**
 * 比较两个版本号（缺位按 0 处理）。返回 -1/0/1。
 * @param {string} a
 * @param {string} b
 */
function compareVersions(a, b) {
  const pa = parseVersionParts(a);
  const pb = parseVersionParts(b);
  if (pa.length === 0 || pb.length === 0) return 0;
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const av = i < pa.length ? pa[i] : 0;
    const bv = i < pb.length ? pb[i] : 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

/** @param {string} current @param {string} latest */
function isNewer(current, latest) {
  return compareVersions(current, latest) < 0;
}

/**
 * 解析 releases/latest 的 JSON；字段缺失或类型不对时返回 null（调用方按"本次跳过"处理）。
 * @param {any} json
 * @returns {ReleaseInfo | null}
 */
function parseRelease(json) {
  if (!json || typeof json !== "object" || typeof json.tag_name !== "string" || !json.tag_name.trim()) return null;
  const assets = Array.isArray(json.assets)
    ? json.assets
        .filter((a) => a && typeof a.name === "string" && typeof a.browser_download_url === "string" && /^https:\/\//i.test(a.browser_download_url))
        .map((a) => ({ name: a.name, size: Number(a.size) || 0, url: a.browser_download_url }))
    : [];
  return {
    tag: json.tag_name.trim(),
    version: normalizeVersion(json.tag_name),
    name: typeof json.name === "string" && json.name.trim() ? json.name : json.tag_name.trim(),
    body: typeof json.body === "string" ? json.body : "",
    htmlUrl: typeof json.html_url === "string" && json.html_url ? json.html_url : RELEASE_PAGE,
    publishedAt: typeof json.published_at === "string" ? json.published_at : "",
    assets,
  };
}

/**
 * 按当前 IDE 架构挑出 VSIX 资产（Release 资产命名见 scripts/package-release.ps1:77,105）。
 * @param {ReleaseAsset[]} assets
 * @param {string} arch process.arch
 * @returns {ReleaseAsset | null}
 */
function pickVsixAsset(assets, arch) {
  const tag = ARCH_TAG[/** @type {keyof typeof ARCH_TAG} */ (arch)] || "";
  if (!tag) return null;
  const suffix = `-ide-extension-win-${tag}.vsix`;
  return assets.find((a) => a.name.toLowerCase().endsWith(suffix)) || null;
}

/**
 * 拼接镜像 URL：镜像必须是 https，返回空字符串表示该镜像不可用（调用方跳过）。
 * @param {string} mirror
 * @param {string} targetUrl
 */
function joinMirror(mirror, targetUrl) {
  const m = String(mirror ?? "").trim();
  const target = String(targetUrl ?? "").trim();
  if (!/^https:\/\//i.test(m) || !/^https:\/\//i.test(target)) return "";
  return (m.endsWith("/") ? m : m + "/") + target;
}

/** @param {string} mirror */
function mirrorHost(mirror) {
  try {
    return new URL(mirror).host || mirror;
  } catch {
    return String(mirror);
  }
}

/**
 * 构造「镜像」候选（按配置顺序）；直连候选由调用方追加在最后。
 * @param {string} targetUrl
 * @param {string[]} mirrors
 * @returns {{ label: string, url: string, mirror: string }[]}
 */
function buildMirrorCandidates(targetUrl, mirrors) {
  /** @type {{ label: string, url: string, mirror: string }[]} */
  const out = [];
  for (const mirror of Array.isArray(mirrors) ? mirrors : []) {
    const url = joinMirror(mirror, targetUrl);
    if (url) out.push({ label: mirrorHost(mirror), url, mirror: String(mirror) });
  }
  return out;
}

/**
 * 构造完整的源候选（顺序即优先级）：本地代理 → 各镜像 → 直连。
 * 与 scripts/install-online.ps1:287-301 的路线顺序保持一致。
 * @param {string} targetUrl
 * @param {{ proxy?: any, mirrors?: string[] }} opts
 * @returns {{ kind: "proxy" | "mirror" | "direct", label: string, url: string }[]}
 */
function buildSourceCandidates(targetUrl, opts = {}) {
  /** @type {{ kind: "proxy" | "mirror" | "direct", label: string, url: string }[]} */
  const out = [];
  const proxy = opts.proxy;
  if (proxy && proxy.host && Number.isInteger(proxy.port) && proxy.port > 0) {
    out.push({ kind: "proxy", label: "config proxy", url: targetUrl });
  }
  for (const c of buildMirrorCandidates(targetUrl, opts.mirrors || [])) {
    out.push({ kind: "mirror", label: c.label, url: c.url });
  }
  out.push({ kind: "direct", label: "direct", url: targetUrl });
  return out;
}

/**
 * 解析 SHA256SUMS.txt（sha256sum 标准格式：<64 hex>  <文件名>，兼容 *文件名）。
 * @param {string} text
 * @returns {Map<string, string>}
 */
function parseSha256Sums(text) {
  /** @type {Map<string, string>} */
  const map = new Map();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^([a-fA-F0-9]{64})\s+\*?(\S.*)$/.exec(line.trim());
    if (!m) continue;
    map.set(m[2].trim(), m[1].toLowerCase());
  }
  return map;
}

module.exports = {
  API_URL,
  RELEASE_PAGE,
  REPO,
  ARCH_TAG,
  normalizeVersion,
  parseVersionParts,
  compareVersions,
  isNewer,
  parseRelease,
  pickVsixAsset,
  joinMirror,
  mirrorHost,
  buildMirrorCandidates,
  buildSourceCandidates,
  parseSha256Sums,
};
