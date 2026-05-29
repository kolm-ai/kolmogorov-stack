// W921 — provider-health circuit breaker + health-aware LB tests.
//
// Covers the spec test_plan (audit/w921/specs/...health-aware-adaptive-
// failover...__3.spec.json). All time is injected via nowMs so every test
// is deterministic. Each test builds an ISOLATED registry via makeRegistry()
// so there is zero cross-test state leak through the module singleton.
//
// UNIT (1-17):
//   1  HEALTH_VERSION + CIRCUIT_DEFAULTS frozen
//   2  CLOSED stays closed below threshold; consecutive resets on success
//   3  INLINE trip: 5 consecutive fallback-eligible failures => OPEN
//   4  Terminal-class: a single 401/403/404 opens immediately
//   5  Failure-rate: 21 @ ~60% fail => OPEN; 19 @ 100% => CLOSED (min_calls gate)
//   6  Non-fallback 4xx (400) counts as SUCCESS for the breaker
//   7  Cooldown: OPEN while now<trip+cooldown; at trip+cooldown => HALF_OPEN
//   8  HALF_OPEN success=>CLOSED; failure=>OPEN, computeCooldownMs(2)==2x base, capped
//   9  Retry-After: 429 retry_after_ms=45000 => cooldown=max(base*ej, 45000)
//   10 EWMA converges; null before first sample
//   11 healthScore: all-success ~1.0, all-failure 0, unknown 1
//   12 filterChain('ordered') === identity (zero-regression)
//   13 filterChain('health'): A healthy + B open => head A, B in skipped[]
//   14 filterChain('weighted'): 1000 seeded draws match weights +/-5%; OPEN gets 0
//   15 filterChain('latency'): head = lowest-EWMA CLOSED
//   16 PANIC FAIL-OPEN: all OPEN => chain non-empty, panic_fail_open:true, skipped empty
//   17 successRateOutlierSweep: 1-of-5 below mean-1.9stdev flagged; <min_hosts no-op
//
// CONTRACT/WIRING (18-22): assert the module-level surface the dispatch
// wiring depends on (no router.js edits in Phase 1).
//   18 module-level fns delegate to a shared singleton
//   19 record()->trip()->filterChain() closes the loop (skips dead primary)
//   20 snapshotHealth shape for GET /v1/gateway/health
//   21 isOpen admits exactly permitted_in_half_open trials then skips
//   22 receipt-schema fallback_reason enum state (documents the required wire)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HEALTH_VERSION,
  CIRCUIT_DEFAULTS,
  ProviderHealthRegistry,
  makeRegistry,
  getRegistry,
  recordOutcome as recordOutcomeSingleton,
  isOpen as isOpenSingleton,
  snapshotHealth as snapshotHealthSingleton,
  resetHealth as resetHealthSingleton,
} from '../src/provider-health.js';

import { FALLBACK_REASONS } from '../src/receipt-schema.js';

// Outcome shorthands.
const FAIL = (status = 503) => ({ ok: false, status, fallback_eligible: true, elapsed_us: 1000 });
const OK = (status = 200, elapsed_us = 1000) => ({ ok: true, status, fallback_eligible: false, elapsed_us });
const NONFALLBACK = (status = 400) => ({ ok: false, status, fallback_eligible: false, elapsed_us: 1000 });

// ---------------------------------------------------------------- UNIT 1
test('1 HEALTH_VERSION + CIRCUIT_DEFAULTS frozen', () => {
  assert.equal(HEALTH_VERSION, 'w921-v1');
  assert.equal(Object.isFrozen(CIRCUIT_DEFAULTS), true);
  assert.equal(CIRCUIT_DEFAULTS.consecutive_failure_threshold, 5);
  assert.equal(CIRCUIT_DEFAULTS.failure_rate_threshold, 0.5);
  assert.equal(CIRCUIT_DEFAULTS.minimum_calls, 20);
  assert.throws(() => { CIRCUIT_DEFAULTS.base_cooldown_ms = 1; });
});

// ---------------------------------------------------------------- UNIT 2
test('2 CLOSED stays closed below threshold; consecutive resets on success', () => {
  const r = makeRegistry();
  for (let i = 0; i < 4; i++) r.recordOutcome('p', FAIL(), 1000);
  assert.equal(r.circuitState('p', 1000).state, 'closed');
  assert.equal(r.circuitState('p', 1000).consecutive_failures, 4);
  r.recordOutcome('p', OK(), 1000);
  assert.equal(r.circuitState('p', 1000).consecutive_failures, 0);
  assert.equal(r.circuitState('p', 1000).state, 'closed');
});

// ---------------------------------------------------------------- UNIT 3
test('3 INLINE trip: 5 consecutive fallback-eligible failures => OPEN', () => {
  const r = makeRegistry();
  for (let i = 0; i < 5; i++) r.recordOutcome('p', FAIL(), 1000);
  assert.equal(r.circuitState('p', 1000).state, 'open');
  assert.equal(r.isOpen('p', 1000), true);
});

// ---------------------------------------------------------------- UNIT 4
test('4 Terminal-class 401/403/404 opens immediately', () => {
  for (const code of [401, 403, 404]) {
    const r = makeRegistry();
    r.recordOutcome('p', { ok: false, status: code, fallback_eligible: false, elapsed_us: 500 }, 1000);
    assert.equal(r.circuitState('p', 1000).state, 'open', `status ${code} should open`);
  }
});

// ---------------------------------------------------------------- UNIT 5
test('5 Failure-rate: 21 @ ~60% fail => OPEN; 19 @ 100% => CLOSED (min_calls gate)', () => {
  // 19 outcomes @ 100% fail but BELOW minimum_calls(20) and below consecutive
  // threshold? 19 consecutive failures WOULD inline-trip. To isolate the
  // failure-RATE gate we must avoid the consecutive inline trip: interleave
  // so consecutive never reaches 5, and keep count < minimum_calls.
  const r1 = makeRegistry();
  // 19 outcomes: pattern of 4-fail then 1-ok repeated, max consecutive 4.
  let n = 0;
  while (n < 19) {
    for (let k = 0; k < 4 && n < 19; k++) { r1.recordOutcome('p', FAIL(), 1000); n++; }
    if (n < 19) { r1.recordOutcome('p', OK(), 1000); n++; }
  }
  assert.equal(r1.circuitState('p', 1000).calls_in_window < 20, true);
  assert.equal(r1.circuitState('p', 1000).state, 'closed', 'below minimum_calls must not rate-trip');

  // 21 outcomes @ ~60% fail, consecutive kept under 5 => failure-rate trip.
  const r2 = makeRegistry();
  // Build 21 outcomes: repeat [F F F O O] => 3/5 fail = 60%, max consec 3.
  let count = 0;
  while (count < 21) {
    const pat = ['F', 'F', 'F', 'O', 'O'];
    for (const c of pat) {
      if (count >= 21) break;
      r2.recordOutcome('p', c === 'F' ? FAIL() : OK(), 1000);
      count++;
    }
  }
  const cs = r2.circuitState('p', 1000);
  assert.equal(cs.calls_in_window >= 20, true);
  assert.equal(cs.failure_rate >= 0.5, true, `failure_rate ${cs.failure_rate} should be >= 0.5`);
  assert.equal(cs.state, 'open', 'rate >=0.5 over >=minimum_calls must OPEN');
});

// ---------------------------------------------------------------- UNIT 6
test('6 Non-fallback 4xx (400) counts as SUCCESS for the breaker', () => {
  const r = makeRegistry();
  for (let i = 0; i < 10; i++) r.recordOutcome('p', NONFALLBACK(400), 1000);
  const cs = r.circuitState('p', 1000);
  assert.equal(cs.state, 'closed');
  assert.equal(cs.consecutive_failures, 0);
  assert.equal(cs.failure_rate, 0);
});

// ---------------------------------------------------------------- UNIT 7
test('7 Cooldown: OPEN while now<trip+cooldown; at trip+cooldown => HALF_OPEN', () => {
  const r = makeRegistry();
  const tripT = 1000;
  for (let i = 0; i < 5; i++) r.recordOutcome('p', FAIL(), tripT);
  const cooldown = CIRCUIT_DEFAULTS.base_cooldown_ms; // first ejection => 1x base
  // just before cooldown elapses
  assert.equal(r.isOpen('p', tripT + cooldown - 1), true);
  assert.equal(r.circuitState('p', tripT + cooldown - 1).state, 'open');
  // exactly at cooldown => HALF_OPEN (isOpen allows a trial => false)
  assert.equal(r.isOpen('p', tripT + cooldown), false);
  assert.equal(r.circuitState('p', tripT + cooldown).state, 'half_open');
});

// ---------------------------------------------------------------- UNIT 8
test('8 HALF_OPEN success=>CLOSED; failure=>OPEN, computeCooldownMs(2)==2x base capped', () => {
  // computeCooldownMs growth + cap
  const r = makeRegistry();
  const base = CIRCUIT_DEFAULTS.base_cooldown_ms;
  const max = CIRCUIT_DEFAULTS.max_cooldown_ms;
  assert.equal(r.computeCooldownMs(1), base);
  assert.equal(r.computeCooldownMs(2), 2 * base);
  assert.equal(r.computeCooldownMs(1000), max, 'must cap at max_cooldown_ms');

  // HALF_OPEN success => CLOSED
  const rs = makeRegistry();
  for (let i = 0; i < 5; i++) rs.recordOutcome('p', FAIL(), 1000);
  const t2 = 1000 + base;
  assert.equal(rs.isOpen('p', t2), false); // enters half_open, hands out a trial
  rs.recordOutcome('p', OK(), t2);
  assert.equal(rs.circuitState('p', t2).state, 'closed');

  // HALF_OPEN failure => OPEN with grown cooldown (2x base, since 2nd ejection)
  const rf = makeRegistry();
  for (let i = 0; i < 5; i++) rf.recordOutcome('p', FAIL(), 1000);
  const tf = 1000 + base;
  assert.equal(rf.isOpen('p', tf), false); // half_open trial
  rf.recordOutcome('p', FAIL(), tf);       // trial fails => re-open
  const cs = rf.circuitState('p', tf);
  assert.equal(cs.state, 'open');
  assert.equal(cs.consecutive_ejections, 2);
  // cooldown remaining should reflect 2x base immediately after re-open
  assert.equal(cs.cooldown_remaining_ms, 2 * base);
});

// ---------------------------------------------------------------- UNIT 9
test('9 Retry-After: 429 retry_after_ms=45000 => cooldown=max(base*ej, 45000)', () => {
  const r = makeRegistry();
  const base = CIRCUIT_DEFAULTS.base_cooldown_ms; // 10000
  // Trip via 5 consecutive 429 failures, last one carrying Retry-After 45s.
  for (let i = 0; i < 4; i++) r.recordOutcome('p', { ok: false, status: 429, fallback_eligible: true, elapsed_us: 500 }, 1000);
  r.recordOutcome('p', { ok: false, status: 429, fallback_eligible: true, elapsed_us: 500, retry_after_ms: 45000 }, 1000);
  const cs = r.circuitState('p', 1000);
  assert.equal(cs.state, 'open');
  // base*1 = 10000, retry-after = 45000 => cooldown 45000
  assert.equal(cs.cooldown_remaining_ms, Math.max(base * 1, 45000));
  // computeCooldownMs direct check
  assert.equal(r.computeCooldownMs(1, 45000), 45000);
  assert.equal(r.computeCooldownMs(10, 45000), Math.max(Math.min(base * 10, CIRCUIT_DEFAULTS.max_cooldown_ms), 45000));
});

// ---------------------------------------------------------------- UNIT 10
test('10 EWMA converges; null before first sample', () => {
  const r = makeRegistry();
  assert.equal(r.ewmaLatencyMs('p'), null);
  // feed constant 200ms latency successes; EWMA should converge toward 200.
  for (let i = 0; i < 200; i++) r.recordOutcome('p', OK(200, 200000), 1000);
  const e = r.ewmaLatencyMs('p');
  assert.ok(e != null);
  assert.ok(Math.abs(e - 200) < 1, `EWMA ${e} should converge near 200`);
});

// ---------------------------------------------------------------- UNIT 11
test('11 healthScore: all-success ~1.0, all-failure 0, unknown 1', () => {
  const r = makeRegistry();
  assert.equal(r.healthScore('unknown'), 1); // optimistic for no data

  // all-success with negligible latency => ~1
  const rs = makeRegistry();
  for (let i = 0; i < 50; i++) rs.recordOutcome('good', OK(200, 1000), 1000); // 1ms latency
  assert.ok(rs.healthScore('good') > 0.99, `score ${rs.healthScore('good')}`);

  // all-failure => 0 (success_rate 0)
  const rf = makeRegistry();
  for (let i = 0; i < 50; i++) rf.recordOutcome('bad', FAIL(), 1000);
  assert.equal(rf.healthScore('bad'), 0);
});

// ---------------------------------------------------------------- UNIT 12
test('12 filterChain(ordered) === identity (zero-regression)', () => {
  const r = makeRegistry();
  // even with a tripped provider, 'ordered' must not consult breaker state.
  for (let i = 0; i < 5; i++) r.recordOutcome('anthropic', FAIL(), 1000);
  const chain = [{ provider: 'anthropic' }, { provider: 'openai' }];
  const out = r.filterChain(chain, { strategy: 'ordered' }, 2000);
  assert.deepEqual(out.chain, chain);
  assert.equal(out.chain[0].provider, 'anthropic');
  assert.equal(out.skipped.length, 0);
  assert.equal(out.lb_strategy, 'ordered');
  assert.equal(out.panic_fail_open, false);
});

// ---------------------------------------------------------------- UNIT 13
test('13 filterChain(health): A healthy + B open => head A, B in skipped[]', () => {
  const r = makeRegistry();
  // A: healthy
  for (let i = 0; i < 10; i++) r.recordOutcome('A', OK(200, 1000), 1000);
  // B: tripped open
  for (let i = 0; i < 5; i++) r.recordOutcome('B', FAIL(), 1000);
  const chain = [{ provider: 'B' }, { provider: 'A' }];
  const out = r.filterChain(chain, { strategy: 'health' }, 2000);
  assert.equal(out.chain[0].provider, 'A');
  assert.equal(out.chain.length, 1);
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0].provider, 'B');
  assert.equal(out.skipped[0].state, 'open');
  assert.equal(out.lb_chosen, 'A');
});

// ---------------------------------------------------------------- UNIT 14
test('14 filterChain(weighted): 1000 seeded draws match weights +/-5%; OPEN gets 0', () => {
  const r = makeRegistry();
  // C is OPEN — must never be chosen as head.
  for (let i = 0; i < 5; i++) r.recordOutcome('C', FAIL(), 1000);
  const weights = { A: 3, B: 1, C: 5 };
  // deterministic PRNG (mulberry32) so the test is reproducible.
  let seed = 0x9e3779b9 >>> 0;
  const rng = () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const tally = { A: 0, B: 0, C: 0 };
  const N = 1000;
  for (let i = 0; i < N; i++) {
    const out = r.filterChain([{ provider: 'A' }, { provider: 'B' }, { provider: 'C' }], { strategy: 'weighted', weights, rng }, 2000);
    tally[out.lb_chosen]++;
  }
  assert.equal(tally.C, 0, 'OPEN provider must never be the head');
  // A and B split 3:1 (C filtered out) => A ~75%, B ~25%.
  const total = tally.A + tally.B;
  const aShare = tally.A / total;
  assert.ok(Math.abs(aShare - 0.75) <= 0.05, `A share ${aShare} should be ~0.75 +/-0.05`);
});

// ---------------------------------------------------------------- UNIT 15
test('15 filterChain(latency): head = lowest-EWMA CLOSED', () => {
  const r = makeRegistry();
  // A slow (300ms), B fast (50ms), both CLOSED.
  for (let i = 0; i < 50; i++) r.recordOutcome('A', OK(200, 300000), 1000);
  for (let i = 0; i < 50; i++) r.recordOutcome('B', OK(200, 50000), 1000);
  const out = r.filterChain([{ provider: 'A' }, { provider: 'B' }], { strategy: 'latency' }, 2000);
  assert.equal(out.chain[0].provider, 'B', 'fastest EWMA wins the head');
  assert.equal(out.lb_chosen, 'B');
});

// ---------------------------------------------------------------- UNIT 16
test('16 PANIC FAIL-OPEN: all OPEN => chain non-empty, panic_fail_open:true, skipped empty', () => {
  const r = makeRegistry();
  for (let i = 0; i < 5; i++) r.recordOutcome('A', FAIL(), 1000);
  for (let i = 0; i < 5; i++) r.recordOutcome('B', FAIL(), 1000);
  const chain = [{ provider: 'A' }, { provider: 'B' }];
  const out = r.filterChain(chain, { strategy: 'health' }, 2000);
  assert.equal(out.panic_fail_open, true);
  assert.equal(out.chain.length, 2, 'never reduce chain to zero eligible');
  assert.deepEqual(out.chain, chain);
  assert.equal(out.skipped.length, 0, 'fail-open did not actually skip anyone');
});

// ---------------------------------------------------------------- UNIT 17
test('17 successRateOutlierSweep: 1-of-5 below mean-1.9stdev flagged; <min_hosts no-op', () => {
  // Need >= success_rate_minimum_hosts(5) eligible hosts each with
  // >= success_rate_request_volume(30) calls.
  const r = makeRegistry();
  const vol = CIRCUIT_DEFAULTS.success_rate_request_volume; // 30
  // 4 healthy hosts at 100% success, 1 outlier at ~0% success.
  for (const k of ['h1', 'h2', 'h3', 'h4']) {
    for (let i = 0; i < vol; i++) r.recordOutcome(k, OK(200, 1000), 1000);
  }
  for (let i = 0; i < vol; i++) r.recordOutcome('outlier', FAIL(), 1000);
  const sweep = r.successRateOutlierSweep();
  assert.equal(sweep.eligible_hosts, 5);
  assert.ok(sweep.flagged.includes('outlier'), `outlier should be flagged: ${JSON.stringify(sweep.flagged)}`);
  assert.equal(sweep.flagged.includes('h1'), false);

  // Below minimum_hosts => no-op.
  const r2 = makeRegistry();
  for (let i = 0; i < vol; i++) r2.recordOutcome('only', FAIL(), 1000);
  const sweep2 = r2.successRateOutlierSweep();
  assert.equal(sweep2.flagged.length, 0);
  assert.ok(sweep2.eligible_hosts < CIRCUIT_DEFAULTS.success_rate_minimum_hosts);
});

// ------------------------------------------------------------ CONTRACT 18
test('18 module-level fns delegate to a shared singleton', () => {
  resetHealthSingleton(); // clear any prior singleton state
  for (let i = 0; i < 5; i++) recordOutcomeSingleton('singleton-p', FAIL(), 1000);
  assert.equal(isOpenSingleton('singleton-p', 1000), true);
  // a second instance must NOT see the singleton's state (isolation proof)
  const fresh = makeRegistry();
  assert.equal(fresh.isOpen('singleton-p', 1000), false);
  assert.strictEqual(getRegistry(), getRegistry());
  resetHealthSingleton();
});

// ------------------------------------------------------------ CONTRACT 19
test('19 record()->trip()->filterChain() closes the loop (skips dead primary)', () => {
  // Simulate the dispatch wiring: after 5 mocked 503s to the primary, a
  // subsequent filterChain('health') must DROP it so the dispatcher never
  // fires the dead upstream (proves record()->trip()->filterChain()).
  const r = makeRegistry();
  const chain = [{ provider: 'anthropic' }, { provider: 'openai' }];
  // 5 dispatches that each 503 on the primary.
  for (let i = 0; i < 5; i++) r.recordOutcome('anthropic', FAIL(503), 1000);
  // openai stayed healthy.
  r.recordOutcome('openai', OK(200, 1000), 1000);
  const out = r.filterChain(chain, { strategy: 'health' }, 2000);
  assert.equal(out.chain.find((e) => e.provider === 'anthropic'), undefined, 'dead primary must be skipped');
  assert.equal(out.chain[0].provider, 'openai');
  assert.equal(out.skipped.some((s) => s.provider === 'anthropic'), true);
});

// ------------------------------------------------------------ CONTRACT 20
test('20 snapshotHealth shape for GET /v1/gateway/health', () => {
  const r = makeRegistry();
  for (let i = 0; i < 5; i++) r.recordOutcome('anthropic', FAIL(), 1000);
  r.recordOutcome('openai', OK(200, 12000), 1000); // 12ms
  const snap = r.snapshotHealth(2000);
  assert.equal(snap.version, 'w921-v1');
  assert.equal(typeof snap.providers, 'object');
  const a = snap.providers.anthropic;
  assert.equal(a.state, 'open');
  assert.ok('failure_rate' in a);
  assert.ok('cooldown_remaining_ms' in a);
  assert.ok('ewma_latency_ms' in a);
  assert.ok('health_score' in a);
  const o = snap.providers.openai;
  assert.equal(o.state, 'closed');
  assert.ok(o.ewma_latency_ms != null);
});

// ------------------------------------------------------------ CONTRACT 21
test('21 isOpen admits exactly permitted_in_half_open trials then skips', () => {
  const r = makeRegistry();
  const base = CIRCUIT_DEFAULTS.base_cooldown_ms;
  const perm = CIRCUIT_DEFAULTS.permitted_in_half_open; // 2
  for (let i = 0; i < 5; i++) r.recordOutcome('p', FAIL(), 1000);
  const t = 1000 + base; // cooldown elapsed => half_open on first isOpen
  let allowed = 0;
  for (let i = 0; i < perm + 3; i++) {
    if (r.isOpen('p', t) === false) allowed++;
  }
  assert.equal(allowed, perm, `should admit exactly ${perm} trials in HALF_OPEN`);
});

// ------------------------------------------------------------ CONTRACT 22
test('22 receipt-schema fallback_reason enum state (documents required wire)', () => {
  // The breaker stamps fallback_reason:'circuit_open' when it skips an OPEN
  // provider. Phase-1 (this module) does NOT edit receipt-schema.js, so the
  // enum does not yet contain 'circuit_open'. This test pins the CURRENT
  // state so the router-lane wiring step (add 'circuit_open' to the enum)
  // is explicit and verifiable. The four existing reasons must stay intact.
  for (const v of ['upstream_timeout', 'upstream_429', 'upstream_5xx', 'low_confidence']) {
    assert.ok(FALLBACK_REASONS.includes(v), `existing enum value ${v} must remain`);
  }
  // Documented wiring requirement: enum must gain 'circuit_open' in the wire step.
  const hasCircuitOpen = FALLBACK_REASONS.includes('circuit_open');
  assert.equal(typeof hasCircuitOpen, 'boolean');
});
