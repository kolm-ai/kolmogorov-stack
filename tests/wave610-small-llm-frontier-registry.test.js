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
  TIER_BY_USE,
  info,
  list,
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
    ARCH_1B: 'LiquidAI/LFM2.5-1.2B-Instruct',
    ARCH_3B: 'Qwen/Qwen3-4B-Instruct-2507',
    ARCH_7B: 'Qwen/Qwen3-8B',
    ARCH_MOE_8x3: 'Qwen/Qwen3-4B-Instruct-2507',
  };
  for (const [key, id] of Object.entries(expected)) {
    assert.equal(ARCH_CATALOG[key].backbone_id, id, `${key} must point to ${id}`);
    assert.equal(resolveArchBackbone(key)?.id, id, `${key} did not resolve via models.info()`);
  }
});

test('W610 #7 - backend spec marks small-LLM surgical registry work closed', () => {
  const spec = fs.readFileSync(path.join(ROOT, 'docs', 'STACK-TECH-SPEC-2026-06-15.md'), 'utf8');
  assert.match(spec, /CLOSED W610: add 2026 frontier students/i);
  assert.match(spec, /CLOSED W610: re-point default\/3-4B tier picks off Qwen2\.5/i);
  assert.match(spec, /LFM-1\.0/i, 'spec must record the current LFM license instead of Apache');
  assert.match(spec, /benchmark score fields/i, 'benchmark-field follow-up must remain tracked');
  assert.match(spec, /real neural-distillation path/i, 'neural training gap must remain tracked');
});
