// W-B / wrapper-completion - local-vLLM provider adapter.
//
// vLLM serves an OpenAI-compatible HTTP surface by default at
// http://127.0.0.1:8000/v1/chat/completions (or whatever --host:--port
// the operator passed). Auth is OPTIONAL - vLLM accepts requests with
// or without a bearer when --api-key was set on the server. We pass
// the upstreamKey if provided, otherwise we skip auth.
//
// W-N hardening: shared hardenedFetch - 429+backoff (max 3 retries),
// AbortController timeoutMs (default 60s, clamped 1-300s), malformed-JSON
// envelope, OpenAI-compat body normalizer. The local-* adapters
// intentionally use the same timeout default as the cloud adapters so
// operators get the same gateway behavior regardless of which backend
// is wired in.
//
// Contract mirrors src/capture.js forwardOpenAI: returns
//   { status: <http status int>, json: <parsed body or {_raw}>, elapsed_us }
// Never throws on non-2xx - upstream errors flow through as-is so the
// gateway can sign + capture them. Never throws on transport failure.

import { hardenedFetch, buildOpenAICompatBody, DEFAULT_TIMEOUT_MS } from './_shared.js';

const VLLM_DEFAULT_BASE = 'http://127.0.0.1:8000';

export async function forward({ url, body, upstreamKey, base, timeoutMs } = {}) {
  const target = url || `${base || resolveBase()}/v1/chat/completions`;
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

// W-Magpie / raw-completion seam. The Magpie self-synthesis path autoregresses
// an INSTRUCTION from the bare chat-template pre-query prefix - that is a RAW
// text continuation, NOT a chat turn, so it must hit /v1/completions (which
// vLLM / SGLang / TGI all serve OpenAI-compatibly) and read choices[0].text.
// We pass the body THROUGH unshaped (it carries {prompt, stop, max_tokens, ...}
// - not {messages}) so the chat normalizer never rewrites the prompt seam.
//
// The base URL is operator-config / env-gated (KOLM_LOCAL_COMPLETION_BASE,
// falling back to KOLM_LOCAL_VLLM_BASE, then the local default) so the seam is
// only live when an operator has actually stood up a local completions server.
// Contract mirrors forward(): { status, json, elapsed_us }; never throws.
export async function forwardCompletion({ url, body, upstreamKey, base, timeoutMs } = {}) {
  const target = url || `${base || resolveCompletionBase()}/v1/completions`;
  const headers = { 'content-type': 'application/json' };
  if (upstreamKey) headers['authorization'] = `Bearer ${upstreamKey}`;
  // Pass-through: /v1/completions consumes a raw `prompt`, not chat `messages`.
  const shapedBody = (body && typeof body === 'object') ? body : {};
  return hardenedFetch({
    url: target,
    method: 'POST',
    headers,
    body: JSON.stringify(shapedBody),
    timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
    requireJson: true,
  });
}

// Read choices[0].text from a /v1/completions response envelope. Returns '' on
// any malformed/empty shape so a caller's row-cleaner just drops it.
export function extractCompletionText(resp) {
  const json = resp && resp.json ? resp.json : resp;
  const choices = json && Array.isArray(json.choices) ? json.choices : [];
  const first = choices.length ? choices[0] : null;
  if (first && typeof first.text === 'string') return first.text;
  // Some servers echo a chat-shaped choice even on /v1/completions; tolerate it.
  if (first && first.message && typeof first.message.content === 'string') return first.message.content;
  return '';
}

function resolveBase() {
  const b = process.env.KOLM_LOCAL_VLLM_BASE;
  return (typeof b === 'string' && b.trim()) ? b.trim().replace(/\/+$/, '') : VLLM_DEFAULT_BASE;
}

function resolveCompletionBase() {
  const b = process.env.KOLM_LOCAL_COMPLETION_BASE || process.env.KOLM_LOCAL_VLLM_BASE;
  return (typeof b === 'string' && b.trim()) ? b.trim().replace(/\/+$/, '') : VLLM_DEFAULT_BASE;
}

export const PROVIDER_ID = 'local-vllm';
export const DEFAULT_BASE = VLLM_DEFAULT_BASE;
