// Finalized C4 -- Speculative-decoding draft-head acceptance / speedup eval
// harness tests (src/spec-decode-eval.js).
//
// Proves the harness measures the three metrics the technique exists to
// optimize -- acceptance_length (tau), per-position acceptance across tree
// depth, and end-to-end tokens/sec speedup -- using the REAL draft-propose +
// target-verify loop over a holdout set, auto-tunes the stamped tree_depth from
// the measured curve, fails closed on holdout overlap, and writes the measured
// numbers into run-meta + the serve spec.
//
// One atomic contract per test. Version constants matched via /^spec-decode-eval-/
// regex (anti-brittleness). No fabricated numbers -- every acceptance value is
// computed from the DI-injected draft/target bridges.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  SPEC_DECODE_EVAL_VERSION,
  TAU_SERVE_FLOOR,
  EVAL_HEAD_KINDS,
  hashPrompt,
  acceptTree,
  perPositionCounts,
  tuneTreeDepth,
  assertHoldoutDisjoint,
  resolveRuntimeBridge,
  evalSpeculativeDecoding,
  buildRunMetaAcceptanceBlock,
  applyAcceptanceToServeSpec,
} from '../src/spec-decode-eval.js';

// --------------------------------------------------------------------------
// Test fixtures: a deterministic draft + target bridge pair.
//
// The "world" is a fixed target continuation per prompt (a token-id path). The
// draft proposes a tree of candidate paths; we control exactly how many tokens
// of the target path each draft path matches so the expected tau / per-position
// curve is hand-computable.
// --------------------------------------------------------------------------

// Build a DI bridge pair whose accepted length for prompt i is `accepts[i]`
// (the draft's best path prefix-matches the target path for `accepts[i]`
// tokens). depth D means the target path is length D and the draft proposes a
// single best path that matches the first `accepts[i]` of it then diverges.
function makeBridges({ accepts, depth, verifyMs = 10, proposeMs = 1, tokPerSecAlone = 50 }) {
  let i = -1;
  const order = [];
  const draft = {
    propose: ({ prompt, depth: d }) => {
      // resolve which fixture index this prompt is
      const idx = order.indexOf(prompt) >= 0 ? order.indexOf(prompt) : (order.push(prompt), order.length - 1);
      const a = accepts[idx % accepts.length];
      // best path: a matching tokens then a divergent token; plus a decoy path
      const matching = [];
      for (let k = 0; k < a; k += 1) matching.push(1000 + k); // matches target ids
      const path = matching.concat([999999]); // diverge at depth a+1
      const decoy = [424242]; // wrong from depth 1
      return { paths: [decoy, path], propose_ms: proposeMs };
    },
  };
  const target = ({ prompt }) => {
    const idx = order.indexOf(prompt) >= 0 ? order.indexOf(prompt) : (order.push(prompt), order.length - 1);
    // target's own continuation: ids 1000..1000+depth-1
    const path = [];
    for (let k = 0; k < depth; k += 1) path.push(1000 + k);
    return { path, verify_ms: verifyMs, tokens_per_sec_alone: tokPerSecAlone };
  };
  return { draft, target };
}

function holdoutOf(n) {
  const h = [];
  for (let i = 0; i < n; i += 1) h.push({ prompt: `holdout-prompt-${i}` });
  return h;
}

// --------------------------------------------------------------------------
// 1. Module surface + versioning.
// --------------------------------------------------------------------------

test('exports the binding surface', () => {
  for (const fn of [hashPrompt, acceptTree, perPositionCounts, tuneTreeDepth,
    assertHoldoutDisjoint, resolveRuntimeBridge, evalSpeculativeDecoding,
    buildRunMetaAcceptanceBlock, applyAcceptanceToServeSpec]) {
    assert.equal(typeof fn, 'function');
  }
  assert.ok(Array.isArray(EVAL_HEAD_KINDS) && EVAL_HEAD_KINDS.includes('eagle3'));
  assert.ok(EVAL_HEAD_KINDS.includes('medusa'));
});

test('version matches the anti-brittleness regex', () => {
  assert.match(SPEC_DECODE_EVAL_VERSION, /^spec-decode-eval-/);
});

// --------------------------------------------------------------------------
// 2. acceptTree -- the tree accept rule.
// --------------------------------------------------------------------------

test('acceptTree returns the longest prefix-matching path length', () => {
  const target = [10, 20, 30, 40];
  const paths = [
    [10, 20, 99],     // matches 2
    [10, 20, 30, 41], // matches 3
    [11],             // matches 0
  ];
  const r = acceptTree(paths, target);
  assert.equal(r.accepted_len, 3);
  assert.equal(r.best_path_index, 1);
});

test('acceptTree is zero when no path matches the first target token', () => {
  const r = acceptTree([[9, 9], [8]], [10, 20]);
  assert.equal(r.accepted_len, 0);
  assert.equal(r.best_path_index, -1);
});

// --------------------------------------------------------------------------
// 3. perPositionCounts -- monotonic non-increasing depth curve.
// --------------------------------------------------------------------------

test('perPositionCounts builds a monotonic non-increasing curve', () => {
  // accepted lengths across 4 steps, depth 3
  const counts = perPositionCounts([3, 2, 1, 0], 3);
  // depth1 committed by steps with len>=1 -> 3 ; depth2 len>=2 -> 2 ; depth3 -> 1
  assert.deepEqual(counts, [3, 2, 1]);
  for (let d = 1; d < counts.length; d += 1) assert.ok(counts[d] <= counts[d - 1]);
});

// --------------------------------------------------------------------------
// 4. tuneTreeDepth -- trim the tree where it stops paying.
// --------------------------------------------------------------------------

test('tuneTreeDepth trims depth where marginal acceptance falls below floor', () => {
  // rates per depth: 0.9, 0.5, 0.05, 0.0 ; floor 0.10 -> keep depth 2
  const tuned = tuneTreeDepth([0.9, 0.5, 0.05, 0.0], 4, 0.10);
  assert.equal(tuned, 2);
});

test('tuneTreeDepth never widens past the stamped depth', () => {
  const tuned = tuneTreeDepth([0.9, 0.9, 0.9, 0.9, 0.9], 3, 0.10);
  assert.equal(tuned, 3);
});

// --------------------------------------------------------------------------
// 5. Holdout disjointness -- moat fail-closed.
// --------------------------------------------------------------------------

test('assertHoldoutDisjoint fails closed when no training hashes are given', () => {
  const r = assertHoldoutDisjoint({ evalHashes: ['a', 'b'], trainHashes: null });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'holdout_unverifiable');
});

test('assertHoldoutDisjoint rejects any overlap with the training set', () => {
  const r = assertHoldoutDisjoint({ evalHashes: ['a', 'b', 'c'], trainHashes: ['x', 'b'] });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'holdout_overlap');
  assert.equal(r.overlap, 1);
});

test('assertHoldoutDisjoint passes on a disjoint set', () => {
  const r = assertHoldoutDisjoint({ evalHashes: ['a', 'b'], trainHashes: ['x', 'y'] });
  assert.equal(r.ok, true);
  assert.equal(r.overlap, 0);
});

test('eval refuses a holdout that overlaps the training prompts', async () => {
  const salt = 'fixed-salt';
  const holdout = holdoutOf(3);
  // training set deliberately includes one of the eval prompts
  const trainHashes = [hashPrompt('holdout-prompt-1', salt), hashPrompt('other', salt)];
  const { draft, target } = makeBridges({ accepts: [3, 3, 3], depth: 4 });
  const res = await evalSpeculativeDecoding({
    holdout, head_kind: 'eagle3', tree_depth: 4, draft, target, trainHashes, salt,
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'holdout_overlap');
});

// --------------------------------------------------------------------------
// 6. Caveat envelopes (loud, no fabricated numbers).
// --------------------------------------------------------------------------

test('eval refuses an empty holdout', async () => {
  const res = await evalSpeculativeDecoding({ holdout: [], head_kind: 'eagle3', tree_depth: 4 });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'empty_holdout');
});

test('eval refuses a missing tree_depth', async () => {
  const res = await evalSpeculativeDecoding({ holdout: holdoutOf(2), head_kind: 'eagle3' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'missing_tree_depth');
});

test('eval refuses an unknown head kind', async () => {
  const res = await evalSpeculativeDecoding({ holdout: holdoutOf(2), head_kind: 'nope', tree_depth: 3 });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'unknown_head_kind');
});

test('resolveRuntimeBridge returns no_runtime_configured with an install hint when unset', () => {
  const r = resolveRuntimeBridge({}); // no KOLM_SPECEVAL_RUNTIME
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_runtime_configured');
  assert.match(r.hint, /KOLM_SPECEVAL_RUNTIME/);
});

test('eval with no DI bridges and no runtime env fails loud (no fabricated tau)', async () => {
  const res = await evalSpeculativeDecoding({
    holdout: holdoutOf(2), head_kind: 'eagle3', tree_depth: 4,
    skip_holdout_check: true, env: {},
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'no_runtime_configured');
  assert.equal(res.acceptance_length, undefined);
});

// --------------------------------------------------------------------------
// 7. End-to-end DI eval -- tau, per-position curve, speedup all REAL.
// --------------------------------------------------------------------------

test('end-to-end eval computes tau, per-position curve, and speedup from the loop', async () => {
  const salt = 'e2e-salt';
  const depth = 4;
  // accepted lengths across 4 holdout steps: 4, 3, 1, 0
  const accepts = [4, 3, 1, 0];
  const holdout = holdoutOf(4);
  const trainHashes = [hashPrompt('disjoint-train-a', salt), hashPrompt('disjoint-train-b', salt)];
  const { draft, target } = makeBridges({ accepts, depth, verifyMs: 10, proposeMs: 1, tokPerSecAlone: 50 });

  const res = await evalSpeculativeDecoding({
    holdout, head_kind: 'eagle3', tree_depth: depth, draft, target, trainHashes, salt,
  });
  assert.equal(res.ok, true);
  assert.equal(res.steps, 4);

  // tau = mean (accepted_len + 1) = ((4+1)+(3+1)+(1+1)+(0+1))/4 = (5+4+2+1)/4 = 3.0
  assert.equal(res.acceptance_length, 3.0);

  // per-position acceptance over depth 4:
  //   depth1: len>=1 -> steps {4,3,1} = 3/4 = 0.75
  //   depth2: len>=2 -> {4,3}        = 2/4 = 0.50
  //   depth3: len>=3 -> {4,3}        = 2/4 = 0.50
  //   depth4: len>=4 -> {4}          = 1/4 = 0.25
  assert.deepEqual(res.per_position_acceptance, [0.75, 0.5, 0.5, 0.25]);

  // measured speedup: drafted commits 5+4+2+1=12 tokens over (verify 40ms +
  // propose 4ms)=44ms -> 12/0.044 = 272.7 tok/s ; target alone = 50 tok/s ->
  // speedup ~ 5.45x. Just assert it is a real >1 number with measured basis.
  assert.equal(res.speedup_basis, 'measured_wallclock');
  assert.ok(res.speedup_x > 1, `expected speedup>1, got ${res.speedup_x}`);
  assert.ok(Number.isFinite(res.drafted_tok_per_sec));
  assert.equal(res.target_alone_tok_per_sec, 50);
});

test('eval falls back to the cost-model speedup when no target-alone tok/s is reported', async () => {
  const salt = 'cm-salt';
  const depth = 4;
  const holdout = holdoutOf(3);
  const trainHashes = [hashPrompt('t1', salt)];
  // tokPerSecAlone <=0 disables the measured path
  const { draft, target } = makeBridges({ accepts: [4, 4, 4], depth, verifyMs: 10, proposeMs: 1, tokPerSecAlone: 0 });
  const res = await evalSpeculativeDecoding({
    holdout, head_kind: 'eagle3', tree_depth: depth, draft, target, trainHashes, salt,
  });
  assert.equal(res.ok, true);
  assert.equal(res.speedup_basis, 'cost_model_tau_over_propose_ratio');
  // tau=5 (all 4 accepted +1), propose_cost_ratio = 3/30 = 0.1 -> 5/1.1 ~ 4.545
  assert.equal(res.acceptance_length, 5.0);
  assert.ok(res.speedup_x > 4 && res.speedup_x < 5);
});

// --------------------------------------------------------------------------
// 8. Auto-tuning the stamped tree depth from the measured curve.
// --------------------------------------------------------------------------

test('eval auto-tunes tree_depth down when deep positions rarely land', async () => {
  const salt = 'tune-salt';
  const depth = 6; // stamped deep
  // all steps accept exactly 2 tokens -> depths 3..6 never land
  const accepts = [2, 2, 2, 2, 2];
  const holdout = holdoutOf(5);
  const trainHashes = [hashPrompt('z', salt)];
  const { draft, target } = makeBridges({ accepts, depth });
  const res = await evalSpeculativeDecoding({
    holdout, head_kind: 'eagle3', tree_depth: depth, draft, target, trainHashes, salt, marginal_floor: 0.10,
  });
  assert.equal(res.ok, true);
  assert.equal(res.stamped_tree_depth, 6);
  // depths 1,2 land 100%; depth3 lands 0% -> tuned to 2
  assert.equal(res.tuned_tree_depth, 2);
  assert.equal(res.tree_depth_changed, true);
});

// --------------------------------------------------------------------------
// 9. Serve recommendation gate (tau below floor => not served).
// --------------------------------------------------------------------------

test('eval marks serve_recommended false when tau is below the serve floor', async () => {
  const salt = 'floor-salt';
  const depth = 4;
  // every step accepts 0 -> tau = 1.0 (just the bonus token) < TAU_SERVE_FLOOR
  const { draft, target } = makeBridges({ accepts: [0, 0, 0], depth });
  const res = await evalSpeculativeDecoding({
    holdout: holdoutOf(3), head_kind: 'medusa', tree_depth: depth, draft, target,
    trainHashes: [hashPrompt('q', salt)], salt,
  });
  assert.equal(res.ok, true);
  assert.equal(res.acceptance_length, 1.0);
  assert.ok(res.acceptance_length < TAU_SERVE_FLOOR);
  assert.equal(res.serve_recommended, false);
});

// --------------------------------------------------------------------------
// 10. run-meta + serve-spec writers.
// --------------------------------------------------------------------------

test('buildRunMetaAcceptanceBlock carries the headline metrics + holdout proof', async () => {
  const salt = 'meta-salt';
  const { draft, target } = makeBridges({ accepts: [3, 3, 3, 3], depth: 4 });
  const res = await evalSpeculativeDecoding({
    holdout: holdoutOf(4), head_kind: 'eagle3', tree_depth: 4, draft, target,
    trainHashes: [hashPrompt('m', salt)], salt,
  });
  assert.equal(res.ok, true);
  const block = buildRunMetaAcceptanceBlock(res);
  assert.equal(block.method, 'speculative_decoding_eval');
  assert.match(block.version, /^spec-decode-eval-/);
  assert.equal(block.acceptance_length, res.acceptance_length);
  assert.equal(block.speedup_x, res.speedup_x);
  assert.ok(Array.isArray(block.per_position_acceptance));
  assert.equal(block.status, 'tested');
  assert.ok(block.holdout && block.holdout.eval_set_hash);
  // privacy: no raw prompts leak into the block
  assert.equal(JSON.stringify(block).includes('holdout-prompt-'), false);
});

test('buildRunMetaAcceptanceBlock rejects a failed eval result', () => {
  assert.throws(() => buildRunMetaAcceptanceBlock({ ok: false }), /successful/);
});

test('applyAcceptanceToServeSpec fills null fields and tunes the tree, without mutating input', async () => {
  const salt = 'serve-salt';
  // compile-time block shape from spec-compile.js (acceptance/throughput null)
  const compileBlock = {
    method: 'speculative_decoding',
    head_kind: 'eagle3',
    num_speculative_tokens: 6,
    num_steps: 6,
    eagle_topk: 8,
    acceptance_rate: null,
    throughput_speedup: null,
    resolved_at: 'compile',
  };
  const frozenCopy = JSON.parse(JSON.stringify(compileBlock));
  // stamped depth 6 but only 2 tokens ever land -> tune to 2
  const { draft, target } = makeBridges({ accepts: [2, 2, 2], depth: 6 });
  const res = await evalSpeculativeDecoding({
    holdout: holdoutOf(3), head_kind: 'eagle3', tree_depth: 6, draft, target,
    trainHashes: [hashPrompt('s', salt)], salt,
  });
  assert.equal(res.ok, true);

  const served = applyAcceptanceToServeSpec(compileBlock, res);
  // filled measured fields
  assert.equal(typeof served.acceptance_rate, 'number');
  assert.equal(served.acceptance_length, res.acceptance_length);
  assert.equal(served.throughput_speedup, res.speedup_x);
  assert.equal(served.resolved_at, 'eval');
  // auto-tuned knobs narrowed to the effective depth
  assert.equal(served.tree_depth, res.tuned_tree_depth);
  assert.equal(served.num_speculative_tokens, res.tuned_tree_depth);
  assert.equal(served.num_steps, res.tuned_tree_depth);
  // input untouched
  assert.deepEqual(compileBlock, frozenCopy);
});

test('applyAcceptanceToServeSpec stamps a disable_reason when the head should not be served', async () => {
  const salt = 'disable-salt';
  const { draft, target } = makeBridges({ accepts: [0, 0], depth: 3 });
  const res = await evalSpeculativeDecoding({
    holdout: holdoutOf(2), head_kind: 'eagle3', tree_depth: 3, draft, target,
    trainHashes: [hashPrompt('d', salt)], salt,
  });
  assert.equal(res.ok, true);
  assert.equal(res.serve_recommended, false);
  const served = applyAcceptanceToServeSpec({ method: 'speculative_decoding' }, res);
  assert.equal(served.serve_recommended, false);
  assert.match(served.disable_reason, /below serve floor/);
});

// --------------------------------------------------------------------------
// 11. Privacy: prompt hashing is salted + stable within a run.
// --------------------------------------------------------------------------

test('hashPrompt is salted (different salt => different digest) and stable within a salt', () => {
  const a = hashPrompt('sensitive customer prompt', 'salt-A');
  const b = hashPrompt('sensitive customer prompt', 'salt-B');
  const c = hashPrompt('sensitive customer prompt', 'salt-A');
  assert.notEqual(a, b);
  assert.equal(a, c);
  // digest does not contain the raw prompt
  assert.equal(a.includes('sensitive'), false);
  assert.match(a, /^[0-9a-f]{64}$/);
});

// --------------------------------------------------------------------------
// 12. External runtime bridge resolves from an env JSON array (real spawn path).
// --------------------------------------------------------------------------

test('resolveRuntimeBridge resolves a JSON-array env to node + script argv', () => {
  // process.execPath is a real file -> _whichSync resolves it.
  const env = { KOLM_SPECEVAL_RUNTIME: JSON.stringify([process.execPath, '/abs/bridge.js']) };
  const r = resolveRuntimeBridge(env);
  assert.equal(r.ok, true);
  assert.equal(r.source, 'env-array');
  assert.equal(r.argv[0], process.execPath);
  assert.equal(r.argv[1], '/abs/bridge.js');
});
