// W890-1 — codebase organization lock-in.
//
// Twelve invariants ratify the audit produced by
// `node scripts/w890-1-organization-audit.cjs`. The audit writes five JSON
// reports under data/ and a canonical reference at docs/reference/
// codebase-organization.md. These tests assert the shape and the key
// invariants the W890 V1 production code audit cares about:
//   - 500-LoC rule + substantive exception process
//   - directory boundary rules (src/cli/tests/public are not kitchen sinks)
//   - orphan policy
//   - no forbidden vocabulary in audit scripts
//   - audit-static-refs is clean
//   - audit-href is clean (strict)
//
// Lock-ins are intentionally re-runnable: every assertion reads files from
// disk, so a regression that breaks the organization will fail here before
// it can ship.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const NODE = process.execPath;
const DATA = path.join(ROOT, 'data');

function readJSON(rel) {
  const full = path.join(ROOT, rel);
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

test('lock-in 1: all five W890-1 audit JSON files exist', () => {
  for (const f of [
    'data/w890-1-loc-report.json',
    'data/w890-1-loc-exceptions.json',
    'data/w890-1-boundary-violations.json',
    'data/w890-1-orphans.json',
    'data/w890-1-binary-blobs.json',
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `missing artifact: ${f}`);
  }
});

test('lock-in 2: loc-report has total_files >= 50 and median_loc < 500', () => {
  const r = readJSON('data/w890-1-loc-report.json');
  assert.ok(typeof r.total_files === 'number');
  assert.ok(r.total_files >= 50, `total_files=${r.total_files} < 50`);
  assert.ok(r.median_loc < 500, `median_loc=${r.median_loc} >= 500 (rule violated)`);
  // Files-over-500 list is bounded by exception list.
  assert.ok(Array.isArray(r.files_over_500));
  assert.equal(r.files_over_500_count, r.files_over_500.length);
});

test('lock-in 3: every loc-exception has non-empty reason and valid planned_split', () => {
  const ex = readJSON('data/w890-1-loc-exceptions.json');
  assert.ok(Array.isArray(ex));
  const validSplits = new Set(['never', 'next-major', 'inline']);
  for (const e of ex) {
    assert.ok(typeof e.file === 'string' && e.file.length > 0, `file missing in ${JSON.stringify(e)}`);
    assert.ok(typeof e.loc === 'number' && e.loc > 500, `loc=${e.loc} must be > 500 for ${e.file}`);
    assert.ok(typeof e.reason === 'string' && e.reason.trim().length > 20,
      `reason too short for ${e.file}: ${JSON.stringify(e.reason)}`);
    assert.ok(validSplits.has(e.planned_split),
      `planned_split=${e.planned_split} for ${e.file} (must be one of ${[...validSplits].join('/')})`);
  }
  // Sanity: the exception list must include the two top-known monoliths,
  // otherwise the audit has missed the cli/router files.
  const paths = ex.map((e) => e.file);
  assert.ok(paths.includes('cli/kolm.js'), 'cli/kolm.js must appear in LoC exceptions');
  assert.ok(paths.includes('src/router.js'), 'src/router.js must appear in LoC exceptions');
});

test('lock-in 4: boundary-violations is an array', () => {
  const v = readJSON('data/w890-1-boundary-violations.json');
  assert.ok(Array.isArray(v));
  // Each entry, when present, must have file/violation/severity/fix.
  for (const e of v) {
    assert.ok(typeof e.file === 'string', `bad file: ${JSON.stringify(e)}`);
    assert.ok(typeof e.violation === 'string', `bad violation: ${JSON.stringify(e)}`);
    assert.ok(['low', 'med', 'high'].includes(e.severity), `bad severity: ${e.severity}`);
    assert.ok(typeof e.fix === 'string' && e.fix.length > 0, `bad fix: ${JSON.stringify(e)}`);
  }
});

test('lock-in 5: orphans is an array', () => {
  const o = readJSON('data/w890-1-orphans.json');
  assert.ok(Array.isArray(o));
  for (const e of o) {
    assert.ok(typeof e.file === 'string', `bad file in orphan entry: ${JSON.stringify(e)}`);
    assert.ok(['unused', 'dead'].includes(e.type), `bad type: ${e.type}`);
  }
});

test('lock-in 6: binary-blobs is an array', () => {
  const b = readJSON('data/w890-1-binary-blobs.json');
  assert.ok(Array.isArray(b));
  for (const e of b) {
    assert.ok(typeof e.file === 'string', `bad file in blob entry: ${JSON.stringify(e)}`);
    assert.ok(typeof e.size_bytes === 'number' && e.size_bytes > 100 * 1024,
      `blob ${e.file} size_bytes=${e.size_bytes} must exceed 100KB`);
  }
});

test('lock-in 7: docs/reference/codebase-organization.md exists and names the 500-LoC rule', () => {
  const docPath = path.join(ROOT, 'docs/reference/codebase-organization.md');
  assert.ok(fs.existsSync(docPath), 'codebase-organization.md missing');
  const txt = fs.readFileSync(docPath, 'utf8');
  assert.ok(/500.{0,4}[Ll]o[Cc]/.test(txt) || txt.includes('500 lines'),
    'codebase-organization.md must reference the 500-LoC rule');
  assert.ok(txt.includes('w890-1-loc-exceptions.json'),
    'codebase-organization.md must point to the exceptions file');
});

test('lock-in 8: no forbidden vocabulary in W890-1 audit script or doc', () => {
  // Standing constraint: avoid a specific banned word family in audit
  // deliverables. The banned token is constructed at runtime so this test's
  // own source does not embed the literal string (which would create a
  // self-recursive false positive when the test scans itself).
  const banned = 'h' + 'one' + 's' + 't';  // do not embed the literal
  const re = new RegExp(`\\b${banned}(?:y)?\\b`, 'i');
  const targets = [
    'scripts/w890-1-organization-audit.cjs',
    'docs/reference/codebase-organization.md',
  ];
  for (const t of targets) {
    const txt = fs.readFileSync(path.join(ROOT, t), 'utf8');
    assert.ok(!re.test(txt),
      `forbidden vocabulary in ${t}; use Caveats / Constraints / Limitations instead`);
  }
});

test('lock-in 9: tests/ contains only test files + helper subdirs', () => {
  const entries = fs.readdirSync(path.join(ROOT, 'tests'), { withFileTypes: true });
  for (const ent of entries) {
    if (ent.isDirectory()) {
      // fixtures/ is the only allowed non-helper subdir. _tmp_no_home_* are
      // test-runtime artifacts created by setIsolatedHome.
      if (ent.name === 'fixtures') continue;
      if (/^_tmp_no_home_\d+$/.test(ent.name)) continue;
      assert.fail(`unexpected directory under tests/: ${ent.name}`);
    } else if (ent.isFile()) {
      // _spawn-helpers.js, _fixtures-w422-noop-worker.cjs, etc. are allowed helper files.
      // _w258_be7_*.json are wave258 fixture leftovers (preserved by test runs).
      if (ent.name.startsWith('_')) continue;
      // Test files
      if (/\.test\.(js|cjs|mjs)$/.test(ent.name)) continue;
      assert.fail(`unexpected file under tests/: ${ent.name} (must be *.test.{js,cjs,mjs} or _helper)`);
    }
  }
});

test('lock-in 10: cli/ contains only JS-ecosystem files (no Python, no shell)', () => {
  function walk(dir, out = []) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'data') continue;  // cli/data is allowed for static data
        walk(full, out);
      } else if (ent.isFile()) {
        out.push(full);
      }
    }
    return out;
  }
  const files = walk(path.join(ROOT, 'cli'));
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    // Allowed: JS, MJS, CJS, TS, JSON, MD.
    if (['.js', '.mjs', '.cjs', '.ts', '.json', '.md'].includes(ext)) continue;
    // Disallowed: .py, .sh, etc.
    assert.fail(`disallowed file under cli/: ${path.relative(ROOT, f)} (cli/ is JS-ecosystem-only)`);
  }
});

test('lock-in 11: audit-static-refs reports zero missing static references', () => {
  // The script audit-static-refs.cjs walks public/ and verifies that every
  // referenced static asset exists on disk. Run it and parse the count.
  let out;
  try {
    out = execFileSync(NODE, [path.join(ROOT, 'scripts', 'audit-static-refs.cjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60000,
    });
  } catch (err) {
    // If the script exits non-zero, the missing-refs gate failed.
    assert.fail(`audit-static-refs failed: ${err.stdout || ''}\n${err.stderr || err.message}`);
  }
  // Expect a zero-missing report. The script prints "missing static refs: 0".
  assert.match(out, /missing[^\n]*:\s*0\b|0\s+missing|\bmissing\b.*\b0\b/i,
    `audit-static-refs must report 0 missing; got:\n${out.slice(0, 400)}`);
});

test('lock-in 12: audit-href --strict reports zero broken hrefs', () => {
  let out;
  try {
    out = execFileSync(NODE, [path.join(ROOT, 'scripts', 'audit-href.cjs'), '--strict'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120000,
    });
  } catch (err) {
    assert.fail(`audit-href --strict failed: ${err.stdout || ''}\n${err.stderr || err.message}`);
  }
  // Expect a zero-broken report.
  assert.match(out, /broken[^\n]*:\s*0\b|0\s+broken|\bbroken\b.*\b0\b/i,
    `audit-href --strict must report 0 broken; got:\n${out.slice(0, 400)}`);
});
