// W-B / wrapper-completion — Fireworks provider adapter.
//
// Fireworks AI is an OpenAI-compatible inference service
// (https://api.fireworks.ai/inference/v1). Bearer auth. Models include
// accounts/fireworks/models/llama-v3p3-70b-instruct,
// accounts/fireworks/models/mixtral-8x22b-instruct,
// accounts/fireworks/models/deepseek-r1, and many community-served weights.
//
// W-N hardening: shared hardenedFetch — 429+backoff (max 3 retries, exp
// schedule 500/1500/4500 ms each capped by Retry-After), AbortController
// timeoutMs (default 60s, clamped 1-300s), malformed-JSON envelope,
// OpenAI-compat body normalizer.
//
// Contract mirrors src/capture.js forwardOpenAI: returns
//   { status: <http status int>, json: <parsed body or {_raw}>, elapsed_us }
// Never throws on non-2xx — upstream errors flow through as-is so the
// gateway can sign + capture them. Never throws on transport failure.

import { hardenedFetch, buildOpenAICompatBody, DEFAULT_TIMEOUT_MS } from './_shared.js';

const FIREWORKS_DEFAULT_BASE = 'https://api.fireworks.ai';

export async function forward({ url, body, upstreamKey, base, timeoutMs } = {}) {
  if (!upstreamKey) {
    return {
      status: 401,
      json: { error: { type: 'no_upstream_key', message: 'pass your Fireworks key in x-upstream-api-key (FIREWORKS_API_KEY)' } },
    };
  }
  const target = url || `${base || FIREWORKS_DEFAULT_BASE}/inference/v1/chat/completions`;
  const shapedBody = buildOpenAICompatBody(body);
  return hardenedFetch({
    url: target,
    method: 'POST',
    headers: {
      'authorization': `Bearer ${upstreamKey}`,
      'content-type': 'application/json',
      'accept': 'application/json',
    },
    body: JSON.stringify(shapedBody),
    timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
    requireJson: true,
  });
}

export const PROVIDER_ID = 'fireworks';
export const DEFAULT_BASE = FIREWORKS_DEFAULT_BASE;
