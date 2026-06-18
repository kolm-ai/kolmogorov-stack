// W663 - direct contract for workers/data/scripts/dsir_resample.py.
//
// Focus: the Python DSIR worker itself, not only the JS data-curation wrapper.
// Exercises deterministic subprocess behavior, target-distribution weighting,
// stdin mode, and fail-closed resource limits.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const BUNDLED_PYTHON = path.join(
  os.homedir(),
  '.cache',
  'codex-runtimes',
  'codex-primary-runtime',
  'dependencies',
  'python',
  'python.exe',
);
const PYTHON = process.env.KOLM_PYTHON
  || process.env.PYTHON
  || (fs.existsSync(BUNDLED_PYTHON) ? BUNDLED_PYTHON : 'python');
const SCRIPT = path.resolve('workers/data/scripts/dsir_resample.py');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w663-dsir-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJsonl(file, rows) {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function runDsir(args, { input = null, env = {} } = {}) {
  return spawnSync(PYTHON, [SCRIPT, ...args], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 5 * 1024 * 1024,
  });
}

function parseJsonStdout(result) {
  assert.ok(result.stdout.trim(), `expected JSON stdout; stderr=${result.stderr}`);
  const lines = result.stdout.trim().split(/\r?\n/);
  return JSON.parse(lines[lines.length - 1]);
}

function supportRow(i) {
  return {
    input: `billing refund invoice payment case ${i}`,
    output: `customer asks about invoice refund payment receipt subscription ${i}`,
  };
}

function spaceRow(i) {
  return {
    input: `orbit telescope galaxy launch case ${i}`,
    output: `spacecraft planet asteroid nebula orbit telescope mission ${i}`,
  };
}

test('W663 DSIR worker self-test passes through the Python CLI', () => {
  const result = runDsir(['--self-test']);
  assert.equal(result.status, 0, result.stderr);
  const out = parseJsonStdout(result);
  assert.equal(out.ok, true);
  assert.equal(out.self_test, true);
  assert.equal(out.failed, 0);
  assert.ok(out.passed >= 4);
  assert.match(out.backend, /^(numpy|pure-python):target-corpus$/);
});

test('W663 DSIR worker selects deterministically and weights target-like rows higher', (t) => {
  const dir = tempDir(t);
  const rawPath = path.join(dir, 'raw.jsonl');
  const targetPath = path.join(dir, 'target.jsonl');
  const outPath = path.join(dir, 'result.json');
  const raw = [
    ...Array.from({ length: 12 }, (_, i) => supportRow(i)),
    ...Array.from({ length: 8 }, (_, i) => spaceRow(i)),
  ];
  const target = Array.from({ length: 10 }, (_, i) => spaceRow(i + 100));
  writeJsonl(rawPath, raw);
  writeJsonl(targetPath, target);

  const args = [
    '--pairs', rawPath,
    '--target', targetPath,
    '--target-size', '8',
    '--seed', '12345',
    '--dim', '512',
    '--out', outPath,
  ];
  const first = runDsir(args);
  const second = runDsir(args);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);

  const a = parseJsonStdout(first);
  const b = parseJsonStdout(second);
  assert.equal(a.ok, true);
  assert.equal(a.version, 'dsir-v1');
  assert.equal(a.n_in, raw.length);
  assert.equal(a.n_target, target.length);
  assert.equal(a.n_selected, 8);
  assert.equal(a.dim, 512);
  assert.equal(a.weights.length, raw.length);
  assert.equal(new Set(a.selected_indices).size, 8);
  assert.deepEqual(a.selected_indices, b.selected_indices);
  assert.deepEqual(a.weights, b.weights);
  assert.deepEqual(JSON.parse(fs.readFileSync(outPath, 'utf8')), a);

  const supportMean = a.weights.slice(0, 12).reduce((sum, x) => sum + x, 0) / 12;
  const spaceMean = a.weights.slice(12).reduce((sum, x) => sum + x, 0) / 8;
  assert.ok(spaceMean > supportMean, `space target mean ${spaceMean} should exceed support mean ${supportMean}`);
  assert.match(a.backend_used, /^(numpy|pure-python):target-corpus$/);
});

test('W663 DSIR worker supports stdin and bare-string rows in uniform-target mode', () => {
  const result = runDsir(['--target-size', '1', '--seed', '7', '--dim', '64'], {
    input: 'alpha billing refund\norbit galaxy telescope\n',
  });
  assert.equal(result.status, 0, result.stderr);
  const out = parseJsonStdout(result);
  assert.equal(out.ok, true);
  assert.equal(out.n_in, 2);
  assert.equal(out.n_target, 0);
  assert.equal(out.n_selected, 1);
  assert.equal(out.weights.length, 2);
  assert.match(out.backend_used, /^(numpy|pure-python):uniform-target$/);
});

test('W663 DSIR worker fails closed on huge dimensions and oversized input lines', (t) => {
  const dir = tempDir(t);
  const rawPath = path.join(dir, 'raw.jsonl');
  writeJsonl(rawPath, [supportRow(1), spaceRow(2)]);

  const hugeDim = runDsir(['--pairs', rawPath, '--dim', '129'], {
    env: { KOLM_DSIR_MAX_DIM: '128' },
  });
  assert.equal(hugeDim.status, 20);
  const hugeDimOut = parseJsonStdout(hugeDim);
  assert.equal(hugeDimOut.ok, false);
  assert.equal(hugeDimOut.error, 'dim_too_large');

  const longPath = path.join(dir, 'long.jsonl');
  fs.writeFileSync(longPath, JSON.stringify({ input: 'x'.repeat(80), output: 'y' }) + '\n', 'utf8');
  const longLine = runDsir(['--pairs', longPath], {
    env: { KOLM_DSIR_MAX_LINE_CHARS: '32' },
  });
  assert.equal(longLine.status, 20);
  const longLineOut = parseJsonStdout(longLine);
  assert.equal(longLineOut.ok, false);
  assert.equal(longLineOut.error, 'input_line_too_large');
});

test('W663 DSIR worker reports missing target files without throwing', (t) => {
  const dir = tempDir(t);
  const rawPath = path.join(dir, 'raw.jsonl');
  writeJsonl(rawPath, [supportRow(1), spaceRow(2)]);
  const result = runDsir(['--pairs', rawPath, '--target', path.join(dir, 'missing.jsonl')]);
  assert.equal(result.status, 20);
  const out = parseJsonStdout(result);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'target_not_found');
});
