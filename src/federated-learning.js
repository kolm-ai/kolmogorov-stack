// Federated learning foundations.
//
// HONEST SCOPE - what this module is and is not:
//
//   IS:
//   - The protocol *contract* and *data shapes* a kolm federated round runs
//     over. Specifies round_id, model_hash, participant_id, delta encoding,
//     contribution receipt fields.
//   - A reference *coordinator-side aggregator* that supports FedAvg, FedSGD,
//     and FedProx-style weighted averaging across N participants who have
//     handed in their local deltas.
//   - A *participant-side helper* that wraps "(start_with_global_state) ->
//     (compute_local_update_however_you_compute_it) -> (sign_and_emit_delta)"
//     so the surface matches everyone else in the round.
//   - Differential-privacy noise helpers (Gaussian and Laplace) with explicit
//     epsilon/delta accounting hooks. The DP budget is the caller's
//     responsibility; this module records what noise was applied so a downstream
//     auditor can compute the resulting privacy cost.
//   - Honest aggregator-side verification of contribution receipts: signature
//     present, model hash matches the round's announced base, delta is the
//     declared shape.
//
//   IS NOT:
//   - A network transport. Participants exchange JSON blobs via whatever
//     channel the tenant runs (HTTPS, mTLS to a hub, S3/GCS dropbox,
//     Cloudflare R2). This module hands you the blob; you ship it.
//   - Secure multi-party computation. There is no MPC primitive here. The
//     aggregator sees individual contributions in cleartext unless the
//     tenant wires a real SecAgg layer below this module.
//   - Production-grade Byzantine robustness. The aggregator detects shape /
//     hash mismatches and per-round duplicate participant IDs; it does not
//     run Krum, Multi-Krum, trimmed mean, or any other Byzantine-resilient
//     aggregator out of the box.
//     Optional local robust aggregation methods are available per round, but
//     they are algorithmic defenses, not a claim of secure transport or MPC.
//   - A trained-model output. This module aggregates *deltas*; the training
//     loop that produces a delta lives in the kolm distill worker (Task J).
//
// What "foundations" earns you:
//   - You can stand up a federated round between N kolm tenants today, with
//     real signatures, real round bookkeeping, real DP noise, and a
//     receipt chain. What you *cannot* claim is that the aggregation is
//     cryptographically private (no SecAgg) or Byzantine-robust (no Krum).
//     Both are explicit follow-on waves.

import crypto from 'node:crypto';

export const FL_SPEC_VERSION = 'fl-v1';

// W409u - Honest "foundation" labeling. The federated module is a working
// data + protocol contract; it is NOT a production secure-aggregation /
// Byzantine-robust implementation. Every produced object carries this
// feature_state so downstream consumers (verifier, dashboards, product copy)
// cannot mistake it for a production federated learning claim.
export const FEATURE_STATE = 'foundation';
// Stable copy strings - product surfaces must use these, never substitute
// "production federated learning" without registering a real plugin first.
export const FEATURE_STATE_LABEL = 'Federated learning (foundation)';
export const FEATURE_STATE_DESCRIPTION =
  'Foundation: protocol contract + aggregator + DP helpers. No secure-aggregation, no network transport, no production Byzantine robustness by default. Configure robust aggregation per round and wire a registered SecAgg plugin to upgrade proof scope.';

// Pluggable SecAgg plugin registry. Defaults to empty - every artifact that
// claims secure_aggregation_verified:true MUST come from a registered plugin
// returning ok:true. (W409u)
const _secagg_plugins = new Map();
export function registerSecureAggregationPlugin(provider, fn) {
  if (typeof provider !== 'string' || !provider) throw new Error('provider name required');
  if (typeof fn !== 'function') throw new Error('plugin must be a function');
  _secagg_plugins.set(provider, fn);
}
export function clearSecureAggregationPlugin(provider) {
  _secagg_plugins.delete(provider);
}
export function listSecureAggregationPlugins() {
  return Array.from(_secagg_plugins.keys()).sort();
}

// Aggregation strategies the reference aggregator supports.
export const STRATEGIES = Object.freeze({
  FEDAVG:  'fedavg',   // weighted mean of deltas by participant.sample_count
  FEDSGD:  'fedsgd',   // simple mean of deltas (equal weight)
  FEDPROX: 'fedprox',  // FedAvg + proximal-term scaling (uses participant.mu)
});

export const ROBUST_AGGREGATORS = Object.freeze({
  NONE: 'none',
  TRIMMED_MEAN: 'trimmed_mean',
  COORDINATE_MEDIAN: 'coordinate_median',
  KRUM: 'krum',
  MULTI_KRUM: 'multi_krum',
});

// What's in a Round? The coordinator broadcasts this before participants
// compute their local updates. Embedded verbatim in every contribution receipt.
export function newRound({ round_id, model_hash, base_artifact_version, target_strategy, target_dp = null, min_participants = 3, deadline = null, transport = null, secure_aggregation = null, robust_aggregation = null }) {
  if (!round_id || typeof round_id !== 'string') throw new Error('round_id required');
  if (!model_hash || typeof model_hash !== 'string') throw new Error('model_hash required');
  if (!Object.values(STRATEGIES).includes(target_strategy)) {
    throw new Error(`unknown target_strategy: ${target_strategy}`);
  }
  if (target_dp && (target_dp.epsilon == null || target_dp.delta == null)) {
    throw new Error('target_dp requires { epsilon, delta }');
  }
  const robust = _normalizeRobustAggregation(robust_aggregation);
  return {
    spec: FL_SPEC_VERSION,
    feature_state: FEATURE_STATE,
    round_id,
    model_hash,
    base_artifact_version: base_artifact_version || null,
    target_strategy,
    target_dp,
    min_participants,
    deadline: deadline || null,
    issued_at: new Date().toISOString(),
    // W409u - honest transport + SecAgg placeholders. The default transport
    // is the in-memory dev harness used by tests; production deployments
    // must override via a registered transport plugin (separate wave).
    transport: transport || 'in_memory_dev_only',
    secure_aggregation: secure_aggregation || {
      status: 'not_verified',
      provider: null,
      verified_at: null,
    },
    byzantine_robust: robust.method !== ROBUST_AGGREGATORS.NONE,
    byzantine_strategy: robust.method === ROBUST_AGGREGATORS.NONE ? null : robust,
    // Privacy budget placeholder. Both epsilon + delta are null until a
    // real DP accountant is wired (separate wave). target_dp above still
    // controls round-time noise; this is the cumulative-budget surface
    // that downstream auditors read.
    privacy_budget: { epsilon: null, delta: null },
  };
}

// Compute the round hash that goes into every participant's receipt so the
// aggregator + verifier can confirm everyone trained against the same base.
export function roundHash(round) {
  return _shortHash(_canonicalize(_roundHashPayload(round)));
}

// PARTICIPANT SIDE -------------------------------------------------------
//
// The participant (each kolm tenant) is given a Round and produces a
// Contribution. The local training step is opaque to this module - you hand
// us the delta tensor (in our compact representation), the sample_count, and
// optionally a mu (for FedProx). We add the signature + receipt fields.

// Build a contribution. `delta` is a plain object - keys are tensor names,
// values are 1-D numeric arrays of update values. Shape and key names must
// match what the round's base model expects; the aggregator checks this.
//
// `private_key` is an Ed25519 PEM. The contribution is signed so the
// aggregator + downstream auditor can confirm provenance.
export function buildContribution({ round, participant_id, client_id, delta, sample_count, mu, private_key, dp_applied, dataset_hash, reviewed }) {
  if (!round || round.spec !== FL_SPEC_VERSION) throw new Error('invalid round');
  // W409u - keep the original `participant_id` field, but also expose
  // `client_id` so the new client_update schema works alongside it.
  const cid = client_id || participant_id;
  if (!cid || typeof cid !== 'string') throw new Error('participant_id (or client_id) required');
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) throw new Error('delta must be an object');
  if (sample_count == null || sample_count < 0) throw new Error('sample_count required');
  if (round.target_strategy === STRATEGIES.FEDPROX && (mu == null || mu < 0)) {
    throw new Error('fedprox requires mu >= 0');
  }
  const r_hash = roundHash(round);
  const d_hash = _shortHash(_canonicalize(delta));
  const dp = dp_applied ? {
    mechanism: dp_applied.mechanism,
    noise_scale: dp_applied.noise_scale,
    sensitivity: dp_applied.sensitivity,
    epsilon_spent: dp_applied.epsilon_spent,
    delta_spent: dp_applied.delta_spent,
  } : null;
  // W409u client_update schema (fields tests assert):
  //   round_id, client_id, gradient_summary_hash, sample_count, dataset_hash,
  //   reviewed{ state }, feature_state
  const base = {
    spec: FL_SPEC_VERSION,
    feature_state: FEATURE_STATE,
    round_id: round.round_id,
    round_hash: r_hash,
    participant_id: cid,
    client_id: cid,
    sample_count,
    mu: mu == null ? null : mu,
    delta_hash: d_hash,
    // Alias used by the W409u schema. delta_hash is the canonical content
    // hash of the contributed delta; gradient_summary_hash is the same
    // value under the schema name auditors look for.
    gradient_summary_hash: d_hash,
    delta_shapes: _shapesOf(delta),
    dp_applied: dp,
    // Lineage - dataset_hash optional but recommended; ties the contribution
    // back through team_learning to a specific reviewed-and-approved
    // dataset (see src/team-events.js buildTeamDataset).
    dataset_hash: dataset_hash || null,
    // Reviewer state. W409u: any client_update that lands at the aggregator
    // with reviewed.state !== 'approved' is rejected - federated rounds do
    // not silently train on unreviewed local captures.
    reviewed: reviewed && reviewed.state ? { state: reviewed.state, reviewer: reviewed.reviewer || null } : { state: 'pending', reviewer: null },
    submitted_at: new Date().toISOString(),
  };
  base.signature = private_key ? _sign(_canonicalize(base), private_key) : null;
  // Delta is attached separately so it can travel as a binary attachment
  // when the receipt itself is logged. Round-tripped together in tests.
  return { receipt: base, delta };
}

// AGGREGATOR SIDE --------------------------------------------------------
//
// The coordinator collects N contributions, verifies them, and applies the
// chosen strategy to produce a single aggregated delta to broadcast back.

export function verifyContribution({ contribution, round, public_key, require_reviewed }) {
  if (!contribution || !contribution.receipt) return { ok: false, reason: 'no_receipt' };
  const r = contribution.receipt;
  if (r.spec !== FL_SPEC_VERSION) return { ok: false, reason: 'spec_mismatch' };
  if (r.round_id !== round.round_id) return { ok: false, reason: 'wrong_round_id' };
  if (r.round_hash !== roundHash(round)) return { ok: false, reason: 'round_hash_mismatch' };
  const recomputed_delta = _shortHash(_canonicalize(contribution.delta));
  if (recomputed_delta !== r.delta_hash) return { ok: false, reason: 'delta_hash_mismatch' };
  const shapes = _shapesOf(contribution.delta);
  if (_canonicalize(shapes) !== _canonicalize(r.delta_shapes)) return { ok: false, reason: 'shape_mismatch' };
  // W409u - reject any contribution whose reviewed.state is not 'approved'
  // when require_reviewed:true. Default is back-compat (false) so existing
  // round flows keep working until the caller opts into the gate. Aggregator
  // code that wants the W409u gate should set require_reviewed:true.
  if (require_reviewed === true) {
    const rs = (r.reviewed && r.reviewed.state) || 'pending';
    if (rs !== 'approved') return { ok: false, reason: 'unreviewed_client_update', reviewed_state: rs };
  }
  if (public_key) {
    const { signature, ...unsigned } = r;
    const sigOk = _verify(_canonicalize(unsigned), signature, public_key);
    if (!sigOk) return { ok: false, reason: 'signature_failed' };
  }
  return { ok: true };
}

// FedAvg / FedSGD / FedProx in pure JS. Inputs are an array of verified
// contributions (use verifyContribution first; the aggregator should refuse
// to fold in anything that didn't pass). Returns the aggregated delta in
// the same shape as the inputs, plus the receipt the aggregator publishes.
export function aggregate({ round, contributions, started_at }) {
  if (!round || round.spec !== FL_SPEC_VERSION) throw new Error('invalid round');
  if (!Array.isArray(contributions) || contributions.length === 0) {
    throw new Error('contributions must be a non-empty array');
  }
  if (contributions.length < round.min_participants) {
    throw new Error(`too few participants: ${contributions.length} < min ${round.min_participants}`);
  }
  // Reject duplicate participant_ids - basic sybil guard, NOT a real
  // Byzantine defense.
  const seen = new Set();
  for (const c of contributions) {
    if (seen.has(c.receipt.participant_id)) {
      throw new Error(`duplicate participant_id: ${c.receipt.participant_id}`);
    }
    seen.add(c.receipt.participant_id);
  }

  const first = contributions[0].delta;
  const keys = _validateDeltaShapes(contributions);
  const robust = _normalizeRobustAggregation(round.byzantine_strategy || round.robust_aggregation || null);
  const robustEnabled = robust.method !== ROBUST_AGGREGATORS.NONE;
  const aggregated_delta = robustEnabled
    ? _robustAggregate({ round, contributions, keys, config: robust })
    : _weightedAggregate({ round, contributions, keys, first });
  const aggregated_hash = _shortHash(_canonicalize(aggregated_delta));
  const dp_summary = _summarizeDp(contributions);
  const privacy_budget = _composePrivacyBudget(round, contributions);

  // W409u aggregation_round schema fields:
  //   round_id, participants, started_at, completed_at, aggregation_method,
  //   byzantine_robust:false, feature_state, dataset_hashes (lineage to
  //   client_updates).
  const completed_at = new Date().toISOString();
  const receipt = {
    spec: FL_SPEC_VERSION,
    feature_state: FEATURE_STATE,
    round_id: round.round_id,
    round_hash: roundHash(round),
    strategy: round.target_strategy,
    aggregation_method: round.target_strategy,
    participant_count: contributions.length,
    participants: contributions.map(c => c.receipt.participant_id).sort(),
    participant_ids: contributions.map(c => c.receipt.participant_id).sort(),
    client_updates: contributions.map(c => ({
      client_id: c.receipt.client_id || c.receipt.participant_id,
      gradient_summary_hash: c.receipt.gradient_summary_hash || c.receipt.delta_hash,
      sample_count: c.receipt.sample_count,
      dataset_hash: c.receipt.dataset_hash || null,
      reviewed_state: (c.receipt.reviewed && c.receipt.reviewed.state) || 'pending',
    })),
    dataset_hashes: Array.from(new Set(contributions.map(c => c.receipt.dataset_hash).filter(Boolean))).sort(),
    total_samples: contributions.reduce((s, c) => s + (c.receipt.sample_count || 0), 0),
    aggregated_delta_hash: aggregated_hash,
    started_at: started_at || completed_at,
    completed_at,
    aggregated_at: completed_at,
    byzantine_robust: robustEnabled,
    byzantine_strategy: robustEnabled ? robust : null,
    secure_aggregation: round.secure_aggregation || { status: 'not_verified', provider: null, verified_at: null },
    privacy_budget,
    dp_summary,
  };
  return { receipt, aggregated_delta };
}

function _participantWeight(strategy, c) {
  switch (strategy) {
    case STRATEGIES.FEDAVG:  return Math.max(1, c.receipt.sample_count || 1);
    case STRATEGIES.FEDSGD:  return 1;
    case STRATEGIES.FEDPROX: return Math.max(1, c.receipt.sample_count || 1) * (1 + (c.receipt.mu || 0));
    default: return 1;
  }
}
function _totalWeight(strategy, contributions) {
  return contributions.reduce((s, c) => s + _participantWeight(strategy, c), 0);
}

function _weightedAggregate({ round, contributions, keys, first }) {
  const acc = {};
  for (const k of keys) acc[k] = new Array(first[k].length).fill(0);
  const total_weight = _totalWeight(round.target_strategy, contributions);
  for (const c of contributions) {
    const w = _participantWeight(round.target_strategy, c) / total_weight;
    for (const k of keys) {
      const v = c.delta[k];
      for (let i = 0; i < v.length; i++) acc[k][i] += w * v[i];
    }
  }
  return acc;
}

function _normalizeRobustAggregation(config) {
  if (!config || config === true) return { method: ROBUST_AGGREGATORS.NONE };
  if (typeof config === 'string') config = { method: config };
  if (typeof config !== 'object' || Array.isArray(config)) throw new Error('robust_aggregation must be an object, string, or null');
  const method = String(config.method || ROBUST_AGGREGATORS.NONE).toLowerCase().replace(/-/g, '_');
  if (!Object.values(ROBUST_AGGREGATORS).includes(method)) throw new Error(`unknown robust aggregation method: ${method}`);
  if (method === ROBUST_AGGREGATORS.NONE) return { method };
  const f = Math.max(0, Math.floor(Number(config.f ?? config.max_byzantine ?? 1)));
  const trim_ratio = Math.max(0, Math.min(0.49, Number(config.trim_ratio ?? 0.2)));
  const m = config.m == null ? null : Math.max(1, Math.floor(Number(config.m)));
  return { method, f, trim_ratio, m };
}

function _validateDeltaShapes(contributions) {
  const first = contributions[0].delta;
  const keys = Object.keys(first).sort();
  for (const c of contributions) {
    const got = Object.keys(c.delta || {}).sort();
    if (_canonicalize(got) !== _canonicalize(keys)) throw new Error(`shape mismatch for participant ${c.receipt.participant_id}`);
    for (const k of keys) {
      const v = c.delta[k];
      if (!Array.isArray(v) || !Array.isArray(first[k]) || v.length !== first[k].length) {
        throw new Error(`shape mismatch for key ${k} in participant ${c.receipt.participant_id}`);
      }
      for (const x of v) {
        if (!Number.isFinite(Number(x))) throw new Error(`non_numeric_delta for key ${k} in participant ${c.receipt.participant_id}`);
      }
    }
  }
  return keys;
}

function _robustAggregate({ contributions, keys, config }) {
  switch (config.method) {
    case ROBUST_AGGREGATORS.COORDINATE_MEDIAN:
      return _coordinateMedian(contributions, keys);
    case ROBUST_AGGREGATORS.TRIMMED_MEAN:
      return _trimmedMean(contributions, keys, config);
    case ROBUST_AGGREGATORS.KRUM:
      return _cloneDelta(contributions[_krumWinner(contributions, keys, config.f)].delta);
    case ROBUST_AGGREGATORS.MULTI_KRUM:
      return _meanDeltas(_multiKrumWinners(contributions, keys, config), keys);
    default:
      throw new Error(`unsupported robust aggregation method: ${config.method}`);
  }
}

function _coordinateMedian(contributions, keys) {
  const out = {};
  for (const k of keys) {
    out[k] = [];
    for (let i = 0; i < contributions[0].delta[k].length; i++) {
      const vals = contributions.map((c) => Number(c.delta[k][i])).sort((a, b) => a - b);
      out[k][i] = _median(vals);
    }
  }
  return out;
}

function _trimmedMean(contributions, keys, config) {
  const n = contributions.length;
  const trim = Math.min(Math.floor((n - 1) / 2), Math.max(config.f || 0, Math.floor(n * (config.trim_ratio || 0))));
  if (trim * 2 >= n) throw new Error(`trimmed_mean requires more participants than trim count: n=${n} trim=${trim}`);
  const out = {};
  for (const k of keys) {
    out[k] = [];
    for (let i = 0; i < contributions[0].delta[k].length; i++) {
      const vals = contributions.map((c) => Number(c.delta[k][i])).sort((a, b) => a - b).slice(trim, n - trim);
      out[k][i] = vals.reduce((s, v) => s + v, 0) / vals.length;
    }
  }
  return out;
}

function _krumWinner(contributions, keys, f) {
  const winners = _multiKrumWinners(contributions, keys, { f, m: 1 });
  return contributions.indexOf(winners[0]);
}

function _multiKrumWinners(contributions, keys, config) {
  const n = contributions.length;
  const f = Math.max(0, Math.floor(config.f || 0));
  if (n < (2 * f + 3)) throw new Error(`krum requires n >= 2f + 3; got n=${n} f=${f}`);
  const vectors = contributions.map((c) => _flattenDelta(c.delta, keys));
  const neighborCount = n - f - 2;
  const scored = vectors.map((v, i) => {
    const distances = vectors
      .map((other, j) => (i === j ? null : _squaredDistance(v, other)))
      .filter((x) => x != null)
      .sort((a, b) => a - b);
    return { i, score: distances.slice(0, neighborCount).reduce((s, d) => s + d, 0) };
  }).sort((a, b) => (a.score - b.score) || a.i - b.i);
  const maxM = Math.max(1, n - f - 2);
  const m = Math.min(maxM, Math.max(1, Math.floor(config.m || maxM)));
  return scored.slice(0, m).map((row) => contributions[row.i]);
}

function _meanDeltas(contributions, keys) {
  const out = {};
  for (const k of keys) {
    out[k] = [];
    for (let i = 0; i < contributions[0].delta[k].length; i++) {
      out[k][i] = contributions.reduce((s, c) => s + Number(c.delta[k][i]), 0) / contributions.length;
    }
  }
  return out;
}

function _flattenDelta(delta, keys) {
  const out = [];
  for (const k of keys) out.push(...delta[k].map(Number));
  return out;
}

function _cloneDelta(delta) {
  return Object.fromEntries(Object.entries(delta).map(([k, v]) => [k, v.slice()]));
}

function _squaredDistance(a, b) {
  let out = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    out += d * d;
  }
  return out;
}

function _median(vals) {
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}

function _summarizeDp(contributions) {
  const applied = contributions.filter(c => c.receipt.dp_applied);
  if (applied.length === 0) return null;
  const eps = applied.map(c => c.receipt.dp_applied.epsilon_spent).filter((v) => Number.isFinite(Number(v))).map(Number);
  const deltas = applied.map(c => c.receipt.dp_applied.delta_spent).filter((v) => Number.isFinite(Number(v))).map(Number);
  return {
    participants_with_dp: applied.length,
    epsilon_min: eps.length ? Math.min(...eps) : null,
    epsilon_max: eps.length ? Math.max(...eps) : null,
    epsilon_sum_basic: eps.length ? eps.reduce((s, v) => s + v, 0) : null,
    delta_sum_basic: deltas.length ? deltas.reduce((s, v) => s + v, 0) : null,
    mechanisms: Array.from(new Set(applied.map(c => c.receipt.dp_applied.mechanism))).sort(),
    note: 'Per-round DP bookkeeping is the participant\'s responsibility. The aggregator surfaces what was claimed; it does not recompute the budget.',
  };
}

function _composePrivacyBudget(round, contributions) {
  const applied = contributions.filter(c => c.receipt.dp_applied);
  if (!applied.length) return round.privacy_budget || { epsilon: null, delta: null };
  const eps = applied.map(c => c.receipt.dp_applied.epsilon_spent).filter((v) => Number.isFinite(Number(v))).map(Number);
  const deltas = applied.map(c => c.receipt.dp_applied.delta_spent).filter((v) => Number.isFinite(Number(v))).map(Number);
  return {
    epsilon: eps.length ? eps.reduce((s, v) => s + v, 0) : null,
    delta: deltas.length ? deltas.reduce((s, v) => s + v, 0) : null,
    composition: 'basic',
    participants_with_dp: applied.length,
    target: round.target_dp || null,
  };
}

// DIFFERENTIAL PRIVACY HELPERS ------------------------------------------
//
// Gaussian and Laplace noise injection. The CALLER is responsible for the
// privacy budget (epsilon, delta) bookkeeping. These helpers add the noise
// and emit the dp_applied record that the participant attaches to their
// receipt - they DO NOT track cumulative budget across rounds.

// Gaussian mechanism: noise ~ N(0, (sensitivity * sigma)^2). Returns the
// noised array and the dp_applied record.
export function applyGaussianNoise(array, { sensitivity, sigma, epsilon_spent, delta_spent }) {
  if (!Array.isArray(array)) throw new Error('array required');
  if (sensitivity == null || sigma == null) throw new Error('sensitivity + sigma required');
  const out = new Array(array.length);
  for (let i = 0; i < array.length; i++) {
    out[i] = array[i] + _gaussian() * sensitivity * sigma;
  }
  return {
    noised: out,
    dp_applied: {
      mechanism: 'gaussian',
      noise_scale: sensitivity * sigma,
      sensitivity,
      sigma,
      epsilon_spent: epsilon_spent ?? null,
      delta_spent: delta_spent ?? null,
    },
  };
}

// Laplace mechanism: noise ~ Lap(0, sensitivity / epsilon). Epsilon required.
export function applyLaplaceNoise(array, { sensitivity, epsilon, epsilon_spent }) {
  if (!Array.isArray(array)) throw new Error('array required');
  if (sensitivity == null || epsilon == null) throw new Error('sensitivity + epsilon required');
  const scale = sensitivity / epsilon;
  const out = new Array(array.length);
  for (let i = 0; i < array.length; i++) {
    out[i] = array[i] + _laplace(scale);
  }
  return {
    noised: out,
    dp_applied: {
      mechanism: 'laplace',
      noise_scale: scale,
      sensitivity,
      epsilon,
      epsilon_spent: epsilon_spent ?? epsilon,
      delta_spent: 0,
    },
  };
}

// Approximate clipping for per-example gradient norms. Standard sanity step
// before DP noise injection. Operates in place on a single 1-D array.
export function clipNorm(array, max_norm) {
  if (!Array.isArray(array)) throw new Error('array required');
  if (!(max_norm > 0)) throw new Error('max_norm must be > 0');
  let sq = 0;
  for (const v of array) sq += v * v;
  const norm = Math.sqrt(sq);
  if (norm <= max_norm) return { clipped: array.slice(), clip_applied: false, original_norm: norm };
  const scale = max_norm / norm;
  const clipped = array.map(v => v * scale);
  return { clipped, clip_applied: true, original_norm: norm, max_norm };
}

// INTERNALS --------------------------------------------------------------

function _shortHash(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16); }
function _roundHashPayload(round) {
  if (!round || typeof round !== 'object') return round;
  const { issued_at, ...semanticRound } = round;
  return semanticRound;
}
function _canonicalize(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(_canonicalize).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + _canonicalize(v[k])).join(',') + '}';
}
function _shapesOf(delta) {
  const out = {};
  for (const k of Object.keys(delta).sort()) {
    out[k] = Array.isArray(delta[k]) ? [delta[k].length] : null;
  }
  return out;
}
function _gaussian() {
  // Box-Muller. Pulls fresh randomness; not seeded.
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function _laplace(scale) {
  const u = Math.random() - 0.5;
  return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}

function _sign(payload, privKeyPem) {
  const key = crypto.createPrivateKey(privKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), key);
  return sig.toString('base64');
}
function _verify(payload, sigB64, pubKeyPem) {
  if (!sigB64) return false;
  try {
    const key = crypto.createPublicKey(pubKeyPem);
    return crypto.verify(null, Buffer.from(payload, 'utf8'), key, Buffer.from(sigB64, 'base64'));
  } catch { return false; }
}

// Tiny helper for tests - generate an ephemeral Ed25519 keypair.
// Returns snake_case keys to match the rest of the FL module's API
// (buildContribution takes `private_key`; verifyContribution takes `public_key`).
export function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  return { public_key: publicKey, private_key: privateKey };
}

// W409u - Foundation-state verifier. Given an artifact that claims to have
// run through a federated aggregation round, surface the verifier state
// that downstream auditors / product copy should respect:
//
//   federated_foundation: true - every federated artifact starts here
//   secure_aggregation_verified: false - only flips true when a registered
//                                        plugin returns ok:true
//   byzantine_robust: false - not implemented; lock to false
//
// The verifier ALSO rejects artifacts whose embedded aggregation claims
// `secure_aggregation_verified: true` without a registered plugin
// returning ok:true. This is the gate that the product can lean on when
// rendering "confidential federated learning verified" badges - without it,
// the badge cannot legitimately appear.
export async function verifyFederatedArtifact(artifact, opts = {}) {
  if (!artifact || typeof artifact !== 'object') {
    return {
      ok: false,
      federated_foundation: true,
      secure_aggregation_verified: false,
      reason: 'no_artifact',
    };
  }
  const aggregation = artifact.aggregation_round || artifact.aggregation || null;
  const claim = artifact.secure_aggregation ||
    (aggregation && aggregation.secure_aggregation) ||
    { status: 'not_verified', provider: null };
  const claimsVerified = artifact.secure_aggregation_verified === true ||
    (claim && claim.status === 'verified');
  const state = {
    spec: FL_SPEC_VERSION,
    feature_state: FEATURE_STATE,
    federated_foundation: true,
    secure_aggregation_verified: false,
    byzantine_robust: false,
    byzantine_strategy: null,
    transport: artifact.transport || (aggregation && aggregation.transport) || 'in_memory_dev_only',
    plugin: null,
    reason: null,
    verified_at: new Date().toISOString(),
  };
  const robustClaim = artifact.byzantine_robust === true || (aggregation && aggregation.byzantine_robust === true);
  if (robustClaim) {
    const robust = _normalizeRobustAggregation(artifact.byzantine_strategy || (aggregation && aggregation.byzantine_strategy) || null);
    if (robust.method === ROBUST_AGGREGATORS.NONE) {
      return { ...state, ok: false, reason: 'byzantine_robust_claimed_no_supported_strategy' };
    }
    state.byzantine_robust = true;
    state.byzantine_strategy = robust;
  }
  if (claimsVerified) {
    const provider = claim.provider || opts.provider;
    if (!provider) {
      return { ...state, ok: false, reason: 'secure_aggregation_claimed_no_provider' };
    }
    const plugin = _secagg_plugins.get(provider);
    if (!plugin) {
      return { ...state, ok: false, reason: 'secure_aggregation_no_plugin', plugin: provider };
    }
    try {
      const r = await plugin(claim, opts);
      if (r && r.ok === true) {
        return {
          ...state,
          ok: true,
          secure_aggregation_verified: true,
          plugin: provider,
        };
      }
      return { ...state, ok: false, reason: 'secure_aggregation_plugin_returned_falsy', plugin: provider, plugin_reason: (r && r.reason) || null };
    } catch (e) {
      return { ...state, ok: false, reason: `secure_aggregation_plugin_threw:${e.message}`, plugin: provider };
    }
  }
  // Foundation path - artifact does not claim verified SecAgg; OK because
  // the foundation label is honest.
  return { ...state, ok: true, reason: 'foundation_no_claim' };
}

// Lineage walker - given an aggregation_round receipt, return the chain
// {artifact → aggregation_round → client_updates → dataset_hash[]} so a
// downstream verifier can prove the data path. Each step carries the
// fields tests assert on. (W409u)
export function traceLineage(aggregationReceipt) {
  if (!aggregationReceipt) return null;
  const clientUpdates = aggregationReceipt.client_updates || [];
  return {
    spec: FL_SPEC_VERSION,
    feature_state: FEATURE_STATE,
    round_id: aggregationReceipt.round_id,
    aggregated_delta_hash: aggregationReceipt.aggregated_delta_hash,
    client_updates: clientUpdates.map(c => ({
      client_id: c.client_id,
      gradient_summary_hash: c.gradient_summary_hash,
      sample_count: c.sample_count,
      dataset_hash: c.dataset_hash,
      reviewed_state: c.reviewed_state,
    })),
    dataset_hashes: Array.from(new Set(clientUpdates.map(c => c.dataset_hash).filter(Boolean))).sort(),
  };
}

export default {
  FL_SPEC_VERSION,
  FEATURE_STATE,
  FEATURE_STATE_LABEL,
  FEATURE_STATE_DESCRIPTION,
  STRATEGIES,
  ROBUST_AGGREGATORS,
  newRound,
  roundHash,
  buildContribution,
  verifyContribution,
  aggregate,
  applyGaussianNoise,
  applyLaplaceNoise,
  clipNorm,
  generateKeypair,
  verifyFederatedArtifact,
  traceLineage,
  registerSecureAggregationPlugin,
  clearSecureAggregationPlugin,
  listSecureAggregationPlugins,
};
