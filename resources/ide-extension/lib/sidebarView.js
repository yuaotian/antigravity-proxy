// @ts-check
"use strict";

/**
 * 左侧活动栏视图（单一职责：把状态模型与快捷命令渲染为原生 TreeView 节点；不做任何 IO）。
 *
 * 设计意图：
 * - 让插件除了底部状态栏外，也在 IDE 左侧活动栏（Activity Bar）常驻显示 G8 护盾图标；
 * - 展开后分为「当前状态」与「快捷操作」两组，100% 适配 IDE 深色与浅色主题；
 * - 点击状态项或操作项直接复用既有命令（打开设置面板、扫描本机代理、测试连接、修复补丁、重启 IDE、打开日志）。
 */

/** @typedef {import("./statusBar").StatusModel} StatusModel */
/** @typedef {(key: string, params?: Record<string, any>) => string} Translate */

class ProxySidebarProvider {
  /**
   * @param {typeof import("vscode")} vscode
   * @param {Translate} t
   */
  constructor(vscode, t) {
    this.vscode = vscode;
    this.t = t;
    /** @type {StatusModel | null} */
    this.model = null;
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._emitter.event;
  }

  /**
   * 更新状态模型并通知左侧树视图重绘
   * @param {StatusModel} m
   */
  render(m) {
    this.model = m;
    this._emitter.fire(undefined);
  }

  /** @param {any} element */
  getTreeItem(element) {
    return element;
  }

  /** @param {any} [element] */
  getChildren(element) {
    const { TreeItem, TreeItemCollapsibleState, ThemeIcon, ThemeColor } = this.vscode;
    const t = this.t;

    // 根节点：返回「当前状态」与「快捷操作」两个默认展开的分组
    if (!element) {
      const statusGroup = new TreeItem(t("side.groupStatus"), TreeItemCollapsibleState.Expanded);
      statusGroup.contextValue = "group-status";
      const actionsGroup = new TreeItem(t("side.groupActions"), TreeItemCollapsibleState.Expanded);
      actionsGroup.contextValue = "group-actions";
      return [statusGroup, actionsGroup];
    }

    if (element.contextValue === "group-status") {
      return this._buildStatusItems(TreeItem, TreeItemCollapsibleState, ThemeIcon, ThemeColor);
    }

    if (element.contextValue === "group-actions") {
      return this._buildActionItems(TreeItem, TreeItemCollapsibleState, ThemeIcon);
    }

    return [];
  }

  /**
   * 构造「当前状态」分组下的实时状态节点
   * @param {typeof import("vscode").TreeItem} TreeItem
   * @param {typeof import("vscode").TreeItemCollapsibleState} State
   * @param {typeof import("vscode").ThemeIcon} ThemeIcon
   * @param {typeof import("vscode").ThemeColor} ThemeColor
   */
  _buildStatusItems(TreeItem, State, ThemeIcon, ThemeColor) {
    const t = this.t;
    const m = this.model;
    if (!m) return [];

    const items = [];

    // 1. 补丁状态
    const patchItem = new TreeItem(t("sb.rowPatch"), State.None);
    if (!m.patch.dllExists) {
      patchItem.description = t("sb.patchStateMissing");
      patchItem.iconPath = new ThemeIcon("error", new ThemeColor("testing.iconFailed"));
      patchItem.tooltip = t("sb.patchMissingSummary");
      patchItem.command = { command: "antigravityProxy.repairPatch", title: t("side.repairPatch") };
    } else if (m.patch.dllLoaded === true && !m.pendingRestart) {
      patchItem.description = t("sb.patchStateActive");
      patchItem.iconPath = new ThemeIcon("agp-shield", new ThemeColor("testing.iconPassed"));
      patchItem.tooltip = t("sb.okSummary");
      patchItem.command = { command: "antigravityProxy.openSettings", title: t("side.openSettings") };
    } else if (m.pendingRestart || m.patch.needsRestart || m.patch.dllLoaded === false) {
      patchItem.description = t("sb.patchStatePending");
      patchItem.iconPath = new ThemeIcon("sync~spin", new ThemeColor("editorWarning.foreground"));
      patchItem.tooltip = t("sb.pendingSummary");
      patchItem.command = { command: "antigravityProxy.restartIde", title: t("side.restartIde") };
    } else {
      patchItem.description = t("sb.patchStateReady");
      patchItem.iconPath = new ThemeIcon("info");
      patchItem.command = { command: "antigravityProxy.openSettings", title: t("side.openSettings") };
    }
    items.push(patchItem);

    // 2. 配置文件状态
    const cfgItem = new TreeItem(t("sb.rowConfig"), State.None);
    const cfgMap = {
      ok: { desc: t("sb.configStateOk"), icon: "pass-filled", color: "testing.iconPassed" },
      missing: { desc: t("sb.configStateMissing"), icon: "warning", color: "editorWarning.foreground" },
      invalid: { desc: t("sb.configStateInvalid"), icon: "warning", color: "editorWarning.foreground" },
      error: { desc: t("sb.configStateError"), icon: "error", color: "testing.iconFailed" },
    };
    const cfgState = cfgMap[m.configStatus] || cfgMap.error;
    cfgItem.description = cfgState.desc;
    cfgItem.iconPath = new ThemeIcon(cfgState.icon, new ThemeColor(cfgState.color));
    cfgItem.command = { command: "antigravityProxy.openSettings", title: t("side.openSettings") };
    items.push(cfgItem);

    // 3. 当前代理地址
    const proxyItem = new TreeItem(t("sb.rowProxy"), State.None);
    if (!m.proxy || m.proxy.port === 0) {
      proxyItem.description = t("sb.disabled");
      proxyItem.iconPath = new ThemeIcon("circle-slash");
      proxyItem.tooltip = t("sb.disabledSummary");
    } else {
      proxyItem.description = `${m.proxy.type}://${m.proxy.host}:${m.proxy.port}`;
      proxyItem.iconPath = new ThemeIcon("agp-shield");
      proxyItem.tooltip = `${m.proxy.type}://${m.proxy.host}:${m.proxy.port}`;
    }
    proxyItem.command = { command: "antigravityProxy.openSettings", title: t("side.openSettings") };
    items.push(proxyItem);

    // 4. 连通性状态
    if (m.proxy && m.proxy.port > 0) {
      const reachItem = new TreeItem(t("sb.rowReach"), State.None);
      if (m.probing) {
        reachItem.description = t("sb.probing", { port: m.proxy.port });
        reachItem.iconPath = new ThemeIcon("sync~spin");
      } else if (m.reach) {
        if (m.reach.ok) {
          reachItem.description = Number(m.reach.latencyMs) > 0
            ? t("sb.reachOkLatency", { ms: m.reach.latencyMs })
            : t("sb.reachOk");
          reachItem.iconPath = new ThemeIcon("pass-filled", new ThemeColor("testing.iconPassed"));
        } else {
          reachItem.description = m.reach.message;
          reachItem.iconPath = new ThemeIcon("debug-disconnect", new ThemeColor("editorWarning.foreground"));
        }
        reachItem.tooltip = m.reach.message;
      } else {
        reachItem.description = "—";
        reachItem.iconPath = new ThemeIcon("plug");
      }
      reachItem.command = { command: "antigravityProxy.testProxy", title: t("side.testProxy") };
      items.push(reachItem);
    }

    // 5. 若缺少后端目标进程（如 agy.exe），在状态列表底部显示一键补齐项
    const missingTargets = m.missingTargets || [];
    if (missingTargets.length > 0) {
      const names = missingTargets.join(", ");
      const fixItem = new TreeItem(t("sb.targetsMissing", { names }), State.None);
      fixItem.description = t("sb.linkFixTargets");
      fixItem.iconPath = new ThemeIcon("warning", new ThemeColor("editorWarning.foreground"));
      fixItem.tooltip = t("sb.targetsMissingSummary", { names });
      fixItem.command = { command: "antigravityProxy.fixTargets", title: t("sb.linkFixTargets") };
      items.push(fixItem);
    }

    return items;
  }

  /**
   * 构造「快捷操作」分组下的操作按钮节点
   * @param {typeof import("vscode").TreeItem} TreeItem
   * @param {typeof import("vscode").TreeItemCollapsibleState} State
   * @param {typeof import("vscode").ThemeIcon} ThemeIcon
   */
  _buildActionItems(TreeItem, State, ThemeIcon) {
    const t = this.t;
    /** @type {[string, string, string][]} */
    const actions = [
      ["side.openSettings", "settings-gear", "antigravityProxy.openSettings"],
      ["side.scanProxy", "search", "antigravityProxy.scanProxy"],
      ["side.testProxy", "plug", "antigravityProxy.testProxy"],
      ["side.repairPatch", "shield", "antigravityProxy.repairPatch"],
      ["side.restartIde", "debug-restart", "antigravityProxy.restartIde"],
      ["side.openLogs", "folder-opened", "antigravityProxy.openLogs"],
    ];
    return actions.map(([labelKey, iconName, cmd]) => {
      const label = t(labelKey);
      const item = new TreeItem(label, State.None);
      item.iconPath = new ThemeIcon(iconName);
      item.command = { command: cmd, title: label };
      return item;
    });
  }

  dispose() {
    this._emitter.dispose();
  }
}

module.exports = { ProxySidebarProvider };

