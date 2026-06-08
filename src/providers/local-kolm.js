// W-B / wrapper-completion - local-.kolm artifact provider adapter.
//
// When a namespace is configured with `primary = "local:<artifact>"`,
// the ConfidenceRouter (W807) wants to dispatch the request to a
// locally-loaded .kolm artifact instead of an upstream provider.
// In production, the .kolm artifact is served by `kolm serve` on
// http://127.0.0.1:8765/v1/chat/completions (OpenAI-compatible). The
// resolver here just forwards.
//
// W-N hardening: shared hardenedFetch - 429+backoff (max 3 retries),
// AbortController timeoutMs (default 60s, clamped 1-300s), malformed-JSON
// envelope, OpenAI-compat body normalizer. A local kolm-serve hitting a
// 429 is rare but possible (operator-set rate limit); honoring it keeps
// the gateway's chain-fallback behavior consistent with cloud adapters.
//
// Contract mirrors src/capture.js forwardOpenAI: returns
//   { status: <http status int>, json: <parsed body or {_raw}>, elapsed_us }
// Never throws on non-2xx - upstream errors flow through as-is so the
// gateway can sign + capture them. Never throws on transport failure.

import { hardenedFetch, buildOpenAICompatBody, DEFAULT_TIMEOUT_MS } from './_shared.js';

const KOLM_LOCAL_DEFAULT_BASE = 'http://127.0.0.1:8765';

export async function forward({ url, body, upstreamKey, base, timeoutMs } = {}) {
  const target = url || `${base || KOLM_LOCAL_DEFAULT_BASE}/v1/chat/completions`;
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

export const PROVIDER_ID = 'local-kolm';
export const DEFAULT_BASE = KOLM_LOCAL_DEFAULT_BASE;
