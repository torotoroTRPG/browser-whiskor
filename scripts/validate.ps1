<#
.SYNOPSIS
    Pre-push validation: YAML lint, file structure, and quick sanity checks.

.DESCRIPTION
    Runs lightweight checks before pushing to catch CI failures early.
    Not counted in test suite — this is a developer convenience tool.

.EXAMPLE
    .\scripts\validate.ps1
    .\scripts\validate.ps1 -Verbose
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot | Split-Path
$Pass = 0
$Fail = 0
$Warn = 0

function Pass([string]$Msg) {
    Write-Host "  ✅ $Msg" -ForegroundColor Green
    $script:Pass++
}
function Fail([string]$Msg) {
    Write-Host "  ❌ $Msg" -ForegroundColor Red
    $script:Fail++
}
function Warn([string]$Msg) {
    Write-Host "  ⚠️  $Msg" -ForegroundColor Yellow
    $script:Warn++
}

Write-Host "`n Validation`n" -ForegroundColor Cyan

# ── 1. YAML lint ──────────────────────────────────────────────────────────────
Write-Host "  YAML Lint" -ForegroundColor White

$YamlFiles = Get-ChildItem -Path (Join-Path $Root '.github/workflows') -Filter '*.yml' -Recurse -ErrorAction SilentlyContinue
if ($YamlFiles) {
    # Check if js-yaml is available
    $HasJsYaml = $false
    try {
        $null = (Get-ChildItem (Join-Path $Root 'node_modules/js-yaml') -ErrorAction SilentlyContinue)
        if ($HasJsYaml) { $HasJsYaml = $true }
    } catch {}

    if (-not $HasJsYaml) {
        Write-Host "  Installing js-yaml (one-time)..." -ForegroundColor Gray
        npm install js-yaml --no-save 2>&1 | Out-Null
    }

    foreach ($f in $YamlFiles) {
        $Rel = $f.FullName.Substring($Root.Length + 1)
        $EscapedPath = $f.FullName -replace '\\','/'
        $Result = node -e "const yaml=require('js-yaml'); const fs=require('fs'); try { yaml.load(fs.readFileSync(process.argv[1])); console.log('ok'); } catch(e) { console.log(e.message); process.exit(1); }" "$EscapedPath" 2>&1
        if ($LASTEXITCODE -eq 0) {
            Pass "$Rel"
        } else {
            Fail "$Rel — $Result"
        }
    }
} else {
    Warn "No workflow files found"
}

# ── 2. Shared/ sync check ────────────────────────────────────────────────────
Write-Host "`n  Shared/ Sync" -ForegroundColor White

$SharedDir = Join-Path $Root 'shared/injected'
if (Test-Path $SharedDir) {
    $SyncErrors = 0
    $Total = 0
    foreach ($f in Get-ChildItem -Path $SharedDir -Recurse -File) {
        $Rel = $f.FullName.Substring($SharedDir.Length + 1)
        $Ch = Join-Path $Root "extension/injected/$Rel"
        $Ff = Join-Path $Root "firefox-mv2/injected/$Rel"
        $Total++

        if ((Test-Path $Ch) -and (Test-Path $Ff)) {
            $ChHash = (Get-FileHash $f).Hash
            if ((Get-FileHash $Ch).Hash -ne $ChHash) { $SyncErrors++ }
            if ((Get-FileHash $Ff).Hash -ne $ChHash) { $SyncErrors++ }
        } else {
            $SyncErrors++
        }
    }

    if ($SyncErrors -eq 0) {
        Pass "All $Total shared files in sync"
    } else {
        Fail "$SyncErrors sync error(s) in $Total files — run .\scripts\sync-shared.ps1"
    }
} else {
    Warn "shared/injected/ not found"
}

# ── 3. File structure ────────────────────────────────────────────────────────
Write-Host "`n  File Structure" -ForegroundColor White

$Required = @(
    'server/index.js',
    'server/dashboard.html',
    'extension/manifest.json',
    'firefox-mv2/manifest.json',
    'package.json'
)

foreach ($f in $Required) {
    if (Test-Path (Join-Path $Root $f)) {
        Pass "$f exists"
    } else {
        Fail "$f missing"
    }
}

# ── 4. Package.json syntax ───────────────────────────────────────────────────
Write-Host "`n  Package.json" -ForegroundColor White

try {
    $Pkg = Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
    Pass "Valid JSON"
    if ($Pkg.name) { Pass "name: $($Pkg.name)" }
    if ($Pkg.version) { Pass "version: $($Pkg.version)" }
} catch {
    Fail "Invalid JSON: $_"
}

# ── 5. Version consistency ───────────────────────────────────────────────────
Write-Host "`n  Version Sync" -ForegroundColor White

$VersionResult = node (Join-Path $Root 'scripts/_check-version.js') 2>&1
if ($LASTEXITCODE -eq 0) {
    Pass "Manifests match package.json — $VersionResult"
} else {
    Fail "Version mismatch — $VersionResult"
}

$ConfigResult = node (Join-Path $Root 'scripts/_check-config-defaults.js') 2>&1
if ($LASTEXITCODE -eq 0) {
    Pass "config.json public defaults intact — $ConfigResult"
} else {
    Fail "config.json drifted from public defaults — $ConfigResult"
}

# ── 6. Model config consistency ──────────────────────────────────────────────
Write-Host "`n  Model Config" -ForegroundColor White

$ModelResult = node (Join-Path $Root 'scripts/_check-model-config.js') 2>&1
if ($LASTEXITCODE -eq 0) {
    Pass "Model config consistent — $ModelResult"
} else {
    Fail "Model config inconsistent — $ModelResult"
}

# ── 7. Hollow test guard ─────────────────────────────────────────────────────
Write-Host "`n  Test Integrity" -ForegroundColor White

$HollowResult = node (Join-Path $Root 'scripts/_check-hollow-tests.js') 2>&1
if ($LASTEXITCODE -eq 0) {
    Pass "Unit tests reach production code — $HollowResult"
} else {
    Fail "Hollow test(s) found — $HollowResult"
}

# ── Summary ──────────────────────────────────────────────────────────────────
Write-Host "`n  Result: $Pass pass, $Fail fail, $Warn warnings`n" -ForegroundColor $(if ($Fail -gt 0) { 'Red' } else { 'Green' })

if ($Fail -gt 0) {
    Write-Host "  Fix errors before pushing.`n" -ForegroundColor Yellow
    exit 1
} else {
    Write-Host "  All checks passed. Safe to push.`n" -ForegroundColor Green
    exit 0
}
