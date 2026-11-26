@echo off
chcp 65001 >nul
setlocal

set "NODE_EXE="
call :check_node "%LOCALAPPDATA%\antigravity-node\node.exe"
if not defined NODE_EXE (
    for /f "delims=" %%i in ('where node.exe 2^>nul') do (
        if not defined NODE_EXE call :check_node "%%i"
    )
)
if not defined NODE_EXE call :check_node "D:\nodejs\node.exe"
if not defined NODE_EXE call :check_node "C:\Program Files\nodejs\node.exe"
if not defined NODE_EXE call :check_node "%LOCALAPPDATA%\Programs\nodejs\node.exe"

if not defined NODE_EXE (
    echo [提示] 未检测到 Node.js 20+，正在自动下载并配置运行环境...
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1" -SkipPlugin -SkipSync -NoPause
    if errorlevel 1 (
        echo [错误] 自动安装 Node.js 失败，请前往 https://nodejs.org/ 手动安装后重试。
        if /i "%~1"=="/noopen" exit /b 1
        pause
        exit /b 1
    )
    call :check_node "%LOCALAPPDATA%\antigravity-node\node.exe"
    if not defined NODE_EXE (
        for /f "delims=" %%i in ('where node.exe 2^>nul') do (
            if not defined NODE_EXE call :check_node "%%i"
        )
    )
)

if not defined NODE_EXE (
    echo [错误] 未找到 Node.js 20+，请重启终端或安装 Node.js LTS 后重试。
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
exit /b 0

:check_node
set "CAND=%~1"
if "%CAND%"=="" goto :eof
if not exist "%CAND%" goto :eof
set "VER_OUT="
for /f "delims=" %%v in ('""%CAND%" -v 2^>nul"') do (
    if not defined VER_OUT set "VER_OUT=%%v"
)
if not defined VER_OUT goto :eof
set "VER_OUT=%VER_OUT:v=%"
for /f "tokens=1 delims=." %%m in ("%VER_OUT%") do set "MAJ=%%m"
if "%MAJ%"=="" goto :eof
set /a MAJ_NUM=%MAJ% 2>nul
if %MAJ_NUM% GEQ 20 set "NODE_EXE=%CAND%"
goto :eof
