<#
.SYNOPSIS
    Runs tests in a dark-themed PowerShell window.

.DESCRIPTION
    Sets console background to DarkBlue and text to White for eye comfort,
    then runs the test suite. Does not affect test performance.

.EXAMPLE
    .\scripts\run-tests-dark.ps1          # Run all tests
    .\scripts\run-tests-dark.ps1 -Unit    # Run unit tests only
    .\scripts\run-tests-dark.ps1 -E2E     # Run E2E tests only
#>
param(
    [switch]$Unit,
    [switch]$E2E,
    [switch]$All
)

$ErrorActionPreference = 'Stop'

# 🌙 Dark Mode Setup
$Host.UI.RawUI.BackgroundColor = 'DarkBlue'
$Host.UI.RawUI.ForegroundColor = 'White'
$Host.PrivateData.ErrorBackgroundColor = 'DarkBlue'
$Host.PrivateData.ErrorForegroundColor = 'Red'
$Host.PrivateData.WarningBackgroundColor = 'DarkBlue'
$Host.PrivateData.WarningForegroundColor = 'Yellow'

Clear-Host

$Target = if ($Unit) { 'test:unit' } elseif ($E2E) { 'test:e2e' } else { 'test' }

Write-Host "`n 🌙 Dark Mode Test Runner" -ForegroundColor Cyan
Write-Host " └ Running: npm run $Target`n" -ForegroundColor Gray

npm run $Target
