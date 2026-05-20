// W481 P0-7 lock-in: the public registry-pack manifest (consumed by
// /hub.html "featured" strip) must include every slug listed in the live
// marketplace catalog (src/marketplace.js SEED_CATALOG). The audit flagged
// "8 vs 7, Qwen missing from hub" — once aligned, regressions are easy to
// reintroduce when a new marketplace entry lands without a manifest edit.
//
// Three lock-ins:
//   1) registry-pack manifest.json artifact count >= marketplace seed count.
//   2) Every marketplace SEED_CATALOG slug appears in manifest by `name`.
//   3) sha256 in manifest matches the on-disk artifact byte hash (no stale
//      manifest entries pointing at a different build).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MARKETPLACE_ARTIFACTS } from '../src/marketplace.js';

const REPO = path.resolve(import.meta.dirname, '..');
const MANIFEST_PATH = path.join(REPO, 'public', 'registry-pack', 'manifest.json');

test('W481 P0-7 #1 — registry-pack manifest has >= as many entries as SEED_CATALOG', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const seedCount = MARKETPLACE_ARTIFACTS.length;
  const manifestCount = manifest.artifacts.length;
  assert.ok(manifestCount >= seedCount, `manifest=${manifestCount} < seeds=${seedCount}: ${MARKETPLACE_ARTIFACTS.map((a) => a.slug).join(', ')}`);
});

test('W481 P0-7 #2 — every marketplace slug is present in registry-pack manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const manifestNames = new Set(manifest.artifacts.map((a) => a.name));
  const missing = [];
  for (const seed of MARKETPLACE_ARTIFACTS) {
    if (!manifestNames.has(seed.slug)) missing.push(seed.slug);
  }
  assert.deepEqual(missing, [], `missing from manifest: ${missing.join(', ')}`);
});

test('W481 P0-7 #3 — manifest sha256 matches on-disk artifact bytes', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const mismatches = [];
  for (const seed of MARKETPLACE_ARTIFACTS) {
    const m = manifest.artifacts.find((a) => a.name === seed.slug);
    if (!m) continue;
    const abs = path.join(REPO, seed.source_path);
    if (!fs.existsSync(abs)) { mismatches.push(`${seed.slug}: file missing at ${seed.source_path}`); continue; }
    const buf = fs.readFileSync(abs);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (sha !== m.sha256) mismatches.push(`${seed.slug}: manifest=${m.sha256.slice(0, 12)}... on-disk=${sha.slice(0, 12)}...`);
  }
  assert.deepEqual(mismatches, [], `manifest/on-disk sha drift: ${mismatches.join(' | ')}`);
});
