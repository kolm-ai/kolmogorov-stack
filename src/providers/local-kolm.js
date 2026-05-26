// W-B / wrapper-completion — local-.kolm artifact provider adapter.
//
// When a namespace is configured with `primary = "local:<artifact>"`,
// the ConfidenceRouter (W807) wants to dispatch the request to a
// locally-loaded .kolm artifact instead of an upstream provider.
// In production, the .kolm artifact is served by `kolm serve` on
// http://127.0.0.1:8765/v1/chat/completions (OpenAI-compatible). The
// resolver here just forwards.
//
// Contract mirrors src/capture.js forwardOpenAI: returns
//   { status: <http status int>, json: <parsed body or {_raw}>, elapsed_us }
// Never throws on non-2xx — upstream errors flow through as-is so the
// gateway can sign + capture them. Throws ONLY on transport failure.

const KOLM_LOCAL_DEFAULT_BASE = 'http://127.0.0.1:8765';

export async function forward({ url, body, upstreamKey, base }) {
  const target = url || `${base || KOLM_LOCAL_DEFAULT_BASE}/v1/chat/completions`;
  const headers = { 'content-type': 'application/json' };
  if (upstreamKey) headers['authorization'] = `Bearer ${upstreamKey}`;
  const t0 = process.hrtime.bigint();
  const res = await fetch(target, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { json = { _raw: text }; }
  const elapsed_us = Math.round(Number(process.hrtime.bigint() - t0) / 1000);
  return { status: res.status, json, elapsed_us };
}

export const PROVIDER_ID = 'local-kolm';
export const DEFAULT_BASE = KOLM_LOCAL_DEFAULT_BASE;
