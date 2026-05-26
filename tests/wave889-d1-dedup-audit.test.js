// W889-D1 — Blocks 1-5 dedup audit lock-ins.
//
// Locks: each block's audit JSON exists with the right item count, every item
// is either shipped or patched (no missing), the roll-up sums correctly, the
// Block 2 --dry-run patch is callable, and the Block 1.5 Trinity publish stub
// gates on KOLM_HF_TOKEN.
//
// Constraints (USER-MANDATED, non-negotiable):
//   - Do not use the forbidden h-word in test strings. Use Caveats /
//     Constraints / Limitations.
//   - No emojis.
//   - Single-process (concurrency=1) so the CLI spawn paths do not race.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO = path.resolve(__dirname, '..');

const AUDIT_PATHS = [
  path.join(REPO, 'data', 'w889-block-1-audit.json'),
  path.join(REPO, 'data', 'w889-block-2-audit.json'),
  path.join(REPO, 'data', 'w889-block-3-audit.json'),
  path.join(REPO, 'data', 'w889-block-4-audit.json'),
  path.join(REPO, 'data', 'w889-block-5-audit.json'),
];

const EXPECTED_ITEM_COUNTS = { 1: 5, 2: 1, 3: 5, 4: 1, 5: 4 };
const TOTAL_ITEMS = Object.values(EXPECTED_ITEM_COUNTS).reduce((a, b) => a + b, 0);

const VALID_STATUSES = new Set(['shipped', 'patched', 'missing']);

const CLI = path.join(REPO, 'cli', 'kolm.js');
const PUBLISH_STUB = path.join(REPO, 'scripts', 'w889-1.5-trinity-publish.cjs');

function readAudit(p) {
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

// ─── #1: every audit JSON exists ─────────────────────────────────────────────
test('W889-D1 #1: all 5 audit JSONs exist on disk', () => {
  for (const p of AUDIT_PATHS) {
    assert.ok(fs.existsSync(p), `audit JSON missing: ${p}`);
  }
});

// ─── #2: item counts per block ───────────────────────────────────────────────
test('W889-D1 #2: each audit JSON has the correct items array length', () => {
  for (const p of AUDIT_PATHS) {
    const a = readAudit(p);
    const expected = EXPECTED_ITEM_COUNTS[a.block_number];
    assert.strictEqual(
      a.items.length, expected,
      `block ${a.block_number}: expected ${expected} items, got ${a.items.length}`,
    );
  }
});

// ─── #3: every item has a valid status; nothing is missing ───────────────────
test('W889-D1 #3: every item is shipped or patched (no missing)', () => {
  for (const p of AUDIT_PATHS) {
    const a = readAudit(p);
    for (const item of a.items) {
      assert.ok(item.id, `block ${a.block_number}: item missing id`);
      assert.ok(item.description, `${item.id}: missing description`);
      assert.ok(VALID_STATUSES.has(item.status),
        `${item.id}: status '${item.status}' not in {shipped, patched, missing}`);
      assert.notStrictEqual(item.status, 'missing',
        `${item.id}: status is 'missing' — every Block 1-5 item must be shipped or patched`);
      assert.ok(item.evidence, `${item.id}: missing evidence string`);
    }
  }
});

// ─── #4: roll-up sums match across all 5 blocks ──────────────────────────────
test('W889-D1 #4: roll-up totals 16 items, 0 missing', () => {
  let shipped = 0, patched = 0, missing = 0;
  for (const p of AUDIT_PATHS) {
    const a = readAudit(p);
    for (const item of a.items) {
      if (item.status === 'shipped') shipped += 1;
      else if (item.status === 'patched') patched += 1;
      else if (item.status === 'missing') missing += 1;
    }
  }
  const total = shipped + patched + missing;
  assert.strictEqual(total, TOTAL_ITEMS,
    `total ${total} != expected ${TOTAL_ITEMS}`);
  assert.strictEqual(missing, 0, `missing_count must be 0, got ${missing}`);
  assert.ok(shipped + patched === TOTAL_ITEMS,
    `shipped (${shipped}) + patched (${patched}) must equal total (${TOTAL_ITEMS})`);
});

// ─── #5: Block 2 --dry-run patch is callable + exits 0 ───────────────────────
test('W889-D1 #5: kolm bench --all-targets --dry-run exits 0 + emits valid envelope', () => {
  const r = spawnSync(process.execPath, [CLI, 'bench', '--all-targets', '--dry-run', '--json'], {
    cwd: REPO, encoding: 'utf8', timeout: 30000,
  });
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}; stderr: ${r.stderr}`);
  const env = JSON.parse(r.stdout);
  assert.strictEqual(env.ok, true);
  assert.strictEqual(env.dry_run, true);
  assert.strictEqual(env.n_targets, 0);
  assert.deepStrictEqual(env.rows, []);
  // MCD directive: comparison table with K-Score, latency p50/p95, cost.
  assert.ok(env.columns.includes('k_score'));
  assert.ok(env.columns.includes('latency_p50_ms'));
  assert.ok(env.columns.includes('latency_p95_ms'));
  assert.ok(env.columns.includes('cost_per_1k_usd'));
});

// ─── #6: Trinity-500 publish stub gates on KOLM_HF_TOKEN ─────────────────────
test('W889-D1 #6: Trinity-500 publish stub exits non-zero without KOLM_HF_TOKEN', () => {
  assert.ok(fs.existsSync(PUBLISH_STUB), `stub missing: ${PUBLISH_STUB}`);
  // Scrub both env vars so the gate has nothing to fall back to.
  const env = { ...process.env };
  delete env.KOLM_HF_TOKEN;
  delete env.HF_TOKEN;
  const r = spawnSync(process.execPath, [PUBLISH_STUB], {
    cwd: REPO, encoding: 'utf8', env, timeout: 10000,
  });
  assert.notStrictEqual(r.status, 0,
    `stub should exit non-zero without KOLM_HF_TOKEN, got status=${r.status}`);
  assert.match(r.stderr, /KOLM_HF_TOKEN/,
    'stub stderr must mention KOLM_HF_TOKEN by name');
});

// ─── #7: Block 1 — Ollama Modelfile generator surfaces FROM stanza ───────────
test('W889-D1 #7: src/export-ollama.js generateModelfile emits FROM', async () => {
  const url = path.join(REPO, 'src', 'export-ollama.js');
  const mod = await import('file://' + url.replace(/\\/g, '/'));
  const body = mod.generateModelfile({
    artifact: {
      name: 'audit-test',
      artifact_hash: 'sha256:dead',
      base_model: 'Qwen/Qwen2.5-7B-Instruct',
      license: 'apache-2.0',
      passport: {},
    },
    ggufPath: '/tmp/model.gguf',
  });
  assert.match(body, /^FROM /m, 'Modelfile must contain a FROM stanza');
});

// ─── #8: Block 3 — kolm fleet status exits 0 ─────────────────────────────────
test('W889-D1 #8: kolm fleet status --json exits 0', () => {
  const r = spawnSync(process.execPath, [CLI, 'fleet', 'status', '--json'], {
    cwd: REPO, encoding: 'utf8', timeout: 15000,
  });
  assert.strictEqual(r.status, 0, `fleet status failed: ${r.stderr}`);
  const env = JSON.parse(r.stdout);
  assert.strictEqual(env.ok, true);
  assert.ok(Array.isArray(env.fleet), 'fleet must be array');
});

// ─── #9: Block 4 — Colab notebook + UI link both exist ───────────────────────
test('W889-D1 #9: Colab notebook + UI link exist', () => {
  const nb = path.join(REPO, 'examples', 'colab-compile.ipynb');
  assert.ok(fs.existsSync(nb), `Colab notebook missing: ${nb}`);
  const compileHtml = path.join(REPO, 'public', 'studio', 'compile.html');
  const html = fs.readFileSync(compileHtml, 'utf8');
  assert.match(html, /colab\.research\.google\.com/,
    'public/studio/compile.html must surface the Colab UI link');
});

// ─── #10: Block 5 — assistant shim returns deterministic envelope ────────────
test('W889-D1 #10: KOLM_ASSISTANT_TEST_SHIM=1 returns ok:true envelope', () => {
  const r = spawnSync(process.execPath, [
    CLI, 'assistant', 'run', 'what is k-score?', '--json',
  ], {
    cwd: REPO,
    env: { ...process.env, KOLM_ASSISTANT_TEST_SHIM: '1' },
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.strictEqual(r.status, 0, `assistant run failed: ${r.stderr}`);
  const env = JSON.parse(r.stdout);
  assert.strictEqual(env.ok, true);
  assert.strictEqual(env.source, 'local');
  assert.ok(Array.isArray(env.fallback_chain));
  assert.ok(env.fallback_chain.length >= 1);
});
