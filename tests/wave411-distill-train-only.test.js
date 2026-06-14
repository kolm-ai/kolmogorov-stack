// Wave 411 — distill MUST see train-only pairs, never the full corpus.
//
// Regression contract for src/compile-pipeline.js. The pre-fix line 681
// ternary handed the *entire* corpus (train + holdout) to distillation on its
// false branch:
//
//   const distillPairs = (trainPairs && trainPairs.length) ? trainPairs : corpusPairs;
//
// That silent full-corpus fallback re-introduced the exact eval-set leak the
// W411 P0 audit contract forbids: the artifact would be trained on its own
// holdout, and the "honest holdout" K-score claim would be a lie. The fix
// fails closed instead — it only mirrors the corpus into trainPairs when the
// honest stub path is explicitly enabled (allow_stub), and otherwise throws.
//
// This file asserts BEHAVIOR end-to-end:
//   #1  distill processes exactly train_count pairs (< corpus pair_count) —
//       proving holdout rows never reach distillation.
//   #2  source-level guard: the train-only throw + allowStub-gated stub mirror
//       are present, and the silent `: corpusPairs` fallback is gone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

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
  };
}

function _restoreEnv(saved) {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

function _setEnv(tmp) {
  process.env.KOLM_DATA_DIR = tmp;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_STORE_DRIVER = 'jsonl';
  process.env.KOLM_RECIPE_RECEIPT_SECRET =
    process.env.KOLM_RECIPE_RECEIPT_SECRET || 'wave411-test-secret-32chars-min-len';
}

// Distinct (prompt, response) pairs so the workbench split is content-disjoint
// and every row hydrates back to a unique pair (no dedupe collapse).
async function _seedNamespace(namespace, n) {
  const { appendEvent, _resetForTests } = await import('../src/event-store.js');
  _resetForTests();
  for (let i = 0; i < n; i++) {
    await appendEvent({
      namespace,
      tenant_id: 'wave411-test',
      prompt_redacted: `classify ticket ${i} about topic-${i % 7} priority-${i % 3}`,
      response_redacted: `label ${i}: route-${i % 5} severity-${i % 4} reply-${i}`,
      provider: 'openai',
      model: 'gpt-4o-mini',
      status: 'ok',
    });
  }
}

// ---------------------------------------------------------------------------
// #1 — distillation processes train-only pairs (holdout excluded).
test('W411 — distill sees train-only pairs, never the full corpus', async () => {
  const tmp = _mkTmp('w411-1');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    // Force stub/collect distill mode (no live teacher) so the run is offline,
    // deterministic, and exercises pairs_override end-to-end.
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.KOLM_DISTILL_TEACHER;
    delete process.env.KOLM_DISTILL_FULL;

    const N = 40;
    await _seedNamespace('w411-train-only', N);

    const { compileFull } = await import('../src/compile-pipeline.js');

    let corpusPairCount = null;
    let trainCount = null;
    let holdoutCount = null;
    let distillDonePairCount = null;
    let holdoutExcludedCount = null;

    for await (const ev of compileFull({
      namespace: 'w411-train-only',
      // force lets the verdict/gate proceed offline; it does NOT (post-fix)
      // open a silent full-corpus distill fallback.
      opts: { emit_progress_every: 0, no_install: true, force: true },
    })) {
      if (ev.phase === 'corpus_prepare') corpusPairCount = ev.pair_count;
      if (ev.phase === 'dataset_split') {
        trainCount = ev.train_count;
        holdoutCount = ev.holdout_count;
      }
      // With emit_progress_every=0 the pipeline collapses the distill phase to
      // a single canonical summary event carrying worker_mode + pair_count
      // (the count of pairs distillation actually processed).
      if (ev.phase === 'distill' && ev.summary) {
        distillDonePairCount = ev.pair_count;
      }
      if (ev.phase === 'done') {
        holdoutExcludedCount = ev.holdout_excluded_count;
      }
    }

    assert.ok(corpusPairCount > 0, 'corpus_prepare must report a positive pair_count');
    assert.ok(trainCount > 0, 'dataset_split must report a positive train_count');
    assert.ok(holdoutCount > 0, 'this corpus must yield a non-empty holdout for the test to be meaningful');
    assert.equal(typeof distillDonePairCount, 'number',
      'distill must yield a summary event carrying pair_count');

    // The core W411 contract: distillation processed exactly the train rows,
    // strictly fewer than the full corpus. If the regression were live,
    // distillDonePairCount would equal corpusPairCount (train + holdout).
    assert.equal(distillDonePairCount, trainCount,
      `distill must process exactly train_count (${trainCount}) pairs, got ${distillDonePairCount}`);
    assert.ok(distillDonePairCount < corpusPairCount,
      `distill pair_count (${distillDonePairCount}) must be < corpus pair_count (${corpusPairCount}) — holdout excluded`);
    assert.equal(distillDonePairCount + holdoutCount, corpusPairCount,
      'train + holdout must reconstitute the full corpus (no rows lost or duplicated)');
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #2 — source guard: the silent full-corpus fallback is gone; the train-only
// throw + allowStub-gated stub mirror are present.
test('W411 — compile-pipeline source enforces train-only distill (no silent corpus fallback)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'compile-pipeline.js'), 'utf8');

  // The exact pre-fix ternary must be gone.
  assert.ok(
    !/const distillPairs = \(trainPairs && trainPairs\.length\) \? trainPairs : corpusPairs;/.test(src),
    'the silent (trainPairs ? trainPairs : corpusPairs) fallback must be removed',
  );

  // distillPairs must be train-only.
  assert.match(src, /const distillPairs = trainPairs;/,
    'distillPairs must be assigned trainPairs (train-only)');

  // The fail-closed throw must be present and gated on allowStub.
  assert.match(src, /if \(!\(trainPairs && trainPairs\.length\)\) \{/,
    'must guard on empty trainPairs');
  assert.match(src, /if \(!allowStub\) \{/,
    'empty-train guard must require allowStub before mirroring the corpus');
  assert.match(src, /refusing to distill on full corpus/,
    'must throw a W411 train/holdout boundary error when allowStub is false');
  assert.match(src, /trainPairs = corpusPairs\.slice\(\);/,
    'the honest stub path must mirror the corpus into trainPairs only when allowStub');
});
