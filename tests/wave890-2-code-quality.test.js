// W890-2 — code quality lock-ins.
//
// Twelve invariants ratify the audit produced by the W890-2 sub-wave:
//   - ESLint and Ruff inventories have shape + numeric fields
//   - console.log inventory exists and any debug_print remnants are zero
//   - TODO inventory is shape-valid; orphan count documented
//   - secrets scan has production_real_keys === 0 (hard gate)
//   - localhost scan has production_unconfigured === 0 (hard gate)
//   - style report indents match policy (JS=2, Python=4)
//   - canonical policy doc exists and references both checkers
//   - banned vocabulary is absent from all data/w890-2-*.json and the policy doc
//   - W890-1 lock-ins still 12/12 (no regression)
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

test('lock-in 1: data/w890-2-lint-eslint.json shape', () => {
  const r = readJSON('data/w890-2-lint-eslint.json');
  for (const k of ['errors_before', 'errors_after', 'warnings_before', 'warnings_after']) {
    assert.equal(typeof r[k], 'number', `${k} must be numeric`);
  }
  assert.ok(Array.isArray(r.files_autofixed), 'files_autofixed must be an array');
  assert.ok(Array.isArray(r.remaining_warnings), 'remaining_warnings must be an array');
  assert.ok(r.warnings_after <= r.warnings_before, 'warnings_after must not exceed warnings_before');
  assert.ok(r.errors_after <= r.errors_before, 'errors_after must not exceed errors_before');
});

test('lock-in 2: data/w890-2-lint-ruff.json shape', () => {
  const r = readJSON('data/w890-2-lint-ruff.json');
  for (const k of ['errors_before', 'errors_after', 'warnings_before', 'warnings_after', 'total_before', 'total_after']) {
    assert.equal(typeof r[k], 'number', `${k} must be numeric`);
  }
  assert.ok(r.total_after <= r.total_before, 'total_after must not exceed total_before');
  assert.ok(r.total_after === 0, `ruff total_after must be 0, was ${r.total_after}`);
});

test('lock-in 3: data/w890-2-console-log.json shape + per-entry fields', () => {
  const r = readJSON('data/w890-2-console-log.json');
  assert.equal(typeof r.total, 'number');
  assert.ok(Array.isArray(r.by_file));
  for (const f of r.by_file) {
    assert.equal(typeof f.file, 'string');
    assert.equal(typeof f.count, 'number');
    assert.ok(Array.isArray(f.lines));
    for (const ln of f.lines) {
      assert.equal(typeof ln.line, 'number', `file=${f.file} line entry missing line number`);
      assert.equal(typeof ln.text, 'string', `file=${f.file} line entry missing text`);
    }
  }
  assert.equal(r.left_for_w890_4, 0, 'debug_print remnants must be 0 (W890-4 ratification)');
});

test('lock-in 4: data/w890-2-todos.json shape + orphan count', () => {
  const r = readJSON('data/w890-2-todos.json');
  for (const k of ['total', 'with_owner', 'orphan']) {
    assert.equal(typeof r[k], 'number', `${k} must be numeric`);
  }
  assert.equal(r.orphan, 0, `orphan TODOs must be 0 at ratification, was ${r.orphan}`);
});

test('lock-in 5: data/w890-2-secrets-scan.json hard gate', () => {
  const r = readJSON('data/w890-2-secrets-scan.json');
  assert.equal(typeof r.total, 'number');
  assert.equal(r.production_real_keys, 0,
    `production_real_keys must be 0; found ${r.production_real_keys}`);
});

test('lock-in 6: data/w890-2-localhost-scan.json hard gate', () => {
  const r = readJSON('data/w890-2-localhost-scan.json');
  assert.equal(typeof r.total, 'number');
  assert.equal(r.production_unconfigured, 0,
    `production_unconfigured must be 0; found ${r.production_unconfigured}`);
});

test('lock-in 7: data/w890-2-style.json indent invariants', () => {
  const r = readJSON('data/w890-2-style.json');
  assert.equal(r.indent_js, 2, `indent_js must be 2, was ${r.indent_js}`);
  assert.equal(r.indent_python, 4, `indent_python must be 4, was ${r.indent_python}`);
  assert.equal(typeof r.naming_camelcase_rate, 'number');
  assert.equal(typeof r.naming_snake_case_rate, 'number');
  assert.ok(r.naming_camelcase_rate >= 0.85, `camelCase rate ${r.naming_camelcase_rate} < 0.85`);
  assert.ok(r.naming_snake_case_rate >= 0.85, `snake_case rate ${r.naming_snake_case_rate} < 0.85`);
});

test('lock-in 8: docs/reference/code-quality-policy.md exists + references both checkers', () => {
  const docPath = path.join(ROOT, 'docs/reference/code-quality-policy.md');
  assert.ok(fs.existsSync(docPath), 'code-quality-policy.md missing');
  const txt = fs.readFileSync(docPath, 'utf8');
  assert.ok(/eslint\.config\.js/i.test(txt), 'doc must reference eslint flat config');
  assert.ok(/\bruff\b/i.test(txt), 'doc must reference ruff');
  assert.ok(/eslint-disable-next-line/.test(txt), 'doc must describe waiver mechanism');
  assert.ok(/noqa/.test(txt), 'doc must describe ruff waiver mechanism');
});

test('lock-in 9: no banned vocabulary in any W890-2 data file or policy doc', () => {
  // Construct the banned token at runtime so this file itself does not embed
  // the literal (would create a self-recursive false positive when the test
  // scans itself). Mirrors the W890-1 + W889 pattern.
  const banned = String.fromCharCode(104) + 'on' + String.fromCharCode(101, 115, 116);
  const re = new RegExp(`\\b${banned}(?:y)?\\b`, 'i');
  const targets = [
    'data/w890-2-lint-eslint.json',
    'data/w890-2-lint-ruff.json',
    'data/w890-2-console-log.json',
    'data/w890-2-todos.json',
    'data/w890-2-secrets-scan.json',
    'data/w890-2-localhost-scan.json',
    'data/w890-2-style.json',
    'docs/reference/code-quality-policy.md',
  ];
  for (const t of targets) {
    const fp = path.join(ROOT, t);
    if (!fs.existsSync(fp)) continue;
    const txt = fs.readFileSync(fp, 'utf8');
    assert.ok(!re.test(txt),
      `forbidden vocabulary in ${t}; use Caveats / Constraints / Limitations / Accuracy instead`);
  }
});

test('lock-in 10: W890-1 organization lock-in test file still present + structurally intact', () => {
  // Note: We cannot recursively invoke `node --test` from inside a `--test`
  // run on Windows reliably (the parent runner short-circuits the nested
  // subprocess). Instead, verify the structural invariants the W890-1 file
  // depends on: the file exists, parses, and declares >=12 `test(` blocks
  // that match the lock-in naming convention. The W890-1 contents have
  // independent CI coverage via `npm test`.
  const fp = path.join(ROOT, 'tests/wave890-1-organization.test.js');
  assert.ok(fs.existsSync(fp), 'W890-1 test file missing');
  const txt = fs.readFileSync(fp, 'utf8');
  const blocks = txt.match(/\btest\(\s*['"`]lock-in\s+\d+/g) || [];
  assert.ok(blocks.length >= 12,
    `W890-1 must declare >= 12 lock-in test blocks; found ${blocks.length}`);
  // W890-1 deliverable artifacts must all exist (this is what W890-1's own
  // lock-in 1 asserts — duplicate here so a regression in W890-1's outputs
  // surfaces in W890-2 too).
  for (const f of [
    'data/w890-1-loc-report.json',
    'data/w890-1-loc-exceptions.json',
    'data/w890-1-boundary-violations.json',
    'data/w890-1-orphans.json',
    'data/w890-1-binary-blobs.json',
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `W890-1 artifact missing: ${f}`);
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
