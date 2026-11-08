// @ts-check
"use strict";

/**
 * IDE 插件自更新（单一职责：检查 → 下载 → 校验 → 安装 → 提示重载）。
 *
 * 关键约束（都有代码/文档依据）：
 * - 检查顺序：本地代理 → GitHub 镜像 → 直连（与 scripts/install-online.ps1:287-301 一致）；
 * - 镜像必须能转发 api.github.com（install-online.ps1:73 与本次实测的 https://gh-proxy.com/）；
 * - 只安装本仓库 Release 里带 -ide-extension-win-<arch>.vsix 的资产（scripts/package-release.ps1:77,105）；
 * - 下载后必须与 SHA256SUMS.txt 匹配；拿不到清单或哈希不符一律不安装；
 * - 安装优先用官方内置命令 workbench.extensions.installExtension（VS Code 文档「Built-in Commands」），
 *   失败再回退 IDE 自带 CLI（与 src/ide/IdeExtensionPrompt.cpp:455-462 同源）；
 * - 运行中安装不会自动切换版本，必须提示用户重载窗口（microsoft/vscode#345106）。
 *
 * 安全边界：不下载非 https、不执行脚本、不替换安装目录里的 version.dll、不上传任何本地数据。
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { request, downloadToFile, describeNetworkError } = require("./httpClient");
const R = require("./githubRelease");
const { sanitizeEnv } = require("./restart");

const CONFIG_SECTION = "antigravityProxy";
/** 默认镜像：gh-proxy.com 实测可转发 api.github.com（2026-11-08 返回 v2.6 JSON）；wget.la 见 install-online.ps1:73 */
const DEFAULT_MIRRORS = Object.freeze(["https://gh-proxy.com/", "https://wget.la/"]);
const NOTIFIED_KEY = "antigravityProxy.update.notifiedTag";
const LAST_CHECK_KEY = "antigravityProxy.update.lastCheckAt";
const CHECK_TIMEOUT_MS = 10000;
const DOWNLOAD_TIMEOUT_MS = 60000;
const CLI_TIMEOUT_MS = 180000;

/**
 * @typedef {Object} UpdateState
 * @property {"idle" | "checking" | "uptodate" | "available" | "downloading" | "installing" | "installed" | "error" | "disabled"} status
 * @property {string} currentVersion
 * @property {string} latestTag
 * @property {string} latestName
 * @property {string} notes
 * @property {string} htmlUrl
 * @property {{ name: string, size: number, url: string } | null} asset
 * @property {string} source 成功获取 Release 的源（日志/UI 用）
 * @property {string} error
 * @property {number} checkedAt
 * @property {string} installedTag
 */

class ExtensionUpdater {
  /**
   * @param {{
   *   vscode: typeof import("vscode"),
   *   context: import("vscode").ExtensionContext,
   *   info: import("./installInfo").InstallInfo,
   *   t: (key: string, params?: Record<string, any>) => string,
   *   log: (level: "debug" | "info" | "warn" | "error", text: string) => void,
   *   getProxy: () => ({ host: string, port: number, type?: string, username?: string, password?: string } | null),
   * }} deps
   */
  constructor(deps) {
    this.vscode = deps.vscode;
    this.context = deps.context;
    this.info = deps.info;
    this.t = deps.t;
    this.log = deps.log;
    this.getProxy = deps.getProxy;
    /** @type {UpdateState} */
    this.state = {
      status: "idle",
      currentVersion: String(deps.context.extension?.packageJSON?.version || "0.0.0"),
      latestTag: "",
      latestName: "",
      notes: "",
      htmlUrl: R.RELEASE_PAGE,
      asset: null,
      source: "",
      error: "",
      checkedAt: 0,
      installedTag: "",
    };
    /** @type {Set<(state: UpdateState) => void>} */
    this.listeners = new Set();
    /** @type {NodeJS.Timeout | undefined} */
    this.startTimer = undefined;
    /** @type {NodeJS.Timeout | undefined} */
    this.intervalTimer = undefined;
    this.busy = false;
  }

  /**
   * 订阅状态变化；返回 Disposable（与 VS Code 订阅容器兼容）。
   * @param {(state: UpdateState) => void} cb
   */
  onDidChange(cb) {
    this.listeners.add(cb);
    return { dispose: () => { this.listeners.delete(cb); } };
  }

  getState() {
    return this.state;
  }

  /** @param {Partial<UpdateState>} patch */
  setState(patch) {
    this.state = { ...this.state, ...patch };
    for (const cb of this.listeners) {
      try { cb(this.state); } catch { /* 单个订阅者异常不影响其它订阅者 */ }
    }
  }

  /** 读取设置（每次读取，保证修改设置后无需重启） */
  settings() {
    const cfg = this.vscode.workspace.getConfiguration(CONFIG_SECTION);
    const mirrors = cfg.get("update.mirrors");
    return {
      enabled: cfg.get("update.enabled", true) !== false,
      mode: String(cfg.get("update.mode", "notify")) === "auto" ? "auto" : "notify",
      intervalHours: Math.max(1, Number(cfg.get("update.intervalHours", 6)) || 6),
      delaySeconds: Math.max(0, Number(cfg.get("update.delaySeconds", 20)) || 0),
      mirrors: Array.isArray(mirrors) && mirrors.length > 0 ? mirrors.map(String) : [...DEFAULT_MIRRORS],
    };
  }

  /** 开发版（仓库内 0.0.0）不检查，避免每次启动都提示"有新版本" */
  isDevVersion() {
    return /^0\.0\.0(?:-|$)/.test(this.state.currentVersion);
  }

  start() {
    this.stop();
    const s = this.settings();
    if (!s.enabled || this.isDevVersion()) {
      this.setState({ status: s.enabled ? "idle" : "disabled" });
      return;
    }
    const last = Number(this.context.globalState.get(LAST_CHECK_KEY, 0)) || 0;
    const due = Date.now() - last >= s.intervalHours * 3600 * 1000;
    this.startTimer = setTimeout(() => {
      if (due) void this.check({ manual: false });
      else this.log("debug", this.t("upd.skipRecent"));
    }, s.delaySeconds * 1000);
    this.intervalTimer = setInterval(() => void this.check({ manual: false }), s.intervalHours * 3600 * 1000);
    if (typeof this.startTimer.unref === "function") this.startTimer.unref();
    if (typeof this.intervalTimer.unref === "function") this.intervalTimer.unref();
  }

  stop() {
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.startTimer = undefined;
    this.intervalTimer = undefined;
  }

  dispose() {
    this.stop();
    this.listeners.clear();
  }

  /**
   * 检查最新 Release。
   * @param {{ manual?: boolean }} [opts]
   */
  async check(opts = {}) {
    const manual = !!opts.manual;
    if (this.busy) return this.state;
    const s = this.settings();
    if (!s.enabled && !manual) {
      this.setState({ status: "disabled" });
      return this.state;
    }
    if (this.isDevVersion()) {
      this.setState({ status: "idle", error: this.t("upd.devSkip") });
      return this.state;
    }

    this.busy = true;
    this.setState({ status: "checking", error: "" });
    this.log("info", this.t("upd.checkingLog"));
    /** @type {string} */
    let source = "";
    /** @type {string} */
    let lastError = "";
    const proxy = this.getProxy();
    const sources = R.buildSourceCandidates(R.API_URL, { proxy, mirrors: s.mirrors });

    try {
      for (const candidate of sources) {
        try {
          const res = await request(candidate.url, {
            proxy: candidate.kind === "proxy" ? proxy : null,
            timeoutMs: CHECK_TIMEOUT_MS,
            headers: { accept: "application/vnd.github+json" },
          });
          if (res.status !== 200) {
            lastError = this.t("upd.httpStatus", { source: candidate.label, status: res.status });
            continue;
          }
          const release = R.parseRelease(JSON.parse(res.body.toString("utf8")));
          if (!release) {
            lastError = this.t("upd.badJson", { source: candidate.label });
            continue;
          }
          source = candidate.kind === "proxy" ? "proxy" : candidate.kind === "mirror" ? candidate.label : "direct";
          this.context.globalState.update(LAST_CHECK_KEY, Date.now());
          this.log("info", this.t("upd.sourceOk", { source }));
          // 关键：先释放"检查中"标记，否则 auto 模式下 applyRelease → downloadAndInstall 会被 busy 挡住
          this.busy = false;
          await this.applyRelease(release, source, manual);
          return this.state;
        } catch (e) {
          lastError = this.t("upd.sourceFailed", { source: candidate.label, error: describeNetworkError(e, this.t) });
          this.log("warn", lastError);
        }
      }
      this.setState({ status: "error", error: this.t("upd.checkFailed", { error: lastError }), checkedAt: Date.now() });
      if (manual) void this.vscode.window.showWarningMessage(this.t("upd.checkFailed", { error: lastError }));
      return this.state;
    } finally {
      this.busy = false;
    }
  }

  /**
   * 拿到 Release 后决定"有新版/已最新/提示或自动安装"。
   * @param {import("./githubRelease").ReleaseInfo} release
   * @param {string} source
   * @param {boolean} manual
   */
  async applyRelease(release, source, manual) {
    const current = this.state.currentVersion;
    const asset = R.pickVsixAsset(release.assets, process.arch);
    const base = {
      currentVersion: current,
      latestTag: release.tag,
      latestName: release.name,
      notes: release.body,
      htmlUrl: release.htmlUrl,
      asset,
      source,
      checkedAt: Date.now(),
      error: "",
    };
    if (!R.isNewer(current, release.version)) {
      this.setState({ ...base, status: "uptodate" });
      this.log("info", this.t("upd.uptodateLog", { current, latest: release.tag }));
      if (manual) void this.vscode.window.showInformationMessage(this.t("upd.uptodateLog", { current, latest: release.tag }));
      return;
    }
    this.setState({ ...base, status: "available" });
    this.log("info", this.t("upd.availableLog", { current, latest: release.tag, source }));

    if (!asset) {
      // 架构没有对应资产（例如 arm64）：只提示，不尝试安装
      this.setState({ status: "error", error: this.t("upd.noAsset", { arch: process.arch }) });
      void this.vscode.window.showWarningMessage(this.t("upd.noAsset", { arch: process.arch }), this.t("upd.openRelease"))
        .then((pick) => pick && this.vscode.env.openExternal(this.vscode.Uri.parse(release.htmlUrl)));
      return;
    }

    const s = this.settings();
    if (s.mode === "auto") {
      await this.downloadAndInstall();
      return;
    }
    if (manual) {
      void this.notifyAvailable();
      return;
    }
    const notified = String(this.context.globalState.get(NOTIFIED_KEY, ""));
    if (notified !== release.tag) {
      await this.context.globalState.update(NOTIFIED_KEY, release.tag);
      void this.notifyAvailable();
    }
  }

  async notifyAvailable() {
    const actions = [this.t("upd.applyNow"), this.t("upd.openRelease"), this.t("common.later")];
    const pick = await this.vscode.window.showInformationMessage(
      this.t("upd.notifyBody", { current: this.state.currentVersion, latest: this.state.latestTag }),
      ...actions,
    );
    if (pick === actions[0]) await this.downloadAndInstall();
    else if (pick === actions[1]) await this.vscode.env.openExternal(this.vscode.Uri.parse(this.state.htmlUrl));
  }

  /** 下载 + 校验 + 安装；任何一步失败都停在 error 状态，不触碰现有插件 */
  async downloadAndInstall() {
    if (this.busy) return this.state;
    const asset = this.state.asset;
    if (!asset) {
      this.setState({ status: "error", error: this.t("upd.noAsset", { arch: process.arch }) });
      return this.state;
    }
    this.busy = true;
    const s = this.settings();
    const proxy = this.getProxy();
    const release = { tag: this.state.latestTag, version: this.state.latestTag.replace(/^v/i, "") };
    const targetDir = path.join(this.context.globalStorageUri.fsPath, "updates", release.tag);
    const targetPath = path.join(targetDir, asset.name);

    try {
      await this.vscode.window.withProgress(
        { location: this.vscode.ProgressLocation.Notification, title: this.t("upd.progressTitle"), cancellable: false },
        async (progress) => {
          this.setState({ status: "downloading", error: "" });
          progress.report({ message: this.t("upd.checkingChecksum") });
          const sums = await this.fetchChecksums(s, proxy);
          const expected = sums ? sums.get(asset.name) : "";
          if (!expected) {
            const err = new Error(this.t("upd.checksumMissing"));
            err.code = "checksum";
            throw err;
          }

          const sources = R.buildSourceCandidates(asset.url, { proxy, mirrors: s.mirrors });
          /** @type {string} */
          let lastError = "";
          for (const candidate of sources) {
            try {
              progress.report({ message: this.t("upd.downloadingFrom", { source: candidate.label }) });
              this.log("info", this.t("upd.downloadingLog", { source: candidate.label, name: asset.name }));
              const result = await downloadToFile(candidate.url, targetPath, {
                proxy: candidate.kind === "proxy" ? proxy : null,
                timeoutMs: DOWNLOAD_TIMEOUT_MS,
                headers: { accept: "application/octet-stream" },
                onProgress: (bytes) => progress.report({ message: this.t("upd.downloadingBytes", { kb: Math.round(bytes / 1024) }) }),
              });
              if (result.sha256 !== expected) {
                try { fs.unlinkSync(targetPath); } catch { /* 忽略 */ }
                const err = new Error(this.t("upd.checksumMismatch"));
                err.code = "checksum";
                throw err;
              }
              this.setState({ status: "installing" });
              const ok = await this.install(targetPath);
              if (!ok) throw new Error(this.t("upd.installFailed"));
              this.setState({ status: "installed", installedTag: this.state.latestTag, error: "" });
              this.log("info", this.t("upd.installedLog", { tag: this.state.latestTag }));
              return;
            } catch (e) {
              lastError = this.t("upd.sourceFailed", { source: candidate.label, error: /** @type {Error} */ (e).message || String(e) });
              this.log("warn", lastError);
              // 校验失败说明内容被篡改/截断：换源也没有意义，直接中止（安全优先）
              if (/** @type {any} */ (e).code === "checksum") break;
            }
          }
          throw new Error(lastError || this.t("upd.installFailed"));
        },
      );
      await this.promptReload();
      return this.state;
    } catch (e) {
      const message = /** @type {Error} */ (e).message || String(e);
      this.setState({ status: "error", error: message });
      this.log("error", this.t("upd.failedLog", { error: message }));
      void this.vscode.window.showErrorMessage(this.t("upd.failed", { error: message }), this.t("upd.openRelease"))
        .then((pick) => pick && this.vscode.env.openExternal(this.vscode.Uri.parse(this.state.htmlUrl)));
      return this.state;
    } finally {
      this.busy = false;
    }
  }

  /**
   * 拉取 SHA256SUMS.txt（与资产同版本，源顺序同上）。
   * @param {{ mirrors: string[] }} s
   * @param {any} proxy
   * @returns {Promise<Map<string, string> | null>}
   */
  async fetchChecksums(s, proxy) {
    if (!this.state.asset) return null;
    const manifestUrl = new URL(this.state.asset.url);
    manifestUrl.pathname = manifestUrl.pathname.replace(/[^/]+$/, "SHA256SUMS.txt");
    const target = manifestUrl.toString();
    for (const candidate of R.buildSourceCandidates(target, { proxy, mirrors: s.mirrors })) {
      try {
        const res = await request(candidate.url, {
          proxy: candidate.kind === "proxy" ? proxy : null,
          timeoutMs: CHECK_TIMEOUT_MS,
          maxBytes: 64 * 1024,
        });
        if (res.status !== 200) continue;
        const map = R.parseSha256Sums(res.body.toString("utf8"));
        if (map.size > 0) return map;
      } catch { /* 换下一个源 */ }
    }
    return null;
  }

  /**
   * 安装 VSIX：官方命令优先，失败回退 IDE CLI。
   * @param {string} vsixPath
   * @returns {Promise<boolean>}
   */
  async install(vsixPath) {
    try {
      await this.vscode.commands.executeCommand("workbench.extensions.installExtension", this.vscode.Uri.file(vsixPath));
      this.log("info", this.t("upd.installViaCommand"));
      return true;
    } catch (e) {
      this.log("warn", this.t("upd.installCommandFailed", { error: /** @type {Error} */ (e).message || String(e) }));
      return this.installViaCli(vsixPath);
    }
  }

  /**
   * 回退：IDE 自带 CLI（DLL 的插件安装提示用的同一条路径）。
   * @param {string} vsixPath
   */
  installViaCli(vsixPath) {
    return new Promise((resolve) => {
      const cli = path.join(this.info.installDir, "bin", "antigravity-ide.cmd");
      if (!fs.existsSync(cli)) {
        this.log("error", this.t("upd.cliMissing", { path: cli }));
        resolve(false);
        return;
      }
      /** @type {string[]} */
      const args = ["--install-extension", vsixPath, "--force"];
      try {
        args.push("--extensions-dir", path.dirname(this.context.extensionPath));
      } catch { /* 取不到就交给 CLI 默认目录 */ }
      try {
        args.push("--user-data-dir", path.resolve(this.context.globalStorageUri.fsPath, "..", "..", ".."));
      } catch { /* 同上 */ }
      const line = [cli, ...args].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(" ");
      const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
        windowsHide: true,
        env: sanitizeEnv(process.env),
      });
      let output = "";
      const capture = (/** @type {Buffer} */ data) => {
        if (output.length < 8000) output += data.toString("utf8");
      };
      child.stdout?.on("data", capture);
      child.stderr?.on("data", capture);
      const timer = setTimeout(() => {
        child.kill();
        this.log("error", this.t("upd.cliTimeout"));
        resolve(false);
      }, CLI_TIMEOUT_MS);
      if (typeof timer.unref === "function") timer.unref();
      child.on("error", (e) => {
        clearTimeout(timer);
        this.log("error", this.t("upd.cliFailed", { error: e.message }));
        resolve(false);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(true);
        else {
          this.log("error", this.t("upd.cliFailed", { error: `exit ${code}: ${output.trim().slice(0, 500)}` }));
          resolve(false);
        }
      });
    });
  }

  /** 安装完成后提示重载（运行中的扩展宿主不会自动换版本） */
  async promptReload() {
    const pick = await this.vscode.window.showInformationMessage(
      this.t("upd.installed", { tag: this.state.installedTag || this.state.latestTag }),
      this.t("upd.reloadNow"),
      this.t("common.later"),
    );
    if (pick === this.t("upd.reloadNow")) {
      await this.vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  }
}

module.exports = { ExtensionUpdater, DEFAULT_MIRRORS };
