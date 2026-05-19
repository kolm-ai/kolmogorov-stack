// W460 — confidential compute attestation report embed into .kolm RS-1 receipt.
//
// Closes audit P1 Confidential Compute cluster open item:
//   "attestation report embed in .kolm RS-1 receipt; enclave-build CI;
//    verification path."
//
// Shipped:
//   - spec-compile.js accepts opts.attestation_report (path or object) +
//     opts.attestation_kind ('pccs' | 'snp-report' | 'nitro-attestation' | 'nras')
//   - artifact.js (already wired W144/W409v) runs verifyAttestation, embeds
//     state as manifest.confidential_compute, binds confidential_compute_hash
//     into artifact_hash so any post-build tamper invalidates the receipt
//   - cli/kolm.js compile: --attestation-report <file> + --attestation-kind <kind>
//   - cli/kolm.js verify: --attestation pretty-prints the embedded block
//
// Tests assert behavior — manifest shape, artifact_hash binding, state
// progression (shape_ok default → cryptographically_verified with verifier
// plugin → rejected on tampered report).
//
// Why this test pattern: every check goes through the live spec-compile.js
// path (no shortcut into artifact.js with hand-built inputs), so a future
// refactor that breaks the spec→artifact wiring fails loudly here even if
// artifact.js's unit tests stay green.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { compileSpec } from '../src/spec-compile.js';
import { loadArtifact } from '../src/artifact-runner.js';
import {
  KINDS,
  STATES,
  registerAttestationVerifier,
  clearAttestationVerifier,
} from '../src/confidential-compute.js';

process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';

const TMP = path.join(os.tmpdir(), 'kolm-wave460-' + crypto.randomBytes(3).toString('hex'));
fs.mkdirSync(TMP, { recursive: true });

function writeSeeds(filename, count = 30) {
  const rows = Array.from({ length: count }, (_, i) => ({
    input: { text: 'row-' + i },
    output: { echo: 'row-' + i },
  }));
  const p = path.join(TMP, filename);
  fs.writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

function basicSpec(jobId = 'job_wave460') {
  return {
    job_id: jobId,
    task: 'W460 confidential compute attestation smoke',
    base_model: 'none',
    recipes: [
      {
        id: 'rcp_w460',
        name: 'Echo recipe',
        source: 'function generate(input, lib) { return { echo: String(input.text || input) }; }',
      },
    ],
  };
}

// A happy PCCS quote report — every required field present + right type.
// Required-fields contract from src/confidential-compute.js REPORT_SHAPES[pccs]:
//   quote, tee_type, tcb_evaluation_data_number, mr_td, mr_seam,
//   rtmr0..rtmr3, report_data
function happyPccsReport(over = {}) {
  return {
    tee_type: 'TDX',
    quote: 'aa'.repeat(64),                           // base64-or-hex
    tcb_evaluation_data_number: 17,
    mr_td:       'a'.repeat(64),                      // hex64
    mr_seam:     'b'.repeat(64),                      // hex64
    rtmr0:       'c'.repeat(96),                      // hex96
    rtmr1:       'd'.repeat(96),                      // hex96
    rtmr2:       'e'.repeat(96),                      // hex96
    rtmr3:       'f'.repeat(96),                      // hex96
    report_data: '1'.repeat(128),                     // hex128
    ...over,
  };
}

test('W460 #1 — compileSpec with --attestation-report+kind embeds confidential_compute block (shape_ok default)', async () => {
  const seedsPath = writeSeeds('w460-1.jsonl');
  const reportPath = path.join(TMP, 'pccs-1.json');
  fs.writeFileSync(reportPath, JSON.stringify(happyPccsReport(), null, 2));

  const outPath = path.join(TMP, 'w460-1.kolm');
  await compileSpec(basicSpec('job_w460_1'), {
    seedsPath,
    comparator: 'json_subset',
    outDir: TMP,
    outPath,
    attestation_report: reportPath,
    attestation_kind: 'pccs',
  });
  const art = loadArtifact(outPath);
  const cc = art.manifest.confidential_compute;
  assert.ok(cc, 'manifest.confidential_compute must be present after --attestation-report');
  assert.equal(cc.kind, 'pccs');
  assert.equal(cc.state, STATES.SHAPE_OK, 'no plugin registered → state=shape_ok');
  assert.equal(cc.verified, false, 'shape_ok must NEVER claim verified:true');
  assert.equal(typeof cc.report_hash, 'string');
  assert.equal(cc.report_hash.length, 64, 'sha256 report_hash is 64 hex chars');
});

test('W460 #2 — pre-loaded report object (not a path) is accepted', async () => {
  const seedsPath = writeSeeds('w460-2.jsonl');
  const outPath = path.join(TMP, 'w460-2.kolm');
  await compileSpec(basicSpec('job_w460_2'), {
    seedsPath,
    comparator: 'json_subset',
    outDir: TMP,
    outPath,
    attestation_report: happyPccsReport(),     // object, not path
    attestation_kind: 'pccs',
  });
  const art = loadArtifact(outPath);
  assert.equal(art.manifest.confidential_compute.state, STATES.SHAPE_OK);
});

test('W460 #3 — confidential_compute_hash binds into artifact_hash (tamper detection)', async () => {
  const seedsPath = writeSeeds('w460-3.jsonl');
  const reportA = happyPccsReport({ report_data: '1'.repeat(128) });
  const reportB = happyPccsReport({ report_data: '2'.repeat(128) });

  const outA = path.join(TMP, 'w460-3a.kolm');
  const outB = path.join(TMP, 'w460-3b.kolm');
  await compileSpec(basicSpec('job_w460_3a'), {
    seedsPath, comparator: 'json_subset', outDir: TMP, outPath: outA,
    attestation_report: reportA, attestation_kind: 'pccs',
  });
  await compileSpec(basicSpec('job_w460_3a'), {
    seedsPath, comparator: 'json_subset', outDir: TMP, outPath: outB,
    attestation_report: reportB, attestation_kind: 'pccs',
  });
  const artA = loadArtifact(outA);
  const artB = loadArtifact(outB);
  // Same spec, same seeds — only attestation differs. artifact_hash MUST
  // differ, proving the attestation block is bound into the hash.
  assert.notEqual(
    artA.receipt.artifact_hash,
    artB.receipt.artifact_hash,
    'attestation report change must flow into artifact_hash',
  );
  // And both report_hashes must be present and distinct.
  assert.notEqual(
    artA.manifest.confidential_compute.report_hash,
    artB.manifest.confidential_compute.report_hash,
  );
});

test('W460 #4 — registered crypto verifier upgrades state to cryptographically_verified', async () => {
  const seedsPath = writeSeeds('w460-4.jsonl');
  const reportPath = path.join(TMP, 'pccs-4.json');
  fs.writeFileSync(reportPath, JSON.stringify(happyPccsReport(), null, 2));

  // Register a fake crypto verifier for pccs kind, build artifact, then clear.
  registerAttestationVerifier(KINDS.PCCS, async () => ({
    ok: true,
    verifier: 'w460-test-fake-crypto',
    trust_root: 'test-root',
  }));
  try {
    const outPath = path.join(TMP, 'w460-4.kolm');
    await compileSpec(basicSpec('job_w460_4'), {
      seedsPath, comparator: 'json_subset', outDir: TMP, outPath,
      attestation_report: reportPath, attestation_kind: 'pccs',
    });
    const art = loadArtifact(outPath);
    const cc = art.manifest.confidential_compute;
    assert.equal(cc.state, STATES.CRYPTOGRAPHICALLY_VERIFIED);
    assert.equal(cc.verified, true);
    assert.equal(cc.verifier, 'w460-test-fake-crypto');
    assert.equal(cc.trust_root, 'test-root');
  } finally {
    clearAttestationVerifier(KINDS.PCCS);
  }
});

test('W460 #5 — malformed report (missing required field) → state=rejected, verified:false', async () => {
  const seedsPath = writeSeeds('w460-5.jsonl');
  const broken = happyPccsReport();
  delete broken.mr_td;                          // chop a required field

  const outPath = path.join(TMP, 'w460-5.kolm');
  await compileSpec(basicSpec('job_w460_5'), {
    seedsPath, comparator: 'json_subset', outDir: TMP, outPath,
    attestation_report: broken, attestation_kind: 'pccs',
  });
  const art = loadArtifact(outPath);
  const cc = art.manifest.confidential_compute;
  assert.equal(cc.state, STATES.REJECTED);
  assert.equal(cc.verified, false);
});

test('W460 #6 — missing attestation_kind on report-without-_kind throws clear error', async () => {
  const seedsPath = writeSeeds('w460-6.jsonl');
  const outPath = path.join(TMP, 'w460-6.kolm');
  await assert.rejects(
    () => compileSpec(basicSpec('job_w460_6'), {
      seedsPath, comparator: 'json_subset', outDir: TMP, outPath,
      attestation_report: happyPccsReport(),    // no kind hint
      // attestation_kind intentionally omitted
    }),
    /attestation_report supplied without an attestation kind/i,
  );
});

test('W460 #7 — missing attestation_report file path throws path-load error', async () => {
  const seedsPath = writeSeeds('w460-7.jsonl');
  const outPath = path.join(TMP, 'w460-7.kolm');
  await assert.rejects(
    () => compileSpec(basicSpec('job_w460_7'), {
      seedsPath, comparator: 'json_subset', outDir: TMP, outPath,
      attestation_report: path.join(TMP, 'nope.json'),  // doesn't exist
      attestation_kind: 'pccs',
    }),
    /attestation_report path .* failed to load/i,
  );
});

test('W460 #8 — no attestation_report opt → manifest.confidential_compute absent (existing behavior preserved)', async () => {
  const seedsPath = writeSeeds('w460-8.jsonl');
  const outPath = path.join(TMP, 'w460-8.kolm');
  await compileSpec(basicSpec('job_w460_8'), {
    seedsPath, comparator: 'json_subset', outDir: TMP, outPath,
  });
  const art = loadArtifact(outPath);
  // The pre-W460 path either omits the field entirely or sets it to null —
  // both are "no attestation embedded" and either is acceptable. The
  // load-bearing assertion is that state is NOT shape_ok / verified.
  const cc = art.manifest.confidential_compute;
  assert.ok(
    cc == null || cc.state === STATES.UNVERIFIED || cc.verified === false,
    'no-attestation path must not silently claim verified:true',
  );
});

test('W460 #9 — source pin: spec-compile.js threads attestation_report+kind to buildAndZip', async () => {
  // Static-source pin so a future refactor that drops the wiring fails this
  // test loudly. We check the literal call site in src/spec-compile.js.
  const src = fs.readFileSync(
    new URL('../src/spec-compile.js', import.meta.url),
    'utf8',
  );
  assert.ok(
    /attestation_report:\s*attestationReportObj/.test(src),
    'spec-compile.js must pass attestation_report to buildAndZip',
  );
  assert.ok(
    /opts\.attestation_kind/.test(src),
    'spec-compile.js must read opts.attestation_kind',
  );
  assert.ok(
    /attestation_report supplied without an attestation kind/.test(src),
    'spec-compile.js must reject report without a kind hint',
  );
});

test('W460 #10 — sw.js CACHE references the wave460 family pattern', async () => {
  const sw = fs.readFileSync(
    new URL('../public/sw.js', import.meta.url),
    'utf8',
  );
  assert.ok(
    /wave46\d-/.test(sw),
    'public/sw.js CACHE slug should reference the wave460-wave469 family',
  );
});
