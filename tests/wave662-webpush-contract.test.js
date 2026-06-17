// W662 - direct contract for src/webpush.js.
//
// Focus: VAPID key validation, push endpoint SSRF boundaries, signed JWT shape,
// empty tickle payloads, and testable network dispatch without real network IO.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  buildVapidHeader,
  normalizePushEndpoint,
  sendWebPush,
  validateVapidConfig,
  vapidConfigured,
  vapidPublicKey,
} from '../src/webpush.js';

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(text) {
  const s = String(text || '');
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function makeVapidPair(subject = 'mailto:ops@kolm.ai') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const privateJwk = privateKey.export({ format: 'jwk' });
  const publicJwk = publicKey.export({ format: 'jwk' });
  const x = b64urlDecode(publicJwk.x);
  const y = b64urlDecode(publicJwk.y);
  return {
    publicKey,
    privateKey,
    env: {
      VAPID_PUBLIC_KEY: b64urlEncode(Buffer.concat([Buffer.from([0x04]), x, y])),
      VAPID_PRIVATE_KEY: privateJwk.d,
      VAPID_SUBJECT: subject,
    },
  };
}

function installVapidEnv(t, env) {
  const old = {
    VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
    VAPID_SUBJECT: process.env.VAPID_SUBJECT,
  };
  if ('VAPID_PUBLIC_KEY' in env) process.env.VAPID_PUBLIC_KEY = env.VAPID_PUBLIC_KEY;
  else delete process.env.VAPID_PUBLIC_KEY;
  if ('VAPID_PRIVATE_KEY' in env) process.env.VAPID_PRIVATE_KEY = env.VAPID_PRIVATE_KEY;
  else delete process.env.VAPID_PRIVATE_KEY;
  if ('VAPID_SUBJECT' in env) process.env.VAPID_SUBJECT = env.VAPID_SUBJECT;
  else delete process.env.VAPID_SUBJECT;

  t.after(() => {
    for (const [k, v] of Object.entries(old)) {
      if (v == null) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

function parseVapidAuthorization(headerValue) {
  const m = String(headerValue || '').match(/^vapid t=([^,]+), k=(.+)$/);
  assert.ok(m, 'Authorization header must be VAPID token + public key');
  const token = m[1];
  const publicKey = m[2];
  const [headerB64, payloadB64, sigB64] = token.split('.');
  assert.ok(headerB64 && payloadB64 && sigB64, 'JWT must have three parts');
  return {
    token,
    unsigned: `${headerB64}.${payloadB64}`,
    header: JSON.parse(b64urlDecode(headerB64).toString('utf8')),
    payload: JSON.parse(b64urlDecode(payloadB64).toString('utf8')),
    signature: b64urlDecode(sigB64),
    publicKey,
  };
}

test('W662 VAPID config validation requires valid matching P-256 keys and safe subject', (t) => {
  const valid = makeVapidPair();
  assert.equal(validateVapidConfig(valid.env).ok, true);

  const badSubject = validateVapidConfig({ ...valid.env, VAPID_SUBJECT: 'javascript:alert(1)' });
  assert.equal(badSubject.ok, false);
  assert.ok(badSubject.errors.includes('VAPID_SUBJECT_must_be_mailto_or_https'));

  const other = makeVapidPair();
  const mismatch = validateVapidConfig({ ...valid.env, VAPID_PUBLIC_KEY: other.env.VAPID_PUBLIC_KEY });
  assert.equal(mismatch.ok, false);
  assert.ok(mismatch.errors.includes('VAPID_KEYPAIR_mismatch'));

  const malformed = validateVapidConfig({
    VAPID_PUBLIC_KEY: 'not base64url!',
    VAPID_PRIVATE_KEY: b64urlEncode(Buffer.alloc(31, 1)),
    VAPID_SUBJECT: 'mailto:ops@kolm.ai',
  });
  assert.equal(malformed.ok, false);
  assert.ok(malformed.errors.includes('VAPID_PUBLIC_KEY_invalid_base64url'));
  assert.ok(malformed.errors.includes('VAPID_PRIVATE_KEY_must_be_32_bytes'));

  installVapidEnv(t, valid.env);
  assert.equal(vapidConfigured(), true);
  assert.equal(vapidPublicKey(), valid.env.VAPID_PUBLIC_KEY);
});

test('W662 push endpoint normalization allows known services and rejects direct-call SSRF shapes', () => {
  assert.equal(
    normalizePushEndpoint('https://fcm.googleapis.com/fcm/send/abc'),
    'https://fcm.googleapis.com/fcm/send/abc',
  );
  assert.equal(
    normalizePushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc'),
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
  );
  assert.equal(
    normalizePushEndpoint('https://edge.notify.windows.com/w/?token=abc'),
    'https://edge.notify.windows.com/w/?token=abc',
  );

  for (const endpoint of [
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://localhost/fcm/send/abc',
    'https://169.254.169.254/latest/meta-data',
    'https://user:pass@fcm.googleapis.com/fcm/send/abc',
    'https://push.example.com/fcm/send/abc',
  ]) {
    assert.throws(() => normalizePushEndpoint(endpoint), /endpoint|allowed push service|https|credentials/i, endpoint);
  }
});

test('W662 VAPID header has signed ES256 JWT with endpoint-origin audience', (t) => {
  const pair = makeVapidPair('https://kolm.ai/security');
  installVapidEnv(t, pair.env);

  const headers = buildVapidHeader('https://fcm.googleapis.com/fcm/send/device-token', {
    now_ms: 1_700_000_000_000,
  });
  const parsed = parseVapidAuthorization(headers.Authorization);
  assert.deepEqual(parsed.header, { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(parsed.payload, {
    aud: 'https://fcm.googleapis.com',
    exp: 1_700_000_000 + (12 * 3600),
    sub: 'https://kolm.ai/security',
  });
  assert.equal(parsed.publicKey, pair.env.VAPID_PUBLIC_KEY);
  assert.equal(parsed.signature.length, 64);
  assert.equal(
    crypto.verify(
      'sha256',
      Buffer.from(parsed.unsigned),
      { key: pair.publicKey, dsaEncoding: 'ieee-p1363' },
      parsed.signature,
    ),
    true,
  );
});

test('W662 sendWebPush refuses unsafe inputs before fetch and reports config gaps', async (t) => {
  installVapidEnv(t, {});
  const missing = await sendWebPush({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc' }, {});
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'vapid_not_configured');
  assert.ok(missing.reasons.includes('VAPID_PUBLIC_KEY_required'));

  const pair = makeVapidPair();
  installVapidEnv(t, pair.env);
  let called = false;
  const unsafe = await sendWebPush(
    { endpoint: 'https://127.0.0.1:6379/internal' },
    { title: 'ignored' },
    { fetch: async () => { called = true; } },
  );
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.error, 'unsafe_endpoint');
  assert.equal(called, false);
});

test('W662 sendWebPush dispatches empty tickle payload and marks stale subscriptions', async (t) => {
  const pair = makeVapidPair();
  installVapidEnv(t, pair.env);
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: calls.length === 1, status: calls.length === 1 ? 201 : 410 };
  };

  const first = await sendWebPush(
    { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' },
    { title: 'must not be sent in plaintext' },
    { fetch, now_ms: 1_700_000_000_000 },
  );
  assert.equal(first.ok, true);
  assert.equal(first.status, 201);
  assert.equal(first.stale_subscription, false);
  assert.equal(calls[0].url, 'https://fcm.googleapis.com/fcm/send/abc');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.body, '');
  assert.equal(calls[0].init.headers.TTL, '86400');
  assert.match(calls[0].init.headers.Authorization, /^vapid t=/);
  parseVapidAuthorization(calls[0].init.headers.Authorization);

  const second = await sendWebPush(
    { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' },
    {},
    { fetch },
  );
  assert.equal(second.ok, false);
  assert.equal(second.status, 410);
  assert.equal(second.stale_subscription, true);
});
