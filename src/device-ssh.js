// W888-C - Real SSH transport for device fleet operations.
//
// This module is the ssh2-backed SSHConnection class used by the Run surface's
// deploy pipeline (src/deploy-pipeline.js) + on-device testers (src/test-device.js,
// src/test-quants.js). It is intentionally separate from the older
// src/compute/backends/remote-ssh.js (which shells out to the system `ssh`
// binary) because:
//
//   - The deploy pipeline needs SFTP upload + progress callbacks, which the
//     CLI `scp` binary cannot stream into a Node-side progress meter.
//   - Hardware detection runs ~7 commands per session; opening one TCP +
//     reusing it is materially faster than fork/exec'ing ssh 7 times.
//   - We need structured exec results ({stdout, stderr, code}) without piping
//     through a shell - the system-ssh path concatenates env-prefix + command
//     into one shell string, which makes error attribution lossy.
//
// ssh2 is loaded LAZILY (inside .connect()) so `kolm doctor` / `kolm devices
// list` stay fast for users who haven't installed it yet. The lazy import
// also means the rest of the CLI surface keeps working in environments
// (web-only, browser, air-gapped) where ssh2 is absent.
//
// Public shape (matches the W888-C deliverable):
//   const c = new SSHConnection(device);
//   await c.connect();
//   const { stdout, stderr, code } = await c.exec('uname -sr', { timeoutMs: 30_000 });
//   await c.upload('./local.kolm', '/remote/path.kolm', { onProgress });
//   await c.download('/remote/log.txt', './local.log');
//   const hw = await c.detectHardware();
//   const sha = await c.sha256('/remote/path.kolm');
//   c.disconnect();
//
// SECURITY:
//   - Private keys are read from device.connection.key_path (file path), NEVER
//     passed inline as content. The path is read on connect; the key bytes
//     are NOT persisted by this module.
//   - Hosts that look like flags (starts with `-`) are rejected - mirrors
//     the guard in src/device-install.js#_assertSafeSshHost.
//   - Default StrictHostKeyChecking is OFF for hostHash callback ("accept-new"
//     semantics); callers that need stricter pinning pass `hostFingerprint`
//     in the device.connection block and we verify against it.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Lazy ssh2 reference. Resolved on first .connect().
let _ssh2 = null;
async function _loadSsh2() {
  if (_ssh2) return _ssh2;
  try {
    const mod = await import('ssh2');
    _ssh2 = mod.default || mod;
    return _ssh2;
  } catch (e) {
    const err = new Error(
      'ssh2 module not installed. Install with: npm install ssh2\n' +
      'Underlying error: ' + (e && e.message ? e.message : String(e))
    );
    err.code = 'KOLM_E_SSH2_MISSING';
    throw err;
  }
}

function _isSafeHost(host) {
  const s = String(host || '');
  if (!s) return false;
  if (s.startsWith('-')) return false;
  return /^[A-Za-z0-9][A-Za-z0-9_.@:-]*$/.test(s);
}

// W888-C - Take a device record from device-capabilities and normalize the
// connection block. We accept three shapes for compat:
//   - device.connection = { host, user, port, key_path, fingerprint, ...} (W888-C canonical)
//   - device.ssh        = { host, user, port, identity_file, ... }       (W372 legacy)
//   - device.host (plus device.ssh_key)                                  (compute/backends/remote-ssh legacy)
function _normalizeConnection(device) {
  if (!device) {
    const e = new Error('device record required'); e.code = 'KOLM_E_NO_DEVICE'; throw e;
  }
  // Canonical W888-C shape
  if (device.connection && typeof device.connection === 'object') {
    return device.connection;
  }
  if (device.ssh && typeof device.ssh === 'object') {
    return {
      host: device.ssh.host,
      user: device.ssh.user,
      port: device.ssh.port,
      key_path: device.ssh.identity_file || device.ssh.key_path,
      passphrase: device.ssh.passphrase,
      fingerprint: device.ssh.fingerprint,
    };
  }
  if (device.host) {
    return {
      host: device.host,
      user: device.user,
      port: device.port,
      key_path: device.ssh_key || device.key_path,
    };
  }
  const e = new Error('device has no connection block (need device.connection.host or device.ssh.host)');
  e.code = 'KOLM_E_NO_CONNECTION';
  throw e;
}

export class SSHConnection {
  constructor(device) {
    this.device = device;
    this.connection = _normalizeConnection(device);
    this.deviceId = device.device_id || device.id || device.name || 'unknown';
    this._client = null;
    this._connected = false;

    // Validation up-front so a bad device record fails on `new SSHConnection()`
    // instead of much later inside .connect(). This is also what the test
    // suite exercises ("throws clear error for missing key_path").
    if (!this.connection.host) {
      const e = new Error(`device ${this.deviceId}: connection.host is required`);
      e.code = 'KOLM_E_NO_HOST';
      throw e;
    }
    if (!_isSafeHost(this.connection.host)) {
      const e = new Error(`device ${this.deviceId}: connection.host has unsafe characters or starts with '-'`);
      e.code = 'KOLM_E_UNSAFE_HOST';
      throw e;
    }
    if (!this.connection.key_path) {
      const e = new Error(`device ${this.deviceId}: connection.key_path is required (private key file path)`);
      e.code = 'KOLM_E_NO_KEY_PATH';
      throw e;
    }
  }

  // Open the ssh2 client and authenticate. Idempotent - repeat calls return
  // the existing client without re-auth.
  async connect() {
    if (this._connected) return this;
    const ssh2 = await _loadSsh2();

    const { host, user = 'kolm', port = 22, key_path, passphrase, fingerprint } = this.connection;
    if (!fs.existsSync(key_path)) {
      const e = new Error(`device ${this.deviceId}: key file not found at ${key_path}`);
      e.code = 'KOLM_E_KEY_FILE_MISSING';
      throw e;
    }
    const privateKey = fs.readFileSync(key_path);

    const Client = ssh2.Client || (ssh2.default && ssh2.default.Client);
    if (!Client) {
      const e = new Error('ssh2 module exports no Client'); e.code = 'KOLM_E_SSH2_BAD_EXPORTS'; throw e;
    }
    const client = new Client();

    await new Promise((resolve, reject) => {
      const onReady = () => { client.off('error', onError); resolve(); };
      const onError = (err) => {
        client.off('ready', onReady);
        const wrapped = new Error(
          `device ${this.deviceId} unreachable (${host}:${port}): ${err && err.message ? err.message : String(err)}`
        );
        wrapped.code = err && err.code ? err.code : 'KOLM_E_SSH_UNREACHABLE';
        wrapped.cause = err;
        reject(wrapped);
      };
      client.once('ready', onReady);
      client.once('error', onError);
      const cfg = {
        host,
        port: Number(port) || 22,
        username: user,
        privateKey,
        readyTimeout: 10_000,
        keepaliveInterval: 0,
        algorithms: undefined,
      };
      if (passphrase) cfg.passphrase = passphrase;
      if (fingerprint) {
        cfg.hostVerifier = (keyHash) => {
          // keyHash is the SHA-256 of the host key. Compare with the
          // configured fingerprint (case-insensitive, ignore SHA256: prefix).
          const expected = String(fingerprint).replace(/^SHA256:/i, '').toLowerCase();
          const actual = String(keyHash).replace(/^SHA256:/i, '').toLowerCase();
          return expected === actual;
        };
      }
      try {
        client.connect(cfg);
      } catch (e) { onError(e); }
    });
    this._client = client;
    this._connected = true;
    return this;
  }

  // Run a single command. Returns { stdout, stderr, code }. Throws on
  // transport-level failure (broken pipe, ssh dead); a nonzero exit code is
  // RETURNED in `code`, never thrown - callers branch on code !== 0.
  async exec(command, { timeoutMs = 30_000 } = {}) {
    if (!this._connected) await this.connect();
    return await new Promise((resolve, reject) => {
      this._client.exec(command, (err, stream) => {
        if (err) return reject(err);
        let stdout = '';
        let stderr = '';
        let timer = null;
        let settled = false;
        const settle = (val) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          resolve(val);
        };
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            try { stream.close(); } catch {} // deliberate: cleanup
            settle({ stdout, stderr: stderr + `\n[exec timeout after ${timeoutMs}ms]`, code: 124, timed_out: true });
          }, timeoutMs);
        }
        stream.on('data', (d) => { stdout += d.toString('utf8'); });
        stream.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
        stream.on('close', (code, _signal) => {
          settle({ stdout, stderr, code: typeof code === 'number' ? code : 0 });
        });
        stream.on('error', (e) => settle({ stdout, stderr: stderr + '\n' + (e && e.message ? e.message : String(e)), code: 1 }));
      });
    });
  }

  // SFTP upload with optional progress callback. onProgress({bytes, total}).
  async upload(localPath, remotePath, { onProgress } = {}) {
    if (!this._connected) await this.connect();
    if (!fs.existsSync(localPath)) {
      const e = new Error(`local file not found: ${localPath}`);
      e.code = 'KOLM_E_LOCAL_FILE_MISSING';
      throw e;
    }
    const stat = fs.statSync(localPath);
    const total = stat.size;
    return await new Promise((resolve, reject) => {
      this._client.sftp((err, sftp) => {
        if (err) return reject(err);
        const opts = onProgress ? { step: (bytes) => { try { onProgress({ bytes, total }); } catch {} } } : {}; // deliberate: cleanup
        sftp.fastPut(localPath, remotePath, opts, (uerr) => {
          if (uerr) {
            const w = new Error(`sftp upload failed (${remotePath}): ${uerr.message}`);
            w.code = uerr.code || 'KOLM_E_SFTP_UPLOAD';
            return reject(w);
          }
          resolve({ ok: true, bytes: total, remote_path: remotePath });
        });
      });
    });
  }

  // SFTP download.
  async download(remotePath, localPath) {
    if (!this._connected) await this.connect();
    return await new Promise((resolve, reject) => {
      this._client.sftp((err, sftp) => {
        if (err) return reject(err);
        sftp.fastGet(remotePath, localPath, (gerr) => {
          if (gerr) {
            const w = new Error(`sftp download failed (${remotePath}): ${gerr.message}`);
            w.code = gerr.code || 'KOLM_E_SFTP_DOWNLOAD';
            return reject(w);
          }
          const stat = fs.statSync(localPath);
          resolve({ ok: true, bytes: stat.size, local_path: localPath });
        });
      });
    });
  }

  // Compose a hardware snapshot from a handful of common Linux probes. The
  // output shape is the one downstream callers (deploy-pipeline preflight,
  // device-capabilities.detectHardwareRemote) expect.
  async detectHardware() {
    // Each probe runs with a short timeout; failures degrade to nulls (the
    // remote may not have nvidia-smi, /proc/cpuinfo on Mac, etc.).
    const run = async (cmd, timeoutMs = 8_000) => {
      try { return await this.exec(cmd, { timeoutMs }); } catch (e) {
        return { stdout: '', stderr: e && e.message ? e.message : String(e), code: 1 };
      }
    };
    const [nv, cpu, mem, disk, unameSr, unameMa, nvcc] = await Promise.all([
      run('nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap --format=csv,noheader,nounits 2>/dev/null || true'),
      run('cat /proc/cpuinfo 2>/dev/null | head -25 || sysctl -n machdep.cpu.brand_string 2>/dev/null || echo'),
      run('free -m 2>/dev/null | head -2 || vm_stat 2>/dev/null || echo'),
      run('df -m / 2>/dev/null | tail -1 || df -m / 2>/dev/null || echo'),
      run('uname -sr 2>/dev/null || echo'),
      run('uname -m 2>/dev/null || echo'),
      run('nvcc --version 2>/dev/null || true'),
    ]);

    return _parseHardware({ nv, cpu, mem, disk, unameSr, unameMa, nvcc });
  }

  // sha256 a remote file via `sha256sum`. Returns the hex digest (lowercase).
  async sha256(remotePath) {
    const r = await this.exec(`sha256sum ${JSON.stringify(remotePath)}`, { timeoutMs: 60_000 });
    if (r.code !== 0) {
      const e = new Error(`sha256sum failed on ${remotePath}: ${(r.stderr || '').trim()}`);
      e.code = 'KOLM_E_REMOTE_SHA256';
      throw e;
    }
    // Output shape: "<hex>  <path>\n"
    const m = String(r.stdout || '').trim().match(/^([a-fA-F0-9]{64})\b/);
    if (!m) {
      const e = new Error(`sha256sum output unparseable: ${r.stdout.slice(0, 80)}`);
      e.code = 'KOLM_E_REMOTE_SHA256_PARSE';
      throw e;
    }
    return m[1].toLowerCase();
  }

  disconnect() {
    if (!this._client) return;
    try { this._client.end(); } catch {} // deliberate: cleanup
    this._client = null;
    this._connected = false;
  }
}

// Parse the canonical hardware probe outputs into the structured shape.
// Exported so the test suite can drive the parser with fixtures without
// opening a real ssh2 connection.
export function _parseHardware({ nv, cpu, mem, disk, unameSr, unameMa, nvcc }) {
  const out = {
    gpu: null,
    gpu_vram_mb: null,
    driver_version: null,
    compute_capability: null,
    cpu: null,
    cpu_cores: null,
    ram_mb: null,
    disk_free_mb: null,
    os: null,
    arch: null,
    cuda_version: null,
    raw: {},
  };

  // nvidia-smi line: "NVIDIA GeForce RTX 5090, 32607, 535.183.01, 12.0"
  const nvOut = String(nv && nv.stdout || '').trim();
  if (nvOut && !/no devices were found/i.test(nvOut)) {
    const line = nvOut.split(/\r?\n/).find(l => l.trim()) || '';
    const parts = line.split(',').map(s => s.trim());
    if (parts.length >= 2) {
      out.gpu = parts[0] || null;
      const mb = Number(parts[1]);
      if (Number.isFinite(mb) && mb > 0) out.gpu_vram_mb = Math.round(mb);
      if (parts[2]) out.driver_version = parts[2];
      if (parts[3]) out.compute_capability = parts[3];
    }
    out.raw.nvidia_smi = nvOut.slice(0, 256);
  }

  // CPU: /proc/cpuinfo "model name : Intel(R) ...". macOS sysctl returns
  // just the brand string on one line.
  const cpuOut = String(cpu && cpu.stdout || '');
  if (cpuOut.trim()) {
    const linuxModel = (cpuOut.split(/\r?\n/).find(l => /^model name\s*:/.test(l)) || '').split(':')[1];
    if (linuxModel) {
      out.cpu = linuxModel.trim();
    } else {
      // single-line shape (sysctl / echo fallback)
      const first = cpuOut.split(/\r?\n/).find(l => l.trim());
      if (first) out.cpu = first.trim();
    }
    const procCount = (cpuOut.match(/^processor\s*:/gm) || []).length;
    if (procCount > 0) out.cpu_cores = procCount;
  }

  // RAM via `free -m` shape:
  //   "               total        used        free      shared  buff/cache   available"
  //   "Mem:           64111       2034       58723         96       3354      61567"
  const memOut = String(mem && mem.stdout || '');
  const memLine = memOut.split(/\r?\n/).find(l => /^Mem:\s+\d+/.test(l));
  if (memLine) {
    const tokens = memLine.trim().split(/\s+/);
    const total = Number(tokens[1]);
    if (Number.isFinite(total) && total > 0) out.ram_mb = total;
  } else {
    // macOS vm_stat fallback would need page-size math; skip and leave null.
  }

  // df -m / shape: "/dev/nvme0n1p2  945843  287312  610243  33% /"
  const diskOut = String(disk && disk.stdout || '');
  const diskLine = diskOut.split(/\r?\n/).find(l => /\d+/.test(l));
  if (diskLine) {
    const tokens = diskLine.trim().split(/\s+/);
    // Available column is index 3 in standard df -m output on linux.
    const avail = Number(tokens[3]);
    if (Number.isFinite(avail) && avail > 0) out.disk_free_mb = avail;
  }

  out.os = String(unameSr && unameSr.stdout || '').trim() || null;
  out.arch = String(unameMa && unameMa.stdout || '').trim() || null;

  const nvccOut = String(nvcc && nvcc.stdout || '');
  const cudaMatch = nvccOut.match(/release\s+(\d+\.\d+)/i);
  if (cudaMatch) out.cuda_version = cudaMatch[1];

  return out;
}

export default { SSHConnection, _parseHardware };
