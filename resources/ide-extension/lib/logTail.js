// @ts-check
"use strict";

/**
 * DLL 日志尾随（纯 Node，不依赖 vscode，便于单测）。
 *
 * 日志事实（见 src/core/Logger.hpp）：
 * - 目录优先级：<安装目录>\logs → %TEMP%\antigravity-proxy-logs（Logger.hpp:130-157）
 * - 文件名：proxy-YYYYMMDD.log（Logger.hpp:177-190）
 * - 行格式：[时间] [PID:x][TID:y] [信息|警告|错误|调试] 内容（Logger.hpp:364-394）
 * - 单文件 10MB 后被就地覆盖写入（Logger.hpp:245-290）→ 尾部读取必须处理 size < offset 的截断
 * - 多进程同时写同一个文件 → 只做"按大小增量读"，不锁文件
 *
 * 本模块只负责"发现文件 + 增量读取 + 按行切分"，级别解析与缓冲在 logService.js。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

/** 日志级别中文标记 → 稳定英文级别（DLL 固定写中文，不随界面语言变化） */
const LEVEL_MAP = Object.freeze({ "调试": "debug", "信息": "info", "警告": "warn", "错误": "error" });
const LOG_FILE_RE = /^proxy-\d{8}\.log$/i;
const LINE_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]\s*(?:\[PID:(\d+)\]\[TID:(\d+)\]\s*)?\[(调试|信息|警告|错误)\]\s?([\s\S]*)$/;

const DEFAULT_INITIAL_BYTES = 256 * 1024;
const DEFAULT_POLL_MS = 1000;
const DEFAULT_RESCAN_MS = 5000;
const MAX_CHUNK_BYTES = 2 * 1024 * 1024;

/**
 * 解析一行 DLL 日志；格式不认识时按 info 处理并保留原文（避免升级后旧格式被吞掉）。
 * @param {string} raw
 * @returns {{ ts: string, pid: number, tid: number, level: "debug" | "info" | "warn" | "error", text: string, raw: string }}
 */
function parseLogLine(raw) {
  const line = String(raw ?? "").replace(/\r$/, "");
  const m = LINE_RE.exec(line);
  if (!m) {
    return { ts: "", pid: 0, tid: 0, level: "info", text: line, raw: line };
  }
  return {
    ts: m[1],
    pid: Number(m[2] || 0),
    tid: Number(m[3] || 0),
    level: LEVEL_MAP[m[4]] || "info",
    text: m[5] || "",
    raw: line,
  };
}

/**
 * 候选日志目录（安装目录优先，TEMP 兜底）。
 * @param {string} installDir
 */
function candidateLogDirs(installDir) {
  const dirs = [];
  if (installDir) dirs.push(path.join(installDir, "logs"));
  dirs.push(path.join(os.tmpdir(), "antigravity-proxy-logs"));
  return dirs;
}

/**
 * 列出所有 proxy-*.log（按修改时间倒序）。
 * @param {string[]} dirs
 * @returns {{ path: string, mtimeMs: number, size: number }[]}
 */
function listLogFiles(dirs) {
  /** @type {{ path: string, mtimeMs: number, size: number }[]} */
  const out = [];
  for (const dir of dirs || []) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!LOG_FILE_RE.test(name)) continue;
      const filePath = path.join(dir, name);
      try {
        const st = fs.statSync(filePath);
        if (st.isFile()) out.push({ path: filePath, mtimeMs: st.mtimeMs, size: st.size });
      } catch { /* 文件在扫描瞬间被清理：跳过 */ }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * 找到最新的日志文件；没有则返回 null。
 * @param {string[]} dirs
 */
function findLatestLogFile(dirs) {
  return listLogFiles(dirs)[0] || null;
}

/**
 * 读取文件区间；失败返回 null（调用方下次轮询重试）。
 * @param {string} filePath @param {number} start @param {number} length
 */
function readRange(filePath, start, length) {
  let fd = -1;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(length);
    const read = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, read);
  } catch {
    return null;
  } finally {
    if (fd >= 0) {
      try { fs.closeSync(fd); } catch { /* 忽略关闭失败 */ }
    }
  }
}

/**
 * 日志尾随器：自动发现最新的 proxy-*.log，按大小增量读取并按行回调。
 *
 * 回调：
 * - onLines(string[])：新增的完整行（不含换行符）
 * - onReset(reason)：检测到换文件("switch")或就地截断("truncate")
 * - onFile(fileInfo|null)：当前跟随的文件发生变化
 */
class LogTailer {
  /**
   * @param {{ dirs: string[], onLines: (lines: string[]) => void, onReset?: (reason: string) => void, onFile?: (file: { path: string, mtimeMs: number, size: number } | null) => void, initialBytes?: number, pollMs?: number, rescanMs?: number }} opts
   */
  constructor(opts) {
    this.dirs = opts.dirs;
    this.onLines = opts.onLines;
    this.onReset = opts.onReset || (() => {});
    this.onFile = opts.onFile || (() => {});
    this.initialBytes = opts.initialBytes ?? DEFAULT_INITIAL_BYTES;
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.rescanMs = opts.rescanMs ?? DEFAULT_RESCAN_MS;

    /** @type {string} */
    this.filePath = "";
    this.offset = 0;
    /** 未凑满一行的字节：UTF-8 多字节字符可能被 read 截断，必须按字节留到下次拼接 */
    this.remainder = Buffer.alloc(0);
    this.lastScanAt = 0;
    this.started = false;
    /** @type {NodeJS.Timeout | undefined} */
    this.timer = undefined;
    this.polling = false;
  }

  /** 当前跟随的文件路径（可能为空） */
  get file() {
    return this.filePath;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.attach(true);
    this.timer = setInterval(() => this.poll(), this.pollMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop() {
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 立即重扫目录（例如用户刚打开日志目录后） */
  rescan() {
    this.lastScanAt = 0;
    this.poll();
  }

  /** 选择文件：有变化时重置读取位置并回放尾部 */
  attach(initial) {
    const now = Date.now();
    this.lastScanAt = now;
    const latest = findLatestLogFile(this.dirs);
    if (!latest) {
      if (this.filePath) {
        this.filePath = "";
        this.offset = 0;
        this.remainder = Buffer.alloc(0);
        this.onFile(null);
        this.onReset("switch");
      }
      return;
    }
    if (latest.path !== this.filePath) {
      const hadFile = !!this.filePath;
      this.filePath = latest.path;
      this.offset = 0;
      this.remainder = Buffer.alloc(0);
      this.onFile(latest);
      // 只有"从一个文件切到另一个文件"才重置视图；首次挂载不应清空缓冲/插一条无意义的切换提示
      if (hadFile) this.onReset("switch");
      this.readInitial();
    }
  }

  /** 首次加载：只回放文件尾部，避免 10MB 日志阻塞扩展宿主 */
  readInitial() {
    let size = 0;
    try {
      size = fs.statSync(this.filePath).size;
    } catch {
      return;
    }
    const start = Math.max(0, size - this.initialBytes);
    const buffer = readRange(this.filePath, start, size - start);
    if (!buffer) return;
    // 起点可能落在行中间：丢弃第一行（除非从 0 开始）
    let usable = buffer;
    if (start > 0) {
      const nl = usable.indexOf(0x0a);
      usable = nl >= 0 ? usable.subarray(nl + 1) : Buffer.alloc(0);
    }
    this.offset = size;
    this.emitBuffer(usable, false);
  }

  poll() {
    if (!this.started || this.polling) return;
    this.polling = true;
    try {
      const now = Date.now();
      if (!this.filePath || now - this.lastScanAt >= this.rescanMs) this.attach(false);
      if (!this.filePath) return;

      /** @type {fs.Stats} */
      let st;
      try {
        st = fs.statSync(this.filePath);
      } catch {
        // 文件被删除/换日：下一轮重扫
        this.lastScanAt = 0;
        return;
      }
      if (st.size < this.offset) {
        // 10MB 覆盖写或外部清空：从头读，并通知上层重置缓冲
        this.offset = 0;
        this.remainder = Buffer.alloc(0);
        this.onReset("truncate");
      }
      if (st.size <= this.offset) return;
      const length = Math.min(st.size - this.offset, MAX_CHUNK_BYTES);
      const chunk = readRange(this.filePath, this.offset, length);
      if (!chunk) return;
      this.offset += chunk.length;
      this.emitBuffer(chunk, true);
    } finally {
      this.polling = false;
    }
  }

  /**
   * 把字节切分成完整行；最后一段不完整的内容留到下次。
   * @param {Buffer} chunk @param {boolean} keepRemainder
   */
  emitBuffer(chunk, keepRemainder) {
    const buffer = this.remainder.length ? Buffer.concat([this.remainder, chunk]) : chunk;
    const lastNl = buffer.lastIndexOf(0x0a);
    if (lastNl < 0) {
      // 没有换行：整段都是未完成行。限制大小，避免异常超长行吃内存
      this.remainder = keepRemainder ? buffer.subarray(Math.max(0, buffer.length - 64 * 1024)) : Buffer.alloc(0);
      return;
    }
    const complete = buffer.subarray(0, lastNl);
    this.remainder = keepRemainder ? buffer.subarray(lastNl + 1) : Buffer.alloc(0);
    const text = complete.toString("utf8");
    const lines = text.split("\n").filter((line) => line.length > 0);
    if (lines.length) this.onLines(lines);
  }
}

module.exports = {
  LogTailer,
  parseLogLine,
  candidateLogDirs,
  listLogFiles,
  findLatestLogFile,
  LEVEL_MAP,
  LOG_FILE_RE,
};
