@echo off
chcp 65001 >nul
setlocal

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1" -NoPause
if errorlevel 1 (
    echo.
    echo [错误] 一键安装失败，请检查上方报错信息。
    if /i "%~1"=="/nopause" exit /b 1
    pause
    exit /b 1
)

if /i "%~1"=="/nopause" exit /b 0
echo.
pause
