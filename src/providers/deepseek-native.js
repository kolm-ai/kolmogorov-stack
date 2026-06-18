// W-B / wrapper-completion - DeepSeek native provider adapter.
//
// DeepSeek's own platform (https://api.deepseek.com) is OpenAI-compatible.
// Bearer auth. Models include deepseek-chat (V4 Pro), deepseek-reasoner
// (R1 lineage). SSE streaming via stream:true; reasoning_content surfaces
// in the same delta payload for distillation capture.
//
// W-N hardening: same shared hardenedFetch as the other 7 W-B adapters.
// 429+backoff (max 3 retries), Retry-After honored (capped at 30s),
// AbortController-timeoutMs (default 60s, clamped 1-300s), malformed-JSON
// envelope, OpenAI-compat body normalizer (temperature / top_p /
// max_tokens / stop / tools pass-through).
//
// Contract mirrors src/capture.js forwardOpenAI: returns
//   { status: <http status int>, json: <parsed body or {_raw}>, elapsed_us }
// Never throws on non-2xx - upstream errors flow through as-is so the
// gateway can sign + capture them. Never throws on transport failure.

import {
  hardenedFetch,
  buildOpenAICompatBody,
  DEFAULT_TIMEOUT_MS,
  normalizeProviderTarget,
  validateProviderApiKey,
} from './_shared.js';

const DEEPSEEK_DEFAULT_BASE = 'https://api.deepseek.com';

export async function forward({ url, body, upstreamKey, base, timeoutMs } = {}) {
  if (!upstreamKey) {
    return {
      status: 401,
      json: { error: { type: 'no_upstream_key', message: 'pass your DeepSeek key in x-upstream-api-key (DEEPSEEK_API_KEY)' } },
    };
  }
  const key = validateProviderApiKey(upstreamKey, 'deepseek');
  if (!key.ok) return key.envelope;
  const target = normalizeProviderTarget({
    url,
    base,
    defaultBase: DEEPSEEK_DEFAULT_BASE,
    path: '/v1/chat/completions',
    provider: 'deepseek',
  });
  if (!target.ok) return target.envelope;
  const shapedBody = buildOpenAICompatBody(body);
  return hardenedFetch({
    url: target.url,
    method: 'POST',
    headers: {
      'authorization': `Bearer ${key.key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(shapedBody),
    timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
    requireJson: true,
  });
}

export const PROVIDER_ID = 'deepseek';
export const DEFAULT_BASE = DEEPSEEK_DEFAULT_BASE;
