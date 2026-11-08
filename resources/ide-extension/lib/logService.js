// @ts-check
"use strict";

/**
 * 日志服务（单一职责：把「DLL 文件日志」与「插件自身事件」合并成一条可订阅的实时流）。
 *
 * - 环形缓冲：默认保留最近 3000 行，防止长期运行吃内存；超出部分只计数（UI 显示"已丢弃 N 行"）。
 * - 批量广播：200ms 合并一次，日志量大时不会把 Webview 消息通道打爆。
 * - 视图无关：底部日志面板与左侧栏共用同一个实例；新打开的视图用 snapshot() 回放。
 */

const I18n = require("../media/i18n");
const { LogTailer, parseLogLine, candidateLogDirs } = require("./logTail");

const DEFAULT_MAX_LINES = 3000;
const FLUSH_MS = 200;
const DEFAULT_T = I18n.createT("zh-cn");

/** @typedef {{ id: number, ts: string, level: "debug" | "info" | "warn" | "error", text: string, source: "dll" | "plugin", pid?: number, tid?: number }} LogLine */

/** 本地时间 "YYYY-MM-DD HH:mm:ss"（与 DLL 日志一致，便于对照） */
function formatNow(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

class LogService {
  /**
   * @param {{ installDir: string, t?: (key: string, params?: Record<string, any>) => string, maxLines?: number, pollMs?: number, now?: () => number }} opts
   */
  constructor(opts) {
    this.t = opts.t || DEFAULT_T;
    this.maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
    this.pollMs = opts.pollMs;
    this.now = opts.now || Date.now;
    this.dirs = candidateLogDirs(opts.installDir);
    /** @type {LogLine[]} */
    this.lines = [];
    this.nextId = 1;
    this.dropped = 0;
    /** @type {string} */
    this.file = "";
    /** @type {Set<(event: any) => void>} */
    this.listeners = new Set();
    /** @type {LogLine[]} */
    this.pending = [];
    /** @type {NodeJS.Timeout | undefined} */
    this.flushTimer = undefined;
    /** @type {LogTailer | undefined} */
    this.tailer = undefined;
  }

  start() {
    if (this.tailer) return;
    this.tailer = new LogTailer({
      dirs: this.dirs,
      pollMs: this.pollMs,
      onLines: (rawLines) => {
        for (const raw of rawLines) {
          const parsed = parseLogLine(raw);
          this.push({ ts: parsed.ts || formatNow(), level: parsed.level, text: parsed.text, source: "dll", pid: parsed.pid, tid: parsed.tid });
        }
      },
      onReset: (reason) => this.reset(reason),
      onFile: (file) => { this.file = file ? file.path : ""; },
    });
    this.tailer.start();
  }

  /** 立即重扫日志目录（用户手动刷新时用） */
  rescan() {
    if (this.tailer) this.tailer.rescan();
  }

  dispose() {
    if (this.tailer) this.tailer.stop();
    this.tailer = undefined;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.listeners.clear();
  }

  /** @param {(event: any) => void} cb */
  subscribe(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** 视图打开时回放当前缓冲与文件信息 */
  snapshot() {
    return {
      file: this.file,
      dirs: this.dirs,
      lines: this.lines.slice(),
      dropped: this.dropped,
      total: this.nextId - 1,
      serverNow: this.now(),
    };
  }

  /**
   * 插件自身事件（更新/ IP / Gemini 的关键步骤）：写进同一条流，排障时不用切 Output。
   * @param {"debug" | "info" | "warn" | "error"} level
   * @param {string} text
   */
  add(level, text) {
    this.push({ ts: formatNow(), level, text, source: "plugin" });
  }

  /** @param {{ ts: string, level: "debug" | "info" | "warn" | "error", text: string, source: "dll" | "plugin", pid?: number, tid?: number }} line */
  push(line) {
    /** @type {LogLine} */
    const item = { id: this.nextId++, ts: line.ts, level: line.level, text: line.text, source: line.source, pid: line.pid, tid: line.tid };
    this.lines.push(item);
    this.pending.push(item);
    if (this.lines.length > this.maxLines) {
      const overflow = this.lines.length - this.maxLines;
      this.lines.splice(0, overflow);
      this.dropped += overflow;
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
      if (typeof this.flushTimer.unref === "function") this.flushTimer.unref();
    }
  }

  flush() {
    this.flushTimer = undefined;
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    this.emit({ type: "append", lines: batch });
  }

  /**
   * 文件切换/截断：清空缓冲并插入一条说明。
   * 注意：说明行直接写入缓冲、不进入 pending，避免 reset 快照与随后的 append 重复下发同一条。
   * @param {string} reason
   */
  reset(reason) {
    this.lines = [];
    this.dropped = 0;
    this.pending = [];
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    /** @type {LogLine} */
    const note = {
      id: this.nextId++,
      ts: formatNow(),
      level: "info",
      text: this.t(reason === "truncate" ? "logs.fileTruncated" : "logs.fileSwitched"),
      source: "plugin",
    };
    this.lines.push(note);
    this.emit({ type: "reset", snapshot: this.snapshot() });
  }

  /** @param {any} event */
  emit(event) {
    for (const cb of this.listeners) {
      try { cb(event); } catch { /* 单个视图异常不影响其它视图 */ }
    }
  }
}

module.exports = { LogService, formatNow, DEFAULT_MAX_LINES };
