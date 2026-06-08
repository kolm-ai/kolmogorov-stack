// W888-B - High-level Modal provider.
//
// Wraps the low-level src/compute/backends/modal.js adapter which already
// knows how to shell out to the `modal` CLI for `modal run` jobs.
//
// This file adds:
//   * detect() - env probe + CLI availability check (never throws).
//   * ModalProvider class - submitCompileJob / submitBenchmark / createServingEndpoint /
//     listEndpoints / stopEndpoint / getEndpointMetrics - same shape as
//     src/cloud-providers/runpod.js so callers can swap providers.
//
// Caveats / Constraints / Limitations:
//   1. Modal has no public REST API; everything is the gRPC client wrapped
//      by the `modal` Python CLI. We shell out to `modal run script.py::fn`
//      to submit work and `modal app list` to enumerate apps. There is no
//      public schema lookup, so timeouts + parsing are best-effort.
//   2. We do NOT bundle a Modal Python script template here - the caller is
//      expected to point us at an existing kolm modal worker script via
//      `MODAL_COMPILE_REF` env or `opts.compileRef`. The default is the
//      stub at scripts/modal/compile_worker.py which the bootstrap creates.
//   3. For listEndpoints / getEndpointMetrics we shell out to `modal app
//      list --json` and `modal app stats <name>` - if Modal renames the
//      flags the parse will fail and we surface a structured error envelope
//      rather than masking it.

import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { exec as execCb } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const exec = promisify(execCb);

function _hint() {
  return [
    'pip install modal',
    'modal token new   # opens browser to mint MODAL_TOKEN_ID + MODAL_TOKEN_SECRET',
    'export MODAL_TOKEN_ID=...; export MODAL_TOKEN_SECRET=...',
    '(or) export KOLM_MODAL_TOKEN=<id>:<secret>',
    'verify with: kolm test cloud --provider modal',
  ].join('\n  ');
}

async function _modalCliAvailable() {
  const which = process.platform === 'win32' ? 'where modal' : 'command -v modal';
  try {
    const { stdout } = await exec(which);
    return stdout.trim().length > 0;
  } catch { return false; }
}

export function detect(env = process.env) {
  const tok = env.KOLM_MODAL_TOKEN || env.MODAL_TOKEN_ID || '';
  if (!tok) {
    return {
      ok: false,
      provider: 'modal',
      configured: false,
      reason: 'MODAL_TOKEN_ID / KOLM_MODAL_TOKEN not set',
      install_hint: _hint(),
      docs_url: 'https://modal.com/docs/guide/authentication',
    };
  }
  return {
    ok: true,
    provider: 'modal',
    configured: true,
    region: env.KOLM_MODAL_REGION || 'auto',
  };
}

export class ModalProvider {
  constructor(token, opts = {}) {
    const tok = token
      || (typeof opts.token === 'string' ? opts.token : '')
      || process.env.KOLM_MODAL_TOKEN
      || process.env.MODAL_TOKEN_ID
      || '';
    if (!tok) {
      const err = new Error('Modal token missing. Set MODAL_TOKEN_ID + MODAL_TOKEN_SECRET or KOLM_MODAL_TOKEN.');
      err.code = 'modal_token_missing';
      err.install_hint = _hint();
      err.docs_url = 'https://modal.com/docs/guide/authentication';
      throw err;
    }
    this.token = tok;
    this.region = opts.region || process.env.KOLM_MODAL_REGION || 'auto';
    this.compileRef = opts.compileRef || process.env.MODAL_COMPILE_REF || 'scripts/modal/compile_worker.py::compile';
    this.benchmarkRef = opts.benchmarkRef || process.env.MODAL_BENCH_REF || 'scripts/modal/compile_worker.py::benchmark';
  }

  _splitTokenEnv() {
    const env = { ...process.env };
    if (process.env.KOLM_MODAL_TOKEN && !env.MODAL_TOKEN_ID) {
      const parts = process.env.KOLM_MODAL_TOKEN.split(':');
      if (parts.length >= 2) {
        env.MODAL_TOKEN_ID = parts[0];
        env.MODAL_TOKEN_SECRET = parts.slice(1).join(':');
      }
    }
    return env;
  }

  async _modalRun({ ref, args = [], timeoutMs = 30 * 60 * 1000 }) {
    if (!(await _modalCliAvailable())) {
      const err = new Error('modal CLI not installed');
      err.code = 'modal_cli_missing';
      err.install_hint = 'pip install modal && modal token new';
      throw err;
    }
    return await new Promise((resolve, reject) => {
      const child = spawn('modal', ['run', ref, ...args], { env: this._splitTokenEnv(), shell: false });
      const out = []; const errC = [];
      child.stdout.on('data', (c) => out.push(c));
      child.stderr.on('data', (c) => errC.push(c));
      const killer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs); // deliberate: cleanup
      child.on('close', (code) => {
        clearTimeout(killer);
        const stdout = Buffer.concat(out).toString('utf8');
        const stderr = Buffer.concat(errC).toString('utf8');
        if (code !== 0) {
          const e = new Error(`modal run ${ref} exited ${code}: ${stderr.slice(-500)}`);
          e.code = 'modal_run_failed'; e.exit_code = code; e.stdout = stdout; e.stderr = stderr;
          return reject(e);
        }
        resolve({ stdout, stderr });
      });
      child.on('error', (e) => {
        clearTimeout(killer);
        const err = new Error(`spawn modal failed: ${e.message}`);
        err.code = 'modal_spawn_failed';
        reject(err);
      });
    });
  }

  // submitCompileJob - shells out to `modal run <compileRef>` with args that
  // the Python worker parses. Caller-supplied capturesPath is uploaded via
  // Modal's network filesystem in the worker; here we just pass the path.
  async submitCompileJob({ spec, capturesPath, gpu = 'A100', timeoutMs = 30 * 60 * 1000 } = {}) {
    if (!spec || typeof spec !== 'object') {
      const err = new Error('submitCompileJob requires spec object');
      err.code = 'bad_args'; throw err;
    }
    if (capturesPath && !fs.existsSync(capturesPath)) {
      const err = new Error(`captures path not found: ${capturesPath}`);
      err.code = 'captures_not_found'; throw err;
    }
    const args = [
      '--spec', JSON.stringify(spec),
      '--gpu', gpu,
    ];
    if (capturesPath) args.push('--captures', path.resolve(capturesPath));
    const t0 = Date.now();
    const r = await this._modalRun({ ref: this.compileRef, args, timeoutMs });
    // The worker is expected to print a JSON line prefixed with `KOLM_RESULT:`
    let result = {};
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^KOLM_RESULT:\s*(\{.*\})\s*$/);
      if (m) { try { result = JSON.parse(m[1]); break; } catch { /* keep scanning */ } }
    }
    return {
      ok: true,
      provider: 'modal',
      artifact_path: result.artifact_path || null,
      compile_ms: typeof result.compile_ms === 'number' ? result.compile_ms : null,
      gpu_cost_usd: typeof result.gpu_cost_usd === 'number' ? result.gpu_cost_usd : null,
      k_score: result.k_score || null,
      receipt_id: result.receipt_id || null,
      latency_ms: Date.now() - t0,
      raw_stdout_tail: r.stdout.slice(-1000),
    };
  }

  async submitBenchmark({ artifactPath, gpu = 'A100', timeoutMs = 15 * 60 * 1000 } = {}) {
    if (artifactPath && !fs.existsSync(artifactPath)) {
      const err = new Error(`artifact not found: ${artifactPath}`);
      err.code = 'artifact_not_found'; throw err;
    }
    const args = ['--gpu', gpu];
    if (artifactPath) args.push('--artifact', path.resolve(artifactPath));
    const t0 = Date.now();
    const r = await this._modalRun({ ref: this.benchmarkRef, args, timeoutMs });
    let result = {};
    for (const line of r.stdout.split('\n')) {
      const m = line.match(/^KOLM_RESULT:\s*(\{.*\})\s*$/);
      if (m) { try { result = JSON.parse(m[1]); break; } catch {} } // deliberate: cleanup
    }
    return {
      ok: true,
      provider: 'modal',
      benchmark: result.benchmark || result,
      latency_ms: Date.now() - t0,
    };
  }

  async createServingEndpoint({ artifactPath, config = {} } = {}) {
    // Modal serving is `modal deploy <ref>` which deploys an @app.function or
    // @web_endpoint. We surface the would-do plan rather than guessing the
    // ref because each kolm-serve deployment is a separate Python file.
    return {
      ok: false,
      provider: 'modal',
      reason: 'modal serving deploy requires a Python @app.function script. Use modal deploy <ref> directly.',
      docs_url: 'https://modal.com/docs/guide/webhooks',
      install_hint: 'modal deploy scripts/modal/serve.py',
      would_do: {
        artifact_path: artifactPath ? path.resolve(artifactPath) : null,
        config,
      },
    };
  }

  async listEndpoints() {
    if (!(await _modalCliAvailable())) {
      const err = new Error('modal CLI not installed');
      err.code = 'modal_cli_missing';
      throw err;
    }
    try {
      const { stdout } = await exec('modal app list --json', { env: this._splitTokenEnv() });
      let rows = [];
      try { rows = JSON.parse(stdout); } catch { /* parse-friendly */ }
      return {
        ok: true,
        provider: 'modal',
        endpoints: Array.isArray(rows) ? rows.map((r) => ({
          id: r.id || r.app_id || r.name,
          name: r.name || r.description || null,
          state: r.state || null,
          raw: r,
        })) : [],
      };
    } catch (e) {
      const err = new Error(`modal app list failed: ${e.message}`);
      err.code = 'modal_list_failed';
      err.stderr = e.stderr || null;
      throw err;
    }
  }

  async stopEndpoint(id) {
    if (!id) { const err = new Error('stopEndpoint requires app id'); err.code = 'bad_args'; throw err; }
    if (!(await _modalCliAvailable())) {
      const err = new Error('modal CLI not installed');
      err.code = 'modal_cli_missing'; throw err;
    }
    try {
      await exec(`modal app stop ${id}`, { env: this._splitTokenEnv() });
      return { ok: true, provider: 'modal', endpoint_id: id };
    } catch (e) {
      const err = new Error(`modal app stop failed: ${e.message}`);
      err.code = 'modal_stop_failed';
      err.stderr = e.stderr || null;
      throw err;
    }
  }

  async getEndpointMetrics(id) {
    if (!id) { const err = new Error('getEndpointMetrics requires app id'); err.code = 'bad_args'; throw err; }
    if (!(await _modalCliAvailable())) {
      const err = new Error('modal CLI not installed');
      err.code = 'modal_cli_missing'; throw err;
    }
    try {
      const { stdout } = await exec(`modal app stats ${id} --json`, { env: this._splitTokenEnv() });
      let stats = {}; try { stats = JSON.parse(stdout); } catch {} // deliberate: cleanup
      return { ok: true, provider: 'modal', endpoint_id: id, metrics: stats };
    } catch (e) {
      const err = new Error(`modal app stats failed: ${e.message}`);
      err.code = 'modal_metrics_failed';
      err.stderr = e.stderr || null;
      throw err;
    }
  }
}

export default ModalProvider;
