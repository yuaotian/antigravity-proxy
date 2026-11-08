// @ts-check
"use strict";

/**
 * 实时日志窗口：底部面板 WebviewView（主入口）+ 编辑器标签页 WebviewPanel（兜底）。
 *
 * 为什么两个入口：
 * - 底部面板与 Terminal/Output 并列，符合"看日志"的直觉；
 * - 万一某些 IDE 版本没有注册 workbench.view.extension.<containerId> 命令，兜底打开编辑器标签页，
 *   保证用户永远能看到日志（两条路径复用同一份 media/logview.js + 同一套消息协议）。
 *
 * 消息协议（webview → host）：ready | openFile | openDir | copy{text}
 * 消息协议（host → webview）：init{lang, snapshot} | append{lines} | reset{snapshot} | lang{lang} | toast
 */

const path = require("path");
const { renderWebviewHtml } = require("./webviewHtml");

const VIEW_ID = "antigravityProxy.logs";
const CONTAINER_ID = "antigravityProxyLogs";

/**
 * @typedef {{
 *   vscode: typeof import("vscode"),
 *   extensionUri: import("vscode").Uri,
 *   logService: import("./logService").LogService,
 *   t: (key: string, params?: Record<string, any>) => string,
 *   lang: () => string,
 *   getEnv: () => ({ proxy: any, egress: any, gemini: any }),
 * }} LogDeps
 */

/**
 * 生成日志窗口 HTML（两个入口共用）。
 * @param {LogDeps} deps
 * @param {import("vscode").Webview} webview
 */
function buildHtml(deps, webview) {
  const mediaUri = deps.vscode.Uri.joinPath(deps.extensionUri, "media");
  return renderWebviewHtml({
    vscode: deps.vscode,
    webview,
    mediaUri,
    title: deps.t("logs.windowTitle"),
    lang: deps.lang(),
    styles: ["codicons/codicon.css", "logview.css"],
    scripts: ["i18n.js", "logview.js"],
    bodyClass: "logview-body",
  });
}

/** 顶部环境条需要的代理/出口 IP/Gemini 摘要（需求 3/4 的"底部面板"信息区） */
function envSnapshot(deps) {
  try {
    return deps.getEnv();
  } catch {
    return { proxy: null, egress: null, gemini: null };
  }
}

/**
 * 两个入口共享的消息处理。
 * @param {LogDeps} deps
 * @param {any} msg
 * @param {(msg: any) => void} post
 */
async function handleMessage(deps, msg, post) {
  const { vscode, logService, t } = deps;
  switch (String(msg?.type || "")) {
    case "ready":
      post({ type: "init", lang: deps.lang(), snapshot: logService.snapshot(), env: envSnapshot(deps) });
      break;
    case "openFile": {
      const file = logService.snapshot().file;
      if (file && require("fs").existsSync(file)) {
        await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
      } else {
        post({ type: "toast", kind: "warn", text: t("logs.noFile") });
      }
      break;
    }
    case "openDir": {
      const file = logService.snapshot().file;
      const dir = file ? path.dirname(file) : "";
      if (dir && require("fs").existsSync(dir)) await vscode.env.openExternal(vscode.Uri.file(dir));
      else post({ type: "toast", kind: "warn", text: t("ext.logsNotFound", { path: dir }) });
      break;
    }
    case "copy":
      await vscode.env.clipboard.writeText(String(msg.text ?? ""));
      post({ type: "toast", kind: "info", text: t("host.copied") });
      break;
    default:
      break;
  }
}

class LogViewProvider {
  /** @param {LogDeps} deps */
  constructor(deps) {
    this.deps = deps;
    /** @type {import("vscode").WebviewView | null} */
    this.view = null;
    this.unsubscribe = deps.logService.subscribe((event) => {
      if (!this.view) return;
      if (event.type === "append") void this.view.webview.postMessage({ type: "append", lines: event.lines });
      else if (event.type === "file") void this.view.webview.postMessage({ type: "file", file: event.file });
      else void this.view.webview.postMessage({ type: "reset", snapshot: event.snapshot });
    });
  }

  /** @param {import("vscode").WebviewView} webviewView */
  resolveWebviewView(webviewView) {
    const { vscode, extensionUri } = this.deps;
    this.view = webviewView;
    const mediaUri = vscode.Uri.joinPath(extensionUri, "media");
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [mediaUri] };
    webviewView.webview.html = buildHtml(this.deps, webviewView.webview);
    const sub = webviewView.webview.onDidReceiveMessage((msg) => void handleMessage(this.deps, msg, (m) => {
      void webviewView.webview.postMessage(m);
    }));
    webviewView.onDidDispose(() => {
      sub.dispose();
      this.view = null;
    });
  }

  /** 语言切换：前端用收到的 lang 重建文案；日志内容本身不翻译 */
  relocalize() {
    void this.view?.webview.postMessage({ type: "lang", lang: this.deps.lang() });
  }

  /** 状态变化：把代理/出口 IP/Gemini 摘要推给底部面板的日志窗口（编辑器兜底面板也同步） */
  updateEnv() {
    const env = envSnapshot(this.deps);
    void this.view?.webview.postMessage({ type: "env", env });
    LogPanel.updateEnv();
  }

  /** 尽量切到面板容器；命令不可用时退回编辑器标签页 */
  async reveal() {
    try {
      await this.deps.vscode.commands.executeCommand(`workbench.view.extension.${CONTAINER_ID}`);
    } catch {
      LogPanel.show(this.deps);
    }
  }

  dispose() {
    this.unsubscribe();
    this.view = null;
  }
}

class LogPanel {
  /** @type {LogPanel | undefined} */
  static current;

  /** 环境条更新（编辑器兜底面板） */
  static updateEnv() {
    const current = LogPanel.current;
    if (!current) return;
    void current.panel.webview.postMessage({ type: "env", env: envSnapshot(current.deps) });
  }

  /** @param {LogDeps} deps */
  static show(deps) {
    if (LogPanel.current) {
      LogPanel.current.panel.reveal();
      return;
    }
    LogPanel.current = new LogPanel(deps);
  }

  /** @param {LogDeps} deps */
  constructor(deps) {
    this.deps = deps;
    const { vscode, extensionUri } = deps;
    const mediaUri = vscode.Uri.joinPath(extensionUri, "media");
    this.panel = vscode.window.createWebviewPanel("antigravityProxy.logpanel", deps.t("logs.windowTitle"), vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [mediaUri],
    });
    this.panel.iconPath = vscode.Uri.joinPath(mediaUri, "icon.png");
    this.panel.webview.html = buildHtml(deps, this.panel.webview);
    this.panel.webview.onDidReceiveMessage((msg) => void handleMessage(deps, msg, (m) => {
      void this.panel.webview.postMessage(m);
    }));
    this.unsubscribe = deps.logService.subscribe((event) => {
      if (event.type === "append") void this.panel.webview.postMessage({ type: "append", lines: event.lines });
      else if (event.type === "file") void this.panel.webview.postMessage({ type: "file", file: event.file });
      else void this.panel.webview.postMessage({ type: "reset", snapshot: event.snapshot });
    });
    this.panel.onDidDispose(() => {
      this.unsubscribe();
      LogPanel.current = undefined;
    });
  }
}

module.exports = { LogViewProvider, LogPanel, VIEW_ID, CONTAINER_ID };
