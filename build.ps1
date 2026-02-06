# ============================================================
#  Antigravity-Proxy 编译脚本
#  PowerShell Build Script for Windows
# ============================================================
# 使用方法:
#   .\build.ps1              # 默认 Release x64 编译
#   .\build.ps1 -Config Debug
#   .\build.ps1 -Arch x86
#   .\build.ps1 -Config Debug -Arch x86
# ============================================================

param(
    [ValidateSet("Release", "Debug")]
    [string]$Config = "Release",
    
    [ValidateSet("x64", "x86")]
    [string]$Arch = "x64",
    
    [switch]$StaticRuntime,
    [switch]$DynamicRuntime,
    [switch]$Clean,
    [switch]$Help
)

# ============================================================
# 版本信息 (在此处统一管理版本号)
# ============================================================
$Version = "1.7"

# ============================================================
# 辅助函数
# ============================================================

function Write-Header {
    param([string]$Message)
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "  $Message" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan
}

function Write-Step {
    param([string]$Message)
    Write-Host "[*] $Message" -ForegroundColor Yellow
}

function Write-Success {
    param([string]$Message)
    Write-Host "[✓] $Message" -ForegroundColor Green
}

function Write-Error {
    param([string]$Message)
    Write-Host "[✗] $Message" -ForegroundColor Red
}

function Show-Help {
    Write-Host @"
Antigravity-Proxy 编译脚本

用法:
    .\build.ps1 [参数]

参数:
    -Config <Release|Debug>  编译配置 (默认: Release)
    -Arch   <x64|x86>        目标架构 (默认: x64)
    -StaticRuntime           使用静态运行库 (/MT) (默认启用)
    -DynamicRuntime          使用动态运行库 (/MD)
    -Clean                   清理后重新编译
    -Help                    显示帮助信息

示例:
    .\build.ps1                      # Release x64 编译
    .\build.ps1 -Config Debug        # Debug x64 编译
    .\build.ps1 -Arch x86            # Release x86 编译
    .\build.ps1 -DynamicRuntime      # 使用动态运行库编译
    .\build.ps1 -Clean -Config Debug # 清理后 Debug 编译
"@
}

# ============================================================
# 主逻辑
# ============================================================

if ($Help) {
    Show-Help
    exit 0
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BuildDir = Join-Path $ScriptDir "build-$Arch"
$OutputDir = Join-Path $ScriptDir "output"

# 默认启用静态运行库，降低运行库缺失导致的启动失败风险
$UseStaticRuntime = $true
if ($DynamicRuntime) { $UseStaticRuntime = $false }
elseif ($StaticRuntime) { $UseStaticRuntime = $true }
$RuntimeLabel = if ($UseStaticRuntime) { "静态(/MT)" } else { "动态(/MD)" }

Write-Header "Antigravity-Proxy 编译开始"
Write-Host "  配置: $Config" -ForegroundColor White
Write-Host "  架构: $Arch" -ForegroundColor White
Write-Host "  运行库: $RuntimeLabel" -ForegroundColor White
Write-Host "  构建目录: $BuildDir" -ForegroundColor White
Write-Host ""

# ============================================================
# 步骤 1: 检查依赖
# ============================================================

Write-Step "检查依赖项..."

# 检查 CMake
$cmake = Get-Command cmake -ErrorAction SilentlyContinue
if (-not $cmake) {
    Write-Error "CMake 未找到，请确保 CMake 已安装并添加到 PATH"
    exit 1
}
Write-Success "CMake 已找到: $($cmake.Source)"

# 检查 nlohmann/json
$jsonHeader = Join-Path $ScriptDir "include\nlohmann\json.hpp"
if (-not (Test-Path $jsonHeader)) {
    Write-Step "下载 nlohmann/json (单头文件)..."
    $nlohmannDir = Join-Path $ScriptDir "include\nlohmann"
    if (-not (Test-Path $nlohmannDir)) {
        New-Item -ItemType Directory -Path $nlohmannDir -Force | Out-Null
    }
    try {
        Invoke-WebRequest -Uri "https://raw.githubusercontent.com/nlohmann/json/develop/single_include/nlohmann/json.hpp" -OutFile $jsonHeader
        Write-Success "nlohmann/json 下载完成"
    } catch {
        Write-Error "下载失败: $_"
        Write-Host "请手动下载 json.hpp 到 include/nlohmann/ 目录" -ForegroundColor Yellow
        exit 1
    }
} else {
    Write-Success "nlohmann/json 已存在"
}

# ============================================================
# 步骤 2: 清理 (可选)
# ============================================================

if ($Clean -and (Test-Path $BuildDir)) {
    Write-Step "清理构建目录..."
    Remove-Item -Recurse -Force $BuildDir
    Write-Success "构建目录已清理"
}

# ============================================================
# 步骤 3: 创建构建目录
# ============================================================

if (-not (Test-Path $BuildDir)) {
    Write-Step "创建构建目录..."
    New-Item -ItemType Directory -Path $BuildDir | Out-Null
}

# ============================================================
# 步骤 4: CMake 配置
# ============================================================

Write-Step "运行 CMake 配置..."

$cmakeArch = if ($Arch -eq "x64") { "x64" } else { "Win32" }

Push-Location $BuildDir
try {
    $cmakeArgs = @(
        "..",
        "-G", "Visual Studio 17 2022",
        "-A", $cmakeArch
    )
    if ($UseStaticRuntime) {
        $cmakeArgs += "-DSTATIC_RUNTIME=ON"
    } else {
        $cmakeArgs += "-DSTATIC_RUNTIME=OFF"
    }

    $cmakeResult = & cmake @cmakeArgs 2>&1
    $cmakeFailed = ($LASTEXITCODE -ne 0)

    # 处理项目目录迁移后的旧缓存：自动清理并重试一次
    if ($cmakeFailed) {
        $cmakeText = ($cmakeResult | Out-String)
        $isCacheMismatch = $cmakeText -match "CMakeCache\.txt directory .* is different than the directory" -or
                          $cmakeText -match "does not match the source .* used to generate cache"

        if ($isCacheMismatch) {
            Pop-Location
            Write-Step "检测到 CMake 缓存路径不匹配，自动清理构建目录后重试..."
            if (Test-Path $BuildDir) {
                Remove-Item -Recurse -Force $BuildDir
            }
            New-Item -ItemType Directory -Path $BuildDir | Out-Null

            Push-Location $BuildDir
            $cmakeResult = & cmake @cmakeArgs 2>&1
            $cmakeFailed = ($LASTEXITCODE -ne 0)
        }
    }

    if ($cmakeFailed) {
        Write-Error "CMake 配置失败"
        Write-Host $cmakeResult -ForegroundColor Red
        exit 1
    }
    Write-Success "CMake 配置完成"
} finally {
    Pop-Location
}

# ============================================================
# 步骤 5: 编译
# ============================================================

Write-Step "开始编译 ($Config $Arch)..."

Push-Location $BuildDir
try {
    $buildResult = & cmake --build . --config $Config 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Error "编译失败"
        Write-Host $buildResult -ForegroundColor Red
        exit 1
    }
    Write-Success "编译完成"
} finally {
    Pop-Location
}

# ============================================================
# 步骤 6: 查找输出文件
# ============================================================

Write-Step "查找编译产物..."

$dllPattern = if ($Config -eq "Debug") { "version*.dll" } else { "version.dll" }
$dllPath = Get-ChildItem -Path $BuildDir -Recurse -Filter $dllPattern | Select-Object -First 1

if (-not $dllPath) {
    Write-Error "未找到编译产物 DLL"
    exit 1
}

Write-Success "找到 DLL: $($dllPath.FullName)"

# ============================================================
# 步骤 7: 创建输出目录并复制文件
# ============================================================

Write-Step "创建输出目录..."

if (-not (Test-Path $OutputDir)) {
    New-Item -ItemType Directory -Path $OutputDir | Out-Null
}

Copy-Item $dllPath.FullName -Destination $OutputDir -Force
Write-Success "DLL 已复制到 output 目录"

# ============================================================
# 步骤 8: 生成配置文件
# ============================================================

Write-Step "生成配置文件..."

$configJson = @{
    "_comment" = "Antigravity-Proxy 配置文件"
    "_version" = $Version
    "_build" = @{
        "date" = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
        "config" = $Config
        "arch" = $Arch
    }
    # 日志等级：默认 info（克制日志输出）；排障时可改为 debug 以获得更详细信息
    log_level = "debug"
    proxy = @{
        host = "127.0.0.1"
        port = 7890
        type = "socks5"
    }
    fake_ip = @{
        enabled = $true
        cidr = "198.18.0.0/15"
    }
    timeout = @{
        connect = 5000
        send = 5000
        recv = 5000
    }
    traffic_logging = $false
    child_injection = $true
    # 子进程注入模式: filtered(按target_processes过滤) / inherit(注入所有子进程)
    child_injection_mode = "filtered"
    # 子进程注入排除列表（大小写不敏感，支持子串匹配）
    child_injection_exclude = @()
    # 目标进程列表（空数组=注入所有子进程）
    target_processes = @("language_server_windows", "Antigravity.exe")
    proxy_rules = @{
        # 端口白名单: 仅代理 HTTP(80) 和 HTTPS(443)，空数组=代理所有端口
        allowed_ports = @(80, 443)
        dns_mode = "direct"
        ipv6_mode = "proxy"
        # UDP策略: block(阻断UDP以强制回退TCP) / direct(直连) / proxy(UDP走代理, 需 SOCKS5 UDP Associate)
        udp_mode = "block"
        # UDP代理失败降级策略(仅udp_mode=proxy时生效): block(失败即阻断) / direct(失败回退直连)
        udp_fallback = "block"
        # 高级路由规则（内网自动直连，无需手动配置）
        routing = @{
            enabled = $true
            priority_mode = "order"
            default_action = "proxy"
            use_default_private = $true
            rules = @()
        }
    }
} | ConvertTo-Json -Depth 5

$configPath = Join-Path $OutputDir "config.json"
$configJson | Out-File -FilePath $configPath -Encoding UTF8
Write-Success "配置文件已生成: $configPath"

# ============================================================
# 步骤 9: 生成使用说明
# ============================================================

Write-Step "生成使用说明..."

$usageDoc = @'
# Antigravity-Proxy 使用说明

## 概述
Antigravity-Proxy 是一个基于 MinHook 的 Windows DLL 代理注入工具。
通过劫持 version.dll，可以透明地将目标进程的网络流量重定向到代理服务器。

## 快速开始

### 1. 部署文件
将以下文件复制到目标程序的目录：
- ` version.dll ` (编译生成的 DLL)
- ` config.json ` (配置文件)

### 2. 配置代理
编辑 `config.json`，设置代理服务器地址：
``````jsonc
{
    "proxy": {
        "host": "127.0.0.1",       // 代理服务器地址
        "port": 7890,              // 代理服务器端口
        "type": "socks5"           // 代理类型: socks5 或 http
    },
    "log_level": "info",           // 日志等级: debug/info/warn/error (默认 info)
    "fake_ip": {
        "enabled": true,           // 是否启用 FakeIP 系统 (拦截 DNS 解析)
        "cidr": "198.18.0.0/15"    // FakeIP 分配的虚拟 IP 地址范围 (默认为基准测试保留网段)
    },
    "timeout": {
        "connect": 5000,           // 连接超时 (毫秒)
        "send": 5000,              // 发送超时 (毫秒)
        "recv": 5000               // 接收超时 (毫秒)
    },
    "traffic_logging": false,      // 是否记录流量日志 (调试用)
    "child_injection": true,       // 是否自动注入子进程
    "child_injection_mode": "filtered",  // 子进程注入模式: filtered(按target_processes过滤) / inherit(注入所有)
    "child_injection_exclude": [],       // 子进程注入排除列表 (大小写不敏感，支持子串匹配)
    "target_processes": [],        // 目标进程列表 (空数组=注入所有子进程)
    "proxy_rules": {
        "allowed_ports": [80, 443],  // 端口白名单: 仅代理 HTTP/HTTPS，空数组=代理所有端口
        "dns_mode": "direct",        // DNS策略: direct(直连) 或 proxy(走代理)
        "ipv6_mode": "proxy",        // IPv6策略: proxy(走代理) / direct(直连) / block(阻止)
        "udp_mode": "block",         // UDP策略: block(阻断UDP以强制回退TCP) / direct(直连) / proxy(UDP走代理, 需 SOCKS5 UDP Associate)
        "udp_fallback": "block",     // UDP代理失败降级策略(仅udp_mode=proxy生效): block(阻断) / direct(回退直连)
        "routing": {                 // 高级路由规则 (内网自动直连，一般无需配置)
            "enabled": true,
            "priority_mode": "order",
            "default_action": "proxy",
            "use_default_private": true,
            "rules": []
        }
    }
}
``````

#### 常用代理软件端口参考

| 代理软件 | SOCKS5 端口 | HTTP 端口 | 混合端口 | 说明 |
|----------|-------------|-----------|----------|------|
| Clash / Clash Verge | 7891 | 7890 | 7890 | 混合端口同时支持 SOCKS5 和 HTTP |
| Clash for Windows | 7891 | 7890 | 7890 | 设置 → Ports 查看 |
| Mihomo (Clash Meta) | 7891 | 7890 | 7890 | 配置同 Clash |
| V2RayN | 10808 | 10809 | - | 设置 → Core 基础设置 |
| Shadowsocks | 1080 | - | - | 仅 SOCKS5 |
| Surge | 6153 | 6152 | - | Mac/iOS |
| Qv2ray | 1089 | 8889 | - | 首选项 → 入站设置 |

> **提示**: 推荐使用 SOCKS5 协议，本工具对其支持更完善。

#### 如何确认端口是否开启？
```powershell
# PowerShell 测试端口
Test-NetConnection -ComputerName 127.0.0.1 -Port 7890
```

### 3. 启动目标程序
直接启动目标程序，DLL 会自动加载并重定向网络流量。

## 配置文件说明

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| log_level | 日志等级 (debug/info/warn/error) | info |
| proxy.host | 代理服务器地址 | 127.0.0.1 |
| proxy.port | 代理服务器端口 | 7890 |
| proxy.type | 代理类型 (socks5/http) | socks5 |
| fake_ip.enabled | 是否启用 FakeIP 系统 | true |
| fake_ip.cidr | 虚拟 IP 地址范围 | 198.18.0.0/15 |
| timeout.connect | 连接超时 (毫秒) | 5000 |
| timeout.send | 发送超时 (毫秒) | 5000 |
| timeout.recv | 接收超时 (毫秒) | 5000 |
| traffic_logging | 是否记录流量日志 | false |
| child_injection | 是否注入子进程 | true |
| child_injection_mode | 子进程注入模式 (filtered/inherit) | filtered |
| child_injection_exclude | 子进程注入排除列表 | [] |
| target_processes | 目标进程列表 (空=全部) | [] |
| proxy_rules.allowed_ports | 端口白名单 (空=全部代理) | [80, 443] |
| proxy_rules.dns_mode | DNS策略 (direct/proxy) | direct |
| proxy_rules.ipv6_mode | IPv6策略 (proxy/direct/block) | proxy |
| proxy_rules.udp_mode | UDP策略 (block/direct/proxy) | block |
| proxy_rules.udp_fallback | UDP代理失败降级策略 (block/direct) | block |
| proxy_rules.routing.enabled | 是否启用路由分流 | true |
| proxy_rules.routing.priority_mode | 规则优先级模式 (order/number) | order |
| proxy_rules.routing.default_action | 默认动作 (proxy/direct) | proxy |
| proxy_rules.routing.use_default_private | 是否自动添加内网直连规则 | true |
| proxy_rules.routing.rules | 自定义路由规则列表 | [] |

## v1.1.0 更新说明

### 新增功能
1. **目标进程过滤**: 可配置 `target_processes` 数组，仅对指定进程注入 DLL
2. **回环地址 bypass**: `127.0.0.1`、`localhost` 等本地地址不再走代理
3. **日志中文化**: 所有日志已统一为中文输出
4. **智能路由规则**: 新增 `proxy_rules` 配置，支持端口白名单、DNS/IPv6/UDP 策略
   - `allowed_ports`: 仅指定端口走代理，其他直连
   - `dns_mode`: DNS (53端口) 可选直连或走代理
   - `ipv6_mode`: IPv6 可选走代理/直连/阻止
   - `udp_mode`: UDP 可选直连/阻断/走代理（默认阻断以强制回退 TCP；若需要 QUIC/HTTP3，请使用 proxy 并确保代理端支持 SOCKS5 UDP Associate）
   - `udp_fallback`: UDP 代理失败时的降级策略（仅 `udp_mode=proxy` 生效，默认阻断以防止流量泄漏）

### 配置示例
```json
{
    "target_processes": ["language_server_windows", "Antigravity.exe"],
    "child_injection_mode": "filtered",
    "child_injection_exclude": ["unwanted_process.exe"]
}
```
- `target_processes` 为空数组或不存在时，注入所有子进程(原行为)
- `child_injection_mode="inherit"` 时注入所有子进程，可用 `child_injection_exclude` 排除特定进程

## 日志文件
DLL 运行时会在当前目录生成 `proxy.log` 日志文件，用于调试。

## WSL 环境说明

> ⚠️ **重要提示**：Antigravity-Proxy (version.dll 劫持方案) **无法代理 WSL 内部的流量**。

这是由技术架构决定的根本性限制：
- DLL 注入只能 Hook Windows PE 进程
- WSL2 运行真正的 Linux 内核，使用 Linux socket() 系统调用
- 即使注入 wsl.exe，也无法 Hook WSL 内部的 language_server_linux_x64

### WSL 替代方案

**方案一：使用 antissh 工具（推荐）**
```bash
# 在 WSL 中执行
curl -O https://raw.githubusercontent.com/ccpopy/antissh/main/antissh.sh
chmod +x antissh.sh && bash ./antissh.sh
```
项目地址：https://github.com/ccpopy/antissh

**方案二：WSL Mirrored 网络模式**
1. 创建 %USERPROFILE%\.wslconfig 文件，内容如下：
```ini
[wsl2]
networkingMode=mirrored
```
2. 执行 `wsl --shutdown` 重启 WSL
3. 在 WSL 中设置环境变量：
```bash
export ALL_PROXY=socks5://127.0.0.1:7890
```
要求：Windows 11 22H2+，WSL 2.0+

**方案三：TUN 模式全局代理**
在 Clash/Mihomo 中开启 TUN 模式，实现全局透明代理。

## 常见问题

### Q: DLL 加载失败？
A: 确保使用正确的架构版本 (x64 程序用 x64 DLL，x86 程序用 x86 DLL)。

### Q: 网络连接失败？
A: 检查代理服务器是否正常运行，且端口配置正确。

### Q: 如何验证 DLL 是否生效？
A: 检查目标程序目录是否生成 `proxy.log` 文件。

### Q: WSL 中的程序不走代理？
A: 这是技术限制，请参考上述"WSL 环境说明"使用替代方案。

## 编译信息
- 编译时间: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
- 编译配置: $Config
- 目标架构: $Arch
- 编译版本: $Version
- 开发环境: Windows 11
- 开发者: 煎饼果子@86

---
GitHub: https://github.com/yuaotian/antigravity-proxy
关注公众号「煎饼果子卷AI」获取最新动态
'@

$usagePath = Join-Path $OutputDir "使用说明.md"
$usageDoc | Out-File -FilePath $usagePath -Encoding UTF8
Write-Success "使用说明已生成: $usagePath"

# ============================================================
# 步骤 10: 复制配置工具
# ============================================================

Write-Step "复制配置工具..."
$configWebSrc = Join-Path $PSScriptRoot "resources\config-web\index.html"
if (Test-Path $configWebSrc) {
    Copy-Item $configWebSrc -Destination (Join-Path $OutputDir "config-web.html") -Force
    Write-Success "配置工具已复制到 output 目录"
} else {
    Write-Warning "配置工具源文件不存在: $configWebSrc"
}

# ============================================================
# 完成
# ============================================================

Write-Header "编译完成!"
Write-Host ""
Write-Host "输出目录: $OutputDir" -ForegroundColor Green
Write-Host ""
Write-Host "生成的文件:" -ForegroundColor White
Get-ChildItem $OutputDir | ForEach-Object {
    Write-Host "  - $($_.Name)" -ForegroundColor Gray
}
Write-Host ""
Write-Host "下一步: 将 output 目录中的文件复制到目标程序目录即可使用。" -ForegroundColor Yellow
Write-Host ""
