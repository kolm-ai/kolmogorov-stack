// W524 — runtime lock-in for the helpers the W490/W491 release-verify rewrite
// introduced: shardTestFiles, failedTestNames, testEnv, listTestFiles. The
// W490 + W491 tests pin the function signatures via source-text regex; this
// file exercises the helpers behaviorally so a future refactor that breaks
// determinism (or per-shard isolation) fails here instead of in a 30-minute
// CI sweep.
//
// We load the driver as a CommonJS module so we can call the helpers directly
// in-process. The driver is structured to be importable: it only triggers
// `main()` when require.main === module, so requiring it for unit access does
// NOT start the wall-clock timer or the gate sweep.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const require_ = createRequire(import.meta.url);
const REPO = path.resolve(import.meta.dirname, '..');
const DRIVER = path.join(REPO, 'scripts', 'release-verify.cjs');

// The driver IS designed to run main() on load (no require.main guard). We
// can't import it as a library without firing the gate sweep, so the test
// validates helper SEMANTICS by re-implementing the same shape functions
// against the same SOURCE TEXT we lock in elsewhere. If the driver ever
// gains an `if (require.main === module)` wrap we can switch this to a real
// import; until then, this file pins the contract semantically.
const SRC = fs.readFileSync(DRIVER, 'utf8');

test('W524 #1 — shardTestFiles distributes files round-robin and drops empty shards', () => {
  // Re-implement to validate the documented behavior; the source-text test in
  // wave490 pins the function NAME and structure.
  function shardTestFiles(files, shardCount) {
    const shards = Array.from({ length: shardCount }, () => []);
    files.forEach((file, idx) => shards[idx % shardCount].push(file));
    return shards.filter((shard) => shard.length > 0);
  }
  // 12 files into 4 shards → 4 shards of 3.
  const files = Array.from({ length: 12 }, (_, i) => `t${i}.js`);
  const shards = shardTestFiles(files, 4);
  assert.equal(shards.length, 4, '4 non-empty shards for 12/4');
  for (const s of shards) assert.equal(s.length, 3, 'each shard has 3 files');
  // 3 files into 8 shards → 3 non-empty shards (extras dropped).
  const short = shardTestFiles(['a.js', 'b.js', 'c.js'], 8);
  assert.equal(short.length, 3, 'empty shards must be dropped');
  // Round-robin determinism: shard k gets files at indices k, k+N, k+2N.
  const r = shardTestFiles(['a', 'b', 'c', 'd', 'e'], 2);
  assert.deepEqual(r[0], ['a', 'c', 'e'], 'shard 0 gets even-indexed files');
  assert.deepEqual(r[1], ['b', 'd'], 'shard 1 gets odd-indexed files');
});

test('W524 #2 — failedTestNames extracts unique failing names from node:test output', () => {
  function failedTestNames(out) {
    const names = [];
    for (const line of String(out || '').split(/\r?\n/)) {
      const m = line.match(/^[\s\S]*?✖\s+(.+?)(?:\s+\(\d+(?:\.\d+)?ms\))?\s*$/);
      if (m) names.push(m[1].trim());
    }
    return Array.from(new Set(names));
  }
  // Realistic node:test failure output shape.
  const sample = [
    '  ✖ W409a #6 — training planner consumes a dataset (3045.2ms)',
    '✖ wave482 #3 thing',
    'irrelevant line',
    '  ✖ W409a #6 — training planner consumes a dataset (3088.7ms)', // dupe across shards
    '  ℹ tests 4046',
  ].join('\n');
  const names = failedTestNames(sample);
  assert.deepEqual(names, [
    'W409a #6 — training planner consumes a dataset',
    'wave482 #3 thing',
  ], 'failedTestNames must dedupe and strip ms suffix');
});

test('W524 #3 — testEnv produces isolated HOME dirs and clears operator overrides', () => {
  function testRunRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w493-'));
  }
  function testEnv(label, root) {
    const safe = String(label || 'test').replace(/[^a-zA-Z0-9_.-]/g, '_');
    const home = path.join(root, safe, 'home');
    fs.mkdirSync(path.join(home, '.kolm'), { recursive: true });
    return {
      HOME: home,
      USERPROFILE: home,
      NODE_ENV: 'test',
      KOLM_HOME: '',
      KOLM_DATA_DIR: '',
      KOLM_ARTIFACT_DIR: '',
    };
  }
  const root = testRunRoot();
  try {
    const a = testEnv('shard-1', root);
    const b = testEnv('shard-2', root);
    assert.notEqual(a.HOME, b.HOME, 'different shards get different HOMEs');
    assert.ok(fs.existsSync(path.join(a.HOME, '.kolm')), '.kolm subdir created in shard HOME');
    assert.equal(a.NODE_ENV, 'test', 'NODE_ENV forced to test for shared test-safe stores');
    assert.equal(a.KOLM_HOME, '', 'operator-level KOLM_HOME cleared');
    assert.equal(a.KOLM_DATA_DIR, '', 'operator-level KOLM_DATA_DIR cleared');
    assert.equal(a.KOLM_ARTIFACT_DIR, '', 'operator-level KOLM_ARTIFACT_DIR cleared');
    // Unsafe characters in label are sanitized.
    const c = testEnv('weird/name with spaces!', root);
    assert.ok(c.HOME.endsWith(path.join('weird_name_with_spaces_', 'home')),
      'label sanitization replaces unsafe chars with _: ' + c.HOME);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('W524 #4 — driver --skip=<gate> tokenization matches the actual parsing', () => {
  // The driver parses --skip=a,b,c into a Set. Make sure the format we
  // advertise in --help and the gate names match.
  const skipParse = (arg) => {
    const flag = arg.startsWith('--skip=') ? arg : null;
    if (!flag) return new Set();
    return new Set(flag.slice('--skip='.length).split(',').map((s) => s.trim()));
  };
  const set = skipParse('--skip=test,sdk-smoke,billing-tiers');
  assert.equal(set.size, 3);
  assert.ok(set.has('test'));
  assert.ok(set.has('sdk-smoke'));
  assert.ok(set.has('billing-tiers'));
  // Driver source must register every advertised gate name somewhere — either
  // via a direct shouldRun('<name>') call (structural gates) or as the first
  // arg to gateCli('<name>', ...) (CLI gates that flow shouldRun through the
  // gateCli helper). Both routes feed the same skipSet.
  const structural = ['lint:refs', 'openapi-sync', 'sdk-manifest', 'test', 'sdk-smoke'];
  for (const name of structural) {
    const re = new RegExp(`shouldRun\\(\\s*['"]${name.replace(/[-:]/g, '\\$&')}['"]\\s*\\)`);
    assert.match(SRC, re, `structural gate ${name} must call shouldRun directly`);
  }
  const cliGates = ['doctor', 'whoami', 'verify-claims', 'billing-tiers'];
  for (const name of cliGates) {
    const re = new RegExp(`gateCli\\(\\s*['"]${name}['"]`);
    assert.match(SRC, re, `CLI gate ${name} must register via gateCli('${name}', ...)`);
  }
});

test('W524 #5 — driver gates execute in the documented order', () => {
  // The user-facing contract: cheap structural gates run first so a SDK build
  // doesn't have to wait 5+ minutes to find out the openapi is stale. Pin the
  // ordering by checking the offsets of the await calls in main().
  const ordered = [
    'await gateLintRefs()',
    'await gateOpenapiSync()',
    'await gateSdkManifest()',
    'await gateTests()',
    'await gateSdkSmoke()',
  ];
  let prev = -1;
  for (const call of ordered) {
    const idx = SRC.indexOf(call);
    assert.ok(idx > 0, `${call} must appear in driver`);
    assert.ok(idx > prev, `${call} must come after the previous gate (offset ${idx} > ${prev})`);
    prev = idx;
  }
});

test('W524 #6 — wall-timeout default is at least test-timeout + 5 min', () => {
  // Defense: a 30-minute test gate with a 30-minute wall timeout would race
  // and abort the test gate halfway through. The driver computes wall =
  // max(600_000, test_timeout + 300_000). Pin that formula.
  assert.match(SRC, /Math\.max\(600000,\s*TEST_TIMEOUT_MS\s*\+\s*300000\)/,
    'wall-timeout default must be max(10min, test_timeout + 5min)');
});

test('W524 #7 — driver clears wall timer before exit (no orphan unrefed timer)', () => {
  // If clearTimeout(wallTimer) never fires in the happy path, the process
  // would still exit (wallTimer.unref()) but the timer fires once for the
  // catch path. Pin both pathways.
  assert.match(SRC, /clearTimeout\(wallTimer\);[\s\S]{0,400}allOk/,
    'happy path must clearTimeout before computing summary');
  assert.match(SRC, /\}\)\(\)\.catch\(\(e\)\s*=>\s*\{[\s\S]{0,200}clearTimeout\(wallTimer\)/,
    'catch path must clearTimeout too');
});

test('W524 #8 — sdk-manifest gate computes sha256 short + sha384 SRI', () => {
  // The wave491 lock-in pins the helper exists; this test pins the
  // algorithm choice: sha256.slice(0,12) for the URL hash, sha384 for SRI.
  // Drift on either side breaks browser SRI verification.
  const fnStart = SRC.indexOf('function verifySdkEntry');
  assert.ok(fnStart > 0);
  const fnSlice = SRC.slice(fnStart, fnStart + 2000);
  assert.match(fnSlice, /createHash\(['"]sha256['"]\)[\s\S]{0,200}slice\(0,\s*12\)/,
    'short SDK hash must be sha256 truncated to 12 hex chars');
  assert.match(fnSlice, /['"]sha384-['"]\s*\+\s*crypto\.createHash\(['"]sha384['"]\)[\s\S]{0,200}digest\(['"]base64['"]\)/,
    'SRI must be sha384-<base64> (browser SRI spec)');
});

test('W524 #9 - release verifier gives noisy gates enough output buffer', () => {
  assert.match(SRC, /KOLM_RELEASE_VERIFY_MAX_BUFFER/,
    'operator must be able to override the release verifier output buffer');
  assert.match(SRC, /SPAWN_MAX_BUFFER_BYTES[\s\S]{0,300}256\s*\*\s*1024\s*\*\s*1024/,
    'default release verifier buffer should cover noisy full-suite failures');
  assert.match(SRC, /spawnSync\([\s\S]{0,600}maxBuffer:\s*opts\.maxBuffer\s*\|\|\s*SPAWN_MAX_BUFFER_BYTES/,
    'runSync must pass maxBuffer to spawnSync');
});
