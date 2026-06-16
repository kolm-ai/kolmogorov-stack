// tests/finalized-c1-distillation-pipeline.test.js
//
// FINALIZED-C1 - Teacher -> Student Distillation Pipeline.
//
// Proves the atom's contract end-to-end with NO heavy deps (pure JS, node:test):
//
//   1. Learned judge + rejection sampling build a sequence-level KD corpus
//      (best candidate kept iff it clears the accept threshold; below-bar
//      prompts are reported, not silently dropped). Train/eval scoring share
//      one judge function (eval_adapter parity).
//   2. Teacher-fidelity is a HARD CONTRACT: a student below the declared
//      fraction of teacher holdout accuracy is BLOCKED; an unverifiable teacher
//      anchor is fail-closed (not shippable); the contract cannot be defeated
//      by declaring min_fidelity <= 0.
//   3. Holdout disjointness is fail-closed (overlap throws); train-only.
//   4. The privacy boundary is provable + fail-closed: raw rows never reach a
//      hyperscaler teacher; redacted/synthetic rows or a local/open-weights
//      teacher pass.
//   5. Real LoRA/QLoRA trainer + INT4 (AWQ/GPTQ/NVFP4) export are routed,
//      env-gated, and fail LOUD with an install hint (never a silent stub).
//   6. The full plan -> run -> finalizeShip orchestration ties it together and
//      stamps a manifest fragment for the signed-.kolm receipt chain.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import pipeline, {
  PIPELINE_VERSION,
  OBJECTIVES,
  QUANT_EXPORT_TARGETS,
  DEFAULT_MIN_FIDELITY,
  FIDELITY_FLOOR,
  scoreWithJudge,
  rejectionSample,
  assertHoldoutDisjoint,
  classifyTeacherSource,
  assertPrivacyBoundary,
  resolveFidelityContract,
  evaluateFidelityContract,
  routeTrainer,
  planQuantExport,
  splitCorpus,
  planDistillation,
  finalizeShip,
  runDistillation,
} from '../src/distillation-pipeline-c1.js';

// ---------------------------------------------------------------------------
// 1. Learned judge + rejection sampling (sequence-level KD).
// ---------------------------------------------------------------------------

test('learned judge: overlap with reference scores high; off-reference low', () => {
  const ref = 'the capital of france is paris located on the seine river';
  const good = scoreWithJudge('paris is the capital of france on the seine river', ref);
  const bad = scoreWithJudge('bananas are yellow and grow in tropical climates', ref);
  assert.equal(good.judge, 'local');
  assert.ok(good.score > bad.score, 'on-reference candidate must outscore off-reference');
  assert.ok(good.score > 0.5, `good candidate should clear 0.5, got ${good.score}`);
});

test('learned judge: penalizes leaked chain-of-thought and refusals and emptiness', () => {
  const ref = 'paris is the capital of france';
  const leak = scoreWithJudge('<think>paris is the capital</think> paris is the capital of france', ref);
  const clean = scoreWithJudge('paris is the capital of france', ref);
  assert.ok(leak.score < clean.score, 'leaked CoT must be penalized');
  assert.ok(leak.reasons.includes('cot_leak'));

  const refusal = scoreWithJudge('as an ai i cannot answer that', ref);
  assert.ok(refusal.reasons.includes('refusal'));

  const empty = scoreWithJudge('', ref);
  assert.equal(empty.score, 0);
  assert.ok(empty.reasons.includes('empty_candidate'));

  const noRef = scoreWithJudge('something', '');
  assert.equal(noRef.score, null, 'no reference -> null score, caller must handle');
});

test('rejection sampling: keeps best candidate above threshold, reports rejects', () => {
  const rows = [
    {
      prompt: 'capital of france?',
      reference: 'paris is the capital of france',
      candidates: ['paris is the capital of france', 'lyon is the capital', 'i am not sure'],
    },
    {
      // No candidate is close to the reference -> rejected, not polluting corpus.
      prompt: 'capital of japan?',
      reference: 'tokyo is the capital of japan',
      candidates: ['bananas grow on trees', 'the weather is nice today'],
    },
  ];
  const out = rejectionSample(rows, { accept_threshold: 0.55 });
  assert.equal(out.ok, true);
  assert.equal(out.accepted.length, 1, 'only the france prompt has an acceptable candidate');
  assert.equal(out.accepted[0].response, 'paris is the capital of france');
  assert.ok(out.accepted[0].judge_score >= 0.55);
  assert.equal(out.rejected.length, 1);
  assert.equal(out.rejected[0].reason, 'below_threshold');
  assert.equal(out.stats.with_reference, 2);
});

test('rejection sampling: reference-free self-consistency keeps the consensus answer', () => {
  const rows = [{
    prompt: 'what is 2+2?',
    candidates: ['the answer is four', 'the answer is four indeed', 'forty two'],
  }];
  const out = rejectionSample(rows, { accept_threshold: 0.3 });
  assert.equal(out.stats.self_consistency, 1);
  assert.equal(out.accepted.length, 1);
  assert.ok(/four/.test(out.accepted[0].response), 'consensus (four) should win over the outlier');
  assert.equal(out.accepted[0].basis, 'self_consistency');
});

// ---------------------------------------------------------------------------
// 2. Teacher-fidelity HARD CONTRACT.
// ---------------------------------------------------------------------------

test('fidelity contract: student below declared fraction is BLOCKED from ship', () => {
  // teacher holdout = 0.90, student = 0.72 -> T = 0.80 < default 0.90 -> blocked.
  const v = evaluateFidelityContract({
    student_holdout_accuracy: 0.72,
    teacher_holdout_accuracy: 0.90,
  });
  assert.equal(v.ok, true);
  assert.equal(v.ships, false, 'T=0.80 must NOT ship under a 0.90 contract');
  assert.equal(v.verdict, 'blocked');
  assert.ok(v.shortfall > 0);
  assert.ok(/BLOCKED/.test(v.reason));
});

test('fidelity contract: student at/above declared fraction ships', () => {
  // teacher = 0.90, student = 0.855 -> T = 0.95 >= 0.90 -> ships.
  const v = evaluateFidelityContract({
    student_holdout_accuracy: 0.855,
    teacher_holdout_accuracy: 0.90,
  });
  assert.equal(v.ships, true);
  assert.equal(v.verdict, 'pass');
  assert.equal(v.shortfall, 0);
  assert.ok(v.teacher_fidelity >= 0.90);
});

test('fidelity contract: unverifiable teacher anchor is fail-closed (not shippable)', () => {
  const noTeacher = evaluateFidelityContract({ student_holdout_accuracy: 0.9, teacher_holdout_accuracy: null });
  assert.equal(noTeacher.ships, false);
  assert.equal(noTeacher.verdict, 'unverifiable');

  const zeroTeacher = evaluateFidelityContract({ student_holdout_accuracy: 0.9, teacher_holdout_accuracy: 0.01 });
  assert.equal(zeroTeacher.ships, false, 'teacher below honest floor cannot anchor a ratio');
  assert.equal(zeroTeacher.verdict, 'unverifiable');

  const noStudent = evaluateFidelityContract({ student_holdout_accuracy: undefined, teacher_holdout_accuracy: 0.9 });
  assert.equal(noStudent.ships, false);
  assert.equal(noStudent.verdict, 'unverifiable');
});

test('fidelity contract: cannot be defeated by declaring min_fidelity <= 0', () => {
  const resolved = resolveFidelityContract({ min_fidelity: 0 });
  assert.ok(resolved >= FIDELITY_FLOOR, `declaring 0 must clamp up to the floor (${FIDELITY_FLOOR}), got ${resolved}`);
  const resolvedNeg = resolveFidelityContract({ min_fidelity: -5 });
  assert.ok(resolvedNeg >= FIDELITY_FLOOR);
  // A custom-but-valid tighter contract is honored.
  assert.equal(resolveFidelityContract({ min_fidelity: 0.95 }), 0.95);
  assert.equal(DEFAULT_MIN_FIDELITY, 0.90);
});

// ---------------------------------------------------------------------------
// 3. Holdout disjointness (moat: fail-closed) + train-only.
// ---------------------------------------------------------------------------

test('holdout disjointness: overlap throws fail-closed; disjoint returns a proof', () => {
  const train = [{ prompt: 'a' }, { prompt: 'b' }];
  const holdoutBad = [{ prompt: 'b' }, { prompt: 'c' }]; // 'b' overlaps
  assert.throws(() => assertHoldoutDisjoint(train, holdoutBad), (e) => e.code === 'holdout_not_disjoint');

  const holdoutOk = [{ prompt: 'c' }, { prompt: 'd' }];
  const proof = assertHoldoutDisjoint(train, holdoutOk);
  assert.equal(proof.disjoint, true);
  assert.equal(proof.overlap_count, 0);
  assert.equal(proof.train_size, 2);
});

test('splitCorpus: deterministic, holdout_only never enters train', () => {
  const rows = [];
  for (let i = 0; i < 50; i++) rows.push({ prompt: `prompt number ${i}` });
  rows.push({ prompt: 'forced-holdout', holdout_only: true });
  const a = splitCorpus(rows, { holdout_fraction: 0.2 });
  const b = splitCorpus(rows.slice().reverse(), { holdout_fraction: 0.2 });
  // Determinism: same partition regardless of order (content-hash bucketing).
  const aTrain = new Set(a.train.map((r) => r.prompt));
  const bTrain = new Set(b.train.map((r) => r.prompt));
  assert.deepEqual([...aTrain].sort(), [...bTrain].sort());
  // holdout_only row never in train.
  assert.ok(!aTrain.has('forced-holdout'));
  assert.ok(a.holdout.some((r) => r.prompt === 'forced-holdout'));
  // The split is disjoint by construction.
  const proof = assertHoldoutDisjoint(a.train, a.holdout);
  assert.equal(proof.disjoint, true);
});

// ---------------------------------------------------------------------------
// 4. Privacy boundary (provable, fail-closed for external teachers).
// ---------------------------------------------------------------------------

test('teacher source classification: proprietary vs open-weights vs local', () => {
  assert.equal(classifyTeacherSource('anthropic:claude-opus-4-7'), 'proprietary');
  assert.equal(classifyTeacherSource('openai:gpt-4o-mini'), 'proprietary');
  assert.equal(classifyTeacherSource('claude'), 'proprietary');
  assert.equal(classifyTeacherSource('qwen2.5-7b'), 'open-weights');
  assert.equal(classifyTeacherSource('local:/models/qwen'), 'open-weights');
  assert.equal(classifyTeacherSource('hf:Qwen/Qwen2.5-7B'), 'open-weights');
  assert.equal(classifyTeacherSource('something-unknown'), 'unknown');
});

test('privacy boundary: raw rows BLOCKED from a hyperscaler teacher', () => {
  const raw = [{ prompt: 'real customer SSN 123', response: 'x' }];
  const v = assertPrivacyBoundary(raw, 'anthropic:claude-opus-4-7');
  assert.equal(v.ok, false, 'raw row to proprietary teacher must be blocked');
  assert.equal(v.external_egress, true);
  assert.equal(v.leaking_rows, 1);
  assert.ok(v.provable);
  assert.ok(/never passes raw customer data/i.test(v.hint));
});

test('privacy boundary: redacted/synthetic rows pass; local teacher passes by construction', () => {
  const redacted = [{ prompt: '[REDACTED]', redaction_policy: 'phi-v2' }, { prompt: 'gen', synthesized: true }];
  const ext = assertPrivacyBoundary(redacted, 'anthropic:claude-opus-4-7');
  assert.equal(ext.ok, true, 'all-redacted rows may egress to an external teacher');
  assert.equal(ext.leaking_rows, 0);

  // Local / open-weights teacher: boundary satisfied by construction even with raw rows.
  const raw = [{ prompt: 'real customer data' }];
  const local = assertPrivacyBoundary(raw, 'local:/models/qwen');
  assert.equal(local.ok, true);
  assert.equal(local.external_egress, false);
  assert.equal(local.boundary, 'local-or-open-weights');
});

// ---------------------------------------------------------------------------
// 5. Real trainer + INT4 export routing (env-gated, fail-LOUD).
// ---------------------------------------------------------------------------

test('routeTrainer: every objective routes to a shell + carries an install hint', async () => {
  for (const obj of OBJECTIVES) {
    const r = await routeTrainer(obj);
    assert.equal(r.ok, true, `objective ${obj} should route`);
    assert.ok(typeof r.install_hint === 'string' && r.install_hint.length > 0, `${obj} must carry an install hint`);
    // ready is a boolean gate; when not ready the hint is the fail-loud path.
    assert.equal(typeof r.ready, 'boolean');
  }
  const bad = await routeTrainer('not-a-real-objective');
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'unknown_objective');
});

test('planQuantExport: INT4 targets route with GPU gate + install hint; none is a no-op', async () => {
  // none -> no export planned.
  const none = await planQuantExport('none');
  assert.equal(none.export_planned, false);

  // AWQ/GPTQ/NVFP4 require a GPU; without KOLM_GPU they are not ready but the
  // real path is preserved (install hint present, never a silent stub).
  const savedGpu = process.env.KOLM_GPU;
  const savedCuda = process.env.CUDA_VISIBLE_DEVICES;
  delete process.env.KOLM_GPU;
  delete process.env.CUDA_VISIBLE_DEVICES;
  try {
    for (const t of ['awq', 'gptq', 'nvfp4']) {
      const p = await planQuantExport(t);
      assert.equal(p.ok, true);
      assert.equal(p.requires_gpu, true);
      assert.equal(p.ready, false, `${t} must NOT be ready without a GPU`);
      assert.ok(/install|pip|cuda/i.test(p.install_hint + ' ' + p.note), `${t} must fail loud with an install/GPU hint`);
    }
    // With a GPU flag set, AWQ becomes ready.
    process.env.KOLM_GPU = '1';
    const ready = await planQuantExport('awq');
    assert.equal(ready.ready, true);
  } finally {
    if (savedGpu === undefined) delete process.env.KOLM_GPU; else process.env.KOLM_GPU = savedGpu;
    if (savedCuda === undefined) delete process.env.CUDA_VISIBLE_DEVICES; else process.env.CUDA_VISIBLE_DEVICES = savedCuda;
  }

  const bad = await planQuantExport('totally-unknown');
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'unknown_quant_target');
  assert.ok(QUANT_EXPORT_TARGETS.includes('awq') && QUANT_EXPORT_TARGETS.includes('nvfp4'));
});

// ---------------------------------------------------------------------------
// 6. Full orchestration: plan -> run -> finalizeShip.
// ---------------------------------------------------------------------------

function buildCorpus(n = 60) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      prompt: `question ${i}: what is the value of item ${i}?`,
      reference: `the value of item ${i} is ${i * 2}`,
      candidates: [`the value of item ${i} is ${i * 2}`, `i don't know item ${i}`],
      redaction_policy: 'phi-v2', // pre-redacted so an external teacher is allowed
    });
  }
  return rows;
}

test('planDistillation: builds a train-only plan with disjoint holdout + privacy verdict + fidelity contract', () => {
  const plan = planDistillation({
    rows: buildCorpus(60),
    objective: 'seq_kd_rejection',
    teacher: 'anthropic:claude-opus-4-7',
    student_base: 'qwen-0.5b',
    quant_export: 'awq',
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.train_only, true);
  assert.equal(plan.objective, 'seq_kd_rejection');
  assert.equal(plan.holdout_disjoint_proof.disjoint, true);
  assert.ok(plan.split.train > 0 && plan.split.holdout > 0);
  assert.equal(plan.privacy_boundary.ok, true, 'redacted corpus may use an external teacher');
  assert.ok(plan.rejection_sampling, 'seq_kd_rejection with candidates builds an accepted corpus');
  assert.ok(plan.sft_corpus_size > 0);
  assert.equal(plan.fidelity_contract.min_fidelity, DEFAULT_MIN_FIDELITY);
  assert.equal(plan.quant_export_target, 'awq');
});

test('planDistillation: raw rows + proprietary teacher make the plan NOT ok (fail-closed)', () => {
  const rawRows = [];
  for (let i = 0; i < 40; i++) rawRows.push({ prompt: `raw customer row ${i}` }); // no redaction stamp
  const plan = planDistillation({
    rows: rawRows,
    objective: 'on_policy_rkl',
    teacher: 'openai:gpt-4o-mini',
  });
  assert.equal(plan.ok, false, 'raw rows to a proprietary teacher must fail the plan');
  assert.equal(plan.privacy_boundary.ok, false);
  assert.ok(plan.privacy_boundary.leaking_rows > 0);
});

test('finalizeShip: enforces the T contract as the FINAL ship gate', () => {
  const plan = planDistillation({
    rows: buildCorpus(60),
    objective: 'seq_kd_rejection',
    teacher: 'local:/models/qwen2.5-7b',
    student_base: 'qwen-0.5b',
    min_fidelity: 0.90,
  });
  assert.equal(plan.ok, true);

  // Student fell short of the teacher on the holdout -> BLOCKED.
  const blocked = finalizeShip({ plan, student_holdout_accuracy: 0.70, teacher_holdout_accuracy: 0.90 });
  assert.equal(blocked.ships, false);
  assert.ok(blocked.blockers.some((b) => /teacher_fidelity/.test(b)));
  assert.equal(blocked.fidelity_contract.verdict, 'blocked');

  // Student reached the contract -> ships, with a manifest fragment for the seal.
  const shipped = finalizeShip({ plan, student_holdout_accuracy: 0.864, teacher_holdout_accuracy: 0.90 });
  assert.equal(shipped.ships, true);
  assert.equal(shipped.manifest_fragment.train_only, true);
  assert.equal(shipped.manifest_fragment.holdout_disjoint, true);
  assert.ok(shipped.manifest_fragment.teacher_fidelity_score >= 0.90);
  assert.equal(shipped.manifest_fragment.distill_pipeline_version, PIPELINE_VERSION);
  assert.equal(shipped.manifest_fragment.teacher_fidelity_verdict, 'pass');
});

test('runDistillation: stages a run dir + manifest with proofs; deferred + fail-loud without GPU/torch', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'c1-distill-'));
  try {
    const savedFull = process.env.KOLM_DISTILL_FULL;
    delete process.env.KOLM_DISTILL_FULL; // force not-ready (collect-only) path
    let res;
    try {
      const rows = buildCorpus(40);
      const split = splitCorpus(rows, { holdout_fraction: 0.2 });
      const rej = rejectionSample(split.train, { accept_threshold: 0.4 });
      res = await runDistillation(
        { rows, objective: 'seq_kd_rejection', teacher: 'local:/models/qwen', student_base: 'qwen-0.5b', quant_export: 'gguf' },
        { out_dir: path.join(tmp, 'run1'), accepted_corpus: rej.accepted },
      );
    } finally {
      if (savedFull === undefined) delete process.env.KOLM_DISTILL_FULL; else process.env.KOLM_DISTILL_FULL = savedFull;
    }
    assert.equal(res.ok, true);
    assert.ok(fs.existsSync(res.manifest_path), 'run manifest must be written');
    const manifest = JSON.parse(fs.readFileSync(res.manifest_path, 'utf8'));
    assert.equal(manifest.train_only, true);
    assert.equal(manifest.holdout_disjoint_proof.disjoint, true);
    assert.equal(manifest.privacy_boundary.ok, true);
    assert.ok(manifest.fidelity_contract.min_fidelity >= FIDELITY_FLOOR);
    // The accepted SFT corpus was written for the model-tier SFT step.
    assert.ok(res.sft_corpus_path && fs.existsSync(res.sft_corpus_path));
    // Deferred (no GPU/torch) -> real path preserved with a loud install hint.
    if (res.deferred) assert.ok(typeof res.install_hint === 'string' && res.install_hint.length > 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('default export surface exposes the full atom API', () => {
  for (const fn of ['scoreWithJudge', 'rejectionSample', 'assertHoldoutDisjoint', 'assertPrivacyBoundary',
    'evaluateFidelityContract', 'routeTrainer', 'planQuantExport', 'planDistillation', 'finalizeShip', 'runDistillation']) {
    assert.equal(typeof pipeline[fn], 'function', `default export must expose ${fn}`);
  }
  assert.equal(pipeline.PIPELINE_VERSION, PIPELINE_VERSION);
});
