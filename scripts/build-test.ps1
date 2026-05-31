#!/usr/bin/env pwsh
<#
.SYNOPSIS
  テスト用ビルド: shared同期 → 拡張機能をbuild/にコピー → サーバー起動
.EXAMPLE
  .\scripts\build-test.ps1
#>

param(
    [switch]$NoStart = $false,
    [switch]$Verbose = $false
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# 日本語対応
[System.Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$scriptDir = $PSScriptRoot
$projectRoot = Split-Path -Parent $scriptDir
$buildDir = Join-Path $projectRoot "build"
$extensionDir = Join-Path $projectRoot "extension"
$firefoxDir = Join-Path $projectRoot "firefox-mv2"
$sharedDir = Join-Path $projectRoot "shared"

Write-Host "🔨 テスト用ビルドを開始します" -ForegroundColor Cyan

# Step 1: shared/injected/ を両拡張機能に同期
Write-Host "`n📦 Step 1: shared/injected/ を同期中..." -ForegroundColor Yellow
if (Test-Path "$sharedDir\injected") {
    Copy-Item -Path "$sharedDir\injected\*" -Destination "$extensionDir\injected\" -Recurse -Force
    Copy-Item -Path "$sharedDir\injected\*" -Destination "$firefoxDir\injected\" -Recurse -Force
    Write-Host "✓ shared/injected → extension/injected と firefox-mv2/injected へ同期完了" -ForegroundColor Green
} else {
    Write-Host "⚠️  shared/injected が見つかりません（スキップ）" -ForegroundColor Yellow
}

# Step 2: build/ ディレクトリ準備
Write-Host "`n📁 Step 2: build/ ディレクトリを準備中..." -ForegroundColor Yellow
if (Test-Path $buildDir) {
    Remove-Item $buildDir -Recurse -Force
}
New-Item -ItemType Directory -Path $buildDir -Force | Out-Null
Write-Host "✓ $buildDir を初期化しました" -ForegroundColor Green

# Step 3: extension/ をコピー
Write-Host "`n📋 Step 3: Chrome MV3 拡張機能をコピー中..." -ForegroundColor Yellow
$extBuildPath = Join-Path $buildDir "extension"
New-Item -ItemType Directory -Path $extBuildPath -Force | Out-Null
Copy-Item -Path (Join-Path $extensionDir "*") -Destination $extBuildPath -Recurse -Force
Write-Host "✓ extension/ → build/extension/" -ForegroundColor Green

# Step 4: firefox-mv2/ をコピー
Write-Host "`n🦊 Step 4: Firefox MV2 拡張機能をコピー中..." -ForegroundColor Yellow
$ffBuildPath = Join-Path $buildDir "firefox-mv2"
New-Item -ItemType Directory -Path $ffBuildPath -Force | Out-Null
Copy-Item -Path (Join-Path $firefoxDir "*") -Destination $ffBuildPath -Recurse -Force
Write-Host "✓ firefox-mv2/ → build/firefox-mv2/" -ForegroundColor Green

Write-Host "`n✅ ビルド完了！" -ForegroundColor Green
Write-Host "`n📂 build/ ディレクトリ構成:" -ForegroundColor Cyan
@(Get-ChildItem $buildDir -Directory).Name | ForEach-Object {
    Write-Host "  ├─ $_"
}

# サーバー起動オプション
if (-not $NoStart) {
    Write-Host "`n🚀 サーバーを起動します..." -ForegroundColor Green
    Write-Host "HTTP :7892 + WS :7891 でリッスン中" -ForegroundColor Cyan
    Write-Host "ダッシュボード: http://localhost:7892/" -ForegroundColor Cyan
    Write-Host "(Chrome/Firefox 拡張機能で http://localhost:7891 に接続)" -ForegroundColor Cyan
    Write-Host ""

    Push-Location $projectRoot
    try {
        $serverArgs = @("server/index.js")
        if ($Verbose) {
            $serverArgs += "--verbose"
        }
        & node $serverArgs
    } finally {
        Pop-Location
    }
} else {
    Write-Host "`n💡 サーバーを起動するには: npm start" -ForegroundColor Cyan
}
