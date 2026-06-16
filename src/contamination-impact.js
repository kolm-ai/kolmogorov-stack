// src/contamination-impact.js
//
// Finalized C6 - Quantitative contamination-impact estimation + clean/dirty
// accuracy decomposition, feeding a contamination-CORRECTED A/R axis into the
// K-score and emitting a signed contamination-impact block.
//
// WHY THIS EXISTS
// ---------------
// The seeds.jsonl train/holdout gate (src/seeds.js leakageReport) already
// detects overlap between a tenant's train and holdout split. But the reported
// holdout accuracy that flows into the K-score A axis (and the R axis) is the
// RAW accuracy over the WHOLE holdout - including any rows that leaked from
// train. A model can score 0.95 on a holdout where 30% of rows are near-dups of
// training rows it memorized; the headline 0.95 is INFLATED. The GPT-4 technical
// report and the llm-decontaminator (Yang et al. 2023, "Rethinking Benchmark
// and Contamination for LLMs") established the reporting standard this module
// implements: partition eval into a decontaminated-CLEAN subset and a flagged
// (contaminated) subset, report accuracy on EACH, and surface the inflation
// the contamination caused.
//
// WHAT THIS MODULE DOES
// ---------------------
//   1. Runs the SAME 3-tier overlap cascade the project uses for train/holdout
//      leakage, but holdout-vs-train (NOT synthetic-vs-eval):
//        Tier 1 - EXACT  : canonical input-hash (and output-hash) identity.
//        Tier 2 - NEAR   : n-gram (word-bigram) Jaccard >= threshold (the
//                          llm-decontaminator "rephrase" catcher; the project's
//                          existing near-dup tier).
//        Tier 3 - GROUPED: shared grouping key (member_id / claim_id style),
//                          the entity-leak catcher that survives surface
//                          rewrites.
//      A holdout row flagged by ANY tier is contaminated; the rest are clean.
//   2. Decomposes per-row correctness into accuracy_clean and accuracy_flagged.
//   3. Computes the inflation delta = accuracy_reported - accuracy_clean with a
//      seeded, reproducible bootstrap 95% CI on that delta.
//   4. Feeds accuracy_clean as the contamination-CORRECTED A axis (and the
//      corrected holdout_accuracy / R axis) into computeKScore, alongside the
//      RAW K-score, so a verifier sees both numbers and the magnitude of the
//      correction.
//   5. Emits a contamination_impact block; when an Ed25519 signer is available
//      the block is signed so a third party can confirm the raw->corrected
//      delta was not tampered with.
//
// MOAT / CONSTRAINTS
// ------------------
//   * Pure JS, zero new npm deps. Ed25519 signing is the project's existing
//     primitive (src/ed25519.js) and is OPTIONAL: when no signer key is present
//     the block ships unsigned (signature: null) exactly like other additive
//     blocks - it never fails the build, but it does record signed:false so a
//     verifier can tell.
//   * Fail-closed disjointness is PRESERVED, not weakened: this module never
//     mutates the holdout/train split and never lowers the gate. It can only
//     LOWER the reported A (correction is downward), so it can only make the
//     ship decision STRICTER, never more lenient. A model that ships on the
//     raw score might NOT ship on the corrected score - that is the point.
//   * Privacy: operates on hashes + token sets locally. No row text is sent
//     anywhere. The emitted block carries only counts, hashes (truncated), and
//     scores - never raw row text - so it is safe to ship in a public receipt.
//
// HONEST CAVEATS
//   * Tier 2's bigram Jaccard is the same cheap O(n*m) detector the project
//     ships in seeds.js; for very large holdouts the caller can raise the
//     similarity threshold or cap pair comparisons via opts. The signed block
//     records the exact threshold + tier params so the partition is reproducible.
//   * accuracy_flagged over an empty flagged set is reported as null (not 0):
//     "no contaminated rows" is distinct from "contaminated rows all wrong".

import crypto from 'node:crypto';
import { canonicalJson } from './seeds.js';
import { computeKScore } from './kscore.js';
import {
  buildSignatureBlock,
  verifySignatureBlock,
  loadOrCreateDefaultSigner,
} from './ed25519.js';

export const CONTAMINATION_IMPACT_SPEC = 'contamination-impact-v1';
export const DEFAULT_SIMILARITY_THRESHOLD = 0.85;
export const DEFAULT_BOOTSTRAP_ITERATIONS = 2000;
export const DEFAULT_BOOTSTRAP_SEED = 0x6b6f6c6d; // 'kolm'

function sha256(s) {
  return crypto.createHash('sha256').update(typeof s === 'string' ? s : Buffer.from(s)).digest('hex');
}

// Canonicalize an input/expected value to a stable string for hashing. Mirrors
// the project's canonicalInput intent (objects -> canonical JSON, primitives ->
// String) so two structurally-identical rows hash to the same digest.
function canonicalField(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return canonicalJson(v); } catch { return String(v); }
}

// -- Tier 2 helper: word-bigram Jaccard (matches seeds.js jaccardBigrams) -----
function _flatten(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}
function _tokens(s) {
  return _flatten(s).toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
}
function _bigrams(toks) {
  const set = new Set();
  for (let i = 0; i < toks.length - 1; i++) set.add(toks[i] + ' ' + toks[i + 1]);
  return set;
}
function jaccardBigrams(a, b) {
  const A = _bigrams(_tokens(a));
  const B = _bigrams(_tokens(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// -- Tier 3 helper: grouping key (matches seeds.js groupingKey) ---------------
function extractGroupValue(row, group_key) {
  if (!group_key) return null;
  const tags = (row && row.metadata && row.metadata.tags) || [];
  const prefix = group_key + ':';
  for (const t of tags) {
    if (typeof t === 'string' && t.toLowerCase().startsWith(prefix.toLowerCase())) {
      return t.slice(prefix.length);
    }
  }
  // Also allow a direct metadata field, e.g. metadata.member_id.
  if (row && row.metadata && row.metadata[group_key] != null) {
    return String(row.metadata[group_key]);
  }
  return null;
}
function groupingKey(row, group_key) {
  if (group_key) {
    const v = extractGroupValue(row, group_key);
    return v ? group_key + ':' + String(v).toLowerCase() : null;
  }
  const tags = (row && row.metadata && row.metadata.tags) || [];
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    if (/^[a-z_]+:[a-z0-9_-]+$/i.test(t)) return t.toLowerCase();
  }
  return null;
}

// Seeded LCG (Numerical Recipes constants) so the bootstrap CI is reproducible
// + verifier-recomputable. Returns a function yielding floats in [0,1).
function _lcg(seed) {
  let state = (seed >>> 0) || 1;
  return function next() {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function _percentile(sortedAsc, q) {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc[0];
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  const frac = pos - lo;
  return sortedAsc[lo] * (1 - frac) + sortedAsc[hi] * frac;
}

/**
 * partitionHoldout - run the 3-tier overlap cascade HOLDOUT-vs-TRAIN and split
 * the holdout into clean + flagged index sets.
 *
 * @param {object[]} train     normalized rows {input, expected, metadata}
 * @param {object[]} holdout   normalized rows
 * @param {object}   [opts]
 * @param {number}   [opts.similarity_threshold=0.85]  Tier-2 Jaccard floor
 * @param {string}   [opts.group_key]                  Tier-3 explicit grouping key
 * @param {number}   [opts.max_near_dup_pairs=2_000_000] cap on Tier-2 comparisons
 * @returns {{ clean_indices:number[], flagged_indices:number[],
 *             tier_hits: { exact:number[], near:number[], grouped:number[] },
 *             flagged_by:object, params:object }}
 */
export function partitionHoldout(train, holdout, opts = {}) {
  const tr = Array.isArray(train) ? train : [];
  const ho = Array.isArray(holdout) ? holdout : [];
  const simThreshold = Number.isFinite(Number(opts.similarity_threshold))
    ? Number(opts.similarity_threshold) : DEFAULT_SIMILARITY_THRESHOLD;
  const groupKey = (typeof opts.group_key === 'string' && opts.group_key) ? opts.group_key : null;
  const maxPairs = Number.isFinite(Number(opts.max_near_dup_pairs))
    ? Number(opts.max_near_dup_pairs) : 2_000_000;

  // Tier 1 substrate: train input + output hash sets.
  const trainInputHashes = new Set(tr.map(r => sha256(canonicalField(r.input))));
  const trainOutputHashes = new Set(tr.map(r => sha256(canonicalField(r.expected))));
  // Tier 3 substrate: train grouping keys.
  const trainGroups = new Set();
  for (const r of tr) {
    const g = groupingKey(r, groupKey);
    if (g) trainGroups.add(g);
  }

  const tierExact = [];
  const tierNear = [];
  const tierGrouped = [];
  const flaggedBy = {}; // holdout_index -> array of tiers that flagged it
  const flaggedSet = new Set();

  const canNearDup = tr.length * ho.length <= maxPairs;

  for (let i = 0; i < ho.length; i++) {
    const row = ho[i];
    const tiers = [];

    // Tier 1 - exact input OR output hash identity.
    const ih = sha256(canonicalField(row.input));
    const oh = sha256(canonicalField(row.expected));
    if (trainInputHashes.has(ih) || trainOutputHashes.has(oh)) {
      tierExact.push(i);
      tiers.push('exact');
    }

    // Tier 2 - near-duplicate by bigram Jaccard (only if not already exact, to
    // avoid double-counting work; a row can still be recorded under multiple
    // tiers for transparency).
    if (canNearDup) {
      let nearHit = false;
      for (let j = 0; j < tr.length; j++) {
        if (jaccardBigrams(row.input, tr[j].input) >= simThreshold) { nearHit = true; break; }
      }
      if (nearHit) {
        tierNear.push(i);
        tiers.push('near');
      }
    }

    // Tier 3 - shared grouping key (entity leak).
    const g = groupingKey(row, groupKey);
    if (g && trainGroups.has(g)) {
      tierGrouped.push(i);
      tiers.push('grouped');
    }

    if (tiers.length > 0) {
      flaggedSet.add(i);
      flaggedBy[i] = tiers;
    }
  }

  const flagged_indices = [];
  const clean_indices = [];
  for (let i = 0; i < ho.length; i++) {
    if (flaggedSet.has(i)) flagged_indices.push(i);
    else clean_indices.push(i);
  }

  return {
    clean_indices,
    flagged_indices,
    tier_hits: { exact: tierExact, near: tierNear, grouped: tierGrouped },
    flagged_by: flaggedBy,
    params: {
      similarity_threshold: simThreshold,
      group_key: groupKey,
      near_dup_evaluated: canNearDup,
      train_count: tr.length,
      holdout_count: ho.length,
    },
  };
}

// Mean of a boolean/0-1 array over a given index subset.
function _accOver(correctness, indices) {
  if (!indices || indices.length === 0) return null;
  let sum = 0;
  for (const idx of indices) sum += correctness[idx] ? 1 : 0;
  return sum / indices.length;
}

/**
 * bootstrapDeltaCI - seeded bootstrap 95% CI on the inflation delta
 * (accuracy_reported - accuracy_clean).
 *
 * Resampling scheme: the delta is a function of the WHOLE holdout's correctness
 * vector AND its clean/flagged partition. We resample holdout rows WITH
 * replacement, recompute reported-accuracy (mean over the resample) and
 * clean-accuracy (mean over the clean rows IN the resample), and take their
 * difference. Resamples whose clean subset is empty are skipped (cannot define
 * clean accuracy); if too few valid resamples remain we report a null CI with a
 * reason rather than a fake interval.
 *
 * @param {Array<0|1|boolean>} correctness    per-holdout-row correctness
 * @param {Set<number>|number[]} cleanIndexSet clean holdout indices
 * @param {object} [opts]
 * @param {number} [opts.iterations=2000]
 * @param {number} [opts.seed]
 * @param {number} [opts.ci=0.95]
 * @returns {{ ci_low:number|null, ci_high:number|null, point:number,
 *             iterations:number, valid_iterations:number, seed:number,
 *             ci_level:number, reason?:string }}
 */
export function bootstrapDeltaCI(correctness, cleanIndexSet, opts = {}) {
  const n = correctness.length;
  const iterations = Math.max(1, Math.trunc(Number(opts.iterations) || DEFAULT_BOOTSTRAP_ITERATIONS));
  const seed = (Number(opts.seed) >>> 0) || DEFAULT_BOOTSTRAP_SEED;
  const ciLevel = Number.isFinite(Number(opts.ci)) ? Number(opts.ci) : 0.95;
  const cleanSet = cleanIndexSet instanceof Set ? cleanIndexSet : new Set(cleanIndexSet || []);

  // Point estimate over the full sample.
  const reported = n === 0 ? 0 : correctness.reduce((s, c) => s + (c ? 1 : 0), 0) / n;
  let cleanSum = 0, cleanCount = 0;
  for (let i = 0; i < n; i++) if (cleanSet.has(i)) { cleanSum += correctness[i] ? 1 : 0; cleanCount++; }
  const cleanAcc = cleanCount === 0 ? null : cleanSum / cleanCount;
  const point = cleanAcc == null ? 0 : reported - cleanAcc;

  if (n === 0 || cleanCount === 0) {
    return {
      ci_low: null, ci_high: null, point,
      iterations, valid_iterations: 0, seed, ci_level: ciLevel,
      reason: n === 0 ? 'empty_holdout' : 'no_clean_rows',
    };
  }

  const rng = _lcg(seed);
  const deltas = [];
  for (let it = 0; it < iterations; it++) {
    let repSum = 0;
    let clSum = 0, clCount = 0;
    for (let k = 0; k < n; k++) {
      const idx = Math.min(n - 1, Math.floor(rng() * n));
      const c = correctness[idx] ? 1 : 0;
      repSum += c;
      if (cleanSet.has(idx)) { clSum += c; clCount++; }
    }
    if (clCount === 0) continue; // resample has no clean rows; skip
    deltas.push((repSum / n) - (clSum / clCount));
  }

  if (deltas.length < Math.max(20, iterations * 0.5)) {
    return {
      ci_low: null, ci_high: null, point,
      iterations, valid_iterations: deltas.length, seed, ci_level: ciLevel,
      reason: 'too_few_valid_resamples',
    };
  }

  deltas.sort((a, b) => a - b);
  const lowQ = (1 - ciLevel) / 2;
  const highQ = 1 - lowQ;
  return {
    ci_low: round4(_percentile(deltas, lowQ)),
    ci_high: round4(_percentile(deltas, highQ)),
    point: round4(point),
    iterations,
    valid_iterations: deltas.length,
    seed,
    ci_level: ciLevel,
  };
}

function clamp01(x) { return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0)); }
function round4(x) { return Number(Number(x).toFixed(4)); }

/**
 * estimateContaminationImpact - the headline export.
 *
 * Partitions the holdout vs train, decomposes accuracy, computes the inflation
 * delta + bootstrap CI, and computes BOTH a raw K-score (A = reported holdout
 * accuracy) and a contamination-corrected K-score (A = accuracy_clean). Returns
 * a serializable, hash-stable contamination_impact block.
 *
 * @param {object} args
 * @param {object[]} args.train               normalized train rows
 * @param {object[]} args.holdout             normalized holdout rows
 * @param {Array<0|1|boolean>} args.correctness  per-holdout-row correctness,
 *                                             aligned to holdout index order
 * @param {object} args.kscore_inputs         base inputs for computeKScore (size,
 *                                             latency, cost, coverage, etc.). The
 *                                             A axis (accuracy) AND holdout_accuracy
 *                                             are OVERRIDDEN by this function.
 * @param {object} [args.cascade]             partitionHoldout opts (threshold,
 *                                             group_key, ...)
 * @param {object} [args.bootstrap]           bootstrapDeltaCI opts (iterations, seed)
 * @param {object} [args.signer]              { privateKey, publicKey, key_fingerprint }
 *                                             override; if omitted, the default
 *                                             env/cache signer is used unless
 *                                             args.sign === false.
 * @param {boolean} [args.sign=true]          set false to skip signing entirely
 * @param {string}  [args.generated_at]       ISO timestamp (deterministic tests)
 * @returns {object} contamination_impact block
 */
export function estimateContaminationImpact(args = {}) {
  const train = Array.isArray(args.train) ? args.train : [];
  const holdout = Array.isArray(args.holdout) ? args.holdout : [];
  const correctnessRaw = Array.isArray(args.correctness) ? args.correctness : [];
  if (correctnessRaw.length !== holdout.length) {
    throw new Error(
      `contamination-impact: correctness length (${correctnessRaw.length}) must equal holdout length (${holdout.length})`
    );
  }
  const correctness = correctnessRaw.map(c => (c ? 1 : 0));
  const kInputs = (args.kscore_inputs && typeof args.kscore_inputs === 'object') ? args.kscore_inputs : {};

  // 1. Partition.
  const part = partitionHoldout(train, holdout, args.cascade || {});
  const cleanSet = new Set(part.clean_indices);

  // 2. Decompose accuracy.
  const accuracy_reported = holdout.length === 0
    ? 0
    : round4(correctness.reduce((s, c) => s + c, 0) / holdout.length);
  const accuracy_clean = part.clean_indices.length === 0
    ? null
    : round4(_accOver(correctness, part.clean_indices));
  const accuracy_flagged = part.flagged_indices.length === 0
    ? null
    : round4(_accOver(correctness, part.flagged_indices));

  // 3. Inflation delta + bootstrap CI. FAIL-CLOSED downward-only: clamp correctedA
  //    to min(reported, clean) so the contamination correction can ONLY ever LOWER
  //    the accuracy (make the ship gate STRICTER), never raise it. Without the
  //    clamp, an unusual holdout where flagged rows scored LOWER than clean rows
  //    gives accuracy_clean > accuracy_reported -> an UPWARD correction that flips
  //    a non-shipping model to ship -- contamination must NEVER help you pass. This
  //    clamp makes the documented downward-only moat guarantee unconditionally true.
  const correctedA = accuracy_clean == null
    ? accuracy_reported
    : Math.min(accuracy_reported, accuracy_clean);
  const inflation_delta = round4(accuracy_reported - correctedA);
  const boot = bootstrapDeltaCI(correctness, cleanSet, args.bootstrap || {});

  // 4. Raw + corrected K-scores. The corrected K feeds the clamped correctedA into
  //    BOTH the A axis and (when the caller declared a holdout_accuracy / R axis)
  //    the holdout_accuracy, since the clean-decontaminated accuracy IS the honest
  //    held-out generalization number. Correction is downward-only by construction
  //    (correctedA = min(reported, clean), see step 3): corrected A <= reported A
  //    ALWAYS, so the ship gate can only get STRICTER (fail-closed preserved).
  const rawInputs = { ...kInputs, accuracy: accuracy_reported };
  if (kInputs.holdout_accuracy != null) rawInputs.holdout_accuracy = kInputs.holdout_accuracy;
  // Disable the additive W810 calibration surfacing for the embedded sub-scores
  // so this block never depends on a calibration file being present and stays
  // hash-stable across environments.
  rawInputs.calibration_disabled = true;

  const correctedInputs = { ...kInputs, accuracy: clamp01(correctedA), calibration_disabled: true };
  // When a holdout_accuracy (R axis) was supplied, the corrected number IS the
  // clean held-out accuracy. If the caller's holdout_accuracy equals the raw
  // reported accuracy (common: the holdout IS the eval), correct it too.
  if (kInputs.holdout_accuracy != null) {
    correctedInputs.holdout_accuracy = clamp01(correctedA);
  }

  const k_raw = computeKScore(rawInputs);
  const k_corrected = computeKScore(correctedInputs);
  const kscore_correction = round4((k_raw.composite || 0) - (k_corrected.composite || 0));

  const block = {
    spec: CONTAMINATION_IMPACT_SPEC,
    generated_at: args.generated_at || new Date().toISOString(),
    cascade: {
      tiers: ['exact', 'near', 'grouped'],
      similarity_threshold: part.params.similarity_threshold,
      group_key: part.params.group_key,
      near_dup_evaluated: part.params.near_dup_evaluated,
      train_count: part.params.train_count,
      holdout_count: part.params.holdout_count,
    },
    decomposition: {
      holdout_count: holdout.length,
      clean_count: part.clean_indices.length,
      flagged_count: part.flagged_indices.length,
      contaminated_fraction: holdout.length === 0
        ? 0
        : round4(part.flagged_indices.length / holdout.length),
      tier_hit_counts: {
        exact: part.tier_hits.exact.length,
        near: part.tier_hits.near.length,
        grouped: part.tier_hits.grouped.length,
      },
      accuracy_reported,
      accuracy_clean,
      accuracy_flagged,
    },
    inflation: {
      // accuracy_reported - accuracy_clean. Positive => the headline number was
      // INFLATED by contamination; the clean number is the corrected truth.
      delta: inflation_delta,
      ci95_low: boot.ci_low,
      ci95_high: boot.ci_high,
      bootstrap_iterations: boot.iterations,
      bootstrap_valid_iterations: boot.valid_iterations,
      bootstrap_seed: boot.seed,
      ci_level: boot.ci_level,
      ci_reason: boot.reason || null,
      // The delta is statistically distinguishable from zero only if the CI
      // excludes zero. Surfacing this saves the verifier the arithmetic.
      significant: (boot.ci_low != null && boot.ci_high != null)
        ? (boot.ci_low > 0 || boot.ci_high < 0)
        : null,
    },
    kscore: {
      raw: {
        composite: k_raw.composite,
        accuracy: k_raw.accuracy,
        ships: k_raw.ships,
        spec: k_raw.spec,
      },
      corrected: {
        composite: k_corrected.composite,
        accuracy: k_corrected.accuracy,
        ships: k_corrected.ships,
        spec: k_corrected.spec,
      },
      // Magnitude of the correction to the headline K-score.
      correction: kscore_correction,
      // Did contamination flip the ship decision? The honest, load-bearing fact.
      ship_decision_flipped: k_raw.ships !== k_corrected.ships,
      gate: k_raw.gate,
    },
  };

  // Stable content hash over the canonical block (excluding signature, which is
  // added next) so any tamper with raw/corrected numbers drifts the hash. The
  // hash is computed over the block BEFORE signed/signature/content_hash exist.
  block.content_hash = sha256(canonicalJson(block));

  // 5. Optional Ed25519 signature. The signature covers the canonical block
  //    WITH content_hash but WITHOUT the signed/signature fields (those are
  //    added after signing), exactly mirroring verifyContaminationImpactBlock.
  block.signed = false;
  block.signature = null;
  if (args.sign !== false) {
    let signer = args.signer || null;
    if (!signer) {
      try { signer = loadOrCreateDefaultSigner(); } catch { signer = null; }
    }
    if (signer && signer.privateKey && signer.publicKey) {
      const { signed: _s0, signature: _sig0, ...signedPayloadObj } = block;
      const payloadCanonical = canonicalJson(signedPayloadObj);
      const sigBlock = buildSignatureBlock({
        privateKey: signer.privateKey,
        publicKey: signer.publicKey,
        key_fingerprint: signer.key_fingerprint,
        payloadCanonical,
        signed_at: args.generated_at || undefined,
      });
      block.signed = true;
      block.signature = sigBlock;
    }
  }

  return block;
}

/**
 * verifyContaminationImpactBlock - re-derive the content hash and (if present)
 * check the Ed25519 signature. A verifier uses this to confirm the
 * raw->corrected K-score correction was not tampered with.
 *
 * @param {object} block
 * @returns {{ ok:boolean, hash_ok:boolean, signature_ok:boolean|null,
 *             reason?:string, key_fingerprint?:string }}
 */
export function verifyContaminationImpactBlock(block) {
  if (!block || typeof block !== 'object') {
    return { ok: false, hash_ok: false, signature_ok: null, reason: 'block missing or not an object' };
  }
  if (block.spec !== CONTAMINATION_IMPACT_SPEC) {
    return { ok: false, hash_ok: false, signature_ok: null, reason: `unexpected spec: ${block.spec}` };
  }
  // Recompute content_hash over the block minus { content_hash, signed, signature }.
  const { content_hash, signed, signature, ...core } = block;
  const recomputed = sha256(canonicalJson(core));
  const hash_ok = recomputed === content_hash;
  if (!hash_ok) {
    return {
      ok: false, hash_ok: false, signature_ok: null,
      reason: `content_hash drift - declared ${content_hash}, recomputed ${recomputed}`,
    };
  }

  // Signature is optional. When absent, hash integrity alone is the guarantee.
  if (!signature) {
    return { ok: true, hash_ok: true, signature_ok: null, reason: 'unsigned (hash-verified only)' };
  }

  // The signature covers the canonical block WITHOUT { signed, signature } but
  // WITH content_hash - reconstruct exactly what buildSignatureBlock signed.
  const { signed: _s, signature: _sig, ...signedPayload } = block;
  const payloadCanonical = canonicalJson(signedPayload);
  const res = verifySignatureBlock(signature, payloadCanonical);
  return {
    ok: hash_ok && res.ok,
    hash_ok,
    signature_ok: res.ok,
    reason: res.ok ? 'hash + signature verified' : res.reason,
    key_fingerprint: res.key_fingerprint,
  };
}

export default {
  CONTAMINATION_IMPACT_SPEC,
  DEFAULT_SIMILARITY_THRESHOLD,
  DEFAULT_BOOTSTRAP_ITERATIONS,
  DEFAULT_BOOTSTRAP_SEED,
  partitionHoldout,
  bootstrapDeltaCI,
  estimateContaminationImpact,
  verifyContaminationImpactBlock,
};
