// fal — fal.ai serverless inference. KOLM_FAL_TOKEN env var.

export async function detect() {
  const token = process.env.KOLM_FAL_TOKEN || process.env.FAL_KEY;
  if (!token) return { available: false, reason: 'KOLM_FAL_TOKEN env var not set' };
  return { available: true, device: 'fal-serverless', endpoint: 'https://fal.run' };
}

export async function test() {
  const t0 = Date.now();
  const d = await detect();
  return { ok: d.available, latency_ms: Date.now() - t0, ...d };
}

export async function run() {
  throw new Error('fal.run() not direct-callable; inference-only backend');
}

export default { detect, test, run };
