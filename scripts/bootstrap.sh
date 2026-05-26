#!/usr/bin/env bash
# kolm bootstrap — install every dependency the W888 surface mix can need.
#
# Re-runnable: every step is idempotent. Optional deps that fail to install
# print "X: skip" and the script keeps going (exits 0 even on optional fail).
#
# usage:
#   bash scripts/bootstrap.sh                # full install
#   bash scripts/bootstrap.sh --no-python    # skip the ML stack
#   bash scripts/bootstrap.sh --no-node      # skip npm install
#   bash scripts/bootstrap.sh --dry-run      # print what would happen
#
# what we install:
#   - system probe   : node >=20, python3 >=3.10, git, pip
#   - node deps      : `npm install` (picks up ssh2 + the rest of package.json)
#   - python core    : torch, transformers, peft, bitsandbytes, datasets,
#                      sentence-transformers, jsonschema
#   - python export  : llama-cpp-python, exllamav2, auto-gptq, autoawq, mlx-lm
#                      (mac only for mlx-lm) — each is try-and-skip
#   - python shard   : git+https://github.com/krish1905/shard.git
#   - cloud SDKs     : runpod if $RUNPOD_API_KEY, modal if $MODAL_TOKEN_ID
#
# the goal is `kolm doctor --json` reports the full env after this runs.

set -u
# Note: deliberately NOT `set -e`. Optional deps are allowed to fail.

DRY_RUN=0
SKIP_NODE=0
SKIP_PYTHON=0
SKIP_CLOUD=0
ONLY_PROBE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-node) SKIP_NODE=1 ;;
    --no-python) SKIP_PYTHON=1 ;;
    --no-cloud) SKIP_CLOUD=1 ;;
    --probe-only) ONLY_PROBE=1 ;;
    --help|-h)
      sed -n '1,30p' "$0"
      exit 0
      ;;
  esac
done

log()  { printf "[bootstrap] %s\n" "$*"; }
warn() { printf "[bootstrap] warn: %s\n" "$*" >&2; }
skip() { printf "[bootstrap] skip: %s\n" "$*"; }
run()  {
  if [ "$DRY_RUN" -eq 1 ]; then
    log "DRY-RUN: $*"
    return 0
  fi
  eval "$@"
}

# Track results for the final summary table.
RESULTS=()
note() {
  # note <name> <ok|skip|fail> <detail>
  RESULTS+=("$1|$2|$3")
}

# ---------------------------------------------------------------------------
# System probe — required baseline.
# ---------------------------------------------------------------------------
probe_system() {
  log "probing system"

  if command -v node >/dev/null 2>&1; then
    NODE_VER="$(node -v 2>/dev/null | sed 's/^v//')"
    NODE_MAJOR="$(echo "$NODE_VER" | cut -d. -f1)"
    if [ "$NODE_MAJOR" -ge 20 ]; then
      note "node" ok "v$NODE_VER"
    else
      note "node" fail "v$NODE_VER (need >=20)"
      warn "node v$NODE_VER too old; install Node.js >=20 and re-run"
    fi
  else
    note "node" fail "not on PATH"
    warn "node not found; install Node.js >=20 (https://nodejs.org)"
  fi

  PY=""
  for cand in python3 python; do
    if command -v "$cand" >/dev/null 2>&1; then
      PY="$cand"
      break
    fi
  done
  if [ -n "$PY" ]; then
    PY_VER="$($PY -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo "0.0")"
    PY_MAJOR="$(echo "$PY_VER" | cut -d. -f1)"
    PY_MINOR="$(echo "$PY_VER" | cut -d. -f2)"
    if [ "$PY_MAJOR" -gt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -ge 10 ]; }; then
      note "python" ok "$PY $PY_VER"
    else
      note "python" fail "$PY $PY_VER (need >=3.10)"
      warn "python $PY_VER too old; install Python >=3.10"
    fi
  else
    note "python" fail "not on PATH"
    warn "python3 not found; install Python >=3.10"
  fi

  if command -v git >/dev/null 2>&1; then
    note "git" ok "$(git --version 2>/dev/null | head -1)"
  else
    note "git" fail "not on PATH"
    warn "git not found; install git"
  fi

  if [ -n "$PY" ] && $PY -m pip --version >/dev/null 2>&1; then
    note "pip" ok "$($PY -m pip --version 2>/dev/null | head -1)"
  else
    note "pip" fail "not available via $PY -m pip"
    warn "pip not available; try: $PY -m ensurepip --upgrade"
  fi
}

# ---------------------------------------------------------------------------
# Node deps via `npm install`.
# ---------------------------------------------------------------------------
install_node_deps() {
  if [ "$SKIP_NODE" -eq 1 ]; then
    skip "node deps (--no-node)"
    note "npm install" skip "--no-node"
    return
  fi
  if ! command -v npm >/dev/null 2>&1; then
    warn "npm not on PATH; cannot install node deps"
    note "npm install" fail "npm not on PATH"
    return
  fi
  log "installing node deps (npm install)"
  if run "npm install --no-audit --no-fund"; then
    note "npm install" ok "package.json deps installed"
  else
    note "npm install" fail "npm install exited non-zero"
  fi

  # ssh2 lands via the package.json. Sanity-check it actually loaded.
  if [ "$DRY_RUN" -eq 0 ] && [ -d node_modules/ssh2 ]; then
    note "ssh2" ok "node_modules/ssh2 present"
  elif [ "$DRY_RUN" -eq 1 ]; then
    note "ssh2" skip "dry-run"
  else
    note "ssh2" fail "node_modules/ssh2 missing after npm install"
  fi
}

# ---------------------------------------------------------------------------
# Python core ML stack.
# ---------------------------------------------------------------------------
pip_install_required() {
  # pip_install_required <pretty_name> <pip_spec>
  local name="$1"; shift
  local spec="$1"; shift
  if [ -z "$PY" ]; then
    note "$name" fail "no python on PATH"
    return
  fi
  log "pip install (required): $name -> $spec"
  if run "$PY -m pip install --break-system-packages --upgrade $spec >/dev/null 2>&1"; then
    note "$name" ok "$spec"
  else
    # Some envs disallow --break-system-packages (pip < 23); retry without it.
    if run "$PY -m pip install --upgrade $spec >/dev/null 2>&1"; then
      note "$name" ok "$spec"
    else
      note "$name" fail "pip install failed"
    fi
  fi
}

pip_install_optional() {
  # pip_install_optional <pretty_name> <pip_spec>
  local name="$1"; shift
  local spec="$1"; shift
  if [ -z "$PY" ]; then
    note "$name" skip "no python"
    return
  fi
  log "pip install (optional): $name -> $spec"
  if run "$PY -m pip install --break-system-packages --upgrade $spec >/dev/null 2>&1" \
     || run "$PY -m pip install --upgrade $spec >/dev/null 2>&1"; then
    note "$name" ok "$spec"
  else
    note "$name" skip "install failed (optional)"
  fi
}

install_python_core() {
  if [ "$SKIP_PYTHON" -eq 1 ]; then
    skip "python core (--no-python)"
    note "python-core" skip "--no-python"
    return
  fi
  log "installing python core ML stack"
  pip_install_required "torch"                  "torch"
  pip_install_required "transformers"           "transformers"
  pip_install_required "peft"                   "peft"
  pip_install_required "datasets"               "datasets"
  pip_install_required "sentence-transformers"  "sentence-transformers"
  pip_install_required "jsonschema"             "jsonschema"

  # bitsandbytes is required for NF4 quantize on CUDA hosts but is best-effort
  # on macOS / no-CUDA Linux. We try then degrade to optional on failure.
  if [ -n "$PY" ] && run "$PY -m pip install --break-system-packages --upgrade bitsandbytes >/dev/null 2>&1"; then
    note "bitsandbytes" ok "bitsandbytes"
  elif [ -n "$PY" ] && run "$PY -m pip install --upgrade bitsandbytes >/dev/null 2>&1"; then
    note "bitsandbytes" ok "bitsandbytes"
  else
    note "bitsandbytes" skip "no CUDA / mac wheel — kolm compile --target gguf still works"
  fi
}

install_python_export() {
  if [ "$SKIP_PYTHON" -eq 1 ]; then
    skip "python export (--no-python)"
    return
  fi
  log "installing python export stack (best-effort)"
  pip_install_optional "llama-cpp-python" "llama-cpp-python"
  pip_install_optional "exllamav2"        "exllamav2"
  pip_install_optional "auto-gptq"        "auto-gptq"
  pip_install_optional "autoawq"          "autoawq"
  # mlx-lm is Mac-only (Apple Silicon).
  if [ "$(uname -s)" = "Darwin" ]; then
    pip_install_optional "mlx-lm" "mlx-lm"
  else
    note "mlx-lm" skip "mac only"
  fi
}

install_shard() {
  if [ "$SKIP_PYTHON" -eq 1 ]; then
    skip "shard (--no-python)"
    return
  fi
  log "installing shard (KV-cache compression)"
  pip_install_optional "shard" "git+https://github.com/krish1905/shard.git"
}

# ---------------------------------------------------------------------------
# Cloud SDKs — only if user has env keys.
# ---------------------------------------------------------------------------
install_cloud_sdks() {
  if [ "$SKIP_CLOUD" -eq 1 ]; then
    skip "cloud sdks (--no-cloud)"
    note "runpod"  skip "--no-cloud"
    note "modal"   skip "--no-cloud"
    return
  fi
  if [ -n "${RUNPOD_API_KEY:-}" ]; then
    pip_install_optional "runpod" "runpod"
  else
    note "runpod" skip "RUNPOD_API_KEY not set"
  fi
  if [ -n "${MODAL_TOKEN_ID:-}" ]; then
    pip_install_optional "modal" "modal"
  else
    note "modal" skip "MODAL_TOKEN_ID not set"
  fi
}

# ---------------------------------------------------------------------------
# Post-install verification — every line should match what doctor expects.
# ---------------------------------------------------------------------------
verify_node_import() {
  local mod="$1"
  if [ "$DRY_RUN" -eq 1 ]; then
    note "verify:$mod" skip "dry-run"
    return
  fi
  if node -e "import('$mod').then(()=>process.exit(0)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    note "verify:$mod" ok "node import ok"
  else
    note "verify:$mod" fail "node import failed"
  fi
}

verify_python_import() {
  local mod="$1"
  if [ "$DRY_RUN" -eq 1 ] || [ -z "$PY" ]; then
    note "verify:$mod" skip "no probe"
    return
  fi
  if $PY -c "import $mod" >/dev/null 2>&1; then
    note "verify:$mod" ok "python import ok"
  else
    note "verify:$mod" skip "import failed (optional)"
  fi
}

verify_all() {
  if [ "$SKIP_NODE" -eq 0 ]; then verify_node_import "ssh2"; fi
  if [ "$SKIP_PYTHON" -eq 0 ]; then
    verify_python_import "torch"
    verify_python_import "transformers"
    verify_python_import "peft"
    verify_python_import "datasets"
    verify_python_import "jsonschema"
  fi
}

# ---------------------------------------------------------------------------
# Print summary table.
# ---------------------------------------------------------------------------
print_summary() {
  printf "\n"
  printf "+------------------------------+--------+--------------------------------------------------+\n"
  printf "| %-28s | %-6s | %-48s |\n" "dep" "status" "detail"
  printf "+------------------------------+--------+--------------------------------------------------+\n"
  for row in "${RESULTS[@]}"; do
    IFS='|' read -r n s d <<< "$row"
    printf "| %-28s | %-6s | %-48s |\n" "${n:0:28}" "${s:0:6}" "${d:0:48}"
  done
  printf "+------------------------------+--------+--------------------------------------------------+\n"

  local ok=0 sk=0 fl=0
  for row in "${RESULTS[@]}"; do
    case "$(echo "$row" | cut -d'|' -f2)" in
      ok) ok=$((ok+1)) ;;
      skip) sk=$((sk+1)) ;;
      fail) fl=$((fl+1)) ;;
    esac
  done
  printf "\n[bootstrap] %d ok, %d skip, %d fail (total %d)\n" "$ok" "$sk" "$fl" "${#RESULTS[@]}"
  printf "[bootstrap] next: run \`kolm doctor --json\` to confirm env\n"
}

# ---------------------------------------------------------------------------
# Main.
# ---------------------------------------------------------------------------
probe_system
if [ "$ONLY_PROBE" -eq 1 ]; then
  print_summary
  exit 0
fi
install_node_deps
install_python_core
install_python_export
install_shard
install_cloud_sdks
verify_all
print_summary
# Always exit 0 — optional fails are not a script failure.
exit 0
