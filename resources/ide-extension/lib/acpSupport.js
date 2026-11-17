// @ts-check
"use strict";

/**
 * 外部编辑器 ACP 代理支持（Issue #164）——检测与配置生成（不依赖 vscode API，便于单元测试）。
 *
 * 背景（详见 docs/acp.md）：
 * - ACP（Agent Client Protocol）客户端（JetBrains / Zed / VS Code ACP Client 等）以子进程方式启动 Agent，
 *   父进程不是 Antigravity，因此 IDE 的 version.dll 注入链覆盖不到；
 * - Google 提供两种 Agent：`agy acp`（Antigravity CLI 子命令）与 ACP Registry 分发的 `agy_acp_server.exe`；
 * - 解决方式：把 Agent 命令改成 `agy-acp-proxy.exe <真实 Agent> [参数]`，包装器注入同目录的代理 DLL。
 *
 * 本模块只做三件事：找出本机的 Agent、生成各编辑器的配置片段、安全地合并 JetBrains acp.json。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const Core = require("./core");

/** 包装器文件名（与 CMake 目标 / 发布包一致） */
const ACP_WRAPPER_NAME = "agy-acp-proxy.exe";
/** ACP Registry 版服务端（antigravity-acp/agent.json 中 windows 的 cmd） */
const ACP_SERVER_EXE = "agy_acp_server.exe";
/** 写入各编辑器的 Agent 名称（与官方 “Antigravity” 区分，避免覆盖用户已有条目） */
const ACP_AGENT_NAME = "Antigravity (Proxy)";

/** 识别“未经包装器的 Antigravity Agent”所用的可执行文件名 */
const ANTIGRAVITY_AGENT_EXES = Object.freeze(["agy", "agy.exe", "agy_acp_server", ACP_SERVER_EXE]);

/** 扫描 Registry 安装目录时跳过的大目录（只影响速度，不影响正确性） */
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", "index", "jcef_cache", "log", "logs"]);

/**
 * @typedef {Object} AcpTarget
 * @property {"agy" | "registry" | "custom"} kind  agy=`agy acp`；registry=agy_acp_server.exe；custom=用户手选
 * @property {string} path      可执行文件绝对路径
 * @property {"ide" | "cli" | "registry" | "custom"} source  来源（用于界面文案）
 * @property {string} [version] 能读到时给出版本号
 */

/**
 * 读取文件元信息，不存在返回 null（只认普通文件）。
 * @param {string} filePath
 * @param {typeof fs} [fsImpl]
 */
function isFile(filePath, fsImpl = fs) {
  try {
    return fsImpl.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * 已知位置的 agy.exe（只读探测）。
 * - ~/.gemini/bin/agy.exe：Antigravity IDE 下载并自动更新的 CLI（1.5.x 起含 `agy acp`）；
 * - %LOCALAPPDATA%\agy\bin、%LOCALAPPDATA%\Programs\Antigravity CLI：独立安装的 Antigravity CLI。
 * @param {{ env?: NodeJS.ProcessEnv, homeDir?: string, fsImpl?: typeof fs }} [opts]
 * @returns {AcpTarget[]}
 */
function findAgyCandidates(opts = {}) {
  const env = opts.env || process.env;
  const homeDir = opts.homeDir || os.homedir();
  const fsImpl = opts.fsImpl || fs;
  const localAppData = env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local");

  /** @type {AcpTarget[]} */
  const result = [];
  const seen = new Set();
  /** @param {string} p @param {"ide" | "cli"} source @param {string} [version] */
  const add = (p, source, version) => {
    const key = path.resolve(p).toLowerCase();
    if (seen.has(key) || !isFile(p, fsImpl)) return;
    seen.add(key);
    result.push({ kind: "agy", path: p, source, ...(version ? { version } : {}) });
  };

  const ideBin = path.join(homeDir, ".gemini", "bin");
  add(path.join(ideBin, "agy.exe"), "ide", readIdeAgyVersion(ideBin, fsImpl));
  add(path.join(localAppData, "agy", "bin", "agy.exe"), "cli");
  add(path.join(localAppData, "Programs", "Antigravity CLI", "agy.exe"), "cli");
  return result;
}

/**
 * IDE 托管的 agy.exe 旁边有 agy.version.json（{ version: "1.5.10", ... }）。
 * @param {string} binDir @param {typeof fs} fsImpl
 * @returns {string | undefined}
 */
function readIdeAgyVersion(binDir, fsImpl) {
  try {
    const raw = JSON.parse(fsImpl.readFileSync(path.join(binDir, "agy.version.json"), "utf8"));
    return typeof raw?.version === "string" && raw.version ? raw.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * ACP 客户端可能存放 Registry 下载物的根目录（只返回存在的目录）。
 * 各客户端的具体子目录未公开且随版本变化，因此只给出根目录，由有界扫描负责定位。
 * @param {{ env?: NodeJS.ProcessEnv, homeDir?: string, fsImpl?: typeof fs }} [opts]
 * @returns {string[]}
 */
function defaultRegistryRoots(opts = {}) {
  const env = opts.env || process.env;
  const homeDir = opts.homeDir || os.homedir();
  const fsImpl = opts.fsImpl || fs;
  const localAppData = env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local");
  const appData = env.APPDATA || path.join(homeDir, "AppData", "Roaming");

  const roots = [
    path.join(localAppData, "JetBrains"),
    path.join(appData, "JetBrains"),
    path.join(homeDir, ".jetbrains"),
    path.join(localAppData, "Zed"),
    path.join(appData, "Zed"),
    path.join(appData, "app.codeg"),
  ];
  // Android Studio 的目录形如 %LOCALAPPDATA%\Google\AndroidStudio2025.2（只取这一类，避免扫描 Chrome 数据）
  for (const googleDir of [path.join(localAppData, "Google"), path.join(appData, "Google")]) {
    try {
      for (const name of fsImpl.readdirSync(googleDir)) {
        if (/^androidstudio/i.test(name)) roots.push(path.join(googleDir, name));
      }
    } catch { /* 目录不存在 */ }
  }
  return roots.filter((dir) => {
    try {
      return fsImpl.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * 有界广度优先扫描，查找 Registry 安装的 agy_acp_server.exe（异步，不阻塞扩展宿主）。
 * @param {{ roots: string[], maxDepth?: number, maxDirs?: number, fsp?: typeof fs.promises }} opts
 * @returns {Promise<AcpTarget[]>}
 */
async function findRegistryServers(opts) {
  const maxDepth = opts.maxDepth ?? 7;
  const maxDirs = opts.maxDirs ?? 6000;
  const fsp = opts.fsp || fs.promises;
  /** @type {AcpTarget[]} */
  const found = [];
  /** @type {Array<{ dir: string, depth: number }>} */
  const queue = opts.roots.map((dir) => ({ dir, depth: 0 }));
  let visited = 0;

  while (queue.length > 0 && visited < maxDirs) {
    const { dir, depth } = /** @type {{ dir: string, depth: number }} */ (queue.shift());
    visited++;
    /** @type {fs.Dirent[]} */
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.toLowerCase() === ACP_SERVER_EXE) {
        const exePath = path.join(dir, entry.name);
        const version = guessVersionFromPath(exePath);
        found.push({ kind: "registry", path: exePath, source: "registry", ...(version ? { version } : {}) });
      } else if (entry.isDirectory() && depth < maxDepth && !SKIP_DIR_NAMES.has(entry.name.toLowerCase())) {
        queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    }
  }
  // 新版本优先：同一客户端可能保留多个版本目录
  return found.sort((a, b) => compareVersionDesc(a.version, b.version));
}

/**
 * Registry 客户端通常按 <agent-id>/<version>/ 存放，从路径中取最后一个形如 1.5.0 的目录名。
 * @param {string} exePath
 * @returns {string | undefined}
 */
function guessVersionFromPath(exePath) {
  const parts = path.dirname(exePath).split(/[\\/]+/).reverse();
  const hit = parts.find((p) => /^v?\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(p));
  return hit ? hit.replace(/^v/, "") : undefined;
}

/** @param {string | undefined} a @param {string | undefined} b */
function compareVersionDesc(a, b) {
  const pa = String(a || "0").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "0").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] || 0) - (pa[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * 包装器命令：`agy acp` 需要追加子命令参数，Registry 版直接启动即可（Windows 无额外参数）。
 * @param {string} wrapperPath
 * @param {AcpTarget} target
 * @returns {{ command: string, args: string[] }}
 */
function buildAgentCommand(wrapperPath, target) {
  const isAgy = target.kind === "agy" || /^agy(\.exe)?$/i.test(path.basename(target.path));
  return { command: wrapperPath, args: isAgy ? [target.path, "acp"] : [target.path] };
}

/**
 * Windows 命令行参数加引号（仅用于“复制命令”，不参与进程启动）。
 * @param {string} arg
 */
function quoteArg(arg) {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/**
 * 各编辑器的配置片段（结构以官方文档为准：antigravity.google/docs/ide/extensions/acp）。
 * @param {{ command: string, args: string[] }} cmd
 */
function buildClientSnippets(cmd) {
  const entry = { command: cmd.command, args: cmd.args };
  return {
    zed: { agent_servers: { [ACP_AGENT_NAME]: { type: "custom", ...entry } } },
    jetbrains: { agent_servers: { [ACP_AGENT_NAME]: entry } },
    vscode: { "acp.agents": { [ACP_AGENT_NAME]: entry } },
    commandLine: [cmd.command, ...cmd.args].map(quoteArg).join(" "),
  };
}

/**
 * 把包装器条目合并进 JetBrains 的 ~/.jetbrains/acp.json。
 * 只改写“严格 JSON”文件：含注释/尾逗号时改写会丢失用户内容，返回 comments 由调用方降级为“复制片段”。
 * @param {string | null | undefined} existingText 现有文件内容（不存在传 null）
 * @param {{ command: string, args: string[] }} cmd
 * @returns {{ ok: true, text: string } | { ok: false, reason: "comments" | "invalid" }}
 */
function mergeJetBrainsAcpJson(existingText, cmd) {
  /** @type {any} */
  let obj = {};
  // 记事本保存的 UTF-8 可能带 BOM：去掉后再按严格 JSON 解析，避免被误判为“含注释”
  const src = String(existingText || "").replace(/^﻿/, "");
  if (src.trim()) {
    try {
      obj = JSON.parse(src);
    } catch {
      try {
        Core.parseJsonc(src);
        return { ok: false, reason: "comments" };
      } catch {
        return { ok: false, reason: "invalid" };
      }
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, reason: "invalid" };
  if (obj.agent_servers === undefined) obj.agent_servers = {};
  if (!obj.agent_servers || typeof obj.agent_servers !== "object" || Array.isArray(obj.agent_servers)) {
    return { ok: false, reason: "invalid" };
  }
  obj.agent_servers[ACP_AGENT_NAME] = { command: cmd.command, args: cmd.args };
  return { ok: true, text: JSON.stringify(obj, null, 2) + "\n" };
}

/**
 * 分析编辑器配置里的 agent_servers（JetBrains acp.json / Zed settings.json 结构相同），用于启动时提示。
 * @param {string | null | undefined} text
 * @returns {{ proxied: boolean, unwrapped: boolean }}
 *   proxied=已有经包装器启动的条目；unwrapped=存在直接启动 agy / agy_acp_server 的条目（不走代理）
 */
function analyzeAgentServers(text) {
  const result = { proxied: false, unwrapped: false };
  if (!text || !text.trim()) return result;
  /** @type {any} */
  let obj;
  try {
    obj = Core.parseJsonc(text);
  } catch {
    return result;
  }
  const servers = obj && typeof obj === "object" ? obj.agent_servers : null;
  if (!servers || typeof servers !== "object") return result;
  for (const value of Object.values(servers)) {
    const command = typeof value?.command === "string" ? value.command : "";
    const base = path.win32.basename(command).toLowerCase();
    if (base === ACP_WRAPPER_NAME) result.proxied = true;
    else if (ANTIGRAVITY_AGENT_EXES.includes(base)) result.unwrapped = true;
  }
  return result;
}

/** @param {string} [homeDir] */
function jetBrainsAcpJsonPath(homeDir = os.homedir()) {
  return path.join(homeDir, ".jetbrains", "acp.json");
}

/** @param {NodeJS.ProcessEnv} [env] @param {string} [homeDir] */
function zedSettingsPath(env = process.env, homeDir = os.homedir()) {
  return path.join(env.APPDATA || path.join(homeDir, "AppData", "Roaming"), "Zed", "settings.json");
}

module.exports = {
  ACP_WRAPPER_NAME,
  ACP_SERVER_EXE,
  ACP_AGENT_NAME,
  findAgyCandidates,
  defaultRegistryRoots,
  findRegistryServers,
  guessVersionFromPath,
  buildAgentCommand,
  buildClientSnippets,
  mergeJetBrainsAcpJson,
  analyzeAgentServers,
  jetBrainsAcpJsonPath,
  zedSettingsPath,
  quoteArg,
};
