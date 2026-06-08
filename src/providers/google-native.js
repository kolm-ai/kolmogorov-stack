// W-B / wrapper-completion - Google / Gemini native provider adapter.
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
// When the caller asks for the native shape (opts.native === true or the
// target URL contains :generateContent) we shape the body via
// buildGeminiNativeBody - {contents:[{role,parts:[{text}]}],
// generationConfig:{temperature, topP, topK, maxOutputTokens, ...}} - and
// after the upstream returns we attach the candidate's safetyRatings to
// the envelope so the gateway-receipt path can surface it in metadata.
//
// W-N hardening: shared hardenedFetch - 429+backoff (max 3 retries, exp
// schedule 500/1500/4500 ms each capped by Retry-After), AbortController
// timeoutMs (default 60s, clamped 1-300s), malformed-JSON envelope. When
// the OpenAI-compat alias is used the body flows through buildOpenAICompat
// Body for the temperature/top_p/max_tokens/stop/tools normalization;
// when the native path is used buildGeminiNativeBody handles the
// conversion.
//
// Contract mirrors src/capture.js forwardOpenAI: returns
//   { status: <http status int>, json: <parsed body or {_raw}>, elapsed_us }
// Never throws on non-2xx - upstream errors flow through as-is so the
// gateway can sign + capture them. Never throws on transport failure.

import {
  hardenedFetch,
  buildOpenAICompatBody,
  buildGeminiNativeBody,
  extractGeminiText,
  DEFAULT_TIMEOUT_MS,
} from './_shared.js';

const GEMINI_DEFAULT_BASE = 'https://generativelanguage.googleapis.com';

export async function forward({ url, body, upstreamKey, base, timeoutMs, native = false } = {}) {
  if (!upstreamKey) {
    return {
      status: 401,
      json: { error: { type: 'no_upstream_key', message: 'pass your Gemini key in x-upstream-api-key (GEMINI_API_KEY)' } },
    };
  }
  const baseUrl = base || GEMINI_DEFAULT_BASE;
  // Detect native vs OpenAI-compat based on either an explicit flag or the
  // URL path. The native generateContent endpoint has the model in the path
  // (/v1beta/models/{model}:generateContent), so callers can either pass a
  // pre-built native URL or call us with native:true and we'll build it.
  const isNative = native === true
    || (typeof url === 'string' && /:generateContent/.test(url));

  if (isNative) {
    const target = url || `${baseUrl}/v1beta/models/${encodeURIComponent(String(body && body.model || 'gemini-2.5-flash'))}:generateContent`;
    const shapedBody = buildGeminiNativeBody(body);
    const res = await hardenedFetch({
      url: target,
      method: 'POST',
      headers: {
        'authorization': `Bearer ${upstreamKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(shapedBody),
      timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
      requireJson: true,
    });
    // Lift safetyRatings into the envelope JSON so gateway-receipt metadata
    // can include it without a second pass over the raw response. Also
    // synthesize an OpenAI-compat choices[0].message.content so the
    // gateway's output-text extractor finds the answer immediately.
    if (res && res.json && typeof res.json === 'object' && !res.json.error) {
      const { text, safetyRatings, finishReason } = extractGeminiText(res.json);
      res.json = {
        ...res.json,
        choices: [{
          index: 0,
          finish_reason: finishReason || 'stop',
          message: { role: 'assistant', content: text },
        }],
      };
      if (safetyRatings) res.json.safety_ratings = safetyRatings;
    }
    return res;
  }

  // OpenAI-compat alias.
  const target = url || `${baseUrl}/v1beta/openai/chat/completions`;
  const shapedBody = buildOpenAICompatBody(body);
  return hardenedFetch({
    url: target,
    method: 'POST',
    headers: {
      'authorization': `Bearer ${upstreamKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(shapedBody),
    timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
    requireJson: true,
  });
}

export const PROVIDER_ID = 'google';
export const DEFAULT_BASE = GEMINI_DEFAULT_BASE;
