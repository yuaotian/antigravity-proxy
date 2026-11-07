// @ts-check
"use strict";

/**
 * 安装目录与补丁文件定位（单一职责：只做路径解析与只读探测，不做任何写操作）。
 *
 * 依据：
 * - vscode.env.appRoot = <安装目录>/resources/app（Antigravity IDE 为 VS Code 二开，结构一致）
 * - DLL 优先读取自身所在目录的 config.json（src/core/Config.hpp），因此配置文件与 version.dll 同级
 */

const fs = require("fs");
const path = require("path");

/** 可能的主程序名（Antigravity IDE 为主，保留常见 VS Code 系兼容） */
const KNOWN_EXE_NAMES = ["Antigravity IDE.exe", "Antigravity.exe", "Code.exe"];

/**
 * @typedef {Object} InstallInfo
 * @property {boolean} supported   当前平台是否支持（仅 Windows：补丁为 version.dll 劫持）
 * @property {string} installDir   安装目录（与主程序同级）
 * @property {string} exePath      主程序完整路径（用于重启）
 * @property {string} dllPath      version.dll 路径
 * @property {string} configPath   config.json 路径
 * @property {string} logsDir      DLL 日志目录
 */

/**
 * 由 appRoot 推导安装目录，并探测主程序路径。
 * @param {string} appRoot vscode.env.appRoot
 * @returns {InstallInfo}
 */
function resolveInstallInfo(appRoot) {
  const installDir = path.resolve(appRoot, "..", "..");
  let exePath = KNOWN_EXE_NAMES.map((n) => path.join(installDir, n)).find((p) => fs.existsSync(p)) || "";
  if (!exePath) {
    // 兜底：扩展宿主由主程序以 utility 进程方式拉起，execPath 即主程序
    exePath = process.execPath;
  }
  return {
    supported: process.platform === "win32",
    installDir,
    exePath,
    dllPath: path.join(installDir, "version.dll"),
    configPath: path.join(installDir, "config.json"),
    logsDir: path.join(installDir, "logs"),
  };
}

/**
 * 进程内结果缓存：version.dll 只会在进程启动时被加载器载入，进程生命周期内“是否已加载”不会变化，
 * 缓存后周期刷新无需重复生成诊断报告。
 * @type {Map<string, boolean | null>}
 */
const loadedCache = new Map();

/**
 * 判断指定 DLL 是否已被“当前进程”（扩展宿主）加载。
 * 扩展宿主进程由主进程创建，DLL 生效时会通过 version.dll 侧载或子进程注入进入本进程，
 * 因此可作为“补丁是否真正生效”的直接证据（比单纯判断文件存在更可靠）。
 * @param {string} dllPath
 * @returns {boolean | null} true=已加载；false=未加载；null=无法判断（运行时不支持诊断报告）
 */
function isDllLoadedInThisProcess(dllPath) {
  const target = path.resolve(dllPath).toLowerCase();
  if (loadedCache.has(target)) return /** @type {boolean | null} */ (loadedCache.get(target));
  const reporter = /** @type {any} */ (process).report;
  let result = /** @type {boolean | null} */ (null);
  if (reporter && typeof reporter.getReport === "function") {
    const prevExclude = reporter.excludeNetwork;
    try {
      // 关闭网络信息采集：默认会对每个 socket 句柄做同步反向 DNS，
      // 实测补丁未生效（连接直连）时可阻塞整个扩展宿主约 14 秒；用完即恢复，避免影响同宿主的其它扩展
      reporter.excludeNetwork = true;
      const shared = reporter.getReport()?.sharedObjects;
      if (Array.isArray(shared)) {
        result = shared.some((/** @type {string} */ p) => typeof p === "string" && path.resolve(p).toLowerCase() === target);
      }
    } catch {
      result = null;
    } finally {
      reporter.excludeNetwork = prevExclude;
    }
  }
  loadedCache.set(target, result);
  return result;
}

/**
 * 读取文件元信息（不存在返回 null）。
 * @param {string} filePath
 * @returns {{ size: number, mtimeMs: number } | null}
 */
function statOrNull(filePath) {
  try {
    const st = fs.statSync(filePath);
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

module.exports = { resolveInstallInfo, isDllLoadedInThisProcess, statOrNull, KNOWN_EXE_NAMES };
