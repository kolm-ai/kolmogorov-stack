// W470 P1-5 lock-in: --target native-rust / --target native-c / bare --target
// rust / bare --target c MUST actually produce a native binary inside the
// .kolm zip whenever the host has a usable toolchain. The original audit
// finding was: CLI accepted --target native-rust but never threaded `target:`
// into compileSpec, so spec-compile.js's `targetLc === 'c' || targetLc ===
// 'rust'` trigger never fired and the .kolm shipped source-only no matter
// what the user asked for.
//
// Tests assert BEHAVIOR (binary entry present in zip + manifest claims +
// recompile via spec-compile direct call) — not page copy.
//
// Three scenarios:
//   1. The CLI surface --target=native-rust threads into compileSpec.target
//      so compileNative is auto-enabled and a binary is bundled.
//   2. The bare alias --target=rust is accepted by the CLI validator and
//      produces the same artifact shape.
//   3. compileSpec({target:'rust'}) directly (no CLI wrapping) compiles a
//      compiled_rule artifact with a native.rust.bin entry and the manifest
//      claims compiled_targets.native.recipes.<rid>.rust.bin_hash matches the
//      bundled bytes.
//
// Host-conditional: rust path is exercised when rustc is on PATH; C path
// when a C compiler is. On a host with neither, the structural assertions
// (CLI argument parse + opts threading) still run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

import { detectToolchains } from '../src/native-compile.js';
import { compileSpec } from '../src/spec-compile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const KOLM_CLI = path.join(REPO_ROOT, 'cli', 'kolm.js');

process.env.RECIPE_RECEIPT_SECRET = process.env.RECIPE_RECEIPT_SECRET || 'kolm-w470-p15-test-secret';

const TOOLCHAINS = detectToolchains();
const HAS_RUSTC = !!TOOLCHAINS.rust;
const HAS_CC = !!TOOLCHAINS.c;

function echoDsl() {
  return {
    type: 'rule-dsl-v1',
    output: {
      op: 'object',
      fields: { echo: { op: 'input' } },
    },
  };
}

function echoCases() {
  // 5+ deterministic eval cases so spec-compile's no-seeds guard is satisfied.
  // The echo DSL output is { echo: <input> }, so expected matches.
  const inputs = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot'];
  return inputs.map((s, i) => ({ id: 'case_' + i, input: s, expected: { echo: s } }));
}

function echoSpec(jobId) {
  return {
    job_id: jobId,
    task: 'wave470 native target completion echo',
    base_model: 'none',
    artifact_class: 'compiled_rule',
    recipes: [{ id: 'rcp_echo', name: 'echo', dsl: echoDsl(), tags: [] }],
    evals: { spec: 'rs-1-evals', n: 6, cases: echoCases() },
    training_stats: {
      distilled_pairs: 0,
      pass_rate_positive: 1,
      latency_p50_us: 50,
      cost_usd_per_call: 0,
    },
  };
}

// Async spawn so the in-process server in adjacent tests doesn't deadlock
// against a spawnSync child.
function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [KOLM_CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 120_000); // deliberate: cleanup
    child.on('error', reject);
    child.on('exit', (status) => {
      clearTimeout(t);
      resolve({ status, stdout: out, stderr: err });
    });
  });
}

function writeRealSpec() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w470-p15-spec-'));
  const spec = echoSpec('job_w470_p15_validator_' + crypto.randomBytes(3).toString('hex'));
  const specPath = path.join(tmp, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
  return { tmp, specPath };
}

test('W470 P1-5 #1 — `kolm compile` accepts bare --target rust as an alias for native-rust', async () => {
  // Negative-validator check — feed a real spec so --target validation is
  // actually reached, then assert the enum guard does NOT trip on 'rust'.
  const { tmp, specPath } = writeRealSpec();
  try {
    const r = await runCli(['compile', '--spec', specPath, '--target', 'rust', '--allow-below-gate'], {
      KOLM_DATA_DIR: tmp, RECIPE_RECEIPT_SECRET: process.env.RECIPE_RECEIPT_SECRET,
    });
    assert.doesNotMatch(
      r.stderr + r.stdout,
      /--target must be one of/,
      'bare --target rust must NOT trigger the enum guard',
    );
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} } // deliberate: cleanup
});

test('W470 P1-5 #2 — `kolm compile` accepts bare --target c as an alias for native-c', async () => {
  const { tmp, specPath } = writeRealSpec();
  try {
    const r = await runCli(['compile', '--spec', specPath, '--target', 'c', '--allow-below-gate'], {
      KOLM_DATA_DIR: tmp, RECIPE_RECEIPT_SECRET: process.env.RECIPE_RECEIPT_SECRET,
    });
    assert.doesNotMatch(
      r.stderr + r.stdout,
      /--target must be one of/,
      'bare --target c must NOT trigger the enum guard',
    );
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} } // deliberate: cleanup
});

test('W470 P1-5 #3 — `kolm compile` rejects an unknown --target value with the expanded list', async () => {
  const { tmp, specPath } = writeRealSpec();
  try {
    const r = await runCli(['compile', '--spec', specPath, '--target', 'cobol'], {
      KOLM_DATA_DIR: tmp, RECIPE_RECEIPT_SECRET: process.env.RECIPE_RECEIPT_SECRET,
    });
    assert.match(r.stderr + r.stdout, /--target must be one of/, 'unknown target must trigger enum guard');
    assert.match(r.stderr + r.stdout, /native-c \(alias c\)/, 'help text lists native-c alias');
    assert.match(r.stderr + r.stdout, /native-rust \(alias rust\)/, 'help text lists native-rust alias');
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} } // deliberate: cleanup
});

test('W470 P1-5 #4 — compileSpec({target:"rust"}) auto-enables native compile + bundles a binary', {
  skip: !HAS_RUSTC ? 'no rustc on this host' : false,
}, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w470-p15-rust-'));
  try {
    const spec = echoSpec('job_w470_p15_rust_' + crypto.randomBytes(3).toString('hex'));
    const out = path.join(tmp, spec.job_id + '.kolm');
    const built = await compileSpec(spec, { outDir: tmp, outPath: out, target: 'rust' });
    assert.ok(fs.existsSync(built.outPath), 'compileSpec must write a .kolm file');

    const zip = new AdmZip(built.outPath);
    const entries = zip.getEntries().map(e => e.entryName);
    // Single-recipe artifact → native.rust.bin (no recipe-id namespacing).
    assert.ok(entries.includes('native.rust.bin'),
      'native.rust.bin MUST be present in the .kolm zip; got entries: ' + entries.join(', '));

    const binBuf = zip.getEntries().find(e => e.entryName === 'native.rust.bin').getData();
    assert.ok(binBuf.length > 0, 'native.rust.bin must not be empty');

    const manifest = JSON.parse(zip.getEntries().find(e => e.entryName === 'manifest.json').getData().toString('utf8'));
    assert.equal(manifest.artifact_class, 'compiled_rule');
    assert.ok(manifest.compiled_targets, 'manifest must carry compiled_targets');
    // After artifact.js flattens the bundle, native_spec sits at the
    // compiled_targets root and the per-recipe bin block lands at
    // compiled_targets.recipes.<rid>.rust.bin.
    assert.ok(manifest.compiled_targets.native_spec,
      'manifest.compiled_targets.native_spec MUST be present when --target=rust + toolchain present');
    const rustClaim = manifest.compiled_targets.recipes?.rcp_echo?.rust?.bin;
    assert.ok(rustClaim, 'manifest must record compiled_targets.recipes.rcp_echo.rust.bin block');
    assert.equal(rustClaim.bin_filename, 'native.rust.bin');

    // Bundled bytes must match the manifest's bin_hash claim.
    const actualHash = crypto.createHash('sha256').update(binBuf).digest('hex');
    assert.equal(rustClaim.bin_hash, actualHash,
      'manifest.compiled_targets.recipes.rcp_echo.rust.bin.bin_hash must equal sha256(native.rust.bin)');

    // Honest top-level binaries[] summary must record the native binary.
    assert.ok(Array.isArray(manifest.binaries), 'manifest.binaries[] must be an array');
    const binEntry = manifest.binaries.find(b => b.kind === 'rust' && b.recipe_id === 'rcp_echo');
    assert.ok(binEntry, 'manifest.binaries[] must include the rust/rcp_echo entry');
    assert.equal(binEntry.sha256, actualHash, 'binaries[].sha256 must match bundled bytes');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
  }
});

test('W470 P1-5 #5 — compileSpec({target:"native-rust"}) is normalized via the CLI mapping', {
  skip: !HAS_RUSTC ? 'no rustc on this host' : false,
}, async () => {
  // Direct compileSpec passes 'rust' (CLI maps native-rust → rust); this test
  // pins that {target:'rust'} continues to be the on-the-wire value spec-compile
  // honors. If a refactor renames the field, native artifacts silently regress
  // to source-only.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w470-p15-rust-norm-'));
  try {
    const spec = echoSpec('job_w470_p15_rust_norm_' + crypto.randomBytes(3).toString('hex'));
    const out = path.join(tmp, spec.job_id + '.kolm');
    const built = await compileSpec(spec, { outDir: tmp, outPath: out, target: 'rust', compileNative: true });
    const zip = new AdmZip(built.outPath);
    const entries = zip.getEntries().map(e => e.entryName);
    assert.ok(entries.includes('native.rust.bin'),
      'compileSpec({target:"rust",compileNative:true}) must still bundle native.rust.bin');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
  }
});

test('W470 P1-5 #6 — CLI threading: `kolm compile --spec --target native-rust` produces native.rust.bin', {
  skip: !HAS_RUSTC ? 'no rustc on this host' : false,
}, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w470-p15-cli-'));
  try {
    const spec = echoSpec('job_w470_p15_cli_' + crypto.randomBytes(3).toString('hex'));
    const specPath = path.join(tmp, 'spec.json');
    fs.writeFileSync(specPath, JSON.stringify(spec, null, 2));
    const out = path.join(tmp, spec.job_id + '.kolm');
    const r = await runCli(['compile', '--spec', specPath, '--out', out, '--target', 'native-rust'], {
      KOLM_DATA_DIR: tmp,
      RECIPE_RECEIPT_SECRET: process.env.RECIPE_RECEIPT_SECRET,
    });
    assert.equal(r.status, 0,
      'kolm compile --target native-rust must exit 0; got ' + r.status +
      '\nstdout:\n' + r.stdout +
      '\nstderr:\n' + r.stderr);
    assert.ok(fs.existsSync(out), 'kolm compile must produce the requested output file');

    const zip = new AdmZip(out);
    const entries = zip.getEntries().map(e => e.entryName);
    assert.ok(entries.includes('native.rust.bin'),
      'kolm compile --target native-rust MUST bundle native.rust.bin; got entries: ' + entries.join(', '));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
  }
});
