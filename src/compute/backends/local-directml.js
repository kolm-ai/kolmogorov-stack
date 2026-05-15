// local-directml — Windows DX12 via torch-directml.

import { spawnSync } from 'node:child_process';

export async function detect() {
  try {
    const res = spawnSync('python', ['-c', 'import torch_directml; d=torch_directml.device(); print(torch_directml.device_count())'], {
      encoding: 'utf-8',
      timeout: 4000,
    });
    if (res.status !== 0) {
      return { available: false, reason: 'torch-directml not importable (pip install torch-directml)' };
    }
    const count = Number((res.stdout || '0').trim()) || 0;
    if (count === 0) return { available: false, reason: 'no DX12 device' };
    return { available: true, device: 'dml:0', device_count: count };
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
  throw new Error('local-directml.run() not direct-callable; trainer bridge handles DML path');
}

export default { detect, test, run };
