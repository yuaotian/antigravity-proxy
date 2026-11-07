// @ts-check
"use strict";

/**
 * 配置健康检查（纯函数，不做 IO）：找出“补丁在、但后端不走代理”的配置缺口。
 * 目前只检查 Antigravity IDE 2.6 起必需的后端进程 agy.exe：
 * IDE 2.6 的后端改为 ~/.gemini/bin/agy.exe --hub，旧配置的 target_processes 缺它时后端直连，
 * 表现为界面一直转圈 / 127.0.0.1 超时（Issue #159）。判定规则与 DLL 保持一致（Config.hpp）：
 * - child_injection_mode = inherit：注入全部子进程，无需列出；
 * - target_processes 为空：同样注入全部子进程；
 * - 进程名比较不区分大小写。
 */

/** IDE 后端必需的目标进程 */
const REQUIRED_TARGETS = Object.freeze(["agy.exe"]);

/**
 * @param {any} raw config.json 解析结果
 * @returns {string[]} 缺少的目标进程，空数组表示无需处理
 */
function findMissingTargets(raw) {
  if (!raw || typeof raw !== "object") return [];
  const mode = String(raw.child_injection_mode || "filtered").trim().toLowerCase();
  if (mode === "inherit") return [];
  const list = Array.isArray(raw.target_processes) ? raw.target_processes : [];
  if (list.length === 0) return [];
  const have = new Set(list.map((name) => String(name).trim().toLowerCase()));
  return REQUIRED_TARGETS.filter((name) => !have.has(name));
}

/**
 * 返回补齐目标进程后的新配置（不修改入参；补在列表最前，便于用户一眼看到）
 * @param {any} raw @param {string[]} missing
 */
function withTargetsAdded(raw, missing) {
  const next = JSON.parse(JSON.stringify(raw));
  const current = Array.isArray(next.target_processes) ? next.target_processes : [];
  next.target_processes = [...missing, ...current];
  return next;
}

module.exports = { REQUIRED_TARGETS, findMissingTargets, withTargetsAdded };
