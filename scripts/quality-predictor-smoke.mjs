// scripts/quality-predictor-smoke.mjs
//
// Pure-JS smoke for src/quality-predictor.js. No GPU, no network, no model
// download. Runs entirely against a throwaway KOLM_DATA_DIR so it never
// touches the real ~/.kolm store.
//
// Asserts:
//   1. cold start (0 train rows) -> ok, basis:'heuristic', low confidence,
//      valid ci with lo <= predicted <= hi.
//   2. heuristic monotonicity: a clearly-better feature vector predicts a
//      higher K than a clearly-worse one.
//   3. after backfilling a synthetic run whose features map to a known K, the
//      heuristic prediction for that vector lands within +/-0.05 of the target.
//   4. backfillFromRuns is idempotent (second run does not double-count).
//   5. malformed input -> ok:false with an error code, no throw.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// FIRST LINE OF EFFECT: isolate the data dir BEFORE importing any module that
// touches the event store or the meta-trainer row store.
process.env.KOLM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-qp-'));

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log('  PASS', msg); }
  else { fail += 1; console.log('  FAIL', msg); }
}

function isValidCi(ci, predicted) {
  return Array.isArray(ci) && ci.length === 2
    && Number.isFinite(ci[0]) && Number.isFinite(ci[1])
    && ci[0] <= predicted && predicted <= ci[1];
}

async function main() {
  // Dynamic import AFTER the env seam is set so the modules resolve the
  // throwaway KOLM_DATA_DIR.
  const qp = await import('../src/quality-predictor.js');
  const {
    predictKScore, backfillFromRuns, QUALITY_PREDICTOR_VERSION, __internals,
  } = qp;

  ok(QUALITY_PREDICTOR_VERSION === 'qp-v1', `version is qp-v1 (got ${QUALITY_PREDICTOR_VERSION})`);

  // ----- 1. cold start: heuristic, low confidence, valid ci -----------------
  const trinityLike = {
    n_pairs: 410, dup_fraction: 0.05, coverage_score: 0.9,
    avg_quality: 0.9, cot_contam_fraction: 0.1, teacher_diversity: 1.0,
  };
  const cold = await predictKScore({ features: trinityLike });
  ok(cold.ok === true, 'cold: ok:true');
  ok(cold.basis === 'heuristic', `cold: basis heuristic (got ${cold.basis})`);
  ok(cold.n_train_rows === 0, `cold: 0 train rows (got ${cold.n_train_rows})`);
  ok(typeof cold.confidence === 'number' && cold.confidence > 0 && cold.confidence <= 0.45,
    `cold: low confidence in (0,0.45] (got ${cold.confidence})`);
  ok(isValidCi(cold.ci, cold.kscore_predicted),
    `cold: valid ci lo<=pred<=hi (ci ${JSON.stringify(cold.ci)}, pred ${cold.kscore_predicted})`);
  // Calibration sanity: a Trinity-like vector should predict near the observed
  // Trinity K of ~0.89.
  ok(Math.abs(cold.kscore_predicted - 0.89) <= 0.05,
    `cold: Trinity-like vector predicts ~0.89 (got ${cold.kscore_predicted})`);

  // ----- 2. monotonicity: better vector > worse vector ----------------------
  const better = {
    n_pairs: 5000, dup_fraction: 0.02, coverage_score: 0.95,
    avg_quality: 0.95, cot_contam_fraction: 0.02, teacher_diversity: 1.0,
  };
  const worse = {
    n_pairs: 25, dup_fraction: 0.7, coverage_score: 0.15,
    avg_quality: 0.2, cot_contam_fraction: 0.8, teacher_diversity: 0.05,
  };
  const pBetter = await predictKScore({ features: better });
  const pWorse = await predictKScore({ features: worse });
  ok(pBetter.ok && pWorse.ok, 'mono: both predictions ok');
  ok(pBetter.kscore_predicted > pWorse.kscore_predicted,
    `mono: better (${pBetter.kscore_predicted}) > worse (${pWorse.kscore_predicted})`);
  // Per-feature monotonicity spot checks via the internal sub-score blend.
  const baseFeat = { n_pairs: 300, dup_fraction: 0.2, coverage_score: 0.6, avg_quality: 0.6, cot_contam_fraction: 0.2, teacher_diversity: 0.5 };
  const kBase = __internals._heuristicK(__internals._subScores(baseFeat));
  const kMorePairs = __internals._heuristicK(__internals._subScores({ ...baseFeat, n_pairs: 3000 }));
  const kLessDup = __internals._heuristicK(__internals._subScores({ ...baseFeat, dup_fraction: 0.0 }));
  const kLessCot = __internals._heuristicK(__internals._subScores({ ...baseFeat, cot_contam_fraction: 0.0 }));
  ok(kMorePairs > kBase, `mono: more pairs raises K (${kBase.toFixed(4)} -> ${kMorePairs.toFixed(4)})`);
  ok(kLessDup > kBase, `mono: less dup raises K (${kBase.toFixed(4)} -> ${kLessDup.toFixed(4)})`);
  ok(kLessCot > kBase, `mono: less CoT contamination raises K (${kBase.toFixed(4)} -> ${kLessCot.toFixed(4)})`);

  // ----- 3. backfill a synthetic run -> prediction within +/-0.05 of target -
  // Construct the run so the target is achievable: the eval composite is set to
  // exactly the heuristic K of the run's feature vector, so a (still-heuristic,
  // since 1 row << threshold) prediction must land within tolerance.
  const synthFeatures = {
    n_pairs: 600, dup_fraction: 0.08, coverage_score: 0.85,
    avg_quality: 0.88, cot_contam_fraction: 0.12, teacher_diversity: 0.9,
  };
  const targetK = __internals._heuristicK(__internals._subScores(synthFeatures));

  const runsDir = path.join(process.env.KOLM_DATA_DIR, 'synth-runs');
  const runDir = path.join(runsDir, 'synthetic-run-001');
  fs.mkdirSync(path.join(runDir, 'student'), { recursive: true });
  // run.json carries the feature vector; student/eval.json carries the label.
  fs.writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ features: synthFeatures }));
  fs.writeFileSync(
    path.join(runDir, 'student', 'eval.json'),
    JSON.stringify({ composite: Number(targetK.toFixed(4)) }),
  );

  const bf1 = await backfillFromRuns({ runs_dir: runsDir });
  ok(bf1.ok === true, 'backfill: ok:true');
  ok(bf1.n_backfilled === 1, `backfill: 1 row backfilled (got ${bf1.n_backfilled})`);
  ok(bf1.n_train_rows === 1, `backfill: 1 train row total (got ${bf1.n_train_rows})`);

  const pSynth = await predictKScore({ features: synthFeatures });
  ok(pSynth.ok === true, 'backfill: prediction ok');
  ok(Math.abs(pSynth.kscore_predicted - targetK) <= 0.05,
    `backfill: predicted ${pSynth.kscore_predicted} within +/-0.05 of target ${Number(targetK.toFixed(4))}`);

  // ----- 4. idempotency: a second backfill does not double-count ------------
  const bf2 = await backfillFromRuns({ runs_dir: runsDir });
  ok(bf2.ok === true, 'idempotent: second backfill ok');
  ok(bf2.n_backfilled === 0, `idempotent: 0 new rows on re-run (got ${bf2.n_backfilled})`);
  ok(bf2.n_train_rows === 1, `idempotent: still 1 train row (got ${bf2.n_train_rows})`);

  // ----- 5. malformed input -> ok:false, no throw ---------------------------
  const m1 = await predictKScore({ features: null });
  ok(m1.ok === false && typeof m1.error === 'string',
    `malformed: null features -> ok:false (error ${m1.error})`);
  const m2 = await predictKScore({ features: 'not-an-object' });
  ok(m2.ok === false && typeof m2.error === 'string',
    `malformed: string features -> ok:false (error ${m2.error})`);
  const m3 = await predictKScore({ features: [1, 2, 3] });
  ok(m3.ok === false && typeof m3.error === 'string',
    `malformed: array features -> ok:false (error ${m3.error})`);
  const m4 = await predictKScore({ features: { totally_unrelated: 1, junk: 2 } });
  ok(m4.ok === false && m4.error === 'no_recognized_features',
    `malformed: junk-only keys -> no_recognized_features (error ${m4.error})`);
  const m5 = await predictKScore({});
  ok(m5.ok === false && typeof m5.error === 'string',
    `malformed: missing features arg -> ok:false (error ${m5.error})`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  // A throw here is itself a failure — the public API must never throw, and the
  // smoke harness must surface that rather than crash silently.
  console.log('  FAIL uncaught error:', String((e && e.stack) || e));
  console.log(`\n${pass} passed, ${fail + 1} failed`);
  process.exit(1);
});
