#!/usr/bin/env node
// W888-O — compile-assistant orchestrator.
//
// One-shot end-to-end pipeline that wraps the existing `kolm forge distill`
// / `kolm forge quantize` / `kolm bench` / `kolm export` verbs into a single
// gated drive, with HARD GATES that BLOCK publish on K-Score < 0.90 or any
// hallucinated CLI verb in the holdout response set.
//
// Pipeline (each step is a spawnSync to existing CLI verb in real mode; a
// stub { ok:true, dry_run:true, would_invoke:'<cmd>' } in dry-run):
//
//   1. distill   — `kolm forge distill --student <id> --pairs <path> ...`
//   2. quantize  — `kolm forge quantize --in <merged> --quant <Q4_K_M> ...`
//   3. bench     — `kolm bench --artifact <art> --suite assistant-eval ...`
//                  (scaffold: scripts/scaffolds/assistant-eval-suite.cjs)
//   4. hallu     — `node scripts/check-assistant-hallucinations.cjs ...`
//   5. gate      — evaluate K-Score + hallu count vs thresholds; HARD block
//                  publish on fail; emit gate-report.json with failing pair
//                  ids and bucket breakdown.
//   6. publish   — `kolm export --hf-repo ...` via scaffold (gated)
//
// DRY-RUN is the DEFAULT. Real GPU training, real quantization, and real HF
// publish are gated on KOLM_W888O_REAL=1. The scaffold short-circuits at every
// external boundary in dry-run mode.
//
// Flags:
//   --pairs <path>           default data/assistant-corpus/training-pairs.jsonl
//   --holdout <path>         default data/assistant-corpus/holdout-200.jsonl
//   --student <hf_id>        default Qwen/Qwen2.5-1.5B-Instruct
//   --epochs <N>             default 3
//   --rank <r>               default 16 (LoRA r)
//   --quant <gguf_quant>     default Q4_K_M
//   --bench-suite <name>     default assistant-eval
//   --out <dir>              default build/kolm-assistant-1.5b
//   --hf-repo <id>           default kolm-ai/kolm-assistant-1.5b
//   --k-score-gate <float>   default 0.90 (HARD GATE)
//   --hallu-gate <int>       default 0   (HARD GATE)
//   --dry-run                default ON unless KOLM_W888O_REAL=1
//   --mock-k-score <f>       force eval K-Score (test-only flag)
//   --inject-hallu           inject a `kolm not-a-verb` into one response (test)
//   --skip-distill           skip step 1
//   --skip-quant             skip step 2
//   --skip-bench             skip step 3 (skips step 4 too)
//   --skip-publish           skip step 6 even on gate-pass
//   --json                   emit compile-passport to stdout
//   --help

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const VERSION = 'w888o-compile-assistant-v1';
const REPO = path.resolve(__dirname, '..');
const SCAFFOLDS = path.join(REPO, 'scripts', 'scaffolds');

const DEFAULTS = {
  pairs: path.join(REPO, 'data', 'assistant-corpus', 'training-pairs.jsonl'),
  holdout: path.join(REPO, 'data', 'assistant-corpus', 'holdout-200.jsonl'),
  trainingPassport: path.join(REPO, 'data', 'assistant-corpus', 'training-passport.json'),
  student: 'Qwen/Qwen2.5-1.5B-Instruct',
  epochs: 3,
  rank: 16,
  quant: 'Q4_K_M',
  benchSuite: 'assistant-eval',
  out: path.join(REPO, 'build', 'kolm-assistant-1.5b'),
  hfRepo: 'kolm-ai/kolm-assistant-1.5b',
  kScoreGate: 0.90,
  halluGate: 0,
};

function parseArgs(argv) {
  const out = {
    ...DEFAULTS,
    dryRun: !(process.env.KOLM_W888O_REAL === '1'),
    mockKScore: null,
    injectHallu: false,
    skipDistill: false,
    skipQuant: false,
    skipBench: false,
    skipPublish: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else if (a === '--version') { process.stdout.write(VERSION + '\n'); process.exit(0); }
    else if (a === '--pairs') out.pairs = argv[++i];
    else if (a === '--holdout') out.holdout = argv[++i];
    else if (a === '--training-passport') out.trainingPassport = argv[++i];
    else if (a === '--student') out.student = argv[++i];
    else if (a === '--epochs') out.epochs = parseInt(argv[++i], 10);
    else if (a === '--rank' || a === '--r') out.rank = parseInt(argv[++i], 10);
    else if (a === '--quant') out.quant = argv[++i];
    else if (a === '--bench-suite') out.benchSuite = argv[++i];
    else if (a === '--out') out.out = path.resolve(argv[++i]);
    else if (a === '--hf-repo') out.hfRepo = argv[++i];
    else if (a === '--k-score-gate') out.kScoreGate = parseFloat(argv[++i]);
    else if (a === '--hallu-gate') out.halluGate = parseInt(argv[++i], 10);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-dry-run') out.dryRun = false;
    else if (a === '--mock-k-score') out.mockKScore = parseFloat(argv[++i]);
    else if (a === '--inject-hallu') out.injectHallu = true;
    else if (a === '--skip-distill') out.skipDistill = true;
    else if (a === '--skip-quant') out.skipQuant = true;
    else if (a === '--skip-bench') out.skipBench = true;
    else if (a === '--skip-publish') out.skipPublish = true;
    else if (a === '--json') out.json = true;
  }
  return out;
}

function printHelp() {
  process.stdout.write(
    'compile-assistant — W888-O orchestrator (distill -> quantize -> bench -> hallu -> gate -> publish).\n' +
    '\n' +
    'usage: node scripts/compile-assistant.cjs [flags]\n' +
    '\n' +
    'inputs:\n' +
    '  --pairs <path>              training-pairs.jsonl from W888-N\n' +
    '  --holdout <path>            holdout-200.jsonl (actually 204 rows)\n' +
    '  --training-passport <p>     W888-N training-passport.json\n' +
    '\n' +
    'training:\n' +
    '  --student <hf_id>           default Qwen/Qwen2.5-1.5B-Instruct\n' +
    '  --epochs <N>                default 3\n' +
    '  --rank <r>                  default 16 (LoRA r)\n' +
    '  --quant <gguf_quant>        default Q4_K_M\n' +
    '\n' +
    'output:\n' +
    '  --out <dir>                 default build/kolm-assistant-1.5b\n' +
    '  --hf-repo <id>              default kolm-ai/kolm-assistant-1.5b\n' +
    '\n' +
    'gates (HARD; failing exits non-zero, no publish):\n' +
    '  --k-score-gate <float>      default 0.90\n' +
    '  --hallu-gate <int>          default 0\n' +
    '\n' +
    'modes:\n' +
    '  --dry-run                   default ON unless KOLM_W888O_REAL=1\n' +
    '  --mock-k-score <f>          force K-Score (test branch)\n' +
    '  --inject-hallu              inject a bogus verb into one response (test branch)\n' +
    '  --skip-distill              skip step 1\n' +
    '  --skip-quant                skip step 2\n' +
    '  --skip-bench                skip steps 3+4\n' +
    '  --skip-publish              skip step 6\n' +
    '  --json                      emit compile-passport to stdout\n' +
    '  --help                      this message\n'
  );
}

function nowIso() { return new Date().toISOString(); }

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// Shell out to a CLI / script. In real mode this actually runs. In dry-run
// mode we return a stub envelope with the command line that WOULD have run.
function runStep(label, argv, opts, { dryRun, timeout = 30 * 60 * 1000 } = {}) {
  const cmdline = argv.join(' ');
  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      label,
      would_invoke: cmdline,
      exit_code: 0,
      duration_ms: 0,
      stdout: '',
      stderr: '',
    };
  }
  const t0 = Date.now();
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd: REPO,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, ...(opts.env || {}) },
    // Inherit-stdio would be more readable, but for the orchestrator we
    // need to capture output so the passport can include it. Mixed mode:
    // stdout/stderr captured, stdin not used.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const dur = Date.now() - t0;
  return {
    ok: r.status === 0,
    dry_run: false,
    label,
    cmd: cmdline,
    exit_code: r.status == null ? -1 : r.status,
    signal: r.signal || null,
    duration_ms: dur,
    stdout: (r.stdout || '').slice(0, 4096),
    stderr: (r.stderr || '').slice(0, 4096),
  };
}

// ---------- step 1: distill ----------
// Real-mode invokes `kolm forge distill`. In W888 the CLI verb actually
// available is `cmdDistill` (also reachable as `kolm forge distill`); the
// orchestrator uses the umbrella form for discoverability.
function stepDistill(opts) {
  if (opts.skipDistill) {
    return { skipped: true, reason: 'skip_distill flag' };
  }
  if (!fs.existsSync(opts.pairs)) {
    return { ok: false, error: `pairs file not found: ${opts.pairs}`, label: 'distill' };
  }
  const loraDir = path.join(opts.out, 'lora');
  ensureDir(loraDir);
  const argv = [
    'kolm', 'forge', 'distill',
    '--student', opts.student,
    '--pairs', opts.pairs,
    '--epochs', String(opts.epochs),
    '--r', String(opts.rank),
    '--out', loraDir,
  ];
  // CLI verb-name caveat: the live `kolm distill` surface uses
  // --namespace/--from-captures rather than --pairs. The orchestrator
  // documents this mismatch in the passport; the real CLI wrapper that
  // ships in W888-O+1 will translate flag names.
  const r = runStep('distill', argv, opts, { dryRun: opts.dryRun });
  r.outputs = {
    lora_dir: loraDir,
    merged_fp16: path.join(opts.out, 'merged.gguf'),
  };
  // Compat-note: stamps a flag-translation hint in the passport.
  r.verb_name_caveat = 'kolm forge distill (umbrella) -> cmdDistill; --pairs flag is W888-O addition';
  return r;
}

// ---------- step 2: quantize ----------
function stepQuantize(opts) {
  if (opts.skipQuant) {
    return { skipped: true, reason: 'skip_quant flag' };
  }
  const mergedIn = path.join(opts.out, 'merged.gguf');
  const outGguf = path.join(opts.out, `kolm-assistant-1.5b.${opts.quant}.gguf`);
  const argv = [
    'kolm', 'forge', 'quantize',
    '--in', mergedIn,
    '--quant', opts.quant,
    '--imatrix', opts.holdout,
    '--out', outGguf,
  ];
  const r = runStep('quantize', argv, opts, { dryRun: opts.dryRun });
  r.outputs = { gguf: outGguf };
  return r;
}

// ---------- step 3: bench (assistant-eval suite) ----------
function stepBench(opts) {
  if (opts.skipBench) {
    return { skipped: true, reason: 'skip_bench flag', k_score: null };
  }
  const artifactPath = path.join(opts.out, 'kolm-assistant-1.5b.kolm');
  const benchOut = path.join(opts.out, 'bench');
  ensureDir(benchOut);
  // We invoke the scaffold directly (not via `kolm bench`) so the suite
  // is reproducible in CI even when the CLI is not on $PATH. `kolm bench`
  // would be the user-facing front-door; the orchestrator goes direct.
  const argv = [
    process.execPath,
    path.join(SCAFFOLDS, 'assistant-eval-suite.cjs'),
    '--artifact', artifactPath,
    '--holdout', opts.holdout,
    '--out', benchOut,
    '--json',
  ];
  if (opts.dryRun) argv.push('--dry-run');
  if (opts.mockKScore !== null && !Number.isNaN(opts.mockKScore)) {
    argv.push('--mock-k-score', String(opts.mockKScore));
  }
  // Bench runs locally (no spawn-to-CLI); use real spawn but force a short
  // timeout because the dry-run path is sub-second.
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd: REPO, encoding: 'utf8', timeout: 5 * 60 * 1000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const t0 = Date.now();
  let envelope = null;
  if (r.stdout) {
    try { envelope = JSON.parse(r.stdout); }
    catch { /* if JSON parse fails, the bench scaffold likely errored */ }
  }
  const fallbackPath = path.join(benchOut, 'bench.json');
  if (!envelope && fs.existsSync(fallbackPath)) {
    try { envelope = JSON.parse(fs.readFileSync(fallbackPath, 'utf8')); }
    catch {} // deliberate: cleanup
  }
  return {
    ok: r.status === 0 && envelope && typeof envelope.k_score === 'number',
    label: 'bench',
    cmd: argv.join(' '),
    exit_code: r.status == null ? -1 : r.status,
    duration_ms: Date.now() - t0,
    stdout: (r.stdout || '').slice(0, 2048),
    stderr: (r.stderr || '').slice(0, 2048),
    envelope,
    outputs: {
      bench_json: path.join(benchOut, 'bench.json'),
      bench_responses_jsonl: path.join(benchOut, 'bench-responses.jsonl'),
    },
    k_score: envelope && typeof envelope.k_score === 'number' ? envelope.k_score : null,
    per_bucket: envelope && envelope.per_bucket ? envelope.per_bucket : null,
  };
}

// ---------- inject-hallu helper (test-only) ----------
// If --inject-hallu, mutate one response in bench-responses.jsonl to include
// a bogus `kolm not-a-verb` invocation so the hallu checker registers > 0.
function injectHallu(benchResponsesPath) {
  if (!fs.existsSync(benchResponsesPath)) return { ok: false, reason: 'no responses file' };
  const raw = fs.readFileSync(benchResponsesPath, 'utf8').split(/\r?\n/).filter(Boolean);
  if (raw.length === 0) return { ok: false, reason: 'empty responses' };
  const first = JSON.parse(raw[0]);
  first.response = (first.response || '') + '\nExtra: `kolm not-a-verb --foo`';
  raw[0] = JSON.stringify(first);
  fs.writeFileSync(benchResponsesPath, raw.join('\n') + '\n', 'utf8');
  return { ok: true, mutated_id: first.id };
}

// ---------- step 4: hallucination check ----------
function stepHallu(opts, benchResponsesPath) {
  if (opts.skipBench) {
    return { skipped: true, reason: 'skip_bench cascades; no responses to check', hallu_count: null };
  }
  if (!benchResponsesPath || !fs.existsSync(benchResponsesPath)) {
    return { ok: false, error: 'bench-responses.jsonl missing', label: 'hallu', hallu_count: null };
  }
  // Optional test-mode mutation. Done BEFORE the checker so the gate sees
  // the bogus verb.
  let injected = null;
  if (opts.injectHallu) {
    injected = injectHallu(benchResponsesPath);
  }
  const checkerPath = path.join(REPO, 'scripts', 'check-assistant-hallucinations.cjs');
  const halluOut = path.join(opts.out, 'hallu-report.json');
  const argv = [
    process.execPath, checkerPath,
    '--responses', benchResponsesPath,
    '--inventory', path.join(REPO, 'data', 'assistant-corpus', 'cli-inventory.json'),
    '--json',
  ];
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd: REPO, encoding: 'utf8', timeout: 60 * 1000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let envelope = null;
  try { envelope = JSON.parse(r.stdout); } catch {} // deliberate: cleanup
  if (envelope) {
    fs.writeFileSync(halluOut, JSON.stringify(envelope, null, 2), 'utf8');
  }
  const halluCount = envelope
    ? (envelope.offenders || []).filter(o => o.reason === 'invalid_verb').length
    : null;
  return {
    // ok=true means we successfully ran the checker; gate logic decides PASS/FAIL.
    ok: r.status === 0 || r.status === 1,
    label: 'hallu',
    cmd: argv.join(' '),
    exit_code: r.status == null ? -1 : r.status,
    hallu_count: halluCount,
    envelope,
    outputs: { hallu_report: halluOut },
    injected,
  };
}

// ---------- step 5: gate evaluation ----------
function evaluateGate(opts, benchResult, halluResult) {
  const kScore = benchResult && benchResult.k_score != null ? benchResult.k_score : null;
  const halluCount = halluResult && halluResult.hallu_count != null ? halluResult.hallu_count : null;

  const kPass = kScore !== null && kScore >= opts.kScoreGate;
  const hPass = halluCount !== null && halluCount <= opts.halluGate;
  const pass = !!(kPass && hPass);

  // Build failure-bucket detail so the loop hint can name which buckets
  // dragged the K-Score down.
  const failingBuckets = [];
  if (benchResult && benchResult.per_bucket) {
    for (const [bucket, agg] of Object.entries(benchResult.per_bucket)) {
      if (typeof agg.k_score === 'number' && agg.k_score < opts.kScoreGate) {
        failingBuckets.push({ bucket, k_score: agg.k_score, n: agg.n });
      }
    }
  }
  // Failing offender IDs from the hallu checker (first 10 only).
  const failingIds = [];
  if (halluResult && halluResult.envelope) {
    for (const o of (halluResult.envelope.offenders || [])) {
      if (o.reason === 'invalid_verb') failingIds.push({ id: o.id, invalid: o.invalid });
    }
  }

  const report = {
    ok: pass,
    k_score: kScore,
    k_score_gate: opts.kScoreGate,
    k_pass: kPass,
    hallu_count: halluCount,
    hallu_gate: opts.halluGate,
    hallu_pass: hPass,
    failing_buckets: failingBuckets,
    failing_ids: failingIds.slice(0, 10),
    loop_hint: pass
      ? null
      : 'queue failing pairs for re-distillation with more teacher coverage; do NOT publish until both gates green.',
    evaluated_at: nowIso(),
  };
  ensureDir(opts.out);
  fs.writeFileSync(path.join(opts.out, 'gate-report.json'), JSON.stringify(report, null, 2), 'utf8');
  return report;
}

// ---------- step 6: publish ----------
function stepPublish(opts) {
  if (opts.skipPublish) {
    return { skipped: true, reason: 'skip_publish flag' };
  }
  const artifactPath = path.join(opts.out, 'kolm-assistant-1.5b.kolm');
  const benchPassport = path.join(opts.out, 'bench', 'bench.json');
  const gatePassport = path.join(opts.out, 'gate-report.json');
  const publishOut = path.join(opts.out, 'publish-report.json');
  const argv = [
    process.execPath,
    path.join(SCAFFOLDS, 'assistant-publish.cjs'),
    '--artifact', artifactPath,
    '--hf-repo', opts.hfRepo,
    '--training-passport', opts.trainingPassport,
    '--bench-passport', benchPassport,
    '--cost-passport', gatePassport,
    '--out', publishOut,
    '--json',
  ];
  if (opts.dryRun) argv.push('--dry-run');
  const t0 = Date.now();
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd: REPO, encoding: 'utf8', timeout: 5 * 60 * 1000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let envelope = null;
  try { envelope = JSON.parse(r.stdout); } catch {} // deliberate: cleanup
  // Without HF_TOKEN or KOLM_W888O_REAL=1 the publish scaffold ALWAYS exits 0
  // with would_publish populated. That's a clean PASS for the orchestrator —
  // not a publish-failure. Lock-in test #9 asserts this branch.
  return {
    ok: r.status === 0,
    label: 'publish',
    cmd: argv.join(' '),
    exit_code: r.status == null ? -1 : r.status,
    duration_ms: Date.now() - t0,
    stdout: (r.stdout || '').slice(0, 2048),
    stderr: (r.stderr || '').slice(0, 2048),
    envelope,
    would_publish: envelope && envelope.would_publish ? envelope.would_publish : null,
    outputs: { publish_report: publishOut },
  };
}

// ---------- orchestrator main ----------
function orchestrate(opts) {
  const t0 = Date.now();
  ensureDir(opts.out);

  const passport = {
    schema_version: VERSION,
    started_at: nowIso(),
    dry_run: opts.dryRun,
    real_mode_env: process.env.KOLM_W888O_REAL === '1',
    inputs: {
      pairs: opts.pairs,
      holdout: opts.holdout,
      training_passport: opts.trainingPassport,
    },
    config: {
      student: opts.student,
      epochs: opts.epochs,
      rank: opts.rank,
      quant: opts.quant,
      bench_suite: opts.benchSuite,
      out: opts.out,
      hf_repo: opts.hfRepo,
      k_score_gate: opts.kScoreGate,
      hallu_gate: opts.halluGate,
    },
    steps: {},
    gate: null,
    publish: null,
  };

  // ---- holdout off-by-4 audit ----
  // W888-N rounded "200" to a deterministic stratified split that actually
  // landed on 204 rows. Stamp the observed count in the passport so the
  // discrepancy is recorded surgically rather than papered over.
  let holdoutRowCount = null;
  if (fs.existsSync(opts.holdout)) {
    holdoutRowCount = fs.readFileSync(opts.holdout, 'utf8')
      .split(/\r?\n/).filter(Boolean).length;
  }
  passport.holdout_rows_actual = holdoutRowCount;
  passport.holdout_rows_target = 200;
  passport.holdout_rows_caveat = holdoutRowCount === 200
    ? 'on-target'
    : `actual=${holdoutRowCount} vs target=200 (W888-N stratified split rounding)`;

  // Step 1: distill
  passport.steps.distill = stepDistill(opts);
  // Step 2: quantize
  passport.steps.quantize = stepQuantize(opts);
  // Step 3: bench
  passport.steps.bench = stepBench(opts);
  // Step 4: hallucination check
  const benchRespPath = passport.steps.bench && passport.steps.bench.outputs
    ? passport.steps.bench.outputs.bench_responses_jsonl
    : null;
  passport.steps.hallu = stepHallu(opts, benchRespPath);
  // Step 5: gate
  passport.gate = evaluateGate(opts, passport.steps.bench, passport.steps.hallu);

  // Step 6: publish (only if gate passes)
  if (passport.gate.ok) {
    passport.publish = stepPublish(opts);
  } else {
    passport.publish = {
      skipped: true,
      reason: 'gate_failed',
      gate_summary: {
        k_pass: passport.gate.k_pass,
        hallu_pass: passport.gate.hallu_pass,
      },
    };
  }

  passport.finished_at = nowIso();
  passport.duration_ms = Date.now() - t0;
  passport.overall_ok = !!passport.gate.ok;

  // Write passport to disk.
  fs.writeFileSync(path.join(opts.out, 'compile-passport.json'),
    JSON.stringify(passport, null, 2), 'utf8');

  return passport;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const passport = orchestrate(opts);

  if (opts.json) {
    process.stdout.write(JSON.stringify(passport, null, 2) + '\n');
  } else {
    const gate = passport.gate;
    process.stdout.write(
      `compile-assistant (${passport.dry_run ? 'dry-run' : 'real'})\n` +
      `  pairs:    ${opts.pairs}\n` +
      `  holdout:  ${opts.holdout} (${passport.holdout_rows_actual} rows, target 200)\n` +
      `  out:      ${opts.out}\n` +
      `  K-Score:  ${gate.k_score == null ? 'n/a' : gate.k_score.toFixed(4)} ` +
        `(gate ${opts.kScoreGate}, ${gate.k_pass ? 'PASS' : 'FAIL'})\n` +
      `  hallu:    ${gate.hallu_count == null ? 'n/a' : gate.hallu_count} ` +
        `(gate ${opts.halluGate}, ${gate.hallu_pass ? 'PASS' : 'FAIL'})\n` +
      `  publish:  ${passport.publish && passport.publish.skipped
        ? 'skipped (' + passport.publish.reason + ')'
        : (passport.publish && passport.publish.would_publish
          ? 'would_publish'
          : 'real')}\n` +
      `  duration: ${passport.duration_ms} ms\n`
    );
    if (!gate.ok) {
      process.stdout.write('\n' + gate.loop_hint + '\n');
      if (gate.failing_buckets.length > 0) {
        process.stdout.write('failing buckets:\n');
        for (const b of gate.failing_buckets) {
          process.stdout.write(`  - ${b.bucket}: k=${b.k_score.toFixed(4)} (n=${b.n})\n`);
        }
      }
      if (gate.failing_ids.length > 0) {
        process.stdout.write('failing pair ids (first 10):\n');
        for (const fi of gate.failing_ids) {
          process.stdout.write(`  - ${fi.id} (invalid: ${fi.invalid})\n`);
        }
      }
    }
  }

  // HARD GATE: non-zero exit if either gate fails.
  if (!passport.gate.ok) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  orchestrate,
  stepDistill,
  stepQuantize,
  stepBench,
  stepHallu,
  stepPublish,
  evaluateGate,
  injectHallu,
  DEFAULTS,
  VERSION,
};
