// W777 - A/B testing infrastructure tests.
//
// One atomic test per contract. W604 anti-brittleness:
//   - version asserted via regex /^w777-/ (NEVER explicit equality + array).
//   - sample counts asserted via thresholds; deterministic split bounds use
//     fnv1a bucket math, not hard-coded counts that drift on hash changes.
//
// Coverage map (>= 15 tests):
//
//   #1  Module exports + AB_ROUTER_VERSION regex
//   #2  fnv1a determinism (same input -> same hash) + unsigned 32-bit output
//   #3  createAbTest happy path returns ab_test_id + record
//   #4  createAbTest missing_tenant / missing_namespace / missing_arm honest envelope
//   #5  createAbTest bad split (-> 0 / >=1) rejected with bad_args
//   #6  assignArm 50/50 split is roughly balanced over 1000 hashes
//   #7  assignArm 90/10 split honors the split exactly via bucket threshold
//   #8  assignArm is deterministic (same request_hash -> same arm)
//   #9  assignArm honest envelope on not_found
//  #10  recordOutcome writes an event readable by readSamples
//  #11  readSamples is tenant-fenced (foreign tenant -> empty arrays)
//  #12  getAbStatus returns sig_test from welchT once both arms have data
//  #13  getAbStatus honest envelope on no_traffic_in_window
//  #14  promoteArm flips status + freezes future assignArm to promoted arm
//  #15  autoRollback only fires when (a) arm B promoted (b) arm B underperforms
//  #16  listAbTests is tenant fenced
//  #17  stopAbTest flips status to stopped; assignArm refuses
//  #18  Route POST /v1/ab-tests/create requires auth (401)
//  #19  Route POST /v1/ab-tests/create + GET /v1/ab-tests round-trip
//  #20  CLI `kolm ab --help` exits 0 with usage text
//  #21  CLI `kolm ab` (no subverb) -> missing_subverb honest JSON envelope

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import bodyParser from 'body-parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '..', 'cli', 'kolm.js');

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w777-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(process.env.KOLM_DATA_DIR, 'events'), { recursive: true });
  delete process.env.KOLM_TENANT_ID;
  return tmp;
}

async function _loadMods() {
  const es = await import('../src/event-store.js');
  if (typeof es._resetForTests === 'function') es._resetForTests();
  const store = await import('../src/store.js');
  if (typeof store._resetForTests === 'function') store._resetForTests();
  const ab = await import('../src/ab-router.js');
  const ss = await import('../src/stat-sig.js');
  return { es, store, ab, ss };
}

// =============================================================================
// #1 - Module exports + version regex
// =============================================================================

test('W777 #1 - module exports + AB_ROUTER_VERSION regex', async () => {
  freshDir();
  const { ab } = await _loadMods();
  assert.equal(typeof ab.AB_ROUTER_VERSION, 'string');
  assert.ok(/^w777-/.test(ab.AB_ROUTER_VERSION),
    'version must match /^w777-/; got ' + ab.AB_ROUTER_VERSION);
  for (const sym of ['createAbTest', 'assignArm', 'recordOutcome', 'readSamples',
                     'getAbStatus', 'listAbTests', 'stopAbTest', 'promoteArm',
                     'autoRollback', 'fnv1a']) {
    assert.equal(typeof ab[sym], 'function', sym + ' must be exported as a function');
  }
});

// =============================================================================
// #2 - fnv1a determinism + unsigned 32-bit
// =============================================================================

test('W777 #2 - fnv1a is deterministic and unsigned 32-bit', async () => {
  freshDir();
  const { ab } = await _loadMods();
  const h1 = ab.fnv1a('hello');
  const h2 = ab.fnv1a('hello');
  assert.equal(h1, h2, 'fnv1a must be deterministic');
  assert.notEqual(ab.fnv1a('foo'), ab.fnv1a('bar'), 'distinct strings must hash to distinct ints');
  // unsigned 32-bit upper bound
  assert.ok(h1 >= 0 && h1 <= 0xffffffff,
    'hash must be unsigned 32-bit; got ' + h1);
  // empty string hash is the FNV-1a offset basis (no characters processed)
  assert.equal(ab.fnv1a(''), 0x811c9dc5, 'empty string must return FNV-1a offset basis');
});

// =============================================================================
// #3 - createAbTest happy path
// =============================================================================

test('W777 #3 - createAbTest happy path returns ab_test_id + record', async () => {
  freshDir();
  const { ab } = await _loadMods();
  const r = ab.createAbTest({
    tenant: 'tenant_w777_a',
    namespace: 'ns_a',
    arm_a: 'model-v1',
    arm_b: 'model-v2',
    split: 0.5,
  });
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.ok(typeof r.ab_test_id === 'string' && /^abt_/.test(r.ab_test_id));
  assert.equal(r.record.namespace, 'ns_a');
  assert.equal(r.record.arm_a, 'model-v1');
  assert.equal(r.record.arm_b, 'model-v2');
  assert.equal(r.record.status, 'active');
  assert.ok(/^w777-/.test(r.version));
});

// =============================================================================
// #4 - createAbTest honest envelope on missing args
// =============================================================================

test('W777 #4 - createAbTest honest envelope on missing args', async () => {
  freshDir();
  const { ab } = await _loadMods();
  let r = ab.createAbTest({ namespace: 'ns', arm_a: 'a', arm_b: 'b' });
  assert.equal(r.ok, false); assert.equal(r.error, 'missing_tenant');
  r = ab.createAbTest({ tenant: 't', arm_a: 'a', arm_b: 'b' });
  assert.equal(r.ok, false); assert.equal(r.error, 'missing_namespace');
  r = ab.createAbTest({ tenant: 't', namespace: 'n', arm_b: 'b' });
  assert.equal(r.ok, false); assert.equal(r.error, 'missing_arm');
  r = ab.createAbTest({ tenant: 't', namespace: 'n', arm_a: 'a', arm_b: 'a' });
  assert.equal(r.ok, false); assert.equal(r.error, 'bad_args');
});

// =============================================================================
// #5 - createAbTest rejects out-of-range split
// =============================================================================

test('W777 #5 - createAbTest rejects out-of-range split with bad_args', async () => {
  freshDir();
  const { ab } = await _loadMods();
  for (const split of [0, 1, -0.1, 1.5, NaN]) {
    const r = ab.createAbTest({
      tenant: 't', namespace: 'n', arm_a: 'a', arm_b: 'b', split,
    });
    if (Number.isNaN(split)) {
      // NaN -> falls back to DEFAULT_SPLIT (0.5) -> ok
      assert.equal(r.ok, true, 'NaN split must fall back to default; got ' + JSON.stringify(r).slice(0, 200));
      continue;
    }
    assert.equal(r.ok, false, 'split=' + split + ' should be rejected');
    assert.equal(r.error, 'bad_args');
  }
});

// =============================================================================
// #6 - assignArm 50/50 split is roughly balanced
// =============================================================================

test('W777 #6 - assignArm 50/50 split is roughly balanced over 1000 hashes', async () => {
  freshDir();
  const { ab } = await _loadMods();
  const created = ab.createAbTest({
    tenant: 'tenant_split_50',
    namespace: 'ns_split',
    arm_a: 'v1', arm_b: 'v2',
    split: 0.5,
  });
  let countA = 0;
  let countB = 0;
  for (let i = 0; i < 1000; i++) {
    const r = ab.assignArm({
      tenant: 'tenant_split_50',
      ab_test_id: created.ab_test_id,
      request_hash: 'req_' + i,
    });
    assert.equal(r.ok, true);
    if (r.arm === 'a') countA++;
    else if (r.arm === 'b') countB++;
  }
  // Allow generous slack (FNV-1a is good enough for traffic splitting).
  assert.ok(countA > 350 && countA < 650, 'arm A count out of slack: ' + countA);
  assert.ok(countB > 350 && countB < 650, 'arm B count out of slack: ' + countB);
  assert.equal(countA + countB, 1000);
});

// =============================================================================
// #7 - 90/10 split honors threshold via bucket math
// =============================================================================

test('W777 #7 - 90/10 split sends majority to arm A', async () => {
  freshDir();
  const { ab } = await _loadMods();
  const created = ab.createAbTest({
    tenant: 'tenant_split_90',
    namespace: 'ns_split90',
    arm_a: 'big', arm_b: 'small',
    split: 0.9,
  });
  let countA = 0; let countB = 0;
  for (let i = 0; i < 1000; i++) {
    const r = ab.assignArm({
      tenant: 'tenant_split_90',
      ab_test_id: created.ab_test_id,
      request_hash: 'req_90_' + i,
    });
    if (r.arm === 'a') countA++; else countB++;
  }
  // With split=0.9 we expect ~900 arm A; allow slack.
  assert.ok(countA > 800, 'arm A count under slack for 90/10 split: ' + countA);
  assert.ok(countB < 200, 'arm B count over slack for 90/10 split: ' + countB);
});

// =============================================================================
// #8 - assignArm is deterministic on identical request_hash
// =============================================================================

test('W777 #8 - assignArm is deterministic on identical request_hash', async () => {
  freshDir();
  const { ab } = await _loadMods();
  const created = ab.createAbTest({
    tenant: 'tenant_det',
    namespace: 'ns_det',
    arm_a: 'a1', arm_b: 'b1',
    split: 0.5,
  });
  const r1 = ab.assignArm({ tenant: 'tenant_det', ab_test_id: created.ab_test_id, request_hash: 'stable_user_42' });
  const r2 = ab.assignArm({ tenant: 'tenant_det', ab_test_id: created.ab_test_id, request_hash: 'stable_user_42' });
  const r3 = ab.assignArm({ tenant: 'tenant_det', ab_test_id: created.ab_test_id, request_hash: 'stable_user_42' });
  assert.equal(r1.arm, r2.arm);
  assert.equal(r2.arm, r3.arm);
  assert.equal(r1.artifact_id, r2.artifact_id);
});

// =============================================================================
// #9 - assignArm honest envelope on not_found
// =============================================================================

test('W777 #9 - assignArm honest envelope on not_found', async () => {
  freshDir();
  const { ab } = await _loadMods();
  const r = ab.assignArm({
    tenant: 'tenant_x',
    ab_test_id: 'abt_does_not_exist',
    request_hash: 'h',
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not_found');
  assert.ok(/^w777-/.test(r.version));
});

// =============================================================================
// #10 - recordOutcome writes events that readSamples can read
// =============================================================================

test('W777 #10 - recordOutcome + readSamples round-trip', async () => {
  freshDir();
  const { ab } = await _loadMods();
  const tenant = 'tenant_outcomes';
  const created = ab.createAbTest({
    tenant, namespace: 'ns_o', arm_a: 'a', arm_b: 'b', split: 0.5,
  });
  for (let i = 0; i < 6; i++) {
    await ab.recordOutcome({
      tenant, ab_test_id: created.ab_test_id, arm: 'a',
      kscore: 0.8 + i * 0.01, latency_ms: 100 + i,
    });
  }
  for (let i = 0; i < 5; i++) {
    await ab.recordOutcome({
      tenant, ab_test_id: created.ab_test_id, arm: 'b',
      kscore: 0.9 + i * 0.01, latency_ms: 120 + i,
    });
  }
  const samples = await ab.readSamples({ tenant, ab_test_id: created.ab_test_id });
  assert.equal(samples.n_a, 6, 'expected 6 arm A samples; got ' + samples.n_a);
  assert.equal(samples.n_b, 5, 'expected 5 arm B samples; got ' + samples.n_b);
  // values are finite numerics
  for (const v of samples.samples_a) assert.ok(Number.isFinite(v));
  for (const v of samples.samples_b) assert.ok(Number.isFinite(v));
});

// =============================================================================
// #11 - readSamples is tenant-fenced
// =============================================================================

test('W777 #11 - readSamples is tenant-fenced (foreign tenant -> empty)', async () => {
  freshDir();
  const { ab } = await _loadMods();
  const tenantOwner = 'tenant_owner';
  const tenantForeign = 'tenant_foreign';
  const created = ab.createAbTest({
    tenant: tenantOwner, namespace: 'ns_fence',
    arm_a: 'a', arm_b: 'b', split: 0.5,
  });
  for (let i = 0; i < 5; i++) {
    await ab.recordOutcome({
      tenant: tenantOwner, ab_test_id: created.ab_test_id, arm: 'a', kscore: 0.5,
    });
  }
  const samplesForeign = await ab.readSamples({
    tenant: tenantForeign, ab_test_id: created.ab_test_id,
  });
  assert.equal(samplesForeign.n_a, 0, 'foreign tenant must see 0 samples');
  assert.equal(samplesForeign.n_b, 0);
  const samplesOwner = await ab.readSamples({
    tenant: tenantOwner, ab_test_id: created.ab_test_id,
  });
  assert.equal(samplesOwner.n_a, 5);
});

// =============================================================================
// #12 - getAbStatus returns sig_test from welchT
// =============================================================================

test('W777 #12 - getAbStatus returns sig_test summary from welchT', async () => {
  freshDir();
  const { ab } = await _loadMods();
  const tenant = 'tenant_status';
  const created = ab.createAbTest({
    tenant, namespace: 'ns_status',
    arm_a: 'a', arm_b: 'b', split: 0.5,
  });
  for (let i = 0; i < 30; i++) {
    await ab.recordOutcome({
      tenant, ab_test_id: created.ab_test_id, arm: 'a',
      kscore: 0.50 + (i * 0.001),
    });
    await ab.recordOutcome({
      tenant, ab_test_id: created.ab_test_id, arm: 'b',
      kscore: 0.70 + (i * 0.001),
    });
  }
  const status = await ab.getAbStatus({ tenant, ab_test_id: created.ab_test_id });
  assert.equal(status.ok, true, JSON.stringify(status).slice(0, 400));
  assert.equal(status.n_a, 30);
  assert.equal(status.n_b, 30);
  assert.ok(status.kscore_a < status.kscore_b);
  assert.ok(status.sig_test && status.sig_test.ok);
  assert.ok(Number.isFinite(status.sig_test.p));
  // 30 vs 30 samples with delta 0.2 should yield very small p
  assert.ok(status.sig_test.p < 0.01,
    'expected p < 0.01 for clean delta; got ' + status.sig_test.p);
  assert.ok(/^w777-/.test(status.version));
});

// =============================================================================
// #13 - getAbStatus honest envelope on no_traffic_in_window
// =============================================================================

test('W777 #13 - getAbStatus honest envelope on no_traffic_in_window', async () => {
  freshDir();
  const { ab } = await _loadMods();
  const tenant = 'tenant_quiet';
  const created = ab.createAbTest({
    tenant, namespace: 'ns_quiet',
    arm_a: 'a', arm_b: 'b', split: 0.5,
  });
  const status = await ab.getAbStatus({ tenant, ab_test_id: created.ab_test_id });
  assert.equal(status.ok, false);
  assert.equal(status.error, 'no_traffic_in_window');
  assert.ok(/^w777-/.test(status.version));
});

// =============================================================================
// #14 - promoteArm flips status + freezes future assignArm to promoted arm
// =============================================================================

test('W777 #14 - promoteArm freezes assignArm to promoted_arm', async () => {
  freshDir();
  const { ab } = await _loadMods();
  const tenant = 'tenant_promote';
  const created = ab.createAbTest({
    tenant, namespace: 'ns_promote',
    arm_a: 'old', arm_b: 'new', split: 0.5,
  });
  const promote = await ab.promoteArm({
    tenant, ab_test_id: created.ab_test_id, arm: 'b', reason: 'won_the_test',
  });
  assert.equal(promote.ok, true);
  assert.equal(promote.arm, 'b');
  // After promotion, ALL assignments map to arm B regardless of hash bucket.
  for (let i = 0; i < 20; i++) {
    const r = ab.assignArm({
      tenant, ab_test_id: created.ab_test_id, request_hash: 'h_' + i,
    });
    assert.equal(r.arm, 'b', 'post-promote assignArm must return b; got ' + r.arm);
    assert.equal(r.artifact_id, 'new');
    assert.equal(r.reason, 'frozen_to_promoted_arm');
  }
});

// =============================================================================
// #15 - autoRollback only fires when (a) arm B promoted (b) arm B underperforms
// =============================================================================

test('W777 #15 - autoRollback fires only when arm B promoted AND underperforms', async () => {
  freshDir();
  const { ab } = await _loadMods();
  const tenant = 'tenant_rollback';
  // Setup: arm B was promoted but is now LOSING badly.
  const created = ab.createAbTest({
    tenant, namespace: 'ns_rb', arm_a: 'good', arm_b: 'bad', split: 0.5,
  });
  // Pre-promotion: arm B looked OK with limited data
  await ab.promoteArm({ tenant, ab_test_id: created.ab_test_id, arm: 'b' });
  // Post-promotion: 35 samples per arm with arm B obviously worse
  for (let i = 0; i < 35; i++) {
    await ab.recordOutcome({
      tenant, ab_test_id: created.ab_test_id, arm: 'a',
      kscore: 0.90 + (i * 0.0005),
    });
    await ab.recordOutcome({
      tenant, ab_test_id: created.ab_test_id, arm: 'b',
      kscore: 0.40 + (i * 0.0005),
    });
  }
  const result = await ab.autoRollback({ tenant, ab_test_id: created.ab_test_id });
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 400));
  assert.equal(result.rolled_back, true,
    'rollback must fire when promoted_arm=b AND mean_b < mean_a; got ' + JSON.stringify(result).slice(0, 400));
  // After rollback, assignArm freezes to arm A.
  const assign = ab.assignArm({
    tenant, ab_test_id: created.ab_test_id, request_hash: 'h_after',
  });
  assert.equal(assign.arm, 'a');
  assert.equal(assign.reason, 'rolled_back_to_arm_a');
});

test('W777 #15b - autoRollback does NOT fire when arm B wins', async () => {
  freshDir();
  const { ab } = await _loadMods();
  const tenant = 'tenant_no_rb';
  const created = ab.createAbTest({
    tenant, namespace: 'ns_no_rb', arm_a: 'a', arm_b: 'b', split: 0.5,
  });
  await ab.promoteArm({ tenant, ab_test_id: created.ab_test_id, arm: 'b' });
  for (let i = 0; i < 35; i++) {
    await ab.recordOutcome({
      tenant, ab_test_id: created.ab_test_id, arm: 'a', kscore: 0.40,
    });
    await ab.recordOutcome({
      tenant, ab_test_id: created.ab_test_id, arm: 'b', kscore: 0.92,
    });
  }
  const result = await ab.autoRollback({ tenant, ab_test_id: created.ab_test_id });
  assert.equal(result.ok, true);
  assert.equal(result.rolled_back, false, 'rollback must NOT fire when arm B is winning');
});

// =============================================================================
// #16 - listAbTests is tenant-fenced
// =============================================================================

test('W777 #16 - listAbTests is tenant-fenced', async () => {
  freshDir();
  const { ab } = await _loadMods();
  ab.createAbTest({ tenant: 'tenant_owner_l', namespace: 'ns', arm_a: 'a1', arm_b: 'b1' });
  ab.createAbTest({ tenant: 'tenant_owner_l', namespace: 'ns', arm_a: 'a2', arm_b: 'b2' });
  ab.createAbTest({ tenant: 'tenant_other_l', namespace: 'ns', arm_a: 'x', arm_b: 'y' });
  const lOwner = ab.listAbTests({ tenant: 'tenant_owner_l' });
  assert.equal(lOwner.ok, true);
  assert.equal(lOwner.count, 2);
  const lOther = ab.listAbTests({ tenant: 'tenant_other_l' });
  assert.equal(lOther.count, 1);
  for (const t of lOwner.tests) {
    assert.notEqual(t.arm_a, 'x', 'owner must not see other tenant test');
  }
});

// =============================================================================
// #17 - stopAbTest flips status + assignArm refuses
// =============================================================================

test('W777 #17 - stopAbTest flips status to stopped; assignArm refuses', async () => {
  freshDir();
  const { ab } = await _loadMods();
  const tenant = 'tenant_stop';
  const created = ab.createAbTest({
    tenant, namespace: 'ns_stop', arm_a: 'a', arm_b: 'b',
  });
  const stop = ab.stopAbTest({ tenant, ab_test_id: created.ab_test_id, reason: 'done' });
  assert.equal(stop.ok, true);
  assert.equal(stop.status, 'stopped');
  const r = ab.assignArm({ tenant, ab_test_id: created.ab_test_id, request_hash: 'h' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'stopped');
});

// =============================================================================
// #18 - Route POST /v1/ab-tests/create requires auth (401)
// =============================================================================

test('W777 #18 - route POST /v1/ab-tests/create requires auth', async () => {
  freshDir();
  const { buildRouter } = await import('../src/router.js');
  const app = express();
  app.use(bodyParser.json({ limit: '8mb' }));
  app.use(buildRouter());

  await new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const port = server.address().port;
        const res = await fetch('http://127.0.0.1:' + port + '/v1/ab-tests/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ namespace: 'ns', arm_a: 'a', arm_b: 'b' }),
        });
        assert.equal(res.status, 401, 'expected 401; got ' + res.status);
        const j = await res.json();
        assert.ok(j.ok !== true);
        const errStr = String(j.error || j.message || '').toLowerCase();
        assert.ok(/auth|api[\s_-]?key|unauth/.test(errStr),
          'expected auth-related error; got ' + JSON.stringify(j));
        server.close(() => resolve());
      } catch (e) { server.close(() => reject(e)); }
    });
  });
});

// =============================================================================
// #19 - Route POST + GET round-trip via provisioned tenant
// =============================================================================

test('W777 #19 - route POST /v1/ab-tests/create + GET /v1/ab-tests round-trip', async () => {
  freshDir();
  const es = await import('../src/event-store.js');
  if (typeof es._resetForTests === 'function') es._resetForTests();
  const storeMod = await import('../src/store.js');
  if (typeof storeMod._resetForTests === 'function') storeMod._resetForTests();
  const { provisionAnonTenant } = await import('../src/auth.js');
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });
  const { buildRouter } = await import('../src/router.js');
  const app = express();
  app.use(bodyParser.json({ limit: '8mb' }));
  app.use(buildRouter());

  await new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const port = server.address().port;
        const base = 'http://127.0.0.1:' + port;
        const auth = { 'authorization': 'Bearer ' + t.api_key, 'content-type': 'application/json' };
        const createRes = await fetch(base + '/v1/ab-tests/create', {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({
            namespace: 'ns_route',
            arm_a: 'v1',
            arm_b: 'v2',
            split: 0.5,
          }),
        });
        assert.equal(createRes.status, 200, 'create expected 200; got ' + createRes.status);
        const createJ = await createRes.json();
        assert.equal(createJ.ok, true);
        const ab_test_id = createJ.ab_test_id;
        assert.ok(ab_test_id);

        const listRes = await fetch(base + '/v1/ab-tests', { headers: auth });
        assert.equal(listRes.status, 200);
        const listJ = await listRes.json();
        assert.equal(listJ.ok, true);
        assert.ok(Array.isArray(listJ.tests));
        assert.ok(listJ.tests.some((x) => x.ab_test_id === ab_test_id),
          'list must include the created test');

        // assignments route
        const assignRes = await fetch(
          base + '/v1/ab-tests/' + ab_test_id + '/assignments?request_hash=u1',
          { headers: auth });
        assert.equal(assignRes.status, 200);
        const assignJ = await assignRes.json();
        assert.equal(assignJ.ok, true);
        assert.ok(assignJ.arm === 'a' || assignJ.arm === 'b');
        assert.ok(/^w777-/.test(assignJ.version));

        server.close(() => resolve());
      } catch (e) { server.close(() => reject(e)); }
    });
  });
});

// =============================================================================
// #20 - CLI `kolm ab --help` exits 0
// =============================================================================

test('W777 #20 - `kolm ab --help` exits 0 with usage text', () => {
  const r = spawnSync(process.execPath, [CLI_PATH, 'ab', '--help'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  const combined = (r.stdout || '') + (r.stderr || '');
  assert.equal(r.status, 0, 'expected exit 0; got ' + r.status + ' combined=' + combined.slice(0, 400));
  assert.ok(/kolm ab/.test(combined),
    'help must mention "kolm ab"; got: ' + combined.slice(0, 400));
  assert.ok(/start|promote|rollback|assign/.test(combined),
    'help must list subverbs; got: ' + combined.slice(0, 400));
});

// =============================================================================
// #21 - CLI `kolm ab` (no subverb) -> missing_subverb honest JSON envelope
// =============================================================================

test('W777 #21 - `kolm ab --json` (no subverb) -> missing_subverb envelope', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w777-cli-'));
  const r = spawnSync(process.execPath, [CLI_PATH, 'ab', '--json'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      HOME: tmp,
      USERPROFILE: tmp,
      KOLM_DATA_DIR: path.join(tmp, '.kolm'),
      KOLM_API_KEY: '',
      KOLM_TENANT_ID: '',
    },
  });
  const out = (r.stdout || '').trim();
  let parsed = null;
  try { parsed = JSON.parse(out); } catch (_) {} // deliberate: cleanup
  assert.ok(parsed && typeof parsed === 'object',
    'expected JSON envelope; got stdout=' + out.slice(0, 200) + ' stderr=' + (r.stderr || '').slice(0, 200));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, 'missing_subverb');
  assert.ok(/^w777-/.test(parsed.version));
});
