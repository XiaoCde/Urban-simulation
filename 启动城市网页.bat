@echo off
setlocal
title 城市仿真 - 网页服务器[ 关掉此窗口 = 停止服务 ]
cd /d "%~dp0web"

set "PORT=8123"
if not "%~1"=="" set "PORT=%~1"

if not exist "D:\AI\node.exe" goto NONODE
if not exist "serve.js" goto NOSERVE
netstat -ano | findstr "LISTENING" | findstr ":%PORT% " >nul
if not errorlevel 1 goto INUSE

echo.
echo   城市仿真网页
echo   ----------------------------------------
echo   本页   http://127.0.0.1:%PORT%/
echo   积涝   http://127.0.0.1:%PORT%/?flood=1
echo   ----------------------------------------
echo   浏览器 2 秒后自动打开；没打开就手动复制上面的地址。
echo   这个黑窗口要一直开着，关掉它网页就打不开了。
echo.

start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 2; Start-Process 'http://127.0.0.1:%PORT%/?flood=1'"
"D:\AI\node.exe" serve.js %PORT%

echo.
echo 服务已停止。
pause
exit /b 0

:INUSE
echo [提示] 端口 %PORT% 已经被占用，可能网页服务早就跑起来了。
echo        先直接打开 http://127.0.0.1:%PORT%/?flood=1 试试。
echo        想换端口：在本文件所在目录运行  启动城市网页.bat 8124
pause
exit /b 0

:NONODE
echo [错误] 找不到 D:\AI\node.exe
pause
exit /b 1

:NOSERVE
echo [错误] 在 %CD% 下找不到 serve.js
pause
exit /b 1
