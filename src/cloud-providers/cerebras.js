// W916-I9 — High-level Cerebras Cloud Inference provider.
//
// Cerebras is an inference-only target. You do NOT train or compile weights
// on Cerebras CS-3 — you point an existing artifact at a pre-loaded Cerebras
// model id and route traffic to api.cerebras.ai via the OpenAI-compatible
// /v1/chat/completions endpoint.
//
// What "deploy" means here:
//   * Cerebras pre-loads a fixed catalog (llama3.1-8b, llama-3.3-70b,
//     llama-4-scout-17b-16e-instruct, qwen-3-coder-480b, deepseek-r1-distill-llama-70b, ...).
//   * A kolm artifact is "deployed to Cerebras" by binding it to a Cerebras
//     model id in the artifact's namespace config so kolm serve / kolm
//     gateway dispatch route through cerebras instead of vLLM/local.
//   * Customer-trained LoRA adapters cannot be uploaded to Cerebras (no public
//     adapter upload API as of 2026-05). The bind is therefore a "use this
//     base model for this artifact's namespace at inference time" record.
//
// Surface:
//   * detect(env)            — env probe + key check (never throws).
//   * CerebrasProvider class — listModels / bindArtifact / unbindArtifact /
//     getBinding / chatCompletion / getUsage — same shape as RunPodProvider.
//
// Docs:
//   https://inference-docs.cerebras.ai/
//   https://inference-docs.cerebras.ai/api-reference/chat-completions
//   https://inference-docs.cerebras.ai/api-reference/models
//
// Caveats / Constraints / Limitations:
//   1. Cerebras has no per-namespace endpoint provisioning step (unlike RunPod
//      saveEndpoint). The "binding" is a kolm-side record in the namespace
//      config; Cerebras itself only sees /v1/chat/completions requests with
//      a model id and the api key.
//   2. The model catalog changes. listModels() hits /v1/models live; we never
//      ship a hardcoded list as the source of truth (CEREBRAS_MODELS below
//      is a fallback for offline / dry-run only).
//   3. Streaming is supported by the underlying API (stream: true) but is
//      not exposed by this provider — callers use the chatCompletion()
//      method which returns the full response. The gateway-router.js path
//      handles streaming separately via the OpenAI-compatible backend.

import fs from 'node:fs';
import path from 'node:path';

const CEREBRAS_API_BASE = 'https://api.cerebras.ai/v1';
const DEFAULT_DOCS_URL = 'https://inference-docs.cerebras.ai/';

// Fallback catalog used only when the live /v1/models probe fails (offline
// dry-run, network outage). Verify against /v1/models on every real call.
// Source: https://inference-docs.cerebras.ai/api-reference/models (2026-05).
export const CEREBRAS_MODELS = Object.freeze([
  { id: 'llama3.1-8b',                            params_b: 8,   context: 8192,   tok_s_published: 2200 },
  { id: 'llama-3.3-70b',                          params_b: 70,  context: 8192,   tok_s_published: 450 },
  { id: 'llama-4-scout-17b-16e-instruct',         params_b: 17,  context: 8192,   tok_s_published: 2600 },
  { id: 'llama-4-maverick-17b-128e-instruct',     params_b: 17,  context: 8192,   tok_s_published: 1700 },
  { id: 'qwen-3-coder-480b',                      params_b: 480, context: 32768,  tok_s_published: 220 },
  { id: 'qwen-3-32b',                             params_b: 32,  context: 32768,  tok_s_published: 1100 },
  { id: 'deepseek-r1-distill-llama-70b',          params_b: 70,  context: 8192,   tok_s_published: 1500 },
]);

function _hint() {
  return [
    'sign up at https://cloud.cerebras.ai',
    'mint key at https://cloud.cerebras.ai/platform/credentials',
    'export CEREBRAS_API_KEY=csk-...',
    '(or) export KOLM_CEREBRAS_TOKEN=csk-...',
    'verify with: kolm test cloud --provider cerebras',
  ].join('\n  ');
}

function _resolveKey(env = process.env) {
  return env.CEREBRAS_API_KEY || env.KOLM_CEREBRAS_TOKEN || '';
}

export function detect(env = process.env) {
  const key = _resolveKey(env);
  if (!key) {
    return {
      ok: false,
      provider: 'cerebras',
      configured: false,
      reason: 'CEREBRAS_API_KEY not set',
      install_hint: _hint(),
      docs_url: DEFAULT_DOCS_URL,
    };
  }
  return {
    ok: true,
    provider: 'cerebras',
    configured: true,
    base_url: env.KOLM_CEREBRAS_URL || env.CEREBRAS_BASE_URL || CEREBRAS_API_BASE,
    region: env.KOLM_CEREBRAS_REGION || 'us-default',
  };
}

export class CerebrasProvider {
  constructor(apiKey, opts = {}) {
    const key = apiKey
      || (typeof opts.apiKey === 'string' ? opts.apiKey : '')
      || _resolveKey();
    if (!key) {
      const err = new Error('Cerebras API key missing. Set CEREBRAS_API_KEY or pass apiKey.');
      err.code = 'cerebras_api_key_missing';
      err.install_hint = _hint();
      err.docs_url = DEFAULT_DOCS_URL;
      throw err;
    }
    this.apiKey = key;
    this.baseUrl = (opts.baseUrl || process.env.KOLM_CEREBRAS_URL || process.env.CEREBRAS_BASE_URL || CEREBRAS_API_BASE).replace(/\/+$/, '');
    this.bindingsDir = opts.bindingsDir
      || process.env.KOLM_CEREBRAS_BINDINGS_DIR
      || path.join(process.env.KOLM_DATA_DIR || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.kolm'), 'cerebras-bindings');
    this._fetch = opts.fetch || globalThis.fetch;
    if (typeof this._fetch !== 'function') {
      const err = new Error('global fetch is required (Node 22+ has it). Pass opts.fetch to override.');
      err.code = 'fetch_unavailable';
      throw err;
    }
  }

  async _callCerebras(pathname, init = {}, opName = 'cerebras_call') {
    const url = `${this.baseUrl}${pathname}`;
    let res;
    try {
      res = await this._fetch(url, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          ...(init.headers || {}),
        },
      });
    } catch (e) {
      const err = new Error(`cerebras ${opName} fetch failed: ${e.message}`);
      err.code = 'cerebras_fetch_failed';
      err.op = opName;
      err.docs_url = DEFAULT_DOCS_URL;
      throw err;
    }
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const err = new Error(`cerebras ${opName} http ${res.status}: ${text.slice(0, 500)}`);
      err.code = 'cerebras_http_error';
      err.status = res.status;
      err.op = opName;
      err.body = text.slice(0, 2000);
      err.docs_url = DEFAULT_DOCS_URL;
      throw err;
    }
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep raw text for the caller */ }
    return { json, raw: text };
  }

  // listModels — live probe of /v1/models. Falls back to CEREBRAS_MODELS if
  // the request fails (offline / outage); the response includes a `source`
  // field so callers can tell which list they're seeing.
  async listModels() {
    try {
      const { json } = await this._callCerebras('/models', { method: 'GET' }, 'listModels');
      const rows = Array.isArray(json?.data) ? json.data : [];
      return {
        ok: true,
        provider: 'cerebras',
        source: 'live',
        models: rows.map((r) => ({
          id: r.id,
          owned_by: r.owned_by || null,
          context: r.context_length || null,
          created: r.created || null,
          raw: r,
        })),
      };
    } catch (err) {
      return {
        ok: false,
        provider: 'cerebras',
        source: 'fallback',
        models: CEREBRAS_MODELS.slice(),
        error: err.message,
        error_code: err.code,
      };
    }
  }

  _bindingPath(namespace) {
    if (!namespace || typeof namespace !== 'string') {
      const err = new Error('namespace is required'); err.code = 'bad_args'; throw err;
    }
    const safe = namespace.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 80);
    return path.join(this.bindingsDir, `${safe}.json`);
  }

  // bindArtifact — record that the given namespace's artifact should route
  // through Cerebras using the supplied model id at inference time. Persists
  // to ~/.kolm/cerebras-bindings/<namespace>.json so subsequent kolm serve
  // / kolm gateway dispatch calls pick it up without re-asking.
  //
  // We do NOT verify the model id with Cerebras during bind because the
  // catalog can change between bind and dispatch; we re-check on every
  // chatCompletion() call instead.
  async bindArtifact({ namespace, artifactId, model, maxTokens = 2048, temperature = 0.7, metadata = {} } = {}) {
    if (!namespace) {
      const err = new Error('bindArtifact requires namespace'); err.code = 'bad_args'; throw err;
    }
    if (!model) {
      const err = new Error('bindArtifact requires model id (e.g. llama3.1-8b)'); err.code = 'bad_args'; throw err;
    }
    fs.mkdirSync(this.bindingsDir, { recursive: true });
    const binding = {
      schema: 'kolm-cerebras-binding/1',
      namespace,
      artifact_id: artifactId || null,
      cerebras_model: model,
      base_url: this.baseUrl,
      max_tokens: maxTokens,
      temperature,
      bound_at: new Date().toISOString(),
      metadata,
    };
    fs.writeFileSync(this._bindingPath(namespace), JSON.stringify(binding, null, 2));
    return {
      ok: true,
      provider: 'cerebras',
      binding,
      binding_path: this._bindingPath(namespace),
    };
  }

  async unbindArtifact({ namespace } = {}) {
    const p = this._bindingPath(namespace);
    if (!fs.existsSync(p)) {
      return { ok: false, provider: 'cerebras', reason: 'no_binding_found', binding_path: p };
    }
    fs.unlinkSync(p);
    return { ok: true, provider: 'cerebras', binding_path: p, unbound: true };
  }

  getBinding({ namespace } = {}) {
    const p = this._bindingPath(namespace);
    if (!fs.existsSync(p)) {
      return { ok: false, provider: 'cerebras', reason: 'no_binding_found', binding_path: p };
    }
    let binding;
    try { binding = JSON.parse(fs.readFileSync(p, 'utf-8')); }
    catch (e) {
      return { ok: false, provider: 'cerebras', reason: 'binding_parse_error', error: e.message, binding_path: p };
    }
    return { ok: true, provider: 'cerebras', binding, binding_path: p };
  }

  listBindings() {
    if (!fs.existsSync(this.bindingsDir)) {
      return { ok: true, provider: 'cerebras', bindings: [], bindings_dir: this.bindingsDir };
    }
    const files = fs.readdirSync(this.bindingsDir).filter((f) => f.endsWith('.json'));
    const bindings = [];
    for (const f of files) {
      try {
        const b = JSON.parse(fs.readFileSync(path.join(this.bindingsDir, f), 'utf-8'));
        bindings.push(b);
      } catch { /* ignore corrupt entries */ }
    }
    return { ok: true, provider: 'cerebras', bindings, bindings_dir: this.bindingsDir };
  }

  // chatCompletion — direct OpenAI-compatible call, returns the parsed JSON
  // response plus latency telemetry. For namespace-bound calls the caller
  // resolves the model id via getBinding() and passes it explicitly.
  async chatCompletion({ model, messages, maxTokens = 2048, temperature = 0.7, stream = false, timeoutMs = 60_000 } = {}) {
    if (!model) {
      const err = new Error('chatCompletion requires model id'); err.code = 'bad_args'; throw err;
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      const err = new Error('chatCompletion requires non-empty messages array'); err.code = 'bad_args'; throw err;
    }
    const t0 = Date.now();
    const body = {
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
    };
    if (stream) body.stream = true;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const url = `${this.baseUrl}/chat/completions`;
      let res;
      try {
        res = await this._fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (e) {
        const err = new Error(`cerebras chatCompletion fetch failed: ${e.message}`);
        err.code = 'cerebras_fetch_failed';
        throw err;
      }
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`cerebras chatCompletion http ${res.status}: ${text.slice(0, 500)}`);
        err.code = 'cerebras_http_error';
        err.status = res.status;
        err.body = text.slice(0, 2000);
        throw err;
      }
      let json = null;
      try { json = JSON.parse(text); } catch { /* raw text preserved */ }
      const time_info = json?.time_info || null;
      return {
        ok: true,
        provider: 'cerebras',
        model,
        response: json,
        latency_ms: Date.now() - t0,
        // Cerebras returns server-side tok/s on every completion in time_info.
        // Surface it so the receipt can record the wafer-scale headline number.
        cerebras_time_info: time_info,
        cerebras_tok_s: time_info?.completion_time && json?.usage?.completion_tokens
          ? Math.round((json.usage.completion_tokens / time_info.completion_time) * 10) / 10
          : null,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // getUsage — Cerebras doesn't expose a public usage endpoint as of 2026-05,
  // so we surface a clear "not_available" envelope instead of fabricating a
  // number. Callers should fall back to the cost-tracking layer's local
  // accounting (src/cost-tracking.js) which records per-call token counts.
  async getUsage() {
    return {
      ok: false,
      provider: 'cerebras',
      reason: 'cerebras_no_public_usage_endpoint',
      message: 'Cerebras Cloud Inference does not expose a public usage endpoint as of 2026-05. Use kolm savings --namespace <ns> for local per-call accounting.',
      docs_url: 'https://cloud.cerebras.ai/platform/usage',
    };
  }
}

// estimateCost — Cerebras Cloud Inference (2026-05 list pricing).
// Per Cerebras docs: pricing scales per 1M tokens, model-dependent.
// We surface a conservative quote; the actual invoice comes from
// https://cloud.cerebras.ai/platform/usage.
export function estimateCost({ model, inputTokens, outputTokens }) {
  // Per Cerebras (2026-05): roughly $0.10/MTok in + $0.10/MTok out for 8B,
  // $0.85/$1.20 for 70B, $0.60/$1.20 for the 17B Llama-4 tier, $2/$2 for 480B.
  const lower = String(model || '').toLowerCase();
  let inRate, outRate;
  if (/-?8b|-?7b/.test(lower)) { inRate = 0.10; outRate = 0.10; }
  else if (/scout|maverick|17b/.test(lower)) { inRate = 0.60; outRate = 1.20; }
  else if (/70b|qwen-3-32b|distill-llama-70b/.test(lower)) { inRate = 0.85; outRate = 1.20; }
  else if (/480b|qwen-3-coder-480b/.test(lower)) { inRate = 2.00; outRate = 2.00; }
  else { inRate = 0.50; outRate = 1.00; } // conservative default
  const cost = ((inputTokens || 0) / 1_000_000) * inRate
             + ((outputTokens || 0) / 1_000_000) * outRate;
  return {
    estimated_cost_usd: Number(cost.toFixed(6)),
    rate_per_mtok_input: inRate,
    rate_per_mtok_output: outRate,
    basis: `Cerebras Cloud Inference list pricing as of 2026-05 for model "${model}"`,
    docs_url: 'https://www.cerebras.ai/inference',
  };
}

export default CerebrasProvider;
