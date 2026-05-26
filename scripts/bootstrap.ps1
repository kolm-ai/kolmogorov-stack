# kolm bootstrap - install every dependency the W888 surface mix can need.
#
# Re-runnable: every step is idempotent. Optional deps that fail to install
# print "X: skip" and the script keeps going (exits 0 even on optional fail).
#
# usage:
#   pwsh scripts/bootstrap.ps1                # full install
#   pwsh scripts/bootstrap.ps1 -NoPython      # skip the ML stack
#   pwsh scripts/bootstrap.ps1 -NoNode        # skip npm install
#   pwsh scripts/bootstrap.ps1 -DryRun        # print what would happen
#
# what we install:
#   - system probe   : node >=20, python >=3.10, git, pip
#   - node deps      : `npm install` (picks up ssh2 + the rest of package.json)
#   - python core    : torch, transformers, peft, bitsandbytes, datasets,
#                      sentence-transformers, jsonschema
#   - python export  : llama-cpp-python, exllamav2, auto-gptq, autoawq
#                      (mlx-lm is Mac-only and skipped on Windows)
#   - python shard   : git+https://github.com/krish1905/shard.git
#   - cloud SDKs     : runpod if $env:RUNPOD_API_KEY, modal if $env:MODAL_TOKEN_ID
#
# the goal is `kolm doctor --json` reports the full env after this runs.

param(
  [switch]$DryRun,
  [switch]$NoNode,
  [switch]$NoPython,
  [switch]$NoCloud,
  [switch]$ProbeOnly
)

$ErrorActionPreference = "Continue"

$script:Results = New-Object System.Collections.ArrayList
$script:Python = ""

function Log($msg)  { Write-Output "[bootstrap] $msg" }
function Warn($msg) { Write-Output "[bootstrap] warn: $msg" }
function Skip($msg) { Write-Output "[bootstrap] skip: $msg" }

function Note($name, $status, $detail) {
  [void]$script:Results.Add([pscustomobject]@{
    name = $name; status = $status; detail = $detail
  })
}

function Run-Cmd($desc, $exe, $argv) {
  if ($DryRun) {
    Log "DRY-RUN: $desc"
    return $true
  }
  try {
    $out = & $exe @argv 2>$null
    return ($LASTEXITCODE -eq 0)
  } catch {
    return $false
  }
}

function Pip-Install-Required($name, $spec) {
  if (-not $script:Python) {
    Note $name "fail" "no python on PATH"
    return
  }
  Log "pip install (required): $name -> $spec"
  if ($DryRun) {
    Note $name "skip" "dry-run"
    return
  }
  # Windows pip doesn't need --break-system-packages; the flag is unknown to
  # the bundled Microsoft Store python in some configurations, so we omit it.
  $ok = Run-Cmd "pip install $spec" $script:Python @("-m", "pip", "install", "--upgrade", "--disable-pip-version-check", $spec)
  if ($ok) {
    Note $name "ok" $spec
  } else {
    Note $name "fail" "pip install failed"
  }
}

function Pip-Install-Optional($name, $spec) {
  if (-not $script:Python) {
    Note $name "skip" "no python"
    return
  }
  Log "pip install (optional): $name -> $spec"
  if ($DryRun) {
    Note $name "skip" "dry-run"
    return
  }
  $ok = Run-Cmd "pip install $spec" $script:Python @("-m", "pip", "install", "--upgrade", "--disable-pip-version-check", $spec)
  if ($ok) {
    Note $name "ok" $spec
  } else {
    Note $name "skip" "install failed (optional)"
  }
}

function Probe-System {
  Log "probing system"

  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) {
    $nodeVer = (& node -v 2>$null) -replace '^v',''
    $nodeMajor = [int]($nodeVer -split '\.')[0]
    if ($nodeMajor -ge 20) {
      Note "node" "ok" "v$nodeVer"
    } else {
      Note "node" "fail" "v$nodeVer (need >=20)"
      Warn "node v$nodeVer too old; install Node.js >=20"
    }
  } else {
    Note "node" "fail" "not on PATH"
    Warn "node not found; install Node.js >=20"
  }

  foreach ($cand in @("python", "python3", "py")) {
    $c = Get-Command $cand -ErrorAction SilentlyContinue
    if ($c) {
      $script:Python = $c.Source
      break
    }
  }
  if ($script:Python) {
    try {
      $pyVer = & $script:Python -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
      $parts = $pyVer -split '\.'
      $pyMajor = [int]$parts[0]
      $pyMinor = [int]$parts[1]
      if ($pyMajor -gt 3 -or ($pyMajor -eq 3 -and $pyMinor -ge 10)) {
        Note "python" "ok" "$script:Python $pyVer"
      } else {
        Note "python" "fail" "$pyVer (need >=3.10)"
        Warn "python $pyVer too old; install Python >=3.10"
      }
    } catch {
      Note "python" "fail" "version probe failed"
    }
  } else {
    Note "python" "fail" "not on PATH"
    Warn "python not found; install Python >=3.10"
  }

  $gitCmd = Get-Command git -ErrorAction SilentlyContinue
  if ($gitCmd) {
    $gitVer = (& git --version 2>$null)
    Note "git" "ok" $gitVer
  } else {
    Note "git" "fail" "not on PATH"
    Warn "git not found; install git"
  }

  if ($script:Python) {
    try {
      $pipVer = & $script:Python -m pip --version 2>$null
      if ($LASTEXITCODE -eq 0) {
        Note "pip" "ok" ($pipVer -split "`n")[0]
      } else {
        Note "pip" "fail" "$script:Python -m pip failed"
        Warn "pip missing; try: $script:Python -m ensurepip --upgrade"
      }
    } catch {
      Note "pip" "fail" "pip probe failed"
    }
  } else {
    Note "pip" "fail" "no python"
  }
}

function Install-Node-Deps {
  if ($NoNode) {
    Skip "node deps (-NoNode)"
    Note "npm install" "skip" "-NoNode"
    return
  }
  $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
  if (-not $npmCmd) {
    Warn "npm not on PATH; cannot install node deps"
    Note "npm install" "fail" "npm not on PATH"
    return
  }
  Log "installing node deps (npm install)"
  if ($DryRun) {
    Note "npm install" "skip" "dry-run"
    return
  }
  # `npm install` writes a lot to stdout; let it through so the user sees
  # progress. We just check $LASTEXITCODE for ok/fail.
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -eq 0) {
    Note "npm install" "ok" "package.json deps installed"
  } else {
    Note "npm install" "fail" "npm install exited non-zero"
  }

  if (Test-Path "node_modules\ssh2") {
    Note "ssh2" "ok" "node_modules/ssh2 present"
  } else {
    Note "ssh2" "fail" "node_modules/ssh2 missing after npm install"
  }
}

function Install-Python-Core {
  if ($NoPython) {
    Skip "python core (-NoPython)"
    Note "python-core" "skip" "-NoPython"
    return
  }
  Log "installing python core ML stack"
  Pip-Install-Required "torch"                 "torch"
  Pip-Install-Required "transformers"          "transformers"
  Pip-Install-Required "peft"                  "peft"
  Pip-Install-Required "datasets"              "datasets"
  Pip-Install-Required "sentence-transformers" "sentence-transformers"
  Pip-Install-Required "jsonschema"            "jsonschema"

  # bitsandbytes is required for NF4 on CUDA, best-effort everywhere else.
  if ($script:Python -and -not $DryRun) {
    $bnb = Run-Cmd "pip install bitsandbytes" $script:Python @("-m", "pip", "install", "--upgrade", "--disable-pip-version-check", "bitsandbytes")
    if ($bnb) {
      Note "bitsandbytes" "ok" "bitsandbytes"
    } else {
      Note "bitsandbytes" "skip" "no CUDA wheel - kolm compile --target gguf still works"
    }
  } else {
    Note "bitsandbytes" "skip" "dry-run or no python"
  }
}

function Install-Python-Export {
  if ($NoPython) {
    Skip "python export (-NoPython)"
    return
  }
  Log "installing python export stack (best-effort)"
  Pip-Install-Optional "llama-cpp-python" "llama-cpp-python"
  Pip-Install-Optional "exllamav2"        "exllamav2"
  Pip-Install-Optional "auto-gptq"        "auto-gptq"
  Pip-Install-Optional "autoawq"          "autoawq"
  Note "mlx-lm" "skip" "mac only"
}

function Install-Shard {
  if ($NoPython) {
    Skip "shard (-NoPython)"
    return
  }
  Log "installing shard (KV-cache compression)"
  Pip-Install-Optional "shard" "git+https://github.com/krish1905/shard.git"
}

function Install-Cloud-Sdks {
  if ($NoCloud) {
    Skip "cloud sdks (-NoCloud)"
    Note "runpod" "skip" "-NoCloud"
    Note "modal"  "skip" "-NoCloud"
    return
  }
  if ($env:RUNPOD_API_KEY) {
    Pip-Install-Optional "runpod" "runpod"
  } else {
    Note "runpod" "skip" "RUNPOD_API_KEY not set"
  }
  if ($env:MODAL_TOKEN_ID) {
    Pip-Install-Optional "modal" "modal"
  } else {
    Note "modal" "skip" "MODAL_TOKEN_ID not set"
  }
}

function Verify-Node-Import($mod) {
  if ($DryRun) { Note "verify:$mod" "skip" "dry-run"; return }
  try {
    & node -e "import('$mod').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>$null
    if ($LASTEXITCODE -eq 0) {
      Note "verify:$mod" "ok" "node import ok"
    } else {
      Note "verify:$mod" "fail" "node import failed"
    }
  } catch {
    Note "verify:$mod" "fail" "node import threw"
  }
}

function Verify-Python-Import($mod) {
  if ($DryRun -or -not $script:Python) {
    Note "verify:$mod" "skip" "no probe"
    return
  }
  try {
    & $script:Python -c "import $mod" 2>$null
    if ($LASTEXITCODE -eq 0) {
      Note "verify:$mod" "ok" "python import ok"
    } else {
      Note "verify:$mod" "skip" "import failed (optional)"
    }
  } catch {
    Note "verify:$mod" "skip" "import threw"
  }
}

function Verify-All {
  if (-not $NoNode) { Verify-Node-Import "ssh2" }
  if (-not $NoPython) {
    Verify-Python-Import "torch"
    Verify-Python-Import "transformers"
    Verify-Python-Import "peft"
    Verify-Python-Import "datasets"
    Verify-Python-Import "jsonschema"
  }
}

function Print-Summary {
  Write-Output ""
  $header = "{0,-28} | {1,-6} | {2}" -f "dep","status","detail"
  Write-Output $header
  Write-Output ("-" * 80)
  foreach ($r in $script:Results) {
    $line = "{0,-28} | {1,-6} | {2}" -f $r.name, $r.status, $r.detail
    Write-Output $line
  }
  Write-Output ("-" * 80)
  $ok = ($script:Results | Where-Object { $_.status -eq "ok" }).Count
  $sk = ($script:Results | Where-Object { $_.status -eq "skip" }).Count
  $fl = ($script:Results | Where-Object { $_.status -eq "fail" }).Count
  Write-Output ""
  Write-Output ("[bootstrap] {0} ok, {1} skip, {2} fail (total {3})" -f $ok, $sk, $fl, $script:Results.Count)
  Write-Output "[bootstrap] next: run `kolm doctor --json` to confirm env"
}

Probe-System
if ($ProbeOnly) {
  Print-Summary
  exit 0
}
Install-Node-Deps
Install-Python-Core
Install-Python-Export
Install-Shard
Install-Cloud-Sdks
Verify-All
Print-Summary
# Always exit 0 - optional fails are not a script failure.
exit 0
