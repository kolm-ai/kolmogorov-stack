import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve('.');
const MATRIX_PATH = path.join(ROOT, 'docs', 'internal', 'binder-contract-matrix.json');

function readJson(relOrAbs) {
  return JSON.parse(fs.readFileSync(path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs), 'utf8'));
}

function matrix() {
  assert.ok(fs.existsSync(MATRIX_PATH), 'binder-contract-matrix.json must exist');
  return readJson(MATRIX_PATH);
}

test('W942 package wiring makes the binder contract matrix a depth and control-file gate', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.scripts['build:binder-contract-matrix'], 'node scripts/build-binder-contract-matrix.cjs');
  assert.equal(
    pkg.scripts['verify:binder-contract-matrix'],
    'node scripts/build-binder-contract-matrix.cjs --check --summary && node --test --test-concurrency=1 tests/wave942-binder-contract-matrix.test.js',
  );
  assert.match(pkg.scripts['build:control-files'], /build:quantize-worker-matrix && npm run build:binder-contract-matrix && npm run build:file-ledger/);
  assert.match(pkg.scripts['verify:control-files'], /verify:quantize-worker-matrix && npm run verify:binder-contract-matrix && npm run verify:file-ledger/);
  assert.match(pkg.scripts['verify:depth'], /verify:daemon-connector-matrix && npm run verify:binder-contract-matrix && npm run verify:meta-routes/);

  const ledgerBuilder = fs.readFileSync(path.join(ROOT, 'scripts', 'build-codebase-file-ledger.cjs'), 'utf8');
  assert.match(ledgerBuilder, /build-binder-contract-matrix\.cjs/);
  assert.match(ledgerBuilder, /docs\/internal\/binder-contract-matrix\.json/);

  const releaseVerify = fs.readFileSync(path.join(ROOT, 'scripts', 'release-verify.cjs'), 'utf8');
  assert.match(releaseVerify, /docs\/internal\/binder-contract-matrix\.json/);
  assert.match(releaseVerify, /kolm\.binder_contract_matrix\.v1/);

  const backendAtomic = fs.readFileSync(path.join(ROOT, 'scripts', 'build-backend-atomic-deep-dive.mjs'), 'utf8');
  assert.match(backendAtomic, /BINDER_CONTRACT_MATRIX/);
  assert.match(backendAtomic, /maintain_generated_binder_contract_matrix_and_verifier_failure_taxonomy/);
  assert.match(backendAtomic, /npm run verify:binder-contract-matrix/);
});

test('W942 generated matrix is current and all hard binder gates are green', () => {
  execFileSync(process.execPath, ['scripts/build-binder-contract-matrix.cjs', '--check', '--summary'], {
    cwd: ROOT,
    stdio: 'pipe',
    timeout: 60_000,
  });
  const m = matrix();

  assert.equal(m.schema, 'kolm.binder_contract_matrix.v1');
  assert.equal(m.updated_at, '2026-06-18');
  assert.equal(m.gates.ok, true, JSON.stringify(m.gates.failures, null, 2));
  assert.deepEqual(m.gates.failures, []);
  assert.deepEqual(m.gates.warnings, []);
  assert.equal(m.summary.import_count, 22);
  assert.equal(m.summary.export_count, 5);
  assert.equal(m.summary.internal_function_count, 21);
  assert.equal(m.summary.verification_check_push_count, 104);
  assert.equal(m.summary.verification_check_family_count, 31);
  assert.equal(m.summary.missing_required_check_families, 0);
  assert.equal(m.summary.structured_check_mapping_count, 12);
  assert.equal(m.summary.structured_reason_count, 6);
  assert.equal(m.summary.render_section_count, 10);
  assert.equal(m.summary.bundled_hash_slot_count, 8);
  assert.equal(m.summary.required_test_evidence_count, 22);
  assert.ok(m.summary.direct_test_evidence_count >= 23);
  assert.equal(m.summary.missing_required_exports, 0);
  assert.equal(m.summary.failed_safety_guards, 0);
  assert.equal(m.summary.missing_test_evidence, 0);
});

test('W942 matrix captures public exports, verifier families, and structured errors', () => {
  const m = matrix();
  const exports = new Set(m.exports.map((row) => row.name));
  for (const name of ['buildBinder', 'writeBinder', 'verifyArtifactStructured', 'recordFingerprintShare', 'BINDER']) {
    assert.ok(exports.has(name), `missing export ${name}`);
  }

  const families = new Set(m.verification_check_families.map((row) => row.name));
  for (const name of [
    'Manifest signature (legacy HMAC)',
    'Content identifier (CID) round-trip',
    'Runtime target consistency',
    'Audit chain (HMAC receipt)',
    'Receipt signature (Ed25519, public-key)',
    'Receipt signature (Sigstore bundle)',
    'Provenance sidecars (SLSA/OMS, signer-derived)',
    'Seed gate (train/holdout independence)',
    'Attestation state',
    'Third-party auditor attestation',
    'Supersession chain',
    'Drift report',
    'Corpus URL licensing gate',
  ]) {
    assert.ok(families.has(name), `missing verifier family ${name}`);
  }

  assert.deepEqual(m.structured_failure_taxonomy.stable_reasons, [
    'manifest_hash_mismatch',
    'native_binary_missing',
    'production_check_failed_on_install',
    'signature_invalid',
    'synthetic_only_in_production',
    'train_holdout_leakage',
  ]);
  const fields = new Set(m.structured_failure_taxonomy.mappings.map((row) => row.failing_field));
  for (const field of ['signature.sig', 'receipt.signature_ed25519', 'receipt.signature_sigstore', 'manifest.cid', 'manifest.runtime_target', 'manifest.seed_provenance']) {
    assert.ok(fields.has(field), `missing structured failing field ${field}`);
  }
});

test('W942 matrix captures render sections, hash slots, safety guards, and tests', () => {
  const m = matrix();
  assert.equal(Object.values(m.safety_guards).every(Boolean), true);

  const renderers = new Set(m.render_sections.map((row) => row.name));
  for (const name of ['renderHead', 'renderSummary', 'renderIdentity', 'renderKScore', 'renderHashes', 'renderChain', 'renderCredential', 'renderEvals', 'renderReproduction', 'renderFooter']) {
    assert.ok(renderers.has(name), `missing renderer ${name}`);
  }

  const slots = new Map(m.bundled_hash_slots.map((row) => [row.manifest_hash_key, row.zip_entry]));
  assert.equal(slots.get('model_pointer'), 'model.gguf');
  assert.equal(slots.get('recipes_json'), 'recipes.json');
  assert.equal(slots.get('workflow_ir'), 'workflow_ir.json');
  assert.equal(slots.get('attestation_report'), 'attestation_report.json');

  const evidence = new Map(m.test_evidence.map((row) => [row.path, row]));
  for (const rel of m.required_test_evidence) {
    assert.ok(evidence.has(rel), `${rel} must be direct binder evidence`);
  }
});
