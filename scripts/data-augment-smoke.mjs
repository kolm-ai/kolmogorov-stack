// scripts/data-augment-smoke.mjs
//
// Smoke test for src/data-augment.js (KOLM DATA ENGINE — AUGMENT stage).
//
// State is isolated into a fresh temp dir via KOLM_DATA_DIR so the test never
// touches the developer's real ~/.kolm. Prints "N passed, M failed" and exits
// nonzero on any failure.
//
// Run: node scripts/data-augment-smoke.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate state BEFORE importing the module (the module reads KOLM_DATA_DIR
// lazily at call time, but set it up front to be safe).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-augment-smoke-'));
process.env.KOLM_DATA_DIR = TMP;

const {
  augment,
  appendFixPairs,
  previewCost,
  AUGMENT_VERSION,
} = await import('../src/data-augment.js');

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function pathFor(ns) {
  return path.join(TMP, '.kolm', 'data', ns, 'augment-pairs.jsonl');
}

function readLines(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

console.log(`data-augment smoke (version=${AUGMENT_VERSION}, KOLM_DATA_DIR=${TMP})`);

// 1. gap-fill with two zero-example categories.
{
  const ns = 'ns-gapfill';
  const res = await augment({
    namespace: ns,
    strategy: 'gap-fill',
    opts: { categories: ['returns', 'billing'], apply: false },
  });
  const refs = (res.candidates || []).map((c) => c.input).join('\n').toLowerCase();
  check('1. gap-fill ok envelope', res.ok === true && res.version === AUGMENT_VERSION, JSON.stringify(res.error));
  check('1. gap-fill n_candidates>=2', res.n_candidates >= 2, `got ${res.n_candidates}`);
  check('1. gap-fill references returns+billing', refs.includes('returns') && refs.includes('billing'));
}

// 2. evol on 2 seed prompts.
{
  const ns = 'ns-evol';
  const seeds = [
    { id: 's1', input: 'How do I reset my password?', output: 'Use the reset link.' },
    { id: 's2', input: 'Where is my order?', output: 'Track it in your account.' },
  ];
  const res = await augment({ namespace: ns, strategy: 'evol', seedPairs: seeds, opts: { apply: false } });
  const seedSet = new Set(seeds.map((s) => s.input));
  const allDiffer = (res.candidates || []).every((c) => !seedSet.has(c.input));
  check('2. evol ok', res.ok === true, JSON.stringify(res.error));
  check('2. evol n_candidates>=2', res.n_candidates >= 2, `got ${res.n_candidates}`);
  check('2. evol each variant differs from seed', allDiffer);
}

// 3. persona on 1 seed with 3 personas.
{
  const ns = 'ns-persona';
  const res = await augment({
    namespace: ns,
    strategy: 'persona',
    seedPairs: [{ id: 'p1', input: 'Cancel my subscription.' }],
    opts: { personas: ['an angry customer', 'a developer', 'a CFO'], apply: false },
  });
  check('3. persona ok', res.ok === true, JSON.stringify(res.error));
  check('3. persona 3 candidates', res.n_candidates === 3, `got ${res.n_candidates}`);
}

// 4. adversarial on 1 seed.
{
  const ns = 'ns-adv';
  const res = await augment({
    namespace: ns,
    strategy: 'adversarial',
    seedPairs: [{ id: 'a1', input: 'Refund my last charge.' }],
    opts: { apply: false },
  });
  check('4. adversarial ok', res.ok === true, JSON.stringify(res.error));
  check('4. adversarial >=1 candidate', res.n_candidates >= 1, `got ${res.n_candidates}`);
}

// 5. apply:false writes nothing; apply:true writes the file and wrote===true.
{
  const ns = 'ns-apply';
  const p = pathFor(ns);
  const preview = await augment({
    namespace: ns,
    strategy: 'gap-fill',
    opts: { categories: ['shipping'], apply: false },
  });
  check('5. apply:false wrote===false', preview.wrote === false);
  check('5. apply:false file absent', !fs.existsSync(p), `file unexpectedly exists at ${p}`);

  const applied = await augment({
    namespace: ns,
    strategy: 'gap-fill',
    opts: { categories: ['shipping'], apply: true },
  });
  const lines = readLines(p);
  const shapeOk = lines.length > 0 && lines.every(
    (r) => r.id && r.source_type === 'augment' && r.provenance && r.provenance.strategy === 'gap-fill'
      && typeof r.output === 'string',
  );
  check('5. apply:true wrote===true', applied.wrote === true);
  check('5. apply:true file written with canonical shape', fs.existsSync(p) && shapeOk, `lines=${lines.length}`);
}

// 6. previewCost returns a finite est_cost_usd >= 0.
{
  const fake = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, input: 'x', output: '' }));
  const pc = previewCost(fake, {});
  check('6. previewCost finite est_cost_usd>=0', Number.isFinite(pc.est_cost_usd) && pc.est_cost_usd >= 0, JSON.stringify(pc));
  check('6. previewCost n matches', pc.n === 10, `got ${pc.n}`);
}

// 7. appendFixPairs appends 1 line with provenance.strategy==='failure-fix'.
{
  const ns = 'ns-fix';
  const p = pathFor(ns);
  const res = await appendFixPairs({
    namespace: ns,
    fix_pairs: [{ input: 'x', output: 'y', rationale: 'z' }],
  });
  const lines = readLines(p);
  check('7. appendFixPairs ok n_written===1', res.ok === true && res.n_written === 1, JSON.stringify(res));
  check('7. appendFixPairs 1 line appended', lines.length === 1, `got ${lines.length}`);
  check('7. appendFixPairs provenance.strategy===failure-fix',
    lines.length === 1 && lines[0].provenance && lines[0].provenance.strategy === 'failure-fix',
    JSON.stringify(lines[0]));
  check('7. appendFixPairs preserves output', lines.length === 1 && lines[0].output === 'y');
}

// Cleanup (best-effort).
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log('');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
