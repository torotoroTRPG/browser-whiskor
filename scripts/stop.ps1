#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Stop running browser-whiskor server(s) — the supervisor and anything listening on
  WS:7891 / HTTP:7892.
.DESCRIPTION
  Stops in two steps:
    1. The supervisor (scripts/supervisor.js), if running, FIRST — otherwise it would
       see the worker we are about to kill as a crash and restart it right back.
    2. The worker process(es) listening on the whiskor ports. As a safety guard it only
       stops node processes whose command line actually runs `server/index.js`, so an
       unrelated program that happens to use the port is left alone.
  Note: MCP proxy processes (`--mcp`) do not bind a port, so they are not targeted here —
  they exit when their client (Claude Desktop/Code) closes.
.EXAMPLE
  .\scripts\stop.ps1
#>
Set-StrictMode -Version Latest
[System.Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$stopped = 0

# ── 1. Stop the supervisor(s) first so they don't restart the worker ──────────
$supervisors = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'scripts[\\/]supervisor\.js' })
foreach ($s in $supervisors) {
    Write-Host "Stopping supervisor PID $($s.ProcessId)" -ForegroundColor Cyan
    try {
        Stop-Process -Id $s.ProcessId -Force -ErrorAction Stop
        $stopped++
    } catch {
        Write-Host "  ✗ failed: $($_.Exception.Message)" -ForegroundColor Red
    }
}
# Give a killed supervisor a moment to release its child before we hunt the worker.
if ($supervisors.Count -gt 0) { Start-Sleep -Milliseconds 300 }

# ── 2. Stop the worker(s) listening on the whiskor ports ──────────────────────
$ports = 7891, 7892
$procIds = @()
foreach ($port in $ports) {
    try {
        $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
        foreach ($c in $conns) { $procIds += [int]$c.OwningProcess }
    } catch { }
}
$procIds = $procIds | Where-Object { $_ -gt 0 } | Sort-Object -Unique

foreach ($procId in $procIds) {
    $proc = $null
    try { $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $procId" -ErrorAction Stop } catch { }
    if (-not $proc) { continue }
    $cmd = [string]$proc.CommandLine

    if ($proc.Name -match 'node' -and $cmd -match 'server[\\/]index\.js') {
        Write-Host "Stopping PID $procId" -ForegroundColor Cyan
        Write-Host "  $cmd" -ForegroundColor DarkGray
        try {
            Stop-Process -Id $procId -Force -ErrorAction Stop
            $stopped++
        } catch {
            Write-Host "  ✗ failed: $($_.Exception.Message)" -ForegroundColor Red
        }
    } else {
        Write-Host "Skipping PID $procId — not a browser-whiskor server ($($proc.Name))" -ForegroundColor DarkGray
    }
}

if ($stopped -eq 0) {
    Write-Host "✓ No browser-whiskor supervisor/server running on 7891/7892." -ForegroundColor Yellow
    exit 0
}

Write-Host "`n✓ Stopped $stopped browser-whiskor process(es)." -ForegroundColor Green
