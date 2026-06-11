// GAP-3 - vendor coverage declaration: validation, vendor signature handling,
// caveat wording, and the binding into the SIGNED report envelope.
//
// The threat: tiers B/C accept vendor-curated exports, so a vendor can hand
// over a quiet week and pass every analyzer. The declaration puts the vendor
// on the record about WHICH window/systems the export covers, and the builder
// binds that statement inside the Ed25519-signed payload so it is exactly as
// tamper-evident as the findings.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  COVERAGE_DECLARATION_VERSION,
  normalizeCoverageDeclaration,
  declarationCaveat,
} from '../src/coverage-declaration.js';
import { generateKeyPair, buildSignatureBlock, keyFingerprint } from '../src/ed25519.js';
import { canonicalize, buildAndSignReport, verifyReport } from '../src/attestation-report-builder.js';
import { runAudit } from '../src/audit-orchestrator.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURE = path.join(ROOT, 'examples', 'agent-audit', 'litellm-export.jsonl');

function dirtyAudit() {
  return runAudit(fs.readFileSync(FIXTURE, 'utf8'), { source: 'litellm' });
}

function validRaw(extra = {}) {
  return {
    window_start: '2026-02-01T00:00:00Z',
    window_end: '2026-04-30T00:00:00Z',
    systems: ['litellm-gateway-prod', ' helpdesk-agent '],
    expected_calls_per_day: 1200,
    attestor: { name: 'A. Vendor, Head of Platform', email: 'platform@example.com' },
    statement: 'This export is the complete LiteLLM gateway log for the stated window.',
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// normalizeCoverageDeclaration - validation.
// ---------------------------------------------------------------------------
test('a valid declaration normalizes with ISO windows, trimmed systems, version stamp', () => {
  const r = normalizeCoverageDeclaration(validRaw());
  assert.equal(r.ok, true, r.error);
  const d = r.declaration;
  assert.equal(d.version, COVERAGE_DECLARATION_VERSION);
  assert.equal(d.window_start, '2026-02-01T00:00:00.000Z');
  assert.equal(d.window_end, '2026-04-30T00:00:00.000Z');
  assert.deepEqual(d.systems, ['litellm-gateway-prod', 'helpdesk-agent'], 'systems trimmed');
  assert.equal(d.expected_calls_per_day, 1200);
  assert.equal(d.attestor.name, 'A. Vendor, Head of Platform');
  assert.equal(d.attestor.email, 'platform@example.com');
  assert.ok(d.statement.length > 0);
});

test('expected_calls_per_day and email and statement are optional', () => {
  const r = normalizeCoverageDeclaration({
    window_start: '2026-01-01T00:00:00Z',
    window_end: '2026-01-31T00:00:00Z',
    systems: ['s1'],
    attestor: { name: 'N' },
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.declaration.expected_calls_per_day, null);
  assert.equal('email' in r.declaration.attestor, false);
  assert.equal('statement' in r.declaration, false);
});

test('malformed declarations are rejected with a reason, never a throw', () => {
  const cases = [
    [null, /object/],
    ['x', /object/],
    [[], /object/],
    [validRaw({ window_start: 'not-a-date' }), /window_start/],
    [validRaw({ window_end: undefined }), /window_end/],
    [validRaw({ window_start: '2026-05-01T00:00:00Z', window_end: '2026-04-01T00:00:00Z' }), /precede/],
    [validRaw({ systems: [] }), /systems/],
    [validRaw({ systems: ['ok', ''] }), /non-empty/],
    [validRaw({ systems: Array.from({ length: 21 }, (_, i) => 's' + i) }), /at most 20/],
    [validRaw({ systems: ['x'.repeat(121)] }), /120/],
    [validRaw({ expected_calls_per_day: -5 }), /expected_calls_per_day/],
    [validRaw({ expected_calls_per_day: 'lots' }), /expected_calls_per_day/],
    [validRaw({ attestor: null }), /attestor/],
    [validRaw({ attestor: { name: '' } }), /attestor\.name/],
    [validRaw({ attestor: { name: 'N', email: 'not-an-email' } }), /email/],
    [validRaw({ statement: 'x'.repeat(501) }), /500/],
  ];
  for (const [raw, re] of cases) {
    let r;
    assert.doesNotThrow(() => { r = normalizeCoverageDeclaration(raw); });
    assert.equal(r.ok, false, 'rejected: ' + JSON.stringify(raw).slice(0, 80));
    assert.match(String(r.error), re);
  }
});

// ---------------------------------------------------------------------------
// vendor Ed25519 signature over the declaration.
// ---------------------------------------------------------------------------
function signedRaw() {
  // Sign over the canonical form of the NORMALIZED declaration (what a vendor
  // SDK would reproduce), then attach the block to the raw input.
  const base = normalizeCoverageDeclaration(validRaw()).declaration;
  const kp = generateKeyPair();
  const block = buildSignatureBlock({
    privateKey: kp.privateKey,
    publicKey: kp.publicKey,
    key_fingerprint: keyFingerprint(kp.publicKey),
    payloadCanonical: canonicalize(base),
    signed_at: '2026-05-01T00:00:00.000Z',
  });
  return { ...validRaw(), signature_ed25519: block };
}

test('a vendor-signed declaration verifies and the block is passed through', () => {
  const r = normalizeCoverageDeclaration(signedRaw());
  assert.equal(r.ok, true, r.error);
  const blk = r.declaration.signature_ed25519;
  assert.ok(blk && blk.signature, 'signature block kept');
  assert.equal(blk.alg, 'ed25519');
  assert.ok(blk.key_fingerprint, 'fingerprint carried');
});

test('a present-but-invalid vendor signature is a hard reject', () => {
  const raw = signedRaw();
  raw.systems = ['litellm-gateway-prod', 'helpdesk-agent', 'OTHER-SYSTEM']; // alters signed bytes
  const r = normalizeCoverageDeclaration(raw);
  assert.equal(r.ok, false, 'tampered signed declaration rejected');
  assert.match(String(r.error), /signature/);

  const raw2 = signedRaw();
  raw2.signature_ed25519 = 'not-a-block';
  assert.equal(normalizeCoverageDeclaration(raw2).ok, false);
});

// ---------------------------------------------------------------------------
// declarationCaveat wording.
// ---------------------------------------------------------------------------
test('declarationCaveat names the attestor, window, systems, and signing status', () => {
  const d = normalizeCoverageDeclaration(validRaw()).declaration;
  const c = declarationCaveat(d);
  assert.ok(c.includes('A. Vendor, Head of Platform'));
  assert.ok(c.includes('2026-02-01'));
  assert.ok(c.includes('2026-04-30'));
  assert.ok(c.includes('litellm-gateway-prod'));
  assert.ok(c.includes('~1200 calls/day'));
  assert.ok(!c.includes('(vendor-signed)'), 'unsigned declaration not marked vendor-signed');
  const ds = normalizeCoverageDeclaration(signedRaw()).declaration;
  assert.ok(declarationCaveat(ds).includes('(vendor-signed)'));
});

test('declarationCaveat never throws on garbage', () => {
  for (const bad of [null, undefined, 42, 'x', [], {}]) {
    assert.doesNotThrow(() => declarationCaveat(bad));
    assert.equal(typeof declarationCaveat(bad), 'string');
  }
});

// ---------------------------------------------------------------------------
// binding into the SIGNED envelope (GAP-3 accountability half).
// ---------------------------------------------------------------------------
test('the declaration is bound inside the signed envelope and tamper breaks the signature', () => {
  const decl = normalizeCoverageDeclaration(validRaw()).declaration;
  const { envelope } = buildAndSignReport(dirtyAudit(), { subject: 'X', coverage_declaration: decl });
  assert.deepEqual(envelope.coverage_declaration, decl, 'declaration carried verbatim');
  assert.ok(
    envelope.caveats.some((c) => c.includes('Coverage declared by')),
    'declaration caveat in the signed caveats',
  );
  assert.equal(verifyReport(envelope).ok, true);
  // A vendor quietly widening their declared window AFTER signing must fail.
  envelope.coverage_declaration.window_end = '2027-01-01T00:00:00.000Z';
  assert.equal(verifyReport(envelope).ok, false, 'edited declaration breaks the Ed25519 signature');
});

test('a declared window that does not match the observed event span is called out', () => {
  // Fixture events span 2026-02..2026-04; declare a disjoint 2025 window.
  const decl = normalizeCoverageDeclaration(validRaw({
    window_start: '2025-01-01T00:00:00Z',
    window_end: '2025-03-01T00:00:00Z',
  })).declaration;
  const { envelope } = buildAndSignReport(dirtyAudit(), { subject: 'X', coverage_declaration: decl });
  assert.ok(
    envelope.caveats.some((c) => c.includes('does not match the observed event span')),
    'window-mismatch caveat present',
  );
});

test('a matching declared window adds no mismatch caveat', () => {
  const decl = normalizeCoverageDeclaration(validRaw()).declaration; // 2026-02..2026-04 covers the fixture
  const { envelope } = buildAndSignReport(dirtyAudit(), { subject: 'X', coverage_declaration: decl });
  assert.ok(!envelope.caveats.some((c) => c.includes('does not match the observed event span')));
});

test('vendor-tier evidence with NO declaration carries the explicit window-selection caveat', () => {
  const { envelope } = buildAndSignReport(dirtyAudit(), { subject: 'X' });
  assert.ok(['B', 'C'].includes(envelope.evidence_tier.grade), 'fixture is vendor-tier evidence');
  assert.ok(
    envelope.caveats.some((c) => c.includes('No coverage declaration was supplied')),
    'absence of a declaration is stated in the signed report',
  );
});
