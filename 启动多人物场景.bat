@echo off
setlocal
title District scene - close this window to stop the server
cd /d "%~dp0web"

set "PORT=8123"
if not "%~1"=="" set "PORT=%~1"

if not exist "D:\AI\node.exe" goto NONODE
if not exist "serve.js" goto NOSERVE

netstat -ano | findstr "LISTENING" | findstr ":%PORT% " >nul
if not errorlevel 1 goto OPENONLY

echo.
echo   District scene server
echo   ----------------------------------------
echo   multi-agent   http://127.0.0.1:%PORT%/_legacy/district.html
echo   single-agent  http://127.0.0.1:%PORT%/_legacy/office.html
echo   whole city    http://127.0.0.1:%PORT%/
echo   ----------------------------------------
echo   Opening the multi-agent page in 2 seconds...
echo   Keep this window open while you use the page.
echo.
start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 2; Start-Process 'http://127.0.0.1:%PORT%/_legacy/district.html'"
"D:\AI\node.exe" serve.js %PORT%
echo.
echo   server stopped
pause
exit /b 0

:OPENONLY
echo   Port %PORT% already serving, opening the page directly.
start "" "http://127.0.0.1:%PORT%/_legacy/district.html"
exit /b 0

:NONODE
echo   Cannot find D:\AI\node.exe
pause
exit /b 1

:NOSERVE
echo   Cannot find web\serve.js
pause
exit /b 1
