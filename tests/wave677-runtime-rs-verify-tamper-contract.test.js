// W677 - direct contract/security test for packages/runtime-rs/tests/verify_tamper.rs.
//
// The Rust tamper fixture is the offline verifier's regression boundary. It
// must cover signed-but-malformed receipt chains, duplicate zip entries, and
// the verifier source must enforce the chain DAG shape.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const VERIFY_SOURCE = 'packages/runtime-rs/src/verify.rs';
const TAMPER_SOURCE = 'packages/runtime-rs/tests/verify_tamper.rs';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function runCargo(args) {
  return spawnSync('cargo', args, {
    cwd: ROOT,
    env: { ...process.env, CARGO_TARGET_DIR: path.join(os.tmpdir(), 'kolm-runtime-rs-target') },
    encoding: 'utf8',
    timeout: 180000,
  });
}

test('W677 runtime-rs verifier enforces receipt chain DAG shape', () => {
  const src = read(VERIFY_SOURCE);

  assert.match(src, /EXPECTED_CHAIN_STEPS: \[&str; 5\] = \["task", "seeds", "recipes", "evals", "package"\]/);
  assert.match(src, /receipt\.chain\.len\(\) != EXPECTED_CHAIN_STEPS\.len\(\)/);
  assert.match(src, /chain\[\{\}\] expected step \{\} got \{\}/);
  assert.match(src, /package_output_hash != &receipt\.artifact_hash/);
  assert.match(src, /receipt artifact_hash mismatch/);
  assert.match(src, /receipt\.artifact_hash != artifact_hash/);
  assert.match(src, /artifact_hash recompute mismatch/);
  assert.match(src, /compute_artifact_hash\(manifest, manifest_json_text\)/);
  assert.match(src, /obj\.remove\("signature"\)/);
  assert.match(src, /obj\.remove\("signature_ed25519"\)/);
  assert.match(src, /obj\.remove\("signature_sigstore"\)/);
});

test('W677 runtime-rs tamper fixture pins signed malformed-chain regressions', () => {
  const src = read(TAMPER_SOURCE);

  assert.match(src, /struct BuildKnobs/);
  assert.match(src, /tamper_chain_step_name: Option<\(usize, &'static str\)>/);
  assert.match(src, /tamper_receipt_artifact_hash: bool/);
  assert.match(src, /wrong_chain_step_name_breaks_chain_shape/);
  assert.match(src, /receipt_artifact_hash_mismatch_breaks_chain_shape/);
  assert.match(src, /duplicate_zip_entry_is_error/);
  assert.match(src, /repack_with_duplicate_entry/);
});

test('W677 runtime-rs touched proof files stay ASCII clean', () => {
  for (const rel of [VERIFY_SOURCE, TAMPER_SOURCE]) {
    assert.doesNotMatch(read(rel), /[^\x00-\x7F]/, `${rel} contains non-ASCII text`);
  }
});

test('W677 runtime-rs integration tests type-check without executing blocked binaries', () => {
  const result = runCargo([
    'check',
    '--manifest-path',
    'packages/runtime-rs/Cargo.toml',
    '--tests',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr || result.stdout, /Finished/);
});
