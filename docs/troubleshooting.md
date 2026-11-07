# 故障排查手册

> 内容自 README 迁移。建议先运行 `doctor.ps1` 体检（见 [doctor.md](doctor.md)），它已自动化下面大部分检查；
> 对话报错 `User location is not supported` 时先看 [agent-ip-diagnosis.md](agent-ip-diagnosis.md)（多数是出口 IP 问题）。

## 常用代理软件端口

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

### 如何确认代理端口是否开启？

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

### 常见端口问题及解决

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| 端口被占用 | 其他程序使用了该端口 | `netstat -ano | findstr :7890` 查找占用进程 |
| 连接被拒绝 | 代理软件未启动或端口错误 | 确认代理软件已启动，检查端口配置 |
| 代理无响应 | 防火墙阻止 | 检查 Windows 防火墙设置 |

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
| `非 SOCK_STREAM socket 直连, soType=2` | UDP 有效策略为 direct，或该端口未命中代理规则 | ⚠️ 视配置而定 |
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

### 验证是否生效 / Verification

1. **检查日志**: 查看是否生成日志文件（格式：`proxy-YYYYMMDD.log`）
2. **查看代理软件**: 观察代理软件的连接日志
3. **使用抓包工具**: 使用 Wireshark 确认流量走向

#### 📂 日志文件位置 / Log File Locations

日志文件按以下优先级存放：

| 优先级 | 位置 | 说明 |
|--------|------|------|
| 1️⃣ | `<DLL所在目录>\logs\` | 与代理主体 DLL 同级的 `logs` 子目录 |
| 2️⃣ | `%TEMP%\antigravity-proxy-logs\` | 系统临时目录（通常为 `C:\Users\<用户名>\AppData\Local\Temp\antigravity-proxy-logs\`） |

> 💡 **提示**：如果在 DLL 目录无法创建 `logs` 文件夹（例如权限不足），日志会自动回退到系统 TEMP 目录。
>
> 快速打开 TEMP 目录：按 `Win+R`，输入 `%TEMP%`，回车即可。

### 📊 第四步：收集信息提交 Issue

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
| **大量 `非 SOCK_STREAM socket 直连, soType=2`** | UDP/QUIC 有效策略为 direct，或 UDP 代理未生效 | 优先使用 `udp_mode=auto` + `proxy.type=socks5`，并确认代理端支持 SOCKS5 UDP Associate |
| **日志显示成功但网页打不开** | Clash 规则、节点问题 | 检查 Clash 日志 |
| **某些请求绕过代理** | 应用使用了未 Hook 的 API | 提交 Issue 反馈 |
| **360 等安全软件环境下失效** | LSP 注入干扰 | 添加白名单或卸载 |

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
