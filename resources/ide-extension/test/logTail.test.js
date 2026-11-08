// 单测：node --test resources/ide-extension/test/logTail.test.js
// 覆盖日志行解析、增量尾随、截断重置、文件选择与广播服务。
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { LogTailer, parseLogLine, findLatestLogFile } = require("../lib/logTail.js");
const { LogService } = require("../lib/logService.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("日志行解析：标准格式 / 无 PID 旧格式 / 未知格式", () => {
  const std = parseLogLine("[2026-11-08 12:00:00] [PID:123][TID:456] [警告] 隧道建立失败");
  assert.deepEqual(
    { ts: std.ts, pid: std.pid, tid: std.tid, level: std.level, text: std.text },
    { ts: "2026-11-08 12:00:00", pid: 123, tid: 456, level: "warn", text: "隧道建立失败" },
  );

  const legacy = parseLogLine("[2026-11-08 12:00:00] [信息] 旧格式");
  assert.equal(legacy.level, "info");
  assert.equal(legacy.pid, 0);
  assert.equal(legacy.text, "旧格式");

  const unknown = parseLogLine("random line");
  assert.equal(unknown.level, "info");
  assert.equal(unknown.raw, "random line");
});

test("日志尾随：回放尾部、追加新行、截断后重置", async () => {
  const dir = tempDir("agp-log-");
  const file = path.join(dir, "proxy-20261108.log");
  fs.writeFileSync(file, "[2026-11-08 10:00:00] [PID:1][TID:2] [信息] 第一行\n[2026-11-08 10:00:01] [PID:1][TID:2] [错误] 第二行\n", "utf8");

  /** @type {string[]} */
  const lines = [];
  /** @type {string[]} */
  const resets = [];
  const tailer = new LogTailer({
    dirs: [dir],
    onLines: (batch) => lines.push(...batch),
    onReset: (reason) => resets.push(reason),
    pollMs: 20,
    rescanMs: 1000,
  });
  try {
    tailer.start();
    await wait(120);
    assert.ok(lines.some((l) => l.includes("第一行")), "应回放已有日志");
    assert.ok(lines.some((l) => l.includes("第二行")));

    fs.appendFileSync(file, "[2026-11-08 10:00:02] [PID:1][TID:2] [信息] 第三行\n", "utf8");
    await wait(140);
    assert.ok(lines.some((l) => l.includes("第三行")), "应尾随追加日志");

    // 模拟 10MB 覆盖写：文件变短 → 触发 truncate 重置并重新读取
    fs.writeFileSync(file, "[2026-11-08 10:00:03] [PID:1][TID:2] [信息] 截断后\n", "utf8");
    await wait(160);
    assert.ok(resets.includes("truncate"), "截断应触发 reset");
    assert.ok(lines.some((l) => l.includes("截断后")), "截断后应从 0 重新读取");
  } finally {
    tailer.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("选择日志文件：跨目录取最新 proxy-*.log", () => {
  const a = tempDir("agp-log-a-");
  const b = tempDir("agp-log-b-");
  const oldFile = path.join(a, "proxy-20261107.log");
  const newFile = path.join(b, "proxy-20261108.log");
  fs.writeFileSync(oldFile, "old\n", "utf8");
  fs.writeFileSync(newFile, "new\n", "utf8");
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(oldFile, past, past);
  const latest = findLatestLogFile([a, b]);
  assert.equal(latest.path, newFile);
  fs.rmSync(a, { recursive: true, force: true });
  fs.rmSync(b, { recursive: true, force: true });
});

test("日志服务：快照 + 插件事件 + 截断重置事件", async () => {
  const dir = tempDir("agp-log-svc-");
  const file = path.join(dir, "proxy-20261108.log");
  fs.writeFileSync(file, "[2026-11-08 10:00:00] [PID:1][TID:2] [信息] hello\n", "utf8");
  const service = new LogService({ installDir: path.dirname(dir), pollMs: 20 });
  // 测试里 installDir 的 logs 子目录并不是 dir，这里直接替换候选目录，避免依赖真实安装目录
  service.dirs = [dir];
  const events = [];
  service.subscribe((e) => events.push(e));
  try {
    service.start();
    await wait(120);
    const snap = service.snapshot();
    assert.ok(snap.lines.some((l) => l.text.includes("hello")));

    service.add("info", "插件事件");
    await wait(260);
    assert.ok(events.some((e) => e.type === "append" && e.lines.some((l) => l.text === "插件事件")));

    // 注意：内容必须比原文件更短，否则按"追加"处理（真实 10MB 覆盖写也是从 0 开始，size 会小于 offset）
    fs.writeFileSync(file, "[2026-11-08 10:00:01] [PID:1][TID:2] [警告] x\n", "utf8");
    await wait(300);
    assert.ok(events.some((e) => e.type === "reset"), "截断应广播 reset");
  } finally {
    service.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
