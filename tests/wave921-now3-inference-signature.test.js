// W921 NOW-3 — standards-conformant inference signatures. The Ed25519 signing
// key is published as an RFC 8037 OKP JWK at /.well-known/jwks.json, and the
// gateway emits X-Inference-Signature / X-Inference-Key-ID so a third party can
// verify a kolm inference WITHOUT trusting kolm. The JWK must actually verify a
// real kolm signature (round-trip).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPair, sign, publicKeyJwk, keyFingerprint } from '../src/ed25519.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTER = fs.readFileSync(path.join(ROOT, 'src', 'router.js'), 'utf8');

test('#1 publicKeyJwk emits a valid RFC 8037 OKP/Ed25519 JWK with kid=fingerprint', () => {
  const { publicKey } = generateKeyPair();
  const jwk = publicKeyJwk(publicKey);
  assert.equal(jwk.kty, 'OKP');
  assert.equal(jwk.crv, 'Ed25519');
  assert.equal(jwk.use, 'sig');
  assert.equal(jwk.alg, 'EdDSA');
  assert.ok(typeof jwk.x === 'string' && jwk.x.length > 0);
  assert.equal(jwk.kid, keyFingerprint(publicKey));
});

test('#2 round-trip: a key reconstructed from the published JWK verifies a real kolm signature', () => {
  const { publicKey, privateKey } = generateKeyPair();
  const jwk = publicKeyJwk(publicKey);
  const payload = 'kolm-inference-receipt-canonical-string';
  const sigB64Url = sign(privateKey, payload); // kolm's own signer
  // A third party rebuilds the verify key purely from the JWK and checks the sig.
  const pub = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify(null, Buffer.from(payload), pub, Buffer.from(sigB64Url, 'base64url'));
  assert.equal(ok, true, 'the JWKS-published key must verify a kolm Ed25519 signature');
});

test('#3 router exposes /.well-known/jwks.json + emits X-Inference-Signature headers', () => {
  assert.match(ROUTER, /r\.get\('\/\.well-known\/jwks\.json'/, 'JWKS route must be registered');
  assert.match(ROUTER, /ed\.publicKeyJwk\(signer\.publicKey/, 'JWKS must serve the signer JWK');
  assert.match(ROUTER, /res\.set\('X-Inference-Signature', _sig\.signature\)/, 'dispatch must emit X-Inference-Signature');
  assert.match(ROUTER, /res\.set\('X-Inference-Key-ID'/, 'dispatch must emit X-Inference-Key-ID');
});
