// W834-2 — Risk classification per task category (EU AI Act Annex III).
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md):
//   [W834-2] Risk classification per task category
//            (high-risk/limited-risk/minimal-risk).
//
// Why a separate module from src/ai-act-risk.js (W766):
//   * ai-act-risk.js gives the BROAD four-tier classification (minimal,
//     limited, high, unacceptable) based on the artifact's task_category
//     catalog key OR vertical OR intended_use free-text.
//   * reg-risk-classify.js targets the GATING-DECISION use case: given an
//     INTENDED-USE label (`medical_dx`, `credit_scoring`, ...), return the
//     concrete operational gates the system must satisfy before deployment.
//     The Annex III enumeration drives the basis citations + the
//     gates_required list that downstream policy engines walk.
//
// The two modules cite the same regulation but answer different questions:
//   - W766: "what risk tier IS this artifact?" (descriptive)
//   - W834-2: "what gates MUST FIRE before this artifact may be deployed
//             for this intended use?" (operational)
//
// HONESTY CONTRACT (matches W411, W766, W768):
//   * tier MUST be one of {prohibited, high_risk, limited_risk, minimal_risk}.
//     NEVER null. NEVER fabricated.
//   * basis MUST cite the EU AI Act article(s) the tier derives from. Empty
//     basis on an explicit catalog key is a contract violation — the test
//     suite locks on basis.length >= 1 for every Annex III enumerator.
//   * gates_required is the canonical list of operational gates. Each gate
//     name is a stable string that downstream code (e.g. src/reg-hil.js,
//     src/audit-export.js) checks against verbatim — adding a new gate
//     requires bumping the version stamp.
//   * Unknown intended_use → tier='minimal_risk' floor with explicit
//     reasoning string `no_intended_use_match`. NEVER throws.
//
// W604 anti-brittleness: REG_RISK_CLASSIFY_VERSION = 'w834-v1'. Tests lock
// /^w834-/ regex plus the literal pin.

export const REG_RISK_CLASSIFY_VERSION = 'w834-v1';

// Canonical four-tier ordering. Frozen so a refactor cannot quietly add a
// new tier without bumping the version stamp.
export const RISK_TIERS = Object.freeze([
  'minimal_risk',
  'limited_risk',
  'high_risk',
  'prohibited',
]);

// Canonical gate enumeration. Each gate name is checked verbatim against
// downstream subsystems:
//   - 'mandatory_human_review'  → src/reg-hil.js threshold gate
//   - 'accuracy_threshold'      → src/kscore.js minimum K-Score gate
//   - 'documentation'           → src/reg-eu-aiact-docs.js Annex IV blob
//   - 'audit_log'               → src/audit-export.js retention gate
//   - 'transparency_disclosure' → /v1/whoami transparency obligations
//   - 'conformity_assessment'   → Article 43 third-party audit (high-risk only)
//   - 'fundamental_rights_impact_assessment'
//                               → Article 27 FRIA (high-risk deployment)
//   - 'eu_database_registration'→ Article 71 EU database registration
// Frozen — adding a new gate requires bumping REG_RISK_CLASSIFY_VERSION.
export const REQUIRED_GATES = Object.freeze([
  'mandatory_human_review',
  'accuracy_threshold',
  'documentation',
  'audit_log',
  'transparency_disclosure',
  'conformity_assessment',
  'fundamental_rights_impact_assessment',
  'eu_database_registration',
]);

// INTENDED_USE_CATALOG maps a deployment-side intended-use label to:
//   { tier, basis[], gates_required[] }
//
// Sourced from:
//   - Article 5         — prohibited practices (social_scoring,
//                         biometric_identify_realtime_public, ...)
//   - Annex III §1-§8   — high-risk enumeration (biometric ID,
//                         critical infra, education, employment, essential
//                         services, law enforcement, migration & border,
//                         administration of justice)
//   - Article 50        — limited-risk transparency obligations
//                         (chatbot, deepfake, generative content)
//   - implicit minimal  — everything else with no Annex III hit
//
// The catalog uses snake_case keys matching the W766 task-category map so
// callers can pass either label vocabulary and get a coherent answer.
export const INTENDED_USE_CATALOG = Object.freeze({
  // ---- prohibited (Article 5) ----
  social_scoring: Object.freeze({
    tier: 'prohibited',
    basis: Object.freeze(['EU_AIACT_Article_5_1_c']),
    gates_required: Object.freeze([]), // prohibited systems have no path to deployment
  }),
  subliminal_manipulation: Object.freeze({
    tier: 'prohibited',
    basis: Object.freeze(['EU_AIACT_Article_5_1_a']),
    gates_required: Object.freeze([]),
  }),
  emotion_recognition_workplace: Object.freeze({
    tier: 'prohibited',
    basis: Object.freeze(['EU_AIACT_Article_5_1_f']),
    gates_required: Object.freeze([]),
  }),
  real_time_biometric_id_public: Object.freeze({
    tier: 'prohibited',
    basis: Object.freeze(['EU_AIACT_Article_5_1_h']),
    gates_required: Object.freeze([]),
  }),
  predictive_policing_individual: Object.freeze({
    tier: 'prohibited',
    basis: Object.freeze(['EU_AIACT_Article_5_1_d']),
    gates_required: Object.freeze([]),
  }),
  // ---- high_risk (Annex III enumeration) ----
  biometric_identify: Object.freeze({
    tier: 'high_risk',
    basis: Object.freeze(['EU_AIACT_Annex_III_1']),
    gates_required: Object.freeze([
      'mandatory_human_review',
      'accuracy_threshold',
      'documentation',
      'audit_log',
      'conformity_assessment',
      'fundamental_rights_impact_assessment',
      'eu_database_registration',
    ]),
  }),
  critical_infrastructure: Object.freeze({
    tier: 'high_risk',
    basis: Object.freeze(['EU_AIACT_Annex_III_2', 'EU_AIACT_Article_6_2']),
    gates_required: Object.freeze([
      'mandatory_human_review',
      'accuracy_threshold',
      'documentation',
      'audit_log',
      'conformity_assessment',
      'eu_database_registration',
    ]),
  }),
  medical_dx: Object.freeze({
    tier: 'high_risk',
    basis: Object.freeze(['EU_AIACT_Annex_III_5_a', 'EU_AIACT_Article_6_2']),
    gates_required: Object.freeze([
      'mandatory_human_review',
      'accuracy_threshold',
      'documentation',
      'audit_log',
      'conformity_assessment',
      'fundamental_rights_impact_assessment',
      'eu_database_registration',
    ]),
  }),
  medical_diagnosis: Object.freeze({
    tier: 'high_risk',
    basis: Object.freeze(['EU_AIACT_Annex_III_5_a', 'EU_AIACT_Article_6_2']),
    gates_required: Object.freeze([
      'mandatory_human_review',
      'accuracy_threshold',
      'documentation',
      'audit_log',
      'conformity_assessment',
      'fundamental_rights_impact_assessment',
      'eu_database_registration',
    ]),
  }),
  credit_scoring: Object.freeze({
    tier: 'high_risk',
    basis: Object.freeze(['EU_AIACT_Annex_III_5_b', 'EU_AIACT_Article_6_2']),
    gates_required: Object.freeze([
      'mandatory_human_review',
      'accuracy_threshold',
      'documentation',
      'audit_log',
      'conformity_assessment',
      'fundamental_rights_impact_assessment',
    ]),
  }),
  hiring: Object.freeze({
    tier: 'high_risk',
    basis: Object.freeze(['EU_AIACT_Annex_III_4_a']),
    gates_required: Object.freeze([
      'mandatory_human_review',
      'accuracy_threshold',
      'documentation',
      'audit_log',
      'conformity_assessment',
      'fundamental_rights_impact_assessment',
    ]),
  }),
  employment_screening: Object.freeze({
    tier: 'high_risk',
    basis: Object.freeze(['EU_AIACT_Annex_III_4_a']),
    gates_required: Object.freeze([
      'mandatory_human_review',
      'accuracy_threshold',
      'documentation',
      'audit_log',
      'conformity_assessment',
      'fundamental_rights_impact_assessment',
    ]),
  }),
  education_assessment: Object.freeze({
    tier: 'high_risk',
    basis: Object.freeze(['EU_AIACT_Annex_III_3_a']),
    gates_required: Object.freeze([
      'mandatory_human_review',
      'accuracy_threshold',
      'documentation',
      'audit_log',
      'conformity_assessment',
    ]),
  }),
  law_enforcement: Object.freeze({
    tier: 'high_risk',
    basis: Object.freeze(['EU_AIACT_Annex_III_6']),
    gates_required: Object.freeze([
      'mandatory_human_review',
      'accuracy_threshold',
      'documentation',
      'audit_log',
      'conformity_assessment',
      'fundamental_rights_impact_assessment',
      'eu_database_registration',
    ]),
  }),
  border_control: Object.freeze({
    tier: 'high_risk',
    basis: Object.freeze(['EU_AIACT_Annex_III_7']),
    gates_required: Object.freeze([
      'mandatory_human_review',
      'accuracy_threshold',
      'documentation',
      'audit_log',
      'conformity_assessment',
      'eu_database_registration',
    ]),
  }),
  admin_of_justice: Object.freeze({
    tier: 'high_risk',
    basis: Object.freeze(['EU_AIACT_Annex_III_8']),
    gates_required: Object.freeze([
      'mandatory_human_review',
      'accuracy_threshold',
      'documentation',
      'audit_log',
      'conformity_assessment',
      'fundamental_rights_impact_assessment',
    ]),
  }),
  essential_services_access: Object.freeze({
    tier: 'high_risk',
    basis: Object.freeze(['EU_AIACT_Annex_III_5_a']),
    gates_required: Object.freeze([
      'mandatory_human_review',
      'accuracy_threshold',
      'documentation',
      'audit_log',
      'conformity_assessment',
    ]),
  }),
  insurance_risk_assessment: Object.freeze({
    tier: 'high_risk',
    basis: Object.freeze(['EU_AIACT_Annex_III_5_c']),
    gates_required: Object.freeze([
      'mandatory_human_review',
      'accuracy_threshold',
      'documentation',
      'audit_log',
      'conformity_assessment',
    ]),
  }),
  // ---- limited_risk (Article 50 transparency obligations) ----
  general_chat: Object.freeze({
    tier: 'limited_risk',
    basis: Object.freeze(['EU_AIACT_Article_50_1']),
    gates_required: Object.freeze([
      'transparency_disclosure',
      'documentation',
    ]),
  }),
  chatbot: Object.freeze({
    tier: 'limited_risk',
    basis: Object.freeze(['EU_AIACT_Article_50_1']),
    gates_required: Object.freeze([
      'transparency_disclosure',
      'documentation',
    ]),
  }),
  generative_text: Object.freeze({
    tier: 'limited_risk',
    basis: Object.freeze(['EU_AIACT_Article_50_2']),
    gates_required: Object.freeze([
      'transparency_disclosure',
      'documentation',
    ]),
  }),
  generative_image: Object.freeze({
    tier: 'limited_risk',
    basis: Object.freeze(['EU_AIACT_Article_50_2']),
    gates_required: Object.freeze([
      'transparency_disclosure',
      'documentation',
    ]),
  }),
  deepfake: Object.freeze({
    tier: 'limited_risk',
    basis: Object.freeze(['EU_AIACT_Article_50_4']),
    gates_required: Object.freeze([
      'transparency_disclosure',
      'documentation',
    ]),
  }),
  voice_synthesis: Object.freeze({
    tier: 'limited_risk',
    basis: Object.freeze(['EU_AIACT_Article_50_2']),
    gates_required: Object.freeze([
      'transparency_disclosure',
      'documentation',
    ]),
  }),
  // ---- minimal_risk (implicit; no Annex III hit) ----
  code_assist: Object.freeze({
    tier: 'minimal_risk',
    basis: Object.freeze(['EU_AIACT_Recital_27']),
    gates_required: Object.freeze([
      'documentation',
    ]),
  }),
  code_completion: Object.freeze({
    tier: 'minimal_risk',
    basis: Object.freeze(['EU_AIACT_Recital_27']),
    gates_required: Object.freeze([
      'documentation',
    ]),
  }),
  spam_filter: Object.freeze({
    tier: 'minimal_risk',
    basis: Object.freeze(['EU_AIACT_Recital_27']),
    gates_required: Object.freeze([
      'documentation',
    ]),
  }),
  recommendation: Object.freeze({
    tier: 'minimal_risk',
    basis: Object.freeze(['EU_AIACT_Recital_27']),
    gates_required: Object.freeze([
      'documentation',
    ]),
  }),
  search_ranking: Object.freeze({
    tier: 'minimal_risk',
    basis: Object.freeze(['EU_AIACT_Recital_27']),
    gates_required: Object.freeze([
      'documentation',
    ]),
  }),
});

// =============================================================================
// PUBLIC: classifyArtifactRisk({manifest, intended_use})
//
// Operational gate-decision classifier. Given the deployment's INTENDED USE
// label, return the tier, regulatory basis, and required gates that must
// fire before deployment.
//
// Inputs:
//   manifest      — kolm artifact manifest.json contents (used for hints + reasoning)
//   intended_use  — REQUIRED enumeration key (see INTENDED_USE_CATALOG)
//
// Returns:
//   { ok:true, tier, basis[], gates_required[], reasoning, version, intended_use, manifest_hint }
//   or { ok:false, error, hint, version } on bad input.
// =============================================================================
export function classifyArtifactRisk(opts = {}) {
  const o = opts || {};
  const intended_use = typeof o.intended_use === 'string' ? o.intended_use.trim() : '';
  if (!intended_use) {
    return {
      ok: false,
      error: 'intended_use_required',
      hint: 'pass {intended_use: "medical_dx" | "credit_scoring" | "hiring" | "social_scoring" | "biometric_identify" | "general_chat" | "code_assist" | ...} — see INTENDED_USE_CATALOG for the full enumeration',
      supported: Object.keys(INTENDED_USE_CATALOG),
      version: REG_RISK_CLASSIFY_VERSION,
    };
  }
  const manifest = (o.manifest && typeof o.manifest === 'object' && !Array.isArray(o.manifest))
    ? o.manifest
    : {};

  const entry = INTENDED_USE_CATALOG[intended_use];
  if (entry) {
    return {
      ok: true,
      tier: entry.tier,
      basis: [...entry.basis],
      gates_required: [...entry.gates_required],
      reasoning: `intended_use='${intended_use}' maps to tier='${entry.tier}' per ${entry.basis.join(', ')}`,
      intended_use,
      manifest_hint: manifest.vertical || manifest.task_category || null,
      version: REG_RISK_CLASSIFY_VERSION,
    };
  }

  // Fallback — unknown intended_use. Floor to minimal_risk with explicit
  // reasoning so a reviewer can see the assignment is a FLOOR, not an
  // attestation. Documentation gate still applies so the artifact still
  // carries an Annex IV blob.
  return {
    ok: true,
    tier: 'minimal_risk',
    basis: ['EU_AIACT_Recital_27'],
    gates_required: ['documentation'],
    reasoning: `no_intended_use_match for '${intended_use}' — defaulted to minimal_risk floor (honest); supply an INTENDED_USE_CATALOG key for stronger classification`,
    intended_use,
    manifest_hint: manifest.vertical || manifest.task_category || null,
    version: REG_RISK_CLASSIFY_VERSION,
  };
}

export default {
  REG_RISK_CLASSIFY_VERSION,
  RISK_TIERS,
  REQUIRED_GATES,
  INTENDED_USE_CATALOG,
  classifyArtifactRisk,
};
