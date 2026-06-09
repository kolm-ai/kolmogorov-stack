// TRACK CRYPTO-STD - JWS (RFC 7515) + SLSA/in-toto DSSE + proof-route shape.
//
// Proves the standards-conformant ALTERNATE representations of a signed kolm
// Agent Security-Review report:
//   * toJwsGeneralJson -> verifyJws roundtrip, and a single-byte payload tamper
//     fails verification.
//   * the OKP JWK export is RFC 8037 shaped (kty:OKP, crv:Ed25519).
//   * toInTotoStatement subject digest equals sha256(canonicalizeReport(report)).
//   * toDsseEnvelope -> verifyDsse roundtrip, with a wrong key + tampered payload
//     failing.
//   * the /v1/transparency-log/proof/:seq route surfaces RFC 9162 fields
//     (leaf_index + tree_size + audit_path + root_hash) at the TOP LEVEL.
//
// Pure in-process - no spawned server. Uses the committed dogfood fixture and
// the default per-machine signer so the asserted bytes track a real report.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { runAudit } from '../src/audit-orchestrator.js';
import {
  buildAndSignReport,
  canonicalizeReport,
} from '../src/attestation-report-builder.js';
import { loadOrCreateDefaultSigner } from '../src/ed25519.js';
import {
  toJwsGeneralJson,
  verifyJws,
  publicJwk,
  reportPublicJwk,
  decodeJwsPayload,
  JWS_ALG,
} from '../src/jws-envelope.js';
import {
  toInTotoStatement,
  toDsseEnvelope,
  verifyDsse,
  IN_TOTO_STATEMENT_TYPE,
  SLSA_PREDICATE_TYPE,
  INTOTO_PAYLOAD_TYPE,
} from '../src/slsa-provenance.js';
import { register } from '../src/transparency-log-routes.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURE = path.join(ROOT, 'examples', 'agent-audit', 'litellm-export.jsonl');

const SIGNER = loadOrCreateDefaultSigner();

function builtReport(opts = {}) {
  const logs = fs.readFileSync(FIXTURE, 'utf8');
  const audit = runAudit(logs, { source: 'litellm' });
  const { envelope } = buildAndSignReport(audit, { subject: 'Helpwise', signer: SIGNER, ...opts });
  return envelope;
}

function sha256hex(str) {
  return crypto.createHash('sha256').update(String(str), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// S4 - JWS (RFC 7515).
// ---------------------------------------------------------------------------
test('toJwsGeneralJson produces a verifiable JWS General JSON serialization', () => {
  const report = builtReport();
  const jws = toJwsGeneralJson(report, SIGNER);

  assert.ok(jws && typeof jws.payload === 'string', 'has a base64url payload');
  assert.ok(Array.isArray(jws.signatures) && jws.signatures.length === 1, 'one signature');
  const sig0 = jws.signatures[0];
  assert.ok(typeof sig0.protected === 'string', 'protected header present');
  assert.ok(typeof sig0.signature === 'string', 'signature present');

  // Protected header decodes to EdDSA + a kid.
  const hdr = JSON.parse(Buffer.from(sig0.protected, 'base64url').toString('utf8'));
  assert.equal(hdr.alg, JWS_ALG, 'alg is EdDSA');
  assert.equal(hdr.alg, 'EdDSA');
  assert.ok(hdr.kid && hdr.kid.length >= 16, 'kid (fingerprint) present');
  assert.equal(hdr.kid, SIGNER.key_fingerprint);

  // Payload is exactly the canonical report bytes.
  assert.equal(decodeJwsPayload(jws), canonicalizeReport(report), 'payload is canonicalizeReport bytes');

  // Roundtrip verifies with the public key (and as a JSON string too).
  assert.equal(verifyJws(jws, SIGNER.publicKey), true, 'JWS verifies with public key');
  assert.equal(verifyJws(JSON.stringify(jws), SIGNER.publicKey), true, 'JWS string form verifies');
});

test('verifyJws fails on a tampered payload', () => {
  const report = builtReport();
  const jws = toJwsGeneralJson(report, SIGNER);

  // Flip a field inside the decoded payload and re-encode - signature no longer
  // covers these bytes.
  const decoded = JSON.parse(decodeJwsPayload(jws));
  decoded.summary = decoded.summary || {};
  decoded.summary.readiness_pct = (Number(decoded.summary.readiness_pct) || 0) + 99;
  const tampered = {
    ...jws,
    payload: Buffer.from(canonicalizeReport(decoded), 'utf8').toString('base64url'),
  };
  assert.equal(verifyJws(tampered, SIGNER.publicKey), false, 'tampered payload does not verify');

  // A flipped signature byte also fails.
  const badSig = JSON.parse(JSON.stringify(jws));
  const sb = Buffer.from(badSig.signatures[0].signature, 'base64url');
  sb[0] = sb[0] ^ 0xff;
  badSig.signatures[0].signature = sb.toString('base64url');
  assert.equal(verifyJws(badSig, SIGNER.publicKey), false, 'tampered signature does not verify');

  // A different key fails.
  const other = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  assert.equal(verifyJws(jws, other.publicKey), false, 'wrong key does not verify');

  // Never throws on garbage.
  assert.equal(verifyJws(null, SIGNER.publicKey), false);
  assert.equal(verifyJws('not json', SIGNER.publicKey), false);
  assert.equal(verifyJws(jws, ''), false);
});

test('OKP JWK export is RFC 8037 shaped', () => {
  const report = builtReport();
  const jwk = publicJwk(SIGNER.publicKey, SIGNER.key_fingerprint);
  assert.equal(jwk.kty, 'OKP');
  assert.equal(jwk.crv, 'Ed25519');
  assert.equal(jwk.alg, 'EdDSA');
  assert.equal(jwk.use, 'sig');
  assert.ok(typeof jwk.x === 'string' && jwk.x.length > 0, 'x is the raw public key (base64url)');
  assert.equal(jwk.kid, SIGNER.key_fingerprint);

  const fromReport = reportPublicJwk(report);
  assert.equal(fromReport.kty, 'OKP');
  assert.equal(fromReport.crv, 'Ed25519');
  assert.equal(fromReport.x, jwk.x, 'report-embedded key matches the signer key');
  assert.equal(reportPublicJwk({}), null, 'no key -> null');
});

// ---------------------------------------------------------------------------
// S5 - in-toto Statement + SLSA provenance + DSSE.
// ---------------------------------------------------------------------------
test('toInTotoStatement subject digest matches the canonical report digest', () => {
  const report = builtReport();
  const stmt = toInTotoStatement(report);

  assert.equal(stmt._type, IN_TOTO_STATEMENT_TYPE);
  assert.equal(stmt.predicateType, SLSA_PREDICATE_TYPE);
  assert.ok(Array.isArray(stmt.subject) && stmt.subject.length === 1, 'one subject');

  const subj = stmt.subject[0];
  assert.equal(subj.name, report.report_id, 'subject names the report_id');
  const expected = sha256hex(canonicalizeReport(report));
  assert.equal(subj.digest.sha256, expected, 'subject digest is sha256(canonicalizeReport(report))');

  // SLSA predicate shape.
  const pred = stmt.predicate;
  assert.equal(pred.runDetails.builder.id, 'https://kolm.ai');
  assert.equal(pred.buildDefinition.buildType, 'https://kolm.ai/asr-audit/v1');
  assert.equal(pred.runDetails.metadata.invocationId, report.report_id);

  // The input-events digest rides as a resolved dependency.
  const dep = pred.buildDefinition.resolvedDependencies.find((d) => d.name === 'audit-events');
  assert.ok(dep, 'audit-events resolved dependency present');
  assert.equal(dep.digest.sha256, report.evidence_digest.value, 'dependency digest is the evidence digest');

  // Never throws on garbage.
  assert.doesNotThrow(() => toInTotoStatement(null));
  assert.doesNotThrow(() => toInTotoStatement('x'));
});

test('toDsseEnvelope -> verifyDsse roundtrip', () => {
  const report = builtReport();
  const stmt = toInTotoStatement(report);
  const env = toDsseEnvelope(stmt, SIGNER);

  assert.equal(env.payloadType, INTOTO_PAYLOAD_TYPE);
  assert.ok(typeof env.payload === 'string', 'base64 payload present');
  assert.ok(Array.isArray(env.signatures) && env.signatures.length === 1, 'one signature');
  assert.equal(env.signatures[0].keyid, SIGNER.key_fingerprint, 'keyid is the fingerprint');

  // Payload base64-decodes back to the exact statement JSON.
  assert.deepEqual(JSON.parse(Buffer.from(env.payload, 'base64').toString('utf8')), stmt);

  assert.equal(verifyDsse(env, SIGNER.publicKey), true, 'DSSE verifies with the public key');

  // Wrong key fails.
  const other = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  assert.equal(verifyDsse(env, other.publicKey), false, 'wrong key does not verify');

  // Tampered payload fails (PAE no longer matches).
  const tampered = { ...env, payload: Buffer.from(JSON.stringify({ ...stmt, _type: 'evil' }), 'utf8').toString('base64') };
  assert.equal(verifyDsse(tampered, SIGNER.publicKey), false, 'tampered payload does not verify');

  // Never throws on garbage.
  assert.equal(verifyDsse(null, SIGNER.publicKey), false);
  assert.equal(verifyDsse(env, ''), false);
  assert.equal(verifyDsse({ payloadType: INTOTO_PAYLOAD_TYPE, payload: 'x', signatures: [] }, SIGNER.publicKey), false);
});

test('toDsseEnvelope without a signer yields an unsigned envelope (never throws)', () => {
  const stmt = toInTotoStatement(builtReport());
  // A signer object with no privateKey forces the unsigned path deterministically
  // without disturbing the default key store.
  const env = toDsseEnvelope(stmt, { privateKey: '', publicKey: '' });
  assert.ok(Array.isArray(env.signatures), 'signatures is an array');
});

// ---------------------------------------------------------------------------
// Proof-route polish - top-level RFC 9162 fields.
// ---------------------------------------------------------------------------
function makeRouter() {
  const routes = {};
  const r = {
    get(p, h) { routes[p] = h; return r; },
    _routes: routes,
  };
  return r;
}

function makeRes() {
  const res = {
    _status: 200,
    _json: null,
    setHeader() { return res; },
    status(c) { res._status = c; return res; },
    json(o) { res._json = o; return res; },
  };
  return res;
}

test('proof route surfaces top-level leaf_index + tree_size + audit_path + root_hash', () => {
  // Building + signing a report anchors its digest in the public transparency
  // log, so an entry exists to prove.
  const report = builtReport();
  const seq = (report.log_checkpoint && Number.isInteger(report.log_checkpoint.seq))
    ? report.log_checkpoint.seq
    : 0;

  const r = makeRouter();
  register(r);
  const handler = r._routes['/v1/transparency-log/proof/:seq'];
  assert.equal(typeof handler, 'function', 'proof route registered');

  const res = makeRes();
  handler({ params: { seq: String(seq) }, query: {} }, res);

  assert.equal(res._status, 200, 'proof route 200');
  const body = res._json;
  assert.equal(body.ok, true);

  // Top-level RFC 9162 fields.
  assert.equal(body.leaf_index, seq, 'top-level leaf_index');
  assert.ok(Number.isInteger(body.tree_size) && body.tree_size > seq, 'top-level tree_size');
  assert.ok(Array.isArray(body.audit_path), 'top-level audit_path array');
  assert.ok(/^[0-9a-f]{64}$/i.test(body.root_hash), 'top-level root_hash is 64-hex');
  assert.ok(/^[0-9a-f]{64}$/i.test(body.leaf_hash), 'top-level leaf_hash is 64-hex');

  // Backward-compatible nested copies still present.
  assert.ok(body.proof && body.proof.ok === true, 'nested proof kept');
  assert.equal(body.proof.leaf_index, body.leaf_index, 'nested matches top-level');
  assert.ok(body.checkpoint && typeof body.checkpoint === 'object', 'checkpoint kept');
});
