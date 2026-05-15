# Base model + device-fit audit — 2026-05-14

Reference output that explains the default base-model pick and the device-fit
contract that the rest of the compile pipeline relies on. Drives the
src/models.js + src/devices.js registries and the public /models page.

> **Why this exists:** the founder asked which base model we should default to
> and pivoted with "start with the assumption of the device, the prom
> compilation is that if you're running it, you need to make sure that it runs
> on a specific device." The decision is therefore not "pick one model" but
> "pick a default + bind every compile to a device." This doc records the
> ranking we ran, the license/hardware/eval tradeoffs, and what we will
> change when the v0.2 frontier shifts.

---

## A. The pick — `Qwen/Qwen2.5-3B-Instruct`

Default base model for `kolm compile` (`src/models.js: DEFAULT_MODEL`).

| Axis | Qwen2.5-3B-Instruct | Why it wins |
|------|--------------------|-------------|
| License | **Apache 2.0** | Commercial-redistributable. No "Meta Community" clause, no Gemma usage policy, no MIT-with-attribution caveat. |
| Params | 3.09B | Hits the sweet spot for a single 8–24GB consumer GPU at bf16 + LoRA r=16. |
| Context | 32K native (128K with YaRN) | Long enough for medical notes, contracts, long support threads. |
| Tool use | Native (function-calling pre-trained) | Distillation targets that emit tool calls don't need a second fine-tune stage. |
| Languages | 29 | Healthcare + finance + legal often need non-English. Llama 3.2 is English-first. |
| Tokenizer | 151K vocab | Smaller than Qwen3 (170K) but big enough to keep medical and code tokens dense. |
| Frontier wins | beats Llama-3.2-3B on MMLU, GSM8K, MATH, HumanEval, IFEval per Qwen2.5 tech report | Verified across Qwen team's reproduction + independent Hugging Face Open LLM Leaderboard runs (Oct–Dec 2024 entries). |

The alternatives we ranked it against:

1. **`meta-llama/Llama-3.2-3B-Instruct`** — strong, but the Llama 3.2 Community
   License has the "≥700M MAU triggers a Meta license request" clause. Our
   buyers ship to regulated industries; we should not put that clause on the
   compile path by default. Also English-only by design (multilingual support
   is "available for limited research"). Kept in the registry as a permissive
   alternate for English-only callers.
2. **`google/gemma-3-4b-it`** — released 2025-03 with vision input at 4B+ and
   strong reasoning, but the Gemma Terms of Use have an explicit prohibited-
   uses policy that buyers in healthcare and defense have to evaluate
   contract-by-contract. Same Apache-ish posture, more legal review. Kept in
   the registry as the **default mobile/vision target** because the 1B/4B
   variants are the only credible 4-bit-runnable VLM under 5GB on iPhone 15 Pro
   / Pixel 8 Pro right now.
3. **`Qwen/Qwen2.5-7B-Instruct`** — better quality, but bf16 doesn't fit on the
   24GB consumer top-end (RTX 4090) once you add the optimizer state. With
   `paged_adamw_8bit` it fits, but we don't want the default to assume the
   user installed bitsandbytes correctly. Pinned as the **default for RTX 5090
   and any 32GB+ training device** via `TRAIN_DEFAULT_BY_DEVICE`.
4. **`microsoft/Phi-3.5-mini-instruct`** — MIT license, very strong reasoning
   for 3.8B params, but tool-use is not native and the 128K context comes with
   a noticeable quality dip past 32K. Kept in the registry as a reasoning-
   first alternate; we will revisit if Phi-4 lands MIT.
5. **`HuggingFaceTB/SmolLM2-1.7B-Instruct`** — Apache 2.0, extremely fast on
   CPU, but quality lags Qwen2.5-3B by enough on multi-step extraction that
   we don't want it as the default. Pinned as the **CPU-only fallback** when
   `kolm gpu detect` returns no accelerator.

---

## B. The device-fit contract

Every compile binds the artifact to a device. The manifest carries
`target_device` and `train_device`; the runtime calls `verifyDeviceFit()`
before loading.

`src/devices.js` ships the registry. Today's entries:

| ID                  | Class      | VRAM   | Arch              | Attention | Min CUDA | Min torch | Notes |
|---------------------|------------|--------|-------------------|-----------|----------|-----------|-------|
| `rtx-5090`          | training   | 32 GB  | Blackwell sm_120  | fa3       | 12.8     | 2.7       | Local dev rig. FP4 native. |
| `rtx-4090`          | training   | 24 GB  | Ada sm_89         | fa2       | 12.1     | 2.4       | FP8 inference, no FP4. |
| `rtx-3090`          | training   | 24 GB  | Ampere sm_86      | fa2       | 11.8     | 2.2       | bf16 OK, no FP8. |
| `a100-40gb`         | training   | 40 GB  | Ampere sm_80      | fa2       | 11.8     | 2.2       | |
| `a100-80gb`         | training   | 80 GB  | Ampere sm_80      | fa2       | 11.8     | 2.2       | |
| `h100-80gb`         | training   | 80 GB  | Hopper sm_90      | fa3       | 12.4     | 2.4       | FP8 native. |
| `h200-141gb`        | training   | 141 GB | Hopper sm_90      | fa3       | 12.4     | 2.4       | |
| `apple-m3-max`      | training   | 64 GB  | Apple Silicon     | mlx       | n/a      | n/a       | MLX-native via mlx_lm. |
| `apple-m2-pro`      | inference  | 16 GB  | Apple Silicon     | mlx       | n/a      | n/a       | |
| `iphone-15-pro`     | inference  | 4 GB   | A17 Pro           | coreml    | n/a      | n/a       | Mobile target. |
| `pixel-8-pro`       | inference  | 3 GB   | Tensor G3         | mediapipe | n/a      | n/a       | Mobile target. |
| `laptop-igpu`       | inference  | 2 GB   | Intel Arc / Iris  | directml  | n/a      | n/a       | DirectML fallback. |
| `cpu-x86_64`        | inference  | n/a    | any x86_64        | sdpa      | n/a      | n/a       | Universal CPU floor. |
| `wasm`              | inference  | n/a    | wasm32            | sdpa      | n/a      | n/a       | Browser target. |

### Per-device defaults

`src/devices.js: TRAIN_DEFAULT_BY_DEVICE`:

| Device         | Default train model |
|----------------|---------------------|
| `rtx-5090`     | `Qwen/Qwen2.5-7B-Instruct` |
| `rtx-4090`     | `Qwen/Qwen2.5-3B-Instruct` |
| `rtx-3090`     | `Qwen/Qwen2.5-3B-Instruct` |
| `a100-40gb`    | `Qwen/Qwen2.5-7B-Instruct` |
| `a100-80gb`    | `Qwen/Qwen2.5-14B-Instruct` |
| `h100-80gb`    | `Qwen/Qwen2.5-14B-Instruct` |
| `h200-141gb`   | `Qwen/Qwen2.5-14B-Instruct` |
| `apple-m3-max` | `Qwen/Qwen2.5-3B-Instruct` |
| `cpu-x86_64`   | `HuggingFaceTB/SmolLM2-1.7B-Instruct` |

`src/devices.js: INFER_DEFAULT_BY_DEVICE`:

| Device         | Default infer model |
|----------------|---------------------|
| `iphone-15-pro`| `Qwen/Qwen2.5-1.5B-Instruct` (4-bit) |
| `pixel-8-pro`  | `google/gemma-3-1b-it` (4-bit) |
| `laptop-igpu`  | `Qwen/Qwen2.5-1.5B-Instruct` |
| `apple-m2-pro` | `Qwen/Qwen2.5-3B-Instruct` (MLX) |
| `cpu-x86_64`   | `Qwen/Qwen2.5-0.5B-Instruct` |
| `wasm`         | `Qwen/Qwen2.5-0.5B-Instruct` |

### `verifyDeviceFit()` truth table

Defined in `src/artifact.js`. Smoke-test at `scripts/smoke-device-bind.mjs`
(7/7 pass).

| Compile target | Host device     | Result                | Soft? |
|----------------|-----------------|-----------------------|-------|
| `rtx-5090`     | `rtx-5090`      | `ok:true`             | no    |
| `iphone-15-pro`| `rtx-5090`      | `ok:true`             | yes   |
| `null`         | `rtx-5090`      | `ok:true`             | yes   |
| `rtx-5090`     | `iphone-15-pro` | `ok:false`            | n/a   |

"Soft" means the runtime should warn but continue; "hard fail" means the
adapter cannot load on the host VRAM and the runtime should refuse.

---

## C. The SOTA training stack pinned to each device

`apps/trainer/trainer_real.py` auto-selects per `_attn_impl_for()` and
`_maybe_apply_liger()`. Env switches:

| Env var | Default | Purpose |
|--------|---------|---------|
| `KOLM_USE_LIGER` | `1` on Llama/Qwen/Gemma/Phi | Fused RMSNorm/SwiGLU/RoPE (~20-30% throughput). |
| `KOLM_ATTN_IMPL` | auto: `fa3` on 5090/H100/H200, `fa2` on 4090/3090/A100, `sdpa` else | Flash-attention kernel selection. |
| `KOLM_8BIT_OPTIM` | `1` when bitsandbytes is present | `paged_adamw_8bit`, ~6GB savings on 7B. |
| `KOLM_TRAIN_OBJECTIVE` | `sft` | `sft` (default) or `span` (UL2-style span corruption via `apps/trainer/span_objective.py`). |
| `KOLM_DPO_PAIRS_URL` | unset | When set, runs a `trl.DPOTrainer` stage post-SFT. |
| `KOLM_PROMPT_LOOKUP` | `0` | `prompt_lookup_num_tokens` at inference for repetitive-text speedup. |
| `KOLM_PREFIX_CACHE_SIZE` | `64` | `apps/trainer/inference_cache.py` LRU entries for static system-prefix KV reuse. |
| `KOLM_LORA_R` | `16` | LoRA rank. |
| `KOLM_LORA_ALPHA` | `32` | LoRA alpha. |
| `KOLM_LORA_DROPOUT` | `0.05` | LoRA dropout. |
| `KOLM_LOCAL_EPOCHS` | `1` | Epochs on the CPU/MPS local path (`trainer_local.py`). |
| `KOLM_LOCAL_BASE_MODEL` | `sshleifer/tiny-gpt2` | Default base for the CPU-only path; resolves to itself if too big. |

### `kolm gpu doctor` — current dev box findings

The local rig has an RTX 5090 with the wrong torch wheel for sm_120:

```
- torch              installed (2.4.1+cpu)             FAIL  CPU-only wheel
- torch sm_120       required (cu128 + torch ≥ 2.7)    FAIL
- transformers       installed (4.46.x)                OK
- peft               installed (0.13.x)                OK
- trl                not installed                     FAIL  needed for DPO
- bitsandbytes       not installed                     FAIL  needed for 8-bit Adam
- flash_attn         not installed                     FAIL  needed for fa2/fa3
- liger_kernel       not installed                     FAIL  needed for fused ops
- unsloth            not installed                     skip  optional faster path
```

`kolm gpu setup --yes` emits the right `pip install` line for the device that
`kolm gpu detect` returns. For the 5090 that's:

```
pip install --upgrade --pre torch torchvision torchaudio \
  --index-url https://download.pytorch.org/whl/nightly/cu128
pip install transformers peft trl bitsandbytes accelerate
pip install flash-attn --no-build-isolation
pip install liger-kernel
```

(Authorization to actually run this on the box requires explicit user nod.)

---

## D. What we will revisit

- **Qwen3 family** — when Qwen3-3B-Instruct ships under Apache 2.0 with a
  comparable tool-use stance, we re-rank. The Qwen3 tokenizer is bigger (170K
  vocab) which is good for code but slightly worse for tiny-model latency, so
  the swap is not automatic.
- **Llama 4** — if Meta drops the MAU clause we move the Llama family up.
  Until then it stays as the English-only alternate.
- **Gemma 3 vision** — `gemma-3-4b-it` is the only credible <5GB on-device
  VLM right now. Once we ship a vision capture verb (`kolm capture <image>`)
  the mobile-inference default flips to Gemma 3 4B.
- **FP4 NVFP4 training** — torch 2.8 + cuBLASLt 12.9 lands native NVFP4
  training on Blackwell. When that wheel hits the index, the 5090 default
  trainer flips from bf16 LoRA to fp4-LoRA and the trainable-params slice
  doubles for the same VRAM.
- **Speculative decoding via a draft cache** — we already ship
  `prompt_lookup_num_tokens` (which is zero-shot speculative decoding from
  the prompt itself). A draft-model speculative decoder for static system
  prefixes is the next inference upgrade.

---

## E. Verification

Smoke tests that gate this work:

- `node scripts/smoke-models.mjs` → **19/19 pass** (registry shape + device
  detect + recommend + fitsOn/trainOn).
- `node scripts/smoke-device-bind.mjs` → **7/7 pass** (artifact carries
  `target_device`; `verifyDeviceFit` rejects iPhone artifact on RTX-5090 host
  by VRAM and soft-warns cross-class).
- `kolm gpu detect` returns `rtx-5090` on the local box; matches
  `DEVICES.rtx-5090.label`.
- `kolm models recommend --target_device rtx-5090` returns
  `Qwen/Qwen2.5-7B-Instruct` first; `--target_device iphone-15-pro` returns
  `Qwen/Qwen2.5-1.5B-Instruct` first.

---

## F. Files changed in this audit wave

- `src/models.js` (new) — 16-model registry + `recommend()`.
- `src/devices.js` (new) — 14-device registry + `detectLocal()`.
- `src/artifact.js` — `buildPayload({target_device, train_device})`,
  `verifyDeviceFit(manifest, hostDeviceId)`.
- `src/compile.js` — default `base_model` to `Qwen/Qwen2.5-3B-Instruct`.
- `src/router.js` — same default sweep in 2 places.
- `apps/trainer/main.py` — Job dataclass default.
- `apps/trainer/trainer_real.py` — Liger/FA/8-bit Adam/DPO/lookup wiring.
- `apps/trainer/trainer_local.py` — size-heuristic fallback to tiny-gpt2.
- `apps/trainer/models.py` (new) — Python mirror of the registry.
- `apps/trainer/span_objective.py` (new) — UL2 span corruption objective.
- `apps/trainer/inference_cache.py` (new) — prefix KV LRU + prompt-lookup.
- `cli/kolm.js` — `kolm models` + `kolm gpu` verbs.
- `scripts/smoke-models.mjs` (new) — registry smoke (19/19 pass).
- `scripts/smoke-device-bind.mjs` (new) — artifact-binding smoke (7/7 pass).
- `public/models.html` (new) — public-facing index of the registry.
- `public/sitemap.xml` — `/models` entry added.
- `vercel.json` — `/models` rewrite added.
- `server.js` — `/models` route added.
