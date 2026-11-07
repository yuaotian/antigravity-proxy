# IDE 插件：状态栏 + 可视化设置 + 补丁守护

> 适用：Windows 桌面端 Antigravity IDE（VS Code 二开，2.6.0 实测：VS Code 1.107 / Electron 39.2.3 / Node 22.21.1）。
> 不适用：终端 CLI `agy`（无插件宿主）。
> 源码：`resources/ide-extension/`；共享配置核心：`resources/shared/config-core.js`。

## 1. 背景

补丁方案本身稳定，但用户侧长期有三个痛点：

1. **更新即失效且无提示**：IDE 静默自更新会重建安装目录，`version.dll` / `config.json` 一起被删，
   表现为白屏或无法登录（根因分层见 `docs/doctor.md` 第 2 节）。
2. **改配置门槛高**：DLL 只在进程启动时读取同目录 `config.json`（无热加载），用户要自己找目录、
   手写 JSON、记得重启；`config-web.html` 需要另外打开并手动替换文件。
3. **看不到状态**：补丁在不在、有没有被进程加载、代理端口通不通，都只能翻日志。

IDE 2.6.0 起后端改为内置扩展 `extensions/agy` 拉起的 `%USERPROFILE%\.gemini\bin\agy.exe --hub`，
默认 `target_processes` 已包含 `agy.exe`，注入与代理链路不变；插件解决的是上面三个“使用面”问题。

关键事实：插件安装在 `~/.antigravity-ide/extensions`，**不在安装目录内，IDE 更新不会清除**，
因此可以作为补丁的“常驻恢复源”。

## 2. 架构与模块职责

```
resources/shared/config-core.js     配置唯一事实源（规范化/导出/校验/JSONC），UMD
        │  构建时内联进 config-web.html；打包时复制为插件 media/config-core.js
        ▼
extension.js                        组装层：依赖装配、命令注册、生命周期、启动期补丁守护
lib/installInfo.js                  由 vscode.env.appRoot 推导安装目录/exe/DLL/配置路径；DLL 是否已加载
lib/configStore.js                  config.json 读写：原子写入、写前备份（10 份）、最后可用配置
lib/patchGuard.js                   补丁状态检测与缺失文件恢复
lib/proxyProbe.js                   代理探测：TCP / SOCKS5(含 RFC1929 认证) / HTTP CONNECT 隧道
lib/proxyScan.js                    本机代理扫描（多来源合并去重 → TCP 探活 → SOCKS5/HTTP 完整隧道探测）
lib/statusBar.js                    状态模型 → 状态栏文本/配色/悬浮提示（无 IO）
lib/configPanel.js                  Webview 宿主侧：单例面板、CSP、消息路由、保存前二次校验
lib/restart.js                      两段式重启器
media/panel.js + panel.css          Webview 前端（schema 驱动表单，仅用 --vscode-* 主题变量）
media/i18n.js                       运行时三语词典（UMD，宿主与 Webview 共用）
package.nls*.json                   命令标题 / 设置描述三语（VS Code 原生本地化）
payload/                            构建生成：同版本 version.dll + 默认 config.json（仓库中不存在）
```

设计取舍：

- **单一事实源**：校验规则只有 `config-core.js` 一份，config-web、Webview、宿主保存前二次校验共用，
  杜绝“UI 能存、DLL 不认”的漂移；`config-core.test.js` 中有“下拉枚举与校验取值一致”的守护用例。
- **Webview 只做展示**：所有文件 IO 在宿主侧完成；Webview 发 `save`，宿主用同一份核心再校验一次后才写盘。
- **CSP**：`default-src 'none'`，脚本仅允许 nonce，样式/字体仅允许插件资源；因此前端**不使用 style 属性**
  （骨架屏等用类名实现），否则会被 CSP 拦截。

Webview ↔ 宿主消息：

| 方向 | 消息 |
|:--|:--|
| Webview → 宿主 | `ready` `reload` `save` `probe` `scan` `restart` `repair` `createDefault` `openConfigFile` `openLogs` `import` `export` `copy` |
| 宿主 → Webview | `init`（含 `lang` / `intent`） `meta` `saved` `probeResult` `scanResult` `lang` `imported` `toast` |

打包与分发：`build.ps1` 生成 `output\ide\antigravity-proxy.vsix`（与 `version.dll` 同目录；`System.IO.Compression` 写入 `/` 分隔条目，
避免 PS 5.1 `Compress-Archive` 的反斜杠条目被 VS Code 拒绝）；`package-release.ps1` 把它放进 IDE 包的 `ide\`，
并另外发布独立资产 `*-ide-extension-win-<arch>.vsix`（Release 同时发布 `SHA256SUMS.txt`）。安装途径：
`doctor.ps1 -Action Setup/Repair` 与在线安装脚本（检测到 `Antigravity IDE.exe` 时调用 `bin\antigravity-ide.cmd --install-extension`）、
DLL 侧安装提示（第 7 节）、手动「从 VSIX 安装」。

## 3. 状态模型与状态栏优先级

```js
StatusModel = { patch, configStatus, proxy, reach, pendingRestart }
```

状态栏一次只展示“最需要处理”的一项，优先级自上而下：

| 条件 | 状态栏 | 背景 |
|:--|:--|:--|
| `version.dll` 不存在 | `$(error) 代理补丁缺失` | error |
| `config.json` 缺失/无法解析/读取失败 | `$(warning) 代理配置异常` | warning |
| 待重启（见下） | `$(sync) 代理 · 待重启` | warning |
| `proxy.port = 0` | `$(circle-slash) 代理已禁用` | — |
| 端口探测失败 | `$(debug-disconnect) 代理 N 不可达` | warning |
| 其它 | `$(globe) 代理 N` | — |

- **待重启** = `config.json` 修改时间晚于扩展宿主启动 2 秒以上，或本会话内保存/恢复过，
  或 DLL 文件存在但当前进程未加载（`needsRestart`）。
- **DLL 是否已加载**：读取 `process.report.getReport().sharedObjects`，判断安装目录下的 `version.dll`
  是否在扩展宿主进程中。这是“补丁真正生效”的直接证据，比判断文件存在可靠。
  实现上**必须临时开启 `report.excludeNetwork`**（见第 9 节问题 3），并按进程缓存结果
  （DLL 只在进程启动时载入，结果在进程生命周期内不变）。
- **连通检测**：状态栏只做轻量 TCP 检测（间隔 `statusBar.probeIntervalSeconds`，最小 10 秒，0 为仅启动/保存后）；
  面板“测试连接”与命令 `测试代理连接` 做完整隧道检测（握手 → 认证 → CONNECT `www.gstatic.com:443`），
  失败时按阶段（config/tcp/handshake/auth/tunnel）以当前界面语言给出原因。
- 无障碍：状态栏项设置 `accessibilityInformation`（role=button，朗读完整状态与“点击打开代理设置”）。

## 4. 补丁守护：恢复策略与安全约束

启动（`onStartupFinished`）流程：

1. `config.json` 可读 → 保存为“最后可用配置”（插件全局存储，不受 IDE 更新影响）。
2. 任一关键文件缺失 → `patchGuard.autoRestore=true` 时自动恢复，否则提示「一键恢复 / 开启自动恢复」。
3. **先刷新状态栏，再弹提示**：提示会一直等待点击，启动期还可能直接收进通知中心，不能阻塞状态展示。

恢复规则（`lib/patchGuard.js`）：

| 文件 | 来源 | 方式 |
|:--|:--|:--|
| `version.dll` | 插件 `payload/version.dll` | 临时文件 + rename，复制后校验 SHA256，不一致则丢弃 |
| `config.json` | 最后可用配置 → 其次 `payload/config.json` | 临时文件 + rename |

安全约束：

- **只补缺失文件，已存在的绝不覆盖**（用户可能自行升级了 DLL 或改了配置）。
- 不结束任何进程、不改注册表；恢复后由用户决定何时重启。
- 安装在 Program Files 等无写权限目录时返回 EPERM 提示（以管理员运行或改用户目录安装）。
- 面板保存同样走“备份 → 临时文件 → rename → 记录最后可用配置”，DLL 不会读到半写入的 JSON。

## 5. 多语言（中文 / English / Русский）

两层机制，各管一段：

| 层 | 范围 | 语言来源 |
|:--|:--|:--|
| `package.nls.json` / `.zh-cn` / `.ru` | 命令标题、设置描述、插件描述 | 只能跟随 IDE 显示语言（VS Code 原生机制） |
| `media/i18n.js` | 状态栏、通知、面板、连通测试原因、配置校验文案 | `antigravityProxy.language`（`auto` 跟随 `vscode.env.language`） |

- `resolveLang`：`zh*` → `zh-cn`，`ru*` → `ru`，其余 → `en`；缺词回退英文，再回退 key 本身；`{name}` 占位符替换。
- 校验文案在 `config-core.js` 的 `VMSG` 中（`validateForm(form, lang)`），中文与原文逐字一致，字段路径不变，config-web 不受影响。
- 切换语言即时生效：宿主重建 `t` 并刷新状态栏；已打开的面板收到 `lang` 消息后重建表单文案，测试过连接的会重新探测，
  让结果原因也换成新语言。
- `test/i18n.test.js` 守护：三语词条齐全、占位符一致、源码里引用的 key 都存在、各语言校验输出。

## 6. 首次引导与本机代理扫描

触发（`extension.js` 的 `maybeOnboard`）：每个 profile 只执行一次（`globalState` 键 `antigravityProxy.onboarded`），
前提是 `config.json` 可读且 `version.dll` 存在；`proxy.port = 0`（用户主动禁用）不打扰。

1. 当前代理完整隧道探测成功 → 只发一条通知（含延迟），可点「打开设置」。
2. 失败 → 自动打开面板（`intent: onboarding`），显示引导卡片，滚动到【代理】区并自动扫描：
   - 单个可用结果且当前配置不可用 → 自动填入（**不自动保存**），保存按钮温和呼吸提示；
   - 多个结果 → 列出候选（类型、来源、延迟），点「使用」填入；
   - 无结果 → 提示手动填写，【代理】区呼吸描边 3 次并聚焦端口输入框（`prefers-reduced-motion` 下关闭动画）；
   - 保存成功后撤下引导卡片与描边。
3. 命令「扫描本机代理」与面板里的扫描按钮走同一流程（`intent: scan`）。

扫描（`lib/proxyScan.js`，不依赖 vscode API，便于单测）：

- 来源与排序：当前配置 > IDE `http.proxy` > 系统代理（`HKCU\...\Internet Settings`，要求 `ProxyEnable=1`）>
  `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` > 常用端口（7890、7897、7891、10808、10809、1080、8118，与 doctor 一致）；
  同一 `host:port` 合并来源。
- 先 TCP 探活（800 ms），再并行做 SOCKS5 / HTTP 完整隧道探测（4 s），都可用时优先 SOCKS5；只有“当前配置”端点携带账密。

## 7. DLL 侧插件安装提示

`src/ide/IdeExtensionPrompt.cpp`：DLL 在 IDE 里加载后检查插件是否已安装，未安装则询问是否一键安装。

- 启用条件：进程是 `Antigravity IDE.exe` 主进程（命令行无 `--type=`、非 RunAsNode），且 DLL 同目录存在
  `antigravity-proxy.vsix`（手动复制 `ide/` 全部文件、或启动器同步时具备；doctor / 在线安装自己装插件，不放 VSIX）。
- 后台线程延迟 8 秒；扩展目录按 `--extensions-dir` > `VSCODE_PORTABLE\extensions` >
  `%USERPROFILE%\<product.json dataFolderName>\extensions` 确定，读 `extensions.json`（兜底看目录）判断是否已安装。
- 三语询问框，**每个 DLL 版本只问一次**（`logs\ide-extension-prompt.marker`，按 DLL 路径 + 大小 + 修改时间）。
- 选择安装：调用 `bin\antigravity-ide.cmd --install-extension <vsix> --force`（透传 `--extensions-dir` / `--user-data-dir`，
  无窗口，清理 `ELECTRON_*` / `VSCODE_*` / `CHROME_CRASHPAD_*`，超时 180 秒）。
- 实测：运行中的 IDE 会自动加载 CLI 刚安装的插件，**无需重启**，因此成功时不再弹窗，由插件的首次引导接管；
  失败时提示手动安装方法。
- 纯逻辑（主进程判定、参数解析、product.json、extensions.json）在 `IdeExtensionLogic.hpp`，由 `tests/test_ide_extension.cpp` 覆盖。

## 8. 两段式重启器

IDE 没有“重启应用”命令（只有 `workbench.action.quit` / `reloadWindow`），而 DLL 必须在新进程中才会重新读取配置，
因此需要一个在 IDE 退出后仍存活的外部重启器。实测约束（Windows PowerShell 5.1 + Node `child_process`）：

| 尝试 | 结果 |
|:--|:--|
| `spawn(..., { detached: true })` | 以 `DETACHED_PROCESS` 创建，powershell.exe 无控制台**直接退出（码 0），脚本不执行** |
| 非 detached | 子进程被 libuv 放入 `KILL_ON_JOB_CLOSE` 作业，**扩展宿主退出时被一并结束** |
| `-Command <含双引号的脚本>` | 被 powershell.exe 命令行解析破坏 |

最终方案：

1. **外层**（非 detached，调用方等待其结束）：趁 IDE 仍在运行，用 WMI 读取主进程（扩展宿主的父进程）命令行，
   去掉 exe 路径与 `--open-url` 及其后内容（防止重放 OAuth 回调），写入环境变量 `AGP_RELAUNCH_ARGS`，
   再 `Start-Process -WindowStyle Hidden` 拉起内层后退出。libuv 作业带 `SILENT_BREAKAWAY_OK`，孙进程不在作业内。
2. **内层**：等待主进程退出（最长 90 秒；用户在“未保存文件”提示中取消则超时放弃，不会重复拉起），
   再等同路径子进程收尾（最长 10 秒，确保单实例锁释放），按原参数启动主程序。
3. 外层确认成功（退出码 0）后才执行 `workbench.action.quit`；失败则提示手动重启，**不会“只关不开”**。

所有脚本以 `-EncodedCommand`（UTF-16LE Base64）传递，彻底避开引号转义。
重启后保留 `--user-data-dir` / `--extensions-dir` 等参数，便携版与多配置用户不会进错配置目录。

## 9. 测试方法

单元测试（`node:test`，`build.ps1 -RunTests` 自动执行，无 Node 时跳过并告警）：

| 文件 | 覆盖 |
|:--|:--|
| `resources/shared/config-core.test.js` | 默认值、规范化回退、未知字段保留、往返一致、CIDR/IPv6/端口范围、JSONC 容错、枚举一致 |
| `resources/ide-extension/test/proxyProbe.test.js` | SOCKS5 免认证/账密/目标拒绝、HTTP CONNECT 200/407、端口未监听、tcpOnly |
| `resources/ide-extension/test/patchGuard.test.js` | 恢复与哈希、不覆盖已存在文件、无 payload、原子写+备份上限、DLL 加载检测、重启器**真实拉起路径** |
| `resources/ide-extension/test/i18n.test.js` | 三语词条齐全、占位符一致、源码引用 key 存在、语言解析与回退、校验文案三语 |
| `resources/ide-extension/test/proxyScan.test.js` | 代理 URL / 系统代理串解析；伪造仅 SOCKS5、仅 HTTP 服务与关闭端口，验证排序、来源合并、无结果 |
| `tests/test_ide_extension.cpp`（ctest） | DLL 侧：主进程判定、命令行参数、product.json `dataFolderName`、extensions.json 查找 |

端到端（隔离副本，**不触碰正在使用的 IDE**）：

1. `robocopy` 安装目录到临时目录（排除 `logs`、卸载器）；用副本的 `bin\antigravity-ide.cmd`
   以临时 `--user-data-dir` / `--extensions-dir` 安装 VSIX。
2. 清理 `ELECTRON_*` / `VSCODE_*` / `HTTP(S)_PROXY` / `ALL_PROXY` 环境变量后，以 `--remote-debugging-port` 启动副本。
3. 通过 CDP 驱动：`Runtime.evaluate` 点击状态栏项、操作 Webview（iframe 目标内的 `#active-frame`），
   `Input.dispatchKeyEvent` 打开命令面板执行命令，`Page.captureScreenshot` 截图。全程不移动真实鼠标键盘。
4. 场景：状态栏 → 面板 → 修改保存 → 待重启 → 重启（核对新主进程命令行与原参数一致）→ 已生效；
   删除 `version.dll` + `config.json` → 启动 → 自动恢复（哈希一致、配置为上次保存值）→ 提示重启 → 生效；
   三语热切换；首次引导“可用 / 不可用 / 无结果”三条分支；
   经发布目录 `launcher\AntigravityLauncher.exe` 启动 → DLL 弹窗询问 → 安装 → 插件热加载 → 首次引导接管；
   已安装不再询问、选择「否」后同版本不再询问。
5. DLL 弹窗用 Win32 `FindWindow` + `GetDlgItem(IDYES/IDNO)` + `BM_CLICK` 自动点击，同样不移动鼠标。

该方法发现并修复了单元测试未覆盖的问题：

1. 重启后不再拉起 IDE（第 8 节的三条约束）——新增走真实拉起路径的回归用例。
2. 补丁被清除时状态栏空白——启动流程 `await` 提示框阻塞了刷新。
3. 扩展宿主卡死约 14 秒——`getReport()` 默认对每个 socket 做同步反向 DNS，补丁未生效（直连）时尤其慢；
   该阻塞会冻结同一扩展宿主内的所有插件。
4. 深色主题下代理类型分段控件选中态不可辨——改用 IDE 原生 `inputOption.active*` 令牌。
5. `build.ps1` 输出的一直是旧 DLL——递归查找产物时先命中了 VSIX 暂存目录里上一次构建的 `payload\version.dll`；
   改为排除暂存目录并按修改时间取最新（DLL 侧新模块因此一度“没生效”）。
6. 切换语言后连通测试结果仍是旧语言——收到 `lang` 消息时重新探测。
7. “未找到代理”提示把输入框方位写成“下方”——实际在扫描行上方。

## 10. 已知限制

- 仅 Windows 桌面端；CLI `agy` 不适用。
- **更新后的第一个会话没有代理**：补丁在启动后才被恢复，必须重启一次才会加载（插件会提示并可一键重启）。
- `payload` 中的 DLL 与构建架构一致（x64 发布包内的插件携带 x64 DLL，x86 同理），须与 IDE 架构匹配；
  插件版本应与发布包同步升级。
- “已生效”判断的是扩展宿主进程；`agy.exe` 等子进程的注入情况仍以 DLL 日志为准（可从面板一键打开日志目录）。
- 面板只编辑安装目录下的 `config.json`；`config-web.html` 仍可离线使用，两者校验规则一致。
- 命令标题与设置描述只能跟随 IDE 显示语言；`antigravityProxy.language` 只影响运行时文案。
- 首次引导每个 profile 只执行一次；之后可用命令「扫描本机代理」重新扫描。
- DLL 侧安装提示依赖 DLL 同目录的 VSIX；通过 doctor / 在线安装部署时由脚本直接安装插件，不经过该提示。
