@echo off
chcp 65001 >nul
REM browser-whiskor — Server start script (Windows)
cd /d "%~dp0"

if not exist node_modules (
  echo [SI] node_modules not found. Running npm install...
  call npm install
)

if not exist cache\sessions mkdir cache\sessions

echo.
echo ╔══════════════════════════════════════════════╗
echo ║       Site Inspector v2  —  Server           ║
echo ╠══════════════════════════════════════════════╣
echo ║  WebSocket   ws://localhost:7891             ║
echo ║  HTTP API    http://localhost:7892/api       ║
echo ║  Dashboard   http://localhost:7892/          ║
echo ╚══════════════════════════════════════════════╝
echo.
echo   拡張機能をChromiumに読み込んだ後、
echo   ブラウザのDevToolsを開いてください。
echo.

node server/index.js %*
pause
