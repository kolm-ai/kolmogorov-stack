// W834-3 - Human-in-the-loop config (confidence-threshold gate).
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md):
//   [W834-3] Human-in-the-loop config: per-namespace
//            `mandatory_human_review_threshold`.
//
// Why a separate module from W766's humanInLoopConfig:
//   * W766 humanInLoopConfig persists the threshold in NATS (entropy units)
//     because it shares semantics with W709's confidence-routing gate
//     (which also uses nats).
//   * W834-3 persists the threshold as a CONFIDENCE PROBABILITY in [0.0, 1.0]
//     because the regulator-facing surface speaks "confidence below X
//     triggers human review", NOT "entropy above Y". A compliance team
//     writes policies in probability units, not nats - forcing them to
//     translate is a footgun.
//   * Both subsystems can coexist; downstream callers pick the unit
//     vocabulary that matches their audience.
//
// HONESTY CONTRACT (matches W766, W782 approval-queue):
//   * threshold validated ∈ [0.0, 1.0] (probability). Out-of-range →
//     honest {ok:false, error:'invalid_threshold'} envelope. NEVER persists.
//   * Per-row tenant fence (W411 defense-in-depth) - every event-store read
//     re-checks row.tenant_id even after the query filter.
//   * shouldEscalate(opts) is a pure function - no I/O, no side effects.
//     Returns BOOL. NEVER throws.
//   * When the manifest field is missing, shouldEscalate returns FALSE
//     (no escalation when no threshold configured) - but the caller must
//     pass threshold explicitly. We do NOT auto-default to 0.5; an unset
//     threshold is treated as "no HIL configured".
//
// Wiring to approval queue: when shouldEscalate returns true the caller
// should push to src/distill-approval-queue.js (W782) via requestApproval
// to actually surface the row to a human. This module owns the THRESHOLD;
// the approval queue owns the REVIEW WORKFLOW.
//
// W604 anti-brittleness: REG_HIL_VERSION = 'w834-v1'. Tests lock /^w834-/
// regex plus the literal pin.

export const REG_HIL_VERSION = 'w834-v1';

// Bounds. CONFIDENCE PROBABILITY in [0, 1]. 0.0 = never escalate;
// 1.0 = always escalate.
const THRESHOLD_MIN = 0.0;
const THRESHOLD_MAX = 1.0;

// Event-store provider tag - distinct from W766's
// 'kolm_human_review_threshold' (which is in nats) so the two subsystems
// don't shadow each other.
const PROVIDER_TAG = 'kolm_reg_hil_confidence_threshold';

function _now() {
  return new Date().toISOString();
}

// =============================================================================
// PUBLIC: setMandatoryHumanReviewThreshold({tenant, namespace, threshold, eventStore})
//
// Persist the per-namespace confidence threshold. Confidence below threshold
// triggers human review.
//
// Inputs:
//   tenant - REQUIRED tenant_id (route layer sources from req.tenant_record.id)
//   namespace - REQUIRED string
//   threshold - REQUIRED number in [0.0, 1.0]
//   eventStore - DI seam for tests
//
// Returns:
//   { ok:true, tenant, namespace, threshold, persisted_event_id, persisted_at, version }
//   or { ok:false, error, hint, version } on bad input.
// =============================================================================
export async function setMandatoryHumanReviewThreshold(opts = {}) {
  const o = opts || {};
  // Accept BOTH tenant + tenant_id for callsite forgiveness.
  const tenant = o.tenant || o.tenant_id || null;
  const namespace = typeof o.namespace === 'string' ? o.namespace : null;
  const threshold = o.threshold;

  if (!tenant) {
    return {
      ok: false,
      error: 'tenant_required',
      hint: 'pass {tenant: <tenant_id>} - required so the threshold is tenant-fenced',
      version: REG_HIL_VERSION,
    };
  }
  if (!namespace) {
    return {
      ok: false,
      error: 'namespace_required',
      hint: 'pass {namespace: "<namespace>"} - thresholds are per-namespace',
      version: REG_HIL_VERSION,
    };
  }
  const n = Number(threshold);
  if (!Number.isFinite(n)) {
    return {
      ok: false,
      error: 'invalid_threshold',
      hint: `threshold must be a finite number in [${THRESHOLD_MIN}, ${THRESHOLD_MAX}]`,
      min: THRESHOLD_MIN,
      max: THRESHOLD_MAX,
      version: REG_HIL_VERSION,
    };
  }
  if (n < THRESHOLD_MIN || n > THRESHOLD_MAX) {
    return {
      ok: false,
      error: 'invalid_threshold',
      hint: `threshold=${n} out of range [${THRESHOLD_MIN}, ${THRESHOLD_MAX}]; reject loudly per honesty contract`,
      min: THRESHOLD_MIN,
      max: THRESHOLD_MAX,
      version: REG_HIL_VERSION,
    };
  }

  // DI seam - accept opts.eventStore for tests.
  let eventStore = o.eventStore;
  if (!eventStore) {
    try {
      eventStore = await import('./event-store.js');
    } catch (e) {
      return {
        ok: false,
        error: 'event_store_unavailable',
        detail: String(e && e.message || e),
        version: REG_HIL_VERSION,
      };
    }
  }

  let ev;
  try {
    ev = await eventStore.appendEvent({
      tenant_id: String(tenant),
      namespace: String(namespace),
      provider: PROVIDER_TAG,
      feedback: JSON.stringify({
        kind: 'reg_hil_threshold_set',
        threshold,
        set_at: _now(),
        source: 'setMandatoryHumanReviewThreshold',
        version: REG_HIL_VERSION,
      }),
      status: 'ok',
      source_type: 'real',
    });
  } catch (e) {
    return {
      ok: false,
      error: 'append_event_failed',
      detail: String(e && e.message || e),
      version: REG_HIL_VERSION,
    };
  }

  return {
    ok: true,
    tenant,
    namespace,
    threshold: n,
    persisted_event_id: ev && ev.event_id ? ev.event_id : null,
    persisted_at: ev && ev.created_at ? ev.created_at : _now(),
    version: REG_HIL_VERSION,
  };
}

// =============================================================================
// PUBLIC: getHilConfig({tenant, namespace, eventStore})
//
// Read back the most recent per-namespace HIL threshold for a tenant.
//
// Returns:
//   { ok:true, tenant, namespace, threshold, configured:true|false, version }
//
// configured:false means no threshold has ever been set for this
// (tenant, namespace) pair - caller must NOT treat threshold:null as 0.0
// (that would mean "never escalate"). Default behavior when unconfigured:
// shouldEscalate returns false (no escalation), but the caller MAY want to
// fall back to a tenant-wide default; that's policy-layer business.
// =============================================================================
export async function getHilConfig(opts = {}) {
  const o = opts || {};
  const tenant = o.tenant || o.tenant_id || null;
  const namespace = typeof o.namespace === 'string' ? o.namespace : null;

  if (!tenant || !namespace) {
    return {
      ok: false,
      error: !tenant ? 'tenant_required' : 'namespace_required',
      hint: 'pass {tenant, namespace}',
      version: REG_HIL_VERSION,
    };
  }

  let eventStore = o.eventStore;
  if (!eventStore) {
    try {
      eventStore = await import('./event-store.js');
    } catch (e) {
      return {
        ok: false,
        error: 'event_store_unavailable',
        detail: String(e && e.message || e),
        version: REG_HIL_VERSION,
      };
    }
  }

  let rows = [];
  try {
    rows = await eventStore.listEvents({
      tenant_id: String(tenant),
      namespace: String(namespace),
      provider: PROVIDER_TAG,
      limit: 50,
      order: 'desc',
    });
  } catch (e) {
    return {
      ok: false,
      error: 'event_store_query_failed',
      detail: String(e && e.message || e),
      version: REG_HIL_VERSION,
    };
  }
  if (!Array.isArray(rows)) rows = [];

  // W411 defense-in-depth - per-row tenant + namespace + provider re-check.
  for (const row of rows) {
    if (!row || row.tenant_id !== String(tenant)) continue;
    if (row.namespace !== String(namespace)) continue;
    if (row.provider !== PROVIDER_TAG) continue;
    if (typeof row.feedback !== 'string') continue;
    try {
      const blob = JSON.parse(row.feedback);
      if (blob && blob.kind === 'reg_hil_threshold_set') {
        const n = Number(blob.threshold);
        if (Number.isFinite(n) && n >= THRESHOLD_MIN && n <= THRESHOLD_MAX) {
          return {
            ok: true,
            tenant,
            namespace,
            threshold: n,
            configured: true,
            set_at: blob.set_at || row.created_at || null,
            version: REG_HIL_VERSION,
          };
        }
      }
    } catch (_) { continue; }
  }

  return {
    ok: true,
    tenant,
    namespace,
    threshold: null,
    configured: false,
    version: REG_HIL_VERSION,
  };
}

// =============================================================================
// PUBLIC: shouldEscalate({confidence_score, threshold})
//
// Pure function. NO I/O. Returns BOOL.
//
// Returns true iff confidence_score < threshold (escalate to human review).
// Returns false when either input is missing/invalid OR confidence >= threshold.
//
// HONESTY: a missing threshold returns FALSE (no escalation). The caller is
// responsible for deciding whether to refuse the request OR fall through to
// a tenant-wide default.
// =============================================================================
export function shouldEscalate(opts = {}) {
  const o = opts || {};
  const c = Number(o.confidence_score);
  const t = Number(o.threshold);
  if (!Number.isFinite(c)) return false;
  if (!Number.isFinite(t)) return false;
  if (t < THRESHOLD_MIN || t > THRESHOLD_MAX) return false;
  if (c < THRESHOLD_MIN || c > THRESHOLD_MAX) return false;
  return c < t;
}

export default {
  REG_HIL_VERSION,
  setMandatoryHumanReviewThreshold,
  getHilConfig,
  shouldEscalate,
};
