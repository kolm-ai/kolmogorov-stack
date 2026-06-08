// W888-C - Local adapter: deploy(device, artifactPath, opts).
//
// For type=local devices the "deploy" step is just a copy into
// ~/.kolm/installed/<device_id>/<artifact_basename> followed by an optional
// runtime spawn. We never SSH or use the network - this is the "this very
// machine" path.
//
// Adapter contract (uniform across src/device-adapters/*):
//   async deploy(device, artifactPath, opts) → { ok, deployment_id, message, raw }

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

function _kolmDir() {
  return process.env.KOLM_DATA_DIR ? path.resolve(process.env.KOLM_DATA_DIR) : path.join(os.homedir(), '.kolm');
}

export async function deploy(device, artifactPath, opts = {}) {
  const deployment_id = 'dep_' + crypto.randomBytes(8).toString('hex');
  const raw = { steps: [] };
  if (!device || device.type !== 'local') {
    return { ok: false, deployment_id, message: 'local-adapter requires device.type === "local"', raw };
  }
  if (!artifactPath || !fs.existsSync(artifactPath)) {
    return { ok: false, deployment_id, message: `artifact not found: ${artifactPath}`, raw };
  }
  const dryRun = !!opts.dryRun;
  const startProcess = opts.startProcess !== false; // default true
  const runtime = opts.runtime || 'llama.cpp';
  const port = Number(opts.port || 8080);

  const installRoot = path.join(_kolmDir(), 'installed', device.id);
  const dst = path.join(installRoot, path.basename(artifactPath));

  if (dryRun) {
    raw.steps.push({ step: 'dry_run', ok: true });
    return { ok: true, deployment_id, message: `dry-run: would copy to ${dst}`, raw };
  }

  try {
    fs.mkdirSync(installRoot, { recursive: true });
    fs.copyFileSync(artifactPath, dst);
    raw.steps.push({ step: 'copy', ok: true, bytes: fs.statSync(dst).size, dest: dst });
  } catch (e) {
    return { ok: false, deployment_id, message: `copy failed: ${e && e.message ? e.message : String(e)}`, raw };
  }

  if (!startProcess) {
    return { ok: true, deployment_id, message: `installed ${path.basename(artifactPath)} to ${dst} (no process start)`, raw };
  }

  // Best-effort detached spawn. If the runtime binary isn't on PATH we surface
  // a non-fatal message - the artifact is on disk regardless.
  try {
    let cmd, args;
    if (runtime === 'llama.cpp' || runtime === 'llama-cpp') {
      cmd = 'llama-server';
      args = ['-m', dst, '--port', String(port), '--host', '127.0.0.1'];
    } else {
      raw.steps.push({ step: 'start', ok: false, skipped: 'unknown_runtime' });
      return { ok: true, deployment_id, message: `installed ${path.basename(artifactPath)} (runtime=${runtime} start skipped)`, raw };
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
    raw.steps.push({ step: 'start', ok: true, pid: child.pid });
    return {
      ok: true,
      deployment_id,
      message: `installed + spawned ${runtime} on 127.0.0.1:${port} (pid=${child.pid})`,
      raw,
    };
  } catch (e) {
    raw.steps.push({ step: 'start', ok: false, error: e && e.message ? e.message : String(e) });
    // Spawn failure is non-fatal: the artifact is on disk.
    return {
      ok: true,
      deployment_id,
      message: `installed ${path.basename(artifactPath)} (runtime spawn failed: ${e && e.message ? e.message : String(e)})`,
      raw,
    };
  }
}

export default { deploy };
