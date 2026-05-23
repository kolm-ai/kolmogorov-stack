// W728 — Inference-Time Compute Scaling tests.
//
// Atomic items from the W707-W806 system upgrade plan (lines 350-357):
//
//   [W728-1] apps/runtime/best_of_n.py        — Best-of-N sampling
//   [W728-2] apps/runtime/self_verify.py      — Self-verification w/ retries
//   [W728-3] apps/runtime/entropy_budget.py   — Entropy-gated budget
//
// Composed by apps/runtime/inference_time_scaling.py and exposed via the
// `kolm its ask | bench` CLI (cmdW728InferenceScale dispatcher).
//
// W604 anti-brittleness: sibling-wave assertions use regex `wave(\d{3,4})`
// + numeric threshold, never an explicit-array list. Python module shape
// is validated via `python3 -c "import ast; ast.parse(open(p).read())"`
// so the suite stays green even on a host without numpy/torch — the W728
// modules have NO heavy deps (pure stdlib).
//
// Skip-gracefully contract: every Python-dependent assertion checks for
// python3 first. On a CI host without python3 the test reports a
// `python3_missing` reason and asserts the load-bearing structural
// invariants (file existence + Node-side dispatcher symbol) that DO NOT
// need the interpreter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const APPS_RUNTIME = path.join(REPO_ROOT, 'apps', 'runtime');
const BENCH_DIR = path.join(REPO_ROOT, 'bench');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');

const PY_BIN = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

// Probe python3 ONCE. Many tests below need it; on a CI host without it we
// downgrade to file-existence checks rather than throw a hard fail.
function python3Available() {
  try {
    const r = spawnSync(PY_BIN, ['--version'], { encoding: 'utf8' });
    return !r.error && (r.status === 0 || r.status === null);
  } catch {
    return false;
  }
}

const HAS_PY = python3Available();

function pyParseFile(absPath) {
  // Pass the absolute path to a tiny driver script that opens the file
  // with explicit utf-8 encoding. Avoids the Windows-stdin codepage trap
  // (Python on Win32 decodes stdin as cp1252 by default, which mangles
  // any non-ASCII characters in the source — e.g. em-dashes in docstrings).
  // Returns { ok, stderr } so tests can assert + log.
  const driver = `import ast,sys; src=open(sys.argv[1],'r',encoding='utf-8').read(); ast.parse(src)`;
  const r = spawnSync(
    PY_BIN,
    ['-c', driver, absPath],
    { encoding: 'utf8', timeout: 20_000 },
  );
  return { ok: r.status === 0, stderr: r.stderr || '', status: r.status };
}

function pyRun(code) {
  // Run a short Python snippet; returns { ok, stdout, stderr, status }.
  // PYTHONIOENCODING=utf-8 forces stdout/stderr to utf-8 on Windows so
  // any non-ASCII output from the script round-trips cleanly through the
  // Node test harness (which decodes spawn output as utf-8).
  const r = spawnSync(
    PY_BIN,
    ['-c', code],
    {
      encoding: 'utf8',
      timeout: 30_000,
      cwd: REPO_ROOT,
      env: { ...process.env, PYTHONPATH: REPO_ROOT, PYTHONIOENCODING: 'utf-8' },
    },
  );
  return {
    ok: r.status === 0,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    status: r.status,
  };
}

// =============================================================================
// 1) apps/runtime/best_of_n.py exists, has best_of_n function, parses OK.
// =============================================================================

test('W728 #1 — apps/runtime/best_of_n.py exists, parses, exports best_of_n', () => {
  const p = path.join(APPS_RUNTIME, 'best_of_n.py');
  assert.ok(fs.existsSync(p), `expected file at ${p}`);
  const src = fs.readFileSync(p, 'utf8');
  assert.ok(/def\s+best_of_n\s*\(/.test(src),
    'best_of_n.py must define a function named best_of_n');
  if (!HAS_PY) return; // structural shape good enough on no-python hosts
  const r = pyParseFile(p);
  assert.ok(r.ok, `best_of_n.py must parse cleanly via ast.parse; stderr=${r.stderr.slice(0, 400)}`);
});

// =============================================================================
// 2) apps/runtime/self_verify.py exists, has self_verify function, parses OK.
// =============================================================================

test('W728 #2 — apps/runtime/self_verify.py exists, parses, exports self_verify', () => {
  const p = path.join(APPS_RUNTIME, 'self_verify.py');
  assert.ok(fs.existsSync(p), `expected file at ${p}`);
  const src = fs.readFileSync(p, 'utf8');
  assert.ok(/def\s+self_verify\s*\(/.test(src),
    'self_verify.py must define a function named self_verify');
  if (!HAS_PY) return;
  const r = pyParseFile(p);
  assert.ok(r.ok, `self_verify.py must parse cleanly via ast.parse; stderr=${r.stderr.slice(0, 400)}`);
});

// =============================================================================
// 3) apps/runtime/entropy_budget.py exists, has allocate_budget function.
// =============================================================================

test('W728 #3 — apps/runtime/entropy_budget.py exists, parses, exports allocate_budget', () => {
  const p = path.join(APPS_RUNTIME, 'entropy_budget.py');
  assert.ok(fs.existsSync(p), `expected file at ${p}`);
  const src = fs.readFileSync(p, 'utf8');
  assert.ok(/def\s+allocate_budget\s*\(/.test(src),
    'entropy_budget.py must define a function named allocate_budget');
  assert.ok(/def\s+estimate_entropy\s*\(/.test(src),
    'entropy_budget.py must define a function named estimate_entropy');
  if (!HAS_PY) return;
  const r = pyParseFile(p);
  assert.ok(r.ok, `entropy_budget.py must parse cleanly; stderr=${r.stderr.slice(0, 400)}`);
});

// =============================================================================
// 4) allocate_budget(entropy=2.5) returns n_samples >= 4 (high-entropy bucket).
// =============================================================================

test('W728 #4 — allocate_budget(entropy=2.5) returns n_samples >= 4', () => {
  if (!HAS_PY) {
    // Structural fallback: the threshold constants are still grep-able.
    const src = fs.readFileSync(path.join(APPS_RUNTIME, 'entropy_budget.py'), 'utf8');
    assert.ok(/HIGH_ENTROPY_THRESHOLD\s*:\s*float\s*=\s*2\.0/.test(src),
      'HIGH_ENTROPY_THRESHOLD must be 2.0 nats');
    return;
  }
  const r = pyRun(
    'from apps.runtime.entropy_budget import allocate_budget;'
    + 'import json,sys; sys.stdout.write(json.dumps(allocate_budget(2.5)))',
  );
  assert.ok(r.ok, `allocate_budget(2.5) must succeed; stderr=${r.stderr.slice(0, 400)}`);
  const got = JSON.parse(r.stdout);
  assert.ok(got.n_samples >= 4,
    `entropy=2.5 should map to n_samples >= 4; got n_samples=${got.n_samples}`);
  assert.equal(got.bucket, 'high',
    `entropy=2.5 should land in the 'high' bucket; got bucket=${got.bucket}`);
  assert.equal(got.verify_rounds, 2,
    `entropy=2.5 should allocate 2 verify rounds; got verify_rounds=${got.verify_rounds}`);
});

// =============================================================================
// 5) allocate_budget(entropy=0.1) returns n_samples == 1 (low-entropy bucket).
// =============================================================================

test('W728 #5 — allocate_budget(entropy=0.1) returns n_samples == 1', () => {
  if (!HAS_PY) {
    const src = fs.readFileSync(path.join(APPS_RUNTIME, 'entropy_budget.py'), 'utf8');
    assert.ok(/LOW_ENTROPY_THRESHOLD\s*:\s*float\s*=\s*0\.5/.test(src),
      'LOW_ENTROPY_THRESHOLD must be 0.5 nats');
    return;
  }
  const r = pyRun(
    'from apps.runtime.entropy_budget import allocate_budget;'
    + 'import json,sys; sys.stdout.write(json.dumps(allocate_budget(0.1)))',
  );
  assert.ok(r.ok, `allocate_budget(0.1) must succeed; stderr=${r.stderr.slice(0, 400)}`);
  const got = JSON.parse(r.stdout);
  assert.equal(got.n_samples, 1,
    `entropy=0.1 with default base_n=1 should map to n_samples=1; got ${got.n_samples}`);
  assert.equal(got.bucket, 'low',
    `entropy=0.1 should land in the 'low' bucket; got bucket=${got.bucket}`);
  assert.equal(got.verify_rounds, 0,
    `entropy=0.1 should allocate 0 verify rounds; got verify_rounds=${got.verify_rounds}`);
});

// =============================================================================
// 6) inference_time_scaling.py exists and composes the three primitives.
// =============================================================================

test('W728 #6 — inference_time_scaling.py exists and composes best_of_n + self_verify + entropy_budget', () => {
  const p = path.join(APPS_RUNTIME, 'inference_time_scaling.py');
  assert.ok(fs.existsSync(p), `expected file at ${p}`);
  const src = fs.readFileSync(p, 'utf8');
  // Load-bearing: orchestrator must import the three primitives.
  assert.ok(/from\s+apps\.runtime\.best_of_n\s+import/.test(src),
    'inference_time_scaling.py must import from apps.runtime.best_of_n');
  assert.ok(/from\s+apps\.runtime\.self_verify\s+import/.test(src),
    'inference_time_scaling.py must import from apps.runtime.self_verify');
  assert.ok(/from\s+apps\.runtime\.entropy_budget\s+import/.test(src),
    'inference_time_scaling.py must import from apps.runtime.entropy_budget');
  assert.ok(/def\s+scale_inference\s*\(/.test(src),
    'inference_time_scaling.py must define scale_inference');
  if (!HAS_PY) return;
  const r = pyParseFile(p);
  assert.ok(r.ok, `inference_time_scaling.py must parse cleanly; stderr=${r.stderr.slice(0, 400)}`);
  // End-to-end: scale_inference with a deterministic mock model_fn must
  // yield a full envelope. We run it via a tiny driver passed on the
  // command line; the model_fn returns a known first-token distribution
  // so the bucket is predictable.
  const driver = [
    'from apps.runtime.inference_time_scaling import scale_inference',
    'import json, sys',
    'def mfn(*args):',
    '  if len(args) == 1:',
    '    text = str(args[0])',
    '    if "strict verifier" in text.lower():',
    '      return "YES synthetic pass"',
    '    if "Verifier" in text:',
    '      return "revised synthetic answer"',
    '    return [0.97, 0.01, 0.01, 0.01]',
    '  return "synthetic candidate"',
    'r = scale_inference("hi prompt", model_fn=mfn)',
    'sys.stdout.write(json.dumps(r, default=str))',
  ].join('\n');
  const e2e = pyRun(driver);
  assert.ok(e2e.ok, `scale_inference dry-run must succeed; stderr=${e2e.stderr.slice(0, 400)}`);
  const env = JSON.parse(e2e.stdout);
  assert.equal(env.ok, true, 'scale_inference must return ok:true');
  assert.equal(env.budget.bucket, 'low',
    `entropy from [0.97,0.01,0.01,0.01] should land in 'low'; got ${env.budget.bucket}`);
  assert.equal(env.final_verified, true, 'mock verifier always says YES, so verified=true');
  assert.ok(env.model_calls >= 2,
    `model_calls must be >= 2 (entropy probe + best_of_n + verify); got ${env.model_calls}`);
});

// =============================================================================
// 7) bench/wave728-its-bench.py exists and is syntactically valid Python.
// =============================================================================

test('W728 #7 — bench/wave728-its-bench.py exists and parses', () => {
  const p = path.join(BENCH_DIR, 'wave728-its-bench.py');
  assert.ok(fs.existsSync(p), `expected bench file at ${p}`);
  const src = fs.readFileSync(p, 'utf8');
  assert.ok(/def\s+run_bench\s*\(/.test(src),
    'bench must define run_bench');
  assert.ok(/scale_inference/.test(src),
    'bench must call scale_inference');
  if (!HAS_PY) return;
  const r = pyParseFile(p);
  assert.ok(r.ok, `bench must parse cleanly; stderr=${r.stderr.slice(0, 400)}`);
});

// =============================================================================
// 8) CLI cmdW728InferenceScale dispatcher present in cli/kolm.js w/ unique name.
// =============================================================================

test('W728 #8 — cli/kolm.js contains the cmdW728InferenceScale dispatcher (unique name)', () => {
  const src = fs.readFileSync(CLI_PATH, 'utf8');
  assert.ok(/async\s+function\s+cmdW728InferenceScale\s*\(/.test(src),
    'cli/kolm.js must define async function cmdW728InferenceScale');
  // The dispatcher must be wired from the main switch via `case 'its':`.
  assert.ok(/case\s*'its'\s*:\s*await\s+withErrorContext\(\s*'its'\s*,\s*\(\)\s*=>\s*cmdW728InferenceScale\(/.test(src),
    "cli/kolm.js must route `case 'its':` through cmdW728InferenceScale");
  // Honest envelope: 'python3_missing' string must appear in the dispatcher
  // body so the missing-python path emits a structured error.
  assert.ok(/python3_missing/.test(src),
    'cli/kolm.js must include the python3_missing error code in the W728 dispatcher');
});

// =============================================================================
// 9) Anti-brittleness: family lock-in uses regex `wave(\d{3,4})` + threshold.
// =============================================================================

test('W728 #9 — sibling W7xx test files use regex+threshold (no explicit-array check)', () => {
  const testsDir = path.join(REPO_ROOT, 'tests');
  const files = fs.readdirSync(testsDir);
  // Wave detection uses the regex pinned by W604 anti-brittleness pattern.
  const w7Sibs = files.filter((f) => /wave(\d{3,4})/i.test(f) && /\.test\.js$/.test(f));
  // Threshold: at least the W728 test file itself must be in the set.
  assert.ok(w7Sibs.length >= 1,
    `expected at least 1 wave(\\d{3,4}) test file; found ${w7Sibs.length}`);
  assert.ok(w7Sibs.some((f) => f.startsWith('wave728-')),
    `the W728 test file must be in the family; got ${JSON.stringify(w7Sibs).slice(0, 400)}`);
  // Self-check: this test file must NOT contain a literal explicit-array
  // sibling list, which is the W604 regression trap.
  const ownPath = fileURLToPath(import.meta.url);
  const ownBody = fs.readFileSync(ownPath, 'utf8');
  // Strip lines that mention "explicit-array" by name (this comment + the
  // regex literal below) so the self-grep doesn't false-positive on
  // ourselves; THEN scan the rest for a hardcoded wave-name array.
  const stripped = ownBody
    .split(/\r?\n/)
    .filter((l) => !/explicit-array|explicitArray/.test(l))
    .join('\n');
  const explicitArrayLiteral = /\[\s*['"]wave7\d\d/;
  if (explicitArrayLiteral.test(stripped)) {
    assert.fail('W604 anti-brittleness: explicit-array sibling list detected in W728 test');
  }
});

// =============================================================================
// 10) Honest envelope: python3 absent path emits {ok:false, error:'python3_missing'}
//     with a non-zero exit. We assert on the source-level invariant
//     (string literal present in the dispatcher body) and, when python3
//     IS available on the host, also assert that `kolm its` with a bogus
//     sub-verb exits non-zero — proving the dispatcher fails loud rather
//     than silent-passing.
// =============================================================================

test('W728 #10 — python3-absent path is honest (non-zero exit, structured error)', () => {
  const cliSrc = fs.readFileSync(CLI_PATH, 'utf8');
  // Source-level: the dispatcher must include the load-bearing tokens.
  assert.ok(/python3_missing/.test(cliSrc),
    'cli/kolm.js W728 dispatcher must emit error:"python3_missing" on the missing-python path');
  assert.ok(/EXIT\.MISSING_PREREQ/.test(cliSrc),
    'cli/kolm.js W728 dispatcher must exit MISSING_PREREQ on the missing-python path');
  // Loud-on-bad-args: with no sub-verb, the dispatcher must NOT silently
  // succeed. We run the CLI with `its` and no sub-verb and assert exit
  // status is non-zero (BAD_ARGS specifically). This catches a silent-
  // pass regression even on python3-available hosts.
  const r = spawnSync(process.execPath, [CLI_PATH, 'its'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, KOLM_NO_INTERACTIVE: '1' },
  });
  assert.notEqual(r.status, 0,
    `\`kolm its\` with no sub-verb must exit non-zero; got ${r.status}; stderr=${(r.stderr || '').slice(0, 400)}`);
});
