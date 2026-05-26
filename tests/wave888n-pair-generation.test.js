// Wave W888-N — assistant Q&A pair generation lock-ins.
//
// 8 lock-ins covering the W888-N surface:
//   1. dry-run generator runs without errors and emits non-empty training-pairs.jsonl
//   2. every row in training-pairs.jsonl has the required keys (shape contract)
//   3. hallucinated `kolm <fake>` in a synthetic response makes the checker fail
//   4. clean response (only real verbs) passes the checker with exit 0
//   5. holdout split is ~200/~754, with per-bucket counts within +/-20% of proportional
//   6. holdout split is deterministic (running twice produces byte-identical files)
//   7. rejected.jsonl is created when a hallucinated verb appears in the canonical response
//   8. budget abort: --budget 0.001 --limit 50 in dry-run aborts before completing 50 seeds
//
// All tests run at concurrency=1 (project standing rule) and use a per-test
// temp dir so the canonical data/assistant-corpus/ outputs are not clobbered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.resolve(__dirname, '..');

const GEN = path.join(REPO, 'scripts', 'generate-assistant-pairs.mjs');
const CHECK = path.join(REPO, 'scripts', 'check-assistant-hallucinations.cjs');
const SPLIT = path.join(REPO, 'scripts', 'corpus', 'split-holdout.cjs');
const SEEDS = path.join(REPO, 'data', 'assistant-corpus', 'seeds.jsonl');
const INVENTORY = path.join(REPO, 'data', 'assistant-corpus', 'cli-inventory.json');

function tmpDir(label) {
  const d = path.join(os.tmpdir(), `kolm-w888n-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf8');
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    out.push(JSON.parse(line));
  }
  return out;
}

function runGen(extra, env) {
  return spawnSync(process.execPath, [GEN, ...extra], {
    cwd: REPO, encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, ...(env || {}) },
  });
}

function runCheck(extra) {
  return spawnSync(process.execPath, [CHECK, ...extra], {
    cwd: REPO, encoding: 'utf8', timeout: 30_000,
  });
}

function runSplit(extra) {
  return spawnSync(process.execPath, [SPLIT, ...extra], {
    cwd: REPO, encoding: 'utf8', timeout: 30_000,
  });
}

test('W888-N gen: --dry-run --limit 20 emits non-empty training-pairs.jsonl with exit 0', () => {
  assert.ok(fs.existsSync(SEEDS), `seeds.jsonl missing: ${SEEDS}`);
  const dir = tmpDir('dryrun-20');
  const out = path.join(dir, 'training-pairs.jsonl');
  const passport = path.join(dir, 'training-passport.json');
  const r = runGen([
    '--dry-run', '--limit', '20',
    '--out', out,
    '--passport', passport,
    '--disagreements', path.join(dir, 'disagreements.jsonl'),
    '--rejected', path.join(dir, 'rejected.jsonl'),
  ]);
  assert.equal(r.status, 0, `generator exited ${r.status}: ${r.stderr || r.stdout}`);
  assert.ok(fs.existsSync(out), `training-pairs.jsonl missing: ${out}`);
  const rows = readJsonl(out);
  assert.ok(rows.length > 0, `training-pairs.jsonl is empty (limit=20)`);
  // dry-run should keep all 20 (synthetic responses agree perfectly).
  assert.ok(rows.length <= 20, `more rows than seeds: ${rows.length}`);
  assert.ok(fs.existsSync(passport), `passport missing: ${passport}`);
  const p = JSON.parse(fs.readFileSync(passport, 'utf8'));
  assert.equal(p.dry_run, true, 'passport dry_run must be true');
  assert.equal(p.cost_usd, 0, `default dry-run cost must be $0 (got $${p.cost_usd})`);
});

test('W888-N gen: every training-pair row has required keys', () => {
  const dir = tmpDir('shape');
  const out = path.join(dir, 'training-pairs.jsonl');
  const r = runGen([
    '--dry-run', '--limit', '15',
    '--out', out,
    '--passport', path.join(dir, 'training-passport.json'),
    '--disagreements', path.join(dir, 'disagreements.jsonl'),
    '--rejected', path.join(dir, 'rejected.jsonl'),
  ]);
  assert.equal(r.status, 0, `generator exited ${r.status}: ${r.stderr || r.stdout}`);
  const rows = readJsonl(out);
  assert.ok(rows.length > 0, 'no rows to validate shape on');
  for (const row of rows) {
    for (const key of ['id', 'bucket', 'source', 'prompt', 'response', 'teacher_consensus', 'provenance']) {
      assert.ok(Object.prototype.hasOwnProperty.call(row, key), `missing key "${key}" in row ${row.id}`);
    }
    assert.equal(typeof row.id, 'string', 'id must be string');
    assert.equal(typeof row.bucket, 'string', 'bucket must be string');
    assert.equal(typeof row.prompt, 'string', 'prompt must be string');
    assert.equal(typeof row.response, 'string', 'response must be string');
    assert.equal(typeof row.teacher_consensus, 'object', 'teacher_consensus must be object');
    assert.equal(typeof row.teacher_consensus.agreed, 'boolean', 'agreed must be boolean');
    assert.equal(typeof row.teacher_consensus.similarity, 'number', 'similarity must be number');
    assert.equal(typeof row.provenance, 'object', 'provenance must be object');
    assert.ok(Array.isArray(row.provenance.teacher_models), 'teacher_models must be array');
    assert.equal(row.provenance.teacher_models.length, 2, 'expected exactly 2 teachers');
    assert.equal(typeof row.provenance.timestamp_iso, 'string', 'timestamp_iso must be string');
    assert.equal(typeof row.provenance.seed_row_id, 'string', 'seed_row_id must be string');
    assert.equal(typeof row.provenance.run_id, 'string', 'run_id must be string');
  }
});

test('W888-N check: hallucinated `kolm <fake>` verb makes checker exit non-zero', () => {
  const dir = tmpDir('hallucinated');
  const responses = path.join(dir, 'responses.jsonl');
  const synthetic = [
    { id: 'syn_1', prompt: 'How do I check the kolm doc?', response: 'Run `kolm whoami` to see your tenant.' },
    { id: 'syn_2', prompt: 'How do I do the bad thing?', response: 'Run `kolm definitely-not-a-real-verb --force`.' },
  ];
  fs.writeFileSync(responses, synthetic.map(r => JSON.stringify(r)).join('\n') + '\n');
  const r = runCheck(['--responses', responses, '--json']);
  assert.notEqual(r.status, 0, `checker should fail on hallucinated verb (status=${r.status})`);
  const envelope = JSON.parse(r.stdout);
  assert.equal(envelope.ok, false, 'envelope.ok must be false');
  const invalid = envelope.offenders.filter(o => o.reason === 'invalid_verb');
  assert.ok(invalid.length >= 1, 'expected at least 1 invalid_verb offender');
  assert.equal(invalid[0].invalid, 'definitely-not-a-real-verb', `wrong invalid verb: ${invalid[0].invalid}`);
});

test('W888-N check: clean response (real verbs only) makes checker exit 0', () => {
  const dir = tmpDir('clean');
  const responses = path.join(dir, 'responses.jsonl');
  const clean = [
    { id: 'ok_1', prompt: 'List artifacts?', response: 'Try `kolm artifacts --json` to see all compiled artifacts.' },
    { id: 'ok_2', prompt: 'Who am I?', response: 'Run `kolm whoami` to see your tenant + plan.' },
    { id: 'ok_3', prompt: 'Sign me up?', response: 'Use `kolm signup --email you@example.com`.' },
    { id: 'ok_4', prompt: 'No backticks here?', response: 'You can just open https://kolm.ai/docs/quickstart to read.' },
  ];
  fs.writeFileSync(responses, clean.map(r => JSON.stringify(r)).join('\n') + '\n');
  const r = runCheck(['--responses', responses, '--json']);
  assert.equal(r.status, 0, `checker should pass on clean responses (status=${r.status}, stderr=${r.stderr}, stdout=${r.stdout})`);
  const envelope = JSON.parse(r.stdout);
  assert.equal(envelope.ok, true, 'envelope.ok must be true');
  assert.equal(envelope.offenders.length, 0, `expected 0 offenders, got ${envelope.offenders.length}`);
  assert.ok(envelope.verbs_checked >= 3, `expected at least 3 verbs checked, got ${envelope.verbs_checked}`);
});

test('W888-N split: holdout/train counts are stratified within +/-20% per bucket', () => {
  const dir = tmpDir('split');
  const trainOut = path.join(dir, 'train.jsonl');
  const holdOut = path.join(dir, 'hold.jsonl');
  const r = runSplit([
    '--seeds', SEEDS,
    '--out-train', trainOut,
    '--out-hold', holdOut,
    '--json',
  ]);
  assert.equal(r.status, 0, `split failed: ${r.stderr || r.stdout}`);
  const env = JSON.parse(r.stdout);
  assert.ok(env.ok, 'split envelope.ok must be true');
  const totalSeeds = env.seeds_in;
  // Holdout target is ~200/954 = ~20.96% of seeds.
  const expectedHold = totalSeeds * (200 / 954);
  assert.ok(env.holdout_count >= expectedHold * 0.8, `holdout too small: ${env.holdout_count} < ${(expectedHold * 0.8).toFixed(0)}`);
  assert.ok(env.holdout_count <= expectedHold * 1.25, `holdout too large: ${env.holdout_count} > ${(expectedHold * 1.25).toFixed(0)}`);
  assert.equal(env.holdout_count + env.train_count, totalSeeds, 'holdout + train must equal seeds_in');
  // Per-bucket proportional check. Each bucket should have a holdout
  // proportion within +/-20% of the global proportion (with a floor of 1
  // for tiny buckets, which is why split-holdout uses Math.ceil).
  const globalFrac = env.holdout_count / totalSeeds;
  for (const [bucket, info] of Object.entries(env.per_bucket)) {
    if (info.total < 5) continue; // skip tiny buckets where rounding dominates
    const frac = info.hold / info.total;
    assert.ok(frac >= globalFrac * 0.8 && frac <= globalFrac * 1.25,
      `bucket "${bucket}" hold-fraction ${frac.toFixed(3)} outside [${(globalFrac*0.8).toFixed(3)}, ${(globalFrac*1.25).toFixed(3)}]`);
  }
});

test('W888-N split: deterministic (running twice produces byte-identical files)', () => {
  const dir1 = tmpDir('det1');
  const dir2 = tmpDir('det2');
  const t1 = path.join(dir1, 'train.jsonl');
  const h1 = path.join(dir1, 'hold.jsonl');
  const t2 = path.join(dir2, 'train.jsonl');
  const h2 = path.join(dir2, 'hold.jsonl');
  const a = runSplit(['--seeds', SEEDS, '--out-train', t1, '--out-hold', h1]);
  const b = runSplit(['--seeds', SEEDS, '--out-train', t2, '--out-hold', h2]);
  assert.equal(a.status, 0, `first split failed: ${a.stderr || a.stdout}`);
  assert.equal(b.status, 0, `second split failed: ${b.stderr || b.stdout}`);
  const train1 = fs.readFileSync(t1, 'utf8');
  const train2 = fs.readFileSync(t2, 'utf8');
  const hold1 = fs.readFileSync(h1, 'utf8');
  const hold2 = fs.readFileSync(h2, 'utf8');
  assert.equal(train1, train2, 'train files differ between runs');
  assert.equal(hold1, hold2, 'holdout files differ between runs');
});

test('W888-N rejected: hallucinated verb in canonical response is logged to rejected.jsonl', () => {
  // We can't easily inject a hallucinated response into the dry-run pipeline
  // (the mock teacher response by construction never includes a `kolm <verb>`
  // backtick). Instead, exercise the same internal helpers the pipeline uses
  // to confirm the rejection path works end-to-end on synthetic input.
  const dir = tmpDir('rejected');
  const seedsPath = path.join(dir, 'seeds.jsonl');
  const outRej = path.join(dir, 'rejected.jsonl');
  // Build a minimal seed that the dry-run pipeline will accept.
  const synSeed = {
    id: 'syn_reject_001', bucket: 'docs',
    intent: 'How do I do the rejected thing?',
    sources: ['docs/synthetic'],
    must_include: ['Use the command `kolm not-a-real-verb-w888n` to do it.'],
    must_not_include: [],
  };
  fs.writeFileSync(seedsPath, JSON.stringify(synSeed) + '\n');
  // The mock response will include the must_include[0] line — which contains
  // a backticked bad verb — so the rejection path will trigger.
  const r = runGen([
    '--dry-run', '--limit', '1',
    '--seeds', seedsPath,
    '--out', path.join(dir, 'pairs.jsonl'),
    '--passport', path.join(dir, 'passport.json'),
    '--disagreements', path.join(dir, 'disagreements.jsonl'),
    '--rejected', outRej,
  ]);
  assert.equal(r.status, 0, `generator exited ${r.status}: ${r.stderr || r.stdout}`);
  assert.ok(fs.existsSync(outRej), `rejected.jsonl was not created: ${outRej}`);
  const rejRows = readJsonl(outRej);
  assert.ok(rejRows.length >= 1, `expected at least 1 rejected row, got ${rejRows.length}`);
  const row = rejRows[0];
  assert.equal(row.seed_id, 'syn_reject_001', `wrong seed_id: ${row.seed_id}`);
  assert.equal(row.reason, 'invalid_verb', `wrong reason: ${row.reason}`);
  assert.equal(row.invalid, 'not-a-real-verb-w888n', `wrong invalid: ${row.invalid}`);
});

test('W888-N budget: --budget 0.001 --limit 50 in dry-run aborts before processing all 50 seeds', () => {
  const dir = tmpDir('budget');
  const out = path.join(dir, 'pairs.jsonl');
  const passport = path.join(dir, 'passport.json');
  // Drive a synthetic $0.001 per teacher dispatch so the budget gate triggers
  // without burning real API credits. The budget caps at $0.001 so the very
  // first teacher dispatch on the first seed already crosses the cap.
  const r = runGen([
    '--dry-run', '--budget', '0.001', '--limit', '50',
    '--mock-cost-per-call', '0.001',
    '--out', out,
    '--passport', passport,
    '--disagreements', path.join(dir, 'disagreements.jsonl'),
    '--rejected', path.join(dir, 'rejected.jsonl'),
  ]);
  // The generator should still exit 0 — a budget abort is a clean stop, not a crash.
  assert.equal(r.status, 0, `generator exited ${r.status}: ${r.stderr || r.stdout}`);
  assert.ok(fs.existsSync(passport), `passport missing: ${passport}`);
  const p = JSON.parse(fs.readFileSync(passport, 'utf8'));
  assert.equal(p.budget_aborted, true, 'passport.budget_aborted must be true');
  // Per-call dry-run cost = $0.001, budget = $0.001 — so the first teacher
  // call already crosses the cap. seeds_processed should be 0 (the loop
  // checks budget BEFORE processing each seed) or 1 at most.
  assert.ok(p.counts.seeds_processed < 50, `expected <50 processed, got ${p.counts.seeds_processed}`);
  assert.ok(p.cost_usd >= 0.001, `expected cost >= budget, got $${p.cost_usd}`);
});
