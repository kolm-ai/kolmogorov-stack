#!/usr/bin/env node
// scripts/trinity-500-split-seeds.mjs
//
// W870 follow-on — once trinity-500-2026-05-26/seeds.jsonl has 500 rows,
// split into three council slices the local distill worker can consume
// directly (it doesn't support --seed-offset, just takes the first N).
//
//   seeds-claude.jsonl   rows   1-300  -> anthropic:claude-opus-4-7  via proxy
//   seeds-gpt4o.jsonl    rows 301-450  -> openai:gpt-4o              via proxy
//   seeds-deepseek.jsonl rows 451-500  -> kolm:deepseek-r1-32b       local :8765
//
// Idempotent — overwrites the slice files each run.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const RUN_DIR = path.join(os.homedir(), '.kolm', 'distill-runs', 'trinity-500-2026-05-26');
const SEEDS   = path.join(RUN_DIR, 'seeds.jsonl');
const SLICES  = [
  { name: 'seeds-claude.jsonl',   start: 0,   end: 300 },
  { name: 'seeds-gpt4o.jsonl',    start: 300, end: 450 },
  { name: 'seeds-deepseek.jsonl', start: 450, end: 500 },
];

if (!fs.existsSync(SEEDS)) {
  console.error('[split] no seeds.jsonl at ' + SEEDS);
  process.exit(1);
}
const rows = fs.readFileSync(SEEDS, 'utf-8').split('\n').filter(Boolean);
if (rows.length < 500) {
  console.error('[split] expected 500 rows, got ' + rows.length + '; rerun seed-gen first');
  process.exit(1);
}

for (const sl of SLICES) {
  const slice = rows.slice(sl.start, sl.end);
  const p = path.join(RUN_DIR, sl.name);
  fs.writeFileSync(p, slice.join('\n') + '\n');
  console.log('[split] ' + sl.name + ' = ' + slice.length + ' rows  ->  ' + p);
}
console.log('[split] done.');
