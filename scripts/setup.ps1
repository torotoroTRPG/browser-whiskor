#!/usr/bin/env pwsh
<#
.SYNOPSIS
  First-run bootstrap for browser-whiskor: register the `whk` / `whiskor` CLI
  globally, install the browser extension into the managed directory
  (~/.whiskor/), then start the server.
.DESCRIPTION
  Run this ONCE after cloning / unzipping. It:
    1. registers the CLI on your PATH via `npm link` (skipped if `whk` already
       resolves, or with -NoRegister),
    2. hands off to `whk setup` (node server/cli.js setup), which copies the
       bundled extension(s) to ~/.whiskor/, prints the one-time "load unpacked"
       instructions, and starts the server.
  Running it AGAIN later is also fine — it then behaves like start.ps1:
  refreshes the managed extension files and starts the server, or, if a server
  is already running, asks the connected extension to reload itself.
  Extra args pass through to the server, e.g. `--verbose`.
.EXAMPLE
  .\scripts\setup.ps1
  .\scripts\setup.ps1 -NoStart          # sync CLI + extension files only
  .\scripts\setup.ps1 -NoRegister --verbose
#>
param([switch]$NoStart, [switch]$NoRegister)
[System.Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $PSScriptRoot

# 1. Register whk / whiskor on PATH (npm link) when not yet available
if (-not $NoRegister) {
    $whk = Get-Command whk -ErrorAction SilentlyContinue
    if (-not $whk) {
        Write-Host "`n🔗 Registering 'whk' / 'whiskor' commands globally (npm link)..." -ForegroundColor Yellow
        Push-Location $root
        try { npm link } finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) {
            Write-Host "npm link failed — you can still use 'node server/cli.js' directly. Continuing." -ForegroundColor DarkYellow
        } else {
            Write-Host "(if 'whk' is not found in THIS terminal, open a new one — PATH is read at shell start)" -ForegroundColor DarkGray
        }
    }
}

# 2. Extension install/refresh + server start — the Node CLI does the real work.
#    Called via node directly so it works even before PATH picks up the new command.
$setupArgs = @('setup')
if ($NoStart) { $setupArgs += '--no-start' }
& node (Join-Path $root 'server/cli.js') @setupArgs @args
exit $LASTEXITCODE
