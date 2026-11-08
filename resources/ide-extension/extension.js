// @ts-check
"use strict";

/**
 * Antigravity Proxy IDE 插件入口（组装层：只负责依赖装配、命令注册与生命周期，具体逻辑在 lib/）。
 *
 * 功能：
 * - 底部状态栏：补丁/配置/代理/连通 + 代理出口 IP·运营商 + Gemini 可用性（可分别关闭）
 * - 左侧活动栏 WebviewView：状态卡片、出口 IP、Gemini 三层结论、实时日志、插件更新、快捷操作
 * - 底部面板「代理日志」：级别筛选、关键字搜索高亮、暂停/清空/复制、打开文件/目录
 * - 配置面板：可视化编辑安装目录下的 config.json，保存后一键重启 IDE 生效
 * - 补丁守护：IDE 更新清除 version.dll / config.json 后，启动时自动从插件内置副本恢复
 * - 插件自更新：本地代理 → GitHub 镜像 → 直连，下载后校验 SHA256，再安装并提示重载
 * - 多语言：简体中文 / English / Русский
 */

const vscode = require("vscode");
const fs = require("fs");
const Core = require("./lib/core");
const I18n = require("./media/i18n");
const { resolveInstallInfo } = require("./lib/installInfo");
const { ConfigStore } = require("./lib/configStore");
const { PatchGuard } = require("./lib/patchGuard");
const { ProxyStatusBar } = require("./lib/statusBar");
const { ProxySidebarProvider } = require("./lib/sidebarView");
const { ConfigPanel } = require("./lib/configPanel");
const { LogService } = require("./lib/logService");
const { LogViewProvider } = require("./lib/logView");
const { IpInfoService } = require("./lib/ipInfo");
const { checkGemini } = require("./lib/geminiCheck");
const { ExtensionUpdater } = require("./lib/updater");
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
    for (const id of ["openSettings", "testProxy", "repairPatch", "restartIde", "openLogs", "scanProxy", "openLogsWindow", "checkGemini", "refreshIp", "checkUpdate", "focusSidebar", "switchLanguage"]) {
      context.subscriptions.push(vscode.commands.registerCommand(`${CONFIG_SECTION}.${id}`, unsupported));
    }
    return;
  }

  const store = new ConfigStore(info.configPath, context.globalStorageUri.fsPath, tr);
  const guard = new PatchGuard(info, store, context.extensionPath, tr);
  const iconUri = vscode.Uri.joinPath(context.extensionUri, "media", "icon.png");
  const statusBar = new ProxyStatusBar(vscode, tr, iconUri);
  const extVersion = String(context.extension?.packageJSON?.version || "0.0.0");

  // ---- 日志：插件事件 + DLL 文件日志合并成一条可订阅的实时流 ----
  const logService = new LogService({ installDir: info.installDir, t: tr });
  logService.start();
  context.subscriptions.push({ dispose: () => logService.dispose() });
  /** @param {"debug" | "info" | "warn" | "error"} level @param {string} text */
  const log = (level, text) => logService.add(level, text);
  log("info", `插件已激活 v${extVersion}`);

  /** 从 config.json 读取当前代理（缺失/禁用返回 null） */
  const getProxy = () => {
    const read = store.read();
    if (read.status !== "ok") return null;
    const proxy = Core.normalizeForm(read.raw).proxy;
    return proxy && proxy.port > 0 ? proxy : null;
  };

  /** 出口 IP 查询（代理优先，直连兜底） */
  const ipInfo = new IpInfoService({ getProxy, t: tr });
  /** @type {{ checking: boolean, result: any, error: string }} */
  let geminiState = { checking: false, result: null, error: "" };

  /** 插件自更新 */
  const updater = new ExtensionUpdater({ vscode, context, info, t: tr, log, getProxy });

  let sessionPendingRestart = false;
  /** @type {import("./lib/proxyProbe").ProbeResult | null} */
  let lastReach = null;
  /** @type {ProxySidebarProvider | undefined} */
  let sidebar;
  /** @type {LogViewProvider | undefined} */
  let logView;

  const isPendingRestart = () => {
    if (sessionPendingRestart) return true;
    try {
      return fs.statSync(info.configPath).mtimeMs > HOST_STARTED_AT + 2000;
    } catch {
      return false;
    }
  };

  /** 刷新底部状态栏与左侧视图；probe=true 时顺带做一次轻量 TCP 连通检测并展示探测动效 */
  const refresh = async (probe = false) => {
    const enabled = vscode.workspace.getConfiguration(CONFIG_SECTION).get("statusBar.enabled", true);
    const read = store.read();
    const proxy = read.status === "ok" ? Core.normalizeForm(read.raw).proxy : null;
    const baseModel = () => ({
      patch: guard.check(),
      configStatus: read.status,
      proxy,
      reach: proxy && proxy.port > 0 ? lastReach : null,
      pendingRestart: isPendingRestart(),
      missingTargets: read.status === "ok" ? findMissingTargets(read.raw) : [],
      egress: ipInfo.state,
      gemini: geminiState,
      update: updater.getState(),
      version: extVersion,
    });
    if (probe && proxy && proxy.port > 0) {
      const probingModel = { ...baseModel(), probing: true };
      sidebar?.render(probingModel);
      if (enabled) statusBar.render(probingModel);
      else statusBar.hide();
      lastReach = await probeProxy(proxy, { tcpOnly: true, timeoutMs: 3000, t: tr });
    }
    const finalModel = baseModel();
    sidebar?.render(finalModel);
    if (enabled) statusBar.render(finalModel);
    else statusBar.hide();
    // 底部日志窗口的环境条（代理 / 出口 IP / Gemini）随状态刷新
    logView?.updateEnv();
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

  const openLogsFolder = async () => {
    if (fs.existsSync(info.logsDir)) await vscode.env.openExternal(vscode.Uri.file(info.logsDir));
    else void vscode.window.showWarningMessage(tr("ext.logsNotFound", { path: info.logsDir }));
  };

  /** 完整隧道探测（命令/面板用） */
  const runTestProxy = async () => {
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
  };

  /**
   * 执行一次 Gemini / Antigravity 可用性检测。
   * 说明：三层探测（网络 / Gemini API 区域 / loadCodeAssist + Antigravity 日志证据）见 lib/geminiCheck.js。
   * @param {boolean} [silent]
   */
  const runGeminiCheck = async (silent = true) => {
    if (geminiState.checking) return geminiState.result;
    geminiState = { ...geminiState, checking: true };
    await refresh(false);
    try {
      const result = await checkGemini({ proxy: getProxy(), t: tr, appDataDir: process.env.APPDATA });
      geminiState = { checking: false, result, error: "" };
      log(result.state === "blocked" ? "warn" : "info", `Gemini 检测完成：${result.state}`);
    } catch (e) {
      geminiState = { checking: false, result: null, error: /** @type {Error} */ (e).message || String(e) };
      log("warn", `Gemini 检测失败：${geminiState.error}`);
    }
    await refresh(false);
    if (!silent && !geminiState.result) void vscode.window.showWarningMessage(geminiState.error);
    return geminiState.result;
  };

  /** 手动切换界面语言：写 VS Code 全局设置；onDidChangeConfiguration 负责重建各视图 */
  const setLanguage = async (/** @type {string} */ lang) => {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const next = ["auto", "zh-cn", "en", "ru"].includes(lang) ? lang : "auto";
    if (cfg.get("language", "auto") === next) {
      sidebar?.relocalize();
      logView?.relocalize();
      ConfigPanel.relocalizeIfOpen();
      return;
    }
    await cfg.update("language", next, vscode.ConfigurationTarget.Global);
  };

  /** 侧栏/命令面板共用的语言选择器 */
  const pickLanguage = async () => {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const current = cfg.get("language", "auto");
    const items = [
      { value: "auto", label: tr("lang.auto") },
      { value: "zh-cn", label: tr("lang.zh") },
      { value: "en", label: tr("lang.en") },
      { value: "ru", label: tr("lang.ru") },
    ].map((o) => ({
      label: o.label,
      description: o.value === current ? "\u2713" : "",
      value: o.value,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: tr("side2.languageTitle"),
      placeHolder: tr("side2.languageTitle"),
      matchOnDescription: false,
    });
    if (picked) await setLanguage(picked.value);
  };

  /** 头部更新图标：按当前状态检查 / 下载安装 / 重载 */
  const updateClick = async () => {
    const s = updater.getState();
    if (s.status === "available") return updater.downloadAndInstall();
    if (s.status === "installed") return vscode.commands.executeCommand("workbench.action.reloadWindow");
    if (s.status === "checking" || s.status === "downloading" || s.status === "installing") return;
    return updater.check({ manual: true });
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
    scan,
    t: tr,
    lang: currentLang,
    languagePref: () => vscode.workspace.getConfiguration(CONFIG_SECTION).get("language", "auto"),
    setLanguage,
  });
  const openSettings = () => ConfigPanel.show(panelDeps());

  const openLogsWindow = () => logView?.reveal();

  /** 侧边栏动作表：webview 只发 action 名称，具体行为都在宿主侧 */
  const sidebarActions = {
    openSettings,
    scanProxy: () => ConfigPanel.show(panelDeps(), { intent: "scan" }),
    testProxy: runTestProxy,
    repairPatch: () => repair(),
    restartIde: restart,
    openLogs: openLogsFolder,
    openLogWindow: openLogsWindow,
    refreshIp: () => ipInfo.get({ force: true }),
    checkGemini: () => runGeminiCheck(false),
    checkUpdate: () => updater.check({ manual: true }),
    applyUpdate: () => updater.downloadAndInstall(),
    updateClick,
    pickLanguage,
    reloadWindow: () => vscode.commands.executeCommand("workbench.action.reloadWindow"),
    refreshLogs: () => logService.rescan(),
  };

  const getSettings = () => {
    const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
    return {
      geminiIntervalSeconds: Number(cfg.get("gemini.intervalSeconds", 300)),
      egressIntervalSeconds: Number(cfg.get("egress.refreshIntervalSeconds", 1800)),
      statusProbeSeconds: Number(cfg.get("statusBar.probeIntervalSeconds", 60)),
      language: currentLang(),
      languagePref: cfg.get("language", "auto"),
    };
  };

  // ---- 左侧栏（WebviewView）与日志窗口（底部面板 WebviewView） ----
  sidebar = new ProxySidebarProvider({
    vscode,
    extensionUri: context.extensionUri,
    logService,
    t: tr,
    lang: currentLang,
    version: extVersion,
    getSettings,
    actions: sidebarActions,
  });
  logView = new LogViewProvider({
    vscode,
    extensionUri: context.extensionUri,
    logService,
    t: tr,
    lang: currentLang,
    getEnv: () => ({ proxy: getProxy(), egress: ipInfo.state, gemini: geminiState }),
  });

  context.subscriptions.push(
    statusBar,
    sidebar,
    logView,
    vscode.window.registerWebviewViewProvider("antigravityProxy.sidebar", sidebar, { webviewOptions: { retainContextWhenHidden: false } }),
    vscode.window.registerWebviewViewProvider("antigravityProxy.logs", logView, { webviewOptions: { retainContextWhenHidden: false } }),
  );

  // 服务状态变化 → 刷新模型（不触发网络探测）
  context.subscriptions.push(ipInfo.onDidChange(() => void refresh(false)));
  context.subscriptions.push(updater.onDidChange(() => void refresh(false)));
  context.subscriptions.push({ dispose: () => updater.dispose() });

  // ---- 命令 ----
  context.subscriptions.push(
    vscode.commands.registerCommand(`${CONFIG_SECTION}.openSettings`, openSettings),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.scanProxy`, () => ConfigPanel.show(panelDeps(), { intent: "scan" })),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.restartIde`, restart),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.repairPatch`, () => repair()),
    // 仅供状态栏悬浮提示链接调用（未在 package.json 声明，不出现在命令面板）
    vscode.commands.registerCommand(`${CONFIG_SECTION}.fixTargets`, fixTargets),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.openLogs`, openLogsFolder),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.testProxy`, runTestProxy),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.focusSidebar`, () => vscode.commands.executeCommand("workbench.view.extension.antigravityProxy")),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.openLogsWindow`, openLogsWindow),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.checkGemini`, () => runGeminiCheck(false)),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.refreshIp`, () => ipInfo.get({ force: true })),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.checkUpdate`, () => updater.check({ manual: true })),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.applyUpdate`, () => updater.downloadAndInstall()),
    vscode.commands.registerCommand(`${CONFIG_SECTION}.switchLanguage`, pickLanguage),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${CONFIG_SECTION}.language`)) {
        t = I18n.createT(currentLang());
        ConfigPanel.relocalizeIfOpen();
        sidebar?.relocalize();
        logView?.relocalize();
        void refresh(true);
      }
      if (e.affectsConfiguration(CONFIG_SECTION)) {
        scheduleTimers();
        updater.stop();
        updater.start();
        void refresh(false);
      }
    }),
  );

  // ---- 定时任务：状态栏轻量探测 / 出口 IP / Gemini 检测 ----
  /** @type {NodeJS.Timeout | undefined} */
  let statusTimer;
  /** @type {NodeJS.Timeout | undefined} */
  let egressTimer;
  /** @type {NodeJS.Timeout | undefined} */
  let geminiTimer;
  const scheduleTimers = () => {
    if (statusTimer) clearInterval(statusTimer);
    if (egressTimer) clearInterval(egressTimer);
    if (geminiTimer) clearInterval(geminiTimer);
    const s = getSettings();
    // 状态栏端口探测：间隔可配置；0 表示仅启动与保存后检测（保持原有行为）
    statusTimer = s.statusProbeSeconds > 0 ? setInterval(() => void refresh(true), Math.max(10, s.statusProbeSeconds) * 1000) : undefined;
    // 出口 IP：免费额度有限，最小 60 秒；0 表示仅手动刷新
    egressTimer = s.egressIntervalSeconds > 0 ? setInterval(() => void ipInfo.get({ force: true }), Math.max(60, s.egressIntervalSeconds) * 1000) : undefined;
    // Gemini：默认 5 分钟，最小 60 秒；0 表示关闭定时检测（仍可手动）
    geminiTimer = s.geminiIntervalSeconds > 0 ? setInterval(() => void runGeminiCheck(), Math.max(60, s.geminiIntervalSeconds) * 1000) : undefined;
    for (const timer of [statusTimer, egressTimer, geminiTimer]) {
      if (timer && typeof timer.unref === "function") timer.unref();
    }
  };
  scheduleTimers();
  context.subscriptions.push({
    dispose: () => {
      if (statusTimer) clearInterval(statusTimer);
      if (egressTimer) clearInterval(egressTimer);
      if (geminiTimer) clearInterval(geminiTimer);
    },
  });

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

  // 出口 IP 与 Gemini 检测延后执行：避开启动高峰，且保证激活流程尽快返回
  const startupTimers = [
    setTimeout(() => void ipInfo.get(), 2500),
    setTimeout(() => void runGeminiCheck(), 4000),
  ];
  context.subscriptions.push({ dispose: () => { for (const timer of startupTimers) clearTimeout(timer); } });

  // 插件自更新：内部按设置延迟与间隔调度（默认 20s 后首次检查，之后每 6h）
  updater.start();
}

function deactivate() {}

module.exports = { activate, deactivate };
