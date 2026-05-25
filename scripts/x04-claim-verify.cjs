#!/usr/bin/env node
// X04 — website claim verification.
//
// Every numeric claim that appears on a public page must trace to a
// checked-in evidence file. The X04 fixture manifest (data/x04-claim-fixtures.json)
// maps each claim substring (e.g. "17.9 GB", "125.3 s") to:
//   1. an evidence file (e.g. public/benchmarks/sota-quantize-matrix.json),
//   2. a row selector (matched against a key field, e.g. model name),
//   3. the field whose value the claim asserts, and
//   4. a sprintf-style format used to derive the rendered substring.
//
// The verifier:
//   (a) loads every fixture,
//   (b) resolves the evidence value for each fixture and confirms the
//       formatted value byte-equals the declared claim_substring (a
//       "value drift" — number on page no longer matches measured fact —
//       fails the gate),
//   (c) walks public/**/*.html and counts how many pages contain each
//       claim_substring (a "fixture orphan" — declared but never rendered —
//       is a coverage warning but NOT a release blocker), and
//   (d) emits a JSON report with per-fixture and aggregate counts.
//
// Invocation:
//   node scripts/x04-claim-verify.cjs            # human-readable summary
//   node scripts/x04-claim-verify.cjs --json     # machine-readable single line
//   node scripts/x04-claim-verify.cjs --strict   # exit non-zero on orphans too
//
// Designed to be called from scripts/release-verify.cjs as a non-blocking
// audit gate when the manifest grows.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'data', 'x04-claim-fixtures.json');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');

const args = process.argv.slice(2);
const jsonMode = args.includes('--json');
const strict = args.includes('--strict');

function readJson(absPath) {
  const raw = fs.readFileSync(absPath, 'utf8');
  return JSON.parse(raw);
}

function existsSync(absPath) {
  try { fs.accessSync(absPath); return true; } catch (_) { return false; }
}

// sprintf-lite — supports %.1f, %.2f, %d, %s. Sufficient for X04 fixtures.
function formatValue(value, fmt) {
  const out = String(fmt).replace(/%\.(\d+)f|%d|%s/g, (token, decimals) => {
    if (token === '%d') return String(Math.trunc(Number(value)));
    if (token === '%s') return String(value);
    const n = Number(value);
    if (!Number.isFinite(n)) return String(value);
    return n.toFixed(parseInt(decimals, 10));
  });
  return out;
}

function findEvidenceRow(evidenceJson, match) {
  // Walk the JSON looking for the first object that contains match.field === match.value.
  // Supports both the top-level rows[] convention used in public/benchmarks/*.json
  // and a simple { ...match.field: match.value } shape at the root.
  if (!match || typeof match !== 'object') return evidenceJson;
  const { field, value } = match;
  if (!field) return evidenceJson;
  const stack = [evidenceJson];
  while (stack.length) {
    const node = stack.shift();
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    if (node && typeof node === 'object') {
      if (node[field] === value) return node;
      for (const v of Object.values(node)) {
        if (v && typeof v === 'object') stack.push(v);
      }
    }
  }
  return null;
}

// Walk public/**/*.html. We avoid Node's experimental fs.glob to stay on the
// LTS API surface — depth-first walk with a hard depth cap.
function walkHtmlFiles(dir, depth, files) {
  if (depth < 0) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkHtmlFiles(full, depth - 1, files);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) {
      files.push(full);
    }
  }
}

function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error('x04 fixture manifest missing: ' + path.relative(REPO_ROOT, MANIFEST_PATH));
  }
  const manifest = readJson(MANIFEST_PATH);
  if (manifest.spec !== 'kolm-x04-claim-fixtures-1') {
    throw new Error('x04 fixture manifest spec mismatch: ' + manifest.spec);
  }
  if (!Array.isArray(manifest.fixtures)) throw new Error('x04 fixture manifest missing fixtures[]');
  return manifest;
}

function relRepo(absPath) {
  return path.relative(REPO_ROOT, absPath).replace(/\\/g, '/');
}

function verifyFixture(fixture, evidenceCache) {
  const out = {
    id: fixture.id,
    claim_substring: fixture.claim_substring,
    evidence_file: fixture.evidence_file,
    evidence_field: fixture.evidence_field,
    blocking: fixture.blocking !== false,
  };
  if (typeof fixture.claim_substring !== 'string' || !fixture.claim_substring.length) {
    out.status = 'invalid_fixture';
    out.detail = 'claim_substring missing or empty';
    return out;
  }
  if (typeof fixture.evidence_file !== 'string') {
    out.status = 'invalid_fixture';
    out.detail = 'evidence_file missing';
    return out;
  }
  if (typeof fixture.format !== 'string') {
    out.status = 'invalid_fixture';
    out.detail = 'format missing';
    return out;
  }

  const evAbs = path.join(REPO_ROOT, fixture.evidence_file);
  if (!existsSync(evAbs)) {
    out.status = 'evidence_missing';
    out.detail = 'evidence file not on disk';
    return out;
  }
  let evJson = evidenceCache.get(evAbs);
  if (!evJson) {
    try { evJson = readJson(evAbs); evidenceCache.set(evAbs, evJson); }
    catch (e) { out.status = 'evidence_invalid_json'; out.detail = String(e.message || e); return out; }
  }

  const row = findEvidenceRow(evJson, fixture.evidence_match);
  if (!row) {
    out.status = 'evidence_row_not_found';
    out.detail = 'no row matched ' + JSON.stringify(fixture.evidence_match);
    return out;
  }
  if (!(fixture.evidence_field in row)) {
    out.status = 'evidence_field_missing';
    out.detail = `row missing field "${fixture.evidence_field}"`;
    return out;
  }

  const raw = row[fixture.evidence_field];
  const derived = formatValue(raw, fixture.format);
  out.evidence_raw = raw;
  out.evidence_derived = derived;

  if (derived !== fixture.claim_substring) {
    out.status = 'value_drift';
    out.detail = `derived "${derived}" != declared claim "${fixture.claim_substring}"`;
    return out;
  }

  out.status = 'evidence_ok';
  return out;
}

function countAppearances(htmlFiles, fixtureReports) {
  // Single pass per file: read file once, scan for every fixture's substring.
  // O(files * fixtures * filesize) but file count is small (<1000) so fine.
  for (const file of htmlFiles) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
    for (const rep of fixtureReports) {
      if (rep.status === 'invalid_fixture') continue;
      const needle = rep.claim_substring;
      if (!needle) continue;
      // Count non-overlapping literal occurrences.
      let count = 0;
      let from = 0;
      for (;;) {
        const idx = text.indexOf(needle, from);
        if (idx < 0) break;
        count++;
        from = idx + needle.length;
      }
      if (count > 0) {
        if (!rep.appearances) rep.appearances = [];
        rep.appearances.push({ file: relRepo(file), count });
        rep.total_appearances = (rep.total_appearances || 0) + count;
      }
    }
  }
  // Default zero if never seen.
  for (const rep of fixtureReports) {
    if (!('total_appearances' in rep)) rep.total_appearances = 0;
    if (!('appearances' in rep)) rep.appearances = [];
  }
}

function main() {
  const startedAt = Date.now();
  let manifest;
  try { manifest = loadManifest(); }
  catch (e) {
    const env = { spec: 'kolm-x04-claim-verification-1', ok: false, error: String(e.message || e) };
    process.stdout.write(JSON.stringify(env) + '\n');
    process.exit(2);
  }

  const evidenceCache = new Map();
  const fixtureReports = manifest.fixtures.map((f) => verifyFixture(f, evidenceCache));

  const htmlFiles = [];
  walkHtmlFiles(PUBLIC_DIR, 12, htmlFiles);
  htmlFiles.sort();

  countAppearances(htmlFiles, fixtureReports);

  // Aggregate.
  const counts = {
    fixtures: fixtureReports.length,
    fixtures_evidence_ok: 0,
    fixtures_value_drift: 0,
    fixtures_evidence_missing: 0,
    fixtures_invalid: 0,
    fixtures_with_appearances: 0,
    fixtures_orphaned: 0,
    total_appearances: 0,
    html_files_scanned: htmlFiles.length,
  };
  const blocking_failures = [];
  const warnings = [];
  for (const rep of fixtureReports) {
    if (rep.status === 'evidence_ok') counts.fixtures_evidence_ok++;
    else if (rep.status === 'value_drift') {
      counts.fixtures_value_drift++;
      if (rep.blocking) blocking_failures.push(`${rep.id}: ${rep.detail}`);
      else warnings.push(`${rep.id}: ${rep.detail}`);
    } else if (rep.status === 'evidence_missing' || rep.status === 'evidence_row_not_found' || rep.status === 'evidence_field_missing' || rep.status === 'evidence_invalid_json') {
      counts.fixtures_evidence_missing++;
      if (rep.blocking) blocking_failures.push(`${rep.id}: ${rep.status} (${rep.detail})`);
      else warnings.push(`${rep.id}: ${rep.status}`);
    } else if (rep.status === 'invalid_fixture') {
      counts.fixtures_invalid++;
      blocking_failures.push(`${rep.id}: invalid_fixture (${rep.detail})`);
    }
    if (rep.total_appearances > 0) counts.fixtures_with_appearances++;
    else counts.fixtures_orphaned++;
    counts.total_appearances += rep.total_appearances || 0;
  }

  const ok = blocking_failures.length === 0 && (!strict || counts.fixtures_orphaned === 0);
  const env = {
    spec: 'kolm-x04-claim-verification-1',
    ok,
    strict,
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    counts,
    blocking_failures,
    warnings,
    fixtures: fixtureReports,
  };

  if (jsonMode) {
    process.stdout.write(JSON.stringify(env) + '\n');
  } else {
    const tag = ok ? 'PASS' : 'FAIL';
    process.stdout.write(`[x04-claim-verify] ${tag} - ${counts.fixtures_evidence_ok}/${counts.fixtures} fixtures match evidence, ${counts.total_appearances} appearances across ${counts.html_files_scanned} HTML files, ${counts.fixtures_orphaned} orphaned, ${counts.fixtures_value_drift} drifted\n`);
    if (blocking_failures.length) {
      process.stdout.write('  blocking failures:\n');
      for (const f of blocking_failures) process.stdout.write('    - ' + f + '\n');
    }
    if (warnings.length) {
      process.stdout.write('  warnings:\n');
      for (const w of warnings) process.stdout.write('    - ' + w + '\n');
    }
    if (counts.fixtures_orphaned && !strict) {
      const orphans = fixtureReports.filter((r) => r.total_appearances === 0).map((r) => r.id);
      process.stdout.write('  orphaned (declared but never rendered, --strict to fail on this):\n');
      for (const o of orphans) process.stdout.write('    - ' + o + '\n');
    }
  }

  process.exit(ok ? 0 : 1);
}

main();
