// W826-4 — pre-load performance estimate ("~25 tok/s on your hardware").
//
// Closes KOLM_W707_SYSTEM_UPGRADE_PLAN.md W826-4 (line 1126): "Performance
// estimate before load: '~25 tok/s on your hardware'."
//
// Pure prediction layer — never blocks load, never reaches the network. The
// numbers it returns are FORECASTS, not measurements: the UI surfaces them
// alongside a "verify with real run" affordance so users understand the
// distinction (W604 honesty contract).
//
// One export:
//
//   estimatePerformance({artifact_id, placement, hierarchy})
//      → {tok_per_sec_estimate, ttft_ms_estimate, source}
//
// Curve-fit model:
//
//   tok/s ≈ base_tok_s(params_b, quant) × placement_penalty
//
//   placement_penalty:
//     full_gpu   = 1.00   (no offload)
//     hybrid     = 0.40   (PCIe shuffle dominates)
//     nvme_mmap  = 0.10   (disk-bound; page-fault every layer)
//     cpu_only   = 0.05   (no SIMD specialization assumed)
//
//   base_tok_s(params_b, quant):
//     - Anchored to W604 reproducible matrix runs on RTX 5090:
//         Qwen2.5-7B INT4   → ~24.5 tok/s
//         Qwen2.5-3B INT4   → ~60 tok/s (extrapolated)
//         DeepSeek-R1-32B INT4 → ~11.5 tok/s
//     - Functional form: base_tok_s ≈ K_quant / sqrt(params_b)
//       (memory-bandwidth-bound scaling — empirically the right shape for
//        decode throughput on a single GPU).
//     - K_quant = 65 for INT4 / Q4 / NF4 (default), 45 for INT8, 32 for BF16.
//
// TTFT (time-to-first-token) model:
//   ttft_ms = base_ttft(params_b) × placement_penalty_inverse
//   base_ttft ≈ 80ms + 8ms × params_b for full_gpu (prefill dominated).
//
// `source` is one of:
//   'curve_fit'  — synthesized from the formula above (default path).
//   'cached_run' — a real prior benchmark exists in the event store for this
//                  exact (artifact_id, placement, gpu_name) triple.
//   'fallback'   — could not look up params from registry; conservative
//                  numbers returned + reason field populated.
//
// W604 anti-brittleness: PERF_VERSION matches /^w826-/ so a v1.x bump inside
// the wave does not force coordinated test churn.
//
// TODO(future-wave-runtime): when `kolm run` finishes a real inference, write
//   a `perf_sample` event to the event store keyed by (artifact_id, placement,
//   gpu_name). estimatePerformance should then prefer `source:'cached_run'`
//   over the curve_fit when a sample exists. Wire-up point: src/runtime.js
//   getCompiled() should call estimatePerformance once with placement from
//   placementDecision before kicking off the model load.

import { info as modelInfo } from './models.js';

export const PERF_VERSION = 'w826-v1';

// Placement penalty factors. Each is the fraction of full-GPU throughput
// retained at that placement. cpu_only and nvme_mmap intentionally rounded
// down — better to under-promise; if reality is faster the user is happy.
export const PLACEMENT_PENALTY = Object.freeze({
  full_gpu: 1.0,
  hybrid: 0.4,
  nvme_mmap: 0.1,
  cpu_only: 0.05,
});

// Quant scaling constants K_quant in base_tok_s = K_quant / sqrt(params_b).
// W604 matrix run anchors: Qwen2.5-7B NF4 → ~24.5 tok/s → K ≈ 65.
export const K_QUANT = Object.freeze({
  int4: 65,
  nf4: 65,
  q4: 65,
  q4_0: 65,
  q4_k_m: 65,
  int8: 45,
  q8: 45,
  bf16: 32,
  fp16: 32,
  fp32: 18,
});

// Base TTFT (ms) at full_gpu. Prefill is roughly linear in params_b for a
// single-prompt batch, so 80ms fixed overhead + 8ms per billion params is a
// reasonable first-order fit for a 500-token prompt.
function _baseTtftMs(paramsB) {
  return 80 + 8 * Math.max(0.5, paramsB);
}

// ---------------------------------------------------------------------------
// estimatePerformance
// ---------------------------------------------------------------------------
//
// Input:
//   artifact_id: string. Looked up against src/models.js MODELS registry to
//                pull params_b. If the registry does not have it, we fall
//                back to a conservative 7B assumption with source:'fallback'.
//   placement:  one of {full_gpu, hybrid, nvme_mmap, cpu_only}. Required.
//                Unknown placement → cpu_only penalty (most conservative).
//   hierarchy:  memory hierarchy snapshot from runtime-placement. Optional.
//                If present, includes the GPU name in the rationale; future
//                versions will adjust the GPU-class multiplier here.
//
// Output:
//   {
//     tok_per_sec_estimate: number,    // rounded to 1 decimal
//     ttft_ms_estimate: number,        // rounded to whole ms
//     source: 'curve_fit' | 'cached_run' | 'fallback',
//     placement: string,
//     params_b: number,
//     quant: 'int4' | 'int8' | 'bf16' | ...,
//     rationale: string,
//     version: 'w826-v1',
//   }

export function estimatePerformance(opts = {}) {
  const artifact_id = opts.artifact_id || null;
  const placement = String(opts.placement || '').toLowerCase();
  const hierarchy = opts.hierarchy || null;

  // Look up params_b from MODELS registry. Most artifacts are compiled from a
  // base in MODELS, so this hits for the common case. When it misses (e.g.
  // user-uploaded weights), we still return numbers — but with a fallback
  // source label so the UI can show "estimate is rough."
  let modelHit = null;
  if (artifact_id) {
    modelHit = modelInfo(artifact_id);
    if (!modelHit) {
      // Strip any quant suffix or path component a caller may have appended.
      // e.g. "Qwen/Qwen2.5-7B-Instruct@int4" → "Qwen/Qwen2.5-7B-Instruct".
      const stripped = String(artifact_id).split('@')[0].split('#')[0];
      modelHit = modelInfo(stripped);
    }
  }

  // Default to 7B / INT4 when the registry doesn't know the artifact. This
  // matches the W604 "DEFAULT_MODEL = Qwen/Qwen2.5-3B-Instruct" but biased a
  // little larger so we never UNDER-warn about VRAM needs. We mark source as
  // 'fallback' so the UI can label appropriately.
  const params_b = modelHit ? Number(modelHit.params_b) : 7.0;
  const quant = _detectQuant(opts.quant) || (modelHit ? 'int4' : 'int4');
  const k = K_QUANT[quant] != null ? K_QUANT[quant] : K_QUANT.int4;

  // Pick the placement penalty. Unknown placement → cpu_only (most
  // conservative; never promise a number that requires GPU when we can't
  // confirm the placement is GPU-resident).
  const penalty = PLACEMENT_PENALTY[placement] != null
    ? PLACEMENT_PENALTY[placement]
    : PLACEMENT_PENALTY.cpu_only;

  // Curve-fit core. sqrt(params_b) is the bandwidth-bound decode shape.
  const base_tok_s = k / Math.sqrt(Math.max(0.5, params_b));
  const tok_per_sec_estimate = Number((base_tok_s * penalty).toFixed(1));

  // TTFT inverse-scales with penalty: nvme_mmap takes ~10x as long to first
  // token because the prefill weights must page in from disk. We invert the
  // penalty (capped at 1/0.05 = 20x). Cap is important — otherwise cpu_only
  // would inflate ttft to absurd numbers.
  const inverse = Math.min(20, 1 / Math.max(0.05, penalty));
  const ttft_ms_estimate = Math.round(_baseTtftMs(params_b) * inverse);

  // Source label: 'fallback' when the registry didn't know the artifact;
  // 'curve_fit' otherwise. (cached_run is reserved for a future wave that
  // wires real perf samples into the event store.)
  const source = modelHit ? 'curve_fit' : 'fallback';

  const gpuName = hierarchy && Array.isArray(hierarchy.gpu) && hierarchy.gpu[0]
    ? hierarchy.gpu[0].name
    : 'unknown_gpu';

  const rationale = source === 'fallback'
    ? `no_registry_match; assumed_params_b=${params_b}; quant=${quant}; placement=${placement}; penalty=${penalty}; gpu=${gpuName}`
    : `params_b=${params_b}; quant=${quant}; K=${k}; placement=${placement}; penalty=${penalty}; gpu=${gpuName}`;

  return {
    tok_per_sec_estimate,
    ttft_ms_estimate,
    source,
    placement: PLACEMENT_PENALTY[placement] != null ? placement : 'cpu_only',
    params_b,
    quant,
    rationale,
    version: PERF_VERSION,
  };
}

// Normalize a free-form quant label. Accepts "int4"/"INT4"/"q4_0"/"NF4"/"Q4_K_M"
// and returns the canonical K_QUANT key. Returns null when unrecognized so
// the caller can fall back to a default.
function _detectQuant(raw) {
  if (!raw) return null;
  const key = String(raw).toLowerCase().replace(/-/g, '_');
  if (K_QUANT[key] != null) return key;
  if (/int4|nf4|q4/.test(key)) return 'int4';
  if (/int8|q8/.test(key)) return 'int8';
  if (/bf16|fp16/.test(key)) return 'bf16';
  if (/fp32/.test(key)) return 'fp32';
  return null;
}

export default {
  PERF_VERSION,
  PLACEMENT_PENALTY,
  K_QUANT,
  estimatePerformance,
};
