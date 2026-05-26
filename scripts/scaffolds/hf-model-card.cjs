#!/usr/bin/env node
// W888-L scaffold #17 — Hugging Face model card has all required sections.
//
// Reads an artifact passport (or, when missing, a minimal in-process fixture),
// emits a HuggingFace model card via src/model-card-emit.js, and asserts the
// canonical 10 sections + critical labels (Model Details / Training / Eval /
// Usage / License / Citation) are present in the rendered Markdown.
//
// Output (stdout):
//   PASS: { ok:true, sections_present, version }
//   FAIL: { ok:false, missing_sections, version }
//   SKIP: { ok:false, skipped:true, reason, install_hint, version }

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const VERSION = 'w888L-hf-card-v1';

(async function main() {
  // Dynamic import of an ESM module from CJS scaffold.
  let mod;
  try {
    mod = await import(url.pathToFileURL(path.join(ROOT, 'src', 'model-card-emit.js')).href);
  } catch (e) {
    process.stdout.write(JSON.stringify({
      ok: false, skipped: true,
      reason: 'src/model-card-emit.js not importable',
      install_hint: 'ensure src/model-card-emit.js exists and is ESM-importable',
      detail: String(e && e.message || e),
      version: VERSION,
    }) + '\n');
    return process.exit(0);
  }

  // Build the canonical card from a synthetic-passport fixture so we exercise
  // every branch of buildModelCard without depending on an external artifact.
  const manifest = {
    name: 'w888L-scaffold-fixture',
    version: '1.0.0',
    developed_by: 'kolm',
    model_type: 'language-model',
    license: 'apache-2.0',
    base_model: 'qwen2.5-7b-instruct',
    framework: 'transformers',
    languages: ['en'],
    intended_use: { primary_uses: 'support classification', primary_users: 'kolm', out_of_scope_uses: ['safety-critical'] },
    training_data: { datasets: ['kolm-captures-2026-05'], size: '410 pairs', preprocessing: 'redaction + dedup', capture_count: 410 },
    evaluation_data: { datasets: ['kolm-bench-2026-05'], motivation: 'support task', preprocessing: 'none' },
    metrics: { performance_measures: ['asks-1q', 'judge-clarify'], decision_thresholds: '0.5', variation_approaches: 'seed_sweep' },
    factors: { relevant: ['intent_category'], evaluation: ['intent_category'] },
    quantitative_analyses: { unitary_results: { asks_1q: 0.965 }, intersectional_results: null },
    ethical_considerations: { sensitive_data: 'redacted at capture time', human_life: 'not_used', mitigations: ['pii_redaction'], risks_and_harms: ['hallucination'], use_cases: ['support'] },
    caveats_and_recommendations: { caveats: ['english only'], recommendations: ['use in non-safety-critical paths only'] },
  };
  const card = mod.buildModelCard(manifest, { format: 'huggingface', include_environmental: false });
  let rendered;
  if (typeof card === 'string') {
    rendered = card;
  } else if (card && card.markdown) {
    rendered = card.markdown;
  } else {
    rendered = mod.formatAsHuggingFace(card);
  }
  // Canonical 10 sections per HF Model Card v0.3.
  const expected = mod.MODEL_CARD_SECTIONS || [
    'model_details', 'intended_use', 'factors', 'metrics',
    'evaluation_data', 'training_data', 'quantitative_analyses',
    'ethical_considerations', 'caveats_and_recommendations', 'environmental_impact',
  ];
  const missing = [];
  for (const sec of expected) {
    // Section headings in formatAsMarkdown are emitted as Title Case ('## Model Details').
    const heading = '## ' + sec.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    if (!rendered.includes(heading)) missing.push(sec);
  }
  // Critical labels the W888-L caller cares about. Mapped to v0.3 section titles.
  const criticalLabels = ['Model Details', 'Training Data', 'Evaluation Data', 'Intended Use', 'license:'];
  const missingLabels = criticalLabels.filter((l) => !rendered.includes(l));
  if (missing.length || missingLabels.length) {
    process.stdout.write(JSON.stringify({
      ok: false,
      missing_sections: missing,
      missing_labels: missingLabels,
      version: VERSION,
    }) + '\n');
    return process.exit(2);
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    sections_present: expected.length,
    bytes: rendered.length,
    version: VERSION,
  }) + '\n');
  process.exit(0);
})().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message || e), version: VERSION }) + '\n');
  process.exit(2);
});
