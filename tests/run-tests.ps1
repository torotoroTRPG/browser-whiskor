# Run tests and generate TEST-REPORT.md
$ErrorActionPreference = "Stop"

$testDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$outputFile = Join-Path $testDir "TEST-REPORT.md"
$rootDir    = Split-Path -Parent $testDir

# Collect test files per category
$categories = @{}
foreach ($sub in @('unit', 'integration', 'stress')) {
    $path = Join-Path $testDir "$sub\*.test.js"
    $files = Get-ChildItem $path -ErrorAction SilentlyContinue
    $categories[$sub] = $files
}

$totalFiles = ($categories.Values | ForEach-Object { $_.Count }) | Measure-Object -Sum | Select-Object -ExpandProperty Sum
Write-Host "Running $totalFiles test files across $($categories.Count) categories..." -ForegroundColor Cyan

# Run each category separately to capture per-category stats
$results = @{}
$allOutput = ""

foreach ($cat in @('unit', 'integration', 'stress')) {
    $files = $categories[$cat]
    if (-not $files -or $files.Count -eq 0) {
        $results[$cat] = @{ total = 0; pass = 0; fail = 0; duration = 0 }
        continue
    }

    Write-Host "  [$cat] $($files.Count) files..." -ForegroundColor DarkCyan
    $output = node --test --experimental-test-coverage $files.FullName 2>&1 | Out-String
    $allOutput += $output

    $total  = [regex]::Match($output, '# tests\s+(\d+)').Groups[1].Value
    $pass   = [regex]::Match($output, '# pass\s+(\d+)').Groups[1].Value
    $fail   = [regex]::Match($output, '# fail\s+(\d+)').Groups[1].Value
    $dur    = [regex]::Match($output, '# duration_ms\s+([\d.]+)').Groups[1].Value

    $results[$cat] = @{
        total    = if ($total) { [int]$total } else { 0 }
        pass     = if ($pass) { [int]$pass } else { 0 }
        fail     = if ($fail) { [int]$fail } else { 0 }
        duration = if ($dur) { [double]$dur } else { 0 }
    }
}

# Aggregate totals
$grandTotal = ($results.Values | ForEach-Object { $_.total }) | Measure-Object -Sum | Select-Object -ExpandProperty Sum
$grandPass  = ($results.Values | ForEach-Object { $_.pass }) | Measure-Object -Sum | Select-Object -ExpandProperty Sum
$grandFail  = ($results.Values | ForEach-Object { $_.fail }) | Measure-Object -Sum | Select-Object -ExpandProperty Sum
$grandDur   = ($results.Values | ForEach-Object { $_.duration }) | Measure-Object -Sum | Select-Object -ExpandProperty Sum

# Overall coverage
$coverage = [regex]::Match($allOutput, 'all files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)')
if ($coverage.Success) {
    $covStmt  = $coverage.Groups[1].Value
    $covBranch = $coverage.Groups[2].Value
    $covFuncs = $coverage.Groups[3].Value
    $coverageSummary = "${covStmt}% (statements) / ${covBranch}% (branch) / ${covFuncs}% (funcs)"
} else {
    $coverageSummary = "N/A"
}

# Parse per-file coverage details (exclude test files, deduplicate)
$coverageLines = $allOutput -split "`n" | Where-Object { $_ -match '^#\s+tests\\.*\|' -and $_ -notmatch '\.test\.js\s*\|' }
$detailMap = @{}
foreach ($line in $coverageLines) {
    $parts = $line -split '\|'
    if ($parts.Count -ge 5) {
        $file = [System.IO.Path]::GetFileName($parts[0].TrimStart('# ').Trim())
        $stmt = $parts[1].Trim()
        $branch = $parts[2].Trim()
        $funcs = $parts[3].Trim()
        $uncovered = $parts[4].Trim()
        $isMock = if ($file -match 'mock|fixture') { ' (mock)' } else { '' }
        $key = "$file${isMock}"
        # Keep the entry with the lowest coverage (most conservative)
        if (-not $detailMap.ContainsKey($key) -or [double]$stmt -lt [double]$detailMap[$key].stmt) {
            $detailMap[$key] = @{ file = $file; isMock = $isMock; stmt = $stmt; branch = $branch; funcs = $funcs; uncovered = $uncovered }
        }
    }
}
$detailRows = $detailMap.Values | ForEach-Object { "| $($_.file)$($_.isMock) | $($_.stmt)% | $($_.branch)% | $($_.funcs)% | $($_.uncovered) |" }
$detailTable = $detailRows -join "`n"

# Parse failed tests
$failedTests = @()
if ($grandFail -gt 0) {
    $failMatches = [regex]::Matches($allOutput, 'not ok \d+ - (.+?)$')
    foreach ($m in $failMatches) {
        $failedTests += "- ❌ $($m.Groups[1].Value)"
    }
}
$failedSection = if ($failedTests.Count -gt 0) {
    "`n## 失敗テスト`n`n" + ($failedTests -join "`n") + "`n"
} else { "" }

$date = Get-Date -Format "yyyy-MM-dd"
$time = Get-Date -Format "HH:mm:ss"
$status = if ($grandFail -eq 0) { "✅ 全件パス" } else { "❌ $grandFail 件失敗" }

# Category emoji
$catEmoji = @{ unit = '🧪'; integration = '🔗'; stress = '💪' }

# Build report
$report = @"
# Test Report

| 項目 | 値 |
|------|-----|
| 日付 | $date $time |
| 合計 | $grandTotal |
| パス | $grandPass |
| 失敗 | $grandFail |
| 実行時間 | ${grandDur}ms |
| カバレッジ | ${coverageSummary} |

## カテゴリ別結果

| カテゴリ | テスト数 | パス | 失敗 | 時間 |
|----------|---------|------|------|------|
| $($catEmoji.unit) Unit | $($results.unit.total) | $($results.unit.pass) | $($results.unit.fail) | $($results.unit.duration)ms |
| $($catEmoji.integration) Integration | $($results.integration.total) | $($results.integration.pass) | $($results.integration.fail) | $($results.integration.duration)ms |
| $($catEmoji.stress) Stress | $($results.stress.total) | $($results.stress.pass) | $($results.stress.fail) | $($results.stress.duration)ms |

## 結果

$status
$failedSection

---

## ファイル別カバレッジ詳細

| ファイル | 行 | ブランチ | 関数 | 未カバー行 |
|----------|-----|----------|------|-----------|
$detailTable
"@

$report | Out-File -FilePath $outputFile -Encoding utf8BOM
Write-Host ""
Write-Host "Report saved to $outputFile" -ForegroundColor Green
Write-Host ""
Write-Host "  $($catEmoji.unit) Unit:        $($results.unit.total) tests ($($results.unit.pass) pass, $($results.unit.fail) fail)" -ForegroundColor Cyan
Write-Host "  $($catEmoji.integration) Integration: $($results.integration.total) tests ($($results.integration.pass) pass, $($results.integration.fail) fail)" -ForegroundColor Cyan
Write-Host "  $($catEmoji.stress) Stress:       $($results.stress.total) tests ($($results.stress.pass) pass, $($results.stress.fail) fail)" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Total: $grandTotal tests | ${grandDur}ms | $coverageSummary" -ForegroundColor White
