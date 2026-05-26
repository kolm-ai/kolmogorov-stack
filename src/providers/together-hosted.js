// W-B / wrapper-completion — Together AI provider adapter.
//
// Together (https://api.together.xyz/v1) is an OpenAI-compatible inference
// service serving a wide catalog of open-weight models (Llama, Qwen, Mistral,
// DeepSeek, Mixtral, etc.). Bearer auth.
//
// Contract mirrors src/capture.js forwardOpenAI: returns
//   { status: <http status int>, json: <parsed body or {_raw}>, elapsed_us }
// Never throws on non-2xx — upstream errors flow through as-is so the
// gateway can sign + capture them. Throws ONLY on transport failure.

const TOGETHER_DEFAULT_BASE = 'https://api.together.xyz';

export async function forward({ url, body, upstreamKey, base }) {
  if (!upstreamKey) {
    return {
      status: 401,
      json: { error: { type: 'no_upstream_key', message: 'pass your Together key in x-upstream-api-key (TOGETHER_API_KEY)' } },
    };
  }
  const target = url || `${base || TOGETHER_DEFAULT_BASE}/v1/chat/completions`;
  const t0 = process.hrtime.bigint();
  const res = await fetch(target, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${upstreamKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { json = { _raw: text }; }
  const elapsed_us = Math.round(Number(process.hrtime.bigint() - t0) / 1000);
  return { status: res.status, json, elapsed_us };
}

export const PROVIDER_ID = 'together';
export const DEFAULT_BASE = TOGETHER_DEFAULT_BASE;
