// tests/wave921-intoto-attestation.test.js
//
// W921 BET-3 — lock-in tests for the in-toto / SLSA / OpenSSF Model-Signing-
// compatible attestation form of a kolm inference receipt:
//   * statement shape valid (in-toto v1 Statement: _type, subject[name,digest],
//     predicateType, predicate)
//   * sign -> verify round-trip (DSSE bundle + OMS bundle)
//   * tamper detected (mutated payload / wrong key / subject-digest mismatch)
//   * register(r, deps) route surface (GET :receipt_id, POST verify)
//
// REUSES the already-tested src/intoto-slsa.js DSSE machinery + src/ed25519.js
// crypto. Vectors are deterministic; no network, no GPU, no external service.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { generateKeyPair, keyFingerprint, verify as ed25519Verify } from '../src/ed25519.js';
import { pae, INTOTO_DSSE_PAYLOAD_TYPE } from '../src/intoto-slsa.js';
import {
  toInTotoStatement,
  signInTotoBundle,
  toOmsBundle,
  verifyInTotoBundle,
  receiptSubjects,
  buildInferencePredicate,
  canonicalReceiptForDigest,
  INTOTO_STATEMENT_TYPE,
  KOLM_INFERENCE_PREDICATE_TYPE,
  OMS_SIGNATURE_PREDICATE_TYPE,
  KOLM_INFERENCE_CONFORMANCE,
  INTOTO_RECEIPT_VERSION,
} from '../src/intoto-receipt.js';
import {
  register as registerIntotoRoutes,
  INTOTO_RECEIPT_ROUTES_VERSION,
} from '../src/intoto-receipt-routes.js';

function freshSigner() {
  const { publicKey, privateKey } = generateKeyPair();
  return { publicKey, privateKey, key_fingerprint: keyFingerprint(publicKey) };
}

// A realistic kolm-audit-1 receipt (signature block included so we exercise the
// signature_meta path). The hashes use the truncated `sha256:<hex>` short form
// the gateway actually emits.
function sampleReceipt(overrides = {}) {
  return {
    schema: 'kolm-audit-1',
    receipt_id: 'rcpt_01HXYZABCDEFGHJKMNPQRS',
    timestamp: '2026-05-29T12:00:00.000Z',
    namespace_id: 'ns_support',
    route_decision: 'frontier',
    provider: 'anthropic',
    model: 'claude-opus-4-8',
    artifact_id: null,
    confidence: 0.91,
    fallback_reason: null,
    input_hash: 'sha256:' + crypto.createHash('sha256').update('hello').digest('hex').slice(0, 32),
    output_hash: 'sha256:' + crypto.createHash('sha256').update('world').digest('hex').slice(0, 32),
    capture_eligible: true,
    capture_id: 'cap_1',
    redaction_applied: ['email'],
    input_tokens: 12,
    output_tokens: 34,
    cost_usd: 0.0012,
    signing_key_id: 'kf_abc',
    verify_url: 'https://kolm.ai/v1/verify/rcpt_01HXYZABCDEFGHJKMNPQRS',
    signature_ed25519: { alg: 'ed25519', key_fingerprint: 'kf_abc', signed_at: '2026-05-29T12:00:00.000Z', signature: 'AAAA' },
    ...overrides,
  };
}

// ===========================================================================
// Statement shape
// ===========================================================================

test('statement: toInTotoStatement emits a well-formed in-toto v1 Statement', () => {
  const stmt = toInTotoStatement(sampleReceipt());
  assert.equal(stmt._type, INTOTO_STATEMENT_TYPE);
  assert.equal(stmt._type, 'https://in-toto.io/Statement/v1');
  assert.equal(stmt.predicateType, KOLM_INFERENCE_PREDICATE_TYPE);
  assert.ok(stmt.predicate && typeof stmt.predicate === 'object');
  // subject is a non-empty array, each with a non-empty sha256 digest.
  assert.ok(Array.isArray(stmt.subject) && stmt.subject.length >= 1);
  for (const s of stmt.subject) {
    assert.equal(typeof s.name, 'string');
    assert.ok(s.name.length > 0);
    assert.ok(s.digest && typeof s.digest.sha256 === 'string');
    assert.match(s.digest.sha256, /^[0-9a-f]+$/);
  }
});

test('statement: receipt subject digest is a FULL 64-hex sha256 of the canonical receipt', () => {
  const r = sampleReceipt();
  const subjects = receiptSubjects(r);
  const receiptSubj = subjects.find((s) => s.name === `receipt:${r.receipt_id}`);
  assert.ok(receiptSubj);
  assert.equal(receiptSubj.digest.sha256.length, 64);
  assert.equal(receiptSubj.digest.blake2b.length, 128);
  // Recompute independently from the canonical (signature-stripped) receipt.
  const expected = crypto.createHash('sha256').update(canonicalReceiptForDigest(r), 'utf8').digest('hex');
  const expectedBlake = crypto.createHash('blake2b512').update(canonicalReceiptForDigest(r), 'utf8').digest('hex');
  assert.equal(receiptSubj.digest.sha256, expected);
  assert.equal(receiptSubj.digest.blake2b, expectedBlake);
});

test('statement: an output subject carries the receipt output_hash hex', () => {
  const r = sampleReceipt();
  const subjects = receiptSubjects(r);
  const outSubj = subjects.find((s) => s.name === `output:${r.receipt_id}`);
  assert.ok(outSubj, 'output subject present when output_hash exists');
  const outHex = r.output_hash.replace(/^sha256:/, '');
  assert.equal(outSubj.digest.sha256, outHex);
  assert.equal(outSubj.digest.blake2b, undefined, 'do not fabricate BLAKE2b without output bytes');
});

test('statement: canonical receipt digest excludes the signature blocks (seal does not cover itself)', () => {
  const a = sampleReceipt();
  const b = sampleReceipt({ signature_ed25519: { alg: 'ed25519', signature: 'DIFFERENT', key_fingerprint: 'kf_abc' } });
  // The two receipts differ ONLY in the signature block -> same subject digest.
  assert.equal(canonicalReceiptForDigest(a), canonicalReceiptForDigest(b));
  assert.equal(receiptSubjects(a)[0].digest.sha256, receiptSubjects(b)[0].digest.sha256);
});

test('statement: predicate restates the receipt claims (provider/model/route/cost) and never fabricates', () => {
  const pred = buildInferencePredicate(sampleReceipt());
  assert.equal(pred.inference.provider, 'anthropic');
  assert.equal(pred.inference.model, 'claude-opus-4-8');
  assert.equal(pred.inference.route_decision, 'frontier');
  assert.equal(pred.inference.cost_usd, 0.0012);
  assert.equal(pred.conformance, KOLM_INFERENCE_CONFORMANCE);
  // signature_meta carries the fingerprint but NOT the raw signature bytes.
  assert.equal(pred.signature_meta.key_fingerprint, 'kf_abc');
  assert.ok(!('signature' in pred.signature_meta));
  // a receipt without a given field does not produce that key.
  const sparse = buildInferencePredicate({ schema: 'kolm-audit-1', receipt_id: 'rcpt_xxxxxxxxxxxxxxxxxxxxxx' });
  assert.ok(!('provider' in sparse.inference));
  assert.equal(sparse.signature_meta, null);
});

test('statement: toInTotoStatement throws on a non-object receipt', () => {
  assert.throws(() => toInTotoStatement(null));
  assert.throws(() => toInTotoStatement('nope'));
});

// ===========================================================================
// Sign -> verify round-trip
// ===========================================================================

test('roundtrip: signInTotoBundle -> verifyInTotoBundle ok with the matching key', () => {
  const signer = freshSigner();
  const signed = signInTotoBundle(sampleReceipt(), signer);
  assert.equal(signed.predicateType, KOLM_INFERENCE_PREDICATE_TYPE);
  assert.equal(signed.envelope.payloadType, INTOTO_DSSE_PAYLOAD_TYPE);
  const v = verifyInTotoBundle(signed.bundle, { publicKey: signer.publicKey });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.predicateType, KOLM_INFERENCE_PREDICATE_TYPE);
  assert.equal(v.statement._type, INTOTO_STATEMENT_TYPE);
  assert.equal(v.key_fingerprint, keyFingerprint(signer.publicKey));
});

test('roundtrip: verify also works on the bare DSSE envelope (not just the bundle)', () => {
  const signer = freshSigner();
  const signed = signInTotoBundle(sampleReceipt(), signer);
  const v = verifyInTotoBundle(signed.envelope, { publicKey: signer.publicKey });
  assert.equal(v.ok, true, v.reason);
});

test('roundtrip: bundle carries an embedded key so verify works trust-on-first-use', () => {
  const signer = freshSigner();
  const signed = signInTotoBundle(sampleReceipt(), signer);
  // PEM + RFC 8037 OKP JWK both embedded.
  assert.equal(signed.bundle.verificationMaterial.publicKey.pem, signer.publicKey);
  const jwk = signed.bundle.verificationMaterial.publicKey.jwk;
  assert.equal(jwk.kty, 'OKP');
  assert.equal(jwk.crv, 'Ed25519');
  assert.equal(jwk.alg, 'EdDSA');
  // verify with NO explicit key falls back to the embedded one and flags it.
  const v = verifyInTotoBundle(signed.bundle);
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.key_from_bundle, true);
});

test('roundtrip: the DSSE signature is computed over PAE bytes (cross-tooling interop)', () => {
  const signer = freshSigner();
  const signed = signInTotoBundle(sampleReceipt(), signer);
  const env = signed.envelope;
  const payloadBytes = Buffer.from(env.payload, 'base64');
  const paeBytes = pae(env.payloadType, payloadBytes);
  // Convert the standard-base64 DSSE sig back to base64url for ed25519.verify.
  const sigB64Url = Buffer.from(env.signatures[0].sig, 'base64').toString('base64url');
  assert.equal(ed25519Verify(signer.publicKey, paeBytes, sigB64Url), true);
  // The payload decodes to the exact Statement.
  const decoded = JSON.parse(payloadBytes.toString('utf8'));
  assert.equal(decoded._type, INTOTO_STATEMENT_TYPE);
});

test('roundtrip: subjectDigestMap content check passes for the real bytes', () => {
  const signer = freshSigner();
  const r = sampleReceipt();
  const signed = signInTotoBundle(r, signer);
  const receiptDigest = crypto.createHash('sha256').update(canonicalReceiptForDigest(r), 'utf8').digest('hex');
  const receiptBlake = crypto.createHash('blake2b512').update(canonicalReceiptForDigest(r), 'utf8').digest('hex');
  const outHex = r.output_hash.replace(/^sha256:/, '');
  const dm = {
    [`receipt:${r.receipt_id}`]: { sha256: receiptDigest, blake2b: receiptBlake },
    [`output:${r.receipt_id}`]: { sha256: outHex },
  };
  const v = verifyInTotoBundle(signed.bundle, { publicKey: signer.publicKey, subjectDigestMap: dm });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.subjects_matched, v.subjects_total);
});

test('roundtrip: OMS bundle uses the OpenSSF model-signing predicateType and verifies', () => {
  const signer = freshSigner();
  const bundle = toOmsBundle(sampleReceipt(), signer);
  const v = verifyInTotoBundle(bundle, { publicKey: signer.publicKey });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.predicateType, OMS_SIGNATURE_PREDICATE_TYPE);
  assert.equal(v.predicateType, 'https://model_signing/signature/v1.0');
  // The bundle is the Sigstore-bundle-shaped detached form.
  assert.match(bundle.mediaType, /sigstore\.bundle/);
});

test('roundtrip: OMS predicate is a manifest of (name, digest) resources', () => {
  const signer = freshSigner();
  const bundle = toOmsBundle(sampleReceipt(), signer);
  const stmt = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
  assert.ok(Array.isArray(stmt.predicate.resources));
  for (const res of stmt.predicate.resources) {
    assert.equal(typeof res.name, 'string');
    assert.ok(res.digest && typeof res.digest.sha256 === 'string');
  }
});

// ===========================================================================
// Tamper detection
// ===========================================================================

test('tamper: a wrong public key fails verification', () => {
  const a = freshSigner();
  const b = freshSigner();
  const signed = signInTotoBundle(sampleReceipt(), a);
  const v = verifyInTotoBundle(signed.envelope, { publicKey: b.publicKey });
  assert.equal(v.ok, false);
});

test('tamper: mutating one payload byte fails the signature', () => {
  const signer = freshSigner();
  const signed = signInTotoBundle(sampleReceipt(), signer);
  // flip a byte in the base64 payload by decoding, mutating, re-encoding.
  const raw = Buffer.from(signed.envelope.payload, 'base64');
  raw[10] ^= 0xff;
  const tampered = { ...signed.envelope, payload: raw.toString('base64') };
  const v = verifyInTotoBundle(tampered, { publicKey: signer.publicKey });
  assert.equal(v.ok, false);
});

test('tamper: a subject-digest mismatch is detected as content tamper', () => {
  const signer = freshSigner();
  const r = sampleReceipt();
  const signed = signInTotoBundle(r, signer);
  // claim a DIFFERENT output digest than the Statement carries.
  const receiptDigest = crypto.createHash('sha256').update(canonicalReceiptForDigest(r), 'utf8').digest('hex');
  const dm = {
    [`receipt:${r.receipt_id}`]: receiptDigest,
    [`output:${r.receipt_id}`]: 'f'.repeat(64), // wrong
  };
  const v = verifyInTotoBundle(signed.bundle, { publicKey: signer.publicKey, subjectDigestMap: dm });
  assert.equal(v.ok, false);
  assert.ok(v.subjects_matched < v.subjects_total);
});

test('tamper: replacing the embedded bundle key with a non-signing key fails', () => {
  const signer = freshSigner();
  const attacker = freshSigner();
  const signed = signInTotoBundle(sampleReceipt(), signer);
  // attacker swaps in their own key but keeps the original (signer-signed) envelope.
  const forged = {
    ...signed.bundle,
    verificationMaterial: { ...signed.bundle.verificationMaterial, publicKey: { ...signed.bundle.verificationMaterial.publicKey, pem: attacker.publicKey } },
  };
  const v = verifyInTotoBundle(forged); // uses the embedded (attacker) key
  assert.equal(v.ok, false);
});

test('tamper: verifyInTotoBundle never throws on garbage and requires a key', () => {
  assert.doesNotThrow(() => verifyInTotoBundle(null));
  assert.equal(verifyInTotoBundle(null).ok, false);
  assert.equal(verifyInTotoBundle({}).ok, false);
  assert.equal(verifyInTotoBundle({ dsseEnvelope: {} }).ok, false); // no key
});

// ===========================================================================
// register(r, deps) route surface
// ===========================================================================

function mockRouter() {
  const routes = {};
  const add = (m) => (p, h) => { routes[`${m} ${p}`] = h; };
  return {
    routes,
    get: add('GET'), post: add('POST'),
    call(method, path, req) {
      const h = routes[`${method} ${path}`];
      if (!h) throw new Error(`no route ${method} ${path}`);
      const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
      h(req, res);
      return res;
    },
  };
}

test('routes: register mounts exactly the two intoto routes', () => {
  const r = mockRouter();
  registerIntotoRoutes(r, {});
  assert.equal(Object.keys(r.routes).length, 2);
  assert.ok(r.routes['GET /v1/govern/intoto/:receipt_id']);
  assert.ok(r.routes['POST /v1/govern/intoto/verify']);
});

test('routes: every route 401s without a tenant_record', () => {
  const r = mockRouter();
  registerIntotoRoutes(r, {});
  const a = r.call('GET', '/v1/govern/intoto/:receipt_id', { params: { receipt_id: 'rcpt_x' }, query: {} });
  assert.equal(a.code, 401);
  assert.equal(a.body.error, 'auth_required');
  const b = r.call('POST', '/v1/govern/intoto/verify', { body: {} });
  assert.equal(b.code, 401);
});

test('routes: GET resolves a receipt via the injectable resolver + returns a signed bundle', () => {
  const r = mockRouter();
  const signer = freshSigner();
  const receipt = sampleReceipt();
  registerIntotoRoutes(r, {
    getSigner: () => signer,
    getReceipt: ({ tenant_id, receipt_id }) => (receipt_id === receipt.receipt_id ? receipt : null),
  });
  const res = r.call('GET', '/v1/govern/intoto/:receipt_id', {
    tenant_record: { id: 't1' }, params: { receipt_id: receipt.receipt_id }, query: {},
  });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.signed, true);
  assert.equal(res.body.statement._type, INTOTO_STATEMENT_TYPE);
  // the returned bundle verifies.
  const v = verifyInTotoBundle(res.body.bundle, { publicKey: signer.publicKey });
  assert.equal(v.ok, true, v.reason);
});

test('routes: GET ?format=oms returns an OMS-shaped bundle', () => {
  const r = mockRouter();
  const signer = freshSigner();
  const receipt = sampleReceipt();
  registerIntotoRoutes(r, { getSigner: () => signer, getReceipt: () => receipt });
  const res = r.call('GET', '/v1/govern/intoto/:receipt_id', {
    tenant_record: { id: 't1' }, params: { receipt_id: receipt.receipt_id }, query: { format: 'oms' },
  });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.format, 'oms');
  const v = verifyInTotoBundle(res.body.bundle, { publicKey: signer.publicKey });
  assert.equal(v.ok, true);
  assert.equal(v.predicateType, OMS_SIGNATURE_PREDICATE_TYPE);
});

test('routes: GET returns the unsigned Statement when no signer is configured', () => {
  const r = mockRouter();
  const receipt = sampleReceipt();
  registerIntotoRoutes(r, { getReceipt: () => receipt });
  const res = r.call('GET', '/v1/govern/intoto/:receipt_id', {
    tenant_record: { id: 't1' }, params: { receipt_id: receipt.receipt_id }, query: {},
  });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.signed, false);
  assert.equal(res.body.statement._type, INTOTO_STATEMENT_TYPE);
});

test('routes: GET 404s when the receipt is not found', () => {
  const r = mockRouter();
  registerIntotoRoutes(r, { getReceipt: () => null });
  const res = r.call('GET', '/v1/govern/intoto/:receipt_id', {
    tenant_record: { id: 't1' }, params: { receipt_id: 'rcpt_missing' }, query: {},
  });
  assert.equal(res.code, 404);
  assert.equal(res.body.error, 'receipt_not_found');
});

test('routes: GET resolves via the row-store fallback (findByTenant receipts)', () => {
  const r = mockRouter();
  const signer = freshSigner();
  const receipt = sampleReceipt();
  const store = {
    findByTenant: (kind, tenant) => (kind === 'receipts' && tenant === 't1' ? [{ receipt }] : []),
  };
  registerIntotoRoutes(r, { getSigner: () => signer, store });
  const res = r.call('GET', '/v1/govern/intoto/:receipt_id', {
    tenant_record: { id: 't1' }, params: { receipt_id: receipt.receipt_id }, query: {},
  });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.signed, true);
});

test('routes: POST verify confirms a signed bundle (and the tenant cannot inject a key it does not control)', () => {
  const r = mockRouter();
  const signer = freshSigner();
  registerIntotoRoutes(r, { getSigner: () => signer });
  const signed = signInTotoBundle(sampleReceipt(), signer);
  const ok = r.call('POST', '/v1/govern/intoto/verify', {
    tenant_record: { id: 't1' }, body: { bundle: signed.bundle, public_key: signer.publicKey },
  });
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.verify.ok, true);
  // tamper -> verify.ok false.
  const bad = r.call('POST', '/v1/govern/intoto/verify', {
    tenant_record: { id: 't1' }, body: { bundle: signed.bundle, public_key: freshSigner().publicKey },
  });
  assert.equal(bad.body.ok, true); // route succeeded
  assert.equal(bad.body.verify.ok, false); // but verification failed
});

test('routes: POST verify 400s without a bundle/envelope', () => {
  const r = mockRouter();
  registerIntotoRoutes(r, {});
  const res = r.call('POST', '/v1/govern/intoto/verify', { tenant_record: { id: 't1' }, body: {} });
  assert.equal(res.code, 400);
  assert.equal(res.body.error, 'bundle_or_envelope_required');
});

test('routes: register throws if given a non-router', () => {
  assert.throws(() => registerIntotoRoutes({}, {}));
});

// ===========================================================================
// Version stamps (regression sentinels)
// ===========================================================================
test('versions: module + routes version stamps are w921-shaped', () => {
  assert.match(INTOTO_RECEIPT_VERSION, /^w921-/);
  assert.match(INTOTO_RECEIPT_ROUTES_VERSION, /^w921-/);
});
