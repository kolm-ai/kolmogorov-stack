// src/webhooks.js
//
// Tenant-scoped outbound webhooks for the kolm platform.
//
// Responsibilities:
//   - CRUD for webhook subscriptions, persisted through the event-store as an
//     append-only log folded into current state per tenant.
//   - emit(tenant, event, payload): fan-out to every active subscription that
//     listens for `event`, with an HMAC-SHA256 signature header, bounded
//     retries with exponential backoff, and a delivery record appended to the
//     event-store for auditability.
//
// Persistence contract (matched to src/event-store.js + src/event-schema.js):
//   appendEvent() runs canonicalize(newEvent(partial)) then validateEvent() and
//   THROWS `EVENT_INVALID` on missing required canonical fields. canonicalize()
//   REBUILDS the event from the CLOSED EVENT_FIELDS list, so any field NOT in
//   that list (e.g. a free-form `webhook` key) is silently dropped before the
//   json column is written. We therefore carry the whole webhook payload exactly
//   the way conversations.js carries chat history: JSON-serialized into
//   `media_extracted_text` (a real canonical field, preserved up to 1 MiB)
//   tagged media_kind:'transcript' + media_mime:'application/json'. listEvents()
//   round-trips that field intact, so we JSON.parse it back on read. Provider
//   tag 'kolm-webhooks' (conversations.js uses 'kolm-chat') keeps these rows out
//   of every gateway/capture surface. required fields (event_id/tenant_id/
//   namespace/created_at/schema_version) are auto-filled by newEvent().
//
//   Two namespaces, both tenant-fenced:
//     kolm-webhooks/subscriptions - create/update/delete subscription ops
//     kolm-webhooks/deliveries - per-attempt delivery audit records
//
// Conventions: ESM ("type":"module"), Node >= 20 (global fetch + node:crypto).
// Strict tenant fencing: every read/write is keyed by tenant id; nothing is ever
// returned across tenants.

import { appendEvent, listEvents } from './event-store.js';
import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Event types we know how to emit. Frozen allow-list so a typo in a caller
// surfaces as an error instead of a silently-dropped delivery.
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

const NS_SUBSCRIPTION = 'kolm-webhooks/subscriptions';
const NS_DELIVERY = 'kolm-webhooks/deliveries';
const PROVIDER_TAG = 'kolm-webhooks';

const MAX_RETRIES = 4; // total attempts (1 initial + 3 retries)
const BASE_BACKOFF_MS = 500;
const DELIVERY_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Event-store envelope. We hand appendEvent() the canonical fields it validates
// on, and stash the webhook payload as JSON in `media_extracted_text` (the only
// large free-text field canonicalize() preserves - same trick conversations.js
// uses). `model` carries a cheap discriminator (create/update/delete/delivery).
// ---------------------------------------------------------------------------
async function persist(tenant, namespace, opKind, webhookPayload) {
  return appendEvent({
    tenant_id: tenant,
    namespace,
    provider: PROVIDER_TAG,
    model: opKind,
    status: 'ok',
    created_at: new Date().toISOString(),
    media_kind: 'transcript',
    media_mime: 'application/json',
    media_extracted_text: JSON.stringify(webhookPayload),
  });
}

function payloadOf(ev) {
  if (!ev || typeof ev.media_extracted_text !== 'string') return null;
  try {
    return JSON.parse(ev.media_extracted_text);
  } catch {
    return null;
  }
}

async function readPayloads(tenant, namespace) {
  const rows = await listEvents({ tenant_id: tenant, namespace, limit: 0, order: 'asc' });
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const e of rows) {
    // Defensive re-fence: never trust the store to have fenced for us.
    if (!e || e.tenant_id !== tenant || e.namespace !== namespace) continue;
    const p = payloadOf(e);
    if (p) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Subscription projection. Fold the append-only op log into the current set of
// live subscriptions. `payloads` is oldest -> newest (listEvents order:'asc'),
// so later ops win.
// ---------------------------------------------------------------------------
function projectSubscriptions(payloads) {
  const byId = new Map();
  for (const w of payloads) {
    const op = w && w.op;
    const sub = w && w.subscription;
    if (!sub || !sub.id) continue;
    if (op === 'delete') byId.delete(sub.id);
    else if (op === 'create' || op === 'update') byId.set(sub.id, sub);
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

function validateEventsList(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return { ok: false, error: 'events must be a non-empty array' };
  }
  const bad = events.filter((e) => !WEBHOOK_EVENTS.includes(e));
  if (bad.length) return { ok: false, error: `unknown event(s): ${bad.join(', ')}` };
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
  // Block obvious SSRF targets unless explicitly allowed (e.g. local dev/tests).
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
// Public CRUD API. Every function takes a tenant id first and fences on it.
// ---------------------------------------------------------------------------
export async function listWebhooks(tenant) {
  const payloads = await readPayloads(tenant, NS_SUBSCRIPTION);
  return projectSubscriptions(payloads).map(sanitizeForResponse);
}

export async function getWebhook(tenant, id) {
  const payloads = await readPayloads(tenant, NS_SUBSCRIPTION);
  const sub = projectSubscriptions(payloads).find((s) => s.id === id);
  return sub ? sanitizeForResponse(sub) : null;
}

export async function createWebhook(tenant, { url, events, secret, description, active } = {}) {
  const ev = validateEventsList(events);
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
  await persist(tenant, NS_SUBSCRIPTION, 'create', { op: 'create', subscription: sub });
  // Return the secret exactly once, on creation.
  return { ok: true, webhook: { ...sanitizeForResponse(sub), secret: sub.secret } };
}

export async function updateWebhook(tenant, id, patch = {}) {
  const payloads = await readPayloads(tenant, NS_SUBSCRIPTION);
  const current = projectSubscriptions(payloads).find((s) => s.id === id);
  if (!current) return { ok: false, error: 'not_found' };

  const next = { ...current };
  if (patch.url !== undefined) {
    const uv = validateUrl(patch.url);
    if (!uv.ok) return { ok: false, error: uv.error };
    next.url = patch.url;
  }
  if (patch.events !== undefined) {
    const evc = validateEventsList(patch.events);
    if (!evc.ok) return { ok: false, error: evc.error };
    next.events = [...patch.events];
  }
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.active !== undefined) next.active = Boolean(patch.active);
  if (patch.secret === 'rotate') next.secret = newSecret();
  next.updated_at = new Date().toISOString();

  await persist(tenant, NS_SUBSCRIPTION, 'update', { op: 'update', subscription: next });
  const rotated = patch.secret === 'rotate';
  return {
    ok: true,
    webhook: rotated
      ? { ...sanitizeForResponse(next), secret: next.secret }
      : sanitizeForResponse(next),
  };
}

export async function deleteWebhook(tenant, id) {
  const payloads = await readPayloads(tenant, NS_SUBSCRIPTION);
  const current = projectSubscriptions(payloads).find((s) => s.id === id);
  if (!current) return { ok: false, error: 'not_found' };
  await persist(tenant, NS_SUBSCRIPTION, 'delete', { op: 'delete', subscription: { id, tenant } });
  return { ok: true };
}

export async function listDeliveries(tenant, { id, limit = 50 } = {}) {
  let rows = await readPayloads(tenant, NS_DELIVERY);
  if (id) rows = rows.filter((d) => d.webhook_id === id);
  rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return rows.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Signing + delivery.
// ---------------------------------------------------------------------------
function sign(secret, timestamp, body) {
  // Stripe-style signed payload: "<timestamp>.<body>" -> HMAC-SHA256 hex.
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
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
    if (attempt < MAX_RETRIES) await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
  }

  const record = {
    webhook_id: sub.id,
    event,
    envelope_id: envelope.id,
    url: sub.url,
    delivered: last.ok,
    status_code: last.status,
    attempts: last.ok ? 1 : MAX_RETRIES,
    error: last.error,
    ts: Date.now(),
  };
  // Best-effort audit; never let an audit-write failure break emit fan-out.
  try {
    await persist(tenant, NS_DELIVERY, 'delivery', record);
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
  return Promise.all(targets.map((s) => deliver(tenant, s, event, payload)));
}

// Internal: subscriptions WITH secrets, never exposed over the API.
async function listSubscriptionsWithSecret(tenant) {
  const payloads = await readPayloads(tenant, NS_SUBSCRIPTION);
  return projectSubscriptions(payloads);
}

// Convenience used by the route layer to verify a webhook works end-to-end.
export async function sendTestEvent(tenant, id) {
  const payloads = await readPayloads(tenant, NS_SUBSCRIPTION);
  const sub = projectSubscriptions(payloads).find((s) => s.id === id);
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
