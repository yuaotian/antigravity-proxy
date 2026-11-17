// 外部编辑器 ACP 代理（Issue #164）单元测试：node --test resources/ide-extension/test/acpSupport.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const Acp = require("../lib/acpSupport.js");
const { PatchGuard } = require("../lib/patchGuard.js");
const { ConfigStore } = require("../lib/configStore.js");

const sha = (/** @type {string} */ p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

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

/** @param {string} filePath @param {string} [content] */
const touch = (filePath, content = "x") => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
};

// ---------------- 检测 ----------------

test("findAgyCandidates：按 IDE 托管 → 独立 CLI 顺序返回存在的 agy.exe，并读取 IDE 版本号", () => {
  const home = mkTmp("agp-acp-home-");
  const local = path.join(home, "AppData", "Local");
  touch(path.join(home, ".gemini", "bin", "agy.exe"));
  touch(path.join(home, ".gemini", "bin", "agy.version.json"), JSON.stringify({ version: "1.5.10" }));
  touch(path.join(local, "agy", "bin", "agy.exe"));

  const found = Acp.findAgyCandidates({ homeDir: home, env: { LOCALAPPDATA: local } });
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((f) => f.source), ["ide", "cli"]);
  assert.equal(found[0].version, "1.5.10");
  assert.equal(found[1].version, undefined);
  assert.ok(found.every((f) => f.kind === "agy"));
});

test("findAgyCandidates：什么都没装时返回空数组", () => {
  const home = mkTmp("agp-acp-empty-");
  assert.deepEqual(Acp.findAgyCandidates({ homeDir: home, env: { LOCALAPPDATA: path.join(home, "L") } }), []);
});

test("findRegistryServers：有界扫描找到 agy_acp_server.exe，新版本排在前面，跳过 node_modules", async () => {
  const root = mkTmp("agp-acp-reg-");
  touch(path.join(root, "acp-agents", "antigravity-acp", "1.4.1", "agy_acp_server.exe"));
  touch(path.join(root, "acp-agents", "antigravity-acp", "1.5.0", "AGY_ACP_SERVER.EXE"));
  touch(path.join(root, "node_modules", "x", "1.9.9", "agy_acp_server.exe"));

  const found = await Acp.findRegistryServers({ roots: [root] });
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((f) => f.version), ["1.5.0", "1.4.1"]);
  assert.ok(found.every((f) => f.kind === "registry" && f.source === "registry"));
});

test("findRegistryServers：超过深度上限的目录不扫描，不存在的根目录被忽略", async () => {
  const root = mkTmp("agp-acp-deep-");
  touch(path.join(root, "a", "b", "c", "agy_acp_server.exe"));
  assert.equal((await Acp.findRegistryServers({ roots: [root], maxDepth: 2 })).length, 0);
  assert.equal((await Acp.findRegistryServers({ roots: [root], maxDepth: 3 })).length, 1);
  assert.equal((await Acp.findRegistryServers({ roots: [path.join(root, "missing")] })).length, 0);
});

test("guessVersionFromPath：取路径中最近的版本目录名", () => {
  assert.equal(Acp.guessVersionFromPath("C:\\x\\antigravity-acp\\1.5.0\\windows-x86_64\\agy_acp_server.exe"), "1.5.0");
  assert.equal(Acp.guessVersionFromPath("C:\\x\\v2.0.1-preview.3\\agy_acp_server.exe"), "2.0.1-preview.3");
  assert.equal(Acp.guessVersionFromPath("C:\\x\\agy_acp_server.exe"), undefined);
});

// ---------------- 配置生成 ----------------

test("buildAgentCommand：agy 追加 acp 子命令，Registry 版直接启动", () => {
  const wrapper = "C:\\IDE\\agy-acp-proxy.exe";
  assert.deepEqual(Acp.buildAgentCommand(wrapper, { kind: "agy", path: "C:\\u\\.gemini\\bin\\agy.exe", source: "ide" }),
    { command: wrapper, args: ["C:\\u\\.gemini\\bin\\agy.exe", "acp"] });
  assert.deepEqual(Acp.buildAgentCommand(wrapper, { kind: "registry", path: "D:\\r\\agy_acp_server.exe", source: "registry" }),
    { command: wrapper, args: ["D:\\r\\agy_acp_server.exe"] });
  // 手选的文件名为 agy.exe 时同样按 `agy acp` 处理
  assert.deepEqual(Acp.buildAgentCommand(wrapper, { kind: "custom", path: "E:\\tools\\AGY.EXE", source: "custom" }).args,
    ["E:\\tools\\AGY.EXE", "acp"]);
});

test("buildClientSnippets：三种编辑器结构正确，命令行对含空格路径加引号", () => {
  const cmd = { command: "C:\\Program Files\\IDE\\agy-acp-proxy.exe", args: ["C:\\u\\agy.exe", "acp"] };
  const s = Acp.buildClientSnippets(cmd);
  assert.deepEqual(s.zed.agent_servers[Acp.ACP_AGENT_NAME], { type: "custom", ...cmd });
  assert.deepEqual(s.jetbrains.agent_servers[Acp.ACP_AGENT_NAME], cmd);
  assert.deepEqual(s.vscode["acp.agents"][Acp.ACP_AGENT_NAME], cmd);
  assert.equal(s.commandLine, "\"C:\\Program Files\\IDE\\agy-acp-proxy.exe\" C:\\u\\agy.exe acp");
});

test("mergeJetBrainsAcpJson：新建 / 保留已有 Agent / 覆盖同名旧条目", () => {
  const cmd = { command: "C:\\IDE\\agy-acp-proxy.exe", args: ["C:\\u\\agy.exe", "acp"] };

  const created = Acp.mergeJetBrainsAcpJson(null, cmd);
  assert.equal(created.ok, true);
  assert.deepEqual(JSON.parse(/** @type {any} */ (created).text), { agent_servers: { [Acp.ACP_AGENT_NAME]: cmd } });

  const existing = JSON.stringify({ default_mcp_settings: { x: 1 }, agent_servers: { Other: { command: "other.exe" } } });
  const merged = Acp.mergeJetBrainsAcpJson(existing, cmd);
  assert.equal(merged.ok, true);
  const obj = JSON.parse(/** @type {any} */ (merged).text);
  assert.deepEqual(obj.default_mcp_settings, { x: 1 });
  assert.deepEqual(obj.agent_servers.Other, { command: "other.exe" });
  assert.deepEqual(obj.agent_servers[Acp.ACP_AGENT_NAME], cmd);

  // 记事本保存的 BOM 不应被当成“含注释”
  assert.equal(Acp.mergeJetBrainsAcpJson("\uFEFF{}", cmd).ok, true);
});

test("mergeJetBrainsAcpJson：含注释时不改写，结构异常时报告 invalid", () => {
  const cmd = { command: "w.exe", args: [] };
  assert.deepEqual(Acp.mergeJetBrainsAcpJson('{\n  // 注释\n  "agent_servers": {}\n}', cmd), { ok: false, reason: "comments" });
  assert.deepEqual(Acp.mergeJetBrainsAcpJson("{not json", cmd), { ok: false, reason: "invalid" });
  assert.deepEqual(Acp.mergeJetBrainsAcpJson("[]", cmd), { ok: false, reason: "invalid" });
  assert.deepEqual(Acp.mergeJetBrainsAcpJson('{"agent_servers": []}', cmd), { ok: false, reason: "invalid" });
});

test("analyzeAgentServers：区分已走包装器与直连的 Antigravity Agent（支持 Zed 的 JSONC）", () => {
  const zed = `{
    // Zed 默认设置里常见注释
    "agent_servers": {
      "Antigravity": { "type": "custom", "command": "agy", "args": ["acp"] },
    },
  }`;
  assert.deepEqual(Acp.analyzeAgentServers(zed), { proxied: false, unwrapped: true });

  const jb = JSON.stringify({ agent_servers: {
    a: { command: "C:\\IDE\\agy-acp-proxy.exe", args: ["C:\\u\\agy.exe", "acp"] },
    b: { command: "D:\\r\\agy_acp_server.exe" },
  } });
  assert.deepEqual(Acp.analyzeAgentServers(jb), { proxied: true, unwrapped: true });

  assert.deepEqual(Acp.analyzeAgentServers(JSON.stringify({ agent_servers: { c: { command: "claude" } } })), { proxied: false, unwrapped: false });
  assert.deepEqual(Acp.analyzeAgentServers(null), { proxied: false, unwrapped: false });
  assert.deepEqual(Acp.analyzeAgentServers("{broken"), { proxied: false, unwrapped: false });
});

// ---------------- 补丁守护：包装器部署与恢复 ----------------

/** @param {{ restoreWrapper?: boolean, withPayload?: boolean }} [opts] */
function guardFixture(opts = {}) {
  const root = mkTmp("agp-acp-guard-");
  const installDir = path.join(root, "install");
  const extDir = path.join(root, "ext");
  fs.mkdirSync(installDir);
  fs.mkdirSync(path.join(extDir, "payload"), { recursive: true });
  fs.writeFileSync(path.join(extDir, "payload", "version.dll"), "MZ-dll");
  fs.writeFileSync(path.join(extDir, "payload", "config.json"), JSON.stringify({ proxy: { port: 7890 } }));
  if (opts.withPayload !== false) fs.writeFileSync(path.join(extDir, "payload", Acp.ACP_WRAPPER_NAME), "MZ-wrapper-v2");
  const info = {
    supported: true,
    installDir,
    exePath: path.join(installDir, "Antigravity IDE.exe"),
    dllPath: path.join(installDir, "version.dll"),
    configPath: path.join(installDir, "config.json"),
    logsDir: path.join(installDir, "logs"),
  };
  const store = new ConfigStore(info.configPath, path.join(root, "storage"));
  const guard = new PatchGuard(info, store, extDir, undefined, { shouldRestoreAcpWrapper: () => !!opts.restoreWrapper });
  return { guard, installDir, extDir, wrapper: path.join(installDir, Acp.ACP_WRAPPER_NAME) };
}

test("deployAcpWrapper：首次部署、内容一致时不重复写、旧版本被更新", () => {
  const f = guardFixture();
  const first = f.guard.deployAcpWrapper();
  assert.equal(first.ok, true);
  assert.equal(/** @type {any} */ (first).changed, true);
  assert.equal(sha(f.wrapper), sha(path.join(f.extDir, "payload", Acp.ACP_WRAPPER_NAME)));

  const again = f.guard.deployAcpWrapper();
  assert.equal(/** @type {any} */ (again).changed, false);

  fs.writeFileSync(f.wrapper, "MZ-wrapper-v1");
  assert.equal(f.guard.checkAcpWrapper().upToDate, false);
  assert.equal(/** @type {any} */ (f.guard.deployAcpWrapper()).changed, true);
  assert.equal(f.guard.checkAcpWrapper().upToDate, true);
});

test("deployAcpWrapper：插件未携带包装器时明确报错", () => {
  const f = guardFixture({ withPayload: false });
  const r = f.guard.deployAcpWrapper();
  assert.equal(r.ok, false);
  assert.match(/** @type {any} */ (r).error, /agy-acp-proxy\.exe/);
});

test("restore：只有用户部署过包装器时才在 IDE 更新后恢复它", () => {
  const off = guardFixture({ restoreWrapper: false });
  assert.equal(off.guard.restore().ok, true);
  assert.equal(fs.existsSync(off.wrapper), false);

  const on = guardFixture({ restoreWrapper: true });
  const r = on.guard.restore();
  assert.equal(r.ok, true, r.error);
  assert.ok(r.restored.includes(Acp.ACP_WRAPPER_NAME));
  assert.equal(fs.existsSync(on.wrapper), true);
});
