<#
.SYNOPSIS
    ACP 启动包装器 agy-acp-proxy.exe 的行为测试（Issue #164）。

.DESCRIPTION
    在临时沙箱目录中复制包装器与代理 DLL，用系统自带的 cmd.exe / findstr.exe 作为“假 Agent”，验证：
      1. 无参数时输出用法并返回 2；
      2. 目标进程退出码原样透传；
      3. stdin → 目标进程 → stdout 透传（ACP 的 JSON-RPC 就走这条管道）；
      4. 目标不存在返回 4；同目录缺少 DLL 返回 3；
      5. version.dll 回退（IDE 插件部署场景）同样可用；
      6. 日志里出现“已注入并启动目标”与 DLL 加载记录，证明注入真实发生。
    不访问网络，不需要真实的 Antigravity / Google 账号。

.PARAMETER SourceDir
    包含 agy-acp-proxy.exe 与 antigravity_proxy.dll 的目录，默认 output\cli（先运行 build.ps1）。

.PARAMETER KeepSandbox
    保留临时沙箱目录，便于查看日志。

.EXAMPLE
    pwsh -File scripts\test-acp-proxy.ps1
#>
param(
    [string]$SourceDir = "",
    [switch]$KeepSandbox
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($SourceDir)) { $SourceDir = Join-Path $Root "output\cli" }

$wrapperSrc = Join-Path $SourceDir "agy-acp-proxy.exe"
$dllSrc = Join-Path $SourceDir "antigravity_proxy.dll"
foreach ($required in @($wrapperSrc, $dllSrc)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "缺少测试输入: $required（请先运行 build.ps1 生成 output\cli）"
    }
}

$cmdExe = Join-Path $env:SystemRoot "System32\cmd.exe"
$findstrExe = Join-Path $env:SystemRoot "System32\findstr.exe"
$sandboxRoot = Join-Path ([IO.Path]::GetTempPath()) ("agp-acp-test-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$failures = New-Object System.Collections.Generic.List[string]

function Assert-True([bool]$Condition, [string]$Name, [string]$Detail = "") {
    if ($Condition) {
        Write-Host "  [通过] $Name" -ForegroundColor Green
    } else {
        Write-Host "  [失败] $Name $Detail" -ForegroundColor Red
        $script:failures.Add($Name)
    }
}

# 构造沙箱：包装器 + 指定名称的 DLL + 关闭加载弹窗的最小配置
function New-Sandbox([string]$Name, [string]$DllName) {
    $dir = Join-Path $sandboxRoot $Name
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    Copy-Item -LiteralPath $wrapperSrc -Destination (Join-Path $dir "agy-acp-proxy.exe")
    if ($DllName) {
        Copy-Item -LiteralPath $dllSrc -Destination (Join-Path $dir $DllName)
        # ui.load_notify=none：避免注入到 cmd/findstr 后弹出“加载成功”对话框打断测试
        $config = @{
            proxy = @{ host = "127.0.0.1"; port = 7890; type = "socks5" }
            ui = @{ load_notify = "none" }
            child_injection = $true
        } | ConvertTo-Json -Depth 4
        [IO.File]::WriteAllText((Join-Path $dir "config.json"), $config, (New-Object System.Text.UTF8Encoding($false)))
    }
    return $dir
}

function Get-SandboxLog([string]$Dir) {
    $logDir = Join-Path $Dir "logs"
    if (-not (Test-Path -LiteralPath $logDir)) { return "" }
    return (Get-ChildItem -LiteralPath $logDir -Filter "proxy-*.log" | ForEach-Object {
        [IO.File]::ReadAllText($_.FullName, [Text.Encoding]::UTF8)
    }) -join "`n"
}

try {
    Write-Host "[测试] 沙箱目录: $sandboxRoot"
    $main = New-Sandbox "main" "antigravity_proxy.dll"
    $wrapper = Join-Path $main "agy-acp-proxy.exe"

    Write-Host "[1] 无参数输出用法"
    & $wrapper 2>$null | Out-Null
    Assert-True ($LASTEXITCODE -eq 2) "无参数返回 2" "(实际 $LASTEXITCODE)"

    Write-Host "[2] 退出码透传"
    & $wrapper $cmdExe /d /c "exit 7"
    Assert-True ($LASTEXITCODE -eq 7) "cmd /c exit 7 返回 7" "(实际 $LASTEXITCODE)"
    & $wrapper $cmdExe /d /c "exit 0"
    Assert-True ($LASTEXITCODE -eq 0) "cmd /c exit 0 返回 0" "(实际 $LASTEXITCODE)"

    Write-Host "[3] stdin → stdout 透传"
    $lines = @('{"jsonrpc":"2.0","id":1,"method":"initialize"}', "line-2 中文")
    $output = @($lines | & $wrapper $findstrExe "^")
    Assert-True ($LASTEXITCODE -eq 0) "findstr 正常退出" "(实际 $LASTEXITCODE)"
    Assert-True ($output.Count -eq 2 -and $output[0] -eq $lines[0]) "JSON-RPC 行原样回显" "(实际: $($output -join ' | '))"

    Write-Host "[4] 错误路径"
    & $wrapper (Join-Path $main "not-exist-agent.exe") 2>$null
    Assert-True ($LASTEXITCODE -eq 4) "目标不存在返回 4" "(实际 $LASTEXITCODE)"
    $noDll = New-Sandbox "no-dll" ""
    & (Join-Path $noDll "agy-acp-proxy.exe") $cmdExe /d /c "exit 0" 2>$null
    Assert-True ($LASTEXITCODE -eq 3) "缺少代理 DLL 返回 3" "(实际 $LASTEXITCODE)"

    Write-Host "[5] version.dll 回退（IDE 插件部署场景）"
    $ideLike = New-Sandbox "ide-like" "version.dll"
    & (Join-Path $ideLike "agy-acp-proxy.exe") $cmdExe /d /c "exit 5"
    Assert-True ($LASTEXITCODE -eq 5) "使用 version.dll 注入后退出码透传" "(实际 $LASTEXITCODE)"

    Write-Host "[6] 注入证据（日志）"
    $log = Get-SandboxLog $main
    Assert-True ($log -match "\[ACP 包装器\] 已注入并启动目标") "包装器记录注入成功"
    Assert-True ($log -match "Antigravity-Proxy DLL 已加载") "目标进程内的代理 DLL 已加载"
    Assert-True ($log -match "ProcessInjector: 注入成功") "LoadLibraryW 返回非空"
    $ideLog = Get-SandboxLog $ideLike
    Assert-True ($ideLog -match "\[ACP 包装器\] 已注入并启动目标.*version\.dll") "version.dll 回退路径被使用"
} finally {
    if ($KeepSandbox) {
        Write-Host "[测试] 已保留沙箱: $sandboxRoot"
    } else {
        Remove-Item -LiteralPath $sandboxRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if ($failures.Count -gt 0) {
    Write-Host "[测试] 失败 $($failures.Count) 项: $($failures -join ', ')" -ForegroundColor Red
    exit 1
}
Write-Host "[测试] ACP 启动包装器测试全部通过。" -ForegroundColor Green
