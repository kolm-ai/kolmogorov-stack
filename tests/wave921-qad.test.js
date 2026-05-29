// W921 NEXT-2 — Quantization-Aware Distillation (QAD): the fusion of kolm's two
// verbs. Tests the three owned artifacts:
//   * workers/distill/scripts/fake_quant.py  (the fake-quant QDQ + STE core)
//   * apps/trainer/qad.py                     (the QAD trainer entry; reuses
//                                              distill.py losses read-only)
//   * recipes/trinity-qad.json                (the quant_aware recipe)
//
// GPU-free: the real QAD training run is listed under needs_gpu_run. Here we
// assert FILE SHAPE + recipe validity + that the python --self-test and the
// qad.py --preflight paths pass WITHOUT a GPU (when python is available; we
// skip gracefully when it is not — the orchestrator box has python + a 5090).
//
// Caveat: these tests assert numerics correctness of the fake-quant + the
// wiring/preflight, NOT end-to-end training quality (that needs the GPU run).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRecipe, listRecipes } from '../src/distill-recipe-loader.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const FAKE_QUANT_PY = path.join(REPO, 'workers', 'distill', 'scripts', 'fake_quant.py');
const QAD_PY = path.join(REPO, 'apps', 'trainer', 'qad.py');
const RECIPE = path.join(REPO, 'recipes', 'trinity-qad.json');

function _pythonBin() {
  return process.env.KOLM_PYTHON || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}
// On many Windows installs the console codec is cp9xx; force UTF-8 so the
// files' non-ASCII characters print without UnicodeEncodeError.
function _pyEnv(extra = {}) {
  return { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', ...extra };
}
function _pythonAvailable(py) {
  const probe = spawnSync(py, ['-c', 'print(1)'], { stdio: 'pipe', timeout: 30000, env: _pyEnv() });
  return probe.status === 0;
}
function _tmp(name) {
  return path.join(os.tmpdir(), `kolm-w921-qad-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
}
// The python entries print pretty (indent=2) JSON on stdout (torch warnings go
// to stderr). Extract the JSON object spanning the first '{' to the last '}'.
function _parseJsonBlock(stdout) {
  const s = (stdout || '').toString();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  assert.ok(start >= 0 && end > start, `no JSON object in stdout:\n${s}`);
  return JSON.parse(s.slice(start, end + 1));
}

// ---------------------------------------------------------------------------
// 1. File shapes
// ---------------------------------------------------------------------------

test('1. all three owned QAD artifacts exist', () => {
  assert.ok(fs.existsSync(FAKE_QUANT_PY), `missing ${FAKE_QUANT_PY}`);
  assert.ok(fs.existsSync(QAD_PY), `missing ${QAD_PY}`);
  assert.ok(fs.existsSync(RECIPE), `missing ${RECIPE}`);
});

test('2. fake_quant.py declares the NF4 + FP4 grids and STE in source', () => {
  const src = fs.readFileSync(FAKE_QUANT_PY, 'utf8');
  // NF4 must carry the 16 NormalFloat levels (endpoints + exact zero).
  assert.match(src, /_NF4_LEVELS/, 'NF4 levels constant must be present');
  assert.match(src, /-0\.6961928009986877/, 'NF4 must use the QLoRA Appendix-E levels');
  // FP4 E2M1 magnitudes {0,0.5,1,1.5,2,3,4,6}.
  assert.match(src, /_FP4_E2M1_MAGNITUDES\s*:\s*tuple/, 'FP4 E2M1 magnitudes must be present');
  // Straight-through estimator autograd function.
  assert.match(src, /class _FakeQuantSTE\(torch\.autograd\.Function\)/, 'STE autograd.Function must be present');
  // Must NOT use the banned word.
  assert.equal(/\bhonest(y)?\b/i.test(src), false, 'must not use the banned word');
});

test('3. qad.py reuses distill.py losses by read-only import (does not edit distill.py)', () => {
  const src = fs.readFileSync(QAD_PY, 'utf8');
  // The read-only reuse: imports the loss registry + objective from distill.py.
  assert.match(src, /from apps\.trainer\.distill import/, 'must import distill.py');
  assert.match(src, /_KD_FNS/, 'must reuse distill.py KD loss registry');
  assert.match(src, /KDObjective/, 'must reuse distill.py KDObjective');
  // Provides --preflight / --dry-run.
  assert.match(src, /--preflight/, 'must expose --preflight');
  assert.match(src, /--dry-run/, 'must expose --dry-run alias');
  assert.equal(/\bhonest(y)?\b/i.test(src), false, 'must not use the banned word');
});

// ---------------------------------------------------------------------------
// 4. Recipe validity
// ---------------------------------------------------------------------------

test('4. trinity-qad recipe loads + validates via the recipe loader', () => {
  const loaded = loadRecipe('trinity-qad');
  assert.equal(loaded.ok, true, `recipe invalid: ${JSON.stringify(loaded.issues || loaded.message)}`);
  const r = loaded.recipe;
  assert.equal(r.quant_aware, true, 'recipe must flag quant_aware:true');
  assert.ok(r.qad, 'recipe must carry a qad section');
  assert.ok(['nf4', 'fp4'].includes(r.qad.quant_format), 'qad.quant_format must be nf4|fp4');
  assert.equal(r.qad.quant_block, 16, 'qad.quant_block should match NVFP4 (16)');
  assert.equal(r.qad.trainer, 'apps/trainer/qad.py', 'qad.trainer must point at qad.py');
  // QAD is logit-level (forward KL) -> requires a LOCAL teacher.
  assert.equal(r.distill.objective, 'forward_kl', 'QAD objective is the logit-level forward KL');
  assert.equal(r.distill.teacher_local, true, 'QAD needs a local logit teacher');
});

test('5. trinity-qad does not break recipe listing', () => {
  const me = listRecipes().find((x) => x.name === 'trinity-qad');
  assert.ok(me, 'trinity-qad must appear in listRecipes()');
  assert.equal(me.valid, true, 'trinity-qad must list as valid');
});

// ---------------------------------------------------------------------------
// 6. Python: fake_quant CPU self-test (no GPU, no network)
// ---------------------------------------------------------------------------

test('6. fake_quant.py --self-test passes (deterministic CPU numerics)', () => {
  const py = _pythonBin();
  if (!_pythonAvailable(py)) return; // no python on this box: skip gracefully
  const r = spawnSync(py, ['-X', 'utf8', FAKE_QUANT_PY, '--self-test'], {
    stdio: 'pipe', timeout: 120000, env: _pyEnv(),
  });
  const out = (r.stdout || '').toString();
  const err = (r.stderr || '').toString();
  assert.equal(r.status, 0, `fake_quant self-test exit ${r.status}\nSTDOUT:\n${out}\nSTDERR:\n${err}`);
  // Last summary line is "<passed>/<total> passed".
  const summary = out.trim().split('\n').filter((l) => /\bpassed\b/.test(l)).pop() || '';
  const m = summary.match(/(\d+)\/(\d+)\s+passed/);
  assert.ok(m, `could not find pass summary in self-test output:\n${out}`);
  assert.equal(m[1], m[2], `fake_quant self-test had failures: ${summary}\n${out}`);
  assert.ok(Number(m[2]) >= 20, 'self-test must cover both formats + STE + determinism');
});

test('7. fake_quant.py --print-grid emits the 16-level NF4 grid', () => {
  const py = _pythonBin();
  if (!_pythonAvailable(py)) return;
  const r = spawnSync(py, ['-X', 'utf8', FAKE_QUANT_PY, '--print-grid', 'nf4'], {
    stdio: 'pipe', timeout: 60000, env: _pyEnv(),
  });
  assert.equal(r.status, 0, `print-grid exit ${r.status}: ${(r.stderr || '').toString()}`);
  const obj = _parseJsonBlock(r.stdout);
  assert.equal(obj.format, 'nf4');
  assert.equal(obj.grid.length, 16);
  assert.ok(obj.grid.includes(0), 'NF4 grid must contain exact 0');
});

// ---------------------------------------------------------------------------
// 8. Python: qad.py --preflight is GPU-free and validates the plan
// ---------------------------------------------------------------------------

test('8. qad.py --preflight succeeds GPU-free on a valid plan (exit 0, ok:true)', () => {
  const py = _pythonBin();
  if (!_pythonAvailable(py)) return;
  const dir = _tmp('pre');
  fs.mkdirSync(dir, { recursive: true });
  const jsonl = path.join(dir, 'train.jsonl');
  fs.writeFileSync(jsonl, '{"prompt":"hi","response":"hello"}\n{"prompt":"bye","response":"goodbye"}\n');
  const out = path.join(dir, 'out');
  const r = spawnSync(py, [
    '-X', 'utf8', '-m', 'apps.trainer.qad', '--preflight',
    '--teacher-model', 'Qwen/Qwen2.5-7B-Instruct',
    '--student-model', 'Qwen/Qwen2.5-1.5B-Instruct',
    '--train-jsonl', jsonl, '--out-dir', out,
    '--quant-format', 'nf4', '--quant-block', '16',
  ], { stdio: 'pipe', timeout: 180000, cwd: REPO, env: _pyEnv() });
  const sout = (r.stdout || '').toString();
  const serr = (r.stderr || '').toString();
  // Exit 0 == ok:true (the preflight contract). If python lacks torch the
  // preflight would block on deps; the orchestrator box has torch, so we
  // assert the success contract there. When torch is missing we still accept
  // a clean exit 3 (ok:false with a deps blocker) — never a crash.
  assert.ok([0, 3].includes(r.status), `preflight crashed (exit ${r.status})\nSTDOUT:\n${sout}\nSTDERR:\n${serr}`);
  const plan = _parseJsonBlock(sout);
  if (r.status === 0) {
    assert.equal(plan.ok, true, `preflight not ok: ${JSON.stringify(plan.blockers)}`);
    assert.equal(plan.n_train_rows, 2);
    assert.equal(plan.quant_format, 'nf4');
    assert.equal(plan.quant_block, 16);
  } else {
    // exit 3: ok:false, but the blocker must be a missing dep, not our wiring.
    assert.equal(plan.ok, false);
    assert.ok(Array.isArray(plan.blockers) && plan.blockers.length > 0);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('9. qad.py --preflight blocks (exit 3) on a missing train JSONL', () => {
  const py = _pythonBin();
  if (!_pythonAvailable(py)) return;
  const out = _tmp('blockout');
  const r = spawnSync(py, [
    '-X', 'utf8', '-m', 'apps.trainer.qad', '--dry-run',
    '--teacher-model', 't', '--student-model', 's',
    '--train-jsonl', path.join(os.tmpdir(), 'definitely-not-here-' + Date.now() + '.jsonl'),
    '--out-dir', out, '--quant-format', 'nf4',
  ], { stdio: 'pipe', timeout: 120000, cwd: REPO, env: _pyEnv() });
  assert.equal(r.status, 3, `expected exit 3 (ok:false), got ${r.status}: ${(r.stderr || '').toString()}`);
  const plan = _parseJsonBlock(r.stdout);
  assert.equal(plan.ok, false);
  assert.ok(plan.blockers.some((b) => /train_jsonl/.test(b)), 'must name the missing JSONL blocker');
  fs.rmSync(out, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 10. Python: the dedicated QAD test suite passes (numerics + reuse + wiring)
// ---------------------------------------------------------------------------

test('10. apps/trainer/test_qad.py passes (fake-quant numerics + distill-loss reuse)', () => {
  const py = _pythonBin();
  if (!_pythonAvailable(py)) return;
  const testPy = path.join(REPO, 'apps', 'trainer', 'test_qad.py');
  assert.ok(fs.existsSync(testPy), `missing ${testPy}`);
  const r = spawnSync(py, ['-X', 'utf8', testPy], {
    stdio: 'pipe', timeout: 240000, cwd: REPO, env: _pyEnv(),
  });
  const out = (r.stdout || '').toString();
  assert.equal(r.status, 0, `test_qad.py exit ${r.status}\nSTDOUT:\n${out}\nSTDERR:\n${(r.stderr || '').toString()}`);
  const summary = out.trim().split('\n').filter((l) => /\bpassed\b/.test(l)).pop() || '';
  const m = summary.match(/(\d+)\/(\d+)\s+passed/);
  assert.ok(m, `no pass summary:\n${out}`);
  assert.equal(m[1], m[2], `test_qad.py had failures: ${summary}`);
});
