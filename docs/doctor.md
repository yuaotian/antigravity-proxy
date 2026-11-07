# doctor.ps1：一键部署与体检修复

> 面向两个场景：首次使用时用它把补丁装好；出问题时用它一次性定位并修复。
> 脚本不常驻、不注册计划任务、不写注册表、不结束任何进程。

## 1. 为什么需要它

`version.dll` 劫持方案有一个结构性弱点：**Antigravity 的安装目录是它自己的**。
客户端后台静默自更新会重新执行安装器并重建安装目录，我们手动放进去的
`version.dll` 与 `config.json` 会一起被清掉。用户侧的表现是：更新之前一切正常，
更新之后主页白屏、无法登录，而且没有任何提示说明"补丁没了"。

README 里已经写了"更新后可能清理劫持文件，请重新复制"，但让普通用户手动找目录、
比对架构、保留自己配好的端口，失败率很高。`doctor.ps1` 把这套动作变成一条命令。

## 2. 为什么补丁没了就直接白屏（根因分层）

这次现场排查（Antigravity 2.23.0 → 2.23.1，Windows 11 x64，Clash Verge Rev 系统代理）
把因果链拆成了三层，值得写进文档，因为它解释了"为什么不能只靠系统代理"：

1. **Antigravity 的主页和登录态不是 Electron 自己请求的**，而是由
   `resources\bin\language_server.exe` 这个 Go 进程去请求
   `oauth2.googleapis.com` / `daily-cloudcode-pa.googleapis.com`。
2. **Go 的标准库只读环境变量**（`HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`），
   完全不读 Windows 注册表里的系统代理。Clash 的"系统代理"模式只改注册表，
   所以对 Chromium（Electron 界面）有效，对 Go 后端无效。
   后端日志里能直接看到它自己解析出的 Google IP 并超时：
   `Post "https://oauth2.googleapis.com/token": dial tcp 172.253.117.95:443: connectex ...`
   同时 `[RemoteControl] Resolved proxyServerURL: ""` 说明它拿不到任何代理配置。
3. **DLL 注入正是为了补上这一层**：Hook Winsock 让 Go 进程的连接走 SOCKS5。
   补丁一旦被更新冲掉，后端就退回"裸直连 Google"，在国内网络必然超时，
   主页拿不到用户信息就停在白屏，Electron 侧表现为
   `Failed to load URL: https://127.0.0.1:<port>/ with error: ERR_TIMED_OUT`（Issue #150）。
   注意这个本地端口本身是好的，直接 `curl` 同一个端口能拿到 200。

实测对照：同一个安装目录，只把 `version.dll` + `config.json` 放回去并重启，
`language_server.log` 里的直连超时从 157 条降到 0 条，主页恢复。

## 3. 与启动器类方案（#143 / #148）的区别

#143 和 #148 都是"启动前补文件"的启动器思路。#148 的评论区已经实测到关键盲区：

> 更新后不仅 `version.dll`、`config.json` 消失，开始菜单的 `Antigravity.lnk`
> 也会被重置为直接启动官方 `Antigravity.exe`，绕过启动器。

也就是说，凡是依赖"用户从我们的入口启动"的方案，都会在一次自更新之后失效，
而自更新本身还会用 `--updated --force-run` 直接重启主程序，同样绕过启动器。

`doctor.ps1` 因此不做入口劫持，只做两件事：**把状态判定清楚**，
**把文件从安装目录之外的母本补回来**。代价是更新后需要用户主动跑一次
（或在体检提示下来跑一次），换来的是不依赖启动路径、不常驻、不装服务。

## 4. 检查项与判定码

| 判定码 | 级别 | 含义 |
|--------|------|------|
| `InstallDirNotFound` / `InstallDirInvalid` / `InstallDirAmbiguous` | Fail / Fail / Warn | 安装目录发现结果（注册表卸载信息、常见路径、运行中进程主模块目录） |
| `PatchMissing` | Fail | 补丁文件被更新冲掉，即本文档的主场景 |
| `PatchPresent` / `ArchMatched` | Pass | 文件齐全、PE 头架构与主程序一致 |
| `ArchMismatch` / `PatchFileInvalid` / `PatchDiffersFromSource` | Fail / Fail / Warn | x86 补丁配 x64 主程序、文件被截断、与母本内容不一致 |
| `ConfigMissing` / `ConfigUnreadable` / `ConfigNotDeployed` | Fail / Fail / Info | 配置缺失或语法错误（JSONC 注释可容错解析） |
| `ProxyPortUnreachable` / `ProxyPortReachable` | Fail / Pass | 直接 TCP 探测 `proxy.host:port`，并列出本机在听的相关端口 |
| `TargetProcessesMissingBackend` | Fail | `target_processes` 未覆盖 `language_server`，后端仍会直连（见 issue-85 文档） |
| `ChildInjectionDisabled` / `AllowedPortsMissing443` / `FakeIpEnabled` | Warn / Warn / Info | 常见配置陷阱 |
| `DllLoaded` / `DllNotLoaded` / `ChildNotInjected` | Pass / Fail / Fail | 按**模块路径是否位于该安装目录**判断，避免把 `System32\VERSION.dll` 误判成注入成功；无关的 `node.exe` 也不会算作后端子进程 |
| `DllLoadedFromDeletedFile` | Warn | 文件已被删除，但运行中的进程还在使用内存里的旧镜像——下次启动就失效，应立刻修复 |
| `HookInstalled` / `TunnelEstablished` / `TunnelFailed` / `HookNotObserved` / `ProcessCrashObserved` / `FakeIpRefused` | Pass / Pass / Fail / Warn / Fail / Warn | 解析 `logs\proxy-YYYYMMDD.log` |
| `BackendDirectDial` / `BackendHealthy` / `LocationRejected` | Fail / Pass / Fail | 解析 `language_server.log`；命中 location 说明该查出口 IP 而不是查注入 |
| `RendererLoadTimeout` / `RendererLoadTimeoutHistory` | Warn / Info | `main.log` 是累积追加的，按时间戳区分"本次还有"和"历史残留"，避免修好之后仍报白屏 |
| `SourceInsideInstallDir` | Fail | 母本放在安装目录里，会连同母本一起被更新删除 |
| `NoLocalSourceCopy` / `SourceDirNotFound` | Warn / Fail | 本机没有可用母本，需要重新下载发布包 |

## 5. 用法

```powershell
# 体检（只读，默认动作）
powershell -ExecutionPolicy Bypass -File .\doctor.ps1

# 首次部署：自动发现安装目录 + 探测本机代理端口 + 写 config.json
powershell -ExecutionPolicy Bypass -File .\doctor.ps1 -Action Setup -ProxyPort 7897

# 更新后修复：从安装目录之外的母本补回缺失文件，保留已配好的 config.json
powershell -ExecutionPolicy Bypass -File .\doctor.ps1 -Action Repair

# 需要用母本覆盖安装目录内的 DLL 与配置时
powershell -ExecutionPolicy Bypass -File .\doctor.ps1 -Action Repair -OverwriteConfig

# 供脚本或 CI 消费
powershell -ExecutionPolicy Bypass -File .\doctor.ps1 -Json
```

发布包里同时提供 `doctor.bat`，双击即可运行体检并在结束后停留显示结果。

**母本目录请放在安装目录之外**，例如 `%LOCALAPPDATA%\antigravity-proxy\` 或独立的下载目录。
首次成功部署后，脚本会把母本位置记到
`%LOCALAPPDATA%\antigravity-proxy\doctor-state.json`，之后 `-Action Repair` 不用再带参数。

退出码：`0` 健康 / `1` 需要修复 / `2` 自动修复未完成 / `3` 环境或参数问题。

## 6. 安全边界

- 不结束、不重启任何进程；检测到进程在运行时只提示"需要完全退出后重开"。
- 写入一律"临时文件 + SHA256 校验 + Move-Item 原子替换"，失败即回滚清理临时文件。
- 默认不覆盖安装目录里已有的 `config.json`，避免把用户的端口重置成默认值。
- 默认不覆盖已存在的 `version.dll`，需要同步时用 `-OverwriteConfig` 显式声明。
- 只读日志、只写目标安装目录；注册表仅只读 `Uninstall` 项用于发现安装目录。
- 母本位于安装目录内部时直接拒绝部署，并解释为什么（见第 3 节）。

## 7. 自测

```powershell
powershell -ExecutionPolicy Bypass -File .\test-doctor.ps1
```

全部在 `%TEMP%` 下的临时夹具内运行：用自造的最小 PE 头文件验证架构判定、
补丁缺失、架构不匹配、哈希一致性、母本位置校验、config 保留、JSONC 容错、
日志判读与目录隔离统计等 69 项断言，不触碰真实安装目录，也不读写注册表。
