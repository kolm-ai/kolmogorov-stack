// src/speculative-decoding.js
//
// W916-I1 - Speculative decoding integration module. Sister of
// src/kv-cache-shard.js. Provides the Node-side contract for the Python
// speculative path in apps/trainer/speculative.py and apps/runtime/serve.py.
//
// Mental model:
//   The target model is the big one (Qwen 7B, Llama 14B, ...). The draft model
//   is a small fast model (1.5B / 3B) that proposes K tokens; the target then
//   verifies them in a single forward pass. When the proposals match, we get
//   K tokens for the cost of one big-model forward - typical wins are 2x - 3x
//   tokens/sec, sometimes more for code.
//
// What this module exposes:
//   * DRAFT_PAIRINGS - well-known target -> draft auto-picks.
//   * pickDraft(target, opts) - resolve auto -> concrete draft, or null.
//   * resolveSpeculative(flag, ...) - resolve the CLI's --speculative value
//                                     ('auto' | 'off' | '<model>') into a final
//                                     { mode, draft_model, reason }.
//   * isSpeculativeSupported(...) - gate on runtime + draft availability.
//   * speculativePassportEntry() - runtime-passport.kv_cache-style sub-object
//                                     describing the spec-decoding configuration.
//
// Why mirror DRAFT_PAIRINGS in two languages: the Python (apps/trainer/
// speculative.py) is what serve.py actually loads; the JS copy lets the CLI
// resolve `--speculative auto` before spawning Python, so the user sees the
// chosen draft model in the boot log up-front.

export const SPECULATIVE_VERSION = 'kolm-speculative/1';

// Default proposal depth. vLLM and HF transformers both default to ~5;
// raising can help on code but raises the verification cost of wrong proposals.
export const DEFAULT_NUM_SPECULATIVE_TOKENS = 5;

// Runtimes that accept a draft-model handoff. llama.cpp has its own
// speculative path (`--draft-model`) but the kolm Python serve does not
// drive it today - keep it out of this gate until that path lands.
export const SUPPORTED_RUNTIMES = Object.freeze(['transformers', 'vllm']);

// Known good target -> draft pairings. Keys are lower-case canonical model ids.
// Mirrors apps/trainer/speculative.py DRAFT_PAIRINGS - keep them in sync.
export const DRAFT_PAIRINGS = Object.freeze({
  'qwen/qwen2.5-7b-instruct':        'Qwen/Qwen2.5-1.5B-Instruct',
  'qwen/qwen2.5-14b-instruct':       'Qwen/Qwen2.5-3B-Instruct',
  'qwen/qwen2.5-32b-instruct':       'Qwen/Qwen2.5-7B-Instruct',
  'qwen/qwen2.5-72b-instruct':       'Qwen/Qwen2.5-7B-Instruct',
  'qwen/qwen3-8b':                   'Qwen/Qwen3-1.7B',
  'qwen/qwen3-14b':                  'Qwen/Qwen3-1.7B',
  'qwen/qwen3-32b':                  'Qwen/Qwen3-4B',
  'meta-llama/llama-3.2-3b-instruct':'meta-llama/Llama-3.2-1B-Instruct',
  'meta-llama/meta-llama-3-8b-instruct': 'meta-llama/Llama-3.2-1B-Instruct',
  'meta-llama/llama-3.1-8b-instruct':'meta-llama/Llama-3.2-1B-Instruct',
  'meta-llama/llama-3.1-70b-instruct':'meta-llama/Llama-3.2-3B-Instruct',
  'google/gemma-3-12b-it':           'google/gemma-3-1b-it',
  'google/gemma-3-4b-it':            'google/gemma-3-1b-it',
  'google/gemma-2-9b-it':            'google/gemma-2-2b-it',
  'google/gemma-2-27b-it':           'google/gemma-2-2b-it',
  'microsoft/phi-3.5-mini-instruct': 'Qwen/Qwen2.5-1.5B-Instruct',
  'mistralai/mistral-7b-instruct-v0.3': 'Qwen/Qwen2.5-1.5B-Instruct',
});

/**
 * Resolve the auto-picked draft for a target model id, or null when no good
 * pairing exists. The lookup is case-insensitive.
 */
export function pickDraft(targetId) {
  if (!targetId || typeof targetId !== 'string') return null;
  const key = targetId.toLowerCase().trim();
  if (DRAFT_PAIRINGS[key]) return DRAFT_PAIRINGS[key];
  // Try the family-prefix fallback: e.g. someone passes
  // "qwen/qwen2.5-7b-instruct-awq" - strip a known suffix and retry once.
  const stripped = key.replace(/-(awq|gptq|bnb-4bit|nf4|fp8|fp16|bf16|q[0-9]_[a-z][_a-z]*)$/i, '');
  if (stripped !== key && DRAFT_PAIRINGS[stripped]) return DRAFT_PAIRINGS[stripped];
  return null;
}

/**
 * Gate: is speculative decoding possible for this configuration?
 *
 * Inputs:
 *   runtime  : 'vllm' | 'transformers' | 'llama.cpp' | 'mlx' | ...
 *   draft    : the resolved draft model id (or null for auto + no pairing)
 *
 * Returns { supported: boolean, reason: string }.
 */
export function isSpeculativeSupported({ runtime, draft }) {
  if (!runtime || typeof runtime !== 'string') {
    return { supported: false, reason: 'runtime is required (string)' };
  }
  if (!SUPPORTED_RUNTIMES.includes(runtime)) {
    return {
      supported: false,
      reason: `runtime ${runtime} does not drive speculative decoding through the kolm Python serve; supported: ${SUPPORTED_RUNTIMES.join(', ')}`,
    };
  }
  if (!draft) {
    return { supported: false, reason: 'no draft model resolved (auto-pick returned null)' };
  }
  return { supported: true, reason: 'ok' };
}

/**
 * Resolve a CLI --speculative / --with-draft flag value into a final
 * decision. Pure: never throws.
 *
 * Inputs:
 *   flag    : raw flag value ('auto' | 'off' | '<model id>' | undefined)
 *   target  : the target model id (for auto resolution)
 *   runtime : the serving runtime (for support gate)
 *
 * Returns:
 *   {
 *     mode:        'auto' | 'explicit' | 'off' | 'unsupported',
 *     draft_model: string | null,
 *     reason:      string,        // human-readable explanation
 *     supported:   boolean,
 *     num_speculative_tokens: number,
 *   }
 */
export function resolveSpeculative({ flag, target, runtime, numSpeculativeTokens }) {
  const n = (typeof numSpeculativeTokens === 'number' && Number.isFinite(numSpeculativeTokens) && numSpeculativeTokens > 0)
    ? Math.floor(numSpeculativeTokens)
    : DEFAULT_NUM_SPECULATIVE_TOKENS;
  const rawFlag = (typeof flag === 'string') ? flag.trim() : '';
  // Explicit off - never run speculative decoding even if a pairing exists.
  if (rawFlag.toLowerCase() === 'off' || rawFlag.toLowerCase() === 'none' || rawFlag.toLowerCase() === 'false') {
    return {
      mode: 'off',
      draft_model: null,
      reason: 'speculative decoding disabled by --speculative off',
      supported: false,
      num_speculative_tokens: n,
    };
  }
  // Auto - look up via the DRAFT_PAIRINGS registry.
  if (!rawFlag || rawFlag.toLowerCase() === 'auto' || rawFlag.toLowerCase() === 'on') {
    const picked = pickDraft(target);
    const gate = isSpeculativeSupported({ runtime, draft: picked });
    if (!gate.supported) {
      return {
        mode: 'unsupported',
        draft_model: null,
        reason: `auto: ${gate.reason}`,
        supported: false,
        num_speculative_tokens: n,
      };
    }
    return {
      mode: 'auto',
      draft_model: picked,
      reason: `auto-paired ${target} -> ${picked}`,
      supported: true,
      num_speculative_tokens: n,
    };
  }
  // Explicit draft model id passed by the operator.
  const gate = isSpeculativeSupported({ runtime, draft: rawFlag });
  if (!gate.supported) {
    return {
      mode: 'unsupported',
      draft_model: null,
      reason: `explicit: ${gate.reason}`,
      supported: false,
      num_speculative_tokens: n,
    };
  }
  return {
    mode: 'explicit',
    draft_model: rawFlag,
    reason: `explicit draft model ${rawFlag}`,
    supported: true,
    num_speculative_tokens: n,
  };
}

/**
 * Human-readable one-liner for the CLI startup banner.
 */
export function formatSpeculativeBanner(resolved) {
  if (!resolved) return '';
  if (resolved.mode === 'off') {
    return `speculative decoding: OFF (${resolved.reason})`;
  }
  if (resolved.mode === 'unsupported') {
    return `speculative decoding: SKIPPED - ${resolved.reason}`;
  }
  return `speculative decoding: ${resolved.draft_model} (${resolved.mode}, K=${resolved.num_speculative_tokens})`;
}

/**
 * Build the runtime-passport speculative sub-object. Mirrors the shape of
 * shardPassportEntry - additive sub-document attached to the passport via
 * addSpeculativeDecodingToPassport(passport, this).
 *
 * `measured` carries:
 *   {
 *     draft_model:     string         // required
 *     target_model:    string         // required
 *     runtime:         string         // 'vllm' | 'transformers'
 *     num_speculative_tokens: number  // configured K
 *     acceptance_rate: number | null  // measured ratio in [0, 1]; null pre-warmup
 *     throughput_speedup: number | null // measured tok/s ratio vs no-draft baseline
 *     mode:            'auto' | 'explicit'
 *   }
 */
export function speculativePassportEntry({ measured }) {
  if (!measured || typeof measured !== 'object') {
    throw new TypeError('speculativePassportEntry: measured object is required');
  }
  const {
    draft_model,
    target_model,
    runtime,
    num_speculative_tokens = DEFAULT_NUM_SPECULATIVE_TOKENS,
    acceptance_rate = null,
    throughput_speedup = null,
    mode = 'explicit',
  } = measured;
  if (typeof draft_model !== 'string' || draft_model.length === 0) {
    throw new TypeError('measured.draft_model must be a non-empty string');
  }
  if (typeof target_model !== 'string' || target_model.length === 0) {
    throw new TypeError('measured.target_model must be a non-empty string');
  }
  if (!SUPPORTED_RUNTIMES.includes(runtime)) {
    throw new TypeError(`measured.runtime must be one of ${SUPPORTED_RUNTIMES.join(', ')}; got ${runtime}`);
  }
  if (typeof num_speculative_tokens !== 'number' || !Number.isFinite(num_speculative_tokens) || num_speculative_tokens <= 0) {
    throw new TypeError(`measured.num_speculative_tokens must be a positive number; got ${num_speculative_tokens}`);
  }
  if (acceptance_rate !== null) {
    if (typeof acceptance_rate !== 'number' || !Number.isFinite(acceptance_rate) || acceptance_rate < 0 || acceptance_rate > 1) {
      throw new TypeError(`measured.acceptance_rate must be a number in [0,1] or null; got ${acceptance_rate}`);
    }
  }
  if (throughput_speedup !== null) {
    if (typeof throughput_speedup !== 'number' || !Number.isFinite(throughput_speedup) || throughput_speedup <= 0) {
      throw new TypeError(`measured.throughput_speedup must be a positive number or null; got ${throughput_speedup}`);
    }
  }
  if (mode !== 'auto' && mode !== 'explicit') {
    throw new TypeError(`measured.mode must be 'auto' or 'explicit'; got ${mode}`);
  }
  return Object.freeze({
    method: 'speculative_decoding',
    version: SPECULATIVE_VERSION,
    draft_model,
    target_model,
    runtime,
    num_speculative_tokens: Math.floor(num_speculative_tokens),
    acceptance_rate,
    throughput_speedup,
    mode,
  });
}

export default {
  SPECULATIVE_VERSION,
  DEFAULT_NUM_SPECULATIVE_TOKENS,
  SUPPORTED_RUNTIMES,
  DRAFT_PAIRINGS,
  pickDraft,
  isSpeculativeSupported,
  resolveSpeculative,
  formatSpeculativeBanner,
  speculativePassportEntry,
};
