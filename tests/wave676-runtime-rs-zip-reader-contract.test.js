// W676 - direct contract/security test for packages/runtime-rs/src/zip_reader.rs.
//
// The Rust runtime zip reader is a package-distribution boundary. Artifact
// extraction must reject ambiguous duplicate names and enforce bounded reads.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const ZIP_READER_SOURCE = 'packages/runtime-rs/src/zip_reader.rs';

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

test('W676 runtime-rs zip reader exposes bounded extraction controls', () => {
  const src = read(ZIP_READER_SOURCE);

  assert.match(src, /pub const DEFAULT_MAX_ZIP_ENTRIES: usize = 512;/);
  assert.match(src, /pub const DEFAULT_MAX_ZIP_ENTRY_BYTES: u64 = 2 \* 1024 \* 1024 \* 1024;/);
  assert.match(src, /pub const DEFAULT_MAX_ZIP_TOTAL_BYTES: u64 = 4 \* 1024 \* 1024 \* 1024;/);
  assert.match(src, /pub struct ZipReadLimits/);
  assert.match(src, /pub fn read_artifact_files_with_limits/);
  assert.match(src, /archive\.len\(\) > limits\.max_entries/);
  assert.match(src, /declared_size > limits\.max_entry_bytes/);
  assert.match(src, /take\(limits\.max_entry_bytes\.saturating_add\(1\)\)/);
  assert.match(src, /checked_add\(buf\.len\(\) as u64\)/);
  assert.match(src, /total_uncompressed > limits\.max_total_bytes/);
});

test('W676 runtime-rs zip reader rejects ambiguous artifact member names', () => {
  const src = read(ZIP_READER_SOURCE);

  assert.match(src, /\.enclosed_name\(\)/);
  assert.match(src, /replace\('\\\\', "\/"\)/);
  assert.match(src, /name\.is_empty\(\)/);
  assert.match(src, /out\.contains_key\(&name\)/);
  assert.match(src, /duplicate zip entry name/);
});

test('W676 runtime-rs zip reader source pins duplicate and limit regressions', () => {
  const src = read(ZIP_READER_SOURCE);

  assert.match(src, /duplicate_zip_entry_is_rejected/);
  assert.match(src, /zip_limits_reject_large_entry/);
  assert.match(src, /zip_limits_reject_total_size/);
  assert.match(src, /zip_limits_reject_too_many_entries/);
});

test('W676 runtime-rs zip reader crate type-checks with bounded extraction', () => {
  const result = runCargo([
    'check',
    '--manifest-path',
    'packages/runtime-rs/Cargo.toml',
    '--lib',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr || result.stdout, /Finished/);
});
