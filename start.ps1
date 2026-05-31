#!/usr/bin/env pwsh
# browser-whiskor — Server start script (Windows PowerShell)
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
param(
  [switch]$mock,
  [switch]$verbose,
  [string]$cacheDir = ""
)

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

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

# ── Environment ────────────────────────────────────────────────────
if ($cacheDir) { $env:WHISKOR_CACHE_DIR = $cacheDir }

# ── Banner ─────────────────────────────────────────────────────────
Write-Host ""
Write-Host "╔══════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║       browser-whiskor v0.3.4  —  Server   ║" -ForegroundColor Cyan
Write-Host "╠══════════════════════════════════════════════╣" -ForegroundColor Cyan
Write-Host "║  WebSocket   ws://localhost:$port1             ║" -ForegroundColor Cyan
Write-Host "║  HTTP API    http://localhost:$port2/api       ║" -ForegroundColor Cyan
Write-Host "║  Dashboard   http://localhost:$port2/          ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

$args = @("server/index.js")
if ($mock) { $args += "--mock" }
if ($verbose) { $args += "--verbose" }

node $args
