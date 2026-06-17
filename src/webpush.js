// Wave 215 - minimal WebPush sender. Native Node, no npm dep.
//
// Implements the VAPID JWT auth scheme (RFC 8292) using node:crypto's
// built-in ECDSA P-256 support. Payloads are sent in plaintext with
// Content-Encoding: aes128gcm OMITTED - we use the "tickle" form where the
// push body is empty and the service worker's push handler reads from its
// own cache. Browsers accept this and fire the push event with empty data;
// the SW's `event.waitUntil(showNotification(...))` then renders a generic
// "open /captures" notification.
//
// Config (set in Vercel env or .env):
//   VAPID_PUBLIC_KEY   - base64url-encoded uncompressed P-256 public key
//                        (the 65-byte X9.62 form, starting 0x04).
//   VAPID_PRIVATE_KEY  - base64url-encoded P-256 private key scalar (32 bytes).
//   VAPID_SUBJECT      - "mailto:ops@kolm.ai" (or https://kolm.ai).
//
// Generate a fresh pair with: openssl ecparam -name prime256v1 -genkey
// (then convert to raw 65/32 byte forms - see notes in tests).

import crypto from 'node:crypto';

const VAPID_TOKEN_TTL_SECONDS = 12 * 3600;
const DEFAULT_PUSH_TTL_SECONDS = 86400;
const DEFAULT_PUSH_TIMEOUT_MS = 5000;
const MAX_PUSH_TIMEOUT_MS = 30000;

export const WEBPUSH_ALLOWED_HOSTS = Object.freeze([
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
]);

export const WEBPUSH_ALLOWED_HOST_SUFFIXES = Object.freeze([
  '.notify.windows.com',
  '.push.apple.com',
  '.push.services.mozilla.com',
  '.googleapis.com',
]);

export function vapidConfigured() {
  return validateVapidConfig().ok;
}

export function vapidPublicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(str) {
  const raw = String(str || '').trim();
  if (!raw || !/^[A-Za-z0-9_-]+={0,2}$/.test(raw) || raw.length % 4 === 1) {
    throw new Error('invalid_base64url');
  }
  const unpadded = raw.replace(/=+$/g, '');
  const pad = '='.repeat((4 - (unpadded.length % 4)) % 4);
  const out = Buffer.from(unpadded.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
  if (b64urlEncode(out) !== unpadded) throw new Error('invalid_base64url');
  return out;
}

function rawPublicToSpki(publicRaw) {
  if (!Buffer.isBuffer(publicRaw) || publicRaw.length !== 65 || publicRaw[0] !== 0x04) {
    throw new Error('VAPID_PUBLIC_KEY must be 65 raw uncompressed P-256 bytes');
  }
  return Buffer.concat([
    Buffer.from([
      0x30, 0x59,
      0x30, 0x13,
      0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
      0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07,
      0x03, 0x42, 0x00,
    ]),
    publicRaw,
  ]);
}

function subjectLooksSafe(subject) {
  const sub = String(subject || '').trim();
  if (sub.startsWith('mailto:')) return /^mailto:[^@\s]+@[^@\s]+\.[^@\s]+$/i.test(sub);
  if (sub.startsWith('https://')) {
    try {
      const u = new URL(sub);
      return u.protocol === 'https:' && !!u.hostname && !u.username && !u.password;
    } catch (_) {
      return false;
    }
  }
  return false;
}

function verifyVapidKeyPair(publicRaw, privateRaw) {
  try {
    const privateKey = crypto.createPrivateKey({ key: rawPrivateToPkcs8(privateRaw), format: 'der', type: 'pkcs8' });
    const publicKey = crypto.createPublicKey({ key: rawPublicToSpki(publicRaw), format: 'der', type: 'spki' });
    const msg = Buffer.from('kolm-vapid-self-check');
    const sig = crypto.sign('sha256', msg, { key: privateKey, dsaEncoding: 'ieee-p1363' });
    return crypto.verify('sha256', msg, { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig);
  } catch (_) {
    return false;
  }
}

export function validateVapidConfig(env = process.env) {
  const errors = [];
  const publicKeyText = String(env.VAPID_PUBLIC_KEY || '').trim();
  const privateKeyText = String(env.VAPID_PRIVATE_KEY || '').trim();
  const subject = String(env.VAPID_SUBJECT || '').trim();
  let publicRaw = null;
  let privateRaw = null;

  if (!publicKeyText) errors.push('VAPID_PUBLIC_KEY_required');
  else {
    try { publicRaw = b64urlDecode(publicKeyText); }
    catch (_) { errors.push('VAPID_PUBLIC_KEY_invalid_base64url'); }
    if (publicRaw && (publicRaw.length !== 65 || publicRaw[0] !== 0x04)) {
      errors.push('VAPID_PUBLIC_KEY_must_be_uncompressed_p256');
    }
  }

  if (!privateKeyText) errors.push('VAPID_PRIVATE_KEY_required');
  else {
    try { privateRaw = b64urlDecode(privateKeyText); }
    catch (_) { errors.push('VAPID_PRIVATE_KEY_invalid_base64url'); }
    if (privateRaw && privateRaw.length !== 32) errors.push('VAPID_PRIVATE_KEY_must_be_32_bytes');
    if (privateRaw && privateRaw.every((b) => b === 0)) errors.push('VAPID_PRIVATE_KEY_must_be_nonzero');
  }

  if (!subject) errors.push('VAPID_SUBJECT_required');
  else if (!subjectLooksSafe(subject)) errors.push('VAPID_SUBJECT_must_be_mailto_or_https');

  if (publicRaw && privateRaw && publicRaw.length === 65 && publicRaw[0] === 0x04 && privateRaw.length === 32) {
    if (!verifyVapidKeyPair(publicRaw, privateRaw)) errors.push('VAPID_KEYPAIR_mismatch');
  }

  return {
    ok: errors.length === 0,
    errors,
    public_key: publicKeyText || null,
    subject: subject || null,
  };
}

export function normalizePushEndpoint(endpoint) {
  let u;
  try { u = new URL(String(endpoint || '')); }
  catch (_) { throw new Error('subscription.endpoint must be a valid URL'); }
  if (u.protocol !== 'https:') throw new Error('subscription.endpoint must be https://');
  if (u.username || u.password) throw new Error('subscription.endpoint must not contain credentials');
  const host = u.hostname.toLowerCase();
  if (!host || host.length > 253 || host.includes('..')) {
    throw new Error('subscription.endpoint hostname must be valid');
  }
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.startsWith('[') || host === 'localhost') {
    throw new Error('subscription.endpoint hostname must be a public push service');
  }
  if (WEBPUSH_ALLOWED_HOSTS.includes(host)) return u.toString();
  if (WEBPUSH_ALLOWED_HOST_SUFFIXES.some((sfx) => host.endsWith(sfx))) return u.toString();
  throw new Error(`subscription.endpoint host ${host} is not an allowed push service`);
}

function normalizeTimeoutMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PUSH_TIMEOUT_MS;
  return Math.max(1, Math.min(MAX_PUSH_TIMEOUT_MS, Math.floor(n)));
}

// Build VAPID JWT for the audience derived from the push endpoint.
// Audience is origin (scheme + host) of endpoint.
export function buildVapidHeader(endpoint, opts = {}) {
  const cfg = validateVapidConfig();
  if (!cfg.ok) {
    const err = new Error('VAPID not configured: ' + cfg.errors.join(','));
    err.code = 'KOLM_E_VAPID_CONFIG';
    err.reasons = cfg.errors;
    throw err;
  }
  const safeEndpoint = normalizePushEndpoint(endpoint);
  const u = new URL(safeEndpoint);
  const aud = `${u.protocol}//${u.host}`;
  const nowMs = Number.isFinite(Number(opts.now_ms)) ? Number(opts.now_ms) : Date.now();
  const exp = Math.floor(nowMs / 1000) + VAPID_TOKEN_TTL_SECONDS;
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = { aud, exp, sub: process.env.VAPID_SUBJECT };
  const headerB64 = b64urlEncode(JSON.stringify(header));
  const payloadB64 = b64urlEncode(JSON.stringify(payload));
  const unsigned = `${headerB64}.${payloadB64}`;
  const privateRaw = b64urlDecode(process.env.VAPID_PRIVATE_KEY);
  // Construct a PKCS#8 key from the raw 32-byte scalar so node:crypto.sign accepts it.
  const pkcs8 = rawPrivateToPkcs8(privateRaw);
  const keyObj = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const sigDer = crypto.sign('sha256', Buffer.from(unsigned), { key: keyObj, dsaEncoding: 'ieee-p1363' });
  const token = `${unsigned}.${b64urlEncode(sigDer)}`;
  return {
    Authorization: `vapid t=${token}, k=${process.env.VAPID_PUBLIC_KEY}`,
  };
}

// Wrap raw 32-byte P-256 private key scalar in the PKCS#8 DER envelope.
// Built by hand because node:crypto can't import a raw scalar directly.
// Format: PrivateKeyInfo with ecPrivateKey(SEQUENCE{ version=1, octetString, [0] params, [1] publicKey }).
// We only emit the minimum required: SEQUENCE { 1, OCTETSTRING(scalar) } inside an OCTETSTRING
// inside a PrivateKeyInfo with the prime256v1 OID.
function rawPrivateToPkcs8(scalar) {
  if (scalar.length !== 32) throw new Error('VAPID_PRIVATE_KEY must be 32 raw bytes (base64url-encoded)');
  // ECPrivateKey(version=1, OCTETSTRING(scalar), [0] EXPLICIT OID prime256v1).
  const ecPrivKeyV1 = Buffer.concat([
    Buffer.from([0x02, 0x01, 0x01]), // INTEGER 1
    Buffer.from([0x04, 0x20]), scalar, // OCTET STRING(32)
    Buffer.from([0xa0, 0x0a, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]), // [0] OID prime256v1
  ]);
  const ecPrivKeyOuter = Buffer.concat([Buffer.from([0x30, ecPrivKeyV1.length]), ecPrivKeyV1]);
  // PrivateKeyInfo = SEQUENCE { version=0, AlgorithmId{ ecPublicKey, prime256v1 }, OCTETSTRING(ecPrivateKey) }
  const algId = Buffer.from([
    0x30, 0x13,
    0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, // OID id-ecPublicKey 1.2.840.10045.2.1
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, // OID prime256v1
  ]);
  const privOctet = Buffer.concat([
    Buffer.from([0x04, ecPrivKeyOuter.length]),
    ecPrivKeyOuter,
  ]);
  const inner = Buffer.concat([Buffer.from([0x02, 0x01, 0x00]), algId, privOctet]); // version 0 + algid + octet
  return Buffer.concat([Buffer.from([0x30, 0x81, inner.length]), inner]);
}

// Send a tickle (empty payload) push to the subscription. Returns
// { ok, status }. 404 / 410 means the subscription is dead and the caller
// should remove it; other failures are best-effort retry candidates.
//
// The payload arg is currently informational (logged but not encrypted +
// shipped). Encrypting requires aes128gcm + ECDH which needs a heavier
// crypto path. The "tickle" approach is enough for the SW's
// "you have new captures, open /captures" notification.
export async function sendWebPush(subscription, _payload, opts = {}) {
  const cfg = validateVapidConfig();
  if (!cfg.ok) return { ok: false, status: 0, error: 'vapid_not_configured', reasons: cfg.errors };
  if (!subscription || !subscription.endpoint) return { ok: false, status: 0, error: 'no_endpoint' };
  let endpoint;
  try {
    endpoint = normalizePushEndpoint(subscription.endpoint);
  } catch (err) {
    return { ok: false, status: 0, error: 'unsafe_endpoint', detail: String(err.message || err) };
  }
  const fetchFn = opts.fetch || globalThis.fetch;
  if (typeof fetchFn !== 'function') return { ok: false, status: 0, error: 'fetch_unavailable' };
  const timeoutMs = normalizeTimeoutMs(opts.timeout_ms);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = {
      ...buildVapidHeader(endpoint, opts),
      TTL: String(DEFAULT_PUSH_TTL_SECONDS),
    };
    const res = await fetchFn(endpoint, {
      method: 'POST',
      headers,
      body: '',
      signal: ctrl.signal,
    });
    return { ok: res.ok, status: res.status, stale_subscription: res.status === 404 || res.status === 410 };
  } catch (err) {
    if (err && err.name === 'AbortError') return { ok: false, status: 0, error: 'webpush_timeout' };
    return { ok: false, status: 0, error: 'webpush_send_failed', detail: String(err.message || err).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}
