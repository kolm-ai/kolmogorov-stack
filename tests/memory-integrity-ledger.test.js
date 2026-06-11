// Agent Security-Review audit - Memory Integrity Ledger lock-in tests (ASR-7).
//
// Pins src/memory-integrity-ledger.js: hash-chains every observed memory WRITE
// op and proves whether any stored memory was altered between writes.
//
//   - zero writes        -> untested + chain_intact:null, NO clean finding
//   - clean write stream  -> chain_intact:true, 0 findings
//   - tampered link       -> 'memory-integrity-broken' (high, ASR-7) emitted
//
// Non-inflation: an unexercised control is never a silent pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  analyzeMemoryIntegrity,
  MEMORY_LEDGER_SPEC_VERSION,
} from '../src/memory-integrity-ledger.js';

function has(findings, id) { return findings.some((f) => f.id === id); }
function get(findings, id) { return findings.find((f) => f.id === id); }

function sha256Hex(s) {
  return crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
}
const GENESIS_PREV = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');

// Recompute the same canonical content_hash the module uses, for a derived
// (non-declared) write record, so the test can forge a matching/mismatching link.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

test('never throws on empty / bad input and returns a valid shape', () => {
  for (const bad of [undefined, null, 'x', 42, [], {}, { memory_ops: null }]) {
    const r = analyzeMemoryIntegrity(bad);
    assert.equal(r.spec_version, MEMORY_LEDGER_SPEC_VERSION);
    assert.ok(Array.isArray(r.ledger), 'ledger is an array');
    assert.ok(Array.isArray(r.findings), 'findings is an array');
    assert.ok(r.summary && typeof r.summary === 'object', 'summary present');
  }
});

test('no writes observed -> untested + chain_intact null, no clean finding', () => {
  // Reads-only memory ops (op:read, writes:0) and an empty list both count as
  // zero writes: an unexercised poisoning surface.
  for (const ragMemory of [
    { memory_ops: [] },
    { memory_ops: [{ tool: 'recall_fact', op: 'read', writes: 0, reads: 3 }] },
  ]) {
    const r = analyzeMemoryIntegrity(ragMemory);
    assert.equal(r.summary.untested, true, 'untested');
    assert.equal(r.chain_intact, null, 'chain_intact is null, NOT false/true');
    assert.equal(r.ledger.length, 0, 'empty ledger');
    assert.equal(r.findings.length, 0, 'NO finding emitted (no clean pass)');
  }
});

test('clean write sequence -> chain_intact true and 0 findings', () => {
  const ragMemory = {
    memory_ops: [
      { tool: 'store_fact', op: 'write', tier: 2, writes: 2, reads: 0, integrity: true, attribution: true },
      { tool: 'context_store', op: 'write', tier: 2, writes: 1, reads: 0, integrity: true, attribution: true },
    ],
  };
  const r = analyzeMemoryIntegrity(ragMemory);
  assert.equal(r.summary.untested, false, 'exercised');
  assert.equal(r.chain_intact, true, 'chain intact');
  assert.equal(r.summary.writes, 3, 'three writes ledgered');
  assert.equal(r.ledger.length, 3);
  assert.equal(r.findings.length, 0, 'no findings on a clean chain');

  // Ledger is a real hash-chain: genesis prev, then each prev === prior link.
  assert.equal(r.ledger[0].prev, GENESIS_PREV, 'genesis predecessor');
  for (let i = 1; i < r.ledger.length; i++) {
    assert.equal(r.ledger[i].prev, r.ledger[i - 1].link_hash, `link ${i} chains the prior`);
  }
  // link_hash = SHA256(prev || content_hash) - verifiable offline.
  for (const e of r.ledger) {
    assert.equal(e.link_hash, sha256Hex(e.prev + e.content_hash), 'link reconciles');
    assert.match(e.content_hash, /^[0-9a-f]{64}$/, 'content_hash is sha256 hex');
  }
});

test('clean sequence with DECLARED matching links stays intact (no finding)', () => {
  // First derive the canonical content_hash + link_hash for two writes, then
  // feed them back as declared values: a correct gateway chain reconciles.
  const recA = { tool: 'store_fact', op: 'write', tier: 2, seq_in_op: 0, integrity: true, attribution: true };
  const recB = { tool: 'store_fact', op: 'write', tier: 2, seq_in_op: 1, integrity: true, attribution: true };
  const chA = sha256Hex(canonical(recA));
  const linkA = sha256Hex(GENESIS_PREV + chA);
  const chB = sha256Hex(canonical(recB));
  const linkB = sha256Hex(linkA + chB);

  const ragMemory = {
    memory_ops: [{
      tool: 'store_fact', op: 'write', tier: 2, writes: 2,
      writes_detail: [
        { key: 'fact:1', content: recA, content_hash: chA, link_hash: linkA, id: 'ev-a' },
        { key: 'fact:2', content: recB, content_hash: chB, link_hash: linkB, id: 'ev-b' },
      ],
    }],
  };
  const r = analyzeMemoryIntegrity(ragMemory);
  assert.equal(r.chain_intact, true, 'declared links reconcile -> intact');
  assert.equal(r.findings.length, 0, 'no finding when declared links match');
  assert.equal(r.ledger[0].key, 'fact:1');
});

test('tampered link -> memory-integrity-broken finding (high, ASR-7 pillar)', () => {
  const ragMemory = {
    memory_ops: [{
      tool: 'store_fact', op: 'write', tier: 2, writes: 2,
      writes_detail: [
        { key: 'fact:1', content: { v: 'alpha' }, id: 'ev-1' },
        // declared link hash that cannot match the recomputed chain: a stored
        // memory was altered between writes / the chain was forged.
        { key: 'fact:2', content: { v: 'beta' }, link_hash: 'deadbeef'.repeat(8), id: 'ev-2' },
      ],
    }],
  };
  const r = analyzeMemoryIntegrity(ragMemory);
  assert.equal(r.chain_intact, false, 'chain broken');
  assert.ok(has(r.findings, 'memory-integrity-broken'), 'finding emitted');
  const f = get(r.findings, 'memory-integrity-broken');
  assert.equal(f.severity, 'high', 'high severity');
  assert.equal(f.pillar, 'rag-memory', 'ASR-7 pillar so it flows to the rollup');
  assert.equal(f.analyzer, 'memory-integrity-ledger');
  assert.equal(f.metric.broken_links, 1);
  assert.ok(f.evidence.includes('ev-2'), 'carries the tampered event evidence');
  assert.equal(r.summary.by_severity.high, 1);
});
