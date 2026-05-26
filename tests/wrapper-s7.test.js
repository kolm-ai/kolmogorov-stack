// S-7 lock-in (V1 launch wrapper close-out 2026-05-26)
//
// Mixture-of-Experts model support: detection + per-expert metadata +
// expert-aware quantization strategy + serve-time expert pinning.
//
// This suite covers:
//   #1  MOE_FAMILIES has at least 6 entries (mixtral-8x7b/8x22b, qwen2-moe,
//       deepseek-v2-lite/v3, llama4-maverick at minimum).
//   #2  getFamily('mixtral-8x7b') returns a record with experts/top_k.
//   #3  listFamilies() returns a non-empty array of plain (clone-able) records.
//   #4  detectMoE on a synthesized Mixtral-shaped config.json reports
//       is_moe:true, num_experts:8, experts_per_token:2.
//   #5  detectMoE on a synthesized dense config (Qwen-7B-style) reports
//       is_moe:false.
//   #6  detectMoE handles missing path gracefully (no throw).
//   #7  estimateMoEMemory hand-check: Mixtral 8x7B at q4_k_m. Total ~47B,
//       active per token ~13B; hot VRAM at q4_k_m should land near
//       (~15B * 0.5625) = ~8.4 GB, ±10% tolerance.
//   #8  estimateMoEMemory rejects unknown quant levels.
//   #9  recommendQuantPolicy returns a mixed policy with router='fp16' and
//       experts being equal-or-more-aggressive than shared.
//   #10 recommendQuantPolicy escalates expert quant when VRAM is tight.
//   #11 expertHotness aggregates a list of traces into a hit-count map.
//   #12 expertHotness handles multiple trace shapes (experts_activated,
//       activations, experts).
//   #13 pinExperts emits a vllm pin config with --enable-expert-parallel.
//   #14 pinExperts emits llama.cpp --override-tensor for each pinned id.
//   #15 pinExperts rejects unknown runtime.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  MOE_FAMILIES,
  getFamily,
  listFamilies,
  familyForArchitecture,
} from '../src/moe-registry.js';

import {
  detectMoE,
  estimateMoEMemory,
  pinExperts,
  expertHotness,
  recommendQuantPolicy,
  MOE_SUPPORT_VERSION,
} from '../src/moe-support.js';

// ------- helpers -----------------------------------------------------------

function tmpDir(label) {
  const d = path.join(os.tmpdir(), `kolm-s7-${label}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function writeConfig(dir, cfg) {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
}

// ------- registry tests ----------------------------------------------------

test('S-7 #1: MOE_FAMILIES has at least 6 entries', () => {
  const ids = Object.keys(MOE_FAMILIES);
  assert.ok(ids.length >= 6, `expected >=6 families, got ${ids.length}: ${ids.join(',')}`);
  // Required anchors from the launch plan
  for (const required of [
    'mixtral-8x7b', 'mixtral-8x22b', 'qwen2-moe-a14b',
    'deepseek-v2-lite', 'deepseek-v3', 'llama4-maverick',
  ]) {
    assert.ok(MOE_FAMILIES[required], `MOE_FAMILIES missing required family '${required}'`);
  }
});

test('S-7 #2: getFamily("mixtral-8x7b") returns full topology', () => {
  const fam = getFamily('mixtral-8x7b');
  assert.ok(fam, 'getFamily returned null');
  assert.equal(fam.experts, 8);
  assert.equal(fam.top_k, 2);
  assert.equal(fam.vendor, 'mistralai');
  assert.ok(fam.architectures.includes('MixtralForCausalLM'));
});

test('S-7 #3: listFamilies returns plain clonable records', () => {
  const fams = listFamilies();
  assert.ok(Array.isArray(fams));
  assert.ok(fams.length >= 6);
  // Each entry should be a plain object (not the frozen registry entry) — we
  // should be able to mutate it without throwing.
  fams[0].experts = 9999;
  // Original registry is still 8 for mixtral-8x7b
  assert.equal(MOE_FAMILIES['mixtral-8x7b'].experts, 8);
});

test('S-7 #3b: familyForArchitecture maps MixtralForCausalLM -> mixtral-8x7b', () => {
  const fam = familyForArchitecture('MixtralForCausalLM');
  assert.ok(fam);
  assert.equal(fam.id, 'mixtral-8x7b');
});

// ------- detectMoE tests ---------------------------------------------------

test('S-7 #4: detectMoE on Mixtral-shaped config.json', () => {
  const d = tmpDir('mixtral');
  writeConfig(d, {
    model_type: 'mixtral',
    architectures: ['MixtralForCausalLM'],
    num_experts: 8,
    num_experts_per_tok: 2,
    hidden_size: 4096,
    intermediate_size: 14336,
    num_hidden_layers: 32,
  });
  const got = detectMoE(d);
  assert.equal(got.is_moe, true, `expected is_moe:true, got ${JSON.stringify(got)}`);
  assert.equal(got.num_experts, 8);
  assert.equal(got.experts_per_token, 2);
  assert.ok(got.expert_dim > 0, 'expert_dim should be derived from intermediate_size');
  assert.equal(got.family, 'mixtral-8x7b');
  assert.equal(got.source, 'config.json');
  fs.rmSync(d, { recursive: true, force: true });
});

test('S-7 #5: detectMoE on dense Qwen-7B-shaped config reports is_moe:false', () => {
  const d = tmpDir('qwen-dense');
  writeConfig(d, {
    model_type: 'qwen2',
    architectures: ['Qwen2ForCausalLM'],
    hidden_size: 4096,
    intermediate_size: 11008,
    num_hidden_layers: 32,
  });
  const got = detectMoE(d);
  assert.equal(got.is_moe, false);
  assert.equal(got.reason, 'dense_config');
  fs.rmSync(d, { recursive: true, force: true });
});

test('S-7 #6: detectMoE handles missing path gracefully', () => {
  const got = detectMoE('/nonexistent/path/never-going-to-be-here-9999');
  assert.equal(got.is_moe, false);
  assert.equal(got.reason, 'path_not_found');
});

test('S-7 #6b: detectMoE reads safetensors index when config silent', () => {
  const d = tmpDir('safet-index');
  // config that does NOT mention MoE
  writeConfig(d, { model_type: 'custom', hidden_size: 4096 });
  const idx = {
    metadata: { total_size: 999 },
    weight_map: {
      'model.embed_tokens.weight': 'a.safetensors',
      'model.layers.0.block_sparse_moe.experts.0.w1.weight': 'a.safetensors',
      'model.layers.0.block_sparse_moe.experts.3.w2.weight': 'a.safetensors',
      'model.layers.0.block_sparse_moe.experts.7.w3.weight': 'a.safetensors',
    },
  };
  fs.writeFileSync(path.join(d, 'model.safetensors.index.json'),
                   JSON.stringify(idx), 'utf8');
  const got = detectMoE(d);
  assert.equal(got.is_moe, true);
  assert.equal(got.num_experts, 8);  // max index 7 -> 8 experts
  assert.equal(got.source, 'safetensors_index');
  fs.rmSync(d, { recursive: true, force: true });
});

// ------- estimateMoEMemory tests ------------------------------------------

test('S-7 #7: estimateMoEMemory hand-check for Mixtral 8x7B at q4_k_m', () => {
  // Mixtral 8x7B: 47B total params, top-2 of 8 experts active per token.
  // Hand calculation:
  //   shared (default 15% of 47B) = ~7.05B
  //   experts_total = 47 - 7.05 = ~39.95B
  //   active_experts = 39.95 * (2/8) = ~9.99B
  //   active_params = shared + active_experts = ~17.04B
  //   hot_vram_gb at q4_k_m (0.5625 B/param) = 17.04 * 0.5625 = ~9.59 GB
  const got = estimateMoEMemory({
    params: 47,
    num_experts: 8,
    experts_per_token: 2,
    quant: 'q4_k_m',
  });
  const expected = 9.59;
  const tolerance = expected * 0.10;
  assert.ok(
    Math.abs(got.hot_vram_gb - expected) <= tolerance,
    `hot_vram_gb=${got.hot_vram_gb} should be within ${tolerance.toFixed(2)} of ${expected}`,
  );
  // Sanity: cold > 0 (we have 6 of 8 experts paged out)
  assert.ok(got.cold_dram_gb > 0, 'cold_dram_gb should be >0 for 75% offload');
  // Sanity: total = full_weights_gb
  assert.ok(got.full_weights_gb > got.hot_vram_gb, 'full > hot');
  assert.equal(got.active_fraction, 0.25);
});

test('S-7 #7b: estimateMoEMemory at fp16 (full-precision) sanity', () => {
  const got = estimateMoEMemory({
    params: 47, num_experts: 8, experts_per_token: 2, quant: 'fp16',
  });
  // 47B * 2 bytes = 94 GB full; with 0.25 active fraction
  // shared 7.05 + active 9.99 = ~17 B active. 17 * 2 = ~34 GB hot.
  assert.ok(got.hot_vram_gb > 30 && got.hot_vram_gb < 38,
            `fp16 hot_vram_gb=${got.hot_vram_gb} should be ~34`);
  assert.equal(got.full_weights_gb, 94);
});

test('S-7 #8: estimateMoEMemory rejects unknown quant', () => {
  assert.throws(
    () => estimateMoEMemory({ params: 47, num_experts: 8, experts_per_token: 2, quant: 'banana' }),
    /unknown quant/,
  );
});

test('S-7 #8b: estimateMoEMemory rejects bad inputs', () => {
  assert.throws(() => estimateMoEMemory({}), /params/);
  assert.throws(() => estimateMoEMemory({ params: 47, num_experts: 1, experts_per_token: 1 }),
                /num_experts/);
  assert.throws(() => estimateMoEMemory({ params: 47, num_experts: 8, experts_per_token: 0 }),
                /experts_per_token/);
});

// ------- recommendQuantPolicy tests ---------------------------------------

test('S-7 #9: recommendQuantPolicy returns sane mixed policy with router=fp16', () => {
  const moe_info = {
    num_experts: 8, experts_per_token: 2, params: 47, family: 'mixtral-8x7b',
  };
  const got = recommendQuantPolicy({ moe_info, target_vram_gb: 24 });
  assert.equal(got.router, 'fp16', 'router must stay at fp16 (rounding kills routing)');
  assert.ok(typeof got.shared === 'string' && got.shared.length > 0);
  assert.ok(typeof got.experts === 'string' && got.experts.length > 0);
  assert.ok(['fits_at_q4_k_m', 'mild_pressure', 'moderate_pressure', 'high_pressure',
             'extreme_pressure_consider_smaller_model'].includes(got.label));
  assert.equal(typeof got.fits, 'boolean');
  assert.ok(got.projected_hot_vram_gb > 0);
});

test('S-7 #10: recommendQuantPolicy escalates expert quant under VRAM pressure', () => {
  // Same model, two budgets: 24GB (loose) vs 4GB (tight).
  const moe_info = { num_experts: 8, experts_per_token: 2, params: 47 };
  const loose = recommendQuantPolicy({ moe_info, target_vram_gb: 24 });
  const tight = recommendQuantPolicy({ moe_info, target_vram_gb: 4 });
  // Tight budget should pick a more aggressive (smaller bytes/param) quant
  // for experts than the loose budget.
  const ladderOrder = ['q4_k_m', 'iq4_xs', 'iq3_xxs', 'iq2_xxs'];
  const looseIdx = ladderOrder.indexOf(loose.experts);
  const tightIdx = ladderOrder.indexOf(tight.experts);
  assert.ok(looseIdx >= 0, `unexpected loose.experts=${loose.experts}`);
  assert.ok(tightIdx >= 0, `unexpected tight.experts=${tight.experts}`);
  assert.ok(tightIdx >= looseIdx,
    `tight budget should produce more aggressive expert quant: loose=${loose.experts} tight=${tight.experts}`);
  // Tight pressure ratio should be higher
  assert.ok(tight.pressure_ratio > loose.pressure_ratio);
});

test('S-7 #10b: recommendQuantPolicy rejects bad inputs', () => {
  assert.throws(() => recommendQuantPolicy({}), /moe_info/);
  assert.throws(
    () => recommendQuantPolicy({ moe_info: { num_experts: 8, experts_per_token: 2 } }),
    /target_vram_gb/,
  );
});

// ------- expertHotness tests ----------------------------------------------

test('S-7 #11: expertHotness aggregates a flat list of traces', () => {
  const traces = [
    { experts_activated: [0, 3] },
    { experts_activated: [3, 7] },
    { experts_activated: [3, 5] },
  ];
  const got = expertHotness({ traces });
  assert.equal(got[0], 1);
  assert.equal(got[3], 3);
  assert.equal(got[5], 1);
  assert.equal(got[7], 1);
});

test('S-7 #12: expertHotness handles multiple trace shapes', () => {
  const traces = [
    { experts_activated: [1, 2] },
    { experts: [2, 3] },
    { expert_ids: [3, 4] },
    { activations: [[1, 2], [3, 4]] },
    { expert_id: 5 },
    null,
    'garbage',
    {},
  ];
  const got = expertHotness({ traces });
  // expert 2: experts_activated + experts + activations[0] = 3
  assert.equal(got[2], 3);
  // expert 3: experts + expert_ids + activations[1] = 3
  assert.equal(got[3], 3);
  // expert 5: single int
  assert.equal(got[5], 1);
});

test('S-7 #12b: expertHotness rejects non-array traces', () => {
  assert.throws(() => expertHotness({ traces: 'not array' }), /array/);
});

// ------- pinExperts tests -------------------------------------------------

test('S-7 #13: pinExperts emits vllm pin config + --enable-expert-parallel', () => {
  const got = pinExperts({
    artifact: '/tmp/fake.kolm',
    expert_ids: [3, 7, 41],
    runtime: 'vllm',
  });
  assert.equal(got.runtime, 'vllm');
  assert.deepEqual(got.pinned_expert_ids, [3, 7, 41]);
  assert.equal(got.pinned_count, 3);
  assert.ok(got.runtime_args.includes('--enable-expert-parallel'));
  assert.ok(got.envelope.vllm_expert_pin_json);
  assert.deepEqual(got.envelope.vllm_expert_pin_json.pin_to_gpu, [3, 7, 41]);
});

test('S-7 #14: pinExperts emits llama.cpp --override-tensor for each pinned id', () => {
  const got = pinExperts({
    artifact: '/tmp/fake.gguf',
    expert_ids: [2, 5],
    runtime: 'llama.cpp',
  });
  assert.equal(got.runtime, 'llama.cpp');
  // Count --override-tensor occurrences in runtime_args
  const overrides = got.runtime_args.filter((x) => x === '--override-tensor');
  assert.equal(overrides.length, 2, 'one --override-tensor per pinned expert');
  // The override patterns should mention expert 2 and 5
  const argsStr = got.runtime_args.join(' ');
  assert.ok(/experts\\\.2\\\./.test(argsStr), 'should pin expert 2');
  assert.ok(/experts\\\.5\\\./.test(argsStr), 'should pin expert 5');
});

test('S-7 #14b: pinExperts dedupes + sorts expert_ids', () => {
  const got = pinExperts({
    artifact: 'foo.kolm',
    expert_ids: [5, 3, 5, 1, 3],
    runtime: 'vllm',
  });
  assert.deepEqual(got.pinned_expert_ids, [1, 3, 5]);
});

test('S-7 #15: pinExperts rejects unknown runtime / bad args', () => {
  assert.throws(
    () => pinExperts({ artifact: 'a', expert_ids: [1], runtime: 'made-up' }),
    /runtime/,
  );
  assert.throws(
    () => pinExperts({ artifact: 'a', expert_ids: [], runtime: 'vllm' }),
    /expert_ids/,
  );
  assert.throws(
    () => pinExperts({ artifact: 'a', expert_ids: [1.5], runtime: 'vllm' }),
    /non-negative integers/,
  );
});

// ------- version pin ------------------------------------------------------

test('S-7 #16: MOE_SUPPORT_VERSION present so downstream can pin compatibility', () => {
  assert.equal(typeof MOE_SUPPORT_VERSION, 'string');
  assert.ok(MOE_SUPPORT_VERSION.length > 0);
});
