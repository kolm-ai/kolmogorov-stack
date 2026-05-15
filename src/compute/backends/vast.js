// vast — Vast.ai SSH-driven instances. Auth via KOLM_VAST_TOKEN + an SSH key
// (KOLM_VAST_SSH_KEY path, default ~/.ssh/id_ed25519).

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export async function detect() {
  const token = process.env.KOLM_VAST_TOKEN || process.env.VAST_API_KEY;
  if (!token) return { available: false, reason: 'KOLM_VAST_TOKEN env var not set' };
  const sshKey = process.env.KOLM_VAST_SSH_KEY || path.join(os.homedir(), '.ssh', 'id_ed25519');
  if (!fs.existsSync(sshKey)) return { available: false, reason: `SSH key not found at ${sshKey}` };
  return { available: true, device: 'vast-ssh', endpoint: 'https://console.vast.ai/api/v0' };
}

export async function test() {
  const t0 = Date.now();
  const d = await detect();
  return { ok: d.available, latency_ms: Date.now() - t0, ...d };
}

export async function run() {
  throw new Error('vast.run() not direct-callable; dispatched via trainer bridge with KOLM_TRAINER_BACKEND=vast');
}

export default { detect, test, run };
