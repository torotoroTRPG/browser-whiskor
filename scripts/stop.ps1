#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Stop running browser-whiskor server(s) — anything listening on WS:7891 / HTTP:7892.
.DESCRIPTION
  Finds the process(es) that own the whiskor ports and stops them. As a safety guard it
  only stops node processes whose command line actually runs `server/index.js`, so an
  unrelated program that happens to use the port is left alone.
  Note: MCP proxy processes (`--mcp`) do not bind a port, so they are not targeted here —
  they exit when their client (Claude Desktop/Code) closes.
.EXAMPLE
  .\scripts\stop.ps1
#>
Set-StrictMode -Version Latest
[System.Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$ports = 7891, 7892
$procIds = @()
foreach ($port in $ports) {
    try {
        $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
        foreach ($c in $conns) { $procIds += [int]$c.OwningProcess }
    } catch { }
}
$procIds = $procIds | Where-Object { $_ -gt 0 } | Sort-Object -Unique

if (-not $procIds) {
    Write-Host "✓ No browser-whiskor server is listening on 7891/7892." -ForegroundColor Yellow
    exit 0
}

$stopped = 0
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

Write-Host "`n✓ Stopped $stopped browser-whiskor server process(es)." -ForegroundColor Green
