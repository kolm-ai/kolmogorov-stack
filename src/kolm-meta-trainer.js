// W832 - kolm-meta meta-distillation model.
//
// HONEST: this is a TOY gradient-boosting regressor. Each tree is a single
// best-split decision stump over a numeric feature; the ensemble is the sum
// of stump predictions scaled by learning_rate. There is NO column subsampling,
// NO multi-depth splits, NO row subsampling, NO regularization. It is a
// faithful but small GBM - production-scale meta-distillation should move to
// apps/trainer/meta_xgb.py via a worker shell (same W786-style honesty contract
// the other heavy-ML primitives use; see workers/multimodal-redact-audio for
// the worker-shell template).
//
// Bounds we DO NOT pretend to:
//   - We are not XGBoost / LightGBM. Performance on big training sets will
//     trail real GBMs because we use stumps (depth=1), not depth-3 trees.
//   - We do not handle categorical features natively - strings are hashed to
//     stable integers and treated as ordinals (lossy but deterministic).
//   - We do not output calibrated confidence - `confidence` is a heuristic
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

// W921 - real depth-D gradient-boosted regressor (src/gbm-regressor.js), wired
// in BEHIND this module's existing train/predict API as an OPT-IN engine. The
// default path remains the W832 toy stump GBM, so every existing caller + test
// behaves identically by default. The GBM engine activates only when explicitly
// requested (opts.engine==='gbm' / KOLM_META_ENGINE=gbm) AND there are enough
// rows to fit it; below the row floor it falls back to the stump automatically.
import * as gbm from './gbm-regressor.js';

export const META_VERSION = 'w832-v1';

// W921 - opt-in engine selection. 'stump' (W832 default, unchanged) or 'gbm'
// (the real depth-D regressor). Env override lets an operator flip the engine
// without a code change; an explicit opts.engine wins over the env.
export const META_ENGINE_STUMP = 'stump';
export const META_ENGINE_GBM = 'gbm';

// Minimum training rows before the real GBM is worth fitting. Below this the
// engine falls back to the stump even when 'gbm' is requested, so a thin
// backfill never trains a deep tree on too little signal (and the determinism /
// holdout machinery in gbm-regressor stays well-conditioned).
export const MIN_ROWS_FOR_GBM_ENGINE = Number(process.env.KOLM_META_GBM_MIN_ROWS || 24);

function _resolveEngine(optEngine) {
  const want = String(optEngine || process.env.KOLM_META_ENGINE || META_ENGINE_STUMP).toLowerCase();
  return want === META_ENGINE_GBM ? META_ENGINE_GBM : META_ENGINE_STUMP;
}

// Frozen so a test can pin the exact feature contract - a re-ordering or rename
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

// GBM hyperparameters - small + honest. NOT XGBoost-tuned.
const N_TREES = 50;
const LEARNING_RATE = 0.1;
// Tree depth is fixed at 1 (stumps) - see honesty note at top of file.

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
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} // deliberate: cleanup
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
  try { fs.rmSync(_trainingRowsPath(), { force: true }); } catch (_) {} // deliberate: cleanup
  try { fs.rmSync(_defaultModelPath(), { force: true }); } catch (_) {} // deliberate: cleanup
}

// =============================================================================
// Feature coercion
// =============================================================================

// Categorical / string features get a stable hash → integer so the GBM splitter
// can treat them ordinally. Lossy by design (collisions possible) but
// deterministic - same string always lands on the same bucket.
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
  // Missing keys coerce to 0 (NOT NaN - never leak NaN downstream).
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
  // We require at least ONE of the required keys to be present - that is a
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
    // Defense-in-depth tenant fence - caller-provided filter MUST match.
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
// Honest: this is a brute-force O(N) scan over candidate splits - fine at
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
    // SSE = sum (y - mean)^2 - but we only care about RELATIVE SSE across
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
// W921 - real GBM engine (behind the same API).
//
// These helpers wrap src/gbm-regressor.js. The feature matrix + targets are the
// SAME ones the stump path builds (_coerceFeatures over META_FEATURES), so the
// GBM is a drop-in replacement for the per-target stump ensemble. Each target
// (kscore, compile_time, per-failure-class one-vs-rest) gets its own GBM model.
// The serialized output rides in additive model fields so the on-disk shape is a
// strict superset of the W832 model; inferKolmMeta routes by inspecting the
// stored engine tag.
// =============================================================================

// GBM hyperparameters for the meta-task. Conservative depth-3 with subsampling
// + L2 + early stopping (the gbm-regressor defaults already encode this, but we
// pin a seed so retrains are byte-deterministic - the W832 promise).
const GBM_META_OPTS = Object.freeze({
  max_depth: 3,
  n_trees: 200,
  learning_rate: 0.05,
  subsample: 0.8,
  colsample: 0.7,
  lambda: 1.0,
  gamma: 0.0,
  min_child_weight: 3,
  early_stopping_rounds: 20,
  seed: 1337,
  n_features: META_FEATURES.length,
});

function _trainOneTargetRealGBM(xs, ys) {
  // gbm.fit returns a serializable model object; keep it as-is in the meta model.
  return gbm.fit(xs, ys, GBM_META_OPTS);
}

function _predictRealGBM(model, xRow) {
  const v = gbm.predict(model, xRow);
  return Number.isFinite(v) ? v : 0;
}

// One-vs-rest failure classifier using real GBMs (mirrors _trainFailureClassifier).
function _trainFailureClassifierGBM(xs, failureModeRows) {
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
    gbms[lab] = _trainOneTargetRealGBM(xs, ys);
  }
  return { labels, gbms };
}

// Split-conformal calibration over an absolute-residual holdout.
//
// Q = the b-th order statistic of {|y_i - pred_i|}, b = ceil((1-alpha)(n+1)),
// which yields the distribution-free finite-sample marginal-coverage interval
// [pred-Q, pred+Q] at level 1-alpha (Angelopoulos & Bates 2021). When the
// calibration pool is too thin (b>n) Q is undefined and we report undercalibrated
// so the caller keeps its existing (point) band instead of a false-tight CI.
function _splitConformalCalibrate(model, xsCal, ysCal, alpha) {
  const a = Number.isFinite(Number(alpha)) && Number(alpha) > 0 && Number(alpha) < 1 ? Number(alpha) : 0.10;
  const scores = [];
  for (let i = 0; i < xsCal.length; i++) {
    const pred = _predictRealGBM(model, xsCal[i]);
    const y = Number(ysCal[i]);
    if (!Number.isFinite(pred) || !Number.isFinite(y)) continue;
    scores.push(Math.abs(y - pred));
  }
  scores.sort((x, y) => x - y);
  const n = scores.length;
  const b = Math.ceil((1 - a) * (n + 1));
  if (n === 0 || b > n) {
    return { Q: null, n_cal: n, alpha: a, coverage_target: 1 - a, undercalibrated: true };
  }
  return { Q: scores[b - 1], n_cal: n, alpha: a, coverage_target: 1 - a, undercalibrated: false };
}

// Build the GBM-engine meta model. Splits a deterministic calibration holdout
// (last calib_frac of the rows after a seeded shuffle handled by gbm-regressor's
// own internal split is for early-stopping; here we carve a SEPARATE conformal
// holdout so the interval is honest). Returns the model object to persist.
function _trainKolmMetaGBM({ xs, ysKscore, ysCompile, failureModeRows, nRows, alpha, calib_frac }) {
  const a = Number.isFinite(Number(alpha)) && Number(alpha) > 0 && Number(alpha) < 1 ? Number(alpha) : 0.10;
  const cf = Number.isFinite(Number(calib_frac)) && Number(calib_frac) > 0 && Number(calib_frac) < 0.9
    ? Number(calib_frac) : 0.3;

  // Deterministic conformal split: take the last cf-fraction as calibration.
  // (gbm-regressor's seeded PRNG handles the train-time early-stopping holdout
  // separately; this slice is only used to compute Q.)
  const nCal = Math.max(0, Math.min(nRows - 2, Math.floor(nRows * cf)));
  const nFit = nRows - nCal;

  const xsFit = xs.slice(0, nFit);
  const ysKFit = ysKscore.slice(0, nFit);
  const ysCFit = ysCompile.slice(0, nFit);
  const failFit = failureModeRows.slice(0, nFit);

  const kscoreGBM = _trainOneTargetRealGBM(xsFit, ysKFit);
  const compileGBM = _trainOneTargetRealGBM(xsFit, ysCFit);
  const failureClf = _trainFailureClassifierGBM(xsFit, failFit);

  // Conformal Q on the held-out calibration slice (kscore target only - the
  // interval the autopilot consumes is the K-Score interval).
  let conformal = { Q: null, n_cal: nCal, alpha: a, coverage_target: 1 - a, undercalibrated: true };
  if (nCal >= 2) {
    conformal = _splitConformalCalibrate(kscoreGBM, xs.slice(nFit), ysKscore.slice(nFit), a);
  }

  return { kscoreGBM, compileGBM, failureClf, conformal };
}

// =============================================================================
// Public train + infer
// =============================================================================

export function trainKolmMeta({ rows, model_path = null, engine = null, alpha = 0.10, calib_frac = 0.3 } = {}) {
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
  // W921 - engine selection. Default 'stump' (W832, unchanged byte-for-byte).
  // 'gbm' activates the real depth-D regressor BUT silently downgrades back to
  // the stump when there are too few rows to fit it, so a thin pool never trains
  // a deep tree (and the default behavior + existing tests are untouched).
  let resolvedEngine = _resolveEngine(engine);
  if (resolvedEngine === META_ENGINE_GBM && rows.length < MIN_ROWS_FOR_GBM_ENGINE) {
    resolvedEngine = META_ENGINE_STUMP;
  }

  let model;
  if (resolvedEngine === META_ENGINE_GBM) {
    const fit = _trainKolmMetaGBM({
      xs, ysKscore, ysCompile, failureModeRows,
      nRows: rows.length, alpha, calib_frac,
    });
    model = {
      schema: META_VERSION,
      engine: META_ENGINE_GBM,
      trained_at: new Date().toISOString(),
      n_train_rows: rows.length,
      feature_order: META_FEATURES.slice(),
      target_order: META_TARGETS.slice(),
      hyperparameters: {
        max_depth: GBM_META_OPTS.max_depth,
        n_trees: GBM_META_OPTS.n_trees,
        learning_rate: GBM_META_OPTS.learning_rate,
        subsample: GBM_META_OPTS.subsample,
        colsample: GBM_META_OPTS.colsample,
        lambda: GBM_META_OPTS.lambda,
        gamma: GBM_META_OPTS.gamma,
        min_child_weight: GBM_META_OPTS.min_child_weight,
        early_stopping_rounds: GBM_META_OPTS.early_stopping_rounds,
        seed: GBM_META_OPTS.seed,
      },
      kscore_gbm: fit.kscoreGBM,
      compile_time_gbm: fit.compileGBM,
      failure_classifier: fit.failureClf,
      // Split-conformal calibration of the K-Score interval (the distribution-
      // free, finite-sample replacement for the n/1000 confidence proxy).
      conformal: fit.conformal,
      honesty: {
        implementation: 'depth_d_gbm',
        engine: META_ENGINE_GBM,
        interval: 'split_conformal',
      },
    };
  } else {
    const kscoreGBM = _trainOneTargetGBM(xs, ysKscore);
    const compileGBM = _trainOneTargetGBM(xs, ysCompile);
    const failureClf = _trainFailureClassifier(xs, failureModeRows);

    model = {
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
  }
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
  return {
    ok: true,
    model,
    model_path: outPath,
    version: META_VERSION,
    // Additive: which engine actually trained + the conformal block (gbm only).
    engine: resolvedEngine,
    conformal: (resolvedEngine === META_ENGINE_GBM) ? model.conformal : null,
  };
}

// Engine-aware single-target inference. A 'gbm'-tagged model predicts through
// gbm-regressor; otherwise the legacy stump path. Never returns NaN.
function _predictTargetForModel(metaModel, targetModel, xRow) {
  if (!targetModel) return 0;
  if (metaModel && metaModel.engine === META_ENGINE_GBM) {
    return _predictRealGBM(targetModel, xRow);
  }
  return _predictGBM(targetModel, xRow);
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
  // Schema fence - if the on-disk model was trained under a different feature
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
  const kscore_predicted = _predictTargetForModel(model, model.kscore_gbm, x);
  const compile_time_s_predicted = _predictTargetForModel(model, model.compile_time_gbm, x);
  // Failure mode: pick argmax among label scores. If no labels, return null.
  let failure_mode_predicted = null;
  let failure_mode_scores = {};
  if (model.failure_classifier && Array.isArray(model.failure_classifier.labels)) {
    let bestLab = null;
    let bestScore = -Infinity;
    for (const lab of model.failure_classifier.labels) {
      const clfModel = model.failure_classifier.gbms[lab];
      const score = clfModel ? _predictTargetForModel(model, clfModel, x) : 0;
      failure_mode_scores[lab] = score;
      if (score > bestScore) { bestScore = score; bestLab = lab; }
    }
    failure_mode_predicted = bestLab;
  }
  // Heuristic confidence: shrink toward 0 when training-set support is thin.
  // n=1000 → 1.0; n=100 → 0.1. NOT a calibrated posterior.
  const confidence = Math.max(0, Math.min(1, (model.n_train_rows || 0) / 1000));

  const out = {
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

  // W921 additive: for a GBM-engine model, attach the split-conformal K-Score
  // interval [pred-Q, pred+Q] clamped to [0,1] + coverage target. The legacy
  // `confidence` field is preserved untouched; this is a strict superset.
  out.engine = (model.engine === META_ENGINE_GBM) ? META_ENGINE_GBM : META_ENGINE_STUMP;
  if (model.engine === META_ENGINE_GBM && model.conformal
      && Number.isFinite(Number(model.conformal.Q)) && !model.conformal.undercalibrated) {
    const Q = Number(model.conformal.Q);
    const lo = Math.max(0, Math.min(1, kscore_predicted - Q));
    const hi = Math.max(0, Math.min(1, kscore_predicted + Q));
    out.ci = [lo, hi];
    out.conformal_Q = Q;
    out.coverage_target = Number(model.conformal.coverage_target);
    out.conformal_basis = 'split_conformal';
  } else if (model.engine === META_ENGINE_GBM) {
    // GBM but calibration pool too thin to certify coverage - honest signal.
    out.ci = null;
    out.conformal_Q = null;
    out.coverage_target = model.conformal ? Number(model.conformal.coverage_target) : null;
    out.conformal_basis = 'undercalibrated';
  }

  return out;
}

export const __internals = Object.freeze({
  _coerceFeatures,
  _hashStr,
  _bestStump,
  _trainOneTargetGBM,
  _predictGBM,
  _trainingRowsPath,
  _defaultModelPath,
  // W921 GBM engine internals.
  _resolveEngine,
  _trainOneTargetRealGBM,
  _predictRealGBM,
  _splitConformalCalibrate,
  _trainKolmMetaGBM,
});
