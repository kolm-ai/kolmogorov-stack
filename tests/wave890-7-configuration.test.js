// W890-7 — configuration management lock-ins.
//
// Twelve invariants ratify the audit produced by the W890-7 sub-wave:
//   1. env-var inventory shape valid + zero user-facing undocumented
//   2. defaults audit shape valid + without_default <= 5
//   3. zero-config doctor exit_code === 0
//   4. hierarchy trace shows CLI > env > user > project > default
//   5. secret-leak scan: every category is 0
//   6. .gitignore: missing.length === 0
//   7. configuration-policy.md exists + cross-links to config-toml.md
//   8. .gitignore re-read: contains all required entries
//   9. no banned vocabulary in any W890-7 data file or policy doc
//  10. W890-1 + W890-2 lock-in files still present + structurally intact
//  11. audit-static-refs still 0 missing
//  12. audit-href --strict still 0 broken

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

test('lock-in 1: data/w890-7-env-vars.json shape + zero user-facing undocumented', () => {
  const r = readJSON('data/w890-7-env-vars.json');
  assert.equal(typeof r.total_env_vars_referenced_in_code, 'number');
  assert.equal(typeof r.documented_in_env_example, 'number');
  assert.ok(Array.isArray(r.undocumented), 'undocumented must be an array');
  assert.ok(Array.isArray(r.undocumented_user_facing), 'undocumented_user_facing must be an array');
  assert.equal(r.undocumented_user_facing.length, 0,
    `every user-facing env var must be in .env.example; missing: ${r.undocumented_user_facing.join(', ')}`);
  assert.ok(Array.isArray(r.examples_required), 'examples_required must be an array');
});

test('lock-in 2: data/w890-7-defaults.json shape + without_default <= 5', () => {
  const r = readJSON('data/w890-7-defaults.json');
  assert.equal(typeof r.sampled_total, 'number');
  assert.equal(typeof r.with_default, 'number');
  assert.equal(typeof r.without_default_count, 'number');
  assert.ok(Array.isArray(r.without_default), 'without_default must be an array');
  assert.ok(Array.isArray(r.sampled), 'sampled must be an array');
  assert.ok(r.without_default_count <= 5,
    `without_default must be <=5; got ${r.without_default_count}: ${JSON.stringify(r.without_default).slice(0, 400)}`);
});

test('lock-in 3: zero-config doctor exit_code === 0 + blockers === 0', () => {
  const r = readJSON('data/w890-7-zero-config-doctor.json');
  assert.equal(r.exit_code, 0, `kolm doctor in pristine HOME must exit 0; got ${r.exit_code}`);
  assert.equal(r.blockers, 0, `kolm doctor must have 0 blockers; got ${r.blockers}`);
  assert.ok(Array.isArray(r.critical_failures), 'critical_failures must be an array');
});

test('lock-in 4: data/w890-7-hierarchy.json shows CLI > env > user > project > default', () => {
  const r = readJSON('data/w890-7-hierarchy.json');
  assert.ok(Array.isArray(r.traces), 'traces must be an array');
  assert.ok(r.traces.length >= 5, `must have at least 5 layer traces; got ${r.traces.length}`);
  const seen = new Set();
  for (const t of r.traces) {
    assert.equal(typeof t.layer, 'string');
    assert.equal(typeof t.pass, 'boolean');
    assert.equal(t.pass, true,
      `trace ${t.layer} failed: value=${t.value} source=${t.source} expected_source=${t.expected_source}`);
    seen.add(t.layer);
  }
  for (const required of ['defaults', 'project', 'user', 'env', 'flag']) {
    assert.ok(seen.has(required), `hierarchy must trace layer "${required}"; got ${[...seen].join(', ')}`);
  }
  assert.equal(r.pass, true, 'overall hierarchy trace must pass');
});

test('lock-in 5: data/w890-7-secret-leak-scan.json: every category is 0', () => {
  const r = readJSON('data/w890-7-secret-leak-scan.json');
  for (const cat of ['git_history', 'error_messages', 'logs', 'client_side_js', 'openapi_responses']) {
    assert.equal(typeof r[cat], 'number', `${cat} must be a number`);
    assert.equal(r[cat], 0, `${cat} must be 0; got ${r[cat]}`);
  }
});

test('lock-in 6: data/w890-7-gitignore.json: missing.length === 0', () => {
  const r = readJSON('data/w890-7-gitignore.json');
  assert.ok(Array.isArray(r.required), 'required must be an array');
  assert.ok(Array.isArray(r.present), 'present must be an array');
  assert.ok(Array.isArray(r.missing), 'missing must be an array');
  assert.equal(r.missing.length, 0,
    `.gitignore is missing required entries: ${r.missing.join(', ')}`);
});

test('lock-in 7: docs/reference/configuration-policy.md exists + cross-links config-toml.md', () => {
  const docPath = path.join(ROOT, 'docs/reference/configuration-policy.md');
  assert.ok(fs.existsSync(docPath), 'configuration-policy.md missing');
  const txt = fs.readFileSync(docPath, 'utf8');
  assert.ok(/config-toml\.md/.test(txt), 'doc must cross-link to config-toml.md');
  assert.ok(/Hierarchy/.test(txt), 'doc must describe the hierarchy');
  assert.ok(/Zero-config/.test(txt) || /zero-config/.test(txt), 'doc must describe zero-config operation');
  assert.ok(/Secret/.test(txt), 'doc must describe secret handling');
  assert.ok(/\.gitignore/.test(txt), 'doc must describe .gitignore policy');
});

test('lock-in 8: .gitignore contains all required W890-7 entries (re-read source of truth)', () => {
  const txt = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  const lines = txt.split('\n').map(l => l.trim());
  // .env (exact or .env*)
  assert.ok(lines.some(l => /^\.env\b/.test(l)), '.gitignore must ignore .env');
  // *.key
  assert.ok(lines.some(l => /^\*\.key\b/.test(l)), '.gitignore must ignore *.key');
  // *.pem
  assert.ok(lines.some(l => /^\*\.pem\b/.test(l)), '.gitignore must ignore *.pem');
  // user TOML
  assert.ok(lines.some(l => /(\.kolm\/config\.toml|kolm\/config\.toml)/.test(l)),
    '.gitignore must ignore ~/.kolm/config.toml');
  // captures.db
  assert.ok(lines.some(l => /(captures\.db|\*\.db|\.sqlite)/.test(l)),
    '.gitignore must ignore captures.db (or covering *.db / *.sqlite rule)');
});

test('lock-in 9: no banned vocabulary in any W890-7 data file or policy doc', () => {
  // Construct the banned token at runtime so this file itself does not embed
  // the literal (would create a self-recursive false positive). Mirrors the
  // W890-1 + W890-2 + W889 pattern.
  const banned = String.fromCharCode(104) + 'on' + String.fromCharCode(101, 115, 116);
  const re = new RegExp(`\\b${banned}(?:y)?\\b`, 'i');
  const targets = [
    'data/w890-7-env-vars.json',
    'data/w890-7-defaults.json',
    'data/w890-7-zero-config-doctor.json',
    'data/w890-7-hierarchy.json',
    'data/w890-7-secret-leak-scan.json',
    'data/w890-7-gitignore.json',
    'docs/reference/configuration-policy.md',
  ];
  for (const t of targets) {
    const fp = path.join(ROOT, t);
    if (!fs.existsSync(fp)) continue;
    const txt = fs.readFileSync(fp, 'utf8');
    assert.ok(!re.test(txt),
      `forbidden vocabulary in ${t}; use Caveats / Constraints / Limitations / Accuracy instead`);
  }
});

test('lock-in 10: W890-1 + W890-2 test files still present + structurally intact', () => {
  for (const f of ['tests/wave890-1-organization.test.js', 'tests/wave890-2-code-quality.test.js']) {
    const fp = path.join(ROOT, f);
    assert.ok(fs.existsSync(fp), `${f} missing`);
    const txt = fs.readFileSync(fp, 'utf8');
    const blocks = txt.match(/\btest\(\s*['"`]lock-in\s+\d+/g) || [];
    assert.ok(blocks.length >= 12, `${f} must declare >= 12 lock-in test blocks; found ${blocks.length}`);
  }
  for (const f of [
    'data/w890-1-loc-report.json',
    'data/w890-1-orphans.json',
    'data/w890-2-secrets-scan.json',
    'data/w890-2-localhost-scan.json',
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `W890-1/W890-2 artifact missing: ${f}`);
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
