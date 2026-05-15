#!/usr/bin/env bash
# smoke-chat-nl.sh
#
# Validates that `kolm chat` correctly dispatches natural-language prompts
# to the matching CLI verbs (or narrates correctly for informational asks).
# Runs against whichever `kolm` is on PATH (use this from a fresh install
# to confirm a release shipped end-to-end).
#
# Exits non-zero on the first failed expectation. Prints a per-test pass/fail
# line so the failing case is obvious.

set -u
pass=0
fail=0
fails=()

check() {
  local label="$1" out="$2" expect="$3"
  if echo "$out" | grep -q -- "$expect"; then
    echo "  PASS  $label"
    pass=$((pass + 1))
  else
    echo "  FAIL  $label"
    echo "        expected substring: $expect"
    echo "        actual: $(echo "$out" | head -c 240)..."
    fail=$((fail + 1))
    fails+=("$label")
  fi
}

# Force airgap on every probe so we don't fire side-effect cloud compile
# jobs in CI. Airgap returns narration-only; we only check that the intent
# routes correctly. Action dispatch is exercised by the integration tests.

# 1. scaffold ask -> compile intent + scaffold-style narration
out=$(echo "make me a redactor recipe" | kolm chat --once - --airgap --json 2>&1)
check "scaffold redactor"          "$out" '"intent":"compile"'
check "task extracted"             "$out" '"task":"redactor recipe"'

# 2. true compile ask -> compile intent, full task body
out=$(echo "compile a recipe that classifies tickets by urgency" | kolm chat --once - --airgap --json 2>&1)
check "compile full task"          "$out" '"task":"classifies tickets by urgency"'

# 3. anonymize ask -> redact heuristic in narration
out=$(echo "anonymize my customer data" | kolm chat --once - --airgap --json 2>&1)
check "anonymize narrated"         "$out" 'redact\|anonym\|seeds generate'

# 4. status ask -> status intent
out=$(echo "show my status" | kolm chat --once - --airgap --json 2>&1)
check "status intent"              "$out" '"intent":"status"'

# 5. install ask -> install intent
out=$(echo "install claude code" | kolm chat --once - --airgap --json 2>&1)
check "install intent"             "$out" '"intent":"install"'
check "harness extracted"          "$out" 'claude-code'

# 6. upgrade ask -> upgrade intent
out=$(echo "upgrade kolm" | kolm chat --once - --airgap --json 2>&1)
check "upgrade intent"             "$out" '"intent":"upgrade"'

# 7. empty / unknown -> help intent (falls through cleanly)
out=$(echo "asdfgh" | kolm chat --once - --airgap --json 2>&1)
check "unknown falls to help"      "$out" '"intent":"help"'

# 8. kolm anonymize verb exists in help
out=$(kolm help 2>&1)
check "anonymize in main help"     "$out" 'anonymize'

# 9. kolm chat help mentions action-mode wording
out=$(kolm help chat 2>&1)
check "chat help mentions EXECUTES" "$out" 'EXECUTES'

echo ""
echo "----------------------------------------"
echo "passed: $pass  failed: $fail"
if [ "$fail" -gt 0 ]; then
  echo "failures:"
  for f in "${fails[@]}"; do echo "  - $f"; done
  exit 1
fi
exit 0
