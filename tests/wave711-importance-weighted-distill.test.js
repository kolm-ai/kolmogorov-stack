// W711 — capture importance scorer + importance-weighted distill CLI.
//
// Atomic items pinned:
//
//   1) scoreCapture deterministic given same input.
//   2) High token-density capture scores higher than low-density.
//   3) Novelty window: identical-repeat scores lower the second time.
//   4) topNByImportance returns exactly N in descending score order.
//   5) bottomNByImportance returns exactly N in ascending score order.
//   6) buildImportanceReportBlock structure shape (block_kind, versions, ...).
//   7) CLI `kolm capture importance --json` returns valid JSON without error.
//   8) CLI `kolm distill --importance-weighted` with no trainer returns the
//      honest envelope (trainer_not_invoked:true).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  scoreCapture,
  topNByImportance,
  bottomNByImportance,
  createScorerWindow,
  buildImportanceJsonlRows,
  hashScore,
  IMPORTANCE_VERSION,
} from '../src/capture-importance.js';
import {
  buildImportanceReportBlock,
  IMPORTANCE_BLOCK_KIND,
  IMPORTANCE_BLOCK_VERSION,
} from '../src/distill-report-blocks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, '..', 'cli', 'kolm.js');

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w711-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  return tmp;
}

// =============================================================================
// 1) scoreCapture deterministic given same input.
// =============================================================================

test('W711 #1 — scoreCapture deterministic for same input', async () => {
  freshDir();
  const capture = {
    prompt: 'Summarize the philosophy of stoicism in two sentences.',
    response: 'Stoicism teaches that virtue is the only true good and that we should focus on what is within our control. External events are indifferent; our judgments about them shape our lives.',
  };
  const a = scoreCapture(capture);
  const b = scoreCapture(capture);
  assert.equal(a.score, b.score, 'score is identical');
  assert.deepEqual(a.components, b.components, 'components match');
  assert.equal(a.version, IMPORTANCE_VERSION);
  assert.equal(hashScore(a), hashScore(b));
});

// =============================================================================
// 2) High token-density capture scores higher than low-density.
// =============================================================================

test('W711 #2 — high token-density scores higher than low-density', async () => {
  freshDir();
  const high = {
    prompt: 'Why?',
    response: 'Because the second law of thermodynamics says entropy in a closed system tends to increase, which means heat flows from hot to cold and useful energy gradients diminish over time. The arrow of time we perceive is the macroscopic shadow of this microscopic statistical fact, and it constrains every irreversible process we observe.',
  };
  const low = {
    prompt: 'Please write me a thorough explanation of why the sky is blue including Rayleigh scattering and any related optical phenomena, and please be exhaustive about historical theories that were superseded.',
    response: 'Blue.',
  };
  const highScore = scoreCapture(high);
  const lowScore = scoreCapture(low);
  assert.ok(
    highScore.components.token_density > lowScore.components.token_density,
    `expected high.token_density > low.token_density; got ${highScore.components.token_density} vs ${lowScore.components.token_density}`,
  );
  assert.ok(
    highScore.score > lowScore.score,
    `expected high.score > low.score; got ${highScore.score} vs ${lowScore.score}`,
  );
});

// =============================================================================
// 3) Novelty window: identical-repeat capture scores lower the second time.
// =============================================================================

test('W711 #3 — novelty drops on identical repeat through window', async () => {
  freshDir();
  const capture = {
    prompt: 'Define gradient descent.',
    response: 'Gradient descent is a first-order iterative optimization method that updates parameters in the direction of the negative gradient of an objective function. The step size is set by a learning rate hyperparameter and convergence depends on smoothness.',
  };
  const win = createScorerWindow(100);
  const first = win.score(capture);
  const second = win.score(capture);
  assert.equal(first.components.novelty, 1.0, 'first capture is maximally novel');
  assert.ok(
    second.components.novelty < first.components.novelty,
    `expected second.novelty < first.novelty (drift after dedup); got ${second.components.novelty} vs ${first.components.novelty}`,
  );
  // The score should also be lower the second time around (novelty drove it down).
  assert.ok(second.score < first.score,
    `expected second.score < first.score; got ${second.score} vs ${first.score}`);
});

// =============================================================================
// 4) topNByImportance returns exactly N in descending order.
// =============================================================================

test('W711 #4 — topNByImportance returns N rows in descending score order', async () => {
  freshDir();
  const captures = [
    { id: 'a', prompt: 'X', response: 'tiny' },
    { id: 'b', prompt: 'Y', response: 'A reasonably detailed response with several distinct content tokens that should rank highly.' },
    { id: 'c', prompt: 'Z', response: 'medium length response with diversity' },
    { id: 'd', prompt: 'W', response: 'A very long highly novel response explaining concepts of category theory including limits, colimits, adjunctions, monads, and Yoneda lemma applications across functional programming and abstract algebra.' },
    { id: 'e', prompt: 'V', response: 'small' },
    { id: 'f', prompt: 'U', response: 'another short one' },
  ];
  const top3 = topNByImportance(captures, 3);
  assert.equal(top3.length, 3, 'exactly 3 rows');
  for (let i = 0; i < top3.length - 1; i++) {
    assert.ok(top3[i].score >= top3[i + 1].score,
      `top[${i}].score (${top3[i].score}) >= top[${i+1}].score (${top3[i+1].score})`);
  }
  // Capture-ids surface.
  for (const r of top3) {
    assert.ok(typeof r.capture_id === 'string' && r.capture_id.length > 0);
    assert.ok(typeof r.score === 'number' && Number.isFinite(r.score));
  }
});

// =============================================================================
// 5) bottomNByImportance returns exactly N in ascending score order.
// =============================================================================

test('W711 #5 — bottomNByImportance returns N rows in ascending score order', async () => {
  freshDir();
  const captures = [
    { id: 'a', prompt: 'X', response: 'tiny' },
    { id: 'b', prompt: 'Y', response: 'A reasonably detailed response with several distinct content tokens that should rank highly enough to be middle-of-the-pack.' },
    { id: 'c', prompt: 'Z', response: 'medium length response with diversity and a bit of structure' },
    { id: 'd', prompt: 'W', response: 'A very long highly novel response explaining concepts of category theory including limits, colimits, adjunctions, monads, and Yoneda lemma applications across functional programming and abstract algebra.' },
    { id: 'e', prompt: 'V', response: 'small' },
    { id: 'f', prompt: 'U', response: 'another short one' },
  ];
  const bot3 = bottomNByImportance(captures, 3);
  assert.equal(bot3.length, 3, 'exactly 3 rows');
  for (let i = 0; i < bot3.length - 1; i++) {
    assert.ok(bot3[i].score <= bot3[i + 1].score,
      `bot[${i}].score (${bot3[i].score}) <= bot[${i+1}].score (${bot3[i+1].score})`);
  }
  // Bottom must NOT equal top in general (different rankings).
  const top3 = topNByImportance(captures, 3);
  const topIds = new Set(top3.map(r => r.capture_id));
  const botIds = new Set(bot3.map(r => r.capture_id));
  // At least one row differs (sanity).
  let differ = false;
  for (const id of botIds) if (!topIds.has(id)) { differ = true; break; }
  assert.ok(differ, 'bottom-N and top-N must differ on at least one row');
});

// =============================================================================
// 6) buildImportanceReportBlock structure shape.
// =============================================================================

test('W711 #6 — buildImportanceReportBlock emits the contract envelope', async () => {
  freshDir();
  const captures = [
    { id: 'r1', prompt: 'hi', response: 'A medium novel response with some structure to it.' },
    { id: 'r2', prompt: 'hi2', response: 'A different medium response that is structurally similar.' },
  ];
  const top = topNByImportance(captures, 2);
  const bot = bottomNByImportance(captures, 2);
  const block = buildImportanceReportBlock({
    topN: top,
    bottomN: bot,
    scorerVersion: IMPORTANCE_VERSION,
  });
  assert.equal(block.block_kind, IMPORTANCE_BLOCK_KIND);
  assert.equal(block.block_kind, 'importance_distribution');
  assert.equal(block.block_version, IMPORTANCE_BLOCK_VERSION);
  assert.equal(block.block_version, 'w711-v1');
  assert.equal(block.scorer_version, IMPORTANCE_VERSION);
  assert.equal(block.scorer_version, 'w711-v1');
  assert.ok(Array.isArray(block.top_n));
  assert.ok(Array.isArray(block.bottom_n));
  assert.equal(block.top_n.length, 2);
  assert.equal(block.bottom_n.length, 2);
  assert.ok(typeof block.interpretation_hint === 'string');
  assert.ok(/Top-N|bottom-N/i.test(block.interpretation_hint));
  // Default scorerVersion when not supplied.
  const block2 = buildImportanceReportBlock({ topN: [], bottomN: [] });
  assert.equal(block2.scorer_version, IMPORTANCE_VERSION);
});

// =============================================================================
// 7) CLI `kolm capture importance --json` returns JSON without error.
// =============================================================================

test('W711 #7 — CLI `kolm capture importance --json` emits valid JSON envelope', async () => {
  const tmp = freshDir();
  const env = {
    ...process.env,
    HOME: tmp,
    USERPROFILE: tmp,
    KOLM_HOME: path.join(tmp, '.kolm'),
    KOLM_DATA_DIR: path.join(tmp, '.kolm'),
  };
  const r = spawnSync(process.execPath, [CLI_PATH, 'capture', 'importance', '--json'], {
    env, encoding: 'utf8', timeout: 30_000,
  });
  const stdout = r.stdout || '';
  const firstBrace = stdout.indexOf('{');
  const lastBrace = stdout.lastIndexOf('}');
  assert.ok(firstBrace >= 0 && lastBrace > firstBrace,
    `expected JSON; stdout=${stdout.slice(0, 400)} stderr=${(r.stderr || '').slice(0, 400)}`);
  const parsed = JSON.parse(stdout.slice(firstBrace, lastBrace + 1));
  assert.equal(parsed.ok, true);
  assert.ok(parsed.block, 'envelope has block field');
  assert.equal(parsed.block.block_kind, 'importance_distribution');
  assert.equal(parsed.block.block_version, 'w711-v1');
  assert.equal(parsed.block.scorer_version, 'w711-v1');
  assert.ok(Array.isArray(parsed.block.top_n));
  assert.ok(Array.isArray(parsed.block.bottom_n));
  assert.equal(r.status, 0, `exit 0 expected; got ${r.status} stderr=${(r.stderr || '').slice(0, 200)}`);
});

// =============================================================================
// 8) CLI `kolm distill --importance-weighted` with no trainer falls back to
//    the honest envelope.
// =============================================================================

test('W711 #8 — CLI `kolm distill --importance-weighted` honest fallback', async () => {
  const tmp = freshDir();
  const cfgDir = path.join(tmp, '.kolm');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(
    path.join(cfgDir, 'config.json'),
    JSON.stringify({ api_key: 'ks_test_w711', base: 'http://127.0.0.1:1' }),
  );
  // Ensure KOLM_TRAINER_BIN is NOT set and no sibling trainer exists so the
  // fallback path runs.
  const env = {
    ...process.env,
    HOME: tmp,
    USERPROFILE: tmp,
    KOLM_HOME: path.join(tmp, '.kolm'),
    KOLM_DATA_DIR: path.join(tmp, '.kolm'),
    KOLM_TENANT_ID: 'tenant_w711_8',
    KOLM_BASE: 'http://127.0.0.1:1',
    KOLM_API_KEY: 'ks_test_w711',
  };
  delete env.KOLM_TRAINER_BIN;
  const r = spawnSync(process.execPath, [CLI_PATH, 'distill', '--importance-weighted', '--namespace', 'ns_w711_8', '--json'], {
    env, encoding: 'utf8', timeout: 30_000,
  });
  const stdout = r.stdout || '';
  const firstBrace = stdout.indexOf('{');
  const lastBrace = stdout.lastIndexOf('}');
  assert.ok(firstBrace >= 0 && lastBrace > firstBrace,
    `expected JSON envelope; stdout=${stdout.slice(0, 400)} stderr=${(r.stderr || '').slice(0, 400)}`);
  const parsed = JSON.parse(stdout.slice(firstBrace, lastBrace + 1));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.trainer_not_invoked, true);
  assert.ok(typeof parsed.weights_jsonl_written === 'string'
    && parsed.weights_jsonl_written.length > 0,
    'envelope carries weights_jsonl_written path');
  assert.ok(parsed.hint && /pip install -e apps\/trainer|KOLM_TRAINER_BIN/.test(parsed.hint),
    `envelope hint mentions install path; got ${parsed.hint}`);
  assert.equal(parsed.scorer_version, 'w711-v1');
  assert.equal(parsed.namespace, 'ns_w711_8');
  // The JSONL file must actually exist on disk (we promised an artifact).
  assert.ok(fs.existsSync(parsed.weights_jsonl_written),
    `weights JSONL must exist at ${parsed.weights_jsonl_written}`);
  assert.equal(r.status, 0, `exit 0 expected; got ${r.status} stderr=${(r.stderr || '').slice(0, 200)}`);
});

// =============================================================================
// 9) buildImportanceJsonlRows emits the trainer contract shape.
// =============================================================================

test('W711 #9 — buildImportanceJsonlRows emits {capture_id, importance} rows', async () => {
  freshDir();
  const captures = [
    { id: 'c1', prompt: 'A', response: 'B C D' },
    { id: 'c2', prompt: 'E', response: 'F G' },
  ];
  const rows = buildImportanceJsonlRows(captures);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.ok(typeof r.capture_id === 'string' && r.capture_id.length > 0);
    assert.ok(typeof r.importance === 'number' && r.importance >= 0 && r.importance <= 1,
      `importance in [0,1]; got ${r.importance}`);
  }
  // Empty input -> empty output (never throw).
  assert.deepEqual(buildImportanceJsonlRows([]), []);
  assert.deepEqual(buildImportanceJsonlRows(null), []);
});
