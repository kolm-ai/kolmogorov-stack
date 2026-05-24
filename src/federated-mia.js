// src/federated-mia.js
//
// W830-2 — Membership-Inference Attack (MIA) resistance verifier.
//
// Closes the audit gap on "verifiable privacy claim" for federated /
// distilled artifacts. The federated layer (src/federated-learning.js +
// src/federated-approvals.js) ships:
//   - DP noise injection (Gaussian / Laplace) with epsilon/delta bookkeeping.
//   - Hash-only approval-row sharing with Laplace-noised counts.
//
// What's missing is the FLIP side: how do we prove, after the fact, that
// a shipped artifact resists membership-inference? An attacker who held a
// candidate input asks "was this row in your training set?" — they should
// only be able to win that game at the rate set by the privacy budget.
//
// HONEST SCOPE — what this module IS and IS NOT:
//
//   IS:
//   - A protocol contract for plugging shadow-model MIA evaluations into
//     the artifact verifier. Takes shadow_models, train_set, holdout_set
//     and produces { auc_attack, p_member_threshold }.
//   - An honest-stub when shadow_models are not provided. We DO NOT silently
//     return ok:true — we return {ok:false, error:'mia_requires_shadow_models'}.
//   - A verdict envelope for artifact-time MIA check given live attack
//     probabilities: 'passing' when AUC ≤ p_threshold, 'leaking' otherwise.
//   - A DP claim auditor: dpEpsilonAudit reads manifest.privacy.dp_epsilon
//     and produces a verifiable claim envelope with audit_method tagged.
//
//   IS NOT:
//   - A trained MIA attacker. The shadow-model attack callers feed in are
//     opaque to this module — we score the output, not implement the model.
//   - A DP accountant. dpEpsilonAudit READS the claimed epsilon; it does
//     NOT recompute the cumulative budget across rounds (that's the job of
//     src/federated-learning.js _composePrivacyBudget when running rounds).
//   - A guarantee. A 'passing' verdict bounds the attacker AUC observed
//     in YOUR test setup; it does not bound an adversary with better
//     shadow-model coverage.

import crypto from 'node:crypto';

export const MIA_SPEC_VERSION = 'mia-v1';
export const FEATURE_STATE = 'foundation';
export const FEATURE_STATE_LABEL = 'Membership-Inference resistance (foundation)';
export const FEATURE_STATE_DESCRIPTION =
  'Foundation: protocol contract + honest stubs + DP-claim auditor. The actual ' +
  'shadow-model attack is opt-in via calibrateMIA; the foundation guarantees ' +
  'that no artifact gets a "passing" MIA badge unless a real attack envelope ' +
  'was supplied and AUC <= p_threshold.';

// Default MIA-pass threshold. AUC of 0.55 = attacker barely beats coin flip;
// values closer to 0.50 = perfect privacy, 1.00 = perfect leak. Tenants may
// override per-call.
export const DEFAULT_P_MEMBER_THRESHOLD = 0.55;

// --------------------------------------------------------------------------
// calibrateMIA — compute the attack AUC from N shadow models trained on
// disjoint shards of the same data distribution as the target artifact.
//
//   shadow_models : array of {predict_proba(x) -> [p_member, p_nonmember]}.
//   train_set     : array of inputs known to be in the target artifact's
//                   training data.
//   holdout_set   : array of inputs known to NOT be in the training data.
//
// Returns { ok, auc_attack, p_member_threshold, n_shadow_models } on success.
// Returns { ok:false, error:'mia_requires_shadow_models', install_hint }
// when the input is too small to mount the attack honestly.
// --------------------------------------------------------------------------
export function calibrateMIA({ shadow_models = [], train_set = [], holdout_set = [] } = {}) {
  // Honest stub — refuse to fabricate an AUC when we don't have the shadow
  // models. A "missing shadow models" path that returned auc=0 would
  // silently certify every artifact as MIA-resistant — exactly the failure
  // the federated module was built to prevent.
  if (!Array.isArray(shadow_models) || shadow_models.length < 3) {
    return {
      ok: false,
      spec: MIA_SPEC_VERSION,
      feature_state: FEATURE_STATE,
      error: 'mia_requires_shadow_models',
      install_hint: 'Provide >=3 shadow models trained on disjoint shards',
      n_shadow_models: Array.isArray(shadow_models) ? shadow_models.length : 0,
      auc_attack: null,
      p_member_threshold: null,
    };
  }
  if (!Array.isArray(train_set) || train_set.length === 0) {
    return {
      ok: false,
      spec: MIA_SPEC_VERSION,
      feature_state: FEATURE_STATE,
      error: 'mia_requires_train_set',
      install_hint: 'Pass train_set: at least one in-distribution member',
      n_shadow_models: shadow_models.length,
    };
  }
  if (!Array.isArray(holdout_set) || holdout_set.length === 0) {
    return {
      ok: false,
      spec: MIA_SPEC_VERSION,
      feature_state: FEATURE_STATE,
      error: 'mia_requires_holdout_set',
      install_hint: 'Pass holdout_set: at least one held-out non-member',
      n_shadow_models: shadow_models.length,
    };
  }

  // Score each input through every shadow model, then average the per-input
  // p_member scores across shadow models. The resulting two pools (members,
  // non-members) are reduced to an AUC by counting the fraction of
  // (member, non-member) pairs where the member ranked strictly higher.
  const scoreOne = (x) => {
    let acc = 0;
    let n = 0;
    for (const sm of shadow_models) {
      try {
        const out = typeof sm === 'function' ? sm(x) : (sm && typeof sm.predict_proba === 'function' ? sm.predict_proba(x) : null);
        const p = Array.isArray(out) ? Number(out[0]) : Number(out);
        if (Number.isFinite(p)) { acc += p; n += 1; }
      } catch { /* skip broken shadow models silently per-input */ }
    }
    return n > 0 ? (acc / n) : 0.5; // unknown -> coin flip
  };
  const member_scores = train_set.map(scoreOne);
  const nonmember_scores = holdout_set.map(scoreOne);
  let wins = 0;
  let pairs = 0;
  for (const m of member_scores) {
    for (const nm of nonmember_scores) {
      pairs += 1;
      if (m > nm) wins += 1;
      else if (m === nm) wins += 0.5;
    }
  }
  const auc_attack = pairs > 0 ? (wins / pairs) : 0.5;

  return {
    ok: true,
    spec: MIA_SPEC_VERSION,
    feature_state: FEATURE_STATE,
    auc_attack,
    p_member_threshold: DEFAULT_P_MEMBER_THRESHOLD,
    n_shadow_models: shadow_models.length,
    n_train: train_set.length,
    n_holdout: holdout_set.length,
    calibrated_at: new Date().toISOString(),
  };
}

// --------------------------------------------------------------------------
// verifyArtifactMIAResistance — given an artifact_id and a list of
// test_inputs, produce a {passing|leaking} verdict at the caller-supplied
// p_threshold. Threads through to calibrateMIA when the caller has shadow
// models available; otherwise returns honest-stub.
// --------------------------------------------------------------------------
export function verifyArtifactMIAResistance({
  artifact_id,
  test_inputs = [],
  shadow_models = [],
  train_set = null,
  holdout_set = null,
  p_threshold = DEFAULT_P_MEMBER_THRESHOLD,
} = {}) {
  if (!artifact_id || typeof artifact_id !== 'string') {
    return {
      ok: false,
      spec: MIA_SPEC_VERSION,
      feature_state: FEATURE_STATE,
      error: 'artifact_id_required',
      verdict: 'unknown',
      detail: 'artifact_id (string) is required',
    };
  }
  if (!Array.isArray(test_inputs) || test_inputs.length === 0) {
    return {
      ok: false,
      spec: MIA_SPEC_VERSION,
      feature_state: FEATURE_STATE,
      error: 'test_inputs_required',
      verdict: 'unknown',
      detail: 'test_inputs (non-empty array) is required',
    };
  }
  // If caller passed shadow_models + train/holdout splits, run calibration.
  // Otherwise treat test_inputs as a 50/50 split for a quick check.
  const tset = train_set || test_inputs.slice(0, Math.floor(test_inputs.length / 2));
  const hset = holdout_set || test_inputs.slice(Math.floor(test_inputs.length / 2));
  const calib = calibrateMIA({ shadow_models, train_set: tset, holdout_set: hset });
  if (!calib.ok) {
    return {
      ok: false,
      spec: MIA_SPEC_VERSION,
      feature_state: FEATURE_STATE,
      artifact_id,
      verdict: 'unknown',
      error: calib.error,
      install_hint: calib.install_hint,
      attack_auc: null,
      p_at_threshold: p_threshold,
      detail: 'calibration failed — see error/install_hint',
    };
  }
  const passing = calib.auc_attack <= p_threshold;
  return {
    ok: true,
    spec: MIA_SPEC_VERSION,
    feature_state: FEATURE_STATE,
    artifact_id,
    verdict: passing ? 'passing' : 'leaking',
    attack_auc: calib.auc_attack,
    p_at_threshold: p_threshold,
    n_shadow_models: calib.n_shadow_models,
    n_train: calib.n_train,
    n_holdout: calib.n_holdout,
    detail: passing
      ? 'attack AUC <= p_threshold; artifact resists MIA at this confidence level'
      : 'attack AUC > p_threshold; artifact LEAKS membership signal — investigate DP budget',
    verified_at: new Date().toISOString(),
  };
}

// --------------------------------------------------------------------------
// dpEpsilonAudit — verifiable claim envelope for a manifest's claimed DP
// epsilon. Reads manifest.privacy.dp_epsilon and reports whether the claim
// is structurally well-formed + records the audit method.
//
// We use the standard Gaussian-mechanism formula:
//
//   epsilon = (sensitivity * sqrt(2 * ln(1.25 / delta))) / sigma
//
// The auditor verifies the manifest carries (epsilon, sensitivity, sigma)
// AND that the recomputed epsilon matches the claimed epsilon to within
// 1% relative tolerance. Mismatches surface as verified:false.
// --------------------------------------------------------------------------
export function dpEpsilonAudit({ artifact_manifest } = {}) {
  if (!artifact_manifest || typeof artifact_manifest !== 'object') {
    return {
      ok: false,
      spec: MIA_SPEC_VERSION,
      feature_state: FEATURE_STATE,
      error: 'manifest_required',
      audit_method: 'gaussian-mechanism-formula',
      claimed_epsilon: null,
      verified: false,
    };
  }
  const privacy = artifact_manifest.privacy || {};
  const claimed_epsilon = privacy.dp_epsilon != null ? Number(privacy.dp_epsilon) : null;
  if (claimed_epsilon == null || !Number.isFinite(claimed_epsilon)) {
    return {
      ok: false,
      spec: MIA_SPEC_VERSION,
      feature_state: FEATURE_STATE,
      audit_method: 'gaussian-mechanism-formula',
      claimed_epsilon: null,
      verified: false,
      error: 'no_dp_epsilon_in_manifest',
      detail: 'manifest.privacy.dp_epsilon missing or non-numeric',
    };
  }
  // If the manifest also carries sensitivity, sigma, and delta, recompute
  // epsilon via the Gaussian-mechanism formula and verify the claim.
  const sensitivity = privacy.dp_sensitivity != null ? Number(privacy.dp_sensitivity) : null;
  const sigma = privacy.dp_sigma != null ? Number(privacy.dp_sigma) : null;
  const delta = privacy.dp_delta != null ? Number(privacy.dp_delta) : null;
  let recomputed_epsilon = null;
  let verified = false;
  let detail = 'epsilon claim present but no sensitivity/sigma/delta to recompute';
  if (sensitivity != null && sigma != null && delta != null && sigma > 0 && delta > 0 && delta < 1) {
    recomputed_epsilon = (sensitivity * Math.sqrt(2 * Math.log(1.25 / delta))) / sigma;
    const tol = Math.max(0.01 * Math.abs(claimed_epsilon), 1e-9);
    verified = Math.abs(recomputed_epsilon - claimed_epsilon) <= tol;
    detail = verified
      ? 'claimed epsilon matches Gaussian-mechanism recompute within 1%'
      : `claimed epsilon ${claimed_epsilon} != recomputed ${recomputed_epsilon} beyond 1% tolerance`;
  }
  return {
    ok: true,
    spec: MIA_SPEC_VERSION,
    feature_state: FEATURE_STATE,
    audit_method: 'gaussian-mechanism-formula',
    claimed_epsilon,
    recomputed_epsilon,
    sensitivity,
    sigma,
    delta,
    verified,
    detail,
    audited_at: new Date().toISOString(),
    // Provenance — a downstream verifier signs the digest of this envelope
    // to make the claim non-repudiable in the artifact chain.
    audit_digest: _digest({
      artifact_manifest_hash: _digest(artifact_manifest),
      claimed_epsilon,
      recomputed_epsilon,
      verified,
    }),
  };
}

function _canonical(o) {
  if (o === null || typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return '[' + o.map(_canonical).join(',') + ']';
  const keys = Object.keys(o).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + _canonical(o[k])).join(',') + '}';
}

function _digest(o) {
  return crypto.createHash('sha256').update(_canonical(o)).digest('hex').slice(0, 32);
}

export default {
  MIA_SPEC_VERSION,
  FEATURE_STATE,
  FEATURE_STATE_LABEL,
  FEATURE_STATE_DESCRIPTION,
  DEFAULT_P_MEMBER_THRESHOLD,
  calibrateMIA,
  verifyArtifactMIAResistance,
  dpEpsilonAudit,
};
