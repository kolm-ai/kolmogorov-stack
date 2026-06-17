// @kolm/langchain - LangChain adapter for kolm.ai compiled artifacts.
//
// Two transport modes:
//   1. subprocess: spawn `kolm run <artifactPath>` and pipe the prompt to stdin.
//   2. http: POST {prompt} to `${baseUrl}/v1/run/<artifact>` with Bearer apiKey.
//
// The receipt chain (cid, recipe_class, k_score, audit_id) returned by the
// runtime is preserved on the response object and surfaced to LangChain via
// the standard `generationInfo` metadata channel.
//
// Peer dep: langchain (>=0.1.0). The class extends LLM from @langchain/core
// when present; otherwise it falls back to a minimal compatible shape so the
// adapter can be unit-tested without LangChain installed.

import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';

// Try to resolve the real LangChain LLM base. Pure best-effort: this keeps the
// adapter unit-testable in a tree with no LangChain installed.
let BaseLLM;
try {
  // eslint-disable-next-line import/no-unresolved
  const mod = await import('@langchain/core/language_models/llms');
  BaseLLM = mod.LLM || mod.BaseLLM;
} catch (_) {
  // Minimal stand-in: matches the surface LangChain expects (constructor +
  // _call + _llmType) so the adapter behaves identically in both contexts.
  BaseLLM = class StandinLLM {
    constructor(fields = {}) { Object.assign(this, fields); }
    async call(prompt, opts) { return this._call(prompt, opts || {}); }
  };
}

const DEFAULT_KOLM_BIN = 'kolm';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_STDERR_CHARS = 8192;

function requirePrompt(prompt) {
  if (typeof prompt !== 'string') {
    throw new Error('KolmLLM: prompt must be a string');
  }
  return prompt;
}

function normalizeTimeoutMs(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_TIMEOUT_MS;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.floor(n);
}

function normalizeBaseUrl(value) {
  if (!value) return null;
  let url;
  try {
    url = new URL(String(value));
  } catch (_) {
    throw new Error('KolmLLM: baseUrl must be a valid http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('KolmLLM: baseUrl must use http or https');
  }
  if (url.username || url.password) {
    throw new Error('KolmLLM: baseUrl must not include credentials');
  }
  url.hash = '';
  url.search = '';
  return url.toString().replace(/\/+$/, '');
}

function requireSubprocessArtifact(value) {
  const artifact = String(value || '').trim();
  if (!artifact) throw new Error('KolmLLM: artifactPath is required for subprocess mode');
  if (artifact.length > 2048 || /[\x00-\x1f\x7f]/.test(artifact)) {
    throw new Error('KolmLLM: artifactPath contains invalid characters');
  }
  return artifact;
}

function requireHttpArtifact(value) {
  const artifact = String(value || 'default').trim();
  if (!artifact) throw new Error('KolmLLM: artifactPath must not be empty');
  if (artifact.length > 512 || /[\x00-\x1f\x7f]/.test(artifact)) {
    throw new Error('KolmLLM: artifactPath contains invalid characters');
  }
  const parts = artifact.replace(/\\/g, '/').split('/');
  if (parts.includes('..')) {
    throw new Error('KolmLLM: artifactPath must not traverse parent directories');
  }
  return artifact;
}

function redactSecrets(value, apiKey = null) {
  let text = String(value ?? '');
  if (apiKey) {
    text = text.split(String(apiKey)).join('[redacted]');
  }
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bks_[A-Za-z0-9._~+/=-]{8,}\b/g, 'ks_[redacted]')
    .replace(/\bsk-[A-Za-z0-9._~+/=-]{8,}\b/g, 'sk-[redacted]');
}

function truncate(value, maxChars = 200) {
  const text = String(value ?? '');
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function parseRuntimeOutput(raw) {
  // The kolm runtime emits either:
  //   - a single JSON line { text, receipt: { cid, k_score, ... } }
  //   - plain text (subprocess mode without --json), returned as-is.
  const trimmed = (raw || '').trim();
  if (!trimmed) return { text: '', receipt: null };
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      return {
        text: typeof obj.text === 'string' ? obj.text : (obj.output || ''),
        receipt: obj.receipt || obj.audit || null,
      };
    } catch (_) {
      // Fall through to plain text.
    }
  }
  return { text: trimmed, receipt: null };
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

async function readResponsePayload(res) {
  const text = await res.text().catch(() => '');
  const trimmed = text.trim();
  if (!trimmed) return {};
  const contentType = String(res.headers?.get?.('content-type') || '').toLowerCase();
  if (contentType.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch (_) {
      return { text };
    }
  }
  return { text };
}

export class KolmLLM extends BaseLLM {
  constructor(fields = {}) {
    super(fields);
    this.artifactPath = fields.artifactPath || null;
    this.baseUrl = normalizeBaseUrl(fields.baseUrl || null);
    this.apiKey = fields.apiKey || process.env.KOLM_API_KEY || null;
    this.bin = fields.bin || process.env.KOLM_BIN || DEFAULT_KOLM_BIN;
    this.timeoutMs = normalizeTimeoutMs(fields.timeoutMs);
    // Surfaced on every response.
    this.lastReceipt = null;
    if (!this.artifactPath && !this.baseUrl) {
      throw new Error('KolmLLM: either artifactPath (subprocess) or baseUrl (HTTP) is required');
    }
  }

  _llmType() { return 'kolm'; }

  async _call(prompt, _options = {}, _runManager) {
    const checkedPrompt = requirePrompt(prompt);
    const out = this.baseUrl ? await this._callHttp(checkedPrompt) : await this._callSubprocess(checkedPrompt);
    this.lastReceipt = out.receipt;
    return out.text;
  }

  // Returns { text, receipt } so callers that want the chain can grab it.
  async invokeWithReceipt(prompt, options) {
    const checkedPrompt = requirePrompt(prompt);
    const out = this.baseUrl ? await this._callHttp(checkedPrompt) : await this._callSubprocess(checkedPrompt);
    this.lastReceipt = out.receipt;
    return out;
  }

  async _callSubprocess(prompt) {
    return new Promise((resolve, reject) => {
      const artifact = requireSubprocessArtifact(this.artifactPath);
      const args = ['run', artifact, '--json'];
      const child = spawn(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let killed = false;
      let settled = false;
      let stderr = '';
      let timer;
      const finishReject = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };
      timer = setTimeout(() => {
        killed = true;
        try { child.kill('SIGKILL'); } catch (_) {}
      }, this.timeoutMs);
      child.stderr.on('data', (c) => {
        if (stderr.length >= MAX_STDERR_CHARS) return;
        stderr += c.toString('utf8').slice(0, MAX_STDERR_CHARS - stderr.length);
      });
      child.on('error', (err) => finishReject(err));
      const stdoutP = readAll(child.stdout);
      child.on('close', async (code) => {
        if (settled) return;
        clearTimeout(timer);
        const raw = await stdoutP.catch(() => '');
        settled = true;
        if (killed) return reject(new Error(`kolm run timeout after ${this.timeoutMs}ms`));
        if (code !== 0) {
          return reject(new Error(`kolm run exited ${code}: ${truncate(stderr.trim(), MAX_STDERR_CHARS)}`));
        }
        return resolve(parseRuntimeOutput(raw));
      });
      child.stdin.on('error', (err) => finishReject(err));
      child.stdin.end(prompt);
    });
  }

  async _callHttp(prompt) {
    if (typeof fetch !== 'function') {
      throw new Error('KolmLLM: global fetch is required for HTTP mode');
    }
    const artifact = encodeURIComponent(requireHttpArtifact(this.artifactPath || 'default'));
    const url = `${this.baseUrl}/v1/run/${artifact}`;
    const headers = { 'content-type': 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ prompt }),
        signal: controller.signal,
      });
    } catch (err) {
      if (timedOut || err?.name === 'AbortError') {
        throw new Error(`kolm http timeout after ${this.timeoutMs}ms`);
      }
      throw new Error(`kolm http request failed: ${truncate(redactSecrets(err?.message || err, this.apiKey))}`);
    } finally {
      clearTimeout(timer);
    }

    const json = await readResponsePayload(res);
    if (!res.ok) {
      const message = typeof json.error === 'string'
        ? json.error
        : (typeof json.message === 'string' ? json.message : (json.text || ''));
      throw new Error(`kolm http ${res.status}: ${truncate(redactSecrets(message, this.apiKey))}`);
    }
    return {
      text: typeof json.text === 'string' ? json.text : (json.output || ''),
      receipt: json.receipt || json.audit || null,
    };
  }
}

export default KolmLLM;
