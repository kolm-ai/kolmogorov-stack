param(
  [string]$Message = "W538: ship production UI surface",
  [switch]$SkipVerify,
  [switch]$PrivateOnly
)

$ErrorActionPreference = "Stop"

function Step($Name) {
  Write-Host ""
  Write-Host "==> $Name" -ForegroundColor Cyan
}

function Run($Exe, [string[]]$ArgsList) {
  & $Exe @ArgsList
  if ($LASTEXITCODE -ne 0) {
    throw "$Exe $($ArgsList -join ' ') failed with exit code $LASTEXITCODE"
  }
}

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

Step "repo"
$branch = (& git branch --show-current).Trim()
if ($branch -ne "main") {
  throw "Deploy expects branch main; current branch is '$branch'."
}
Write-Host "branch: $branch"
Write-Host "head:   $((& git rev-parse --short HEAD).Trim())"

if (-not $SkipVerify) {
  Step "release verification"
  Run "node" @("scripts\release-verify.cjs", "--test-shards=8", "--allow-logged-out", "--timeout-ms=3600000", "--json")

  Step "rendered UI gate"
  Run "node" @("scripts\run-ui-gates-local.mjs")
} else {
  Write-Host "verification skipped by caller" -ForegroundColor Yellow
}

Step "stage deployable files"
Run "git" @("add", "-u")

$untracked = & git ls-files --others --exclude-standard
foreach ($file in $untracked) {
  if ($file -match '^"?C') { continue }
  if ($file -like "data/*.tmp") { continue }
  if ($file -like "tmp/*") { continue }
  if ($file -like "tmp-*/*") { continue }
  if ($file -like "tmp-screenshots/*") { continue }
  if ($file -like "*.log") { continue }
  Run "git" @("add", "--", $file)
}

$staged = (& git diff --cached --name-only)
if (-not $staged) {
  Write-Host "nothing staged; skipping commit"
} else {
  Step "commit"
  Run "git" @("commit", "-m", $Message)
}

Step "push private remote"
Run "git" @("push", "origin", "main")

if (-not $PrivateOnly) {
  Step "push public remote"
  Run "git" @("push", "public", "main")
}

Step "live smoke"
$deadline = (Get-Date).AddMinutes(8)
$ok = $false
while ((Get-Date) -lt $deadline) {
  try {
    $html = (Invoke-WebRequest -Uri "https://kolm.ai/" -UseBasicParsing -Headers @{ "Cache-Control" = "no-cache" }).Content
    if ($html -match "Your AI stack starts as a gateway" -or $html -match "Capture, distill, run locally") {
      $ok = $true
      break
    }
    Write-Host "live not updated yet; waiting 20s..."
  } catch {
    Write-Host "live check failed; waiting 20s... $($_.Exception.Message)"
  }
  Start-Sleep -Seconds 20
}

if (-not $ok) {
  throw "Deploy pushed, but https://kolm.ai/ did not serve the new homepage within 8 minutes."
}

Write-Host ""
Write-Host "deployed and live-smoked: https://kolm.ai/" -ForegroundColor Green
