<#
.SYNOPSIS
  browser-whiskor test runner — Quick / Full modes.

.DESCRIPTION
  Quick  – runs unit tests only (fast, no browser needed).
  Full   – runs all tests (unit + integration + stress) and generates
           a detailed Markdown report + JSON results in tests/report/.

.PARAMETER Mode
  "quick" (default) or "full"

.PARAMETER ReportDir
  Output directory for reports (default: tests/report/)

.EXAMPLE
  .\tests\run.ps1 -Mode quick
  .\tests\run.ps1 -Mode full
#>

param(
  [ValidateSet('quick','full')][string]$Mode = 'quick',
  [string]$ReportDir = 'tests/report'
)

$root = Split-Path -Parent $PSScriptRoot

function Write-Color($color, $text) {
  Write-Host $text -ForegroundColor $color
}

function Get-Timestamp {
  Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
}

# ── Report directory ─────────────────────────────────────────────────────────
$reportDir = Join-Path $root $ReportDir
if (-not (Test-Path $reportDir)) {
  New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
}
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$reportFile   = Join-Path $reportDir "test-report-$ts.md"
$jsonFile     = Join-Path $reportDir "test-results-$ts.json"

# ── Print header ────────────────────────────────────────────────────────────
Write-Color Cyan "╔══════════════════════════════════════════════════════╗"
Write-Color Cyan "║   browser-whiskor Test Runner                        ║"
Write-Color Cyan "║   Mode: $($Mode.ToUpper())                                  ║"
Write-Color Cyan "║   Started: $(Get-Timestamp)                 ║"
Write-Color Cyan "╚══════════════════════════════════════════════════════╝"
Write-Host ""

# ── Run tests via Node.js runner ────────────────────────────────────────────
Write-Color Yellow "▶ Running tests..."
$t0 = Get-Date

$parser = Join-Path $root 'tests/lib/run-and-report.mjs'
$jsonRaw = & node $parser $Mode 2>&1
$exitCode = $LASTEXITCODE
$totalDur = (Get-Date) - $t0

# Parse JSON output
$result = $jsonRaw -join "`n" | ConvertFrom-Json

# ── Display phase results ───────────────────────────────────────────────────
foreach ($phase in $result.phases) {
  $pct = if ($phase.total -gt 0) { "{0:P1}" -f ($phase.pass / $phase.total) } else { "N/A" }
  $lbl = if ($phase.label) { $phase.label } else { $phase.name }
  Write-Host "  $lbl`: $($phase.total) tests, $($phase.pass) passed, $($phase.fail) failed, $($pct) pass rate"
  Write-Host "  Duration: $([math]::Round($phase.durationMs / 1000, 1))s"
  Write-Host ""
}

# ── Compute totals ──────────────────────────────────────────────────────────
$allTotal = 0; $allPass = 0; $allFail = 0
foreach ($p in $result.phases) {
  $allTotal += $p.total
  $allPass  += $p.pass
  $allFail  += $p.fail
}
$passRate = if ($allTotal -gt 0) { "{0:P1}" -f ($allPass / $allTotal) } else { "N/A" }
$totalDurSec = [math]::Round($totalDur.TotalSeconds, 1)

# ── Save JSON report ────────────────────────────────────────────────────────
$result | ConvertTo-Json -Depth 10 | Out-File $jsonFile -Encoding utf8

# ── Generate Markdown report ────────────────────────────────────────────────
$md = @"
# browser-whiskor Test Report

**Mode:** $Mode  
**Started:** $(Get-Timestamp)  
**Duration:** ${totalDurSec}s  

## Summary

| Metric       | Value |
|-------------:|-------|
| Total tests  | $allTotal |
| Passed       | $allPass |
| Failed       | $allFail |
| Pass rate    | $passRate |

## Suites

"@

foreach ($phase in $result.phases) {
  $lbl = if ($phase.label) { $phase.label } else { $phase.name }
  $dur = [math]::Round($phase.durationMs / 1000, 1)
  $md += @"
### $lbl

_Duration: ${dur}s_

| Suite | Tests | Passed | Failed | Rate |
|-------|------:|-------:|------:|-----:|

"@
  foreach ($suite in $phase.suites) {
    $spct = if ($suite.total -gt 0) { "{0:P1}" -f ($suite.pass / $suite.total) } else { "N/A" }
    $md += "| $($suite.name) | $($suite.total) | $($suite.pass) | $($suite.fail) | $spct`n"
  }
  $md += @"

"@
}

# ── Failure details ─────────────────────────────────────────────────────────
if ($allFail -gt 0) {
  $md += @"
## Failure Details

| # | Phase | Suite | Test | Error |
|---|-------|-------|------|-------|

"@
  $failIdx = 0
  foreach ($phase in $result.phases) {
    if ($phase.fail -eq 0) { continue }
    $allLines = $phase.tapOutput -split "`n"
    $testStack = @()
    $inDetail = $false
    $detailLines = @()
    foreach ($line in $allLines) {
      $cleaned = $line -replace '\e\[[0-9;]*m', ''
      if ($cleaned -match '^# Subtest:\s+(.+)') {
        $testStack += , $Matches[1].Trim()
      }
      if ($cleaned -match '^not ok\s+\d+\s+-\s+(.+)') {
        $failIdx++
        $testName = $Matches[1].Trim()
        $context = $testStack -join ' › '
        $md += "`n| $failIdx | $($phase.name) | $context | $testName |"
      }
    }
  }
}

# ── Footer ──────────────────────────────────────────────────────────────────
$md += @"

---

*Report generated at $(Get-Timestamp) by tests\run.ps1*
"@

$md | Out-File $reportFile -Encoding utf8

# ── Print summary ───────────────────────────────────────────────────────────
Write-Color Cyan "╔══════════════════════════════════════════════════════╗"
Write-Color Cyan "║   Done!                                             ║"
Write-Color Cyan "║                                                    ║"
if ($allFail -eq 0) {
  Write-Color Green "║   $allTotal / $allTotal  ALL PASSED  $([char]0x2713)                  ║"
} else {
  Write-Color Red   "║   $allFail failure(s) — see report for details     ║"
}
Write-Color Cyan "║                                                    ║"
Write-Color Cyan "║   Report: $([System.IO.Path]::GetRelativePath($root, $reportFile))  ║"
Write-Color Cyan "╚══════════════════════════════════════════════════════╝"
