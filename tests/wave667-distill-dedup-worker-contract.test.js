// W667 - direct contract for workers/distill/scripts/dedup_pairs.py.
//
// Focus: the Python semantic near-duplicate worker itself, not only the JS
// data-curation fallback. Exercises deterministic n-gram fallback behavior,
// survivor ordering, malformed-row tolerance, preview/report semantics, and
// fail-closed resource limits around the O(n^2) dedup boundary.

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
const SCRIPT = path.resolve('workers/distill/scripts/dedup_pairs.py');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w667-dedup-pairs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJsonl(file, rows) {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function readJsonl(file) {
  const body = fs.readFileSync(file, 'utf8').trim();
  return body ? body.split(/\r?\n/).map((line) => JSON.parse(line)) : [];
}

function runDedup(args, { env = {} } = {}) {
  return spawnSync(PYTHON, [SCRIPT, ...args], {
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

function longAnswer(topic, suffix = '') {
  const words = String(topic).split(/\s+/).filter(Boolean);
  const phrase = words.join(' ');
  return Array.from({ length: 10 }, (_, i) => `${phrase} ${words[i % words.length]} detail${i}`)
    .concat(suffix ? [suffix] : [])
    .join(' ')
    .trim();
}

function contractRows() {
  const billing = longAnswer('billing');
  const refund = longAnswer('refund');
  return [
    {
      id: 'high-confidence',
      input: 'How do I update billing?',
      teacher_output: billing,
      _teacher_phase: 'gpt4o',
      confidence: 0.95,
    },
    {
      id: 'teacher-priority-low-confidence',
      input: 'How do I update billing?',
      teacher_output: billing,
      _teacher_phase: 'claude',
      confidence: 0.10,
    },
    {
      id: 'clean-refund',
      input: 'How do I request a refund?',
      teacher_output: refund,
      _teacher_phase: 'claude',
    },
    {
      id: 'cot-refund',
      input: 'How do I request a refund?',
      teacher_output: `<think>recall refund policy</think> ${refund}`,
      _teacher_phase: 'claude',
    },
    {
      id: 'distinct-auth',
      input: 'How do I reset a password?',
      teacher_output: longAnswer('password login token mfa credential security', 'sessions revoked after reset'),
      _teacher_phase: 'deepseek',
    },
    {
      id: 'distinct-install',
      input: 'How do I install the desktop app?',
      teacher_output: longAnswer('desktop installer package download signature binary', 'signed launch verified'),
      _teacher_phase: 'gpt4o',
    },
  ];
}

test('W667 dedup_pairs worker self-test passes through the Python CLI', () => {
  const result = runDedup(['--self-test']);
  assert.equal(result.status, 0, result.stderr);
  const out = parseJsonStdout(result);
  assert.equal(out.ok, true);
  assert.equal(out.self_test, true);
  assert.equal(out.passed, 5);
  assert.deepEqual(out.removed_ids.sort(), ['cot-refund', 'teacher-priority-low-confidence']);
  assert.match(result.stderr, /dedup --self-test/);
});

test('W667 dedup_pairs worker dedupes deterministically and honors survivor ordering', (t) => {
  const dir = tempDir(t);
  const rawPath = path.join(dir, 'pairs.jsonl');
  const outPath = path.join(dir, 'deduped.jsonl');
  const reportPath = path.join(dir, 'report.json');
  writeJsonl(rawPath, contractRows());

  const args = [
    '--embedder', 'ngram',
    '--pairs', rawPath,
    '--out', outPath,
    '--report', reportPath,
    '--threshold', '0.82',
    '--teacher-priority', 'claude,gpt4o,deepseek',
  ];
  const first = runDedup(args, { env: { PYTHONHASHSEED: 'random' } });
  const second = runDedup(args, { env: { PYTHONHASHSEED: '123' } });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);

  const a = parseJsonStdout(first);
  const b = parseJsonStdout(second);
  assert.deepEqual(a, b);
  assert.equal(a.ok, true);
  assert.equal(a.version, 't2.1-v1');
  assert.equal(a.backend, 'sparse');
  assert.equal(a.embedder_used, 'ngram:hashed-2048');
  assert.equal(a.threshold, 0.82);
  assert.equal(a.n_in, 6);
  assert.equal(a.n_kept, 4);
  assert.equal(a.n_removed, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(reportPath, 'utf8')), a);

  const keptIds = readJsonl(outPath).map((r) => r.id).sort();
  assert.deepEqual(keptIds, ['clean-refund', 'distinct-auth', 'distinct-install', 'high-confidence']);
});

test('W667 dedup_pairs worker skips malformed and non-object JSONL rows', (t) => {
  const dir = tempDir(t);
  const rawPath = path.join(dir, 'mixed.jsonl');
  const outPath = path.join(dir, 'out.jsonl');
  fs.writeFileSync(rawPath, [
    JSON.stringify({ id: 'a', input: 'q', teacher_output: longAnswer('alpha') }),
    '{not json',
    JSON.stringify('not an object'),
    JSON.stringify({ id: 'b', input: 'q', teacher_output: longAnswer('alpha') }),
  ].join('\n') + '\n', 'utf8');

  const result = runDedup(['--embedder', 'ngram', '--pairs', rawPath, '--out', outPath, '--threshold', '0.9']);
  assert.equal(result.status, 0, result.stderr);
  const out = parseJsonStdout(result);
  assert.equal(out.ok, true);
  assert.equal(out.n_in, 2);
  assert.equal(out.n_kept, 1);
  assert.equal(readJsonl(outPath).length, 1);
});

test('W667 dedup_pairs worker preview mode does not write output', (t) => {
  const dir = tempDir(t);
  const rawPath = path.join(dir, 'pairs.jsonl');
  const outPath = path.join(dir, 'preview.jsonl');
  writeJsonl(rawPath, contractRows());

  const result = runDedup([
    '--embedder', 'ngram',
    '--pairs', rawPath,
    '--out', outPath,
    '--preview',
    '--threshold', '0.82',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const out = parseJsonStdout(result);
  assert.equal(out.ok, true);
  assert.equal(out.preview, true);
  assert.equal(out.wrote, null);
  assert.equal(fs.existsSync(outPath), false);
});

test('W667 dedup_pairs worker fails closed on invalid thresholds and oversized inputs', (t) => {
  const dir = tempDir(t);
  const rawPath = path.join(dir, 'pairs.jsonl');
  writeJsonl(rawPath, [
    { id: 'a', input: 'q1', teacher_output: longAnswer('alpha') },
    { id: 'b', input: 'q2', teacher_output: longAnswer('beta') },
    { id: 'c', input: 'q3', teacher_output: longAnswer('gamma') },
  ]);

  const badThreshold = runDedup(['--embedder', 'ngram', '--pairs', rawPath, '--preview', '--threshold', 'Infinity']);
  assert.equal(badThreshold.status, 20);
  assert.equal(parseJsonStdout(badThreshold).error, 'threshold_invalid');

  const tooManyRows = runDedup(['--embedder', 'ngram', '--pairs', rawPath, '--preview'], {
    env: { KOLM_DEDUP_PAIRS_MAX_ROWS: '1' },
  });
  assert.equal(tooManyRows.status, 20);
  assert.equal(parseJsonStdout(tooManyRows).error, 'input_too_many_rows');

  const tooManyComparisons = runDedup(['--embedder', 'ngram', '--pairs', rawPath, '--preview'], {
    env: { KOLM_DEDUP_PAIRS_MAX_COMPARISONS: '1' },
  });
  assert.equal(tooManyComparisons.status, 20);
  assert.equal(parseJsonStdout(tooManyComparisons).error, 'comparison_budget_exceeded');

  const longLinePath = path.join(dir, 'long-line.jsonl');
  fs.writeFileSync(longLinePath, JSON.stringify({ input: 'x'.repeat(80), teacher_output: 'y' }) + '\n', 'utf8');
  const longLine = runDedup(['--embedder', 'ngram', '--pairs', longLinePath, '--preview'], {
    env: { KOLM_DEDUP_PAIRS_MAX_LINE_CHARS: '32' },
  });
  assert.equal(longLine.status, 20);
  assert.equal(parseJsonStdout(longLine).error, 'input_line_too_large');

  const longText = runDedup(['--embedder', 'ngram', '--pairs', longLinePath, '--preview'], {
    env: { KOLM_DEDUP_PAIRS_MAX_TEXT_CHARS: '16' },
  });
  assert.equal(longText.status, 20);
  assert.equal(parseJsonStdout(longText).error, 'text_too_large');
});

test('W667 dedup_pairs worker reports missing input and missing --out cleanly', (t) => {
  const dir = tempDir(t);
  const missing = runDedup(['--embedder', 'ngram', '--pairs', path.join(dir, 'missing.jsonl'), '--out', path.join(dir, 'out.jsonl')]);
  assert.equal(missing.status, 20);
  assert.equal(parseJsonStdout(missing).error, 'input_not_found');

  const rawPath = path.join(dir, 'pairs.jsonl');
  writeJsonl(rawPath, contractRows().slice(0, 2));
  const noOut = runDedup(['--embedder', 'ngram', '--pairs', rawPath]);
  assert.equal(noOut.status, 0);
  assert.equal(parseJsonStdout(noOut).error, 'out_required');
});
