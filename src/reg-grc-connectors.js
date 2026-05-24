// W834-6 — GRC export connectors (OneTrust, ServiceNow, IBM OpenPages).
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md):
//   [W834-6] GRC export connectors: OneTrust, ServiceNow, IBM OpenPages.
//
// W768 ships the field-name MAPPING (src/model-card-schema.js holds
// GOVERNANCE_PLATFORM_MAPPINGS); W834-6 ships the EXPORT ACTION — given a
// model-card / governance-report blob and a vendor, return the vendor-
// shaped JSON payload PLUS the honest creds-check.
//
// HONESTY CONTRACT (matches W411, W768):
//   * If KOLM_GRC_<VENDOR>_API_KEY env var is missing → return
//     {ok:false, error:'no_grc_creds', install_hint, export_payload}.
//     We STILL compute and return export_payload so the operator can
//     manually upload via the vendor UI. NEVER drop the payload silently.
//   * When creds ARE present we DO NOT actually call the vendor API in
//     this module — that's a downstream job (the deploy pipeline owns
//     credential rotation). We just emit {ok:true, ready_to_post:true,
//     export_payload}. The caller decides whether to post or to log.
//   * NEVER fabricates field values. Missing fields in the report land in
//     the payload as null.
//   * The three vendor shapes are concrete + auditable. Each carries a
//     vendor-specific top-level wrapper key + a flat field-name map.
//
// Vendor shape sources (W768-3 verified):
//   * OneTrust AI Inventory:
//       https://my.onetrust.com/articles/en_US/Knowledge/Ai-Inventory-(Pro)
//       Top-level: { aiInventory: { modelMetadata, purposeOfProcessing, ... } }
//   * ServiceNow AI Governance:
//       https://docs.servicenow.com/bundle/washingtondc-ai-governance/
//       Top-level: { sn_aigov_inventory: { ...table_columns } } + {
//                   sn_aigov_risk: { ...table_columns } }
//   * IBM OpenPages with Watson (Model Risk Governance):
//       https://www.ibm.com/docs/en/openpages-with-watson
//       Top-level: { OPModel: { ModelOverview, IntendedUse, ... } }
//
// W604 anti-brittleness: REG_GRC_CONNECTORS_VERSION = 'w834-v1'. Tests lock
// /^w834-/ regex plus the literal pin.

export const REG_GRC_CONNECTORS_VERSION = 'w834-v1';

// Vendor enumeration. Frozen — adding a vendor requires bumping the version
// stamp + adding env-var + shape table entries below.
export const SUPPORTED_VENDORS = Object.freeze([
  'onetrust',
  'servicenow',
  'ibm_openpages',
]);

// Per-vendor env var holding the API key. We DO NOT inline the values
// anywhere; this table is the SINGLE source of truth so a credential rotation
// only needs to touch this map + the env config.
export const VENDOR_ENV_VARS = Object.freeze({
  onetrust: 'KOLM_GRC_ONETRUST_API_KEY',
  servicenow: 'KOLM_GRC_SERVICENOW_API_KEY',
  ibm_openpages: 'KOLM_GRC_IBM_OPENPAGES_API_KEY',
});

// Per-vendor wrapper key + field-name aliases. Sourced from W768-3
// GOVERNANCE_PLATFORM_MAPPINGS (kept in sync; if the W768 mappings file
// changes, this table MUST update too).
const VENDOR_SHAPE = Object.freeze({
  onetrust: Object.freeze({
    wrapper: 'aiInventory',
    fields: Object.freeze({
      model_metadata: 'modelMetadata',
      intended_use: 'purposeOfProcessing',
      factors: 'modelFactors',
      metrics: 'modelPerformance',
      evaluation_data: 'evaluationDatasets',
      training_data: 'trainingDatasets',
      quantitative_analyses: 'quantitativeAnalyses',
      ethical_considerations: 'ethicalRiskAssessment',
      caveats_and_recommendations: 'modelLimitations',
      environmental_impact: 'environmentalImpact',
      per_language_kscore: 'perLanguageKScore',
      per_risk_category_gate_status: 'gateStatus',
      teacher_attribution: 'teacherAttribution',
      // Governance-report fields:
      capture_provenance: 'captureProvenance',
      pii_handling_summary: 'piiHandlingSummary',
      consent_records: 'consentRecords',
      annex_iv: 'annexIv',
    }),
  }),
  servicenow: Object.freeze({
    wrapper: 'sn_aigov',
    fields: Object.freeze({
      model_metadata: 'sn_aigov_inventory.model_metadata',
      intended_use: 'sn_aigov_inventory.intended_use',
      factors: 'sn_aigov_inventory.relevant_factors',
      metrics: 'sn_aigov_inventory.performance_metrics',
      evaluation_data: 'sn_aigov_inventory.evaluation_data',
      training_data: 'sn_aigov_inventory.training_data',
      quantitative_analyses: 'sn_aigov_inventory.quantitative_analyses',
      ethical_considerations: 'sn_aigov_risk.ethical_considerations',
      caveats_and_recommendations: 'sn_aigov_risk.model_limitations',
      environmental_impact: 'sn_aigov_inventory.environmental_impact',
      per_language_kscore: 'sn_aigov_inventory.per_language_kscore',
      per_risk_category_gate_status: 'sn_aigov_risk.gate_status',
      teacher_attribution: 'sn_aigov_inventory.teacher_attribution',
      capture_provenance: 'sn_aigov_data.capture_provenance',
      pii_handling_summary: 'sn_aigov_data.pii_handling_summary',
      consent_records: 'sn_aigov_data.consent_records',
      annex_iv: 'sn_aigov_inventory.annex_iv',
    }),
  }),
  ibm_openpages: Object.freeze({
    wrapper: 'OPModel',
    fields: Object.freeze({
      model_metadata: 'ModelOverview',
      intended_use: 'IntendedUse',
      factors: 'ModelFactors',
      metrics: 'PerformanceMetrics',
      evaluation_data: 'EvaluationData',
      training_data: 'TrainingData',
      quantitative_analyses: 'QuantitativeAnalyses',
      ethical_considerations: 'EthicalConsiderations',
      caveats_and_recommendations: 'CaveatsAndRecommendations',
      environmental_impact: 'EnvironmentalImpact',
      per_language_kscore: 'PerLanguageKScore',
      per_risk_category_gate_status: 'GateStatus',
      teacher_attribution: 'TeacherAttribution',
      capture_provenance: 'CaptureProvenance',
      pii_handling_summary: 'PiiHandlingSummary',
      consent_records: 'ConsentRecords',
      annex_iv: 'AnnexIv',
    }),
  }),
});

// Pull a candidate field value from the input report. Reports come in two
// shapes today: model-card-style ({card:{...}, extensions:{...}}) or
// data-governance-style ({sources, pii_handling_summary, ...}). We map BOTH
// canonical kolm-side keys + nested aliases.
function _pullReportField(report, key) {
  if (!report || typeof report !== 'object') return null;
  // Try top-level first.
  if (key in report) return report[key];
  // Nested under .card (model-card envelope).
  if (report.card && typeof report.card === 'object' && key in report.card) {
    return report.card[key];
  }
  // Nested under .extensions (extended model-card envelope).
  if (report.extensions && typeof report.extensions === 'object' && key in report.extensions) {
    return report.extensions[key];
  }
  // Alias for the model-card model_details section.
  if (key === 'model_metadata' && report.card && report.card.model_details) {
    return report.card.model_details;
  }
  if (key === 'model_metadata' && report.model_details) {
    return report.model_details;
  }
  // Alias for the data-governance .sources field.
  if (key === 'capture_provenance' && report.sources) {
    return report.sources;
  }
  // Annex IV alias for W834-1 envelope.
  if (key === 'annex_iv' && report.body && report.format) {
    return report.body;
  }
  return null;
}

// Build the vendor-shaped payload from a report blob. Returns the wrapper
// object {<vendor_wrapper>: {...fields...}} per vendor convention.
function _buildVendorPayload(vendor, report) {
  const shape = VENDOR_SHAPE[vendor];
  if (!shape) return null;
  const flatFields = {};
  for (const [kolmKey, vendorField] of Object.entries(shape.fields)) {
    const v = _pullReportField(report, kolmKey);
    if (v != null) {
      // ServiceNow uses dotted paths; respect them.
      if (vendor === 'servicenow' && vendorField.includes('.')) {
        const [table, col] = vendorField.split('.');
        flatFields[table] = flatFields[table] || {};
        flatFields[table][col] = v;
      } else {
        flatFields[vendorField] = v;
      }
    }
  }
  // ServiceNow returns multiple table wrappers under the shape.wrapper key.
  if (vendor === 'servicenow') {
    return flatFields; // already keyed by table name
  }
  return { [shape.wrapper]: flatFields };
}

// Read the per-vendor API key from env. Returns null when missing.
function _readApiKey(vendor) {
  const envVar = VENDOR_ENV_VARS[vendor];
  if (!envVar) return null;
  const v = process.env[envVar];
  return (typeof v === 'string' && v.length > 0) ? v : null;
}

// Build the per-vendor install hint string. Says which env var to set.
function _installHint(vendor) {
  return `Set ${VENDOR_ENV_VARS[vendor]}=<api_key> to enable direct vendor posting; meanwhile the export_payload field carries the full vendor-shaped JSON for manual upload.`;
}

// =============================================================================
// PUBLIC: exportToOneTrust(report)
//
// Returns:
//   { ok:true, vendor:'onetrust', version, ready_to_post:true, export_payload }
// when KOLM_GRC_ONETRUST_API_KEY is set, OR
//   { ok:false, vendor:'onetrust', version, error:'no_grc_creds',
//     install_hint, export_payload }
// when the env var is missing. The payload is computed + returned EITHER WAY.
// =============================================================================
export function exportToOneTrust(report) {
  return _exportVendor('onetrust', report);
}

// =============================================================================
// PUBLIC: exportToServiceNow(report)
//
// Same contract as exportToOneTrust; payload is ServiceNow-shaped.
// =============================================================================
export function exportToServiceNow(report) {
  return _exportVendor('servicenow', report);
}

// =============================================================================
// PUBLIC: exportToIBMOpenPages(report)
//
// Same contract as exportToOneTrust; payload is IBM-OpenPages-shaped.
// =============================================================================
export function exportToIBMOpenPages(report) {
  return _exportVendor('ibm_openpages', report);
}

// Shared export plumbing.
function _exportVendor(vendor, report) {
  if (!SUPPORTED_VENDORS.includes(vendor)) {
    return {
      ok: false,
      error: 'unknown_vendor',
      hint: 'supported: ' + SUPPORTED_VENDORS.join(', '),
      supported: SUPPORTED_VENDORS,
      version: REG_GRC_CONNECTORS_VERSION,
    };
  }
  if (report == null || typeof report !== 'object' || Array.isArray(report)) {
    return {
      ok: false,
      vendor,
      error: 'report_required',
      hint: 'pass the kolm report blob (model-card or governance-report envelope) as the first arg',
      version: REG_GRC_CONNECTORS_VERSION,
    };
  }
  const export_payload = _buildVendorPayload(vendor, report);
  const apiKey = _readApiKey(vendor);
  if (!apiKey) {
    return {
      ok: false,
      vendor,
      error: 'no_grc_creds',
      install_hint: _installHint(vendor),
      export_payload,
      version: REG_GRC_CONNECTORS_VERSION,
    };
  }
  return {
    ok: true,
    vendor,
    ready_to_post: true,
    export_payload,
    version: REG_GRC_CONNECTORS_VERSION,
  };
}

// =============================================================================
// PUBLIC: exportByVendor(report, vendor) — generic dispatch.
//
// Lets callers pass the vendor as a string instead of picking one of the
// three exported functions above. Mirrors the W768-3
// mapCardToGovernancePlatform contract.
// =============================================================================
export function exportByVendor(report, vendor) {
  if (typeof vendor !== 'string') {
    return {
      ok: false,
      error: 'vendor_required',
      hint: 'pass vendor:"onetrust" | "servicenow" | "ibm_openpages"',
      supported: SUPPORTED_VENDORS,
      version: REG_GRC_CONNECTORS_VERSION,
    };
  }
  switch (vendor) {
    case 'onetrust': return exportToOneTrust(report);
    case 'servicenow': return exportToServiceNow(report);
    case 'ibm_openpages': return exportToIBMOpenPages(report);
    default:
      return {
        ok: false,
        error: 'unknown_vendor',
        hint: 'supported: ' + SUPPORTED_VENDORS.join(', '),
        supported: SUPPORTED_VENDORS,
        version: REG_GRC_CONNECTORS_VERSION,
      };
  }
}

export default {
  REG_GRC_CONNECTORS_VERSION,
  SUPPORTED_VENDORS,
  VENDOR_ENV_VARS,
  exportToOneTrust,
  exportToServiceNow,
  exportToIBMOpenPages,
  exportByVendor,
};
