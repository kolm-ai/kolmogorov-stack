# ITKV x Shard: Importance-Tiered Structured KV Cache Compression

Status: research roadmap. NOT for V1 launch. Combines two independent
techniques the kolm codebase already understands:

- **Shard** (`src/kv-cache-shard.js`, `github.com/krish1905/shard`) —
  structural compression: K via PCA + int4 after undoing RoPE; V via
  Hadamard rotation + VQ256. Roughly 10x at parity quality on RoPE-based
  decoder-only models.
- **ITKV** (`src/itkv-profile.js`, kolm W722 / Invention 4) — token-class
  scorer that labels tokens as sink, policy, schema, retrieved_evidence,
  conversation_recent, boilerplate, or irrelevant_span, then allocates
  precision by class (BF16 sinks + policy, INT8 warm, INT4 cold).

The two are orthogonal: Shard tells you HOW to compress per token; ITKV
tells you WHICH tokens are worth more bits. This document sketches the
combination.

## 1. Background

### 1.1 What Shard does

Shard's `ShardCache` is a `transformers.Cache` subclass with three regions
per layer per attention head:

- **Sink region** (tokens 0..S-1, default S=4) — FP16, never compressed.
- **Window region** (tokens T-W..T-1, default W=64) — FP16, never compressed.
- **Compressed tail** (tokens S..T-W-1) — K via PCA + int4 in the principal
  subspace; V via Hadamard rotation + 256-entry codebook index (VQ256).

The compressed tail uniformly spends ~1.5 bits per original element. It does
not know whether a given token is a system-prompt instruction, a tool
description, or a throwaway boilerplate line — they all get the same budget.

### 1.2 What ITKV does

ITKV scores each token at insertion time with a class label. The default
precision policy in `src/itkv-profile.js` is:

```
sink                 -> BF16  (highest)
policy               -> BF16
schema               -> FP8 or INT8
retrieved_evidence   -> precision by citation confidence
conversation_recent  -> BF16
boilerplate          -> INT4 or prefix-cache reference
irrelevant_span      -> compress or evict
```

The ITKV profile is a SCHEMA + SCORER today. The runtime tier-dispatch is
out of scope in W722 — it plugs into vLLM PagedAttention / SGLang radix
cache when those land.

### 1.3 The gap

Shard underspends on high-importance tokens (sink + policy + tool schemas
get the same 1.5 bpe as boilerplate). ITKV has no compressor at the byte
level — only labels. Combining them turns ITKV labels into per-token
bit-budgets for the Shard codebook.

## 2. Novel combination: per-token VQ codebook size by ITKV importance

The kernel insight: VQ256 is one specific choice on a continuum.
VQ-{N} uses log2(N) bits per token slot. Per-token codebook size by class:

```
sink, policy            -> VQ-512 (9 bits/slot)     high precision
schema, evidence        -> VQ-256 (8 bits/slot)     Shard default
conv_recent             -> VQ-256 (kept in window in practice)
boilerplate             -> VQ-128 (7 bits/slot)
irrelevant_span         -> VQ-64  (6 bits/slot) or evict
```

K side: rank of the PCA subspace is also class-aware. High-importance
tokens get the full Shard rank (e.g. 16); irrelevant_span tokens get a
truncated rank (e.g. 8) with the residual snapped to zero.

## 3. Architecture (ASCII)

```
  +---------------------------+
  |   Incoming token batch    |
  +-------------+-------------+
                |
                v
  +---------------------------+
  |    ITKV Scorer            |   (existing, src/itkv-profile.js)
  |    -> class label per     |
  |       token               |
  +-------------+-------------+
                |
                v
  +---------------------------+
  |  ShardITKVCache (NEW)     |
  |  - K: PCA rank by class   |
  |  - V: VQ-{N} by class     |
  |  - Sink + window untouched|
  +-------------+-------------+
                |
                v
  +---------------------------+
  |  Per-layer tiered storage |
  |  sink/policy   : FP16     |
  |  schema/ev     : VQ256+r16|
  |  conv_recent   : FP16     |
  |  boilerplate   : VQ128+r12|
  |  irrelevant    : VQ64+r8  |
  +---------------------------+
```

A class-label sidecar (uint8 per token per layer) lives alongside the
compressed K and V tensors so decompression knows which codebook to load.

## 4. Math: bits per token with importance weights

Let:

- `f_c` = expected fraction of tokens in class c
- `bV_c` = V VQ bits per slot for class c
- `r_c` = K PCA rank for class c
- `d` = head_dim (per-head dimension)
- `H_kv` = num_key_value_heads
- `L` = num_hidden_layers

Bits per token, averaged across classes (ignoring sink + window for now):

```
bits_per_token = 2 * L * H_kv * sum_c f_c * (r_c * 4 / d + bV_c)
```

The factor `r_c * 4 / d` reflects K stored as int4 over a rank-`r_c`
subspace projected from a `d`-dimensional space (so per-token-per-head
K cost is `r_c * 4` bits, amortized over `d` original slots).

Baseline Shard (uniform): `r = 16, bV = 8` for all c, giving roughly:

```
bits_per_token_shard ~= 2 * L * H_kv * (16*4/d + 8)
                     ~= 2 * L * H_kv * (0.5 + 8)    for d=128
                     ~= 17 * L * H_kv               bits/token
```

ITKV-weighted (assuming typical agent/RAG workload mix:
sink/policy=10%, schema/evidence=30%, conv_recent=15%, boilerplate=35%, irrelevant=10%):

```
sum_c f_c * (r_c*4/d + bV_c)
  = 0.10 * (16*4/128 + 9)     # sink/policy at VQ-512
  + 0.30 * (16*4/128 + 8)     # schema/evidence at VQ-256
  + 0.15 * (16*4/128 + 8)     # conv_recent
  + 0.35 * (12*4/128 + 7)     # boilerplate at VQ-128, rank 12
  + 0.10 * (8*4/128 + 6)      # irrelevant at VQ-64, rank 8
  = 0.10*(0.5+9) + 0.30*(0.5+8) + 0.15*(0.5+8) + 0.35*(0.375+7) + 0.10*(0.25+6)
  = 0.95 + 2.55 + 1.275 + 2.581 + 0.625
  = 7.98 bits/slot
```

vs uniform Shard at 8.5 bits/slot — so the V-side budget alone drops about
6%. Adding K rank reduction on the low-importance classes (rank 8 vs 16)
gives another ~3% savings.

Combined: total bits/token drops from ~17 * L * H_kv to ~16 * L * H_kv,
a ~6% improvement at average quality — BUT crucially, that 6% is taken
from the tokens that don't need the bits, and the high-importance tokens
gain a full bit of headroom (9 vs 8 bpe on V, full rank vs truncated on K).

The headline savings comes from the irrelevant_span class being EVICTED
not compressed. In agent + RAG workloads the irrelevant fraction is
often 20%-30%, not 10%. At 25% eviction the bits/token drops by an
additional 25% on top of the 6%, yielding ~12-15x compression vs the
FP16 baseline (vs Shard's 10x).

## 5. Implementation sketch (algorithm, no code)

1. **Token insertion path**
   - When transformers calls `cache.update(new_K, new_V, layer_idx, ...)`:
     - For each new token, look up its class label from the ITKV scorer.
     - Sink + window tokens: FP16 path (unchanged from Shard).
     - All others: pick the codebook + rank for the class, encode K and V.
     - Append the class label to the per-layer label sidecar.

2. **Eviction path**
   - When the compressed tail reaches a configured max length:
     - First evict irrelevant_span tokens (these are tagged at insertion).
     - If still over budget, evict the oldest boilerplate tokens.
     - Never evict sink or policy tokens within a session.

3. **Attention computation**
   - For each decode step, gather (K, V) for all stored tokens:
     - Sink + window: read FP16 directly.
     - Compressed: per-class decode (rank-`r_c` K project back to full d;
       VQ-`N_c` V index back into the codebook).
   - The class-aware decode path is the only mechanical addition vs
     vanilla Shard.

4. **Codebook lifecycle**
   - Per class, per layer, per head: maintain a codebook of size N_c.
     Online K-means update (Lloyd's algorithm) every `K` insertions to
     adapt to the running token distribution. Codebook state is part of
     the cache's serialized form.

5. **Calibration**
   - Before deployment, run the kolm benchmark suite to find per-class
     {rank, codebook size} that minimize quality_delta subject to a target
     compression ratio. Ship the resulting profile in the runtime passport.

## 6. Expected gains (back-of-envelope)

At workloads dominated by agent + RAG traffic (the kolm target):

| Cache | Compression | Quality delta on agent eval | Notes |
|---|---|---|---|
| Default FP16 | 1.0x | 0 (baseline) | reference |
| Shard alone | ~10x | ~ -0.002 (parity) | uniform 1.5 bpe |
| ITKV x Shard | ~12-15x | ~ 0 to -0.001 | with 20-25% irrelevant eviction |

The win is biggest where the workload has high boilerplate + irrelevant
fraction (agents repeating long system prompts, RAG dumping unranked
chunks). On uniform creative-writing workloads ITKV degenerates to
"all tokens are conv_recent" and the cache reverts to plain Shard.

## 7. Validation plan

The combination should be validated against these benchmarks before any
production rollout:

1. **Quality**: kolm benchmark suite (`scripts/bench-quality-calibration.mjs`)
   on the standard model x task matrix, comparing FP16 vs Shard vs ITKVxShard.
   Target: quality_delta within +/- 0.005 of FP16 baseline.
2. **Compression**: peak VRAM measurement on a long-context agent trace
   (32K + tokens, tool calls + RAG retrievals). Target: >= 1.2x reduction
   vs Shard alone, >= 12x vs FP16.
3. **Latency**: per-token decode latency. The class-aware decode adds one
   branch + one codebook lookup per token. Target: <= 10% latency overhead
   vs Shard alone.
4. **Stability**: run a 24-hour rolling agent simulation. The online
   codebook update must not degrade quality monotonically. If it does,
   freeze the codebook after warmup and re-evaluate.

## 8. What's NOT in V1

This document is research-track. V1 ships Shard alone (uniform 1.5 bpe).
ITKV remains a separate profile/scorer with no runtime dispatch. The
combination requires:

- A `ShardITKVCache` Python class extending `ShardCache` with a class
  label sidecar.
- A class-to-codebook size mapping serialized in the runtime passport.
- Per-class codebook lifecycle management.
- Benchmark calibration to find production-ready per-class rank/codebook
  settings.
- A revised eviction policy with class-aware priority.

Estimated effort: ~6 person-weeks across the Python (cache class +
codebook lifecycle), JS (passport schema extension, policy selector
extension), and benchmark (calibration sweep + agent eval harness)
surfaces.

## 9. Risks

- **Codebook overfitting** — online K-means on a non-stationary token
  stream can drift. Mitigation: freeze the codebook after a warmup
  window and rebuild on session boundaries.
- **Class label cost** — the ITKV scorer adds latency at token insertion.
  Mitigation: the existing W722 scorer runs at well under 1% of attention
  cost on the reference traces.
- **Eviction surprises** — if the ITKV scorer mislabels a critical token
  as `irrelevant_span` and the eviction policy throws it away, decode
  quality silently degrades. Mitigation: shadow-mode the eviction policy
  for the first deployment and compare retained-vs-evicted attention
  contribution against ground truth before enabling.
- **HF Cache contract churn** — both Shard and any subclass live downstream
  of the upstream `transformers.Cache` ABI. Mitigation: pin the
  `transformers` version in the runtime passport.

## 10. Pointers

- `src/kv-cache-shard.js` — Shard module (this codebase)
- `src/itkv-profile.js` — ITKV profile + token-class scorer (W722)
- `docs/kv-cache-shard.md` — V1 Shard integration notes
- `github.com/krish1905/shard` — upstream Shard reference (Apache-2.0)
- `docs/research/kolm-billion-dollar-distillation-lab-2026-05-24.md`
  lines 1434-1466 — ITKV invention writeup
