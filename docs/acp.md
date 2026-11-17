# 其它编辑器经 ACP 使用 Antigravity 时走代理（Issue #164）

> 适用：在 **JetBrains（IntelliJ / PyCharm / Android Studio …）、Zed、VS Code（ACP Client 扩展）、Xcode** 等编辑器里，
> 通过 ACP 使用 Google Antigravity Agent，并希望它的流量也经过 Antigravity-Proxy。
>
> 关联 Issue：[#164 支持 Google Antigravity ACP：agy-acp-server](https://github.com/yuaotian/antigravity-proxy/issues/164)

---

## 1. 一句话结论

ACP 的 Agent 由**其它编辑器**以子进程方式启动，父进程不是 Antigravity，原有的 `version.dll` 注入链覆盖不到它。
本项目新增了一个启动包装器 **`agy-acp-proxy.exe`**：把编辑器里的 Agent 命令改成
`agy-acp-proxy.exe <真正的 Agent> [参数]`，包装器会先注入代理 DLL 再启动 Agent。
Antigravity IDE 用户可以直接在插件侧栏点 **「外部编辑器 ACP 代理」**，全程不需要终端。

---

## 2. 背景：ACP 与 Google Antigravity ACP

### 2.1 ACP 是什么

[Agent Client Protocol](https://agentclientprotocol.com)（ACP）由 Zed 与 JetBrains 发起，可以理解为“AI Agent 领域的 LSP”：

- 编辑器（Client）把 Agent 作为**子进程**启动；
- 双方在 **stdin/stdout 上跑 JSON-RPC 2.0**：`initialize` → `authenticate` → `session/new` → `session/prompt`，Agent 用 `session/update` 流式回传；
- Agent 还可以反向请求编辑器：`session/request_permission`、`fs/read_text_file`、`terminal/*` 等。

### 2.2 Google 提供的两种 Antigravity ACP

| 形态 | 启动方式 | 来源 | 说明 |
|:--|:--|:--|:--|
| `agy acp` | `agy.exe acp` | [官方文档](https://antigravity.google/docs/cli/acp) | Antigravity CLI 的子命令，**需 agy ≥ 1.5**（`agy acp --help` 能运行即支持）。IDE 托管的 `~/.gemini/bin/agy.exe` 与独立安装的 `%LOCALAPPDATA%\agy\bin\agy.exe` 都可以 |
| `agy-acp-server` | `agy_acp_server.exe` | [ACP Registry: antigravity-acp](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json) | JetBrains / Zed / Android Studio “一键安装”下载的独立包 |

登录方式两者一致：`oauth-personal`、`oauth-business`、`gemini-api-key`、`agent-platform`、`terminal-login`（`agy acp --login`）。
ACP 日志位于 `~/.gemini/antigravity-cli/log/acp-*.log`。

### 2.3 `agy-acp-server` 包内部结构（对 1.5.0 Windows 包的静态分析）

Registry 中的 Windows 包（`agy-acp-server-1.5.0-windows-x86_64.zip`，SHA256 与 agent.json 一致）解压后有**两个**程序：

| 文件 | 类型 | 静态导入 | 角色（依据内置模块名） |
|:--|:--|:--|:--|
| `agy_acp_server.exe`（58 MB） | PyInstaller 打包的 Python 3.14 | KERNEL32 / ADVAPI32 / USER32 | ACP 协议适配层，内含 `acp.*`、`acp_server.oauth.*`、`ccpa_connection.{ccpa_client, oauth_manager, proxy_server}`、`telemetry`、`google.genai` 等 |
| `localharness_external.exe`（155 MB） | Go（与 agy.exe 同源） | ADVAPI32 / dbghelp / KERNEL32 / WS2_32 | Agent 引擎，访问 `cloudcode-pa` / `aiplatform` / `generativelanguage` / `oauth2.googleapis.com` |

进程树（前两层已在 2026-11-17 运行期验证，见 2.4）：

```
ACP 客户端（idea64 / zed / studio64 …）
 └─ agy_acp_server.exe            PyInstaller 引导进程                 ✅ 已验证
     └─ agy_acp_server.exe        Python 主体：ACP / OAuth / CloudCode  ✅ 已验证
         └─ localharness_external.exe   Go 引擎（登录后创建会话时启动） ⏳ 需登录后验证
             └─ 工具子进程（powershell / git …）
```

关键点：**Python 层和 Go 层都会访问 Google**，必须两层都进代理；而 `agy_acp_server.exe` 引导进程只导入系统 KnownDLLs，没有可侧载 DLL 的位置。

### 2.4 运行期验证记录（2026-11-17，agy-acp-server 1.5.0，Google LLC 签名有效）

用 `agy-acp-proxy.exe` 拉起 Registry 版服务端，只发送 ACP `initialize` 与 `session/new`（不发 prompt）：

| 检查项 | 结果 |
|:--|:--|
| `initialize` 经包装器的 stdio 往返 | ✅ 6.9 秒返回 `protocolVersion: 1`、`authMethods`（oauth-personal / oauth-business / gemini-api-key / agent-platform …） |
| 包装器 → 引导进程注入 | ✅ `[ACP 包装器] 已注入并启动目标`，DLL 以全量模式安装 Hook |
| 引导进程 → Python 主体注入（兼容规则） | ✅ `[兼容/ACP] agy_acp_server.exe 派生了关键子进程 agy_acp_server.exe` → `[成功] 已注入新建进程` |
| 关闭 stdin 后退出 | ✅ 正常退出（exit=0），无残留进程 |
| `session/new` | 返回 `-32000 Authentication required`：**Registry 版使用独立的登录状态**（`~/.gemini/antigravity-acp/settings.json` 的 `auth.type`），不复用 `agy` CLI 的登录，需要在编辑器里先登录一次 |

`initialize` 阶段没有任何外网连接；`localharness_external.exe` 的注入与 `*.googleapis.com` 隧道需在编辑器里登录后按第 5 节自行确认。

---

## 3. 实现原理

| 组件 | 位置 | 作用 |
|:--|:--|:--|
| `agy-acp-proxy.exe` | `src/launcher/AcpProxyLauncher.cpp` | 挂起创建目标 → 注入同目录 DLL（`antigravity_proxy.dll` 优先，其次 `version.dll`）→ 恢复 → 透传退出码。stdio 只做**句柄继承**，不读写 ACP 流量；Job 对象保证包装器退出时整棵进程树一起结束 |
| ACP 进程链兼容注入 | `src/hooks/Hooks.cpp::ShouldAutoInjectAcpServerChild` | 当前进程是 `agy_acp_server.exe` 时，filtered 模式下也自动注入子进程 `agy_acp_server.exe` / `localharness_external.exe`，**不需要改 config.json**；工具子进程不受影响 |
| 同进程单实例保护 | `src/main.cpp::TryClaimProcessHookOwnership` | 互斥量 `Local\AntigravityProxy_Hooks_<PID>`：同一进程被“dbghelp 侧载 + 注入”加载两份 DLL 时，只有第一份装 Hook |
| 插件向导 | `resources/ide-extension/lib/acpWizard.js`、`acpSupport.js` | 自动检测、部署包装器、写入/复制各编辑器配置、启动时提示 |

包装器退出码：

| 退出码 | 含义 |
|:--|:--|
| 目标自身的退出码 | 正常运行 |
| 2 | 没有提供目标程序 |
| 3 | 包装器同目录找不到代理 DLL |
| 4 | 目标程序启动失败（路径错误 / 权限 / 架构不符） |
| 5 | 注入失败（已结束目标进程，**不会悄悄直连**） |

---

## 4. 使用方法

### 4.1 方式一：Antigravity IDE 插件一键配置（推荐，无需终端）

1. 在 Antigravity IDE 左侧 Antigravity Proxy 侧栏点击 **「外部编辑器 ACP 代理」**（或命令面板执行 `Antigravity Proxy: 配置外部编辑器 ACP 代理`）；
2. 插件把 `agy-acp-proxy.exe` 部署到 **IDE 安装目录**（与 `version.dll`、`config.json` 同级，**共用同一份代理配置**，插件设置面板改端口后对 ACP 也生效）；
3. 选择要走代理的服务端（插件会自动检测 `~/.gemini/bin/agy.exe`、`%LOCALAPPDATA%\agy\bin\agy.exe` 以及 JetBrains / Zed / Android Studio 目录下 Registry 安装的 `agy_acp_server.exe`）；
4. 选择编辑器：
   - **JetBrains**：自动合并写入 `~/.jetbrains/acp.json`（原文件先备份为 `acp.json.agp-bak-<时间戳>`；文件含注释时不改写，改为复制片段）；
   - **Zed**：配置片段复制到剪贴板并打开 `%APPDATA%\Zed\settings.json`，粘贴到 `agent_servers`；
   - **VS Code（ACP Client 扩展）**：配置片段复制到剪贴板，粘贴到用户 `settings.json`；
   - **仅复制命令**：用于 Xcode 或其它 ACP 客户端。
5. 在编辑器里选择名为 **`Antigravity (Proxy)`** 的 Agent 开始对话。

自动检测：插件启动约 15 秒后，若发现其它编辑器在用 Antigravity ACP 但没经过包装器，会提示一次（每个插件版本最多一次，可选“不再提示”，或在设置里关闭 `antigravityProxy.acp.detectOnStartup`）。
IDE 自动更新清空安装目录后，补丁守护会把部署过的包装器一并恢复；插件升级后包装器也会静默更新。

### 4.2 方式二：手动配置（CLI 发布包）

发布包 `cli/` 目录里有 `agy-acp-proxy.exe`、`antigravity_proxy.dll`、`config.json`（在线安装 / doctor 部署 CLI 补丁时会一起放到 `agy.exe` 目录）。
把它们放在同一个目录，然后在编辑器里把 Agent 命令指向包装器：

**Zed**（`settings.json`）：

```json
{
  "agent_servers": {
    "Antigravity (Proxy)": {
      "type": "custom",
      "command": "C:\\Users\\<你>\\AppData\\Local\\agy\\bin\\agy-acp-proxy.exe",
      "args": ["C:\\Users\\<你>\\.gemini\\bin\\agy.exe", "acp"]
    }
  }
}
```

**JetBrains**（`~/.jetbrains/acp.json`，需要 AI Assistant 插件）：

```json
{
  "agent_servers": {
    "Antigravity (Proxy)": {
      "command": "C:\\Users\\<你>\\AppData\\Local\\agy\\bin\\agy-acp-proxy.exe",
      "args": ["<Registry 安装目录>\\agy_acp_server.exe"]
    }
  }
}
```

**VS Code（`formulahendry.acp-client` 扩展）**：

```json
{
  "acp.agents": {
    "Antigravity (Proxy)": {
      "command": "C:\\...\\agy-acp-proxy.exe",
      "args": ["C:\\Users\\<你>\\.gemini\\bin\\agy.exe", "acp"]
    }
  }
}
```

说明：

- `agy acp` 的其它参数（`--sandbox`、`--add-dir`、`--log-file` 等）照常追加在 `args` 末尾，包装器原样传递；
- 如果 `agy.exe` 目录本身已部署 CLI 补丁（`dbghelp.dll`），编辑器直接启动 `agy acp` 也会走代理，包装器不是必需的；但 IDE 托管的 `~/.gemini/bin/agy.exe` 不部署 dbghelp，**需要用包装器**；
- Registry 版 `agy_acp_server.exe` **只能用包装器**（引导进程没有可侧载 DLL 的位置）。

### 4.3 编辑器“一键安装”的入口不会自动走代理

JetBrains / Zed 在 Registry 里点 “Install” 后，编辑器直接启动 `agy_acp_server.exe`，不会经过包装器。
请改用上面的“自定义 Agent”（插件向导会帮你找到 Registry 安装的路径并生成配置）。

---

## 5. 如何验证

1. 在编辑器里与 `Antigravity (Proxy)` 对话一次；
2. 打开**包装器所在目录**的 `logs\proxy-<日期>.log`（插件部署时就是 IDE 安装目录的 `logs`，插件的“代理日志”窗口可以直接看到）；
3. 应能看到：
   - `[ACP 包装器] 已注入并启动目标: ...agy_acp_server.exe`（或 `agy.exe`）；
   - Registry 版还应有 `[兼容/ACP] agy_acp_server.exe 派生了关键子进程 localharness_external.exe` 与 `[成功] 已注入新建进程 ... target_basename=localharness_external.exe`；
   - 到 `*.googleapis.com` 的 SOCKS5 / HTTP 隧道记录。
4. 如果看到 `[单实例] 当前进程已有另一份代理实例安装了 Hook`，属于正常保护（同一进程被两种方式各加载了一份 DLL）。

本地自测（不需要网络和 Google 账号）：`pwsh -File scripts\test-acp-proxy.ps1`（先运行 `build.ps1`），用 cmd/findstr 模拟 Agent，验证注入、stdio 透传与退出码。

---

## 6. 已知限制

- 只支持 Windows x64 / x86；Registry 提供的 windows-aarch64 暂不支持；
- 包装器使用远程线程注入（与 DLL 的子进程注入同一技术），个别安全软件可能误报，需要加白；
- 包装器退出时会结束整棵 Agent 进程树（Job 对象）；Agent 若需要保留后台进程，应使用 `CREATE_BREAKAWAY_FROM_JOB`；
- 包装器 → 引导进程 → Python 主体的注入已运行期验证；“Python 层也直连 Google”与 localharness 的网络链路来自静态分析，登录后以日志为准；
- Registry 版 `agy_acp_server` 与 `agy acp` 的登录状态互相独立，换用另一种服务端时需要重新登录。

---

## 7. ACP Registry 对本项目的作用

[agentclientprotocol/registry](https://github.com/agentclientprotocol/registry) 是 ACP Agent 的官方目录：每个 Agent 一份 `agent.json`（版本、各平台下载地址、sha256、启动命令），每小时自动同步版本，JetBrains 2025.3+ / Zed / Android Studio 据此一键安装；收录要求支持 Agent Auth 或 Terminal Auth。

对本项目：

- ✅ **权威信息源**：Windows 进程名（`cmd` 字段）、下载地址、版本与 sha256，本次兼容规则即据此确定；
- ✅ **回归测试与版本跟踪**：可按 agent.json 固定版本下载、离线校验后做兼容回归（`antigravity-acp` 已从 1.4.1 更新到 1.5.0）；
- ❌ 它**不提供注入点**，本项目也不是 ACP Agent，不适合上架 Registry。
