// W888-C - SSH adapter: deploy(device, artifactPath, opts).
//
// Wraps src/device-ssh.js#SSHConnection to upload an artifact via SFTP +
// run the runtime-install + start path. This is the "happy path" for any
// physical device the operator can SSH into.
//
// Adapter contract (uniform across src/device-adapters/*):
//   async deploy(device, artifactPath, opts) → { ok, deployment_id, message, raw }
//
//   - device: DeviceRegistry record (must have type='ssh' + host + keyPath)
//   - artifactPath: absolute local path to the .kolm artifact
//   - opts: { runtime, port, bindHost, remoteDir, autoInstall, dryRun,
//             SSHConnectionClass (test injection) }
//   - return: { ok: bool, deployment_id: string, message: string, raw: object }

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function _sha256(filePath) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(filePath));
  return h.digest('hex');
}

const RUNTIME_INSTALL_CMDS = {
  'llama.cpp': 'curl -fsSL https://github.com/ggml-org/llama.cpp/releases/latest/download/llama-server-linux-x64 -o /usr/local/bin/llama-server && chmod +x /usr/local/bin/llama-server',
  'llama-cpp': 'curl -fsSL https://github.com/ggml-org/llama.cpp/releases/latest/download/llama-server-linux-x64 -o /usr/local/bin/llama-server && chmod +x /usr/local/bin/llama-server',
  vllm: 'pip install --quiet --upgrade vllm',
  ollama: 'curl -fsSL https://ollama.com/install.sh | sh',
};

const RUNTIME_START_CMDS = {
  'llama.cpp': ({ remotePath, port, bindHost }) => `nohup llama-server -m ${JSON.stringify(remotePath)} --port ${Number(port)} --host ${JSON.stringify(bindHost)} > /tmp/kolm-deploy.log 2>&1 & echo $!`,
  'llama-cpp': ({ remotePath, port, bindHost }) => `nohup llama-server -m ${JSON.stringify(remotePath)} --port ${Number(port)} --host ${JSON.stringify(bindHost)} > /tmp/kolm-deploy.log 2>&1 & echo $!`,
};

// W890-6 - input validation for any value interpolated into an SSH command
// payload. The connection itself uses ssh2's per-channel API (no shell escape
// at the SSH layer), but the remote shell still parses the command string - 
// so any caller-supplied path or runtime name must match a strict allowlist.
//
// _assertSafeRemoteDir: POSIX-shell-safe path; only [A-Za-z0-9_./~-] allowed.
// Backticks, $(, ;, &, |, <, >, quotes, newlines, and spaces are rejected.
const _SAFE_REMOTE_DIR_RE = /^[A-Za-z0-9_./~-]{1,512}$/;
function _assertSafeRemoteDir(p) {
  if (!_SAFE_REMOTE_DIR_RE.test(String(p))) {
    throw new Error(`unsafe remoteDir (rejected by allowlist): ${p}`);
  }
}
// _assertSafeRuntimeName: runtime is whitelisted against RUNTIME_INSTALL_CMDS,
// but we re-validate here so the regex catches anything added to the dict that
// somehow contains shell metacharacters.
const _SAFE_RUNTIME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
function _assertSafeRuntime(r) {
  if (!_SAFE_RUNTIME_RE.test(String(r))) {
    throw new Error(`unsafe runtime name (rejected by allowlist): ${r}`);
  }
}

export async function deploy(device, artifactPath, opts = {}) {
  const deployment_id = 'dep_' + crypto.randomBytes(8).toString('hex');
  const raw = { steps: [] };

  if (!device || device.type !== 'ssh') {
    return { ok: false, deployment_id, message: 'ssh-adapter requires device.type === "ssh"', raw };
  }
  if (!artifactPath || !fs.existsSync(artifactPath)) {
    return { ok: false, deployment_id, message: `artifact not found: ${artifactPath}`, raw };
  }
  const runtime = opts.runtime || 'llama.cpp';
  const port = Number(opts.port || 8080);
  const bindHost = opts.bindHost || '0.0.0.0';
  const remoteDir = opts.remoteDir || '~/.kolm/installed';
  const autoInstall = !!opts.autoInstall;
  const dryRun = !!opts.dryRun;

  // W890-6 - validate every value that lands in an SSH command payload.
  try {
    _assertSafeRemoteDir(remoteDir);
    _assertSafeRuntime(runtime);
  } catch (e) {
    return { ok: false, deployment_id, message: e.message, raw };
  }

  // Test-time injection: opts.SSHConnectionClass shortcuts the lazy import
  // so the test suite can drive the whole adapter against an in-memory shim.
  const SSHConnectionClass = opts.SSHConnectionClass || (await import('../device-ssh.js')).SSHConnection;

  if (dryRun) {
    raw.steps.push({ step: 'dry_run', ok: true });
    return {
      ok: true,
      deployment_id,
      message: `dry-run: would upload ${path.basename(artifactPath)} to ${device.host}:${remoteDir} + start runtime=${runtime} on port ${port}`,
      raw,
    };
  }

  const remotePath = `${remoteDir.replace(/\/$/, '')}/${path.basename(artifactPath)}`;
  const localSha = _sha256(artifactPath);

  let conn = null;
  try {
    conn = new SSHConnectionClass(device);
    if (typeof conn.connect === 'function') await conn.connect();

    // Step 1: mkdir
    const mk = await conn.exec(`mkdir -p ${remoteDir.replace('~', '$HOME')}`, { timeoutMs: 10_000 });
    raw.steps.push({ step: 'mkdir', ok: mk.code === 0, stderr: mk.stderr });
    if (mk.code !== 0) return { ok: false, deployment_id, message: `mkdir failed: ${mk.stderr}`, raw };

    // Step 2: upload
    const u = await conn.upload(artifactPath, remotePath.replace('~', '$HOME'));
    raw.steps.push({ step: 'upload', ok: u.ok !== false, bytes: u.bytes });

    // Step 3: sha verify (mocked SSH returns the same sha on .sha256())
    if (typeof conn.sha256 === 'function') {
      const remoteSha = await conn.sha256(remotePath.replace('~', '$HOME'));
      const shaMatch = remoteSha === localSha;
      raw.steps.push({ step: 'sha256_verify', ok: shaMatch, local: localSha, remote: remoteSha });
      if (!shaMatch) return { ok: false, deployment_id, message: `sha mismatch: local=${localSha} remote=${remoteSha}`, raw };
    }

    // Step 4: ensureRuntime
    if (autoInstall && RUNTIME_INSTALL_CMDS[runtime]) {
      // runtime is validated by _assertSafeRuntime above; only [A-Za-z0-9_.-]
      // are allowed so this `command -v` interpolation cannot inject shell.
      const probeRuntime = runtime === 'llama.cpp' || runtime === 'llama-cpp' ? 'llama-server' : runtime;
      const probe = await conn.exec(`command -v ${probeRuntime} 2>/dev/null`, { timeoutMs: 5_000 });
      if (probe.code !== 0 || !(probe.stdout || '').trim()) {
        const ir = await conn.exec(RUNTIME_INSTALL_CMDS[runtime], { timeoutMs: 300_000 });
        raw.steps.push({ step: 'install_runtime', ok: ir.code === 0, stderr: ir.stderr });
        if (ir.code !== 0) return { ok: false, deployment_id, message: `auto-install failed: ${ir.stderr}`, raw };
      } else {
        raw.steps.push({ step: 'install_runtime', ok: true, skipped: 'already_present' });
      }
    }

    // Step 5: start
    const startBuilder = RUNTIME_START_CMDS[runtime];
    if (startBuilder) {
      const startCmd = startBuilder({ remotePath: remotePath.replace('~', '$HOME'), port, bindHost });
      const sr = await conn.exec(startCmd, { timeoutMs: 15_000 });
      const pid = Number(String(sr.stdout || '').trim().split(/\s+/).pop());
      raw.steps.push({ step: 'start', ok: sr.code === 0 && Number.isFinite(pid), pid, stderr: sr.stderr });
      if (sr.code !== 0) return { ok: false, deployment_id, message: `start failed: ${sr.stderr}`, raw };
      return {
        ok: true,
        deployment_id,
        message: `deployed ${path.basename(artifactPath)} to ${device.host}:${port} (pid=${pid})`,
        raw,
      };
    }

    return {
      ok: true,
      deployment_id,
      message: `uploaded ${path.basename(artifactPath)} to ${device.host}:${remotePath} (no auto-start for runtime=${runtime})`,
      raw,
    };
  } catch (e) {
    return { ok: false, deployment_id, message: e && e.message ? e.message : String(e), raw };
  } finally {
    if (conn && typeof conn.disconnect === 'function') {
      try { conn.disconnect(); } catch {} // deliberate: cleanup
    }
  }
}

export default { deploy };
