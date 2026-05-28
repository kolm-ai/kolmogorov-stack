#!/usr/bin/env node
// scripts/trinity-2000-v2-split-seeds.mjs
//
// Splits trinity-2000-v2/seeds.jsonl into 3 phase files, preserving the
// per-bucket distribution within each phase so no teacher specializes in one
// topic. Deterministic — same seeds.jsonl + same phase weights always yield
// the same split.
//
// Output:
//   seeds-claude.jsonl    800 rows  (40% of each bucket)
//   seeds-gpt4o.jsonl     600 rows  (30% of each bucket)
//   seeds-deepseek.jsonl  600 rows  (30% of each bucket)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const RUN = path.join(os.homedir(), '.kolm', 'distill-runs', 'trinity-2000-v2-2026-05-28');
const SEEDS = path.join(RUN, 'seeds.jsonl');

if (!fs.existsSync(SEEDS)) {
  console.error(`[split] missing ${SEEDS}; run trinity-2000-v2-seed-gen.mjs first`);
  process.exit(1);
}

const rows = fs.readFileSync(SEEDS, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
console.log(`[split] loaded ${rows.length} seeds`);

const phases = [
  { name: 'claude',   file: 'seeds-claude.jsonl',   share: 0.40 },
  { name: 'gpt4o',    file: 'seeds-gpt4o.jsonl',    share: 0.30 },
  { name: 'deepseek', file: 'seeds-deepseek.jsonl', share: 0.30 },
];

const byBucket = {};
for (const r of rows) {
  const b = r._bucket || 'unbucketed';
  if (!byBucket[b]) byBucket[b] = [];
  byBucket[b].push(r);
}
for (const k of Object.keys(byBucket)) byBucket[k].sort((a, b) => a.id.localeCompare(b.id));

const outRows = { claude: [], gpt4o: [], deepseek: [] };
for (const [bucket, items] of Object.entries(byBucket)) {
  const claudeTake = Math.round(items.length * 0.40);
  const gpt4oTake = Math.round(items.length * 0.30);
  // deepseek gets whatever remains so total is preserved
  let i = 0;
  for (let n = 0; n < claudeTake && i < items.length; n++, i++) outRows.claude.push(items[i]);
  for (let n = 0; n < gpt4oTake && i < items.length; n++, i++) outRows.gpt4o.push(items[i]);
  for (; i < items.length; i++) outRows.deepseek.push(items[i]);
  console.log(`  bucket ${bucket}: ${claudeTake} claude / ${gpt4oTake} gpt4o / ${items.length - claudeTake - gpt4oTake} deepseek`);
}

for (const ph of phases) {
  const out = path.join(RUN, ph.file);
  fs.writeFileSync(out, outRows[ph.name].map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`[split] ${ph.name}: ${outRows[ph.name].length} rows -> ${out}`);
}
