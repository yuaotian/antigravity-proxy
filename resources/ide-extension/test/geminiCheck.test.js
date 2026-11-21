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

// ---------------- agy 登录日志（IDE 2.6+，~/.gemini/antigravity/log/cli-*.log） ----------------
// 以下日志行按 2026-11-21 用户机器上的真实格式构造（glog 前缀 + agy 的 telemetry 字段）

/** 在临时 home 下写一个 agy 日志文件 */
function writeAgyLog(home, name, lines) {
  const dir = path.join(home, ".gemini", "antigravity", "log");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}
const signedIn = (ts) => `I${ts}     423 auth_status_telemetry.go:81] [auth-status] rpc=get_auth_status valid=true`;
const hasToken = (ts, v) => `I${ts}     138 auth_status_telemetry.go:58] [auth-status] rpc=has_auth_token has_token=${v}`;
const statusIneligible = (ts) => `I${ts}     553 auth_status_telemetry.go:81] [auth-status] ms=602 reason=ineligible rpc=get_auth_status valid=false`;
const loginIneligible = (ts) => `I${ts}    9841 login_telemetry.go:232] [auth-login] attempt=7 done browser_open_result=started failure_kind=ineligible last_step=code_exchanged outcome=error session_mode=loopback`;
const notLoggedIn = (ts) => `W${ts}      68 cache.go:157] Cache(loadCodeAssistResponse): Singleflight refresh failed: error getting token source: You are not logged into Antigravity.`;
/** 正常会话里也会每分钟出现的实验配置 403（不能当作被拒） */
const fetchConfig403 = (ts, loc) => `W${ts}    9445 code_assist_client.go:475] AICode FetchConfig failed, falling back to CCPA ListExperiments: failed to make AI Code FetchConfig request: "403 Forbidden", body: "{\\n  \\"error\\": {\\n    \\"code\\": 403,\\n    \\"message\\": \\"Your location is not eligible for this service at this time. Detected location: ${loc}.\\",\\n    \\"status\\": \\"PERMISSION_DENIED\\",\\n    \\"details\\": [{\\"reason\\": \\"LOCATION_NOT_ELIGIBLE\\", \\"metadata\\": {\\"detected_location\\": \\"${loc}\\", \\"error_number\\": \\"1008\\"}}]}}"`;

test("agy 日志：资格被拒后大量\"未登录\"不覆盖被拒，并取最近的检测地区", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agp-agy-blocked-"));
  writeAgyLog(home, "cli-20261121_014131.log", [
    hasToken("1121 01:41:34.064048", true),
    signedIn("1121 01:41:34.199260"),
    fetchConfig403("1121 01:42:34.100000", "HK"),
  ]);
  writeAgyLog(home, "cli-20261121_124348.log", [
    hasToken("1121 12:43:50.513190", true),
    statusIneligible("1121 12:43:51.203005"),
    fetchConfig403("1121 14:33:48.924737", "CN"),
    loginIneligible("1121 14:37:45.646662"),
  ]);
  writeAgyLog(home, "cli-20261121_143811.log", [
    notLoggedIn("1121 14:38:11.260098"),
    hasToken("1121 14:38:12.340371", false),
    notLoggedIn("1121 14:42:11.260878"),
  ]);

  const agy = Gem.findAgyAuthEvidence({ homeDir: home });
  assert.equal(agy.available, true);
  assert.equal(agy.state, "blocked");
  assert.equal(agy.detectedLocation, "CN");
  assert.match(agy.line, /failure_kind=ineligible/);
  assert.equal(agy.at, new Date(2026, 10, 21, 14, 37, 45, 646).getTime());
  assert.equal(path.basename(agy.path), "cli-20261121_124348.log");

  fs.rmSync(home, { recursive: true, force: true });
});

test("agy 日志：正常会话里的 FetchConfig 403（LOCATION_NOT_ELIGIBLE/1008）不算被拒", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agp-agy-healthy-"));
  writeAgyLog(home, "cli-20261119_124620.log", [
    hasToken("1119 12:46:24.000001", true),
    signedIn("1119 12:46:25.000001"),
    fetchConfig403("1119 12:47:25.000001", "CN"),
    fetchConfig403("1119 12:48:25.000001", "CN"),
  ]);

  const agy = Gem.findAgyAuthEvidence({ homeDir: home });
  assert.equal(agy.state, "signed-in");
  // 检测地区只在被拒时输出，正常会话不展示，避免误导
  assert.equal(agy.detectedLocation, "");

  fs.rmSync(home, { recursive: true, force: true });
});

test("agy 日志：先被拒、后登录成功 → 已登录（Antigravity 层 ok）", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agp-agy-recovered-"));
  writeAgyLog(home, "cli-20261121_100000.log", [
    loginIneligible("1121 10:00:05.000000"),
    notLoggedIn("1121 10:01:00.000000"),
  ]);
  writeAgyLog(home, "cli-20261121_103000.log", [
    signedIn("1121 10:30:02.000000"),
  ]);

  const agy = Gem.findAgyAuthEvidence({ homeDir: home });
  assert.equal(agy.state, "signed-in");
  const anti = Gem.resolveAntigravityState({
    lcaVerdict: Gem.classifyLoadCodeAssist(401, "unauthorized"),
    agy,
    logEvidence: Gem.findAntigravityLogEvidence({ appDataDir: home }),
  });
  assert.equal(anti.state, "ok");
  assert.equal(anti.source, "agy");
  assert.equal(anti.loggedIn, true);

  fs.rmSync(home, { recursive: true, force: true });
});

test("回归：第三方扩展（Cockpit）日志显示已登录 + agy 资格被拒 → 判受限，顶部不显示可用", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agp-agy-cockpit-"));
  // 同一个临时目录同时充当 %APPDATA% 与用户主目录
  const cockpitDir = path.join(root, "Antigravity IDE", "logs", "20261121T124343", "window1", "exthost", "output_logging_20261121T124345");
  fs.mkdirSync(cockpitDir, { recursive: true });
  fs.writeFileSync(path.join(cockpitDir, "5-Antigravity Cockpit.log"), [
    "[2026-11-21 06:42:56] [INFO] [CloudCode:AuthorizedQuota] Requesting https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
    "[2026-11-21 06:42:57] [INFO] [CredentialStorage] ProjectId updated for user@example.com",
  ].join("\n"), "utf8");
  writeAgyLog(root, "cli-20261121_124348.log", [
    statusIneligible("1121 12:43:51.203005"),
    loginIneligible("1121 14:37:45.646662"),
  ]);

  const logEvidence = Gem.findAntigravityLogEvidence({ appDataDir: root });
  assert.equal(logEvidence.loggedIn, true, "前置条件：旧逻辑会把 Cockpit 日志当成已登录");

  const anti = Gem.resolveAntigravityState({
    lcaVerdict: Gem.classifyLoadCodeAssist(401, "unauthorized"),
    agy: Gem.findAgyAuthEvidence({ homeDir: root }),
    logEvidence,
  });
  assert.equal(anti.state, "blocked");
  assert.equal(anti.source, "agy");
  assert.equal(anti.loggedIn, false);
  assert.equal(
    Gem.resolveOverallState({ allFailed: false, proxyFailedOnly: false, apiState: "ok", antigravityState: anti.state }),
    "blocked",
  );

  fs.rmSync(root, { recursive: true, force: true });
});

test("agy 日志：只有\"未登录\"事件 → signed-out", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agp-agy-signedout-"));
  writeAgyLog(home, "cli-20261121_143723.log", [notLoggedIn("1121 14:37:23.892120")]);

  const agy = Gem.findAgyAuthEvidence({ homeDir: home });
  assert.equal(agy.state, "signed-out");
  const anti = Gem.resolveAntigravityState({ lcaVerdict: { state: "inconclusive" }, agy, logEvidence: Gem.findAntigravityLogEvidence({ appDataDir: home }) });
  assert.equal(anti.state, "signed-out");

  fs.rmSync(home, { recursive: true, force: true });
});

test("agy 日志不存在（旧版 IDE）：state=none，回退到 IDE 日志的原有判定", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agp-agy-none-"));
  const agy = Gem.findAgyAuthEvidence({ homeDir: root });
  assert.equal(agy.available, false);
  assert.equal(agy.state, "none");

  const dir = path.join(root, "Antigravity IDE", "logs", "20261108T153055");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "cloudcode.log"), "[CredentialStorage] ProjectId updated for user@example.com\n", "utf8");
  const anti = Gem.resolveAntigravityState({ lcaVerdict: { state: "inconclusive" }, agy, logEvidence: Gem.findAntigravityLogEvidence({ appDataDir: root }) });
  assert.equal(anti.state, "ok");
  assert.equal(anti.source, "ide-log");

  fs.rmSync(root, { recursive: true, force: true });
});

test("顶部结论：只有 API 与 Antigravity 两层都确认可用才显示可用", () => {
  const base = { allFailed: false, proxyFailedOnly: false };
  const s = (apiState, antigravityState) => Gem.resolveOverallState({ ...base, apiState, antigravityState });
  assert.equal(s("ok", "ok"), "ok");
  // 本次截图的场景：匿名 API 放行，但 Antigravity 会话无法判定 → 不能显示"可用"
  assert.equal(s("ok", "inconclusive"), "inconclusive");
  assert.equal(s("ok", "signed-out"), "inconclusive");
  assert.equal(s("ok", "unknown"), "inconclusive");
  assert.equal(s("ok", "blocked"), "blocked");
  assert.equal(s("blocked", "ok"), "blocked");
  assert.equal(Gem.resolveOverallState({ allFailed: true, proxyFailedOnly: false, apiState: "error", antigravityState: "ok" }), "error");
  assert.equal(Gem.resolveOverallState({ allFailed: false, proxyFailedOnly: true, apiState: "ok", antigravityState: "ok" }), "proxy-error");
});
