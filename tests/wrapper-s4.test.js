// tests/wrapper-s4.test.js
//
// S-4 (V1 launch) lock-in tests for the multi-model benchmark harness.
//
// Coverage:
//   1. listSuites() returns all four built-in suites with the documented IDs.
//   2. validateSuite() accepts every built-in suite without errors.
//   3. validateSuite() rejects an obviously-malformed suite (unknown metric,
//      missing prompts, bad id).
//   4. resolveModelTarget() can build a fake target with deterministic output.
//   5. runBench() in dry-run mode produces rows + a markdown report matching
//      the W869 model-rows-x-metric-columns shape.
//   6. buildMarkdownReport() produces the canonical header + table + Caveats
//      section + correct number of rows.
//   7. runBench() against a fake adapter returns canned-shape rows (no API
//      keys involved).
//   8. runBench() writes JSON + Markdown artifacts when outDir is supplied.
//
// All tests are pure compute or filesystem — no network, no API keys, no
// child processes. They run on every `npm test` without an opt-in flag.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const SUITES_MODULE = path.join(REPO_ROOT, 'src', 'bench-eval-suites.js');
const HARNESS_MODULE = path.join(REPO_ROOT, 'src', 'bench-harness.js');

// All four built-in suites required by the S-4 spec.
const REQUIRED_SUITE_IDS = [
  'support-clarity-57',
  'reasoning-deepseek-50',
  'gateway-overhead-100',
  'pii-redaction-30',
];

// ---------------------------------------------------------------------------
// Suite registry tests.
// ---------------------------------------------------------------------------

test('S-4 #1: listSuites returns all four built-in suite IDs', async () => {
  assert.ok(fs.existsSync(SUITES_MODULE), 'bench-eval-suites.js must exist');
  const { listSuites, BUILT_IN_SUITE_IDS } = await import('../src/bench-eval-suites.js');
  const suites = listSuites();
  assert.ok(Array.isArray(suites), 'listSuites must return an array');
  assert.equal(suites.length, REQUIRED_SUITE_IDS.length, `expected ${REQUIRED_SUITE_IDS.length} suites, got ${suites.length}`);
  const ids = suites.map((s) => s.id).sort();
  assert.deepEqual(ids, REQUIRED_SUITE_IDS.slice().sort(), 'every required suite id must be present');
  assert.deepEqual([...BUILT_IN_SUITE_IDS].sort(), REQUIRED_SUITE_IDS.slice().sort(), 'BUILT_IN_SUITE_IDS must match');
  // Each suite manifest carries the contracted fields.
  for (const s of suites) {
    assert.ok(typeof s.description === 'string' && s.description.length > 0, `${s.id} missing description`);
    assert.ok(Number.isInteger(s.n_prompts) && s.n_prompts > 0, `${s.id} must have prompts (got n=${s.n_prompts})`);
    assert.ok(Array.isArray(s.metrics) && s.metrics.length > 0, `${s.id} must have metrics`);
  }
});

test('S-4 #2: validateSuite accepts every built-in suite', async () => {
  const { listSuites, getSuite, validateSuite } = await import('../src/bench-eval-suites.js');
  for (const meta of listSuites()) {
    const suite = getSuite(meta.id);
    const v = validateSuite(suite);
    assert.equal(v.ok, true, `${meta.id} failed validation: ${JSON.stringify(v.errors)}`);
    assert.deepEqual(v.errors, [], `${meta.id} reported errors despite ok:true`);
  }
});

test('S-4 #3: validateSuite rejects malformed suites with explicit errors', async () => {
  const { validateSuite } = await import('../src/bench-eval-suites.js');
  // Non-object.
  const r0 = validateSuite(null);
  assert.equal(r0.ok, false);
  assert.ok(r0.errors.length > 0, 'null suite must produce errors');
  // Bad id.
  const r1 = validateSuite({ id: 'Bad ID!', description: 'x', prompts: [{ id: 'p1', text: 't' }], metrics: ['mean_ms'] });
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => /id/.test(e)), `expected id error, got ${r1.errors.join(', ')}`);
  // Unknown metric.
  const r2 = validateSuite({ id: 'good-id', description: 'x', prompts: [{ id: 'p1', text: 't' }], metrics: ['unknown_metric'] });
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => /unknown metric/.test(e)), `expected unknown-metric error, got ${r2.errors.join(', ')}`);
  // No prompts.
  const r3 = validateSuite({ id: 'good-id', description: 'x', prompts: [], metrics: ['mean_ms'] });
  assert.equal(r3.ok, false);
  assert.ok(r3.errors.some((e) => /prompts/.test(e)), 'expected prompts error');
  // Duplicate prompt id.
  const r4 = validateSuite({
    id: 'good-id', description: 'x',
    prompts: [{ id: 'p1', text: 't1' }, { id: 'p1', text: 't2' }],
    metrics: ['mean_ms'],
  });
  assert.equal(r4.ok, false);
  assert.ok(r4.errors.some((e) => /duplicate/.test(e)), 'expected duplicate-id error');
});

// ---------------------------------------------------------------------------
// Harness target resolution + dry-run end-to-end.
// ---------------------------------------------------------------------------

test('S-4 #4: resolveModelTarget builds a fake target with deterministic output', async () => {
  assert.ok(fs.existsSync(HARNESS_MODULE), 'bench-harness.js must exist');
  const { resolveModelTarget } = await import('../src/bench-harness.js');
  const t = resolveModelTarget('fake:canned');
  assert.equal(t.transport, 'fake');
  assert.equal(typeof t.send, 'function');
  const r1 = await t.send('Where is my order?');
  const r2 = await t.send('Where is my order?');
  assert.equal(typeof r1.text, 'string');
  assert.equal(typeof r1.ms, 'number');
  // Latency is deterministic by content+tag for the fake adapter.
  assert.equal(r1.ms, r2.ms, 'fake adapter must be deterministic across calls');
  assert.ok(r1.in_tok > 0 && r1.out_tok > 0, 'token counts must be positive');
});

test('S-4 #5: runBench dry-run produces rows + markdown in W869 shape', async () => {
  const { runBench } = await import('../src/bench-harness.js');
  const out = await runBench({
    suiteId: 'support-clarity-57',
    models: ['fake:trinity-500', 'fake:claude-haiku-4-5'],
    n: 5,
    dry_run: true,
    timestamp: '2026-05-26T00:00:00.000Z',
  });
  assert.equal(out.suite.id, 'support-clarity-57');
  assert.equal(out.suite.n, 5);
  assert.equal(out.dry_run, true);
  assert.ok(Array.isArray(out.models), 'out.models must be an array');
  assert.equal(out.models.length, 2, 'expected 2 model rows');
  for (const row of out.models) {
    assert.equal(typeof row.id, 'string');
    assert.ok(Number.isFinite(row.mean_ms), `${row.id} must have mean_ms`);
    assert.ok(Number.isFinite(row.p50_ms),  `${row.id} must have p50_ms`);
    assert.ok(Number.isFinite(row.p95_ms),  `${row.id} must have p95_ms`);
    assert.ok(Number.isFinite(row.mean_chars), `${row.id} must have mean_chars`);
    // Behavior rates are in [0,1].
    for (const m of ['asks_one_question_rate', 'judge_clarify_rate', 'judge_on_policy_rate']) {
      assert.ok(row[m] >= 0 && row[m] <= 1, `${row.id}.${m} must be in [0,1] (got ${row[m]})`);
    }
  }
  // Markdown report sanity.
  assert.ok(typeof out.comparison_md === 'string' && out.comparison_md.length > 0);
  assert.ok(out.comparison_md.includes('| model |'), 'markdown must have model column header');
  assert.ok(out.comparison_md.includes('## Caveats'), 'markdown must have Caveats section');
  assert.ok(out.comparison_md.includes('dry-run'), 'dry-run mode must be flagged in the markdown');
  // No emojis.
  // Check for common emoji ranges (rough — bench output must stay plain text).
  assert.equal(/\p{Extended_Pictographic}/u.test(out.comparison_md), false, 'markdown must not contain emojis');
  // No forbidden h-word in output (user-mandated linguistic constraint).
  assert.equal(/\bh[o]nest(y)?\b/i.test(out.comparison_md), false, 'markdown must not contain the forbidden h-word');
});

test('S-4 #6: buildMarkdownReport renders header + rows + caveats', async () => {
  const { buildMarkdownReport } = await import('../src/bench-harness.js');
  const suite = {
    id: 'unit-suite',
    description: 'unit test suite',
    metrics: ['mean_ms', 'p95_ms', 'cost_per_1k_usd'],
    prompts: [],
  };
  const rows = [
    { id: 'trinity-500',        mean_ms: 1240, p95_ms: 1450, cost_per_1k_usd: 0 },
    { id: 'claude-haiku-4-5',   mean_ms: 1774, p95_ms: 2642, cost_per_1k_usd: 0.301 },
  ];
  const md = buildMarkdownReport({ rows, suite, n: 10, ts: '2026-05-26T00:00:00.000Z' });
  // Title
  assert.ok(md.startsWith('# unit-suite comparison -'), 'title must start with suite id');
  // Header
  assert.ok(md.includes('| model | mean_ms (ms) | p95_ms (ms) | cost_per_1k_usd (usd) |'), 'header must include all metric columns');
  // Row data
  assert.ok(md.includes('| trinity-500 |'));
  assert.ok(md.includes('| claude-haiku-4-5 |'));
  // Caveats present
  assert.ok(md.includes('## Caveats'));
  // Cost formatted with dollar sign.
  assert.ok(md.includes('$0.3010'), `expected $0.3010 in markdown, got: ${md}`);
});

test('S-4 #7: runBench against a fake adapter rejects empty models[]', async () => {
  const { runBench } = await import('../src/bench-harness.js');
  await assert.rejects(
    () => runBench({ suiteId: 'support-clarity-57', models: [], dry_run: true }),
    /models\[\] must be a non-empty array/,
  );
});

test('S-4 #8: runBench unknown suite rejects with explicit error', async () => {
  const { runBench } = await import('../src/bench-harness.js');
  await assert.rejects(
    () => runBench({ suiteId: 'does-not-exist', models: ['fake:x'], dry_run: true }),
    /unknown suite/,
  );
});

test('S-4 #9: runBench writes JSON + Markdown when outDir supplied', async () => {
  const { runBench } = await import('../src/bench-harness.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-bench-s4-'));
  try {
    const out = await runBench({
      suiteId: 'gateway-overhead-100',
      models: ['fake:a', 'fake:b'],
      n: 3,
      dry_run: true,
      outDir: tmp,
      timestamp: '2026-05-26T00:00:00.000Z',
    });
    assert.ok(out.comparison_json_path && fs.existsSync(out.comparison_json_path), 'JSON file should exist');
    assert.ok(out.comparison_md_path && fs.existsSync(out.comparison_md_path),     'Markdown file should exist');
    const jsonRaw = JSON.parse(fs.readFileSync(out.comparison_json_path, 'utf8'));
    assert.equal(jsonRaw.spec, 'kolm-bench-compare-1');
    assert.equal(jsonRaw.suite.id, 'gateway-overhead-100');
    assert.equal(jsonRaw.suite.n, 3);
    assert.equal(jsonRaw.dry_run, true);
    assert.ok(Array.isArray(jsonRaw.models) && jsonRaw.models.length === 2);
    assert.ok(jsonRaw.per_model_samples && typeof jsonRaw.per_model_samples === 'object');
    // Per-model samples were captured.
    for (const r of jsonRaw.models) {
      assert.ok(Array.isArray(jsonRaw.per_model_samples[r.id]), `samples missing for ${r.id}`);
      assert.equal(jsonRaw.per_model_samples[r.id].length, 3);
    }
    const mdRaw = fs.readFileSync(out.comparison_md_path, 'utf8');
    assert.ok(mdRaw.includes('gateway-overhead-100'), 'markdown file must reference suite id');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* best-effort cleanup */ }
  }
});

// ---------------------------------------------------------------------------
// Adapter contract — every transport string resolves and exposes send().
// ---------------------------------------------------------------------------

test('S-4 #10: every transport prefix produces a target with send()', async () => {
  const { resolveModelTarget } = await import('../src/bench-harness.js');
  const cases = [
    'fake:x',
    'gateway:claude-haiku-4-5',
    'gguf:/tmp/does-not-exist.gguf',
    'ollama:llama3.2:1b',
    'vllm:meta-llama/Llama-3.1-8B',
    'local-kolm:trinity-500',
    'claude-haiku-4-5',          // bare → anthropic
    'gpt-4o-mini',                // bare → openai
    'deepseek-chat',              // bare → deepseek
    'gemini-2.5-flash',           // bare → google
    'trinity-500',                // bare alias → gateway
    'unknown-vendor-model-x',     // unknown → falls back without crashing
  ];
  for (const c of cases) {
    const t = resolveModelTarget(c);
    assert.ok(t, `target null for ${c}`);
    assert.equal(typeof t.send, 'function', `send() missing for ${c}`);
    assert.equal(typeof t.id, 'string');
  }
});

// ---------------------------------------------------------------------------
// CLI wiring — the verb must be reachable from cli/kolm.js dispatch.
// ---------------------------------------------------------------------------

test('S-4 #11: CLI wires `kolm bench compare <suite> --models ...`', async () => {
  const cliPath = path.join(REPO_ROOT, 'cli', 'kolm.js');
  const src = fs.readFileSync(cliPath, 'utf8');
  // Look for the S-4 dispatch arm + the harness import. We don't boot the
  // CLI here (that needs the whole runtime); we pin the wiring.
  assert.ok(
    /args\s*\[\s*0\s*\]\s*===?\s*['"]compare['"]/.test(src) || /args\s*&&\s*args\[0\]\s*===?\s*['"]compare['"]/.test(src),
    'cli/kolm.js must dispatch "kolm bench compare" sub-verb',
  );
  assert.ok(
    /bench-harness\.js/.test(src) || /from\s+['"]\.\.\/src\/bench-harness\.js['"]/.test(src) || /bench-harness/.test(src),
    'cli/kolm.js must import the bench-harness module',
  );
});
