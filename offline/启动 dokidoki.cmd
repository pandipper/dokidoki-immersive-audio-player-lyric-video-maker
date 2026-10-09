@echo off
setlocal
title dokidoki 字幕播放器 - 离线版
cd /d "%~dp0"

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"

echo.
echo   ================================================
echo     dokidoki 字幕播放器 - 离线版
echo   ================================================
echo.
echo   正在启动本地服务，浏览器会自动打开。
echo   使用完毕后，直接关闭本窗口即可停止服务。
echo.

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1" -Port 3000
set "rc=%ERRORLEVEL%"

echo.
if not "%rc%"=="0" (
    echo   [错误] 服务异常退出，退出码 %rc%
    echo   可尝试：右键本文件 -^> 以管理员身份运行
) else (
    echo   服务已停止。
)
echo.
pause
exit /b %rc%
