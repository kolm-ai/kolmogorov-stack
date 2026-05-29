// tests/wave921-failure-analyst.test.js
//
// Contract tests for src/failure-analyst.js → analyzeFailures(...).
//
// Determinism: no network, no wall-clock branching. The eval artifact is a
// fixed on-disk fixture; clusters are pinned via explicit per-item `cluster_id`
// so bucketing is deterministic regardless of active-learning's hash. Every
// call is tenant-fenced with a unique test tenant id, and KOLM_DATA_DIR is
// redirected into a unique temp dir so appendFixPairs() never touches the real
// home dir. No live teacher is required (templated/reference path only).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { analyzeFailures, FAILURE_ANALYST_VERSION } from '../src/failure-analyst.js';

const UNIQ = crypto.randomBytes(6).toString('hex');
const TENANT = `tenant_test_fa_${UNIQ}`;
const NAMESPACE = `ns_fa_${UNIQ}`;

let TMP_DIR; // unique temp dir; also used as KOLM_DATA_DIR for write isolation
let EVAL_PATH; // path to the eval-*.json fixture
let PRIOR_DATA_DIR; // saved env to restore in after()

// The fixture has two pinned clusters:
//   - 'cluster_billing': 5 items, 4 failing (score 0.1) + 1 passing (0.9)
//     => fail_rate 0.8 (~80% wrong) — this MUST be the worst_category.
//   - 'cluster_greeting': 4 items, 1 failing (0.2) + 3 passing (0.95)
//     => fail_rate 0.25.
// Each billing item carries a reference_answer so fix_pairs use the canonical
// (non-scaffold) output path. One unscored item is included to confirm it is
// dropped (neither pass nor fail).
function buildEvalFixture() {
  const results = [];
  for (let i = 0; i < 4; i++) {
    results.push({
      id: `bill_fail_${i}`,
      question: `Why was my invoice charged twice in billing scenario ${i}?`,
      reference_answer: `Refund the duplicate charge for scenario ${i} and confirm the credit.`,
      cluster_id: 'cluster_billing',
      verdict: { score: 0.1 },
    });
  }
  results.push({
    id: 'bill_pass_0',
    question: 'How do I download a past invoice?',
    reference_answer: 'Open Billing → Invoices and click download.',
    cluster_id: 'cluster_billing',
    verdict: { score: 0.9 },
  });
  results.push({
    id: 'greet_fail_0',
    question: 'Say hello to a brand new user warmly.',
    reference_answer: 'Welcome! Glad to have you here.',
    cluster_id: 'cluster_greeting',
    verdict: { score: 0.2 },
  });
  for (let i = 0; i < 3; i++) {
    results.push({
      id: `greet_pass_${i}`,
      question: `Greet returning user number ${i}.`,
      reference_answer: `Welcome back, friend ${i}!`,
      cluster_id: 'cluster_greeting',
      verdict: { score: 0.95 },
    });
  }
  // Unscored item — no verdict.score and no flat score => must be dropped.
  results.push({
    id: 'unscored_0',
    question: 'This item has no score and must not count as pass or fail.',
    cluster_id: 'cluster_billing',
  });

  return { bench: 'support-eval', mean_score: 0.5, n: results.length, cot_contaminated: 0, results };
}

before(() => {
  TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `kolm-fa-${UNIQ}-`));
  EVAL_PATH = path.join(TMP_DIR, 'eval-support-eval.json');
  fs.writeFileSync(EVAL_PATH, JSON.stringify(buildEvalFixture()), 'utf8');
  // Redirect every augment-pairs.jsonl write into the temp dir.
  PRIOR_DATA_DIR = process.env.KOLM_DATA_DIR;
  process.env.KOLM_DATA_DIR = TMP_DIR;
});

after(() => {
  if (PRIOR_DATA_DIR === undefined) delete process.env.KOLM_DATA_DIR;
  else process.env.KOLM_DATA_DIR = PRIOR_DATA_DIR;
  try {
    if (TMP_DIR) fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch (_) {
    // best-effort cleanup; never fail the suite on a Windows file-lock.
  }
});

test('analyzeFailures: success envelope + worst_category is the ~80%-wrong cluster', async () => {
  const res = await analyzeFailures({
    tenant: TENANT,
    namespace: NAMESPACE,
    eval_path: EVAL_PATH,
    max_fix_pairs: 10,
  });

  // (envelope) success shape: { ok:true, version:'fa-v1', ... }
  assert.equal(res.ok, true);
  assert.equal(res.version, FAILURE_ANALYST_VERSION);
  assert.equal(res.version, 'fa-v1');

  // (4) clusters[] present and includes both pinned clusters.
  assert.ok(Array.isArray(res.clusters), 'clusters[] must be present');
  const ids = res.clusters.map((c) => c.cluster_id).sort();
  assert.deepEqual(ids, ['cluster_billing', 'cluster_greeting']);

  // (1) worst_category is the billing cluster at ~80% fail rate.
  assert.ok(res.worst_category, 'worst_category must be identified');
  assert.equal(res.worst_category.cluster_id, 'cluster_billing');
  assert.equal(res.worst_category.fail_rate, 0.8); // 4 fail / 5 scored
  assert.equal(res.worst_category.n_failed, 4);

  // The unscored item was dropped: billing has 5 scored items, not 6.
  const billing = res.clusters.find((c) => c.cluster_id === 'cluster_billing');
  assert.equal(billing.n_total, 5);
  assert.equal(billing.n_failed, 4);
});

test('analyzeFailures: emits targeted fix_pairs with {input, output, rationale}', async () => {
  const res = await analyzeFailures({
    tenant: TENANT,
    namespace: NAMESPACE,
    eval_path: EVAL_PATH,
    max_fix_pairs: 10,
  });

  // (2) at least one fix_pair, all targeting the worst cluster's failing items.
  assert.ok(Array.isArray(res.fix_pairs), 'fix_pairs[] must be present');
  assert.ok(res.fix_pairs.length >= 1, 'expected >= 1 fix_pair');
  // Capped to the 4 failing billing items (the 1 passing item is not a target).
  assert.equal(res.fix_pairs.length, 4);

  const fp = res.fix_pairs[0];
  // Exact key contract: { input, output, rationale }.
  assert.deepEqual(Object.keys(fp).sort(), ['input', 'output', 'rationale']);
  assert.equal(typeof fp.input, 'string');
  assert.equal(typeof fp.output, 'string');
  assert.equal(typeof fp.rationale, 'string');
  assert.ok(fp.input.trim().length > 0, 'fix_pair.input must be non-empty');
  // Reference-answer path: output is the canonical answer, not a scaffold.
  assert.ok(fp.output.startsWith('Refund the duplicate charge'));
  assert.ok(!fp.output.includes('[NEEDS_'), 'reference path must not scaffold');
  // Rationale names the worst-category cluster it targets.
  assert.ok(fp.rationale.includes('cluster_billing'));

  // Fix pairs were appended to the augment queue (best-effort write succeeded).
  assert.ok(res.append, 'append result must be present');
  assert.equal(res.append.ok, true);
  assert.equal(res.n_fix_pairs_written, res.fix_pairs.length);
});

test('analyzeFailures: max_fix_pairs cap is respected', async () => {
  const res = await analyzeFailures({
    tenant: TENANT,
    namespace: NAMESPACE,
    eval_path: EVAL_PATH,
    max_fix_pairs: 2,
  });
  assert.equal(res.ok, true);
  assert.equal(res.fix_pairs.length, 2, 'fix_pairs must honor the cap of 2');
});

test('analyzeFailures: unreadable/missing eval_path => { ok:false, error } envelope', async () => {
  const bogus = path.join(TMP_DIR, 'eval-does-not-exist.json');
  const res = await analyzeFailures({
    tenant: TENANT,
    namespace: NAMESPACE,
    eval_path: bogus,
  });

  // (3) failure envelope: { ok:false, error:'<snake_case>', version:'fa-v1' }
  assert.equal(res.ok, false);
  assert.equal(res.version, 'fa-v1');
  assert.equal(res.error, 'eval_path_unreadable');
});

test('analyzeFailures: malformed (non-object) eval JSON => eval_path_malformed', async () => {
  const malformedPath = path.join(TMP_DIR, 'eval-malformed.json');
  fs.writeFileSync(malformedPath, JSON.stringify(42), 'utf8'); // valid JSON, not an object
  const res = await analyzeFailures({
    tenant: TENANT,
    namespace: NAMESPACE,
    eval_path: malformedPath,
  });
  assert.equal(res.ok, false);
  assert.equal(res.version, 'fa-v1');
  assert.equal(res.error, 'eval_path_malformed');
});

test('analyzeFailures: no eval_path and no run_dir => eval_input_required', async () => {
  const res = await analyzeFailures({ tenant: TENANT, namespace: NAMESPACE });
  assert.equal(res.ok, false);
  assert.equal(res.version, 'fa-v1');
  assert.equal(res.error, 'eval_input_required');
});
