// W724 — Memory-aware scheduling: tier detection + placement estimator tests.
//
// Atomic items pinned (matches the W724 implementation):
//
//   1) detectMemoryTiers() returns a numeric shape on every field
//   2) estimatePlacement places a small artifact in VRAM
//   3) estimatePlacement places a large artifact mixed VRAM+RAM
//   4) estimatePlacement places an oversize artifact on NVMe
//   5) applyAutoPlaceDecision produces a reasoning_line mentioning VRAM + tok/s
//   6) CLI dispatcher: `kolm run --auto-place --placement-only --artifact ...`
//      emits a placement decision line and DOES NOT load the artifact.
//   7) MEMORY_TIER_VERSION exported and pinned to 'w724-v1'
//   8) /docs/runtime/memory-tiers.html exists + contains load-bearing strings
//   9) Anti-brittleness: sibling-wave count uses regex(7\d\d) ≥ 3 threshold
//  10) Honest-failure: no nvidia-smi → vram_gb === 0 (not throw, not negative)
//
// W604 anti-brittleness: no explicit-array family checks, no exact-string
// matches on free-form messages. Assertions key on load-bearing fields
// (version stamp, placement bucket, numeric ranges, reasoning_line tokens,
// exit codes, file existence).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  MEMORY_TIER_VERSION,
  detectMemoryTiers,
  estimatePlacement,
  applyAutoPlaceDecision,
} from '../src/memory-tier.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '..', 'cli', 'kolm.js');
const DOC_PATH = path.join(__dirname, '..', 'public', 'docs', 'runtime', 'memory-tiers.html');
const TESTS_DIR = path.join(__dirname);

// Each test that touches the on-disk NVMe probe gets a fresh KOLM_DATA_DIR
// so the probe can't accidentally land on a stale state directory written
// by a sibling test in the larger suite.
function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w724-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  return tmp;
}

// =============================================================================
// 1) detectMemoryTiers shape contract
// =============================================================================

test('W724 #1 — detectMemoryTiers returns {vram_gb:number, ram_gb:number, nvme_gb:number, network_gbps:number|null}', () => {
  freshDir();
  const t = detectMemoryTiers();
  assert.equal(typeof t, 'object');
  assert.notEqual(t, null);
  assert.equal(typeof t.vram_gb, 'number',
    `vram_gb must be a number (got ${typeof t.vram_gb}: ${t.vram_gb})`);
  assert.equal(typeof t.ram_gb, 'number',
    `ram_gb must be a number (got ${typeof t.ram_gb}: ${t.ram_gb})`);
  assert.equal(typeof t.nvme_gb, 'number',
    `nvme_gb must be a number (got ${typeof t.nvme_gb}: ${t.nvme_gb})`);
  assert.ok(t.network_gbps === null || typeof t.network_gbps === 'number',
    `network_gbps must be number|null (got ${typeof t.network_gbps}: ${t.network_gbps})`);
  // Non-negativity invariant — every probe failure must yield zero, never negative.
  assert.ok(t.vram_gb >= 0, `vram_gb must be non-negative; got ${t.vram_gb}`);
  assert.ok(t.ram_gb >= 0, `ram_gb must be non-negative; got ${t.ram_gb}`);
  assert.ok(t.nvme_gb >= 0, `nvme_gb must be non-negative; got ${t.nvme_gb}`);
});

// =============================================================================
// 2) estimatePlacement: 4GB artifact, 24GB VRAM → placement === 'vram'
// =============================================================================

test('W724 #2 — estimatePlacement places small artifact in VRAM with healthy tok/s', () => {
  const r = estimatePlacement({
    artifact_size_gb: 4,
    tiers: { vram_gb: 24, ram_gb: 32, nvme_gb: 100, network_gbps: 1 },
  });
  assert.equal(r.placement, 'vram',
    `4GB artifact in 24GB VRAM must place 'vram'; got '${r.placement}'`);
  assert.ok(r.expected_tok_per_s > 50,
    `vram-only placement must report >50 tok/s; got ${r.expected_tok_per_s}`);
  assert.equal(r.fits_in_vram, true);
  assert.equal(r.fits_in_ram, true);
  assert.equal(r.mixed_breakdown.vram_layers, 100,
    `pure VRAM placement must report 100% vram_layers; got ${r.mixed_breakdown.vram_layers}`);
  assert.equal(r.mixed_breakdown.ram_layers, 0);
  assert.equal(r.mixed_breakdown.nvme_layers, 0);
});

// =============================================================================
// 3) estimatePlacement: 30GB artifact, 12GB VRAM, 64GB RAM → 'mixed'
// =============================================================================

test('W724 #3 — estimatePlacement places oversize-for-VRAM artifact mixed VRAM+RAM with both tiers populated', () => {
  const r = estimatePlacement({
    artifact_size_gb: 30,
    tiers: { vram_gb: 12, ram_gb: 64, nvme_gb: 500, network_gbps: 1 },
  });
  assert.equal(r.placement, 'mixed',
    `30GB artifact + 12GB VRAM + 64GB RAM must place 'mixed'; got '${r.placement}'`);
  assert.ok(r.expected_tok_per_s > 10 && r.expected_tok_per_s < 60,
    `mixed placement tok/s must be in (10,60); got ${r.expected_tok_per_s}`);
  assert.ok(r.mixed_breakdown.vram_layers > 0,
    `mixed placement must put SOME layers in VRAM; got ${r.mixed_breakdown.vram_layers}`);
  assert.ok(r.mixed_breakdown.ram_layers > 0,
    `mixed placement must put SOME layers in RAM; got ${r.mixed_breakdown.ram_layers}`);
  // Sanity: the two layer counts must sum to ~100% (mixed mode has no NVMe spill).
  assert.equal(
    r.mixed_breakdown.vram_layers + r.mixed_breakdown.ram_layers,
    100,
    'mixed breakdown vram+ram should sum to 100%',
  );
  assert.equal(r.fits_in_vram, false);
});

// =============================================================================
// 4) estimatePlacement: 200GB artifact, 8GB VRAM, 16GB RAM → 'nvme', tok/s < 20
// =============================================================================

test('W724 #4 — estimatePlacement places mega-artifact on NVMe with realistic slow tok/s', () => {
  const r = estimatePlacement({
    artifact_size_gb: 200,
    tiers: { vram_gb: 8, ram_gb: 16, nvme_gb: 1000, network_gbps: 1 },
  });
  assert.equal(r.placement, 'nvme',
    `200GB artifact + 8GB VRAM + 16GB RAM + 1TB NVMe must place 'nvme'; got '${r.placement}'`);
  assert.ok(r.expected_tok_per_s < 20,
    `NVMe placement tok/s must be < 20; got ${r.expected_tok_per_s}`);
  assert.ok(r.expected_tok_per_s > 0,
    `NVMe placement must still report POSITIVE tok/s (artifact is runnable); got ${r.expected_tok_per_s}`);
  assert.equal(r.fits_in_vram, false);
  assert.equal(r.fits_in_ram, false);
  assert.equal(r.mixed_breakdown.nvme_layers, 100);
});

// =============================================================================
// 5) applyAutoPlaceDecision: reasoning_line mentions VRAM and a tok/s number
// =============================================================================

test('W724 #5 — applyAutoPlaceDecision reasoning_line contains "VRAM" and a tok/s number', () => {
  const out = applyAutoPlaceDecision(4, {
    tiers: { vram_gb: 24, ram_gb: 32, nvme_gb: 100, network_gbps: 1 },
  });
  assert.equal(typeof out, 'object');
  assert.equal(out.version, MEMORY_TIER_VERSION);
  assert.equal(out.artifact_size_gb, 4);
  assert.equal(typeof out.reasoning_line, 'string');
  assert.ok(/VRAM/.test(out.reasoning_line),
    `reasoning_line must mention "VRAM"; got "${out.reasoning_line}"`);
  assert.ok(/tok\/s/.test(out.reasoning_line),
    `reasoning_line must mention "tok/s"; got "${out.reasoning_line}"`);
  // tok/s number must actually appear (not just the literal word) — pull
  // the first numeric run and verify it's > 0.
  const tokNumMatch = out.reasoning_line.match(/~?(\d+(?:\.\d+)?)\s*tok\/s/);
  assert.ok(tokNumMatch, `reasoning_line must include "<number> tok/s"; got "${out.reasoning_line}"`);
  assert.ok(Number(tokNumMatch[1]) > 0,
    `tok/s number in reasoning_line must be > 0; got ${tokNumMatch[1]}`);
  assert.equal(out.decision.placement, 'vram');
});

// =============================================================================
// 6) CLI integration: `kolm run --auto-place --placement-only --artifact <fake>`
// =============================================================================

test('W724 #6 — CLI `kolm run --auto-place --placement-only --artifact <fake>` emits placement decision line', () => {
  const tmp = freshDir();
  const fakeArtifact = path.join(tmp, 'fake.kolm');
  // Note: the fake artifact intentionally does NOT exist. --placement-only
  // means the run flow short-circuits BEFORE artifact resolution, so the
  // user sees the placement plan without actually loading anything.
  const env = {
    ...process.env,
    HOME: tmp,
    USERPROFILE: tmp,
    KOLM_HOME: path.join(tmp, '.kolm'),
    KOLM_DATA_DIR: path.join(tmp, '.kolm'),
    KOLM_ENV: 'test',
  };
  const r = spawnSync(process.execPath, [
    CLI_PATH, 'run',
    '--auto-place',
    '--placement-only',
    '--artifact', fakeArtifact,
  ], { env, encoding: 'utf8', timeout: 30_000 });

  const stdout = r.stdout || '';
  const stderr = r.stderr || '';
  // The decision line MUST appear somewhere in stdout — never silent.
  assert.ok(/placement:/.test(stdout),
    `stdout must contain "placement:"; stdout=${stdout.slice(0, 400)} stderr=${stderr.slice(0, 400)} status=${r.status}`);
  assert.ok(/expected_tok_per_s:/.test(stdout),
    `stdout must contain "expected_tok_per_s:"; stdout=${stdout.slice(0, 400)} stderr=${stderr.slice(0, 400)} status=${r.status}`);
  // Exit code MUST be 0 — placement-only is a pure dry-run, no failure.
  assert.equal(r.status, 0,
    `placement-only dry-run must exit 0; got ${r.status}; stderr=${stderr.slice(0, 400)}`);
});

// =============================================================================
// 7) MEMORY_TIER_VERSION constant
// =============================================================================

test('W724 #7 — MEMORY_TIER_VERSION is "w724-v1"', () => {
  assert.equal(MEMORY_TIER_VERSION, 'w724-v1');
});

// =============================================================================
// 8) Doc page exists and contains load-bearing strings
// =============================================================================

test('W724 #8 — /docs/runtime/memory-tiers.html exists and documents the four tiers + auto-placement', () => {
  assert.ok(fs.existsSync(DOC_PATH),
    `expected doc file at ${DOC_PATH}`);
  const html = fs.readFileSync(DOC_PATH, 'utf8');
  // Load-bearing strings — these are the FOUR tier names + the auto-placement
  // verb. Anti-brittleness: we don't lock to exact prose, just to the tokens
  // a reader skimming the page MUST encounter.
  for (const needle of ['Auto-Placement', 'VRAM', 'RAM', 'NVMe']) {
    assert.ok(html.includes(needle),
      `memory-tiers.html must mention "${needle}"`);
  }
});

// =============================================================================
// 9) Anti-brittleness: sibling W7xx wave file count uses regex + threshold
// =============================================================================

test('W724 #9 — wave724 sibling test count uses regex(7\\d\\d) + threshold pattern (no explicit array)', () => {
  // Walk the tests directory and count files matching wave(7\d\d). The W724
  // owner spec FORBIDS `^family^` explicit-array assertions. This test
  // proves the regex+threshold pattern is what's in place.
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(7\d\d)-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  // Threshold check — at least 3 wave7xx test files MUST exist (W724 itself
  // + two earlier siblings such as W721/W722). Threshold is forward-compat:
  // adding more wave7xx tests does NOT break this test.
  assert.ok(siblings.length >= 3,
    `expected >=3 wave7xx test files; found ${siblings.length}: ${siblings.join(',')}`);
});

// =============================================================================
// 10) Honest-failure path: no nvidia-smi → vram_gb === 0
// =============================================================================

test('W724 #10 — detectMemoryTiers honest-fails to vram_gb=0 when nvidia-smi is unreachable', () => {
  // Force the nvidia-smi probe to MISS by emptying PATH. The detector must
  // catch the spawn failure and yield vram_gb=0 — never throw, never
  // negative, never undefined. This is the load-bearing contract for
  // CPU-only hosts and CI runners.
  freshDir();
  const savedPath = process.env.PATH;
  const savedPath2 = process.env.Path;
  try {
    process.env.PATH = '';
    process.env.Path = '';
    const t = detectMemoryTiers();
    assert.equal(typeof t.vram_gb, 'number',
      `vram_gb must be a number even when nvidia-smi unreachable; got ${typeof t.vram_gb}`);
    assert.equal(t.vram_gb, 0,
      `vram_gb must be exactly 0 when nvidia-smi unreachable; got ${t.vram_gb}`);
    assert.ok(t.vram_gb >= 0, 'vram_gb must be non-negative on the no-GPU honest-fail path');
  } finally {
    process.env.PATH = savedPath;
    process.env.Path = savedPath2;
  }
});
