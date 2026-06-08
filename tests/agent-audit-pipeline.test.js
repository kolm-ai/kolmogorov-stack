// Agent Security-Review audit — end-to-end pipeline test.
//
// Proves the wedge the user greenlit: raw agent logs → ingest (AuditEvents) →
// permission + audit-trail analyzers → control mapper, with findings landing
// on the buyer's frameworks. This is the spine the API/report layer sits on.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestForAudit } from '../src/audit-ingest.js';
import { analyzePermissions } from '../src/permission-analyzer.js';
import { analyzeAuditTrail } from '../src/audit-trail-analyzer.js';
import { mapControls } from '../src/control-mapper.js';

// A small, realistic LiteLLM-style export: an over-permissioned agent and a
// send_email call carrying PII to an external recipient. No hash chain — the
// common ~1-in-3 "no tamper-evident trail" case.
const LOG = [
  JSON.stringify({
    request_id: 'r1', timestamp: '2026-05-01T09:00:00Z', model: 'openai/gpt-4o',
    api_base: 'https://api.openai.com/v1', user: 'support-agent',
    messages: [
      { role: 'user', content: 'find the latest pricing doc' },
      { role: 'assistant', tool_calls: [{ type: 'function', function: { name: 'search_web', arguments: '{"q":"pricing"}' } }] },
    ],
    tools: [
      { type: 'function', function: { name: 'search_web' } },
      { type: 'function', function: { name: 'send_email' } },
      { type: 'function', function: { name: 'delete_user' } },
      { type: 'function', function: { name: 'read_doc' } },
    ],
    response: { choices: [{ message: { role: 'assistant', content: 'found it' } }] },
  }),
  JSON.stringify({
    request_id: 'r2', timestamp: '2026-05-02T10:00:00Z', model: 'openai/gpt-4o',
    api_base: 'https://api.openai.com/v1', user: 'support-agent',
    messages: [
      { role: 'user', content: 'email jane@customer.com — her SSN 123-45-6789 was confirmed' },
      { role: 'assistant', tool_calls: [{ type: 'function', function: { name: 'send_email', arguments: '{"to":"jane@customer.com"}' } }] },
    ],
    tools: [{ type: 'function', function: { name: 'send_email' } }],
    response: { choices: [{ message: { role: 'assistant', content: 'sent' } }] },
  }),
].join('\n');

// A record that makes a tool call fans out into >1 AuditEvent, all carrying
// that record's hash/prev_hash. The chain walk must treat them as ONE link, or
// a valid tamper-evident chain is falsely reported as broken (a critical
// finding that would destroy credibility in a signed audit).
test('pipeline: a valid hash chain across multi-event records is not falsely broken', () => {
  const rows = [
    { request_id: 'r1', timestamp: '2026-01-01T00:00:00Z', model: 'openai/gpt-4o', user: 'a', hash: 'h1',
      messages: [{ role: 'user', content: 'hi' }] },
    { request_id: 'r2', timestamp: '2026-01-02T00:00:00Z', model: 'openai/gpt-4o', user: 'a', hash: 'h2', prev_hash: 'h1',
      messages: [{ role: 'assistant', tool_calls: [{ type: 'function', function: { name: 'read_doc', arguments: '{}' } }] }],
      tools: [{ type: 'function', function: { name: 'read_doc' } }] },
  ];
  const { events } = ingestForAudit(rows, { source: 'litellm' });
  assert.ok(events.length >= 3, 'r2 fans out into a tool event + a model event');
  const trail = analyzeAuditTrail(events);
  assert.equal(trail.coverage.chain_links_broken, 0, 'no false break across same-hash events');
  assert.equal(trail.summary.tamper_evident, true, 'intact chain reported as tamper-evident');
  assert.equal(trail.findings.some((f) => f.id === 'broken-hash-chain'), false, 'no false critical');

  // A genuinely tampered prev_hash must still be caught.
  const tampered = [
    rows[0],
    { ...rows[1], prev_hash: 'TAMPERED' },
  ];
  const bad = analyzeAuditTrail(ingestForAudit(tampered, { source: 'litellm' }).events);
  assert.ok(bad.findings.some((f) => f.id === 'broken-hash-chain' && f.severity === 'critical'), 'real tamper still flagged critical');
});

// Regression: kolm's own content-blind id derivation collapsed genuinely
// distinct calls (same-second bursts, parallel tool calls) to one id, then the
// trail analyzer accused the buyer's faithful trail of replay / non-unique ids.
test('pipeline: distinct same-second and parallel calls do not fabricate duplicate-event-ids', () => {
  // Two distinct exchanges by one actor in the same one-second bucket.
  const sameSecond = [
    { request_id: 'r-a', timestamp: '2026-05-01T09:00:00Z', model: 'openai/gpt-4o', api_base: 'https://api.openai.com/v1', user: 'agent-x', messages: [{ role: 'user', content: 'question ALPHA' }] },
    { request_id: 'r-b', timestamp: '2026-05-01T09:00:00Z', model: 'openai/gpt-4o', api_base: 'https://api.openai.com/v1', user: 'agent-x', messages: [{ role: 'user', content: 'question BRAVO' }] },
  ];
  const t1 = analyzeAuditTrail(ingestForAudit(sameSecond, { source: 'litellm' }).events);
  assert.equal(t1.coverage.duplicate_ids, 0, 'distinct request_ids/content → distinct ids');
  assert.equal(t1.findings.some((f) => f.id === 'duplicate-event-ids'), false, 'no false replay finding');

  // Parallel tool calls to the same tool with different args (one exchange).
  const parallel = {
    timestamp: '2026-01-02T00:00:00Z', key_id: 'k', user: 'research-agent', model: 'openai/gpt-4o',
    request: { tools: [{ type: 'function', function: { name: 'web_search' } }],
      messages: [{ role: 'user', content: 'compare' },
        { role: 'assistant', tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'web_search', arguments: '{"q":"alpha"}' } },
          { id: 'c2', type: 'function', function: { name: 'web_search', arguments: '{"q":"beta"}' } },
        ] }] },
  };
  const ing = ingestForAudit([parallel], { source: 'litellm' });
  assert.equal(ing.stats.tool_calls, 2, 'both distinct parallel calls are kept');
  const t2 = analyzeAuditTrail(ing.events);
  assert.equal(t2.coverage.duplicate_ids, 0, 'parallel distinct calls → distinct ids');
});

test('pipeline: logs → events → analyzers → control map', () => {
  const { events, errors } = ingestForAudit(LOG, { source: 'litellm' });
  assert.equal(errors.length, 0, 'clean ingest');
  assert.ok(events.length >= 4, 'tool + model events for both records');

  const perm = analyzePermissions(events);
  const permIds = perm.findings.map((f) => f.id);
  assert.ok(permIds.includes('over-permission'), 'over-permissioned agent surfaced');
  assert.ok(permIds.includes('sensitive-egress'), 'PII leaving the boundary surfaced');

  const trail = analyzeAuditTrail(events);
  assert.ok(trail.findings.some((f) => f.id === 'no-tamper-evidence'), 'no tamper-evident trail surfaced');
  assert.equal(trail.summary.tamper_evident, false);

  const mapped = mapControls([...perm.findings, ...trail.findings]);
  assert.equal(mapped.asr.length, 6, 'all ASR controls reported');
  const fwNames = mapped.frameworks.map((f) => f.framework);
  assert.ok(fwNames.includes('EU AI Act'), 'EU AI Act implicated by the trail gap');
  assert.ok(fwNames.includes('OWASP LLM & Agentic Top 10'), 'OWASP implicated by permission findings');

  const asr1 = mapped.asr.find((a) => a.id === 'ASR-1');
  const asr2 = mapped.asr.find((a) => a.id === 'ASR-2');
  assert.ok(asr1.findings > 0, 'ASR-1 (least privilege) has findings');
  assert.ok(asr2.findings > 0, 'ASR-2 (audit trail) has findings');

  // every mapped finding carries an ASR control and at least one framework control
  for (const f of mapped.findings) {
    assert.ok(f.asr && f.asr.id, `finding ${f.id} has an ASR control`);
    assert.ok(Array.isArray(f.controls) && f.controls.length > 0, `finding ${f.id} maps to ≥1 control`);
  }
});
