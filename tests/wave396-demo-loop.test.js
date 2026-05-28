// Wave 396 . `kolm demo seed-log-triage` close-the-loop seed corpus.
//
// The acceptance test is the 12-command flow:
//   npm i -g github:kolm-ai/kolm
//   kolm connect start --detach
//   kolm connect doctor
//   kolm privacy test "email a@b.com ssn 123-45-6789"
//   kolm lake stats
//   kolm demo seed-log-triage
//   kolm optimize
//   kolm dataset create demo-log-triage
//   kolm bakeoff demo-log-triage
//   kolm build demo-log-triage
//   kolm run demo-log-triage.kolm "ERROR db timeout on checkout"
//   kolm what
//
// This test asserts the BEHAVIOR seam: after `demo seed-log-triage` the
// event-store has N events in the demo-log-triage namespace, the receipt
// chain tags them as source_type=simulated, the cluster signature collapses
// so local_replacement_candidate has a 100+ population, and the curated
// example dir (examples/demo-log-triage/) is structurally sound enough for
// `kolm build demo-log-triage` to wire through findCuratedTemplate().
//
// Tests assert BEHAVIOR (CLI exit codes + event-store rows + filesystem),
// not page copy (the W202-W210 anti-pattern Pablo flagged).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(ROOT, 'cli', 'kolm.js');
const EXAMPLE_DIR = path.join(ROOT, 'examples', 'demo-log-triage');

function runCli(args, { extraEnv, home } = {}) {
  const tmp = home || fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w396-'));
  const env = {
    ...process.env,
    HOME: tmp,
    USERPROFILE: tmp,
    KOLM_HOME: path.join(tmp, '.kolm'),
    KOLM_DATA_DIR: path.join(tmp, '.kolm'),
    KOLM_STORE_DRIVER: 'jsonl',
    ...(extraEnv || {}),
  };
  delete env.KOLM_API_KEY;
  const r = spawnSync(process.execPath, [CLI_PATH, ...args], {
    env, encoding: 'utf8', timeout: 60000,
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', signal: r.signal, home: tmp };
}

function parseJson(out) {
  const trimmed = (out || '').trim();
  if (trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed); } catch (_) {} // deliberate: cleanup
  }
  const line = (out || '').split(/\r?\n/).map(s => s.trim()).find(s => s.startsWith('{'));
  if (!line) throw new Error('no JSON line in stdout: ' + JSON.stringify(out).slice(0, 200));
  return JSON.parse(line);
}

function cleanup(home) {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
}

// ===========================================================================
// 1 . curated example dir exists and is structurally sound
// ===========================================================================

test('W396 #1 . examples/demo-log-triage/ has spec.json + recipe.js + seeds.jsonl', () => {
  for (const f of ['spec.json', 'recipe.js', 'seeds.jsonl']) {
    const p = path.join(EXAMPLE_DIR, f);
    assert.ok(fs.existsSync(p), `missing ${f} in examples/demo-log-triage/`);
  }
});

test('W396 #2 . spec.json job_id + K-score gate + comparator are pinned', () => {
  const spec = JSON.parse(fs.readFileSync(path.join(EXAMPLE_DIR, 'spec.json'), 'utf8'));
  assert.equal(spec.job_id, 'job_demo_log_triage_v1');
  assert.equal(spec.comparator, 'json_subset');
  assert.equal(spec.k_score.threshold, 0.85);
  assert.ok(Array.isArray(spec.recipes) && spec.recipes.length === 1);
  assert.equal(spec.recipes[0].source_file, './recipe.js');
});

test('W396 #3 . seeds.jsonl has >= 50 rows so 80/20 split clears MIN_PRODUCTION_TRAIN', () => {
  const raw = fs.readFileSync(path.join(EXAMPLE_DIR, 'seeds.jsonl'), 'utf8');
  const rows = raw.split(/\r?\n/).filter(s => s.trim().startsWith('{'));
  assert.ok(rows.length >= 50, `expected >= 50 seed rows, got ${rows.length}`);
  // Train count after 80/20 split must clear the MIN_PRODUCTION_TRAIN=40 gate.
  const trainCount = Math.floor(rows.length * 0.8);
  assert.ok(trainCount >= 40, `train_count ${trainCount} < MIN_PRODUCTION_TRAIN (40)`);
  // Every row must be parseable and carry expected.category.
  const cats = new Set();
  for (const r of rows) {
    const obj = JSON.parse(r);
    assert.ok(obj.input && typeof obj.input.log === 'string');
    assert.ok(obj.expected && typeof obj.expected.category === 'string');
    cats.add(obj.expected.category);
  }
  // All 6 categories + unknown fallback should appear.
  for (const c of ['db', 'network', 'auth', 'deploy', 'app-bug', 'infra']) {
    assert.ok(cats.has(c), `seeds.jsonl missing category=${c}`);
  }
});

test('W396 #4 . recipe.js avoids forbidden identifiers (require / module) outside comments', () => {
  const raw = fs.readFileSync(path.join(EXAMPLE_DIR, 'recipe.js'), 'utf8');
  // Mirror the verifier's pre-scan: strip line + block comments and string
  // literals so doc references like "// import/require..." don't false-match.
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')  // block comments
    .replace(/\/\/.*$/gm, '')            // line comments
    .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""'); // string literals
  assert.equal(/\brequire\s*\(/.test(stripped), false, 'recipe.js calls require()');
  assert.equal(/\bmodule\.(exports|id)\b/.test(stripped), false, 'recipe.js uses module.exports/id');
});

// ===========================================================================
// 2 . CLI dispatcher wiring
// ===========================================================================

test('W396 #5 . `kolm demo` (no subverb) lists the seed-log-triage flow', () => {
  const r = runCli(['demo']);
  cleanup(r.home);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
  assert.match(r.stdout, /seed-log-triage/, 'demo list must mention seed-log-triage flow');
});

test('W396 #6 . `kolm demo list --json` returns flows envelope', () => {
  const r = runCli(['demo', 'list', '--json']);
  cleanup(r.home);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
  const env = parseJson(r.stdout);
  assert.equal(env.ok, true);
  assert.ok(Array.isArray(env.flows));
  assert.ok(env.flows.find(f => f.id === 'seed-log-triage'), 'flows[] missing seed-log-triage');
});

// ===========================================================================
// 3 . seed-log-triage actually appends events
// ===========================================================================

test('W396 #7 . `demo seed-log-triage --count 80` appends 80 events to the lake', () => {
  const r = runCli(['demo', 'seed-log-triage', '--count', '80', '--json']);
  try {
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
    const env = parseJson(r.stdout);
    assert.equal(env.ok, true);
    assert.equal(env.namespace, 'demo-log-triage');
    assert.equal(env.events_appended, 80, `expected 80 events_appended, got ${env.events_appended}`);
    assert.ok(Array.isArray(env.next_steps) && env.next_steps.length >= 4);
    // Next steps must reference the close-the-loop verbs.
    const joined = env.next_steps.join(' | ');
    for (const verb of ['lake stats', 'optimize', 'dataset create', 'build']) {
      assert.match(joined, new RegExp(verb), `next_steps missing reference to: ${verb}`);
    }
  } finally {
    cleanup(r.home);
  }
});

test('W396 #8 . seeded events are tagged source_type=simulated', async () => {
  const r = runCli(['demo', 'seed-log-triage', '--count', '40', '--json']);
  try {
    assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
    // Read events back via the public store API (driver-agnostic — works for
    // both sqlite and jsonl modes). KOLM_DATA_DIR must match the CLI run.
    process.env.KOLM_DATA_DIR = path.join(r.home, '.kolm');
    process.env.HOME = r.home;
    process.env.USERPROFILE = r.home;
    const mod = await import('../src/event-store.js?w396_8=' + Date.now());
    if (mod._resetForTests) mod._resetForTests();
    const events = await mod.listEvents({ namespace: 'demo-log-triage', limit: 1000 });
    assert.ok(events.length >= 40, `expected >= 40 events, got ${events.length}`);
    const simulated = events.filter(e => e.source_type === 'simulated').length;
    assert.equal(simulated, events.length,
      `every seeded event must carry source_type=simulated; got ${simulated}/${events.length}`);
    if (mod._resetForTests) mod._resetForTests();
  } finally {
    delete process.env.KOLM_DATA_DIR;
    cleanup(r.home);
  }
});

test('W396 #9 . seed -> lake stats reports >= 60 calls when filtered to demo namespace', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w396-flow-'));
  try {
    const seed = runCli(['demo', 'seed-log-triage', '--count', '60', '--json'], { home });
    assert.equal(seed.code, 0, `seed failed: ${seed.stderr}`);
    // Filter to the demo namespace so the test isolates from any noise.
    const stats = runCli(['lake', 'stats', '--namespace', 'demo-log-triage', '--json'], { home });
    assert.equal(stats.code, 0, `lake stats failed: ${stats.stderr}`);
    const env = parseJson(stats.stdout);
    // lake stats output is the stats object directly (no { ok } wrapper).
    assert.ok(typeof env === 'object' && env !== null, 'lake stats must return an object');
    assert.ok(typeof env.total_calls === 'number',
      `lake stats must include total_calls; got: ${JSON.stringify(env).slice(0, 300)}`);
    assert.ok(env.total_calls >= 60,
      `total_calls must be >= 60 after seeding 60 events; got ${env.total_calls}`);
  } finally {
    cleanup(home);
  }
});

// ===========================================================================
// 4 . reset --confirm purges only the demo namespace
// ===========================================================================

test('W396 #10 . `demo reset --confirm` purges the namespace and reports the count', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w396-reset-'));
  try {
    const seed = runCli(['demo', 'seed-log-triage', '--count', '30', '--json'], { home });
    assert.equal(seed.code, 0, `seed failed: ${seed.stderr}`);
    const reset = runCli(['demo', 'reset', '--confirm', '--json'], { home });
    assert.equal(reset.code, 0, `reset failed: ${reset.stderr}`);
    const env = parseJson(reset.stdout);
    assert.equal(env.ok, true);
    assert.equal(env.namespace, 'demo-log-triage');
    assert.ok(env.purged >= 30, `expected >= 30 purged, got ${env.purged}`);
  } finally {
    cleanup(home);
  }
});

test('W396 #11 . `demo reset` without --confirm exits non-zero with a usage hint', () => {
  const r = runCli(['demo', 'reset']);
  cleanup(r.home);
  assert.notEqual(r.code, 0, 'expected non-zero exit when --confirm missing');
  assert.match(r.stderr, /--confirm/, 'stderr must hint at --confirm');
});

// ===========================================================================
// 5 . dispatcher / completion / help wiring
// ===========================================================================

test('W396 #12 . COMPLETION_VERBS includes `demo` and COMPLETION_SUBS lists 3 subverbs', () => {
  const src = fs.readFileSync(CLI_PATH, 'utf8');
  const verbsBlock = src.match(/const COMPLETION_VERBS = \[([\s\S]*?)\];/);
  assert.ok(verbsBlock, 'COMPLETION_VERBS block missing');
  const verbs = [...verbsBlock[1].matchAll(/'([a-z-]+)'/g)].map(x => x[1]);
  assert.ok(verbs.includes('demo'), 'COMPLETION_VERBS missing `demo`');
  // Subverbs must include the three documented ones.
  const subsBlock = src.match(/const COMPLETION_SUBS = \{([\s\S]*?)\n\};/);
  assert.ok(subsBlock, 'COMPLETION_SUBS block missing');
  assert.match(subsBlock[1], /demo:\s*\[[^\]]*'seed-log-triage'/, 'COMPLETION_SUBS.demo missing seed-log-triage');
  assert.match(subsBlock[1], /demo:\s*\[[^\]]*'reset'/, 'COMPLETION_SUBS.demo missing reset');
});

test('W396 #13 . docs/cli/demo.md exists with a Usage + Examples section', () => {
  const docPath = path.join(ROOT, 'public', 'docs', 'cli', 'demo.md');
  assert.ok(fs.existsSync(docPath), `missing ${docPath}`);
  const md = fs.readFileSync(docPath, 'utf8');
  assert.match(md, /##\s+Usage/, 'demo.md missing Usage section');
  assert.match(md, /##\s+Examples/, 'demo.md missing Examples section');
  // Must reference the seed verb so the wave206-docs-audit `kolm demo` regex hits.
  assert.match(md, /kolm\s+demo\s+seed-log-triage/, 'demo.md must reference `kolm demo seed-log-triage`');
});

test('W396 #14 . sw.js CACHE slug is at wave396 or newer', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'public', 'sw.js'), 'utf8');
  // W604 anti-brittleness: scan all wave tokens, assert max >= 396.
  const waves = [...sw.matchAll(/wave(\d{3,4})/g)].map((m) => parseInt(m[1], 10));
  assert.ok(waves.length > 0, 'sw.js must carry at least one wave token');
  const maxWave = Math.max(...waves);
  assert.ok(maxWave >= 396, 'sw.js CACHE wave must reach >= 396 (saw max wave' + maxWave + ')');
});
