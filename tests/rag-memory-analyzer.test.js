// Agent Security-Review audit - RAG and memory integrity analyzer lock-in tests.
//
// Pins src/rag-memory-analyzer.js (ASR-7): retrieval from an external/untrusted
// source is flagged high (indirect-injection / poisoning surface), a memory
// write with no integrity or attribution is flagged medium (memory poisoning),
// a clean first-party surface yields the positive finding only, and an absent
// retrieval/memory signal is reported untested - never scored clean.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent } from '../src/audit-event.js';
import { analyzeRagMemory } from '../src/rag-memory-analyzer.js';

function ev(p) {
  return normalizeEvent({ namespace: 'audit', meta: { kind: 'tool_call' }, ...p });
}
function retrieval({ tool = 'vector_search', host = null, server = null, key_id = 'k1', agent = 'rag-bot' } = {}) {
  return ev({
    actor: { key_id, agent },
    action: { type: 'tool', tool, host, server },
    scopes: { granted: ['tool:' + tool], used: ['tool:' + tool] },
    data: { egress: !!host },
  });
}
function memory({ tool = 'store_fact', key_id = 'k1', agent = 'mem-bot', hash = null } = {}) {
  return ev({
    actor: { key_id, agent },
    action: { type: 'tool', tool },
    scopes: { granted: ['tool:' + tool], used: ['tool:' + tool] },
    hash,
  });
}
function has(findings, id) { return findings.some((f) => f.id === id); }
function get(findings, id) { return findings.find((f) => f.id === id); }

test('analyzeRagMemory never throws on empty / bad input', () => {
  for (const bad of [undefined, null, 'x', 42, [], [null, 5], {}]) {
    const r = analyzeRagMemory(bad);
    assert.ok(Array.isArray(r.findings), 'findings is an array');
    assert.ok(Array.isArray(r.retrieval_sources), 'retrieval_sources is an array');
    assert.ok(Array.isArray(r.memory_ops), 'memory_ops is an array');
    assert.ok(r.summary && typeof r.summary === 'object', 'summary present');
  }
});

test('retrieval from an external host is flagged high (untrusted source)', () => {
  const events = [retrieval({ tool: 'vector_search', host: 'api.untrusted-rag.com' })];
  const { findings, retrieval_sources, summary } = analyzeRagMemory(events);
  const f = get(findings, 'untrusted-retrieval-source');
  assert.ok(f, 'untrusted-retrieval-source present');
  assert.equal(f.severity, 'high');
  assert.equal(f.pillar, 'rag-memory');
  assert.equal(f.analyzer, 'rag-memory');
  assert.ok(f.evidence.length >= 1, 'carries evidence event ids');
  // structured output reflects the external source
  assert.equal(retrieval_sources.length, 1);
  assert.equal(retrieval_sources[0].classification, 'external');
  assert.equal(retrieval_sources[0].first_party, false);
  assert.equal(summary.untrusted_sources, 1);
  // a flagged surface does not also emit the positive
  assert.equal(has(findings, 'retrieval-sources-enumerated'), false);
});

test('a retrieval API call to a third-party host (endpoint-detected) is flagged', () => {
  const e = ev({
    actor: { key_id: 'k1', agent: 'rag-bot' },
    action: { type: 'api', endpoint: '/v1/search', host: 'api.exa.ai', method: 'post' },
    data: { egress: true },
  });
  const { findings } = analyzeRagMemory([e]);
  assert.ok(has(findings, 'untrusted-retrieval-source'), 'endpoint-detected retrieval flagged');
});

test('a memory write with no integrity is flagged medium (memory poisoning)', () => {
  const events = [memory({ tool: 'store_fact' })]; // no hash chain logged
  const { findings, memory_ops, summary } = analyzeRagMemory(events);
  const f = get(findings, 'unverified-memory-write');
  assert.ok(f, 'unverified-memory-write present');
  assert.equal(f.severity, 'medium');
  assert.equal(f.pillar, 'rag-memory');
  assert.equal(memory_ops.length, 1);
  assert.equal(memory_ops[0].op, 'write');
  assert.equal(memory_ops[0].verified, false);
  assert.equal(summary.unverified_writes, 1);
  // a flagged surface does not also emit the positive
  assert.equal(has(findings, 'retrieval-sources-enumerated'), false);
});

test('a memory write carrying an integrity link and attribution is not flagged', () => {
  const events = [memory({ tool: 'store_fact', hash: 'h1' })];
  const { findings, memory_ops } = analyzeRagMemory(events);
  assert.equal(has(findings, 'unverified-memory-write'), false, 'verified write is clean');
  assert.equal(memory_ops[0].verified, true);
  assert.ok(has(findings, 'retrieval-sources-enumerated'), 'clean activity yields the positive');
});

test('a memory read (recall) is not misclassified as a write', () => {
  const events = [memory({ tool: 'memory_get' })];
  const { findings, memory_ops } = analyzeRagMemory(events);
  assert.equal(memory_ops[0].op, 'read');
  assert.equal(has(findings, 'unverified-memory-write'), false);
  assert.equal(has(findings, 'rag-memory-untested'), false, 'memory activity is not untested');
});

test('first-party retrieval yields the positive finding only', () => {
  const events = [
    retrieval({ tool: 'vector_search', host: 'rag-index.internal' }),
    retrieval({ tool: 'knowledge_lookup' }), // no host -> local / in-process index
  ];
  const { findings, retrieval_sources } = analyzeRagMemory(events);
  assert.equal(findings.length, 1, 'only the positive finding');
  assert.equal(findings[0].id, 'retrieval-sources-enumerated');
  assert.equal(findings[0].severity, 'info');
  assert.ok(retrieval_sources.every((s) => s.classification !== 'external'), 'no external source');
});

test('an operator first-party allow-list reclassifies a public host', () => {
  const events = [retrieval({ tool: 'vector_search', host: 'api.idx.acme.com' })];
  const flagged = analyzeRagMemory(events);
  assert.ok(has(flagged.findings, 'untrusted-retrieval-source'), 'untrusted by default');

  const cleared = analyzeRagMemory(events, { firstPartyDomains: ['acme.com'] });
  assert.equal(has(cleared.findings, 'untrusted-retrieval-source'), false, 'allow-listed domain cleared');
  assert.ok(has(cleared.findings, 'retrieval-sources-enumerated'), 'positive after allow-list');
  assert.equal(cleared.retrieval_sources[0].classification, 'first-party');
});

test('no retrieval or memory ops at all is reported untested (never scored clean)', () => {
  // Events exist, but none are retrieval/memory operations.
  const events = [ev({ actor: { key_id: 'k1' }, action: { type: 'tool', tool: 'send_email' } })];
  const { findings } = analyzeRagMemory(events);
  const f = get(findings, 'rag-memory-untested');
  assert.ok(f, 'rag-memory-untested present');
  assert.equal(f.severity, 'info');
  assert.equal(f.pillar, 'rag-memory');
});

test('empty input is reported untested, not clean', () => {
  const { findings, summary } = analyzeRagMemory([]);
  assert.deepEqual(findings.map((f) => f.id), ['rag-memory-untested']);
  assert.equal(summary.retrieval_calls, 0);
  assert.equal(summary.memory_calls, 0);
});

test('mixed external retrieval + unverified memory write: both flagged, no positive', () => {
  const events = [
    retrieval({ tool: 'vector_search', host: 'api.untrusted-rag.com' }),
    memory({ tool: 'context_store' }),
  ];
  const { findings, summary } = analyzeRagMemory(events);
  assert.ok(has(findings, 'untrusted-retrieval-source'), 'high present');
  assert.ok(has(findings, 'unverified-memory-write'), 'medium present');
  assert.equal(has(findings, 'retrieval-sources-enumerated'), false, 'no positive when findings exist');
  assert.equal(has(findings, 'rag-memory-untested'), false, 'activity is not untested');
  assert.equal(summary.by_severity.high, 1);
  assert.equal(summary.by_severity.medium, 1);
});
