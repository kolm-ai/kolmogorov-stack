// scripts/data-evaluate-smoke.mjs
//
// Smoke for src/data-evaluate.js — the EVALUATE-stage aggregation layer.
//
// Synthesizes a run_dir (and a baseline dir) whose student/eval-*.json files
// match the shape eval_adapter.py writes, then asserts the roll-up:
//   1. evaluateRun reads the bench; mean_score round-trips.
//   2. failure_categories non-empty + ranked by count desc; worst_category set.
//   3. safety.refusal_rate reflects injected refusals.
//   4. regression vs a higher baseline -> n_regressed===1, delta ~= -0.08.
//   5. no baseline -> vs_baseline===false, n_regressed===0.
//   6. ships:false on injected CoT contamination; ships:true on the clean run.
//
// State is isolated via KOLM_DATA_DIR = a fresh mkdtemp at the very top so the
// best-effort event-store writes land in a throwaway dir. Prints
// "N passed, M failed" and exits nonzero on any failure.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate persistence BEFORE importing the module (event-store reads
// KOLM_DATA_DIR lazily, but set it first to be safe).
process.env.KOLM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-deval-smoke-'));

const { evaluateRun, loadEvalJsons, classifyFailure, EVALUATE_VERSION } =
  await import('../src/data-evaluate.js');

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { passed++; }
  else { failed++; failures.push(`${name}${detail ? ' :: ' + detail : ''}`); }
}

function approx(a, b, eps = 1e-6) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= eps;
}

// --- Build a synthetic eval artifact ---------------------------------------

function writeBench(dir, benchName, summary) {
  const studentDir = path.join(dir, 'student');
  fs.mkdirSync(studentDir, { recursive: true });
  fs.writeFileSync(
    path.join(studentDir, `eval-${benchName}.json`),
    JSON.stringify(summary, null, 2),
    'utf8',
  );
}

// 20 items: a mix of high-scoring passes, low-scoring failures (some sharing a
// question prefix so they bucket together), and a few templated refusals. The
// per-item score lives at verdict.score, exactly as eval_adapter.py writes it.
function makeResults() {
  const results = [];
  // 10 high-scoring passes on distinct questions.
  for (let i = 0; i < 10; i++) {
    results.push({
      id: `q_pass_${i + 1}`,
      question: `How do I reset device number ${i + 1}?`,
      reference_answer: 'Hold the power button for ten seconds.',
      student_answer: 'Hold the power button for ten seconds to reset.',
      verdict: { score: 0.9, judge: 'local' },
      cot_flags: [],
    });
  }
  // 5 failures that all share the "how do i cancel my" prefix -> one big bucket.
  for (let i = 0; i < 5; i++) {
    results.push({
      id: `q_cancel_${i + 1}`,
      question: `How do I cancel my subscription option ${i + 1}?`,
      reference_answer: 'Open billing settings and click cancel.',
      student_answer: 'I am not sure about that, sorry.',
      verdict: { score: 0.2, judge: 'local' },
      cot_flags: [],
    });
  }
  // 3 failures that are templated refusals -> show up in safety.refusal_rate
  // AND as failed items (score below threshold) in a separate bucket.
  for (let i = 0; i < 3; i++) {
    results.push({
      id: `q_refuse_${i + 1}`,
      question: `Tell me a refundable detail ${i + 1}?`,
      reference_answer: 'Refunds are processed within five days.',
      student_answer: "I can't help with that request.",
      verdict: { score: 0.1, judge: 'local' },
      cot_flags: [],
    });
  }
  // 2 mid failures on another distinct prefix -> smaller bucket.
  for (let i = 0; i < 2; i++) {
    results.push({
      id: `q_ship_${i + 1}`,
      question: `When will my package arrive late ${i + 1}?`,
      reference_answer: 'Within three to five business days.',
      student_answer: 'Unknown.',
      verdict: { score: 0.3, judge: 'local' },
      cot_flags: [],
    });
  }
  return results;
}

function baseSummary(overrides = {}) {
  return {
    bench: 'mixeval-hard',
    bench_file: '/fake/questions.jsonl',
    adapter: '/fake/run/student',
    base: 'Qwen/Qwen2.5-7B-Instruct',
    judge: { vendor: 'local', model: null },
    n: 20,
    questions_total: 20,
    questions_scored: 20,
    mean_score: 0.72,
    arena_correlation_estimate: 0.96,
    cot_contaminated: false,
    evaluated_at: '2026-05-29T00:00:00Z',
    results: makeResults(),
    ...overrides,
  };
}

// --- Scenario A: clean run, no baseline ------------------------------------

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-deval-run-'));
writeBench(runDir, 'mixeval-hard', baseSummary());

// loadEvalJsons pure helper sanity.
const loaded = loadEvalJsons(runDir);
ok('loadEvalJsons finds the bench', !!loaded['mixeval-hard'],
  `keys=${Object.keys(loaded).join(',')}`);

// classifyFailure pure helper sanity.
const cf = classifyFailure({ question: 'How do I cancel my subscription option 1?' });
ok('classifyFailure returns a category', !!cf.category && cf.category.length > 0, JSON.stringify(cf));

const resA = await evaluateRun({ run_dir: runDir });

ok('A: envelope ok + version', resA.ok === true && resA.version === EVALUATE_VERSION,
  JSON.stringify({ ok: resA.ok, version: resA.version, error: resA.error }));

// 1. mean_score round-trips.
ok('1: benches[mixeval-hard].mean_score===0.72',
  resA.benches && resA.benches['mixeval-hard'] && resA.benches['mixeval-hard'].mean_score === 0.72,
  JSON.stringify(resA.benches && resA.benches['mixeval-hard']));

ok('1b: bench n===20', resA.benches['mixeval-hard'].n === 20,
  String(resA.benches['mixeval-hard'].n));

// 2. failure_categories non-empty, ranked desc, worst_category set.
const fcs = resA.failure_categories || [];
ok('2: failure_categories non-empty', fcs.length > 0, `len=${fcs.length}`);
let rankedDesc = true;
for (let i = 1; i < fcs.length; i++) if (fcs[i].count > fcs[i - 1].count) rankedDesc = false;
ok('2b: failure_categories ranked by count desc', rankedDesc, JSON.stringify(fcs.map((f) => f.count)));
ok('2c: worst_category set', !!resA.summary.worst_category,
  String(resA.summary.worst_category));
ok('2d: worst_category is the biggest bucket (the cancel prefix, count 5)',
  fcs[0].count === 5 && resA.summary.worst_category === fcs[0].category,
  JSON.stringify({ top: fcs[0], worst: resA.summary.worst_category }));
// shares should sum to ~1.
const shareSum = fcs.reduce((a, b) => a + b.share, 0);
ok('2e: failure_categories shares sum ~1', approx(shareSum, 1, 1e-3), String(shareSum));

// 3. safety.refusal_rate reflects the 3 injected refusals out of 20 outputs.
ok('3: safety.n_checked===20', resA.safety.n_checked === 20, String(resA.safety.n_checked));
ok('3b: safety.refusal_rate===3/20', approx(resA.safety.refusal_rate, 3 / 20),
  String(resA.safety.refusal_rate));

// 5. no baseline -> vs_baseline false, n_regressed 0.
ok('5: regression.vs_baseline===false (no baseline)', resA.regression.vs_baseline === false,
  JSON.stringify(resA.regression));
ok('5b: regression.n_regressed===0 (no baseline)', resA.regression.n_regressed === 0,
  String(resA.regression.n_regressed));

// 6 (clean half): ships:true on the clean non-regressed case.
ok('6a: ships===true on clean non-regressed run', resA.summary.ships === true,
  JSON.stringify(resA.summary));

// --- Scenario B: regression vs a higher baseline ---------------------------

const baselineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-deval-base-'));
writeBench(baselineDir, 'mixeval-hard', baseSummary({ mean_score: 0.80 }));

const resB = await evaluateRun({ run_dir: runDir, baseline_dir: baselineDir });

// 4. regression: 0.72 < 0.80 - 0.02 -> regressed.
ok('4: regression.vs_baseline===true', resB.regression.vs_baseline === true,
  JSON.stringify(resB.regression));
ok('4b: n_regressed===1', resB.regression.n_regressed === 1, String(resB.regression.n_regressed));
ok('4c: regressed_benches[0].bench===mixeval-hard',
  resB.regression.regressed_benches[0] && resB.regression.regressed_benches[0].bench === 'mixeval-hard',
  JSON.stringify(resB.regression.regressed_benches[0]));
ok('4d: regressed delta ~= -0.08',
  approx(resB.regression.regressed_benches[0].delta, -0.08, 1e-6),
  String(resB.regression.regressed_benches[0] && resB.regression.regressed_benches[0].delta));

// A regression alone should also block shipping.
ok('4e: ships===false when regressed', resB.summary.ships === false,
  JSON.stringify(resB.summary));

// --- Scenario C: CoT contamination blocks shipping -------------------------

const contamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-deval-contam-'));
// Same clean, non-regressed, above-floor scores — only the contamination flag
// flips. The evaluator writes an integer count, so use 2 to exercise the
// integer path (the boolean path is covered by the clean scenario's `false`).
writeBench(contamDir, 'mixeval-hard', baseSummary({ cot_contaminated: 2 }));

const resC = await evaluateRun({ run_dir: contamDir });
ok('6b: ships===false on cot_contaminated', resC.summary.ships === false,
  JSON.stringify({ ships: resC.summary.ships, bench: resC.benches['mixeval-hard'] }));
ok('6c: bench cot_contaminated flag true', resC.benches['mixeval-hard'].cot_contaminated === true,
  JSON.stringify(resC.benches['mixeval-hard']));

// --- Scenario D: error envelopes never throw -------------------------------

const resMissing = await evaluateRun({ run_dir: path.join(os.tmpdir(), 'kolm-deval-does-not-exist-xyz') });
ok('D: missing run_dir -> ok:false + version', resMissing.ok === false && resMissing.version === EVALUATE_VERSION,
  JSON.stringify(resMissing));

const resNoArg = await evaluateRun({});
ok('D2: missing run_dir arg -> ok:false', resNoArg.ok === false, JSON.stringify(resNoArg));

const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-deval-empty-'));
const resEmpty = await evaluateRun({ run_dir: emptyDir });
ok('D3: empty run_dir (no eval-*.json) -> ok:false', resEmpty.ok === false, JSON.stringify(resEmpty));

// --- Cleanup (best-effort) -------------------------------------------------

for (const d of [runDir, baselineDir, contamDir, emptyDir, process.env.KOLM_DATA_DIR]) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// --- Report ----------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('\nFailures:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
