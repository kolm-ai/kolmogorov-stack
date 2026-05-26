// W-B / wrapper-completion — DeepSeek native provider adapter.
//
// DeepSeek's own platform (https://api.deepseek.com) is OpenAI-compatible.
// Bearer auth. Models include deepseek-chat (V4 Pro), deepseek-reasoner
// (R1 lineage). SSE streaming via stream:true; reasoning_content surfaces
// in the same delta payload for distillation capture.
//
// Contract mirrors src/capture.js forwardOpenAI: returns
//   { status: <http status int>, json: <parsed body or {_raw}>, elapsed_us }
// Never throws on non-2xx — upstream errors flow through as-is so the
// gateway can sign + capture them. Throws ONLY on transport failure.

const DEEPSEEK_DEFAULT_BASE = 'https://api.deepseek.com';

export async function forward({ url, body, upstreamKey, base }) {
  if (!upstreamKey) {
    return {
      status: 401,
      json: { error: { type: 'no_upstream_key', message: 'pass your DeepSeek key in x-upstream-api-key (DEEPSEEK_API_KEY)' } },
    };
  }
  const target = url || `${base || DEEPSEEK_DEFAULT_BASE}/v1/chat/completions`;
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

export const PROVIDER_ID = 'deepseek';
export const DEFAULT_BASE = DEEPSEEK_DEFAULT_BASE;
