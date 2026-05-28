#!/usr/bin/env node
// scripts/trinity-2000-v2-run.mjs
//
// One-shot orchestrator for Trinity 2000 v2. Runs in 5 phases:
//
//   1. seed-gen   ->  2000 seeds via Claude (skipped if seeds.jsonl already has 2000)
//   2. split      ->  3 phase files (claude/gpt4o/deepseek) preserving per-bucket dist
//   3. collect    ->  3 teacher phases via kolm distill --local-worker --mode=collect
//                     (auto-skips DeepSeek phase if teacher-server isn't reachable)
//   4. merge      ->  trinity-2000-v2-2026-05-28/merged/training-pairs.jsonl
//   5. train      ->  QLoRA on merged pairs via train_lora.py
//                     (skipped if --no-train; runs in foreground, logs to train.log)
//
// All phases are idempotent — re-running picks up where it left off.
// Failures in any phase exit nonzero with the phase name in the message.
//
// Usage:
//   node scripts/trinity-2000-v2-run.mjs                 # full pipeline
//   node scripts/trinity-2000-v2-run.mjs --no-train      # data only
//   node scripts/trinity-2000-v2-run.mjs --phase=collect # one phase
//   node scripts/trinity-2000-v2-run.mjs --skip-deepseek # skip the local 32B phase

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { mineFromTeacherFiles, writePreferencePairs, trainPreference } from '../src/distill-preference.js';

const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) args[m[1]] = m[2] === undefined ? true : m[2];
}

const REPO = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]):/, '$1:'));
const SCRIPTS = path.join(REPO, 'scripts');
const KOLM = path.join(REPO, 'cli', 'kolm.js');
const RUN = path.join(os.homedir(), '.kolm', 'distill-runs', 'trinity-2000-v2-2026-05-28');
const SEEDS = path.join(RUN, 'seeds.jsonl');
const TARGET = 2000;

function step(name, fn) {
  if (args.phase && args.phase !== name) {
    console.log(`[run] skip ${name} (--phase=${args.phase})`);
    return;
  }
  console.log(`\n══════════ phase: ${name} ══════════`);
  const t0 = Date.now();
  fn();
  console.log(`[run] phase ${name} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

function countLines(p) {
  if (!fs.existsSync(p)) return 0;
  return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).length;
}

function exec(cmd, argv, extraEnv) {
  const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
  const r = spawnSync(cmd, argv, { stdio: 'inherit', shell: false, env });
  if (r.status !== 0) {
    console.error(`[run] ${cmd} ${argv.join(' ')} -> exit ${r.status}`);
    process.exit(r.status || 1);
  }
}

function _sha256OfFile(p) {
  if (!fs.existsSync(p)) return null;
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return 'sha256:' + h.digest('hex');
}

// T1.4 — collect the reproducibility envs the trainer will stamp into
// training-summary.json. Best-effort: missing values become null. Centralized
// here so a single read produces a consistent snapshot across all steps.
function _reproducibilityEnv() {
  let gitSha = null;
  try {
    const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' });
    if (r.status === 0) gitSha = (r.stdout || '').trim() || null;
  } catch { /* git not on PATH or not a repo */ }
  let kolmVersion = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf-8'));
    kolmVersion = pkg.version || null;
  } catch { /* ignore */ }
  const specPath = path.join(RUN, 'spec.json');
  const mergedPath = path.join(RUN, 'merged', 'training-pairs.jsonl');
  const scrubPath = path.join(REPO, 'workers', 'distill', 'scripts', 'scrub_think.py');
  const markersPath = path.join(REPO, 'workers', 'distill', 'scripts', 'cot_markers.json');
  // Recipe hash includes spec + scrubber + markers — anything that changes
  // training data semantics should invalidate the hash.
  const recipeMaterial = [specPath, scrubPath, markersPath]
    .map(_sha256OfFile)
    .filter(Boolean)
    .join('|');
  const recipeHash = recipeMaterial
    ? 'sha256:' + crypto.createHash('sha256').update(recipeMaterial).digest('hex')
    : null;
  return {
    KOLM_GIT_SHA: gitSha || '',
    KOLM_RECIPE_HASH: recipeHash || '',
    KOLM_RECIPE_NAME: 'trinity-2000-v2',
    KOLM_SCRUBBER_VERSION: _sha256OfFile(scrubPath) || '',
    KOLM_PAIRS_HASH: _sha256OfFile(mergedPath) || '',
    KOLM_VERSION: kolmVersion || '',
  };
}

// T1.1 — preflight library-version gate. Catches transformers/peft/bnb API
// drift before any teacher spend. Exits the pipeline with the python process's
// exit code (0 ok, 10 drift). Skippable with --no-preflight.
step('preflight', () => {
  if (args['no-preflight']) {
    console.log('[run] --no-preflight set; skipping library-version gate');
    return;
  }
  const trainer = path.join(REPO, 'workers', 'distill', 'scripts', 'train_lora.py');
  const pythonBin = process.env.KOLM_PYTHON || 'python';
  exec(pythonBin, [trainer, '--preflight-only']);
});

step('seeds', () => {
  const have = countLines(SEEDS);
  if (have >= TARGET) {
    console.log(`[run] seeds already have ${have}/${TARGET} rows -> skip`);
    return;
  }
  console.log(`[run] generating seeds (${have}/${TARGET}) — this calls Claude via /v1/teacher/chat`);
  exec(process.execPath, [path.join(SCRIPTS, 'trinity-2000-v2-seed-gen.mjs')]);
});

step('split', () => {
  exec(process.execPath, [path.join(SCRIPTS, 'trinity-2000-v2-split-seeds.mjs')]);
});

step('collect', () => {
  // collect-all is idempotent: per-phase counts are checked. If --skip-deepseek
  // is set we patch the script env so the local phase is skipped.
  if (args['skip-deepseek']) process.env.KOLM_SKIP_LOCAL_TEACHER = '1';
  exec(process.execPath, [path.join(SCRIPTS, 'trinity-2000-v2-collect-all.mjs')]);
});

// T1.5 — pre-train CoT contamination scan. Walks merged/training-pairs.jsonl
// and exits nonzero if any teacher_output trips a hard or 2+ soft markers.
// Catches the v1-thinkleak class of bug (DeepSeek-R1 chat template leaking
// </think> into the answer) BEFORE the trainer burns an hour of 5090.
// Skippable with --no-scan.
step('scan', () => {
  if (args['no-scan']) {
    console.log('[run] --no-scan set; skipping CoT contamination gate');
    return;
  }
  const merged = path.join(RUN, 'merged', 'training-pairs.jsonl');
  if (!fs.existsSync(merged)) {
    console.log(`[run] no merged pairs at ${merged} yet; nothing to scan`);
    return;
  }
  const evalScript = path.join(REPO, 'workers', 'distill', 'scripts', 'eval_adapter.py');
  const pythonBin = process.env.KOLM_PYTHON || 'python';
  exec(pythonBin, [evalScript, '--scan-text-only', '--pairs', merged, '--strict']);
});

// T2.1 — semantic near-dup dedup at merge time. Across teachers the same prompt
// often gets near-identical answers; those redundant pairs only slow the loss
// curve. Opt-in via --dedup (cosine > threshold = dup, higher-confidence teacher
// survives). Previews first, then rewrites merged/training-pairs.jsonl in place
// (original preserved as training-pairs.predupe.jsonl) so train/eval pick it up.
// nomic-embed-text-v1.5 by default; auto-falls back to an n-gram backend when
// the embedder model is absent. --dedup-preview-only reports without applying.
step('dedup', () => {
  if (!args.dedup) {
    console.log('[run] --dedup not set; skipping semantic dedup (pairs pass through unchanged)');
    return;
  }
  const merged = path.join(RUN, 'merged', 'training-pairs.jsonl');
  if (!fs.existsSync(merged)) {
    console.log(`[run] no merged pairs at ${merged} yet; nothing to dedup`);
    return;
  }
  const dedupScript = path.join(REPO, 'workers', 'distill', 'scripts', 'dedup_pairs.py');
  const pythonBin = process.env.KOLM_PYTHON || 'python';
  const threshold = String(args['dedup-threshold'] || '0.92');
  const embedder = String(args['dedup-embedder'] || 'nomic-embed-text-v1.5');
  const key = String(args['dedup-key'] || 'pair');
  const report = path.join(RUN, 'merged', 'dedup-report.json');
  const base = [
    dedupScript, '--pairs', merged, '--threshold', threshold,
    '--embedder', embedder, '--key', key,
    '--teacher-priority', 'claude,gpt4o,deepseek', '--report', report,
  ];
  // Always show the preview first (dry run) so the cut is visible before it lands.
  console.log('[run] dedup preview (no changes written yet):');
  exec(pythonBin, [...base, '--preview']);
  if (args['dedup-preview-only']) {
    console.log('[run] --dedup-preview-only set; leaving merged pairs untouched');
    return;
  }
  // Apply: write deduped sidecar, back up the original once, then swap in place.
  const deduped = path.join(RUN, 'merged', 'training-pairs.deduped.jsonl');
  exec(pythonBin, [...base, '--out', deduped]);
  const backup = path.join(RUN, 'merged', 'training-pairs.predupe.jsonl');
  if (!fs.existsSync(backup)) fs.copyFileSync(merged, backup);
  fs.copyFileSync(deduped, merged);
  const kept = countLines(merged);
  console.log(`[run] dedup applied: merged now ${kept} pairs (original kept at ${path.basename(backup)})`);
});

step('train', () => {
  if (args['no-train']) {
    console.log('[run] --no-train set; data pipeline complete, exiting before training');
    return;
  }
  const merged = path.join(RUN, 'merged', 'training-pairs.jsonl');
  if (!fs.existsSync(merged)) {
    console.error(`[run] merged training pairs missing: ${merged}`);
    process.exit(3);
  }
  const have = countLines(merged);
  console.log(`[run] training on ${have} merged pairs`);
  const spec = JSON.parse(fs.readFileSync(path.join(RUN, 'spec.json'), 'utf-8'));
  const trainer = path.join(REPO, 'workers', 'distill', 'scripts', 'train_lora.py');
  const outDir = path.join(RUN, 'student');
  const argv = [
    trainer,
    '--pairs', merged,
    '--out', outDir,
    '--student-base', spec.student_base,
    '--epochs', String(spec.epochs),
    '--batch-size', String(spec.batch_size),
    '--gradient-accumulation-steps', String(spec.gradient_accumulation_steps),
    '--lr', String(spec.lr),
    '--max-seq-len', String(spec.max_seq_len),
    '--lora-r', String(spec.lora.r),
    '--lora-alpha', String(spec.lora.alpha),
    '--lora-dropout', String(spec.lora.dropout),
    '--warmup-ratio', String(spec.warmup_ratio),
    '--max-grad-norm', String(spec.max_grad_norm),
    '--val-fraction', String(spec.val_fraction),
    '--eval-steps', String(spec.eval_steps),
    '--save-steps', String(spec.save_steps),
    '--save-total-limit', String(spec.save_total_limit),
  ];
  if (spec.distillation_method === 'qlora') argv.push('--qlora');
  // Resume support — if a checkpoint-N dir already exists under outDir, use it.
  if (fs.existsSync(outDir)) {
    const checkpoints = fs.readdirSync(outDir)
      .filter((n) => /^checkpoint-\d+$/.test(n))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    if (checkpoints.length > 0) {
      const resumeAt = path.join(outDir, checkpoints[0]);
      console.log(`[run] resuming from ${resumeAt}`);
      argv.push('--resume-from-checkpoint', resumeAt);
    }
  }
  const pythonBin = process.env.KOLM_PYTHON || 'python';
  // T1.4 — stamp reproducibility envs so train_lora.py writes them into
  // training-summary.json. Recomputed at the train step so a fresh merged
  // file (e.g. after a collect rerun) gets its current hash.
  exec(pythonBin, argv, _reproducibilityEnv());
});

// T1.5 — post-train regression gate. Loads the just-trained adapter and
// generates --n holdout completions; trips on any CoT contamination in the
// student's actual outputs. This is the gate that would have caught the
// v1-thinkleak student before the post-hoc eyeball discovered it.
// Skippable with --no-eval.
step('eval', () => {
  if (args['no-eval'] || args['no-train']) {
    if (args['no-eval']) console.log('[run] --no-eval set; skipping inference-side regression gate');
    return;
  }
  const merged = path.join(RUN, 'merged', 'training-pairs.jsonl');
  const adapter = path.join(RUN, 'student');
  if (!fs.existsSync(adapter)) {
    console.log(`[run] no student adapter at ${adapter}; skipping eval`);
    return;
  }
  const spec = JSON.parse(fs.readFileSync(path.join(RUN, 'spec.json'), 'utf-8'));
  const evalScript = path.join(REPO, 'workers', 'distill', 'scripts', 'eval_adapter.py');
  const pythonBin = process.env.KOLM_PYTHON || 'python';
  const outPath = path.join(adapter, 'eval-strict-20.jsonl');
  const evalArgv = [
    evalScript,
    '--adapter', adapter,
    '--pairs', merged,
    '--base', spec.student_base,
    '--n', String(args['eval-n'] || 20),
    '--strict',
    '--out', outPath,
  ];
  if (spec.distillation_method === 'qlora') evalArgv.push('--qlora');
  exec(pythonBin, evalArgv);
});

// T2.3 — council-disagreement preference mining + optional SimPO alignment.
// Where 2+ teachers answered the same prompt differently, that disagreement
// is free preference data (the answers were already paid for at collect time).
// Always mines + writes merged/preference-pairs.jsonl; runs SimPO on the SFT
// adapter only when $KOLM_PREFERENCE_TRAINER is wired. SimPO needs no reference
// model, so no doubled VRAM. Skippable with --no-align.
step('align', () => {
  if (args['no-align']) {
    console.log('[run] --no-align set; skipping preference mining');
    return;
  }
  // Discover per-teacher collected files (claude/, gpt4o/, deepseek/, ...),
  // tagging teacher by directory name. Adapts to --skip-deepseek automatically.
  const specs = [];
  for (const name of fs.existsSync(RUN) ? fs.readdirSync(RUN) : []) {
    const p = path.join(RUN, name, 'training-pairs.jsonl');
    if (name !== 'merged' && fs.existsSync(p)) specs.push({ path: p, teacher: name });
  }
  if (specs.length < 2) {
    console.log(`[run] align: need >=2 teacher files to mine disagreement; found ${specs.length} -> skip`);
    return;
  }
  const mined = mineFromTeacherFiles(specs, { minMargin: Number(args['align-min-margin'] || 0) });
  const prefPath = path.join(RUN, 'merged', 'preference-pairs.jsonl');
  const w = writePreferencePairs(mined.pairs, prefPath);
  console.log(`[run] align: mined ${mined.stats.emitted} preference pairs from ${specs.length} teachers `
    + `(${mined.stats.eligible_groups}/${mined.stats.groups} prompts disagreed, basis=${mined.basis})`);
  console.log(`[run] align: wrote ${w.count} pairs -> ${prefPath}`);

  const adapter = path.join(RUN, 'student');
  if (args['no-train'] || !fs.existsSync(adapter)) {
    console.log('[run] align: no student adapter (or --no-train); pairs file ready, alignment training deferred');
    return;
  }
  if (!process.env.KOLM_PREFERENCE_TRAINER) {
    console.log('[run] align: $KOLM_PREFERENCE_TRAINER not set; alignment training deferred (pairs file ready)');
    return;
  }
  const outDir = path.join(RUN, 'student-aligned');
  const res = trainPreference({
    pairsPath: prefPath,
    studentPath: adapter,
    objective: args['align-objective'] || 'simpo',
    outDir,
  });
  if (!res.ok) {
    console.error(`[run] align: preference trainer failed: ${res.error}`);
    process.exit(res.exit_code || 1);
  }
  console.log(`[run] align: ${res.objective} adapter -> ${res.run_dir}`);
});

console.log('\n[run] trinity-2000-v2 pipeline finished.');
console.log(`[run] artifacts under ${RUN}`);
console.log('  seeds.jsonl                      (2000 prompts)');
console.log('  seeds-claude / gpt4o / deepseek  (phase splits)');
console.log('  claude / gpt4o / deepseek        (training pairs per teacher)');
console.log('  merged/training-pairs.jsonl      (combined 2000 rows)');
console.log('  student/                         (LoRA adapter + training-summary.json)');
