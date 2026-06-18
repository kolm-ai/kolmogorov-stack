// src/carbon-estimator.js
//
// W786 - Carbon footprint / CO2 estimator.
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 744-748):
//   [W786-1] CO2 estimate per distillation run (GPU type, duration, grid carbon)
//   [W786-2] CO2 savings report: "Running .kolm locally saved X kg CO2 vs cloud frontier API"
//   [W786-3] Sustainability badge on .kolm artifacts
//
// =====================================================================
// HONESTY CONTRACT
// =====================================================================
//
// Every value this module returns is a MODELED ESTIMATE built from public
// vendor TDP numbers and public grid carbon intensities. Nothing in this
// module is measured. The output envelope MUST carry:
//
//   methodology         : 'public-research-estimate'
//   methodology_version : 'w786-v1'
//   honest_caveat       : 'estimate_not_measured'
//   error_bar_pct       : 30  (the +/- 30% error bar the marketing page already promises)
//
// W604 ANTI-BRITTLENESS: version stamp matches /^w786-/. Sibling tests use
// the regex+threshold family pattern (never an explicit hard-coded array).
//
// =====================================================================
// DESIGN
// =====================================================================
//
// 1. PURE FUNCTIONS ONLY. No I/O, no fs, no fetch, no random.
//    estimateRunCo2 / estimateFrontierCallCo2 / savingsReport / badgeFor
//    all take plain inputs and return plain objects. This makes the module
//    trivially testable and lets it run in a worker / WASM / browser.
//
// 2. SHARED ENVELOPE. Every estimator emits the same methodology stamp so a
//    downstream tool can grep ONE field instead of N. The model-card-emit
//    sibling (W768) uses 'static_grid_average_w768_v1' for the model-card
//    flavor of the same math; we keep the W786 stamp distinct so consumers
//    can tell which path produced the number.
//
// 3. BADGE IS POST-HASH METADATA. badgeFor produces a structure suitable for
//    embedding in a .kolm manifest as `sustainability_badge`. It is keyed
//    AFTER artifact_hash_input so legacy artifacts remain byte-stable; a
//    tamperer flipping the badge after build does NOT break receipt.json
//    (the badge is a hygiene signal, not provenance). The matching write
//    site lives in src/artifact.js buildPayload.
//
// 4. NUMBERS ARE PUBLIC. Sources cited inline next to every constant so a
//    third-party auditor can grep + diff.

export const CARBON_VERSION = 'w786-v1';
export const CARBON_LIMITS = Object.freeze({
  max_gpu_hours: 1000000,
  max_tokens: 10000000000,
  max_label_chars: 120,
});

// =====================================================================
// PUBLIC TDP MAP (watts at sustained training load, single card)
// =====================================================================
//
// Sources: NVIDIA / Apple / Intel published datasheets. Rounded to the
// nearest 5W per the W786 honesty contract. We are NOT claiming sub-watt
// fidelity. Add new SKUs by appending here; older SKUs MUST stay so legacy
// estimates reproduce byte-identical.
//
// W604 ANTI-BRITTLENESS: this is a Map, frozen, with a stable lookup helper
// below. Callers must use gpuTdpWatts() so unknown SKUs return a clean
// envelope, not undefined.
export const GPU_TDP_W = Object.freeze({
  // NVIDIA datacenter
  'A100-80GB':   400,
  'A100-40GB':   400,
  'H100-SXM5':   700,
  'H100-PCIe':   350,
  'H200':        700,
  'B200':       1000,
  'L40S':        350,
  // NVIDIA consumer / workstation
  'RTX-5090':    575,
  'RTX-4090':    450,
  'RTX-3090':    350,
  'RTX-A6000':   300,
  // AMD datacenter
  'MI300X':      750,
  // Apple Silicon (rounded total-package watts under sustained ML load)
  'M2-Ultra':    215,
  'M3-Max':       90,
  'M4-Max':      110,
  // CPU fallback bucket. When the caller passes an unknown SKU OR an
  // explicit CPU label, we want a non-zero default so the math still works.
  'CPU-default':  95,
});

// =====================================================================
// PUBLIC GRID CARBON INTENSITY (kg CO2 per kWh)
// =====================================================================
//
// Sources: IEA 2024 World Energy Outlook + cloud-provider public regional
// disclosures (AWS / GCP / Azure 2024-2025 sustainability reports). These
// are annual averages, NOT hourly real-time intensity. ElectricityMap and
// WattTime provide hourly data but require an API key + network egress,
// which would defeat the air-gap design.
//
// global-avg matches the W768 GLOBAL_GRID_CO2_KG_PER_KWH (0.475) so the
// two estimators stay reconcilable. Region keys mirror common cloud-region
// nomenclature so the caller can pass through whatever their host expects.
export const GRID_CARBON_KGCO2_PER_KWH = Object.freeze({
  'us-west-2':       0.18,
  'us-west-1':       0.21,
  'us-east-1':       0.40,
  'us-east-2':       0.45,
  'eu-west-1':       0.30,
  'eu-west-2':       0.21,
  'eu-central-1':    0.45,
  'eu-north-1':      0.05,
  'ap-northeast-1':  0.50,
  'ap-northeast-2':  0.45,
  'ap-south-1':      0.70,
  'ap-southeast-1':  0.45,
  'ap-southeast-2':  0.65,
  'global-avg':      0.475,
});

// =====================================================================
// FRONTIER API per-token watt-hour estimates
// =====================================================================
//
// Source: published research (Patterson et al. 2021, Luccioni et al. 2024,
// EpochAI 2024 inference-cost surveys). These cover the inference-time
// energy of a single forward pass on hosted frontier hardware (H100 class)
// at typical batch sizes. They are MODELED upper bounds - vendor-internal
// power draw is not disclosed.
//
// Wh per 1k tokens. The published range is ~0.2-0.5 Wh/1k for small models
// and 2-10 Wh/1k for frontier-class. We hardcode three buckets keyed by
// a coarse `model_size_class` enum so callers do not have to guess.
//
// model_size_class enum: 'small' | 'medium' | 'large'
//   small  : up to ~10B params (Haiku 3.5, GPT-4o-mini, Gemini Flash)
//   medium : 10B-200B params   (Sonnet 4.7, GPT-4o, Gemini Pro)
//   large  : 200B+ params      (Opus 4.7, GPT-4.5, Gemini Ultra)
//
// Provider keys exist so future tuning can differentiate per-vendor TDP
// disclosures; today all three providers use the same per-class numbers
// because we lack disclosed per-vendor measurements.
const FRONTIER_WH_PER_KTOKENS = Object.freeze({
  openai:    Object.freeze({ small: 0.3, medium: 2.5, large: 7.0 }),
  anthropic: Object.freeze({ small: 0.3, medium: 2.5, large: 7.0 }),
  google:    Object.freeze({ small: 0.3, medium: 2.5, large: 7.0 }),
});

// Frontier providers run mostly in US-East + EU-West datacenters per their
// public disclosures. We approximate with a weighted average that lands
// near the global-avg but skews slightly higher to reflect heavy us-east
// (40%) + ap (50%) load. The exact mix is opaque, so the value is rounded.
const FRONTIER_GRID_KGCO2_PER_KWH = 0.42;

// =====================================================================
// HELPERS
// =====================================================================

function _round(v, places) {
  const p = Math.pow(10, places || 6);
  return Math.round(Number(v) * p) / p;
}

function _safeLabel(value) {
  if (value == null) return null;
  return String(value).replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, CARBON_LIMITS.max_label_chars) || null;
}

function _normalizeRegion(region) {
  if (region == null || region === '') return 'global-avg';
  const r = String(region).trim().toLowerCase();
  // Accept both UPPER and lower SKU-style spellings for grid keys.
  const keys = Object.keys(GRID_CARBON_KGCO2_PER_KWH);
  for (const k of keys) {
    if (k.toLowerCase() === r) return k;
  }
  return null; // signal unknown to the caller
}

function _normalizeGpu(gpu) {
  if (gpu == null || gpu === '') return null;
  const g = String(gpu).trim();
  // Exact match first (preserves the canonical spelling in the output).
  if (Object.prototype.hasOwnProperty.call(GPU_TDP_W, g)) return g;
  // Case-insensitive fallback.
  const keys = Object.keys(GPU_TDP_W);
  const lower = g.toLowerCase();
  for (const k of keys) {
    if (k.toLowerCase() === lower) return k;
  }
  return null;
}

// PUBLIC: gpuTdpWatts(sku) -> number | null
// Returns the published TDP for a known SKU, null otherwise. Callers can
// inspect for null and fall back to CPU-default if they want a non-zero
// estimate.
export function gpuTdpWatts(sku) {
  const k = _normalizeGpu(sku);
  return k == null ? null : GPU_TDP_W[k];
}

// PUBLIC: gridCarbonKgPerKwh(region) -> number | null
export function gridCarbonKgPerKwh(region) {
  const k = _normalizeRegion(region);
  return k == null ? null : GRID_CARBON_KGCO2_PER_KWH[k];
}

// =====================================================================
// PUBLIC: estimateRunCo2({gpu, gpu_hours, region, utilization})
// =====================================================================
//
// Returns:
//   {
//     ok, version,
//     gpu, gpu_tdp_w, region, grid_factor,
//     gpu_hours, utilization,
//     kwh, kg_co2,
//     methodology, methodology_version, honest_caveat, error_bar_pct,
//     assumptions: { ... },
//   }
//
// gpu_hours=0 returns kwh=0, kg_co2=0 (and still stamps methodology so the
// envelope is uniform).
export function estimateRunCo2(opts) {
  const o = opts || {};
  const gpuKey = _normalizeGpu(o.gpu);
  const regionKey = _normalizeRegion(o.region);
  const utilization = (typeof o.utilization === 'number' && o.utilization > 0 && o.utilization <= 1)
    ? o.utilization
    : 0.75;
  const gpu_hours = Number(o.gpu_hours);

  if (!Number.isFinite(gpu_hours) || gpu_hours < 0 || gpu_hours > CARBON_LIMITS.max_gpu_hours) {
    return {
      ok: false,
      version: CARBON_VERSION,
      error: 'invalid_gpu_hours',
      hint: `gpu_hours must be a non-negative finite number <= ${CARBON_LIMITS.max_gpu_hours}`,
      methodology: 'public-research-estimate',
      methodology_version: CARBON_VERSION,
      honest_caveat: 'estimate_not_measured',
      error_bar_pct: 30,
    };
  }

  // Unknown SKU + unknown region: still produce a structurally-valid envelope
  // with CPU-default + global-avg fallback so the caller can render an
  // estimate_quality:low pill.
  const tdp_w = gpuKey != null ? GPU_TDP_W[gpuKey] : GPU_TDP_W['CPU-default'];
  const grid_factor = regionKey != null
    ? GRID_CARBON_KGCO2_PER_KWH[regionKey]
    : GRID_CARBON_KGCO2_PER_KWH['global-avg'];

  // kWh = (TDP_W * utilization * hours) / 1000
  const kwh = (tdp_w * utilization * gpu_hours) / 1000;
  const kg_co2 = kwh * grid_factor;

  return {
    ok: true,
    version: CARBON_VERSION,
    gpu: gpuKey || _safeLabel(o.gpu),
    gpu_known: gpuKey != null,
    gpu_tdp_w: tdp_w,
    region: regionKey || _safeLabel(o.region),
    region_known: regionKey != null,
    grid_factor,
    gpu_hours,
    utilization,
    kwh: _round(kwh, 6),
    kg_co2: _round(kg_co2, 6),
    methodology: 'public-research-estimate',
    methodology_version: CARBON_VERSION,
    honest_caveat: 'estimate_not_measured',
    error_bar_pct: 30,
    assumptions: {
      tdp_source: 'vendor_datasheet_nameplate',
      grid_source: 'iea_2024_plus_cloud_disclosures',
      utilization_default: 0.75,
      pue_factor: 1.0,
      pue_note: 'PUE not applied; caller-side dc adds ~1.1-1.5x for cloud, ~1.0-1.05x for on-prem',
    },
  };
}

// =====================================================================
// PUBLIC: estimateFrontierCallCo2({provider, tokens, model_size_class})
// =====================================================================
//
// Returns the modeled CO2 for ONE round-trip to a hosted frontier API.
// tokens covers prompt+completion (the published research bundles them).
// model_size_class is a coarse enum because exact frontier weight counts
// are usually not disclosed.
//
// Returns the same envelope shape as estimateRunCo2 so a downstream
// renderer can iterate the two side by side.
export function estimateFrontierCallCo2(opts) {
  const o = opts || {};
  const provider = String(o.provider || '').toLowerCase();
  const tokens = Number(o.tokens);
  const cls = String(o.model_size_class || 'medium').toLowerCase();
  const allowedProviders = ['openai', 'anthropic', 'google'];
  const allowedClasses = ['small', 'medium', 'large'];

  if (!allowedProviders.includes(provider)) {
    return {
      ok: false,
      version: CARBON_VERSION,
      error: 'invalid_provider',
      hint: 'provider must be one of ' + allowedProviders.join('|'),
      methodology: 'public-research-estimate',
      methodology_version: CARBON_VERSION,
      honest_caveat: 'estimate_not_measured',
      error_bar_pct: 30,
    };
  }
  if (!allowedClasses.includes(cls)) {
    return {
      ok: false,
      version: CARBON_VERSION,
      error: 'invalid_model_size_class',
      hint: 'model_size_class must be one of ' + allowedClasses.join('|'),
      methodology: 'public-research-estimate',
      methodology_version: CARBON_VERSION,
      honest_caveat: 'estimate_not_measured',
      error_bar_pct: 30,
    };
  }
  if (!Number.isFinite(tokens) || tokens < 0 || tokens > CARBON_LIMITS.max_tokens) {
    return {
      ok: false,
      version: CARBON_VERSION,
      error: 'invalid_tokens',
      hint: `tokens must be a non-negative finite number <= ${CARBON_LIMITS.max_tokens}`,
      methodology: 'public-research-estimate',
      methodology_version: CARBON_VERSION,
      honest_caveat: 'estimate_not_measured',
      error_bar_pct: 30,
    };
  }

  const wh_per_ktokens = FRONTIER_WH_PER_KTOKENS[provider][cls];
  const kwh = (tokens / 1000) * (wh_per_ktokens / 1000);
  const kg_co2 = kwh * FRONTIER_GRID_KGCO2_PER_KWH;

  return {
    ok: true,
    version: CARBON_VERSION,
    provider,
    model_size_class: cls,
    tokens,
    wh_per_ktokens,
    grid_factor: FRONTIER_GRID_KGCO2_PER_KWH,
    kwh: _round(kwh, 9),
    kg_co2: _round(kg_co2, 9),
    methodology: 'public-research-estimate',
    methodology_version: CARBON_VERSION,
    honest_caveat: 'estimate_not_measured',
    error_bar_pct: 30,
    assumptions: {
      wh_source: 'patterson_2021_luccioni_2024_epochai_2024',
      grid_source: 'frontier_provider_regions_weighted_avg',
      grid_note: 'Approximation of US-East + AP datacenter mix; exact provider mix opaque',
    },
  };
}

// =====================================================================
// PUBLIC: savingsReport({local_run, frontier_baseline})
// =====================================================================
//
// Both inputs are envelopes produced by estimateRunCo2 / estimateFrontierCallCo2
// (or any shape that exposes .kwh + .kg_co2 numerically).
//
// Returns the canonical "saved X kg CO2 vs cloud frontier API" envelope.
// saved_* may be negative when the local run draws MORE CO2 than the
// equivalent cloud call (a tiny model on a 1kW box can lose against a
// flash-class hosted endpoint); we surface the signed delta honestly and
// flag it via `local_is_greener:false` so the renderer can decide whether
// to show the pill at all.
export function savingsReport(opts) {
  const o = opts || {};
  const lr = o.local_run || {};
  const fb = o.frontier_baseline || {};

  const local_kwh = Number.isFinite(Number(lr.kwh)) ? Number(lr.kwh) : 0;
  const local_kg = Number.isFinite(Number(lr.kg_co2)) ? Number(lr.kg_co2) : 0;
  const front_kwh = Number.isFinite(Number(fb.kwh)) ? Number(fb.kwh) : 0;
  const front_kg = Number.isFinite(Number(fb.kg_co2)) ? Number(fb.kg_co2) : 0;

  const saved_kwh = front_kwh - local_kwh;
  const saved_kg_co2 = front_kg - local_kg;

  return {
    ok: true,
    version: CARBON_VERSION,
    saved_kg_co2: _round(saved_kg_co2, 9),
    saved_kwh: _round(saved_kwh, 9),
    local_is_greener: saved_kg_co2 > 0,
    breakdown: {
      local_kwh: _round(local_kwh, 9),
      local_kg_co2: _round(local_kg, 9),
      frontier_kwh: _round(front_kwh, 9),
      frontier_kg_co2: _round(front_kg, 9),
    },
    methodology: 'public-research-estimate',
    methodology_version: CARBON_VERSION,
    honest_caveat: 'estimate_not_measured',
    error_bar_pct: 30,
    methodology_note: 'Saved CO2 = (frontier_baseline_kg_co2) - (local_run_kg_co2). '
      + 'Frontier baseline is a per-call MODELED estimate from published '
      + 'research (Patterson 2021, Luccioni 2024, EpochAI 2024); local run '
      + 'is GPU TDP * duration * regional grid intensity. Both numbers carry '
      + 'a +/- 30 percent error bar. Embodied carbon (GPU manufacturing) is '
      + 'NOT included on either side. PUE not applied; cloud datacenters '
      + 'typically add 1.1-1.5x to the frontier side.',
  };
}

// =====================================================================
// PUBLIC: badgeFor(artifact) -> sustainability_badge
// =====================================================================
//
// Produces a small, stable structure suitable for embedding in the .kolm
// manifest as `sustainability_badge`. Used by src/artifact.js buildPayload
// to stamp the field POST artifact_hash so legacy artifacts remain
// byte-stable when rebuilt.
//
// The artifact argument may carry any of:
//   training_stats.gpu_hours    OR  artifact.gpu_hours
//   training_stats.gpu          OR  artifact.gpu
//   training_stats.region       OR  artifact.region
//   training_stats.utilization
//
// When inputs are missing we emit an honest envelope flagged
// estimate_quality:'unknown_inputs' rather than fabricate numbers.
export function badgeFor(artifact) {
  const a = artifact || {};
  const ts = a.training_stats || {};
  const gpu = a.gpu || ts.gpu || null;
  const region = a.region || ts.region || null;
  const gpu_hours = Number.isFinite(Number(a.gpu_hours)) ? Number(a.gpu_hours)
    : Number.isFinite(Number(ts.gpu_hours)) ? Number(ts.gpu_hours)
    : null;
  const utilization = Number.isFinite(Number(ts.utilization)) ? Number(ts.utilization) : undefined;

  if (gpu_hours == null) {
    return {
      ok: true,
      version: CARBON_VERSION,
      co2_kg_estimate: null,
      kwh: null,
      gpu: _safeLabel(gpu),
      region: _safeLabel(region),
      gpu_hours: null,
      estimate_quality: 'unknown_inputs',
      methodology: 'public-research-estimate',
      methodology_version: CARBON_VERSION,
      honest_caveat: 'estimate_not_measured',
      error_bar_pct: 30,
      note: 'training_stats.gpu_hours not supplied; CO2 cannot be estimated honestly',
    };
  }

  const run = estimateRunCo2({ gpu, gpu_hours, region, utilization });
  if (!run.ok) {
    return {
      ok: true,
      version: CARBON_VERSION,
      co2_kg_estimate: null,
      kwh: null,
      gpu: _safeLabel(gpu),
      region: _safeLabel(region),
      gpu_hours,
      estimate_quality: 'invalid_inputs',
      methodology: 'public-research-estimate',
      methodology_version: CARBON_VERSION,
      honest_caveat: 'estimate_not_measured',
      error_bar_pct: 30,
      note: run.error || 'estimateRunCo2 rejected inputs',
    };
  }

  // estimate_quality semantics:
  //   high   : both GPU + region recognized
  //   medium : one of GPU/region recognized
  //   low    : both fell back to defaults
  let quality = 'high';
  if (!run.gpu_known && !run.region_known) quality = 'low';
  else if (!run.gpu_known || !run.region_known) quality = 'medium';

  return {
    ok: true,
    version: CARBON_VERSION,
    co2_kg_estimate: run.kg_co2,
    kwh: run.kwh,
    gpu: run.gpu,
    gpu_tdp_w: run.gpu_tdp_w,
    region: run.region,
    grid_factor: run.grid_factor,
    gpu_hours: run.gpu_hours,
    utilization: run.utilization,
    estimate_quality: quality,
    methodology: 'public-research-estimate',
    methodology_version: CARBON_VERSION,
    honest_caveat: 'estimate_not_measured',
    error_bar_pct: 30,
  };
}

export default {
  CARBON_VERSION,
  CARBON_LIMITS,
  gpuTdpWatts,
  gridCarbonKgPerKwh,
  estimateRunCo2,
  estimateFrontierCallCo2,
  savingsReport,
  badgeFor,
};
