// W1030 GPU trainer variant e2e harness contract.
//
// Default test path is GPU-free and verifies the harness is real, opt-in, and
// points at the production Python trainer. Setting KOLM_RUN_GPU_TRAINER_E2E=1
// turns the same file into a live GPU evidence test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const harness = path.join(repoRoot, 'scripts', 'run-gpu-trainer-variant-e2e.mjs');

test('W1030 harness skips safely unless explicitly enabled', () => {
  const env = { ...process.env };
  delete env.KOLM_RUN_GPU_TRAINER_E2E;
  const r = spawnSync(process.execPath, [harness], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 60000,
  });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.equal(got.ok, true);
  assert.equal(got.skipped, true);
  assert.match(got.reason, /KOLM_RUN_GPU_TRAINER_E2E=1/);
  assert.deepEqual(got.required_env, ['KOLM_RUN_GPU_TRAINER_E2E', 'KOLM_GPU_TRAINER_E2E_BASE_MODEL']);
});

test('W1030 harness pins real trainer cases and summary assertions', () => {
  const txt = fs.readFileSync(harness, 'utf8');
  assert.match(txt, /KOLM_RUN_GPU_TRAINER_E2E/);
  assert.match(txt, /KOLM_GPU_TRAINER_E2E_BASE_MODEL/);
  assert.match(txt, /torch\.cuda\.is_available\(\)/);
  assert.match(txt, /train_lora\.py/);
  assert.match(txt, /'--backend', 'hf'/);
  assert.doesNotMatch(txt, /['"]--preflight-only['"]/);
  assert.match(txt, /KOLM_LORA_INIT: 'pissa_niter_16'/);
  assert.match(txt, /KOLM_LORA_VARIANT: 'dora'/);
  assert.match(txt, /KOLM_PACKING: '1'/);
  assert.match(txt, /KOLM_OPTIM: 'galore_adamw'/);
  assert.match(txt, /KOLM_GALORE_ARGS: 'rank=4,update_proj_gap=50,scale=0\.25'/);
  assert.match(txt, /training-summary\.json/);
  assert.match(txt, /summary\.variants/);
  assert.match(txt, /TRANSFORMERS_OFFLINE/);
  assert.match(txt, /HF_HUB_OFFLINE/);
});

test('W1030 live GPU trainer e2e evidence run', {
  skip: process.env.KOLM_RUN_GPU_TRAINER_E2E !== '1',
}, () => {
  const r = spawnSync(process.execPath, [harness], {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: Number(process.env.KOLM_GPU_TRAINER_E2E_TEST_TIMEOUT_MS || 35 * 60 * 1000),
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const got = JSON.parse(r.stdout);
  assert.equal(got.ok, true);
  assert.equal(got.skipped, false);
  assert.ok(got.cases.some((c) => c.case === 'pissa_dora_packing'));
  assert.ok(got.cases.some((c) => c.case === 'galore_adamw'));
});
