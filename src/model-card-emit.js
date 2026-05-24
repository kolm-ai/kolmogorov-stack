// W768 - Model Card auto-generation (Hugging Face Model Card v0.3 standard).
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 603-607):
//   [W768-1] Auto-generate model cards (per Hugging Face standard) for every .kolm
//   [W768-2] Intended use, limitations, training data summary, eval results,
//            ethical considerations, environmental impact
//   [W768-3] Embeddable in OneTrust / ServiceNow AI Governance / IBM OpenPages
//
// Why: a .kolm artifact is a frozen artifact; an auditor or a compliance team
// downstream needs a structured description of WHAT the model is, what it was
// trained on, what its known limitations are, and what it must NOT be used for.
// The HF Model Card v0.3 schema is the de facto standard format for that
// description; OneTrust / ServiceNow AI Governance / IBM OpenPages all consume
// some variant of it. W768 generates a fresh, honest card on demand from the
// .kolm manifest.
//
// HONESTY CONTRACT (matches W411, W763, W760):
//   - We NEVER fabricate metric values, intended-use text, training-data
//     summaries, or evaluation results.
//   - When the source manifest lacks a field we emit the literal sentinel
//     'not_yet_disclosed' so downstream tooling and auditors can see the
//     gap immediately (vs an empty string that might be mistaken for blank
//     measured content).
//   - Environmental-impact estimation is stamped 'static_grid_average_w768_v1'
//     + 'estimate_not_measured' so a static estimate is never mistaken for
//     a measured datacenter bill.
//
// W604 ANTI-BRITTLENESS: version stamp matches /^w768-/. Sibling tests use
// the regex+threshold family pattern (never an explicit hard-coded array).

import fs from 'node:fs';

export const MODEL_CARD_VERSION = 'w768-v1';

// HF Model Card v0.3 canonical section order. NEVER reorder without bumping
// the version stamp - byte-stability matters for downstream tools that diff
// sequential card emissions and for W460 byte-stable manifest fields.
export const MODEL_CARD_SECTIONS = Object.freeze([
  'model_details',
  'intended_use',
  'factors',
  'metrics',
  'evaluation_data',
  'training_data',
  'quantitative_analyses',
  'ethical_considerations',
  'caveats_and_recommendations',
  'environmental_impact',
]);

export const MODEL_CARD_FORMATS = Object.freeze(['json', 'markdown', 'huggingface']);

// IEA 2024 World Energy Outlook global grid average. Exposed as a named
// constant so a downstream auditor can grep for the exact source value.
const GLOBAL_GRID_CO2_KG_PER_KWH = 0.475;

// Coarse GPU-class TDP in kilowatts (sustained training load, single-card
// draw). Rounded for honest estimation - we are NOT claiming sub-watt fidelity.
const GPU_CLASS_KW = Object.freeze({
  'a100': 0.400,
  'h100': 0.700,
  'h200': 0.700,
  'b200': 1.000,
  'rtx-5090': 0.575,
  'rtx-4090': 0.450,
  'l40s': 0.350,
  'mi300x': 0.750,
  'tpu-v5p': 0.450,
});

// The honest sentinel for every field the manifest does not provide. We NEVER
// substitute an empty string or list - an auditor must be able to grep for
// 'not_yet_disclosed' and see every gap in the card.
const HONEST_NOT_DISCLOSED = 'not_yet_disclosed';

// =============================================================================
// Internal helpers
// =============================================================================

function _get(obj, ...keys) {
  let cur = obj;
  for (const k of keys) {
    if (!cur || typeof cur !== 'object') return null;
    if (!(k in cur)) return null;
    cur = cur[k];
  }
  return cur == null ? null : cur;
}

function _strOrDisclose(v) {
  if (typeof v === 'string' && v.trim().length > 0) return v;
  return HONEST_NOT_DISCLOSED;
}

function _listOrDisclose(v) {
  if (Array.isArray(v) && v.length > 0) return v;
  return HONEST_NOT_DISCLOSED;
}

function _gpuClassKw(gpuClass) {
  if (typeof gpuClass !== 'string') return null;
  const norm = gpuClass.trim().toLowerCase().replace(/_/g, '-');
  return GPU_CLASS_KW[norm] || null;
}

// =============================================================================
// PUBLIC: estimateEnvironmentalImpact(manifest)
//
// Returns the W768 environmental_impact section. Honest envelope when
// inputs are missing. Methodology stamp 'static_grid_average_w768_v1' is
// REQUIRED in every output so downstream tooling cannot mistake the
// estimate for measurement.
// =============================================================================
export function estimateEnvironmentalImpact(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    return {
      compute_hours: HONEST_NOT_DISCLOSED,
      gpu_class: HONEST_NOT_DISCLOSED,
      estimated_co2_kg: HONEST_NOT_DISCLOSED,
      methodology: 'static_grid_average_w768_v1',
      honest_caveat: 'estimate_not_measured',
      reason: 'no_manifest',
    };
  }
  const computeHours = _get(manifest, 'compute_hours')
    || _get(manifest, 'training', 'compute_hours');
  const gpuClass = _get(manifest, 'gpu_class')
    || _get(manifest, 'training', 'gpu_class');

  if (typeof computeHours !== 'number' || !(computeHours > 0)) {
    return {
      compute_hours: HONEST_NOT_DISCLOSED,
      gpu_class: typeof gpuClass === 'string' ? gpuClass : HONEST_NOT_DISCLOSED,
      estimated_co2_kg: HONEST_NOT_DISCLOSED,
      methodology: 'static_grid_average_w768_v1',
      honest_caveat: 'estimate_not_measured',
      reason: 'missing_compute_hours',
    };
  }
  const kw = _gpuClassKw(gpuClass);
  if (kw == null) {
    return {
      compute_hours: computeHours,
      gpu_class: typeof gpuClass === 'string' ? gpuClass : HONEST_NOT_DISCLOSED,
      estimated_co2_kg: HONEST_NOT_DISCLOSED,
      methodology: 'static_grid_average_w768_v1',
      honest_caveat: 'estimate_not_measured',
      reason: 'unknown_gpu_class',
      known_gpu_classes: Object.keys(GPU_CLASS_KW),
    };
  }
  const co2_kg = Math.round(computeHours * kw * GLOBAL_GRID_CO2_KG_PER_KWH * 10000) / 10000;
  return {
    compute_hours: computeHours,
    gpu_class: gpuClass,
    gpu_class_kw: kw,
    grid_co2_kg_per_kwh: GLOBAL_GRID_CO2_KG_PER_KWH,
    estimated_co2_kg: co2_kg,
    methodology: 'static_grid_average_w768_v1',
    honest_caveat: 'estimate_not_measured',
  };
}

// =============================================================================
// PUBLIC: buildModelCard(manifest, opts)
//
// Build the full 10-section HF v0.3 card. Returns
//   { ok: true, version, generated_at, format, card: { ...10 sections... } }
//
// HONESTY CONTRACT: every field the manifest does not supply emits
// HONEST_NOT_DISCLOSED. NO fabrication.
//
// opts:
//   include_environmental  -- bool, default false. When true, environmental_impact
//                             is computed from manifest.compute_hours +
//                             manifest.gpu_class via estimateEnvironmentalImpact.
//   format                 -- 'json' (default) | 'markdown' | 'huggingface'
//   storeMod               -- DI hook for tests (unused today; reserved so test
//                             rigs can inject a stub data store without rewiring).
// =============================================================================
export function buildModelCard(manifest, opts) {
  const o = opts || {};
  const format = o.format || 'json';
  if (!MODEL_CARD_FORMATS.includes(format)) {
    return {
      ok: false,
      error: 'unsupported_format',
      hint: 'format must be one of ' + JSON.stringify(MODEL_CARD_FORMATS),
      version: MODEL_CARD_VERSION,
    };
  }
  const m = manifest && typeof manifest === 'object' ? manifest : {};

  // 1. model_details
  const model_details = {
    name: _strOrDisclose(m.name || m.model_name),
    version: _strOrDisclose(m.version || m.spec_hash || m.artifact_hash),
    developed_by: _strOrDisclose(_get(m, 'developed_by') || _get(m, 'owner') || _get(m, 'tenant_id')),
    model_type: _strOrDisclose(_get(m, 'model_type') || _get(m, 'task')),
    license: _strOrDisclose(_get(m, 'license')),
    base_model: _strOrDisclose(_get(m, 'base_model') || _get(m, 'teacher_model')),
    framework: _strOrDisclose(_get(m, 'framework')),
    languages: _listOrDisclose(_get(m, 'languages')),
  };

  // 2. intended_use
  const intended_use = {
    primary_uses: _strOrDisclose(_get(m, 'intended_use', 'primary_uses')),
    primary_users: _strOrDisclose(_get(m, 'intended_use', 'primary_users')),
    out_of_scope_uses: _listOrDisclose(_get(m, 'intended_use', 'out_of_scope_uses')),
  };

  // 3. factors
  const factors = {
    relevant_factors: _listOrDisclose(_get(m, 'factors', 'relevant')),
    evaluation_factors: _listOrDisclose(_get(m, 'factors', 'evaluation')),
  };

  // 4. metrics
  const rawMetrics = _get(m, 'metrics') || _get(m, 'eval_metrics');
  const metrics = {
    performance_measures: _listOrDisclose(_get(m, 'metrics', 'performance_measures')),
    decision_thresholds: _strOrDisclose(_get(m, 'metrics', 'decision_thresholds')),
    variation_approaches: _strOrDisclose(_get(m, 'metrics', 'variation_approaches')),
    values: (rawMetrics && typeof rawMetrics === 'object' && !Array.isArray(rawMetrics))
      ? rawMetrics : HONEST_NOT_DISCLOSED,
  };

  // 5. evaluation_data
  const evaluation_data = {
    datasets: _listOrDisclose(_get(m, 'evaluation_data', 'datasets')),
    motivation: _strOrDisclose(_get(m, 'evaluation_data', 'motivation')),
    preprocessing: _strOrDisclose(_get(m, 'evaluation_data', 'preprocessing')),
  };

  // 6. training_data
  const training_data = {
    datasets: _listOrDisclose(
      _get(m, 'training_data', 'datasets') || _get(m, 'training', 'datasets'),
    ),
    size: _strOrDisclose(
      _get(m, 'training_data', 'size') || _get(m, 'training', 'size'),
    ),
    preprocessing: _strOrDisclose(
      _get(m, 'training_data', 'preprocessing') || _get(m, 'training', 'preprocessing'),
    ),
    capture_count: (
      _get(m, 'training_data', 'capture_count')
        || _get(m, 'training', 'capture_count')
        || HONEST_NOT_DISCLOSED
    ),
  };

  // 7. quantitative_analyses
  const quantitative_analyses = {
    unitary_results: _get(m, 'quantitative_analyses', 'unitary_results') || HONEST_NOT_DISCLOSED,
    intersectional_results: _get(m, 'quantitative_analyses', 'intersectional_results')
      || HONEST_NOT_DISCLOSED,
  };

  // 8. ethical_considerations
  const ethical_considerations = {
    sensitive_data: _strOrDisclose(_get(m, 'ethical_considerations', 'sensitive_data')),
    human_life: _strOrDisclose(_get(m, 'ethical_considerations', 'human_life')),
    mitigations: _listOrDisclose(_get(m, 'ethical_considerations', 'mitigations')),
    risks_and_harms: _listOrDisclose(_get(m, 'ethical_considerations', 'risks_and_harms')),
    use_cases: _listOrDisclose(_get(m, 'ethical_considerations', 'use_cases')),
  };

  // 9. caveats_and_recommendations
  const caveats_and_recommendations = {
    caveats: _listOrDisclose(_get(m, 'caveats_and_recommendations', 'caveats')),
    recommendations: _listOrDisclose(_get(m, 'caveats_and_recommendations', 'recommendations')),
  };

  // 10. environmental_impact
  const environmental_impact = o.include_environmental
    ? estimateEnvironmentalImpact(m)
    : {
        compute_hours: HONEST_NOT_DISCLOSED,
        gpu_class: HONEST_NOT_DISCLOSED,
        estimated_co2_kg: HONEST_NOT_DISCLOSED,
        methodology: 'static_grid_average_w768_v1',
        honest_caveat: 'estimate_not_measured',
        reason: 'environmental_estimate_not_requested',
      };

  const card = {
    model_details,
    intended_use,
    factors,
    metrics,
    evaluation_data,
    training_data,
    quantitative_analyses,
    ethical_considerations,
    caveats_and_recommendations,
    environmental_impact,
  };

  const generated_at = new Date().toISOString();
  const envelope = {
    ok: true,
    version: MODEL_CARD_VERSION,
    format,
    generated_at,
    card,
  };
  if (format === 'markdown') {
    envelope.markdown = formatAsMarkdown(card);
  } else if (format === 'huggingface') {
    envelope.huggingface = formatAsHuggingFace(card);
  }
  return envelope;
}

// =============================================================================
// PUBLIC: buildModelCardFromManifestPath(path, opts)
//
// Convenience wrapper that reads + parses the manifest from disk, then
// delegates to buildModelCard. Honest envelope on any read/parse failure.
// =============================================================================
export function buildModelCardFromManifestPath(manifestPath, opts) {
  if (typeof manifestPath !== 'string' || !manifestPath) {
    return {
      ok: false,
      error: 'manifest_path_required',
      hint: 'pass an absolute path to a kolm manifest.json',
      version: MODEL_CARD_VERSION,
    };
  }
  let raw;
  try { raw = fs.readFileSync(manifestPath, 'utf8'); }
  catch (e) {
    return {
      ok: false,
      error: 'manifest_read_failed',
      detail: e && e.message,
      version: MODEL_CARD_VERSION,
    };
  }
  let manifest;
  try { manifest = JSON.parse(raw); }
  catch (e) {
    return {
      ok: false,
      error: 'manifest_parse_failed',
      detail: e && e.message,
      version: MODEL_CARD_VERSION,
    };
  }
  return buildModelCard(manifest, opts);
}

// =============================================================================
// PUBLIC: formatAsMarkdown(card)
//
// Pure JS renderer. Returns a string starting with "# Model Card".
// =============================================================================
function _humanLabel(key) {
  return key.replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function _renderValue(value, depth) {
  const indent = '  '.repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${indent}- ${HONEST_NOT_DISCLOSED}`;
    return value.map((v) => `${indent}- ${typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n');
  }
  if (value && typeof value === 'object') {
    const lines = [];
    for (const [k, v] of Object.entries(value)) {
      const label = _humanLabel(k);
      if (Array.isArray(v) || (v && typeof v === 'object')) {
        lines.push(`${indent}- **${label}:**`);
        lines.push(_renderValue(v, depth + 1));
      } else {
        lines.push(`${indent}- **${label}:** ${v}`);
      }
    }
    return lines.join('\n');
  }
  return `${indent}${value}`;
}

export function formatAsMarkdown(card) {
  const c = (card && typeof card === 'object') ? card : {};
  const out = [
    '# Model Card',
    '',
    `_Generated by kolm.ai ${MODEL_CARD_VERSION} - Hugging Face Model Card v0.3 standard._`,
    '',
  ];
  for (const section of MODEL_CARD_SECTIONS) {
    const title = _humanLabel(section);
    const body = c[section];
    out.push(`## ${title}`);
    out.push('');
    if (body === undefined || body === null) {
      out.push(HONEST_NOT_DISCLOSED);
    } else {
      out.push(_renderValue(body, 0));
    }
    out.push('');
  }
  return out.join('\n');
}

// =============================================================================
// PUBLIC: formatAsHuggingFace(card)
//
// Wraps formatAsMarkdown with a YAML frontmatter block consumable by the
// Hugging Face Hub. License falls back to 'other' (HF-canonical) when the
// manifest omits it; we DO NOT invent a permissive license sentinel.
// =============================================================================
export function formatAsHuggingFace(card) {
  const c = (card && typeof card === 'object') ? card : {};
  const md = c.model_details || {};
  const lines = ['---'];
  const languages = md.languages;
  if (Array.isArray(languages) && languages.length > 0) {
    lines.push('language:');
    for (const lang of languages) lines.push(`  - ${lang}`);
  }
  const lic = md.license;
  lines.push(`license: ${(typeof lic === 'string' && lic !== HONEST_NOT_DISCLOSED) ? lic : 'other'}`);
  const baseModel = md.base_model;
  if (typeof baseModel === 'string' && baseModel !== HONEST_NOT_DISCLOSED) {
    lines.push(`base_model: ${baseModel}`);
  }
  lines.push('tags:');
  lines.push('  - kolm');
  lines.push('  - distilled');
  lines.push(`  - ${MODEL_CARD_VERSION}`);
  const name = md.name;
  if (typeof name === 'string' && name !== HONEST_NOT_DISCLOSED) {
    lines.push('model-index:');
    lines.push(`  - name: ${name}`);
  }
  lines.push('---');
  lines.push('');
  return lines.join('\n') + formatAsMarkdown(card);
}

// Default export for the rare consumer that wants the whole module by name.
export default {
  MODEL_CARD_VERSION,
  MODEL_CARD_SECTIONS,
  MODEL_CARD_FORMATS,
  buildModelCard,
  buildModelCardFromManifestPath,
  estimateEnvironmentalImpact,
  formatAsMarkdown,
  formatAsHuggingFace,
};
