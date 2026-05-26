// W-B / wrapper-completion — Groq provider adapter.
//
// Groq is an OpenAI-compatible inference service (https://api.groq.com).
// Uses bearer auth, /openai/v1/chat/completions endpoint, models include
// llama-3.1-8b-instant, llama-3.3-70b-versatile, mixtral-8x7b-32768,
// gemma2-9b-it. Streaming via SSE on stream:true.
//
// Contract mirrors src/capture.js forwardOpenAI: returns
//   { status: <http status int>, json: <parsed body or {_raw}>, elapsed_us }
// Never throws on non-2xx — upstream errors flow through as-is so the
// gateway can sign + capture them. Throws ONLY on transport failure.

const GROQ_DEFAULT_BASE = 'https://api.groq.com';

export async function forward({ url, body, upstreamKey, base }) {
  if (!upstreamKey) {
    return {
      status: 401,
      json: { error: { type: 'no_upstream_key', message: 'pass your Groq key in x-upstream-api-key (GROQ_API_KEY)' } },
    };
  }
  const target = url || `${base || GROQ_DEFAULT_BASE}/openai/v1/chat/completions`;
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

export const PROVIDER_ID = 'groq';
export const DEFAULT_BASE = GROQ_DEFAULT_BASE;
