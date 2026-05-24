// W787 — Compute-efficiency optimizations for the distill pipeline.
//
// Three atomic levers, each independently testable:
//
//   W787-1  Early stopping when K-Score plateaus.
//           shouldStopEarly({ kscore_history, patience, delta, min_steps })
//           returns { stop: bool, reason: <enum>, observed_delta }.
//           Wired into src/distill-pipeline.js via opts.early_stop_config.
//
//   W787-2  Mixed-precision training (FP16 / BF16 / mixed-FP16 / mixed-BF16).
//           PRECISION_MODES frozen enum + normalizeEfficiencyOptions coercer.
//           The trainer side (workers/distill/scripts/train_lora.py) ALREADY
//           reads dtype from env; W787 wires the env from the Node-side opts
//           so callers can ask for a precision without editing Python.
//
//   W787-3  Gradient checkpointing for memory-efficient distillation.
//           Boolean knob, defaults OFF on small/medium models, recommended ON
//           for >7B students or VRAM < 24 GB. Trainer reads KOLM_GRAD_CHECKPOINT
//           env var. apps/trainer/trainer_real.py ALREADY hardcodes
//           gradient_checkpointing=True; W787 makes it opt-out + surfaces it
//           in the distill envelope so users see whether it was used.
//
// HONESTY CONTRACT
//   The Node-side surface in this file is FULLY WIRED — opts validate, the
//   pipeline passes env vars to the worker, the worker forwards to Python.
//   On the Python side: train_lora.py reads KOLM_PRECISION + KOLM_GRAD_CHECKPOINT
//   + KOLM_EARLY_STOP_* envs (W787 patch). trainer_real.py reads the same envs
//   when the operator invokes that path. early_stop is implemented via a
//   transformers EarlyStoppingCallback hook the Python side has the option to
//   wire; absent that wiring, the run completes max_steps and Node-side detects
//   plateau from the worker progress.jsonl post-hoc (still useful for
//   "should I re-run with --early-stop?" decisions).
//
// W604 anti-brittleness: version strings use regex /^w787-/, no literal eq.
//
// Pure-Node, no I/O at import time, no external dep.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const EFFICIENCY_VERSION = 'w787-v1';

// W787-1 — early-stop defaults. patience = number of K-Score samples below the
// improvement threshold before we trigger stop. delta_kscore = the minimum
// per-sample K-Score uptick that "counts" as progress. min_steps prevents
// stopping during the early warm-up where K-Score is dominated by noise.
export const EARLY_STOP_DEFAULTS = Object.freeze({
  patience: 3,
  delta_kscore: 0.005,
  min_steps: 50,
});

// W787-2 — supported precision modes. fp32 is the safe baseline; fp16 and bf16
// are pure half-precision (saves memory but trades off numerical range);
// mixed-fp16 / mixed-bf16 use autocast + a master fp32 copy for the optimizer
// state (the modern standard via torch.cuda.amp). Anything outside this list
// is rejected by normalizeEfficiencyOptions.
export const PRECISION_MODES = Object.freeze(['fp32', 'fp16', 'bf16', 'mixed-fp16', 'mixed-bf16']);

// W787-2 — friendly hints surfaced through efficiencyDoctor() output. Kept here
// (frozen, single source of truth) so docs/efficiency.html can rebuild the
// same table from this export without forking the recommendation logic.
export const PRECISION_HINTS = Object.freeze({
  fp32: 'Safest baseline; only useful when bf16+fp16 trigger NaNs (rare on stable models).',
  fp16: 'Half memory + faster on Volta/Turing GPUs; numerical range smaller, watch for overflow.',
  bf16: 'Half memory + same dynamic range as fp32; preferred on Ampere/Hopper (sm_80+).',
  'mixed-fp16': 'Autocast forward in fp16, master copy in fp32; balances speed + stability.',
  'mixed-bf16': 'Autocast forward in bf16, master copy in fp32; preferred on Ampere+ for stability.',
});

// W787-1 — shouldStopEarly: pure inspection of a K-Score history array.
// Returns { stop: bool, reason: 'plateau'|'min_steps_not_met'|'history_too_short'|'no_plateau', observed_delta: number|null }.
//
// Algorithm: look at the LAST `patience+1` samples; compute the max - min
// across those samples. If max - min < delta (i.e. the K-Score barely moved)
// AND we are past min_steps, signal stop. The "+1" gives us a baseline +
// `patience` follow-ups, which matches the conventional ML "patience" semantic.
export function shouldStopEarly({
  kscore_history = [],
  patience = EARLY_STOP_DEFAULTS.patience,
  delta = EARLY_STOP_DEFAULTS.delta_kscore,
  min_steps = EARLY_STOP_DEFAULTS.min_steps,
} = {}) {
  if (!Array.isArray(kscore_history)) {
    return { stop: false, reason: 'history_too_short', observed_delta: null };
  }
  const n = kscore_history.length;
  if (n < min_steps) {
    return { stop: false, reason: 'min_steps_not_met', observed_delta: null };
  }
  const windowSize = patience + 1;
  if (n < windowSize) {
    return { stop: false, reason: 'history_too_short', observed_delta: null };
  }
  const window = kscore_history.slice(-windowSize)
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (window.length < windowSize) {
    return { stop: false, reason: 'history_too_short', observed_delta: null };
  }
  let lo = window[0];
  let hi = window[0];
  for (const v of window) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const observed_delta = hi - lo;
  if (observed_delta < delta) {
    return { stop: true, reason: 'plateau', observed_delta };
  }
  return { stop: false, reason: 'no_plateau', observed_delta };
}

// W787 — normalizeEfficiencyOptions(opts): coerces a raw caller-supplied
// efficiency block into the shape the pipeline + worker expect. Throws on
// invalid precision; clamps numeric ranges; defaults are pulled from the
// frozen constants above so adding a precision mode in ONE place updates
// every consumer (CLI flag list, docs page, doctor recommendation).
//
// Returns:
//   {
//     precision_mode: <one of PRECISION_MODES>,
//     gradient_checkpointing: bool,
//     early_stop: { enabled, patience, delta_kscore, min_steps },
//     version: EFFICIENCY_VERSION,
//     surface_only: bool,   // true when trainer wiring is partial (see honesty contract)
//   }
//
// `surface_only` is FALSE for precision_mode + gradient_checkpointing (trainer
// reads the env vars). It is TRUE for early_stop because the Python side
// callback is conditional; Node-side detection still runs but the worker
// itself does not stop mid-step until the trainer-side patch lands.
export function normalizeEfficiencyOptions(opts = {}) {
  const raw = (opts && typeof opts === 'object') ? opts : {};
  const precision_raw = raw.precision_mode == null ? 'bf16' : String(raw.precision_mode).toLowerCase();
  if (!PRECISION_MODES.includes(precision_raw)) {
    const err = new Error(`precision_mode must be one of [${PRECISION_MODES.join(', ')}]; got ${JSON.stringify(raw.precision_mode)}`);
    err.code = 'invalid_precision_mode';
    throw err;
  }
  const gradient_checkpointing = raw.gradient_checkpointing === true
    || raw.gradient_checkpointing === 'true'
    || raw.gradient_checkpointing === 1;
  const esRaw = (raw.early_stop_config && typeof raw.early_stop_config === 'object') ? raw.early_stop_config : {};
  const patience = Number.isFinite(Number(esRaw.patience)) && Number(esRaw.patience) > 0
    ? Math.min(50, Math.floor(Number(esRaw.patience)))
    : EARLY_STOP_DEFAULTS.patience;
  const delta = Number.isFinite(Number(esRaw.delta_kscore)) && Number(esRaw.delta_kscore) >= 0
    ? Number(esRaw.delta_kscore)
    : EARLY_STOP_DEFAULTS.delta_kscore;
  const min_steps = Number.isFinite(Number(esRaw.min_steps)) && Number(esRaw.min_steps) >= 0
    ? Math.floor(Number(esRaw.min_steps))
    : EARLY_STOP_DEFAULTS.min_steps;
  const early_stop_enabled = esRaw.enabled === true
    || esRaw.enabled === 'true'
    || esRaw.enabled === 1
    || (raw.early_stop === true);
  return {
    precision_mode: precision_raw,
    gradient_checkpointing,
    early_stop: {
      enabled: !!early_stop_enabled,
      patience,
      delta_kscore: delta,
      min_steps,
    },
    version: EFFICIENCY_VERSION,
    // Surface-only for the early-stop branch until the trainer-side
    // EarlyStoppingCallback patch lands; precision + grad_checkpoint flow
    // through env vars the trainer already honours (or, for fields the
    // trainer hasn't read yet, the patch ships in the same commit so the
    // CLI surface and the trainer agree).
    surface_only: !!early_stop_enabled,
  };
}

// W787 — efficiencyDoctor: read the cached GPU probe at
// ~/.kolm/devices/local.json (written by src/device-capabilities.js
// detectLocalDevice()), recommend a precision + gradient_checkpointing
// setting, and return an honest envelope when no probe exists. The probe
// records `compute_capability` (sm_major.sm_minor) and `vram_mib`; the
// recommendation logic is the simplest correct rule:
//
//   sm >= 8.0 (Ampere+)  -> mixed-bf16 + grad_checkpoint:false unless vram_mib < 24576
//   sm >= 7.0 (Volta/Turing) -> mixed-fp16 + grad_checkpoint:false unless vram_mib < 16384
//   sm <  7.0 OR CPU only  -> fp32 + grad_checkpoint:true
//
// Returns:
//   { ok: bool, source: 'cached_probe'|'no_probe', probe?, recommendation?: {...}, hint? }
export function efficiencyDoctor({ probePath = null } = {}) {
  const home = process.env.KOLM_HOME || process.env.HOME || process.env.USERPROFILE || os.homedir();
  const resolved = probePath || path.join(home, '.kolm', 'devices', 'local.json');
  let probe = null;
  let probeErr = null;
  try {
    if (fs.existsSync(resolved)) {
      probe = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    }
  } catch (e) {
    probeErr = e && e.message ? e.message : String(e);
  }
  if (!probe) {
    return {
      ok: false,
      source: 'no_probe',
      probe_path: resolved,
      hint: 'run `kolm devices detect` first to write a local probe, then re-run this doctor',
      probe_error: probeErr,
      version: EFFICIENCY_VERSION,
    };
  }
  // Pull compute capability + vram from whatever shape the probe used; we
  // accept a few aliases so older probes (pre-W787) still produce a hint.
  const cap = probe.compute_capability
    || probe.sm
    || (probe.sm_major != null && probe.sm_minor != null ? `${probe.sm_major}.${probe.sm_minor}` : null);
  const vram = Number(probe.vram_mib || probe.vram_mb || probe.total_memory_mib || 0);
  let sm = NaN;
  if (typeof cap === 'string') {
    const m = cap.match(/^(\d+)\.(\d+)/);
    if (m) sm = Number(m[1]) + Number(m[2]) / 10;
  } else if (typeof cap === 'number') {
    sm = cap;
  }
  let precision_mode;
  let gradient_checkpointing;
  let rationale;
  if (!Number.isFinite(sm) || sm <= 0) {
    precision_mode = 'fp32';
    gradient_checkpointing = true;
    rationale = 'no_gpu_detected: defaulting to fp32 + gradient_checkpointing for CPU/small-mem safety';
  } else if (sm >= 8.0) {
    precision_mode = 'mixed-bf16';
    gradient_checkpointing = vram > 0 && vram < 24 * 1024;
    rationale = `Ampere+ (sm ${sm}): bf16 has fp32 range + fits autocast; grad_checkpoint=${gradient_checkpointing} for vram=${vram} MiB`;
  } else if (sm >= 7.0) {
    precision_mode = 'mixed-fp16';
    gradient_checkpointing = vram > 0 && vram < 16 * 1024;
    rationale = `Volta/Turing (sm ${sm}): fp16 autocast; bf16 not available; grad_checkpoint=${gradient_checkpointing}`;
  } else {
    precision_mode = 'fp32';
    gradient_checkpointing = true;
    rationale = `pre-Volta (sm ${sm}): safe fp32 baseline + grad_checkpoint to fit small VRAM`;
  }
  return {
    ok: true,
    source: 'cached_probe',
    probe_path: resolved,
    probe: { compute_capability: cap, vram_mib: vram, raw: probe },
    recommendation: {
      precision_mode,
      gradient_checkpointing,
      early_stop_enabled: true,
      early_stop_config: { ...EARLY_STOP_DEFAULTS },
      rationale,
    },
    version: EFFICIENCY_VERSION,
  };
}

// W787 — build the env-var slice that the worker / Python trainer reads. Pure
// helper, exported so tests can assert the exact wire-format passed through.
// We use KOLM_-prefixed names so a stray torch shell variable cannot collide.
export function buildEfficiencyEnv(normalized) {
  if (!normalized || typeof normalized !== 'object') return {};
  const out = {};
  out.KOLM_PRECISION = normalized.precision_mode;
  out.KOLM_GRAD_CHECKPOINT = normalized.gradient_checkpointing ? '1' : '0';
  if (normalized.early_stop && normalized.early_stop.enabled) {
    out.KOLM_EARLY_STOP = '1';
    out.KOLM_EARLY_STOP_PATIENCE = String(normalized.early_stop.patience);
    out.KOLM_EARLY_STOP_DELTA = String(normalized.early_stop.delta_kscore);
    out.KOLM_EARLY_STOP_MIN_STEPS = String(normalized.early_stop.min_steps);
  } else {
    out.KOLM_EARLY_STOP = '0';
  }
  return out;
}

export default {
  EFFICIENCY_VERSION,
  EARLY_STOP_DEFAULTS,
  PRECISION_MODES,
  PRECISION_HINTS,
  shouldStopEarly,
  normalizeEfficiencyOptions,
  efficiencyDoctor,
  buildEfficiencyEnv,
};
