// Agent Security-Review audit - model & supply-chain provenance analyzer
// lock-in tests (src/model-provenance-analyzer.js).
//
// Pins ASR-5: that the analyzer enumerates the model + MCP/vendor supply-chain
// surface a reviewer must vet, and flags the provenance problems that block a
// clean attestation - floating (unpinned) model versions, opaque gateway
// routing, unpinned MCP servers, and sensitive data leaving unredacted to a
// third-party vendor. The load-bearing property (mirroring src/red-team.js): an
// absent signal is reported UNTESTED, never scored clean, and it never throws.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { normalizeEvent } from '../src/audit-event.js';
import { ingestForAudit } from '../src/audit-ingest.js';
import { mapControls } from '../src/control-mapper.js';
import { analyzeModelProvenance } from '../src/model-provenance-analyzer.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURE = path.join(ROOT, 'examples', 'agent-audit', 'litellm-export.jsonl');

function modelEvent({ model, host = null, routed = null, source = 'litellm', sensitive = false, redacted = false, egress = null }) {
  return normalizeEvent({
    namespace: source,
    actor: { key_id: 'k1', agent: 'agentA' },
    action: { type: 'model', host, method: 'post', endpoint: '/chat/completions' },
    data: { has_sensitive: sensitive, redacted, egress: egress == null ? !!host : egress },
    meta: { kind: 'model_call', model, routed_provider: routed, source },
  });
}

function mcpEvent({ server, tool = 'do_thing', sensitive = false, redacted = false, host = null }) {
  return normalizeEvent({
    namespace: 'audit',
    actor: { key_id: 'k1', agent: 'agentA' },
    action: { type: 'tool', tool, server, host },
    data: { has_sensitive: sensitive, redacted, egress: !!host },
    meta: { kind: 'tool_call' },
  });
}

const has = (findings, id) => findings.some((f) => f.id === id);
const get = (findings, id) => findings.find((f) => f.id === id);

// ---------------------------------------------------------------------------
// contract - never throws, always returns the documented shape.
// ---------------------------------------------------------------------------
test('analyzeModelProvenance never throws on empty / malformed input', () => {
  for (const bad of [undefined, null, 'x', 42, [], [null, 5], [{}], [{ action: null }], [{ meta: null }], [{ action: { type: 'model' }, meta: null }]]) {
    let r;
    assert.doesNotThrow(() => { r = analyzeModelProvenance(bad); }, `must not throw on ${JSON.stringify(bad)}`);
    assert.ok(Array.isArray(r.findings), 'findings is an array');
    assert.ok(Array.isArray(r.models), 'models is an array');
    assert.ok(Array.isArray(r.mcp_servers), 'mcp_servers is an array');
    assert.ok(Array.isArray(r.providers), 'providers is an array');
    assert.ok(r.summary && typeof r.summary === 'object', 'summary present');
  }
});

test('every finding carries the canonical analyzer shape and supply-chain pillar', () => {
  const r = analyzeModelProvenance([
    modelEvent({ model: 'openai/gpt-4o', host: 'api.openai.com' }),
    mcpEvent({ server: 'github-mcp' }),
  ]);
  assert.ok(r.findings.length > 0);
  for (const f of r.findings) {
    assert.ok(f.id && typeof f.id === 'string', 'id');
    assert.equal(f.analyzer, 'model-provenance');
    assert.ok(['critical', 'high', 'medium', 'low', 'info'].includes(f.severity), 'severity');
    assert.equal(f.pillar, 'supply-chain', 'pillar pins to supply-chain (ASR-5 fallback)');
    assert.ok(f.title && f.detail, 'title + detail');
    assert.ok(f.metric && typeof f.metric === 'object', 'metric object');
    assert.ok(Array.isArray(f.evidence), 'evidence array');
    assert.ok(Array.isArray(f.controls), 'controls array');
  }
});

// ---------------------------------------------------------------------------
// pinned vs floating model version.
// ---------------------------------------------------------------------------
test('a floating model alias is flagged; a pinned snapshot is not', () => {
  const floating = analyzeModelProvenance([modelEvent({ model: 'openai/gpt-4o', host: 'api.openai.com' })]);
  const fm = floating.models[0];
  assert.equal(floating.models.length, 1);
  assert.equal(fm.slug, 'openai/gpt-4o');
  assert.equal(fm.pinned, false, 'bare gpt-4o is floating');
  assert.equal(fm.provider, 'openai');
  const f = get(floating.findings, 'unpinned-model-version');
  assert.ok(f, 'unpinned-model-version present for a floating slug');
  assert.equal(f.severity, 'medium');
  assert.equal(f.metric.slug, 'openai/gpt-4o');

  const pinned = analyzeModelProvenance([modelEvent({ model: 'openai/gpt-4o-2024-08-06', host: 'api.openai.com' })]);
  assert.equal(pinned.models[0].pinned, true, 'dated snapshot is pinned');
  assert.ok(!has(pinned.findings, 'unpinned-model-version'), 'no unpinned finding for a pinned slug');
  // a clean, pinned, non-egress model call yields the positive (signable) info finding.
  assert.deepEqual(pinned.findings.map((x) => x.id), ['model-provenance-clean']);
  assert.equal(pinned.findings[0].severity, 'info');
});

test('pin detection handles bare slugs and several real snapshot conventions', () => {
  const cases = [
    ['gpt-4o', false],
    ['gpt-4o-2024-08-06', true],
    ['gpt-4-0613', true],
    ['gpt-4-1106-preview', true],
    ['anthropic/claude-sonnet-4', false],
    ['anthropic/claude-3-5-sonnet-20241022', true],
    ['anthropic/claude-3-5-sonnet-latest', false],
    ['mistral/mistral-large-2407', true],
    ['meta-llama/llama-3.1-70b-instruct', false],
  ];
  for (const [slug, expected] of cases) {
    const r = analyzeModelProvenance([modelEvent({ model: slug, host: 'api.openai.com' })]);
    assert.equal(r.models[0].pinned, expected, `${slug} pinned=${expected}`);
  }
});

// ---------------------------------------------------------------------------
// MCP / vendor server enumeration + pinning.
// ---------------------------------------------------------------------------
test('MCP servers are enumerated and unpinned ones are flagged medium', () => {
  const r = analyzeModelProvenance([
    mcpEvent({ server: 'github-mcp', tool: 'create_issue' }),
    mcpEvent({ server: 'github-mcp', tool: 'list_repos' }),
    mcpEvent({ server: 'stripe-mcp', tool: 'get_balance' }),
  ]);
  assert.deepEqual(r.mcp_servers.map((s) => s.name).sort(), ['github-mcp', 'stripe-mcp']);
  const gh = r.mcp_servers.find((s) => s.name === 'github-mcp');
  assert.equal(gh.calls, 2, 'calls accumulate per server');
  assert.equal(gh.pinned, false);
  const findings = r.findings.filter((f) => f.id === 'unpinned-mcp-server');
  assert.equal(findings.length, 2, 'one finding per unpinned server');
  assert.ok(findings.every((f) => f.severity === 'medium'));
});

test('an MCP server is treated as pinned via an inline digest OR a declared trust list', () => {
  const inline = analyzeModelProvenance([mcpEvent({ server: 'github-mcp@sha256:deadbeefcafe1234' })]);
  assert.equal(inline.mcp_servers[0].pinned, true, 'inline image digest is a pin');
  assert.ok(!has(inline.findings, 'unpinned-mcp-server'));

  const inlineVer = analyzeModelProvenance([mcpEvent({ server: 'stripe-mcp@1.4.2' })]);
  assert.equal(inlineVer.mcp_servers[0].pinned, true, 'inline semver is a pin');

  const declared = analyzeModelProvenance(
    [mcpEvent({ server: 'github-mcp' })],
    { mcpPins: { 'github-mcp': '1.0.0' } },
  );
  assert.equal(declared.mcp_servers[0].pinned, true, 'operator-declared trust pins the server');
  assert.ok(!has(declared.findings, 'unpinned-mcp-server'), 'a declared server is not flagged');

  const declaredList = analyzeModelProvenance(
    [mcpEvent({ server: 'github-mcp' })],
    { trustedMcpServers: ['github-mcp'] },
  );
  assert.equal(declaredList.mcp_servers[0].pinned, true, 'trustedMcpServers list pins the server');
});

// ---------------------------------------------------------------------------
// sensitive data leaving to a third-party vendor.
// ---------------------------------------------------------------------------
test('unredacted sensitive egress to a third-party model vendor is high', () => {
  const r = analyzeModelProvenance([
    modelEvent({ model: 'openai/gpt-4o', host: 'api.openai.com', sensitive: true, redacted: false, egress: true }),
  ]);
  const f = get(r.findings, 'model-egress-third-party');
  assert.ok(f, 'model-egress-third-party present');
  assert.equal(f.severity, 'high');
  assert.equal(f.metric.destination, 'api.openai.com');
  assert.equal(f.metric.kind, 'model');
});

test('redacted sensitive egress is NOT escalated to the high third-party finding', () => {
  const r = analyzeModelProvenance([
    modelEvent({ model: 'openai/gpt-4o-2024-08-06', host: 'api.openai.com', sensitive: true, redacted: true, egress: true }),
  ]);
  assert.ok(!has(r.findings, 'model-egress-third-party'), 'redaction before egress is the defended case');
});

test('unredacted sensitive egress through an MCP / vendor server is high', () => {
  const r = analyzeModelProvenance([
    mcpEvent({ server: 'slack-mcp', tool: 'post_message', host: 'hooks.slack.com', sensitive: true, redacted: false }),
  ]);
  const f = get(r.findings, 'model-egress-third-party');
  assert.ok(f, 'MCP egress is caught too');
  assert.equal(f.severity, 'high');
  assert.equal(f.metric.kind, 'mcp');
});

// ---------------------------------------------------------------------------
// opaque gateway routing.
// ---------------------------------------------------------------------------
test('a model routed through a gateway is flagged opaque (low when the vendor is named, medium when not)', () => {
  // slug names the upstream vendor -> low.
  const named = analyzeModelProvenance([modelEvent({ model: 'openai/gpt-4o', host: 'openrouter.ai' })]);
  const lo = get(named.findings, 'opaque-model-routing');
  assert.ok(lo, 'opaque-model-routing present');
  assert.equal(lo.severity, 'low', 'named upstream -> low');
  assert.equal(lo.metric.gateway, 'openrouter.ai');
  assert.equal(lo.metric.unidentifiable_upstream, false);

  // slug cannot identify the vendor -> medium (fully opaque).
  const blind = analyzeModelProvenance([modelEvent({ model: 'mystery-model', host: 'openrouter.ai' })]);
  const md = get(blind.findings, 'opaque-model-routing');
  assert.ok(md);
  assert.equal(md.severity, 'medium', 'unidentifiable upstream -> medium');
  assert.equal(md.metric.unidentifiable_upstream, true);
});

// ---------------------------------------------------------------------------
// no model call -> untested (never clean).
// ---------------------------------------------------------------------------
test('empty events -> a single untested info finding, never scored clean', () => {
  const r = analyzeModelProvenance([]);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].id, 'model-provenance-untested');
  assert.equal(r.findings[0].severity, 'info');
  assert.equal(r.models.length, 0);
  assert.equal(r.summary.untested, true);
  assert.equal(r.summary.model_events, 0);
});

test('tool-only logs (no model call) still report model provenance untested', () => {
  const r = analyzeModelProvenance([mcpEvent({ server: 'github-mcp@1.2.3', tool: 'list_repos' })]);
  // model leg is untested...
  assert.ok(has(r.findings, 'model-provenance-untested'), 'no model call -> untested');
  // ...but the MCP surface is still enumerated (pinned here, so no MCP finding).
  assert.equal(r.mcp_servers.length, 1);
  assert.equal(r.mcp_servers[0].pinned, true);
  assert.ok(!has(r.findings, 'unpinned-mcp-server'));
});

// ---------------------------------------------------------------------------
// determinism + provider enumeration.
// ---------------------------------------------------------------------------
test('the analysis is deterministic and enumerates providers for the passport', () => {
  const events = [
    modelEvent({ model: 'openai/gpt-4o', host: 'api.openai.com' }),
    modelEvent({ model: 'openai/gpt-4o', host: 'api.openai.com' }),
    modelEvent({ model: 'anthropic/claude-sonnet-4', host: 'api.anthropic.com' }),
  ];
  const a = analyzeModelProvenance(events);
  const b = analyzeModelProvenance(events);
  assert.deepEqual(a, b, 'same events -> identical result');
  assert.deepEqual(a.providers.map((p) => p.name).sort(), ['anthropic', 'openai']);
  const openai = a.providers.find((p) => p.name === 'openai');
  assert.equal(openai.calls, 2, 'provider calls accumulate');
  assert.equal(openai.models, 1, 'distinct model slugs per provider');
  assert.equal(a.models.find((m) => m.slug === 'openai/gpt-4o').calls, 2);
});

// ---------------------------------------------------------------------------
// integration over the committed dogfood fixture + the control-mapper.
// ---------------------------------------------------------------------------
test('over the dogfood fixture: floating models flagged, SSN-bearing model call is high egress', () => {
  const events = ingestForAudit(fs.readFileSync(FIXTURE, 'utf8'), { source: 'litellm' }).events;
  const r = analyzeModelProvenance(events);

  // The fixture uses two floating aliases.
  assert.deepEqual(r.models.map((m) => m.slug).sort(), ['anthropic/claude-sonnet-4', 'openai/gpt-4o']);
  assert.ok(r.models.every((m) => m.pinned === false), 'both fixture models are floating');
  assert.equal(r.findings.filter((f) => f.id === 'unpinned-model-version').length, 2);

  // req_a2 carries an SSN bound for OpenAI; req_b1 an account number bound for
  // Anthropic. Both model calls egress unredacted sensitive content, so each
  // third-party destination is flagged high.
  const egress = r.findings.filter((f) => f.id === 'model-egress-third-party');
  assert.ok(egress.length >= 1, 'sensitive model egress is flagged');
  assert.ok(egress.every((f) => f.severity === 'high'), 'every third-party egress is high');
  const dests = egress.map((f) => f.metric.destination).sort();
  assert.ok(dests.includes('api.openai.com'), 'the SSN-bearing OpenAI call is flagged');

  // Provider surface a reviewer must vet.
  assert.deepEqual(r.providers.map((p) => p.name).sort(), ['anthropic', 'openai']);
});

test('findings map onto ASR-5 + OWASP supply-chain controls via the control-mapper', () => {
  const r = analyzeModelProvenance([modelEvent({ model: 'openai/gpt-4o', host: 'api.openai.com' })]);
  const mapped = mapControls(r.findings);
  const unpinned = mapped.findings.find((f) => f.id === 'unpinned-model-version');
  assert.ok(unpinned.asr && unpinned.asr.id === 'ASR-5', 'supply-chain pillar -> ASR-5');
  const ids = unpinned.controls.map((c) => c.id);
  assert.ok(ids.includes('AML.T0010'), 'maps MITRE ATLAS supply-chain compromise');
  assert.ok(ids.includes('LLM03'), 'maps OWASP LLM03 (supply chain - model, MCP and dependency provenance)');
  assert.ok(!ids.includes('LLM05'), 'no stale LLM05 (2025: LLM05 is improper output handling, out of scope)');
  // ASR-5 shows up in the rollup with at least one finding.
  const asr5 = mapped.asr.find((a) => a.id === 'ASR-5');
  assert.ok(asr5 && asr5.findings >= 1, 'ASR-5 rollup reflects the finding');
});
