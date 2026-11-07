// @ts-check
"use strict";

/**
 * Antigravity Proxy IDE 插件入口（组装层：只负责依赖装配、命令注册与生命周期，具体逻辑在 lib/）。
 *
 * 功能：
 * - 底部状态栏：展示补丁/配置/代理连通状态，点击打开配置面板
 * - 配置面板：可视化编辑安装目录下的 config.json，保存后一键重启 IDE 生效
 * - 补丁守护：IDE 更新清除 version.dll / config.json 后，启动时自动从插件内置副本恢复
 */

const vscode = require("vscode");
const fs = require("fs");
const Core = require("./lib/core");
const { resolveInstallInfo } = require("./lib/installInfo");
const { ConfigStore } = require("./lib/configStore");
const { PatchGuard } = require("./lib/patchGuard");
const { ProxyStatusBar } = require("./lib/statusBar");
const { ConfigPanel } = require("./lib/configPanel");
const { probeProxy } = require("./lib/proxyProbe");
const { restartIde } = require("./lib/restart");

const CONFIG_SECTION = "antigravityProxy";
// 扩展宿主启动时刻：config.json 修改时间晚于此刻（留 2 秒余量）说明运行中的 DLL 仍在使用旧配置
const HOST_STARTED_AT = Date.now() - process.uptime() * 1000;

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const info = resolveInstallInfo(vscode.env.appRoot);

  if (!info.supported) {
    // 非 Windows：代理补丁为 version.dll 劫持方案，不适用；命令给出明确说明而不是静默失败
    const unsupported = () => vscode.window.showInformationMessage("Antigravity Proxy 插件仅支持 Windows 版 Antigravity IDE。");
    for (const id of ["openSettings", "testProxy", "repairPatch", "restartIde", "openLogs"]) {
      context.subscriptions.push(vscode.commands.registerCommand(`${CONFIG_SECTION}.${id}`, unsupported));
    }
    return;
  }

  const store = new ConfigStore(info.configPath, context.globalStorageUri.fsPath);
  const guard = new PatchGuard(info, store, context.extensionPath);
  const statusBar = new ProxyStatusBar(vscode);
  context.subscriptions.push(statusBar);

  let sessionPendingRestart = false;
  /** @type {import("./lib/proxyProbe").ProbeResult | null} */
  let lastReach = null;

  const isPendingRestart = () => {
    if (sessionPendingRestart) return true;
    try {
      return fs.statSync(info.configPath).mtimeMs > HOST_STARTED_AT + 2000;
    } catch {
      return false;
    }
  };

  /** 刷新状态栏；probe=true 时顺带做一次轻量 TCP 连通检测 */
  const refresh = async (probe = false) => {
    const enabled = vscode.workspace.getConfiguration(CONFIG_SECTION).get("statusBar.enabled", true);
    if (!enabled) {
      statusBar.hide();
      return;
    }
    const read = store.read();
    const proxy = read.status === "ok" ? Core.normalizeForm(read.raw).proxy : null;
    if (probe && proxy && proxy.port > 0) {
      lastReach = await probeProxy(proxy, { tcpOnly: true, timeoutMs: 3000 });
    }
    statusBar.render({
      patch: guard.check(),
      configStatus: read.status,
      proxy,
      reach: proxy && proxy.port > 0 ? lastReach : null,
      pendingRestart: isPendingRestart(),
    });
  };

  const restart = () => restartIde(vscode, info.exePath);

  /** 修复补丁并引导重启；silent=true 时仅在有实际动作时提示 */
  const repair = async (silent = false) => {
    const r = guard.restore();
    if (r.ok && r.restored.length > 0) sessionPendingRestart = true;
    // 先刷新状态栏与面板再弹提示：提示会一直等待用户点击（启动期还可能直接收进通知中心），
    // 若先等提示，状态栏会在用户响应前一直空白
    await refresh();
    ConfigPanel.refreshIfOpen();
    if (!r.ok) {
      void vscode.window.showErrorMessage(`代理补丁恢复失败：${r.error}`);
    } else if (r.restored.length > 0) {
      const pick = await vscode.window.showWarningMessage(
        `已恢复代理补丁：${r.restored.join("、")}。重启 IDE 后代理生效。`,
        "立即重启",
        "稍后",
      );
      if (pick === "立即重启") await restart();
    } else if (!silent) {
      const s = guard.check();
      if (s.needsRestart || isPendingRestart()) {
        const pick = await vscode.window.showInformationMessage("补丁文件完整，但当前 IDE 进程尚未加载，重启后生效。", "立即重启");
        if (pick === "立即重启") await restart();
      } else {
        void vscode.window.showInformationMessage("代理补丁完整，且已在当前 IDE 中生效。");
      }
    }
  };

  const panelDeps = () => ({
    vscode,
    extensionUri: context.extensionUri,
    info,
    store,
    guard,
    isPendingRestart,
    onSaved: () => {
      sessionPendingRestart = true;
      void refresh(true);
    },
    restart,
    repair: () => repair(),
  });

  context.subscriptions.push(
    vscode.commands.registerCommand(`${CONFIG_SECTION}.openSettings`, () => ConfigPanel.show(panelDeps())),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.restartIde`, restart),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.repairPatch`, () => repair()),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.openLogs`, async () => {
      if (fs.existsSync(info.logsDir)) await vscode.env.openExternal(vscode.Uri.file(info.logsDir));
      else void vscode.window.showWarningMessage(`日志目录尚未生成：${info.logsDir}`);
    }),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.testProxy`, async () => {
      const read = store.read();
      if (read.status !== "ok") {
        void vscode.window.showWarningMessage("config.json 缺失或无法解析，请先在代理设置中修复。", "打开设置")
          .then((p) => p && ConfigPanel.show(panelDeps()));
        return;
      }
      const proxy = Core.normalizeForm(read.raw).proxy;
      const r = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `正在测试代理 ${proxy.type}://${proxy.host}:${proxy.port} …` },
        () => probeProxy(proxy),
      );
      lastReach = r;
      void refresh();
      if (r.ok) void vscode.window.showInformationMessage(`代理可用：${r.message}（${r.latencyMs} ms）`);
      else void vscode.window.showWarningMessage(`代理不可用：${r.message}`, "打开设置").then((p) => p && ConfigPanel.show(panelDeps()));
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(CONFIG_SECTION)) {
        scheduleProbe();
        void refresh(true);
      }
    }),
  );

  // 周期性轻量检测（间隔可配置；0 表示仅启动与保存后检测）
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const scheduleProbe = () => {
    if (timer) clearInterval(timer);
    const sec = Number(vscode.workspace.getConfiguration(CONFIG_SECTION).get("statusBar.probeIntervalSeconds", 60));
    timer = sec > 0 ? setInterval(() => void refresh(true), Math.max(10, sec) * 1000) : undefined;
  };
  scheduleProbe();
  context.subscriptions.push({ dispose: () => timer && clearInterval(timer) });

  // ---- 启动时补丁守护（P2）----
  const read = store.read();
  if (read.status === "ok") store.saveLastGood(read.raw); // 记录用户当前配置，供下次更新清空后恢复
  if (guard.isWiped()) {
    const auto = vscode.workspace.getConfiguration(CONFIG_SECTION).get("patchGuard.autoRestore", true);
    if (auto) {
      // repair 的文件恢复是同步完成的，其后的提示不阻塞下方的状态刷新
      void repair(true);
    } else {
      void vscode.window.showWarningMessage("检测到代理补丁缺失（常见于 IDE 自动更新后）。", "一键恢复", "开启自动恢复").then(async (pick) => {
        if (pick === "开启自动恢复") {
          await vscode.workspace.getConfiguration(CONFIG_SECTION).update("patchGuard.autoRestore", true, vscode.ConfigurationTarget.Global);
        }
        if (pick) await repair(true);
      });
    }
  }
  // 状态栏立即展示（含一次轻量连通检测），不等待任何提示框
  void refresh(true);
}

function deactivate() {}

module.exports = { activate, deactivate };
