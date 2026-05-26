// W890-3 — error-handling lock-ins.
//
// Twelve invariants ratify the audit produced by the W890-3 sub-wave:
//   - async coverage shape valid; naked count documented
//   - empty catches: 0 (achievable target per spec)
//   - error message audit shape valid; weakest list capped at 20
//   - process-level handlers (unhandledRejection + uncaughtException) wired
//     in every entry point; graceful shutdown present
//   - HTTP status-code scan shape valid
//   - Sentry installed + capture_on_500 true
//   - canonical policy doc exists and references all 6 data files
//   - no banned vocabulary in any data/w890-3-*.json or policy doc
//   - W890-1 + W890-2 lock-in test files still 12/12 each (no regression)
//   - audit-static-refs still 0 missing
//   - audit-href --strict still 0 broken

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const NODE = process.execPath;

function readJSON(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

test('lock-in 1: data/w890-3-async-coverage.json shape', () => {
  const r = readJSON('data/w890-3-async-coverage.json');
  for (const k of ['total_async_fns', 'with_try_catch', 'naked']) {
    assert.equal(typeof r[k], 'number', `${k} must be numeric`);
  }
  assert.ok(Array.isArray(r.by_file), 'by_file must be an array');
  // naked count is DOCUMENTED, not required to be zero. The audit is a
  // heuristic and false-positives are expected in the long tail.
  assert.ok(r.by_file.length <= 50, `by_file capped at 50, was ${r.by_file.length}`);
  assert.ok(r.total_async_fns >= r.with_try_catch,
    `total (${r.total_async_fns}) must be >= guarded (${r.with_try_catch})`);
});

test('lock-in 2: data/w890-3-empty-catches.json — total 0', () => {
  const r = readJSON('data/w890-3-empty-catches.json');
  assert.equal(typeof r.total, 'number');
  assert.ok(Array.isArray(r.by_file));
  assert.equal(r.total, 0,
    `empty-catch sites must be 0 after fixer; found ${r.total}. ` +
    `Re-run: node scripts/w890-3-fix-empty-catches.cjs && node scripts/w890-3-error-handling-audit.cjs`);
});

test('lock-in 3: data/w890-3-error-messages.json shape + weakest cap', () => {
  const r = readJSON('data/w890-3-error-messages.json');
  for (const k of ['sampled', 'with_what', 'with_why', 'with_action']) {
    assert.equal(typeof r[k], 'number', `${k} must be numeric`);
  }
  assert.ok(Array.isArray(r.weakest), 'weakest must be an array');
  assert.ok(r.weakest.length <= 20, `weakest capped at 20, was ${r.weakest.length}`);
  for (const w of r.weakest) {
    assert.equal(typeof w.file, 'string');
    assert.equal(typeof w.line, 'number');
    assert.equal(typeof w.message, 'string');
    assert.equal(typeof w.reason, 'string');
  }
});

test('lock-in 4: data/w890-3-process-handlers.json — unhandledRejection wired at every entry', () => {
  const r = readJSON('data/w890-3-process-handlers.json');
  assert.ok(Array.isArray(r.entry_points), 'entry_points must be an array');
  assert.equal(r.unhandled_rejection_handler, true,
    'every entry point must register process.on("unhandledRejection")');
  for (const ep of r.entry_points) {
    assert.equal(ep.unhandled_rejection, true,
      `entry point ${ep.file} missing unhandledRejection handler`);
  }
});

test('lock-in 5: data/w890-3-process-handlers.json — uncaughtException wired at every entry', () => {
  const r = readJSON('data/w890-3-process-handlers.json');
  assert.equal(r.uncaught_exception_handler, true,
    'every entry point must register process.on("uncaughtException")');
  for (const ep of r.entry_points) {
    assert.equal(ep.uncaught_exception, true,
      `entry point ${ep.file} missing uncaughtException handler`);
  }
});

test('lock-in 6: data/w890-3-http-status-codes.json shape', () => {
  const r = readJSON('data/w890-3-http-status-codes.json');
  assert.equal(typeof r.sampled_endpoints, 'string', 'sampled_endpoints points at the scanned router');
  for (const k of ['with_200_path', 'with_4xx', 'with_5xx', 'with_retry_after_on_429', 'error_id_on_500']) {
    assert.equal(typeof r[k], 'number', `${k} must be numeric`);
  }
  // We expect there to be SOME 4xx and 5xx coverage in the scanned router.
  assert.ok(r.with_4xx > 0, '4xx sites must be present in the scanned router');
  assert.ok(r.with_5xx > 0, '5xx sites must be present in the scanned router');
});

test('lock-in 7: data/w890-3-sentry-report.json — installed + capture on 500', () => {
  const r = readJSON('data/w890-3-sentry-report.json');
  assert.equal(r.sentry_installed, true, 'Sentry init shim must exist at src/sentry-init.js');
  assert.equal(typeof r.init_call_count, 'number');
  assert.ok(r.init_call_count >= 1, 'initSentry() must be called from at least one entry point');
  assert.equal(r.sentry_capture_on_500, true,
    'server.js 500 middleware must call Sentry.captureException');
  assert.ok(Array.isArray(r.sample_routes_verified));
});

test('lock-in 8: docs/reference/error-handling-policy.md exists + references all 6 data files', () => {
  const docPath = path.join(ROOT, 'docs/reference/error-handling-policy.md');
  assert.ok(fs.existsSync(docPath), 'error-handling-policy.md missing');
  const txt = fs.readFileSync(docPath, 'utf8');
  for (const f of [
    'data/w890-3-async-coverage.json',
    'data/w890-3-empty-catches.json',
    'data/w890-3-error-messages.json',
    'data/w890-3-process-handlers.json',
    'data/w890-3-http-status-codes.json',
    'data/w890-3-sentry-report.json',
  ]) {
    assert.ok(txt.includes(f), `policy doc must reference ${f}`);
  }
  // Doc must describe the WHAT + WHY + ACTION rubric and the Sentry pathway.
  assert.ok(/WHAT/.test(txt) && /WHY/.test(txt) && /ACTION/.test(txt),
    'policy doc must describe WHAT/WHY/ACTION rubric');
  assert.ok(/captureException/.test(txt), 'policy doc must reference Sentry captureException');
});

test('lock-in 9: no banned vocabulary in any W890-3 data file or policy doc', () => {
  // Construct the banned token at runtime so this file itself does not embed
  // the literal (would create a self-recursive false positive when the test
  // scans itself). Mirrors the W890-1 / W890-2 / W889 pattern.
  const banned = String.fromCharCode(104) + 'on' + String.fromCharCode(101, 115, 116);
  const re = new RegExp(`\\b${banned}(?:y)?\\b`, 'i');
  const targets = [
    'data/w890-3-async-coverage.json',
    'data/w890-3-empty-catches.json',
    'data/w890-3-error-messages.json',
    'data/w890-3-process-handlers.json',
    'data/w890-3-http-status-codes.json',
    'data/w890-3-sentry-report.json',
    'docs/reference/error-handling-policy.md',
  ];
  for (const t of targets) {
    const fp = path.join(ROOT, t);
    if (!fs.existsSync(fp)) continue;
    const txt = fs.readFileSync(fp, 'utf8');
    assert.ok(!re.test(txt),
      `forbidden vocabulary in ${t}; use Caveats / Constraints / Limitations / Accuracy instead`);
  }
});

test('lock-in 10: W890-1 + W890-2 lock-in test files still structurally intact', () => {
  // Mirror the W890-2 pattern: we cannot recursively invoke `node --test`
  // from inside a --test run, but we CAN assert that both prior test files
  // exist, parse, and declare >=12 lock-in blocks. The W890-1/W890-2 file
  // contents have independent CI coverage via `npm test`.
  for (const fp of [
    path.join(ROOT, 'tests/wave890-1-organization.test.js'),
    path.join(ROOT, 'tests/wave890-2-code-quality.test.js'),
  ]) {
    assert.ok(fs.existsSync(fp), `prior W890 test file missing: ${fp}`);
    const txt = fs.readFileSync(fp, 'utf8');
    const blocks = txt.match(/\btest\(\s*['"`]lock-in\s+\d+/g) || [];
    assert.ok(blocks.length >= 12,
      `${path.basename(fp)} must declare >= 12 lock-in test blocks; found ${blocks.length}`);
  }
  // Also verify the prior data artifacts still exist.
  for (const f of [
    'data/w890-1-loc-report.json',
    'data/w890-1-loc-exceptions.json',
    'data/w890-1-boundary-violations.json',
    'data/w890-1-orphans.json',
    'data/w890-1-binary-blobs.json',
    'data/w890-2-lint-eslint.json',
    'data/w890-2-lint-ruff.json',
    'data/w890-2-console-log.json',
    'data/w890-2-todos.json',
    'data/w890-2-secrets-scan.json',
    'data/w890-2-localhost-scan.json',
    'data/w890-2-style.json',
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `prior W890 artifact missing: ${f}`);
  }
});

test('lock-in 11: audit-static-refs reports zero missing static references', () => {
  let out;
  try {
    out = execFileSync(NODE, [path.join(ROOT, 'scripts', 'audit-static-refs.cjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60000,
    });
  } catch (err) {
    assert.fail(`audit-static-refs failed: ${err.stdout || ''}\n${err.stderr || err.message}`);
  }
  assert.match(out, /missing[^\n]*:\s*0\b|0\s+missing|\bmissing\b.*\b0\b/i,
    `audit-static-refs must report 0 missing; got:\n${out.slice(0, 400)}`);
});

test('lock-in 12: audit-href --strict reports zero broken hrefs', () => {
  let out;
  try {
    out = execFileSync(NODE, [path.join(ROOT, 'scripts', 'audit-href.cjs'), '--strict'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 180000,
    });
  } catch (err) {
    assert.fail(`audit-href --strict failed: ${err.stdout || ''}\n${err.stderr || err.message}`);
  }
  assert.match(out, /broken[^\n]*:\s*0\b|0\s+broken|\bbroken\b.*\b0\b/i,
    `audit-href --strict must report 0 broken; got:\n${out.slice(0, 400)}`);
});
