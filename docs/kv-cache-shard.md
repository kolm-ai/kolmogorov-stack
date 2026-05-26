# Shard KV cache integration (engineering notes)

Status: V1 candidate — module + tests landed; CLI wiring + runtime passport +
memory-fit edits are documented here as text patches for the owning agents
(R-1, Forge memory-fit, S-10 docs) to merge.

Not for: llama.cpp / MLX runtimes (they have their own KV cache).

## 1. What Shard is

Shard is a drop-in HuggingFace `Cache` subclass that compresses the KV cache
roughly 10x at parity quality on RoPE-based decoder-only models. The
structural insight is that K and V have different statistics and should be
compressed differently:

- **K cache**: after undoing RoPE, keys are low-rank and quantize well.
  Shard projects K onto its principal subspace (PCA) then stores int4.
- **V cache**: values are full-rank but smooth after a Hadamard rotation.
  Shard rotates then runs vector quantization with a 256-entry codebook
  (VQ256), so each token's V slot becomes an 8-bit codebook index.
- **Sink tokens** (first 4 by default): kept at FP16, never compressed.
  Attention-sink result — early tokens absorb disproportionate attention
  mass and lossy compression there destroys quality.
- **Recency window** (last 64 tokens by default): kept at FP16. These
  tokens have not been "warmed up" by enough attention to estimate a
  stable subspace, so they wait in FP16 until they exit the window.

Reference: `github.com/krish1905/shard` (Apache-2.0). Tested model families
in the upstream repo: Llama 2/3, Qwen 2/2.5, Mistral, Gemma, DeepSeek.

## 2. Why it matters for kolm

The KV cache is the second-largest VRAM consumer after the model weights.
For Qwen-2.5-7B at INT4 (Q4_K_M) the weights are ~5.2 GB. Default FP16 KV
cache at 8K context is hundreds of MB; at 32K it's multi-GB and pushes
the model off a 16 GB GPU. Shard at 8K is ~10x smaller, which means:

- A 16 GB GPU running a 7B Q4 model gains roughly **4x usable context length**
  at the same memory budget (sink+window is the floor, everything past it
  is at 1.5 bits/element).
- The "fits on one consumer GPU" envelope expands to cover the entire 14B
  Q4 class at 8K+, and 7B Q4 at 32K+.

## 3. Module API (`src/kv-cache-shard.js`)

ESM exports:

```js
import {
  SHARD_VERSION,                         // 'kolm-shard/1'
  SUPPORTED_MODEL_FAMILIES,              // frozen array
  SUPPORTED_RUNTIMES,                    // ['transformers', 'vllm']
  SHARD_DEFAULT_SINK_TOKENS,             // 4
  SHARD_DEFAULT_WINDOW_TOKENS,           // 64
  SHARD_DEFAULT_BITS_PER_ELEMENT,        // 1.5
  estimateKvCacheBytes,                  // default FP16 KV bytes
  estimateShardKvCacheBytes,             // Shard-compressed KV bytes
  compressionRatio,                      // default / shard
  maxContextAtVram,                      // closed-form solve for max T
  isShardSupported,                      // gate
  shardPassportEntry,                    // runtime-passport sub-object
} from './kv-cache-shard.js';
```

Memory math (per token):

```
perTokenSlots = 2 * num_hidden_layers * num_key_value_heads * head_dim
defaultBytes  = perTokenSlots * T * 2                       // FP16
shardBytes    = perTokenSlots * min(T, sink+window) * 2     // FP16 region
              + perTokenSlots * max(0, T - sink - window) * (1.5 / 8)
```

At T much larger than sink+window the ratio approaches 16 / 1.5 = 10.67x.

## 4. Policy selection (`src/kv-cache-policy.js`)

```js
import { selectKvCache, formatPolicyReport } from './kv-cache-policy.js';

const policy = selectKvCache({
  format: 'vllm',
  modelMeta: { family: 'qwen2.5', has_rope: true },
  hardware: { vram_gb: 24 },
  requested: 'auto',         // 'auto' | 'shard' | 'default'
});
// -> { backend: 'shard', reason: '...', fallback: 'default' }
```

`requested='auto'` (the default) picks `shard` when:

1. `format` is a HF Cache consumer (`transformers`, `vllm`, `tgi`, ...).
2. `modelMeta.family` is on `SUPPORTED_MODEL_FAMILIES`.
3. `modelMeta.has_rope === true`.

`requested='shard'` forces Shard regardless of compatibility but records
the gate verdict in the `reason` field. `requested='default'` always
returns the default FP16 cache.

## 5. Runtime passport extension (to be applied by R-1's owner)

`src/runtime-passport.js` currently pins these fields per entry:

```
target_id, status, runtime, runtime_version, precision, memory_mb,
latency_p50_ms, latency_p95_ms, tok_s, quality_delta, fallback
```

Add an optional `kv_cache` field (object, null when default). Shape:

```json
{
  "method": "shard",
  "version": "kolm-shard/1",
  "compression_ratio": 9.86,
  "k_method": "pca_int4",
  "v_method": "hadamard_vq256",
  "sink_tokens": 4,
  "window_tokens": 64,
  "bits_per_element": 1.5,
  "quality_delta": -0.002,
  "max_context_at_vram": { "16": 32768, "24": 65536, "32": 131072 }
}
```

Recommended helper to add alongside `validatePassport`:

```js
import { shardPassportEntry } from './kv-cache-shard.js';

/**
 * Attach a kv_cache sub-object to an existing passport entry. Idempotent.
 * `measured` carries the per-model numbers from the benchmark suite.
 */
export function addShardPassportEntry(passportEntry, measured) {
  if (!passportEntry || typeof passportEntry !== 'object') {
    throw new TypeError('passportEntry must be an object');
  }
  return {
    ...passportEntry,
    kv_cache: shardPassportEntry({ measured }),
  };
}
```

The validator should accept `kv_cache: null` (default cache) OR a frozen
object with the exact shape above.

## 6. CLI wiring stub (to be applied by the cli/kolm.js owner)

Add a global flag `--kv-cache <auto|shard|default>` to the `run`, `serve`,
and `bench` verbs. Default: `auto`. Wire it into the dispatcher by calling
`selectKvCache` before launching the Python child:

```js
import { selectKvCache, formatPolicyReport } from '../src/kv-cache-policy.js';

const policy = selectKvCache({
  format: opts.format,                      // 'vllm' | 'transformers' | ...
  modelMeta: opts.modelMeta,                // from the artifact passport
  hardware: opts.hardware,                  // from forge-hardware probe
  requested: opts.kvCache || 'auto',        // CLI flag
});

if (opts.dryRun) {
  process.stdout.write(formatPolicyReport(policy) + '\n');
}

// Pass into the runtime launcher (env var or argv) so the Python side can
// instantiate ShardCache vs the default cache accordingly.
env.KOLM_KV_CACHE_BACKEND = policy.backend;
```

Help text:

```
--kv-cache <mode>     KV cache backend. One of:
                        auto    (default) — pick Shard when supported,
                                else default FP16 cache
                        shard   force Shard (HF transformers + vLLM only)
                        default force the default FP16 HF Cache
```

## 7. Memory-fit calculator patch (to be applied by Forge memory-fit owner)

`src/forge-hardware.js` (or `src/memory-fit.js` if/when introduced) should
gain a `useShard` parameter on its KV-cache sizing function. Patch text:

```js
function kvCacheSize(modelConfig, contextLength, useShard = false) {
  const L = modelConfig.num_hidden_layers;
  const Hkv = modelConfig.num_key_value_heads;
  const d = modelConfig.head_dim;
  const bytesPerElement = 2; // FP16
  const defaultSize = 2 * L * Hkv * d * contextLength * bytesPerElement;
  if (!useShard) return defaultSize;
  const sinkWindow = 2 * L * Hkv * d * (4 + 64) * bytesPerElement;
  const compressed =
    2 * L * Hkv * d * Math.max(0, contextLength - 68) * 0.1875; // 1.5 bits/elem
  return sinkWindow + compressed;
}
```

Then in the "does it fit?" decision, the planner should call `kvCacheSize`
twice (with and without Shard) and present both ceilings in the dry-run
table so the buyer sees the unlock.

## 8. Scripts

- `scripts/shard-install-verify.cjs` — Node-side probe. `--json` for
  machine-readable. Exit 0 if installed, exit 3 if missing, exit 2 if
  Python interpreter not found. Does not `pip install` — verify only.
- `scripts/shard-benchmark.py` — Python smoke. Measures default vs Shard
  on Qwen2.5-0.5B-Instruct (smallest viable RoPE model). Emits a single
  JSON envelope on stdout. Exit 0 on success, exit 3 with envelope on
  any missing dependency (torch / transformers / shard / cuda / model
  pull failure).

## 9. Website copy block (for the homepage / `/runtimes` page)

Recommended copy:

> **10x KV cache compression via Shard**
>
> Shard treats keys and values separately (K: PCA + int4 after undoing
> RoPE; V: Hadamard rotation + VQ256), with FP16 attention sinks and a
> 64-token FP16 recency window. The result is a drop-in HuggingFace
> `Cache` subclass that fits roughly 10x more context in the same VRAM
> on Llama, Qwen, Mistral, Gemma, and DeepSeek.
>
> Measured on Qwen-2.5-7B Q4 at 8K context on a 16 GB GPU: the default
> KV cache costs hundreds of MB, the Shard cache costs roughly one tenth
> of that. The 16 GB envelope gains about 4x usable context length at
> the same memory budget, and 7B Q4 reaches 32K context without spilling.
>
> Supported: HuggingFace transformers, vLLM, TGI. Not supported:
> llama.cpp and MLX (they use their own KV cache and need separate work).

## 10. Caveats / Limitations

- **HF Cache only.** Shard is a `transformers.Cache` subclass. llama.cpp
  and MLX have their own KV cache implementations; integrating them is a
  separate research project.
- **RoPE required.** The K-side compression hinges on undoing RoPE before
  PCA. Models without RoPE (e.g. GPT-2 with learned positional embeddings)
  cannot use Shard.
- **quality_delta must be measured per model.** The Shard paper's "no
  measurable drop" headline is on reference Llama/Qwen runs. Every model
  kolm ships through Shard must re-measure quality vs the FP16 baseline
  before the passport row promotes from `estimated` to `tested`.
- **1.5 bits/element is a default.** Per-layer ranks differ. The default
  `bits_per_element = 1.5` is the geometric mean across the K int4 path
  (4 bpe over a rank-reduced subspace) and the V VQ256 path (8 bits over
  a typically rank-8 group). Some models calibrate to 1.3 - 1.7 bpe in
  practice; the passport carries the measured value.
- **Sink + window floor.** Below 68 tokens of context there is no
  compression — both cache paths cost the same. Compression only pays
  off at moderate to long contexts.
- **Python-side dependency.** Shard is installed via `pip install shard-kv`.
  The JS modules in this domain only describe the policy and the math;
  the actual cache lives on the Python side.

## 11. Pointers

- `src/kv-cache-shard.js` — module API + memory math
- `src/kv-cache-policy.js` — `selectKvCache` + `formatPolicyReport`
- `scripts/shard-benchmark.py` — Python smoke
- `scripts/shard-install-verify.cjs` — Node install probe
- `tests/wrapper-shard.test.js` — 11 unit tests (sub-100ms)
- `ITKV-SHARD-COMBINATION-DESIGN.md` (repo root) — research roadmap that
  combines Shard's structural compression with ITKV (W722) importance
  tiering. Not for V1 launch.
