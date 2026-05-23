// W810-1 / W810-3 — K-Score external calibration pack loader + mapping exporter.
//
// Spec recap (verbatim from master plan §W810):
//   - Calibration pack file: ~/.kolm/calibration-pack-YYYY-MM.jsonl
//   - Row shape: {pair_id, prompt, response_a, response_b,
//                 human_preference:'a'|'b'|'tie', task_category}
//   - Categories the public methodology page surfaces:
//       coding, writing, analysis, support
//     plus the pooled curve across all categories.
//   - Mapping persisted at ~/.kolm/kscore-calibration.json
//   - Honest contract: per-category mapping ONLY emitted when n>=500 pairs;
//     otherwise that slot reports 'insufficient_data' verbatim (never silently
//     falls back to the pooled estimate).
//
// The actual envelope surfacing lives in src/kscore.js (W810-4) — this module
// is the data layer only.
//
// Test seam: KOLM_DATA_DIR overrides ~/.kolm (same pattern as event-store).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fitBradleyTerry, BRADLEY_TERRY_SPEC } from './bradley-terry.js';

export const CALIBRATION_VERSION = 'w810-v1';

// Minimum pairs required IN A CATEGORY before we publish a calibration
// mapping for that category. Below this, the methodology page surfaces
// 'insufficient_data' and the K-Score envelope reports the same code.
export const MIN_PAIRS_PER_CATEGORY = 500;

// Allowlist of canonical category names — surfaces of the methodology page
// pin these four explicitly so that an unrelated 'random' label in a pack
// can't quietly create a new public curve.
export const CALIBRATION_CATEGORIES = Object.freeze(['coding', 'writing', 'analysis', 'support']);

// ---------------------------------------------------------------------------
// Path helpers (KOLM_DATA_DIR aware — never touches the real ~/.kolm in tests)
// ---------------------------------------------------------------------------

function _home() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

export function _dataDir() {
  if (process.env.KOLM_DATA_DIR) return path.resolve(process.env.KOLM_DATA_DIR);
  return path.join(_home(), '.kolm');
}

export function calibrationPackPath(period) {
  // period is 'YYYY-MM' OR 'YYYY-Qn'. We accept both because the master plan
  // shows 'calibration_pack_id:"2026-Q2"' in the K-Score envelope shape.
  // Internally the JSONL convention is YYYY-MM; we also accept the quarter
  // form (Q1=01,Q2=04,Q3=07,Q4=10 as the canonical month per ISO quarter).
  const norm = _normalizePeriod(period);
  return path.join(_dataDir(), `calibration-pack-${norm}.jsonl`);
}

export function calibrationMappingPath() {
  return path.join(_dataDir(), 'kscore-calibration.json');
}

function _normalizePeriod(period) {
  if (typeof period !== 'string') throw new TypeError('period must be a string');
  // W604 anti-brittleness: regex+threshold for version forms.
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return period;     // YYYY-MM
  if (/^\d{4}-Q[1-4]$/.test(period)) {
    const yr = period.slice(0, 4);
    const q = Number(period[6]);
    const mm = String(1 + (q - 1) * 3).padStart(2, '0');
    return `${yr}-${mm}`;
  }
  throw new TypeError(`period '${period}' must match YYYY-MM or YYYY-Qn`);
}

export function periodToCalibrationPackId(period) {
  // The mapping JSON + the K-Score envelope both report calibration_pack_id
  // in the human-friendly 'YYYY-Qn' form. This function maps either input
  // shape back to that canonical form.
  if (/^\d{4}-Q[1-4]$/.test(period)) return period;
  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) {
    const yr = period.slice(0, 4);
    const mm = Number(period.slice(5, 7));
    const q = Math.floor((mm - 1) / 3) + 1;
    return `${yr}-Q${q}`;
  }
  throw new TypeError(`period '${period}' must match YYYY-MM or YYYY-Qn`);
}

// ---------------------------------------------------------------------------
// W810-1: pack loader.
// ---------------------------------------------------------------------------

export function loadPack(period) {
  const file = calibrationPackPath(period);
  if (!fs.existsSync(file)) {
    return { ok: false, error: 'pack_not_found', detail: file, period, rows: [], n: 0 };
  }
  const txt = fs.readFileSync(file, 'utf8');
  const rows = [];
  const errors = [];
  let lineNo = 0;
  for (const raw of txt.split(/\r?\n/)) {
    lineNo += 1;
    const line = raw.trim();
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); }
    catch (e) {
      errors.push({ line: lineNo, error: 'json_parse_failed', detail: String(e && e.message || e) });
      continue;
    }
    if (typeof row !== 'object' || row == null) {
      errors.push({ line: lineNo, error: 'row_not_object' });
      continue;
    }
    if (!row.pair_id || typeof row.pair_id !== 'string') {
      errors.push({ line: lineNo, error: 'missing_pair_id' });
      continue;
    }
    if (typeof row.prompt !== 'string') {
      errors.push({ line: lineNo, error: 'missing_prompt' });
      continue;
    }
    if (typeof row.response_a !== 'string' || typeof row.response_b !== 'string') {
      errors.push({ line: lineNo, error: 'missing_responses' });
      continue;
    }
    if (row.human_preference !== 'a' && row.human_preference !== 'b' && row.human_preference !== 'tie') {
      errors.push({ line: lineNo, error: 'bad_human_preference', detail: row.human_preference });
      continue;
    }
    if (!row.task_category || typeof row.task_category !== 'string') {
      errors.push({ line: lineNo, error: 'missing_task_category' });
      continue;
    }
    rows.push(row);
  }
  return {
    ok: true,
    period: periodToCalibrationPackId(period),
    pack_file: file,
    rows,
    n: rows.length,
    parse_errors: errors,
    version: CALIBRATION_VERSION,
  };
}

// ---------------------------------------------------------------------------
// W810-3: fit-and-persist.
// ---------------------------------------------------------------------------
//
// Strategy:
//   1) Split pack rows by task_category.
//   2) For each category with n >= MIN_PAIRS_PER_CATEGORY:
//        - Map every row to a BT pair where 'a' = response_a's model id and
//          'b' = response_b's model id. When a row doesn't carry an explicit
//          model id (most calibration packs in the wild don't — they treat
//          response_a / response_b as anonymous candidates), we synthesize
//          stable ids from pair_id + 'a' / 'b'. The BT fit then gives us a
//          per-response skill estimate.
//        - Fit logistic regression of human_preference_rate against the
//          BT-predicted-win-prob across binned predictions. The slope+intercept
//          of that regression IS the calibration mapping: callers feed in a
//          raw K-Score (or BT-predicted prob), get back a calibrated estimate
//          of the realized human preference rate.
//   3) Always also fit the pooled curve across all categories.
//   4) For categories that fall below the threshold OR fail to fit, write
//      {status:'insufficient_data', n_pairs:<actual>} so the methodology page
//      can surface the gap verbatim.
//
// Calibration regression: simple bin-and-fit (10 equal-width bins on [0,1])
// of empirical rate vs midpoint, weighted by bin count. Slope, intercept,
// and Wald CI95 on the slope are persisted; the K-Score envelope surfacing
// (W810-4) projects ci95 to a per-prediction CI.

function _logit(p) {
  // Maps probability -> logit. Clamp to keep things finite when bins have 0/1.
  const q = Math.max(1e-6, Math.min(1 - 1e-6, p));
  return Math.log(q / (1 - q));
}

function _expit(x) {
  if (x >= 0) {
    const z = Math.exp(-x);
    return 1 / (1 + z);
  }
  const z = Math.exp(x);
  return z / (1 + z);
}

function _rowKeyFor(r, side) {
  // BT needs item-level skill, so the row "side" must collapse onto a stable
  // identifier that REPEATS across rows. Priority chain:
  //   1) explicit model id (response_a_model / response_b_model) when supplied
  //   2) explicit response_a_id / response_b_id
  //   3) hash bucket of the response text (mod 8) so similar candidates share
  //      a BT skill estimate even when the pack didn't carry model ids
  // Falling back per-pair-unique ids would make BT degenerate (every item
  // appears in exactly one comparison, the ridge dominates, grad stays
  // ridge*theta and the fitter never reaches 1e-6 on >100 pairs).
  const k1 = side === 'a' ? r.response_a_model : r.response_b_model;
  if (typeof k1 === 'string' && k1) return 'M:' + k1;
  const k2 = side === 'a' ? r.response_a_id : r.response_b_id;
  if (typeof k2 === 'string' && k2) return 'I:' + k2;
  const text = side === 'a' ? r.response_a : r.response_b;
  return 'H:' + (_hashBucket(text, 8));
}

function _hashBucket(s, mod) {
  let h = 0;
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(31, h) + str.charCodeAt(i) | 0;
  }
  return ((h % mod) + mod) % mod;
}

function _rowsToPairs(rows) {
  // Map each row to a BT pair against item-level keys. See _rowKeyFor for
  // the priority chain; we keep tie rows because tieRupp half-credit is the
  // documented behavior of the fitter and dropping them would bias the
  // calibration toward decisive prefs only.
  const pairs = [];
  for (const r of rows) {
    const a = _rowKeyFor(r, 'a');
    const b = _rowKeyFor(r, 'b');
    if (a === b) continue;     // self-pair has no information
    pairs.push({ a, b, pref: r.human_preference });
  }
  return pairs;
}

function _fitCalibrationCurve(rows) {
  // Returns {slope, intercept, ci95_low, ci95_high, n_pairs, bt_iter,
  // bt_grad_inf, bt_converged, status, message?}.
  if (rows.length < MIN_PAIRS_PER_CATEGORY) {
    return {
      status: 'insufficient_data',
      n_pairs: rows.length,
      threshold: MIN_PAIRS_PER_CATEGORY,
      message: `n=${rows.length} below threshold ${MIN_PAIRS_PER_CATEGORY}`,
    };
  }
  const pairs = _rowsToPairs(rows);
  const fit = fitBradleyTerry(pairs);
  if (!fit.converged) {
    return {
      status: 'fit_did_not_converge',
      n_pairs: rows.length,
      bt_iter: fit.iter,
      bt_grad_inf: fit.grad_inf,
      message: 'BT fitter exhausted max_iter without reaching grad_tol',
    };
  }

  // Reduce each row to (raw_pred_prob_a_beats_b, observed_outcome) and bin.
  // observed_outcome: 1 if pref='a', 0 if pref='b', 0.5 if tie.
  // The lookup MUST use the same key-derivation as _rowsToPairs (priority:
  // model id -> response id -> hash bucket); otherwise pred is identically 0.
  const samples = [];
  for (const r of rows) {
    const ka = _rowKeyFor(r, 'a');
    const kb = _rowKeyFor(r, 'b');
    if (ka === kb) continue;
    const ta = fit.theta[ka] || 0;
    const tb = fit.theta[kb] || 0;
    const pred = _expit(ta - tb);
    const obs = r.human_preference === 'a' ? 1 : r.human_preference === 'b' ? 0 : 0.5;
    samples.push({ pred, obs });
  }
  // 10 bins on [0,1].
  const nb = 10;
  const bins = new Array(nb).fill(null).map(() => ({ n: 0, sumObs: 0, sumPred: 0 }));
  for (const s of samples) {
    let b = Math.floor(s.pred * nb);
    if (b >= nb) b = nb - 1;
    if (b < 0) b = 0;
    bins[b].n += 1;
    bins[b].sumObs += s.obs;
    bins[b].sumPred += s.pred;
  }
  // Use logit(midpoint_pred) -> logit(rate) regression. Bins with 0 entries
  // are dropped. Weighted least squares with weights = bin count.
  const xs = [];
  const ys = [];
  const ws = [];
  for (const b of bins) {
    if (b.n === 0) continue;
    const meanPred = b.sumPred / b.n;
    const meanObs = b.sumObs / b.n;
    xs.push(_logit(meanPred));
    ys.push(_logit(meanObs));
    ws.push(b.n);
  }
  if (xs.length < 2) {
    return {
      status: 'fit_did_not_converge',
      n_pairs: rows.length,
      message: `Only ${xs.length} non-empty bin(s); cannot fit calibration slope`,
    };
  }
  // Weighted linear regression y = slope * x + intercept.
  let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
  for (let i = 0; i < xs.length; i++) {
    const w = ws[i];
    sw += w;
    swx += w * xs[i];
    swy += w * ys[i];
    swxx += w * xs[i] * xs[i];
    swxy += w * xs[i] * ys[i];
  }
  const denom = sw * swxx - swx * swx;
  if (Math.abs(denom) < 1e-9) {
    return {
      status: 'fit_did_not_converge',
      n_pairs: rows.length,
      message: 'Calibration regression is singular (all x identical)',
    };
  }
  const slope = (sw * swxy - swx * swy) / denom;
  const intercept = (swy - slope * swx) / sw;
  // Residual variance + slope SE via standard WLS Wald.
  let rss = 0;
  for (let i = 0; i < xs.length; i++) {
    const yhat = slope * xs[i] + intercept;
    const r2 = (ys[i] - yhat);
    rss += ws[i] * r2 * r2;
  }
  const dof = Math.max(1, xs.length - 2);
  const sigma2 = rss / dof;
  const slopeVar = sigma2 * (sw / denom);
  const slopeSE = Math.sqrt(Math.max(slopeVar, 0));
  // 95% Wald CI: slope +/- 1.96 * SE
  const ci95_low = slope - 1.96 * slopeSE;
  const ci95_high = slope + 1.96 * slopeSE;
  return {
    status: 'ok',
    slope: Number(slope.toFixed(6)),
    intercept: Number(intercept.toFixed(6)),
    slope_se: Number(slopeSE.toFixed(6)),
    ci95_low: Number(ci95_low.toFixed(6)),
    ci95_high: Number(ci95_high.toFixed(6)),
    n_pairs: rows.length,
    n_bins: xs.length,
    bt_iter: fit.iter,
    bt_grad_inf: Number(fit.grad_inf.toExponential(3)),
    bt_converged: fit.converged,
    bt_spec: BRADLEY_TERRY_SPEC,
  };
}

export function fitAndPersist(pack) {
  if (!pack || !pack.ok) {
    throw new TypeError('fitAndPersist: pack must be a successful loadPack() result');
  }
  const byCategory = {};
  const byCategoryRows = {};
  for (const cat of CALIBRATION_CATEGORIES) byCategoryRows[cat] = [];
  for (const r of pack.rows) {
    if (byCategoryRows[r.task_category]) byCategoryRows[r.task_category].push(r);
  }
  for (const cat of CALIBRATION_CATEGORIES) {
    byCategory[cat] = _fitCalibrationCurve(byCategoryRows[cat]);
  }
  const pooled = _fitCalibrationCurve(pack.rows);
  const mapping = {
    version: CALIBRATION_VERSION,
    calibration_pack_id: pack.period,
    by_category: byCategory,
    pooled,
    n_pairs: pack.n,
    fitted_at: new Date().toISOString(),
  };
  const out = calibrationMappingPath();
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(mapping, null, 2) + '\n', 'utf8');
  return { ok: true, mapping_path: out, mapping };
}

// ---------------------------------------------------------------------------
// Loader for the persisted mapping (used by src/kscore.js W810-4 surfacing).
// ---------------------------------------------------------------------------

export function loadMapping() {
  const f = calibrationMappingPath();
  if (!fs.existsSync(f)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (data && typeof data === 'object' && data.version === CALIBRATION_VERSION) return data;
    return null;
  } catch {
    return null;
  }
}

// Apply a fitted calibration curve to a raw K-Score (or BT predicted prob)
// and produce {point, ci95_low, ci95_high}. Returns null when the per-category
// slot is insufficient_data — callers MUST surface 'insufficient_data' rather
// than silently fall back to the pooled estimate (honest contract).
export function applyCalibration(mapping, category, kscore) {
  if (mapping == null) return null;
  const slot = (mapping.by_category && mapping.by_category[category]) || null;
  if (slot == null || slot.status !== 'ok') {
    return {
      status: slot ? slot.status : 'unknown_category',
      n_pairs: slot ? slot.n_pairs : 0,
    };
  }
  const x = _logit(Math.max(0, Math.min(1, kscore)));
  const point = _expit(slot.slope * x + slot.intercept);
  const lo = _expit(slot.ci95_low * x + slot.intercept);
  const hi = _expit(slot.ci95_high * x + slot.intercept);
  // The CI endpoints can land out of order when the slope CI brackets 0;
  // sort them so [low, high] is always monotone.
  const ci95_low = Math.min(lo, hi);
  const ci95_high = Math.max(lo, hi);
  return {
    status: 'ok',
    point: Number(point.toFixed(4)),
    ci95_low: Number(ci95_low.toFixed(4)),
    ci95_high: Number(ci95_high.toFixed(4)),
    n_pairs: slot.n_pairs,
  };
}
