// R-6 — Assurance case export tests.
//
// Pins:
//   1. buildAssuranceCase returns at least 3 claims with evidence_ids.
//   2. Every claim's status is in CLAIM_STATUSES.
//   3. Controls span at least 3 distinct frameworks.
//   4. JSON export shape matches schema (validateAssuranceCase ok).
//   5. PDF export creates a non-empty file (>1KB) — skipped with a clear
//      reason when pdfkit is not installed.
//   6. Auto-generation downgrades cleanly when inputs are missing
//      (claim status drops to package-gated / external-proof-needed; no throw).
//   7. Data provenance: full rights-holder coverage flips claim to
//      'implemented'; missing coverage downgrades to 'package-gated'.
//   8. Model integrity: signed + audit receipts -> 'implemented'.
//   9. Deployment integrity: at least one 'tested' passport -> 'implemented'.
//  10. Drift monitoring: enabled namespace -> 'implemented'; else
//      'external-proof-needed'.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TEST_DATA_DIR = path.join(os.tmpdir(), 'kolm-r6-' + crypto.randomBytes(4).toString('hex'));
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.KOLM_DATA_DIR = TEST_DATA_DIR;
process.env.KOLM_HOME = TEST_DATA_DIR;
process.env.HOME = TEST_DATA_DIR;
process.env.USERPROFILE = TEST_DATA_DIR;

const ac = await import('../src/assurance-case.js');

// ---------------------------------------------------------------------------
// Fixtures — an artifact with a full evidence DAG + a workspace with a
// procurement vault, and a "thin" artifact with nothing.
// ---------------------------------------------------------------------------

function fullArtifact() {
  return {
    id: 'art_abc123',
    namespace: 'prod-us-east',
    manifest: {
      artifact_id: 'art_abc123',
      runtime_passports: [
        { target_id: 'gguf-q4_k_m-llama.cpp', status: 'tested',    runtime: 'llama.cpp', runtime_version: 'b3415', precision: 'q4_k_m', memory_mb: 4096, latency_p50_ms: 12, latency_p95_ms: 22, tok_s: 80, quality_delta: 0, fallback: null },
        { target_id: 'mlx-fp16',              status: 'estimated', runtime: 'mlx',       runtime_version: '0.20.0', precision: 'fp16',   memory_mb: 8192, latency_p50_ms: null, latency_p95_ms: null, tok_s: null, quality_delta: null, fallback: 'gguf-q4_k_m-llama.cpp' },
      ],
      evidence_dag: {
        nodes: [
          { id: 'cap_001', kind: 'capture', hash: 'h1' },
          { id: 'cap_002', kind: 'capture', hash: 'h2' },
          { id: 'rt_001',  kind: 'rights',  hash: 'r1', covers: ['cap_001', 'cap_002'] },
          { id: 'eval_001', kind: 'eval' },
        ],
      },
    },
    receipt: {
      signature_ed25519: 'aabb...',
      signature_mode: 'ed25519',
      signature_fingerprint: 'fp_001',
      receipts: [
        { cid: 'cidv1:sha256:00aa', kind: 'kolm-audit-1' },
      ],
    },
  };
}

function thinArtifact() {
  return { id: 'art_thin', namespace: 'prod-eu', manifest: {}, receipt: null };
}

function fullWorkspace() {
  return {
    id: 'ws_demo',
    drift_namespaces: { 'prod-us-east': { enabled: true, kl_threshold: 0.10 } },
    procurement_vault: {
      sig_lite: {
        sections: [
          { id: 'A', questions: [{ id: 'A.1.2', answer: 'yes', evidence: 'annual board review.' }] },
        ],
      },
      caiq: {
        controls: [
          { id: 'AIS-01.1', answer: 'yes', evidence: 'OWASP ASVS L2.' },
          { id: 'IAM-01.1', answer: 'yes', evidence: 'tenant-scoped auth + RBAC.' },
          { id: 'BCR-01.1', answer: 'yes', evidence: 'quarterly DR drills.' },
          { id: 'CEK-01.1', answer: 'yes', evidence: 'AES-256 at rest, TLS 1.3 in transit.' },
          { id: 'IAM-08.1', answer: 'yes', evidence: 'workforce auth via SSO.' },
          { id: 'GRC-04.1', answer: 'yes', evidence: 'risk register + governance committee.' },
        ],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 1) buildAssuranceCase returns at least 3 claims with evidence_ids
// ---------------------------------------------------------------------------

test('R6 #1 — buildAssuranceCase returns >= 3 claims with evidence_ids', () => {
  const envelope = ac.buildAssuranceCase({ artifact: fullArtifact(), workspace: fullWorkspace() });
  assert.ok(Array.isArray(envelope.claims), 'claims must be array');
  assert.ok(envelope.claims.length >= 3, `expected >=3 claims, got ${envelope.claims.length}`);
  // At least 3 claims must carry non-empty evidence_ids when the artifact
  // and workspace are fully populated.
  const claimsWithEvidence = envelope.claims.filter((c) => Array.isArray(c.evidence_ids) && c.evidence_ids.length > 0);
  assert.ok(claimsWithEvidence.length >= 3, `expected >=3 claims with evidence_ids; got ${claimsWithEvidence.length}`);
});

// ---------------------------------------------------------------------------
// 2) Every claim's status is in CLAIM_STATUSES
// ---------------------------------------------------------------------------

test('R6 #2 — every claim status is in CLAIM_STATUSES', () => {
  const envelope = ac.buildAssuranceCase({ artifact: fullArtifact(), workspace: fullWorkspace() });
  for (const c of envelope.claims) {
    assert.ok(ac.CLAIM_STATUSES.includes(c.status), `claim status '${c.status}' not in taxonomy`);
  }
});

// ---------------------------------------------------------------------------
// 3) Controls span at least 3 distinct frameworks
// ---------------------------------------------------------------------------

test('R6 #3 — controls span >= 3 distinct frameworks', () => {
  const envelope = ac.buildAssuranceCase({ artifact: fullArtifact(), workspace: fullWorkspace() });
  const frameworks = new Set(envelope.controls.map((c) => c.framework));
  assert.ok(frameworks.size >= 3, `expected >=3 frameworks; got ${frameworks.size}: ${[...frameworks].join(',')}`);
  // At least 8 controls per spec.
  assert.ok(envelope.controls.length >= 8, `expected >=8 controls; got ${envelope.controls.length}`);
});

// ---------------------------------------------------------------------------
// 4) JSON export shape matches schema
// ---------------------------------------------------------------------------

test('R6 #4 — validateAssuranceCase returns ok:true on a well-formed envelope', () => {
  const envelope = ac.buildAssuranceCase({ artifact: fullArtifact(), workspace: fullWorkspace() });
  const v = ac.validateAssuranceCase(envelope);
  assert.equal(v.ok, true, 'validate failed: ' + (v.reasons || []).join(','));
  assert.equal(envelope.spec, 'kolm-assurance-case-1');
  assert.ok(typeof envelope.generated_at === 'string' && envelope.generated_at.length > 0);
});

test('R6 #4b — validateAssuranceCase rejects a malformed envelope', () => {
  const bad = {
    spec: 'wrong-spec',
    claims: [{ claim: 'x', status: 'not-a-status', evidence_ids: [], limitations: '' }],
    controls: 'not-an-array',
  };
  const v = ac.validateAssuranceCase(bad);
  assert.equal(v.ok, false);
  assert.ok(v.reasons.some((r) => r === 'bad_spec'));
  assert.ok(v.reasons.some((r) => r === 'controls_not_array'));
  assert.ok(v.reasons.some((r) => r.startsWith('claim_bad_status:')));
});

// ---------------------------------------------------------------------------
// 5) PDF export creates non-empty file (>1KB)
// ---------------------------------------------------------------------------

let pdfkitAvailable = true;
try {
  await import('pdfkit');
} catch {
  pdfkitAvailable = false;
}

test('R6 #5 — renderAssuranceCasePdf writes a non-empty PDF file (>1KB)', { skip: !pdfkitAvailable ? 'pdfkit not installed' : false }, async () => {
  const envelope = ac.buildAssuranceCase({ artifact: fullArtifact(), workspace: fullWorkspace() });
  const { renderAssuranceCasePdf } = await import('../src/assurance-case-pdf.js');
  const outPath = path.join(TEST_DATA_DIR, 'r6-trust-packet.pdf');
  const stream = fs.createWriteStream(outPath);
  await renderAssuranceCasePdf(envelope, stream);
  const stat = fs.statSync(outPath);
  assert.ok(stat.size > 1024, `expected >1KB pdf; got ${stat.size} bytes`);
  // Magic-bytes sanity check.
  const head = fs.readFileSync(outPath).slice(0, 4).toString('latin1');
  assert.equal(head, '%PDF', `expected PDF magic header; got ${head}`);
});

// ---------------------------------------------------------------------------
// 6) Missing inputs degrade gracefully
// ---------------------------------------------------------------------------

test('R6 #6 — thin artifact + empty workspace downgrades claims without throwing', () => {
  const envelope = ac.buildAssuranceCase({ artifact: thinArtifact(), workspace: {} });
  assert.ok(Array.isArray(envelope.claims));
  // Every claim status is still valid.
  for (const c of envelope.claims) {
    assert.ok(ac.CLAIM_STATUSES.includes(c.status));
  }
  // No claim should have status 'implemented' when neither artifact nor
  // workspace carry real evidence.
  const implemented = envelope.claims.filter((c) => c.status === 'implemented');
  assert.equal(implemented.length, 0, 'thin inputs should not produce any implemented claims');
});

// ---------------------------------------------------------------------------
// 7-10) Per-claim auto-generation logic
// ---------------------------------------------------------------------------

test('R6 #7 — data provenance: full coverage -> implemented; missing -> package-gated', () => {
  const full = ac.buildAssuranceCase({ artifact: fullArtifact(), workspace: fullWorkspace() });
  const provFull = full.claims.find((c) => /training captures/i.test(c.claim));
  assert.equal(provFull.status, 'implemented');

  // Strip the rights-holder coverage and re-build.
  const partial = fullArtifact();
  partial.manifest.evidence_dag.nodes = partial.manifest.evidence_dag.nodes.map((n) =>
    n.kind === 'rights' ? { ...n, covers: ['cap_001'] } : n
  );
  const env = ac.buildAssuranceCase({ artifact: partial, workspace: fullWorkspace() });
  const prov = env.claims.find((c) => /training captures/i.test(c.claim));
  assert.equal(prov.status, 'package-gated');
  assert.match(prov.limitations, /1 of 2 capture nodes lack a covering rights-holder/);
});

test('R6 #8 — model integrity: signed + audit-1 -> implemented', () => {
  const env = ac.buildAssuranceCase({ artifact: fullArtifact(), workspace: fullWorkspace() });
  const mi = env.claims.find((c) => /cryptographically signed/i.test(c.claim));
  assert.equal(mi.status, 'implemented');
  assert.ok(mi.evidence_ids.includes('receipt:signature:ed25519'));
});

test('R6 #9 — deployment integrity: at least one tested passport -> implemented', () => {
  const env = ac.buildAssuranceCase({ artifact: fullArtifact(), workspace: fullWorkspace() });
  const di = env.claims.find((c) => /runtime capabilities/i.test(c.claim));
  assert.equal(di.status, 'implemented');
  // 1 of 2 passports is tested -> limitations should mention the estimate count.
  assert.match(di.limitations, /1 of 2 runtime targets carry measured numbers/);
});

test('R6 #10 — drift monitoring: enabled namespace -> implemented; absent -> external-proof-needed', () => {
  const env = ac.buildAssuranceCase({ artifact: fullArtifact(), workspace: fullWorkspace() });
  const dm = env.claims.find((c) => /drift is monitored/i.test(c.claim));
  assert.equal(dm.status, 'implemented');

  const noDrift = fullWorkspace();
  noDrift.drift_namespaces = {};
  const env2 = ac.buildAssuranceCase({ artifact: fullArtifact(), workspace: noDrift });
  const dm2 = env2.claims.find((c) => /drift is monitored/i.test(c.claim));
  assert.equal(dm2.status, 'external-proof-needed');
});

// ---------------------------------------------------------------------------
// 11) Constraint: no warm colours in PDF colour spec
// ---------------------------------------------------------------------------

test('R6 #11 — PDF colour palette contains no browns / beiges / oranges', async () => {
  // The PDF module is allowed to import even without pdfkit (the lazy import
  // happens inside renderAssuranceCasePdf, not at module top).
  const { COLOR } = await import('../src/assurance-case-pdf.js');
  // Forbidden warm-palette substrings the spec rejects. Hex tokens are
  // compared lowercase; we just check none of the canonical "orange" /
  // "brown" / "beige" CSS named colours appear and that no chosen hex
  // sits in the warm 30-60° hue range we're avoiding.
  const all = Object.values(COLOR).map((v) => String(v).toLowerCase());
  for (const c of all) {
    assert.ok(/^#[0-9a-f]{6}$/.test(c), `colour must be hex: ${c}`);
  }
  // Heuristic: every chosen palette value above has red <= green or blue
  // dominance, which excludes typical orange/brown/beige (R > G > B with R high).
  // We verify by checking no entry matches the orange-family signature
  // R in [180,255] AND G in [100,180] AND B in [0,120].
  function rgb(hex) {
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  }
  for (const c of all) {
    const [r, g, b] = rgb(c);
    const orangeFamily = r >= 180 && g >= 100 && g <= 180 && b <= 120 && r > b;
    assert.equal(orangeFamily, false, `colour ${c} sits in orange/brown family — forbidden by R-6 spec`);
  }
});
