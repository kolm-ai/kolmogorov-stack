// W675 - direct contract/security test for packages/runtime-rs/src/tofu.rs.
//
// The Rust runtime TOFU store is a proof/trust boundary. Malformed stores
// must have a strict error path, and malformed pins must not be recorded.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const TOFU_SOURCE = 'packages/runtime-rs/src/tofu.rs';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function runCargo(args) {
  return spawnSync('cargo', ['--offline', ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      CARGO_NET_OFFLINE: 'true',
      CARGO_TARGET_DIR: path.join(os.tmpdir(), 'kolm-runtime-rs-target'),
    },
    encoding: 'utf8',
    timeout: 120000,
  });
}

test('W675 runtime-rs TOFU store has strict load and pin validation paths', () => {
  const src = read(TOFU_SOURCE);
  assert.match(src, /pub fn try_from_json\(bytes: &\[u8\]\) -> Result<Self, Error>/);
  assert.match(src, /serde_json::from_slice\(bytes\)\.map_err\(Error::Json\)/);
  assert.match(src, /trust store contains invalid pin/);
  assert.match(src, /fn valid_pin_inputs\(cid: &str, signed_by: &str\) -> bool/);
  assert.match(src, /is_valid_cid_format\(cid\)/);
  assert.match(src, /fn valid_signed_by\(signed_by: &str\) -> bool/);
  assert.match(src, /signed_by\.len\(\) <= 256/);
  assert.match(src, /valid_pin_inputs\(cid, signed_by\)/);
});

test('W675 runtime-rs TOFU source pins invalid-store and invalid-pin regression cases', () => {
  const src = read(TOFU_SOURCE);
  assert.match(src, /try_from_json_invalid_returns_error/);
  assert.match(src, /invalid_pin_inputs_are_ignored/);
  assert.match(src, /cidv1:sha256:a/);
  assert.match(src, /bad namespace/);
  assert.match(src, /bad\\"namespace/);
});

test('W675 runtime-rs TOFU crate type-checks with strict trust-store loading', () => {
  const result = runCargo([
    'check',
    '--manifest-path',
    'packages/runtime-rs/Cargo.toml',
    '--lib',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr || result.stdout, /Finished/);
});
