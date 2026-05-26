// W890-5 — testing-completeness lock-ins.
//
// Fourteen invariants ratify the audit produced by the W890-5 sub-wave:
//   1.  coverage.percent >= 0.80 (static-reference heuristic)
//   2.  every critical path (signing/verification/capture/routing) >= 0.95
//   3.  exported-fn rate >= 0.70
//   4.  CLI without_test enumerated, count documented (target 0)
//   5.  endpoint without_test enumerated, count documented
//   6.  error-path coverage produced (rate documented, target 0.90)
//   7.  flake 3-run stable === true
//   8.  external-deps should_be_mocked === 0
//   9.  orphan-script confirmed_orphans === 0
//   10. test-naming rate produced (target 0.90)
//   11. canonical doc docs/reference/testing-policy.md exists and refs all data files
//   12. no banned vocabulary in any W890-5 deliverable
//   13. W890-1..4 + W890-7 + W890-8 lock-in test files still structurally intact
//   14. ship-gate snapshot 52/52 (snapshot is captured by the audit driver;
//       Node 22+ refuses to nest its test runner, so we cannot spawn ship-gate
//       live from inside `node --test` — the audit captures it once)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

function readJSON(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

test('lock-in 1: data/w890-5-coverage.json — percent >= 0.80', () => {
  const r = readJSON('data/w890-5-coverage.json');
  assert.equal(typeof r.percent, 'number', 'percent must be numeric');
  assert.equal(typeof r.files_total, 'number');
  assert.equal(typeof r.files_with_test, 'number');
  assert.equal(typeof r.lines_total, 'number');
  assert.equal(typeof r.lines_covered, 'number');
  assert.equal(typeof r.method, 'string', 'method must document the heuristic');
  assert.ok(Array.isArray(r.by_dir), 'by_dir must be an array');
  assert.equal(r.target_80_met, true,
    `coverage.percent ${r.percent} must be >= 0.80; refresh via node scripts/w890-5-testing-audit.cjs`);
  assert.ok(r.percent >= 0.8,
    `coverage.percent ${r.percent} < 0.80 floor`);
});

test('lock-in 2: data/w890-5-critical-paths.json — every critical path >= 0.95', () => {
  const r = readJSON('data/w890-5-critical-paths.json');
  assert.ok(Array.isArray(r.paths), 'paths must be an array');
  assert.ok(Array.isArray(r.by_path), 'by_path must be an array');
  assert.equal(r.all_target_met, true,
    'all critical paths (signing/verification/capture/routing) must meet 0.95 floor');
  // Must cover the four named critical paths verbatim.
  for (const expected of ['signing', 'verification', 'capture', 'routing']) {
    assert.ok(r.paths.includes(expected),
      `critical path "${expected}" must be in paths[]`);
    const entry = r.by_path.find((p) => p.name === expected);
    assert.ok(entry, `critical path "${expected}" must have a by_path entry`);
    assert.ok(entry.percent >= 0.95,
      `critical path "${expected}" coverage ${entry.percent} < 0.95 floor`);
    assert.equal(entry.target_95_met, true,
      `critical path "${expected}" must report target_95_met: true`);
  }
});

test('lock-in 3: data/w890-5-exported-fns-coverage.json — rate >= 0.70', () => {
  const r = readJSON('data/w890-5-exported-fns-coverage.json');
  assert.equal(typeof r.total_exports, 'number');
  assert.equal(typeof r.with_test, 'number');
  assert.equal(typeof r.without_test_count, 'number');
  assert.equal(typeof r.rate, 'number');
  assert.ok(Array.isArray(r.without_test), 'without_test must be an array');
  assert.ok(r.rate >= 0.7,
    `exported-fn coverage rate ${r.rate} < 0.70 floor`);
  // Sanity: with_test + without_test_count = total_exports.
  assert.equal(r.with_test + r.without_test_count, r.total_exports,
    'with_test + without_test_count must equal total_exports');
});

test('lock-in 4: data/w890-5-cli-cmd-coverage.json — 0 without_test', () => {
  const r = readJSON('data/w890-5-cli-cmd-coverage.json');
  assert.equal(typeof r.total_cli_cmds, 'number');
  assert.equal(typeof r.with_test, 'number');
  assert.ok(Array.isArray(r.without_test), 'without_test must be an array');
  assert.equal(r.without_test_count, 0,
    `every top-level CLI verb must be tested; uncovered: ${JSON.stringify(r.without_test)}. ` +
    'Add either a `kolm <verb>` string, a `"<verb>"` literal, or a cmd<Verb> function name to a tests/ file.');
  assert.equal(r.rate, 1,
    `cli-cmd coverage rate ${r.rate} must be 1.00 (0 without_test)`);
});

test('lock-in 5: data/w890-5-endpoint-coverage.json — without_test enumerated and documented', () => {
  const r = readJSON('data/w890-5-endpoint-coverage.json');
  assert.equal(typeof r.total_endpoints, 'number');
  assert.equal(typeof r.with_test, 'number');
  assert.equal(typeof r.without_test_count, 'number');
  assert.ok(Array.isArray(r.without_test), 'without_test must be an array');
  assert.equal(typeof r.method, 'string');
  // Sanity: with_test + without_test_count = total_endpoints.
  assert.equal(r.with_test + r.without_test_count, r.total_endpoints,
    'with_test + without_test_count must equal total_endpoints');
  // The without_test list must be enumerable (each entry has method+path+file).
  for (const e of r.without_test.slice(0, 5)) {
    assert.equal(typeof e.method, 'string', 'each without_test entry has method');
    assert.equal(typeof e.path, 'string', 'each without_test entry has path');
    assert.equal(typeof e.file, 'string', 'each without_test entry has file');
  }
  // Soft cap so future endpoint sprawl is forced to ship tests.
  assert.ok(r.without_test_count <= 250,
    `endpoint without_test_count ${r.without_test_count} > 250 cap; add tests for the largest namespaces`);
});

test('lock-in 6: data/w890-5-error-path-coverage.json — rate >= 0.90', () => {
  const r = readJSON('data/w890-5-error-path-coverage.json');
  assert.equal(typeof r.sampled_error_paths, 'number');
  assert.equal(typeof r.total_in_router, 'number');
  assert.equal(typeof r.with_test, 'number');
  assert.equal(typeof r.without_test_count, 'number');
  assert.equal(typeof r.rate, 'number');
  assert.equal(typeof r.method, 'string', 'method must document the sampling strategy');
  assert.ok(r.rate >= 0.9,
    `error-path coverage rate ${r.rate} < 0.90 floor`);
});

test('lock-in 7: data/w890-5-flake-3run.json — stable === true', () => {
  const r = readJSON('data/w890-5-flake-3run.json');
  assert.equal(typeof r.full_flake_mode, 'boolean');
  assert.ok(Array.isArray(r.subset), 'subset must be an array');
  assert.ok(Array.isArray(r.runs), 'runs must be an array');
  assert.equal(r.runs.length, 3, 'must capture exactly three sequential runs');
  for (const run of r.runs) {
    assert.equal(typeof run.pass, 'number', 'each run records pass count');
    assert.equal(typeof run.fail, 'number', 'each run records fail count');
    assert.equal(typeof run.exit_code, 'number', 'each run records exit_code');
  }
  assert.equal(r.stable, true,
    `flake 3-run must be stable; diff: ${JSON.stringify(r.diff)}`);
  assert.deepEqual(r.diff, [], 'diff must be empty when stable === true');
});

test('lock-in 8: data/w890-5-external-deps.json — should_be_mocked === 0', () => {
  const r = readJSON('data/w890-5-external-deps.json');
  assert.ok(Array.isArray(r.tests_calling_external),
    'tests_calling_external must be an array');
  assert.ok(Array.isArray(r.should_be_mocked),
    'should_be_mocked must be an array');
  assert.ok(Array.isArray(r.excluded_localhost_or_test_server),
    'excluded_localhost_or_test_server must be an array');
  assert.equal(r.should_be_mocked.length, 0,
    `tests must not call external services; offenders: ${JSON.stringify(r.should_be_mocked.slice(0, 5))}. ` +
    'Wrap behind KOLM_TEST_MOCK_PROVIDER=1 or move to an in-process fixture.');
});

test('lock-in 9: data/w890-5-orphan-scripts.json — confirmed_orphans === 0', () => {
  const r = readJSON('data/w890-5-orphan-scripts.json');
  assert.equal(typeof r.candidates_total, 'number');
  assert.ok(Array.isArray(r.confirmed_orphans),
    'confirmed_orphans must be an array');
  assert.ok(Array.isArray(r.oneshots_excluded),
    'oneshots_excluded must be an array');
  assert.equal(typeof r.rationale, 'string',
    'rationale must document the orphan-detection exclusions');
  assert.equal(r.confirmed_orphans.length, 0,
    `confirmed_orphans must be 0; found: ${JSON.stringify(r.confirmed_orphans)}. ` +
    'Either delete the script or document why it is kept in the script header.');
});

test('lock-in 10: data/w890-5-test-naming.json — rate >= 0.90', () => {
  const r = readJSON('data/w890-5-test-naming.json');
  assert.equal(typeof r.sampled, 'number');
  assert.equal(typeof r.conformant_to_pattern, 'number');
  assert.equal(typeof r.malformed_count, 'number');
  assert.equal(typeof r.rate, 'number');
  assert.equal(typeof r.method, 'string',
    'method must document the accepted naming patterns');
  assert.ok(Array.isArray(r.malformed),
    'malformed must be an array');
  assert.ok(r.rate >= 0.9,
    `test-naming rate ${r.rate} < 0.90 floor. Malformed: ${JSON.stringify(r.malformed.slice(0, 5))}`);
});

test('lock-in 11: docs/reference/testing-policy.md exists + references all data files', () => {
  const docPath = path.join(ROOT, 'docs/reference/testing-policy.md');
  assert.ok(fs.existsSync(docPath), 'testing-policy.md missing');
  const txt = fs.readFileSync(docPath, 'utf8');
  for (const f of [
    'data/w890-5-coverage.json',
    'data/w890-5-critical-paths.json',
    'data/w890-5-exported-fns-coverage.json',
    'data/w890-5-cli-cmd-coverage.json',
    'data/w890-5-endpoint-coverage.json',
    'data/w890-5-error-path-coverage.json',
    'data/w890-5-flake-3run.json',
    'data/w890-5-external-deps.json',
    'data/w890-5-orphan-scripts.json',
    'data/w890-5-test-naming.json',
    'data/w890-5-ship-gate-snapshot.json',
  ]) {
    assert.ok(txt.includes(f), `policy doc must reference ${f}`);
  }
  // Doc must describe the four key policies.
  assert.ok(/coverage/i.test(txt), 'doc must describe coverage targets');
  assert.ok(/flake/i.test(txt), 'doc must describe flake tolerance');
  assert.ok(/mock/i.test(txt), 'doc must describe mock policy');
  assert.ok(/naming/i.test(txt), 'doc must describe naming convention');
  assert.ok(/ship[\s-]?gate/i.test(txt), 'doc must describe ship-gate integration');
});

test('lock-in 12: no banned vocabulary in any W890-5 deliverable', () => {
  // Construct the banned token at runtime so this file itself does not embed
  // the literal (would create a self-recursive false positive when the test
  // scans itself). Mirrors the W890-1 / W890-2 / W890-3 pattern.
  const banned = String.fromCharCode(104) + 'on' + String.fromCharCode(101, 115, 116);
  const re = new RegExp(`\\b${banned}(?:y)?\\b`, 'i');
  const targets = [
    'data/w890-5-coverage.json',
    'data/w890-5-critical-paths.json',
    'data/w890-5-exported-fns-coverage.json',
    'data/w890-5-cli-cmd-coverage.json',
    'data/w890-5-endpoint-coverage.json',
    'data/w890-5-error-path-coverage.json',
    'data/w890-5-flake-3run.json',
    'data/w890-5-external-deps.json',
    'data/w890-5-orphan-scripts.json',
    'data/w890-5-test-naming.json',
    'data/w890-5-ship-gate-snapshot.json',
    'docs/reference/testing-policy.md',
  ];
  for (const t of targets) {
    const fp = path.join(ROOT, t);
    if (!fs.existsSync(fp)) continue;
    const txt = fs.readFileSync(fp, 'utf8');
    assert.ok(!re.test(txt),
      `forbidden vocabulary in ${t}; use Caveats / Constraints / Limitations / Accuracy instead`);
  }
});

test('lock-in 13: prior W890 lock-in test files still structurally intact', () => {
  // Same pattern as W890-3 #10: we cannot recursively invoke `node --test`,
  // but we CAN assert the prior W890 sub-wave test files exist, parse, and
  // declare >= 12 lock-in blocks each. Their own CI coverage runs them.
  for (const fp of [
    path.join(ROOT, 'tests/wave890-1-organization.test.js'),
    path.join(ROOT, 'tests/wave890-2-code-quality.test.js'),
    path.join(ROOT, 'tests/wave890-3-error-handling.test.js'),
    path.join(ROOT, 'tests/wave890-4-logging.test.js'),
    path.join(ROOT, 'tests/wave890-7-configuration.test.js'),
    path.join(ROOT, 'tests/wave890-8-storage.test.js'),
  ]) {
    assert.ok(fs.existsSync(fp), `prior W890 test file missing: ${fp}`);
    const txt = fs.readFileSync(fp, 'utf8');
    const blocks = txt.match(/\btest\(\s*['"`]lock-in\s+\d+/g) || [];
    assert.ok(blocks.length >= 12,
      `${path.basename(fp)} must declare >= 12 lock-in test blocks; found ${blocks.length}`);
  }
  // Sample of prior-wave data artifacts must still exist.
  for (const f of [
    'data/w890-1-loc-report.json',
    'data/w890-2-secrets-scan.json',
    'data/w890-3-empty-catches.json',
    'data/w890-4-structured-logging.json',
    'data/w890-7-env-vars.json',
    'data/w890-8-wal-mode.json',
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `prior W890 artifact missing: ${f}`);
  }
});

test('lock-in 14: data/w890-5-ship-gate-snapshot.json — 52/52', () => {
  // Why a snapshot instead of a live spawn:
  //
  //   Node 22+ refuses to nest its test runner. `node --test` invoked inside
  //   a `node --test` parent returns recursive-warning failures even when
  //   the ship-gate is green standalone. The W890-5 audit driver spawns
  //   ship-gate ONCE and writes this snapshot; the lock-in reads it.
  //
  // CI re-runs `node scripts/w890-5-testing-audit.cjs` on every wave-deploy
  // so the snapshot freshness is bounded.
  const r = readJSON('data/w890-5-ship-gate-snapshot.json');
  assert.equal(typeof r.captured_at, 'string', 'captured_at must be a timestamp');
  assert.equal(typeof r.duration_s, 'number', 'duration_s must be numeric');
  assert.equal(typeof r.exit_status, 'number', 'exit_status must be numeric');
  assert.equal(r.total, 52, 'ship-gate must declare 52 total checks');
  assert.equal(r.passed, 52, `ship-gate passed ${r.passed}/52`);
  assert.equal(r.failed, 0, `ship-gate failed ${r.failed} (must be 0)`);
  assert.equal(r.exit_status, 0, `ship-gate exit_status ${r.exit_status} (must be 0)`);
});
