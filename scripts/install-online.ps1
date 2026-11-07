<#
.SYNOPSIS
    Antigravity-Proxy Windows 在线安装：自动检测已安装的 Antigravity 产品，下载对应 Release 包，
    校验后解压到本机母本目录，再调用包内 doctor.ps1 完成部署。

.DESCRIPTION
    一行命令（在 PowerShell 中粘贴执行，经 wget.la 镜像获取本脚本）：

      [Net.ServicePointManager]::SecurityProtocol=3072; & ([scriptblock]::Create((New-Object Net.WebClient).DownloadString('https://wget.la/https://raw.githubusercontent.com/yuaotian/antigravity-proxy/main/scripts/install-online.ps1')))

    需要传参时把参数加在末尾，例如 ... install-online.ps1'))) -Product ide -Version 2.5

    流程：
      1. 检测 Antigravity IDE（Antigravity IDE.exe）、Antigravity（Antigravity.exe）、Antigravity CLI（agy.exe）
      2. 获取版本（默认最新，GitHub API 直连失败时依次走镜像）
      3. 下载对应架构的发布包：直连 GitHub 与镜像依次尝试；有 SHA256SUMS.txt 时校验，取不到清单只告警不阻断
      4. 解压到 %LOCALAPPDATA%\antigravity-proxy\<版本>\（安装目录之外，日后 IDE 更新冲掉补丁时可据此修复）
      5. 调用 doctor.ps1 -Action Setup 部署补丁与 config.json（已有 config.json 不覆盖；IDE 会同时安装配套插件）

    下载优先使用环境变量 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY（http 代理），否则使用系统代理。

.PARAMETER Version
    指定版本（如 2.5 或 v2.5.1），默认安装最新版本。

.PARAMETER Product
    只安装指定产品：ide（Antigravity IDE）、desktop（Antigravity）、cli（Antigravity CLI）或 all。
    默认检测到多个时询问。

.PARAMETER InstallDir
    手动指定安装目录（与主程序同级），跳过自动检测。

.PARAMETER ProxyPort
    透传给 doctor.ps1：本地代理端口，默认自动探测。

.PARAMETER Yes
    不询问，直接安装全部检测到的产品。
#>
[CmdletBinding()]
param(
    [string]$Version = "",
    [ValidateSet("", "all", "ide", "desktop", "cli")]
    [string]$Product = "",
    [string]$InstallDir = "",
    [int]$ProxyPort = 0,
    [switch]$Yes
)

$ErrorActionPreference = "Stop"

# 作为 .ps1 文件运行时才用 exit 返回退出码；经 scriptblock 在线执行时 exit 会关掉用户的 PowerShell 窗口
$script:RunAsFile = [bool]$MyInvocation.MyCommand.Path
$script:ExitCode = 0

$script:Repo = "yuaotian/antigravity-proxy"
$script:Root = Join-Path $env:LOCALAPPDATA "antigravity-proxy"
# 下载源："" 表示直连 GitHub，其余为 GitHub 代理站（与 DLL 更新检查 updates.mirrors 默认值一致）；
# 成功的源会被提到最前，后续下载优先复用
$script:Sources = @(
    "",
    "https://wget.la/",
    "https://rapidgit.jjda.de5.net/",
    "https://fastgit.cc/",
    "https://gitproxy.mrhjx.cn/",
    "https://github.boki.moe/",
    "https://github.ednovas.xyz/"
)
$script:WebProxy = $null
$script:ReleaseAssets = @()

# ---------------------------------------------------------------------------
# 三语提示：zh* → 中文，ru* → 俄文，其余英文。先看界面语言，不是中/俄时再看区域格式
# （常见情况：英文界面 + 中文区域的用户仍以中文阅读）
# ---------------------------------------------------------------------------

$script:LangIndex = 1
foreach ($cultureName in @([Globalization.CultureInfo]::CurrentUICulture.Name, [Globalization.CultureInfo]::CurrentCulture.Name)) {
    if ($cultureName -like "zh*") { $script:LangIndex = 0; break }
    if ($cultureName -like "ru*") { $script:LangIndex = 2; break }
}

$script:Msg = @{
    Title           = @("Antigravity Proxy 在线安装", "Antigravity Proxy online installer", "Онлайн-установка Antigravity Proxy")
    ProxyEnv        = @("下载使用环境变量代理：{0}", "Downloading via proxy from environment: {0}", "Загрузка через прокси из переменных окружения: {0}")
    Detecting       = @("检测已安装的产品...", "Detecting installed products...", "Поиск установленных продуктов...")
    NoneFound       = @("未检测到 Antigravity IDE / Antigravity / Antigravity CLI。可用 -InstallDir 指定安装目录（与主程序同级）。",
                        "No Antigravity IDE / Antigravity / Antigravity CLI found. Use -InstallDir to specify the install folder (next to the main executable).",
                        "Antigravity IDE / Antigravity / Antigravity CLI не найдены. Укажите каталог установки через -InstallDir (рядом с исполняемым файлом).")
    InstallDirBad   = @("指定目录中没有 Antigravity IDE.exe / Antigravity.exe / agy.exe：{0}",
                        "No Antigravity IDE.exe / Antigravity.exe / agy.exe in: {0}",
                        "В каталоге нет Antigravity IDE.exe / Antigravity.exe / agy.exe: {0}")
    ProductMissing  = @("未检测到指定产品：{0}", "Requested product not found: {0}", "Указанный продукт не найден: {0}")
    SelectPrompt    = @("输入要安装的序号（多个用逗号分隔，直接回车 = 全部）", "Enter numbers to install (comma separated, Enter = all)", "Введите номера для установки (через запятую, Enter = все)")
    NothingSelected = @("未选择任何产品。", "Nothing selected.", "Ничего не выбрано.")
    ArchSkip        = @("{0} 是 {1} 程序，暂无对应补丁，已跳过。", "{0} is a {1} binary; no matching build, skipped.", "{0} — сборка {1}, подходящего патча нет, пропущено.")
    ResolvingTag    = @("获取最新版本...", "Fetching latest version...", "Получение последней версии...")
    TagFailed       = @("无法获取最新版本（GitHub 与镜像均不可达）。请检查网络或代理，或用 -Version 指定版本。",
                        "Cannot fetch the latest version (GitHub and mirrors unreachable). Check your network/proxy, or pass -Version.",
                        "Не удалось получить последнюю версию (GitHub и зеркала недоступны). Проверьте сеть/прокси или укажите -Version.")
    VersionBad      = @("版本号格式错误：{0}（应为 2.5 或 2.5.1）", "Invalid version: {0} (expected 2.5 or 2.5.1)", "Неверный формат версии: {0} (ожидается 2.5 или 2.5.1)")
    Plan            = @("即将安装 {0}：", "About to install {0}:", "Будет установлено {0}:")
    Confirm         = @("确认安装？[Y/n]", "Proceed? [Y/n]", "Продолжить? [Y/n]")
    Cancelled       = @("已取消。", "Cancelled.", "Отменено.")
    SumsMissing     = @("未取到校验清单 SHA256SUMS.txt（旧版本未提供或网络问题），跳过完整性校验。",
                        "SHA256SUMS.txt unavailable (older release or network issue); skipping integrity check.",
                        "SHA256SUMS.txt недоступен (старый релиз или проблема сети); проверка целостности пропущена.")
    Downloading     = @("下载 {0}", "Downloading {0}", "Загрузка {0}")
    SourceFailed    = @("  {0} 不可用：{1}", "  {0} failed: {1}", "  {0} недоступен: {1}")
    NotZip          = @("返回内容不是 zip", "response is not a zip file", "ответ не является zip-архивом")
    HashMismatch    = @("SHA256 与校验清单不一致", "SHA256 does not match the checksum list", "SHA256 не совпадает со списком контрольных сумм")
    Verified        = @("  已下载并通过 SHA256 校验（来源：{0}）", "  Downloaded and SHA256 verified (from {0})", "  Загружено, SHA256 проверен (источник: {0})")
    NotVerified     = @("  已下载（来源：{0}，未校验）", "  Downloaded (from {0}, not verified)", "  Загружено (источник: {0}, без проверки)")
    DownloadFailed  = @("{0} 下载失败：所有下载源均不可用。", "{0}: download failed on all sources.", "{0}: загрузка не удалась ни с одного источника.")
    Extracted       = @("  已解压到 {0}", "  Extracted to {0}", "  Распаковано в {0}")
    DoctorFallback  = @("  该版本发布包不含 doctor.ps1，改用仓库最新的部署脚本。", "  This release has no doctor.ps1; using the latest one from the repository.", "  В этом релизе нет doctor.ps1; используется последняя версия из репозитория.")
    DoctorMissing   = @("无法获取部署脚本 doctor.ps1。", "Cannot obtain deployment script doctor.ps1.", "Не удалось получить скрипт развёртывания doctor.ps1.")
    Running         = @("{0} 正在运行：补丁文件被占用时部署会失败，运行中的进程也要重启后才生效。",
                        "{0} is running: deployment fails if the patch file is in use, and running processes need a restart.",
                        "{0} запущен: развёртывание не удастся, если файл патча занят; запущенные процессы нужно перезапустить.")
    RunningPrompt   = @("请完全退出 {0} 后按回车继续（输入 s 跳过该产品）", "Fully quit {0}, then press Enter (type s to skip it)", "Полностью закройте {0} и нажмите Enter (введите s, чтобы пропустить)")
    Deploying       = @("部署 {0} → {1}", "Deploying {0} → {1}", "Развёртывание {0} → {1}")
    Summary         = @("安装结果", "Result", "Результат")
    ResultOk        = @("完成", "done", "готово")
    ResultWarn      = @("已部署，有需要留意的提示（见上方输出）", "deployed, with warnings (see output above)", "развёрнуто, есть предупреждения (см. вывод выше)")
    ResultFail      = @("失败（doctor 退出码 {0}）", "failed (doctor exit code {0})", "ошибка (код выхода doctor {0})")
    ResultSkip      = @("已跳过", "skipped", "пропущено")
    NextRestart     = @("重启对应应用后生效。", "Restart the application(s) to take effect.", "Перезапустите приложение(я), чтобы изменения вступили в силу.")
    NextIde         = @("Antigravity IDE：已安装配套插件，点击底部状态栏即可设置代理；IDE 更新冲掉补丁时插件会自动恢复。",
                        "Antigravity IDE: the companion extension is installed; click the status bar to configure the proxy. It restores the patch after IDE updates.",
                        "Antigravity IDE: установлено сопутствующее расширение; нажмите на строку состояния для настройки прокси. Оно восстанавливает патч после обновлений IDE.")
    NextRepair      = @("应用更新后补丁丢失时运行：", "If an app update removes the patch, run:", "Если обновление удалило патч, выполните:")
}

function T([string]$Key) { return $script:Msg[$Key][$script:LangIndex] }

function Write-Info([string]$Text) { Write-Host $Text -ForegroundColor Cyan }
function Write-Ok([string]$Text) { Write-Host $Text -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host $Text -ForegroundColor Yellow }
function Write-Err([string]$Text) { Write-Host $Text -ForegroundColor Red }
function Write-Dim([string]$Text) { Write-Host $Text -ForegroundColor DarkGray }

# ---------------------------------------------------------------------------
# 下载
# ---------------------------------------------------------------------------

# WebRequest 不读 HTTPS_PROXY 等环境变量（PS 5.1），只开了“端口代理”没开系统代理的用户会直连失败，这里显式接上；
# SOCKS 代理 WebRequest 不支持，跳过后回落到系统代理
function Initialize-WebProxy {
    foreach ($name in @("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY")) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ([string]::IsNullOrWhiteSpace($value)) { continue }
        $value = $value.Trim()
        if ($value -notmatch '^[a-zA-Z][a-zA-Z0-9+.-]*://') { $value = "http://$value" }
        if ($value -notmatch '^https?://') { continue }
        try {
            $script:WebProxy = New-Object Net.WebProxy($value, $true)
            Write-Dim ((T "ProxyEnv") -f $value)
            return
        } catch { }
    }
}

function Get-InnerMessage($ErrorRecord) {
    $e = $ErrorRecord.Exception
    while ($e.InnerException) { $e = $e.InnerException }
    return $e.Message
}

# 读取整个响应为字节数组；Timeout 控制建连与响应头，ReadWriteTimeout 防止慢速源无限拖住
function Get-WebBytes([string]$Url, [int]$TimeoutSec) {
    $req = [Net.WebRequest]::Create($Url)
    $req.Timeout = $TimeoutSec * 1000
    $req.ReadWriteTimeout = 30000
    $req.UserAgent = "antigravity-proxy-online-installer"
    if ($script:WebProxy) { $req.Proxy = $script:WebProxy }
    $resp = $req.GetResponse()
    try {
        $ms = New-Object IO.MemoryStream
        $resp.GetResponseStream().CopyTo($ms)
        return , $ms.ToArray()
    } finally {
        $resp.Close()
    }
}

function Get-SourceLabel([string]$Source) {
    if ([string]::IsNullOrEmpty($Source)) { return "github.com" }
    return ([Uri]$Source).Host
}

# 依次尝试各下载源（直连 + 镜像）。Validate 返回非空字符串表示内容不合格（如镜像返回了错误页），继续换源；
# 全部失败返回 $null，由调用方决定是否阻断
function Invoke-Sources([string]$Target, [int]$TimeoutSec, [scriptblock]$Validate, $State = $null) {
    foreach ($source in @($script:Sources)) {
        $label = Get-SourceLabel $source
        try {
            $bytes = Get-WebBytes ($source + $Target) $TimeoutSec
            $problem = & $Validate $bytes $State
            if ($problem) {
                Write-Dim ((T "SourceFailed") -f $label, $problem)
                continue
            }
            $script:Sources = @($source) + @($script:Sources | Where-Object { $_ -ne $source })
            return [pscustomobject]@{ Bytes = $bytes; Source = $label }
        } catch {
            Write-Dim ((T "SourceFailed") -f $label, (Get-InnerMessage $_))
        }
    }
    return $null
}

function Get-Sha256Hex([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace("-", "") }
    finally { $sha.Dispose() }
}

function Resolve-ReleaseTag {
    if (-not [string]::IsNullOrWhiteSpace($Version)) {
        $v = $Version.Trim() -replace '^[vV]', ''
        if ($v -notmatch '^\d+\.\d+(\.\d+)?$') {
            Write-Err ((T "VersionBad") -f $Version)
            return ""
        }
        return "v$v"
    }
    Write-Info (T "ResolvingTag")
    $result = Invoke-Sources -Target "https://api.github.com/repos/$($script:Repo)/releases/latest" -TimeoutSec 8 -Validate {
        param($b)
        try {
            $json = [Text.Encoding]::UTF8.GetString($b) | ConvertFrom-Json
            if ([string]$json.tag_name -match '^v\d') { return "" }
        } catch { }
        return "no tag_name"
    }
    if (-not $result) {
        Write-Err (T "TagFailed")
        return ""
    }
    $release = [Text.Encoding]::UTF8.GetString($result.Bytes) | ConvertFrom-Json
    # 记下资产清单：没有 SHA256SUMS.txt 的旧版本直接跳过校验，不必逐个源试探
    $script:ReleaseAssets = @($release.assets | ForEach-Object { [string]$_.name })
    return [string]$release.tag_name
}

# 校验清单（v2.5 起随 Release 发布）：取不到只告警不阻断；取到后逐个资产比对，不一致则换源
function Get-ReleaseChecksums([string]$Tag) {
    if ($script:ReleaseAssets.Count -gt 0 -and $script:ReleaseAssets -notcontains "SHA256SUMS.txt") {
        Write-Warn (T "SumsMissing")
        return $null
    }
    $result = Invoke-Sources -Target "https://github.com/$($script:Repo)/releases/download/$Tag/SHA256SUMS.txt" -TimeoutSec 8 -Validate {
        param($b)
        if ([Text.Encoding]::ASCII.GetString($b) -match '(?m)^[0-9a-fA-F]{64}\s') { return "" }
        return "not a checksum list"
    }
    if (-not $result) {
        Write-Warn (T "SumsMissing")
        return $null
    }
    $map = @{}
    foreach ($line in ([Text.Encoding]::ASCII.GetString($result.Bytes) -split "`r?`n")) {
        if ($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(\S.*?)\s*$') { $map[$Matches[2]] = $Matches[1].ToUpperInvariant() }
    }
    return $map
}

# 下载并解压发布包到 %LOCALAPPDATA%\antigravity-proxy\<tag>\<variant>-win-<arch>，返回包目录；失败返回空串
function Install-ReleasePackage([string]$Tag, [string]$Variant, [string]$Arch, $Checksums) {
    $asset = "antigravity-proxy-$Tag-$Variant-win-$Arch.zip"
    $expected = if ($Checksums) { $Checksums[$asset] } else { $null }
    Write-Info ((T "Downloading") -f $asset)

    $result = Invoke-Sources -Target "https://github.com/$($script:Repo)/releases/download/$Tag/$asset" -TimeoutSec 20 -State $expected -Validate {
        param($b, $hash)
        # 镜像出错时可能返回 200 + HTML 错误页，先看 zip 魔数
        if ($b.Length -lt 4 -or $b[0] -ne 0x50 -or $b[1] -ne 0x4B) { return (T "NotZip") }
        if ($hash -and (Get-Sha256Hex $b) -ne $hash) { return (T "HashMismatch") }
        return ""
    }
    if (-not $result) {
        Write-Err ((T "DownloadFailed") -f $asset)
        return ""
    }
    if ($expected) { Write-Ok ((T "Verified") -f $result.Source) } else { Write-Dim ((T "NotVerified") -f $result.Source) }

    $pkgDir = Join-Path $script:Root "$Tag\$Variant-win-$Arch"
    $zipPath = Join-Path $script:Root "$asset.download"
    New-Item -ItemType Directory -Path $script:Root -Force | Out-Null
    [IO.File]::WriteAllBytes($zipPath, $result.Bytes)
    try {
        # 重新安装同一版本时先清空，避免旧文件残留
        if (Test-Path -LiteralPath $pkgDir) { Remove-Item -LiteralPath $pkgDir -Recurse -Force }
        New-Item -ItemType Directory -Path $pkgDir -Force | Out-Null
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $pkgDir)
    } finally {
        Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
    }
    Write-Dim ((T "Extracted") -f $pkgDir)

    # v2.4 及更早的发布包不含 doctor.ps1：从仓库主分支取（同样走直连 + 镜像）
    $doctor = Join-Path $pkgDir "doctor.ps1"
    if (-not (Test-Path -LiteralPath $doctor -PathType Leaf)) {
        Write-Dim (T "DoctorFallback")
        $raw = Invoke-Sources -Target "https://raw.githubusercontent.com/$($script:Repo)/main/scripts/doctor.ps1" -TimeoutSec 15 -Validate {
            param($b)
            if ([Text.Encoding]::UTF8.GetString($b) -match 'function Invoke-Setup') { return "" }
            return "not doctor.ps1"
        }
        if (-not $raw) {
            Write-Err (T "DoctorMissing")
            return ""
        }
        # 原样写入字节，保留 UTF-8 BOM（PS 5.1 依赖 BOM 识别中文）
        [IO.File]::WriteAllBytes($doctor, $raw.Bytes)
    }
    return $pkgDir
}

# ---------------------------------------------------------------------------
# 产品检测
# ---------------------------------------------------------------------------

$script:ProductDefs = @(
    [pscustomobject]@{ Key = "ide"; Name = "Antigravity IDE"; Exe = "Antigravity IDE.exe"; Proc = "Antigravity IDE"; Variant = "ide"
        Dirs = @((Join-Path $env:LOCALAPPDATA "Programs\Antigravity IDE"), (Join-Path $env:ProgramFiles "Antigravity IDE")) },
    [pscustomobject]@{ Key = "desktop"; Name = "Antigravity"; Exe = "Antigravity.exe"; Proc = "Antigravity"; Variant = "ide"
        Dirs = @((Join-Path $env:LOCALAPPDATA "Programs\Antigravity"), (Join-Path $env:ProgramFiles "Antigravity")) },
    [pscustomobject]@{ Key = "cli"; Name = "Antigravity CLI"; Exe = "agy.exe"; Proc = "agy"; Variant = "cli"
        Dirs = @((Join-Path $env:LOCALAPPDATA "agy\bin"), (Join-Path $env:LOCALAPPDATA "Programs\Antigravity CLI"), (Join-Path $env:ProgramFiles "Antigravity CLI")) }
)

function Test-PathUnder([string]$Path, [string]$Parent) {
    $p = $Path.TrimEnd('\') + '\'
    return $p.StartsWith($Parent.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)
}

# 读 PE 头判断架构，避免把 x86 补丁放进 x64 程序目录
function Get-PeArch([string]$Path) {
    try {
        $fs = [IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
        try {
            $reader = New-Object IO.BinaryReader($fs)
            $fs.Position = 0x3C
            $fs.Position = $reader.ReadInt32() + 4
            switch ($reader.ReadUInt16()) {
                0x014c { return "x86" }
                0x8664 { return "x64" }
                0xAA64 { return "arm64" }
                default { return "unknown" }
            }
        } finally { $fs.Dispose() }
    } catch {
        return "unknown"
    }
}

function Find-ProductDir($Def) {
    $candidates = New-Object System.Collections.Generic.List[string]
    # 正在运行的进程最能代表用户实际使用的安装
    Get-Process -Name $Def.Proc -ErrorAction SilentlyContinue | ForEach-Object {
        try { if ($_.Path) { $candidates.Add((Split-Path -Parent $_.Path)) } } catch { }
    }
    if ($Def.Key -eq "cli") {
        Get-Command -Name "agy.exe" -CommandType Application -All -ErrorAction SilentlyContinue |
            ForEach-Object { $candidates.Add((Split-Path -Parent $_.Source)) }
    }
    foreach ($d in $Def.Dirs) { $candidates.Add($d) }

    # ~/.gemini/bin 下的 agy.exe 由 IDE 下载并自动更新（IDE 的 version.dll 会注入它），不单独部署
    $ideManaged = Join-Path $env:USERPROFILE ".gemini"
    foreach ($dir in $candidates) {
        if ([string]::IsNullOrWhiteSpace($dir)) { continue }
        $dir = $dir.TrimEnd('\')
        if (Test-PathUnder $dir $ideManaged) { continue }
        if (Test-Path -LiteralPath (Join-Path $dir $Def.Exe) -PathType Leaf) { return $dir }
    }
    return ""
}

function New-Target($Def, [string]$Dir) {
    return [pscustomobject]@{ Def = $Def; Dir = $Dir; Arch = (Get-PeArch (Join-Path $Dir $Def.Exe)) }
}

function Find-Targets {
    if (-not [string]::IsNullOrWhiteSpace($InstallDir)) {
        $dir = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
        foreach ($def in $script:ProductDefs) {
            if (Test-Path -LiteralPath (Join-Path $dir $def.Exe) -PathType Leaf) { return @(New-Target $def $dir) }
        }
        Write-Err ((T "InstallDirBad") -f $dir)
        return @()
    }
    Write-Info (T "Detecting")
    $found = @()
    foreach ($def in $script:ProductDefs) {
        $dir = Find-ProductDir $def
        if ($dir) { $found += New-Target $def $dir }
    }
    if ($found.Count -eq 0) { Write-Err (T "NoneFound") }
    return $found
}

function Select-Targets($Targets) {
    for ($i = 0; $i -lt $Targets.Count; $i++) {
        $t = $Targets[$i]
        Write-Host ("  [{0}] {1,-16} {2,-6} {3}" -f ($i + 1), $t.Def.Name, $t.Arch, $t.Dir)
    }
    if ($Product -and $Product -ne "all") {
        $picked = @($Targets | Where-Object { $_.Def.Key -eq $Product })
        if ($picked.Count -eq 0) { Write-Err ((T "ProductMissing") -f $Product) }
        return $picked
    }
    if ($Product -eq "all" -or $Yes -or $Targets.Count -eq 1) { return $Targets }

    $answer = Read-Host (T "SelectPrompt")
    if ([string]::IsNullOrWhiteSpace($answer)) { return $Targets }
    $picked = @()
    foreach ($token in ($answer -split '[,，\s]+')) {
        $n = 0
        if ([int]::TryParse($token, [ref]$n) -and $n -ge 1 -and $n -le $Targets.Count) {
            if ($picked -notcontains $Targets[$n - 1]) { $picked += $Targets[$n - 1] }
        }
    }
    if ($picked.Count -eq 0) { Write-Warn (T "NothingSelected") }
    return $picked
}

function Get-RunningFrom($Target) {
    return @(Get-Process -Name $Target.Def.Proc -ErrorAction SilentlyContinue | Where-Object {
        try { $_.Path -and (Test-PathUnder (Split-Path -Parent $_.Path) $Target.Dir) } catch { $false }
    })
}

# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

function Invoke-OnlineInstall {
    Write-Host ""
    Write-Host (T "Title") -ForegroundColor White
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Initialize-WebProxy

    $targets = @(Find-Targets)
    if ($targets.Count -eq 0) { $script:ExitCode = 3; return }
    $targets = @(Select-Targets $targets)
    if ($targets.Count -eq 0) { $script:ExitCode = 3; return }

    # 只有 x64 / x86 有对应补丁
    $supported = @()
    foreach ($t in $targets) {
        if ($t.Arch -eq "x64" -or $t.Arch -eq "x86") { $supported += $t }
        else { Write-Warn ((T "ArchSkip") -f $t.Def.Name, $t.Arch) }
    }
    if ($supported.Count -eq 0) { $script:ExitCode = 3; return }

    $tag = Resolve-ReleaseTag
    if (-not $tag) { $script:ExitCode = 3; return }

    Write-Host ""
    Write-Host ((T "Plan") -f $tag) -ForegroundColor White
    foreach ($t in $supported) { Write-Host ("  - {0} ({1})  {2}" -f $t.Def.Name, $t.Arch, $t.Dir) }
    if (-not $Yes) {
        $answer = Read-Host (T "Confirm")
        if ($answer -and $answer -notmatch '^\s*(y|yes|是|д|да)\s*$') {
            Write-Warn (T "Cancelled")
            return
        }
    }

    Write-Host ""
    $checksums = Get-ReleaseChecksums $tag
    $packages = @{}
    $results = @()
    $powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"

    foreach ($t in $supported) {
        $name = $t.Def.Name
        # 同一架构的 IDE 与桌面版共用 ide 包，只下载一次
        $pkgKey = "$($t.Def.Variant)-$($t.Arch)"
        if (-not $packages.ContainsKey($pkgKey)) {
            $packages[$pkgKey] = Install-ReleasePackage -Tag $tag -Variant $t.Def.Variant -Arch $t.Arch -Checksums $checksums
        }
        $pkgDir = $packages[$pkgKey]
        if (-not $pkgDir) {
            $results += [pscustomobject]@{ Name = $name; Status = "fail"; Code = -1; Pkg = ""; Key = $t.Def.Key }
            continue
        }

        if ((Get-RunningFrom $t).Count -gt 0) {
            Write-Warn ((T "Running") -f $name)
            if (-not $Yes) {
                $answer = Read-Host ((T "RunningPrompt") -f $name)
                if ($answer -match '^\s*s') {
                    $results += [pscustomobject]@{ Name = $name; Status = "skip"; Code = 0; Pkg = $pkgDir; Key = $t.Def.Key }
                    continue
                }
            }
        }

        Write-Host ""
        Write-Info ((T "Deploying") -f $name, $t.Dir)
        # 已确认过安装，doctor 用 -Yes 免二次确认；在独立进程中运行（doctor 末尾会 exit）
        $doctorArgs = @(
            "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", (Join-Path $pkgDir "doctor.ps1"),
            "-Action", "Setup",
            "-InstallDir", $t.Dir,
            "-SourceDir", (Join-Path $pkgDir $t.Def.Variant),
            "-Yes"
        )
        if ($ProxyPort -gt 0) { $doctorArgs += @("-ProxyPort", [string]$ProxyPort) }
        & $powershell @doctorArgs | Out-Host
        $code = $LASTEXITCODE
        $status = switch ($code) { 0 { "ok" } 1 { "warn" } default { "fail" } }
        $results += [pscustomobject]@{ Name = $name; Status = $status; Code = $code; Pkg = $pkgDir; Key = $t.Def.Key }
    }

    Write-Host ""
    Write-Host ("==== {0} ====" -f (T "Summary")) -ForegroundColor White
    foreach ($r in $results) {
        switch ($r.Status) {
            "ok"   { Write-Ok   ("  {0}: {1}" -f $r.Name, (T "ResultOk")) }
            "warn" { Write-Warn ("  {0}: {1}" -f $r.Name, (T "ResultWarn")) }
            "skip" { Write-Warn ("  {0}: {1}" -f $r.Name, (T "ResultSkip")) }
            default { Write-Err ("  {0}: {1}" -f $r.Name, ((T "ResultFail") -f $r.Code)) }
        }
    }

    $deployed = @($results | Where-Object { $_.Status -eq "ok" -or $_.Status -eq "warn" })
    if ($deployed.Count -gt 0) {
        Write-Host ""
        Write-Host (T "NextRestart")
        # 只有发布包带插件（v2.5 起 ide\antigravity-proxy.vsix）时 doctor 才会安装，避免误报
        $ideWithExtension = @($deployed | Where-Object {
            $_.Key -eq "ide" -and (Test-Path -LiteralPath (Join-Path $_.Pkg "ide\antigravity-proxy.vsix"))
        })
        if ($ideWithExtension.Count -gt 0) { Write-Host (T "NextIde") }
        Write-Host (T "NextRepair")
        foreach ($pkg in @($deployed | ForEach-Object { $_.Pkg } | Select-Object -Unique)) {
            Write-Dim ("  powershell -ExecutionPolicy Bypass -File `"{0}`" -Action Repair" -f (Join-Path $pkg "doctor.ps1"))
        }
    }
    if (@($results | Where-Object { $_.Status -eq "fail" }).Count -gt 0) { $script:ExitCode = 2 }
}

Invoke-OnlineInstall
if ($script:RunAsFile) { exit $script:ExitCode }
