# WSL 环境使用指南

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
