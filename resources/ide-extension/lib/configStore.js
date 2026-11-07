// @ts-check
"use strict";

/**
 * config.json 读写（单一职责：文件 IO + 备份；不关心 UI 与校验规则）。
 *
 * 安全约束：
 * - 写入采用“同目录临时文件 + rename”原子替换，避免写一半导致 DLL 读取到残缺 JSON；
 * - 每次覆盖前把旧文件备份到插件全局存储（不在安装目录，IDE 更新不会清掉），最多保留 10 份；
 * - 记录“最后一次可用配置”，供补丁守护在 IDE 更新清空安装目录后恢复用户自己的配置。
 */

const fs = require("fs");
const path = require("path");
const Core = require("./core");
const I18n = require("../media/i18n");

const MAX_BACKUPS = 10;
const LAST_GOOD_NAME = "last-good-config.json";
// 未传入翻译函数时使用简体中文
const DEFAULT_T = I18n.createT("zh-cn");

/** @typedef {(key: string, params?: Record<string, any>) => string} Translate */

/**
 * @typedef {Object} ReadResult
 * @property {"ok" | "missing" | "invalid" | "error"} status
 * @property {any} [raw]        解析后的对象（status=ok）
 * @property {string} [text]    原始文本（ok/invalid）
 * @property {string} [error]   错误描述（invalid/error）
 */

class ConfigStore {
  /**
   * @param {string} configPath  安装目录下的 config.json
   * @param {string} storageDir  插件全局存储目录（context.globalStorageUri.fsPath）
   * @param {Translate} [t]      翻译函数（随界面语言切换）
   */
  constructor(configPath, storageDir, t = DEFAULT_T) {
    this.t = t;
    this.configPath = configPath;
    this.storageDir = storageDir;
    this.backupDir = path.join(storageDir, "backups");
    this.lastGoodPath = path.join(storageDir, LAST_GOOD_NAME);
  }

  /** @returns {ReadResult} */
  read() {
    let text;
    try {
      text = fs.readFileSync(this.configPath, "utf8");
    } catch (e) {
      const err = /** @type {NodeJS.ErrnoException} */ (e);
      if (err.code === "ENOENT") return { status: "missing" };
      return { status: "error", error: describeFsError(err, this.configPath, this.t) };
    }
    try {
      const raw = Core.parseJsonc(text);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { status: "invalid", text, error: this.t("store.notObject") };
      }
      return { status: "ok", raw, text };
    } catch (e) {
      return { status: "invalid", text, error: this.t("store.parseFailed", { error: /** @type {Error} */ (e).message }) };
    }
  }

  /**
   * 原子写入配置（写前自动备份旧文件）。
   * @param {any} obj 已通过校验的完整配置对象
   * @returns {{ ok: true, backupPath?: string } | { ok: false, error: string }}
   */
  write(obj) {
    const text = JSON.stringify(obj, null, 2) + "\n";
    let backupPath;
    try {
      backupPath = this.backupCurrent();
      const tmp = `${this.configPath}.agp-${process.pid}-${Date.now()}.tmp`;
      fs.writeFileSync(tmp, text, "utf8");
      try {
        fs.renameSync(tmp, this.configPath);
      } catch (e) {
        try { fs.unlinkSync(tmp); } catch { /* 清理失败不影响主错误 */ }
        throw e;
      }
      this.saveLastGood(obj);
      return { ok: true, backupPath };
    } catch (e) {
      return { ok: false, error: describeFsError(/** @type {NodeJS.ErrnoException} */ (e), this.configPath, this.t) };
    }
  }

  /**
   * 备份当前安装目录中的 config.json 到全局存储（不存在则跳过）。
   * @returns {string | undefined} 备份文件路径
   */
  backupCurrent() {
    if (!fs.existsSync(this.configPath)) return undefined;
    fs.mkdirSync(this.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dst = path.join(this.backupDir, `config-${stamp}.json`);
    fs.copyFileSync(this.configPath, dst);
    this.pruneBackups();
    return dst;
  }

  /** 仅保留最近 MAX_BACKUPS 份备份 */
  pruneBackups() {
    try {
      const files = fs.readdirSync(this.backupDir)
        .filter((f) => /^config-.*\.json$/.test(f))
        .sort();
      for (const f of files.slice(0, Math.max(0, files.length - MAX_BACKUPS))) {
        fs.unlinkSync(path.join(this.backupDir, f));
      }
    } catch { /* 备份清理失败不影响主流程 */ }
  }

  /**
   * 记录“最后一次可用配置”（IDE 更新清空安装目录后用于恢复用户配置）。
   * @param {any} obj
   */
  saveLastGood(obj) {
    try {
      fs.mkdirSync(this.storageDir, { recursive: true });
      fs.writeFileSync(this.lastGoodPath, JSON.stringify(obj, null, 2) + "\n", "utf8");
    } catch { /* 存储目录不可写时静默跳过，不影响保存主流程 */ }
  }

  /** @returns {any | null} */
  loadLastGood() {
    try {
      return Core.parseJsonc(fs.readFileSync(this.lastGoodPath, "utf8"));
    } catch {
      return null;
    }
  }
}

/**
 * 将文件系统错误转为可操作的中文提示。
 * @param {NodeJS.ErrnoException} err
 * @param {string} filePath
 * @param {Translate} [t]
 */
function describeFsError(err, filePath, t = DEFAULT_T) {
  if (err && (err.code === "EPERM" || err.code === "EACCES")) {
    return t("fs.noPermission", { path: filePath });
  }
  if (err && err.code === "EBUSY") {
    return t("fs.busy", { path: filePath });
  }
  return `${err?.code || "ERROR"}: ${err?.message || String(err)}`;
}

module.exports = { ConfigStore, describeFsError };
