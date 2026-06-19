// W921 — LoRA-variant / GaLore / packing JS knobs + recipe-loader validation.
//
// JS-only, GPU-free. The Python preflight + GPU e2e live under needs_gpu_run.
//
// Pins:
//  - normalizeTrainerVariantOptions rejects out-of-enum, accepts valid combos
//  - refuses galore+qlora and galore_layerwise + grad-accum>1
//  - buildTrainerVariantEnv emits exactly the expected KOLM_* keys; default rsLoRA
//  - recipe-loader accepts trinity-2000 + a pissa/galore recipe; rejects bad enums

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeEfficiencyOptions, buildEfficiencyEnv,
  normalizeTrainerVariantOptions, buildTrainerVariantEnv,
  LORA_VARIANTS, DEFAULT_LORA_VARIANT, LORA_INITS, TRAINER_OPTIMS,
  TRAINER_PRESET_NAMES, TORCH_COMPILE_MODES,
} from '../src/distill-efficiency.js';
import { loadRecipe } from '../src/distill-recipe-loader.js';

test('frozen enums present', () => {
  assert.ok(LORA_VARIANTS.includes('dora'));
  assert.ok(LORA_VARIANTS.includes('qdora'));
  assert.equal(DEFAULT_LORA_VARIANT, 'rslora');
  assert.ok(LORA_INITS.includes('pissa_niter_16'));
  assert.ok(TRAINER_OPTIMS.includes('galore_adamw'));
  assert.ok(TRAINER_PRESET_NAMES.includes('qdora'));
  assert.ok(TORCH_COMPILE_MODES.includes('reduce-overhead'));
  assert.ok(Object.isFrozen(LORA_VARIANTS));
});

test('normalizeEfficiencyOptions wires torch.compile env exactly', () => {
  const v = normalizeEfficiencyOptions({
    precision_mode: 'mixed-bf16',
    gradient_checkpointing: 'true',
    torch_compile: true,
    torch_compile_mode: 'reduce-overhead',
    torch_compile_backend: 'inductor',
    torch_compile_dynamic: false,
  });
  assert.equal(v.torch_compile.requested, true);
  assert.equal(v.torch_compile.enabled, true);
  assert.equal(v.torch_compile.mode, 'reduce-overhead');
  assert.equal(v.torch_compile.dynamic, false);
  assert.deepEqual(buildEfficiencyEnv(v), {
    KOLM_PRECISION: 'mixed-bf16',
    KOLM_GRAD_CHECKPOINT: '1',
    KOLM_EARLY_STOP: '0',
    KOLM_TORCH_COMPILE: '1',
    KOLM_TORCH_COMPILE_MODE: 'reduce-overhead',
    KOLM_TORCH_COMPILE_BACKEND: 'inductor',
    KOLM_TORCH_COMPILE_DYNAMIC: '0',
  });

  const required = buildEfficiencyEnv(normalizeEfficiencyOptions({
    torch_compile: 'required',
    torch_compile_fullgraph: true,
  }));
  assert.equal(required.KOLM_TORCH_COMPILE, 'required');
  assert.equal(required.KOLM_TORCH_COMPILE_MODE, 'default');
  assert.equal(required.KOLM_TORCH_COMPILE_FULLGRAPH, '1');
  assert.throws(() => normalizeEfficiencyOptions({ torch_compile_mode: 'bogus' }), /torch_compile_mode/);
});

test('normalizeTrainerVariantOptions accepts valid + rejects out-of-enum', () => {
  const v = normalizeTrainerVariantOptions({ lora_variant: 'dora', lora_init: 'pissa', neftune_alpha: 5 });
  assert.equal(v.lora_variant, 'dora');
  assert.equal(v.lora_init, 'pissa');
  assert.equal(v.neftune_alpha, 5);
  assert.throws(() => normalizeTrainerVariantOptions({ lora_variant: 'bogus' }), /lora_variant/);
  assert.throws(() => normalizeTrainerVariantOptions({ lora_init: 'bogus' }), /lora_init/);
  assert.throws(() => normalizeTrainerVariantOptions({ optim: 'bogus' }), /optim/);
});

test('refuses incompatible combos', () => {
  let e1;
  try { normalizeTrainerVariantOptions({ optim: 'galore_adamw', method: 'qlora' }); } catch (e) { e1 = e; }
  assert.equal(e1.code, 'galore_qlora_conflict');
  let e2;
  try { normalizeTrainerVariantOptions({ optim: 'galore_adamw_layerwise', grad_accum: 4 }); } catch (e) { e2 = e; }
  assert.equal(e2.code, 'galore_layerwise_grad_accum_conflict');
});

test('buildTrainerVariantEnv exact wire format; default rsLoRA + explicit lora opt-out', () => {
  assert.deepEqual(buildTrainerVariantEnv(normalizeTrainerVariantOptions({})), {
    KOLM_LORA_VARIANT: 'rslora',
  });
  assert.deepEqual(buildTrainerVariantEnv(normalizeTrainerVariantOptions({ lora_variant: 'lora' })), {
    KOLM_LORA_VARIANT: 'lora',
  });
  assert.deepEqual(buildTrainerVariantEnv(normalizeTrainerVariantOptions({ lora_variant: 'dora', neftune_alpha: 5 })), {
    KOLM_LORA_VARIANT: 'dora', KOLM_NEFTUNE_ALPHA: '5',
  });
  assert.deepEqual(buildTrainerVariantEnv(normalizeTrainerVariantOptions({ lora_init: 'pissa_niter_16' })), {
    KOLM_LORA_VARIANT: 'rslora', KOLM_LORA_INIT: 'pissa_niter_16',
  });
  const galore = buildTrainerVariantEnv(normalizeTrainerVariantOptions({ optim: 'galore_adamw', galore: { rank: 128 }, method: 'full' }));
  assert.equal(galore.KOLM_OPTIM, 'galore_adamw');
  assert.match(galore.KOLM_GALORE_ARGS, /rank=128/);
  assert.equal(galore.KOLM_GALORE_TARGETS, 'attn,mlp');
  const packing = buildTrainerVariantEnv(normalizeTrainerVariantOptions({ packing: true }));
  assert.equal(packing.KOLM_PACKING, '1');
});

test('qdora preset expands to one-click frontier quality env', () => {
  const v = normalizeTrainerVariantOptions({ preset: 'qdora' });
  assert.equal(v.preset, 'qdora');
  assert.equal(v.method, 'qlora');
  assert.equal(v.lora_variant, 'qdora');
  assert.equal(v.optim, 'paged_adamw_8bit');
  assert.equal(v.neftune_alpha, 5);
  assert.equal(v.packing, true);
  assert.equal(v.backend, 'auto');
  assert.equal(v.use_liger, true);
  assert.deepEqual(buildTrainerVariantEnv(v), {
    KOLM_TRAIN_PRESET: 'qdora',
    KOLM_TRAIN_METHOD: 'qlora',
    KOLM_TRAIN_LORA_BACKEND: 'auto',
    KOLM_USE_LIGER: '1',
    KOLM_LORA_VARIANT: 'qdora',
    KOLM_NEFTUNE_ALPHA: '5',
    KOLM_OPTIM: 'paged_adamw_8bit',
    KOLM_PACKING: '1',
  });
  assert.throws(() => normalizeTrainerVariantOptions({ preset: 'bogus' }), /train preset/);
});

test('loraplus default ratio', () => {
  const v = normalizeTrainerVariantOptions({ lora_variant: 'loraplus' });
  assert.equal(v.loraplus_ratio, 16);
  const env = buildTrainerVariantEnv(v);
  assert.equal(env.KOLM_LORAPLUS_RATIO, '16');
});

test('recipe loader: trinity-2000 still valid; pissa/galore recipe validates; bad enum rejected', () => {
  assert.equal(loadRecipe('trinity-2000').ok, true);
  // valid pissa recipe fixture
  const good = {
    name: 'lv-test', version: '1',
    seeds: { target: 10, generator: 'x' },
    teachers: [{ slug: 'anthropic:claude', rows: 10 }],
    train: { method: 'lora', student_base: 'Q', backend: 'auto', epochs: 1, batch_size: 1, lr: 0.0001, max_seq_len: 512, lora: { r: 16, alpha: 32 }, lora_init: 'pissa_niter_16', lora_variant: 'dora', neftune_alpha: 5, packing: true },
  };
  const p = path.join(os.tmpdir(), 'kolm-lv-good-' + Date.now() + '.json');
  fs.writeFileSync(p, JSON.stringify(good));
  assert.equal(loadRecipe(p).ok, true);
  // galore + qlora rejected before spend
  const bad = JSON.parse(JSON.stringify(good));
  bad.train.method = 'qlora';
  bad.train.optim = 'galore_adamw';
  const pb = path.join(os.tmpdir(), 'kolm-lv-bad-' + Date.now() + '.json');
  fs.writeFileSync(pb, JSON.stringify(bad));
  const r = loadRecipe(pb);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => /galore/.test(i)));
  // bad lora_init enum rejected
  const bad2 = JSON.parse(JSON.stringify(good));
  bad2.train.lora_init = 'nonsense';
  const pb2 = path.join(os.tmpdir(), 'kolm-lv-bad2-' + Date.now() + '.json');
  fs.writeFileSync(pb2, JSON.stringify(bad2));
  assert.equal(loadRecipe(pb2).ok, false);
  // bad train backend enum rejected
  const bad3 = JSON.parse(JSON.stringify(good));
  bad3.train.backend = 'bogus';
  const pb3 = path.join(os.tmpdir(), 'kolm-lv-bad3-' + Date.now() + '.json');
  fs.writeFileSync(pb3, JSON.stringify(bad3));
  const r3 = loadRecipe(pb3);
  assert.equal(r3.ok, false);
  assert.ok(r3.issues.some((i) => /train\.backend/.test(i)));
  const qdora = JSON.parse(JSON.stringify(good));
  qdora.train.preset = 'qdora';
  delete qdora.train.method;
  delete qdora.train.lora_variant;
  const pq = path.join(os.tmpdir(), 'kolm-lv-qdora-' + Date.now() + '.json');
  fs.writeFileSync(pq, JSON.stringify(qdora));
  assert.equal(loadRecipe(pq).ok, true);
  const qdoraBad = JSON.parse(JSON.stringify(qdora));
  qdoraBad.train.method = 'lora';
  const pqb = path.join(os.tmpdir(), 'kolm-lv-qdora-bad-' + Date.now() + '.json');
  fs.writeFileSync(pqb, JSON.stringify(qdoraBad));
  const rb = loadRecipe(pqb);
  assert.equal(rb.ok, false);
  assert.ok(rb.issues.some((i) => /preset=qdora requires train\.method=qlora/.test(i)));
});
