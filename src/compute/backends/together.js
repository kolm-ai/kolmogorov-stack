// together — Together AI managed fine-tune. Auth via KOLM_TOGETHER_TOKEN.

export async function detect() {
  const token = process.env.KOLM_TOGETHER_TOKEN || process.env.TOGETHER_API_KEY;
  if (!token) return { available: false, reason: 'KOLM_TOGETHER_TOKEN env var not set' };
  return {
    available: true,
    device: 'together-managed',
    endpoint: 'https://api.together.xyz/v1',
  };
}

export async function test() {
  const t0 = Date.now();
  const d = await detect();
  return { ok: d.available, latency_ms: Date.now() - t0, ...d };
}

export async function run() {
  throw new Error('together.run() not direct-callable; dispatched via trainer bridge with KOLM_TRAINER_BACKEND=together');
}

export default { detect, test, run };
