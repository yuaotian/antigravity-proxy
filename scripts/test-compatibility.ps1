[CmdletBinding()]
param(
    [ValidateSet("Release", "Debug")]
    [string]$Config = "Release",
    [ValidateSet("x64", "x86")]
    [string]$Arch = "x64",
    [string]$BuildDir = "",
    [switch]$SkipReleaseLayout
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($BuildDir)) {
    $BuildDir = "build-compatibility-tests-$Arch"
}
$BuildPath = Join-Path $Root $BuildDir
$CMakeArch = if ($Arch -eq "x86") { "Win32" } else { "x64" }

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

function Assert-FileExists {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "缺少文件: $Path"
    }
}

function Get-ZipEntryNames {
    param([Parameter(Mandatory = $true)][string]$Path)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($Path)
    try {
        return @($archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') })
    } finally {
        $archive.Dispose()
    }
}

function Assert-ZipEntry {
    param(
        [Parameter(Mandatory = $true)][string[]]$Entries,
        [Parameter(Mandatory = $true)][string]$Expected
    )
    if ($Entries -notcontains $Expected) {
        throw "压缩包缺少条目: $Expected"
    }
}

Write-Host "[测试] 配置兼容性回归测试..."
Invoke-Checked {
    cmake -S $Root -B $BuildPath -A $CMakeArch -DBUILD_TESTS=ON
} "CMake 配置失败"

Write-Host "[测试] 编译 DLL 与全部测试目标..."
Invoke-Checked {
    cmake --build $BuildPath --config $Config
} "测试目标编译失败"

Write-Host "[测试] 运行 CTest..."
Invoke-Checked {
    ctest --test-dir $BuildPath -C $Config --output-on-failure
} "CTest 回归失败"

if (-not $SkipReleaseLayout) {
    Write-Host "[测试] 生成并检查 release 部署目录..."
    Invoke-Checked {
        & (Join-Path $Root "build.ps1") -Config $Config -Arch $Arch -SkipTests
    } "Release 产物生成失败"

    $Output = Join-Path $Root "output"
    $Ide = Join-Path $Output "ide"
    $Cli = Join-Path $Output "cli"

    Assert-FileExists (Join-Path $Ide "version.dll")
    Assert-FileExists (Join-Path $Ide "config.json")
    Assert-FileExists (Join-Path $Cli "dbghelp.dll")
    Assert-FileExists (Join-Path $Cli "antigravity_proxy.dll")
    Assert-FileExists (Join-Path $Cli "config.json")
    Assert-FileExists (Join-Path $Output "config-web.html")
    Assert-FileExists (Join-Path $Output "使用说明.md")

    if (Test-Path -LiteralPath (Join-Path $Ide "dbghelp.dll")) {
        throw "IDE 目录不应包含 dbghelp.dll"
    }
    $rootDlls = @(Get-ChildItem -LiteralPath $Output -File -Filter "*.dll")
    if ($rootDlls.Count -ne 0) {
        throw "output 根目录仍存在可混装 DLL: $($rootDlls.Name -join ', ')"
    }

    $configObject = Get-Content -LiteralPath (Join-Path $Ide "config.json") -Raw -Encoding UTF8 |
        ConvertFrom-Json
    if ($configObject.proxy_rules.udp_mode -ne "auto") {
        throw "生成配置的 proxy_rules.udp_mode 不是 auto"
    }
    if ($configObject.proxy_rules.udp_fallback -ne "block") {
        throw "生成配置的 proxy_rules.udp_fallback 不是 block"
    }
    if ($configObject.diagnostics.agent_ip_probe -ne $false) {
        throw "生成配置的 diagnostics.agent_ip_probe 应默认关闭"
    }

    $configWeb = Get-Content -LiteralPath (Join-Path $Output "config-web.html") -Raw -Encoding UTF8
    if ($configWeb -notmatch 'data-bind="diagnostics\.agent_ip_probe"') {
        throw "配置页缺少 diagnostics.agent_ip_probe 控件"
    }
    if ($configWeb -notmatch '<option value="auto">auto</option>') {
        throw "配置页缺少 udp_mode=auto 选项"
    }

    Write-Host "[测试] 生成并检查 IDE/CLI 独立发布包..."
    $PackageDir = Join-Path $BuildPath "release-packages"
    & (Join-Path $Root "scripts\package-release.ps1") `
        -Version "0.0.0" `
        -Arch $Arch `
        -OutputDir $Output `
        -DestinationDir $PackageDir | Out-Host

    $IdeZip = Join-Path $PackageDir "antigravity-proxy-v0.0.0-ide-win-$Arch.zip"
    $CliZip = Join-Path $PackageDir "antigravity-proxy-v0.0.0-cli-win-$Arch.zip"
    Assert-FileExists $IdeZip
    Assert-FileExists $CliZip

    $IdeEntries = Get-ZipEntryNames $IdeZip
    Assert-ZipEntry $IdeEntries "ide/version.dll"
    Assert-ZipEntry $IdeEntries "ide/config.json"
    Assert-ZipEntry $IdeEntries "config-web.html"
    Assert-ZipEntry $IdeEntries "使用说明.md"
    Assert-ZipEntry $IdeEntries "setup.bat"
    Assert-ZipEntry $IdeEntries "setup.sh"
    Assert-ZipEntry $IdeEntries "launcher/install-windows.ps1"
    Assert-ZipEntry $IdeEntries "launcher/install-linux.sh"
    if ($IdeEntries -match '(^|/)cli/' -or $IdeEntries -match 'dbghelp\.dll$' -or $IdeEntries -match 'antigravity_proxy\.dll$') {
        throw "IDE 压缩包出现 CLI 专用文件"
    }

    $CliEntries = Get-ZipEntryNames $CliZip
    Assert-ZipEntry $CliEntries "cli/dbghelp.dll"
    Assert-ZipEntry $CliEntries "cli/antigravity_proxy.dll"
    Assert-ZipEntry $CliEntries "cli/config.json"
    Assert-ZipEntry $CliEntries "config-web.html"
    Assert-ZipEntry $CliEntries "使用说明.md"
    Assert-ZipEntry $CliEntries "setup.bat"
    Assert-ZipEntry $CliEntries "setup.sh"
    Assert-ZipEntry $CliEntries "launcher/install-windows.ps1"
    Assert-ZipEntry $CliEntries "launcher/install-linux.sh"
    if ($CliEntries -match '(^|/)ide/' -or $CliEntries -match '(^|/)version\.dll$') {
        throw "CLI 压缩包出现 IDE 专用文件"
    }
}

if ($SkipReleaseLayout) {
    Write-Host "[测试] UDP/IPv6/DbgHelp 回归通过（已按参数跳过发布目录检查）。"
} else {
    Write-Host "[测试] UDP/IPv6/DbgHelp、发布目录与独立压缩包回归通过。"
}
