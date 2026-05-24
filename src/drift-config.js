// W813 - Per-namespace drift configuration (threshold + auto_remediate).
//
// W813-2 spec: per-namespace override of kl_threshold + fallback_rate_lift.
// W813-5 spec: auto_remediate_drift opt-in flag. When true (AND the operator
// hits the auto-remediate endpoint with dry_run:false) the W720 orchestrator
// is invoked to re-distill. Default is OFF — auto-trigger is a P0 trust
// violation when implicit.
//
// Atomic guarantees pinned by tests/wave813-drift-detection.test.js:
//
//   - DRIFT_CONFIG_VERSION = 'w813-v1'
//   - validateConfig strict bounds:
//       kl_threshold in (0, 10]
//       fallback_rate_lift in (0, 1]
//       auto_remediate_drift boolean
//     Honest envelope on failure - never silent-coerce.
//   - setNamespaceConfig requires confirm:true (else returns confirm_required).
//   - getNamespaceConfig returns DEFAULTS when no override is persisted:
//       { kl_threshold: 0.10, fallback_rate_lift: 0.20, auto_remediate_drift: false }
//     Fail-safe: auto_remediate_drift NEVER auto-enables.
//   - getNamespaceConfig is tenant-fenced via storeMod.all + per-row filter
//     (W411 defense-in-depth law — same trap as W761/W770 where findByTenant
//     would silently miss rows due to field-key mismatch).
//
// HONESTY INVARIANTS (NEVER violate):
//   - getNamespaceConfig defaults to auto_remediate_drift:false. Period.
//   - setNamespaceConfig refuses without confirm:true.
//   - validateConfig refuses out-of-range values with snake_case error codes.

import { DEFAULT_KL_THRESHOLD, DEFAULT_FALLBACK_RATE_LIFT } from './drift-detect.js';

export const DRIFT_CONFIG_VERSION = 'w813-v1';

// Provider tag for the event-store row carrying a drift config override.
// Distinct from kolm_drift_alert so the two tables are independently queryable.
export const DRIFT_CONFIG_PROVIDER = 'kolm_drift_config';

// Fail-safe defaults. auto_remediate_drift is FALSE by default per W813-5
// invariant — implicit auto-trigger would be a P0 trust violation.
export const DRIFT_CONFIG_DEFAULTS = Object.freeze({
  kl_threshold: DEFAULT_KL_THRESHOLD,
  fallback_rate_lift: DEFAULT_FALLBACK_RATE_LIFT,
  auto_remediate_drift: false,
});

// Strict bounds.
const KL_MIN_EXCLUSIVE = 0;
const KL_MAX_INCLUSIVE = 10;
const FBL_MIN_EXCLUSIVE = 0;
const FBL_MAX_INCLUSIVE = 1;

// =============================================================================
// validateConfig({kl_threshold, fallback_rate_lift, auto_remediate_drift})
// -> {ok:true, normalized} or honest envelope.
//
// Strict — out-of-range / wrong-type values are REJECTED, not silently coerced.
// =============================================================================
export function validateConfig(input = {}) {
  const out = {};
  if (input == null || typeof input !== 'object') {
    return {
      ok: false,
      error: 'bad_input',
      hint: 'pass {kl_threshold?, fallback_rate_lift?, auto_remediate_drift?}',
      version: DRIFT_CONFIG_VERSION,
    };
  }

  if (input.kl_threshold !== undefined) {
    const v = Number(input.kl_threshold);
    if (!Number.isFinite(v)) {
      return {
        ok: false,
        error: 'kl_threshold_not_number',
        hint: 'kl_threshold must be a finite number in (0, 10]',
        version: DRIFT_CONFIG_VERSION,
      };
    }
    if (v <= KL_MIN_EXCLUSIVE || v > KL_MAX_INCLUSIVE) {
      return {
        ok: false,
        error: 'kl_threshold_out_of_range',
        hint: `kl_threshold must be in (${KL_MIN_EXCLUSIVE}, ${KL_MAX_INCLUSIVE}]; got ${v}`,
        version: DRIFT_CONFIG_VERSION,
      };
    }
    out.kl_threshold = v;
  }

  if (input.fallback_rate_lift !== undefined) {
    const v = Number(input.fallback_rate_lift);
    if (!Number.isFinite(v)) {
      return {
        ok: false,
        error: 'fallback_rate_lift_not_number',
        hint: 'fallback_rate_lift must be a finite number in (0, 1]',
        version: DRIFT_CONFIG_VERSION,
      };
    }
    if (v <= FBL_MIN_EXCLUSIVE || v > FBL_MAX_INCLUSIVE) {
      return {
        ok: false,
        error: 'fallback_rate_lift_out_of_range',
        hint: `fallback_rate_lift must be in (${FBL_MIN_EXCLUSIVE}, ${FBL_MAX_INCLUSIVE}]; got ${v}`,
        version: DRIFT_CONFIG_VERSION,
      };
    }
    out.fallback_rate_lift = v;
  }

  if (input.auto_remediate_drift !== undefined) {
    if (typeof input.auto_remediate_drift !== 'boolean') {
      return {
        ok: false,
        error: 'auto_remediate_drift_not_boolean',
        hint: 'auto_remediate_drift must be true or false (strict boolean)',
        version: DRIFT_CONFIG_VERSION,
      };
    }
    out.auto_remediate_drift = input.auto_remediate_drift;
  }

  return {
    ok: true,
    normalized: out,
    version: DRIFT_CONFIG_VERSION,
  };
}

// =============================================================================
// setNamespaceConfig({tenant_id, namespace, kl_threshold, fallback_rate_lift,
//                     auto_remediate_drift, confirm, opts}) -> persist.
//
// Requires confirm:true (else returns confirm_required honest envelope).
// Persists via eventStore.appendEvent with provider DRIFT_CONFIG_PROVIDER.
// =============================================================================
export async function setNamespaceConfig({
  tenant_id = null,
  namespace = null,
  kl_threshold,
  fallback_rate_lift,
  auto_remediate_drift,
  confirm = false,
  opts = {},
} = {}) {
  if (!tenant_id || typeof tenant_id !== 'string') {
    return {
      ok: false,
      error: 'tenant_id_required',
      version: DRIFT_CONFIG_VERSION,
    };
  }
  if (!namespace || typeof namespace !== 'string') {
    return {
      ok: false,
      error: 'namespace_required',
      version: DRIFT_CONFIG_VERSION,
    };
  }
  if (confirm !== true) {
    return {
      ok: false,
      error: 'confirm_required',
      hint: 'setNamespaceConfig persists a durable drift config override; pass confirm:true to acknowledge',
      version: DRIFT_CONFIG_VERSION,
    };
  }
  const validated = validateConfig({ kl_threshold, fallback_rate_lift, auto_remediate_drift });
  if (!validated.ok) return validated;

  // Merge with defaults so the persisted row is self-describing.
  const merged = {
    ...DRIFT_CONFIG_DEFAULTS,
    ...validated.normalized,
  };

  let eventStore = opts && opts.eventStore;
  if (!eventStore) {
    try {
      eventStore = await import('./event-store.js');
    } catch (e) {
      return {
        ok: false,
        error: 'event_store_unavailable',
        detail: String((e && e.message) || e),
        version: DRIFT_CONFIG_VERSION,
      };
    }
  }
  let ev;
  try {
    ev = await eventStore.appendEvent({
      tenant_id: String(tenant_id),
      namespace: String(namespace),
      provider: DRIFT_CONFIG_PROVIDER,
      status: 'ok',
      source_type: 'real',
      feedback: JSON.stringify({
        kind: 'drift_config_override',
        config: merged,
        set_at: new Date().toISOString(),
        version: DRIFT_CONFIG_VERSION,
      }),
    });
  } catch (e) {
    return {
      ok: false,
      error: 'append_event_failed',
      detail: String((e && e.message) || e),
      version: DRIFT_CONFIG_VERSION,
    };
  }

  return {
    ok: true,
    version: DRIFT_CONFIG_VERSION,
    tenant_id,
    namespace,
    config: merged,
    persisted_event_id: (ev && ev.event_id) || null,
    persisted_at: (ev && ev.created_at) || null,
  };
}

// =============================================================================
// getNamespaceConfig({tenant_id, namespace, opts}) - tenant-fenced read.
//
// Returns DRIFT_CONFIG_DEFAULTS when no override is present.
//
// W411 defense-in-depth: the config rows live in the event store; we list
// events for the tenant + provider then re-check per-row tenant_id before
// trusting the row. Same trap as W761/W770 — never use findByTenant on
// canonical store tables that key on `tenant_id` instead of `tenant`.
//
// opts.storeMod — DI seam for tests (storeMod.all('events') style). When
// absent we use eventStore.listEvents which itself does in-driver fencing.
// =============================================================================
export async function getNamespaceConfig({
  tenant_id = null,
  namespace = null,
  opts = {},
} = {}) {
  if (!tenant_id || typeof tenant_id !== 'string') {
    return {
      ok: false,
      error: 'tenant_id_required',
      version: DRIFT_CONFIG_VERSION,
    };
  }
  if (!namespace || typeof namespace !== 'string') {
    return {
      ok: false,
      error: 'namespace_required',
      version: DRIFT_CONFIG_VERSION,
    };
  }

  // ---------------------------------------------------------------------------
  // Path A: opts.storeMod DI seam (tests). Read ALL rows and per-row filter so
  //         a buggy field-key mismatch can never leak cross-tenant data.
  // ---------------------------------------------------------------------------
  if (opts && opts.storeMod && typeof opts.storeMod.all === 'function') {
    const rawRows = opts.storeMod.all('events') || [];
    const tenantRows = rawRows.filter((r) =>
      r && r.tenant_id === tenant_id
        && r.namespace === namespace
        && r.provider === DRIFT_CONFIG_PROVIDER
    );
    // Most-recent first by created_at if present.
    tenantRows.sort((a, b) => {
      const ta = Date.parse((a && a.created_at) || '') || 0;
      const tb = Date.parse((b && b.created_at) || '') || 0;
      return tb - ta;
    });
    for (const row of tenantRows) {
      // Belt + suspenders re-check after sort.
      if (!row || row.tenant_id !== tenant_id) continue;
      const parsed = _parseConfigRow(row);
      if (parsed) {
        return {
          ok: true,
          version: DRIFT_CONFIG_VERSION,
          tenant_id,
          namespace,
          config: { ...DRIFT_CONFIG_DEFAULTS, ...parsed },
          source: 'override',
        };
      }
    }
    return {
      ok: true,
      version: DRIFT_CONFIG_VERSION,
      tenant_id,
      namespace,
      config: { ...DRIFT_CONFIG_DEFAULTS },
      source: 'default',
    };
  }

  // ---------------------------------------------------------------------------
  // Path B: lazy-import event-store. listEvents already filters by tenant_id
  //         + provider, but we still per-row re-check defense-in-depth.
  // ---------------------------------------------------------------------------
  let eventStore = opts && opts.eventStore;
  if (!eventStore) {
    try {
      eventStore = await import('./event-store.js');
    } catch (_) {
      // Failsafe: when event-store is unavailable, return defaults rather
      // than crash. Honesty: stamp source:'default_event_store_unavailable'.
      return {
        ok: true,
        version: DRIFT_CONFIG_VERSION,
        tenant_id,
        namespace,
        config: { ...DRIFT_CONFIG_DEFAULTS },
        source: 'default_event_store_unavailable',
      };
    }
  }
  let rows = [];
  try {
    rows = await eventStore.listEvents({
      tenant_id,
      namespace,
      provider: DRIFT_CONFIG_PROVIDER,
      limit: 50,
      order: 'desc',
    }) || [];
  } catch (_) {
    return {
      ok: true,
      version: DRIFT_CONFIG_VERSION,
      tenant_id,
      namespace,
      config: { ...DRIFT_CONFIG_DEFAULTS },
      source: 'default_list_events_failed',
    };
  }
  for (const row of rows) {
    if (!row || row.tenant_id !== tenant_id) continue; // defense-in-depth
    if (row.namespace !== namespace) continue;
    const parsed = _parseConfigRow(row);
    if (parsed) {
      return {
        ok: true,
        version: DRIFT_CONFIG_VERSION,
        tenant_id,
        namespace,
        config: { ...DRIFT_CONFIG_DEFAULTS, ...parsed },
        source: 'override',
      };
    }
  }
  return {
    ok: true,
    version: DRIFT_CONFIG_VERSION,
    tenant_id,
    namespace,
    config: { ...DRIFT_CONFIG_DEFAULTS },
    source: 'default',
  };
}

function _parseConfigRow(row) {
  if (!row) return null;
  if (!row.feedback) return null;
  let blob;
  try { blob = JSON.parse(row.feedback); } catch { return null; }
  if (!blob || blob.kind !== 'drift_config_override') return null;
  const cfg = blob.config || {};
  const out = {};
  if (typeof cfg.kl_threshold === 'number') out.kl_threshold = cfg.kl_threshold;
  if (typeof cfg.fallback_rate_lift === 'number') out.fallback_rate_lift = cfg.fallback_rate_lift;
  if (typeof cfg.auto_remediate_drift === 'boolean') out.auto_remediate_drift = cfg.auto_remediate_drift;
  return out;
}

export default {
  DRIFT_CONFIG_VERSION,
  DRIFT_CONFIG_PROVIDER,
  DRIFT_CONFIG_DEFAULTS,
  validateConfig,
  setNamespaceConfig,
  getNamespaceConfig,
};
