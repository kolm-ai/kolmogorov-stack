#!/usr/bin/env node
import { distillStrategyCatalog, planDistillStrategy } from '../src/distill-strategy.js';

function flag(name, fallback = '') {
  const args = process.argv.slice(2);
  const eq = args.find((a) => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const idx = args.indexOf(name);
  if (idx >= 0 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];
  return fallback;
}

function has(name) {
  return process.argv.slice(2).includes(name);
}

function simulatedEnv(kind) {
  if (!kind) return process.env;
  if (kind === 'anthropic') return { ANTHROPIC_API_KEY: 'simulated-key' };
  if (kind === 'openai') return { OPENAI_API_KEY: 'simulated-key' };
  if (kind === 'local') return { KOLM_LOCAL_TEACHER_URL: 'http://127.0.0.1:8000' };
  if (kind === 'empty') return {};
  throw new Error(`unknown --simulate ${kind}; use anthropic, openai, local, empty`);
}

function profileFromFlags() {
  const teachers = flag('--teachers', '');
  return {
    task: flag('--task', 'generation'),
    namespace: flag('--namespace', 'default'),
    base_model: flag('--base-model', flag('--model', 'Qwen/Qwen2.5-7B-Instruct')),
    privacy: flag('--privacy', 'standard'),
    real_pairs: Number(flag('--real-pairs', flag('--rows', '1000'))),
    synthetic_pairs: Number(flag('--synthetic-pairs', '0')),
    holdout_pairs: Number(flag('--holdout-pairs', '200')),
    preference_pairs: Number(flag('--preference-pairs', '0')),
    label_noise: Number(flag('--label-noise', '0.05')),
    teacher_agreement: Number(flag('--teacher-agreement', '0.8')),
    repeat_rate: Number(flag('--repeat-rate', '0.2')),
    target_latency_ms: Number(flag('--target-latency-ms', '120')),
    budget_usd: Number(flag('--budget-usd', '0')),
    existing_artifact: has('--existing-artifact'),
    teachers: teachers ? teachers.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
  };
}

try {
  if (has('--catalog')) {
    console.log(JSON.stringify(distillStrategyCatalog(), null, 2));
    process.exit(0);
  }
  const plan = planDistillStrategy(profileFromFlags(), simulatedEnv(flag('--simulate', '')));
  if (has('--summary')) {
    const rec = plan.recommendation || {};
    console.log(`ok=${plan.ok} task=${plan.profile.task} privacy=${plan.profile.privacy} recommendation=${rec.id || 'none'} feasible=${rec.feasible === true}`);
    if (rec.command) console.log(`run=${rec.command}`);
    if (rec.blockers?.length) console.log(`blockers=${rec.blockers.join(',')}`);
  } else {
    console.log(JSON.stringify(plan, null, 2));
  }
  if (has('--require-ready') && !plan.ok) process.exit(1);
} catch (err) {
  console.error(err && err.message ? err.message : String(err));
  process.exit(1);
}
