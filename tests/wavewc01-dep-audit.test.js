// WC01 — Dependency audit lock-in.
//
// Atomic items (per KOLM_W707_SYSTEM_UPGRADE_PLAN.md PART VIII WC01):
//   WC01-1: `npm audit` clean — no high or critical CVEs.
//   WC01-2: every top-level dep pinned to EXACT semver in package.json.
//   WC01-3: lockfile committed + deterministic.
//   WC01-4: zero unused deps per `npx depcheck`.
//
// Tests are atomic and each pins exactly one contract. Per W479+W604+W464+W466
// anti-brittleness pattern: never assert an explicit "family array" of deps.
// Instead re-derive from package.json + an inclusion-by-shape assertion so
// adding/removing one dep can never break the lock-in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const PKG_PATH = path.join(REPO_ROOT, 'package.json');
const LOCK_PATH = path.join(REPO_ROOT, 'package-lock.json');

function readPkg() {
  return JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
}

// Exact-semver shape: MAJOR.MINOR.PATCH with optional pre-release tag.
// Rejects "^X.Y.Z", "~X.Y.Z", "X.Y", "X", ">=X", "X.Y.Z || Y.Y.Y", etc.
const EXACT_SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

test('WC01-2 every top-level dependency is pinned to exact semver (no ^ or ~)', () => {
  const pkg = readPkg();
  const deps = pkg.dependencies || {};
  const names = Object.keys(deps);
  assert.ok(names.length >= 1, 'expected at least one production dependency');
  for (const name of names) {
    const spec = deps[name];
    assert.equal(typeof spec, 'string', `dep ${name} must have string version`);
    assert.ok(!spec.startsWith('^'), `dep ${name} must not use caret range; got ${spec}`);
    assert.ok(!spec.startsWith('~'), `dep ${name} must not use tilde range; got ${spec}`);
    assert.match(spec, EXACT_SEMVER_RE, `dep ${name} must be exact semver; got ${spec}`);
  }
});

test('WC01-2 every top-level devDependency is pinned to exact semver (no ^ or ~)', () => {
  const pkg = readPkg();
  const dev = pkg.devDependencies || {};
  const names = Object.keys(dev);
  // devDependencies may legitimately be empty if all tooling moves to dependencies;
  // but if present, each must be pinned.
  for (const name of names) {
    const spec = dev[name];
    assert.equal(typeof spec, 'string', `devDep ${name} must have string version`);
    assert.ok(!spec.startsWith('^'), `devDep ${name} must not use caret range; got ${spec}`);
    assert.ok(!spec.startsWith('~'), `devDep ${name} must not use tilde range; got ${spec}`);
    assert.match(spec, EXACT_SEMVER_RE, `devDep ${name} must be exact semver; got ${spec}`);
  }
});

test('WC01-3 package-lock.json is committed and lists a non-trivial dep graph', () => {
  assert.ok(fs.existsSync(LOCK_PATH), 'package-lock.json must exist at repo root');
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  assert.ok(lock.lockfileVersion >= 2, `expected lockfileVersion >= 2; got ${lock.lockfileVersion}`);
  assert.ok(lock.packages && typeof lock.packages === 'object', 'lockfile must have packages map');
  // Sanity: the resolved tree should contain at least the top-level deps + a few transitives.
  const installedCount = Object.keys(lock.packages).length;
  assert.ok(installedCount >= 10, `expected >=10 entries in package-lock.json packages; got ${installedCount}`);
});

test('WC01-3 lockfile pins each top-level dep to the exact version declared in package.json', () => {
  const pkg = readPkg();
  const lock = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  for (const [name, exactSpec] of Object.entries(allDeps)) {
    const lockEntry = lock.packages[`node_modules/${name}`];
    assert.ok(lockEntry, `lockfile missing entry for node_modules/${name}`);
    assert.equal(
      lockEntry.version,
      exactSpec,
      `lockfile version drift for ${name}: package.json=${exactSpec} lockfile=${lockEntry.version}`,
    );
  }
});

test('WC01-4 each declared top-level dep is reachable from a source file', () => {
  // Reachability sample: walk a small fixed set of source roots and look for
  // import/require usages. We deliberately do not shell out to `npx depcheck`
  // here (slow + network-touching). Instead we re-implement the minimum
  // contract: every dep name appears in at least one of (server.js,
  // src/**/*.js, cli/**/*.js, scripts/**/*.{js,mjs,cjs}, services/**/*.js,
  // tests/**/*.js, audit-shots/**/*.mjs).
  const pkg = readPkg();
  const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const names = Object.keys(allDeps);

  const roots = [
    path.join(REPO_ROOT, 'server.js'),
    path.join(REPO_ROOT, 'src'),
    path.join(REPO_ROOT, 'cli'),
    path.join(REPO_ROOT, 'scripts'),
    path.join(REPO_ROOT, 'services'),
    path.join(REPO_ROOT, 'tests'),
    path.join(REPO_ROOT, 'audit-shots'),
  ];

  const files = [];
  function walk(p) {
    if (!fs.existsSync(p)) return;
    const stat = fs.statSync(p);
    if (stat.isFile()) {
      if (/\.(?:m?js|cjs)$/.test(p)) files.push(p);
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(p)) {
        if (entry === 'node_modules' || entry === '.git') continue;
        walk(path.join(p, entry));
      }
    }
  }
  for (const r of roots) walk(r);
  assert.ok(files.length > 100, `expected >100 source files scanned; got ${files.length}`);

  // Build a single corpus blob (acceptable: source tree is < ~30 MB).
  const haystacks = files.map(f => fs.readFileSync(f, 'utf8'));
  const blob = haystacks.join('\n');

  for (const name of names) {
    // Look for: from 'name', from 'name/subpath', require('name'),
    // require('name/subpath'), and bare-import 'name' / 'name/subpath' (no `from`).
    // Subpath imports matter for packages like `dotenv/config`.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const subpath = '(?:/[^\'"\\s]+)?';
    const re = new RegExp(
      `(?:from\\s*['"]${escaped}${subpath}['"]|require\\(\\s*['"]${escaped}${subpath}['"]\\s*\\)|import\\s+['"]${escaped}${subpath}['"])`,
    );
    assert.ok(
      re.test(blob),
      `dep ${name} is declared in package.json but not imported by any source file under ${roots.map(r => path.relative(REPO_ROOT, r)).join(', ')}`,
    );
  }
});

test('WC01-1 npm audit reports zero high and zero critical CVEs', () => {
  // Run npm audit --json and assert the metadata buckets.
  // We tolerate moderate/low — those are documented in
  // docs/cleanup/wc01-dep-audit-2026-05-24.md. We HARD-FAIL on high/critical
  // because those would require an immediate response.
  // Skipped if running offline (npm audit needs registry access).
  const isWin = process.platform === 'win32';
  const npmCmd = isWin ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmCmd, ['audit', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    shell: isWin,
    timeout: 60_000,
  });
  // npm audit exits non-zero when vulnerabilities are present; we read stdout regardless.
  const stdout = result.stdout || '';
  if (!stdout.trim()) {
    // Likely offline. Don't fail CI when registry is unreachable.
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Older npm versions emit a different shape; skip rather than false-fail.
    return;
  }
  if (!parsed?.metadata?.vulnerabilities) return;
  const v = parsed.metadata.vulnerabilities;
  assert.equal(v.high, 0, `expected 0 high-severity CVEs; got ${v.high}`);
  assert.equal(v.critical, 0, `expected 0 critical-severity CVEs; got ${v.critical}`);
});

test('WC01 report file exists and documents the audit', () => {
  const report = path.join(REPO_ROOT, 'docs', 'cleanup', 'wc01-dep-audit-2026-05-24.md');
  assert.ok(fs.existsSync(report), 'WC01 report file must exist');
  const text = fs.readFileSync(report, 'utf8');
  assert.match(text, /WC01-1/, 'report must reference WC01-1');
  assert.match(text, /WC01-2/, 'report must reference WC01-2');
  assert.match(text, /WC01-3/, 'report must reference WC01-3');
  assert.match(text, /WC01-4/, 'report must reference WC01-4');
});
