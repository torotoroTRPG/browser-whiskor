#!/usr/bin/env pwsh
# browser-whiskor — Server start script (Windows PowerShell)
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
param(
  [switch]$mock,
  [switch]$verbose,
  [switch]$NoSupervisor,   # run the worker directly (no auto-restart)
  [switch]$NoOcrPrompt,    # skip the optional OCR-engine install offer
  [string]$cacheDir = ""
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

# Version is read from package.json (the single source of truth) so the banner
# never goes stale as releases are cut.
$bwVer = try { (Get-Content "package.json" -Raw | ConvertFrom-Json).version } catch { "?" }

# node_modules
if (-not (Test-Path "node_modules")) {
  Write-Host "[bw] node_modules not found. Running npm install..." -ForegroundColor Yellow
  npm install
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[bw] npm install failed." -ForegroundColor Red
    exit 1
  }
}

# cache directory
if (-not (Test-Path "cache\sessions")) { New-Item -ItemType Directory -Path "cache\sessions" -Force | Out-Null }

# ── Check if ports are already in use ──────────────────────────────
$port1 = 7891; $port2 = 7892
$inUse = $false
$existingProcesses = @()

$connections = netstat -ano 2>$null | Select-String "LISTENING"
foreach ($c in $connections) {
  $parts = $c -split '\s+'
  $addr = $parts[-2]
  $procId = $parts[-1]
  if ($addr -match ":($port1|$port2)`$") {
    $inUse = $true
    $existingProcesses += @{ Port = [int]$Matches[1]; Pid = [int]$procId }
  }
}

if ($inUse) {
  $pidList = ($existingProcesses | Select-Object -Property Pid -Unique).Pid
  Write-Host ""
  Write-Host "[bw] Port $port1 or $port2 is already in use by PID(s): $($pidList -join ', ')" -ForegroundColor Yellow
  Write-Host "[bw] Override existing server? (y/N, default: N, timeout: 10s)" -ForegroundColor Yellow -NoNewline
  Write-Host " " -NoNewline

  $response = $null
  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  while ($timer.Elapsed.TotalSeconds -lt 10 -and $response -eq $null) {
    if ([Console]::KeyAvailable) {
      $key = [Console]::ReadKey($true)
      $response = $key.KeyChar
    }
    Start-Sleep -Milliseconds 100
  }
  $timer.Stop()

  if ($response -eq 'y' -or $response -eq 'Y') {
    Write-Host "y"
    Write-Host "[bw] Stopping existing server..." -ForegroundColor Yellow
    foreach ($p in ($existingProcesses | Select-Object -Property Pid -Unique)) {
      try { Stop-Process -Id $p.Pid -Force -ErrorAction Stop; Write-Host "[bw] Killed PID $($p.Pid)" } catch { }
    }
    Start-Sleep 1
  } else {
    if ($response) { Write-Host $response }
    Write-Host "[bw] Exiting." -ForegroundColor Gray
    exit 0
  }
}

# ── OCR engine offer (optional perception feature) ─────────────────
# ocr_region / POST /api/ocr read text from pixels — canvas/WebGL apps (Unity,
# games) and icon-only buttons. The engine is bring-your-own; if none is found we
# offer to install Tesseract. Never blocks startup. Skip with -NoOcrPrompt,
# WHISKOR_OCR_NO_PROMPT=1, or once dismissed (cache\.ocr-offer-dismissed).
function Test-WhiskorOcr {
  if ($env:WHISKOR_OCR_PATH -and (Test-Path $env:WHISKOR_OCR_PATH)) { return $true }
  return [bool](Get-Command tesseract -ErrorAction SilentlyContinue)
}
$ocrDismissed = Join-Path $ScriptDir "cache\.ocr-offer-dismissed"
if (-not $NoOcrPrompt -and -not $env:WHISKOR_OCR_NO_PROMPT -and -not (Test-Path $ocrDismissed) -and -not (Test-WhiskorOcr)) {
  Write-Host ""
  Write-Host "[bw] No OCR engine found (optional)." -ForegroundColor Yellow
  Write-Host "[bw] OCR lets whiskor read text from pixels — canvas/WebGL apps (Unity, games) and icon-only buttons (ocr_region / POST /api/ocr)." -ForegroundColor Gray
  if ([Console]::IsInputRedirected) {
    Write-Host "[bw] To enable: install Tesseract on PATH, or set WHISKOR_OCR_PATH / config intelligence.ocr.binPath. (WHISKOR_OCR_NO_PROMPT=1 silences this.)" -ForegroundColor DarkGray
  } else {
    $hasWinget = [bool](Get-Command winget -ErrorAction SilentlyContinue)
    $prompt = if ($hasWinget) { "[bw] Install Tesseract now? [G]lobal via winget  [L]ocal/manual how-to  [N]o  (default N, 10s): " }
              else            { "[bw] Install Tesseract? [L]ocal/manual how-to  [N]o  (default N, 10s): " }
    Write-Host $prompt -ForegroundColor Yellow -NoNewline
    $resp = $null
    $t = [System.Diagnostics.Stopwatch]::StartNew()
    while ($t.Elapsed.TotalSeconds -lt 10 -and $null -eq $resp) {
      if ([Console]::KeyAvailable) { $resp = [Console]::ReadKey($true).KeyChar }
      Start-Sleep -Milliseconds 100
    }
    $t.Stop()
    Write-Host ""
    if (($resp -eq 'g' -or $resp -eq 'G') -and $hasWinget) {
      Write-Host "[bw] Installing Tesseract via winget (UB-Mannheim.TesseractOCR)..." -ForegroundColor Cyan
      winget install --id UB-Mannheim.TesseractOCR -e --accept-package-agreements --accept-source-agreements
      if (Test-WhiskorOcr) { Write-Host "[bw] OCR engine installed." -ForegroundColor Green }
      else { Write-Host "[bw] Tesseract may need a new shell for PATH, or a manual install — https://github.com/UB-Mannheim/tesseract/wiki" -ForegroundColor Yellow }
    } elseif ($resp -eq 'l' -or $resp -eq 'L') {
      Write-Host "[bw] Local/manual OCR setup:" -ForegroundColor Cyan
      Write-Host "      1. Download Tesseract (Windows: https://github.com/UB-Mannheim/tesseract/wiki)" -ForegroundColor Gray
      Write-Host "      2. Point whiskor at it: `$env:WHISKOR_OCR_PATH = 'C:\path\to\tesseract.exe'  (or config.json intelligence.ocr.binPath)" -ForegroundColor Gray
      Write-Host "      For Japanese add the 'jpn' language data and use lang:'eng+jpn'." -ForegroundColor Gray
      New-Item -ItemType File -Path $ocrDismissed -Force | Out-Null
    } else {
      Write-Host "[bw] Skipping OCR. (Won't ask again; delete cache\.ocr-offer-dismissed or set WHISKOR_OCR_PATH later.)" -ForegroundColor DarkGray
      New-Item -ItemType File -Path $ocrDismissed -Force | Out-Null
    }
  }
}

# ── Environment ────────────────────────────────────────────────────
if ($cacheDir) { $env:WHISKOR_CACHE_DIR = $cacheDir }

# ── Banner ─────────────────────────────────────────────────────────
Write-Host ""
Write-Host "╔══════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║       browser-whiskor v$bwVer  —  Server   ║" -ForegroundColor Cyan
Write-Host "╠══════════════════════════════════════════════╣" -ForegroundColor Cyan
Write-Host "║  WebSocket   ws://localhost:$port1             ║" -ForegroundColor Cyan
Write-Host "║  HTTP API    http://localhost:$port2/api       ║" -ForegroundColor Cyan
Write-Host "║  Dashboard   http://localhost:$port2/          ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# By default the server runs under the supervisor (scripts/supervisor.js) so an
# unclean crash auto-restarts and the cache hands off cleanly. Use -NoSupervisor
# to run the worker directly (e.g. when debugging a crash you want to inspect).
if ($NoSupervisor) {
  $args = @("server/index.js")
} else {
  $args = @("scripts/supervisor.js")
  Write-Host "[bw] Supervised mode: auto-restart on crash (use -NoSupervisor to disable)." -ForegroundColor DarkGray
}
if ($mock) { $args += "--mock" }
if ($verbose) { $args += "--verbose" }

node $args
