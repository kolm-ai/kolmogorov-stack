// src/compute/estimator.js
//
// Cost + duration estimator for a training spec on a chosen backend.
//
// Why this exists: before someone rents a $2.50/hr H100 from Modal or a
// $0.50/hr 4090 from Vast, they should see "this run will cost ~$3 and take
// ~90 minutes." The estimator never charges anyone — it just renders a
// plausible bound from the spec shape.
//
// The estimate combines three signals:
//   1. Spec size: number of training examples × epochs × per-example cost
//   2. Model size: base-model parameter count from src/models.js
//   3. Backend perf factor: relative tokens/sec class for the backend
//
// We expose:
//   estimate(spec, backendName)  → { duration_seconds, cost_usd, breakdown }
//   estimateAll(spec)            → array of estimates across all backends
//
// Out of scope: actual benchmark calibration. The numbers are deliberately
// conservative (2x slack) so quoted prices over-deliver, not under-deliver.

import { list as listBackends, info as backendInfo } from './index.js';

// Reference throughputs in tokens/sec for a 3B-parameter LoRA SFT step,
// batch 4, seq 1024. Sourced from public Unsloth / TRL benchmarks and our
// own dev-box measurements. Conservative — real throughput often higher.
const REFERENCE_TPS_3B = {
  'local-cpu': 50,
  'local-cuda': 4500,      // RTX 4090 / 5090 class
  'local-mps': 800,        // M3 Max
  'local-mlx': 1200,       // M3 Max native
  'local-rocm': 3500,      // MI300X / 7900 XTX
  'local-directml': 1200,
  'modal': 5500,           // A100-40 / 80
  'runpod': 6000,          // H100 80
  'together': 4000,        // managed, opaque
  'vast': 5000,            // 4090 / A100 mix
  'lambda': 5500,          // A100/H100
  'replicate': 4500,       // A40/A100
  'remote-ssh': 4000,      // unknown — assume Ampere class
  'fal': 0,                // infer-only
};

// How throughput scales with parameter count. Empirical: 3B → 7B = ~0.55x
// throughput, 7B → 14B = ~0.55x again. Coarse but correct shape.
function paramScaleFactor(paramsB) {
  if (paramsB <= 1.5) return 1.6;
  if (paramsB <= 3) return 1.0;
  if (paramsB <= 7) return 0.55;
  if (paramsB <= 14) return 0.30;
  if (paramsB <= 30) return 0.15;
  return 0.07;
}

// Translate a spec to an example-token budget.
//   tokens_per_step ≈ batch_size × seq_len
//   total_steps    ≈ examples × epochs / batch_size
//   total_tokens   = tokens_per_step × total_steps
function totalTokens(spec) {
  const examples = Math.max(1, spec.examples || spec.n_examples || 200);
  const epochs = Math.max(1, spec.epochs || 3);
  const batch = Math.max(1, spec.batch_size || 4);
  const seq = Math.max(64, spec.seq_len || spec.max_seq_length || 1024);
  const steps = Math.ceil((examples * epochs) / batch);
  return { steps, total_tokens: steps * batch * seq, batch, seq };
}

// Resolve a model size in billions of parameters from spec.base_model.
// Falls back to 3B if we can't find a match.
function resolveParamsB(baseModelId) {
  if (!baseModelId) return 3.0;
  const m = /([0-9]+(?:\.[0-9]+)?)B/i.exec(baseModelId);
  if (m) return parseFloat(m[1]);
  return 3.0;
}

export function estimate(spec, backendName) {
  const b = backendInfo(backendName);
  if (!b) throw new Error(`unknown backend: ${backendName}`);
  if (!b.train) {
    return {
      backend: backendName,
      supported: false,
      reason: 'backend does not support training',
    };
  }

  const paramsB = resolveParamsB(spec.base_model || spec.base_model_id);
  const { total_tokens, steps, batch, seq } = totalTokens(spec);

  const baseTps = REFERENCE_TPS_3B[backendName] ?? 1000;
  const scale = paramScaleFactor(paramsB);
  const effectiveTps = Math.max(1, baseTps * scale);

  // Conservative 2x slack to absorb optimizer overhead + eval + I/O.
  const duration_seconds = Math.ceil((total_tokens / effectiveTps) * 2);

  // Cost: zero for local, per-hour for cloud. cost_per_hour_usd = null means
  // we can't quote without a real run (Together per-token, Replicate per-sec).
  let cost_usd = 0;
  let cost_basis = 'free';
  if (b.cost_per_hour_usd != null) {
    cost_usd = Number(((b.cost_per_hour_usd * duration_seconds) / 3600).toFixed(2));
    cost_basis = `$${b.cost_per_hour_usd.toFixed(2)}/hr`;
  } else if (b.kind === 'cloud-managed') {
    cost_basis = 'per-token (varies)';
    cost_usd = null;
  } else if (b.kind === 'cloud-serverless') {
    cost_basis = 'per-second (varies)';
    cost_usd = null;
  }

  return {
    backend: backendName,
    supported: true,
    duration_seconds,
    duration_human: humanDuration(duration_seconds),
    cost_usd,
    cost_basis,
    breakdown: {
      examples: spec.examples || spec.n_examples || 200,
      epochs: spec.epochs || 3,
      batch_size: batch,
      seq_len: seq,
      steps,
      total_tokens,
      base_model: spec.base_model || 'Qwen/Qwen2.5-3B-Instruct',
      base_params_b: paramsB,
      effective_tps: Math.round(effectiveTps),
      slack_factor: 2,
    },
  };
}

export function estimateAll(spec) {
  return listBackends()
    .filter((b) => b.train)
    .map((b) => estimate(spec, b.name))
    .sort((a, b) => {
      const ac = a.cost_usd == null ? 9999 : a.cost_usd;
      const bc = b.cost_usd == null ? 9999 : b.cost_usd;
      return ac - bc;
    });
}

function humanDuration(s) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.ceil(s / 60)}m`;
  const h = Math.floor(s / 3600);
  const m = Math.ceil((s % 3600) / 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

export default { estimate, estimateAll };
