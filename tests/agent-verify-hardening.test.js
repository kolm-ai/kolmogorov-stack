// Agent Security-Review — verify-hardening regression tests.
//
// These lock the adversarial-review fixes that close the *forgeable offline-
// verify* HIGH and its neighbours. They are pure unit tests over BOTH the Node
// builder/verifier (src/attestation-report-builder.js) and the browser verifier
// (public/kolm-audit-verify.js), run under Node's WebCrypto (Ed25519 native in
// Node 24), so the two stay in lock-step.
//
// What each block guards:
//   * canonicalization parity — Node and browser produce byte-identical signed
//     bytes, INCLUDING a hostile own `__proto__` key (the assignment-vs-spread
//     divergence that previously let the two disagree).
//   * never-throw verify boundary — a non-string key_fingerprint must yield
//     ok:false, never a thrown exception, on both sides.
//   * signed_at coverage — editing the displayed timestamp after signing fails
//     verification even though signed_at lives outside the signed payload.
//   * THE forgery / two-tier verdict — a tampered "100% ready" report re-signed
//     with a rogue key PASSES tier-1 (cryptographic integrity) on both verifiers
//     but is caught by tier-2 (issuer provenance + key pinning). This is the
//     whole reason the keyring + issuerProvenance exist.
//   * published artifacts — the bundled sample report + keyring verify and
//     resolve to the DEMO issuer (never a production signer).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runAudit } from '../src/audit-orchestrator.js';
import {
  buildReportEnvelope,
  signReport,
  verifyReport,
  canonicalizeReport as nodeCanonicalizeReport,
  AUDIT_REPORT_SCHEMA as NODE_SCHEMA,
} from '../src/attestation-report-builder.js';
import {
  generateKeyPair,
  buildSignatureBlock,
  keyFingerprint,
  loadSignerKeyFromEnv,
} from '../src/ed25519.js';
import {
  verifyAuditReport,
  issuerProvenance,
  normalizePem,
  keyFingerprintFromPem,
  canonicalizeReport as browserCanonicalizeReport,
  AUDIT_REPORT_SCHEMA as BROWSER_SCHEMA,
} from '../public/kolm-audit-verify.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURE = path.join(ROOT, 'examples', 'agent-audit', 'litellm-export.jsonl');
const LOGS = fs.readFileSync(FIXTURE, 'utf8');
const AUDIT = runAudit(LOGS, { source: 'litellm' });

function signerFrom(kp) {
  return { privateKey: kp.privateKey, publicKey: kp.publicKey, key_fingerprint: keyFingerprint(kp.publicKey) };
}

// A genuine, internally-consistent report signed by the given keypair.
function genuineSignedBy(kp, opts = {}) {
  const env = buildReportEnvelope(AUDIT, {
    subject: 'Hardening test subject',
    report_seed: 'hardening',
    generated_at: '2026-06-08T00:00:00.000Z',
    ...opts,
  });
  return signReport(env, signerFrom(kp));
}

// Re-sign an arbitrary (possibly tampered) envelope the way a forger would:
// strip the old signature, recompute the canonical payload, and embed a fresh
// signature + the forger's OWN public key, keeping signed_at == generated_at so
// the tier-1 timestamp check passes. The result is cryptographically pristine —
// only its provenance is wrong.
function resignWith(envelope, kp) {
  const clone = JSON.parse(JSON.stringify(envelope));
  delete clone.signature_ed25519;
  const canonical = nodeCanonicalizeReport(clone);
  clone.signature_ed25519 = buildSignatureBlock({
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    key_fingerprint: keyFingerprint(kp.publicKey),
    payloadCanonical: canonical,
    signed_at: clone.generated_at,
  });
  return clone;
}

// ---------------------------------------------------------------------------
// Canonicalization parity.
// ---------------------------------------------------------------------------
test('canonicalization is byte-identical: Node builder vs browser verifier', () => {
  const env = genuineSignedBy(generateKeyPair());
  assert.equal(nodeCanonicalizeReport(env), browserCanonicalizeReport(env));
  assert.equal(NODE_SCHEMA, BROWSER_SCHEMA, 'both modules agree on the report schema id');
});

test('canonicalization parity survives a hostile own __proto__ key (CopyDataProperties, not assignment)', () => {
  // JSON.parse installs `__proto__` as an OWN enumerable data property. The old
  // browser code did `rest[k] = envelope[k]`, which routes `__proto__` through
  // the Object.prototype setter and silently DROPS it — diverging from the Node
  // builder's object-spread, which copies it as own data. Both now use the
  // spread, so the signed bytes match and the key is part of them.
  const env = JSON.parse('{"a":2,"z":1,"__proto__":{"injected":true},"schema":"kolm-audit-report-1","signature_ed25519":{"spec":"kolm-ed25519-v1"}}');
  const nodeCanon = nodeCanonicalizeReport(env);
  const browserCanon = browserCanonicalizeReport(env);
  assert.equal(nodeCanon, browserCanon, 'Node and browser canonicalization agree on a __proto__ own key');
  assert.ok(nodeCanon.includes('"__proto__"'), 'the __proto__ own key is part of the signed bytes, not silently dropped');
});

// ---------------------------------------------------------------------------
// Never-throw verify boundary.
// ---------------------------------------------------------------------------
test('verifiers never throw on a non-string key_fingerprint (both return ok:false)', async () => {
  const base = genuineSignedBy(generateKeyPair());
  for (const evil of [12345, true, { nested: 'x' }, ['a', 'b']]) {
    const r = JSON.parse(JSON.stringify(base));
    r.signature_ed25519.key_fingerprint = evil;
    let nodeRes;
    let browserRes;
    assert.doesNotThrow(() => { nodeRes = verifyReport(r); }, `verifyReport must not throw on ${JSON.stringify(evil)}`);
    await assert.doesNotReject(async () => { browserRes = await verifyAuditReport(r); }, `verifyAuditReport must not throw on ${JSON.stringify(evil)}`);
    assert.equal(nodeRes.ok, false, `node verifier rejects fingerprint ${JSON.stringify(evil)}`);
    assert.equal(browserRes.ok, false, `browser verifier rejects fingerprint ${JSON.stringify(evil)}`);
  }
});

test('a null key_fingerprint claim is treated as absent (genuine report still verifies)', async () => {
  const base = genuineSignedBy(generateKeyPair());
  const r = JSON.parse(JSON.stringify(base));
  r.signature_ed25519.key_fingerprint = null;
  assert.equal(verifyReport(r).ok, true, 'node verifier: absent fingerprint claim is not a failure');
  assert.equal((await verifyAuditReport(r)).ok, true, 'browser verifier: absent fingerprint claim is not a failure');
});

// ---------------------------------------------------------------------------
// signed_at coverage — the timestamp outside the signed payload can't be edited.
// ---------------------------------------------------------------------------
test('tampering signed_at after signing is caught by both verifiers', async () => {
  const base = genuineSignedBy(generateKeyPair());
  assert.equal(verifyReport(base).ok, true, 'control: genuine report verifies (node)');
  assert.equal((await verifyAuditReport(base)).ok, true, 'control: genuine report verifies (browser)');

  const r = JSON.parse(JSON.stringify(base));
  r.signature_ed25519.signed_at = '2099-01-01T00:00:00.000Z'; // != generated_at
  const nodeRes = verifyReport(r);
  const browserRes = await verifyAuditReport(r);
  assert.equal(nodeRes.ok, false, 'node verifier rejects an altered signed_at');
  assert.match(nodeRes.reason, /signed_at/);
  assert.equal(browserRes.ok, false, 'browser verifier rejects an altered signed_at');
  assert.match(browserRes.reason, /signed_at/);
});

// ---------------------------------------------------------------------------
// THE forgery — tier-1 passes, tier-2 catches. The HIGH this whole layer fixes.
// ---------------------------------------------------------------------------
test('FORGERY: a rogue-signed tampered report passes tier-1 but fails issuer provenance + pinning', async () => {
  const realKp = generateKeyPair();
  const rogueKp = generateKeyPair();
  const keyring = {
    schema: 'kolm-issuer-keyring-1',
    issuers: [
      { kid: 'kolm-prod-test', label: 'kolm production (test)', status: 'production', public_key: realKp.publicKey, fingerprint: keyFingerprint(realKp.publicKey) },
    ],
  };

  const genuine = genuineSignedBy(realKp);
  // The genuine report passes every tier.
  assert.equal(verifyReport(genuine).ok, true);
  assert.equal((await verifyAuditReport(genuine)).ok, true);
  assert.equal((await verifyAuditReport(genuine, { pinnedPublicKeyPem: realKp.publicKey })).ok, true, 'genuine report survives pinning to the real key');
  const gp = issuerProvenance(genuine, keyring);
  assert.equal(gp.recognized, true);
  assert.equal(gp.status, 'production');
  assert.equal(gp.kid, 'kolm-prod-test');

  // Forge: flip readiness to a passing grade, drop the findings, re-sign rogue.
  const tampered = JSON.parse(JSON.stringify(genuine));
  tampered.summary.readiness_pct = 100;
  tampered.summary.blocking_count = 0;
  tampered.findings = [];
  const forged = resignWith(tampered, rogueKp);

  // TIER 1 — cryptographic integrity — PASSES. The forged report really is
  // signed by the holder of its embedded (rogue) key and untampered since. A
  // signature check ALONE cannot distinguish it from a real report. This is the
  // exact gap the review flagged.
  assert.equal(verifyReport(forged).ok, true, 'tier-1 (node) cannot tell a rogue-signed report from a real one');
  assert.equal((await verifyAuditReport(forged)).ok, true, 'tier-1 (browser) cannot tell either — this is WHY tier-2 exists');

  // TIER 2 — issuer provenance — CATCHES IT.
  const fp = issuerProvenance(forged, keyring);
  assert.equal(fp.recognized, false, 'the rogue key is NOT in the published keyring');

  // Pinning the real issuer key also rejects the forgery.
  const pinned = await verifyAuditReport(forged, { pinnedPublicKeyPem: realKp.publicKey });
  assert.equal(pinned.ok, false, 'pinning the real issuer key rejects the rogue-signed forgery');
  assert.match(pinned.reason, /pinned/);

  // And the two keys really are distinct (no accidental collision).
  assert.notEqual(normalizePem(forged.signature_ed25519.public_key), normalizePem(realKp.publicKey));
});

// ---------------------------------------------------------------------------
// issuerProvenance — whitespace-insensitive match, unknown-key reject, no throw.
// ---------------------------------------------------------------------------
test('issuerProvenance matches keys whitespace-insensitively and rejects unknown keys', () => {
  const kp = generateKeyPair();
  const report = genuineSignedBy(kp);

  // Same key, mangled line endings + trailing whitespace.
  const mangled = kp.publicKey.replace(/\n/g, '\r\n') + '\n\n   ';
  const p = issuerProvenance(report, { issuers: [{ kid: 'k', status: 'demo', public_key: mangled }] });
  assert.equal(p.recognized, true, 'whitespace differences do not defeat issuer matching');
  assert.equal(p.kid, 'k');
  assert.equal(p.status, 'demo');

  // Empty keyring → not recognized, embedded key still surfaced, no throw.
  const none = issuerProvenance(report, { issuers: [] });
  assert.equal(none.recognized, false);
  assert.ok(none.embedded_key.includes('BEGIN PUBLIC KEY'));

  // Hostile inputs never throw.
  assert.doesNotThrow(() => issuerProvenance(null, null));
  assert.doesNotThrow(() => issuerProvenance({}, { issuers: 'nope' }));
  assert.equal(issuerProvenance(null, null).recognized, false);
});

// ---------------------------------------------------------------------------
// Fingerprint parity — the two implementations agree byte-for-byte.
// ---------------------------------------------------------------------------
test('keyFingerprint (node) and keyFingerprintFromPem (browser) agree', async () => {
  const kp = generateKeyPair();
  const a = keyFingerprint(kp.publicKey);
  const b = await keyFingerprintFromPem(kp.publicKey);
  assert.equal(a, b);
  assert.equal(a.length, 32);
});

// ---------------------------------------------------------------------------
// Published artifacts — the bundled sample + keyring are consistent and DEMO.
// ---------------------------------------------------------------------------
test('published sample report + keyring verify and resolve to the demo issuer', async () => {
  const sample = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'sample-audit-report.json'), 'utf8'));
  const keyring = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'keys', 'kolm-issuers.json'), 'utf8'));

  // Tier 1 — both verifiers accept the published sample.
  assert.equal(verifyReport(sample).ok, true, 'node verifier accepts the published sample');
  assert.equal((await verifyAuditReport(sample)).ok, true, 'browser verifier accepts the published sample');

  // Tier 2 — the sample resolves to the DEMO issuer in the published keyring.
  const prov = issuerProvenance(sample, keyring);
  assert.equal(prov.recognized, true, 'sample is signed by a published issuer key');
  assert.equal(prov.status, 'demo', 'and that issuer is the DEMO key — never a production signer');
  assert.equal(prov.kid, 'kolm-demo-2026');

  // The embedded fingerprint matches the keyring entry and a fresh compute.
  const demo = keyring.issuers.find((i) => i.kid === 'kolm-demo-2026');
  assert.ok(demo, 'keyring contains the demo issuer');
  assert.equal(sample.signature_ed25519.key_fingerprint, demo.fingerprint);
  assert.equal(await keyFingerprintFromPem(sample.signature_ed25519.public_key), demo.fingerprint);
  assert.equal(normalizePem(sample.signature_ed25519.public_key), normalizePem(demo.public_key));

  // The sample is the dogfood 0%-ready report — no accidental "all clear".
  assert.equal(sample.summary.readiness_pct, 0);
  assert.ok(sample.summary.blocking_count >= 1);

  // No drift between the published keyring and the inline anchor baked into
  // verify.html. The inline anchor is what an OFFLINE reviewer pins against
  // (refreshKeyring() only upgrades it when the network is reachable), so if it
  // diverged from the published demo key the sample would fail tier-2 offline.
  const verifyHtml = fs.readFileSync(path.join(ROOT, 'public', 'verify.html'), 'utf8');
  const demoBody = normalizePem(demo.public_key).replace(/-----[A-Z]+-----/g, '');
  assert.ok(demoBody.length > 0);
  assert.ok(verifyHtml.includes(demoBody), 'verify.html inlines the published demo issuer key (no drift between keyring, sample, and the offline anchor)');
});

test('FORGERY on the published sample: tamper readiness, re-sign rogue → demo provenance is lost', async () => {
  const sample = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'sample-audit-report.json'), 'utf8'));
  const keyring = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'keys', 'kolm-issuers.json'), 'utf8'));
  const rogueKp = generateKeyPair();

  const tampered = JSON.parse(JSON.stringify(sample));
  tampered.summary.readiness_pct = 100;
  const forged = resignWith(tampered, rogueKp);

  assert.equal((await verifyAuditReport(forged)).ok, true, 'tier-1 stays green on the rogue-signed forgery');
  assert.equal(issuerProvenance(forged, keyring).recognized, false, 'but it no longer resolves to the demo issuer');
});

// ---------------------------------------------------------------------------
// Production issuer — the LIVE evidence signer is published and trusted.
//
// The demo key only ever signs the on-page sample. Real audits are signed by a
// SEPARATE production key whose PUBLIC half is published in the keyring AND
// baked into verify.html's offline anchor, so a production report verifies and
// resolves to a trusted (status:'production') issuer even with the network
// unplugged. These lock that the production entry exists, is internally
// consistent, is distinct from the demo key, and carries NO private material.
// ---------------------------------------------------------------------------
test('keyring publishes a production issuer that is distinct from the demo key and self-consistent', async () => {
  const keyring = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'keys', 'kolm-issuers.json'), 'utf8'));
  const prod = keyring.issuers.find((i) => i.status === 'production');
  assert.ok(prod, 'keyring contains a production issuer');
  assert.equal(prod.kid, 'kolm-prod-2026');
  assert.equal(prod.alg, 'ed25519');

  // Self-consistent: the published fingerprint is the real fingerprint of the PEM.
  assert.equal(await keyFingerprintFromPem(prod.public_key), prod.fingerprint, 'fingerprint matches the published key');

  // Distinct from the demo signer — production evidence is never demo-signed.
  const demo = keyring.issuers.find((i) => i.kid === 'kolm-demo-2026');
  assert.ok(demo, 'demo issuer still present');
  assert.notEqual(normalizePem(prod.public_key), normalizePem(demo.public_key), 'production key is not the demo key');

  // No private material ever ships in the keyring.
  const blob = JSON.stringify(keyring);
  assert.ok(!blob.includes('PRIVATE KEY'), 'keyring carries only public keys');
});

test('a report carrying the production key resolves to a trusted production issuer (offline anchor + keyring)', async () => {
  const keyring = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'keys', 'kolm-issuers.json'), 'utf8'));
  const prod = keyring.issuers.find((i) => i.status === 'production');

  // issuerProvenance only reads the embedded key, so a report whose embedded
  // public_key is the production key resolves to the production issuer — tier-2
  // green — against the published keyring.
  const reportShapedLikeProd = { signature_ed25519: { public_key: prod.public_key } };
  const provKeyring = issuerProvenance(reportShapedLikeProd, keyring);
  assert.equal(provKeyring.recognized, true, 'production key is recognized in the keyring');
  assert.equal(provKeyring.status, 'production');
  assert.equal(provKeyring.kid, 'kolm-prod-2026');

  // And the same resolves against the OFFLINE anchor baked into verify.html, so
  // a production report verifies with the network unplugged.
  const verifyHtml = fs.readFileSync(path.join(ROOT, 'public', 'verify.html'), 'utf8');
  const prodBody = normalizePem(prod.public_key).replace(/-----[A-Z]+-----/g, '');
  assert.ok(prodBody.length > 0);
  assert.ok(verifyHtml.includes(prodBody), 'verify.html inlines the production issuer key (offline anchor, no drift)');
});

// ---------------------------------------------------------------------------
// Production key provisioning — the env signer accepts escaped-newline PEMs.
//
// Railway/CI/dashboard secret stores frequently cannot carry real newlines, so
// the production private key is commonly stored with its line breaks escaped as
// the two-character sequence backslash-n. loadSignerKeyFromEnv must restore them
// and load the key identically to a real-newline PEM. Without this the prod
// signer would fail to boot and every /run would 503 no_signer_configured.
// ---------------------------------------------------------------------------
test('loadSignerKeyFromEnv accepts a PEM with escaped (\\n) newlines, identical to real newlines', () => {
  const kp = generateKeyPair();
  const realFp = keyFingerprint(kp.publicKey);
  const escaped = kp.privateKey.replace(/\r?\n/g, '\\n'); // store with literal backslash-n
  assert.ok(escaped.includes('\\n') && !/\n/.test(escaped), 'fixture really is single-line, escaped');

  const saved = process.env.KOLM_ED25519_PRIVATE_KEY;
  const savedDisable = process.env.KOLM_ED25519_DISABLE;
  try {
    delete process.env.KOLM_ED25519_DISABLE;
    process.env.KOLM_ED25519_PRIVATE_KEY = escaped;
    const signer = loadSignerKeyFromEnv();
    assert.ok(signer, 'escaped-newline PEM loads');
    assert.equal(signer.key_fingerprint, realFp, 'loads to the same key as the real-newline PEM');
    assert.ok(/-----BEGIN PRIVATE KEY-----\n/.test(signer.privateKey), 'newlines were restored');
  } finally {
    if (saved === undefined) delete process.env.KOLM_ED25519_PRIVATE_KEY; else process.env.KOLM_ED25519_PRIVATE_KEY = saved;
    if (savedDisable === undefined) delete process.env.KOLM_ED25519_DISABLE; else process.env.KOLM_ED25519_DISABLE = savedDisable;
  }
});
