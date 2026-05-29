// W921 — health-aware failover: dispatchWithFallback must consult the
// provider-health circuit breaker (src/provider-health.js) to skip a known-down
// provider instead of burning a full upstream timeout, feed outcomes back to the
// breaker, and honor the fail-open panic invariant (never skip the LAST
// candidate). Source-level lock-in (behavior needs a live multi-provider chain).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GW = fs.readFileSync(path.join(ROOT, 'src', 'gateway-router.js'), 'utf8');

test('W921-CB #1 — gateway-router imports the provider-health circuit breaker', () => {
  assert.match(GW, /from '\.\/provider-health\.js'/, 'gateway-router must import provider-health.js');
  assert.match(GW, /isOpen as _circuitOpen/, 'must import isOpen (circuit-open check)');
  assert.match(GW, /recordOutcome as _recordHealth/, 'must import recordOutcome (health feedback)');
});

test('W921-CB #2 — failover skips circuit-open providers but never the last (fail-open)', () => {
  assert.match(GW, /const _isLast = i === chain\.length - 1/, 'must compute _isLast for the fail-open invariant');
  assert.match(GW, /if \(!_isLast && entry\.provider\)[\s\S]*?_circuitOpen\(entry\.provider\)[\s\S]*?continue;/,
    'must skip a circuit-open provider ONLY when it is not the last candidate (fail-open panic invariant)');
});

test('W921-CB #3 — every attempt feeds the breaker', () => {
  assert.match(GW, /_recordHealth\(entry\.provider,\s*\{\s*ok:\s*!!result\.ok,\s*status:\s*result\.status\s*\}\)/,
    'must record each attempt outcome (ok+status) so a flapping provider trips OPEN and recovers');
});
