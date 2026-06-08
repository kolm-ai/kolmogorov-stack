// cerebras - Cerebras Cloud Inference (CS-3 wafer-scale).
//
// Cerebras Cloud Inference exposes an OpenAI-compatible /v1/chat/completions
// endpoint at api.cerebras.ai. The standout feature is per-token latency:
// llama3.1-8b serves ~2,200 tok/s and llama-3.3-70b serves ~450 tok/s on
// public benchmarks (2026-05), which is 10-20x typical GPU clouds.
//
// Auth via CEREBRAS_API_KEY (or KOLM_CEREBRAS_TOKEN).
// Docs: https://inference-docs.cerebras.ai/

import { createOpenAICompatibleAdapter } from './openai-compatible.js';

const adapter = createOpenAICompatibleAdapter({
  name: 'cerebras',
  urlEnv: ['KOLM_CEREBRAS_URL', 'CEREBRAS_BASE_URL'],
  keyEnv: ['CEREBRAS_API_KEY', 'KOLM_CEREBRAS_TOKEN'],
  device: 'cerebras-cs3-wafer',
  docs: 'https://inference-docs.cerebras.ai/api-reference/chat-completions',
});

// Default base URL - only applied when none of the env vars are set. We do
// this by overriding detect/run to fall back to api.cerebras.ai/v1 when the
// API key is present but the base URL isn't.
const CEREBRAS_DEFAULT_BASE = 'https://api.cerebras.ai/v1';

function _key() {
  return process.env.CEREBRAS_API_KEY || process.env.KOLM_CEREBRAS_TOKEN || '';
}

function _baseUrl() {
  return process.env.KOLM_CEREBRAS_URL || process.env.CEREBRAS_BASE_URL || CEREBRAS_DEFAULT_BASE;
}

export async function detect() {
  if (!_key()) {
    return {
      available: false,
      reason: 'CEREBRAS_API_KEY env var not set',
      docs: 'https://inference-docs.cerebras.ai/quickstart',
    };
  }
  return {
    available: true,
    device: 'cerebras-cs3-wafer',
    endpoint: _baseUrl(),
    auth: 'bearer',
    docs: 'https://inference-docs.cerebras.ai/api-reference/chat-completions',
  };
}

export async function test() {
  const t0 = Date.now();
  const det = await detect();
  if (!det.available) return { ok: false, latency_ms: Date.now() - t0, ...det };
  const headers = { Authorization: `Bearer ${_key()}` };
  try {
    const res = await fetch(`${det.endpoint}/models`, { headers });
    if (res.ok) {
      return { ok: true, latency_ms: Date.now() - t0, ...det, probe: '/models' };
    }
    return {
      ok: false,
      latency_ms: Date.now() - t0,
      ...det,
      reason: `endpoint configured but /models returned ${res.status}`,
    };
  } catch (err) {
    return { ok: false, latency_ms: Date.now() - t0, ...det, reason: String(err.message || err) };
  }
}

export async function run({
  model,
  messages = null,
  prompt = null,
  body = null,
  timeoutMs = 60_000,
} = {}) {
  const t0 = Date.now();
  const det = await detect();
  if (!det.available) {
    return {
      ok: false,
      exit_code: 1,
      reason: det.reason,
      next_step: 'set CEREBRAS_API_KEY to your Cerebras Cloud Inference key from https://cloud.cerebras.ai',
    };
  }
  const requestBody = body || {
    model: model || process.env.KOLM_MODEL || 'llama3.1-8b',
    messages: messages || [{ role: 'user', content: prompt || '' }],
  };
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${_key()}`,
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${det.endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* raw text returned below */ }
    return {
      ok: res.ok,
      exit_code: res.ok ? 0 : 1,
      stdout: text,
      stderr: res.ok ? '' : text.slice(0, 1000),
      latency_ms: Date.now() - t0,
      backend: 'cerebras',
      endpoint: det.endpoint,
      response: parsed,
      choices: parsed?.choices || null,
      // Cerebras returns time_info on completions with per-stage tok/s. Pass
      // through so the receipt can record the wafer-scale headline number.
      cerebras_time_info: parsed?.time_info || null,
    };
  } catch (err) {
    return {
      ok: false,
      exit_code: 1,
      reason: String(err.message || err),
      latency_ms: Date.now() - t0,
      backend: 'cerebras',
    };
  } finally {
    clearTimeout(timer);
  }
}

export default { detect, test, run };

// Re-export the underlying OpenAI-compatible adapter for callers that want
// the generic shape (e.g. ConfidenceRouter).
export const openAICompatible = adapter;
