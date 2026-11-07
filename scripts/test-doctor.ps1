<#
.SYNOPSIS
    doctor.ps1 的离线自测。全部在 %TEMP% 的临时目录内进行，不触碰真实安装目录、
    不读写注册表、不结束任何进程。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\test-doctor.ps1
#>
[CmdletBinding()]
param(
    [string]$DoctorPath = "",
    [switch]$KeepFixtures
)

$ErrorActionPreference = "Stop"

$script:PassCount = 0
$script:FailCount = 0
$script:Failures = New-Object System.Collections.ArrayList
$script:FixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ("agp-doctor-test-" + [guid]::NewGuid().ToString('N').Substring(0, 8))

if ([string]::IsNullOrWhiteSpace($DoctorPath)) {
    $DoctorPath = Join-Path $PSScriptRoot "doctor.ps1"
}
if (-not (Test-Path -LiteralPath $DoctorPath -PathType Leaf)) {
    throw "找不到 doctor.ps1: $DoctorPath"
}

# -NoRun 只加载函数定义；$Json = $true 用于抑制体检脚本的彩色控制台输出。
. $DoctorPath -NoRun
$Json = $true

function Reset-State {
    $script:Findings = New-Object System.Collections.ArrayList
    $script:Verdicts = New-Object System.Collections.ArrayList
}

function Get-Findings {
    return @($script:Findings)
}

function Assert-True {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][bool]$Condition,
        [string]$Detail = ""
    )
    if ($Condition) {
        $script:PassCount++
        Write-Host ("  [通过] {0}" -f $Name) -ForegroundColor Green
    } else {
        $script:FailCount++
        [void]$script:Failures.Add("$Name  $Detail")
        Write-Host ("  [失败] {0}    {1}" -f $Name, $Detail) -ForegroundColor Red
    }
}

function Assert-Equal {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)]$Expected,
        $Actual
    )
    Assert-True -Name $Name -Condition ([string]$Expected -eq [string]$Actual) `
        -Detail ("期望 '{0}'，实际 '{1}'" -f $Expected, $Actual)
}

function Assert-HasCode {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Code,
        [ValidateSet("", "Pass", "Info", "Warn", "Fail")][string]$Level = ""
    )
    $items = Get-Findings | Where-Object { $_.Code -eq $Code }
    if ($Level) { $items = $items | Where-Object { $_.Level -eq $Level } }
    $count = @($items).Count
    Assert-True -Name $Name -Condition ($count -gt 0) `
        -Detail ("未找到 Code={0} Level={1}，实际条目: {2}" -f $Code, $Level,
            ((Get-Findings | ForEach-Object { $_.Code + ":" + $_.Level }) -join ", "))
}

function Assert-NoCode {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Code
    )
    $items = @(Get-Findings | Where-Object { $_.Code -eq $Code })
    Assert-True -Name $Name -Condition ($items.Count -eq 0) `
        -Detail ("不应出现 Code={0}" -f $Code)
}

function New-PeStub {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [ValidateSet("x64", "x86")][string]$Arch = "x64",
        [int]$Size = 512
    )
    $bytes = New-Object byte[] $Size
    $bytes[0] = 0x4D; $bytes[1] = 0x5A                                  # "MZ"
    $bytes[0x3C] = 0x80                                                 # e_lfanew = 0x80
    $bytes[0x80] = 0x50; $bytes[0x81] = 0x45                            # "PE\0\0"
    if ($Arch -eq "x64") {
        $bytes[0x84] = 0x64; $bytes[0x85] = 0x86                        # 0x8664
    } else {
        $bytes[0x84] = 0x4C; $bytes[0x85] = 0x01                        # 0x014C
    }
    [IO.File]::WriteAllBytes($Path, $bytes)
}

function New-Fixture {
    param([ValidateSet("ide", "cli")][string]$Variant = "ide")
    $name = "{0}-{1}" -f $Variant, ([guid]::NewGuid().ToString('N').Substring(0, 6))
    $install = Join-Path $script:FixtureRoot ("install-" + $name)
    $source = Join-Path $script:FixtureRoot ("source-" + $name)
    New-Item -ItemType Directory -Path $install -Force | Out-Null
    New-Item -ItemType Directory -Path $source -Force | Out-Null
    if ($Variant -eq "cli") {
        New-PeStub -Path (Join-Path $install "agy.exe")
        New-PeStub -Path (Join-Path $source "dbghelp.dll")
        New-PeStub -Path (Join-Path $source "antigravity_proxy.dll")
    } else {
        New-PeStub -Path (Join-Path $install "Antigravity.exe")
        New-PeStub -Path (Join-Path $source "version.dll")
    }
    return [pscustomobject]@{ Install = $install; Source = $source }
}

function Write-UserConfig {
    param([string]$Dir, [int]$Port = 7897)
    $config = [pscustomobject]@{
        proxy            = @{ type = "socks5"; host = "127.0.0.1"; port = $Port }
        child_injection  = $true
        target_processes = @("Antigravity.exe", "language_server.exe")
    }
    [IO.File]::WriteAllText((Join-Path $Dir "config.json"), ($config | ConvertTo-Json -Depth 10))
}

# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "== 用例 1: PE 架构识别 ==" -ForegroundColor White

$x64 = Join-Path $script:FixtureRoot "arch-x64.dll"
$x86 = Join-Path $script:FixtureRoot "arch-x86.dll"
$junk = Join-Path $script:FixtureRoot "arch-junk.dll"
New-Item -ItemType Directory -Path $script:FixtureRoot -Force | Out-Null
New-PeStub -Path $x64 -Arch "x64"
New-PeStub -Path $x86 -Arch "x86"
[IO.File]::WriteAllText($junk, "not a portable executable at all")

Assert-Equal -Name "x64 桩识别为 x64" -Expected "x64" -Actual (Get-PeArchitecture $x64)
Assert-Equal -Name "x86 桩识别为 x86" -Expected "x86" -Actual (Get-PeArchitecture $x86)
Assert-Equal -Name "非 PE 内容识别为非 PE" -Expected "非 PE" -Actual (Get-PeArchitecture $junk)
Assert-Equal -Name "缺失文件返回缺失" -Expected "缺失" -Actual (Get-PeArchitecture (Join-Path $script:FixtureRoot "nope.dll"))

Write-Host ""
Write-Host "== 用例 2: JSONC 容错解析 ==" -ForegroundColor White

$jsonc = @'
{
  // 行注释
  "proxy": { "type": "socks5", "host": "127.0.0.1", "port": 7897 }, /* 块注释 */
  "note": "字符串里的 // 不应被当成注释",
  "allowed": [80, 443,],
}
'@
$parsed = ConvertFrom-TolerantJson $jsonc
Assert-True -Name "带注释与尾逗号可解析" -Condition ([bool]$parsed)
Assert-Equal -Name "注释后仍能读到端口" -Expected 7897 -Actual $parsed.proxy.port
Assert-Equal -Name "字符串内的双斜杠未被吃掉" -Expected "字符串里的 // 不应被当成注释" -Actual $parsed.note
Assert-Equal -Name "非法内容返回空" -Expected "" -Actual (ConvertFrom-TolerantJson "{ broken")

Write-Host ""
Write-Host "== 用例 3: 路径包含判断 ==" -ForegroundColor White

Assert-True -Name "同目录判定为包含" -Condition (Test-PathInside "C:\app\antigravity" "C:\app\antigravity")
Assert-True -Name "子目录判定为包含" -Condition (Test-PathInside "C:\app\antigravity\resources\bin" "C:\app\antigravity")
Assert-True -Name "大小写不同仍判定为包含" -Condition (Test-PathInside "C:\APP\Antigravity\version.dll" "c:\app\antigravity")
Assert-True -Name "前缀相同的兄弟目录不算包含" -Condition (-not (Test-PathInside "C:\app\antigravity-ide" "C:\app\antigravity"))
Assert-True -Name "空路径不算包含" -Condition (-not (Test-PathInside "" "C:\app\antigravity"))

Write-Host ""
Write-Host "== 用例 4: 补丁文件与架构检查 ==" -ForegroundColor White

Reset-State
$fx = New-Fixture
Test-PatchFiles -BaseDir $fx.Install -Variant "ide" -SrcDir $fx.Source | Out-Null
Assert-HasCode -Name "补丁缺失被判定为错误" -Code "PatchMissing" -Level "Fail"
Assert-True -Name "补丁缺失会给出修复结论" -Condition (@($script:Verdicts).Count -gt 0)

Reset-State
[void](Copy-PatchFile -SrcDir $fx.Source -BaseDir $fx.Install -FileName "version.dll")
Write-UserConfig $fx.Install
Test-PatchFiles -BaseDir $fx.Install -Variant "ide" -SrcDir $fx.Source | Out-Null
Assert-HasCode -Name "补齐后判定补丁齐全" -Code "PatchPresent" -Level "Pass"
Assert-HasCode -Name "同架构通过校验" -Code "ArchMatched" -Level "Pass"
Assert-NoCode -Name "不再报告补丁缺失" -Code "PatchMissing"

Reset-State
New-PeStub -Path (Join-Path $fx.Install "version.dll") -Arch "x86"
Test-PatchFiles -BaseDir $fx.Install -Variant "ide" -SrcDir $fx.Source | Out-Null
Assert-HasCode -Name "x86 补丁配 x64 主程序被拦截" -Code "ArchMismatch" -Level "Fail"

Reset-State
New-PeStub -Path (Join-Path $fx.Install "version.dll") -Arch "x64" -Size 1024
Write-UserConfig $fx.Install
Test-PatchFiles -BaseDir $fx.Install -Variant "ide" -SrcDir $fx.Source | Out-Null
Assert-HasCode -Name "与母本内容不同给出告警" -Code "PatchDiffersFromSource" -Level "Warn"

Write-Host ""
Write-Host "== 用例 5: 配置内容检查 ==" -ForegroundColor White

Reset-State
$badConfig = [pscustomobject]@{
    proxy            = @{ type = "socks5"; host = "127.0.0.1"; port = 1 }
    child_injection  = $true
    child_injection_mode = "filtered"
    target_processes = @("Antigravity.exe", "node.exe")
    proxy_rules      = @{ allowed_ports = @(80) }
}
[IO.File]::WriteAllText((Join-Path $fx.Install "config.json"), ($badConfig | ConvertTo-Json -Depth 10))
Test-ConfigContent -BaseDir $fx.Install -Variant "ide" | Out-Null
Assert-HasCode -Name "代理端口不可达被判定为错误" -Code "ProxyPortUnreachable" -Level "Fail"
Assert-HasCode -Name "未覆盖 language_server 被判定为错误" -Code "TargetProcessesMissingBackend" -Level "Fail"
Assert-HasCode -Name "allowed_ports 缺 443 给出告警" -Code "AllowedPortsMissing443" -Level "Warn"

Reset-State
$noParse = Join-Path $fx.Install "config.json"
[IO.File]::WriteAllText($noParse, "{ this is not json")
Test-ConfigContent -BaseDir $fx.Install -Variant "ide" | Out-Null
Assert-HasCode -Name "无法解析的 config.json 被判定为错误" -Code "ConfigUnreadable" -Level "Fail"

Write-Host ""
Write-Host "== 用例 6: 母本位置安全校验 ==" -ForegroundColor White

Reset-State
$inside = Join-Path $fx.Install "backup"
New-Item -ItemType Directory -Path $inside -Force | Out-Null
New-PeStub -Path (Join-Path $inside "version.dll")
Assert-True -Name "母本在安装目录内被拒绝" -Condition (Stop-IfSourceUnsafe -SrcDir $inside -BaseDir $fx.Install)
Assert-HasCode -Name "给出 SourceInsideInstallDir 错误" -Code "SourceInsideInstallDir" -Level "Fail"
Assert-True -Name "结论里强调母本要放安装目录外" -Condition (
    (@($script:Verdicts | Where-Object { $_ -match '安装目录之外' }).Count -gt 0))

Reset-State
Assert-True -Name "母本在外部时放行" -Condition (-not (Stop-IfSourceUnsafe -SrcDir $fx.Source -BaseDir $fx.Install))

Reset-State
# 强制把母本指定到安装目录内部：此时不能把它当成恢复源，否则更新会连母本一起删掉。
$SourceDir = $inside
$found = Find-SourceDir -Variant "ide" -KnownInstallDir $fx.Install
$SourceDir = ""
Assert-True -Name "母本位于安装目录内时不作为恢复源" -Condition ([string]::IsNullOrWhiteSpace($found)) `
    -Detail ("实际发现: {0}" -f $found)

Write-Host ""
Write-Host "== 用例 7: 修复行为 ==" -ForegroundColor White

Reset-State
$fx7 = New-Fixture
$repairOk = Invoke-Repair -BaseDir $fx7.Install -Variant "ide" -SrcDir $fx7.Source
Assert-True -Name "Repair 返回成功" -Condition ([bool]$repairOk)
Assert-HasCode -Name "恢复补丁文件" -Code "PatchRestored" -Level "Pass"
Assert-True -Name "临时文件已清理" -Condition (
    (@(Get-ChildItem -LiteralPath $fx7.Install -Filter "*.tmp" -File -ErrorAction SilentlyContinue).Count -eq 0))
$dllHash = Get-FileSha256 (Join-Path $fx7.Install "version.dll")
$srcHash = Get-FileSha256 (Join-Path $fx7.Source "version.dll")
Assert-Equal -Name "恢复后的 DLL 与母本哈希一致" -Expected $srcHash -Actual $dllHash
# 临时目录里不可能有正在运行的进程，真实机器上的 Antigravity 也不能被算到它名下。
$scopeState = Get-RunningState -BaseDir $fx7.Install -Variant "ide"
Assert-Equal -Name "运行状态按安装目录隔离统计" -Expected 0 -Actual ($scopeState.HostRunning + $scopeState.ChildRunning)
Assert-NoCode -Name "无需重启时不产生重启告警" -Code "RestartRequired"

Reset-State
Write-UserConfig -Dir $fx7.Install -Port 10808
$repeatResult = Invoke-Repair -BaseDir $fx7.Install -Variant "ide" -SrcDir $fx7.Source
Assert-True -Name "补丁都在时 Repair 仍然成功" -Condition ([bool]$repeatResult)
Assert-HasCode -Name "已存在的 DLL 保持不动" -Code "PatchKept" -Level "Info"
Assert-HasCode -Name "保留用户 config.json" -Code "ConfigPreserved" -Level "Info"
$kept = Read-JsonFile (Join-Path $fx7.Install "config.json")
Assert-Equal -Name "用户自定义端口未被重置" -Expected 10808 -Actual $kept.proxy.port

Reset-State
$noSource = Join-Path $script:FixtureRoot "install-nosource"
New-Item -ItemType Directory -Path $noSource -Force | Out-Null
New-PeStub -Path (Join-Path $noSource "Antigravity.exe")
$repairResult = Invoke-Repair -BaseDir $noSource -Variant "ide" -SrcDir ""
Assert-True -Name "缺少母本时 Repair 返回失败" -Condition (-not [bool]$repairResult)
Assert-HasCode -Name "提示 SourceDirNotFound" -Code "SourceDirNotFound" -Level "Fail"

Write-Host ""
Write-Host "== 用例 8: 代理配置模板生成 ==" -ForegroundColor White

Reset-State
$fx8 = New-Fixture
$profile = New-ProxyProfile -ProxyHostValue "127.0.0.1" -ProxyPortValue 7897 -ProxyTypeValue "socks5" -Base $null
Assert-Equal -Name "生成的代理端口正确" -Expected 7897 -Actual $profile.proxy.port
Assert-Equal -Name "默认走 SOCKS5" -Expected "socks5" -Actual $profile.proxy.type
Assert-True -Name "模板覆盖 language_server" -Condition (
    (@($profile.target_processes | Where-Object { [string]$_ -match 'language_server' }).Count -gt 0))
Assert-Equal -Name "子进程注入默认开启" -Expected $true -Actual ([bool]$profile.child_injection)

Reset-State
$userBase = [pscustomobject]@{
    proxy            = @{ type = "http"; host = "127.0.0.1"; port = 7890 }
    log_level        = "debug"
    traffic_logging  = $true
    target_processes = @("Antigravity.exe")
}
$merged = New-ProxyProfile -ProxyHostValue "127.0.0.1" -ProxyPortValue 7897 -ProxyTypeValue "socks5" -Base $userBase
Assert-Equal -Name "代理三要素被改写" -Expected 7897 -Actual $merged.proxy.port
Assert-Equal -Name "协议被改写为 socks5" -Expected "socks5" -Actual $merged.proxy.type
Assert-Equal -Name "保留用户其它字段" -Expected "debug" -Actual $merged.log_level
Assert-True -Name "补齐缺失的 language_server" -Condition (
    (@($merged.target_processes | Where-Object { [string]$_ -match 'language_server' }).Count -gt 0))

Write-Host ""
Write-Host "== 用例 9: CLI 目录识别 ==" -ForegroundColor White

Reset-State
$fx9 = New-Fixture -Variant "cli"
Assert-Equal -Name "含 agy.exe 判定为 cli" -Expected "cli" -Actual (Get-VariantOfDir $fx9.Install)
Assert-Equal -Name "桌面端判定为 ide" -Expected "ide" -Actual (Get-VariantOfDir $fx7.Install)
$cliFiles = Get-PatchFileNames "cli"
Assert-True -Name "CLI 恢复 dbghelp.dll" -Condition ($cliFiles -contains "dbghelp.dll")
Assert-True -Name "CLI 恢复 antigravity_proxy.dll" -Condition ($cliFiles -contains "antigravity_proxy.dll")
Assert-True -Name "CLI 不部署 version.dll" -Condition (-not ($cliFiles -contains "version.dll"))

$cliRepair = Invoke-Repair -BaseDir $fx9.Install -Variant "cli" -SrcDir $fx9.Source
Assert-True -Name "CLI Repair 部署两个 DLL" -Condition (
    ((Test-Path -LiteralPath (Join-Path $fx9.Install "dbghelp.dll")) -and
     (Test-Path -LiteralPath (Join-Path $fx9.Install "antigravity_proxy.dll"))))

Write-Host ""
Write-Host "== 用例 10: 日志时间戳解析 ==" -ForegroundColor White

$mainLine = "[2026-10-15 19:25:36.649] [error] electron: Failed to load URL: https://127.0.0.1:7546/ with error: ERR_TIMED_OUT"
$klogLine = "ERROR: logging before google.Init: E1015 19:29:32.694464 61 g3syslog.go:23] failed"
$mainStamp = Get-TimeFromLine $mainLine
$klogStamp = Get-TimeFromLine $klogLine
Assert-True -Name "main.log 时间戳可解析" -Condition ($null -ne $mainStamp)
Assert-Equal -Name "main.log 秒级时间正确" -Expected "19:25:36" -Actual $mainStamp.ToString("HH:mm:ss")
Assert-True -Name "klog 时间戳可解析" -Condition ($null -ne $klogStamp)
Assert-Equal -Name "klog 秒级时间正确" -Expected "19:29:32" -Actual $klogStamp.ToString("HH:mm:ss")
Assert-True -Name "无时间戳行返回空" -Condition ($null -eq (Get-TimeFromLine "plain text"))

Write-Host ""
Write-Host "== 用例 11: 代理日志与后端日志判读 ==" -ForegroundColor White

Reset-State
$fx11 = New-Fixture
New-Item -ItemType Directory -Path (Join-Path $fx11.Install "logs") -Force | Out-Null
$toolLog = Join-Path $fx11.Install "logs\proxy-20261015.log"
[IO.File]::WriteAllText($toolLog, @'
[2026-10-15 20:00:00] [信息] 当前进程 Antigravity.exe 使用全量模式：安装网络与进程创建 Hook
[2026-10-15 20:00:01] [信息] 所有 API Hook 安装成功 (Phase 1-3)
[2026-10-15 20:00:02] [信息] SOCKS5: 隧道建立成功, sock=1980, 目标=172.217.117.4:443
'@, $script:Utf8NoBom)
$healthy = Test-ProxyLogs $fx11.Install
Assert-True -Name "健康 proxy 日志返回 true" -Condition ([bool]$healthy)
Assert-HasCode -Name "识别 Hook 安装成功" -Code "HookInstalled" -Level "Pass"
Assert-HasCode -Name "识别隧道建立成功" -Code "TunnelEstablished" -Level "Pass"

Reset-State
[IO.File]::WriteAllText($toolLog, @'
[2026-10-15 20:00:00] [错误] SOCKS5: 隧道建立失败, 目标=142.250.0.4:443
[2026-10-15 20:00:01] [错误] ConnectEx 失败: 由于目标计算机积极拒绝，无法连接。 198.18.0.12:443
'@, $script:Utf8NoBom)
$broken = Test-ProxyLogs $fx11.Install
Assert-True -Name "异常 proxy 日志返回 false" -Condition (-not [bool]$broken)
Assert-HasCode -Name "识别隧道建立失败" -Code "TunnelFailed" -Level "Fail"
Assert-HasCode -Name "识别 FakeIP 段被拒绝" -Code "FakeIpRefused" -Level "Warn"

Reset-State
$emptyInstall = Join-Path $script:FixtureRoot "install-nolog"
New-Item -ItemType Directory -Path $emptyInstall -Force | Out-Null
New-PeStub -Path (Join-Path $emptyInstall "Antigravity.exe")
[void](Test-ProxyLogs $emptyInstall)
Assert-HasCode -Name "没有 proxy 日志时给出告警" -Code "ProxyLogMissing" -Level "Warn"

Write-Host ""
Write-Host "== 用例 12: 安装目录发现参数校验 ==" -ForegroundColor White

Reset-State
# doctor.ps1 的参数变量在点源后就是本脚本的变量，测试里直接赋值即可影响函数内的读取。
$InstallDir = Join-Path $script:FixtureRoot "does-not-exist"
[void](Resolve-TargetDirs)
Assert-HasCode -Name "不存在的目录被判为参数错误" -Code "InstallDirInvalid" -Level "Fail"

Reset-State
$InstallDir = $fx7.Install
$targets = @(Resolve-TargetDirs)
Assert-Equal -Name "-InstallDir 指向合法目录时只体检该目录" -Expected 1 -Actual $targets.Count

Reset-State
$InstallDir = ""

# ---------------------------------------------------------------------------
if (-not $KeepFixtures) {
    Remove-Item -LiteralPath $script:FixtureRoot -Recurse -Force -ErrorAction SilentlyContinue
} else {
    Write-Host ("测试夹具保留在: {0}" -f $script:FixtureRoot) -ForegroundColor Yellow
}

Write-Host ""
Write-Host ("测试完成: 通过 {0}，失败 {1}" -f $script:PassCount, $script:FailCount) -ForegroundColor $(if ($script:FailCount -eq 0) { "Green" } else { "Red" })
if ($script:FailCount -gt 0) {
    Write-Host "失败明细:" -ForegroundColor Red
    foreach ($item in $script:Failures) { Write-Host ("  - " + $item) -ForegroundColor Red }
    exit 1
}
exit 0
