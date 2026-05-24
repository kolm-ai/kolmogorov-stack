// W834-1 — EU AI Act Annex IV technical-documentation auto-generator.
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 1202-1209):
//   [W834-1] EU AI Act technical-docs auto-generator from artifact manifest.
//
// This is the regulator-submission-ready cousin of src/ai-act-export.js. W766
// gave us the JSON-envelope `buildTechnicalDocumentation` for programmatic
// consumption; W834-1 emits a SUBMISSION-FORMATTED markdown (or HTML) blob
// that an EU compliance team can paste directly into a regulatory dossier.
//
// Why a separate module from ai-act-export.js:
//   * ai-act-export.js targets the API consumer — its envelope nests Annex IV
//     fields under .annex_iv for programmatic walking.
//   * reg-eu-aiact-docs.js targets the human auditor — emits free-flowing
//     markdown with section headings every regulatory reviewer expects, and
//     calls out MISSING fields with structured action hints.
//   * Distinct version stamp ('w834-v1') so downstream tooling that locks on
//     /^w766-/ continues to work AND new tooling that wants the formatted
//     submission can lock on /^w834-/.
//
// HONESTY CONTRACT (matches W766, W768):
//   * Fields missing from the manifest emit
//       `<!-- MISSING: <field> — <recommended action> -->`
//     so a reviewer reading the rendered output can grep for "MISSING" and
//     immediately see every gap with a recommended remediation.
//   * NEVER fabricates training-data sources, accuracy numbers, or
//     conformity claims.
//   * Output is byte-stable across runs given the same manifest input
//     (no Date.now() unless caller passes opts.generated_at).
//
// W604 anti-brittleness: REG_EU_AIACT_DOCS_VERSION = 'w834-v1'. Tests lock on
// /^w834-/ regex plus the literal pin.

export const REG_EU_AIACT_DOCS_VERSION = 'w834-v1';

// Canonical Annex IV section order per Regulation (EU) 2024/1689 Annex IV.
// The spec carves it into six top-level groups; we keep them in the order the
// regulation lists so a reviewer skimming the doc finds each section where
// they expect it. NEVER reorder without bumping the version stamp.
export const ANNEX_IV_SECTIONS = Object.freeze([
  'general_description',
  'data_and_data_governance',
  'monitoring_and_control',
  'risk_management',
  'standards_applied',
  'conformity_assessment_plan',
]);

// Output formats. 'markdown' is the default for paste-into-Word workflows;
// 'html' is for compliance teams that want to drop the block into a
// browser-rendered regulator portal.
export const SUPPORTED_FORMATS = Object.freeze(['markdown', 'html']);

// Per-field recommended-action hints. Keyed by the manifest field name we
// looked for. The reviewer sees a literal action string after the MISSING
// marker so they know what to do to close the gap.
const RECOMMENDED_ACTIONS = Object.freeze({
  name: 'set manifest.name or manifest.model_name to the system\'s commercial name',
  version: 'set manifest.version or use the artifact_hash as the canonical version stamp',
  developed_by: 'set manifest.developed_by to the legal entity name (matches EU declaration of conformity)',
  intended_purpose: 'set manifest.intended_purpose to a 1-2 paragraph description of the deployment context',
  vertical: 'set manifest.vertical to the industry vertical (medical, financial, hr, ...)',
  hardware_targets: 'set manifest.hardware_targets to the deployment-target enumeration (e.g. ["rtx-5090","h100"])',
  training_data_sources: 'set manifest.training_data_sources to the data-source enumeration (e.g. [{source:"customer_captures",n:50000},{source:"public_corpus",name:"...",license:"..."}])',
  k_score: 'set manifest.k_score (or manifest.metrics.k_score) — empty K-Score forfeits the EU performance-metric declaration',
  redaction_classes_used: 'set manifest.redaction_classes_used to the list of PII redactors that ran on training data',
  human_oversight_measures: 'set manifest.human_oversight_measures or call POST /v1/reg/hil/threshold to declare review thresholds',
  postmarket_monitoring_plan: 'set manifest.postmarket_monitoring_plan or attach a Confluence/Notion link describing alert + recall procedures',
  cybersecurity_measures: 'set manifest.cybersecurity_measures — describe encryption at rest, key rotation, attestation hardware',
  standards_applied: 'set manifest.standards_applied to the standards enumeration (e.g. ["ISO/IEC 27001:2022","ISO/IEC 42001:2023","NIST AI RMF 1.0"])',
  conformity_assessment_plan: 'set manifest.conformity_assessment_plan — for high-risk systems describe Article 43 third-party audit cadence',
});

function _now() {
  return new Date().toISOString();
}

// Format a MISSING marker. We use HTML comment syntax so the marker is
// invisible in rendered markdown/HTML but greppable in the source — a
// reviewer can `grep "<!-- MISSING"` to enumerate every gap.
function _missing(field) {
  const action = RECOMMENDED_ACTIONS[field] || `set manifest.${field}`;
  return `<!-- MISSING: ${field} — ${action} -->`;
}

// Pull a field from a manifest with optional alias list. Returns null if
// the field (and every alias) is missing or empty. We DELIBERATELY treat the
// empty string + empty array as missing — a regulator submission should not
// carry blank fields that look like attestation.
function _pull(manifest, field, aliases = []) {
  const keys = [field, ...aliases];
  for (const k of keys) {
    const v = manifest && manifest[k];
    if (v == null) continue;
    if (typeof v === 'string' && v.trim().length === 0) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    return v;
  }
  return null;
}

// Render a value as a markdown body. Strings render verbatim; arrays render
// as bullet lists; objects render as a sub-section with bullet sub-items.
function _renderValue(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    return v.map((item) => {
      if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
        return `- ${item}`;
      }
      return `- ${JSON.stringify(item)}`;
    }).join('\n');
  }
  if (v && typeof v === 'object') {
    const lines = [];
    for (const [k, val] of Object.entries(v)) {
      const label = k.replace(/_/g, ' ');
      if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
        lines.push(`- **${label}**: ${val}`);
      } else {
        lines.push(`- **${label}**: ${JSON.stringify(val)}`);
      }
    }
    return lines.join('\n');
  }
  return String(v);
}

// =============================================================================
// PUBLIC: generateTechnicalDocs({artifact_manifest, tenant_metadata, format, generated_at})
//
// Build the regulator-submission-ready Annex IV doc.
//
// Inputs:
//   artifact_manifest  — the kolm artifact manifest.json contents
//   tenant_metadata    — optional {legal_name, dpo_contact, eu_representative}
//                        — provides legal-entity boilerplate for the cover
//   opts.format        — 'markdown' (default) | 'html'
//   opts.generated_at  — ISO timestamp; defaults to now() (override for tests)
//
// Returns:
//   { ok:true, version, format, generated_at, body, missing_fields[] }
//   or { ok:false, error, hint, version } on bad input.
// =============================================================================
export function generateTechnicalDocs(opts = {}) {
  const o = opts || {};
  const format = o.format === 'html' ? 'html' : 'markdown';
  if (!SUPPORTED_FORMATS.includes(format)) {
    return {
      ok: false,
      error: 'unsupported_format',
      hint: 'format must be one of ' + JSON.stringify(SUPPORTED_FORMATS),
      version: REG_EU_AIACT_DOCS_VERSION,
    };
  }
  const manifest = o.artifact_manifest;
  if (manifest == null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return {
      ok: false,
      error: 'artifact_manifest_required',
      hint: 'pass {artifact_manifest: {...kolm artifact manifest.json contents...}}',
      version: REG_EU_AIACT_DOCS_VERSION,
    };
  }
  const tenant = (o.tenant_metadata && typeof o.tenant_metadata === 'object') ? o.tenant_metadata : {};
  const generated_at = typeof o.generated_at === 'string' && o.generated_at
    ? o.generated_at
    : _now();

  const missing = [];
  const sections = {};

  // -----------------------------------------------------------------------
  // 1) General description of the system
  // -----------------------------------------------------------------------
  {
    const name = _pull(manifest, 'name', ['model_name']);
    const version = _pull(manifest, 'version', ['spec_hash', 'artifact_hash']);
    const developed_by = _pull(manifest, 'developed_by',
      ['owner', 'tenant_id']) || tenant.legal_name;
    const intended_purpose = _pull(manifest, 'intended_purpose',
      ['intended_use', 'purpose']);
    const vertical = _pull(manifest, 'vertical');
    const hardware_targets = _pull(manifest, 'hardware_targets',
      ['deployment_targets']);
    const teacher_model = _pull(manifest, 'teacher_model', ['base_model']);

    const lines = ['### General description of the AI system'];
    lines.push('');
    lines.push(name ? `- **Commercial name**: ${name}` : `- **Commercial name**: ${_missing('name')}`);
    lines.push(version ? `- **Version**: ${version}` : `- **Version**: ${_missing('version')}`);
    lines.push(developed_by ? `- **Provider (legal entity)**: ${developed_by}` : `- **Provider (legal entity)**: ${_missing('developed_by')}`);
    if (tenant.eu_representative) lines.push(`- **EU representative**: ${tenant.eu_representative}`);
    if (tenant.dpo_contact) lines.push(`- **Data Protection Officer**: ${tenant.dpo_contact}`);
    lines.push(intended_purpose ? `- **Intended purpose**: ${intended_purpose}` : `- **Intended purpose**: ${_missing('intended_purpose')}`);
    lines.push(vertical ? `- **Vertical / domain**: ${vertical}` : `- **Vertical / domain**: ${_missing('vertical')}`);
    if (teacher_model) lines.push(`- **Underlying base / teacher model**: ${teacher_model}`);
    if (hardware_targets) {
      lines.push('- **Deployment hardware targets**:');
      lines.push(_renderValue(hardware_targets));
    } else {
      lines.push(`- **Deployment hardware targets**: ${_missing('hardware_targets')}`);
    }
    if (!name) missing.push('name');
    if (!version) missing.push('version');
    if (!developed_by) missing.push('developed_by');
    if (!intended_purpose) missing.push('intended_purpose');
    if (!vertical) missing.push('vertical');
    if (!hardware_targets) missing.push('hardware_targets');
    sections.general_description = lines.join('\n');
  }

  // -----------------------------------------------------------------------
  // 2) Detailed information on data + data governance
  // -----------------------------------------------------------------------
  {
    const training_data_sources = _pull(manifest, 'training_data_sources',
      ['training_data', 'dataset', 'captures_summary']);
    const redaction_classes_used = _pull(manifest, 'redaction_classes_used',
      ['pii_classes_redacted']);
    const consent_records = _pull(manifest, 'consent_records');
    const data_provenance = _pull(manifest, 'data_provenance');

    const lines = ['### Data and data governance'];
    lines.push('');
    if (training_data_sources) {
      lines.push('- **Training data sources**:');
      lines.push(_renderValue(training_data_sources));
    } else {
      lines.push(`- **Training data sources**: ${_missing('training_data_sources')}`);
      missing.push('training_data_sources');
    }
    if (redaction_classes_used) {
      lines.push('- **PII redaction classes applied**:');
      lines.push(_renderValue(redaction_classes_used));
    } else {
      lines.push(`- **PII redaction classes applied**: ${_missing('redaction_classes_used')}`);
      missing.push('redaction_classes_used');
    }
    if (consent_records) {
      lines.push('- **Consent records**:');
      lines.push(_renderValue(consent_records));
    }
    if (data_provenance) {
      lines.push('- **Data provenance**:');
      lines.push(_renderValue(data_provenance));
    }
    sections.data_and_data_governance = lines.join('\n');
  }

  // -----------------------------------------------------------------------
  // 3) Detailed description of monitoring + control mechanisms
  // -----------------------------------------------------------------------
  {
    const human_oversight = _pull(manifest, 'human_oversight_measures',
      ['human_in_the_loop']);
    const monitoring = _pull(manifest, 'postmarket_monitoring_plan',
      ['monitoring_plan']);
    const k_score = _pull(manifest, 'k_score') ??
      (manifest.metrics && manifest.metrics.k_score) ??
      (manifest.performance_metrics && manifest.performance_metrics.k_score);

    const lines = ['### Monitoring and control mechanisms'];
    lines.push('');
    if (human_oversight) {
      lines.push('- **Human oversight measures**:');
      lines.push(_renderValue(human_oversight));
    } else {
      lines.push(`- **Human oversight measures**: ${_missing('human_oversight_measures')}`);
      missing.push('human_oversight_measures');
    }
    if (monitoring) {
      lines.push('- **Post-market monitoring plan**:');
      lines.push(_renderValue(monitoring));
    } else {
      lines.push(`- **Post-market monitoring plan**: ${_missing('postmarket_monitoring_plan')}`);
      missing.push('postmarket_monitoring_plan');
    }
    if (k_score != null) {
      lines.push(`- **K-Score (calibrated accuracy metric)**: ${k_score}`);
    } else {
      lines.push(`- **K-Score**: ${_missing('k_score')}`);
      missing.push('k_score');
    }
    sections.monitoring_and_control = lines.join('\n');
  }

  // -----------------------------------------------------------------------
  // 4) Risk management system summary
  // -----------------------------------------------------------------------
  {
    const risk_management = _pull(manifest, 'risk_management',
      ['risk_assessment']);
    const known_risks = _pull(manifest, 'known_risks',
      ['risks_and_harms']);

    const lines = ['### Risk management system'];
    lines.push('');
    if (risk_management) {
      lines.push('- **Risk management summary**:');
      lines.push(_renderValue(risk_management));
    } else {
      lines.push('- **Risk management summary**: see EU AI Act Article 9. ' +
        'kolm.ai recommends running POST /v1/reg/classify-risk against this ' +
        'manifest with the deployment\'s intended_use to populate the ' +
        'risk-tier basis.');
    }
    if (known_risks) {
      lines.push('- **Identified risks and mitigations**:');
      lines.push(_renderValue(known_risks));
    }
    sections.risk_management = lines.join('\n');
  }

  // -----------------------------------------------------------------------
  // 5) Standards applied
  // -----------------------------------------------------------------------
  {
    const standards = _pull(manifest, 'standards_applied',
      ['conformity_standards']);
    const lines = ['### Standards applied'];
    lines.push('');
    if (standards) {
      lines.push('- **Standards referenced for conformity**:');
      lines.push(_renderValue(standards));
    } else {
      lines.push(`- **Standards referenced for conformity**: ${_missing('standards_applied')}`);
      lines.push('- Suggested baseline: ISO/IEC 42001:2023 (AI Management), ' +
        'ISO/IEC 27001:2022 (Information Security), NIST AI RMF 1.0.');
      missing.push('standards_applied');
    }
    sections.standards_applied = lines.join('\n');
  }

  // -----------------------------------------------------------------------
  // 6) Conformity assessment plan
  // -----------------------------------------------------------------------
  {
    const plan = _pull(manifest, 'conformity_assessment_plan',
      ['conformity_plan']);
    const lines = ['### Conformity assessment plan'];
    lines.push('');
    if (plan) {
      lines.push('- **Conformity assessment plan**:');
      lines.push(_renderValue(plan));
    } else {
      lines.push(`- **Conformity assessment plan**: ${_missing('conformity_assessment_plan')}`);
      lines.push('- For high-risk systems (Annex III), Article 43 requires a ' +
        'third-party conformity assessment by a notified body before market ' +
        'placement. For limited-risk systems, only transparency obligations ' +
        '(Article 50) apply.');
      missing.push('conformity_assessment_plan');
    }
    sections.conformity_assessment_plan = lines.join('\n');
  }

  // Assemble the full doc.
  const lines = [];
  lines.push('# EU AI Act — Annex IV Technical Documentation');
  lines.push('');
  lines.push(`_Generated by kolm.ai ${REG_EU_AIACT_DOCS_VERSION} at ${generated_at}_`);
  lines.push('');
  lines.push('This document is structured per Regulation (EU) 2024/1689 Annex IV.');
  lines.push('Sections marked with HTML comments `<!-- MISSING: ... -->` indicate ' +
    'manifest fields that were not supplied; the recommended action follows the ' +
    'field name.');
  lines.push('');
  for (const section of ANNEX_IV_SECTIONS) {
    lines.push(sections[section]);
    lines.push('');
  }

  let body = lines.join('\n');
  if (format === 'html') {
    body = _markdownToHtml(body);
  }

  return {
    ok: true,
    version: REG_EU_AIACT_DOCS_VERSION,
    format,
    generated_at,
    body,
    missing_fields: missing,
    sections_present: ANNEX_IV_SECTIONS.slice(),
  };
}

// _markdownToHtml(md) — minimal markdown -> HTML renderer suitable for the
// regulator-portal paste workflow. We DO NOT pull in a full markdown parser
// (would add a runtime dep); this handler covers the small subset our
// emitter produces: headings, bullets, bold spans, and HTML comments
// (which pass through verbatim — they MUST stay greppable).
function _markdownToHtml(md) {
  const lines = md.split('\n');
  const out = ['<!DOCTYPE html>', '<html><head><meta charset="utf-8">',
    '<title>EU AI Act — Annex IV Technical Documentation</title>',
    '</head><body>'];
  let inList = false;
  for (const line of lines) {
    if (/^# /.test(line)) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<h1>${_escapeHtml(line.replace(/^# /, ''))}</h1>`);
    } else if (/^## /.test(line)) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<h2>${_escapeHtml(line.replace(/^## /, ''))}</h2>`);
    } else if (/^### /.test(line)) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<h3>${_escapeHtml(line.replace(/^### /, ''))}</h3>`);
    } else if (/^- /.test(line)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${_inlineMd(line.replace(/^- /, ''))}</li>`);
    } else if (/^<!-- /.test(line)) {
      // Pass HTML comments through verbatim — MISSING markers MUST stay
      // greppable in the rendered output too.
      out.push(line);
    } else if (line.trim() === '') {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push('');
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push(`<p>${_inlineMd(line)}</p>`);
    }
  }
  if (inList) out.push('</ul>');
  out.push('</body></html>');
  return out.join('\n');
}

function _escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _inlineMd(s) {
  // Pass through HTML comments (MISSING markers) verbatim.
  if (/<!--/.test(s)) return s;
  return _escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

export default {
  REG_EU_AIACT_DOCS_VERSION,
  ANNEX_IV_SECTIONS,
  SUPPORTED_FORMATS,
  generateTechnicalDocs,
};
