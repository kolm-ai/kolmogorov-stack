// scripts/compile-simulator-smoke.mjs
//
// Pure-JS smoke test for src/compile-simulator.js. No GPU, no network.
// Isolates the event store into a throwaway data dir BEFORE importing anything
// that touches it, then exercises the compile-vs-skip decision surface.

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// MUST run before importing the module (which transitively loads the event store).
process.env.KOLM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-cs-smoke-'));

const { simulateCompile, decideFromDeltaK, COMPILE_SIM_VERSION } =
  await import('../src/compile-simulator.js');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed += 1; console.log(`PASS ${name}`); }
  else { failed += 1; console.log(`FAIL ${name}`); }
}

// --- 1. Substantial delta -> compile, delta_k >= 0.02 -----------------------
const big = await simulateCompile({
  tenant: 'tenant_smoke', namespace: 'cs-smoke',
  current_features: { n_pairs: 120, dup_fraction: 0.25, coverage_score: 0.5 },
  proposed_delta: { n_pairs: 400, dup_fraction: -0.15, coverage_score: 0.3 },
});
check('substantial delta ok', big.ok === true);
check('substantial delta decision=compile', big.decision === 'compile');
check('substantial delta delta_k >= 0.02', big.delta_k >= 0.02);
check('substantial delta version cs-v1', big.version === 'cs-v1');
check('substantial delta carries persist sub-object', big.persist && typeof big.persist.persisted === 'boolean');

// --- 2. Marginal delta -> skip, delta_k < 0.02 ------------------------------
const small = await simulateCompile({
  tenant: 'tenant_smoke', namespace: 'cs-smoke',
  current_features: { n_pairs: 120, dup_fraction: 0.25, coverage_score: 0.5 },
  proposed_delta: { n_pairs: 5 },
});
check('marginal delta ok', small.ok === true);
check('marginal delta decision=skip', small.decision === 'skip');
check('marginal delta delta_k < 0.02', small.delta_k < 0.02);

// --- 3. Batch of ~10 mostly-marginal proposals -> >=50% skip ----------------
const base = { n_pairs: 120, dup_fraction: 0.25, coverage_score: 0.5, avg_quality: 0.6 };
const batch = [
  { n_pairs: 1 },
  { n_pairs: 3 },
  { n_pairs: 5 },
  { dup_fraction: -0.005 },
  { coverage_score: 0.005 },
  { avg_quality: 0.004 },
  { teacher_diversity: 0.01 },
  { cot_contam_fraction: -0.003 },
  { n_pairs: 8, dup_fraction: -0.002 },
  { n_pairs: 600, dup_fraction: -0.2, coverage_score: 0.4 }, // the one clear winner
];
let skips = 0;
let allOk = true;
for (const d of batch) {
  const r = await simulateCompile({
    tenant: 'tenant_smoke', namespace: 'cs-smoke',
    current_features: base, proposed_delta: d,
  });
  if (r.ok !== true) allOk = false;
  if (r.decision === 'skip') skips += 1;
}
check('batch all ok', allOk);
check(`batch >=50% skipped (${skips}/${batch.length})`, skips >= Math.ceil(batch.length / 2));

// --- 4. Pure decideFromDeltaK + custom threshold ----------------------------
check('decideFromDeltaK(0.05) -> compile', decideFromDeltaK(0.05).decision === 'compile');
check('decideFromDeltaK(0.005) -> skip', decideFromDeltaK(0.005).decision === 'skip');
check('decideFromDeltaK(0.05, 0.1) -> skip (custom threshold)', decideFromDeltaK(0.05, 0.1).decision === 'skip');

// --- 5. Malformed input -> ok:false snake_case error (no throw) --------------
const nullCurrent = await simulateCompile({ current_features: null, proposed_delta: { n_pairs: 100 } });
check('null current_features -> ok:false', nullCurrent.ok === false);
check('null current_features -> current_features_required', nullCurrent.error === 'current_features_required');
const nullDelta = await simulateCompile({ current_features: { n_pairs: 100 }, proposed_delta: null });
check('null proposed_delta -> ok:false', nullDelta.ok === false);
check('null proposed_delta -> proposed_delta_required', nullDelta.error === 'proposed_delta_required');

// --- 6. Envelope version on BOTH ok and error paths -------------------------
check('error-path version cs-v1', nullCurrent.version === 'cs-v1' && nullDelta.version === 'cs-v1');
check('COMPILE_SIM_VERSION export', COMPILE_SIM_VERSION === 'cs-v1');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
