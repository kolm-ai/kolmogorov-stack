// local-cpu — always available, slow, no GPU required.
//
// Detection: we never claim "unavailable" for CPU. Reports core count and
// total RAM so the picker can downgrade if a 7B job is asked for on a tiny
// box. Run() bridges to apps/trainer via /distill with backend=local-cpu.

import os from 'node:os';

export async function detect() {
  return {
    available: true,
    device: 'cpu',
    cores: os.cpus().length,
    ram_gb: Number((os.totalmem() / 1e9).toFixed(1)),
  };
}

export async function test() {
  const t0 = Date.now();
  return { ok: true, latency_ms: Date.now() - t0, device: 'cpu', cores: os.cpus().length };
}

// Run is delegated to the Python trainer — JS never imports torch.
export async function run(spec, { on_progress } = {}) {
  // The actual dispatch happens in router.js -> apps/trainer (KOLM_TRAINER_MODE=local).
  // This stub exists so pick() can route to local-cpu and the caller routes the spec.
  throw new Error('local-cpu.run() not direct-callable; use trainer bridge with KOLM_TRAINER_BACKEND=local');
}

export default { detect, test, run };
