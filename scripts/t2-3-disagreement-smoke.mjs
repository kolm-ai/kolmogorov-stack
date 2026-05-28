#!/usr/bin/env node
// scripts/t2-3-disagreement-smoke.mjs
//
// T2.3 smoke test — council-disagreement preference mining in
// src/distill-preference.js. Pure JS, no trainer/GPU/teacher spend.
//
//   1. mineDisagreementPairs groups by prompt; a 2-teacher disagreement
//      yields exactly one {prompt, chosen, rejected} pair
//   2. identical outputs across teachers -> no pair (no disagreement)
//   3. a single teacher for a prompt -> no pair
//   4. heuristic ranks a clean answer ABOVE a CoT-leaked answer (chosen
//      has no <think>)
//   5. heuristic ranks a real answer ABOVE a refusal
//   6. seed_output reference overlap lifts the on-reference candidate
//   7. injected judge fn overrides the heuristic; basis 'judge:injected'
//   8. tokenOverlap mirrors eval_adapter._judge_local (perfect=1, none=0,
//      empty-ref=null)
//   9. toKtoRows emits 2 label rows per pair (true then false)
//  10. writePreferencePairs writes JSONL round-trip; kto format writes labels
//  11. minMargin filter drops thin-margin pairs
//  12. requireDistinctTeachers drops same-teacher pairs
//  13. trainPreference still returns the no_trainer envelope (regression
//      guard) and accepts a pairs file we wrote

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ok   ${label}`); }
function bad(label, detail) { fail++; console.log(`  FAIL ${label}: ${detail}`); }
function assert(cond, label, detail = '') { if (cond) ok(label); else bad(label, detail || 'condition false'); }

console.log('T2.3 — Council-disagreement preference mining smoke');

// Import fresh; ensure no env judge is configured for the heuristic tests.
delete process.env.KOLM_DISAGREEMENT_JUDGE;
const pref = await import('../src/distill-preference.js');
const {
  mineDisagreementPairs, tokenOverlap, scoreCandidateLocal,
  toKtoRows, writePreferencePairs, trainPreference, DISAGREEMENT_VERSION,
} = pref;

// --- 1. basic disagreement -> one pair ---
const rows1 = [
  { input: 'How do I reset my password?', teacher_output: 'Click "Forgot password" on the sign-in page and follow the email link.', teacher: 'openai:gpt-4o' },
  { input: 'How do I reset my password?', teacher_output: 'Go to Settings > Security > Reset password and confirm via email.', teacher: 'anthropic:claude' },
];
const r1 = mineDisagreementPairs(rows1);
assert(r1.ok && r1.pairs.length === 1, '1: 2-teacher disagreement -> 1 pair', JSON.stringify(r1.stats));
assert(r1.pairs[0] && r1.pairs[0].prompt === 'How do I reset my password?'
  && typeof r1.pairs[0].chosen === 'string' && typeof r1.pairs[0].rejected === 'string'
  && r1.pairs[0].chosen !== r1.pairs[0].rejected,
  '1: pair has distinct chosen/rejected for the prompt',
  JSON.stringify(r1.pairs[0]));
assert(r1.version === DISAGREEMENT_VERSION && r1.basis === 'heuristic',
  '1: version + heuristic basis stamped', `${r1.version}/${r1.basis}`);

// --- 2. identical outputs -> no disagreement ---
const rows2 = [
  { input: 'Q', teacher_output: 'Same exact answer.', teacher: 'a' },
  { input: 'Q', teacher_output: 'Same exact answer.', teacher: 'b' },
];
const r2 = mineDisagreementPairs(rows2);
assert(r2.pairs.length === 0, '2: identical outputs -> no pair', JSON.stringify(r2.stats));

// --- 3. single teacher -> no pair ---
const r3 = mineDisagreementPairs([{ input: 'Q', teacher_output: 'only one', teacher: 'a' }]);
assert(r3.pairs.length === 0, '3: single candidate -> no pair', JSON.stringify(r3.stats));

// --- 4. clean answer beats CoT-leaked answer ---
const rows4 = [
  { input: 'What is the refund window?', teacher_output: 'Refunds are available within 30 days of purchase.', teacher: 'clean' },
  { input: 'What is the refund window?', teacher_output: '<think>the user wants policy, recall 30 days</think> 30 days.', teacher: 'leaky' },
];
const r4 = mineDisagreementPairs(rows4);
assert(r4.pairs.length === 1 && !/<think>/i.test(r4.pairs[0].chosen) && /<think>/i.test(r4.pairs[0].rejected),
  '4: clean answer chosen over CoT-leaked answer', JSON.stringify(r4.pairs[0]));

// --- 5. real answer beats a refusal ---
const rows5 = [
  { input: 'How do I export my data?', teacher_output: 'Open Settings > Export and choose CSV or JSON.', teacher: 'helpful' },
  { input: 'How do I export my data?', teacher_output: "I'm sorry, I cannot help with that request.", teacher: 'refuser' },
];
const r5 = mineDisagreementPairs(rows5);
assert(r5.pairs.length === 1 && r5.pairs[0].chosen_teacher === 'helpful',
  '5: helpful answer chosen over refusal', JSON.stringify(r5.pairs[0]));

// --- 6. seed_output reference overlap lifts on-reference candidate ---
const rows6 = [
  { input: 'Capital of France?', teacher_output: 'The capital of France is Paris.', teacher: 'onref', seed_output: 'Paris is the capital of France.' },
  { input: 'Capital of France?', teacher_output: 'It is a major European city.', teacher: 'vague', seed_output: 'Paris is the capital of France.' },
];
const r6 = mineDisagreementPairs(rows6);
assert(r6.pairs.length === 1 && r6.pairs[0].chosen_teacher === 'onref',
  '6: reference-overlapping answer chosen', JSON.stringify(r6.pairs[0]));

// --- 7. injected judge overrides heuristic ---
// Judge prefers the SECOND candidate (index 1) regardless of content.
const judge = (_prompt, cands) => cands.map((_c, i) => (i === 1 ? 1.0 : 0.0));
const r7 = mineDisagreementPairs(rows1, { judge });
assert(r7.pairs.length === 1 && r7.pairs[0].basis === 'judge:injected',
  '7: injected judge basis stamped', JSON.stringify(r7.pairs[0]));
assert(r7.pairs[0].chosen === rows1[1].teacher_output,
  '7: injected judge picks its preferred candidate', JSON.stringify(r7.pairs[0]));

// --- 8. tokenOverlap mirrors _judge_local ---
assert(tokenOverlap('The answer is four.', 'The answer is four.') === 1.0,
  '8: perfect overlap -> 1.0');
assert(tokenOverlap('xyz unrelated banana', 'The answer is four.') === 0,
  '8: disjoint tokens -> 0');
assert(tokenOverlap('anything', 'a') === null,
  '8: empty-ref-tokens -> null');

// --- 9. toKtoRows shape ---
const kto = toKtoRows(r1.pairs);
assert(kto.length === 2 && kto[0].label === true && kto[1].label === false
  && kto[0].response === r1.pairs[0].chosen && kto[1].response === r1.pairs[0].rejected,
  '9: toKtoRows -> [chosen(true), rejected(false)]', JSON.stringify(kto));

// --- 10. writePreferencePairs round-trip (pref + kto) ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-t2-3-'));
const prefPath = path.join(tmp, 'preference-pairs.jsonl');
const w = writePreferencePairs(r1.pairs, prefPath);
assert(w.ok && fs.existsSync(prefPath) && w.count === 1, '10: pref file written', JSON.stringify(w));
const back = fs.readFileSync(prefPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
assert(back.length === 1 && back[0].chosen && back[0].rejected && back[0].prompt,
  '10: pref JSONL round-trips {prompt,chosen,rejected}', JSON.stringify(back[0]));
const ktoPath = path.join(tmp, 'kto.jsonl');
const wk = writePreferencePairs(r1.pairs, ktoPath, { format: 'kto' });
const ktoBack = fs.readFileSync(ktoPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
assert(wk.ok && ktoBack.length === 2 && 'label' in ktoBack[0],
  '10: kto JSONL round-trips label rows', JSON.stringify(ktoBack));

// --- 11. minMargin filter ---
// Two near-identical-quality answers; a high minMargin should drop the pair.
const rowsThin = [
  { input: 'Hi', teacher_output: 'Hello there, how can I help you today?', teacher: 'a' },
  { input: 'Hi', teacher_output: 'Hi there, how may I help you today?', teacher: 'b' },
];
const rThinKeep = mineDisagreementPairs(rowsThin, { minMargin: 0 });
const rThinDrop = mineDisagreementPairs(rowsThin, { minMargin: 0.9 });
assert(rThinKeep.pairs.length === 1 && rThinDrop.pairs.length === 0,
  '11: minMargin gates thin-margin pairs',
  `keep=${rThinKeep.pairs.length} drop=${rThinDrop.pairs.length}`);

// --- 12. requireDistinctTeachers ---
const rowsSameTeacher = [
  { input: 'Q2', teacher_output: 'Answer one is short.', teacher: 'solo' },
  { input: 'Q2', teacher_output: 'Answer two is a much longer and more complete reply.', teacher: 'solo' },
];
const rSame = mineDisagreementPairs(rowsSameTeacher, { requireDistinctTeachers: true });
assert(rSame.pairs.length === 0, '12: same-teacher pair dropped when requireDistinctTeachers',
  JSON.stringify(rSame.stats));
const rSameAllow = mineDisagreementPairs(rowsSameTeacher, { requireDistinctTeachers: false });
assert(rSameAllow.pairs.length === 1, '12: same-teacher pair kept when allowed',
  JSON.stringify(rSameAllow.stats));

// --- 13. trainPreference regression guard + accepts our pairs file ---
const prevTrainer = process.env.KOLM_PREFERENCE_TRAINER;
delete process.env.KOLM_PREFERENCE_TRAINER;
const tp = trainPreference({ pairsPath: prefPath, studentPath: tmp, objective: 'simpo' });
assert(tp.ok === false && tp.error === 'no_trainer_installed' && tp.objective === 'simpo',
  '13: trainPreference returns no_trainer envelope (simpo)', JSON.stringify(tp));
if (prevTrainer != null) process.env.KOLM_PREFERENCE_TRAINER = prevTrainer;

// also confirm scoreCandidateLocal is bounded + penalizes hard CoT
const sClean = scoreCandidateLocal('A clear, complete answer to the question.').score;
const sLeak = scoreCandidateLocal('<think>secret reasoning</think> answer').score;
assert(sClean >= 0 && sClean <= 1 && sLeak >= 0 && sLeak <= 1 && sClean > sLeak,
  '13b: scoreCandidateLocal bounded [0,1] and penalizes hard CoT',
  `clean=${sClean} leak=${sLeak}`);

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
