#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { quantizationOracleCatalog, rankQuantizationStrategies } from '../src/quantization-oracle.js';

const args = process.argv.slice(2);

function flag(name, fallback = null) {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  return args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true;
}

function readProfile() {
  const file = flag('--profile');
  if (file && file !== true) {
    return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  }
  return {
    task: flag('--task', 'chat'),
    device: flag('--device', null),
    runtime: flag('--runtime', null),
    params_b: Number(flag('--params-b', flag('--params', 7))),
    context_tokens: Number(flag('--context', 4096)),
    memory_gb: flag('--memory-gb') == null ? undefined : Number(flag('--memory-gb')),
    calibration_rows: Number(flag('--calibration-rows', 0)),
    quality_floor: flag('--quality-floor') == null ? undefined : Number(flag('--quality-floor')),
    privacy_mode: flag('--privacy-mode', 'standard'),
    preference_tuned: args.includes('--preference-tuned'),
  };
}

if (args.includes('--help')) {
  console.log(`usage:
  node scripts/quantization-oracle.mjs --task extraction --device rtx-4090-24gb --params-b 7 --context 8192 --calibration-rows 256
  node scripts/quantization-oracle.mjs --profile profile.json
  node scripts/quantization-oracle.mjs --catalog

This is a deterministic planner, not a benchmark. It chooses a quantization
strategy from device/runtime/quality/privacy constraints and tells the operator
which real worker command or external toolchain is required.`);
  process.exit(0);
}

const result = args.includes('--catalog')
  ? quantizationOracleCatalog()
  : rankQuantizationStrategies(readProfile());

console.log(JSON.stringify(result, null, 2));
if (result.ok === false) process.exitCode = 1;
