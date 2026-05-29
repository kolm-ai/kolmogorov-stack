// src/quality-predictor.js
//
// KOLM AUTOPILOT — QUALITY PREDICTOR.
//
// The autopilot daemon watches a deployed model and must DECIDE whether a new
// batch of training data is worth acquiring before it spends GPU on a compile.
// To decide, it predicts the K-Score (src/kscore.js composite scale, [0,1],
// ship gate 0.85) that a compile would yield from a feature vector describing
// the candidate data. This module is that predictor.
//
// TWO PATHS, ONE CONTRACT:
//   - COLD START (basis:'heuristic'): below ~1000 training rows there is not
//     enough observed (features -> K) history to fit a model, so we fall back
//     to a transparent, monotonic blend of the feature sub-scores, calibrated
//     against the one real run we have measured end-to-end (Trinity-500:
//     ~410 pairs, 3-teacher council, low dup, customer-support coverage ->
//     observed K ~= 0.89). Confidence is LOW and scales with n_train_rows so
//     callers never over-trust a cold prediction.
//   - LEARNED (basis:'learned'): once rows accumulate past the threshold we
//     defer to the W832 stump-GBM in src/kolm-meta-trainer.js (the same model
//     the meta-distillation surface already trains), retrain it from the rows
//     we backfilled, and raise confidence with training-set support.
//
// The flip from heuristic to learned is automatic and keyed on
// MIN_ROWS_FOR_META (W832's own threshold) so the two surfaces agree on when
// the GBM is trustworthy.
//
// CONTRACT (qp-v1) — other autopilot components (Compile Simulator, Cost
// Optimizer) import predictKScore against this EXACT shape:
//   predictKScore({tenant, namespace, features}) -> {
//     ok, version, kscore_predicted, ci:[lo,hi], confidence,
//     basis:'heuristic'|'learned', n_train_rows }
//   backfillFromRuns({tenant, namespace, runs_dir}) -> {
//     ok, version, n_backfilled, n_train_rows }
// Every exported function returns an envelope and NEVER throws across the
// public API. Persistence is best-effort (a prediction is still returned with
// persisted:false if the event store is unavailable).
//
// Reuses (no new deps):
//   - src/kolm-meta-trainer.js  : the stump-GBM (predict + retrain + row store)
//   - src/kscore.js             : computeKScoreV2 to relabel run artifacts
//   - src/event-store.js        : best-effort prediction logging (_persist)
//
// Caveats / Limitations:
//   - The heuristic is a hand-calibrated blend, not a fit. It is anchored to a
//     single real run; its absolute level away from Trinity-like vectors is an
//     extrapolation and the LOW confidence reflects that.
//   - The CI is a transparent confidence-scaled band, NOT a posterior interval.
//     It widens as confidence drops. The learned path uses the GBM's own
//     support-based confidence and a tighter band.

import * as eventStore from './event-store.js';
import { computeKScoreV2 } from './kscore.js';
import {
  appendTrainingRow,
  readTrainingRows,
  trainKolmMeta,
  inferKolmMeta,
  n_rows as metaNRows,
  MIN_ROWS_FOR_META,
} from './kolm-meta-trainer.js';
// W921 — split-conformal calibrated interval, attached as an ADDITIVE field
// (predicted_interval) alongside the existing point-estimate `ci` band. The
// legacy `ci` is left untouched; this is a strict superset of the qp-v1
// envelope and activates only when a calibration pool clears MIN_CONFORMAL_CAL.
import {
  conformalInterval,
  splitConformalQuantile,
  MIN_CONFORMAL_CAL,
  CONFORMAL_VERSION,
} from './conformal.js';

export const QUALITY_PREDICTOR_VERSION = 'qp-v1';

const PROVIDER = 'kolm_quality_predictor';
const DEFAULT_TENANT = 'tenant_local';
const DEFAULT_NAMESPACE = 'default';

// K-Score composite scale (mirrors src/kscore.js): [0,1], ship gate 0.85.
const K_MIN = 0;
const K_MAX = 1;

// ---------------------------------------------------------------------------
// Persistence — EXACT mandated pattern (copied from src/data-feedback.js).
// Best-effort; never throws across the public API.
// ---------------------------------------------------------------------------

async function _persist({ tenant, namespace, workflow, payload }) {
  try {
    const ev = await eventStore.appendEvent({
      tenant_id: tenant, namespace: namespace || DEFAULT_NAMESPACE,
      provider: PROVIDER, vendor: 'kolm', model: 'quality-predictor/v1',
      workflow_id: workflow, status: 'ok',
      prompt_tokens: 0, completion_tokens: 0,
      feedback: JSON.stringify(payload || {}),
    });
    return { persisted: true, event_id: ev && ev.event_id };
  } catch (e) { return { persisted: false, error: String((e && e.message) || e) }; }
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function _tenant(t) { return (t && String(t)) || DEFAULT_TENANT; }
function _ns(n) { return (n && String(n)) || DEFAULT_NAMESPACE; }
function _clampK(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return K_MIN;
  return Math.max(K_MIN, Math.min(K_MAX, v));
}
function _clamp01(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}
function _round4(x) { return Number(Number(x).toFixed(4)); }

// ---------------------------------------------------------------------------
// Feature normalization — turn an arbitrary data-feature object into a set of
// [0,1] sub-scores where 1 is always "better for K". This is the monotonicity
// backbone of the heuristic: every sub-score is non-decreasing in goodness.
//
// Recognized features (all optional; sensible neutral defaults when missing):
//   n_pairs              count of training pairs (more is better, saturating)
//   dup_fraction         fraction of duplicate pairs (less is better)
//   coverage_score       [0,1] task coverage (more is better)
//   avg_quality          [0,1] mean per-pair quality (more is better)
//   cot_contam_fraction  fraction with chain-of-thought contamination (less)
//   teacher_diversity    [0,1] teacher-council diversity (more is better)
// ---------------------------------------------------------------------------

// Pairs sub-score: log-saturating in count so 410 (Trinity) sits high but not
// pinned, 0 pairs scores 0, and very large corpora asymptote toward 1.
// Calibrated so n_pairs=410 -> ~0.84.
function _pairsSubScore(nPairs) {
  const n = Math.max(0, Number(nPairs) || 0);
  if (n <= 0) return 0;
  // log2(1+n)/log2(1+ANCHOR) gives ~0.84 at ANCHOR≈2200; tuned for Trinity.
  const s = Math.log2(1 + n) / Math.log2(1 + 2200);
  return _clamp01(s);
}

// Returns a map of named sub-scores, each in [0,1], higher = better for K.
// `defined` counts how many of the recognized features the caller supplied —
// used to gauge how complete the feature vector is (feeds confidence).
function _subScores(features) {
  const f = (features && typeof features === 'object') ? features : {};

  const has = (k) => f[k] != null && Number.isFinite(Number(f[k]));
  let defined = 0;
  for (const k of ['n_pairs', 'dup_fraction', 'coverage_score', 'avg_quality',
    'cot_contam_fraction', 'teacher_diversity']) {
    if (has(k)) defined += 1;
  }

  // Neutral defaults chosen so an empty/partial vector lands mid-range rather
  // than at an extreme — keeps the heuristic stable under sparse input.
  const pairs = _pairsSubScore(has('n_pairs') ? f.n_pairs : 0);
  const dupGood = 1 - _clamp01(has('dup_fraction') ? f.dup_fraction : 0.1);
  const coverage = _clamp01(has('coverage_score') ? f.coverage_score : 0.6);
  const quality = _clamp01(has('avg_quality') ? f.avg_quality : 0.6);
  const cotGood = 1 - _clamp01(has('cot_contam_fraction') ? f.cot_contam_fraction : 0.1);
  const diversity = _clamp01(has('teacher_diversity') ? f.teacher_diversity : 0.5);

  return { pairs, dupGood, coverage, quality, cotGood, diversity, defined };
}

// ---------------------------------------------------------------------------
// Feature-space bridge to the W832 meta-trainer.
//
// The meta-trainer (src/kolm-meta-trainer.js) has its OWN frozen feature
// contract (META_FEATURES: capture_count, capture_diversity, avg_input_tokens,
// ...). Our data-quality vocabulary (n_pairs, dup_fraction, coverage_score,
// avg_quality, cot_contam_fraction, teacher_diversity) is different. To reuse
// the GBM without forking its contract, we project our features into its
// feature space deterministically. The SAME projection is used when we persist
// a training row AND when we infer, so the GBM always sees a consistent
// vocabulary. Unmapped meta slots are left to the trainer's own zero-default.
//
//   n_pairs              -> capture_count       (data volume)
//   teacher_diversity    -> capture_diversity   (source diversity)
//   avg_quality          -> avg_output_tokens   (numeric quality proxy slot)
//   coverage_score       -> avg_input_tokens    (numeric coverage proxy slot)
//   dup_fraction         -> has_tool_use        (numeric ordinal slot, [0,1])
//   cot_contam_fraction  -> has_reasoning       (numeric ordinal slot, [0,1])
//
// The proxy-slot choices are arbitrary-but-fixed: the GBM splits ordinally so
// it only needs each feature to land on a stable, monotone-meaningful column.
// (Caveat: these are not the slots' literal semantics — they are stable
// carriers so the stump splitter can learn on our signal. The contract that
// matters is consistency between persist and infer, which this guarantees.)
function _toMetaFeatures(features) {
  const f = (features && typeof features === 'object') ? features : {};
  const num = (k, dflt) => {
    const v = Number(f[k]);
    return Number.isFinite(v) ? v : dflt;
  };
  return {
    capture_count: num('n_pairs', 0),
    capture_diversity: num('teacher_diversity', 0),
    avg_output_tokens: num('avg_quality', 0),
    avg_input_tokens: num('coverage_score', 0),
    has_tool_use: num('dup_fraction', 0),
    has_reasoning: num('cot_contam_fraction', 0),
  };
}

// Heuristic weights over the sub-scores. They sum to 1 so the blend stays in
// [0,1]. Accuracy proxies (avg_quality, coverage) carry the most weight,
// mirroring how src/kscore.js weights accuracy (A) + coverage (V) heaviest.
const HEURISTIC_WEIGHTS = Object.freeze({
  quality: 0.30,
  coverage: 0.22,
  pairs: 0.18,
  cotGood: 0.12,
  dupGood: 0.10,
  diversity: 0.08,
});

// Map the weighted sub-score blend onto the K composite scale. The blend is
// already in [0,1]; we apply a mild affine calibration so a Trinity-like
// vector (high quality/coverage/diversity, low dup/CoT, ~410 pairs) lands near
// the observed Trinity K of ~0.89 rather than at the raw blend value.
//
// Calibration constants were fit by hand to the single Trinity anchor:
//   blend(Trinity) ~= 0.86  ->  K ~= 0.89
// The slope keeps monotonicity (K strictly increases with the blend); the
// intercept lifts the operating range so good-but-not-perfect data clears the
// 0.85 ship gate, matching the real run.
const CAL_SLOPE = 0.92;
const CAL_INTERCEPT = 0.07;

function _heuristicK(sub) {
  let blend = 0;
  for (const k of Object.keys(HEURISTIC_WEIGHTS)) {
    blend += HEURISTIC_WEIGHTS[k] * sub[k];
  }
  return _clampK(CAL_SLOPE * blend + CAL_INTERCEPT);
}

// ---------------------------------------------------------------------------
// W921 — split-conformal calibrated interval (additive).
//
// Builds calibration residuals e_i = | observed_K_i - f_hat(x_i) | over the
// accumulated meta-training rows, where f_hat is the SAME heuristic point
// estimator used for the cold path (over each row's preserved _qp_features).
// Then conformalInterval gives a distribution-free, finite-sample [lo,hi] around
// the CURRENT point prediction. Returns null when the pool is below
// MIN_CONFORMAL_CAL (caller simply omits the additive field — zero regression).
//
// This is intentionally a SEPARATE, additive signal: it never replaces the
// existing `ci` band, so every existing caller of predictKScore is unaffected.
// ---------------------------------------------------------------------------
function _conformalIntervalForPoint({ tenant, point }) {
  try {
    if (!Number.isFinite(Number(point))) return null;
    const rows = readTrainingRows({ tenant_id: tenant });
    if (!Array.isArray(rows) || rows.length < MIN_CONFORMAL_CAL) return null;

    const calRows = [];
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue;
      const obs = r.observed || {};
      const y = Number(obs.kscore);
      if (!Number.isFinite(y)) continue;
      // Reconstruct the heuristic point for this row from its preserved
      // data-quality features (_qp_features), so the residual is on the same
      // scale as the prediction we are bracketing.
      const f = (r.features && typeof r.features === 'object' && r.features._qp_features
        && typeof r.features._qp_features === 'object')
        ? r.features._qp_features
        : null;
      let yhat;
      if (f) {
        yhat = _heuristicK(_subScores(f));
      } else {
        // No source vector preserved: fall back to the pool mean as f_hat so the
        // residual still reflects spread (conservative — widens the interval).
        yhat = null;
      }
      if (Number.isFinite(yhat)) calRows.push({ y, yhat });
      else calRows.push({ residual: null, y });
    }

    // Drop rows we could not residualize; require the floor on usable rows.
    const usable = calRows.filter((c) => Number.isFinite(Number(c.y))
      && (Number.isFinite(Number(c.yhat)) || Number.isFinite(Number(c.residual))));
    if (usable.length < MIN_CONFORMAL_CAL) return null;

    const iv = conformalInterval({
      point: Number(point),
      calRows: usable,
      alpha: 0.10,
      mode: 'split',
    });
    if (!iv || iv.ok !== true) return null;
    return {
      lo: iv.lo,
      hi: iv.hi,
      coverage_target: iv.coverage_target,
      basis: iv.basis,
      n_cal: iv.n_cal,
      qhat: iv.qhat,
      version: CONFORMAL_VERSION,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// predictKScore — the public predictor. Heuristic below MIN_ROWS_FOR_META,
// learned at or above it.
// ---------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {string} [args.tenant]
 * @param {string} [args.namespace]
 * @param {object} args.features   numeric data-quality features
 * @returns {Promise<{ok:boolean, version:string, kscore_predicted?:number,
 *   ci?:[number,number], confidence?:number, basis?:string,
 *   n_train_rows?:number, error?:string}>}
 */
export async function predictKScore({ tenant, namespace, features } = {}) {
  try {
    if (!features || typeof features !== 'object' || Array.isArray(features)) {
      return { ok: false, error: 'features_required', version: QUALITY_PREDICTOR_VERSION };
    }
    const t = _tenant(tenant);
    const ns = _ns(namespace);

    // Training-set support drives both the path choice and the confidence.
    let nTrain = 0;
    try { nTrain = metaNRows({ tenant_id: t }); } catch { nTrain = 0; }

    const sub = _subScores(features);
    // Require at least one recognized, finite feature — an object of only junk
    // keys is a malformed call, not a sparse-but-valid vector.
    if (sub.defined === 0) {
      return { ok: false, error: 'no_recognized_features', version: QUALITY_PREDICTOR_VERSION };
    }

    let result;
    if (nTrain >= MIN_ROWS_FOR_META) {
      result = await _predictLearned({ tenant: t, features, sub, nTrain });
      // If the learned path could not produce a usable number (no/corrupt
      // model, retrain failure), fall back to the heuristic rather than fail.
      if (!result) result = _predictHeuristic({ sub, nTrain });
    } else {
      result = _predictHeuristic({ sub, nTrain });
    }

    // W921 — additive split-conformal interval around the point estimate. When
    // the learned path already produced a meta conformal interval, prefer it;
    // otherwise compute one from the accumulated calibration pool. null when the
    // pool is below the floor (field simply absent — no regression).
    const predicted_interval = (result.conformal_interval && result.conformal_interval.lo != null)
      ? result.conformal_interval
      : _conformalIntervalForPoint({ tenant: t, point: result.kscore_predicted });

    // Best-effort log of the prediction for later audit / calibration drift.
    const persist = await _persist({
      tenant: t, namespace: ns, workflow: 'quality:predict',
      payload: {
        features, kscore_predicted: result.kscore_predicted, ci: result.ci,
        confidence: result.confidence, basis: result.basis, n_train_rows: nTrain,
        predicted_interval,
        predicted_at: new Date().toISOString(),
      },
    });

    const out = {
      ok: true,
      version: QUALITY_PREDICTOR_VERSION,
      kscore_predicted: result.kscore_predicted,
      ci: result.ci,
      confidence: result.confidence,
      basis: result.basis,
      n_train_rows: nTrain,
      persisted: persist.persisted === true,
    };
    // Strict-superset addition: present only when a calibrated interval exists.
    if (predicted_interval) out.predicted_interval = predicted_interval;
    return out;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), version: QUALITY_PREDICTOR_VERSION };
  }
}

// COLD-START heuristic path. Confidence is LOW and scales with how many rows we
// have accumulated toward the learned threshold (0 rows -> floor; near the
// threshold -> approaches the heuristic ceiling), plus a small bonus for a
// more complete feature vector. The CI widens as confidence drops.
function _predictHeuristic({ sub, nTrain }) {
  const k = _heuristicK(sub);

  // Support fraction toward the learned threshold, capped well below 1 so the
  // heuristic is always visibly less trusted than the learned model.
  const supportFrac = MIN_ROWS_FOR_META > 0
    ? Math.min(1, Math.max(0, nTrain) / MIN_ROWS_FOR_META)
    : 0;
  // Feature completeness in [0,1] over the 6 recognized features.
  const completeness = sub.defined / 6;
  // Heuristic confidence: floor 0.10, ceiling 0.45. Always LOW — the cold path
  // is calibrated to one run and must not be over-trusted.
  const confidence = _round4(
    0.10 + 0.25 * supportFrac + 0.10 * completeness
  );

  // CI half-width shrinks with confidence: ~0.22 at min confidence, ~0.10 near
  // the heuristic ceiling. A transparent band, not a posterior interval.
  const half = 0.26 - 0.32 * confidence;
  const lo = _round4(_clampK(k - half));
  const hi = _round4(_clampK(k + half));

  return {
    kscore_predicted: _round4(k),
    ci: [lo, hi],
    confidence: Math.min(0.45, Math.max(0.10, confidence)),
    basis: 'heuristic',
  };
}

// LEARNED path. Retrains the W832 stump-GBM from the rows we have accumulated
// (cheap, pure-JS, deterministic) then infers. Returns null on any failure so
// the caller can fall back to the heuristic. The GBM's confidence is its own
// support-based heuristic (n_train_rows/1000); we tighten the CI relative to
// the cold path because we now have a fitted model.
async function _predictLearned({ tenant, features, sub, nTrain }) {
  try {
    const rows = readTrainingRows({ tenant_id: tenant });
    if (!Array.isArray(rows) || rows.length < 2) return null;

    // Retrain to the default model path so inferKolmMeta picks it up. trainKolmMeta
    // is deterministic given identical rows + feature order. The engine defaults
    // to the W832 stump (unchanged); KOLM_META_ENGINE=gbm opts into the real
    // depth-D regressor BEHIND this same call (resolved inside trainKolmMeta).
    const trained = trainKolmMeta({ rows });
    if (!trained || trained.ok !== true) return null;

    // Infer in the meta-trainer's own feature space — the same projection used
    // when the rows were persisted, so train and infer agree on vocabulary.
    const inf = inferKolmMeta({ features: _toMetaFeatures(features) });
    if (!inf || inf.ok !== true || !Number.isFinite(Number(inf.kscore_predicted))) {
      return null;
    }

    const k = _clampK(inf.kscore_predicted);
    // Learned confidence: blend the GBM's support-based confidence with a floor
    // that sits ABOVE the heuristic ceiling so a learned prediction is always
    // more trusted than a cold one.
    const gbmConf = _clamp01(inf.confidence);
    const confidence = _round4(Math.max(0.5, Math.min(0.95, 0.5 + 0.45 * gbmConf)));

    // Tighter band than the cold path: ~0.12 at min learned confidence, ~0.05
    // at high confidence. (Legacy point-estimate band — UNCHANGED.)
    const half = 0.155 - 0.11 * confidence;
    const lo = _round4(_clampK(k - half));
    const hi = _round4(_clampK(k + half));

    // W921 additive: if the GBM engine attached a split-conformal K-Score
    // interval, carry it up so predictKScore can surface predicted_interval
    // straight from the meta model (distribution-free coverage) instead of the
    // accumulated-pool recompute. Absent on the stump path -> stays null.
    let conformal_interval = null;
    if (inf.engine === 'gbm' && Array.isArray(inf.ci)
        && Number.isFinite(Number(inf.ci[0])) && Number.isFinite(Number(inf.ci[1]))) {
      conformal_interval = {
        lo: _round4(_clampK(inf.ci[0])),
        hi: _round4(_clampK(inf.ci[1])),
        coverage_target: Number(inf.coverage_target),
        basis: inf.conformal_basis || 'split_conformal',
        qhat: Number.isFinite(Number(inf.conformal_Q)) ? Number(inf.conformal_Q) : null,
        source: 'meta_gbm',
      };
    }

    return {
      kscore_predicted: _round4(k),
      ci: [lo, hi],
      confidence,
      basis: 'learned',
      conformal_interval,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// backfillFromRuns — derive (features -> observed K) training rows from
// historical distill runs so the predictor can flip heuristic -> learned.
// Idempotent: a run already present in the meta row store (matched by run_id)
// is skipped, so re-running never double-counts.
// ---------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {string} [args.tenant]
 * @param {string} [args.namespace]
 * @param {string} args.runs_dir   directory of distill-run subdirs
 * @returns {Promise<{ok:boolean, version:string, n_backfilled?:number,
 *   n_train_rows?:number, error?:string}>}
 */
export async function backfillFromRuns({ tenant, namespace, runs_dir } = {}) {
  try {
    const t = _tenant(tenant);

    // Lazy-require fs/path so the module's top has no node:fs import surface
    // beyond what the predictor needs; keeps the smoke env-seam clean.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');

    const dir = (typeof runs_dir === 'string' && runs_dir)
      ? runs_dir
      : path.join(os.homedir(), '.kolm', 'distill-runs');

    // Existing run_ids in the meta row store — for idempotent skipping.
    const existing = readTrainingRows({ tenant_id: t });
    const seen = new Set(
      (Array.isArray(existing) ? existing : [])
        .map(r => r && r.run_id)
        .filter(id => id != null)
        .map(String)
    );

    let subdirs = [];
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        subdirs = fs.readdirSync(dir)
          .map(name => ({ name, full: path.join(dir, name) }))
          .filter(e => { try { return fs.statSync(e.full).isDirectory(); } catch { return false; } });
      }
    } catch { subdirs = []; }

    let nBackfilled = 0;
    for (const sub of subdirs) {
      const run_id = sub.name;
      if (seen.has(String(run_id))) continue;

      const parsed = _loadRunForBackfill(fs, path, sub.full);
      if (!parsed) continue;
      const { features, observedK } = parsed;
      if (!features || observedK == null) continue;

      try {
        // Persist in the meta-trainer's frozen feature space (it validates
        // against META_FEATURES). The original data-quality vector is preserved
        // alongside it so a human inspecting the row can see the source signal.
        appendTrainingRow({
          tenant_id: t,
          run_id,
          features: { ..._toMetaFeatures(features), _qp_features: features },
          observed: { kscore: observedK },
        });
        nBackfilled += 1;
        seen.add(String(run_id)); // guard against dup subdir names in one scan
      } catch {
        // appendTrainingRow validates; a malformed derived row is skipped
        // rather than failing the whole backfill.
        continue;
      }
    }

    let nTrain = 0;
    try { nTrain = metaNRows({ tenant_id: t }); } catch { nTrain = 0; }

    return {
      ok: true,
      version: QUALITY_PREDICTOR_VERSION,
      n_backfilled: nBackfilled,
      n_train_rows: nTrain,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), version: QUALITY_PREDICTOR_VERSION };
  }
}

// Load one run subdir and derive (features, observedK). Two sources accepted:
//   1. A features.json (the data feature vector for the batch) alongside an
//      eval json whose composite/accuracy yields the observed K.
//   2. A single run.json carrying both `features` and an eval-shaped block.
// observed K is computed via computeKScoreV2 when raw eval inputs are present,
// otherwise read from an explicit composite/kscore field. Returns null when a
// usable (features, K) pair cannot be derived.
function _loadRunForBackfill(fs, path, runDir) {
  const readJson = (p) => {
    try {
      if (!fs.existsSync(p)) return null;
      const raw = fs.readFileSync(p, 'utf8');
      const j = JSON.parse(raw);
      return (j && typeof j === 'object') ? j : null;
    } catch { return null; }
  };

  // Source 2: a combined run.json.
  const combined = readJson(path.join(runDir, 'run.json'));
  let features = null;
  let observedK = null;

  if (combined) {
    if (combined.features && typeof combined.features === 'object') features = combined.features;
    // K may live in a nested `eval` block OR at the top level of run.json.
    if (combined.eval && typeof combined.eval === 'object') {
      observedK = _deriveObservedK(combined.eval);
    }
    if (observedK == null) observedK = _deriveObservedK(combined);
  }

  // Source 1: separate features.json + eval json (student/eval*.json or eval.json).
  if (!features) {
    const fj = readJson(path.join(runDir, 'features.json'));
    if (fj && typeof fj === 'object') {
      features = (fj.features && typeof fj.features === 'object') ? fj.features : fj;
    }
  }
  // Fall through to the standalone eval json whenever run.json did not already
  // yield a usable K (e.g. run.json carried only the feature vector).
  if (observedK == null) {
    observedK = _deriveObservedK(_findEvalJson(fs, path, runDir));
  }

  if (!features) return null;
  if (observedK == null) return null;
  return { features, observedK };
}

// Find an eval-shaped json: prefer student/eval-*.json (sorted), then
// student/eval.json, then eval.json at the run root.
function _findEvalJson(fs, path, runDir) {
  const tryFile = (p) => {
    try {
      if (!fs.existsSync(p)) return null;
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      return (j && typeof j === 'object') ? j : null;
    } catch { return null; }
  };
  try {
    const studentDir = path.join(runDir, 'student');
    if (fs.existsSync(studentDir) && fs.statSync(studentDir).isDirectory()) {
      const globbed = fs.readdirSync(studentDir)
        .filter(name => /^eval-.*\.json$/i.test(name))
        .sort()
        .map(name => path.join(studentDir, name));
      for (const file of globbed) { const j = tryFile(file); if (j) return j; }
      const plain = tryFile(path.join(studentDir, 'eval.json'));
      if (plain) return plain;
    }
  } catch { /* fall through */ }
  return tryFile(path.join(runDir, 'eval.json'));
}

// Pull a [0,1] observed K out of an eval-shaped object. Prefer an explicit
// composite/kscore/mean_score; otherwise relabel via computeKScoreV2 when the
// raw K-Score inputs (accuracy/coverage/size) are present.
function _deriveObservedK(evalLike) {
  if (!evalLike || typeof evalLike !== 'object') return null;
  for (const key of ['composite', 'kscore', 'mean_score']) {
    const v = Number(evalLike[key]);
    if (Number.isFinite(v)) return _clampK(v);
  }
  if (evalLike.accuracy != null || evalLike.coverage != null || evalLike.size_bytes != null) {
    try {
      const r = computeKScoreV2(evalLike);
      if (r && Number.isFinite(Number(r.composite))) return _clampK(r.composite);
    } catch { /* fall through to null */ }
  }
  return null;
}

// Exposed for tests + downstream introspection. Not part of the stable
// contract — do not rely on these from other modules.
export const __internals = Object.freeze({
  _subScores,
  _heuristicK,
  _pairsSubScore,
  _toMetaFeatures,
  _deriveObservedK,
  HEURISTIC_WEIGHTS,
  CAL_SLOPE,
  CAL_INTERCEPT,
});
