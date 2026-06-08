// KOLM Data Engine - Confident-Learning / label-error detection (W921).
//
// The CURATE quality gate scores SURFACE FORM only (length, CoT leak, refusal,
// PII) and the dedup gate kills near-duplicates. NEITHER asks the load-bearing
// question for a DISTILLATION product: "is this OUTPUT actually a correct answer
// to this INPUT?". A fluent-but-wrong teacher answer, a stale doc answer, a
// mislabeled CSV row, or a captured 4xx error stored as the "answer" all pass
// every existing gate and then teach the student the wrong behavior.
//
// This module flags likely-mislabeled pairs via TWO complementary frontier
// algorithms, auto-selected by what is available:
//
//   (A) CONFIDENT LEARNING (Northcutt et al., JAIR 2021; cleanlab). Offline,
//       teacher-free. Treat each cluster as a "class": class i = cluster of the
//       pair's INPUT. For each pair compute p̂(output belongs to cluster j) by
//       embedding the OUTPUT, cosine to each cluster centroid, softmax over
//       clusters. The per-class self-confidence threshold t_j = mean over pairs
//       whose INPUT is in cluster j of p̂(output in j). A pair is a confident
//       off-diagonal (label-error candidate) when p̂(output in j) >= t_j for some
//       j != input_cluster(x) AND j is the argmax over the classes meeting their
//       own threshold. Off-diagonal mass = estimated label-error rate. A pair
//       whose ANSWER looks like a different topic than its QUESTION is a likely
//       mislabel. Needs only embeddings + cluster ids (which CURATE already has).
//
//   (B) CLEAR / BSDetector (BSDetector arXiv:2308.16175; CLEAR arXiv:2403.12776,
//       ACL'24). Higher-precision teacher path. Per pair: C = beta*O + (1-beta)*S
//       with beta=0.7. Observed consistency O: sample k teacher answers to the
//       INPUT, per-sample agreement with the stored OUTPUT o_i = alpha*s_i +
//       (1-alpha)*r_i where s_i is semantic equivalence (embedding cosine, in
//       [0,1]) and r_i an exact-ish match indicator, alpha=0.8; O = mean(o_i).
//       Self-reflection certainty S: ask the teacher to grade the stored OUTPUT
//       Incorrect/Uncertain/Correct -> {0,0.5,1}. CLEAR decision rules: auto-
//       filter gamma = median(C); auto-correct eta = 0.8.
//
// kolm posture: CONSERVATIVE. By default this NEVER auto-drops or auto-rewrites.
// It FLAGS (stamps provenance.error_flag) and reports. action:'filter' is an
// explicit opt-in; action:'correct' (CLEAR+teacher only) only proposes a
// suggested_output candidate, never an in-place overwrite.
//
// Envelope contract: detectLabelErrors returns {ok, version:'label-error-v1', ...}
// and NEVER throws across the public API. Degrades cleanly: no embeddings / no
// teacher -> backend records the path that ran, ok:true. Pure JS, zero new deps - 
// reuses src/embedding.js (the deterministic 256-d hash-bag embedder).

import { embed as _embedText, cosine as _cosineVec } from './embedding.js';

export const LABEL_ERROR_VERSION = 'label-error-v1';

// ── pair text extraction (mirrors data-curate / data-select) ─────────────────

function _pairInput(p) {
  if (!p || typeof p !== 'object') return '';
  if (typeof p.input === 'string') return p.input;
  if (typeof p.prompt === 'string') return p.prompt;
  return '';
}

function _pairOutput(p) {
  if (!p || typeof p !== 'object') return '';
  if (typeof p.output === 'string') return p.output;
  if (typeof p.teacher_output === 'string') return p.teacher_output;
  if (typeof p.response === 'string') return p.response;
  return '';
}

// ── vector helpers (pure) ─────────────────────────────────────────────────────

function _cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  return _cosineVec(a, b);
}

// softmax over a similarity row, with an inverse-temperature so cosine (which
// lives in a narrow band for the hash-bag embedder) produces a usable
// probability spread. Deterministic.
function _softmax(sims, beta = 8) {
  const n = sims.length;
  if (n === 0) return [];
  let max = -Infinity;
  for (const s of sims) if (s > max) max = s;
  const exps = new Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const e = Math.exp(beta * (sims[i] - max));
    exps[i] = e;
    sum += e;
  }
  if (!(sum > 0)) return sims.map(() => 1 / n);
  for (let i = 0; i < n; i++) exps[i] /= sum;
  return exps;
}

// ── cluster index assignment ──────────────────────────────────────────────────

// Build a stable cluster index map from whatever cluster field the pairs carry.
// Pairs with no cluster id all share a single bucket (the detector then becomes
// a no-op for off-diagonal since there is only one class - reported plainly).
function _clusterIndexMap(pairs, clusterField) {
  const map = new Map(); // cluster_id string -> dense index
  const idxOf = new Array(pairs.length);
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    let cid = (p && typeof p === 'object') ? p[clusterField] : undefined;
    cid = (cid == null || cid === '') ? '__nocluster__' : String(cid);
    if (!map.has(cid)) map.set(cid, map.size);
    idxOf[i] = map.get(cid);
  }
  return { idxOf, count: map.size, ids: [...map.keys()] };
}

// Mean-pool member OUTPUT embeddings into a unit centroid per cluster. Works on
// any cluster id (real k-means slug or 3-gram-prefix bucket - coarser, but exact).
function _centroidsFromClusters(outputEmbeddings, clusterIdxOf, clusterCount) {
  const dim = outputEmbeddings.length ? outputEmbeddings[0].length : 0;
  const centroids = Array.from({ length: clusterCount }, () => new Array(dim).fill(0));
  const counts = new Array(clusterCount).fill(0);
  for (let i = 0; i < outputEmbeddings.length; i++) {
    const c = clusterIdxOf[i];
    const v = outputEmbeddings[i];
    for (let d = 0; d < dim; d++) centroids[c][d] += v[d];
    counts[c] += 1;
  }
  for (let c = 0; c < clusterCount; c++) {
    if (counts[c] === 0) continue;
    let norm = 0;
    for (let d = 0; d < dim; d++) { centroids[c][d] /= counts[c]; norm += centroids[c][d] * centroids[c][d]; }
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dim; d++) centroids[c][d] /= norm;
  }
  return centroids;
}

// ── scoreOutputClusterProbs ───────────────────────────────────────────────────

/**
 * scoreOutputClusterProbs(outputEmbeddings, centroids) - for each output embed,
 * cosine to every cluster centroid, softmax to p̂(output in cluster j; x).
 * @param {number[][]} outputEmbeddings  N x d
 * @param {number[][]} centroids          K x d
 * @returns {number[][]}  N x K row-stochastic probability matrix
 */
export function scoreOutputClusterProbs(outputEmbeddings, centroids) {
  const out = [];
  for (const v of (outputEmbeddings || [])) {
    const sims = centroids.map((c) => _cosineSim(v, c));
    out.push(_softmax(sims));
  }
  return out;
}

// ── confidentJointAgreement (Confident Learning core) ─────────────────────────

/**
 * confidentJointAgreement - Confident-Learning confident-joint over the
 * (input-cluster -> output-cluster) agreement. Per-cluster self-confidence
 * threshold t_j = mean p̂(output in j) over pairs whose INPUT is in cluster j.
 * A pair is a confident off-diagonal label-error candidate when its output's
 * p̂(in j) >= t_j for some j != input-cluster AND j is the argmax over the
 * classes that meet their own threshold.
 *
 * @param {object[]} pairs
 * @param {number[][]} outputProbs   N x K row-stochastic (from scoreOutputClusterProbs)
 * @param {(p:object,i:number)=>number} clusterIndexOf  input-cluster index of a pair
 * @param {number} clusterCount  K
 * @param {object} [opts]
 * @param {number} [opts.margin=0.05]  relaxation on the per-class self-confidence
 *        threshold. CL assumes calibrated probabilities; the embedding-cosine-
 *        softmax here is a heuristic proxy, so a small margin (t_j*(1-margin))
 *        recalls confident off-diagonals that sit just under a saturated
 *        self-threshold. margin=0 is the strict cleanlab definition.
 * @returns {{flags:Array<{index,given_cluster,confident_cluster,p,t_j}>, off_diagonal_rate:number, joint:number[][], thresholds:number[]}}
 */
export function confidentJointAgreement(pairs, outputProbs, clusterIndexOf, clusterCount, opts = {}) {
  const rows = Array.isArray(pairs) ? pairs : [];
  const N = rows.length;
  const K = Math.max(1, clusterCount | 0);
  const margin = Number.isFinite(Number(opts.margin)) ? Math.max(0, Math.min(0.5, Number(opts.margin))) : 0.05;
  const given = new Array(N);
  for (let i = 0; i < N; i++) {
    const gi = clusterIndexOf(rows[i], i);
    given[i] = Number.isInteger(gi) && gi >= 0 && gi < K ? gi : 0;
  }

  // t_j = mean over pairs WHOSE INPUT is in cluster j of p̂(output in j).
  // (Cleanlab's per-class self-confidence threshold, ported input->output.)
  // Classes with NO self-members fall back to the mean of the populated
  // thresholds (avoids an unestimable class defaulting to 1 and never flagging).
  const sumSelf = new Array(K).fill(0);
  const cntSelf = new Array(K).fill(0);
  for (let i = 0; i < N; i++) {
    const j = given[i];
    const pj = (outputProbs[i] && Number.isFinite(outputProbs[i][j])) ? outputProbs[i][j] : 0;
    sumSelf[j] += pj;
    cntSelf[j] += 1;
  }
  let populatedSum = 0; let populatedCnt = 0;
  for (let j = 0; j < K; j++) if (cntSelf[j] > 0) { populatedSum += sumSelf[j] / cntSelf[j]; populatedCnt += 1; }
  const meanThreshold = populatedCnt > 0 ? populatedSum / populatedCnt : 1;
  const thresholds = new Array(K);
  for (let j = 0; j < K; j++) {
    const raw = cntSelf[j] > 0 ? sumSelf[j] / cntSelf[j] : meanThreshold;
    thresholds[j] = raw * (1 - margin);
  }

  // Confident joint C[i][j]: count a pair into bin (given=i, confident=j) where
  // j is the argmax over classes meeting their threshold. Off-diagonal i!=j are
  // the label-error candidates.
  const joint = Array.from({ length: K }, () => new Array(K).fill(0));
  const flags = [];
  for (let i = 0; i < N; i++) {
    const probs = outputProbs[i] || [];
    let best = -1; let bestP = -Infinity;
    for (let j = 0; j < K; j++) {
      const pj = Number.isFinite(probs[j]) ? probs[j] : 0;
      if (pj >= thresholds[j] && pj > bestP) { bestP = pj; best = j; }
    }
    if (best < 0) continue; // meets no class threshold confidently -> uncounted
    const gi = given[i];
    joint[gi][best] += 1;
    if (best !== gi) {
      flags.push({
        index: i,
        given_cluster: gi,
        confident_cluster: best,
        p: Number(bestP.toFixed(6)),
        t_j: Number(thresholds[best].toFixed(6)),
      });
    }
  }

  // off-diagonal rate = off-diagonal mass / total counted mass (CL noise rate).
  let total = 0; let off = 0;
  for (let i = 0; i < K; i++) for (let j = 0; j < K; j++) { total += joint[i][j]; if (i !== j) off += joint[i][j]; }
  const off_diagonal_rate = total > 0 ? off / total : 0;

  return { flags, off_diagonal_rate: Number(off_diagonal_rate.toFixed(6)), joint, thresholds };
}

// ── bsDetectorConfidence (CLEAR / BSDetector) ─────────────────────────────────

// semantic equivalence proxy s_i in [0,1] via embedding cosine (clamped to
// [0,1]; the hash-bag embedder yields non-negative cosines for related text).
function _semanticEquivalence(a, b) {
  const s = _cosineSim(_embedText(String(a || '')), _embedText(String(b || '')));
  return Math.max(0, Math.min(1, s));
}

// exact-ish match r_i: normalized whitespace+case equality.
function _exactish(a, b) {
  const na = String(a || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const nb = String(b || '').toLowerCase().replace(/\s+/g, ' ').trim();
  return na.length > 0 && na === nb ? 1 : 0;
}

// map a self-reflection verdict string to {0, 0.5, 1}.
function _reflectionToScore(verdict) {
  const v = String(verdict || '').toLowerCase();
  if (/\bincorrect\b|\bwrong\b|\bno\b/.test(v)) return 0;
  if (/\bcorrect\b|\byes\b/.test(v)) return 1;
  if (/\buncertain\b|\bmaybe\b|\bpartial/.test(v)) return 0.5;
  return 0.5; // unknown -> uncertain
}

/**
 * bsDetectorConfidence - CLEAR/BSDetector confidence C = beta*O + (1-beta)*S.
 *   O = mean over k samples of (alpha*s_i + (1-alpha)*r_i)
 *   S in {0,0.5,1} from a self-reflection grade (default 0.5 if no grader)
 * The teacher caller is fully injectable so this is unit-testable with stubs and
 * spends nothing in tests.
 *
 * @param {object} args
 * @param {string} args.input
 * @param {string} args.output  the stored OUTPUT being verified
 * @param {(input:string,n:number)=>Promise<string[]>} args.sample  draws k teacher answers
 * @param {(input:string,output:string)=>Promise<string>} [args.reflect]  self-reflection grader
 * @param {number} [args.alpha=0.8]
 * @param {number} [args.beta=0.7]
 * @param {number} [args.k=5]
 * @returns {Promise<{confidence:number, observed_consistency:number, self_reflection:number, n_samples:number}>}
 */
export async function bsDetectorConfidence({ input, output, sample, reflect, alpha = 0.8, beta = 0.7, k = 5 } = {}) {
  const a = Number.isFinite(Number(alpha)) ? Number(alpha) : 0.8;
  const b = Number.isFinite(Number(beta)) ? Number(beta) : 0.7;
  const kk = Math.max(1, Math.trunc(Number(k) || 5));

  let samples = [];
  if (typeof sample === 'function') {
    try {
      const drawn = await sample(String(input || ''), kk);
      if (Array.isArray(drawn)) samples = drawn.map((x) => String(x == null ? '' : x));
    } catch (_) { samples = []; }
  }

  let O = 0;
  if (samples.length > 0) {
    let acc = 0;
    for (const s of samples) {
      const si = _semanticEquivalence(output, s);
      const ri = _exactish(output, s);
      acc += a * si + (1 - a) * ri;
    }
    O = acc / samples.length;
  }

  let S = 0.5;
  if (typeof reflect === 'function') {
    try { S = _reflectionToScore(await reflect(String(input || ''), String(output || ''))); }
    catch (_) { S = 0.5; }
  }

  const confidence = b * O + (1 - b) * S;
  return {
    confidence: Number(confidence.toFixed(6)),
    observed_consistency: Number(O.toFixed(6)),
    self_reflection: S,
    n_samples: samples.length,
  };
}

// ── routeErrorsToReview (best-effort enqueue bridge) ──────────────────────────

/**
 * routeErrorsToReview - materialize each flagged pair as a reviewable event so
 * the existing human review queue can surface it (closing the F6.7 hook). The
 * event-store + label-queue modules are injectable so this is testable in
 * isolation and never hard-requires them; missing modules degrade to a recorded
 * skip, never a throw.
 *
 * @param {object} args
 * @param {Array<object>} args.flaggedPairs  each {pair, method, score, reason, suggested_output?}
 * @param {string} [args.tenant]
 * @param {string} [args.namespace]
 * @param {string} [args.method]
 * @param {string} [args.reviewer='curate-auto']
 * @param {(ev:object)=>Promise<object>} [args.appendEvent]  injectable event-store.appendEvent
 * @returns {Promise<{enqueued:number, errors:string[], event_ids:string[]}>}
 */
export async function routeErrorsToReview({ flaggedPairs, tenant, namespace, method, reviewer = 'curate-auto', appendEvent } = {}) {
  const items = Array.isArray(flaggedPairs) ? flaggedPairs : [];
  const errors = [];
  const event_ids = [];
  let enqueued = 0;

  let appender = appendEvent;
  if (typeof appender !== 'function') {
    try {
      const es = await import('./event-store.js');
      if (es && typeof es.appendEvent === 'function') appender = es.appendEvent;
    } catch (e) { errors.push('event_store_unavailable:' + String((e && e.message) || e)); }
  }
  if (typeof appender !== 'function') {
    return { enqueued: 0, errors: errors.length ? errors : ['no_event_appender'], event_ids };
  }

  for (const it of items) {
    const pair = (it && it.pair) || it;
    try {
      const ev = await appender({
        tenant_id: tenant || 'tenant_local',
        namespace: namespace || 'default',
        provider: 'kolm_data_curate',
        vendor: 'kolm',
        model: 'label-error/v1',
        workflow_id: 'data_curate:label_error_review',
        status: 'needs_review',
        prompt: _pairInput(pair),
        completion: _pairOutput(pair),
        prompt_tokens: 0,
        completion_tokens: 0,
        feedback: JSON.stringify({
          origin: 'curate-label-error',
          method: it.method || method || 'cl',
          score: it.score,
          reason: it.reason,
          suggested_output: it.suggested_output || null,
          reviewer,
        }),
      });
      enqueued += 1;
      if (ev && ev.event_id) event_ids.push(ev.event_id);
    } catch (e) {
      errors.push(String((e && e.message) || e));
    }
  }
  return { enqueued, errors, event_ids };
}

// ── detectLabelErrors (headline orchestrator) ─────────────────────────────────

/**
 * detectLabelErrors - orchestrates the offline Confident-Learning detector (and
 * the CLEAR/BSDetector teacher path when a sampler is supplied). FLAGS by
 * default; never drops. Returns a well-formed envelope and never throws.
 *
 * @param {object} args
 * @param {object[]} args.pairs
 * @param {string} [args.clusterField='cluster_id']
 * @param {'cl'|'clear'} [args.method='cl']
 * @param {'review'|'filter'|'correct'} [args.action='review']  advisory; the caller acts on flags
 * @param {number|null} [args.threshold=null]  for 'clear': drop/flag below; null => median(C) (CLEAR gamma)
 * @param {Function} [args.sample]  CLEAR teacher sampler (input,n)=>Promise<string[]>
 * @param {Function} [args.reflect] CLEAR self-reflection grader
 * @param {number} [args.k=5]
 * @param {string} [args.tenant]
 * @param {string} [args.namespace]
 * @param {(i:number,n:number)=>void} [args.onProgress]
 * @returns {Promise<object>} {ok, version, flagged, by_reason, off_diagonal_rate?, median_confidence?, backend, pairs, sample, note?}
 */
export async function detectLabelErrors({
  pairs,
  clusterField = 'cluster_id',
  method = 'cl',
  action = 'review',
  threshold = null,
  sample = null,
  reflect = null,
  k = 5,
  tenant = 'tenant_local',
  namespace = 'default',
  onProgress = null,
} = {}) {
  try {
    const rows = Array.isArray(pairs) ? pairs : [];
    const n = rows.length;
    const base = {
      ok: true,
      version: LABEL_ERROR_VERSION,
      method,
      action,
      flagged: 0,
      by_reason: {},
      backend: 'skipped',
      pairs: rows,
      sample: [],
    };
    if (n === 0) return { ...base, note: 'empty_corpus' };

    // ── CLEAR / BSDetector teacher path ──────────────────────────────────────
    if (method === 'clear' && typeof sample === 'function') {
      const confidences = new Array(n);
      for (let i = 0; i < n; i++) {
        const c = await bsDetectorConfidence({
          input: _pairInput(rows[i]),
          output: _pairOutput(rows[i]),
          sample, reflect, k,
        });
        confidences[i] = c.confidence;
        if (typeof onProgress === 'function') { try { onProgress(i + 1, n); } catch (_) { /* noop */ } }
      }
      const gamma = (threshold == null) ? _median(confidences) : Number(threshold);
      const flaggedEntries = [];
      for (let i = 0; i < n; i++) {
        if (confidences[i] < gamma) {
          const reason = 'low_clear_confidence';
          base.by_reason[reason] = (base.by_reason[reason] || 0) + 1;
          const flag = {
            method: 'clear',
            score: Number(confidences[i].toFixed(6)),
            reason,
            suggested_action: action === 'filter' ? 'drop' : (action === 'correct' ? 'correct' : 'review'),
          };
          _stampFlag(rows[i], flag);
          flaggedEntries.push({ index: i, pair: rows[i], method: 'clear', score: confidences[i], reason });
          if (base.sample.length < 10) base.sample.push({ index: i, score: flag.score, reason });
        }
      }
      base.flagged = flaggedEntries.length;
      base.median_confidence = Number(gamma.toFixed(6));
      base.backend = 'clear-teacher';
      base.flagged_entries = flaggedEntries;
      return base;
    }

    // ── offline Confident-Learning path (default) ────────────────────────────
    const { idxOf, count } = _clusterIndexMap(rows, clusterField);
    const outEmbs = rows.map((p) => _embedText(_pairOutput(p)));
    const backend = (count > 1) ? 'cl-dense' : 'cl-ngram';

    if (count <= 1) {
      // Only one class -> no off-diagonal possible. Report plainly.
      base.backend = backend;
      base.off_diagonal_rate = 0;
      base.note = 'single_cluster:no_off_diagonal_possible';
      return base;
    }

    const centroids = _centroidsFromClusters(outEmbs, idxOf, count);
    const probs = scoreOutputClusterProbs(outEmbs, centroids);
    const cjMargin = (threshold != null && Number.isFinite(Number(threshold))) ? Number(threshold) : 0.05;
    const cj = confidentJointAgreement(rows, probs, (p, i) => idxOf[i], count, { margin: cjMargin });

    const flaggedEntries = [];
    for (const f of cj.flags) {
      const reason = 'answer_topic_mismatch';
      base.by_reason[reason] = (base.by_reason[reason] || 0) + 1;
      const flag = {
        method: 'cl',
        score: f.p,
        reason,
        given_cluster: f.given_cluster,
        confident_cluster: f.confident_cluster,
        suggested_action: action === 'filter' ? 'drop' : (action === 'correct' ? 'correct' : 'review'),
      };
      _stampFlag(rows[f.index], flag);
      flaggedEntries.push({ index: f.index, pair: rows[f.index], method: 'cl', score: f.p, reason });
      if (base.sample.length < 10) base.sample.push({ index: f.index, score: f.p, reason });
    }
    base.flagged = flaggedEntries.length;
    base.off_diagonal_rate = cj.off_diagonal_rate;
    base.backend = backend;
    base.flagged_entries = flaggedEntries;
    return base;
  } catch (e) {
    return {
      ok: false,
      version: LABEL_ERROR_VERSION,
      error: String((e && e.message) || e),
      flagged: 0,
      by_reason: {},
      backend: 'error',
      pairs: Array.isArray(pairs) ? pairs : [],
      sample: [],
    };
  }
}

function _stampFlag(pair, flag) {
  if (!pair || typeof pair !== 'object') return;
  const prov = (pair.provenance && typeof pair.provenance === 'object') ? pair.provenance : {};
  prov.error_flag = flag;
  pair.provenance = prov;
}

function _median(arr) {
  const a = (arr || []).filter((x) => Number.isFinite(x)).slice().sort((x, y) => x - y);
  if (a.length === 0) return 0;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export const __internals = {
  _clusterIndexMap,
  _centroidsFromClusters,
  _softmax,
  _semanticEquivalence,
  _exactish,
  _reflectionToScore,
  _median,
};

export default {
  LABEL_ERROR_VERSION,
  detectLabelErrors,
  confidentJointAgreement,
  scoreOutputClusterProbs,
  bsDetectorConfidence,
  routeErrorsToReview,
  __internals,
};
