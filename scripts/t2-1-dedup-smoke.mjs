#!/usr/bin/env node
// scripts/t2-1-dedup-smoke.mjs
//
// T2.1 smoke test — semantic near-dup dedup in
// workers/distill/scripts/dedup_pairs.py. Uses the dependency-free n-gram
// backend (--embedder ngram) so it runs anywhere with no model download.
//
//   1. synthetic 50%-dup set -> >90% of injected dups removed (DoD)
//   2. distinct prompts all survive (no false-positive dedup)
//   3. survivor of a clean-vs-CoT-leaked dup is the CLEAN row (confidence wins)
//   4. teacher-priority breaks ties (claude beats deepseek on identical text)
//   5. --preview does NOT write the --out file (dry run)
//   6. report JSON round-trips with the expected envelope keys
//   7. missing input -> exit 20 + {ok:false}

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'workers', 'distill', 'scripts', 'dedup_pairs.py');
const PY = process.env.KOLM_PYTHON || 'python';

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ok   ${label}`); }
function bad(label, detail) { fail++; console.log(`  FAIL ${label}: ${detail}`); }
function assert(cond, label, detail = '') { if (cond) ok(label); else bad(label, detail || 'condition false'); }

console.log('T2.1 — Semantic near-dup dedup smoke (n-gram backend)');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-t2-1-'));

function runDedup(extra) {
  const r = spawnSync(PY, [SCRIPT, '--embedder', 'ngram', ...extra],
    { encoding: 'utf8' });
  // Summary is the last non-empty stdout line (machine-readable JSON).
  const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
  let summary = null;
  try { summary = JSON.parse(lines[lines.length - 1]); } catch { /* leave null */ }
  return { status: r.status, summary, stderr: r.stderr || '', stdout: r.stdout || '' };
}

function writeJsonl(p, rows) {
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// A long, content-rich answer (used for the 2-row clean-vs-leak + tie cases
// where the two rows are MEANT to be near-dups of each other).
function longAnswer(topic, n) {
  return `To handle ${topic}, open the settings panel and locate the ${topic} section. `
    + `Review each option carefully, confirm the change, and save before leaving the page. `
    + `If anything looks wrong, you can revert from the history tab at any time. `
    + `This keeps your ${topic} configuration consistent across every device on the account. `
    + `Item reference number ${n}.`;
}

// 25 lexically disjoint words. Repeating one word fills an answer with trigrams
// unique to that word, so two DIFFERENT topics share ~no n-gram mass (cosine
// ~0) while a topic vs its trivial edit stays ~identical (cosine >0.95). This
// is what lets the coarse n-gram backend separate true near-dups from distinct
// rows in the smoke without a model download.
const WORDS = ['apricot', 'bicycle', 'cactus', 'dolphin', 'eagle', 'falcon', 'guitar',
  'hammer', 'igloo', 'jacket', 'kettle', 'lemon', 'mango', 'needle', 'octopus', 'pencil',
  'quartz', 'rabbit', 'salmon', 'turtle', 'umbrella', 'violin', 'walnut', 'xylophone', 'yogurt'];
const distinctAnswer = (i) => (WORDS[i] + ' ').repeat(18).trim();

// --- build a synthetic 50%-dup corpus: 25 distinct + 25 near-dups = 50 rows ---
const N = WORDS.length;
const rows = [];
for (let i = 0; i < N; i++) {
  rows.push({ id: `u${i}`, input: `How do I configure ${WORDS[i]}?`, teacher_output: distinctAnswer(i), _teacher_phase: 'claude' });
}
// near-dups: same input, answer with a trivial trailing change (different teacher)
for (let i = 0; i < N; i++) {
  rows.push({ id: `d${i}`, input: `How do I configure ${WORDS[i]}?`, teacher_output: distinctAnswer(i) + ' thanks', _teacher_phase: 'gpt4o' });
}
const corpus = path.join(tmp, 'pairs.jsonl');
writeJsonl(corpus, rows);

// --- 1 + 2. dedup the 50%-dup corpus ---
const out1 = path.join(tmp, 'deduped.jsonl');
const rep1 = path.join(tmp, 'report.json');
const r1 = runDedup(['--pairs', corpus, '--out', out1, '--report', rep1, '--threshold', '0.92']);
assert(r1.status === 0 && r1.summary && r1.summary.ok, '1: dedup runs ok', `status=${r1.status} stderr=${r1.stderr.slice(-200)}`);
// 25 injected dups; DoD = remove >90% of them. Distinct 25 must all survive,
// so n_kept should be ~25 (>=23) and n_removed ~25 (>=23 = 92% of 25).
const kept = r1.summary ? r1.summary.n_kept : -1;
const removed = r1.summary ? r1.summary.n_removed : -1;
assert(removed >= 23, '1: >=90% of injected near-dups removed', `removed=${removed}/25`);
assert(kept >= 23 && kept <= 27, '2: distinct prompts survive (no over-dedup)', `kept=${kept} (expect ~25)`);
// The written file row count must equal n_kept.
const writtenCount = fs.readFileSync(out1, 'utf8').trim().split('\n').filter(Boolean).length;
assert(writtenCount === kept, '2: written row count matches n_kept', `file=${writtenCount} summary=${kept}`);

// --- 3. clean answer survives over a CoT-leaked near-dup ---
const cleanVsLeak = [
  { id: 'c', input: 'What is the refund window?', teacher_output: longAnswer('refunds', 1), _teacher_phase: 'claude' },
  { id: 'l', input: 'What is the refund window?', teacher_output: '<think>recall policy, 30 days</think> ' + longAnswer('refunds', 1), _teacher_phase: 'deepseek' },
];
const cvlIn = path.join(tmp, 'cvl.jsonl');
const cvlOut = path.join(tmp, 'cvl-out.jsonl');
writeJsonl(cvlIn, cleanVsLeak);
const r3 = runDedup(['--pairs', cvlIn, '--out', cvlOut, '--threshold', '0.85']);
const cvlRows = fs.existsSync(cvlOut)
  ? fs.readFileSync(cvlOut, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : [];
assert(r3.summary && r3.summary.n_kept === 1 && cvlRows.length === 1
  && !/<think>/i.test(cvlRows[0].teacher_output),
  '3: clean answer survives, CoT-leaked dup dropped', JSON.stringify(r3.summary));

// --- 4. teacher-priority breaks an exact-text tie (claude beats deepseek) ---
const tie = [
  { id: 'a', input: 'Q', teacher_output: longAnswer('billing', 7), _teacher_phase: 'deepseek' },
  { id: 'b', input: 'Q', teacher_output: longAnswer('billing', 7), _teacher_phase: 'claude' },
];
const tieIn = path.join(tmp, 'tie.jsonl');
const tieOut = path.join(tmp, 'tie-out.jsonl');
writeJsonl(tieIn, tie);
const r4 = spawnSync(PY, [SCRIPT, '--embedder', 'ngram', '--pairs', tieIn, '--out', tieOut,
  '--threshold', '0.9', '--teacher-priority', 'claude,gpt4o,deepseek'], { encoding: 'utf8' });
const tieRows = fs.existsSync(tieOut)
  ? fs.readFileSync(tieOut, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : [];
assert(r4.status === 0 && tieRows.length === 1 && tieRows[0]._teacher_phase === 'claude',
  '4: teacher-priority keeps claude over deepseek on a tie', JSON.stringify(tieRows.map((x) => x._teacher_phase)));

// --- 5. --preview does not write the out file ---
const previewOut = path.join(tmp, 'preview-out.jsonl');
const r5 = runDedup(['--pairs', corpus, '--out', previewOut, '--preview', '--threshold', '0.92']);
assert(r5.summary && r5.summary.preview === true && !fs.existsSync(previewOut),
  '5: --preview reports but writes no out file', `exists=${fs.existsSync(previewOut)}`);

// --- 6. report JSON envelope ---
let report = null;
try { report = JSON.parse(fs.readFileSync(rep1, 'utf8')); } catch { /* leave null */ }
assert(report && report.ok === true && report.version === 't2.1-v1'
  && report.backend === 'sparse' && typeof report.removed_fraction === 'number'
  && Array.isArray(report.removals_sample),
  '6: report JSON has expected envelope', JSON.stringify(report && Object.keys(report)));

// --- 7. missing input -> exit 20 ---
const r7 = runDedup(['--pairs', path.join(tmp, 'does-not-exist.jsonl'), '--out', path.join(tmp, 'x.jsonl')]);
assert(r7.status === 20 && r7.summary && r7.summary.ok === false,
  '7: missing input -> exit 20 + ok:false', `status=${r7.status}`);

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
