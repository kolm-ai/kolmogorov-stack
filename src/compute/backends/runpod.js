// runpod — serverless or pod-based GPUs on runpod.io. Auth via KOLM_RUNPOD_TOKEN.

export async function detect() {
  const token = process.env.KOLM_RUNPOD_TOKEN || process.env.RUNPOD_API_KEY;
  if (!token) return { available: false, reason: 'KOLM_RUNPOD_TOKEN env var not set' };
  return {
    available: true,
    device: 'runpod-h100',
    endpoint: process.env.KOLM_RUNPOD_ENDPOINT || 'https://api.runpod.io/graphql',
  };
}

export async function test() {
  const t0 = Date.now();
  const d = await detect();
  return { ok: d.available, latency_ms: Date.now() - t0, ...d };
}

export async function run() {
  throw new Error('runpod.run() not direct-callable; dispatched via trainer bridge with KOLM_TRAINER_BACKEND=runpod');
}

export default { detect, test, run };
