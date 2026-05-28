#!/usr/bin/env node
// Smoke for src/adversarial-eval.js + the eval_adapter.py --bench adversarial
// path. State is isolated under a fresh KOLM_DATA_DIR so the real ~/.kolm store
// is never touched. Prints "N passed, M failed"; exits nonzero on any failure.
//
// Set KOLM_DATA_DIR BEFORE importing anything that reads it (event-store.js
// caches the root on first call).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-adv-smoke-'));
process.env.KOLM_DATA_DIR = TMP;

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ' — ' + detail : ''}`);
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function skip(name, why) {
  skipped += 1;
  console.log(`  SKIP  ${name} — ${why}`);
}

const modUrl = pathToFileURL(path.resolve('src/adversarial-eval.js')).href;
const {
  ADVERSARIAL_VERSION,
  generateAdversarialSet,
  recordAdversarialGap,
  buildProbes,
} = await import(modUrl);

ok('ADVERSARIAL_VERSION is adv-v1', ADVERSARIAL_VERSION === 'adv-v1', `got ${ADVERSARIAL_VERSION}`);

// ---------------------------------------------------------------------------
// Test 1 — generateAdversarialSet with 2 weak clusters.
// ---------------------------------------------------------------------------
const weak = [
  { cluster_id: 'c1', label: 'refund window edge cases' },
  'shipping address ambiguity',
];
const gen = await generateAdversarialSet({
  namespace: 'smoke',
  weak_clusters: weak,
});

ok('generateAdversarialSet ok envelope', gen && gen.ok === true && gen.version === 'adv-v1',
  JSON.stringify(gen));
ok('bench_file exists', !!gen.bench_file && fs.existsSync(gen.bench_file), gen.bench_file);

let lines = [];
if (gen.bench_file && fs.existsSync(gen.bench_file)) {
  lines = fs.readFileSync(gen.bench_file, 'utf8').split('\n').filter((l) => l.trim());
}
ok('n_questions >= 10', gen.n_questions >= 10, `n_questions=${gen.n_questions}`);
ok('n_questions matches written lines', gen.n_questions === lines.length,
  `n_questions=${gen.n_questions} lines=${lines.length}`);

const suppliedIds = new Set(['c1', 'shipping address ambiguity']);
let allValidJson = true;
let allReferenceSupplied = true;
for (const ln of lines) {
  let row;
  try { row = JSON.parse(ln); } catch { allValidJson = false; continue; }
  if (!row || typeof row.question !== 'string' || !row.question) allValidJson = false;
  if (!suppliedIds.has(row.cluster_id)) allReferenceSupplied = false;
}
ok('every line is valid JSON with a question', allValidJson);
ok('every line references a supplied cluster', allReferenceSupplied);
ok('clusters_covered === 2', gen.clusters_covered === 2, `clusters_covered=${gen.clusters_covered}`);

// ---------------------------------------------------------------------------
// Test 2 — buildProbes returns distinct non-empty probes mentioning the label.
// ---------------------------------------------------------------------------
const probes = buildProbes({ cluster_id: 'c1', label: 'refund window edge cases' });
const probesNonEmpty = Array.isArray(probes) && probes.length > 0 && probes.every((p) => typeof p === 'string' && p.trim().length > 0);
ok('buildProbes returns non-empty probe strings', probesNonEmpty, `len=${probes && probes.length}`);
ok('buildProbes probes are distinct', probesNonEmpty && new Set(probes).size === probes.length,
  `distinct=${probes ? new Set(probes).size : 0} total=${probes ? probes.length : 0}`);
ok('buildProbes probes mention the cluster label',
  probesNonEmpty && probes.every((p) => p.includes('refund window edge cases')));

// ---------------------------------------------------------------------------
// Test 3 — recordAdversarialGap(0.9, 0.6) -> gap ~= 0.3.
// ---------------------------------------------------------------------------
const gapRes = await recordAdversarialGap({
  namespace: 'smoke',
  standard_score: 0.9,
  adversarial_score: 0.6,
});
ok('recordAdversarialGap ok envelope', gapRes && gapRes.ok === true && gapRes.version === 'adv-v1',
  JSON.stringify(gapRes));
ok('gap ~= 0.3', gapRes && Math.abs(gapRes.gap - 0.3) < 1e-6, `gap=${gapRes && gapRes.gap}`);

// ---------------------------------------------------------------------------
// Test 4 — Python compile gate.
// ---------------------------------------------------------------------------
const PY = process.env.KOLM_PYTHON || 'python';
const pyFile = path.resolve('workers/distill/scripts/eval_adapter.py');
let pyAvailable = true;
const compile = spawnSync(PY, ['-m', 'py_compile', pyFile], { encoding: 'utf8' });
if (compile.error && compile.error.code === 'ENOENT') {
  pyAvailable = false;
  skip('eval_adapter.py py_compile', `python not found (${PY})`);
} else {
  ok('eval_adapter.py py_compile exit 0', compile.status === 0,
    `status=${compile.status} stderr=${(compile.stderr || '').trim().slice(0, 300)}`);
}

// ---------------------------------------------------------------------------
// Test 5 — best-effort: run the adversarial bench end-to-end (no model, local
// judge) and assert numeric mean_score. Skip (not fail) if python/import fails.
// ---------------------------------------------------------------------------
if (!pyAvailable) {
  skip('eval_adapter.py --bench adversarial', 'python not available');
} else if (!gen.bench_file || !fs.existsSync(gen.bench_file)) {
  skip('eval_adapter.py --bench adversarial', 'no bench file from test 1');
} else {
  const benchOut = path.join(TMP, 'eval-adversarial.json');
  const run = spawnSync(PY, [
    pyFile,
    '--pairs', gen.bench_file,        // ignored on the bench path, but --pairs is required
    '--bench', 'adversarial',
    '--bench-file', gen.bench_file,
    '--bench-out', benchOut,
    '--judge-vendor', 'local',
  ], { encoding: 'utf8' });

  const combined = `${run.stdout || ''}\n${run.stderr || ''}`;
  // A missing scientific-python dep (torch/transformers/etc.) surfaces as an
  // ImportError/ModuleNotFoundError at module import — count that as a skip.
  const importFail = /ModuleNotFoundError|ImportError|No module named/i.test(combined);
  if (importFail && run.status !== 0) {
    skip('eval_adapter.py --bench adversarial', `import failure: ${combined.trim().slice(0, 200)}`);
  } else if (run.status !== 0) {
    ok('eval_adapter.py --bench adversarial exit 0', false,
      `status=${run.status} ${combined.trim().slice(0, 300)}`);
  } else {
    ok('eval_adapter.py --bench adversarial exit 0', true);
    let summary = null;
    try { summary = JSON.parse(fs.readFileSync(benchOut, 'utf8')); } catch (e) { /* handled below */ }
    ok('bench-out is valid JSON', !!summary, benchOut);
    ok('mean_score is numeric', summary && typeof summary.mean_score === 'number',
      `mean_score=${summary && summary.mean_score}`);
    ok('bench === adversarial', summary && summary.bench === 'adversarial',
      `bench=${summary && summary.bench}`);
    ok('n is numeric', summary && typeof summary.n === 'number', `n=${summary && summary.n}`);
  }
}

// ---------------------------------------------------------------------------
// Cleanup + report.
// ---------------------------------------------------------------------------
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* deliberate: best-effort */ }

console.log('');
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log('  - ' + f);
}
console.log(`${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failed > 0 ? 1 : 0);
