// W921 — model-merge orchestration tests.
//
// Pins:
//  - planMerge dry-run envelope shape + same_base mismatch warning
//  - mergeAdapters with torch/peft ABSENT (no trainer) returns durable envelope
//    that still writes plan + lineage even without the trainer
//  - weights normalize + validate (length mismatch / negative / zero-sum errors)
//  - SLERP rejected for N != 2
//  - bindMergeLineage produces lineage.source==='model_merge' with N parents
//  - doctor envelope shape

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  planMerge, mergeAdapters, bindMergeLineage, doctor, MERGE_METHODS,
} from '../src/model-merge.js';

function mkAdapterDir(base) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-merge-adapter-'));
  fs.writeFileSync(path.join(d, 'adapter_config.json'), JSON.stringify({
    base_model_name_or_path: base, r: 16, lora_alpha: 32, peft_type: 'LORA',
  }));
  fs.writeFileSync(path.join(d, 'adapter_model.safetensors'), Buffer.from('fake-weights-' + Math.random()));
  return d;
}

test('planMerge envelope shape', () => {
  const a = mkAdapterDir('Qwen/Qwen2.5-7B');
  const b = mkAdapterDir('Qwen/Qwen2.5-7B');
  const c = mkAdapterDir('Qwen/Qwen2.5-7B');
  const p = planMerge({ adapters: [a, b, c], method: 'ties', weights: [0.5, 0.3, 0.2], density: 0.5 });
  assert.equal(p.ok, true);
  assert.equal(p.n_parents, 3);
  assert.equal(p.same_base, true);
  assert.equal(p.method, 'ties');
  assert.equal(p.density, 0.5);
  assert.ok(p.parents.every((x) => /^[0-9a-f]{64}$/.test(x.sha256)));
  // weights normalized to sum 1
  const sum = p.parents.reduce((s, x) => s + x.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6);
});

test('planMerge same_base mismatch warning', () => {
  const a = mkAdapterDir('Qwen/Qwen2.5-7B');
  const b = mkAdapterDir('meta-llama/Llama-3-8B');
  const p = planMerge({ adapters: [a, b], method: 'linear' });
  assert.equal(p.same_base, false);
  assert.match(p.warning, /disagree on base_model/);
});

test('planMerge weight validation', () => {
  const a = mkAdapterDir('B'); const b = mkAdapterDir('B');
  assert.equal(planMerge({ adapters: [a, b], weights: [0.5] }).error, 'weights_length_mismatch');
  assert.equal(planMerge({ adapters: [a, b], weights: [-1, 2] }).error, 'weight_negative');
  assert.equal(planMerge({ adapters: [a, b], weights: [0, 0] }).error, 'weight_sum_nonpositive');
  assert.equal(planMerge({ adapters: [a] }).error, 'too_few_adapters');
});

test('SLERP rejected for N != 2', () => {
  const a = mkAdapterDir('B'); const b = mkAdapterDir('B'); const c = mkAdapterDir('B');
  assert.equal(planMerge({ adapters: [a, b, c], method: 'slerp' }).error, 'method_requires_two');
  // exactly 2 is fine
  assert.equal(planMerge({ adapters: [a, b], method: 'slerp' }).ok, true);
});

test('mergeAdapters durable no-trainer envelope writes plan + lineage', () => {
  const a = mkAdapterDir('Qwen/Qwen2.5-7B');
  const b = mkAdapterDir('Qwen/Qwen2.5-7B');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-merge-out-'));
  // KOLM_MERGE_NO_TRAINER=1 forces the durable no-tool path (no torch spawn).
  const prev = process.env.KOLM_MERGE_NO_TRAINER;
  process.env.KOLM_MERGE_NO_TRAINER = '1';
  try {
    const r = mergeAdapters({ adapters: [a, b], method: 'ties', outDir });
    assert.equal(r.ok, true);
    assert.equal(r.trainer_kicked, false, 'no trainer should be kicked');
    assert.equal(r.error, 'no_trainer_installed');
    assert.ok(fs.existsSync(r.merge_plan_path), 'plan must be written');
    assert.ok(fs.existsSync(path.join(outDir, 'merge-lineage.json')), 'lineage must be written');
    assert.ok(r.lineage, 'envelope carries lineage');
    assert.equal(r.source_adapter_hashes.length, 2);
  } finally {
    if (prev === undefined) delete process.env.KOLM_MERGE_NO_TRAINER; else process.env.KOLM_MERGE_NO_TRAINER = prev;
  }
});

test('mergeAdapters with real artifact cids binds model_merge lineage', () => {
  const H64 = (c) => c.repeat(64);
  const a = mkAdapterDir('Qwen/Qwen2.5-7B');
  const b = mkAdapterDir('Qwen/Qwen2.5-7B');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-merge-out2-'));
  const prev = process.env.KOLM_MERGE_NO_TRAINER;
  process.env.KOLM_MERGE_NO_TRAINER = '1';
  try {
    const r = mergeAdapters({ adapters: [a, b], method: 'ties', outDir, parentCids: [H64('a'), H64('b')] });
    assert.equal(r.ok, true);
    assert.equal(r.lineage.source, 'model_merge');
    assert.equal(r.lineage.parent_artifact_hashes.length, 2);
    assert.equal(r.lineage.merge_method, 'ties');
  } finally {
    if (prev === undefined) delete process.env.KOLM_MERGE_NO_TRAINER; else process.env.KOLM_MERGE_NO_TRAINER = prev;
  }
});

test('mergeAdapters refuses base mismatch', () => {
  const a = mkAdapterDir('Qwen/Qwen2.5-7B');
  const b = mkAdapterDir('meta-llama/Llama-3-8B');
  const r = mergeAdapters({ adapters: [a, b], method: 'ties' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'base_model_mismatch');
});

test('bindMergeLineage produces model_merge lineage with N parents', () => {
  const H64 = (c) => c.repeat(64);
  const m = bindMergeLineage({ name: 'merged' }, {
    parentCids: [H64('a'), H64('b'), H64('c')],
    sourceAdapterHashes: ['1'.repeat(16), '2'.repeat(16)],
    method: 'dare_ties',
    weights: { a: 0.4, b: 0.4, c: 0.2 },
    density: 0.7,
  });
  assert.equal(m.lineage.source, 'model_merge');
  assert.equal(m.lineage.parent_artifact_hashes.length, 3);
  assert.equal(m.lineage.merge_method, 'dare_ties');
  assert.equal(m.lineage.merge_density, 0.7);
});

test('doctor envelope shape + MERGE_METHODS catalog', () => {
  const d = doctor();
  assert.equal(d.kind, 'model_merge');
  assert.ok(Array.isArray(d.methods));
  assert.ok(d.methods.includes('ties'));
  assert.ok(d.methods.includes('della'));
  assert.equal(typeof d.torch_peft_importable, 'boolean');
  assert.ok(MERGE_METHODS.includes('slerp'));
});
