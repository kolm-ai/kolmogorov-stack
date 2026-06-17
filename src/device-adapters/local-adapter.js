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

const SAFE_DEVICE_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

function _kolmDir() {
  return process.env.KOLM_DATA_DIR ? path.resolve(process.env.KOLM_DATA_DIR) : path.join(os.homedir(), '.kolm');
}

function _installedRoot() {
  return path.join(_kolmDir(), 'installed');
}

function _safeDeviceId(device) {
  const id = device && device.id != null ? String(device.id) : '';
  if (!SAFE_DEVICE_ID_RE.test(id) || id === '.' || id === '..') {
    throw new Error('local-adapter requires a safe device.id ([A-Za-z0-9._-], 1-128 chars)');
  }
  return id;
}

function _safePort(value) {
  const port = value === undefined || value === null || value === ''
    ? 8080
    : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('local-adapter port must be an integer from 1 to 65535');
  }
  return port;
}

function _sha256File(filePath) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let bytes;
    while ((bytes = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      h.update(buf.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

function _resolveInside(root, ...parts) {
  const rootAbs = path.resolve(root);
  const target = path.resolve(rootAbs, ...parts);
  const rel = path.relative(rootAbs, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('local-adapter install path escaped installed root');
  }
  return target;
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
  let deviceId;
  let port;
  try {
    deviceId = _safeDeviceId(device);
    port = _safePort(opts.port);
  } catch (e) {
    return { ok: false, deployment_id, message: e && e.message ? e.message : String(e), raw };
  }
  const dryRun = !!opts.dryRun;
  const startProcess = opts.startProcess !== false; // default true
  const runtime = opts.runtime || 'llama.cpp';
  const spawnImpl = opts.spawnImpl || spawn;

  const installRoot = _resolveInside(_installedRoot(), deviceId);
  const dst = _resolveInside(installRoot, path.basename(artifactPath));

  if (dryRun) {
    raw.steps.push({ step: 'dry_run', ok: true });
    return { ok: true, deployment_id, message: `dry-run: would copy to ${dst}`, raw };
  }

  try {
    fs.mkdirSync(installRoot, { recursive: true });
    fs.copyFileSync(artifactPath, dst);
    raw.steps.push({
      step: 'copy',
      ok: true,
      bytes: fs.statSync(dst).size,
      dest: dst,
      sha256: _sha256File(dst),
    });
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
    const child = spawnImpl(cmd, args, { detached: true, stdio: 'ignore' });
    if (child && typeof child.once === 'function') {
      child.once('error', (err) => {
        raw.steps.push({ step: 'start_error', ok: false, error: err && err.message ? err.message : String(err) });
      });
    }
    if (!child || !Number.isInteger(child.pid) || child.pid <= 0) {
      raw.steps.push({ step: 'start', ok: false, error: 'spawn_no_pid' });
      return {
        ok: true,
        deployment_id,
        message: `installed ${path.basename(artifactPath)} (runtime spawn failed: no pid)`,
        raw,
      };
    }
    if (typeof child.unref === 'function') child.unref();
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
