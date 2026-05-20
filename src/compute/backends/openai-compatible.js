// Shared adapter for self-hosted OpenAI-compatible inference servers.
// Used by vLLM, SGLang, TGI, and TensorRT-LLM. These backends are inference
// targets only; training still routes through local/cloud training adapters.

function firstEnv(names) {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  return '';
}

function normalizeBaseUrl(raw) {
  if (!raw) return '';
  return String(raw).replace(/\/+$/, '');
}

function endpoint(baseUrl, pathname) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) return '';
  if (/\/v1$/.test(base) && pathname.startsWith('/v1/')) {
    return base + pathname.slice(3);
  }
  return base + pathname;
}

async function timedFetch(url, init = {}, timeoutMs = 10_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
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

  function baseUrl() {
    return normalizeBaseUrl(firstEnv(urlEnvNames));
  }

  function apiKey() {
    return firstEnv(keyEnvNames);
  }

  async function detect() {
    const base = baseUrl();
    if (!base) {
      return {
        available: false,
        reason: `${urlEnvNames[0]} env var not set`,
        docs,
      };
    }
    return {
      available: true,
      device,
      endpoint: base,
      auth: apiKey() ? 'bearer' : 'none',
      docs,
    };
  }

  async function test() {
    const t0 = Date.now();
    const det = await detect();
    if (!det.available) return { ok: false, latency_ms: Date.now() - t0, ...det };
    const headers = apiKey() ? { Authorization: `Bearer ${apiKey()}` } : {};
    for (const path of ['/health', '/v1/models']) {
      try {
        const res = await timedFetch(endpoint(det.endpoint, path), { headers }, 5_000);
        if (res.ok) {
          return { ok: true, latency_ms: Date.now() - t0, ...det, probe: path };
        }
      } catch {
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
    const requestBody = body || {
      model: model || env.KOLM_MODEL || process.env.KOLM_MODEL || 'default',
      messages: messages || [{ role: 'user', content: prompt || '' }],
    };
    const headers = { 'Content-Type': 'application/json' };
    const key = apiKey();
    if (key) headers.Authorization = `Bearer ${key}`;
    let res;
    let text;
    try {
      res = await timedFetch(endpoint(det.endpoint, '/v1/chat/completions'), {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      }, timeoutMs);
      text = await res.text();
    } catch (err) {
      return { ok: false, exit_code: 1, reason: String(err.message || err), latency_ms: Date.now() - t0 };
    }
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* raw text is returned below */ }
    return {
      ok: res.ok,
      exit_code: res.ok ? 0 : 1,
      stdout: text,
      stderr: res.ok ? '' : text.slice(0, 1000),
      latency_ms: Date.now() - t0,
      backend: name,
      endpoint: det.endpoint,
      response: parsed,
      choices: parsed?.choices || null,
    };
  }

  return { detect, test, run };
}

export default { createOpenAICompatibleAdapter };
