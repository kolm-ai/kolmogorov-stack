// W-B / wrapper-completion - Groq provider adapter.
//
// Groq is an OpenAI-compatible inference service (https://api.groq.com).
// Uses bearer auth, /openai/v1/chat/completions endpoint, models include
// llama-3.1-8b-instant, llama-3.3-70b-versatile, mixtral-8x7b-32768,
// gemma2-9b-it. Streaming via SSE on stream:true.
//
// W-N hardening: routes upstream POSTs through hardenedFetch which gives
// us 429+backoff retries (max 3, exponential with Retry-After cap),
// AbortController-driven timeoutMs (default 60s, clamped 1-300s),
// malformed-JSON envelopes, and the OpenAI-compat body normalizer that
// forwards temperature / top_p / max_tokens / stop / tools.
//
// Contract mirrors src/capture.js forwardOpenAI: returns
//   { status: <http status int>, json: <parsed body or {_raw}>, elapsed_us }
// Never throws on non-2xx - upstream errors flow through as-is so the
// gateway can sign + capture them. Never throws on transport failure - 
// the hardenedFetch envelope replaces transport throws with synthetic
// status:0 envelopes.

import { hardenedFetch, buildOpenAICompatBody, DEFAULT_TIMEOUT_MS } from './_shared.js';

const GROQ_DEFAULT_BASE = 'https://api.groq.com';

export async function forward({ url, body, upstreamKey, base, timeoutMs } = {}) {
  if (!upstreamKey) {
    return {
      status: 401,
      json: { error: { type: 'no_upstream_key', message: 'pass your Groq key in x-upstream-api-key (GROQ_API_KEY)' } },
    };
  }
  const target = url || `${base || GROQ_DEFAULT_BASE}/openai/v1/chat/completions`;
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

export const PROVIDER_ID = 'groq';
export const DEFAULT_BASE = GROQ_DEFAULT_BASE;
