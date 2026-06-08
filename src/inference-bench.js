// src/inference-bench.js
//
// inference-economics (P1) - harden + benchmark the EXISTING inference
// primitives. This module does NOT rebuild speculative decoding, the bench
// harness, or the compute backends. It is a thin, reproducible benchmark
// runner that:
//
//   1. Drives a real OpenAI-compatible /v1/chat/completions endpoint
//      (the same wire shape src/compute/backends/openai-compatible.js,
//      vllm.js, sglang.js, tgi.js, and trt-llm.js already speak).
//   2. Measures $/1k-token, end-to-end latency (mean / p50 / p95), and
//      tokens/sec, with and without speculative decoding when the endpoint
//      advertises it (resolved via src/speculative-decoding.js - we never
//      claim a speedup we did not actually measure).
//   3. Writes a SIGNED result (content sha256 digest + optional ed25519
//      detached signature, identical primitive to the receipt/evidence path)
//      so a third party can re-verify the numbers off the wire.
//   4. Emits a comparison ROW shaped for public/benchmarks/inference-matrix.json
//      so the website's $/1k-token + tok/s table traces to a measurement.
//
// Relationship to siblings (read before editing - do NOT duplicate):
//   src/bench-harness.js - multi-model eval-suite harness. We
//                                       reuse its cost-per-1k math contract
//                                       and its honest "missing usage -> 0"
//                                       convention. This module is the
//                                       throughput/economics complement: it
//                                       measures tok/s + $/1k under (no-)spec
//                                       decoding rather than answer behavior.
//   src/speculative-decoding.js - DRAFT_PAIRINGS + resolveSpeculative.
//                                       We import resolveSpeculative/pickDraft
//                                       to label the spec-decode arm honestly.
//   src/speculative-teacher.js - student-draft / teacher-verify loop
//                                       (acceptance math). Out of scope here;
//                                       this module benchmarks an already-
//                                       served endpoint, it does not train.
//   src/compute/backends/openai-compatible.js - the wire shape we POST.
//
// Constraints (USER-MANDATED, non-negotiable - match bench-harness.js):
//   - Never use the forbidden h-word (see MEMORY) - use Caveats / Limitations.
//   - No browns/beiges/oranges; no emojis.
//   - --dry-run path produces a deterministic, signed stub result with NO
//     network and NO API keys, so a fresh checkout + CI can exercise the path.
//   - NEVER fabricate a speedup: the spec-decode arm is only labelled measured
//     when both arms actually ran against the live endpoint.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  resolveSpeculative,
  pickDraft,
  DEFAULT_NUM_SPECULATIVE_TOKENS,
} from './speculative-decoding.js';

export const INFERENCE_BENCH_VERSION = 'kolm-inference-bench/1';

// Schema id stamped on every emitted matrix row + signed result. Consumers
// (the website table, release-verify) MUST match via prefix `/^kolm-inference-matrix\//`
// NOT === equality, so a future v2 ships without a cascading rewrite.
export const INFERENCE_MATRIX_SCHEMA = 'kolm-inference-matrix/1';

// Default prompt set. Small, deterministic, and shaped to exercise a mix of
// short-answer + longer-generation so tok/s is not dominated by a single
// pathological length. Callers override via opts.prompts.
export const DEFAULT_PROMPTS = Object.freeze([
  'Summarize the difference between latency and throughput in two sentences.',
  'Write a Python function that returns the nth Fibonacci number iteratively.',
  'List five common causes of high tail latency in an LLM serving stack.',
  'Explain speculative decoding to a backend engineer in one short paragraph.',
  'Convert this to JSON: name Ada, role engineer, joined 2021.',
]);

// ---------------------------------------------------------------------------
// runInferenceBench - the top-level entry.
//
// opts:
//   endpoint        string   OpenAI-compatible base URL (no trailing slash
//                            required). Default $KOLM_BENCH_OAI_URL or
//                            http://127.0.0.1:8000. Ignored under dry_run.
//   model           string   model id sent in the request body. Required for
//                            a live run; defaulted under dry_run.
//   api_key         string   bearer; default $KOLM_BENCH_OAI_KEY (optional - 
//                            many local servers need none).
//   prompts         string[] override prompt set (default DEFAULT_PROMPTS).
//   repeats         number   how many times to replay the prompt set per arm
//                            (default 1). More repeats -> tighter samples.
//   max_tokens      number   generation cap per call (default 256).
//   speculative     string   'auto' | 'off' | '<draft model id>' (default
//                            'auto'). Resolved via resolveSpeculative; when a
//                            draft is resolvable AND the endpoint accepts the
//                            spec-decode hint, a second "with spec" arm runs.
//   runtime         string   serving runtime label for the spec-decode gate
//                            ('vllm' | 'transformers'); default 'vllm'.
//   num_speculative_tokens number  K draft tokens (default 5).
//   price_in_per_1k  number  USD per 1k INPUT tokens for $/1k math. Default 0.
//   price_out_per_1k number  USD per 1k OUTPUT tokens. Default 0.
//   hardware        string   free-text hardware label for the row + result.
//   signing_key_pem string   optional PKCS8 ed25519 private key PEM. When set,
//                            the result carries a detached signature. Default
//                            $KOLM_BENCH_SIGNING_KEY (path or inline PEM).
//   dry_run         boolean  deterministic offline stub (default false).
//   out_path        string   when set, write the signed result JSON here.
//   timestamp       string   fixed ISO for golden output (tests).
//   fetchImpl       function injectable fetch (tests). Default global fetch.
//
// Returns { ok:true, result, row, signed_result_path? } OR honest envelope.
// ---------------------------------------------------------------------------
export async function runInferenceBench(opts = {}) {
  const o = opts || {};
  const dry_run = !!o.dry_run;
  const prompts = Array.isArray(o.prompts) && o.prompts.length ? o.prompts.map(String) : [...DEFAULT_PROMPTS];
  const repeats = clampInt(o.repeats, 1, 1, 1000);
  const maxTokens = clampInt(o.max_tokens, 256, 1, 8192);
  const ts = o.timestamp || new Date().toISOString();
  const model = o.model || (dry_run ? 'dry-run/model' : null);
  const runtime = o.runtime || 'vllm';
  const numSpec = clampInt(o.num_speculative_tokens, DEFAULT_NUM_SPECULATIVE_TOKENS, 1, 64);

  if (!dry_run && (!model || typeof model !== 'string')) {
    return honest('missing_model', 'pass opts.model - the OpenAI-compatible model id to benchmark');
  }

  const endpoint = (o.endpoint || process.env.KOLM_BENCH_OAI_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
  const apiKey = o.api_key || process.env.KOLM_BENCH_OAI_KEY || '';
  const priceIn = num(o.price_in_per_1k, 0);
  const priceOut = num(o.price_out_per_1k, 0);
  const hardware = o.hardware ? String(o.hardware) : null;

  // Resolve the speculative-decoding decision HONESTLY via the existing
  // primitive. We never invent a draft pairing.
  const spec = resolveSpeculative({
    flag: o.speculative === undefined ? 'auto' : o.speculative,
    target: model || '',
    runtime,
    numSpeculativeTokens: numSpec,
  });

  const fetchImpl = typeof o.fetchImpl === 'function'
    ? o.fetchImpl
    : (typeof fetch === 'function' ? fetch : null);

  // --- Arm 1: baseline (no speculative decoding). Always runs. ---
  const baseline = dry_run
    ? synthArm('baseline', { model, prompts, repeats, maxTokens, priceIn, priceOut })
    : await runArm({
        arm: 'baseline', endpoint, apiKey, model, prompts, repeats,
        maxTokens, priceIn, priceOut, fetchImpl, speculative: null,
      });

  // --- Arm 2: with speculative decoding, only when resolvable + supported. ---
  // We pass the draft hint to the endpoint via the OpenAI `extra_body`-style
  // fields vLLM/SGLang accept. If the endpoint ignores it, the arm still
  // produces numbers but `spec_decode_applied` reflects only what we asked
  // for - we do NOT assert the server honored it.
  let withSpec = null;
  let specArmReason = spec.reason;
  if (spec.supported && spec.draft_model) {
    withSpec = dry_run
      ? synthArm('speculative', { model, prompts, repeats, maxTokens, priceIn, priceOut, draft: spec.draft_model })
      : await runArm({
          arm: 'speculative', endpoint, apiKey, model, prompts, repeats,
          maxTokens, priceIn, priceOut, fetchImpl,
          speculative: { draft_model: spec.draft_model, num_speculative_tokens: spec.num_speculative_tokens },
        });
  } else {
    specArmReason = `speculative arm skipped: ${spec.reason}`;
  }

  // Speedup is MEASURED only when both arms produced live, error-free
  // throughput. Otherwise it is null (never fabricated).
  let throughputSpeedup = null;
  let latencySpeedup = null;
  if (withSpec && baseline.ok_calls > 0 && withSpec.ok_calls > 0
      && baseline.tokens_per_sec > 0 && withSpec.tokens_per_sec > 0) {
    throughputSpeedup = round(withSpec.tokens_per_sec / baseline.tokens_per_sec, 4);
    if (withSpec.mean_ms > 0) latencySpeedup = round(baseline.mean_ms / withSpec.mean_ms, 4);
  }

  const result = {
    schema: INFERENCE_MATRIX_SCHEMA,
    kind: 'inference_economics_benchmark',
    version: INFERENCE_BENCH_VERSION,
    ran_at: ts,
    dry_run,
    endpoint: dry_run ? null : endpoint,
    model,
    hardware,
    runtime,
    config: {
      prompts_n: prompts.length,
      repeats,
      max_tokens: maxTokens,
      price_in_per_1k_usd: priceIn,
      price_out_per_1k_usd: priceOut,
    },
    speculative: {
      requested: o.speculative === undefined ? 'auto' : String(o.speculative),
      mode: spec.mode,
      draft_model: spec.draft_model,
      num_speculative_tokens: spec.num_speculative_tokens,
      supported: spec.supported,
      reason: specArmReason,
      auto_pairing: pickDraft(model || '') || null,
    },
    arms: {
      baseline,
      speculative: withSpec, // null when not run
    },
    deltas: {
      throughput_speedup: throughputSpeedup, // null = not measured
      latency_speedup: latencySpeedup,       // null = not measured
    },
  };

  // Sign the result (content digest + optional detached ed25519 signature).
  result.signature = signResult(result, o.signing_key_pem);

  // Build the website/matrix comparison row.
  const row = buildMatrixRow(result);

  let signed_result_path = null;
  if (o.out_path) {
    fs.mkdirSync(path.dirname(o.out_path), { recursive: true });
    fs.writeFileSync(o.out_path, JSON.stringify(result, null, 2) + '\n');
    signed_result_path = o.out_path;
  }

  return { ok: true, version: INFERENCE_BENCH_VERSION, result, row, signed_result_path };
}

// ---------------------------------------------------------------------------
// runArm - replay the prompt set `repeats` times against the OpenAI-compatible
// endpoint, collect per-call latency + token counts, summarize.
// ---------------------------------------------------------------------------
async function runArm({ arm, endpoint, apiKey, model, prompts, repeats, maxTokens, priceIn, priceOut, fetchImpl, speculative }) {
  if (!fetchImpl) {
    return errorArm(arm, 'no_fetch_available', { speculative });
  }
  const samples = [];
  for (let r = 0; r < repeats; r += 1) {
    for (const prompt of prompts) {
      samples.push(await oneCall({ endpoint, apiKey, model, prompt, maxTokens, fetchImpl, speculative }));
    }
  }
  return summarizeArm(arm, samples, { priceIn, priceOut, speculative });
}

// One /v1/chat/completions call. Returns a uniform per-call envelope.
async function oneCall({ endpoint, apiKey, model, prompt, maxTokens, fetchImpl, speculative }) {
  const headers = { 'content-type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
    temperature: 0,
    stream: false,
  };
  // Speculative-decoding hint via the fields vLLM / SGLang accept on the
  // OpenAI-compatible route. The server may ignore these; we record what we
  // ASKED, never assert the server honored it.
  if (speculative && speculative.draft_model) {
    body.extra_body = {
      speculative_model: speculative.draft_model,
      num_speculative_tokens: speculative.num_speculative_tokens,
    };
    body.speculative_model = speculative.draft_model;
    body.num_speculative_tokens = speculative.num_speculative_tokens;
  }
  const t0 = nowMs();
  try {
    const res = await fetchImpl(`${endpoint}/v1/chat/completions`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    const ms = nowMs() - t0;
    const json = await safeJson(res);
    if (!res.ok) return { ms, error: `http_${res.status}`, in_tok: 0, out_tok: 0 };
    const text = (json.choices?.[0]?.message?.content || json.choices?.[0]?.text || '').trim();
    return {
      ms,
      error: null,
      in_tok: Number(json.usage?.prompt_tokens || 0),
      out_tok: Number(json.usage?.completion_tokens || 0),
      chars: text.length,
    };
  } catch (e) {
    return { ms: nowMs() - t0, error: String(e && e.message || e), in_tok: 0, out_tok: 0 };
  }
}

// Collapse per-call samples into the arm summary row.
function summarizeArm(arm, samples, { priceIn, priceOut, speculative }) {
  const ok = samples.filter((s) => !s.error);
  const lat = ok.map((s) => s.ms).filter((x) => Number.isFinite(x) && x > 0);
  const totalIn = sum(ok.map((s) => s.in_tok || 0));
  const totalOut = sum(ok.map((s) => s.out_tok || 0));
  const totalMs = sum(lat);
  // tokens/sec: output tokens produced per wall-second of generation time.
  // We use OUTPUT tokens (the throughput metric operators care about) over the
  // summed per-call latency. Concurrency=1 by construction so this is a fair
  // single-stream tok/s, not an aggregate-throughput claim.
  const tokensPerSec = totalMs > 0 ? round((totalOut / (totalMs / 1000)), 3) : 0;
  // $/1k tokens: blended cost of producing 1000 tokens (in + out) at the given
  // published per-token prices. Missing prices -> 0 (honest, per harness rule).
  const totalTok = totalIn + totalOut;
  const costAll = (totalIn / 1000) * priceIn + (totalOut / 1000) * priceOut;
  const costPer1k = totalTok > 0 ? round((costAll / totalTok) * 1000, 6) : 0;

  return {
    arm,
    ok: ok.length > 0,
    n_calls: samples.length,
    ok_calls: ok.length,
    err_calls: samples.length - ok.length,
    mean_ms: mean(lat),
    p50_ms: percentile(lat, 50),
    p95_ms: percentile(lat, 95),
    tokens_in: totalIn,
    tokens_out: totalOut,
    tokens_per_sec: tokensPerSec,
    cost_per_1k_usd: costPer1k,
    spec_decode_requested: !!(speculative && speculative.draft_model),
    draft_model: (speculative && speculative.draft_model) || null,
    errors: dedupeErrors(samples),
  };
}

function errorArm(arm, error, { speculative }) {
  return {
    arm, ok: false, n_calls: 0, ok_calls: 0, err_calls: 0,
    mean_ms: null, p50_ms: null, p95_ms: null,
    tokens_in: 0, tokens_out: 0, tokens_per_sec: 0, cost_per_1k_usd: 0,
    spec_decode_requested: !!(speculative && speculative.draft_model),
    draft_model: (speculative && speculative.draft_model) || null,
    errors: [error],
  };
}

// Deterministic offline stub arm: derives stable latency / token counts from a
// content hash so dry-run + CI produce a signed, reproducible result with no
// network. The speculative arm gets a modest deterministic edge so the schema's
// "with spec" column is exercised - clearly flagged dry_run so nobody mistakes
// it for a measurement.
function synthArm(arm, { model, prompts, repeats, maxTokens, priceIn, priceOut, draft = null }) {
  const samples = [];
  const speedup = arm === 'speculative' ? 0.62 : 1.0; // dry-run only, deterministic
  for (let r = 0; r < repeats; r += 1) {
    for (let i = 0; i < prompts.length; i += 1) {
      const h = crypto.createHash('sha256').update(`${arm}:${model}:${r}:${i}:${prompts[i]}`).digest();
      const baseMs = 400 + (h[0] % 400);
      const outTok = 60 + (h[1] % 180);
      samples.push({
        ms: round(baseMs * speedup, 2),
        error: null,
        in_tok: Math.ceil(String(prompts[i]).length / 4),
        out_tok: Math.min(outTok, maxTokens),
        chars: outTok * 4,
      });
    }
  }
  const summary = summarizeArm(arm, samples, {
    priceIn, priceOut,
    speculative: draft ? { draft_model: draft } : null,
  });
  summary.dry_run = true;
  return summary;
}

// ---------------------------------------------------------------------------
// Signing - content sha256 digest (always) + optional detached ed25519
// signature (when a key is supplied). Same crypto primitives the receipt /
// evidence path uses; degrades to a verifiable content hash with no key so a
// fresh checkout still produces a signed-shape result.
// ---------------------------------------------------------------------------
export function canonicalize(obj) {
  // Stable JSON: sort object keys recursively so the digest is reproducible
  // regardless of insertion order. Mirrors the event-store canonicalize rule.
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']';
  const keys = Object.keys(obj).filter((k) => k !== 'signature').sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

export function signResult(result, signingKeyPem) {
  const canonical = canonicalize(result);
  const digest = crypto.createHash('sha256').update(canonical).digest('hex');
  const out = {
    alg: 'sha256',
    content_digest: `sha256:${digest}`,
    signed_at: new Date().toISOString(),
    signature: null,
    public_key: null,
  };
  const keySource = signingKeyPem || process.env.KOLM_BENCH_SIGNING_KEY || '';
  if (keySource) {
    try {
      let pem = keySource;
      // Allow a path to a PEM file as well as inline PEM.
      if (!/-----BEGIN/.test(keySource) && fs.existsSync(keySource)) {
        pem = fs.readFileSync(keySource, 'utf8');
      }
      const keyObj = crypto.createPrivateKey(pem);
      // ed25519 signs the raw message (no separate digest algo arg).
      const sig = crypto.sign(null, Buffer.from(canonical), keyObj);
      out.alg = 'sha256+ed25519';
      out.signature = `ed25519:${sig.toString('base64')}`;
      const pub = crypto.createPublicKey(keyObj).export({ type: 'spki', format: 'pem' });
      out.public_key = String(pub).trim();
    } catch (e) {
      out.signing_error = String(e && e.message || e);
    }
  }
  return out;
}

// Re-verify a signed result off the wire. Returns { ok, digest_match,
// signature_valid } so release-verify / a third party can confirm numbers.
export function verifyResult(result) {
  if (!result || typeof result !== 'object' || !result.signature) {
    return { ok: false, error: 'no_signature' };
  }
  const sig = result.signature;
  const canonical = canonicalize(result);
  const digest = `sha256:${crypto.createHash('sha256').update(canonical).digest('hex')}`;
  const digestMatch = digest === sig.content_digest;
  let signatureValid = null;
  if (sig.signature && sig.public_key && /^ed25519:/.test(sig.signature)) {
    try {
      const pub = crypto.createPublicKey(sig.public_key);
      const raw = Buffer.from(sig.signature.replace(/^ed25519:/, ''), 'base64');
      signatureValid = crypto.verify(null, Buffer.from(canonical), pub, raw);
    } catch (e) {
      signatureValid = false;
    }
  }
  return {
    ok: digestMatch && (signatureValid === null || signatureValid === true),
    digest_match: digestMatch,
    signature_valid: signatureValid, // null when result carries no detached sig
  };
}

// ---------------------------------------------------------------------------
// buildMatrixRow - shape one row for public/benchmarks/inference-matrix.json.
// ---------------------------------------------------------------------------
export function buildMatrixRow(result) {
  const b = (result.arms && result.arms.baseline) || {};
  const s = (result.arms && result.arms.speculative) || null;
  return {
    schema: INFERENCE_MATRIX_SCHEMA,
    model: result.model,
    hardware: result.hardware,
    runtime: result.runtime,
    dry_run: !!result.dry_run,
    measured_at: result.ran_at,
    baseline: {
      tokens_per_sec: b.tokens_per_sec ?? null,
      mean_ms: b.mean_ms ?? null,
      p95_ms: b.p95_ms ?? null,
      cost_per_1k_usd: b.cost_per_1k_usd ?? null,
    },
    speculative: s ? {
      draft_model: s.draft_model,
      tokens_per_sec: s.tokens_per_sec ?? null,
      mean_ms: s.mean_ms ?? null,
      p95_ms: s.p95_ms ?? null,
      cost_per_1k_usd: s.cost_per_1k_usd ?? null,
    } : null,
    throughput_speedup: result.deltas ? result.deltas.throughput_speedup : null,
    latency_speedup: result.deltas ? result.deltas.latency_speedup : null,
    content_digest: result.signature ? result.signature.content_digest : null,
    signed: !!(result.signature && result.signature.signature),
  };
}

// ---------------------------------------------------------------------------
// appendRowToMatrix - additive append of a row to the matrix file, preserving
// the schema + placeholder. De-dupes by content_digest so re-runs replace.
// ---------------------------------------------------------------------------
export function appendRowToMatrix(matrixPath, row) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(matrixPath, 'utf8'));
  } catch (_) {
    doc = { schema: INFERENCE_MATRIX_SCHEMA, generated_at: new Date().toISOString(), rows: [] };
  }
  if (!Array.isArray(doc.rows)) doc.rows = [];
  // Drop any prior row with the same digest (idempotent re-run).
  if (row.content_digest) {
    doc.rows = doc.rows.filter((r) => r && r.content_digest !== row.content_digest);
  }
  doc.rows.push(row);
  doc.generated_at = new Date().toISOString();
  fs.mkdirSync(path.dirname(matrixPath), { recursive: true });
  fs.writeFileSync(matrixPath, JSON.stringify(doc, null, 2) + '\n');
  return doc;
}

// ---------------------------------------------------------------------------
// Utilities (mirror bench-harness.js conventions).
// ---------------------------------------------------------------------------
function honest(error, hint) {
  return { ok: false, error, hint, version: INFERENCE_BENCH_VERSION };
}

async function safeJson(res) {
  try {
    const txt = await res.text();
    if (!txt) return {};
    try { return JSON.parse(txt); } catch { return { _raw: txt }; }
  } catch { return {}; }
}

function dedupeErrors(samples) {
  const set = new Set();
  for (const s of samples) if (s && s.error) set.add(s.error);
  return [...set];
}

function nowMs() { return Number(process.hrtime.bigint()) / 1e6; }
function sum(arr) { return arr.reduce((a, b) => a + (Number(b) || 0), 0); }
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function clampInt(v, d, lo, hi) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return d;
  return Math.max(lo, Math.min(hi, n));
}
function round(v, dp) { const f = Math.pow(10, dp); return Math.round(Number(v) * f) / f; }
function mean(arr) { if (!arr || !arr.length) return null; return round(sum(arr) / arr.length, 2); }
function percentile(arr, p) {
  if (!arr || !arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return round(sorted[idx], 2);
}

// CLI-friendly entry. The intended verb is
//   kolm bench inference --endpoint <url> --model <id> [--speculative auto] [--dry-run]
export async function cliInferenceBenchEntry(opts = {}) {
  return runInferenceBench(opts);
}

export default {
  INFERENCE_BENCH_VERSION,
  INFERENCE_MATRIX_SCHEMA,
  DEFAULT_PROMPTS,
  runInferenceBench,
  cliInferenceBenchEntry,
  buildMatrixRow,
  appendRowToMatrix,
  signResult,
  verifyResult,
  canonicalize,
};
