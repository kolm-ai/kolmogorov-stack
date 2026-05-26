#!/usr/bin/env node
// scripts/w889-1.5-trinity-publish.cjs
//
// W889-1.5 — Trinity-500 publish stub.
//
// Block 1.5 of the Master Completion Directive asks for an actual push to
// HuggingFace (`kolm-ai/trinity-500-support-7b`). The dry-run orchestrator
// at scripts/publish-trinity.cjs generates the README + publication manifest
// and prints the huggingface-cli commands to copy-paste — it never executes
// them. This stub is the executable bridge for when an operator has the
// KOLM_HF_TOKEN env var set and is ready to fire the push.
//
// Behaviour:
//   1. Verify KOLM_HF_TOKEN (or HF_TOKEN) is present. If missing, print a
//      clear message + exit non-zero. This is the gate the audit asserts.
//   2. Verify huggingface-cli is on PATH. If missing, print install hint
//      and exit non-zero.
//   3. Re-run the dry-run orchestrator to ensure README + manifest are
//      current.
//   4. With --confirm, execute the commands the dry-run printed. Without
//      --confirm, print the executable plan and exit 0 (safe default).
//
// Caveats / Constraints / Limitations:
//   - This script does NOT bypass git or push code. It only invokes
//     huggingface-cli with the operator's token.
//   - The dry-run orchestrator is still the source of truth for the
//     publication manifest. This script wraps it.
//   - Without --confirm, no network call ever fires; the script is safe
//     to invoke for plan inspection.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const DRY_RUN_ORCH = path.join(REPO, 'scripts', 'publish-trinity.cjs');

const HELP = `Usage: node scripts/w889-1.5-trinity-publish.cjs [options]

  Trinity-500 publish stub. Gates on KOLM_HF_TOKEN. Without --confirm it
  prints the executable plan only.

Options:
  --confirm              Actually invoke huggingface-cli (otherwise plan-only).
  --target-repo <slug>   HF repo slug. Default: kolm-ai/trinity-500-support-7b
  --license <id>         License id passed through to the dry-run orchestrator.
  --base-model <slug>    Base model passed through to the dry-run orchestrator.
  --artifact-dir <path>  Override artifact dir (passed through to dry-run).
  --help, -h             Print this message.

Environment:
  KOLM_HF_TOKEN          Required. HuggingFace API token with write scope.
                         HF_TOKEN is also accepted as an alias.

Exit codes:
  0   success (or plan-only mode)
  1   bad arguments
  2   KOLM_HF_TOKEN missing
  3   huggingface-cli missing
  4   dry-run orchestrator failed
  5   one or more huggingface-cli invocations failed
`;

function parseArgs(argv) {
  const opts = {
    confirm: false,
    targetRepo: 'kolm-ai/trinity-500-support-7b',
    license: 'apache-2.0',
    baseModel: 'Qwen/Qwen2.5-7B-Instruct',
    artifactDir: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; }
    else if (a === '--confirm') { opts.confirm = true; }
    else if (a === '--target-repo') { opts.targetRepo = argv[++i]; }
    else if (a === '--license') { opts.license = argv[++i]; }
    else if (a === '--base-model') { opts.baseModel = argv[++i]; }
    else if (a === '--artifact-dir') { opts.artifactDir = argv[++i]; }
    else { return { ok: false, error: `unknown arg: ${a}` }; }
  }
  return { ok: true, opts };
}

function hasHfCli() {
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which',
    ['huggingface-cli'], { encoding: 'utf8' });
  return which.status === 0 && (which.stdout || '').trim().length > 0;
}

function runDryRun(opts) {
  const args = [DRY_RUN_ORCH, '--target-repo', opts.targetRepo,
    '--license', opts.license, '--base-model', opts.baseModel];
  if (opts.artifactDir) args.push('--artifact-dir', opts.artifactDir);
  const r = spawnSync(process.execPath, args, {
    cwd: REPO, encoding: 'utf8',
  });
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function extractHfCommands(stdout) {
  // The dry-run orchestrator prints `--- huggingface-cli commands ---` block.
  const start = stdout.indexOf('--- huggingface-cli commands (NOT executed) ---');
  const end = stdout.indexOf('--- end ---');
  if (start < 0 || end < 0 || end <= start) return [];
  return stdout.slice(start, end).split('\n')
    .filter((l) => l.trim().startsWith('huggingface-cli '));
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`error: ${parsed.error}\n${HELP}`);
    process.exit(1);
  }
  if (parsed.opts.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  const opts = parsed.opts;

  // Gate #1: KOLM_HF_TOKEN
  const token = process.env.KOLM_HF_TOKEN || process.env.HF_TOKEN;
  if (!token) {
    process.stderr.write(
      'error: KOLM_HF_TOKEN (or HF_TOKEN) is not set.\n' +
      '  Set it to a HuggingFace token with write scope, then re-run:\n' +
      '    export KOLM_HF_TOKEN=hf_xxxxxxxxxxxx\n' +
      `    node scripts/w889-1.5-trinity-publish.cjs --target-repo ${opts.targetRepo} --confirm\n` +
      '  Without --confirm the script runs in plan-only mode; --confirm fires the push.\n'
    );
    process.exit(2);
  }

  // Gate #2: huggingface-cli installed (only enforced when --confirm)
  if (opts.confirm && !hasHfCli()) {
    process.stderr.write(
      'error: huggingface-cli not on PATH.\n' +
      '  Install: pip install -U huggingface_hub\n' +
      '  Then re-run with --confirm.\n'
    );
    process.exit(3);
  }

  // Run the dry-run orchestrator to refresh README + manifest.
  const dry = runDryRun(opts);
  if (!dry.ok) {
    process.stderr.write(`error: dry-run orchestrator failed:\n${dry.stderr}\n`);
    process.exit(4);
  }

  const cmds = extractHfCommands(dry.stdout);
  if (cmds.length === 0) {
    process.stderr.write('error: dry-run orchestrator produced no upload commands.\n');
    process.exit(4);
  }

  if (!opts.confirm) {
    process.stdout.write('Trinity-500 publish plan (PLAN-ONLY, --confirm to execute)\n');
    process.stdout.write('=========================================================\n');
    process.stdout.write(`target_repo : ${opts.targetRepo}\n`);
    process.stdout.write(`token_present : true (KOLM_HF_TOKEN / HF_TOKEN)\n`);
    process.stdout.write(`commands : ${cmds.length}\n`);
    process.stdout.write(`\nWould run:\n`);
    for (const c of cmds) process.stdout.write(`  ${c}\n`);
    process.stdout.write(`\nRe-run with --confirm to actually publish.\n`);
    process.exit(0);
  }

  // --confirm path: execute each huggingface-cli command sequentially.
  process.stdout.write(`Trinity-500 publish: ${cmds.length} commands\n`);
  let failed = 0;
  for (const c of cmds) {
    process.stdout.write(`\n$ ${c}\n`);
    const parts = c.split(/\s+/);
    const r = spawnSync(parts[0], parts.slice(1), {
      cwd: REPO,
      env: { ...process.env, HF_TOKEN: token },
      stdio: 'inherit',
    });
    if (r.status !== 0) {
      failed += 1;
      process.stderr.write(`  ! command exited with status ${r.status}\n`);
    }
  }
  if (failed > 0) {
    process.stderr.write(`\n${failed}/${cmds.length} commands failed.\n`);
    process.exit(5);
  }
  process.stdout.write(`\nAll ${cmds.length} commands succeeded.\n`);
  process.exit(0);
}

main();
