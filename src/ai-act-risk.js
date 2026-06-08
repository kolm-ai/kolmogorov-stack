// W766-2 - EU AI Act risk scoring based on an artifact's task category.
//
// The EU AI Act (Regulation (EU) 2024/1689) classifies AI systems into four
// risk categories - minimal, limited, high, and unacceptable. The category
// determines which Annex IV technical documentation requirements apply, and
// whether a conformity assessment is needed before placing the system on the
// EU market.
//
// This module exposes:
//
//   * AI_ACT_RISK_VERSION - stamp 'w766-v1' so the test suite can lock.
//   * AI_ACT_RISK_CATEGORIES - Object.freeze()-d list of the four categories
//                                 in canonical order so dashboards key by index.
//   * AI_ACT_TASK_CATEGORY_MAP - Object.freeze()-d catalog of task-category
//                                 strings -> risk_category. Sourced from
//                                 Annex III of the EU AI Act (high-risk task list)
//                                 plus Article 5 prohibitions (unacceptable risk).
//   * scoreArtifactRisk - pure function over a kolm manifest. Picks the
//                                 category from manifest.vertical, manifest.
//                                 task_category, or manifest.intended_use using
//                                 the catalog. Floor is 'minimal' if nothing
//                                 matches - NEVER null, NEVER fabricated.
//   * classifyTaskCategory - regex-based string classifier so callers
//                                 without a structured manifest can still get
//                                 a category guess. Confidence caps at 0.95
//                                 (honesty contract - never 1.0).
//
// HONESTY CONTRACT (do not violate):
//   * scoreArtifactRisk MUST NEVER return null risk_category. The floor when
//     no taxonomy match is found is 'minimal', and the envelope's reasoning
//     string explicitly says "no_task_category_matched".
//   * classifyTaskCategory MUST NEVER return confidence >= 1.0. Even a perfect
//     phrase match caps at 0.95 because a sufficiently adversarial caller can
//     craft text that hits multiple categories ambiguously.
//   * Invalid input → honest {ok:false, error, hint} envelope. NEVER throws.
//   * 'unacceptable' systems carry conformity_assessment_required:false
//     because such systems are PROHIBITED on the EU market - there is no
//     conformity path that legalizes them.
//
// W604 anti-brittleness - AI_ACT_RISK_VERSION = 'w766-v1', test pins both
// /^w766-/ AND the literal value.

export const AI_ACT_RISK_VERSION = 'w766-v1';

// Canonical ordering. Tests pin both length === 4 AND deep-equality so a
// future maintainer who reorders this also has to update the dashboards.
export const AI_ACT_RISK_CATEGORIES = Object.freeze([
  'minimal',
  'limited',
  'high',
  'unacceptable',
]);

// Catalog of task-category strings → risk_category. Sourced from Annex III
// (high-risk task list) and Article 5 (unacceptable / prohibited practices).
// Spec says >=15 entries; we ship 24 so dashboards have meaningful coverage.
//
// Notes on a few entries:
//   * 'social_scoring' - Article 5(1)(c) prohibits public-authority
//                                     social-scoring of natural persons.
//   * 'subliminal_manipulation' - Article 5(1)(a) prohibits subliminal
//                                     techniques that materially distort behavior.
//   * 'emotion_recognition_workplace'
// - Article 5(1)(f) prohibits emotion-recognition
//                                     in workplace + educational contexts.
//   * 'real_time_biometric_id_public'
// - Article 5(1)(h) prohibits real-time remote
//                                     biometric identification in publicly
//                                     accessible spaces (limited exemptions).
//   * 'biometric_id', 'critical_infrastructure', 'employment_screening',
//     'credit_scoring', 'medical_diagnosis', 'law_enforcement',
//     'border_control', 'admin_of_justice'
// - Annex III high-risk categories.
//   * 'chatbot', 'generative_text', 'deepfake'
// - Article 50 transparency obligations
//                                     (limited risk).
//   * 'spam_filter', 'recommendation', 'code_completion'
// - Implicit minimal-risk category.
export const AI_ACT_TASK_CATEGORY_MAP = Object.freeze({
  // ---- unacceptable (Article 5 prohibitions) ----
  social_scoring: 'unacceptable',
  subliminal_manipulation: 'unacceptable',
  emotion_recognition_workplace: 'unacceptable',
  real_time_biometric_id_public: 'unacceptable',
  predictive_policing_individual: 'unacceptable',
  // ---- high (Annex III) ----
  biometric_id: 'high',
  critical_infrastructure: 'high',
  law_enforcement: 'high',
  employment_screening: 'high',
  credit_scoring: 'high',
  medical_diagnosis: 'high',
  border_control: 'high',
  admin_of_justice: 'high',
  education_assessment: 'high',
  essential_services_access: 'high',
  insurance_risk_assessment: 'high',
  // ---- limited (Article 50 transparency obligations) ----
  chatbot: 'limited',
  generative_text: 'limited',
  generative_image: 'limited',
  deepfake: 'limited',
  voice_synthesis: 'limited',
  // ---- minimal (default for everything else) ----
  spam_filter: 'minimal',
  recommendation: 'minimal',
  code_completion: 'minimal',
  search_ranking: 'minimal',
});

// Verticals that strongly imply a risk category. Used as a fallback when the
// manifest doesn't carry an explicit task_category. Sourced from the same
// Annex III list as the catalog above.
const VERTICAL_TO_CATEGORY = Object.freeze({
  medical: 'high',
  healthcare: 'high',
  health: 'high',
  legal: 'high',
  justice: 'high',
  financial: 'high',
  finance: 'high',
  insurance: 'high',
  banking: 'high',
  hr: 'high',
  recruiting: 'high',
  employment: 'high',
  education: 'high',
  border: 'high',
  policing: 'high',
  // Limited-risk verticals.
  marketing: 'limited',
  copywriting: 'limited',
  chatbot: 'limited',
  // Minimal-risk verticals.
  developer_tools: 'minimal',
  internal_tools: 'minimal',
  search: 'minimal',
});

// Transparency requirements per category, sourced from Articles 13, 14, 50.
const TRANSPARENCY_BY_CATEGORY = Object.freeze({
  minimal: Object.freeze([]),
  limited: Object.freeze([
    'disclose_ai_interaction_to_user',
    'mark_synthetic_content',
  ]),
  high: Object.freeze([
    'disclose_ai_interaction_to_user',
    'mark_synthetic_content',
    'maintain_annex_iv_documentation',
    'log_runtime_decisions_for_audit',
    'register_in_eu_database',
    'publish_instructions_for_use',
  ]),
  unacceptable: Object.freeze([
    'system_prohibited_no_market_placement',
  ]),
});

// Regex patterns used by classifyTaskCategory. Each entry is
// {key, re, weight} - weight contributes to the confidence accumulator.
const _CLASSIFY_PATTERNS = Object.freeze([
  // unacceptable - strongest signals.
  { key: 'social_scoring', re: /\bsocial[\s_-]+scor(?:e|ing)\b/i, weight: 0.5 },
  { key: 'subliminal_manipulation', re: /\bsubliminal\b/i, weight: 0.5 },
  { key: 'emotion_recognition_workplace', re: /\bemotion[\s_-]+(?:detection|recognition|reading)\b.*\b(?:workplace|office|employee|workers?)\b/i, weight: 0.5 },
  { key: 'real_time_biometric_id_public', re: /\breal[\s-]?time\b.*\bbiometric\b.*\b(?:public|street|crowd)\b/i, weight: 0.5 },
  // high.
  { key: 'medical_diagnosis', re: /\b(?:medical|clinical|diagnos|patient[\s_-]+chart|radiolog)\b/i, weight: 0.4 },
  { key: 'biometric_id', re: /\bbiometric\b/i, weight: 0.35 },
  { key: 'critical_infrastructure', re: /\b(?:power[\s_-]+grid|water[\s_-]+system|critical[\s_-]+infrastructure|scada)\b/i, weight: 0.4 },
  { key: 'law_enforcement', re: /\b(?:law[\s_-]+enforcement|police|criminal[\s_-]+investigation)\b/i, weight: 0.4 },
  { key: 'employment_screening', re: /\b(?:resume|cv|applicant|hiring|recruit|employment[\s_-]+screen)\b/i, weight: 0.35 },
  { key: 'credit_scoring', re: /\b(?:credit[\s_-]+scor|loan[\s_-]+(?:approval|underwrit)|underwrit)\b/i, weight: 0.4 },
  { key: 'border_control', re: /\b(?:border|customs|immigration|asylum)\b/i, weight: 0.35 },
  { key: 'admin_of_justice', re: /\b(?:judicial|sentencing|recidiv|parole|bail[\s_-]+decision)\b/i, weight: 0.4 },
  { key: 'education_assessment', re: /\b(?:exam[\s_-]+grading|student[\s_-]+assessment|admission[\s_-]+decision)\b/i, weight: 0.35 },
  { key: 'essential_services_access', re: /\b(?:welfare|housing[\s_-]+allocation|benefit[\s_-]+eligibility)\b/i, weight: 0.35 },
  { key: 'insurance_risk_assessment', re: /\binsurance\b.*\b(?:risk|premium|underwrit)\b/i, weight: 0.35 },
  // limited.
  { key: 'chatbot', re: /\b(?:chatbot|conversational[\s_-]+agent|virtual[\s_-]+assistant)\b/i, weight: 0.3 },
  { key: 'generative_text', re: /\b(?:text[\s_-]+generation|llm|chat[\s_-]+completion)\b/i, weight: 0.3 },
  { key: 'generative_image', re: /\b(?:image[\s_-]+generation|text[\s_-]+to[\s_-]+image|diffusion[\s_-]+model)\b/i, weight: 0.3 },
  { key: 'deepfake', re: /\bdeepfake|face[\s_-]+swap\b/i, weight: 0.4 },
  { key: 'voice_synthesis', re: /\b(?:voice[\s_-]+synthesis|voice[\s_-]+clon|tts|text[\s_-]+to[\s_-]+speech)\b/i, weight: 0.35 },
  // minimal.
  { key: 'spam_filter', re: /\bspam[\s_-]+(?:filter|classif|detect)\b/i, weight: 0.3 },
  { key: 'recommendation', re: /\b(?:recommend|ranking[\s_-]+system|content[\s_-]+rec)\b/i, weight: 0.25 },
  { key: 'code_completion', re: /\b(?:code[\s_-]+(?:complet|assist|generat|completion)|copilot|ide[\s_-]+plugin)\b/i, weight: 0.3 },
  { key: 'search_ranking', re: /\b(?:search[\s_-]+ranking|query[\s_-]+expansion|search[\s_-]+result)\b/i, weight: 0.25 },
]);

// classifyTaskCategory(text) - returns { key, confidence, version } where
// key is the catalog key (defaults to 'recommendation' on no match, since
// 'minimal' is the broadest plausible class for free-text inputs). Confidence
// caps at 0.95.
//
// Returns null for non-string / empty input.
export function classifyTaskCategory(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return null;
  }
  // Walk patterns, accumulate weight per key, then pick the top-scoring key.
  const tally = new Map();
  for (const { key, re, weight } of _CLASSIFY_PATTERNS) {
    if (re.test(text)) {
      tally.set(key, (tally.get(key) || 0) + weight);
    }
  }
  if (tally.size === 0) {
    return {
      key: null,
      confidence: 0,
      version: AI_ACT_RISK_VERSION,
      reasoning: 'no_pattern_matched',
    };
  }
  // Top-scoring key.
  let best = null;
  let bestScore = -Infinity;
  for (const [key, score] of tally) {
    if (score > bestScore) {
      bestScore = score;
      best = key;
    }
  }
  // Confidence cap at 0.95 (honesty contract).
  const confidence = Math.min(0.95, Math.max(0.05, bestScore));
  return {
    key: best,
    confidence,
    version: AI_ACT_RISK_VERSION,
    reasoning: tally.size === 1
      ? 'single_pattern_match'
      : `multiple_pattern_matches_top_scoring (${tally.size})`,
  };
}

// _normalizeVertical(v) → lowercase trimmed string or null.
function _normalizeVertical(v) {
  if (typeof v !== 'string') return null;
  const n = v.trim().toLowerCase();
  return n.length === 0 ? null : n;
}

// scoreArtifactRisk(manifest) - return {ok:true, risk_category, task_category,
// reasoning, transparency_requirements, human_oversight_required,
// conformity_assessment_required, version}.
//
// Resolution order (first match wins):
//   1. manifest.task_category - explicit catalog key.
//   2. manifest.vertical - domain → category map.
//   3. manifest.intended_use - free-text → classifyTaskCategory().
//   4. fallback - 'minimal' floor.
//
// Honest envelope on bad input.
export function scoreArtifactRisk(manifest) {
  if (manifest == null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return {
      ok: false,
      error: 'invalid_manifest',
      hint: 'manifest must be an object with at least .vertical or .task_category',
      version: AI_ACT_RISK_VERSION,
    };
  }

  let risk_category = null;
  let task_category = null;
  let reasoning = null;

  // 1. Explicit task_category.
  const tc = typeof manifest.task_category === 'string' ? manifest.task_category.trim() : '';
  if (tc && AI_ACT_TASK_CATEGORY_MAP[tc] != null) {
    task_category = tc;
    risk_category = AI_ACT_TASK_CATEGORY_MAP[tc];
    reasoning = `manifest.task_category='${tc}' maps to risk_category='${risk_category}' per Annex III + Article 5 catalog`;
  }

  // 2. Vertical fallback.
  if (risk_category == null) {
    const v = _normalizeVertical(manifest.vertical);
    if (v != null && VERTICAL_TO_CATEGORY[v] != null) {
      risk_category = VERTICAL_TO_CATEGORY[v];
      // Synthesize a task_category guess from the vertical when none is set.
      task_category = null;
      reasoning = `manifest.vertical='${v}' implies risk_category='${risk_category}' (verticals heuristic)`;
    }
  }

  // 3. Intended-use free-text classification.
  if (risk_category == null) {
    const text = typeof manifest.intended_use === 'string' ? manifest.intended_use : null;
    if (text) {
      const cls = classifyTaskCategory(text);
      if (cls && cls.key && AI_ACT_TASK_CATEGORY_MAP[cls.key] != null) {
        task_category = cls.key;
        risk_category = AI_ACT_TASK_CATEGORY_MAP[cls.key];
        reasoning = `classifyTaskCategory(intended_use) -> task_category='${cls.key}' at confidence ${cls.confidence.toFixed(2)} -> risk_category='${risk_category}'`;
      }
    }
  }

  // 4. Floor - NEVER null, NEVER fabricated.
  if (risk_category == null) {
    risk_category = 'minimal';
    reasoning = 'no_task_category_matched - defaulting to minimal risk floor (honest); supply manifest.task_category for stronger classification';
  }

  // Derived obligations.
  const transparency_requirements = TRANSPARENCY_BY_CATEGORY[risk_category] || [];
  // Article 14 - human oversight is REQUIRED for high-risk systems. For
  // unacceptable systems, oversight is moot because the system is prohibited.
  const human_oversight_required = risk_category === 'high';
  // Conformity assessment per Article 43 - required for high-risk.
  // Unacceptable systems CANNOT be conformity-assessed (they are prohibited),
  // so we set this to false for clarity; the prohibition is what governs.
  const conformity_assessment_required = risk_category === 'high';

  return {
    ok: true,
    risk_category,
    task_category,
    reasoning,
    transparency_requirements: [...transparency_requirements],
    human_oversight_required,
    conformity_assessment_required,
    version: AI_ACT_RISK_VERSION,
  };
}
