// W921 — the gateway opt-ins wired into /v1/gateway/dispatch (semantic router,
// semantic/exact cache, prompt-injection guardrail) must be REACHABLE: settable
// on a namespace via POST /v1/namespaces (create) and PUT /v1/namespaces/:slug
// (patch), with enum validation. Without this plumbing the features are dark.
// Source-level lock-in (the handlers are closures behind a server boot).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTER = fs.readFileSync(path.join(ROOT, 'src', 'router.js'), 'utf8');

test('W921-NSOPT #1 — namespace create persists route_mode/cache_mode/guardrail_mode with safe defaults', () => {
  assert.match(ROUTER, /route_mode: \['static', 'cost_quality', 'semantic'\]\.includes\(body\.route_mode\) \? body\.route_mode : 'static'/,
    'create must default route_mode to static');
  assert.match(ROUTER, /cache_mode: \['off', 'exact', 'semantic', 'verified'\]\.includes\(body\.cache_mode\) \? body\.cache_mode : 'off'/,
    'create must default cache_mode to off');
  assert.match(ROUTER, /guardrail_mode: \['off', 'detect_only', 'flag', 'block'\]\.includes\(body\.guardrail_mode\) \? body\.guardrail_mode : 'detect_only'/,
    'create must default guardrail_mode to detect_only');
});

test('W921-NSOPT #2 — namespace patch allowlist accepts the three gateway opt-ins', () => {
  const m = ROUTER.match(/const allowed = \[([^\]]*)\];/);
  assert.ok(m, 'patch handler must define an allowed[] list');
  for (const f of ['route_mode', 'cache_mode', 'guardrail_mode']) {
    assert.ok(m[1].includes(`'${f}'`), `patch allowlist must include ${f}`);
  }
});

test('W921-NSOPT #3 — patch rejects out-of-range enum values (no silent garbage)', () => {
  assert.match(ROUTER, /const ENUMS = \{[\s\S]*?route_mode: \['static', 'cost_quality', 'semantic'\][\s\S]*?\};/,
    'patch must carry an ENUMS map covering route_mode');
  assert.match(ROUTER, /if \(ENUMS\[k\] && !ENUMS\[k\]\.includes\(patch\[k\]\)\) \{[\s\S]*?error: 'invalid_value'/,
    'patch must 400 on an invalid enum value');
});
