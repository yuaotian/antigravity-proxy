// @ts-check
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { findMissingTargets, withTargetsAdded } = require("../lib/configHealth");

test("旧配置缺少 agy.exe 时报告缺失", () => {
  assert.deepEqual(findMissingTargets({ target_processes: ["Antigravity IDE.exe", "language_server.exe"] }), ["agy.exe"]);
});

test("包含 agy.exe（大小写不敏感）时无需处理", () => {
  assert.deepEqual(findMissingTargets({ target_processes: ["AGY.EXE", "node.exe"] }), []);
});

test("空列表与 inherit 模式会注入全部子进程，不报告缺失", () => {
  assert.deepEqual(findMissingTargets({ target_processes: [] }), []);
  assert.deepEqual(findMissingTargets({}), []);
  assert.deepEqual(findMissingTargets({ child_injection_mode: "INHERIT", target_processes: ["node.exe"] }), []);
});

test("非对象输入安全返回空", () => {
  assert.deepEqual(findMissingTargets(null), []);
  assert.deepEqual(findMissingTargets("x"), []);
});

test("补齐时不修改原对象，并把缺失项放在最前", () => {
  const raw = { proxy: { port: 7890 }, target_processes: ["node.exe"] };
  const next = withTargetsAdded(raw, ["agy.exe"]);
  assert.deepEqual(next.target_processes, ["agy.exe", "node.exe"]);
  assert.deepEqual(raw.target_processes, ["node.exe"]);
  assert.equal(next.proxy.port, 7890);
  assert.deepEqual(findMissingTargets(next), []);
});
