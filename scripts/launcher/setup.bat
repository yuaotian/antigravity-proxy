@echo off
chcp 65001 >nul 2>&1
setlocal

REM ============================================================================
REM Antigravity-Proxy Smart Setup & Management Wizard
REM Supported: Chinese / English / Russian
REM Auto-detect: Desktop IDE (ide-win-x64) and Console CLI (cli-win-x64)
REM ============================================================================

set "CUR_DIR=%~dp0"
if exist "%CUR_DIR%launcher\install-windows.ps1" (
    set "PS_SCRIPT=%CUR_DIR%launcher\install-windows.ps1"
) else if exist "%CUR_DIR%scripts\launcher\install-windows.ps1" (
    set "PS_SCRIPT=%CUR_DIR%scripts\launcher\install-windows.ps1"
) else if exist "%CUR_DIR%install-windows.ps1" (
    set "PS_SCRIPT=%CUR_DIR%install-windows.ps1"
) else (
    echo [Error] Installation script not found.
    pause
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" %*
if %ERRORLEVEL% neq 0 (
    echo.
    echo [Notice] Execution exited.
)
