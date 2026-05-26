// W-B / wrapper-completion — local-vLLM provider adapter.
//
// vLLM serves an OpenAI-compatible HTTP surface by default at
// http://127.0.0.1:8000/v1/chat/completions (or whatever --host:--port
// the operator passed). Auth is OPTIONAL — vLLM accepts requests with
// or without a bearer when --api-key was set on the server. We pass
// the upstreamKey if provided, otherwise we skip auth.
//
// W-N hardening: shared hardenedFetch — 429+backoff (max 3 retries),
// AbortController timeoutMs (default 60s, clamped 1-300s), malformed-JSON
// envelope, OpenAI-compat body normalizer. The local-* adapters
// intentionally use the same timeout default as the cloud adapters so
// operators get the same gateway behavior regardless of which backend
// is wired in.
//
// Contract mirrors src/capture.js forwardOpenAI: returns
//   { status: <http status int>, json: <parsed body or {_raw}>, elapsed_us }
// Never throws on non-2xx — upstream errors flow through as-is so the
// gateway can sign + capture them. Never throws on transport failure.

import { hardenedFetch, buildOpenAICompatBody, DEFAULT_TIMEOUT_MS } from './_shared.js';

const VLLM_DEFAULT_BASE = 'http://127.0.0.1:8000';

export async function forward({ url, body, upstreamKey, base, timeoutMs } = {}) {
  const target = url || `${base || VLLM_DEFAULT_BASE}/v1/chat/completions`;
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

export const PROVIDER_ID = 'local-vllm';
export const DEFAULT_BASE = VLLM_DEFAULT_BASE;
