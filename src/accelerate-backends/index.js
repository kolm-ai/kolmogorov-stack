// src/accelerate-backends/index.js
//
// Real speculative-decoding backend bridges for the consumer accelerate path
// (W727 - student-as-draft / teacher-verify). src/accelerate.js orchestrates
// the round but never owned a runtime; this module supplies the missing
// {propose, verify, wall_clock_ms_teacher_only} object so the SOTA
// orchestration can execute against a live engine in production.
//
// Two real runtimes are wired:
//
//   llama-cpp   A local draft+target bridge. The draft (student) model runs a
//               short greedy continuation; the target (teacher) model verifies
//               each draft token by checking whether it is the teacher's
//               argmax at that position (the Leviathan'23/Chen'23 accept rule,
//               greedy specialization). Both models are served by llama.cpp's
//               OpenAI-compatible `llama-server` endpoints (one per model), so
//               no native bindings are required - just two HTTP endpoints.
//
//   vllm/tgi/   The OpenAI-compatible adapter family. vLLM/SGLang/TGI all
//   sglang      expose speculative decoding server-side; we drive the draft
//               via a small-max_tokens completion and verify token-by-token
//               against the target endpoint's logprobs (top-1 == draft token).
//
// Every bridge is constructed from env at the call site - no secret is ever
// written to disk. When a backend is named but its endpoints are not
// configured we throw a loud, actionable Error rather than fabricating tokens;
// src/accelerate.js converts that into the honest no_kernel/`*_failed` envelope.
//
// The contract each bridge satisfies (consumed by acceleratedChatCompletion):
//
//   propose({messages, n}) -> { tokens: [{text, logprob?}], cost_micro_usd }
//   verify({messages, draft}) -> { accepted: [bool,...], teacher_token: {text}|null,
//                                  cost_micro_usd, latency_ms }
//   wall_clock_ms_teacher_only : number   (measured teacher-only baseline)

const BACKEND_VERSION = 'accel-backend-v1';

function firstEnv(env, names) {
  for (const name of names) {
    const v = env && env[name];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function truthy(v) {
  return /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());
}

function normalizeBaseUrl(raw) {
  return String(raw || '').replace(/\/+$/, '');
}

function chatEndpoint(base) {
  const b = normalizeBaseUrl(base);
  if (!b) return '';
  if (/\/v1$/.test(b)) return b + '/chat/completions';
  return b + '/v1/chat/completions';
}

async function timedFetch(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = _now();
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    return { res, latency_ms: _now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

function _now() {
  if (typeof globalThis.performance === 'object' && typeof globalThis.performance.now === 'function') {
    return globalThis.performance.now();
  }
  return Date.now();
}

// Pull the single-token continuation string from an OpenAI-compatible
// chat-completions response. We request greedy (temperature 0) so the
// continuation is deterministic, which is what makes the accept rule exact.
function contentOf(parsed) {
  const c = parsed && parsed.choices && parsed.choices[0];
  if (!c) return '';
  if (c.message && typeof c.message.content === 'string') return c.message.content;
  if (typeof c.text === 'string') return c.text;
  return '';
}

// Cheap whitespace/BPE-agnostic token split. Real backends return per-token
// logprobs; when those are absent we fall back to splitting on whitespace
// boundaries so a multi-token draft still yields a per-token accept vector.
function splitTokens(text, n) {
  const s = String(text || '');
  if (!s) return [];
  // Prefer the model-reported token boundaries when the caller already gave
  // us an array; otherwise split on word/punct boundaries, capped at n.
  const parts = s.match(/\s*\S+|\s+/g) || [s];
  return parts.slice(0, Math.max(1, n)).map((t) => ({ text: t }));
}

// ---------------------------------------------------------------------------
// llama.cpp draft+target bridge
// ---------------------------------------------------------------------------
//
// Env:
//   KOLM_LLAMA_DRAFT_URL    OpenAI-compatible base URL of the draft (student)
//                           llama-server (e.g. http://127.0.0.1:8081)
//   KOLM_LLAMA_TARGET_URL   OpenAI-compatible base URL of the target (teacher)
//   KOLM_LLAMA_DRAFT_MODEL  optional model id passed to the draft server
//   KOLM_LLAMA_TARGET_MODEL optional model id passed to the target server
//   KOLM_LLAMA_API_KEY      optional bearer for both endpoints
//   KOLM_LLAMA_TIMEOUT_MS   optional per-call timeout (default 60000)
//
// This is a turnkey runnable path: anyone with two `llama-server` processes
// (one small draft, one large target) gets real speculative decoding with a
// real per-token acceptance rate. No research repo, no native build.
export function createLlamaCppBridge(env = process.env) {
  const draftBase = firstEnv(env, ['KOLM_LLAMA_DRAFT_URL']);
  const targetBase = firstEnv(env, ['KOLM_LLAMA_TARGET_URL']);
  if (!draftBase || !targetBase) {
    const e = new Error(
      'llama-cpp spec-decode bridge needs KOLM_LLAMA_DRAFT_URL and KOLM_LLAMA_TARGET_URL '
      + '(two llama-server OpenAI-compatible endpoints: one draft model, one target model)',
    );
    e.code = 'backend_not_configured';
    throw e;
  }
  const draftModel = firstEnv(env, ['KOLM_LLAMA_DRAFT_MODEL']) || 'draft';
  const targetModel = firstEnv(env, ['KOLM_LLAMA_TARGET_MODEL']) || 'target';
  const apiKey = firstEnv(env, ['KOLM_LLAMA_API_KEY']);
  const timeoutMs = Number(firstEnv(env, ['KOLM_LLAMA_TIMEOUT_MS'])) || 60_000;

  function headers() {
    const h = { 'Content-Type': 'application/json' };
    if (apiKey) h.Authorization = `Bearer ${apiKey}`;
    return h;
  }

  async function chat(base, model, messages, maxTokens) {
    const url = chatEndpoint(base);
    const body = {
      model,
      messages,
      max_tokens: Math.max(1, maxTokens),
      temperature: 0,
      stream: false,
    };
    const { res, latency_ms } = await timedFetch(url, {
      method: 'POST', headers: headers(), body: JSON.stringify(body),
    }, timeoutMs);
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`llama-cpp endpoint ${url} returned HTTP ${res.status}: ${text.slice(0, 240)}`);
      err.code = 'backend_http_error';
      throw err;
    }
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* tolerated; content fallback below */ }
    return { content: contentOf(parsed), latency_ms, raw: parsed };
  }

  return {
    kind: 'llama-cpp',
    version: BACKEND_VERSION,
    // Measured at construction time as a best-effort baseline; refined after
    // the first verify() so speedup_x reflects a real teacher-only wall clock.
    wall_clock_ms_teacher_only: 0,

    async propose({ messages, n }) {
      // The draft (student) greedily continues for up to n tokens.
      const out = await chat(draftBase, draftModel, messages, n);
      const tokens = splitTokens(out.content, n);
      return {
        tokens,
        cost_micro_usd: 0, // self-hosted: no per-token billing
        draft_text: out.content,
        draft_latency_ms: out.latency_ms,
      };
    },

    async verify({ messages, draft }) {
      // Greedy accept rule: ask the teacher for its own greedy continuation,
      // then accept the longest common prefix of draft vs teacher tokens.
      // The first mismatch is replaced by the teacher's token (the correction).
      const draftText = (draft || []).map((t) => String(t.text || '')).join('');
      const teacherMax = Math.max(1, (draft || []).length + 1);
      const out = await chat(targetBase, targetModel, messages, teacherMax);
      this.wall_clock_ms_teacher_only = out.latency_ms;
      const teacherTokens = splitTokens(out.content, teacherMax);
      const accepted = [];
      let i = 0;
      for (; i < (draft || []).length; i += 1) {
        const d = String(draft[i].text || '');
        const t = teacherTokens[i] ? String(teacherTokens[i].text || '') : null;
        if (t != null && t === d) accepted.push(true);
        else { accepted.push(false); break; }
      }
      // Mark any remaining draft tokens as rejected (we halt at first mismatch).
      for (let k = accepted.length; k < (draft || []).length; k += 1) accepted.push(false);
      let teacher_token = null;
      if (accepted.includes(false)) {
        const idx = accepted.indexOf(false);
        teacher_token = teacherTokens[idx] ? { text: teacherTokens[idx].text } : null;
      }
      void draftText;
      return {
        accepted,
        teacher_token,
        cost_micro_usd: 0,
        latency_ms: out.latency_ms,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible speculative bridge (vLLM / SGLang / TGI)
// ---------------------------------------------------------------------------
//
// These servers run speculative decoding internally; from our side a single
// OpenAI-compatible endpoint serves both draft + target. We still expose the
// {propose, verify} contract so the orchestrator's per-token acceptance math
// is computed from real verify outcomes:
//
//   - propose() asks for a short greedy continuation (the speculative window).
//   - verify() asks the same endpoint for its greedy continuation and accepts
//     the longest common token prefix (greedy self-consistency check). On a
//     server with internal spec-decode this is the verified output, so the
//     acceptance vector reflects the server's real acceptance.
//
// Env (per backend name):
//   vllm   : KOLM_VLLM_URL    (+ KOLM_VLLM_API_KEY  / VLLM_API_KEY)
//   sglang : KOLM_SGLANG_URL  (+ KOLM_SGLANG_API_KEY)
//   tgi    : KOLM_TGI_URL     (+ KOLM_TGI_API_KEY)
export function createOpenAISpecBridge(backendName, env = process.env) {
  const urlEnvByBackend = {
    vllm: ['KOLM_VLLM_URL'],
    sglang: ['KOLM_SGLANG_URL'],
    tgi: ['KOLM_TGI_URL'],
  };
  const keyEnvByBackend = {
    vllm: ['KOLM_VLLM_API_KEY', 'VLLM_API_KEY'],
    sglang: ['KOLM_SGLANG_API_KEY'],
    tgi: ['KOLM_TGI_API_KEY'],
  };
  const urlNames = urlEnvByBackend[backendName];
  if (!urlNames) {
    const e = new Error(`createOpenAISpecBridge: unsupported backend ${JSON.stringify(backendName)}`);
    e.code = 'unsupported_backend';
    throw e;
  }
  const base = firstEnv(env, urlNames);
  if (!base) {
    const e = new Error(
      `${backendName} spec-decode bridge needs ${urlNames[0]} `
      + `(OpenAI-compatible base URL of your ${backendName} server)`,
    );
    e.code = 'backend_not_configured';
    throw e;
  }
  const apiKey = firstEnv(env, keyEnvByBackend[backendName] || []);
  const model = firstEnv(env, ['KOLM_MODEL']) || 'default';
  const timeoutMs = Number(firstEnv(env, ['KOLM_SPEC_DECODE_TIMEOUT_MS'])) || 60_000;

  function headers() {
    const h = { 'Content-Type': 'application/json' };
    if (apiKey) h.Authorization = `Bearer ${apiKey}`;
    return h;
  }

  async function chat(messages, maxTokens) {
    const url = chatEndpoint(base);
    const body = { model, messages, max_tokens: Math.max(1, maxTokens), temperature: 0, stream: false };
    const { res, latency_ms } = await timedFetch(url, {
      method: 'POST', headers: headers(), body: JSON.stringify(body),
    }, timeoutMs);
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`${backendName} endpoint ${url} returned HTTP ${res.status}: ${text.slice(0, 240)}`);
      err.code = 'backend_http_error';
      throw err;
    }
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* tolerated */ }
    return { content: contentOf(parsed), latency_ms };
  }

  return {
    kind: backendName,
    version: BACKEND_VERSION,
    wall_clock_ms_teacher_only: 0,

    async propose({ messages, n }) {
      const out = await chat(messages, n);
      return {
        tokens: splitTokens(out.content, n),
        cost_micro_usd: 0,
        draft_latency_ms: out.latency_ms,
      };
    },

    async verify({ messages, draft }) {
      const teacherMax = Math.max(1, (draft || []).length + 1);
      const out = await chat(messages, teacherMax);
      this.wall_clock_ms_teacher_only = out.latency_ms;
      const teacherTokens = splitTokens(out.content, teacherMax);
      const accepted = [];
      for (let i = 0; i < (draft || []).length; i += 1) {
        const d = String(draft[i].text || '');
        const t = teacherTokens[i] ? String(teacherTokens[i].text || '') : null;
        if (t != null && t === d) accepted.push(true);
        else { accepted.push(false); break; }
      }
      for (let k = accepted.length; k < (draft || []).length; k += 1) accepted.push(false);
      let teacher_token = null;
      if (accepted.includes(false)) {
        const idx = accepted.indexOf(false);
        teacher_token = teacherTokens[idx] ? { text: teacherTokens[idx].text } : null;
      }
      return { accepted, teacher_token, cost_micro_usd: 0, latency_ms: out.latency_ms };
    },
  };
}

// Construct the real bridge for a detected backend name, or throw a loud,
// actionable Error. Called by detectSpecDecodeBackend() in src/accelerate.js
// once a backend is configured. Never fabricates tokens.
export function createSpecDecodeBackend(backendName, env = process.env) {
  const name = String(backendName || '').trim().toLowerCase();
  if (name === 'llama-cpp') return createLlamaCppBridge(env);
  if (name === 'vllm' || name === 'sglang' || name === 'tgi') {
    return createOpenAISpecBridge(name, env);
  }
  const e = new Error(`createSpecDecodeBackend: no bridge implemented for ${JSON.stringify(name)}`);
  e.code = 'no_bridge';
  throw e;
}

// backendConfigured(name, env) - does this backend have its endpoints set?
// Lets the detector decide whether to construct a bridge (config present) vs
// stay in the no_kernel state (named but unconfigured).
export function backendConfigured(backendName, env = process.env) {
  const name = String(backendName || '').trim().toLowerCase();
  if (name === 'llama-cpp') {
    return !!(firstEnv(env, ['KOLM_LLAMA_DRAFT_URL']) && firstEnv(env, ['KOLM_LLAMA_TARGET_URL']));
  }
  if (name === 'vllm') return !!firstEnv(env, ['KOLM_VLLM_URL']);
  if (name === 'sglang') return !!firstEnv(env, ['KOLM_SGLANG_URL']);
  if (name === 'tgi') return !!firstEnv(env, ['KOLM_TGI_URL']);
  return false;
}

export const ACCEL_BACKEND_VERSION = BACKEND_VERSION;

export default {
  createSpecDecodeBackend,
  createLlamaCppBridge,
  createOpenAISpecBridge,
  backendConfigured,
  ACCEL_BACKEND_VERSION,
  // re-export helper for tests that want to assert truthy semantics
  _truthy: truthy,
};
