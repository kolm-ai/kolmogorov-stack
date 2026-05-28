#!/usr/bin/env node
// scripts/trinity-2000-v2-collect-all.mjs
//
// Fires the Trinity 2000 v2 three-teacher council end-to-end:
//   1. claude-sonnet-4-5-20250929  via kolm proxy   ->  ./claude/     800 rows
//   2. gpt-4o                      via kolm proxy   ->  ./gpt4o/      600 rows
//   3. deepseek-r1-distill-qwen-32b local :8765     ->  ./deepseek/   600 rows
//
// Each phase invokes `node cli/kolm.js distill --local-worker --mode=collect
// --resume` (the new resume flag picks up at row N+1 if a prior run crashed).
//
// Phase 3 expects a teacher-server.py already running on 127.0.0.1:8765.
// Start it first with:
//
//   set KOLM_LOCAL_TEACHER_DIR=%USERPROFILE%\.kolm\models-hf\deepseek-r1-distill-qwen-32b-int4
//   python  %USERPROFILE%\.kolm\distill-runs\trinity-pilot-7b-collect\teacher-server.py
//
// On failure, exits with the offending phase's exit code so caller (CI / shell)
// can branch. Idempotent: if a phase's training-pairs.jsonl already has the
// expected row count, it's skipped. If it has fewer rows, the phase is run
// with --resume so the collector picks up where it left off.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { estimateBatchCost } from '../src/cost-estimator.js';

const REPO = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]):/, '$1:'));
const KOLM = path.join(REPO, 'cli', 'kolm.js');
const RUN  = path.join(os.homedir(), '.kolm', 'distill-runs', 'trinity-2000-v2-2026-05-28');

const PHASES = [
  { name: 'claude',   seeds: 'seeds-claude.jsonl',   out: 'claude',   teacher: 'anthropic:claude-sonnet-4-6', maxRows: 800 },
  { name: 'gpt4o',    seeds: 'seeds-gpt4o.jsonl',    out: 'gpt4o',    teacher: 'openai:gpt-4o',                        maxRows: 600 },
  { name: 'deepseek', seeds: 'seeds-deepseek.jsonl', out: 'deepseek', teacher: 'local:deepseek-r1-distill-qwen-32b',   maxRows: 600,
    localEndpoint: 'http://127.0.0.1:8765' },
];

// T1.2 — upfront cost preview. Pulls per-teacher estimate from the same module
// the worker uses for its in-loop cap, so the numbers preview = numbers cap.
const _estimate = estimateBatchCost({
  teachers: PHASES.map((p) => ({ slug: p.teacher, rows: p.maxRows })),
});
console.log(`[collect-all] estimate: $${_estimate.total_usd.toFixed(2)} total`);
for (const t of _estimate.per_teacher) {
  const note = t.unknown_price ? '  (no price in registry; $0 placeholder)'
             : t.vendor === 'local' ? '  (local hardware; no per-token cost)'
             : '';
  console.log(`  ${t.slug.padEnd(48)} ${String(t.rows).padStart(4)} rows  $${t.est_usd.toFixed(2)}${note}`);
}
if (process.env.KOLM_MAX_USD) {
  const cap = Number.parseFloat(process.env.KOLM_MAX_USD);
  if (Number.isFinite(cap) && cap > 0) {
    console.log(`[collect-all] cap: $${cap.toFixed(2)} (KOLM_MAX_USD)`);
    if (_estimate.total_usd > cap) {
      console.error(`[collect-all] preview exceeds cap: $${_estimate.total_usd.toFixed(2)} > $${cap.toFixed(2)}; aborting pre-spend.`);
      console.error('  override with KOLM_MAX_USD=<larger> OR reduce per-phase maxRows.');
      process.exit(2);
    }
  }
} else {
  console.log(`[collect-all] no cap set (set KOLM_MAX_USD=<n> to fail-closed at $n cumulative)`);
}

function countLines(p) {
  if (!fs.existsSync(p)) return 0;
  return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).length;
}

for (const ph of PHASES) {
  const seedsPath = path.join(RUN, ph.seeds);
  const outDir    = path.join(RUN, ph.out);
  const pairsPath = path.join(outDir, 'training-pairs.jsonl');
  if (!fs.existsSync(seedsPath)) {
    console.error(`[collect-all] missing ${seedsPath}; run trinity-2000-v2-split-seeds.mjs first`);
    process.exit(1);
  }
  const have = countLines(pairsPath);
  if (have >= ph.maxRows) {
    console.log(`[collect-all] ${ph.name}: ${have}/${ph.maxRows} already collected -> skip`);
    continue;
  }
  const willResume = have > 0;
  console.log(`[collect-all] ${ph.name}: ${have}/${ph.maxRows}  ->  teacher=${ph.teacher}${willResume ? '  (resume)' : ''}`);
  const argv = [
    KOLM, 'distill', '--local-worker',
    '--mode=collect',
    `--spec=${path.join(RUN, 'spec.json')}`,
    `--seeds=${seedsPath}`,
    `--out=${outDir}`,
    `--teacher=${ph.teacher}`,
    `--max-rows=${ph.maxRows}`,
    '--no-preflight',
    '--no-holdout-split',
  ];
  if (willResume) argv.push('--resume');
  if (ph.localEndpoint) argv.push(`--local-endpoint=${ph.localEndpoint}`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, argv, { stdio: 'inherit', shell: false });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status !== 0) {
    console.error(`[collect-all] ${ph.name} exited with status ${r.status} after ${dt}s`);
    process.exit(r.status || 1);
  }
  console.log(`[collect-all] ${ph.name} ok in ${dt}s  ->  ${pairsPath}`);
}

// Scrub DeepSeek-R1 chain-of-thought leaks at merge time. The R1 chat template
// emits reasoning followed by '</think>' (often without a matching '<think>'
// open tag). Training on the raw text causes the student to leak 'Okay, so the
// user...' preambles on non-reasoning queries. Standalone scrubber lives at
// workers/distill/scripts/scrub_think.py.
function scrubThink(text) {
  if (typeof text !== 'string') return text;
  const idx = text.lastIndexOf('</think>');
  if (idx >= 0) return text.slice(idx + '</think>'.length).replace(/^\s+/, '');
  return text;
}

const merged = path.join(RUN, 'merged', 'training-pairs.jsonl');
fs.mkdirSync(path.dirname(merged), { recursive: true });
const mergedFp = fs.openSync(merged, 'w');
let total = 0;
let scrubbed = 0;
const perPhase = {};
for (const ph of PHASES) {
  const p = path.join(RUN, ph.out, 'training-pairs.jsonl');
  if (!fs.existsSync(p)) continue;
  const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean);
  perPhase[ph.name] = 0;
  for (const ln of lines) {
    try {
      const row = JSON.parse(ln);
      if (typeof row.teacher_output === 'string' && row.teacher_output.includes('</think>')) {
        row.teacher_output = scrubThink(row.teacher_output);
        scrubbed++;
      }
      if (!row.teacher_output) continue; // post-scrub empty row is useless
      row._teacher_phase = ph.name;
      row._teacher_slug  = ph.teacher;
      fs.writeSync(mergedFp, JSON.stringify(row) + '\n');
      total++;
      perPhase[ph.name]++;
    } catch { /* skip malformed */ }
  }
}
fs.closeSync(mergedFp);
console.log(`[collect-all] merged ${total} training pairs -> ${merged}  (CoT-scrubbed ${scrubbed})`);
for (const [name, n] of Object.entries(perPhase)) console.log(`  ${name}: ${n}`);
