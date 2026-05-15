// local-mps — Apple Silicon (M1+) via torch.backends.mps.

import os from 'node:os';
import { spawnSync } from 'node:child_process';

export async function detect() {
  const isMac = os.platform() === 'darwin';
  const isAppleSilicon = isMac && (os.arch() === 'arm64');
  if (!isAppleSilicon) {
    return { available: false, reason: 'not Apple Silicon' };
  }
  return {
    available: true,
    device: 'mps',
    chip: detectChip(),
    cores: os.cpus().length,
    unified_memory_gb: Number((os.totalmem() / 1e9).toFixed(1)),
  };
}

function detectChip() {
  try {
    const res = spawnSync('sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf-8', timeout: 1000 });
    return (res.stdout || '').trim() || 'Apple Silicon';
  } catch {
    return 'Apple Silicon';
  }
}

export async function test() {
  const t0 = Date.now();
  const d = await detect();
  return { ok: d.available, latency_ms: Date.now() - t0, ...d };
}

export async function run() {
  throw new Error('local-mps.run() not direct-callable; trainer bridge handles PEFT-on-MPS path');
}

export default { detect, test, run };
