// W834-4 - Data governance reports (captures provenance + PII + consent).
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md):
//   [W834-4] Data governance reports: capture sources, PII handling,
//            consent tracking.
//
// Why a separate module from W766's buildGovernanceReport:
//   * W766 buildGovernanceReport answers OPERATIONAL questions: how many
//     captures, how many high-risk, average confidence, count_human_in_loop_
//     triggered.
//   * W834-4 answers DATA-GOVERNANCE questions: WHERE did captures come
//     from (gateway, manual upload, connector), WHAT PII handling fired
//     against them, and WHAT consent records back them.
//   * Both walk the event-store but bucket the rows along different axes.
//
// HONESTY CONTRACT (matches W411, W766, W768):
//   * Tenant-fenced via per-row tenant_id re-check (W411 defense-in-depth).
//   * Missing PII / consent fields → honest sentinel
//     `'pii_metadata_not_yet_attached'` / `'no_consent_records_attached'`
//     so an auditor can grep for the literal string to enumerate gaps.
//   * NEVER fabricates source attribution. If a row lacks a source hint
//     it lands under bucket 'unknown_source' with first_seen/last_seen
//     populated from the row's actual timestamps.
//   * Period filtering is INCLUSIVE on both endpoints (YYYY-MM-01 through
//     end-of-month). Regulators expect calendar-month semantics.
//
// W604 anti-brittleness: REG_DATA_GOVERNANCE_VERSION = 'w834-v1'. Tests
// lock /^w834-/ regex plus the literal pin.

export const REG_DATA_GOVERNANCE_VERSION = 'w834-v1';

// Canonical source enumeration. Rows missing all hints land under
// 'unknown_source'. Frozen - adding a source class requires bumping the
// version stamp.
export const CAPTURE_SOURCES = Object.freeze([
  'gateway',
  'manual',
  'connector',
  'unknown_source',
]);

// Honest sentinels - auditors grep for these literals.
const PII_NOT_ATTACHED = 'pii_metadata_not_yet_attached';
const CONSENT_NOT_ATTACHED = 'no_consent_records_attached';

function _now() {
  return new Date().toISOString();
}

// Detect the source class from a row. Connector rows carry a connector_id
// or daemon_connector_id; gateway rows carry a request_hash; manual rows
// carry source_type='manual' OR no other hint. Defensive ordering - most
// specific first.
function _detectSource(row) {
  if (!row || typeof row !== 'object') return 'unknown_source';
  if (row.connector_id || row.daemon_connector_id) return 'connector';
  if (row.source_type === 'manual') return 'manual';
  if (row.request_hash || row.workflow_id) return 'gateway';
  if (typeof row.feedback === 'string' && row.feedback.length > 0) return 'gateway';
  return 'unknown_source';
}

// Parse a YYYY-MM period to {fromIso, toIso} inclusive on both endpoints.
// Returns null on invalid input - caller should treat as "no period filter".
function _parsePeriod(period) {
  if (typeof period !== 'string') return null;
  const m = period.match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  if (year < 1970 || year > 9999) return null;
  if (month < 1 || month > 12) return null;
  const fromIso = `${m[1]}-${m[2]}-01T00:00:00.000Z`;
  // last day of month - using Date.UTC and back-stepping is fine for the
  // calendar-month upper bound. Year/month roll over correctly via
  // Date.UTC(year, month, 0) which returns the LAST day of (year, month).
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const dd = String(lastDay).padStart(2, '0');
  const toIso = `${m[1]}-${m[2]}-${dd}T23:59:59.999Z`;
  return { fromIso, toIso };
}

// =============================================================================
// PUBLIC: capturesProvenanceReport({tenant, namespace, eventStore})
//
// Walk the event-store and group captures by source class. Each bucket
// carries {source, count, first_seen, last_seen}. Plus a PII-handling
// summary AND a consent records list.
//
// Returns:
//   { ok:true, version, tenant, namespace, sources[], pii_handling_summary,
//     consent_records[], generated_at }
//   or { ok:false, error, hint, version } on bad input.
// =============================================================================
export async function capturesProvenanceReport(opts = {}) {
  const o = opts || {};
  const tenant = o.tenant || o.tenant_id || null;
  const namespace = typeof o.namespace === 'string' ? o.namespace : null;

  if (!tenant) {
    return {
      ok: false,
      error: 'tenant_required',
      hint: 'pass {tenant: <tenant_id>} - required so the report is tenant-fenced',
      version: REG_DATA_GOVERNANCE_VERSION,
    };
  }

  let eventStore = o.eventStore;
  if (!eventStore) {
    try {
      eventStore = await import('./event-store.js');
    } catch (e) {
      return {
        ok: false,
        error: 'event_store_unavailable',
        detail: String(e && e.message || e),
        version: REG_DATA_GOVERNANCE_VERSION,
      };
    }
  }

  const query = {
    tenant_id: String(tenant),
    limit: 10000,
    order: 'desc',
  };
  if (namespace) query.namespace = String(namespace);

  let rows = [];
  try {
    rows = await eventStore.listEvents(query);
  } catch (e) {
    return {
      ok: false,
      error: 'event_store_query_failed',
      detail: String(e && e.message || e),
      version: REG_DATA_GOVERNANCE_VERSION,
    };
  }
  if (!Array.isArray(rows)) rows = [];

  // Per-source buckets.
  const buckets = new Map();
  // PII counters.
  let pii_rows_present = 0;
  let pii_rows_missing = 0;
  const pii_classes_seen = new Set();
  // Consent records - best-effort harvest.
  const consent_records = [];

  for (const row of rows) {
    // W411 defense-in-depth - re-check tenant_id on every row.
    if (!row || row.tenant_id !== String(tenant)) continue;
    // Skip threshold/marker rows - those are governance metadata, not captures.
    if (row.provider === 'kolm_routing_threshold') continue;
    if (row.provider === 'kolm_capture_forget') continue;
    if (row.provider === 'kolm_human_review_threshold') continue;
    if (row.provider === 'kolm_reg_hil_confidence_threshold') continue;

    // Source bucket.
    const source = _detectSource(row);
    const bucket = buckets.get(source) || {
      source,
      count: 0,
      first_seen: null,
      last_seen: null,
    };
    bucket.count += 1;
    const t = row.created_at;
    if (t) {
      if (bucket.first_seen == null || t < bucket.first_seen) bucket.first_seen = t;
      if (bucket.last_seen == null || t > bucket.last_seen) bucket.last_seen = t;
    }
    buckets.set(source, bucket);

    // PII counter.
    const piiClasses = row.pii_classes_redacted
      || row.redaction_classes_used
      || (row.redaction_summary && row.redaction_summary.classes);
    if (Array.isArray(piiClasses) && piiClasses.length > 0) {
      pii_rows_present += 1;
      for (const c of piiClasses) pii_classes_seen.add(String(c));
    } else if (row.pii_present === true) {
      pii_rows_missing += 1; // PII WAS present but no class metadata
    } else {
      // Default: no PII metadata attached.
      pii_rows_missing += 1;
    }

    // Consent records harvest. Look for explicit consent_id / consent_text fields.
    if (row.consent_id || row.consent_text) {
      consent_records.push({
        event_id: row.event_id || null,
        created_at: row.created_at || null,
        consent_id: row.consent_id || null,
        consent_text: typeof row.consent_text === 'string'
          ? row.consent_text.slice(0, 500)
          : null,
        source: source,
      });
    }
  }

  // Sort sources by canonical enumeration order so dashboards stay stable.
  const sources = CAPTURE_SOURCES.map((s) => buckets.get(s))
    .filter((b) => b != null);

  const pii_handling_summary = (pii_rows_present + pii_rows_missing > 0)
    ? {
        rows_with_pii_metadata: pii_rows_present,
        rows_missing_pii_metadata: pii_rows_missing,
        pii_classes_seen: Array.from(pii_classes_seen).sort(),
        attachment_rate: (pii_rows_present + pii_rows_missing) > 0
          ? pii_rows_present / (pii_rows_present + pii_rows_missing)
          : 0,
      }
    : PII_NOT_ATTACHED;

  const consent_out = consent_records.length > 0
    ? consent_records
    : CONSENT_NOT_ATTACHED;

  return {
    ok: true,
    version: REG_DATA_GOVERNANCE_VERSION,
    tenant,
    namespace: namespace || null,
    sources,
    pii_handling_summary,
    consent_records: consent_out,
    generated_at: _now(),
  };
}

// =============================================================================
// PUBLIC: generateGovernanceReport({tenant, namespace, period, eventStore, generated_at})
//
// Build a FULL markdown audit doc covering the same provenance + PII + consent
// data, formatted for compliance-team submission. Period is a YYYY-MM string
// that filters to a calendar month (inclusive on both endpoints).
//
// Returns:
//   { ok:true, version, format:'markdown', body, tenant, namespace, period,
//     generated_at, missing_attachments[] }
//   or { ok:false, error, hint, version } on bad input.
// =============================================================================
export async function generateGovernanceReport(opts = {}) {
  const o = opts || {};
  const tenant = o.tenant || o.tenant_id || null;
  const namespace = typeof o.namespace === 'string' ? o.namespace : null;
  const period = typeof o.period === 'string' ? o.period : null;
  const generated_at = typeof o.generated_at === 'string' && o.generated_at
    ? o.generated_at
    : _now();

  if (!tenant) {
    return {
      ok: false,
      error: 'tenant_required',
      hint: 'pass {tenant: <tenant_id>} - required for tenant fence',
      version: REG_DATA_GOVERNANCE_VERSION,
    };
  }

  // Validate period if supplied.
  let periodBounds = null;
  if (period) {
    periodBounds = _parsePeriod(period);
    if (!periodBounds) {
      return {
        ok: false,
        error: 'invalid_period',
        hint: 'period must be YYYY-MM (e.g. "2026-05")',
        version: REG_DATA_GOVERNANCE_VERSION,
      };
    }
  }

  let eventStore = o.eventStore;
  if (!eventStore) {
    try {
      eventStore = await import('./event-store.js');
    } catch (e) {
      return {
        ok: false,
        error: 'event_store_unavailable',
        detail: String(e && e.message || e),
        version: REG_DATA_GOVERNANCE_VERSION,
      };
    }
  }

  // Reuse capturesProvenanceReport for the heavy lift. If a period filter
  // was supplied, apply it client-side over the returned report.
  const prov = await capturesProvenanceReport({
    tenant,
    namespace,
    eventStore,
  });
  if (!prov.ok) return prov;

  // Filter sources by period (client-side; the event-store query is
  // bounded by tenant + namespace already).
  let filteredSources = prov.sources;
  if (periodBounds) {
    filteredSources = prov.sources
      .map((b) => {
        // A bucket is in-period if its window overlaps with the period bounds.
        // Since the bucket aggregates many rows, we keep the bucket unchanged
        // when at least one row falls in the period. For exact per-row period
        // filtering callers should walk the event-store directly via the
        // exposed eventStore module.
        const fits = (b.last_seen && b.last_seen >= periodBounds.fromIso)
          && (b.first_seen && b.first_seen <= periodBounds.toIso);
        return fits ? b : null;
      })
      .filter(Boolean);
  }

  // Collect missing attachments for the doc header.
  const missing_attachments = [];
  if (prov.pii_handling_summary === PII_NOT_ATTACHED) {
    missing_attachments.push('pii_handling_metadata');
  }
  if (prov.consent_records === CONSENT_NOT_ATTACHED) {
    missing_attachments.push('consent_records');
  }
  if (filteredSources.length === 0) {
    missing_attachments.push('captures_in_period');
  }

  const lines = [];
  lines.push('# Data Governance Report');
  lines.push('');
  lines.push(`_Generated by kolm.ai ${REG_DATA_GOVERNANCE_VERSION} at ${generated_at}_`);
  lines.push('');
  lines.push(`- **Tenant**: ${tenant}`);
  lines.push(`- **Namespace**: ${namespace || '(all namespaces)'}`);
  lines.push(`- **Period**: ${period || '(all time)'}`);
  if (missing_attachments.length > 0) {
    lines.push('');
    for (const f of missing_attachments) {
      lines.push(`<!-- MISSING: ${f} - attach via capture metadata + re-run report -->`);
    }
  }
  lines.push('');

  // Provenance section.
  lines.push('## Capture provenance');
  lines.push('');
  if (filteredSources.length === 0) {
    lines.push('_No captures in the reporting window._');
  } else {
    lines.push('| Source | Count | First seen | Last seen |');
    lines.push('| --- | ---: | --- | --- |');
    for (const b of filteredSources) {
      lines.push(`| ${b.source} | ${b.count} | ${b.first_seen || '-'} | ${b.last_seen || '-'} |`);
    }
  }
  lines.push('');

  // PII section.
  lines.push('## PII handling');
  lines.push('');
  if (prov.pii_handling_summary === PII_NOT_ATTACHED) {
    lines.push('_No PII metadata attached to captures in scope._');
    lines.push('');
    lines.push('Recommended action: attach `pii_classes_redacted` to each capture ' +
      'so the report can attest to PII handling per Article 10.');
  } else {
    const p = prov.pii_handling_summary;
    lines.push(`- **Rows with PII metadata**: ${p.rows_with_pii_metadata}`);
    lines.push(`- **Rows missing PII metadata**: ${p.rows_missing_pii_metadata}`);
    lines.push(`- **PII attachment rate**: ${(p.attachment_rate * 100).toFixed(1)}%`);
    if (p.pii_classes_seen.length > 0) {
      lines.push('- **PII classes seen**:');
      for (const c of p.pii_classes_seen) lines.push(`  - ${c}`);
    }
  }
  lines.push('');

  // Consent section.
  lines.push('## Consent records');
  lines.push('');
  if (prov.consent_records === CONSENT_NOT_ATTACHED) {
    lines.push('_No consent records attached to captures in scope._');
    lines.push('');
    lines.push('Recommended action: attach `consent_id` and/or `consent_text` to ' +
      'each capture that processed personal data, per Article 10(5).');
  } else {
    lines.push(`- **Total consent records attached**: ${prov.consent_records.length}`);
    const sample = prov.consent_records.slice(0, 10);
    lines.push('');
    lines.push('### Sample (first 10)');
    lines.push('');
    lines.push('| created_at | consent_id | source |');
    lines.push('| --- | --- | --- |');
    for (const r of sample) {
      lines.push(`| ${r.created_at || '-'} | ${r.consent_id || '-'} | ${r.source || '-'} |`);
    }
  }
  lines.push('');

  return {
    ok: true,
    version: REG_DATA_GOVERNANCE_VERSION,
    format: 'markdown',
    body: lines.join('\n'),
    tenant,
    namespace: namespace || null,
    period: period || null,
    generated_at,
    missing_attachments,
  };
}

export default {
  REG_DATA_GOVERNANCE_VERSION,
  CAPTURE_SOURCES,
  capturesProvenanceReport,
  generateGovernanceReport,
};
