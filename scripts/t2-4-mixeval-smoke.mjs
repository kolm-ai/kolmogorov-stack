#!/usr/bin/env node
// scripts/t2-4-mixeval-smoke.mjs
//
// T2.4 smoke test — MixEval-Hard bench mode in eval_adapter.py. Verifies the
// argparse contract + helper functions WITHOUT requiring torch/transformers
// (and without spending real judge $$$).
//
//   1. --bench=mixeval-hard + missing bench file -> exit 20 with hint
//   2. --bench-file <path> override accepted; loads JSONL with `question` field
//   3. _judge_local() returns score in [0,1] for matching strings; lower for poor matches
//   4. _judge_local() returns score=None when no reference provided
//   5. MIXEVAL_HARD_ARENA_CORRELATION constant present in source
//   6. eval_adapter.py argparse accepts --bench --bench-file --bench-out
//      --judge-vendor --judge-model --bench-limit (no SystemExit on dry parse)
//   7. _default_bench_path() points under ~/.kolm/benches/
//   8. _load_bench_questions() respects --bench-limit
//   9. Recipe schema: trinity-2000.json eval block can carry `bench` field
//      (recipe loader does NOT reject it)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const _here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(_here, '..');
const EVAL_PY = path.join(REPO, 'workers', 'distill', 'scripts', 'eval_adapter.py');

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ok   ${label}`); }
function bad(label, detail) { fail++; console.log(`  FAIL ${label}: ${detail}`); }
function assert(cond, label, detail = '') {
  if (cond) ok(label); else bad(label, detail || 'condition false');
}

function findPython() {
  for (const cand of ['python3', 'python']) {
    const r = spawnSync(cand, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf-8' });
    if (r.status === 0 && r.stdout.trim() === '3') return cand;
  }
  return null;
}
const PY = findPython();
if (!PY) { console.log('  SKIP (no python3 in PATH)'); process.exit(0); }

console.log('T2.4 — MixEval-Hard bench mode smoke');

// --- Set up a tmp bench fixture ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-t2-4-'));
const fixture = path.join(tmp, 'questions.jsonl');
const sample = [
  { id: 'q1', question: 'What is 2+2?', reference_answer: 'The answer is four.' },
  { id: 'q2', question: 'Capital of France?', reference_answer: 'Paris is the capital of France.' },
  { id: 'q3', question: 'Sum 1..10?', reference_answer: 'The sum of integers 1 through 10 is 55.' },
];
fs.writeFileSync(fixture, sample.map((s) => JSON.stringify(s)).join('\n') + '\n');

// --- 1. missing bench file -> exit 20 ---
const probe1 = `
import sys, os, json
HERE = r"${path.dirname(EVAL_PY).replace(/\\/g, '\\\\')}"
sys.path.insert(0, HERE)
import importlib.util as _ilu
spec = _ilu.spec_from_file_location('eval_probe', os.path.join(HERE, 'eval_adapter.py'))
mod = _ilu.module_from_spec(spec)
spec.loader.exec_module(mod)
# Call _load_bench_questions on a non-existent path; should sys.exit(20)
try:
    mod._load_bench_questions(r"${path.join(tmp, 'nonexistent.jsonl').replace(/\\/g, '\\\\')}", 0)
    print("DID_NOT_EXIT")
except SystemExit as e:
    print(f"EXIT:{e.code}")
`;
const r1 = spawnSync(PY, ['-c', probe1], { encoding: 'utf-8' });
assert(/EXIT:20/.test(r1.stdout || ''),
  '1: missing bench file -> exit 20',
  `stdout=${r1.stdout?.slice(0, 200)} stderr=${r1.stderr?.slice(0, 200)}`);
assert(/bench file not found|expected JSONL/i.test(r1.stderr || ''),
  '1: stderr has install hint pointing at fixture path',
  r1.stderr?.slice(0, 300));

// --- 2-4, 7-8: probe helpers ---
const probe2 = `
import sys, os, json
HERE = r"${path.dirname(EVAL_PY).replace(/\\/g, '\\\\')}"
sys.path.insert(0, HERE)
import importlib.util as _ilu
spec = _ilu.spec_from_file_location('eval_probe2', os.path.join(HERE, 'eval_adapter.py'))
mod = _ilu.module_from_spec(spec)
spec.loader.exec_module(mod)

rows = mod._load_bench_questions(r"${fixture.replace(/\\/g, '\\\\')}", 0)
limited = mod._load_bench_questions(r"${fixture.replace(/\\/g, '\\\\')}", 2)
judge_good = mod._judge_local("The answer is four.", "The answer is four.")
judge_poor = mod._judge_local("xyz unrelated text", "The answer is four.")
judge_noref = mod._judge_local("anything", None)
judge_emptyref = mod._judge_local("anything", "a")  # ref tokens all len<=2 -> empty set
default_path = mod._default_bench_path("mixeval-hard")
print(json.dumps({
  "row_count": len(rows),
  "limited_count": len(limited),
  "judge_good_score": judge_good["score"],
  "judge_poor_score": judge_poor["score"],
  "judge_noref": judge_noref["score"],
  "judge_emptyref": judge_emptyref["score"],
  "default_path": default_path,
  "arena_corr": mod.MIXEVAL_HARD_ARENA_CORRELATION,
}))
`;
const r2 = spawnSync(PY, ['-c', probe2], { encoding: 'utf-8' });
let p2 = null;
try { p2 = JSON.parse((r2.stdout || '').trim()); } catch (e) {
  bad('2-4: probe2 JSON parses', e.message + ' stderr=' + (r2.stderr || '').slice(0, 300));
}
if (p2) {
  assert(p2.row_count === 3,
    '2: loads 3 questions from fixture', `got ${p2.row_count}`);
  assert(p2.limited_count === 2,
    '8: --bench-limit truncates to first N', `got ${p2.limited_count}`);
  assert(p2.judge_good_score === 1.0,
    '3: perfect match -> score 1.0', `got ${p2.judge_good_score}`);
  assert(p2.judge_poor_score >= 0 && p2.judge_poor_score < 0.5,
    '3: poor match -> low score', `got ${p2.judge_poor_score}`);
  assert(p2.judge_noref === null,
    '4: no reference -> score null', `got ${p2.judge_noref}`);
  assert(p2.judge_emptyref === null,
    '4: empty-ref-tokens -> score null', `got ${p2.judge_emptyref}`);
  assert(/\.kolm[\\/]benches[\\/]mixeval-hard[\\/]questions\.jsonl$/.test(p2.default_path),
    '7: default bench path under ~/.kolm/benches/mixeval-hard/',
    p2.default_path);
  assert(Math.abs(p2.arena_corr - 0.96) < 0.001,
    '5: MIXEVAL_HARD_ARENA_CORRELATION = 0.96',
    `got ${p2.arena_corr}`);
}

// --- 6. argparse accepts T2.4 flags ---
const probe6 = `
import sys, os
HERE = r"${path.dirname(EVAL_PY).replace(/\\/g, '\\\\')}"
sys.path.insert(0, HERE)
sys.argv = ['eval_adapter', '--pairs', 'x', '--adapter', 'y',
            '--bench', 'mixeval-hard',
            '--bench-file', '/tmp/q.jsonl',
            '--bench-out', '/tmp/out.json',
            '--judge-vendor', 'openai',
            '--judge-model', 'gpt-4o-mini',
            '--bench-limit', '5']
import importlib.util as _ilu
spec = _ilu.spec_from_file_location('eval_probe6', os.path.join(HERE, 'eval_adapter.py'))
mod = _ilu.module_from_spec(spec)
spec.loader.exec_module(mod)
args = mod.parse_args()
print(f"bench={args.bench} judge_vendor={args.judge_vendor} judge_model={args.judge_model} bench_limit={args.bench_limit}")
`;
const r6 = spawnSync(PY, ['-c', probe6], { encoding: 'utf-8' });
assert(r6.status === 0,
  '6: argparse accepts all T2.4 flags', `status=${r6.status} stderr=${(r6.stderr || '').slice(0, 300)}`);
assert(/bench=mixeval-hard/.test(r6.stdout || ''),
  '6: --bench parsed', r6.stdout?.slice(0, 200));
assert(/judge_vendor=openai.*judge_model=gpt-4o-mini.*bench_limit=5/.test(r6.stdout || ''),
  '6: --judge-vendor/--judge-model/--bench-limit parsed', r6.stdout?.slice(0, 200));

// --- 9. recipe loader accepts eval.bench key ---
// Make a tmp recipe with the bench key, load it through the loader.
const recipesDir = path.join(tmp, 'recipes');
fs.mkdirSync(recipesDir, { recursive: true });
const tmpRecipe = {
  name: 'test-mixeval',
  version: '1.0.0',
  description: 'T2.4 smoke-test recipe (not for real runs)',
  seeds: {
    target: 10,
    generator: 'scripts/nonexistent-seed-gen.mjs',
    buckets: { sample: 10 },
  },
  teachers: [{ slug: 'openai:gpt-4o', weight: 1.0, rows: 10, source: 'kolm-proxy' }],
  scrub: { cot: { markers_path: 'workers/distill/scripts/cot_markers.json' } },
  train: {
    method: 'qlora',
    student_base: 'Qwen/Qwen2.5-0.5B',
    lora: { r: 8, alpha: 16, dropout: 0.05 },
    max_seq_len: 512,
    epochs: 1,
    batch_size: 1,
    lr: 2e-4,
  },
  eval: { holdout_n: 5, strict_cot: true, bench: 'mixeval-hard' },
  system_prompt: 'x',
};
fs.writeFileSync(path.join(recipesDir, 'test-mixeval.json'), JSON.stringify(tmpRecipe, null, 2));

const { loadRecipe } = await import('../src/distill-recipe-loader.js');
const loaded = loadRecipe(path.join(recipesDir, 'test-mixeval.json'));
assert(loaded.ok === true,
  '9: recipe loader accepts eval.bench=mixeval-hard',
  loaded.message || JSON.stringify(loaded.issues));
if (loaded.ok) {
  assert(loaded.recipe?.eval?.bench === 'mixeval-hard',
    '9: bench field survives load round-trip',
    `got ${loaded.recipe?.eval?.bench}`);
}

// cleanup
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
