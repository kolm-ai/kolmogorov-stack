// W-B / wrapper-completion - local-Ollama provider adapter.
//
// Ollama exposes an OpenAI-compatible chat surface at
// http://127.0.0.1:11434/v1/chat/completions. No auth in default
// install; the gateway treats Ollama as a trusted local upstream.
//
// W-N hardening: shared hardenedFetch - 429+backoff (max 3 retries),
// AbortController timeoutMs (default 60s, clamped 1-300s), malformed-JSON
// envelope, OpenAI-compat body normalizer.
//
// Contract mirrors src/capture.js forwardOpenAI: returns
//   { status: <http status int>, json: <parsed body or {_raw}>, elapsed_us }
// Never throws on non-2xx - upstream errors flow through as-is so the
// gateway can sign + capture them. Never throws on transport failure.

import { hardenedFetch, buildOpenAICompatBody, DEFAULT_TIMEOUT_MS } from './_shared.js';

const OLLAMA_DEFAULT_BASE = 'http://127.0.0.1:11434';

export async function forward({ url, body, upstreamKey, base, timeoutMs } = {}) {
  const target = url || `${base || OLLAMA_DEFAULT_BASE}/v1/chat/completions`;
  const headers = { 'content-type': 'application/json' };
  if (upstreamKey) headers['authorization'] = `Bearer ${upstreamKey}`;
  const shapedBody = buildOpenAICompatBody(body);
  return hardenedFetch({
    url: target,
    method: 'POST',
    headers,
    body: JSON.stringify(shapedBody),
    timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
    requireJson: true,
  });
}

export const PROVIDER_ID = 'local-ollama';
export const DEFAULT_BASE = OLLAMA_DEFAULT_BASE;
