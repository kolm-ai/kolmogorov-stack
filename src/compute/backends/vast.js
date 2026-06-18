// vast - Vast.ai marketplace (GPU rentals via SSH, no managed job queue).
// API: https://console.vast.ai/api/v0 (instances, ask_offers, asks)
// Env: KOLM_VAST_TOKEN (or VAST_API_KEY) + SSH key. run() lists instances or
// honestly returns a handle - vast.ai has no programmatic exec API.

import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';

export const VAST_BACKEND_CONTRACT_VERSION = 'w789-vast-backend-v1';
export const VAST_BACKEND_LIMITS = Object.freeze({
  max_error_chars: 500,
  max_stdout_chars: 2 * 1024 * 1024,
  max_instances: 200,
  max_command_args: 64,
  max_command_arg_chars: 512,
  max_host_chars: 255,
});

const HOST = 'console.vast.ai';
const SAFE_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;

function _token() {
  return String(process.env.KOLM_VAST_TOKEN || process.env.VAST_API_KEY || '').trim();
}

function _sha256(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function _redactText(value, limit = VAST_BACKEND_LIMITS.max_error_chars) {
  return String(value || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, '[redacted-email]')
    .replace(/\b(api[_-]?key|token|secret|password)\b\s*[:=]\s*[^,\s"'}]+/ig, '$1=[redacted]')
    .replace(/api_key=[^&\s"'}]+/ig, 'api_key=[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/ig, 'Bearer [redacted]')
    .slice(0, limit);
}

function _failure(reason, extra = {}) {
  return {
    ok: false,
    contract_version: VAST_BACKEND_CONTRACT_VERSION,
    secret_values_included: false,
    reason,
    ...extra,
  };
}

function _providerFailure(reason, text, extra = {}) {
  return _failure(reason, {
    exit_code: 1,
    stderr: _redactText(text),
    error_sha256: _sha256(text),
    ...extra,
  });
}

function _sshKeyPath() {
  return process.env.KOLM_VAST_SSH_KEY || path.join(os.homedir(), '.ssh', 'id_ed25519');
}

function _safeHost(value) {
  const host = String(value || '').trim();
  if (!host || host.length > VAST_BACKEND_LIMITS.max_host_chars || !SAFE_HOST_RE.test(host)) return null;
  if (host.includes('..') || host.endsWith('.')) return null;
  return host;
}

function _safePort(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return n;
}

function _quoteArg(value) {
  const arg = String(value || '').slice(0, VAST_BACKEND_LIMITS.max_command_arg_chars);
  return `'${arg.replace(/'/g, `'\"'\"'`)}'`;
}

function _normalizeCommand(command = []) {
  const args = Array.isArray(command) ? command : [String(command || '')];
  return args.slice(0, VAST_BACKEND_LIMITS.max_command_args).map(_quoteArg).join(' ');
}

function _capText(value, limit = VAST_BACKEND_LIMITS.max_stdout_chars) {
  return String(value || '').slice(0, limit);
}

export async function detect() {
  if (!_token()) {
    return {
      available: false,
      reason: 'KOLM_VAST_TOKEN env var not set',
      contract_version: VAST_BACKEND_CONTRACT_VERSION,
      secret_values_included: false,
    };
  }
  const sshKey = _sshKeyPath();
  if (!fs.existsSync(sshKey)) {
    return {
      available: false,
      reason: 'SSH key not found',
      ssh_key_sha256: _sha256(sshKey),
      contract_version: VAST_BACKEND_CONTRACT_VERSION,
      secret_values_included: false,
    };
  }
  return {
    available: true,
    device: 'vast-ssh',
    endpoint: 'https://console.vast.ai/api/v0',
    contract_version: VAST_BACKEND_CONTRACT_VERSION,
    secret_values_included: false,
  };
}

export async function test() {
  const t0 = Date.now();
  const d = await detect();
  return { ok: d.available, latency_ms: Date.now() - t0, ...d };
}

function _req(method, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const req = https.request({
      method,
      host: HOST,
      path: pathname,
      headers: { ...(headers || {}), ...(data ? { 'Content-Length': data.length } : {}) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// vast.ai is a rental marketplace, not a job queue. With no command, list
// the user's running instances. With a command + VAST_PROVISION=1, the
// honest path is: the user must already have an instance + SSH to it. We
// surface the instance list so the caller can pick one to SSH into.
export async function run({
  command = [],
  request = _req,
  now = () => Date.now(),
} = {}) {
  const t0 = now();
  const tok = _token();
  if (!tok) {
    return _failure('KOLM_VAST_TOKEN not set', {
      next_step: 'export KOLM_VAST_TOKEN=...; see https://console.vast.ai/account/',
    });
  }
  if (/[\r\n]/.test(tok)) return _failure('invalid KOLM_VAST_TOKEN');

  const headers = { 'Content-Type': 'application/json' };
  let r;
  try {
    r = await request('GET', `/api/v0/instances?api_key=${encodeURIComponent(tok)}`, headers);
  } catch (e) {
    return _failure('instances fetch failed', {
      error_sha256: _sha256(e && e.message || e),
      latency_ms: now() - t0,
    });
  }
  if (r.status >= 400) {
    return _providerFailure(`vast ${r.status}`, r.text, { latency_ms: now() - t0 });
  }

  if (!command || command.length === 0) {
    const stdout = _capText(r.text);
    return {
      ok: true,
      contract_version: VAST_BACKEND_CONTRACT_VERSION,
      secret_values_included: false,
      exit_code: 0,
      stdout,
      stdout_truncated: stdout.length < String(r.text || '').length,
      stderr: '',
      artifact_url: `https://${HOST}/api/v0/instances`,
      latency_ms: now() - t0,
      mode: 'list-instances',
      next_step: 'ssh root@<ssh_host> -p <ssh_port> -i ~/.ssh/id_ed25519 from /instances response',
    };
  }

  let inst;
  try {
    inst = JSON.parse(r.text);
  } catch {
    return _providerFailure('vast instances response was not JSON', r.text, { latency_ms: now() - t0 });
  }
  const rows = Array.isArray(inst.instances) ? inst.instances.slice(0, VAST_BACKEND_LIMITS.max_instances) : [];
  const cmd = _normalizeCommand(command);
  const ssh = rows
    .filter((row) => row && row.actual_status === 'running')
    .map((row) => ({ host: _safeHost(row.ssh_host), port: _safePort(row.ssh_port) }))
    .filter((row) => row.host && row.port)
    .map((row) => `ssh -p ${row.port} root@${row.host} ${cmd}`);

  return {
    ok: ssh.length > 0,
    contract_version: VAST_BACKEND_CONTRACT_VERSION,
    secret_values_included: false,
    exit_code: ssh.length > 0 ? 0 : 1,
    stdout: ssh.join('\n'),
    stderr: ssh.length === 0 ? `no running instances (have ${rows.length} total)` : '',
    artifact_url: `https://${HOST}/api/v0/instances`,
    latency_ms: now() - t0,
    mode: 'ssh-handles',
    instance_count: rows.length,
    ssh_handle_count: ssh.length,
    next_step: 'vast.ai has no exec API - copy one ssh line and run it manually',
  };
}

export default { detect, test, run };
