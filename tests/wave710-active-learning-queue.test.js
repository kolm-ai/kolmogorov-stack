// W710 — active-learning queue.
//
// Wave 709 emits routing_decisions rows; W710 picks the high-value subset
// (route='teacher'|'mixed') into an active-learning queue that `kolm distill
// --resume-from-active-queue` will pull. These tests pin the contract:
//
//   1) enqueueFromRoutingDecision writes exactly one queued row for a
//      'teacher'/'mixed' decision.
//   2) listQueued is tenant-fenced (foreign tenant gets [] for the same
//      namespace).
//   3) consumeQueue is atomic — two parallel calls do not double-consume.
//   4) requeueStale only flips 'consumed' rows older than the threshold.
//   5) summarize math is correct on a mixed queued/consumed/dropped fixture.
//   6) recordRoutingDecision auto-enqueues only when route !== 'student'.
//   7) CLI: --resume-from-active-queue with an empty queue returns
//      ok:true consumed:0.
//   8) _resetForTests clears state.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as eventStore from '../src/event-store.js';
import * as kolmStore from '../src/store.js';
import {
  recordRoutingDecision,
  _resetForTests as routingResetForTests,
} from '../src/routing-events.js';
import {
  enqueueFromRoutingDecision,
  listQueued,
  consumeQueue,
  requeueStale,
  summarize,
  dropRow,
  ACTIVE_LEARNING_QUEUE_TABLE,
  _resetForTests as alqResetForTests,
} from '../src/active-learning-queue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '..', 'cli', 'kolm.js');

// Every test below uses a unique tenant so that even if src/store.js's
// captured DATA_DIR persists the JSON table between tests in the same
// process, we cannot accidentally read another test's rows. We also wipe
// the listed tenants at the start of each freshDir() call.
const W710_TEST_TENANTS = [
  'tenant_w710_a',
  'tenant_w710_b',
  'tenant_w710_c',
  'tenant_w710_d_1',
  'tenant_w710_d_2',
  'tenant_w710_e',
  'tenant_w710_f',
  'tenant_w710_g',
  'tenant_w710_h',
  'tenant_w710_i',
];

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w710-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_ENV = 'test';
  if (eventStore._resetForTests) eventStore._resetForTests();
  if (kolmStore._resetForTests) kolmStore._resetForTests();
  for (const t of W710_TEST_TENANTS) {
    try { routingResetForTests(t); } catch (_) {} // deliberate: cleanup
    try { alqResetForTests(t); } catch (_) {} // deliberate: cleanup
  }
  return tmp;
}

function makeDecision(route, extras = {}) {
  return {
    id: 'rd_test_' + Math.random().toString(36).slice(2, 10),
    kind: 'routing_decision',
    route,
    reason: extras.reason || `route_${route}`,
    trace_id: extras.trace_id || null,
    namespace: extras.namespace || 'default',
    entropy_summary: extras.entropy_summary || null,
    student_tokens: extras.student_tokens ?? 0,
    teacher_tokens: extras.teacher_tokens ?? 0,
    threshold_used: extras.threshold_used ?? 0.5,
    ts: extras.ts || new Date().toISOString(),
  };
}

// =============================================================================
// 1) enqueueFromRoutingDecision writes one queued row.
// =============================================================================

test('W710 #1 — enqueueFromRoutingDecision writes one queued row', async () => {
  freshDir();
  const rd = makeDecision('teacher', {
    trace_id: 'a'.repeat(32),
    entropy_summary: { max: 0.9, mean: 0.6, p95: 0.85 },
  });
  const res = enqueueFromRoutingDecision('tenant_w710_a', 'ns_one', rd);
  assert.equal(res.ok, true, 'enqueue returned ok:true');
  assert.equal(res.row.kind, 'active_learning_row');
  assert.equal(res.row.status, 'queued');
  assert.equal(res.row.tenant, 'tenant_w710_a');
  assert.equal(res.row.tenant_id, 'tenant_w710_a');
  assert.equal(res.row.namespace, 'ns_one');
  assert.equal(res.row.trace_id, 'a'.repeat(32));
  assert.ok(res.row.id.startsWith('alq_'), 'id has alq_ prefix');
  assert.ok(Number.isFinite(res.row.enqueued_at_ms));
  assert.equal(res.row.consumed_at_ms, null);
  // Priority pulled from entropy_summary.max.
  assert.ok(Math.abs(res.row.priority - 0.9) < 1e-9);
  // Pure-student decisions are NOT eligible.
  const studentRes = enqueueFromRoutingDecision('tenant_w710_a', 'ns_one', makeDecision('student'));
  assert.equal(studentRes.ok, false);
  assert.equal(studentRes.reason, 'not_eligible');
  const queued = listQueued('tenant_w710_a', 'ns_one', 100);
  assert.equal(queued.length, 1, 'only the teacher row is queued');
  assert.equal(queued[0].route === undefined, true, 'row carries source decision, not the raw route');
  assert.equal(queued[0].source_routing_decision.route, 'teacher');
});

// =============================================================================
// 2) Tenant fence — foreign tenant gets [] even with same namespace.
// =============================================================================

test('W710 #2 — listQueued tenant-fenced against foreign tenant', async () => {
  freshDir();
  enqueueFromRoutingDecision('tenant_w710_b', 'ns_shared', makeDecision('mixed', { trace_id: 'b1'.padEnd(32, '0') }));
  enqueueFromRoutingDecision('tenant_w710_b', 'ns_shared', makeDecision('teacher', { trace_id: 'b2'.padEnd(32, '0') }));
  enqueueFromRoutingDecision('tenant_w710_c', 'ns_shared', makeDecision('teacher', { trace_id: 'c1'.padEnd(32, '0') }));
  const own = listQueued('tenant_w710_b', 'ns_shared', 100);
  assert.equal(own.length, 2);
  for (const r of own) {
    assert.equal(r.tenant, 'tenant_w710_b');
    assert.equal(r.tenant_id, 'tenant_w710_b');
  }
  // Foreign tenant, same namespace: only their own row.
  const foreign = listQueued('tenant_w710_c', 'ns_shared', 100);
  assert.equal(foreign.length, 1);
  assert.equal(foreign[0].tenant, 'tenant_w710_c');
  // Wholly unknown tenant returns [].
  const empty = listQueued('tenant_w710_nonexistent', 'ns_shared', 100);
  assert.equal(empty.length, 0);
  // No tenant at all returns [].
  assert.equal(listQueued('', 'ns_shared').length, 0);
});

// =============================================================================
// 3) consumeQueue atomicity — two parallel consumes do not double-consume.
// =============================================================================

test('W710 #3 — consumeQueue atomicity: parallel consumes do not double-consume', async () => {
  freshDir();
  for (let i = 0; i < 8; i++) {
    enqueueFromRoutingDecision('tenant_w710_d_1', 'ns_dx', makeDecision('teacher', {
      trace_id: ('d' + i).padEnd(32, '0'),
      entropy_summary: { max: 0.5 + i * 0.05, mean: 0.3, p95: 0.6 },
    }));
  }
  // Fire two consumes in the same tick. The store API is synchronous so
  // each consumeQueue() runs to completion before the other starts — the
  // second one's listQueued snapshot already reflects the first's update.
  const [a, b] = await Promise.all([
    Promise.resolve().then(() => consumeQueue('tenant_w710_d_1', 'ns_dx', 5)),
    Promise.resolve().then(() => consumeQueue('tenant_w710_d_1', 'ns_dx', 5)),
  ]);
  const allIds = [...a, ...b].map(r => r.id);
  const uniq = new Set(allIds);
  assert.equal(uniq.size, allIds.length, 'no row appears in both consumes');
  // Sum should equal 8 (the original count) since consumes drain the queue.
  // We requested 5 each (10 cap), so all 8 should be consumed across the two.
  assert.equal(allIds.length, 8, 'all 8 rows consumed across both calls');
  // All consumed rows must have status='consumed' and consumed_at_ms set.
  for (const r of [...a, ...b]) {
    assert.equal(r.status, 'consumed');
    assert.ok(Number.isFinite(r.consumed_at_ms));
  }
  // Queue should now be empty.
  assert.equal(listQueued('tenant_w710_d_1', 'ns_dx', 100).length, 0);
  // Foreign tenant cannot consume our rows.
  const foreignConsumed = consumeQueue('tenant_w710_d_2', 'ns_dx', 100);
  assert.equal(foreignConsumed.length, 0);
});

// =============================================================================
// 4) requeueStale only touches consumed rows older than threshold.
// =============================================================================

test('W710 #4 — requeueStale only re-queues stuck consumed rows', async () => {
  freshDir();
  // Enqueue + consume so we have a 'consumed' row.
  enqueueFromRoutingDecision('tenant_w710_e', 'ns_e', makeDecision('teacher', { trace_id: 'e1'.padEnd(32, '0') }));
  enqueueFromRoutingDecision('tenant_w710_e', 'ns_e', makeDecision('mixed',   { trace_id: 'e2'.padEnd(32, '0') }));
  enqueueFromRoutingDecision('tenant_w710_e', 'ns_e', makeDecision('teacher', { trace_id: 'e3'.padEnd(32, '0') }));
  const consumed = consumeQueue('tenant_w710_e', 'ns_e', 2);
  assert.equal(consumed.length, 2, 'two rows consumed');
  // Backdate one of the consumed rows so it looks stuck.
  const stuckId = consumed[0].id;
  const all = kolmStore.find(ACTIVE_LEARNING_QUEUE_TABLE, (r) => r && r.id === stuckId);
  assert.equal(all.length, 1, 'sanity: row exists');
  const past = Date.now() - 60_000;
  kolmStore.update(ACTIVE_LEARNING_QUEUE_TABLE, (r) => r && r.id === stuckId, { consumed_at_ms: past });
  // Threshold = 30 seconds. Stale row should be requeued, fresh one stays.
  const n = requeueStale('tenant_w710_e', 'ns_e', 30_000);
  assert.equal(n, 1, 'exactly one row was requeued');
  // Verify status: stuck row is now 'queued' (and consumed_at_ms cleared);
  // the other 'consumed' row is untouched.
  const updated = kolmStore.find(ACTIVE_LEARNING_QUEUE_TABLE, (r) => r && r.id === stuckId);
  assert.equal(updated[0].status, 'queued');
  assert.equal(updated[0].consumed_at_ms, null);
  const others = kolmStore.find(
    ACTIVE_LEARNING_QUEUE_TABLE,
    (r) => r && r.id === consumed[1].id,
  );
  assert.equal(others[0].status, 'consumed');
  // requeueStale must NOT touch 'dropped' rows.
  const queued = listQueued('tenant_w710_e', 'ns_e', 100);
  assert.ok(queued.length >= 1);
  dropRow('tenant_w710_e', queued[0].id);
  // Re-consume the still-queued one then backdate, and confirm dropped row
  // is never resurrected.
  const remaining = listQueued('tenant_w710_e', 'ns_e', 100);
  if (remaining.length > 0) {
    const c2 = consumeQueue('tenant_w710_e', 'ns_e', remaining.length);
    if (c2.length > 0) {
      kolmStore.update(ACTIVE_LEARNING_QUEUE_TABLE, (r) => r && r.id === c2[0].id, { consumed_at_ms: past });
    }
  }
  // Mark the dropped row's "consumed_at_ms" to past too (defensive — should still NOT requeue).
  const droppedRows = kolmStore.find(ACTIVE_LEARNING_QUEUE_TABLE, (r) => r && r.status === 'dropped' && (r.tenant === 'tenant_w710_e' || r.tenant_id === 'tenant_w710_e'));
  for (const dr of droppedRows) {
    kolmStore.update(ACTIVE_LEARNING_QUEUE_TABLE, (r) => r && r.id === dr.id, { consumed_at_ms: past });
  }
  requeueStale('tenant_w710_e', 'ns_e', 0);
  const stillDropped = kolmStore.find(ACTIVE_LEARNING_QUEUE_TABLE, (r) => r && r.status === 'dropped' && (r.tenant === 'tenant_w710_e' || r.tenant_id === 'tenant_w710_e'));
  assert.ok(stillDropped.length >= 1, 'dropped row stays dropped');
});

// =============================================================================
// 5) summarize on a mixed fixture.
// =============================================================================

test('W710 #5 — summarize math on mixed queued/consumed/dropped fixture', async () => {
  freshDir();
  // 4 queued, then consume 2, then drop 1. Final state: 1 queued, 2 consumed,
  // 1 dropped.
  const tenant = 'tenant_w710_f';
  const ns = 'ns_f';
  enqueueFromRoutingDecision(tenant, ns, makeDecision('teacher', { trace_id: 'f1'.padEnd(32, '0'), entropy_summary: { max: 0.10, mean: 0.05, p95: 0.10 } }));
  enqueueFromRoutingDecision(tenant, ns, makeDecision('teacher', { trace_id: 'f2'.padEnd(32, '0'), entropy_summary: { max: 0.20, mean: 0.10, p95: 0.20 } }));
  enqueueFromRoutingDecision(tenant, ns, makeDecision('mixed',   { trace_id: 'f3'.padEnd(32, '0'), entropy_summary: { max: 0.30, mean: 0.15, p95: 0.30 } }));
  enqueueFromRoutingDecision(tenant, ns, makeDecision('teacher', { trace_id: 'f4'.padEnd(32, '0'), entropy_summary: { max: 0.40, mean: 0.20, p95: 0.40 } }));
  // Consume top-2 (priorities 0.40 and 0.30).
  const c = consumeQueue(tenant, ns, 2);
  assert.equal(c.length, 2);
  // Drop one of the remaining queued rows.
  const remaining = listQueued(tenant, ns, 100);
  assert.equal(remaining.length, 2);
  dropRow(tenant, remaining[0].id);
  const s = summarize(tenant, ns);
  assert.equal(s.queued, 1);
  assert.equal(s.consumed, 2);
  assert.equal(s.dropped, 1);
  assert.equal(s.total, 4);
  assert.ok(s.oldest_queued_ms != null);
  // The single queued row has priority either 0.10 or 0.20 — both medians OK.
  assert.ok(s.p50_priority === 0.10 || s.p50_priority === 0.20,
    `unexpected p50 priority ${s.p50_priority}`);
  // namespace=null aggregates across all the tenant's namespaces (here, just one).
  const sAll = summarize(tenant);
  assert.equal(sAll.queued, 1);
  assert.equal(sAll.consumed, 2);
  assert.equal(sAll.dropped, 1);
});

// =============================================================================
// 6) recordRoutingDecision auto-enqueues only when route !== 'student'.
// =============================================================================

test('W710 #6 — recordRoutingDecision auto-enqueues non-student rows', async () => {
  freshDir();
  // student -> no enqueue
  await recordRoutingDecision({
    tenant_id: 'tenant_w710_g',
    namespace: 'ns_g',
    decision: { route: 'student', reason: 'low_entropy' },
  });
  let q = listQueued('tenant_w710_g', 'ns_g', 100);
  assert.equal(q.length, 0, 'student decision must NOT enqueue');
  // teacher -> enqueue
  await recordRoutingDecision({
    tenant_id: 'tenant_w710_g',
    namespace: 'ns_g',
    decision: { route: 'teacher', reason: 'high_entropy', entropy_summary: { max: 1.1, mean: 0.7, p95: 1.0 } },
  });
  q = listQueued('tenant_w710_g', 'ns_g', 100);
  assert.equal(q.length, 1, 'teacher decision auto-enqueued');
  assert.equal(q[0].source_routing_decision.route, 'teacher');
  // mixed -> enqueue
  await recordRoutingDecision({
    tenant_id: 'tenant_w710_g',
    namespace: 'ns_g',
    decision: { route: 'mixed', reason: 'mid_entropy', entropy_summary: { max: 0.8, mean: 0.4, p95: 0.7 } },
  });
  q = listQueued('tenant_w710_g', 'ns_g', 100);
  assert.equal(q.length, 2, 'mixed decision also auto-enqueued');
  // A second student call must still not bump the queue.
  await recordRoutingDecision({
    tenant_id: 'tenant_w710_g',
    namespace: 'ns_g',
    decision: { route: 'student', reason: 'low_entropy' },
  });
  q = listQueued('tenant_w710_g', 'ns_g', 100);
  assert.equal(q.length, 2);
});

// =============================================================================
// 7) CLI: --resume-from-active-queue with empty queue returns ok:true consumed:0.
// =============================================================================

test('W710 #7 — CLI --resume-from-active-queue empty queue returns ok:true consumed:0', async () => {
  const tmp = freshDir();
  // Build a config file so the CLI thinks it's logged in. Use a stub local
  // base that 401s — the CLI will hit our local KOLM_TENANT_ID env hint
  // fallback (no network), bypassing the whoami call cleanly.
  const cfgDir = path.join(tmp, '.kolm');
  fs.mkdirSync(cfgDir, { recursive: true });
  // Point the CLI at an unreachable address so the whoami call short-circuits
  // and we fall through to KOLM_TENANT_ID.
  fs.writeFileSync(
    path.join(cfgDir, 'config.json'),
    JSON.stringify({ api_key: 'ks_test_w710', base: 'http://127.0.0.1:1' }),
  );
  // Set HOME so loadConfig() picks our temp cfg.
  const env = {
    ...process.env,
    HOME: tmp,
    USERPROFILE: tmp,
    KOLM_DATA_DIR: path.join(tmp, '.kolm'),
    KOLM_TENANT_ID: 'tenant_w710_h',
    KOLM_BASE: 'http://127.0.0.1:1',
    KOLM_API_KEY: 'ks_test_w710',
  };
  const r = spawnSync(process.execPath, [CLI_PATH, 'distill', '--resume-from-active-queue', '--namespace', 'ns_empty', '--json'], {
    env, encoding: 'utf8', timeout: 30_000,
  });
  // The CLI prints the envelope to stdout. Even on a 0-exit honest envelope
  // it might be the only line, or it might be preceded by harness chatter
  // — pull the JSON tail.
  const stdout = r.stdout || '';
  // Find the JSON envelope; the CLI prints `JSON.stringify(env, null, 2)` so
  // we can pull it as the first '{' through the last '}'.
  const firstBrace = stdout.indexOf('{');
  const lastBrace = stdout.lastIndexOf('}');
  assert.ok(firstBrace >= 0 && lastBrace > firstBrace,
    `expected JSON envelope, got stdout=${stdout.slice(0, 400)} stderr=${(r.stderr || '').slice(0, 400)}`);
  const env_out = JSON.parse(stdout.slice(firstBrace, lastBrace + 1));
  assert.equal(env_out.ok, true);
  assert.equal(env_out.consumed, 0);
  assert.equal(env_out.namespace, 'ns_empty');
  assert.ok(env_out.message && /empty/i.test(env_out.message), 'envelope carries empty-queue message');
  assert.equal(r.status, 0, `expected exit 0, got ${r.status} stderr=${(r.stderr || '').slice(0, 400)}`);
});

// =============================================================================
// 8) _resetForTests clears state.
// =============================================================================

test('W710 #8 — _resetForTests clears tenant rows', async () => {
  freshDir();
  enqueueFromRoutingDecision('tenant_w710_i', 'ns_z', makeDecision('teacher', { trace_id: 'i1'.padEnd(32, '0') }));
  enqueueFromRoutingDecision('tenant_w710_i', 'ns_z', makeDecision('mixed',   { trace_id: 'i2'.padEnd(32, '0') }));
  assert.equal(listQueued('tenant_w710_i', 'ns_z', 100).length, 2);
  alqResetForTests('tenant_w710_i');
  assert.equal(listQueued('tenant_w710_i', 'ns_z', 100).length, 0);
  // Reset is tenant-scoped: another tenant's rows are untouched.
  enqueueFromRoutingDecision('tenant_w710_i', 'ns_z', makeDecision('teacher', { trace_id: 'i3'.padEnd(32, '0') }));
  enqueueFromRoutingDecision('tenant_w710_a', 'ns_z', makeDecision('teacher', { trace_id: 'a9'.padEnd(32, '0') }));
  alqResetForTests('tenant_w710_i');
  assert.equal(listQueued('tenant_w710_i', 'ns_z', 100).length, 0);
  // tenant_w710_a row should still be there.
  assert.equal(listQueued('tenant_w710_a', 'ns_z', 100).length, 1);
});
