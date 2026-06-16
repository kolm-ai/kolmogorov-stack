// FINALIZED-C4 — Rejection-sampling / best-of-N distillation trainer tests.
//
// Proves the atom: for each prompt, sample N candidates, score every candidate
// with the SAME reward path the GRPO/RLVR trainer uses (grpo.py
// REWARD_FUNCTIONS + kolm_verifier) - NOT the K-score ship gate's accuracy axis
// (_judge_local), which is a different function - keep the best (or above-
// threshold) candidate, fine-tune on the accepted set only, and surface accept-
// rate, mean candidate score, N + threshold into run-meta. The selection half is
// GPU-free and tested here; the SFT half is the durable-envelope + trainer-
// resolution path; and a parity test confirms the Python select_accepted picks
// the SAME candidate as the JS path (the one-scoring-path guarantee, JS<->Python).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  REWARD_FAMILIES, SELECTION_MODES,
  extractAnswer, rewardMathChecker, rewardKolmVerifier, scoreCandidate,
  selectAcceptedSet, buildCandidatesJsonl, resolveTrainer, doctor,
  trainRejectionSampling,
} from '../src/distill-rejection-sampling.js';
import { REWARD_FAMILIES as GRPO_FAMILIES } from '../src/distill-grpo.js';

const _here = path.dirname(fileURLToPath(import.meta.url));
const _repoRoot = path.resolve(_here, '..');
const tmp = (n) => path.join(os.tmpdir(), `kolm-rs-${n}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);

function pythonBin() {
  const cands = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  for (const c of cands) {
    try {
      const r = spawnSync(c, ['--version'], { stdio: 'pipe' });
      if (r.status === 0) return c;
    } catch { /* next */ }
  }
  return null;
}

// --------------------------------------------------------------------------

test('reward families are the SAME set the GRPO / K-score path uses', () => {
  // The whole moat: train-eval scoring is ONE path. The rejection-sampling
  // families MUST equal the GRPO families so a candidate accepted here would
  // get the same number at the release gate.
  assert.deepEqual([...REWARD_FAMILIES].sort(), [...GRPO_FAMILIES].sort());
  assert.ok(REWARD_FAMILIES.includes('kolm_verifier'));
  assert.ok(REWARD_FAMILIES.includes('code_exec'));
  assert.deepEqual([...SELECTION_MODES], ['best', 'threshold']);
});

test('extractAnswer + math/kolm scorers mirror the grpo.py contract', () => {
  assert.equal(extractAnswer('<answer>42</answer>'), '42');
  assert.equal(extractAnswer('the final answer is\nAnswer: 7.'), '7');
  assert.equal(extractAnswer('\\boxed{13}'), '13');
  // math_checker: numeric-equivalent after normalize ($ , %)
  assert.equal(rewardMathChecker('Answer: 1,000', '1000'), 1.0);
  assert.equal(rewardMathChecker('Answer: 5', '6'), 0.0);
  assert.equal(rewardMathChecker('no answer here', '6'), 0.0);
  // kolm_verifier: refusal + <think> leakage penalties, overlap bonus, [0,1]
  const refuse = rewardKolmVerifier('I cannot help with that', 'help with that');
  assert.ok(refuse >= 0 && refuse <= 1);
  const good = rewardKolmVerifier('paris is the capital of france', 'paris capital france');
  const bad = rewardKolmVerifier('totally unrelated text', 'paris capital france');
  assert.ok(good > bad, 'overlap with reference should score higher');
});

test('selectAcceptedSet best-of-N keeps the argmax candidate per prompt', () => {
  const groups = [
    {
      id: 'p1', prompt: 'capital of france?',
      row: { reference: 'paris france capital' },
      candidates: [
        'i do not know',                 // low overlap
        'paris is the capital of france', // high overlap -> best
        'london',                         // low
      ],
    },
  ];
  const r = selectAcceptedSet(groups, { family: 'kolm_verifier', threshold: 0.5, selection: 'best' });
  assert.equal(r.ok, true);
  assert.equal(r.accepted.length, 1);
  assert.match(r.accepted[0].completion, /paris is the capital/);
  // stats surfaced for run-meta
  assert.equal(r.stats.prompts, 1);
  assert.equal(r.stats.accepted, 1);
  assert.equal(r.stats.accept_rate, 1);
  assert.equal(r.stats.num_candidates_max, 3);
  assert.equal(r.stats.candidates_total, 3);
  assert.ok(r.stats.mean_candidate_score >= 0 && r.stats.mean_candidate_score <= 1);
  assert.ok(r.stats.mean_accepted_score >= r.stats.mean_candidate_score - 1e-9);
  assert.match(r.stats.ledger_hash, /^sha256:[0-9a-f]{64}$/);
});

test('rejection: a prompt whose best candidate misses threshold contributes ZERO rows', () => {
  const groups = [
    {
      id: 'good', prompt: 'q', row: { reference: 'alpha beta gamma delta' },
      candidates: ['alpha beta gamma delta'],
    },
    {
      id: 'bad', prompt: 'q2', row: { reference: 'alpha beta gamma delta' },
      candidates: ['zzz qqq', 'i cannot answer'], // far from ref + refusal
    },
  ];
  // High threshold so only the perfect-overlap prompt is accepted.
  const r = selectAcceptedSet(groups, { family: 'kolm_verifier', threshold: 0.75, selection: 'best' });
  assert.equal(r.accepted.length, 1);
  assert.equal(r.accepted[0].id, 'good');
  assert.equal(r.stats.accepted, 1);
  assert.equal(r.stats.rejected, 1);
  assert.equal(r.stats.accept_rate, 0.5);
  const decisions = Object.fromEntries(r.ledger.map(l => [l.id, l.decision]));
  assert.equal(decisions.good, 'accept');
  assert.equal(decisions.bad, 'reject');
});

test('threshold selection keeps the FIRST above-floor candidate (RAFT/STaR style)', () => {
  const groups = [{
    id: 'p', prompt: 'q', row: { reference: 'one two three' },
    candidates: [
      'one two three',        // index 0 — clears floor first
      'one two three four',   // index 1 — also clears, slightly different
    ],
  }];
  const r = selectAcceptedSet(groups, { family: 'kolm_verifier', threshold: 0.5, selection: 'threshold' });
  assert.equal(r.accepted.length, 1);
  assert.equal(r.accepted[0].completion, 'one two three');
});

test('selectAcceptedSet validates family / threshold / selection', () => {
  assert.equal(selectAcceptedSet('nope').error, 'groups_not_array');
  assert.equal(selectAcceptedSet([], { family: 'bogus' }).error, 'unknown_reward');
  assert.equal(selectAcceptedSet([], { threshold: 2 }).error, 'bad_threshold');
  assert.equal(selectAcceptedSet([], { selection: 'wat' }).error, 'unknown_selection');
});

test('code_exec candidates defer to Python (un-scoreable in JS) without crashing', () => {
  const groups = [{
    id: 'c', prompt: 'add', row: { tests: ['assert add(1,2)==3'] },
    candidates: ['```python\ndef add(a,b): return a+b\n```'],
  }];
  const r = selectAcceptedSet(groups, { family: 'code_exec', threshold: 0.5, selection: 'best' });
  assert.equal(r.ok, true);
  assert.equal(r.stats.deferred_to_python, 1);
  assert.equal(r.stats.scored_in_js, 0);
  assert.equal(r.ledger[0].decision, 'deferred');
});

test('buildCandidatesJsonl writes prompt + candidates + verifiable column', () => {
  const out = tmp('cand') + '.jsonl';
  const r = buildCandidatesJsonl([
    { id: 'a', prompt: 'q1', row: { reference: 'ref one' }, candidates: ['x', 'y'] },
    { id: 'b', input: 'q2', row: { reference: 'ref two' }, candidates: ['z'] },
  ], { family: 'kolm_verifier' }, out);
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  const lines = fs.readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines[0].candidates, ['x', 'y']);
  assert.equal(lines[0].references, 'ref one');
  assert.equal(lines[1].prompt, 'q2'); // input -> prompt fallback
  fs.rmSync(out, { force: true });
});

test('in-repo Python trainer (train_rejection.py) resolves', () => {
  const prev = process.env.KOLM_REJECTION_TRAINER;
  delete process.env.KOLM_REJECTION_TRAINER;
  try {
    const t = resolveTrainer();
    assert.ok(t, 'in-repo train_rejection.py should resolve');
    assert.equal(t.source, 'in_repo');
    assert.match(t.script, /train_rejection\.py$/);
    assert.ok(fs.existsSync(t.script));
  } finally {
    if (prev !== undefined) process.env.KOLM_REJECTION_TRAINER = prev;
  }
});

test('doctor reports the families + selection modes + install hint', () => {
  const d = doctor();
  assert.equal(d.kind, 'distill_rejection_sampling');
  assert.deepEqual(d.reward_families, [...REWARD_FAMILIES]);
  assert.deepEqual(d.selection_modes, [...SELECTION_MODES]);
  assert.match(d.install_hint, /train_rejection\.py/);
});

test('trainRejectionSampling validates inputs + emits durable no-trainer envelope', () => {
  const candOut = tmp('p') + '.jsonl';
  buildCandidatesJsonl([{ id: 'a', prompt: 'q', row: { reference: 'r' }, candidates: ['c'] }],
    { family: 'kolm_verifier' }, candOut);

  // validation
  assert.equal(trainRejectionSampling({ candidatesPath: '/nope', studentPath: '/s' }).error, 'candidates_missing');
  assert.equal(trainRejectionSampling({ candidatesPath: candOut }).error, 'student_missing');
  assert.equal(trainRejectionSampling({ candidatesPath: candOut, studentPath: '/s', rewardFunction: 'bogus' }).error, 'unknown_reward');
  assert.equal(trainRejectionSampling({ candidatesPath: candOut, studentPath: '/s', selection: 'wat' }).error, 'unknown_selection');
  assert.equal(trainRejectionSampling({ candidatesPath: candOut, studentPath: '/s', threshold: 9 }).error, 'bad_threshold');

  // durable no-trainer path: point override at a nonexistent script
  const prev = process.env.KOLM_REJECTION_TRAINER;
  process.env.KOLM_REJECTION_TRAINER = path.join(os.tmpdir(), 'no-such-rejection.py');
  try {
    const r = trainRejectionSampling({ candidatesPath: candOut, studentPath: '/s', rewardFunction: 'kolm_verifier' });
    assert.equal(r.ok, true);
    assert.equal(r.trainer_kicked, false);
    assert.equal(r.error, 'no_trainer_installed');
    assert.ok(fs.existsSync(r.run_dir));
    assert.match(r.install_hint, /pip install/);
  } finally {
    if (prev === undefined) delete process.env.KOLM_REJECTION_TRAINER; else process.env.KOLM_REJECTION_TRAINER = prev;
    fs.rmSync(candOut, { force: true });
  }
});

// --------------------------------------------------------------------------
// One-path guarantee: the Python select_accepted (which reuses the REAL
// apps.trainer.grpo REWARD_FUNCTIONS) picks the SAME candidate as the JS path.
// This is the load-bearing "train-eval scoring is one path" proof. Skipped
// (not failed) when python3 is unavailable on the runner.
// --------------------------------------------------------------------------
test('Python select_accepted matches the JS selection (one scoring path)', { skip: pythonBin() ? false : 'python not available' }, () => {
  const py = pythonBin();
  const groups = [
    { id: 'p1', prompt: 'capital of france?', references: 'paris france capital',
      candidates: ['i do not know', 'paris is the capital of france', 'london'] },
    { id: 'p2', prompt: 'q2', references: 'alpha beta gamma',
      candidates: ['zzz', 'i cannot answer'] },
  ];

  // JS side: build the same groups shape (row carries reference).
  const jsGroups = groups.map(g => ({
    id: g.id, prompt: g.prompt, row: { reference: g.references }, candidates: g.candidates,
  }));
  const jsR = selectAcceptedSet(jsGroups, { family: 'kolm_verifier', threshold: 0.55, selection: 'best' });

  // Python side: run train_rejection.py --select-only over a candidates JSONL.
  const candPath = tmp('parity') + '.jsonl';
  fs.writeFileSync(candPath, groups.map(g => JSON.stringify(g)).join('\n') + '\n');
  const outDir = tmp('parity-out');
  const script = path.join(_repoRoot, 'workers', 'distill', 'scripts', 'train_rejection.py');
  const res = spawnSync(py, [
    script, '--candidates', candPath, '--student', 'unused-in-select-only',
    '--out', outDir, '--reward', 'kolm_verifier', '--threshold', '0.55',
    '--selection', 'best', '--select-only',
  ], { encoding: 'utf8' });

  assert.equal(res.status, 0, `train_rejection --select-only failed: ${res.stderr || res.stdout}`);
  const meta = JSON.parse(fs.readFileSync(path.join(outDir, 'run-meta.json'), 'utf8'));

  // run-meta surfaces accept_rate, mean_candidate_score, N, threshold, selection
  assert.equal(meta.method, 'rejection_sampling');
  assert.equal(meta.threshold, 0.55);
  assert.equal(meta.selection, 'best');
  assert.ok('num_candidates' in meta);
  assert.ok('accept_rate' in meta);
  assert.ok('mean_candidate_score' in meta);

  // Same accept/reject decision + same ledger hash => one scoring path.
  assert.equal(meta.accepted, jsR.stats.accepted, 'Python + JS must accept the same count');
  assert.equal(meta.accept_rate, jsR.stats.accept_rate);
  assert.equal(meta.ledger_hash, jsR.stats.ledger_hash, 'ledger hashes must match (identical scoring path)');

  // The accepted-pairs file holds the SAME chosen completion as the JS path.
  const acc = fs.readFileSync(path.join(outDir, 'accepted-pairs.jsonl'), 'utf8')
    .trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(acc.length, jsR.accepted.length);
  assert.equal(acc[0].teacher_output, jsR.accepted[0].completion);

  fs.rmSync(candPath, { force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('Python preflight-only resolves reward + config GPU-free', { skip: pythonBin() ? false : 'python not available' }, () => {
  const py = pythonBin();
  const candPath = tmp('pf') + '.jsonl';
  fs.writeFileSync(candPath, JSON.stringify({ id: 'a', prompt: 'q', candidates: ['x'], references: 'r' }) + '\n');
  const outDir = tmp('pf-out');
  const script = path.join(_repoRoot, 'workers', 'distill', 'scripts', 'train_rejection.py');
  const res = spawnSync(py, [
    script, '--candidates', candPath, '--student', 's', '--out', outDir,
    '--reward', 'kolm_verifier', '--num-candidates', '8', '--threshold', '0.5',
    '--selection', 'best', '--preflight-only',
  ], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr || res.stdout);
  const parsed = JSON.parse(res.stdout.trim().split('\n').pop());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.reward, 'kolm_verifier');
  assert.equal(parsed.num_candidates, 8);
  fs.rmSync(candPath, { force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
});
