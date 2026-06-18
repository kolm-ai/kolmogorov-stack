// W699 - W813 drift alert wrapper.
//
// W813-3 spec: webhook + email alerts via the existing notification surface.
// This module is the W813 alert envelope around drift_detected events.
//
// FILENAME NOTE: The W813 wave spec listed this as `src/drift-alert.js`. That
// path was already taken by W747 (distribution-shift live alerter), so the
// embedding-distribution W813 alert wrapper lives here.
//
// HONESTY INVARIANTS:
//   - emitDriftAlert never silent-fails. Notification and persistence outcomes
//     are explicit in every successful envelope.
//   - Drift notifications use the unified W910 notifications.notify surface
//     when it is available, with event_type === drift_detected.
//   - tenant_id and namespace are bounded before notification or persistence.
//   - listRecentAlerts tenant-fences twice: event-store query plus per-row
//     re-check, and it sanitizes persisted JSON before returning it.

import crypto from 'node:crypto';

export const DRIFT_ALERT_VERSION = 'w813-v1';
export const DRIFT_ALERT_CONTRACT_VERSION = 'w699-v1';

// The event_type stamp on every drift alert. W813-3 spec contract.
export const DRIFT_EVENT_TYPE = 'drift_detected';

export const MAX_DRIFT_ALERT_ID_BYTES = 256;
export const MAX_DRIFT_ALERT_TEXT_CHARS = 1000;
export const MAX_RECENT_ALERT_LIMIT = 500;

// Provider tag used when persisting drift-alert rows via the event-store.
export const DRIFT_ALERT_PROVIDER = 'kolm_drift_alert';

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const HEX64_RE = /^[a-f0-9]{64}$/;
const SEVERITIES = new Set(['none', 'minor', 'moderate', 'severe', 'unknown']);

function _byteLen(s) {
  return Buffer.byteLength(String(s), 'utf8');
}

function _fail(error, hint) {
  return {
    ok: false,
    error,
    ...(hint ? { hint } : {}),
    version: DRIFT_ALERT_VERSION,
    contract_version: DRIFT_ALERT_CONTRACT_VERSION,
  };
}

function _normalizeId(value, field, {
  required = true,
  defaultValue = null,
  maxBytes = MAX_DRIFT_ALERT_ID_BYTES,
} = {}) {
  if (value == null || value === '') {
    if (!required) return { ok: true, value: defaultValue };
    return { ok: false, error: field + '_required' };
  }
  if (typeof value !== 'string') {
    return { ok: false, error: field + '_required' };
  }
  const s = value.trim();
  if (!s) {
    if (!required) return { ok: true, value: defaultValue };
    return { ok: false, error: field + '_required' };
  }
  if (CONTROL_RE.test(s)) return { ok: false, error: field + '_invalid' };
  if (_byteLen(s) > maxBytes) return { ok: false, error: field + '_too_large' };
  return { ok: true, value: s };
}

function _cleanText(value, maxChars = MAX_DRIFT_ALERT_TEXT_CHARS) {
  if (value == null) return '';
  const s = String(value).replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  return s.length > maxChars ? s.slice(0, maxChars) : s;
}

function _safeSeverity(value) {
  const s = _cleanText(value, 32).toLowerCase();
  return SEVERITIES.has(s) ? s : 'unknown';
}

function _finiteOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function _canonicalize(value) {
  if (Array.isArray(value)) return value.map((v) => _canonicalize(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = _canonicalize(value[k]);
    return out;
  }
  return value;
}

function _sha256Hex(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(_canonicalize(value)))
    .digest('hex');
}

function _withPayloadHash(payload) {
  const out = { ...payload };
  delete out.payload_sha256;
  return { ...out, payload_sha256: _sha256Hex(out) };
}

function _resolveNowIso(opts) {
  if (opts && typeof opts.now_iso === 'string' && !CONTROL_RE.test(opts.now_iso)) {
    const t = Date.parse(opts.now_iso);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return new Date().toISOString();
}

function _resolveAlertId(opts) {
  let uuid = null;
  if (opts && typeof opts.randomUUID === 'function') {
    try { uuid = opts.randomUUID(); } catch { uuid = null; }
  }
  if (!uuid) uuid = crypto.randomUUID();
  const safe = _cleanText(uuid, 96).replace(/[^a-zA-Z0-9_-]/g, '');
  return 'da_' + (safe || crypto.randomUUID());
}

function _buildPayload({
  alert_id,
  tenant_id,
  namespace,
  drift_result,
  created_at,
}) {
  const p = {
    alert_id,
    event_type: DRIFT_EVENT_TYPE,
    tenant_id,
    namespace,
    drift_detected: drift_result && drift_result.drift_detected === true,
    severity: _safeSeverity(drift_result && drift_result.severity),
    kl_divergence: _finiteOrNull(drift_result && drift_result.kl_divergence),
    kl_threshold: _finiteOrNull(drift_result && drift_result.kl_threshold),
    fallback_rate_delta: _finiteOrNull(drift_result && drift_result.fallback_rate_delta),
    suggested_action_text: _cleanText(drift_result && drift_result.suggested_action_text),
    created_at,
    version: DRIFT_ALERT_VERSION,
    contract_version: DRIFT_ALERT_CONTRACT_VERSION,
  };
  return _withPayloadHash(p);
}

function _notificationPayload(payload) {
  const out = { ...payload };
  // notifications.notify already carries the tenant argument. Keep the channel
  // payload focused on the drift event and its digest.
  delete out.tenant_id;
  return out;
}

function _notificationResultToSent(result) {
  const sent = Number(result && result.sent);
  const succeeded = Number(result && result.succeeded);
  return Number.isFinite(succeeded) ? succeeded > 0 : !!(result && (result.sent === true || result.ok === true));
}

function _notificationErrorFor(result) {
  if (result && result.reason === 'event_disabled') return 'notification_event_disabled';
  const sent = Number(result && result.sent);
  if (Number.isFinite(sent) && sent === 0) return 'notification_channels_not_configured';
  return 'notification_delivery_failed';
}

async function _dispatchNotification({ tenant_id, namespace, drift_result, payload, opts }) {
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
      notification_result = await sender({ tenant_id, namespace, drift_result, payload });
      notification_sent = !!(notification_result && (notification_result === true || notification_result.ok === true || notification_result.sent === true));
      if (!notification_sent) notification_error = _notificationErrorFor(notification_result);
    } catch (e) {
      notification_error = String((e && e.message) || e);
    }
    return { notification_attempted, notification_sent, notification_error, notification_result };
  }

  notification_attempted = true;
  let notifMod = opts && opts.notificationsModule;
  if (!notifMod) {
    try {
      notifMod = await import('./notifications.js');
    } catch (e) {
      notifMod = null;
      notification_error = 'notifications_module_unavailable: ' + String((e && e.message) || e);
    }
  }

  if (notifMod && typeof notifMod.notify === 'function') {
    try {
      notification_result = await notifMod.notify(
        tenant_id,
        DRIFT_EVENT_TYPE,
        _notificationPayload(payload),
      );
      notification_sent = _notificationResultToSent(notification_result);
      if (!notification_sent) notification_error = _notificationErrorFor(notification_result);
    } catch (e) {
      notification_error = String((e && e.message) || e);
    }
  } else if (notifMod) {
    try {
      if (typeof notifMod.publicConfig === 'function') {
        const cfg = notifMod.publicConfig();
        notification_result = {
          webpush_configured: !!cfg.webpush_configured,
          email_configured: !!cfg.email_configured,
          dispatch_hook: 'notify_missing',
        };
        notification_error = 'notifications_module_missing_notify';
      } else {
        notification_error = 'notifications_module_missing_notify';
      }
    } catch (e) {
      notification_error = String((e && e.message) || e);
    }
  }

  return { notification_attempted, notification_sent, notification_error, notification_result };
}

function _sanitizeStoredPayload(parsed, row) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.event_type && parsed.event_type !== DRIFT_EVENT_TYPE) return null;
  const createdAt = typeof parsed.created_at === 'string' && !CONTROL_RE.test(parsed.created_at)
    ? parsed.created_at
    : row.created_at || null;
  const alertId = _cleanText(parsed.alert_id || row.event_id || '', 160) || null;
  return _buildPayload({
    alert_id: alertId,
    tenant_id: row.tenant_id,
    namespace: row.namespace || 'default',
    drift_result: parsed,
    created_at: createdAt,
  });
}

// emitDriftAlert({tenant_id, namespace, drift_result, opts}) - fire alert.
export async function emitDriftAlert({
  tenant_id = null,
  namespace = null,
  drift_result = null,
  opts = {},
} = {}) {
  const tenant = _normalizeId(tenant_id, 'tenant_id');
  if (!tenant.ok) {
    return _fail(tenant.error, 'pass tenant_id (string). Drift alerts are tenant-scoped.');
  }
  const ns = _normalizeId(namespace, 'namespace', { required: false, defaultValue: 'default' });
  if (!ns.ok) return _fail(ns.error, 'namespace must be a bounded string when provided.');

  if (!drift_result || typeof drift_result !== 'object' || Array.isArray(drift_result)) {
    return _fail('drift_result_required', 'pass drift_result envelope from compareDistributions()');
  }

  const alert_id = _resolveAlertId(opts);
  const payload = _buildPayload({
    alert_id,
    tenant_id: tenant.value,
    namespace: ns.value,
    drift_result,
    created_at: _resolveNowIso(opts),
  });

  const notification = await _dispatchNotification({
    tenant_id: tenant.value,
    namespace: ns.value,
    drift_result,
    payload,
    opts,
  });

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
        tenant_id: tenant.value,
        namespace: ns.value,
        provider: DRIFT_ALERT_PROVIDER,
        status: payload.drift_detected ? 'drift' : 'ok',
        source_type: 'real',
        feedback: JSON.stringify(payload),
      });
      persisted = true;
      persisted_event_id = (ev && ev.event_id) || null;
    } catch (e) {
      persist_error = String((e && e.message) || e);
    }
  } else if (!persist_error) {
    persist_error = 'event_store_missing_appendEvent';
  }

  return {
    ok: true,
    version: DRIFT_ALERT_VERSION,
    contract_version: DRIFT_ALERT_CONTRACT_VERSION,
    alert_id,
    event_type: DRIFT_EVENT_TYPE,
    tenant_id: tenant.value,
    namespace: ns.value,
    payload,
    payload_sha256: payload.payload_sha256,
    ...notification,
    persisted,
    persisted_event_id,
    persist_error,
  };
}

// listRecentAlerts({tenant_id, namespace, limit, opts}) - tenant-fenced read.
export async function listRecentAlerts({
  tenant_id = null,
  namespace = null,
  limit = 50,
  opts = {},
} = {}) {
  const tenant = _normalizeId(tenant_id, 'tenant_id');
  if (!tenant.ok) {
    return _fail(tenant.error, 'pass tenant_id (string). Drift alerts are tenant-scoped.');
  }
  const ns = _normalizeId(namespace, 'namespace', { required: false, defaultValue: null });
  if (!ns.ok) return _fail(ns.error, 'namespace must be a bounded string when provided.');

  let cap = Number(limit);
  if (!Number.isFinite(cap) || cap < 1) cap = 50;
  cap = Math.min(MAX_RECENT_ALERT_LIMIT, Math.trunc(cap));

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
        contract_version: DRIFT_ALERT_CONTRACT_VERSION,
      };
    }
  }
  if (typeof eventStore.listEvents !== 'function') {
    return _fail('event_store_missing_listEvents');
  }

  let rows = [];
  try {
    rows = await eventStore.listEvents({
      tenant_id: tenant.value,
      provider: DRIFT_ALERT_PROVIDER,
      limit: cap * 4,
      order: 'desc',
    }) || [];
  } catch (e) {
    return {
      ok: false,
      error: 'list_events_failed',
      detail: String((e && e.message) || e),
      version: DRIFT_ALERT_VERSION,
      contract_version: DRIFT_ALERT_CONTRACT_VERSION,
    };
  }

  const fenced = rows.filter((r) => r && r.tenant_id === tenant.value);
  const nsFiltered = ns.value
    ? fenced.filter((r) => r && r.namespace === ns.value)
    : fenced;

  const alerts = [];
  for (const row of nsFiltered.slice(0, cap)) {
    let parsed = null;
    if (row.feedback) {
      try { parsed = JSON.parse(row.feedback); } catch { parsed = null; }
    }
    alerts.push({
      event_id: row.event_id || null,
      tenant_id: row.tenant_id,
      namespace: row.namespace || 'default',
      created_at: row.created_at || null,
      status: row.status || null,
      payload: _sanitizeStoredPayload(parsed, row),
    });
  }

  return {
    ok: true,
    version: DRIFT_ALERT_VERSION,
    contract_version: DRIFT_ALERT_CONTRACT_VERSION,
    tenant_id: tenant.value,
    namespace: ns.value || null,
    alerts,
    count: alerts.length,
    limit: cap,
  };
}

export default {
  DRIFT_ALERT_VERSION,
  DRIFT_ALERT_CONTRACT_VERSION,
  DRIFT_EVENT_TYPE,
  DRIFT_ALERT_PROVIDER,
  emitDriftAlert,
  listRecentAlerts,
};
