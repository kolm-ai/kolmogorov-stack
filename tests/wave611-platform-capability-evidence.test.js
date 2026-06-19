import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEVICE_TARGETS,
  MODEL_FRAMEWORK_TARGETS,
  listPlatformCapabilities,
  validatePlatformCapabilities,
} from '../src/platform-capabilities.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_PATH = path.join(ROOT, 'docs', 'STACK-TECH-SPEC-2026-06-15.md');

function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

function collectMissingEvidence() {
  const missing = [];
  for (const [group, rows] of Object.entries(listPlatformCapabilities())) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!Array.isArray(row.evidence)) continue;
      for (const rel of row.evidence) {
        if (!exists(rel)) missing.push(`${group}:${row.id}:${rel}`);
      }
    }
  }
  return missing;
}

test('W611 #1 - every platform capability evidence path resolves locally', () => {
  assert.deepEqual(collectMissingEvidence(), []);
});

test('W611 #2 - wasm-webgpu row now cites only real public/device runner evidence', () => {
  const row = MODEL_FRAMEWORK_TARGETS.find((target) => target.id === 'wasm-webgpu');
  assert.ok(row);
  assert.equal(row.status, 'implemented');
  assert.deepEqual(row.evidence, [
    'public/sdk.js',
    'public/device/webgpu-runner.js',
    'public/device/onnx-web-runner.js',
    'public/device/webllm-runner.js',
    'public/device/llamaweb-runner.js',
    'public/device/fixtures/tiny-linear.manifest.json',
    'server.js',
    'docs/kolm-format-v1.md',
  ]);
  assert.equal(row.evidence.every((rel) => exists(rel)), true);
  assert.match(row.note, /verifies signed weight bytes/i);
  assert.match(row.note, /signed ONNX bytes/i);
  assert.match(row.note, /signed WebLLM\/MLC bytes/i);
  assert.match(row.note, /signed GGUF bytes/i);
});

test('W611 #3 - browser WebGPU has real proof-harness evidence and platform validation still passes', () => {
  const browser = DEVICE_TARGETS.find((target) => target.id === 'browser-webgpu');
  assert.ok(browser);
  assert.equal(browser.status, 'implemented');
  assert.ok(browser.evidence.includes('public/device/webgpu-runner.js'));
  assert.ok(browser.evidence.includes('public/device/onnx-web-runner.js'));
  assert.ok(browser.evidence.includes('public/device/webllm-runner.js'));
  assert.ok(browser.evidence.includes('public/device/llamaweb-runner.js'));
  assert.ok(browser.evidence.includes('public/device/webgpu-runner.html'));
  assert.ok(browser.runtimes.includes('onnxruntime-web'));
  assert.ok(browser.runtimes.includes('webllm'));
  assert.ok(browser.runtimes.includes('llama.cpp-webgpu'));
  assert.equal(browser.evidence.every((rel) => exists(rel)), true);
  assert.equal(validatePlatformCapabilities().ok, true);
});

test('W611 #4 - backend spec records W611 truthfulness and W959 browser runner closure', () => {
  const spec = fs.readFileSync(SPEC_PATH, 'utf8');
  assert.match(spec, /\| 10 \| ondevice-inference \| 8 \| S\/low \| CLOSED W611: fix phantom WebGPU-runner evidence/i);
  assert.match(spec, /W611 fixed the platform-capabilities phantom evidence claim/i);
  assert.match(spec, /CLOSED W959: Browser verify-then-run signed-weight proof harness/i);
  assert.match(spec, /CLOSED W611: Fix phantom WebGPU-runner evidence in platform-capabilities/i);
});
