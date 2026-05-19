# W403 — kolm proxy dogfood helper.
#
# Starts/stops the local capture-and-forward proxy that Claude Code routes
# Anthropic API calls through (see .claude/settings.local.json env block).
#
# Usage:
#   powershell -File scripts/dogfood-proxy.ps1 start
#   powershell -File scripts/dogfood-proxy.ps1 stop
#   powershell -File scripts/dogfood-proxy.ps1 status
#   powershell -File scripts/dogfood-proxy.ps1 tail [--namespace NAME] [--n 20]
#
# Capture log: $env:USERPROFILE\.kolm\captures\<namespace>.jsonl
# Proxy PID:   $env:USERPROFILE\.kolm\.dogfood-proxy.pid

param(
  [Parameter(Position=0)] [string] $Action = 'status',
  [int]    $Port      = 7403,
  [string] $Host_     = '127.0.0.1',
  [string] $Upstream  = 'https://api.anthropic.com',
  [string] $Namespace = 'claude-code',
  [string] $Redact    = 'auto',
  [string] $NsFilter,
  [int]    $N         = 20
)

$ErrorActionPreference = 'Stop'
$RepoRoot  = Split-Path -Parent $PSScriptRoot
$ProxyJs   = Join-Path $RepoRoot 'src/services/proxy.js'
$KolmDir   = Join-Path $env:USERPROFILE '.kolm'
$PidFile   = Join-Path $KolmDir '.dogfood-proxy.pid'
$LogFile   = Join-Path $KolmDir '.dogfood-proxy.log'

if (-not (Test-Path $KolmDir)) { New-Item -ItemType Directory -Path $KolmDir | Out-Null }

function Get-RunningPid {
  if (-not (Test-Path $PidFile)) { return $null }
  $p = Get-Content $PidFile -ErrorAction SilentlyContinue
  if (-not $p) { return $null }
  try {
    $proc = Get-Process -Id $p -ErrorAction Stop
    if ($proc.ProcessName -eq 'node') { return [int]$p }
  } catch { return $null }
  return $null
}

function Test-Health {
  try {
    $r = Invoke-WebRequest -Uri "http://${Host_}:$Port/health" -UseBasicParsing -TimeoutSec 3
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

switch ($Action.ToLower()) {
  'start' {
    $existing = Get-RunningPid
    if ($existing -and (Test-Health)) {
      Write-Output "[dogfood-proxy] already running (pid $existing, port $Port, upstream $Upstream)"
      exit 0
    }
    if ($existing) { try { Stop-Process -Id $existing -Force } catch {}; Remove-Item $PidFile -ErrorAction SilentlyContinue }

    $args = @(
      $ProxyJs,
      "--port=$Port",
      "--host=$Host_",
      "--upstream=$Upstream",
      "--namespace=$Namespace",
      "--redact=$Redact"
    )
    $env:KOLM_SERVICE_PORT = "$Port"
    $proc = Start-Process -FilePath 'node' -ArgumentList $args -WindowStyle Hidden -PassThru -RedirectStandardOutput $LogFile -RedirectStandardError $LogFile
    $proc.Id | Out-File -FilePath $PidFile -Encoding ascii

    Start-Sleep -Milliseconds 500
    if (Test-Health) {
      Write-Output "[dogfood-proxy] started (pid $($proc.Id), port $Port, upstream $Upstream, namespace $Namespace)"
      Write-Output "[dogfood-proxy] log: $LogFile"
      Write-Output "[dogfood-proxy] captures: $(Join-Path $KolmDir 'captures')\$Namespace.jsonl"
    } else {
      Write-Error "[dogfood-proxy] start failed — see $LogFile"
      exit 1
    }
  }

  'stop' {
    $existing = Get-RunningPid
    if (-not $existing) {
      Write-Output "[dogfood-proxy] not running"
      Remove-Item $PidFile -ErrorAction SilentlyContinue
      exit 0
    }
    try { Stop-Process -Id $existing -Force } catch {}
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    Write-Output "[dogfood-proxy] stopped (was pid $existing)"
  }

  'status' {
    $existing = Get-RunningPid
    $healthy  = Test-Health
    if ($healthy) {
      $pidTag = if ($existing) { "pid $existing" } else { "external, no pid file" }
      Write-Output "[dogfood-proxy] UP ($pidTag, port $Port)"
      try {
        $h = Invoke-RestMethod -Uri "http://${Host_}:$Port/health" -TimeoutSec 3
        Write-Output ("  upstream:    {0}" -f $h.upstream)
        Write-Output ("  uptime_s:    {0}" -f $h.uptime_s)
        Write-Output ("  capture_dir: {0}" -f $h.capture_dir)
        Write-Output ("  version:     {0}" -f $h.version)
      } catch {}
    } elseif ($existing) {
      Write-Output "[dogfood-proxy] pid $existing exists but /health not responding"
      exit 2
    } else {
      Write-Output "[dogfood-proxy] DOWN"
      exit 1
    }
  }

  'tail' {
    if (-not $NsFilter) { $NsFilter = $Namespace }
    $cap = Join-Path $KolmDir "captures\$NsFilter.jsonl"
    if (-not (Test-Path $cap)) { Write-Output "[dogfood-proxy] no captures yet for $NsFilter"; exit 0 }
    $lines = Get-Content $cap -Tail $N
    foreach ($line in $lines) {
      try {
        $row = $line | ConvertFrom-Json
        $promptHead = ($row.prompt -replace '\s+', ' ')
        if ($promptHead.Length -gt 80) { $promptHead = $promptHead.Substring(0,80) + '...' }
        Write-Output ("{0}  {1}  status={2}  lat={3}ms  durable=true  {4}" -f $row.ts, $row.capture_id, $row.upstream_status, [math]::Round($row.latency_us/1000,0), $promptHead)
      } catch {
        Write-Output $line
      }
    }
  }

  default {
    Write-Output "usage: dogfood-proxy.ps1 {start|stop|status|tail}"
    exit 64
  }
}
