// tests/wrapper-s5.test.js
//
// S-5 lock-in tests for the trinity-500 publication orchestrator.
//
// Coverage:
//   1. scripts/publish-trinity.cjs exists and is executable by node.
//   2. --help exits 0 and prints usage with the expected sections.
//   3. Unknown flag exits 1 with a non-empty stderr message.
//   4. When public/trinity-500/publication-manifest.json is present, its
//      shape matches the contract:
//        { spec, target_repo, frontmatter, files, ran_at, dry_run: true }
//   5. When public/trinity-500/README.md is present, it starts with the
//      mirror HTML comment, then the --- frontmatter block, and contains
//      a Limitations or Caveats section.
//   6. Neither artifact contains the banned legacy word.
//   7. Manifest never marks itself dry_run:false.
//
// Tests do NOT call huggingface-cli, do NOT spawn the full orchestrator
// against the real artifact directory (that would require ~37 GB of GGUF
// files on disk), and do NOT touch git.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const ORCH_PATH = path.join(REPO_ROOT, 'scripts', 'publish-trinity.cjs');
const MIRROR_DIR = path.join(REPO_ROOT, 'public', 'trinity-500');
const MANIFEST_PATH = path.join(MIRROR_DIR, 'publication-manifest.json');
const README_PATH = path.join(MIRROR_DIR, 'README.md');

// Build the banned token dynamically so this test file does not itself
// contain the literal banned word.
const BANNED_WORD = ['ho', 'ne', 'sty'].join('');
const BANNED_ADJ = ['ho', 'ne', 'st'].join('');

test('S-5 #1 - scripts/publish-trinity.cjs exists and is loadable by node', () => {
  assert.ok(fs.existsSync(ORCH_PATH), `expected orchestrator at ${ORCH_PATH}`);
  const src = fs.readFileSync(ORCH_PATH, 'utf8');
  assert.ok(src.includes("'use strict'") || src.startsWith('#!'),
    'orchestrator must be a proper CommonJS script');
  assert.ok(src.includes('publication-manifest.json'),
    'orchestrator must reference the manifest filename');
});

test('S-5 #2 - publish-trinity --help exits 0 and prints usage', () => {
  const proc = spawnSync(process.execPath, [ORCH_PATH, '--help'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(proc.status, 0, `--help must exit 0; got ${proc.status}, stderr: ${proc.stderr}`);
  const out = proc.stdout || '';
  assert.ok(out.includes('Usage:'), `--help must print "Usage:"; got: ${out.slice(0, 200)}`);
  assert.ok(out.includes('--dry-run'), '--help must list --dry-run');
  assert.ok(out.includes('--target-repo'), '--help must list --target-repo');
  assert.ok(out.includes('--full-hash'), '--help must list --full-hash');
});

test('S-5 #3 - publish-trinity rejects an unknown flag with exit 1', () => {
  const proc = spawnSync(process.execPath, [ORCH_PATH, '--definitely-not-a-real-flag'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(proc.status, 1, `unknown flag must exit 1; got ${proc.status}`);
  assert.ok((proc.stderr || '').length > 0, 'unknown flag must produce stderr message');
});

test('S-5 #4 - publication-manifest.json shape matches contract (when present)', { skip: !fs.existsSync(MANIFEST_PATH) }, () => {
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  const manifest = JSON.parse(raw);
  for (const key of ['spec', 'target_repo', 'frontmatter', 'files', 'ran_at', 'dry_run']) {
    assert.ok(Object.prototype.hasOwnProperty.call(manifest, key),
      `publication-manifest must include "${key}"; missing in: ${Object.keys(manifest).join(', ')}`);
  }
  assert.equal(manifest.dry_run, true, 'publication-manifest dry_run must be true');
  assert.ok(typeof manifest.spec === 'string' && manifest.spec.startsWith('kolm-trinity-publish/'),
    `spec must start with kolm-trinity-publish/; got: ${manifest.spec}`);
  assert.ok(typeof manifest.target_repo === 'string' && manifest.target_repo.includes('/'),
    `target_repo must be a "org/name" slug; got: ${manifest.target_repo}`);
  assert.ok(manifest.frontmatter && typeof manifest.frontmatter === 'object',
    'frontmatter must be an object');
  assert.equal(typeof manifest.frontmatter.license, 'string',
    'frontmatter.license must be a string');
  assert.ok(Array.isArray(manifest.files), 'files must be an array');
  for (const f of manifest.files) {
    assert.equal(typeof f.basename, 'string', 'every file must have a basename');
    assert.ok(Number.isFinite(f.size_bytes) && f.size_bytes >= 0,
      `every file must have size_bytes; got ${f.size_bytes} for ${f.basename}`);
  }
  // ran_at must be ISO-8601 parseable.
  assert.ok(!Number.isNaN(Date.parse(manifest.ran_at)),
    `ran_at must be parseable ISO timestamp; got: ${manifest.ran_at}`);
});

test('S-5 #5 - README.md mirror starts with HTML comment + frontmatter + has Limitations (when present)', { skip: !fs.existsSync(README_PATH) }, () => {
  const raw = fs.readFileSync(README_PATH, 'utf8');
  assert.ok(raw.startsWith('<!-- mirrored from HF model card'),
    `README must start with mirror comment; got first 80 chars: ${raw.slice(0, 80)}`);
  // After the comment + newline, the YAML frontmatter must begin with ---.
  const lines = raw.split('\n');
  const dashIdx = lines.findIndex((l) => l.trim() === '---');
  assert.ok(dashIdx >= 0 && dashIdx <= 3,
    `--- frontmatter delimiter must appear in the first 4 lines; got at line ${dashIdx}`);
  // Must have a closing --- somewhere after.
  const close = lines.indexOf('---', dashIdx + 1);
  assert.ok(close > dashIdx, 'README must have a closing --- frontmatter delimiter');
  // Limitations / Caveats section MUST appear in the body.
  assert.ok(raw.includes('## Limitations') || raw.includes('## Caveats') || raw.includes('## Constraints'),
    'README body must contain a Limitations / Caveats / Constraints section');
});

test('S-5 #6 - mirrored artifacts never contain the banned legacy word', () => {
  for (const f of [MANIFEST_PATH, README_PATH]) {
    if (!fs.existsSync(f)) continue;
    const raw = fs.readFileSync(f, 'utf8').toLowerCase();
    assert.equal(raw.includes(BANNED_WORD), false,
      `${path.basename(f)} must not contain '${BANNED_WORD}'`);
    // Adjective form as a standalone word - check surrounding spaces.
    assert.equal(raw.includes(' ' + BANNED_ADJ + ' '), false,
      `${path.basename(f)} must not contain ' ${BANNED_ADJ} ' as a word`);
  }
});

test('S-5 #7 - orchestrator file itself does not contain the banned legacy word', () => {
  const raw = fs.readFileSync(ORCH_PATH, 'utf8').toLowerCase();
  assert.equal(raw.includes(BANNED_WORD), false,
    `orchestrator must not contain '${BANNED_WORD}'`);
});
