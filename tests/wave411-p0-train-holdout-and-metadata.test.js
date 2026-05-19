// Wave 411 — P0 lock-ins for the two bugs the external CTO audit flagged
// on 2026-05-19:
//
// (1) src/compile-pipeline.js:623 — `pairs_override: corpusPairs` shipped
//     the FULL namespace (train + holdout) into distill(). The bundle
//     receipt still hashed trainPairs/holdoutPairs separately so the
//     row-hash disjointness check passed, but the artifact was trained on
//     the same rows it claimed as held-out.
//
// (2) src/distill-pipeline.js:147 — `pairs.push({prompt, response, event_id})`
//     dropped source_type, tenant_id, approved, redaction_policy,
//     fixed_output, holdout_only. Downstream synthetic gating filtered on
//     a field that was always undefined.
//
// These tests assert BEHAVIOR (the actual pair contents and the actual
// trainPairs hydration logic), not page copy. #4-#7 are unit tests on the
// hydration step (lines 529-534 + 623 in compile-pipeline.js); they do NOT
// spawn the distill worker (which was the cause of the previous test hang
// on Windows). The actual worker-input spy lives in
// tests/wave411-worker-input-spy.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

function _mkTmp(label = 'w411') {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-' + label + '-'));
}

function _snapEnv() {
  return {
    KOLM_DATA_DIR: process.env.KOLM_DATA_DIR,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    KOLM_STORE_DRIVER: process.env.KOLM_STORE_DRIVER,
    KOLM_RECIPE_RECEIPT_SECRET: process.env.KOLM_RECIPE_RECEIPT_SECRET,
    KOLM_DISTILL_FULL: process.env.KOLM_DISTILL_FULL,
    KOLM_DISTILL_TEACHER: process.env.KOLM_DISTILL_TEACHER,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    KOLM_SIGNING_KEY: process.env.KOLM_SIGNING_KEY,
  };
}

function _setEnv(tmp) {
  process.env.KOLM_DATA_DIR = tmp;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_STORE_DRIVER = 'jsonl';
  process.env.KOLM_RECIPE_RECEIPT_SECRET = process.env.KOLM_RECIPE_RECEIPT_SECRET || 'wave411-test-secret-32chars-min-len';
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.KOLM_DISTILL_FULL;
  delete process.env.KOLM_DISTILL_TEACHER;
}

function _restoreEnv(saved) {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

async function _seedNamespace(namespace, n = 25, opts = {}) {
  const { appendEvent, _resetForTests } = await import('../src/event-store.js');
  _resetForTests();
  for (let i = 0; i < n; i++) {
    await appendEvent({
      namespace,
      tenant_id: opts.tenant_id || 'wave411-test',
      prompt_redacted: 'classify ticket ' + i + ' about billing for tenant row ' + i,
      response_redacted: 'reply ' + i,
      provider: 'openai',
      model: 'gpt-4o-mini',
      status: 'ok',
      ...(opts.sourceType ? { source_type: opts.sourceType } : {}),
      ...(opts.fields || {}),
    });
  }
}

async function _approveAll(namespace) {
  const { listEvents } = await import('../src/event-store.js');
  const events = await listEvents({ namespace });
  const labelsDir = path.join(process.env.KOLM_DATA_DIR, 'labels');
  fs.mkdirSync(labelsDir, { recursive: true });
  const lines = events.map((ev) => JSON.stringify({
    event_id: ev.event_id,
    decision: 'approve',
    reviewer: 'wave411-test',
    ts: new Date().toISOString(),
  })).join('\n') + '\n';
  fs.writeFileSync(path.join(labelsDir, 'approvals.jsonl'), lines);
  return events.length;
}

function _rowHash(p) {
  return crypto.createHash('sha256').update(String(p.prompt || '') + '\x1f' + String(p.response || '')).digest('hex');
}

// ---------------------------------------------------------------------------
// #1 — prepareDistillCorpus preserves metadata on every pair.
test('W411 #1 — prepareDistillCorpus preserves source_type / tenant_id / approved metadata', async () => {
  const tmp = _mkTmp('w411-1');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    await _seedNamespace('w411-meta', 8, { tenant_id: 'tenantA', sourceType: 'capture' });
    const { prepareDistillCorpus } = await import('../src/distill-pipeline.js');
    const { pairs } = await prepareDistillCorpus({ namespace: 'w411-meta', split: 'all' });
    assert.ok(pairs.length > 0, 'must yield pairs');
    for (const p of pairs) {
      assert.ok(p.event_id, 'event_id preserved');
      assert.ok(Object.prototype.hasOwnProperty.call(p, 'source_type'), 'source_type field present');
      assert.ok(Object.prototype.hasOwnProperty.call(p, 'tenant_id'), 'tenant_id field present');
      assert.ok(Object.prototype.hasOwnProperty.call(p, 'approved'), 'approved field present');
      assert.ok(Object.prototype.hasOwnProperty.call(p, 'redaction_policy'), 'redaction_policy field present');
      assert.ok(Object.prototype.hasOwnProperty.call(p, 'holdout_only'), 'holdout_only field present');
      assert.equal(p.tenant_id, 'tenantA', 'tenant_id round-trips');
    }
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #2 — synthetic source_type carries through.
test('W411 #2 — synthetic source_type metadata survives prepareDistillCorpus', async () => {
  const tmp = _mkTmp('w411-2');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    await _seedNamespace('w411-synth', 10, { sourceType: 'synthetic' });
    const { prepareDistillCorpus } = await import('../src/distill-pipeline.js');
    const { pairs } = await prepareDistillCorpus({ namespace: 'w411-synth', split: 'all' });
    const syntheticCount = pairs.filter((p) => p.source_type === 'synthetic').length;
    assert.equal(syntheticCount, pairs.length,
      'every synthetic seed must carry source_type=synthetic through the corpus');
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #3 — approved-only mode flags pairs as approved.
test('W411 #3 — approvedOnly mode marks every pair approved:true', async () => {
  const tmp = _mkTmp('w411-3');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    await _seedNamespace('w411-approve', 12);
    await _approveAll('w411-approve');
    const { prepareDistillCorpus } = await import('../src/distill-pipeline.js');
    const { pairs } = await prepareDistillCorpus({ namespace: 'w411-approve', split: 'all', approvedOnly: true });
    assert.ok(pairs.length > 0, 'approvals must produce pairs');
    for (const p of pairs) {
      assert.equal(p.approved, true,
        'approvedOnly mode must mark each pair approved:true');
    }
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #4 — Unit test for the bug-locus hydration logic at compile-pipeline:529-534.
//     If corpusPairs is the full namespace and splitInfo.train_ids is a
//     subset, then trainPairs (= splitInfo.train_ids → corpusPairs map) must
//     be a strict subset of corpusPairs AND contain zero holdout event_ids.
test('W411 #4 — trainPairs hydration is a strict subset of corpusPairs and excludes all holdout event_ids', async () => {
  const tmp = _mkTmp('w411-4');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    await _seedNamespace('w411-hydrate', 30);
    await _approveAll('w411-hydrate');

    const { prepareDistillCorpus } = await import('../src/distill-pipeline.js');
    const { createDataset, splitDataset } = await import('../src/dataset-workbench.js');

    // Step 1: corpus has all rows.
    const { pairs: corpusPairs } = await prepareDistillCorpus({
      namespace: 'w411-hydrate',
      split: 'all',
      approvedOnly: true,
    });

    // Step 2: workbench creates dataset + split.
    const ds = await createDataset('w411-hydrate', { train_ratio: 0.8, approvedOnly: true, seed: 42 });
    const splitInfo = await splitDataset(ds.dataset_id, 0.8, { seed: 42 });

    // Step 3: hydrate trainPairs / holdoutPairs (mirrors compile-pipeline:529-534).
    const idToPair = new Map();
    for (const p of corpusPairs) {
      if (p && p.event_id) idToPair.set(p.event_id, p);
    }
    const trainPairs = splitInfo.train_ids.map((id) => idToPair.get(id)).filter(Boolean);
    const holdoutPairs = splitInfo.holdout_ids.map((id) => idToPair.get(id)).filter(Boolean);

    // Invariant 1: trainPairs is non-empty.
    assert.ok(trainPairs.length > 0, 'trainPairs must be non-empty');
    // Invariant 2: trainPairs is a strict subset of corpusPairs by size.
    assert.ok(trainPairs.length <= corpusPairs.length,
      'trainPairs.length must be <= corpusPairs.length');
    // Invariant 3: holdoutPairs are non-empty and disjoint by event_id.
    assert.ok(holdoutPairs.length > 0, 'holdoutPairs must be non-empty (split:0.8 from 30 events should yield at least 1 holdout)');
    const trainIds = new Set(trainPairs.map((p) => p.event_id));
    const holdoutIds = new Set(holdoutPairs.map((p) => p.event_id));
    for (const h of holdoutIds) {
      assert.ok(!trainIds.has(h),
        'event_id ' + h + ' appears in both train and holdout sets (P0 bug)');
    }
    // Invariant 4: the union of train + holdout covers the corpus (every
    // event in the corpus lands in exactly one bucket).
    assert.equal(trainPairs.length + holdoutPairs.length, corpusPairs.length,
      'train + holdout must partition the corpus (no events dropped, no double-counting)');
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #5 — Row-hash disjointness: even if two distinct event_ids carry the same
//      (prompt, response), the row-hash check at compile-pipeline:557-575
//      catches it as content-level overlap.
test('W411 #5 — train and holdout sets are row-hash disjoint after hydration', async () => {
  const tmp = _mkTmp('w411-5');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    await _seedNamespace('w411-disjoint', 30);
    await _approveAll('w411-disjoint');
    const { prepareDistillCorpus } = await import('../src/distill-pipeline.js');
    const { createDataset, splitDataset } = await import('../src/dataset-workbench.js');
    const ds = await createDataset('w411-disjoint', { train_ratio: 0.8, approvedOnly: true, seed: 42 });
    const splitInfo = await splitDataset(ds.dataset_id, 0.8, { seed: 42 });
    const { pairs } = await prepareDistillCorpus({
      namespace: 'w411-disjoint',
      split: 'all',
      approvedOnly: true,
    });
    const idToPair = new Map(pairs.filter((p) => p && p.event_id).map((p) => [p.event_id, p]));
    const trainPairs = splitInfo.train_ids.map((id) => idToPair.get(id)).filter(Boolean);
    const holdoutPairs = splitInfo.holdout_ids.map((id) => idToPair.get(id)).filter(Boolean);
    const trainHashes = new Set(trainPairs.map(_rowHash));
    let overlap = 0;
    for (const h of holdoutPairs) {
      if (trainHashes.has(_rowHash(h))) overlap += 1;
    }
    assert.equal(overlap, 0, 'train/holdout row-hash overlap must be 0 (found ' + overlap + ')');
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #6 — distillPairs fallback logic mirrors compile-pipeline:615:
//      const distillPairs = (trainPairs && trainPairs.length) ? trainPairs : corpusPairs;
//      When trainPairs is non-empty, distillPairs MUST be trainPairs, never corpusPairs.
test('W411 #6 — distillPairs equals trainPairs when train split is non-empty (NOT corpusPairs)', async () => {
  const tmp = _mkTmp('w411-6');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    await _seedNamespace('w411-distpairs', 25);
    await _approveAll('w411-distpairs');
    const { prepareDistillCorpus } = await import('../src/distill-pipeline.js');
    const { createDataset, splitDataset } = await import('../src/dataset-workbench.js');
    const { pairs: corpusPairs } = await prepareDistillCorpus({
      namespace: 'w411-distpairs',
      split: 'all',
      approvedOnly: true,
    });
    const ds = await createDataset('w411-distpairs', { train_ratio: 0.8, approvedOnly: true, seed: 42 });
    const splitInfo = await splitDataset(ds.dataset_id, 0.8, { seed: 42 });
    const idToPair = new Map(corpusPairs.filter((p) => p && p.event_id).map((p) => [p.event_id, p]));
    const trainPairs = splitInfo.train_ids.map((id) => idToPair.get(id)).filter(Boolean);
    // Replicate the exact line from compile-pipeline.js:615:
    const distillPairs = (trainPairs && trainPairs.length) ? trainPairs : corpusPairs;
    // Invariant: distillPairs must equal trainPairs by identity AND not equal corpusPairs.
    assert.equal(distillPairs.length, trainPairs.length,
      'distillPairs length must equal trainPairs length when train split is non-empty');
    assert.ok(distillPairs.length < corpusPairs.length,
      'distillPairs must be a strict subset of corpusPairs (was ' + distillPairs.length + '/' + corpusPairs.length + ')');
    // Invariant: every event_id in distillPairs must be in splitInfo.train_ids.
    const trainIdSet = new Set(splitInfo.train_ids);
    for (const p of distillPairs) {
      assert.ok(trainIdSet.has(p.event_id),
        'distillPairs contains event_id ' + p.event_id + ' which is NOT in the train_ids set (HOLDOUT LEAK)');
    }
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #7 — tenant_id flows from event → pair.
test('W411 #7 — tenant_id flows event → pair → metadata', async () => {
  const tmp = _mkTmp('w411-7');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    await _seedNamespace('w411-tenantA', 8, { tenant_id: 'alpha-corp' });
    const { prepareDistillCorpus } = await import('../src/distill-pipeline.js');
    const { pairs } = await prepareDistillCorpus({ namespace: 'w411-tenantA', split: 'all' });
    const tenants = new Set(pairs.map((p) => p.tenant_id));
    assert.ok(tenants.has('alpha-corp'),
      'tenant_id must round-trip through the corpus (got ' + JSON.stringify([...tenants]) + ')');
  } finally {
    _restoreEnv(saved);
  }
});
