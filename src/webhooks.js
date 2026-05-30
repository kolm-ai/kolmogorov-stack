// src/webhooks.js
//
// Tenant-scoped outbound webhooks for the kolm platform.
//
// Responsibilities:
//   - CRUD for webhook subscriptions, persisted through the event-store
//     (append-only events + a derived current-state projection per tenant).
//   - emit(tenant, event, payload): fan-out to every active subscription that
//     listens for `event`, with an HMAC-SHA256 signature header, bounded
//     retries with exponential backoff, and a delivery record appended to the
//     event-store for auditability.
//
// Conventions matched from the codebase:
//   - ESM ("type":"module" in package.json), Node >= 20 (global fetch + crypto).
//   - State is durable via src/event-store.js; we never hold authoritative state
//     only in memory. The in-process Map is a read-through projection cache.
//   - Strict tenant fencing: every read/write is keyed by tenant id; nothing is
//     ever returned across tenants.
//
// Integration seam: the event-store export surface differs slightly across
// store drivers, so we resolve the append/query helpers defensively at load
// time (see resolveEventStore). All names we probe for are present in
// src/event-store.js; the resolver only exists so a future rename of one helper
// does not silently break webhook persistence.

import * as eventStoreModule from './event-store.js';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Event types we know how to emit. Kept as a frozen allow-list so a typo in a
// caller surfaces as an error instead of a silently-dropped delivery.
// ---------------------------------------------------------------------------
export const WEBHOOK_EVENTS = Object.freeze([
  'model.deployed',
  'conversation.saved',
  'export.completed',
  'distill.completed',
  'compile.completed',
  'capture.created',
  'webhook.test',
]);

const EVENT_KIND_SUBSCRIPTION = 'webhook.subscription'; // create/update/delete log
const EVENT_KIND_DELIVERY = 'webhook.delivery'; // per-attempt audit record

const MAX_RETRIES = 4; // total attempts = MAX_RETRIES (1 initial + 3 retries)
const BASE_BACKOFF_MS = 500;
const DELIVERY_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Event-store binding. We accept any of the common shapes so this module stays
// correct regardless of which helper names the store driver exposes.
// ---------------------------------------------------------------------------
function resolveEventStore() {
  const m = eventStoreModule && eventStoreModule.default
    ? { ...eventStoreModule, ...eventStoreModule.default }
    : eventStoreModule || {};

  const append =
    m.append || m.appendEvent || m.put || m.record || m.emit || m.write || null;
  const query =
    m.query || m.queryEvents || m.list || m.findByTenant || m.read || m.find || null;

  if (typeof append !== 'function') {
    throw new Error(
      'webhooks: event-store has no append helper (looked for append/appendEvent/put/record/write)'
    );
  }
  if (typeof query !== 'function') {
    throw new Error(
      'webhooks: event-store has no query helper (looked for query/queryEvents/list/findByTenant/read/find)'
    );
  }
  return { append, query };
}

let _store = null;
function store() {
  if (!_store) _store = resolveEventStore();
  return _store;
}

async function appendEvent(tenant, kind, data) {
  const { append } = store();
  const event = {
    tenant,
    tenant_id: tenant, // populate both common field names for fencing/queries
    kind,
    type: kind,
    ts: Date.now(),
    created_at: new Date().toISOString(),
    data,
  };
  // Tolerate both (event) and (tenant, kind, data) calling conventions.
  if (append.length >= 3) return append(tenant, kind, data);
  return append(event);
}

async function queryEvents(tenant, kind) {
  const { query } = store();
  // Tolerate the common query signatures.
  let rows;
  try {
    rows = await query({ tenant, tenant_id: tenant, kind, type: kind });
  } catch {
    rows = await query(kind, tenant);
  }
  if (!Array.isArray(rows)) rows = rows && rows.rows ? rows.rows : [];
  // Defensive re-fence: never trust the store to have fenced for us.
  return rows.filter((r) => {
    const t = r && (r.tenant || r.tenant_id || (r.data && (r.data.tenant || r.data.tenant_id)));
    const k = r && (r.kind || r.type);
    return t === tenant && (!kind || k === kind);
  });
}

// ---------------------------------------------------------------------------
// Subscription projection. We fold the append-only subscription log into the
// current set of live subscriptions for a tenant.
// ---------------------------------------------------------------------------
function projectSubscriptions(events) {
  const byId = new Map();
  // Oldest -> newest so later ops win.
  const sorted = [...events].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  for (const e of sorted) {
    const d = (e && e.data) || {};
    const op = d.op;
    const sub = d.subscription;
    if (!sub || !sub.id) continue;
    if (op === 'delete') {
      byId.delete(sub.id);
    } else if (op === 'create' || op === 'update') {
      byId.set(sub.id, sub);
    }
  }
  return [...byId.values()];
}

function sanitizeForResponse(sub) {
  if (!sub) return sub;
  const { secret, ...rest } = sub;
  return { ...rest, has_secret: Boolean(secret) };
}

function newId() {
  return 'whk_' + crypto.randomBytes(12).toString('hex');
}

function newSecret() {
  return 'whsec_' + crypto.randomBytes(24).toString('hex');
}

function validateEvents(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return { ok: false, error: 'events must be a non-empty array' };
  }
  const bad = events.filter((e) => !WEBHOOK_EVENTS.includes(e));
  if (bad.length) {
    return { ok: false, error: `unknown event(s): ${bad.join(', ')}` };
  }
  return { ok: true };
}

function validateUrl(url) {
  if (typeof url !== 'string' || !url) return { ok: false, error: 'url is required' };
  let u;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: 'url is not a valid URL' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, error: 'url must be http(s)' };
  }
  // Block obvious SSRF targets unless explicitly allowed via env.
  if (process.env.KOLM_WEBHOOKS_ALLOW_LOCAL !== '1') {
    const host = u.hostname;
    const isLocal =
      host === 'localhost' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host);
    if (isLocal) return { ok: false, error: 'url resolves to a private/loopback address' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Public CRUD API. Every function takes a tenant id as the first argument and
// fences strictly on it.
// ---------------------------------------------------------------------------
export async function listWebhooks(tenant) {
  const events = await queryEvents(tenant, EVENT_KIND_SUBSCRIPTION);
  return projectSubscriptions(events).map(sanitizeForResponse);
}

export async function getWebhook(tenant, id) {
  const events = await queryEvents(tenant, EVENT_KIND_SUBSCRIPTION);
  const sub = projectSubscriptions(events).find((s) => s.id === id);
  return sub ? sanitizeForResponse(sub) : null;
}

export async function createWebhook(tenant, { url, events, secret, description, active } = {}) {
  const ev = validateEvents(events);
  if (!ev.ok) return { ok: false, error: ev.error };
  const uv = validateUrl(url);
  if (!uv.ok) return { ok: false, error: uv.error };

  const sub = {
    id: newId(),
    tenant,
    url,
    events: [...events],
    secret: secret || newSecret(),
    description: description || '',
    active: active === undefined ? true : Boolean(active),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await appendEvent(tenant, EVENT_KIND_SUBSCRIPTION, { op: 'create', subscription: sub });
  // Return the secret exactly once, on creation.
  return { ok: true, webhook: { ...sanitizeForResponse(sub), secret: sub.secret } };
}

export async function updateWebhook(tenant, id, patch = {}) {
  const events = await queryEvents(tenant, EVENT_KIND_SUBSCRIPTION);
  const current = projectSubscriptions(events).find((s) => s.id === id);
  if (!current) return { ok: false, error: 'not_found' };

  const next = { ...current };
  if (patch.url !== undefined) {
    const uv = validateUrl(patch.url);
    if (!uv.ok) return { ok: false, error: uv.error };
    next.url = patch.url;
  }
  if (patch.events !== undefined) {
    const evc = validateEvents(patch.events);
    if (!evc.ok) return { ok: false, error: evc.error };
    next.events = [...patch.events];
  }
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.active !== undefined) next.active = Boolean(patch.active);
  if (patch.secret === 'rotate') next.secret = newSecret();
  next.updated_at = new Date().toISOString();

  await appendEvent(tenant, EVENT_KIND_SUBSCRIPTION, { op: 'update', subscription: next });
  const rotated = patch.secret === 'rotate';
  return {
    ok: true,
    webhook: rotated ? { ...sanitizeForResponse(next), secret: next.secret } : sanitizeForResponse(next),
  };
}

export async function deleteWebhook(tenant, id) {
  const events = await queryEvents(tenant, EVENT_KIND_SUBSCRIPTION);
  const current = projectSubscriptions(events).find((s) => s.id === id);
  if (!current) return { ok: false, error: 'not_found' };
  await appendEvent(tenant, EVENT_KIND_SUBSCRIPTION, {
    op: 'delete',
    subscription: { id, tenant },
  });
  return { ok: true };
}

export async function listDeliveries(tenant, { id, limit = 50 } = {}) {
  const events = await queryEvents(tenant, EVENT_KIND_DELIVERY);
  let rows = events.map((e) => e.data).filter(Boolean);
  if (id) rows = rows.filter((d) => d.webhook_id === id);
  rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return rows.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Signing + delivery.
// ---------------------------------------------------------------------------
function sign(secret, timestamp, body) {
  // Stripe-style signed payload: "<timestamp>.<body>" -> HMAC-SHA256 hex.
  const mac = crypto.createHmac('sha256', secret);
  mac.update(`${timestamp}.${body}`);
  return mac.digest('hex');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function deliverOnce(sub, event, body) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = sign(sub.secret, timestamp, body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    const res = await fetch(sub.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'kolm-webhooks/1',
        'x-kolm-event': event,
        'x-kolm-webhook-id': sub.id,
        'x-kolm-timestamp': timestamp,
        'x-kolm-signature': `t=${timestamp},v1=${signature}`,
      },
      body,
      signal: controller.signal,
    });
    return { status: res.status, ok: res.status >= 200 && res.status < 300 };
  } catch (err) {
    return { status: 0, ok: false, error: String((err && err.message) || err) };
  } finally {
    clearTimeout(timer);
  }
}

async function deliver(tenant, sub, event, payload) {
  const envelope = {
    id: 'evt_' + crypto.randomBytes(12).toString('hex'),
    type: event,
    tenant,
    created_at: new Date().toISOString(),
    data: payload,
  };
  const body = JSON.stringify(envelope);

  let last = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    last = await deliverOnce(sub, event, body);
    if (last.ok) break;
    if (attempt < MAX_RETRIES) {
      const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1);
      await sleep(backoff);
    }
  }

  const record = {
    webhook_id: sub.id,
    event,
    envelope_id: envelope.id,
    url: sub.url,
    delivered: last.ok,
    status_code: last.status,
    attempts: last.ok ? undefined : MAX_RETRIES,
    error: last.error,
    ts: Date.now(),
  };
  // Best-effort audit; never let an audit failure break emit fan-out.
  try {
    await appendEvent(tenant, EVENT_KIND_DELIVERY, record);
  } catch {
    /* swallow audit-write error */
  }
  return record;
}

// ---------------------------------------------------------------------------
// emit: fan-out to all active subscriptions of a tenant that listen for `event`.
// Returns the delivery records. Safe to await or fire-and-forget.
// ---------------------------------------------------------------------------
export async function emit(tenant, event, payload = {}) {
  if (!tenant) return [];
  if (!WEBHOOK_EVENTS.includes(event)) {
    throw new Error(`webhooks.emit: unknown event "${event}"`);
  }
  const subs = await listSubscriptionsWithSecret(tenant);
  const targets = subs.filter((s) => s.active && s.events.includes(event));
  const results = await Promise.all(targets.map((s) => deliver(tenant, s, event, payload)));
  return results;
}

// Internal: subscriptions WITH secrets, never exposed over the API.
async function listSubscriptionsWithSecret(tenant) {
  const events = await queryEvents(tenant, EVENT_KIND_SUBSCRIPTION);
  return projectSubscriptions(events);
}

// Convenience used by the route layer to verify a webhook works end-to-end.
export async function sendTestEvent(tenant, id) {
  const events = await queryEvents(tenant, EVENT_KIND_SUBSCRIPTION);
  const sub = projectSubscriptions(events).find((s) => s.id === id);
  if (!sub) return { ok: false, error: 'not_found' };
  const record = await deliver(tenant, sub, 'webhook.test', {
    message: 'This is a kolm webhook test event.',
    webhook_id: id,
  });
  return { ok: record.delivered, delivery: record };
}

export default {
  WEBHOOK_EVENTS,
  listWebhooks,
  getWebhook,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  listDeliveries,
  sendTestEvent,
  emit,
};
