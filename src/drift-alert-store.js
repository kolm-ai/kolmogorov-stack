// W747 - Drift-alert sketch + webhook persistence.
//
// Backed by src/store.js (tables: drift_sketches, drift_webhooks). Every
// getter enforces tenant-fence at the call site via findByTenant + a
// defense-in-depth filter (W720 trap memory: never trust upstream filters
// alone, every row must be re-checked).
//
// Sketches are persisted as ONE row per (tenant, namespace, kind) snapshot.
// latestSnapshots() returns the most recent of each kind so the
// /v1/drift-alert/:namespace handler can compare them in O(1) per call.
//
// Webhooks are persisted as ONE row per (tenant, namespace, webhook_url)
// tuple. A second registration for the same URL UPDATES the existing row
// (threshold change) rather than duplicating it.
//
// Also wires the W709 drift-warning bridge:
//   - registerDriftWarning(tenant_id, namespace) sets an in-memory flag.
//   - consumeDriftWarning(tenant_id, namespace) returns + clears the flag.
// The W709 routing path imports this module at decision time and stamps
// `drift_warning:true` onto the next routing decision when a warning is
// pending. Honest fallback: if drift-alert-store fails to import (e.g. in a
// future refactor that decouples the modules) the W709 path silently
// continues - drift_warning is best-effort, never load-bearing.

import { insert, update, find, findByTenant, remove } from './store.js';

export const DRIFT_SKETCHES_TABLE = 'drift_sketches';
export const DRIFT_WEBHOOKS_TABLE = 'drift_webhooks';

export const DRIFT_KINDS = Object.freeze(['training', 'production']);
const MAX_NAMESPACE_CHARS = 128;
const MAX_WEBHOOK_URL_CHARS = 2048;

function _now() {
  return new Date().toISOString();
}

function _validKind(k) {
  return DRIFT_KINDS.indexOf(k) >= 0;
}

function _safeNamespace(ns) {
  const s = String(ns == null ? 'default' : ns)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, MAX_NAMESPACE_CHARS);
  if (!s || s === '__proto__' || s === 'constructor' || s === 'prototype') return 'default';
  return s;
}

function _normalizeWebhookUrl(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.length > MAX_WEBHOOK_URL_CHARS) return null;
  let u;
  try { u = new URL(raw.trim()); } catch (_) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  u.hash = '';
  return u.toString();
}

// ---------------------------------------------------------------------------
// Sketch snapshots
// ---------------------------------------------------------------------------

/**
 * Persist a sketch snapshot.
 *
 * @param {object} opts
 * @param {string} opts.tenant_id      REQUIRED (tenant-fenced at write)
 * @param {string} opts.namespace
 * @param {'training'|'production'} opts.kind
 * @param {object} opts.sketch         sketch object from buildDistributionSketch
 * @param {string} [opts.generated_at] ISO timestamp; defaults to now
 * @returns {object} row written
 */
export function recordSketchSnapshot({
  tenant_id,
  namespace,
  kind,
  sketch,
  generated_at,
} = {}) {
  if (!tenant_id) {
    const e = new Error('drift_alert_store: tenant_id required');
    e.code = 'missing_tenant_id';
    throw e;
  }
  if (!_validKind(kind)) {
    const e = new Error(`drift_alert_store: kind must be one of ${DRIFT_KINDS.join('|')}; got ${kind}`);
    e.code = 'invalid_kind';
    throw e;
  }
  if (!sketch || typeof sketch !== 'object') {
    const e = new Error('drift_alert_store: sketch (object) required');
    e.code = 'invalid_sketch';
    throw e;
  }
  const ns = _safeNamespace(namespace);
  const ts = generated_at || _now();
  const row = {
    kind: 'drift_sketch',
    sketch_kind: kind,
    tenant: tenant_id,
    tenant_id,
    namespace: ns,
    sketch,
    sketch_size: Number(sketch._top_k || 0),
    sketch_total: Number(sketch._total || 0),
    generated_at: ts,
    ts,
  };
  insert(DRIFT_SKETCHES_TABLE, row);
  return row;
}

/**
 * Return the latest training + production sketch snapshots for this
 * (tenant, namespace). Either may be null when no snapshot has been recorded.
 *
 * @param {string} tenant_id
 * @param {string} namespace
 * @returns {{training: object|null, production: object|null}}
 */
export function latestSnapshots(tenant_id, namespace) {
  if (!tenant_id) return { training: null, production: null };
  const ns = _safeNamespace(namespace);
  let rows = [];
  try { rows = findByTenant(DRIFT_SKETCHES_TABLE, tenant_id) || []; } catch (_) { rows = []; }
  // Defense in depth - re-check tenant + namespace.
  rows = rows.filter((r) =>
    r
    && (r.tenant === tenant_id || r.tenant_id === tenant_id)
    && r.namespace === ns
  );
  // Sort newest first.
  rows.sort((a, b) => {
    const ta = Date.parse(a.generated_at || a.ts || 0);
    const tb = Date.parse(b.generated_at || b.ts || 0);
    return tb - ta;
  });
  let training = null;
  let production = null;
  for (const r of rows) {
    if (!training && r.sketch_kind === 'training') training = r;
    if (!production && r.sketch_kind === 'production') production = r;
    if (training && production) break;
  }
  return { training, production };
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * Register (upsert) a webhook for distribution-shift alerts.
 *
 * @param {object} opts
 * @param {string} opts.tenant_id REQUIRED
 * @param {string} opts.namespace
 * @param {string} opts.webhook_url   absolute URL (http/https)
 * @param {number} [opts.jsd_threshold]
 * @returns {object} the persisted row
 */
export function registerWebhook({
  tenant_id,
  namespace,
  webhook_url,
  jsd_threshold,
} = {}) {
  if (!tenant_id) {
    const e = new Error('drift_alert_store: tenant_id required');
    e.code = 'missing_tenant_id';
    throw e;
  }
  const normalizedUrl = _normalizeWebhookUrl(webhook_url);
  if (!normalizedUrl) {
    const e = new Error('drift_alert_store: webhook_url must be an absolute http(s) URL');
    e.code = 'invalid_webhook_url';
    throw e;
  }
  const ns = _safeNamespace(namespace);
  const thr = Number.isFinite(Number(jsd_threshold)) ? Number(jsd_threshold) : null;
  // Upsert: if a webhook with the same url is already registered for this
  // (tenant, namespace) tuple, UPDATE its threshold rather than insert a dup.
  const existing = find(DRIFT_WEBHOOKS_TABLE, (r) =>
    r
    && (r.tenant === tenant_id || r.tenant_id === tenant_id)
    && r.namespace === ns
    && r.webhook_url === normalizedUrl
  );
  if (Array.isArray(existing) && existing.length > 0) {
    update(DRIFT_WEBHOOKS_TABLE,
      (r) => r === existing[0],
      { jsd_threshold: thr, updated_at: _now() });
    return { ...existing[0], jsd_threshold: thr, updated_at: _now() };
  }
  const row = {
    kind: 'drift_webhook',
    tenant: tenant_id,
    tenant_id,
    namespace: ns,
    webhook_url: normalizedUrl,
    jsd_threshold: thr,
    created_at: _now(),
    updated_at: _now(),
  };
  insert(DRIFT_WEBHOOKS_TABLE, row);
  return row;
}

/**
 * List webhooks for a (tenant, namespace).
 *
 * @param {string} tenant_id
 * @param {string} namespace
 * @returns {object[]}
 */
export function listWebhooks(tenant_id, namespace) {
  if (!tenant_id) return [];
  const ns = _safeNamespace(namespace);
  let rows = [];
  try { rows = findByTenant(DRIFT_WEBHOOKS_TABLE, tenant_id) || []; } catch (_) { rows = []; }
  return rows.filter((r) =>
    r
    && (r.tenant === tenant_id || r.tenant_id === tenant_id)
    && r.namespace === ns
  );
}

// ---------------------------------------------------------------------------
// W709 drift-warning bridge (in-memory, opt-in).
//
// The router sets a pending flag when shouldAlert() fires. The W709 routing
// decision path reads + clears the flag at decision time. The flag is
// in-process only - a server restart drops it and the next routing decision
// is back to "no warning". That's intentional: drift warnings are a SOFT
// signal whose value decays quickly. If a permanent warning is desired, the
// caller should pin it via the webhook (durable) instead.
// ---------------------------------------------------------------------------

const _warnings = new Map(); // key = `${tenant_id}|${namespace}` -> { at, jsd, namespace }

function _wkey(tenant_id, namespace) {
  return String(tenant_id) + '|' + _safeNamespace(namespace);
}

/**
 * Mark a drift warning as pending for this (tenant, namespace). Idempotent - 
 * repeated calls overwrite the timestamp + JSD.
 *
 * @param {string} tenant_id
 * @param {string} namespace
 * @param {{jsd?: number}} [opts]
 */
export function registerDriftWarning(tenant_id, namespace, opts = {}) {
  if (!tenant_id) return;
  const ns = _safeNamespace(namespace);
  _warnings.set(_wkey(tenant_id, ns), {
    at: _now(),
    jsd: Number.isFinite(Number(opts.jsd)) ? Number(opts.jsd) : null,
    namespace: ns,
  });
}

/**
 * Consume + clear a pending drift warning. Returns the warning record (with
 * jsd + at) or null if nothing was pending. The W709 routing path calls this
 * once per decision, stamps `drift_warning:true` when truthy, and the warning
 * does not fire again until the next /v1/drift-alert/:namespace pulls a fresh
 * compare that crosses threshold.
 *
 * @param {string} tenant_id
 * @param {string} namespace
 * @returns {{at:string, jsd:number|null, namespace:string}|null}
 */
export function consumeDriftWarning(tenant_id, namespace) {
  if (!tenant_id) return null;
  const k = _wkey(tenant_id, namespace);
  const v = _warnings.get(k);
  if (!v) return null;
  _warnings.delete(k);
  return v;
}

/**
 * Peek a pending drift warning without clearing. Used by /v1/drift-alert/peek
 * (read-only) so the dashboard can show pending state without firing it.
 */
export function peekDriftWarning(tenant_id, namespace) {
  if (!tenant_id) return null;
  return _warnings.get(_wkey(tenant_id, namespace)) || null;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

export function _resetForTests(tenant_id = null) {
  try {
    if (tenant_id) {
      remove(DRIFT_SKETCHES_TABLE, (r) => r && (r.tenant === tenant_id || r.tenant_id === tenant_id));
      remove(DRIFT_WEBHOOKS_TABLE, (r) => r && (r.tenant === tenant_id || r.tenant_id === tenant_id));
      for (const k of [..._warnings.keys()]) {
        if (k.startsWith(String(tenant_id) + '|')) _warnings.delete(k);
      }
    } else {
      remove(DRIFT_SKETCHES_TABLE, () => true);
      remove(DRIFT_WEBHOOKS_TABLE, () => true);
      _warnings.clear();
    }
  } catch (_) {} // deliberate: cleanup
}

export default {
  DRIFT_SKETCHES_TABLE,
  DRIFT_WEBHOOKS_TABLE,
  DRIFT_KINDS,
  recordSketchSnapshot,
  latestSnapshots,
  registerWebhook,
  listWebhooks,
  registerDriftWarning,
  consumeDriftWarning,
  peekDriftWarning,
  _resetForTests,
};
