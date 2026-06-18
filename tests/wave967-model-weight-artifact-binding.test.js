import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { generateKeyPair, keyFingerprint } from '../src/ed25519.js';
import {
  MODEL_WEIGHT_ARTIFACT_MANIFEST_FILENAME,
  MODEL_WEIGHT_ARTIFACT_MANIFEST_SCHEMA,
  buildModelWeightArtifactManifest,
  canonicalModelWeightArtifactManifest,
  hashModelWeightArtifactManifest,
  signModelWeightArtifactManifest,
  verifyModelWeightArtifactManifest,
} from '../src/model-weights-manifest.js';
import {
  artifactManifestPathFor,
  buildPulledWeightArtifactManifest,
  savePulledWeightArtifactManifest,
} from '../src/model-weights-puller.js';

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function signer() {
  const { publicKey, privateKey } = generateKeyPair();
  return { publicKey, privateKey, key_fingerprint: keyFingerprint(publicKey) };
}

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `kolm-w967-${tag}-`));
}

test('W967 production weight artifact manifest signs exact GGUF SHA rows', () => {
  const key = signer();
  const bytes = Buffer.from('GGUF\0frontier-binding-fixture');
  const manifest = buildModelWeightArtifactManifest({
    artifact_id: 'artifact:gguf:q4',
    model_id: 'Qwen/Qwen2.5-0.5B-Instruct',
    variant: 'q4_k_m',
    files: [{ path: 'model/qwen.gguf', bytes: bytes.length, sha256: sha256(bytes) }],
    created_at: '2026-06-19T00:00:00.000Z',
    source: { kind: 'test' },
  });
  assert.equal(manifest.schema, MODEL_WEIGHT_ARTIFACT_MANIFEST_SCHEMA);
  assert.deepEqual(manifest.runtime_targets, ['llama.cpp', 'llama.cpp-webgpu']);

  const signed = signModelWeightArtifactManifest(manifest, key, { signed_at: manifest.created_at });
  const verified = verifyModelWeightArtifactManifest(signed, { require_signature: true });
  assert.equal(verified.ok, true, verified.reason);
  assert.match(canonicalModelWeightArtifactManifest(signed), /artifact:gguf:q4/);

  const stale = structuredClone(signed);
  stale.files[0].sha256 = sha256('different bytes');
  assert.equal(verifyModelWeightArtifactManifest(stale, { require_signature: true }).ok, false);

  const resignedWithoutRows = structuredClone(signed);
  resignedWithoutRows.files = [];
  assert.match(
    verifyModelWeightArtifactManifest(resignedWithoutRows, { require_signature: true }).reason,
    /files missing|requires at least one file|file_count mismatch/,
  );
});

test('W967 manifest supports WebLLM MLC multi-file and ONNX/WebGPU runtime targets', () => {
  const key = signer();
  const mlc = buildModelWeightArtifactManifest({
    artifact_id: 'artifact:mlc:q4f16_1',
    model_id: 'local/domain-student',
    variant: 'q4f16_1-MLC',
    files: [
      { path: 'Domain-q4f16_1-MLC/mlc-chat-config.json', bytes: 12, sha256: sha256('config'), role: 'config' },
      { path: 'Domain-q4f16_1-MLC/params_shard_0.bin', bytes: 256, sha256: sha256('shard0'), format: 'mlc' },
      { path: 'Domain-q4f16_1-MLC/tokenizer.json', bytes: 64, sha256: sha256('tok'), role: 'tokenizer' },
      { path: 'libs/Domain-q4f16_1-webgpu.wasm', bytes: 128, sha256: sha256('wasm'), format: 'wasm' },
    ],
    runtime_targets: ['webllm'],
    created_at: '2026-06-19T00:00:00.000Z',
    policy: { cache_backend: 'indexeddb' },
  });
  const signedMlc = signModelWeightArtifactManifest(mlc, key, { signed_at: mlc.created_at });
  assert.equal(verifyModelWeightArtifactManifest(signedMlc, { require_signature: true }).ok, true);
  assert.ok(signedMlc.runtime_targets.includes('webllm'));
  assert.ok(signedMlc.runtime_targets.includes('webgpu'));
  assert.ok(signedMlc.runtime_targets.includes('mlc'));
  assert.equal(signedMlc.file_count, 4);

  const onnx = buildModelWeightArtifactManifest({
    artifact_id: 'artifact:onnx:int8',
    model_id: 'local/onnx-student',
    variant: 'int8',
    files: [{ path: 'model.onnx', bytes: 32, sha256: sha256('onnx') }],
    created_at: '2026-06-19T00:00:00.000Z',
  });
  assert.deepEqual(onnx.runtime_targets, ['onnxruntime-node', 'onnxruntime-web']);
});

test('W967 weight-class .kolm payload embeds signed sidecar and binds it into hashes', async () => {
  process.env.RECIPE_RECEIPT_SECRET = process.env.RECIPE_RECEIPT_SECRET || 'kolm-w967-test-secret';
  process.env.KOLM_ED25519_KEY_STORE = tmpDir('signer');
  process.env.KOLM_SIGSTORE_DISABLE = '1';
  const { buildPayload } = await import('../src/artifact.js');
  const weightBytes = Buffer.from('GGUF\0w967-artifact-sidecar');
  const payload = buildPayload({
    job_id: 'job_w967_weight_binding',
    task: 'w967 signed production weight artifact binding',
    base_model: 'local/w967-student',
    recipes: [{ id: 'rcp_w967', name: 'noop', source: 'return {ok:true};', source_hash: 'h', version_id: 'v', tags: [], schema: null }],
    evals: { spec: 'rs-1-evals', n: 0, cases: [], coverage: 0 },
    runtime_target: 'gguf',
    runtime_target_config: { gguf_path: 'model.gguf' },
    model_weights: { filename: 'model.gguf', content: weightBytes },
    allow_below_gate: true,
  });

  const weightManifest = payload.manifest.model_weight_artifact_manifest;
  assert.ok(weightManifest, 'weight-class artifact must stamp model_weight_artifact_manifest');
  assert.equal(weightManifest.files[0].sha256, sha256(weightBytes));
  assert.equal(verifyModelWeightArtifactManifest(weightManifest, { require_signature: true }).ok, true);
  assert.equal(payload.manifest.hashes.model_weight_artifact_manifest, hashModelWeightArtifactManifest(weightManifest));

  const sidecar = payload.files.find((f) => f.filename === MODEL_WEIGHT_ARTIFACT_MANIFEST_FILENAME);
  assert.ok(sidecar, 'zip payload must include model.weight.manifest.json');
  assert.equal(sha256(sidecar.content), payload.manifest.hashes.model_weight_artifact_manifest);
  assert.equal(JSON.parse(sidecar.content.toString('utf8')).weights_sha256, weightManifest.weights_sha256);
});

test('W967 puller builds and persists a signed production artifact manifest from cached SHA rows', () => {
  process.env.KOLM_ED25519_KEY_STORE = tmpDir('puller-signer');
  process.env.KOLM_SIGSTORE_DISABLE = '1';
  const row = {
    model_id: 'test/pulled-model',
    variant: 'q4_k_m',
    hf_repo: 'test/pulled-model-GGUF',
    hf_revision: 'main',
    tier: 'edge',
  };
  const pulled = [{
    file: 'pulled.gguf',
    ok: true,
    bytes: 17,
    sha256: sha256('pulled gguf bytes'),
  }];
  const manifest = buildPulledWeightArtifactManifest({
    row,
    files: pulled,
    downloaded_at: '2026-06-19T00:00:00.000Z',
  });
  assert.equal(verifyModelWeightArtifactManifest(manifest, { require_signature: true }).ok, true);
  assert.equal(manifest.files[0].source_url, 'https://huggingface.co/test/pulled-model-GGUF/resolve/main/pulled.gguf');

  const dir = tmpDir('puller-cache');
  const saved = savePulledWeightArtifactManifest(dir, row, manifest);
  assert.equal(saved.path, artifactManifestPathFor(dir, row));
  assert.equal(saved.sha256, hashModelWeightArtifactManifest(manifest));
  assert.ok(fs.existsSync(saved.path));
  assert.equal(JSON.parse(fs.readFileSync(saved.path, 'utf8')).weights_sha256, manifest.weights_sha256);
});
