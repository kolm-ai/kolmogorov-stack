// W674 - direct contract/security test for packages/runtime-rs/src/cid.rs.
//
// The Rust runtime CID module is a package-distribution proof boundary.
// A malformed-but-parseable CID must not look structurally valid to callers.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const CID_SOURCE = 'packages/runtime-rs/src/cid.rs';
const LIB_SOURCE = 'packages/runtime-rs/src/lib.rs';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function runCargo(args) {
  return spawnSync('cargo', args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
  });
}

test('W674 runtime-rs CID source exposes a strict canonical format helper', () => {
  const src = read(CID_SOURCE);
  const lib = read(LIB_SOURCE);

  assert.match(src, /pub const CID_VERSION: &str = "cidv1";/);
  assert.match(src, /pub const CID_DIGEST: &str = "sha256";/);
  assert.match(src, /pub fn is_valid_cid_format\(s: &str\) -> bool/);
  assert.match(src, /fn is_lower_hex64\(s: &str\) -> bool/);
  assert.match(src, /s\.len\(\) == 64/);
  assert.match(src, /version != CID_VERSION \|\| digest != CID_DIGEST/);
  assert.doesNotMatch(src, /starts_with\("cidv"\)/);
  assert.doesNotMatch(src, /splitn\(3, ':'\)/);
  assert.match(lib, /is_valid_cid_format/);
});

test('W674 runtime-rs CID unit tests pin non-canonical rejection cases', () => {
  const src = read(CID_SOURCE);
  assert.match(src, /parse_cid_invalid/);
  assert.match(src, /cidv2:sha256/);
  assert.match(src, /cidv1:blake3/);
  assert.match(src, /cidv1:sha256:0000/);
  assert.match(src, /AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/);
  assert.match(src, /cidv1:sha256:0000000000000000000000000000000000000000000000000000000000000000:extra/);
});

test('W674 runtime-rs CID crate type-checks with the strict parser', () => {
  const result = runCargo([
    'check',
    '--manifest-path',
    'packages/runtime-rs/Cargo.toml',
    '--lib',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr || result.stdout, /Finished/);
});
