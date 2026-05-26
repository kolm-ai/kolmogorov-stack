// W411 — Event-store JSONL dedupe by event_id + holdout enforcement at every
// consumer + row-hash dedupe before split. Behavior-only assertions, isolated
// per-test tmpdirs, ESM imports.
//
// Lock-ins:
//   1. appendEvent(same event_id) → listEvents returns exactly 1 row.
//   2. prepareDistillCorpus split='train' drops every holdout_only event.
//   3. createDataset deduplicates by (prompt, response) row hash before split.
//   4. Bundle phase emits holdout_excluded_count + row_hash_dedupe_count.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function mkTmp(label = 'w411-dedupe') {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-' + label + '-'));
}

function snapEnv() {
  return {
    KOLM_DATA_DIR: process.env.KOLM_DATA_DIR,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    KOLM_STORE_DRIVER: process.env.KOLM_STORE_DRIVER,
    KOLM_EVENT_STORE_PATH: process.env.KOLM_EVENT_STORE_PATH,
    KOLM_RECIPE_RECEIPT_SECRET: process.env.KOLM_RECIPE_RECEIPT_SECRET,
    KOLM_DISTILL_FULL: process.env.KOLM_DISTILL_FULL,
    KOLM_DISTILL_TEACHER: process.env.KOLM_DISTILL_TEACHER,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    KOLM_SIGNING_KEY: process.env.KOLM_SIGNING_KEY,
  };
}

function setEnv(tmp) {
  // KOLM_DATA_DIR is the base dir itself (not a parent of .kolm/).
  process.env.KOLM_DATA_DIR = tmp;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  // Best-effort JSONL hint — the dedupe behavior is identical under both
  // SQLite (INSERT OR REPLACE) and JSONL (read-modify-write fallback), so
  // the test does NOT assert the driver name; it asserts the user-observable
  // outcome (listEvents returns one row).
  process.env.KOLM_STORE_DRIVER = 'jsonl';
  process.env.KOLM_RECIPE_RECEIPT_SECRET = process.env.KOLM_RECIPE_RECEIPT_SECRET || 'wave411-dedupe-secret-32chars-min';
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.KOLM_DISTILL_FULL;
  delete process.env.KOLM_DISTILL_TEACHER;
  delete process.env.KOLM_SIGNING_KEY;
}

function restoreEnv(saved) {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

// Forces the JSONL driver: removes a stale sqlite file from previous tmp
// before each test and resets the module singleton so the driver re-picks.
async function _hardResetEventStore() {
  const es = await import('../src/event-store.js');
  if (es._resetForTests) es._resetForTests();
}

// ---------------------------------------------------------------------------
// #1 — Same event_id appended twice → listEvents returns 1 row.
test('W411 dedupe #1 — JSONL event-store dedupes by event_id', async () => {
  const saved = snapEnv();
  const tmp = mkTmp('w411-d1');
  try {
    setEnv(tmp);
    await _hardResetEventStore();
    const { appendEvent, listEvents } = await import('../src/event-store.js');
    // Dedupe semantics are identical under SQLite (INSERT OR REPLACE) and
    // JSONL (read-modify-write); we assert behavior, not driver.

    const eid = 'evt_w411_dup_lock';
    await appendEvent({
      event_id: eid,
      namespace: 'w411-dup',
      tenant_id: 't1',
      prompt_redacted: 'hello prompt',
      response_redacted: 'first response',
      provider: 'openai',
      model: 'gpt-4o-mini',
      status: 'ok',
    });
    // Re-emit the SAME event_id with a different response. Expected: the
    // store treats this as an update (last-write-wins), not a second row.
    await appendEvent({
      event_id: eid,
      namespace: 'w411-dup',
      tenant_id: 't1',
      prompt_redacted: 'hello prompt',
      response_redacted: 'second response (overwrites first)',
      provider: 'openai',
      model: 'gpt-4o-mini',
      status: 'ok',
    });
    // And a third dupe to be sure the dedupe is iterative.
    await appendEvent({
      event_id: eid,
      namespace: 'w411-dup',
      tenant_id: 't1',
      prompt_redacted: 'hello prompt',
      response_redacted: 'third response (final)',
      provider: 'openai',
      model: 'gpt-4o-mini',
      status: 'ok',
    });

    const rows = await listEvents({ namespace: 'w411-dup' });
    assert.equal(rows.length, 1,
      'listEvents must return exactly 1 row (got ' + rows.length + ') for a thrice-appended event_id');
    assert.equal(rows[0].event_id, eid, 'returned event_id mismatch');
    // last-write-wins semantics: latest response should be visible.
    assert.match(rows[0].response_redacted, /third response/,
      'last-write-wins: latest append must overwrite earlier appends');
  } finally {
    restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #2 — 20 events, 10 with holdout_only=true → prepareDistillCorpus
//      split='train' returns <=10 rows AND no row has holdout_only=true.
test('W411 dedupe #2 — prepareDistillCorpus split=train filters holdout_only rows', async () => {
  const saved = snapEnv();
  const tmp = mkTmp('w411-d2');
  try {
    setEnv(tmp);
    await _hardResetEventStore();
    const { appendEvent } = await import('../src/event-store.js');
    const ns = 'w411-holdout-filter';
    // Seed 20 events. Even-index rows are marked holdout_only=true.
    for (let i = 0; i < 20; i++) {
      await appendEvent({
        event_id: 'evt_w411_ho_' + i,
        namespace: ns,
        tenant_id: 't1',
        prompt_redacted: 'prompt unique number ' + i,
        response_redacted: 'response number ' + i,
        provider: 'openai',
        model: 'gpt-4o-mini',
        status: 'ok',
        holdout_only: i % 2 === 0,
      });
    }
    const { prepareDistillCorpus } = await import('../src/distill-pipeline.js');
    const { pairs: trainPairs, stats } = await prepareDistillCorpus({ namespace: ns, split: 'train' });
    // No holdout_only must appear in the train split.
    for (const p of trainPairs) {
      assert.ok(p.holdout_only !== true,
        'pair ' + p.event_id + ' is holdout_only but landed in train split');
    }
    // The original 20-row corpus has 10 holdout_only. Train split with the
    // existing 4/5 modulo bucket would normally yield ~16 rows; after the
    // holdout_only strip we expect <= 10 rows (since 10 were flagged).
    assert.ok(trainPairs.length <= 10,
      'train split must contain <=10 rows after holdout_only strip (got ' + trainPairs.length + ')');
    // The stats envelope must surface the new counter.
    assert.ok(typeof stats.holdout_excluded_from_train === 'number',
      'stats must carry holdout_excluded_from_train counter');
    assert.ok(stats.holdout_excluded_from_train > 0,
      'holdout_excluded_from_train must be > 0 when holdout_only rows existed');
  } finally {
    restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #3 — 100 events with 5 unique (prompt, response) pairs → createDataset
//      dedupes to 5 → 80/20 split is 4/1, no row-hash overlap.
test('W411 dedupe #3 — createDataset dedupes by row hash before split', async () => {
  const saved = snapEnv();
  const tmp = mkTmp('w411-d3');
  try {
    setEnv(tmp);
    await _hardResetEventStore();
    const { appendEvent } = await import('../src/event-store.js');
    const ns = 'w411-rowhash-dedupe';
    // Seed 100 events covering 5 unique (prompt, response) pairs (20 dups each).
    const UNIQUE_PAIRS = 5;
    const COPIES = 20;
    for (let g = 0; g < UNIQUE_PAIRS; g++) {
      for (let c = 0; c < COPIES; c++) {
        await appendEvent({
          event_id: 'evt_w411_rh_' + g + '_' + c,
          namespace: ns,
          tenant_id: 't1',
          prompt_redacted: 'group ' + g + ' canonical prompt',
          response_redacted: 'group ' + g + ' canonical response',
          provider: 'openai',
          model: 'gpt-4o-mini',
          status: 'ok',
        });
      }
    }
    const { createDataset, splitDataset } = await import('../src/dataset-workbench.js');
    const ds = await createDataset(ns, { train_ratio: 0.8, seed: 411 });
    // After row-hash dedupe, exactly 5 unique rows survive.
    assert.equal(ds.source_event_ids.length, UNIQUE_PAIRS,
      'createDataset must dedupe by row hash to ' + UNIQUE_PAIRS + ' unique rows (got ' + ds.source_event_ids.length + ')');
    assert.equal(ds.row_hash_dedupe_count, 100 - UNIQUE_PAIRS,
      'row_hash_dedupe_count must equal total-unique (got ' + ds.row_hash_dedupe_count + ')');
    // 5 rows split 80/20 -> 4 train + 1 holdout. Allow off-by-one for hash
    // bucket boundary (could be 3/2 or 5/0 depending on seed).
    const split = await splitDataset(ds.dataset_id, 0.8, { seed: 411 });
    assert.equal(split.train_count + split.holdout_count, UNIQUE_PAIRS,
      'train + holdout must sum to ' + UNIQUE_PAIRS);
    // Disjointness on row-hash AND identity.
    const trainSet = new Set(split.train_ids);
    let overlap = 0;
    for (const id of split.holdout_ids) {
      if (trainSet.has(id)) overlap += 1;
    }
    assert.equal(overlap, 0, 'train/holdout must be id-disjoint');
    // Also confirm content uniqueness (since deduped, identity-disjoint
    // implies content-disjoint, but assert it directly to lock in the seam).
    const crypto = await import('node:crypto');
    const { getEvent } = await import('../src/event-store.js');
    const trainHashes = new Set();
    for (const id of split.train_ids) {
      const e = await getEvent(id);
      if (!e) continue;
      const h = crypto.createHash('sha256').update((e.prompt_redacted || '') + '\x1f' + (e.response_redacted || '')).digest('hex');
      trainHashes.add(h);
    }
    let rowOverlap = 0;
    for (const id of split.holdout_ids) {
      const e = await getEvent(id);
      if (!e) continue;
      const h = crypto.createHash('sha256').update((e.prompt_redacted || '') + '\x1f' + (e.response_redacted || '')).digest('hex');
      if (trainHashes.has(h)) rowOverlap += 1;
    }
    assert.equal(rowOverlap, 0, 'train/holdout must be content-disjoint after dedupe');
  } finally {
    restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #4 — distill() refuses holdout_only rows in pairs_override. We assert the
// filter behavior by inspecting the seeds.jsonl the worker would have been
// fed (which distill() writes to runDir BEFORE the spawn). This avoids the
// W381 #16 detached-spawn flake on Windows under the test runner — we don't
// need to await the worker to verify the chokepoint.
test('W411 dedupe #4 — distill() drops holdout_only from pairs_override (seeds.jsonl probe)', async () => {
  const saved = snapEnv();
  const tmp = mkTmp('w411-d4');
  try {
    setEnv(tmp);
    await _hardResetEventStore();
    const distillMod = await import('../src/distill-pipeline.js');
    // Hand-build a pairs_override with a mix of normal and holdout_only rows.
    const pairs = [];
    for (let i = 0; i < 10; i++) {
      pairs.push({
        prompt: 'p ' + i,
        response: 'r ' + i,
        event_id: 'evt_w411_d4_' + i,
        holdout_only: i < 4, // first 4 are holdout_only
      });
    }
    // Drive the iterator just past the first yield by reading one tick. With
    // emit_progress_every=0 the iterator skips the progress loop and goes
    // straight to awaiting the worker exit, so the seeds.jsonl has been
    // written by then. We don't `for await` the whole thing — we sample the
    // disk after triggering the spawn, then dispose of the iterator.
    const iter = distillMod.distill({
      student_base: 'qwen-0.5b',
      pairs_override: pairs,
      emit_progress_every: 0,
      max_steps: 1,
    });
    // Calling .next() once kicks off the function body up to the first yield
    // (which won't fire because emit_progress_every=0 and the next yield is
    // the post-await done event). The seeds.jsonl write completes BEFORE the
    // await so we can read it now.
    const nextPromise = iter.next();
    // Wait one macrotask so the spawn + seeds write have actually flushed.
    await new Promise((r) => setTimeout(r, 50));
    // The runDir is under KOLM_DATA_DIR/distill-runs/.
    const runsRoot = path.join(tmp, 'distill-runs');
    assert.ok(fs.existsSync(runsRoot),
      'distill-runs dir must exist after distill() spawn (was ' + runsRoot + ')');
    const runs = fs.readdirSync(runsRoot).sort();
    assert.ok(runs.length >= 1, 'at least one run dir must exist');
    const latest = runs[runs.length - 1];
    const seedsPath = path.join(runsRoot, latest, 'seeds.jsonl');
    assert.ok(fs.existsSync(seedsPath), 'seeds.jsonl must exist at ' + seedsPath);
    const seedLines = fs.readFileSync(seedsPath, 'utf8').split('\n').filter(Boolean);
    assert.equal(seedLines.length, 6,
      'seeds.jsonl must contain 6 rows after holdout_only strip (got ' + seedLines.length + ')');
    // Verify none of the seeded rows reference the holdout_only event_ids.
    for (const ln of seedLines) {
      const r = JSON.parse(ln);
      assert.ok(
        !['evt_w411_d4_0', 'evt_w411_d4_1', 'evt_w411_d4_2', 'evt_w411_d4_3'].includes(r.id),
        'holdout_only event ' + r.id + ' leaked into seeds.jsonl',
      );
    }
    // Dispose of the iterator so the worker spawn doesn't keep the test alive.
    // The detached child is unref'd, so we don't need to wait on it.
    if (typeof iter.return === 'function') {
      try { await Promise.race([iter.return(), new Promise((r) => setTimeout(r, 100))]); } catch {} // deliberate: cleanup
    }
    // Best-effort consume the in-flight next() so the GC can reclaim it.
    try { await Promise.race([nextPromise, new Promise((r) => setTimeout(r, 100))]); } catch {} // deliberate: cleanup
  } finally {
    restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #5 — Verify the bundle phase emits the row_hash_dedupe_count counter via
// the dataset record audit field (the same number is forwarded into the
// seed_provenance receipt by compile-pipeline.js). We use the workbench
// directly to avoid the W381 detached-spawn flake.
test('W411 dedupe #5 — dataset record carries row_hash_dedupe_count audit field', async () => {
  const saved = snapEnv();
  const tmp = mkTmp('w411-d5');
  try {
    setEnv(tmp);
    await _hardResetEventStore();
    const { appendEvent } = await import('../src/event-store.js');
    const ns = 'w411-bundle-counters';
    // Seed 30 events with 6 unique pairs (5 copies each) so dedupe trims 24.
    for (let g = 0; g < 6; g++) {
      for (let c = 0; c < 5; c++) {
        await appendEvent({
          event_id: 'evt_w411_d5_' + g + '_' + c,
          namespace: ns,
          tenant_id: 't1',
          prompt_redacted: 'group ' + g + ' prompt',
          response_redacted: 'group ' + g + ' response',
          provider: 'openai',
          model: 'gpt-4o-mini',
          status: 'ok',
        });
      }
    }
    const { createDataset } = await import('../src/dataset-workbench.js');
    const ds = await createDataset(ns, { train_ratio: 0.8, seed: 411 });
    // The dataset record on disk MUST carry the row_hash_dedupe_count audit.
    const recordPath = path.join(tmp, 'datasets', ds.dataset_id + '.json');
    assert.ok(fs.existsSync(recordPath), 'dataset record file must exist');
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    assert.equal(typeof record.row_hash_dedupe_count, 'number',
      'record must carry row_hash_dedupe_count field');
    assert.equal(record.row_hash_dedupe_count, 24,
      'row_hash_dedupe_count must be 24 for the 30→6 collapse (got ' + record.row_hash_dedupe_count + ')');
    // And the createDataset return envelope mirrors it.
    assert.equal(ds.row_hash_dedupe_count, 24,
      'createDataset return must mirror row_hash_dedupe_count');
    // The bundle phase (compile-pipeline.js _bundlePhase) reads this value
    // from splitInfo.row_hash_dedupe_count which compileFull copies from
    // ds.row_hash_dedupe_count at the dataset_split phase. We assert the
    // wire-up by inspecting the compile-pipeline source: it must reference
    // both `holdout_excluded_count` and `row_hash_dedupe_count`.
    const cpSource = fs.readFileSync(
      path.resolve(import.meta.dirname, '..', 'src', 'compile-pipeline.js'),
      'utf8',
    );
    assert.match(cpSource, /holdout_excluded_count/,
      'compile-pipeline.js must reference holdout_excluded_count for the receipt');
    assert.match(cpSource, /row_hash_dedupe_count/,
      'compile-pipeline.js must reference row_hash_dedupe_count for the receipt');
  } finally {
    restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #6 — Approval row's holdout_only flag propagates into the corpus pair.
test('W411 dedupe #6 — approval-row holdout_only flag flows into pair metadata', async () => {
  const saved = snapEnv();
  const tmp = mkTmp('w411-d6');
  try {
    setEnv(tmp);
    await _hardResetEventStore();
    const { appendEvent } = await import('../src/event-store.js');
    const ns = 'w411-approval-holdout';
    for (let i = 0; i < 6; i++) {
      await appendEvent({
        event_id: 'evt_w411_d6_' + i,
        namespace: ns,
        tenant_id: 't1',
        prompt_redacted: 'p ' + i,
        response_redacted: 'r ' + i,
        provider: 'openai',
        model: 'gpt-4o-mini',
        status: 'ok',
      });
    }
    const { approveEvent } = await import('../src/dataset-workbench.js');
    // Approve all, but flag the first 3 as holdoutOnly via the approval row.
    for (let i = 0; i < 6; i++) {
      await approveEvent('evt_w411_d6_' + i, {
        reviewer: 'r1',
        holdoutOnly: i < 3,
      });
    }
    const { prepareDistillCorpus } = await import('../src/distill-pipeline.js');
    const { pairs } = await prepareDistillCorpus({
      namespace: ns,
      split: 'all',
      approvedOnly: true,
    });
    const flagged = pairs.filter((p) => p.holdout_only);
    assert.equal(flagged.length, 3,
      'approval-row holdout_only must propagate to 3 pairs (got ' + flagged.length + ')');
    // And in split='train' mode, none of those holdout-flagged pairs survive.
    const trainResult = await prepareDistillCorpus({
      namespace: ns,
      split: 'train',
      approvedOnly: true,
    });
    for (const p of trainResult.pairs) {
      assert.ok(!p.holdout_only,
        'pair ' + p.event_id + ' with approval-row holdout_only=true leaked into train');
    }
  } finally {
    restoreEnv(saved);
  }
});
