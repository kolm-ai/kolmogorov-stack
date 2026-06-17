// W664 - direct contract for workers/data/scripts/minhash_dedup.py.
//
// Focus: the Python MinHash/LSH worker itself, not only the JS parity module.
// Exercises deterministic subprocess behavior, malformed input tolerance, and
// fail-closed resource limits on the worker boundary.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const PYTHON = process.env.KOLM_PYTHON || process.env.PYTHON || 'python';
const SCRIPT = path.resolve('workers/data/scripts/minhash_dedup.py');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w664-minhash-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJsonl(file, rows) {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function runMinhash(args, { input = null, env = {} } = {}) {
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

function goldRows() {
  const near = 'the annual report shows revenue grew twelve percent over the prior fiscal year';
  return [
    { input: 'q1', output: near },
    { input: 'q2', output: `${near} indeed` },
    { input: 'q3', output: 'the annual report shows revenue grew twelve percent over the prior year' },
    { input: 'q4', output: 'kubernetes schedules containerized workloads across a fleet of worker nodes' },
    { input: 'q5', output: 'photosynthesis converts sunlight carbon dioxide and water into glucose and oxygen' },
    { input: 'q6', output: 'the mitochondria is widely described as the powerhouse of the eukaryotic cell' },
  ];
}

test('W664 MinHash worker self-test passes through the Python CLI', () => {
  const result = runMinhash(['--self-test']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
  assert.match(result.stderr, /self-test: PASS=\d+ FAIL=0/);
});

test('W664 MinHash worker dedupes deterministically and writes the same JSON receipt', (t) => {
  const dir = tempDir(t);
  const rawPath = path.join(dir, 'raw.jsonl');
  const outPath = path.join(dir, 'result.json');
  writeJsonl(rawPath, goldRows());

  const args = [
    '--pairs', rawPath,
    '--threshold', '0.6',
    '--num-perm', '128',
    '--bands', '16',
    '--rows', '8',
    '--key', 'output',
    '--out', outPath,
  ];
  const first = runMinhash(args);
  const second = runMinhash(args);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);

  const a = parseJsonStdout(first);
  const b = parseJsonStdout(second);
  assert.deepEqual(a, b);
  assert.equal(a.ok, true);
  assert.equal(a.report.version, 'minhash-v1');
  assert.equal(a.report.backend, 'minhash-py');
  assert.equal(a.report.n_in, 6);
  assert.equal(a.report.n_kept, 4);
  assert.equal(a.removed, 2);
  assert.deepEqual(a.duplicate_groups.map((g) => [...g].sort((x, y) => x - y)), [[0, 1, 2]]);
  assert.deepEqual(a.kept_indices, [0, 3, 4, 5]);
  assert.match(a.report.dedup_signature, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(outPath, 'utf8')), a);
});

test('W664 MinHash worker tolerates stdin and malformed JSONL rows', () => {
  const input = [
    '{"input": "valid", "output": "alpha beta gamma delta epsilon zeta"}',
    '{not json',
    '{"input": "valid 2", "output": "alpha beta gamma delta epsilon zeta"}',
  ].join('\n') + '\n';

  const result = runMinhash(['--threshold', '0.6', '--key', 'output'], { input });
  assert.equal(result.status, 0, result.stderr);
  const out = parseJsonStdout(result);
  assert.equal(out.ok, true);
  assert.equal(out.report.n_in, 3);
  assert.equal(out.report.version, 'minhash-v1');
});

test('W664 MinHash worker fails closed on oversized tunables and inputs', (t) => {
  const dir = tempDir(t);
  const rawPath = path.join(dir, 'raw.jsonl');
  writeJsonl(rawPath, goldRows().slice(0, 2));

  const tooManyPerms = runMinhash(['--pairs', rawPath, '--num-perm', '9'], {
    env: { KOLM_MINHASH_MAX_NUM_HASHES: '8' },
  });
  assert.equal(tooManyPerms.status, 20);
  assert.equal(parseJsonStdout(tooManyPerms).error, 'num_perm_too_large');

  const longPath = path.join(dir, 'long.jsonl');
  fs.writeFileSync(longPath, JSON.stringify({ input: 'x'.repeat(80), output: 'y' }) + '\n', 'utf8');
  const longLine = runMinhash(['--pairs', longPath], {
    env: { KOLM_MINHASH_MAX_LINE_CHARS: '32' },
  });
  assert.equal(longLine.status, 20);
  assert.equal(parseJsonStdout(longLine).error, 'input_line_too_large');

  const tooManyRows = runMinhash(['--pairs', rawPath], {
    env: { KOLM_MINHASH_MAX_ROWS: '1' },
  });
  assert.equal(tooManyRows.status, 20);
  assert.equal(parseJsonStdout(tooManyRows).error, 'input_too_many_rows');

  const badThreshold = runMinhash(['--pairs', rawPath, '--threshold', 'Infinity']);
  assert.equal(badThreshold.status, 20);
  assert.equal(parseJsonStdout(badThreshold).error, 'threshold_invalid');
});

test('W664 MinHash worker reports missing input files without throwing', (t) => {
  const dir = tempDir(t);
  const result = runMinhash(['--pairs', path.join(dir, 'missing.jsonl')]);
  assert.equal(result.status, 0);
  const out = parseJsonStdout(result);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'read_failed');
});
