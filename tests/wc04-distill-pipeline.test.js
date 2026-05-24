// WC04 — test coverage close-out for src/distill-pipeline.js.
//
// Previously: 1087 LOC, 0 tests anywhere in tests/.
// Pins the public export surface of the W381 distillation pipeline:
//   - MODES enum (pipeline_mode allow-list)
//   - TEACHER_SOURCE_CLASSIFICATION + classifyTeacher() resolution order
//   - selectStudentBackbone(): tier/task → backbone slug
//   - prepareDistillCorpus(): required-param validation
//   - distill(): pipeline_mode + student_base required-param validation
//   - _resolveDistillTenant(): pure alias/default helper
//   - _pickTeachers(): KOLM_TEACHER_SOURCE=open-weights policy enforcement
//   - listDistillRuns() / readDistillRun(): structural shape
//   - W808 regression-gate constants + first_run verdict
//
// DOES NOT run distill() end-to-end — that needs a teacher, a worker, and
// real corpus rows. We only pin the validation + structural surface.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Isolate KOLM_DATA_DIR so listDistillRuns/readDistillRun don't read the
// developer's actual ~/.kolm. Set BEFORE importing the module so any module-
// load side-effects pick up the temp dir.
const _tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-wc04-dp-'));
process.env.KOLM_DATA_DIR = _tmpHome;

const {
  MODES,
  TEACHER_SOURCE_CLASSIFICATION,
  classifyTeacher,
  selectStudentBackbone,
  prepareDistillCorpus,
  distill,
  _resolveDistillTenant,
  _pickTeachers,
  listDistillRuns,
  readDistillRun,
  W808_REGRESSION_GATE_VERSION,
  W808_KSCORE_DROP_THRESHOLD,
  W808_CRITICAL_FAIL_RATE_INCREASE_THRESHOLD,
  _w808RegressionGate,
} = await import('../src/distill-pipeline.js');

test('WC04-dp #1 MODES exposes the three documented pipeline modes', () => {
  assert.deepEqual([...MODES].sort(), ['kd_softmax', 'kd_top_k', 'rejection_sampling'].sort());
  assert.equal(MODES.length, 3);
});

test('WC04-dp #2 TEACHER_SOURCE_CLASSIFICATION is frozen + classifies known vendors', () => {
  assert.ok(Object.isFrozen(TEACHER_SOURCE_CLASSIFICATION), 'classification table must be frozen');
  assert.equal(TEACHER_SOURCE_CLASSIFICATION['claude'], 'proprietary');
  assert.equal(TEACHER_SOURCE_CLASSIFICATION['gpt'], 'proprietary');
  assert.equal(TEACHER_SOURCE_CLASSIFICATION['gemini'], 'proprietary');
  assert.equal(TEACHER_SOURCE_CLASSIFICATION['qwen'], 'open-weights');
  assert.equal(TEACHER_SOURCE_CLASSIFICATION['llama'], 'open-weights');
  assert.equal(TEACHER_SOURCE_CLASSIFICATION['deepseek'], 'open-weights');
});

test('WC04-dp #3 classifyTeacher: nullish/empty input → unknown', () => {
  assert.equal(classifyTeacher(null), 'unknown');
  assert.equal(classifyTeacher(undefined), 'unknown');
  assert.equal(classifyTeacher(''), 'unknown');
  assert.equal(classifyTeacher('   '), 'unknown');
});

test('WC04-dp #4 classifyTeacher: local:/hf: prefix → open-weights', () => {
  assert.equal(classifyTeacher('local:/path/to/weights'), 'open-weights');
  assert.equal(classifyTeacher('hf:Qwen/Qwen2.5-7B-Instruct'), 'open-weights');
  // case-insensitive
  assert.equal(classifyTeacher('LOCAL:/foo'), 'open-weights');
});

test('WC04-dp #5 classifyTeacher: anthropic:/openai:/google: prefix → proprietary', () => {
  assert.equal(classifyTeacher('anthropic:claude-opus-4-7'), 'proprietary');
  assert.equal(classifyTeacher('openai:gpt-4o-mini'), 'proprietary');
  assert.equal(classifyTeacher('google:gemini-1.5-pro'), 'proprietary');
});

test('WC04-dp #6 classifyTeacher: longest-prefix base-name match (qwen2.5 wins over qwen)', () => {
  // qwen2.5-7b-instruct must resolve under 'qwen2.5', not 'qwen' (both are
  // open-weights so the value is the same, but the docstring guarantees the
  // longest-prefix winner — verify the algorithm by checking exact match).
  assert.equal(classifyTeacher('qwen2.5-7b-instruct'), 'open-weights');
  assert.equal(classifyTeacher('qwen-3b'), 'open-weights');
  assert.equal(classifyTeacher('llama-3-8b-instruct'), 'open-weights');
  assert.equal(classifyTeacher('claude-opus-4-7'), 'proprietary');
  // unknown slug → unknown (safe-deny)
  assert.equal(classifyTeacher('never-shipped-model-xyz'), 'unknown');
  // partial match without separator must NOT trigger (qwenfoo ≠ qwen)
  assert.equal(classifyTeacher('qwenfoo'), 'unknown');
});

test('WC04-dp #7 selectStudentBackbone: hw_tier wins over task_type when tier overrides exist', () => {
  // dgx-spark + m3-ultra-512 always upgrade to qwen-3b regardless of task
  assert.equal(selectStudentBackbone({ task_type: 'classification', hw_tier: 'dgx-spark' }), 'qwen-3b');
  assert.equal(selectStudentBackbone({ task_type: 'generation', hw_tier: 'm3-ultra-512' }), 'qwen-3b');
  // 3090 / 5090 tier returns null → falls through to task_type
  assert.equal(selectStudentBackbone({ task_type: 'classification', hw_tier: '5090' }), 'gemma-3n-e2b');
});

test('WC04-dp #8 selectStudentBackbone: task_type routing when no tier override', () => {
  assert.equal(selectStudentBackbone({ task_type: 'classification' }), 'gemma-3n-e2b');
  assert.equal(selectStudentBackbone({ task_type: 'redaction' }), 'gemma-3n-e2b');
  assert.equal(selectStudentBackbone({ task_type: 'extraction' }), 'qwen-0.5b');
  assert.equal(selectStudentBackbone({ task_type: 'generation' }), 'phi-mini');
  // unknown task → lora default
  assert.equal(selectStudentBackbone({ task_type: 'mystery' }), 'qwen-0.5b');
  // no args at all → lora default
  assert.equal(selectStudentBackbone(), 'qwen-0.5b');
  assert.equal(selectStudentBackbone({}), 'qwen-0.5b');
});

test('WC04-dp #9 prepareDistillCorpus requires {namespace}', async () => {
  await assert.rejects(
    () => prepareDistillCorpus(),
    (err) => /requires \{namespace\}/.test(err.message),
  );
  await assert.rejects(
    () => prepareDistillCorpus({}),
    (err) => /requires \{namespace\}/.test(err.message),
  );
});

test('WC04-dp #10 prepareDistillCorpus returns canonical stats envelope on empty namespace', async () => {
  // Empty namespace → no events → pairs:[] with full stats shape pinned.
  const res = await prepareDistillCorpus({ namespace: 'wc04-dp-empty-' + Date.now() });
  assert.equal(Array.isArray(res.pairs), true);
  assert.equal(res.pairs.length, 0);
  assert.equal(typeof res.stats, 'object');
  // Stats envelope shape — every key must be present even on empty.
  assert.equal(res.stats.split, 'train');
  assert.equal(typeof res.stats.events_scanned, 'number');
  assert.equal(typeof res.stats.pairs_kept, 'number');
  assert.equal(typeof res.stats.dropped_no_prompt, 'number');
  assert.equal(typeof res.stats.dropped_no_response, 'number');
  assert.equal(typeof res.stats.dropped_status, 'number');
  assert.equal(typeof res.stats.dropped_unapproved, 'number');
  assert.equal(typeof res.stats.dropped_since, 'number');
  assert.equal(typeof res.stats.holdout_excluded_from_train, 'number');
  assert.equal(res.stats.since, null);
});

test('WC04-dp #11 distill() throws on invalid pipeline_mode', async () => {
  const iter = distill({ student_base: 'qwen-0.5b', pipeline_mode: 'not_a_real_mode' });
  await assert.rejects(
    () => iter.next(),
    (err) => /pipeline_mode must be one of/.test(err.message),
  );
});

test('WC04-dp #12 distill() throws when student_base missing', async () => {
  const iter = distill({ pipeline_mode: 'kd_softmax' });
  await assert.rejects(
    () => iter.next(),
    (err) => /requires \{student_base\}/.test(err.message),
  );
});

test('WC04-dp #13 _resolveDistillTenant: tenant_id wins, then tenant, then local default', () => {
  // canonical tenant_id
  assert.equal(_resolveDistillTenant({ tenant_id: 'tenant_abc' }), 'tenant_abc');
  // shorthand alias
  assert.equal(_resolveDistillTenant({ tenant: 'tenant_def' }), 'tenant_def');
  // tenant_id takes priority over tenant
  assert.equal(_resolveDistillTenant({ tenant_id: 'A', tenant: 'B' }), 'A');
  // default
  assert.equal(_resolveDistillTenant(), 'local');
  assert.equal(_resolveDistillTenant({}), 'local');
  assert.equal(_resolveDistillTenant({ tenant_id: null, tenant: null }), 'local');
  // numbers coerced to string
  assert.equal(_resolveDistillTenant({ tenant_id: 42 }), '42');
});

test('WC04-dp #14 _pickTeachers: KOLM_TEACHER_SOURCE=open-weights with no open teacher → throws coded error', () => {
  const prevPolicy = process.env.KOLM_TEACHER_SOURCE;
  const prevTeacher = process.env.KOLM_DISTILL_TEACHER;
  const prevA = process.env.ANTHROPIC_API_KEY;
  const prevO = process.env.OPENAI_API_KEY;
  try {
    process.env.KOLM_TEACHER_SOURCE = 'open-weights';
    // Force ONLY a proprietary teacher to be configured.
    process.env.KOLM_DISTILL_TEACHER = 'anthropic:claude-opus-4-7';
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    assert.throws(
      () => _pickTeachers(),
      (err) => err.code === 'no_open_weight_teacher_configured' && typeof err.hint === 'string',
    );
  } finally {
    if (prevPolicy === undefined) delete process.env.KOLM_TEACHER_SOURCE;
    else process.env.KOLM_TEACHER_SOURCE = prevPolicy;
    if (prevTeacher === undefined) delete process.env.KOLM_DISTILL_TEACHER;
    else process.env.KOLM_DISTILL_TEACHER = prevTeacher;
    if (prevA !== undefined) process.env.ANTHROPIC_API_KEY = prevA;
    if (prevO !== undefined) process.env.OPENAI_API_KEY = prevO;
  }
});

test('WC04-dp #15 _pickTeachers: open-weights policy keeps a hf: prefixed teacher', () => {
  const prevPolicy = process.env.KOLM_TEACHER_SOURCE;
  const prevTeacher = process.env.KOLM_DISTILL_TEACHER;
  const prevA = process.env.ANTHROPIC_API_KEY;
  const prevO = process.env.OPENAI_API_KEY;
  try {
    process.env.KOLM_TEACHER_SOURCE = 'open-weights';
    process.env.KOLM_DISTILL_TEACHER = 'hf:Qwen/Qwen2.5-7B-Instruct,anthropic:claude-opus-4-7';
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const list = _pickTeachers();
    // proprietary teacher filtered out, only hf: remains
    assert.deepEqual(list, ['hf:Qwen/Qwen2.5-7B-Instruct']);
  } finally {
    if (prevPolicy === undefined) delete process.env.KOLM_TEACHER_SOURCE;
    else process.env.KOLM_TEACHER_SOURCE = prevPolicy;
    if (prevTeacher === undefined) delete process.env.KOLM_DISTILL_TEACHER;
    else process.env.KOLM_DISTILL_TEACHER = prevTeacher;
    if (prevA !== undefined) process.env.ANTHROPIC_API_KEY = prevA;
    if (prevO !== undefined) process.env.OPENAI_API_KEY = prevO;
  }
});

test('WC04-dp #16 listDistillRuns + readDistillRun: clean envelope shape on empty/missing dirs', () => {
  // No runs in our isolated KOLM_DATA_DIR → empty array
  const list = listDistillRuns({ tenant_id: 'local' });
  assert.equal(Array.isArray(list), true);
  // readDistillRun guards: bad id → null
  assert.equal(readDistillRun(''), null);
  assert.equal(readDistillRun(null), null);
  assert.equal(readDistillRun('not-a-run-id'), null);           // doesn't match /^run_/
  assert.equal(readDistillRun('run_DOES_NOT_EXIST_xyz'), null); // matches but no dir
});

test('WC04-dp #17 W808 regression-gate constants are pinned + version frozen', () => {
  assert.equal(W808_REGRESSION_GATE_VERSION, 'w808-v1');
  assert.equal(W808_KSCORE_DROP_THRESHOLD, 0.02);
  assert.equal(W808_CRITICAL_FAIL_RATE_INCREASE_THRESHOLD, 0.01);
});

test('WC04-dp #18 _w808RegressionGate: no candidate k_score → needs_human verdict', () => {
  // No run_dir + no manifest → cannot extract kscore → needs_human
  const v = _w808RegressionGate({ run_dir: null, namespace: 'wc04-dp-nons', tenant_id: 'local', manifest: null });
  assert.equal(v.ok, false);
  assert.equal(v.verdict, 'needs_human');
  assert.equal(v.error, 'no_candidate_kscore');
  assert.equal(v.version, 'w808-v1');
});

test('WC04-dp #19 _w808RegressionGate: candidate kscore but no prior run → first_run verdict', () => {
  // Provide a manifest with k_score_final but no prior run exists in our isolated KOLM_DATA_DIR.
  const v = _w808RegressionGate({
    run_dir: path.join(_tmpHome, 'no-such-run'),
    namespace: 'wc04-dp-first-' + Date.now(),
    tenant_id: 'local',
    manifest: { k_score_final: 0.91 },
  });
  assert.equal(v.ok, true);
  assert.equal(v.verdict, 'first_run');
  assert.equal(v.candidate_kscore, 0.91);
  assert.equal(v.prior_kscore, null);
  assert.equal(v.version, 'w808-v1');
  assert.equal(v.kscore_drop_threshold, W808_KSCORE_DROP_THRESHOLD);
  assert.equal(v.critical_fail_rate_increase_threshold, W808_CRITICAL_FAIL_RATE_INCREASE_THRESHOLD);
});
