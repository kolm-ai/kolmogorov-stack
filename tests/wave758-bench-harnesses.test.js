// W758 — MMLU / HumanEval / MT-Bench harness tests.
//
// Atomic items pinned (matches the W758 implementation):
//
//   1) MMLU_VERSION matches /^w758-/ AND equals 'w758-v1' (W604)
//   2) HUMANEVAL_VERSION matches /^w758-/ AND equals 'w758-v1'
//   3) MTBENCH_VERSION matches /^w758-/ AND equals 'w758-v1'
//   4) MMLU_CATEGORIES len=57 + Object.frozen
//   5) MTBENCH_CATEGORIES len=8 + Object.frozen + canonical order
//   6) parseMMLUCsv parses a tiny fixture incl. quoted comma + escaped quote
//   7) parseHumanEvalJsonl parses tiny JSONL + skips invalid rows
//   8) parseMTBenchJsonl parses tiny JSONL + supports id alias
//   9) loadMMLUPack returns bench_pack_not_local when pack_dir is missing
//  10) loadHumanEvalPack returns bench_pack_not_local when pack_dir is missing
//  11) loadMTBenchPack returns bench_pack_not_local when pack_dir is missing
//  12) runMMLU with seeded pack + DI runOnArtifact returns ok:true + accuracy
//  13) runMMLU without runOnArtifact returns runtime_not_wired envelope
//  14) runHumanEval without sandbox_cmd returns no_code_sandbox_configured
//  15) runHumanEval with sandbox_cmd + DI runOnArtifact returns ok:true + pass_at_1
//  16) runMTBench without judge returns no_judge_model_configured
//  17) runMTBench with judge + DI runOnArtifact returns ok:true + mean_score
//  18) POST /v1/bench/mmlu returns 401 without auth
//  19) POST /v1/bench/humaneval returns 401 without auth
//  20) POST /v1/bench/mtbench returns 401 without auth
//  21) POST /v1/bench/mmlu returns 400 confirm_required when {} body
//  22) public/benchmarks.html has data-w758='external-results' anchor + all
//      3 benchmark rows (MMLU + HumanEval + MT-Bench)
//  23) cli/kolm.js defines cmdW758Bench exactly once AND references it from
//      the cmdBenchmark dispatcher (reachable via case 'bench')
//  24) cli/kolm.js has case 'bench' arm wired (already exists; we verify it
//      is still present so a regression cannot silently break the surface)
//  25) wave758 sibling test count uses regex wave(\d{3,4}) + threshold
//      (W604 anti-brittleness — never an explicit hard-coded sibling list)
//
// W604 anti-brittleness: the version stamp tests use BOTH a regex match
// (/^w758-/) and the literal value pin, so a 1.x bump within the same wave
// keeps the regex assertion green while the literal assertion catches an
// accidental cross-wave version stamp.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  MMLU_VERSION,
  MMLU_PACK_PATH_ENV,
  MMLU_CATEGORIES,
  parseMMLUCsv,
  loadMMLUPack,
  formatMMLUPrompt,
  runMMLU,
} from '../src/eval-mmlu.js';
import {
  HUMANEVAL_VERSION,
  HUMANEVAL_PACK_PATH_ENV,
  parseHumanEvalJsonl,
  loadHumanEvalPack,
  extractCodeFromResponse,
  runHumanEval,
} from '../src/eval-humaneval.js';
import {
  MTBENCH_VERSION,
  MTBENCH_PACK_PATH_ENV,
  MTBENCH_CATEGORIES,
  parseMTBenchJsonl,
  loadMTBenchPack,
  runMTBench,
} from '../src/eval-mtbench.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const TESTS_DIR = __dirname;
const BENCH_HTML = path.join(REPO_ROOT, 'public', 'benchmarks.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');

// Each test seeds an isolated KOLM_DATA_DIR + HOME so the pack lookups
// cannot accidentally hit a real user pack and so the env-var fallbacks
// resolve to a fresh tmpdir.
function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w758-' + crypto.randomBytes(4).toString('hex') + '-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.KOLM_STORE_DRIVER = 'json';
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  // Clear any pack-pointer env vars so the default fallback resolves
  // against the fresh KOLM_HOME — tests stay hermetic.
  delete process.env[MMLU_PACK_PATH_ENV];
  delete process.env[HUMANEVAL_PACK_PATH_ENV];
  delete process.env[MTBENCH_PACK_PATH_ENV];
  return tmp;
}

// =============================================================================
// 1) MMLU_VERSION
// =============================================================================

test('W758 #1 — MMLU_VERSION matches /^w758-/ AND equals w758-v1', () => {
  freshDir();
  assert.ok(/^w758-/.test(MMLU_VERSION),
    `expected /^w758-/; got ${JSON.stringify(MMLU_VERSION)}`);
  assert.equal(MMLU_VERSION, 'w758-v1',
    `initial spec mandates MMLU_VERSION='w758-v1'; got ${JSON.stringify(MMLU_VERSION)}`);
});

// =============================================================================
// 2) HUMANEVAL_VERSION
// =============================================================================

test('W758 #2 — HUMANEVAL_VERSION matches /^w758-/ AND equals w758-v1', () => {
  freshDir();
  assert.ok(/^w758-/.test(HUMANEVAL_VERSION),
    `expected /^w758-/; got ${JSON.stringify(HUMANEVAL_VERSION)}`);
  assert.equal(HUMANEVAL_VERSION, 'w758-v1');
});

// =============================================================================
// 3) MTBENCH_VERSION
// =============================================================================

test('W758 #3 — MTBENCH_VERSION matches /^w758-/ AND equals w758-v1', () => {
  freshDir();
  assert.ok(/^w758-/.test(MTBENCH_VERSION),
    `expected /^w758-/; got ${JSON.stringify(MTBENCH_VERSION)}`);
  assert.equal(MTBENCH_VERSION, 'w758-v1');
});

// =============================================================================
// 4) MMLU_CATEGORIES len=57 + frozen
// =============================================================================

test('W758 #4 — MMLU_CATEGORIES len=57 + frozen', () => {
  freshDir();
  assert.ok(Array.isArray(MMLU_CATEGORIES), 'MMLU_CATEGORIES must be an array');
  assert.equal(MMLU_CATEGORIES.length, 57,
    `expected exactly 57 MMLU subjects (per cais/mmlu); got ${MMLU_CATEGORIES.length}`);
  assert.ok(Object.isFrozen(MMLU_CATEGORIES),
    'MMLU_CATEGORIES must be Object.freeze()d (deliberate breaking-change gate)');
  // Sanity: every entry is a non-empty lowercase string.
  for (const subj of MMLU_CATEGORIES) {
    assert.ok(typeof subj === 'string' && subj.length > 0,
      `MMLU subject must be non-empty string; got ${JSON.stringify(subj)}`);
    assert.ok(subj === subj.toLowerCase(),
      `MMLU subject must be lowercase (HF csv filename convention); got ${subj}`);
  }
});

// =============================================================================
// 5) MTBENCH_CATEGORIES len=8 + frozen + canonical order
// =============================================================================

test('W758 #5 — MTBENCH_CATEGORIES len=8 + frozen + canonical order', () => {
  freshDir();
  assert.ok(Array.isArray(MTBENCH_CATEGORIES), 'MTBENCH_CATEGORIES must be an array');
  assert.equal(MTBENCH_CATEGORIES.length, 8,
    `expected exactly 8 MT-Bench categories; got ${MTBENCH_CATEGORIES.length}`);
  assert.ok(Object.isFrozen(MTBENCH_CATEGORIES), 'MTBENCH_CATEGORIES must be frozen');
  assert.deepEqual(
    MTBENCH_CATEGORIES.slice(),
    ['writing', 'roleplay', 'reasoning', 'math', 'coding', 'extraction', 'stem', 'humanities'],
    'canonical MT-Bench category order pinned (re-order is a deliberate breaking change)',
  );
});

// =============================================================================
// 6) parseMMLUCsv handles a tiny fixture (quoted comma + escaped quote)
// =============================================================================

test('W758 #6 — parseMMLUCsv tiny fixture (quoted comma + escaped quote)', () => {
  freshDir();
  // Row 1: simple
  // Row 2: A field with a comma inside quotes
  // Row 3: A field with an escaped quote (RFC 4180 "")
  const csv =
    'Question 1?,Choice A,Choice B,Choice C,Choice D,A\n' +
    '"Is 2+2,four?","Choice A","Choice B","Choice C","Choice D",B\n' +
    '"He said ""yes""","Yes","No","Maybe","None","C"\n';
  const rows = parseMMLUCsv(csv, 'math');
  assert.equal(rows.length, 3, `expected 3 rows; got ${rows.length}`);
  assert.equal(rows[0].question, 'Question 1?');
  assert.equal(rows[0].answer, 'A');
  assert.equal(rows[0].subject, 'math');
  assert.equal(rows[1].question, 'Is 2+2,four?');
  assert.equal(rows[1].answer, 'B');
  assert.equal(rows[2].question, 'He said "yes"');
  assert.equal(rows[2].answer, 'C');
  // Choices array always length 4.
  for (const r of rows) {
    assert.ok(Array.isArray(r.choices) && r.choices.length === 4);
  }
});

// =============================================================================
// 7) parseHumanEvalJsonl parses + skips invalid rows
// =============================================================================

test('W758 #7 — parseHumanEvalJsonl parses tiny JSONL + skips invalid rows', () => {
  freshDir();
  const jsonl =
    JSON.stringify({
      task_id: 'HumanEval/0',
      prompt: 'def add(a, b):\n    """sum"""\n',
      canonical_solution: '    return a + b',
      test: 'def check(candidate):\n    assert candidate(1,2) == 3',
      entry_point: 'add',
    }) + '\n' +
    '{not json}\n' +                                                           // skipped
    JSON.stringify({ task_id: 'HumanEval/missing_test', prompt: 'p', entry_point: 'x' }) + '\n' + // skipped: no test
    JSON.stringify({
      task_id: 'HumanEval/1',
      prompt: 'def mul(a, b):\n    """product"""\n',
      canonical_solution: '    return a * b',
      test: 'def check(candidate):\n    assert candidate(2,3) == 6',
      entry_point: 'mul',
    }) + '\n';
  const rows = parseHumanEvalJsonl(jsonl);
  assert.equal(rows.length, 2, `expected 2 valid rows (2 skipped); got ${rows.length}`);
  assert.equal(rows[0].task_id, 'HumanEval/0');
  assert.equal(rows[0].entry_point, 'add');
  assert.equal(rows[1].entry_point, 'mul');
});

// =============================================================================
// 8) parseMTBenchJsonl parses + supports id alias
// =============================================================================

test('W758 #8 — parseMTBenchJsonl parses tiny JSONL + supports id alias', () => {
  freshDir();
  const jsonl =
    JSON.stringify({
      question_id: 81,
      category: 'writing',
      turns: ['Write a sonnet.', 'Now rewrite in the style of Yoda.'],
    }) + '\n' +
    JSON.stringify({
      id: 100,                                       // id alias instead of question_id
      category: 'math',
      turns: ['What is 2+2?', 'And 3*4?'],
      reference: ['4', '12'],
    }) + '\n' +
    JSON.stringify({ question_id: 999, category: 'oops', turns: ['only-one-turn'] }) + '\n';  // skipped
  const rows = parseMTBenchJsonl(jsonl);
  assert.equal(rows.length, 2, `expected 2 valid rows (1 skipped for <2 turns); got ${rows.length}`);
  assert.equal(rows[0].question_id, 81);
  assert.equal(rows[0].category, 'writing');
  assert.equal(rows[1].question_id, 100, 'id alias must populate question_id');
  assert.deepEqual(rows[1].reference, ['4', '12']);
});

// =============================================================================
// 9) loadMMLUPack returns bench_pack_not_local
// =============================================================================

test('W758 #9 — loadMMLUPack returns bench_pack_not_local when pack_dir absent', () => {
  freshDir();
  const envelope = loadMMLUPack({ pack_dir: path.join(process.env.KOLM_HOME, 'missing-mmlu') });
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error, 'bench_pack_not_local');
  assert.ok(typeof envelope.hint === 'string' && envelope.hint.includes('huggingface.co/datasets/cais/mmlu'),
    `hint must point at the canonical pack source; got ${JSON.stringify(envelope.hint)}`);
  assert.ok(typeof envelope.expected_path === 'string' && envelope.expected_path.length > 0);
  assert.equal(envelope.version, 'w758-v1');
});

// =============================================================================
// 10) loadHumanEvalPack returns bench_pack_not_local
// =============================================================================

test('W758 #10 — loadHumanEvalPack returns bench_pack_not_local when pack_dir absent', () => {
  freshDir();
  const envelope = loadHumanEvalPack({ pack_dir: path.join(process.env.KOLM_HOME, 'missing-humaneval') });
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error, 'bench_pack_not_local');
  assert.ok(typeof envelope.hint === 'string' && envelope.hint.includes('openai_humaneval'),
    `hint must point at openai_humaneval source; got ${JSON.stringify(envelope.hint)}`);
  assert.equal(envelope.version, 'w758-v1');
});

// =============================================================================
// 11) loadMTBenchPack returns bench_pack_not_local
// =============================================================================

test('W758 #11 — loadMTBenchPack returns bench_pack_not_local when pack_dir absent', () => {
  freshDir();
  const envelope = loadMTBenchPack({ pack_dir: path.join(process.env.KOLM_HOME, 'missing-mtbench') });
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error, 'bench_pack_not_local');
  assert.ok(typeof envelope.hint === 'string' && envelope.hint.includes('FastChat'),
    `hint must mention FastChat (canonical MT-Bench source); got ${JSON.stringify(envelope.hint)}`);
  assert.equal(envelope.version, 'w758-v1');
});

// =============================================================================
// 12) runMMLU with seeded pack + DI runOnArtifact returns ok:true
// =============================================================================

test('W758 #12 — runMMLU with seeded pack + DI runOnArtifact returns ok:true + accuracy', async () => {
  freshDir();
  // Seed a tiny pack on disk under the HF layout.
  const packDir = path.join(process.env.KOLM_HOME, 'mmlu-pack');
  const testDir = path.join(packDir, 'test');
  fs.mkdirSync(testDir, { recursive: true });
  fs.writeFileSync(path.join(testDir, 'global_facts_test.csv'),
    'What is the capital of France?,London,Paris,Berlin,Madrid,B\n' +
    'Which planet is closest to the Sun?,Venus,Mercury,Earth,Mars,B\n' +
    'What is 2+2?,3,4,5,6,B\n',
    'utf8',
  );
  // Oracle runOnArtifact: always returns "B" — should score 3/3.
  const runOnArtifact = (_artifact, _prompt) => 'The answer is B.';
  const result = await runMMLU({
    artifact_path: '/dev/null',
    pack_dir: packDir,
    runOnArtifact,
    subjects: ['global_facts'],
  });
  assert.equal(result.ok, true,
    `expected ok:true; got ${JSON.stringify(result)}`);
  assert.equal(result.version, 'w758-v1');
  assert.equal(result.n, 3);
  assert.equal(result.correct, 3);
  assert.equal(result.accuracy, 1.0);
  assert.ok(result.by_subject && result.by_subject.global_facts);
  assert.equal(result.by_subject.global_facts.accuracy, 1.0);
  assert.ok(Array.isArray(result.sample_runs) && result.sample_runs.length === 3);
  for (const s of result.sample_runs) {
    assert.equal(s.predicted, 'B');
    assert.equal(s.correct, true);
  }
});

// =============================================================================
// 13) runMMLU without runOnArtifact returns runtime_not_wired
// =============================================================================

test('W758 #13 — runMMLU without runOnArtifact returns runtime_not_wired envelope', async () => {
  freshDir();
  const result = await runMMLU({ artifact_path: '/dev/null' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'runtime_not_wired');
  assert.ok(typeof result.hint === 'string' && result.hint.includes('runOnArtifact'),
    `hint must name the missing seam; got ${JSON.stringify(result.hint)}`);
  assert.equal(result.version, 'w758-v1');
});

// =============================================================================
// 14) runHumanEval without sandbox_cmd returns no_code_sandbox_configured
// =============================================================================

test('W758 #14 — runHumanEval without sandbox_cmd returns no_code_sandbox_configured', async () => {
  freshDir();
  const result = await runHumanEval({
    artifact_path: '/dev/null',
    runOnArtifact: (_a, _p) => 'def add(a,b): return a+b',
    // sandbox_cmd omitted on purpose.
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no_code_sandbox_configured');
  assert.ok(typeof result.hint === 'string' && result.hint.includes('sandbox'),
    `hint must mention the sandbox requirement; got ${JSON.stringify(result.hint)}`);
  assert.equal(result.version, 'w758-v1');
});

// =============================================================================
// 15) runHumanEval with sandbox_cmd + DI runOnArtifact returns ok:true + pass_at_1
// =============================================================================

test('W758 #15 — runHumanEval with sandbox_cmd + DI runOnArtifact returns ok:true + pass_at_1', async () => {
  freshDir();
  const packDir = path.join(process.env.KOLM_HOME, 'humaneval-pack');
  fs.mkdirSync(packDir, { recursive: true });
  const jsonl =
    JSON.stringify({
      task_id: 'HumanEval/0', prompt: 'def add(a,b):\n',
      canonical_solution: '    return a+b',
      test: 'def check(candidate):\n    assert candidate(1,2)==3',
      entry_point: 'add',
    }) + '\n' +
    JSON.stringify({
      task_id: 'HumanEval/1', prompt: 'def mul(a,b):\n',
      canonical_solution: '    return a*b',
      test: 'def check(candidate):\n    assert candidate(2,3)==6',
      entry_point: 'mul',
    }) + '\n';
  fs.writeFileSync(path.join(packDir, 'HumanEval.jsonl'), jsonl, 'utf8');
  // Always-pass sandbox stub returns passed:true.
  const sandbox_cmd = async (_code, _test, _entry) => ({ passed: true });
  const runOnArtifact = (_a, _p) => 'def stub(): return 0';
  const result = await runHumanEval({
    artifact_path: '/dev/null',
    pack_dir: packDir,
    runOnArtifact,
    sandbox_cmd,
  });
  assert.equal(result.ok, true,
    `expected ok:true; got ${JSON.stringify(result)}`);
  assert.equal(result.version, 'w758-v1');
  assert.equal(result.n, 2);
  assert.equal(result.passed, 2);
  assert.equal(result.pass_at_1, 1.0);
  assert.ok(Array.isArray(result.by_task) && result.by_task.length === 2);
  for (const t of result.by_task) {
    assert.equal(t.passed, true);
  }
});

// =============================================================================
// 16) runMTBench without judge returns no_judge_model_configured
// =============================================================================

test('W758 #16 — runMTBench without judge returns no_judge_model_configured', async () => {
  freshDir();
  const result = await runMTBench({
    artifact_path: '/dev/null',
    runOnArtifact: (_a, _p) => 'an answer',
    // judge omitted on purpose.
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no_judge_model_configured');
  assert.ok(typeof result.hint === 'string' && /judge|GPT-4/.test(result.hint),
    `hint must mention the judge requirement; got ${JSON.stringify(result.hint)}`);
  assert.equal(result.version, 'w758-v1');
});

// =============================================================================
// 17) runMTBench with judge + DI runOnArtifact returns ok:true + mean_score
// =============================================================================

test('W758 #17 — runMTBench with judge + DI runOnArtifact returns ok:true + mean_score', async () => {
  freshDir();
  const packDir = path.join(process.env.KOLM_HOME, 'mtbench-pack');
  fs.mkdirSync(packDir, { recursive: true });
  const jsonl =
    JSON.stringify({
      question_id: 81, category: 'writing',
      turns: ['Write a haiku about rain.', 'Now make it about snow.'],
    }) + '\n' +
    JSON.stringify({
      question_id: 82, category: 'math',
      turns: ['What is 7*8?', 'And 9*9?'],
      reference: ['56', '81'],
    }) + '\n';
  fs.writeFileSync(path.join(packDir, 'question.jsonl'), jsonl, 'utf8');
  const runOnArtifact = (_a, _p, _hist) => 'a reasonable response';
  // Judge returns 8 for every turn → mean_score 8.0.
  const judge = async (_q, _ti, _resp, _ref) => ({ score: 8, rationale: 'good' });
  const result = await runMTBench({
    artifact_path: '/dev/null',
    pack_dir: packDir,
    runOnArtifact,
    judge,
  });
  assert.equal(result.ok, true,
    `expected ok:true; got ${JSON.stringify(result)}`);
  assert.equal(result.version, 'w758-v1');
  assert.equal(result.n, 2);
  assert.equal(result.mean_score, 8.0,
    `mean_score must be 8.0 from constant-8 judge; got ${result.mean_score}`);
  assert.ok(result.by_category && result.by_category.writing && result.by_category.math);
  assert.equal(result.by_category.writing.mean_score, 8.0);
  assert.equal(result.by_category.math.mean_score, 8.0);
  assert.ok(Array.isArray(result.by_question) && result.by_question.length === 2);
});

// =============================================================================
// 18) POST /v1/bench/mmlu returns 401 without auth
// =============================================================================

test('W758 #18 — POST /v1/bench/mmlu returns 401 without auth', async () => {
  freshDir();
  const { buildRouter } = await import('../src/router.js');
  const express = (await import('express')).default;
  const http = await import('node:http');
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const res = await fetch(`http://127.0.0.1:${port}/v1/bench/mmlu`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(res.status, 401, `expected 401; got ${res.status}`);
    const body = await res.json();
    // Auth middleware may short-circuit with its own error before the route
    // sees the request; either honest 401 envelope proves auth is enforced.
    assert.ok(
      /auth_required|missing api key|api[_ ]key/i.test(String(body.error || '')),
      `expected auth-required-shape error; got ${JSON.stringify(body)}`,
    );
  } finally {
    await new Promise(r => srv.close(r));
  }
});

// =============================================================================
// 19) POST /v1/bench/humaneval returns 401 without auth
// =============================================================================

test('W758 #19 — POST /v1/bench/humaneval returns 401 without auth', async () => {
  freshDir();
  const { buildRouter } = await import('../src/router.js');
  const express = (await import('express')).default;
  const http = await import('node:http');
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const res = await fetch(`http://127.0.0.1:${port}/v1/bench/humaneval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.ok(
      /auth_required|missing api key|api[_ ]key/i.test(String(body.error || '')),
      `expected auth-required-shape error; got ${JSON.stringify(body)}`,
    );
  } finally {
    await new Promise(r => srv.close(r));
  }
});

// =============================================================================
// 20) POST /v1/bench/mtbench returns 401 without auth
// =============================================================================

test('W758 #20 — POST /v1/bench/mtbench returns 401 without auth', async () => {
  freshDir();
  const { buildRouter } = await import('../src/router.js');
  const express = (await import('express')).default;
  const http = await import('node:http');
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const res = await fetch(`http://127.0.0.1:${port}/v1/bench/mtbench`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.ok(
      /auth_required|missing api key|api[_ ]key/i.test(String(body.error || '')),
      `expected auth-required-shape error; got ${JSON.stringify(body)}`,
    );
  } finally {
    await new Promise(r => srv.close(r));
  }
});

// =============================================================================
// 21) POST /v1/bench/mmlu returns 400 confirm_required when body omits confirm
// =============================================================================

test('W758 #21 — POST /v1/bench/mmlu returns 400 confirm_required without confirm', async () => {
  freshDir();
  // Reset event store with isolated path so provisionTenant writes here.
  process.env.KOLM_EVENT_STORE_PATH = path.join(
    process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite',
  );
  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();
  const { buildRouter } = await import('../src/router.js');
  const { provisionTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionTenant('w758-' + crypto.randomBytes(3).toString('hex'),
    { kind: 'human', plan: 'enterprise', quota: 5000 });
  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const res = await fetch(`http://127.0.0.1:${port}/v1/bench/mmlu`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({}),                              // no confirm
    });
    assert.equal(res.status, 400, `expected 400; got ${res.status}`);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'confirm_required');
    assert.ok(typeof body.hint === 'string' && body.hint.includes('confirm'));
  } finally {
    await new Promise(r => srv.close(r));
  }
});

// =============================================================================
// 22) public/benchmarks.html has W758 anchor + 3 rows
// =============================================================================

test('W758 #22 — public/benchmarks.html has data-w758=external-results anchor + all 3 rows', () => {
  freshDir();
  assert.ok(fs.existsSync(BENCH_HTML), `expected ${BENCH_HTML}`);
  const html = fs.readFileSync(BENCH_HTML, 'utf8');
  for (const needle of [
    'w758-external-benchmarks',
    'data-w758="external-results"',
    'MMLU',
    'HumanEval',
    'MT-Bench',
    'huggingface.co/datasets/cais/mmlu',
    'huggingface.co/datasets/openai_humaneval',
    'github.com/lm-sys/FastChat',
    'pack_not_local',
    'kolm bench',
  ]) {
    assert.ok(html.includes(needle),
      `benchmarks.html must mention "${needle}"`);
  }
  // Defense-in-depth brand-lock: no emoji glyphs anywhere in the file.
  const commonEmoji = /[\uD83C-\uDBFF][\uDC00-\uDFFF]/g;
  assert.ok(!commonEmoji.test(html),
    'benchmarks.html MUST NOT carry emoji glyphs (brand-lock)');
});

// =============================================================================
// 23) cli/kolm.js defines cmdW758Bench exactly once + wired via cmdBenchmark
// =============================================================================

test('W758 #23 — cli/kolm.js defines cmdW758Bench exactly once + wired from case bench', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const defs = cli.match(/async function cmdW758Bench\s*\(/g) || [];
  assert.equal(defs.length, 1,
    `expected exactly 1 cmdW758Bench definition; got ${defs.length}`);
  // The wire path is case 'bench' -> cmdBenchmark -> cmdW758Bench (the
  // existing case predates W758 and is shared with the legacy benchmark
  // dispatcher). Verify the existing case AND the delegation both stand.
  assert.ok(/case\s+['"]bench['"]/.test(cli),
    `cli must have case 'bench' arm`);
  // At least one invocation of cmdW758Bench(args|rest) from elsewhere in the
  // file proves the dispatcher is reachable.
  const invokeRe = /cmdW758Bench\s*\(/g;
  const invokes = (cli.match(invokeRe) || []).length;
  assert.ok(invokes >= 2,
    `expected >=2 mentions of cmdW758Bench (definition + at least 1 call); got ${invokes}`);
});

// =============================================================================
// 24) cli/kolm.js still has case 'bench' arm wired (regression guard)
// =============================================================================

test('W758 #24 — cli/kolm.js has case bench arm wired to cmdBenchmark', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  // Locate the `case 'bench':` line and verify the dispatch on the same
  // logical statement reaches cmdBenchmark. We split on the literal token
  // rather than building a single regex that has to thread through the
  // (... => cmdBenchmark(rest)) parenthesis nesting.
  const idx = cli.search(/case\s+['"]bench['"]\s*:/);
  assert.ok(idx >= 0, `cli must declare case 'bench'`);
  const window = cli.slice(idx, idx + 200);
  assert.ok(window.includes('cmdBenchmark'),
    `cli case 'bench' must dispatch to cmdBenchmark within 200 chars; got window: ${JSON.stringify(window)}`);
});

// =============================================================================
// 25) wave758 sibling test count uses regex wave(\d{3,4}) + threshold
// =============================================================================

test('W758 #25 — wave758 sibling test count uses regex wave(\\d{3,4}) + threshold (W604 anti-brittleness)', () => {
  freshDir();
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  // Forward-compatible threshold — adding more wave tests does NOT break this.
  assert.ok(siblings.length >= 5,
    `expected >=5 wave(\\d{3,4}) test files; found ${siblings.length}`);
});

// Sanity-check unused imports stay referenced so a future tree-shake doesn't
// silently drop them. Use the imported symbols at least once outside their
// dedicated test blocks.
test('W758 #26 — exported helpers (formatMMLUPrompt + extractCodeFromResponse) are functions', () => {
  freshDir();
  assert.equal(typeof formatMMLUPrompt, 'function');
  assert.equal(typeof extractCodeFromResponse, 'function');
  const prompt = formatMMLUPrompt({
    question: 'q', choices: ['a', 'b', 'c', 'd'], answer: 'A', subject: 'x',
  });
  assert.ok(prompt.includes('Question: q'));
  assert.ok(prompt.includes('A. a'));
  assert.ok(prompt.endsWith('Answer:'));
  // extractCodeFromResponse strips python fence.
  const code = extractCodeFromResponse('```python\ndef f():\n    return 1\n```');
  assert.equal(code, 'def f():\n    return 1');
});
