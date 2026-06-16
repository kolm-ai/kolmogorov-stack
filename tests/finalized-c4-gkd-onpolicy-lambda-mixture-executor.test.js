// tests/finalized-c4-gkd-onpolicy-lambda-mixture-executor.test.js
//
// Proves the GKD on-policy lambda-mixture EXECUTOR
// (workers/distill/scripts/gkd_onpolicy_executor.py) is a REAL on-policy
// executor, not a scheduled-scalar stub:
//
//   1. Source-level guarantees that survive without a GPU/torch: a Bernoulli
//      per-example lambda decision, generate_on_policy_outputs() wiring in the
//      JSD loop, generalized JSD against the student's ACTUAL distribution, a
//      warmup->ramp data-mixture controller, the REALIZED on-policy fraction in
//      run-meta (not just the scheduled value), and the FAIL-LOUD trl-path
//      assertion that GKDConfig.lmbda was accepted.
//   2. The deterministic --self-test passes (full executor SHAPE on CPU).
//   3. The --dry-run emits run-meta carrying the per-step REALIZED on-policy
//      fraction and a ramped schedule (teacher-data first, student-data later).
//   4. Targeted python harnesses prove: Bernoulli determinism, realized fraction
//      tracks the scheduled rate, the trl-path assertion RAISES on a dropped
//      lmbda, and the generalized JSD is reverse-KL-weighted as beta->0.
//
// Skips the python-driven cases when python is absent; the static source
// assertions always run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = process.env.KOLM_PYTHON || process.env.PYTHON
  || (process.platform === 'win32' ? 'python' : 'python3');
const SCRIPT = path.join(repoRoot, 'workers', 'distill', 'scripts', 'gkd_onpolicy_executor.py');

function pythonAvailable() {
  try { return spawnSync(PY, ['--version'], { stdio: 'pipe', timeout: 20000 }).status === 0; }
  catch { return false; }
}
const HAVE_PY = pythonAvailable();

function runPy(code, opts = {}) {
  return spawnSync(PY, ['-c', code], { stdio: 'pipe', timeout: 60000, ...opts });
}

const SRC = fs.readFileSync(SCRIPT, 'utf8');

// --- 1. Static source guarantees (no GPU / no python needed) ----------------

test('executor script exists', () => {
  assert.ok(fs.existsSync(SCRIPT), 'gkd_onpolicy_executor.py must exist');
});

test('per-example Bernoulli lambda decision is wired (not a scheduled scalar)', () => {
  assert.match(SRC, /def bernoulli_mixture_decisions\(/);
  // The decision is a per-example draw against the SCHEDULED rate.
  assert.match(SRC, /u\s*<\s*r/);
  assert.match(SRC, /deterministic_uniform\(/);
});

test('generate_on_policy_outputs() is invoked in the JSD loop for on-policy examples', () => {
  // The executor calls an injected GENERATE fn ONLY on the on-policy branch...
  assert.match(SRC, /self\._generate\(prompt, step, idx\)/);
  assert.match(SRC, /if on:/);
  // ...and a REAL binder wires that injected fn to
  // train_gkd.generate_on_policy_outputs (the shipped GKD rollout generator),
  // so the receipt's on-policy claim is load-bearing, not a comment.
  assert.match(SRC, /def bind_generate_on_policy_outputs\(/);
  assert.match(SRC, /train_gkd\.generate_on_policy_outputs/);
});

test('generalized JSD is scored against the student ACTUAL distribution on its own tokens', () => {
  assert.match(SRC, /def generalized_jsd_loss_np\(/);
  // student logits over the SAME tokens it generated:
  assert.match(SRC, /self\._student_logits\(prompt, tokens\)/);
  assert.match(SRC, /self\._teacher_logits\(prompt, tokens\)/);
  // reverse-KL-dominant weighting as beta->0:
  assert.match(SRC, /def student_direction_weight\(/);
});

test('warmup->ramp lambda is a real data-mixture controller (teacher-data first)', () => {
  assert.match(SRC, /def lmbda_schedule\(/);
  assert.match(SRC, /warmup_frac/);
  // off-policy branch uses the fixed TEACHER-data target:
  assert.match(SRC, /teacher_data_fn|_teacher_data\(/);
});

test('REALIZED on-policy fraction (not just scheduled) is recorded per step in run-meta', () => {
  assert.match(SRC, /def realized_on_policy_fraction\(/);
  assert.match(SRC, /realized_on_policy_schedule/);
  assert.match(SRC, /realized_on_policy_fraction/);
  // and the scheduled value is kept distinctly, so a receipt can compare them:
  assert.match(SRC, /scheduled_lmbda/);
});

test('FAIL-LOUD trl-path assertion that GKDConfig.lmbda was accepted', () => {
  assert.match(SRC, /def assert_trl_lmbda_accepted\(/);
  assert.match(SRC, /class TrlLmbdaNotAccepted\(RuntimeError\)/);
  // It RAISES (not warns) and carries an install hint.
  assert.match(SRC, /raise TrlLmbdaNotAccepted/);
  assert.match(SRC, /trl>=0\.12\.0/);
});

// --- 2. Deterministic self-test (full executor on CPU, no torch) ------------

test('python --self-test passes (GPU-free executor shape)', { skip: !HAVE_PY }, () => {
  const r = spawnSync(PY, [SCRIPT, '--self-test'], { stdio: 'pipe', timeout: 60000 });
  assert.equal(r.status, 0, (r.stderr || '').toString());
  const out = (r.stdout || '').toString();
  assert.match(out, /"self_test": "passed"/);
  const j = JSON.parse(out.trim().split('\n').pop());
  assert.equal(j.ok, true);
  assert.ok(j.mean_realized_on_policy_fraction > 0, 'self-test must train on-policy somewhere');
});

// --- 3. --dry-run run-meta carries realized per-step fraction ---------------

test('--dry-run run-meta carries REALIZED per-step fraction and ramps up', { skip: !HAVE_PY }, () => {
  const out = path.join(os.tmpdir(), 'kolm-gkdx-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7));
  const r = spawnSync(PY, [SCRIPT, '--dry-run', '--out', out, '--total-steps', '60',
    '--batch-size', '32', '--beta', '0.3', '--lmbda', '1.0', '--warmup-frac', '0.1'],
    { stdio: 'pipe', timeout: 60000 });
  assert.equal(r.status, 0, (r.stderr || '').toString());

  const metaPath = path.join(out, 'run-meta.json');
  assert.ok(fs.existsSync(metaPath), 'run-meta.json must be written');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

  assert.equal(meta.objective, 'gkd');
  assert.equal(meta.regime, 'on_policy_lambda_mixture');
  assert.ok(Array.isArray(meta.realized_on_policy_schedule), 'realized schedule present');
  assert.equal(meta.realized_on_policy_schedule.length, 60);

  const first = meta.realized_on_policy_schedule[0];
  const last = meta.realized_on_policy_schedule[meta.realized_on_policy_schedule.length - 1];
  // teacher-data first: warmup step is 0% on-policy.
  assert.equal(first.realized_on_policy_fraction, 0,
    'warmup step must be 0% on-policy (teacher-data first)');
  // student-data later: realized fraction rises by the end.
  assert.ok(last.realized_on_policy_fraction > first.realized_on_policy_fraction,
    'realized on-policy fraction must rise over training');
  // realized is a measured outcome, distinct from the scheduled rate field.
  for (const s of meta.realized_on_policy_schedule) {
    assert.ok(Object.prototype.hasOwnProperty.call(s, 'scheduled_lmbda'));
    assert.ok(Object.prototype.hasOwnProperty.call(s, 'realized_on_policy_fraction'));
  }
  // reverse-KL-dominant weighting recorded for the receipt.
  assert.ok(Math.abs(meta.student_direction_weight - 0.7) < 1e-9,
    'student-direction weight must equal (1-beta)');
});

// --- 4. Targeted python harnesses -------------------------------------------

test('Bernoulli mixture is deterministic and tracks the scheduled rate', { skip: !HAVE_PY }, () => {
  const code = [
    'import sys; sys.path.insert(0, r"' + path.join(repoRoot, 'workers', 'distill', 'scripts').replace(/\\/g, '\\\\') + '")',
    'import gkd_onpolicy_executor as e',
    'a=e.bernoulli_mixture_decisions(3,200,0.5,seed=42)',
    'b=e.bernoulli_mixture_decisions(3,200,0.5,seed=42)',
    'assert a==b, "decisions must be deterministic"',
    'lo=e.realized_on_policy_fraction(e.bernoulli_mixture_decisions(3,500,0.2,seed=1))',
    'hi=e.realized_on_policy_fraction(e.bernoulli_mixture_decisions(3,500,0.8,seed=1))',
    'assert lo<hi, "realized fraction must track the scheduled rate"',
    'assert e.realized_on_policy_fraction(e.bernoulli_mixture_decisions(0,64,0.0,seed=1))==0.0',
    'assert e.realized_on_policy_fraction(e.bernoulli_mixture_decisions(0,64,1.0,seed=1))==1.0',
    'print("MIXTURE_OK")',
  ].join('\n');
  const r = runPy(code);
  assert.equal(r.status, 0, (r.stderr || '').toString());
  assert.match((r.stdout || '').toString(), /MIXTURE_OK/);
});

test('assert_trl_lmbda_accepted RAISES loud on a dropped lmbda', { skip: !HAVE_PY }, () => {
  const code = [
    'import sys; sys.path.insert(0, r"' + path.join(repoRoot, 'workers', 'distill', 'scripts').replace(/\\/g, '\\\\') + '")',
    'import gkd_onpolicy_executor as e',
    'class Cfg:',
    '    def __init__(self,l): self.lmbda=l',
    'assert e.assert_trl_lmbda_accepted(Cfg(0.5),0.5)==0.5',
    'raised=False',
    'try:',
    '    e.assert_trl_lmbda_accepted(Cfg(0.0),0.5)',
    'except e.TrlLmbdaNotAccepted:',
    '    raised=True',
    'assert raised, "must RAISE when lmbda is silently dropped"',
    'class NoL:',
    '    beta=0.5',
    'raised2=False',
    'try:',
    '    e.assert_trl_lmbda_accepted(NoL(),0.5)',
    'except e.TrlLmbdaNotAccepted:',
    '    raised2=True',
    'assert raised2, "must RAISE when GKDConfig has no lmbda attribute"',
    'print("TRL_GUARD_OK")',
  ].join('\n');
  const r = runPy(code);
  assert.equal(r.status, 0, (r.stderr || '').toString());
  assert.match((r.stdout || '').toString(), /TRL_GUARD_OK/);
});

test('generalized JSD is reverse-KL-weighted as beta->0 and forward as beta->1', { skip: !HAVE_PY }, () => {
  const code = [
    'import sys; sys.path.insert(0, r"' + path.join(repoRoot, 'workers', 'distill', 'scripts').replace(/\\/g, '\\\\') + '")',
    'import gkd_onpolicy_executor as e',
    'assert e.student_direction_weight(1e-3) > 0.99',
    'assert e.student_direction_weight(1-1e-3) < 0.01',
    '# swap-symmetry JSD_beta(P||Q)=JSD_{1-beta}(Q||P)',
    'a=e.generalized_jsd_token([3.0,0.0],[0.0,3.0],beta=0.3)',
    'b=e.generalized_jsd_token([0.0,3.0],[3.0,0.0],beta=0.7)',
    'assert abs(a-b)<1e-9',
    '# masking: label -100 tokens excluded',
    's=[[2.0,0.0,0.0]]; t=[[0.0,2.0,0.0]]',
    'base=e.generalized_jsd_loss_np(s,t,beta=0.5)',
    'masked=e.generalized_jsd_loss_np(s+s,t+t,labels=[-100,0],beta=0.5)',
    'assert abs(base-masked)<1e-9',
    'print("JSD_OK")',
  ].join('\n');
  const r = runPy(code);
  assert.equal(r.status, 0, (r.stderr || '').toString());
  assert.match((r.stdout || '').toString(), /JSD_OK/);
});

test('executor records one StepRecord per step with realized fraction rising', { skip: !HAVE_PY }, () => {
  const code = [
    'import sys; sys.path.insert(0, r"' + path.join(repoRoot, 'workers', 'distill', 'scripts').replace(/\\/g, '\\\\') + '")',
    'import gkd_onpolicy_executor as e',
    'g,sl,tl,td=e._make_offline_loop()',
    'cfg=e.GkdExecutorConfig(total_steps=50,batch_size=24,beta=0.3,lmbda_start=0.0,lmbda_end=1.0,warmup_frac=0.1,seed=42)',
    'ex=e.GkdOnPolicyExecutor(cfg,generate_fn=g,student_logits_fn=sl,teacher_logits_fn=tl,teacher_data_fn=td)',
    'ex.run(["p%d"%i for i in range(cfg.batch_size)])',
    'assert len(ex.records)==50',
    'assert ex.records[0].realized_on_policy_fraction==0.0',
    'assert ex.records[-1].realized_on_policy_fraction>ex.records[0].realized_on_policy_fraction',
    'assert all(r.loss>=0.0 for r in ex.records)',
    '# on_policy_count+off_policy_count == batch each step',
    'assert all(r.on_policy_count+r.off_policy_count==24 for r in ex.records)',
    'meta=e.build_run_meta(cfg,ex.records,trl_lmbda_accepted=0.5)',
    'assert meta["trl_lmbda_accepted"]==0.5',
    'assert len(meta["realized_on_policy_schedule"])==50',
    'print("EXEC_OK")',
  ].join('\n');
  const r = runPy(code);
  assert.equal(r.status, 0, (r.stderr || '').toString());
  assert.match((r.stdout || '').toString(), /EXEC_OK/);
});

// ===========================================================================
// 5. CANONICAL train_gkd.py path. The sibling pure-core executor above proves
//    the loop SHAPE GPU-free; this section proves the ATOM the spec names:
//    train_gkd.py's HAND-ROLLED loop is now the canonical on-policy GKD
//    executor with REAL torch student rollouts in the JSD loop, an endpoint-
//    correct generalized_jsd_loss pinned to trl on BOTH paths, a fail-loud
//    trl-drop guard, and a receipt recording the REALIZED (not just scheduled)
//    on-policy fraction. torch-dependent cases skip if torch is absent.
// ===========================================================================

const TRAIN_GKD = path.join(repoRoot, 'workers', 'distill', 'scripts', 'train_gkd.py');
const PYTEST_GKD = path.join(repoRoot, 'workers', 'distill', 'scripts', 'test_gkd_onpolicy.py');

function torchAvailable() {
  try { return spawnSync(PY, ['-c', 'import torch'], { stdio: 'pipe', timeout: 60000 }).status === 0; }
  catch { return false; }
}
const HAVE_TORCH = HAVE_PY && torchAvailable();

function tmpDir(prefix) {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}
function lastJsonLine(stdout) {
  const lines = (stdout || '').toString().trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch { /* keep scanning up */ }
  }
  return null;
}
function gkdSelfTest({ lmbda, warmup = 0.0, steps = 8, seed = 7 }) {
  const out = tmpDir('train-gkd-st');
  const r = spawnSync(PY, [TRAIN_GKD, '--self-test', '--prompts', 'x', '--student', 'x',
    '--out', out, '--lmbda', String(lmbda), '--warmup-frac', String(warmup),
    '--total-steps', String(steps), '--seed', String(seed)],
    { stdio: 'pipe', timeout: 300000 });
  return { r, out, payload: lastJsonLine(r.stdout), metaPath: path.join(out, 'run-meta.json') };
}

test('train_gkd.py BETA-PINS: test_gkd_onpolicy.py passes (trl-pinned loss)', { skip: !HAVE_TORCH }, () => {
  const r = spawnSync(PY, [PYTEST_GKD], { stdio: 'pipe', timeout: 300000 });
  const out = (r.stdout || '').toString();
  assert.equal(r.status, 0, out + '\n' + (r.stderr || '').toString());
  assert.match(out, /all \d+ tests passed/);
  assert.match(out, /PASS test_beta0_forward_kl/);
  assert.match(out, /PASS test_beta1_reverse_kl/);
  assert.match(out, /PASS test_trl_equiv/);
});

test('train_gkd.py ROLLOUT-REALIZED: on-policy fraction>0 + labels cover rollout', { skip: !HAVE_TORCH }, () => {
  const { r, payload, metaPath } = gkdSelfTest({ lmbda: 1.0, warmup: 0.0, steps: 8, seed: 7 });
  assert.equal(r.status, 0, (r.stderr || '').toString());
  assert.ok(payload.on_policy_step_count > 0, 'must run at least one on-policy step');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  assert.ok(meta.realized_on_policy_fraction.overall > 0.0, 'realized on-policy overall must be > 0');
  assert.equal(meta.train_path, 'handrolled_on_policy');
  for (const rec of payload.label_audit) {
    assert.equal(rec.loss_positions, rec.rollout_len, 'loss positions must equal rollout length');
    assert.equal(rec.prompt_all_masked, true, 'prompt tokens must be -100');
  }
});

test('train_gkd.py OFFPOLICY-REALIZED: lmbda=0 -> zero on-policy steps', { skip: !HAVE_TORCH }, () => {
  const { r, payload, metaPath } = gkdSelfTest({ lmbda: 0.0, warmup: 0.0, steps: 8, seed: 7 });
  assert.equal(r.status, 0, (r.stderr || '').toString());
  assert.equal(payload.on_policy_step_count, 0, 'off-policy path must run zero rollouts');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  assert.equal(meta.realized_on_policy_fraction.overall, 0.0, 'lmbda=0 must realize 0 on-policy');
});

test('train_gkd.py RECEIPT-NO-LMBDA-CURVE: realized fraction replaces lmbda_curve', { skip: !HAVE_TORCH }, () => {
  const { r, metaPath } = gkdSelfTest({ lmbda: 1.0, warmup: 0.0, steps: 6, seed: 42 });
  assert.equal(r.status, 0, (r.stderr || '').toString());
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  assert.ok(!('lmbda_curve' in meta), 'old misleading lmbda_curve must be gone');
  const rof = meta.realized_on_policy_fraction;
  assert.ok(Array.isArray(rof.per_step) && typeof rof.overall === 'number');
  assert.ok(rof.scheduled_lmbda_at && 'end' in rof.scheduled_lmbda_at && '0' in rof.scheduled_lmbda_at);
  assert.equal(meta.seed, 42);
  assert.ok('warmup_frac' in meta && 'max_new_tokens' in meta);
  assert.ok('on_policy_step_count' in meta && 'off_policy_step_count' in meta);
  assert.equal(meta.objective, 'gkd');
  assert.ok('beta' in meta && 'lmbda' in meta && 'temperature' in meta && Array.isArray(meta.papers));
});

test('train_gkd.py SEED-DETERMINISM: identical seed reproduces per_step', { skip: !HAVE_TORCH }, () => {
  const a = gkdSelfTest({ lmbda: 1.0, warmup: 0.0, steps: 10, seed: 123 });
  const b = gkdSelfTest({ lmbda: 1.0, warmup: 0.0, steps: 10, seed: 123 });
  assert.deepEqual(a.payload.per_step, b.payload.per_step, 'same seed must reproduce per_step');
});

test('train_gkd.py TRL-DROP-FATAL: dropped lmbda exits 8 with upgrade/handrolled hint', { skip: !HAVE_PY }, () => {
  const stubDir = tmpDir('train-gkd-badcfg');
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'badgkd.py'),
    'class GKDConfig:\n    def __init__(self, beta=0.5, temperature=1.0): pass\n', 'utf8');
  const out = tmpDir('train-gkd-fatal');
  const r = spawnSync(PY, [TRAIN_GKD, '--prompts', 'x', '--student', 's', '--out', out,
    '--check-trl-lmbda', '--lmbda', '0.5'],
    { stdio: 'pipe', timeout: 120000,
      env: { ...process.env, PYTHONPATH: stubDir, KOLM_GKD_GKDCONFIG: 'badgkd:GKDConfig' } });
  assert.equal(r.status, 8, 'dropped lmbda must exit 8');
  const err = (r.stderr || '').toString();
  assert.match(err, /lmbda/);
  assert.match(err, /KOLM_GKD_HANDROLLED|trl>=0\.12\.0/);
  assert.ok(!fs.existsSync(path.join(out, 'run-meta.json')), 'no run-meta on a dropped-lmbda fatal');
});

test('train_gkd.py PREFLIGHT-INTACT + DEFAULTS', { skip: !HAVE_PY }, () => {
  const out = tmpDir('train-gkd-pf');
  const r = spawnSync(PY, [TRAIN_GKD, '--prompts', 'x', '--student', '/s', '--teacher', '/t',
    '--out', out, '--beta', '0.5', '--lmbda', '0.5', '--preflight-only'],
    { stdio: 'pipe', timeout: 60000 });
  assert.equal(r.status, 0, (r.stderr || '').toString());
  assert.match((r.stdout || '').toString(), /"objective": "gkd"/);
  if (HAVE_TORCH) {
    const stOut = tmpDir('train-gkd-defaults');
    const s = spawnSync(PY, [TRAIN_GKD, '--self-test', '--prompts', 'x', '--student', 'x',
      '--out', stOut, '--total-steps', '4'], { stdio: 'pipe', timeout: 200000 });
    assert.equal(s.status, 0, (s.stderr || '').toString());
    const meta = JSON.parse(fs.readFileSync(path.join(stOut, 'run-meta.json'), 'utf8'));
    assert.equal(meta.seed, 42);
    assert.equal(meta.warmup_frac, 0.1);
    assert.equal(meta.max_new_tokens, 256);
  }
});
