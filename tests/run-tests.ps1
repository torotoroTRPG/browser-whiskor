# Run tests and generate TEST-REPORT.md
$ErrorActionPreference = "Stop"

$testDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$outputFile = Join-Path $testDir "TEST-REPORT.md"

Write-Host "Running tests with coverage..." -ForegroundColor Cyan
$output = node --test --experimental-test-coverage (Get-ChildItem "$testDir\unit\*.test.js").FullName 2>&1 | Out-String

# Parse TAP summary
$total  = [regex]::Match($output, '# tests\s+(\d+)').Groups[1].Value
$pass   = [regex]::Match($output, '# pass\s+(\d+)').Groups[1].Value
$fail   = [regex]::Match($output, '# fail\s+(\d+)').Groups[1].Value
$skip   = [regex]::Match($output, '# skipped\s+(\d+)').Groups[1].Value
$duration = [regex]::Match($output, '# duration_ms\s+([\d.]+)').Groups[1].Value
$coverage = [regex]::Match($output, 'all files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)')
if ($coverage.Success) {
    $covStmt = $coverage.Groups[1].Value
    $covBranch = $coverage.Groups[2].Value
    $covFuncs = $coverage.Groups[3].Value
    $coverageSummary = "${covStmt}% (statements) / ${covBranch}% (branch) / ${covFuncs}% (funcs)"
} else {
    $coverageSummary = "N/A"
}
$date = Get-Date -Format "yyyy-MM-dd"
$time = Get-Date -Format "HH:mm:ss"

if ($fail -eq "0") {
    $status = "✅ 全件パス"
} else {
    $status = "❌ $fail 件失敗"
}

$report = @"
# Test Report

| 項目 | 値 |
|------|-----|
| 日付 | $date $time |
| 合計 | $total |
| パス | $pass |
| 失敗 | $fail |
| スキップ | $skip |
| 実行時間 | ${duration}ms |
| カバレッジ | ${coverageSummary} |

## 結果

$status

"@

$report | Out-File -FilePath $outputFile -Encoding utf8BOM
Write-Host "Report saved to $outputFile" -ForegroundColor Green
Write-Host $report
