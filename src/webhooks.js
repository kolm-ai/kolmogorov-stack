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
import dns from 'node:dns';
import net from 'node:net';
import { promisify } from 'node:util';

const dnsLookup = promisify(dns.lookup);

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

// GW - SSRF hardening. A robust private/loopback/link-local/ULA/IPv4-mapped
// range check over a normalized numeric IP string. Covers the encodings the old
// dotted-quad regex missed (decimal/octal/hex IPv4, IPv6 ULA/link-local,
// ::ffff:127.0.0.1 mapped, CGNAT, metadata 169.254.169.254). Returns true when
// the address is one a tenant-controlled URL must never be allowed to reach.
function _allowLocal() {
  return process.env.KOLM_WEBHOOKS_ALLOW_LOCAL === '1';
}

// Normalize a host that is a numeric IPv4 in decimal/octal/hex form (e.g.
// "2130706433", "0x7f000001", "0177.0.0.1") to dotted-quad, so the range check
// below sees a canonical address. Returns the normalized string, or the input
// unchanged when it is not a recognizable numeric IPv4 encoding.
function normalizeNumericHost(host) {
  if (typeof host !== 'string' || !host) return host;
  let h = host.trim();
  // Strip IPv6 brackets if present.
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (net.isIP(h)) return h;
  // Single-integer forms: decimal, 0x-hex, or 0-octal.
  const single = h.match(/^(0x[0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)$/);
  if (single) {
    let n;
    try { n = h.toLowerCase().startsWith('0x') ? parseInt(h, 16) : (h[0] === '0' && h.length > 1 ? parseInt(h, 8) : parseInt(h, 10)); } catch { n = NaN; }
    if (Number.isFinite(n) && n >= 0 && n <= 0xffffffff) {
      return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
    }
  }
  // Dotted forms where octets may be octal/hex (e.g. 0x7f.0.0.1, 0177.0.0.1).
  const parts = h.split('.');
  if (parts.length === 4 && parts.every((p) => /^(0x[0-9a-fA-F]+|0[0-7]*|[0-9]+)$/.test(p))) {
    const octets = parts.map((p) => p.toLowerCase().startsWith('0x') ? parseInt(p, 16) : (p[0] === '0' && p.length > 1 ? parseInt(p, 8) : parseInt(p, 10)));
    if (octets.every((o) => Number.isFinite(o) && o >= 0 && o <= 255)) return octets.join('.');
  }
  return h;
}

function ipv4ToInt(ip) {
  const m = ip.split('.').map(Number);
  if (m.length !== 4 || m.some((o) => !Number.isFinite(o) || o < 0 || o > 255)) return null;
  return ((m[0] << 24) >>> 0) + (m[1] << 16) + (m[2] << 8) + m[3];
}

function isPrivateIp(ip) {
  if (typeof ip !== 'string' || !ip) return true; // unresolved => treat as unsafe
  const v = net.isIP(ip);
  if (v === 4) {
    const n = ipv4ToInt(ip);
    if (n == null) return true;
    const inRange = (cidrBase, bits) => (n >>> (32 - bits)) === (ipv4ToInt(cidrBase) >>> (32 - bits));
    return (
      inRange('0.0.0.0', 8) ||        // 0.0.0.0/8
      inRange('10.0.0.0', 8) ||       // private
      inRange('100.64.0.0', 10) ||    // CGNAT
      inRange('127.0.0.0', 8) ||      // loopback
      inRange('169.254.0.0', 16) ||   // link-local (incl. 169.254.169.254 metadata)
      inRange('172.16.0.0', 12) ||    // private
      inRange('192.168.0.0', 16) ||   // private
      inRange('192.0.0.0', 24) ||     // IETF protocol assignments
      n >= ipv4ToInt('224.0.0.0')     // multicast + reserved (>=224.0.0.0)
    );
  }
  if (v === 6) {
    let a = ip.toLowerCase();
    if (a === '::1' || a === '::') return true;
    // IPv4-mapped (::ffff:127.0.0.1) and IPv4-compatible: extract trailing v4.
    const mapped = a.match(/(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    // fc00::/7 (ULA), fe80::/10 (link-local), ::/8 reserved.
    const first = a.split(':')[0] || '';
    const hi = parseInt(first.padStart(4, '0').slice(0, 2), 16);
    if ((hi & 0xfe) === 0xfc) return true;           // fc00::/7
    if (a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb')) return true; // fe80::/10
    return false;
  }
  return true; // not a valid IP literal => unsafe
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
  // Block obvious SSRF targets at create time (a fast literal check). Real
  // protection happens at delivery time (assertPublicUrlAtDelivery) which
  // resolves DNS, defeating rebinding.
  if (!_allowLocal()) {
    const host = normalizeNumericHost(u.hostname);
    if (host === 'localhost') return { ok: false, error: 'url resolves to a private/loopback address' };
    if (net.isIP(host) && isPrivateIp(host)) {
      return { ok: false, error: 'url resolves to a private/loopback address' };
    }
  }
  return { ok: true };
}

// GW - delivery-time SSRF guard. Resolve the hostname to ALL its addresses and
// reject if ANY is private/loopback/link-local/ULA/mapped. This defeats DNS
// rebinding (a public name that later points at 169.254.169.254 or 10.x) which
// a create-time literal check cannot catch. Returns { ok } or { ok:false, error }.
export async function assertPublicUrlAtDelivery(rawUrl) {
  if (_allowLocal()) return { ok: true };
  let u;
  try { u = new URL(rawUrl); } catch { return { ok: false, error: 'invalid url' }; }
  const host = normalizeNumericHost(u.hostname);
  if (host === 'localhost') return { ok: false, error: 'host resolves to a private address' };
  // Literal IP host: check directly (no DNS).
  if (net.isIP(host)) {
    return isPrivateIp(host) ? { ok: false, error: 'host resolves to a private address' } : { ok: true };
  }
  // Named host: resolve every address and reject if ANY is private.
  let addrs = [];
  try { addrs = await dnsLookup(host, { all: true }); } catch (e) { return { ok: false, error: 'dns lookup failed: ' + String((e && e.message) || e) }; }
  if (!addrs.length) return { ok: false, error: 'host did not resolve' };
  for (const a of addrs) {
    if (isPrivateIp(a.address)) return { ok: false, error: 'host resolves to a private address' };
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
  // GW - re-validate at delivery time (defeats DNS rebinding). Reject before any
  // socket is opened to a private/metadata address.
  const guard = await assertPublicUrlAtDelivery(sub.url);
  if (!guard.ok) return { status: 0, ok: false, error: 'ssrf_blocked: ' + guard.error };
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
      // GW - never auto-follow a redirect: a public URL could 302 to a private
      // one, bypassing the resolve-and-check above. A 3xx is surfaced as-is.
      redirect: 'manual',
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

// Exposed for tests + any caller that wants to pre-validate a URL the same way
// delivery does.
export { isPrivateIp, normalizeNumericHost };

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
  assertPublicUrlAtDelivery,
  isPrivateIp,
  normalizeNumericHost,
};
