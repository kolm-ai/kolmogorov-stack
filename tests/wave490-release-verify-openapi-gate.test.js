// W490 — pin the new openapi-sync gate inside scripts/release-verify.cjs.
//
// Why this lock-in: release-verify is the "did we ship?" gate sweep. If
// someone removes the openapi-sync gate (or replaces its semantics) the
// 11-vs-344 OpenAPI drift hole that W485 closed could quietly re-open.
//
// This test parses the actual release-verify driver source for:
//   1. The gate function definition (gateOpenapiSync).
//   2. The gate registration in main() before gateTests/gateSdkSmoke.
//   3. The shouldRun('openapi-sync') skip-name binding so --skip=openapi-sync
//      stays a valid CLI override.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(REPO, 'scripts', 'release-verify.cjs'), 'utf8');

test('W490 #1 — gateOpenapiSync is defined in release-verify.cjs', () => {
  assert.match(SRC, /async function gateOpenapiSync\(\)/,
    'gateOpenapiSync must exist; W485 OpenAPI drift cannot regress silently');
});

test('W490 #2 — main() awaits gateOpenapiSync before tests + sdk-smoke', () => {
  // We want it ordered: lint:refs -> openapi-sync -> tests -> sdk-smoke
  const m = SRC.match(/await gateLintRefs[\s\S]{0,400}/);
  assert.ok(m, 'main() block not found');
  assert.match(m[0], /await gateOpenapiSync\(\)/, 'openapi-sync must be in main() after lint:refs');
  // Verify call ordering inside main(): openapi-sync awaited before tests, before sdk-smoke
  const idxOpenapi = SRC.indexOf('await gateOpenapiSync()');
  const idxTests = SRC.indexOf('await gateTests()');
  const idxSdk = SRC.indexOf('await gateSdkSmoke()');
  assert.ok(idxOpenapi > 0 && idxTests > idxOpenapi, 'openapi-sync must run before tests');
  assert.ok(idxSdk > idxTests, 'sdk-smoke must run after tests');
});

test('W490 #3 — gate uses shouldRun("openapi-sync") so --skip works', () => {
  assert.match(SRC, /shouldRun\(\s*['"]openapi-sync['"]\s*\)/,
    'gateOpenapiSync must respect --skip=openapi-sync');
});

test('W490 #4 — gate reads both api-routes.json AND openapi.json (real check)', () => {
  // The gate must compare both files; if it only reads one it's not a sync gate.
  const fnStart = SRC.indexOf('async function gateOpenapiSync');
  assert.ok(fnStart > 0);
  const fnSlice = SRC.slice(fnStart, fnStart + 2500);
  assert.match(fnSlice, /openapi\.json/, 'gate must read public/openapi.json');
  assert.match(fnSlice, /api-routes\.json/, 'gate must read public/docs/api-routes.json');
  assert.match(fnSlice, /stub/, 'gate must skip route-doc entries whose inline documentation is still pending');
});

test('W490 #5 — header comment lists openapi-sync as gate #2', () => {
  // Documentation lock-in: future maintainers should see the gate listed
  // in the top-of-file comment summary so the contract is self-describing.
  const headSlice = SRC.slice(0, 1500);
  assert.match(headSlice, /openapi-sync/, 'top-of-file gate list must mention openapi-sync');
});
test('W490 #6 - release-verify exposes configurable full-suite timeout', () => {
  assert.match(SRC, /--test-timeout-ms=/,
    'release-verify usage must document --test-timeout-ms for the full test gate');
  assert.match(SRC, /KOLM_RELEASE_VERIFY_TEST_TIMEOUT_MS/,
    'release-verify must support KOLM_RELEASE_VERIFY_TEST_TIMEOUT_MS');
  assert.match(SRC, /const TEST_TIMEOUT_MS =/,
    'release-verify must define TEST_TIMEOUT_MS separately from wall timeout');
  assert.match(SRC, /timeout_ms: TEST_TIMEOUT_MS/,
    'test gate result must report the timeout it used for diagnostics');
});

test('W490 #7 - release-verify can shard the full test gate', () => {
  assert.match(SRC, /--test-shards=/,
    'release-verify usage must document --test-shards for deterministic test chunks');
  assert.match(SRC, /KOLM_RELEASE_VERIFY_TEST_SHARDS/,
    'release-verify must support KOLM_RELEASE_VERIFY_TEST_SHARDS');
  assert.match(SRC, /function shardTestFiles\(/,
    'release-verify must build deterministic file shards');
  assert.match(SRC, /test_shards: TEST_SHARDS/,
    'test gate result must report the shard count it used');
});

test('W490 #8 - release-verify isolates test shards from the operator home', () => {
  assert.match(SRC, /function testEnv\(/,
    'release-verify must define a per-test environment helper');
  assert.match(SRC, /HOME: home/,
    'release-verify test env must set an isolated HOME');
  assert.match(SRC, /NODE_ENV: 'test'/,
    'release-verify test env must set NODE_ENV=test for shared test-safe stores');
  assert.match(SRC, /KOLM_HOME: ''/,
    'release-verify test env must clear operator-level KOLM_HOME');
  assert.match(SRC, /KOLM_DATA_DIR: ''/,
    'release-verify test env must clear operator-level KOLM_DATA_DIR');
  assert.match(SRC, /KOLM_ARTIFACT_DIR: ''/,
    'release-verify test env must clear operator-level KOLM_ARTIFACT_DIR');
  assert.match(SRC, /env: testEnv\(`shard-\$\{i \+ 1\}`\)/,
    'sharded test runs must use isolated per-shard env');
});

test('W490 #9 - release-verify reports failing test names per shard', () => {
  assert.match(SRC, /function failedTestNames\(/,
    'release-verify must parse failing node:test names from shard output');
  assert.match(SRC, /failed_tests/,
    'release-verify shard summaries must include failed_tests when available');
});
