#!/usr/bin/env node
// scripts/trinity-2000-v2-monitor.mjs
//
// Print a one-line status for each Trinity 2000 v2 artifact, with ETA
// estimates pulled from the per-phase log timestamps. Safe to run any time —
// pure-read; never touches the run files.
//
// Usage:
//   node scripts/trinity-2000-v2-monitor.mjs
//   node scripts/trinity-2000-v2-monitor.mjs --watch     # refresh every 10s

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const RUN = path.join(os.homedir(), '.kolm', 'distill-runs', 'trinity-2000-v2-2026-05-28');
const WATCH = process.argv.includes('--watch');
const TARGETS = { claude: 800, gpt4o: 600, deepseek: 600 };
const SEED_TARGET = 2000;

function countLines(p) {
  if (!fs.existsSync(p)) return 0;
  return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).length;
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function fileAgeSec(p) {
  try { return (Date.now() - fs.statSync(p).mtimeMs) / 1000; } catch { return null; }
}

function snapshot() {
  console.clear();
  const now = new Date().toISOString();
  console.log(`Trinity 2000 v2 monitor — ${now}`);
  console.log(`run: ${RUN}`);
  console.log('');

  // 1. Seeds
  const seedsPath = path.join(RUN, 'seeds.jsonl');
  const seedN = countLines(seedsPath);
  const seedAge = fileAgeSec(seedsPath);
  const seedBar = bar(seedN, SEED_TARGET);
  console.log(`seeds.jsonl              ${seedBar} ${pad(seedN, 4)}/${SEED_TARGET}  (touched ${seedAge !== null ? Math.floor(seedAge) + 's ago' : 'n/a'})`);

  // 2. Phase splits
  for (const phase of ['claude', 'gpt4o', 'deepseek']) {
    const splitPath = path.join(RUN, `seeds-${phase}.jsonl`);
    const n = countLines(splitPath);
    console.log(`  seeds-${phase}${' '.repeat(13 - phase.length)} ${pad(n, 4)}`);
  }

  // 3. Per-phase collected pairs
  console.log('');
  for (const phase of ['claude', 'gpt4o', 'deepseek']) {
    const pairs = path.join(RUN, phase, 'training-pairs.jsonl');
    const n = countLines(pairs);
    const target = TARGETS[phase];
    const b = bar(n, target);
    const age = fileAgeSec(pairs);
    console.log(`${phase}/training-pairs ${b} ${pad(n, 4)}/${target}  (touched ${age !== null ? Math.floor(age) + 's ago' : 'n/a'})`);
  }

  // 4. Merged
  const merged = path.join(RUN, 'merged', 'training-pairs.jsonl');
  const mn = countLines(merged);
  console.log(`merged/training-pairs    ${bar(mn, SEED_TARGET)} ${pad(mn, 4)}/${SEED_TARGET}`);

  // 5. Student artifact
  const studentDir = path.join(RUN, 'student');
  if (fs.existsSync(studentDir)) {
    const items = fs.readdirSync(studentDir);
    const ckpts = items.filter((n) => /^checkpoint-\d+$/.test(n)).sort();
    const sumPath = path.join(studentDir, 'training-summary.json');
    const hasSummary = fs.existsSync(sumPath);
    const adapterPath = path.join(studentDir, 'adapter_model.safetensors');
    const hasAdapter = fs.existsSync(adapterPath);
    console.log('');
    console.log(`student/                 checkpoints=${ckpts.length}  adapter=${hasAdapter ? 'yes' : 'no'}  summary=${hasSummary ? 'yes' : 'no'}`);
    if (ckpts.length > 0) console.log(`  latest: ${ckpts[ckpts.length - 1]}`);
    if (hasSummary) {
      try {
        const sum = JSON.parse(fs.readFileSync(sumPath, 'utf-8'));
        console.log(`  pairs=${sum.pairs}  epochs=${sum.epochs}  eff_bs=${sum.massive ? sum.massive.effective_batch_size : '?'}  qlora=${sum.massive ? sum.massive.qlora : '?'}  val=${sum.massive ? sum.massive.val_rows : '?'}`);
      } catch { /* ignore */ }
    }
  }

  if (WATCH) {
    console.log('\n(--watch active; refresh in 10s; Ctrl+C to stop)');
  }
}

function bar(n, target) {
  const W = 20;
  const filled = Math.min(W, Math.floor((n / Math.max(1, target)) * W));
  return '[' + '█'.repeat(filled) + '·'.repeat(W - filled) + ']';
}
function pad(s, n) { return String(s).padStart(n, ' '); }

snapshot();
if (WATCH) {
  setInterval(snapshot, 10_000);
}
