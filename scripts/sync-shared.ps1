<#
.SYNOPSIS
    Sync shared/ files to both Chrome and Firefox extensions.

.DESCRIPTION
    Copies files from shared/injected/ to both extension/injected/ and
    firefox-mv2/injected/. Verifies that all files were copied successfully.

    Run this after editing any file in shared/ to propagate changes.

.EXAMPLE
    .\scripts\sync-shared.ps1
    .\scripts\sync-shared.ps1 -DryRun
    .\scripts\sync-shared.ps1 -Verbose
#>

[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot | Split-Path
$SharedDir = Join-Path $Root 'shared/injected'
$ChromeDir = Join-Path $Root 'extension/injected'
$FirefoxDir = Join-Path $Root 'firefox-mv2/injected'

if (-not (Test-Path $SharedDir)) {
    Write-Host "shared/injected/ not found. Nothing to sync." -ForegroundColor Yellow
    exit 0
}

$Files = Get-ChildItem -Path $SharedDir -Recurse -File
$Copied = 0
$Skipped = 0
$Errors = 0

Write-Host "`n Syncing shared/ to Chrome & Firefox extensions`n" -ForegroundColor Cyan

foreach ($File in $Files) {
    $RelPath = $File.FullName.Substring($SharedDir.Length + 1)
    $ChromeTarget = Join-Path $ChromeDir $RelPath
    $FirefoxTarget = Join-Path $FirefoxDir $RelPath

    if ($CheckOnly) {
        # Check mode: verify files match
        $ChromeMatch = (Test-Path $ChromeTarget) -and (Get-FileHash $File.FullName).Hash -eq (Get-FileHash $ChromeTarget).Hash
        $FirefoxMatch = (Test-Path $FirefoxTarget) -and (Get-FileHash $File.FullName).Hash -eq (Get-FileHash $FirefoxTarget).Hash

        if ($ChromeMatch -and $FirefoxMatch) {
            Write-Host "  $RelPath" -ForegroundColor Green
            $Copied++
        } else {
            $Issues = @()
            if (-not $ChromeMatch) { $Issues += 'Chrome' }
            if (-not $FirefoxMatch) { $Issues += 'Firefox' }
            Write-Host "  $RelPath - OUT OF SYNC ($($Issues -join ', '))" -ForegroundColor Red
            $Errors++
        }
        continue
    }

    # Ensure target directory exists
    $ChromeDirTarget = Split-Path $ChromeTarget -Parent
    $FirefoxDirTarget = Split-Path $FirefoxTarget -Parent
    if (-not (Test-Path $ChromeDirTarget)) { New-Item -ItemType Directory -Force -Path $ChromeDirTarget | Out-Null }
    if (-not (Test-Path $FirefoxDirTarget)) { New-Item -ItemType Directory -Force -Path $FirefoxDirTarget | Out-Null }

    if ($DryRun) {
        Write-Host "  [DRY RUN] Would copy: $RelPath" -ForegroundColor Gray
        $Copied++
        continue
    }

    # Copy to Chrome
    try {
        Copy-Item -Path $File.FullName -Destination $ChromeTarget -Force
        Write-Host "  Chrome: $RelPath" -ForegroundColor Green
    } catch {
        Write-Host "  Chrome: $RelPath - FAILED: $_" -ForegroundColor Red
        $Errors++
    }

    # Copy to Firefox
    try {
        Copy-Item -Path $File.FullName -Destination $FirefoxTarget -Force
        Write-Host "  Firefox: $RelPath" -ForegroundColor Green
    } catch {
        Write-Host "  Firefox: $RelPath - FAILED: $_" -ForegroundColor Red
        $Errors++
    }

    $Copied++
}

Write-Host "`n"
if ($CheckOnly) {
    if ($Errors -gt 0) {
        Write-Host " Result: $Errors file(s) out of sync" -ForegroundColor Red
        Write-Host " Run without -CheckOnly to fix`n" -ForegroundColor Yellow
        exit 1
    } else {
        Write-Host " Result: All $Copied file(s) in sync" -ForegroundColor Green
    }
} else {
    Write-Host " Result: $Copied file(s) processed, $Errors error(s)" -ForegroundColor $(if ($Errors -gt 0) { 'Red' } else { 'Green' })
    if ($DryRun) {
        Write-Host " (Dry run - no files were modified)" -ForegroundColor Yellow
    }
}
Write-Host ""

if ($Errors -gt 0) { exit 1 }
