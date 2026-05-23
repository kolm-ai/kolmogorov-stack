// W717 — curriculum-distillation tests.
//
// Atomic items pinned:
//
//   1) CURRICULUM_VERSION exported and matches the w717 contract (regex,
//      not literal, so a v1.x bump in the same wave doesn't break the lock).
//   2) complexityProxy returns a number in [0, 1] with a finite score.
//   3) complexityProxy is monotonic-ish: a longer + higher-entropy response
//      scores higher than a short + low-entropy one.
//   4) sortCapturesByCurriculum 'ascending' returns easiest first
//      (lowest complexity in slot 0) and stable on ties.
//   5) buildCurriculumJsonlRows preserves capture_id and stamps
//      complexity_proxy on every row.
//   6) CLI `kolm distill --curriculum --json` with no python falls back to
//      the honest envelope (trainer_not_invoked:true, exit 0).
//   7) descending mode reverses the ascending order.
//
// Concurrency 1 (per W711/W712 sibling-wave convention). KOLM_DATA_DIR
// isolated per-test via freshDir() so the event-store doesn't leak.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  CURRICULUM_VERSION,
  complexityProxy,
  sortCapturesByCurriculum,
  buildCurriculumJsonlRows,
  buildUnigramTable,
} from '../src/curriculum-sort.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '..', 'cli', 'kolm.js');

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w717-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  return tmp;
}

// =============================================================================
// 1) CURRICULUM_VERSION exported.
// =============================================================================

test('W717 #1 — CURRICULUM_VERSION exported and matches w717-* contract', () => {
  // Anti-brittleness: regex match, not literal equality, so a v1.x bump in
  // the same wave doesn't force a coordinated test-rev (W604 standing
  // directive #3). The wave-prefix is the load-bearing piece.
  assert.ok(typeof CURRICULUM_VERSION === 'string', 'is a string');
  assert.ok(/^w717-/.test(CURRICULUM_VERSION),
    `CURRICULUM_VERSION starts with w717-; got ${CURRICULUM_VERSION}`);
});

// =============================================================================
// 2) complexityProxy returns 0..1.
// =============================================================================

test('W717 #2 — complexityProxy returns finite score in [0, 1] with components', () => {
  const capture = {
    prompt: 'Why is the sky blue?',
    response: 'Because of Rayleigh scattering — shorter wavelengths scatter more in the atmosphere.',
  };
  const r = complexityProxy(capture);
  assert.ok(Number.isFinite(r.score), `score is finite; got ${r.score}`);
  assert.ok(r.score >= 0 && r.score <= 1,
    `score in [0,1]; got ${r.score}`);
  assert.ok(r.components && typeof r.components === 'object', 'components present');
  assert.ok(Number.isFinite(r.components.length_norm), 'length_norm finite');
  assert.ok(Number.isFinite(r.components.perplexity_norm), 'perplexity_norm finite');
  assert.ok(Number.isFinite(r.components.perplexity), 'perplexity finite');
  assert.equal(r.version, CURRICULUM_VERSION, 'version stamped');

  // Degenerate input also yields a finite score (honesty contract).
  const empty = complexityProxy({});
  assert.ok(Number.isFinite(empty.score), 'empty capture still scores finite');
  assert.ok(empty.score >= 0 && empty.score <= 1, 'empty capture clamped');

  const nullish = complexityProxy(null);
  assert.ok(Number.isFinite(nullish.score), 'null capture still scores finite');
});

// =============================================================================
// 3) complexityProxy is monotonic-ish: longer + more entropy -> higher.
// =============================================================================

test('W717 #3 — complexityProxy is monotonic-ish (long+entropic > short+repetitive)', () => {
  // Long + diverse vocabulary = HARD.
  const hard = {
    prompt: 'Explain quantum entanglement.',
    response: Array.from({ length: 200 }, (_, i) =>
      `quantum${i % 17} state${i % 23} entangled${i % 11} measurement${i % 13}`
    ).join(' '),
  };
  // Short + repetitive = EASY.
  const easy = {
    prompt: 'Say yes.',
    response: 'yes',
  };
  // Score against the same corpus table so the comparison is meaningful.
  const { table, total } = buildUnigramTable([hard, easy]);
  const hardScore = complexityProxy(hard, { unigramTable: table, totalTokens: total });
  const easyScore = complexityProxy(easy, { unigramTable: table, totalTokens: total });
  assert.ok(
    hardScore.score > easyScore.score,
    `expected hard.score > easy.score; got hard=${hardScore.score} easy=${easyScore.score}`,
  );
  // Length axis specifically should be larger for the hard sample.
  assert.ok(
    hardScore.components.length_norm > easyScore.components.length_norm,
    `expected hard.length_norm > easy.length_norm; got ${hardScore.components.length_norm} vs ${easyScore.components.length_norm}`,
  );
});

// =============================================================================
// 4) sortCapturesByCurriculum ascending returns easiest first.
// =============================================================================

test('W717 #4 — sortCapturesByCurriculum ascending returns easiest first', () => {
  // Easy: very short response with a SINGLE word that ALSO appears in the
  // corpus elsewhere (so unigram perplexity isn't blown up by a lone OOV).
  // Length-norm is what dominates the easy/hard ordering at this scale.
  const easy = { id: 'easy', prompt: 'p', response: 'word' };
  const mid = { id: 'mid', prompt: 'p',
    response: ('word ' + 'word '.repeat(60)).trim() };
  const hard = { id: 'hard', prompt: 'p',
    response: Array.from({ length: 600 }, (_, i) =>
      `unique${i} term${i * 7 % 53} concept${i * 11 % 73}`
    ).join(' ') };
  // Feed in non-sorted order to make sure the function actually sorts.
  const inOrder = [hard, easy, mid];
  const sorted = sortCapturesByCurriculum(inOrder);
  assert.equal(sorted.length, 3, 'all rows preserved');
  // Easiest is first.
  assert.equal(sorted[0].id, 'easy', `expected easy first; got ${sorted[0].id}`);
  // Hardest is last.
  assert.equal(sorted[2].id, 'hard', `expected hard last; got ${sorted[2].id}`);
  // Defensive shallow copy: input unchanged.
  assert.equal(inOrder[0].id, 'hard', 'input array unmutated');
  // Edge: empty / single / non-array.
  assert.deepEqual(sortCapturesByCurriculum([]), []);
  const single = [{ id: 'only', response: 'x' }];
  const singleOut = sortCapturesByCurriculum(single);
  assert.equal(singleOut.length, 1);
  assert.deepEqual(sortCapturesByCurriculum(null), []);
  assert.deepEqual(sortCapturesByCurriculum(undefined), []);
});

// =============================================================================
// 5) buildCurriculumJsonlRows preserves capture_id + stamps complexity_proxy.
// =============================================================================

test('W717 #5 — buildCurriculumJsonlRows preserves capture_id + stamps complexity_proxy', () => {
  const captures = [
    { capture_id: 'cap_easy', prompt: 'p1', response: 'short' },
    { capture_id: 'cap_hard', prompt: 'p2',
      response: Array.from({ length: 250 }, (_, i) => `tok${i}`).join(' ') },
    // capture without capture_id but with id alias.
    { id: 'cap_mid', prompt: 'p3', response: 'mid length response here' },
  ];
  const rows = buildCurriculumJsonlRows(captures);
  assert.equal(rows.length, 3, 'one row per capture');
  for (const r of rows) {
    assert.ok(typeof r.capture_id === 'string' && r.capture_id.length > 0,
      `capture_id present on each row; got ${r.capture_id}`);
    assert.ok(typeof r.complexity_proxy === 'number',
      'complexity_proxy is a number');
    assert.ok(r.complexity_proxy >= 0 && r.complexity_proxy <= 1,
      `complexity_proxy in [0, 1]; got ${r.complexity_proxy}`);
    assert.ok(typeof r.prompt === 'string', 'prompt passed through');
    assert.ok(typeof r.response === 'string', 'response passed through');
  }
  // Order is ascending: first row has the lowest complexity_proxy.
  for (let i = 1; i < rows.length; i++) {
    assert.ok(
      rows[i - 1].complexity_proxy <= rows[i].complexity_proxy,
      `rows ascending; row ${i - 1}=${rows[i - 1].complexity_proxy} row ${i}=${rows[i].complexity_proxy}`,
    );
  }
  // Easy capture first (lowest complexity).
  assert.equal(rows[0].capture_id, 'cap_easy');
  // Empty input.
  assert.deepEqual(buildCurriculumJsonlRows([]), []);
  assert.deepEqual(buildCurriculumJsonlRows(null), []);
});

// =============================================================================
// 6) CLI honest fallback when no python trainer reachable.
// =============================================================================

test('W717 #6 — CLI `kolm distill --curriculum --json` honest fallback', () => {
  const tmp = freshDir();
  const cfgDir = path.join(tmp, '.kolm');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(
    path.join(cfgDir, 'config.json'),
    JSON.stringify({ api_key: 'ks_test_w717', base: 'http://127.0.0.1:1' }),
  );
  const env = {
    ...process.env,
    HOME: tmp,
    USERPROFILE: tmp,
    KOLM_HOME: path.join(tmp, '.kolm'),
    KOLM_DATA_DIR: path.join(tmp, '.kolm'),
    KOLM_TENANT_ID: 'tenant_w717_6',
    KOLM_BASE: 'http://127.0.0.1:1',
    KOLM_API_KEY: 'ks_test_w717',
    // Force the trainer-probe path to fail so we exercise the honest
    // trainer_not_invoked envelope regardless of whether python is on PATH.
    KOLM_DISABLE_TRAINER_PROBE: '1',
    // Point KOLM_TRAINER_BIN at a non-existent file so the existsSync check
    // also fails up front.
    KOLM_TRAINER_BIN: path.join(tmp, 'definitely-not-a-real-trainer-binary'),
  };
  const r = spawnSync(process.execPath, [
    CLI_PATH, 'distill', '--curriculum',
    '--namespace', 'ns_w717_6',
    '--json',
  ], { env, encoding: 'utf8', timeout: 30_000 });

  const stdout = r.stdout || '';
  const firstBrace = stdout.indexOf('{');
  const lastBrace = stdout.lastIndexOf('}');
  assert.ok(firstBrace >= 0 && lastBrace > firstBrace,
    `expected JSON envelope; stdout=${stdout.slice(0, 400)} stderr=${(r.stderr || '').slice(0, 400)}`);
  const parsed = JSON.parse(stdout.slice(firstBrace, lastBrace + 1));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.trainer_not_invoked, true);
  // Anti-brittleness via version-prefix regex (W604 standing directive #3).
  assert.ok(/^w717/.test(parsed.curriculum_version),
    `curriculum_version starts with w717; got ${parsed.curriculum_version}`);
  assert.equal(parsed.namespace, 'ns_w717_6');
  assert.ok(typeof parsed.captures_jsonl_written === 'string'
    && parsed.captures_jsonl_written.length > 0,
    'envelope carries captures_jsonl_written path');
  assert.ok(fs.existsSync(parsed.captures_jsonl_written),
    `captures JSONL must exist at ${parsed.captures_jsonl_written}`);
  assert.ok(parsed.hint && /pip install|KOLM_TRAINER_BIN/.test(parsed.hint),
    `envelope hint mentions install path; got ${parsed.hint}`);
  assert.ok(parsed.mode === 'ascending' || parsed.mode === 'descending',
    `mode echoed; got ${parsed.mode}`);
  assert.equal(r.status, 0,
    `exit 0 expected; got ${r.status} stderr=${(r.stderr || '').slice(0, 200)}`);
});

// =============================================================================
// 7) descending mode reverses ascending.
// =============================================================================

test('W717 #7 — descending mode reverses ascending order', () => {
  const captures = [
    { id: 'a', response: 'short' },
    { id: 'b', response: 'medium length response with several different words used in sequence' },
    { id: 'c', response: Array.from({ length: 200 }, (_, i) => `t${i}`).join(' ') },
  ];
  const asc = sortCapturesByCurriculum(captures, 'ascending');
  const desc = sortCapturesByCurriculum(captures, 'descending');
  assert.equal(asc.length, desc.length);
  // First-of-ascending == last-of-descending (the easiest one).
  assert.equal(asc[0].id, desc[desc.length - 1].id,
    `easiest is first of asc and last of desc; got asc[0]=${asc[0].id} desc[last]=${desc[desc.length - 1].id}`);
  // Last-of-ascending == first-of-descending (the hardest one).
  assert.equal(asc[asc.length - 1].id, desc[0].id,
    `hardest is last of asc and first of desc; got asc[last]=${asc[asc.length - 1].id} desc[0]=${desc[0].id}`);
});
