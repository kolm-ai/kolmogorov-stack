// W-1 / W-2 / W-3 lock-in (V1 launch wrapper close-out 2026-05-26)
//
// W-1: streaming SSE branch in /v1/gateway/dispatch
// W-2: tier rate limiting (free 50k / indie 500k / team 5M / business 25M /
//      enterprise 250M) — TIER_LIMITS shape + tierForPlan('business') gate
// W-3: cost-by-provider / cost-by-namespace / savings_usd in
//      /v1/receipts/stats — verified by reading the handler source for the
//      key keys (handler boot is integration-only; this unit test pins the
//      structural contract so a stray rename trips here).
//
// These tests stay light by NOT spinning up the router — that path needs auth
// middleware + tenant store seeding. The contract-shape pins are enough to
// catch the regressions we care about (someone removing the `business` tier
// or the gateway_calls unit).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BILLING_UNITS,
  TIER_LIMITS,
  tierForPlan,
  checkLimit,
  resetPeriod,
  incrementMeter,
  currentPeriod,
} from '../src/usage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// W-2 #1 — gateway_calls is a registered billing unit
test('W-2: BILLING_UNITS includes gateway_calls', () => {
  assert.ok(BILLING_UNITS.includes('gateway_calls'),
    'gateway_calls must be in BILLING_UNITS for /v1/gateway/dispatch to meter');
});

// W-2 #2 — every plan tier has a gateway_calls hard cap, in the launch ladder
test('W-2: every tier has a gateway_calls hard cap (50k/500k/5M/25M/250M ladder)', () => {
  const expected = {
    free:        { hard: 50_000 },
    indie:       { hard: 500_000 },
    team:        { hard: 5_000_000 },
    business:    { hard: 25_000_000 },
    enterprise:  { hard: 250_000_000 },
  };
  for (const [tier, { hard }] of Object.entries(expected)) {
    const entry = TIER_LIMITS[tier] && TIER_LIMITS[tier].gateway_calls;
    assert.ok(entry, `tier '${tier}' missing gateway_calls entry`);
    assert.equal(entry.hard, hard, `tier '${tier}' hard cap should be ${hard} (got ${entry.hard})`);
    // Soft must be < hard so the 10% grace headroom rule holds.
    assert.ok(entry.soft <= entry.hard, `tier '${tier}' soft (${entry.soft}) must be <= hard (${entry.hard})`);
  }
});

// W-2 #3 — `business` is now a DEDICATED tier, no longer an alias for team
test('W-2: tierForPlan("business") returns business (not team alias)', () => {
  assert.equal(tierForPlan('business'), 'business');
  assert.equal(tierForPlan('BUSINESS'), 'business'); // case-insensitive
  // team unchanged
  assert.equal(tierForPlan('team'), 'team');
  assert.equal(tierForPlan('teams'), 'team');
  // sanity: business limits are distinct from team
  assert.notDeepEqual(TIER_LIMITS.business, TIER_LIMITS.team);
  assert.ok(TIER_LIMITS.business.gateway_calls.hard > TIER_LIMITS.team.gateway_calls.hard,
    'business gateway_calls hard cap should be higher than team');
});

// W-2 #4 — checkLimit('gateway_calls') signals overage in the standard shape
test('W-2: checkLimit blocks gateway_calls past the hard cap', async () => {
  // Use a unique tenant id + isolated period so the test never collides.
  const period = currentPeriod() + '-w2test-' + Math.random().toString(36).slice(2, 8);
  const tid = 'tenant_w2test_' + Math.random().toString(36).slice(2, 10);
  resetPeriod(period);

  // Free tier — 50k cap.
  const r0 = checkLimit({ tenantId: tid, tier: 'free', unit: 'gateway_calls', amount: 1, period });
  assert.equal(r0.allowed, true);
  assert.equal(r0.hard, 50_000);
  assert.equal(r0.current, 0);

  // Simulate 49_999 calls and confirm the 50k-th is still allowed.
  await incrementMeter(tid, 'gateway_calls', 49_999, { period });
  const r1 = checkLimit({ tenantId: tid, tier: 'free', unit: 'gateway_calls', amount: 1, period });
  assert.equal(r1.allowed, true, 'call #50000 should still be allowed (49999 + 1 = 50000)');
  assert.equal(r1.current, 49_999);

  // The 50_001-th call must overflow.
  await incrementMeter(tid, 'gateway_calls', 1, { period });
  const r2 = checkLimit({ tenantId: tid, tier: 'free', unit: 'gateway_calls', amount: 1, period });
  assert.equal(r2.allowed, false, 'call #50001 must be blocked');
  assert.equal(r2.overHard, true);
  assert.equal(r2.current, 50_000);

  resetPeriod(period);
});

// W-1 — dispatch handler has a streaming branch that returns SSE
test('W-1: router.js /v1/gateway/dispatch has a stream:true SSE branch', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src/router.js'), 'utf8');
  // The branch must:
  //  - check body.stream === true
  //  - set text/event-stream content type
  //  - emit a kolm_receipt event
  //  - emit a [DONE] sentinel like OpenAI streaming
  assert.match(src, /body\.stream\s*===\s*true|wantsStream/, 'must check body.stream===true');
  assert.match(src, /text\/event-stream/, 'must set SSE content type');
  assert.match(src, /event:\s*kolm_receipt/, 'must emit kolm_receipt SSE event');
  assert.match(src, /\[DONE\]/, 'must emit [DONE] sentinel (OpenAI streaming convention)');
});

// W-2 — dispatch handler emits X-RateLimit headers + 429 + Retry-After
test('W-2: router.js dispatch enforces gateway_calls + emits X-RateLimit headers', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src/router.js'), 'utf8');
  assert.match(src, /usageCheckLimit\s*\(\s*\{[^}]*unit:\s*['"]gateway_calls['"]/s,
    'must call usageCheckLimit({unit:"gateway_calls"}) before doing work');
  assert.match(src, /res\.status\(429\)/, 'must return HTTP 429 on overage');
  assert.match(src, /X-RateLimit-Limit/, 'must emit X-RateLimit-Limit header');
  assert.match(src, /X-RateLimit-Remaining/, 'must emit X-RateLimit-Remaining header');
  assert.match(src, /X-RateLimit-Reset/, 'must emit X-RateLimit-Reset header');
  assert.match(src, /Retry-After/, 'must emit Retry-After header on 429');
  assert.match(src, /usageIncrementMeter\s*\(\s*tenant\s*,\s*['"]gateway_calls['"]/,
    'must increment gateway_calls on success path');
});

// W-3 — /v1/receipts/stats returns cost_by_provider, cost_by_namespace, savings_usd.
// We slice from the route declaration to the NEXT `r.get('` (or `r.post('`) to
// scope the assertion to this handler — a single closing `});` won't do it
// because the handler contains nested try/catch blocks.
test('W-3: /v1/receipts/stats includes cost_by_provider + cost_by_namespace + savings_usd', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src/router.js'), 'utf8');
  const startIdx = src.indexOf("r.get('/v1/receipts/stats'");
  assert.ok(startIdx >= 0, '/v1/receipts/stats handler not found');
  // Slice to the next route declaration (any verb) — gives us the full body
  const afterStart = src.slice(startIdx + 1);
  const nextRouteIdx = afterStart.search(/r\.(get|post|put|delete|patch|all)\(['"]/);
  const block = nextRouteIdx > 0 ? src.slice(startIdx, startIdx + 1 + nextRouteIdx) : src.slice(startIdx);
  assert.match(block, /cost_by_provider/, 'stats must include cost_by_provider');
  assert.match(block, /cost_by_namespace/, 'stats must include cost_by_namespace');
  assert.match(block, /savings_usd/, 'stats must include savings_usd');
  assert.match(block, /baseline_usd_if_all_frontier|baselineUsd/, 'stats must compute frontier-baseline counterfactual');
  // tokens broken down too so callers can derive their own cost
  assert.match(block, /tokens_by_provider/, 'stats must include tokens_by_provider');
  assert.match(block, /tokens_by_namespace/, 'stats must include tokens_by_namespace');
});
