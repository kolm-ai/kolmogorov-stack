// local-cuda — NVIDIA GPU on this box. Detection via nvidia-smi.

import { spawnSync } from 'node:child_process';

function nvidiaSmi() {
  try {
    const res = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'], {
      encoding: 'utf-8',
      timeout: 3000,
    });
    if (res.status !== 0 || !res.stdout) return null;
    return res.stdout
      .trim()
      .split('\n')
      .map((line) => {
        const [name, mem, drv] = line.split(',').map((s) => s.trim());
        return { name, vram_mb: Number(mem), driver: drv };
      });
  } catch {
    return null;
  }
}

export async function detect() {
  const gpus = nvidiaSmi();
  if (!gpus || gpus.length === 0) {
    return { available: false, reason: 'no nvidia-smi or no GPUs' };
  }
  return {
    available: true,
    device: `cuda:0`,
    gpus,
    primary_vram_gb: Number((gpus[0].vram_mb / 1024).toFixed(1)),
  };
}

export async function test() {
  const t0 = Date.now();
  const d = await detect();
  return { ok: d.available, latency_ms: Date.now() - t0, ...d };
}

export async function run() {
  throw new Error('local-cuda.run() not direct-callable; trainer bridge handles Unsloth path');
}

export default { detect, test, run };
