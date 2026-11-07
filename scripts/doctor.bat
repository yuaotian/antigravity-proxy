@echo off
setlocal
chcp 65001 >nul
title Antigravity-Proxy Doctor

set "SCRIPT=%~dp0doctor.ps1"
if not exist "%SCRIPT%" (
    echo [ERROR] doctor.ps1 not found in this folder.
    echo         Keep doctor.bat and doctor.ps1 together.
    pause
    exit /b 3
)

echo Running Antigravity-Proxy doctor ...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
set "RC=%ERRORLEVEL%"

echo.
echo Exit code %RC%:  0 healthy / 1 needs repair / 2 repair incomplete / 3 environment or arguments
pause
endlocal
exit /b %RC%
