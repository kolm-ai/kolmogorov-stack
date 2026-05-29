// W921 — the semantic cost<->quality router (src/semantic-router.js) must be
// wired into /v1/gateway/dispatch: gated behind namespace route_mode (default
// 'static' => unchanged), reorders the chain via scoreRoute, and stamps the
// decision on the receipt additively (non-signed, like latency_breakdown).
// Two invariants are covered live by the module test (cold-start == static
// order); this is the source-level wiring lock-in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreRoute } from '../src/semantic-router.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTER = fs.readFileSync(path.join(ROOT, 'src', 'router.js'), 'utf8');

test('W921-ROUTE #1 — dispatch gates the semantic router on route_mode and imports it', () => {
  assert.match(ROUTER, /nsConfig\.route_mode === 'cost_quality' \|\| nsConfig\.route_mode === 'semantic'/,
    'the reorder must be gated behind an opt-in route_mode (default static = unchanged)');
  assert.match(ROUTER, /await import\('\.\/semantic-router\.js'\)/, 'dispatch must import semantic-router.js');
  assert.match(ROUTER, /_sr\.scoreRoute\(\{/, 'must call scoreRoute to reorder the chain');
});

test('W921-ROUTE #2 — the router decision is stamped on the receipt additively', () => {
  assert.match(ROUTER, /receipt\.router_decision = _routerDecision/,
    'the decision must be attached to the receipt as a non-signed additive field');
});

test('W921-ROUTE #3 — cold-start invariant: opted-in but untrained keeps the static order', () => {
  const chain = [{ provider: 'anthropic', model: 'claude-opus-4-7' }, { provider: 'openai', model: 'gpt-4o-mini' }];
  const cfg = { primary: 'anthropic:claude-opus-4-7', fallback: ['openai:gpt-4o-mini'], route_mode: 'cost_quality' };
  const s = scoreRoute({ namespaceConfig: cfg, prompt: 'hello there', candidates: chain, callerConfidence: null, stats: null });
  assert.equal(s.cold_start, true, 'no trained stats => cold start');
  assert.equal(s.ordered_chain[0].provider, 'anthropic', 'cold start must preserve the static head');
  assert.equal(s.ordered_chain.length, 2, 'cold start must preserve the full chain');
});
