// W834-5 - Extended model card (HF standard + per-language K-Score +
// per-risk-category gate status + teacher attribution).
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md):
//   [W834-5] Auto-generated model cards (HF standard).
//
// W768 already ships the BASE 10-section HF v0.3 model card via
// src/model-card-emit.js. W834-5 EXTENDS that base by adding three regulator-
// facing sub-sections that the base card does not carry:
//
//   * per_language_kscore - wires to W760/W833 cross-lingual K-Score.
//                                 Per-locale calibrated accuracy +
//                                 Wilson 95% CI per locale. Empty when no
//                                 multilingual evaluation has been wired.
//   * per_risk_category_gate_status
// - for each gate in W834-2's REQUIRED_GATES,
//                                 emit {gate, satisfied:bool, evidence}.
//                                 Wires to src/reg-risk-classify.js +
//                                 src/reg-hil.js to attest to gate readiness.
//   * teacher_attribution - explicit attribution to the teacher model
//                                 (HF derivative-model standard requires
//                                 disclosing the base model + its license).
//
// Output is HF model card YAML frontmatter + markdown - the standard format
// HF Hub ingests. We re-export the existing buildModelCard pieces from
// src/model-card-emit.js so callers can opt into the extended fields without
// breaking the W768 surface.
//
// HONESTY CONTRACT (matches W411, W766, W768):
//   * Per-language buckets with fewer than N_PER_LANG_MIN rows report
//     k_score:null + ci:null (W760 Wilson-floor pattern).
//   * Gate status reports {satisfied:false, evidence:'no_evidence_attached'}
//     for any gate where no evidence is attached. NEVER fabricates a
//     satisfied:true claim.
//   * teacher_attribution returns {teacher_model:null, license:null,
//     attribution_required:bool} when the manifest does not declare a teacher
// - and attribution_required is true iff manifest.base_model_was_distilled
//     is truthy (a kolm distilled artifact MUST attribute the teacher).
//
// W604 anti-brittleness: REG_MODEL_CARD_EXTENDED_VERSION = 'w834-v1'. Tests
// lock /^w834-/ regex plus the literal pin.

import {
  MODEL_CARD_VERSION,
  MODEL_CARD_SECTIONS,
  buildModelCard,
  formatAsHuggingFace,
} from './model-card-emit.js';

export const REG_MODEL_CARD_EXTENDED_VERSION = 'w834-v1';

// Minimum rows-per-language for any K-Score estimate. Below this the bucket
// reports null per the W760 Wilson-floor honesty contract.
const N_PER_LANG_MIN = 30;

const HONEST_NOT_DISCLOSED = 'not_yet_disclosed';

// Pull a per-language K-Score map from the manifest. Accepts a few legal
// shapes:
//   manifest.per_language_kscore  = {en:{k_score, n, ci}, es:..., ...}
//   manifest.kscore_per_language  = same shape (W760 sibling)
//   manifest.metrics.per_language_kscore  = nested
// Returns null when none of those exist.
function _pullPerLangKScore(manifest) {
  if (!manifest || typeof manifest !== 'object') return null;
  const candidates = [
    manifest.per_language_kscore,
    manifest.kscore_per_language,
    manifest.metrics && manifest.metrics.per_language_kscore,
    manifest.metrics && manifest.metrics.kscore_per_language,
  ];
  for (const c of candidates) {
    if (c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length > 0) {
      return c;
    }
  }
  return null;
}

// Normalize a per-language K-Score entry into the canonical shape
// {k_score, ci_low, ci_high, n} with the W760 floor applied (k_score:null
// when n < N_PER_LANG_MIN).
function _normalizePerLangEntry(entry) {
  if (entry == null) {
    return { k_score: null, ci_low: null, ci_high: null, n: 0, honest_floor_reason: 'no_data' };
  }
  if (typeof entry === 'number') {
    return { k_score: null, ci_low: null, ci_high: null, n: 0, honest_floor_reason: 'no_sample_size' };
  }
  const n = Number(entry.n) || 0;
  const k = Number(entry.k_score);
  const ciLow = (entry.ci && Number.isFinite(Number(entry.ci.low))) ? Number(entry.ci.low) : Number(entry.ci_low);
  const ciHigh = (entry.ci && Number.isFinite(Number(entry.ci.high))) ? Number(entry.ci.high) : Number(entry.ci_high);
  if (n < N_PER_LANG_MIN) {
    return {
      k_score: null,
      ci_low: null,
      ci_high: null,
      n,
      honest_floor_reason: `n<${N_PER_LANG_MIN}_min_sample_size`,
    };
  }
  return {
    k_score: Number.isFinite(k) ? k : null,
    ci_low: Number.isFinite(ciLow) ? ciLow : null,
    ci_high: Number.isFinite(ciHigh) ? ciHigh : null,
    n,
  };
}

// Build the per-risk-category gate status block. For each gate in
// REQUIRED_GATES we check the manifest for evidence attachments:
//   - 'mandatory_human_review' satisfied when manifest.hil_threshold_set === true
//                              OR manifest.gates_evidence.mandatory_human_review present.
//   - 'accuracy_threshold' satisfied when manifest.k_score >= manifest.kscore_threshold
//                          (default threshold 0.7 when manifest.kscore_threshold missing).
//   - 'documentation' satisfied when manifest.annex_iv_doc_present === true
//                     OR manifest.gates_evidence.documentation present.
//   - 'audit_log' satisfied when manifest.audit_retention_days >= 365.
//   - 'transparency_disclosure' satisfied when manifest.disclosures_attached === true.
//   - 'conformity_assessment' satisfied when manifest.conformity_assessment_complete === true.
//   - 'fundamental_rights_impact_assessment' satisfied when manifest.fria_attached === true.
//   - 'eu_database_registration' satisfied when manifest.eu_db_registration_id is truthy.
function _buildGateStatus(manifest, gatesRequired) {
  const m = manifest && typeof manifest === 'object' ? manifest : {};
  const ev = m.gates_evidence && typeof m.gates_evidence === 'object' ? m.gates_evidence : {};
  const out = [];
  for (const gate of gatesRequired) {
    let satisfied = false;
    let evidence = ev[gate] || null;
    switch (gate) {
      case 'mandatory_human_review':
        satisfied = m.hil_threshold_set === true || (evidence != null);
        break;
      case 'accuracy_threshold': {
        const k = Number(m.k_score)
          || (m.metrics && Number(m.metrics.k_score))
          || (m.performance_metrics && Number(m.performance_metrics.k_score));
        const threshold = Number(m.kscore_threshold) || 0.7;
        satisfied = Number.isFinite(k) && k >= threshold;
        evidence = Number.isFinite(k) ? { k_score: k, threshold } : evidence;
        break;
      }
      case 'documentation':
        satisfied = m.annex_iv_doc_present === true || (evidence != null);
        break;
      case 'audit_log': {
        const days = Number(m.audit_retention_days);
        satisfied = Number.isFinite(days) && days >= 365;
        evidence = Number.isFinite(days) ? { audit_retention_days: days } : evidence;
        break;
      }
      case 'transparency_disclosure':
        satisfied = m.disclosures_attached === true || (evidence != null);
        break;
      case 'conformity_assessment':
        satisfied = m.conformity_assessment_complete === true || (evidence != null);
        break;
      case 'fundamental_rights_impact_assessment':
        satisfied = m.fria_attached === true || (evidence != null);
        break;
      case 'eu_database_registration':
        satisfied = (typeof m.eu_db_registration_id === 'string' && m.eu_db_registration_id.length > 0)
          || (evidence != null);
        evidence = (typeof m.eu_db_registration_id === 'string')
          ? { eu_db_registration_id: m.eu_db_registration_id }
          : evidence;
        break;
      default:
        satisfied = (evidence != null);
        break;
    }
    out.push({
      gate,
      satisfied: !!satisfied,
      evidence: evidence != null ? evidence : 'no_evidence_attached',
    });
  }
  return out;
}

// Build the teacher attribution block. HF distilled-model convention asks
// that derivative models cite the base model + its license verbatim. We
// surface attribution_required:true iff the manifest indicates the artifact
// is a distilled student of a teacher.
function _buildTeacherAttribution(manifest) {
  const m = manifest && typeof manifest === 'object' ? manifest : {};
  const teacher = m.teacher_model || m.base_model || null;
  const teacher_license = m.teacher_license || m.base_model_license || null;
  const teacher_link = m.teacher_link || m.base_model_link || null;
  // A kolm-distilled artifact is the canonical case where attribution is
  // required. The flag also accepts the manifest.distilled_from === true
  // sibling shape.
  const attribution_required = !!(
    m.base_model_was_distilled === true
    || m.distilled_from
    || m.kolm_distilled === true
    || teacher
  );
  if (!teacher) {
    return {
      teacher_model: null,
      license: null,
      link: null,
      attribution_required,
      honest_note: attribution_required
        ? 'attribution required but no teacher_model declared - set manifest.teacher_model'
        : 'no teacher; not a derivative model',
    };
  }
  return {
    teacher_model: teacher,
    license: teacher_license || HONEST_NOT_DISCLOSED,
    link: teacher_link || HONEST_NOT_DISCLOSED,
    attribution_required,
  };
}

// =============================================================================
// PUBLIC: buildExtendedModelCard(manifest, opts)
//
// Build a base HF v0.3 model card via the W768 emitter, then attach the
// three regulator-facing sub-sections:
//   * per_language_kscore
//   * per_risk_category_gate_status
//   * teacher_attribution
//
// opts:
//   gates_required[] - REQUIRED to gate the per_risk_category block;
//                         pass classifyArtifactRisk(...).gates_required from
//                         W834-2.
//   format - 'json' (default) | 'huggingface'
//   include_environmental - passed through to buildModelCard.
//
// Returns:
//   { ok:true, version, base_version, generated_at, format, card,
//     extensions: { per_language_kscore, per_risk_category_gate_status,
//                   teacher_attribution } }
//   or { ok:false, error, hint, version } on bad input.
// =============================================================================
export function buildExtendedModelCard(manifest, opts = {}) {
  const o = opts || {};
  const format = o.format === 'huggingface' ? 'huggingface' : 'json';
  if (manifest == null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return {
      ok: false,
      error: 'manifest_required',
      hint: 'pass the kolm artifact manifest.json contents as the first arg',
      version: REG_MODEL_CARD_EXTENDED_VERSION,
    };
  }

  // Base card via W768 emitter - always JSON internally so we can append
  // the extensions before final-formatting.
  const base = buildModelCard(manifest, {
    format: 'json',
    include_environmental: o.include_environmental === true,
  });
  if (!base.ok) {
    return {
      ok: false,
      error: 'base_model_card_failed',
      detail: base.error || 'unknown',
      base,
      version: REG_MODEL_CARD_EXTENDED_VERSION,
    };
  }

  // Per-language K-Score block.
  const perLangRaw = _pullPerLangKScore(manifest);
  const per_language_kscore = perLangRaw
    ? Object.fromEntries(
        Object.entries(perLangRaw).map(([lang, entry]) => [lang, _normalizePerLangEntry(entry)]),
      )
    : HONEST_NOT_DISCLOSED;

  // Per-risk-category gate status block.
  const gatesRequired = Array.isArray(o.gates_required) ? o.gates_required : [];
  const per_risk_category_gate_status = gatesRequired.length > 0
    ? _buildGateStatus(manifest, gatesRequired)
    : HONEST_NOT_DISCLOSED;

  // Teacher attribution block.
  const teacher_attribution = _buildTeacherAttribution(manifest);

  const generated_at = new Date().toISOString();
  const card = {
    ...base.card,
    per_language_kscore,
    per_risk_category_gate_status,
    teacher_attribution,
  };

  const envelope = {
    ok: true,
    version: REG_MODEL_CARD_EXTENDED_VERSION,
    base_version: MODEL_CARD_VERSION,
    generated_at,
    format,
    card,
    extensions: {
      per_language_kscore,
      per_risk_category_gate_status,
      teacher_attribution,
    },
  };

  if (format === 'huggingface') {
    // Format the base HF YAML+markdown, then append the three extension
    // blocks as markdown sub-sections. HF's parser ignores unknown headers
    // gracefully.
    const baseHf = formatAsHuggingFace(base.card);
    const ext = [];
    ext.push('');
    ext.push('## Per-Language K-Score');
    ext.push('');
    if (per_language_kscore === HONEST_NOT_DISCLOSED) {
      ext.push('_not_yet_disclosed_');
    } else {
      ext.push('| Language | K-Score | n | 95% CI |');
      ext.push('| --- | --- | --- | --- |');
      for (const [lang, v] of Object.entries(per_language_kscore)) {
        const k = v.k_score == null ? 'null' : v.k_score.toFixed(3);
        const ci = (v.ci_low == null || v.ci_high == null)
          ? '-'
          : `[${v.ci_low.toFixed(3)}, ${v.ci_high.toFixed(3)}]`;
        ext.push(`| ${lang} | ${k} | ${v.n} | ${ci} |`);
      }
    }
    ext.push('');
    ext.push('## Per-Risk-Category Gate Status');
    ext.push('');
    if (per_risk_category_gate_status === HONEST_NOT_DISCLOSED) {
      ext.push('_not_yet_disclosed_');
    } else {
      ext.push('| Gate | Satisfied | Evidence |');
      ext.push('| --- | --- | --- |');
      for (const g of per_risk_category_gate_status) {
        const evidenceStr = (typeof g.evidence === 'object' && g.evidence !== null)
          ? JSON.stringify(g.evidence)
          : String(g.evidence);
        ext.push(`| ${g.gate} | ${g.satisfied} | ${evidenceStr} |`);
      }
    }
    ext.push('');
    ext.push('## Teacher Attribution');
    ext.push('');
    ext.push(`- **Teacher model**: ${teacher_attribution.teacher_model || 'null'}`);
    ext.push(`- **License**: ${teacher_attribution.license || 'null'}`);
    ext.push(`- **Link**: ${teacher_attribution.link || 'null'}`);
    ext.push(`- **Attribution required**: ${teacher_attribution.attribution_required}`);
    envelope.huggingface = baseHf + ext.join('\n');
  }

  return envelope;
}

export default {
  REG_MODEL_CARD_EXTENDED_VERSION,
  MODEL_CARD_SECTIONS,
  buildExtendedModelCard,
};
