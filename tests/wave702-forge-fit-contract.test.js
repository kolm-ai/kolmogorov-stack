// W702 - direct contract for src/forge-fit.js.
//
// Focus: finite bounded estimates, safe public route errors, deterministic
// estimator hashes, and direct package/depth coverage for the fit primitive.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

import {
  BYTES_PER_PARAM,
  FIT_CONTRACT_VERSION,
  FIT_LIMITS,
  FIT_VERSION,
  estimateMemoryFit,
  fitErrorStatus,
  pickBestFitTarget,
  safeFitError,
} from '../src/forge-fit.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const HEX64_RE = /^[a-f0-9]{64}$/;

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

async function withServer(app, fn) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('W702 source pins bounded estimator controls and package wiring', () => {
  const source = read('src/forge-fit.js');
  const router = read('src/router.js');
  const pkg = readJson('package.json');

  assert.equal(FIT_VERSION, 'forge-fit-v1');
  assert.equal(FIT_CONTRACT_VERSION, 'w702-v1');
  assert.ok(FIT_LIMITS.MAX_CONTEXT <= 1_048_576);
  assert.equal(BYTES_PER_PARAM.fp16, 2);
  assert.match(source, /FIT_LIMITS/);
  assert.match(source, /fit_sha256/);
  assert.match(source, /pick_sha256/);
  assert.match(source, /safeFitError/);
  assert.doesNotMatch(source, /[^\x00-\x7F]/);

  assert.match(router, /forgeFit\.fitErrorStatus\(e\)/);
  assert.match(router, /forgeFit\.safeFitError\(e\)/);
  assert.match(router, /kv_precision:\s*String\(body\.kv_precision \|\| 'fp16'\)/);

  assert.equal(
    pkg.scripts['verify:forge-fit'],
    'node --test --test-concurrency=1 tests/wave702-forge-fit-contract.test.js',
  );
  assert.match(pkg.scripts['verify:depth'], /verify:forge-experts && npm run verify:forge-fit && npm run verify:pattern-lake/);
});

test('W702 estimateMemoryFit emits finite digest-backed comfortable and over envelopes', () => {
  const fit = estimateMemoryFit({
    model_params_b: 7,
    quant: 'int4',
    vram_gb: 24,
    context: 8192,
    batch: 1,
    kv_precision: 'fp16',
  });

  assert.equal(fit.fits, true);
  assert.equal(fit.tight, false);
  assert.equal(fit.fit_class, 'comfortable');
  assert.equal(fit.est_total_gb, 6.5);
  assert.equal(fit.est_weights_gb, 3.9);
  assert.equal(fit.est_kv_gb, 1.3);
  assert.equal(fit.est_activations_gb, 0.3);
  assert.equal(fit.headroom_gb, 17.5);
  assert.equal(fit.contract_version, 'w702-v1');
  assert.match(fit.fit_sha256, HEX64_RE);
  for (const value of Object.values(fit)) {
    if (typeof value === 'number') assert.equal(Number.isFinite(value), true);
  }

  const over = estimateMemoryFit({
    model_params_b: 70,
    quant: 'fp16',
    vram_gb: 24,
    context: 8192,
  });
  assert.equal(over.fits, false);
  assert.equal(over.fit_class, 'over');
  assert.match(over.recommendation, /try gguf-q8 or smaller/);
  assert.match(over.fit_sha256, HEX64_RE);
});

test('W702 rejects non-finite and out-of-contract estimator inputs', () => {
  assert.throws(
    () => estimateMemoryFit({ model_params_b: Infinity, quant: 'fp16', vram_gb: 24 }),
    /fit_requires_model_params_b/,
  );
  assert.throws(
    () => estimateMemoryFit({ model_params_b: 7, quant: 'fp16', vram_gb: NaN }),
    /fit_requires_vram_gb/,
  );
  assert.throws(
    () => estimateMemoryFit({ model_params_b: 7, quant: 'fp16', vram_gb: 24, context: 0 }),
    /fit_requires_context/,
  );
  assert.throws(
    () => estimateMemoryFit({ model_params_b: 7, quant: 'fp16', vram_gb: 24, batch: 0 }),
    /fit_requires_batch/,
  );
  assert.throws(
    () => estimateMemoryFit({ model_params_b: 7, quant: 'fp16', vram_gb: 24, kv_precision: 'bad' }),
    /fit_unknown_kv_precision/,
  );
  assert.throws(
    () => estimateMemoryFit({ model_params_b: 7, quant: 'bad\nquant', vram_gb: 24 }),
    /fit_unknown_quant/,
  );

  const err = new Error('fit_unknown_quant: bad\nsecret');
  assert.equal(safeFitError(err), 'fit_unknown_quant');
  assert.equal(fitErrorStatus(err), 400);
});

test('W702 pickBestFitTarget evaluates bounded supported methods and hashes the decision', () => {
  const picked = pickBestFitTarget({
    model_params_b: 13,
    vram_gb: 24,
    context: 8192,
    supported_methods: ['fp16', 'gguf-q4km', 'gguf-q4km', 'unknown'],
  });

  assert.equal(picked.picked, 'gguf-q4km');
  assert.equal(picked.fit.fits, true);
  assert.equal(picked.fit.fit_class, 'comfortable');
  assert.equal(picked.candidates_evaluated, 2);
  assert.equal(picked.contract_version, 'w702-v1');
  assert.match(picked.pick_sha256, HEX64_RE);

  const none = pickBestFitTarget({
    model_params_b: 1000,
    vram_gb: 1,
    supported_methods: ['gguf-iq2xs'],
  });
  assert.equal(none.picked, null);
  assert.equal(none.fit, null);
  assert.equal(none.candidates_evaluated, 1);
  assert.equal(none.smallest_attempt.quant, 'gguf-iq2xs');
  assert.match(none.pick_sha256, HEX64_RE);

  assert.throws(
    () => pickBestFitTarget({
      model_params_b: 7,
      vram_gb: 24,
      supported_methods: Array.from({ length: FIT_LIMITS.MAX_SUPPORTED_METHODS + 1 }, (_, i) => `m${i}`),
    }),
    /fit_supported_methods_invalid/,
  );
});

test('W702 /v1/fit returns safe bounded route errors and fit envelopes', async () => {
  const { buildRouter } = await import('../src/router.js');
  const app = express();
  app.use(express.json());
  app.use(buildRouter());

  await withServer(app, async (base) => {
    const ok = await fetch(`${base}/v1/fit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model_params_b: 7, quant: 'int4', vram_gb: 24 }),
    });
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    assert.equal(okBody.ok, true);
    assert.equal(okBody.contract_version, 'w702-v1');
    assert.match(okBody.fit_sha256, HEX64_RE);

    const picked = await fetch(`${base}/v1/fit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pick_best: true,
        model_params_b: 13,
        vram_gb: 24,
        supported_methods: ['fp16', 'gguf-q4km'],
      }),
    });
    assert.equal(picked.status, 200);
    const pickedBody = await picked.json();
    assert.equal(pickedBody.ok, true);
    assert.equal(pickedBody.picked, 'gguf-q4km');
    assert.match(pickedBody.pick_sha256, HEX64_RE);

    const bad = await fetch(`${base}/v1/fit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model_params_b: 7, quant: 'bad\nsecret', vram_gb: 24 }),
    });
    assert.equal(bad.status, 400);
    const text = await bad.text();
    assert.equal(text.includes('secret'), false);
    assert.deepEqual(JSON.parse(text), { ok: false, error: 'fit_unknown_quant' });
  });
});
