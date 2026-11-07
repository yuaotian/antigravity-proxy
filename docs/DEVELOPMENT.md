# Antigravity-Proxy 开发文档

## 📜 项目开发历程

### 2026-01-07: 项目重构 (Scheme B)
- **目标**: 基于现有 MinHook 框架，现代化重构代理注入逻辑
- **决策**: 
  - 放弃 1:1 复刻伪代码方案
  - 采用现代 C++ (C++17) 重写
  - 使用 JSON 配置替代原有的 INI 格式
- **产出**: 
  - 核心模块: `Config.hpp`, `Logger.hpp`
  - 网络模块: `SocketWrapper.hpp`, `FakeIP.hpp`
  - Hook 模块: `Hooks.cpp`

---

## 🏗️ 架构设计说明

### 设计原则
本项目严格遵循以下设计原则:

| 原则 | 应用 |
|------|------|
| **KISS** | 保持简单的网络重定向逻辑，不引入复杂的异步框架 |
| **YAGNI** | 仅实现当前需要的功能，不做过度设计 |
| **SOLID/SRP** | 分离配置 (Config)、日志 (Logger)、网络 (Network)、Hook (Hooks) 职责 |

### 模块架构

```
┌─────────────────────────────────────────────────────────────┐
│                      DLL Entry (main.cpp)                    │
│  - 加载配置                                                   │
│  - 初始化日志                                                 │
│  - 安装 Hooks                                                │
└─────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
   │ Core Module  │   │Network Module│   │ Hooks Module │
   │ - Config     │   │ - Socket     │   │ - connect()  │
   │ - Logger     │   │ - FakeIP     │   │ - getaddrinfo│
   └──────────────┘   └──────────────┘   └──────────────┘
```

### 错误处理策略
- **Fail-Safe**: 配置加载失败或 Hook 失败时，不崩溃，仅记录日志并让目标程序继续运行

---

## 🔑 重要技术决策

### 1. 选择 MinHook 作为 Hook 引擎
**原因**:
- 轻量级，无外部依赖
- 支持 x86 和 x64
- 稳定性高，广泛使用

### 2. 使用 nlohmann/json 作为 JSON 库
**原因**:
- 单头文件，易于集成
- 现代 C++ 风格
- 异常安全

### 3. 放弃跨平台支持
**原因**:
- MinHook 仅支持 Windows
- Winsock API 为 Windows 特有
- 跨平台需要大量重构，不符合当前需求优先级

---

## 📋 待改进项

- [x] 完整 SOCKS5 握手（含错误码/响应解析）
- [x] HTTP CONNECT 代理隧道
- [x] 路由匹配（域名/IP/CIDR/端口/协议）
- [ ] 配置热重载功能（按需评估，避免破坏稳定性）
- [ ] 持续性能优化（锁竞争、热路径日志 I/O、握手超时预算）

---

## 📚 参考资料

- [MinHook GitHub](https://github.com/TsudaKageyu/minhook)
- [nlohmann/json](https://github.com/nlohmann/json)
- [Winsock2 Documentation](https://docs.microsoft.com/en-us/windows/win32/winsock/windows-sockets-start-page-2)

<!-- 以下章节自 README 迁移 -->

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

# 构建并运行 CTest（CI/Release 使用）
.\build.ps1 -RunTests

# 显式声明跳过测试（也是默认行为）
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

## 🔧 二次开发入口 / Development Entry Points

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
