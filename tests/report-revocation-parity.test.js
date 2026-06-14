// tests/report-revocation-parity.test.js
//
// SPEC: report-revocation-parity
//
// verifyReport() is the PURE, offline verifier shared by the HTTP route, the CLI,
// and the SDK bridge. Before this change it proved tier-1 only (signed by the
// holder of the embedded key, untampered) and left revocation to the route - so a
// revoked-key report still verified true everywhere OFFLINE. This proves the gap
// is closed: a report whose issuer key has been REVOKED now fails verifyReport
// directly (ok:false, reason:'issuer_key_revoked'), while a live-key report still
// verifies and the signing/canonicalization format is untouched.
//
// Runs fully OFFLINE + deterministic. Store state is isolated to a scratch dir
// (set BEFORE any store-touching module loads, mirroring crypto-services.test.js)
// so this never reads or writes production revocation rows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- isolate state BEFORE any module that touches the store is loaded ---------
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-revoke-parity-'));
process.env.KOLM_DATA_DIR = path.join(SCRATCH, 'data');
process.env.KOLM_STORE_DRIVER = 'json';
process.env.KOLM_ED25519_KEY_STORE = path.join(SCRATCH, 'keys');
fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });

// --- dynamic imports (after env is set) ---------------------------------------
const keyrev = await import('../src/key-revocation.js');
const { buildAndSignReport, verifyReport, canonicalizeReport } = await import('../src/attestation-report-builder.js');

// A minimal, well-formed runAudit()-shaped result. buildReportEnvelope only needs
// a summary; the rest of the analyzer outputs default cleanly (pure builders).
function tinyAudit() {
  return {
    source: 'litellm',
    summary: {
      readiness_pct: 100,
      total_findings: 0,
      by_severity: {},
      tamper_evident: true,
      assessed_controls: ['ASR-1', 'ASR-2', 'ASR-3'],
      controls: [],
      not_assessed: [],
      blocking_count: 0,
    },
    controls: { findings: [], frameworks: [] },
    events: [],
  };
}

test('verifyReport passes for a live (non-revoked) issuer key', () => {
  keyrev._resetKeyStatusForTests();
  const { envelope, key_fingerprint } = buildAndSignReport(tinyAudit(), { subject: 'Live key' });

  const v = verifyReport(envelope);
  assert.equal(v.ok, true, 'a report signed by a live key verifies offline');
  assert.equal(v.key_fingerprint, key_fingerprint);

  // The new revocation check is present and passing in the trail.
  const check = v.checks.find((c) => c.name === 'issuer key not revoked');
  assert.ok(check, 'verify trail carries the revocation check');
  assert.equal(check.ok, true, 'live key passes the revocation check');
  keyrev._resetKeyStatusForTests();
});

test('verifyReport FAILS offline once the issuer key is revoked (parity with the route)', () => {
  keyrev._resetKeyStatusForTests();
  const { envelope, key_fingerprint } = buildAndSignReport(tinyAudit(), { subject: 'To be revoked' });

  // Sanity: verifies before revocation.
  assert.equal(verifyReport(envelope).ok, true, 'control: report verifies before revocation');

  // Revoke the exact issuer fingerprint the report was signed with.
  keyrev.revoke(key_fingerprint, 'compromised in parity test');

  const v = verifyReport(envelope);
  assert.equal(v.ok, false, 'a revoked-key report no longer verifies true OFFLINE');
  assert.equal(v.reason, 'issuer_key_revoked', 'the verdict names the revocation reason');
  assert.equal(v.key_fingerprint, key_fingerprint, 'the failing verdict still surfaces the fingerprint');

  const check = v.checks.find((c) => c.name === 'issuer key not revoked');
  assert.ok(check && check.ok === false, 'the revocation check is recorded as failed in the trail');

  keyrev._resetKeyStatusForTests();
});

test('revoking the key does NOT change the signed/canonical bytes (signature format untouched)', () => {
  keyrev._resetKeyStatusForTests();
  const { envelope } = buildAndSignReport(tinyAudit(), { subject: 'Canonical stable' });
  const before = canonicalizeReport(envelope);

  keyrev.revoke(envelope.signature_ed25519.key_fingerprint, 'format-stability test');
  const after = canonicalizeReport(envelope);

  assert.equal(before, after, 'revocation is a runtime trust check, not a payload mutation');
  keyrev._resetKeyStatusForTests();
});

test('a rotated (not revoked) key still verifies - rotation is not compromise', () => {
  keyrev._resetKeyStatusForTests();
  const { envelope, key_fingerprint } = buildAndSignReport(tinyAudit(), { subject: 'Rotated key' });

  keyrev.rotateKey({ old_fp: key_fingerprint });

  const v = verifyReport(envelope);
  assert.equal(v.ok, true, 'a report signed before routine rotation remains valid');
  keyrev._resetKeyStatusForTests();
});
