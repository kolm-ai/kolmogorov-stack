#!/usr/bin/env pwsh
# kolm-claude — fail-open launcher for Claude Code with kolm dogfood capture.
#
# This is the structural fix for the W403 fragility: instead of a STATIC
# ANTHROPIC_BASE_URL pin in settings (which can never self-heal and refuses every
# call when the proxy is down — it broke a remote tunnel session), this launcher
# decides at launch time:
#
#   1. Ensure the capture proxy is running (spawn it detached if /kolm-health is silent).
#   2. Health-check it (fast timeout).
#   3. If healthy  -> launch Claude pointed at the proxy (traffic is captured).
#   4. If NOT      -> launch Claude DIRECT to Anthropic (capture skipped, Claude always works).
#
# Capture is best-effort; Claude is bulletproof. Usage: `kolm-claude <any claude args>`.
# Disable capture for a run:  $env:KOLM_DOGFOOD = "0"; kolm-claude

$ErrorActionPreference = "SilentlyContinue"
$port = if ($env:KOLM_PROXY_PORT) { $env:KOLM_PROXY_PORT } else { "7403" }
$healthUrl = "http://127.0.0.1:$port/kolm-health"
$repo = Split-Path -Parent $PSScriptRoot
$proxyScript = Join-Path $PSScriptRoot "kolm-capture-proxy.cjs"

function Test-Proxy {
  try { $r = Invoke-WebRequest -Uri $healthUrl -TimeoutSec 1 -UseBasicParsing -ErrorAction Stop; return $r.StatusCode -eq 200 }
  catch { return $false }
}

$useProxy = $false
if ($env:KOLM_DOGFOOD -ne "0") {
  if (-not (Test-Proxy)) {
    # Spawn the proxy detached; it stays up for future launches too.
    Start-Process -FilePath "node" -ArgumentList "`"$proxyScript`"" -WindowStyle Hidden -WorkingDirectory $repo
    # Wait up to ~4s for it to bind (never longer — Claude must launch promptly).
    for ($i = 0; $i -lt 8; $i++) { Start-Sleep -Milliseconds 500; if (Test-Proxy) { break } }
  }
  $useProxy = Test-Proxy
}

if ($useProxy) {
  $env:ANTHROPIC_BASE_URL = "http://127.0.0.1:$port"
  Write-Host "[kolm] dogfood capture ON -> $($env:ANTHROPIC_BASE_URL) (~/.kolm/captures/claude-code.jsonl)" -ForegroundColor DarkGray
} else {
  # Critical: clear any inherited pin so Claude goes straight to Anthropic.
  Remove-Item Env:\ANTHROPIC_BASE_URL -ErrorAction SilentlyContinue
  if ($env:KOLM_DOGFOOD -ne "0") { Write-Host "[kolm] capture proxy unavailable -> Claude direct to Anthropic (capture skipped, session unaffected)" -ForegroundColor DarkGray }
}

# Hand off to the REAL Claude binary (resolved by path, so this works even when a
# `claude` shell-function shim points here — no recursion).
$realClaude = $null
$cands = @(
  "$env:APPDATA\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe",
  "$env:APPDATA\npm\claude.cmd",
  "$env:LOCALAPPDATA\Programs\claude\claude.exe"
)
foreach ($c in $cands) { if (Test-Path $c) { $realClaude = $c; break } }
if (-not $realClaude) {
  # Fall back to PATH lookup, excluding any function shim.
  $cmd = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { $realClaude = $cmd.Source }
}
if (-not $realClaude) { Write-Error "claude binary not found"; exit 127 }
& $realClaude @args
exit $LASTEXITCODE
