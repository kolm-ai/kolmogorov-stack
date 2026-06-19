import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  DISTILL_BAKEOFF_VERSION,
  loadDistillBakeoffJsonl,
  runDistillMethodBakeoff,
} from '../src/distill-bakeoff.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'distill-method-bakeoff.mjs');

const rows = [
  {
    id: 'r1',
    prompt: 'private prompt alpha',
    teacher_output: 'return the exact invoice total',
    method_outputs: {
      seqkd: 'invoice total',
      ropd: 'exact invoice total',
      gad: 'return the exact invoice total',
    },
  },
  {
    id: 'r2',
    prompt: 'private prompt beta',
    teacher_output: 'refuse unsafe key disclosure',
    method_outputs: {
      seqkd: 'unsafe key disclosure',
      ropd: 'refuse key disclosure',
      gad: 'refuse unsafe key disclosure',
    },
  },
];

function fixtureJudge({ actual }) {
  if (actual.startsWith('return the exact') || actual.startsWith('refuse unsafe')) return { score: 0.95, kscore: 0.91 };
  if (actual.includes('exact') || actual.includes('refuse')) return { score: 0.75, kscore: 0.8 };
  return { score: 0.35, kscore: 0.5 };
}

test('W972 #1 - method bakeoff ranks GAD over ROPD and SeqKD with callable judge', async () => {
  const report = await runDistillMethodBakeoff({
    rows,
    methods: ['seqkd', 'ropd', 'gad'],
    baseline_method: 'seqkd',
    judge: fixtureJudge,
    judge_kind: 'fixture_teacher_text_judge',
    min_score_delta: 0.1,
    min_win_rate: 0.9,
  });
  assert.equal(report.ok, true);
  assert.equal(report.version, DISTILL_BAKEOFF_VERSION);
  assert.equal(report.claim_scope, 'method_head_to_head_with_callable_judge');
  assert.equal(report.judge_kind, 'fixture_teacher_text_judge');
  assert.equal(report.best_method, 'gad');
  assert.equal(report.gate.pass, true);
  const gad = report.ranked_methods.find((m) => m.method === 'gad');
  assert.equal(gad.completed, 2);
  assert.equal(gad.win_rate_vs_baseline, 1);
  assert.ok(gad.score_delta_vs_baseline > 0.5);
  assert.ok(gad.avg_kscore > 0.9);
});

test('W972 #2 - row evidence is hash-only and does not echo prompts or outputs', async () => {
  const report = await runDistillMethodBakeoff({ rows, judge: fixtureJudge });
  const json = JSON.stringify(report);
  assert.equal(report.privacy_mode, 'hash_only');
  assert.doesNotMatch(json, /private prompt alpha/);
  assert.doesNotMatch(json, /return the exact invoice total/);
  assert.match(json, /output_sha256/);
  assert.match(json, /teacher_output_sha256/);
});

test('W972 #3 - K-score hook contributes avg_kscore when judge omits it', async () => {
  const report = await runDistillMethodBakeoff({
    rows,
    methods: ['seqkd', 'gad'],
    judge: ({ actual }) => ({ score: actual.includes('refuse') || actual.includes('return') ? 0.8 : 0.2 }),
    kscore: ({ actual }) => ({ score: actual.includes('unsafe') ? 0.9 : 0.4 }),
  });
  assert.equal(report.ok, true);
  const gad = report.ranked_methods.find((m) => m.method === 'gad');
  assert.ok(gad.avg_kscore > 0.6);
});

test('W972 #4 - missing runner and method outputs fail honestly', async () => {
  const report = await runDistillMethodBakeoff({
    rows: [{ id: 'r1', prompt: 'x', teacher_output: 'y' }],
    methods: ['seqkd', 'gad'],
  });
  assert.equal(report.ok, false);
  assert.equal(report.error, 'no_method_outputs_or_runner');
});

test('W972 #5 - heuristic fallback is labeled as non-quality claim', async () => {
  const report = await runDistillMethodBakeoff({ rows, methods: ['seqkd', 'gad'] });
  assert.equal(report.ok, true);
  assert.equal(report.judge_kind, 'heuristic_token_jaccard');
  assert.equal(report.claim_scope, 'heuristic_local_overlap_smoke_not_quality_claim');
});

test('W972 #6 - JSONL loader rejects malformed rows loudly', () => {
  assert.throws(() => loadDistillBakeoffJsonl('{"ok":true}\n{bad'), /malformed JSONL/);
});

test('W972 #7 - CLI emits a summary from precomputed method outputs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w972-'));
  const jsonl = path.join(dir, 'rows.jsonl');
  fs.writeFileSync(jsonl, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const r = spawnSync(process.execPath, [
    SCRIPT,
    '--rows', jsonl,
    '--methods', 'seqkd,ropd,gad',
    '--baseline', 'seqkd',
    '--summary',
  ], { encoding: 'utf8', cwd: ROOT, timeout: 30_000 });
  assert.equal(r.status, 0, `stderr=${r.stderr}\nstdout=${r.stdout}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.version, DISTILL_BAKEOFF_VERSION);
  assert.equal(out.best_method, 'gad');
  assert.equal(out.gate.pass, true);
  assert.equal(out.claim_scope, 'heuristic_local_overlap_smoke_not_quality_claim');
});
