// W727-3 — student-as-draft speculative-decoding acceleration bench.
//
// Runs benchAcceptanceRate(task_class, samples) for each of the three
// task classes called out in KOLM_W707_SYSTEM_UPGRADE_PLAN.md W727-3:
//
//   extraction  — high local redundancy → high acceptance is expected
//   generation  — medium dependency length → middling acceptance
//   reasoning   — long dependency length → the hardest case
//
// Acceptance criterion (honest baselines, calibrated to the public
// Leviathan/Chen literature on speculative decoding):
//
//   extraction acceptance_rate >= 0.60
//   generation acceptance_rate >= 0.40
//   reasoning  acceptance_rate >= 0.30
//
// HONESTY: this is a SYNTHETIC bench when no real speculative-decoding
// backend is wired. Without KOLM_SPEC_DECODE_BACKEND set, every row will
// be a `no_kernel` envelope and the bench will EXIT 0 with skipped:true on
// each row — the orchestrator promised "if backend missing, skip" so this
// is the honest path. With a real backend wired via the in-process bridge
// in src/router.js (production), the numbers are real per-class means.
//
// CLI:
//   node bench/wave727-acceleration-bench.js                # human table
//   node bench/wave727-acceleration-bench.js --json         # JSON only
//   node bench/wave727-acceleration-bench.js --samples 50   # default 20

import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  ACCELERATE_VERSION,
  TASK_CLASSES,
  BASELINES,
  benchAcceptanceRate,
} from '../src/accelerate.js';

function _parseArgs(argv) {
  const out = { json: false, samples: 20 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--samples' && i + 1 < argv.length) {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) out.samples = Math.floor(n);
      i += 1;
    } else if (a === '--task-class' && i + 1 < argv.length) {
      out.task_class = String(argv[i + 1] || '').trim().toLowerCase();
      i += 1;
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    }
  }
  return out;
}

function _printHelp() {
  // eslint-disable-next-line no-console
  console.log([
    'wave727-acceleration-bench.js — student-as-draft speculative-decoding bench',
    '',
    'Usage: node bench/wave727-acceleration-bench.js [--json] [--samples N]',
    '                                                 [--task-class extraction|generation|reasoning]',
    '',
    '  --json              Print JSON only (machine-parseable).',
    '  --samples N         Number of samples per task class (default 20).',
    '  --task-class STR    Run only this task class instead of all three.',
    '  --help, -h          This help.',
    '',
    'Honest fallback: when KOLM_SPEC_DECODE_BACKEND is not set, every row',
    'reports {skipped:true, reason:"no_kernel"}; the bench still exits 0.',
  ].join('\n'));
}

/**
 * Run the W727 bench across the three task classes. Returns a single
 * envelope keyed by task_class so the JSON output is stable for
 * downstream observability.
 */
export async function runBench({ samples = 20, task_class = null } = {}) {
  const classes = task_class ? [task_class] : TASK_CLASSES.slice();
  const results = {};
  let anyOk = false;
  let allMeetBaseline = true;
  for (const tc of classes) {
    const r = await benchAcceptanceRate({ task_class: tc, samples });
    if (r.ok === false) {
      results[tc] = {
        task_class: tc,
        skipped: true,
        reason: r.error,
        hint: r.hint,
        baseline_floor: BASELINES[tc],
      };
      // skipped does NOT count as "meets baseline" but it also doesn't
      // count as a baseline failure — it's an honest "no backend wired".
      continue;
    }
    anyOk = true;
    if (!r.meets_baseline) allMeetBaseline = false;
    results[tc] = {
      task_class: tc,
      skipped: false,
      mean_acceptance_rate: r.mean_acceptance_rate,
      mean_tokens_per_draft_round: r.mean_tokens_per_draft_round,
      mean_speedup_x: r.mean_speedup_x,
      mean_wall_clock_ms: r.mean_wall_clock_ms,
      baseline_floor: r.baseline_floor,
      meets_baseline: r.meets_baseline,
      samples: r.samples,
    };
  }
  return {
    ok: true,
    version: ACCELERATE_VERSION,
    samples_per_class: samples,
    any_class_ran: anyOk,
    all_classes_meet_baseline: anyOk ? allMeetBaseline : null,
    by_task_class: results,
  };
}

function _humanReport(report) {
  const header = 'W727 student-as-draft acceleration bench  (' + report.version + ')';
  const rule = '-'.repeat(header.length);
  const lines = [header, rule];
  lines.push(`samples_per_class: ${report.samples_per_class}`);
  lines.push(`any_class_ran:     ${report.any_class_ran}`);
  if (report.any_class_ran) {
    lines.push(`all_meet_baseline: ${report.all_classes_meet_baseline}`);
  } else {
    lines.push('all_meet_baseline: (skipped — no backend wired; set KOLM_SPEC_DECODE_BACKEND)');
  }
  lines.push('');
  // Table header. Column widths chosen to fit a typical terminal.
  lines.push('task_class    | mean_acceptance_rate | mean_speedup_x | n_samples | baseline | meets?');
  lines.push('--------------|----------------------|----------------|-----------|----------|-------');
  for (const tc of Object.keys(report.by_task_class)) {
    const r = report.by_task_class[tc];
    if (r.skipped) {
      lines.push(
        `${tc.padEnd(13)} | ${('SKIPPED: ' + r.reason).padEnd(20)} | ${'(n/a)'.padEnd(14)} | ${'0'.padEnd(9)} | ${String(r.baseline_floor).padEnd(8)} | (n/a)`,
      );
      continue;
    }
    lines.push(
      `${tc.padEnd(13)} | ${String(r.mean_acceptance_rate).padEnd(20)} | ${String(r.mean_speedup_x).padEnd(14)} | ${String(r.samples).padEnd(9)} | ${String(r.baseline_floor).padEnd(8)} | ${r.meets_baseline ? 'YES' : 'no'}`,
    );
  }
  return lines.join('\n');
}

async function _main() {
  const args = _parseArgs(process.argv.slice(2));
  if (args.help) {
    _printHelp();
    process.exit(0);
  }
  if (args.task_class && !TASK_CLASSES.includes(args.task_class)) {
    // eslint-disable-next-line no-console
    console.error(`error: --task-class must be one of ${TASK_CLASSES.join('|')}; got ${JSON.stringify(args.task_class)}`);
    process.exit(1);
  }
  const report = await runBench({ samples: args.samples, task_class: args.task_class || null });
  if (args.json) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));
  } else {
    // eslint-disable-next-line no-console
    console.log(_humanReport(report));
  }
  // Honest exit semantics: exit 0 even when skipped (no backend wired is
  // not a bench failure — it's an honest "operator hasn't configured the
  // backend yet"). Exit 2 only when a class actually RAN and did NOT meet
  // baseline (a real regression signal).
  if (report.any_class_ran && report.all_classes_meet_baseline === false) {
    process.exit(2);
  }
  process.exit(0);
}

const __filename = fileURLToPath(import.meta.url);
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (invokedDirectly) _main();
