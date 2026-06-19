// tests/receipt-export-registry.test.js
//
// Focused unit coverage for src/receipt-export-registry.js: descriptor registry,
// generic subjects/predicate, dispatcher fallback, proof-scope gate, durable
// queue, and the OMS member manifest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { canonicalJson } from '../src/cid.js';
import { receiptSubjects, buildInferencePredicate } from '../src/intoto-receipt.js';
import {
  resolveReceiptExport,
  genericReceiptSubjects,
  genericBuildPredicate,
  getReceiptDescriptor,
  listReceiptClasses,
  registerReceiptClass,
  proofScopeLabel,
  PROOF_SCOPE,
  makeDurableAnchorQueue,
  omsMemberList,
  toOmsArtifactManifest,
  KOLM_TOOLCALL_PREDICATE_TYPE,
  KOLM_INFERENCE_PREDICATE_TYPE,
  KOLM_RECEIPT_PREDICATE_TYPE,
} from '../src/receipt-export-registry.js';

test('registry has kolm-audit-1 + MCP tool-call descriptors built in', () => {
  const classes = listReceiptClasses();
  assert.ok(classes.includes('kolm-audit-1'));
  assert.ok(classes.includes('mcp-tool-call-1'));
  assert.ok(classes.includes('mcp-tool-call-2'));
  assert.ok(classes.includes('mcp-tool-call-3'));
  assert.equal(getReceiptDescriptor('kolm-audit-1').predicateType, KOLM_INFERENCE_PREDICATE_TYPE);
  assert.equal(getReceiptDescriptor('mcp-tool-call-1').predicateType, KOLM_TOOLCALL_PREDICATE_TYPE);
  assert.equal(getReceiptDescriptor('mcp-tool-call-2').predicateType, KOLM_TOOLCALL_PREDICATE_TYPE);
  assert.equal(getReceiptDescriptor('mcp-tool-call-3').predicateType, KOLM_TOOLCALL_PREDICATE_TYPE);
});

test('kolm-audit-1 generic functions == legacy intoto-receipt functions', () => {
  const r = {
    schema: 'kolm-audit-1',
    receipt_id: 'rcpt_X',
    timestamp: '2026-01-01T00:00:00.000Z',
    provider: 'anthropic',
    model: 'claude',
    output_hash: 'sha256:' + 'a'.repeat(32),
    signature_ed25519: { alg: 'ed25519', key_fingerprint: 'kf', signed_at: 't' },
  };
  const d = getReceiptDescriptor('kolm-audit-1');
  assert.deepEqual(genericReceiptSubjects(r, d), receiptSubjects(r));
  assert.deepEqual(genericBuildPredicate(r, d), buildInferencePredicate(r));
});

test('content subjects dropped when hash field absent/unparseable (never fabricate)', () => {
  const r = { schema: 'mcp-tool-call-1', call_id: 'c1', args_hash: 'not-a-hash', result_hash: 'sha256:' + 'b'.repeat(64) };
  const ex = resolveReceiptExport(r);
  assert.equal(ex.subjects[0].digest.blake2b.length, 128, 'receipt subject carries multi-algorithm digest map');
  // args dropped (unparseable), result kept.
  assert.ok(!ex.subjects.find((s) => s.name === 'args:c1'));
  assert.ok(ex.subjects.find((s) => s.name === 'result:c1'));
});

test('truncated short hash flagged truncated:true; full 64-hex truncated:false', () => {
  const short = resolveReceiptExport({ schema: 'mcp-tool-call-1', call_id: 'c', args_hash: 'sha256:' + 'a'.repeat(16) });
  const full = resolveReceiptExport({ schema: 'mcp-tool-call-1', call_id: 'c', args_hash: 'sha256:' + 'a'.repeat(64) });
  assert.equal(short.subjects.find((s) => s.name === 'args:c').annotations.truncated, true);
  assert.equal(full.subjects.find((s) => s.name === 'args:c').annotations.truncated, false);
});

test('dispatcher falls back to generic descriptor for unknown schema', () => {
  const ex = resolveReceiptExport({ schema: 'xyz-9', receipt_id: 'r9', a: 1 });
  assert.equal(ex.predicateType, KOLM_RECEIPT_PREDICATE_TYPE);
  assert.equal(ex.subjects.length, 1);
  assert.equal(ex.subjects[0].name, 'receipt:r9');
});

test('generic descriptor auto-detects id from receipt_id || call_id || id', () => {
  assert.equal(resolveReceiptExport({ schema: 'u', call_id: 'cc' }).subjects[0].name, 'receipt:cc');
  assert.equal(resolveReceiptExport({ schema: 'u', id: 'ii' }).subjects[0].name, 'receipt:ii');
  assert.equal(resolveReceiptExport({ schema: 'u' }).subjects[0].name, 'receipt:unknown');
});

test('registerReceiptClass adds a new descriptor', () => {
  registerReceiptClass('custom-1', { idField: 'cid_field', predicateType: 'https://x/y', predicateFields: ['a', 'b'], predicateKey: 'custom' });
  const ex = resolveReceiptExport({ schema: 'custom-1', cid_field: 'z9', a: 1, b: 2, c: 3 });
  assert.equal(ex.subjects[0].name, 'receipt:z9');
  assert.equal(ex.predicateType, 'https://x/y');
  assert.deepEqual(ex.predicate.custom, { a: 1, b: 2 });
});

test('proofScopeLabel gate', () => {
  assert.equal(proofScopeLabel(undefined), PROOF_SCOPE.KEY_CUSTODY);
  assert.equal(proofScopeLabel({ verifier: 'shape_v1', verified: false }), PROOF_SCOPE.KEY_CUSTODY);
  assert.equal(proofScopeLabel({ verifier: 'none', verified: true }), PROOF_SCOPE.KEY_CUSTODY);
  assert.equal(proofScopeLabel({ verifier: 'nras', verified: true }), PROOF_SCOPE.PROVEN_COMPUTE);
  assert.equal(proofScopeLabel({ verifier: 'pccs', verified: true }), PROOF_SCOPE.PROVEN_COMPUTE);
});

test('makeDurableAnchorQueue no-store is a pass-through no-op', async () => {
  const q = makeDurableAnchorQueue();
  assert.equal(q.durable, false);
  assert.equal(q.record({ receipt_id: 'a', leaf: 'ff' }), false);
  assert.deepEqual(await q.recover(), { ok: true, recovered: 0, rows: [] });
});

test('makeDurableAnchorQueue with store persists + recovers', async () => {
  const rows = [];
  const store = { put: (r) => rows.push(r), list: () => rows.slice(), clear: () => { rows.length = 0; } };
  const q = makeDurableAnchorQueue({ store, flushFn: async () => ({ ok: true }) });
  assert.equal(q.durable, true);
  q.record({ receipt_id: 'r1', leaf: Buffer.from('aa', 'hex'), schema: 's' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].leaf_hex, 'aa');
  const rec = await q.recover();
  assert.equal(rec.recovered, 1);
  assert.equal(rows.length, 0);
});

test('omsMemberList excludes seals + sorts; toOmsArtifactManifest hashes match', () => {
  const files = [
    { filename: 'manifest.json', content: Buffer.from('M') },
    { filename: 'recipes.json', content: Buffer.from('R') },
    { filename: 'model.sig.bundle', content: Buffer.from('SEAL') },
    { filename: 'provenance.intoto.dsse.json', content: Buffer.from('SEAL2') },
  ];
  const members = omsMemberList(files);
  assert.deepEqual(members.map((m) => m.name), ['manifest.json', 'recipes.json']);
  const stmt = toOmsArtifactManifest(members);
  for (const s of stmt.subject) {
    const f = files.find((x) => x.filename === s.name);
    assert.equal(s.digest.sha256, crypto.createHash('sha256').update(f.content).digest('hex'));
  }
});

test('toOmsArtifactManifest throws on no valid members', () => {
  assert.throws(() => toOmsArtifactManifest([]));
  assert.throws(() => toOmsArtifactManifest([{ name: 'x', sha256: 'short' }]));
});
