#!/usr/bin/env pwsh
# manual/notes.ps1  —  テストメモ帳
# 使い方:
#   引数なし → 対話ループ
#   list               メモ一覧
#   note <text>        メモ追加
#   get <key>          値取得
#   set <key> <val>    値保存
#   open               メモ帳を開く

$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$JSON_PATH = Join-Path $PSScriptRoot "notes.json"

param(
  [Parameter(Position = 0)][string]$Command = "",
  [Parameter(Position = 1)][string]$Key,
  [Parameter(Position = 2, ValueFromRemainingArguments = $true)][string[]]$ValueArgs
)

$Value = if ($ValueArgs) { $ValueArgs -join " " } else { $null }

function Load    { if (Test-Path $JSON_PATH) { Get-Content $JSON_PATH -Raw -Encoding UTF8 | ConvertFrom-Json } else { @{} } }
function Save($d) { $d | ConvertTo-Json -Depth 10 | Set-Content $JSON_PATH -Encoding UTF8 }

function Do-List {
  $d = Load
  Write-Host "`n=== notes.json ===" -ForegroundColor Cyan
  $d.PSObject.Properties | Where-Object { $_.Name[0] -ne '_' } | ForEach-Object {
    $v = $_.Value
    $t = if ($v -is [array]) { "array($($v.Count))" } elseif ($v -is [PSCustomObject]) { "object" } else { "string" }
    Write-Host "  $($_.Name) : $t"
  }
  if ($d.notes -and $d.notes.Count -gt 0) {
    Write-Host "`n--- Notes ---" -ForegroundColor Yellow
    $d.notes | ForEach-Object { Write-Host "  $_" }
  }
}

function Do-Note {
  param($text)
  if (-not $text) { Write-Host "Usage: note <text>" -ForegroundColor Red; return }
  $d = Load
  if (-not $d.PSObject.Properties.Name.Contains('notes')) { $d | Add-Member -Force NoteProperty "notes" @() }
  $entry = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm')] $text"
  $d.notes = @($d.notes) + @($entry)
  Save $d
  Write-Host "saved: $entry" -ForegroundColor Green
}

function Do-Get {
  param($k)
  if (-not $k) { Write-Host "Usage: get <key>" -ForegroundColor Red; return }
  $d = Load; $v = $d.$k
  if ($null -eq $v) { Write-Host "not found" -ForegroundColor Yellow } else { $v | ConvertTo-Json -Depth 5 }
}

function Do-Set {
  param($k, $v)
  if (-not $k -or -not $v) { Write-Host "Usage: set <key> <value>" -ForegroundColor Red; return }
  $d = Load
  try { $p = $v | ConvertFrom-Json -ErrorAction Stop } catch { $p = $v }
  $d | Add-Member -Force NoteProperty $k $p
  Save $d
  Write-Host "set $k" -ForegroundColor Green
}

function Start-InteractiveLoop {
  Write-Host @"

  ╔══════════════════════════════════════════════╗
  ║     Testing Notepad — Interactive            ║
  ║     テスト中のメモをサッと残す               ║
  ╚══════════════════════════════════════════════╝

  コマンド:
    list                   メモ一覧
    note <text>            メモ追加
    get <key>              値取得
    set <key> <val>        値保存
    open                   メモ帳(njson)を開く
    help                   このヘルプ
    exit                   終了

  例:
    note スクリーンショット成功
    note ログインボタンは #login-btn
    set lastTabId 1666822684
"@

  $running = $true
  while ($running) {
    try {
      $input = Read-Host "`nnotes> "
      if (-not $input) { continue }

      $parts = @(); $current = ""; $inQuote = $false
      foreach ($ch in $input.ToCharArray()) {
        if ($ch -eq '"') { $inQuote = -not $inQuote; continue }
        if ($ch -eq ' ' -and -not $inQuote) { if ($current) { $parts += $current; $current = "" }; continue }
        $current += $ch
      }
      if ($current) { $parts += $current }

      $cmd = $parts[0].ToLower()
      $rest = $parts[1..$parts.Count]
      $restStr = $rest -join " "

      switch ($cmd) {
        "exit"  { $running = $false; Write-Host "Bye!" -ForegroundColor Yellow }
        "quit"  { $running = $false; Write-Host "Bye!" -ForegroundColor Yellow }
        "q"     { $running = $false; Write-Host "Bye!" -ForegroundColor Yellow }
        "help"  { Start-InteractiveLoop; return }
        "list"  { Do-List }
        "note"  { Do-Note $restStr }
        "get"   { Do-Get $rest[0] }
        "set"   { Do-Set $rest[0] ($rest[1..$rest.Count] -join " ") }
        "open"  { if (Test-Path $JSON_PATH) { Invoke-Item $JSON_PATH } }
        default { Write-Host "unknown: $cmd (try: list, note, get, set)" -ForegroundColor Yellow }
      }
    } catch {
      Write-Host "Error: $_" -ForegroundColor Red
    }
  }
}

# ── Main dispatch ─────────────────────────────────────────────────────────────
if (-not $Command) { Start-InteractiveLoop; exit }

switch ($Command.ToLower()) {
  "list"  { Do-List }
  "note"  { Do-Note "$Key $Value".Trim() }
  "get"   { Do-Get $Key }
  "set"   { Do-Set $Key $Value }
  "open"  { if (Test-Path $JSON_PATH) { Invoke-Item $JSON_PATH } }
  default { Write-Host "unknown: $Command (try: list, note, get, set, open)" -ForegroundColor Yellow }
}
