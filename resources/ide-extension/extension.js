// @ts-check
"use strict";

/**
 * Antigravity Proxy IDE 插件入口（组装层：只负责依赖装配、命令注册与生命周期，具体逻辑在 lib/）。
 *
 * 功能：
 * - 底部状态栏：展示补丁/配置/代理连通状态，点击打开配置面板
 * - 配置面板：可视化编辑安装目录下的 config.json，保存后一键重启 IDE 生效
 * - 补丁守护：IDE 更新清除 version.dll / config.json 后，启动时自动从插件内置副本恢复
 * - 首次引导：首次启动时若当前代理不可用，自动打开设置并扫描本机可用代理
 * - 多语言：简体中文 / English / Русский，默认跟随 IDE 显示语言，可在设置中覆盖
 */

const vscode = require("vscode");
const fs = require("fs");
const Core = require("./lib/core");
const I18n = require("./media/i18n");
const { resolveInstallInfo } = require("./lib/installInfo");
const { ConfigStore } = require("./lib/configStore");
const { PatchGuard } = require("./lib/patchGuard");
const { ProxyStatusBar } = require("./lib/statusBar");
const { ConfigPanel } = require("./lib/configPanel");
const { probeProxy } = require("./lib/proxyProbe");
const { scanLocalProxies } = require("./lib/proxyScan");
const { restartIde } = require("./lib/restart");
const { findMissingTargets, withTargetsAdded } = require("./lib/configHealth");

const CONFIG_SECTION = "antigravityProxy";
// 首次引导只执行一次（全局状态，不随工作区变化）
const ONBOARDED_KEY = "antigravityProxy.onboarded";
// 扩展宿主启动时刻：config.json 修改时间晚于此刻（留 2 秒余量）说明运行中的 DLL 仍在使用旧配置
const HOST_STARTED_AT = Date.now() - process.uptime() * 1000;

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  // ---- 多语言：tr 为稳定引用，语言切换后各模块自动使用新语言 ----
  const currentLang = () => I18n.resolveLang(vscode.workspace.getConfiguration(CONFIG_SECTION).get("language", "auto"), vscode.env.language);
  let t = I18n.createT(currentLang());
  /** @type {(key: string, params?: Record<string, any>) => string} */
  const tr = (key, params) => t(key, params);

  const info = resolveInstallInfo(vscode.env.appRoot);

  if (!info.supported) {
    // 非 Windows：代理补丁为 version.dll 劫持方案，不适用；命令给出明确说明而不是静默失败
    const unsupported = () => vscode.window.showInformationMessage(tr("ext.unsupported"));
    for (const id of ["openSettings", "testProxy", "repairPatch", "restartIde", "openLogs", "scanProxy"]) {
      context.subscriptions.push(vscode.commands.registerCommand(`${CONFIG_SECTION}.${id}`, unsupported));
    }
    return;
  }

  const store = new ConfigStore(info.configPath, context.globalStorageUri.fsPath, tr);
  const guard = new PatchGuard(info, store, context.extensionPath, tr);
  const statusBar = new ProxyStatusBar(vscode, tr);
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
      lastReach = await probeProxy(proxy, { tcpOnly: true, timeoutMs: 3000, t: tr });
    }
    statusBar.render({
      patch: guard.check(),
      configStatus: read.status,
      proxy,
      reach: proxy && proxy.port > 0 ? lastReach : null,
      pendingRestart: isPendingRestart(),
      missingTargets: read.status === "ok" ? findMissingTargets(read.raw) : [],
    });
  };

  /** 状态栏悬浮提示「一键补齐」：把缺少的后端进程写入 target_processes（写前自动备份），提示重启生效 */
  const fixTargets = async () => {
    const read = store.read();
    if (read.status !== "ok") return;
    const missing = findMissingTargets(read.raw);
    if (missing.length === 0) return;
    const r = store.write(withTargetsAdded(read.raw, missing));
    if (!r.ok) {
      void vscode.window.showErrorMessage(tr("ext.targetsFixFailed", { error: r.error }));
      return;
    }
    sessionPendingRestart = true;
    await refresh();
    ConfigPanel.refreshIfOpen();
    const pick = await vscode.window.showInformationMessage(
      tr("ext.targetsFixed", { names: missing.join(", ") }),
      tr("common.restartNow"),
    );
    if (pick === tr("common.restartNow")) await restart();
  };

  const restart = () => restartIde(vscode, info.exePath, tr);

  /** 修复补丁并引导重启；silent=true 时仅在有实际动作时提示 */
  const repair = async (silent = false) => {
    const r = guard.restore();
    if (r.ok && r.restored.length > 0) sessionPendingRestart = true;
    // 先刷新状态栏与面板再弹提示：提示会一直等待用户点击（启动期还可能直接收进通知中心），
    // 若先等提示，状态栏会在用户响应前一直空白
    await refresh();
    ConfigPanel.refreshIfOpen();
    if (!r.ok) {
      void vscode.window.showErrorMessage(tr("ext.repairFailed", { error: r.error }));
    } else if (r.restored.length > 0) {
      const pick = await vscode.window.showWarningMessage(
        tr("ext.repairRestored", { files: r.restored.join(tr("common.listSep")) }),
        tr("common.restartNow"),
        tr("common.later"),
      );
      if (pick === tr("common.restartNow")) await restart();
    } else if (!silent) {
      const s = guard.check();
      if (s.needsRestart || isPendingRestart()) {
        const pick = await vscode.window.showInformationMessage(tr("ext.repairNotLoaded"), tr("common.restartNow"));
        if (pick === tr("common.restartNow")) await restart();
      } else {
        void vscode.window.showInformationMessage(tr("ext.repairAllGood"));
      }
    }
  };

  /** 扫描本机代理：IDE http.proxy 设置由此处读取，扫描模块本身不依赖 vscode API */
  const scan = (/** @type {any} */ current) => scanLocalProxies({
    current,
    ideProxy: vscode.workspace.getConfiguration("http").get("proxy", ""),
    t: tr,
  });

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
    scan,
    t: tr,
    lang: currentLang,
  });
  const openSettings = () => ConfigPanel.show(panelDeps());

  context.subscriptions.push(
    vscode.commands.registerCommand(`${CONFIG_SECTION}.openSettings`, openSettings),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.scanProxy`, () => ConfigPanel.show(panelDeps(), { intent: "scan" })),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.restartIde`, restart),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.repairPatch`, () => repair()),
    // 仅供状态栏悬浮提示链接调用（未在 package.json 声明，不出现在命令面板）
    vscode.commands.registerCommand(`${CONFIG_SECTION}.fixTargets`, fixTargets),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.openLogs`, async () => {
      if (fs.existsSync(info.logsDir)) await vscode.env.openExternal(vscode.Uri.file(info.logsDir));
      else void vscode.window.showWarningMessage(tr("ext.logsNotFound", { path: info.logsDir }));
    }),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.testProxy`, async () => {
      const read = store.read();
      if (read.status !== "ok") {
        void vscode.window.showWarningMessage(tr("ext.testConfigBad"), tr("common.openSettings"))
          .then((p) => p && openSettings());
        return;
      }
      const proxy = Core.normalizeForm(read.raw).proxy;
      const r = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: tr("ext.testProgress", { url: `${proxy.type}://${proxy.host}:${proxy.port}` }) },
        () => probeProxy(proxy, { t: tr }),
      );
      lastReach = r;
      void refresh();
      if (r.ok) void vscode.window.showInformationMessage(tr("ext.testOk", { message: r.message, ms: r.latencyMs }));
      else void vscode.window.showWarningMessage(tr("ext.testFail", { message: r.message }), tr("common.openSettings")).then((p) => p && openSettings());
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${CONFIG_SECTION}.language`)) {
        t = I18n.createT(currentLang());
        ConfigPanel.relocalizeIfOpen();
      }
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

  /**
   * 首次引导（只执行一次）：当前代理可用 → 轻提示；不可用 → 自动打开设置并扫描本机代理。
   * 配置缺失/损坏交给补丁守护与面板空态处理；proxy.port=0 视为用户主动禁用，不打扰。
   */
  const maybeOnboard = async () => {
    if (context.globalState.get(ONBOARDED_KEY)) return;
    const read = store.read();
    if (read.status !== "ok" || !guard.check().dllExists) return;
    const proxy = Core.normalizeForm(read.raw).proxy;
    await context.globalState.update(ONBOARDED_KEY, true);
    if (proxy.port === 0) return;
    const r = await probeProxy(proxy, { timeoutMs: 6000, t: tr });
    if (r.ok) {
      const pick = await vscode.window.showInformationMessage(
        tr("ext.onboardOk", { url: `${proxy.type}://${proxy.host}:${proxy.port}`, ms: r.latencyMs }),
        tr("common.openSettings"),
      );
      if (pick) openSettings();
    } else {
      ConfigPanel.show(panelDeps(), { intent: "onboarding" });
    }
  };

  // ---- 启动时补丁守护（P2）----
  const read = store.read();
  if (read.status === "ok") store.saveLastGood(read.raw); // 记录用户当前配置，供下次更新清空后恢复
  if (guard.isWiped()) {
    const auto = vscode.workspace.getConfiguration(CONFIG_SECTION).get("patchGuard.autoRestore", true);
    if (auto) {
      // repair 的文件恢复是同步完成的，其后的提示不阻塞下方的状态刷新
      void repair(true);
    } else {
      void vscode.window.showWarningMessage(tr("ext.guardWiped"), tr("ext.restoreOneClick"), tr("ext.enableAutoRestore")).then(async (pick) => {
        if (pick === tr("ext.enableAutoRestore")) {
          await vscode.workspace.getConfiguration(CONFIG_SECTION).update("patchGuard.autoRestore", true, vscode.ConfigurationTarget.Global);
        }
        if (pick) await repair(true);
      });
    }
  }
  // 状态栏立即展示（含一次轻量连通检测），不等待任何提示框
  void refresh(true);
  void maybeOnboard();
}

function deactivate() {}

module.exports = { activate, deactivate };
