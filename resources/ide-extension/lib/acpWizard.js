// @ts-check
"use strict";

/**
 * 外部编辑器 ACP 代理向导（Issue #164）——交互层：只负责弹窗、选择与写文件，检测/生成逻辑在 acpSupport.js。
 *
 * 一键流程（不需要终端）：
 *   1. 把插件内置的 agy-acp-proxy.exe 部署到 IDE 安装目录（与 version.dll / config.json 同级，共用代理配置）；
 *   2. 自动检测本机的 `agy acp`（IDE 内置 / 独立 CLI）与 ACP Registry 安装的 agy_acp_server.exe；
 *   3. 选择编辑器：JetBrains 自动合并写入 ~/.jetbrains/acp.json（先备份）；Zed / VS Code 复制配置片段。
 *
 * 启动检测（可在设置中关闭）：发现其它编辑器在用 Antigravity ACP、但没有经过包装器时，提示一次。
 */

const fs = require("fs");
const path = require("path");
const Acp = require("./acpSupport");

/** 用户曾部署过包装器：补丁守护据此在 IDE 更新后恢复它 */
const ACP_DEPLOYED_KEY = "antigravityProxy.acp.wrapperDeployed";
/** 启动提示“不再提示” */
const ACP_HINT_DISMISSED_KEY = "antigravityProxy.acp.hintDismissed";
/** 每个插件版本最多自动提示一次 */
const ACP_HINT_VERSION_KEY = "antigravityProxy.acp.hintShownForVersion";
const GUIDE_URL = "https://github.com/yuaotian/antigravity-proxy/blob/main/docs/acp.md";

/**
 * @typedef {Object} AcpWizardDeps
 * @property {typeof import("vscode")} vscode
 * @property {import("vscode").ExtensionContext} context
 * @property {import("./patchGuard").PatchGuard} guard
 * @property {(key: string, params?: Record<string, any>) => string} t
 * @property {(level: "debug" | "info" | "warn" | "error", text: string) => void} log
 */

/**
 * 读取文本文件，不存在返回 null。
 * @param {string} filePath
 */
function readTextOrNull(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * 检测本机所有可用的 ACP 服务端（agy 同步探测 + Registry 有界异步扫描）。
 * @returns {Promise<import("./acpSupport").AcpTarget[]>}
 */
async function detectTargets() {
  const agy = Acp.findAgyCandidates();
  const registry = await Acp.findRegistryServers({ roots: Acp.defaultRegistryRoots() });
  return [...agy, ...registry];
}

/**
 * @param {AcpWizardDeps} deps
 * @param {import("./acpSupport").AcpTarget} target
 */
function describeTarget(deps, target) {
  const { t } = deps;
  const label = target.source === "ide" ? t("acp.targetAgyIde")
    : target.source === "cli" ? t("acp.targetAgyCli")
      : target.source === "registry" ? t("acp.targetRegistry")
        : path.basename(target.path);
  const version = target.version ? t("acp.versionLabel", { version: target.version }) : "";
  return {
    label,
    description: version,
    detail: target.path,
  };
}

/**
 * 让用户选择要走代理的服务端（找不到时直接进入文件选择）。
 * @param {AcpWizardDeps} deps
 * @returns {Promise<import("./acpSupport").AcpTarget | undefined>}
 */
async function pickTarget(deps) {
  const { vscode, t } = deps;
  const targets = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t("acp.detecting") },
    () => detectTargets(),
  );
  deps.log("info", `ACP 检测完成：找到 ${targets.length} 个服务端`);

  const browse = async () => {
    const picked = await vscode.window.showOpenDialog({
      title: t("acp.browseTitle"),
      canSelectMany: false,
      filters: { exe: ["exe"] },
    });
    if (!picked || picked.length === 0) return undefined;
    const exePath = picked[0].fsPath;
    /** @type {import("./acpSupport").AcpTarget} */
    const custom = { kind: /^agy(\.exe)?$/i.test(path.basename(exePath)) ? "agy" : "custom", path: exePath, source: "custom" };
    return custom;
  };

  if (targets.length === 0) {
    void vscode.window.showInformationMessage(t("acp.noTargetFound"));
    return browse();
  }

  const items = targets.map((target) => ({ ...describeTarget(deps, target), target }));
  const browseItem = { label: `$(folder-opened) ${t("acp.targetBrowse")}`, description: "", detail: t("acp.needsAcp"), target: undefined };
  const picked = await vscode.window.showQuickPick([...items, browseItem], {
    title: t("acp.pickTarget"),
    placeHolder: t("acp.pickTarget"),
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  if (!picked) return undefined;
  return picked.target || browse();
}

/**
 * 按所选编辑器写入或复制配置。
 * @param {AcpWizardDeps} deps
 * @param {{ command: string, args: string[] }} cmd
 */
async function applyToClient(deps, cmd) {
  const { vscode, t } = deps;
  const snippets = Acp.buildClientSnippets(cmd);
  const choices = [
    { id: "jetbrains", label: `$(gear) ${t("acp.clientJetBrains")}` },
    { id: "zed", label: `$(copy) ${t("acp.clientZed")}` },
    { id: "vscode", label: `$(copy) ${t("acp.clientVsCode")}` },
    { id: "command", label: `$(terminal) ${t("acp.clientCommand")}` },
  ];
  const picked = await vscode.window.showQuickPick(choices, {
    title: t("acp.pickClient"),
    placeHolder: t("acp.pickClient"),
    ignoreFocusOut: true,
  });
  if (!picked) return;

  const copy = (/** @type {unknown} */ value) =>
    vscode.env.clipboard.writeText(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  /** @type {string} */
  let message;

  if (picked.id === "jetbrains") {
    const acpPath = Acp.jetBrainsAcpJsonPath();
    const existing = readTextOrNull(acpPath);
    const merged = Acp.mergeJetBrainsAcpJson(existing, cmd);
    if (merged.ok) {
      try {
        fs.mkdirSync(path.dirname(acpPath), { recursive: true });
        // 改写前备份原文件（同目录，带时间戳），用户可随时手动还原
        if (existing !== null) fs.copyFileSync(acpPath, `${acpPath}.agp-bak-${Date.now()}`);
        const tmp = `${acpPath}.agp-${process.pid}-${Date.now()}.tmp`;
        fs.writeFileSync(tmp, merged.text, "utf8");
        fs.renameSync(tmp, acpPath);
        deps.log("info", `ACP：已写入 JetBrains 配置 ${acpPath}`);
        message = t("acp.jetbrainsDone", { path: acpPath, name: Acp.ACP_AGENT_NAME });
      } catch (e) {
        void vscode.window.showErrorMessage(t("acp.writeFailed", { error: /** @type {Error} */ (e).message || String(e) }));
        return;
      }
    } else {
      // 含注释或结构异常：不冒险改写，降级为复制片段 + 打开文件
      await copy(snippets.jetbrains);
      if (existing !== null) await openFile(vscode, acpPath);
      message = t("acp.jetbrainsManual", { path: acpPath });
    }
  } else if (picked.id === "zed") {
    await copy(snippets.zed);
    const zedPath = Acp.zedSettingsPath();
    if (fs.existsSync(zedPath)) await openFile(vscode, zedPath);
    message = t("acp.zedDone", { name: Acp.ACP_AGENT_NAME });
  } else if (picked.id === "vscode") {
    await copy(snippets.vscode);
    message = t("acp.vscodeDone");
  } else {
    await copy(snippets.commandLine);
    message = t("acp.commandDone");
  }

  const action = await vscode.window.showInformationMessage(message, t("acp.openGuide"));
  if (action) await vscode.env.openExternal(vscode.Uri.parse(GUIDE_URL));
}

/** @param {typeof import("vscode")} vscode @param {string} filePath */
async function openFile(vscode, filePath) {
  try {
    await vscode.window.showTextDocument(vscode.Uri.file(filePath), { preview: false });
  } catch { /* 打开失败不影响已复制到剪贴板的配置 */ }
}

/**
 * 向导入口（命令 / 侧栏按钮 / 启动提示共用）。
 * @param {AcpWizardDeps} deps
 */
async function runAcpSetup(deps) {
  const { vscode, guard, t, context } = deps;

  // 包装器与 IDE 共用 version.dll / config.json：补丁缺失时先引导修复，避免生成指向“无代理 DLL”的配置
  if (!guard.check().dllExists) {
    void vscode.window.showWarningMessage(t("acp.patchMissing"));
    return;
  }
  const deployed = guard.deployAcpWrapper();
  if (!deployed.ok) {
    void vscode.window.showErrorMessage(t("acp.deployFailed", { error: deployed.error }));
    return;
  }
  await context.globalState.update(ACP_DEPLOYED_KEY, true);
  deps.log("info", deployed.changed ? `ACP：已部署包装器 ${deployed.path}` : `ACP：包装器已是最新 ${deployed.path}`);

  const target = await pickTarget(deps);
  if (!target) return;
  await applyToClient(deps, Acp.buildAgentCommand(deployed.path, target));
}

/**
 * 启动后台检测：其它编辑器在用 Antigravity ACP 但未经包装器时提示一次（每个插件版本最多一次）。
 * @param {AcpWizardDeps & { version: string, enabled: () => boolean }} deps
 */
async function maybeHintAcp(deps) {
  const { vscode, context, t } = deps;
  if (!deps.enabled()) return;
  if (context.globalState.get(ACP_HINT_DISMISSED_KEY)) return;
  if (context.globalState.get(ACP_HINT_VERSION_KEY) === deps.version) return;

  const jetbrains = Acp.analyzeAgentServers(readTextOrNull(Acp.jetBrainsAcpJsonPath()));
  const zed = Acp.analyzeAgentServers(readTextOrNull(Acp.zedSettingsPath()));
  // 已有经包装器的条目：说明用户配置过，不再打扰
  if (jetbrains.proxied || zed.proxied) return;
  const registry = await Acp.findRegistryServers({ roots: Acp.defaultRegistryRoots(), maxDirs: 3000 });

  /** @type {string[]} */
  const where = [];
  if (registry.length > 0) where.push(t("acp.whereRegistry"));
  if (jetbrains.unwrapped) where.push("JetBrains");
  if (zed.unwrapped) where.push("Zed");
  if (where.length === 0) return;

  await context.globalState.update(ACP_HINT_VERSION_KEY, deps.version);
  deps.log("info", `ACP：检测到未走代理的外部编辑器 Agent（${where.join(", ")}）`);
  const pick = await vscode.window.showInformationMessage(
    t("acp.hint", { where: where.join(t("common.listSep")) }),
    t("acp.hintSetup"),
    t("acp.hintNever"),
  );
  if (pick === t("acp.hintSetup")) await runAcpSetup(deps);
  else if (pick === t("acp.hintNever")) await context.globalState.update(ACP_HINT_DISMISSED_KEY, true);
}

module.exports = { runAcpSetup, maybeHintAcp, ACP_DEPLOYED_KEY };
