#!/usr/bin/env node
'use strict';

// kolm.codebase_file_ledger.v1 — classify every tracked + untracked path so
// release inclusion, ownership, generated status, and cleanup responsibility
// are explicit. Seeds the codebase redline gate.
//
// Usage: node scripts/build-codebase-file-ledger.cjs [--check]
//
// Spec: docs/research/kolm-p0-control-files-implementation-spec-2026-05-25.md
//       docs/research/kolm-p0-control-files-buildbook-2026-05-25.md

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'internal', 'codebase-file-ledger.json');
const SCHEMA = 'kolm.codebase_file_ledger.v1';
const LARGE_FILE_BYTES = 250_000;

const args = process.argv.slice(2);
const CHECK = args.includes('--check');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
  return out;
}

function stableStringify(value) {
  return JSON.stringify(stable(value), null, 2) + '\n';
}

function sh(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    return '';
  }
}

function lsTracked() {
  const raw = sh('git ls-files -z');
  if (!raw) return [];
  return raw.split('\0').filter(Boolean);
}

function porcelain() {
  // Map<path, status-letter-pair>
  const out = new Map();
  const raw = sh('git status --porcelain=1 -z');
  if (!raw) return out;
  const parts = raw.split('\0').filter(Boolean);
  for (const entry of parts) {
    if (entry.length < 4) continue;
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    out.set(file, status);
  }
  return out;
}

function dirtyState(file, porcelainMap) {
  const status = porcelainMap.get(file);
  if (!status) return 'clean';
  const x = status[0];
  const y = status[1];
  if (x === '?' && y === '?') return 'untracked';
  if (x === '!' && y === '!') return 'ignored';
  // The committed ledger must be clean-tree stable. Tracked edits are visible
  // in git diff and become the next committed source state, so recording them
  // here would make the control file stale before and after every commit.
  return 'clean';
}

// Known generators: { generator-script-relative-path : [globPattern, ...] }
// Maps generated outputs back to the script that owns them. Used both for
// `generated_by` attribution and `release_included` (generated outputs always
// ship if they're under public/ or docs/).
const GENERATED_BY = [
  { gen: 'scripts/build-product-graph.cjs', match: /^public\/product-graph\.json$/ },
  { gen: 'scripts/build-openapi.cjs', match: /^public\/openapi\.json$/ },
  { gen: 'scripts/build-api-ref.cjs', match: /^public\/api-routes\.json$/ },
  { gen: 'scripts/build-api-ref.cjs', match: /^public\/docs\/api\.html$/ },
  { gen: 'scripts/build-cli-docs.cjs', match: /^public\/docs\/cli\.html$/ },
  { gen: 'scripts/build-docs-manifest.cjs', match: /^public\/docs\/manifest\.json$/ },
  { gen: 'scripts/build-readiness-closeout.cjs', match: /^public\/readiness-closeout\.json$/ },
  { gen: 'scripts/build-readiness-closeout.cjs', match: /^docs\/readiness-closeout\.json$/ },
  { gen: 'scripts/build-sitemap.cjs', match: /^public\/sitemap\.xml$/ },
  { gen: 'scripts/build-sdk-version.js', match: /^sdk\/[^/]+\/(VERSION|version\.json)$/ },
  { gen: 'scripts/build-changelog.cjs', match: /^public\/changelog\.html$/ },
  { gen: 'scripts/build-og.cjs', match: /^public\/og\/.*\.(png|svg)$/ },
  { gen: 'scripts/build-codegraph.mjs', match: /^docs\/codegraph\.json$/ },
  { gen: 'scripts/build-codebase-file-ledger.cjs', match: /^docs\/internal\/codebase-file-ledger\.json$/ },
  { gen: 'scripts/build-design-cascade-ledger.cjs', match: /^docs\/internal\/design-cascade-ledger\.json$/ },
  { gen: 'scripts/build-wave-registry.cjs', match: /^docs\/internal\/wave-registry\.json$/ },
  { gen: 'scripts/build-wave-registry.cjs', match: /^docs\/internal\/wave-registry\.schema\.json$/ },
  { gen: 'scripts/build-wave-registry.cjs', match: /^docs\/internal\/wave-reconcile-report\.json$/ },
  { gen: 'scripts/build-catalog-manifest.mjs', match: /^docs\/internal\/catalog-manifest\.json$/ },
  { gen: 'scripts/build-product-media-proof.cjs', match: /^docs\/internal\/product-media-proof\.json$/ },
  { gen: 'scripts/build-api-contract-matrix.cjs', match: /^docs\/internal\/api-contract-matrix\.json$/ },
  { gen: 'scripts/build-auth-boundary-matrix.cjs', match: /^docs\/internal\/auth-boundary-matrix\.json$/ },
  { gen: 'scripts/build-cli-command-matrix.cjs', match: /^docs\/internal\/cli-command-matrix\.json$/ },
  { gen: 'scripts/build-daemon-connector-matrix.cjs', match: /^docs\/internal\/daemon-connector-matrix\.json$/ },
  { gen: 'scripts/build-quantize-worker-matrix.cjs', match: /^docs\/internal\/quantize-worker-matrix\.json$/ },
  { gen: 'scripts/build-binder-contract-matrix.cjs', match: /^docs\/internal\/binder-contract-matrix\.json$/ },
  { gen: 'scripts/build-intent-contract-matrix.cjs', match: /^docs\/internal\/intent-contract-matrix\.json$/ },
  { gen: 'scripts/build-wrapper-cli-matrix.cjs', match: /^docs\/internal\/wrapper-cli-matrix\.json$/ },
  { gen: 'scripts/build-distill-pipeline-matrix.cjs', match: /^docs\/internal\/distill-pipeline-matrix\.json$/ },
  { gen: 'scripts/build-spec-compile-matrix.cjs', match: /^docs\/internal\/spec-compile-matrix\.json$/ },
  { gen: 'scripts/build-data-curate-matrix.cjs', match: /^docs\/internal\/data-curate-matrix\.json$/ },
  { gen: 'scripts/build-artifact-matrix.cjs', match: /^docs\/internal\/artifact-matrix\.json$/ },
  { gen: 'scripts/build-tui-workbench-matrix.cjs', match: /^docs\/internal\/tui-workbench-matrix\.json$/ },
];

function generatedBy(p) {
  for (const row of GENERATED_BY) {
    if (row.match.test(p)) return row.gen;
  }
  return null;
}

function looksLikeRootScratch(p) {
  // Root path-like artifacts (the windows-pathname-as-filename bugs we keep
  // seeing dropped into the tree), .tmp-* files, or screenshot dirs at root.
  const top = p.split('/')[0] || p;
  if (!p.includes('/')) {
    if (top.startsWith('.tmp-')) return true;
    if (top.startsWith('C:')) return true;
    if (top.startsWith('Cﹺ')) return true; // the mojibake variant we saw
    if (/^C[\x80-\xff]+UsersuserDesktop/.test(top)) return true;
  }
  if (top.startsWith('.w850-shots') || top.startsWith('.w849-shots')) return true;
  return false;
}

function classify(p) {
  if (looksLikeRootScratch(p)) return 'scratch';
  const seg = p.split('/');
  const top = seg[0];
  const ext = path.extname(p).toLowerCase();
  const basename = seg[seg.length - 1];

  // Generated first — overrides directory rules.
  if (generatedBy(p)) return 'generated';

  // Config files at root.
  if (seg.length === 1) {
    if (basename === 'package.json' || basename === 'package-lock.json') return 'config';
    if (basename === '.gitignore' || basename === '.vercelignore' || basename === '.npmignore') return 'config';
    if (basename === 'vercel.json' || basename === 'railway.json' || basename === 'tsconfig.json') return 'config';
    if (basename === '.eslintrc' || basename.startsWith('.eslintrc.')) return 'config';
    if (basename === '.editorconfig' || basename === '.nvmrc' || basename === '.node-version') return 'config';
    if (basename === 'Dockerfile' || basename === '.dockerignore') return 'config';
    if (basename === 'server.js' || basename === 'index.js') return 'source';
    if (ext === '.md' || ext === '.markdown') return 'docs';
    if (ext === '.txt' && /failures|notes|scratch/i.test(basename)) return 'scratch';
  }

  // Directory-based classification.
  if (top === 'src' || top === 'cli' || top === 'workers' || top === 'lib') return 'source';
  if (top === 'sdk' || top === 'packages') {
    if (basename.endsWith('.test.js') || basename.endsWith('.test.mjs') || basename.endsWith('.test.cjs')) return 'test';
    if (ext === '.md') return 'docs';
    return 'source';
  }
  if (top === 'scripts') return 'source';
  if (top === 'tests' || basename.endsWith('.test.js') || basename.endsWith('.test.mjs') || basename.endsWith('.test.cjs')) return 'test';
  if (top === 'fixtures' || top === 'fixture' || (top === 'tests' && seg[1] === 'fixtures')) return 'fixture';
  if (top === 'reports') return 'report';
  if (top === 'docs') {
    if (ext === '.json' && (basename.endsWith('-report.json') || basename.includes('snapshot'))) return 'report';
    return 'docs';
  }
  if (top === 'public') {
    if (seg[1] === 'img' || seg[1] === 'og' || seg[1] === 'images' || seg[1] === 'media') return 'asset';
    if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp' || ext === '.avif' || ext === '.ico' || ext === '.gif' || ext === '.mp4' || ext === '.webm' || ext === '.woff' || ext === '.woff2' || ext === '.ttf') return 'asset';
    return 'source';
  }
  if (top === 'data') return 'fixture';
  if (top === 'attestations' || top === '.github') return 'config';

  if (ext === '.md' || ext === '.markdown') return 'docs';
  if (ext === '.json' && top !== 'src' && top !== 'cli') return 'config';
  return 'source';
}

function releaseIncluded(p, kind) {
  if (kind === 'scratch' || kind === 'quarantine') return false;
  if (kind === 'test' || kind === 'fixture' || kind === 'report') return false;
  if (p.startsWith('docs/internal/')) return false;
  if (kind === 'generated' && p.startsWith('docs/internal/')) return false;
  if (kind === 'docs' && !p.startsWith('docs/research/') && p !== 'README.md') {
    // Most docs/ files ship for transparency; research notes do not.
    return true;
  }
  if (kind === 'docs' && p.startsWith('docs/research/')) return false;
  const top = p.split('/')[0];
  if (top === 'public' || top === 'src' || top === 'cli' || top === 'workers' || top === 'lib' || top === 'server.js' || top === 'package.json' || top === 'vercel.json') return true;
  if (top === 'sdk' || top === 'packages') return true;
  if (top === 'scripts') return false; // scripts are dev-time, not in npm bin
  return false;
}

function redlineFor(p, kind, dirty) {
  if (kind === 'scratch') return 'scratch_in_release_tree';
  if (kind === 'quarantine') return 'quarantine_in_release_tree';
  return null;
}

function safeStat(abs) {
  try {
    return fs.statSync(abs);
  } catch (e) {
    return null;
  }
}

function main() {
  const tracked = lsTracked();
  const porcelainMap = porcelain();

  // Union of tracked + untracked-non-ignored paths.
  const all = new Set(tracked);
  for (const [p, status] of porcelainMap.entries()) {
    if (status.startsWith('!')) continue; // ignored
    all.add(p);
  }

  // Skip self + the design-cascade-ledger output. Listing them recursively
  // creates a bootstrap loop: their bytes-on-disk change when their own
  // timestamp changes, which breaks --check idempotence.
  const SELF_PATHS = new Set([
    'docs/internal/codebase-file-ledger.json',
    'docs/internal/design-cascade-ledger.json',
    'docs/internal/wave-registry.json',
    'docs/internal/wave-registry.schema.json',
    'docs/internal/wave-reconcile-report.json',
    'docs/internal/catalog-manifest.json',
    'docs/internal/product-media-proof.json',
    'docs/internal/api-contract-matrix.json',
    'docs/internal/auth-boundary-matrix.json',
    'docs/internal/cli-command-matrix.json',
    'docs/internal/daemon-connector-matrix.json',
    'docs/internal/quantize-worker-matrix.json',
    'docs/internal/binder-contract-matrix.json',
    'docs/internal/intent-contract-matrix.json',
    'docs/internal/wrapper-cli-matrix.json',
    'docs/internal/distill-pipeline-matrix.json',
    'docs/internal/spec-compile-matrix.json',
    'docs/internal/data-curate-matrix.json',
    'docs/internal/artifact-matrix.json',
    'docs/internal/tui-workbench-matrix.json',
  ]);
  for (const sp of SELF_PATHS) all.delete(sp);

  const paths = [];
  const counts = {
    total_paths: 0,
    source_paths: 0,
    generated_paths: 0,
    docs_paths: 0,
    test_paths: 0,
    report_paths: 0,
    asset_paths: 0,
    config_paths: 0,
    fixture_paths: 0,
    scratch_or_quarantine_paths: 0,
    unowned_paths: 0,
    release_included_paths: 0,
    large_files: 0,
    dirty_paths: 0,
    untracked_paths: 0,
  };

  for (const p of [...all].sort()) {
    const abs = path.join(ROOT, p);
    const stat = safeStat(abs);
    const bytes = stat ? stat.size : null;
    const kind = classify(p);
    const dirty = dirtyState(p, porcelainMap);
    const gen = generatedBy(p);
    const release = releaseIncluded(p, kind);
    const large = bytes != null && bytes >= LARGE_FILE_BYTES;
    const redline = redlineFor(p, kind, dirty);

    paths.push({
      path: p,
      kind,
      bytes,
      generated_by: gen,
      release_included: release,
      large_file: large,
      dirty_state: dirty,
      redline,
    });

    counts.total_paths += 1;
    if (kind === 'source') counts.source_paths += 1;
    else if (kind === 'generated') counts.generated_paths += 1;
    else if (kind === 'docs') counts.docs_paths += 1;
    else if (kind === 'test') counts.test_paths += 1;
    else if (kind === 'report') counts.report_paths += 1;
    else if (kind === 'asset') counts.asset_paths += 1;
    else if (kind === 'config') counts.config_paths += 1;
    else if (kind === 'fixture') counts.fixture_paths += 1;
    else if (kind === 'scratch' || kind === 'quarantine') counts.scratch_or_quarantine_paths += 1;
    if (release) counts.release_included_paths += 1;
    if (large) counts.large_files += 1;
    if (dirty !== 'clean') counts.dirty_paths += 1;
    if (dirty === 'untracked') counts.untracked_paths += 1;
  }

  const failures = [];
  for (const row of paths) {
    if (row.redline) failures.push({ path: row.path, kind: row.kind, redline: row.redline });
  }

  const doc = {
    schema: SCHEMA,
    generated_at: new Date().toISOString(),
    secret_values_included: false,
    root: ROOT.replace(/\\/g, '/'),
    counts,
    failures,
    paths,
  };

  // Pin generated_at to a stable value when --check so the diff only catches
  // real content drift, not the timestamp.
  if (CHECK && fs.existsSync(OUT)) {
    try {
      const existing = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      if (existing && typeof existing.generated_at === 'string') {
        doc.generated_at = existing.generated_at;
      }
    } catch (e) { // deliberate: cleanup
      // fall through — if existing is malformed, comparison will fail loudly
    }
  }

  const body = stableStringify(doc);

  if (CHECK) {
    const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (existing !== body) {
      console.error('codebase-file-ledger: docs/internal/codebase-file-ledger.json is out of date');
      process.exit(1);
    }
    console.log(`codebase-file-ledger: ok paths=${counts.total_paths} release=${counts.release_included_paths} scratch=${counts.scratch_or_quarantine_paths} dirty=${counts.dirty_paths} failures=${failures.length}`);
    return;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, body);
  console.log(`codebase-file-ledger: wrote docs/internal/codebase-file-ledger.json paths=${counts.total_paths} release=${counts.release_included_paths} scratch=${counts.scratch_or_quarantine_paths} dirty=${counts.dirty_paths} failures=${failures.length}`);
}

try {
  main();
} catch (err) {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
}
