// @ts-check
"use strict";

/**
 * 左侧活动栏视图（WebviewView 宿主侧：负责 HTML/CSP、状态模型下发与消息路由；不做 IO）。
 *
 * 为什么从 TreeView 改为 WebviewView：
 * - 需求要的实时日志、级别筛选、关键字搜索、IP/运营商卡片、Gemini 置信度都不是 TreeView 能表达的；
 * - WebviewView 仍是 IDE 原生视图：view/title 菜单、拖动、快捷键与主题变量都保持不变。
 *
 * 消息协议（webview → host）：
 *   ready | action{action} | copy{text}
 * 消息协议（host → webview）：
 *   init{lang, model, logs, settings} | model{model} | lang{lang}
 *   logsAppend{lines} | logsReset{snapshot} | toast{kind, text}
 */

const { renderWebviewHtml } = require("./webviewHtml");

class ProxySidebarProvider {
  /**
   * @param {{
   *   vscode: typeof import("vscode"),
   *   extensionUri: import("vscode").Uri,
   *   logService: import("./logService").LogService,
   *   t: (key: string, params?: Record<string, any>) => string,
   *   lang: () => string,
   *   version: string,
   *   getSettings: () => Record<string, any>,
   *   actions: Record<string, () => any>,
   * }} deps
   */
  constructor(deps) {
    this.deps = deps;
    this.vscode = deps.vscode;
    /** @type {any} */
    this.model = null;
    /** @type {import("vscode").WebviewView | null} */
    this.view = null;
    this.unsubscribeLogs = deps.logService.subscribe((event) => {
      if (!this.view) return;
      if (event.type === "append") this.post({ type: "logsAppend", lines: event.lines });
      else if (event.type === "file") this.post({ type: "logsFile", file: event.file });
      else this.post({ type: "logsReset", snapshot: event.snapshot });
    });
  }

  /**
   * @param {import("vscode").WebviewView} webviewView
   */
  resolveWebviewView(webviewView) {
    const { vscode, extensionUri } = this.deps;
    this.view = webviewView;
    const mediaUri = vscode.Uri.joinPath(extensionUri, "media");
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaUri],
    };
    webviewView.webview.html = renderWebviewHtml({
      vscode,
      webview: webviewView.webview,
      mediaUri,
      title: this.deps.t("side.title"),
      lang: this.deps.lang(),
      data: {
        icon: webviewView.webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, "icon.png")).toString(),
        version: this.deps.version,
      },
      styles: ["codicons/codicon.css", "sidebar.css"],
      scripts: ["i18n.js", "sidebar.js"],
      bodyClass: "sidebar-body",
    });
    const sub = webviewView.webview.onDidReceiveMessage((msg) => void this.onMessage(msg));
    webviewView.onDidDispose(() => {
      sub.dispose();
      this.view = null;
    });
  }

  /**
   * 更新状态模型：视图存在时即时下发，否则等下次 resolve 的 init 回放。
   * @param {any} model
   */
  render(model) {
    this.model = model;
    this.post({ type: "model", model });
  }

  /** 语言切换：前端按 data-lang/消息重建文案（探测结果由宿主重新探测后随 model 下发） */
  relocalize() {
    this.post({ type: "lang", lang: this.deps.lang() });
  }

  postInit() {
    this.post({
      type: "init",
      lang: this.deps.lang(),
      model: this.model,
      logs: this.deps.logService.snapshot(),
      settings: this.deps.getSettings(),
    });
  }

  /** @param {any} msg */
  post(msg) {
    if (!this.view) return;
    void this.view.webview.postMessage(msg);
  }

  /** @param {"info" | "warn" | "error"} kind @param {string} text */
  toast(kind, text) {
    this.post({ type: "toast", kind, text });
  }

  /** @param {any} msg */
  async onMessage(msg) {
    const type = String(msg?.type || "");
    if (type === "ready") {
      this.postInit();
      return;
    }
    if (type === "copy") {
      await this.vscode.env.clipboard.writeText(String(msg.text ?? ""));
      this.toast("info", this.deps.t("host.copied"));
      return;
    }
    if (type === "action") {
      const name = String(msg.action || "");
      const fn = this.deps.actions[name];
      if (!fn) return;
      try {
        await fn();
      } catch (e) {
        this.toast("error", /** @type {Error} */ (e).message || String(e));
      }
    }
  }

  dispose() {
    this.unsubscribeLogs();
    this.view = null;
  }
}

module.exports = { ProxySidebarProvider };
