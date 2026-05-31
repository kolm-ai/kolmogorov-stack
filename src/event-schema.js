// W369 — canonical event schema (single source of truth).
//
// Every byte that flows through kolm.ai's data plane lands as a row matching
// this contract. The Connector agent writes events using newEvent() and
// validateEvent(); the Lake / Optimizer / Dataset / Label modules read them.
//
// Design rules:
//   - All fields are explicit. No "unknown" or "extra" keys land in the
//     store. validateEvent({ok, missing, extra, errors}) tells the caller
//     exactly what is wrong before the write hits the SQLite driver.
//   - canonicalize() coerces strings, clamps ints, drops null-y junk, and
//     fills sane defaults (event_id, created_at, status, cache_hit). It is
//     idempotent: canonicalize(canonicalize(x)) === canonicalize(x).
//   - newEvent(partial) returns a fully-formed event ready to write.
//   - Zero deps. Pure ESM. Browser-safe (no fs / no net) so the schema can
//     be imported by the public SDK as well.
//
// Upgrades the W368 daemon-connector stub: same field list, plus provenance
// columns (namespace, source_type, redaction_policy, schema_version) and
// strict type coercion. Backwards compatible: hashContent() preserved.

import crypto from 'node:crypto';

export const EVENT_FIELDS = [
  'event_id', 'tenant_id', 'workspace_id', 'app_id', 'user_id', 'session_id', 'workflow_id', 'trace_id',
  // W936 — team attribution. team_id scopes a capture to a team workspace and
  // actor_id pins it to the member whose key/session produced it, so a team
  // dashboard can show "who asked what" across the whole org. Both default null
  // (NOT required) — solo/unauthenticated rows still validate.
  'team_id', 'actor_id',
  'provider', 'model', 'upstream_url', 'request_hash', 'response_hash',
  'prompt_redacted', 'response_redacted', 'raw_prompt_path', 'raw_response_path',
  'prompt_tokens', 'completion_tokens', 'estimated_cost_usd', 'latency_ms', 'status', 'error_type',
  'cache_hit', 'sensitive_data_detected', 'sensitive_classes', 'redaction_count', 'tool_calls',
  'accepted', 'feedback', 'created_at',
  // schema/data provenance — required to pin every event back to a source.
  'namespace', 'source_type', 'redaction_policy', 'schema_version',
  // W411 — canonical vendor normalization + parity field names so OpenAI,
  // Anthropic, OpenRouter, Ollama, vLLM and llama.cpp all land in the lake
  // with identical column names. `vendor` is the closed enum the auditor
  // mandated; `provider` is preserved as a free-text alias for back-compat
  // (some legacy rows used 'manual', 'kolm', or other non-vendor strings).
  // tokens_in/out + cost_micro_usd + latency_us mirror the legacy
  // prompt_tokens/completion_tokens/estimated_cost_usd/latency_ms fields with
  // the units the auditor wants on the wire. `files` is the multimodal
  // attachment list (parallel to tool_calls). `error` is the human-readable
  // error message (paired with the existing error_type enum).
  'vendor', 'tokens_in', 'tokens_out', 'cost_micro_usd', 'latency_us',
  'files', 'error',
  // W409b — privacy provenance.
  // raw_available: whether raw_prompt_path / raw_response_path actually point at
  // a raw byte blob (true only when explicit opt-in via KOLM_ALLOW_RAW=true or
  // per-request header x-kolm-raw: true). Default false so consumers can trust
  // "no raw on disk" without inspecting the filesystem.
  // raw_prompt_hash / raw_response_hash: sha256-hex of the raw bytes (when
  // stored). Lets the lake reference the raw blob without re-loading it.
  // noncompliant_identifiers: array of classes (e.g. ['malformed_ssn']) where a
  // detector regex matched but the format failed validation; this is the
  // "noncompliant identifier detected" warning the auditor flagged.
  'raw_available', 'raw_prompt_hash', 'raw_response_hash', 'noncompliant_identifiers',
  // W377 — multimodal capture extension. media_uri points at a blob in the
  // media-store (file:~/.kolm/events/raw/<sha256>.<ext>) so the events table
  // stays small and the heavy bytes live on disk. media_extracted_text is the
  // OCR/transcription/pdf-text result (may be null until the worker runs).
  'media_kind', 'media_uri', 'media_hash', 'media_bytes', 'media_mime',
  'media_extracted_text', 'media_extraction_status', 'media_extraction_engine',
  // W411 — event-level holdout pin. When true, this event MUST NOT enter
  // any training split (distill, recipe-gen, augmentation, worker input).
  // The reviewer-set approval-row flag is the primary path; this field is
  // for cases where the holdout assignment is intrinsic to the event
  // (eg. an externally-curated benchmark row imported via importSeedsJsonl).
  'holdout_only',
  // W411 P0 addendum #9 — legacy migration + review-state fields.
  // review_state: human-review state machine.
  //   'unreviewed' (default) — never seen by a reviewer; cannot be promoted
  //     into a verified/production_ready artifact.
  //   'approved' / 'rejected' / 'needs_fix' — reviewer outcomes.
  // production_eligible: hard gate on whether this row may flow into a
  //   verified/production_ready artifact. Fail-closed false by default; only
  //   the productionReady() full-async pipeline sets this true.
  'review_state', 'production_eligible',
];

export const REQUIRED_FIELDS = ['event_id', 'tenant_id', 'namespace', 'created_at', 'schema_version'];
export const SCHEMA_VERSION = 1;

const STATUS_VALUES = new Set(['ok', 'error', 'timeout', 'rate_limited', 'blocked']);
// 'legacy_unknown' is the safe default the migration layer assigns to rows
// that pre-date W411 and never wrote source_type. Keeping it in the enum
// (vs collapsing to 'real') makes the lake honest about provenance: a row
// tagged 'legacy_unknown' must NOT be treated as approved real customer
// data without re-review.
const SOURCE_TYPES = new Set(['real', 'synthetic', 'simulated', 'teacher_generated', 'legacy_unknown']);
const REVIEW_STATES = new Set(['unreviewed', 'approved', 'rejected', 'needs_fix']);
// W411 — closed vendor enum. The auditor's mandate is that every captured
// event maps onto one of these. Anything else (free-text provider tags like
// 'manual', 'kolm', etc.) collapses to 'other' so downstream lake queries can
// switch on a finite set. The 'manual' value is preserved because seed /
// capture-log paths use it for non-LLM rows that still need the canonical
// schema.
export const VENDOR_VALUES = new Set([
  'openai', 'anthropic', 'openrouter',
  'ollama', 'vllm', 'llama-cpp',
  'gemini', 'kolm', 'manual', 'other',
]);
// Map free-text provider strings the legacy paths emit onto the closed vendor
// enum. Returns 'other' for anything outside the set (never null, never empty).
export function normalizeVendor(provider) {
  if (provider == null) return 'other';
  const p = String(provider).trim().toLowerCase();
  if (!p) return 'other';
  if (VENDOR_VALUES.has(p)) return p;
  // Common aliases the wild emits.
  if (p === 'llama.cpp' || p === 'llamacpp' || p === 'llama_cpp') return 'llama-cpp';
  if (p === 'open-router' || p === 'open_router') return 'openrouter';
  if (p === 'google' || p === 'google_gemini' || p === 'google-gemini') return 'gemini';
  return 'other';
}
// W409b — added 'review_required' so the membrane can return rows that need
// reviewer attention without forcing a binary allow/block. Default remains
// 'redact' (fail-closed) at the schema, daemon, and router layers.
const POLICY_VALUES = new Set(['allow', 'redact', 'block', 'review_required']);

// W377 — multimodal capture kinds. null is a valid value (text-only events
// still flow through the same schema). The enum is closed on purpose so
// downstream loaders can switch on it without a fallback path.
export const MEDIA_KINDS = new Set([
  'text', 'log', 'code', 'pdf', 'screenshot', 'image',
  'audio', 'transcript', 'video', 'browser_trace',
  'terminal_output', 'tool_output',
]);
const EXTRACTION_STATUS_VALUES = new Set(['none', 'pending', 'done', 'failed']);

function _stableId(seed) {
  const r = crypto.randomBytes(8).toString('hex');
  return `evt_${Date.now().toString(36)}${r}${seed ? '_' + String(seed).slice(0, 6) : ''}`;
}

function _clampInt(v, lo = 0, hi = Number.MAX_SAFE_INTEGER) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

function _clampFloat(v, lo = 0, hi = 1e9) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(lo, Math.min(hi, n));
}

function _str(v, max = 512) {
  if (v == null) return null;
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

function _arr(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(x => _str(x, 128)).filter(Boolean);
  return [_str(v, 128)].filter(Boolean);
}

// newEvent(partial): returns a fully-formed event with sane defaults.
// Callers may override any field; validateEvent will catch missing required.
export function newEvent(partial = {}) {
  const now = new Date().toISOString();
  const base = {
    event_id: partial.event_id || _stableId(partial.tenant_id),
    tenant_id: partial.tenant_id || 'local-tenant',
    workspace_id: partial.workspace_id || 'default',
    team_id: partial.team_id || null,
    actor_id: partial.actor_id || null,
    app_id: partial.app_id || null,
    user_id: partial.user_id || null,
    session_id: partial.session_id || null,
    workflow_id: partial.workflow_id || null,
    trace_id: partial.trace_id || null,
    provider: partial.provider || null,
    model: partial.model || null,
    upstream_url: partial.upstream_url || null,
    request_hash: partial.request_hash || null,
    response_hash: partial.response_hash || null,
    prompt_redacted: partial.prompt_redacted || null,
    response_redacted: partial.response_redacted || null,
    raw_prompt_path: partial.raw_prompt_path || null,
    raw_response_path: partial.raw_response_path || null,
    prompt_tokens: partial.prompt_tokens != null ? partial.prompt_tokens : 0,
    completion_tokens: partial.completion_tokens != null ? partial.completion_tokens : 0,
    estimated_cost_usd: partial.estimated_cost_usd != null ? partial.estimated_cost_usd : 0,
    latency_ms: partial.latency_ms != null ? partial.latency_ms : 0,
    status: partial.status || 'ok',
    error_type: partial.error_type || null,
    cache_hit: partial.cache_hit === true,
    sensitive_data_detected: partial.sensitive_data_detected === true,
    sensitive_classes: partial.sensitive_classes || [],
    redaction_count: partial.redaction_count != null ? partial.redaction_count : 0,
    tool_calls: partial.tool_calls || [],
    accepted: partial.accepted == null ? null : !!partial.accepted,
    feedback: partial.feedback || null,
    created_at: partial.created_at || now,
    namespace: partial.namespace || 'default',
    source_type: partial.source_type || 'real',
    redaction_policy: partial.redaction_policy || 'redact',
    schema_version: partial.schema_version || SCHEMA_VERSION,
    // W409b — privacy provenance defaults. raw_available is fail-closed (false)
    // so anything that does not explicitly opt in via KOLM_ALLOW_RAW or the
    // x-kolm-raw header reports "no raw on disk".
    raw_available: partial.raw_available === true,
    raw_prompt_hash: partial.raw_prompt_hash == null ? null : partial.raw_prompt_hash,
    raw_response_hash: partial.raw_response_hash == null ? null : partial.raw_response_hash,
    noncompliant_identifiers: partial.noncompliant_identifiers || [],
    // W377 — multimodal defaults. media_kind null === text-only legacy event.
    media_kind: partial.media_kind == null ? null : partial.media_kind,
    media_uri: partial.media_uri == null ? null : partial.media_uri,
    media_hash: partial.media_hash == null ? null : partial.media_hash,
    media_bytes: partial.media_bytes == null ? null : partial.media_bytes,
    media_mime: partial.media_mime == null ? null : partial.media_mime,
    media_extracted_text: partial.media_extracted_text == null ? null : partial.media_extracted_text,
    media_extraction_status: partial.media_extraction_status || 'none',
    media_extraction_engine: partial.media_extraction_engine == null ? null : partial.media_extraction_engine,
    // W411 — canonical vendor + parity field names. vendor defaults to
    // normalized form of provider (or 'other' when provider is unknown).
    // tokens_in/out mirror prompt_tokens/completion_tokens, cost_micro_usd
    // mirrors estimated_cost_usd (in micro-USD), latency_us mirrors
    // latency_ms*1000, files defaults to []. error mirrors error_type's
    // human-readable message when the caller passes it explicitly.
    vendor: partial.vendor != null
      ? normalizeVendor(partial.vendor)
      : normalizeVendor(partial.provider),
    tokens_in: partial.tokens_in != null
      ? partial.tokens_in
      : (partial.prompt_tokens != null ? partial.prompt_tokens : 0),
    tokens_out: partial.tokens_out != null
      ? partial.tokens_out
      : (partial.completion_tokens != null ? partial.completion_tokens : 0),
    cost_micro_usd: partial.cost_micro_usd != null
      ? partial.cost_micro_usd
      : (partial.estimated_cost_usd != null ? Math.round(Number(partial.estimated_cost_usd) * 1_000_000) : 0),
    latency_us: partial.latency_us != null
      ? partial.latency_us
      : (partial.latency_ms != null ? Number(partial.latency_ms) * 1000 : 0),
    files: Array.isArray(partial.files) ? partial.files : [],
    error: partial.error == null ? null : partial.error,
    // W411 — event-level holdout pin (see EVENT_FIELDS comment).
    holdout_only: partial.holdout_only === true,
    // W411 P0 addendum #9 — review-state machine + production gate.
    // Defaults are fail-closed: new rows are 'unreviewed' and not eligible
    // for production-ready artifacts until productionReady() flips them.
    review_state: partial.review_state || 'unreviewed',
    production_eligible: partial.production_eligible === true,
  };
  return canonicalize(base);
}

// canonicalize(ev): coerce types, fill defaults, drop unknown keys.
// Idempotent: canonicalize(canonicalize(x)) === canonicalize(x).
export function canonicalize(ev = {}) {
  const out = {};
  out.event_id = _str(ev.event_id, 128) || _stableId(ev.tenant_id);
  out.tenant_id = _str(ev.tenant_id, 128) || 'local-tenant';
  out.workspace_id = ev.workspace_id == null ? 'default' : _str(ev.workspace_id, 128);
  out.team_id = ev.team_id == null ? null : _str(ev.team_id, 128);
  out.actor_id = ev.actor_id == null ? null : _str(ev.actor_id, 128);
  out.app_id = ev.app_id == null ? null : _str(ev.app_id, 128);
  out.user_id = ev.user_id == null ? null : _str(ev.user_id, 128);
  out.session_id = ev.session_id == null ? null : _str(ev.session_id, 128);
  out.workflow_id = ev.workflow_id == null ? null : _str(ev.workflow_id, 128);
  out.trace_id = ev.trace_id == null ? null : _str(ev.trace_id, 128);

  out.provider = ev.provider == null ? null : _str(ev.provider, 64);
  out.model = ev.model == null ? null : _str(ev.model, 128);
  out.upstream_url = ev.upstream_url == null ? null : _str(ev.upstream_url, 512);
  out.request_hash = ev.request_hash == null ? null : _str(ev.request_hash, 128);
  out.response_hash = ev.response_hash == null ? null : _str(ev.response_hash, 128);

  out.prompt_redacted = ev.prompt_redacted == null ? null : _str(ev.prompt_redacted, 16384);
  out.response_redacted = ev.response_redacted == null ? null : _str(ev.response_redacted, 16384);
  out.raw_prompt_path = ev.raw_prompt_path == null ? null : _str(ev.raw_prompt_path, 1024);
  out.raw_response_path = ev.raw_response_path == null ? null : _str(ev.raw_response_path, 1024);

  out.prompt_tokens = _clampInt(ev.prompt_tokens, 0, 10_000_000);
  out.completion_tokens = _clampInt(ev.completion_tokens, 0, 10_000_000);
  out.estimated_cost_usd = _clampFloat(ev.estimated_cost_usd, 0, 1_000_000);
  out.latency_ms = _clampInt(ev.latency_ms, 0, 24 * 60 * 60 * 1000);

  const st = _str(ev.status, 32) || 'ok';
  out.status = STATUS_VALUES.has(st) ? st : 'ok';
  out.error_type = ev.error_type == null ? null : _str(ev.error_type, 128);

  out.cache_hit = ev.cache_hit === true;
  out.sensitive_data_detected = ev.sensitive_data_detected === true;
  out.sensitive_classes = _arr(ev.sensitive_classes);
  out.redaction_count = _clampInt(ev.redaction_count, 0, 100000);

  out.tool_calls = Array.isArray(ev.tool_calls) ? ev.tool_calls.slice(0, 50) : [];
  out.accepted = ev.accepted == null ? null : !!ev.accepted;
  out.feedback = ev.feedback == null ? null : _str(ev.feedback, 4096);

  let ts = _str(ev.created_at, 64);
  if (!ts || isNaN(Date.parse(ts))) ts = new Date().toISOString();
  out.created_at = ts;

  out.namespace = _str(ev.namespace, 128) || 'default';
  const src = _str(ev.source_type, 32) || 'real';
  out.source_type = SOURCE_TYPES.has(src) ? src : 'real';
  const pol = _str(ev.redaction_policy, 32) || 'redact';
  out.redaction_policy = POLICY_VALUES.has(pol) ? pol : 'redact';
  out.schema_version = _clampInt(ev.schema_version, 1, 1000) || SCHEMA_VERSION;

  // W409b — privacy provenance: fail-closed defaults.
  out.raw_available = ev.raw_available === true;
  out.raw_prompt_hash = ev.raw_prompt_hash == null ? null : _str(ev.raw_prompt_hash, 128);
  out.raw_response_hash = ev.raw_response_hash == null ? null : _str(ev.raw_response_hash, 128);
  out.noncompliant_identifiers = _arr(ev.noncompliant_identifiers);

  // W377 — multimodal fields. media_kind null is a valid (text-only) state;
  // any invalid enum value collapses to null so the downstream loader doesn't
  // have to guess. media_extraction_status defaults to 'none' for legacy rows
  // that never went through the OCR/whisper worker.
  if (ev.media_kind == null) {
    out.media_kind = null;
  } else {
    const mk = _str(ev.media_kind, 32);
    out.media_kind = MEDIA_KINDS.has(mk) ? mk : null;
  }
  out.media_uri = ev.media_uri == null ? null : _str(ev.media_uri, 1024);
  out.media_hash = ev.media_hash == null ? null : _str(ev.media_hash, 128);
  out.media_bytes = ev.media_bytes == null ? null : _clampInt(ev.media_bytes, 0, Number.MAX_SAFE_INTEGER);
  out.media_mime = ev.media_mime == null ? null : _str(ev.media_mime, 128);
  out.media_extracted_text = ev.media_extracted_text == null ? null : _str(ev.media_extracted_text, 1_048_576);
  const xst = _str(ev.media_extraction_status, 32) || 'none';
  out.media_extraction_status = EXTRACTION_STATUS_VALUES.has(xst) ? xst : 'none';
  out.media_extraction_engine = ev.media_extraction_engine == null ? null : _str(ev.media_extraction_engine, 128);

  // W411 — event-level holdout pin. Bool with fail-closed false default;
  // honored by distill-pipeline and the dataset workbench when assigning
  // a split bucket.
  out.holdout_only = ev.holdout_only === true;

  // W411 P0 addendum #9 — review-state + production-eligible coercion.
  // review_state collapses to 'unreviewed' on unknown values so callers
  // cannot smuggle in a 'production' string and trick the gate. The hard
  // gate is fail-closed: any value other than literal `true` becomes false.
  const rev = _str(ev.review_state, 32) || 'unreviewed';
  out.review_state = REVIEW_STATES.has(rev) ? rev : 'unreviewed';
  out.production_eligible = ev.production_eligible === true;

  // W411 — canonical vendor + parity field names. Coerce + clamp so the
  // canonicalize(canonicalize(x)) === canonicalize(x) idempotency contract
  // holds. vendor falls back to the normalized provider when missing so
  // legacy rows that only carry `provider` still report the canonical enum.
  out.vendor = normalizeVendor(ev.vendor != null ? ev.vendor : ev.provider);
  out.tokens_in = _clampInt(
    ev.tokens_in != null ? ev.tokens_in : ev.prompt_tokens,
    0, 10_000_000,
  );
  out.tokens_out = _clampInt(
    ev.tokens_out != null ? ev.tokens_out : ev.completion_tokens,
    0, 10_000_000,
  );
  out.cost_micro_usd = _clampInt(
    ev.cost_micro_usd != null
      ? ev.cost_micro_usd
      : (ev.estimated_cost_usd != null ? Math.round(Number(ev.estimated_cost_usd) * 1_000_000) : 0),
    0, Number.MAX_SAFE_INTEGER,
  );
  out.latency_us = _clampInt(
    ev.latency_us != null
      ? ev.latency_us
      : (ev.latency_ms != null ? Number(ev.latency_ms) * 1000 : 0),
    0, 24 * 60 * 60 * 1_000_000,
  );
  // files: array of small objects/strings describing multimodal attachments.
  // Keep at most 50 entries to cap row size; preserve shape (object or string)
  // rather than coercing to string so the lake can read sha/uri/mime fields.
  if (Array.isArray(ev.files)) {
    out.files = ev.files.slice(0, 50);
  } else {
    out.files = [];
  }
  out.error = ev.error == null ? null : _str(ev.error, 2048);

  return out;
}

// validateEvent(ev): returns {ok, missing[], extra[], errors[]}.
// Missing: required fields absent. Extra: keys not in EVENT_FIELDS. Errors:
// type / range issues that canonicalize() would silently fix.
export function validateEvent(ev) {
  const missing = [];
  const extra = [];
  const errors = [];
  if (!ev || typeof ev !== 'object') {
    return { ok: false, missing: REQUIRED_FIELDS.slice(), extra: [], errors: ['event_is_not_object'] };
  }
  for (const f of REQUIRED_FIELDS) {
    if (ev[f] === undefined || ev[f] === null || ev[f] === '') missing.push(f);
  }
  const allowed = new Set(EVENT_FIELDS);
  for (const k of Object.keys(ev)) {
    if (!allowed.has(k)) extra.push(k);
  }
  if (ev.status && !STATUS_VALUES.has(ev.status)) errors.push('status_invalid');
  if (ev.source_type && !SOURCE_TYPES.has(ev.source_type)) errors.push('source_type_invalid');
  if (ev.redaction_policy && !POLICY_VALUES.has(ev.redaction_policy)) errors.push('redaction_policy_invalid');
  // W377 — multimodal enum checks. Null is allowed; only non-null values get
  // gated. This keeps every legacy text-only event a 1st-class citizen while
  // still catching typos like media_kind:'pdfs' before they hit the store.
  if (ev.media_kind != null && !MEDIA_KINDS.has(ev.media_kind)) errors.push('media_kind_invalid');
  if (ev.media_extraction_status != null && ev.media_extraction_status !== '' && !EXTRACTION_STATUS_VALUES.has(ev.media_extraction_status)) errors.push('media_extraction_status_invalid');
  if (ev.media_bytes != null && (!Number.isFinite(Number(ev.media_bytes)) || Number(ev.media_bytes) < 0)) errors.push('media_bytes_invalid');
  // W411 — vendor closed-enum check. Only flag when set to a non-null value
  // outside the set; null collapses to 'other' in canonicalize so the lake
  // still gets a clean column.
  if (ev.vendor != null && !VENDOR_VALUES.has(String(ev.vendor).toLowerCase())) errors.push('vendor_invalid');
  // W411 — files must be array (or absent). tool_calls follows the same shape.
  if (ev.files != null && !Array.isArray(ev.files)) errors.push('files_invalid');
  return { ok: missing.length === 0 && errors.length === 0, missing, extra, errors };
}

// W411 P0 addendum #9 — legacy row backfill at the READ boundary.
//
// Rows on disk written before W411 do not carry tenant_id (or carry a
// placeholder), source_type, review_state, production_eligible. Reading
// them back as-is would let the data plane treat them as approved real
// customer data — exactly the failure mode the auditor flagged.
//
// backfillLegacy(rawRow) returns a row with safe defaults applied to any
// missing fields:
//   - tenant_id missing/empty/'local-tenant' → 'local'
//   - source_type missing                    → 'legacy_unknown'
//   - review_state missing                   → 'unreviewed'
//   - production_eligible missing            → false
// It then runs canonicalize() so the row is shape-compatible with every
// downstream reader. Rows that already carry these fields are returned
// unchanged (the function is idempotent).
//
// Apply this in listEvents/getEvent/_jsonlAll on read; never on write
// (writes go through newEvent which sets the modern defaults).
export function backfillLegacy(rawRow) {
  if (!rawRow || typeof rawRow !== 'object') return rawRow;
  const r = { ...rawRow };
  if (r.tenant_id == null || r.tenant_id === '' || r.tenant_id === 'local-tenant') {
    // 'local-tenant' was the previous newEvent() default for unauthenticated
    // rows; in retrospect 'local' is the audit-mandated value. Migrate at
    // read time so the lake reports a single canonical name.
    r.tenant_id = 'local';
  }
  if (r.source_type == null) r.source_type = 'legacy_unknown';
  if (r.review_state == null) r.review_state = 'unreviewed';
  if (r.production_eligible == null) r.production_eligible = false;
  // namespace must not be empty — canonicalize defaults to 'default' but the
  // legacy backfill keeps it explicit for the audit trail.
  if (r.namespace == null || r.namespace === '') r.namespace = 'default';
  return canonicalize(r);
}

// templateSignature(prompt, model): deterministic skeleton hash used by lake
// clustering and opportunity detection. Strip identifiers (quoted strings,
// numbers, emails, URLs), take first 200 chars, sha256 prefix 16. Same prompt
// modulo identifiers -> same signature. Used by lake.clusterRepeatedPrompts.
export function templateSignature(prompt = '', model = '') {
  const raw = String(prompt).replace(/\s+/g, ' ').trim().toLowerCase();
  const stripped = raw
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '<email>')
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '"<s>"')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<n>');
  const head = stripped.slice(0, 200);
  const h = crypto.createHash('sha256').update(String(model || '') + ' ' + head).digest('hex').slice(0, 16);
  return { hash: h, normalized: head };
}

// Backwards-compat with the W368 daemon-connector stub: preserved verbatim.
export function hashContent(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex').slice(0, 16);
}
