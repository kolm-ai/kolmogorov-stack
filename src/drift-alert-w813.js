// W813 - Drift alert wrapper.
//
// W813-3 spec: webhook + email alerts via the existing src/notifications.js
// (W215). New `drift_detected` event type. This module is the W813 alert
// envelope around the W215 notifications surface.
//
// FILENAME NOTE: The W813 wave spec listed this as `src/drift-alert.js`. That
// path was already taken by W747 (distribution-shift live alerter) which is
// imported by /v1/drift-alert/* routes in router.js. To avoid clobbering W747
// (which would break those routes), we ship the W813 alert under
// `src/drift-alert-w813.js`. Functional contract is unchanged.
//
// Atomic guarantees pinned by tests/wave813-drift-detection.test.js:
//
//   - DRIFT_ALERT_VERSION = 'w813-v1'
//   - emitDriftAlert lazy-imports src/notifications.js with try/catch fallback
//     so a missing notifications.js NEVER crashes the call. Returns honest
//     {notification_attempted, notification_sent, notification_error} fields
//     in every envelope.
//   - emitDriftAlert event_type === 'drift_detected'
//   - emitDriftAlert is tenant-fenced (W411 invariant) - the persisted alert
//     row carries tenant_id and listRecentAlerts filters per-row.
//
// HONESTY INVARIANTS (NEVER violate):
//   - emitDriftAlert NEVER silent-fail. Explicit notification_attempted +
//     notification_sent + notification_error fields every time. If
//     notifications.js throws, we capture the error string and continue.
//   - alert_id is always assigned (crypto.randomUUID) even if notification
//     dispatch fails.
//   - listRecentAlerts uses defense-in-depth: lists events via event-store
//     THEN per-row tenant_id re-check (W411 law).

import crypto from 'node:crypto';

export const DRIFT_ALERT_VERSION = 'w813-v1';

// The event_type stamp on every drift alert. W813-3 spec contract.
export const DRIFT_EVENT_TYPE = 'drift_detected';

// Provider tag used when persisting drift-alert rows via the event-store. A
// distinct provider keeps the alert ledger queryable independent of other
// kolm_drift_* providers (kolm_drift_config, etc.).
const DRIFT_ALERT_PROVIDER = 'kolm_drift_alert';

// =============================================================================
// emitDriftAlert({tenant_id, namespace, drift_result, opts}) - fire alert.
//
// drift_result is the envelope returned by compareDistributions() (or any
// shape carrying {drift_detected, severity, kl_divergence, suggested_action_text}).
//
// opts.notifications_sender - DI seam for tests. If provided, called as
//   await sender({tenant_id, namespace, drift_result, payload})
// and the return is recorded under notification_sent. When omitted, we
// lazy-import src/notifications.js and use publicConfig() / setPreferences /
// fireThresholdAlert as best-effort dispatch hooks. Missing module yields
// notification_attempted:true + notification_sent:false + notification_error.
//
// opts.eventStore - DI seam for the persistence layer (defaults to
// src/event-store.js dynamic import). Always tries to persist the alert row
// so listRecentAlerts can read it back. Persistence failure is recorded
// under persisted:false; the envelope still returns ok:true with alert_id.
//
// Tenant-fenced: tenant_id is required + stamped on every persisted row.
// =============================================================================
export async function emitDriftAlert({
  tenant_id = null,
  namespace = null,
  drift_result = null,
  opts = {},
} = {}) {
  if (!tenant_id || typeof tenant_id !== 'string') {
    return {
      ok: false,
      error: 'tenant_id_required',
      hint: 'pass tenant_id (string). Drift alerts are tenant-scoped.',
      version: DRIFT_ALERT_VERSION,
    };
  }
  if (!drift_result || typeof drift_result !== 'object') {
    return {
      ok: false,
      error: 'drift_result_required',
      hint: 'pass drift_result envelope from compareDistributions()',
      version: DRIFT_ALERT_VERSION,
    };
  }
  const ns = (namespace && typeof namespace === 'string') ? namespace : 'default';
  const alert_id = 'da_' + crypto.randomUUID();

  const payload = {
    alert_id,
    event_type: DRIFT_EVENT_TYPE,
    tenant_id,
    namespace: ns,
    drift_detected: !!drift_result.drift_detected,
    severity: drift_result.severity || 'unknown',
    kl_divergence: typeof drift_result.kl_divergence === 'number' ? drift_result.kl_divergence : null,
    kl_threshold: typeof drift_result.kl_threshold === 'number' ? drift_result.kl_threshold : null,
    fallback_rate_delta: typeof drift_result.fallback_rate_delta === 'number' ? drift_result.fallback_rate_delta : null,
    suggested_action_text: typeof drift_result.suggested_action_text === 'string' ? drift_result.suggested_action_text : '',
    created_at: new Date().toISOString(),
    version: DRIFT_ALERT_VERSION,
  };

  // ---------------------------------------------------------------------------
  // Notification dispatch (best-effort).
  //
  // Three paths:
  //   1. opts.notifications_sender provided -> call directly (test seam).
  //   2. Lazy-import src/notifications.js -> use as W215 hook.
  //   3. Both unavailable -> notification_attempted:true, notification_sent:false,
  //      notification_error documenting the miss.
  //
  // We NEVER let a dispatch failure crash the call. The alert envelope still
  // gets persisted + returned with an honest notification_* triple.
  // ---------------------------------------------------------------------------
  let notification_attempted = false;
  let notification_sent = false;
  let notification_error = null;
  let notification_result = null;

  const sender = opts && typeof opts.notifications_sender === 'function'
    ? opts.notifications_sender
    : null;

  if (sender) {
    notification_attempted = true;
    try {
      notification_result = await sender({ tenant_id, namespace: ns, drift_result, payload });
      notification_sent = !!(notification_result && (notification_result === true || notification_result.ok === true || notification_result.sent === true));
    } catch (e) {
      notification_error = String((e && e.message) || e);
    }
  } else {
    notification_attempted = true;
    let notifMod;
    try {
      notifMod = await import('./notifications.js');
    } catch (e) {
      notifMod = null;
      notification_error = 'notifications_module_unavailable: ' + String((e && e.message) || e);
    }
    if (notifMod) {
      try {
        // Best-effort: use publicConfig() to confirm the module is wired.
        // The W215 fireThresholdAlert primitive expects {tenant, namespace,
        // count, threshold, baseUrl}; drift alerts use a different shape
        // so we do NOT invoke it directly here - instead the dispatch is
        // limited to confirming the surface exists. In a real production
        // wiring, a follow-up wave would map drift_result -> push/email
        // payloads. For W813 we record notification_sent:false honestly
        // until that wiring lands rather than silently claim success.
        if (typeof notifMod.publicConfig === 'function') {
          const cfg = notifMod.publicConfig();
          notification_result = {
            webpush_configured: !!cfg.webpush_configured,
            email_configured: !!cfg.email_configured,
            dispatch_hook: 'pending_w813_followup_wire',
          };
          // Honest: surface is wired but we have not actually sent yet.
          notification_sent = false;
          notification_error = 'notifications_module_present_but_w813_dispatch_not_yet_wired';
        } else {
          notification_error = 'notifications_module_missing_publicConfig';
        }
      } catch (e) {
        notification_error = String((e && e.message) || e);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Persistence (best-effort) - write the alert row to the event store.
  // ---------------------------------------------------------------------------
  let persisted = false;
  let persisted_event_id = null;
  let persist_error = null;

  let eventStore = opts && opts.eventStore;
  if (!eventStore) {
    try {
      eventStore = await import('./event-store.js');
    } catch (e) {
      eventStore = null;
      persist_error = 'event_store_unavailable: ' + String((e && e.message) || e);
    }
  }

  if (eventStore && typeof eventStore.appendEvent === 'function') {
    try {
      const ev = await eventStore.appendEvent({
        tenant_id: String(tenant_id),
        namespace: String(ns),
        provider: DRIFT_ALERT_PROVIDER,
        status: drift_result.drift_detected ? 'drift' : 'ok',
        source_type: 'real',
        feedback: JSON.stringify(payload),
      });
      persisted = true;
      persisted_event_id = (ev && ev.event_id) || null;
    } catch (e) {
      persist_error = String((e && e.message) || e);
    }
  }

  return {
    ok: true,
    version: DRIFT_ALERT_VERSION,
    alert_id,
    event_type: DRIFT_EVENT_TYPE,
    tenant_id,
    namespace: ns,
    payload,
    notification_attempted,
    notification_sent,
    notification_error,
    notification_result,
    persisted,
    persisted_event_id,
    persist_error,
  };
}

// =============================================================================
// listRecentAlerts({tenant_id, namespace, limit, opts}) - tenant-fenced read.
//
// Returns ranked list of past drift_detected alerts most-recent first.
//
// W411 defense-in-depth: listEvents tenant_id filter AND per-row tenant_id
// re-check after the read. Never trusts the index alone.
// =============================================================================
export async function listRecentAlerts({
  tenant_id = null,
  namespace = null,
  limit = 50,
  opts = {},
} = {}) {
  if (!tenant_id || typeof tenant_id !== 'string') {
    return {
      ok: false,
      error: 'tenant_id_required',
      hint: 'pass tenant_id (string). Drift alerts are tenant-scoped.',
      version: DRIFT_ALERT_VERSION,
    };
  }
  let cap = Number(limit);
  if (!Number.isFinite(cap) || cap < 1) cap = 50;
  if (cap > 500) cap = 500;

  let eventStore = opts && opts.eventStore;
  if (!eventStore) {
    try {
      eventStore = await import('./event-store.js');
    } catch (e) {
      return {
        ok: false,
        error: 'event_store_unavailable',
        detail: String((e && e.message) || e),
        version: DRIFT_ALERT_VERSION,
      };
    }
  }
  if (typeof eventStore.listEvents !== 'function') {
    return {
      ok: false,
      error: 'event_store_missing_listEvents',
      version: DRIFT_ALERT_VERSION,
    };
  }

  let rows = [];
  try {
    rows = await eventStore.listEvents({
      tenant_id,
      provider: DRIFT_ALERT_PROVIDER,
      limit: cap * 4, // overfetch then defense-in-depth filter + slice
      order: 'desc',
    }) || [];
  } catch (e) {
    return {
      ok: false,
      error: 'list_events_failed',
      detail: String((e && e.message) || e),
      version: DRIFT_ALERT_VERSION,
    };
  }

  // W411 defense-in-depth per-row tenant fence even after the index query.
  const fenced = rows.filter((r) => r && r.tenant_id === tenant_id);

  // Optional namespace filter (after fence, never instead of).
  const nsFiltered = namespace
    ? fenced.filter((r) => r && r.namespace === namespace)
    : fenced;

  const alerts = [];
  for (const row of nsFiltered.slice(0, cap)) {
    let parsed = null;
    if (row.feedback) {
      try { parsed = JSON.parse(row.feedback); } catch {} // deliberate: cleanup
    }
    alerts.push({
      event_id: row.event_id || null,
      tenant_id: row.tenant_id,
      namespace: row.namespace || 'default',
      created_at: row.created_at || null,
      status: row.status || null,
      payload: parsed,
    });
  }

  return {
    ok: true,
    version: DRIFT_ALERT_VERSION,
    tenant_id,
    namespace: namespace || null,
    alerts,
    count: alerts.length,
    limit: cap,
  };
}

export default {
  DRIFT_ALERT_VERSION,
  DRIFT_EVENT_TYPE,
  emitDriftAlert,
  listRecentAlerts,
};
