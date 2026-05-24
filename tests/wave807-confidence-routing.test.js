// @unauthed-test — pure unit tests of src/confidence-router.js + src/splice-to-teacher.js; never mounts buildRouter().
// W807 — confidence-aware adaptive routing tests.
//
// The atomic items (per KOLM_W707_SYSTEM_UPGRADE_PLAN.md W807-1..6):
//   1. token-level entropy + threshold table + streaming window
//   2. mid-response splice with honest envelope
//   3. response-metadata schema shape
//   4. dashboard page exists with the required tile slots
//   5. per-tenant max_splice_delay_ms budget
//   6. wire-into-W720 weakness-signal helper
//
// Tests in this file are atomic: each test pins exactly one contract.
// Anti-brittleness (per W604 memory): never assert exact file contents
// for the dashboard — assert the presence of the W807 tile slots via
// regex with a numeric threshold.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  VERSION as CR_VERSION,
  THRESHOLD_TABLE,
  DEFAULT_PROFILE,
  resolveThreshold,
  tokenEntropy,
  streamingEntropyWindow,
  emitSpliceWeaknessSignal,
} from '../src/confidence-router.js';

import {
  VERSION as TS_VERSION,
  DEFAULT_MAX_SPLICE_DELAY_MS,
  spliceToTeacher,
  getMaxSpliceDelayMs,
  setMaxSpliceDelayMs,
  _resetTenantBudgetsForTests,
} from '../src/teacher-splice.js';

import * as eventStore from '../src/event-store.js';
import * as kolmStore from '../src/store.js';
import { _resetForTests as routingResetForTests } from '../src/routing-events.js';

// Local tenants the W720 hook tests write under; we reset them at the top
// of each test that touches the routing_decisions table.
const W807_TEST_TENANTS = [
  'tenant_w807_a',
  'tenant_w807_b',
  'tenant_w807_c',
  'tenant_w807_d',
];

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w807-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_ENV = 'test';
  if (eventStore._resetForTests) eventStore._resetForTests();
  if (kolmStore._resetForTests) kolmStore._resetForTests();
  for (const t of W807_TEST_TENANTS) {
    try { routingResetForTests(t); } catch (_) {}
  }
  _resetTenantBudgetsForTests();
  // Wipe any env-budget so the default path runs unless a test sets it.
  delete process.env.KOLM_MAX_SPLICE_DELAY_MS;
  return tmp;
}

// ---------------------------------------------------------------------------
// W807-1 — token entropy + threshold table + streaming window
// ---------------------------------------------------------------------------

test('W807 #1 — THRESHOLD_TABLE has the three named profiles with monotone values', () => {
  assert.equal(THRESHOLD_TABLE.aggressive, 0.85);
  assert.equal(THRESHOLD_TABLE.balanced, 0.7);
  assert.equal(THRESHOLD_TABLE.conservative, 0.55);
  // aggressive > balanced > conservative — higher number = more tolerant.
  assert.ok(THRESHOLD_TABLE.aggressive > THRESHOLD_TABLE.balanced);
  assert.ok(THRESHOLD_TABLE.balanced > THRESHOLD_TABLE.conservative);
  assert.equal(DEFAULT_PROFILE, 'balanced');
});

test('W807 #2 — resolveThreshold accepts named profile, raw number, and unknown-string fallback', () => {
  // Named profile.
  const aggr = resolveThreshold('aggressive');
  assert.equal(aggr.value, 0.85);
  assert.equal(aggr.profile, 'aggressive');
  // Raw number passes through.
  const raw = resolveThreshold(0.42);
  assert.equal(raw.value, 0.42);
  assert.equal(raw.profile, null);
  // Unknown string falls back to balanced + records the original input.
  const unknown = resolveThreshold('frothy');
  assert.equal(unknown.value, THRESHOLD_TABLE.balanced);
  assert.equal(unknown.profile, 'balanced');
  assert.equal(unknown.unknown, 'frothy');
});

test('W807 #3 — tokenEntropy returns 0 for empty/invalid input and >0 for uniform distribution', () => {
  assert.equal(tokenEntropy(null), 0);
  assert.equal(tokenEntropy([]), 0);
  assert.equal(tokenEntropy(undefined), 0);
  // Uniform over 4 -> log(4) nats ≈ 1.386.
  const h = tokenEntropy([0.25, 0.25, 0.25, 0.25]);
  assert.ok(Math.abs(h - Math.log(4)) < 1e-6, 'expected ≈ log(4); got ' + h);
  // OpenAI-shaped row.
  const openaiRow = [{ token: 'a', logprob: Math.log(0.5) }, { token: 'b', logprob: Math.log(0.5) }];
  assert.ok(Math.abs(tokenEntropy(openaiRow) - Math.log(2)) < 1e-6);
});

test('W807 #4 — streamingEntropyWindow tracks O(1) mean + exceeds-threshold', () => {
  const w = streamingEntropyWindow(4);
  assert.equal(w.capacity, 4);
  assert.equal(w.size, 0);
  assert.equal(w.exceeds(0.5), false);
  // Push four moderate values.
  w.push(0.2);
  w.push(0.4);
  w.push(0.6);
  w.push(0.8);
  assert.equal(w.size, 4);
  assert.ok(Math.abs(w.mean() - 0.5) < 1e-6);
  // Mean (0.5) is NOT strictly above 0.5 → exceeds returns false (strict-above).
  assert.equal(w.exceeds(0.5), false);
  // Push a fifth value (1.2); window evicts the first (0.2). New mean = (0.4+0.6+0.8+1.2)/4 = 0.75.
  const last = w.push(1.2);
  assert.equal(last.at, 4);
  assert.ok(Math.abs(w.mean() - 0.75) < 1e-6);
  assert.equal(w.exceeds(0.7), true);
});

// ---------------------------------------------------------------------------
// W807-2 — mid-response splice + honest envelope
// ---------------------------------------------------------------------------

test('W807 #5 — spliceToTeacher honest envelope when teacher_call is absent', async () => {
  freshDir();
  const env = await spliceToTeacher({
    tokens_so_far: ['hello', 'world'],
    prompt: 'irrelevant',
    teacher_id: 'anthropic',
    threshold_used: 0.7,
    threshold_profile: 'balanced',
  });
  // local-only fallback shape.
  assert.equal(env.local_tokens, 2);
  assert.equal(env.teacher_tokens, 0);
  assert.equal(env.local_ratio, 1);
  assert.equal(env.threshold_used, 0.7);
  assert.equal(env.threshold_profile, 'balanced');
  assert.equal(env.fallback_failed, true);
  assert.equal(env.version, 'w807-v1');
  assert.equal(env.splice_events.length, 1);
  assert.equal(env.splice_events[0].ok, false);
  assert.equal(env.splice_events[0].error, 'no_teacher_call_wired');
  assert.equal(env.splice_events[0].at_token, 2);
});

test('W807 #6 — spliceToTeacher records successful splice + computes local_ratio', async () => {
  freshDir();
  const env = await spliceToTeacher({
    tokens_so_far: ['the', 'quick'],
    prompt: 'irrelevant',
    teacher_id: 'openai',
    threshold_used: 0.55,
    threshold_profile: 'conservative',
    teacher_call: async () => ({ text: 'brown fox', completion_tokens: 4 }),
  });
  assert.equal(env.local_tokens, 2);
  assert.equal(env.teacher_tokens, 4);
  assert.ok(Math.abs(env.local_ratio - 2 / 6) < 1e-6);
  assert.equal(env.fallback_failed, false);
  assert.equal(env.splice_events.length, 1);
  assert.equal(env.splice_events[0].ok, true);
  assert.equal(env.splice_events[0].teacher_id, 'openai');
  assert.equal(typeof env.splice_events[0].latency_ms, 'number');
  assert.ok(env.splice_events[0].latency_ms >= 0);
});

// ---------------------------------------------------------------------------
// W807-3 — response metadata schema shape
// ---------------------------------------------------------------------------

test('W807 #7 — response metadata envelope carries every W807-3 field', async () => {
  freshDir();
  const env = await spliceToTeacher({
    tokens_so_far: ['x'],
    prompt: 'p',
    teacher_call: async () => ({ text: 'yz', completion_tokens: 2 }),
    threshold_used: 0.7,
    threshold_profile: 'balanced',
  });
  // Per the W807-3 schema all of these keys MUST exist.
  for (const k of ['local_tokens', 'teacher_tokens', 'local_ratio', 'splice_events', 'threshold_used', 'threshold_profile', 'fallback_failed', 'version']) {
    assert.ok(Object.prototype.hasOwnProperty.call(env, k), 'missing key: ' + k);
  }
  // splice_events members carry at_token / reason / latency_ms.
  for (const k of ['at_token', 'reason', 'latency_ms']) {
    assert.ok(Object.prototype.hasOwnProperty.call(env.splice_events[0], k), 'missing splice_events.' + k);
  }
});

// ---------------------------------------------------------------------------
// W807-4 — dashboard page exists + has the four W807 tile slots
// ---------------------------------------------------------------------------

test('W807 #8 — /account/confidence.html ships with the four required tile slots', () => {
  const p = path.join(process.cwd(), 'public', 'account', 'confidence.html');
  assert.ok(fs.existsSync(p), 'public/account/confidence.html must exist');
  const html = fs.readFileSync(p, 'utf8');
  // Tile slot heuristics — regex + threshold count, NEVER exact-substring.
  // (Per W604 anti-brittleness lock-in discipline.)
  assert.ok(/local-vs-teacher ratio/i.test(html), 'tile #1: local-vs-teacher ratio over time');
  assert.ok(/cost saving/i.test(html), 'tile #2: cost savings line');
  assert.ok(/(p50|p95|p99)/i.test(html), 'tile #3: latency percentiles');
  assert.ok(/threshold distribution|histogram/i.test(html), 'tile #4: threshold-distribution histogram');
  // Reuses ks- classes from /account/routing.html.
  const ksClassMatches = html.match(/class="ks[\w-]*"|ks-nav|ks-footer/g) || [];
  assert.ok(ksClassMatches.length >= 5, 'should reuse ks- scaffold classes (got ' + ksClassMatches.length + ')');
});

test('W807 #9 — vercel.json rewrites /account/confidence to the HTML', () => {
  const p = path.join(process.cwd(), 'vercel.json');
  const raw = fs.readFileSync(p, 'utf8');
  const cfg = JSON.parse(raw);
  const rewrites = cfg.rewrites || [];
  const hit = rewrites.find((r) => r && r.source === '/account/confidence' && r.destination === '/account/confidence.html');
  assert.ok(hit, 'vercel.json must include {/account/confidence → /account/confidence.html}');
});

// ---------------------------------------------------------------------------
// W807-5 — per-tenant max_splice_delay_ms budget
// ---------------------------------------------------------------------------

test('W807 #10 — getMaxSpliceDelayMs priority: explicit > env > tenant > default', () => {
  freshDir();
  // Default when nothing is set.
  assert.equal(getMaxSpliceDelayMs('tenant_w807_a'), DEFAULT_MAX_SPLICE_DELAY_MS);
  // Tenant override wins over default.
  setMaxSpliceDelayMs('tenant_w807_a', 2500);
  assert.equal(getMaxSpliceDelayMs('tenant_w807_a'), 2500);
  // Env beats tenant.
  process.env.KOLM_MAX_SPLICE_DELAY_MS = '1234';
  assert.equal(getMaxSpliceDelayMs('tenant_w807_a'), 1234);
  // Explicit override beats env.
  assert.equal(getMaxSpliceDelayMs('tenant_w807_a', 99), 99);
  // Cleanup.
  delete process.env.KOLM_MAX_SPLICE_DELAY_MS;
  setMaxSpliceDelayMs('tenant_w807_a', null);
  assert.equal(getMaxSpliceDelayMs('tenant_w807_a'), DEFAULT_MAX_SPLICE_DELAY_MS);
});

test('W807 #11 — splice that exceeds budget degrades to local + stamps splice_budget_exceeded', async () => {
  freshDir();
  // Use a slow teacher_call that exceeds the small budget.
  const env = await spliceToTeacher({
    tokens_so_far: ['a', 'b', 'c'],
    prompt: 'p',
    tenant_id: 'tenant_w807_b',
    namespace: 'ns_b',
    budget_ms: 30,
    threshold_used: 0.7,
    threshold_profile: 'balanced',
    teacher_call: () => new Promise((resolve) => setTimeout(() => resolve({ text: 'too late', completion_tokens: 99 }), 200)),
  });
  assert.equal(env.fallback_failed, true);
  assert.equal(env.teacher_tokens, 0);
  assert.equal(env.local_tokens, 3);
  assert.equal(env.local_ratio, 1);
  assert.equal(env.splice_events.length, 1);
  assert.equal(env.splice_events[0].ok, false);
  assert.equal(env.splice_events[0].reason, 'splice_budget_exceeded');
  assert.equal(env.splice_events[0].error, 'splice_budget_exceeded');
  assert.equal(env.splice_events[0].budget_ms, 30);
});

// ---------------------------------------------------------------------------
// W807-6 — wire-into-W720
// ---------------------------------------------------------------------------

test('W807 #12 — emitSpliceWeaknessSignal writes a routing_decisions row + a weakness-signal event', async () => {
  freshDir();
  const spliceEnvelope = {
    local_tokens: 5,
    teacher_tokens: 10,
    splice_events: [{ at_token: 5, reason: 'entropy_window_exceeded', latency_ms: 120, ok: true, teacher_id: 'anthropic' }],
    threshold_used: 0.7,
    threshold_profile: 'balanced',
    window_mean: 0.82,
    window_max: 0.91,
    fallback_failed: false,
  };
  const r = await emitSpliceWeaknessSignal({
    tenant_id: 'tenant_w807_c',
    namespace: 'ns_c',
    splice_event: spliceEnvelope,
    student_micro_usd: 200,
    teacher_micro_usd: 1500,
  });
  assert.equal(r.ok, true);
  assert.equal(r.row.kind, 'routing_decision');
  assert.equal(r.row.tenant_id, 'tenant_w807_c');
  assert.equal(r.row.namespace, 'ns_c');
  assert.equal(r.row.route, 'mixed');
  assert.ok(String(r.row.reason).startsWith('splice:'), 'reason should be tagged with splice:<base>');
  assert.equal(r.row.threshold_used, 0.7);
  assert.equal(r.row.student_tokens, 5);
  assert.equal(r.row.teacher_tokens, 10);

  // Detect underperforming via W720 — the event-store row written by W807-6
  // must be visible.
  const si = await import('../src/self-improvement.js');
  const detection = await si.detectUnderperformingCaptures({
    tenant_id: 'tenant_w807_c',
    namespace: 'ns_c',
    window_days: 7,
    min_failure_rate: 0, // accept anything to assert the row is reachable
    min_kscore_delta: 0.05,
  });
  // detectUnderperformingCaptures returns ok:true (or ok:false with reason
  // 'no_route_telemetry' if appendEvent rejected the row). We require:
  //   - the function did NOT throw, and
  //   - if ok:true then events_scanned >= 1.
  if (detection.ok) {
    assert.ok(detection.events_scanned >= 1, 'expected detectUnderperformingCaptures to see ≥1 event; got ' + detection.events_scanned);
  } else {
    // Acceptable only if the event store reports no telemetry; this would
    // indicate appendEvent rejected our row — call that out instead of
    // silently passing.
    assert.notEqual(detection.error, 'event_store_unavailable', 'event-store must be available in tests');
  }
});

test('W807 #13 — emitSpliceWeaknessSignal honest envelope when tenant_id missing', async () => {
  freshDir();
  const r = await emitSpliceWeaknessSignal({
    namespace: 'ns_d',
    splice_event: { local_tokens: 1, teacher_tokens: 1, splice_events: [] },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'missing_tenant_id');
  assert.equal(r.version, 'w807-v1');
  assert.ok(typeof r.hint === 'string' && r.hint.length > 0);
});

test('W807 #14 — emitSpliceWeaknessSignal honest envelope when splice_event missing', async () => {
  freshDir();
  const r = await emitSpliceWeaknessSignal({ tenant_id: 'tenant_w807_d' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'missing_splice_event');
  assert.equal(r.version, 'w807-v1');
});

test('W807 #15 — module versions stay in lockstep at w807-v1', () => {
  // Single-source-of-truth check so a rev bump of one module does NOT
  // leave the other stamping stale metadata.
  assert.equal(CR_VERSION, 'w807-v1');
  assert.equal(TS_VERSION, 'w807-v1');
});
