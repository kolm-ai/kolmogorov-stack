#!/usr/bin/env node
import { cloudComputeBrokerCatalog, planCloudCompute } from '../src/cloud-compute-broker.js';

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
  const base = { KOLM_DATA_DIR: process.env.KOLM_DATA_DIR || 'C:/tmp/kolm-sim' };
  if (kind === 'runpod-r2') {
    return {
      ...base,
      KOLM_RUNPOD_TOKEN: 'simulated-token',
      CLOUDFLARE_ACCOUNT_ID: 'acct',
      R2_ACCESS_KEY_ID: 'r2-access',
      R2_SECRET_ACCESS_KEY: 'r2-secret',
      R2_BUCKET: 'kolm-artifacts',
    };
  }
  if (kind === 'ssh-s3') {
    return {
      ...base,
      KOLM_REMOTE_SSH_HOST: 'gpu.internal',
      KOLM_REMOTE_SSH_USER: 'kolm',
      KOLM_S3_ENDPOINT: 'https://minio.internal',
      KOLM_S3_BUCKET: 'kolm-artifacts',
      KOLM_S3_ACCESS_KEY_ID: 'minio-access',
      KOLM_S3_SECRET_ACCESS_KEY: 'minio-secret',
    };
  }
  if (kind === 'local-cuda') {
    return { ...base, KOLM_FORCE_LOCAL_CUDA: '1' };
  }
  if (kind === 'cloudflare-edge') {
    return {
      ...base,
      CLOUDFLARE_ACCOUNT_ID: 'acct',
      CLOUDFLARE_API_TOKEN: 'cf-token',
      R2_ACCESS_KEY_ID: 'r2-access',
      R2_SECRET_ACCESS_KEY: 'r2-secret',
      R2_BUCKET: 'kolm-artifacts',
    };
  }
  if (kind === 'empty') return base;
  throw new Error(`unknown --simulate ${kind}; use runpod-r2, ssh-s3, local-cuda, cloudflare-edge, empty`);
}

function profileFromFlags() {
  return {
    workload: flag('--workload', flag('--mode', 'train')),
    privacy: flag('--privacy', 'standard'),
    name: flag('--name', 'kolm-job'),
    artifact: flag('--artifact', 'artifact'),
    base_model: flag('--base-model', flag('--model', 'Qwen/Qwen2.5-7B-Instruct')),
    dataset: flag('--dataset', flag('--seeds', 'seeds.jsonl')),
    params_b: Number(flag('--params-b', '7')),
    rows: Number(flag('--rows', '1000')),
    context_tokens: Number(flag('--context', '8192')),
    budget_usd: Number(flag('--budget-usd', flag('--budget', '0'))),
    no_local_gpu: has('--no-local-gpu'),
  };
}

try {
  if (has('--catalog')) {
    console.log(JSON.stringify(cloudComputeBrokerCatalog(), null, 2));
    process.exit(0);
  }
  const env = simulatedEnv(flag('--simulate', ''));
  const plan = planCloudCompute(profileFromFlags(), env);
  if (has('--summary')) {
    const rec = plan.recommendation || {};
    console.log(`ok=${plan.ok} workload=${plan.profile.workload} privacy=${plan.profile.privacy} recommendation=${rec.id || 'none'} state=${rec.state || 'none'} storage=${plan.storage.selected_provider || 'none'}`);
    if (rec.run_command) console.log(`run=${rec.run_command}`);
    else if (rec.quote_command) console.log(`quote=${rec.quote_command}`);
  } else {
    console.log(JSON.stringify(plan, null, 2));
  }
  if (has('--require-ready') && !plan.ok) process.exit(1);
} catch (err) {
  console.error(err && err.message ? err.message : String(err));
  process.exit(1);
}
