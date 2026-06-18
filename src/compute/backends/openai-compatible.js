// Shared adapter for self-hosted OpenAI-compatible inference servers.
// Used by vLLM, SGLang, TGI, and TensorRT-LLM. These backends are inference
// targets only; training still routes through local/cloud training adapters.

import crypto from 'node:crypto';

export const OPENAI_COMPATIBLE_LIMITS = Object.freeze({
  max_url_chars: 2048,
  max_api_key_chars: 4096,
  max_request_body_bytes: 2 * 1024 * 1024,
  max_error_chars: 1000,
  max_timeout_ms: 10 * 60 * 1000,
});

function firstEnv(names) {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  return '';
}

function _hash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function _cleanDetail(value, max = OPENAI_COMPATIBLE_LIMITS.max_error_chars) {
  return String(value ?? '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function normalizeBaseUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (value.length > OPENAI_COMPATIBLE_LIMITS.max_url_chars) return '';
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return '';
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return '';
  if (parsed.username || parsed.password) return '';
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/+$/, '');
}

function baseUrlStatus(raw, envName) {
  const value = String(raw || '').trim();
  if (!value) return { ok: false, base: '', reason: `${envName} env var not set` };
  if (value.length > OPENAI_COMPATIBLE_LIMITS.max_url_chars) {
    return { ok: false, base: '', reason: 'invalid_base_url', detail: 'url_too_long', url_sha256: _hash(value) };
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, base: '', reason: 'invalid_base_url', detail: 'parse_failed', url_sha256: _hash(value) };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, base: '', reason: 'invalid_base_url', detail: 'unsupported_scheme', url_sha256: _hash(value) };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, base: '', reason: 'invalid_base_url', detail: 'embedded_credentials_forbidden', url_sha256: _hash(value) };
  }
  parsed.search = '';
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return { ok: true, base: parsed.toString().replace(/\/+$/, '') };
}

function endpoint(baseUrl, pathname) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) return '';
  if (/\/v1$/.test(base) && pathname.startsWith('/v1/')) {
    return base + pathname.slice(3);
  }
  return base + pathname;
}

function normalizedTimeout(timeoutMs) {
  const n = Number(timeoutMs);
  if (!Number.isFinite(n) || n <= 0) return 60_000;
  return Math.min(OPENAI_COMPATIBLE_LIMITS.max_timeout_ms, Math.trunc(n));
}

async function timedFetch(url, init = {}, timeoutMs = 10_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), normalizedTimeout(timeoutMs));
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function createOpenAICompatibleAdapter({
  name,
  urlEnv,
  keyEnv = [],
  device,
  docs,
}) {
  const urlEnvNames = Array.isArray(urlEnv) ? urlEnv : [urlEnv];
  const keyEnvNames = Array.isArray(keyEnv) ? keyEnv : [keyEnv].filter(Boolean);

  function baseStatus() {
    return baseUrlStatus(firstEnv(urlEnvNames), urlEnvNames[0]);
  }

  function apiKey() {
    const key = firstEnv(keyEnvNames);
    if (!key) return { ok: true, value: '' };
    const value = String(key);
    if (
      value.length > OPENAI_COMPATIBLE_LIMITS.max_api_key_chars
      || /[\x00-\x1f\x7f]/.test(value)
    ) {
      return { ok: false, value: '', reason: 'invalid_api_key_env', key_sha256: _hash(value) };
    }
    return { ok: true, value };
  }

  async function detect() {
    const status = baseStatus();
    if (!status.ok) {
      return {
        available: false,
        reason: status.reason,
        detail: status.detail,
        url_sha256: status.url_sha256,
        docs,
      };
    }
    const key = apiKey();
    return {
      available: true,
      device,
      endpoint: status.base,
      auth: key.ok && key.value ? 'bearer' : (key.ok ? 'none' : 'invalid'),
      docs,
    };
  }

  async function test() {
    const t0 = Date.now();
    const det = await detect();
    if (!det.available) return { ok: false, latency_ms: Date.now() - t0, ...det };
    const key = apiKey();
    if (!key.ok) return { ok: false, latency_ms: Date.now() - t0, reason: key.reason, key_sha256: key.key_sha256 };
    const headers = key.value ? { Authorization: `Bearer ${key.value}` } : {};
    for (const path of ['/health', '/v1/models']) {
      try {
        const res = await timedFetch(endpoint(det.endpoint, path), { headers }, 5_000);
        if (res.ok) {
          return { ok: true, latency_ms: Date.now() - t0, ...det, probe: path };
        }
      } catch { // deliberate: cleanup
        // Try the next common health endpoint.
      }
    }
    return {
      ok: false,
      latency_ms: Date.now() - t0,
      ...det,
      reason: 'endpoint configured but /health and /v1/models did not respond',
    };
  }

  async function run({
    model,
    messages = null,
    prompt = null,
    body = null,
    env = {},
    timeoutMs = 60_000,
  } = {}) {
    const t0 = Date.now();
    const det = await detect();
    if (!det.available) {
      return {
        ok: false,
        exit_code: 1,
        reason: det.reason,
        next_step: `set ${urlEnvNames[0]} to your ${name} OpenAI-compatible base URL`,
      };
    }
    const key = apiKey();
    if (!key.ok) {
      return {
        ok: false,
        exit_code: 1,
        reason: key.reason,
        key_sha256: key.key_sha256,
        latency_ms: Date.now() - t0,
      };
    }
    const requestBody = body || {
      model: model || env.KOLM_MODEL || process.env.KOLM_MODEL || 'default',
      messages: messages || [{ role: 'user', content: prompt || '' }],
    };
    let encodedBody;
    try {
      encodedBody = JSON.stringify(requestBody);
    } catch (err) {
      return {
        ok: false,
        exit_code: 1,
        reason: 'request_body_not_json_serializable',
        detail: _cleanDetail(err.message || err),
        latency_ms: Date.now() - t0,
      };
    }
    if (typeof encodedBody !== 'string') {
      return {
        ok: false,
        exit_code: 1,
        reason: 'request_body_not_json_serializable',
        latency_ms: Date.now() - t0,
      };
    }
    if (Buffer.byteLength(encodedBody, 'utf8') > OPENAI_COMPATIBLE_LIMITS.max_request_body_bytes) {
      return {
        ok: false,
        exit_code: 1,
        reason: 'request_body_too_large',
        max_request_body_bytes: OPENAI_COMPATIBLE_LIMITS.max_request_body_bytes,
        latency_ms: Date.now() - t0,
      };
    }
    const headers = { 'Content-Type': 'application/json' };
    if (key.value) headers.Authorization = `Bearer ${key.value}`;
    let res;
    let text;
    try {
      res = await timedFetch(endpoint(det.endpoint, '/v1/chat/completions'), {
        method: 'POST',
        headers,
        body: encodedBody,
      }, timeoutMs);
      text = await res.text();
    } catch (err) {
      return { ok: false, exit_code: 1, reason: _cleanDetail(err.message || err), latency_ms: Date.now() - t0 };
    }
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* raw text is returned below */ }
    const safeText = String(text || '').slice(0, OPENAI_COMPATIBLE_LIMITS.max_error_chars);
    return {
      ok: res.ok,
      exit_code: res.ok ? 0 : 1,
      stdout: res.ok ? text : safeText,
      stderr: res.ok ? '' : safeText,
      latency_ms: Date.now() - t0,
      backend: name,
      endpoint: det.endpoint,
      response_text_sha256: _hash(text),
      response: parsed,
      choices: parsed?.choices || null,
    };
  }

  return { detect, test, run };
}

export default { createOpenAICompatibleAdapter };
