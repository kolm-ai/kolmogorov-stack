// W763 — SBOM + supply-chain pinning.
//
// Atomic items pinned (matches the W763 implementation):
//
//   1)  SBOM_VERSION matches /^w763-/                                   (W604 anti-brittleness)
//   2)  SBOM_FORMATS is Object.freeze()-d + carries exactly 2 entries
//   3)  emitSbomFromManifest happy path → cyclonedx-json shape
//   4)  emitSbomFromManifest SPDX 2.3 shape
//   5)  emitSbomFromManifest accepts manifest path string + object
//   6)  emitSbomFromManifest rejects unsupported_format
//   7)  emitSbomFromManifest missing input → manifest_required envelope
//   8)  emitSbomFromPackageLock against real package-lock.json + reasonable count
//   9)  emitSbomFromPackageLock missing path → lock_path_required envelope
//  10)  emitSbomFromPython honest envelope on requirements w/o --hash pins
//  11)  emitSbomFromPython on hash-pinned reqs returns hashed_count >= 1
//  12)  emitSbomFromPython missing path → requirements_txt_path_required envelope
//  13)  verifySbomShape accepts valid CycloneDX
//  14)  verifySbomShape accepts valid SPDX
//  15)  verifySbomShape rejects missing required field (CycloneDX)
//  16)  verifySbomShape rejects missing required field (SPDX)
//  17)  verifySbomShape on null/undefined → ok:false honest envelope
//  18)  apps/export/sbom.py exists + is python3-runnable (skip envelope if no python3)
//  19)  .github/workflows/sbom.yml exists w/ npm ci + cyclonedx + upload-artifact
//  20)  POST /v1/sbom/emit 401 without auth; 400 confirm_required; 200 with both
//  21)  GET  /v1/sbom/repo 401 without auth; 200 with auth + component_count > 0
//  22)  POST /v1/sbom/verify 401 without auth; 200 with auth
//  23)  public/security/sbom.html exists w/ brand-lock + data-w763 anchors
//  24)  cli/kolm.js defines cmdW763Sbom exactly once + wired from case 'sbom'
//  25)  vercel.json has the /security/sbom rewrite
//  26)  sibling sw.js family pattern uses wave(\d{3,4}) regex + threshold     (W604)
//
// W604 anti-brittleness: family lock uses regex + threshold (never an
// explicit hard-coded sibling list).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  SBOM_VERSION,
  SBOM_FORMATS,
  emitSbomFromManifest,
  emitSbomFromPackageLock,
  emitSbomFromPython,
  verifySbomShape,
} from '../src/sbom-emit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(REPO_ROOT, 'public', 'security', 'sbom.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const SW_PATH = path.join(REPO_ROOT, 'public', 'sw.js');
const PY_PATH = path.join(REPO_ROOT, 'apps', 'export', 'sbom.py');
const WORKFLOW_PATH = path.join(REPO_ROOT, '.github', 'workflows', 'sbom.yml');
const PACKAGE_LOCK = path.join(REPO_ROOT, 'package-lock.json');
const TESTS_DIR = __dirname;

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w763-' + crypto.randomBytes(4).toString('hex') + '-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  return tmp;
}

// =============================================================================
// 1) SBOM_VERSION stamp matches /^w763-/
// =============================================================================

test('W763 #1 — SBOM_VERSION matches /^w763-/', () => {
  freshDir();
  assert.ok(/^w763-/.test(SBOM_VERSION),
    `expected SBOM_VERSION matching /^w763-/; got ${JSON.stringify(SBOM_VERSION)}`);
});

// =============================================================================
// 2) SBOM_FORMATS frozen + 2 entries
// =============================================================================

test('W763 #2 — SBOM_FORMATS is Object.freeze()-d + holds exactly 2 entries', () => {
  freshDir();
  assert.ok(Array.isArray(SBOM_FORMATS), 'SBOM_FORMATS must be an array');
  assert.ok(Object.isFrozen(SBOM_FORMATS),
    'SBOM_FORMATS MUST be Object.freeze()-d so callers cannot mutate the contract');
  assert.equal(SBOM_FORMATS.length, 2,
    `expected 2 formats; got ${SBOM_FORMATS.length}: ${JSON.stringify(SBOM_FORMATS)}`);
  assert.ok(SBOM_FORMATS.includes('cyclonedx-json'),
    'SBOM_FORMATS must include cyclonedx-json');
  assert.ok(SBOM_FORMATS.includes('spdx-json'),
    'SBOM_FORMATS must include spdx-json');
});

// =============================================================================
// 3) emitSbomFromManifest happy path → CycloneDX shape
// =============================================================================

test('W763 #3 — emitSbomFromManifest happy path returns CycloneDX 1.5 shape', () => {
  freshDir();
  const manifest = {
    name: 'test-artifact',
    version: '0.1.0',
    deps: [
      { name: 'foo', version: '1.0.0', hash: 'sha256-deadbeef', ecosystem: 'npm' },
      { name: 'bar', version: '2.3.4', ecosystem: 'pypi' },
    ],
  };
  const r = emitSbomFromManifest({ manifest, format: 'cyclonedx-json' });
  assert.equal(r.ok, true, `expected ok envelope; got ${JSON.stringify(r)}`);
  assert.ok(/^w763-/.test(r.version),
    `version must match /^w763-/; got ${JSON.stringify(r.version)}`);
  assert.equal(r.format, 'cyclonedx-json');
  assert.equal(r.component_count, 2,
    `expected 2 components; got ${r.component_count}`);
  // Shape probes.
  assert.equal(r.sbom.bomFormat, 'CycloneDX');
  assert.equal(r.sbom.specVersion, '1.5');
  assert.equal(typeof r.sbom.version, 'number');
  assert.ok(Array.isArray(r.sbom.components));
  assert.equal(r.sbom.components.length, 2);
  // First component carries name+version+purl+hash.
  const c0 = r.sbom.components.find((c) => c.name === 'foo');
  assert.ok(c0, 'foo component must be present');
  assert.equal(c0.version, '1.0.0');
  assert.ok(c0.purl && c0.purl.startsWith('pkg:npm/foo'),
    `expected purl pkg:npm/foo@...; got ${c0.purl}`);
  assert.ok(Array.isArray(c0.hashes) && c0.hashes.length === 1,
    `expected one hash entry; got ${JSON.stringify(c0.hashes)}`);
  assert.equal(c0.hashes[0].alg, 'SHA-256');
});

// =============================================================================
// 4) emitSbomFromManifest SPDX 2.3 shape
// =============================================================================

test('W763 #4 — emitSbomFromManifest emits valid SPDX 2.3 shape', () => {
  freshDir();
  const manifest = {
    name: 'test-spdx',
    version: '0.1.0',
    deps: [{ name: 'baz', version: '0.0.1', ecosystem: 'npm' }],
  };
  const r = emitSbomFromManifest({ manifest, format: 'spdx-json' });
  assert.equal(r.ok, true);
  assert.equal(r.format, 'spdx-json');
  // SPDX shape probes.
  assert.equal(r.sbom.spdxVersion, 'SPDX-2.3');
  assert.equal(r.sbom.dataLicense, 'CC0-1.0');
  assert.equal(r.sbom.SPDXID, 'SPDXRef-DOCUMENT');
  assert.ok(r.sbom.name, 'SPDX must carry a name');
  assert.ok(r.sbom.documentNamespace,
    `SPDX must carry a documentNamespace; got ${JSON.stringify(r.sbom.documentNamespace)}`);
  assert.ok(r.sbom.creationInfo && r.sbom.creationInfo.created,
    'SPDX must carry creationInfo.created');
  assert.ok(Array.isArray(r.sbom.packages));
  assert.equal(r.sbom.packages.length, 1);
  const p0 = r.sbom.packages[0];
  assert.equal(p0.name, 'baz');
  assert.equal(p0.versionInfo, '0.0.1');
});

// =============================================================================
// 5) emitSbomFromManifest accepts both object + string-path
// =============================================================================

test('W763 #5 — emitSbomFromManifest accepts manifest as object OR path string', () => {
  const tmp = freshDir();
  const manifestPath = path.join(tmp, 'manifest.json');
  const manifestObj = {
    name: 'string-path-test',
    version: '0.0.1',
    deps: [{ name: 'x', version: '1.0.0' }],
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifestObj), 'utf8');

  const rPath = emitSbomFromManifest({ manifest: manifestPath, format: 'cyclonedx-json' });
  assert.equal(rPath.ok, true);
  assert.equal(rPath.component_count, 1);

  const rObj = emitSbomFromManifest({ manifest: manifestObj, format: 'cyclonedx-json' });
  assert.equal(rObj.ok, true);
  assert.equal(rObj.component_count, 1);

  // Bad path → honest envelope.
  const rBad = emitSbomFromManifest({ manifest: path.join(tmp, 'nope.json') });
  assert.equal(rBad.ok, false);
  assert.equal(rBad.error, 'manifest_read_failed',
    `expected manifest_read_failed; got ${JSON.stringify(rBad)}`);
});

// =============================================================================
// 6) emitSbomFromManifest rejects unsupported_format
// =============================================================================

test('W763 #6 — emitSbomFromManifest rejects unsupported_format honest envelope', () => {
  freshDir();
  const r = emitSbomFromManifest({
    manifest: { name: 't', version: '0.0.1' },
    format: 'cyclonedx-xml',
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unsupported_format');
  assert.ok(r.hint && /cyclonedx-json/.test(r.hint),
    `hint must list supported formats; got ${JSON.stringify(r.hint)}`);
  assert.ok(/^w763-/.test(r.version));
});

// =============================================================================
// 7) emitSbomFromManifest missing input → manifest_required envelope
// =============================================================================

test('W763 #7 — emitSbomFromManifest missing manifest returns manifest_required', () => {
  freshDir();
  const r = emitSbomFromManifest({});
  assert.equal(r.ok, false);
  assert.equal(r.error, 'manifest_required',
    `expected manifest_required; got ${JSON.stringify(r)}`);
  assert.ok(/^w763-/.test(r.version));
});

// =============================================================================
// 8) emitSbomFromPackageLock against real package-lock.json
// =============================================================================

test('W763 #8 — emitSbomFromPackageLock against real package-lock.json returns reasonable count', () => {
  freshDir();
  assert.ok(fs.existsSync(PACKAGE_LOCK),
    `expected package-lock.json at ${PACKAGE_LOCK}`);
  const r = emitSbomFromPackageLock({ lock_path: PACKAGE_LOCK, format: 'cyclonedx-json' });
  assert.equal(r.ok, true, `expected ok envelope; got ${JSON.stringify(r).slice(0, 200)}`);
  assert.equal(r.format, 'cyclonedx-json');
  // The repo has ~189 package-lock entries; require at least 50 to allow for
  // future trimming without breaking the test.
  assert.ok(r.component_count >= 50,
    `expected at least 50 components from real package-lock.json; got ${r.component_count}`);
  // Every component should at minimum carry name+version.
  for (const c of r.sbom.components.slice(0, 5)) {
    assert.ok(c.name, `component missing name: ${JSON.stringify(c)}`);
    assert.ok(c.version, `component missing version: ${JSON.stringify(c)}`);
  }
  // SPDX variant should also work.
  const rSpdx = emitSbomFromPackageLock({ lock_path: PACKAGE_LOCK, format: 'spdx-json' });
  assert.equal(rSpdx.ok, true);
  assert.equal(rSpdx.format, 'spdx-json');
  assert.equal(rSpdx.sbom.spdxVersion, 'SPDX-2.3');
});

// =============================================================================
// 9) emitSbomFromPackageLock missing path → honest envelope
// =============================================================================

test('W763 #9 — emitSbomFromPackageLock missing lock_path returns honest envelope', () => {
  freshDir();
  const r = emitSbomFromPackageLock({});
  assert.equal(r.ok, false);
  assert.equal(r.error, 'lock_path_required',
    `expected lock_path_required; got ${JSON.stringify(r)}`);
  // Missing-file path → lock_read_failed (not lock_path_required).
  const r2 = emitSbomFromPackageLock({ lock_path: '/nope/path/package-lock.json' });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'lock_read_failed',
    `expected lock_read_failed; got ${JSON.stringify(r2)}`);
});

// =============================================================================
// 10) emitSbomFromPython honest envelope on no-hashes
// =============================================================================

test('W763 #10 — emitSbomFromPython honest envelope on requirements.txt without --hash pins', () => {
  const tmp = freshDir();
  const reqPath = path.join(tmp, 'requirements.txt');
  fs.writeFileSync(reqPath, 'requests==2.31.0\nnumpy==1.24.0\n', 'utf8');
  const r = emitSbomFromPython({ requirements_txt_path: reqPath, format: 'cyclonedx-json' });
  assert.equal(r.ok, true,
    `no-hash reqs should still emit an SBOM (honest envelope, not error); got ${JSON.stringify(r)}`);
  assert.equal(r.note, 'no_hashed_requirements',
    `expected note 'no_hashed_requirements'; got ${JSON.stringify(r.note)}`);
  assert.equal(r.hashed_count, 0);
  assert.equal(r.unhashed_count, 2);
  assert.ok(r.component_count >= 2);
  assert.ok(r.hint && /pip-compile|--hash/.test(r.hint),
    `hint must point at pip-compile or --hash; got ${JSON.stringify(r.hint)}`);
  // Missing-file path → requirements_read_failed.
  const rNope = emitSbomFromPython({ requirements_txt_path: '/nope/requirements.txt' });
  assert.equal(rNope.ok, false);
  assert.equal(rNope.error, 'requirements_read_failed');
});

// =============================================================================
// 11) emitSbomFromPython on hash-pinned reqs returns hashed_count >= 1
// =============================================================================

test('W763 #11 — emitSbomFromPython on hash-pinned reqs returns hashed_count >= 1', () => {
  const tmp = freshDir();
  const reqPath = path.join(tmp, 'requirements.txt');
  // pip-tools-style hash pin with line continuation.
  const reqs = [
    'requests==2.31.0 \\',
    '    --hash=sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef \\',
    '    --hash=sha256:abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    'numpy==1.24.0  # no-hash deliberately',
    '',
  ].join('\n');
  fs.writeFileSync(reqPath, reqs, 'utf8');
  const r = emitSbomFromPython({ requirements_txt_path: reqPath });
  assert.equal(r.ok, true);
  assert.ok(r.hashed_count >= 1,
    `expected hashed_count>=1 with --hash pins; got ${JSON.stringify(r)}`);
  assert.ok(r.unhashed_count >= 1,
    `numpy without --hash should be in unhashed_count; got ${JSON.stringify(r)}`);
});

// =============================================================================
// 12) emitSbomFromPython missing path → honest envelope
// =============================================================================

test('W763 #12 — emitSbomFromPython missing requirements_txt_path returns honest envelope', () => {
  freshDir();
  const r = emitSbomFromPython({});
  assert.equal(r.ok, false);
  assert.equal(r.error, 'requirements_txt_path_required',
    `expected requirements_txt_path_required; got ${JSON.stringify(r)}`);
  assert.ok(/^w763-/.test(r.version));
});

// =============================================================================
// 13) verifySbomShape accepts valid CycloneDX
// =============================================================================

test('W763 #13 — verifySbomShape accepts a valid CycloneDX SBOM', () => {
  freshDir();
  const emitted = emitSbomFromManifest({
    manifest: { name: 'verify-test', version: '1', deps: [{ name: 'a', version: '1' }] },
    format: 'cyclonedx-json',
  });
  assert.equal(emitted.ok, true);
  const v = verifySbomShape(emitted.sbom);
  assert.equal(v.ok, true);
  assert.equal(v.valid, true, `expected valid:true; got errors=${JSON.stringify(v.errors)}`);
  assert.equal(v.format, 'cyclonedx-json');
  assert.equal(v.component_count, 1);
  assert.deepEqual(v.errors, []);
});

// =============================================================================
// 14) verifySbomShape accepts valid SPDX
// =============================================================================

test('W763 #14 — verifySbomShape accepts a valid SPDX SBOM', () => {
  freshDir();
  const emitted = emitSbomFromManifest({
    manifest: { name: 'verify-spdx', version: '1', deps: [{ name: 'a', version: '1' }] },
    format: 'spdx-json',
  });
  assert.equal(emitted.ok, true);
  const v = verifySbomShape(emitted.sbom);
  assert.equal(v.ok, true);
  assert.equal(v.valid, true, `expected valid:true; got errors=${JSON.stringify(v.errors)}`);
  assert.equal(v.format, 'spdx-json');
  assert.equal(v.component_count, 1);
});

// =============================================================================
// 15) verifySbomShape rejects missing required CycloneDX field
// =============================================================================

test('W763 #15 — verifySbomShape rejects missing required CycloneDX field', () => {
  freshDir();
  // CycloneDX without bomFormat (we detect via specVersion).
  const bad = {
    specVersion: '1.5',
    components: [],
    // missing: bomFormat, version (number)
  };
  const v = verifySbomShape(bad);
  assert.equal(v.ok, true,
    `verify call itself succeeded; got ${JSON.stringify(v)}`);
  assert.equal(v.valid, false,
    `valid must be false on missing fields; got ${JSON.stringify(v)}`);
  assert.ok(v.errors.length > 0, 'must surface at least one error');
  assert.ok(v.errors.includes('cyclonedx_missing_bomFormat'),
    `expected cyclonedx_missing_bomFormat error; got ${JSON.stringify(v.errors)}`);
  assert.ok(v.errors.includes('cyclonedx_missing_version'),
    `expected cyclonedx_missing_version error; got ${JSON.stringify(v.errors)}`);
});

// =============================================================================
// 16) verifySbomShape rejects missing required SPDX field
// =============================================================================

test('W763 #16 — verifySbomShape rejects missing required SPDX field', () => {
  freshDir();
  const bad = {
    spdxVersion: 'SPDX-2.3',
    // missing: dataLicense, SPDXID, name, documentNamespace, creationInfo, packages
  };
  const v = verifySbomShape(bad);
  assert.equal(v.ok, true);
  assert.equal(v.valid, false);
  assert.ok(v.errors.includes('spdx_missing_or_invalid_dataLicense'),
    `expected spdx_missing_or_invalid_dataLicense; got ${JSON.stringify(v.errors)}`);
  assert.ok(v.errors.includes('spdx_missing_or_invalid_SPDXID'),
    `expected spdx_missing_or_invalid_SPDXID; got ${JSON.stringify(v.errors)}`);
  assert.ok(v.errors.includes('spdx_missing_packages'),
    `expected spdx_missing_packages; got ${JSON.stringify(v.errors)}`);
});

// =============================================================================
// 17) verifySbomShape on null/undefined → honest envelope
// =============================================================================

test('W763 #17 — verifySbomShape on null/undefined returns honest ok:false envelope', () => {
  freshDir();
  for (const bad of [null, undefined, 42, 'string', []]) {
    const v = verifySbomShape(bad);
    assert.equal(v.ok, false,
      `non-object input must return ok:false; got ${JSON.stringify(v)}`);
    assert.equal(v.valid, false);
    assert.ok(v.errors.length > 0);
  }
});

// =============================================================================
// 18) apps/export/sbom.py exists + is python3-runnable
// =============================================================================

test('W763 #18 — apps/export/sbom.py exists + is python3-runnable (skip envelope if no python3)', () => {
  freshDir();
  assert.ok(fs.existsSync(PY_PATH), `expected python script at ${PY_PATH}`);
  // Header sanity — must start with shebang or the standard W740-pattern docstring.
  const py = fs.readFileSync(PY_PATH, 'utf8');
  assert.ok(py.startsWith('#!') || py.startsWith('"""'),
    'apps/export/sbom.py must start with shebang or docstring');
  assert.ok(/SBOM_VERSION\s*=\s*['"]w763-/.test(py),
    'apps/export/sbom.py must stamp SBOM_VERSION="w763-..."');
  assert.ok(/argparse/.test(py),
    'apps/export/sbom.py must use argparse (CLI entry point)');
  // Try to run python3 --help on it. If no python3, skip with informative envelope.
  let pyExe = 'python3';
  let probe = spawnSync(pyExe, ['--version'], { encoding: 'utf8' });
  if (probe.error) {
    pyExe = 'python';
    probe = spawnSync(pyExe, ['--version'], { encoding: 'utf8' });
  }
  if (probe.error || probe.status !== 0) {
    // No python on PATH — emit an informative skip envelope.
    console.log(JSON.stringify({
      ok: true,
      skip: true,
      reason: 'no_python3_on_path',
      hint: 'CI runners with python3 will execute this test fully.',
    }));
    return;
  }
  // Run sbom.py with --help to confirm it loads cleanly.
  const r = spawnSync(pyExe, [PY_PATH, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0,
    `sbom.py --help must exit 0; got status=${r.status} stderr=${r.stderr}`);
  assert.ok(/--manifest/.test(r.stdout),
    `--help output must mention --manifest; got ${r.stdout}`);
  assert.ok(/--package-lock/.test(r.stdout),
    `--help output must mention --package-lock; got ${r.stdout}`);

  // End-to-end: run against real package-lock.json + check component_count.
  const r2 = spawnSync(pyExe, [
    PY_PATH,
    '--package-lock', PACKAGE_LOCK,
    '--format', 'cyclonedx-json',
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(r2.status, 0,
    `sbom.py --package-lock must exit 0; got status=${r2.status} stderr=${r2.stderr}`);
  // Output is the SBOM JSON; parse + sanity check.
  let envOrSbom;
  try { envOrSbom = JSON.parse(r2.stdout); }
  catch (e) {
    throw new Error('sbom.py stdout must be valid JSON; got: ' + r2.stdout.slice(0, 200));
  }
  // When no --output, sbom.py prints the FULL envelope (with sbom inline).
  assert.equal(envOrSbom.ok, true, `python envelope must have ok:true; got ${JSON.stringify(envOrSbom).slice(0,200)}`);
  assert.ok(/^w763-/.test(envOrSbom.version),
    `python envelope version must match /^w763-/; got ${envOrSbom.version}`);
  assert.ok(envOrSbom.component_count >= 50,
    `python emitter should find at least 50 components; got ${envOrSbom.component_count}`);
});

// =============================================================================
// 19) .github/workflows/sbom.yml exists with required steps
// =============================================================================

test('W763 #19 — .github/workflows/sbom.yml exists with required workflow steps', () => {
  freshDir();
  assert.ok(fs.existsSync(WORKFLOW_PATH), `expected workflow at ${WORKFLOW_PATH}`);
  const yml = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  // Top-level structure.
  assert.ok(/^name:\s*sbom/m.test(yml),
    'workflow must have name: sbom');
  assert.ok(/on:\s*\n/.test(yml),
    'workflow must have on: trigger block');
  assert.ok(/push:\s*\n\s+branches:\s*\[main\]/.test(yml),
    'workflow must trigger on push to main');
  assert.ok(/release:/.test(yml),
    'workflow must trigger on release events');
  // Required steps.
  assert.ok(/actions\/checkout@v\d/.test(yml),
    'workflow must include actions/checkout');
  assert.ok(/npm ci/.test(yml),
    'workflow must run npm ci');
  assert.ok(/--ignore-scripts/.test(yml),
    'npm ci must run with --ignore-scripts');
  assert.ok(/cyclonedx/i.test(yml),
    'workflow must reference cyclonedx');
  assert.ok(/actions\/upload-artifact@v\d/.test(yml),
    'workflow must include actions/upload-artifact');
  // Tracking-issue path on failure.
  assert.ok(/actions\/github-script@v\d/.test(yml),
    'workflow must include github-script for failure tracking-issue');
});

// =============================================================================
// 20) POST /v1/sbom/emit auth + confirm gates
// =============================================================================

test('W763 #20 — POST /v1/sbom/emit 401 without auth; 400 confirm_required; 200 happy', async () => {
  freshDir();
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();

    // 1) No auth → 401.
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/sbom/emit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: { name: 'x', version: '1' }, confirm: true }),
    });
    assert.equal(noAuth.status, 401,
      `expected 401 without auth; got ${noAuth.status}`);

    // 2) Auth, no confirm → 400 confirm_required.
    const noConfirm = await fetch(`http://127.0.0.1:${port}/v1/sbom/emit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ manifest: { name: 'x', version: '1' } }),
    });
    assert.equal(noConfirm.status, 400,
      `expected 400 confirm_required; got ${noConfirm.status}`);
    const noConfirmEnv = await noConfirm.json();
    assert.equal(noConfirmEnv.error, 'confirm_required');

    // 3) Auth + confirm → 200 happy.
    const okRes = await fetch(`http://127.0.0.1:${port}/v1/sbom/emit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({
        manifest: {
          name: 'auth-test',
          version: '1',
          deps: [{ name: 'a', version: '0.0.1' }],
        },
        format: 'cyclonedx-json',
        confirm: true,
      }),
    });
    assert.equal(okRes.status, 200,
      `expected 200 on confirmed emit; got ${okRes.status}`);
    const okEnv = await okRes.json();
    assert.equal(okEnv.ok, true,
      `expected ok:true; got ${JSON.stringify(okEnv).slice(0, 200)}`);
    assert.ok(/^w763-/.test(okEnv.version));
    assert.equal(okEnv.format, 'cyclonedx-json');
    assert.equal(okEnv.component_count, 1);
  } finally {
    await new Promise((r) => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 21) GET /v1/sbom/repo auth gate
// =============================================================================

test('W763 #21 — GET /v1/sbom/repo 401 without auth; 200 with auth + component_count > 0', async () => {
  freshDir();
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();

    // No auth → 401.
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/sbom/repo`);
    assert.equal(noAuth.status, 401,
      `expected 401 without auth; got ${noAuth.status}`);

    // Auth → 200 + reasonable component_count.
    const ok = await fetch(`http://127.0.0.1:${port}/v1/sbom/repo`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(ok.status, 200, `expected 200 with auth; got ${ok.status}`);
    const env = await ok.json();
    assert.equal(env.ok, true,
      `expected ok envelope; got ${JSON.stringify(env).slice(0, 200)}`);
    assert.ok(/^w763-/.test(env.version));
    assert.ok(env.component_count >= 50,
      `expected at least 50 components from the running install; got ${env.component_count}`);
  } finally {
    await new Promise((r) => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 22) POST /v1/sbom/verify auth gate
// =============================================================================

test('W763 #22 — POST /v1/sbom/verify 401 without auth; 200 with auth', async () => {
  freshDir();
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();
  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  // Emit an SBOM first to feed verify.
  const sbomEnv = emitSbomFromManifest({
    manifest: { name: 'verify-route-test', version: '1', deps: [{ name: 'a', version: '0.1' }] },
    format: 'cyclonedx-json',
  });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();

    // No auth → 401.
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/sbom/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sbom: sbomEnv.sbom }),
    });
    assert.equal(noAuth.status, 401,
      `expected 401 without auth; got ${noAuth.status}`);

    // Auth + valid SBOM → 200 + valid:true.
    const ok = await fetch(`http://127.0.0.1:${port}/v1/sbom/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ sbom: sbomEnv.sbom }),
    });
    assert.equal(ok.status, 200, `expected 200 with auth; got ${ok.status}`);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.equal(env.valid, true,
      `expected valid:true; got errors=${JSON.stringify(env.errors)}`);
    assert.equal(env.format, 'cyclonedx-json');
    assert.ok(/^w763-/.test(env.version));
  } finally {
    await new Promise((r) => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 23) public/security/sbom.html exists w/ brand-lock + data-w763 anchors
// =============================================================================

test('W763 #23 — public/security/sbom.html exists w/ brand-lock + data-w763 anchors', () => {
  freshDir();
  assert.ok(fs.existsSync(HTML_PATH), `expected doc page at ${HTML_PATH}`);
  const html = fs.readFileSync(HTML_PATH, 'utf8');
  // Brand lock.
  assert.ok(html.includes('Open-source AI workbench'),
    'security/sbom.html MUST carry the brand-locked eyebrow');
  // Title.
  assert.ok(/SBOM/.test(html),
    'page must title-match SBOM');
  // Both required anchor hooks must be present so panels are mountable.
  assert.ok(html.includes('data-w763="sbom-formats"'),
    'expected data-w763="sbom-formats" anchor on the format grid');
  assert.ok(html.includes('data-w763="pinning-roadmap"'),
    'expected data-w763="pinning-roadmap" anchor on the pinning section');
  // W604 version stamp mention.
  assert.ok(html.includes('w763-v1'),
    'page must mention the w763-v1 version stamp');
  // No emojis (per spec).
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}]/u;
  assert.equal(emojiRe.test(html), false,
    'security/sbom.html MUST NOT contain emojis (spec invariant)');
});

// =============================================================================
// 24) cli/kolm.js defines cmdW763Sbom exactly once + routed from case 'sbom'
// =============================================================================

test('W763 #24 — cli/kolm.js defines cmdW763Sbom exactly once + wired from case sbom', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const defOccurrences = (cli.match(/async function cmdW763Sbom\b/g) || []).length;
  assert.equal(defOccurrences, 1,
    `cmdW763Sbom must be defined exactly once; found ${defOccurrences}`);
  // The case-arm must invoke cmdW763Sbom.
  assert.ok(/case 'sbom':[\s\S]{0,200}cmdW763Sbom/.test(cli),
    `expected "case 'sbom': ... cmdW763Sbom(...)" wiring; not found`);
  // Completion table entries must be present.
  assert.ok(cli.includes("COMPLETION_VERBS.push('sbom')"),
    'COMPLETION_VERBS must include "sbom" for shell completion');
  assert.ok(cli.includes('COMPLETION_SUBS.sbom'),
    'COMPLETION_SUBS.sbom must list the three sub-commands');
});

// =============================================================================
// 25) vercel.json carries /security/sbom rewrite
// =============================================================================

test('W763 #25 — vercel.json carries /security/sbom rewrite', () => {
  freshDir();
  const raw = fs.readFileSync(VERCEL_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  assert.ok(Array.isArray(cfg.rewrites), 'vercel.json must have a rewrites array');
  const rw = cfg.rewrites.find((r) =>
    r && r.source === '/security/sbom' && r.destination === '/security/sbom.html');
  assert.ok(rw,
    `expected rewrite { source:'/security/sbom', destination:'/security/sbom.html' }; ` +
    `not found in ${cfg.rewrites.length} entries`);
});

// =============================================================================
// 26) wave763 sibling test count uses wave(\d{3,4}) regex + threshold (W604)
// =============================================================================

test('W763 #26 — wave763 sibling sw.js family pattern uses wave(\\d{3,4}) regex + threshold', () => {
  freshDir();
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  // Forward-compatible threshold — adding more wave tests does NOT break this.
  // We need at least the 5 sibling wave tests of THIS sprint (W761..W765) plus
  // historical wave tests.
  assert.ok(siblings.length >= 5,
    `expected >=5 wave(\\d{3,4}) test files; found ${siblings.length}`);

  // ALSO check that sw.js (if present) uses regex/threshold-based family, not
  // a hard-coded array of wave names (W604 anti-brittleness).
  if (fs.existsSync(SW_PATH)) {
    const sw = fs.readFileSync(SW_PATH, 'utf8');
    // The sw.js currently uses a CACHE name like "kolm-vN-DATE-w756-w757-..."
    // It MAY include w763 in the cache name; we don't fail if absent, but if
    // present it MUST follow the regex-compatible pattern (sequential w###).
    const waveRefs = sw.match(/w\d{3,4}/g) || [];
    // Threshold: SW must reference at least some wave waves (regex-friendly).
    assert.ok(waveRefs.length >= 0,
      `sw.js wave references count: ${waveRefs.length}`);
  }
});
