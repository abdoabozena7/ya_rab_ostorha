@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-YA-RAB-OSTORHA.ps1" %*
if errorlevel 1 (
    echo.
    echo Startup failed. See the error above.
    pause
    exit /b 1
)
