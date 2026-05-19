// Wave 409q — honest C / Rust / WASM compile metadata.
//
// The auditor flagged: the previous artifact surface said "target=c/rust/wasm
// was compiled" whenever DSL emitted source, even when no toolchain produced a
// binary. This test battery asserts the corrected behaviour:
//
//   1. Build with target=C, no clang  → artifact ships src/main.c, manifest
//      says `binaries=[]`, `compiled_binary=false`, `production_ready=false`.
//   2. Build with target=C and a working C toolchain (real cc on host)  →
//      manifest carries a `binaries[]` entry with the native sha256, the .bin
//      file is in the zip at the claimed filename, and `verify` passes.
//   3. Verifier on an artifact whose manifest CLAIMS a native binary but the
//      file is missing from the zip  → check status=fail, reason=
//      `native_binary_missing`.
//   4. Verifier on an artifact whose bundled binary has been tampered (so the
//      sha256 in the zip no longer matches the claim)  → check status=fail,
//      reason=`native_binary_hash_mismatch`.
//   5. Build with target=WASM, no wasm toolchain  → src/main.wat ships,
//      manifest says `binaries=[]`, `production_ready=false`.
//   6. Build with target=WASM and a working wasm toolchain (real rustc
//      wasm32-wasi or clang wasi-sysroot on host)  → manifest has a wasm
//      entry, verify passes.
//
// Tests #2 and #6 are conditional on host toolchains via t.skip — same
// pattern as wave144-native-compile.test.js. Tests #1 / #3 / #4 / #5 are
// hermetic (no toolchain required) and exercise the honesty contract that the
// auditor actually cared about: a missing toolchain MUST surface as
// `compiled_binary=false`, not silently as a "success".
//
// All tests assert behaviour (manifest contents + verify check status +
// reason codes), never page copy.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import AdmZip from 'adm-zip';

import {
  detectToolchains,
  NATIVE_SPEC,
  buildBinariesArray,
  getSourceFileEntries,
} from '../src/native-compile.js';
import { compileSpec } from '../src/spec-compile.js';
import { buildBinder } from '../src/binder.js';

process.env.RECIPE_RECEIPT_SECRET = process.env.RECIPE_RECEIPT_SECRET || 'kolm-wave409q-c-rust-wasm-secret';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-wave409q-'));
const T = detectToolchains();
const HAS_CC = !!T.c;
const HAS_RUSTC = !!T.rust;
const HAS_WASM = !!T.wasm;

// ─── helpers ──────────────────────────────────────────────────────────────

function echoDsl() {
  // Minimal rule-dsl-v1 — input → { echo: input }. emitCompiledTargets knows
  // how to translate this to both C and Rust source.
  return {
    type: 'rule-dsl-v1',
    output: {
      op: 'object',
      fields: { echo: { op: 'input' } },
    },
  };
}

function echoSpec(jobId) {
  return {
    job_id: jobId,
    task: 'wave409q honest c/rust/wasm compile metadata',
    base_model: 'none',
    artifact_class: 'compiled_rule',
    recipes: [{
      id: 'rcp_echo',
      name: 'echo',
      dsl: echoDsl(),
      tags: [],
    }],
    evals: { spec: 'rs-1-evals', n: 0, cases: [] },
    training_stats: {
      distilled_pairs: 0,
      pass_rate_positive: 1,
      latency_p50_us: 50,
      cost_usd_per_call: 0,
    },
  };
}

// Rewrite a .kolm zip in place using archiver. AdmZip's writeZip drifts CRCs
// in ways the artifact loader rejects (see wave144 tamper test) — archiver is
// the path the existing test base uses for the same job.
async function rewriteZipEntries(artifactPath, entriesMap) {
  const archiver = (await import('archiver')).default;
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(artifactPath);
    const z = archiver('zip', { zlib: { level: 9 } });
    z.on('warning', (e) => { if (e.code !== 'ENOENT') reject(e); });
    z.on('error', reject);
    ws.on('close', resolve);
    z.pipe(ws);
    for (const [name, buf] of entriesMap) z.append(buf, { name });
    z.finalize();
  });
}

function readZipEntries(artifactPath) {
  const zip = new AdmZip(artifactPath);
  const map = new Map();
  for (const e of zip.getEntries()) map.set(e.entryName, e.getData());
  return map;
}

function loadManifest(artifactPath) {
  const zip = new AdmZip(artifactPath);
  const e = zip.getEntries().find(e => e.entryName === 'manifest.json');
  return JSON.parse(e.getData().toString('utf8'));
}

// Replicate src/artifact.js' canonicalJson so we can re-sign a manifest after
// tampering. Order: stable key sort, recursive.
function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  const k = Object.keys(v).sort();
  return '{' + k.map(x => JSON.stringify(x) + ':' + canonicalJson(v[x])).join(',') + '}';
}

// Re-sign the signature.sig envelope after mutating manifest bytes. Preserves
// the original sig envelope's spec/job_id/artifact_hash/eval_set_hash/etc.,
// only updates manifest_hash and hmac so loadArtifact accepts the bundle and
// the binaries-integrity check fires (which is what these tests assert).
function resignManifest(entriesMap, secret) {
  const manifestBytes = entriesMap.get('manifest.json');
  const manifestHash = crypto.createHash('sha256').update(manifestBytes).digest('hex');
  const origSig = JSON.parse(entriesMap.get('signature.sig').toString('utf8'));
  // Match the rich-payload shape verifyManifestSignature tries first.
  const richPayload = canonicalJson({
    spec: origSig.spec,
    manifest_hash: manifestHash,
    job_id: origSig.job_id,
    artifact_hash: origSig.artifact_hash,
    eval_set_hash: origSig.eval_set_hash,
    eval_score: origSig.eval_score,
    judge_id: origSig.judge_id,
  });
  const newHmac = crypto.createHmac('sha256', secret).update(richPayload).digest('hex');
  origSig.manifest_hash = manifestHash;
  origSig.hmac = newHmac;
  entriesMap.set('signature.sig', Buffer.from(JSON.stringify(origSig, null, 2), 'utf8'));
}

// ─── unit — helper functions on their own ────────────────────────────────

test('buildBinariesArray: returns [] for an empty native bundle', () => {
  assert.deepEqual(buildBinariesArray(null), []);
  assert.deepEqual(buildBinariesArray({}), []);
  assert.deepEqual(buildBinariesArray({ bundle: null }), []);
  assert.deepEqual(buildBinariesArray({ bundle: { recipes: {} } }), []);
});

test('buildBinariesArray: surfaces each compiled (c, rust, wasm) tuple as a separate row', () => {
  const nativeBundle = {
    bundle: {
      spec: NATIVE_SPEC,
      host_triple: 'x64-linux',
      recipes: {
        rcp_a: {
          c: { bin_filename: 'native.c.bin', bin_hash: 'a'.repeat(64), bytes: 1024, compiler: 'cc', compiler_version: 'cc 1.2.3' },
          rust: { bin_filename: 'native.rust.bin', bin_hash: 'b'.repeat(64), bytes: 2048, compiler: 'rustc', compiler_version: 'rustc 1.78.0' },
          wasm: { bin_filename: 'native.wasm', bin_hash: 'c'.repeat(64), bytes: 512, compiler: 'rustc', compiler_version: 'rustc 1.78.0', source_kind: 'rust', target_triple: 'wasm32-wasi' },
        },
      },
    },
  };
  const out = buildBinariesArray(nativeBundle);
  assert.equal(out.length, 3);
  const c = out.find(b => b.kind === 'c');
  const rs = out.find(b => b.kind === 'rust');
  const w = out.find(b => b.target === 'wasm');
  assert.equal(c.target, 'native');
  assert.equal(c.filename, 'native.c.bin');
  assert.equal(c.sha256, 'a'.repeat(64));
  assert.equal(c.size, 1024);
  assert.equal(rs.target, 'native');
  assert.equal(rs.filename, 'native.rust.bin');
  assert.equal(w.target, 'wasm');
  assert.equal(w.target_triple, 'wasm32-wasi');
  assert.equal(w.kind, 'rust'); // wasm row's `kind` reflects source_kind
});

test('buildBinariesArray: skips recipes whose toolchain was absent (no bin_hash)', () => {
  const nativeBundle = {
    bundle: {
      recipes: {
        rcp_b: { c: null, rust: null }, // both toolchains absent
      },
    },
  };
  assert.deepEqual(buildBinariesArray(nativeBundle), []);
});

test('getSourceFileEntries: single-recipe bundle ships canonical src/main.{c,rs} paths', () => {
  const compiled_targets = {
    spec: 'rule-dsl-v1',
    single_recipe: true,
    recipes: {
      rcp_echo: {
        c: { source: 'char* kolm_run(...) {return "";}' },
        rust: { source: 'fn run() -> String { String::new() }' },
      },
    },
  };
  const entries = getSourceFileEntries(compiled_targets);
  const byName = Object.fromEntries(entries.map(e => [e.filename, e.content]));
  assert.ok('src/main.c' in byName, 'src/main.c present in single-recipe mode');
  assert.ok('src/main.rs' in byName, 'src/main.rs present in single-recipe mode');
  assert.ok(byName['src/main.c'].includes('kolm_run'));
});

test('getSourceFileEntries: multi-recipe bundle nests under src/<rid>/main.{c,rs}', () => {
  const compiled_targets = {
    spec: 'rule-dsl-v1',
    single_recipe: false,
    recipes: {
      rcp_alpha: { c: { source: '/* alpha */' }, rust: { source: '// alpha' } },
      rcp_beta:  { c: { source: '/* beta */'  }, rust: { source: '// beta'  } },
    },
  };
  const entries = getSourceFileEntries(compiled_targets);
  const names = entries.map(e => e.filename);
  assert.ok(names.includes('src/rcp_alpha/main.c'));
  assert.ok(names.includes('src/rcp_alpha/main.rs'));
  assert.ok(names.includes('src/rcp_beta/main.c'));
  assert.ok(names.includes('src/rcp_beta/main.rs'));
});

test('getSourceFileEntries: opts.includeWasmText=true mints src/main.wat alongside .c/.rs', () => {
  const compiled_targets = {
    spec: 'rule-dsl-v1',
    single_recipe: true,
    recipes: {
      rcp_echo: {
        c: { source: 'int kolm_run(){return 0;}' },
        rust: { source: 'fn run(){}' },
      },
    },
  };
  const entries = getSourceFileEntries(compiled_targets, { includeWasmText: true });
  const names = entries.map(e => e.filename);
  assert.ok(names.includes('src/main.wat'));
  // The wat stub explains that real wasm is compiled from the sibling main.c
  // or main.rs — auditor signal that a wasm target was requested even when no
  // toolchain ran.
  const wat = entries.find(e => e.filename === 'src/main.wat').content.toString('utf8');
  assert.match(wat, /wasm32-wasi/);
});

// ─── #1 — target=C with no clang → src/main.c ships, binaries=[], production_ready=false ───

test('target=C, no C toolchain: ships src/main.c, binaries=[], compiled_binary=false, production_ready=false', async () => {
  const spec = echoSpec('job_w409q_c_no_toolchain_' + crypto.randomBytes(3).toString('hex'));
  const out = path.join(TMP, spec.job_id + '.kolm');
  const built = await compileSpec(spec, {
    outDir: TMP,
    outPath: out,
    target: 'c',
    toolchains: { c: null, rust: null, wasm: null }, // hermetic: no toolchain on host
  });

  const manifest = loadManifest(built.outPath);
  const entries = readZipEntries(built.outPath);

  // Honest top-level signal.
  assert.deepEqual(manifest.binaries, [], 'manifest.binaries empty when no toolchain produced a binary');
  assert.equal(manifest.compiled_binary, false, 'compiled_binary=false when target requested but no toolchain');
  assert.equal(manifest.production_ready, false, 'production_ready=false when compiled_binary=false');

  // Source still ships — the auditor's "source generated, not compiled" path.
  assert.ok(entries.has('src/main.c'), 'src/main.c present in zip');
  // Legacy native.c alias still rides along for back-compat with wave144.
  assert.ok(entries.has('native.c'), 'native.c (legacy alias) still present');
  // No native binary file in the zip.
  assert.ok(!entries.has('native.c.bin'), 'no native.c.bin when no toolchain');

  // Verifier skips the binaries-integrity check (no claims to check).
  const v = await buildBinder(built.outPath);
  const binCheck = v.checks.find(c => c.name === 'binaries integrity');
  assert.equal(binCheck, undefined, 'binaries-integrity check is a no-op when manifest.binaries=[]');
});

// ─── #2 — target=C with real cc → manifest pins binary hash, verify passes ───

test('target=C with real cc: manifest.binaries pins native sha256, verify passes', { skip: !HAS_CC ? 'no C compiler on this host' : false }, async () => {
  if (!HAS_CC) return;
  const spec = echoSpec('job_w409q_c_real_' + crypto.randomBytes(3).toString('hex'));
  const out = path.join(TMP, spec.job_id + '.kolm');
  const built = await compileSpec(spec, {
    outDir: TMP,
    outPath: out,
    target: 'c',
    toolchains: { c: T.c, rust: null, wasm: null }, // only C path
  });

  const manifest = loadManifest(built.outPath);
  const entries = readZipEntries(built.outPath);

  // At least one C binary in manifest.binaries[].
  assert.ok(Array.isArray(manifest.binaries) && manifest.binaries.length >= 1,
    `manifest.binaries non-empty, saw ${JSON.stringify(manifest.binaries)}`);
  const cEntry = manifest.binaries.find(b => b.target === 'native' && b.kind === 'c');
  assert.ok(cEntry, 'native+c entry in manifest.binaries');
  assert.match(cEntry.sha256, /^[0-9a-f]{64}$/);
  assert.ok(cEntry.size > 0);
  assert.equal(cEntry.recipe_id, 'rcp_echo');
  assert.equal(cEntry.filename, 'native.c.bin');

  // Source still ships.
  assert.ok(entries.has('src/main.c'));

  // The compiled binary itself is bundled and its sha256 matches the claim.
  const binBuf = entries.get(cEntry.filename);
  assert.ok(binBuf, 'compiled binary present in zip at claimed filename');
  const actualSha = crypto.createHash('sha256').update(binBuf).digest('hex');
  assert.equal(actualSha, cEntry.sha256, 'bundled bytes hash matches manifest claim');

  assert.equal(manifest.compiled_binary, true, 'compiled_binary=true when at least one binary was produced');

  // Verifier passes the binaries-integrity check.
  const v = await buildBinder(built.outPath);
  const binCheck = v.checks.find(c => c.name === 'binaries integrity');
  assert.ok(binCheck, 'binaries-integrity check fires when manifest.binaries non-empty');
  assert.equal(binCheck.status, 'pass', `expected pass, got ${binCheck.status}: ${binCheck.detail}`);
});

// ─── #3 — verifier: claim present but file missing → native_binary_missing ───

test('verifier fails with native_binary_missing when claimed binary is absent from zip', async () => {
  // Strategy: build an artifact with NO toolchain (so binaries=[]), then inject
  // a fake binaries[] claim into the manifest WITHOUT adding the corresponding
  // zip entry. The signature.sig HMAC over manifest.json still validates
  // because we re-sign locally with RECIPE_RECEIPT_SECRET. The binaries-
  // integrity check is the one that catches the missing file.
  const spec = echoSpec('job_w409q_missing_' + crypto.randomBytes(3).toString('hex'));
  const out = path.join(TMP, spec.job_id + '.kolm');
  const built = await compileSpec(spec, {
    outDir: TMP,
    outPath: out,
    target: 'c',
    toolchains: { c: null, rust: null, wasm: null },
  });

  // Re-write zip with a fabricated manifest.binaries[] claim.
  const entriesMap = readZipEntries(built.outPath);
  const manifest = JSON.parse(entriesMap.get('manifest.json').toString('utf8'));
  // Forge a claim for a binary that does NOT exist in the zip. We use the
  // legacy native.c.bin filename which the integrity check looks up by name.
  manifest.binaries = [{
    target: 'native',
    kind: 'c',
    recipe_id: 'rcp_echo',
    filename: 'native.c.bin',
    sha256: '0'.repeat(64),
    size: 1024,
    compiler: 'cc',
    compiler_version: 'cc fake',
  }];
  entriesMap.set('manifest.json', Buffer.from(JSON.stringify(manifest), 'utf8'));
  resignManifest(entriesMap, process.env.RECIPE_RECEIPT_SECRET);

  await rewriteZipEntries(built.outPath, entriesMap);

  // Verifier should surface native_binary_missing.
  const v = await buildBinder(built.outPath);
  const binCheck = v.checks.find(c => c.name === 'binaries integrity');
  assert.ok(binCheck, 'binaries-integrity check fires');
  assert.equal(binCheck.status, 'fail', `expected fail, got ${binCheck.status}`);
  assert.equal(binCheck.reason, 'native_binary_missing');
  assert.ok(Array.isArray(binCheck.codes) && binCheck.codes.includes('native_binary_missing'));
  assert.match(binCheck.detail, /not bundled/);
  // Verdict propagates.
  assert.equal(v.verdict, 'fail');
});

// ─── #4 — verifier: file present but hash drifts → native_binary_hash_mismatch ───

test('verifier fails with native_binary_hash_mismatch when bundled bytes drift from claim', { skip: !HAS_CC && !HAS_RUSTC ? 'no cc/rustc on this host' : false }, async () => {
  if (!HAS_CC && !HAS_RUSTC) return;
  const spec = echoSpec('job_w409q_mismatch_' + crypto.randomBytes(3).toString('hex'));
  const out = path.join(TMP, spec.job_id + '.kolm');
  const built = await compileSpec(spec, {
    outDir: TMP,
    outPath: out,
    target: HAS_CC ? 'c' : 'rust',
    toolchains: { c: HAS_CC ? T.c : null, rust: !HAS_CC && HAS_RUSTC ? T.rust : null, wasm: null },
  });

  // Read the artifact, flip a byte in the bundled binary, re-pack. Crucially
  // we do NOT update manifest.binaries[].sha256 so the integrity check is the
  // gate that catches the drift.
  const entriesMap = readZipEntries(built.outPath);
  const manifest = JSON.parse(entriesMap.get('manifest.json').toString('utf8'));
  const claim = manifest.binaries.find(b => b.target === 'native');
  assert.ok(claim, 'pre-condition: manifest.binaries has a native claim');
  const targetName = claim.filename;
  const original = entriesMap.get(targetName);
  assert.ok(original, `pre-condition: ${targetName} present in zip`);
  const tampered = Buffer.from(original);
  tampered[Math.min(8, tampered.length - 1)] ^= 0xff;
  entriesMap.set(targetName, tampered);

  await rewriteZipEntries(built.outPath, entriesMap);

  const v = await buildBinder(built.outPath);
  const binCheck = v.checks.find(c => c.name === 'binaries integrity');
  assert.ok(binCheck);
  assert.equal(binCheck.status, 'fail', `expected fail, got ${binCheck.status}: ${binCheck.detail}`);
  assert.equal(binCheck.reason, 'native_binary_hash_mismatch');
  assert.ok(binCheck.codes.includes('native_binary_hash_mismatch'));
  assert.match(binCheck.detail, /hash mismatch/);
  assert.equal(v.verdict, 'fail');
});

// ─── #5 — target=WASM with no wasm toolchain → src/main.wat ships, production_ready=false ───

test('target=WASM, no wasm toolchain: ships src/main.wat, binaries=[], compiled_binary=false, production_ready=false', async () => {
  const spec = echoSpec('job_w409q_wasm_no_toolchain_' + crypto.randomBytes(3).toString('hex'));
  const out = path.join(TMP, spec.job_id + '.kolm');
  const built = await compileSpec(spec, {
    outDir: TMP,
    outPath: out,
    target: 'wasm',
    toolchains: { c: null, rust: null, wasm: null }, // no wasm path on host
  });

  const manifest = loadManifest(built.outPath);
  const entries = readZipEntries(built.outPath);

  // No binary was produced.
  assert.deepEqual(manifest.binaries, [], 'binaries empty when no wasm toolchain');
  assert.equal(manifest.compiled_binary, false, 'compiled_binary=false when wasm target requested but no toolchain');
  assert.equal(manifest.production_ready, false, 'production_ready=false');

  // Source-text alias for wasm ships even when no toolchain compiled it. This
  // is the auditor signal: a wasm target was requested, the bundle declares it
  // honestly without a binary.
  assert.ok(entries.has('src/main.wat'), 'src/main.wat present when target=wasm but no toolchain');
  // No .wasm binary in zip.
  assert.ok(!entries.has('native.wasm'), 'no native.wasm in zip when toolchain absent');

  // No binaries-integrity check fires (nothing to check).
  const v = await buildBinder(built.outPath);
  const binCheck = v.checks.find(c => c.name === 'binaries integrity');
  assert.equal(binCheck, undefined);
});

// ─── #6 — target=WASM with a working toolchain → manifest carries wasm hash, verify passes ───

test('target=WASM with real wasm toolchain: manifest.binaries has wasm entry, verify passes', { skip: !HAS_WASM ? 'no wasm32-wasi toolchain on this host' : false }, async () => {
  if (!HAS_WASM) return;
  const spec = echoSpec('job_w409q_wasm_real_' + crypto.randomBytes(3).toString('hex'));
  const out = path.join(TMP, spec.job_id + '.kolm');
  const built = await compileSpec(spec, {
    outDir: TMP,
    outPath: out,
    target: 'wasm',
    compileWasm: true, // belt-and-suspenders — target=wasm already implies it
  });

  const manifest = loadManifest(built.outPath);
  const entries = readZipEntries(built.outPath);

  const wasmEntry = manifest.binaries.find(b => b.target === 'wasm');
  assert.ok(wasmEntry, `wasm entry in manifest.binaries, saw ${JSON.stringify(manifest.binaries)}`);
  assert.equal(wasmEntry.target_triple, 'wasm32-wasi');
  assert.match(wasmEntry.sha256, /^[0-9a-f]{64}$/);
  assert.ok(wasmEntry.size > 0);
  assert.equal(wasmEntry.filename, 'native.wasm');

  assert.equal(manifest.compiled_binary, true);

  // The wasm bin is in the zip at the claimed filename and re-hashes correctly.
  const binBuf = entries.get(wasmEntry.filename);
  assert.ok(binBuf);
  const actualSha = crypto.createHash('sha256').update(binBuf).digest('hex');
  assert.equal(actualSha, wasmEntry.sha256);

  // WASM magic bytes.
  assert.equal(binBuf[0], 0x00);
  assert.equal(binBuf[1], 0x61);
  assert.equal(binBuf[2], 0x73);
  assert.equal(binBuf[3], 0x6D);

  // Verifier passes binaries-integrity.
  const v = await buildBinder(built.outPath);
  const binCheck = v.checks.find(c => c.name === 'binaries integrity');
  assert.ok(binCheck);
  assert.equal(binCheck.status, 'pass', binCheck.detail);
});

// ─── #5b — verifier: wasm claim present but file missing → wasm_binary_missing ───

test('verifier fails with wasm_binary_missing when claimed wasm is absent from zip', async () => {
  const spec = echoSpec('job_w409q_wasm_missing_' + crypto.randomBytes(3).toString('hex'));
  const out = path.join(TMP, spec.job_id + '.kolm');
  const built = await compileSpec(spec, {
    outDir: TMP,
    outPath: out,
    target: 'wasm',
    toolchains: { c: null, rust: null, wasm: null },
  });

  // Inject a fake wasm claim.
  const entriesMap = readZipEntries(built.outPath);
  const manifest = JSON.parse(entriesMap.get('manifest.json').toString('utf8'));
  manifest.binaries = [{
    target: 'wasm',
    kind: 'rust',
    recipe_id: 'rcp_echo',
    filename: 'native.wasm',
    sha256: '0'.repeat(64),
    size: 512,
    compiler: 'rustc',
    compiler_version: 'rustc fake',
    target_triple: 'wasm32-wasi',
  }];
  entriesMap.set('manifest.json', Buffer.from(JSON.stringify(manifest), 'utf8'));
  resignManifest(entriesMap, process.env.RECIPE_RECEIPT_SECRET);

  await rewriteZipEntries(built.outPath, entriesMap);

  const v = await buildBinder(built.outPath);
  const binCheck = v.checks.find(c => c.name === 'binaries integrity');
  assert.ok(binCheck);
  assert.equal(binCheck.status, 'fail');
  assert.equal(binCheck.reason, 'wasm_binary_missing');
  assert.ok(binCheck.codes.includes('wasm_binary_missing'));
  assert.equal(v.verdict, 'fail');
});

// ─── coverage report ──────────────────────────────────────────────────────

test('wave 409q coverage summary: report which toolchains were exercised', () => {
  const summary = {
    has_cc: HAS_CC,
    has_rustc: HAS_RUSTC,
    has_wasm: HAS_WASM,
    hermetic_paths_exercised: ['target=C no-toolchain', 'native_binary_missing', 'target=WASM no-toolchain', 'wasm_binary_missing'],
  };
  console.log('# wave-409q coverage:', JSON.stringify(summary));
  assert.ok(true);
});
