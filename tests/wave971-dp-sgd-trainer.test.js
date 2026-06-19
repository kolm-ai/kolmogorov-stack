import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DISTILL_PATH = path.join(ROOT, 'apps', 'trainer', 'distill.py');
const DISTILL = fs.readFileSync(DISTILL_PATH, 'utf8');
const PY = process.env.KOLM_PY || (process.platform === 'win32' ? 'python' : 'python3');

function runPy(args, opts = {}) {
  return spawnSync(PY, args, {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: 120_000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    ...opts,
  });
}

function pyAvailable() {
  return runPy(['-c', 'import sys']).status === 0;
}

test('W971 #1 - distill.py carries fail-closed Opacus DP-SGD wiring', () => {
  for (const field of [
    'dp_sgd: bool = False',
    'dp_l2_clip: float = 1.0',
    'dp_noise_multiplier: float = 0.0',
    'dp_delta: float = 1e-5',
    'dp_sample_rate: Optional[float] = None',
    'dp_steps: Optional[int] = None',
  ]) {
    assert.ok(DISTILL.includes(field), `missing DistillConfig field ${field}`);
  }
  assert.match(DISTILL, /from opacus import PrivacyEngine/);
  assert.match(DISTILL, /PrivacyEngine\(accountant="rdp"\)/);
  assert.match(DISTILL, /make_private\(/);
  assert.match(DISTILL, /trainer\._kolm_dp_train_dataloader = private_loader/);
  assert.match(DISTILL, /Refusing to continue without real DP-SGD/);
  assert.match(DISTILL, /run-meta\.dp\.json/);
});

test('W971 #2 - DP budget is stamped into trainer summary and receipt', () => {
  assert.match(DISTILL, /summary\["privacy_budget"\] = dp_budget/);
  assert.match(DISTILL, /block\["privacy_budget"\] = privacy_budget/);
  assert.match(DISTILL, /compute_dp_sgd_budget\(/);
  assert.match(DISTILL, /sample_rate_source/);
  assert.match(DISTILL, /observed_steps/);
  assert.match(DISTILL, /opacus_epsilon/);
});

test('W971 #3 - DP CLI and env knobs are exposed', () => {
  for (const flag of [
    '--dp-sgd',
    '--no-dp-sgd',
    '--dp-l2-clip',
    '--dp-noise-multiplier',
    '--dp-delta',
    '--dp-sample-rate',
    '--dp-steps',
    '--self-test-dp',
  ]) {
    assert.ok(DISTILL.includes(flag), `missing CLI flag ${flag}`);
  }
  for (const env of [
    'KOLM_DP_SGD',
    'KOLM_DP_L2_CLIP',
    'KOLM_DP_NOISE_MULTIPLIER',
    'KOLM_DP_SAMPLE_RATE',
    'KOLM_DP_STEPS',
    'KOLM_DP_DELTA',
  ]) {
    assert.ok(DISTILL.includes(env), `missing env fallback ${env}`);
  }
});

test('W971 #4 - --self-test-dp passes without model downloads', () => {
  if (!pyAvailable()) {
    console.error('[wave971] python unavailable; skipping live DP self-test');
    return;
  }
  const r = runPy([DISTILL_PATH, '--self-test-dp']);
  assert.equal(r.status, 0, `--self-test-dp failed:\n${r.stdout}\n${r.stderr}`);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.ok, true);
  assert.equal(out.dp_training_version, 'finalized-c2-v1');
  assert.equal(out.accountant, 'rdp_moments_v1');
  assert.ok(out.reference_epsilon > 1.0 && out.reference_epsilon < 2.2);
  assert.ok(out.n_checks >= 6);
});

test('W971 #5 - --print-config resolves DP CLI flags and forces grad_accum=1', () => {
  if (!pyAvailable()) {
    console.error('[wave971] python unavailable; skipping print-config check');
    return;
  }
  const r = runPy([
    DISTILL_PATH,
    '--print-config',
    '--dp-sgd',
    '--dp-noise-multiplier', '1.2',
    '--dp-l2-clip', '0.75',
    '--dp-delta', '0.000001',
    '--dp-sample-rate', '0.02',
    '--dp-steps', '123',
  ]);
  assert.equal(r.status, 0, `--print-config failed:\n${r.stdout}\n${r.stderr}`);
  const cfg = JSON.parse(r.stdout);
  assert.equal(cfg.dp_sgd, true);
  assert.equal(cfg.dp_noise_multiplier, 1.2);
  assert.equal(cfg.dp_l2_clip, 0.75);
  assert.equal(cfg.dp_delta, 0.000001);
  assert.equal(cfg.dp_sample_rate, 0.02);
  assert.equal(cfg.dp_steps, 123);
  assert.equal(cfg.grad_accum, 1);
});

test('W971 #6 - KOLM_DP_* env falls through to DistillConfig', () => {
  if (!pyAvailable()) {
    console.error('[wave971] python unavailable; skipping env print-config check');
    return;
  }
  const r = runPy([DISTILL_PATH, '--print-config'], {
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      KOLM_DP_SGD: '1',
      KOLM_DP_NOISE_MULTIPLIER: '1.3',
      KOLM_DP_L2_CLIP: '1.5',
      KOLM_DP_DELTA: '0.00001',
      KOLM_DP_SAMPLE_RATE: '0.03',
      KOLM_DP_STEPS: '456',
    },
  });
  assert.equal(r.status, 0, `env --print-config failed:\n${r.stdout}\n${r.stderr}`);
  const cfg = JSON.parse(r.stdout);
  assert.equal(cfg.dp_sgd, true);
  assert.equal(cfg.dp_noise_multiplier, 1.3);
  assert.equal(cfg.dp_l2_clip, 1.5);
  assert.equal(cfg.dp_delta, 0.00001);
  assert.equal(cfg.dp_sample_rate, 0.03);
  assert.equal(cfg.dp_steps, 456);
  assert.equal(cfg.grad_accum, 1);
});

test('W971 #7 - requested DP with zero noise fails before model loading', () => {
  if (!pyAvailable()) {
    console.error('[wave971] python unavailable; skipping invalid config check');
    return;
  }
  const r = runPy([DISTILL_PATH, '--print-config', '--dp-sgd', '--dp-noise-multiplier', '0']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /dp_noise_multiplier must be > 0/);
});
