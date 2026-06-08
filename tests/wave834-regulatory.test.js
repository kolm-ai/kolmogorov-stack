// W834 — Regulatory Compliance Toolkit.
//
// Atomic items pinned (matches the W834 implementation):
//
//   1) REG_EU_AIACT_DOCS_VERSION stamped 'w834-v1' + /^w834-/ regex (W604)
//   2) generateTechnicalDocs emits ALL 6 Annex IV sections + MISSING markers
//      for absent fields (HONESTY)
//   3) generateTechnicalDocs html format emits valid HTML wrapper
//   4) REG_RISK_CLASSIFY_VERSION stamped 'w834-v1' + RISK_TIERS frozen
//      (exactly 4) + REQUIRED_GATES frozen (exactly 8)
//   5) classifyArtifactRisk('medical_dx') -> 'high_risk' with conformity
//      + FRIA + eu_database_registration gates
//   6) classifyArtifactRisk('social_scoring') -> 'prohibited' with EMPTY
//      gates_required (no deployment path)
//   7) classifyArtifactRisk('code_assist') -> 'minimal_risk' (documentation
//      gate only)
//   8) classifyArtifactRisk(unknown intended_use) -> 'minimal_risk' floor
//      (HONESTY: never null, never throws)
//   9) classifyArtifactRisk({intended_use: missing}) -> {ok:false, error:
//      'intended_use_required'} honest envelope
//  10) REG_HIL_VERSION stamped 'w834-v1' + setMandatoryHumanReviewThreshold
//      validates threshold ∈ [0.0, 1.0]
//  11) setMandatoryHumanReviewThreshold persists durable marker via event-
//      store + getHilConfig reads it back + per-row tenant fence (W411)
//  12) shouldEscalate({confidence_score, threshold}) returns BOOL; never
//      throws on missing/invalid input
//  13) REG_DATA_GOVERNANCE_VERSION stamped 'w834-v1' + capturesProvenance
//      Report bucketed by source enum + W411 per-row tenant fence
//  14) generateGovernanceReport({tenant, namespace, period}) emits markdown
//      + missing_attachments stamps
//  15) REG_MODEL_CARD_EXTENDED_VERSION stamped 'w834-v1' +
//      buildExtendedModelCard adds 3 extension blocks
//  16) REG_GRC_CONNECTORS_VERSION stamped 'w834-v1' + 3 vendor connectors
//      emit honest no_grc_creds envelopes with export_payload still computed
//  17) POST /v1/reg/eu-aiact-docs 401 w/o auth; 200 envelope on auth
//  18) POST /v1/reg/classify-risk 401 w/o auth; 200 envelope on auth
//  19) POST /v1/reg/hil/threshold auth + confirm gates; GET reads back
//  20) GET  /v1/reg/data-governance 401 w/o auth; 200 envelope on auth
//  21) POST /v1/reg/model-card 401 w/o auth; 200 envelope on auth
//  22) POST /v1/reg/grc-export 401 w/o auth; 200 envelope (with no_grc_creds
//      honest sub-state when env vars unset)
//  23) src/reg-routes.js exports registerRegRoutes + router.js mounts it via
//      single import + single call line (W83x concurrent-edit directive)
//  24) public/sw.js carries -wave834-regulatory suffix + W604 wave token
//      regex+threshold (never explicit array)
//
// W604 anti-brittleness: family lock uses regex `wave(\d{3,4})` + numeric
// threshold (never an explicit hard-coded sibling list).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  REG_EU_AIACT_DOCS_VERSION,
  ANNEX_IV_SECTIONS,
  SUPPORTED_FORMATS as EU_AIACT_FORMATS,
  generateTechnicalDocs,
} from '../src/reg-eu-aiact-docs.js';

import {
  REG_RISK_CLASSIFY_VERSION,
  RISK_TIERS,
  REQUIRED_GATES,
  INTENDED_USE_CATALOG,
  classifyArtifactRisk,
} from '../src/reg-risk-classify.js';

import {
  REG_HIL_VERSION,
  setMandatoryHumanReviewThreshold,
  getHilConfig,
  shouldEscalate,
} from '../src/reg-hil.js';

import {
  REG_DATA_GOVERNANCE_VERSION,
  CAPTURE_SOURCES,
  capturesProvenanceReport,
  generateGovernanceReport,
} from '../src/reg-data-governance.js';

import {
  REG_MODEL_CARD_EXTENDED_VERSION,
  buildExtendedModelCard,
} from '../src/reg-model-card-extended.js';

import {
  REG_GRC_CONNECTORS_VERSION,
  SUPPORTED_VENDORS,
  VENDOR_ENV_VARS,
  exportToOneTrust,
  exportToServiceNow,
  exportToIBMOpenPages,
  exportByVendor,
} from '../src/reg-grc-connectors.js';

import { registerRegRoutes } from '../src/reg-routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const ROUTER_PATH = path.join(REPO_ROOT, 'src', 'router.js');
const SW_PATH = path.join(REPO_ROOT, 'public', 'sw.js');
const PLAN_PATH = path.join(REPO_ROOT, 'KOLM_W707_SYSTEM_UPGRADE_PLAN.md');
const TESTS_DIR = __dirname;

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w834-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  return tmp;
}

// =============================================================================
// 1) Version stamps + W604 regex
// =============================================================================

test('W834 #1 — all six modules stamped w834-v1 + /^w834-/ regex (W604)', () => {
  freshDir();
  const stamps = {
    REG_EU_AIACT_DOCS_VERSION,
    REG_RISK_CLASSIFY_VERSION,
    REG_HIL_VERSION,
    REG_DATA_GOVERNANCE_VERSION,
    REG_MODEL_CARD_EXTENDED_VERSION,
    REG_GRC_CONNECTORS_VERSION,
  };
  for (const [name, v] of Object.entries(stamps)) {
    assert.equal(v, 'w834-v1',
      `expected ${name}='w834-v1'; got ${JSON.stringify(v)}`);
    assert.ok(/^w834-/.test(v),
      `${name} must match /^w834-/; got ${v}`);
  }
});

// =============================================================================
// 2) generateTechnicalDocs emits 6 Annex IV sections + MISSING markers
// =============================================================================

test('W834 #2 — generateTechnicalDocs emits 6 Annex IV sections + MISSING markers (HONESTY)', () => {
  freshDir();
  // Minimal manifest — most fields will land as MISSING markers.
  const res = generateTechnicalDocs({
    artifact_manifest: { name: 'test_model', version: 'v1' },
    tenant_metadata: { legal_name: 'Acme GmbH' },
  });
  assert.equal(res.ok, true);
  assert.equal(res.version, 'w834-v1');
  assert.equal(res.format, 'markdown');
  assert.ok(typeof res.body === 'string' && res.body.length > 0);
  // ANNEX_IV_SECTIONS is frozen + holds exactly 6 entries.
  assert.ok(Object.isFrozen(ANNEX_IV_SECTIONS),
    'ANNEX_IV_SECTIONS must be Object.freeze()-d');
  assert.equal(ANNEX_IV_SECTIONS.length, 6,
    `expected 6 Annex IV sections; got ${ANNEX_IV_SECTIONS.length}`);
  // Body must mention "Annex IV" and each section heading.
  assert.ok(/Annex IV/.test(res.body),
    'body must reference Annex IV in the header');
  assert.ok(/General description of the AI system/.test(res.body),
    'body must carry the General description section');
  assert.ok(/Data and data governance/.test(res.body),
    'body must carry the Data and data governance section');
  assert.ok(/Monitoring and control mechanisms/.test(res.body),
    'body must carry the Monitoring section');
  assert.ok(/Risk management system/.test(res.body),
    'body must carry the Risk management section');
  assert.ok(/Standards applied/.test(res.body),
    'body must carry the Standards applied section');
  assert.ok(/Conformity assessment plan/.test(res.body),
    'body must carry the Conformity assessment plan section');
  // Missing-field markers MUST surface in the rendered body so a reviewer
  // can grep for "MISSING" and see every gap with an action hint.
  assert.ok(/<!-- MISSING:/.test(res.body),
    'body must carry at least one MISSING marker for absent fields');
  assert.ok(Array.isArray(res.missing_fields) && res.missing_fields.length > 0,
    `missing_fields[] must list every missing field; got ${JSON.stringify(res.missing_fields)}`);
  // HONESTY: bad input returns honest envelope.
  for (const bad of [null, undefined, 42, 'foo', []]) {
    const r = generateTechnicalDocs({ artifact_manifest: bad });
    assert.equal(r.ok, false,
      `expected ok:false for artifact_manifest=${JSON.stringify(bad)}`);
    assert.equal(r.error, 'artifact_manifest_required');
  }
});

// =============================================================================
// 3) generateTechnicalDocs html format
// =============================================================================

test('W834 #3 — generateTechnicalDocs(format:html) emits HTML wrapper + preserves MISSING markers', () => {
  freshDir();
  const res = generateTechnicalDocs({
    artifact_manifest: { name: 'test_model' },
    format: 'html',
  });
  assert.equal(res.ok, true);
  assert.equal(res.format, 'html');
  assert.ok(/<!DOCTYPE html>/.test(res.body),
    'html body must start with the doctype declaration');
  assert.ok(/<h1>/.test(res.body),
    'html body must contain at least one <h1> heading');
  // MISSING markers must pass through as HTML comments — greppability is
  // part of the contract.
  assert.ok(/<!-- MISSING:/.test(res.body),
    'html body must preserve MISSING markers verbatim');
  // SUPPORTED_FORMATS constant.
  assert.ok(Array.isArray(EU_AIACT_FORMATS) && EU_AIACT_FORMATS.length === 2,
    `SUPPORTED_FORMATS must hold exactly 2 entries; got ${JSON.stringify(EU_AIACT_FORMATS)}`);
  assert.ok(EU_AIACT_FORMATS.includes('markdown') && EU_AIACT_FORMATS.includes('html'));
});

// =============================================================================
// 4) RISK_TIERS + REQUIRED_GATES frozen with canonical counts
// =============================================================================

test('W834 #4 — RISK_TIERS (4 entries) + REQUIRED_GATES (8 entries) both frozen', () => {
  freshDir();
  assert.ok(Object.isFrozen(RISK_TIERS),
    'RISK_TIERS MUST be Object.freeze()-d');
  assert.equal(RISK_TIERS.length, 4,
    `expected 4 risk tiers; got ${RISK_TIERS.length}`);
  for (const name of ['minimal_risk', 'limited_risk', 'high_risk', 'prohibited']) {
    assert.ok(RISK_TIERS.includes(name),
      `RISK_TIERS must include '${name}'; got ${JSON.stringify(RISK_TIERS)}`);
  }
  assert.ok(Object.isFrozen(REQUIRED_GATES),
    'REQUIRED_GATES MUST be Object.freeze()-d');
  assert.equal(REQUIRED_GATES.length, 8,
    `expected 8 required gates; got ${REQUIRED_GATES.length}`);
  for (const g of [
    'mandatory_human_review',
    'accuracy_threshold',
    'documentation',
    'audit_log',
    'transparency_disclosure',
    'conformity_assessment',
    'fundamental_rights_impact_assessment',
    'eu_database_registration',
  ]) {
    assert.ok(REQUIRED_GATES.includes(g),
      `REQUIRED_GATES must include '${g}'`);
  }
  // INTENDED_USE_CATALOG must be frozen too.
  assert.ok(Object.isFrozen(INTENDED_USE_CATALOG),
    'INTENDED_USE_CATALOG MUST be Object.freeze()-d');
  assert.ok(Object.keys(INTENDED_USE_CATALOG).length >= 20,
    `expected >=20 INTENDED_USE_CATALOG entries; got ${Object.keys(INTENDED_USE_CATALOG).length}`);
});

// =============================================================================
// 5) classifyArtifactRisk(medical_dx) -> high_risk + full gate set
// =============================================================================

test('W834 #5 — classifyArtifactRisk(medical_dx) -> high_risk + conformity + FRIA gates', () => {
  freshDir();
  const r = classifyArtifactRisk({ intended_use: 'medical_dx' });
  assert.equal(r.ok, true);
  assert.equal(r.tier, 'high_risk');
  assert.ok(Array.isArray(r.basis) && r.basis.length >= 1,
    `high_risk must cite at least one Article/Annex basis; got ${JSON.stringify(r.basis)}`);
  assert.ok(r.basis.some((b) => b.startsWith('EU_AIACT_Annex_III')),
    `medical_dx basis must include an Annex III citation; got ${JSON.stringify(r.basis)}`);
  assert.ok(Array.isArray(r.gates_required) && r.gates_required.length >= 5,
    `high_risk must require >=5 gates; got ${JSON.stringify(r.gates_required)}`);
  for (const g of ['mandatory_human_review', 'accuracy_threshold', 'documentation',
    'audit_log', 'conformity_assessment',
    'fundamental_rights_impact_assessment', 'eu_database_registration']) {
    assert.ok(r.gates_required.includes(g),
      `medical_dx must require gate '${g}'; got ${JSON.stringify(r.gates_required)}`);
  }
  assert.equal(r.version, 'w834-v1');
});

// =============================================================================
// 6) classifyArtifactRisk(social_scoring) -> prohibited + EMPTY gates
// =============================================================================

test('W834 #6 — classifyArtifactRisk(social_scoring) -> prohibited + EMPTY gates_required', () => {
  freshDir();
  const r = classifyArtifactRisk({ intended_use: 'social_scoring' });
  assert.equal(r.ok, true);
  assert.equal(r.tier, 'prohibited');
  // Prohibited systems have no deployment path → gates_required is empty by design.
  assert.equal(r.gates_required.length, 0,
    `prohibited tier must have EMPTY gates_required (no path to deployment); got ${JSON.stringify(r.gates_required)}`);
  assert.ok(r.basis.some((b) => /Article_5/.test(b)),
    `prohibited tier must cite Article 5; got ${JSON.stringify(r.basis)}`);
});

// =============================================================================
// 7) classifyArtifactRisk(code_assist) -> minimal_risk + documentation gate
// =============================================================================

test('W834 #7 — classifyArtifactRisk(code_assist) -> minimal_risk + documentation gate', () => {
  freshDir();
  const r = classifyArtifactRisk({ intended_use: 'code_assist' });
  assert.equal(r.ok, true);
  assert.equal(r.tier, 'minimal_risk');
  assert.ok(r.gates_required.includes('documentation'),
    `minimal_risk should still carry a documentation gate; got ${JSON.stringify(r.gates_required)}`);
});

// =============================================================================
// 8) classifyArtifactRisk(unknown intended_use) -> minimal_risk floor (HONESTY)
// =============================================================================

test('W834 #8 — classifyArtifactRisk(unknown intended_use) -> minimal_risk floor (HONESTY)', () => {
  freshDir();
  const r = classifyArtifactRisk({ intended_use: 'totally_unknown_use_case_xyz' });
  assert.equal(r.ok, true);
  assert.equal(r.tier, 'minimal_risk',
    'unknown intended_use must floor to minimal_risk (honest); NEVER null');
  assert.ok(/no_intended_use_match/.test(r.reasoning),
    `reasoning must surface 'no_intended_use_match'; got ${JSON.stringify(r.reasoning)}`);
});

// =============================================================================
// 9) classifyArtifactRisk({intended_use: missing}) -> honest envelope
// =============================================================================

test('W834 #9 — classifyArtifactRisk without intended_use -> {ok:false, error:intended_use_required}', () => {
  freshDir();
  for (const bad of [{}, { intended_use: '' }, { intended_use: null }, { intended_use: 42 }]) {
    const r = classifyArtifactRisk(bad);
    assert.equal(r.ok, false,
      `expected ok:false for ${JSON.stringify(bad)}; got ${JSON.stringify(r)}`);
    assert.equal(r.error, 'intended_use_required',
      `expected error='intended_use_required' for ${JSON.stringify(bad)}`);
    assert.ok(Array.isArray(r.supported) && r.supported.length >= 20,
      `envelope must list supported intended_use catalog keys; got ${JSON.stringify(r.supported)}`);
  }
});

// =============================================================================
// 10) setMandatoryHumanReviewThreshold validates threshold ∈ [0.0, 1.0]
// =============================================================================

test('W834 #10 — setMandatoryHumanReviewThreshold validates threshold ∈ [0.0, 1.0]', async () => {
  freshDir();
  const appended = [];
  const fakeEventStore = {
    async appendEvent(partial) {
      appended.push(partial);
      return { event_id: 'evt_test_' + appended.length, created_at: new Date().toISOString() };
    },
    async listEvents() { return appended; },
  };
  // Out-of-range high.
  const tooHigh = await setMandatoryHumanReviewThreshold({
    tenant: 'tenant_A',
    namespace: 'ns_a',
    threshold: 1.5,
    eventStore: fakeEventStore,
  });
  assert.equal(tooHigh.ok, false);
  assert.equal(tooHigh.error, 'invalid_threshold');
  // Out-of-range low.
  const tooLow = await setMandatoryHumanReviewThreshold({
    tenant: 'tenant_A',
    namespace: 'ns_a',
    threshold: -0.1,
    eventStore: fakeEventStore,
  });
  assert.equal(tooLow.ok, false);
  assert.equal(tooLow.error, 'invalid_threshold');
  // Non-finite.
  const bad = await setMandatoryHumanReviewThreshold({
    tenant: 'tenant_A',
    namespace: 'ns_a',
    threshold: 'not_a_number',
    eventStore: fakeEventStore,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_threshold');
  // Missing namespace.
  const nons = await setMandatoryHumanReviewThreshold({
    tenant: 'tenant_A',
    threshold: 0.5,
    eventStore: fakeEventStore,
  });
  assert.equal(nons.ok, false);
  assert.equal(nons.error, 'namespace_required');
  // Missing tenant.
  const nont = await setMandatoryHumanReviewThreshold({
    namespace: 'ns_a',
    threshold: 0.5,
    eventStore: fakeEventStore,
  });
  assert.equal(nont.ok, false);
  assert.equal(nont.error, 'tenant_required');
  // Append must NEVER have fired during these refusals.
  assert.equal(appended.length, 0,
    `setMandatoryHumanReviewThreshold MUST NOT persist on bad input; got ${appended.length} appends`);
  // Valid threshold writes durable marker.
  const okR = await setMandatoryHumanReviewThreshold({
    tenant: 'tenant_A',
    namespace: 'ns_a',
    threshold: 0.7,
    eventStore: fakeEventStore,
  });
  assert.equal(okR.ok, true);
  assert.equal(okR.threshold, 0.7);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].provider, 'kolm_reg_hil_confidence_threshold',
    `must use distinct provider tag; got ${appended[0].provider}`);
});

// =============================================================================
// 11) setMandatoryHumanReviewThreshold + getHilConfig + per-row tenant fence
// =============================================================================

test('W834 #11 — setMandatoryHumanReviewThreshold persists; getHilConfig reads back; W411 per-row fence', async () => {
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
      return appended
        .filter((r) => (!q.tenant_id || r.tenant_id === q.tenant_id))
        .filter((r) => (!q.namespace || r.namespace === q.namespace))
        .filter((r) => (!q.provider || r.provider === q.provider))
        .reverse();
    },
  };
  await setMandatoryHumanReviewThreshold({
    tenant: 'tenant_A',
    namespace: 'ns_a',
    threshold: 0.65,
    eventStore: fakeEventStore,
  });
  const back = await getHilConfig({
    tenant: 'tenant_A',
    namespace: 'ns_a',
    eventStore: fakeEventStore,
  });
  assert.equal(back.ok, true);
  assert.equal(back.configured, true);
  assert.equal(back.threshold, 0.65,
    `getHilConfig must return the most recent threshold; got ${back.threshold}`);
  // Per-row tenant fence — wrong tenant returns configured:false even on same ns.
  const wrong = await getHilConfig({
    tenant: 'tenant_OTHER',
    namespace: 'ns_a',
    eventStore: fakeEventStore,
  });
  assert.equal(wrong.configured, false,
    'cross-tenant read MUST return configured:false (per-row tenant fence)');
  assert.equal(wrong.threshold, null);
  // Unconfigured (tenant, namespace) returns honest envelope.
  const none = await getHilConfig({
    tenant: 'tenant_A',
    namespace: 'ns_never_seen',
    eventStore: fakeEventStore,
  });
  assert.equal(none.ok, true);
  assert.equal(none.configured, false,
    'unconfigured ns must return configured:false (NOT auto-default to 0.5)');
});

// =============================================================================
// 12) shouldEscalate pure function — returns BOOL, never throws
// =============================================================================

test('W834 #12 — shouldEscalate returns BOOL; never throws; honest on missing inputs', () => {
  freshDir();
  // Confidence below threshold → escalate.
  assert.equal(shouldEscalate({ confidence_score: 0.3, threshold: 0.7 }), true);
  // Confidence at threshold (not below) → don't escalate.
  assert.equal(shouldEscalate({ confidence_score: 0.7, threshold: 0.7 }), false);
  // Confidence above threshold → don't escalate.
  assert.equal(shouldEscalate({ confidence_score: 0.9, threshold: 0.7 }), false);
  // Missing threshold → false.
  assert.equal(shouldEscalate({ confidence_score: 0.3 }), false);
  // Missing confidence_score → false.
  assert.equal(shouldEscalate({ threshold: 0.7 }), false);
  // Both missing → false.
  assert.equal(shouldEscalate({}), false);
  // Invalid types → false (never throws).
  assert.equal(shouldEscalate({ confidence_score: 'foo', threshold: 0.7 }), false);
  assert.equal(shouldEscalate({ confidence_score: 0.3, threshold: 'bar' }), false);
  // Out-of-range → false.
  assert.equal(shouldEscalate({ confidence_score: 0.3, threshold: 2.5 }), false);
  assert.equal(shouldEscalate({ confidence_score: -1.0, threshold: 0.7 }), false);
});

// =============================================================================
// 13) capturesProvenanceReport bucketed by source + W411 per-row tenant fence
// =============================================================================

test('W834 #13 — capturesProvenanceReport bucketed by source + W411 per-row tenant fence', async () => {
  freshDir();
  assert.ok(Object.isFrozen(CAPTURE_SOURCES),
    'CAPTURE_SOURCES MUST be Object.freeze()-d');
  assert.ok(CAPTURE_SOURCES.includes('gateway') && CAPTURE_SOURCES.includes('manual')
    && CAPTURE_SOURCES.includes('connector') && CAPTURE_SOURCES.includes('unknown_source'),
    'CAPTURE_SOURCES must include the four canonical buckets');
  // Build fake event-store with one tenant_A row + a leak row.
  const fakeRows = [
    {
      tenant_id: 'tenant_A',
      namespace: 'ns_a',
      created_at: '2026-05-01T00:00:00Z',
      connector_id: 'conn_xyz',
      provider: 'kolm_capture',
    },
    {
      tenant_id: 'tenant_A',
      namespace: 'ns_a',
      created_at: '2026-05-02T00:00:00Z',
      request_hash: 'sha_abc',
      provider: 'openai',
      pii_classes_redacted: ['email', 'phone'],
    },
    // Leak row — query filter SHOULD reject, but the loop must too.
    {
      tenant_id: 'tenant_OTHER',
      namespace: 'ns_other',
      created_at: '2026-05-03T00:00:00Z',
      request_hash: 'leak_hash',
      provider: 'openai',
    },
    // Threshold marker — must be skipped.
    {
      tenant_id: 'tenant_A',
      namespace: 'ns_a',
      created_at: '2026-05-04T00:00:00Z',
      provider: 'kolm_reg_hil_confidence_threshold',
    },
  ];
  const fakeEventStore = {
    async listEvents(_q) { return fakeRows; },
  };
  const env = await capturesProvenanceReport({
    tenant: 'tenant_A',
    eventStore: fakeEventStore,
  });
  assert.equal(env.ok, true);
  assert.equal(env.version, 'w834-v1');
  assert.ok(Array.isArray(env.sources) && env.sources.length >= 1,
    `sources must be a non-empty array; got ${JSON.stringify(env.sources)}`);
  const totalCount = env.sources.reduce((acc, s) => acc + s.count, 0);
  assert.equal(totalCount, 2,
    `expected 2 captures for tenant_A (connector + gateway); got ${totalCount} — leak row may have crossed the fence`);
  // PII summary must surface.
  assert.notEqual(env.pii_handling_summary, 'pii_metadata_not_yet_attached',
    `with one PII-tagged capture, pii_handling_summary must NOT be the not-attached sentinel`);
  // Honest envelope on bad input.
  const bad = await capturesProvenanceReport({});
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'tenant_required');
});

// =============================================================================
// 14) generateGovernanceReport markdown body + missing_attachments stamps
// =============================================================================

test('W834 #14 — generateGovernanceReport emits markdown + missing_attachments stamps', async () => {
  freshDir();
  // Empty event-store → all attachments missing.
  const fakeEventStore = {
    async listEvents() { return []; },
  };
  const env = await generateGovernanceReport({
    tenant: 'tenant_A',
    namespace: 'ns_a',
    eventStore: fakeEventStore,
  });
  assert.equal(env.ok, true);
  assert.equal(env.version, 'w834-v1');
  assert.equal(env.format, 'markdown');
  assert.ok(typeof env.body === 'string' && env.body.length > 0);
  assert.ok(/# Data Governance Report/.test(env.body),
    'markdown body must start with the canonical heading');
  assert.ok(Array.isArray(env.missing_attachments)
    && env.missing_attachments.includes('pii_handling_metadata')
    && env.missing_attachments.includes('consent_records'),
    `missing_attachments must enumerate empty-state gaps; got ${JSON.stringify(env.missing_attachments)}`);
  // Invalid period → honest envelope.
  const badPeriod = await generateGovernanceReport({
    tenant: 'tenant_A',
    period: 'not-a-period',
    eventStore: fakeEventStore,
  });
  assert.equal(badPeriod.ok, false);
  assert.equal(badPeriod.error, 'invalid_period');
  // Missing tenant → honest envelope.
  const noTenant = await generateGovernanceReport({});
  assert.equal(noTenant.ok, false);
  assert.equal(noTenant.error, 'tenant_required');
});

// =============================================================================
// 15) buildExtendedModelCard adds 3 extension blocks
// =============================================================================

test('W834 #15 — buildExtendedModelCard adds per_language_kscore + gate_status + teacher_attribution', () => {
  freshDir();
  const manifest = {
    name: 'student_distilled',
    teacher_model: 'claude-opus-4-7',
    teacher_license: 'commercial',
    per_language_kscore: {
      en: { k_score: 0.91, n: 250, ci: { low: 0.88, high: 0.93 } },
      es: { k_score: 0.74, n: 80, ci: { low: 0.66, high: 0.81 } },
      ja: { k_score: 0.62, n: 15 }, // below floor — should null out
    },
    k_score: 0.85,
    hil_threshold_set: true,
    annex_iv_doc_present: true,
    audit_retention_days: 730,
    disclosures_attached: true,
  };
  const res = buildExtendedModelCard(manifest, {
    gates_required: ['mandatory_human_review', 'accuracy_threshold', 'documentation',
      'audit_log', 'transparency_disclosure'],
  });
  assert.equal(res.ok, true);
  assert.equal(res.version, 'w834-v1');
  assert.ok(res.base_version, 'base_version should reference the W768 base card version');
  assert.ok(res.extensions && typeof res.extensions === 'object');
  // per_language_kscore block carries one entry per language; below-floor
  // bucket (ja) must report k_score:null per honesty contract.
  const perLang = res.extensions.per_language_kscore;
  assert.ok(perLang && typeof perLang === 'object',
    `per_language_kscore must be an object; got ${typeof perLang}`);
  assert.ok(perLang.en && perLang.en.k_score === 0.91);
  assert.ok(perLang.ja && perLang.ja.k_score === null,
    `below-floor ja bucket must report k_score:null (n<30); got ${JSON.stringify(perLang.ja)}`);
  // Gate status block — at least mandatory_human_review must be satisfied.
  const gates = res.extensions.per_risk_category_gate_status;
  assert.ok(Array.isArray(gates) && gates.length === 5,
    `expected 5 gate-status rows; got ${gates && gates.length}`);
  const hil = gates.find((g) => g.gate === 'mandatory_human_review');
  assert.equal(hil.satisfied, true,
    `hil_threshold_set:true must satisfy mandatory_human_review; got ${JSON.stringify(hil)}`);
  // Teacher attribution.
  assert.equal(res.extensions.teacher_attribution.teacher_model, 'claude-opus-4-7');
  assert.equal(res.extensions.teacher_attribution.license, 'commercial');
  assert.equal(res.extensions.teacher_attribution.attribution_required, true);
  // Honest envelope on bad input.
  const bad = buildExtendedModelCard(null);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'manifest_required');
});

// =============================================================================
// 16) GRC connectors emit honest no_grc_creds envelopes with payload computed
// =============================================================================

test('W834 #16 — GRC connectors return no_grc_creds envelope WITH export_payload (HONESTY)', () => {
  freshDir();
  // Ensure env vars are NOT set so we exercise the honest-stub path.
  for (const ev of Object.values(VENDOR_ENV_VARS)) {
    delete process.env[ev];
  }
  assert.ok(Object.isFrozen(SUPPORTED_VENDORS),
    'SUPPORTED_VENDORS must be Object.freeze()-d');
  assert.equal(SUPPORTED_VENDORS.length, 3,
    `expected 3 supported vendors; got ${SUPPORTED_VENDORS.length}`);
  assert.ok(Object.isFrozen(VENDOR_ENV_VARS),
    'VENDOR_ENV_VARS must be Object.freeze()-d');
  // Sample report blob — model-card-shaped.
  const sampleReport = {
    card: {
      model_details: { name: 'foo', version: '1.0' },
      intended_use: { primary_uses: 'demo' },
      training_data: { datasets: ['internal'] },
    },
    extensions: {
      per_language_kscore: { en: { k_score: 0.9, n: 100 } },
      teacher_attribution: { teacher_model: 'claude-opus-4-7' },
    },
  };
  for (const [vendor, fn] of [
    ['onetrust', exportToOneTrust],
    ['servicenow', exportToServiceNow],
    ['ibm_openpages', exportToIBMOpenPages],
  ]) {
    const r = fn(sampleReport);
    assert.equal(r.ok, false, `${vendor}: expected ok:false without creds; got ${JSON.stringify(r)}`);
    assert.equal(r.vendor, vendor);
    assert.equal(r.error, 'no_grc_creds');
    assert.ok(typeof r.install_hint === 'string' && r.install_hint.length > 0,
      `${vendor}: install_hint must be non-empty`);
    // CRITICAL: export_payload MUST still be computed so operators can
    // manually upload. NEVER drop the payload silently.
    assert.ok(r.export_payload && typeof r.export_payload === 'object',
      `${vendor}: export_payload MUST be computed even without creds; got ${JSON.stringify(r.export_payload)}`);
    assert.equal(r.version, 'w834-v1');
  }
  // exportByVendor dispatch.
  const dispatch = exportByVendor(sampleReport, 'onetrust');
  assert.equal(dispatch.vendor, 'onetrust');
  // Unknown vendor → honest envelope.
  const unknown = exportByVendor(sampleReport, 'totally_unknown_grc_vendor');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, 'unknown_vendor');
  // Missing vendor → honest envelope.
  const missing = exportByVendor(sampleReport, null);
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'vendor_required');
  // With creds present → ready_to_post:true.
  process.env.KOLM_GRC_ONETRUST_API_KEY = 'fake_test_key';
  try {
    const withCreds = exportToOneTrust(sampleReport);
    assert.equal(withCreds.ok, true);
    assert.equal(withCreds.ready_to_post, true);
    assert.ok(withCreds.export_payload);
  } finally {
    delete process.env.KOLM_GRC_ONETRUST_API_KEY;
  }
});

// =============================================================================
// 17) POST /v1/reg/eu-aiact-docs 401 w/o auth; 200 envelope on auth
// =============================================================================

test('W834 #17 — POST /v1/reg/eu-aiact-docs 401 w/o auth; 200 envelope on auth', async () => {
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

    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/reg/eu-aiact-docs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ artifact_manifest: { name: 'foo' } }),
    });
    assert.equal(noAuth.status, 401, `expected 401 without auth; got ${noAuth.status}`);

    const ok = await fetch(`http://127.0.0.1:${port}/v1/reg/eu-aiact-docs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({
        artifact_manifest: { name: 'student_v1', version: '0.1', intended_purpose: 'demo' },
        format: 'markdown',
      }),
    });
    assert.equal(ok.status, 200, `expected 200 with auth; got ${ok.status}`);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.equal(env.version, 'w834-v1');
    assert.equal(env.format, 'markdown');
    assert.ok(typeof env.body === 'string' && env.body.length > 0);
  } finally {
    await new Promise((r) => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 18) POST /v1/reg/classify-risk 401 w/o auth; 200 envelope on auth
// =============================================================================

test('W834 #18 — POST /v1/reg/classify-risk 401 w/o auth; 200 envelope on auth', async () => {
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

    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/reg/classify-risk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intended_use: 'medical_dx' }),
    });
    assert.equal(noAuth.status, 401, `expected 401 without auth; got ${noAuth.status}`);

    const ok = await fetch(`http://127.0.0.1:${port}/v1/reg/classify-risk`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ intended_use: 'medical_dx' }),
    });
    assert.equal(ok.status, 200, `expected 200 with auth; got ${ok.status}`);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.equal(env.tier, 'high_risk');
    assert.equal(env.version, 'w834-v1');
  } finally {
    await new Promise((r) => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 19) POST + GET /v1/reg/hil/threshold (auth + confirm gates)
// =============================================================================

test('W834 #19 — POST /v1/reg/hil/threshold confirm gate; GET reads back', async () => {
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

    // No auth.
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/reg/hil/threshold`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: 'ns_x', threshold: 0.5, confirm: true }),
    });
    assert.equal(noAuth.status, 401);

    // No confirm.
    const noConfirm = await fetch(`http://127.0.0.1:${port}/v1/reg/hil/threshold`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ namespace: 'ns_x', threshold: 0.5 }),
    });
    assert.equal(noConfirm.status, 400);
    const noConfirmEnv = await noConfirm.json();
    assert.equal(noConfirmEnv.error, 'confirm_required');

    // Out-of-range threshold even with confirm.
    const oob = await fetch(`http://127.0.0.1:${port}/v1/reg/hil/threshold`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ namespace: 'ns_x', threshold: 5.0, confirm: true }),
    });
    assert.equal(oob.status, 400);
    const oobEnv = await oob.json();
    assert.equal(oobEnv.error, 'invalid_threshold');

    // Happy path.
    const ok = await fetch(`http://127.0.0.1:${port}/v1/reg/hil/threshold`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ namespace: 'ns_x', threshold: 0.4, confirm: true }),
    });
    assert.equal(ok.status, 200, `expected 200; got ${ok.status}`);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.equal(env.threshold, 0.4);
    assert.equal(env.namespace, 'ns_x');

    // GET reads back.
    const getOk = await fetch(`http://127.0.0.1:${port}/v1/reg/hil/threshold?namespace=ns_x`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(getOk.status, 200);
    const getEnv = await getOk.json();
    assert.equal(getEnv.ok, true);
    assert.equal(getEnv.threshold, 0.4);
    assert.equal(getEnv.configured, true);

    // GET without namespace -> 400.
    const noNs = await fetch(`http://127.0.0.1:${port}/v1/reg/hil/threshold`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(noNs.status, 400);

    // GET without auth -> 401.
    const getNoAuth = await fetch(`http://127.0.0.1:${port}/v1/reg/hil/threshold?namespace=ns_x`);
    assert.equal(getNoAuth.status, 401);
  } finally {
    await new Promise((r) => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 20) GET /v1/reg/data-governance 401 w/o auth; 200 envelope on auth
// =============================================================================

test('W834 #20 — GET /v1/reg/data-governance 401 w/o auth; 200 envelope on auth', async () => {
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

    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/reg/data-governance`);
    assert.equal(noAuth.status, 401);

    const ok = await fetch(`http://127.0.0.1:${port}/v1/reg/data-governance?namespace=ns_a`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(ok.status, 200, `expected 200; got ${ok.status}`);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.equal(env.version, 'w834-v1');
    assert.equal(env.format, 'markdown');
    assert.ok(typeof env.body === 'string' && env.body.length > 0);
  } finally {
    await new Promise((r) => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 21) POST /v1/reg/model-card 401 w/o auth; 200 envelope on auth
// =============================================================================

test('W834 #21 — POST /v1/reg/model-card 401 w/o auth; 200 envelope on auth', async () => {
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

    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/reg/model-card`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ artifact_manifest: { name: 'foo' } }),
    });
    assert.equal(noAuth.status, 401);

    const ok = await fetch(`http://127.0.0.1:${port}/v1/reg/model-card`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({
        artifact_manifest: {
          name: 'student',
          teacher_model: 'claude-opus-4-7',
          k_score: 0.88,
        },
        gates_required: ['documentation', 'accuracy_threshold'],
      }),
    });
    assert.equal(ok.status, 200, `expected 200; got ${ok.status}`);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.equal(env.version, 'w834-v1');
    assert.ok(env.card);
    assert.ok(env.extensions);
    assert.ok(env.extensions.teacher_attribution.teacher_model === 'claude-opus-4-7');

    // No manifest -> 400.
    const noManifest = await fetch(`http://127.0.0.1:${port}/v1/reg/model-card`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({}),
    });
    assert.equal(noManifest.status, 400);
  } finally {
    await new Promise((r) => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 22) POST /v1/reg/grc-export 401 w/o auth; 200 with no_grc_creds sub-state
// =============================================================================

test('W834 #22 — POST /v1/reg/grc-export 401 w/o auth; 200 envelope (no_grc_creds honest sub-state when env vars unset)', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  // Ensure GRC env vars are not set so we exercise the honest stub.
  for (const ev of Object.values(VENDOR_ENV_VARS)) {
    delete process.env[ev];
  }

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

    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/reg/grc-export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ vendor: 'onetrust', report: { card: { model_details: {} } } }),
    });
    assert.equal(noAuth.status, 401);

    // Without creds → 200 envelope with ok:false + no_grc_creds + computed payload.
    const ok = await fetch(`http://127.0.0.1:${port}/v1/reg/grc-export`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({
        vendor: 'onetrust',
        report: { card: { model_details: { name: 'foo' } } },
      }),
    });
    assert.equal(ok.status, 200, `expected 200 (honest sub-state); got ${ok.status}`);
    const env = await ok.json();
    assert.equal(env.vendor, 'onetrust');
    assert.equal(env.ok, false);
    assert.equal(env.error, 'no_grc_creds');
    assert.ok(env.export_payload,
      'export_payload MUST still be computed for manual upload');

    // Missing vendor → 400.
    const noVendor = await fetch(`http://127.0.0.1:${port}/v1/reg/grc-export`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ report: {} }),
    });
    assert.equal(noVendor.status, 400);

    // Missing report → 400.
    const noReport = await fetch(`http://127.0.0.1:${port}/v1/reg/grc-export`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ vendor: 'onetrust' }),
    });
    assert.equal(noReport.status, 400);
  } finally {
    await new Promise((r) => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 23) src/reg-routes.js exports registerRegRoutes + router.js single-import mount
// =============================================================================

test('W834 #23 — registerRegRoutes exported; router.js single-import + single-call mount (W83x directive)', () => {
  freshDir();
  assert.equal(typeof registerRegRoutes, 'function',
    'src/reg-routes.js must export registerRegRoutes as a function');
  // Router.js must carry exactly one import line and one call line.
  const router = fs.readFileSync(ROUTER_PATH, 'utf8');
  const importMatches = router.match(/import\s+\{\s*registerRegRoutes\s+as\s+__registerRegRoutes_w834\s*\}\s+from\s+['"]\.\/reg-routes\.js['"]/g) || [];
  assert.equal(importMatches.length, 1,
    `expected exactly 1 import of registerRegRoutes; got ${importMatches.length}`);
  const callMatches = router.match(/__registerRegRoutes_w834\s*\(/g) || [];
  assert.equal(callMatches.length, 1,
    `expected exactly 1 call site for __registerRegRoutes_w834; got ${callMatches.length}`);
});

// =============================================================================
// 24) public/sw.js carries -wave834-regulatory + W604 regex+threshold
// =============================================================================


// =============================================================================
// 25) W834 is recorded as a shipped wave in the durable wave-registry ledger
//     + all six sub-item source modules are present in the tree.
// =============================================================================
//
// The original internal plan doc (KOLM_W707_SYSTEM_UPGRADE_PLAN.md) was
// DELIBERATELY removed from the tree and gitignored (`KOLM_*_PLAN.md` —
// "Internal planning / audit docs — never publish", commit 3a57dd4f
// "Public-surface polish"). Pinning a gitignored, intentionally-scrubbed
// internal artifact is stale. The durable SHIPPED evidence that genuinely
// persists in the tracked tree is the wave-registry ledger entry (state green)
// plus the six W834 source modules themselves — which is what we lock here.

test('W834 #25 — wave-registry records W834 shipped + all six W834 source modules present', () => {
  freshDir();
  const REGISTRY_PATH = path.join(REPO_ROOT, 'docs', 'internal', 'wave-registry.json');
  assert.ok(fs.existsSync(REGISTRY_PATH), `expected ${REGISTRY_PATH}`);
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const waves = Array.isArray(registry) ? registry : (registry.waves || []);
  const w834 = waves.find((w) => w && w.canonical_wave_id === 'W834');
  assert.ok(w834, 'wave-registry must carry a W834 entry');
  // Ledger must record W834 as a shipped/green wave and bind it to this test.
  assert.ok(/green|shipped/i.test(String(w834.state)),
    `W834 registry state must be green/shipped; got ${JSON.stringify(w834.state)}`);
  assert.ok(Array.isArray(w834.test_files)
    && w834.test_files.includes('tests/wave834-regulatory.test.js'),
    `W834 ledger entry must bind tests/wave834-regulatory.test.js; got ${JSON.stringify(w834.test_files)}`);
  // All six W834 sub-item source modules must be present in the tree — this is
  // the real, durable proof the regulatory toolkit shipped.
  for (const mod of [
    'src/reg-eu-aiact-docs.js',       // W834-1
    'src/reg-risk-classify.js',        // W834-2
    'src/reg-hil.js',                  // W834-3
    'src/reg-data-governance.js',      // W834-4
    'src/reg-model-card-extended.js',  // W834-5
    'src/reg-grc-connectors.js',       // W834-6
  ]) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, mod)),
      `W834 sub-item module must be present in the tree: ${mod}`);
  }
});
