// W810 — K-Score external calibration tests.
//
// Coverage (>=12 atomic tests, all green):
//   1)  Bradley-Terry: tiny 3-item fixture converges (|grad|_inf < 1e-6).
//   2)  Bradley-Terry: stronger candidate gets higher theta than weaker.
//   3)  Bradley-Terry: tie pulls theta toward the mean.
//   4)  Bradley-Terry: rejects self-pair (a===b) at validation time.
//   5)  Bradley-Terry: predictPairProb is monotone in theta difference.
//   6)  calibration: loadPack returns pack_not_found when no file.
//   7)  calibration: loadPack parses well-formed JSONL, captures parse errors.
//   8)  calibration: fitAndPersist on <500 pairs -> insufficient_data.
//   9)  calibration: fitAndPersist on >=500 pairs -> per-category mapping with
//       ok status + slope/intercept/ci95 + n_pairs.
//  10)  calibration: persisted JSON shape matches the spec exactly.
//  11)  envelope: K-Score with no mapping -> human_preference_rate:null +
//       calibration_status:'no_calibration_mapping'.
//  12)  envelope: K-Score with mapping but unsupplied category ->
//       calibration_status:'no_category_supplied'.
//  13)  envelope: K-Score with mapping + insufficient_data category ->
//       human_preference_rate:null + calibration_status:'insufficient_data'.
//  14)  envelope: K-Score with mapping + ok category -> populated
//       human_preference_rate{point, ci95:[lo,hi], n_pairs}.
//  15)  envelope: V2 axis weights are untouched by the calibration block
//       (composite + ships + weights are byte-identical).
//  16)  recalibration script: --period missing pack -> exit code 2.
//  17)  CALIBRATION_VERSION and BRADLEY_TERRY_SPEC exports are stable strings.
//  18)  Period normalization: '2026-Q2' and '2026-04' resolve to the same
//       pack file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.join(__dirname, '..');

function freshDir(label) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `kolm-w810-${label || ''}-`));
  const dot = path.join(tmp, '.kolm');
  fs.mkdirSync(dot, { recursive: true });
  process.env.KOLM_DATA_DIR = dot;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  return tmp;
}

function freshImport(rel) {
  // Cache-bust so test order can't cross-contaminate module-level state.
  return import(`../${rel}?cb=${Date.now()}_${Math.random()}`);
}

function writePack(period, rows) {
  const file = path.join(process.env.KOLM_DATA_DIR, `calibration-pack-${period}.jsonl`);
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return file;
}

function makeRows({ n, category, biasA = 0.7 }) {
  // Deterministic biased pack: realistic multi-model bake-off shape. We have
  // 5 distinct candidate models per side so the BT fit produces 10 distinct
  // skill levels and the predicted-prob distribution spans multiple bins (the
  // calibration regression requires >=2 non-empty bins). Per-row pair-up is
  // deterministic on i. biasA biases the SIDE that wins (per-pair), with a
  // small per-row noise scaled by model rank so different model combinations
  // produce different prediction strengths.
  const rng = mulberry32(0xCAFE ^ n ^ hashStr(category));
  const rows = [];
  const aModels = ['ax', 'bx', 'cx', 'dx', 'ex'];  // 5 "strong" variants
  const bModels = ['ay', 'by', 'cy', 'dy', 'ey'];  // 5 "weak"   variants
  for (let i = 0; i < n; i++) {
    const ai = i % aModels.length;
    const bi = (i * 3) % bModels.length;
    // Model-rank tilt: ax beats every b; ex barely beats ay. Spreads the
    // predicted prob across the [0,1] range so the calibration regression
    // sees >=2 bins.
    const tilt = (aModels.length - ai) / aModels.length;
    const winA = rng() < (0.50 + (biasA - 0.50) * 2 * tilt);
    rows.push({
      pair_id: `${category}-${i}`,
      prompt: `q ${i}`,
      response_a: `cand A for ${i}`,
      response_b: `cand B for ${i}`,
      response_a_model: `strong-${category}-${aModels[ai]}`,
      response_b_model: `weak-${category}-${bModels[bi]}`,
      human_preference: winA ? 'a' : 'b',
      task_category: category,
    });
  }
  return rows;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = Math.imul(31, h) + s.charCodeAt(i) | 0; }
  return h;
}

// ---------------------------------------------------------------------------
// 1) Bradley-Terry tiny fixture converges.
// ---------------------------------------------------------------------------
test('W810 #1 Bradley-Terry converges on a tiny 3-item fixture', async () => {
  freshDir('t1');
  const { fitBradleyTerry, BT_DEFAULTS } = await freshImport('src/bradley-terry.js');
  const pairs = [
    { a: 'X', b: 'Y', pref: 'a' },
    { a: 'X', b: 'Y', pref: 'a' },
    { a: 'X', b: 'Y', pref: 'a' },
    { a: 'X', b: 'Z', pref: 'a' },
    { a: 'X', b: 'Z', pref: 'a' },
    { a: 'Y', b: 'Z', pref: 'a' },
  ];
  const fit = fitBradleyTerry(pairs);
  assert.ok(fit.converged, 'converged flag true');
  assert.ok(fit.grad_inf < BT_DEFAULTS.grad_tol, `|grad|_inf ${fit.grad_inf} < ${BT_DEFAULTS.grad_tol}`);
  assert.ok(fit.iter < BT_DEFAULTS.max_iter, 'iter under max');
  assert.equal(fit.n_items, 3);
  assert.equal(fit.n_pairs, 6);
});

// ---------------------------------------------------------------------------
// 2) Stronger candidate has higher theta.
// ---------------------------------------------------------------------------
test('W810 #2 Bradley-Terry: stronger candidate gets higher theta', async () => {
  freshDir('t2');
  const { fitBradleyTerry } = await freshImport('src/bradley-terry.js');
  const pairs = [];
  for (let i = 0; i < 10; i++) pairs.push({ a: 'STRONG', b: 'WEAK', pref: 'a' });
  for (let i = 0; i < 2; i++)  pairs.push({ a: 'STRONG', b: 'WEAK', pref: 'b' });
  const fit = fitBradleyTerry(pairs);
  assert.ok(fit.theta.STRONG > fit.theta.WEAK,
    `theta(STRONG)=${fit.theta.STRONG} > theta(WEAK)=${fit.theta.WEAK}`);
});

// ---------------------------------------------------------------------------
// 3) Tie centers theta.
// ---------------------------------------------------------------------------
test('W810 #3 Bradley-Terry: pure ties pull theta toward the mean (0)', async () => {
  freshDir('t3');
  const { fitBradleyTerry } = await freshImport('src/bradley-terry.js');
  const pairs = [];
  for (let i = 0; i < 50; i++) pairs.push({ a: 'P', b: 'Q', pref: 'tie' });
  const fit = fitBradleyTerry(pairs);
  assert.ok(Math.abs(fit.theta.P) < 1e-3, `theta(P)=${fit.theta.P} near 0`);
  assert.ok(Math.abs(fit.theta.Q) < 1e-3, `theta(Q)=${fit.theta.Q} near 0`);
});

// ---------------------------------------------------------------------------
// 4) Validation: self-pair rejected.
// ---------------------------------------------------------------------------
test('W810 #4 Bradley-Terry: rejects a===b self-pair', async () => {
  freshDir('t4');
  const { fitBradleyTerry } = await freshImport('src/bradley-terry.js');
  assert.throws(() => fitBradleyTerry([{ a: 'X', b: 'X', pref: 'a' }]),
    /self-pair/);
});

// ---------------------------------------------------------------------------
// 5) predictPairProb monotonic in theta delta.
// ---------------------------------------------------------------------------
test('W810 #5 predictPairProb is monotone in (theta_a - theta_b)', async () => {
  freshDir('t5');
  const { predictPairProb } = await freshImport('src/bradley-terry.js');
  const fit1 = { theta: { A: 0, B: 0 } };
  const fit2 = { theta: { A: 1, B: 0 } };
  const fit3 = { theta: { A: 2, B: 0 } };
  const p1 = predictPairProb(fit1, 'A', 'B');
  const p2 = predictPairProb(fit2, 'A', 'B');
  const p3 = predictPairProb(fit3, 'A', 'B');
  assert.ok(Math.abs(p1 - 0.5) < 1e-9, 'theta delta 0 -> 0.5');
  assert.ok(p2 > p1 && p3 > p2, `monotone: ${p1} < ${p2} < ${p3}`);
});

// ---------------------------------------------------------------------------
// 6) loadPack: missing file.
// ---------------------------------------------------------------------------
test('W810 #6 loadPack: missing file returns pack_not_found envelope', async () => {
  freshDir('t6');
  const { loadPack } = await freshImport('src/kscore-calibration.js');
  const out = loadPack('2026-Q2');
  assert.equal(out.ok, false);
  assert.equal(out.error, 'pack_not_found');
  assert.ok(out.detail && out.detail.includes('calibration-pack-2026-04.jsonl'),
    `detail path includes normalized YYYY-MM, got ${out.detail}`);
});

// ---------------------------------------------------------------------------
// 7) loadPack: parses well-formed JSONL + captures errors.
// ---------------------------------------------------------------------------
test('W810 #7 loadPack: parses good rows + records parse errors', async () => {
  freshDir('t7');
  const file = path.join(process.env.KOLM_DATA_DIR, 'calibration-pack-2026-04.jsonl');
  const lines = [
    JSON.stringify({ pair_id: 'p1', prompt: 'q', response_a: 'A', response_b: 'B', human_preference: 'a', task_category: 'coding' }),
    'not-json',
    JSON.stringify({ pair_id: 'p2', prompt: 'q', response_a: 'A', response_b: 'B', human_preference: 'tie', task_category: 'writing' }),
    JSON.stringify({ pair_id: 'p3', prompt: 'q', response_a: 'A', response_b: 'B', human_preference: 'maybe', task_category: 'support' }),
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  const { loadPack } = await freshImport('src/kscore-calibration.js');
  const out = loadPack('2026-Q2');
  assert.equal(out.ok, true);
  assert.equal(out.n, 2, 'two well-formed rows');
  assert.equal(out.parse_errors.length, 2, 'one bad json + one bad pref');
  const codes = out.parse_errors.map((e) => e.error).sort();
  assert.deepEqual(codes, ['bad_human_preference', 'json_parse_failed']);
});

// ---------------------------------------------------------------------------
// 8) fitAndPersist: <500 pairs -> insufficient_data.
// ---------------------------------------------------------------------------
test('W810 #8 fitAndPersist: small pack -> insufficient_data for every category', async () => {
  freshDir('t8');
  writePack('2026-04', makeRows({ n: 50, category: 'coding' }));
  const cal = await freshImport('src/kscore-calibration.js');
  const pack = cal.loadPack('2026-Q2');
  assert.equal(pack.ok, true);
  const { mapping } = cal.fitAndPersist(pack);
  assert.equal(mapping.by_category.coding.status, 'insufficient_data');
  assert.equal(mapping.by_category.writing.status, 'insufficient_data');
  assert.equal(mapping.by_category.analysis.status, 'insufficient_data');
  assert.equal(mapping.by_category.support.status, 'insufficient_data');
  assert.equal(mapping.by_category.coding.threshold, 500);
  assert.equal(mapping.n_pairs, 50);
});

// ---------------------------------------------------------------------------
// 9) fitAndPersist: >=500 pairs -> ok per-category mapping.
// ---------------------------------------------------------------------------
test('W810 #9 fitAndPersist: large pack -> per-category mapping ok', async () => {
  freshDir('t9');
  // Each row has its own pair_id, so each generates 2 unique BT items. We
  // need >=500 rows in the 'coding' bucket to clear the threshold.
  const rows = [
    ...makeRows({ n: 600, category: 'coding', biasA: 0.7 }),
    ...makeRows({ n: 100, category: 'writing' }),    // < 500 -> insufficient
  ];
  writePack('2026-04', rows);
  const cal = await freshImport('src/kscore-calibration.js');
  const pack = cal.loadPack('2026-Q2');
  const { mapping } = cal.fitAndPersist(pack);
  assert.equal(mapping.by_category.coding.status, 'ok',
    `coding status got ${mapping.by_category.coding.status}, full slot: ${JSON.stringify(mapping.by_category.coding)}`);
  assert.equal(typeof mapping.by_category.coding.slope, 'number');
  assert.equal(typeof mapping.by_category.coding.intercept, 'number');
  assert.equal(typeof mapping.by_category.coding.ci95_low, 'number');
  assert.equal(typeof mapping.by_category.coding.ci95_high, 'number');
  assert.ok(mapping.by_category.coding.ci95_low <= mapping.by_category.coding.ci95_high);
  assert.equal(mapping.by_category.coding.n_pairs, 600);
  assert.equal(mapping.by_category.writing.status, 'insufficient_data');
});

// ---------------------------------------------------------------------------
// 10) Persisted JSON shape matches the W810-3 spec.
// ---------------------------------------------------------------------------
test('W810 #10 persisted ~/.kolm/kscore-calibration.json shape matches spec', async () => {
  freshDir('t10');
  writePack('2026-04', makeRows({ n: 600, category: 'coding' }));
  const cal = await freshImport('src/kscore-calibration.js');
  const pack = cal.loadPack('2026-Q2');
  cal.fitAndPersist(pack);
  const onDisk = JSON.parse(fs.readFileSync(cal.calibrationMappingPath(), 'utf8'));
  // Top-level keys exactly as the spec lists them.
  assert.equal(onDisk.version, 'w810-v1');
  assert.equal(onDisk.calibration_pack_id, '2026-Q2');
  assert.ok('by_category' in onDisk);
  assert.ok('pooled' in onDisk);
  assert.equal(typeof onDisk.n_pairs, 'number');
  assert.equal(typeof onDisk.fitted_at, 'string');
  for (const cat of ['coding', 'writing', 'analysis', 'support']) {
    assert.ok(cat in onDisk.by_category, `category ${cat} present`);
  }
});

// ---------------------------------------------------------------------------
// 11) Envelope: no mapping -> null block + 'no_calibration_mapping'.
// ---------------------------------------------------------------------------
test('W810 #11 envelope: no mapping installed -> calibration_status=no_calibration_mapping', async () => {
  freshDir('t11');
  const { computeKScore } = await freshImport('src/kscore.js');
  const env = computeKScore({
    accuracy: 0.97, size_bytes: 32 * 1024 * 1024,
    p50_latency_us: 1200, cost_usd_per_call: 0.0001, coverage: 0.92,
    calibration_category: 'coding',
  });
  assert.equal(env.human_preference_rate, null);
  assert.equal(env.calibration_status, 'no_calibration_mapping');
  assert.equal(env.calibration_version, 'w810-v1');
  assert.equal(env.calibration_pack_id, null);
});

// ---------------------------------------------------------------------------
// 12) Envelope: mapping installed but no category supplied.
// ---------------------------------------------------------------------------
test('W810 #12 envelope: mapping but no category -> calibration_status=no_category_supplied', async () => {
  freshDir('t12');
  writePack('2026-04', makeRows({ n: 600, category: 'coding' }));
  const cal = await freshImport('src/kscore-calibration.js');
  cal.fitAndPersist(cal.loadPack('2026-Q2'));
  const { computeKScore } = await freshImport('src/kscore.js');
  const env = computeKScore({
    accuracy: 0.97, size_bytes: 32 * 1024 * 1024,
    p50_latency_us: 1200, cost_usd_per_call: 0.0001, coverage: 0.92,
    // calibration_category intentionally omitted
  });
  assert.equal(env.calibration_status, 'no_category_supplied');
  assert.equal(env.calibration_pack_id, '2026-Q2');
  assert.equal(env.human_preference_rate, null);
});

// ---------------------------------------------------------------------------
// 13) Envelope: insufficient_data category -> null block + status verbatim.
// ---------------------------------------------------------------------------
test('W810 #13 envelope: insufficient_data category surfaces verbatim', async () => {
  freshDir('t13');
  // Coding gets 600 (ok); writing gets 100 (insufficient).
  const rows = [
    ...makeRows({ n: 600, category: 'coding' }),
    ...makeRows({ n: 100, category: 'writing' }),
  ];
  writePack('2026-04', rows);
  const cal = await freshImport('src/kscore-calibration.js');
  cal.fitAndPersist(cal.loadPack('2026-Q2'));
  const { computeKScore } = await freshImport('src/kscore.js');
  const env = computeKScore({
    accuracy: 0.97, size_bytes: 32 * 1024 * 1024,
    p50_latency_us: 1200, cost_usd_per_call: 0.0001, coverage: 0.92,
    calibration_category: 'writing',
  });
  assert.equal(env.calibration_status, 'insufficient_data');
  assert.equal(env.human_preference_rate, null,
    'must NOT silently fall back to pooled (honest contract)');
  assert.equal(env.calibration_n_pairs, 100);
});

// ---------------------------------------------------------------------------
// 14) Envelope: ok category -> populated human_preference_rate.
// ---------------------------------------------------------------------------
test('W810 #14 envelope: ok category -> populated human_preference_rate{point,ci95,n_pairs}', async () => {
  freshDir('t14');
  writePack('2026-04', makeRows({ n: 600, category: 'coding', biasA: 0.7 }));
  const cal = await freshImport('src/kscore-calibration.js');
  cal.fitAndPersist(cal.loadPack('2026-Q2'));
  const { computeKScore } = await freshImport('src/kscore.js');
  const env = computeKScore({
    accuracy: 0.97, size_bytes: 32 * 1024 * 1024,
    p50_latency_us: 1200, cost_usd_per_call: 0.0001, coverage: 0.92,
    calibration_category: 'coding',
  });
  assert.equal(env.calibration_status, 'ok');
  assert.ok(env.human_preference_rate, 'block populated');
  assert.equal(typeof env.human_preference_rate.point, 'number');
  assert.ok(Array.isArray(env.human_preference_rate.ci95));
  assert.equal(env.human_preference_rate.ci95.length, 2);
  assert.ok(env.human_preference_rate.ci95[0] <= env.human_preference_rate.ci95[1],
    'ci95 sorted ascending');
  assert.equal(env.human_preference_rate.n_pairs, 600);
});

// ---------------------------------------------------------------------------
// 15) V2 weights / composite / ships preserved by the calibration block.
// ---------------------------------------------------------------------------
test('W810 #15 V2 weights and composite are unchanged by the calibration block', async () => {
  freshDir('t15');
  writePack('2026-04', makeRows({ n: 600, category: 'coding' }));
  const cal = await freshImport('src/kscore-calibration.js');
  cal.fitAndPersist(cal.loadPack('2026-Q2'));
  const { computeKScore, computeKScoreV2 } = await freshImport('src/kscore.js');
  const inputs = {
    accuracy: 0.97, size_bytes: 32 * 1024 * 1024,
    p50_latency_us: 1200, cost_usd_per_call: 0.0001, coverage: 0.92,
    holdout_accuracy: 0.93, teacher_holdout_accuracy: 0.96,
    subgroup_min_accuracy: 0.91, joules_per_call: 50, eval_set_drift: 0.04,
  };
  const v2 = computeKScoreV2(inputs);
  const calibrated = computeKScore({ ...inputs, calibration_category: 'coding' });
  assert.equal(v2.composite, calibrated.composite, 'composite preserved');
  assert.equal(v2.ships, calibrated.ships, 'ships decision preserved');
  assert.deepEqual(v2.weights, calibrated.weights, 'weights preserved');
  assert.equal(v2.spec, calibrated.spec, 'spec preserved');
  // And the new block IS present:
  assert.equal(calibrated.calibration_status, 'ok');
});

// ---------------------------------------------------------------------------
// 16) recalibrate script: missing pack -> exit code 2.
// ---------------------------------------------------------------------------
test('W810 #16 scripts/recalibrate-kscore.cjs exit-code-2 on missing pack', async () => {
  freshDir('t16');
  const script = path.join(REPO_ROOT, 'scripts', 'recalibrate-kscore.cjs');
  const res = spawnSync(process.execPath, [script, '--period', '2026-Q2', '--json'], {
    env: { ...process.env, KOLM_DATA_DIR: process.env.KOLM_DATA_DIR },
    encoding: 'utf8',
  });
  assert.equal(res.status, 2, `expected exit 2, got ${res.status}, stderr=${res.stderr}`);
  const parsed = JSON.parse(res.stdout.trim() || '{}');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, 'pack_not_found');
});

// ---------------------------------------------------------------------------
// 17) Exported version constants are stable.
// ---------------------------------------------------------------------------
test('W810 #17 CALIBRATION_VERSION + BRADLEY_TERRY_SPEC stable strings', async () => {
  freshDir('t17');
  const cal = await freshImport('src/kscore-calibration.js');
  const bt = await freshImport('src/bradley-terry.js');
  assert.equal(cal.CALIBRATION_VERSION, 'w810-v1');
  assert.equal(bt.BRADLEY_TERRY_SPEC, 'kolm-bradley-terry-1');
  assert.equal(cal.MIN_PAIRS_PER_CATEGORY, 500);
});

// ---------------------------------------------------------------------------
// 18) Period normalization equivalence.
// ---------------------------------------------------------------------------
test("W810 #18 calibrationPackPath('2026-Q2') === calibrationPackPath('2026-04')", async () => {
  freshDir('t18');
  const { calibrationPackPath, periodToCalibrationPackId } = await freshImport('src/kscore-calibration.js');
  const a = calibrationPackPath('2026-Q2');
  const b = calibrationPackPath('2026-04');
  assert.equal(a, b, `expected same file path, got\n  ${a}\nvs\n  ${b}`);
  // And both map to the same canonical pack id.
  assert.equal(periodToCalibrationPackId('2026-Q2'), '2026-Q2');
  assert.equal(periodToCalibrationPackId('2026-04'), '2026-Q2');
});
