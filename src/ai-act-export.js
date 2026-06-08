// W766-1 + W766-3 + W766-4 - EU AI Act technical documentation export,
// human-in-the-loop config, and data governance reports.
//
// Annex IV of Regulation (EU) 2024/1689 enumerates the technical-documentation
// items every high-risk AI system must carry: intended purpose, system
// architecture, training data summary, performance metrics, risk management,
// human-oversight measures, accuracy metrics, cybersecurity measures, and a
// post-market monitoring plan. This module assembles those nine fields from a
// kolm artifact manifest and emits an Annex-IV-shaped envelope.
//
// HONESTY CONTRACT (do not violate):
//   * Fields the manifest does NOT carry are stamped 'not_yet_disclosed' - 
//     NEVER fabricated. A regulator reading the output must be able to tell
//     "this builder has not yet attested to X" vs "X is empty by design".
//   * buildGovernanceReport runs every event-store read under a per-row
//     tenant filter (W411 defense-in-depth). The query filter alone is not
//     enough - a future schema bug could leak across tenants, so the loop
//     body always re-checks row.tenant_id.
//   * humanInLoopConfig validates threshold ∈ [0, 10] nats. NEVER persists an
//     out-of-range value. Out-of-range → honest ok:false envelope.
//
// DI testing seam - every external interaction (storeMod, eventStore) can be
// overridden via opts so tests can pass in-memory fakes and avoid the real
// disk/sqlite paths.
//
// W604 anti-brittleness - AI_ACT_EXPORT_VERSION = 'w766-v1', test pins both
// /^w766-/ AND the literal value.

import {
  scoreArtifactRisk,
  AI_ACT_RISK_VERSION,
} from './ai-act-risk.js';

export const AI_ACT_EXPORT_VERSION = 'w766-v1';

// The nine Annex IV fields, in canonical order so the JSON output is byte-
// stable across runs.
export const ANNEX_IV_FIELDS = Object.freeze([
  'intended_purpose',
  'system_architecture',
  'training_data_summary',
  'performance_metrics',
  'risk_management',
  'human_oversight_measures',
  'accuracy_metrics',
  'cybersecurity_measures',
  'postmarket_monitoring_plan',
]);

// Honest placeholder string - a regulator reading the export must see that
// the builder has not yet attested to this field.
const NOT_YET_DISCLOSED = 'not_yet_disclosed';

function _nowIso() {
  return new Date().toISOString();
}

// _disclosedOr(value, fallback) - return the manifest value if it's a non-empty
// string OR a non-empty object. Otherwise return the NOT_YET_DISCLOSED string.
// We deliberately do NOT coerce numbers / booleans because Annex IV fields are
// all narrative or structured-object fields per the regulation text.
function _disclosedOr(value) {
  if (typeof value === 'string') {
    const s = value.trim();
    return s.length > 0 ? s : NOT_YET_DISCLOSED;
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? value : NOT_YET_DISCLOSED;
  }
  if (value != null && typeof value === 'object') {
    return Object.keys(value).length > 0 ? value : NOT_YET_DISCLOSED;
  }
  return NOT_YET_DISCLOSED;
}

// buildTechnicalDocumentation(manifest, opts) - return the Annex IV envelope.
//
// opts:
//   format               'json' | 'markdown'  default 'json'
//   risk_category        override the derived risk_category (rare - 
//                        used when an external assessor has already classified
//                        the system).
//
// Returns: { ok, version, generated_at, format, risk_assessment, annex_iv:{ ...9 fields... } }
// or { ok:false, error, hint, version } on invalid input.
export function buildTechnicalDocumentation(manifest, opts = {}) {
  const format = opts && opts.format === 'markdown' ? 'markdown' : 'json';
  if (manifest == null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return {
      ok: false,
      error: 'invalid_manifest',
      hint: 'manifest must be a non-null object (kolm artifact manifest.json)',
      version: AI_ACT_EXPORT_VERSION,
    };
  }

  // Derive risk assessment (or accept caller override).
  let risk_assessment;
  if (opts && opts.risk_category) {
    risk_assessment = {
      ok: true,
      risk_category: opts.risk_category,
      task_category: typeof manifest.task_category === 'string' ? manifest.task_category : null,
      reasoning: 'risk_category supplied by caller (external assessor override)',
      version: AI_ACT_RISK_VERSION,
      transparency_requirements: [],
      human_oversight_required: opts.risk_category === 'high',
      conformity_assessment_required: opts.risk_category === 'high',
    };
  } else {
    risk_assessment = scoreArtifactRisk(manifest);
  }

  // Source each Annex IV field from manifest, falling back to
  // NOT_YET_DISCLOSED for fields the manifest does not carry.
  //
  // Manifest field naming follows the kolm artifact conventions; we accept a
  // small set of aliases for back-compat with W144-era manifests.
  const annex_iv = {
    intended_purpose: _disclosedOr(
      manifest.intended_purpose
        || manifest.intended_use
        || manifest.purpose,
    ),
    system_architecture: _disclosedOr(
      manifest.system_architecture
        || manifest.architecture
        || (manifest.model && {
          base_model: manifest.model.base || NOT_YET_DISCLOSED,
          quantization: manifest.model.quantization || NOT_YET_DISCLOSED,
          parameters: manifest.model.parameters || NOT_YET_DISCLOSED,
        }),
    ),
    training_data_summary: _disclosedOr(
      manifest.training_data_summary
        || manifest.dataset
        || (manifest.captures_summary && {
          n_captures: manifest.captures_summary.n || NOT_YET_DISCLOSED,
          date_range: manifest.captures_summary.date_range || NOT_YET_DISCLOSED,
          source_types: manifest.captures_summary.source_types || NOT_YET_DISCLOSED,
        }),
    ),
    performance_metrics: _disclosedOr(
      manifest.performance_metrics
        || manifest.eval_metrics
        || manifest.metrics,
    ),
    risk_management: _disclosedOr(
      manifest.risk_management
        || manifest.risk_assessment,
    ),
    human_oversight_measures: _disclosedOr(
      manifest.human_oversight_measures
        || manifest.human_in_the_loop
        || (risk_assessment.ok && risk_assessment.human_oversight_required
          ? `Required per Article 14 (risk_category=${risk_assessment.risk_category}); configure via /v1/compliance/ai-act/human-in-loop`
          : null),
    ),
    accuracy_metrics: _disclosedOr(
      manifest.accuracy_metrics
        || manifest.real_eval
        || (manifest.performance_metrics && {
          accuracy: manifest.performance_metrics.accuracy || NOT_YET_DISCLOSED,
          kscore: manifest.performance_metrics.kscore || NOT_YET_DISCLOSED,
        }),
    ),
    cybersecurity_measures: _disclosedOr(
      manifest.cybersecurity_measures
        || manifest.security_measures
        || (manifest.confidential_compute && {
          attestation_present: true,
          attestation_kind: manifest.confidential_compute.attestation_kind || NOT_YET_DISCLOSED,
        }),
    ),
    postmarket_monitoring_plan: _disclosedOr(
      manifest.postmarket_monitoring_plan
        || manifest.monitoring_plan,
    ),
  };

  const envelope = {
    ok: true,
    version: AI_ACT_EXPORT_VERSION,
    generated_at: _nowIso(),
    format,
    risk_assessment,
    annex_iv,
  };

  if (format === 'markdown') {
    envelope.markdown = _renderMarkdown(envelope);
  }

  return envelope;
}

// _renderMarkdown(envelope) - emit a human-readable Annex IV markdown table
// in JSON-envelope form so callers that asked for markdown still get a
// JSON-parseable response (markdown sits in the .markdown field).
function _renderMarkdown(envelope) {
  const lines = [];
  lines.push('# EU AI Act Technical Documentation (Annex IV)');
  lines.push('');
  lines.push(`Generated at: ${envelope.generated_at}`);
  lines.push(`Toolkit version: ${envelope.version}`);
  lines.push('');
  if (envelope.risk_assessment && envelope.risk_assessment.ok) {
    lines.push('## Risk Assessment');
    lines.push('');
    lines.push(`- Risk category: ${envelope.risk_assessment.risk_category}`);
    if (envelope.risk_assessment.task_category) {
      lines.push(`- Task category: ${envelope.risk_assessment.task_category}`);
    }
    lines.push(`- Reasoning: ${envelope.risk_assessment.reasoning}`);
    lines.push(`- Human oversight required: ${envelope.risk_assessment.human_oversight_required}`);
    lines.push(`- Conformity assessment required: ${envelope.risk_assessment.conformity_assessment_required}`);
    lines.push('');
  }
  lines.push('## Annex IV fields');
  lines.push('');
  for (const key of ANNEX_IV_FIELDS) {
    const v = envelope.annex_iv[key];
    lines.push(`### ${key}`);
    lines.push('');
    if (v === NOT_YET_DISCLOSED) {
      lines.push(`> ${NOT_YET_DISCLOSED}`);
    } else if (typeof v === 'string') {
      lines.push(v);
    } else {
      lines.push('```json');
      lines.push(JSON.stringify(v, null, 2));
      lines.push('```');
    }
    lines.push('');
  }
  return lines.join('\n');
}

// buildGovernanceReport({tenant_id, namespace, manifest_ids, time_range,
// storeMod, eventStore}) - aggregate captures via tenant-fenced read +
// per-row tenant filter (W411 defense-in-depth).
//
// Returns:
//   { ok:true, report:{count_total, count_high_risk,
//                       count_human_in_loop_triggered,
//                       average_confidence_at_decision,
//                       oldest_capture_at, newest_capture_at, by_namespace},
//     generated_at, version }
// or:
//   { ok:false, error:'tenant_required' | 'invalid_input', hint, version }
export async function buildGovernanceReport(opts = {}) {
  const {
    tenant_id = null,
    namespace = null,
    manifest_ids = null,
    time_range = null,
  } = opts || {};

  if (!tenant_id) {
    return {
      ok: false,
      error: 'tenant_required',
      hint: 'tenant_id is required so the report is tenant-fenced.',
      version: AI_ACT_EXPORT_VERSION,
    };
  }

  // DI seam - accept opts.eventStore for tests; fall back to the real module.
  let eventStore = opts.eventStore;
  if (!eventStore) {
    try {
      eventStore = await import('./event-store.js');
    } catch (e) {
      return {
        ok: false,
        error: 'event_store_unavailable',
        hint: 'failed to import event-store; tests should inject opts.eventStore',
        detail: String(e && e.message || e),
        version: AI_ACT_EXPORT_VERSION,
      };
    }
  }

  // Pull captures (the dataset rows). The event-store stores everything as
  // "events"; captures are the rows that have a request_hash / response_hash.
  // We use listEvents tenant_id filter, then re-filter in the loop body
  // (W411 defense-in-depth - never trust the query filter alone).
  const query = {
    tenant_id,
    limit: 10000,
    order: 'desc',
  };
  if (namespace) query.namespace = String(namespace);
  if (time_range && typeof time_range === 'object') {
    if (time_range.from) query.since = time_range.from;
    if (time_range.to) query.until = time_range.to;
  }

  let rows = [];
  try {
    rows = await eventStore.listEvents(query);
  } catch (e) {
    return {
      ok: false,
      error: 'event_store_query_failed',
      detail: String(e && e.message || e),
      version: AI_ACT_EXPORT_VERSION,
    };
  }
  if (!Array.isArray(rows)) rows = [];

  // Collect manifest_id set (if caller restricted us to specific manifests).
  const manifestSet = Array.isArray(manifest_ids) && manifest_ids.length > 0
    ? new Set(manifest_ids.map(String))
    : null;

  // Aggregate counters.
  let count_total = 0;
  let count_high_risk = 0;
  let count_human_in_loop_triggered = 0;
  let sum_confidence = 0;
  let n_confidence = 0;
  let oldest_at = null;
  let newest_at = null;
  const by_namespace = {};

  for (const row of rows) {
    // Defense-in-depth - re-check tenant_id on every row.
    if (!row || row.tenant_id !== tenant_id) continue;
    // Skip routing-threshold marker rows and forget markers - those are
    // governance metadata, not captures.
    if (row.provider === 'kolm_routing_threshold') continue;
    if (row.provider === 'kolm_capture_forget') continue;
    if (row.provider === 'kolm_human_review_threshold') continue;
    // Optional manifest_id restriction.
    if (manifestSet && row.manifest_id != null && !manifestSet.has(String(row.manifest_id))) {
      continue;
    }
    count_total += 1;
    // Bucket by namespace.
    const ns = row.namespace || '(default)';
    by_namespace[ns] = (by_namespace[ns] || 0) + 1;
    // Track timestamp range.
    const t = row.created_at;
    if (t) {
      if (oldest_at == null || t < oldest_at) oldest_at = t;
      if (newest_at == null || t > newest_at) newest_at = t;
    }
    // Detect human-in-the-loop trigger markers. Either a structured tag on
    // the row OR a feedback blob that says 'human_review_triggered'.
    if (row.human_in_loop_triggered === true) {
      count_human_in_loop_triggered += 1;
    } else if (typeof row.feedback === 'string') {
      // Parse only if it looks like JSON; cheap check.
      const fb = row.feedback;
      if (fb.length > 0 && (fb[0] === '{' || fb[0] === '[')) {
        try {
          const blob = JSON.parse(fb);
          if (blob && (blob.human_review_triggered === true
            || blob.kind === 'human_review_triggered')) {
            count_human_in_loop_triggered += 1;
          }
        } catch (_) { /* not JSON, skip */ }
      }
    }
    // Risk category - derive once per row if we can find a task hint.
    if (typeof row.task_category === 'string') {
      const sc = scoreArtifactRisk({ task_category: row.task_category });
      if (sc.ok && sc.risk_category === 'high') count_high_risk += 1;
    } else if (typeof row.vertical === 'string') {
      const sc = scoreArtifactRisk({ vertical: row.vertical });
      if (sc.ok && sc.risk_category === 'high') count_high_risk += 1;
    }
    // Confidence-at-decision (from W709 router; lives on the row as
    // entropy_at_decision / confidence_at_decision).
    if (typeof row.confidence_at_decision === 'number'
        && Number.isFinite(row.confidence_at_decision)) {
      sum_confidence += row.confidence_at_decision;
      n_confidence += 1;
    } else if (typeof row.entropy_at_decision === 'number'
        && Number.isFinite(row.entropy_at_decision)) {
      // Convert entropy (nats) to a rough confidence (1 - normalized entropy).
      const conf = Math.max(0, Math.min(1, 1 - row.entropy_at_decision / 10));
      sum_confidence += conf;
      n_confidence += 1;
    }
  }

  const average_confidence_at_decision = n_confidence > 0
    ? sum_confidence / n_confidence
    : null;

  const report = {
    tenant_id,
    namespace: namespace || null,
    count_total,
    count_high_risk,
    count_human_in_loop_triggered,
    average_confidence_at_decision,
    oldest_capture_at: oldest_at,
    newest_capture_at: newest_at,
    by_namespace,
    time_range: time_range || null,
  };

  return {
    ok: true,
    report,
    generated_at: _nowIso(),
    version: AI_ACT_EXPORT_VERSION,
  };
}

// humanInLoopConfig({tenant_id, namespace, threshold_nats, eventStore,
// routingThresholdMod}) - persist the per-namespace human-review threshold.
//
// Backed by W709's setNamespaceThreshold (event-store appendEvent under
// provider='kolm_human_review_threshold'). Threshold validated ∈ [0, 10] nats.
//
// Returns:
//   { ok:true, namespace, threshold_nats, persisted_event_id, version }
// or:
//   { ok:false, error, hint, version }
export async function humanInLoopConfig(opts = {}) {
  const {
    tenant_id = null,
    namespace = null,
    threshold_nats = null,
  } = opts || {};

  if (!tenant_id) {
    return {
      ok: false,
      error: 'tenant_required',
      hint: 'tenant_id is required so the threshold is scoped per tenant',
      version: AI_ACT_EXPORT_VERSION,
    };
  }
  if (!namespace) {
    return {
      ok: false,
      error: 'namespace_required',
      hint: 'namespace is required - thresholds are per-namespace',
      version: AI_ACT_EXPORT_VERSION,
    };
  }
  const n = Number(threshold_nats);
  if (!Number.isFinite(n)) {
    return {
      ok: false,
      error: 'invalid_threshold',
      hint: 'threshold_nats must be a finite number in [0, 10]',
      version: AI_ACT_EXPORT_VERSION,
    };
  }
  if (n < 0 || n > 10) {
    return {
      ok: false,
      error: 'invalid_threshold',
      hint: `threshold_nats=${n} out of range [0, 10]; reject loudly per honesty contract`,
      min: 0,
      max: 10,
      version: AI_ACT_EXPORT_VERSION,
    };
  }

  // DI seam - accept opts.eventStore + opts.routingThresholdMod for tests.
  let eventStore = opts.eventStore;
  if (!eventStore) {
    try {
      eventStore = await import('./event-store.js');
    } catch (e) {
      return {
        ok: false,
        error: 'event_store_unavailable',
        detail: String(e && e.message || e),
        version: AI_ACT_EXPORT_VERSION,
      };
    }
  }

  // Write a durable marker. We use our own provider tag so the
  // routing-threshold subsystem (W709) is not implicitly overridden - this is
  // a distinct knob: "below this confidence, route to a HUMAN reviewer",
  // whereas W709's threshold is "below this confidence, route to TEACHER".
  // Both subsystems can read each other's markers later if desired.
  let ev;
  try {
    ev = await eventStore.appendEvent({
      tenant_id: String(tenant_id),
      namespace: String(namespace),
      provider: 'kolm_human_review_threshold',
      feedback: JSON.stringify({
        kind: 'human_review_threshold_override',
        threshold_nats: n,
        set_at: _nowIso(),
        source: 'humanInLoopConfig',
        version: AI_ACT_EXPORT_VERSION,
      }),
      status: 'ok',
      source_type: 'real',
    });
  } catch (e) {
    return {
      ok: false,
      error: 'append_event_failed',
      detail: String(e && e.message || e),
      version: AI_ACT_EXPORT_VERSION,
    };
  }

  return {
    ok: true,
    tenant_id,
    namespace,
    threshold_nats: n,
    persisted_event_id: ev && ev.event_id ? ev.event_id : null,
    persisted_at: ev && ev.created_at ? ev.created_at : null,
    version: AI_ACT_EXPORT_VERSION,
  };
}

// getHumanInLoopThreshold({tenant_id, namespace, eventStore}) - read back the
// most recent threshold for a (tenant, namespace) pair. Returns null if no
// override has been configured.
//
// Defense-in-depth tenant fence - listEvents tenant_id filter AND per-row
// tenant_id re-check.
export async function getHumanInLoopThreshold(opts = {}) {
  const { tenant_id = null, namespace = null } = opts || {};
  if (!tenant_id || !namespace) return null;
  let eventStore = opts.eventStore;
  if (!eventStore) {
    try {
      eventStore = await import('./event-store.js');
    } catch (_) { return null; }
  }
  let rows = [];
  try {
    rows = await eventStore.listEvents({
      tenant_id,
      namespace: String(namespace),
      provider: 'kolm_human_review_threshold',
      limit: 50,
      order: 'desc',
    });
  } catch (_) { return null; }
  for (const row of rows) {
    if (!row || row.tenant_id !== tenant_id) continue; // defense-in-depth
    if (!row.feedback) continue;
    try {
      const blob = JSON.parse(row.feedback);
      if (blob && blob.kind === 'human_review_threshold_override') {
        const n = Number(blob.threshold_nats);
        if (Number.isFinite(n) && n >= 0 && n <= 10) return n;
      }
    } catch (_) { continue; }
  }
  return null;
}
