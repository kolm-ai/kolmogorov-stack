import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BROWSER_WEIGHT_MANIFEST_SPEC,
  canonicalWeightManifest,
  runTinyLinearCpu,
  runVerifiedTinyModel,
  sha256HexBytes,
  verifyWeightManifest,
} from '../public/device/webgpu-runner.js';

import { DEVICE_TARGETS, MODEL_FRAMEWORK_TARGETS } from '../src/platform-capabilities.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = path.join(ROOT, 'public', 'device', 'fixtures', 'tiny-linear.manifest.json');
const WEIGHTS_PATH = path.join(ROOT, 'public', 'device', 'fixtures', 'tiny-linear.weights.json');
const RUNNER_PATH = path.join(ROOT, 'public', 'device', 'webgpu-runner.js');
const PAGE_PATH = path.join(ROOT, 'public', 'device', 'webgpu-runner.html');
const VERIFY_PAGE_PATH = path.join(ROOT, 'public', 'verify.html');
const SPEC_PATH = path.join(ROOT, 'docs', 'STACK-TECH-SPEC-2026-06-15.md');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

test('W959 browser weight fixture digest and signed manifest are stable', async () => {
  const manifest = readJson(MANIFEST_PATH);
  const weights = fs.readFileSync(WEIGHTS_PATH);
  assert.equal(manifest.schema, BROWSER_WEIGHT_MANIFEST_SPEC);
  assert.equal(await sha256HexBytes(weights), manifest.weights_sha256);
  const verify = await verifyWeightManifest(manifest, weights);
  assert.equal(verify.ok, true, JSON.stringify(verify, null, 2));
  assert.match(canonicalWeightManifest(manifest), /kolm-tiny-linear-webgpu-fixture/);

  const nodeOk = crypto.verify(
    null,
    Buffer.from(canonicalWeightManifest(manifest)),
    crypto.createPublicKey(manifest.signature_ed25519.public_key),
    Buffer.from(manifest.signature_ed25519.signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
  );
  assert.equal(nodeOk, true, 'fixture signature must verify under node:crypto too');
});

test('W959 verifyWeightManifest fails closed on tampered weights and manifest fields', async () => {
  const manifest = readJson(MANIFEST_PATH);
  const weights = fs.readFileSync(WEIGHTS_PATH);
  const tamperedWeights = Buffer.concat([weights, Buffer.from('\n ')]);
  const digestFail = await verifyWeightManifest(manifest, tamperedWeights);
  assert.equal(digestFail.ok, false);
  assert.match(digestFail.reason, /weight bytes/);

  const tamperedManifest = { ...manifest, input: [9, 9, 9, 9] };
  const sigFail = await verifyWeightManifest(tamperedManifest, weights);
  assert.equal(sigFail.ok, false);
  assert.match(sigFail.reason, /signature/);
});

test('W959 runVerifiedTinyModel executes only after verification and returns deterministic logits', async () => {
  const manifest = readJson(MANIFEST_PATH);
  const weightsBytes = fs.readFileSync(WEIGHTS_PATH);
  const result = await runVerifiedTinyModel({
    manifest,
    weightsBytes,
    preferWebGpu: false,
  });
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.execution.runtime, 'cpu-js');
  assert.deepEqual(result.execution.logits, [5.35, 6.3]);
  assert.equal(result.execution.prediction, 'review');
  assert.ok(result.checks.some((row) => row.name === 'weights sha256 matches manifest' && row.ok));
  assert.ok(result.checks.some((row) => row.name === 'Ed25519 manifest signature valid' && row.ok));

  const model = readJson(WEIGHTS_PATH);
  assert.deepEqual(runTinyLinearCpu(model, [1, 2, 3, 4]).logits, [5.35, 6.3]);
});

test('W959 public device runner is wired into capability evidence and verify UI', () => {
  for (const p of [RUNNER_PATH, PAGE_PATH, MANIFEST_PATH, WEIGHTS_PATH]) {
    assert.ok(fs.existsSync(p), `missing ${p}`);
  }
  const wasm = MODEL_FRAMEWORK_TARGETS.find((target) => target.id === 'wasm-webgpu');
  const browser = DEVICE_TARGETS.find((target) => target.id === 'browser-webgpu');
  assert.ok(wasm);
  assert.ok(browser);
  assert.equal(wasm.status, 'implemented');
  assert.equal(browser.status, 'implemented');
  assert.ok(wasm.evidence.includes('public/device/webgpu-runner.js'));
  assert.ok(browser.evidence.includes('public/device/webgpu-runner.html'));
  const page = fs.readFileSync(PAGE_PATH, 'utf8');
  assert.match(page, /Verify and run/);
  assert.match(page, /device\/webgpu-runner\.js/);
  const verifyPage = fs.readFileSync(VERIFY_PAGE_PATH, 'utf8');
  assert.match(verifyPage, /deviceRunBtn/);
  assert.match(verifyPage, /\/device\/webgpu-runner/);
});

test('W959 stack spec records local browser verify-then-run closure honestly', () => {
  const spec = fs.readFileSync(SPEC_PATH, 'utf8');
  assert.match(spec, /CLOSED W959: Browser verify-then-run signed-weight proof harness/);
  assert.match(spec, /not a production WebLLM\/LlamaWeb LLM runtime/i);
  assert.doesNotMatch(spec, /No in-browser model EXECUTION exists at all/);
});
