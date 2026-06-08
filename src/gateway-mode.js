// W742 - Gateway Mode (gateway-mode.js).
//
// Atomic items pinned (matches the W742 implementation):
//
//   [W742-1] Capture from local Ollama / vLLM instances => KOLM_GATEWAY_MODE=local-ollama
//            (and local-vllm).
//   [W742-2] Offline distillation using only local GPU (the gateway-mode plumbing
//            is the chokepoint; offline distillation is a downstream consumer
//            that calls dispatchByMode with the local-* mode set).
//   [W742-3] Mock gateway for testing without API costs => KOLM_GATEWAY_MODE=mock
//
// Design notes:
//   * Single source of truth for gateway-mode resolution. `currentMode()` is
//     the ONLY caller-facing path to translate `process.env.KOLM_GATEWAY_MODE`
//     into one of the frozen `GATEWAY_MODES` values. Unknown values throw
//     loud so callers cannot silently fall through to 'cloud' on a typo
//     (e.g. `local-olama`) - that would re-introduce the very leak this
//     wave is meant to prevent.
//   * `dispatchByMode` is the SINGLE call-site for `/v1/chat/completions`
//     when KOLM_GATEWAY_MODE != 'cloud'. The cloud-mode path is left
//     unchanged so the existing `__hostedInferenceWrapper` keeps owning
//     billing + guardrails + metering.
//   * No retries at this layer. Honest envelopes only. The runner above
//     (router or CLI) decides whether to retry.
//   * Token counts in mock mode use `Math.floor(chars / 4)` so tests are
//     fully deterministic - same input → same usage every time.

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

export const GATEWAY_MODE_VERSION = 'w742-v1';

// Frozen so callers cannot mutate by accident.
export const GATEWAY_MODES = Object.freeze([
  'cloud',
  'local-ollama',
  'local-vllm',
  'mock',
]);

// ---------------------------------------------------------------------------
// currentMode - single source of truth for KOLM_GATEWAY_MODE resolution.
// ---------------------------------------------------------------------------
//
// * Returns 'cloud' when KOLM_GATEWAY_MODE is unset, empty, or 'cloud' (so
//   the production hot-path is unaffected by this wave for every caller
//   that has not explicitly opted in).
// * Throws on unknown values rather than silently falling back - a typo
//   like `KOLM_GATEWAY_MODE=local-olama` would otherwise leak a request
//   to the cloud teacher; failing loud surfaces the typo immediately.
export function currentMode() {
  const raw = String(process.env.KOLM_GATEWAY_MODE || '').trim().toLowerCase();
  if (raw === '' || raw === 'cloud') return 'cloud';
  if (GATEWAY_MODES.indexOf(raw) >= 0) return raw;
  const err = new Error(
    `unknown KOLM_GATEWAY_MODE=${JSON.stringify(raw)}; must be one of ${GATEWAY_MODES.join(', ')}`,
  );
  err.code = 'unknown_gateway_mode';
  err.allowed = GATEWAY_MODES.slice();
  throw err;
}

// ---------------------------------------------------------------------------
// localOllamaCall - POST <base_url>/api/chat (Ollama's chat API).
// ---------------------------------------------------------------------------
//
// Ollama's response shape is `{message:{role,content},...}` with `eval_count`
// + `prompt_eval_count` for usage. We normalize into the kolm envelope:
//   {ok:true, content, usage:{prompt_tokens, completion_tokens}, raw_response}
//
// On connection refused (Ollama not running) we return a honest envelope
// pointing at `ollama serve` rather than re-raising - the caller usually
// wants to surface this in the CLI / dashboard, not crash.
export async function localOllamaCall({
  model,
  messages,
  base_url = 'http://localhost:11434',
}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, error: 'missing_messages', hint: 'pass a non-empty messages[] array' };
  }
  if (typeof model !== 'string' || model.length === 0) {
    return { ok: false, error: 'missing_model', hint: 'pass model:"<ollama-model-tag>" (e.g. qwen2.5:7b)' };
  }
  const body = JSON.stringify({ model, messages, stream: false });
  let raw;
  try {
    raw = await _httpPostJson(`${base_url.replace(/\/$/, '')}/api/chat`, body, 5000);
  } catch (e) {
    if (e && (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET')) {
      return {
        ok: false,
        error: 'ollama_not_reachable',
        hint: "start ollama with 'ollama serve'",
        detail: String(e.message || e),
        version: GATEWAY_MODE_VERSION,
      };
    }
    return {
      ok: false,
      error: 'ollama_request_failed',
      hint: 'check that base_url is correct and ollama is running',
      detail: String(e && e.message || e),
      version: GATEWAY_MODE_VERSION,
    };
  }
  let parsed;
  try { parsed = JSON.parse(raw.body); }
  catch (e) {
    return {
      ok: false,
      error: 'ollama_response_unparseable',
      detail: String(e.message || e),
      raw_body: raw.body && raw.body.slice(0, 400),
      version: GATEWAY_MODE_VERSION,
    };
  }
  const content = (parsed && parsed.message && typeof parsed.message.content === 'string')
    ? parsed.message.content : '';
  return {
    ok: true,
    content,
    usage: {
      prompt_tokens: Number(parsed && parsed.prompt_eval_count) || 0,
      completion_tokens: Number(parsed && parsed.eval_count) || 0,
    },
    raw_response: parsed,
    version: GATEWAY_MODE_VERSION,
  };
}

// ---------------------------------------------------------------------------
// localVllmCall - POST <base_url>/v1/chat/completions (vLLM is OpenAI-compat).
// ---------------------------------------------------------------------------
//
// vLLM returns the standard OpenAI shape so we extract content +
// usage from `choices[0].message.content` and `usage`.
export async function localVllmCall({
  model,
  messages,
  base_url = 'http://localhost:8000',
}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, error: 'missing_messages', hint: 'pass a non-empty messages[] array' };
  }
  if (typeof model !== 'string' || model.length === 0) {
    return { ok: false, error: 'missing_model', hint: 'pass model:"<vllm-served-model-name>"' };
  }
  const body = JSON.stringify({ model, messages, stream: false });
  let raw;
  try {
    raw = await _httpPostJson(`${base_url.replace(/\/$/, '')}/v1/chat/completions`, body, 5000);
  } catch (e) {
    if (e && (e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET')) {
      return {
        ok: false,
        error: 'vllm_not_reachable',
        hint: "start vllm with 'python -m vllm.entrypoints.openai.api_server --model <name>'",
        detail: String(e.message || e),
        version: GATEWAY_MODE_VERSION,
      };
    }
    return {
      ok: false,
      error: 'vllm_request_failed',
      hint: 'check that base_url is correct and vllm is running',
      detail: String(e && e.message || e),
      version: GATEWAY_MODE_VERSION,
    };
  }
  let parsed;
  try { parsed = JSON.parse(raw.body); }
  catch (e) {
    return {
      ok: false,
      error: 'vllm_response_unparseable',
      detail: String(e.message || e),
      raw_body: raw.body && raw.body.slice(0, 400),
      version: GATEWAY_MODE_VERSION,
    };
  }
  const choice = parsed && Array.isArray(parsed.choices) && parsed.choices[0];
  const content = (choice && choice.message && typeof choice.message.content === 'string')
    ? choice.message.content : '';
  const usage = (parsed && parsed.usage) || {};
  return {
    ok: true,
    content,
    usage: {
      prompt_tokens: Number(usage.prompt_tokens) || 0,
      completion_tokens: Number(usage.completion_tokens) || 0,
    },
    raw_response: parsed,
    version: GATEWAY_MODE_VERSION,
  };
}

// ---------------------------------------------------------------------------
// mockGatewayCall - deterministic stub for tests + free local dev.
// ---------------------------------------------------------------------------
//
// Three deterministic kinds:
//   'echo'    → returns the last user message verbatim
//   'reverse' → returns the last user message reversed
//   'fixed'   → returns KOLM_MOCK_RESPONSE env value, or 'mock_response_default'
//
// Token counts are integer-floor(chars / 4). The same inputs ALWAYS produce
// the same outputs (including usage) so tests aren't flaky - this is W742-3
// (mock gateway for testing without API costs).
export function mockGatewayCall({ messages, mockKind = 'echo' }) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, error: 'missing_messages', hint: 'pass a non-empty messages[] array' };
  }
  const lastUser = _findLastUserContent(messages);
  let content;
  if (mockKind === 'echo') {
    content = lastUser || '';
  } else if (mockKind === 'reverse') {
    content = (lastUser || '').split('').reverse().join('');
  } else if (mockKind === 'fixed') {
    const fixed = process.env.KOLM_MOCK_RESPONSE;
    content = (typeof fixed === 'string' && fixed.length > 0) ? fixed : 'mock_response_default';
  } else {
    return {
      ok: false,
      error: 'unknown_mock_kind',
      mockKind,
      allowed: ['echo', 'reverse', 'fixed'],
      version: GATEWAY_MODE_VERSION,
    };
  }
  // Deterministic token counts. Integer math so two identical inputs produce
  // identical usage numbers - tests assert equality, not approximate equality.
  let promptChars = 0;
  for (const m of messages) {
    const c = typeof m.content === 'string' ? m.content : '';
    promptChars += c.length;
  }
  const prompt_tokens = Math.floor(promptChars / 4);
  const completion_tokens = Math.floor(content.length / 4);
  return {
    ok: true,
    content,
    usage: {
      prompt_tokens,
      completion_tokens,
    },
    raw_response: { mock: true, mockKind },
    version: GATEWAY_MODE_VERSION,
  };
}

// ---------------------------------------------------------------------------
// dispatchByMode - single entry point that routes to the right adapter.
// ---------------------------------------------------------------------------
//
// Honest envelopes on every failure path. If `mode` is missing or unknown
// we return ok:false instead of throwing - callers (the router, the CLI)
// surface this envelope rather than spilling a stack to the user.
//
// Callers MUST NOT use this for cloud-mode dispatch; cloud-mode flows
// through `__hostedInferenceWrapper` so billing + guardrails fire. We
// surface a unmistakable envelope on `mode==='cloud'` so an accidental
// caller (e.g. someone removing the cloud-mode early-return) sees the
// mistake instead of a silent no-op.
export async function dispatchByMode(opts) {
  opts = opts || {};
  const mode = String(opts.mode || '').trim().toLowerCase();
  const { messages, model } = opts;
  if (mode === '' || GATEWAY_MODES.indexOf(mode) < 0) {
    return {
      ok: false,
      error: 'unknown_gateway_mode',
      mode: opts.mode,
      allowed: GATEWAY_MODES.slice(),
      version: GATEWAY_MODE_VERSION,
    };
  }
  if (mode === 'cloud') {
    return {
      ok: false,
      error: 'cloud_mode_not_dispatched_here',
      hint: 'cloud-mode calls flow through __hostedInferenceWrapper; do not dispatch via gateway-mode.js',
      version: GATEWAY_MODE_VERSION,
    };
  }
  if (mode === 'local-ollama') {
    return localOllamaCall({
      model,
      messages,
      base_url: opts.base_url || process.env.KOLM_OLLAMA_URL || 'http://localhost:11434',
    });
  }
  if (mode === 'local-vllm') {
    return localVllmCall({
      model,
      messages,
      base_url: opts.base_url || process.env.KOLM_VLLM_URL || 'http://localhost:8000',
    });
  }
  if (mode === 'mock') {
    return mockGatewayCall({
      messages,
      mockKind: opts.mockKind || process.env.KOLM_MOCK_KIND || 'echo',
    });
  }
  // Unreachable - every member of GATEWAY_MODES is handled above. The
  // explicit fall-through envelope below is defense-in-depth.
  return {
    ok: false,
    error: 'unhandled_gateway_mode',
    mode,
    version: GATEWAY_MODE_VERSION,
  };
}

// ---------------------------------------------------------------------------
// probeReachability - used by `GET /v1/gateway/mode` to surface whether
// the local backends respond. HEAD with a 1s timeout so the route is fast
// even when both backends are down.
// ---------------------------------------------------------------------------
export async function probeReachability(opts) {
  opts = opts || {};
  const ollamaUrl = opts.ollama_url || process.env.KOLM_OLLAMA_URL || 'http://localhost:11434';
  const vllmUrl = opts.vllm_url || process.env.KOLM_VLLM_URL || 'http://localhost:8000';
  const [ollama_reachable, vllm_reachable] = await Promise.all([
    _probeOne(ollamaUrl, 1000),
    _probeOne(vllmUrl, 1000),
  ]);
  return { ollama_reachable, vllm_reachable };
}

// ---------------------------------------------------------------------------
// Helpers (private).
// ---------------------------------------------------------------------------

function _findLastUserContent(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && (m.role === 'user' || !m.role) && typeof m.content === 'string') {
      return m.content;
    }
  }
  // Fall back to the last message regardless of role so even a synthetic
  // messages[] without role: still produces a deterministic echo.
  const last = messages[messages.length - 1];
  if (last && typeof last.content === 'string') return last.content;
  return '';
}

function _httpPostJson(urlStr, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlStr); }
    catch (e) { reject(e); return; }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    });
    req.write(body);
    req.end();
  });
}

function _probeOne(urlStr, timeoutMs) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(urlStr); }
    catch (_) { resolve(false); return; }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'HEAD',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: '/',
      timeout: timeoutMs,
    }, (res) => {
      // Any HTTP response (even 404) means the server is reachable.
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}
