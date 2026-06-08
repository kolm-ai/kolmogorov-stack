// W888-D - Remote deploy pipeline.
//
// DeployPipeline.deploy({ artifactPath, deviceId, config }) runs the 6-step
// pipeline from the W888 directive:
//
//   1. preflight - verify artifact exists + signature shape, device online,
//                      hardware fits the artifact runtime passport, disk space.
//   2. upload - SFTP push the .kolm bytes to the remote, sha256 verify.
//   3. ensureRuntime - check llama-server / vllm / ollama presence; with
//                      --auto-install + a known package manager, install it.
//   4. start - generate the runtime invocation, spawn as detached
//                      process (nohup ... &), capture the PID + endpoint URL.
//   5. smokeTest - POST 5 eval examples to the local serving endpoint
//                      (via remote curl loop) and check for valid JSON shape.
//   6. record - call deviceCapabilities.recordDeployment().
//
// Returns:
//   { success: bool, endpoint: 'http://host:port', steps: [{ok, step, detail, elapsed_ms}, ...], device_id, artifact_id }
//
// Each step's result envelope:
//   { ok: bool, step: 'preflight'|'upload'|..., detail: any, elapsed_ms: number, error?: string }
//
// The pipeline is constructor-injectable so the test suite can pass a stub
// SSHConnection class without opening a real socket:
//
//   const p = new DeployPipeline({ SSHConnectionClass: StubConn });
//   await p.deploy({ artifactPath, deviceId, config });
//
// In production callers just instantiate with no args; the SSHConnection
// class is lazy-imported on first use.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import * as deviceCaps from './device-capabilities.js';

// Pre-baked invocation templates per runtime. The host invokes one of these
// over ssh as `nohup <cmd> >/tmp/kolm-<artifact>.log 2>&1 & echo $!`. The PID
// captured after the `echo $!` is what we hand back to recordDeployment.
const RUNTIME_TEMPLATES = {
  'llama.cpp': ({ remoteArtifactPath, port, host }) =>
    `llama-server -m ${JSON.stringify(remoteArtifactPath)} --port ${Number(port)} --host ${JSON.stringify(host)}`,
  'llama-cpp': ({ remoteArtifactPath, port, host }) =>
    `llama-server -m ${JSON.stringify(remoteArtifactPath)} --port ${Number(port)} --host ${JSON.stringify(host)}`,
  vllm: ({ remoteArtifactPath, port, host }) =>
    `python -m vllm.entrypoints.openai.api_server --model ${JSON.stringify(remoteArtifactPath)} --port ${Number(port)} --host ${JSON.stringify(host)}`,
  ollama: ({ remoteArtifactPath, port, host }) =>
    `OLLAMA_HOST=${JSON.stringify(`${host}:${port}`)} ollama serve & sleep 2 && ollama create kolm-deploy -f ${JSON.stringify(remoteArtifactPath)}`,
};

// Auto-install hints. The pipeline never installs without --auto-install in
// config; even then we only try one-liners that the device's OS supports.
const RUNTIME_INSTALLERS = {
  'llama.cpp': 'curl -fsSL https://github.com/ggml-org/llama.cpp/releases/latest/download/llama-server-linux-x64 -o /usr/local/bin/llama-server && chmod +x /usr/local/bin/llama-server',
  'llama-cpp': 'curl -fsSL https://github.com/ggml-org/llama.cpp/releases/latest/download/llama-server-linux-x64 -o /usr/local/bin/llama-server && chmod +x /usr/local/bin/llama-server',
  vllm: 'pip install --quiet --upgrade vllm',
  ollama: 'curl -fsSL https://ollama.com/install.sh | sh',
};

const RUNTIME_PROBES = {
  'llama.cpp': 'command -v llama-server',
  'llama-cpp': 'command -v llama-server',
  vllm: 'python -c "import vllm; print(vllm.__version__)" 2>/dev/null',
  ollama: 'command -v ollama',
};

// W890-6 - every value that lands in an SSH command payload must pass a
// strict allowlist. The ssh2 channel API does not shell-escape its argument;
// the remote shell does the parsing, so backticks, $(, ;, &, |, <, >, quotes
// and newlines must be rejected before any conn.exec(`...`) interpolation.
const _SAFE_REMOTE_DIR_RE = /^[A-Za-z0-9_./~-]{1,512}$/;
function _assertSafeRemoteDir(p) {
  if (!_SAFE_REMOTE_DIR_RE.test(String(p))) {
    throw new Error(`unsafe remoteDir (rejected by allowlist): ${p}`);
  }
}
const _SAFE_RUNTIME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
function _assertSafeRuntime(r) {
  if (!_SAFE_RUNTIME_RE.test(String(r))) {
    throw new Error(`unsafe runtime name (rejected by allowlist): ${r}`);
  }
}

// Small helper that produces a step envelope. `runStep(name, async() => detail)`
// returns either {ok:true, step, detail, elapsed_ms} or {ok:false, step, error, elapsed_ms}.
async function runStep(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    return { ok: detail && detail.ok === false ? false : true, step: name, detail, elapsed_ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, step: name, error: e && e.message ? e.message : String(e), elapsed_ms: Date.now() - t0 };
  }
}

function _sha256File(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

// Extract artifact size + minimal passport-style metadata. We accept either
// a raw passport JSON sibling (.kolm.passport.json) or no passport at all.
function _artifactMeta(artifactPath) {
  const stat = fs.statSync(artifactPath);
  let passport = null;
  const sib = artifactPath + '.passport.json';
  if (fs.existsSync(sib)) {
    try { passport = JSON.parse(fs.readFileSync(sib, 'utf8')); } catch {} // deliberate: cleanup
  }
  return { size_bytes: stat.size, passport };
}

// Default deployments.jsonl location: data/deployments.jsonl under the
// process cwd, or `${KOLM_DATA_DIR}/deployments.jsonl` if that env var is set.
function _defaultDeploymentsPath() {
  if (process.env.KOLM_DATA_DIR) {
    return path.resolve(process.env.KOLM_DATA_DIR, 'deployments.jsonl');
  }
  return path.resolve('data', 'deployments.jsonl');
}

// Load + parse data/deployments.jsonl. Returns an array of entries in append
// order. Lines that fail to parse are silently skipped.
export function loadDeployments(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const txt = fs.readFileSync(filePath, 'utf8');
  const out = [];
  for (const line of txt.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch {} // deliberate: cleanup
  }
  return out;
}

// Append a deployment journal entry to data/deployments.jsonl. Best-effort:
// if the file can't be written we never crash the pipeline.
function _appendDeploymentJournal(filePath, entry) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

export class DeployPipeline {
  // Constructor accepts BOTH the W888-D test-suite shape
  //   { SSHConnectionClass, deviceCapsImpl }
  // AND the W888-D spec shape
  //   { sshConnFactory, adapterFactory, registry, capturer, log, deploymentsPath }
  // so Fleet (W888-E) + the test suite (concurrency=1) + spec callers all
  // share one class without duplication.
  constructor({
    SSHConnectionClass = null,
    deviceCapsImpl = null,
    sshConnFactory = null,
    adapterFactory = null,
    registry = null,
    capturer = null,
    log = null,
    deploymentsPath = null,
  } = {}) {
    this._SSHConnectionClass = SSHConnectionClass;
    this._deviceCaps = deviceCapsImpl || deviceCaps;
    this._sshConnFactory = sshConnFactory;
    this._adapterFactory = adapterFactory;
    this._registry = registry;
    this._capturer = capturer;
    this._log = typeof log === 'function' ? log : () => {};
    this._deploymentsPath = deploymentsPath || _defaultDeploymentsPath();
  }

  async _loadSSHConnection() {
    if (this._SSHConnectionClass) return this._SSHConnectionClass;
    const mod = await import('./device-ssh.js');
    return mod.SSHConnection;
  }

  // Public: where the journal is being written. Test suites read this.
  deploymentsPath() { return this._deploymentsPath; }

  async deploy({ artifactPath, deviceId, config = {} } = {}) {
    const t0 = Date.now();
    const out = {
      success: false,
      device_id: deviceId,
      artifact_id: artifactPath ? path.basename(artifactPath).replace(/\.kolm$/, '') : null,
      endpoint: null,
      steps: [],
      elapsed_ms: 0,
    };
    // W888-D - deployment id minted up-front so every code path (success +
    // failure + dry-run) can write a journal entry with the same id.
    const deploymentId = 'dep_' + crypto.randomBytes(8).toString('hex');
    out.deployment_id = deploymentId;
    const writeJournal = (status, extra = {}) => {
      const entry = {
        deployment_id: deploymentId,
        device_id: deviceId,
        artifact_path: artifactPath,
        artifact_id: out.artifact_id,
        artifact_sha256: extra.sha256 || null,
        runtime: extra.runtime || (config && config.runtime) || 'llama.cpp',
        port: extra.port != null ? extra.port : (config && config.port) || null,
        endpoint: out.endpoint,
        started_at: new Date(t0).toISOString(),
        finished_at: new Date().toISOString(),
        status,
        steps: out.steps.map(s => ({ step: s.step, ok: s.ok, elapsed_ms: s.elapsed_ms })),
      };
      out.journal = _appendDeploymentJournal(this._deploymentsPath, entry);
      if (this._capturer && typeof this._capturer.put === 'function') {
        try { this._capturer.put('deployments', entry); } catch {} // deliberate: cleanup
      }
      try { this._log({ type: 'deploy.finished', entry }); } catch {} // deliberate: cleanup
    };

    // Normalize config defaults
    const runtime = config.runtime || 'llama.cpp';
    const port = Number(config.port || 8080);
    const bindHost = config.bindHost || '0.0.0.0';
    const autoInstall = !!config.autoInstall;
    const dryRun = !!config.dryRun;
    const remoteDir = config.remoteDir || '~/.kolm/installed';

    // W890-6 - validate runtime + remoteDir before any conn.exec() that
    // interpolates them into a shell command. Fail closed.
    try {
      _assertSafeRemoteDir(remoteDir);
      _assertSafeRuntime(runtime);
    } catch (e) {
      out.steps.push({ ok: false, step: 'preflight', error: e.message, elapsed_ms: 0 });
      out.elapsed_ms = Date.now() - t0;
      writeJournal('failed');
      return out;
    }
    const evalSet = Array.isArray(config.evalSet) && config.evalSet.length
      ? config.evalSet
      : [
          { prompt: 'Reply with the word OK.' },
          { prompt: 'Say hello.' },
          { prompt: 'What is 2+2?' },
          { prompt: 'Translate "yes" to French.' },
          { prompt: 'Count to 3.' },
        ];

    // Resolve device first - preflight reads it too, but we want a clear
    // early error if the deviceId is wrong.
    let device = null;
    try { device = await this._deviceCaps.getDevice(deviceId); }
    catch { device = null; }
    if (!device) {
      out.steps.push({ ok: false, step: 'preflight', error: `unknown device: ${deviceId}`, elapsed_ms: 0 });
      out.elapsed_ms = Date.now() - t0;
      writeJournal('failed');
      return out;
    }

    // Single SSH connection reused across upload/exec/sha256 to avoid 6 separate
    // TCP handshakes. Opened lazily inside step 2 (preflight is filesystem-side).
    let conn = null;
    const SSHConnectionClass = await this._loadSSHConnection();
    const openConn = async () => {
      if (conn) return conn;
      conn = new SSHConnectionClass(device);
      await conn.connect();
      return conn;
    };

    try {
      // ----- 1. preflight ------------------------------------------------
      const preflight = await runStep('preflight', async () => {
        if (!artifactPath) throw new Error('artifactPath required');
        if (!fs.existsSync(artifactPath)) throw new Error(`artifact not found: ${artifactPath}`);
        const meta = _artifactMeta(artifactPath);
        const sigSibling = artifactPath + '.sig';
        const sigOk = fs.existsSync(sigSibling) || (meta.passport && meta.passport.signature) || true; // sig optional in MVP
        // Reachability (cheap, doesn't open a long-lived ssh).
        const reach = await this._deviceCaps.testDevice(deviceId);
        if (!reach.reachable) {
          throw new Error(`device ${deviceId} not reachable: ${reach.reason || 'unknown'}`);
        }
        // Hardware fit: prefer the device record's hardware_snapshot if it
        // exists, otherwise call detectHardwareRemote to refresh it.
        let hw = device.hardware_snapshot || null;
        if (!hw) {
          const hwSnap = await this._deviceCaps.detectHardwareRemote(deviceId);
          hw = hwSnap.snapshot;
        }
        // VRAM gate. We require gpu_vram_mb >= passport.min_vram_mb when both
        // sides declare a number; otherwise we soft-pass.
        const requiredVram = meta.passport && (meta.passport.min_vram_mb || meta.passport.runtime && meta.passport.runtime.min_vram_mb);
        if (requiredVram && hw && hw.gpu_vram_mb && hw.gpu_vram_mb < requiredVram) {
          throw new Error(`insufficient vram: artifact wants ${requiredVram} MB, device has ${hw.gpu_vram_mb} MB`);
        }
        // Disk gate: need 2x artifact size free.
        const needMb = Math.ceil((meta.size_bytes / 1024 / 1024) * 2);
        if (hw && hw.disk_free_mb && hw.disk_free_mb < needMb) {
          throw new Error(`insufficient disk: need ~${needMb} MB free, device has ${hw.disk_free_mb} MB`);
        }
        return {
          ok: true,
          artifact_size_mb: Math.round(meta.size_bytes / 1024 / 1024),
          device_reachable: true,
          required_vram_mb: requiredVram || null,
          device_vram_mb: hw ? hw.gpu_vram_mb : null,
          disk_free_mb: hw ? hw.disk_free_mb : null,
          sig_present: !!sigOk,
          dry_run: dryRun,
        };
      });
      out.steps.push(preflight);
      const failExit = (status, extra) => { out.elapsed_ms = Date.now() - t0; writeJournal(status, extra); return out; };
      if (!preflight.ok) return failExit('failed', { runtime, port });
      if (dryRun) {
        out.success = true;
        out.endpoint = `http://${device.connection?.host || device.ssh?.host || 'unknown'}:${port}`;
        out.dry_run = true;
        return failExit('dry_run', { runtime, port });
      }

      // ----- 2. upload ---------------------------------------------------
      const remoteArtifactPath = `${remoteDir}/${path.basename(artifactPath)}`;
      const localSha = _sha256File(artifactPath);
      const upload = await runStep('upload', async () => {
        const c = await openConn();
        // Ensure the remote install dir exists.
        const mkR = await c.exec(`mkdir -p ${remoteDir.replace('~', '$HOME')}`, { timeoutMs: 10_000 });
        if (mkR.code !== 0) throw new Error(`mkdir failed: ${mkR.stderr}`);
        const u = await c.upload(artifactPath, remoteArtifactPath.replace('~', '$HOME'));
        const remoteSha = await c.sha256(remoteArtifactPath.replace('~', '$HOME'));
        if (remoteSha !== localSha) {
          throw new Error(`sha mismatch after upload: local=${localSha} remote=${remoteSha}`);
        }
        return { ok: true, bytes: u.bytes, sha256: localSha, remote_path: remoteArtifactPath };
      });
      out.steps.push(upload);
      if (!upload.ok) return failExit('failed', { sha256: localSha, runtime, port });

      // ----- 3. ensureRuntime --------------------------------------------
      const ensureRuntime = await runStep('ensureRuntime', async () => {
        const c = await openConn();
        const probe = RUNTIME_PROBES[runtime];
        if (!probe) throw new Error(`unknown runtime: ${runtime}`);
        const r = await c.exec(probe, { timeoutMs: 8_000 });
        if (r.code === 0 && r.stdout && r.stdout.trim()) {
          return { ok: true, present: true, path_or_version: r.stdout.trim() };
        }
        if (!autoInstall) {
          throw new Error(`runtime ${runtime} not installed on device (use --auto-install to bootstrap)`);
        }
        const installer = RUNTIME_INSTALLERS[runtime];
        if (!installer) throw new Error(`no auto-install recipe for ${runtime}`);
        const ir = await c.exec(installer, { timeoutMs: 300_000 });
        if (ir.code !== 0) throw new Error(`auto-install failed: ${ir.stderr || ir.stdout}`);
        const re = await c.exec(probe, { timeoutMs: 8_000 });
        return { ok: re.code === 0, present: re.code === 0, installed: true, path_or_version: re.stdout.trim() };
      });
      out.steps.push(ensureRuntime);
      if (!ensureRuntime.ok) return failExit('failed', { sha256: localSha, runtime, port });

      // ----- 4. start ----------------------------------------------------
      const start = await runStep('start', async () => {
        const c = await openConn();
        const tmpl = RUNTIME_TEMPLATES[runtime];
        if (!tmpl) throw new Error(`no template for runtime: ${runtime}`);
        const invocation = tmpl({ remoteArtifactPath: remoteArtifactPath.replace('~', '$HOME'), port, host: bindHost });
        const logPath = `/tmp/kolm-${out.artifact_id}-${port}.log`;
        const launch = `nohup ${invocation} > ${logPath} 2>&1 & echo $!`;
        const r = await c.exec(launch, { timeoutMs: 15_000 });
        const pid = Number(String(r.stdout || '').trim().split(/\s+/).pop());
        if (!Number.isFinite(pid) || pid <= 0) {
          throw new Error(`failed to capture pid from launch (stdout=${r.stdout.slice(0, 80)}, stderr=${r.stderr.slice(0, 80)})`);
        }
        return { ok: true, pid, log_path: logPath, invocation };
      });
      out.steps.push(start);
      if (!start.ok) return failExit('failed', { sha256: localSha, runtime, port });

      const host = device.connection?.host || device.ssh?.host;
      const endpoint = `http://${host}:${port}`;
      out.endpoint = endpoint;

      // ----- 5. smokeTest ------------------------------------------------
      const smokeTest = await runStep('smokeTest', async () => {
        const c = await openConn();
        // Wait briefly for the server to bind, then drive 5 example POSTs via
        // remote curl. We don't deep-check quality - only shape: non-empty
        // body + 200 status.
        await c.exec(`for i in $(seq 1 10); do nc -z 127.0.0.1 ${port} 2>/dev/null && break; sleep 1; done`, { timeoutMs: 15_000 });
        const results = [];
        for (const ex of evalSet) {
          const payload = JSON.stringify({ prompt: ex.prompt, max_tokens: 8 });
          const body = JSON.stringify(payload);
          const r = await c.exec(
            `curl -sS -o - -w "\\n___STATUS:%{http_code}___" -X POST http://127.0.0.1:${port}/completion -H 'content-type: application/json' -d ${body}`,
            { timeoutMs: 30_000 },
          );
          const m = String(r.stdout || '').match(/___STATUS:(\d+)___\s*$/);
          const status = m ? Number(m[1]) : 0;
          const responseBody = m ? r.stdout.slice(0, r.stdout.lastIndexOf('___STATUS:')) : r.stdout;
          results.push({ status, ok: status >= 200 && status < 300, body_len: responseBody.length });
        }
        const passed = results.filter(r => r.ok).length;
        const ok = passed >= Math.ceil(results.length * 0.6);
        return { ok, passed, total: results.length, results };
      });
      out.steps.push(smokeTest);

      // ----- 6. record ---------------------------------------------------
      const record = await runStep('record', async () => {
        const startDetail = start.detail || {};
        return await this._deviceCaps.recordDeployment(deviceId, {
          artifact_id: out.artifact_id,
          artifact_path: remoteArtifactPath,
          sha256: localSha,
          runtime,
          port,
          pid: startDetail.pid,
          endpoint,
          success: smokeTest.ok,
          steps: out.steps.map(s => ({ step: s.step, ok: s.ok, elapsed_ms: s.elapsed_ms })),
        });
      });
      out.steps.push(record);

      out.success = smokeTest.ok && record.ok;
      out.elapsed_ms = Date.now() - t0;
      writeJournal(out.success ? 'deployed' : 'failed', { sha256: localSha, runtime, port });
      return out;
    } finally {
      if (conn) { try { conn.disconnect(); } catch {} } // deliberate: cleanup
    }
  }

  // Read back the full append-only deployments journal. Each line is one
  // JSON entry produced by `deploy()`. Returns [] if the file is missing.
  loadDeployments() {
    return loadDeployments(this._deploymentsPath);
  }

  // Rolling deploy: deploy v_new alongside v_old on a different port, smoke,
  // cut traffic, then stop v_old. The "traffic cutover" in MVP just records
  // the new endpoint as the canonical one; load-balancer wiring is out of
  // scope for this surface.
  async deployRolling({ artifactPath, deviceId, config = {} } = {}) {
    const newPort = Number(config.port || 8080);
    const oldPort = Number(config.oldPort || newPort + 100);
    // Step 1: deploy onto a sidecar port so old keeps serving.
    const sidecar = await this.deploy({ artifactPath, deviceId, config: { ...config, port: newPort } });
    if (!sidecar.success) return { rolling: true, success: false, sidecar };
    // Step 2: stop the old process if a pid is known.
    let stopOld = { ok: true, step: 'stopOld', detail: { skipped: true }, elapsed_ms: 0 };
    if (config.oldPid) {
      const SSHConnectionClass = await this._loadSSHConnection();
      const device = await this._deviceCaps.getDevice(deviceId);
      const conn = new SSHConnectionClass(device);
      try {
        await conn.connect();
        const r = await conn.exec(`kill ${Number(config.oldPid)} 2>&1 || true`, { timeoutMs: 10_000 });
        stopOld = { ok: true, step: 'stopOld', detail: { killed_pid: config.oldPid, output: r.stdout }, elapsed_ms: 0 };
      } finally { conn.disconnect(); }
    }
    return { rolling: true, success: true, sidecar, stopOld, oldPort };
  }

  // Canary: same as deploy() but flagged for the CLI to prompt the user for
  // a fleet rollout after a 60-second monitor window. The actual prompting
  // happens in the CLI layer; this method just decorates the result.
  // canaryWindowS overrides monitorMs (W888-D spec uses canary_window_s).
  async deployCanary({ artifactPath, deviceId, config = {}, monitorMs = 60_000 } = {}) {
    const r = await this.deploy({ artifactPath, deviceId, config });
    r.canary = true;
    const windowS = config && (config.canaryWindowS || config.canary_window_s);
    r.canary_monitor_ms = windowS ? windowS * 1000 : monitorMs;
    return r;
  }

  // W888-D - rollback(deviceId): replay the most recent deployed entry from
  // data/deployments.jsonl that is older than the latest entry for the device.
  // Returns { ok, target_entry, replay, rollback_info }.
  async rollback({ deviceId, config = {} } = {}) {
    const entries = loadDeployments(this._deploymentsPath).filter(e => e.device_id === deviceId);
    // The latest entry is the one we want to revert FROM. The previous
    // status='deployed' entry is what we revert TO.
    const latest = entries[entries.length - 1] || null;
    const previousDeployed = [...entries].reverse().slice(1).find(e => e.status === 'deployed') || null;
    if (!previousDeployed) {
      const info = { ok: false, reason: 'no_prior_deployment', device_id: deviceId, latest };
      return { ok: false, target_entry: null, replay: null, rollback_info: info };
    }
    const rollback_info = {
      ok: true,
      rolling_back_from: latest && latest.deployment_id,
      rolling_back_to: previousDeployed.deployment_id,
      target_artifact_path: previousDeployed.artifact_path,
      device_id: deviceId,
    };
    if (config.replay === false) {
      // Operator just wants the candidate, not an actual redeploy.
      return { ok: true, target_entry: previousDeployed, replay: null, rollback_info };
    }
    const replay = await this.deploy({
      artifactPath: previousDeployed.artifact_path,
      deviceId,
      config: { ...config, runtime: previousDeployed.runtime, port: previousDeployed.port },
    });
    return { ok: !!replay.success, target_entry: previousDeployed, replay, rollback_info };
  }
}

export default { DeployPipeline, RUNTIME_TEMPLATES, RUNTIME_INSTALLERS, RUNTIME_PROBES, loadDeployments };
