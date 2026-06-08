// W921 NEXT-3 - FP4-aware PTQ calibration PLANNER (the JS picker).
//
// This is the deterministic, dependency-free decision layer that sits in front
// of workers/quantize/scripts/quantize.py --calib-fp4. It answers two
// questions for the orchestrator / CLI without touching a GPU:
//
//   1) SHOULD we run the BATQuant-style FP4-aware calibration for this target?
//      -> yes only when the export target is an FP4 family (nvfp4 / mxfp4 /
//         fp4 / a w4a4 / w4a8 quant level) - the calibration recovers FP4/INT4
//         error and is pointless for fp8 / int8 / fp16 targets.
//
//   2) WHICH exact python flags realize that calibration?
//      -> { python_flags: ['--calib-fp4', '--calib-fp4-block=32',
//                          '--calib-fp4-max-layers=64'] }
//
// The calibration itself (block-granular learnable affine transform +
// block-wise learnable clipping, arXiv:2603.16590) lives in fp4_calib.py; the
// reason it can fail-safe is that the python pass NEVER blocks the quantize and
// records its plan in the receipt. This module only decides + emits flags.
//
// Pairs with the quant-kernel-oracle (src/quant-kernel-oracle.js, separate
// workstream): when that oracle selects an FP4 serving target, the orchestrator
// passes the resolved target dtype here to decide whether to gate the
// calibration on. Reusing its dtype vocabulary so the two stay coherent.
//
// Pure: no I/O, no clock, no global random. Every input is a function argument.

export const FP4_CALIB_PLAN_VERSION = 'fp4-calib-plan-v1';

// MXFP4 / NVFP4 hardware-native micro-scaling block size (elements per FP8
// scale). The same constant fp4_calib.py uses (MXFP4_BLOCK = 32).
export const DEFAULT_FP4_BLOCK = 32;

// Cap on how many of the largest weight tensors the calibration profiles,
// largest-first, to bound calibration time on big models. 0 == all layers.
export const DEFAULT_MAX_LAYERS = 64;

// Target dtypes / quant levels that are an FP4 family and therefore benefit
// from FP4-aware calibration. Lower-cased + normalized before matching.
const FP4_TARGET_DTYPES = new Set([
  'nvfp4',
  'mxfp4',
  'fp4',
  'fp4_e2m1',
  'e2m1',
]);

// NVFP4 export quant levels (see src/export-nvfp4.js QUANT_LEVELS) whose WEIGHT
// component is FP4. w8a8 is pure FP8 -> NOT an FP4 weight target.
const FP4_WEIGHT_QUANT_LEVELS = new Set([
  'w4a4',
  'w4a8',
]);

function _norm(s) {
  return String(s == null ? '' : s).toLowerCase().trim();
}

/**
 * Decide whether a target is an FP4-weight family that benefits from the
 * BATQuant-style calibration.
 *
 * @param {object} target
 * @param {string} [target.dtype]        e.g. 'nvfp4', 'mxfp4', 'fp8', 'int4'
 * @param {string} [target.quant_level]  e.g. 'w4a4', 'w4a8', 'w8a8'
 * @param {string} [target.format]       e.g. 'nvfp4', 'fp8', 'gptq'
 * @param {string} [target.weight_dtype] e.g. 'nvfp4', 'fp8_e4m3'
 * @returns {{ is_fp4: boolean, reason: string, matched: string|null }}
 */
export function isFp4Target(target = {}) {
  const dtype = _norm(target.dtype);
  const weightDtype = _norm(target.weight_dtype);
  const format = _norm(target.format);
  const quantLevel = _norm(target.quant_level);

  for (const [field, val] of [['weight_dtype', weightDtype],
                              ['dtype', dtype],
                              ['format', format]]) {
    if (val && FP4_TARGET_DTYPES.has(val)) {
      return { is_fp4: true, reason: `${field}=${val} is an FP4 family`, matched: val };
    }
  }
  if (quantLevel && FP4_WEIGHT_QUANT_LEVELS.has(quantLevel)) {
    // w4a8 weights are still FP4; w8a8 is FP8 and is excluded above.
    return { is_fp4: true, reason: `quant_level=${quantLevel} has FP4 weights`, matched: quantLevel };
  }
  return {
    is_fp4: false,
    reason: 'target is not an FP4 weight family (fp8/int8/int4/fp16 do not need FP4 calibration)',
    matched: null,
  };
}

/**
 * Build the FP4-aware calibration plan: whether to enable --calib-fp4 and the
 * exact python flags to pass to workers/quantize/scripts/quantize.py.
 *
 * Deterministic. No GPU. The orchestrator threads `python_flags` straight onto
 * the quantize.py invocation when `enabled` is true.
 *
 * @param {object} args
 * @param {object} args.target            see isFp4Target
 * @param {number} [args.block]           MXFP4 micro-scale block (default 32)
 * @param {number} [args.max_layers]      largest-N tensors to profile (default 64; 0=all)
 * @param {boolean} [args.force]          enable calibration even for a non-FP4 target
 *                                        (e.g. to study INT4 error; default false)
 * @returns {{
 *   version: string,
 *   enabled: boolean,
 *   reason: string,
 *   target_is_fp4: boolean,
 *   block: number,
 *   max_layers: number,
 *   algorithm: string,
 *   source: string,
 *   python_flags: string[],
 * }}
 */
export function buildFp4CalibPlan(args = {}) {
  const target = args.target || {};
  const block = Number.isInteger(args.block) && args.block > 0 ? args.block : DEFAULT_FP4_BLOCK;
  const maxLayers = Number.isInteger(args.max_layers) && args.max_layers >= 0
    ? args.max_layers
    : DEFAULT_MAX_LAYERS;
  const force = args.force === true;

  const fp4 = isFp4Target(target);
  const enabled = fp4.is_fp4 || force;

  const python_flags = enabled
    ? ['--calib-fp4', `--calib-fp4-block=${block}`, `--calib-fp4-max-layers=${maxLayers}`]
    : [];

  let reason;
  if (fp4.is_fp4) {
    reason = `FP4-aware calibration enabled: ${fp4.reason}`;
  } else if (force) {
    reason = `FP4-aware calibration force-enabled for a non-FP4 target (${fp4.reason})`;
  } else {
    reason = `FP4-aware calibration skipped: ${fp4.reason}`;
  }

  return Object.freeze({
    version: FP4_CALIB_PLAN_VERSION,
    enabled,
    reason,
    target_is_fp4: fp4.is_fp4,
    block,
    max_layers: maxLayers,
    algorithm: 'batquant-block-affine+block-clip',
    source: 'arXiv:2603.16590',
    python_flags: Object.freeze(python_flags),
  });
}

/**
 * Convenience: given a target + the base quantize.py argv (method/in/out/…),
 * return the argv with the FP4 calibration flags appended when applicable.
 * Pure - does not mutate the input array.
 *
 * @param {string[]} baseArgv
 * @param {object} planArgs  forwarded to buildFp4CalibPlan
 * @returns {{ argv: string[], plan: ReturnType<typeof buildFp4CalibPlan> }}
 */
export function withFp4CalibFlags(baseArgv, planArgs = {}) {
  const plan = buildFp4CalibPlan(planArgs);
  const argv = plan.enabled ? [...baseArgv, ...plan.python_flags] : [...baseArgv];
  return { argv, plan };
}

export default {
  FP4_CALIB_PLAN_VERSION,
  DEFAULT_FP4_BLOCK,
  DEFAULT_MAX_LAYERS,
  isFp4Target,
  buildFp4CalibPlan,
  withFp4CalibFlags,
};
