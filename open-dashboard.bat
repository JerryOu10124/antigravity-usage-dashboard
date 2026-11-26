@echo off
chcp 65001 >nul
setlocal

set "NODE_EXE="
for /f "delims=" %%i in ('where node.exe 2^>nul') do (
    if not defined NODE_EXE set "NODE_EXE=%%i"
)
if not defined NODE_EXE if exist "%LOCALAPPDATA%\antigravity-node\node.exe" set "NODE_EXE=%LOCALAPPDATA%\antigravity-node\node.exe"
if not defined NODE_EXE if exist "D:\nodejs\node.exe" set "NODE_EXE=D:\nodejs\node.exe"
if not defined NODE_EXE if exist "C:\Program Files\nodejs\node.exe" set "NODE_EXE=C:\Program Files\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE_EXE (
    echo [提示] 未检测到 Node.js 20+，正在自动下载并配置运行环境...
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1" -SkipPlugin -SkipSync -NoPause
    if errorlevel 1 (
        echo [错误] 自动安装 Node.js 失败，请前往 https://nodejs.org/ 手动安装后重试。
        if /i "%~1"=="/noopen" exit /b 1
        pause
        exit /b 1
    )
    if exist "%LOCALAPPDATA%\antigravity-node\node.exe" set "NODE_EXE=%LOCALAPPDATA%\antigravity-node\node.exe"
    if not defined NODE_EXE (
        for /f "delims=" %%i in ('where node.exe 2^>nul') do (
            if not defined NODE_EXE set "NODE_EXE=%%i"
        )
    )
)

if not defined NODE_EXE (
    echo [错误] 未找到 node.exe，请重启终端或安装 Node.js 20+ 后重试。
    if /i "%~1"=="/noopen" exit /b 1
    pause
    exit /b 1
)

"%NODE_EXE%" "%~dp0sync_usage.mjs"
if errorlevel 1 (
    echo.
    echo [错误] 统计脚本执行失败，请检查上方提示。
    if /i "%~1"=="/noopen" exit /b 1
    pause
    exit /b 1
)

if /i "%~1"=="/noopen" exit /b 0
start "" "%~dp0dashboard.html"
