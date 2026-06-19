// W610 - small-LLM student registry refresh.
//
// This closes the surgical small-student drift found in the backend spec:
// 2026 student rows are in the default registry, defaults no longer point at
// Qwen2.5/Phi-3.5, verified frontier rows include current students, and the
// TAAS arch recommender emits real backbone IDs instead of stale class slugs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_MODEL,
  MODEL_BENCHMARK_METRICS,
  TIER_BY_USE,
  info,
  list,
  normalizeBenchmarkMetric,
  recommend,
} from '../src/models.js';
import {
  verifyEntry,
  verifyBackbone,
  showBackbone,
  resolveTier,
} from '../src/model-registry.js';
import {
  ARCH_CATALOG,
  resolveArchBackbone,
} from '../src/student-arch-recommender.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const FRONTIER_STUDENT_IDS = [
  'Qwen/Qwen3-4B-Instruct-2507',
  'Qwen/Qwen3-8B',
  'microsoft/Phi-4-mini-instruct',
  'HuggingFaceTB/SmolLM3-3B',
  'LiquidAI/LFM2.5-1.2B-Instruct',
  'openbmb/MiniCPM5-1B',
  'google/gemma-4-E2B-it',
  'google/gemma-4-E4B-it',
];

test('W610 #1 - 2026 frontier student rows exist in the default registry', () => {
  for (const id of FRONTIER_STUDENT_IDS) {
    const row = info(id);
    assert.ok(row, `missing model row: ${id}`);
    assert.equal(row.frontier_student, true, `${id} must be marked frontier_student`);
    assert.equal(typeof row.official_source_url, 'string', `${id} must carry source URL`);
  }
});

test('W610 #2 - defaults moved off Qwen2.5/Phi-3.5 onto Qwen3/Phi-4', () => {
  assert.equal(DEFAULT_MODEL, 'Qwen/Qwen3-4B-Instruct-2507');
  assert.equal(TIER_BY_USE.default, DEFAULT_MODEL);
  assert.equal(TIER_BY_USE.chat, DEFAULT_MODEL);
  assert.equal(TIER_BY_USE.agent, DEFAULT_MODEL);
  assert.equal(TIER_BY_USE.reasoning, 'microsoft/Phi-4-mini-instruct');
  assert.doesNotMatch(DEFAULT_MODEL, /Qwen2\.5/);
  assert.doesNotMatch(TIER_BY_USE.reasoning, /Phi-3\.5/);

  const rec = recommend({ use: 'default' });
  assert.equal(rec.explicit_tier_pick, DEFAULT_MODEL);
  assert.equal(rec.pick, DEFAULT_MODEL);
});

test('W610 #3 - LFM2.5 is present but not misclassified as permissive', () => {
  const lfm = info('LiquidAI/LFM2.5-1.2B-Instruct');
  assert.equal(lfm.license, 'lfm-1.0');
  assert.equal(lfm.mobile_friendly, true);
  assert.equal(list({ permissive: true }).some(m => m.id === lfm.id), false);
});

test('W610 #4 - verified frontier registry includes current exact-card rows', () => {
  for (const id of ['Qwen/Qwen3-4B-Instruct-2507', 'microsoft/Phi-4-mini-instruct']) {
    const v = verifyEntry(id);
    assert.equal(v.ok, true, `${id} failed verified registry check: ${JSON.stringify(v)}`);
    assert.equal(v.registry, 'verified');
  }
  const tier = resolveTier('4090');
  assert.equal(tier.base_model, 'Qwen/Qwen3-4B-Instruct-2507');
});

test('W610 #5 - pull-backbone registry also names the new student rows', () => {
  for (const id of FRONTIER_STUDENT_IDS) {
    const b = showBackbone(id);
    assert.ok(b, `missing backbone row: ${id}`);
    const v = verifyBackbone(id);
    assert.equal(v.ok, true, `${id} failed backbone check: ${JSON.stringify(v)}`);
  }
});

test('W610 #6 - TAAS architecture catalog links each class to a real model row', () => {
  const expected = {
    ARCH_1B: 'openbmb/MiniCPM5-1B',
    ARCH_3B: 'Qwen/Qwen3-4B-Instruct-2507',
    ARCH_7B: 'Qwen/Qwen3-8B',
    ARCH_MOE_8x3: 'Qwen/Qwen3-4B-Instruct-2507',
  };
  for (const [key, id] of Object.entries(expected)) {
    assert.equal(ARCH_CATALOG[key].backbone_id, id, `${key} must point to ${id}`);
    assert.equal(resolveArchBackbone(key)?.id, id, `${key} did not resolve via models.info()`);
  }
});

test('W977 #7 - frontier student rows carry sourced benchmark score fields', () => {
  for (const id of FRONTIER_STUDENT_IDS) {
    const row = info(id);
    const benchmarks = row?.benchmarks;
    assert.ok(benchmarks, `${id} must carry benchmarks`);
    assert.equal(benchmarks.verified_at, '2026-06-19', `${id} benchmark source date must be pinned`);
    assert.equal(typeof benchmarks.source_url, 'string', `${id} benchmark source URL missing`);
    assert.match(benchmarks.source_url, /^https:\/\//, `${id} benchmark source must be an https URL`);
    assert.equal(benchmarks.scale, 'percent_higher_is_better', `${id} benchmark scale must be explicit`);
    assert.ok(benchmarks.metrics && typeof benchmarks.metrics === 'object', `${id} benchmark metrics missing`);

    for (const metric of MODEL_BENCHMARK_METRICS) {
      assert.ok(metric in benchmarks.metrics, `${id} missing canonical benchmark key ${metric}`);
      const value = benchmarks.metrics[metric];
      assert.ok(
        value === null || (Number.isFinite(value) && value >= 0 && value <= 100),
        `${id} ${metric} must be a percent score or null, got ${value}`,
      );
    }
    assert.ok(
      Object.values(benchmarks.metrics).some((value) => Number.isFinite(value)),
      `${id} must have at least one sourced benchmark score`,
    );
  }
});

test('W977 #8 - recommend() can rank by a sourced benchmark metric', () => {
  assert.equal(normalizeBenchmarkMetric('BFCL-v3'), 'bfcl');
  assert.equal(normalizeBenchmarkMetric('MMLU-Pro'), 'mmlu_pro');
  assert.equal(normalizeBenchmarkMetric('not-a-real-metric'), null);

  const rec = recommend({ use: 'mobile', vram_gb: 2, optimize_for: 'ifeval' });
  assert.equal(rec.benchmark_metric, 'ifeval');
  assert.equal(rec.benchmark_optimized, true);
  assert.equal(rec.pick, 'LiquidAI/LFM2.5-1.2B-Instruct');
  assert.match(rec.summary, /benchmark_ifeval: 86\.23/);

  const picked = rec.top.find((row) => row.id === rec.pick);
  assert.ok(picked, 'picked row must appear in top list');
  assert.equal(picked.benchmark_metric, 'ifeval');
  assert.equal(picked.benchmark_score, 86.23);
  assert.equal(picked.benchmark_source_scope, 'exact_instruct_model_card');
});

test('W978 #9 - edge and multimodal frontier tiers name MiniCPM5 and Gemma 4', () => {
  const mini = info('openbmb/MiniCPM5-1B');
  assert.equal(mini.license, 'apache-2.0');
  assert.equal(mini.context_tokens, 131072);
  assert.equal(mini.tool_use, 'native');
  assert.equal(mini.benchmarks.metrics.mmlu_pro, 48.85);
  assert.equal(mini.benchmarks.metrics.ifeval, 80.41);
  assert.equal(mini.benchmarks.metrics.bfcl, 25.15);

  const e2b = info('google/gemma-4-E2B-it');
  assert.equal(e2b.license, 'apache-2.0');
  assert.equal(e2b.params_b_raw, 5.1);
  assert.equal(e2b.context_tokens, 131072);
  assert.deepEqual(e2b.modalities, ['text', 'image', 'audio']);
  assert.equal(e2b.benchmarks.metrics.mmlu_pro, 60.0);

  const e4b = info('google/gemma-4-E4B-it');
  assert.equal(e4b.license, 'apache-2.0');
  assert.equal(e4b.params_b_raw, 8.0);
  assert.equal(e4b.context_tokens, 131072);
  assert.deepEqual(e4b.modalities, ['text', 'image', 'audio']);
  assert.equal(e4b.benchmarks.metrics.mmlu_pro, 69.4);

  assert.equal(TIER_BY_USE.edge, 'openbmb/MiniCPM5-1B');
  assert.equal(TIER_BY_USE.wasm, 'Qwen/Qwen2.5-0.5B-Instruct');
  assert.equal(TIER_BY_USE.multimodal, 'google/gemma-4-E4B-it');
  assert.equal(TIER_BY_USE['on-device-multimodal-frontier'], 'google/gemma-4-E2B-it');
  assert.equal(ARCH_CATALOG.ARCH_1B.backbone_id, 'openbmb/MiniCPM5-1B');

  const edge = recommend({ use: 'edge', vram_gb: 2, permissive: true, optimize_for: 'mmlu_pro' });
  assert.equal(edge.pick, 'openbmb/MiniCPM5-1B');
  assert.match(edge.summary, /benchmark_mmlu_pro: 48\.85/);

  const mm = recommend({ use: 'multimodal', optimize_for: 'mmlu_pro' });
  assert.equal(mm.pick, 'google/gemma-4-E4B-it');
  assert.match(mm.summary, /benchmark_mmlu_pro: 69\.4/);
});

test('W610/W977/W978/W1001 #10 - backend spec marks small-LLM registry, benchmark, and provisioning work closed', () => {
  const spec = fs.readFileSync(path.join(ROOT, 'docs', 'STACK-TECH-SPEC-2026-06-15.md'), 'utf8');
  assert.match(spec, /CLOSED W610: add 2026 frontier students/i);
  assert.match(spec, /CLOSED W610: re-point default\/3-4B tier picks off Qwen2\.5/i);
  assert.match(spec, /LFM-1\.0/i, 'spec must record the current LFM license instead of Apache');
  assert.match(spec, /CLOSED W977: Add benchmark score fields/i);
  assert.match(spec, /CLOSED W978: Add MiniCPM5 and Gemma 4 edge frontier rows/i);
  assert.match(spec, /CLOSED W1001: Add fail-closed neural compile provisioning contract/i);
  assert.doesNotMatch(spec, /\[minor\] No benchmark\/score fields/i);
  assert.doesNotMatch(spec, /MiniCPM5-1B and Gemma-4 E2B\/E4B .*absent/i);
  assert.match(spec, /\[external\] Claimable turnkey small-LLM training/i, 'external neural training execution gate must remain tracked');
});
