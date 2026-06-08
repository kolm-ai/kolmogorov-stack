// tests/crypto-services.test.js
//
// TRACK CRYPTO-SERVICES - the verifiability table-stakes that let a buyer prove
// tampering WITHOUT trusting kolm:
//   M3 RFC 3161 trusted timestamping     (src/rfc3161-timestamp.js)
//   M4 transparency-log read surface     (src/transparency-log-routes.js + .js)
//   M5 issuer-key revocation/rotation    (src/key-revocation.js)
//   verifier-side checks                 (public/kolm-audit-verify.js)
//   crypto routes on the audit surface   (src/audit-routes.js)
//
// Runs fully OFFLINE + deterministic. One guarded test pings a real public TSA
// but only asserts "never throws"; it skips its content assertions when the
// network is unavailable. Run: node --test tests/crypto-services.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// --- isolate state BEFORE any module that touches the store is loaded ---------
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-crypto-svc-'));
process.env.KOLM_DATA_DIR = path.join(SCRATCH, 'data');
process.env.KOLM_STORE_DRIVER = 'json';
process.env.KOLM_RATE_LIMIT_DISABLED = '1';
process.env.KOLM_ED25519_KEY_STORE = path.join(SCRATCH, 'keys');
process.env.ADMIN_KEY = 'admin_secret_for_crypto_services_test';
delete process.env.KOLM_TSA_SELF_ISSUE; // keep the offline contract exact
fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });

// --- dynamic imports (after env is set) ---------------------------------------
const rfc3161 = await import('../src/rfc3161-timestamp.js');
const tlog = await import('../src/transparency-log.js');
const tlogRoutes = await import('../src/transparency-log-routes.js');
const keyrev = await import('../src/key-revocation.js');
const ed = await import('../src/ed25519.js');
const reportBuilder = await import('../src/attestation-report-builder.js');
const auditRoutes = await import('../src/audit-routes.js');
const verifier = await import('../public/kolm-audit-verify.js');

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');

// =============================================================================
// Tiny in-process router harness (Express-shaped get/post + :params + query).
// =============================================================================
function makeRouter() {
  const routes = [];
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const compile = (p) => {
    const keys = [];
    const parts = p.split('/').map((seg) => {
      if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)'; }
      return escape(seg);
    });
    return { keys, regex: new RegExp('^' + parts.join('/') + '$') };
  };
  const add = (method) => (p, handler) => { const c = compile(p); routes.push({ method, ...c, handler }); };
  function invoke(handler, req) {
    return new Promise((resolve) => {
      const res = {
        statusCode: 200, headers: {},
        setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
        removeHeader(k) { delete this.headers[k.toLowerCase()]; },
        set() { return this; },
        status(c) { this.statusCode = c; return this; },
        json(o) { resolve({ status: this.statusCode, body: o, headers: this.headers }); return this; },
        send(x) { resolve({ status: this.statusCode, body: x, headers: this.headers }); return this; },
      };
      Promise.resolve(handler(req, res)).catch((e) => resolve({ status: 500, body: { ok: false, error: 'threw', detail: e && e.message } }));
    });
  }
  return {
    get: add('GET'), post: add('POST'),
    async call(method, url, { body = null, headers = {} } = {}) {
      const [pathOnly, qs = ''] = String(url).split('?');
      const query = Object.fromEntries(new URLSearchParams(qs));
      for (const rt of routes) {
        if (rt.method !== method) continue;
        const m = rt.regex.exec(pathOnly);
        if (!m) continue;
        const params = {};
        rt.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        const req = { method, path: pathOnly, params, query, body, headers, ip: '127.0.0.1', socket: { remoteAddress: '127.0.0.1' } };
        return invoke(rt.handler, req);
      }
      return { status: 404, body: { ok: false, error: 'no_route' }, headers: {} };
    },
  };
}

// =============================================================================
// M3 - RFC 3161 trusted timestamping
// =============================================================================
test('M3 timestampDigest: invalid digest -> offline, never throws', async () => {
  const ev = await rfc3161.timestampDigest('not-a-sha256');
  assert.equal(ev.status, 'offline');
  assert.equal(ev.alg, 'sha256');
  assert.equal(ev.token_b64, null);
  assert.equal(ev.timestamp, null);
});

test('M3 timestampDigest: unreachable TSA -> offline, never throws', async () => {
  const digest = sha256hex('unreachable-tsa');
  const ev = await rfc3161.timestampDigest(digest, { tsaUrl: 'http://127.0.0.1:9/tsr', timeoutMs: 1500 });
  assert.equal(ev.status, 'offline');
  assert.equal(ev.message_imprint, digest);
  assert.equal(ev.tsa_url, 'http://127.0.0.1:9/tsr');
  assert.ok(typeof ev.reason === 'string' && ev.reason.length > 0);
});

test('M3 selfIssueTimestamp + verifyTimestamp: full offline roundtrip', () => {
  const digest = sha256hex('roundtrip-payload');
  const ev = rfc3161.selfIssueTimestamp(digest);
  assert.equal(ev.status, 'timestamped');
  assert.equal(ev.source, 'self');
  assert.equal(ev.message_imprint, digest);
  assert.ok(ev.token_b64 && ev.timestamp);

  const v = rfc3161.verifyTimestamp(ev, digest);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.signature_verified, true);
  assert.equal(v.genTime, ev.timestamp);
  // self-check (omit digest -> uses message_imprint)
  assert.equal(rfc3161.verifyTimestamp(ev).ok, true);
});

test('M3 verifyTimestamp: wrong digest, offline evidence, tampered token all fail cleanly', () => {
  const digest = sha256hex('payload-A');
  const ev = rfc3161.selfIssueTimestamp(digest);

  // wrong digest
  const wrong = rfc3161.verifyTimestamp(ev, sha256hex('payload-B'));
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, 'imprint_mismatch');

  // offline evidence
  const off = { alg: 'sha256', message_imprint: digest, timestamp: null, token_b64: null, tsa_url: 'x', status: 'offline' };
  const vo = rfc3161.verifyTimestamp(off, digest);
  assert.equal(vo.ok, false);
  assert.equal(vo.reason, 'not_timestamped');

  // tampered token (flip a byte in the signature region) -> hard fail
  const tk = Buffer.from(ev.token_b64, 'base64');
  tk[tk.length - 5] ^= 0xff;
  const tampered = { ...ev, token_b64: tk.toString('base64') };
  const vt = rfc3161.verifyTimestamp(tampered, digest);
  assert.equal(vt.ok, false);
  assert.equal(vt.signature_verified, false);

  // garbage input never throws
  assert.equal(rfc3161.verifyTimestamp(null, digest).ok, false);
  assert.equal(rfc3161.verifyTimestamp({ status: 'timestamped', message_imprint: digest, token_b64: 'zzzz' }, digest).ok, false);
});

test('M3 real public TSA (network-guarded): never throws; verifies if reachable', async () => {
  const digest = sha256hex('real-tsa-' + Date.now());
  let ev;
  try { ev = await rfc3161.timestampDigest(digest, { timeoutMs: 4000 }); }
  catch (e) { assert.fail('timestampDigest threw: ' + (e && e.message)); }
  assert.ok(ev && (ev.status === 'timestamped' || ev.status === 'offline'));
  if (ev.status === 'timestamped') {
    assert.equal(ev.message_imprint, digest);
    const v = rfc3161.verifyTimestamp(ev, digest);
    assert.equal(v.ok, true, 'real TSA token should verify: ' + JSON.stringify(v));
  }
});

// =============================================================================
// M4 - transparency log: append -> size/entries/proof/checkpoint roundtrip
// =============================================================================
test('M4 transparency log routes: append, size, entries, inclusion proof, checkpoints', async () => {
  tlog._resetTransparencyLogsForTests();
  const r = makeRouter();
  tlogRoutes.register(r);

  // empty log
  let res = await r.call('GET', '/v1/transparency-log/size');
  assert.equal(res.status, 200);
  assert.equal(res.body.tree_size, 0);

  // append a handful of public entries via the exported service
  const seeded = [];
  for (let i = 0; i < 5; i++) {
    const out = tlogRoutes.recordTransparencyEntry({ kind: 'report_anchor', data: { report_id: 'r' + i, digest: sha256hex('r' + i) } });
    assert.equal(out.ok, true);
    seeded.push(out.entry);
  }

  res = await r.call('GET', '/v1/transparency-log/size');
  assert.equal(res.body.tree_size, 5);
  assert.match(res.body.root_hash, /^[0-9a-f]{64}$/);

  // single entry
  res = await r.call('GET', '/v1/transparency-log/entries/2');
  assert.equal(res.status, 200);
  assert.equal(res.body.entry.seq, 2);
  assert.equal(res.body.entry.data.report_id, 'r2');

  // out of range
  res = await r.call('GET', '/v1/transparency-log/entries/99');
  assert.equal(res.status, 404);

  // page
  res = await r.call('GET', '/v1/transparency-log/entries?start=1&end=4');
  assert.equal(res.status, 200);
  assert.equal(res.body.count, 3);
  assert.equal(res.body.entries[0].seq, 1);

  // inclusion proof for seq 3, verified OFFLINE against the signed checkpoint
  res = await r.call('GET', '/v1/transparency-log/proof/3');
  assert.equal(res.status, 200);
  const { proof, checkpoint } = res.body;
  assert.equal(proof.leaf_index, 3);
  const incl = tlog.verifyInclusionProof(proof);
  assert.equal(incl.ok, true, JSON.stringify(incl));
  // proof root must equal the checkpoint root
  assert.equal(proof.root_hash, checkpoint.root_hash);

  // checkpoint signature verifies offline (signer is the cached Ed25519 key)
  const sig = tlog.verifyTreeHeadSignature(checkpoint);
  assert.equal(sig.ok, true, JSON.stringify(sig));

  // bind the proof to the SIGNED checkpoint in one call
  const bound = tlog.verifyInclusionProof(proof, { signedTreeHead: checkpoint });
  assert.equal(bound.ok, true, JSON.stringify(bound));
  assert.ok(bound.checkpoint && bound.checkpoint.verified === true);

  // checkpoints/latest + history
  res = await r.call('GET', '/v1/transparency-log/checkpoints/latest');
  assert.equal(res.status, 200);
  assert.equal(res.body.checkpoint.tree_size, 5);

  res = await r.call('GET', '/v1/transparency-log/checkpoints');
  assert.equal(res.status, 200);
  assert.ok(res.body.count >= 1);
  assert.ok(res.body.checkpoints.every((c) => /^[0-9a-f]{64}$/.test(c.root_hash)));
});

test('M4 witness co-sign hook: a configured witness counter-signs the checkpoint', async () => {
  tlog._resetTransparencyLogsForTests();
  const r = makeRouter();
  tlogRoutes.register(r);
  tlogRoutes.recordTransparencyEntry({ kind: 'report_anchor', data: { report_id: 'w0' } });

  const kp = ed.generateKeyPair();
  const witness = { ...kp, key_fingerprint: ed.keyFingerprint(kp.publicKey) };
  tlog.setTransparencyWitness(witness);
  try {
    const res = await r.call('GET', '/v1/transparency-log/checkpoints/latest');
    const checkpoint = res.body.checkpoint;
    assert.ok(Array.isArray(checkpoint.witnesses) && checkpoint.witnesses.length === 1);
    const ver = tlog.verifyCosignedTreeHead(checkpoint, { witnessKeys: [witness.publicKey] });
    assert.equal(ver.ok, true, JSON.stringify(ver));
    assert.equal(ver.witnesses[0].ok, true);
    // a wrong pinned witness key is rejected
    const wrong = tlog.verifyCosignedTreeHead(checkpoint, { witnessKeys: [ed.generateKeyPair().publicKey] });
    assert.equal(wrong.ok, false);
  } finally {
    tlog.setTransparencyWitness(null);
  }
});

// =============================================================================
// M5 - issuer-key revocation + rotation
// =============================================================================
test('M5 key-revocation: default live, revoke -> revoked, rotate -> rotated', () => {
  keyrev._resetKeyStatusForTests();
  const fp = crypto.randomBytes(16).toString('hex'); // 32 hex chars

  // unknown key defaults to live + valid
  let st = keyrev.status(fp);
  assert.equal(st.status, 'live');
  assert.equal(st.valid, true);
  assert.equal(keyrev.isRevoked(fp), false);

  // revoke
  st = keyrev.revoke(fp, 'compromised in test');
  assert.equal(st.status, 'revoked');
  assert.equal(st.valid, false);
  assert.equal(st.reason, 'compromised in test');
  assert.ok(st.revoked_at);
  assert.equal(keyrev.isRevoked(fp), true);

  // idempotent: re-revoke keeps the original timestamp
  const again = keyrev.revoke(fp, 'second reason');
  assert.equal(again.revoked_at, st.revoked_at);

  // refusing to rotate a revoked key
  assert.throws(() => keyrev.rotateKey({ old_fp: fp, new_fp: crypto.randomBytes(16).toString('hex') }));

  // rotation of a clean key: old -> rotated (still valid), new -> live
  const oldFp = crypto.randomBytes(16).toString('hex');
  const newFp = crypto.randomBytes(16).toString('hex');
  const rot = keyrev.rotateKey({ old_fp: oldFp, new_fp: newFp, reason: 'routine' });
  assert.equal(rot.rotated.status, 'rotated');
  assert.equal(rot.rotated.valid, true); // rotation is not compromise
  assert.equal(rot.live.status, 'live');
  assert.equal(keyrev.isRevoked(oldFp), false);
});

// =============================================================================
// Integration - a report signed by a revoked key FAILS verification
//  (a) server route POST /v1/audit/report/verify, and
//  (b) offline browser verifier public/kolm-audit-verify.js
// =============================================================================
function buildSignedReport() {
  const signer = ed.loadOrCreateDefaultSigner();
  const generatedAt = new Date().toISOString();
  const envelope = {
    schema: 'kolm-audit-report-1',
    report_version: reportBuilder.AUDIT_REPORT_VERSION,
    report_id: 'rpt_' + crypto.randomBytes(6).toString('hex'),
    generated_at: generatedAt,
    tier: 'report',
    watermark: false,
    subject: { name: 'Test fleet' },
    summary: { readiness_pct: 88, total_findings: 0, by_severity: {}, tamper_evident: true, blocking_count: 0 },
    findings: [],
  };
  reportBuilder.signReport(envelope, signer);
  return { envelope, signer };
}

test('integration: server verify route flips trusted:false when the issuer key is revoked', async () => {
  keyrev._resetKeyStatusForTests();
  const r = makeRouter();
  auditRoutes.register(r, { authMiddleware: (req, res, next) => next() });
  const { envelope, signer } = buildSignedReport();

  // before revocation: tier-1 verifies, issuer recognized (live signer), trusted
  let res = await r.call('POST', '/v1/audit/report/verify', { body: { report: envelope } });
  assert.equal(res.status, 200);
  assert.equal(res.body.verify.ok, true, JSON.stringify(res.body.verify));
  assert.equal(res.body.trusted, true);
  assert.ok(res.body.revocation && res.body.revocation.status === 'live');

  // revoke the embedded signing key
  keyrev.revoke(signer.key_fingerprint, 'integration revocation');

  // after revocation: signature still verifies but trust is withdrawn
  res = await r.call('POST', '/v1/audit/report/verify', { body: { report: envelope } });
  assert.equal(res.body.verify.ok, true);
  assert.equal(res.body.trusted, false);
  assert.equal(res.body.reason, 'issuer_key_revoked');
  assert.equal(res.body.revocation.status, 'revoked');
});

test('integration: public status route + admin revoke route', async () => {
  keyrev._resetKeyStatusForTests();
  const r = makeRouter();
  auditRoutes.register(r, { authMiddleware: (req, res, next) => next() });
  const fp = crypto.randomBytes(16).toString('hex');

  // public status: live by default
  let res = await r.call('GET', `/v1/audit/issuer-key/${fp}/status`);
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'live');
  assert.equal(res.body.valid, true);

  // revoke without admin -> 403
  res = await r.call('POST', `/v1/audit/issuer-key/${fp}/revoke`, { body: { reason: 'x' } });
  assert.equal(res.status, 403);

  // revoke WITH admin header -> 200
  res = await r.call('POST', `/v1/audit/issuer-key/${fp}/revoke`, { body: { reason: 'admin test' }, headers: { 'x-admin-key': process.env.ADMIN_KEY } });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'revoked');
  assert.equal(res.body.valid, false);

  // public status now reflects revoked
  res = await r.call('GET', `/v1/audit/issuer-key/${fp}/status`);
  assert.equal(res.body.status, 'revoked');
  assert.equal(res.body.valid, false);
});

test('integration: offline browser verifier rejects a revoked key (reason issuer_key_revoked)', async () => {
  const { envelope, signer } = buildSignedReport();

  // clean verify (no revocation source) passes
  const clean = await verifier.verifyAuditReport(envelope);
  assert.equal(clean.ok, true, JSON.stringify(clean.checks));

  // with the signing fingerprint marked revoked, verification fails early
  const revoked = await verifier.verifyAuditReport(envelope, { revokedFingerprints: [signer.key_fingerprint] });
  assert.equal(revoked.ok, false);
  assert.equal(revoked.reason, 'issuer_key_revoked');

  // keyring-status revocation path
  const keyring = { issuers: [{ public_key: signer.publicKey, status: 'revoked' }] };
  const viaKeyring = await verifier.verifyAuditReport(envelope, { issuerKeyring: keyring });
  assert.equal(viaKeyring.ok, false);
  assert.equal(viaKeyring.reason, 'issuer_key_revoked');
});

test('verifier: optional timestamp_evidence + log_checkpoint surface as checks without breaking the verdict', async () => {
  const { envelope } = buildSignedReport();
  // attach additive evidence AFTER signing -> would normally break the signature,
  // so verify a SEPARATE copy whose evidence is informational-only by re-signing.
  const withEvidence = {
    ...envelope,
    timestamp_evidence: rfc3161.selfIssueTimestamp(sha256hex('anchor')),
    log_checkpoint: { url: 'https://kolm.ai/v1/transparency-log', tree_size: 3, root_hash: sha256hex('root'), tree_head_signature: 'sig' },
  };
  // re-sign so the signature covers the new fields
  const signer = ed.loadOrCreateDefaultSigner();
  delete withEvidence.signature_ed25519;
  reportBuilder.signReport(withEvidence, signer);
  const res = await verifier.verifyAuditReport(withEvidence);
  assert.equal(res.ok, true, JSON.stringify(res.checks));
  assert.ok(res.checks.some((c) => c.name === 'trusted timestamp present' && c.ok));
  assert.ok(res.checks.some((c) => c.name === 'transparency-log checkpoint present' && c.ok));
});
