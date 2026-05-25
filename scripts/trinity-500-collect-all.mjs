#!/usr/bin/env node
// scripts/trinity-500-collect-all.mjs
//
// Fires the Trinity 500 three-teacher council collect end-to-end:
//   1. claude-opus-4-7 via kolm proxy   ->  ./claude/        300 rows
//   2. gpt-4o          via kolm proxy   ->  ./gpt4o/         150 rows
//   3. deepseek-r1-32b local http:8765  ->  ./deepseek/       50 rows
//
// Each phase invokes `node cli/kolm.js distill --local-worker --mode=collect`
// (which spawns workers/distill/distill.mjs with the proxy auto-injected from
// ~/.kolm/config.json). Phase 3 expects a teacher-server.py already running
// on 127.0.0.1:8765 — spawn it first with:
//
//   set KOLM_LOCAL_TEACHER_DIR=%USERPROFILE%\.kolm\models-hf\deepseek-r1-distill-qwen-32b-int4
//   python  %USERPROFILE%\.kolm\distill-runs\trinity-pilot-7b-collect\teacher-server.py
//
// On failure, exits with the offending phase's exit code so caller (CI / shell)
// can branch. Idempotent — if a phase's training-pairs.jsonl already has the
// expected row count, it's skipped.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const REPO   = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]):/, '$1:'));
const KOLM   = path.join(REPO, 'cli', 'kolm.js');
const RUN    = path.join(os.homedir(), '.kolm', 'distill-runs', 'trinity-500-2026-05-26');

const PHASES = [
  { name: 'claude',   seeds: 'seeds-claude.jsonl',   out: 'claude',   teacher: 'anthropic:claude-opus-4-7', maxRows: 300 },
  { name: 'gpt4o',    seeds: 'seeds-gpt4o.jsonl',    out: 'gpt4o',    teacher: 'openai:gpt-4o',             maxRows: 150 },
  { name: 'deepseek', seeds: 'seeds-deepseek.jsonl', out: 'deepseek', teacher: 'local:deepseek-r1-32b',     maxRows: 50,
    localEndpoint: 'http://127.0.0.1:8765' },
];

function countLines(p) {
  if (!fs.existsSync(p)) return 0;
  return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).length;
}

for (const ph of PHASES) {
  const seedsPath = path.join(RUN, ph.seeds);
  const outDir    = path.join(RUN, ph.out);
  const pairsPath = path.join(outDir, 'training-pairs.jsonl');
  if (!fs.existsSync(seedsPath)) {
    console.error(`[collect-all] missing ${seedsPath}; run trinity-500-split-seeds.mjs first`);
    process.exit(1);
  }
  const have = countLines(pairsPath);
  if (have >= ph.maxRows) {
    console.log(`[collect-all] ${ph.name}: ${have}/${ph.maxRows} already collected -> skip`);
    continue;
  }
  console.log(`[collect-all] ${ph.name}: ${have}/${ph.maxRows}  ->  teacher=${ph.teacher}`);
  const argv = [
    KOLM, 'distill', '--local-worker',
    '--mode=collect',
    `--spec=${path.join(RUN, 'spec.json')}`,
    `--seeds=${seedsPath}`,
    `--out=${outDir}`,
    `--teacher=${ph.teacher}`,
    `--max-rows=${ph.maxRows}`,
    '--no-preflight',
  ];
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

const merged = path.join(RUN, 'merged', 'training-pairs.jsonl');
fs.mkdirSync(path.dirname(merged), { recursive: true });
const mergedFp = fs.openSync(merged, 'w');
let total = 0;
for (const ph of PHASES) {
  const p = path.join(RUN, ph.out, 'training-pairs.jsonl');
  if (!fs.existsSync(p)) continue;
  const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean);
  for (const ln of lines) {
    try {
      const row = JSON.parse(ln);
      row._teacher_phase = ph.name;
      row._teacher_slug  = ph.teacher;
      fs.writeSync(mergedFp, JSON.stringify(row) + '\n');
      total++;
    } catch { /* skip malformed */ }
  }
}
fs.closeSync(mergedFp);
console.log(`[collect-all] merged ${total} training pairs -> ${merged}`);
