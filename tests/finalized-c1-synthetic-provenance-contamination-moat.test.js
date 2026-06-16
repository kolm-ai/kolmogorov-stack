// tests/finalized-c1-synthetic-provenance-contamination-moat.test.js
//
// Acceptance battery for src/eval-decontam.js - synthetic provenance tagging,
// dedup-against-eval, and contamination-proof K-score attestation. Pure
// node:test, no external deps. Every criterion in the build spec is proven.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EVAL_DECONTAM_SPEC_VERSION,
  normalizeProvenance,
  partitionBySource,
  syntheticShare,
  buildEvalIndex,
  runMembershipCascade,
  resolveTier3,
  buildSyntheticRoot,
  buildEvalUniverseRoot,
  contaminationPredicate,
  applyContaminationGate,
  buildEvalDecontamBlock,
  validateEvalDecontamBlock,
  runEvalDecontamStage,
} from '../src/eval-decontam.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.resolve(__dirname, '..', 'src', 'eval-decontam.js');

// 13+ token spans for n-gram tests (token = whitespace-split word). The output
// opens with a >=13-token contiguous run that the synthetic hit row reuses
// verbatim: "the determinant equals forty two after expanding along the first
// row of the matrix" is 16 tokens.
const EVAL_LONG = {
  input: 'compute the determinant of the following three by three integer matrix carefully',
  output: 'the determinant equals forty two after expanding along the first row of the matrix exactly',
};
// a synthetic row containing a verbatim 13-token contiguous span from
// EVAL_LONG.output: it reuses the first 14 output tokens then diverges.
const SYNTH_13GRAM_HIT = {
  input: 'unrelated preface text here that shares nothing with the eval input prompt whatsoever',
  output: 'the determinant equals forty two after expanding along the first row of the matrix differently now',
  source_type: 'synthetic',
};

function evalIndexFromRows(rows, extra = {}) {
  // Inject eval rows directly via seedHoldoutRows (no disk needed).
  return buildEvalIndex({ seedHoldoutRows: rows, ...extra });
}

test('A: normalizeProvenance folds both stamp dialects to source_type=synthetic; real defaults', () => {
  const stamped = {
    input: 'q', output: 'a', source_type: 'synthetic',
    teacher_model: 'openai/gpt-4o', mode: 'paraphrase', generation_prompt_hash: 'abc123',
  };
  const augmented = {
    input: 'q', output: 'a', kolm_synthetic: true,
    parent_seed_cids: ['cid1', 'cid2'], version: 'synth-v1',
  };
  const real = { input: 'q', output: 'a' };

  const p1 = normalizeProvenance(stamped);
  const p2 = normalizeProvenance(augmented);
  const p3 = normalizeProvenance(real);

  assert.equal(p1.source_type, 'synthetic');
  assert.equal(p2.source_type, 'synthetic');
  assert.equal(p3.source_type, 'real');
  assert.equal(p1.teacher_model, 'openai/gpt-4o');
  assert.equal(p1.mode, 'paraphrase');
  assert.deepEqual(p2.parent_seed_cids, ['cid1', 'cid2']);
  // never throws on malformed
  assert.doesNotThrow(() => normalizeProvenance(null));
  assert.doesNotThrow(() => normalizeProvenance(42));
  assert.equal(normalizeProvenance(undefined).source_type, 'real');
});

test('A: partitionBySource counts + syntheticShare = round4(M/(N+M))', () => {
  const N = 3, M = 2;
  const rows = [
    { input: 'r1', output: 'o' },
    { input: 'r2', output: 'o' },
    { input: 'r3', output: 'o' },
    { input: 's1', output: 'o', source_type: 'synthetic' },
    { input: 's2', output: 'o', kolm_synthetic: true },
  ];
  const { real, synthetic } = partitionBySource(rows);
  assert.equal(real.length, N);
  assert.equal(synthetic.length, M);
  assert.equal(syntheticShare(rows), Number((M / (N + M)).toFixed(4)));
});

test('B tier1: verbatim 13-token span is flagged; only a 12-token span is NOT (n=13 boundary)', () => {
  const idx = evalIndexFromRows([EVAL_LONG]);

  // exact 13-gram hit
  const r1 = runMembershipCascade({ syntheticRows: [SYNTH_13GRAM_HIT], evalIndex: idx });
  assert.equal(r1.flagged.length, 1);
  assert.equal(r1.flagged[0].tier, 1);
  assert.equal(r1.per_tier_counts.tier1, 1);

  // Build a synthetic row that shares EXACTLY a 12-token contiguous span and no
  // 13-token span with any eval row. Take 12 tokens from the eval output, then
  // diverge so no 13-gram overlaps.
  const evalOutToks = (EVAL_LONG.output).split(' ');
  const span12 = evalOutToks.slice(0, 12).join(' '); // 12 tokens
  const synth12 = {
    // place the 12-token span surrounded by tokens that break any 13-gram:
    // prefix breaks left side, suffix breaks right side.
    input: 'zzz totally different prompt with no shared thirteen token window at all here ok',
    output: 'qqq ' + span12 + ' wwwww', // 12-token eval span, but 13-grams differ at both edges
    source_type: 'synthetic',
  };
  const r2 = runMembershipCascade({ syntheticRows: [synth12], evalIndex: idx });
  assert.equal(r2.per_tier_counts.tier1, 0, '12-token span must NOT trip the 13-gram tier');
});

test('B tier1 exact: byte-identical (post-normalize) synthetic row is flagged', () => {
  const idx = evalIndexFromRows([EVAL_LONG]);
  const exact = {
    // same content, different whitespace/case -> normalizes identical
    input: '  COMPUTE the   Determinant of the following Three by Three integer Matrix carefully ',
    output: 'THE determinant   equals forty two after expanding along the first row of the matrix',
    source_type: 'synthetic',
  };
  const r = runMembershipCascade({ syntheticRows: [exact], evalIndex: idx });
  assert.equal(r.flagged.length, 1);
  assert.equal(r.flagged[0].tier, 1);
});

test('B tier2: light paraphrase (jaccard>=thr, no shared 13-gram) is flagged at tier2 NOT tier1', () => {
  // Long eval row (40 distinct tokens, no internal repeats) so MinHash has
  // signal. The paraphrase replaces one token every 13 positions: that breaks
  // EVERY 13-token contiguous window (each 13-window straddles exactly one
  // edit) so tier1 misses, while ~half the 5-shingles survive so the MinHash
  // Jaccard stays well above the recorded threshold and tier2 catches it.
  const words = ('the agile fox leaps above a drowsy hound beside the calm flowing river while ' +
    'distant church bells toll across the quiet valley and farmers gather ripe golden wheat ' +
    'under a warm autumn sky each tranquil evening').split(' ');
  const evalRow = { input: words.slice(0, 20).join(' '), output: words.slice(20).join(' ') };
  const idx = buildEvalIndex({ seedHoldoutRows: [evalRow], opts: { lshThreshold: 0.45 } });

  const pt = words.slice();
  for (let i = 12; i < pt.length; i += 13) pt[i] = 'X' + i; // edit every 13th token
  const para = {
    input: pt.slice(0, 20).join(' '),
    output: pt.slice(20).join(' '),
    source_type: 'synthetic',
  };
  const r = runMembershipCascade({ syntheticRows: [para], evalIndex: idx, opts: {} });
  assert.equal(r.flagged.length, 1, 'paraphrase should be caught');
  assert.equal(r.flagged[0].tier, 2, 'must be tier2 (minhash), not tier1');
  assert.equal(r.per_tier_counts.tier1, 0);
  assert.equal(r.per_tier_counts.tier2, 1);
});

test('B: a clean synthetic row passes all enabled tiers', () => {
  const idx = evalIndexFromRows([EVAL_LONG]);
  const clean = {
    input: 'please summarize the quarterly revenue report for the northeast sales region',
    output: 'northeast revenue rose nine percent driven by enterprise renewals and two new logos',
    source_type: 'synthetic',
  };
  const r = runMembershipCascade({ syntheticRows: [clean], evalIndex: idx });
  assert.equal(r.flagged.length, 0);
  assert.equal(r.passed.length, 1);
  assert.equal(r.passed[0], clean);
});

test('B fail-closed: a tier that throws internally drops the row, records error, no throw', () => {
  const idx = evalIndexFromRows([EVAL_LONG]);
  // Craft a row that throws inside canonicalRowText by giving a getter that
  // throws when accessed.
  const boom = { source_type: 'synthetic' };
  Object.defineProperty(boom, 'input', { get() { throw new Error('boom-row'); }, enumerable: true });

  let r;
  assert.doesNotThrow(() => { r = runMembershipCascade({ syntheticRows: [boom], evalIndex: idx }); });
  assert.equal(r.flagged.length, 1);
  assert.equal(r.flagged[0].error, true);
  assert.equal(r.passed.length, 0);
  assert.ok(r.errors.length >= 1);
  assert.match(r.errors[0].message, /boom-row/);
});

test('B tier3 gating: unset env -> skipped, lexical_only, non-empty hint; cascade still runs 1-2', () => {
  const idx = evalIndexFromRows([EVAL_LONG]);
  const r = runMembershipCascade({
    syntheticRows: [SYNTH_13GRAM_HIT, { input: 'clean unique', output: 'nothing matches here', source_type: 'synthetic' }],
    evalIndex: idx,
    opts: { env: {} }, // KOLM_DECONTAM_EMBED unset
  });
  assert.equal(r.tier3_status, 'skipped');
  assert.equal(r.contamination_coverage, 'lexical_only');
  assert.ok(typeof r.tier3_install_hint === 'string' && r.tier3_install_hint.length > 0);
  // tiers 1-2 still ran: the 13-gram hit was flagged
  assert.equal(r.per_tier_counts.tier1, 1);
  assert.equal(r.passed.length, 1);
});

test('B tier3 privacy refusal: KOLM_DECONTAM_EMBED=1 + hyperscaler + tenant rows -> REFUSE, no external call', () => {
  // tenant rows present in the universe
  const idx = buildEvalIndex({
    seedHoldoutRows: [EVAL_LONG],
    tenantCorpus: { rows: [{ input: 'secret tenant phi record', output: 'protected diagnosis code' }] },
  });
  assert.equal(idx.tenant_present, true);

  let externalCalls = 0;
  const hyperscalerEmbedder = {
    provider: 'openai',
    embedHit() { externalCalls += 1; return true; }, // would exfiltrate if called
  };

  const r = runMembershipCascade({
    syntheticRows: [{ input: 'q', output: 'a', source_type: 'synthetic' }],
    evalIndex: idx,
    opts: { env: { KOLM_DECONTAM_EMBED: '1' }, embedder: hyperscalerEmbedder },
  });
  assert.equal(r.refused, true);
  assert.equal(r.tier3_status, 'refused_privacy');
  assert.equal(externalCalls, 0, 'no tenant/eval content may reach the hyperscaler');
  assert.match(r.refusal_reason, /hyperscaler/);

  // And the predicate fails closed on refusal.
  const pred = contaminationPredicate(r);
  assert.equal(pred.contaminated, true);
});

test('B tier3 local embedder runs the real path (no refusal) and can flag a semantic paraphrase', () => {
  const idx = evalIndexFromRows([EVAL_LONG]); // no tenant rows
  let calls = 0;
  const localEmbedder = {
    provider: 'ollama',
    embedHit(text) { calls += 1; return /determinant/.test(text); },
  };
  const semantic = { input: 'find the matrix determinant', output: 'value is forty-two', source_type: 'synthetic' };
  const r = runMembershipCascade({
    syntheticRows: [semantic],
    evalIndex: idx,
    opts: { env: { KOLM_DECONTAM_EMBED: '1' }, embedder: localEmbedder },
  });
  assert.equal(r.tier3_status, 'enabled');
  assert.equal(r.refused, false);
  assert.equal(r.per_tier_counts.tier3, 1);
  assert.ok(calls >= 1);
  assert.equal(r.contamination_coverage, 'lexical_and_semantic');
});

test('C dual merkle: synthetic_root inclusion proof round-trips ok and breaks on tamper', () => {
  const passed = [
    { input: 'a1', output: 'b1', source_type: 'synthetic' },
    { input: 'a2', output: 'b2', source_type: 'synthetic' },
    { input: 'a3', output: 'b3', source_type: 'synthetic' },
  ];
  const { tree } = buildSyntheticRoot(passed);
  for (let i = 0; i < passed.length; i++) {
    const proof = tree.proof(i);
    assert.equal(tree.verifyProof(proof).ok, true, `proof ${i} must verify`);
  }
  // Tamper: build a tree over a mutated row; its leaf differs so the original
  // proof's leafHash no longer matches the recomputed root.
  const mutated = passed.slice();
  mutated[1] = { input: 'a2', output: 'TAMPERED', source_type: 'synthetic' };
  const { tree: tree2 } = buildSyntheticRoot(mutated);
  // The original proof for index 1 against the new root must fail.
  const origProof = tree.proof(1);
  const crossProof = { ...origProof, root: tree2.root };
  assert.equal(tree2.verifyProof(crossProof).ok, false, 'tampered row breaks inclusion proof');
});

test('C eval_universe_root commits to hashes only: leaves contain no tenant plaintext', () => {
  const tenantPlain = 'super-secret-tenant-phi-string-xyz';
  const idx = buildEvalIndex({
    seedHoldoutRows: [{ input: 'public eval q', output: 'public eval a' }],
    tenantCorpus: { rows: [{ input: tenantPlain, output: 'protected-diagnosis' }] },
  });
  const { leaves } = buildEvalUniverseRoot(idx);
  // every leaf must be a hex64 commitment, never plaintext
  for (const leaf of leaves) {
    assert.match(leaf, /^[0-9a-f]{64}$/, 'eval universe leaves must be hex64 commitments');
  }
  const joined = leaves.join('|');
  assert.ok(!joined.includes(tenantPlain), 'tenant plaintext must not appear in eval universe leaves');
  assert.ok(!joined.includes('protected-diagnosis'));
  assert.ok(!joined.includes('public eval q'));
});

test('D: contaminationPredicate honors max_allowed_rate (default 0.0) and records it', () => {
  // residual 0 -> not contaminated
  const clean = contaminationPredicate({ refused: false }, { residualRate: 0 });
  assert.equal(clean.contaminated, false);
  assert.equal(clean.max_allowed_rate, 0);

  // residual > 0 with zero tolerance -> contaminated
  const dirty = contaminationPredicate({ refused: false }, { residualRate: 0.01 });
  assert.equal(dirty.contaminated, true);
  assert.equal(dirty.contamination_rate, 0.01);

  // raise tolerance -> not contaminated
  const tolerated = contaminationPredicate({ refused: false }, { residualRate: 0.01, maxAllowedRate: 0.05 });
  assert.equal(tolerated.contaminated, false);
  assert.equal(tolerated.max_allowed_rate, 0.05);
});

test('D ship-gate: contaminated downgrades ships->false, NEVER flips false->true, allow_below_gate stamps', () => {
  const pred = { contaminated: true, reason: 'r' };

  // stricter-only downgrade
  const ks1 = applyContaminationGate({ ships: true, k_score: 0.9 }, pred);
  assert.equal(ks1.ships, false);
  assert.ok(ks1.contamination_block_reason);

  // never flip a false to true: a ships=false stays false even when clean
  const ks2 = applyContaminationGate({ ships: false }, { contaminated: false });
  assert.equal(ks2.ships, false);

  // clean predicate never relaxes an existing gate
  const ks3 = applyContaminationGate({ ships: true }, { contaminated: false });
  assert.equal(ks3.ships, true);

  // allow_below_gate preserves the stamp path; does NOT force ships true
  const ks4 = applyContaminationGate({ ships: false }, pred, { allow_below_gate: true });
  assert.equal(ks4.ships, false);
  assert.equal(ks4.allow_below_gate, true);
  assert.ok(ks4.contamination_block_reason);
});

test('E: buildEvalDecontamBlock emits spec/roots/share/ngram=13/hash and validate returns it', () => {
  const idx = evalIndexFromRows([EVAL_LONG]);
  const synth = [{ input: 'a1', output: 'b1', source_type: 'synthetic' }];
  const cascade = runMembershipCascade({ syntheticRows: synth, evalIndex: idx });
  const { rootHex: sroot } = buildSyntheticRoot(cascade.passed);
  const { rootHex: eroot } = buildEvalUniverseRoot(idx);
  const predicate = contaminationPredicate(cascade);
  const block = buildEvalDecontamBlock({
    provenance_summary: { synthetic_share: 0.5, synthetic_count: 1, real_count: 1 },
    cascadeResult: cascade,
    synthetic_root: sroot,
    eval_universe_root: eroot,
    predicate,
    generated_at: '2026-06-16T00:00:00.000Z',
  });
  assert.equal(block.spec, EVAL_DECONTAM_SPEC_VERSION);
  assert.match(block.synthetic_root, /^[0-9a-f]{64}$/);
  assert.match(block.eval_universe_root, /^[0-9a-f]{64}$/);
  assert.equal(block.operating_point.ngram, 13);
  assert.match(block.hash, /^[0-9a-f]{64}$/);
  assert.equal(typeof block.synthetic_share, 'number');
  assert.deepEqual(validateEvalDecontamBlock(block), block);
});

test('E tamper-evidence: mutating any field breaks validateEvalDecontamBlock', () => {
  const idx = evalIndexFromRows([EVAL_LONG]);
  const cascade = runMembershipCascade({ syntheticRows: [{ input: 'a', output: 'b', source_type: 'synthetic' }], evalIndex: idx });
  const block = buildEvalDecontamBlock({
    provenance_summary: { synthetic_share: 1, synthetic_count: 1, real_count: 0 },
    cascadeResult: cascade,
    synthetic_root: buildSyntheticRoot(cascade.passed).rootHex,
    eval_universe_root: buildEvalUniverseRoot(idx).rootHex,
    predicate: contaminationPredicate(cascade),
    generated_at: '2026-06-16T00:00:00.000Z',
  });

  const t1 = { ...block, contamination_count: block.contamination_count + 1 };
  assert.throws(() => validateEvalDecontamBlock(t1), /hash drift/);
  const t2 = { ...block, synthetic_share: 0.123 };
  assert.throws(() => validateEvalDecontamBlock(t2), /hash drift/);
  const t3 = { ...block, synthetic_root: 'f'.repeat(64) };
  assert.throws(() => validateEvalDecontamBlock(t3), /hash drift/);
});

test('Determinism: cascade + block are byte-identical across two runs', () => {
  const synth = [
    { input: 'one two three', output: 'four five six', source_type: 'synthetic' },
    SYNTH_13GRAM_HIT,
  ];
  const make = () => {
    const idx = evalIndexFromRows([EVAL_LONG]);
    const cascade = runMembershipCascade({ syntheticRows: synth, evalIndex: idx });
    const block = buildEvalDecontamBlock({
      provenance_summary: { synthetic_share: 1, synthetic_count: 2, real_count: 0 },
      cascadeResult: cascade,
      synthetic_root: buildSyntheticRoot(cascade.passed).rootHex,
      eval_universe_root: buildEvalUniverseRoot(idx).rootHex,
      predicate: contaminationPredicate(cascade),
      generated_at: '2026-06-16T00:00:00.000Z',
    });
    return block;
  };
  const a = make();
  const b = make();
  assert.equal(a.hash, b.hash);
  assert.equal(a.synthetic_root, b.synthetic_root);
  assert.equal(a.eval_universe_root, b.eval_universe_root);
  assert.deepEqual(a, b);
});

test('Zero new deps + ASCII-only + no banned word + does NOT import data-curate.js', () => {
  const src = fs.readFileSync(MODULE_PATH, 'utf8');
  // ASCII only
  for (let i = 0; i < src.length; i++) {
    assert.ok(src.charCodeAt(i) <= 0x7f, `non-ASCII char at offset ${i}`);
  }
  // banned word (constructed at runtime so this test file itself stays clean)
  const banned = new RegExp(['ho', 'nest'].join(''), 'i');
  assert.ok(!banned.test(src), 'module must not contain the banned word');
  // imports: only node:crypto + existing src/* (no third-party packages)
  const importLines = src.split('\n').filter(l => /^\s*import\s/.test(l));
  for (const line of importLines) {
    const m = line.match(/from\s+['"]([^'"]+)['"]/);
    if (!m) continue;
    const spec = m[1];
    const ok = spec === 'node:crypto' || spec.startsWith('./');
    assert.ok(ok, `unexpected import '${spec}' - only node:crypto and ./src allowed`);
  }
  // disjointness invariant: never IMPORTS data-curate (structural holdout
  // boundary). Check the actual import statements, not prose in comments.
  for (const line of importLines) {
    assert.ok(!/data-curate/.test(line), 'eval-decontam must NOT import data-curate.js (structural holdout boundary)');
  }
});

test('Driver: runEvalDecontamStage composes the whole stage end-to-end', () => {
  const rows = [
    { input: 'real q1', output: 'real a1' },
    { input: 'real q2', output: 'real a2' },
    SYNTH_13GRAM_HIT, // contaminated (tier1)
    { input: 'clean synth q', output: 'clean synth a unique tokens here', source_type: 'synthetic' },
  ];
  const out = runEvalDecontamStage({
    rows,
    evalIndexArgs: { seedHoldoutRows: [EVAL_LONG] },
    k_score: { ships: true },
  });
  assert.equal(out.real.length, 2);
  assert.equal(out.synthetic.length, 2);
  assert.equal(out.passed_synthetic.length, 1, 'one synthetic contaminated, one passes');
  assert.equal(out.cascade.contamination_count, 1);
  // block validates
  assert.deepEqual(validateEvalDecontamBlock(out.block), out.block);
  // shipped synthetic root proof verifies
  assert.equal(out.synthetic_tree.verifyProof(out.synthetic_tree.proof(0)).ok, true);
  // k_score preserved (no residual contamination over the shipped set)
  assert.equal(out.k_score.ships, true);
});

test('resolveTier3: enabled with local provider but no embedder -> skipped_no_embedder (loud)', () => {
  const idx = evalIndexFromRows([EVAL_LONG]);
  const r = resolveTier3({ evalIndex: idx, opts: { env: { KOLM_DECONTAM_EMBED: '1', KOLM_LLM_PROVIDER: 'ollama' } } });
  assert.equal(r.enabled, false);
  assert.equal(r.status, 'skipped_no_embedder');
  assert.ok(r.install_hint && r.install_hint.length > 0);
});
