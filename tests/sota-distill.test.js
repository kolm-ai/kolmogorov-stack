// SOTA Distill lane - curriculum/importance threading + first-class trainer
// wiring. Exercises the REAL fixes shipped in this build pass:
//
//   D-01 src/distill-pipeline.js   _resolveOrderingPolicy() + _writeWorkerInputs:
//                                  curriculum ordering stamps complexity_proxy +
//                                  pre-orders rows; importance emits the sibling
//                                  importance-weights.jsonl; distill() forwards
//                                  --curriculum / --importance-weights to the
//                                  worker argv. Off-by-default is byte-identical.
//   D-02 src/distill-preference.js resolveTrainer() in_repo fallback to
//                                  train_preference.py + KOLM_PREFERENCE_NO_TRAINER
//                                  opt-out; reward_source threaded.
//   D-03 src/distill-onpolicy.js   resolveTrainer() in_repo fallback to
//                                  train_gkd.py (white-box GKD) + teacher gate +
//                                  KOLM_ONPOLICY_NO_TRAINER opt-out.
//   D-04 src/spec-decode.js        resolveTrainer() in_repo fallback to
//                                  apps/trainer/eagle3_train.py + KOLM_SPECDECODE_NO_TRAINER
//                                  opt-out.
//   D-05 workers/distill/scripts/* train_preference.py + train_specdecode.py
//                                  --self-test (K-score margin reward + EAGLE KL
//                                  loss + Medusa head loss are REAL, CPU-proven).
//
// Pure JS + the Python --self-test shells (no torch needed). Run:
//   node --test tests/sota-distill.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  distill,
  _resolveOrderingPolicy,
} from '../src/distill-pipeline.js';
import * as preference from '../src/distill-preference.js';
import * as onpolicy from '../src/distill-onpolicy.js';
import * as specdecode from '../src/spec-decode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

function _pythonBin() {
  return process.env.KOLM_PYTHON || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

function mkSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-distill-test-'));
  return dir;
}

// Drive distill() in stub mode (no teacher) so it stages worker inputs WITHOUT
// spawning a real trainer, then return the run dir we can inspect. We override
// KOLM_DATA_DIR to a sandbox so the run lands somewhere we can read.
async function runStubDistill(opts) {
  const drained = [];
  for await (const evt of distill({
    student_base: 'qwen-0.5b',
    pairs_override: opts.pairs,
    // worker_cmd points at a node no-op so the spawn exits instantly; the
    // staging (seeds + importance weights) happens BEFORE the spawn so we still
    // observe it. We use process.execPath with -e 'process.exit(0)'.
    worker_cmd: opts.worker_cmd,
    emit_progress_every: 0,
    curriculum: opts.curriculum,
    importance: opts.importance,
    teacher_fallback: false,
  })) {
    drained.push(evt);
  }
  return drained;
}

// ---------------------------------------------------------------------------
// D-01: ordering policy resolver
// ---------------------------------------------------------------------------

test('D-01 _resolveOrderingPolicy: off by default', () => {
  const prevC = process.env.KOLM_DISTILL_CURRICULUM;
  const prevI = process.env.KOLM_DISTILL_IMPORTANCE;
  delete process.env.KOLM_DISTILL_CURRICULUM;
  delete process.env.KOLM_DISTILL_IMPORTANCE;
  try {
    const p = _resolveOrderingPolicy({});
    assert.equal(p.curriculum, null);
    assert.equal(p.importance, false);
  } finally {
    if (prevC !== undefined) process.env.KOLM_DISTILL_CURRICULUM = prevC;
    if (prevI !== undefined) process.env.KOLM_DISTILL_IMPORTANCE = prevI;
  }
});

test('D-01 _resolveOrderingPolicy: opts + env activation', () => {
  assert.equal(_resolveOrderingPolicy({ curriculum: '1' }).curriculum, 'ascending');
  assert.equal(_resolveOrderingPolicy({ curriculum: 'descending' }).curriculum, 'descending');
  assert.equal(_resolveOrderingPolicy({ importance: 'true' }).importance, true);
  const prev = process.env.KOLM_DISTILL_CURRICULUM;
  process.env.KOLM_DISTILL_CURRICULUM = 'ascending';
  try {
    assert.equal(_resolveOrderingPolicy({}).curriculum, 'ascending');
  } finally {
    if (prev === undefined) delete process.env.KOLM_DISTILL_CURRICULUM;
    else process.env.KOLM_DISTILL_CURRICULUM = prev;
  }
});

// ---------------------------------------------------------------------------
// D-01: staging stamps complexity_proxy + emits importance-weights.jsonl and
// the run yields ordering metadata.
// ---------------------------------------------------------------------------

test('D-01 distill() stages curriculum complexity_proxy + ordered seeds', async () => {
  const prevDataDir = process.env.KOLM_DATA_DIR;
  const sandbox = mkSandbox();
  process.env.KOLM_DATA_DIR = sandbox;
  // No-op worker so the spawn exits cleanly without a real trainer.
  const noop = path.join(sandbox, 'noop.mjs');
  fs.writeFileSync(noop, 'process.exit(0);\n');
  try {
    const pairs = [
      { prompt: 'hi', response: 'a', event_id: 'p1' },                          // short -> low complexity
      { prompt: 'explain', response: 'a long structured response with many distinct words and clauses to raise perplexity and length', event_id: 'p2' },
      { prompt: 'mid', response: 'a medium length answer here', event_id: 'p3' },
    ];
    const events = await runStubDistill({ pairs, worker_cmd: noop, curriculum: 'ascending' });
    const done = events.find((e) => e.done);
    assert.ok(done, 'distill yields a done envelope');
    assert.equal(done.ordering.curriculum, 'ascending');
    assert.ok(done.ordering_meta && done.ordering_meta.complexity_stamped, 'complexity stamped');

    // Inspect the staged seeds.jsonl - every row carries complexity_proxy and
    // the rows are ordered ascending by it.
    const seedsPath = path.join(done.artifact_path, '..', 'seeds.jsonl');
    const lines = fs.readFileSync(seedsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 3);
    for (const row of lines) {
      assert.equal(typeof row.complexity_proxy, 'number', 'complexity_proxy stamped on every row');
    }
    const cps = lines.map((r) => r.complexity_proxy);
    for (let i = 1; i < cps.length; i++) {
      assert.ok(cps[i] >= cps[i - 1], `ascending curriculum order: ${cps}`);
    }
  } finally {
    if (prevDataDir === undefined) delete process.env.KOLM_DATA_DIR;
    else process.env.KOLM_DATA_DIR = prevDataDir;
  }
});

test('D-01 distill() emits importance-weights.jsonl + forwards the path', async () => {
  const prevDataDir = process.env.KOLM_DATA_DIR;
  const sandbox = mkSandbox();
  process.env.KOLM_DATA_DIR = sandbox;
  const noop = path.join(sandbox, 'noop.mjs');
  fs.writeFileSync(noop, 'process.exit(0);\n');
  try {
    const pairs = [
      { prompt: 'short', response: 'tiny', event_id: 'i1' },
      { prompt: 'q', response: 'a much longer and denser response from a short prompt', event_id: 'i2' },
    ];
    const events = await runStubDistill({ pairs, worker_cmd: noop, importance: '1' });
    const done = events.find((e) => e.done);
    assert.ok(done.ordering.importance, 'importance flag on done envelope');
    assert.ok(done.ordering_meta.importance_weights, 'importance weights staged');

    const iwPath = path.join(done.artifact_path, '..', 'importance-weights.jsonl');
    assert.ok(fs.existsSync(iwPath), 'importance-weights.jsonl was written');
    const rows = fs.readFileSync(iwPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.equal(typeof r.capture_id, 'string');
      assert.ok(r.importance >= 0 && r.importance <= 1, 'importance in [0,1]');
    }
    // capture_ids must match the supplied event_ids (join key for the sampler).
    assert.deepEqual(rows.map((r) => r.capture_id).sort(), ['i1', 'i2']);
  } finally {
    if (prevDataDir === undefined) delete process.env.KOLM_DATA_DIR;
    else process.env.KOLM_DATA_DIR = prevDataDir;
  }
});

test('D-01 distill() off-by-default does NOT stamp complexity_proxy', async () => {
  const prevDataDir = process.env.KOLM_DATA_DIR;
  const prevC = process.env.KOLM_DISTILL_CURRICULUM;
  const prevI = process.env.KOLM_DISTILL_IMPORTANCE;
  const sandbox = mkSandbox();
  process.env.KOLM_DATA_DIR = sandbox;
  delete process.env.KOLM_DISTILL_CURRICULUM;
  delete process.env.KOLM_DISTILL_IMPORTANCE;
  const noop = path.join(sandbox, 'noop.mjs');
  fs.writeFileSync(noop, 'process.exit(0);\n');
  try {
    const pairs = [{ prompt: 'a', response: 'b', event_id: 'd1' }];
    const events = await runStubDistill({ pairs, worker_cmd: noop });
    const done = events.find((e) => e.done);
    assert.equal(done.ordering.curriculum, null);
    assert.equal(done.ordering.importance, false);
    const seedsPath = path.join(done.artifact_path, '..', 'seeds.jsonl');
    const row = JSON.parse(fs.readFileSync(seedsPath, 'utf8').trim());
    assert.equal(row.complexity_proxy, undefined, 'no complexity_proxy on default path');
    const iwPath = path.join(done.artifact_path, '..', 'importance-weights.jsonl');
    assert.ok(!fs.existsSync(iwPath), 'no importance-weights.jsonl on default path');
  } finally {
    if (prevDataDir === undefined) delete process.env.KOLM_DATA_DIR; else process.env.KOLM_DATA_DIR = prevDataDir;
    if (prevC !== undefined) process.env.KOLM_DISTILL_CURRICULUM = prevC;
    if (prevI !== undefined) process.env.KOLM_DISTILL_IMPORTANCE = prevI;
  }
});

// ---------------------------------------------------------------------------
// D-02: preference trainer wiring
// ---------------------------------------------------------------------------

test('D-02 preference resolveTrainer defaults to in_repo train_preference.py', () => {
  const prev = process.env.KOLM_PREFERENCE_TRAINER;
  const prevNo = process.env.KOLM_PREFERENCE_NO_TRAINER;
  delete process.env.KOLM_PREFERENCE_TRAINER;
  delete process.env.KOLM_PREFERENCE_NO_TRAINER;
  try {
    const d = preference.doctor();
    assert.ok(d.ok, 'preference doctor ok (in_repo trainer present)');
    assert.equal(d.trainer_source, 'in_repo');
    assert.ok(String(d.trainer).endsWith('train_preference.py'));
  } finally {
    if (prev !== undefined) process.env.KOLM_PREFERENCE_TRAINER = prev;
    if (prevNo !== undefined) process.env.KOLM_PREFERENCE_NO_TRAINER = prevNo;
  }
});

test('D-02 preference KOLM_PREFERENCE_NO_TRAINER=1 opt-out is honored', () => {
  const prev = process.env.KOLM_PREFERENCE_NO_TRAINER;
  process.env.KOLM_PREFERENCE_NO_TRAINER = '1';
  try {
    const d = preference.doctor();
    assert.equal(d.ok, false);
    assert.equal(d.error, 'no_trainer_installed');
  } finally {
    if (prev === undefined) delete process.env.KOLM_PREFERENCE_NO_TRAINER;
    else process.env.KOLM_PREFERENCE_NO_TRAINER = prev;
  }
});

// ---------------------------------------------------------------------------
// D-03: white-box on-policy (GKD) trainer wiring + teacher gate
// ---------------------------------------------------------------------------

test('D-03 onpolicy resolveTrainer defaults to in_repo train_gkd.py', () => {
  const prev = process.env.KOLM_ONPOLICY_TRAINER;
  const prevNo = process.env.KOLM_ONPOLICY_NO_TRAINER;
  delete process.env.KOLM_ONPOLICY_TRAINER;
  delete process.env.KOLM_ONPOLICY_NO_TRAINER;
  try {
    const d = onpolicy.doctor();
    assert.ok(d.ok);
    assert.equal(d.trainer_source, 'in_repo');
    assert.ok(String(d.trainer).endsWith('train_gkd.py'));
    assert.equal(d.requires_local_teacher, true);
  } finally {
    if (prev !== undefined) process.env.KOLM_ONPOLICY_TRAINER = prev;
    if (prevNo !== undefined) process.env.KOLM_ONPOLICY_NO_TRAINER = prevNo;
  }
});

test('D-03 onpolicy in_repo path fails loud without a teacher', () => {
  const sandbox = mkSandbox();
  const pairs = path.join(sandbox, 'pairs.jsonl');
  fs.writeFileSync(pairs, '{"prompt":"a","completion":"b"}\n');
  const prevNo = process.env.KOLM_ONPOLICY_NO_TRAINER;
  const prevT = process.env.KOLM_ONPOLICY_TEACHER;
  const prevOverride = process.env.KOLM_ONPOLICY_TRAINER;
  delete process.env.KOLM_ONPOLICY_NO_TRAINER;
  delete process.env.KOLM_ONPOLICY_TEACHER;
  delete process.env.KOLM_ONPOLICY_TRAINER;
  try {
    const r = onpolicy.trainOnPolicy({ pairsPath: pairs, studentPath: 'student', outDir: path.join(sandbox, 'out') });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'teacher_required');
    assert.match(r.detail, /local teacher/i);
  } finally {
    if (prevNo !== undefined) process.env.KOLM_ONPOLICY_NO_TRAINER = prevNo;
    if (prevT !== undefined) process.env.KOLM_ONPOLICY_TEACHER = prevT;
    if (prevOverride !== undefined) process.env.KOLM_ONPOLICY_TRAINER = prevOverride;
  }
});

test('D-03 onpolicy KOLM_ONPOLICY_NO_TRAINER=1 opt-out is honored', () => {
  const prev = process.env.KOLM_ONPOLICY_NO_TRAINER;
  process.env.KOLM_ONPOLICY_NO_TRAINER = '1';
  try {
    const d = onpolicy.doctor();
    assert.equal(d.ok, false);
    assert.equal(d.error, 'no_trainer_installed');
  } finally {
    if (prev === undefined) delete process.env.KOLM_ONPOLICY_NO_TRAINER;
    else process.env.KOLM_ONPOLICY_NO_TRAINER = prev;
  }
});

// ---------------------------------------------------------------------------
// D-04: speculative-decoding trainer wiring
// ---------------------------------------------------------------------------

test('D-04 spec-decode resolveTrainer defaults to in_repo eagle3_train.py', () => {
  const prev = process.env.KOLM_SPECDECODE_TRAINER;
  const prevNo = process.env.KOLM_SPECDECODE_NO_TRAINER;
  delete process.env.KOLM_SPECDECODE_TRAINER;
  delete process.env.KOLM_SPECDECODE_NO_TRAINER;
  try {
    const t = specdecode.resolveTrainer();
    assert.ok(t, 'in_repo trainer resolved');
    assert.equal(t.source, 'in_repo');
    assert.ok(t.argv[1].endsWith(path.join('apps', 'trainer', 'eagle3_train.py')));
    const d = specdecode.doctor();
    assert.ok(d.ok && d.ready);
    assert.equal(d.trainer_source, 'in_repo');
  } finally {
    if (prev !== undefined) process.env.KOLM_SPECDECODE_TRAINER = prev;
    if (prevNo !== undefined) process.env.KOLM_SPECDECODE_NO_TRAINER = prevNo;
  }
});

test('D-04 spec-decode KOLM_SPECDECODE_NO_TRAINER=1 opt-out is honored', () => {
  const prev = process.env.KOLM_SPECDECODE_NO_TRAINER;
  process.env.KOLM_SPECDECODE_NO_TRAINER = '1';
  try {
    const t = specdecode.resolveTrainer();
    assert.equal(t, null);
    const d = specdecode.doctor();
    assert.equal(d.ok, false);
  } finally {
    if (prev === undefined) delete process.env.KOLM_SPECDECODE_NO_TRAINER;
    else process.env.KOLM_SPECDECODE_NO_TRAINER = prev;
  }
});

// ---------------------------------------------------------------------------
// D-05: Python trainer --self-test (K-score margin reward + EAGLE/Medusa loss).
// ---------------------------------------------------------------------------

test('D-05 train_preference.py --self-test (K-score margin reward is real)', () => {
  const script = path.join(REPO, 'workers', 'distill', 'scripts', 'train_preference.py');
  const r = spawnSync(_pythonBin(), [script, '--self-test'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `self-test exit 0; stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.ok, true);
  assert.ok(out.checks.includes('score_delta'));
  assert.ok(out.checks.includes('kscore_overlap'));
});

test('D-05 train_specdecode.py --self-test (EAGLE KL + draft pairing real)', () => {
  const script = path.join(REPO, 'workers', 'distill', 'scripts', 'train_specdecode.py');
  const r = spawnSync(_pythonBin(), [script, '--self-test'], { encoding: 'utf8' });
  assert.equal(r.status, 0, `self-test exit 0; stderr: ${r.stderr}`);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.ok, true);
  assert.ok(out.checks.includes('draft_pairing'));
  assert.ok(out.checks.includes('draft_config'));
});
