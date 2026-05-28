// src/data-augment.js
//
// KOLM DATA ENGINE — stage 3 of 6: AUGMENT.
//
// Turns a small set of seed pairs (and coverage signals from the CURATE stage)
// into a larger set of PROMPT CANDIDATES that a later COLLECT/TRAIN step fills
// with teacher outputs. Augmentation here is templated / heuristic — there are
// NO live teacher calls in this module. Generated rows therefore carry an
// empty `output` ('') on purpose: they are prompts awaiting synthesis. Seed
// outputs that already exist are preserved where a strategy rewrites a prompt
// but keeps the reference answer meaningful.
//
// Five strategies, one dispatch entry point, plus a cost preview that reuses
// the shared cost estimator so the user sees the teacher bill BEFORE any
// expensive collect step runs.
//
//   gap-fill     — target under-covered / zero-example categories.
//   evol         — Evol-Instruct-style complexity escalation of each seed.
//   persona      — rewrite each seed prompt from N personas.
//   adversarial  — ambiguity / negation / multi-constraint / out-of-scope.
//   doc-update   — regenerate prompts whose reference output should change
//                  because a source doc changed.
//
// Public-API contract:
//   - Envelope: { ok:true, version:'augment-v1', ... } on success,
//     { ok:false, error, version:'augment-v1' } on failure. Never throws
//     across the public surface.
//   - opts.apply !== true means PREVIEW ONLY: compute candidates + cost,
//     write nothing.
//   - Data lands at <ROOT>/.kolm/data/<namespace>/augment-pairs.jsonl,
//     ROOT = process.env.KOLM_DATA_DIR || os.homedir().
//
// No new npm deps. Persistence is best-effort via the canonical event store.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { estimateBatchCost } from './cost-estimator.js';
import * as eventStore from './event-store.js';

export const AUGMENT_VERSION = 'augment-v1';

const PROVIDER = 'kolm_data_augment';

const STRATEGIES = new Set(['gap-fill', 'evol', 'persona', 'adversarial', 'doc-update']);

// Default teacher used purely to PRICE the augmentation batch. The augment
// stage itself never calls a teacher; this slug only feeds estimateBatchCost so
// the preview reflects a realistic per-pair bill for the later collect step.
const DEFAULT_PRICING_TEACHER = 'openai:gpt-4o-mini';
const DEFAULT_PERSONAS = [
  'a frustrated new user',
  'a power user',
  'a non-native English speaker',
  'an enterprise admin',
];

// ---- persistence (best-effort) ----------------------------------------------

async function _persist({ tenant, namespace, workflow, payload }) {
  try {
    const ev = await eventStore.appendEvent({
      tenant_id: tenant,
      namespace: namespace || 'default',
      provider: PROVIDER,
      vendor: 'kolm',
      model: 'data-augment/v1',
      workflow_id: workflow,
      status: 'ok',
      prompt_tokens: 0,
      completion_tokens: 0,
      feedback: JSON.stringify(payload || {}),
    });
    return { persisted: true, event_id: ev && ev.event_id };
  } catch (e) {
    return { persisted: false, error: String((e && e.message) || e) };
  }
}

// ---- helpers ----------------------------------------------------------------

function _root() {
  return process.env.KOLM_DATA_DIR || os.homedir();
}

function _dataPath(namespace) {
  const ns = (typeof namespace === 'string' && namespace.trim()) ? namespace.trim() : 'default';
  return path.join(_root(), '.kolm', 'data', ns, 'augment-pairs.jsonl');
}

function _genId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

function _promptOf(pair) {
  // Seed pairs come from the ingest/curate stages as {input, output} (or
  // {prompt, completion} / {input, expected}). Normalize to a prompt string.
  if (pair == null) return '';
  if (typeof pair === 'string') return pair;
  const v = pair.input != null ? pair.input
    : pair.prompt != null ? pair.prompt
    : pair.question != null ? pair.question
    : pair.text != null ? pair.text
    : '';
  return typeof v === 'string' ? v : String(v);
}

function _answerOf(pair) {
  if (pair == null || typeof pair === 'string') return '';
  const v = pair.output != null ? pair.output
    : pair.completion != null ? pair.completion
    : pair.expected != null ? pair.expected
    : pair.answer != null ? pair.answer
    : '';
  return typeof v === 'string' ? v : String(v);
}

function _parentIdOf(pair) {
  if (pair == null || typeof pair === 'string') return null;
  return pair.id != null ? String(pair.id) : null;
}

// Build a candidate record in the canonical augment-pairs shape. `output`
// defaults to '' because generated rows are prompt candidates awaiting a later
// collect step; a strategy may pass a non-empty output when it deliberately
// preserves a seed answer.
function _candidate({ input, output = '', strategy, parentId }) {
  return {
    id: _genId('aug'),
    input: String(input == null ? '' : input),
    output: String(output == null ? '' : output),
    source_type: 'augment',
    provenance: {
      strategy,
      parent_id: parentId == null ? null : String(parentId),
      generated_at: new Date().toISOString(),
    },
  };
}

function _asArray(v) {
  return Array.isArray(v) ? v : (v == null ? [] : [v]);
}

// ---- strategies -------------------------------------------------------------

// gap-fill: target under-covered categories. Accepts either an explicit list of
// zero-example categories (opts.categories) or a {category: count} coverage map
// (opts.coverage); from the map we pick the categories at/under a threshold.
export function gapFill({ categories, coverage } = {}, opts = {}) {
  const list = [];
  const explicit = _asArray(opts.categories).length ? _asArray(opts.categories) : _asArray(categories);
  for (const c of explicit) {
    const name = typeof c === 'string' ? c.trim() : String(c || '').trim();
    if (name) list.push(name);
  }
  // Coverage map: include any category whose count is <= threshold.
  const cov = coverage || opts.coverage;
  if (cov && typeof cov === 'object' && !Array.isArray(cov)) {
    const threshold = Number.isFinite(opts.minExamples) ? Number(opts.minExamples) : 1;
    for (const [name, count] of Object.entries(cov)) {
      const n = Number(count) || 0;
      const clean = String(name || '').trim();
      if (clean && n < threshold && !list.includes(clean)) list.push(clean);
    }
  }
  // Per-category prompt scaffolds. Each phrasing references the category name
  // verbatim so a downstream reviewer (and the smoke test) can confirm the
  // candidate targets the gap.
  const phrasings = [
    (cat) => `A customer asks a typical question about ${cat}. Write their message.`,
    (cat) => `Write a realistic support request specifically about ${cat}.`,
    (cat) => `Compose an edge-case inquiry related to ${cat} that a new user might send.`,
  ];
  const out = [];
  for (const cat of list) {
    for (const make of phrasings) {
      out.push(_candidate({ input: make(cat), strategy: 'gap-fill', parentId: null }));
    }
  }
  return out;
}

// evol: Evol-Instruct-style complexity escalation. For each seed prompt emit a
// set of variants that each escalate the original along one axis.
export function evol(seedPairs = [], opts = {}) {
  const seeds = _asArray(seedPairs);
  const escalations = [
    (p) => `${p}\n\nAdd a hard constraint: the answer must comply with a strict company policy and cite which rule applies.`,
    (p) => `${p}\n\nGo deeper: explain the underlying reason, not just the surface answer.`,
    (p) => `${p}\n\nNow handle the edge case where the usual assumption does not hold.`,
    (p) => `${p}\n\nMake this multi-step: the user has two related requests in one message.`,
  ];
  const out = [];
  for (const seed of seeds) {
    const prompt = _promptOf(seed);
    if (!prompt.trim()) continue;
    const parentId = _parentIdOf(seed);
    for (const make of escalations) {
      const variant = make(prompt);
      // A variant must differ from its seed (the escalations always append).
      if (variant === prompt) continue;
      out.push(_candidate({ input: variant, strategy: 'evol', parentId }));
    }
  }
  return out;
}

// persona: rewrite each seed prompt as if written by N distinct personas.
export function persona(seedPairs = [], opts = {}) {
  const seeds = _asArray(seedPairs);
  let personas = _asArray(opts.personas).map((p) => String(p || '').trim()).filter(Boolean);
  if (!personas.length) personas = DEFAULT_PERSONAS.slice();
  const out = [];
  for (const seed of seeds) {
    const prompt = _promptOf(seed);
    if (!prompt.trim()) continue;
    const parentId = _parentIdOf(seed);
    for (const who of personas) {
      const variant = `Rewrite the following request in the voice of ${who}, preserving the underlying intent:\n\n${prompt}`;
      out.push(_candidate({ input: variant, strategy: 'persona', parentId }));
    }
  }
  return out;
}

// adversarial: produce TRAINING-data variants that stress the model along
// ambiguity / negation / multi-constraint / out-of-scope axes.
export function adversarial(seedPairs = [], opts = {}) {
  const seeds = _asArray(seedPairs);
  const twists = [
    (p) => `Make this request deliberately ambiguous so two readings are possible:\n\n${p}`,
    (p) => `Rephrase this using a negation/double-negative that is easy to misread:\n\n${p}`,
    (p) => `Pile on three competing constraints that partially conflict:\n\n${p}`,
    (p) => `Twist this into an out-of-scope request the assistant must politely decline:\n\n${p}`,
  ];
  const out = [];
  for (const seed of seeds) {
    const prompt = _promptOf(seed);
    if (!prompt.trim()) continue;
    const parentId = _parentIdOf(seed);
    for (const make of twists) {
      out.push(_candidate({ input: make(prompt), strategy: 'adversarial', parentId }));
    }
  }
  return out;
}

// doc-update: given changed doc chunks, regenerate the prompts whose reference
// output should change. Each updated doc yields one or more prompt candidates
// that ask for the now-current answer. updatedDocs entries may be strings or
// objects ({id?, title?, text?/content?/chunk?, prompts?}).
export function docUpdate({ updatedDocs } = {}, opts = {}) {
  const docs = _asArray(updatedDocs).length ? _asArray(updatedDocs) : _asArray(opts.updatedDocs);
  const out = [];
  for (const doc of docs) {
    let parentId = null;
    let title = '';
    let text = '';
    let explicitPrompts = [];
    if (typeof doc === 'string') {
      text = doc;
    } else if (doc && typeof doc === 'object') {
      parentId = doc.id != null ? String(doc.id) : null;
      title = String(doc.title || doc.heading || '').trim();
      text = String(doc.text != null ? doc.text : (doc.content != null ? doc.content : (doc.chunk != null ? doc.chunk : ''))).trim();
      explicitPrompts = _asArray(doc.prompts).map((p) => String(p || '').trim()).filter(Boolean);
    }
    const label = title || (text ? text.slice(0, 60) : '');
    if (!label && !explicitPrompts.length) continue;
    if (explicitPrompts.length) {
      for (const p of explicitPrompts) {
        out.push(_candidate({ input: p, strategy: 'doc-update', parentId }));
      }
    } else {
      out.push(_candidate({
        input: `The documentation for "${label}" changed. Write the user question whose answer must be refreshed to match the updated content.`,
        strategy: 'doc-update',
        parentId,
      }));
    }
  }
  return out;
}

// ---- cost preview -----------------------------------------------------------

// previewCost(candidates, opts) → reuse estimateBatchCost. Treat each candidate
// as one teacher call with avg input/output tokens; the later collect step is
// what actually spends this. Returns {est_cost_usd, n, per_pair_usd}.
export function previewCost(candidates, opts = {}) {
  const n = Array.isArray(candidates) ? candidates.length : (Number(candidates) || 0);
  const teacher = (opts && typeof opts.teacher === 'string' && opts.teacher) ? opts.teacher : DEFAULT_PRICING_TEACHER;
  const avg_input_tokens = Number.isFinite(opts.avg_input_tokens) ? Number(opts.avg_input_tokens) : 256;
  const avg_output_tokens = Number.isFinite(opts.avg_output_tokens) ? Number(opts.avg_output_tokens) : 384;
  const batch = estimateBatchCost({
    teachers: [{ slug: teacher, rows: n }],
    avg_input_tokens,
    avg_output_tokens,
  });
  const est = Number.isFinite(batch.total_usd) ? batch.total_usd : 0;
  return {
    est_cost_usd: est,
    n,
    per_pair_usd: n > 0 ? Number((est / n).toFixed(6)) : 0,
    teacher,
    unknown_models: batch.unknown_models || [],
    assumptions: batch.assumptions,
  };
}

// ---- write ------------------------------------------------------------------

function _appendJsonl(targetPath, records) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const lines = records.map((r) => JSON.stringify(r)).join('\n');
  fs.appendFileSync(targetPath, lines + (records.length ? '\n' : ''), 'utf8');
  return targetPath;
}

// ---- dispatch ---------------------------------------------------------------

function _dispatch(strategy, { pairs, seedPairs, opts }) {
  const seeds = _asArray(seedPairs).length ? _asArray(seedPairs) : _asArray(pairs);
  switch (strategy) {
    case 'gap-fill':
      return gapFill({ categories: opts.categories, coverage: opts.coverage }, opts);
    case 'evol':
      return evol(seeds, opts);
    case 'persona':
      return persona(seeds, opts);
    case 'adversarial':
      return adversarial(seeds, opts);
    case 'doc-update':
      return docUpdate({ updatedDocs: opts.updatedDocs }, opts);
    default:
      return null;
  }
}

// augment({ tenant, namespace, strategy, pairs, seedPairs, opts })
//
// opts.apply !== true → PREVIEW ONLY (compute candidates + cost, write nothing).
// opts.apply === true → also append candidates to augment-pairs.jsonl.
export async function augment({ tenant, namespace, strategy, pairs, seedPairs, opts } = {}) {
  try {
    const ns = (typeof namespace === 'string' && namespace.trim()) ? namespace.trim() : 'default';
    const tn = (typeof tenant === 'string' && tenant.trim()) ? tenant.trim() : 'tenant_local';
    const o = (opts && typeof opts === 'object') ? opts : {};

    if (!STRATEGIES.has(strategy)) {
      return {
        ok: false,
        version: AUGMENT_VERSION,
        error: `unknown strategy '${strategy}'. valid: ${[...STRATEGIES].join(', ')}`,
      };
    }

    const candidates = _dispatch(strategy, { pairs, seedPairs, opts: o });
    if (!Array.isArray(candidates)) {
      return { ok: false, version: AUGMENT_VERSION, error: `strategy '${strategy}' produced no candidate set` };
    }

    const cost_preview = previewCost(candidates, o);
    const apply = o.apply === true;
    const targetPath = _dataPath(ns);

    let wrote = false;
    if (apply && candidates.length) {
      _appendJsonl(targetPath, candidates);
      wrote = true;
    }

    const persistence = await _persist({
      tenant: tn,
      namespace: ns,
      workflow: `augment_${strategy}`,
      payload: {
        strategy,
        n_candidates: candidates.length,
        applied: wrote,
        est_cost_usd: cost_preview.est_cost_usd,
      },
    });

    return {
      ok: true,
      version: AUGMENT_VERSION,
      strategy,
      n_candidates: candidates.length,
      cost_preview,
      wrote,
      path: targetPath,
      candidates,
      persistence,
    };
  } catch (e) {
    return { ok: false, version: AUGMENT_VERSION, error: String((e && e.message) || e) };
  }
}

// appendFixPairs({ tenant, namespace, fix_pairs })
//
// Accepts externally-supplied fix pairs (the Failure Analyst writes here) and
// appends them to augment-pairs.jsonl with provenance.strategy:'failure-fix'.
// Unlike augment(), these carry real outputs (the corrected answer) and are
// always written — there is no preview gate, because the caller already
// decided these are corrections to land.
export async function appendFixPairs({ tenant, namespace, fix_pairs } = {}) {
  try {
    const ns = (typeof namespace === 'string' && namespace.trim()) ? namespace.trim() : 'default';
    const tn = (typeof tenant === 'string' && tenant.trim()) ? tenant.trim() : 'tenant_local';
    const list = _asArray(fix_pairs);
    const records = [];
    for (const fp of list) {
      if (fp == null) continue;
      const input = _promptOf(fp);
      const output = _answerOf(fp);
      if (!String(input).trim()) continue;
      const rec = {
        id: _genId('fix'),
        input: String(input),
        output: String(output),
        source_type: 'augment',
        provenance: {
          strategy: 'failure-fix',
          parent_id: _parentIdOf(fp),
          generated_at: new Date().toISOString(),
          rationale: fp.rationale != null ? String(fp.rationale) : null,
        },
      };
      records.push(rec);
    }

    const targetPath = _dataPath(ns);
    if (records.length) _appendJsonl(targetPath, records);

    await _persist({
      tenant: tn,
      namespace: ns,
      workflow: 'augment_failure_fix',
      payload: { strategy: 'failure-fix', n_written: records.length },
    });

    return {
      ok: true,
      version: AUGMENT_VERSION,
      n_written: records.length,
      path: targetPath,
    };
  } catch (e) {
    return { ok: false, version: AUGMENT_VERSION, error: String((e && e.message) || e) };
  }
}
