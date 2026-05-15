// modal — serverless GPU on modal.com. Auth via KOLM_MODAL_TOKEN env var
// (which the Python trainer translates into MODAL_TOKEN_ID + MODAL_TOKEN_SECRET).

export async function detect() {
  const token = process.env.KOLM_MODAL_TOKEN || process.env.MODAL_TOKEN_ID;
  if (!token) {
    return { available: false, reason: 'KOLM_MODAL_TOKEN env var not set' };
  }
  return {
    available: true,
    device: 'modal-h100',
    auth: 'token',
    region: process.env.KOLM_MODAL_REGION || 'auto',
  };
}

export async function test() {
  const t0 = Date.now();
  const d = await detect();
  return { ok: d.available, latency_ms: Date.now() - t0, ...d };
}

export async function run(spec, { on_progress } = {}) {
  // The actual modal.com SDK call happens on the Python side
  // (apps/trainer/backends/modal_runner.py). JS just forwards the spec.
  throw new Error('modal.run() not direct-callable; dispatched via trainer bridge with KOLM_TRAINER_BACKEND=modal');
}

export default { detect, test, run };
