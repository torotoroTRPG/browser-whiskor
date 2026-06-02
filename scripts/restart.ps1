#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Restart browser-whiskor: stop the running server, rebuild the extension (if source is
  present), then start a fresh server.
.DESCRIPTION
  Use this to APPLY changes (Node does not hot-reload). It:
    1. stops anything on 7891/7892,
    2. rebuilds the extension into build/ via scripts/build-test.ps1 — but ONLY when that
       script and the extension source exist (skipped automatically on a source-less /
       release layout), and skippable with -NoBuild,
    3. starts `node server/index.js` in the foreground (Ctrl+C to quit).
  Extra args pass through to the server, e.g. `--verbose`.
  Reminder: a rebuild updates build/, but you still reload the extension in the browser.
.EXAMPLE
  .\scripts\restart.ps1
  .\scripts\restart.ps1 -NoBuild --verbose
#>
param([switch]$NoBuild)
[System.Console]::OutputEncoding = [System.Text.Encoding]::UTF8

& "$PSScriptRoot\stop.ps1"
Start-Sleep -Milliseconds 400

$root        = Split-Path -Parent $PSScriptRoot
$buildScript = Join-Path $PSScriptRoot 'build-test.ps1'
$extSource   = Join-Path $root 'extension'

if (-not $NoBuild -and (Test-Path $buildScript) -and (Test-Path $extSource)) {
    Write-Host "`n🔨 Rebuilding extension (shared sync → build/)..." -ForegroundColor Yellow
    & $buildScript -NoStart
} elseif ($NoBuild) {
    Write-Host "`n(skipping rebuild: -NoBuild)" -ForegroundColor DarkGray
} else {
    Write-Host "`n(no extension build script/source found — skipping rebuild)" -ForegroundColor DarkGray
}

Write-Host "`n🚀 Starting fresh: node server/index.js  (Ctrl+C to stop)" -ForegroundColor Green
Write-Host "   (reload the browser extension if injected/ changed)`n" -ForegroundColor DarkGray

Push-Location $root
try {
    & node server/index.js @args
} finally {
    Pop-Location
}
