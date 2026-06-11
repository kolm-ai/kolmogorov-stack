// Agent Security-Review audit - data-egress analyzer lock-in tests.
//
// Pins src/egress-analyzer.js (ASR-3, GAP-1). Proves the control no longer
// passes by default: every observed destination lands in the inventory, an
// operator allowlist is evaluated host-by-host (with suffix wildcards), a
// secret-shaped token riding an egress call is a critical finding, and an
// export with zero egress is marked untested - never scored clean.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent } from '../src/audit-event.js';
import { analyzeEgress } from '../src/egress-analyzer.js';

function toolEv({ host, tool = 'http_post', sensitive = false, secrets, key_id = 'k1' } = {}) {
  return normalizeEvent({
    namespace: 'audit',
    actor: { key_id, agent: 'agent-a' },
    action: { type: 'tool', tool, host: host || null },
    data: { has_sensitive: sensitive, egress: !!host },
    meta: { kind: 'tool_call', args_host: host || null, ...(secrets ? { secret_classes: secrets } : {}) },
  });
}

function modelEv({ host = 'api.openai.com', key_id = 'k1' } = {}) {
  return normalizeEvent({
    namespace: 'audit',
    actor: { key_id, agent: 'agent-a' },
    action: { type: 'api', host },
    data: { egress: true },
    meta: { kind: 'model_call', api_base: host },
  });
}

const has = (findings, id) => findings.some((f) => f.id === id);
const get = (findings, id) => findings.find((f) => f.id === id);

// ---------------------------------------------------------------------------
// contract: never throws, empty / garbage input is untested, empty-but-valid.
// ---------------------------------------------------------------------------
test('analyzeEgress never throws on garbage input', () => {
  for (const bad of [undefined, null, 'x', 42, {}, [], [null, 5, 'nope'], [{ data: 'oops' }]]) {
    for (const opts of [undefined, null, 42, { allowedHosts: 'not-an-array' }, { allowedHosts: [null, 7] }]) {
      const r = analyzeEgress(bad, opts);
      assert.ok(Array.isArray(r.findings), 'findings array');
      assert.ok(Array.isArray(r.destinations), 'destinations array');
      assert.ok(r.summary && typeof r.summary === 'object', 'summary present');
      assert.equal(r.summary.analyzer, 'egress');
    }
  }
});

test('zero egress events -> egress-untested (never a silent ASR-3 pass)', () => {
  // A tool call with no destination is not egress.
  const r = analyzeEgress([toolEv({ host: null, tool: 'read_doc' })]);
  assert.equal(r.summary.untested, true);
  assert.equal(r.summary.egress_events, 0);
  assert.deepEqual(r.findings.map((f) => f.id), ['egress-untested']);
  assert.equal(r.findings[0].severity, 'info');
  assert.equal(r.findings[0].pillar, 'data-egress');
  assert.ok(typeof r.summary.note === 'string' && /untested/i.test(r.summary.note));
});

// ---------------------------------------------------------------------------
// destination inventory - the Sub-Processor Inventory seed.
// ---------------------------------------------------------------------------
test('destinations[] enumerates every host with calls, tools, and sensitivity', () => {
  const r = analyzeEgress([
    modelEv({ host: 'api.openai.com' }),
    toolEv({ host: 'hooks.example.com', tool: 'post_webhook' }),
    toolEv({ host: 'hooks.example.com', tool: 'post_webhook', sensitive: true }),
    toolEv({ host: 'crm.partner.io', tool: 'update_crm' }),
  ]);
  assert.equal(r.summary.untested, false);
  assert.deepEqual(r.destinations.map((d) => d.host), ['api.openai.com', 'crm.partner.io', 'hooks.example.com'], 'sorted inventory');
  const hooks = r.destinations.find((d) => d.host === 'hooks.example.com');
  assert.equal(hooks.calls, 2);
  assert.equal(hooks.tool_calls, 2);
  assert.equal(hooks.sensitive_calls, 1);
  assert.deepEqual(hooks.tools, ['post_webhook']);
  const openai = r.destinations.find((d) => d.host === 'api.openai.com');
  assert.equal(openai.model_calls, 1, 'model host inventoried as a declared inference endpoint');
});

// ---------------------------------------------------------------------------
// allowlist evaluation.
// ---------------------------------------------------------------------------
test('a non-model host outside the supplied allowlist -> unapproved-egress-destination (high)', () => {
  const r = analyzeEgress(
    [
      modelEv({ host: 'api.openai.com' }),
      toolEv({ host: 'api.acme.com', tool: 'fetch_doc' }),
      toolEv({ host: 'exfil.evil.example', tool: 'http_post' }),
    ],
    { allowedHosts: ['acme.com'] },
  );
  const f = get(r.findings, 'unapproved-egress-destination');
  assert.ok(f, 'unapproved finding present');
  assert.equal(f.severity, 'high');
  assert.equal(f.pillar, 'data-egress');
  assert.equal(r.summary.unapproved, 1);
  assert.equal(r.summary.allowlist_declared, true);
  assert.deepEqual(f.metric.unapproved.map((d) => d.host), ['exfil.evil.example']);
  // Subdomain matching: api.acme.com is admitted by 'acme.com'.
  const acme = r.destinations.find((d) => d.host === 'api.acme.com');
  assert.equal(acme.allowlisted, true, 'suffix match admits subdomains');
  // The model endpoint is a declared dependency, not an unapproved destination.
  assert.ok(!f.metric.unapproved.some((d) => d.host === 'api.openai.com'));
  assert.ok(!has(r.findings, 'egress-allowlisted-clean'), 'no positive when a problem exists');
  assert.ok(f.evidence.length >= 1, 'finding carries evidence ids');
});

test("'*.corp.com' wildcard and every-host-inside -> egress-allowlisted-clean (info positive)", () => {
  const r = analyzeEgress(
    [toolEv({ host: 'api.corp.com' }), toolEv({ host: 'files.eu.corp.com' })],
    { allowedHosts: ['*.corp.com'] },
  );
  assert.equal(r.summary.unapproved, 0);
  assert.deepEqual(r.findings.map((f) => f.id), ['egress-allowlisted-clean']);
  assert.equal(r.findings[0].severity, 'info');
  for (const d of r.destinations) assert.equal(d.allowlisted, true);
});

test('no allowlist supplied + tool egress observed -> undeclared-egress-surface (medium)', () => {
  const r = analyzeEgress([
    modelEv({ host: 'api.openai.com' }),
    toolEv({ host: 'hooks.example.com', tool: 'post_webhook' }),
  ]);
  const f = get(r.findings, 'undeclared-egress-surface');
  assert.ok(f, 'undeclared-surface finding present (this is what kills the silent pass)');
  assert.equal(f.severity, 'medium');
  assert.equal(r.summary.allowlist_declared, false);
  assert.equal(f.metric.destination_count, 1, 'model endpoints are not counted as undeclared tool egress');
  assert.deepEqual(f.metric.destinations.map((d) => d.host), ['hooks.example.com']);
});

test('model-only egress with no allowlist emits no undeclared-surface noise', () => {
  const r = analyzeEgress([modelEv({ host: 'api.openai.com' }), modelEv({ host: 'api.anthropic.com' })]);
  assert.equal(r.summary.untested, false, 'egress was observed');
  assert.deepEqual(r.findings, [], 'declared inference endpoints alone are inventory, not a finding');
  assert.equal(r.destinations.length, 2, 'both endpoints still inventoried');
});

// ---------------------------------------------------------------------------
// secret egress (GAP-2 meets GAP-1).
// ---------------------------------------------------------------------------
test('an egress event carrying meta.secret_classes -> secret-egress (critical)', () => {
  const r = analyzeEgress(
    [toolEv({ host: 'exfil.evil.example', sensitive: true, secrets: ['openai-style-key', 'jwt'] })],
    { allowedHosts: ['corp.com'] },
  );
  const f = get(r.findings, 'secret-egress');
  assert.ok(f, 'secret-egress finding present');
  assert.equal(f.severity, 'critical');
  assert.equal(r.summary.secret_egress, 1);
  assert.deepEqual(f.metric.secret_classes, ['jwt', 'openai-style-key'], 'shape classes only');
  assert.ok(!JSON.stringify(f).includes('sk-'), 'no token material in the finding');
  assert.ok(f.evidence.length >= 1, 'carries the event id');
  // It rides alongside the allowlist verdict.
  assert.ok(has(r.findings, 'unapproved-egress-destination'));
});

test('analyzeEgress is deterministic: same events -> identical result', () => {
  const events = [
    modelEv({ host: 'api.openai.com' }),
    toolEv({ host: 'b.example.com' }),
    toolEv({ host: 'a.example.com', secrets: ['bearer'] }),
  ];
  const a = analyzeEgress(events, { allowedHosts: ['a.example.com'] });
  const b = analyzeEgress(events, { allowedHosts: ['a.example.com'] });
  assert.deepEqual(a, b);
});
