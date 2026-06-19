// W1028 - provider pricing receipts.
//
// Pricing claims age quickly. This module deliberately does not ship live
// Together/Fireworks/OpenPipe rates. Callers bring a provider-published price
// snapshot with source URL + publication date; Kolm normalizes it, computes the
// cost for the submitted workload, hashes the public receipt, and fails closed
// when provenance is missing.

import crypto from 'node:crypto';

export const PROVIDER_PRICING_RECEIPT_VERSION = 'w1028-provider-pricing-receipts-v1';

export const PROVIDER_PRICING_RECEIPT_SCOPE = 'provider_published_rate_snapshot';

export const PROVIDER_PRICING_PROVIDERS = Object.freeze([
  'together',
  'fireworks',
  'openpipe',
  'runpod',
  'modal',
  'baseten',
  'kolm',
]);

export const PROVIDER_PRICING_OPERATIONS = Object.freeze([
  'inference',
  'training',
  'fine_tune',
  'distill_train',
  'serving',
]);

export const PROVIDER_PRICING_UNITS = Object.freeze([
  '1k_input_tokens',
  '1k_output_tokens',
  '1k_total_tokens',
  '1m_input_tokens',
  '1m_output_tokens',
  '1m_total_tokens',
  '1m_training_tokens',
  'gpu_hour',
  'replica_hour',
  'job',
]);

function _cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function _num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function _nonNegative(value) {
  const n = _num(value);
  return n != null && n >= 0 ? n : null;
}

function _roundMoney(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(8)) : 0;
}

function _canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(_canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) =>
      JSON.stringify(k) + ':' + _canonicalJson(value[k])
    ).join(',') + '}';
  }
  return JSON.stringify(value);
}

function _sha256Json(value) {
  return crypto.createHash('sha256').update(_canonicalJson(value)).digest('hex');
}

function _normalizeProvider(provider) {
  const p = _cleanString(provider).toLowerCase();
  if (!p) return { ok: false, error: 'provider_required' };
  if (!PROVIDER_PRICING_PROVIDERS.includes(p)) {
    return { ok: false, error: 'unsupported_provider', provider: p, supported: PROVIDER_PRICING_PROVIDERS };
  }
  return { ok: true, provider: p };
}

function _normalizeOperation(operation) {
  const op = _cleanString(operation || 'training').toLowerCase().replace(/-/g, '_');
  const mapped = op === 'fine-tune' || op === 'finetune' ? 'fine_tune' : op;
  if (!PROVIDER_PRICING_OPERATIONS.includes(mapped)) {
    return { ok: false, error: 'unsupported_operation', operation: mapped, supported: PROVIDER_PRICING_OPERATIONS };
  }
  return { ok: true, operation: mapped };
}

function _normalizeUnit(unit) {
  const u = _cleanString(unit).toLowerCase().replace(/usd_per_/g, '').replace(/-/g, '_');
  const mapped = {
    input_tokens_1m: '1m_input_tokens',
    output_tokens_1m: '1m_output_tokens',
    total_tokens_1m: '1m_total_tokens',
    training_tokens_1m: '1m_training_tokens',
    input_tokens_1k: '1k_input_tokens',
    output_tokens_1k: '1k_output_tokens',
    total_tokens_1k: '1k_total_tokens',
    per_1m_input_tokens: '1m_input_tokens',
    per_1m_output_tokens: '1m_output_tokens',
    per_1m_training_tokens: '1m_training_tokens',
    per_gpu_hour: 'gpu_hour',
    per_replica_hour: 'replica_hour',
    per_job: 'job',
  }[u] || u;
  if (!PROVIDER_PRICING_UNITS.includes(mapped)) {
    return { ok: false, error: 'unsupported_unit', unit: mapped, supported: PROVIDER_PRICING_UNITS };
  }
  return { ok: true, unit: mapped };
}

function _validateSourceUrl(sourceUrl) {
  const raw = _cleanString(sourceUrl);
  if (!raw) return { ok: false, error: 'source_url_required' };
  let url;
  try { url = new URL(raw); } catch (_) { return { ok: false, error: 'source_url_invalid' }; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: 'source_url_must_be_http' };
  if (url.username || url.password) return { ok: false, error: 'source_url_must_not_embed_credentials' };
  for (const key of url.searchParams.keys()) {
    if (/token|secret|key|password|signature/i.test(key)) return { ok: false, error: 'source_url_must_not_embed_secrets' };
  }
  url.hash = '';
  return { ok: true, source_url: url.toString() };
}

function _normalizeDate(value, field) {
  const raw = _cleanString(value);
  if (!raw) return { ok: false, error: field + '_required' };
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return { ok: false, error: field + '_invalid' };
  return { ok: true, value: raw.slice(0, 10) };
}

function _inferRatesFromObject(snapshot) {
  const rows = [];
  const s = snapshot || {};
  const add = (key, unit, operation) => {
    const v = _nonNegative(s[key]);
    if (v != null) rows.push({ unit, operation, usd: v });
  };
  add('input_per_1m_tokens_usd', '1m_input_tokens', 'inference');
  add('output_per_1m_tokens_usd', '1m_output_tokens', 'inference');
  add('input_per_1k_tokens_usd', '1k_input_tokens', 'inference');
  add('output_per_1k_tokens_usd', '1k_output_tokens', 'inference');
  add('training_per_1m_tokens_usd', '1m_training_tokens', 'fine_tune');
  add('fine_tune_per_1m_tokens_usd', '1m_training_tokens', 'fine_tune');
  add('training_per_gpu_hour_usd', 'gpu_hour', 'training');
  add('replica_per_hour_usd', 'replica_hour', 'serving');
  add('job_usd', 'job', 'training');
  return rows;
}

function _normalizeRateRows(snapshot, defaults) {
  const rawRows = Array.isArray(snapshot?.rates)
    ? snapshot.rates
    : (Array.isArray(snapshot?.price_rows) ? snapshot.price_rows : _inferRatesFromObject(snapshot));
  if (!rawRows.length) return { ok: false, error: 'price_rows_required' };

  const rows = [];
  for (const raw of rawRows) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const op = _normalizeOperation(source.operation || defaults.operation);
    if (!op.ok) return op;
    const unit = _normalizeUnit(source.unit || source.meter || source.basis);
    if (!unit.ok) return unit;
    const rate = _nonNegative(source.usd ?? source.rate_usd ?? source.price_usd ?? source.cost_usd);
    if (rate == null) return { ok: false, error: 'rate_usd_required', unit: unit.unit };
    rows.push(Object.freeze({
      row_id: _cleanString(source.row_id) || `${op.operation}:${unit.unit}:${rows.length + 1}`,
      provider: defaults.provider,
      operation: op.operation,
      unit: unit.unit,
      usd: _roundMoney(rate),
      model: _cleanString(source.model || defaults.model) || null,
      sku: _cleanString(source.sku) || null,
      note: _cleanString(source.note).slice(0, 240) || null,
    }));
  }
  return { ok: true, rows: Object.freeze(rows) };
}

function _normalizeUsage(usage = {}) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const gpuHoursFromSeconds = _nonNegative(u.gpu_seconds) != null ? _nonNegative(u.gpu_seconds) / 3600 : null;
  return Object.freeze({
    input_tokens: _nonNegative(u.input_tokens ?? u.prompt_tokens) || 0,
    output_tokens: _nonNegative(u.output_tokens ?? u.completion_tokens) || 0,
    training_tokens: _nonNegative(u.training_tokens ?? u.fine_tune_tokens) || 0,
    total_tokens: _nonNegative(u.total_tokens) || (
      (_nonNegative(u.input_tokens ?? u.prompt_tokens) || 0)
      + (_nonNegative(u.output_tokens ?? u.completion_tokens) || 0)
    ),
    gpu_hours: _nonNegative(u.gpu_hours) ?? gpuHoursFromSeconds ?? 0,
    replica_hours: _nonNegative(u.replica_hours) || 0,
    jobs: _nonNegative(u.jobs) || 1,
  });
}

function _quantityForUnit(unit, usage) {
  switch (unit) {
    case '1k_input_tokens': return usage.input_tokens / 1_000;
    case '1k_output_tokens': return usage.output_tokens / 1_000;
    case '1k_total_tokens': return usage.total_tokens / 1_000;
    case '1m_input_tokens': return usage.input_tokens / 1_000_000;
    case '1m_output_tokens': return usage.output_tokens / 1_000_000;
    case '1m_total_tokens': return usage.total_tokens / 1_000_000;
    case '1m_training_tokens': return usage.training_tokens / 1_000_000;
    case 'gpu_hour': return usage.gpu_hours;
    case 'replica_hour': return usage.replica_hours;
    case 'job': return usage.jobs;
    default: return 0;
  }
}

function _formatUnit(unit) {
  return {
    '1k_input_tokens': '1K input tokens',
    '1k_output_tokens': '1K output tokens',
    '1k_total_tokens': '1K total tokens',
    '1m_input_tokens': '1M input tokens',
    '1m_output_tokens': '1M output tokens',
    '1m_total_tokens': '1M total tokens',
    '1m_training_tokens': '1M training tokens',
    gpu_hour: 'GPU-hour',
    replica_hour: 'replica-hour',
    job: 'job',
  }[unit] || unit;
}

export function normalizeProviderPricingSnapshot(snapshot = {}) {
  const provider = _normalizeProvider(snapshot.provider);
  if (!provider.ok) return provider;
  const operation = _normalizeOperation(snapshot.operation || 'training');
  if (!operation.ok) return operation;
  const sourceUrl = _validateSourceUrl(snapshot.source_url || snapshot.url);
  if (!sourceUrl.ok) return sourceUrl;
  const publishedAt = _normalizeDate(snapshot.published_at || snapshot.effective_at, 'published_at');
  if (!publishedAt.ok) return publishedAt;
  const retrievedAt = snapshot.retrieved_at
    ? _normalizeDate(snapshot.retrieved_at, 'retrieved_at')
    : { ok: true, value: new Date().toISOString().slice(0, 10) };
  if (!retrievedAt.ok) return retrievedAt;
  const currency = _cleanString(snapshot.currency || 'USD').toUpperCase();
  if (currency !== 'USD') return { ok: false, error: 'currency_must_be_usd', currency };
  const defaults = {
    provider: provider.provider,
    operation: operation.operation,
    model: _cleanString(snapshot.model || snapshot.model_id),
  };
  const rows = _normalizeRateRows(snapshot, defaults);
  if (!rows.ok) return rows;
  return Object.freeze({
    ok: true,
    version: PROVIDER_PRICING_RECEIPT_VERSION,
    provider: provider.provider,
    operation: operation.operation,
    model: defaults.model || null,
    currency,
    source_url: sourceUrl.source_url,
    published_at: publishedAt.value,
    retrieved_at: retrievedAt.value,
    price_rows: rows.rows,
  });
}

export function estimateProviderPricingCost(snapshot, usage = {}) {
  const normalized = snapshot && snapshot.ok ? snapshot : normalizeProviderPricingSnapshot(snapshot);
  if (!normalized.ok) return normalized;
  const normalizedUsage = _normalizeUsage(usage);
  const breakdown = normalized.price_rows.map((row) => {
    const quantity = _quantityForUnit(row.unit, normalizedUsage);
    const cost = quantity * row.usd;
    return Object.freeze({
      row_id: row.row_id,
      operation: row.operation,
      unit: row.unit,
      quantity: Number(quantity.toFixed(8)),
      rate_usd: row.usd,
      cost_usd: _roundMoney(cost),
    });
  });
  const total = breakdown.reduce((sum, row) => sum + row.cost_usd, 0);
  return Object.freeze({
    ok: true,
    usage: normalizedUsage,
    breakdown: Object.freeze(breakdown),
    estimated_cost_usd: _roundMoney(total),
  });
}

export function buildProviderPricingReceipt(opts = {}) {
  const snapshot = normalizeProviderPricingSnapshot({
    ...opts,
    provider: opts.provider,
    operation: opts.operation,
    model: opts.model || opts.model_id,
    rates: opts.rates || opts.price_rows,
  });
  if (!snapshot.ok) return snapshot;
  const estimate = estimateProviderPricingCost(snapshot, opts.usage || opts);
  if (!estimate.ok) return estimate;
  const providerJobId = _cleanString(opts.provider_job_id) || null;
  const kolmJobId = _cleanString(opts.kolm_job_id || opts.job_id) || null;
  const base = {
    version: PROVIDER_PRICING_RECEIPT_VERSION,
    scope: PROVIDER_PRICING_RECEIPT_SCOPE,
    provider: snapshot.provider,
    operation: snapshot.operation,
    model: snapshot.model,
    currency: snapshot.currency,
    source_url: snapshot.source_url,
    published_at: snapshot.published_at,
    retrieved_at: snapshot.retrieved_at,
    price_rows: snapshot.price_rows,
    usage: estimate.usage,
    breakdown: estimate.breakdown,
    estimated_cost_usd: estimate.estimated_cost_usd,
    kolm_job_id: kolmJobId,
    provider_job_id: providerJobId,
    launch_spec_hash: _cleanString(opts.launch_spec_hash) || null,
  };
  const receiptHash = _sha256Json(base);
  const publicRows = snapshot.price_rows.map((row) => {
    const costRow = estimate.breakdown.find((b) => b.row_id === row.row_id);
    return Object.freeze({
      label: row.operation + ' / ' + _formatUnit(row.unit),
      rate: `$${row.usd} / ${_formatUnit(row.unit)}`,
      quantity: costRow ? costRow.quantity : 0,
      cost_usd: costRow ? costRow.cost_usd : 0,
      model: row.model,
      sku: row.sku,
    });
  });
  return Object.freeze({
    ok: true,
    ...base,
    receipt_hash: receiptHash,
    public_display: Object.freeze({
      title: `${snapshot.provider} ${snapshot.operation} pricing receipt`,
      source_url: snapshot.source_url,
      published_at: snapshot.published_at,
      retrieved_at: snapshot.retrieved_at,
      currency: snapshot.currency,
      estimated_cost_usd: estimate.estimated_cost_usd,
      receipt_hash: receiptHash,
      rows: Object.freeze(publicRows),
    }),
  });
}

export function verifyProviderPricingReceipt(receipt = {}) {
  if (!receipt || typeof receipt !== 'object') return { ok: false, error: 'receipt_required' };
  const { receipt_hash, public_display: _display, ok: _ok, ...base } = receipt;
  if (!_cleanString(receipt_hash).match(/^[a-f0-9]{64}$/i)) {
    return { ok: false, error: 'receipt_hash_required' };
  }
  const expected = _sha256Json(base);
  return {
    ok: expected === receipt_hash,
    receipt_hash,
    expected_hash: expected,
    version: PROVIDER_PRICING_RECEIPT_VERSION,
    error: expected === receipt_hash ? null : 'receipt_hash_mismatch',
  };
}

export default {
  PROVIDER_PRICING_RECEIPT_VERSION,
  PROVIDER_PRICING_RECEIPT_SCOPE,
  PROVIDER_PRICING_PROVIDERS,
  PROVIDER_PRICING_OPERATIONS,
  PROVIDER_PRICING_UNITS,
  normalizeProviderPricingSnapshot,
  estimateProviderPricingCost,
  buildProviderPricingReceipt,
  verifyProviderPricingReceipt,
};
