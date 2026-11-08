// 纯逻辑单测：node --test resources/ide-extension/test/geminiCheck.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Gem = require("../lib/geminiCheck.js");

test("Gemini API 分类：地区错误优先于 key 错误，key 错误代表地区放行", () => {
  assert.deepEqual(
    Gem.classifyGeminiApi(400, '{"error":{"code":400,"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}'),
    { state: "blocked", reason: "location" },
  );
  assert.deepEqual(
    Gem.classifyGeminiApi(400, '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}'),
    { state: "ok", reason: "region-ok" },
  );
  assert.deepEqual(Gem.classifyGeminiApi(200, "{}"), { state: "ok", reason: "http-200" });
  assert.deepEqual(Gem.classifyGeminiApi(403, "forbidden"), { state: "inconclusive", reason: "http-403" });
});

test("loadCodeAssist 分类：403/1008 判受限，401 判无法判定", () => {
  const blocked = JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED", message: "Your current account is not eligible ...", details: [{ reason: "UNSUPPORTED_LOCATION", error_number: 1008 }] } });
  assert.equal(Gem.classifyLoadCodeAssist(403, blocked).state, "blocked");
  assert.equal(Gem.classifyLoadCodeAssist(403, '{"error":{"status":"PERMISSION_DENIED","message":"The caller does not have permission"}}').state, "inconclusive");
  assert.equal(Gem.classifyLoadCodeAssist(401, "unauthorized").state, "inconclusive");
  assert.equal(Gem.classifyLoadCodeAssist(200, "{}").state, "ok");
});

test("Antigravity 日志证据：最新目录命中 location 错误", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agp-gemini-"));
  const dir = path.join(root, "Antigravity", "logs", "2026-11-08_120000");
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, "ls-main.log");
  fs.writeFileSync(logPath, [
    "[2026-11-08 12:00:01] language server started",
    "[2026-11-08 12:00:30] agent executor error: FAILED_PRECONDITION (code 400): User location is not supported for the API use.",
    "[2026-11-08 12:01:00] retry",
  ].join("\n"), "utf8");

  const evidence = Gem.findAntigravityLogEvidence({ appDataDir: root });
  assert.equal(evidence.available, true);
  assert.equal(evidence.matched, true);
  assert.match(evidence.line, /User location is not supported/);
  assert.equal(evidence.path, logPath);

  fs.rmSync(root, { recursive: true, force: true });
});

test("Antigravity 日志证据：无日志目录时安全返回", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agp-gemini-empty-"));
  const evidence = Gem.findAntigravityLogEvidence({ appDataDir: root });
  assert.equal(evidence.available, false);
  assert.equal(evidence.matched, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("Antigravity 日志证据：IDE 根目录的 ProjectId 作为已登录证据", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agp-gemini-ide-"));
  const dir = path.join(root, "Antigravity IDE", "logs", "20261108T153055", "window1", "exthost", "output_logging");
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, "7-Antigravity Cockpit.log");
  fs.writeFileSync(logPath, [
    "[2026-11-08 07:31:00] [INFO] [CloudCode:AuthorizedQuota] Requesting https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    "[2026-11-08 07:31:05] [INFO] [CredentialStorage] ProjectId updated for user@example.com",
  ].join("\n"), "utf8");

  const evidence = Gem.findAntigravityLogEvidence({ appDataDir: root });
  assert.equal(evidence.available, true);
  assert.equal(evidence.loggedIn, true);
  assert.equal(evidence.matched, false);
  assert.match(evidence.loginLine, /ProjectId updated for/);
  assert.equal(evidence.loginPath, logPath);

  fs.rmSync(root, { recursive: true, force: true });
});

test("Antigravity 日志证据：旧的 location 错误不应盖过更新的登录", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agp-gemini-stale-"));
  const oldDir = path.join(root, "Antigravity", "logs", "2026-07-22_114604");
  fs.mkdirSync(oldDir, { recursive: true });
  const oldLog = path.join(oldDir, "ls-main.log");
  fs.writeFileSync(oldLog, "User location is not supported for the API use.\n", "utf8");
  const old = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  fs.utimesSync(oldLog, old, old);

  const newDir = path.join(root, "Antigravity IDE", "logs", "20261108T153055");
  fs.mkdirSync(newDir, { recursive: true });
  const newLog = path.join(newDir, "cloudcode.log");
  fs.writeFileSync(newLog, "[CredentialStorage] ProjectId updated for user@example.com\n", "utf8");

  const evidence = Gem.findAntigravityLogEvidence({ appDataDir: root });
  assert.equal(evidence.loggedIn, true);
  assert.equal(evidence.matched, false);
  assert.match(evidence.line, /ProjectId updated for/);

  fs.rmSync(root, { recursive: true, force: true });
});

test("日志扫描：无命中时 available=true、matched=false", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agp-gemini-clean-"));
  const file = path.join(root, "ls-main.log");
  fs.writeFileSync(file, "all good\nno errors here\n", "utf8");
  const scan = Gem.scanLogFileForLocation(file);
  assert.equal(scan.available, true);
  assert.equal(scan.matched, false);
  fs.rmSync(root, { recursive: true, force: true });
});
