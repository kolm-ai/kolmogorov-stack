// W928 - direct contract test for packages/runtime-rs/examples/verify.rs and
// packages/runtime-rs/src/wasm.rs.
//
// These files are browser/CLI proof boundaries. The wasm wrapper must apply
// browser-sized extraction limits and stable error codes; the example verifier
// must demonstrate the same bounded, env-secret flow expected from integrators.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

const ROOT = new URL('..', import.meta.url);
const EXAMPLE_REL = 'packages/runtime-rs/examples/verify.rs';
const WASM_REL = 'packages/runtime-rs/src/wasm.rs';
const LIB_REL = 'packages/runtime-rs/src/lib.rs';
const CARGO_MANIFEST = 'packages/runtime-rs/Cargo.toml';
const VERIFY_SCRIPT =
  'node --test --test-concurrency=1 tests/wave928-runtime-rs-wasm-example-contract.test.js';
const WASM_CONTRACT = 'w928-runtime-rs-wasm-v1';
const EXAMPLE_CONTRACT = 'w928-runtime-rs-example-v1';

function read(rel) {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function run(command, args, timeout = 180000) {
  return spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, CARGO_TARGET_DIR: path.join(os.tmpdir(), 'kolm-runtime-rs-target') },
    encoding: 'utf8',
    timeout,
  });
}

test('W928 runtime-rs wasm/example atoms are wired into direct depth verification', () => {
  const pkg = readJson('package.json');

  assert.equal(pkg.scripts['verify:runtime-rs-wasm-example'], VERIFY_SCRIPT);
  assert.match(
    pkg.scripts['verify:depth'],
    /verify:runtime-rs-build-scripts && npm run verify:runtime-rs-wasm-example && npm run verify:distribution-manifests && node scripts\/audit-sota-readiness\.cjs/,
  );
  assert.equal(EXAMPLE_REL, 'packages/runtime-rs/examples/verify.rs');
  assert.equal(WASM_REL, 'packages/runtime-rs/src/wasm.rs');
});

test('W928 wasm binding enforces browser limits and stable non-leaky errors', () => {
  const wasm = read(WASM_REL);
  const lib = read(LIB_REL);

  assert.match(wasm, new RegExp(WASM_CONTRACT));
  assert.match(wasm, /pub const WASM_MAX_ARTIFACT_BYTES: usize = 64 \* 1024 \* 1024;/);
  assert.match(wasm, /pub const WASM_MAX_ZIP_ENTRIES: usize = 64;/);
  assert.match(wasm, /pub const WASM_MAX_ZIP_ENTRY_BYTES: u64 = 32 \* 1024 \* 1024;/);
  assert.match(wasm, /pub const WASM_MAX_ZIP_TOTAL_BYTES: u64 = 64 \* 1024 \* 1024;/);
  assert.match(wasm, /pub const WASM_MAX_SECRET_BYTES: usize = 4096;/);
  assert.match(wasm, /Artifact::load_from_bytes_with_limits\(bytes, browser_zip_limits\(\)\)/);
  assert.match(wasm, /fn validate_wasm_inputs\(bytes: &\[u8\], secret: &str\)/);
  assert.match(wasm, /return Err\("artifact_too_large"\)/);
  assert.match(wasm, /return Err\("secret_missing"\)/);
  assert.match(wasm, /return Err\("secret_too_large"\)/);
  assert.match(wasm, /fn classify_load_error\(error: &Error\) -> &'static str/);
  assert.match(wasm, /"artifact_resource_limit_exceeded"/);
  assert.match(wasm, /"artifact_duplicate_zip_entry"/);
  assert.match(wasm, /"artifact_unsafe_zip_entry"/);
  assert.match(wasm, /pub fn wasm_contract_version\(\) -> String/);
  assert.match(wasm, /pub fn wasm_limits_json\(\) -> String/);
  assert.match(wasm, /JsError::new\("artifact_too_large"\)/);
  assert.doesNotMatch(wasm, /format!\("load failed: \{\}", e\)|e\.to_string\(\)/);

  assert.match(lib, /pub fn load_from_bytes_with_limits\(/);
  assert.match(lib, /zip_reader::read_artifact_files_with_limits\(bytes, limits\)/);
  assert.match(lib, /fn from_artifact_files\(files: HashMap<String, Vec<u8>>\)/);
});

test('W928 verify example is a bounded env-secret reference flow', () => {
  const example = read(EXAMPLE_REL);

  assert.match(example, new RegExp(EXAMPLE_CONTRACT));
  assert.match(example, /const DEFAULT_SECRET_ENV: &str = "KOLM_SECRET";/);
  assert.match(example, /const DEFAULT_MAX_ARTIFACT_BYTES: u64 = 64 \* 1024 \* 1024;/);
  assert.match(example, /const MAX_ARTIFACT_BYTES: u64 = 512 \* 1024 \* 1024;/);
  assert.match(example, /const MAX_SECRET_BYTES: usize = 4096;/);
  assert.match(example, /const MAX_ZIP_ENTRIES: usize = 64;/);
  assert.match(example, /"--secret-env"/);
  assert.match(example, /fn valid_env_name\(name: &str\) -> bool/);
  assert.match(example, /fn read_secret\(env_name: &str\) -> Result<String, String>/);
  assert.match(example, /secret\.len\(\) > MAX_SECRET_BYTES/);
  assert.match(example, /fn read_bounded\(path: &PathBuf, max_bytes: u64\) -> Result<Vec<u8>, String>/);
  assert.match(example, /fs::metadata\(path\)/);
  assert.match(example, /metadata\.len\(\) > max_bytes/);
  assert.match(example, /ZipReadLimits \{/);
  assert.match(example, /Artifact::load_from_bytes_with_limits\(&bytes, limits\)/);
  assert.match(example, /fn classify_load_error\(error: &kolm_runtime::Error\) -> &'static str/);
  assert.match(example, /fn display_path\(path: &PathBuf\) -> String/);
  assert.doesNotMatch(example, /Artifact::load_from_path\(/);
  assert.doesNotMatch(example, /"--secret"\s*=>|secret_arg|HMAC secret literal/);
});

test('W928 runtime-rs example and limited-loader sources type-check', () => {
  const host = run('cargo', ['check', '--manifest-path', CARGO_MANIFEST, '--lib', '--examples']);
  assert.equal(host.status, 0, host.stderr || host.stdout);
  assert.match(host.stderr || host.stdout, /Finished/);

  const hostWithWasmFeature = run('cargo', [
    'check',
    '--manifest-path',
    CARGO_MANIFEST,
    '--lib',
    '--examples',
    '--features',
    'wasm',
  ]);
  assert.equal(hostWithWasmFeature.status, 0, hostWithWasmFeature.stderr || hostWithWasmFeature.stdout);
  assert.match(hostWithWasmFeature.stderr || hostWithWasmFeature.stdout, /Finished/);

  const rustTests = run('cargo', [
    'test',
    '--manifest-path',
    CARGO_MANIFEST,
    '--lib',
    '--tests',
    '--examples',
  ]);
  assert.equal(rustTests.status, 0, rustTests.stderr || rustTests.stdout);
  assert.match(rustTests.stdout + rustTests.stderr, /test result: ok/);

  const rustup = run('rustup', ['target', 'list', '--installed'], 30000);
  if (rustup.error?.code === 'ENOENT' || rustup.status !== 0) {
    return;
  }
  if (!rustup.stdout.includes('wasm32-unknown-unknown')) {
    return;
  }

  const wasm = run('cargo', [
    'check',
    '--manifest-path',
    CARGO_MANIFEST,
    '--target',
    'wasm32-unknown-unknown',
    '--features',
    'wasm',
    '--lib',
  ]);
  assert.equal(wasm.status, 0, wasm.stderr || wasm.stdout);
  assert.match(wasm.stderr || wasm.stdout, /Finished/);
});
