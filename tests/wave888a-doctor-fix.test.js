// Wave W888-A — kolm doctor extended env probe + --fix flag lock-in.
//
// What this wave adds:
//   1. `kolm doctor --json` now returns an additive `groups` field that
//      buckets every check into seven categories (system / core / export /
//      cloud / network / storage / devices), plus a `summary` string and a
//      per-row `install_hint` + `group` field. The flat `checks` array MUST
//      remain present and well-formed (W457/W470/W481 lock-ins depend on it).
//   2. New optional dep probes — git, cuda, gpu, torch, transformers, peft,
//      bitsandbytes, shard, llama.cpp, llama_cpp, exllamav2, awq, mlx-lm,
//      runpod, modal, kolm.ai/api.kolm.ai/gateway HEAD, better-sqlite3, pg,
//      @aws-sdk/client-s3, registered devices.
//   3. `--fix` flag attempts npm + pip installs for missing optional deps.
//      `--dry-run` lists the plan without invoking anything (deterministic).
//      Missing optional deps surface an `install_hint` instead of a bare
//      "missing" status, so the user always sees how to fix.
//
// We deliberately avoid asserting on network/cloud results — those depend on
// the test environment. We assert STRUCTURE and SCHEMA only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const KOLM_CLI = path.join(REPO, 'cli', 'kolm.js');

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w888a-'));
}

function runDoctor(argv, extraEnv = {}) {
  const home = freshHome();
  // Deliberately scrub RUNPOD/MODAL keys so the cloud probes are deterministic
  // ("warn — env var not set"), and scrub KOLM_API_KEY so doctor follows the
  // --allow-logged-out demotion path under W481.
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    KOLM_API_KEY: '',
    RUNPOD_API_KEY: '',
    MODAL_TOKEN_ID: '',
    MODAL_TOKEN_SECRET: '',
    KOLM_BASE_URL: 'http://127.0.0.1:1',
    ...extraEnv,
  };
  const r = spawnSync(process.execPath, ['--no-warnings', KOLM_CLI, 'doctor', ...argv], {
    cwd: REPO,
    env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
  let parsed = null;
  const trimmed = (r.stdout || '').trim();
  if (trimmed) {
    try { parsed = JSON.parse(trimmed); } catch (_) { /* render path, not json */ }
  }
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', body: parsed };
}

// ---------------------------------------------------------------------------
// SCHEMA — the seven groups must exist and the new envelope fields must be
// present whether or not optional deps are installed.
// ---------------------------------------------------------------------------

test('W888-A #1 — doctor --json returns valid JSON with the new groups + summary shape', () => {
  const r = runDoctor(['--json', '--allow-logged-out']);
  assert.ok(r.body, 'doctor --json must emit parseable JSON; got:\n' + r.stdout.slice(0, 400));
  // Legacy envelope contract (W457/W470/W481).
  assert.equal(typeof r.body.ok, 'boolean', '.ok must be boolean');
  assert.equal(typeof r.body.blockers, 'number', '.blockers must be number');
  assert.equal(typeof r.body.warnings, 'number', '.warnings must be number');
  assert.ok(Array.isArray(r.body.checks), '.checks must remain a flat array');
  // New W888-A fields.
  assert.equal(typeof r.body.summary, 'string', '.summary must be string');
  assert.match(r.body.summary, /^\d+\/\d+ checks passed$/, '.summary must match "X/Y checks passed"');
  assert.ok(r.body.groups && typeof r.body.groups === 'object', '.groups must be an object');
  for (const g of ['system', 'core', 'export', 'cloud', 'network', 'storage', 'devices']) {
    assert.ok(Array.isArray(r.body.groups[g]),
      `.groups.${g} must be an array (got ${typeof r.body.groups[g]})`);
  }
});

test('W888-A #2 — every check row has the W888-A {name, status, detail, group} shape', () => {
  const r = runDoctor(['--json', '--allow-logged-out']);
  assert.ok(r.body && Array.isArray(r.body.checks), 'checks must be an array');
  const validStatus = new Set(['ok', 'warn', 'missing', 'fail']);
  for (const ch of r.body.checks) {
    assert.equal(typeof ch.name, 'string', `check missing .name: ${JSON.stringify(ch)}`);
    assert.ok(validStatus.has(ch.status), `bad status "${ch.status}" on ${ch.name}`);
    assert.equal(typeof ch.detail, 'string', `${ch.name} missing .detail`);
    assert.ok(typeof ch.group === 'string' && ch.group.length > 0,
      `${ch.name} missing .group`);
    assert.ok(['system','core','export','cloud','network','storage','devices'].includes(ch.group),
      `${ch.name} has unknown group "${ch.group}"`);
  }
});

test('W888-A #3 — groups[g] is exactly the subset of checks with .group === g', () => {
  const r = runDoctor(['--json', '--allow-logged-out']);
  assert.ok(r.body);
  for (const [g, list] of Object.entries(r.body.groups)) {
    const flat = r.body.checks.filter((c) => c.group === g);
    assert.equal(list.length, flat.length,
      `groups.${g} has ${list.length} rows; flat checks has ${flat.length} with group=${g}`);
    for (let i = 0; i < list.length; i++) {
      assert.equal(list[i].name, flat[i].name, `groups.${g}[${i}].name drift`);
    }
  }
});

// ---------------------------------------------------------------------------
// CHECK COVERAGE — the new probes must all appear by name.
// ---------------------------------------------------------------------------

test('W888-A #4 — new W888-A probes are present in the checks array', () => {
  const r = runDoctor(['--json', '--allow-logged-out']);
  assert.ok(r.body);
  const names = new Set(r.body.checks.map((c) => c.name));
  // system
  for (const n of ['git', 'cuda (nvidia-smi)', 'gpu']) {
    assert.ok(names.has(n), `system probe "${n}" missing`);
  }
  // core
  for (const n of ['torch', 'transformers', 'peft', 'bitsandbytes', 'shard']) {
    assert.ok(names.has(n), `core probe "${n}" missing`);
  }
  // export
  for (const n of ['llama.cpp binary', 'llama_cpp', 'exllamav2', 'awq', 'mlx-lm']) {
    assert.ok(names.has(n), `export probe "${n}" missing`);
  }
  // cloud
  for (const n of ['runpod', 'modal']) {
    assert.ok(names.has(n), `cloud probe "${n}" missing`);
  }
  // network
  for (const n of ['kolm.ai', 'api.kolm.ai', 'gateway /health']) {
    assert.ok(names.has(n), `network probe "${n}" missing`);
  }
  // storage
  for (const n of ['better-sqlite3', 'pg', '@aws-sdk/client-s3']) {
    assert.ok(names.has(n), `storage probe "${n}" missing`);
  }
  // devices
  assert.ok(names.has('registered devices'), 'devices probe missing');
});

test('W888-A #5 — legacy checks (W457/W470/W481) are still present', () => {
  const r = runDoctor(['--json', '--allow-logged-out']);
  assert.ok(r.body);
  const names = r.body.checks.map((c) => c.name);
  for (const n of [
    'config file', 'api key (config)', 'api key (server)',
    'cloud reachable', 'receipt secret', 'node version',
    'docker (optional)', 'python3 (optional)',
  ]) {
    assert.ok(names.includes(n), `legacy check "${n}" must remain in flat array; got: ${JSON.stringify(names)}`);
  }
});

// ---------------------------------------------------------------------------
// install_hint — missing optional dep rows surface a hint, never a bare label.
// ---------------------------------------------------------------------------

test('W888-A #6 — missing optional deps surface an install_hint (not just "missing")', () => {
  const r = runDoctor(['--json', '--allow-logged-out']);
  assert.ok(r.body);
  // Pick rows that are likely to be missing in CI / a fresh box: at least
  // one of the export-stack rows is typically not installed.
  const warnsInExport = r.body.groups.export.filter((c) => c.status === 'warn');
  if (warnsInExport.length === 0) {
    // Box has everything — nothing to assert. Skip cleanly.
    return;
  }
  for (const ch of warnsInExport) {
    // mac-only mlx-lm on non-mac comes back as ok (skip), so it won't show
    // up here. Every other warn row must include install guidance somewhere.
    const hint = (ch.install_hint || '') + ' ' + (ch.detail || '');
    assert.match(hint, /install:|kolm |pip install|npm install|build llama/i,
      `${ch.name}: warn rows must surface actionable guidance, got hint="${ch.install_hint}" detail="${ch.detail}"`);
  }
});

// ---------------------------------------------------------------------------
// --fix --dry-run — must list a plan without invoking anything.
// ---------------------------------------------------------------------------

test('W888-A #7 — --fix --dry-run lists a plan without installing', () => {
  const r = runDoctor(['--json', '--allow-logged-out', '--fix', '--dry-run']);
  assert.ok(r.body, 'doctor --fix --dry-run --json must emit JSON; stdout=' + r.stdout.slice(0, 200));
  // --fix only attaches a fix block when there is at least one missing
  // optional dep. On a fully-bootstrapped box there may be nothing to plan,
  // in which case the fix block is absent — that's a valid pass too.
  if (!r.body.fix) {
    // Nothing missing — the rest of the assertion bank is moot.
    return;
  }
  assert.equal(typeof r.body.fix, 'object', '.fix must be an object when present');
  assert.equal(typeof r.body.fix.attempted, 'number');
  assert.equal(typeof r.body.fix.succeeded, 'number');
  assert.equal(typeof r.body.fix.failed, 'number');
  assert.equal(typeof r.body.fix.skipped, 'number');
  assert.ok(Array.isArray(r.body.fix.items), '.fix.items must be an array');
  // In dry-run mode, every item must be planned (no installs ran).
  for (const item of r.body.fix.items) {
    assert.equal(item.status, 'planned',
      `--dry-run must not invoke any install; got status="${item.status}" for ${item.spec}`);
    assert.equal(item.detail, 'dry-run',
      `--dry-run item detail must be "dry-run"; got "${item.detail}"`);
    assert.ok(item.kind === 'pip' || item.kind === 'npm',
      `unknown fix kind "${item.kind}"`);
    assert.equal(typeof item.spec, 'string', 'fix item must carry a spec string');
  }
  // succeeded must be zero in dry-run (no installs happened).
  assert.equal(r.body.fix.succeeded, 0, '--dry-run must not increment succeeded');
  assert.equal(r.body.fix.failed, 0, '--dry-run must not increment failed');
  assert.equal(r.body.fix.skipped, r.body.fix.attempted,
    '--dry-run must count every planned item under skipped');
});

// ---------------------------------------------------------------------------
// Backwards compat — exit codes + --loop + --detect-hw still work.
// ---------------------------------------------------------------------------

test('W888-A #8 — --detect-hw subflag still short-circuits and prints hw fields', () => {
  const r = runDoctor(['--detect-hw', '--json', '--allow-logged-out']);
  // The W218 contract: exit 0 when a GPU is detected, exit 3 when none.
  assert.ok(r.status === 0 || r.status === 3, `--detect-hw exited unexpectedly (${r.status})`);
  assert.ok(r.body, '--detect-hw --json must emit parseable JSON');
  assert.ok('source' in r.body, '--detect-hw must include .source');
  assert.ok('gpu_name' in r.body, '--detect-hw must include .gpu_name');
  assert.ok('vram_gb' in r.body, '--detect-hw must include .vram_gb');
});

test('W888-A #9 — fresh-machine (no key, no env) run --json --allow-logged-out is deterministic', () => {
  // Two back-to-back runs with the same scrubbed env must produce identical
  // check NAMES and identical GROUP keys. (Cloud/network status MAY differ
  // by reachability, but the shape must not.)
  const a = runDoctor(['--json', '--allow-logged-out']);
  const b = runDoctor(['--json', '--allow-logged-out']);
  assert.ok(a.body && b.body);
  const aNames = a.body.checks.map((c) => c.name).sort();
  const bNames = b.body.checks.map((c) => c.name).sort();
  assert.deepEqual(aNames, bNames, 'check name list must be deterministic across runs');
  const aGroups = Object.keys(a.body.groups).sort();
  const bGroups = Object.keys(b.body.groups).sort();
  assert.deepEqual(aGroups, bGroups, 'group key set must be deterministic across runs');
  assert.deepEqual(aGroups, ['cloud', 'core', 'devices', 'export', 'network', 'storage', 'system'],
    'group set must be exactly the seven W888-A categories');
});
