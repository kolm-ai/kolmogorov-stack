// W766 — EU AI Act Compliance Toolkit.
//
// Atomic items pinned (matches the W766 implementation):
//
//   1)  AI_ACT_RISK_VERSION + AI_ACT_EXPORT_VERSION stamped 'w766-v1'
//   2)  AI_ACT_RISK_CATEGORIES is Object.freeze()-d + holds exactly 4 entries
//   3)  AI_ACT_TASK_CATEGORY_MAP is Object.freeze()-d + holds >=15 entries
//   4)  scoreArtifactRisk('medical_diagnosis') -> 'high'
//   5)  scoreArtifactRisk('chatbot')           -> 'limited'
//   6)  scoreArtifactRisk('code_completion')   -> 'minimal'
//   7)  scoreArtifactRisk('social_scoring')    -> 'unacceptable'
//       (Article 5 prohibition)
//   8)  scoreArtifactRisk(empty manifest)      -> 'minimal' floor (HONESTY:
//       never null, never fabricated)
//   9)  scoreArtifactRisk(invalid input)       -> {ok:false} honest envelope
//   10) classifyTaskCategory confidence caps at 0.95 (HONESTY)
//   11) ANNEX_IV_FIELDS is Object.freeze()-d + holds exactly 9 entries
//   12) buildTechnicalDocumentation emits 'not_yet_disclosed' for absent fields
//       (HONESTY: never fabricated)
//   13) buildTechnicalDocumentation markdown format carries .markdown body
//   14) buildGovernanceReport tenant-fences via per-row tenant_id re-check
//       (W411 defense-in-depth)
//   15) buildGovernanceReport({}) -> {ok:false, error:'tenant_required'}
//   16) humanInLoopConfig validates threshold ∈ [0, 10] nats
//   17) humanInLoopConfig persists durable marker via event-store
//   18) POST /v1/compliance/ai-act/risk-score 401 w/o auth; 200 envelope on auth
//   19) POST /v1/compliance/ai-act/export 401 w/o auth; 200 envelope on auth
//   20) POST /v1/compliance/ai-act/human-in-loop auth + confirm gates
//   21) GET  /v1/compliance/ai-act/governance-report 401 w/o auth; 200 on auth
//   22) public/compliance/eu-ai-act.html exists w/ brand-lock + anchors
//   23) cli/kolm.js defines cmdW766AiAct exactly once + wired from case 'ai-act'
//   24) vercel.json carries /compliance/eu-ai-act rewrite
//   25) apps/export/ai_act_docs.py exists + is stdlib-only (no third-party imports)
//   26) sibling sw.js / test family pattern uses regex + threshold
//       (W604 anti-brittleness)
//
// W604 anti-brittleness: family lock uses regex + numeric threshold (never an
// explicit hard-coded sibling list).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  AI_ACT_RISK_VERSION,
  AI_ACT_RISK_CATEGORIES,
  AI_ACT_TASK_CATEGORY_MAP,
  scoreArtifactRisk,
  classifyTaskCategory,
} from '../src/ai-act-risk.js';

import {
  AI_ACT_EXPORT_VERSION,
  ANNEX_IV_FIELDS,
  buildTechnicalDocumentation,
  buildGovernanceReport,
  humanInLoopConfig,
  getHumanInLoopThreshold,
} from '../src/ai-act-export.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(REPO_ROOT, 'public', 'compliance', 'eu-ai-act.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const SW_PATH = path.join(REPO_ROOT, 'public', 'sw.js');
const PY_PATH = path.join(REPO_ROOT, 'apps', 'export', 'ai_act_docs.py');
const TESTS_DIR = __dirname;

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w766-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  return tmp;
}

// =============================================================================
// 1) Version stamps
// =============================================================================

test('W766 #1 — AI_ACT_RISK_VERSION + AI_ACT_EXPORT_VERSION stamped w766-v1', () => {
  freshDir();
  assert.equal(AI_ACT_RISK_VERSION, 'w766-v1',
    `expected AI_ACT_RISK_VERSION='w766-v1'; got ${JSON.stringify(AI_ACT_RISK_VERSION)}`);
  assert.equal(AI_ACT_EXPORT_VERSION, 'w766-v1',
    `expected AI_ACT_EXPORT_VERSION='w766-v1'; got ${JSON.stringify(AI_ACT_EXPORT_VERSION)}`);
  // W604 regex pin so a future patch bump like 'w766-v2' still passes the
  // regex shape, but the literal pin is also locked above.
  assert.ok(/^w766-/.test(AI_ACT_RISK_VERSION),
    `AI_ACT_RISK_VERSION must match /^w766-/; got ${AI_ACT_RISK_VERSION}`);
  assert.ok(/^w766-/.test(AI_ACT_EXPORT_VERSION),
    `AI_ACT_EXPORT_VERSION must match /^w766-/; got ${AI_ACT_EXPORT_VERSION}`);
});

// =============================================================================
// 2) AI_ACT_RISK_CATEGORIES frozen + exactly 4 entries
// =============================================================================

test('W766 #2 — AI_ACT_RISK_CATEGORIES frozen + holds exactly 4 entries', () => {
  freshDir();
  assert.ok(Array.isArray(AI_ACT_RISK_CATEGORIES),
    'AI_ACT_RISK_CATEGORIES must be an array');
  assert.ok(Object.isFrozen(AI_ACT_RISK_CATEGORIES),
    'AI_ACT_RISK_CATEGORIES MUST be Object.freeze()-d so callers cannot mutate the contract');
  assert.equal(AI_ACT_RISK_CATEGORIES.length, 4,
    `expected 4 risk categories; got ${AI_ACT_RISK_CATEGORIES.length}`);
  for (const name of ['minimal', 'limited', 'high', 'unacceptable']) {
    assert.ok(AI_ACT_RISK_CATEGORIES.includes(name),
      `AI_ACT_RISK_CATEGORIES must include '${name}'; got ${JSON.stringify(AI_ACT_RISK_CATEGORIES)}`);
  }
});

// =============================================================================
// 3) AI_ACT_TASK_CATEGORY_MAP frozen + holds >=15 entries
// =============================================================================

test('W766 #3 — AI_ACT_TASK_CATEGORY_MAP frozen + holds >=15 entries', () => {
  freshDir();
  assert.ok(typeof AI_ACT_TASK_CATEGORY_MAP === 'object' && AI_ACT_TASK_CATEGORY_MAP != null,
    'AI_ACT_TASK_CATEGORY_MAP must be an object');
  assert.ok(Object.isFrozen(AI_ACT_TASK_CATEGORY_MAP),
    'AI_ACT_TASK_CATEGORY_MAP MUST be Object.freeze()-d so callers cannot mutate the contract');
  const keys = Object.keys(AI_ACT_TASK_CATEGORY_MAP);
  assert.ok(keys.length >= 15,
    `expected >=15 task-category entries; got ${keys.length}`);
  // Every value must be one of the four canonical risk categories.
  for (const k of keys) {
    const v = AI_ACT_TASK_CATEGORY_MAP[k];
    assert.ok(AI_ACT_RISK_CATEGORIES.includes(v),
      `AI_ACT_TASK_CATEGORY_MAP['${k}']='${v}' must be one of AI_ACT_RISK_CATEGORIES`);
  }
});

// =============================================================================
// 4) scoreArtifactRisk medical_diagnosis -> high
// =============================================================================

test('W766 #4 — scoreArtifactRisk(medical_diagnosis) -> high', () => {
  freshDir();
  const r = scoreArtifactRisk({ task_category: 'medical_diagnosis' });
  assert.equal(r.ok, true);
  assert.equal(r.risk_category, 'high');
  assert.equal(r.task_category, 'medical_diagnosis');
  assert.equal(r.human_oversight_required, true,
    'medical_diagnosis is high-risk -> Article 14 oversight required');
  assert.equal(r.conformity_assessment_required, true,
    'medical_diagnosis is high-risk -> Article 43 conformity required');
  assert.ok(Array.isArray(r.transparency_requirements) && r.transparency_requirements.length > 0,
    `high-risk must have transparency_requirements; got ${JSON.stringify(r.transparency_requirements)}`);
  assert.equal(r.version, 'w766-v1');
});

// =============================================================================
// 5) scoreArtifactRisk chatbot -> limited
// =============================================================================

test('W766 #5 — scoreArtifactRisk(chatbot) -> limited', () => {
  freshDir();
  const r = scoreArtifactRisk({ task_category: 'chatbot' });
  assert.equal(r.ok, true);
  assert.equal(r.risk_category, 'limited');
  assert.equal(r.human_oversight_required, false,
    'limited risk does NOT trigger Article 14 oversight');
  assert.equal(r.conformity_assessment_required, false,
    'limited risk does NOT trigger Article 43 conformity assessment');
});

// =============================================================================
// 6) scoreArtifactRisk code_completion -> minimal
// =============================================================================

test('W766 #6 — scoreArtifactRisk(code_completion) -> minimal', () => {
  freshDir();
  const r = scoreArtifactRisk({ task_category: 'code_completion' });
  assert.equal(r.ok, true);
  assert.equal(r.risk_category, 'minimal');
  assert.equal(r.human_oversight_required, false);
  assert.equal(r.conformity_assessment_required, false);
});

// =============================================================================
// 7) scoreArtifactRisk social_scoring -> unacceptable (Article 5 prohibition)
// =============================================================================

test('W766 #7 — scoreArtifactRisk(social_scoring) -> unacceptable (Article 5)', () => {
  freshDir();
  const r = scoreArtifactRisk({ task_category: 'social_scoring' });
  assert.equal(r.ok, true);
  assert.equal(r.risk_category, 'unacceptable');
  // Unacceptable systems are prohibited; conformity assessment is moot.
  assert.equal(r.conformity_assessment_required, false,
    'unacceptable -> prohibited -> NO conformity path available');
  const tr = r.transparency_requirements;
  assert.ok(tr.includes('system_prohibited_no_market_placement'),
    `unacceptable must include 'system_prohibited_no_market_placement' transparency claim; got ${JSON.stringify(tr)}`);
});

// =============================================================================
// 8) scoreArtifactRisk(empty manifest) -> 'minimal' floor (never null, never fabricated)
// =============================================================================

test('W766 #8 — scoreArtifactRisk(empty) -> minimal floor (HONESTY contract)', () => {
  freshDir();
  const r = scoreArtifactRisk({});
  assert.equal(r.ok, true,
    `empty manifest must still be ok:true (we floor to minimal); got ${JSON.stringify(r)}`);
  assert.equal(r.risk_category, 'minimal',
    'empty manifest -> minimal floor — NEVER null, NEVER fabricated');
  // Reasoning must explicitly say "no_task_category_matched" so a reader
  // knows the assignment is a floor, not an attestation.
  assert.ok(/no_task_category_matched/.test(r.reasoning),
    `reasoning must surface 'no_task_category_matched'; got ${JSON.stringify(r.reasoning)}`);
  assert.equal(r.version, 'w766-v1');
});

// =============================================================================
// 9) scoreArtifactRisk(invalid input) -> {ok:false} honest envelope
// =============================================================================

test('W766 #9 — scoreArtifactRisk(invalid input) -> honest {ok:false} envelope', () => {
  freshDir();
  for (const bad of [null, undefined, 42, 'foo', [], true]) {
    const r = scoreArtifactRisk(bad);
    assert.equal(r.ok, false,
      `expected ok:false for ${JSON.stringify(bad)}; got ${JSON.stringify(r)}`);
    assert.equal(r.error, 'invalid_manifest',
      `expected error 'invalid_manifest' for ${JSON.stringify(bad)}; got ${JSON.stringify(r)}`);
    assert.ok(typeof r.hint === 'string' && r.hint.length > 0,
      `expected non-empty hint for ${JSON.stringify(bad)}; got ${JSON.stringify(r)}`);
    assert.equal(r.version, 'w766-v1');
  }
});

// =============================================================================
// 10) classifyTaskCategory confidence caps at 0.95 (HONESTY)
// =============================================================================

test('W766 #10 — classifyTaskCategory confidence caps at 0.95 (HONESTY)', () => {
  freshDir();
  // Build an aggressively redundant signal that should multi-pattern hit.
  const text = 'medical clinical diagnosis radiology patient chart pneumonia detection';
  const r = classifyTaskCategory(text);
  assert.ok(r != null);
  assert.ok(r.confidence <= 0.95,
    `confidence MUST cap at 0.95 (honesty contract); got ${r.confidence}`);
  // Also exercise null/empty input.
  assert.equal(classifyTaskCategory(''), null);
  assert.equal(classifyTaskCategory(null), null);
  assert.equal(classifyTaskCategory(42), null);
  // No-match input should report key:null + confidence:0.
  const empty = classifyTaskCategory('lorem ipsum dolor sit amet');
  assert.ok(empty == null || (empty.key === null && empty.confidence === 0));
});

// =============================================================================
// 11) ANNEX_IV_FIELDS frozen + holds exactly 9 entries
// =============================================================================

test('W766 #11 — ANNEX_IV_FIELDS frozen + holds exactly 9 entries', () => {
  freshDir();
  assert.ok(Array.isArray(ANNEX_IV_FIELDS),
    'ANNEX_IV_FIELDS must be an array');
  assert.ok(Object.isFrozen(ANNEX_IV_FIELDS),
    'ANNEX_IV_FIELDS MUST be Object.freeze()-d so callers cannot mutate the contract');
  assert.equal(ANNEX_IV_FIELDS.length, 9,
    `expected 9 Annex IV fields; got ${ANNEX_IV_FIELDS.length}`);
  for (const name of [
    'intended_purpose',
    'system_architecture',
    'training_data_summary',
    'performance_metrics',
    'risk_management',
    'human_oversight_measures',
    'accuracy_metrics',
    'cybersecurity_measures',
    'postmarket_monitoring_plan',
  ]) {
    assert.ok(ANNEX_IV_FIELDS.includes(name),
      `ANNEX_IV_FIELDS must include '${name}'; got ${JSON.stringify(ANNEX_IV_FIELDS)}`);
  }
});

// =============================================================================
// 12) buildTechnicalDocumentation emits 'not_yet_disclosed' for absent fields
// =============================================================================

test("W766 #12 — buildTechnicalDocumentation emits 'not_yet_disclosed' for absent fields (HONESTY)", () => {
  freshDir();
  const env = buildTechnicalDocumentation({ task_category: 'chatbot' });
  assert.equal(env.ok, true);
  assert.equal(env.version, 'w766-v1');
  assert.ok(env.annex_iv, 'envelope must carry annex_iv block');
  // EVERY Annex IV field must be present in the envelope.
  for (const f of ANNEX_IV_FIELDS) {
    assert.ok(Object.prototype.hasOwnProperty.call(env.annex_iv, f),
      `annex_iv must carry key '${f}'`);
  }
  // At least one absent field must surface the honest placeholder.
  const undisclosed = ANNEX_IV_FIELDS.filter(
    (f) => env.annex_iv[f] === 'not_yet_disclosed');
  assert.ok(undisclosed.length >= 1,
    `expected >=1 'not_yet_disclosed' field for a minimal manifest; got ${JSON.stringify(env.annex_iv)}`);
  // Verify the literal string is used (HONESTY contract — not null, not undefined,
  // not "tbd", not empty string).
  for (const f of undisclosed) {
    assert.equal(env.annex_iv[f], 'not_yet_disclosed',
      `placeholder MUST be the literal string 'not_yet_disclosed'`);
  }
});

// =============================================================================
// 13) buildTechnicalDocumentation markdown format carries .markdown body
// =============================================================================

test('W766 #13 — buildTechnicalDocumentation(format:markdown) carries .markdown body', () => {
  freshDir();
  const env = buildTechnicalDocumentation(
    { task_category: 'medical_diagnosis', intended_purpose: 'radiology assist' },
    { format: 'markdown' },
  );
  assert.equal(env.ok, true);
  assert.equal(env.format, 'markdown');
  assert.ok(typeof env.markdown === 'string' && env.markdown.length > 0,
    `expected .markdown string body; got ${typeof env.markdown}`);
  assert.ok(/Annex IV/i.test(env.markdown),
    `markdown body must mention "Annex IV"; got ${env.markdown.slice(0, 200)}`);
  assert.ok(/risk[_ -]?category|medical_diagnosis|high/i.test(env.markdown),
    `markdown body must surface risk classification; got first 200 chars: ${env.markdown.slice(0, 200)}`);
});

// =============================================================================
// 14) buildGovernanceReport tenant-fences via per-row tenant_id re-check
//     (W411 defense-in-depth)
// =============================================================================

test('W766 #14 — buildGovernanceReport per-row tenant fence (W411 defense-in-depth)', async () => {
  freshDir();
  // Build a fake event-store with one matching tenant_id row + one "leak" row
  // that the QUERY filter accidentally returned but the LOOP body must reject.
  const fakeRows = [
    {
      tenant_id: 'tenant_A',
      namespace: 'ns_a',
      created_at: '2026-05-01T00:00:00Z',
      task_category: 'medical_diagnosis',
      provider: 'openai',
      confidence_at_decision: 0.92,
      human_in_loop_triggered: true,
    },
    // Leak row — query filter SHOULD reject this, but if it doesn't (future
    // schema bug), the per-row re-check inside buildGovernanceReport must.
    {
      tenant_id: 'tenant_OTHER',
      namespace: 'ns_other',
      created_at: '2026-05-02T00:00:00Z',
      task_category: 'chatbot',
      provider: 'openai',
    },
    // Routing-threshold marker — must be skipped (governance metadata, not capture).
    {
      tenant_id: 'tenant_A',
      namespace: 'ns_a',
      created_at: '2026-05-03T00:00:00Z',
      provider: 'kolm_routing_threshold',
    },
  ];
  const fakeEventStore = {
    async listEvents(_query) {
      return fakeRows;
    },
  };
  const env = await buildGovernanceReport({
    tenant_id: 'tenant_A',
    eventStore: fakeEventStore,
  });
  assert.equal(env.ok, true);
  assert.equal(env.report.tenant_id, 'tenant_A');
  // Per-row fence must reject tenant_OTHER even though listEvents returned it.
  assert.equal(env.report.count_total, 1,
    `expected count_total=1 (tenant_A capture only); got ${env.report.count_total} — leak row may have crossed the fence`);
  // The medical_diagnosis row triggers high-risk count.
  assert.equal(env.report.count_high_risk, 1,
    `expected count_high_risk=1; got ${env.report.count_high_risk}`);
  // Human-in-loop trigger surfaces.
  assert.equal(env.report.count_human_in_loop_triggered, 1,
    `expected count_human_in_loop_triggered=1; got ${env.report.count_human_in_loop_triggered}`);
  // Average confidence over 1 sample = 0.92.
  assert.ok(env.report.average_confidence_at_decision != null
    && Math.abs(env.report.average_confidence_at_decision - 0.92) < 1e-6,
    `expected average_confidence_at_decision ~= 0.92; got ${env.report.average_confidence_at_decision}`);
  // by_namespace must surface ns_a only.
  assert.equal(env.report.by_namespace.ns_a, 1,
    `expected by_namespace.ns_a=1; got ${JSON.stringify(env.report.by_namespace)}`);
  assert.ok(env.report.by_namespace.ns_other == null,
    `ns_other MUST NOT leak into the per-namespace bucket; got ${JSON.stringify(env.report.by_namespace)}`);
});

// =============================================================================
// 15) buildGovernanceReport({}) -> {ok:false, error:'tenant_required'}
// =============================================================================

test("W766 #15 — buildGovernanceReport without tenant_id -> {ok:false, error:'tenant_required'}", async () => {
  freshDir();
  const env = await buildGovernanceReport({});
  assert.equal(env.ok, false);
  assert.equal(env.error, 'tenant_required',
    `expected error 'tenant_required' when tenant_id is missing; got ${JSON.stringify(env)}`);
  assert.ok(typeof env.hint === 'string' && env.hint.length > 0);
  assert.equal(env.version, 'w766-v1');
});

// =============================================================================
// 16) humanInLoopConfig validates threshold ∈ [0, 10] nats
// =============================================================================

test('W766 #16 — humanInLoopConfig validates threshold ∈ [0, 10] nats', async () => {
  freshDir();
  // Build a fake event-store that records appendEvent calls.
  const appended = [];
  const fakeEventStore = {
    async appendEvent(partial) {
      appended.push(partial);
      return { event_id: 'evt_test_' + appended.length, created_at: new Date().toISOString() };
    },
    async listEvents() { return appended; },
  };
  // Out-of-range high.
  const tooHigh = await humanInLoopConfig({
    tenant_id: 'tenant_A',
    namespace: 'ns_a',
    threshold_nats: 99,
    eventStore: fakeEventStore,
  });
  assert.equal(tooHigh.ok, false);
  assert.equal(tooHigh.error, 'invalid_threshold');
  // Out-of-range low.
  const tooLow = await humanInLoopConfig({
    tenant_id: 'tenant_A',
    namespace: 'ns_a',
    threshold_nats: -1,
    eventStore: fakeEventStore,
  });
  assert.equal(tooLow.ok, false);
  assert.equal(tooLow.error, 'invalid_threshold');
  // Non-finite.
  const bad = await humanInLoopConfig({
    tenant_id: 'tenant_A',
    namespace: 'ns_a',
    threshold_nats: 'not_a_number',
    eventStore: fakeEventStore,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_threshold');
  // Missing namespace.
  const nons = await humanInLoopConfig({
    tenant_id: 'tenant_A',
    threshold_nats: 1.5,
    eventStore: fakeEventStore,
  });
  assert.equal(nons.ok, false);
  assert.equal(nons.error, 'namespace_required');
  // Missing tenant.
  const nont = await humanInLoopConfig({
    namespace: 'ns_a',
    threshold_nats: 1.5,
    eventStore: fakeEventStore,
  });
  assert.equal(nont.ok, false);
  assert.equal(nont.error, 'tenant_required');
  // Append must NEVER have fired during these refusals.
  assert.equal(appended.length, 0,
    `humanInLoopConfig MUST NOT persist on bad input; got ${appended.length} appends`);
});

// =============================================================================
// 17) humanInLoopConfig persists durable marker via event-store + getHumanInLoopThreshold reads it back
// =============================================================================

test('W766 #17 — humanInLoopConfig persists durable marker + getHumanInLoopThreshold reads back', async () => {
  freshDir();
  const appended = [];
  const fakeEventStore = {
    async appendEvent(partial) {
      const ev = {
        ...partial,
        event_id: 'evt_test_' + (appended.length + 1),
        created_at: new Date().toISOString(),
      };
      appended.push(ev);
      return ev;
    },
    async listEvents(q) {
      // Mirror the W411 contract — query filter PLUS we still get a per-row
      // re-check inside getHumanInLoopThreshold.
      return appended
        .filter((r) => (!q.tenant_id || r.tenant_id === q.tenant_id))
        .filter((r) => (!q.namespace || r.namespace === q.namespace))
        .filter((r) => (!q.provider || r.provider === q.provider))
        .reverse();
    },
  };
  const r = await humanInLoopConfig({
    tenant_id: 'tenant_A',
    namespace: 'ns_a',
    threshold_nats: 2.5,
    eventStore: fakeEventStore,
  });
  assert.equal(r.ok, true);
  assert.equal(r.threshold_nats, 2.5);
  assert.equal(r.namespace, 'ns_a');
  assert.equal(r.tenant_id, 'tenant_A');
  assert.equal(appended.length, 1,
    'one appendEvent must have fired');
  assert.equal(appended[0].provider, 'kolm_human_review_threshold',
    `must use a distinct provider tag (NOT 'kolm_routing_threshold' which is W709); got ${appended[0].provider}`);
  // Read back.
  const back = await getHumanInLoopThreshold({
    tenant_id: 'tenant_A',
    namespace: 'ns_a',
    eventStore: fakeEventStore,
  });
  assert.equal(back, 2.5,
    `getHumanInLoopThreshold must return the most recent value; got ${back}`);
  // Per-row tenant fence — wrong tenant returns null even if same namespace.
  const wrong = await getHumanInLoopThreshold({
    tenant_id: 'tenant_OTHER',
    namespace: 'ns_a',
    eventStore: fakeEventStore,
  });
  assert.equal(wrong, null,
    'cross-tenant read MUST return null (per-row tenant fence)');
});

// =============================================================================
// 18) POST /v1/compliance/ai-act/risk-score 401 w/o auth; 200 envelope on auth
// =============================================================================

test('W766 #18 — POST /v1/compliance/ai-act/risk-score 401 w/o auth; 200 envelope on auth', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
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

    // No auth -> 401.
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/compliance/ai-act/risk-score`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: { task_category: 'medical_diagnosis' } }),
    });
    assert.equal(noAuth.status, 401, `expected 401 without auth; got ${noAuth.status}`);

    // Auth -> 200 envelope.
    const ok = await fetch(`http://127.0.0.1:${port}/v1/compliance/ai-act/risk-score`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ manifest: { task_category: 'medical_diagnosis' } }),
    });
    assert.equal(ok.status, 200, `expected 200 with auth; got ${ok.status}`);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.equal(env.risk_category, 'high');
    assert.equal(env.version, 'w766-v1');
  } finally {
    await new Promise((r) => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 19) POST /v1/compliance/ai-act/export 401 w/o auth; 200 envelope on auth
// =============================================================================

test('W766 #19 — POST /v1/compliance/ai-act/export 401 w/o auth; 200 envelope on auth', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
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

    // No auth -> 401.
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/compliance/ai-act/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: { task_category: 'chatbot' } }),
    });
    assert.equal(noAuth.status, 401, `expected 401 without auth; got ${noAuth.status}`);

    // Auth + bad manifest shape -> 400.
    const badShape = await fetch(`http://127.0.0.1:${port}/v1/compliance/ai-act/export`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({}),
    });
    assert.equal(badShape.status, 400, `expected 400 without manifest; got ${badShape.status}`);

    // Auth + manifest -> 200 envelope with Annex IV fields.
    const ok = await fetch(`http://127.0.0.1:${port}/v1/compliance/ai-act/export`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({
        manifest: { task_category: 'chatbot', intended_purpose: 'customer support' },
      }),
    });
    assert.equal(ok.status, 200);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.equal(env.version, 'w766-v1');
    assert.ok(env.annex_iv);
    assert.ok(env.risk_assessment);
    assert.equal(env.risk_assessment.risk_category, 'limited');
  } finally {
    await new Promise((r) => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 20) POST /v1/compliance/ai-act/human-in-loop auth + confirm gates
// =============================================================================

test('W766 #20 — POST /v1/compliance/ai-act/human-in-loop auth + confirm gates', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
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

    // No auth -> 401.
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/compliance/ai-act/human-in-loop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: 'ns_x', threshold_nats: 2.5, confirm: true }),
    });
    assert.equal(noAuth.status, 401, `expected 401 without auth; got ${noAuth.status}`);

    // Auth, no confirm -> 400 confirm_required.
    const noConfirm = await fetch(`http://127.0.0.1:${port}/v1/compliance/ai-act/human-in-loop`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ namespace: 'ns_x', threshold_nats: 2.5 }),
    });
    assert.equal(noConfirm.status, 400, `no confirm must 400; got ${noConfirm.status}`);
    const noConfirmEnv = await noConfirm.json();
    assert.equal(noConfirmEnv.error, 'confirm_required');

    // Auth + confirm + valid threshold -> 200 envelope.
    const ok = await fetch(`http://127.0.0.1:${port}/v1/compliance/ai-act/human-in-loop`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ namespace: 'ns_x', threshold_nats: 2.5, confirm: true }),
    });
    assert.equal(ok.status, 200, `expected 200; got ${ok.status}`);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.equal(env.namespace, 'ns_x');
    assert.equal(env.threshold_nats, 2.5);
    assert.equal(env.version, 'w766-v1');

    // Auth + confirm + out-of-range -> 400 honest envelope.
    const oob = await fetch(`http://127.0.0.1:${port}/v1/compliance/ai-act/human-in-loop`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ namespace: 'ns_x', threshold_nats: 99, confirm: true }),
    });
    assert.equal(oob.status, 400, `out-of-range threshold must 400; got ${oob.status}`);
    const oobEnv = await oob.json();
    assert.equal(oobEnv.error, 'invalid_threshold');
  } finally {
    await new Promise((r) => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 21) GET /v1/compliance/ai-act/governance-report 401 w/o auth; 200 on auth
// =============================================================================

test('W766 #21 — GET /v1/compliance/ai-act/governance-report 401 w/o auth; 200 on auth', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
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

    // No auth -> 401.
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/compliance/ai-act/governance-report`);
    assert.equal(noAuth.status, 401, `expected 401 without auth; got ${noAuth.status}`);

    // Auth -> 200 envelope (zero captures is the honest happy path).
    const ok = await fetch(`http://127.0.0.1:${port}/v1/compliance/ai-act/governance-report`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(ok.status, 200, `expected 200 with auth; got ${ok.status}`);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.equal(env.version, 'w766-v1');
    assert.ok(env.report);
    assert.equal(typeof env.report.count_total, 'number');
    assert.equal(typeof env.report.count_high_risk, 'number');
    assert.equal(typeof env.report.count_human_in_loop_triggered, 'number');
  } finally {
    await new Promise((r) => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 22) public/compliance/eu-ai-act.html exists w/ brand-lock + anchors
// =============================================================================

test('W766 #22 — public/compliance/eu-ai-act.html exists w/ brand-lock + anchors', () => {
  freshDir();
  assert.ok(fs.existsSync(HTML_PATH), `expected page at ${HTML_PATH}`);
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  // Brand lock.
  assert.ok(html.includes('Open-source AI workbench'),
    'eu-ai-act.html MUST carry the brand-locked eyebrow');
  // Anti-collision (Kolm therapeutics is a wholly unrelated entity).
  assert.ok(/Not\s+Kolm\s+therapeutics/i.test(html),
    'eu-ai-act.html MUST carry a "Not Kolm therapeutics" anti-collision line');
  // Required hidden test anchors (one per W766 sub-item that has a UI surface).
  for (const a of [
    'data-w766="risk-classification"',
    'data-w766="technical-documentation"',
    'data-w766="human-in-loop"',
    'data-w766="governance-report"',
  ]) {
    assert.ok(html.includes(a),
      `eu-ai-act.html missing required anchor: ${a}`);
  }
  // Version stamp.
  assert.ok(html.includes('w766-v1'),
    'page must stamp the w766-v1 version');
  // No emoji glyphs.
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}]/u;
  assert.equal(emojiRe.test(html), false,
    'compliance/eu-ai-act.html MUST NOT contain emojis (spec invariant)');
});

// =============================================================================
// 23) cli/kolm.js defines cmdW766AiAct exactly once + wired from case 'ai-act'
// =============================================================================

test("W766 #23 — cli/kolm.js defines cmdW766AiAct exactly once + wired from case 'ai-act'", () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const defOccurrences = (cli.match(/async function cmdW766AiAct\b/g) || []).length;
  assert.equal(defOccurrences, 1,
    `cmdW766AiAct must be defined exactly once; found ${defOccurrences}`);
  // case 'ai-act' must invoke cmdW766AiAct.
  assert.ok(/case 'ai-act':[\s\S]{0,300}cmdW766AiAct/.test(cli),
    `expected "case 'ai-act': ... cmdW766AiAct(...)" wiring; not found`);
  // No-hyphen alias.
  assert.ok(/case 'aiact':[\s\S]{0,300}cmdW766AiAct/.test(cli),
    `expected "case 'aiact': ... cmdW766AiAct(...)" wiring; not found`);
  // Completion table entries.
  assert.ok(cli.includes("COMPLETION_VERBS.push('ai-act'"),
    `COMPLETION_VERBS must include 'ai-act' for shell completion`);
  assert.ok(cli.includes("COMPLETION_SUBS['ai-act']"),
    `COMPLETION_SUBS['ai-act'] must list the subcommands`);
});

// =============================================================================
// 24) vercel.json carries /compliance/eu-ai-act rewrite
// =============================================================================

test('W766 #24 — vercel.json carries /compliance/eu-ai-act rewrite', () => {
  freshDir();
  const raw = fs.readFileSync(VERCEL_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  assert.ok(Array.isArray(cfg.rewrites), 'vercel.json must have a rewrites array');
  const rw = cfg.rewrites.find((r) =>
    r && r.source === '/compliance/eu-ai-act' &&
    r.destination === '/compliance/eu-ai-act.html');
  assert.ok(rw,
    `expected rewrite { source: '/compliance/eu-ai-act', destination: '/compliance/eu-ai-act.html' }; ` +
    `not found in ${cfg.rewrites.length} entries`);
});

// =============================================================================
// 25) apps/export/ai_act_docs.py exists + is stdlib-only
// =============================================================================

test('W766 #25 — apps/export/ai_act_docs.py exists + is stdlib-only (no third-party imports)', () => {
  freshDir();
  assert.ok(fs.existsSync(PY_PATH), `expected ${PY_PATH}`);
  const py = fs.readFileSync(PY_PATH, 'utf8');
  // Stamp version.
  assert.ok(/w766-v1/.test(py),
    'apps/export/ai_act_docs.py must carry the w766-v1 version stamp');
  // CLI entrypoint.
  assert.ok(/if\s+__name__\s*==\s*['"]__main__['"]/.test(py),
    'apps/export/ai_act_docs.py must have a __main__ guard so it is CLI-runnable');
  // Stdlib-only — no `import requests`, `from anthropic`, `pip`, etc.
  const banned = /^\s*(?:import|from)\s+(requests|httpx|openai|anthropic|pydantic|numpy|pandas|torch|sklearn|jinja2|yaml|toml)\b/m;
  assert.equal(banned.test(py), false,
    `apps/export/ai_act_docs.py MUST be stdlib-only (no third-party deps); matched: ${(py.match(banned) || [''])[0]}`);
  // Catalog keys present.
  for (const k of ['unacceptable', 'high', 'limited', 'minimal']) {
    assert.ok(py.includes(k),
      `apps/export/ai_act_docs.py missing risk category '${k}'`);
  }
});

// =============================================================================
// 26) Sibling sw.js / test family pattern uses regex + threshold (W604)
// =============================================================================

test('W766 #26 — sw.js + sibling test family use wave(\\d{3,4}) regex+threshold (W604)', () => {
  freshDir();
  // sw.js may be present in the public/ tree; if so we sanity-check its slug
  // is a wave token, but we do NOT pin a specific wave number.
  if (fs.existsSync(SW_PATH)) {
    const sw = fs.readFileSync(SW_PATH, 'utf8');
    const m = sw.match(/CACHE\s*=\s*['"]([^'"]+)['"]/);
    if (m) {
      const wm = m[1].match(/wave(\d{3,4})/);
      if (wm) {
        const n = parseInt(wm[1], 10);
        assert.ok(n >= 100,
          `sw.js CACHE slug should reference a sane waveNNN family token; got ${m[1]}`);
      }
    }
  }
  // Sibling test count uses regex + numeric threshold (never a hard-coded
  // explicit array — W604 anti-brittleness, lesson re-iterated in W604/W604
  // memory entries).
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  assert.ok(siblings.length >= 5,
    `expected >=5 wave(\\d{3,4}) test files; found ${siblings.length}`);
  // Confirm at least one sibling matches a sane W76x band so the family token
  // is the right kind of token (not, say, "wave001-some-legacy.test.js" only).
  const inBand = siblings
    .map((name) => parseInt((name.match(re) || [])[1] || '0', 10))
    .filter((n) => n >= 700);
  assert.ok(inBand.length >= 1,
    `expected >=1 wave>=700 sibling; got ${JSON.stringify(siblings.slice(0, 10))}`);
});
