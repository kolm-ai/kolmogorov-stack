#!/usr/bin/env node

import { buildStrategyCatalog, planBuildStrategy } from '../src/build-strategy-brain.js';

function readFlag(args, name, fallback = undefined) {
  const ix = args.indexOf(name);
  if (ix >= 0 && ix + 1 < args.length) return args[ix + 1];
  const prefix = `${name}=`;
  const hit = args.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function has(args, name) {
  return args.includes(name);
}

function num(value) {
  if (value == null) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function inputFromArgs(args) {
  return {
    task: readFlag(args, '--task', 'unknown'),
    namespace: readFlag(args, '--namespace', readFlag(args, '--name', 'default')),
    base_model: readFlag(args, '--base-model', readFlag(args, '--model', undefined)),
    privacy: readFlag(args, '--privacy', readFlag(args, '--privacy-mode', 'standard')),
    real_pairs: num(readFlag(args, '--real-pairs', readFlag(args, '--rows', undefined))),
    synthetic_pairs: num(readFlag(args, '--synthetic-pairs', undefined)),
    holdout_pairs: num(readFlag(args, '--holdout-pairs', readFlag(args, '--holdout', undefined))),
    preference_pairs: num(readFlag(args, '--preference-pairs', undefined)),
    repeat_rate: num(readFlag(args, '--repeat-rate', undefined)),
    label_noise: num(readFlag(args, '--label-noise', undefined)),
    teacher_agreement: num(readFlag(args, '--teacher-agreement', undefined)),
    target_latency_ms: num(readFlag(args, '--target-latency-ms', undefined)),
    budget_usd: num(readFlag(args, '--budget-usd', undefined)),
    params_b: num(readFlag(args, '--params-b', undefined)),
    context_tokens: num(readFlag(args, '--context-tokens', undefined)),
    calibration_rows: num(readFlag(args, '--calibration-rows', undefined)),
    device: readFlag(args, '--device', undefined),
    runtime: readFlag(args, '--runtime', undefined),
    no_local_gpu: has(args, '--no-local-gpu'),
    existing_artifact: has(args, '--existing-artifact'),
  };
}

const args = process.argv.slice(2);
if (has(args, '--catalog')) {
  console.log(JSON.stringify(buildStrategyCatalog(), null, 2));
  process.exit(0);
}

const plan = planBuildStrategy(inputFromArgs(args), process.env);
if (has(args, '--summary')) {
  console.log(`ok=${plan.ok} recommendation=${plan.recommendation?.id || 'none'} task=${plan.profile.task} privacy=${plan.profile.privacy}`);
  if (plan.recommendation?.command) console.log(`run=${plan.recommendation.command}`);
  if (plan.recommendation?.blockers?.length) console.log(`blockers=${plan.recommendation.blockers.join(',')}`);
} else {
  console.log(JSON.stringify(plan, null, 2));
}

if (has(args, '--require-ready') && !plan.ok) process.exitCode = 1;
