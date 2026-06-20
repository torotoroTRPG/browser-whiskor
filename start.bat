@echo off
chcp 65001 >nul
REM browser-whiskor — Server start script (Windows)
cd /d "%~dp0"

if not exist node_modules (
  echo [SI] node_modules not found. Running npm install...
  call npm install
)

if not exist cache\sessions mkdir cache\sessions

REM Version from package.json (single source of truth) so the banner never goes stale.
set "BW_VER=?"
for /f "delims=" %%v in ('node -p "require('./package.json').version" 2^>nul') do set "BW_VER=%%v"

REM ── OCR engine offer (optional) — read text from pixels (canvas/WebGL like Unity,
REM icon-only buttons) via ocr_region / POST /api/ocr. Engine is bring-your-own.
if defined WHISKOR_OCR_NO_PROMPT goto :ocr_done
if exist "cache\.ocr-offer-dismissed" goto :ocr_done
if defined WHISKOR_OCR_PATH if exist "%WHISKOR_OCR_PATH%" goto :ocr_done
where tesseract >nul 2>nul && goto :ocr_done
echo.
echo [bw] No OCR engine found (optional). OCR reads text from pixels —
echo [bw] canvas/WebGL apps (Unity) and icon-only buttons (ocr_region / POST /api/ocr).
choice /c GLN /t 10 /d N /m "[bw] Install Tesseract? G=global(winget) L=manual N=no"
if errorlevel 3 goto :ocr_no
if errorlevel 2 goto :ocr_local
where winget >nul 2>nul && (
  echo [bw] Installing Tesseract via winget...
  winget install --id UB-Mannheim.TesseractOCR -e --accept-package-agreements --accept-source-agreements
) || echo [bw] winget not found — see https://github.com/UB-Mannheim/tesseract/wiki
goto :ocr_done
:ocr_local
echo [bw] Manual: download Tesseract (https://github.com/UB-Mannheim/tesseract/wiki),
echo [bw] then set WHISKOR_OCR_PATH=C:\path\to\tesseract.exe (or config intelligence.ocr.binPath).
echo [bw] For Japanese add the 'jpn' language data and use lang:'eng+jpn'.
type nul > "cache\.ocr-offer-dismissed"
goto :ocr_done
:ocr_no
echo [bw] Skipping OCR. (Won't ask again; delete cache\.ocr-offer-dismissed to re-enable.)
type nul > "cache\.ocr-offer-dismissed"
:ocr_done

echo.
echo ╔══════════════════════════════════════════════╗
echo ║       browser-whiskor v%BW_VER%  —  Server
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
