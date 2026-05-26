// W-B / wrapper-completion — Google / Gemini native provider adapter.
//
// Gemini's native REST surface is at
//   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key=API_KEY
// or the OpenAI-compat alias at
//   POST https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
//
// We default to the OpenAI-compat alias so clients can use the same body
// shape they use for OpenAI/Anthropic/etc. Auth is via the "Authorization:
// Bearer <KEY>" header on the OpenAI-compat path (Google accepts this in
// addition to ?key= on the native path).
//
// Contract mirrors src/capture.js forwardOpenAI: returns
//   { status: <http status int>, json: <parsed body or {_raw}>, elapsed_us }
// Never throws on non-2xx — upstream errors flow through as-is so the
// gateway can sign + capture them. Throws ONLY on transport failure.

const GEMINI_DEFAULT_BASE = 'https://generativelanguage.googleapis.com';

export async function forward({ url, body, upstreamKey, base }) {
  if (!upstreamKey) {
    return {
      status: 401,
      json: { error: { type: 'no_upstream_key', message: 'pass your Gemini key in x-upstream-api-key (GEMINI_API_KEY)' } },
    };
  }
  const target = url || `${base || GEMINI_DEFAULT_BASE}/v1beta/openai/chat/completions`;
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

export const PROVIDER_ID = 'google';
export const DEFAULT_BASE = GEMINI_DEFAULT_BASE;
