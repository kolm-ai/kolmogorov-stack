// Agent Security-Review audit — audit-trail analyzer lock-in tests.
//
// Pins src/audit-trail-analyzer.js: completeness, tamper-evidence, and
// retention checks against EU AI Act Art.12-style record-keeping, including
// the high-severity "no tamper-evident trail" gap (~1 in 3 agents) and the
// positive finding on a complete, chained trail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent } from '../src/audit-event.js';
import { analyzeAuditTrail } from '../src/audit-trail-analyzer.js';

function evt(p) { return normalizeEvent(p); }
function has(findings, id) { return findings.some((f) => f.id === id); }
function get(findings, id) { return findings.find((f) => f.id === id); }

test('analyzeAuditTrail never throws on empty / bad input', () => {
  for (const bad of [undefined, null, 'x', 42, [], [null]]) {
    const r = analyzeAuditTrail(bad);
    assert.ok(Array.isArray(r.findings));
    assert.ok(r.coverage && typeof r.coverage === 'object');
  }
  assert.equal(analyzeAuditTrail([]).findings.length, 0, 'empty trail → no findings');
});

test('no hash chain → high-severity no-tamper-evidence', () => {
  const events = [
    evt({ id: 'a', ts: '2026-05-01T00:00:00Z', actor: { key_id: 'k1' }, action: { tool: 'read_a' } }),
    evt({ id: 'b', ts: '2026-05-02T00:00:00Z', actor: { key_id: 'k1' }, action: { tool: 'read_b' } }),
  ];
  const { findings } = analyzeAuditTrail(events);
  const f = get(findings, 'no-tamper-evidence');
  assert.ok(f, 'no-tamper-evidence present');
  assert.equal(f.severity, 'high');
});

test('a broken hash link is critical', () => {
  const events = [
    evt({ id: 'a', ts: '2026-05-01T00:00:00Z', actor: { key_id: 'k1' }, action: { tool: 'x' }, hash: 'h1' }),
    evt({ id: 'b', ts: '2026-05-02T00:00:00Z', actor: { key_id: 'k1' }, action: { tool: 'y' }, hash: 'h2', prev_hash: 'WRONG' }),
  ];
  const { findings } = analyzeAuditTrail(events);
  const f = get(findings, 'broken-hash-chain');
  assert.ok(f, 'broken-hash-chain present');
  assert.equal(f.severity, 'critical');
});

test('missing / unparseable timestamps are reported', () => {
  const events = [
    evt({ id: 'a', ts: '2026-05-01T00:00:00Z', actor: { key_id: 'k1' }, action: { tool: 'x' }, hash: 'h1' }),
    evt({ id: 'b', ts: null, actor: { key_id: 'k1' }, action: { tool: 'y' }, hash: 'h2', prev_hash: 'h1' }),
    evt({ id: 'c', ts: 'not-a-date', actor: { key_id: 'k1' }, action: { tool: 'z' }, hash: 'h3', prev_hash: 'h2' }),
  ];
  const { findings, coverage } = analyzeAuditTrail(events);
  assert.ok(has(findings, 'incomplete-timestamps'), 'incomplete-timestamps present');
  assert.equal(coverage.missing_timestamp, 1);
  assert.equal(coverage.unparseable_timestamp, 1);
});

test('unattributed events break traceability', () => {
  const events = [
    evt({ id: 'a', ts: '2026-05-01T00:00:00Z', actor: {}, action: { tool: 'x' }, hash: 'h1' }),
    evt({ id: 'b', ts: '2026-05-02T00:00:00Z', actor: {}, action: { tool: 'y' }, hash: 'h2', prev_hash: 'h1' }),
  ];
  const { findings, coverage } = analyzeAuditTrail(events);
  assert.ok(has(findings, 'unattributed-events'), 'unattributed-events present');
  assert.equal(coverage.unattributed, 2);
});

test('no usable timestamps → retention is unverifiable', () => {
  const events = [
    evt({ id: 'a', ts: null, actor: { key_id: 'k1' }, action: { tool: 'x' }, hash: 'h1' }),
  ];
  const { findings } = analyzeAuditTrail(events);
  assert.ok(has(findings, 'retention-unverifiable'), 'retention-unverifiable present');
});

test('a complete, chained, well-retained trail yields the positive finding', () => {
  const events = [
    evt({ id: 'a', ts: '2026-01-01T00:00:00Z', actor: { key_id: 'k1' }, action: { tool: 'read_a' }, hash: 'h1' }),
    evt({ id: 'b', ts: '2026-09-01T00:00:00Z', actor: { key_id: 'k1' }, action: { tool: 'read_b' }, hash: 'h2', prev_hash: 'h1' }),
  ];
  const { findings, summary, coverage } = analyzeAuditTrail(events);
  assert.equal(findings.length, 1, 'only the positive finding');
  assert.equal(findings[0].id, 'audit-trail-complete');
  assert.equal(findings[0].severity, 'info');
  assert.equal(summary.tamper_evident, true);
  assert.ok(coverage.span_days > 182, 'span exceeds the retention window');
});

test('epoch timestamps (unix seconds and ms) are parsed, not misreported', () => {
  // Sources routinely log integer epochs; normalizeEvent stringifies them.
  // Both seconds and millisecond forms must count as usable timestamps.
  const events = [
    evt({ id: 'a', ts: 1735689600, actor: { key_id: 'k1' }, action: { tool: 'x' }, hash: 'h1' }),        // 2025-01-01 (s)
    evt({ id: 'b', ts: 1751328000000, actor: { key_id: 'k1' }, action: { tool: 'y' }, hash: 'h2', prev_hash: 'h1' }), // 2025-07-01 (ms)
  ];
  const { findings, coverage } = analyzeAuditTrail(events);
  assert.equal(coverage.missing_timestamp, 0, 'epoch values are not missing');
  assert.equal(coverage.unparseable_timestamp, 0, 'epoch values are not unparseable');
  assert.equal(has(findings, 'incomplete-timestamps'), false, 'no false timestamp gap');
  assert.ok(coverage.span_days > 100, 'span derived across the two epochs');
});

// Regression: a position-based walk reported an intact chain as CRITICAL broken
// whenever events were not in chain order — but real exports are newest-first
// (ORDER BY ts DESC) or merged. Chain integrity must be order-independent.
test('an intact chain is not falsely broken by event order (newest-first / shuffled)', () => {
  const mk = (id, ts, hash, prev) => evt({ id, ts, actor: { key_id: 'k1' }, action: { tool: id }, hash, prev_hash: prev });
  const a = mk('a', '2026-01-01T00:00:00Z', 'h1', null);
  const b = mk('b', '2026-05-01T00:00:00Z', 'h2', 'h1');
  const c = mk('c', '2026-09-01T00:00:00Z', 'h3', 'h2');
  for (const order of [[a, b, c], [c, b, a], [a, c, b]]) {
    const r = analyzeAuditTrail(order);
    assert.equal(r.coverage.chain_links_broken, 0, `intact chain stays intact in order ${order.map((e) => e.id)}`);
    assert.equal(r.summary.tamper_evident, true);
    assert.equal(has(r.findings, 'broken-hash-chain'), false);
  }
  // A genuinely dangling prev_hash is still caught regardless of order.
  const bad = analyzeAuditTrail([c, mk('b', '2026-05-01T00:00:00Z', 'h2', 'MISSING'), a]);
  assert.ok(has(bad.findings, 'broken-hash-chain'), 'real tamper still flagged');
});

test('configurable retention window is honoured', () => {
  const events = [
    evt({ id: 'a', ts: '2026-05-01T00:00:00Z', actor: { key_id: 'k1' }, action: { tool: 'x' }, hash: 'h1' }),
    evt({ id: 'b', ts: '2026-05-03T00:00:00Z', actor: { key_id: 'k1' }, action: { tool: 'y' }, hash: 'h2', prev_hash: 'h1' }),
  ];
  const { findings } = analyzeAuditTrail(events, { retentionDays: 1 });
  assert.equal(has(findings, 'short-retention-window'), false, '2-day span clears a 1-day window');
  assert.ok(has(findings, 'audit-trail-complete'), 'clean trail under a 1-day window');
});
