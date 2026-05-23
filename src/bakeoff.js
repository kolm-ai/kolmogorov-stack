// Wave 371 - Bakeoff (builder layer, pillar 8/12).
//
// Public surface:
//   bakeoff(datasetId, {contestants, opts})
//   bakeoffReport(bakeoffResult, opts)
//
// Compares contestants on the same holdout:
//   - cache       : artifact-runner's cache hit path (no LLM)
//   - rule        : synthesized regex/keyword rule (zero-shot LLM cost)
//   - prompt_only : cheapest LLM zero-shot
//   - <model id>  : routed via src/llm-call.js
//   - <artifact>  : routed via src/artifact-runner.js (path ends .kolm)
//
// Returns ranked array {name, pass_rate, avg_latency_ms, avg_cost_usd,
// score_per_dollar, recommended, privacy_class, deterministic}. We pick
// `recommended` as the highest score_per_dollar (with a small bias toward
// >=90% pass rate so a 1% pass rate doesn't win on cost alone).
//
// W409p — adds privacy_class + deterministic columns + a recommendation
// verdict from a closed enum {keep_frontier, distill, compile_rule,
// use_local_backbone, needs_human} computed from the four columns:
//
//   keep_frontier      -> recommended is a frontier model (best q/$ at scale)
//   distill            -> a smaller model passes >= 0.85 — distill candidate
//   compile_rule       -> the synthesized rule alone passes >= 0.85
//   use_local_backbone -> the local backbone (gemma/qwen/phi) passes >= 0.85
//   needs_human        -> nothing clears the 0.85 gate — escalate to labeling

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { callLLM, isConfigured, describeConfig } from './llm-call.js';
import { runArtifact } from './artifact-runner.js';
// W809-3 — parse_failure_rate track. parseOutputAgainstSpec returns
// {ok,parsed,error} so the bakeoff summary can count parse failures alongside
// pass_rate (never substituted for K-Score).
import { parseOutputAgainstSpec as _w809ParseOutputAgainstSpec } from './output-schema.js';
// W734-5 — context-faithfulness axis. computeContextFaithfulness returns a
// 0..1 score (or null when retrieved_context is absent — honest absence, NOT
// 0) for how much of a contestant's response is grounded in the retrieved
// chunks. Per-call score is averaged across rows in summarize().
import { computeContextFaithfulness as _w734ComputeContextFaithfulness } from './rag-capture.js';

// Per-contestant cost estimates (USD per call). Conservative defaults; the
// caller can pass opts.costTable to override. These are intentionally rough -
// the goal is RANKING, not billing-grade accounting.
const DEFAULT_COST_TABLE = {
  cache: 0,
  rule: 0,
  prompt_only: 0.00005,
  'gemma-3n-e2b': 0.00002,
  'qwen-0.5b': 0.00002,
  'phi-mini': 0.00005,
  'claude-haiku-4-5': 0.0008,
  'gpt-4o-mini': 0.00015,
  'gpt-4o': 0.005,
  'claude-opus-4-7': 0.015,
};

// W384 hotfix: also named-exported so src/router.js can `import { DEFAULT_CONTESTANTS }`
// instead of going through the default export.
export const DEFAULT_CONTESTANTS = [
  'cache',
  'rule',
  'prompt_only',
  'gemma-3n-e2b',
  'qwen-0.5b',
  'phi-mini',
  'claude-haiku-4-5',
  'gpt-4o-mini',
];

// W409p — privacy class lookup per contestant. local-* contestants are
// 'local' (PHI stays on device). Frontier API calls leak to the vendor.
// 'public' = no data leaves device (cache / rule). 'frontier' = leaks to
// vendor over public internet. 'byo-vendor' = leaks only to vendor under
// customer's BAA/DPA.
export const PRIVACY_CLASSES = {
  cache: 'public',
  rule: 'public',
  prompt_only: 'frontier',
  'gemma-3n-e2b': 'local',
  'qwen-0.5b': 'local',
  'phi-mini': 'local',
  'claude-haiku-4-5': 'frontier',
  'gpt-4o-mini': 'frontier',
  'gpt-4o': 'frontier',
  'claude-opus-4-7': 'frontier',
};

// W409p — deterministic flag per contestant family. cache + rule + sampled
// local artifacts are deterministic. Frontier API calls aren't (temperature
// 0 helps but the vendor still mutates models without notice).
export const DETERMINISM_TABLE = {
  cache: true,
  rule: true,
  prompt_only: false,
  'gemma-3n-e2b': true,    // local + seeded inference
  'qwen-0.5b': true,
  'phi-mini': true,
  'claude-haiku-4-5': false,
  'gpt-4o-mini': false,
  'gpt-4o': false,
  'claude-opus-4-7': false,
};

// W409p — closed enum of recommendation verdicts. Tests assert the verdict
// is one of these labels (never a free-text string).
export const RECOMMENDATION_VERDICTS = [
  'keep_frontier',
  'distill',
  'compile_rule',
  'use_local_backbone',
  'needs_human',
];

// Classify a contestant name into one of {public, local, frontier, byo-vendor,
// artifact, unknown}. Used both for privacy_class on the row and the
// recommendation enum decision.
export function classifyPrivacy(name) {
  if (!name) return 'unknown';
  if (PRIVACY_CLASSES[name]) return PRIVACY_CLASSES[name];
  if (typeof name === 'string') {
    if (name.endsWith('.kolm') || name.startsWith('artifact:')) return 'local';
    if (name.startsWith('local-')) return 'local';
    if (/^(claude|gpt|gemini|mistral|anthropic|openai)/i.test(name)) return 'frontier';
    if (/^(gemma|qwen|phi|llama|deepseek|mixtral)/i.test(name)) return 'local';
  }
  return 'unknown';
}

export function classifyDeterminism(name) {
  if (!name) return false;
  if (Object.prototype.hasOwnProperty.call(DETERMINISM_TABLE, name)) return DETERMINISM_TABLE[name];
  if (typeof name === 'string') {
    if (name.endsWith('.kolm') || name.startsWith('artifact:')) return true;
    if (name.startsWith('local-')) return true;
  }
  return false;
}

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function tokenize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}
function jaccard(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter);
}

// W397 - hydrate ~/.kolm/datasets/ds_*.json (event-ids only) into inline
// {input, output} rows by reading the event-store. This closes the gap that
// W396 worked around via curated-template fallback in cli/kolm.js cmdBakeoff.
//
// Resolution order:
//   1. opts.rows array        -> use directly
//   2. datasetId is array     -> use directly
//   3. datasetId is file path -> parse JSON / JSONL / single-object record
//   4. datasetId is ds_*      -> ~/.kolm/datasets/<id>.json (W369 dataset-workbench)
//                                with event-store hydration, falling back to
//                                ~/.kolm/simulations/<id>.json (legacy sim layout)
//   5. datasetId is namespace -> most-recent ds_*.json in ~/.kolm/datasets/
//                                whose record.namespace === datasetId, then
//                                hydrate as above
//
// Hydration policy: prefer holdout_ids (so bakeoff evals on a real held-out
// split), fall back to source_event_ids when holdout is empty (a fresh dataset
// before splitDataset() ran, or train_ratio=1).
async function loadDatasetRows(datasetId, opts) {
  if (Array.isArray(opts && opts.rows) && opts.rows.length) return opts.rows;
  if (Array.isArray(datasetId)) return datasetId;
  if (typeof datasetId === 'string' && fs.existsSync(datasetId)) {
    const text = fs.readFileSync(datasetId, 'utf8').trim();
    if (text.startsWith('[')) {
      try { return JSON.parse(text); } catch { /* fall through to jsonl */ }
    }
    if (text.startsWith('{') && text.indexOf('\n') === -1) {
      try {
        const j = JSON.parse(text);
        if (Array.isArray(j.holdout) && j.holdout.length) return j.holdout;
        if (Array.isArray(j.rows)) return j.rows;
        // W397: file is a dataset-workbench record -> hydrate via event-store.
        const hydrated = await _hydrateFromRecord(j);
        if (hydrated && hydrated.length) return hydrated;
      } catch { /* fall through to jsonl */ }
    }
    // JSONL: one JSON object per line.
    return text.split(/\r?\n/).filter(Boolean).map((ln) => {
      try { return JSON.parse(ln); } catch { return null; }
    }).filter(Boolean);
  }
  if (typeof datasetId === 'string' && datasetId.startsWith('ds_')) {
    // W369 dataset-workbench location (event-id record).
    const wb = path.join(_kolmBase(), 'datasets', datasetId + '.json');
    if (fs.existsSync(wb)) {
      try {
        const j = JSON.parse(fs.readFileSync(wb, 'utf8'));
        const hydrated = await _hydrateFromRecord(j);
        if (hydrated && hydrated.length) return hydrated;
      } catch { /* fall through */ }
    }
    // Legacy ~/.kolm/simulations layout (inline-rows record).
    const sim = path.join(_kolmBase(), 'simulations', datasetId + '.json');
    if (fs.existsSync(sim)) {
      try {
        const j = JSON.parse(fs.readFileSync(sim, 'utf8'));
        if (Array.isArray(j.holdout) && j.holdout.length) return j.holdout;
        if (Array.isArray(j.rows)) return j.rows;
      } catch { /* fall through */ }
    }
    return [];
  }
  // Namespace string -> most-recent dataset for that namespace.
  if (typeof datasetId === 'string') {
    const dir = path.join(_kolmBase(), 'datasets');
    if (fs.existsSync(dir)) {
      const records = fs.readdirSync(dir)
        .filter((f) => f.startsWith('ds_') && f.endsWith('.json'))
        .map((f) => {
          try {
            const obj = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            const st = fs.statSync(path.join(dir, f));
            return { file: f, obj, mtime: st.mtimeMs };
          } catch { return null; }
        })
        .filter(Boolean)
        .filter((x) => x.obj && x.obj.namespace === datasetId)
        .sort((a, b) => b.mtime - a.mtime);
      if (records.length) {
        const hydrated = await _hydrateFromRecord(records[0].obj);
        if (hydrated && hydrated.length) return hydrated;
      }
    }
  }
  return [];
}

function _kolmBase() {
  return process.env.KOLM_DATA_DIR
    ? path.resolve(process.env.KOLM_DATA_DIR)
    : path.join(os.homedir(), '.kolm');
}

// _hydrateFromRecord: given a dataset record from the workbench
// ({dataset_id, namespace, source_event_ids[], train_ids[], holdout_ids[]}),
// pull the event objects from the event-store and shape them as
// {input, output} rows that the bakeoff contestants understand.
async function _hydrateFromRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const ids = (Array.isArray(record.holdout_ids) && record.holdout_ids.length)
    ? record.holdout_ids
    : (Array.isArray(record.source_event_ids) && record.source_event_ids.length)
      ? record.source_event_ids
      : null;
  if (!ids) return null;
  let getEvent;
  try {
    ({ getEvent } = await import('./event-store.js'));
  } catch {
    return null;
  }
  const out = [];
  for (const id of ids) {
    let ev = null;
    try { ev = await getEvent(id); } catch { ev = null; }
    if (!ev) continue;
    const input = ev.prompt_redacted || ev.prompt || ev.input || '';
    const output = ev.response_redacted || ev.response || ev.output || '';
    if (!input) continue;
    out.push({ input: String(input), output: String(output), event_id: id });
  }
  return out;
}

// ---------------- per-contestant runners ----------------

// cache: a trivial in-process lookup over the dataset's own train half (when
// available) or just the expected output (echo). This represents "you had
// this exact answer cached" - so it's perfect-pass on exact-matched inputs
// and zero-pass on new ones. We approximate by passing iff the input appears
// in opts.cacheKeys (defaults to {} -- no cache hits).
async function runCache(rows, opts) {
  const cacheKeys = opts.cacheKeys || {};
  const out = [];
  for (const r of rows) {
    const hit = Object.prototype.hasOwnProperty.call(cacheKeys, r.input);
    const t0 = Date.now();
    out.push({
      input: r.input,
      expected: r.output,
      got: hit ? cacheKeys[r.input] : null,
      ok: hit,
      pass: hit ? (jaccard(cacheKeys[r.input], r.output) >= 0.7) : false,
      latency_us: Math.max(1, (Date.now() - t0) * 1000),
      cost_usd: 0,
    });
  }
  return out;
}

// rule: build a tiny keyword rule by extracting frequent target tokens from
// the first 30 dataset rows. If a row's expected output starts with one of
// those tokens, our rule returns it for any input containing the same token
// in the input. Intentionally crude; this is the "would a regex have worked?"
// baseline.
function synthesizeKeywordRule(rows) {
  const labelCounts = new Map();
  for (const r of rows.slice(0, 30)) {
    const lbl = String(r.output || '').toLowerCase().trim().split(/[\s,;]/)[0];
    if (!lbl) continue;
    labelCounts.set(lbl, (labelCounts.get(lbl) || 0) + 1);
  }
  const ranked = [...labelCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k]) => k);
  // Map a label -> a representative output (first row that uses it).
  const labelOut = new Map();
  for (const r of rows) {
    const lbl = String(r.output || '').toLowerCase().trim().split(/[\s,;]/)[0];
    if (lbl && ranked.includes(lbl) && !labelOut.has(lbl)) labelOut.set(lbl, r.output);
  }
  return (input) => {
    const lower = String(input || '').toLowerCase();
    for (const lbl of ranked) {
      if (lower.includes(lbl)) return labelOut.get(lbl) || lbl;
    }
    return null;
  };
}

async function runRule(rows, opts) {
  const rule = synthesizeKeywordRule(rows);
  const out = [];
  for (const r of rows) {
    const t0 = Date.now();
    const got = rule(r.input);
    out.push({
      input: r.input,
      expected: r.output,
      got,
      ok: got != null,
      pass: got != null && jaccard(got, r.output) >= 0.5,
      latency_us: Math.max(1, (Date.now() - t0) * 1000),
      cost_usd: 0,
    });
  }
  return out;
}

async function runArtifactContestant(rows, artifactPath, opts) {
  const out = [];
  for (const r of rows) {
    const t0 = Date.now();
    try {
      const ar = await runArtifact(artifactPath, r.input, { timeoutMs: 2000 });
      const got = typeof ar.output === 'string' ? ar.output : JSON.stringify(ar.output);
      out.push({
        input: r.input,
        expected: r.output,
        got,
        ok: true,
        pass: jaccard(got, r.output) >= 0.5,
        latency_us: ar.latency_us || (Date.now() - t0) * 1000,
        cost_usd: 0,
      });
    } catch (e) {
      out.push({ input: r.input, expected: r.output, got: null, ok: false, pass: false, error: String(e.message || e), latency_us: (Date.now() - t0) * 1000, cost_usd: 0 });
    }
  }
  return out;
}

async function runModelContestant(rows, modelName, opts) {
  // We require llm-call to be configured OR opt-in stub mode (opts.stubModel
  // === true) for tests. Stub mode echoes a deterministic answer so the
  // bakeoff can rank pass-rates without network. Real callers MUST set
  // KOLM_LLM_PROVIDER + KOLM_LLM_KEY for the per-model branch to be sound.
  const out = [];
  const costPer = (opts.costTable || DEFAULT_COST_TABLE)[modelName] ?? DEFAULT_COST_TABLE.prompt_only;
  for (const r of rows) {
    const t0 = Date.now();
    if (opts.stubModel) {
      // Deterministic stub: jaccard-match expected with quality scaling per model.
      // smaller models -> noisier outputs.
      const qualityByModel = {
        prompt_only: 0.55,
        'gemma-3n-e2b': 0.6,
        'qwen-0.5b': 0.62,
        'phi-mini': 0.7,
        'claude-haiku-4-5': 0.92,
        'gpt-4o-mini': 0.85,
        'gpt-4o': 0.95,
        'claude-opus-4-7': 0.97,
      };
      const q = qualityByModel[modelName] ?? 0.5;
      const stable = (sha(modelName + ':' + r.input).charCodeAt(0) % 100) / 100;
      const pass = stable < q;
      out.push({
        input: r.input,
        expected: r.output,
        got: pass ? r.output : '[stub mismatch]',
        ok: true,
        pass,
        latency_us: 1000 * (10 + (sha(modelName).charCodeAt(0) % 50)),
        cost_usd: costPer,
      });
      continue;
    }
    if (!isConfigured()) {
      out.push({ input: r.input, expected: r.output, got: null, ok: false, pass: false, error: 'llm_not_configured', latency_us: (Date.now() - t0) * 1000, cost_usd: 0 });
      continue;
    }
    try {
      const { text } = await callLLM({ user: String(r.input), maxTokens: 256, temperature: 0 });
      const got = String(text || '');
      out.push({ input: r.input, expected: r.output, got, ok: true, pass: jaccard(got, r.output) >= 0.5, latency_us: (Date.now() - t0) * 1000, cost_usd: costPer });
    } catch (e) {
      out.push({ input: r.input, expected: r.output, got: null, ok: false, pass: false, error: String(e.message || e), latency_us: (Date.now() - t0) * 1000, cost_usd: 0 });
    }
  }
  return out;
}

async function runContestant(name, rows, opts) {
  if (name === 'cache') return runCache(rows, opts);
  if (name === 'rule') return runRule(rows, opts);
  if (name.endsWith('.kolm') || (fs.existsSync && fs.existsSync(name))) {
    return runArtifactContestant(rows, name, opts);
  }
  return runModelContestant(rows, name, opts);
}

function summarize(name, calls, opts) {
  if (!calls.length) return {
    name, pass_rate: 0, avg_latency_ms: 0, avg_cost_usd: 0, calls: 0, score_per_dollar: 0,
    privacy_class: classifyPrivacy(name), deterministic: classifyDeterminism(name),
    quality: 0,
    // W809-3 — parse_failure_rate is emitted ALONGSIDE pass_rate, never as
    // a substitute. NaN here would poison downstream filters; pin to 0 for
    // the empty-calls path so the column is always numeric.
    parse_failure_rate: 0,
    // W734-5 — context_faithfulness is null on the empty-calls path so the
    // column is honestly absent (we have NO data to score), not falsely 0.
    context_faithfulness: null,
  };
  const pass = calls.filter((c) => c.pass).length;
  const passRate = pass / calls.length;
  const avgLatencyMs = calls.reduce((s, c) => s + (c.latency_us || 0), 0) / calls.length / 1000;
  const avgCostUsd = calls.reduce((s, c) => s + (c.cost_usd || 0), 0) / calls.length;
  // score_per_dollar: pass per dollar. Floor cost at $1e-6 so zero-cost
  // contestants don't blow up to Infinity.
  const score_per_dollar = passRate / Math.max(avgCostUsd, 1e-6);
  // W809-3 — parse_failure_rate track. When the caller passes
  // opts.schema_spec we parse every contestant's `got` string against the
  // spec and report the fraction that failed. This is ALWAYS computed when
  // a spec is present and is NEVER substituted for pass_rate — both ride
  // out alongside K-Score so the UI can show "passed 0.92 / parse-fail 0.04".
  // No spec → parse_failure_rate is null (column present, value honest).
  let parseFailureRate = null;
  if (opts && opts.schema_spec) {
    try {
      let fails = 0;
      let attempted = 0;
      for (const c of calls) {
        if (c.got == null) continue;
        attempted += 1;
        const r = _w809ParseOutputAgainstSpec(c.got, opts.schema_spec);
        if (!r.ok) fails += 1;
      }
      parseFailureRate = attempted === 0 ? 0 : fails / attempted;
    } catch (_e) {
      // Honest-by-default: if the parser throws, leave the field null
      // rather than silently reporting 0 (which would lie).
      parseFailureRate = null;
    }
  }
  // W734-5 — context_faithfulness axis. For every call that carries a
  // retrieved_context array (passed through on the row / call shape),
  // compute the TF-presence score. Average across rows; honest null when
  // NO call carried retrieved_context (RAG-free bakeoff). This is NEVER
  // 0 for the absent case — the bakeoff UI / verdict logic relies on
  // null to mean "axis not applicable to this dataset".
  let contextFaithfulness = null;
  try {
    let cfSum = 0;
    let cfCount = 0;
    for (const c of calls) {
      const retrieved = (c && Array.isArray(c.retrieved_context)) ? c.retrieved_context
        : (c && c.row && Array.isArray(c.row.retrieved_context)) ? c.row.retrieved_context
        : null;
      if (!retrieved || retrieved.length === 0) continue;
      const responseText = (typeof c.got === 'string') ? c.got
        : (typeof c.response === 'string') ? c.response : '';
      const score = _w734ComputeContextFaithfulness(responseText, retrieved);
      if (score == null) continue;
      cfSum += score;
      cfCount += 1;
    }
    contextFaithfulness = cfCount === 0 ? null : (cfSum / cfCount);
  } catch (_e) {
    // Honest absence on heuristic failure — never 0 (would lie).
    contextFaithfulness = null;
  }
  return {
    name,
    pass_rate: passRate,
    quality: passRate,          // W409p — alias the bakeoffs UI reads.
    avg_latency_ms: Math.round(avgLatencyMs * 10) / 10,
    avg_cost_usd: avgCostUsd,
    score_per_dollar,
    privacy_class: classifyPrivacy(name),
    deterministic: classifyDeterminism(name),
    calls: calls.length,
    // W809-3 — parse_failure_rate next to (never replacing) pass_rate.
    parse_failure_rate: parseFailureRate,
    // W734-5 — context_faithfulness axis. 0..1 OR null (honest absence
    // when no call carried retrieved_context).
    context_faithfulness: contextFaithfulness,
  };
}

// W409p — produce a recommendation verdict from the closed enum. Inputs:
// the ranked contestant array + the recommended name. The verdict tells the
// caller what to do next, not just who passed first.
export function recommendationVerdict(results, recommendedName) {
  if (!Array.isArray(results) || !results.length) return 'needs_human';
  const rec = results.find(r => r.name === recommendedName);
  // Nothing cleared the gate -> escalate to human review.
  if (!rec || rec.pass_rate < 0.85) return 'needs_human';
  // The synthesized keyword rule wins -> compile a rule, no model needed.
  if (rec.name === 'rule') return 'compile_rule';
  // A local backbone won the gate.
  if (rec.privacy_class === 'local') {
    // If the local came in via prompt_only-tier quality the upstream is also
    // viable -> distill it instead of just running the small local.
    return 'use_local_backbone';
  }
  // Recommended is a frontier model. Check whether any local cleared the gate
  // close to the frontier -> distill candidate.
  const closeLocal = results.find(r => r.privacy_class === 'local' && r.pass_rate >= 0.7);
  if (closeLocal) return 'distill';
  return 'keep_frontier';
}

export async function bakeoff(datasetId, { contestants, opts = {} } = {}) {
  const rows = await loadDatasetRows(datasetId, opts);
  if (!rows.length) throw new Error('bakeoff: dataset empty (passed: ' + (typeof datasetId === 'string' ? datasetId.slice(0, 80) : '<rows>') + ')');
  const list = (contestants && contestants.length ? contestants : DEFAULT_CONTESTANTS);
  const results = [];
  for (const name of list) {
    const t0 = Date.now();
    let calls = [];
    let error = null;
    try {
      calls = await runContestant(name, rows, opts);
    } catch (e) {
      error = String(e.message || e);
    }
    const summary = summarize(name, calls, opts);
    summary.error = error;
    summary.elapsed_ms = Date.now() - t0;
    results.push(summary);
  }
  // Recommended: best score_per_dollar AMONG contestants with pass_rate >= 0.85.
  // If none clear 0.85, pick the highest pass_rate.
  const eligible = results.filter((r) => r.pass_rate >= 0.85);
  let recommended = null;
  if (eligible.length) recommended = eligible.reduce((a, b) => (a.score_per_dollar >= b.score_per_dollar ? a : b)).name;
  else if (results.length) recommended = results.reduce((a, b) => (a.pass_rate >= b.pass_rate ? a : b)).name;
  for (const r of results) r.recommended = (r.name === recommended);
  // Sort: pass_rate desc, then score_per_dollar desc.
  results.sort((a, b) => (b.pass_rate - a.pass_rate) || (b.score_per_dollar - a.score_per_dollar));
  // W409p — verdict from the closed enum.
  const verdict = recommendationVerdict(results, recommended);
  return {
    dataset_id: typeof datasetId === 'string' ? datasetId : 'inline',
    rows_used: rows.length,
    contestants: results,
    recommended,
    recommendation: verdict,        // W409p — closed-enum verdict.
    recommendation_verdict: verdict, // explicit alias so downstream readers
                                     // don't have to guess at the key name.
    columns: ['name', 'pass_rate', 'avg_latency_ms', 'avg_cost_usd', 'privacy_class', 'deterministic'],
    created_at: new Date().toISOString(),
  };
}

export function bakeoffReport(result, opts = {}) {
  if (!result || !Array.isArray(result.contestants)) return 'no bakeoff result';
  const lines = [];
  lines.push('Bakeoff result (' + result.rows_used + ' rows)');
  lines.push('');
  lines.push('contestant            pass    latency    $/call         score/$         rec');
  lines.push('-----------          ----    -------    ----------     ------------    ---');
  for (const c of result.contestants) {
    const name = c.name.padEnd(20);
    const pass = (Math.round(c.pass_rate * 1000) / 10).toString().padStart(5) + '%';
    const lat = (c.avg_latency_ms.toFixed(1) + 'ms').padStart(8);
    const cost = ('$' + c.avg_cost_usd.toFixed(6)).padStart(12);
    const sd = Number.isFinite(c.score_per_dollar) ? c.score_per_dollar.toFixed(0).padStart(12) : '       n/a';
    const rec = c.recommended ? '   YES' : '';
    lines.push(name + '  ' + pass + '   ' + lat + '   ' + cost + '   ' + sd + '   ' + rec);
  }
  lines.push('');
  if (result.recommended) {
    lines.push('Recommended: ' + result.recommended + ' (best score per dollar among contestants >= 85% pass).');
  } else {
    lines.push('No recommendation: no contestant cleared the 85% pass-rate gate.');
  }
  return lines.join('\n');
}

export default {
  bakeoff, bakeoffReport,
  DEFAULT_CONTESTANTS,
  PRIVACY_CLASSES, DETERMINISM_TABLE, RECOMMENDATION_VERDICTS,
  classifyPrivacy, classifyDeterminism, recommendationVerdict,
};
