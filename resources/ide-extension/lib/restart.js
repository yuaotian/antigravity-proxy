// @ts-check
"use strict";

/**
 * IDE 完整重启编排。
 *
 * 背景：代理 DLL 只在进程启动时读取 config.json（无热加载），且 IDE 未提供“重启应用”命令
 * （仅有 workbench.action.quit / reloadWindow），因此需要一个在 IDE 退出后仍存活的外部重启器。
 *
 * 实测约束（Windows PowerShell 5.1 + Node child_process）：
 *   - detached:true 会以 DETACHED_PROCESS 创建进程，powershell.exe 无控制台时直接退出（退出码 0、脚本不执行）；
 *   - 非 detached 子进程会被 libuv 放入 KILL_ON_JOB_CLOSE 作业，扩展宿主退出时被一并结束；
 *   - 通过 -Command 传入含双引号的脚本会被 powershell.exe 的命令行解析破坏。
 * 因此采用两段式：
 *   1) 外层（附着、等待其结束）：趁 IDE 仍在运行读取主进程启动参数，经环境变量交给内层，
 *      再用 Start-Process 拉起隐藏的内层后立即退出（libuv 作业允许静默脱离，内层不随 IDE 结束）；
 *   2) 内层：等待主进程退出 → 等同路径子进程收尾 → 按原参数启动主程序。
 * 外层确认成功后才执行 workbench.action.quit；若用户在退出提示中取消，内层超时后自行结束，不会重复拉起实例。
 * 所有脚本均以 -EncodedCommand（UTF-16LE Base64）传递，避免任何引号转义问题。
 */

const { spawn } = require("child_process");

/** 外层把主进程启动参数交给内层所用的环境变量名 */
const ARGS_ENV = "AGP_RELAUNCH_ARGS";

/** PowerShell 公共启动参数 */
const PS_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];

/**
 * 构造重启器使用的环境变量：剔除 IDE 内部变量，避免新实例继承 ELECTRON_RUN_AS_NODE 等
 * 导致以 Node 模式启动或连接到旧实例的 IPC。
 * @param {NodeJS.ProcessEnv} env
 */
function sanitizeEnv(env) {
  /** @type {NodeJS.ProcessEnv} */
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (/^(ELECTRON_|VSCODE_|CHROME_CRASHPAD_)/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** PowerShell 单引号字符串转义 */
const psQuote = (/** @type {string} */ s) => `'${String(s).replace(/'/g, "''")}'`;

/** 编码为 -EncodedCommand 所需的 UTF-16LE Base64 */
const encodePs = (/** @type {string} */ script) => Buffer.from(script, "utf16le").toString("base64");

/**
 * 内层脚本：等待主进程退出后按原参数重新启动（参数由外层经环境变量传入）。
 * @param {number} mainPid   IDE 主进程 PID（扩展宿主的父进程）
 * @param {string} exePath   主程序路径
 * @param {number} [waitSeconds]
 */
function buildRelauncherScript(mainPid, exePath, waitSeconds = 90) {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `$mainPid = ${Number(mainPid) | 0}`,
    `$exe = ${psQuote(exePath)}`,
    `$argLine = [string]$env:${ARGS_ENV}`,
    `$deadline = (Get-Date).AddSeconds(${waitSeconds | 0})`,
    // 等待主进程退出（用户取消退出时将超时放弃，避免重复启动）
    "while ((Get-Process -Id $mainPid -ErrorAction SilentlyContinue) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 300 }",
    "if (Get-Process -Id $mainPid -ErrorAction SilentlyContinue) { exit 0 }",
    // 再给同路径的子进程（GPU/渲染/扩展宿主等）最多 10 秒收尾，确保单实例锁已释放
    "$tail = (Get-Date).AddSeconds(10)",
    "while ((Get-Process | Where-Object { $_.Path -eq $exe }) -and ((Get-Date) -lt $tail)) { Start-Sleep -Milliseconds 300 }",
    "Start-Sleep -Milliseconds 500",
    "if ($argLine) { Start-Process -FilePath $exe -ArgumentList $argLine -WorkingDirectory (Split-Path -Parent $exe) } else { Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe) }",
  ].join("\n");
}

/**
 * 外层脚本：读取主进程启动参数（--user-data-dir / --extensions-dir 等），重启后原样恢复，
 * 避免便携/多配置用户重启后进入错误的配置目录；去掉 --open-url 及其后内容，防止重放 OAuth 回调。
 * 随后拉起隐藏内层并退出；内层启动失败时以退出码 1 告知调用方。
 * @param {number} mainPid
 * @param {string} innerScript 内层脚本（导出参数便于单元测试替换为探针脚本）
 */
function buildLauncherScript(mainPid, innerScript) {
  const innerArgs = `${PS_ARGS.join(" ")} -EncodedCommand ${encodePs(innerScript)}`;
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$argLine = ''",
    `$cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=${Number(mainPid) | 0}").CommandLine`,
    "if ($cmd) { if ($cmd.StartsWith('\"')) { $e = $cmd.IndexOf('\"', 1); if ($e -gt 0) { $argLine = $cmd.Substring($e + 1).Trim() } } else { $s = $cmd.IndexOf(' '); if ($s -gt 0) { $argLine = $cmd.Substring($s + 1).Trim() } } }",
    "$cut = $argLine.IndexOf('--open-url'); if ($cut -ge 0) { $argLine = $argLine.Substring(0, $cut).Trim() }",
    `$env:${ARGS_ENV} = $argLine`,
    `try { Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -ArgumentList ${psQuote(innerArgs)} -ErrorAction Stop } catch { exit 1 }`,
    "exit 0",
  ].join("\n");
}

/**
 * 运行外层脚本并等待其结束。
 * @param {string} script
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>} 内层是否已成功拉起
 */
function runLauncher(script, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", [...PS_ARGS, "-EncodedCommand", encodePs(script)], {
      stdio: "ignore",
      windowsHide: true,
      env: sanitizeEnv(process.env),
    });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/**
 * 拉起重启器并退出 IDE。
 * @param {typeof import("vscode")} vscode
 * @param {string} exePath
 * @param {(key: string) => string} t 翻译函数
 */
async function restartIde(vscode, exePath, t) {
  const mainPid = process.ppid;
  const ok = await runLauncher(buildLauncherScript(mainPid, buildRelauncherScript(mainPid, exePath)));
  if (!ok) {
    // 重启器未能启动时不退出 IDE，避免用户“只关不开”
    void vscode.window.showErrorMessage(t("ext.restartHelperFailed"));
    return;
  }
  await vscode.commands.executeCommand("workbench.action.quit");
}

module.exports = { restartIde, buildRelauncherScript, buildLauncherScript, runLauncher, sanitizeEnv, ARGS_ENV };
