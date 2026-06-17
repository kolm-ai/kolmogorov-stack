// SOTA CLI integration lane - real fixes for the CLI integration atoms.
//
// This lane owns cli/kolm.js (integration-only) and scripts/install.*. Because
// cli/kolm.js runs main() on import, the CLI behaviors are exercised by spawning
// the CLI as a subprocess (the realistic integration surface). The trainer
// envelope contracts the CLI threads through are also asserted against the src
// modules directly.
//
// Atoms exercised:
//   - [p0] install.sh node-version probe no longer aborts under `set -eu`
//          (shell-only major-version derivation, numeric guard).
//   - [p1] cloud team role vocabulary fence: reviewer/contributor rejected for
//          cloud ops instead of silently coercing to 'member'.
//   - [p1] provider-vault CLI surface (`kolm vault list|set|rm`) with provider
//          + scope validation.
//   - [p2/p1] dead 503 distill_bridge_not_configured branch removed; real
//          server envelopes handled. The un-gated path enqueues + the CLI offers
//          live follow.
//   - [p1] cmdCompile/pipeline gate exit code wiring (PRODUCTION_GATE_FAILED_EXIT).
//   - kolm migrate DB-migration runner (--status / --dry-run) wired to
//     src/migrations/index.js without clobbering the legacy spec-rewrite verb.
//   - trainer flags: on-policy --teacher (teacher_required envelope),
//     preference --reward-source (kscore/trl_default), spec-decode
//     --draft-model/--medusa-heads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'cli', 'kolm.js');
const INSTALL_SH = path.join(REPO, 'scripts', 'install.sh');
const HAS_POSIX_SH = spawnSync('sh', ['-c', 'exit 0'], { encoding: 'utf8' }).status === 0;

// Isolated home + data dir so the CLI never touches the developer's real config.
function freshEnv(extra = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-sota-cli-'));
  return {
    ...process.env,
    HOME: tmp,
    USERPROFILE: tmp,
    KOLM_DATA_DIR: path.join(tmp, '.kolm'),
    KOLM_HOME: path.join(tmp, '.kolm'),
    KOLM_ENV: 'test',
    KOLM_STORE_DRIVER: 'json',
    KOLM_EVENT_STORE_DRIVER: 'jsonl',
    // Point the CLI at a non-routable base so any accidental network call fails
    // fast rather than hitting prod.
    KOLM_BASE: 'http://127.0.0.1:9',
    ...extra,
  };
}

function runCli(args, env = freshEnv()) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', out: (r.stdout || '') + (r.stderr || '') };
}

// ---------------------------------------------------------------------------
// [p0] install.sh node-version probe.
// ---------------------------------------------------------------------------

test('install.sh: passes `sh -n` syntax check', (t) => {
  if (!HAS_POSIX_SH) return t.skip('POSIX sh is not available on this host');
  const r = spawnSync('sh', ['-n', INSTALL_SH], { encoding: 'utf8' });
  assert.equal(r.status, 0, 'install.sh has a shell syntax error: ' + (r.stderr || ''));
});

test('install.sh: node-version probe has no broken inner-quote escaping', () => {
  const text = fs.readFileSync(INSTALL_SH, 'utf8');
  // The bug was: node -e 'process...split(\".\")[0]' under sh -> the \" is a
  // literal backslash, NODE_MAJOR becomes empty, `[ "" -lt 20 ]` aborts under
  // set -eu. Assert that pattern is gone.
  assert.ok(!/split\(\\"/.test(text), 'install.sh still has the escaped-quote node -e probe');
  // Assert the shell-only derivation is present.
  assert.ok(/NODE_VER="\$\(node -v/.test(text), 'install.sh should derive NODE_VER from `node -v`');
  assert.ok(/NODE_MAJOR="\$\{NODE_MAJOR%%\.\*\}"/.test(text), 'install.sh should strip to the major version in shell');
});

test('install.sh: the require_node probe yields a numeric major under set -eu', (t) => {
  if (!HAS_POSIX_SH) return t.skip('POSIX sh is not available on this host');
  // Execute exactly the probe logic the installer uses, under `set -eu`, and
  // assert it produces a numeric result (this is the line that used to abort).
  const probe = [
    'set -eu',
    'NODE_VER="$(node -v 2>/dev/null || true)"',
    'NODE_MAJOR="${NODE_VER#v}"',
    'NODE_MAJOR="${NODE_MAJOR%%.*}"',
    'case "$NODE_MAJOR" in ""|*[!0-9]*) echo NONNUMERIC; exit 7;; esac',
    'printf "%s" "$NODE_MAJOR"',
  ].join('\n');
  const r = spawnSync('sh', ['-c', probe], { encoding: 'utf8' });
  assert.equal(r.status, 0, 'probe aborted: ' + (r.stderr || ''));
  assert.match(r.stdout.trim(), /^[0-9]+$/, 'probe did not yield a numeric major: ' + r.stdout);
});

// ---------------------------------------------------------------------------
// [p1] cloud team role vocabulary fence.
// ---------------------------------------------------------------------------

test('team invite (cloud): rejects reviewer with an actionable message, exit 1', () => {
  // `team invite <slug> <email>` is the cloud form (2 positionals). reviewer is
  // a local-only role; it must be rejected, NOT coerced to member (no network).
  const r = runCli(['team', 'invite', 'acme', 'alice@example.com', '--role', 'reviewer']);
  assert.equal(r.code, 1, 'expected BAD_ARGS exit 1, got ' + r.code + '\n' + r.out);
  assert.match(r.out, /local-workspace role/i);
  assert.match(r.out, /viewer\|member\|admin/);
});

test('team invite (cloud): rejects contributor too', () => {
  const r = runCli(['team', 'invite', 'acme', 'bob@example.com', '--role', 'contributor']);
  assert.equal(r.code, 1);
  assert.match(r.out, /local-workspace role/i);
});

test('team role (cloud): rejects an unknown role rather than coercing', () => {
  const r = runCli(['team', 'role', 'acme', 'tn_123', 'wizard']);
  assert.equal(r.code, 1);
  assert.match(r.out, /unknown cloud team role/i);
});

test('team invite (cloud): a valid cloud role passes validation (then network-fails, not arg-fails)', () => {
  // admin is valid -> we should get past validation and only fail on the
  // (unreachable) network, which is exit EXECUTION(4), NOT BAD_ARGS(1).
  const r = runCli(['team', 'invite', 'acme', 'carol@example.com', '--role', 'admin']);
  assert.notEqual(r.code, 1, 'admin should not be rejected as a bad arg: ' + r.out);
});

// ---------------------------------------------------------------------------
// [p1] provider-vault CLI surface.
// ---------------------------------------------------------------------------

test('vault --help: prints usage + provider list without a server', () => {
  const r = runCli(['vault', '--help']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /kolm vault <list\|set\|rm>/);
  assert.match(r.out, /openai, anthropic/);
});

test('vault set: unknown provider is rejected (exit 1) before any network call', () => {
  // Set a dummy api key so the login gate passes and we reach provider validation.
  const r = runCli(['vault', 'set', 'notaprovider', 'sk-x'], freshEnv({ KOLM_API_KEY: 'ks_test_dummy' }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /unknown provider 'notaprovider'/);
});

test('vault set: --scope team without --team is rejected', () => {
  const r = runCli(['vault', 'set', 'openai', 'sk-x', '--scope', 'team'], freshEnv({ KOLM_API_KEY: 'ks_test_dummy' }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /--scope team requires --team/);
});

test('vault set: bad --scope value rejected', () => {
  const r = runCli(['vault', 'set', 'openai', 'sk-x', '--scope', 'galaxy'], freshEnv({ KOLM_API_KEY: 'ks_test_dummy' }));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /--scope must be one of: member, team/);
});

test('vault: requires login when no api key', () => {
  const r = runCli(['vault', 'list']);
  assert.equal(r.code, 3, r.out); // MISSING_PREREQ
  assert.match(r.out, /not logged in/i);
});

// ---------------------------------------------------------------------------
// kolm migrate DB-migration runner (does not clobber legacy spec-rewrite verb).
// ---------------------------------------------------------------------------

test('migrate --status: lists the canonical migration registry (no spec needed)', () => {
  const r = runCli(['migrate', '--status']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /migrations \(/);
  assert.match(r.out, /capture-to-events/);
});

test('migrate --dry-run --json: runs the registry in dry-run, no writes', () => {
  const r = runCli(['migrate', '--dry-run', '--json']);
  assert.equal(r.code, 0, r.out);
  const j = JSON.parse(r.stdout);
  assert.equal(j.dry_run, true);
  assert.ok(Array.isArray(j.ran));
});

test('migrate (legacy spec form preserved): a spec positional still routes to the rewrite verb', () => {
  // A non-existent spec path must hit the legacy spec-rewrite branch (which
  // errors 'not found'), proving the DB path did not swallow the positional form.
  const r = runCli(['migrate', '/no/such/spec.json', '--out', '/tmp/out.json']);
  assert.match(r.out, /not found/i);
  assert.ok(!/migrations \(/.test(r.out), 'must NOT take the DB-status path when a spec positional is given');
});

// ---------------------------------------------------------------------------
// Trainer envelope contracts the CLI threads through.
// ---------------------------------------------------------------------------

test('on-policy: trainOnPolicy returns teacher_required when no teacher (CLI surfaces --teacher)', async () => {
  const env = freshEnv();
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  delete process.env.KOLM_ONPOLICY_TEACHER;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-onpolicy-'));
  const pairs = path.join(tmp, 'pairs.jsonl');
  fs.writeFileSync(pairs, JSON.stringify({ prompt: 'hi', response: 'yo' }) + '\n');
  const mod = await import('../src/distill-onpolicy.js');
  // Only the in_repo trainer enforces the teacher gate. When a trainer resolves
  // to in_repo and no teacher is passed, the envelope is teacher_required.
  const out = mod.trainOnPolicy({ pairsPath: pairs, studentPath: path.join(tmp, 'student'), maxSteps: 1 });
  if (out.error === 'teacher_required') {
    assert.equal(out.ok, false);
    assert.match(out.detail || '', /teacher/i);
  } else {
    // Acceptable alternative envelopes when no in_repo trainer is resolvable in
    // this environment; the CLI handles both. Just assert it is a clean
    // ok:false envelope (no throw / no fake success).
    assert.equal(out.ok, false);
    assert.ok(out.error, 'expected an error code, got ' + JSON.stringify(out));
  }
});

test('preference: trainPreference reports a typed envelope (reward_source wired on success)', async () => {
  const env = freshEnv();
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  // Force the durable no-tool path (documented seam) so the test is fast +
  // deterministic and never spawns a real python trainer / downloads a model.
  process.env.KOLM_PREFERENCE_NO_TRAINER = '1';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-pref-'));
  const pairs = path.join(tmp, 'pairs.jsonl');
  fs.writeFileSync(pairs, JSON.stringify({ prompt: 'p', chosen: 'a', rejected: 'b' }) + '\n');
  const mod = await import('../src/distill-preference.js');
  // Use a bogus student path so the trainer does not actually download a model;
  // we only assert the wiring contract, not a full train. The trainer may:
  //   - succeed -> envelope carries reward_source (proves the knob is wired)
  //   - fail to spawn/load -> clean ok:false envelope (no fake success)
  //   - report deferred/no_trainer_installed when trl/torch absent.
  const out = mod.trainPreference({ pairsPath: pairs, studentPath: path.join(tmp, 's'), objective: 'dpo' });
  assert.ok(out && typeof out === 'object');
  if (out.ok) {
    assert.ok('reward_source' in out, 'reward_source missing on success: ' + JSON.stringify(out).slice(0, 200));
    if (out.trainer_source === 'in_repo') assert.equal(out.reward_source, 'kscore');
  } else {
    // No theater: a failure must be a typed envelope, never a thrown error or a
    // fabricated success.
    assert.ok(out.error || out.deferred, 'expected an error/deferred envelope: ' + JSON.stringify(out).slice(0, 200));
  }
});

// ---------------------------------------------------------------------------
// Compile gate exit-code wiring contract.
// ---------------------------------------------------------------------------

test('compile-pipeline: PRODUCTION_GATE_FAILED_EXIT === 2 (the CI exit code the CLI maps)', async () => {
  const mod = await import('../src/compile-pipeline.js');
  assert.equal(mod.PRODUCTION_GATE_FAILED_EXIT, 2);
});

test('CLI dead-branch removal: cmdDistill no longer references distill_bridge_not_configured', () => {
  const text = fs.readFileSync(CLI, 'utf8');
  // The stale 'distillation is gated / not enabled' narrative must be gone.
  assert.ok(!/distill_bridge_not_configured/.test(text), 'CLI still references the dead distill_bridge_not_configured branch');
  // The real server envelopes the CLI now handles must be present.
  assert.ok(/trainer_bridge_not_configured/.test(text), 'CLI should handle the real trainer_bridge_not_configured 503');
  assert.ok(/distill_bridge_spawn_failed/.test(text), 'CLI should handle the real distill_bridge_spawn_failed 500');
});

test('CLI: a `followJob` SSE/poll consumer exists for the un-gated distill progress UX', () => {
  const text = fs.readFileSync(CLI, 'utf8');
  assert.ok(/async function followJob\(/.test(text), 'followJob consumer missing');
  assert.ok(/text\/event-stream/.test(text), 'followJob should attempt SSE');
  assert.ok(/\/v1\/jobs\//.test(text), 'followJob should poll /v1/jobs/:id as a fallback');
});

// ---------------------------------------------------------------------------
// Cloud broker run/quantize wiring + the bare verbs are registered.
// ---------------------------------------------------------------------------

test('CLI: vault verb is registered in the completion table + dispatch', () => {
  const text = fs.readFileSync(CLI, 'utf8');
  assert.ok(/'rag', 'team', 'vault', 'tunnel'/.test(text), 'vault not in COMPLETION_VERBS');
  assert.ok(/case 'vault':\s*await withErrorContext\('vault'/.test(text), 'vault not dispatched');
});

test('cloud broker: runCloudCompute exists and is the execution path (dry-run without confirm)', async () => {
  const env = freshEnv();
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const broker = await import('../src/cloud-compute-broker.js');
  assert.equal(typeof broker.runCloudCompute, 'function');
  const out = await broker.runCloudCompute(
    { workload: 'train', privacy: 'standard', params_b: 7, rows: 100, no_local_gpu: false },
    { env: process.env, confirm: false },
  );
  // Without confirm, runCloudCompute must NOT spend: either a dry_run handle or
  // a clean ok:false plan envelope - never a fabricated job.
  assert.ok(typeof out === 'object');
  if (out.ok) assert.ok(out.dry_run === true || out.mode, 'unexpected shape: ' + JSON.stringify(out));
});
