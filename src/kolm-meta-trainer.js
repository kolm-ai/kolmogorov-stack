// W832 — kolm-meta meta-distillation model.
//
// HONEST: this is a TOY gradient-boosting regressor. Each tree is a single
// best-split decision stump over a numeric feature; the ensemble is the sum
// of stump predictions scaled by learning_rate. There is NO column subsampling,
// NO multi-depth splits, NO row subsampling, NO regularization. It is a
// faithful but small GBM — production-scale meta-distillation should move to
// apps/trainer/meta_xgb.py via a worker shell (same W786-style honesty contract
// the other heavy-ML primitives use; see workers/multimodal-redact-audio for
// the worker-shell template).
//
// Bounds we DO NOT pretend to:
//   - We are not XGBoost / LightGBM. Performance on big training sets will
//     trail real GBMs because we use stumps (depth=1), not depth-3 trees.
//   - We do not handle categorical features natively — strings are hashed to
//     stable integers and treated as ordinals (lossy but deterministic).
//   - We do not output calibrated confidence — `confidence` is a heuristic
//     based on training-set support, NOT a posterior.
//
// What we DO promise:
//   - Pure JS, zero external deps, runs anywhere Node runs.
//   - Deterministic given identical training rows + identical FEATURE_ORDER.
//   - Tenant-fenced row reads (defense-in-depth filter inside readTrainingRows).
//   - Honest envelope on no-model / insufficient-data paths (no silent
//     fabrication, no NaN leakage).
//
// Integration: src/training-arch-advisor.js (W716) calls inferKolmMeta when
// n_rows() >= MIN_ROWS_FOR_META. Below that floor, the rule-based recommender
// is the authority and the envelope carries {meta_insufficient_data:true, rows}.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const META_VERSION = 'w832-v1';

// Frozen so a test can pin the exact feature contract — a re-ordering or rename
// would invalidate any persisted model and the test catches it.
export const META_FEATURES = Object.freeze([
  'capture_count',
  'capture_diversity',
  'avg_input_tokens',
  'avg_output_tokens',
  'teacher_class',
  'task_type',
  'hw_tier',
  'has_reasoning',
  'has_tool_use',
  'has_multimodal',
]);

export const META_TARGETS = Object.freeze([
  'kscore_predicted',
  'compile_time_s_predicted',
  'failure_mode_predicted',
]);

// Below this row count the rule-based recommender stays the authority.
// Spec pin: W832-4. Keep configurable via env for emergency override.
export const MIN_ROWS_FOR_META = Number(process.env.KOLM_META_MIN_ROWS || 1000);

// GBM hyperparameters — small + honest. NOT XGBoost-tuned.
const N_TREES = 50;
const LEARNING_RATE = 0.1;
// Tree depth is fixed at 1 (stumps) — see honesty note at top of file.

// =============================================================================
// Paths
// =============================================================================

function _home() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}
function _kolmDir() {
  return process.env.KOLM_DATA_DIR
    ? path.resolve(process.env.KOLM_DATA_DIR)
    : path.join(_home(), '.kolm');
}
function _metaTrainingDir() {
  const d = path.join(_kolmDir(), 'meta-training');
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}
function _trainingRowsPath() {
  return path.join(_metaTrainingDir(), 'rows.jsonl');
}
function _defaultModelPath() {
  return path.join(_kolmDir(), 'meta-model.json');
}

// =============================================================================
// Test helpers
// =============================================================================

export function resetForTests() {
  // Wipe both the rows file and the default model file. Idempotent.
  try { fs.rmSync(_trainingRowsPath(), { force: true }); } catch (_) {}
  try { fs.rmSync(_defaultModelPath(), { force: true }); } catch (_) {}
}

// =============================================================================
// Feature coercion
// =============================================================================

// Categorical / string features get a stable hash → integer so the GBM splitter
// can treat them ordinally. Lossy by design (collisions possible) but
// deterministic — same string always lands on the same bucket.
function _hashStr(s) {
  const h = crypto.createHash('sha256').update(String(s || '')).digest();
  // 32-bit unsigned int, then map to [0, 1000) so the splitter has reasonable
  // numeric range and we don't bias toward huge magnitudes.
  return (h.readUInt32BE(0) % 1000);
}

function _toNumber(v) {
  if (v == null) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  // Strings → hash to stable ordinal.
  return _hashStr(v);
}

function _coerceFeatures(featuresObj) {
  // Returns a [number, number, ...] vector ALIGNED to META_FEATURES order.
  // Missing keys coerce to 0 (NOT NaN — never leak NaN downstream).
  const out = new Array(META_FEATURES.length);
  for (let i = 0; i < META_FEATURES.length; i++) {
    const key = META_FEATURES[i];
    out[i] = _toNumber(featuresObj && featuresObj[key]);
  }
  return out;
}

function _validateFeatures(featuresObj) {
  if (!featuresObj || typeof featuresObj !== 'object') {
    throw Object.assign(new Error('features must be an object'), {
      code: 'features_required',
    });
  }
  // We require at least ONE of the required keys to be present — that is a
  // weak contract but it catches the "caller passed {} by mistake" case.
  const present = META_FEATURES.filter((k) => featuresObj[k] != null);
  if (present.length === 0) {
    throw Object.assign(
      new Error('features missing all of: ' + META_FEATURES.join(', ')),
      { code: 'features_required' },
    );
  }
}

// =============================================================================
// Row persistence
// =============================================================================

export function appendTrainingRow({
  tenant_id = 'local',
  run_id = null,
  features = null,
  observed = null,
} = {}) {
  _validateFeatures(features);
  if (!observed || typeof observed !== 'object') {
    throw Object.assign(new Error('observed must be an object'), {
      code: 'observed_required',
    });
  }
  const row = {
    schema: META_VERSION,
    tenant_id: String(tenant_id || 'local'),
    run_id: run_id ? String(run_id) : null,
    features: { ...features },
    observed: {
      kscore: Number.isFinite(Number(observed.kscore)) ? Number(observed.kscore) : null,
      compile_time_s: Number.isFinite(Number(observed.compile_time_s))
        ? Number(observed.compile_time_s)
        : null,
      failure_modes: Array.isArray(observed.failure_modes)
        ? observed.failure_modes.map(String)
        : [],
    },
    ts: new Date().toISOString(),
  };
  const line = JSON.stringify(row) + '\n';
  fs.appendFileSync(_trainingRowsPath(), line);
  return { ok: true, version: META_VERSION, row };
}

export function readTrainingRows({ tenant_id = null, limit = null } = {}) {
  const p = _trainingRowsPath();
  if (!fs.existsSync(p)) return [];
  let text;
  try { text = fs.readFileSync(p, 'utf8'); } catch (_) { return []; }
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln) continue;
    let row;
    try { row = JSON.parse(ln); } catch (_) { continue; }
    if (!row || typeof row !== 'object') continue;
    // Defense-in-depth tenant fence — caller-provided filter MUST match.
    if (tenant_id != null && String(row.tenant_id) !== String(tenant_id)) continue;
    out.push(row);
    if (limit != null && out.length >= limit) break;
  }
  return out;
}

export function n_rows({ tenant_id = null } = {}) {
  return readTrainingRows({ tenant_id }).length;
}

// =============================================================================
// Toy GBM
// =============================================================================

// Find the best single-split stump for (xs, residuals) on a given column.
// Returns {split_value, left_pred, right_pred, sse} for the column.
// Honest: this is a brute-force O(N) scan over candidate splits — fine at
// N <= ~50000 which is well above MIN_ROWS_FOR_META, and well below the size
// where you'd want to move to apps/trainer/meta_xgb.py anyway.
function _bestStump(xs, residuals, colIdx) {
  // Build (value, residual) pairs and sort by value for the linear scan.
  const pairs = new Array(xs.length);
  for (let i = 0; i < xs.length; i++) pairs[i] = [xs[i][colIdx], residuals[i]];
  pairs.sort((a, b) => a[0] - b[0]);
  if (pairs.length < 2) return null;

  let totalSum = 0;
  for (let i = 0; i < pairs.length; i++) totalSum += pairs[i][1];

  let leftSum = 0;
  let bestSse = Infinity;
  let best = null;
  for (let i = 0; i < pairs.length - 1; i++) {
    leftSum += pairs[i][1];
    const rightSum = totalSum - leftSum;
    const leftN = i + 1;
    const rightN = pairs.length - leftN;
    // Skip degenerate splits where the value is identical to next (no split).
    if (pairs[i][0] === pairs[i + 1][0]) continue;
    const leftMean = leftSum / leftN;
    const rightMean = rightSum / rightN;
    // SSE = sum (y - mean)^2 — but we only care about RELATIVE SSE across
    // candidate splits, so we can compute the negative-of-variance shortcut:
    // SSE_total = sum_y2 - (leftSum^2/leftN + rightSum^2/rightN)
    // Lower is better → maximize (leftSum^2/leftN + rightSum^2/rightN).
    const gain = (leftSum * leftSum) / leftN + (rightSum * rightSum) / rightN;
    const sse = -gain;
    if (sse < bestSse) {
      bestSse = sse;
      best = {
        col: colIdx,
        split_value: (pairs[i][0] + pairs[i + 1][0]) / 2,
        left_pred: leftMean,
        right_pred: rightMean,
        sse,
      };
    }
  }
  return best;
}

function _bestStumpAnyCol(xs, residuals) {
  let best = null;
  for (let c = 0; c < META_FEATURES.length; c++) {
    const cand = _bestStump(xs, residuals, c);
    if (cand && (best == null || cand.sse < best.sse)) best = cand;
  }
  return best;
}

function _predictStump(stump, xRow) {
  return xRow[stump.col] <= stump.split_value ? stump.left_pred : stump.right_pred;
}

function _trainOneTargetGBM(xs, ys) {
  // Initialize residuals = ys (constant baseline = 0 for simplicity; the
  // stump ensemble will learn the mean in the first tree).
  const trees = [];
  const residuals = ys.slice();
  for (let t = 0; t < N_TREES; t++) {
    const stump = _bestStumpAnyCol(xs, residuals);
    if (!stump) break;
    // Update residuals.
    for (let i = 0; i < xs.length; i++) {
      const pred = _predictStump(stump, xs[i]);
      residuals[i] -= LEARNING_RATE * pred;
    }
    trees.push(stump);
  }
  return { trees, learning_rate: LEARNING_RATE };
}

function _predictGBM(gbm, xRow) {
  let sum = 0;
  for (let i = 0; i < gbm.trees.length; i++) {
    sum += gbm.learning_rate * _predictStump(gbm.trees[i], xRow);
  }
  return sum;
}

// Build a discrete classifier for failure-mode by one-vs-rest stumps.
// Returns per-class GBM regressors fit to (1 if class matches else 0).
function _trainFailureClassifier(xs, failureModeRows) {
  // Pull distinct labels.
  const labelSet = new Set();
  for (const row of failureModeRows) {
    if (!Array.isArray(row)) continue;
    for (const lab of row) labelSet.add(String(lab));
  }
  const labels = Array.from(labelSet).sort();
  if (labels.length === 0) return { labels: [], gbms: {} };
  const gbms = {};
  for (const lab of labels) {
    const ys = new Array(xs.length);
    for (let i = 0; i < xs.length; i++) {
      ys[i] = (Array.isArray(failureModeRows[i]) && failureModeRows[i].includes(lab)) ? 1 : 0;
    }
    gbms[lab] = _trainOneTargetGBM(xs, ys);
  }
  return { labels, gbms };
}

// =============================================================================
// Public train + infer
// =============================================================================

export function trainKolmMeta({ rows, model_path = null } = {}) {
  if (!Array.isArray(rows)) {
    return { ok: false, error: 'rows_must_be_array', version: META_VERSION };
  }
  if (rows.length < 2) {
    return {
      ok: false,
      error: 'insufficient_rows',
      rows: rows.length,
      hint: 'need >=2 rows to train a stump GBM',
      version: META_VERSION,
    };
  }
  // Build feature matrix + target vectors.
  const xs = new Array(rows.length);
  const ysKscore = new Array(rows.length);
  const ysCompile = new Array(rows.length);
  const failureModeRows = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    xs[i] = _coerceFeatures(r.features || {});
    const obs = r.observed || {};
    ysKscore[i] = Number.isFinite(Number(obs.kscore)) ? Number(obs.kscore) : 0;
    ysCompile[i] = Number.isFinite(Number(obs.compile_time_s)) ? Number(obs.compile_time_s) : 0;
    failureModeRows[i] = Array.isArray(obs.failure_modes) ? obs.failure_modes : [];
  }
  const kscoreGBM = _trainOneTargetGBM(xs, ysKscore);
  const compileGBM = _trainOneTargetGBM(xs, ysCompile);
  const failureClf = _trainFailureClassifier(xs, failureModeRows);

  const model = {
    schema: META_VERSION,
    trained_at: new Date().toISOString(),
    n_train_rows: rows.length,
    feature_order: META_FEATURES.slice(),
    target_order: META_TARGETS.slice(),
    hyperparameters: { n_trees: N_TREES, learning_rate: LEARNING_RATE, max_depth: 1 },
    kscore_gbm: kscoreGBM,
    compile_time_gbm: compileGBM,
    failure_classifier: failureClf,
    // Document the honest bounds INSIDE the model file so anyone inspecting
    // it knows it is not XGBoost.
    honesty: {
      implementation: 'toy_stump_gbm',
      not_a_substitute_for: 'xgboost_or_lightgbm',
      production_path: 'apps/trainer/meta_xgb.py worker shell',
    },
  };
  const outPath = model_path || _defaultModelPath();
  try {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(model, null, 2));
  } catch (e) {
    return {
      ok: false,
      error: 'model_write_failed',
      detail: String(e && e.message || e),
      version: META_VERSION,
    };
  }
  return { ok: true, model, model_path: outPath, version: META_VERSION };
}

export function inferKolmMeta({ features, model_path = null } = {}) {
  const p = model_path || _defaultModelPath();
  if (!fs.existsSync(p)) {
    return {
      ok: false,
      status: 'no_model',
      hint: 'run `kolm meta retrain` once n_rows() >= ' + MIN_ROWS_FOR_META,
      version: META_VERSION,
    };
  }
  let model;
  try { model = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {
    return {
      ok: false,
      status: 'model_unreadable',
      detail: String(e && e.message || e),
      version: META_VERSION,
    };
  }
  // Schema fence — if the on-disk model was trained under a different feature
  // order, refuse to predict (silent re-ordering would silently corrupt).
  if (!Array.isArray(model.feature_order)
      || model.feature_order.length !== META_FEATURES.length
      || model.feature_order.some((k, i) => k !== META_FEATURES[i])) {
    return {
      ok: false,
      status: 'feature_order_mismatch',
      hint: 'model was trained with a different feature_order; retrain',
      version: META_VERSION,
    };
  }
  _validateFeatures(features);
  const x = _coerceFeatures(features);
  const kscore_predicted = _predictGBM(model.kscore_gbm, x);
  const compile_time_s_predicted = _predictGBM(model.compile_time_gbm, x);
  // Failure mode: pick argmax among label scores. If no labels, return null.
  let failure_mode_predicted = null;
  let failure_mode_scores = {};
  if (model.failure_classifier && Array.isArray(model.failure_classifier.labels)) {
    let bestLab = null;
    let bestScore = -Infinity;
    for (const lab of model.failure_classifier.labels) {
      const gbm = model.failure_classifier.gbms[lab];
      const score = gbm ? _predictGBM(gbm, x) : 0;
      failure_mode_scores[lab] = score;
      if (score > bestScore) { bestScore = score; bestLab = lab; }
    }
    failure_mode_predicted = bestLab;
  }
  // Heuristic confidence: shrink toward 0 when training-set support is thin.
  // n=1000 → 1.0; n=100 → 0.1. NOT a calibrated posterior.
  const confidence = Math.max(0, Math.min(1, (model.n_train_rows || 0) / 1000));
  return {
    ok: true,
    status: 'predicted',
    kscore_predicted,
    compile_time_s_predicted,
    failure_mode_predicted,
    failure_mode_scores,
    confidence,
    n_train_rows: model.n_train_rows || 0,
    version: META_VERSION,
  };
}

export const __internals = Object.freeze({
  _coerceFeatures,
  _hashStr,
  _bestStump,
  _trainOneTargetGBM,
  _predictGBM,
  _trainingRowsPath,
  _defaultModelPath,
});
