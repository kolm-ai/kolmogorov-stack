// W709-5 — routing-decision event recorder + summary reader.
//
// Wave 709 ships a runtime confidence router. Every routing call writes a
// routing_decision row (src/routing-events.js) so /account/routing can show
// the local-vs-teacher ratio over time and the estimated cost saved.
//
// Tests pin the contract that the dashboard depends on:
//   1) recordRoutingDecision writes a valid row with all routing fields.
//   2) summarizeRouting counts by_route + computes local_ratio over 100 rows.
//   3) Tenant fence — other-tenant rows never enter the summary.
//   4) Namespace filter narrows the count.
//   5) recentRoutingDecisions returns newest-first capped at limit.
//   6) Missing tenant_id throws (not silently swallowed).
//   7) GET /v1/routing/summary is auth-gated (401 without bearer).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as eventStore from '../src/event-store.js';
import * as kolmStore from '../src/store.js';
import {
  recordRoutingDecision,
  summarizeRouting,
  recentRoutingDecisions,
  ROUTING_DECISIONS_TABLE,
  _resetForTests as routingResetForTests,
} from '../src/routing-events.js';
import { buildRouter } from '../src/router.js';

// src/store.js captures DATA_DIR at module load time so it survives env
// mutations from freshDir() — the routing_decisions JSON file persists at
// the repo's data/ directory across test cases. We compensate by wiping
// rows belonging to the test tenants at the start of each test.
const W709_TEST_TENANTS = [
  'tenant_w709_a',
  'tenant_w709_b',
  'tenant_w709_c1',
  'tenant_w709_c2',
  'tenant_w709_d',
  'tenant_w709_e',
  'tenant_w709_f',
];

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w709-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_ENV = 'test';
  if (eventStore._resetForTests) eventStore._resetForTests();
  if (kolmStore._resetForTests) kolmStore._resetForTests();
  // Wipe routing_decisions rows for every test tenant so each case starts
  // from a clean slate regardless of prior runs.
  for (const t of W709_TEST_TENANTS) {
    try { routingResetForTests(t); } catch (_) {} // deliberate: cleanup
  }
  return tmp;
}

async function buildApp() {
  freshDir();
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use(buildRouter());
  return { app };
}

async function listen(app) {
  const http = await import('node:http');
  return new Promise((resolve) => {
    const srv = http.createServer(app).listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ srv, base: `http://127.0.0.1:${port}` });
    });
  });
}

// =============================================================================
// 1) recordRoutingDecision writes a valid row.
// =============================================================================

test('W709 #1 — recordRoutingDecision writes a routing_decisions row with all fields', async () => {
  freshDir();
  const row = await recordRoutingDecision({
    tenant_id: 'tenant_w709_a',
    namespace: 'ns_a',
    decision: { route: 'student', reason: 'entropy_under_threshold', entropy_summary: { max: 0.2, mean: 0.1, p95: 0.15 } },
    student_tokens: 42,
    teacher_tokens: 0,
    costs: { student_micro_usd: 100, teacher_micro_usd: 5000 },
    threshold: 0.5,
  });
  assert.equal(row.kind, 'routing_decision');
  assert.equal(row.tenant_id, 'tenant_w709_a');
  assert.equal(row.tenant, 'tenant_w709_a');
  assert.equal(row.namespace, 'ns_a');
  assert.equal(row.route, 'student');
  assert.equal(row.reason, 'entropy_under_threshold');
  assert.equal(row.student_tokens, 42);
  assert.equal(row.teacher_tokens, 0);
  assert.equal(row.student_cost_micro_usd, 100);
  assert.equal(row.teacher_cost_micro_usd, 5000);
  assert.equal(row.threshold_used, 0.5);
  assert.ok(row.id && row.id.startsWith('rd_'));
  assert.ok(row.ts, 'ts is set');
  // Round-trip through findByTenant.
  const back = kolmStore.findByTenant(ROUTING_DECISIONS_TABLE, 'tenant_w709_a');
  assert.equal(back.length, 1);
  assert.equal(back[0].route, 'student');
});

// =============================================================================
// 2) summarizeRouting on a synthetic 100-event run.
// =============================================================================

test('W709 #2 — summarizeRouting counts by_route + local_ratio over 100 rows', async () => {
  freshDir();
  // 60 student, 25 mixed, 15 teacher = 100 total. local_ratio = 0.85.
  for (let i = 0; i < 60; i++) {
    await recordRoutingDecision({
      tenant_id: 'tenant_w709_b',
      namespace: 'ns_b',
      decision: { route: 'student', reason: 'entropy_under_threshold' },
      student_tokens: 10,
      costs: { student_micro_usd: 50, teacher_micro_usd: 2000 },
      threshold: 0.5,
    });
  }
  for (let i = 0; i < 25; i++) {
    await recordRoutingDecision({
      tenant_id: 'tenant_w709_b',
      namespace: 'ns_b',
      decision: { route: 'mixed', reason: 'entropy_borderline' },
      student_tokens: 8,
      teacher_tokens: 4,
      costs: { student_micro_usd: 40, teacher_micro_usd: 1500 },
      threshold: 0.5,
    });
  }
  for (let i = 0; i < 15; i++) {
    await recordRoutingDecision({
      tenant_id: 'tenant_w709_b',
      namespace: 'ns_b',
      decision: { route: 'teacher', reason: 'entropy_over_threshold' },
      student_tokens: 0,
      teacher_tokens: 50,
      costs: { student_micro_usd: 0, teacher_micro_usd: 4000 },
      threshold: 0.5,
    });
  }
  const s = summarizeRouting('tenant_w709_b', 'ns_b');
  assert.equal(s.total, 100);
  assert.equal(s.by_route.student, 60);
  assert.equal(s.by_route.mixed, 25);
  assert.equal(s.by_route.teacher, 15);
  assert.equal(s.teacher_calls_saved, 85);
  assert.equal(s.escalation_count, 40);
  assert.ok(Math.abs(s.local_ratio - 0.85) < 1e-9, 'local_ratio ~= 0.85');
  assert.ok(Math.abs(s.escalation_rate - 0.4) < 1e-9, 'escalation_rate ~= 0.4');
  assert.ok(Math.abs(s.splice_ratio - 0.4) < 1e-9, 'splice_ratio alias ~= 0.4');
  assert.ok(Math.abs(s.student_rate - 0.6) < 1e-9, 'student_rate ~= 0.6');
  assert.ok(Math.abs(s.mixed_rate - 0.25) < 1e-9, 'mixed_rate ~= 0.25');
  assert.ok(Math.abs(s.teacher_only_rate - 0.15) < 1e-9, 'teacher_only_rate ~= 0.15');
  assert.deepEqual(s.cascade_health.by_route, { student: 60, teacher: 15, mixed: 25 });
  assert.equal(s.cascade_health.escalation_count, 40);
  // est_cost_saved_usd = (60 * 2000 + 25 * 1500) / 1_000_000 = 0.1575
  assert.ok(Math.abs(s.est_cost_saved_usd - 0.1575) < 1e-6, 'est_cost_saved_usd ~= 0.1575');
  assert.ok(s.last_decision_at, 'last_decision_at set');
  assert.equal(s.version, 'w985-v1');
});

// =============================================================================
// 3) Tenant fence — other-tenant rows never enter the summary.
// =============================================================================

test('W709 #3 — tenant fence: other-tenant rows excluded', async () => {
  freshDir();
  await recordRoutingDecision({
    tenant_id: 'tenant_w709_c1',
    namespace: 'ns_shared',
    decision: { route: 'student', reason: 'r' },
  });
  await recordRoutingDecision({
    tenant_id: 'tenant_w709_c1',
    namespace: 'ns_shared',
    decision: { route: 'teacher', reason: 'r' },
  });
  // Other tenant — same namespace — should NOT leak.
  for (let i = 0; i < 7; i++) {
    await recordRoutingDecision({
      tenant_id: 'tenant_w709_c2',
      namespace: 'ns_shared',
      decision: { route: 'teacher', reason: 'r' },
    });
  }
  const c1 = summarizeRouting('tenant_w709_c1', 'ns_shared');
  assert.equal(c1.total, 2);
  assert.equal(c1.by_route.student, 1);
  assert.equal(c1.by_route.teacher, 1);
  assert.equal(c1.by_route.mixed, 0);
  const c2 = summarizeRouting('tenant_w709_c2', 'ns_shared');
  assert.equal(c2.total, 7);
  assert.equal(c2.by_route.teacher, 7);
});

// =============================================================================
// 4) Namespace filter narrows the result.
// =============================================================================

test('W709 #4 — namespace filter narrows the summary', async () => {
  freshDir();
  await recordRoutingDecision({ tenant_id: 'tenant_w709_d', namespace: 'ns_alpha', decision: { route: 'student', reason: 'r' } });
  await recordRoutingDecision({ tenant_id: 'tenant_w709_d', namespace: 'ns_alpha', decision: { route: 'mixed', reason: 'r' } });
  await recordRoutingDecision({ tenant_id: 'tenant_w709_d', namespace: 'ns_beta', decision: { route: 'teacher', reason: 'r' } });
  await recordRoutingDecision({ tenant_id: 'tenant_w709_d', namespace: 'ns_beta', decision: { route: 'teacher', reason: 'r' } });
  const all = summarizeRouting('tenant_w709_d', null);
  assert.equal(all.total, 4);
  const alpha = summarizeRouting('tenant_w709_d', 'ns_alpha');
  assert.equal(alpha.total, 2);
  assert.equal(alpha.by_route.student, 1);
  assert.equal(alpha.by_route.mixed, 1);
  assert.equal(alpha.by_route.teacher, 0);
  const beta = summarizeRouting('tenant_w709_d', 'ns_beta');
  assert.equal(beta.total, 2);
  assert.equal(beta.by_route.teacher, 2);
});

// =============================================================================
// 5) recentRoutingDecisions returns newest-first capped at limit.
// =============================================================================

test('W709 #5 — recentRoutingDecisions returns newest-first capped at limit', async () => {
  freshDir();
  for (let i = 0; i < 12; i++) {
    // Inject monotonically-increasing timestamps so sort is deterministic
    // regardless of how fast the wall clock advances under the test runner.
    await recordRoutingDecision({
      tenant_id: 'tenant_w709_e',
      namespace: 'ns_e',
      decision: {
        route: i % 3 === 0 ? 'teacher' : 'student',
        reason: 'r' + i,
        ts: new Date(Date.UTC(2026, 4, 24, 12, 0, i)).toISOString(),
      },
    });
  }
  const recent = recentRoutingDecisions('tenant_w709_e', 'ns_e', 5);
  assert.equal(recent.length, 5);
  // Newest first → reason='r11' first, 'r7' last.
  assert.equal(recent[0].reason, 'r11');
  assert.equal(recent[4].reason, 'r7');
  // Limit > total returns all rows in order.
  const all = recentRoutingDecisions('tenant_w709_e', 'ns_e', 100);
  assert.equal(all.length, 12);
  assert.equal(all[0].reason, 'r11');
});

// =============================================================================
// 6) Missing tenant_id throws.
// =============================================================================

test('W709 #6 — recordRoutingDecision throws on missing tenant_id', async () => {
  freshDir();
  await assert.rejects(
    () => recordRoutingDecision({ tenant_id: '', decision: { route: 'student', reason: 'r' } }),
    /routing_decision_missing_tenant_id|missing_tenant_id/,
  );
  await assert.rejects(
    () => recordRoutingDecision({ decision: { route: 'student', reason: 'r' } }),
    /routing_decision_missing_tenant_id|missing_tenant_id/,
  );
});

// =============================================================================
// 7) Cascade rollups expose 1h/24h/7d escalation windows.
// =============================================================================

test('W709 #7 - summarizeRouting exposes rolling cascade escalation windows', async () => {
  freshDir();
  const now = Date.now();
  const rows = [
    { route: 'mixed', ageMs: 30 * 60 * 1000 },
    { route: 'teacher', ageMs: 3 * 60 * 60 * 1000 },
    { route: 'student', ageMs: 2 * 24 * 60 * 60 * 1000 },
    { route: 'teacher', ageMs: 9 * 24 * 60 * 60 * 1000 },
  ];
  for (const [i, r] of rows.entries()) {
    await recordRoutingDecision({
      tenant_id: 'tenant_w709_f',
      namespace: 'ns_f',
      decision: {
        route: r.route,
        reason: 'rollup_' + i,
        ts: new Date(now - r.ageMs).toISOString(),
      },
    });
  }

  const s = summarizeRouting('tenant_w709_f', 'ns_f');
  assert.equal(s.total, 4);
  assert.equal(s.escalation_count, 3);
  assert.ok(Math.abs(s.escalation_rate - 0.75) < 1e-9);

  assert.equal(s.cascade_rollups.last_1h.total, 1);
  assert.equal(s.cascade_rollups.last_1h.escalation_count, 1);
  assert.equal(s.cascade_rollups.last_1h.escalation_rate, 1);

  assert.equal(s.cascade_rollups.last_24h.total, 2);
  assert.equal(s.cascade_rollups.last_24h.escalation_count, 2);
  assert.equal(s.cascade_rollups.last_24h.escalation_rate, 1);

  assert.equal(s.cascade_rollups.last_7d.total, 3);
  assert.equal(s.cascade_rollups.last_7d.escalation_count, 2);
  assert.ok(Math.abs(s.cascade_rollups.last_7d.escalation_rate - (2 / 3)) < 1e-9);
});

// =============================================================================
// 8) GET /v1/routing/summary is auth-gated.
// =============================================================================

test('W709 #8 - GET /v1/routing/summary returns 401 without bearer', async () => {
  const { app } = await buildApp();
  const { srv, base } = await listen(app);
  try {
    const res = await fetch(base + '/v1/routing/summary');
    assert.equal(res.status, 401);
    const body = await res.json();
    // Either the inner route handler's 'auth_required' or the global auth
    // middleware's 'missing api key' is acceptable — both prove the
    // endpoint refuses to leak data without a bearer key.
    assert.ok(
      body && (body.error === 'auth_required' || body.error === 'missing api key' || /auth|api[_ ]key/i.test(String(body.error || ''))),
      'expected an auth-related error, got ' + JSON.stringify(body),
    );
  } finally {
    await new Promise(r => srv.close(r));
  }
});
