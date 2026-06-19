#!/usr/bin/env node
// Run a local distillation method bake-off over precomputed method outputs.
//
// This script does not train models and does not call providers. It expects a
// JSONL file where each row carries method_outputs / outputs / <method>_output
// fields, then emits the W972 hash-only comparison report.

import fs from 'node:fs';
import path from 'node:path';

import {
  DISTILL_BAKEOFF_VERSION,
  loadDistillBakeoffJsonl,
  runDistillMethodBakeoff,
} from '../src/distill-bakeoff.js';

function parseArgs(argv) {
  const out = { _: [] };
  const take = (name) => { out[name] = argv[++i]; };
  let i = 0;
  for (; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--rows' || a === '--jsonl' || a === '--holdout') take('rows');
    else if (a === '--methods') take('methods');
    else if (a === '--baseline') take('baseline');
    else if (a === '--max-rows') take('maxRows');
    else if (a === '--min-score-delta') take('minScoreDelta');
    else if (a === '--min-win-rate') take('minWinRate');
    else if (a === '--out') take('out');
    else if (a === '--summary') out.summary = true;
    else out._.push(a);
  }
  return out;
}

function usage() {
  console.error('usage: node scripts/distill-method-bakeoff.mjs --rows holdout.jsonl [--methods seqkd,ropd,gad] [--baseline seqkd] [--max-rows 128] [--summary] [--out report.json]');
  console.error(`spec: ${DISTILL_BAKEOFF_VERSION}`);
  process.exit(2);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.rows) usage();
  const file = path.resolve(args.rows);
  if (!fs.existsSync(file)) {
    console.error(`no such file: ${file}`);
    process.exit(2);
  }
  const rows = loadDistillBakeoffJsonl(fs.readFileSync(file, 'utf8'));
  const methods = args.methods
    ? String(args.methods).split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;
  const report = await runDistillMethodBakeoff({
    rows,
    methods,
    baseline_method: args.baseline,
    max_rows: args.maxRows ? Number(args.maxRows) : undefined,
    min_score_delta: args.minScoreDelta ? Number(args.minScoreDelta) : undefined,
    min_win_rate: args.minWinRate ? Number(args.minWinRate) : undefined,
  });
  if (args.out) fs.writeFileSync(path.resolve(args.out), JSON.stringify(report, null, 2) + '\n');
  if (args.summary && report.ok) {
    console.log(JSON.stringify({
      version: report.version,
      claim_scope: report.claim_scope,
      judge_kind: report.judge_kind,
      rows_compared: report.rows_compared,
      baseline_method: report.baseline_method,
      best_method: report.best_method,
      gate: report.gate,
      ranked_methods: report.ranked_methods,
    }, null, 2));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
  process.exitCode = report.ok ? (report.gate && report.gate.pass ? 0 : 1) : 2;
}

main().catch((e) => {
  console.error(`distill-method-bakeoff failed: ${e && e.message ? e.message : e}`);
  process.exitCode = 2;
});
