// src/trace-translator.js
//
// W467 — cross-provider trace IR translator.
//
// Closes audit P1 Agent Trace cluster open item ("cross-provider IR
// translator — Anthropic ↔ OpenAI ↔ vendor function-call differences").
//
// What this is:
//
//   A pure-function translator that rewrites the vendor + model fields
//   on LLM nodes of a workflow IR so a trace compiled against one
//   vendor's contract can be replayed against another vendor's runtime.
//   Tool nodes and prompt templates are vendor-agnostic at the IR level
//   (the compile-ir.js pass already normalises tool_use vs tool_calls
//   shape into a single TOOL kind), so the translator's only real job
//   is to remap model identifiers per a model_map.
//
// What this is NOT:
//
//   - A re-execution layer. The translator produces a new IR; replay
//     still happens via workflow-ir.interpret() with caller-supplied
//     executors.
//   - A semantic re-prompter. We do not edit prompt_template text —
//     same prompt goes to the new vendor. If the vendors disagree on
//     system-prompt placement that is the executor's problem.
//   - A pricing oracle. Cost re-estimation lives in src/usage.js; this
//     module returns the IR only.
//
// Tenant fencing:
//
//   The translator itself is pure (no I/O). The route + CLI surface
//   that wraps it pulls the trace via traceCapture.readTrace which is
//   already tenant-fenced; foreign trace_ids fail loud via
//   `tenant_mismatch` and never reach this module.

import * as workflowIr from './workflow-ir.js';
import * as traceCapture from './trace-capture.js';
import * as compileIr from './compile-ir.js';

export const KNOWN_PROVIDERS = Object.freeze(['anthropic', 'openai', 'generic']);

// Default model map keyed by canonical capability tier.
//
// We mirror the W217 frontier catalog's tiering — Opus-class, Sonnet-
// class, Haiku-class — so an Anthropic Opus call translates to a
// comparable OpenAI flagship. Callers can override this entirely by
// passing opts.model_map.
//
// The map is bidirectional via TIERS below: every entry in TIERS is
// looked up in both directions during translate.
const TIERS = Object.freeze([
  {
    tier: 'flagship',
    anthropic: ['claude-opus-4-7', 'claude-opus-4-5', 'claude-opus-4', 'claude-opus'],
    openai: ['gpt-4o', 'gpt-4-turbo', 'gpt-4'],
  },
  {
    tier: 'sonnet',
    anthropic: ['claude-sonnet-4-6', 'claude-sonnet-4', 'claude-3-5-sonnet-20241022', 'claude-sonnet'],
    openai: ['gpt-4o', 'gpt-4o-2024-08-06'],
  },
  {
    tier: 'haiku',
    anthropic: ['claude-haiku-4-5-20251001', 'claude-haiku-4-5', 'claude-3-haiku-20240307', 'claude-haiku'],
    openai: ['gpt-4o-mini', 'gpt-4o-mini-2024-07-18', 'gpt-3.5-turbo'],
  },
]);

// Build a flat (from_provider, model) → (to_provider, model) lookup
// when a translation is requested. Returns the canonical (first-listed)
// model for the target provider per tier.
function _buildDefaultMap(from, to) {
  const map = {};
  for (const row of TIERS) {
    const fromList = row[from];
    const toList = row[to];
    if (!fromList || !toList || !toList.length) continue;
    const canonicalTarget = toList[0];
    for (const m of fromList) {
      map[m.toLowerCase()] = canonicalTarget;
    }
  }
  return map;
}

// Resolve a model from a provider to its counterpart in another
// provider. Returns { model, tier, mapped } where mapped=false when
// no entry exists and the caller chose to pass through. For 'generic',
// we always pass through.
function _resolveModel(model, from, to, overrideMap) {
  if (from === to) return { model, tier: null, mapped: true, reason: 'noop' };
  if (to === 'generic') return { model, tier: null, mapped: true, reason: 'passthrough_to_generic' };
  const lookup = model == null ? '' : String(model).toLowerCase();
  // Operator-supplied override always wins.
  if (overrideMap && Object.prototype.hasOwnProperty.call(overrideMap, lookup)) {
    return { model: overrideMap[lookup], tier: null, mapped: true, reason: 'override' };
  }
  const defaults = _buildDefaultMap(from, to);
  if (Object.prototype.hasOwnProperty.call(defaults, lookup)) {
    // Locate the tier for diagnostic purposes.
    let tier = null;
    for (const row of TIERS) {
      if ((row[from] || []).some(m => m.toLowerCase() === lookup)) { tier = row.tier; break; }
    }
    return { model: defaults[lookup], tier, mapped: true, reason: 'tier_default' };
  }
  return { model: model, tier: null, mapped: false, reason: 'unmapped' };
}

// Validate a {from, to} pair early so the caller gets a coded error
// instead of a partial translation.
function _validateProviders({ from, to }) {
  if (!from || !KNOWN_PROVIDERS.includes(from)) {
    const err = new Error('from provider must be one of: ' + KNOWN_PROVIDERS.join(','));
    err.code = 'invalid_from_provider';
    throw err;
  }
  if (!to || !KNOWN_PROVIDERS.includes(to)) {
    const err = new Error('to provider must be one of: ' + KNOWN_PROVIDERS.join(','));
    err.code = 'invalid_to_provider';
    throw err;
  }
}

// Public API — translate an IR in place by returning a deep-copied
// version with rewritten LLM-node vendor + model fields. Tool nodes
// pass through unchanged (the compile-ir pass already normalises
// vendor-specific tool_use/tool_calls shape into a single TOOL kind).
//
// Returns { ir, mappings, dropped, ir_hash, from, to }.
//
//   mappings[]: one entry per LLM node — { node_id, from_model,
//               from_vendor, to_model, to_vendor, tier, mapped, reason }.
//   dropped[]:  LLM nodes that had no model lookup AND opts.strict=true.
//
// If opts.strict=true (default false) and any LLM node is unmapped,
// throws { code: 'unmapped_models', mappings, unmapped_count }.
export function translateIr(ir, { from, to, model_map, strict = false } = {}) {
  _validateProviders({ from, to });
  if (!ir || typeof ir !== 'object') {
    const err = new Error('ir is required');
    err.code = 'ir_required';
    throw err;
  }
  // validateIr throws if the shape is wrong — let it through unchanged.
  workflowIr.validateIr(ir);

  // Lowercase the override map keys once for stable matching.
  const overrideMap = {};
  if (model_map && typeof model_map === 'object') {
    for (const k of Object.keys(model_map)) overrideMap[k.toLowerCase()] = model_map[k];
  }

  const mappings = [];
  const dropped = [];
  const newNodes = ir.nodes.map(n => {
    if (n.kind !== workflowIr.NODE_KINDS.LLM) return { ...n };
    const fromModel = n.model;
    const fromVendor = n.vendor;
    const res = _resolveModel(fromModel, from, to, overrideMap);
    mappings.push({
      node_id: n.id,
      from_model: fromModel,
      from_vendor: fromVendor,
      to_model: res.model,
      to_vendor: to === 'generic' ? n.vendor : to,
      tier: res.tier,
      mapped: res.mapped,
      reason: res.reason,
    });
    if (!res.mapped) dropped.push({ node_id: n.id, model: fromModel });
    return {
      ...n,
      vendor: to === 'generic' ? n.vendor : to,
      model: res.model,
    };
  });

  if (strict && dropped.length) {
    const err = new Error('unmapped LLM models in strict mode: ' + dropped.map(d => d.model).join(','));
    err.code = 'unmapped_models';
    err.mappings = mappings;
    err.unmapped_count = dropped.length;
    throw err;
  }

  const newIr = {
    ...ir,
    nodes: newNodes,
    // edges + seeds are vendor-agnostic — pass through.
    edges: ir.edges.map(e => ({ ...e })),
    seeds: ir.seeds.map(s => ({ ...s })),
  };
  // Re-validate so any mistake we made is caught at the boundary.
  workflowIr.validateIr(newIr);
  const ir_hash = workflowIr.hashIr(newIr);
  return {
    ir: newIr,
    mappings,
    dropped,
    ir_hash,
    from,
    to,
    strict,
  };
}

// Helper: translate by trace_id. Pulls the trace tenant-fenced via
// trace-capture, compiles to IR via compile-ir, then translates.
// Useful for the route + CLI surface — they don't need to import
// three modules.
export async function translateTrace({ trace_id, tenant_id, from, to, model_map, strict }) {
  if (!trace_id) {
    const err = new Error('trace_id required');
    err.code = 'trace_id_required';
    throw err;
  }
  if (!tenant_id) {
    const err = new Error('tenant_id required');
    err.code = 'tenant_id_required';
    throw err;
  }
  _validateProviders({ from, to });
  const spans = await traceCapture.readTrace({ trace_id, tenant_id });
  if (!spans || !spans.length) {
    const err = new Error('trace not found or empty: ' + trace_id);
    err.code = 'trace_empty';
    throw err;
  }
  const ir = compileIr.traceToIr(spans);
  const result = translateIr(ir, { from, to, model_map, strict });
  return {
    ...result,
    trace_id,
    tenant_id,
  };
}

// Sniff a trace's predominant vendor — useful when the caller didn't
// supply a from-provider. Looks at LLM_CALL spans' payload.vendor and
// returns the most common one (defaults to 'generic' if there are no
// LLM spans).
export async function detectTraceProvider({ trace_id, tenant_id }) {
  const spans = await traceCapture.readTrace({ trace_id, tenant_id });
  const counts = {};
  for (const s of spans || []) {
    if (s.kind === traceCapture.SPAN_KINDS.LLM_CALL && s.payload && s.payload.vendor) {
      const v = String(s.payload.vendor).toLowerCase();
      counts[v] = (counts[v] || 0) + 1;
    }
  }
  let best = 'generic';
  let bestN = 0;
  for (const v of Object.keys(counts)) {
    if (counts[v] > bestN) { best = v; bestN = counts[v]; }
  }
  // Normalise an unrecognised vendor to 'generic' so the translator
  // accepts it (vs raising invalid_from_provider).
  if (!KNOWN_PROVIDERS.includes(best)) return { provider: 'generic', counts };
  return { provider: best, counts };
}

export default {
  KNOWN_PROVIDERS,
  translateIr,
  translateTrace,
  detectTraceProvider,
};
