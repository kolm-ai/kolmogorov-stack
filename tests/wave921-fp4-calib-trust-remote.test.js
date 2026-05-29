// W921 NOW-1 + NEXT-3 — quantize worker gains (a) an OPT-IN --trust-remote-code
// flag threaded through every HF from_pretrained loader (default stays False
// for security) so edge models that ship custom modeling code (e.g.
// openbmb/MiniCPM5-1B) can be quantized, and (b) an additive --calib-fp4 path
// that runs an FP4-aware PTQ calibration (BATQuant-style block-granular
// learnable affine transform + block-wise learnable clipping, arXiv:2603.16590)
// before the int4 quantize to reduce FP4/INT4 error.
//
// The GPU quantize itself needs a 5090 + a real model (see needs_gpu_run), so
// this locks in the *code contract* at source level + drives the pure-CPU
// python self-test that proves the calibration math reduces reconstruction
// error vs naive round-to-nearest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  isFp4Target,
  buildFp4CalibPlan,
  withFp4CalibFlags,
  DEFAULT_FP4_BLOCK,
  DEFAULT_MAX_LAYERS,
} from '../src/fp4-calib-plan.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = path.join(ROOT, 'workers', 'quantize', 'scripts');
const QUANTIZE = fs.readFileSync(path.join(SCRIPTS, 'quantize.py'), 'utf8');
const FP4 = fs.readFileSync(path.join(SCRIPTS, 'fp4_calib.py'), 'utf8');

const PY = process.env.KOLM_PY || (process.platform === 'win32' ? 'python' : 'python3');

function runPy(args, opts = {}) {
  return spawnSync(PY, args, {
    encoding: 'utf8',
    cwd: SCRIPTS,
    timeout: 120_000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// NOW-1 — --trust-remote-code (opt-in, default False, threaded everywhere)
// ---------------------------------------------------------------------------

test('NOW1 #1 — --trust-remote-code is an opt-in store_true flag defaulting to False', () => {
  assert.match(QUANTIZE, /--trust-remote-code/, 'flag must be declared');
  assert.match(
    QUANTIZE,
    /add_argument\("--trust-remote-code",\s*dest="trust_remote_code",\s*\n?\s*action="store_true",\s*default=False/,
    'flag must be store_true with default=False (secure default)');
});

test('NOW1 #2 — every HF from_pretrained loader threads the flag (no hardcoded =False at a call site)', () => {
  // Count the loaders that pass the threaded variable.
  const threaded = (QUANTIZE.match(/trust_remote_code=trust_remote_code/g) || []).length;
  assert.ok(threaded >= 11,
    `expected >=11 from_pretrained call sites to thread trust_remote_code, found ${threaded}`);
  // The only `trust_remote_code=False` occurrences allowed are the function
  // parameter DEFAULTS (def run_*(..., trust_remote_code=False)) — never a
  // bare hardcoded call-site override.
  const lines = QUANTIZE.split(/\r?\n/);
  for (const ln of lines) {
    if (ln.includes('trust_remote_code=False')) {
      assert.match(ln, /def .*\(.*trust_remote_code=False\)?:?/,
        `trust_remote_code=False may only appear as a def default, not at a call site: ${ln.trim()}`);
    }
  }
});

test('NOW1 #3 — all 10 run_* loaders accept the trust_remote_code parameter', () => {
  for (const fn of ['run_int_bnb', 'run_gptq', 'run_awq', 'run_aqlm', 'run_quip',
                    'run_exl2', 'run_exl3', 'run_hqq', 'run_qat', '_run_exllamav2']) {
    const re = new RegExp(`def ${fn}\\([^)]*trust_remote_code=False`);
    assert.match(QUANTIZE, re, `${fn} must accept trust_remote_code=False`);
  }
});

test('NOW1 #4 — trust_remote_code is recorded in the receipt for a verifier', () => {
  assert.match(QUANTIZE, /"trust_remote_code":\s*bool\(args\.trust_remote_code\)/,
    'top-level receipt must record trust_remote_code');
});

// ---------------------------------------------------------------------------
// NEXT-3 — FP4-aware PTQ calibration (BATQuant-style)
// ---------------------------------------------------------------------------

test('NEXT3 #1 — --calib-fp4 + tuning flags are additive opt-in (default False / 32 / 64)', () => {
  assert.match(QUANTIZE, /add_argument\("--calib-fp4",\s*dest="calib_fp4",\s*\n?\s*action="store_true",\s*default=False/);
  assert.match(QUANTIZE, /--calib-fp4-block".*\n?.*default=32/s);
  assert.match(QUANTIZE, /--calib-fp4-max-layers".*\n?.*default=64/s);
});

test('NEXT3 #2 — fp4_calib implements the BATQuant levers + the real E2M1 FP4 grid', () => {
  // Block-wise learnable clipping (sigmoid-bounded thresholds).
  assert.match(FP4, /def fit_block_clip/, 'block-wise learnable clipping');
  // Block-diagonal affine transform (relaxed / non-orthogonal).
  assert.match(FP4, /def fit_block_diag_transform/, 'block-granular affine transform');
  // E2M1 grid {0,.5,1,1.5,2,3,4,6} +/-.
  assert.match(FP4, /_E2M1_POS\s*=\s*\(0\.0,\s*0\.5,\s*1\.0,\s*1\.5,\s*2\.0,\s*3\.0,\s*4\.0,\s*6\.0\)/);
  // MXFP4 micro-scaling block size 32.
  assert.match(FP4, /MXFP4_BLOCK\s*=\s*32/);
  // Cites the paper.
  assert.match(FP4, /2603\.16590/);
});

test('NEXT3 #3 — calibration plan is recorded in the receipt only when --calib-fp4 is set', () => {
  assert.match(QUANTIZE, /if args\.calib_fp4:/, 'calibration runs only under the opt-in flag');
  assert.match(QUANTIZE, /receipt\["fp4_calibration"\]\s*=\s*fp4_calib_plan/);
  assert.match(QUANTIZE, /fp4_calib_plan is not None/);
});

test('NEXT3 #4 — calibration degrades gracefully and never blocks the quantize', () => {
  // run_fp4_calibration must catch and return {ok:False, reason:...} not raise.
  assert.match(QUANTIZE, /def run_fp4_calibration/);
  assert.match(QUANTIZE, /except Exception as e:[\s\S]*?fp4 calibration raised/);
});

// ---------------------------------------------------------------------------
// Live math verification — drive the pure-CPU python self-tests.
// ---------------------------------------------------------------------------

test('NEXT3 #5 — fp4_calib --self-test passes (CPU, deterministic, error reduction)', () => {
  const probe = runPy(['-c', 'import numpy']);
  if (probe.status !== 0) {
    // numpy not importable in this environment — skip the live math run but
    // keep the source-level locks above as the contract.
    console.error('[wave921-fp4] numpy unavailable; skipping live self-test');
    return;
  }
  const r = runPy([path.join(SCRIPTS, 'fp4_calib.py'), '--self-test']);
  assert.equal(r.status, 0, `fp4_calib self-test must exit 0:\n${r.stdout}\n${r.stderr}`);
  // The self-test prints a single (multi-line, indented) JSON object.
  const out = JSON.parse(r.stdout.trim());
  assert.equal(out.ok, true, `self-test not ok: ${JSON.stringify(out.failures)}`);
  assert.ok(out.mean_improvement_total > 0,
    `FP4 calibration must reduce reconstruction MSE vs naive: ${out.mean_improvement_total}`);
});

test('NEXT3 #6 — full python test suite (math + safetensors driver) passes', () => {
  const probe = runPy(['-c', 'import numpy, safetensors']);
  if (probe.status !== 0) {
    console.error('[wave921-fp4] numpy/safetensors unavailable; skipping driver suite');
    return;
  }
  const r = runPy([path.join(SCRIPTS, 'test_fp4_calib.py')]);
  assert.equal(r.status, 0, `python test suite must pass:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /7\/7 passed/, r.stdout);
});

test('NEXT3 #7 — quantize.py --help advertises both new flags', () => {
  const r = runPy([path.join(SCRIPTS, 'quantize.py'), '--help']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--trust-remote-code/);
  assert.match(r.stdout, /--calib-fp4/);
});

// ---------------------------------------------------------------------------
// JS picker — src/fp4-calib-plan.js (decides when to gate the calibration on
// + emits the exact quantize.py flags).
// ---------------------------------------------------------------------------

test('PICKER #1 — FP4 targets enable the calibration, FP8/INT do not', () => {
  for (const t of [{ dtype: 'nvfp4' }, { dtype: 'mxfp4' }, { weight_dtype: 'nvfp4' },
                   { quant_level: 'w4a4' }, { quant_level: 'w4a8' }, { format: 'fp4_e2m1' }]) {
    assert.equal(isFp4Target(t).is_fp4, true, `expected FP4 for ${JSON.stringify(t)}`);
    assert.equal(buildFp4CalibPlan({ target: t }).enabled, true);
  }
  for (const t of [{ dtype: 'fp8' }, { dtype: 'int4' }, { dtype: 'int8' },
                   { quant_level: 'w8a8' }, { dtype: 'fp16' }, {}]) {
    assert.equal(isFp4Target(t).is_fp4, false, `expected non-FP4 for ${JSON.stringify(t)}`);
    assert.equal(buildFp4CalibPlan({ target: t }).enabled, false);
  }
});

test('PICKER #2 — plan emits the exact python flags + defaults', () => {
  const plan = buildFp4CalibPlan({ target: { dtype: 'nvfp4' } });
  assert.deepEqual([...plan.python_flags], [
    '--calib-fp4',
    `--calib-fp4-block=${DEFAULT_FP4_BLOCK}`,
    `--calib-fp4-max-layers=${DEFAULT_MAX_LAYERS}`,
  ]);
  assert.equal(plan.block, 32);
  assert.equal(plan.max_layers, 64);
  assert.equal(plan.algorithm, 'batquant-block-affine+block-clip');
  assert.equal(plan.source, 'arXiv:2603.16590');
  // A disabled plan emits zero flags.
  assert.deepEqual([...buildFp4CalibPlan({ target: { dtype: 'fp8' } }).python_flags], []);
});

test('PICKER #3 — custom block/max_layers + force override', () => {
  const plan = buildFp4CalibPlan({ target: { dtype: 'mxfp4' }, block: 16, max_layers: 0 });
  assert.deepEqual([...plan.python_flags], [
    '--calib-fp4', '--calib-fp4-block=16', '--calib-fp4-max-layers=0',
  ]);
  // force enables for a non-FP4 target (e.g. studying INT4 error) but flags it.
  const forced = buildFp4CalibPlan({ target: { dtype: 'int4' }, force: true });
  assert.equal(forced.enabled, true);
  assert.equal(forced.target_is_fp4, false);
  assert.match(forced.reason, /force-enabled/);
});

test('PICKER #4 — withFp4CalibFlags appends flags without mutating base argv', () => {
  const base = ['workers/quantize/scripts/quantize.py', '--method=int4',
                '--in=/m/in', '--out=/m/out'];
  const { argv, plan } = withFp4CalibFlags(base, { target: { dtype: 'nvfp4' } });
  assert.equal(base.length, 4, 'base argv must not be mutated');
  assert.ok(argv.includes('--calib-fp4'));
  assert.equal(argv.length, base.length + 3);
  assert.equal(plan.enabled, true);
  // Non-FP4 target returns a copy of base, unchanged.
  const r2 = withFp4CalibFlags(base, { target: { dtype: 'fp8' } });
  assert.deepEqual(r2.argv, base);
  assert.notEqual(r2.argv, base, 'must return a copy, not the same reference');
});
