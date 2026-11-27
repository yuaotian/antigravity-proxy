[CmdletBinding()]
param(
    [ValidateSet("Release", "Debug")]
    [string]$Config = "Release",
    [ValidateSet("x64", "x86", "arm64")]
    [string]$Arch = "x64",
    [string]$BuildDir = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($BuildDir)) {
    $BuildDir = "build-compatibility-tests-host-network-$Arch"
}
$BuildPath = Join-Path $Root $BuildDir
$CMakeArch = switch ($Arch) { "x86" { "Win32" } "arm64" { "ARM64" } default { "x64" } }
$MainSourcePath = Join-Path $Root "src\main.cpp"
$HooksSourcePath = Join-Path $Root "src\hooks\Hooks.cpp"

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)]
        [scriptblock]$Command,
        [Parameter(Mandatory = $true)]
        [string]$FailureMessage
    )

    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw $FailureMessage
    }
}

Write-Host "[测试] 校验宿主网络 Hook 运行时策略..."
$MainSource = Get-Content -LiteralPath $MainSourcePath -Raw
if ($MainSource -notmatch 'const\s+bool\s+enableNetworkHooks\s*=\s*true\s*;') {
    throw "main.cpp 未统一启用全量网络 Hook"
}
if ($MainSource -match 'enableNetworkHooks\s*=\s*!Hooks::IsAntigravityHostProcessName') {
    throw "main.cpp 仍按宿主进程名禁用网络 Hook"
}

Write-Host "[测试] 校验本地目标全透明旁路契约..."
$HooksSource = Get-Content -LiteralPath $HooksSourcePath -Raw
if ([regex]::Matches($HooksSource, 'Network::IsLoopbackSockaddr\(name,\s*namelen\)').Count -lt 3) {
    throw "connect/WSAConnect/ConnectEx 未完整执行 loopback 早期旁路"
}
if ([regex]::Matches($HooksSource, 'Network::IsLoopbackHost\(node\)').Count -lt 2) {
    throw "WSAConnectByNameA/W 未完整执行 localhost 早期旁路"
}
if ($HooksSource -notmatch 'lpCallerData,\s*lpCalleeData,\s*lpSQOS,\s*lpGQOS') {
    throw "WSAConnect 本地旁路未保留连接数据与 QoS 参数"
}
if ([regex]::Matches($HooksSource, 'IsLocalBypassSocket\(s\)').Count -lt 9) {
    throw "本地 socket 的后续 I/O 生命周期旁路不完整"
}

Write-Host "[测试] 配置宿主网络 Hook 回归验证工程..."
Invoke-Checked {
    cmake -S $Root -B $BuildPath -A $CMakeArch -DBUILD_TESTS=ON
} "CMake 配置失败"

Write-Host "[测试] 编译 DLL、进程分类与本地目标策略测试..."
Invoke-Checked {
    cmake --build $BuildPath --config $Config --target version process_name_tests local_target_policy_tests
} "DLL 或回归测试编译失败"

Write-Host "[测试] 运行宿主 Hook 与本地目标策略回归测试..."
Invoke-Checked {
    ctest --test-dir $BuildPath -C $Config -R '^(process_name_tests|local_target_policy_tests)$' --output-on-failure --no-tests=error
} "宿主 Hook 或本地目标策略回归测试失败"

Write-Host "[测试] 外部目标使用全量 Hook、本地回环目标全生命周期旁路的双重契约验证通过。"
