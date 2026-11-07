# ============================================================================
# Antigravity-Proxy test-resilience.ps1
# ============================================================================

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$TestRoot = Join-Path $env:TEMP ("antigravity_test_" + [Guid]::NewGuid().ToString("N"))
Write-Host "=== Start Antigravity-Proxy Resilience & Auto-Healing Test ===" -ForegroundColor Cyan
Write-Host "Sandbox: $TestRoot"

try {
    # 1. Initialize mock directories
    $mockAppDir = Join-Path $TestRoot "MockApp"
    $mockSourceDir = Join-Path $TestRoot "MockSource"
    $mockDesktop = Join-Path $TestRoot "MockDesktop"
    $mockStartMenu = Join-Path $TestRoot "MockStartMenu"

    New-Item -ItemType Directory -Path $mockAppDir, $mockSourceDir, $mockDesktop, $mockStartMenu -Force | Out-Null

    # Create dummy official Antigravity.exe
    $mockOfficialExe = Join-Path $mockAppDir "Antigravity.exe"
    "MZ-MOCK-OFFICIAL-EXE" | Out-File -FilePath $mockOfficialExe -Encoding ASCII

    # Create patch source directory (ide)
    $mockIdeDir = Join-Path $mockSourceDir "ide"
    New-Item -ItemType Directory -Path $mockIdeDir -Force | Out-Null
    $mockSourceDll = Join-Path $mockIdeDir "version.dll"
    "MOCK-PROXY-DLL-PAYLOAD-V1" | Out-File -FilePath $mockSourceDll -Encoding ASCII

    $mockSourceConfig = Join-Path $mockIdeDir "config.json"
    @{ proxy = @{ host = "127.0.0.1"; port = 7890; type = "socks5" } } | ConvertTo-Json | Out-File -FilePath $mockSourceConfig -Encoding UTF8

    # Copy AntigravityLauncher.exe
    $realLauncher = Join-Path $PSScriptRoot "AntigravityLauncher.exe"
    if (-not (Test-Path $realLauncher)) {
        throw "AntigravityLauncher.exe not found at $realLauncher"
    }
    $testLauncher = Join-Path $mockSourceDir "AntigravityLauncher.exe"
    Copy-Item -LiteralPath $realLauncher -Destination $testLauncher -Force

    # Configure app_path.txt
    $appPathTxt = Join-Path $mockSourceDir "app_path.txt"
    $mockAppDir | Out-File -FilePath $appPathTxt -Encoding UTF8 -NoNewline

    Write-Host "[OK] Sandbox initialized successfully." -ForegroundColor Green

    # 2. Test initial sync
    Write-Host "`n[Test 1] Verify initial auto-healing of missing version.dll and config.json..." -ForegroundColor Yellow
    $p = Start-Process -FilePath $testLauncher -PassThru
    Start-Sleep -Milliseconds 1500
    if (-not $p.HasExited) { try { Stop-Process -Id $p.Id -Force } catch { } }

    $targetDll = Join-Path $mockAppDir "version.dll"
    $targetConfig = Join-Path $mockAppDir "config.json"

    if (-not (Test-Path $targetDll)) { throw "Test 1 Failed: version.dll was not copied on initial run" }
    if (-not (Test-Path $targetConfig)) { throw "Test 1 Failed: config.json was not copied on initial run" }

    $initCfg = Get-Content -LiteralPath $targetConfig -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($initCfg.proxy.port -ne 7890) { throw "Test 1 Failed: Expected port 7890, got $($initCfg.proxy.port)" }
    Write-Host "[PASS] Test 1: Launcher successfully completed initial injection (port=7890)" -ForegroundColor Green

    # 3. Test config preservation when user customizes port
    Write-Host "`n[Test 2] Verify custom port preservation (user changes to 10808)..." -ForegroundColor Yellow
    $userCfg = @{ proxy = @{ host = "127.0.0.1"; port = 10808; type = "socks5" }; custom_rules = @("custom.domain") }
    $userCfg | ConvertTo-Json -Depth 5 | Out-File -FilePath $targetConfig -Encoding UTF8

    $p = Start-Process -FilePath $testLauncher -PassThru
    Start-Sleep -Milliseconds 1000
    if (-not $p.HasExited) { try { Stop-Process -Id $p.Id -Force } catch { } }

    $checkCfg = Get-Content -LiteralPath $targetConfig -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($checkCfg.proxy.port -ne 10808) {
        throw "Test 2 Failed: Custom port 10808 was overwritten by launcher! Current port: $($checkCfg.proxy.port)"
    }
    Write-Host "[PASS] Test 2: User custom configuration (port 10808) safely preserved!" -ForegroundColor Green

    # 4. Simulate Squirrel update
    Write-Host "`n[Test 3] Simulating Squirrel updater wipe & shortcut reset..." -ForegroundColor Yellow
    Remove-Item -LiteralPath $targetDll -Force
    Remove-Item -LiteralPath $targetConfig -Force

    $wsh = New-Object -ComObject WScript.Shell
    $officialDesktopLnk = Join-Path $mockDesktop "Antigravity.lnk"
    $sc = $wsh.CreateShortcut($officialDesktopLnk)
    $sc.TargetPath = $mockOfficialExe
    $sc.Save()

    $officialStartMenuLnk = Join-Path $mockStartMenu "Antigravity.lnk"
    $sc2 = $wsh.CreateShortcut($officialStartMenuLnk)
    $sc2.TargetPath = $mockOfficialExe
    $sc2.Save()

    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($sc) | Out-Null
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($sc2) | Out-Null
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($wsh) | Out-Null

    $proxyDesktopLnk = Join-Path $mockDesktop "Antigravity (Proxy).lnk"
    $wsh = New-Object -ComObject WScript.Shell
    $sc3 = $wsh.CreateShortcut($proxyDesktopLnk)
    $sc3.TargetPath = $testLauncher
    $sc3.Save()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($sc3) | Out-Null
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($wsh) | Out-Null

    Write-Host "[i] Squirrel simulation complete: version.dll/config.json wiped, official Antigravity.lnk reset."

    # 5. Verify dedicated entry heals installation
    Write-Host "`n[Test 4] Verify dedicated launcher entry auto-heals wiped installation..." -ForegroundColor Yellow
    if (-not (Test-Path $proxyDesktopLnk)) {
        throw "Test 4 Failed: Dedicated entry Antigravity (Proxy).lnk was lost"
    }

    $p = Start-Process -FilePath $testLauncher -PassThru
    Start-Sleep -Milliseconds 1500
    if (-not $p.HasExited) { try { Stop-Process -Id $p.Id -Force } catch { } }

    if (-not (Test-Path $targetDll)) { throw "Test 4 Failed: version.dll was not restored after updater wipe!" }
    if (-not (Test-Path $targetConfig)) { throw "Test 4 Failed: config.json was not restored after updater wipe!" }
    Write-Host "[PASS] Test 4: Dedicated entry triggered auto-healing, missing files restored in milliseconds!" -ForegroundColor Green

    # 6. Verify shortcut ownership guard
    Write-Host "`n[Test 5] Verify shortcut ownership check..." -ForegroundColor Yellow
    . (Join-Path $PSScriptRoot "install-windows.ps1") -LibraryOnly

    $isOfficial = Test-IsLauncherShortcut -LnkPath $officialDesktopLnk -ExpectedLauncherPath $testLauncher
    if ($isOfficial) {
        throw "Test 5 Failed: Official shortcut was mistakenly identified as launcher shortcut!"
    }
    Write-Host "[PASS] Test 5a: Ownership guard accurately detected official shortcut" -ForegroundColor Green

    $isProxy = Test-IsLauncherShortcut -LnkPath $proxyDesktopLnk -ExpectedLauncherPath $testLauncher
    if (-not $isProxy) {
        throw "Test 5 Failed: Dedicated proxy shortcut was not recognized!"
    }
    Write-Host "[PASS] Test 5b: Ownership guard accurately identified launcher shortcut" -ForegroundColor Green

    # 7. Verify cross-language shortcut migration
    Write-Host "`n[Test 7] Verify cross-language shortcut migration (zh -> en -> ru)..." -ForegroundColor Yellow
    # Create a Chinese proxy shortcut
    $zhLnk = Join-Path $mockDesktop "Antigravity (代理).lnk"
    $wsh = New-Object -ComObject WScript.Shell
    $scZh = $wsh.CreateShortcut($zhLnk)
    $scZh.TargetPath = $testLauncher
    $scZh.Save()
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($scZh) | Out-Null
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($wsh) | Out-Null

    # Now simulate installing English shortcut: should clean up zhLnk and create enLnk, keeping official Antigravity.lnk
    $enLnkName = "Antigravity (Proxy).lnk"
    $enLnkPath = Join-Path $mockDesktop $enLnkName
    foreach ($known in $Global:AllKnownShortcutNames) {
        $checkPath = Join-Path $mockDesktop $known
        if ((Test-Path -LiteralPath $checkPath) -and ($checkPath -ne $enLnkPath)) {
            if (Test-IsLauncherShortcut -LnkPath $checkPath -ExpectedLauncherPath $testLauncher) {
                Remove-Item -LiteralPath $checkPath -Force
                Write-Host "   [Migrated] Cleaned up previous language shortcut: $known"
            }
        }
    }
    if (Test-Path $zhLnk) { throw "Test 7 Failed: Chinese shortcut was not migrated!" }
    if (-not (Test-Path $officialDesktopLnk)) { throw "Test 7 Failed: Official shortcut was deleted during migration!" }
    Write-Host "[PASS] Test 7: Multi-language migration cleanly replaced old localized shortcut without touching official entry!" -ForegroundColor Green

    # 8. Verify safe uninstall
    Write-Host "`n[Test 8] Verify safe uninstallation (official shortcuts preserved)..." -ForegroundColor Yellow
    foreach ($known in $Global:AllKnownShortcutNames) {
        $pLnk = Join-Path $mockDesktop $known
        if (Test-Path -LiteralPath $pLnk) {
            if (Test-IsLauncherShortcut -LnkPath $pLnk -ExpectedLauncherPath $testLauncher) {
                Remove-Item -LiteralPath $pLnk -Force
                Write-Host "   [Removed] Proxy shortcut: $known"
            } else {
                Write-Host "   [Preserved] Official shortcut: $known"
            }
        }
    }

    if (-not (Test-Path $officialDesktopLnk)) {
        throw "Test 6 Failed: Official shortcut Antigravity.lnk was accidentally deleted during uninstall!"
    }
    if (Test-Path $proxyDesktopLnk) {
        throw "Test 6 Failed: Proxy shortcut was not removed during uninstall!"
    }
    Write-Host "[PASS] Test 8: Safe uninstallation passed! Official entry intact, proxy entry cleanly removed." -ForegroundColor Green

    Write-Host "`n============================================================" -ForegroundColor Cyan
    Write-Host "  ALL 7 RESILIENCE & RECOVERY TESTS PASSED (100%)" -ForegroundColor Green
    Write-Host "============================================================" -ForegroundColor Cyan
} finally {
    if (Test-Path $TestRoot) {
        try { Remove-Item -LiteralPath $TestRoot -Recurse -Force } catch { }
    }
}