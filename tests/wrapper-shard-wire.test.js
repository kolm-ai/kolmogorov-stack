// tests/wrapper-shard-wire.test.js
//
// SHARD wiring tests — pin the 3 follow-up integrations documented in
// docs/kv-cache-shard.md so future renames or refactors trip here, not in
// production.
//
//   #1 src/forge-hardware.js exports kvCacheSize + maxContextBothModes
//   #2 kvCacheSize delegates to the canonical math (matches estimateKvCacheBytes
//      and estimateShardKvCacheBytes byte-for-byte)
//   #3 maxContextBothModes returns both ceilings + an unlock_x ratio in the
//      10x ballpark when the budget is large enough for the compressed tail
//      to dominate
//   #4 cli/kolm.js cmdServe documents --kv-cache in its usage line
//   #5 cli/kolm.js cmdServe wires KOLM_KV_CACHE_BACKEND into serveEnv
//
// Tests #4/#5 grep the source — same approach as wrapper-w1-w2-w3.test.js
// uses for the SSE / X-RateLimit pins.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ARTIFACT_FIT_VERSION,
  artifactFitDescriptor,
  kvCacheSize,
  maxContextBothModes,
  readArtifactManifest,
  willArtifactFit,
} from '../src/forge-hardware.js';
import {
  estimateKvCacheBytes,
  estimateShardKvCacheBytes,
} from '../src/kv-cache-shard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Qwen2.5-7B-Instruct config (GQA: num_key_value_heads=4, NOT 28).
const QWEN_7B = {
  num_hidden_layers: 28,
  num_key_value_heads: 4,
  head_dim: 128,
};

test('shard-wire #1 — forge-hardware exports kvCacheSize + maxContextBothModes', () => {
  assert.equal(typeof kvCacheSize, 'function', 'kvCacheSize must be exported');
  assert.equal(typeof maxContextBothModes, 'function', 'maxContextBothModes must be exported');
});

test('shard-wire #2 — kvCacheSize delegates byte-for-byte to canonical math', () => {
  const defaultBytes = kvCacheSize(QWEN_7B, 8192, false);
  const expectedDefault = estimateKvCacheBytes({
    ...QWEN_7B,
    context_length: 8192,
  });
  assert.equal(defaultBytes, expectedDefault, 'default path must match estimateKvCacheBytes');

  const shardBytes = kvCacheSize(QWEN_7B, 8192, true);
  const expectedShard = estimateShardKvCacheBytes({
    ...QWEN_7B,
    context_length: 8192,
  });
  assert.equal(shardBytes, expectedShard, 'shard path must match estimateShardKvCacheBytes');

  // Sanity: shard < default at 8K (we are well past sink+window=68 tokens).
  assert.ok(shardBytes < defaultBytes, 'shard should beat default at 8K');
});

test('shard-wire #3 — maxContextBothModes ceilings + unlock ratio in 10x ballpark', () => {
  const both = maxContextBothModes(QWEN_7B, 4 * 1024 * 1024 * 1024); // 4 GB budget
  assert.ok(both.default_max_ctx > 0, 'default ceiling must be positive');
  assert.ok(both.shard_max_ctx > both.default_max_ctx, 'shard ceiling must beat default');
  // At a budget big enough for the compressed tail to dominate, the unlock
  // approaches 16 / 1.5 = 10.67x. Allow 9.5-11.5x window.
  assert.ok(both.shard_unlock_x >= 9.5 && both.shard_unlock_x <= 11.5,
    `unlock should be in [9.5, 11.5]x ballpark (got ${both.shard_unlock_x}x)`);
});

test('shard-wire #4 — cmdServe --http usage line documents --kv-cache', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'cli/kolm.js'), 'utf8');
  // The HTTP-serve usage line must list the --kv-cache flag so `--help` users
  // can discover it. We pin the exact substring.
  assert.match(src,
    /usage: kolm serve --http <artifact\.kolm>[^']*--kv-cache auto\|off\|streaming\|h2o\|snapkv\|pyramidkv\|kivi2\|kivi4\|shard/,
    'cmdServe --http usage line must list the full KV policy set');
  assert.match(src, /--kv-budget F/, 'cmdServe --http usage line must expose KV budget tuning');
});

test('shard-wire #5 — cmdServe wires KOLM_KV_POLICY into serveEnv', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'cli/kolm.js'), 'utf8');
  // The wire must:
  //   - import selectKvCachePolicy from serve-config.js
  //   - set KOLM_KV_POLICY for serve.py
  //   - keep KOLM_KV_CACHE_BACKEND=shard for old Shard back-compat
  assert.match(src, /import\(\s*['"]\.\.\/src\/serve-config\.js['"]\s*\)/,
    'must dynamic-import serve-config');
  assert.match(src, /selectKvCachePolicy/, 'must call selectKvCachePolicy');
  assert.match(src, /serveEnv\.KOLM_KV_POLICY\s*=\s*JSON\.stringify/,
    'must set KOLM_KV_POLICY on the env passed to apps.runtime.serve');
  assert.match(src, /serveEnv\.KOLM_KV_CACHE_BACKEND\s*=\s*applied\.policy === 'shard' \? 'shard' : 'default'/,
    'must retain KOLM_KV_CACHE_BACKEND shard compatibility');
});

test('shard-wire #6 - forge-hardware extracts fit descriptor from artifact manifest', () => {
  const manifest = {
    spec: 'kolm-artifact-v1',
    base_model: 'Qwen/Qwen2.5-7B-Instruct',
    params_b: 7,
    quantization: 'q4_k_m',
    context_length: 8192,
    batch_size: 2,
    kv_precision: 'fp8',
  };
  const descriptor = artifactFitDescriptor(manifest);
  assert.equal(descriptor.version, ARTIFACT_FIT_VERSION);
  assert.equal(descriptor.model_params_b, 7);
  assert.equal(descriptor.quant, 'gguf-q4km');
  assert.equal(descriptor.context, 8192);
  assert.equal(descriptor.batch, 2);
  assert.equal(descriptor.kv_precision, 'fp8');
  assert.equal(descriptor.has_estimator_inputs, true);
});

test('shard-wire #7 - readArtifactManifest reads manifest.json directories safely', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-forge-hw-'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    spec: 'kolm-artifact-v1',
    params_b: 13,
    quant_descriptor: { method: 'awq' },
  }));
  const out = readArtifactManifest(dir);
  assert.equal(out.ok, true);
  assert.equal(out.source, 'directory:manifest.json');
  assert.equal(out.manifest.params_b, 13);
});

test('shard-wire #8 - willArtifactFit uses manifest estimate before hardware target recommendation', () => {
  const hardware = {
    primary: {
      vendor: 'nvidia',
      name: 'RTX 4090',
      vram_gb: 24,
      native_dtypes: ['fp16', 'bf16', 'int8', 'int4'],
      supported_methods: ['fp16', 'int8', 'int4', 'gguf-q4km', 'awq-4bit', 'hqq'],
    },
    all: [],
  };
  const fits = willArtifactFit('', {
    hardware,
    manifest: {
      spec: 'kolm-artifact-v1',
      params_b: 7,
      quantization: 'q4_k_m',
      context_length: 8192,
      batch_size: 1,
    },
  });
  assert.equal(fits.fits, true);
  assert.equal(fits.reason, 'manifest_estimate_fits');
  assert.equal(fits.artifact.quant, 'gguf-q4km');
  assert.equal(fits.fit.fit_class, 'comfortable');
  assert.equal(fits.recommended_targets[0], 'gguf-q4km');

  const over = willArtifactFit('', {
    hardware,
    manifest: {
      spec: 'kolm-artifact-v1',
      params_b: 70,
      quantization: 'fp16',
      context_length: 8192,
    },
  });
  assert.equal(over.fits, false);
  assert.equal(over.reason, 'manifest_estimate_exceeds_vram');
  assert.equal(over.fit.fit_class, 'over');
});
