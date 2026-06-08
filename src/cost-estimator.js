// W368 cost estimator.
//
// Given (provider, model, prompt_tokens, completion_tokens) return the USD
// cost from PROVIDERS[provider].cost_per_1k[model]. Unknown model → 0 (we
// never invent fake costs; the row is still written with cost=0 so the
// downstream dashboard can highlight the gap).
//
// Models in OpenRouter sometimes carry the publisher prefix
// ("anthropic/claude-sonnet-4-6"); we look up the full key first, then fall
// back to the bare model name, so both spellings work.

import { PROVIDERS } from './provider-registry.js';

// W921 - resolve the price row AND a status so a $0 result from an UNKNOWN model
// is distinguishable from a genuinely-free call. estimateCostDetailed surfaces
// the status; estimateCost keeps its numeric contract (existing callers
// unchanged). estimator_status: 'priced' | 'unpriced_model' | 'unknown_provider'.
function _resolveCostRow(provider, model) {
  const pcfg = PROVIDERS[provider];
  if (!pcfg || !pcfg.cost_per_1k) return { row: null, status: 'unknown_provider', model_key: null };
  const table = pcfg.cost_per_1k;
  const key = String(model || '');
  let row = table[key];
  let matched = row ? key : null;
  if (!row && key.includes('/')) {
    const bare = key.split('/').pop();
    row = table[bare];
    if (row) matched = bare;
  }
  if (!row && key) {
    // Fuzzy fallback: strip a trailing date stamp (claude-3-5-sonnet-20241022 → claude-3-5-sonnet).
    const stripped = key.replace(/-2\d{7}$/, '');
    row = table[stripped];
    if (row) matched = stripped;
  }
  if (!row) return { row: null, status: 'unpriced_model', model_key: null };
  return { row, status: 'priced', model_key: matched };
}

export function estimateCostDetailed({ provider, model, prompt_tokens, completion_tokens } = {}) {
  const { row, status, model_key } = _resolveCostRow(provider, model);
  if (!row) return { cost_usd: 0, estimator_status: status, model_key: null };
  const pin = Number(prompt_tokens) || 0;
  const pout = Number(completion_tokens) || 0;
  const inCost = (pin / 1000) * (Number(row.input) || 0);
  const outCost = (pout / 1000) * (Number(row.output) || 0);
  return { cost_usd: Number((inCost + outCost).toFixed(6)), estimator_status: status, model_key };
}

export function estimateCost({ provider, model, prompt_tokens, completion_tokens } = {}) {
  return estimateCostDetailed({ provider, model, prompt_tokens, completion_tokens }).cost_usd;
}

// Resolve a teacher slug to a (provider, model) pair against the same price
// tables estimateCost uses. Accepts 'provider:model' or a bare model name
// (searched across providers). Unknown => provider:null (priced at $0, flagged).
function _resolveTeacherSlug(slug) {
  const s = String(slug || '');
  if (s.includes(':')) {
    const idx = s.indexOf(':');
    return { provider: s.slice(0, idx), model: s.slice(idx + 1) };
  }
  for (const [provider, cfg] of Object.entries(PROVIDERS)) {
    if (!cfg || !cfg.cost_per_1k) continue;
    if (_resolveCostRow(provider, s).row) return { provider, model: s };
  }
  return { provider: null, model: s };
}

// W921 - batch teacher-cost estimate used by the data-engine cost optimizer
// (rankStrategies) and the augment cost-preview. teachers: [{slug, rows}]; each
// row is one teacher call (avg_input prompt + avg_output completion). Returns
// {total_usd, per_teacher, unknown_models, assumptions}. Unknown slugs price at
// $0 and are reported in unknown_models - we never invent a price.
export function estimateBatchCost({ teachers = [], avg_input_tokens = 256, avg_output_tokens = 384 } = {}) {
  const ain = Number(avg_input_tokens) || 0;
  const aout = Number(avg_output_tokens) || 0;
  const unknown = [];
  const perTeacher = [];
  let total = 0;
  for (const t of (Array.isArray(teachers) ? teachers : [])) {
    const slug = String((t && t.slug) || '');
    const rows = Math.max(0, Number(t && t.rows) || 0);
    const { provider, model } = _resolveTeacherSlug(slug);
    const d = estimateCostDetailed({ provider, model, prompt_tokens: ain, completion_tokens: aout });
    if (d.estimator_status !== 'priced' && slug) unknown.push(slug);
    const teacherUsd = Number((d.cost_usd * rows).toFixed(6));
    total += teacherUsd;
    perTeacher.push({ slug, rows, per_call_usd: d.cost_usd, total_usd: teacherUsd, estimator_status: d.estimator_status });
  }
  return {
    total_usd: Number(total.toFixed(6)),
    per_teacher: perTeacher,
    unknown_models: unknown,
    assumptions: { avg_input_tokens: ain, avg_output_tokens: aout },
  };
}

// Extract usage from a provider response body. Each provider names the
// tokens differently; this helper normalizes to {prompt_tokens, completion_tokens}.
// Returns zeros if usage block is absent.
export function extractUsage(body, provider) {
  if (!body || typeof body !== 'object') return { prompt_tokens: 0, completion_tokens: 0 };
  if (provider === 'openai' || provider === 'openrouter') {
    const u = body.usage || {};
    return {
      prompt_tokens: Number(u.prompt_tokens || u.input_tokens || 0),
      completion_tokens: Number(u.completion_tokens || u.output_tokens || 0),
    };
  }
  if (provider === 'anthropic') {
    const u = body.usage || {};
    return {
      prompt_tokens: Number(u.input_tokens || 0),
      completion_tokens: Number(u.output_tokens || 0),
    };
  }
  if (provider === 'gemini') {
    const u = body.usageMetadata || body.usage || {};
    return {
      prompt_tokens: Number(u.promptTokenCount || u.prompt_tokens || u.input_tokens || 0),
      completion_tokens: Number(u.candidatesTokenCount || u.completion_tokens || u.output_tokens || 0),
    };
  }
  return { prompt_tokens: 0, completion_tokens: 0 };
}
