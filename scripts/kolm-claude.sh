#!/usr/bin/env bash
# kolm-claude — fail-open Claude Code launcher with kolm dogfood capture (bash).
# Mirror of kolm-claude.ps1: ensure proxy up -> health-gate -> point claude at it
# if healthy, else launch direct. Capture is best-effort; claude never breaks.
set -u
PORT="${KOLM_PROXY_PORT:-7403}"
HEALTH="http://127.0.0.1:${PORT}/kolm-health"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROXY="$HERE/kolm-capture-proxy.cjs"

proxy_up() { curl -s --max-time 1 "$HEALTH" >/dev/null 2>&1; }

use_proxy=0
if [ "${KOLM_DOGFOOD:-1}" != "0" ]; then
  if ! proxy_up; then
    ( KOLM_PROXY_PORT="$PORT" node "$PROXY" >/dev/null 2>&1 & ) >/dev/null 2>&1
    for _ in 1 2 3 4 5 6 7 8; do sleep 0.5; proxy_up && break; done
  fi
  proxy_up && use_proxy=1
fi

if [ "$use_proxy" = "1" ]; then
  export ANTHROPIC_BASE_URL="http://127.0.0.1:${PORT}"
  echo "[kolm] dogfood capture ON -> $ANTHROPIC_BASE_URL (~/.kolm/captures/claude-code.jsonl)" >&2
else
  unset ANTHROPIC_BASE_URL
  [ "${KOLM_DOGFOOD:-1}" != "0" ] && echo "[kolm] capture proxy unavailable -> Claude direct (session unaffected)" >&2
fi

# Resolve the real claude binary (avoid recursing into a shell alias).
REAL="$(command -v claude.exe 2>/dev/null || command -v claude 2>/dev/null)"
exec "$REAL" "$@"
