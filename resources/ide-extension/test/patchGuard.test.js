// 补丁守护与重启器单元测试：node --test resources/ide-extension/test/patchGuard.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync, spawn } = require("child_process");
const { PatchGuard } = require("../lib/patchGuard.js");
const { ConfigStore } = require("../lib/configStore.js");
const { isDllLoadedInThisProcess } = require("../lib/installInfo.js");
const { buildRelauncherScript, buildLauncherScript, runLauncher, sanitizeEnv, ARGS_ENV } = require("../lib/restart.js");

const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

// 本文件创建的临时目录，全部用例结束后统一清理，避免每次构建在 %TEMP% 留下残留
/** @type {string[]} */
const tmpRoots = [];
const mkTmp = (/** @type {string} */ prefix) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
};
test.after(() => {
  for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

/** 构造：安装目录 / 插件目录（含 payload）/ 全局存储目录 */
function fixture() {
  const root = mkTmp("agp-guard-");
  const installDir = path.join(root, "install");
  const extDir = path.join(root, "ext");
  const storage = path.join(root, "storage");
  fs.mkdirSync(installDir);
  fs.mkdirSync(path.join(extDir, "payload"), { recursive: true });
  fs.writeFileSync(path.join(extDir, "payload", "version.dll"), Buffer.from("MZ-payload-dll"));
  fs.writeFileSync(path.join(extDir, "payload", "config.json"), JSON.stringify({ proxy: { port: 7890 } }));
  const info = {
    supported: true,
    installDir,
    exePath: path.join(installDir, "Antigravity IDE.exe"),
    dllPath: path.join(installDir, "version.dll"),
    configPath: path.join(installDir, "config.json"),
    logsDir: path.join(installDir, "logs"),
  };
  const store = new ConfigStore(info.configPath, storage);
  return { root, info, store, guard: new PatchGuard(info, store, extDir), extDir };
}

test("补丁被清除：DLL 从 payload 恢复且哈希一致，config 优先恢复用户上次配置", () => {
  const f = fixture();
  f.store.saveLastGood({ proxy: { host: "127.0.0.1", port: 7897, type: "http" } });
  assert.equal(f.guard.isWiped(), true);
  const r = f.guard.restore();
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.restored, ["version.dll", "config.json（你上次的配置）"]);
  assert.equal(sha(f.info.dllPath), sha(path.join(f.extDir, "payload", "version.dll")));
  assert.equal(JSON.parse(fs.readFileSync(f.info.configPath, "utf8")).proxy.port, 7897);
  assert.equal(f.guard.isWiped(), false);
  // 不残留临时文件
  assert.deepEqual(fs.readdirSync(f.info.installDir).filter((n) => n.endsWith(".tmp")), []);
});

test("无上次配置时使用 payload 默认模板；已存在的文件绝不覆盖", () => {
  const f = fixture();
  fs.writeFileSync(f.info.dllPath, Buffer.from("MZ-user-upgraded-dll"));
  const r = f.guard.restore();
  assert.equal(r.ok, true);
  assert.deepEqual(r.restored, ["config.json（默认模板）"]);
  assert.equal(fs.readFileSync(f.info.dllPath, "utf8"), "MZ-user-upgraded-dll");
});

test("插件未携带 payload（开发版）时给出明确错误", () => {
  const f = fixture();
  fs.rmSync(path.join(f.extDir, "payload"), { recursive: true });
  const r = f.guard.restore();
  assert.equal(r.ok, false);
  assert.match(r.error, /未携带 version\.dll/);
});

test("ConfigStore：原子写入、写前备份、最多保留 10 份", () => {
  const f = fixture();
  for (let i = 0; i < 12; i++) {
    const w = f.store.write({ proxy: { port: 7000 + i } });
    assert.equal(w.ok, true);
  }
  assert.equal(JSON.parse(fs.readFileSync(f.info.configPath, "utf8")).proxy.port, 7011);
  const backups = fs.readdirSync(path.join(f.root, "storage", "backups"));
  assert.equal(backups.length, 10);
  assert.equal(f.store.read().status, "ok");
  assert.equal(f.store.loadLastGood().proxy.port, 7011);
});

test("ConfigStore：JSONC 注释可读，非法 JSON 返回 invalid", () => {
  const f = fixture();
  fs.writeFileSync(f.info.configPath, "{ // c\n \"proxy\": { \"port\": 1080, }, }");
  assert.equal(f.store.read().raw.proxy.port, 1080);
  fs.writeFileSync(f.info.configPath, "{ broken");
  assert.equal(f.store.read().status, "invalid");
});

test("DLL 加载检测：命中已加载模块、未加载返回 false，且不改变全局 report.excludeNetwork", { skip: process.platform !== "win32" }, () => {
  const before = process.report.excludeNetwork;
  const kernel32 = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "kernel32.dll");
  assert.equal(isDllLoadedInThisProcess(kernel32), true);
  assert.equal(isDllLoadedInThisProcess(path.join(os.tmpdir(), "agp-not-loaded", "version.dll")), false);
  assert.equal(process.report.excludeNetwork, before);
});

test("重启器：剔除 ELECTRON_/VSCODE_ 环境变量，保留其它变量", () => {
  const env = sanitizeEnv({ PATH: "C:\\x", ELECTRON_RUN_AS_NODE: "1", VSCODE_PID: "1", vscode_cwd: "x", HTTP_PROXY: "p" });
  assert.deepEqual(Object.keys(env).sort(), ["HTTP_PROXY", "PATH"]);
});

test("重启器脚本：路径中的单引号被正确转义，且内外层均能被 PowerShell 解析", { skip: process.platform !== "win32" }, () => {
  const inner = buildRelauncherScript(1234, "C:\\Program Files\\O'Brien IDE\\Antigravity IDE.exe");
  assert.match(inner, /\$mainPid = 1234/);
  assert.match(inner, /'C:\\Program Files\\O''Brien IDE\\Antigravity IDE\.exe'/);
  const outer = buildLauncherScript(1234, inner);
  assert.match(outer, /--open-url/);
  for (const script of [inner, outer]) {
    const tmp = path.join(os.tmpdir(), `agp-relauncher-${process.pid}.ps1`);
    fs.writeFileSync(tmp, script, "utf8");
    try {
      const out = execFileSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${tmp}', [ref]$null, [ref]$e); $e.Count`,
      ], { encoding: "utf8" });
      assert.equal(out.trim(), "0");
    } finally {
      fs.unlinkSync(tmp);
    }
  }
});

// 回归：曾因 detached 拉起的 powershell.exe 无控制台直接退出、-Command 引号被破坏，导致重启后不再拉起 IDE。
// 此用例走真实拉起路径（-EncodedCommand + Start-Process），以探针脚本替代内层，验证参数抓取与交接。
test("重启器外层：抓取主进程参数（剔除 --open-url）并经环境变量交给独立的内层进程", { skip: process.platform !== "win32" }, async () => {
  const marker = path.join(mkTmp("agp-relaunch-"), "args.txt");
  // 模拟 IDE 主进程：带空格参数与 --open-url 尾巴（"--" 防止 node 把后续参数当作自身选项而直接退出）
  const fakeMain = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)", "--", "--user-data-dir=C:\\a b\\ud", "--open-url", "antigravity://cb"], { stdio: "ignore" });
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(fakeMain.exitCode, null, "模拟主进程应保持运行");
    const probe = `Start-Sleep -Milliseconds 300; Set-Content -LiteralPath ${"'" + marker.replace(/'/g, "''") + "'"} -Value ([string]$env:${ARGS_ENV}) -Encoding UTF8`;
    assert.equal(await runLauncher(buildLauncherScript(fakeMain.pid, probe)), true);
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    const got = fs.readFileSync(marker, "utf8").replace(/^\uFEFF/, "").trim();
    assert.equal(got, '-e "setTimeout(() => {}, 20000)" -- "--user-data-dir=C:\\a b\\ud"');
  } finally {
    fakeMain.kill();
  }
});
