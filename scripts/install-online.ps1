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
      2. 获取版本（默认最新）
      3. 下载对应架构的发布包；有 SHA256SUMS.txt 时校验，取不到清单只告警不阻断
      4. 解压到 %LOCALAPPDATA%\antigravity-proxy\<版本>\（安装目录之外，日后 IDE 更新冲掉补丁时可据此修复）
      5. 调用 doctor.ps1 -Action Setup 部署补丁与 config.json（已有 config.json 不覆盖；IDE 会同时安装配套插件）

    下载顺序：本地代理（环境变量 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY 或系统代理，且端口可连）→ 镜像 → 直连 GitHub；
    未检测到可用代理时为 镜像 → 直连。每个请求超时 60 秒，每个下载源最多尝试 3 次，全部失败才结束并提示。

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

.PARAMETER ExtensionOnly
    只安装 Antigravity IDE 配套插件：下载 Release 中的插件 VSIX（校验后）并用 IDE 命令行安装，
    不修改 version.dll 与 config.json，IDE 运行中也可执行（只装了 DLL 时由 DLL 的通知引导调用）。

.PARAMETER ExtensionsDir / UserDataDir
    透传给 IDE 命令行的 --extensions-dir / --user-data-dir（便携版或多配置用户）。

.PARAMETER InjectedProxy
    内部参数：由 DLL 启动本脚本、且已把代理补丁注入当前 PowerShell 进程时传入（值为 config.json 中的代理地址，仅用于显示）。
    此时所有流量都经该代理，下载顺序为 GitHub（经代理）→ 镜像（经代理），不再探测其它本地代理。
#>
[CmdletBinding()]
param(
    [string]$Version = "",
    [ValidateSet("", "all", "ide", "desktop", "cli")]
    [string]$Product = "",
    [string]$InstallDir = "",
    [int]$ProxyPort = 0,
    [switch]$Yes,
    [switch]$ExtensionOnly,
    [string]$ExtensionsDir = "",
    [string]$UserDataDir = "",
    [string]$InjectedProxy = ""
)

$ErrorActionPreference = "Stop"

# 作为 .ps1 文件运行时才用 exit 返回退出码；经 scriptblock 在线执行时 exit 会关掉用户的 PowerShell 窗口
$script:RunAsFile = [bool]$MyInvocation.MyCommand.Path
$script:ExitCode = 0

$script:Repo = "yuaotian/antigravity-proxy"
$script:Root = Join-Path $env:LOCALAPPDATA "antigravity-proxy"
# GitHub 代理站（镜像），与 DLL 更新检查 updates.mirrors 默认值一致；路线顺序见 Get-Routes。
# 实测（2026-11）：wget.la 可转发 api.github.com 与 Release 下载；fastgit.cc / boki / ednovas 只能下载 Release
$script:Mirrors = @(
    "https://wget.la/",
    "https://rapidgit.jjda.de5.net/",
    "https://fastgit.cc/",
    "https://gitproxy.mrhjx.cn/",
    "https://github.boki.moe/",
    "https://github.ednovas.xyz/"
)
$script:WebProxy = $null
$script:WebProxyLabel = ""
$script:PreferredRoute = ""
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
    SystemProxy     = @("系统代理", "system proxy", "системный прокси")
    ProxyUse        = @("下载优先使用本地代理：{0}（来自 {1}）", "Downloading via local proxy first: {0} (from {1})", "Загрузка сначала через локальный прокси: {0} (из {1})")
    ProxyDown       = @("  本地代理 {0}（来自 {1}）端口无法连接，跳过", "  Local proxy {0} (from {1}) is not reachable, skipped", "  Локальный прокси {0} (из {1}) недоступен, пропущен")
    ProxyNone       = @("未检测到可用的本地 HTTP 代理，依次使用镜像与直连。", "No reachable local HTTP proxy; using mirrors, then direct connection.", "Доступный локальный HTTP-прокси не найден; используются зеркала, затем прямое подключение.")
    ProxyInjected   = @("下载经代理补丁转发到 {0}（与 IDE 相同），失败时改走镜像。", "Downloads go through the proxy patch to {0} (same as the IDE); mirrors are used if that fails.", "Загрузка идёт через патч на прокси {0} (как у IDE); при сбое используются зеркала.")
    ViaProxy        = @("代理 {0}", "proxy {0}", "прокси {0}")
    Direct          = @("直连 github.com", "direct github.com", "напрямую github.com")
    AllRoutesFailed = @("所有下载源均失败（共 {0} 个，每个最多尝试 {1} 次）。请检查网络：开启代理软件（或其「系统代理」）后重新运行。",
                        "All download sources failed ({0} sources, up to {1} attempts each). Check your network: start your proxy app (or its system proxy) and run again.",
                        "Все источники загрузки недоступны ({0} шт., до {1} попыток каждый). Проверьте сеть: запустите прокси-клиент (или его системный прокси) и повторите.")
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
    SourceFailed    = @("  {0} 第 {1}/{2} 次失败：{3}", "  {0} attempt {1}/{2} failed: {3}", "  {0}: попытка {1}/{2} не удалась: {3}")
    Truncated       = @("下载不完整（收到 {0} 字节，应为 {1} 字节）", "incomplete download ({0} of {1} bytes)", "загрузка неполная ({0} из {1} байт)")
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
    ExtTitle        = @("Antigravity Proxy 配套插件安装（只装插件，不修改 DLL 与配置）", "Antigravity Proxy companion extension install (extension only; DLL and config untouched)", "Установка расширения Antigravity Proxy (только расширение; DLL и конфигурация не меняются)")
    ExtIdeNotFound  = @("未找到 Antigravity IDE（Antigravity IDE.exe）。可用 -InstallDir 指定安装目录。", "Antigravity IDE (Antigravity IDE.exe) not found. Use -InstallDir to specify it.", "Antigravity IDE (Antigravity IDE.exe) не найдена. Укажите каталог через -InstallDir.")
    ExtCliMissing   = @("IDE 命令行工具不存在：{0}", "IDE command-line tool not found: {0}", "Не найден инструмент командной строки IDE: {0}")
    ExtAssetMissing = @("{0} 未提供插件安装包（需要 v2.5 及以上），请用 -Version 指定更新的版本。", "{0} has no extension package (v2.5+ required); pass a newer -Version.", "В {0} нет пакета расширения (нужна v2.5+); укажите более новую -Version.")
    ExtInstalling   = @("安装插件到 {0} ...", "Installing the extension into {0} ...", "Установка расширения в {0} ...")
    ExtInstalled    = @("插件安装完成：运行中的 IDE 会自动加载，无需重启；点击底部状态栏即可设置代理。", "Extension installed. A running IDE loads it automatically, no restart needed; click the status bar to configure the proxy.", "Расширение установлено. Запущенная IDE загрузит его автоматически, перезапуск не нужен; нажмите на строку состояния для настройки прокси.")
    ExtInstallFailed = @("插件安装失败（退出码 {0}）。可在 IDE 扩展视图 → 右上角「…」→「从 VSIX 安装…」，选择：{1}", 'Extension install failed (exit code {0}). Install manually: Extensions view → "…" → "Install from VSIX…", then choose: {1}', "Не удалось установить расширение (код {0}). Установите вручную: «Расширения» → «…» → «Установить из VSIX…», файл: {1}")
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

# 每个请求的超时（建连 + 响应头、读写各自计时）与每个下载源的最大尝试次数
$script:RequestTimeoutMs = 60000
$script:MaxAttemptsPerSource = 3

# 本地代理探测：环境变量 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY（http 代理）> 系统代理（ProxyEnable=1）；
# 只有端口在 3 秒内能建立 TCP 连接才认为可用，避免配置了却没启动的代理把每个请求都拖到超时。
# 说明：WebRequest 不读环境变量（PS 5.1），也不支持 SOCKS 代理，SOCKS 地址会被跳过。
function Test-TcpPort([string]$HostName, [int]$Port) {
    $client = New-Object Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect($HostName, $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne(3000)) { return $false }
        $client.EndConnect($iar)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Initialize-WebProxy {
    # 已注入代理补丁：进程内所有连接都由 DLL 转发到 config.json 中的代理，WebRequest 不能再叠加其它代理
    if (-not [string]::IsNullOrWhiteSpace($InjectedProxy)) {
        $script:WebProxyLabel = (T "ViaProxy") -f $InjectedProxy
        Write-Dim ((T "ProxyInjected") -f $InjectedProxy)
        return
    }
    $candidates = @()
    foreach ($name in @("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY")) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ([string]::IsNullOrWhiteSpace($value)) { continue }
        $value = $value.Trim()
        if ($value -notmatch '^[a-zA-Z][a-zA-Z0-9+.-]*://') { $value = "http://$value" }
        if ($value -match '^https?://') { $candidates += [pscustomobject]@{ Url = $value; From = $name } }
    }
    try {
        $ie = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -ErrorAction Stop
        if ($ie.ProxyEnable -eq 1 -and -not [string]::IsNullOrWhiteSpace($ie.ProxyServer)) {
            # ProxyServer 可能是 "host:port" 或 "http=host:port;https=host:port;socks=..."，取 https / http 项
            $server = [string]$ie.ProxyServer
            if ($server -match '=') {
                $map = @{}
                foreach ($part in $server -split ';') { if ($part -match '^\s*(\w+)=(.+?)\s*$') { $map[$Matches[1].ToLowerInvariant()] = $Matches[2] } }
                $server = if ($map["https"]) { $map["https"] } elseif ($map["http"]) { $map["http"] } else { "" }
            }
            if ($server) {
                if ($server -notmatch '^[a-zA-Z][a-zA-Z0-9+.-]*://') { $server = "http://$server" }
                $candidates += [pscustomobject]@{ Url = $server; From = (T "SystemProxy") }
            }
        }
    } catch { }

    foreach ($c in $candidates) {
        try {
            $uri = [Uri]$c.Url
            if (-not (Test-TcpPort $uri.Host $uri.Port)) {
                Write-Dim ((T "ProxyDown") -f $c.Url, $c.From)
                continue
            }
            $script:WebProxy = New-Object Net.WebProxy($c.Url, $true)
            $script:WebProxyLabel = (T "ViaProxy") -f $uri.Authority
            Write-Dim ((T "ProxyUse") -f $c.Url, $c.From)
            return
        } catch { }
    }
    # 自动配置脚本（PAC）无法预先探测端口，交给系统按脚本选择代理
    try {
        $ie = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings" -ErrorAction Stop
        if (-not [string]::IsNullOrWhiteSpace([string]$ie.AutoConfigURL)) {
            $script:WebProxy = [Net.WebRequest]::GetSystemWebProxy()
            $script:WebProxyLabel = (T "ViaProxy") -f "PAC"
            Write-Dim ((T "ProxyUse") -f $ie.AutoConfigURL, (T "SystemProxy"))
            return
        }
    } catch { }
    Write-Dim (T "ProxyNone")
}

function Get-InnerMessage($ErrorRecord) {
    $e = $ErrorRecord.Exception
    while ($e.InnerException) { $e = $e.InnerException }
    return $e.Message
}

# 读取整个响应为字节数组。Proxy 为 $null 表示不走代理（镜像 / 直连），避免系统代理设置干扰。
# 实测镜像（wget.la）偶发在传输中途断开，却不报错、按“正常结束”返回截断的内容；
# 服务器给出 Content-Length 时核对长度，不符按传输失败处理（可重试），避免把截断包误报为“校验不一致”而直接换源
function Get-WebBytes([string]$Url, $Proxy) {
    $req = [Net.WebRequest]::Create($Url)
    $req.Timeout = $script:RequestTimeoutMs
    $req.ReadWriteTimeout = $script:RequestTimeoutMs
    $req.UserAgent = "antigravity-proxy-online-installer"
    $req.Proxy = $Proxy
    $resp = $req.GetResponse()
    try {
        $ms = New-Object IO.MemoryStream
        $resp.GetResponseStream().CopyTo($ms)
        $bytes = $ms.ToArray()
        if ($resp.ContentLength -gt 0 -and $bytes.Length -ne $resp.ContentLength) {
            throw ((T "Truncated") -f $bytes.Length, $resp.ContentLength)
        }
        return , $bytes
    } finally {
        $resp.Close()
    }
}

# 下载路线（按优先级）：本地代理直连 GitHub → 各镜像 → 直连 GitHub。
# 已注入代理补丁时：GitHub（经代理）→ 镜像（经代理）；“直连”与第一条相同，省略。
# 证书始终校验：下载的是可执行补丁与安装包，跳过校验后中间人可同时替换安装包和 SHA256 清单
function Get-Routes {
    $routes = @()
    $injected = -not [string]::IsNullOrWhiteSpace($InjectedProxy)
    if ($injected) {
        $routes += [pscustomobject]@{ Prefix = ""; Proxy = $null; Label = $script:WebProxyLabel }
    } elseif ($script:WebProxy) {
        $routes += [pscustomobject]@{ Prefix = ""; Proxy = $script:WebProxy; Label = $script:WebProxyLabel }
    }
    foreach ($m in $script:Mirrors) { $routes += [pscustomobject]@{ Prefix = $m; Proxy = $null; Label = ([Uri]$m).Host } }
    if (-not $injected) { $routes += [pscustomobject]@{ Prefix = ""; Proxy = $null; Label = (T "Direct") } }
    return $routes
}

# 依次尝试各路线，每条路线最多 MaxAttemptsPerSource 次（超时、断流、5xx、内容不合格都会重试；
# 4xx 说明该源不支持此地址，直接换源）。Validate 返回非空字符串表示内容不合格（错误页 / 哈希不符，
# 镜像断流截断也会表现为哈希不符）。成功的路线提到最前，后续下载优先复用；全部失败时输出汇总并返回 $null
function Invoke-Sources([string]$Target, [scriptblock]$Validate, $State = $null) {
    $routes = Get-Routes
    if ($script:PreferredRoute) {
        $routes = @($routes | Where-Object { $_.Label -eq $script:PreferredRoute }) + @($routes | Where-Object { $_.Label -ne $script:PreferredRoute })
    }
    foreach ($route in $routes) {
        for ($attempt = 1; $attempt -le $script:MaxAttemptsPerSource; $attempt++) {
            try {
                $bytes = Get-WebBytes ($route.Prefix + $Target) $route.Proxy
                $problem = & $Validate $bytes $State
                if ($problem) {
                    Write-Dim ((T "SourceFailed") -f $route.Label, $attempt, $script:MaxAttemptsPerSource, $problem)
                    if ($attempt -lt $script:MaxAttemptsPerSource) { Start-Sleep -Seconds 2 }
                    continue
                }
                $script:PreferredRoute = $route.Label
                return [pscustomobject]@{ Bytes = $bytes; Source = $route.Label }
            } catch {
                $msg = Get-InnerMessage $_
                Write-Dim ((T "SourceFailed") -f $route.Label, $attempt, $script:MaxAttemptsPerSource, $msg)
                # HTTP 4xx（如镜像不支持该地址返回 404/403）重试同一源不会变好，直接换源；超时、截断与 5xx/429 等才重试
                $status = 0
                for ($e = $_.Exception; $e; $e = $e.InnerException) {
                    if ($e -is [Net.WebException] -and $e.Response) { $status = [int]$e.Response.StatusCode; break }
                }
                if ($status -ge 400 -and $status -lt 500 -and $status -ne 429) { break }
                if ($attempt -lt $script:MaxAttemptsPerSource) { Start-Sleep -Seconds 2 }
            }
        }
    }
    Write-Err ((T "AllRoutesFailed") -f @($routes).Count, $script:MaxAttemptsPerSource)
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
    $result = Invoke-Sources -Target "https://api.github.com/repos/$($script:Repo)/releases/latest" -Validate {
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
    $result = Invoke-Sources -Target "https://github.com/$($script:Repo)/releases/download/$Tag/SHA256SUMS.txt" -Validate {
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

# 下载 Release 资产并校验（zip 与 vsix 都是 zip 格式）：镜像出错时可能返回 200 + HTML 错误页，先看魔数 PK；
# 有校验清单时比对 SHA256，不一致换源。成功返回字节数组，全部失败返回 $null
function Get-VerifiedAsset([string]$Tag, [string]$Asset, $Checksums) {
    $expected = if ($Checksums) { $Checksums[$Asset] } else { $null }
    Write-Info ((T "Downloading") -f $Asset)
    $result = Invoke-Sources -Target "https://github.com/$($script:Repo)/releases/download/$Tag/$Asset" -State $expected -Validate {
        param($b, $hash)
        if ($b.Length -lt 4 -or $b[0] -ne 0x50 -or $b[1] -ne 0x4B) { return (T "NotZip") }
        if ($hash -and (Get-Sha256Hex $b) -ne $hash) { return (T "HashMismatch") }
        return ""
    }
    if (-not $result) {
        Write-Err ((T "DownloadFailed") -f $Asset)
        return $null
    }
    if ($expected) { Write-Ok ((T "Verified") -f $result.Source) } else { Write-Dim ((T "NotVerified") -f $result.Source) }
    return , $result.Bytes
}

# 下载并解压发布包到 %LOCALAPPDATA%\antigravity-proxy\<tag>\<variant>-win-<arch>，返回包目录；失败返回空串
function Install-ReleasePackage([string]$Tag, [string]$Variant, [string]$Arch, $Checksums) {
    $asset = "antigravity-proxy-$Tag-$Variant-win-$Arch.zip"
    $bytes = Get-VerifiedAsset -Tag $Tag -Asset $asset -Checksums $Checksums
    if (-not $bytes) { return "" }

    $pkgDir = Join-Path $script:Root "$Tag\$Variant-win-$Arch"
    $zipPath = Join-Path $script:Root "$asset.download"
    New-Item -ItemType Directory -Path $script:Root -Force | Out-Null
    [IO.File]::WriteAllBytes($zipPath, $bytes)
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
        $raw = Invoke-Sources -Target "https://raw.githubusercontent.com/$($script:Repo)/main/scripts/doctor.ps1" -Validate {
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

# 只装插件：IDE 运行中 version.dll 被占用，完整部署（doctor Setup 先替换 DLL）会失败，因此单独下载 VSIX 安装
function Invoke-ExtensionOnlyInstall {
    Write-Host ""
    Write-Host (T "ExtTitle") -ForegroundColor White
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Initialize-WebProxy

    $def = $script:ProductDefs | Where-Object { $_.Key -eq "ide" } | Select-Object -First 1
    $dir = if (-not [string]::IsNullOrWhiteSpace($InstallDir)) { [IO.Path]::GetFullPath($InstallDir).TrimEnd('\') } else { Find-ProductDir $def }
    if (-not $dir -or -not (Test-Path -LiteralPath (Join-Path $dir $def.Exe) -PathType Leaf)) {
        Write-Err (T "ExtIdeNotFound")
        $script:ExitCode = 3
        return
    }
    $cli = Join-Path $dir "bin\antigravity-ide.cmd"
    if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
        Write-Err ((T "ExtCliMissing") -f $cli)
        $script:ExitCode = 3
        return
    }
    $arch = Get-PeArch (Join-Path $dir $def.Exe)
    if ($arch -ne "x64" -and $arch -ne "x86") {
        Write-Warn ((T "ArchSkip") -f $def.Name, $arch)
        $script:ExitCode = 3
        return
    }

    $tag = Resolve-ReleaseTag
    if (-not $tag) { $script:ExitCode = 3; return }
    $asset = "antigravity-proxy-$tag-ide-extension-win-$arch.vsix"
    if ($script:ReleaseAssets.Count -gt 0 -and $script:ReleaseAssets -notcontains $asset) {
        Write-Err ((T "ExtAssetMissing") -f $tag)
        $script:ExitCode = 3
        return
    }
    $checksums = Get-ReleaseChecksums $tag
    $bytes = Get-VerifiedAsset -Tag $tag -Asset $asset -Checksums $checksums
    if (-not $bytes) { $script:ExitCode = 2; return }

    # 安装包留在本机母本目录，安装失败时可手动「从 VSIX 安装」
    $vsixDir = Join-Path $script:Root $tag
    New-Item -ItemType Directory -Path $vsixDir -Force | Out-Null
    $vsix = Join-Path $vsixDir "antigravity-proxy.vsix"
    [IO.File]::WriteAllBytes($vsix, $bytes)

    $cliArgs = @("--install-extension", $vsix, "--force")
    if (-not [string]::IsNullOrWhiteSpace($ExtensionsDir)) { $cliArgs += @("--extensions-dir", $ExtensionsDir) }
    if (-not [string]::IsNullOrWhiteSpace($UserDataDir)) { $cliArgs += @("--user-data-dir", $UserDataDir) }
    Write-Info ((T "ExtInstalling") -f $dir)
    # IDE 命令行成功时也会向 stderr 输出告警（PS 5.1 下会被包装成错误记录），这里只按退出码判定
    $prevErrorAction = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $cli @cliArgs 2>&1 | ForEach-Object { Write-Dim ("  " + [string]$_) }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $prevErrorAction
    }
    if ($code -eq 0) {
        Write-Ok (T "ExtInstalled")
    } else {
        Write-Err ((T "ExtInstallFailed") -f $code, $vsix)
        $script:ExitCode = 2
    }
}

if ($ExtensionOnly) { Invoke-ExtensionOnlyInstall } else { Invoke-OnlineInstall }
if ($script:RunAsFile) { exit $script:ExitCode }
