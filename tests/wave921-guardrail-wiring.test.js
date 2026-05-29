// W921 — the prompt-injection guardrail (src/gateway-guardrail.js) must be wired
// into the /v1/gateway/dispatch input stage: applied after the input-PII scan,
// blocking on a 'block'-mode verdict, and surfaced on the response (kolm_guardrail)
// for audit. Default mode is non-blocking ('detect_only') so existing namespaces
// are unaffected. Source-level lock-in (behavior lives behind a server boot).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTER = fs.readFileSync(path.join(ROOT, 'src', 'router.js'), 'utf8');

test('W921-GW #1 — dispatch imports + applies the guardrail with a detect_only default', () => {
  assert.match(ROUTER, /await import\('\.\/gateway-guardrail\.js'\)/, 'dispatch must import gateway-guardrail.js');
  assert.match(ROUTER, /guardrail\.applyGuardrail\(\{[\s\S]*?mode:\s*nsConfig\.guardrail_mode\s*\|\|\s*'detect_only'/,
    'dispatch must call applyGuardrail with a detect_only default (non-blocking unless the namespace opts in)');
});

test('W921-GW #2 — dispatch blocks on a block-mode verdict and surfaces the verdict', () => {
  assert.match(ROUTER, /if\s*\(guard\.blocked\)\s*\{[\s\S]*?prompt_injection_blocked/,
    'dispatch must return 400 prompt_injection_blocked when guard.blocked');
  assert.match(ROUTER, /kolm_guardrail:\s*guardrail\.buildGuardrailReceiptField\(guard\)/,
    'dispatch must surface the guardrail verdict on the response as kolm_guardrail');
});
