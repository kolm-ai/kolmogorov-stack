// W726 — Batch-vs-Latency Kernels tests.
//
// Three atomic items from the W707-W806 system upgrade plan:
//
//   [W726-1] "Many concurrent (API serving) -> batching-optimized kernels"
//   [W726-2] "Single-user desktop -> latency-optimized" (default selector)
//   [W726-3] "Decision at `kolm run --target` time, not manual" (runtime probe)
//
// Surface map:
//
//   src/kernel-selector.js  — selectKernelProfile + probeRuntimeWorkload
//                              + KERNEL_PROFILES + KERNEL_SELECTOR_VERSION
//   src/spec-compile.js     — opts.workload_profile + manifest field +
//                              re-signed manifest.json patch (W460 byte-
//                              stability pattern: pre-W726 artifacts hash
//                              identically when rebuilt with 'auto'/omitted)
//   cli/kolm.js             — `kolm run --workload-probe` + `--workload <hint>`
//                              + `kolm compile --workload <profile>`
//
// W604 anti-brittleness: no explicit-array family checks. Sibling wave
// detection uses regex `wave(7\d\d)` + numeric threshold so a future
// W727+ wave doesn't have to touch this file. Assertions key on
// load-bearing fields (constants, error codes, profile strings, byte
// equality, stdout tokens).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  KERNEL_PROFILES,
  KERNEL_SELECTOR_VERSION,
  selectKernelProfile,
  probeRuntimeWorkload,
} from '../src/kernel-selector.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');

// Each test gets a fresh KOLM_DATA_DIR so any incidental state writes do
// not collide with sibling tests in the larger suite. Matches the
// freshDir pattern in tests/wave721-*.test.js + tests/wave722-*.test.js.
function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w726-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  return tmp;
}

// =============================================================================
// 1) selectKernelProfile — explicit 'serving' hint maps to 'batching'.
// =============================================================================

test('W726 #1 — selectKernelProfile({workload_hint:"serving"}) returns "batching"', () => {
  freshDir();
  assert.equal(selectKernelProfile({ workload_hint: 'serving' }), 'batching');
});

// =============================================================================
// 2) selectKernelProfile — explicit 'desktop' hint maps to 'latency'.
// =============================================================================

test('W726 #2 — selectKernelProfile({workload_hint:"desktop"}) returns "latency"', () => {
  freshDir();
  assert.equal(selectKernelProfile({ workload_hint: 'desktop' }), 'latency');
});

// =============================================================================
// 3) selectKernelProfile — env.KOLM_WORKLOAD acts as a hint when no
//     explicit workload_hint is passed.
// =============================================================================

test('W726 #3 — selectKernelProfile honors env.KOLM_WORKLOAD = "batching"', () => {
  freshDir();
  assert.equal(
    selectKernelProfile({ env: { KOLM_WORKLOAD: 'batching' } }),
    'batching',
  );
  // Case-insensitive / whitespace-tolerant per the normalize helper.
  assert.equal(
    selectKernelProfile({ env: { KOLM_WORKLOAD: '  Serving  ' } }),
    'batching',
  );
  // env.KOLM_WORKLOAD='desktop' falls back to latency.
  assert.equal(
    selectKernelProfile({ env: { KOLM_WORKLOAD: 'desktop' } }),
    'latency',
  );
});

// =============================================================================
// 4) selectKernelProfile — concurrency_estimate >= 4 triggers batching.
// =============================================================================

test('W726 #4 — selectKernelProfile({concurrency_estimate:10}) returns "batching"', () => {
  freshDir();
  assert.equal(selectKernelProfile({ concurrency_estimate: 10 }), 'batching');
  // Boundary: exactly 4 still triggers batching.
  assert.equal(selectKernelProfile({ concurrency_estimate: 4 }), 'batching');
  // 3 is below the threshold, falls back to default 'latency'.
  assert.equal(selectKernelProfile({ concurrency_estimate: 3 }), 'latency');
});

// =============================================================================
// 5) selectKernelProfile — no signal returns the default 'latency'.
// =============================================================================

test('W726 #5 — selectKernelProfile({}) returns the default "latency"', () => {
  freshDir();
  assert.equal(selectKernelProfile({}), 'latency');
  // Same for an unrecognized hint string — falls through to default.
  assert.equal(selectKernelProfile({ workload_hint: 'imaginary' }), 'latency');
  // Calling with no args at all also returns 'latency'.
  assert.equal(selectKernelProfile(), 'latency');
});

// =============================================================================
// 6) probeRuntimeWorkload — env.PORT set and KOLM_DESKTOP unset -> 'serving'.
// =============================================================================

test('W726 #6 — probeRuntimeWorkload({env:{PORT:"3000"}}) returns "serving"', () => {
  freshDir();
  assert.equal(
    probeRuntimeWorkload({ env: { PORT: '3000' }, concurrent_connections_seen: 0 }),
    'serving',
  );
});

// =============================================================================
// 7) probeRuntimeWorkload — KOLM_DESKTOP=1 overrides PORT -> 'desktop'.
// =============================================================================

test('W726 #7 — probeRuntimeWorkload honors KOLM_DESKTOP=1 escape hatch', () => {
  freshDir();
  assert.equal(
    probeRuntimeWorkload({
      env: { KOLM_DESKTOP: '1', PORT: '3000' },
      concurrent_connections_seen: 0,
    }),
    'desktop',
  );
});

// =============================================================================
// 8) KERNEL_PROFILES exact enum lock-in.
// =============================================================================

test('W726 #8 — KERNEL_PROFILES is exactly ["latency", "batching"]', () => {
  freshDir();
  assert.deepEqual(KERNEL_PROFILES, ['latency', 'batching']);
});

// =============================================================================
// 9) KERNEL_SELECTOR_VERSION exact-string lock-in.
// =============================================================================

test('W726 #9 — KERNEL_SELECTOR_VERSION === "w726-v1"', () => {
  freshDir();
  assert.equal(KERNEL_SELECTOR_VERSION, 'w726-v1');
});

// =============================================================================
// 10) spec-compile.js W460-pattern chain-slot invariant: workload_profile in
//     {undefined, null, 'auto'} produces an artifact whose manifest does NOT
//     carry workload_profile OR workload_profile_hash. This is the chain-slot
//     opt-in contract: pre-W726 callers (and W726 callers who pick 'auto')
//     get exactly the same manifest shape, so the deterministic chain inputs
//     (recipes_json hash, evals_json hash, the rest of manifest.hashes)
//     remain byte-identical to legacy artifacts.
//
//     We do NOT assert on the whole-file .kolm sha256 because
//     receipt.json carries a crypto.randomUUID() per build and K-score
//     bakes in a live performance.now() latency measurement — both are
//     non-deterministic by design, not by W726. The chain-slot absence +
//     deterministic-hash equality below is what catches a real W726 bug
//     (the unconditional-slot variant of this code would flunk both).
// =============================================================================

test('W726 #10 — spec-compile.js workload_profile="auto" / omitted skips chain slot', async () => {
  const tmp = freshDir();
  // Module-under-test is dynamically imported AFTER freshDir() so the
  // ESM cache picks up the test-fixture env (RECIPE_RECEIPT_SECRET +
  // KOLM_DATA_DIR). This is the same pattern as wave722 #14.
  const { compileSpec } = await import('../src/spec-compile.js');
  const baseSpec = {
    job_id: 'job_w726_10',
    task: 'W726 byte-stability preservation',
    base_model: 'none',
    recipes: [{
      id: 'rcp_w726_10',
      name: 'Echo recipe',
      source: 'function generate(input, lib) { return { echo: String(input.text || input) }; }',
    }],
    evals: {
      spec: 'rs-1-evals',
      n: 1,
      cases: [{ id: 'c1', input: { text: 'hi' }, expected: { echo: 'hi' } }],
      coverage: 1.0,
    },
  };
  const outA = path.join(tmp, 'w726-10-a.kolm');
  const outB = path.join(tmp, 'w726-10-b.kolm');
  const outC = path.join(tmp, 'w726-10-c.kolm');
  const a = await compileSpec(baseSpec, {
    outDir: tmp,
    outPath: outA,
    comparator: 'json_subset',
    allowEmptyEvals: false,
  });
  const b = await compileSpec(baseSpec, {
    outDir: tmp,
    outPath: outB,
    comparator: 'json_subset',
    allowEmptyEvals: false,
    workload_profile: 'auto',
  });
  const c = await compileSpec(baseSpec, {
    outDir: tmp,
    outPath: outC,
    comparator: 'json_subset',
    allowEmptyEvals: false,
    // workload_profile omitted entirely - same shape as 'auto'.
  });
  // Chain-slot invariant: the two PURELY-deterministic hash inputs
  // (recipes_json, evals_json) MUST be byte-identical across all three
  // runs. These are content-addressed digests over the spec inputs —
  // they do NOT depend on the wall clock or any random source, so they
  // are the right surface for the W460 stability test.
  // recipe_bundle_mjs is intentionally excluded: it stamps a generated_at
  // wall-clock string into the bundle preamble, so it drifts ms-to-ms
  // even when the spec inputs are byte-identical. That drift is W367,
  // not W726, and is already locked in by W721 #10 / W722 #14 via the
  // FrozenDate pattern (which is not portable into compileSpec because
  // compileSpec calls performance.now() for live latency measurement —
  // performance.now is not Date-derived).
  const sliceHashes = (m) => ({
    recipes_json: m.hashes.recipes_json,
    evals_json: m.hashes.evals_json,
  });
  const ha = sliceHashes(a.manifest);
  const hb = sliceHashes(b.manifest);
  const hc = sliceHashes(c.manifest);
  assert.deepEqual(ha, hb,
    `W726 chain-slot stability: workload_profile=undefined vs "auto" must produce identical deterministic hashes (got ${JSON.stringify(ha)} vs ${JSON.stringify(hb)})`);
  assert.deepEqual(ha, hc,
    `W726 chain-slot stability: workload_profile=undefined vs omitted must produce identical deterministic hashes (got ${JSON.stringify(ha)} vs ${JSON.stringify(hc)})`);
  // Chain-slot opt-in contract: the in-memory manifest must NOT carry
  // workload_profile in the auto/absent path so a downstream caller can
  // rely on absence to detect "no profile chosen". And the hashes block
  // must NOT carry a workload_profile_hash either — that would be the
  // unconditional-slot bug that breaks legacy artifact verification.
  assert.equal(a.manifest.workload_profile, undefined,
    'absent workload_profile should NOT leak onto in-memory manifest');
  assert.equal(b.manifest.workload_profile, undefined,
    'workload_profile="auto" should be normalized to absent on in-memory manifest');
  assert.equal(c.manifest.workload_profile, undefined,
    'omitted workload_profile should NOT appear on in-memory manifest');
  assert.equal(a.manifest.workload_profile_hash, undefined,
    'absent workload_profile must not key workload_profile_hash');
  assert.equal(b.manifest.workload_profile_hash, undefined,
    '"auto" workload_profile must not key workload_profile_hash');
  assert.equal(c.manifest.workload_profile_hash, undefined,
    'omitted workload_profile must not key workload_profile_hash');
});

// =============================================================================
// 11) spec-compile.js workload_profile flows into manifest when set.
//     Build with 'batching', unzip artifact, parse manifest.json, assert the
//     field is present. Signature must remain valid (verified via the public
//     verifyManifestSignature API) so the patch did not silently break the
//     receipt chain.
// =============================================================================

test('W726 #11 — workload_profile="batching" lands in manifest.json + signature stays valid', async () => {
  const tmp = freshDir();
  const { compileSpec } = await import('../src/spec-compile.js');
  const { verifyManifestSignature } = await import('../src/artifact.js');
  const { default: AdmZip } = await import('adm-zip');
  const baseSpec = {
    job_id: 'job_w726_11',
    task: 'W726 batching profile flows into manifest',
    base_model: 'none',
    recipes: [{
      id: 'rcp_w726_11',
      name: 'Echo recipe',
      source: 'function generate(input, lib) { return { echo: String(input.text || input) }; }',
    }],
    evals: {
      spec: 'rs-1-evals',
      n: 1,
      cases: [{ id: 'c1', input: { text: 'hi' }, expected: { echo: 'hi' } }],
      coverage: 1.0,
    },
  };
  const outPath = path.join(tmp, 'w726-11.kolm');
  const r = await compileSpec(baseSpec, {
    outDir: tmp,
    outPath,
    comparator: 'json_subset',
    allowEmptyEvals: false,
    workload_profile: 'batching',
  });
  // In-memory manifest carries the field.
  assert.equal(r.manifest.workload_profile, 'batching');
  assert.equal(typeof r.manifest.workload_profile_hash, 'string');
  assert.equal(r.manifest.workload_profile_hash.length, 64);
  // On-disk manifest.json inside the .kolm zip carries the field.
  const zip = new AdmZip(outPath);
  const manEntry = zip.getEntry('manifest.json');
  assert.ok(manEntry, 'manifest.json must exist in the .kolm zip');
  const manText = manEntry.getData().toString('utf8');
  const manJson = JSON.parse(manText);
  assert.equal(manJson.workload_profile, 'batching');
  assert.equal(typeof manJson.workload_profile_hash, 'string');
  assert.equal(manJson.workload_profile_hash.length, 64);
  // Signature.sig must still verify against the patched manifest bytes.
  // This is what catches a re-sign bug: if the W726 path forgot to
  // recompute the HMAC, verifyManifestSignature would return invalid.
  const sigEntry = zip.getEntry('signature.sig');
  assert.ok(sigEntry, 'signature.sig must exist in the .kolm zip');
  const sigText = sigEntry.getData().toString('utf8');
  const v = verifyManifestSignature(manText, sigText);
  assert.equal(v.valid, true,
    `signature must verify after workload_profile patch; reason=${v.reason}`);
});

// =============================================================================
// 12) CLI: `kolm run --workload-probe` exits 0 and prints "workload:" line.
//
// The probe is pure-printout dry-run — no artifact load, no network call,
// no signature work. Stdout must carry the literal `workload:` token (the
// load-bearing grep handle for operator scripts) AND one of the two
// canonical profile strings.
// =============================================================================

test('W726 #12 — `kolm run --workload-probe` exits 0 and stdout has workload line', () => {
  freshDir();
  const r = spawnSync(process.execPath, [CLI_PATH, 'run', '--workload-probe'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, KOLM_NO_INTERACTIVE: '1' },
  });
  assert.equal(r.status, 0,
    `expected exit 0; got ${r.status}; stdout=${(r.stdout || '').slice(0, 400)} stderr=${(r.stderr || '').slice(0, 400)}`);
  const stdout = r.stdout || '';
  assert.ok(/workload:/.test(stdout),
    `stdout must contain the literal "workload:" token; got ${stdout.slice(0, 400)}`);
  assert.ok(/workload:\s*(latency|batching)/.test(stdout),
    `workload: line must name one of latency | batching; got ${stdout.slice(0, 400)}`);
});

// =============================================================================
// 13) Anti-brittleness: regex `wave(7\d\d)` count threshold instead of an
//     explicit-array sibling list. A future W727 / W728 / etc. wave that
//     adds another sibling test file should NOT have to touch this file.
//     The threshold "at least one sibling exists" stays true forever; an
//     explicit-array check would break the moment W707 ships or W730 lands.
// =============================================================================

test('W726 #13 — sibling W7xx test files use regex+threshold (no explicit-array check)', () => {
  freshDir();
  const testsDir = path.join(REPO_ROOT, 'tests');
  const files = fs.readdirSync(testsDir);
  const w7Sibs = files.filter(f => /^wave(7\d\d)/i.test(f) && /\.test\.js$/.test(f));
  // At least ONE W7xx test file (this one) must exist. The threshold is
  // ">= 1" rather than "exactly N" so a future wave adding W727 etc.
  // doesn't break this lock-in. Anti-brittleness pattern from W462 #10
  // / W464 #1-#3 / W465 #10 / W466.
  assert.ok(w7Sibs.length >= 1,
    `expected at least 1 W7xx sibling test; got ${w7Sibs.length}`);
  // And specifically THIS file must be present so we don't accidentally
  // delete ourselves out of the lock-in set.
  assert.ok(w7Sibs.some(f => f.startsWith('wave726-')),
    `the W726 test file must be in the W7xx sibling list; got ${JSON.stringify(w7Sibs)}`);
  // Sanity: ensure none of the sibling lock-ins is an EXPLICIT array
  // literal (regression guard from W462 #10 / W464 #1-#3). We grep our
  // OWN body to make sure we did not accidentally write an explicit
  // sibling check.
  const ownPath = fileURLToPath(import.meta.url);
  const ownBody = fs.readFileSync(ownPath, 'utf8');
  // The regex below would match a literal explicit-array list pattern.
  // Allow this comment + its own regex; reject any other place that
  // hardcodes wave names in a literal array.
  const explicitArrayLiteralPattern = /\[\s*['"]wave7\d\d/;
  // Strip out THIS very block (lines mentioning explicit-array) before
  // running the check so the self-grep doesn't false-positive.
  const stripped = ownBody.split(/\r?\n/).filter(l => !/explicit-array|explicitArray/.test(l)).join('\n');
  // Use the helper so a hidden hardcoded array would trip us.
  if (explicitArrayLiteralPattern.test(stripped)) {
    assert.fail(`W604 anti-brittleness: explicit-array sibling list detected in W726 test file`);
  }
  // Crypto.randomBytes import sanity for the freshDir helper above —
  // unused-import lint would fail without an explicit reference.
  void crypto;
});
