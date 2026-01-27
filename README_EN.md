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
- [🔧 Troubleshooting Guide](#-troubleshooting-guide)
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

## 🔧 Troubleshooting Guide

> Proxy not working? Follow this guide to diagnose and fix the issue.

### 📋 Quick Diagnostic Flowchart

```
Proxy not working?
    │
    ├── Check if log file exists ─────────────────────────────────┐
    │       │                                               │
    │       ├── ❌ No log → DLL not loaded / wrong location    │
    │       │       └── See "DLL Loading Issues"              │
    │       │                                               │
    │       └── ✅ Has log → Check log contents              │
    │               │                                       │
    ├── Does log contain "SOCKS5: Tunnel established"? ──────┤
    │       │                                               │
    │       ├── ❌ No → Proxy connection failed              │
    │       │       └── See "Proxy Software Check"           │
    │       │                                               │
    │       └── ✅ Yes → Tunnel ok, issue is downstream      │
    │               │                                       │
    └── Check Clash logs and node availability ───────────────┘
```

---

### 🔍 Step 1: Check Log Files

Logs are your first source of debugging information.

**Log Locations** (by priority):
1. `<Antigravity Install Dir>\logs\proxy-YYYYMMDD.log`
2. `%TEMP%\antigravity-proxy-logs\proxy-YYYYMMDD.log`

**Quick Access**:
```powershell
# Open logs folder in DLL directory
cd "$env:LOCALAPPDATA\Programs\Antigravity\logs"

# Or open TEMP directory
cd "$env:TEMP\antigravity-proxy-logs"
```

**Key Log Lines Explained**:

| Log Content | Meaning | Status |
|-------------|---------|--------|
| `Antigravity-Proxy DLL loaded` | DLL successfully injected | ✅ OK |
| `Config loaded successfully` | config.json read OK | ✅ OK |
| `All API Hooks installed` | Hooks are active | ✅ OK |
| `ConnectEx Hook installed` | Async connect hooked | ✅ OK |
| `SOCKS5: Tunnel established` | Proxy connection OK | ✅ OK |
| `Non-SOCK_STREAM socket direct, soType=2` | UDP traffic skipped (normal) | ⚠️ Expected |
| `SOCKS5 handshake failed` | Proxy handshake failed | ❌ Check |
| `Failed to connect proxy` | Cannot connect to proxy | ❌ Check |
| `WSA Error=10061` | Connection refused (proxy not running) | ❌ Check |
| `WSA Error=10060` | Connection timeout | ❌ Check |

---

### 🌐 Step 2: Proxy Software Check

#### 2.1 Verify Proxy Port is Open

```powershell
# Test SOCKS5/mixed port
Test-NetConnection -ComputerName 127.0.0.1 -Port 7890

# If TcpTestSucceeded: False, port is not listening
```

#### 2.2 Verify Clash Configuration

Check in Clash config file:

```yaml
# Must enable mixed or SOCKS5 port
mixed-port: 7890     # Mixed port (recommended)
# Or
port: 7890           # HTTP port
socks-port: 7891     # SOCKS5 port

# If LAN access is needed
allow-lan: true
```

#### 2.3 Check Clash Logs

In Clash UI, check "Logs" to confirm:
- Requests from `daily-cloudcode-pa.googleapis.com`, `www.googleapis.com`
- Whether requests go `DIRECT` or through proxy node
- Whether any `REJECT` rules matched

#### 2.4 Test Node Availability

Simplest method: Enable **TUN mode**. If Antigravity works in TUN mode, your proxy node is fine.

---

### 💻 Step 3: System Environment Check

#### 3.1 Check Windows Version

```powershell
winver
```

Different Windows 11 builds may have different Winsock behaviors.

#### 3.2 Check Winsock LSP Configuration

Some security software injects LSP (Layered Service Providers), which may interfere with hooks.

```powershell
# Run as Administrator
netsh winsock show catalog
```

Normally you should only see Microsoft providers. Third-party providers (from 360, Huorong, etc.) may cause compatibility issues.

#### 3.3 Check Security Software

These may interfere with DLL injection or hooks:

| Software | Possible Impact | Solution |
|----------|----------------|----------|
| **360 Security** | Blocks DLL injection, hooks | Add to whitelist or disable temporarily |
| **Huorong** | May block remote thread injection | Add to whitelist |
| **Tencent PC Manager** | LSP injection may interfere | Add to whitelist |
| **Windows Defender** | Usually no interference | No action needed |

**Troubleshooting tip**: Try completely exiting security software (not just minimizing to tray).

#### 3.4 Check IPv6 Configuration

If IPv6 is enabled, some connections may prefer IPv6:

```powershell
# Check network adapter IPv6 status
Get-NetAdapterBinding -ComponentID ms_tcpip6
```

If logs show many IPv6-related entries, try setting in `config.json`:

```json
"proxy_rules": {
    "ipv6_mode": "block"
}
```

---

### 🔄 Step 4: Comparison Check

If your environment works but a friend's doesn't, compare these:

| Item | Your Value | Their Value |
|------|------------|-------------|
| Windows version (winver) | | |
| Clash version | | |
| Proxy port | 7890 | |
| Proxy type | socks5 | |
| Security software installed | | |
| `netsh winsock show catalog` line count | | |

---

### 📊 Step 5: Collect Info for GitHub Issue

If the above steps don't resolve your issue, collect this info and submit a [GitHub Issue](https://github.com/yuaotian/antigravity-proxy/issues):

1. **Log file**: Complete `proxy-YYYYMMDD.log` contents
2. **config.json**: Your config file (hide sensitive info)
3. **Windows version**: `winver` output
4. **Clash version and config** (port settings)
5. **Security software list**: Installed antivirus/security software
6. **Problem description**: What exactly doesn't work? What site/feature fails?

---

### ⚠️ Known Compatibility Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| **Many `Non-SOCK_STREAM socket direct, soType=2`** | UDP/QUIC traffic skipped (normal) | No action needed, SOCKS5 only proxies TCP |
| **Log shows success but pages won't load** | Clash rules, node issues | Check Clash logs |
| **Some requests bypass proxy** | App uses un-hooked APIs | Submit Issue for feedback |
| **Fails with 360 and similar security software** | LSP injection interference | Add to whitelist or uninstall |

---

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
│    getaddrinfo("example.com") → Allocate FakeIP (198.18.x.x) → Save map   │
└─────────────────────────────────────────────────────────────────────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 4. Connection Redirect                                                   │
│    connect(198.18.x.x) → Lookup mapping → Connect to proxy → SOCKS5 shake │
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
        "cidr": "198.18.0.0/15"
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
| `fake_ip.cidr` | string | `"198.18.0.0/15"` | FakeIP address range (benchmarking reserved) |
| `timeout.connect` | int | `5000` | Connection timeout (ms) |
| `timeout.send` | int | `5000` | Send timeout (ms) |
| `timeout.recv` | int | `5000` | Receive timeout (ms) |
| `child_injection` | bool | `true` | Inject into child processes |
| `traffic_logging` | bool | `false` | Enable traffic logging |
| `target_processes` | array | `[]` | Target process list (empty = all) |
| `proxy_rules.routing.enabled` | bool | `true` | Enable rule-based routing |
| `proxy_rules.routing.priority_mode` | string | `"order"` | Priority: `order`(list order) / `number`(priority) |
| `proxy_rules.routing.default_action` | string | `"proxy"` | Default action when no rule matches |
| `proxy_rules.routing.use_default_private` | bool | `true` | Auto-load RFC1918/loopback direct rules |
| `proxy_rules.routing.rules` | array | `[]` | Rule list (CIDR / wildcard domain / port / protocol) |

### Routing Rules

Routing rules live under `proxy_rules.routing`. They support CIDR, wildcard domains, ports, and protocol filters. Priority can be `order` (list order) or `number` (priority).

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
          "ports": ["445","3389","10000-20000"],
          "protocols": ["tcp"]
        }
      ]
    }
  }
}
```

**Config tool**: `tools/config-web/index.html` (open locally to import/edit/export `config.json`).

**Note**: `AUTHORS.txt` lists contributors of the bundled MinHook dependency, not this project’s maintainers.

**Notes**:
- Leave ports empty to match all ports. Leave domains empty to match CIDR only. `*` matches all domains.
- Use `0.0.0.0/0` and `::/0` for full match.
- The tool supports editing `proxy.host` / `proxy.port` / `proxy.type`.


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
| **Telegram** | [@yuaotian](https://t.me/yuaotian) |
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
    <td align="center">
      <img src="img/qun-21.png" alt="WeChat Group QR Code" width="200"/><br/>
      <sub>🔥 Join WeChat Group</sub>
    </td>
  </tr>
</table>

### 💰 Donate

If this project helped you, consider buying the author a coffee ☕

<table>
  <tr>
    <td align="center">
      <img src="img/wx_zsm.jpg" alt="WeChat Reward" width="200"/><br/>
      <sub>WeChat Reward</sub>
    </td>
    <td align="center">
      <img src="img/zfb.png" alt="Alipay" width="200"/><br/>
      <sub>Alipay</sub>
    </td>
  </tr>
</table>

### 💳 Cryptocurrency

For international supporters, crypto donations are also welcome:

<details>
<summary><b>🪙 View Crypto Addresses (Click to expand)</b></summary>

#### 1️⃣ USDT (Tether) & Stablecoins

| Network | Address |
|---------|---------|
| 🔴 **TRC-20 (Tron)** | `TFbJNoY5Lep5ZrDwBbT8rV1i8xR4ZhX53k` |
| 🟡 **Polygon / BSC / Arbitrum** 🔥 *Cheapest Fees* | `0x44f8925b9f93b3d6da8d5ad26a3516e3e652cc88` |

> *The EVM address supports USDT on Polygon, BSC, and Arbitrum One*

#### 2️⃣ Litecoin (LTC) ✅ Low Fees

| Network | Address |
|---------|---------|
| 🔵 **Litecoin** | `LVrigKxtWfPymMRtRqL3z2eZxfncR3dPV7` |

</details>

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
