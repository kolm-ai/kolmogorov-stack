import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EXECUTORCH_RUNTIME,
  EXECUTORCH_VALIDATION_SCHEMA,
  EXECUTORCH_VALIDATION_VERSION,
  buildExecuTorchValidationPlan,
  execuTorchRuntimePassportEntry,
  validateExecuTorchDeviceReport,
} from '../src/executorch-validation-harness.js';
import {
  buildModelWeightArtifactManifest,
  signModelWeightArtifactManifest,
  verifyModelWeightArtifactManifest,
} from '../src/model-weights-manifest.js';
import { generateKeyPair, keyFingerprint } from '../src/ed25519.js';
import {
  RUNTIME_PASSPORT_FIELDS_V2,
  estimatePassport,
  generateRuntimePassport,
  recordTestedPassport,
  validatePassport,
} from '../src/runtime-passport.js';
import { MODEL_FRAMEWORK_TARGETS, validatePlatformCapabilities } from '../src/platform-capabilities.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_PATH = path.join(ROOT, 'docs', 'STACK-TECH-SPEC-2026-06-15.md');

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function signer() {
  const { publicKey, privateKey } = generateKeyPair();
  return { publicKey, privateKey, key_fingerprint: keyFingerprint(publicKey) };
}

function reportFor(plan, overrides = {}) {
  return {
    schema: EXECUTORCH_VALIDATION_SCHEMA,
    version: EXECUTORCH_VALIDATION_VERSION,
    runtime: EXECUTORCH_RUNTIME,
    platform: plan.platform,
    target_id: plan.target_id,
    device_side: true,
    device: { id: plan.device.id || 'emulator-5554', model: 'Pixel 9 Pro', os_version: 'Android 16' },
    artifact_sha256: plan.artifact.artifact_sha256,
    manifest_sha256: plan.artifact.manifest_sha256,
    model_pte_sha256: plan.model.model_pte_sha256,
    model_pte_bytes: 123456,
    executorch_version: '0.6.0',
    sig_ok: true,
    load_ok: true,
    inference_ok: true,
    prompt_count: plan.prompts.length,
    output_digest_sha256: sha256('OK'),
    latency_p50_ms: 18,
    latency_p95_ms: 31,
    ttft_ms: 21,
    tok_s: 42.5,
    memory_mb: 256,
    precision: 'int4',
    quality_delta: 0,
    ...overrides,
  };
}

test('W1025 builds fail-closed ExecuTorch Android and iOS validation plans', () => {
  const hash = sha256('model.pte');
  const manifestHash = sha256('manifest');
  const android = buildExecuTorchValidationPlan({
    platform: 'android',
    pte_path: 'build/model.pte',
    model_pte_sha256: hash,
    manifest_sha256: manifestHash,
    device_id: 'emulator-5554',
    package_name: 'ai.kolm.executorchprobe.test',
  });

  assert.equal(android.runtime, EXECUTORCH_RUNTIME);
  assert.equal(android.device_side, true);
  assert.equal(android.platform, 'android');
  assert.equal(android.model.model_pte_sha256, hash);
  assert.equal(android.artifact.manifest_sha256, manifestHash);
  assert.equal(android.requirements.signed_weights, true);
  assert.deepEqual(android.commands.map((c) => c.tool), ['adb', 'adb']);
  assert.ok(android.commands[1].argv.includes('instrument'));
  assert.ok(Object.isFrozen(android));

  const ios = buildExecuTorchValidationPlan({
    platform: 'simulator',
    pte_path: 'DerivedData/model.pte',
    model_pte_sha256: hash,
    artifact_sha256: sha256('artifact'),
    udid: 'booted',
    bundle_id: 'ai.kolm.ExecuTorchProbe',
  });
  assert.equal(ios.platform, 'ios');
  assert.equal(ios.commands[0].tool, 'xcrun');
  assert.ok(ios.commands[0].argv.includes('launch'));

  assert.throws(
    () => buildExecuTorchValidationPlan({ platform: 'android', pte_path: 'model.bin', model_pte_sha256: hash, manifest_sha256: manifestHash }),
    /\.pte/,
  );
  assert.throws(
    () => buildExecuTorchValidationPlan({ platform: 'android', pte_path: 'model.pte', model_pte_sha256: hash }),
    /artifact_sha256 or manifest_sha256/,
  );
});

test('W1025 validates device-side report and binds it to the plan', () => {
  const plan = buildExecuTorchValidationPlan({
    platform: 'android',
    pte_path: 'model.pte',
    model_pte_sha256: sha256('pte'),
    artifact_sha256: sha256('artifact'),
    manifest_sha256: sha256('manifest'),
    prompts: [{ id: 'ok', prompt: 'OK?', max_tokens: 8 }],
  });
  const report = reportFor(plan);
  assert.deepEqual(validateExecuTorchDeviceReport(report, plan), {
    ok: true,
    platform: 'android',
    target_id: plan.target_id,
    model_pte_sha256: plan.model.model_pte_sha256,
    artifact_sha256: plan.artifact.artifact_sha256,
    manifest_sha256: plan.artifact.manifest_sha256,
  });

  assert.equal(validateExecuTorchDeviceReport({ ...report, sig_ok: false }, plan).ok, false);
  assert.match(validateExecuTorchDeviceReport({ ...report, sig_ok: false }, plan).reason, /sig_ok/);
  assert.match(validateExecuTorchDeviceReport({ ...report, model_pte_sha256: sha256('other') }, plan).reason, /model_pte_sha256 does not match plan/);
  assert.match(validateExecuTorchDeviceReport({ ...report, latency_p95_ms: 1 }, plan).reason, />= latency_p50/);
  assert.match(validateExecuTorchDeviceReport({ ...report, device_side: false }, plan).reason, /device_side/);
});

test('W1025 converts valid ExecuTorch device reports into runtime passport entries', () => {
  const plan = buildExecuTorchValidationPlan({
    platform: 'android',
    pte_path: 'model.pte',
    model_pte_sha256: sha256('pte-passport'),
    manifest_sha256: sha256('manifest-passport'),
  });
  const report = reportFor(plan);
  const passport = execuTorchRuntimePassportEntry(report, { plan, fallback: 'gguf-q4_k_m-llama.cpp' });

  assert.equal(passport.schema_version, 'kolm-runtime-passport-2');
  assert.equal(passport.status, 'tested');
  assert.equal(passport.runtime, EXECUTORCH_RUNTIME);
  assert.equal(passport.file_hash, `sha256:${plan.model.model_pte_sha256}`);
  assert.equal(passport.fallback, 'gguf-q4_k_m-llama.cpp');
  assert.equal(passport.executorch_device_validation.sig_ok, true);
  assert.equal(passport.executorch_device_validation.platform, 'android');
  assert.ok(RUNTIME_PASSPORT_FIELDS_V2.includes('executorch_device_validation'));

  const v1 = recordTestedPassport({
    target_id: 'executorch-android-pixel9',
    runtime: EXECUTORCH_RUNTIME,
    runtime_version: 'executorch 0.6.0',
    precision: 'int4',
    memory_mb: 256,
    latency_p50_ms: 18,
    latency_p95_ms: 31,
    tok_s: 42.5,
    quality_delta: 0,
  });
  assert.equal(validatePassport(v1).ok, true);
});

test('W1025 signed weight manifests infer .pte as ExecuTorch runtime target', () => {
  const pte = Buffer.from('executorch-pte-fixture');
  const manifest = buildModelWeightArtifactManifest({
    artifact_id: 'artifact:executorch:int4',
    model_id: 'local/mobile-student',
    variant: 'int4-pte',
    files: [{ path: 'mobile/model.pte', bytes: pte.length, sha256: sha256(pte) }],
    created_at: '2026-06-19T00:00:00.000Z',
  });

  assert.equal(manifest.files[0].format, 'pte');
  assert.deepEqual(manifest.runtime_targets, [EXECUTORCH_RUNTIME]);
  assert.deepEqual(manifest.files[0].runtime_targets, [EXECUTORCH_RUNTIME]);
  const signed = signModelWeightArtifactManifest(manifest, signer(), { signed_at: manifest.created_at });
  assert.equal(verifyModelWeightArtifactManifest(signed, { require_signature: true }).ok, true);
});

test('W1025 runtime passport estimator recognizes .pte artifacts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w1025-pte-'));
  const ptePath = path.join(dir, 'student-int4.pte');
  fs.writeFileSync(ptePath, Buffer.from('pte bytes'));

  const generated = await generateRuntimePassport(ptePath, null, 'android');
  assert.equal(generated.runtime, EXECUTORCH_RUNTIME);
  assert.equal(generated.precision, 'int4');
  assert.equal(generated.file_hash, `sha256:${sha256(Buffer.from('pte bytes'))}`);

  const passport = estimatePassport({
    target_id: 'executorch-android-estimated',
    runtime: EXECUTORCH_RUNTIME,
    runtime_version: 'estimated',
    precision: 'int4',
    params_b: 1,
  });
  assert.equal(validatePassport(passport).ok, true);
});

test('W1025 platform matrix cites local ExecuTorch validation harness evidence', () => {
  const row = MODEL_FRAMEWORK_TARGETS.find((target) => target.id === 'executorch');
  assert.ok(row);
  assert.equal(row.status, 'manifest-supported');
  assert.ok(row.evidence.includes('src/executorch-validation-harness.js'));
  assert.ok(row.evidence.includes('apps/export/executorch.py'));
  assert.equal(validatePlatformCapabilities().ok, true);
});

test('W1025 backend spec records ExecuTorch validation harness closure', () => {
  const spec = fs.readFileSync(SPEC_PATH, 'utf8');
  assert.match(spec, /CLOSED W1025: ExecuTorch device validation harness/i);
  assert.match(spec, /src\/executorch-validation-harness\.js/i);
  assert.doesNotMatch(spec, /\[minor\] ExecuTorch exporter exists/i);
});
