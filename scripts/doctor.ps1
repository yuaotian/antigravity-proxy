<#
.SYNOPSIS
    Antigravity-Proxy 一键部署 / 健康诊断 / 故障修复脚本。

.DESCRIPTION
    一个脚本覆盖三种场景：

      -Action Diagnose  只读体检（默认）。判断补丁是否被 Antigravity 自动更新清空、
                        补丁是否真的被目标进程加载、代理端口是否可达，并结合
                        代理侧与 Antigravity 侧日志给出可执行的结论。
      -Action Setup     首次部署。自动发现安装目录与本机代理端口，写出 config.json，
                        并把补丁文件放入安装目录。
      -Action Repair    故障修复。从安装目录之外的发布包母本补回缺失的补丁文件。

    脚本不会结束任何进程，也不会自动重启应用；需要重启时会明确提示。
    Setup 与 Repair 只做文件复制和 config.json 生成，不写注册表、不创建计划任务、
    不安装任何常驻服务。

.PARAMETER InstallDir
    Antigravity 安装目录（与 Antigravity.exe / agy.exe 同级）。默认自动发现。

.PARAMETER SourceDir
    发布包母本目录，即包含 ide\version.dll 或 cli\dbghelp.dll 的目录。默认自动发现。
    母本必须位于安装目录之外，否则下一次自动更新会把母本连同已部署补丁一起清掉。

.PARAMETER ProxyHost / ProxyPort / ProxyType
    本地代理监听地址。Setup 时若未指定 ProxyPort，脚本会探测常用端口
    （Clash / Mihomo 7890、Clash Verge Rev 7897、v2rayN 10808/10809 等）。

.PARAMETER OverwriteConfig
    允许覆盖安装目录内已有的 config.json。默认不覆盖，以保留用户配好的端口。

.PARAMETER WindowHours
    日志比对窗口（小时），默认 24。

.PARAMETER Json
    以 JSON 输出体检结果，便于其它工具或 CI 消费。

.PARAMETER NoRun
    只加载函数定义不执行主流程，供测试脚本点源引用。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\doctor.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\doctor.ps1 -Action Setup -ProxyPort 7897

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\doctor.ps1 -Action Repair -Yes
#>
[CmdletBinding()]
param(
    [ValidateSet("Diagnose", "Setup", "Repair")]
    [string]$Action = "Diagnose",
    [string]$InstallDir = "",
    [string]$SourceDir = "",
    [string]$ProxyHost = "",
    [int]$ProxyPort = 0,
    [ValidateSet("", "socks5", "http")]
    [string]$ProxyType = "",
    [switch]$OverwriteConfig,
    [switch]$Yes,
    [int]$WindowHours = 24,
    [switch]$Json,
    [switch]$NoRun
)

$ErrorActionPreference = "Stop"

$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:Findings = New-Object System.Collections.ArrayList
$script:Verdicts = New-Object System.Collections.ArrayList
$script:Results = New-Object System.Collections.ArrayList
$script:WorstExitCode = 0

$script:LevelColor = @{
    Pass = "Green"
    Info = "Cyan"
    Warn = "Yellow"
    Fail = "Red"
}
$script:LevelLabel = @{
    Pass = "[通过]"
    Info = "[信息]"
    Warn = "[警告]"
    Fail = "[错误]"
}

# 常用本地代理监听端口：Clash / Mihomo、Clash Verge Rev、v2rayN、Shadowsocks 等。
$script:CommonProxyPorts = @(7890, 7897, 7891, 10808, 10809, 1080, 8118)

$script:IdeExeNames = @("Antigravity.exe", "Antigravity IDE.exe")
$script:CliExeNames = @("agy.exe")

# 关键进程名。language_server.exe 是 Antigravity 2.0 之后的新命名，
# language_server_windows_x64 保留旧版兼容。
$script:HostProcessNames = @("Antigravity", "Antigravity IDE", "agy")
$script:ChildProcessNames = @("language_server", "language_server_windows_x64", "node")

# ---------------------------------------------------------------------------
# 输出与基础工具
# ---------------------------------------------------------------------------

function Write-Line {
    param([string]$Text, [string]$Color = "Gray")
    if ($Json) { return }
    Write-Host $Text -ForegroundColor $Color
}

function Write-Section {
    param([string]$Title)
    if ($Json) { return }
    Write-Host ""
    Write-Host "== $Title ==" -ForegroundColor White
}

function Add-Finding {
    param(
        [Parameter(Mandatory = $true)]
        [ValidateSet("Pass", "Info", "Warn", "Fail")]
        [string]$Level,
        [Parameter(Mandatory = $true)]
        [string]$Code,
        [Parameter(Mandatory = $true)]
        [string]$Message,
        [string]$Hint = ""
    )
    $finding = [pscustomobject]@{
        Level   = $Level
        Code    = $Code
        Message = $Message
        Hint    = $Hint
    }
    [void]$script:Findings.Add($finding)
    if (-not $Json) {
        Write-Host ("  {0} {1}  {2}" -f $script:LevelLabel[$Level], $Code, $Message) `
            -ForegroundColor $script:LevelColor[$Level]
        if (-not [string]::IsNullOrWhiteSpace($Hint)) {
            Write-Host ("         建议: {0}" -f $Hint) -ForegroundColor DarkGray
        }
    }
    # 故意不返回对象：Add-Finding 会被裸调用，返回值会污染流水线并打乱报告排版。
}

function Add-Verdict {
    param([Parameter(Mandatory = $true)][string]$Text)
    if (-not $script:Verdicts.Contains($Text)) {
        [void]$script:Verdicts.Add($Text)
    }
}

function Get-CodeCount {
    param(
        [Parameter(Mandatory = $true)][string]$Code,
        [ValidateSet("All", "Pass", "Info", "Warn", "Fail")][string]$Level = "All"
    )
    $items = $script:Findings | Where-Object { $_.Code -eq $Code }
    if ($Level -ne "All") { $items = $items | Where-Object { $_.Level -eq $Level } }
    return @($items).Count
}

function Get-LevelCount {
    param([Parameter(Mandatory = $true)][ValidateSet("Pass", "Info", "Warn", "Fail")][string]$Level)
    return @($script:Findings | Where-Object { $_.Level -eq $Level }).Count
}

function Get-NormalizedPath {
    param([AllowNull()][string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return "" }
    try {
        return [IO.Path]::GetFullPath($Path).TrimEnd([char[]]@('\', '/'))
    } catch {
        return $Path.TrimEnd([char[]]@('\', '/'))
    }
}

function Test-PathInside {
    param([AllowNull()][string]$Child, [AllowNull()][string]$Parent)
    $childPath = Get-NormalizedPath $Child
    $parentPath = Get-NormalizedPath $Parent
    if ([string]::IsNullOrWhiteSpace($childPath) -or [string]::IsNullOrWhiteSpace($parentPath)) {
        return $false
    }
    return $childPath.Equals($parentPath, 'OrdinalIgnoreCase') -or
        $childPath.StartsWith(($parentPath + '\'), 'OrdinalIgnoreCase') -or
        $childPath.StartsWith(($parentPath + '/'), 'OrdinalIgnoreCase')
}

function Test-FileExists {
    param([AllowNull()][string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    return Test-Path -LiteralPath $Path -PathType Leaf
}

function Get-FileSha256 {
    param([string]$Path)
    if (-not (Test-FileExists $Path)) { return "" }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

# 读取 PE 头判断架构，避免把 x86 补丁放进 x64 主程序目录。
function Get-PeArchitecture {
    param([string]$Path)
    if (-not (Test-FileExists $Path)) { return "缺失" }
    $stream = $null
    try {
        $stream = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
        $reader = New-Object IO.BinaryReader($stream)
        $stream = $null
        try {
            if ($reader.ReadInt16() -ne 0x5A4D) { return "非 PE" }        # "MZ"
            $reader.BaseStream.Position = 0x3C
            $peOffset = $reader.ReadInt32()
            if ($peOffset -le 0 -or ($peOffset + 6) -gt $reader.BaseStream.Length) { return "非 PE" }
            $reader.BaseStream.Position = $peOffset
            if ($reader.ReadInt32() -ne 0x00004550) { return "非 PE" }    # "PE\0\0"
            $machine = $reader.ReadUInt16()
            switch ($machine) {
                0x014c { return "x86" }
                0x8664 { return "x64" }
                0xAA64 { return "ARM64" }
                default { return ("未知 0x{0:X4}" -f $machine) }
            }
        } finally { $reader.Dispose() }
    } catch {
        return "读取失败"
    } finally {
        if ($stream) { $stream.Dispose() }
    }
}

# config-web.html 可能导出带注释的 JSONC，这里做容错解析。
function ConvertFrom-TolerantJson {
    param([AllowNull()][string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    try { return ($Text | ConvertFrom-Json) } catch { }

    $builder = New-Object Text.StringBuilder
    foreach ($line in ($Text -split "`r?`n")) {
        $lineBuilder = New-Object Text.StringBuilder
        $inString = $false
        $previous = ''
        $index = 0
        while ($index -lt $line.Length) {
            $char = $line[$index]
            if ($inString) {
                [void]$lineBuilder.Append($char)
                if ($char -eq '"' -and $previous -ne '\') { $inString = $false }
                $previous = $char
                $index++
                continue
            }
            if ($char -eq '"') {
                $inString = $true
                [void]$lineBuilder.Append($char)
                $previous = $char
                $index++
                continue
            }
            if ($char -eq '/' -and ($index + 1) -lt $line.Length) {
                $next = $line[$index + 1]
                if ($next -eq '/') { break }
                if ($next -eq '*') {
                    $close = $line.IndexOf('*/', ($index + 2))
                    if ($close -lt 0) { break }
                    $index = $close + 2
                    continue
                }
            }
            [void]$lineBuilder.Append($char)
            $previous = $char
            $index++
        }
        [void]$builder.AppendLine($lineBuilder.ToString())
    }
    $cleaned = [regex]::Replace($builder.ToString(), ',(\s*[}\]])', '$1')
    try { return ($cleaned | ConvertFrom-Json) } catch { return $null }
}

function Read-TextFile {
    param([string]$Path)
    if (-not (Test-FileExists $Path)) { return "" }
    $stream = $null
    try {
        $stream = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
        $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)
        $stream = $null
        $text = $reader.ReadToEnd()
        $reader.Dispose()
        return $text
    } catch {
        return ""
    } finally {
        if ($stream) { $stream.Dispose() }
    }
}

function Read-JsonFile {
    param([string]$Path)
    $text = Read-TextFile $Path
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    return (ConvertFrom-TolerantJson $text)
}

function Write-JsonFile {
    param([string]$Path, [Parameter(Mandatory = $true)]$Object)
    $text = ($Object | ConvertTo-Json -Depth 20)
    [IO.File]::WriteAllText($Path, $text, $script:Utf8NoBom)
}

function Read-FileTail {
    param([string]$Path, [int]$Lines = 500)
    $text = Read-TextFile $Path
    if ([string]::IsNullOrWhiteSpace($text)) { return @() }
    $all = @($text -split "`r?`n")
    if ($all.Count -gt $Lines) {
        return @($all[($all.Count - $Lines)..($all.Count - 1)])
    }
    return $all
}

function Test-TcpPort {
    param([string]$ComputerName = "127.0.0.1", [int]$Port = 0, [int]$TimeoutMs = 1200)
    if ($Port -le 0) { return $false }
    $client = New-Object Net.Sockets.TcpClient
    try {
        $async = $client.ConnectAsync($ComputerName, $Port)
        if (-not $async.Wait($TimeoutMs)) { return $false }
        return $client.Connected
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Confirm-Choice {
    param([string]$Question)
    if ($Yes) { return $true }
    if (-not [Environment]::UserInteractive) { return $true }
    $answer = Read-Host "$Question [y/N]"
    return ($answer -match '^\s*[yY]')
}

function Get-TimeFromLine {
    param([string]$Line)
    if ($Line -match '(?<y>\d{4})-(?<mo>\d{2})-(?<d>\d{2})[ T](?<h>\d{2}):(?<mi>\d{2}):(?<s>\d{2})') {
        try {
            return New-Object DateTime(
                [int]$Matches['y'], [int]$Matches['mo'], [int]$Matches['d'],
                [int]$Matches['h'], [int]$Matches['mi'], [int]$Matches['s'])
        } catch { return $null }
    }
    # language_server.log 的 klog 形式: E1015 19:29:32.694
    if ($Line -match '[EWIF](?<mo>\d{2})(?<d>\d{2})\s+(?<h>\d{2}):(?<mi>\d{2}):(?<s>\d{2})') {
        try {
            $year = (Get-Date).Year
            return New-Object DateTime(
                $year, [int]$Matches['mo'], [int]$Matches['d'],
                [int]$Matches['h'], [int]$Matches['mi'], [int]$Matches['s'])
        } catch { return $null }
    }
    return $null
}

# ---------------------------------------------------------------------------
# 目录与母本发现
# ---------------------------------------------------------------------------

function Test-AntigravityDir {
    param([AllowNull()][string]$Dir)
    if ([string]::IsNullOrWhiteSpace($Dir)) { return $false }
    if (-not (Test-Path -LiteralPath $Dir -PathType Container)) { return $false }
    foreach ($exe in ($script:IdeExeNames + $script:CliExeNames)) {
        if (Test-FileExists (Join-Path $Dir $exe)) { return $true }
    }
    return $false
}

function Get-VariantOfDir {
    param([string]$Dir)
    if (Test-FileExists (Join-Path $Dir "agy.exe")) { return "cli" }
    return "ide"
}

function Get-PatchFileNames {
    param([string]$Variant)
    if ($Variant -eq "cli") { return @("dbghelp.dll", "antigravity_proxy.dll") }
    return @("version.dll")
}

function Find-InstallDirs {
    $found = New-Object System.Collections.Generic.List[string]

    function Add-Candidate {
        param([string]$Dir)
        if (-not (Test-AntigravityDir $Dir)) { return }
        $normalized = Get-NormalizedPath $Dir
        if (-not $found.Contains($normalized)) { [void]$found.Add($normalized) }
    }

    $registryRoots = @(
        "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
    )
    foreach ($root in $registryRoots) {
        Get-ItemProperty -Path $root -ErrorAction SilentlyContinue | ForEach-Object {
            $display = [string]$_.DisplayName
            if ($display -notmatch '(?i)antigravity') { return }
            $location = [string]$_.InstallLocation
            if ([string]::IsNullOrWhiteSpace($location)) { return }
            Add-Candidate $location
            # 部分安装器把 InstallLocation 写成父目录，主程序在一级子目录里。
            Get-ChildItem -LiteralPath $location -Directory -ErrorAction SilentlyContinue |
                ForEach-Object { Add-Candidate $_.FullName }
        }
    }

    $knownPaths = @(
        (Join-Path $env:LOCALAPPDATA "Programs\antigravity"),
        (Join-Path $env:LOCALAPPDATA "Programs\Antigravity IDE"),
        (Join-Path $env:ProgramFiles "Antigravity IDE"),
        (Join-Path ${env:ProgramFiles(x86)} "Antigravity IDE")
    )
    foreach ($path in $knownPaths) { Add-Candidate $path }

    # 正在运行的主进程最能代表用户实际使用的入口。
    Get-Process -Name $script:HostProcessNames -ErrorAction SilentlyContinue | ForEach-Object {
        try {
            if ($_.Path) { Add-Candidate (Split-Path -Parent $_.Path) }
        } catch { }
    }

    return @($found | Sort-Object)
}

function Get-DoctorStatePath {
    $dir = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) "antigravity-proxy"
    return Join-Path $dir "doctor-state.json"
}

function Save-DoctorSource {
    param([string]$BaseDir, [string]$Variant, [string]$SrcDir)
    if ([string]::IsNullOrWhiteSpace($SrcDir) -or [string]::IsNullOrWhiteSpace($BaseDir)) { return }
    if (Test-PathInside $SrcDir $BaseDir) { return }

    $statePath = Get-DoctorStatePath
    $stateDir = Split-Path -Parent $statePath
    if (-not (Test-Path -LiteralPath $stateDir -PathType Container)) {
        New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    }
    $state = Read-JsonFile $statePath
    if (-not $state) { $state = [pscustomobject]@{ sources = @() } }
    if ($state.PSObject.Properties.Name -notcontains "sources") {
        $state | Add-Member -NotePropertyName "sources" -NotePropertyValue @()
    }

    $entry = [pscustomobject]@{
        variant     = $Variant
        install_dir = $BaseDir
        source_dir  = $SrcDir
        saved_at    = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    }
    $kept = @($state.sources | Where-Object {
        -not ($_.variant -eq $Variant -and ([string]$_.install_dir) -eq $BaseDir)
    })
    $merged = @($kept + $entry)
    $state | Add-Member -NotePropertyName "sources" -NotePropertyValue $merged -Force
    Write-JsonFile -Path $statePath -Object $state
}

function Find-SourceDir {
    param([string]$Variant, [string]$KnownInstallDir)
    $candidates = New-Object System.Collections.Generic.List[string]

    if (-not [string]::IsNullOrWhiteSpace($SourceDir)) {
        [void]$candidates.Add((Get-NormalizedPath $SourceDir))
    } else {
        # 发布包内运行（脚本与 ide/ 同级）与源码仓内运行（output/ide）两种布局都要覆盖。
        $roots = @(
            (Join-Path $PSScriptRoot $Variant),
            (Join-Path $PSScriptRoot ("..\output\" + $Variant)),
            (Join-Path (Split-Path -Parent $PSScriptRoot) $Variant),
            (Join-Path (Split-Path -Parent $PSScriptRoot) ("output\" + $Variant))
        )
        foreach ($root in $roots) { [void]$candidates.Add((Get-NormalizedPath $root)) }

        # 上次成功部署时记录的母本位置，让 -Action Repair 不带参数也能直接用。
        $state = Read-JsonFile (Get-DoctorStatePath)
        if ($state -and $state.sources) {
            foreach ($item in @($state.sources)) {
                if (([string]$item.variant) -ne $Variant) { continue }
                [void]$candidates.Add((Get-NormalizedPath ([string]$item.source_dir)))
            }
        }

        # 兜底：只在两个常用根目录里按名字匹配发布包，不做全盘扫描。
        $scanRoots = @(
            (Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads'),
            ([Environment]::GetFolderPath('LocalApplicationData'))
        )
        foreach ($scanRoot in $scanRoots) {
            Get-ChildItem -LiteralPath $scanRoot -Directory -Filter "*antigravity-proxy*" `
                -ErrorAction SilentlyContinue | ForEach-Object {
                [void]$candidates.Add((Get-NormalizedPath (Join-Path $_.FullName $Variant)))
                [void]$candidates.Add((Get-NormalizedPath $_.FullName))
            }
        }

        [void]$candidates.Add((Get-NormalizedPath $PSScriptRoot))
    }

    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        if (-not (Test-Path -LiteralPath $candidate -PathType Container)) { continue }
        if (-not [string]::IsNullOrWhiteSpace($KnownInstallDir) -and
            (Test-PathInside $candidate $KnownInstallDir)) { continue }
        foreach ($file in (Get-PatchFileNames $Variant)) {
            if (Test-FileExists (Join-Path $candidate $file)) { return $candidate }
        }
    }
    return ""
}

# ---------------------------------------------------------------------------
# 运行状态
# ---------------------------------------------------------------------------

function Get-RunningState {
    param([string]$BaseDir, [string]$Variant)

    $patchNames = @((Get-PatchFileNames $Variant) | ForEach-Object { $_.ToLowerInvariant() })
    $result = [pscustomobject]@{
        HostRunning   = 0
        HostInjected  = 0
        ChildRunning  = 0
        ChildInjected = 0
        InjectedPaths = New-Object System.Collections.Generic.HashSet[string]
        Samples       = @()
        EnumerateOk   = $true
    }

    foreach ($name in ($script:HostProcessNames + $script:ChildProcessNames)) {
        $isHost = $script:HostProcessNames -contains $name
        foreach ($proc in (Get-Process -Name $name -ErrorAction SilentlyContinue)) {
            $procPath = ""
            try { $procPath = [string]$proc.Path } catch { }

            # 只统计目标目录树内的进程：多个安装目录共存时不能互相冒名，
            # 系统里无关的 node.exe 也不该被算作后端子进程。
            if ($procPath -and -not (Test-PathInside $procPath $BaseDir)) { continue }

            if ($isHost) { $result.HostRunning++ } else { $result.ChildRunning++ }

            $loadedPath = ""
            try {
                foreach ($module in $proc.Modules) {
                    $moduleName = [IO.Path]::GetFileName($module.FileName).ToLowerInvariant()
                    if ($patchNames -notcontains $moduleName) { continue }
                    # 系统目录里的同名 version.dll 会被每个进程加载，必须按路径区分。
                    if (Test-PathInside $module.FileName $BaseDir) {
                        $loadedPath = $module.FileName
                        [void]$result.InjectedPaths.Add($module.FileName)
                        break
                    }
                }
            } catch {
                $result.EnumerateOk = $false
            }

            if ($loadedPath) {
                if ($isHost) { $result.HostInjected++ } else { $result.ChildInjected++ }
            }
            if ($result.Samples.Count -lt 8) {
                $tag = if ($loadedPath) { "已加载补丁" } else { "未加载补丁" }
                $result.Samples += ("{0} (PID {1}) {2}" -f $proc.ProcessName, $proc.Id, $tag)
            }
        }
    }
    return $result
}

# ---------------------------------------------------------------------------
# 日志证据
# ---------------------------------------------------------------------------

function Get-NewestLogFile {
    param([string]$Directory, [string[]]$Patterns)
    if ([string]::IsNullOrWhiteSpace($Directory)) { return $null }
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { return $null }
    $best = $null
    foreach ($pattern in $Patterns) {
        Get-ChildItem -LiteralPath $Directory -Filter $pattern -File -ErrorAction SilentlyContinue |
            ForEach-Object {
                if (-not $best -or $_.LastWriteTime -gt $best.LastWriteTime) { $best = $_ }
            }
    }
    return $best
}

function Measure-LineHits {
    param([string[]]$Lines, [string]$Pattern)
    return @($Lines | Where-Object { $_ -match $Pattern }).Count
}

function Get-LastHitTime {
    param([string[]]$Lines, [string]$Pattern)
    $latest = $null
    foreach ($line in $Lines) {
        if ($line -notmatch $Pattern) { continue }
        $stamp = Get-TimeFromLine $line
        if ($stamp -and (-not $latest -or $stamp -gt $latest)) { $latest = $stamp }
    }
    return $latest
}

function Test-ProxyLogs {
    param([string]$BaseDir)
    Write-Section "代理侧日志"

    $items = @(
        (Get-NewestLogFile (Join-Path $BaseDir "logs") @("proxy-*.log", "proxy.log")),
        (Get-NewestLogFile $BaseDir @("proxy-*.log", "proxy.log"))
    ) | Where-Object { $_ }

    if ($items.Count -eq 0) {
        Add-Finding -Level "Warn" -Code "ProxyLogMissing" `
            -Message "安装目录内没有 proxy 日志，无法确认 Hook 是否安装成功。" `
            -Hint "启动一次 Antigravity 再体检；若仍无日志，基本可以判定补丁没有被进程加载。"
        return $false
    }

    $logItem = $items[0]
    $logAgeMinutes = [int]((Get-Date) - $logItem.LastWriteTime).TotalMinutes
    $lines = Read-FileTail -Path $logItem.FullName -Lines 1500
    Add-Finding -Level "Info" -Code "ProxyLogFile" `
        -Message ("读取 {0}（{1} 行，{2} 分钟前写入）" -f $logItem.Name, $lines.Count, $logAgeMinutes)

    $hookOk = (Measure-LineHits $lines "所有 API Hook 安装成功|Hook 安装成功") -gt 0
    $hookBad = (Measure-LineHits $lines "Hook 安装失败|MinHook 初始化失败|安装 Hook 失败") -gt 0
    $tunnelOk = (Measure-LineHits $lines "隧道建立成功|代理隧道就绪") -gt 0
    $tunnelBad = (Measure-LineHits $lines "隧道建立失败|握手失败") -gt 0
    $fakeIpRefused = ((Measure-LineHits $lines "actively refused|连接被拒绝|积极拒绝") -gt 0 -and
        (Measure-LineHits $lines "198\.1[89]\.") -gt 0)
    $crash = (Measure-LineHits $lines "0xc0000409|0xc0e90007") -gt 0

    if ($hookBad) {
        Add-Finding -Level "Fail" -Code "HookInstallFailed" -Message "日志显示 Hook 安装失败。" `
            -Hint "按 docs/host-network-hook-regression-fix.md 排查，并确认 DLL 与主程序架构一致。"
    } elseif ($hookOk) {
        Add-Finding -Level "Pass" -Code "HookInstalled" -Message "日志显示网络 Hook 已安装。"
    } else {
        Add-Finding -Level "Warn" -Code "HookNotObserved" -Message "日志中没有 Hook 安装成功记录。" `
            -Hint "确认 version.dll 与 config.json 来自同一次构建，并完全退出后重启 Antigravity。"
    }

    if ($tunnelBad) {
        Add-Finding -Level "Fail" -Code "TunnelFailed" -Message "日志显示代理隧道建立失败。" `
            -Hint "核对 config.json 的 proxy.host / proxy.port / proxy.type 与代理软件实际监听端口。"
    } elseif ($tunnelOk) {
        Add-Finding -Level "Pass" -Code "TunnelEstablished" -Message "日志显示代理隧道建立成功。"
    }

    if ($crash) {
        Add-Finding -Level "Fail" -Code "ProcessCrashObserved" -Message "日志中出现崩溃特征码。" `
            -Hint "参考 Issue #146：挂载 DLL 后 0xC0000409。"
    }

    if ($fakeIpRefused) {
        Add-Finding -Level "Warn" -Code "FakeIpRefused" -Message "日志中出现 198.18/19 段连接被拒绝。" `
            -Hint "FakeIP 映射未命中会出现该症状（Issue #154），可先把 fake_ip.enabled 设为 false 验证。"
    }

    return ($hookOk -and $tunnelOk)
}

function Test-AppLogs {
    param([bool]$PatchLoaded)
    Write-Section "Antigravity 侧日志"

    $roots = @(
        (Join-Path $env:APPDATA "Antigravity\logs"),
        (Join-Path $env:APPDATA "Antigravity IDE\logs"),
        (Join-Path ([Environment]::GetFolderPath('UserProfile')) ".antigravity-ide\logs")
    )
    $logDir = $roots | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Select-Object -First 1
    if (-not $logDir) {
        Add-Finding -Level "Info" -Code "AppLogMissing" -Message "未找到 Antigravity 日志目录，跳过日志比对。"
        return
    }

    # language_server.log 每次启动会重写，因此它反映的是当前会话的真实网络状态；
    # main.log 是累积追加的，必须按时间判断，否则修复成功后仍会被历史错误误导。
    $lsLogPath = Join-Path $logDir "language_server.log"
    $mainLogPath = Join-Path $logDir "main.log"

    if (Test-FileExists $lsLogPath) {
        $lsItem = Get-Item -LiteralPath $lsLogPath
        $lsAgeMinutes = [int]((Get-Date) - $lsItem.LastWriteTime).TotalMinutes
        $lsLines = Read-FileTail -Path $lsLogPath -Lines 2000
        Add-Finding -Level "Info" -Code "BackendLogFile" `
            -Message ("读取 language_server.log（{0} 行，{1} 分钟前写入）" -f $lsLines.Count, $lsAgeMinutes)

        $directDial = Measure-LineHits $lsLines "dial tcp \d+\.\d+\.\d+\.\d+:443"
        $oauthFail = Measure-LineHits $lsLines "Failed to get OAuth token"
        $backendTimeout = Measure-LineHits $lsLines "connectex|connection attempt failed|由于连接方在一段时间后"

        if ($directDial -gt 0 -or $oauthFail -gt 0) {
            Add-Finding -Level "Fail" -Code "BackendDirectDial" `
                -Message ("当前会话内后端直连 Google 失败 {0} 次（dial tcp / 取 OAuth token）。" -f [Math]::Max($directDial, $oauthFail)) `
                -Hint "language_server.exe 是 Go 进程，只读环境变量、不读 Windows 系统代理，必须由补丁接管才会走代理。"
            if (-not $PatchLoaded) {
                Add-Verdict "后端在直连 Google：补丁缺失或未被加载，这就是主页白屏 / 无法登录的直接原因。"
            } else {
                Add-Verdict "补丁显示已加载但后端仍然直连：核对 child_injection、target_processes 是否覆盖 language_server.exe。"
            }
        } elseif ($backendTimeout -gt 0) {
            Add-Finding -Level "Warn" -Code "BackendTimeout" `
                -Message ("当前会话内有 {0} 条后端连接超时记录。" -f $backendTimeout)
        } else {
            Add-Finding -Level "Pass" -Code "BackendHealthy" -Message "后端日志没有直连或超时记录。"
        }

        $locationBlock = Measure-LineHits $lsLines "User location is not supported"
        if ($locationBlock -gt 0) {
            Add-Finding -Level "Fail" -Code "LocationRejected" `
                -Message ("日志命中 User location is not supported {0} 次。" -f $locationBlock) `
                -Hint "这通常不是补丁问题，而是代理出口 IP 被判不可用，参考 docs/agent-ip-diagnosis.md 更换住宅 / 普通 ISP 出口。"
            Add-Verdict "命中 location 限制：优先换出口 IP，不要继续排查注入。"
        }
    }

    if (Test-FileExists $mainLogPath) {
        $mainLines = Read-FileTail -Path $mainLogPath -Lines 2000
        $timeoutCount = Measure-LineHits $mainLines "ERR_TIMED_OUT|ERR_NETWORK_CHANGED"
        if ($timeoutCount -gt 0) {
            $lastHit = Get-LastHitTime $mainLines "ERR_TIMED_OUT|ERR_NETWORK_CHANGED"
            $isFresh = $false
            if ($lastHit) {
                $isFresh = ((Get-Date) - $lastHit).TotalMinutes -le 30
            }
            if ($isFresh) {
                Add-Finding -Level "Warn" -Code "RendererLoadTimeout" `
                    -Message ("main.log 在最近半小时内仍有 {0} 次本地页面加载超时（最近一次 {1:HH:mm:ss}）。" -f $timeoutCount, $lastHit) `
                    -Hint "本地端口本身可用，多由后端取不到数据引起；补丁恢复并重启后应消失（对应 Issue #150）。"
            } else {
                $label = if ($lastHit) { "{0:MM-dd HH:mm:ss}" -f $lastHit } else { "时间未知" }
                Add-Finding -Level "Info" -Code "RendererLoadTimeoutHistory" `
                    -Message ("main.log 累计 {0} 条本地页面加载超时，最近一次在 {1}，属于历史记录。" -f $timeoutCount, $label)
            }
        } else {
            Add-Finding -Level "Pass" -Code "RendererHealthy" -Message "main.log 没有本地页面加载超时记录。"
        }
    }
}

# ---------------------------------------------------------------------------
# 补丁与配置检查
# ---------------------------------------------------------------------------

function Test-PatchFiles {
    param([string]$BaseDir, [string]$Variant, [string]$SrcDir)

    $patchFiles = Get-PatchFileNames $Variant
    $missing = @($patchFiles | Where-Object { -not (Test-FileExists (Join-Path $BaseDir $_)) })

    if ($missing.Count -gt 0) {
        Add-Finding -Level "Fail" -Code "PatchMissing" `
            -Message ("安装目录缺少补丁文件: {0}" -f ($missing -join ", ")) `
            -Hint "Antigravity 后台静默自更新会重建安装目录并清掉这些文件，运行 -Action Repair 从母本补回。"
        Add-Verdict "补丁文件被更新冲掉：运行 doctor.ps1 -Action Repair 补回，然后完全退出并重新打开 Antigravity。"
    } else {
        Add-Finding -Level "Pass" -Code "PatchPresent" `
            -Message ("补丁文件齐全: {0}" -f ($patchFiles -join ", "))
    }

    $exeNames = if ($Variant -eq "cli") { $script:CliExeNames } else { $script:IdeExeNames }
    $exePath = $null
    foreach ($exe in $exeNames) {
        $candidate = Join-Path $BaseDir $exe
        if (Test-FileExists $candidate) { $exePath = $candidate; break }
    }
    $exeArch = if ($exePath) { Get-PeArchitecture $exePath } else { "缺失" }

    foreach ($file in $patchFiles) {
        $filePath = Join-Path $BaseDir $file
        if (-not (Test-FileExists $filePath)) { continue }
        $dllArch = Get-PeArchitecture $filePath
        if ($dllArch -in @("非 PE", "读取失败", "缺失")) {
            Add-Finding -Level "Fail" -Code "PatchFileInvalid" `
                -Message ("{0} 不是有效 PE 文件，可能被截断或替换。" -f $file) `
                -Hint "用 -Action Repair 从母本重新复制。"
            continue
        }
        if ($exeArch -ne "缺失" -and $dllArch -ne $exeArch) {
            Add-Finding -Level "Fail" -Code "ArchMismatch" `
                -Message ("架构不匹配: 主程序 {0}，{1} 为 {2}。" -f $exeArch, $file, $dllArch) `
                -Hint "x64 主程序必须配 x64 补丁，重新下载对应架构的发布包。"
            Add-Verdict "补丁与主程序架构不一致，先换成同架构发布包。"
        } else {
            Add-Finding -Level "Pass" -Code "ArchMatched" `
                -Message ("{0} 与主程序架构一致 ({1})。" -f $file, $dllArch)
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($SrcDir)) {
        foreach ($file in $patchFiles) {
            $installedHash = Get-FileSha256 (Join-Path $BaseDir $file)
            $sourceHash = Get-FileSha256 (Join-Path $SrcDir $file)
            if ($installedHash -and $sourceHash -and ($installedHash -ne $sourceHash)) {
                Add-Finding -Level "Warn" -Code "PatchDiffersFromSource" `
                    -Message ("{0} 与母本内容不同，可能版本不一致。" -f $file) `
                    -Hint "确认两者来自同一次构建；需要以母本覆盖时运行 -Action Repair -OverwriteConfig。"
            }
        }
    }

    if (-not (Test-FileExists (Join-Path $BaseDir "config.json"))) {
        Add-Finding -Level "Fail" -Code "ConfigMissing" `
            -Message "安装目录缺少 config.json，DLL 只能退回内置默认值。" `
            -Hint "运行 -Action Setup 生成，或从 config-web.html 导出后放到同一目录。"
        return $false
    }
    return ($missing.Count -eq 0)
}

function Test-ConfigContent {
    param([string]$BaseDir, [string]$Variant)

    $configPath = Join-Path $BaseDir "config.json"
    if (-not (Test-FileExists $configPath)) {
        # 文件根本不存在的场景由 Test-PatchFiles 报 ConfigMissing，这里不再重复判成"解析失败"。
        Add-Finding -Level "Info" -Code "ConfigNotDeployed" `
            -Message "安装目录内没有 config.json，跳过配置内容检查。"
        return $null
    }

    $config = Read-JsonFile $configPath
    if (-not $config) {
        Add-Finding -Level "Fail" -Code "ConfigUnreadable" `
            -Message "config.json 无法解析，DLL 可能根本没读到配置。" `
            -Hint "用 config-web.html 重新导出；手写注释导致的语法错误是常见原因。"
        Add-Verdict "config.json 解析失败，先修好配置文件。"
        return $null
    }
    Add-Finding -Level "Pass" -Code "ConfigParsed" -Message "config.json 解析成功。"

    if (-not $config.proxy -or [string]::IsNullOrWhiteSpace([string]$config.proxy.host) -or -not $config.proxy.port) {
        Add-Finding -Level "Fail" -Code "ConfigProxyMissing" -Message "config.json 缺少 proxy.host / proxy.port。" `
            -Hint "运行 -Action Setup 补齐代理地址。"
        return $config
    }

    $proxyHost = [string]$config.proxy.host
    $proxyPort = [int]$config.proxy.port
    if (Test-TcpPort -ComputerName $proxyHost -Port $proxyPort) {
        Add-Finding -Level "Pass" -Code "ProxyPortReachable" `
            -Message ("本地代理端口可达: {0}:{1}（{2}）" -f $proxyHost, $proxyPort, $config.proxy.type)
    } else {
        $listenCandidates = @($script:CommonProxyPorts | Where-Object { Test-TcpPort -ComputerName $proxyHost -Port $_ })
        $hint = "代理软件可能未启动，或端口不是这个。"
        if ($listenCandidates.Count -gt 0) {
            $hint = ("本机实际在听的相关端口: {0}，把它们写进 config.json 的 proxy.port。" -f ($listenCandidates -join ", "))
        }
        Add-Finding -Level "Fail" -Code "ProxyPortUnreachable" `
            -Message ("无法连接 {0}:{1}。" -f $proxyHost, $proxyPort) -Hint $hint
        Add-Verdict "代理端口不通：先确认代理软件监听端口，再同步到 config.json。"
    }

    if ($config.PSObject.Properties.Name -contains "child_injection" -and -not [bool]$config.child_injection) {
        Add-Finding -Level "Warn" -Code "ChildInjectionDisabled" `
            -Message "child_injection = false，language_server 子进程不会被接管。" `
            -Hint "文档实测：关闭后可以登录但 Agent 执行失败，建议恢复为 true。"
    }
    if ([string]$config.child_injection_mode -eq "inherit") {
        Add-Finding -Level "Info" -Code "ChildInjectionInherit" `
            -Message "child_injection_mode = inherit，会注入所有子进程。" `
            -Hint "范围偏大，推荐 filtered 并显式列出关键进程。"
    }

    $targets = @($config.target_processes)
    if ($targets.Count -eq 0) {
        Add-Finding -Level "Info" -Code "TargetProcessesEmpty" `
            -Message "target_processes 为空，按默认行为注入全部子进程。"
    } elseif ([string]$config.child_injection_mode -eq "filtered") {
        $covered = @($targets | Where-Object { ([string]$_).ToLowerInvariant().Contains("language_server") })
        if ($covered.Count -eq 0) {
            Add-Finding -Level "Fail" -Code "TargetProcessesMissingBackend" `
                -Message ("target_processes = [{0}] 未覆盖 language_server。" -f ($targets -join ", ")) `
                -Hint "Antigravity 2.0 起语言服务进程改名为 language_server.exe，缺它后端仍会直连（见 docs/antigravity-2.0-issue-85.md）。"
            Add-Verdict "target_processes 未覆盖 language_server.exe：后端不会走代理，请补齐进程名。"
        } else {
            Add-Finding -Level "Pass" -Code "TargetProcessesCovered" `
                -Message ("target_processes 覆盖关键进程: {0}" -f ($targets -join ", "))
        }
    }

    $allowedPorts = @($config.proxy_rules.allowed_ports)
    if ($allowedPorts.Count -gt 0 -and -not ($allowedPorts -contains 443)) {
        Add-Finding -Level "Warn" -Code "AllowedPortsMissing443" `
            -Message ("allowed_ports = [{0}] 不含 443，HTTPS 不会走代理。" -f ($allowedPorts -join ", "))
    }

    if ($config.fake_ip -and [bool]$config.fake_ip.enabled) {
        Add-Finding -Level "Info" -Code "FakeIpEnabled" `
            -Message ("FakeIP 已启用（{0}）。" -f $config.fake_ip.cidr) `
            -Hint "若出现 198.18 段被拒绝的报错，可先关闭 FakeIP 验证。"
    }

    return $config
}

# ---------------------------------------------------------------------------
# 部署与修复
# ---------------------------------------------------------------------------

function Copy-PatchFile {
    param([string]$SrcDir, [string]$BaseDir, [string]$FileName)

    $src = Join-Path $SrcDir $FileName
    $dst = Join-Path $BaseDir $FileName
    if (-not (Test-FileExists $src)) { throw "母本缺少文件: $src" }

    $temp = Join-Path $BaseDir ("{0}.doctor-{1}.tmp" -f $FileName, [guid]::NewGuid().ToString('N').Substring(0, 8))
    try {
        Copy-Item -LiteralPath $src -Destination $temp -Force
        $srcHash = Get-FileSha256 $src
        $tempHash = Get-FileSha256 $temp
        if ($srcHash -ne $tempHash) { throw "写入后 SHA256 与母本不一致" }
        Move-Item -LiteralPath $temp -Destination $dst -Force
    } catch {
        Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
        throw
    }
    return $dst
}

function Stop-IfSourceUnsafe {
    param([string]$SrcDir, [string]$BaseDir)
    if ([string]::IsNullOrWhiteSpace($SrcDir)) { return $false }
    if (Test-PathInside $SrcDir $BaseDir) {
        Add-Finding -Level "Fail" -Code "SourceInsideInstallDir" `
            -Message ("补丁母本位于安装目录内部: {0}" -f $SrcDir) `
            -Hint "请把发布包解压到安装目录之外（例如 %LOCALAPPDATA%\antigravity-proxy\ 或独立下载目录）。自动更新会重建安装目录，放在里面的母本会和已部署补丁一起被删除，届时无法恢复。"
        Add-Verdict "母本目录必须放在安装目录之外，否则每次自动更新都会连同母本一起被删掉。"
        return $true
    }
    return $false
}

function Report-RestartNeed {
    param([bool]$AnyRunning)
    if ($AnyRunning) {
        Add-Finding -Level "Warn" -Code "RestartRequired" `
            -Message "检测到 Antigravity 相关进程正在运行，补丁只在进程创建时注入。" `
            -Hint "请完全退出应用（含系统托盘后台进程）后重新打开，否则本次修复不会生效。"
        Add-Verdict "文件已就绪，但必须完全退出并重新打开 Antigravity 才会生效。"
    }
}

function Invoke-Repair {
    param([string]$BaseDir, [string]$Variant, [string]$SrcDir)

    Write-Section "修复"
    if ([string]::IsNullOrWhiteSpace($SrcDir)) {
        Add-Finding -Level "Fail" -Code "SourceDirNotFound" `
            -Message "没有找到可用的补丁母本目录。" `
            -Hint "用 -SourceDir 指向解压后的发布包目录（内含 ide\version.dll 或 cli\dbghelp.dll），并保留它在安装目录之外作为长期恢复源。"
        Add-Verdict "缺少母本：重新下载对应版本发布包，解压到安装目录之外，再运行 -Action Repair。"
        return $false
    }
    if (Stop-IfSourceUnsafe $SrcDir $BaseDir) { return $false }

    $state = Get-RunningState -BaseDir $BaseDir -Variant $Variant
    Add-Finding -Level "Info" -Code "RepairSource" -Message ("母本目录: {0}" -f $SrcDir)

    $patchFiles = Get-PatchFileNames $Variant
    $missing = @($patchFiles | Where-Object { -not (Test-FileExists (Join-Path $BaseDir $_)) })
    if ($missing.Count -eq 0 -and -not $OverwriteConfig) {
        Add-Finding -Level "Info" -Code "NothingToRepair" `
            -Message "补丁文件都在，无需补写。" `
            -Hint "如果仍不生效，问题多半在进程加载或代理配置，看体检结论中的 DllLoaded / ProxyPortReachable。"
    }

    foreach ($file in $patchFiles) {
        $exists = Test-FileExists (Join-Path $BaseDir $file)
        if ($exists -and -not $OverwriteConfig) {
            Add-Finding -Level "Info" -Code "PatchKept" `
                -Message ("{0} 已存在，保持不动（需要用母本覆盖时加 -OverwriteConfig）。" -f $file)
            continue
        }
        try {
            $path = Copy-PatchFile -SrcDir $SrcDir -BaseDir $BaseDir -FileName $file
            Add-Finding -Level "Pass" -Code "PatchRestored" -Message ("已恢复 {0}" -f $path)
        } catch {
            Add-Finding -Level "Fail" -Code "PatchRestoreFailed" `
                -Message ("恢复 {0} 失败: {1}" -f $file, $_.Exception.Message) `
                -Hint "提示被占用说明旧 DLL 仍在内存：请先完全退出 Antigravity；提示权限不足请以管理员运行或把应用装到用户目录。"
            return $false
        }
    }

    $configDst = Join-Path $BaseDir "config.json"
    $configSrc = Join-Path $SrcDir "config.json"
    if ((Test-FileExists $configSrc) -and (-not (Test-FileExists $configDst) -or $OverwriteConfig)) {
        try {
            [void](Copy-PatchFile -SrcDir $SrcDir -BaseDir $BaseDir -FileName "config.json")
            Add-Finding -Level "Pass" -Code "ConfigRestored" -Message "已恢复 config.json。"
        } catch {
            Add-Finding -Level "Fail" -Code "ConfigRestoreFailed" `
                -Message ("恢复 config.json 失败: {0}" -f $_.Exception.Message)
            return $false
        }
    } elseif (Test-FileExists $configDst) {
        Add-Finding -Level "Info" -Code "ConfigPreserved" `
            -Message "保留安装目录内已有的 config.json，避免把你配好的端口重置回默认值。"
    }

    Report-RestartNeed -AnyRunning (($state.HostRunning + $state.ChildRunning) -gt 0)
    return $true
}

function New-ProxyProfile {
    param(
        [string]$ProxyHostValue,
        [int]$ProxyPortValue,
        [string]$ProxyTypeValue,
        [AllowNull()]$Base
    )

    # 以母本 config.json 为模板，只改写代理三要素，保留上游其它默认值。
    $root = $Base
    if (-not $root) {
        $root = [pscustomobject]@{
            log_level               = "info"
            child_injection         = $true
            child_injection_mode    = "filtered"
            child_injection_exclude = @()
            traffic_logging         = $false
            fake_ip                 = @{ enabled = $false; cidr = "198.18.0.0/15" }
            timeout                 = @{ connect = 10000; recv = 15000; send = 10000 }
            diagnostics             = @{ agent_ip_probe = $false }
            proxy_rules             = @{
                allowed_ports = @(80, 443)
                dns_mode      = "direct"
                ipv6_mode     = "proxy"
                udp_mode      = "auto"
                udp_fallback  = "block"
                routing       = @{
                    enabled             = $true
                    priority_mode       = "order"
                    default_action      = "proxy"
                    use_default_private = $true
                    rules               = @()
                }
            }
            target_processes        = @(
                "Antigravity.exe", "Antigravity IDE.exe", "agy.exe",
                "language_server.exe", "language_server_windows", "node.exe"
            )
        }
    }

    $names = @($root.PSObject.Properties.Name)
    $root | Add-Member -NotePropertyName "proxy" `
        -NotePropertyValue ([pscustomobject]@{
            type = $ProxyTypeValue
            host = $ProxyHostValue
            port = $ProxyPortValue
        }) -Force

    if ($names -notcontains "target_processes") {
        $root | Add-Member -NotePropertyName "target_processes" -NotePropertyValue @(
            "Antigravity.exe", "Antigravity IDE.exe", "agy.exe",
            "language_server.exe", "language_server_windows", "node.exe"
        )
    } else {
        # 已含 language_server 就保持用户列表，只补上缺失的关键名。
        $targets = @($root.target_processes | ForEach-Object { [string]$_ })
        $coversBackend = @($targets | Where-Object { $_.ToLowerInvariant().Contains("language_server") }).Count -gt 0
        if (-not $coversBackend) {
            $merged = $targets + @("language_server.exe")
            $root | Add-Member -NotePropertyName "target_processes" -NotePropertyValue $merged -Force
        }
    }
    if ($names -notcontains "child_injection") {
        $root | Add-Member -NotePropertyName "child_injection" -NotePropertyValue $true
    }
    if ($names -notcontains "child_injection_mode") {
        $root | Add-Member -NotePropertyName "child_injection_mode" -NotePropertyValue "filtered"
    }
    return $root
}

function Resolve-ProxySettings {
    param([string]$BaseDir)

    $hostValue = $ProxyHost
    $portValue = $ProxyPort
    $typeValue = $ProxyType

    $existing = Read-JsonFile (Join-Path $BaseDir "config.json")
    if ($existing -and $existing.proxy) {
        if ([string]::IsNullOrWhiteSpace($hostValue)) { $hostValue = [string]$existing.proxy.host }
        if ($portValue -eq 0) { $portValue = [int]$existing.proxy.port }
        if ([string]::IsNullOrWhiteSpace($typeValue)) { $typeValue = [string]$existing.proxy.type }
    }
    if ([string]::IsNullOrWhiteSpace($hostValue)) { $hostValue = "127.0.0.1" }

    $listening = @($script:CommonProxyPorts | Where-Object { Test-TcpPort -ComputerName $hostValue -Port $_ })
    if ($portValue -eq 0) {
        if ($listening.Count -gt 0) {
            $portValue = $listening[0]
            Add-Finding -Level "Info" -Code "ProxyPortAutoDetected" `
                -Message ("自动探测到本机代理端口 {0}（候选: {1}）" -f $portValue, ($listening -join ", "))
        } elseif ($Yes -or -not [Environment]::UserInteractive) {
            $portValue = 7890
            Add-Finding -Level "Warn" -Code "ProxyPortGuessed" `
                -Message "探测不到任何常用代理端口，暂用 7890。" `
                -Hint "确认代理软件已启动，或用 -ProxyPort 指定真实端口后重跑 -Action Setup。"
        } else {
            $typed = Read-Host "未探测到代理端口，请输入本地代理端口"
            if ($typed -match '^\d+$') { $portValue = [int]$typed } else { $portValue = 7890 }
        }
    } elseif ($listening.Count -gt 0 -and -not ($listening -contains $portValue)) {
        Add-Finding -Level "Warn" -Code "ProxyPortNotListening" `
            -Message ("指定端口 {0} 当前不可达，本机在听的是 {1}。" -f $portValue, ($listening -join ", ")) `
            -Hint "确认代理软件端口设置，或改用探测到的端口。"
    }
    if ([string]::IsNullOrWhiteSpace($typeValue)) { $typeValue = "socks5" }

    return [pscustomobject]@{ Host = $hostValue; Port = $portValue; Type = $typeValue }
}

function Invoke-Setup {
    param([string]$BaseDir, [string]$Variant, [string]$SrcDir)

    Write-Section "首次部署"
    if ([string]::IsNullOrWhiteSpace($SrcDir)) {
        Add-Finding -Level "Fail" -Code "SourceDirNotFound" `
            -Message "没有找到补丁母本，无法部署。" `
            -Hint "请在解压后的发布包目录内运行本脚本，或用 -SourceDir 指定。"
        return $false
    }
    if (Stop-IfSourceUnsafe $SrcDir $BaseDir) { return $false }

    $state = Get-RunningState -BaseDir $BaseDir -Variant $Variant
    $proxy = Resolve-ProxySettings $BaseDir
    $template = Read-JsonFile (Join-Path $SrcDir "config.json")
    $profile = New-ProxyProfile -ProxyHostValue $proxy.Host -ProxyPortValue $proxy.Port `
        -ProxyTypeValue $proxy.Type -Base $template

    Write-Line ("目标目录 : {0}" -f $BaseDir) "White"
    Write-Line ("补丁母本 : {0}" -f $SrcDir) "White"
    Write-Line ("产品类型 : {0}" -f $Variant) "White"
    Write-Line ("代理设置 : {0}:{1} ({2})" -f $proxy.Host, $proxy.Port, $proxy.Type) "White"
    Write-Line ("部署文件 : {0}" -f (((Get-PatchFileNames $Variant) + "config.json") -join ", ")) "White"

    if (($state.HostRunning + $state.ChildRunning) -gt 0) {
        Add-Finding -Level "Warn" -Code "AppRunningDuringSetup" `
            -Message "检测到 Antigravity 相关进程正在运行。" `
            -Hint "部署会照常写入文件，但正在运行的进程不会加载新补丁；若提示文件被占用，请先完全退出应用。"
    }

    if (-not $Yes -and [Environment]::UserInteractive) {
        if (-not (Confirm-Choice "确认执行部署")) {
            Add-Finding -Level "Info" -Code "Cancelled" -Message "用户取消部署。"
            return $false
        }
    }

    foreach ($file in (Get-PatchFileNames $Variant)) {
        try {
            $path = Copy-PatchFile -SrcDir $SrcDir -BaseDir $BaseDir -FileName $file
            Add-Finding -Level "Pass" -Code "PatchDeployed" -Message ("已部署 {0}" -f $path)
        } catch {
            Add-Finding -Level "Fail" -Code "PatchDeployFailed" `
                -Message ("部署 {0} 失败: {1}" -f $file, $_.Exception.Message) `
                -Hint "文件被占用时请先完全退出 Antigravity；权限不足时以管理员运行，或把应用安装到用户目录。"
            return $false
        }
    }

    $configDst = Join-Path $BaseDir "config.json"
    if ((Test-FileExists $configDst) -and -not $OverwriteConfig) {
        Add-Finding -Level "Info" -Code "ConfigPreserved" `
            -Message "安装目录已有 config.json，未覆盖（需要按新代理端口重写请加 -OverwriteConfig）。"
    } else {
        try {
            Write-JsonFile -Path $configDst -Object $profile
            Add-Finding -Level "Pass" -Code "ConfigWritten" -Message ("已写出 {0}" -f $configDst)
        } catch {
            Add-Finding -Level "Fail" -Code "ConfigWriteFailed" `
                -Message ("写入 config.json 失败: {0}" -f $_.Exception.Message)
            return $false
        }
    }

    Report-RestartNeed -AnyRunning (($state.HostRunning + $state.ChildRunning) -gt 0)
    if (-not (Test-PathInside $SrcDir $BaseDir)) {
        Add-Verdict "部署完成：启动 Antigravity 后再次运行本脚本体检，确认补丁已被进程加载。"
    }
    return $true
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

function Resolve-TargetDirs {
    if (-not [string]::IsNullOrWhiteSpace($InstallDir)) {
        $specified = Get-NormalizedPath $InstallDir
        if (-not (Test-AntigravityDir $specified)) {
            Add-Finding -Level "Fail" -Code "InstallDirInvalid" `
                -Message ("指定目录不是 Antigravity 安装目录: {0}" -f $specified) `
                -Hint "应传入与 Antigravity.exe（CLI 场景为 agy.exe）同级的目录。"
            return @()
        }
        return @($specified)
    }

    $dirs = Find-InstallDirs
    if ($dirs.Count -eq 0) {
        Add-Finding -Level "Fail" -Code "InstallDirNotFound" `
            -Message "未发现 Antigravity 安装目录。" `
            -Hint "用 -InstallDir 指定实际在用的安装目录。"
        Add-Verdict "找不到安装目录：确认应用安装位置后用 -InstallDir 指定。"
        return @()
    }
    if ($dirs.Count -gt 1) {
        Add-Finding -Level "Warn" -Code "InstallDirAmbiguous" `
            -Message ("发现多个安装目录: {0}" -f ($dirs -join " | ")) `
            -Hint "补丁要放在实际启动使用的那个目录；用 -InstallDir 固定后体检更准确。"
    }
    return $dirs
}

function Complete-TargetReport {
    param([string]$BaseDir, [string]$Variant, [string]$SrcDir)

    Write-Section "结论"
    if ($Json) {
        [void]$script:Results.Add([pscustomobject]@{
            install_dir = $BaseDir
            variant     = $Variant
            source_dir  = $SrcDir
            findings    = @($script:Findings)
            verdicts    = @($script:Verdicts)
        })
        return
    }

    if ($script:Verdicts.Count -gt 0) {
        foreach ($verdict in $script:Verdicts) {
            Write-Host ("  -> {0}" -f $verdict) -ForegroundColor Cyan
        }
    } else {
        $fail = Get-LevelCount "Fail"
        $warn = Get-LevelCount "Warn"
        if ($fail -eq 0 -and $warn -eq 0) {
            Write-Host "  一切正常：补丁已部署、进程已加载、代理隧道可用。" -ForegroundColor Green
        } elseif ($fail -eq 0) {
            Write-Host "  未发现阻断性问题，存在需要留意的告警。" -ForegroundColor Green
        } else {
            Write-Host ("  存在 {0} 项错误，请按上面标记为 [错误] 的条目处理。" -f $fail) -ForegroundColor Red
        }
    }
}

function Invoke-Diagnose {
    $dirs = Resolve-TargetDirs
    if ($dirs.Count -eq 0) {
        $script:WorstExitCode = 3
        Complete-TargetReport -BaseDir "" -Variant "" -SrcDir ""
        return
    }

    foreach ($dir in $dirs) {
        $variant = Get-VariantOfDir $dir
        $srcDir = Find-SourceDir -Variant $variant -KnownInstallDir $dir
        $script:Findings = New-Object System.Collections.ArrayList
        $script:Verdicts = New-Object System.Collections.ArrayList

        Write-Section "目标: $dir"
        Add-Finding -Level "Info" -Code "TargetVariant" `
            -Message ("产品类型: {0}；母本: {1}" -f $variant, $(if ($srcDir) { $srcDir } else { "未发现" }))

        [void](Test-PatchFiles -BaseDir $dir -Variant $variant -SrcDir $srcDir)
        [void](Test-ConfigContent -BaseDir $dir -Variant $variant)
        $filesMissing = (Get-CodeCount "PatchMissing" -Level "Fail") -gt 0

        Write-Section "运行状态"
        $state = Get-RunningState -BaseDir $dir -Variant $variant
        if (($state.HostRunning + $state.ChildRunning) -eq 0) {
            Add-Finding -Level "Info" -Code "AppNotRunning" `
                -Message "目标进程未运行，无法验证补丁是否被加载。" `
                -Hint "启动 Antigravity 后再体检一次；补丁只在进程创建时注入。"
        } else {
            foreach ($sample in $state.Samples) { Write-Line ("    " + $sample) "DarkGray" }
            foreach ($path in $state.InjectedPaths) { Write-Line ("    补丁路径: " + $path) "DarkGray" }

            if ($state.HostInjected -eq 0 -and $state.HostRunning -gt 0) {
                Add-Finding -Level "Fail" -Code "DllNotLoaded" `
                    -Message ("{0} 个主进程正在运行，但没有一个从安装目录加载补丁 DLL。" -f $state.HostRunning) `
                    -Hint "文件在但没加载，通常是应用没重启，或文件放到了别的安装目录；确认与主程序同级后完全退出并重开。"
                Add-Verdict "补丁未被进程加载：完全退出 Antigravity，确认文件与主程序同级后重新打开。"
            } elseif ($state.ChildRunning -gt 0 -and $state.ChildInjected -eq 0) {
                Add-Finding -Level "Fail" -Code "ChildNotInjected" `
                    -Message "主进程已加载补丁，但 language_server / node 子进程没有被注入。" `
                    -Hint "检查 child_injection、child_injection_mode 与 target_processes（docs/antigravity-2.0-issue-85.md）。"
                Add-Verdict "后端子进程未被注入：Go 进程仍会直连，主页会停在白屏。"
            } elseif ($state.HostInjected -gt 0) {
                if ($filesMissing) {
                    Add-Finding -Level "Warn" -Code "DllLoadedFromDeletedFile" `
                        -Message ("补丁已被 {0} 个主进程加载，但安装目录里已经找不到补丁文件。" -f $state.HostInjected) `
                        -Hint "典型场景：自动更新删掉了文件，当前进程还在使用内存中的旧镜像，下次启动就会失效。请现在运行 -Action Repair 补回。"
                    Add-Verdict "补丁文件已丢失、旧副本仍在内存里运行：趁现在还能用，立刻运行 -Action Repair 补回文件。"
                } else {
                    Add-Finding -Level "Pass" -Code "DllLoaded" `
                        -Message ("补丁已被 {0} 个主进程、{1} 个子进程加载。" -f $state.HostInjected, $state.ChildInjected)
                }
            }
            if (-not $state.EnumerateOk) {
                Add-Finding -Level "Info" -Code "ModuleEnumPartial" `
                    -Message "部分进程的模块列表无法枚举，运行状态判断可能不完整。" `
                    -Hint "以管理员身份重新运行可获得更准确的判断。"
            }
        }

        $loadedHealthy = (Get-CodeCount "DllLoaded" -Level "Pass") -gt 0
        [void](Test-ProxyLogs $dir)
        [void](Test-AppLogs -PatchLoaded $loadedHealthy)

        if ([string]::IsNullOrWhiteSpace($srcDir) -and (Get-CodeCount "PatchMissing" -Level "Fail") -gt 0) {
            Add-Finding -Level "Warn" -Code "NoLocalSourceCopy" `
                -Message "安装目录内补丁缺失，且本机没有可用的发布包母本。" `
                -Hint "重新下载对应架构的 Release 包，解压到安装目录之外（例如 %LOCALAPPDATA%\antigravity-proxy\）作为长期恢复源，再运行 -Action Repair。"
            Add-Verdict "本机没有母本副本：把发布包解压到安装目录之外保存，之后每次更新后用 -Action Repair 一键补回。"
        }

        if ((Get-LevelCount "Fail") -gt 0) {
            $script:WorstExitCode = [Math]::Max($script:WorstExitCode, 1)
        }
        Complete-TargetReport -BaseDir $dir -Variant $variant -SrcDir $srcDir
    }
}

function Invoke-RepairAction {
    $dirs = Resolve-TargetDirs
    if ($dirs.Count -eq 0) {
        $script:WorstExitCode = 3
        Complete-TargetReport -BaseDir "" -Variant "" -SrcDir ""
        return
    }

    foreach ($dir in $dirs) {
        $variant = Get-VariantOfDir $dir
        $srcDir = Find-SourceDir -Variant $variant -KnownInstallDir $dir
        $script:Findings = New-Object System.Collections.ArrayList
        $script:Verdicts = New-Object System.Collections.ArrayList

        Write-Section "目标: $dir"
        $ok = $false
        if ($Action -eq "Setup") {
            $ok = Invoke-Setup -BaseDir $dir -Variant $variant -SrcDir $srcDir
        } else {
            $ok = Invoke-Repair -BaseDir $dir -Variant $variant -SrcDir $srcDir
        }

        Write-Section "修复后复检"
        [void](Test-PatchFiles -BaseDir $dir -Variant $variant -SrcDir $srcDir)
        [void](Test-ConfigContent -BaseDir $dir -Variant $variant)

        if ($ok -and -not [string]::IsNullOrWhiteSpace($srcDir)) {
            Save-DoctorSource -BaseDir $dir -Variant $variant -SrcDir $srcDir
        }

        if (-not $ok) {
            Write-Section "结论"
            Write-Host "  未能自动完成，请按上面各条目的建议逐项处理。" -ForegroundColor Red
            $script:WorstExitCode = [Math]::Max($script:WorstExitCode, 2)
        } elseif ((Get-LevelCount "Fail") -gt 0) {
            $script:WorstExitCode = [Math]::Max($script:WorstExitCode, 1)
        }
        Complete-TargetReport -BaseDir $dir -Variant $variant -SrcDir $srcDir
    }
}

if (-not $NoRun) {
    if (-not $Json) {
        Write-Host "Antigravity-Proxy 体检 / 一键部署" -ForegroundColor White
        Write-Host ("模式: {0}    时间: {1}" -f $Action, (Get-Date -Format "yyyy-MM-dd HH:mm:ss")) -ForegroundColor DarkGray
    }

    if ($Action -eq "Diagnose") {
        Invoke-Diagnose
    } else {
        Invoke-RepairAction
    }

    if ($Json) {
        $payload = [pscustomobject]@{
            action    = $Action
            generated = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
            results   = @($script:Results)
            exit_code = $script:WorstExitCode
        }
        Write-Output ($payload | ConvertTo-Json -Depth 12)
    }

    if (-not $Json) {
        Write-Host ""
        switch ($script:WorstExitCode) {
            0 { Write-Host "退出码 0：未发现阻断性问题。" -ForegroundColor Green }
            1 { Write-Host "退出码 1：存在需要修复的问题（可运行 -Action Repair）。" -ForegroundColor Yellow }
            2 { Write-Host "退出码 2：自动修复未完成。" -ForegroundColor Red }
            3 { Write-Host "退出码 3：环境或参数问题（安装目录 / 母本缺失）。" -ForegroundColor Red }
        }
    }
    exit $script:WorstExitCode
}
