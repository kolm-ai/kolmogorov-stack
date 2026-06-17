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

test('W611 #2 - wasm-webgpu row no longer cites phantom public/device runner evidence', () => {
  const row = MODEL_FRAMEWORK_TARGETS.find((target) => target.id === 'wasm-webgpu');
  assert.ok(row);
  assert.equal(row.status, 'target-declared');
  assert.deepEqual(row.evidence, ['public/sdk.js', 'server.js', 'docs/kolm-format-v1.md']);
  assert.equal(row.evidence.some((rel) => rel.includes('public/device/webgpu-runner')), false);
  assert.doesNotMatch(row.note, /runner shipped|now exists|minimal transformers\.js|webgpu-runner\.js/i);
  assert.match(row.note, /planned, not shipped/i);
});

test('W611 #3 - browser WebGPU remains target-declared and platform validation still passes', () => {
  const browser = DEVICE_TARGETS.find((target) => target.id === 'browser-webgpu');
  assert.ok(browser);
  assert.equal(browser.status, 'target-declared');
  assert.deepEqual(browser.evidence, ['public/sdk.js', 'docs/product-surfaces.json']);
  assert.equal(validatePlatformCapabilities().ok, true);
});

test('W611 #4 - backend spec records the phantom-evidence closure but keeps the real WebGPU gap open', () => {
  const spec = fs.readFileSync(SPEC_PATH, 'utf8');
  assert.match(spec, /\| 10 \| ondevice-inference \| 8 \| S\/low \| CLOSED W611: fix phantom WebGPU-runner evidence/i);
  assert.match(spec, /W611 fixed the platform-capabilities phantom evidence claim/i);
  assert.match(spec, /No in-browser model EXECUTION exists at all/i);
  assert.match(spec, /CLOSED W611: Fix phantom WebGPU-runner evidence in platform-capabilities/i);
});
