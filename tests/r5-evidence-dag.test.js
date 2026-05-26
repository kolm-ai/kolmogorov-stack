// R-5 — Evidence DAG tests.
//
// Pins:
//   1. EVIDENCE_KINDS / EVIDENCE_RELATIONSHIPS are stable identifier lists.
//   2. buildDag rejects unknown kinds + unknown relationships + duplicate ids
//      + self-loops + missing endpoints.
//   3. trace(dag, id) returns the full ancestor chain (every transitive `to`
//      reachable from `id`).
//   4. revoke propagates: revoking capture C surfaces every artifact derived
//      transitively from C in needs_review.
//   5. Cycle detection rejects circular edges (A -> B -> A; A -> B -> C -> A).
//   6. The artifact manifest carries evidence_dag conditionally (the W460
//      byte-stability rule: absent input -> manifest key absent).
//   7. /v1/evidence/:id returns node detail and 404s on unknown ids.
//   8. /v1/evidence/:id/revoke returns the needs_review list.
//   9. /v1/artifacts/:id/evidence-trace returns the ancestor DAG for an
//      artifact when the manifest carries one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Isolate data/home dirs so we never touch a developer's real ~/.kolm.
const TEST_DATA_DIR = path.join(os.tmpdir(), 'kolm-r5-' + crypto.randomBytes(4).toString('hex'));
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.KOLM_DATA_DIR = TEST_DATA_DIR;
process.env.KOLM_HOME = TEST_DATA_DIR;
process.env.HOME = TEST_DATA_DIR;
process.env.USERPROFILE = TEST_DATA_DIR;
// Receipt secret so artifact.buildPayload doesn't 503 in this test process.
process.env.RECIPE_RECEIPT_SECRET = process.env.RECIPE_RECEIPT_SECRET || 'r5-test-secret';

const dagMod = await import('../src/evidence-dag.js');

// =============================================================================
// 1) Stable identifier lists
// =============================================================================

test('R5 #1 — EVIDENCE_KINDS + EVIDENCE_RELATIONSHIPS are stable lists', () => {
  assert.deepEqual(
    [...dagMod.EVIDENCE_KINDS].sort(),
    ['capture', 'eval', 'policy', 'rights', 'runtime', 'signature', 'student', 'teacher'],
  );
  assert.deepEqual(
    [...dagMod.EVIDENCE_RELATIONSHIPS].sort(),
    ['derived_from', 'invalidates', 'supersedes', 'validated_by'],
  );
  assert.equal(dagMod.EVIDENCE_DAG_SCHEMA_VERSION, 'kolm-evidence-dag-1');
});

// =============================================================================
// 2) Validation rejects unknown kinds + unknown relationships
// =============================================================================

test('R5 #2a — buildDag rejects unknown kinds', () => {
  assert.throws(
    () => dagMod.buildDag({ nodes: [{ id: 'n1', kind: 'made-up' }], edges: [] }),
    /kind invalid: "made-up"/,
  );
});

test('R5 #2b — buildDag rejects unknown relationships', () => {
  assert.throws(
    () => dagMod.buildDag({
      nodes: [{ id: 'a', kind: 'capture' }, { id: 'b', kind: 'eval' }],
      edges: [{ from: 'b', to: 'a', relationship: 'caused_by' }],
    }),
    /relationship invalid: "caused_by"/,
  );
});

test('R5 #2c — buildDag rejects edges referencing unknown nodes', () => {
  assert.throws(
    () => dagMod.buildDag({
      nodes: [{ id: 'a', kind: 'capture' }],
      edges: [{ from: 'a', to: 'ghost', relationship: 'derived_from' }],
    }),
    /references unknown node "ghost"/,
  );
});

test('R5 #2d — buildDag rejects duplicate node ids', () => {
  assert.throws(
    () => dagMod.buildDag({
      nodes: [{ id: 'a', kind: 'capture' }, { id: 'a', kind: 'eval' }],
      edges: [],
    }),
    /duplicate node id "a"/,
  );
});

test('R5 #2e — buildDag rejects self-loops', () => {
  assert.throws(
    () => dagMod.buildDag({
      nodes: [{ id: 'a', kind: 'capture' }],
      edges: [{ from: 'a', to: 'a', relationship: 'derived_from' }],
    }),
    /self-loop/,
  );
});

test('R5 #2f — buildDag rejects malformed input shapes', () => {
  assert.throws(() => dagMod.buildDag(null), /input must be an object/);
  assert.throws(() => dagMod.buildDag({ nodes: null, edges: [] }), /nodes must be an array/);
  assert.throws(() => dagMod.buildDag({ nodes: [], edges: null }), /edges must be an array/);
});

test('R5 #2g — buildDag accepts a well-formed empty DAG', () => {
  const d = dagMod.buildDag({ nodes: [], edges: [] });
  assert.equal(d.nodes.length, 0);
  assert.equal(d.edges.length, 0);
});

// =============================================================================
// 3) trace returns full ancestor chain
// =============================================================================

test('R5 #3 — trace returns the full ancestor chain', () => {
  // Shape:
  //   cap1, cap2 -> eval1 -> student1
  //   cap1, cap2 -> eval1 (validated_by both captures)
  //   student1 derived_from teacher1, teacher1 derived_from eval1
  const dag = dagMod.buildDag({
    nodes: [
      { id: 'cap1', kind: 'capture' },
      { id: 'cap2', kind: 'capture' },
      { id: 'eval1', kind: 'eval' },
      { id: 'teacher1', kind: 'teacher' },
      { id: 'student1', kind: 'student' },
    ],
    edges: [
      { from: 'eval1', to: 'cap1', relationship: 'validated_by' },
      { from: 'eval1', to: 'cap2', relationship: 'validated_by' },
      { from: 'teacher1', to: 'eval1', relationship: 'derived_from' },
      { from: 'student1', to: 'teacher1', relationship: 'derived_from' },
    ],
  });
  const t = dagMod.trace(dag, 'student1');
  assert.equal(t.node.id, 'student1');
  const ids = t.ancestors.map((n) => n.id).sort();
  assert.deepEqual(ids, ['cap1', 'cap2', 'eval1', 'teacher1']);
  // trace on a leaf (cap1) returns the node + no ancestors.
  const leaf = dagMod.trace(dag, 'cap1');
  assert.equal(leaf.node.id, 'cap1');
  assert.equal(leaf.ancestors.length, 0);
  // trace on unknown id returns null node + empty ancestors.
  const ghost = dagMod.trace(dag, 'no-such-id');
  assert.equal(ghost.node, null);
  assert.equal(ghost.ancestors.length, 0);
});

// =============================================================================
// 4) revoke propagation
// =============================================================================

test('R5 #4a — revoking a capture flags every derived artifact', () => {
  const dag = dagMod.buildDag({
    nodes: [
      { id: 'cap1', kind: 'capture' },
      { id: 'cap2', kind: 'capture' },
      { id: 'eval1', kind: 'eval' },
      { id: 'eval2', kind: 'eval' },
      { id: 'teacher1', kind: 'teacher' },
      { id: 'student1', kind: 'student' },
      { id: 'student2', kind: 'student' },
    ],
    edges: [
      // eval1 validated_by cap1 + cap2
      { from: 'eval1', to: 'cap1', relationship: 'validated_by' },
      { from: 'eval1', to: 'cap2', relationship: 'validated_by' },
      // eval2 only validated_by cap2
      { from: 'eval2', to: 'cap2', relationship: 'validated_by' },
      // teacher1 derived from eval1
      { from: 'teacher1', to: 'eval1', relationship: 'derived_from' },
      // student1 derived from teacher1 (so cap1 + cap2 reach student1)
      { from: 'student1', to: 'teacher1', relationship: 'derived_from' },
      // student2 derived from eval2 directly (does NOT depend on cap1)
      { from: 'student2', to: 'eval2', relationship: 'derived_from' },
    ],
  });
  // Revoke cap1 — eval1, teacher1, student1 must be needs_review.
  // student2 must NOT be in needs_review (it only derives from cap2 via eval2).
  const r1 = dagMod.revoke(dag, 'cap1');
  assert.deepEqual(r1.revoked, ['cap1']);
  const flagged1 = r1.needs_review.slice().sort();
  assert.deepEqual(flagged1, ['eval1', 'student1', 'teacher1']);
  // Revoke cap2 — eval1, eval2, teacher1, student1, student2 all surface.
  const r2 = dagMod.revoke(dag, 'cap2');
  assert.deepEqual(r2.revoked, ['cap2']);
  const flagged2 = r2.needs_review.slice().sort();
  assert.deepEqual(flagged2, ['eval1', 'eval2', 'student1', 'student2', 'teacher1']);
});

test('R5 #4b — revoking an unknown node returns an error envelope', () => {
  const dag = dagMod.buildDag({
    nodes: [{ id: 'cap1', kind: 'capture' }],
    edges: [],
  });
  const r = dagMod.revoke(dag, 'no-such-id');
  assert.deepEqual(r.revoked, []);
  assert.deepEqual(r.needs_review, []);
  assert.match(r.error, /unknown_node:no-such-id/);
});

test('R5 #4c — revoking a leaf with no descendants returns empty needs_review', () => {
  const dag = dagMod.buildDag({
    nodes: [
      { id: 'cap1', kind: 'capture' },
      { id: 'eval1', kind: 'eval' },
    ],
    edges: [{ from: 'eval1', to: 'cap1', relationship: 'validated_by' }],
  });
  // Revoke eval1 (the leaf of the reverse graph — nothing derives from it).
  const r = dagMod.revoke(dag, 'eval1');
  assert.deepEqual(r.revoked, ['eval1']);
  assert.deepEqual(r.needs_review, []);
});

// =============================================================================
// 5) Cycle detection
// =============================================================================

test('R5 #5a — buildDag rejects a 2-node cycle A -> B -> A', () => {
  assert.throws(
    () => dagMod.buildDag({
      nodes: [{ id: 'A', kind: 'capture' }, { id: 'B', kind: 'eval' }],
      edges: [
        { from: 'A', to: 'B', relationship: 'derived_from' },
        { from: 'B', to: 'A', relationship: 'derived_from' },
      ],
    }),
    /cycle detected/,
  );
});

test('R5 #5b — buildDag rejects a 3-node cycle A -> B -> C -> A', () => {
  assert.throws(
    () => dagMod.buildDag({
      nodes: [
        { id: 'A', kind: 'capture' },
        { id: 'B', kind: 'eval' },
        { id: 'C', kind: 'teacher' },
      ],
      edges: [
        { from: 'A', to: 'B', relationship: 'derived_from' },
        { from: 'B', to: 'C', relationship: 'derived_from' },
        { from: 'C', to: 'A', relationship: 'derived_from' },
      ],
    }),
    /cycle detected/,
  );
});

test('R5 #5c — buildDag accepts a diamond (shared ancestor + descendant)', () => {
  // root -> a, root -> b, a -> sink, b -> sink. Diamond is acyclic.
  const d = dagMod.buildDag({
    nodes: [
      { id: 'root', kind: 'capture' },
      { id: 'a', kind: 'eval' },
      { id: 'b', kind: 'eval' },
      { id: 'sink', kind: 'student' },
    ],
    edges: [
      { from: 'a', to: 'root', relationship: 'validated_by' },
      { from: 'b', to: 'root', relationship: 'validated_by' },
      { from: 'sink', to: 'a', relationship: 'derived_from' },
      { from: 'sink', to: 'b', relationship: 'derived_from' },
    ],
  });
  // Traversal must terminate and deduplicate 'root'.
  const t = dagMod.trace(d, 'sink');
  const ids = t.ancestors.map((n) => n.id).sort();
  assert.deepEqual(ids, ['a', 'b', 'root']);
});

// =============================================================================
// 6) Artifact manifest carries evidence_dag conditionally
// =============================================================================

test('R5 #6a — buildPayload omits evidence_dag when caller did not pass one', async () => {
  const { buildPayload } = await import('../src/artifact.js');
  const payload = buildPayload({
    job_id: 'r5-omit-' + crypto.randomBytes(2).toString('hex'),
    task: 'r5 omit smoke',
    recipes: [{
      id: 'r1', name: 'r1',
      source: 'function generate(input,lib){return {result:"ok"};}',
      source_hash: 'h_' + crypto.randomBytes(4).toString('hex'),
    }],
    evals: { spec: 'rs-1-evals', n: 0, cases: [] },
    training_stats: { pass_rate_positive: 1.0 },
  });
  const manifest = payload.manifest;
  assert.equal(manifest.evidence_dag, undefined, 'evidence_dag must be absent when caller did not pass one');
});

test('R5 #6b — buildPayload stamps evidence_dag when caller passes one', async () => {
  const { buildPayload } = await import('../src/artifact.js');
  const evidence_dag = {
    nodes: [
      { id: 'cap1', kind: 'capture' },
      { id: 'eval1', kind: 'eval' },
    ],
    edges: [
      { from: 'eval1', to: 'cap1', relationship: 'validated_by' },
    ],
  };
  const payload = buildPayload({
    job_id: 'r5-stamp-' + crypto.randomBytes(2).toString('hex'),
    task: 'r5 stamp smoke',
    recipes: [{
      id: 'r1', name: 'r1',
      source: 'function generate(input,lib){return {result:"ok"};}',
      source_hash: 'h_' + crypto.randomBytes(4).toString('hex'),
    }],
    evals: { spec: 'rs-1-evals', n: 0, cases: [] },
    training_stats: { pass_rate_positive: 1.0 },
    evidence_dag,
  });
  const manifest = payload.manifest;
  assert.ok(manifest.evidence_dag, 'evidence_dag must be present');
  assert.equal(manifest.evidence_dag.nodes.length, 2);
  assert.equal(manifest.evidence_dag.edges.length, 1);
  assert.equal(manifest.evidence_dag_spec_version, 'kolm-evidence-dag-1');
});

test('R5 #6c — buildPayload rejects a malformed evidence_dag (cycle)', async () => {
  const { buildPayload } = await import('../src/artifact.js');
  const cyclic = {
    nodes: [{ id: 'A', kind: 'capture' }, { id: 'B', kind: 'eval' }],
    edges: [
      { from: 'A', to: 'B', relationship: 'derived_from' },
      { from: 'B', to: 'A', relationship: 'derived_from' },
    ],
  };
  assert.throws(
    () => buildPayload({
      job_id: 'r5-bad-' + crypto.randomBytes(2).toString('hex'),
      task: 'r5 bad smoke',
      recipes: [{
        id: 'r1', name: 'r1',
        source: 'function generate(input,lib){return {result:"ok"};}',
        source_hash: 'h_' + crypto.randomBytes(4).toString('hex'),
      }],
      evals: { spec: 'rs-1-evals', n: 0, cases: [] },
      training_stats: { pass_rate_positive: 1.0 },
      evidence_dag: cyclic,
    }),
    /evidence_dag invalid:.*cycle detected/,
  );
});

// =============================================================================
// 7) Router — GET /v1/evidence/:id
// =============================================================================

async function _spinServer(stamper) {
  const express = (await import('express')).default;
  const cookieParser = (await import('cookie-parser')).default;
  const http = await import('node:http');
  const { provisionTenant } = await import('../src/auth.js');
  const { buildRouter } = await import('../src/router.js');
  const tenant = provisionTenant('r5-' + crypto.randomBytes(3).toString('hex'));
  if (typeof stamper === 'function') await stamper(tenant);
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(cookieParser());
  app.use(buildRouter());
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, tenant };
}

test('R5 #7 — GET /v1/evidence/:id returns node detail and 404s on unknown', async () => {
  const { writeEvidenceDag } = await import('../src/evidence-store.js');
  const artifactId = 'r5_art_' + crypto.randomBytes(3).toString('hex');
  writeEvidenceDag(artifactId, {
    nodes: [
      { id: 'cap_xyz', kind: 'capture', note: 'unit test capture' },
      { id: 'eval_xyz', kind: 'eval' },
    ],
    edges: [{ from: 'eval_xyz', to: 'cap_xyz', relationship: 'validated_by' }],
  });
  const { server, port, tenant } = await _spinServer();
  try {
    const ok = await fetch(`http://127.0.0.1:${port}/v1/evidence/cap_xyz`, {
      headers: { authorization: 'Bearer ' + tenant.api_key },
    });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.equal(body.node.id, 'cap_xyz');
    assert.equal(body.node.kind, 'capture');
    assert.equal(body.node.note, 'unit test capture');
    const miss = await fetch(`http://127.0.0.1:${port}/v1/evidence/no_such`, {
      headers: { authorization: 'Bearer ' + tenant.api_key },
    });
    assert.equal(miss.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// =============================================================================
// 8) Router — POST /v1/evidence/:id/revoke
// =============================================================================

test('R5 #8 — POST /v1/evidence/:id/revoke returns needs_review list', async () => {
  const { writeEvidenceDag } = await import('../src/evidence-store.js');
  const artifactId = 'r5_revoke_' + crypto.randomBytes(3).toString('hex');
  writeEvidenceDag(artifactId, {
    nodes: [
      { id: 'cap_v1', kind: 'capture' },
      { id: 'eval_v1', kind: 'eval' },
      { id: 'student_v1', kind: 'student' },
    ],
    edges: [
      { from: 'eval_v1', to: 'cap_v1', relationship: 'validated_by' },
      { from: 'student_v1', to: 'eval_v1', relationship: 'derived_from' },
    ],
  });
  const { server, port, tenant } = await _spinServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/evidence/cap_v1/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tenant.api_key },
      body: JSON.stringify({ reason: 'compromised capture pipeline' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.revoked, ['cap_v1']);
    assert.deepEqual(body.needs_review.sort(), ['eval_v1', 'student_v1']);
    // Reason is required.
    const noReason = await fetch(`http://127.0.0.1:${port}/v1/evidence/cap_v1/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tenant.api_key },
      body: JSON.stringify({}),
    });
    assert.equal(noReason.status, 400);
    const noReasonBody = await noReason.json();
    assert.equal(noReasonBody.error, 'missing_reason');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// =============================================================================
// 9) Router — GET /v1/artifacts/:id/evidence-trace
// =============================================================================

test('R5 #9 — GET /v1/artifacts/:id/evidence-trace returns ancestor DAG', async () => {
  const { writeEvidenceDag } = await import('../src/evidence-store.js');
  const artifactId = 'r5_trace_' + crypto.randomBytes(3).toString('hex');
  writeEvidenceDag(artifactId, {
    nodes: [
      { id: 'cap_t', kind: 'capture' },
      { id: 'eval_t', kind: 'eval' },
      { id: 'art_root', kind: 'student' },
    ],
    edges: [
      { from: 'eval_t', to: 'cap_t', relationship: 'validated_by' },
      { from: 'art_root', to: 'eval_t', relationship: 'derived_from' },
    ],
  });
  const { server, port, tenant } = await _spinServer();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/artifacts/${artifactId}/evidence-trace`, {
      headers: { authorization: 'Bearer ' + tenant.api_key },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.artifact_id, artifactId);
    assert.ok(body.dag);
    assert.equal(body.dag.nodes.length, 3);
    assert.equal(body.dag.edges.length, 2);
    // 404 for an artifact with no evidence DAG on disk.
    const miss = await fetch(`http://127.0.0.1:${port}/v1/artifacts/r5_missing_${crypto.randomBytes(2).toString('hex')}/evidence-trace`, {
      headers: { authorization: 'Bearer ' + tenant.api_key },
    });
    assert.equal(miss.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
