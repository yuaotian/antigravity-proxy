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
    
    [switch]$Clean,
    [switch]$Help
)

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
    -Clean                   清理后重新编译
    -Help                    显示帮助信息

示例:
    .\build.ps1                      # Release x64 编译
    .\build.ps1 -Config Debug        # Debug x64 编译
    .\build.ps1 -Arch x86            # Release x86 编译
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

Write-Header "Antigravity-Proxy 编译开始"
Write-Host "  配置: $Config" -ForegroundColor White
Write-Host "  架构: $Arch" -ForegroundColor White
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
    
    $cmakeResult = & cmake @cmakeArgs 2>&1
    if ($LASTEXITCODE -ne 0) {
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
    "_version" = "1.0.0"
    "_build" = @{
        "date" = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
        "config" = $Config
        "arch" = $Arch
    }
    proxy = @{
        host = "127.0.0.1"
        port = 7890
        type = "socks5"
    }
    fake_ip = @{
        enabled = $true
        cidr = "10.0.0.0/8"
    }
    timeout = @{
        connect = 5000
        send = 5000
        recv = 5000
    }
    traffic_logging = $false
    child_injection = $true
} | ConvertTo-Json -Depth 4

$configPath = Join-Path $OutputDir "config.json"
$configJson | Out-File -FilePath $configPath -Encoding UTF8
Write-Success "配置文件已生成: $configPath"

# ============================================================
# 步骤 9: 生成使用说明
# ============================================================

Write-Step "生成使用说明..."

$usageDoc = @"
# Antigravity-Proxy 使用说明

## 概述
Antigravity-Proxy 是一个基于 MinHook 的 Windows DLL 代理注入工具。
通过劫持 version.dll，可以透明地将目标进程的网络流量重定向到代理服务器。

## 快速开始

### 1. 部署文件
将以下文件复制到目标程序的目录：
- `version.dll` (编译生成的 DLL)
- `config.json` (配置文件)

### 2. 配置代理
编辑 `config.json`，设置代理服务器地址：
```json
{
    "proxy": {
        "host": "127.0.0.1",
        "port": 7890,
        "type": "socks5"
    }
}
```

### 3. 启动目标程序
直接启动目标程序，DLL 会自动加载并重定向网络流量。

## 配置文件说明

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| proxy.host | 代理服务器地址 | 127.0.0.1 |
| proxy.port | 代理服务器端口 | 7890 |
| proxy.type | 代理类型 (socks5/http) | socks5 |
| fake_ip.enabled | 是否启用 FakeIP 系统 | true |
| fake_ip.cidr | 虚拟 IP 地址范围 | 10.0.0.0/8 |
| timeout.connect | 连接超时 (毫秒) | 5000 |
| timeout.send | 发送超时 (毫秒) | 5000 |
| timeout.recv | 接收超时 (毫秒) | 5000 |
| traffic_logging | 是否记录流量日志 | false |
| child_injection | 是否注入子进程 | true |

## 日志文件
DLL 运行时会在当前目录生成 `proxy.log` 日志文件，用于调试。

## 常见问题

### Q: DLL 加载失败？
A: 确保使用正确的架构版本 (x64 程序用 x64 DLL，x86 程序用 x86 DLL)。

### Q: 网络连接失败？
A: 检查代理服务器是否正常运行，且端口配置正确。

### Q: 如何验证 DLL 是否生效？
A: 检查目标程序目录是否生成 `proxy.log` 文件。

## 编译信息
- 编译时间: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
- 编译配置: $Config
- 目标架构: $Arch

---
GitHub: https://github.com/yuaotian/antigravity-proxy
"@

$usagePath = Join-Path $OutputDir "使用说明.md"
$usageDoc | Out-File -FilePath $usagePath -Encoding UTF8
Write-Success "使用说明已生成: $usagePath"

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
