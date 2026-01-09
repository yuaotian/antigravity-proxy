<p align="center">
  <img src="img/antigravity_logo.png" alt="Antigravity Logo" width="120"/>
</p>

<h1 align="center">Antigravity-Proxy</h1>

<p align="center">
  <b>🚀 Built for the Antigravity editor: use proxy without TUN mode (especially useful in China)</b>
</p>

<p align="center">
  <a href="https://github.com/yuaotian/antigravity-proxy/actions"><img src="https://github.com/yuaotian/antigravity-proxy/actions/workflows/build.yml/badge.svg" alt="Build Status"/></a>
  <a href="LICENSE.txt"><img src="https://img.shields.io/badge/license-BSD--2--Clause-blue.svg" alt="License"/></a>
  <img src="https://img.shields.io/badge/platform-Windows%20x86%20%7C%20x64-lightgrey.svg" alt="Platform"/>
  <img src="https://img.shields.io/badge/C%2B%2B-17-00599C.svg" alt="C++17"/>
  <img src="https://img.shields.io/badge/hook-MinHook-orange.svg" alt="MinHook"/>
</p>

<p align="center">
  <a href="README.md">🇨🇳 中文版</a>
</p>

---

## 📖 Table of Contents

- [📖 Introduction](#-introduction)
- [⚡ Antigravity Quick Start](#-antigravity-quick-start)
- [✨ Features](#-features)
- [🔧 How It Works](#-how-it-works)
- [🛠️ Build](#️-build)
- [📝 Usage](#-usage)
- [🚀 Advanced Usage](#-advanced-usage)
- [📄 License](#-license)
- [👤 Author](#-author)

---

## ⚠️ Environment Requirements

> Before using this tool, ensure the required runtime libraries are installed, otherwise the target application may fail to start.

### Common Issue: Error 0xc0000142

If you encounter **error code 0xc0000142** when launching the program (as shown below), it's usually caused by missing Windows runtime libraries.

<p align="center">
  <img src="img/error/win_error_0xc0000142.png" alt="0xc0000142 Error Screenshot" width="400"/>
</p>

### Solution

Please install the **Microsoft Visual C++ Runtime Pack**, which is included in this repository:

📦 **Download Path**: [`microsoft\微软常用运行库合集-2025.exe`](microsoft/微软常用运行库合集-2025.exe)

**Installation Steps:**
1. Navigate to the `microsoft` folder in this repository
2. Run `微软常用运行库合集-2025.exe`
3. Follow the installation wizard
4. Restart the target application


---
## 📖 Introduction

**Antigravity-Proxy** is a Windows proxy injection module built specifically for the **Antigravity editor**.

The goal is simple: help users (especially in China) use Antigravity **without enabling Clash TUN mode**, while still sending Antigravity’s traffic through your SOCKS5/HTTP proxy.

> Name note: **Antigravity-Proxy** = Antigravity + Proxy — it pulls only Antigravity-related processes into the proxy (not a global system takeover).

### 🎯 Problem Solved

Have you ever encountered these situations?

- 🔴 Antigravity **doesn't respect system proxy** in some environments, forcing you to enable Clash TUN mode
- 🔴 TUN mode proxies **all traffic globally**, affecting local development
- 🔴 TUN mode requires **administrator privileges**, which some environments don't allow

**Antigravity-Proxy comes to the rescue!** It can:

- ✅ **Proxy only specified applications** (primarily Antigravity-related), without affecting other traffic
- ✅ **No TUN mode required**, avoiding a global proxy takeover
- ✅ **Transparent proxy**, target applications are completely unaware

### 🌟 Core Value

| Traditional Approach | Antigravity-Proxy |
|---------------------|-------------------|
| Requires TUN mode | No TUN needed |
| Global proxy | Precise per-process proxy |
| Needs admin privileges | Regular user is fine |
| Complex configuration | Just drop in the DLL |

---

## ⚡ Antigravity Quick Start

> If you only care about getting Antigravity working right now, this is the shortest path.

### Step 1: Prepare a Proxy

Start your proxy client (e.g. Clash/Mihomo) and make sure you have a local SOCKS5 or HTTP proxy endpoint (e.g. `127.0.0.1:7890`).

<details>
<summary><b>📋 Common Proxy Software Port Reference (Click to expand)</b></summary>

#### Default Ports for Popular Proxy Clients

| Proxy Software | SOCKS5 Port | HTTP Port | Mixed Port | Notes |
|----------------|-------------|-----------|------------|-------|
| **Clash / Clash Verge** | 7891 | 7890 | 7890 | Mixed port supports both SOCKS5 and HTTP |
| **Clash for Windows** | 7891 | 7890 | 7890 | Settings → Ports to view/modify |
| **Mihomo (Clash Meta)** | 7891 | 7890 | 7890 | Same as Clash config format |
| **V2RayN** | 10808 | 10809 | - | Settings → Basic Settings → Core |
| **V2RayA** | 20170 | 20171 | - | Configurable in admin panel |
| **Shadowsocks** | 1080 | - | - | SOCKS5 only, no HTTP |
| **ShadowsocksR** | 1080 | - | - | SOCKS5 only, no HTTP |
| **Surge (Mac/iOS)** | 6153 | 6152 | - | Ports may differ in enhanced mode |
| **Qv2ray** | 1089 | 8889 | - | Preferences → Inbound Settings |
| **sing-box** | Custom | Custom | Custom | Must be manually specified in config |
| **NekoBox** | 2080 | 2081 | - | Settings → Inbound |
| **Clash Meta for Android** | 7891 | 7890 | 7890 | Same as Clash rules |

> 💡 **SOCKS5 is recommended**: This tool has better support for SOCKS5, so use it when possible.

#### How to Verify Your Proxy Port is Open?

**Method 1: Check Proxy Software UI**
- Most proxy clients display the listening port on the main interface or in settings

**Method 2: PowerShell Test**
```powershell
# Test SOCKS5 port (default 7891)
Test-NetConnection -ComputerName 127.0.0.1 -Port 7891

# Test HTTP port (default 7890)
Test-NetConnection -ComputerName 127.0.0.1 -Port 7890
```

**Method 3: curl Test (requires curl)**
```bash
# Test via SOCKS5 proxy
curl -x socks5://127.0.0.1:7891 https://www.google.com -I

# Test via HTTP proxy
curl -x http://127.0.0.1:7890 https://www.google.com -I
```

#### Common Port Issues and Solutions

| Problem | Cause | Solution |
|---------|-------|----------|
| Port in use | Another program is using the port | `netstat -ano | findstr :7890` to find the process |
| Connection refused | Proxy not running or wrong port | Confirm proxy is running, check port config |
| No response | Firewall blocking | Check Windows Firewall settings |

</details>

### Step 2: Get the Files

You need two files:
- `version.dll`
- `config.json`

(Download from Releases, or build them yourself.)

### Step 3: Deploy to Antigravity

Copy `version.dll` and `config.json` to Antigravity’s main program directory (next to `Antigravity.exe`). Then launch Antigravity — done.

#### Common Windows Path + Quick Jump

In most cases, Antigravity is installed at:

`C:\Users\<username>\AppData\Local\Programs\Antigravity\`

Example: `C:\Users\yuaotian\AppData\Local\Programs\Antigravity`

If you can’t find the folder: locate the Antigravity shortcut (Desktop/Start Menu), **right-click → Open file location** — that folder is Antigravity’s main directory.

Quick jump from terminal:

```powershell
cd "$env:LOCALAPPDATA\Programs\Antigravity"
```

```bat
cd /d "%LOCALAPPDATA%\Programs\Antigravity"
```

(Optional) Set a custom env var so you can jump there anytime:

```bat
setx ANTIGRAVITY_HOME "%LOCALAPPDATA%\Programs\Antigravity"
```

After that: PowerShell `cd $env:ANTIGRAVITY_HOME`, CMD `cd /d %ANTIGRAVITY_HOME%`.

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔀 **Proxy Redirect** | Intercepts `connect()` calls and redirects to proxy server |
| 🌐 **FakeIP System** | Intercepts DNS resolution, allocates virtual IPs and maintains mapping |
| 👶 **Child Injection** | Automatically injects DLL into child processes |
| ⏱️ **Timeout Control** | Prevents target application from hanging on network issues |
| 🔄 **Fail-Safe** | Falls back to direct connection on configuration error |
| 🎯 **Process Filter** | Proxy only specified process list |
| 📊 **Traffic Monitor** | Optional traffic logging |

### Supported Protocols

- ✅ SOCKS5 (Recommended)
- ✅ HTTP CONNECT

---

## 🔧 How It Works

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Target Process                                 │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────────┐   │
│  │  App Code    │───►│ Winsock API  │───►│  antigravity-proxy.dll   │   │
│  │              │    │ (ws2_32.dll) │    │  (Hook Layer)            │   │
│  └──────────────┘    └──────────────┘    └────────────┬─────────────┘   │
│                                                       │                  │
└───────────────────────────────────────────────────────│──────────────────┘
                                                        ▼
                                              ┌──────────────────┐
                                              │   Proxy Server   │
                                              │  (SOCKS5/HTTP)   │
                                              └──────────────────┘
```

### Core Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. DLL Hijacking                                                         │
│    Program loads version.dll → Loads our DLL → Forwards real calls      │
└─────────────────────────────────────────────────────────────────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 2. Install API Hooks                                                     │
│    Uses MinHook to intercept: connect, getaddrinfo, CreateProcessW, etc │
└─────────────────────────────────────────────────────────────────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 3. DNS Interception                                                      │
│    getaddrinfo("example.com") → Allocate FakeIP (10.0.0.x) → Save map   │
└─────────────────────────────────────────────────────────────────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 4. Connection Redirect                                                   │
│    connect(10.0.0.x) → Lookup mapping → Connect to proxy → SOCKS5 shake │
└─────────────────────────────────────────────────────────────────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 5. Child Process Propagation                                             │
│    CreateProcessW → Suspend process → Inject DLL → Resume                │
└─────────────────────────────────────────────────────────────────────────┘
```

### Hooked APIs

| API | Module | Purpose |
|-----|--------|---------|
| `connect` | ws2_32.dll | Intercept TCP connections |
| `WSAConnect` | ws2_32.dll | Intercept WSA connections |
| `getaddrinfo` | ws2_32.dll | Intercept DNS resolution (ANSI) |
| `GetAddrInfoW` | ws2_32.dll | Intercept DNS resolution (Unicode) |
| `WSAConnectByNameA/W` | ws2_32.dll | Intercept connect-by-name |
| `ConnectEx` | ws2_32.dll | Intercept async connections |
| `CreateProcessW` | kernel32.dll | Intercept process creation for injection |
| `send/recv` | ws2_32.dll | Traffic monitoring (optional) |

---

## 🛠️ Build

### Prerequisites

Before building, make sure you have the following tools installed:

| Dependency | Version | Purpose | Download |
|------------|---------|---------|----------|
| **Visual Studio 2022** | 2022 or later | C/C++ Compiler | [Download](https://visualstudio.microsoft.com/) |
| **CMake** | >= 3.0 | Build System | [Download](https://cmake.org/download/) |
| **PowerShell** | 5.0+ | Build Script | Built-in on Windows |

> 💡 **Tip**: When installing Visual Studio, make sure to check the **"Desktop development with C++"** workload.

### Dependencies

| Dependency | Description | How to Get |
|------------|-------------|------------|
| **MinHook** | API Hook framework | Included in project |
| **nlohmann/json** | JSON parsing library | Auto-downloaded by build script |

### Quick Build

The project provides a PowerShell build script for one-click building:

```powershell
# Default build: Release x64
.\build.ps1

# Build Debug version
.\build.ps1 -Config Debug

# Build 32-bit version
.\build.ps1 -Arch x86

# Clean and rebuild
.\build.ps1 -Clean

# Show help
.\build.ps1 -Help
```

### Manual Build

If you prefer manual building, use these commands:

```bash
# ========== x64 (64-bit) ==========
mkdir build-x64 && cd build-x64

# Configure (using Visual Studio 2022)
cmake .. -G "Visual Studio 17 2022" -A x64

# Build Release
cmake --build . --config Release

# Output: version.dll


# ========== x86 (32-bit) ==========
mkdir build-x86 && cd build-x86

# Configure
cmake .. -G "Visual Studio 17 2022" -A Win32

# Build
cmake --build . --config Release

# Output: version.dll
```

### Common Build Errors

<details>
<summary><b>❌ Error: "CMake not found"</b></summary>

**Cause**: CMake is not installed or not in PATH

**Solution**:
1. Download and install [CMake](https://cmake.org/download/)
2. Check "Add CMake to the system PATH" during installation
3. Restart terminal and retry
</details>

<details>
<summary><b>❌ Error: "No CMAKE_CXX_COMPILER could be found"</b></summary>

**Cause**: Visual Studio not installed or C++ toolchain missing

**Solution**:
1. Open Visual Studio Installer
2. Make sure **"Desktop development with C++"** workload is installed
3. Or run build commands from Developer Command Prompt
</details>

<details>
<summary><b>❌ Error: nlohmann/json.hpp not found</b></summary>

**Cause**: JSON library not downloaded

**Solution**:
Using `build.ps1` will auto-download, or manually download:
```bash
# Manual download
curl -o include/nlohmann/json.hpp https://raw.githubusercontent.com/nlohmann/json/develop/single_include/nlohmann/json.hpp
```
</details>

<details>
<summary><b>❌ Error: LNK2019 unresolved external symbol</b></summary>

**Cause**: Linker error, usually Winsock library not linked

**Solution**:
Make sure CMakeLists.txt includes:
```cmake
target_link_libraries(version PRIVATE ws2_32)
```
</details>

## ❓ Common Errors and Error Codes

> When issues occur, first confirm the target app architecture (x86/x64) and check logs (e.g. `proxy-YYYYMMDD.log`).

| Error Code | Description | Possible Cause | Solution |
|-----------|-------------|----------------|----------|
| `VCRUNTIME140_1.dll missing` | System error: \"VCRUNTIME140_1.dll was not found\" | VC++ 2015-2022 runtime not installed or removed by security software | Install VC++ 2015-2022 Redistributable (x64/x86)<br>Or build with static runtime: `.\build.ps1 -StaticRuntime` |

---

## 📝 Usage

### Quick Start

**Just 3 steps to make your target application use proxy!**

#### Step 1: Prepare Files

After building, you'll get these files in the `output` directory:
- `version.dll` - Proxy DLL
- `config.json` - Configuration file

#### Step 2: Configure Proxy

Edit `config.json`:

```json
{
    "proxy": {
        "host": "127.0.0.1",
        "port": 7890,
        "type": "socks5"
    },
    "fake_ip": {
        "enabled": true,
        "cidr": "10.0.0.0/8"
    },
    "timeout": {
        "connect": 5000,
        "send": 5000,
        "recv": 5000
    },
    "child_injection": true,
    "target_processes": []
}
```

#### Step 3: Deploy DLL

Copy `version.dll` and `config.json` to the **same directory** as the target application:

```
Target Application Directory/
├── target_app.exe
├── version.dll      ← Put here
└── config.json      ← Put here
```

Launch the target application, done! 🎉

### Configuration Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `proxy.host` | string | `"127.0.0.1"` | Proxy server address |
| `proxy.port` | int | `7890` | Proxy server port |
| `proxy.type` | string | `"socks5"` | Proxy type: `socks5` or `http` |
| `fake_ip.enabled` | bool | `true` | Enable FakeIP system |
| `fake_ip.cidr` | string | `"10.0.0.0/8"` | FakeIP address range |
| `timeout.connect` | int | `5000` | Connection timeout (ms) |
| `timeout.send` | int | `5000` | Send timeout (ms) |
| `timeout.recv` | int | `5000` | Receive timeout (ms) |
| `child_injection` | bool | `true` | Inject into child processes |
| `traffic_logging` | bool | `false` | Enable traffic logging |
| `target_processes` | array | `[]` | Target process list (empty = all) |

### Verification

1. **Check logs**: Look for `proxy.log` in the target application directory
2. **Check proxy software**: Observe connection logs in your proxy software
3. **Use packet capture**: Use Wireshark to confirm traffic direction

---

## 🚀 Advanced Usage

> Extra value: while this project is primarily built for Antigravity, the underlying technique is generic and can be adapted to other Windows applications that ignore system proxy.

### 🎯 Force Proxy Other Programs

Want Chrome, VS Code, or other programs to use proxy? Just modify the configuration!

#### Example 1: Force Proxy Chrome

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

Then copy `version.dll` and `config.json` to Chrome's installation directory:

```
C:\Program Files\Google\Chrome\Application\
├── chrome.exe
├── version.dll      ← Put here
└── config.json      ← Put here
```

#### Example 2: Force Proxy VS Code

```
C:\Users\YourUsername\AppData\Local\Programs\Microsoft VS Code\
├── Code.exe
├── version.dll      ← Put here
└── config.json      ← Put here
```

#### Example 3: Proxy Only Specific Child Processes

If you only want to proxy certain child processes, use the `target_processes` configuration:

```json
{
    "target_processes": [
        "node.exe",
        "npm.cmd",
        "language_server.exe"
    ]
}
```

### 🔧 Development Entry Points

If you want to do secondary development based on this project, here are the key code locations:

| Module | File | Description |
|--------|------|-------------|
| **Configuration** | `src/core/Config.hpp` | Modify config structure |
| **Network Hooks** | `src/hooks/Hooks.cpp` | Add/modify hook functions |
| **SOCKS5 Protocol** | `src/network/Socks5.hpp` | SOCKS5 handshake implementation |
| **HTTP Protocol** | `src/network/HttpConnect.hpp` | HTTP CONNECT implementation |
| **FakeIP** | `src/network/FakeIP.hpp` | Virtual IP allocation logic |
| **DLL Hijacking** | `src/proxy/VersionProxy.cpp` | version.dll proxy forwarding |
| **Process Injection** | `src/injection/ProcessInjector.hpp` | Child process injection logic |

#### How to Add a New Hook?

1. Define function pointer type and Detour function in `src/hooks/Hooks.cpp`
2. Add `MH_CreateHookApi()` call in `Hooks::Install()`
3. Handle cleanup in `Hooks::Uninstall()`

#### How to Support a New Proxy Protocol?

1. Create new protocol implementation in `src/network/` (refer to `Socks5.hpp`)
2. Add protocol branch in `DoProxyHandshake()` in `src/hooks/Hooks.cpp`

---

## 📄 License

This project is open-sourced under the [BSD-2-Clause License](LICENSE.txt).

MinHook portion is copyrighted by **Tsuda Kageyu**.

---

## 👤 Author

<table>
  <tr>
    <td align="center">
      <b>煎饼果子（86）</b><br/>
      <sub>Independent Developer</sub>
    </td>
  </tr>
</table>

### 📱 Contact

| Platform | Info |
|----------|------|
| **WeChat** | JavaRookie666 |
| **GitHub** | [@yuaotian](https://github.com/yuaotian) |

### 🎁 Support

If this project helps you, feel free to:
- ⭐ Star this project
- 🔗 Share with friends who need it
- 💬 Submit Issues or PRs

<table>
  <tr>
    <td align="center">
      <img src="img/wx_add_qr.png" alt="WeChat QR Code" width="200"/><br/>
      <sub>Add WeChat</sub>
    </td>
    <td align="center">
      <img src="img/wx_gzh_qr.jpg" alt="Official Account QR Code" width="200"/><br/>
      <sub>Follow Official Account</sub>
    </td>
  </tr>
</table>

---

## 🔍 Pseudocode Source Note / 伪代码（pseudocode_dll）来源说明

The `pseudocode_dll/` directory in this repository contains pseudocode obtained by decompiling a **DLL published in a forum post** (Binary Ninja / IDA Hex-Rays output). Its purposes are solely:

- To investigate the **intermittent Antigravity crashes** I encountered on **Windows 11**.
- To study/compare its Hook and forced proxy implementation approach.
- As a research record (for future reference).

> ⚠️ Important Disclaimer
> - `pseudocode_dll/` is **NOT involved** in the build or release of this project; it is merely a record of learning and research.
> - The current code of this project is a version **implemented from scratch and continuously maintained** by me, NOT "open sourcing the original DLL".
> - This repository **does NOT distribute** the finished DLL from the original post; please visit the original thread to obtain the original DLL.
> - If the original author believes that analyzing/publishing this pseudocode is inappropriate and wishes for its removal, please file an Issue, and I will cooperate immediately (move to a separate branch/remove/rewrite description).

**Source (Original Post containing DLL):**
https://linux.do/t/topic/1189424

**Pseudocode Files in this Repo:**
- `pseudocode_dll/BinaryNinja.txt` (Binary Ninja Decompilation Output)
- `pseudocode_dll/Hex-Rays.txt` (IDA Hex-Rays Decompilation Output)

---

<p align="center">
  <sub>Made with ❤️ by 煎饼果子（86）</sub>
</p>
