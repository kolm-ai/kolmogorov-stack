// W678 - direct contract/security test for packages/sdk-kotlin/src/main/kotlin/ai/kolm/Kolm.kt.
//
// The Android/Kotlin SDK loads untrusted .kolm zip artifacts from app assets
// or files. It must preserve CID parity with Node/Rust and fail closed on
// unsafe archive members before dispatching to device backends.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const KOTLIN_SOURCE = 'packages/sdk-kotlin/src/main/kotlin/ai/kolm/Kolm.kt';
const KOTLIN_BUILD = 'packages/sdk-kotlin/build.gradle.kts';
const KOTLIN_README = 'packages/sdk-kotlin/README.md';

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function runNode(args) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 180000,
  });
}

test('W678 Kotlin SDK extraction rejects unsafe zip shapes', () => {
  const src = read(KOTLIN_SOURCE);

  assert.match(src, /MAX_ZIP_ENTRIES = 512/);
  assert.match(src, /MAX_ZIP_ENTRY_BYTES = 2L \* 1024L \* 1024L \* 1024L/);
  assert.match(src, /MAX_ZIP_TOTAL_BYTES = 4L \* 1024L \* 1024L \* 1024L/);
  assert.match(src, /private fun normalizeZipEntryName/);
  assert.match(src, /private fun safeOutputFile/);
  assert.match(src, /private fun copyEntryBounded/);
  assert.match(src, /duplicate zip entry name/);
  assert.match(src, /normalized\.startsWith\("\/"\)/);
  assert.match(src, /normalized\.contains\(":"\)/);
  assert.match(src, /it == "\.\."/);
  assert.match(src, /canonicalFile/);
  assert.match(src, /deleteRecursively\(\)/);
});

test('W678 Kotlin SDK keeps CID and receipt verification aligned with the stack', () => {
  const src = read(KOTLIN_SOURCE);

  for (const key of ['model_pointer', 'recipes_json', 'lora_bin', 'index_bin', 'evals_json']) {
    assert.match(src, new RegExp(`"${key}"`));
  }
  assert.match(src, /HEX64 = Regex\("\^\[0-9a-f\]\{64\}\$"\)/);
  assert.match(src, /put\("digest", "sha256"\)/);
  assert.match(src, /put\("parts", parts\)/);
  assert.doesNotMatch(src, /put\("hashes", hashes\)/);
  assert.match(src, /receipt CID \$receiptCid !=/);
  assert.match(src, /private fun constantTimeEquals/);
  assert.match(src, /JSONObject\.NULL -> "null"/);
});

test('W678 Kotlin package files stay ASCII clean', () => {
  for (const rel of [KOTLIN_SOURCE, KOTLIN_BUILD, KOTLIN_README]) {
    assert.doesNotMatch(read(rel), /[^\x00-\x7F]/, `${rel} contains non-ASCII text`);
  }
});

test('W678 Kotlin package release readiness target remains locally checkable', () => {
  const result = runNode([
    'scripts/package-release-readiness.mjs',
    '--run-local-checks',
    '--target=sdk-kotlin',
    '--summary',
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /sdk-kotlin:gradle publishToMavenLocal: (pass|skipped:)/);
});
