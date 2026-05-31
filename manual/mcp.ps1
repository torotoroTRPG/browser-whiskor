#!/usr/bin/env pwsh
# manual/mcp.ps1  —  MCP Manual Transmission (MT) モード  [🧪 テスト専用]
#
# 【推奨度】テスト専用 — 人間が手で動作確認するためのツール。
#           ⚠ Claude Code など NonInteractive 環境では動作しません。
#           スクリプト・自動化には manual/mcp-client.js を使うこと。
#
# 人間が AI の席に座って、生の JSON-RPC を直接送受信する。
#
# 使い方:
#   引数なし → 対話ループ
#   -call <tool名> [-json '<JSON>']  単発呼び出し
#   -list                             全ツール一覧
#   -raw '<JSON-RPC>'                 任意のJSON-RPC送信
#   -ping                             MCP接続ヘルスチェック
#   -challenge                        MCP接続チャレンジ (全工程テスト)

$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$ROOT = Resolve-Path "$PSScriptRoot/.."

param(
  [switch]$list,
  [string]$call,
  [string]$json,
  [string]$raw,
  [switch]$ping,
  [switch]$challenge
)

function Send-Mcp {
  param([string[]]$Requests)
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = "node"
  $info.Arguments = "server/index.js --mcp"
  $info.WorkingDirectory = $ROOT
  $info.UseShellExecute = $false
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = [System.Text.UTF8Encoding]::new()
  $info.StandardErrorEncoding  = [System.Text.UTF8Encoding]::new()
  $info.CreateNoWindow = $true

  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $info
  $proc.Start() | Out-Null
  Start-Sleep -Milliseconds 300

  $results = [System.Collections.ArrayList]::new()
  $reader = [PowerShell]::Create().AddScript({
    param($p)
    $r = [System.Collections.ArrayList]::new()
    while (!$p.HasExited -or !$p.StandardOutput.EndOfStream) {
      try {
        $line = $p.StandardOutput.ReadLine()
        if ($line) { [void]$r.Add($line) }
      } catch { break }
    }
    $r
  }).AddParameter("p", $proc)
  $async = $reader.BeginInvoke()

  $stdin = $proc.StandardInput
  foreach ($req in $Requests) {
    $stdin.WriteLine($req)
    Start-Sleep -Milliseconds 150
  }
  $stdin.Close()

  if (-not $proc.WaitForExit(10000)) { $proc.Kill() }
  $lines = $reader.EndInvoke($async)
  $reader.Dispose()
  $proc.Dispose()
  return $lines
}

function New-JsonRpc($method, $id, $params) {
  $o = @{jsonrpc = "2.0"; id = $id; method = $method}
  if ($params) { $o.params = $params }
  return ($o | ConvertTo-Json -Compress -Depth 5)
}

function New-ToolCall($name, $args, $id) {
  return (New-JsonRpc "tools/call" $id @{name = $name; arguments = $args})
}

function Show-Json($s) {
  try { $s | ConvertFrom-Json | ConvertTo-Json -Depth 10 } catch { $s }
}

function Run-SingleCall {
  param($toolName, $toolArgs)
  $requestId = 3
  Write-Host "`n══════════════════ MCP MT — $toolName ══════════════════" -ForegroundColor Cyan
  Write-Host "── Request ─────────────────────────────" -ForegroundColor Yellow
  $reqBody = @{jsonrpc = "2.0"; id = $requestId; method = "tools/call"; params = @{name = $toolName; arguments = $toolArgs}}
  Write-Host ($reqBody | ConvertTo-Json -Depth 5)
  Write-Host

  $responses = Send-Mcp @(
    (New-JsonRpc "initialize" 1 @{protocolVersion = "2024-11-05"; capabilities = @{tools = @{}}; clientInfo = @{name = "mcp.ps1"; version = "1.0"}}),
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    (New-ToolCall $toolName $toolArgs $requestId)
  )

  Write-Host "── Response ────────────────────────────" -ForegroundColor Green
  $found = $false
  foreach ($line in $responses) {
    try {
      $parsed = $line | ConvertFrom-Json
      if ($parsed.id -eq $requestId -and ($parsed.result -or $parsed.error)) {
        $found = $true
        Write-Host ($parsed | ConvertTo-Json -Depth 10)
      }
    } catch { }
  }
  if (-not $found) { $responses | ForEach-Object { Write-Host $_ } }
  Write-Host "═══════════════════════════════════════════════════════" -ForegroundColor Cyan
  Write-Host
}

# ── Interactive Loop ──────────────────────────────────────────────────────────
function Start-InteractiveLoop {
  Write-Host @"

  ╔══════════════════════════════════════════════╗
  ║     MCP Manual Transmission — Interactive    ║
  ║     生の JSON-RPC を直接送受信               ║
  ╚══════════════════════════════════════════════╝

  AI の代わりに人間が座って、MCP プロトコルを直接操作します。
  送られるリクエストと返ってくるレスポンスは AI が受け取るのと全く同じものです。

  コマンド:
    <tool名> [<key>=<val> ...]    ツール呼び出し (引数なしの場合は tool名 のみ)
    list                          全ツール一覧
    server                        接続情報 (initialize 応答)
    profiles                      プロファイル状態一覧
    load-profile <name>           プロファイル動的ロード
    unload-profile <name>         プロファイルアンロード
    help                          このヘルプ
    exit / Ctrl+C                 終了

  例:
    get_sessions
    get_text_coords tabId=1666822684 search=ログイン
    click tabId=1666822684 selector=.btn-primary
    capture_screenshot tabId=1666822684 marks=true
"@

  # Ensure server is accessible
  $initResponses = Send-Mcp @(
    (New-JsonRpc "initialize" 1 @{protocolVersion = "2024-11-05"; capabilities = @{tools = @{}}; clientInfo = @{name = "mcp.ps1"; version = "1.0"}}),
    '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  )

  $nextId = 2
  $running = $true

  while ($running) {
    try {
      $input = Read-Host "`nmcp MT> "
      if (-not $input) { continue }

      $parts = @()
      # Simple tokenization: split on spaces unless quoted
      $inQuote = $false; $current = ""
      foreach ($ch in $input.ToCharArray()) {
        if ($ch -eq '"') { $inQuote = -not $inQuote; continue }
        if ($ch -eq ' ' -and -not $inQuote) { if ($current) { $parts += $current; $current = "" }; continue }
        $current += $ch
      }
      if ($current) { $parts += $current }

      $cmd = $parts[0].ToLower()
      $rest = $parts[1..$parts.Count]

      switch ($cmd) {
        "exit" { $running = $false; Write-Host "Bye!" -ForegroundColor Yellow }
        "quit" { $running = $false; Write-Host "Bye!" -ForegroundColor Yellow }
        "q"    { $running = $false; Write-Host "Bye!" -ForegroundColor Yellow }
        "help" { Start-InteractiveLoop; return }
        "server" {
          Write-Host "`n  === Server Info (initialize response) ===" -ForegroundColor Cyan
          $responses = Send-Mcp @(
            (New-JsonRpc "initialize" 1 @{protocolVersion = "2024-11-05"; capabilities = @{tools = @{}}; clientInfo = @{name = "mcp.ps1"; version = "1.0"}})
          )
          $responses | ForEach-Object { Write-Host ($_ | Show-Json) }
        }
        "profiles" {
          Write-Host "`n  === Profile Status ===" -ForegroundColor Cyan
          $responses = Send-Mcp @(
            (New-JsonRpc "initialize" 1 @{protocolVersion = "2024-11-05"; capabilities = @{tools = @{}}; clientInfo = @{name = "mcp.ps1"; version = "1.0"}}),
            '{"jsonrpc":"2.0","method":"notifications/initialized"}',
            (New-ToolCall "profile_status" @{} $nextId)
          )
          $responses | ForEach-Object { Write-Host ($_ | Show-Json) }
          $nextId++
        }
        "load-profile" {
          if ($rest.Count -lt 1) { Write-Host "Usage: load-profile <name>" -ForegroundColor Yellow; continue }
          $profileName = $rest[0]
          Write-Host "→ Loading profile: $profileName" -ForegroundColor Yellow
          $responses = Send-Mcp @(
            (New-JsonRpc "initialize" 1 @{protocolVersion = "2024-11-05"; capabilities = @{tools = @{}}; clientInfo = @{name = "mcp.ps1"; version = "1.0"}}),
            '{"jsonrpc":"2.0","method":"notifications/initialized"}',
            (New-ToolCall "load_profile" @{profile = $profileName} $nextId)
          )
          $responses | ForEach-Object { Write-Host ($_ | Show-Json) }
          $nextId++
          Write-Host "→ Tools refreshed. Use 'list' to see available tools." -ForegroundColor Cyan
        }
        "unload-profile" {
          if ($rest.Count -lt 1) { Write-Host "Usage: unload-profile <name>" -ForegroundColor Yellow; continue }
          $profileName = $rest[0]
          Write-Host "→ Unloading profile: $profileName" -ForegroundColor Yellow
          $responses = Send-Mcp @(
            (New-JsonRpc "initialize" 1 @{protocolVersion = "2024-11-05"; capabilities = @{tools = @{}}; clientInfo = @{name = "mcp.ps1"; version = "1.0"}}),
            '{"jsonrpc":"2.0","method":"notifications/initialized"}',
            (New-ToolCall "unload_profile" @{profile = $profileName} $nextId)
          )
          $responses | ForEach-Object { Write-Host ($_ | Show-Json) }
          $nextId++
        }
        "list" {
          $responses = Send-Mcp @(
            (New-JsonRpc "initialize" 1 @{protocolVersion = "2024-11-05"; capabilities = @{tools = @{}}; clientInfo = @{name = "mcp.ps1"; version = "1.0"}}),
            '{"jsonrpc":"2.0","method":"notifications/initialized"}',
            (New-JsonRpc "tools/list" $nextId @{})
          )
          $responses | ForEach-Object { Write-Host $_ }
          $nextId++
        }
        default {
          # Tool call
          $toolName = $parts[0]
          $toolArgs = @{}

          # Parse key=val arguments
          foreach ($p in $rest) {
            if ($p -match '^([^=]+)=(.*)$') {
              $k = $matches[1]
              $v = $matches[2]
              # Type coercion
              if ($v -eq 'true') { $v = $true }
              elseif ($v -eq 'false') { $v = $false }
              elseif ($v -match '^\d+$') { $v = [int]$v }
              elseif ($v -match '^\d+\.\d+$') { $v = [double]$v }
              else {
                try { $v = $v | ConvertFrom-Json } catch { }
              }
              $toolArgs[$k] = $v
            }
          }

          Write-Host "→ Request (JSON-RPC):" -ForegroundColor Yellow
          $reqObj = @{jsonrpc = "2.0"; id = $nextId; method = "tools/call"; params = @{name = $toolName; arguments = $toolArgs}}
          Write-Host ($reqObj | ConvertTo-Json -Depth 5)
          Write-Host

          $responses = Send-Mcp @(
            (New-JsonRpc "initialize" 1 @{protocolVersion = "2024-11-05"; capabilities = @{tools = @{}}; clientInfo = @{name = "mcp.ps1"; version = "1.0"}}),
            '{"jsonrpc":"2.0","method":"notifications/initialized"}',
            (New-ToolCall $toolName $toolArgs $nextId)
          )

          Write-Host "← Response (raw JSON-RPC):" -ForegroundColor Green
          $found = $false
          foreach ($line in $responses) {
            try {
              $parsed = $line | ConvertFrom-Json
              if ($parsed.id -eq $nextId) {
                $found = $true
                Write-Host ($parsed | ConvertTo-Json -Depth 10)
              }
            } catch { }
          }
          if (-not $found) { $responses | ForEach-Object { Write-Host ($_ | Show-Json) } }
          $nextId++
        }
      }
    } catch {
      Write-Host "Error: $_" -ForegroundColor Red
    }
  }
}

# ── Ping: quick connection check ──────────────────────────────────────────────
function Test-Ping {
  Write-Host "`n  MCP Connection Ping" -ForegroundColor Cyan
  Write-Host "  ───────────────────"
  try {
    $responses = Send-Mcp @(
      (New-JsonRpc "initialize" 1 @{protocolVersion = "2024-11-05"; capabilities = @{tools = @{}}; clientInfo = @{name = "mcp.ps1"; version = "1.0"}})
    )
    $ok = $false
    foreach ($line in $responses) {
      try {
        $p = $line | ConvertFrom-Json
        if ($p.result.protocolVersion) {
          Write-Host "  ${C_GREEN}✓${C_RESET} Server  : node server/index.js --mcp"
          Write-Host "  ${C_GREEN}✓${C_RESET} Protocol: $($p.result.protocolVersion)"
          Write-Host "  ${C_GREEN}✓${C_RESET} Name    : $($p.result.serverInfo.name) v$($p.result.serverInfo.version)"
          $ok = $true
        }
      } catch { }
    }
    if ($ok) { Write-Host "  ${C_GREEN}✓ PASS${C_RESET}" -ForegroundColor Green }
    else     { Write-Host "  ${C_RED}✗ FAIL${C_RESET} — No valid response" -ForegroundColor Red }
  } catch {
    Write-Host "  ${C_RED}✗ FAIL${C_RESET} — $_" -ForegroundColor Red
  }
  Write-Host
}

# ── Challenge: full end-to-end test ──────────────────────────────────────────
function Test-Challenge {
  Write-Host "`n  MCP Connection Challenge" -ForegroundColor Cyan
  Write-Host "  ─────────────────────────"

  $passed = 0; $failed = 0
  $total = 5

  # 1. Initialize
  Write-Host "  ${C_DIM}[1/$total] Initialize...${C_RESET}" -NoNewline
  try {
    $r = Send-Mcp @((New-JsonRpc "initialize" 1 @{protocolVersion = "2024-11-05"; capabilities = @{tools = @{}}; clientInfo = @{name = "mcp.ps1"; version = "1.0"}}))
    $initOk = $false
    foreach ($line in $r) { try { $p = $line | ConvertFrom-Json; if ($p.result.protocolVersion) { $initOk = $true } } catch { } }
    if ($initOk) { Write-Host " ${C_GREEN}✓${C_RESET}"; $passed++ } else { Write-Host " ${C_RED}✗${C_RESET}"; $failed++ }
  } catch { Write-Host " ${C_RED}✗${C_RESET} $_"; $failed++ }

  # 2. tools/list
  Write-Host "  ${C_DIM}[2/$total] List tools...${C_RESET}" -NoNewline
  try {
    $r = Send-Mcp @(
      (New-JsonRpc "initialize" 1 @{protocolVersion = "2024-11-05"; capabilities = @{tools = @{}}; clientInfo = @{name = "mcp.ps1"; version = "1.0"}}),
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      (New-JsonRpc "tools/list" 2 @{})
    )
    $toolCount = 0
    foreach ($line in $r) { try { $p = $line | ConvertFrom-Json; if ($p.result.tools) { $toolCount = $p.result.tools.Count } } catch { } }
    if ($toolCount -gt 0) { Write-Host " ${C_GREEN}✓${C_RESET} ($toolCount tools)"; $passed++ } else { Write-Host " ${C_RED}✗${C_RESET}"; $failed++ }
  } catch { Write-Host " ${C_RED}✗${C_RESET} $_"; $failed++ }

  # 3. get_sessions
  Write-Host "  ${C_DIM}[3/$total] Call get_sessions...${C_RESET}" -NoNewline
  try {
    $r = Send-Mcp @(
      (New-JsonRpc "initialize" 1 @{protocolVersion = "2024-11-05"; capabilities = @{tools = @{}}; clientInfo = @{name = "mcp.ps1"; version = "1.0"}}),
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      (New-JsonRpc "tools/call" 3 @{name = "get_sessions"; arguments = @{}})
    )
    $gotData = $false
    foreach ($line in $r) { try { $p = $line | ConvertFrom-Json; if ($p.result.content) { $gotData = $true } } catch { } }
    if ($gotData) { Write-Host " ${C_GREEN}✓${C_RESET}"; $passed++ } else { Write-Host " ${C_RED}✗${C_RESET}"; $failed++ }
  } catch { Write-Host " ${C_RED}✗${C_RESET} $_"; $failed++ }

  # 4. JSON-RPC format integrity
  Write-Host "  ${C_DIM}[4/$total] JSON-RPC format OK...${C_RESET}" -NoNewline
  $fmtOk = $true
  foreach ($line in $r) { try { $null = $line | ConvertFrom-Json } catch { $fmtOk = $false } }
  if ($fmtOk) { Write-Host " ${C_GREEN}✓${C_RESET}"; $passed++ } else { Write-Host " ${C_RED}✗${C_RESET}"; $failed++ }

  # 5. Summary
  Write-Host "  ${C_DIM}[5/$total] Result...${C_RESET}" -NoNewline
  if ($failed -eq 0) {
    Write-Host " ${C_GREEN}✓ ALL PASS ($passed/$total)${C_RESET}" -ForegroundColor Green
  } else {
    Write-Host " ${C_RED}✗ $failed FAILED ($passed/$total)${C_RESET}" -ForegroundColor Red
  }
  Write-Host
}

# ── Colors for ping/challenge ────────────────────────────────────────────────
$C_GREEN = "`e[92m"; $C_RED = "`e[91m"; $C_DIM = "`e[2m"; $C_RESET = "`e[0m"

# ── Main dispatch ─────────────────────────────────────────────────────────────
if ($ping)     { Test-Ping; exit }
if ($challenge) { Test-Challenge; exit }

if ($list) {
  Write-Host "`n=== MCP tools/list ===" -ForegroundColor Cyan
  $responses = Send-Mcp @(
    (New-JsonRpc "initialize" 1 @{protocolVersion = "2024-11-05"; capabilities = @{tools = @{}}; clientInfo = @{name = "mcp.ps1"; version = "1.0"}}),
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    (New-JsonRpc "tools/list" 2 @{})
  )
  $responses | ForEach-Object { Write-Host ($_ | Show-Json) }
  exit
}

if ($raw) {
  Write-Host "`n=== Raw JSON-RPC ===" -ForegroundColor Cyan
  Write-Host "→ Request:" -ForegroundColor Yellow
  Write-Host ($raw | Show-Json)
  Write-Host "→ Response:" -ForegroundColor Green
  $responses = Send-Mcp @($raw)
  $responses | ForEach-Object { Write-Host ($_ | Show-Json) }
  exit
}

if ($call) {
  $toolArgs = if ($json) { $json | ConvertFrom-Json } else { @{} }
  Run-SingleCall $call $toolArgs
  exit
}

# No args → interactive loop
Start-InteractiveLoop
