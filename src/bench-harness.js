// src/bench-harness.js
//
// S-4 (V1 launch) — multi-model benchmark harness.
//
// Runs the same eval suite (from src/bench-eval-suites.js) across N model
// endpoints and produces a "model rows × metric columns" comparison report
// in BOTH JSON and Markdown. Output shape mirrors the W869 trinity-500
// comparison so existing benchmark consumers keep parsing.
//
// Public surface (exported):
//   - runBench({ suiteId, models, n, outDir, prompt_override, dry_run, ... })
//   - listSuites()      // re-export from bench-eval-suites
//   - validateSuite()   // re-export from bench-eval-suites
//   - buildMarkdownReport({ rows, suite, n, ts, opts? })
//
// Each `models[]` entry is either a string ("trinity-500") that maps via
// resolveModelTarget() to a transport, or a fully-specified
//   { id, transport: 'gateway'|'direct'|'local-gguf'|'fake', provider, model, ... }
// object the caller wants to inject directly.
//
// Constraints (USER-MANDATED, non-negotiable):
//   - Never use the forbidden h-word (see MEMORY) — use Caveats / Limitations.
//   - No browns/beiges/oranges anywhere (no inline HTML colors).
//   - No emojis.
//   - --dry-run path produces a stub report without needing any API keys.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import {
  listSuites as suitesList,
  getSuite,
  validateSuite as suitesValidate,
  METRIC_REGISTRY,
} from './bench-eval-suites.js';

// Re-export so callers have one entry point.
export const listSuites = suitesList;
export const validateSuite = suitesValidate;
export { METRIC_REGISTRY };

// ---------------------------------------------------------------------------
// runBench — the top-level harness entry.
// ---------------------------------------------------------------------------
export async function runBench(opts = {}) {
  const {
    suiteId,
    models,
    n,
    outDir,
    prompt_override,
    dry_run = false,
    bearer = process.env.KOLM_API_KEY || '',
    base   = process.env.KOLM_BASE_URL || 'https://kolm.ai',
    judge,                   // optional injected judge function (for tests)
    transport_factory,       // optional override for unit tests
    timestamp,               // optional fixed ISO for deterministic golden output
  } = opts;

  if (!suiteId || typeof suiteId !== 'string') {
    throw new Error('runBench: suiteId is required');
  }
  const suite = getSuite(suiteId);
  if (!suite) {
    throw new Error(`runBench: unknown suite "${suiteId}"`);
  }
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('runBench: models[] must be a non-empty array');
  }

  // Allow caller to override the prompt set (e.g. run a 5-prompt sample for
  // smoke). The override REPLACES suite.prompts when provided.
  if (prompt_override !== undefined) {
    if (!Array.isArray(prompt_override) || prompt_override.length === 0) {
      throw new Error('runBench: prompt_override, when present, must be a non-empty array');
    }
    suite.prompts = prompt_override.map((p, i) => {
      if (typeof p === 'string') {
        return { id: `ov-${String(i + 1).padStart(3, '0')}`, text: p, expected_traits: [] };
      }
      return p;
    });
  }

  // Cap prompt count via opts.n if requested.
  if (Number.isFinite(n) && n > 0 && n < suite.prompts.length) {
    suite.prompts = suite.prompts.slice(0, n);
  }
  const N = suite.prompts.length;

  // Resolve each model spec to a callable target.
  const targets = models.map((m) => resolveModelTarget(m, { bearer, base, transport_factory }));

  // Run each target sequentially over the suite. Inter-target ordering
  // doesn't matter (no shared state), but per-target we walk the prompts
  // in order so latency samples are commensurate with the suite definition.
  const rows = [];
  const per_model_samples = {};
  for (const t of targets) {
    const result = await runSuiteAgainstTarget({
      suite,
      target: t,
      dry_run,
      judge: judge || defaultJudge,
    });
    rows.push(result.row);
    per_model_samples[t.id] = result.samples;
  }

  const ts = timestamp || new Date().toISOString();

  const comparison_md = buildMarkdownReport({ rows, suite, n: N, ts, dry_run });

  // Write artifacts when an outDir is supplied. We do NOT make the directory
  // implicitly — caller decides.
  let comparison_json_path = null;
  let comparison_md_path   = null;
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = ts.replace(/[:.]/g, '-');
    comparison_json_path = path.join(outDir, `${suite.id}-${stamp}.json`);
    comparison_md_path   = path.join(outDir, `${suite.id}-${stamp}.md`);
    const jsonPayload = {
      spec: 'kolm-bench-compare-1',
      suite: { id: suite.id, description: suite.description, n: N, metrics: suite.metrics },
      ran_at: ts,
      dry_run,
      models: rows,
      per_model_samples,
    };
    fs.writeFileSync(comparison_json_path, JSON.stringify(jsonPayload, null, 2) + '\n');
    fs.writeFileSync(comparison_md_path, comparison_md);
  }

  return {
    suite: { id: suite.id, description: suite.description, n: N, metrics: [...suite.metrics] },
    models: rows,
    comparison_md,
    comparison_json_path,
    comparison_md_path,
    ran_at: ts,
    dry_run,
  };
}

// ---------------------------------------------------------------------------
// buildMarkdownReport — emit the W869-shape markdown table + Caveats section.
// ---------------------------------------------------------------------------
export function buildMarkdownReport({ rows, suite, n, ts, dry_run = false, opts = {} } = {}) {
  if (!suite) throw new Error('buildMarkdownReport: suite is required');
  if (!Array.isArray(rows)) throw new Error('buildMarkdownReport: rows[] is required');
  const metrics = Array.isArray(suite.metrics) ? suite.metrics : [];

  const lines = [];
  lines.push(`# ${suite.id} comparison — ${ts || new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push(`Suite: ${suite.id} (${suite.description})`);
  lines.push(`Prompts: N=${n}`);
  if (dry_run) lines.push('');
  if (dry_run) lines.push('> **Mode: dry-run.** No upstream calls were made. Values below are deterministic stubs.');
  lines.push('');

  // Header row.
  const headerCells = ['model', ...metrics.map(formatMetricHeader)];
  const aligns = ['---', ...metrics.map((m) => alignFor(m))];
  lines.push(`| ${headerCells.join(' | ')} |`);
  lines.push(`| ${aligns.join(' | ')} |`);

  for (const r of rows) {
    const cells = [escapeMd(r.id)];
    for (const m of metrics) {
      cells.push(formatMetricCell(m, r[m]));
    }
    lines.push(`| ${cells.join(' | ')} |`);
  }

  lines.push('');
  lines.push('## Caveats');
  lines.push('');
  lines.push('- Latency samples are wall-clock (ms) and include any wrapper / proxy hops.');
  lines.push('- `cost_per_1k_usd` is computed from published per-token rates and the response usage block; missing usage data yields 0.');
  lines.push('- Behavior rates (`asks_one_question_rate`, `judge_*`) come from a lightweight grader; the W869 study uses Gemini-2.5-Pro as the judge — wire the same judge via the `judge` option for reproducibility.');
  lines.push('- Sample sizes are small by default (suite size); for production claims rerun with `--n 200` or larger and report a confidence interval.');
  if (dry_run) {
    lines.push('- This run was performed in dry-run mode; no upstream provider was invoked. Re-run without `--dry-run` for live numbers.');
  }
  lines.push('');

  if (opts.include_raw_link && opts.raw_link) {
    lines.push(`Raw: [${opts.raw_link}](${opts.raw_link})`);
    lines.push('');
  }

  return lines.join('\n');
}

function formatMetricHeader(m) {
  // Pretty header per metric id. We don't fight the metric id — readers
  // grepping for `mean_ms` need to find it in the rendered output too.
  const meta = METRIC_REGISTRY[m];
  if (!meta) return m;
  const unit = meta.unit ? ` (${meta.unit})` : '';
  return `${m}${unit}`;
}

function alignFor(m) {
  const meta = METRIC_REGISTRY[m];
  if (!meta) return '---';
  if (meta.kind === 'latency' || meta.kind === 'cost' || meta.kind === 'shape' || meta.kind === 'correctness' || meta.kind === 'behavior' || meta.kind === 'safety') {
    return '---:';
  }
  return '---';
}

function formatMetricCell(m, v) {
  if (v == null || Number.isNaN(v)) return '-';
  const meta = METRIC_REGISTRY[m];
  if (!meta) return String(v);
  if (meta.kind === 'latency') return String(Math.round(Number(v)));
  if (meta.kind === 'shape' && meta.unit === 'chars') return String(Math.round(Number(v)));
  if (meta.kind === 'shape' && meta.unit === 'ratio') return Number(v).toFixed(2);
  if (meta.kind === 'cost')   return `$${Number(v).toFixed(4)}`;
  if (meta.kind === 'behavior' || meta.kind === 'safety' || meta.kind === 'correctness') {
    return Number(v).toFixed(3);
  }
  return String(v);
}

function escapeMd(s) {
  return String(s).replace(/\|/g, '\\|');
}

// ---------------------------------------------------------------------------
// resolveModelTarget — string id OR full spec → { id, transport, send() }.
//
// Recognized string shapes:
//   "trinity-500"                 → local gateway → trinity (via kolm gateway)
//   "claude-haiku-4-5"            → direct anthropic
//   "gpt-4o-mini"                 → direct openai
//   "deepseek-chat"               → direct deepseek
//   "gemini-2.5-flash"            → direct google
//   "ollama:llama3.2:1b"          → local-ollama
//   "vllm:meta-llama/Llama-3.1-8B" → local-vllm
//   "gguf:/path/to/model.gguf"    → local-gguf (llama-cli)
//   "gateway:claude-haiku-4-5"    → force-route via kolm gateway /dispatch
//   "fake:canned"                 → fake adapter (testing)
//
// Returns { id, transport, provider, model, send(prompt) → { ms, text, in_tok, out_tok, error? } }.
// ---------------------------------------------------------------------------
export function resolveModelTarget(spec, ctx = {}) {
  if (ctx.transport_factory) {
    const made = ctx.transport_factory(spec, ctx);
    if (made) return made;
  }
  if (spec && typeof spec === 'object') return materializeObjectSpec(spec, ctx);

  const raw = String(spec || '').trim();
  if (!raw) throw new Error('resolveModelTarget: empty spec');

  // Prefixed forms first.
  if (raw.startsWith('fake:')) {
    const tag = raw.slice('fake:'.length) || 'canned';
    return makeFakeTarget({ id: raw, tag });
  }
  if (raw.startsWith('gateway:')) {
    const model = raw.slice('gateway:'.length);
    return makeGatewayTarget({ id: raw, model, ctx });
  }
  if (raw.startsWith('gguf:')) {
    const ggufPath = raw.slice('gguf:'.length);
    return makeLocalGgufTarget({ id: raw, ggufPath });
  }
  if (raw.startsWith('ollama:')) {
    const model = raw.slice('ollama:'.length);
    return makeOllamaTarget({ id: raw, model, ctx });
  }
  if (raw.startsWith('vllm:')) {
    const model = raw.slice('vllm:'.length);
    return makeVllmTarget({ id: raw, model, ctx });
  }
  if (raw.startsWith('local-kolm:')) {
    const model = raw.slice('local-kolm:'.length);
    return makeLocalKolmTarget({ id: raw, model, ctx });
  }
  if (raw === 'trinity-500' || raw === 'trinity') {
    // Trinity-500 runs via the gateway against the locally-served kolm
    // artifact. Caller can override via `gateway:trinity-500`.
    return makeGatewayTarget({ id: raw, model: 'trinity-500', ctx });
  }

  // Bare model name → infer provider.
  const provider = providerForBareModel(raw);
  if (provider === 'anthropic') return makeAnthropicTarget({ id: raw, model: raw, ctx });
  if (provider === 'openai')    return makeOpenAITarget   ({ id: raw, model: raw, ctx });
  if (provider === 'deepseek')  return makeDeepSeekTarget ({ id: raw, model: raw, ctx });
  if (provider === 'google')    return makeGoogleTarget   ({ id: raw, model: raw, ctx });

  // Unknown — return a target that fails per-call so the row shows the
  // limitation rather than crashing the whole bench.
  return makeUnknownTarget({ id: raw });
}

function providerForBareModel(m) {
  if (/^claude/i.test(m)) return 'anthropic';
  if (/^(gpt|o[134]|chatgpt)/i.test(m)) return 'openai';
  if (/^deepseek/i.test(m)) return 'deepseek';
  if (/^gemini/i.test(m)) return 'google';
  return 'unknown';
}

function materializeObjectSpec(spec, ctx) {
  const t = spec.transport || 'direct';
  const id = spec.id || `${t}:${spec.model || 'unspecified'}`;
  if (t === 'fake')        return makeFakeTarget({ id, tag: spec.tag, canned: spec.canned });
  if (t === 'gateway')     return makeGatewayTarget({ id, model: spec.model, ctx });
  if (t === 'local-gguf')  return makeLocalGgufTarget({ id, ggufPath: spec.path || spec.ggufPath });
  if (t === 'local-ollama' || t === 'ollama') return makeOllamaTarget({ id, model: spec.model, ctx });
  if (t === 'local-vllm'   || t === 'vllm')   return makeVllmTarget({ id, model: spec.model, ctx });
  if (t === 'local-kolm')  return makeLocalKolmTarget({ id, model: spec.model, ctx });
  if (t === 'direct') {
    const p = spec.provider || providerForBareModel(spec.model || '');
    if (p === 'anthropic') return makeAnthropicTarget({ id, model: spec.model, ctx });
    if (p === 'openai')    return makeOpenAITarget   ({ id, model: spec.model, ctx });
    if (p === 'deepseek')  return makeDeepSeekTarget ({ id, model: spec.model, ctx });
    if (p === 'google')    return makeGoogleTarget   ({ id, model: spec.model, ctx });
  }
  return makeUnknownTarget({ id });
}

// ---------------------------------------------------------------------------
// Target factories.
//
// Each factory returns { id, transport, provider, model, send(prompt) }
// where send() resolves to a uniform result envelope:
//   { ms, text, in_tok, out_tok, error?, raw? }
//
// Errors set `error` and leave numeric fields at 0 so summarize() doesn't NaN.
// ---------------------------------------------------------------------------
function makeFakeTarget({ id, tag = 'canned', canned = null }) {
  return {
    id,
    transport: 'fake',
    provider: 'fake',
    model: id,
    async send(prompt) {
      const t0 = nowMs();
      // Deterministic canned: sha-derived latency in [50,250] ms, response
      // length keyed off prompt length. Optionally caller-injected.
      const h = crypto.createHash('sha256').update(String(prompt) + ':' + tag).digest();
      const ms = 50 + (h[0] % 200);
      // Simulate elapsed time without actually sleeping (keeps unit tests fast).
      const text = canned != null
        ? String(canned)
        : `Could you clarify which order number you mean? I want to make sure I pull the right record before I help. (${tag})`;
      const elapsed = Math.max(nowMs() - t0, 0.1);
      return {
        ms: ms,                          // canned latency (deterministic)
        wall_ms: elapsed,                // real wall-clock for sanity
        text,
        in_tok: Math.ceil(String(prompt).length / 4),
        out_tok: Math.ceil(text.length / 4),
      };
    },
  };
}

function makeGatewayTarget({ id, model, ctx }) {
  return {
    id,
    transport: 'gateway',
    provider: 'kolm-gateway',
    model: model || id,
    async send(prompt) {
      return runViaGateway(model || id, prompt, ctx.bearer, ctx.base);
    },
  };
}

function makeAnthropicTarget({ id, model, ctx }) {
  return {
    id,
    transport: 'direct',
    provider: 'anthropic',
    model,
    async send(prompt) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return errorEnvelope('missing_anthropic_api_key');
      const t0 = nowMs();
      try {
        const res = await fetch(`${process.env.KOLM_UPSTREAM_ANTHROPIC_BASE || 'https://api.anthropic.com'}/v1/messages`, {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model,
            max_tokens: 512,
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        const ms = nowMs() - t0;
        const json = await safeJson(res);
        if (!res.ok) return errorEnvelope(`http_${res.status}`, { ms, raw: json });
        const text = (Array.isArray(json.content) ? json.content : [])
          .map((b) => b.text || '').join('').trim();
        return {
          ms, text,
          in_tok: Number(json.usage?.input_tokens || 0),
          out_tok: Number(json.usage?.output_tokens || 0),
          raw: json,
        };
      } catch (e) {
        return errorEnvelope(String(e.message || e), { ms: nowMs() - t0 });
      }
    },
  };
}

function makeOpenAITarget({ id, model, ctx }) {
  return {
    id,
    transport: 'direct',
    provider: 'openai',
    model,
    async send(prompt) {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) return errorEnvelope('missing_openai_api_key');
      const t0 = nowMs();
      try {
        const res = await fetch(`${process.env.KOLM_UPSTREAM_OPENAI_BASE || 'https://api.openai.com'}/v1/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 512,
          }),
        });
        const ms = nowMs() - t0;
        const json = await safeJson(res);
        if (!res.ok) return errorEnvelope(`http_${res.status}`, { ms, raw: json });
        const text = (json.choices?.[0]?.message?.content || '').trim();
        return {
          ms, text,
          in_tok: Number(json.usage?.prompt_tokens || 0),
          out_tok: Number(json.usage?.completion_tokens || 0),
          raw: json,
        };
      } catch (e) {
        return errorEnvelope(String(e.message || e), { ms: nowMs() - t0 });
      }
    },
  };
}

function makeDeepSeekTarget({ id, model, ctx }) {
  return {
    id,
    transport: 'direct',
    provider: 'deepseek',
    model,
    async send(prompt) {
      const apiKey = process.env.DEEPSEEK_API_KEY;
      if (!apiKey) return errorEnvelope('missing_deepseek_api_key');
      const t0 = nowMs();
      try {
        const res = await fetch(`${process.env.KOLM_UPSTREAM_DEEPSEEK_BASE || 'https://api.deepseek.com'}/v1/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 512,
          }),
        });
        const ms = nowMs() - t0;
        const json = await safeJson(res);
        if (!res.ok) return errorEnvelope(`http_${res.status}`, { ms, raw: json });
        const text = (json.choices?.[0]?.message?.content || '').trim();
        return {
          ms, text,
          in_tok: Number(json.usage?.prompt_tokens || 0),
          out_tok: Number(json.usage?.completion_tokens || 0),
          raw: json,
        };
      } catch (e) {
        return errorEnvelope(String(e.message || e), { ms: nowMs() - t0 });
      }
    },
  };
}

function makeGoogleTarget({ id, model, ctx }) {
  return {
    id,
    transport: 'direct',
    provider: 'gemini',
    model,
    async send(prompt) {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) return errorEnvelope('missing_gemini_api_key');
      const t0 = nowMs();
      try {
        const base = process.env.KOLM_UPSTREAM_GEMINI_BASE || 'https://generativelanguage.googleapis.com';
        const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 512 },
          }),
        });
        const ms = nowMs() - t0;
        const json = await safeJson(res);
        if (!res.ok) return errorEnvelope(`http_${res.status}`, { ms, raw: json });
        const cand = (json.candidates || [])[0];
        const parts = (cand && cand.content && cand.content.parts) || [];
        const text = parts.map((p) => p && typeof p.text === 'string' ? p.text : '').join('').trim();
        const u = json.usageMetadata || {};
        return {
          ms, text,
          in_tok: Number(u.promptTokenCount || 0),
          out_tok: Number(u.candidatesTokenCount || 0),
          raw: json,
        };
      } catch (e) {
        return errorEnvelope(String(e.message || e), { ms: nowMs() - t0 });
      }
    },
  };
}

function makeOllamaTarget({ id, model, ctx }) {
  const endpoint = (ctx && ctx.ollamaBase) || process.env.KOLM_BENCH_LOCAL_LLM_URL || 'http://127.0.0.1:11434';
  return {
    id,
    transport: 'local-ollama',
    provider: 'ollama',
    model,
    async send(prompt) {
      const t0 = nowMs();
      try {
        const res = await fetch(`${endpoint}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            stream: false,
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        const ms = nowMs() - t0;
        const json = await safeJson(res);
        if (!res.ok) return errorEnvelope(`http_${res.status}`, { ms, raw: json });
        const text = (json.message && json.message.content || '').trim();
        return {
          ms, text,
          in_tok: Number(json.prompt_eval_count || 0),
          out_tok: Number(json.eval_count || 0),
          raw: json,
        };
      } catch (e) {
        return errorEnvelope(String(e.message || e), { ms: nowMs() - t0 });
      }
    },
  };
}

function makeVllmTarget({ id, model, ctx }) {
  const endpoint = (ctx && ctx.vllmBase) || process.env.KOLM_BENCH_VLLM_URL || 'http://127.0.0.1:8000';
  return {
    id,
    transport: 'local-vllm',
    provider: 'vllm',
    model,
    async send(prompt) {
      const t0 = nowMs();
      try {
        const res = await fetch(`${endpoint}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 512,
          }),
        });
        const ms = nowMs() - t0;
        const json = await safeJson(res);
        if (!res.ok) return errorEnvelope(`http_${res.status}`, { ms, raw: json });
        const text = (json.choices?.[0]?.message?.content || '').trim();
        return {
          ms, text,
          in_tok: Number(json.usage?.prompt_tokens || 0),
          out_tok: Number(json.usage?.completion_tokens || 0),
          raw: json,
        };
      } catch (e) {
        return errorEnvelope(String(e.message || e), { ms: nowMs() - t0 });
      }
    },
  };
}

function makeLocalKolmTarget({ id, model, ctx }) {
  const endpoint = (ctx && ctx.localKolmBase) || process.env.KOLM_LOCAL_BASE || 'http://127.0.0.1:7411';
  return {
    id,
    transport: 'local-kolm',
    provider: 'local-kolm',
    model,
    async send(prompt) {
      const t0 = nowMs();
      try {
        const res = await fetch(`${endpoint}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 512,
          }),
        });
        const ms = nowMs() - t0;
        const json = await safeJson(res);
        if (!res.ok) return errorEnvelope(`http_${res.status}`, { ms, raw: json });
        const text = (json.choices?.[0]?.message?.content || '').trim();
        return {
          ms, text,
          in_tok: Number(json.usage?.prompt_tokens || 0),
          out_tok: Number(json.usage?.completion_tokens || 0),
          raw: json,
        };
      } catch (e) {
        return errorEnvelope(String(e.message || e), { ms: nowMs() - t0 });
      }
    },
  };
}

function makeLocalGgufTarget({ id, ggufPath }) {
  return {
    id,
    transport: 'local-gguf',
    provider: 'llama-cpp',
    model: path.basename(ggufPath || ''),
    async send(prompt) {
      if (!ggufPath || !fs.existsSync(ggufPath)) {
        return errorEnvelope(`gguf_not_found:${ggufPath || '(unset)'}`);
      }
      const bin = locateLlamaCli();
      if (!bin) return errorEnvelope('llama_cli_not_found');
      const args = [
        '--model', ggufPath,
        '--prompt', prompt,
        '--no-display-prompt',
        '--temp', '0',
        '--predict', '256',
      ];
      const t0 = nowMs();
      const r = spawnSync(bin, args, {
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      });
      const ms = nowMs() - t0;
      if (r.error || r.status !== 0) {
        return errorEnvelope(`llama_cli_exit_${r.status || 'err'}`, { ms });
      }
      const text = (r.stdout || '').trim();
      // llama.cpp prints "eval time = X ms / Y runs" on stderr — extract
      // output token count when present, otherwise approximate.
      let out_tok = 0;
      const perfMatch = (r.stderr || '').match(/eval time\s*=\s*[\d.]+\s*ms\s*\/\s*(\d+)\s*runs/);
      if (perfMatch) out_tok = Number(perfMatch[1]);
      else out_tok = Math.ceil(text.length / 4);
      const in_tok = Math.ceil(String(prompt).length / 4);
      return { ms, text, in_tok, out_tok };
    },
  };
}

function makeUnknownTarget({ id }) {
  return {
    id,
    transport: 'unknown',
    provider: 'unknown',
    model: id,
    async send() {
      return errorEnvelope(`unresolvable_model:${id}`);
    },
  };
}

// ---------------------------------------------------------------------------
// runViaGateway — POST /v1/gateway/dispatch through the kolm wrapper. Re-used
// by makeGatewayTarget but exported so callers (and benchmarks) can dispatch
// ad-hoc.
// ---------------------------------------------------------------------------
export async function runViaGateway(model, prompt, bearer, base) {
  const t0 = nowMs();
  const baseUrl = (base || process.env.KOLM_BASE_URL || 'https://kolm.ai').replace(/\/+$/, '');
  const token = bearer || process.env.KOLM_API_KEY || '';
  if (!token) return errorEnvelope('missing_kolm_api_key');
  try {
    const res = await fetch(`${baseUrl}/v1/gateway/dispatch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 512,
      }),
    });
    const ms = nowMs() - t0;
    const json = await safeJson(res);
    if (!res.ok) return errorEnvelope(`gateway_http_${res.status}`, { ms, raw: json });
    // Gateway envelopes vary by provider — peek at common shapes.
    let text = '';
    if (json && json.choices && json.choices[0]) {
      text = (json.choices[0].message?.content || json.choices[0].text || '').trim();
    } else if (Array.isArray(json && json.content)) {
      text = json.content.map((c) => c && c.text || '').join('').trim();
    } else if (json && json.response) {
      text = String(json.response).trim();
    }
    return {
      ms,
      text,
      in_tok: Number(json?.usage?.input_tokens || json?.usage?.prompt_tokens || 0),
      out_tok: Number(json?.usage?.output_tokens || json?.usage?.completion_tokens || 0),
      receipt_id: json?.kolm_receipt?.receipt_id || json?.receipt_id || null,
      raw: json,
    };
  } catch (e) {
    return errorEnvelope(String(e.message || e), { ms: nowMs() - t0 });
  }
}

// ---------------------------------------------------------------------------
// runSuiteAgainstTarget — drives one target through every prompt in the
// suite, summarizes into a single row + returns per-sample arrays so callers
// (and the markdown report) can chart distributions.
// ---------------------------------------------------------------------------
async function runSuiteAgainstTarget({ suite, target, dry_run, judge }) {
  const samples = [];
  for (const p of suite.prompts) {
    if (dry_run) {
      samples.push(synthDrySample(target, p));
      continue;
    }
    let env;
    try { env = await target.send(p.text); }
    catch (e) { env = errorEnvelope(String(e.message || e)); }
    samples.push({
      prompt_id: p.id,
      prompt_text: p.text,
      response_text: env.text || '',
      ms: Number(env.ms || 0),
      in_tok: Number(env.in_tok || 0),
      out_tok: Number(env.out_tok || 0),
      error: env.error || null,
      receipt_id: env.receipt_id || null,
    });
  }

  const row = summarizeRow({ id: target.id, samples, suite, target, judge });
  return { row, samples };
}

// Deterministic dry-run sample so a fresh checkout can produce a report.
function synthDrySample(target, prompt) {
  const h = crypto.createHash('sha256').update(`${target.id}:${prompt.id}:${prompt.text}`).digest();
  const ms = 200 + (h[0] % 300);
  const out_tok = 50 + (h[1] % 150);
  const text = `[dry-run] (${target.id}) Could you clarify the order ID you need help with?`;
  return {
    prompt_id: prompt.id,
    prompt_text: prompt.text,
    response_text: text,
    ms,
    in_tok: Math.ceil(prompt.text.length / 4),
    out_tok,
    error: null,
    receipt_id: null,
  };
}

// ---------------------------------------------------------------------------
// summarizeRow — collapse N samples into the canonical metric columns.
// ---------------------------------------------------------------------------
function summarizeRow({ id, samples, suite, target, judge }) {
  const ok = samples.filter((s) => !s.error);
  const lat = ok.map((s) => s.ms).filter((x) => Number.isFinite(x));
  const chars = ok.map((s) => (s.response_text || '').length);
  const totalIn  = sum(ok.map((s) => s.in_tok || 0));
  const totalOut = sum(ok.map((s) => s.out_tok || 0));

  const row = {
    id,
    transport: target.transport,
    provider: target.provider,
    model: target.model,
    n: samples.length,
    n_ok: ok.length,
    n_err: samples.length - ok.length,
  };

  for (const m of suite.metrics) {
    row[m] = computeMetric(m, { samples, ok, lat, chars, totalIn, totalOut, suite, target, judge });
  }
  // Always include cost estimate when we have token data and a known model,
  // even if the metric isn't in the suite list — operators read this.
  if (row.cost_per_1k_usd == null) {
    row.cost_per_1k_usd = estimateCostPer1k({ provider: target.provider, model: target.model, totalIn, totalOut, n: ok.length });
  }
  return row;
}

function computeMetric(m, { samples, ok, lat, chars, totalIn, totalOut, suite, target, judge }) {
  switch (m) {
    case 'mean_ms':                return mean(lat);
    case 'p50_ms':                 return percentile(lat, 50);
    case 'p95_ms':                 return percentile(lat, 95);
    case 'mean_chars':             return mean(chars);
    case 'chars_per_token': {
      const tot = totalOut;
      if (!tot) return null;
      const c = sum(chars);
      return c / tot;
    }
    case 'asks_one_question_rate': return rate(ok.map((s) => asksOneQuestion(s.response_text)));
    case 'judge_clarify_rate':     return rate(ok.map((s) => judge({ kind: 'clarify',   prompt: s.prompt_text, response: s.response_text, suite, target })));
    case 'judge_on_policy_rate':   return rate(ok.map((s) => judge({ kind: 'on_policy', prompt: s.prompt_text, response: s.response_text, suite, target })));
    case 'correctness@1':          return rate(ok.map((s) => {
      const expected = (suite.prompts.find((p) => p.id === s.prompt_id) || {}).expected_answer_substring;
      if (!expected) return false;
      return String(s.response_text || '').toLowerCase().includes(String(expected).toLowerCase());
    }));
    case 'cost_per_1k_usd':        return estimateCostPer1k({ provider: target.provider, model: target.model, totalIn, totalOut, n: ok.length });
    case 'pii_blocked_in_input':   return rate(samples.map((s) => s.error === 'gateway_http_400' || s.error === 'pii_blocked_in_input'));
    case 'pii_redacted_in_output': return rate(ok.map((s) => isPiiRedactedInOutput(s.prompt_text, s.response_text)));
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Default lightweight grader. The W869 study uses Gemini-2.5-Pro; the harness
// accepts an injected judge() for reproducibility but ships with a small
// heuristic so a unit-test run with no API key still surfaces ranked rows.
// ---------------------------------------------------------------------------
function defaultJudge({ kind, prompt, response }) {
  const r = String(response || '').toLowerCase();
  if (kind === 'clarify') {
    // A "clarify" reply contains a question mark AND references a
    // specifier the customer didn't give yet (order id, account number,
    // shipping address, email, etc.).
    if (!r.includes('?')) return false;
    return /(order|tracking|account|email|address|invoice|policy|date|model|version|number|id|reference)/i.test(r);
  }
  if (kind === 'on_policy') {
    // "On policy" = the reply did NOT invent a specific record. We flag
    // failures: fabricated tracking numbers, fabricated order IDs.
    if (/(your order #|tracking #|order id [a-z0-9-]{4,}|account [a-z0-9-]{4,} (was|has been))/i.test(response || '')) {
      return false;
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Heuristics used by the default grader / metric computers.
// ---------------------------------------------------------------------------
function asksOneQuestion(text) {
  const t = String(text || '');
  const qs = (t.match(/\?/g) || []).length;
  return qs === 1;
}

function isPiiRedactedInOutput(promptText, responseText) {
  // Check that none of the PII tokens in the prompt appear verbatim in the
  // response. This is a conservative check: a correctly-behaved gateway
  // does not echo back the email/phone/SSN/card number.
  const pii = extractObviousPii(promptText);
  if (pii.length === 0) return true; // nothing to leak → trivially redacted
  const r = String(responseText || '').toLowerCase();
  for (const tok of pii) {
    if (r.includes(String(tok).toLowerCase())) return false;
  }
  return true;
}

function extractObviousPii(text) {
  const out = [];
  const s = String(text || '');
  // Email
  const em = s.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
  if (em) out.push(...em);
  // Phone (very loose)
  const ph = s.match(/(\+?\d[\d\s().-]{7,}\d)/g);
  if (ph) out.push(...ph);
  // SSN
  const ssn = s.match(/\b\d{3}-\d{2}-\d{4}\b/g);
  if (ssn) out.push(...ssn);
  // Card number 16-digit groups
  const cc = s.match(/\b(?:\d[ -]?){13,19}\b/g);
  if (cc) out.push(...cc);
  return out;
}

// ---------------------------------------------------------------------------
// Cost estimate — wraps src/cost-estimator if importable; falls back to a
// minimal lookup so dry-run + unit tests have no hard dep.
// ---------------------------------------------------------------------------
function estimateCostPer1k({ provider, model, totalIn, totalOut, n }) {
  if (!n || n <= 0) return 0;
  const inPer = totalIn / n;
  const outPer = totalOut / n;
  let usd = 0;
  try {
    // Late import keeps the harness usable from environments where the
    // provider registry isn't fully resolvable (e.g. minimal CI).
    // eslint-disable-next-line no-eval
    const importer = (s) => import(s);
    // We can't await dynamically here without going async — fall back to
    // the minimal inline table. The full registry path runs via the
    // optional async helper estimateCostAsync below for callers that want
    // the precise number.
    usd = inlineCostPer1k({ provider, model, inPer, outPer });
  } catch (_) {
    usd = inlineCostPer1k({ provider, model, inPer, outPer });
  }
  return Number(usd.toFixed(6));
}

function inlineCostPer1k({ provider, model, inPer, outPer }) {
  // Minimum viable price table. The full src/provider-registry holds many
  // more rows; this fallback covers the names benchmarks reference most.
  const TABLE = {
    anthropic: {
      'claude-opus-4-7':     { input: 0.015,   output: 0.075 },
      'claude-sonnet-4-7':   { input: 0.003,   output: 0.015 },
      'claude-haiku-4-5':    { input: 0.0008,  output: 0.004 },
    },
    openai: {
      'gpt-4o':              { input: 0.0025,  output: 0.010 },
      'gpt-4o-mini':         { input: 0.00015, output: 0.0006 },
      'o3-mini':             { input: 0.0011,  output: 0.0044 },
    },
    deepseek: {
      'deepseek-chat':       { input: 0.00027, output: 0.0011 },
      'deepseek-reasoner':   { input: 0.00055, output: 0.0022 },
    },
    gemini: {
      'gemini-2.5-flash':    { input: 0.000075, output: 0.0003 },
      'gemini-2.5-pro':      { input: 0.00125,  output: 0.005 },
    },
    'kolm-gateway':          {}, // priced by the wrapped provider; surfaced via raw
    'local-kolm':            {}, // hardware cost not metered here
    ollama:                  {},
    vllm:                    {},
    'llama-cpp':             {},
    fake:                    {},
  };
  const row = (TABLE[provider] || {})[model];
  if (!row) return 0;
  // row.input / row.output are USD per 1k TOKENS. inPer / outPer are tokens
  // per call. Per-call cost (USD) = (inPer/1000)*input + (outPer/1000)*output.
  // Per 1k CALLS = per-call cost * 1000.
  const perCall =
      ((Number(inPer)  || 0) / 1000) * (Number(row.input)  || 0)
    + ((Number(outPer) || 0) / 1000) * (Number(row.output) || 0);
  return perCall * 1000;
}

// Optional async cost calc using the full provider registry. Callers (e.g.
// release-verify reports) use this when they want precision; the in-flow
// summarizer uses inline above so it remains sync.
export async function estimateCostAsync({ provider, model, totalIn, totalOut, n }) {
  if (!n || n <= 0) return 0;
  try {
    const { estimateCost } = await import('./cost-estimator.js');
    const per = estimateCost({
      provider,
      model,
      prompt_tokens: totalIn / n,
      completion_tokens: totalOut / n,
    });
    return Number((per * 1000).toFixed(6));
  } catch (_) {
    return estimateCostPer1k({ provider, model, totalIn, totalOut, n });
  }
}

// ---------------------------------------------------------------------------
// Utilities.
// ---------------------------------------------------------------------------
function errorEnvelope(err, extra = {}) {
  return {
    ms: extra.ms || 0,
    text: '',
    in_tok: 0,
    out_tok: 0,
    error: String(err || 'error'),
    raw: extra.raw || null,
  };
}

async function safeJson(res) {
  try {
    const txt = await res.text();
    if (!txt) return {};
    try { return JSON.parse(txt); }
    catch { return { _raw: txt }; }
  } catch { return {}; }
}

function nowMs() { return Number(process.hrtime.bigint()) / 1e6; }

function sum(arr) { return arr.reduce((a, b) => a + (Number(b) || 0), 0); }

function mean(arr) {
  if (!arr || !arr.length) return null;
  return Number((sum(arr) / arr.length).toFixed(2));
}

function percentile(arr, p) {
  if (!arr || !arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[idx].toFixed(2));
}

function rate(boolArr) {
  if (!boolArr || !boolArr.length) return null;
  const passed = boolArr.filter(Boolean).length;
  return Number((passed / boolArr.length).toFixed(3));
}

function locateLlamaCli() {
  const candidates = [];
  if (process.env.LLAMA_CPP_BIN) candidates.push(process.env.LLAMA_CPP_BIN);
  // Common install locations.
  if (process.platform === 'win32') {
    candidates.push('llama-cli.exe', 'llama-cli');
  } else {
    candidates.push('llama-cli');
  }
  for (const c of candidates) {
    if (!c) continue;
    if (c.includes(path.sep) || c.includes('/')) {
      if (fs.existsSync(c)) return c;
      continue;
    }
    // Look up via PATH using `where` on Windows / `which` elsewhere.
    const probe = process.platform === 'win32' ? 'where' : 'which';
    const r = spawnSync(probe, [c], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0 && (r.stdout || '').trim()) {
      const first = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (first && fs.existsSync(first)) return first;
    }
  }
  return null;
}

// CLI-friendly helper exported for cli/kolm.js to call. The CLI verb is
// `kolm bench compare <suite> --models a,b,c --out <dir>`.
export async function cliCompareEntry(opts = {}) {
  return runBench(opts);
}
