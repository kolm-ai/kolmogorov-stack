// Agent Security-Review audit — orchestrator lock-in tests.
//
// Pins src/audit-orchestrator.js: the deterministic spine that the CLI dogfood
// and the future API/report layer both call. Proves logs → events → both
// analyzers → control map land in one stable, versioned result, with a
// readiness rollup that is graduated, never inflated, and explicit about what
// the trinity does NOT assess.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAudit, AUDIT_SPEC_VERSION } from '../src/audit-orchestrator.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// The canonical "stalled deal" agent: shared over-permissioned key, PII emailed
// out, destructive actions, no tamper-evident trail.
const BAD_LOG = [
  JSON.stringify({
    request_id: 'r1', timestamp: '2026-02-03T14:22:10Z', model: 'openai/gpt-4o',
    api_base: 'https://api.openai.com/v1', user: 'support-agent', metadata: { key_alias: 'shared' },
    tools: [
      { type: 'function', function: { name: 'get_order' } },
      { type: 'function', function: { name: 'send_email' } },
      { type: 'function', function: { name: 'delete_customer' } },
      { type: 'function', function: { name: 'export_customers' } },
      { type: 'function', function: { name: 'list_users' } },
      { type: 'function', function: { name: 'update_billing' } },
      { type: 'function', function: { name: 'refund_order' } },
    ],
    messages: [{ role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_order', arguments: '{"order":"44219"}' } }] }],
  }),
  JSON.stringify({
    request_id: 'r2', timestamp: '2026-02-04T09:15:42Z', model: 'openai/gpt-4o',
    api_base: 'https://api.openai.com/v1', user: 'support-agent', metadata: { key_alias: 'shared' },
    tools: [
      { type: 'function', function: { name: 'get_order' } },
      { type: 'function', function: { name: 'send_email' } },
      { type: 'function', function: { name: 'delete_customer' } },
      { type: 'function', function: { name: 'export_customers' } },
      { type: 'function', function: { name: 'list_users' } },
      { type: 'function', function: { name: 'update_billing' } },
      { type: 'function', function: { name: 'refund_order' } },
    ],
    messages: [{ role: 'assistant', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'send_email', arguments: '{"to":"maria@gmail.com","body":"SSN 401-55-9823"}' } }] }],
  }),
  JSON.stringify({
    request_id: 'r3', timestamp: '2026-03-12T10:05:00Z', model: 'anthropic/claude-sonnet-4',
    api_base: 'https://api.anthropic.com', user: 'billing-agent', metadata: { key_alias: 'shared' },
    tools: [{ type: 'function', function: { name: 'charge_card' } }],
    messages: [{ role: 'assistant', tool_calls: [{ id: 'c3', type: 'function', function: { name: 'charge_card', arguments: '{"acct":"7782"}' } }] }],
  }),
].join('\n');

// A clean agent: least-privilege key, read-only, hash-chained, well-retained.
const CLEAN_LOG = [
  JSON.stringify({
    request_id: 'g1', timestamp: '2026-01-01T00:00:00Z', model: 'openai/gpt-4o',
    api_base: 'https://api.openai.com/v1', user: 'reader', metadata: { key_alias: 'k-clean' }, hash: 'h1',
    tools: [{ type: 'function', function: { name: 'read_doc' } }],
    messages: [{ role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_doc', arguments: '{}' } }] }],
  }),
  JSON.stringify({
    request_id: 'g2', timestamp: '2026-09-01T00:00:00Z', model: 'openai/gpt-4o',
    api_base: 'https://api.openai.com/v1', user: 'reader', metadata: { key_alias: 'k-clean' }, hash: 'h2', prev_hash: 'h1',
    tools: [{ type: 'function', function: { name: 'read_doc' } }],
    messages: [{ role: 'assistant', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read_doc', arguments: '{}' } }] }],
  }),
].join('\n');

test('runAudit never throws and returns the versioned shape on bad input', () => {
  for (const bad of [undefined, null, 42, '', 'not json', [], [null], [{}]]) {
    const r = runAudit(bad);
    assert.equal(r.spec_version, AUDIT_SPEC_VERSION);
    assert.ok(Array.isArray(r.events), 'events array');
    assert.ok(Array.isArray(r.findings), 'findings array');
    assert.ok(r.summary && typeof r.summary === 'object', 'summary present');
    assert.ok(Array.isArray(r.summary.controls), 'controls rollup present');
  }
});

test('runAudit on a stalled-deal agent surfaces every pillar, mapped to frameworks', () => {
  const r = runAudit(BAD_LOG, { source: 'litellm' });

  // Versioned + traceable.
  assert.equal(r.spec_version, AUDIT_SPEC_VERSION);
  assert.equal(r.source, 'litellm');
  assert.ok(r.ingest.records === 3 && r.ingest.events >= 6, 'ingest stats populated');

  // Least privilege is assessed PER CREDENTIAL: the shared key spans both agents,
  // so its surface is the union (7 support + 1 billing = 8 granted, 3 used).
  const actor = r.permission.actors.find((a) => a.key_id === 'shared');
  assert.ok(actor, 'shared-key actor present');
  assert.equal(actor.granted_tools, 8, 'granted is the union across the shared key');
  assert.equal(actor.used_tools, 3, 'used is the union across the shared key');

  // All three assessed controls are blocking; readiness collapses to 0.
  assert.equal(r.summary.readiness_pct, 0);
  const byId = Object.fromEntries(r.summary.controls.map((c) => [c.id, c]));
  assert.equal(byId['ASR-1'].status, 'blocking');
  assert.equal(byId['ASR-2'].status, 'blocking');
  assert.equal(byId['ASR-3'].status, 'blocking');

  // What was NOT assessed is stated, never silently scored. ASR-4 (injection)
  // is reported in the separate red_team block; ASR-6 (evidence) is established
  // by the report's own signing + input-evidence digest. ASR-5/7/8 are now
  // assessed by the Wave-2 analyzers.
  const naIds = r.summary.not_assessed.map((n) => n.id);
  assert.deepEqual(naIds, ['ASR-4', 'ASR-6']);

  // The deal-blockers a buyer cares about, each carrying an ASR + frameworks.
  const blockingIds = r.summary.blocking.map((b) => b.id);
  for (const id of ['over-permission', 'shared-credential', 'high-privilege-action', 'sensitive-egress', 'no-tamper-evidence']) {
    assert.ok(blockingIds.includes(id), `${id} blocks the deal`);
  }
  assert.equal(r.summary.tamper_evident, false);
  for (const b of r.summary.blocking) {
    assert.ok(b.asr, `blocking finding ${b.id} carries an ASR control`);
    assert.ok(b.frameworks.length > 0, `blocking finding ${b.id} maps to ≥1 framework`);
  }

  // The site mapping (research.html / checks.html) must match what the report
  // cites: least-privilege + egress findings carry SOC 2 CC6.
  const overPerm = r.summary.blocking.find((b) => b.id === 'over-permission');
  assert.ok(overPerm.frameworks.includes('SOC 2 TSC CC6'), 'least-privilege cites SOC 2 CC6');
  const egress = r.summary.blocking.find((b) => b.id === 'sensitive-egress');
  assert.ok(egress.frameworks.includes('SOC 2 TSC CC6'), 'egress cites SOC 2 CC6');
});

test('runAudit on a clean agent reports full readiness and no blockers', () => {
  const r = runAudit(CLEAN_LOG, { source: 'litellm' });
  assert.equal(r.summary.readiness_pct, 100, 'core controls all pass -> full readiness');
  assert.equal(r.summary.blocking.length, 0, 'no deal-blockers');
  assert.equal(r.summary.tamper_evident, true, 'intact hash chain');
  const byId = Object.fromEntries(r.summary.controls.map((c) => [c.id, c]));
  // The posture trinity (core) passes cleanly on a least-privilege, hash-chained
  // agent. Supplemental controls are reported but, on a clean agent, are never a
  // hard blocker (a clean agent on a floating model slug correctly surfaces an
  // ASR-5 provenance attention; an untested supplemental is marked, not failed).
  for (const id of ['ASR-1', 'ASR-2', 'ASR-3']) assert.equal(byId[id].status, 'pass', `${id} passes`);
  for (const id of ['ASR-5', 'ASR-7', 'ASR-8']) assert.ok(byId[id].status !== 'blocking', `${id} non-blocking on a clean agent`);
});

test('runAudit on empty input reports null readiness with a note, not a fake score', () => {
  const r = runAudit('', { source: 'litellm' });
  assert.equal(r.summary.readiness_pct, null);
  assert.ok(typeof r.summary.note === 'string' && r.summary.note.length > 0);
  assert.equal(r.summary.blocking.length, 0);
});

// ---------------------------------------------------------------------------
// ASR-3 egress analyzer wiring (GAP-1) + detector coverage (GAP-2).
// ---------------------------------------------------------------------------

// CLEAN_LOG plus one tool reaching an external destination: the egress surface
// exists but carries no PII / secret. Hash-chained so ASR-2 stays green.
const EGRESS_LOG = [
  JSON.stringify({
    request_id: 'e1', timestamp: '2026-01-01T00:00:00Z', model: 'openai/gpt-4o',
    api_base: 'https://api.openai.com/v1', user: 'reader', metadata: { key_alias: 'k-egress' }, hash: 'h1',
    tools: [{ type: 'function', function: { name: 'read_doc' } }, { type: 'function', function: { name: 'fetch_url' } }],
    messages: [{ role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_doc', arguments: '{}' } }] }],
  }),
  JSON.stringify({
    request_id: 'e2', timestamp: '2026-09-01T00:00:00Z', model: 'openai/gpt-4o',
    api_base: 'https://api.openai.com/v1', user: 'reader', metadata: { key_alias: 'k-egress' }, hash: 'h2', prev_hash: 'h1',
    tools: [{ type: 'function', function: { name: 'read_doc' } }, { type: 'function', function: { name: 'fetch_url' } }],
    // NB: a bare host, not a full URL - the PII detector counts URLs as a PII
    // class (HIPAA Safe Harbor), which would correctly fire sensitive-egress
    // and turn this fixture into a blocking case instead of an attention one.
    messages: [{ role: 'assistant', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'fetch_url', arguments: '{"host":"partner.example.com"}' } }] }],
  }),
].join('\n');

// No api_base, no provider-prefixed model, no tool destinations: nothing ever
// leaves the boundary, so ASR-3 must be untested, not silently passed.
const NO_EGRESS_LOG = [
  JSON.stringify({
    request_id: 'n1', timestamp: '2026-01-01T00:00:00Z', model: 'gpt-4o', user: 'reader', hash: 'h1',
    tools: [{ type: 'function', function: { name: 'read_doc' } }],
    messages: [{ role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_doc', arguments: '{}' } }] }],
  }),
  JSON.stringify({
    request_id: 'n2', timestamp: '2026-09-01T00:00:00Z', model: 'gpt-4o', user: 'reader', hash: 'h2', prev_hash: 'h1',
    tools: [{ type: 'function', function: { name: 'read_doc' } }],
    messages: [{ role: 'assistant', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'read_doc', arguments: '{}' } }] }],
  }),
].join('\n');

test('runAudit carries result.egress and result.detector_coverage (the P2 interface)', () => {
  const r = runAudit(BAD_LOG, { source: 'litellm' });
  assert.ok(r.egress && typeof r.egress === 'object', 'result.egress present');
  assert.equal(r.egress.summary.analyzer, 'egress');
  assert.ok(Array.isArray(r.egress.destinations), 'destination inventory present');
  assert.ok(r.egress.destinations.some((d) => d.host === 'api.openai.com'), 'model endpoint inventoried');
  // The bounded detector claim for the signed report's caveat.
  assert.ok(r.detector_coverage && typeof r.detector_coverage === 'object');
  assert.ok(Array.isArray(r.detector_coverage.pii_classes) && r.detector_coverage.pii_classes.length > 0);
  assert.ok(Array.isArray(r.detector_coverage.secret_shapes) && r.detector_coverage.secret_shapes.includes('openai-style-key'));
});

test('tool egress with no allowlist -> undeclared surface puts ASR-3 at attention', () => {
  const r = runAudit(EGRESS_LOG, { source: 'litellm' });
  const byId = Object.fromEntries(r.summary.controls.map((c) => [c.id, c]));
  assert.equal(byId['ASR-3'].status, 'attention', 'enumerated-but-unvetted egress is no longer a silent pass');
  assert.ok(r.findings.some((f) => f.id === 'undeclared-egress-surface'), 'undeclared-egress-surface merged into findings');
  assert.equal(r.summary.readiness_pct, 83, 'pass + pass + attention over the core trinity');
  // The egress findings are framework-mapped like every other finding.
  const mapped = (r.controls.findings || []).find((f) => f.id === 'undeclared-egress-surface');
  assert.ok(mapped && mapped.asr && mapped.asr.id === 'ASR-3', 'mapped to ASR-3');
  assert.ok(Array.isArray(mapped.controls) && mapped.controls.length > 0, 'carries framework controls');
});

test('opts.analyzerOpts.egress.allowedHosts is plumbed through: clean allowlist -> ASR-3 pass', () => {
  const r = runAudit(EGRESS_LOG, {
    source: 'litellm',
    analyzerOpts: { egress: { allowedHosts: ['partner.example.com'] } },
  });
  const byId = Object.fromEntries(r.summary.controls.map((c) => [c.id, c]));
  assert.equal(byId['ASR-3'].status, 'pass', 'every destination vetted against the operator allowlist');
  assert.equal(r.summary.readiness_pct, 100);
  assert.equal(r.egress.summary.allowlist_declared, true);
  assert.equal(r.egress.summary.unapproved, 0);
  assert.ok(r.findings.some((f) => f.id === 'egress-allowlisted-clean'), 'positive posture finding present');
});

test('zero egress -> ASR-3 untested and EXCLUDED from the readiness denominator', () => {
  const r = runAudit(NO_EGRESS_LOG, { source: 'litellm' });
  const byId = Object.fromEntries(r.summary.controls.map((c) => [c.id, c]));
  assert.equal(byId['ASR-3'].status, 'untested', 'never a silent pass');
  assert.equal(r.egress.summary.untested, true);
  // Non-inflation rule: the denominator is the EXERCISED core controls only.
  const exercised = ['ASR-1', 'ASR-2'].map((id) => byId[id].status);
  const weight = { pass: 1, attention: 0.5, blocking: 0 };
  const expected = Math.round((100 * exercised.reduce((s, st) => s + weight[st], 0)) / exercised.length);
  assert.equal(r.summary.readiness_pct, expected, 'readiness computed over ASR-1/ASR-2 only');
});

test('the committed dogfood fixture stays a meaningful end-to-end demo', () => {
  const fixture = path.join(ROOT, 'examples', 'agent-audit', 'litellm-export.jsonl');
  const logs = fs.readFileSync(fixture, 'utf8');
  const r = runAudit(logs, { source: 'litellm' });
  assert.ok(r.ingest.events > 0, 'fixture ingests to events');
  assert.equal(r.summary.readiness_pct, 0, 'fixture is the canonical failing agent');
  assert.ok(r.summary.blocking.length >= 4, 'fixture exercises multiple blocking findings');
  // Every blocking finding is framework-mapped — the report has nothing dangling.
  for (const b of r.summary.blocking) assert.ok(b.frameworks.length > 0, `${b.id} mapped`);
});
