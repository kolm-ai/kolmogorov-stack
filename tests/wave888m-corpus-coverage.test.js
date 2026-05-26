// Wave W888-M — assistant-corpus seeds.jsonl + coverage lock-ins.
//
// W888-M builds data/assistant-corpus/seeds.jsonl from four scanners:
//   - scripts/corpus/scan-cli-verbs.cjs    (every cmd<Verb> in cli/kolm.js)
//   - scripts/corpus/scan-errors.cjs       (every throw site in src/ + cli/)
//   - scripts/corpus/scan-docs.cjs         (docs/**.md + public/docs/**.html)
//   - scripts/corpus/build-workflows.cjs   (60 hand-authored recipes A-F)
//
// The orchestrator scripts/build-assistant-corpus.cjs emits seeds.jsonl in
// nine buckets per the MCD split:
//   docs:400  cli_help:120  error_fix:80  workflow:60  casual:80
//   guardrail:50  concept:50  pricing:30  hardware:30
//
// Hard contracts asserted here:
//   1. seeds.jsonl exists; every line parses as JSON.
//   2. Bucket counts within +/-10% of MCD targets — EXCEPT cli_help, which
//      is allowed to overflow up to 2x its target because the verb-coverage
//      contract (every cmd<Verb> appears in >=1 seed) structurally pushes
//      it past 120 when cli/kolm.js exposes more verbs than the target.
//   3. Every kolm verb in cli-inventory.json appears in >=1 seed (either
//      directly in `sources[]` via the cmd<Verb> reference, or in
//      `must_include` via the `kolm <verb>` token).
//   4. No banned terms anywhere in the corpus: "honest", "honesty", or any
//      warm-paper hex (#c2410c / #faf9f7 / pure orange/beige codes).
//   5. coverage-report.json has the required fields:
//      buckets / bucket_targets / cli_verbs_total / cli_verbs_covered /
//      uncovered_verbs (== 0 elements) / seed_count.
//   6. At least one seed per bucket has >=3 must_include items, so W888-N's
//      teacher prompts have at least one well-anchored citation per bucket.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const SEEDS_PATH = path.join(REPO, 'data', 'assistant-corpus', 'seeds.jsonl');
const COVERAGE_PATH = path.join(REPO, 'data', 'assistant-corpus', 'coverage-report.json');
const INVENTORY_PATH = path.join(REPO, 'data', 'assistant-corpus', 'cli-inventory.json');
const BUILDER = path.join(REPO, 'scripts', 'build-assistant-corpus.cjs');

const MCD_TARGETS = {
  docs: 400,
  cli_help: 120,
  error_fix: 80,
  workflow: 60,
  casual: 80,
  guardrail: 50,
  concept: 50,
  pricing: 30,
  hardware: 30,
};
const TOTAL_TARGET = Object.values(MCD_TARGETS).reduce((a, b) => a + b, 0); // 900

// Buckets allowed to overflow significantly because of hard contracts.
// cli_help must cover every cli/kolm.js verb (>120 verbs as of W888-M).
const OVERFLOW_OK = { cli_help: 2.0 };

function ensureBuilt() {
  if (fs.existsSync(SEEDS_PATH) && fs.existsSync(COVERAGE_PATH) && fs.existsSync(INVENTORY_PATH)) return;
  const r = spawnSync(process.execPath, [BUILDER], { cwd: REPO, encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, `corpus builder failed: ${r.stderr || r.stdout}`);
}

test('W888-M corpus: seeds.jsonl exists and parses as valid JSONL', () => {
  ensureBuilt();
  assert.ok(fs.existsSync(SEEDS_PATH), `missing: ${SEEDS_PATH}`);
  const raw = fs.readFileSync(SEEDS_PATH, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  assert.ok(lines.length > 0, 'seeds.jsonl is empty');
  for (let i = 0; i < lines.length; i++) {
    let parsed;
    try { parsed = JSON.parse(lines[i]); }
    catch (e) { assert.fail(`seeds.jsonl line ${i + 1} is not valid JSON: ${e.message}`); }
    assert.equal(typeof parsed.id, 'string', `line ${i + 1}: id missing`);
    assert.equal(typeof parsed.bucket, 'string', `line ${i + 1}: bucket missing`);
    assert.equal(typeof parsed.intent, 'string', `line ${i + 1}: intent missing`);
    assert.ok(Array.isArray(parsed.sources), `line ${i + 1}: sources must be array`);
    assert.ok(Array.isArray(parsed.must_include), `line ${i + 1}: must_include must be array`);
    assert.ok(Array.isArray(parsed.must_not_include), `line ${i + 1}: must_not_include must be array`);
  }
});

test('W888-M corpus: bucket counts match MCD targets within tolerance', () => {
  ensureBuilt();
  const lines = fs.readFileSync(SEEDS_PATH, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const buckets = {};
  for (const s of lines) buckets[s.bucket] = (buckets[s.bucket] || 0) + 1;
  for (const [bucket, target] of Object.entries(MCD_TARGETS)) {
    const got = buckets[bucket] || 0;
    const lower = Math.floor(target * 0.9);
    const upperFactor = OVERFLOW_OK[bucket] || 1.1;
    const upper = Math.ceil(target * upperFactor);
    assert.ok(got >= lower, `bucket "${bucket}": ${got} < ${lower} (target ${target})`);
    assert.ok(got <= upper, `bucket "${bucket}": ${got} > ${upper} (target ${target})`);
  }
  // Total seed count: stay within +/-25% of 900 so W888-N has slack.
  const total = lines.length;
  assert.ok(total >= TOTAL_TARGET * 0.9, `total ${total} < ${TOTAL_TARGET * 0.9}`);
  assert.ok(total <= TOTAL_TARGET * 1.25, `total ${total} > ${TOTAL_TARGET * 1.25}`);
});

test('W888-M corpus: every cli verb appears in at least one seed', () => {
  ensureBuilt();
  const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf8'));
  const verbs = inventory.verbs || [];
  assert.ok(verbs.length > 0, 'cli-inventory.json has no verbs');
  const blob = fs.readFileSync(SEEDS_PATH, 'utf8');
  const uncovered = [];
  for (const v of verbs) {
    const verb = v.verb;
    // Match `kolm <verb>` token or cmd<Verb> reference. Use a regex to
    // avoid false positives where one verb is a prefix of another (e.g.
    // `bench` vs `benchmark`).
    const verbToken = new RegExp(`(?:^|[\\s\`'"])kolm ${escapeRegExp(verb)}(?=[\\s\`'".,\\]]|$)`);
    const cmdToken = new RegExp(`cmd${escapeRegExp(capitalize(verb))}\\b`);
    const quoted = new RegExp(`["']${escapeRegExp(verb)}["']`);
    if (!verbToken.test(blob) && !cmdToken.test(blob) && !quoted.test(blob)) {
      uncovered.push(verb);
    }
  }
  assert.equal(uncovered.length, 0,
    `uncovered verbs (first 10): ${uncovered.slice(0, 10).join(', ')}\n` +
    `total uncovered: ${uncovered.length}/${verbs.length}`);
});

test('W888-M corpus: no banned terms (honest, honesty, warm-paper hex)', () => {
  ensureBuilt();
  const raw = fs.readFileSync(SEEDS_PATH, 'utf8');
  const lower = raw.toLowerCase();
  // Word-boundary check so "honestly" / "honest" only trip when actually
  // present as a standalone token (not buried inside another identifier).
  const BANNED_WORDS = [/\bhonest\b/, /\bhonesty\b/, /\bhonestly\b/];
  for (const re of BANNED_WORDS) {
    assert.ok(!re.test(lower), `banned token ${re} present in seeds.jsonl`);
  }
  // Warm-paper hex codes (per W836+ standing constraint).
  const BANNED_HEX = ['#c2410c', '#faf9f7'];
  for (const h of BANNED_HEX) {
    assert.ok(!lower.includes(h.toLowerCase()),
      `banned warm-paper hex ${h} present in seeds.jsonl`);
  }
});

test('W888-M corpus: coverage-report.json has required fields', () => {
  ensureBuilt();
  assert.ok(fs.existsSync(COVERAGE_PATH), `missing: ${COVERAGE_PATH}`);
  const report = JSON.parse(fs.readFileSync(COVERAGE_PATH, 'utf8'));
  assert.equal(typeof report.generated_at, 'string', 'generated_at missing');
  assert.equal(typeof report.seed_count, 'number', 'seed_count missing');
  assert.equal(typeof report.buckets, 'object', 'buckets missing');
  assert.equal(typeof report.bucket_targets, 'object', 'bucket_targets missing');
  assert.equal(typeof report.cli_verbs_total, 'number', 'cli_verbs_total missing');
  assert.equal(typeof report.cli_verbs_covered, 'number', 'cli_verbs_covered missing');
  assert.ok(Array.isArray(report.uncovered_verbs), 'uncovered_verbs must be array');
  // Hard contract: cli_verbs_covered === cli_verbs_total (every verb seeded).
  assert.equal(report.cli_verbs_covered, report.cli_verbs_total,
    `${report.cli_verbs_covered} != ${report.cli_verbs_total} — ${report.uncovered_verbs.length} uncovered`);
  assert.equal(report.uncovered_verbs.length, 0,
    `uncovered_verbs not empty: ${report.uncovered_verbs.slice(0, 10).join(', ')}`);
});

test('W888-M corpus: at least one seed per bucket has >=3 must_include items', () => {
  ensureBuilt();
  const lines = fs.readFileSync(SEEDS_PATH, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const byBucket = {};
  for (const s of lines) {
    if (!byBucket[s.bucket]) byBucket[s.bucket] = [];
    byBucket[s.bucket].push(s);
  }
  for (const bucket of Object.keys(MCD_TARGETS)) {
    const seeds = byBucket[bucket] || [];
    const ge3 = seeds.filter(s => (s.must_include || []).length >= 3);
    assert.ok(ge3.length >= 1,
      `bucket "${bucket}": no seed has >=3 must_include items (${seeds.length} total seeds)`);
  }
});

test('W888-M corpus: cli-inventory.json schema is sound', () => {
  ensureBuilt();
  const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf8'));
  assert.equal(typeof inventory.generated_at, 'string', 'generated_at missing');
  assert.equal(typeof inventory.count, 'number', 'count missing');
  assert.ok(Array.isArray(inventory.verbs), 'verbs must be array');
  assert.ok(inventory.count > 50, `expected >50 verbs, got ${inventory.count}`);
  for (const v of inventory.verbs.slice(0, 5)) {
    assert.equal(typeof v.verb, 'string', `verb name missing`);
    assert.ok(Array.isArray(v.flags), `flags must be array for ${v.verb}`);
    // help_summary may be empty string but must be a string.
    assert.equal(typeof v.help_summary, 'string', `help_summary missing for ${v.verb}`);
  }
});

// ---------- helpers ----------
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function capitalize(s) {
  if (!s) return s;
  // cli/kolm.js camelCases hyphenated verbs into cmd<Camel> (e.g. "spec-decode"
  // -> cmdSpecDecode). Mirror that here so cmd<Verb> tokens resolve.
  return s.split(/[-_]/).map(p => p ? p[0].toUpperCase() + p.slice(1) : p).join('');
}
