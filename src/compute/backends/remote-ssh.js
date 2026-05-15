// remote-ssh — bring your own GPU. Auth via SSH key + KOLM_REMOTE_HOST.

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

export async function detect() {
  const host = process.env.KOLM_REMOTE_HOST;
  if (!host) return { available: false, reason: 'KOLM_REMOTE_HOST not set (user@host:port)' };
  const sshKey = process.env.KOLM_REMOTE_SSH_KEY || path.join(os.homedir(), '.ssh', 'id_ed25519');
  if (!fs.existsSync(sshKey)) return { available: false, reason: `SSH key not found at ${sshKey}` };
  return { available: true, device: `remote://${host}`, host, ssh_key: sshKey };
}

export async function test() {
  const d = await detect();
  if (!d.available) return { ok: false, ...d };
  const t0 = Date.now();
  try {
    const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=4', '-i', d.ssh_key, d.host, 'echo kolm-probe'];
    const res = spawnSync('ssh', args, { encoding: 'utf-8', timeout: 6000 });
    const ok = res.status === 0 && /kolm-probe/.test(res.stdout || '');
    return { ok, latency_ms: Date.now() - t0, host: d.host, stderr: ok ? undefined : (res.stderr || '').slice(0, 200) };
  } catch (err) {
    return { ok: false, reason: String(err.message || err) };
  }
}

export async function run() {
  throw new Error('remote-ssh.run() not direct-callable; dispatched via trainer bridge with KOLM_TRAINER_BACKEND=remote-ssh');
}

export default { detect, test, run };
