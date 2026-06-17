// W636 - GPU-free coverage for the >32B multinode/FSDP launcher.
// The launcher promises that --dry-run resolves topology, memory, and command
// shape without importing torch or touching GPUs. These tests pin that contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PY = process.env.KOLM_PYTHON || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const launcher = path.join(repoRoot, 'apps', 'trainer', 'multinode_launch.py');

function pythonAvailable() {
  try {
    return spawnSync(PY, ['--version'], { stdio: 'pipe', timeout: 20000 }).status === 0;
  } catch {
    return false;
  }
}

const HAVE_PY = pythonAvailable();

function runLauncher(extraArgs = []) {
  const args = [
    launcher,
    '--model', 'meta-llama/Llama-3.1-70B',
    '--nodes', '2',
    '--gpus-per-node', '8',
    '--gpu', 'a100-80gb',
    '--mode', 'qlora',
    '--dry-run',
    '--json',
    ...extraArgs,
  ];
  const result = spawnSync(PY, args, {
    cwd: repoRoot,
    stdio: 'pipe',
    timeout: 60000,
  });
  assert.equal(result.status, 0, (result.stderr || '').toString());
  return {
    plan: JSON.parse((result.stdout || '').toString()),
    stderr: (result.stderr || '').toString(),
  };
}

test('multinode_launch.py parses without trainer dependencies', { skip: !HAVE_PY }, () => {
  const result = spawnSync(PY, ['-m', 'py_compile', launcher], {
    cwd: repoRoot,
    stdio: 'pipe',
    timeout: 30000,
  });
  assert.equal(result.status, 0, (result.stderr || '').toString());
});

test('multinode dry-run pins torchrun FSDP plan and memory estimator', { skip: !HAVE_PY }, () => {
  const { plan, stderr } = runLauncher();

  assert.equal(plan.model, 'meta-llama/Llama-3.1-70B');
  assert.equal(plan.model_params_billion, 70);
  assert.equal(plan.mode, 'qlora');
  assert.equal(plan.trainer, 'distill');
  assert.equal(plan.nnodes, 2);
  assert.equal(plan.gpus_per_node, 8);
  assert.equal(plan.world_size, 16);
  assert.equal(plan.sharding_strategy, 'FULL_SHARD');
  assert.equal(plan.launcher, 'torchrun');
  assert.equal(plan.accelerate_config_path, null);
  assert.equal(plan.accelerate_config_text, null);

  assert.equal(plan.memory.fits, true);
  assert.equal(plan.memory.base_weights_gib, 32.6);
  assert.equal(plan.memory.base_weights_sharded_gib, 2.04);
  assert.equal(plan.memory.trainable_params_million, 210);
  assert.equal(plan.memory.total_per_gpu_gib, 11.87);
  assert.equal(plan.memory.headroom_gib, 67.13);
  assert.match(plan.memory.notes.join('\n'), /auto sharding -> FULL_SHARD/);
  assert.match(plan.memory.notes.join('\n'), /base weights sharded 1\/16/);

  assert.deepEqual(plan.command.slice(0, 7), [
    'torchrun',
    '--nnodes=2',
    '--nproc_per_node=8',
    '--node_rank=0',
    '--rdzv_backend=c10d',
    '--rdzv_id=kolm-mn',
    '--rdzv_endpoint=127.0.0.1:29500',
  ]);
  assert.equal(path.basename(plan.command.at(-1)), 'distill.py');
  assert.equal(plan.env_overrides.KOLM_FSDP, '1');
  assert.equal(plan.env_overrides.KOLM_FSDP_SHARDING, 'FULL_SHARD');
  assert.equal(plan.env_overrides.KOLM_FSDP_MIXED_PRECISION, 'bf16');
  assert.equal(plan.env_overrides.KOLM_TRAIN_MODE, 'qlora');
  assert.match(stderr, /dry-run OK/);
});

test('multinode accelerate dry-run emits FSDP YAML but writes no config file', { skip: !HAVE_PY }, () => {
  const configPath = path.join(os.tmpdir(), `kolm-wave636-accelerate-${process.pid}-${Date.now()}.yaml`);
  assert.equal(fs.existsSync(configPath), false);

  const { plan, stderr } = runLauncher([
    '--launcher', 'accelerate',
    '--accelerate-config-out', configPath,
  ]);

  assert.equal(plan.launcher, 'accelerate');
  assert.equal(plan.accelerate_config_path, configPath);
  assert.deepEqual(plan.command.slice(0, 8), [
    'accelerate',
    'launch',
    `--config_file=${configPath}`,
    '--num_machines=2',
    '--num_processes=16',
    '--machine_rank=0',
    '--main_process_ip=127.0.0.1',
    '--main_process_port=29500',
  ]);
  assert.equal(path.basename(plan.command.at(-1)), 'distill.py');
  assert.match(plan.accelerate_config_text, /distributed_type: FSDP/);
  assert.match(plan.accelerate_config_text, /num_machines: 2/);
  assert.match(plan.accelerate_config_text, /num_processes: 16/);
  assert.match(plan.accelerate_config_text, /mixed_precision: bf16/);
  assert.match(plan.accelerate_config_text, /fsdp_sharding_strategy: 1/);
  assert.match(plan.accelerate_config_text, /fsdp_activation_checkpointing: true/);
  assert.equal(fs.existsSync(configPath), false);
  assert.match(stderr, /dry-run OK/);
});
