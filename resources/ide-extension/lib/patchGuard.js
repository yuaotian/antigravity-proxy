// @ts-check
"use strict";

/**
 * 补丁守护（P2）：IDE 自动更新会重建安装目录并清除 version.dll / config.json，
 * 而插件安装在 ~/.antigravity-ide/extensions（不受更新影响），因此可在下次启动时发现并恢复。
 *
 * 恢复来源（按优先级）：
 * - version.dll：插件内置 payload/version.dll（与本插件同一发布版本构建）
 * - config.json：插件全局存储中的“最后一次可用配置”（用户自己的端口/规则）→ 其次 payload/config.json 默认模板
 *
 * 只做文件层面的检测与恢复，不结束任何进程；DLL 需重启 IDE 才会加载。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { isDllLoadedInThisProcess, statOrNull, readPeArch, KNOWN_EXE_NAMES } = require("./installInfo");
const { ACP_WRAPPER_NAME } = require("./acpSupport");
const I18n = require("../media/i18n");

// 未传入翻译函数时使用简体中文
const DEFAULT_T = I18n.createT("zh-cn");

/**
 * @typedef {Object} PatchStatus
 * @property {boolean} dllExists
 * @property {boolean | null} dllLoaded     本进程是否已加载安装目录下的 version.dll（null=无法判断）
 * @property {boolean} configExists
 * @property {boolean} payloadAvailable     插件是否携带可用于恢复的 DLL
 * @property {boolean} needsRestart         文件就绪但当前进程未加载（新部署/刚恢复）
 * @property {string} [dllSha256]
 */

class PatchGuard {
  /**
   * @param {import("./installInfo").InstallInfo} info
   * @param {import("./configStore").ConfigStore} store
   * @param {string} extensionPath
   * @param {(key: string, params?: Record<string, any>) => string} [t] 翻译函数（随界面语言切换）
   * @param {{ shouldRestoreAcpWrapper?: () => boolean }} [options]
   *   shouldRestoreAcpWrapper：用户曾通过向导部署过 ACP 包装器时返回 true，IDE 更新清空目录后一并恢复
   */
  constructor(info, store, extensionPath, t = DEFAULT_T, options = {}) {
    this.t = t;
    this.info = info;
    this.store = store;
    this.payloadDir = path.join(extensionPath, "payload");
    this.payloadDll = path.join(this.payloadDir, "version.dll");
    this.payloadConfig = path.join(this.payloadDir, "config.json");
    // ACP 启动包装器（Issue #164）：部署在 IDE 安装目录，与 version.dll / config.json 共用同一份代理配置
    this.payloadAcpWrapper = path.join(this.payloadDir, ACP_WRAPPER_NAME);
    this.acpWrapperPath = path.join(info.installDir, ACP_WRAPPER_NAME);
    this.shouldRestoreAcpWrapper = options.shouldRestoreAcpWrapper || (() => false);
  }

  /**
   * ACP 包装器状态（只读）。
   * @returns {{ payloadAvailable: boolean, deployed: boolean, upToDate: boolean, path: string }}
   */
  checkAcpWrapper() {
    const payloadAvailable = !!statOrNull(this.payloadAcpWrapper);
    const deployed = !!statOrNull(this.acpWrapperPath);
    const upToDate = payloadAvailable && deployed &&
      sha256OrUndefined(this.payloadAcpWrapper) === sha256OrUndefined(this.acpWrapperPath);
    return { payloadAvailable, deployed, upToDate, path: this.acpWrapperPath };
  }

  /**
   * 解析目标 IDE 主程序的 PE 架构；找不到有效主程序（如纯文件测试夹具）时返回 null。
   * @returns {"x64" | "x86" | "arm64" | "unknown" | null}
   */
  resolveTargetArch() {
    const direct = readPeArch(this.info.exePath);
    if (direct) return direct;
    for (const name of KNOWN_EXE_NAMES) {
      const candidate = readPeArch(path.join(this.info.installDir, name));
      if (candidate) return candidate;
    }
    return null;
  }

  /**
   * 写入原生二进制前校验架构是否与目标 IDE 一致（防止 Open VSX 的 x64 VSIX 错写入原生 ARM64 IDE）。
   * 若主程序路径无法读取 PE 头：纯测试桩 payload（非 PE）继续兼容放行；真实 PE 负载在 Windows 下按 process.arch 保底 fail-closed。
   * @param {string} payloadFile
   * @returns {string | null} 不匹配时返回本地化错误提示，匹配或纯测试桩夹具时返回 null
   */
  checkPayloadArch(payloadFile) {
    const payloadArch = readPeArch(payloadFile);
    let targetArch = this.resolveTargetArch();
    if (!targetArch) {
      if (!payloadArch) return null;
      if (process.platform === "win32") {
        targetArch = process.arch === "arm64" ? "arm64"
          : process.arch === "x64" ? "x64"
          : process.arch === "ia32" ? "x86"
          : "unknown";
      } else {
        return null;
      }
    }
    if (!payloadArch || payloadArch !== targetArch) {
      return this.t("guard.archMismatch", {
        payloadArch: payloadArch || "unknown",
        targetArch,
      });
    }
    return null;
  }

  /**
   * 部署/更新 ACP 包装器到 IDE 安装目录（内容一致时不重复写入）。
   * 正在被编辑器使用的旧包装器无法覆盖（EBUSY/EPERM），此时返回错误由调用方提示稍后重试。
   * @returns {{ ok: true, changed: boolean, path: string } | { ok: false, error: string }}
   */
  deployAcpWrapper() {
    const s = this.checkAcpWrapper();
    if (!s.payloadAvailable) return { ok: false, error: this.t("acp.noPayload") };
    const archError = this.checkPayloadArch(this.payloadAcpWrapper);
    if (archError) return { ok: false, error: archError };
    if (s.upToDate) return { ok: true, changed: false, path: s.path };
    try {
      atomicCopy(this.payloadAcpWrapper, this.acpWrapperPath, this.t);
      return { ok: true, changed: true, path: s.path };
    } catch (e) {
      const err = /** @type {NodeJS.ErrnoException} */ (e);
      if (err.code === "EPERM" || err.code === "EACCES" || err.code === "EBUSY") {
        return { ok: false, error: this.t("acp.wrapperBusy", { path: s.path }) };
      }
      return { ok: false, error: `${err.code || "ERROR"}: ${err.message}` };
    }
  }

  /** @returns {PatchStatus} */
  check() {
    const dllExists = !!statOrNull(this.info.dllPath);
    const dllLoaded = dllExists ? isDllLoadedInThisProcess(this.info.dllPath) : false;
    return {
      dllExists,
      dllLoaded,
      configExists: !!statOrNull(this.info.configPath),
      payloadAvailable: !!statOrNull(this.payloadDll),
      needsRestart: dllExists && dllLoaded === false,
      dllSha256: dllExists ? sha256OrUndefined(this.info.dllPath) : undefined,
    };
  }

  /** 补丁是否被清除（任一关键文件缺失） */
  isWiped() {
    const s = this.check();
    return !s.dllExists || !s.configExists;
  }

  /**
   * 恢复缺失文件（已存在的文件不覆盖，避免误替换用户自行升级的 DLL / 修改的配置）。
   * @returns {{ ok: boolean, restored: string[], error?: string }}
   */
  restore() {
    /** @type {string[]} */
    const restored = [];
    try {
      if (!statOrNull(this.info.dllPath)) {
        if (!statOrNull(this.payloadDll)) {
          return { ok: false, restored, error: this.t("guard.noPayload") };
        }
        const dllArchError = this.checkPayloadArch(this.payloadDll);
        if (dllArchError) {
          return { ok: false, restored, error: dllArchError };
        }
        atomicCopy(this.payloadDll, this.info.dllPath, this.t);
        restored.push(this.t("ext.restoredDll"));
      }
      if (!statOrNull(this.info.configPath)) {
        const lastGood = this.store.loadLastGood();
        if (lastGood) {
          // 同样走临时文件 + rename，避免 DLL 读到半写入的配置
          const tmp = `${this.info.configPath}.agp-${process.pid}-${Date.now()}.tmp`;
          fs.writeFileSync(tmp, JSON.stringify(lastGood, null, 2) + "\n", "utf8");
          fs.renameSync(tmp, this.info.configPath);
          restored.push(this.t("ext.restoredConfigLastGood"));
        } else if (statOrNull(this.payloadConfig)) {
          atomicCopy(this.payloadConfig, this.info.configPath, this.t);
          restored.push(this.t("ext.restoredConfigDefault"));
        }
      }
      // 只恢复用户曾部署过的 ACP 包装器：其它编辑器的 Agent 配置指向这个路径，缺失会导致 Agent 无法启动
      if (this.shouldRestoreAcpWrapper() && !statOrNull(this.acpWrapperPath) && statOrNull(this.payloadAcpWrapper)) {
        const acpArchError = this.checkPayloadArch(this.payloadAcpWrapper);
        if (acpArchError) {
          return { ok: false, restored, error: acpArchError };
        }
        atomicCopy(this.payloadAcpWrapper, this.acpWrapperPath, this.t);
        restored.push(ACP_WRAPPER_NAME);
      }
      return { ok: true, restored };
    } catch (e) {
      const err = /** @type {NodeJS.ErrnoException} */ (e);
      const perm = err.code === "EPERM" || err.code === "EACCES";
      return {
        ok: false,
        restored,
        error: perm
          ? this.t("guard.noPermission", { dir: this.info.installDir })
          : `${err.code || "ERROR"}: ${err.message}`,
      };
    }
  }
}

/**
 * 临时文件 + rename 的原子复制，并校验 SHA256，避免半写入的 DLL 导致 IDE 无法启动。
 * @param {string} src @param {string} dst
 * @param {(key: string) => string} [t] 翻译函数
 */
function atomicCopy(src, dst, t = DEFAULT_T) {
  const tmp = `${dst}.agp-${process.pid}-${Date.now()}.tmp`;
  fs.copyFileSync(src, tmp);
  try {
    if (sha256OrUndefined(src) !== sha256OrUndefined(tmp)) throw new Error(t("guard.shaMismatch"));
    fs.renameSync(tmp, dst);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 忽略清理失败 */ }
    throw e;
  }
}

/** @param {string} filePath */
function sha256OrUndefined(filePath) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return undefined;
  }
}

module.exports = { PatchGuard, atomicCopy };
