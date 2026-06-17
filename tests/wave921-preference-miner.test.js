// W921 — preference pair mining + local candidate scorer (additive exports on
// src/distill-preference.js). Verifies the W480 exports stay intact.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pref from '../src/distill-preference.js';
import {
  OBJECTIVES, doctor, tokenOverlap, scoreCandidateLocal,
  mineDisagreementPairs, toKtoRows, writePreferencePairs, PREFERENCE_MINER_VERSION,
  buildBonTargets, BON_TARGETS_VERSION,
} from '../src/distill-preference.js';

test('W480 exports intact (additive guarantee)', () => {
  assert.deepEqual(OBJECTIVES, ['dpo', 'simpo', 'orpo', 'kto']);
  assert.equal(typeof doctor, 'function');
  assert.ok('ok' in doctor());
  assert.equal(typeof pref.trainPreference, 'function');
});

test('tokenOverlap Jaccard + null on empty', () => {
  const ov = tokenOverlap('the quick brown fox', 'the slow brown dog');
  assert.ok(ov > 0 && ov < 1);
  assert.equal(tokenOverlap('', 'x'), null);
  assert.equal(tokenOverlap('x', 5), null);
});

test('scoreCandidateLocal penalizes CoT leak + refusals, lifts seed overlap', () => {
  const leak = scoreCandidateLocal('<think>secret reasoning</think> The answer is 42.');
  assert.ok(leak.reasons.includes('cot_leak'));
  const refusal = scoreCandidateLocal("I cannot help with that request.");
  assert.ok(refusal.reasons.includes('refusal'));
  const empty = scoreCandidateLocal('');
  assert.equal(empty.score, 0);
  const lifted = scoreCandidateLocal('process the refund to the original payment method', { seed_output: 'refund to original payment method' });
  const unlifted = scoreCandidateLocal('process the refund to the original payment method');
  assert.ok(lifted.score >= unlifted.score);
  // bounded [0,1]
  for (const s of [leak, refusal, lifted]) assert.ok(s.score >= 0 && s.score <= 1);
});

test('mineDisagreementPairs ranks chosen>rejected by score gap', () => {
  const rows = [
    { prompt: 'P1', candidates: [{ model: 'a', text: 'A clear correct refund answer' }, { model: 'b', text: 'no' }] },
    { prompt: 'P2', candidates: [{ model: 'a', text: 'same answer here' }, { model: 'b', text: 'same answer here' }] },
    { prompt: 'P3', responses: [{ model: 'a', text: 'helpful detailed reply about shipping' }, { model: 'b', text: 'idk' }] },
  ];
  const out = mineDisagreementPairs(rows, { min_gap: 0.1 });
  assert.equal(out.ok, true);
  assert.ok(out.pairs.length >= 2, 'P1 and P3 disagree enough');
  for (const p of out.pairs) {
    assert.ok(p.chosen && p.rejected && p.prompt);
    assert.ok(p.disagreement >= 0.1);
  }
  // explicit per-candidate scores honored
  const scored = mineDisagreementPairs([
    { prompt: 'X', candidates: [{ text: 'lo', score: 0.2 }, { text: 'hi', score: 0.9 }] },
  ], { min_gap: 0.1 });
  assert.equal(scored.pairs[0].chosen, 'hi');
  assert.equal(scored.pairs[0].rejected, 'lo');
});

test('toKtoRows + writePreferencePairs (pref + kto formats)', () => {
  const pairs = [{ prompt: 'P', chosen: 'good', rejected: 'bad' }];
  const kto = toKtoRows(pairs);
  assert.deepEqual(kto, [
    { prompt: 'P', completion: 'good', label: true },
    { prompt: 'P', completion: 'bad', label: false },
  ]);
  const outP = path.join(os.tmpdir(), 'kolm-pref-pref-' + Date.now() + '.jsonl');
  const wp = writePreferencePairs(pairs, outP, { format: 'pref' });
  assert.equal(wp.ok, true);
  assert.equal(wp.count, 1);
  const lines = fs.readFileSync(outP, 'utf8').trim().split('\n');
  assert.deepEqual(JSON.parse(lines[0]), { prompt: 'P', chosen: 'good', rejected: 'bad' });
  const outK = path.join(os.tmpdir(), 'kolm-pref-kto-' + Date.now() + '.jsonl');
  const wk = writePreferencePairs(pairs, outK, { format: 'kto' });
  assert.equal(wk.count, 2);
  assert.equal(writePreferencePairs(pairs, outK, { format: 'bogus' }).error, 'unknown_format');
});

test('miner version exported', () => {
  assert.match(PREFERENCE_MINER_VERSION, /^w921-/);
});

test('buildBonTargets selects best-of-N SeqKD targets with the local scorer', () => {
  const rows = [
    {
      prompt: 'How should support process a refund?',
      seed_output: 'refund to original payment method with confirmation',
      candidates: [
        { text: 'no' },
        { text: 'I cannot help with that request.' },
        { text: 'Process the refund to the original payment method and send confirmation.' },
      ],
    },
    {
      input: 'Empty candidate row',
      candidates: [],
    },
  ];
  const out = buildBonTargets(rows, { n: 3, min_score: 0.1 });
  assert.equal(out.ok, true);
  assert.equal(out.version, BON_TARGETS_VERSION);
  assert.equal(out.targets.length, 1);
  assert.equal(out.targets[0].input, rows[0].prompt);
  assert.equal(out.targets[0].output, 'Process the refund to the original payment method and send confirmation.');
  assert.equal(out.targets[0].teacher_output, out.targets[0].output);
  assert.equal(out.targets[0].bon.n_requested, 3);
  assert.equal(out.targets[0].bon.selected_index, 2);
  assert.equal(out.stats.skipped_no_candidates, 1);
  assert.ok(out.stats.mean_selected_score > 0);
});

test('buildBonTargets validates knobs, honors thresholds, and accepts a custom judge', () => {
  assert.equal(buildBonTargets([], { n: 0 }).error, 'bad_n');
  assert.equal(buildBonTargets([], { min_score: 2 }).error, 'bad_min_score');
  const rows = [{ prompt: 'Pick one', candidates: ['alpha', 'bravo winner', 'charlie'] }];
  const thresholded = buildBonTargets(rows, { n: 3, min_score: 0.99 });
  assert.equal(thresholded.ok, true);
  assert.equal(thresholded.targets.length, 0);
  assert.equal(thresholded.stats.skipped_below_threshold, 1);

  const judged = buildBonTargets(rows, {
    n: 3,
    judge: (text) => ({ score: text.includes('charlie') ? 0.9 : 0.1, reasons: ['fixture'] }),
  });
  assert.equal(judged.targets.length, 1);
  assert.equal(judged.targets[0].output, 'charlie');
  assert.deepEqual(judged.targets[0].bon.reasons, ['fixture']);
  assert.equal(judged.targets[0].bon.judge, 'custom');
});
