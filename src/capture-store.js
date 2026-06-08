// Capture-row durable store router.
//
// W212 fix for the Pablo receipt: previously router.js:3959 was
// `try { insert('observations', obs); } catch (_) {}` - a silent swallow.
// If the DB write failed (or /tmp was already recycled on Vercel) the
// customer still received 200 + x-kolm-capture-id for a row that was
// never stored. This module replaces that path with:
//
//   - async insertCapture(row) → throws on failure; caller returns 503
//   - async listCaptures(tenant, namespace, limit) → reads from same backend
//   - countCaptures(tenant, namespace) → for threshold alerts
//   - isDurable() → honest answer about whether the next insert will persist
//   - driverName() → 'vercel_postgres' | 'vercel_kv' | 'sqlite' | 'json'
//
// Driver selection (precedence high → low):
//   1. KOLM_CAPTURE_DRIVER explicit override
//   2. KOLM_STORE_DRIVER if set to vercel_postgres / vercel_kv
//   3. Legacy synchronous store (./store.js) - durable when KOLM_DATA_DIR
//      points outside /tmp, ephemeral otherwise (e.g. default Vercel /tmp).
//
// W409a - the canonical telemetry plane is src/event-store.js (queryable by
// the lake, opportunity engine, dataset workbench, label queue, and training
// planner). For every observation we accept here we ALSO bridge the row into
// the event-store via observationToCanonicalEvent() so the optimization /
// training loop sees the traffic. The two stores are kept in sync per insert
// and the event-store insert is idempotent (INSERT OR REPLACE keyed on
// event_id) so multiple bridge calls for the same row do not duplicate.

import * as store from './store.js';
import { appendEvent } from './event-store.js';
import { hashContent, normalizeVendor } from './event-schema.js';
import { attachCopyrightFlag } from './capture-copyright-filter.js';
import { classifyForQuarantine as classifyCopyrightForQuarantine } from './copyright-detector.js';

const ON_VERCEL = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

let driverPromise = null;
let cachedDriver = null;
let cachedDriverName = null;

function pickDriverName() {
  const explicit = (process.env.KOLM_CAPTURE_DRIVER || '').toLowerCase();
  if (explicit) return explicit;
  const store = (process.env.KOLM_STORE_DRIVER || '').toLowerCase();
  if (store === 'vercel_postgres' || store === 'vercel_kv') return store;
  return 'legacy';
}

async function loadDriver() {
  if (cachedDriver !== null) return cachedDriver;
  if (driverPromise) return driverPromise;
  const name = pickDriverName();
  cachedDriverName = name;
  driverPromise = (async () => {
    if (name === 'vercel_postgres') {
      const mod = await import('./store-drivers/vercel-postgres.js');
      cachedDriver = mod;
      return mod;
    }
    if (name === 'vercel_kv') {
      const mod = await import('./store-drivers/vercel-kv.js');
      cachedDriver = mod;
      return mod;
    }
    cachedDriver = null; // legacy synchronous fallback
    return null;
  })();
  return driverPromise;
}

// Reset for tests; safe to call between unit tests that switch env vars.
export function _resetDriverCache() {
  driverPromise = null;
  cachedDriver = null;
  cachedDriverName = null;
}

export function driverName() {
  if (cachedDriverName) return cachedDriverName;
  return pickDriverName();
}

// `true` when the next insertCapture call will persist beyond a single
// lambda invocation. Honest answer - used by both the response header
// and the /captures dashboard hero copy.
export function isDurable() {
  const name = pickDriverName();
  if (name === 'vercel_postgres' || name === 'vercel_kv') return true;
  // Legacy synchronous store: durable when writes land on a real disk.
  if (!ON_VERCEL) return true;
  const info = store.backendInfo();
  const dir = String(info.data_dir || '');
  // /tmp is per-invocation ephemeral on Vercel/Lambda.
  if (dir.startsWith('/tmp') || dir === '/tmp') return false;
  return true;
}

// W409a - translate a capture-store observation row into the canonical
// event-store shape. Pure function; safe to call without side effects. The
// `provenance` arg (default 'capture-store') stamps the source on every
// canonical event for auditability of the bridge. Used by both the live
// insertCapture path (provenance='capture-store') and the one-shot migration
// (provenance='capture-store-migration'). Returns a partial event suitable
// for appendEvent(); appendEvent will canonicalize + validate.
export function observationToCanonicalEvent(row, opts = {}) {
  if (!row || typeof row !== 'object') return null;
  const provenance = String(opts.provenance || 'capture-store');
  const event_id = String(row.event_id || row.id || ('evt_' + Date.now().toString(36)));
  const tenant_id = String(row.tenant_id || row.tenant || 'local');
  const namespace = String(row.corpus_namespace || row.namespace || 'default');
  const created_at = row.created_at || new Date().toISOString();
  const promptText = row.prompt != null ? String(row.prompt) : '';
  const responseText = row.response != null
    ? (typeof row.response === 'string' ? row.response : JSON.stringify(row.response))
    : '';
  const request_hash = row.template_hash
    || row.request_hash
    || (promptText ? hashContent(promptText + '|' + (row.model || '')) : null);
  const response_hash = row.response_hash
    || (responseText ? hashContent(responseText) : null);
  // status: the capture row sometimes carries the upstream HTTP int (200, 429,
  // etc.) and sometimes a canonical string ('ok'/'error'). Map ints back to
  // canonical so the event schema validator accepts the row.
  let canonStatus = 'ok';
  const s = row.status;
  if (typeof s === 'string') {
    canonStatus = s;
  } else if (typeof s === 'number') {
    if (s === 429) canonStatus = 'rate_limited';
    else if (s === 408 || s === 504) canonStatus = 'timeout';
    else if (s >= 400) canonStatus = 'error';
    else canonStatus = 'ok';
  }
  const sensitiveClasses = Array.isArray(row.sensitive_classes) ? row.sensitive_classes : [];
  return {
    event_id,
    tenant_id,
    // W936 - carry team attribution through to the canonical event so the team
    // dashboard ("who asked what across the org") can query by team_id/actor_id.
    team_id: row.team_id || null,
    actor_id: row.actor_id || row.user_id || null,
    namespace,
    workspace_id: namespace,
    created_at,
    provider: row.provider || null,
    model: row.model || null,
    request_hash,
    response_hash,
    // The capture-store rows are post-redaction (the daemon-connector lake
    // path writes redactedPromptText/respTextForLake). Treat the row's prompt/
    // response as the redacted variant the event lake should see.
    prompt_redacted: promptText.slice(0, 16384) || null,
    response_redacted: responseText.slice(0, 16384) || null,
    prompt_tokens: Number(row.prompt_tokens) || 0,
    completion_tokens: Number(row.completion_tokens) || 0,
    estimated_cost_usd: Number(row.cost_usd != null ? row.cost_usd : row.estimated_cost_usd) || 0,
    latency_ms: Number(row.latency_ms) || (Number(row.latency_us) ? Math.round(row.latency_us / 1000) : 0),
    status: canonStatus,
    error_type: row.error_type || null,
    sensitive_data_detected: !!(row.sensitive_data_detected || sensitiveClasses.length > 0),
    sensitive_classes: sensitiveClasses,
    redaction_count: Number(row.redaction_count) || 0,
    redaction_policy: row.redaction_policy || 'redact',
    // W409b - propagate privacy provenance through the bridge so the canonical
    // event row carries the same raw_available / hash / noncompliant_identifiers
    // tags the capture row recorded. Fail-closed: missing → false / null / [].
    raw_available: row.raw_available === true,
    raw_prompt_hash: row.raw_prompt_hash || null,
    raw_response_hash: row.raw_response_hash || null,
    noncompliant_identifiers: Array.isArray(row.noncompliant_identifiers) ? row.noncompliant_identifiers : [],
    source_type: row.source_type || 'real',
    // W411 - vendor normalization + parity field names. The canonical event
    // lake must report `vendor` (closed enum) so OpenAI / Anthropic /
    // OpenRouter / Ollama / vLLM / llama.cpp all collapse into one switch
    // target downstream. tokens_in/out + cost_micro_usd + latency_us mirror
    // the legacy prompt_tokens/completion_tokens/cost_usd/latency_ms fields
    // with the units the auditor wants on the wire. files carries multimodal
    // attachment metadata (parallel to tool_calls).
    vendor: normalizeVendor(row.vendor || row.provider),
    tokens_in: Number(row.tokens_in != null ? row.tokens_in : row.prompt_tokens) || 0,
    tokens_out: Number(row.tokens_out != null ? row.tokens_out : row.completion_tokens) || 0,
    cost_micro_usd: row.cost_micro_usd != null
      ? Number(row.cost_micro_usd)
      : Math.round((Number(row.cost_usd != null ? row.cost_usd : row.estimated_cost_usd) || 0) * 1_000_000),
    latency_us: row.latency_us != null
      ? Number(row.latency_us)
      : (Number(row.latency_ms) || 0) * 1000,
    files: Array.isArray(row.files) ? row.files : [],
    tool_calls: Array.isArray(row.tool_calls) ? row.tool_calls : [],
    error: row.error == null ? null : String(row.error),
    // W409a - provenance tag so audit can trace each canonical event back to
    // its bridge origin. Stored in feedback for now to avoid widening the
    // schema; opportunity engine + dataset workbench ignore unknown fields.
    feedback: provenance ? ('migrated_from:' + provenance) : null,
  };
}

// W409a - best-effort bridge into the canonical event-store. Never throws.
// Idempotent: appendEvent uses INSERT OR REPLACE keyed on event_id so a
// double-bridge of the same row (e.g. router proxy + migration backfill)
// collapses into one canonical row. Failure to bridge does NOT block the
// capture-store insert (the customer's app already got its upstream answer).
export async function bridgeToEventStore(row, opts = {}) {
  try {
    const ev = observationToCanonicalEvent(row, opts);
    if (!ev) return null;
    return await appendEvent(ev);
  } catch (_) {
    return null;
  }
}

// Throws on write failure so the caller returns 503. The Pablo W211
// silent-swallow pattern is structurally impossible from here.
export async function insertCapture(row) {
  if (!row || typeof row !== 'object') {
    throw new Error('insertCapture: row must be an object');
  }
  // W708-4 - defensive copyright-risk flag before persistence. Pure
  // observability: stamps copyright_flagged + copyright_reasons[] on the
  // row so downstream (distill-time / dataset workbench / label queue) can
  // filter. Failure NEVER blocks the capture write - the caller already got
  // its upstream answer; losing the flag is better than losing the row.
  try { attachCopyrightFlag(row); } catch (_) { /* never block insert */ }
  // W750-followup - Heuristic copyright detector (regex pack for Disney
  // names, song-title n-grams, code copyright headers). This runs AFTER
  // the W708 paywall-shape detector and serves as the W808 staged_captures
  // post-quarantine classifier: when it fires, we stamp a structured
  // flag_reason on the row so the staged-captures UI can surface
  // `copyright_heuristic:<categories>` next to the existing 3σ anomaly
  // flag. The W808 staged_captures table consumes this via
  // staged_captures.flag_reason (it carries through insertStagedCapture
  // because we mutate the row in place before the staged copy is taken).
  //
  // GATING: KOLM_W750_COPYRIGHT_DETECTOR=off skips this entirely so the
  // W808 happy-path remains byte-stable when an operator wants to disable
  // the heuristic without redeploying.
  if (process.env.KOLM_W750_COPYRIGHT_DETECTOR !== 'off') {
    try {
      const v = classifyCopyrightForQuarantine(row);
      if (v && v.should_quarantine && v.reason) {
        const prior = typeof row.flag_reason === 'string' && row.flag_reason
          ? row.flag_reason + ';' : '';
        row.flag_reason = prior + v.reason;
        row.copyright_heuristic_flagged = true;
        row.copyright_heuristic_risk = v.risk_score;
        if (Array.isArray(v.hits)) {
          row.copyright_heuristic_hits = v.hits.map(h => ({
            kind: h.kind,
            matched: h.matched,
            side: h.side || null,
          }));
        }
      }
    } catch (_) { /* never block insert */ }
  }
  const driver = await loadDriver();
  if (driver) {
    await driver.insert('observations', row);
    // W409a - mirror into the canonical event-store so the lake + optimizer
    // see it. Best-effort, post-insert.
    await bridgeToEventStore(row);
    return row;
  }
  // Legacy path: refuse to silently lose data when the deploy is on
  // ephemeral /tmp without a durable driver opt-in.
  if (!isDurable()) {
    const err = new Error(
      'capture_store_ephemeral: this deployment writes captures to /tmp ' +
      'which does not survive lambda recycling. Set KOLM_STORE_DRIVER=' +
      'vercel_postgres (recommended) or KOLM_DATA_DIR to a persistent path.'
    );
    err.code = 'CAPTURE_STORE_EPHEMERAL';
    throw err;
  }
  // Synchronous insert may throw (disk full, permission, JSON parse) - 
  // we propagate instead of swallowing.
  store.insert('observations', row);
  // W409a - same bridge for the legacy synchronous path.
  await bridgeToEventStore(row);
  return row;
}

export async function listCaptures(tenant, namespace, limit = 10000, opts = {}) {
  const includeDiscarded = !!opts.includeDiscarded;
  const driver = await loadDriver();
  if (driver && driver.findByTenantNamespace) {
    const rows = await driver.findByTenantNamespace('observations', tenant, namespace, limit);
    return includeDiscarded ? rows : rows.filter((o) => !o.discarded);
  }
  // Legacy: synchronous filter on in-memory rows.
  const rows = store.all('observations');
  return rows.filter((o) =>
    o.tenant === tenant
    && (o.corpus_namespace === namespace || (namespace === 'default' && !o.corpus_namespace))
    && (includeDiscarded || !o.discarded)
  ).slice(0, limit);
}

// All observations rows for a tenant (across every namespace). Used by
// /v1/account/export and the customer-visible audit feed so the same
// rows captured via the proxy show up in the bundle the customer downloads.
export async function allCapturesForTenant(tenant, limit = 50000) {
  const driver = await loadDriver();
  if (driver && driver.all) {
    const rows = await driver.all('observations');
    return rows.filter((o) => o && (
      o.tenant === tenant
      || o.tenant_id === tenant
    )).slice(0, limit);
  }
  const rows = store.all('observations');
  return rows.filter((o) => o && (
    o.tenant === tenant
    || o.tenant_id === tenant
  )).slice(0, limit);
}

export async function countCaptures(tenant, namespace) {
  const driver = await loadDriver();
  if (driver && driver.count) {
    return driver.count('observations', { tenant, namespace });
  }
  const rows = store.all('observations');
  return rows.filter((o) =>
    o.tenant === tenant
    && (o.corpus_namespace === namespace || (namespace === 'default' && !o.corpus_namespace))
  ).length;
}

export async function health() {
  const driver = await loadDriver();
  if (driver && driver.health) return driver.health();
  return {
    driver: cachedDriverName || pickDriverName(),
    ok: true,
    legacy: true,
    durable: isDurable(),
    data_dir: store.backendInfo().data_dir,
  };
}
