// Wave 581: redaction benchmark lock-ins.
//
// The redaction-quality requirement must not stay at "trust us". This pins a
// public synthetic fixture, a precision/recall/F1 runner, and two detector bugs
// found by the runner: phone redaction must not consume leading whitespace, and
// context-labeled account numbers must not be swallowed by the generic NPI
// invalid detector.

import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactPhi } from '../src/phi-redactor.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'redaction-public-benchmark.json');
const PACKAGE = path.join(ROOT, 'package.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('1. synthetic redaction fixture covers the public F1 classes', () => {
  const fixture = readJson(FIXTURE);
  assert.equal(fixture.schema, 'kolm-redaction-benchmark-fixture-1');
  const types = new Set((fixture.cases || []).flatMap((row) => (row.expected || []).map((exp) => exp.type)));
  for (const type of ['ssn', 'phone', 'email', 'dob', 'npi', 'mrn', 'account_no', 'address_fragment', 'ssn_malformed']) {
    assert.ok(types.has(type), `fixture missing ${type}`);
  }
});

test('2. redaction benchmark reports perfect synthetic precision/recall at the gate thresholds', () => {
  const stdout = execFileSync(process.execPath, [
    'scripts/bench-redaction-fixtures.mjs',
    '--min-f1', '0.95',
    '--min-recall', '0.95',
    '--max-fp', '0',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const report = JSON.parse(stdout);
  assert.equal(report.spec, 'kolm-redaction-benchmark-1');
  assert.equal(report.ok, true);
  assert.equal(report.totals.tp, 9);
  assert.equal(report.totals.fp, 0);
  assert.equal(report.totals.fn, 0);
  assert.equal(report.totals.f1, 1);
});

test('3. phone redaction preserves surrounding whitespace and hashes exact raw value', () => {
  const out = redactPhi('phone (415) 555-0134 ok');
  assert.equal(out.redacted_text, 'phone [PHI_PHONE_1] ok');
  assert.equal(out.map['[PHI_PHONE_1]'], '(415) 555-0134');
  assert.equal(out.findings[0].type, 'phone');
});

test('4. account number wins over generic invalid-NPI detection when context-labeled', () => {
  const out = redactPhi('Account: 1234567890');
  assert.equal(out.safe_to_send, true);
  assert.equal(out.findings.length, 1);
  assert.equal(out.findings[0].type, 'account_no');
  assert.equal(out.map['[PHI_ACCT_1]'], '1234567890');
});

test('5. depth verifier carries the redaction benchmark gate', () => {
  const pkg = readJson(PACKAGE);
  assert.ok(pkg.scripts['verify:redaction-benchmark'].includes('bench-redaction-fixtures.mjs'));
  assert.ok(pkg.scripts['verify:depth'].includes('bench-redaction-fixtures.mjs'));
});
