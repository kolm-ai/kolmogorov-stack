// C4 - Cross-tokenizer (different-vocab) KD via logit alignment + sequence-level
// fallback. Proves: (1) shared-vocab fast path is detected as NO mismatch and
// is a byte-identical passthrough; (2) a vocab mismatch is auto-detected and
// routed to a logit-alignment tier (ULD / MinED) when logits are available;
// (3) the always-available sequence-level KD fallback (Kim & Rush) takes over
// when logits are unavailable or alignment is force-disabled (graceful
// downgrade); (4) the tier + alignment method + papers[] are stamped into
// run-meta; (5) the ULD optimal-transport + MinED alignments produce real,
// normalised student soft targets across a vocab mismatch.
//
// GPU-free, network-free, no new deps. Pure-JS math is exercised directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CROSS_TOKENIZER_VERSION,
  TIERS,
  SEQUENCE_KD_PAPER,
  ULD_PAPER,
  MINED_PAPER,
  papersForTier,
  normalizeTokenizer,
  detectVocabMismatch,
  selectCrossTokenizerTier,
  tokenGroundCost,
  editDistance,
  uldAlignDistribution,
  minedAlignDistribution,
  buildMinedCrosswalk,
  buildSequenceKdRows,
  stampCrossTokenizerMeta,
  planCrossTokenizerKd,
} from '../src/distill-cross-tokenizer.js';

// Two toy vocabularies that differ (the mismatch case).
const TEACHER_VOCAB = ['the', 'Ġcat', 'Ġsat', 'Ġon', 'Ġmat', 'dog'];
const STUDENT_VOCAB = ['the', '▁cat', '▁s', '▁at', '▁on', '▁mat', '▁dog', 'xyz'];

function cleanEnv() {
  delete process.env.KOLM_XTOK_ALIGNMENT;
  delete process.env.KOLM_XTOK_FORCE_SEQKD;
}

test('1. shared-vocab fast path: identical vocab -> NO mismatch, byte-identical passthrough', () => {
  cleanEnv();
  const tok = { id: 'shared', vocab: ['a', 'b', 'c'] };
  const det = detectVocabMismatch(tok, { id: 'shared', vocab: ['a', 'b', 'c'] });
  assert.equal(det.mismatch, false);

  const sel = selectCrossTokenizerTier(tok, { id: 'shared', vocab: ['a', 'b', 'c'] });
  assert.equal(sel.tier, TIERS.SHARED_VOCAB);
  assert.equal(sel.passthrough, true, 'shared vocab MUST be a passthrough (existing soft-label KD unchanged)');
  assert.equal(sel.alignment_method, null);
  assert.deepEqual(sel.papers, [], 'shared-vocab tier adds no cross-tokenizer paper');
});

test('1b. vocab_hash match short-circuits to shared (no list needed)', () => {
  const det = detectVocabMismatch({ vocab_hash: 'deadbeef', vocab_size: 50000 }, { vocab_hash: 'deadbeef', vocab_size: 50000 });
  assert.equal(det.mismatch, false);
  assert.equal(det.reason, 'vocab_hash_match');
});

test('1c. differing hashes but EQUAL lists -> NO mismatch (hash-algo difference)', () => {
  const det = detectVocabMismatch(
    { vocab: ['a', 'b', 'c'], vocab_hash: 'algoA' },
    { vocab: ['a', 'b', 'c'], vocab_hash: 'algoB' });
  assert.equal(det.mismatch, false);
  assert.equal(det.reason, 'vocab_lists_equal');
});

test('2. vocab mismatch auto-detected (different lists, hashes, sizes)', () => {
  const det = detectVocabMismatch({ vocab: TEACHER_VOCAB }, { vocab: STUDENT_VOCAB });
  assert.equal(det.mismatch, true);
  // Both lists auto-derive a hash; differing vocab surfaces as a hash diff
  // (verified against the lists), or as a direct list diff when no hash exists.
  assert.ok(['vocab_hash_differ', 'vocab_lists_differ'].includes(det.reason), det.reason);

  // Hashes that collide but lists differ -> verified element comparison
  // distinguishes a true mismatch from a hash-algo coincidence.
  const detList = detectVocabMismatch(
    { vocab: TEACHER_VOCAB, vocab_hash: 'COLLIDE' },
    { vocab: STUDENT_VOCAB.slice(0, TEACHER_VOCAB.length), vocab_hash: 'OTHER' });
  assert.equal(detList.mismatch, true);
  assert.equal(detList.reason, 'vocab_hash_differ');

  // size-only signal
  const det2 = detectVocabMismatch({ vocab_size: 32000 }, { vocab_size: 50257 });
  assert.equal(det2.mismatch, true);
  assert.equal(det2.reason, 'vocab_size_differ');

  // safe-deny: indeterminate -> mismatch (never silently "shared")
  const det3 = detectVocabMismatch('teacher-opaque', 'student-opaque');
  assert.equal(det3.mismatch, true);
  assert.equal(det3.reason, 'indeterminate_safe_deny');
});

test('3. mismatch + logit access + auto -> ULD tier with OT method + papers stamped', () => {
  cleanEnv();
  const sel = selectCrossTokenizerTier({ vocab: TEACHER_VOCAB }, { vocab: STUDENT_VOCAB }, {
    teacher_logit_access: true,
    logit_alignment: 'auto',
  });
  assert.equal(sel.tier, TIERS.ULD);
  assert.equal(sel.alignment_method, 'optimal_transport_semirelaxed_entropic');
  assert.ok(sel.papers.includes(ULD_PAPER), 'ULD tier must cite the ULD paper');
  assert.ok(sel.papers.includes(SEQUENCE_KD_PAPER), 'logit tiers carry the seq-KD fallback paper');
});

test('3b. mismatch + logit_alignment:mined -> MinED tier with edit-distance method', () => {
  cleanEnv();
  const sel = selectCrossTokenizerTier({ vocab: TEACHER_VOCAB }, { vocab: STUDENT_VOCAB }, {
    teacher_logit_access: true,
    logit_alignment: 'mined',
  });
  assert.equal(sel.tier, TIERS.MINED);
  assert.equal(sel.alignment_method, 'min_edit_distance');
  assert.ok(sel.papers.includes(MINED_PAPER));
});

test('4. graceful downgrade: no teacher logit access -> sequence_kd (Kim & Rush)', () => {
  cleanEnv();
  const sel = selectCrossTokenizerTier({ vocab: TEACHER_VOCAB }, { vocab: STUDENT_VOCAB }, {
    teacher_logit_access: false,
  });
  assert.equal(sel.tier, TIERS.SEQUENCE_KD);
  assert.equal(sel.downgrade_reason, 'no_teacher_logit_access');
  assert.equal(sel.alignment_method, null);
  assert.deepEqual(sel.papers, [SEQUENCE_KD_PAPER]);
});

test('4b. graceful downgrade: logit_alignment off (env or opt) -> sequence_kd', () => {
  cleanEnv();
  const selOpt = selectCrossTokenizerTier({ vocab: TEACHER_VOCAB }, { vocab: STUDENT_VOCAB }, {
    teacher_logit_access: true, logit_alignment: 'off',
  });
  assert.equal(selOpt.tier, TIERS.SEQUENCE_KD);
  assert.equal(selOpt.downgrade_reason, 'logit_alignment_disabled');

  process.env.KOLM_XTOK_FORCE_SEQKD = '1';
  const selEnv = selectCrossTokenizerTier({ vocab: TEACHER_VOCAB }, { vocab: STUDENT_VOCAB });
  assert.equal(selEnv.tier, TIERS.SEQUENCE_KD, 'KOLM_XTOK_FORCE_SEQKD=1 forces the downgrade');
  cleanEnv();
});

test('4c. downgrade: ULD requested but no vocab lists -> sequence_kd with reason', () => {
  cleanEnv();
  const sel = selectCrossTokenizerTier({ vocab_size: 32000 }, { vocab_size: 50000 }, {
    teacher_logit_access: true, logit_alignment: 'uld',
  });
  assert.equal(sel.tier, TIERS.SEQUENCE_KD);
  assert.equal(sel.downgrade_reason, 'uld_requires_vocab_lists');
});

test('5. ULD optimal transport produces a real, normalised student soft target', () => {
  // Teacher distribution: mass on "Ġcat" and "Ġmat".
  const teacherProbs = [0, 0.7, 0, 0, 0.3, 0]; // over TEACHER_VOCAB
  const r = uldAlignDistribution(teacherProbs, TEACHER_VOCAB, STUDENT_VOCAB, { epsilon: 0.03 });
  assert.equal(r.method, 'optimal_transport_semirelaxed_entropic');
  assert.ok(r.target.size > 0, 'OT must place mass on student tokens');
  // Sums to ~1.
  let sum = 0;
  for (const v of r.target.values()) sum += v;
  assert.ok(Math.abs(sum - 1) < 1e-6, `student soft target must normalise to 1 (got ${sum})`);
  const catIdx = STUDENT_VOCAB.indexOf('▁cat');
  const matIdx = STUDENT_VOCAB.indexOf('▁mat');
  const xyzIdx = STUDENT_VOCAB.indexOf('xyz');
  const cat = r.target.get(catIdx) || 0;
  const mat = r.target.get(matIdx) || 0;
  const xyz = r.target.get(xyzIdx) || 0;
  // REAL concentration, not a floating-point tie-break: the transported student
  // target must (a) preserve the teacher's 0.7/0.3 mass ratio onto the surface-
  // equivalent tokens, (b) keep the unrelated token's mass negligible, and (c)
  // be FAR from the degenerate uniform 1/|cands|. (A balanced-Sinkhorn readout
  // pinned to a uniform target marginal would make every entry 1/|cands| and
  // only pass on last-bit rounding - this asserts that regime is gone.)
  assert.ok(cat > 0.6 && cat < 0.8, `surface-equiv ▁cat carries the teacher's ~0.7 (got ${cat})`);
  assert.ok(mat > 0.2 && mat < 0.4, `surface-equiv ▁mat carries the teacher's ~0.3 (got ${mat})`);
  assert.ok(cat > mat, 'teacher mass ratio (0.7 > 0.3) is preserved, not flattened');
  assert.ok(cat > xyz * 100, `unrelated xyz must be negligible vs ▁cat (cat=${cat}, xyz=${xyz})`);
  const uniform = 1 / r.target.size;
  assert.ok(Math.abs(cat - uniform) > 0.3,
    `target must NOT be the degenerate uniform 1/${r.target.size}=${uniform.toFixed(4)} (cat=${cat})`);
});

test('5b. MinED crosswalk maps teacher tokens to min-edit-distance student tokens', () => {
  const map = buildMinedCrosswalk(TEACHER_VOCAB, STUDENT_VOCAB);
  // "Ġcat" (norm " cat" -> "cat") should map to "▁cat" (norm "cat").
  assert.equal(STUDENT_VOCAB[map.get(TEACHER_VOCAB.indexOf('Ġcat'))], '▁cat');
  assert.equal(STUDENT_VOCAB[map.get(TEACHER_VOCAB.indexOf('Ġmat'))], '▁mat');

  const teacherProbs = [0, 0.6, 0, 0, 0.4, 0];
  const r = minedAlignDistribution(teacherProbs, TEACHER_VOCAB, STUDENT_VOCAB);
  let sum = 0; for (const v of r.target.values()) sum += v;
  assert.ok(Math.abs(sum - 1) < 1e-9, 'MinED target normalises to 1');
  const catIdx = STUDENT_VOCAB.indexOf('▁cat');
  assert.ok((r.target.get(catIdx) || 0) > 0.5, 'most mass lands on the aligned ▁cat');
});

test('5c. ground cost / edit distance behave (identical=0, disjoint high)', () => {
  assert.equal(tokenGroundCost('Ġcat', '▁cat'), 0, 'surface-equivalent tokens cost 0');
  assert.ok(tokenGroundCost('cat', 'xyz') > 0.5, 'disjoint tokens cost high');
  assert.equal(editDistance('cat', 'cat'), 0);
  assert.equal(editDistance('cat', 'bat'), 1);
});

test('6. sequence-level KD builds CE rows on teacher text, re-tokenised under student', () => {
  const pairs = [{ id: 'p1', prompt: '2+2=' }, { input: '3+3=' }];
  const teacherDecode = (q) => (q === '2+2=' ? '4' : 'six');
  const studentTokenize = (t) => t.split('').map((c) => c.charCodeAt(0));
  const r = buildSequenceKdRows(pairs, { teacherDecode, studentTokenize, decode_mode: 'greedy' });
  assert.equal(r.method, 'sequence_level_ce');
  assert.equal(r.paper, SEQUENCE_KD_PAPER);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].output, '4', 'target is the teacher decoded TEXT');
  assert.equal(r.rows[0].kd_objective, 'sequence_level_ce');
  assert.deepEqual(r.rows[0].student_tokens, ['4'.charCodeAt(0)], 'text re-tokenised under student');
});

test('6b. sequence-level KD fails LOUD without a teacherDecode (no silent stub)', () => {
  assert.throws(() => buildSequenceKdRows([{ prompt: 'x' }], {}), (e) => {
    assert.equal(e.code, 'sequence_kd_needs_teacher_decode');
    assert.match(e.hint, /teacherDecode/);
    return true;
  });
});

test('7. run-meta stamp records tier + method + unions KD papers without dropping priors', () => {
  cleanEnv();
  const sel = selectCrossTokenizerTier({ vocab: TEACHER_VOCAB }, { vocab: STUDENT_VOCAB }, {
    teacher_logit_access: true, logit_alignment: 'uld',
  });
  const priorPapers = ['arXiv:1503.02531']; // Hinton soft-label KD (caller's existing paper)
  const stamp = stampCrossTokenizerMeta(sel, priorPapers);
  assert.equal(stamp.cross_tokenizer.tier, TIERS.ULD);
  assert.equal(stamp.cross_tokenizer.alignment_method, 'optimal_transport_semirelaxed_entropic');
  assert.equal(stamp.cross_tokenizer.vocab_mismatch, true);
  assert.equal(stamp.cross_tokenizer.version, CROSS_TOKENIZER_VERSION);
  // Union: prior paper preserved, ULD + seq-KD added, no dupes.
  assert.ok(stamp.kd_papers.includes('arXiv:1503.02531'), 'prior KD paper preserved');
  assert.ok(stamp.kd_papers.includes(ULD_PAPER));
  assert.ok(stamp.kd_papers.includes(SEQUENCE_KD_PAPER));
  assert.equal(new Set(stamp.kd_papers).size, stamp.kd_papers.length, 'no duplicate papers');
});

test('7b. shared-vocab stamp does not pollute the caller papers (byte-identical)', () => {
  cleanEnv();
  const sel = selectCrossTokenizerTier({ vocab: ['a', 'b'] }, { vocab: ['a', 'b'] });
  const prior = ['arXiv:1503.02531'];
  const stamp = stampCrossTokenizerMeta(sel, prior);
  assert.equal(stamp.cross_tokenizer.vocab_mismatch, false);
  assert.deepEqual(stamp.kd_papers, ['arXiv:1503.02531'], 'shared vocab adds NO papers');
  // prior array not mutated.
  assert.deepEqual(prior, ['arXiv:1503.02531']);
});

test('8. planCrossTokenizerKd one-call wiring: detect + select + stamp', () => {
  cleanEnv();
  const plan = planCrossTokenizerKd({
    teacher_tokenizer: { id: 'qwen', vocab: TEACHER_VOCAB },
    student_tokenizer: { id: 'llama', vocab: STUDENT_VOCAB },
    prior_papers: ['arXiv:1503.02531'],
    teacher_logit_access: true,
    logit_alignment: 'auto',
  });
  assert.equal(plan.tier, TIERS.ULD);
  assert.equal(plan.cross_tokenizer.tier, TIERS.ULD);
  assert.ok(plan.kd_papers.includes(ULD_PAPER));
  assert.ok(plan.kd_papers.includes('arXiv:1503.02531'));

  // Same call, black-box teacher -> sequence_kd downgrade end to end.
  const planSeq = planCrossTokenizerKd({
    teacher_tokenizer: 'claude-opaque',
    student_tokenizer: { id: 'llama', vocab: STUDENT_VOCAB },
    prior_papers: ['arXiv:1503.02531'],
    teacher_logit_access: false,
  });
  assert.equal(planSeq.tier, TIERS.SEQUENCE_KD);
  assert.deepEqual(planSeq.cross_tokenizer.papers, [SEQUENCE_KD_PAPER]);
});

test('9. papersForTier mapping is stable', () => {
  assert.deepEqual(papersForTier(TIERS.SHARED_VOCAB), []);
  assert.deepEqual(papersForTier(TIERS.ULD), [ULD_PAPER, SEQUENCE_KD_PAPER]);
  assert.deepEqual(papersForTier(TIERS.MINED), [MINED_PAPER, SEQUENCE_KD_PAPER]);
  assert.deepEqual(papersForTier(TIERS.SEQUENCE_KD), [SEQUENCE_KD_PAPER]);
});

test('10. normalizeTokenizer handles HF object vocab + bare string id', () => {
  const norm = normalizeTokenizer({ vocab: { the: 0, cat: 1, sat: 2 } });
  assert.deepEqual(norm.vocab, ['the', 'cat', 'sat'], 'object vocab ordered by id');
  assert.equal(norm.vocabSize, 3);
  assert.ok(norm.vocabHash, 'vocab hash derived when absent');

  const bare = normalizeTokenizer('hf:Qwen/Qwen2.5-7B');
  assert.equal(bare.id, 'hf:Qwen/Qwen2.5-7B');
  assert.equal(bare.vocab, null);
});
