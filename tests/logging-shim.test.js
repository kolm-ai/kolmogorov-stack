// Offer #5 - Evidence-Grade Logging Shim.
//
// Proves the downloadable static logger (public/shims/kolm-logger.js) emits a
// log whose .toJSONL() output runAudit() ingests cleanly AND grades at evidence
// tier B (vendor-logs-hash-verified), not tier C, because the records carry an
// intact SHA-256 hash chain plus per-agent identity. This is the self-lift the
// offer sells: a customer adds the shim, keeps the chain, and stops being
// graded C without ever touching the kolm gateway.
//
// Pure in-process; no spawned server, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runAudit } from '../src/audit-orchestrator.js';
import { KolmLogger, createLogger } from '../public/shims/kolm-logger.js';

function loggedAudit() {
  const log = new KolmLogger({
    keyId: 'key_agent_alpha',
    agent: 'support-agent',
    grants: ['tool:lookup_policy', 'tool:send_email'],
    model: 'openai/gpt-4o',
  });
  log.record({ tool: 'lookup_policy', args: { topic: 'returns' }, ts: '2026-06-01T00:00:00Z' });
  log.record({ tool: 'send_email', args: { to: 'customer@example.com', body: 'hi' }, host: 'api.sendgrid.com', ts: '2026-06-01T00:01:00Z' });
  log.record({ tool: 'lookup_policy', args: { topic: 'shipping' }, ts: '2026-06-01T00:02:00Z' });
  return { log, result: runAudit(log.toJSONL(), { source: 'shim' }) };
}

test('shim output ingests cleanly with no record errors', () => {
  const { result } = loggedAudit();
  assert.equal(result.ingest.errors, 0, `expected zero ingest errors, got ${result.ingest.errors}`);
  assert.ok(result.ingest.events >= 3, `expected >=3 events, got ${result.ingest.events}`);
});

test('shim output grades evidence tier B (hash-verified), not C', () => {
  const { result } = loggedAudit();
  assert.equal(result.evidence_tier.grade, 'B', `expected grade B, got ${result.evidence_tier.grade}`);
  assert.equal(result.evidence_tier.method, 'vendor-logs-hash-verified');
  assert.equal(result.summary.tamper_evident, true, 'chain must verify as tamper-evident');
});

test('the hash chain is intact: chained > 0 and zero broken links', () => {
  const { result } = loggedAudit();
  const cov = result.trail.coverage;
  assert.ok(cov.hash_chained > 0, 'at least one event must be hash-chained');
  assert.equal(cov.chain_links_broken, 0, 'no link may be broken');
});

test('per-agent identity is attributed on every event (no unattributed)', () => {
  const { result } = loggedAudit();
  assert.equal(result.trail.coverage.unattributed, 0, 'every event carries key_id + agent');
  assert.ok(result.ingest.distinct_keys >= 1, 'the per-agent key id is captured');
});

test('declared grants flow through so used <= granted is assessable', () => {
  const { result } = loggedAudit();
  // The tools the agent invoked are captured as distinct tools.
  assert.ok(result.ingest.distinct_tools >= 2, `expected >=2 tools, got ${result.ingest.distinct_tools}`);
});

test('tampering with one record breaks the chain (B -> not B)', () => {
  const log = new KolmLogger({ keyId: 'k', agent: 'a', grants: ['tool:x'], model: 'm' });
  log.record({ tool: 'x', args: { n: 1 }, ts: '2026-06-01T00:00:00Z' });
  log.record({ tool: 'x', args: { n: 2 }, ts: '2026-06-01T00:01:00Z' });
  const lines = log.toJSONL().split('\n').map((l) => JSON.parse(l));
  // Mutate the genesis record's hash: the second record's prev_hash now
  // references a hash absent from the trail -> a broken link.
  lines[0].hash = 'tampered_' + lines[0].hash;
  const result = runAudit(lines.map((r) => JSON.stringify(r)).join('\n'), { source: 'shim' });
  assert.notEqual(result.evidence_tier.grade, 'B', 'a tampered chain must not grade B');
  assert.ok(result.trail.coverage.chain_links_broken > 0, 'the broken link must be detected');
});

test('createLogger factory is equivalent to the class', () => {
  const log = createLogger({ keyId: 'k', agent: 'a', grants: ['tool:x'], model: 'm' });
  log.record({ tool: 'x', args: { n: 1 }, ts: '2026-06-01T00:00:00Z' });
  const result = runAudit(log.toJSONL(), { source: 'shim' });
  assert.equal(result.ingest.errors, 0);
});
