// replicate — Replicate Cog containers. Auth via KOLM_REPLICATE_TOKEN.

export async function detect() {
  const token = process.env.KOLM_REPLICATE_TOKEN || process.env.REPLICATE_API_TOKEN;
  if (!token) return { available: false, reason: 'KOLM_REPLICATE_TOKEN env var not set' };
  return { available: true, device: 'replicate-cog', endpoint: 'https://api.replicate.com/v1' };
}

export async function test() {
  const t0 = Date.now();
  const d = await detect();
  return { ok: d.available, latency_ms: Date.now() - t0, ...d };
}

export async function run() {
  throw new Error('replicate.run() not direct-callable; dispatched via trainer bridge with KOLM_TRAINER_BACKEND=replicate');
}

export default { detect, test, run };
