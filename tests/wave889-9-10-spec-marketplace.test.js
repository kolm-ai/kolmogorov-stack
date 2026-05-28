// W889-9.1 + W889-10.1 — .kolm v1.0 spec + marketplace landing lock-in.
//
// 15 invariants pinning:
//   * docs/spec/dot-kolm-v1.0.md exists with the canonical structure refs.
//   * docs/spec/dot-kolm-v1.0.json parses as JSON Schema draft-2020-12.
//   * scripts/dotkolm-validate.cjs exists and is invocable.
//   * 3 test vectors at tests/fixtures/dotkolm/ behave correctly under the
//     validator (2 pass, 1 fails with a clear error).
//   * docs/spec/ecosystem-prs.md lists >= 4 reader targets.
//   * public/marketplace.html contains the v2 teaser, the "coming soon"
//     phrase, an email form, and a link to /docs/spec/dot-kolm-v1.0.
//   * src/router.js carries POST /v1/marketplace/interest.
//   * src/auth.js PUBLIC_API admits /v1/marketplace/interest.
//   * none of the W889-9.1/10.1 newly-authored files contain the forbidden
//     vocabulary the operator banned site-wide (see test #15 builder).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');

// Files this wave is asserting NEVER carry the forbidden words.
const W889_AUTHORED = [
  'docs/spec/dot-kolm-v1.0.md',
  'docs/spec/dot-kolm-v1.0.json',
  'docs/spec/ecosystem-prs.md',
  'scripts/dotkolm-validate.cjs',
  'scripts/_build-dotkolm-fixtures.cjs',
  'tests/wave889-9-10-spec-marketplace.test.js',
  'public/docs/spec/dot-kolm-v1.0.html',
  'public/docs/spec/dot-kolm-v1.0.json',
];

test('W889-9.1 #1 — docs/spec/dot-kolm-v1.0.md exists', () => {
  const p = path.join(ROOT, 'docs', 'spec', 'dot-kolm-v1.0.md');
  assert.ok(fs.existsSync(p), 'docs/spec/dot-kolm-v1.0.md must exist');
  const txt = fs.readFileSync(p, 'utf8');
  assert.ok(txt.length > 1000, 'spec file must have substantive content (>1KB)');
});

test('W889-9.1 #2 — docs/spec/dot-kolm-v1.0.json is valid JSON', () => {
  const p = path.join(ROOT, 'docs', 'spec', 'dot-kolm-v1.0.json');
  assert.ok(fs.existsSync(p), 'dot-kolm-v1.0.json must exist');
  const txt = fs.readFileSync(p, 'utf8');
  const parsed = JSON.parse(txt);
  assert.equal(parsed.$schema, 'https://json-schema.org/draft/2020-12/schema',
    'schema must declare draft-2020-12');
  assert.ok(parsed.properties && typeof parsed.properties === 'object',
    'schema must declare a properties object');
  // Required fields the validator depends on.
  for (const k of ['spec', 'format_version', 'artifact_id', 'hashes', 'signature']) {
    assert.ok(parsed.properties[k], `schema must declare property "${k}"`);
  }
});

test('W889-9.1 #3 — spec references passport.json / weights/ / evidence_dag.json', () => {
  const txt = fs.readFileSync(path.join(ROOT, 'docs', 'spec', 'dot-kolm-v1.0.md'), 'utf8');
  assert.ok(/passport\.json/.test(txt), 'spec must reference passport.json');
  assert.ok(/weights\//.test(txt), 'spec must reference weights/');
  assert.ok(/evidence_dag\.json/.test(txt), 'spec must reference evidence_dag.json');
});

test('W889-9.1 #4 — scripts/dotkolm-validate.cjs exists', () => {
  const p = path.join(ROOT, 'scripts', 'dotkolm-validate.cjs');
  assert.ok(fs.existsSync(p), 'validator script must exist');
  const txt = fs.readFileSync(p, 'utf8');
  assert.ok(txt.length > 1000, 'validator must have substantive content');
  // Sanity: it must be a Node module that exits on success.
  assert.ok(/require\.main === module/.test(txt) || /module\.exports/.test(txt),
    'validator must be invocable as a script');
});

test('W889-9.1 #5 — validator passes valid-minimal.kolm (exit 0)', () => {
  const p = path.join(ROOT, 'tests', 'fixtures', 'dotkolm', 'valid-minimal.kolm');
  assert.ok(fs.existsSync(p), 'valid-minimal.kolm fixture must exist');
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'dotkolm-validate.cjs'),
    p,
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0,
    `validator must exit 0 on valid-minimal.kolm; stdout=${result.stdout} stderr=${result.stderr}`);
  assert.match(result.stdout, /^pass:/m, 'stdout must start with "pass:"');
});

test('W889-9.1 #6 — validator passes valid-full.kolm (exit 0)', () => {
  const p = path.join(ROOT, 'tests', 'fixtures', 'dotkolm', 'valid-full.kolm');
  assert.ok(fs.existsSync(p), 'valid-full.kolm fixture must exist');
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'dotkolm-validate.cjs'),
    p,
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0,
    `validator must exit 0 on valid-full.kolm; stdout=${result.stdout} stderr=${result.stderr}`);
  assert.match(result.stdout, /^pass:/m, 'stdout must start with "pass:"');
});

test('W889-9.1 #7 — validator rejects invalid-missing-passport.kolm (exit != 0, clear error)', () => {
  const p = path.join(ROOT, 'tests', 'fixtures', 'dotkolm', 'invalid-missing-passport.kolm');
  assert.ok(fs.existsSync(p), 'invalid-missing-passport.kolm fixture must exist');
  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts', 'dotkolm-validate.cjs'),
    p,
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.notEqual(result.status, 0, 'validator must exit non-zero on invalid bundle');
  // Clear error message naming the missing entry.
  assert.match(result.stdout + result.stderr, /passport\.json/,
    'error must name the missing passport.json entry');
});

test('W889-9.1 #8 — docs/spec/ecosystem-prs.md lists >= 4 ecosystem targets', () => {
  const p = path.join(ROOT, 'docs', 'spec', 'ecosystem-prs.md');
  assert.ok(fs.existsSync(p), 'ecosystem-prs.md must exist');
  const txt = fs.readFileSync(p, 'utf8');
  // Targets are headings like "## Target N: ..."
  const targets = txt.match(/^## Target \d+:/gm) || [];
  assert.ok(targets.length >= 4,
    `ecosystem-prs.md must list >= 4 targets; found ${targets.length}: ${targets.join(', ')}`);
  // Each target row must declare a STATUS.
  const statusRows = txt.match(/STATUS\*\*:\s*`(drafted|prepared|submitted|revisions|merged|closed)`/g) || [];
  assert.ok(statusRows.length >= 4,
    `each ecosystem target must declare a STATUS; found ${statusRows.length}`);
});

test('W889-10.1 #9 — public/marketplace.html exists', () => {
  const p = path.join(ROOT, 'public', 'marketplace.html');
  assert.ok(fs.existsSync(p), 'public/marketplace.html must exist');
});

test('W889-10.1 #10 — marketplace.html teaser signals the not-yet-launched state', () => {
  const txt = fs.readFileSync(path.join(ROOT, 'public', 'marketplace.html'), 'utf8');
  // The v2 premium-marketplace teaser was authored (W891 V1, cc9f6ea7) to
  // signal the not-yet-public state with the phrase "early access" rather
  // than a literal "coming soon" - update the lock-in to the wording the
  // page deliberately ships.
  assert.ok(/early access/i.test(txt),
    'marketplace.html teaser must signal the not-yet-launched state ("early access")');
});

test('W889-10.1 #11 — marketplace.html has a <form> with an email input', () => {
  const txt = fs.readFileSync(path.join(ROOT, 'public', 'marketplace.html'), 'utf8');
  // Form must exist; an input of type="email" must exist; both must be in
  // the same form. We rely on the W889-10.1 form id "mk-interest-form".
  assert.ok(/<form[^>]*id="mk-interest-form"/i.test(txt),
    'marketplace.html must include the v2 interest <form>');
  assert.ok(/<input[^>]*type="email"/i.test(txt),
    'marketplace.html must include an <input type="email">');
});

test('W889-10.1 #12 — marketplace.html links to /docs/spec/dot-kolm-v1.0', () => {
  const txt = fs.readFileSync(path.join(ROOT, 'public', 'marketplace.html'), 'utf8');
  assert.ok(/\/docs\/spec\/dot-kolm-v1\.0/.test(txt),
    'marketplace.html must link to /docs/spec/dot-kolm-v1.0 (open standards mention)');
});

test('W889-10.1 #13 — src/router.js has POST /v1/marketplace/interest', () => {
  const txt = fs.readFileSync(path.join(ROOT, 'src', 'router.js'), 'utf8');
  // Express style: r.post('/v1/marketplace/interest', ...)
  assert.ok(
    /r\.post\(\s*['"]\/v1\/marketplace\/interest['"]/.test(txt),
    'src/router.js must register POST /v1/marketplace/interest',
  );
});

test('W889-10.1 #14 — /v1/marketplace/interest is in src/auth.js PUBLIC_API', () => {
  const txt = fs.readFileSync(path.join(ROOT, 'src', 'auth.js'), 'utf8');
  // The PUBLIC_API arrow function is a chain of OR clauses; the literal
  // string match is the simplest stable assertion.
  assert.ok(
    /p === ['"]\/v1\/marketplace\/interest['"]/.test(txt),
    'src/auth.js PUBLIC_API must admit /v1/marketplace/interest',
  );
});

test('W889 #15 — no W889-authored file contains the forbidden vocabulary', () => {
  // Built at runtime from char codes so this test file itself does not
  // contain the literal banned strings (which would self-fail the check).
  const forbiddenA = String.fromCharCode(104, 111, 110, 101, 115, 116);       // 6 letters
  const forbiddenB = String.fromCharCode(104, 111, 110, 101, 115, 116, 121);  // 7 letters
  const reA = new RegExp('\\b' + forbiddenA + '\\b');
  const reB = new RegExp('\\b' + forbiddenB + '\\b');
  for (const rel of W889_AUTHORED) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    const txt = fs.readFileSync(p, 'utf8').toLowerCase();
    assert.ok(!reB.test(txt),
      `${rel} must not contain the longer forbidden token`);
    assert.ok(!reA.test(txt),
      `${rel} must not contain the shorter forbidden token`);
  }
});
