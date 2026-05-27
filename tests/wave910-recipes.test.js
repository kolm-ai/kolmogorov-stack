// W910 Track C1 - recipe template + sample CSV contract tests.
//
// Each of the 8 templates must:
//   - parse as JSON with the documented schema
//   - point at a sample CSV under /public/samples/
//   - have a sample CSV that exists, has the right header columns, and at
//     least 10 data rows
// Plus the templates listing route surfaces every template and the detail
// route returns the right shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TPL_DIR = path.join(REPO_ROOT, 'data', 'recipes', 'templates');
const SAMPLES_DIR = path.join(REPO_ROOT, 'public', 'samples');

const EXPECTED = [
  'customer-support',
  'document-extractor',
  'medical-coding',
  'sales-qualifier',
  'text-classifier',
  'content-writer',
  'code-reviewer',
  'data-analyst',
];

const REQUIRED_KEYS = [
  'name', 'title', 'icon', 'description', 'default_describe',
  'sample_csv_url', 'recommended_student', 'recommended_target',
  'recommended_gate', 'expected_kscore', 'eval_criteria',
];

function loadTemplate(name) {
  return JSON.parse(fs.readFileSync(path.join(TPL_DIR, `${name}.json`), 'utf8'));
}

function parseCsvLines(raw) {
  // Minimal CSV split: respects double-quoted fields containing commas.
  const lines = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '"') {
      if (inQuotes && raw[i + 1] === '"') { cur += '"'; i++; continue; }
      inQuotes = !inQuotes;
      cur += c;
      continue;
    }
    if (c === '\n' && !inQuotes) {
      lines.push(cur);
      cur = '';
      continue;
    }
    if (c === '\r') continue;
    cur += c;
  }
  if (cur.length) lines.push(cur);
  return lines.filter((l) => l.length > 0);
}

// =====================================================================
// 1) All 8 templates present
// =====================================================================
test('W910 C1: 8 templates present on disk', () => {
  for (const name of EXPECTED) {
    assert.ok(fs.existsSync(path.join(TPL_DIR, `${name}.json`)), `template missing: ${name}`);
  }
});

// =====================================================================
// 2) Each template has the required schema keys + correct types
// =====================================================================
for (const name of EXPECTED) {
  test(`W910 C1: template ${name} matches required schema`, () => {
    const t = loadTemplate(name);
    for (const k of REQUIRED_KEYS) {
      assert.ok(k in t, `${name} missing required key ${k}`);
    }
    assert.equal(t.name, name, `${name} self-references wrong name`);
    assert.ok(typeof t.title === 'string' && t.title.length > 0);
    assert.ok(typeof t.description === 'string' && t.description.length >= 20);
    assert.ok(typeof t.default_describe === 'string' && t.default_describe.length >= 30);
    assert.ok(typeof t.recommended_student === 'string' && t.recommended_student.length > 0);
    assert.ok(typeof t.recommended_target === 'string' && t.recommended_target.length > 0);
    assert.ok(typeof t.recommended_gate === 'number' && t.recommended_gate > 0 && t.recommended_gate < 1);
    assert.ok(typeof t.expected_kscore === 'number' && t.expected_kscore > 0 && t.expected_kscore <= 1);
    assert.ok(t.expected_kscore >= t.recommended_gate, `${name} expected_kscore (${t.expected_kscore}) below gate (${t.recommended_gate})`);
    assert.ok(Array.isArray(t.eval_criteria) && t.eval_criteria.length >= 2, `${name} eval_criteria missing`);
    assert.equal(t.sample_csv_url, `/samples/${name}.csv`, `${name} sample_csv_url mismatch`);
  });
}

// =====================================================================
// 3) Each template's sample CSV exists, has header + 10+ rows
// =====================================================================
for (const name of EXPECTED) {
  test(`W910 C1: sample CSV ${name}.csv exists with header + >=10 rows`, () => {
    const p = path.join(SAMPLES_DIR, `${name}.csv`);
    assert.ok(fs.existsSync(p), `missing sample CSV ${name}.csv`);
    const raw = fs.readFileSync(p, 'utf8');
    const lines = parseCsvLines(raw);
    assert.ok(lines.length >= 11, `${name}.csv has ${lines.length} lines, need >= 11 (header + 10 rows)`);
    const header = lines[0].toLowerCase();
    const t = loadTemplate(name);
    if (t.input_col) {
      assert.ok(header.includes(t.input_col.toLowerCase()), `${name}.csv header missing input_col ${t.input_col}`);
    }
    if (t.output_col) {
      assert.ok(header.includes(t.output_col.toLowerCase()), `${name}.csv header missing output_col ${t.output_col}`);
    }
  });
}

// =====================================================================
// 4) listTemplates() loader returns all 8
// =====================================================================
test('W910 C1: src/recipe-templates.js listTemplates returns all 8 sorted', async () => {
  const mod = await import('../src/recipe-templates.js');
  const all = mod.listTemplates();
  assert.equal(all.length, EXPECTED.length, `got ${all.length}, want ${EXPECTED.length}`);
  const names = all.map((t) => t.name).sort();
  assert.deepEqual(names, [...EXPECTED].sort());
});

// =====================================================================
// 5) getTemplate(name) returns the template or null with input validation
// =====================================================================
test('W910 C1: getTemplate returns template for valid name and null for invalid', async () => {
  const mod = await import('../src/recipe-templates.js');
  const t = mod.getTemplate('customer-support');
  assert.ok(t && t.name === 'customer-support');
  assert.equal(mod.getTemplate('does-not-exist'), null);
  // Reject path traversal
  assert.equal(mod.getTemplate('../router'), null);
  assert.equal(mod.getTemplate(''), null);
});
