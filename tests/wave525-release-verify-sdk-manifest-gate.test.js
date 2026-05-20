// W525 — pin the new sdk-manifest gate inside scripts/release-verify.cjs.
//
// Why this lock-in: the browser SDK ships as content-addressed assets
// (public/sdk-<sha>.js), surfaced through public/sdk-current.json + public/
// sdk-versions.json. The manifest is what every <script src="/sdk-..."> tag
// on the marketing site dereferences. If the manifest goes stale (SDK rebuild
// without manifest bump, manifest bump without re-publish, .gitignore mask
// that hides the asset) the production landing pages still load — but
// against an SDK blob that no longer matches its SRI, so the browser refuses
// to execute it.  That was the failure mode the W470 P1-6 / W490 sweep was
// designed to catch ONCE; W525 makes it impossible to silently rip back out.
//
// This test parses the actual release-verify driver source for:
//   1. The gate function definition (gateSdkManifest).
//   2. The gate registration in main() between openapi-sync and tests.
//   3. The SRI / sha / url / bytes equality enforced per entry.
//   4. The .gitignore guard so a SDK blob can never be ignored.
//   5. The cross-equality between sdk-current.json and sdk-versions.current.
//   6. The shouldRun('sdk-manifest') skip-name binding so --skip works.
//
// Plus a runtime check: parse public/sdk-current.json + public/sdk-versions.json
// from the actual checkout and assert the shape the gate expects exists, so a
// test author who breaks the manifest discovers it here instead of in CI.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const REPO = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(REPO, 'scripts', 'release-verify.cjs'), 'utf8');

test('W525 #1 — gateSdkManifest is defined in release-verify.cjs', () => {
  assert.match(SRC, /async function gateSdkManifest\(\)/,
    'gateSdkManifest must exist; SDK manifest drift cannot regress silently');
});

test('W525 #2 — main() awaits gateSdkManifest between openapi-sync and tests', () => {
  const idxOpenapi = SRC.indexOf('await gateOpenapiSync()');
  const idxManifest = SRC.indexOf('await gateSdkManifest()');
  const idxTests = SRC.indexOf('await gateTests()');
  assert.ok(idxOpenapi > 0, 'gateOpenapiSync call missing from main()');
  assert.ok(idxManifest > 0, 'gateSdkManifest call missing from main()');
  assert.ok(idxTests > 0, 'gateTests call missing from main()');
  assert.ok(idxManifest > idxOpenapi, 'sdk-manifest must run after openapi-sync');
  assert.ok(idxTests > idxManifest, 'sdk-manifest must run before tests (cheap gate first)');
});

test('W525 #3 — gate uses shouldRun("sdk-manifest") so --skip works', () => {
  assert.match(SRC, /shouldRun\(\s*['"]sdk-manifest['"]\s*\)/,
    'gateSdkManifest must respect --skip=sdk-manifest');
});

test('W525 #4 — verifySdkEntry enforces sha / sri / url / bytes equality', () => {
  // The gate must compare each manifest entry against the actual file on disk.
  // If it only checks one field, the manifest can drift past the others.
  const fnStart = SRC.indexOf('function verifySdkEntry');
  assert.ok(fnStart > 0, 'verifySdkEntry helper must exist');
  const fnSlice = SRC.slice(fnStart, fnStart + 2000);
  assert.match(fnSlice, /sha256/, 'verifySdkEntry must hash the file (sha256 → 12-char sha)');
  assert.match(fnSlice, /sha384/, 'verifySdkEntry must compute SRI as sha384');
  assert.match(fnSlice, /entry\.sha\s*!==\s*sha/, 'verifySdkEntry must compare sha');
  assert.match(fnSlice, /entry\.sri\s*!==\s*sri/, 'verifySdkEntry must compare sri');
  assert.match(fnSlice, /entry\.bytes\s*!==\s*body\.length/, 'verifySdkEntry must compare bytes');
  assert.match(fnSlice, /entry\.url\s*!==\s*`\/sdk-\$\{sha\}\.js`/,
    'verifySdkEntry must verify url == /sdk-<sha>.js (content-addressed URL)');
});

test('W525 #5 — gate refuses to ship a manifest whose asset is gitignored', () => {
  assert.match(SRC, /sdkAssetIgnored/,
    'release-verify must check that referenced SDK assets are tracked by git');
  // If the asset matches public/sdk-[0-9a-f]*.js but is masked by .gitignore,
  // the failure path must surface it as a manifest failure.
  assert.match(SRC, /is ignored by git/, 'gate must report ignored SDK assets explicitly');
});

test('W525 #6 — gate cross-checks sdk-current.json against sdk-versions.current', () => {
  // sdk-current.json and sdk-versions.json.current must agree on every field;
  // otherwise the marketing site and the version listing return different
  // SDK blobs.
  const fnStart = SRC.indexOf('async function gateSdkManifest');
  assert.ok(fnStart > 0);
  const fnSlice = SRC.slice(fnStart, fnStart + 2500);
  assert.match(fnSlice, /sdk-versions\.current/,
    'gate must compare against versions.current, not just the array');
  assert.match(fnSlice, /sdk-versions\[0\]/,
    'gate must enforce sdk-current === sdk-versions[0] (latest is at index 0)');
});

test('W525 #7 — manifest files exist on disk with the shape gateSdkManifest expects', () => {
  // Runtime check: the gate is only useful if the files it reads exist and
  // have the right shape. Catch missing-key drift HERE so it surfaces at
  // unit-test time rather than in CI gate logs.
  const currentPath = path.join(REPO, 'public', 'sdk-current.json');
  const versionsPath = path.join(REPO, 'public', 'sdk-versions.json');
  assert.ok(fs.existsSync(currentPath), 'public/sdk-current.json must exist');
  assert.ok(fs.existsSync(versionsPath), 'public/sdk-versions.json must exist');
  const current = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
  const versions = JSON.parse(fs.readFileSync(versionsPath, 'utf8'));
  for (const key of ['sha', 'sri', 'url', 'bytes']) {
    assert.ok(key in current, `sdk-current.json must include ${key}`);
    assert.ok(versions.current && key in versions.current, `sdk-versions.current must include ${key}`);
    assert.equal(current[key], versions.current[key], `sdk-current.${key} must equal sdk-versions.current.${key}`);
  }
  assert.ok(Array.isArray(versions.versions) && versions.versions.length > 0,
    'sdk-versions.versions must be a non-empty array');
  assert.equal(current.url, versions.versions[0].url,
    'sdk-current.url must equal sdk-versions.versions[0].url (latest at index 0)');
});

test('W525 #8 — the SDK blob referenced by sdk-current.json exists and matches its SRI', () => {
  // Defense in depth: if the gate ever stops checking, this test still
  // catches a stale manifest committed to git.
  const current = JSON.parse(fs.readFileSync(path.join(REPO, 'public', 'sdk-current.json'), 'utf8'));
  const blob = path.join(REPO, 'public', path.basename(current.url));
  assert.ok(fs.existsSync(blob), `referenced SDK asset must exist on disk: ${blob}`);
  const body = fs.readFileSync(blob);
  const sha = crypto.createHash('sha256').update(body).digest('hex').slice(0, 12);
  const sri = 'sha384-' + crypto.createHash('sha384').update(body).digest('base64');
  assert.equal(sha, current.sha, 'sha mismatch — manifest is stale (rebuild SDK + re-publish manifest together)');
  assert.equal(sri, current.sri, 'SRI mismatch — manifest is stale');
  assert.equal(body.length, current.bytes, 'bytes mismatch — manifest is stale');
  assert.equal(current.url, `/sdk-${sha}.js`, 'URL must be content-addressed by the actual hash');
});

test('W525 #9 — header comment lists sdk-manifest as a gate', () => {
  // Documentation lock-in: future maintainers should see the gate listed
  // in the top-of-file comment summary so the contract is self-describing.
  const headSlice = SRC.slice(0, 2000);
  assert.match(headSlice, /sdk-manifest/, 'top-of-file gate list must mention sdk-manifest');
});
