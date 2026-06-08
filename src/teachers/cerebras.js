// W918 P1.14 - Cerebras Cloud teacher client.
//
// Thin client over the Cerebras Cloud Inference API. The endpoint shape is
// OpenAI Chat Completions-compatible:
//
//   POST https://api.cerebras.ai/v1/chat/completions
//   authorization: Bearer ${CEREBRAS_API_KEY}
//   { model, messages: [{role, content}, ...], max_tokens?, temperature?,
//     top_p?, stop? }
//
// What this module is:
//   - Pure fetch transport (Node 20+ fetch, no npm deps).
//   - Exponential-backoff retry (3 attempts, 250/750/2250 ms) on 429 + 5xx.
//   - Strict whitelist of the three Cerebras models kolm currently teaches
//     from in W918 (llama-3.3-70b, llama3.1-8b, qwen-3-32b). Other Cerebras
//     models exist (see src/cloud-providers/cerebras.js for the live
//     catalog probe) but the teacher bridge gates on this allow-list.
//
// What this module is NOT:
//   - It does NOT do PHI redaction. The bridge layer
//     (src/teacher-bridge.mjs) is where the fail-closed redactor wraps
//     every cloud call.
//   - It does NOT stream. Distill collection takes whole responses.
//   - It does NOT manage caching. The bridge / distill orchestrator owns
//     dedup + cache decisions.
//
// Reference: https://inference-docs.cerebras.ai/api-reference/chat-completions

const CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1';

// Allow-list of Cerebras model ids the W918 distill stack teaches from.
// Keep this in sync with the whitelist in src/teacher-bridge.mjs.
export const CEREBRAS_MODELS = Object.freeze([
  'llama-3.3-70b',
  'llama3.1-8b',
  'qwen-3-32b',
]);

// HTTP status codes that warrant a retry. 429 is rate-limit; 500/502/503/504
// are upstream-transient.
const RETRIABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

// Backoff schedule in ms. Index 0 runs before retry attempt 1, etc.
const BACKOFF_MS = [250, 750, 2250];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveApiKey(env = process.env) {
  // CEREBRAS_API_KEY is canonical; KOLM_CEREBRAS_TOKEN is the kolm-side
  // alias used by src/cloud-providers/cerebras.js and the gateway router.
  return env.CEREBRAS_API_KEY || env.KOLM_CEREBRAS_TOKEN || '';
}

function resolveBaseUrl(env = process.env) {
  const raw = env.KOLM_CEREBRAS_URL || env.CEREBRAS_BASE_URL || CEREBRAS_BASE_URL;
  return String(raw).replace(/\/+$/, '');
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('cerebras chat(): messages must be a non-empty array of {role, content}');
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== 'object') {
      throw new Error(`cerebras chat(): messages[${i}] must be an object`);
    }
    if (typeof m.role !== 'string' || !m.role) {
      throw new Error(`cerebras chat(): messages[${i}].role must be a non-empty string`);
    }
    if (typeof m.content !== 'string') {
      throw new Error(`cerebras chat(): messages[${i}].content must be a string`);
    }
  }
}

function validateModel(model) {
  if (typeof model !== 'string' || !model) {
    throw new Error('cerebras chat(): model must be a non-empty string');
  }
  if (!CEREBRAS_MODELS.includes(model)) {
    throw new Error(
      `cerebras chat(): model "${model}" not in whitelist. ` +
      `Expected one of: ${CEREBRAS_MODELS.join(', ')}.`,
    );
  }
}

function buildRequestBody(model, messages, opts) {
  const body = { model, messages };
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'max_tokens')) {
    body.max_tokens = opts.max_tokens;
  }
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'temperature')) {
    body.temperature = opts.temperature;
  }
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'top_p')) {
    body.top_p = opts.top_p;
  }
  if (opts && Object.prototype.hasOwnProperty.call(opts, 'stop')) {
    body.stop = opts.stop;
  }
  return body;
}

async function readBodySnippet(res) {
  try {
    const txt = await res.text();
    return txt.slice(0, 400);
  } catch {
    return '<unreadable body>';
  }
}

/**
 * Call the Cerebras Cloud Chat Completions endpoint.
 *
 * @param {string} model    One of CEREBRAS_MODELS.
 * @param {Array<{role: string, content: string}>} messages
 *                          Same shape as OpenAI Chat Completions.
 * @param {object} [opts]   { max_tokens, temperature, top_p, stop, fetchImpl, signal }
 *                          fetchImpl + signal are escape hatches for tests
 *                          and cancellation; the API-shaped fields are
 *                          forwarded to Cerebras verbatim.
 * @returns {Promise<{content: string, usage: {prompt_tokens: number,
 *                    completion_tokens: number, total_tokens: number},
 *                    model: string, latency_ms: number}>}
 */
export async function chat(model, messages, opts = {}) {
  validateModel(model);
  validateMessages(messages);

  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw new Error(
      'CEREBRAS_API_KEY not set. Mint one at https://cloud.cerebras.ai/platform/credentials.',
    );
  }

  const baseUrl = resolveBaseUrl();
  const url = `${baseUrl}/chat/completions`;
  const body = buildRequestBody(model, messages, opts);
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('cerebras chat(): global fetch is not available (Node 20+ required)');
  }

  const startedAt = Date.now();
  let lastErr = null;
  let lastStatus = 0;
  let lastBodySnippet = '';

  // Initial attempt + up to BACKOFF_MS.length retries.
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt++) {
    if (attempt > 0) {
      await sleep(BACKOFF_MS[attempt - 1]);
    }
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (err) {
      lastErr = err;
      lastStatus = 0;
      lastBodySnippet = String(err && err.message ? err.message : err).slice(0, 400);
      // Network-layer failure (DNS, TCP, AbortError, etc.) - retry on the
      // same schedule as transient HTTP errors.
      if (attempt < BACKOFF_MS.length && !(err && err.name === 'AbortError')) {
        continue;
      }
      throw new Error(
        `cerebras chat() transport error after ${attempt + 1} attempt(s): ${lastBodySnippet}`,
      );
    }

    if (res.ok) {
      const json = await res.json();
      const choice = (json.choices && json.choices[0]) || {};
      const message = choice.message || {};
      const content = typeof message.content === 'string' ? message.content : '';
      const usageIn = json.usage || {};
      const usage = {
        prompt_tokens: Number(usageIn.prompt_tokens || 0),
        completion_tokens: Number(usageIn.completion_tokens || 0),
        total_tokens: Number(
          usageIn.total_tokens
            || (Number(usageIn.prompt_tokens || 0) + Number(usageIn.completion_tokens || 0)),
        ),
      };
      return {
        content,
        usage,
        model: typeof json.model === 'string' ? json.model : model,
        latency_ms: Date.now() - startedAt,
      };
    }

    lastStatus = res.status;
    lastBodySnippet = await readBodySnippet(res);

    if (!RETRIABLE_STATUSES.has(res.status) || attempt >= BACKOFF_MS.length) {
      throw new Error(
        `cerebras chat() ${res.status} after ${attempt + 1} attempt(s): ${lastBodySnippet}`,
      );
    }
  }

  // Should be unreachable because the loop throws on the final attempt,
  // but keep an explicit terminal error to satisfy the contract.
  throw new Error(
    `cerebras chat() exhausted retries (last status ${lastStatus}): ${lastBodySnippet || lastErr}`,
  );
}

export default { chat, CEREBRAS_MODELS };
