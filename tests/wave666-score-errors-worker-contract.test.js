// W666 - direct contract for workers/data/scripts/score_errors.py.
//
// Focus: the Python Confident-Learning label-error worker itself, not only the
// JS data-label-errors module. Exercises deterministic subprocess behavior,
// malformed input tolerance, missing-file fallback, and fail-closed resource
// limits before the worker builds its N x K score matrix.

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
const SCRIPT = path.resolve('workers/data/scripts/score_errors.py');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w666-score-errors-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeJsonl(file, rows) {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function runScore(args, { input = null, env = {} } = {}) {
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

function buildCLCorpus() {
  const topics = [
    'refund billing invoice payment money charge bank account statement',
    'password login signin access reset security token credential verify',
    'install setup download requirements desktop application binary package',
  ];
  const rows = [];
  for (let c = 0; c < 3; c++) {
    for (let k = 0; k < 10; k++) {
      rows.push({
        input: `${topics[c]} question ${k}`,
        output: `${topics[c]} detailed answer covering it ${k}`,
        cluster_id: `c${c}`,
      });
    }
  }
  const injected = [
    { idx: 2, toCluster: 1 },
    { idx: 13, toCluster: 2 },
    { idx: 24, toCluster: 0 },
  ];
  for (const { idx, toCluster } of injected) {
    rows[idx].output = `${topics[toCluster]} detailed answer covering it foreign`;
  }
  return { rows, injected: injected.map((x) => x.idx) };
}

test('W666 score_errors worker self-test passes through the Python CLI', () => {
  const result = runScore(['--self-test']);
  assert.equal(result.status, 0, result.stderr);
  const out = parseJsonStdout(result);
  assert.equal(out.ok, true);
  assert.equal(out.self_test, true);
  assert.equal(out.total, 5);
  assert.equal(out.passed, 5);
  assert.ok(out.caught_mislabels >= 2);
  assert.match(out.backend, /^cl-(pure|cleanlab)$/);
  assert.match(result.stderr, /score_errors --self-test/);
});

test('W666 score_errors worker flags injected off-diagonal rows deterministically', (t) => {
  const dir = tempDir(t);
  const rawPath = path.join(dir, 'raw.jsonl');
  const outPath = path.join(dir, 'result.json');
  const { rows, injected } = buildCLCorpus();
  writeJsonl(rawPath, rows);

  const args = [
    '--pairs', rawPath,
    '--cluster-field', 'cluster_id',
    '--action', 'filter',
    '--seed', '12345',
    '--out', outPath,
  ];
  const first = runScore(args);
  const second = runScore(args);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);

  const a = parseJsonStdout(first);
  const b = parseJsonStdout(second);
  assert.deepEqual(a, b);
  assert.deepEqual(JSON.parse(fs.readFileSync(outPath, 'utf8')), a);
  assert.equal(a.ok, true);
  assert.equal(a.action, 'filter');
  assert.equal(a.n, rows.length);
  assert.equal(a.n_clusters, 3);
  assert.match(a.backend, /^cl-(pure|cleanlab)$/);
  assert.equal(a.scores.length, rows.length);
  assert.ok(a.off_diagonal_rate > 0);
  for (const idx of injected) {
    assert.ok(a.flagged_indices.includes(idx), `expected injected row ${idx} to be flagged`);
  }
  assert.deepEqual(a.drop_candidates, a.flagged_indices);
});

test('W666 score_errors worker supports stdin and skips malformed JSONL rows', () => {
  const input = [
    '{"input":"q1","output":"billing invoice refund","cluster_id":"billing"}',
    '{not json',
    '{"input":"q2","output":"billing payment receipt","cluster_id":"billing"}',
  ].join('\n') + '\n';

  const result = runScore(['--cluster-field', 'cluster_id'], { input });
  assert.equal(result.status, 0, result.stderr);
  const out = parseJsonStdout(result);
  assert.equal(out.ok, true);
  assert.equal(out.n, 2);
  assert.equal(out.n_clusters, 1);
  assert.equal(out.backend, 'cl-pure-single-cluster');
  assert.match(out.note, /single_cluster/);
});

test('W666 score_errors worker fails closed on oversized tunables and inputs', (t) => {
  const dir = tempDir(t);
  const rawPath = path.join(dir, 'raw.jsonl');
  writeJsonl(rawPath, [
    { input: 'billing question', output: 'billing invoice payment', cluster_id: 'billing' },
    { input: 'auth question', output: 'login password token', cluster_id: 'auth' },
  ]);

  const longPath = path.join(dir, 'long.jsonl');
  fs.writeFileSync(longPath, JSON.stringify({ input: 'x'.repeat(80), output: 'y' }) + '\n', 'utf8');
  const longLine = runScore(['--pairs', longPath], {
    env: { KOLM_SCORE_ERRORS_MAX_LINE_CHARS: '32' },
  });
  assert.equal(longLine.status, 20);
  assert.equal(parseJsonStdout(longLine).error, 'input_line_too_large');

  const tooManyRows = runScore(['--pairs', rawPath], {
    env: { KOLM_SCORE_ERRORS_MAX_ROWS: '1' },
  });
  assert.equal(tooManyRows.status, 20);
  assert.equal(parseJsonStdout(tooManyRows).error, 'input_too_many_rows');

  const tooManyClusters = runScore(['--pairs', rawPath], {
    env: { KOLM_SCORE_ERRORS_MAX_CLUSTERS: '1' },
  });
  assert.equal(tooManyClusters.status, 20);
  assert.equal(parseJsonStdout(tooManyClusters).error, 'cluster_count_too_large');

  const tooManyCells = runScore(['--pairs', rawPath], {
    env: { KOLM_SCORE_ERRORS_MAX_SCORE_CELLS: '3' },
  });
  assert.equal(tooManyCells.status, 20);
  assert.equal(parseJsonStdout(tooManyCells).error, 'score_matrix_too_large');
});

test('W666 score_errors worker reports missing input files without throwing', (t) => {
  const dir = tempDir(t);
  const result = runScore(['--pairs', path.join(dir, 'missing.jsonl')]);
  assert.equal(result.status, 0);
  const out = parseJsonStdout(result);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'read_failed');
});
