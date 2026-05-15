// lambda — Lambda Labs Cloud API.

export async function detect() {
  const token = process.env.KOLM_LAMBDA_TOKEN || process.env.LAMBDA_API_KEY;
  if (!token) return { available: false, reason: 'KOLM_LAMBDA_TOKEN env var not set' };
  return { available: true, device: 'lambda-cloud', endpoint: 'https://cloud.lambdalabs.com/api/v1' };
}

export async function test() {
  const t0 = Date.now();
  const d = await detect();
  return { ok: d.available, latency_ms: Date.now() - t0, ...d };
}

export async function run() {
  throw new Error('lambda.run() not direct-callable; dispatched via trainer bridge with KOLM_TRAINER_BACKEND=lambda');
}

export default { detect, test, run };
