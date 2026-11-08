// @ts-check
"use strict";

/**
 * 配置面板（Webview）宿主侧：负责面板生命周期与消息路由。
 * UI 渲染全部在 media/panel.js；文件读写委托 ConfigStore；网络探测委托 proxyProbe；本机代理扫描委托 deps.scan。
 *
 * 消息协议（webview → host）：
 *   ready | reload | save{raw} | probe{proxy} | scan{proxy} | restart | repair | createDefault
 *   openConfigFile | openLogs | import | export{raw} | copy{text}
 * 消息协议（host → webview）：
 *   init{lang, read, meta, intent?} | lang{lang} | meta{meta} | saved{ok, error?} | probeResult{result}
 *   scanResult{result} | imported{raw} | toast{kind, text}
 * intent：onboarding（首次引导：自动扫描 + 引导动画）| scan（命令触发：自动扫描）
 */

const fs = require("fs");
const crypto = require("crypto");
const Core = require("./core");
const { probeProxy } = require("./proxyProbe");

class ConfigPanel {
  /** @type {ConfigPanel | undefined} */
  static current;

  /**
   * @typedef {Object} PanelDeps
   * @property {typeof import("vscode")} vscode
   * @property {import("vscode").Uri} extensionUri
   * @property {import("./installInfo").InstallInfo} info
   * @property {import("./configStore").ConfigStore} store
   * @property {import("./patchGuard").PatchGuard} guard
   * @property {() => boolean} isPendingRestart
   * @property {() => void} onSaved            保存成功后的回调（刷新状态栏、标记待重启）
   * @property {() => Promise<void>} restart
   * @property {() => Promise<void>} repair
   * @property {(current: any) => Promise<import("./proxyScan").ScanResult>} scan 本机代理扫描
   * @property {(key: string, params?: Record<string, any>) => string} t 翻译函数
   * @property {() => string} lang             当前界面语言（zh-cn / en / ru）
   * @property {() => string} languagePref     语言偏好（auto / zh-cn / en / ru）
   * @property {(lang: string) => Promise<void>} setLanguage 切换界面语言
   */

  /**
   * @param {PanelDeps} deps
   * @param {{ intent?: "onboarding" | "scan" }} [opts]
   */
  static show(deps, opts = {}) {
    if (ConfigPanel.current) {
      ConfigPanel.current.panel.reveal();
      ConfigPanel.current.postInit(opts.intent);
      return;
    }
    ConfigPanel.current = new ConfigPanel(deps, opts.intent);
  }

  /** 状态变化（保存/修复/外部修改）后通知已打开的面板刷新状态带 */
  static refreshIfOpen() {
    ConfigPanel.current?.postMeta();
  }

  /** 界面语言变化：更新标题并让 Webview 按新语言重绘（保留未保存的编辑） */
  static relocalizeIfOpen() {
    const p = ConfigPanel.current;
    if (!p) return;
    p.panel.title = p.deps.t("host.panelTitle");
    p.post({ type: "lang", lang: p.deps.lang(), languagePref: p.deps.languagePref() });
  }

  /** @param {PanelDeps} deps @param {"onboarding" | "scan" | undefined} intent */
  constructor(deps, intent) {
    this.deps = deps;
    // Webview 加载完成（ready）后随首个 init 下发一次，避免脚本尚未就绪时消息丢失
    this.pendingIntent = intent;
    const { vscode, extensionUri } = deps;
    const mediaUri = vscode.Uri.joinPath(extensionUri, "media");
    this.panel = vscode.window.createWebviewPanel("antigravityProxy.settings", deps.t("host.panelTitle"), vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [mediaUri],
    });
    this.panel.iconPath = vscode.Uri.joinPath(mediaUri, "icon.png");
    this.panel.webview.html = this.renderHtml(this.panel.webview, mediaUri);
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
    this.panel.onDidDispose(() => {
      ConfigPanel.current = undefined;
    });
  }

  /** @param {any} msg */
  post(msg) {
    void this.panel.webview.postMessage(msg);
  }

  meta() {
    const { info, guard, isPendingRestart } = this.deps;
    return {
      installDir: info.installDir,
      configPath: info.configPath,
      patch: guard.check(),
      pendingRestart: isPendingRestart(),
    };
  }

  /** @param {"onboarding" | "scan"} [intent] */
  postInit(intent) {
    const read = this.deps.store.read();
    this.post({ type: "init", lang: this.deps.lang(), languagePref: this.deps.languagePref(), intent, read: { status: read.status, raw: read.raw, error: read.error }, meta: this.meta() });
  }

  postMeta() {
    this.post({ type: "meta", meta: this.meta() });
  }

  /** @param {any} msg */
  async onMessage(msg) {
    const { vscode, info, store, t } = this.deps;
    try {
      switch (msg?.type) {
        case "ready":
        case "reload": {
          const intent = this.pendingIntent;
          this.pendingIntent = undefined;
          this.postInit(intent);
          break;
        }
        case "save": {
          // 宿主侧二次校验：Webview 被篡改或版本不一致时也不会写出非法配置
          const { errors } = Core.validateForm(Core.normalizeForm(msg.raw), this.deps.lang());
          const count = Object.keys(errors).length;
          if (count > 0) {
            this.post({ type: "saved", ok: false, error: t("host.saveHasErrors", { count }) });
            break;
          }
          const r = store.write(msg.raw);
          if (r.ok) {
            this.deps.onSaved();
            this.post({ type: "saved", ok: true, meta: this.meta() });
          } else {
            this.post({ type: "saved", ok: false, error: r.error });
          }
          break;
        }
        case "setLanguage": {
          await this.deps.setLanguage(String(msg.lang || "auto"));
          this.post({ type: "lang", lang: this.deps.lang(), languagePref: this.deps.languagePref() });
          break;
        }
        case "probe": {
          const result = await probeProxy(msg.proxy, { timeoutMs: 6000, t });
          this.post({ type: "probeResult", result });
          break;
        }
        case "scan": {
          const result = await this.deps.scan(msg.proxy);
          this.post({ type: "scanResult", result });
          break;
        }
        case "restart":
          await this.deps.restart();
          break;
        case "repair":
          await this.deps.repair();
          this.postInit();
          break;
        case "createDefault": {
          // 优先使用插件随附的发布版默认配置（版本号与 DLL 一致），缺失时退回共享核心默认值
          let raw;
          try {
            raw = Core.parseJsonc(fs.readFileSync(this.deps.guard.payloadConfig, "utf8"));
          } catch {
            raw = Core.exportObject(Core.defaultForm(), {});
          }
          const r = store.write(raw);
          if (!r.ok) this.post({ type: "toast", kind: "error", text: r.error });
          else this.deps.onSaved();
          this.postInit();
          break;
        }
        case "openConfigFile":
          if (fs.existsSync(info.configPath)) {
            await vscode.window.showTextDocument(vscode.Uri.file(info.configPath), { preview: false });
          } else {
            this.post({ type: "toast", kind: "warn", text: t("host.configNotExist") });
          }
          break;
        case "openLogs":
          if (fs.existsSync(info.logsDir)) await vscode.env.openExternal(vscode.Uri.file(info.logsDir));
          else this.post({ type: "toast", kind: "warn", text: t("ext.logsNotFound", { path: info.logsDir }) });
          break;
        case "import": {
          const picked = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { [t("host.jsonFilter")]: ["json", "jsonc"] },
            title: t("host.importTitle"),
          });
          if (!picked || !picked[0]) break;
          const raw = Core.parseJsonc(fs.readFileSync(picked[0].fsPath, "utf8"));
          this.post({ type: "imported", raw });
          break;
        }
        case "export": {
          const target = await vscode.window.showSaveDialog({
            filters: { [t("host.jsonFilter")]: ["json"] },
            defaultUri: vscode.Uri.file("config.json"),
            title: t("host.exportTitle"),
          });
          if (!target) break;
          fs.writeFileSync(target.fsPath, JSON.stringify(msg.raw, null, 2) + "\n", "utf8");
          this.post({ type: "toast", kind: "info", text: t("host.exported", { path: target.fsPath }) });
          break;
        }
        case "copy":
          await vscode.env.clipboard.writeText(String(msg.text ?? ""));
          this.post({ type: "toast", kind: "info", text: t("host.copied") });
          break;
        default:
          break;
      }
    } catch (e) {
      this.post({ type: "toast", kind: "error", text: /** @type {Error} */ (e).message || String(e) });
    }
  }

  /**
   * @param {import("vscode").Webview} webview
   * @param {import("vscode").Uri} mediaUri
   */
  renderHtml(webview, mediaUri) {
    const { vscode, t } = this.deps;
    const lang = this.deps.lang();
    const htmlLang = { "zh-cn": "zh-CN", en: "en", ru: "ru" }[lang] || "en";
    const nonce = crypto.randomBytes(16).toString("base64");
    const uri = (/** @type {string[]} */ ...p) => webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, ...p)).toString();
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    // data-lang：首帧（骨架屏）即使用正确语言，无需等待 init 消息
    return `<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${uri("codicons", "codicon.css")}" />
  <link rel="stylesheet" href="${uri("panel.css")}" />
  <title>${t("host.panelTitle")}</title>
</head>
<body>
  <div id="app" class="app" data-phase="loading" data-lang="${lang}" data-icon="${uri("icon.png")}"></div>
  <script nonce="${nonce}" src="${uri("i18n.js")}"></script>
  <script nonce="${nonce}" src="${uri("config-core.js")}"></script>
  <script nonce="${nonce}" src="${uri("panel.js")}"></script>
</body>
</html>`;
  }
}

module.exports = { ConfigPanel };
