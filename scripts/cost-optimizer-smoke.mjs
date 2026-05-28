// scripts/cost-optimizer-smoke.mjs
//
// Pure-JS smoke for src/cost-optimizer.js (no GPU, no network). Verifies the
// co-v1 envelope, the ΔK-per-dollar ranking, the free-beats-costly headline
// invariant, budget gating, recommendation safety, and malformed-input
// behavior. Isolates KOLM_DATA_DIR BEFORE importing any event-store-touching
// code so the best-effort persistence in rankStrategies writes to a throwaway
// temp dir and the smoke leaves no state behind.

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

process.env.KOLM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-co-smoke-'));

const { rankStrategies } = await import('../src/cost-optimizer.js');

let passed = 0;
let failed = 0;
function check(name, cond) {
  if (cond) { passed += 1; console.log(`PASS ${name}`); }
  else { failed += 1; console.log(`FAIL ${name}`); }
}

const idxOf = (ranked, strat) => ranked.findIndex((r) => r.strategy === strat);

// --- Normal call ----------------------------------------------------------
const normal = await rankStrategies({
  tenant: 'tenant_smoke',
  namespace: 'default',
  budget_usd: 50,
  target_kscore: 0.85,
  current_features: { n_pairs: 200, dup_fraction: 0.2, coverage_score: 0.55, avg_quality: 0.7 },
});

// 1. ok:true with all five strategies ranked.
check('1 normal ok + 5 strategies ranked',
  normal && normal.ok === true && Array.isArray(normal.ranked) && normal.ranked.length === 5);

// 2. HEADLINE DoD: the (nearly) FREE dedup ranks ABOVE the costly gap-fill.
const dedupIdx = normal && normal.ranked ? idxOf(normal.ranked, 'dedup') : -1;
const gapFillIdx = normal && normal.ranked ? idxOf(normal.ranked, 'gap-fill') : -1;
check('2 free dedup ranks above costly gap-fill',
  dedupIdx >= 0 && gapFillIdx >= 0 && dedupIdx < gapFillIdx);

// 3. ranked is sorted DESC by delta_k_per_dollar (monotonic non-increasing).
let monotonic = true;
if (normal && Array.isArray(normal.ranked)) {
  for (let i = 1; i < normal.ranked.length; i += 1) {
    if (normal.ranked[i].delta_k_per_dollar > normal.ranked[i - 1].delta_k_per_dollar) {
      monotonic = false; break;
    }
  }
} else { monotonic = false; }
check('3 ranked sorted DESC by delta_k_per_dollar', monotonic);

// --- Tiny budget ----------------------------------------------------------
const tiny = await rankStrategies({
  tenant: 'tenant_smoke',
  namespace: 'default',
  budget_usd: 0.001,
  current_features: { n_pairs: 200, dup_fraction: 0.2, coverage_score: 0.55, avg_quality: 0.7 },
});

// 4. Under a tiny budget the costly strategies don't fit, and recommended is a
//    free strategy or null — never a strategy with fits_budget:false.
let tinyCostlyExcluded = false;
let tinyRecSafe = false;
if (tiny && tiny.ok === true && Array.isArray(tiny.ranked)) {
  const costly = tiny.ranked.filter((r) => r.est_cost_usd > 0.001);
  tinyCostlyExcluded = costly.length > 0 && costly.every((r) => r.fits_budget === false);
  if (tiny.recommended === null) {
    tinyRecSafe = true;
  } else {
    const rec = tiny.ranked.find((r) => r.strategy === tiny.recommended);
    tinyRecSafe = !!rec && rec.fits_budget === true;
  }
}
check('4 tiny budget excludes costly + recommended never over-budget',
  tinyCostlyExcluded && tinyRecSafe);

// 5. recommended (when non-null) is present in ranked and fits_budget.
function recommendationValid(res) {
  if (!res || res.ok !== true) return false;
  if (res.recommended === null) return true; // null is a valid "nothing fits"
  const rec = res.ranked.find((r) => r.strategy === res.recommended);
  return !!rec && rec.fits_budget === true && rec.predicted_delta_k >= 0;
}
check('5 recommended present in ranked + fits_budget',
  recommendationValid(normal) && recommendationValid(tiny));

// 6. envelope version co-v1 + malformed input (null features) => ok:false, no throw.
let malformed;
let threw = false;
try {
  malformed = await rankStrategies({ budget_usd: 10, current_features: null });
} catch { threw = true; }
check('6 version co-v1 + malformed input ok:false (no throw)',
  !threw &&
  normal && normal.version === 'co-v1' &&
  malformed && malformed.ok === false && malformed.version === 'co-v1');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
