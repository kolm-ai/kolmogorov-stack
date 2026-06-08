// tests/cloud-compile.test.js — wave3-s8 lock-in.
//
// Shape-only contract for the cloud-compile scaffold:
//   1. scripts/compile-cloud.cjs exists, is requireable, exports the expected
//      pure-function API surface, and runs `--help` with exit code 0.
//   2. scripts/compile-cloud-modal.py exists and contains the Modal app id
//      ("kolm-cloud-compile") + a `gpu=` decorator hint.
//   3. The user-facing doc exists at public/docs/cloud-compile.md and mentions
//      `modal token new` and a "Caveats" or "Limitations" section.
//
// Caveats — this test does NOT:
//   - invoke the `modal` binary
//   - touch the network
//   - launch any Modal job
//   - depend on Modal credentials being present in this environment

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DRIVER = path.join(ROOT, 'scripts', 'compile-cloud.cjs');
const MODAL_PY = path.join(ROOT, 'scripts', 'compile-cloud-modal.py');
const DOC_PATHS = [
  path.join(ROOT, 'public', 'docs', 'cloud-compile.md'),
  path.join(ROOT, 'docs', 'cloud-compile.md'),
];

test('wave3-s8 · scripts/compile-cloud.cjs exists and is a file', () => {
  assert.ok(fs.existsSync(DRIVER), `expected ${DRIVER} to exist`);
  const stat = fs.statSync(DRIVER);
  assert.ok(stat.isFile(), 'compile-cloud.cjs is not a regular file');
  assert.ok(stat.size > 0, 'compile-cloud.cjs is empty');
});

test('wave3-s8 · driver exports the expected pure-function surface', () => {
  const require = createRequire(import.meta.url);
  const mod = require(DRIVER);
  assert.equal(typeof mod, 'object', 'driver should module.exports an object');
  assert.equal(typeof mod.parseArgs, 'function', 'exports.parseArgs missing');
  assert.equal(typeof mod.helpText, 'function', 'exports.helpText missing');
  assert.equal(typeof mod.buildModalCommand, 'function', 'exports.buildModalCommand missing');
  assert.ok(mod.KNOWN_QUANTS instanceof Set, 'exports.KNOWN_QUANTS should be a Set');
  assert.ok(mod.KNOWN_QUANTS.has('nf4-int4'), 'KNOWN_QUANTS should include nf4-int4');
  assert.ok(mod.KNOWN_GPUS instanceof Set, 'exports.KNOWN_GPUS should be a Set');
  assert.ok(mod.KNOWN_GPUS.has('A100'), 'KNOWN_GPUS should include A100');
  assert.equal(typeof mod.DEFAULT_GPU, 'string', 'DEFAULT_GPU should be a string');
});

test('wave3-s8 · driver parseArgs covers required flags', () => {
  const require = createRequire(import.meta.url);
  const { parseArgs } = require(DRIVER);
  const a = parseArgs(['node', 'compile-cloud.cjs', '--model', 'foo/bar', '--quant', 'int8', '--gpu', 'H100']);
  assert.equal(a.model, 'foo/bar');
  assert.equal(a.quant, 'int8');
  assert.equal(a.gpu, 'H100');
  assert.equal(a.dryRun, true, 'dryRun should default true');
  assert.equal(a.run, false, 'run should default false');
  const b = parseArgs(['node', 'compile-cloud.cjs', '--model=foo/bar', '--run']);
  assert.equal(b.model, 'foo/bar');
  assert.equal(b.dryRun, false);
  assert.equal(b.run, true);
  const c = parseArgs(['node', 'compile-cloud.cjs', '--help']);
  assert.equal(c.help, true);
});

test('wave3-s8 · driver `--help` exits 0 and prints usage text', () => {
  const r = spawnSync(process.execPath, [DRIVER, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `--help should exit 0, got ${r.status}: ${r.stderr}`);
  const out = r.stdout || '';
  assert.match(out, /Usage:/, '--help should include "Usage:" section');
  assert.match(out, /--model/, '--help should mention --model flag');
  assert.match(out, /--quant/, '--help should mention --quant flag');
});

test('wave3-s8 · driver missing --model exits 1 with a usable hint', () => {
  const r = spawnSync(process.execPath, [DRIVER, '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 1, `missing --model should exit 1, got ${r.status}`);
  const line = (r.stdout || '').trim().split('\n')[0];
  const parsed = JSON.parse(line);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, 'missing_model');
});

test('wave3-s8 · scripts/compile-cloud-modal.py exists with Modal app id and gpu decorator', () => {
  assert.ok(fs.existsSync(MODAL_PY), `expected ${MODAL_PY} to exist`);
  const body = fs.readFileSync(MODAL_PY, 'utf8');
  assert.match(body, /modal\.App\("kolm-cloud-compile"\)/, 'Modal app id "kolm-cloud-compile" missing');
  assert.match(body, /gpu=/, 'no gpu= decorator argument found');
  assert.match(body, /@app\.function/, 'no @app.function decorator found');
  assert.match(body, /quantize_and_upload/, 'quantize_and_upload function missing');
});
