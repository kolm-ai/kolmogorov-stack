// src/runtime-passport.js
//
// R-1 — Runtime passport schema. Every .kolm artifact manifest carries a
// `runtime_passports: []` array. Each entry pins one (runtime, target_id)
// combination with a measured-or-estimated capability fingerprint:
//
//   {
//     target_id:       'gguf-q4_k_m-llama.cpp' | 'mlx-fp16' | ...
//     status:          'tested' | 'estimated' | 'unsupported'
//     runtime:         'llama.cpp' | 'vllm' | 'ollama' | 'mlx' |
//                      'transformers' | 'tensorrt-llm' | 'sglang' | 'tgi'
//     runtime_version: 'b3415' | '0.6.4' | 'mlx-lm 0.20.0' (string, free-form)
//     precision:       'fp16' | 'bf16' | 'fp8' | 'int8' | 'q4_k_m' | ...
//     memory_mb:       working-set memory the artifact occupies on this runtime
//     latency_p50_ms:  per-token decode latency, 50th pctile
//     latency_p95_ms:  per-token decode latency, 95th pctile
//     tok_s:           sustained throughput, tokens/sec
//     quality_delta:   delta vs the reference run (eval_score - reference) in
//                      raw units. 0.0 means parity; negative means worse.
//     fallback:        target_id of the recommended fallback if this runtime
//                      is unavailable on the host. null when no fallback.
//   }
//
// Rules of the road:
//   * status='tested' REQUIRES every numeric field to be a real measurement.
//     The pipeline must have actually loaded the artifact, run a probe, and
//     pulled the numbers from the runtime's own counters. No interpolation,
//     no scaling, no inference from sibling runs.
//   * status='estimated' carries the same shape but the numbers come from
//     a compile-time model (param-count + precision + a runtime constant).
//     The UI must surface the amber pill so a buyer never confuses an
//     estimate for a measurement.
//   * status='unsupported' means the (runtime, precision) combination is
//     incompatible with this artifact (e.g. fp8 on llama.cpp). Numeric
//     fields are null; fallback is the recommended alternative.
//
// Why a separate module: keeping schema + validators + estimator in one place
// lets every callsite (ExportForge integration, CLI inspect, account UI,
// /v1/inspect HTTP route) read from the same contract without copy-pasting
// the field list.

export const RUNTIME_PASSPORT_SCHEMA_VERSION = 'kolm-runtime-passport-1';

// v2 schema (R-1 enrichment, wave4-r-enrich). v1 stays the canonical pin for
// already-shipped artifacts. v2 is opt-in for new exports and adds:
//   * file_size_bytes / file_hash   — bytes-on-disk fingerprint
//   * time_to_first_token_ms        — cold-prompt TTFT
//   * max_context_tested            — largest context length the probe ran at
//   * perplexity_delta              — additional quality signal beyond quality_delta
//   * kv_cache                      — Shard sub-object (see src/kv-cache-shard.js)
//   * fallback                      — already present in v1
//   * unsupported_features          — feature flags the runtime does not honor
//   * notes                         — free-text caveats for the procurement reviewer
//
// v2 entries are validated by validatePassportV2 (looser superset of v1: it
// accepts unknown v1 fields, requires v2-only fields when they are populated).
export const RUNTIME_PASSPORT_SCHEMA_V2 = 'kolm-runtime-passport-2';

export const RUNTIME_PASSPORT_FIELDS_V2 = Object.freeze([
  // v1 fields carried forward verbatim
  'target_id',
  'status',
  'runtime',
  'runtime_version',
  'precision',
  'memory_mb',
  'latency_p50_ms',
  'latency_p95_ms',
  'tok_s',
  'quality_delta',
  'fallback',
  // v2-only fields
  'file_size_bytes',
  'file_hash',
  'time_to_first_token_ms',
  'max_context_tested',
  'perplexity_delta',
  'kv_cache',
  // W916-I1 — speculative decoding sub-object built by
  // src/speculative-decoding.js speculativePassportEntry({measured}).
  // Always paired with the same artifact's `runtime` field; never
  // back-fillable to a v1 passport without re-measurement.
  'speculative_decoding',
  // W916-I3 — prompt-cache state (boolean) + first-vs-second-call TTFT
  // sub-object so a procurement reviewer can see the cache win.
  'prompt_cache',
  // W916-I4 — measured continuous-batching width and the throughput
  // delta vs single-stream — empty when not measured.
  'continuous_batching',
  'unsupported_features',
  'notes',
]);

// Canonical field order. Used by validatePassport (presence check) and by the
// inspect UI (column order in the Runtime Targets table).
export const RUNTIME_PASSPORT_FIELDS = [
  'target_id',
  'status',
  'runtime',
  'runtime_version',
  'precision',
  'memory_mb',
  'latency_p50_ms',
  'latency_p95_ms',
  'tok_s',
  'quality_delta',
  'fallback',
];

export const VALID_STATUS = ['tested', 'estimated', 'unsupported'];

// Single source of truth for runtime identifiers. New backends append here.
// The values mirror the names buyers see in the export pipeline + the
// Runtimes page (public/runtimes.html) so a buyer can map a passport row
// straight to a docs target.
export const VALID_RUNTIMES = [
  'llama.cpp',
  'vllm',
  'ollama',
  'mlx',
  'transformers',
  'tensorrt-llm',
  'sglang',
  'tgi',
];

// Numeric fields that MUST be a finite non-negative number when status='tested'.
// memory_mb is also required for 'estimated'. The latency/throughput trio is
// allowed to be null on 'estimated' rows because the compile-time estimator
// often only knows memory + precision, not throughput.
const TESTED_REQUIRED_NUMERIC = [
  'memory_mb',
  'latency_p50_ms',
  'latency_p95_ms',
  'tok_s',
];

function _isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function _isString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Validate a single passport entry. Returns { ok:true } on success,
 * { ok:false, reason } on failure. Pure: never throws, never mutates.
 *
 * Callers that want to fail-fast can wrap with:
 *   const v = validatePassport(p); if (!v.ok) throw new Error(v.reason);
 */
export function validatePassport(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    return { ok: false, reason: 'passport must be a non-array object' };
  }
  // Reject unknown fields so a typo (`latencyP50ms`) is loud at write time
  // rather than silently dropping a measurement.
  for (const k of Object.keys(p)) {
    if (!RUNTIME_PASSPORT_FIELDS.includes(k)) {
      return { ok: false, reason: `unknown field: ${k}` };
    }
  }
  if (!_isString(p.target_id)) {
    return { ok: false, reason: 'target_id required (non-empty string)' };
  }
  if (!VALID_STATUS.includes(p.status)) {
    return { ok: false, reason: `status must be one of ${VALID_STATUS.join('|')}` };
  }
  if (!VALID_RUNTIMES.includes(p.runtime)) {
    return { ok: false, reason: `runtime must be one of ${VALID_RUNTIMES.join('|')}` };
  }
  if (!_isString(p.runtime_version)) {
    return { ok: false, reason: 'runtime_version required (non-empty string)' };
  }
  if (!_isString(p.precision)) {
    return { ok: false, reason: 'precision required (non-empty string)' };
  }
  if (p.fallback !== null && !_isString(p.fallback)) {
    return { ok: false, reason: 'fallback must be string target_id or null' };
  }

  if (p.status === 'tested') {
    for (const f of TESTED_REQUIRED_NUMERIC) {
      if (!_isFiniteNumber(p[f]) || p[f] < 0) {
        return { ok: false, reason: `tested passport requires finite non-negative ${f}` };
      }
    }
    if (!_isFiniteNumber(p.quality_delta)) {
      return { ok: false, reason: 'tested passport requires finite quality_delta' };
    }
  } else if (p.status === 'estimated') {
    if (!_isFiniteNumber(p.memory_mb) || p.memory_mb < 0) {
      return { ok: false, reason: 'estimated passport requires finite non-negative memory_mb' };
    }
    // latency / tok_s / quality_delta MAY be null on an estimate.
    for (const f of ['latency_p50_ms', 'latency_p95_ms', 'tok_s', 'quality_delta']) {
      if (p[f] !== null && !_isFiniteNumber(p[f])) {
        return { ok: false, reason: `estimated passport ${f} must be number or null` };
      }
    }
  } else {
    // status === 'unsupported' — numeric fields MUST be null so a UI never
    // accidentally renders a 0 ms latency for a runtime that doesn't run it.
    for (const f of TESTED_REQUIRED_NUMERIC.concat(['quality_delta'])) {
      if (p[f] !== null) {
        return { ok: false, reason: `unsupported passport ${f} must be null` };
      }
    }
  }
  return { ok: true };
}

/**
 * Validate every entry in a runtime_passports array. Returns
 * { ok:true } or { ok:false, reason, index }.
 */
export function validatePassports(arr) {
  if (!Array.isArray(arr)) return { ok: false, reason: 'runtime_passports must be array' };
  for (let i = 0; i < arr.length; i++) {
    const v = validatePassport(arr[i]);
    if (!v.ok) return { ok: false, reason: v.reason, index: i };
  }
  return { ok: true };
}

// Rough memory estimator. Given a parameter count (billions) + a precision tag,
// return the working-set memory in MB. Numbers are conservative — the exporter
// adds KV-cache + activations on top of this, but for the passport-table
// preview the user wants "how big is this on disk vs in RAM" within ~10%.
//
// The constants below are derived from public docs (llama.cpp quant ladder,
// MLX precision table, vLLM weights-only stats), not measured here. Adjusting
// them moves every 'estimated' row in lockstep.
const PRECISION_BYTES_PER_PARAM = {
  fp32: 4,
  fp16: 2,
  bf16: 2,
  fp8:  1,
  int8: 1,
  q8_0: 1.0625,    // 8-bit + ~6% scale overhead
  q6_k: 0.8125,
  q5_k_m: 0.6875,
  q5_k_s: 0.6875,
  q4_k_m: 0.5625,
  q4_k_s: 0.5625,
  q4_0:  0.5625,
  q3_k_m: 0.4375,
  q3_k_s: 0.4375,
  q2_k:  0.3125,
  iq4_xs: 0.5,
  iq4_nl: 0.5,
  iq3_s: 0.4375,
  iq2_s: 0.3125,
  int4: 0.5,
};

function _estMemoryMb({ params_b, precision }) {
  if (!_isFiniteNumber(params_b) || params_b <= 0) return null;
  const bpp = PRECISION_BYTES_PER_PARAM[String(precision || '').toLowerCase()];
  if (!_isFiniteNumber(bpp)) return null;
  // params_b * 1e9 params * bytes/param / (1024*1024) -> MB. Add a 256 MB
  // baseline for the runtime process (tokenizer + scheduler + small caches).
  return Math.round((params_b * 1e9 * bpp) / (1024 * 1024) + 256);
}

/**
 * Compile-time estimator. Given a spec describing the target combination
 * (and optional model size), synthesize a passport row with status='estimated'.
 * The compile pipeline calls this before the actual runtime probe runs so the
 * manifest always carries a row even when ExportForge could not hand-off to
 * the target runtime to take a measurement.
 *
 * Required spec fields: target_id, runtime, runtime_version, precision.
 * Optional: params_b (for memory_mb), fallback.
 */
export function estimatePassport(spec) {
  if (!spec || typeof spec !== 'object') {
    throw new Error('estimatePassport: spec must be object');
  }
  const target_id = spec.target_id;
  const runtime = spec.runtime;
  const runtime_version = spec.runtime_version;
  const precision = spec.precision;
  if (!_isString(target_id)) throw new Error('estimatePassport: spec.target_id required');
  if (!VALID_RUNTIMES.includes(runtime)) {
    throw new Error(`estimatePassport: spec.runtime must be one of ${VALID_RUNTIMES.join('|')}`);
  }
  if (!_isString(runtime_version)) {
    throw new Error('estimatePassport: spec.runtime_version required');
  }
  if (!_isString(precision)) {
    throw new Error('estimatePassport: spec.precision required');
  }
  const memory_mb = _estMemoryMb({ params_b: spec.params_b, precision });
  const passport = {
    target_id,
    status: 'estimated',
    runtime,
    runtime_version,
    precision,
    memory_mb: memory_mb != null ? memory_mb : null,
    latency_p50_ms: null,
    latency_p95_ms: null,
    tok_s: null,
    quality_delta: null,
    fallback: spec.fallback != null ? String(spec.fallback) : null,
  };
  // If the estimator could not resolve memory_mb (unknown precision or no
  // params_b), the passport is still valid as long as memory_mb is finite.
  // Promote the row to 'unsupported' rather than ship a passport that fails
  // its own validator.
  if (passport.memory_mb == null) {
    passport.status = 'unsupported';
    passport.memory_mb = null;
    passport.latency_p50_ms = null;
    passport.latency_p95_ms = null;
    passport.tok_s = null;
    passport.quality_delta = null;
  }
  return passport;
}

/**
 * Build a passport row from REAL measurements. Used by the post-export probe
 * step in ExportForge after it has loaded the bytes into the target runtime
 * and pulled actual numbers. Throws if the caller tries to ship a 'tested'
 * row with missing numbers — exactly the failure mode the schema is here to
 * prevent.
 *
 * Required measurements: target_id, runtime, runtime_version, precision,
 * memory_mb, latency_p50_ms, latency_p95_ms, tok_s, quality_delta.
 * Optional: fallback.
 */
// ---------------------------------------------------------------------------
// v2 enrichment helpers — bytes-on-disk fingerprint, runtime/precision
// inference, performance estimation, and a Shard kv-cache attach point.
// All helpers are additive; existing v1 callers see no change.
// ---------------------------------------------------------------------------

// Lookup table for estimated performance per runtime + precision. Numbers
// are conservative defaults; status='tested' rows replace them with measured
// values. Used by generateRuntimePassport() when no probe has run yet.
const ESTIMATED_PERFORMANCE = Object.freeze({
  'llama.cpp': Object.freeze({
    q4_k_m: { latency_p50_ms: 18, latency_p95_ms: 32, time_to_first_token_ms: 120, max_context_tested: 4096 },
    q5_k_m: { latency_p50_ms: 22, latency_p95_ms: 40, time_to_first_token_ms: 140, max_context_tested: 4096 },
    q8_0:   { latency_p50_ms: 28, latency_p95_ms: 50, time_to_first_token_ms: 160, max_context_tested: 4096 },
    fp16:   { latency_p50_ms: 35, latency_p95_ms: 65, time_to_first_token_ms: 200, max_context_tested: 4096 },
  }),
  vllm: Object.freeze({
    fp16: { latency_p50_ms: 14, latency_p95_ms: 24, time_to_first_token_ms: 80,  max_context_tested: 8192 },
    bf16: { latency_p50_ms: 14, latency_p95_ms: 24, time_to_first_token_ms: 80,  max_context_tested: 8192 },
    fp8:  { latency_p50_ms: 10, latency_p95_ms: 18, time_to_first_token_ms: 60,  max_context_tested: 8192 },
    int8: { latency_p50_ms: 12, latency_p95_ms: 22, time_to_first_token_ms: 70,  max_context_tested: 8192 },
  }),
  mlx: Object.freeze({
    fp16: { latency_p50_ms: 22, latency_p95_ms: 38, time_to_first_token_ms: 110, max_context_tested: 4096 },
    int4: { latency_p50_ms: 18, latency_p95_ms: 30, time_to_first_token_ms: 90,  max_context_tested: 4096 },
  }),
  transformers: Object.freeze({
    fp16: { latency_p50_ms: 60, latency_p95_ms: 120, time_to_first_token_ms: 350, max_context_tested: 2048 },
    bf16: { latency_p50_ms: 60, latency_p95_ms: 120, time_to_first_token_ms: 350, max_context_tested: 2048 },
  }),
});

// Map a filename suffix + target hint to a (runtime, precision) pair. Used
// when the caller only knows the artifact path + a coarse target like 'cuda'.
function _inferRuntimeAndPrecision(artifactPath, format, targetHardware) {
  const lower = String(artifactPath || '').toLowerCase();
  const tgt = String(targetHardware || '').toLowerCase();
  let inferredFormat = String(format || '').toLowerCase();
  if (!inferredFormat) {
    if (lower.endsWith('.gguf')) inferredFormat = 'gguf';
    else if (lower.endsWith('.safetensors')) inferredFormat = 'safetensors';
    else if (lower.endsWith('.mlx')) inferredFormat = 'mlx';
    else inferredFormat = 'unknown';
  }
  // Precision from a typical Q-suffix in the filename: Q4_K_M, Q5_K_M, Q8_0, …
  let precision = null;
  const qm = lower.match(/[\.\-_](q[0-9]_[a-z](?:_[a-z])?|q[0-9]_[0-9]|iq[0-9]_[a-z]+|fp16|bf16|fp8|int8|int4)(?:[\.\-_]|$)/);
  if (qm) precision = qm[1];
  if (!precision && inferredFormat === 'gguf') precision = 'q4_k_m';
  if (!precision && inferredFormat === 'safetensors' && tgt === 'cuda') precision = 'fp16';
  if (!precision && inferredFormat === 'safetensors') precision = 'bf16';
  if (!precision && inferredFormat === 'mlx') precision = 'fp16';
  let runtime = null;
  if (inferredFormat === 'gguf') runtime = 'llama.cpp';
  else if (inferredFormat === 'mlx') runtime = 'mlx';
  else if (inferredFormat === 'safetensors' && tgt === 'cuda') runtime = 'vllm';
  else if (inferredFormat === 'safetensors' && tgt === 'metal') runtime = 'mlx';
  else if (inferredFormat === 'safetensors') runtime = 'transformers';
  return { runtime, precision, format: inferredFormat };
}

// node:crypto + node:fs are loaded lazily so this module stays pure-import
// safe in the browser bundle (the v1 validators ship there). Real callers
// always run in Node so the dynamic import is virtually free.
async function _hashAndSize(absPath) {
  try {
    const { default: fs } = await import('node:fs');
    const { default: cryptoMod } = await import('node:crypto');
    if (!fs.existsSync(absPath)) return { file_size_bytes: null, file_hash: null };
    const stat = fs.statSync(absPath);
    // For very large artifacts (multi-GB), use a streaming hash to avoid
    // loading the whole file. For small probes (under 16 MB) the synchronous
    // read is faster.
    const SMALL = 16 * 1024 * 1024;
    if (stat.size <= SMALL) {
      const buf = fs.readFileSync(absPath);
      const h = cryptoMod.createHash('sha256').update(buf).digest('hex');
      return { file_size_bytes: stat.size, file_hash: 'sha256:' + h };
    }
    return await new Promise((resolve) => {
      const hash = cryptoMod.createHash('sha256');
      const stream = fs.createReadStream(absPath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve({ file_size_bytes: stat.size, file_hash: 'sha256:' + hash.digest('hex') }));
      stream.on('error', () => resolve({ file_size_bytes: stat.size, file_hash: null }));
    });
  } catch {
    return { file_size_bytes: null, file_hash: null };
  }
}

/**
 * generateRuntimePassport(artifactPath, format, targetHardware) -> Promise<passport>
 *
 * Build a v2 runtime passport from an on-disk artifact. Computes file size
 * and sha256 from disk, infers (runtime, precision) from the path + caller
 * hint, and seeds the performance fields from ESTIMATED_PERFORMANCE.
 *
 * The resulting passport has status='estimated' by default — the caller's
 * post-export probe step is expected to upgrade it to 'tested' by calling
 * recordTestedPassport with measured numbers (then merging in file_size /
 * file_hash from this helper). Numeric performance fields the caller does
 * not have are left as estimates (status stays 'estimated').
 */
export async function generateRuntimePassport(artifactPath, format, targetHardware) {
  const { runtime, precision, format: resolvedFormat } = _inferRuntimeAndPrecision(artifactPath, format, targetHardware);
  const { file_size_bytes, file_hash } = await _hashAndSize(artifactPath);
  let memory_mb = null;
  if (_isFiniteNumber(file_size_bytes) && file_size_bytes > 0) {
    // Working-set estimate: file size + 256 MB runtime overhead.
    memory_mb = Math.round(file_size_bytes / (1024 * 1024)) + 256;
  }
  const perfTable = (runtime && ESTIMATED_PERFORMANCE[runtime]) || null;
  const perfRow = (perfTable && precision && perfTable[String(precision).toLowerCase()]) || null;
  const passport = {
    // v1 contract
    target_id: [resolvedFormat, precision, runtime].filter(Boolean).join('-') || 'unknown-target',
    status: 'estimated',
    runtime: runtime || 'transformers',
    runtime_version: 'estimated',
    precision: precision || 'unknown',
    memory_mb: memory_mb,
    latency_p50_ms: perfRow ? perfRow.latency_p50_ms : null,
    latency_p95_ms: perfRow ? perfRow.latency_p95_ms : null,
    tok_s: null,
    quality_delta: null,
    fallback: null,
    // v2 enrichment
    schema_version: RUNTIME_PASSPORT_SCHEMA_V2,
    file_size_bytes: file_size_bytes,
    file_hash: file_hash,
    time_to_first_token_ms: perfRow ? perfRow.time_to_first_token_ms : null,
    max_context_tested: perfRow ? perfRow.max_context_tested : null,
    perplexity_delta: null,
    kv_cache: null,
    unsupported_features: [],
    notes: 'Estimated row generated by generateRuntimePassport. Upgrade to status="tested" with recordTestedPassport once the runtime probe completes.',
  };
  return passport;
}

/**
 * addShardKvCacheToPassport(passport, measured) -> passport (mutated copy)
 *
 * Merge a Shard KV-cache measurement (the object returned by
 * src/kv-cache-shard.js shardPassportEntry()) into a passport's kv_cache
 * field. Returns a shallow copy so the input passport is never mutated.
 *
 * Caller responsibility:
 *   - call isShardSupported() first to gate the attach
 *   - call shardPassportEntry({measured}) to build the kv_cache sub-object
 *   - pass the resulting sub-object here
 */
export function addShardKvCacheToPassport(passport, measured) {
  if (!passport || typeof passport !== 'object') {
    throw new Error('addShardKvCacheToPassport: passport must be an object');
  }
  if (!measured || typeof measured !== 'object') {
    throw new Error('addShardKvCacheToPassport: measured kv_cache object required');
  }
  return {
    ...passport,
    schema_version: RUNTIME_PASSPORT_SCHEMA_V2,
    kv_cache: measured,
  };
}

/**
 * addSpeculativeDecodingToPassport(passport, measured) -> passport (copy)
 *
 * Merge a speculative-decoding measurement (the object returned by
 * src/speculative-decoding.js speculativePassportEntry()) into a
 * passport's `speculative_decoding` field. Returns a shallow copy so
 * the input passport is never mutated.
 *
 * Caller responsibility:
 *   - call isSpeculativeSupported() first to gate the attach
 *   - call speculativePassportEntry({measured}) to build the sub-object
 *   - pass the resulting sub-object here
 *
 * Mirrors addShardKvCacheToPassport (same shape; v2 schema bump).
 */
export function addSpeculativeDecodingToPassport(passport, measured) {
  if (!passport || typeof passport !== 'object') {
    throw new Error('addSpeculativeDecodingToPassport: passport must be an object');
  }
  if (!measured || typeof measured !== 'object') {
    throw new Error('addSpeculativeDecodingToPassport: measured speculative_decoding object required');
  }
  if (measured.method !== 'speculative_decoding') {
    throw new Error(`addSpeculativeDecodingToPassport: measured.method must be 'speculative_decoding'; got ${measured.method}`);
  }
  return {
    ...passport,
    schema_version: RUNTIME_PASSPORT_SCHEMA_V2,
    speculative_decoding: measured,
  };
}

/**
 * addPromptCacheToPassport(passport, measured) -> passport (copy)
 *
 * W916-I3 — attach a prompt-cache measurement. `measured` carries:
 *   {
 *     enabled:           boolean        // is prompt caching on?
 *     backend:           string         // 'vllm-prefix' | 'llama-cpp-prompt-cache' | 'none'
 *     ttft_first_call_ms:  number       // measured cold TTFT
 *     ttft_second_call_ms: number       // measured warm TTFT (same prefix)
 *     speedup:           number         // ttft_first / ttft_second
 *   }
 */
export function addPromptCacheToPassport(passport, measured) {
  if (!passport || typeof passport !== 'object') {
    throw new Error('addPromptCacheToPassport: passport must be an object');
  }
  if (!measured || typeof measured !== 'object') {
    throw new Error('addPromptCacheToPassport: measured prompt_cache object required');
  }
  return {
    ...passport,
    schema_version: RUNTIME_PASSPORT_SCHEMA_V2,
    prompt_cache: measured,
  };
}

/**
 * addContinuousBatchingToPassport(passport, measured) -> passport (copy)
 *
 * W916-I4 — attach a continuous-batching measurement. `measured` carries:
 *   {
 *     enabled:                boolean
 *     max_num_seqs:           number    // configured width
 *     measured_throughput_x:  number    // tok/s @ batch / tok/s @ batch=1
 *     concurrent_streams:     number    // probe load
 *   }
 */
export function addContinuousBatchingToPassport(passport, measured) {
  if (!passport || typeof passport !== 'object') {
    throw new Error('addContinuousBatchingToPassport: passport must be an object');
  }
  if (!measured || typeof measured !== 'object') {
    throw new Error('addContinuousBatchingToPassport: measured continuous_batching object required');
  }
  return {
    ...passport,
    schema_version: RUNTIME_PASSPORT_SCHEMA_V2,
    continuous_batching: measured,
  };
}

export function recordTestedPassport(measurements) {
  if (!measurements || typeof measurements !== 'object') {
    throw new Error('recordTestedPassport: measurements must be object');
  }
  const required = [
    'target_id', 'runtime', 'runtime_version', 'precision',
    'memory_mb', 'latency_p50_ms', 'latency_p95_ms', 'tok_s', 'quality_delta',
  ];
  for (const k of required) {
    if (!(k in measurements)) {
      throw new Error(`recordTestedPassport: ${k} required (no inference for tested rows)`);
    }
  }
  for (const k of ['memory_mb', 'latency_p50_ms', 'latency_p95_ms', 'tok_s', 'quality_delta']) {
    if (!_isFiniteNumber(measurements[k])) {
      throw new Error(`recordTestedPassport: ${k} must be a measured finite number`);
    }
  }
  const passport = {
    target_id: String(measurements.target_id),
    status: 'tested',
    runtime: measurements.runtime,
    runtime_version: String(measurements.runtime_version),
    precision: String(measurements.precision),
    memory_mb: measurements.memory_mb,
    latency_p50_ms: measurements.latency_p50_ms,
    latency_p95_ms: measurements.latency_p95_ms,
    tok_s: measurements.tok_s,
    quality_delta: measurements.quality_delta,
    fallback: measurements.fallback != null ? String(measurements.fallback) : null,
  };
  const v = validatePassport(passport);
  if (!v.ok) throw new Error(`recordTestedPassport: ${v.reason}`);
  return passport;
}
