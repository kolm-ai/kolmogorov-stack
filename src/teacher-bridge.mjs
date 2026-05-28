// src/teacher-bridge.mjs
//
// Cross-vendor teacher bridge surfaced for the in-process distill / council
// paths that run inside the kolm server (as distinct from the offline distill
// worker, which has its own copy at workers/distill/teacher-bridge.mjs with
// the W292 fail-closed PHI redaction wrapper).
//
// What this module owns:
//   - Vendor + model whitelist for "<vendor>:<model>" slugs that the
//     kolm distill/council surfaces are allowed to call.
//   - Thin per-vendor adapter functions that wrap each vendor's
//     chat-completions endpoint into a single envelope shape:
//
//       {
//         vendor: 'anthropic' | 'openai' | 'cerebras' | ...,
//         model:  string,
//         content: string,
//         usage:  { prompt_tokens, completion_tokens, total_tokens },
//         latency_ms: number,
//       }
//
//     Adapter errors throw Error with a "<vendor> <status>: <body snippet>"
//     message so the caller sees the upstream rejection verbatim.
//
//   - A parseSlug() helper that splits "vendor:model" and validates against
//     the whitelist.
//
// What it does NOT own:
//   - PHI redaction. Cloud-bound distill collection MUST be routed through
//     workers/distill/teacher-bridge.mjs callTeacher() which wraps every
//     vendor call in src/phi-redactor.js per W292. This in-process bridge
//     is for non-PHI surfaces (council mediation between teachers on
//     already-redacted inputs, evals, capability probes).
//
// W918 P1.15: adds the Cerebras vendor with the three model slugs the
// W918 land-grab plan whitelists for the OpenAI-fine-tuning-refugee distill
// flow (llama-3.3-70b for top quality, llama3.1-8b for cheap fast, qwen-3-32b
// for code/reasoning).

import { chat as cerebrasChat } from './teachers/cerebras.js';

// ---------- Vendor whitelist ------------------------------------------------

// VENDOR_MODELS is the canonical allow-list. The whitelist literal slugs
// "<vendor>:<model>" are also exported as TEACHER_SLUG_WHITELIST below so
// callers (CLI dispatcher, doctor surfaces, tests) can match on full slugs
// without re-flattening this object every time.
export const VENDOR_MODELS = Object.freeze({
  anthropic: Object.freeze([
    'claude-opus-4-7',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
  ]),
  openai: Object.freeze([
    'gpt-5',
    'gpt-5-mini',
    'gpt-4o',
    'gpt-4o-mini',
  ]),
  // W918 P1.15 — Cerebras teacher. Three models, all at api.cerebras.ai.
  cerebras: Object.freeze([
    'llama-3.3-70b',
    'llama3.1-8b',
    'qwen-3-32b',
  ]),
});

// Flattened "<vendor>:<model>" whitelist. Computed once at module load so
// the tests in tests/wave918-cerebras-teacher.test.js can grep literal
// substrings (cerebras:llama-3.3-70b, cerebras:llama3.1-8b, cerebras:qwen-3-32b)
// and the CLI can do constant-time membership checks.
export const TEACHER_SLUG_WHITELIST = Object.freeze([
  // anthropic
  'anthropic:claude-opus-4-7',
  'anthropic:claude-sonnet-4-6',
  'anthropic:claude-haiku-4-5-20251001',
  // openai
  'openai:gpt-5',
  'openai:gpt-5-mini',
  'openai:gpt-4o',
  'openai:gpt-4o-mini',
  // W918 P1.15 — cerebras
  'cerebras:llama-3.3-70b',
  'cerebras:llama3.1-8b',
  'cerebras:qwen-3-32b',
]);

export function isWhitelistedSlug(slug) {
  return typeof slug === 'string' && TEACHER_SLUG_WHITELIST.includes(slug);
}

/**
 * Split a "vendor:model" slug into its components and validate against the
 * whitelist. Bare strings (no colon) default to vendor=anthropic to match
 * the convention in workers/distill/teacher-bridge.mjs#parseTeacherSpec.
 *
 * @param {string} slug
 * @param {{ strict?: boolean }} [opts]  strict (default true) enforces the
 *                                       whitelist; pass false for tests that
 *                                       just want to parse.
 * @returns {{ vendor: string, model: string }}
 */
export function parseSlug(slug, opts = {}) {
  const strict = opts.strict !== false;
  if (typeof slug !== 'string' || !slug) {
    throw new Error('teacher slug required (e.g., cerebras:llama-3.3-70b)');
  }
  const idx = slug.indexOf(':');
  const vendor = idx < 0 ? 'anthropic' : slug.slice(0, idx).toLowerCase();
  const model = idx < 0 ? slug : slug.slice(idx + 1);
  if (strict) {
    if (!Object.prototype.hasOwnProperty.call(VENDOR_MODELS, vendor)) {
      throw new Error(
        `unknown teacher vendor "${vendor}"; expected one of: ${Object.keys(VENDOR_MODELS).join(', ')}`,
      );
    }
    if (!VENDOR_MODELS[vendor].includes(model)) {
      throw new Error(
        `unknown model "${model}" for vendor "${vendor}"; expected one of: ${VENDOR_MODELS[vendor].join(', ')}`,
      );
    }
  }
  return { vendor, model };
}

// ---------- Adapters --------------------------------------------------------

// Each adapter takes (model, messages, opts) and returns the same envelope:
//   { vendor, model, content, usage, latency_ms }
// Non-2xx upstream responses throw with "<vendor> <status>: <body snippet>".

async function anthropicAdapter(model, messages, opts) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY required for vendor=anthropic');
  }
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: key });
  // Anthropic separates `system` from `messages`. Pull the first system role
  // out of the messages array if present; remaining messages must alternate.
  let system;
  const turns = [];
  for (const m of messages) {
    if (m.role === 'system' && system === undefined) {
      system = m.content;
    } else {
      turns.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content });
    }
  }
  const startedAt = Date.now();
  const resp = await client.messages.create({
    model,
    max_tokens: (opts && opts.max_tokens) || 1024,
    temperature: opts && opts.temperature,
    top_p: opts && opts.top_p,
    stop_sequences: opts && opts.stop ? (Array.isArray(opts.stop) ? opts.stop : [opts.stop]) : undefined,
    system,
    messages: turns,
  });
  const block = (resp.content || []).find((b) => b.type === 'text');
  const usage = resp.usage || {};
  return {
    vendor: 'anthropic',
    model,
    content: block ? block.text : '',
    usage: {
      prompt_tokens: Number(usage.input_tokens || 0),
      completion_tokens: Number(usage.output_tokens || 0),
      total_tokens: Number((usage.input_tokens || 0) + (usage.output_tokens || 0)),
    },
    latency_ms: Date.now() - startedAt,
  };
}

async function openaiAdapter(model, messages, opts) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error('OPENAI_API_KEY required for vendor=openai');
  }
  const body = { model, messages };
  if (opts && opts.max_tokens != null) body.max_tokens = opts.max_tokens;
  if (opts && opts.temperature != null) body.temperature = opts.temperature;
  if (opts && opts.top_p != null) body.top_p = opts.top_p;
  if (opts && opts.stop != null) body.stop = opts.stop;
  const startedAt = Date.now();
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`openai ${res.status}: ${txt.slice(0, 400)}`);
  }
  const j = await res.json();
  const choice = (j.choices && j.choices[0]) || {};
  const message = choice.message || {};
  const usage = j.usage || {};
  return {
    vendor: 'openai',
    model,
    content: typeof message.content === 'string' ? message.content : '',
    usage: {
      prompt_tokens: Number(usage.prompt_tokens || 0),
      completion_tokens: Number(usage.completion_tokens || 0),
      total_tokens: Number(usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0)),
    },
    latency_ms: Date.now() - startedAt,
  };
}

// W918 P1.15 — Cerebras adapter. Delegates to src/teachers/cerebras.js which
// owns the transport, retry/backoff, and model whitelist. Wraps the result
// in the bridge envelope shape so the adapter contract matches anthropic /
// openai exactly.
async function cerebrasAdapter(model, messages, opts) {
  const result = await cerebrasChat(model, messages, opts || {});
  return {
    vendor: 'cerebras',
    model: result.model || model,
    content: result.content,
    usage: result.usage,
    latency_ms: result.latency_ms,
  };
}

const ADAPTERS = Object.freeze({
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  cerebras: cerebrasAdapter,
});

/**
 * Dispatch a chat call to the vendor named in the slug. Returns the same
 * envelope shape regardless of vendor.
 *
 * @param {string} slug              "<vendor>:<model>", must be whitelisted.
 * @param {Array<{role,content}>} messages
 * @param {object} [opts]            { max_tokens, temperature, top_p, stop }
 * @returns {Promise<{vendor,model,content,usage,latency_ms}>}
 */
export async function chat(slug, messages, opts = {}) {
  const { vendor, model } = parseSlug(slug);
  const adapter = ADAPTERS[vendor];
  if (!adapter) {
    throw new Error(`no adapter wired for vendor "${vendor}"`);
  }
  return adapter(model, messages, opts);
}

export default {
  VENDOR_MODELS,
  TEACHER_SLUG_WHITELIST,
  isWhitelistedSlug,
  parseSlug,
  chat,
};
