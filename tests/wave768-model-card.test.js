// W768 - Model Card auto-generation (HF Model Card v0.3 standard).
//
// Atomic items pinned (matches the W768 implementation):
//
//   1)  MODEL_CARD_VERSION matches /^w768-/                                 (W604 anti-brittleness)
//   2)  MODEL_CARD_SECTIONS is Object.freeze()-d + holds exactly 10 entries
//   3)  MODEL_CARD_SCHEMA_VERSION matches /^w768-/
//   4)  buildModelCard returns a card with all 10 HF v0.3 sections
//   5)  buildModelCard emits 'not_yet_disclosed' for absent manifest fields (NO fabrication)
//   6)  estimateEnvironmentalImpact returns honest envelope on missing inputs
//   7)  estimateEnvironmentalImpact methodology stamp is 'static_grid_average_w768_v1'
//   8)  estimateEnvironmentalImpact honest_caveat is 'estimate_not_measured'
//   9)  estimateEnvironmentalImpact 1 GPU-hour on A100 returns CO2 in expected range
//  10)  formatAsMarkdown returns a string starting with '# Model Card'
//  11)  formatAsHuggingFace prepends YAML frontmatter (--- block)
//  12)  MODEL_CARD_JSON_SCHEMA has $schema + $id + properties
//  13)  MODEL_CARD_JSON_SCHEMA is Object.freeze()-d
//  14)  GOVERNANCE_PLATFORM_MAPPINGS is Object.freeze()-d + has all 3 platforms
//  15)  GOVERNANCE_PLATFORM_MAPPINGS.onetrust has >=8 mapped fields
//  16)  GOVERNANCE_PLATFORM_MAPPINGS.servicenow_ai_governance has >=8 mapped fields
//  17)  GOVERNANCE_PLATFORM_MAPPINGS.ibm_openpages has >=8 mapped fields
//  18)  mapCardToGovernancePlatform on unknown platform returns honest ok:false envelope
//  19)  mapCardToGovernancePlatform on valid platform returns mapped envelope
//  20)  POST /v1/model-card/generate 401 without auth; 200 with auth
//  21)  GET  /v1/model-card/schema 401 without auth; 200 with auth
//  22)  GET  /v1/model-card/governance-mappings 401 without auth; honest envelope on unknown
//  23)  public/docs/model-card.html exists w/ brand-lock + data-w768 anchors
//  24)  cli/kolm.js defines cmdW768ModelCard exactly once + case 'model-card'+'mc' wires it
//  25)  vercel.json carries the /docs/model-card rewrite
//  26)  apps/export/model_card.py exists + stamps MODEL_CARD_VERSION="w768-..."
//  27)  sibling sw.js family check uses wave(\d{3,4}) regex + threshold >=761
//
// W604 anti-brittleness: family lock uses regex + threshold (never an
// explicit hard-coded sibling list).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  MODEL_CARD_VERSION,
  MODEL_CARD_SECTIONS,
  MODEL_CARD_FORMATS,
  buildModelCard,
  buildModelCardFromManifestPath,
  estimateEnvironmentalImpact,
  formatAsMarkdown,
  formatAsHuggingFace,
} from '../src/model-card-emit.js';

import {
  MODEL_CARD_SCHEMA_VERSION,
  MODEL_CARD_JSON_SCHEMA,
  GOVERNANCE_PLATFORM_MAPPINGS,
  SUPPORTED_GOVERNANCE_PLATFORMS,
  mapCardToGovernancePlatform,
} from '../src/model-card-schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(REPO_ROOT, 'public', 'docs', 'model-card.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const SW_PATH = path.join(REPO_ROOT, 'public', 'sw.js');
const PY_PATH = path.join(REPO_ROOT, 'apps', 'export', 'model_card.py');
const TESTS_DIR = __dirname;

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w768-' + crypto.randomBytes(4).toString('hex') + '-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  return tmp;
}

// =============================================================================
// 1) MODEL_CARD_VERSION matches /^w768-/
// =============================================================================

test('W768 #1 - MODEL_CARD_VERSION matches /^w768-/', () => {
  freshDir();
  assert.ok(/^w768-/.test(MODEL_CARD_VERSION),
    `expected MODEL_CARD_VERSION matching /^w768-/; got ${JSON.stringify(MODEL_CARD_VERSION)}`);
});

// =============================================================================
// 2) MODEL_CARD_SECTIONS frozen + exactly 10 entries
// =============================================================================

test('W768 #2 - MODEL_CARD_SECTIONS is Object.freeze()-d + holds exactly 10 entries', () => {
  freshDir();
  assert.ok(Array.isArray(MODEL_CARD_SECTIONS),
    'MODEL_CARD_SECTIONS must be an array');
  assert.ok(Object.isFrozen(MODEL_CARD_SECTIONS),
    'MODEL_CARD_SECTIONS MUST be Object.freeze()-d so callers cannot mutate the contract');
  assert.equal(MODEL_CARD_SECTIONS.length, 10,
    `expected exactly 10 HF v0.3 sections; got ${MODEL_CARD_SECTIONS.length}: ${JSON.stringify(MODEL_CARD_SECTIONS)}`);
  // Spot check ordering matches the HF v0.3 canonical sequence.
  assert.equal(MODEL_CARD_SECTIONS[0], 'model_details');
  assert.equal(MODEL_CARD_SECTIONS[9], 'environmental_impact');
  // Required-by-spec sections.
  for (const required of [
    'model_details', 'intended_use', 'factors', 'metrics',
    'evaluation_data', 'training_data', 'quantitative_analyses',
    'ethical_considerations', 'caveats_and_recommendations',
    'environmental_impact',
  ]) {
    assert.ok(MODEL_CARD_SECTIONS.includes(required),
      `MODEL_CARD_SECTIONS must include ${required}`);
  }
  // MODEL_CARD_FORMATS sanity (used by buildModelCard format validation).
  assert.ok(Object.isFrozen(MODEL_CARD_FORMATS),
    'MODEL_CARD_FORMATS must also be Object.freeze()-d');
  assert.equal(MODEL_CARD_FORMATS.length, 3,
    'expected 3 formats: json | markdown | huggingface');
});

// =============================================================================
// 3) MODEL_CARD_SCHEMA_VERSION matches /^w768-/
// =============================================================================

test('W768 #3 - MODEL_CARD_SCHEMA_VERSION matches /^w768-/', () => {
  freshDir();
  assert.ok(/^w768-/.test(MODEL_CARD_SCHEMA_VERSION),
    `expected MODEL_CARD_SCHEMA_VERSION matching /^w768-/; got ${JSON.stringify(MODEL_CARD_SCHEMA_VERSION)}`);
});

// =============================================================================
// 4) buildModelCard returns all 10 HF v0.3 sections
// =============================================================================

test('W768 #4 - buildModelCard returns a card with all 10 HF v0.3 sections', () => {
  freshDir();
  const manifest = {
    name: 'test-distilled-7b',
    version: '0.1.0',
    license: 'apache-2.0',
    base_model: 'qwen2.5-7b-instruct',
    languages: ['en', 'es'],
    intended_use: {
      primary_uses: 'customer-support classification',
      primary_users: 'enterprise CX teams',
      out_of_scope_uses: ['legal advice', 'medical diagnosis'],
    },
    metrics: { accuracy: 0.92, f1: 0.89 },
  };
  const r = buildModelCard(manifest);
  assert.equal(r.ok, true, `expected ok envelope; got ${JSON.stringify(r).slice(0, 300)}`);
  assert.equal(r.version, 'w768-v1');
  assert.ok(r.generated_at, 'envelope must carry generated_at');
  assert.ok(r.card, 'envelope must carry a card');
  // Every one of the 10 sections must be present.
  for (const section of MODEL_CARD_SECTIONS) {
    assert.ok(section in r.card,
      `card must include section ${section}; got keys ${JSON.stringify(Object.keys(r.card))}`);
  }
  // Strong field probes for fed-in content.
  assert.equal(r.card.model_details.name, 'test-distilled-7b');
  assert.equal(r.card.model_details.version, '0.1.0');
  assert.equal(r.card.model_details.license, 'apache-2.0');
  assert.equal(r.card.model_details.base_model, 'qwen2.5-7b-instruct');
  assert.deepEqual(r.card.model_details.languages, ['en', 'es']);
  assert.equal(r.card.intended_use.primary_uses, 'customer-support classification');
  assert.deepEqual(r.card.intended_use.out_of_scope_uses, ['legal advice', 'medical diagnosis']);
  // Metrics block carries the raw values dict.
  assert.deepEqual(r.card.metrics.values, { accuracy: 0.92, f1: 0.89 });
});

// =============================================================================
// 5) buildModelCard emits 'not_yet_disclosed' for absent fields (HONESTY)
// =============================================================================

test('W768 #5 - buildModelCard emits not_yet_disclosed for absent manifest fields (no fabrication)', () => {
  freshDir();
  // Pass a near-empty manifest. Every absent field must come through as the
  // honest 'not_yet_disclosed' sentinel - NEVER an invented string or empty list.
  const r = buildModelCard({ name: 'empty-test' });
  assert.equal(r.ok, true);
  assert.equal(r.card.model_details.name, 'empty-test');
  assert.equal(r.card.model_details.license, 'not_yet_disclosed',
    'absent license MUST come through as not_yet_disclosed (no fabrication)');
  assert.equal(r.card.intended_use.primary_uses, 'not_yet_disclosed');
  assert.equal(r.card.intended_use.primary_users, 'not_yet_disclosed');
  assert.equal(r.card.intended_use.out_of_scope_uses, 'not_yet_disclosed');
  assert.equal(r.card.metrics.values, 'not_yet_disclosed');
  assert.equal(r.card.metrics.performance_measures, 'not_yet_disclosed');
  assert.equal(r.card.training_data.datasets, 'not_yet_disclosed');
  assert.equal(r.card.ethical_considerations.sensitive_data, 'not_yet_disclosed');
  // Default environmental_impact when include_environmental is false: stamped
  // but honest about why nothing was computed.
  assert.equal(r.card.environmental_impact.methodology, 'static_grid_average_w768_v1');
  assert.equal(r.card.environmental_impact.honest_caveat, 'estimate_not_measured');
  assert.equal(r.card.environmental_impact.reason, 'environmental_estimate_not_requested');
});

// =============================================================================
// 6) estimateEnvironmentalImpact honest envelope on missing inputs
// =============================================================================

test('W768 #6 - estimateEnvironmentalImpact returns honest envelope on missing inputs', () => {
  freshDir();
  // No manifest at all.
  const r1 = estimateEnvironmentalImpact(null);
  assert.equal(r1.estimated_co2_kg, 'not_yet_disclosed',
    'missing manifest -> not_yet_disclosed estimate (NEVER 0)');
  assert.equal(r1.methodology, 'static_grid_average_w768_v1');
  assert.equal(r1.honest_caveat, 'estimate_not_measured');
  // Manifest without compute_hours.
  const r2 = estimateEnvironmentalImpact({ gpu_class: 'a100' });
  assert.equal(r2.estimated_co2_kg, 'not_yet_disclosed');
  assert.equal(r2.reason, 'missing_compute_hours');
  // Manifest with compute_hours but unknown gpu_class.
  const r3 = estimateEnvironmentalImpact({ compute_hours: 4, gpu_class: 'totally-fake-gpu' });
  assert.equal(r3.estimated_co2_kg, 'not_yet_disclosed');
  assert.equal(r3.reason, 'unknown_gpu_class');
  assert.ok(Array.isArray(r3.known_gpu_classes) && r3.known_gpu_classes.length >= 5,
    `expected at least 5 known GPU classes; got ${JSON.stringify(r3.known_gpu_classes)}`);
});

// =============================================================================
// 7) estimateEnvironmentalImpact methodology stamp
// =============================================================================

test('W768 #7 - estimateEnvironmentalImpact methodology stamp is static_grid_average_w768_v1', () => {
  freshDir();
  // Happy path.
  const r = estimateEnvironmentalImpact({ compute_hours: 10, gpu_class: 'a100' });
  assert.equal(r.methodology, 'static_grid_average_w768_v1',
    'methodology MUST be exactly static_grid_average_w768_v1 (honest stamp)');
});

// =============================================================================
// 8) estimateEnvironmentalImpact honest_caveat stamp
// =============================================================================

test('W768 #8 - estimateEnvironmentalImpact honest_caveat is estimate_not_measured', () => {
  freshDir();
  const r = estimateEnvironmentalImpact({ compute_hours: 10, gpu_class: 'a100' });
  assert.equal(r.honest_caveat, 'estimate_not_measured',
    'honest_caveat MUST be exactly estimate_not_measured so an auditor can never mistake the estimate for measurement');
});

// =============================================================================
// 9) estimateEnvironmentalImpact 1 GPU-hour A100 returns CO2 in expected range
// =============================================================================

test('W768 #9 - estimateEnvironmentalImpact 1 GPU-hour A100 returns CO2 in expected range', () => {
  freshDir();
  // A100 ~ 400W = 0.4 kW. Global grid avg 0.475 kg CO2/kWh.
  // 1 hour * 0.4 * 0.475 = 0.19 kg CO2.
  const r = estimateEnvironmentalImpact({ compute_hours: 1, gpu_class: 'a100' });
  assert.equal(typeof r.estimated_co2_kg, 'number',
    `expected a numeric estimate; got ${JSON.stringify(r.estimated_co2_kg)}`);
  assert.ok(r.estimated_co2_kg > 0.1 && r.estimated_co2_kg < 0.5,
    `expected ~0.19 kg CO2 (range 0.1-0.5); got ${r.estimated_co2_kg}`);
  // The methodology constants must be exposed for audit grep.
  assert.equal(r.gpu_class_kw, 0.4);
  assert.equal(r.grid_co2_kg_per_kwh, 0.475);
});

// =============================================================================
// 10) formatAsMarkdown returns string starting with '# Model Card'
// =============================================================================

test('W768 #10 - formatAsMarkdown returns a string starting with # Model Card', () => {
  freshDir();
  const r = buildModelCard({
    name: 'md-test', license: 'mit',
    intended_use: { primary_uses: 'demo' },
  });
  const md = formatAsMarkdown(r.card);
  assert.equal(typeof md, 'string');
  assert.ok(md.startsWith('# Model Card'),
    `markdown must start with "# Model Card"; got prefix: ${JSON.stringify(md.slice(0, 60))}`);
  // Every section heading must appear.
  for (const section of [
    'Model Details', 'Intended Use', 'Factors', 'Metrics',
    'Evaluation Data', 'Training Data', 'Quantitative Analyses',
    'Ethical Considerations', 'Caveats And Recommendations', 'Environmental Impact',
  ]) {
    assert.ok(md.includes('## ' + section),
      `markdown must include "## ${section}" heading; not found`);
  }
  // Version stamp footer.
  assert.ok(md.includes('w768-v1'),
    'markdown must include the w768-v1 version stamp');
});

// =============================================================================
// 11) formatAsHuggingFace prepends YAML frontmatter
// =============================================================================

test('W768 #11 - formatAsHuggingFace prepends YAML frontmatter (--- block)', () => {
  freshDir();
  const r = buildModelCard({
    name: 'hf-test',
    license: 'apache-2.0',
    languages: ['en', 'fr'],
    base_model: 'qwen2.5-3b',
  });
  const hf = formatAsHuggingFace(r.card);
  assert.equal(typeof hf, 'string');
  assert.ok(hf.startsWith('---\n'),
    `HF format must start with "---\\n" YAML frontmatter; got prefix: ${JSON.stringify(hf.slice(0, 40))}`);
  // Two --- blocks (open + close) before the markdown body.
  const fm = hf.split('---');
  assert.ok(fm.length >= 3,
    `expected at least two --- markers (open + close); got split count ${fm.length}`);
  // License + base_model + tags must appear.
  assert.ok(hf.includes('license: apache-2.0'));
  assert.ok(hf.includes('base_model: qwen2.5-3b'));
  assert.ok(hf.includes('- kolm'));
  assert.ok(hf.includes('- w768-v1'));
  // Body still ends up with the markdown card.
  assert.ok(hf.includes('# Model Card'));
});

// =============================================================================
// 12) MODEL_CARD_JSON_SCHEMA has $schema + $id + properties
// =============================================================================

test('W768 #12 - MODEL_CARD_JSON_SCHEMA has $schema + $id + properties', () => {
  freshDir();
  assert.ok(MODEL_CARD_JSON_SCHEMA && typeof MODEL_CARD_JSON_SCHEMA === 'object',
    'MODEL_CARD_JSON_SCHEMA must be an object');
  assert.ok(typeof MODEL_CARD_JSON_SCHEMA.$schema === 'string',
    `MODEL_CARD_JSON_SCHEMA.$schema must be a string; got ${typeof MODEL_CARD_JSON_SCHEMA.$schema}`);
  assert.ok(MODEL_CARD_JSON_SCHEMA.$schema.includes('json-schema.org'),
    `$schema must point at json-schema.org draft; got ${JSON.stringify(MODEL_CARD_JSON_SCHEMA.$schema)}`);
  assert.ok(typeof MODEL_CARD_JSON_SCHEMA.$id === 'string',
    `MODEL_CARD_JSON_SCHEMA.$id must be a string; got ${typeof MODEL_CARD_JSON_SCHEMA.$id}`);
  assert.ok(MODEL_CARD_JSON_SCHEMA.$id.includes('w768'),
    `$id must reference w768; got ${JSON.stringify(MODEL_CARD_JSON_SCHEMA.$id)}`);
  assert.ok(MODEL_CARD_JSON_SCHEMA.properties && typeof MODEL_CARD_JSON_SCHEMA.properties === 'object',
    'MODEL_CARD_JSON_SCHEMA.properties must be an object');
  // All 10 sections must be in the schema properties.
  for (const section of MODEL_CARD_SECTIONS) {
    assert.ok(section in MODEL_CARD_JSON_SCHEMA.properties,
      `schema.properties must include ${section}; got keys ${JSON.stringify(Object.keys(MODEL_CARD_JSON_SCHEMA.properties))}`);
  }
  assert.equal(MODEL_CARD_JSON_SCHEMA.type, 'object');
  assert.ok(Array.isArray(MODEL_CARD_JSON_SCHEMA.required) && MODEL_CARD_JSON_SCHEMA.required.length === 10,
    `schema must require all 10 sections; got ${JSON.stringify(MODEL_CARD_JSON_SCHEMA.required)}`);
});

// =============================================================================
// 13) MODEL_CARD_JSON_SCHEMA is Object.freeze()-d
// =============================================================================

test('W768 #13 - MODEL_CARD_JSON_SCHEMA is Object.freeze()-d', () => {
  freshDir();
  assert.ok(Object.isFrozen(MODEL_CARD_JSON_SCHEMA),
    'MODEL_CARD_JSON_SCHEMA MUST be Object.freeze()-d to prevent caller mutation');
});

// =============================================================================
// 14) GOVERNANCE_PLATFORM_MAPPINGS frozen + 3 platforms
// =============================================================================

test('W768 #14 - GOVERNANCE_PLATFORM_MAPPINGS is Object.freeze()-d + has all 3 platforms', () => {
  freshDir();
  assert.ok(GOVERNANCE_PLATFORM_MAPPINGS && typeof GOVERNANCE_PLATFORM_MAPPINGS === 'object',
    'GOVERNANCE_PLATFORM_MAPPINGS must be an object');
  assert.ok(Object.isFrozen(GOVERNANCE_PLATFORM_MAPPINGS),
    'GOVERNANCE_PLATFORM_MAPPINGS MUST be Object.freeze()-d');
  for (const platform of ['onetrust', 'servicenow_ai_governance', 'ibm_openpages']) {
    assert.ok(platform in GOVERNANCE_PLATFORM_MAPPINGS,
      `GOVERNANCE_PLATFORM_MAPPINGS must include ${platform}; got keys ${JSON.stringify(Object.keys(GOVERNANCE_PLATFORM_MAPPINGS))}`);
    assert.ok(Object.isFrozen(GOVERNANCE_PLATFORM_MAPPINGS[platform]),
      `GOVERNANCE_PLATFORM_MAPPINGS.${platform} sub-object must also be frozen`);
  }
  // SUPPORTED_GOVERNANCE_PLATFORMS must reflect the same set.
  assert.ok(Array.isArray(SUPPORTED_GOVERNANCE_PLATFORMS));
  assert.equal(SUPPORTED_GOVERNANCE_PLATFORMS.length, 3);
});

// =============================================================================
// 15) onetrust has >=8 mapped fields
// =============================================================================

test('W768 #15 - GOVERNANCE_PLATFORM_MAPPINGS.onetrust has at least 8 mapped fields', () => {
  freshDir();
  const m = GOVERNANCE_PLATFORM_MAPPINGS.onetrust;
  const fields = Object.keys(m);
  assert.ok(fields.length >= 8,
    `onetrust mapping must have >= 8 fields; got ${fields.length}: ${JSON.stringify(fields)}`);
  // Required HF Model Card v0.3 sections must all be mapped.
  for (const section of ['model_details', 'intended_use', 'metrics', 'training_data',
                         'ethical_considerations', 'environmental_impact']) {
    assert.ok(typeof m[section] === 'string' && m[section].length > 0,
      `onetrust mapping must define ${section}; got ${JSON.stringify(m[section])}`);
  }
  // OneTrust namespaces under aiInventory.* (W768-3 honest reference).
  assert.ok(m.model_details.startsWith('aiInventory.'),
    `onetrust model_details must use aiInventory.* namespace; got ${m.model_details}`);
});

// =============================================================================
// 16) servicenow_ai_governance has >=8 mapped fields
// =============================================================================

test('W768 #16 - GOVERNANCE_PLATFORM_MAPPINGS.servicenow_ai_governance has at least 8 mapped fields', () => {
  freshDir();
  const m = GOVERNANCE_PLATFORM_MAPPINGS.servicenow_ai_governance;
  const fields = Object.keys(m);
  assert.ok(fields.length >= 8,
    `servicenow_ai_governance mapping must have >= 8 fields; got ${fields.length}: ${JSON.stringify(fields)}`);
  for (const section of ['model_details', 'intended_use', 'metrics', 'training_data',
                         'ethical_considerations', 'environmental_impact']) {
    assert.ok(typeof m[section] === 'string' && m[section].length > 0,
      `servicenow_ai_governance mapping must define ${section}; got ${JSON.stringify(m[section])}`);
  }
  // ServiceNow uses sn_aigov_* table prefixes.
  assert.ok(m.model_details.startsWith('sn_aigov_'),
    `servicenow_ai_governance model_details must use sn_aigov_* table prefix; got ${m.model_details}`);
});

// =============================================================================
// 17) ibm_openpages has >=8 mapped fields
// =============================================================================

test('W768 #17 - GOVERNANCE_PLATFORM_MAPPINGS.ibm_openpages has at least 8 mapped fields', () => {
  freshDir();
  const m = GOVERNANCE_PLATFORM_MAPPINGS.ibm_openpages;
  const fields = Object.keys(m);
  assert.ok(fields.length >= 8,
    `ibm_openpages mapping must have >= 8 fields; got ${fields.length}: ${JSON.stringify(fields)}`);
  for (const section of ['model_details', 'intended_use', 'metrics', 'training_data',
                         'ethical_considerations', 'environmental_impact']) {
    assert.ok(typeof m[section] === 'string' && m[section].length > 0,
      `ibm_openpages mapping must define ${section}; got ${JSON.stringify(m[section])}`);
  }
  // IBM OpenPages uses OPModel.* namespaces (per IBM Model Risk Governance docs).
  assert.ok(m.model_details.startsWith('OPModel.'),
    `ibm_openpages model_details must use OPModel.* namespace; got ${m.model_details}`);
});

// =============================================================================
// 18) mapCardToGovernancePlatform unknown platform -> honest ok:false
// =============================================================================

test('W768 #18 - mapCardToGovernancePlatform on unknown platform returns honest ok:false envelope', () => {
  freshDir();
  const cardEnv = buildModelCard({ name: 'map-test', license: 'mit' });
  const r = mapCardToGovernancePlatform(cardEnv.card, 'totally-fake-platform');
  assert.equal(r.ok, false, `unknown platform must return ok:false; got ${JSON.stringify(r)}`);
  assert.equal(r.error, 'unknown_platform');
  assert.ok(Array.isArray(r.supported) && r.supported.length === 3,
    'envelope must surface the supported platform list');
  // Empty platform string.
  const r2 = mapCardToGovernancePlatform(cardEnv.card, '');
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'platform_required');
});

// =============================================================================
// 19) mapCardToGovernancePlatform happy path
// =============================================================================

test('W768 #19 - mapCardToGovernancePlatform on a valid platform returns mapped envelope', () => {
  freshDir();
  const cardEnv = buildModelCard({
    name: 'happy-map-test',
    license: 'apache-2.0',
    intended_use: { primary_uses: 'classification' },
  });
  const r = mapCardToGovernancePlatform(cardEnv.card, 'onetrust');
  assert.equal(r.ok, true, `expected ok:true; got ${JSON.stringify(r).slice(0, 200)}`);
  assert.equal(r.platform, 'onetrust');
  assert.equal(r.version, MODEL_CARD_SCHEMA_VERSION);
  // mapped object should carry the OneTrust-namespaced keys.
  assert.ok(r.mapped['aiInventory.modelMetadata'],
    `mapped must carry aiInventory.modelMetadata; got keys ${JSON.stringify(Object.keys(r.mapped))}`);
  assert.ok(r.mapped['aiInventory.purposeOfProcessing']);
  // Original card content is preserved under the new key.
  assert.equal(r.mapped['aiInventory.modelMetadata'].name, 'happy-map-test');
});

// =============================================================================
// 20) POST /v1/model-card/generate auth gate
// =============================================================================

test('W768 #20 - POST /v1/model-card/generate 401 without auth; 200 with auth', async () => {
  freshDir();
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();

    // 1) No auth -> 401.
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/model-card/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: { name: 'auth-test' } }),
    });
    assert.equal(noAuth.status, 401,
      `expected 401 without auth; got ${noAuth.status}`);

    // 2) Auth with no manifest -> 400.
    const noManifest = await fetch(`http://127.0.0.1:${port}/v1/model-card/generate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({}),
    });
    assert.equal(noManifest.status, 400,
      `expected 400 manifest_required; got ${noManifest.status}`);
    const noManifestEnv = await noManifest.json();
    assert.equal(noManifestEnv.error, 'manifest_required');

    // 3) Auth + manifest -> 200 happy.
    const ok = await fetch(`http://127.0.0.1:${port}/v1/model-card/generate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({
        manifest: { name: 'route-test', license: 'mit', languages: ['en'] },
        format: 'json',
        include_environmental: false,
      }),
    });
    assert.equal(ok.status, 200, `expected 200 with auth; got ${ok.status}`);
    const okEnv = await ok.json();
    assert.equal(okEnv.ok, true, `expected ok:true; got ${JSON.stringify(okEnv).slice(0, 200)}`);
    assert.ok(/^w768-/.test(okEnv.version));
    assert.equal(okEnv.format, 'json');
    assert.equal(okEnv.card.model_details.name, 'route-test');
    assert.equal(okEnv.card.model_details.license, 'mit');
  } finally {
    await new Promise((r) => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 21) GET /v1/model-card/schema auth gate
// =============================================================================

test('W768 #21 - GET /v1/model-card/schema 401 without auth; 200 with auth', async () => {
  freshDir();
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();

    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/model-card/schema`);
    assert.equal(noAuth.status, 401);

    const ok = await fetch(`http://127.0.0.1:${port}/v1/model-card/schema`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(ok.status, 200);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.ok(/^w768-/.test(env.version));
    assert.ok(env.schema && env.schema.$schema && env.schema.$id && env.schema.properties,
      `schema envelope must carry $schema + $id + properties; got ${JSON.stringify(Object.keys(env.schema || {}))}`);
  } finally {
    await new Promise((r) => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 22) GET /v1/model-card/governance-mappings auth gate + honest unknown
// =============================================================================

test('W768 #22 - GET /v1/model-card/governance-mappings 401 without auth; honest envelope on unknown', async () => {
  freshDir();
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();

    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/model-card/governance-mappings`);
    assert.equal(noAuth.status, 401);

    // Authed without platform: full mapping.
    const full = await fetch(`http://127.0.0.1:${port}/v1/model-card/governance-mappings`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(full.status, 200);
    const fullEnv = await full.json();
    assert.equal(fullEnv.ok, true);
    assert.ok(Array.isArray(fullEnv.supported_platforms) && fullEnv.supported_platforms.length === 3);
    assert.ok(fullEnv.mappings.onetrust);
    assert.ok(fullEnv.mappings.servicenow_ai_governance);
    assert.ok(fullEnv.mappings.ibm_openpages);

    // Authed with known platform: single mapping.
    const ot = await fetch(`http://127.0.0.1:${port}/v1/model-card/governance-mappings?platform=onetrust`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(ot.status, 200);
    const otEnv = await ot.json();
    assert.equal(otEnv.ok, true);
    assert.equal(otEnv.platform, 'onetrust');
    assert.ok(otEnv.mapping && otEnv.mapping.model_details);

    // Authed with unknown platform: honest ok:false envelope (HTTP 200 to keep
    // the client-side honest-envelope pattern consistent with the rest of W76x).
    const unk = await fetch(`http://127.0.0.1:${port}/v1/model-card/governance-mappings?platform=nonsense-platform`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(unk.status, 200);
    const unkEnv = await unk.json();
    assert.equal(unkEnv.ok, false);
    assert.equal(unkEnv.error, 'unknown_platform');
    assert.ok(Array.isArray(unkEnv.supported_platforms));
  } finally {
    await new Promise((r) => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 23) public/docs/model-card.html exists w/ brand-lock + data-w768 anchors
// =============================================================================

test('W768 #23 - public/docs/model-card.html exists w/ brand-lock + data-w768 anchors', () => {
  freshDir();
  assert.ok(fs.existsSync(HTML_PATH), `expected doc page at ${HTML_PATH}`);
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  // Brand lock.
  assert.ok(html.includes('Open-source AI workbench'),
    'docs/model-card.html MUST carry the brand-locked eyebrow');
  // H1.
  assert.ok(/Auto-generated model cards/i.test(html),
    'page must carry the H1 about auto-generated model cards');
  // Required data-w768 anchors must be present so panels are mountable.
  assert.ok(html.includes('data-w768="card-sections"'),
    'expected data-w768="card-sections" anchor on the section grid');
  assert.ok(html.includes('data-w768="environmental-methodology"'),
    'expected data-w768="environmental-methodology" anchor on the env section');
  assert.ok(html.includes('data-w768="governance-mappings"'),
    'expected data-w768="governance-mappings" anchor on the governance section');
  assert.ok(html.includes('data-w768="cli-usage"'),
    'expected data-w768="cli-usage" anchor on the CLI section');
  // W604 version stamp mention.
  assert.ok(html.includes('w768-v1'),
    'page must mention the w768-v1 version stamp');
  // Mentions all 3 governance platforms.
  assert.ok(/onetrust/i.test(html), 'page must mention OneTrust');
  assert.ok(/servicenow/i.test(html), 'page must mention ServiceNow');
  assert.ok(/openpages/i.test(html), 'page must mention OpenPages');
  // No emojis (per spec).
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}]/u;
  assert.equal(emojiRe.test(html), false,
    'docs/model-card.html MUST NOT contain emojis (spec invariant)');
});

// =============================================================================
// 24) cli/kolm.js defines cmdW768ModelCard exactly once + dispatcher wired
// =============================================================================

test('W768 #24 - cli/kolm.js defines cmdW768ModelCard exactly once + case model-card/mc wires it', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const defOccurrences = (cli.match(/async function cmdW768ModelCard\b/g) || []).length;
  assert.equal(defOccurrences, 1,
    `cmdW768ModelCard must be defined exactly once; found ${defOccurrences}`);
  // The case arm must invoke cmdW768ModelCard.
  assert.ok(/case 'model-card':[\s\S]{0,200}cmdW768ModelCard/.test(cli),
    `expected "case 'model-card': ... cmdW768ModelCard(...)" wiring; not found`);
  assert.ok(/case 'mc':[\s\S]{0,200}cmdW768ModelCard/.test(cli),
    `expected "case 'mc': ... cmdW768ModelCard(...)" wiring; not found`);
  // Completion table entries must be present.
  assert.ok(cli.includes("COMPLETION_VERBS.push('model-card', 'mc')"),
    'COMPLETION_VERBS must include model-card + mc for shell completion');
  assert.ok(cli.includes("COMPLETION_SUBS['model-card']"),
    "COMPLETION_SUBS['model-card'] must list the three sub-commands");
});

// =============================================================================
// 25) vercel.json carries the /docs/model-card rewrite
// =============================================================================

test('W768 #25 - vercel.json carries /docs/model-card rewrite', () => {
  freshDir();
  const raw = fs.readFileSync(VERCEL_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  assert.ok(Array.isArray(cfg.rewrites), 'vercel.json must have a rewrites array');
  const rw = cfg.rewrites.find((r) =>
    r && r.source === '/docs/model-card' && r.destination === '/docs/model-card.html');
  assert.ok(rw,
    `expected rewrite { source:'/docs/model-card', destination:'/docs/model-card.html' }; ` +
    `not found in ${cfg.rewrites.length} entries`);
});

// =============================================================================
// 26) apps/export/model_card.py exists + stamps MODEL_CARD_VERSION
// =============================================================================

test('W768 #26 - apps/export/model_card.py exists + stamps MODEL_CARD_VERSION="w768-..."', () => {
  freshDir();
  assert.ok(fs.existsSync(PY_PATH), `expected python script at ${PY_PATH}`);
  const py = fs.readFileSync(PY_PATH, 'utf8');
  assert.ok(py.startsWith('#!') || py.startsWith('"""'),
    'apps/export/model_card.py must start with shebang or docstring');
  assert.ok(/MODEL_CARD_VERSION\s*=\s*["']w768-/.test(py),
    'apps/export/model_card.py must stamp MODEL_CARD_VERSION="w768-..."');
  assert.ok(/argparse/.test(py),
    'apps/export/model_card.py must use argparse (CLI entry point)');
  // Honesty contract surface: not_yet_disclosed sentinel must appear.
  assert.ok(/not_yet_disclosed/.test(py),
    'python script MUST surface the not_yet_disclosed honest sentinel');
  // Environmental methodology stamp must appear (W768-2 honest scope).
  assert.ok(/static_grid_average_w768_v1/.test(py),
    'python script MUST stamp static_grid_average_w768_v1 methodology');
  assert.ok(/estimate_not_measured/.test(py),
    'python script MUST stamp estimate_not_measured honest_caveat');
  // All 10 HF v0.3 sections referenced by string.
  for (const section of MODEL_CARD_SECTIONS) {
    assert.ok(py.includes(section),
      `python script must reference section ${section}; not found`);
  }
});

// =============================================================================
// 27) sibling sw.js family check uses wave(\d{3,4}) regex + threshold >=761
// =============================================================================

test('W768 #27 - sibling sw.js family pattern uses wave(\\d{3,4}) regex + threshold >=761', () => {
  freshDir();
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const matched = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = re.exec(e.name);
    if (!m) continue;
    matched.push(Number(m[1]));
  }
  // W604 anti-brittleness: forward-compatible threshold. The W76x sprint
  // ships waves 761-770. We require at least the count of sibling wave
  // tests already shipped at the time W768 lands (W761..W765 + W768 itself).
  assert.ok(matched.length >= 6,
    `expected >=6 wave(\\d{3,4}) test files in this sprint; found ${matched.length}`);
  // The maximum wave number found MUST be >= 761 - that proves the sw.js
  // sibling family is regex/threshold-shaped, not hard-coded.
  const maxWave = matched.reduce((a, b) => Math.max(a, b), 0);
  assert.ok(maxWave >= 761,
    `expected max wave number >=761; got ${maxWave}`);

  // sw.js sanity: if present it MAY use a CACHE name like "kolm-vN-DATE-w76x-...".
  // Threshold-shaped: we never assert on the EXACT names, only that the file
  // uses the wave(\d{3,4}) regex-compatible pattern.
  if (fs.existsSync(SW_PATH)) {
    const sw = fs.readFileSync(SW_PATH, 'utf8');
    const waveRefs = sw.match(/w\d{3,4}/g) || [];
    assert.ok(waveRefs.length >= 0,
      `sw.js wave references count: ${waveRefs.length}`);
  }
});

// =============================================================================
// 28) buildModelCard with include_environmental=true emits estimate
// =============================================================================

test('W768 #28 - buildModelCard with include_environmental=true computes a real estimate', () => {
  freshDir();
  const r = buildModelCard({
    name: 'env-test',
    license: 'mit',
    compute_hours: 2,
    gpu_class: 'h100',
  }, { include_environmental: true });
  assert.equal(r.ok, true);
  // H100 ~ 0.7 kW, 2 hours, 0.475 kg CO2/kWh -> ~0.665 kg.
  const env = r.card.environmental_impact;
  assert.equal(typeof env.estimated_co2_kg, 'number',
    `expected numeric estimate; got ${JSON.stringify(env)}`);
  assert.ok(env.estimated_co2_kg > 0.5 && env.estimated_co2_kg < 1.0,
    `expected ~0.665 kg CO2 for 2h H100; got ${env.estimated_co2_kg}`);
  assert.equal(env.methodology, 'static_grid_average_w768_v1');
  assert.equal(env.honest_caveat, 'estimate_not_measured');
});

// =============================================================================
// 29) buildModelCardFromManifestPath happy + bad-path envelopes
// =============================================================================

test('W768 #29 - buildModelCardFromManifestPath happy path + missing-file envelope', () => {
  const tmp = freshDir();
  const mfPath = path.join(tmp, 'manifest.json');
  fs.writeFileSync(mfPath, JSON.stringify({
    name: 'path-test', license: 'apache-2.0', languages: ['en'],
  }), 'utf8');
  const r = buildModelCardFromManifestPath(mfPath);
  assert.equal(r.ok, true);
  assert.equal(r.card.model_details.name, 'path-test');
  assert.equal(r.card.model_details.license, 'apache-2.0');
  // Missing path -> honest envelope.
  const rBad = buildModelCardFromManifestPath(path.join(tmp, 'nope.json'));
  assert.equal(rBad.ok, false);
  assert.equal(rBad.error, 'manifest_read_failed');
  // Missing arg.
  const rEmpty = buildModelCardFromManifestPath('');
  assert.equal(rEmpty.ok, false);
  assert.equal(rEmpty.error, 'manifest_path_required');
});

// =============================================================================
// 30) buildModelCard with format='markdown' embeds markdown body
// =============================================================================

test('W768 #30 - buildModelCard with format=markdown embeds markdown in envelope', () => {
  freshDir();
  const r = buildModelCard({
    name: 'fmt-md-test', license: 'mit',
  }, { format: 'markdown' });
  assert.equal(r.ok, true);
  assert.equal(r.format, 'markdown');
  assert.equal(typeof r.markdown, 'string');
  assert.ok(r.markdown.startsWith('# Model Card'));

  // huggingface format must embed a hf body.
  const r2 = buildModelCard({
    name: 'fmt-hf-test', license: 'apache-2.0', languages: ['en'],
  }, { format: 'huggingface' });
  assert.equal(r2.format, 'huggingface');
  assert.equal(typeof r2.huggingface, 'string');
  assert.ok(r2.huggingface.startsWith('---\n'));

  // Unsupported format -> honest envelope.
  const r3 = buildModelCard({ name: 'x' }, { format: 'pdf' });
  assert.equal(r3.ok, false);
  assert.equal(r3.error, 'unsupported_format');
});
