[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Version,
    [ValidateSet("x64", "x86")]
    [string]$Arch = "x64",
    [string]$OutputDir = "",
    [Parameter(Mandatory = $true)]
    [string]$DestinationDir
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    $OutputDir = Join-Path $Root "output"
}

$normalizedVersion = $Version.Trim()
if ($normalizedVersion.StartsWith("v", [System.StringComparison]::OrdinalIgnoreCase)) {
    $normalizedVersion = $normalizedVersion.Substring(1)
}
if ($normalizedVersion -notmatch '^\d+\.\d+(?:\.\d+)?$') {
    throw "发布版本格式错误: $Version（应为 1.2 或 1.2.3）"
}

$tag = "v$normalizedVersion"
$requiredFiles = @(
    "ide\version.dll",
    "ide\config.json",
    "cli\dbghelp.dll",
    "cli\antigravity_proxy.dll",
    "cli\config.json",
    "config-web.html",
    "使用说明.md"
)
foreach ($relativePath in $requiredFiles) {
    $path = Join-Path $OutputDir $relativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "发布目录缺少必需文件: $relativePath"
    }
}

# 发布前同时校验两套目录，尽早阻断旧文件残留造成的入口混装。
$forbiddenFiles = @(
    "ide\dbghelp.dll",
    "ide\antigravity_proxy.dll",
    "cli\version.dll",
    "version.dll",
    "dbghelp.dll",
    "antigravity_proxy.dll"
)
foreach ($relativePath in $forbiddenFiles) {
    if (Test-Path -LiteralPath (Join-Path $OutputDir $relativePath) -PathType Leaf) {
        throw "发布目录出现跨产品 DLL: $relativePath"
    }
}

New-Item -ItemType Directory -Path $DestinationDir -Force | Out-Null
$stagingRoot = Join-Path $DestinationDir ".package-$Arch-$([guid]::NewGuid().ToString('N'))"
$ideZip = Join-Path $DestinationDir "antigravity-proxy-$tag-ide-win-$Arch.zip"
$cliZip = Join-Path $DestinationDir "antigravity-proxy-$tag-cli-win-$Arch.zip"

try {
    foreach ($product in @("ide", "cli")) {
        $productStage = Join-Path $stagingRoot "$product-package"
        New-Item -ItemType Directory -Path $productStage -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $OutputDir $product) `
            -Destination (Join-Path $productStage $product) -Recurse -Force
        Copy-Item -LiteralPath (Join-Path $OutputDir "config-web.html") -Destination $productStage -Force
        Copy-Item -LiteralPath (Join-Path $OutputDir "使用说明.md") -Destination $productStage -Force
        if (Test-Path -LiteralPath (Join-Path $OutputDir "launcher")) {
            Copy-Item -LiteralPath (Join-Path $OutputDir "launcher") -Destination (Join-Path $productStage "launcher") -Recurse -Force
        }
        foreach ($entryFile in @("setup.bat", "setup.sh")) {
            $bPath = Join-Path $OutputDir $entryFile
            if (Test-Path -LiteralPath $bPath) {
                Copy-Item -LiteralPath $bPath -Destination $productStage -Force
            }
        }

        $zipPath = if ($product -eq "ide") { $ideZip } else { $cliZip }
        Compress-Archive -Path (Join-Path $productStage "*") -DestinationPath $zipPath -Force
        Write-Host "[打包] 已生成 $product 产物: $zipPath"
    }
} finally {
    if (Test-Path -LiteralPath $stagingRoot) {
        Remove-Item -LiteralPath $stagingRoot -Recurse -Force
    }
}

[PSCustomObject]@{
    IdeZip = $ideZip
    CliZip = $cliZip
}
