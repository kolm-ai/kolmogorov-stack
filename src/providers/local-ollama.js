// W-B / wrapper-completion — local-Ollama provider adapter.
//
// Ollama exposes an OpenAI-compatible chat surface at
// http://127.0.0.1:11434/v1/chat/completions. No auth in default
// install; the gateway treats Ollama as a trusted local upstream.
//
// Contract mirrors src/capture.js forwardOpenAI: returns
//   { status: <http status int>, json: <parsed body or {_raw}>, elapsed_us }
// Never throws on non-2xx — upstream errors flow through as-is so the
// gateway can sign + capture them. Throws ONLY on transport failure.

const OLLAMA_DEFAULT_BASE = 'http://127.0.0.1:11434';

export async function forward({ url, body, upstreamKey, base }) {
  const target = url || `${base || OLLAMA_DEFAULT_BASE}/v1/chat/completions`;
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

export const PROVIDER_ID = 'local-ollama';
export const DEFAULT_BASE = OLLAMA_DEFAULT_BASE;
