<p align="center">
  <img src="img/antigravity_logo.png" alt="Antigravity Logo" width="120"/>
</p>

<h1 align="center">Antigravity-Proxy</h1>

<p align="center">
  <b>🚀 专为 Antigravity 编辑器打造：在中国也能无需 TUN 模式稳定走代理</b>
</p>

<p align="center">
  <a href="https://github.com/yuaotian/antigravity-proxy/actions"><img src="https://github.com/yuaotian/antigravity-proxy/actions/workflows/build.yml/badge.svg" alt="Build Status"/></a>
  <a href="LICENSE.txt"><img src="https://img.shields.io/badge/license-BSD--2--Clause-blue.svg" alt="License"/></a>
  <img src="https://img.shields.io/badge/platform-Windows%20x86%2Fx64%20%7C%20macOS%20launcher-lightgrey.svg" alt="Platform"/>
  <img src="https://img.shields.io/badge/C%2B%2B-17-00599C.svg" alt="C++17"/>
  <img src="https://img.shields.io/badge/hook-MinHook-orange.svg" alt="MinHook"/>
</p>

<p align="center">
  <a href="README_EN.md">🇬🇧 English Version</a>
</p>

---

## 📖 目录 / Table of Contents

- [📖 项目介绍 / Introduction](#-项目介绍--introduction)
- [🚨 先看这个：对话报错先排 IP / Read This First](#-先看这个对话报错先排-ip--read-this-first)
- [⚡ Antigravity 快速开始 / Quick Start](#-antigravity-快速开始--quick-start)
- [🔧 故障排查自查手册 / Troubleshooting Guide](#-故障排查自查手册--troubleshooting-guide)
- [✨ 功能特性 / Features](#-功能特性--features)
- [🔧 工作原理 / How It Works](#-工作原理--how-it-works)
- [🛠️ 编译构建 / Build](#️-编译构建--build)
- [📝 使用方法 / Usage](#-使用方法--usage)
- [🍎 macOS 使用指南 / macOS Guide](#-macos-使用指南--macos-guide)
- [🐧 WSL 环境使用指南 / WSL Guide](#-wsl-环境使用指南--wsl-guide)
- [🚀 进阶玩法 / Advanced Usage](#-进阶玩法--advanced-usage)
- [📄 许可证 / License](#-许可证--license)
- [👤 关于作者 / Author](#-关于作者--author)

---

## 🚨 先看这个：对话报错先排 IP / Read This First

> **先说结论：如果 Antigravity 的对话框里出现 `Agent execution terminated due to error`，请先排查代理出口 IP，不要先怀疑 DLL 没生效。**

我们已经在真实现场里确认过，最容易误判的场景是：
- `version.dll` 已加载
- `language_server_windows_x64.exe` 已注入
- `node.exe` 也已注入
- `oauth2.googleapis.com` / `daily-cloudcode-pa.googleapis.com` 仍然可以通过 SOCKS5 正常连通
- **但 Antigravity 自己的 `ls-main.log` 仍然返回：**
  - `FAILED_PRECONDITION (code 400): User location is not supported for the API use.`

这类问题的主因通常不是 DLL 失效，而是：
- **当前代理出口 IP 的国家/ASN/机房属性，被 Antigravity agent mode / Gemini CLI 路径判定为不可用**
- 也就是说：**“国家支持”不等于“当前这条 agent 执行链路一定接受这条出口 IP”**

### 你现在应该先看哪两份日志

#### 1. DLL 日志：证明“不是注入失效”
- `<Antigravity安装目录>\\logs\\proxy-YYYYMMDD.log`

如果你在这份日志里看到类似下面这些关键行，说明 DLL 本身已经在工作：
- `[成功] 已注入目标进程: language_server_windows_x64.exe`
- `[成功] 已注入目标进程: node.exe`
- `SOCKS5: 隧道建立成功, 目标=oauth2.googleapis.com:443`
- `SOCKS5: 隧道建立成功, 目标=daily-cloudcode-pa.googleapis.com:443`

从当前版本开始，DLL 还会额外输出 IP 诊断日志：
- `[诊断/IP] 当前代理出口探测完成: ...`
- `[诊断/IP] 当前代理出口呈现机房/托管特征...`
- `[诊断/IP] 最新 Antigravity 日志已命中 location 限制错误，同时当前代理出口呈现机房/托管特征...`

#### 2. Antigravity 应用日志：证明“真正失败的是 agent 执行链路”
- `%APPDATA%\\Antigravity\\logs\\<最新时间目录>\\ls-main.log`

如果你在这里看到：
- `agent executor error: FAILED_PRECONDITION (code 400): User location is not supported for the API use.`

那就说明：
- **当前失败点已经不是 DLL 注入或基本代理链路**
- **而是 Antigravity 自己的 agent execution 路径被服务端按 location / egress 策略拦住了**

### 最有效的排查顺序

1. 先看 `proxy-YYYYMMDD.log`
   - 如果注入和 SOCKS5 都成功，说明 DLL 大概率没问题。
2. 再看 `%APPDATA%\\Antigravity\\logs\\<最新目录>\\ls-main.log`
   - 如果有 `User location is not supported for the API use.`，优先排 IP。
3. 优先更换**非机房 / 非托管 / 普通 ISP / 住宅**出口，再重试
   - 同一个国家（例如新加坡）下，不同 ASN / 不同类型出口，结果可能完全不同。
4. 只有当 DLL 日志里根本没有注入成功、或根本没有代理握手成功时，才回头排 DLL。

### 一句话记忆点

> **Antigravity 对话报错时，先排出口 IP，再排 DLL。看到 `location is not supported` 基本优先看 IP。**

---

## 📖 项目介绍 / Introduction

**Antigravity-Proxy** 是专门为 **Antigravity 编辑器**量身定制的 Windows 代理注入组件（DLL）。

它的目标很简单：让中国用户使用 Antigravity 时，**不用开 Clash TUN 模式**，也能把网络流量稳定交给你的 SOCKS5/HTTP 代理。

> 项目名 **Antigravity-Proxy** = Antigravity + Proxy：只把 Antigravity 相关进程的流量“拽”进代理里（别担心，不会全局接管）。

### 🎯 解决的痛点 / Problem Solved

你是否遇到过这些情况？

- 🔴 使用 Antigravity 时**不走系统代理**，只能被迫开启 Clash TUN 模式
- 🔴 开启 TUN 模式后**全局流量都被代理**，影响本地开发
- 🔴 TUN 模式需要**管理员权限**，某些环境不允许

**Antigravity-Proxy 就是来专治这个的。** 它可以：

- ✅ **仅代理指定程序**（默认面向 Antigravity 相关进程），不影响其他流量
- ✅ **无需 TUN 模式**，避免全局接管
- ✅ **透明代理**，目标程序完全无感知

### 🌟 核心价值 / Core Value

| 传统方案 | Antigravity-Proxy |
|---------|-------------------|
| 需要 TUN 模式 | 无需 TUN |
| 全局代理 | 精准代理指定进程 |
| 需要管理员权限 | 普通用户即可 |
| 配置复杂 | 放入 DLL 即用 |

---


## ⚠️ 环境要求 / Prerequisites

> 在使用本工具前，请确保系统已安装必要的运行库，否则可能无法正常启动目标程序。

### 常见问题：0xc0000142 错误

如果启动程序时遇到 **错误代码 0xc0000142**（如下图所示），通常是由于系统缺少 Windows 运行库导致的。

<p align="center">
  <img src="img/error/win_error_0xc0000142.png" alt="0xc0000142 错误截图" width="400"/>
</p>

### 解决方案

请安装 **微软常用运行库合集**，该工具已包含在本仓库中：

📦 **下载路径**: [`microsoft\微软常用运行库合集-2025.exe`](microsoft/微软常用运行库合集-2025.exe)

**安装步骤：**
1. 进入本仓库的 `microsoft` 目录
2. 运行 `微软常用运行库合集-2025.exe`
3. 按照安装向导完成安装
4. 重新启动目标程序

---

## ⚡ Antigravity 快速开始 / Quick Start

> 只想让 Antigravity 立刻能用？看这一节就够了。

### macOS 快速开始

macOS 不能直接使用 Windows 的 `version.dll` 注入方式。本仓库提供了 macOS 启动器：自动读取 Clash Verge/Mihomo 本地混合端口，并用 Chromium 代理参数与 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`GRPC_PROXY` 环境变量启动 Antigravity。

```bash
./scripts/macos-antigravity-proxy.sh doctor
./scripts/macos-antigravity-proxy.sh restart
```

如果你使用旧版或独立安装的 **Antigravity IDE.app**：

```bash
./scripts/macos-antigravity-proxy.sh doctor --app ide
./scripts/macos-antigravity-proxy.sh restart --app ide
```

如果你想关闭 Clash Verge TUN，改为 System Proxy：

```bash
./scripts/macos-antigravity-proxy.sh clash-verge use-system-proxy
./scripts/macos-antigravity-proxy.sh system-proxy on
```

详细说明见 [docs/macos.md](docs/macos.md)。

### Step 1: 准备代理 / Prepare a Proxy

启动你的代理软件（例如 Clash/Mihomo），确保本机有可用的 SOCKS5 或 HTTP 代理端口（如 `127.0.0.1:7890`）。

<details>
<summary><b>📋 常用代理软件端口速查表（点击展开）</b></summary>

#### 各代理软件默认端口

| 代理软件 | SOCKS5 端口 | HTTP 端口 | 混合端口 | 备注 |
|----------|-------------|-----------|----------|------|
| **Clash / Clash Verge** | 7891 | 7890 | 7890 | 混合端口同时支持 SOCKS5 和 HTTP |
| **Clash for Windows** | 7891 | 7890 | 7890 | 设置 → Ports 可查看/修改 |
| **Mihomo (Clash Meta)** | 7891 | 7890 | 7890 | 同 Clash 配置格式 |
| **V2RayN** | 10808 | 10809 | - | 设置 → 参数设置 → Core 基础设置 |
| **V2RayA** | 20170 | 20171 | - | 后台管理页面可修改 |
| **Shadowsocks** | 1080 | - | - | 仅 SOCKS5，无 HTTP |
| **ShadowsocksR** | 1080 | - | - | 仅 SOCKS5，无 HTTP |
| **Surge (Mac/iOS)** | 6153 | 6152 | - | 增强模式下端口可能不同 |
| **Qv2ray** | 1089 | 8889 | - | 首选项 → 入站设置 |
| **sing-box** | 自定义 | 自定义 | 自定义 | 需在配置文件中手动指定 |
| **NekoBox** | 2080 | 2081 | - | 设置 → 入站 |
| **Clash Meta for Android** | 7891 | 7890 | 7890 | 同 Clash 规则 |

> 💡 **推荐使用 SOCKS5 协议**：本工具对 SOCKS5 的支持更完善，建议优先使用。

#### 如何确认代理端口是否开启？

**方法 1：查看代理软件界面**
- 大多数代理软件会在主界面或设置中显示当前监听端口

**方法 2：命令行测试**
```powershell
# 测试 SOCKS5 端口 (默认 7891)
Test-NetConnection -ComputerName 127.0.0.1 -Port 7891

# 测试 HTTP 端口 (默认 7890)
Test-NetConnection -ComputerName 127.0.0.1 -Port 7890
```

**方法 3：curl 测试（需安装 curl）**
```bash
# 通过 SOCKS5 代理访问
curl -x socks5://127.0.0.1:7891 https://www.google.com -I

# 通过 HTTP 代理访问
curl -x http://127.0.0.1:7890 https://www.google.com -I
```

#### 常见端口问题及解决

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| 端口被占用 | 其他程序使用了该端口 | `netstat -ano | findstr :7890` 查找占用进程 |
| 连接被拒绝 | 代理软件未启动或端口错误 | 确认代理软件已启动，检查端口配置 |
| 代理无响应 | 防火墙阻止 | 检查 Windows 防火墙设置 |

</details>

### Step 2: 准备文件 / Get the Files

准备以下文件：
- `version.dll`
- `dbghelp.dll`（仅 Antigravity CLI 需要）
- `config.json`

（可以从 Release 下载，或自行编译生成。）

### Step 3: 部署到 Antigravity / Deploy to Antigravity

把 `version.dll` 和 `config.json` 复制到 **Antigravity 主程序目录**（与 `Antigravity.exe` 同级）。然后启动 Antigravity，搞定。

如果使用 **Antigravity CLI**，把 `dbghelp.dll`、`version.dll` 和 `config.json` 复制到 `agy.exe` 同级目录。`agy.exe` 会加载同目录 `dbghelp.dll`，再由它加载 `version.dll`，不需要额外启动器。

#### Antigravity 2.0 注意事项

Antigravity 2.0 新增/改名了关键进程，默认配置已覆盖：

```json
"target_processes": [
  "agy.exe",
  "language_server.exe",
  "language_server_windows",
  "Antigravity.exe",
  "Antigravity IDE.exe",
  "node.exe"
]
```

如果你是从旧版本手动迁移 `config.json`，请确认 `child_injection` 仍为 `true`，并把上面的目标进程列表同步进去。2.0 环境如果存在多个启动目录，也要把 `version.dll` 和 `config.json` 放到实际启动的 Antigravity/IDE 目录中。

Antigravity 更新后可能清理安装目录里的劫持文件；如果更新后不走代理，请重新复制这些文件。若代理软件区分 mixed-port 和 SOCKS5 端口，也要确认 `proxy.type` 和 `proxy.port` 匹配本机实际监听端口。

更多现场记录见 `docs/antigravity-2.0-issue-85.md`。

#### Windows 常见目录 + 快速跳转

一般情况下 Antigravity 会装在：

例如：`C:\Users\<用户名>\AppData\Local\Programs\Antigravity`

如果你找不到这个目录：在桌面/开始菜单找到 Antigravity 图标，**右键 → 打开文件所在的位置**，跳出来的那个目录就是它的主程序目录。

想从命令行一键跳过去（少点鼠标，多点快乐）：

```powershell
cd "$env:LOCALAPPDATA\Programs\Antigravity"
```

```bat
cd /d "%LOCALAPPDATA%\Programs\Antigravity"
```

（可选）你也可以自己设个环境变量，之后就能 `cd` 秒过去：

```bat
setx ANTIGRAVITY_HOME "%LOCALAPPDATA%\Programs\Antigravity"
```

设置完后：PowerShell 用 `cd $env:ANTIGRAVITY_HOME`，CMD 用 `cd /d %ANTIGRAVITY_HOME%`。


## 🔧 故障排查自查手册 / Troubleshooting Guide

> 代理不工作？按照本手册逐步排查，找到问题根源。

### 📋 快速诊断流程图

```
代理不工作？
    │
    ├── 检查日志是否存在 ───────────────────────────────────┐
    │       │                                               │
    │       ├── ❌ 无日志 → DLL未加载/位置错误               │
    │       │       └── 见「DLL 加载问题」                   │
    │       │                                               │
    │       └── ✅ 有日志 → 继续检查日志内容                │
    │               │                                       │
    ├── 日志中有 "SOCKS5: 隧道建立成功" 吗？ ────────────────┤
    │       │                                               │
    │       ├── ❌ 没有 → 代理连接失败                      │
    │       │       └── 见「代理软件排查」                   │
    │       │                                               │
    │       └── ✅ 有 → 隧道建立成功，问题在后续            │
    │               │                                       │
    └── 检查 Clash 日志和节点可用性 ──────────────────────────┘
```

---

### 🔍 第一步：检查日志文件

日志是排查问题的第一手资料。

**日志位置**（按优先级）：
1. `<Antigravity安装目录>\logs\proxy-YYYYMMDD.log`
2. `%TEMP%\antigravity-proxy-logs\proxy-YYYYMMDD.log`

**快速打开**：
```powershell
# 打开 DLL 目录的 logs 文件夹
cd "$env:LOCALAPPDATA\Programs\Antigravity\logs"

# 或打开 TEMP 目录
cd "$env:TEMP\antigravity-proxy-logs"
```

**日志关键行解读**：

| 日志内容 | 含义 | 状态 |
|---------|------|------|
| `Antigravity-Proxy DLL 已加载` | DLL 成功注入 | ✅ 正常 |
| `配置加载成功` | config.json 读取成功 | ✅ 正常 |
| `所有 API Hook 安装成功` | Hook 生效 | ✅ 正常 |
| `ConnectEx Hook 已安装` | 异步连接 Hook 成功 | ✅ 正常 |
| `SOCKS5: 隧道建立成功` | 代理连接成功 | ✅ 正常 |
| `非 SOCK_STREAM socket 直连, soType=2` | UDP 未走代理（`udp_mode=direct` 或未启用 UDP 代理） | ⚠️ 视配置而定 |
| `SOCKS5 握手失败` | 代理握手失败 | ❌ 需排查 |
| `连接代理服务器失败` | 无法连接到代理 | ❌ 需排查 |
| `WSA错误码=10061` | 连接被拒绝（代理未启动） | ❌ 需排查 |
| `WSA错误码=10060` | 连接超时 | ❌ 需排查 |

---

### 🌐 第二步：代理软件排查

#### 2.1 确认代理端口可用

```powershell
# 测试 SOCKS5/混合端口
Test-NetConnection -ComputerName 127.0.0.1 -Port 7890

# 如果 TcpTestSucceeded: False，说明端口未监听
```

#### 2.2 确认 Clash 配置正确

在 Clash 配置文件中检查：

```yaml
# 必须开启混合端口或 SOCKS5 端口
mixed-port: 7890     # 混合端口（推荐）
# 或
port: 7890           # HTTP 端口
socks-port: 7891     # SOCKS5 端口

# 如果需要局域网访问
allow-lan: true
```

#### 2.3 检查 Clash 日志

在 Clash 界面查看「日志」或「Logs」，确认：
- 是否有来自 `daily-cloudcode-pa.googleapis.com`、`www.googleapis.com` 的请求
- 请求是 `DIRECT`（直连）还是走了代理节点
- 是否有 `REJECT` 规则命中

#### 2.4 测试节点可用性

最简单的方法：直接开启 **TUN 模式**，如果 TUN 模式下 Antigravity 正常，说明节点没问题。

---

### 💻 第三步：系统环境排查

#### 3.1 检查 Windows 版本

```powershell
winver
```

不同 Windows 11 小版本的 Winsock 行为可能有差异。请记录版本号备用。

#### 3.2 检查 Winsock LSP 配置

某些安全软件会注入 LSP（分层服务提供程序），可能干扰 Hook。

```powershell
# 以管理员身份运行
netsh winsock show catalog
```

正常情况下只应该有 Microsoft 的 Provider。如果看到第三方 Provider（如 360、火绒等），可能会有兼容性问题。

#### 3.3 检查安全软件

以下软件可能干扰 DLL 注入或 Hook：

| 软件 | 可能的影响 | 解决方案 |
|------|-----------|----------|
| **360 安全卫士** | 拦截 DLL 注入、Hook | 添加白名单或临时关闭 |
| **火绒安全** | 可能阻止远程线程注入 | 添加白名单 |
| **腾讯电脑管家** | LSP 注入可能干扰网络 | 添加白名单 |
| **Windows Defender** | 通常不干扰 | 无需处理 |

**临时排查**：尝试完全退出安全软件后测试（不只是退到托盘，要完全退出）。

#### 3.4 检查 IPv6 配置

如果系统启用了 IPv6，某些连接可能尝试 IPv6 优先：

```powershell
# 查看网络适配器 IPv6 状态
Get-NetAdapterBinding -ComponentID ms_tcpip6
```

如果日志中出现大量 IPv6 相关内容，可以尝试在 `config.json` 中设置：

```json
"proxy_rules": {
    "ipv6_mode": "block"
}
```

---

### 🔄 第四步：对比排查（与正常环境对比）

如果你的环境正常，但朋友的不行，请对比以下信息：

| 对比项 | 你的值 | 对方的值 |
|-------|--------|----------|
| Windows 版本 (winver) | | |
| Clash 版本 | | |
| 代理端口 | 7890 | |
| 代理类型 | socks5 | |
| 是否有安全软件 | | |
| `netsh winsock show catalog` 输出行数 | | |

---

### 📊 第五步：收集信息提交 Issue

如果以上排查都无法解决，请收集以下信息提交 [GitHub Issue](https://github.com/yuaotian/antigravity-proxy/issues)：

1. **日志文件**：完整的 `proxy-YYYYMMDD.log` 内容
2. **config.json**：你的配置文件（隐藏敏感信息）
3. **Windows 版本**：`winver` 输出
4. **Clash 版本和配置**（端口设置部分）
5. **安全软件列表**：已安装的杀软/安全软件
6. **问题描述**：具体什么功能不工作？打开什么网站/功能时失败？

---

### ⚠️ 已知兼容性问题

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| **大量 `非 SOCK_STREAM socket 直连, soType=2`** | UDP/QUIC 流量未走代理（`udp_mode=direct` 或 UDP 代理未生效） | 若需要 QUIC/HTTP3：设置 `udp_mode=proxy` + `proxy.type=socks5`，并确保代理端支持 SOCKS5 UDP Associate |
| **日志显示成功但网页打不开** | Clash 规则、节点问题 | 检查 Clash 日志 |
| **某些请求绕过代理** | 应用使用了未 Hook 的 API | 提交 Issue 反馈 |
| **360 等安全软件环境下失效** | LSP 注入干扰 | 添加白名单或卸载 |

---

## ❓ DLL常见问题与错误码 / Common Errors and Error Codes

> 遇到问题时，建议先确认目标程序位数（x86/x64），并查看目标程序目录下的日志文件（如 `proxy-YYYYMMDD.log`）。

### 已知错误码

| 错误码 | 问题描述 | 可能原因 | 解决方案 |
|--------|----------|----------|----------|
| `0xC0000142` | 应用程序无法正常启动（已知：部分环境使用 x64 版本会出现此错误，切换到 x86 版本可以正常运行） | 架构不兼容（目标程序为 x86，但放入了 x64 的 `version.dll`）<br>依赖库缺失或版本不匹配（常见：VC++ 运行库未安装/版本不一致）<br>安全软件拦截/隔离导致初始化失败 | 使用与目标程序一致的版本（x86 程序用 x86，x64 程序用 x64）<br>安装对应架构的 VC++ 2015-2022 运行库（尤其是 x64）<br>尝试使用静态运行库构建：`.\build.ps1 -StaticRuntime` |

### 其他常见错误码

| 错误码 | 问题描述 | 可能原因 | 解决方案 |
|--------|----------|----------|----------|
| `0xC000007B` | 应用程序无法正常启动（常见于位数不匹配） | `version.dll` 与目标程序位数不一致（x86/x64 混用）<br>依赖 DLL 位数不一致或文件损坏 | 确保 `version.dll` 与目标程序位数一致，并替换为对应版本产物<br>清理目标目录中可能残留的旧 DLL 后重试 |
| `0xC0000135` | 找不到组件/缺少 DLL，程序无法启动 | 依赖库缺失（常见：VC++ 运行库 DLL 缺失）<br>依赖库被安全软件删除/隔离 | 安装对应架构的 VC++ 2015-2022 运行库<br>或使用静态运行库构建：`.\build.ps1 -StaticRuntime` |
| `VCRUNTIME140_1.dll 缺失` | 启动时报“找不到 VCRUNTIME140_1.dll” | VC++ 2015-2022 运行库未安装或被安全软件删除 | 安装对应架构的 VC++ 2015-2022 运行库（x64/x86）<br>或使用静态运行库构建：`.\build.ps1 -StaticRuntime` |
| `0xC0000906` | 应用程序无法正常启动 | 文件被安全软件拦截/隔离<br>文件不完整或已损坏 | 重新获取/重新编译 DLL 并替换<br>将目标程序目录加入安全软件白名单/排除项后重试 |
| `0xC0000005` | 程序启动后闪退/崩溃（事件查看器常见） | Hook 与目标程序/系统环境不兼容<br>目标进程范围过大，误注入导致冲突 | 缩小 `target_processes` 仅代理必要进程<br>必要时关闭 `child_injection` 或 `fake_ip` 排查 |
| `10061 (WSAECONNREFUSED)` | 代理连接被拒绝（通常会出现在日志里） | 代理软件未启动或端口未监听<br>`config.json` 中代理地址/端口错误 | 启动代理软件并确认端口可用（如 `127.0.0.1:7890`）<br>检查并修正 `config.json` 的 `proxy.host/proxy.port` |
| `10060 (WSAETIMEDOUT)` | 连接超时（通常会出现在日志里） | 代理不可达/网络被阻断<br>超时配置过短 | 检查代理与网络状态后重试<br>适当增大 `config.json` 的 `timeout.connect/send/recv` |



## ✨ 功能特性 / Features

| 功能 | 说明 | Feature | Description |
|------|------|---------|-------------|
| 🔀 **代理重定向** | 拦截 `connect()` 调用，重定向至代理服务器 | Proxy Redirect | Intercepts `connect()` and redirects to proxy |
| 🌐 **FakeIP 系统** | 拦截 DNS 解析，分配虚拟 IP 并建立映射 | FakeIP System | Intercepts DNS, allocates virtual IPs |
| 👶 **子进程注入** | 自动将 DLL 注入到子进程 | Child Injection | Auto-injects DLL into child processes |
| ⏱️ **超时控制** | 防止目标程序因网络问题卡死 | Timeout Control | Prevents hanging on network issues |
| 🔄 **Fail-Safe** | 配置加载失败时自动直连 | Fail-Safe | Falls back to direct connection on error |
| 🎯 **进程过滤** | 仅代理指定的进程列表 | Process Filter | Proxy only specified processes |
| 📊 **流量监控** | 可选的流量日志记录 | Traffic Monitor | Optional traffic logging |

### 支持的代理协议 / Supported Protocols

- ✅ SOCKS5 (推荐 / Recommended)
- ✅ HTTP CONNECT

---

## 🔧 工作原理 / How It Works

### 整体架构 / Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           目标程序 (Target Process)                       │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────────┐   │
│  │  应用代码     │───►│ Winsock API  │───►│  antigravity-proxy.dll   │   │
│  │  (App Code)  │    │ (ws2_32.dll) │    │  (Hook Layer)            │   │
│  └──────────────┘    └──────────────┘    └────────────┬─────────────┘   │
│                                                       │                  │
└───────────────────────────────────────────────────────│──────────────────┘
                                                        ▼
                                              ┌──────────────────┐
                                              │   代理服务器      │
                                              │  (SOCKS5/HTTP)   │
                                              │  Proxy Server    │
                                              └──────────────────┘
```

### 核心流程 / Core Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. DLL 劫持 (DLL Hijacking)                                              │
│    程序加载 version.dll → 加载我们的 DLL → 转发真实 version.dll 调用      │
└─────────────────────────────────────────────────────────────────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 2. API Hook 安装 (Install Hooks)                                         │
│    使用 MinHook 拦截: connect, getaddrinfo, CreateProcessW 等           │
└─────────────────────────────────────────────────────────────────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 3. DNS 拦截 (DNS Interception)                                           │
│    getaddrinfo("example.com") → 分配 FakeIP (198.18.x.x) → 记录映射       │
└─────────────────────────────────────────────────────────────────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 4. 连接重定向 (Connection Redirect)                                       │
│    connect(198.18.x.x) → 查询映射还原域名 → 连接代理 → SOCKS5 握手         │
└─────────────────────────────────────────────────────────────────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 5. 子进程传播 (Child Process Propagation)                                │
│    CreateProcessW → 挂起进程 → 注入 DLL → 恢复运行                       │
└─────────────────────────────────────────────────────────────────────────┘
```

### Hook 的 API 列表 / Hooked APIs

| API | 模块 | 用途 |
|-----|------|------|
| `connect` | ws2_32.dll | 拦截 TCP 连接 |
| `WSAConnect` | ws2_32.dll | 拦截 WSA 方式连接 |
| `getaddrinfo` | ws2_32.dll | 拦截 DNS 解析 (ANSI) |
| `GetAddrInfoW` | ws2_32.dll | 拦截 DNS 解析 (Unicode) |
| `WSAConnectByNameA/W` | ws2_32.dll | 拦截按名称连接 |
| `ConnectEx` | ws2_32.dll | 拦截异步连接 |
| `CreateProcessW` | kernel32.dll | 拦截进程创建，注入子进程 |
| `send/recv` | ws2_32.dll | 流量监控（可选） |

---

## 🛠️ 编译构建 / Build

### 环境要求 / Prerequisites

在开始编译之前，请确保已安装以下工具：

| 依赖项 | 版本要求 | 用途 | 下载链接 |
|--------|----------|------|----------|
| **Visual Studio 2022** | 2022 或更高 | C/C++ 编译器 | [下载](https://visualstudio.microsoft.com/) |
| **CMake** | >= 3.0 | 构建系统 | [下载](https://cmake.org/download/) |
| **PowerShell** | 5.0+ | 编译脚本 | Windows 自带 |

> 💡 **提示**: 安装 Visual Studio 时，请确保勾选 **"使用 C++ 的桌面开发"** 工作负载。

### 依赖项 / Dependencies

| 依赖 | 说明 | 获取方式 |
|------|------|----------|
| **MinHook** | API Hook 框架 | 已内置于项目 |
| **nlohmann/json** | JSON 解析库 | 编译脚本自动下载 |

### 一键编译 / Quick Build

项目提供了 PowerShell 编译脚本，支持一键编译：

```powershell
# 默认编译 Release x64
.\build.ps1

# 编译 Debug 版本
.\build.ps1 -Config Debug

# 编译 32 位版本
.\build.ps1 -Arch x86

# 清理后重新编译
.\build.ps1 -Clean

# 输出详细编译日志
.\build.ps1 -Verbose

# CI 场景显式声明跳过测试步骤
.\build.ps1 -SkipTests

# 查看帮助
.\build.ps1 -Help
```

### 手动编译 / Manual Build

如果你更喜欢手动编译，也可以使用以下命令：

```bash
# ========== x64 (64位) ==========
mkdir build-x64 && cd build-x64

# 配置 (使用 Visual Studio 2022)
cmake .. -G "Visual Studio 17 2022" -A x64

# 编译 Release 版本
cmake --build . --config Release

# 输出: version.dll


# ========== x86 (32位) ==========
mkdir build-x86 && cd build-x86

# 配置
cmake .. -G "Visual Studio 17 2022" -A Win32

# 编译
cmake --build . --config Release

# 输出: version.dll
```

### 常见编译错误 / Common Build Errors

<details>
<summary><b>❌ 错误: "CMake 未找到"</b></summary>

**原因**: CMake 未安装或未添加到 PATH

**解决方案**:
1. 下载并安装 [CMake](https://cmake.org/download/)
2. 安装时勾选 "Add CMake to the system PATH"
3. 重启终端后重试
</details>

<details>
<summary><b>❌ 错误: "No CMAKE_CXX_COMPILER could be found"</b></summary>

**原因**: Visual Studio 未安装或 C++ 工具链缺失

**解决方案**:
1. 打开 Visual Studio Installer
2. 确保安装了 **"使用 C++ 的桌面开发"** 工作负载
3. 或者使用 Developer Command Prompt 运行编译命令
</details>

<details>
<summary><b>❌ 错误: 找不到 nlohmann/json.hpp</b></summary>

**原因**: JSON 库未下载

**解决方案**:
使用编译脚本 `build.ps1` 会自动下载，或手动下载：
```bash
# 手动下载
curl -o include/nlohmann/json.hpp https://raw.githubusercontent.com/nlohmann/json/develop/single_include/nlohmann/json.hpp
```
</details>

<details>
<summary><b>❌ 错误: LNK2019 unresolved external symbol</b></summary>

**原因**: 链接错误，通常是 Winsock 库未链接

**解决方案**:
确保 CMakeLists.txt 中包含:
```cmake
target_link_libraries(version PRIVATE ws2_32)
```
</details>

---

## 📝 使用方法 / Usage

### 快速开始 / Quick Start

**只需 3 步，即可让目标程序走代理！**

#### Step 1: 准备文件 / Prepare Files

编译完成后，你会在 `output` 目录得到：
- `version.dll` - 代理 DLL
- `dbghelp.dll` - Antigravity CLI 劫持 DLL
- `config.json` - 配置文件

#### Step 2: 配置代理 / Configure Proxy

编辑 `config.json`：

```json
{
    "proxy": {
        "host": "127.0.0.1",
        "port": 7890,
        "type": "socks5"
    },
    "fake_ip": {
        "enabled": true,
        "cidr": "198.18.0.0/15"
    },
    "timeout": {
        "connect": 5000,
        "send": 5000,
        "recv": 5000
    },
    "child_injection": true,
    "child_injection_mode": "filtered",
    "target_processes": [
        "agy.exe",
        "language_server.exe",
        "language_server_windows",
        "Antigravity.exe",
        "Antigravity IDE.exe",
        "node.exe"
    ],
    "proxy_rules": {
        "allowed_ports": [80, 443],
        "dns_mode": "direct",
        "ipv6_mode": "proxy"
    }
}
```

#### Step 3: 部署 DLL / Deploy DLL

将 `version.dll` 和 `config.json` 复制到目标程序的**同一目录**：

```
目标程序目录/
├── 目标程序.exe
├── version.dll      ← 放这里
└── config.json      ← 放这里
```

启动目标程序，完成！🎉

### 配置文件详解 / Configuration Reference

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `proxy.host` | string | `"127.0.0.1"` | 代理服务器地址 |
| `proxy.port` | int | `7890` | 代理服务器端口 |
| `proxy.type` | string | `"socks5"` | 代理类型: `socks5` 或 `http`（兼容 `https`，按 `http` 处理） |
| `fake_ip.enabled` | bool | `true` | 是否启用 FakeIP 系统 |
| `fake_ip.cidr` | string | `"198.18.0.0/15"` | FakeIP 地址范围 (基准测试保留网段) |
| `timeout.connect` | int | `5000` | 连接超时 (毫秒) |
| `timeout.send` | int | `5000` | 发送超时 (毫秒) |
| `timeout.recv` | int | `5000` | 接收超时 (毫秒) |
| `child_injection` | bool | `true` | 是否注入子进程 |
| `traffic_logging` | bool | `false` | 是否记录流量日志 |
| `target_processes` | array | `[]` | 目标进程列表 (空=全部) |
| `proxy_rules.allowed_ports` | array | `[80, 443]` | 端口白名单 (空=全部) |
| `proxy_rules.dns_mode` | string | `"direct"` | DNS策略: `direct`(直连) / `proxy`(走代理) |
| `proxy_rules.ipv6_mode` | string | `"proxy"` | IPv6策略: `proxy`(走代理) / `direct`(直连) / `block`(阻止) |
| `proxy_rules.udp_mode` | string | `"block"` | UDP策略: `block`(阻断) / `direct`(直连) / `proxy`(走代理, 需 SOCKS5 UDP Associate) |
| `proxy_rules.udp_fallback` | string | `"block"` | UDP 代理失败降级策略（仅 `udp_mode=proxy` 生效）: `block`(失败即阻断, 默认) / `direct`(失败回退直连, 有泄漏风险) |
| `proxy_rules.routing.enabled` | bool | `true` | 是否启用规则路由 |
| `proxy_rules.routing.priority_mode` | string | `"order"` | 规则优先级: `order`(按顺序) / `number`(priority) |
| `proxy_rules.routing.default_action` | string | `"proxy"` | 未命中时默认动作 |
| `proxy_rules.routing.use_default_private` | bool | `true` | 自动加载 RFC1918/loopback 内网直连规则 |
| `proxy_rules.routing.rules` | array | `[]` | 规则列表（支持 CIDR/域名通配符/端口/协议） |

### 规则路由 / Routing Rules

路由规则由 `proxy_rules.routing` 管理，支持 CIDR/域名通配符/端口/协议分流，优先级可选 `order`(按顺序) 或 `number`(priority)。

```json
{
  "proxy_rules": {
    "routing": {
      "enabled": true,
      "priority_mode": "order",
      "default_action": "proxy",
      "use_default_private": true,
      "rules": [
        {
          "name": "lan-direct",
          "action": "direct",
          "ip_cidrs_v4": ["10.0.0.0/8","172.16.0.0/12","192.168.0.0/16"],
          "ip_cidrs_v6": ["fc00::/7","fe80::/10","::1/128"],
          "domains": [".local","*.corp.example.com"],
          "protocols": ["tcp"]
        }
      ]
    }
  }
}
```

**可视化配置工具**：`resources/config-web/index.html`（本地打开即可使用；或构建后使用 `output/config-web.html`，支持导入/编辑/导出 `config.json`）。

**说明**：`AUTHORS.txt` 为内嵌的 MinHook 依赖作者名单，并非本项目维护者列表。

**提示**：
- 端口留空代表“全部端口”；域名留空仅按 CIDR 匹配；域名填 `*` 将匹配所有域名。
- 全量匹配可用 `0.0.0.0/0` 与 `::/0`。
- 工具已支持 `proxy.host` / `proxy.port` / `proxy.type` 的编辑。

### 已知问题 / Known Issues

- **历史版本（已修复）：FakeIP 与 `direct + domains + ports`**：在部分旧版本中，若启用 FakeIP，且 `action=direct` 的规则同时配置了 `domains` 与 `ports`，可能出现 DNS 阶段分配 FakeIP，随后 connect 阶段“直连虚拟地址”导致连接失败。若你仍在使用旧版本，建议升级；或临时规避：移除该规则的 `ports` 条件，或关闭 FakeIP。


### IPv6 注意事项

当日志出现 `SOCKS5: 读取认证响应失败, WSA错误码=10060`，且目标是 IPv6 地址（如 `2001:4860:4860::8888:443`），表示代理没有及时响应该 IPv6 连接。

可选处理方式：
- **不改 host，快速止血**：将 `proxy_rules.ipv6_mode` 改为 `block`（阻止）或 `direct`（直连）。
- **继续代理 IPv6**：让代理监听 `::1` 或开启双栈，再把 `proxy.host` 改为 `::1`（确保代理实际监听）。

**优先级说明**：当目标为纯 IPv6（非 v4-mapped）且 `proxy_rules.ipv6_mode` 为 `direct`/`block` 时，会在进入 `routing` 规则前直接直连/阻止；当 `ipv6_mode=proxy` 时才会继续进入 `routing` 匹配。

### UDP/QUIC 注意事项

当目标程序使用 **QUIC/HTTP3**（UDP/443）时，必须开启 UDP 代理，否则会出现“TCP 走代理但 QUIC 直连/被阻断”的现象。

启用方式：
- 将 `proxy_rules.udp_mode` 设为 `proxy`
- 将 `proxy.type` 设为 `socks5`（⚠️ HTTP 代理没有标准 UDP 转发能力）
- 确保代理软件**支持 SOCKS5 UDP Associate** 并允许 UDP 转发（不同客户端/内核能力不同）
- 可选：当代理不支持 UDP 时，可将 `proxy_rules.udp_fallback` 设为 `direct`（⚠️ 可能导致 UDP 直连泄漏；默认 `block` 更安全）

示例：

```json
{
  "proxy": { "host": "127.0.0.1", "port": 10808, "type": "socks5" },
  "proxy_rules": {
    "udp_mode": "proxy",
    "dns_mode": "direct",
    "allowed_ports": [80, 443]
  }
}
```

说明：
- `dns_mode="direct"` 仍会放行 UDP/53（避免 DNS 超时）；若你希望 DNS 也走代理，请改为 `dns_mode="proxy"`。
- 若日志出现“UDP 代理仅支持 SOCKS5 (UDP Associate)”：说明你配置了 `udp_mode=proxy` 但 `proxy.type` 不是 `socks5`，请修正配置。
- `udp_mode="block"` 默认会阻断大部分 UDP，但仍放行 loopback 与 UDP/53 作为例外（避免影响本机通信与 DNS）。

### 验证是否生效 / Verification

1. **检查日志**: 查看是否生成日志文件（格式：`proxy-YYYYMMDD.log`）
2. **查看代理软件**: 观察代理软件的连接日志
3. **使用抓包工具**: 使用 Wireshark 确认流量走向

#### 📂 日志文件位置 / Log File Locations

日志文件按以下优先级存放：

| 优先级 | 位置 | 说明 |
|--------|------|------|
| 1️⃣ | `<DLL所在目录>\logs\` | 与 `version.dll` 同级的 `logs` 子目录 |
| 2️⃣ | `%TEMP%\antigravity-proxy-logs\` | 系统临时目录（通常为 `C:\Users\<用户名>\AppData\Local\Temp\antigravity-proxy-logs\`） |

> 💡 **提示**：如果在 DLL 目录无法创建 `logs` 文件夹（例如权限不足），日志会自动回退到系统 TEMP 目录。
>
> 快速打开 TEMP 目录：按 `Win+R`，输入 `%TEMP%`，回车即可。

---

## 🐧 WSL 环境使用指南 / WSL Guide

> ⚠️ **重要提示**：Antigravity-Proxy（version.dll 劫持方案）**无法直接代理 WSL 内部的流量**。

### 为什么 DLL 劫持在 WSL 中不起作用？

这是由技术架构决定的根本性限制，无法通过修改代码来解决：

| 技术层面 | 详细说明 |
|---------|----------|
| **DLL 注入机制** | 本项目使用 Windows `version.dll` 劫持，只能 Hook **Windows PE 进程** |
| **Winsock API** | 拦截的是 `ws2_32.dll` 中的 `connect()`、`getaddrinfo()` 等 **Windows 专用 API** |
| **WSL 架构** | WSL2 运行真正的 **Linux 内核**，网络使用 Linux `socket()` 系统调用，与 Windows Winsock **完全独立** |
| **进程边界** | 即使注入 `wsl.exe`，也无法 Hook 其内部 Linux 子系统中 `language_server_linux_x64` 发出的流量 |

```
┌─────────────────────────────────────────────────────────────────┐
│                        Windows 主机                              │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  Antigravity-Proxy (version.dll)                           │  │
│  │  ├── Hook: connect(), getaddrinfo(), WSAConnect()...      │  │
│  │  └── ✅ 可以拦截所有 Windows 进程的网络请求                 │  │
│  └────────────────────────────────────────────────────────────┘  │
│                              │                                    │
│                         ❌ 无法穿透                               │
│                              ↓                                    │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │               WSL2 (轻量级 Linux 虚拟机)                     │  │
│  │  ┌──────────────────────────────────────────────────────┐  │  │
│  │  │  language_server_linux_x64                           │  │  │
│  │  │  └── 使用 Linux socket() 系统调用 → 绕过 Winsock    │  │  │
│  │  └──────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

### 替代方案

#### 方案一：使用 antissh 工具（推荐 ⭐⭐⭐⭐⭐）

[antissh](https://github.com/ccpopy/antissh) 是专门为在 WSL 中代理 Antigravity Agent 设计的工具。

**原理**：在 WSL 内部使用 **graftcp** 对 `language_server_linux_x64` 进行代理包装。

**快速开始**：
```bash
# 在 WSL 中执行
curl -O https://raw.githubusercontent.com/ccpopy/antissh/main/antissh.sh
chmod +x antissh.sh
bash ./antissh.sh
```

脚本会引导你：
1. 输入代理地址（如 `socks5://127.0.0.1:10808`）
2. 自动安装依赖并编译 graftcp
3. 自动找到并包装 `language_server_linux_x64`

**优点**：
- 专门针对此场景设计
- 无需修改 Antigravity-Proxy 代码
- 社区持续维护

**注意**：IDE 升级后可能需要重新运行脚本。

---

#### 方案二：WSL Mirrored 网络模式（推荐 ⭐⭐⭐⭐）

**原理**：让 WSL 共享 Windows 的网络栈，从而可以使用 `127.0.0.1` 访问 Windows 上的代理。

**配置步骤**：

1. 在 Windows 用户目录创建或编辑 `.wslconfig` 文件：

```powershell
# PowerShell 执行
notepad "$env:USERPROFILE\.wslconfig"
```

2. 添加以下内容：

```ini
[wsl2]
networkingMode=mirrored
```

3. 重启 WSL：

```powershell
wsl --shutdown
```

4. 在 WSL 中设置环境变量（添加到 `~/.bashrc` 或 `~/.zshrc`）：

```bash
export ALL_PROXY=socks5://127.0.0.1:7890
export HTTPS_PROXY=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890
```

**要求**：
- Windows 11 22H2 或更高版本
- WSL 版本 >= 2.0.0（运行 `wsl --version` 检查）

**优点**：
- 无需安装额外工具
- 配置简单

**缺点**：
- 环境变量方式可能对某些不读取环境变量的程序无效

---

#### 方案三：TUN 模式全局透明代理（推荐 ⭐⭐⭐）

**原理**：使用 Clash/Mihomo 的 TUN 模式创建虚拟网卡，在 IP 层拦截所有流量。

**操作**：在 Clash/Mihomo 中开启 TUN 模式即可。

**优点**：
- 真正的全局代理，覆盖所有应用
- 无需针对单个程序配置

**缺点**：
- 需要管理员权限
- 可能影响系统网络性能
- 与 Antigravity-Proxy 的定位（精准代理）有所重叠

---

### 方案对比

| 方案 | 适用场景 | 复杂度 | 推荐度 |
|------|---------|--------|--------|
| **antissh** | 仅需在 WSL 中代理 Antigravity | 中等 | ⭐⭐⭐⭐⭐ |
| **Mirrored 模式** | 系统满足版本要求，需简单代理 | 低 | ⭐⭐⭐⭐ |
| **TUN 全局代理** | 需要所有流量代理 | 低 | ⭐⭐⭐ |

---

## 🚀 进阶玩法 / Advanced Usage

> 附加价值：本项目首先为 Antigravity 服务，但底层是通用的进程级强制代理方案，也可以用来强制代理其他不走系统代理的 Windows 程序，或基于此二次开发。

### 🎯 强制代理其他程序 / Force Proxy Other Programs

想让 Chrome、VS Code 或其他程序也走代理？只需修改配置文件！

#### 示例 1: 强制代理 Chrome

```json
{
    "proxy": {
        "host": "127.0.0.1",
        "port": 7890,
        "type": "socks5"
    },
    "child_injection": true,
    "target_processes": []
}
```

然后将 `version.dll` 和 `config.json` 复制到 Chrome 安装目录：

```
C:\Program Files\Google\Chrome\Application\
├── chrome.exe
├── version.dll      ← 放这里
└── config.json      ← 放这里
```

#### 示例 2: 强制代理 VS Code

```
C:\Users\你的用户名\AppData\Local\Programs\Microsoft VS Code\
├── Code.exe
├── version.dll      ← 放这里
└── config.json      ← 放这里
```

#### 示例 3: 仅代理特定子进程

如果你只想代理程序的某些子进程，可以使用 `target_processes` 配置：

```json
{
    "target_processes": [
        "node.exe",
        "npm.cmd",
        "language_server.exe"
    ]
}
```

### 🔧 二次开发入口 / Development Entry Points

如果你想基于此项目进行二次开发，以下是关键代码位置：

| 模块 | 文件 | 说明 |
|------|------|------|
| **配置加载** | `src/core/Config.hpp` | 修改配置项结构 |
| **网络 Hook** | `src/hooks/Hooks.cpp` | 添加/修改 Hook 函数 |
| **代理协议** | `src/network/Socks5.hpp` | SOCKS5 握手实现 |
| **代理协议** | `src/network/HttpConnect.hpp` | HTTP CONNECT 实现 |
| **FakeIP** | `src/network/FakeIP.hpp` | 虚拟 IP 分配逻辑 |
| **DLL 劫持** | `src/proxy/VersionProxy.cpp` | version.dll 代理转发 |
| **进程注入** | `src/injection/ProcessInjector.hpp` | 子进程注入逻辑 |

#### 如何添加新的 Hook？

1. 在 `src/hooks/Hooks.cpp` 中定义函数指针类型和 Detour 函数
2. 在 `Hooks::Install()` 中添加 `MH_CreateHookApi()` 调用
3. 在 `Hooks::Uninstall()` 中处理清理逻辑

#### 如何支持新的代理协议？

1. 在 `src/network/` 下创建新的协议实现 (参考 `Socks5.hpp`)
2. 在 `src/hooks/Hooks.cpp` 的 `DoProxyHandshake()` 中添加协议分支

---

## 📄 许可证 / License

本项目基于 [BSD-2-Clause License](LICENSE.txt) 开源。

MinHook 部分版权归 **Tsuda Kageyu** 所有。

---

## 👤 关于作者 / Author

<table>
  <tr>
    <td align="center">
      <b>煎饼果子（86）</b><br/>
      <sub>独立开发者 / Independent Developer</sub>
    </td>
  </tr>
</table>

### 📱 联系方式 / Contact

| 平台 | 信息 |
|------|------|
| **微信** | JavaRookie666 |
| **Telegram** | [@yuaotian](https://t.me/yuaotian) |
| **GitHub** | [@yuaotian](https://github.com/yuaotian) |

### 🎁 支持作者 / Support

如果这个项目对你有帮助，欢迎：
- ⭐ 给项目点个 Star
- 🔗 分享给需要的朋友
- 💬 提交 Issue 或 PR

<table>
  <tr>
    <td align="center">
      <img src="img/wx_add_qr.png" alt="微信二维码" width="200"/><br/>
      <sub>添加微信交流</sub>
    </td>
    <td align="center">
      <img src="img/wx_gzh_qr.jpg" alt="公众号二维码" width="200"/><br/>
      <sub>关注公众号</sub>
    </td>
    <td align="center">
      <img src="img/qun-22.jpg" alt="微信群二维码" width="200"/><br/>
      <sub>🔥 加入微信交流群</sub>
    </td>
  </tr>
</table>

### 💰 打赏支持 / Donate

如果这个项目帮到了你，可以请作者喝杯咖啡 ☕

<table>
  <tr>
    <td align="center">
      <img src="img/wx_zsm.jpg" alt="微信赞赏码" width="200"/><br/>
      <sub>微信赞赏</sub>
    </td>
    <td align="center">
      <img src="img/zfb.png" alt="支付宝收款码" width="200"/><br/>
      <sub>支付宝打赏</sub>
    </td>
  </tr>
</table>

---

## 🔍 伪代码（pseudocode_dll）来源说明 / Pseudocode Source Note

本仓库的 `pseudocode_dll/` 目录收录了**对某论坛帖中发布的 DLL**进行反编译得到的伪代码（Binary Ninja / IDA Hex-Rays 输出），用途仅为：

- 排查我在 **Windows 11** 环境下遇到的 **Antigravity 间歇性崩溃**问题
- 学习/对照其 Hook 与强制代理的实现思路
- 作为研究记录留档（便于后续回溯）

> ⚠️ 重要声明  
> - `pseudocode_dll/` **不参与**本项目的构建与发布，只是学习与研究记录。  
> - 本项目当前代码为我**从零实现与持续维护**的版本，并非“原 DLL 的源码开源”。  
> - 本仓库**不分发**原帖中的成品 DLL；如需获取原始 DLL，请前往原帖。  
> - 若原帖作者认为该伪代码公开不合适、希望移除相关内容，请在仓库提 Issue，我会第一时间配合调整（移动到单独分支/移除/重写说明均可）。

**来源（原帖含 DLL）：**  
https://linux.do/t/topic/1189424

**本仓库伪代码文件：**
- `pseudocode_dll/BinaryNinja.txt`（Binary Ninja 反编译输出）
- `pseudocode_dll/Hex-Rays.txt`（IDA Hex-Rays 反编译输出）

---

<p align="center">
  <sub>Made with ❤️ by 煎饼果子（86）</sub>
</p>
