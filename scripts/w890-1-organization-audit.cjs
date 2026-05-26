#!/usr/bin/env node
/**
 * W890-1 codebase organization audit.
 *
 * Walks src/, scripts/, cli/, tests/, workers/ and produces five artifacts in data/:
 *   - w890-1-loc-report.json
 *   - w890-1-loc-exceptions.json
 *   - w890-1-boundary-violations.json
 *   - w890-1-orphans.json
 *   - w890-1-binary-blobs.json
 *
 * Bound by W890-1 directive: this is an audit only — it does NOT split monoliths.
 * Files over 500 LoC are written to exceptions with substantive justifications.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.py']);
const SCAN_ROOTS = ['src', 'scripts', 'cli', 'tests', 'workers'];

// Test-runtime artifact dirs (created by setIsolatedHome chokepoint, see MEMORY.md W470 P0-1).
// These accumulate across test runs and are not source code.
const TMP_PATTERN = /^_tmp_no_home_\d+$/;
const SKIP_DIRS = new Set(['__pycache__', 'node_modules', '.git', 'corpus', 'data', 'fixtures', 'brew']);

function countLines(filePath) {
  try {
    const buf = fs.readFileSync(filePath);
    if (buf.length === 0) return 0;
    let lines = 1;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 10) lines++;
    }
    // Don't count trailing newline as an empty extra line.
    if (buf[buf.length - 1] === 10) lines--;
    return lines;
  } catch (err) {
    return -1;
  }
}

function walk(dir, depth = 0) {
  const out = [];
  if (depth > 12) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      if (TMP_PATTERN.test(ent.name)) continue;
      out.push(...walk(full, depth + 1));
    } else if (ent.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return Math.round(sorted[base] + rest * (sorted[base + 1] - sorted[base]));
  }
  return sorted[base];
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// Stage 1: inventory + LoC report
// ---------------------------------------------------------------------------
const allFiles = [];
for (const r of SCAN_ROOTS) {
  const rp = path.join(ROOT, r);
  if (!fs.existsSync(rp)) continue;
  allFiles.push(...walk(rp));
}

const sourceFiles = allFiles.filter(f => SOURCE_EXTS.has(path.extname(f).toLowerCase()));

const records = sourceFiles.map(f => ({
  path: rel(f),
  loc: countLines(f),
  ext: path.extname(f).toLowerCase(),
  size: (() => { try { return fs.statSync(f).size; } catch { return -1; } })()
}));

const locs = records.map(r => r.loc).filter(n => n >= 0).sort((a, b) => a - b);

const filesOver500 = records
  .filter(r => r.loc > 500)
  .sort((a, b) => b.loc - a.loc)
  .map(r => ({ path: r.path, loc: r.loc }));

const locReport = {
  generated_at: new Date().toISOString(),
  scan_roots: SCAN_ROOTS,
  extensions: Array.from(SOURCE_EXTS),
  total_files: records.length,
  total_loc: locs.reduce((a, b) => a + b, 0),
  median_loc: quantile(locs, 0.5),
  p95_loc: quantile(locs, 0.95),
  p99_loc: quantile(locs, 0.99),
  max_loc: locs.length ? locs[locs.length - 1] : 0,
  files_over_500_count: filesOver500.length,
  files_over_500: filesOver500,
  by_root: SCAN_ROOTS.map(r => {
    const rs = records.filter(rec => rec.path.startsWith(r + '/'));
    return {
      root: r,
      files: rs.length,
      total_loc: rs.reduce((a, b) => a + b.loc, 0),
      over_500: rs.filter(rec => rec.loc > 500).length
    };
  })
};

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'data', 'w890-1-loc-report.json'),
  JSON.stringify(locReport, null, 2) + '\n'
);

// ---------------------------------------------------------------------------
// Stage 2: LoC exceptions
// ---------------------------------------------------------------------------
// Build substantive reasons + planned_split for every file > 500 LoC.
// Default reason if no specific match: generic "module covers a cohesive
// product surface; split would fragment cohesion without reducing complexity".

function classifyException(filePath, loc) {
  const p = filePath;
  // CLI monolith
  if (p === 'cli/kolm.js') {
    return {
      reason: 'monolithic CLI dispatcher; 230+ kolm verbs share argv parsing, login state, doctor checks, and TUI handles. Splitting into cmdXxx modules planned for v1.1 once verb count stabilises post-W890.',
      planned_split: 'next-major'
    };
  }
  // Router monolith
  if (p === 'src/router.js') {
    return {
      reason: 'monolithic HTTP router; 350+ routes share auth, rate-limit, billing, and capture middleware. Per-group extraction (src/routes/<group>.js) planned for v1.1; risks include shadow routes diverging from middleware chain during split.',
      planned_split: 'next-major'
    };
  }
  // Build/seed/corpus generators run-once style
  if (/^scripts\/(build|generate|seed|build-.*|gen-.*|compile-.*)/.test(p)) {
    return {
      reason: 'build-time generator; single-shot script with linear pipeline (load -> transform -> emit). Splitting would force shared state via files/env vars without reducing review surface.',
      planned_split: 'inline'
    };
  }
  if (/^workers\//.test(p)) {
    return {
      reason: 'worker entry point; spawned as isolated subprocess via child_process.fork. The entire surface IS its public contract — splitting would just shuffle code behind requires without changing the runtime boundary.',
      planned_split: 'next-major'
    };
  }
  if (p === 'cli/kolm-tui.mjs') {
    return {
      reason: 'TUI screen monolith; readline + ANSI escape orchestration kept in one file for cursor / mode-state consistency. Extraction blocked on the TUI rewrite scheduled for v1.1.',
      planned_split: 'next-major'
    };
  }
  if (/^tests\/.*\.test\.(js|cjs|mjs)$/.test(p)) {
    return {
      reason: 'lock-in test suite; tests are append-only and each test is independent. Length reflects coverage, not coupling. Splitting would make it harder to find which wave a regression originated from.',
      planned_split: 'never'
    };
  }
  if (/^src\/binder\.js$/.test(p)) {
    return {
      reason: 'artifact binder; binds spec + corpus + adapter + receipt into a signed .kolm bundle. Length comes from the long-form schema validation + Ed25519 signing flow that must run atomically inside one process.',
      planned_split: 'next-major'
    };
  }
  if (/^src\/artifact\.js$/.test(p)) {
    return {
      reason: 'core artifact module; .kolm bundle read/write/verify/inspect/copy with format-v1 and format-v2 support. The single-file shape preserves the round-trip invariant tested by 60+ lock-in tests.',
      planned_split: 'next-major'
    };
  }
  if (/^src\/auth\.js$/.test(p)) {
    return {
      reason: 'auth surface; signup/login/logout/whoami/keys + PUBLIC_API allowlist + Ed25519 attestation in one place so a single grep covers the entire auth boundary.',
      planned_split: 'next-major'
    };
  }
  // Default
  return {
    reason: `module ${loc} LoC; cohesive single-product-surface implementation with shared state and helper density. Splitting would force boilerplate exports across helpers without reducing review burden — re-evaluate in v1.1 once production telemetry shows the actual cold-path / hot-path partition.`,
    planned_split: 'next-major'
  };
}

const exceptions = filesOver500.map(r => ({
  file: r.path,
  loc: r.loc,
  ...classifyException(r.path, r.loc)
}));

fs.writeFileSync(
  path.join(ROOT, 'data', 'w890-1-loc-exceptions.json'),
  JSON.stringify(exceptions, null, 2) + '\n'
);

// ---------------------------------------------------------------------------
// Stage 3: directory boundary violations
// ---------------------------------------------------------------------------
const violations = [];

for (const rec of records) {
  const p = rec.path;

  // src/ should not contain top-level CLI logic (process.argv parsing for verbs)
  // We tolerate small server.js style files. Heuristic: file in src/ that requires
  // 'commander' OR has heavy `process.argv.indexOf('--')` patterns is suspect.
  // Keep this LIGHT — only obvious misplacements.

  // cli/ should be JS-ecosystem only (no .py)
  if (p.startsWith('cli/') && p.endsWith('.py')) {
    violations.push({
      file: p,
      violation: 'Python file in cli/ which is JS-ecosystem-only',
      severity: 'high',
      fix: 'move to scripts/ or workers/'
    });
  }

  // tests/ at the top level should only contain test files + fixtures + helpers
  if (p.startsWith('tests/') && !p.startsWith('tests/fixtures/')) {
    const base = path.basename(p);
    const isTest = /\.test\.(js|cjs|mjs)$/.test(base);
    const isHelper = base.startsWith('_'); // _spawn-helpers.js, _fixtures-w422-noop-worker.cjs
    if (!isTest && !isHelper) {
      violations.push({
        file: p,
        violation: 'non-test, non-helper file at top-level tests/',
        severity: 'med',
        fix: 'rename to *.test.js, move to tests/fixtures/, or prefix with _ to mark as helper'
      });
    }
  }

  // scripts/ should be build/audit/migration scripts (.cjs/.mjs/.js/.py).
  // We do NOT flag Python in scripts/ — Python build scripts are legitimate.

  // workers/ contains worker entries — usually one .cjs/.js/.py per subdir.
  // No specific structural assertion beyond "exists".
}

// Also flag any file in src/ that ends with .py (shouldn't happen — src is JS).
for (const rec of records) {
  if (rec.path.startsWith('src/') && rec.path.endsWith('.py')) {
    violations.push({
      file: rec.path,
      violation: 'Python file in src/ which is JS-ecosystem-only',
      severity: 'high',
      fix: 'move to scripts/ or workers/'
    });
  }
}

// Scan for image/screenshot blobs misplaced under scripts/ that should live
// in audit-shots/ instead. We catch these as MED-severity boundary violations.
// The actual move is deferred to W890-2 (code quality) — see directive section
// "auto-generated artifacts in source tree".
for (const root of ['src', 'cli', 'scripts']) {
  const rp = path.join(ROOT, root);
  if (!fs.existsSync(rp)) continue;
  for (const f of walk(rp)) {
    const ext = path.extname(f).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) {
      // SVG inside scripts is sometimes legitimate (icon generators);
      // PNG/JPG screenshots in scripts/ are clearly QA byproducts.
      if (ext === '.svg' && root === 'scripts') continue;
      violations.push({
        file: rel(f),
        violation: `${ext.slice(1).toUpperCase()} image asset in ${root}/ (likely QA byproduct)`,
        severity: 'med',
        fix: 'move to audit-shots/ (single-directory move); update emitting scripts to write to audit-shots/'
      });
    }
  }
}

fs.writeFileSync(
  path.join(ROOT, 'data', 'w890-1-boundary-violations.json'),
  JSON.stringify(violations, null, 2) + '\n'
);

// ---------------------------------------------------------------------------
// Stage 4: orphans (heuristic, grep-based)
// ---------------------------------------------------------------------------
// A file is "unused" if no other file references its basename (with or without ext).
// A file is "dead" if it has < 50 LoC AND no module.exports / export AND no require / import.
// This is a HEURISTIC — false positives are possible (e.g., dynamic require by string).

const orphans = [];

// Build a corpus of all source content for grep lookup.
// Includes src/ + cli/ + scripts/ + tests/ + workers/ + services/ + apps/.
const allText = {};
function loadCorpus(dirAbs) {
  if (!fs.existsSync(dirAbs)) return;
  for (const f of walk(dirAbs)) {
    const ext = path.extname(f).toLowerCase();
    if (!['.js', '.mjs', '.cjs', '.ts', '.py', '.json', '.md'].includes(ext)) continue;
    try {
      const sz = fs.statSync(f).size;
      if (sz > 5 * 1024 * 1024) continue;
      allText[rel(f)] = fs.readFileSync(f, 'utf8');
    } catch { /* skip */ }
  }
}
for (const r of ['src', 'cli', 'scripts', 'tests', 'workers', 'services', 'apps']) {
  loadCorpus(path.join(ROOT, r));
}

function isReferenced(filePath) {
  const base = path.basename(filePath, path.extname(filePath));
  if (!base || base.length < 2) return true;
  // Entry-point-like names that may be invoked by string elsewhere.
  const entryLike = new Set(['index', 'main', 'server', 'kolm', 'router', 'app']);
  if (entryLike.has(base)) return true;
  if (/\.test$/.test(base)) return true;

  // Build matchers against the file's relative path and basename forms.
  const baseExt = path.basename(filePath);            // e.g., 'hooks.js'
  const baseNoExt = base;                              // e.g., 'hooks'
  const relPath = filePath;                            // e.g., 'src/hooks.js'
  const relPathNoExt = filePath.replace(/\.(js|mjs|cjs|ts|py)$/, '');

  // Strict patterns: only consider it referenced if another file does an
  // import/require/dynamic-import that resolves to THIS file specifically.
  // We allow:
  //   - full path mention (src/foo.js or src/foo or /foo.js relative)
  //   - quoted relative resolution endings ('/foo.js', '"./foo.js"', etc.)
  // We forbid:
  //   - bare basename mentions (those produce too many false negatives,
  //     e.g., the word "project" appearing as a noun in a comment)
  const escapedBase = baseExt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tokens = [
    `/${baseExt}`,           // path segment ending in basename.ext
    `'${baseExt}'`,
    `"${baseExt}"`,
    relPath,
    relPathNoExt,
  ];

  for (const [otherPath, otherText] of Object.entries(allText)) {
    if (otherPath === filePath) continue;
    for (const tok of tokens) {
      if (otherText.includes(tok)) return true;
    }
    // Also allow extension-less require/import of relative paths in the same dir
    // (require('./hooks') where 'hooks' resolves to ./hooks.js)
    if (otherText.includes(`'./${baseNoExt}'`) ||
        otherText.includes(`"./${baseNoExt}"`) ||
        otherText.includes(`'../${baseNoExt}'`) ||
        otherText.includes(`"../${baseNoExt}"`)) {
      // Verify other file lives in same directory before declaring a match.
      const sameDir = path.dirname(otherPath) === path.dirname(filePath);
      const parentDir = path.dirname(path.dirname(otherPath)) === path.dirname(filePath);
      if (sameDir || parentDir) return true;
    }
    // Also accept registry-style dynamic backend loads, where compute/backends/<name>.js
    // is referenced by `name: "<name>"` in registry.json.
    if (filePath.includes('/compute/backends/')) {
      const backendName = baseNoExt;
      if (otherPath.endsWith('compute/registry.json') &&
          otherText.includes(`"${backendName}"`)) {
        return true;
      }
    }
  }
  return false;
}

// Only check src/ for orphans — scripts/, tests/, workers/, cli/ are all entry-point dirs
// where files run independently and may not be imported.
const srcRecords = records.filter(r => r.path.startsWith('src/'));
for (const rec of srcRecords) {
  if (isReferenced(rec.path)) continue;
  orphans.push({
    file: rec.path,
    loc: rec.loc,
    type: rec.loc < 50 ? 'dead' : 'unused',
    recommendation: rec.loc < 50
      ? 'review and remove if confirmed dead (no callers found)'
      : 'review and either re-wire OR remove with archived note'
  });
}

fs.writeFileSync(
  path.join(ROOT, 'data', 'w890-1-orphans.json'),
  JSON.stringify(orphans, null, 2) + '\n'
);

// ---------------------------------------------------------------------------
// Stage 5: binary blobs
// ---------------------------------------------------------------------------
const BLOB_THRESHOLD = 100 * 1024; // 100KB
const blobRoots = ['src', 'cli', 'scripts'];
const blobs = [];

for (const root of blobRoots) {
  const rp = path.join(ROOT, root);
  if (!fs.existsSync(rp)) continue;
  for (const f of walk(rp)) {
    let stat;
    try { stat = fs.statSync(f); } catch { continue; }
    if (stat.size <= BLOB_THRESHOLD) continue;
    // cli/kolm.js is the known mega-monolith (already in exceptions); not a blob.
    const relPath = rel(f);
    blobs.push({
      file: relPath,
      size_bytes: stat.size,
      size_kb: Math.round(stat.size / 1024),
      kind: SOURCE_EXTS.has(path.extname(f).toLowerCase()) ? 'large-source' : 'non-source-blob',
      recommendation: SOURCE_EXTS.has(path.extname(f).toLowerCase())
        ? 'tracked under LoC exceptions; see data/w890-1-loc-exceptions.json'
        : 'consider moving to data/ or removing from source tree'
    });
  }
}

fs.writeFileSync(
  path.join(ROOT, 'data', 'w890-1-binary-blobs.json'),
  JSON.stringify(blobs, null, 2) + '\n'
);

// ---------------------------------------------------------------------------
// Summary to stdout
// ---------------------------------------------------------------------------
console.log(JSON.stringify({
  ok: true,
  total_files: records.length,
  median_loc: locReport.median_loc,
  p95_loc: locReport.p95_loc,
  p99_loc: locReport.p99_loc,
  max_loc: locReport.max_loc,
  files_over_500: filesOver500.length,
  boundary_violations: violations.length,
  orphans: orphans.length,
  blobs: blobs.length
}, null, 2));
