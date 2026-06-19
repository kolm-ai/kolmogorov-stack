import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  BOND_TARGET_OBJECTIVE,
  buildBonTargets,
} from '../src/distill-preference.js';
import {
  distillStrategyCatalog,
  planDistillStrategy,
} from '../src/distill-strategy.js';
import { runDistillMethodBakeoff } from '../src/distill-bakeoff.js';

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

test('W973 #1 - distill.py registers a real BOND Jeffreys objective', () => {
  assert.match(DISTILL, /BOND_TRAINING_VERSION = "w973-bond-jeffreys-v1"/);
  assert.match(DISTILL, /BOND_OBJECTIVE = "bond_jeffreys"/);
  assert.match(DISTILL, /BOND_JEFFREYS = BOND_OBJECTIVE/);
  assert.match(DISTILL, /def bond_jeffreys_from_probs/);
  assert.match(DISTILL, /def _bond_jeffreys/);
  assert.match(DISTILL, /KDObjective\.BOND_JEFFREYS: _bond_jeffreys/);
  assert.match(DISTILL, /F\.kl_div\(log_p_s, p_t/);
  assert.match(DISTILL, /F\.kl_div\(log_p_t, p_s/);
  assert.match(DISTILL, /arXiv:2407\.14622/);
});

test('W973 #2 - --self-test-bond passes without torch or model downloads', () => {
  if (!pyAvailable()) {
    console.error('[wave973] python unavailable; skipping live BOND self-test');
    return;
  }
  const r = runPy([DISTILL_PATH, '--self-test-bond']);
  assert.equal(r.status, 0, `--self-test-bond failed:\n${r.stdout}\n${r.stderr}`);
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.ok, true);
  assert.equal(out.bond_training_version, 'w973-bond-jeffreys-v1');
  assert.equal(out.objective, 'bond_jeffreys');
  assert.equal(out.divergence, 'jeffreys');
  assert.ok(out.reference_loss > 0);
  assert.ok(out.checks.some((c) => c.name === 'jeffreys_symmetric' && c.pass));
  assert.ok(out.n_checks >= 6);
});

test('W973 #3 - --print-config accepts bond_jeffreys as a KD objective', () => {
  if (!pyAvailable()) {
    console.error('[wave973] python unavailable; skipping print-config check');
    return;
  }
  const r = runPy([DISTILL_PATH, '--print-config', '--objective', 'bond_jeffreys']);
  assert.equal(r.status, 0, `--print-config failed:\n${r.stdout}\n${r.stderr}`);
  const cfg = JSON.parse(r.stdout);
  assert.equal(cfg.objective, 'bond_jeffreys');
});

test('W973 #4 - BoN target curation stamps the BOND objective hint without breaking SeqKD rows', () => {
  const rows = [{
    prompt: 'How should support process a refund?',
    seed_output: 'refund to original payment method with confirmation',
    candidates: [
      { text: 'no' },
      { text: 'Process the refund to the original payment method and send confirmation.' },
    ],
  }];
  const out = buildBonTargets(rows, { n: 2, min_score: 0.1 });
  assert.equal(out.ok, true);
  assert.equal(BOND_TARGET_OBJECTIVE, 'bond_jeffreys');
  assert.equal(out.stats.distill_objective_hint, 'bond_jeffreys');
  assert.equal(out.targets[0].target_source, 'best_of_n');
  assert.equal(out.targets[0].input, rows[0].prompt);
  assert.equal(out.targets[0].teacher_output, out.targets[0].output);
  assert.equal(out.targets[0].distill_objective_hint, 'bond_jeffreys');
  assert.deepEqual(out.targets[0].bond_distribution_matching, {
    objective: 'bond_jeffreys',
    divergence: 'jeffreys',
    source: 'best_of_n_selected_target',
  });
});

test('W973 #5 - strategy planner exposes BOND only for local-logit teachers', () => {
  const catalog = distillStrategyCatalog();
  const bond = catalog.strategies.find((s) => s.id === 'bond_jeffreys');
  assert.ok(bond);
  assert.equal(bond.requires_teacher_logits, true);
  assert.ok(bond.references.some((r) => r.paper === 'arXiv:2407.14622'));

  const localPlan = planDistillStrategy({
    task: 'generation',
    real_pairs: 1500,
    holdout_pairs: 300,
    teachers: ['local:qwen'],
    teacher_local: true,
    teacher_agreement: 0.55,
  }, {});
  const localRow = localPlan.ranked.find((r) => r.id === 'bond_jeffreys');
  assert.equal(localRow.feasible, true);
  assert.match(localRow.command, /--objective=bond_jeffreys/);

  const apiPlan = planDistillStrategy({
    task: 'generation',
    real_pairs: 1500,
    holdout_pairs: 300,
    teachers: ['anthropic'],
  }, {});
  const apiRow = apiPlan.ranked.find((r) => r.id === 'bond_jeffreys');
  assert.equal(apiRow.feasible, false);
  assert.ok(apiRow.blockers.includes('teacher_logits_required'));
});

test('W973 #6 - bakeoff can report measured SeqKD vs BOND deltas hash-only', async () => {
  const report = await runDistillMethodBakeoff({
    rows: [
      {
        id: 'r1',
        prompt: 'private row one',
        teacher_output: 'refund to the original payment method',
        method_outputs: {
          seqkd: 'refund payment',
          bond_jeffreys: 'refund to the original payment method',
        },
      },
      {
        id: 'r2',
        prompt: 'private row two',
        teacher_output: 'send a confirmation email after refund',
        method_outputs: {
          seqkd: 'send email',
          bond_jeffreys: 'send a confirmation email after refund',
        },
      },
    ],
    methods: ['seqkd', 'bond_jeffreys'],
    baseline_method: 'seqkd',
    judge: ({ actual, expected }) => ({ score: actual === expected ? 0.95 : 0.4 }),
    judge_kind: 'fixture_exact_teacher_judge',
    min_score_delta: 0.1,
    min_win_rate: 0.9,
  });
  assert.equal(report.ok, true);
  assert.equal(report.privacy_mode, 'hash_only');
  assert.equal(report.best_method, 'bond_jeffreys');
  assert.equal(report.gate.pass, true);
  assert.doesNotMatch(JSON.stringify(report), /private row one/);
  const bond = report.ranked_methods.find((m) => m.method === 'bond_jeffreys');
  assert.ok(bond.score_delta_vs_baseline > 0);
  assert.equal(bond.win_rate_vs_baseline, 1);
});
