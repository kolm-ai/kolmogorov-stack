// W-B / wrapper-completion — Fireworks provider adapter.
//
// Fireworks AI is an OpenAI-compatible inference service
// (https://api.fireworks.ai/inference/v1). Bearer auth. Models include
// accounts/fireworks/models/llama-v3p3-70b-instruct,
// accounts/fireworks/models/mixtral-8x22b-instruct,
// accounts/fireworks/models/deepseek-r1, and many community-served weights.
//
// Contract mirrors src/capture.js forwardOpenAI: returns
//   { status: <http status int>, json: <parsed body or {_raw}>, elapsed_us }
// Never throws on non-2xx — upstream errors flow through as-is so the
// gateway can sign + capture them. Throws ONLY on transport failure.

const FIREWORKS_DEFAULT_BASE = 'https://api.fireworks.ai';

export async function forward({ url, body, upstreamKey, base }) {
  if (!upstreamKey) {
    return {
      status: 401,
      json: { error: { type: 'no_upstream_key', message: 'pass your Fireworks key in x-upstream-api-key (FIREWORKS_API_KEY)' } },
    };
  }
  const target = url || `${base || FIREWORKS_DEFAULT_BASE}/inference/v1/chat/completions`;
  const t0 = process.hrtime.bigint();
  const res = await fetch(target, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${upstreamKey}`,
      'content-type': 'application/json',
      'accept': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { json = { _raw: text }; }
  const elapsed_us = Math.round(Number(process.hrtime.bigint() - t0) / 1000);
  return { status: res.status, json, elapsed_us };
}

export const PROVIDER_ID = 'fireworks';
export const DEFAULT_BASE = FIREWORKS_DEFAULT_BASE;
