// W-N / wrapper-completion - shared fetch hardening for all 11 provider
// adapters (anthropic, openai, google, deepseek, groq, together, fireworks,
// openrouter, local-vllm, local-ollama, local-kolm).
//
// Implements the four gaps called out in the W-N hardening directive:
//
//   1. 429 with exponential backoff - read Retry-After header; sleep
//      min(retryAfter*1000, 30000) ms then retry; max 3 retries with
//      500ms / 1500ms / 4500ms exponential schedule (each capped by
//      the upstream's Retry-After if present). After 3 failed retries
//      the envelope surfaces { ok:false, error:'upstream_rate_limited',
//      retry_after_s }.
//
//   2. Configurable timeout - every upstream fetch accepts a timeoutMs
//      option (default 60000 ms). AbortController wired so the request
//      cancels cleanly; on abort the envelope surfaces
//      { ok:false, error:'upstream_timeout', timeout_ms }.
//
//   3. Malformed response handling - response body parse is wrapped in
//      try/catch. On JSON.parse failure the envelope surfaces
//      { ok:false, error:'upstream_malformed_response',
//        body_snippet: rawText.slice(0,500) }.
//
//   4. Pass-through model params - adapters that call buildOpenAIBody /
//      buildAnthropicBody / buildGeminiBody here forward `temperature`,
//      `top_p`, `max_tokens` (mapped to `max_completion_tokens` for
//      OpenAI o-series), `stop`, and `tools` (when the provider supports
//      tools).
//
// Contract: hardenedFetch() always returns the SAME shape the legacy
// adapters returned ({ status, json, elapsed_us }). The new outcome
// codes (upstream_rate_limited / upstream_timeout /
// upstream_malformed_response) are surfaced as ok:false error envelopes
// with synthetic status codes so the downstream gateway pipeline keeps
// signing receipts + writing observations without crashing.
//
//   status === 429  → exhausted retries on rate limit
//                     json.error = { type:'upstream_rate_limited', retry_after_s }
//   status === 0    → AbortController fired (timeout) or transport error
//                     json.error = { type:'upstream_timeout', timeout_ms }   when timeout
//                     json.error = { type:'transport_error',   message }     when other
//   status === 502  → upstream responded but body is unparseable JSON and
//                     the caller declared the response MUST be JSON
//                     json.error = { type:'upstream_malformed_response',
//                                    body_snippet }
//
// Adapters call hardenedFetch + (optional) parseJsonOrSurface together
// so the malformed-response envelope is detectable both at the network
// layer and at the parse layer, and so 2xx-with-junk-body still flows
// through as a soft failure that triggers fallback (5xx-class status).

export const DEFAULT_TIMEOUT_MS = 60000;
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 300000;
export const MAX_RETRIES = 3;
export const RETRY_BACKOFF_MS = [500, 1500, 4500]; // exponential
export const RETRY_AFTER_CAP_MS = 30000;

// Clamp an inbound timeout_ms (from the dispatch handler) into the safe
// [1000, 300000] window the shared fetcher honors. Anything else returns
// the default. Exported so the gateway dispatch handler can clamp once
// and forward the result through every chain entry.
export function clampTimeoutMs(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  if (n < MIN_TIMEOUT_MS) return MIN_TIMEOUT_MS;
  if (n > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS;
  return Math.round(n);
}

// Parse the upstream Retry-After header. Per RFC 7231 it is either an
// HTTP-date or an integer seconds count. We support both. Returns
// milliseconds clamped to [0, 30000] (RETRY_AFTER_CAP_MS), or null when
// the header is missing/unparseable.
export function parseRetryAfterMs(retryAfterHeader) {
  if (retryAfterHeader == null) return null;
  const raw = String(retryAfterHeader).trim();
  if (!raw) return null;
  // Integer seconds form.
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const s = Number(raw);
    if (!Number.isFinite(s) || s < 0) return null;
    return Math.min(Math.round(s * 1000), RETRY_AFTER_CAP_MS);
  }
  // HTTP-date form.
  const t = Date.parse(raw);
  if (Number.isFinite(t)) {
    const deltaMs = t - Date.now();
    if (deltaMs <= 0) return 0;
    return Math.min(deltaMs, RETRY_AFTER_CAP_MS);
  }
  return null;
}

// Promise-based sleep that respects an optional AbortSignal so a caller
// can cancel a pending backoff (e.g. when the outer dispatch chain
// abandons this provider).
function _sleep(ms, signal) {
  return new Promise((resolve) => {
    if (ms <= 0) { resolve(); return; }
    const t = setTimeout(resolve, ms);
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    }
  });
}

// hardenedFetch - the single source of truth for upstream provider POSTs.
//
//   * url - full upstream URL
//   * method - usually 'POST'
//   * headers - adapter-built headers (auth, content-type, anthropic-version)
//   * body - raw body string (caller stringifies)
//   * timeoutMs - request timeout (default 60s, clamped 1-300s)
//   * maxRetries - number of retry attempts for 429 (default 3)
//   * requireJson - when true, parse failures become upstream_malformed_response
//                     envelopes; when false, the raw text is preserved as {_raw}
//
// Returns { status, json, elapsed_us, headers_retry_after_s? }. Never
// throws - every error path becomes an envelope so the gateway pipeline
// keeps receipts honest.
export async function hardenedFetch({
  url,
  method = 'POST',
  headers = {},
  body = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRetries = MAX_RETRIES,
  requireJson = true,
} = {}) {
  const effectiveTimeout = clampTimeoutMs(timeoutMs);
  const t0 = process.hrtime.bigint();
  let attempt = 0;
  let lastRetryAfterMs = null;
  // attempts loop: 1 primary + up to maxRetries (default 3) extra
  // retries when the upstream returns 429.
  while (true) {
    attempt += 1;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), effectiveTimeout);
    let res;
    let transportError = null;
    try {
      res = await fetch(url, {
        method,
        headers,
        body,
        signal: ac.signal,
      });
    } catch (e) {
      transportError = e;
    } finally {
      clearTimeout(timer);
    }
    if (transportError) {
      const elapsed_us = Math.round(Number(process.hrtime.bigint() - t0) / 1000);
      // AbortError → timeout envelope. node-fetch / undici set .name to
      // "AbortError" or .code to "ABORT_ERR". Either signal counts.
      const isAbort = transportError && (
        transportError.name === 'AbortError' ||
        transportError.code === 'ABORT_ERR' ||
        /aborted/i.test(String(transportError.message || ''))
      );
      if (isAbort) {
        return {
          status: 0,
          json: {
            ok: false,
            // Both flat-string and {type,message} shapes - flat for the
            // W-N spec (`error:'upstream_timeout'`) so callers can pattern
            // match on the string, structured for legacy code that reads
            // err.error.type / err.error.message.
            error: 'upstream_timeout',
            timeout_ms: effectiveTimeout,
            error_detail: {
              type: 'upstream_timeout',
              message: `request aborted after ${effectiveTimeout}ms`,
            },
          },
          elapsed_us,
        };
      }
      return {
        status: 0,
        json: {
          ok: false,
          error: 'transport_error',
          message: String(transportError && transportError.message || transportError),
          error_detail: {
            type: 'transport_error',
            message: String(transportError && transportError.message || transportError),
          },
        },
        elapsed_us,
      };
    }
    // 429 with retry-and-backoff. We always honor Retry-After when
    // present (capped at RETRY_AFTER_CAP_MS); otherwise we use the
    // exponential schedule RETRY_BACKOFF_MS[attempt-1].
    if (res.status === 429 && attempt <= maxRetries) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
      lastRetryAfterMs = retryAfterMs;
      // Drain body so the connection can be reused - node fetch needs
      // this even though we're going to discard the bytes.
      try { await res.text(); } catch (_) { /* discard */ }
      // Pick the larger of (Retry-After cap, exponential step), but
      // never exceed RETRY_AFTER_CAP_MS overall.
      const expMs = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)] || 4500;
      const sleepMs = retryAfterMs != null
        ? Math.min(retryAfterMs, RETRY_AFTER_CAP_MS)
        : Math.min(expMs, RETRY_AFTER_CAP_MS);
      await _sleep(sleepMs);
      continue;
    }
    // 429 after exhausted retries → surface clean rate-limited envelope.
    if (res.status === 429) {
      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
      const elapsed_us = Math.round(Number(process.hrtime.bigint() - t0) / 1000);
      // Drain so connection-pool stays healthy.
      try { await res.text(); } catch (_) { /* discard */ }
      const retry_after_s = retryAfterMs != null
        ? Math.round(retryAfterMs / 1000)
        : (lastRetryAfterMs != null ? Math.round(lastRetryAfterMs / 1000) : null);
      return {
        status: 429,
        json: {
          ok: false,
          error: 'upstream_rate_limited',
          retry_after_s,
          retries_attempted: attempt - 1,
          error_detail: {
            type: 'upstream_rate_limited',
            message: `upstream returned 429 after ${attempt - 1} retries`,
            retry_after_s,
          },
        },
        elapsed_us,
      };
    }
    // Non-429 - read the body and either parse or pass through.
    const elapsed_us = Math.round(Number(process.hrtime.bigint() - t0) / 1000);
    let text = '';
    try { text = await res.text(); } catch (_) { text = ''; }
    if (!requireJson) {
      // Caller doesn't need parsed JSON - return raw text as a {_raw}
      // body so the receipt path can still hash + log it.
      return { status: res.status, json: { _raw: text }, elapsed_us };
    }
    if (!text) {
      // Empty body is valid for some 204/200-no-content responses; we
      // return an empty object envelope rather than a parse failure.
      return { status: res.status, json: {}, elapsed_us };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      // Malformed JSON. We always surface as ok:false (the gateway
      // pipeline will short-circuit and sign the failure receipt). The
      // synthetic status 502 keeps shouldFallback() advancing the chain
      // when configured to fall back on 5xx.
      return {
        status: res.status >= 200 && res.status < 300 ? 502 : res.status,
        json: {
          ok: false,
          error: 'upstream_malformed_response',
          body_snippet: text.slice(0, 500),
          original_status: res.status,
          error_detail: {
            type: 'upstream_malformed_response',
            message: 'upstream body was not valid JSON',
            body_snippet: text.slice(0, 500),
            original_status: res.status,
          },
        },
        elapsed_us,
      };
    }
    return { status: res.status, json: parsed, elapsed_us };
  }
}

// --------------------------------------------------------------------------
// Body shapers for the three families that need adapter-side normalization.
//
//   buildOpenAICompatBody - used by openai/openrouter/groq/together/
//                            fireworks/deepseek/local-* (OpenAI shape).
//                            Maps max_tokens → max_completion_tokens for
//                            the o-series + gpt-5 family.
//
//   buildAnthropicBody - converts plain string `content` into the
//                            content-block form Anthropic Messages API
//                            documents as canonical (the API also accepts
//                            strings but documented form is blocks).
//
//   buildGeminiNativeBody - converts OpenAI-style messages to the
//                            Gemini native {contents:[{role,parts:[{text}]}],
//                            generationConfig:{...}} envelope. Used when
//                            the adapter calls the native /v1beta/models/
//                            *:generateContent path instead of the
//                            OpenAI-compat alias.
// --------------------------------------------------------------------------

// OpenAI families that take `max_completion_tokens` instead of `max_tokens`
// (Reasoning models - o1, o1-mini, o3, o3-mini, o4-mini, GPT-5 lineage).
const O_SERIES_RE = /^(o[134]([-_].*)?$|o[134]-mini([-_].*)?$|gpt-5(.*)?$)/i;

export function isOSeriesModel(model) {
  if (!model || typeof model !== 'string') return false;
  return O_SERIES_RE.test(model.trim());
}

// Forward only the model params the upstream provider supports. Unknown
// keys pass through unchanged so adapter-specific features (e.g. Anthropic
// `system`, OpenAI `response_format`, DeepSeek `frequency_penalty`) keep
// working - we only NORMALIZE the four cross-provider standards.
export function buildOpenAICompatBody(body) {
  const src = (body && typeof body === 'object') ? body : {};
  const out = { ...src };
  // o-series + gpt-5 use max_completion_tokens; everything else uses max_tokens.
  if (out.max_tokens != null && isOSeriesModel(out.model)) {
    out.max_completion_tokens = out.max_completion_tokens != null
      ? out.max_completion_tokens
      : out.max_tokens;
    delete out.max_tokens;
  }
  // Standard pass-through normalization (no-ops when the keys are absent).
  for (const k of ['temperature', 'top_p', 'stop', 'tools', 'tool_choice', 'response_format']) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  return out;
}

export function buildAnthropicBody(body) {
  const src = (body && typeof body === 'object') ? body : {};
  const out = { ...src };
  if (Array.isArray(src.messages)) {
    out.messages = src.messages.map((m) => {
      if (!m || typeof m !== 'object') return m;
      // String content → content-block form per Anthropic docs.
      if (typeof m.content === 'string') {
        return { role: m.role, content: [{ type: 'text', text: m.content }] };
      }
      // Already content blocks - leave alone.
      if (Array.isArray(m.content)) {
        // Normalize plain {text} entries to {type:'text', text} so the
        // upstream doesn't 400 on a missing type field.
        const norm = m.content.map((c) => {
          if (!c || typeof c !== 'object') return { type: 'text', text: String(c || '') };
          if (typeof c.type === 'string') return c;
          if (typeof c.text === 'string') return { type: 'text', text: c.text };
          return c;
        });
        return { role: m.role, content: norm };
      }
      return m;
    });
  }
  // Pass-through model params Anthropic supports.
  for (const k of ['temperature', 'top_p', 'top_k', 'stop_sequences', 'tools', 'tool_choice', 'system', 'max_tokens']) {
    if (src[k] !== undefined) out[k] = src[k];
  }
  // Map OpenAI `stop` → Anthropic `stop_sequences` if caller used the
  // OpenAI key.
  if (src.stop !== undefined && out.stop_sequences === undefined) {
    out.stop_sequences = Array.isArray(src.stop) ? src.stop : [src.stop];
  }
  return out;
}

// Gemini native generateContent body shape. Use ONLY when the adapter
// chose to hit the native path (/v1beta/models/{model}:generateContent)
// rather than the OpenAI-compat alias. Returns {contents, generationConfig}.
export function buildGeminiNativeBody(body) {
  const src = (body && typeof body === 'object') ? body : {};
  const contents = [];
  const msgs = Array.isArray(src.messages) ? src.messages : [];
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    // Gemini uses 'user' and 'model' (not 'assistant'); 'system' is hoisted
    // to systemInstruction below.
    const role = m.role === 'assistant' ? 'model'
      : m.role === 'system' ? 'system'
      : 'user';
    const text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((c) => (c && (c.text || c.content)) || '').join('\n')
        : '';
    if (role === 'system') continue; // handled via systemInstruction
    contents.push({ role, parts: [{ text }] });
  }
  const out = { contents };
  // Hoist system messages to systemInstruction (Gemini native API spec).
  const systemMsgs = msgs.filter((m) => m && m.role === 'system');
  if (systemMsgs.length > 0) {
    const sysText = systemMsgs.map((m) => typeof m.content === 'string' ? m.content : '').join('\n');
    if (sysText) out.systemInstruction = { parts: [{ text: sysText }] };
  }
  // generationConfig holds the OpenAI-equivalent knobs.
  const gc = {};
  if (src.temperature !== undefined)     gc.temperature      = src.temperature;
  if (src.top_p       !== undefined)     gc.topP             = src.top_p;
  if (src.top_k       !== undefined)     gc.topK             = src.top_k;
  if (src.max_tokens  !== undefined)     gc.maxOutputTokens  = src.max_tokens;
  if (src.stop        !== undefined)     gc.stopSequences    = Array.isArray(src.stop) ? src.stop : [src.stop];
  if (src.response_format && src.response_format.type === 'json_object') {
    gc.responseMimeType = 'application/json';
  }
  if (Object.keys(gc).length > 0) out.generationConfig = gc;
  // Tools (Gemini supports functionDeclarations under tools[]).
  if (Array.isArray(src.tools) && src.tools.length > 0) {
    const fd = src.tools.map((t) => {
      if (t && t.type === 'function' && t.function) return t.function;
      return t;
    }).filter(Boolean);
    if (fd.length > 0) out.tools = [{ functionDeclarations: fd }];
  }
  return out;
}

// Extract response text from a Gemini native generateContent response.
// Returns { text, safetyRatings, finishReason } - text is empty string
// when extraction fails (the receipt pipeline tolerates empties).
export function extractGeminiText(response) {
  if (!response || typeof response !== 'object') {
    return { text: '', safetyRatings: null, finishReason: null };
  }
  const cands = Array.isArray(response.candidates) ? response.candidates : [];
  const first = cands[0] || {};
  const parts = (first.content && Array.isArray(first.content.parts)) ? first.content.parts : [];
  const text = parts.map((p) => (p && typeof p.text === 'string') ? p.text : '').join('');
  return {
    text,
    safetyRatings: Array.isArray(first.safetyRatings) ? first.safetyRatings : null,
    finishReason: first.finishReason || null,
  };
}
