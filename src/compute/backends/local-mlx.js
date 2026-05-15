// local-mlx — Apple Silicon native via mlx-lm. Detected by mlx import probe.

import os from 'node:os';
import { spawnSync } from 'node:child_process';

export async function detect() {
  if (os.platform() !== 'darwin' || os.arch() !== 'arm64') {
    return { available: false, reason: 'not Apple Silicon' };
  }
  try {
    const res = spawnSync('python3', ['-c', 'import mlx, mlx_lm; print(mlx.__version__)'], {
      encoding: 'utf-8',
      timeout: 4000,
    });
    if (res.status !== 0) {
      return { available: false, reason: 'mlx-lm not importable (pip install mlx-lm)' };
    }
    return {
      available: true,
      device: 'mlx',
      version: (res.stdout || '').trim(),
      unified_memory_gb: Number((os.totalmem() / 1e9).toFixed(1)),
    };
  } catch (err) {
    return { available: false, reason: String(err.message || err) };
  }
}

export async function test() {
  const t0 = Date.now();
  const d = await detect();
  return { ok: d.available, latency_ms: Date.now() - t0, ...d };
}

export async function run() {
  throw new Error('local-mlx.run() not direct-callable; trainer bridge invokes mlx_lm.lora');
}

export default { detect, test, run };
