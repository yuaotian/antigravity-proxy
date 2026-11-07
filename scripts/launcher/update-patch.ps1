# ============================================================================
# Antigravity-Proxy 在线补丁自动更新工具 (update-patch.ps1)
# ============================================================================

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$NoPause,
    [string]$Lang = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = $ScriptDir
if ((Split-Path -Leaf $ScriptDir) -match '^(launcher|scripts)$') {
    $Parent = Split-Path -Parent $ScriptDir
    if ((Test-Path (Join-Path $Parent "Patch")) -or (Test-Path (Join-Path $Parent "ide")) -or `
        (Test-Path (Join-Path $Parent "cli")) -or (Test-Path (Join-Path $Parent "build.ps1"))) {
        $RootDir = $Parent
    }
}

$LauncherDir = if (Test-Path (Join-Path $RootDir "launcher")) { Join-Path $RootDir "launcher" } else { $ScriptDir }
$LangPrefFile = Join-Path $LauncherDir "lang.pref"

function Get-Language {
    if (-not [string]::IsNullOrWhiteSpace($Lang)) { return $Lang.ToLower() }
    if (Test-Path -LiteralPath $LangPrefFile) {
        $saved = (Get-Content -LiteralPath $LangPrefFile -Raw -Encoding UTF8).Trim().ToLower()
        if ($saved -in @("zh", "en", "ru")) { return $saved }
    }
    $ui = [System.Globalization.CultureInfo]::InstalledUICulture.Name.ToLower()
    if ($ui -like "zh*") { return "zh" }
    if ($ui -like "ru*") { return "ru" }
    return "en"
}

$CurrentLang = Get-Language

$M = @{
    "zh" = @{
        Title = "Antigravity-Proxy 在线补丁自动更新工具"
        Fetching = "正在获取 GitHub 官方仓库最新 Release 信息..."
        GotLatest = "获取到最新官方 Release: {0} (发布日期: {1})"
        AlreadyLatest = "当前本地补丁版本 ({0}) 已是最新版本，无需更新！"
        ForceHint = "（如需强制重新下载覆盖，可加参数 -Force 运行）"
        FoundNew = "发现新版本！本地: [{0}] -> 最新: [{1}]"
        NoAsset = "未在最新 Release 中找到适合当前产品的 zip 资产包。"
        Downloading = "正在下载最新资产包: {0} ..."
        Extracting = "正在解压并更新本地补丁目录..."
        Synced = "已将最新补丁同步至主程序目录！"
        Done = "🎉 补丁更新完毕！已成功保留您的本地代理端口配置。"
        ErrConn = "无法连接到 GitHub Releases 服务，请检查代理端口 ({0}) 是否开启或网络连接状态。"
        PressEnter = "按回车键退出..."
    }
    "en" = @{
        Title = "Antigravity-Proxy Online Patch Updater"
        Fetching = "Fetching latest Release info from GitHub..."
        GotLatest = "Found latest official Release: {0} (Published: {1})"
        AlreadyLatest = "Local patch version ({0}) is already up to date!"
        ForceHint = "(Run with -Force to redownload and overwrite anyway)"
        FoundNew = "New version available! Local: [{0}] -> Remote: [{1}]"
        NoAsset = "No matching zip asset found in the latest Release."
        Downloading = "Downloading latest package: {0} ..."
        Extracting = "Extracting and updating local patch repository..."
        Synced = "Synced updated patches to target program directory!"
        Done = "🎉 Patch update complete! Your proxy settings have been preserved."
        ErrConn = "Failed to connect to GitHub Releases. Please check proxy port ({0}) and network status."
        PressEnter = "Press Enter to exit..."
    }
    "ru" = @{
        Title = "Онлайн-обновление патча Antigravity-Proxy"
        Fetching = "Получение информации о релизах с GitHub..."
        GotLatest = "Найден последний официальный релиз: {0} (Опубликован: {1})"
        AlreadyLatest = "Локальная версия патча ({0}) уже актуальна!"
        ForceHint = "(Используйте параметр -Force для принудительного обновления)"
        FoundNew = "Доступна новая версия! Локальная: [{0}] -> Удаленная: [{1}]"
        NoAsset = "Не найден подходящий zip архив в последнем релизе."
        Downloading = "Загрузка пакета: {0} ..."
        Extracting = "Распаковка и обновление локального патча..."
        Synced = "Обновленный патч синхронизирован с папкой программы!"
        Done = "🎉 Обновление завершено! Настройки прокси успешно сохранены."
        ErrConn = "Не удалось подключиться к GitHub Releases. Проверьте порт прокси ({0}) и сеть."
        PressEnter = "Нажмите Enter для выхода..."
    }
}

function T([string]$Key) {
    if ($M[$CurrentLang].ContainsKey($Key)) { return $M[$CurrentLang][$Key] }
    return $M["en"][$Key]
}

function Write-Title([string]$Text) {
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "  $Text" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan
}

function Write-Info([string]$Text) { Write-Host "[*] $Text" -ForegroundColor Yellow }
function Write-Ok([string]$Text)   { Write-Host "[✓] $Text" -ForegroundColor Green }
function Write-Warn([string]$Text) { Write-Host "[!] $Text" -ForegroundColor Magenta }
function Write-Err([string]$Text)  { Write-Host "[✗] $Text" -ForegroundColor Red }

# 判断当前是 IDE 还是 CLI 产品包
$isCli = (Test-Path (Join-Path $RootDir "cli")) -and -not (Test-Path (Join-Path $RootDir "ide"))

$PatchDir = if ($isCli) { Join-Path $RootDir "cli" } else {
    if (Test-Path (Join-Path $RootDir "ide")) { Join-Path $RootDir "ide" }
    elseif (Test-Path (Join-Path $RootDir "Patch")) { Join-Path $RootDir "Patch" }
    else { Join-Path $RootDir "ide" }
}

if (-not (Test-Path $PatchDir)) {
    New-Item -ItemType Directory -Path $PatchDir -Force | Out-Null
}

$localVersion = "未知 (<=2.2)"
$proxyHost = "127.0.0.1"
$proxyPort = 7890
$proxyType = "socks5"
$localConfigFile = Join-Path $PatchDir "config.json"

if (Test-Path $localConfigFile) {
    try {
        $cfgJson = Get-Content -LiteralPath $localConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($cfgJson._version) { $localVersion = $cfgJson._version }
        if ($cfgJson.proxy) {
            if ($cfgJson.proxy.host) { $proxyHost = $cfgJson.proxy.host }
            if ($cfgJson.proxy.port) { $proxyPort = $cfgJson.proxy.port }
            if ($cfgJson.proxy.type) { $proxyType = $cfgJson.proxy.type }
        }
    } catch { }
}

Write-Title (T "Title")
Write-Host "  Target Product: $(if ($isCli) { 'CLI' } else { 'IDE' })"
Write-Host "  Patch Directory: $PatchDir"
Write-Host "  Local Version: $localVersion"
Write-Host "  Proxy Setting: ${proxyType}://${proxyHost}:${proxyPort}"

$apiUrl = "https://api.github.com/repos/yuaotian/antigravity-proxy/releases/latest"
$releaseData = $null

Write-Info (T "Fetching")

$curlCmd = Get-Command "curl.exe" -ErrorAction SilentlyContinue
$proxyArg = if ($proxyType -eq "socks5") { "socks5h://${proxyHost}:${proxyPort}" } else { "http://${proxyHost}:${proxyPort}" }

if ($curlCmd) {
    foreach ($proxyCandidate in @($proxyArg, "http://${proxyHost}:${proxyPort}", "")) {
        try {
            $argsList = @("-fsSL", "--connect-timeout", "8", "-H", "User-Agent: Antigravity-Updater")
            if ($proxyCandidate) { $argsList += @("-x", $proxyCandidate) }
            $argsList += $apiUrl
            $respText = (& curl.exe @argsList 2>$null) -join "`n"
            if ($respText -and $respText.Contains("tag_name")) {
                $releaseData = $respText | ConvertFrom-Json
                break
            }
        } catch { }
    }
}

if (-not $releaseData -or -not $releaseData.tag_name) {
    $webClient = New-Object System.Net.WebClient
    $webClient.Headers.Add("User-Agent", "Antigravity-Update-Script/1.0")
    foreach ($endpoint in @("https://ghproxy.net/$apiUrl", $apiUrl)) {
        try {
            $resp = $webClient.DownloadString($endpoint)
            if ($resp) {
                $releaseData = $resp | ConvertFrom-Json
                if ($releaseData.tag_name) { break }
            }
        } catch { }
    }
}

if (-not $releaseData -or -not $releaseData.tag_name) {
    Write-Err ([string]::Format((T "ErrConn"), $proxyPort))
    if (-not $NoPause) { Read-Host (T "PressEnter") }
    exit 1
}

$remoteTag = $releaseData.tag_name
$remoteVersion = $remoteTag.TrimStart('vV')
Write-Host ""
Write-Ok ([string]::Format((T "GotLatest"), $remoteTag, $releaseData.published_at))

$needUpdate = ($localVersion -ne $remoteVersion -or $Force)
if (-not $needUpdate) {
    Write-Ok ([string]::Format((T "AlreadyLatest"), $localVersion))
    Write-Host (T "ForceHint") -ForegroundColor Gray
    if (-not $NoPause) { Read-Host (T "PressEnter") }
    exit 0
}

Write-Info ([string]::Format((T "FoundNew"), $localVersion, $remoteVersion))

# 根据当前是 CLI 还是 IDE 寻找匹配的资产包
$assetPattern = if ($isCli) { "*cli-win-x64.zip" } else { "*ide-win-x64.zip" }
$asset = $releaseData.assets | Where-Object { $_.name -like $assetPattern } | Select-Object -First 1
if (-not $asset) {
    $asset = $releaseData.assets | Where-Object { $_.name -like "*-win-x64.zip" } | Select-Object -First 1
}

if (-not $asset) {
    Write-Err (T "NoAsset")
    exit 1
}

$downloadUrl = $asset.browser_download_url
$zipFileName = $asset.name
Write-Info ([string]::Format((T "Downloading"), $zipFileName))

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) "ag-update-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
$tempZip = Join-Path $tempDir $zipFileName

$downloadSuccess = $false
if ($curlCmd) {
    foreach ($proxyCandidate in @($proxyArg, "http://${proxyHost}:${proxyPort}", "")) {
        $dlArgs = @("-fsSL", "--connect-timeout", "10", "-o", $tempZip)
        if ($proxyCandidate) { $dlArgs += @("-x", $proxyCandidate) }
        $dlArgs += $downloadUrl
        & curl.exe @dlArgs 2>$null
        if ((Test-Path $tempZip) -and (Get-Item $tempZip).Length -gt 10000) {
            $downloadSuccess = $true
            break
        }
    }
}

if (-not $downloadSuccess) {
    foreach ($dlUrl in @("https://ghproxy.net/$downloadUrl", $downloadUrl)) {
        try {
            (New-Object System.Net.WebClient).DownloadFile($dlUrl, $tempZip)
            if ((Test-Path $tempZip) -and (Get-Item $tempZip).Length -gt 10000) {
                $downloadSuccess = $true
                break
            }
        } catch { }
    }
}

if (-not $downloadSuccess) {
    Write-Err "Download failed."
    exit 1
}

Write-Ok "Download completed."
Write-Info (T "Extracting")

$extractDir = Join-Path $tempDir "extracted"
Expand-Archive -LiteralPath $tempZip -DestinationPath $extractDir -Force

# 寻找解压出的新补丁目录
$srcPatchDir = ""
if ($isCli) {
    if (Test-Path (Join-Path $extractDir "cli")) { $srcPatchDir = Join-Path $extractDir "cli" }
} else {
    if (Test-Path (Join-Path $extractDir "ide")) { $srcPatchDir = Join-Path $extractDir "ide" }
    elseif (Test-Path (Join-Path $extractDir "Patch")) { $srcPatchDir = Join-Path $extractDir "Patch" }
}

if (-not $srcPatchDir -or -not (Test-Path $srcPatchDir)) {
    $srcPatchDir = $extractDir
}

# 保留原有的代理配置
$sourceConfigFile = Join-Path $srcPatchDir "config.json"
if ((Test-Path $sourceConfigFile) -and $hasLocalConfig) {
    try {
        $newCfg = Get-Content -LiteralPath $sourceConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($newCfg.proxy) {
            $newCfg.proxy.host = $proxyHost
            $newCfg.proxy.port = $proxyPort
            $newCfg.proxy.type = $proxyType
        }
        $newCfg | ConvertTo-Json -Depth 10 | Out-File -FilePath $sourceConfigFile -Encoding UTF8
    } catch { }
}

# 复制到本地补丁目录
Copy-Item -Path (Join-Path $srcPatchDir "*") -Destination $PatchDir -Recurse -Force
Remove-Item -LiteralPath $tempDir -Recurse -Force

Write-Ok (T "Done")

# 如果已经绑定了目标目录，尝试自动同步
$installScript = Join-Path $RootDir "launcher\install-windows.ps1"
if (-not (Test-Path $installScript)) {
    $installScript = Join-Path $RootDir "scripts\launcher\install-windows.ps1"
}
if (Test-Path $installScript) {
    & $installScript -Mode SyncOnly -NoPause
    Write-Ok (T "Synced")
}

if (-not $NoPause) {
    Write-Host ""
    Read-Host (T "PressEnter")
}
