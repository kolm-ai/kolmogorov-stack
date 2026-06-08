// W-B / wrapper-completion - Together AI provider adapter.
//
// Together (https://api.together.xyz/v1) is an OpenAI-compatible inference
// service serving a wide catalog of open-weight models (Llama, Qwen, Mistral,
// DeepSeek, Mixtral, etc.). Bearer auth.
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

const TOGETHER_DEFAULT_BASE = 'https://api.together.xyz';

export async function forward({ url, body, upstreamKey, base, timeoutMs } = {}) {
  if (!upstreamKey) {
    return {
      status: 401,
      json: { error: { type: 'no_upstream_key', message: 'pass your Together key in x-upstream-api-key (TOGETHER_API_KEY)' } },
    };
  }
  const target = url || `${base || TOGETHER_DEFAULT_BASE}/v1/chat/completions`;
  const shapedBody = buildOpenAICompatBody(body);
  return hardenedFetch({
    url: target,
    method: 'POST',
    headers: {
      'authorization': `Bearer ${upstreamKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(shapedBody),
    timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
    requireJson: true,
  });
}

export const PROVIDER_ID = 'together';
export const DEFAULT_BASE = TOGETHER_DEFAULT_BASE;
