// local-rocm — AMD MI / RDNA3 via rocm-smi.

import { spawnSync } from 'node:child_process';

export async function detect() {
  try {
    const res = spawnSync('rocm-smi', ['--showproductname', '--showmeminfo', 'vram', '--json'], {
      encoding: 'utf-8',
      timeout: 3000,
    });
    if (res.status !== 0 || !res.stdout) {
      return { available: false, reason: 'rocm-smi missing or no AMD GPU' };
    }
    let data;
    try { data = JSON.parse(res.stdout); } catch { return { available: false, reason: 'rocm-smi json parse failed' }; }
    const cards = Object.keys(data).filter((k) => k.startsWith('card'));
    if (cards.length === 0) return { available: false, reason: 'no cards reported' };
    return {
      available: true,
      device: 'cuda:0', // ROCm exposes via cuda namespace in pytorch+hip
      cards: cards.length,
      detail: cards.map((c) => data[c]),
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
  throw new Error('local-rocm.run() not direct-callable; trainer bridge handles ROCm path');
}

export default { detect, test, run };
