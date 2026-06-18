import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  ARTIFACT_CLASSES,
  HETEROGENEOUS_WEIGHTS_VERSION,
  addHeterogeneousWeights,
  buildRecipeBundleMjs,
  decodeIndex,
  decodePack,
  verifyDeviceFit,
  verifyManifestSignature,
} from '../src/artifact.js';

const ROOT = path.resolve('.');
const MATRIX_PATH = path.join(ROOT, 'docs', 'internal', 'artifact-matrix.json');

function readJson(relOrAbs) {
  return JSON.parse(fs.readFileSync(path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs), 'utf8'));
}

function matrix() {
  assert.ok(fs.existsSync(MATRIX_PATH), 'artifact-matrix.json must exist');
  return readJson(MATRIX_PATH);
}

function framedJson(magic, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length, 0);
  return Buffer.concat([Buffer.from(magic, 'binary'), len, body]);
}

test('W948 package wiring makes the artifact matrix a depth and control-file gate', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.scripts['build:artifact-matrix'], 'node scripts/build-artifact-matrix.cjs');
  assert.equal(
    pkg.scripts['verify:artifact-matrix'],
    'node scripts/build-artifact-matrix.cjs --check --summary && node --test --test-concurrency=1 tests/wave948-artifact-matrix.test.js',
  );
  assert.match(pkg.scripts['build:control-files'], /build:data-curate-matrix && npm run build:artifact-matrix && npm run build:tui-workbench-matrix && npm run build:bench-harness-matrix && npm run build:otel-matrix && npm run build:file-ledger/);
  assert.match(pkg.scripts['verify:control-files'], /verify:data-curate-matrix && npm run verify:artifact-matrix && npm run verify:tui-workbench-matrix && npm run verify:bench-harness-matrix && npm run verify:otel-matrix && npm run verify:file-ledger/);
  assert.match(pkg.scripts['verify:depth'], /verify:spec-compile-matrix && npm run verify:data-curate-matrix && npm run verify:artifact-matrix && npm run verify:tui-workbench-matrix && npm run verify:bench-harness-matrix && npm run verify:otel-matrix && npm run verify:meta-routes/);

  const ledgerBuilder = fs.readFileSync(path.join(ROOT, 'scripts', 'build-codebase-file-ledger.cjs'), 'utf8');
  assert.match(ledgerBuilder, /build-artifact-matrix\.cjs/);
  assert.match(ledgerBuilder, /docs\/internal\/artifact-matrix\.json/);

  const releaseVerify = fs.readFileSync(path.join(ROOT, 'scripts', 'release-verify.cjs'), 'utf8');
  assert.match(releaseVerify, /docs\/internal\/artifact-matrix\.json/);
  assert.match(releaseVerify, /kolm\.artifact_matrix\.v1/);

  const backendAtomic = fs.readFileSync(path.join(ROOT, 'scripts', 'build-backend-atomic-deep-dive.mjs'), 'utf8');
  assert.match(backendAtomic, /ARTIFACT_MATRIX/);
  assert.match(backendAtomic, /maintain_generated_artifact_matrix_and_signed_artifact_runtime_contract/);
  assert.match(backendAtomic, /npm run verify:artifact-matrix/);
});

test('W948 generated matrix is current and all hard artifact gates are green', () => {
  execFileSync(process.execPath, ['scripts/build-artifact-matrix.cjs', '--check', '--summary'], {
    cwd: ROOT,
    stdio: 'pipe',
    timeout: 60_000,
  });
  const m = matrix();

  assert.equal(m.schema, 'kolm.artifact_matrix.v1');
  assert.equal(m.updated_at, '2026-06-18');
  assert.equal(m.gates.ok, true, JSON.stringify(m.gates.failures, null, 2));
  assert.deepEqual(m.gates.failures, []);
  assert.deepEqual(m.gates.warnings, []);
  assert.equal(m.summary.export_count, 12);
  assert.ok(m.summary.function_count >= 30);
  assert.equal(m.summary.env_ref_count, 9);
  assert.ok(m.summary.build_payload_field_count >= 61);
  assert.ok(m.summary.build_and_zip_field_count >= 57);
  assert.ok(m.summary.artifact_hash_slot_count >= 35);
  assert.equal(m.summary.phase_count, 35);
  assert.equal(m.summary.present_phase_count, 35);
  assert.equal(m.summary.missing_required_exports, 0);
  assert.equal(m.summary.failed_safety_guards, 0);
  assert.equal(m.summary.missing_test_evidence, 0);
  assert.ok(m.summary.direct_test_evidence_count >= 90);
});

test('W948 matrix captures artifact phases, hash slots, ZIP members, and evidence', () => {
  const m = matrix();
  assert.equal(Object.values(m.safety_guards).every(Boolean), true, JSON.stringify(m.failed_safety_guards, null, 2));
  assert.deepEqual(m.failed_safety_guards, []);
  assert.ok(m.sources.includes('src/artifact.js'));
  assert.ok(m.sources.includes('src/sigstore.js'));
  assert.ok(m.sources.includes('src/intoto-slsa.js'));
  assert.ok(m.sources.includes('src/output-schema.js'));

  const phases = new Set(m.artifact_phases.map((row) => row.phase));
  for (const phase of [
    'sign_secret_resolution',
    'recipe_bundle_esm',
    'reproducible_build_context',
    'kscore_conformal_gate',
    'contamination_impact_gate',
    'runtime_passports',
    'evidence_dag',
    'output_schema_guardrails',
    'model_weights_runtime_target',
    'artifact_hash_chain_slots',
    'receipt_hmac_chain',
    'ed25519_sigstore_signing',
    'model_signing_sidecars',
    'rekor_pinning_policy',
    'heterogeneous_weights',
  ]) {
    assert.ok(phases.has(phase), `missing phase ${phase}`);
  }

  const slots = new Set(m.artifact_hash_slots);
  for (const slot of ['export_hash', 'moe_hash', 'pretokenize_hash', 'external_holdout_hash', 'tenant_shadow_corpus_hash', 'auditor_attestation_hash', 'supersession_hash', 'drift_report_hash', 'output_schema_hash', 'guardrails_hash', 'recipe_bundle_mjs_hash', 'model_weights_hash']) {
    assert.ok(slots.has(slot), `missing hash slot ${slot}`);
  }

  const members = new Set(m.zip_member_names);
  for (const member of ['manifest.json', 'recipes.json', 'evals.json', 'signature.sig', 'receipt.json', 'credential.json', 'recipe.bundle.mjs', 'provenance.intoto.dsse.json', 'model.sig.bundle']) {
    assert.ok(members.has(member), `missing ZIP member ${member}`);
  }

  const evidence = new Set(m.test_evidence.map((row) => row.path));
  for (const rel of m.required_test_evidence) assert.ok(evidence.has(rel), `missing evidence ${rel}`);
});

test('W948 artifact runtime primitives stay framed, versioned, and bounded', async () => {
  for (const klass of ['rule', 'synthesized_rule', 'compiled_rule', 'distilled_model']) {
    assert.ok(ARTIFACT_CLASSES.includes(klass), `missing artifact class ${klass}`);
  }
  assert.equal(HETEROGENEOUS_WEIGHTS_VERSION, 'w829-v1');

  assert.deepEqual(decodePack(framedJson('KOLMPACK\x01', { table: ['a'] })), { table: ['a'] });
  assert.deepEqual(decodeIndex(framedJson('KOLMIDX\x01', { lookup: { a: 1 } })), { lookup: { a: 1 } });
  assert.throws(() => decodePack(Buffer.from('bad')), /container too short|container magic mismatch/);

  const bundle = buildRecipeBundleMjs([
    {
      id: 'r1',
      name: 'rule one',
      source: 'function generate(input, lib) { return `${lib.params.prefix}:${input.value}`; }',
    },
  ], { spec: 'kolm-1', job_id: 'job_w948', generated_at: '2026-06-18T00:00:00.000Z' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w948-artifact-'));
  try {
    const bundlePath = path.join(tmp, 'recipe.bundle.mjs');
    fs.writeFileSync(bundlePath, bundle);
    const mod = await import(pathToFileURL(bundlePath).href);
    const out = await mod.default({ value: 'ok' }, { params: { prefix: 'p' } });
    assert.equal(out.output, 'p:ok');
    assert.equal(out.recipe_id, 'r1');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const builder = addHeterogeneousWeights({ files: [], manifest: {} }, {
    text_weights: Buffer.from('text'),
    vision_encoder: { kind: 'siglip', content: Buffer.from('vision') },
    tool_use_head: { kind: 'tool-use-head-v1', content: Buffer.from('tool') },
  });
  assert.deepEqual(builder.manifest.heterogeneous_weights.present_modalities, ['text', 'vision', 'tool_use']);
  assert.equal(builder.files.length, 3);
  assert.throws(() => addHeterogeneousWeights({ files: [], manifest: {} }, {
    vision_encoder: { kind: 'unknown', content: Buffer.from('x') },
  }), /vision_encoder\.kind/);

  const noTarget = await verifyDeviceFit({ target_device: null }, 'unknown');
  assert.equal(noTarget.ok, true);
  assert.equal(noTarget.soft, true);

  const saved = process.env.RECIPE_RECEIPT_SECRET;
  process.env.RECIPE_RECEIPT_SECRET = 'w948-secret';
  try {
    assert.equal(verifyManifestSignature('{}', { spec: 'kolm-1' }).valid, false);
  } finally {
    if (saved === undefined) delete process.env.RECIPE_RECEIPT_SECRET;
    else process.env.RECIPE_RECEIPT_SECRET = saved;
  }
});
