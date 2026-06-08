// W761 - Model Poisoning Anomaly Orchestrator.
//
// W761 ships an ADDITIVE LAYER on top of three existing primitives:
//   - W808 statistical capture anomaly detector (src/capture-anomaly.js)
//   - W750-followup heuristic copyright detector (src/copyright-detector.js)
//   - W761-3 teacher-response HMAC binding   (src/teacher-response-hmac.js)
//
// Each primitive answers a different question:
//   - W808: "Is this capture statistically far from the namespace baseline?"
//   - W750: "Does this capture look like it contains copyrighted content?"
//   - W761-3: "Was this capture row's response actually produced by the
//             configured teacher (not MITM / not cache poisoning)?"
//
// This module combines all three into a single risk verdict that downstream
// quarantine + UI surfaces can act on.
//
// W761 INVARIANTS:
//   - HMAC verification failure ALWAYS escalates to rotate_teacher_key.
//     We NEVER return 'safe' when the HMAC check fails. A bound row whose
//     binding cannot be verified is by definition not from the configured
//     teacher - it is the strongest evidence of poisoning we have.
//   - Anomaly + copyright signals contribute risk levels but never override
//     an HMAC failure. The four-level ladder is monotone: any signal can
//     ONLY raise the risk level, never lower it.
//   - The orchestrator NEVER throws on a missing upstream module. If
//     capture-anomaly.js or copyright-detector.js cannot be imported, we
//     return an honest envelope tagging that signal as 'module_unavailable'
//     and treat the row as 'review' rather than blindly passing.
//
// Anti-brittleness (W604):
//   - POISONING_VERSION is `w761-vN.M`; consumers MUST match with a regex
//     `/^w761-/` NOT literal equality.
//   - POISON_RISK_LEVELS is Object.freeze()-d so downstream consumers cannot
//     mutate the ladder.

import crypto from 'node:crypto';

import {
  bindTeacherResponse,
  verifyTeacherResponse,
  attachBindingToCapture,
  verifyCaptureBinding,
  TEACHER_HMAC_VERSION,
} from './teacher-response-hmac.js';

export const POISONING_VERSION = 'w761-v1';

// Risk level ladder. Monotone - higher index strictly dominates lower
// indices. Helpers escalate by taking the max of all detected signals.
// Frozen so a downstream tweak cannot accidentally insert / reorder levels.
export const POISON_RISK_LEVELS = Object.freeze([
  'safe',
  'review',
  'quarantine',
  'rotate_teacher_key',
]);

// Risk index lookup. _escalate uses this to take the max of two levels.
const RISK_INDEX = Object.freeze(
  POISON_RISK_LEVELS.reduce((acc, lvl, i) => { acc[lvl] = i; return acc; }, {})
);

// Sample cap on namespace risk sweep - keeps the assessNamespacePoisoningRisk
// hot path bounded even for tenants with millions of captures.
const MAX_NAMESPACE_SAMPLE = 1000;

// Default sample size for assessNamespacePoisoningRisk.
const DEFAULT_NAMESPACE_SAMPLE_N = 100;

// -----------------------------------------------------------------------------
// Risk ladder helpers.
// -----------------------------------------------------------------------------

function _escalate(current, candidate) {
  const a = RISK_INDEX[current];
  const b = RISK_INDEX[candidate];
  if (!Number.isFinite(a)) return candidate;
  if (!Number.isFinite(b)) return current;
  return a >= b ? current : candidate;
}

// -----------------------------------------------------------------------------
// Per-row risk assessment (combines all three signals).
// -----------------------------------------------------------------------------

// Lazy-import the W808 anomaly detector. Returns a result envelope, NEVER
// throws on missing module. The module is part of the same repo so this
// import should always succeed; the try/catch is defense-in-depth so the
// orchestrator can keep running even if a downstream agent ever deletes
// the file.
async function _runAnomaly(capture) {
  try {
    const mod = await import('./capture-anomaly.js');
    const tenant_id = capture.tenant_id || capture.tenant || null;
    const namespace = capture.namespace || capture.corpus_namespace || 'default';
    if (!tenant_id) {
      return { ok: false, available: true, error: 'missing_tenant_id', detail: 'capture row has no tenant_id - cannot run W808 tenant-fenced detector' };
    }
    const res = mod.detectAnomaly({ row: capture, tenant_id, namespace });
    return { ok: true, available: true, result: res };
  } catch (e) {
    return {
      ok: false,
      available: false,
      error: 'module_unavailable',
      module: 'capture-anomaly',
      detail: String(e && e.message || e),
    };
  }
}

async function _runCopyright(capture) {
  try {
    const mod = await import('./copyright-detector.js');
    const res = mod.classifyForQuarantine(capture, { threshold: 0.25 });
    return { ok: true, available: true, result: res };
  } catch (e) {
    return {
      ok: false,
      available: false,
      error: 'module_unavailable',
      module: 'copyright-detector',
      detail: String(e && e.message || e),
    };
  }
}

// HMAC signal. Returns one of:
//   { ok:true, status:'verified'       } - binding present + signature OK
//   { ok:true, status:'invalid_signature' }
//   { ok:true, status:'key_rotated'    }
//   { ok:true, status:'no_binding'     } - row has no teacher_binding
//   { ok:true, status:'no_key_configured' } - env not set; row can't be verified
function _runHmac(capture) {
  try {
    const result = verifyCaptureBinding(capture);
    if (result.valid) return { ok: true, status: 'verified', result };
    // Translate reason → status.
    if (result.reason === 'hmac_key_mismatch_post_rotation') {
      return { ok: true, status: 'key_rotated', result };
    }
    if (result.reason === 'hmac_key_not_configured') {
      return { ok: true, status: 'no_key_configured', result };
    }
    if (result.reason === 'binding_missing_fields' && (!capture.teacher_binding)) {
      return { ok: true, status: 'no_binding', result };
    }
    return { ok: true, status: 'invalid_signature', result };
  } catch (e) {
    return { ok: false, status: 'error', detail: String(e && e.message || e) };
  }
}

// assessPoisoningRisk - combines all three detectors. Returns an envelope:
//   {
//     ok: true,
//     version,
//     risk: 'safe' | 'review' | 'quarantine' | 'rotate_teacher_key',
//     signals: { anomaly, copyright, hmac },
//     recommendation: <human-readable text>,
//     evidence: [<short tag>, ...],
//   }
//
// W761 INVARIANT: HMAC verification failure ALWAYS escalates to
// 'rotate_teacher_key'. NEVER returns 'safe' if HMAC is invalid.
export async function assessPoisoningRisk(capture) {
  if (!capture || typeof capture !== 'object') {
    return {
      ok: false,
      error: 'missing_capture',
      hint: 'pass a capture row object as the first arg',
      version: POISONING_VERSION,
    };
  }

  const [anomalyEnv, copyrightEnv] = await Promise.all([
    _runAnomaly(capture),
    _runCopyright(capture),
  ]);
  const hmacEnv = _runHmac(capture);

  let risk = 'safe';
  const evidence = [];

  // ----- HMAC signal first (W761 INVARIANT - escalates hardest) -----
  if (hmacEnv.status === 'invalid_signature') {
    risk = _escalate(risk, 'rotate_teacher_key');
    evidence.push('hmac:invalid_signature');
  } else if (hmacEnv.status === 'key_rotated') {
    // A binding signed under a previous key cannot be re-derived. This is
    // not necessarily poisoning - but it IS the "we cannot verify" state,
    // which under our threat model is equivalent to "treat as potentially
    // poisoned" until the row is re-bound under the active key.
    risk = _escalate(risk, 'rotate_teacher_key');
    evidence.push('hmac:key_rotated');
  } else if (hmacEnv.status === 'no_binding') {
    // Honest signal - most legacy rows have no binding. Surface as review
    // (the analyst should know which rows are unbound) but not block.
    risk = _escalate(risk, 'review');
    evidence.push('hmac:no_binding');
  } else if (hmacEnv.status === 'no_key_configured') {
    // The verifier could not run because the env is unset. We surface this
    // distinctly from invalid_signature so the operator gets the right hint.
    evidence.push('hmac:no_key_configured');
  } else if (hmacEnv.status === 'verified') {
    evidence.push('hmac:verified');
  } else if (hmacEnv.status === 'error') {
    risk = _escalate(risk, 'review');
    evidence.push('hmac:error');
  }

  // ----- W808 anomaly signal -----
  let anomalyFlagged = false;
  if (anomalyEnv.ok && anomalyEnv.result && anomalyEnv.result.ok === true) {
    anomalyFlagged = anomalyEnv.result.anomaly_flagged === true;
    if (anomalyFlagged) {
      const axes = Array.isArray(anomalyEnv.result.flagged_axes)
        ? anomalyEnv.result.flagged_axes.map((a) => a.axis).join(',')
        : 'unknown';
      // Multiple flagged axes → quarantine. Single axis → review.
      const count = Array.isArray(anomalyEnv.result.flagged_axes) ? anomalyEnv.result.flagged_axes.length : 0;
      if (count >= 2) {
        risk = _escalate(risk, 'quarantine');
      } else {
        risk = _escalate(risk, 'review');
      }
      evidence.push('anomaly:flagged[' + axes + ']');
    }
  } else if (anomalyEnv.available === false) {
    risk = _escalate(risk, 'review');
    evidence.push('anomaly:module_unavailable');
  }
  // anomalyEnv.ok=false with available=true (e.g. no_baseline_captures or
  // missing_tenant_id) is NOT escalated - it just means there is not enough
  // information to flag. The orchestrator records it for the audit trail.

  // ----- W750 copyright signal -----
  let copyrightHit = false;
  if (copyrightEnv.ok && copyrightEnv.result) {
    copyrightHit = copyrightEnv.result.should_quarantine === true;
    if (copyrightHit) {
      risk = _escalate(risk, 'quarantine');
      evidence.push('copyright:' + (copyrightEnv.result.reason || 'hit'));
    }
  } else if (copyrightEnv.available === false) {
    risk = _escalate(risk, 'review');
    evidence.push('copyright:module_unavailable');
  }

  // Recommendation text - maps the final risk level to an action sentence.
  const recommendation = _recommendation(risk, {
    anomaly_flagged: anomalyFlagged,
    copyright_hit: copyrightHit,
    hmac_status: hmacEnv.status,
  });

  return {
    ok: true,
    version: POISONING_VERSION,
    risk,
    signals: {
      anomaly: anomalyEnv.ok && anomalyEnv.result
        ? { flagged: anomalyFlagged, detail: anomalyEnv.result }
        : { flagged: false, error: anomalyEnv.error || null, available: anomalyEnv.available !== false },
      copyright: copyrightEnv.ok && copyrightEnv.result
        ? { hit: copyrightHit, detail: copyrightEnv.result }
        : { hit: false, error: copyrightEnv.error || null, available: copyrightEnv.available !== false },
      hmac: { status: hmacEnv.status, detail: hmacEnv.result || null },
    },
    recommendation,
    evidence,
  };
}

function _recommendation(risk, { anomaly_flagged, copyright_hit, hmac_status }) {
  if (risk === 'rotate_teacher_key') {
    if (hmac_status === 'invalid_signature') {
      return 'Rotate KOLM_TEACHER_HMAC_KEY immediately. The capture row carries an invalid HMAC - its response body was mutated post-binding or was injected from a non-teacher source.';
    }
    if (hmac_status === 'key_rotated') {
      return 'The active HMAC key does not match the key this row was bound under. If the key rotation was intentional, this row pre-dates the rotation. If it was not intentional, treat as a potential key compromise.';
    }
    return 'Rotate KOLM_TEACHER_HMAC_KEY and re-verify all captures from this window.';
  }
  if (risk === 'quarantine') {
    const reasons = [];
    if (anomaly_flagged) reasons.push('statistical anomaly');
    if (copyright_hit) reasons.push('copyright heuristic hit');
    return 'Quarantine this capture (' + reasons.join(' + ') + '). Audit-trailed, reversible - release after analyst review.';
  }
  if (risk === 'review') {
    return 'Surface this capture for analyst review. No single signal is conclusive but the combined evidence warrants a look before promoting into the distill corpus.';
  }
  return 'No poisoning signal detected. Capture is safe to promote into the distill corpus.';
}

// -----------------------------------------------------------------------------
// Namespace-wide poisoning sweep.
// -----------------------------------------------------------------------------

// Lazy-import the event-store. Returns the listEvents function or null.
async function _loadEventStore() {
  try {
    return await import('./event-store.js');
  } catch (_) {
    return null;
  }
}

// assessNamespacePoisoningRisk - runs assessPoisoningRisk on the N most-recent
// captures in (tenant_id, namespace). Returns aggregate counts + top
// evidence so the operator can see the breakdown without iterating every row.
export async function assessNamespacePoisoningRisk({ tenant_id, namespace, sample_n = DEFAULT_NAMESPACE_SAMPLE_N } = {}) {
  if (!tenant_id) {
    return {
      ok: false,
      error: 'missing_tenant_id',
      hint: 'assessNamespacePoisoningRisk requires tenant_id for the W411 tenant fence',
      version: POISONING_VERSION,
    };
  }
  const ns = namespace || 'default';
  const cap = Math.max(1, Math.min(MAX_NAMESPACE_SAMPLE, Math.trunc(Number(sample_n) || DEFAULT_NAMESPACE_SAMPLE_N)));

  const es = await _loadEventStore();
  if (!es || typeof es.listEvents !== 'function') {
    return {
      ok: false,
      error: 'event_store_unavailable',
      hint: 'src/event-store.js could not be imported - orchestrator cannot sweep namespace risk',
      version: POISONING_VERSION,
    };
  }
  let rows;
  try {
    rows = await es.listEvents({ tenant_id, namespace: ns, limit: cap, order: 'desc' });
  } catch (e) {
    return {
      ok: false,
      error: 'event_store_read_failed',
      detail: String(e && e.message || e),
      version: POISONING_VERSION,
    };
  }
  // DEFENSE-IN-DEPTH tenant fence (W411). listEvents already filters by
  // tenant_id but we re-check inline so a stale row that slipped past the
  // index cannot pollute the cross-tenant risk verdict.
  rows = (rows || []).filter((r) => r && (r.tenant_id === tenant_id || r.tenant === tenant_id));

  if (!rows.length) {
    return {
      ok: false,
      error: 'empty_namespace',
      hint: `no captures in (tenant=${tenant_id}, namespace=${ns}) - poisoning sweep needs at least one row to assess`,
      namespace: ns,
      sample_n: cap,
      version: POISONING_VERSION,
    };
  }

  const by_risk = { safe: 0, review: 0, quarantine: 0, rotate_teacher_key: 0 };
  const top_evidence = [];
  let highest = 'safe';
  let assessed = 0;
  for (const row of rows) {
    const verdict = await assessPoisoningRisk(row);
    if (!verdict || verdict.ok !== true) continue;
    by_risk[verdict.risk] = (by_risk[verdict.risk] || 0) + 1;
    highest = _escalate(highest, verdict.risk);
    assessed += 1;
    if (verdict.risk !== 'safe' && top_evidence.length < 10) {
      top_evidence.push({
        capture_id: row.event_id || row.cid || row.id || null,
        risk: verdict.risk,
        evidence: verdict.evidence,
      });
    }
  }

  const hint = _namespaceHint(highest, by_risk);

  return {
    ok: true,
    version: POISONING_VERSION,
    tenant_id,
    namespace: ns,
    sample_n: cap,
    assessed,
    highest_risk: highest,
    by_risk,
    top_evidence,
    hint,
  };
}

function _namespaceHint(highest, by_risk) {
  if (highest === 'rotate_teacher_key') {
    return `${by_risk.rotate_teacher_key || 0} capture(s) failed HMAC verification - rotate KOLM_TEACHER_HMAC_KEY and investigate the source of the unsigned/mismatched rows.`;
  }
  if (highest === 'quarantine') {
    return `${by_risk.quarantine || 0} capture(s) flagged for quarantine. Use kolm poison quarantine --capture-id <id> --reason <r> to act.`;
  }
  if (highest === 'review') {
    return `${by_risk.review || 0} capture(s) need analyst review before promotion.`;
  }
  return 'All sampled captures are safe to promote into the distill corpus.';
}

// -----------------------------------------------------------------------------
// Quarantine + release (W750 audit-trailed pattern).
// -----------------------------------------------------------------------------

async function _loadAudit() {
  try { return await import('./audit.js'); } catch (_) { return null; }
}

async function _loadStore() {
  try { return await import('./store.js'); } catch (_) { return null; }
}

// quarantineCapture - audit-trailed, idempotent. The orchestrator records a
// poisoning-quarantine event in the per-tenant audit chain. Reads the same
// chain the kolm audit verify command walks, so the action is verifiable.
//
// Idempotency: if an audit row already exists for the same (tenant_id,
// capture_id, reason) tuple we re-use the existing row's id instead of
// writing a duplicate. The W411 dedupe pattern.
export async function quarantineCapture({ tenant_id, capture_id, reason, evidence } = {}) {
  if (!tenant_id) {
    return { ok: false, error: 'missing_tenant_id', version: POISONING_VERSION };
  }
  if (!capture_id) {
    return { ok: false, error: 'missing_capture_id', version: POISONING_VERSION };
  }
  if (!reason || typeof reason !== 'string') {
    return { ok: false, error: 'missing_reason', hint: 'pass {reason:"<short tag>"}', version: POISONING_VERSION };
  }

  const auditMod = await _loadAudit();
  if (!auditMod || typeof auditMod.tryAppendAudit !== 'function') {
    return {
      ok: false,
      error: 'audit_unavailable',
      hint: 'src/audit.js could not be imported',
      version: POISONING_VERSION,
    };
  }

  const op = 'poisoning.capture_quarantined';
  const payload = {
    capture_id,
    reason,
    evidence: Array.isArray(evidence) ? evidence : (evidence ? [String(evidence)] : []),
    version: POISONING_VERSION,
  };

  // Idempotency: scan existing audit rows for this tenant + same capture_id
  // + same reason. If found we return the existing event without re-appending.
  // We use `all('audit_events')` + manual tenant_id filter because
  // findByTenant() keys on a `tenant` field, but audit.js writes rows with a
  // `tenant_id` field - so findByTenant would always return []. The manual
  // filter below preserves the W411 tenant fence (defense-in-depth) and
  // matches the actual on-disk row shape.
  const storeMod = await _loadStore();
  if (storeMod && typeof storeMod.all === 'function') {
    try {
      const all = storeMod.all('audit_events') || [];
      for (const r of all) {
        if (!r) continue;
        if (r.op !== op) continue;
        // Tenant fence (defense-in-depth W411).
        if (r.tenant_id !== tenant_id) continue;
        const p = r.payload || {};
        if (p.capture_id === capture_id && p.reason === reason) {
          return {
            ok: true,
            already_quarantined: true,
            capture_id,
            reason,
            quarantined_at: r.at,
            audit_event_id: r.id,
            version: POISONING_VERSION,
          };
        }
      }
    } catch (_) { /* fall through to append */ }
  }

  const row = auditMod.tryAppendAudit({
    tenant_id,
    op,
    payload,
  });
  if (!row) {
    return {
      ok: false,
      error: 'audit_append_failed',
      hint: 'tryAppendAudit returned null - likely no receipt secret configured',
      version: POISONING_VERSION,
    };
  }
  return {
    ok: true,
    capture_id,
    reason,
    quarantined_at: row.at,
    audit_event_id: row.id,
    version: POISONING_VERSION,
  };
}

// releaseFromQuarantine - audit-trailed release. Owner/admin gating is
// enforced at the route layer; this function just records the release in
// the audit chain. Returns the new audit row.
export async function releaseFromQuarantine({ tenant_id, capture_id, release_reason, released_by } = {}) {
  if (!tenant_id) {
    return { ok: false, error: 'missing_tenant_id', version: POISONING_VERSION };
  }
  if (!capture_id) {
    return { ok: false, error: 'missing_capture_id', version: POISONING_VERSION };
  }
  const auditMod = await _loadAudit();
  if (!auditMod || typeof auditMod.tryAppendAudit !== 'function') {
    return {
      ok: false,
      error: 'audit_unavailable',
      version: POISONING_VERSION,
    };
  }
  const row = auditMod.tryAppendAudit({
    tenant_id,
    op: 'poisoning.capture_released',
    actor: released_by || null,
    payload: {
      capture_id,
      release_reason: release_reason || null,
      released_by: released_by || null,
      version: POISONING_VERSION,
    },
  });
  if (!row) {
    return { ok: false, error: 'audit_append_failed', version: POISONING_VERSION };
  }
  return {
    ok: true,
    capture_id,
    released_at: row.at,
    audit_event_id: row.id,
    version: POISONING_VERSION,
  };
}

export default {
  POISONING_VERSION,
  POISON_RISK_LEVELS,
  assessPoisoningRisk,
  assessNamespacePoisoningRisk,
  quarantineCapture,
  releaseFromQuarantine,
};
