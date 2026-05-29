// W921 — multi-parent model-merge lineage tests.
//
// Pins:
//  1) buildLineage({source:'model_merge', parent_artifact_hashes:[h1,h2,h3], ...})
//     round-trips through validateLineage with a stable hash.
//  2) rejects model_merge with < 2 parents.
//  3) rejects bad-hex parent hashes.
//  4) setMergeParents byte-stability — empty array OMITS the slot (W460).
//  5) walkLineageDag fans out to ALL parents not just one.
//  6) buildLineage with no merge fields is byte-identical to pre-W921 (additive).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLineage, validateLineage, setMergeParents, getMergeParents,
  walkLineageDag, VALID_MERGE_METHODS,
} from '../src/artifact-lineage.js';

const H64 = (c) => c.repeat(64);
const H16 = (c) => c.repeat(16);

test('1) model_merge lineage round-trips with stable hash', () => {
  const l = buildLineage({
    source: 'model_merge',
    parent_artifact_hashes: [H64('a'), H64('b'), H64('c')],
    merge_method: 'ties',
    merge_weights: { refund: 0.5, pii: 0.3, tone: 0.2 },
    merge_density: 0.5,
    source_adapter_hashes: [H16('1'), H16('2')],
  });
  assert.equal(l.source, 'model_merge');
  assert.equal(l.parent_artifact_hashes.length, 3);
  assert.equal(l.merge_method, 'ties');
  const v = validateLineage(l);
  assert.equal(v.hash, l.hash);
  // Determinism: rebuilding yields the same hash.
  const l2 = buildLineage({
    source: 'model_merge',
    parent_artifact_hashes: [H64('c'), H64('a'), H64('b')], // different input order
    merge_method: 'ties',
    merge_weights: { refund: 0.5, pii: 0.3, tone: 0.2 },
    merge_density: 0.5,
    source_adapter_hashes: [H16('2'), H16('1')],
  });
  assert.equal(l2.hash, l.hash, 'parent order must not change lineage hash');
});

test('2) model_merge rejects < 2 parents', () => {
  assert.throws(() => buildLineage({
    source: 'model_merge',
    parent_artifact_hashes: [H64('a')],
    merge_method: 'ties',
  }), />= 2 entries/);
  assert.throws(() => buildLineage({
    source: 'model_merge',
    merge_method: 'ties',
  }), />= 2 entries/);
});

test('3) rejects bad-hex parent hashes + unknown merge method', () => {
  assert.throws(() => buildLineage({
    source: 'model_merge',
    parent_artifact_hashes: ['nothex', H64('b')],
    merge_method: 'ties',
  }), /hex64/);
  assert.throws(() => buildLineage({
    source: 'model_merge',
    parent_artifact_hashes: [H64('a'), H64('b')],
    merge_method: 'bogus_method',
  }), /unknown merge_method/);
});

test('4) setMergeParents byte-stability — empty omits the slot', () => {
  const m0 = { name: 'x' };
  assert.deepEqual(setMergeParents(m0, []), { name: 'x' });
  assert.deepEqual(setMergeParents(m0, null), { name: 'x' });
  const m1 = setMergeParents(m0, [H64('a'), H64('b')]);
  assert.equal(m1.parent_cids.length, 2);
  // sorted canonical order
  assert.deepEqual(m1.parent_cids, [H64('a'), H64('b')].sort());
  assert.throws(() => setMergeParents(m0, ['bad']), /sha256-hex/);
});

test('5) walkLineageDag fans out to ALL parents', async () => {
  const store = {
    leaf: { parent_cids: [H64('a'), H64('b')], k_score: 0.9 },
    [H64('a')]: { parent_cid: null, k_score: 0.85 },
    [H64('b')]: { parent_cid: null, k_score: 0.88 },
  };
  const load = async (cid) => store[cid] || null;
  const res = await walkLineageDag(load, 'leaf');
  assert.equal(res.ok, true);
  assert.equal(res.leaf_found, true);
  assert.equal(res.node_count, 3, 'should resolve leaf + both parents');
  assert.equal(res.nodes['leaf'].parents.length, 2);
  // missing leaf
  const bad = await walkLineageDag(load, 'nonexistent');
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'leaf_not_found');
});

test('6) additive: non-merge lineage unaffected + VALID_MERGE_METHODS frozen set', () => {
  const l = buildLineage({
    source: 'distillation',
    teacher: { vendor: 'anthropic', model: 'claude' },
    student_base: { repo: 'Qwen/Qwen2.5-7B' },
    distillation_method: 'qlora',
  });
  assert.equal(l.source, 'distillation');
  assert.equal(l.parent_artifact_hashes, undefined, 'merge slots must be absent on non-merge lineage');
  assert.ok(VALID_MERGE_METHODS.has('ties'));
  assert.ok(VALID_MERGE_METHODS.has('della'));
  assert.ok(!VALID_MERGE_METHODS.has('bogus'));
});

test('getMergeParents falls back to single parent_cid', () => {
  assert.deepEqual(getMergeParents({ parent_cid: H64('a') }), [H64('a')]);
  assert.deepEqual(getMergeParents({ parent_cids: [H64('a'), H64('b')] }), [H64('a'), H64('b')]);
  assert.deepEqual(getMergeParents({}), []);
});
