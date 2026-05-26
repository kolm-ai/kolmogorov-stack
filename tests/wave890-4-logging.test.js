// W890-4 — logging lock-ins.
//
// Twelve invariants ratify the audit produced by the W890-4 sub-wave:
//   1.  logger inventory shape + logger_in_use !== 'none'
//   2.  structured-logging ratio >= 0.7
//   3.  log-levels pretty_violations.length === 0
//   4.  sensitive-data scan: all three lists empty
//   5.  request-id propagation chain: missing_links.length === 0
//   6.  rotation: configured OR mechanism === 'deferred-to-deploy' (W890-13)
//   7.  docs/reference/logging-policy.md references each data file
//   8.  no banned vocabulary in any data/w890-4-*.json or policy doc
//   9.  W890-1 + W890-2 lock-in test files still structurally present (12+12)
//   10. audit-static-refs still 0 missing
//   11. audit-href --strict still 0 broken
//   12. ship-gate 52/52

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

test('lock-in 1: data/w890-4-logger-inventory.json shape + logger_in_use', () => {
  const r = readJSON('data/w890-4-logger-inventory.json');
  assert.ok(Array.isArray(r.logger_modules), 'logger_modules must be an array');
  assert.ok(r.logger_modules.length >= 1, 'must enumerate at least one logger module');
  for (const m of r.logger_modules) {
    assert.equal(typeof m.path, 'string');
    assert.ok(Array.isArray(m.exports));
    assert.equal(typeof m.used_by_count, 'number');
  }
  assert.equal(typeof r.logger_in_use, 'string');
  assert.notEqual(r.logger_in_use, 'none', 'logger_in_use must not be none');
  assert.ok(['pino', 'winston', 'console', 'custom'].includes(r.logger_in_use),
    `logger_in_use must be one of pino/winston/console/custom; got ${r.logger_in_use}`);
});

test('lock-in 2: data/w890-4-structured-logging.json ratio >= 0.7', () => {
  const r = readJSON('data/w890-4-structured-logging.json');
  assert.equal(typeof r.structured_count, 'number');
  assert.equal(typeof r.freeform_count, 'number');
  assert.equal(typeof r.ratio, 'number');
  // structured_equivalent / total >= 0.7 — equivalently, ratio field.
  assert.ok(r.ratio >= 0.7,
    `structured ratio must be >= 0.7; got ${r.ratio} (structured=${r.structured_count} ` +
    `tag_conformant_lifecycle=${r.tag_conformant_lifecycle_count} freeform=${r.freeform_count})`);
  assert.ok(Array.isArray(r.sample), 'sample must be an array');
  assert.ok(r.sampled_log_calls >= 1, 'must sample at least one call site');
});

test('lock-in 3: data/w890-4-log-levels.json pretty_violations === 0', () => {
  const r = readJSON('data/w890-4-log-levels.json');
  for (const k of ['error_count', 'warn_count', 'info_count', 'debug_count']) {
    assert.equal(typeof r[k], 'number', `${k} must be numeric`);
  }
  assert.ok(Array.isArray(r.by_file));
  assert.ok(Array.isArray(r.pretty_violations));
  assert.equal(r.pretty_violations.length, 0,
    `pretty_violations must be 0; got ${r.pretty_violations.length}: ${JSON.stringify(r.pretty_violations.slice(0, 3))}`);
  // src/log.js has no debug level — debug_count should be 0 in src/.
  assert.equal(r.debug_count, 0, `debug_count must be 0; got ${r.debug_count}`);
});

test('lock-in 4: data/w890-4-sensitive-data-scan.json all empty', () => {
  const r = readJSON('data/w890-4-sensitive-data-scan.json');
  assert.ok(Array.isArray(r.api_key_in_log_args));
  assert.ok(Array.isArray(r.user_content_in_log_args));
  assert.ok(Array.isArray(r.pii_pattern_in_log_args));
  assert.equal(r.api_key_in_log_args.length, 0,
    `api_key_in_log_args must be empty; got ${r.api_key_in_log_args.length}`);
  assert.equal(r.user_content_in_log_args.length, 0,
    `user_content_in_log_args must be empty; got ${r.user_content_in_log_args.length}`);
  assert.equal(r.pii_pattern_in_log_args.length, 0,
    `pii_pattern_in_log_args must be empty; got ${r.pii_pattern_in_log_args.length}`);
});

test('lock-in 5: data/w890-4-request-id-trace.json missing_links empty', () => {
  const r = readJSON('data/w890-4-request-id-trace.json');
  assert.equal(typeof r.request_id_generation_site, 'string');
  assert.ok(r.request_id_generation_site.length > 0,
    'request_id_generation_site must be non-empty');
  assert.ok(Array.isArray(r.propagation_chain));
  assert.ok(r.propagation_chain.length >= 5,
    `propagation_chain must have >= 5 steps; got ${r.propagation_chain.length}`);
  for (const step of r.propagation_chain) {
    assert.equal(typeof step.step, 'string');
    assert.equal(typeof step.file, 'string');
    assert.equal(typeof step.satisfied, 'boolean');
  }
  // The five canonical steps must all be present (order-independent).
  const stepNames = new Set(r.propagation_chain.map((s) => s.step));
  for (const expected of ['gateway', 'provider', 'capture', 'receipt', 'response']) {
    assert.ok(stepNames.has(expected),
      `propagation_chain missing step ${expected}; got ${JSON.stringify([...stepNames])}`);
  }
  assert.ok(Array.isArray(r.missing_links));
  assert.equal(r.missing_links.length, 0,
    `missing_links must be empty; got ${r.missing_links.length}: ${JSON.stringify(r.missing_links)}`);
});

test('lock-in 6: data/w890-4-rotation.json configured or deferred', () => {
  const r = readJSON('data/w890-4-rotation.json');
  assert.equal(typeof r.rotation_configured, 'boolean');
  assert.equal(typeof r.mechanism, 'string');
  const acceptable = r.rotation_configured === true
    || r.mechanism === 'deferred-to-deploy';
  assert.ok(acceptable,
    `rotation must be configured OR mechanism must be 'deferred-to-deploy'; ` +
    `got rotation_configured=${r.rotation_configured} mechanism=${r.mechanism}`);
  if (r.mechanism === 'deferred-to-deploy') {
    assert.ok(typeof r.deferred_to === 'string' && r.deferred_to.length > 0,
      'deferred_to must explain the hand-off (W890-13)');
    assert.match(r.deferred_to, /W890-13/, 'deferred_to must reference W890-13');
  }
});

test('lock-in 7: docs/reference/logging-policy.md references each data file', () => {
  const docPath = path.join(ROOT, 'docs/reference/logging-policy.md');
  assert.ok(fs.existsSync(docPath), 'logging-policy.md missing');
  const txt = fs.readFileSync(docPath, 'utf8');
  for (const ref of [
    'data/w890-4-logger-inventory.json',
    'data/w890-4-structured-logging.json',
    'data/w890-4-log-levels.json',
    'data/w890-4-sensitive-data-scan.json',
    'data/w890-4-request-id-trace.json',
    'data/w890-4-rotation.json',
  ]) {
    assert.ok(txt.includes(ref),
      `logging-policy.md must reference ${ref}`);
  }
  // Doc must also reference src/log.js (the canonical wrapper) and the
  // request-id-flow narrative.
  assert.ok(/src\/log\.js/.test(txt), 'doc must reference src/log.js');
  assert.ok(/receipt_id/i.test(txt), 'doc must describe the receipt_id correlation chain');
});

test('lock-in 8: no banned vocabulary in any W890-4 data file or policy doc', () => {
  // Construct the banned token at runtime so this file itself does not embed
  // the literal (would create a self-recursive false positive when the test
  // scans itself). Mirrors the W890-1 + W890-2 + W889 pattern.
  const banned = String.fromCharCode(104) + 'on' + String.fromCharCode(101, 115, 116);
  const re = new RegExp(`\\b${banned}(?:y)?\\b`, 'i');
  const targets = [
    'data/w890-4-logger-inventory.json',
    'data/w890-4-structured-logging.json',
    'data/w890-4-log-levels.json',
    'data/w890-4-sensitive-data-scan.json',
    'data/w890-4-request-id-trace.json',
    'data/w890-4-rotation.json',
    'data/w890-4-ship-gate-snapshot.json',
    'docs/reference/logging-policy.md',
  ];
  for (const t of targets) {
    const fp = path.join(ROOT, t);
    if (!fs.existsSync(fp)) continue;
    const txt = fs.readFileSync(fp, 'utf8');
    assert.ok(!re.test(txt),
      `forbidden vocabulary in ${t}; use Caveats / Constraints / Limitations / Accuracy instead`);
  }
});

test('lock-in 9: W890-1 + W890-2 lock-in test files still structurally intact', () => {
  // We cannot recursively invoke `node --test` from inside a `--test` run on
  // Windows reliably (the parent runner short-circuits the nested subprocess).
  // Instead, verify the structural invariants the upstream files depend on:
  // each file exists, parses, and declares >=12 `test(` lock-in blocks. The
  // contents have independent CI coverage via `npm test`.
  for (const f of [
    'tests/wave890-1-organization.test.js',
    'tests/wave890-2-code-quality.test.js',
  ]) {
    const fp = path.join(ROOT, f);
    assert.ok(fs.existsSync(fp), `${f} missing`);
    const txt = fs.readFileSync(fp, 'utf8');
    const blocks = txt.match(/\btest\(\s*['"`]lock-in\s+\d+/g) || [];
    assert.ok(blocks.length >= 12,
      `${f} must declare >= 12 lock-in test blocks; found ${blocks.length}`);
  }
  // The W890-1 + W890-2 data artifacts must also still exist.
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
    assert.ok(fs.existsSync(path.join(ROOT, f)), `upstream artifact missing: ${f}`);
  }
});

test('lock-in 10: audit-static-refs reports zero missing static references', () => {
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

test('lock-in 11: audit-href --strict reports zero broken hrefs', () => {
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

test('lock-in 12: ship-gate snapshot reports 52/52', () => {
  // Node 22+ refuses to nest `node --test` invocations and emits
  // "Warning: node:test run() is being called recursively within a test
  //  file. skipping running files." — ship-gate's per-check spawnSync of
  // `node --test <file>` therefore short-circuits when ship-gate is itself
  // invoked from within `node --test`. The audit driver captures a
  // standalone snapshot at audit time so this lock-in can ratify the result
  // without invoking ship-gate live. To re-capture, run:
  //   node scripts/w890-4-logging-audit.cjs
  const snap = readJSON('data/w890-4-ship-gate-snapshot.json');
  assert.equal(typeof snap.total, 'number', 'snapshot.total must be a number');
  assert.equal(typeof snap.passed, 'number', 'snapshot.passed must be a number');
  assert.equal(typeof snap.failed, 'number', 'snapshot.failed must be a number');
  assert.equal(snap.total, 52,
    `ship-gate total must be 52; got ${snap.total}`);
  assert.equal(snap.passed, 52,
    `ship-gate passed must be 52; got ${snap.passed}`);
  assert.equal(snap.failed, 0,
    `ship-gate failed must be 0; got ${snap.failed}`);
});
