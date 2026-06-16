// tests/wave-gkd-onpolicy-executor.test.js
//
// Proves the GKD on-policy lambda-mixture executor atom inside
// workers/distill/scripts/train_gkd.py: the hand-rolled loop is now the
// canonical on-policy GKD executor with real student rollouts in the JSD loop,
// an endpoint-correct generalized_jsd_loss pinned to trl on BOTH paths, a
// fail-loud trl-drop guard, and a receipt recording the REALIZED (not just
// scheduled) on-policy fraction.
//
// GPU-free: every python-touching case is skipped when python/torch is absent.
// The JS layer asserts dispatch + receipt shape. The full loss/beta/seed pins
// live in workers/distill/scripts/test_gkd_onpolicy.py (run here via its
// __main__ runner).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = process.env.KOLM_PYTHON || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const SCRIPT = path.join(repoRoot, 'workers/distill/scripts/train_gkd.py');
const PYTEST = path.join(repoRoot, 'workers/distill/scripts/test_gkd_onpolicy.py');

function pythonAvailable() {
  try { return spawnSync(PY, ['--version'], { stdio: 'pipe', timeout: 20000 }).status === 0; }
  catch { return false; }
}
function torchAvailable() {
  try { return spawnSync(PY, ['-c', 'import torch'], { stdio: 'pipe', timeout: 60000 }).status === 0; }
  catch { return false; }
}
const HAVE_PY = pythonAvailable();
const HAVE_TORCH = HAVE_PY && torchAvailable();

function tmp(prefix) {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}
function lastJson(stdout) {
  const lines = (stdout || '').toString().trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch { /* keep scanning up */ }
  }
  return null;
}
function runSelfTest({ lmbda, warmup = 0.0, steps = 8, seed = 7 }) {
  const out = tmp('gkd-onpolicy-st');
  const r = spawnSync(PY, [SCRIPT, '--self-test', '--prompts', 'x', '--student', 'x',
    '--out', out, '--lmbda', String(lmbda), '--warmup-frac', String(warmup),
    '--total-steps', String(steps), '--seed', String(seed)],
    { stdio: 'pipe', timeout: 300000 });
  return { r, out, payload: lastJson(r.stdout), metaPath: path.join(out, 'run-meta.json') };
}

// ---------------------------------------------------------------------------
// BETA-PIN-* / JSD-NONNEG / TRL-EQUIV / continuity: run the python suite.
// ---------------------------------------------------------------------------
test('PY-SUITE: test_gkd_onpolicy.py passes (beta pins, trl-equiv, mixture)', { skip: !HAVE_TORCH }, () => {
  const r = spawnSync(PY, [PYTEST], { stdio: 'pipe', timeout: 300000 });
  const out = (r.stdout || '').toString();
  assert.equal(r.status, 0, out + '\n' + (r.stderr || '').toString());
  assert.match(out, /all \d+ tests passed/);
  assert.match(out, /PASS test_beta0_forward_kl/);
  assert.match(out, /PASS test_beta1_reverse_kl/);
  assert.match(out, /PASS test_beta_half_symmetric/);
  assert.match(out, /PASS test_endpoint_continuity/);
  assert.match(out, /PASS test_nonneg_zero_finite/);
  assert.match(out, /PASS test_trl_equiv/);
});

// ---------------------------------------------------------------------------
// ROLLOUT-REALIZED: lmbda=1.0 -> overall>0; on-policy steps cover the STUDENT-
// generated tokens (labels != -100 count == rollout length, prompt all -100).
// ---------------------------------------------------------------------------
test('ROLLOUT-REALIZED: on-policy fraction > 0 and labels cover the rollout span', { skip: !HAVE_TORCH }, () => {
  const { r, payload, metaPath } = runSelfTest({ lmbda: 1.0, warmup: 0.0, steps: 8, seed: 7 });
  assert.equal(r.status, 0, (r.stderr || '').toString());
  assert.ok(payload, 'self-test must print a JSON payload');
  assert.ok(payload.on_policy_step_count > 0, 'must run at least one on-policy step');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  assert.ok(meta.realized_on_policy_fraction.overall > 0.0, 'realized on-policy overall must be > 0');
  assert.equal(meta.train_path, 'handrolled_on_policy');
  assert.ok(payload.label_audit.length > 0, 'must record a label audit for on-policy steps');
  for (const rec of payload.label_audit) {
    assert.equal(rec.loss_positions, rec.rollout_len, 'loss positions must equal rollout length');
    assert.equal(rec.prompt_all_masked, true, 'prompt tokens must be masked to -100');
  }
});

// ---------------------------------------------------------------------------
// OFFPOLICY-REALIZED: lmbda=0.0 -> overall==0 and on_policy_step_count==0.
// ---------------------------------------------------------------------------
test('OFFPOLICY-REALIZED: lmbda=0 realizes zero on-policy steps (off-policy path preserved)', { skip: !HAVE_TORCH }, () => {
  const { r, payload, metaPath } = runSelfTest({ lmbda: 0.0, warmup: 0.0, steps: 8, seed: 7 });
  assert.equal(r.status, 0, (r.stderr || '').toString());
  assert.equal(payload.on_policy_step_count, 0, 'off-policy path must run zero rollouts');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  assert.equal(meta.realized_on_policy_fraction.overall, 0.0, 'lmbda=0 must realize 0 on-policy');
});

// ---------------------------------------------------------------------------
// RECEIPT-NO-LMBDA-CURVE: realized_on_policy_fraction replaces lmbda_curve.
// ---------------------------------------------------------------------------
test('RECEIPT-NO-LMBDA-CURVE: realized fraction replaces the scheduled lmbda_curve', { skip: !HAVE_TORCH }, () => {
  const { r, metaPath } = runSelfTest({ lmbda: 1.0, warmup: 0.0, steps: 6, seed: 42 });
  assert.equal(r.status, 0, (r.stderr || '').toString());
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  assert.ok(!('lmbda_curve' in meta), 'old misleading lmbda_curve must be gone');
  const rof = meta.realized_on_policy_fraction;
  assert.ok(rof && Array.isArray(rof.per_step), 'realized_on_policy_fraction.per_step required');
  assert.ok(typeof rof.overall === 'number', 'realized_on_policy_fraction.overall required');
  assert.ok(rof.scheduled_lmbda_at && 'end' in rof.scheduled_lmbda_at && '0' in rof.scheduled_lmbda_at,
    'scheduled_lmbda_at {0,mid,end} required');
  assert.equal(meta.seed, 42, 'seed must be recorded');
  assert.ok('warmup_frac' in meta && 'max_new_tokens' in meta, 'warmup_frac/max_new_tokens recorded');
  assert.ok('on_policy_step_count' in meta && 'off_policy_step_count' in meta, 'step counts recorded');
  // legacy receipt fields preserved.
  assert.equal(meta.objective, 'gkd');
  assert.ok('beta' in meta && 'lmbda' in meta && 'temperature' in meta && Array.isArray(meta.papers));
  assert.ok(Array.isArray(meta.loss_trajectory));
});

// ---------------------------------------------------------------------------
// SEED-DETERMINISM: same --seed -> identical realized per_step.
// ---------------------------------------------------------------------------
test('SEED-DETERMINISM: identical seed reproduces per_step', { skip: !HAVE_TORCH }, () => {
  const a = runSelfTest({ lmbda: 1.0, warmup: 0.0, steps: 10, seed: 123 });
  const b = runSelfTest({ lmbda: 1.0, warmup: 0.0, steps: 10, seed: 123 });
  assert.equal(a.r.status, 0, (a.r.stderr || '').toString());
  assert.deepEqual(a.payload.per_step, b.payload.per_step, 'same seed must reproduce per_step');
});

// ---------------------------------------------------------------------------
// TRL-DROP-FATAL: a GKDConfig stub WITHOUT lmbda -> exit 8, stderr mentions
// lmbda + the upgrade/KOLM_GKD_HANDROLLED hint; NEVER writes an on-policy meta.
// ---------------------------------------------------------------------------
test('TRL-DROP-FATAL: dropped lmbda exits 8 with an upgrade/KOLM_GKD_HANDROLLED hint', { skip: !HAVE_PY }, () => {
  const stubDir = tmp('gkd-badcfg');
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'badgkd.py'),
    'class GKDConfig:\n    def __init__(self, beta=0.5, temperature=1.0): pass\n', 'utf8');
  const out = tmp('gkd-fatal-out');
  const r = spawnSync(PY, [SCRIPT, '--prompts', 'x', '--student', 's', '--out', out,
    '--check-trl-lmbda', '--lmbda', '0.5'],
    { stdio: 'pipe', timeout: 120000,
      env: { ...process.env, PYTHONPATH: stubDir, KOLM_GKD_GKDCONFIG: 'badgkd:GKDConfig' } });
  assert.equal(r.status, 8, 'dropped lmbda must exit 8');
  const err = (r.stderr || '').toString();
  assert.match(err, /lmbda/, 'stderr must mention lmbda');
  assert.match(err, /KOLM_GKD_HANDROLLED|trl>=0\.12\.0/, 'stderr must give an upgrade/handrolled hint');
  assert.ok(!fs.existsSync(path.join(out, 'run-meta.json')), 'no run-meta on a dropped-lmbda fatal');
});

test('TRL-DROP-FATAL: real trl GKDConfig accepts lmbda (guard passes)', { skip: !HAVE_TORCH }, () => {
  const haveTrl = spawnSync(PY, ['-c', 'import trl;assert hasattr(trl,"GKDConfig")'],
    { stdio: 'pipe', timeout: 60000 }).status === 0;
  if (!haveTrl) return; // no trl -> the fatal-stub case still locks the guard
  const out = tmp('gkd-guard-ok');
  const r = spawnSync(PY, [SCRIPT, '--prompts', 'x', '--student', 's', '--out', out,
    '--check-trl-lmbda', '--lmbda', '0.5'], { stdio: 'pipe', timeout: 120000 });
  assert.equal(r.status, 0, (r.stderr || '').toString());
  assert.match((r.stdout || '').toString(), /"trl_lmbda_accepted": 0\.5/);
});

// ---------------------------------------------------------------------------
// PREFLIGHT-INTACT + DEFAULTS.
// ---------------------------------------------------------------------------
test('PREFLIGHT-INTACT: --preflight-only exits 0 with objective gkd', { skip: !HAVE_PY }, () => {
  const out = tmp('gkd-pf');
  const r = spawnSync(PY, [SCRIPT, '--prompts', 'x', '--student', '/s', '--teacher', '/t',
    '--out', out, '--beta', '0.5', '--lmbda', '0.5', '--preflight-only'],
    { stdio: 'pipe', timeout: 60000 });
  assert.equal(r.status, 0, (r.stderr || '').toString());
  assert.match((r.stdout || '').toString(), /"objective": "gkd"/);
});

test('DEFAULTS: --seed=42, --warmup-frac=0.1, --max-new-tokens=256', { skip: !HAVE_TORCH }, () => {
  const out = tmp('gkd-defaults');
  const r = spawnSync(PY, [SCRIPT, '--self-test', '--prompts', 'x', '--student', 'x',
    '--out', out, '--total-steps', '4'], { stdio: 'pipe', timeout: 200000 });
  assert.equal(r.status, 0, (r.stderr || '').toString());
  const meta = JSON.parse(fs.readFileSync(path.join(out, 'run-meta.json'), 'utf8'));
  assert.equal(meta.seed, 42, 'default seed must be 42');
  assert.equal(meta.warmup_frac, 0.1, 'default warmup-frac must be 0.1');
  assert.equal(meta.max_new_tokens, 256, 'default max-new-tokens must be 256');
});

// ---------------------------------------------------------------------------
// GPU-FREE dispatch shape: the executor symbols exist + script parses.
// ---------------------------------------------------------------------------
test('GPU-FREE: train_gkd.py parses and exposes the executor symbols', { skip: !HAVE_PY }, () => {
  const probe = [
    'import ast,sys',
    `src=open(r'${SCRIPT}',encoding='utf-8').read()`,
    'tree=ast.parse(src)',
    'names={n.name for n in ast.walk(tree) if isinstance(n,ast.FunctionDef)}',
    "need={'generalized_jsd_loss','lmbda_schedule','generate_on_policy_outputs','train_gkd_handrolled','_filter_config_kwargs','_build_gkd_batches','_build_run_meta'}",
    'missing=need-names',
    "sys.stdout.write('OK' if not missing else 'MISSING:'+','.join(sorted(missing)))",
  ].join('\n');
  const r = spawnSync(PY, ['-c', probe], { stdio: 'pipe', timeout: 30000 });
  assert.equal(r.status, 0, (r.stderr || '').toString());
  assert.match((r.stdout || '').toString(), /OK/, (r.stdout || '').toString());
});
