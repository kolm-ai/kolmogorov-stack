# KOLM W921 — Frontier Review & 10–100x Roadmap

> **EXECUTION STATUS (updated 2026-05-29, same session):**
> - **NOW-2 (EAGLE serve) + NOW-6 (multi-LoRA serve): ALREADY DONE** — the review analyzed the
>   pre-fix spec state; the shipped `apps/runtime/serve.py` already uses the modern vLLM
>   `speculative_config` (`method:'eagle3'`, no fabricated keys, via `eagle3.py`) and wires
>   `enable_lora`/`max_loras`. Live (the review's "dead wires" are not dead). Needs a vLLM GPU serve to perf-verify.
> - **NOW-4 (sequential gate → gating): SHIPPED** (`fe155fd1`) — autonomous deploy now requires the
>   anytime-valid mSPRT/GAVI 'promote' by default when an A/B test is in scope.
> - **NOW-3 (standards-conformant inference signatures): SHIPPED** (`60435ee5`) — `/.well-known/jwks.json`
>   (RFC 8037 OKP JWK) + `X-Inference-Signature`/`X-Inference-Key-ID` headers; round-trip-tested.
> - **Remaining NOW:** NOW-1 (edge students — needs HF model-existence check + a 5090 quantize run);
>   NOW-5 (WebGPU verified runner — needs browser WebGPU validation). **NEXT/BET are multi-day bets** below.


> Chief-architect review, 2026-05-29. Sources are web-verified for the last 2–3 weeks
> (mid-to-late May 2026); my training cutoff is Jan 2026 so every "newer than Jan 2026"
> claim below was confirmed by live web search (URLs + dates inline). Where a search
> returned nothing new, that is stated rather than invented.
>
> **What I read in-repo to ground this:** `KOLM_W921_PLAN.md`, `KOLM_W921_RESEARCH.md`
> (60 verified specs), `src/semantic-router.js` (full — solid Avengers-Pro cluster/KNN
> router, already cost+quality-aware), `src/gateway-receipt.js` (Ed25519 19-field
> kolm-audit-1 receipt builder, additive non-signed-block convention), `apps/trainer/distill.py`
> (FWD/REV-KL + JSD + a real DistiLLM-2 SKL/SRKL implementation already landed as
> `KDObjective.DISTILLM2`), `src/model-merge.js` (TIES/DARE/DELLA/SLERP merge in delta-W
> space with SVD refactor), and the public `.kolm` "Inside the file" anatomy
> (signed ZIP: `spec.toml` + `weights/` + frozen eval + K-Score bakeoff + hash-chained
> receipts + `manifest.json` SHA-256 + Ed25519 sidecar).

---

## TL;DR — the strategic read

kolm's W921 wave already shipped an enormous amount of the *right* frontier work
(semantic router, injection guardrail, circuit breaker, semantic cache, DistiLLM-2
loss, model merge, conformal/mSPRT autopilot stats, Merkle/in-toto provenance). The
gap is no longer "kolm lacks frontier techniques." It is three things:

1. **The frontier moved under kolm in the last 3 weeks.** Vendors now ship *native
   INT4 via QAT* (Kimi K2.6) and *official NVFP4 checkpoints* (NVIDIA Gemma-4), which
   reframes "kolm quantizes to INT4" from a differentiator into table stakes. kolm's
   post-hoc bitsandbytes-NF4 path must move to **quantization-aware distillation (QAD)**
   to stay ahead — and that is *exactly* the fusion of kolm's two core verbs (distill +
   quantize) into one, which no competitor packages.

2. **kolm built engines but left the last wire dark.** Per kolm's own spec #17, it
   *trains and compiles* EAGLE-3 heads but **never serves them** (`apps/runtime/serve.py`
   uses vLLM's removed flat `speculative_model` kwargs). EAGLE **3.1** shipped May 26 —
   so the serve gap is now a *version* gap too. Same pattern for multi-LoRA serving and
   on-policy distillation (`src/distill-onpolicy.js` is an empty shell).

3. **kolm's students are a generation behind, and its highest-value proof claim
   (verifiable inference) is software-trust where the frontier is now standardized
   wire-format + hardware-rooted.** New Apache-2.0 sub-2B / edge-MoE models
   (MiniCPM5-1B, LFM2.5-8B-A1B, Gemma-4 E2B/E4B) are far stronger student bases than
   kolm's Qwen2.5-0.5B/3B/7B defaults. And the IETF `draft-sharif` lifecycle-attestation
   draft specifies almost exactly kolm's receipt — but standardizes the *wire format*
   (`X-Inference-Signature` headers, JWKS discovery) kolm doesn't speak.

**The 100x move is to collapse kolm's two verbs into one (QAD), make the engines kolm
already built actually serve, jump students to the new edge tier, and turn the
"verifiable" claim from a kolm-signed assertion into a standards-conformant,
independently-checkable, on-device-runnable proof.**

---

## Where kolm is ALREADY ahead of frontier (do not rebuild — defend & market)

| Capability | kolm state | Frontier comparison |
|---|---|---|
| **Routing decision is *auditable*** | `semantic-router.js` stamps `route_score`, `rejected[]`, `cluster_id`, `cold_start` into the **non-signed receipt block** | RouteLLM / LiteLLM / OpenRouter / vLLM Semantic Router all route, but **none emit a signed/auditable record of *why*** a cheaper model was chosen. This is a genuine moat — lead with it. |
| **Distillation objective is real SOTA** | `apps/trainer/distill.py` already implements DistiLLM-2 SKL/SRKL (`skewed_kl`, `skewed_reverse_kl`, `distillm2_loss`, `adaptive_alpha`, `gradual_beta`) | distil-labs / OpenPipe / Lamini are SFT platforms. kolm's logit-level contrastive KD is ahead of the commercial pack (it must just be wired into the *shipping* path + given the black-box fallback, see NEXT-1). |
| **Model merging in correct delta-W space** | `model-merge.js` reconstructs `ΔW = (α/r)·B@A`, merges, SVD-refactorizes; records `merge_space='delta_w'` so a verifier confirms it wasn't a byte-copy | Most "LoRA merge" tooling merges A/B factors separately (mathematically wrong at differing rank). kolm does it right *and proves it*. |
| **Receipt + Merkle + in-toto/SLSA already present** | `gateway-receipt.js` + `receipt-schema.js` + the W921 `merkle.js`/`intoto-slsa.js` modules | kolm is *ahead* of most gateways on provenance primitives. The gap is standardization/wire-format, not existence (see NOW-3 / BET-3). |
| **Autopilot uses anytime-valid stats** | W921 shipped conformal intervals + mSPRT/GAVI sequential gate (advisory) | Most "self-improving" pipelines peek a fixed-horizon t-test (statistically invalid). kolm already has the correct machinery — just promote it from advisory to gating. |
| **`.kolm` artifact is a sealed, hash-pinned, signed, offline-verifiable file** | spec.toml + weights + frozen eval + K-Score bakeoff + hash-chained receipts + manifest SHA-256 + Ed25519 sidecar | This is genuinely differentiated packaging. The OpenSSF/Sigstore world signs *weights*; kolm signs the *whole reproducible lineage*. Align the envelope (BET-3) but the concept leads. |

---

# NOW — ship this week (GPU-free or single-5090-runnable)

### NOW-1 — Add the new edge/sub-2B student tier (MiniCPM5-1B, LFM2.5, Gemma-4 E2B/E4B) to recipes + validate quantize path
- **Frontier basis:** MiniCPM5-1B (Apache-2.0, sub-2B SOTA, native MCP/tool-calling, ~0.5 GB quantized), released **2026-05-19** ([HF](https://huggingface.co/openbmb/MiniCPM5-1B)); LFM2.5-8B-A1B (8.3B total / 1.5B active edge-MoE, day-one llama.cpp/MLX/vLLM/SGLang), released **2026-05-28** ([Liquid AI](https://www.liquid.ai/blog/lfm2-5-8b-a1b), [MarkTechPost](https://www.marktechpost.com/2026/05/28/liquid-ai-releases-lfm2-5-8b-a1b-an-on-device-moe-model-with-8-3b-total-and-1-5b-active-parameters/)); Gemma-4 E2B/E4B (Apache-2.0 edge, 2026-03).
- **kolm gap:** proven students are dense Qwen2.5-0.5B/3B/7B + Qwen3-8B. The "runs on a phone" demo (kolm's strongest self-host narrative) has no model behind it. MiniCPM5-1B is dense → kolm's existing NF4 path applies directly *today*.
- **Implementation:** add `recipes/minicpm5-1b-*.json` + `recipes/gemma4-e4b-*.json`; register the bases in `src/distill-recipe-loader.js` and the student catalog; run the existing bitsandbytes NF4 quantize worker on MiniCPM5-1B on the 5090 to produce a real `~0.5 GB` artifact + receipt; add to `recipes/` and the registry page. (LFM2.5 is MoE — defer its quantize to NEXT-4; add it as a *teacher/eval* candidate now.)
- **User impact:** instantly modernizes the product's headline "smallest artifact" story with a real sub-1 GB signed `.kolm` that beats the old Qwen2.5-0.5B on every axis; unblocks the on-device demo (NOW-5).
- **Effort:** S · **10x** (M if you also do the on-device runner — see NOW-5).

### NOW-2 — Fix the EAGLE serve wire and version-gate it to EAGLE 3.1
- **Frontier basis:** EAGLE **3.1** (FC-normalization fixes "attention drift"; up to 2x longer acceptance length in long-context; backward-compatible with EAGLE-3 checkpoints; ships in **vLLM v0.22.0**), released **2026-05-26** ([vLLM blog](https://vllm.ai/blog/2026-05-26-eagle-3-1), [MarkTechPost](https://www.marktechpost.com/2026/05/27/meet-eagle-3-1-the-speculative-decoding-algorithm-that-fixes-attention-drift-in-llm-inference/)).
- **kolm gap (kolm's own spec #17, verified):** `apps/runtime/serve.py` sets vLLM's *removed* flat kwargs `speculative_model` / `num_speculative_tokens` (deprecated since vLLM 0.10) and never imports `eagle3.py`, which itself emits a fabricated `draft_model_type` key vLLM never reads. So kolm **trains and compiles** EAGLE heads that **never actually serve**. The marquee decode-speed feature is dead in the served product.
- **Implementation:** rewrite `_try_vllm` in `apps/runtime/serve.py` to build the modern `speculative_config={'method':'eagle3','model':<head>,'num_speculative_tokens':K}`; version-gate the EAGLE-3.1 path behind `vllm>=0.22.0`; add the SGLang `--speculative-algorithm EAGLE3` path; add `head_kind`/`eagle_topk`/`num_steps` fields to the artifact manifest; delete the fabricated `draft_model_type` key in `apps/runtime/eagle3.py`. Touch `src/speculative-decoding.js` / `src/serve-autodetect.js` to surface the served config.
- **User impact:** the speed claim kolm already sells becomes *true* — up to 2x acceptance length on the long-context/agentic workloads kolm targets, with zero new training (backward-compatible checkpoints).
- **Effort:** M · **10x** (it converts an existing-but-dead feature into a live one; pure wiring, no new science).

### NOW-3 — Emit a standards-conformant inference-signature wire format alongside native receipts
- **Frontier basis:** IETF `draft-sharif-ai-model-lifecycle-attestation-00` (**2026-03-31**) — ECDSA P-256, RFC 6962 Merkle, **`X-Inference-Signature` / `X-Inference-Key-ID` HTTP headers, JWKS key discovery, SSE-terminated streaming sig** ([datatracker](https://datatracker.ietf.org/doc/draft-sharif-ai-model-lifecycle-attestation/)). Plus the *newer* `draft-tsyrulnikov-rats-attested-inference-receipt-01` (AIR — a COSE/CWT profile for confidential AI inference), surfaced in the same search — a second converging standard.
- **kolm gap:** kolm signs Ed25519 over a proprietary `kolm-audit-1` JSON schema and exposes no JWKS endpoint and no per-inference HTTP-header signature consumable by a third party. A buyer's existing supply-chain tooling can't ingest a kolm receipt.
- **Implementation:** add a *compatibility profile* — keep native `.kolm` receipts, but additionally (a) emit `X-Inference-Signature` + `X-Inference-Key-ID` response headers from the gateway dispatch path (`src/router.js` dispatch + `src/gateway-receipt.js`), (b) stand up `GET /.well-known/jwks.json` exposing the Ed25519 public key in JWK form, (c) ship the streaming-final-SSE signature event. No new crypto — reuses `src/ed25519.js`. Add a `scripts/release-verify.cjs` gate that round-trips a kolm receipt through the draft-sharif shape.
- **User impact:** turns "kolm signed it" into "any standards-aware verifier can check it without trusting kolm" — the difference between a marketing claim and an enterprise procurement checkbox before the **EU AI Act enforcement date of 2026-08-02**.
- **Effort:** M · **10x**.

### NOW-4 — Promote the autopilot sequential gate from advisory to gating (close the peeking hole)
- **Frontier basis:** mSPRT (Statsig) + GAVI confidence sequences (Eppo) — the industry-standard anytime-valid procedures; already specced and *built* in kolm's W921 (`src/stat-sig.js` sequential functions). No new external release needed; this is a correctness fix.
- **kolm gap:** the W921 status notes the mSPRT/GAVI gate is **advisory** on `autopilot-lifecycle` + `ab-router`. The autonomous deploy path still gates on a fixed-horizon point estimate, which inflates Type-I error toward ~1 under minutely cron peeking — a correctness bug on the highest-blast-radius path (autonomous promotion).
- **Implementation:** add condition (6) `sequential_promote` to `src/autopilot-lifecycle.js::_evaluateDeploy` so the `--auto` EXECUTE path *requires* `sequentialGate() === 'promote'` when an A/B test is in scope; env-gate `ab-router.autoRollback` to prefer the sequential decision (`KOLM_AB_SEQUENTIAL` default ON). Surface the anytime-valid interval in `getAbStatus()`.
- **User impact:** makes the "self-improving loop you can actually leave running unattended" claim defensible — the entire autopilot value prop.
- **Effort:** S · **10x**.

### NOW-5 — Ship a `kolm verify`-gated WebGPU/MLX on-device runner for `.kolm` artifacts
- **Frontier basis:** official llama.cpp/ggml WebGPU backend + "LlamaWeb" (arXiv **2605.20706**, submitted **2026-05-20**, 16 devices / 8 vendors, **+45–69% decode**, **−29–33% VRAM** in-browser) ([arXiv](https://arxiv.org/abs/2605.20706)); MLX as the fastest Apple-silicon path (Ollama 0.19+ uses MLX).
- **kolm gap:** kolm produces GGUF but has no browser/WebGPU or MLX-native execution path, and no signature-verification at on-device load time. The privacy story ("data never leaves your laptop, *and you can verify the model*") is unrealized.
- **Implementation:** a static `public/run/` page that loads a kolm GGUF via the llama.cpp WebGPU build, **verifies the Ed25519 sidecar against `manifest.sha256` in-browser before load**, and runs fully offline. Reuse the demo's existing in-browser Ed25519 verify (already shipped in `demo-live.html`). Add `kolm serve --target mlx` autodetect in `src/serve-autodetect.js` for Apple silicon.
- **User impact:** the single most compelling "verifiable on-device inference" demo nobody else can show — pairs the NOW-1 sub-1 GB MiniCPM5 artifact with a zero-network, signature-checked, in-browser run.
- **Effort:** M · **100x** (this is the demo that makes the whole thesis viscerally undeniable).

### NOW-6 — Wire multi-LoRA serving into the serve path
- **Frontier basis:** vLLM `enable_lora` multi-adapter serving (one base, N adapters, per-request switch) — established, and the economic backbone of "distill many cheap specialists." Reinforced by the edge-MoE trend (per-skill experts).
- **kolm gap (run.frontier #0, critical):** the Python (`apps/runtime/multi_lora.py`) is implemented but **not wired into the serve path**, so the marquee "distill many small adapters, serve them cheaply on one GPU" economics aren't deliverable.
- **Implementation:** thread `multi_lora.py` into `apps/runtime/serve.py` and `src/deploy-generators.js`; add `src/multi-lora-plan.js` surfacing the per-request adapter switch; CLI `kolm serve --multi-lora a1,a2,a3`.
- **User impact:** unlocks the per-skill adapter business model and pairs directly with model-merge (kolm already ships the merge math).
- **Effort:** M · **10x**.

---

# NEXT — needs a build (multi-day, may need GPU time)

### NEXT-1 — Black-box on-policy distillation (ROPD) so on-policy KD works for API teachers
- **Frontier basis:** ROPD — Rubric-based On-policy Distillation (arXiv **2605.07396**, **2026-05-12**, code released) — induces prompt-specific rubrics from teacher-vs-student output *contrasts*, scores student rollouts with only **teacher text** (no logits), claims **up to 10x sample efficiency** and beats logit-based OPD even when logits are available ([arXiv](https://arxiv.org/html/2605.07396v1), [GitHub](https://github.com/Peregrine123/ROPD_official), [HF](https://huggingface.co/papers/2605.07396)).
- **kolm gap:** `src/distill-onpolicy.js` is an empty shell (`{ok:false,error:'no_trainer_installed'}`); `distill.py`'s `on_policy` flag is dead. kolm's *dominant* teacher regime is **black-box API** (Anthropic/OpenAI/Cerebras via `teacher-bridge.mjs`, which captures text only). DistiLLM-2 (already implemented) is white-box-only → useless for the majority of kolm users. ROPD is the published, code-backed path that fixes exactly this.
- **Implementation:** implement the rubric-induction + rollout-scoring loop in `apps/trainer/` (new `ropd.py`), reusing kolm's **existing K-Score rubric gate** (`src/kscore.js` / `src/tune.js`) as the scoring layer; wire `src/distill-onpolicy.js` to dispatch it; add a recipe `objective: 'ropd'`; gate to "teacher text available" (always true). On-policy student generation reuses `generate_student_responses()` already in `distill.py`.
- **User impact:** kolm's distillation finally works *on-policy* for the regime most customers are actually in (started from a Claude/GPT capture) — the difference between "we imitate teacher text" and "we close the student's own error distribution."
- **Effort:** L · **100x** (this is the single biggest distill-quality unlock for the real user base).

### NEXT-2 — Quantization-Aware Distillation (QAD) for NVFP4/INT4 — fuse kolm's two verbs
- **Frontier basis:** NVIDIA Nemotron QAD report (2026-03) — train the *already-quantized* student against a high-precision teacher to recover near-BF16 accuracy ([NVIDIA](https://research.nvidia.com/labs/nemotron/nemotron-qad/)); Kimi K2.6 native INT4 via QAT, ~2x speed / 50% memory, "negligible" loss, released **2026-04-20** ([HF](https://huggingface.co/moonshotai/Kimi-K2.6), [codersera](https://codersera.com/blog/kimi-k2-6-complete-guide-2026/)); official NVIDIA Gemma-4-NVFP4 checkpoint.
- **kolm gap:** kolm treats distill and quantize as *separate* pipeline stages; its NVFP4/INT4 path is **PTQ-only with no accuracy-recovery loop**. Vendors now ship QAT/QAD checkpoints that strictly beat post-hoc quantization — eroding "kolm quantizes to INT4" unless kolm's INT4 *matches QAT quality*.
- **Implementation:** add a QAD schedule that runs kolm's existing `distill.py` losses (the DistiLLM-2 SKL/SRKL is perfect here) with the student weights in the quantized (NVFP4/INT4) numerical format during training — fake-quant forward, full-precision teacher target. New `apps/trainer/qad.py` + a recipe `quant_aware: true`; reuse `export-nvfp4.js` for the format. This is the *natural fusion of kolm's two core capabilities into one* — a positioning no competitor packages.
- **User impact:** kolm INT4/NVFP4 artifacts match QAT-recovered quality instead of trailing it; "we don't just quantize your model, we *distill it into* the quantized format" becomes the new headline.
- **Effort:** L · **100x** (architectural-adjacent; the strategic answer to the "vendors ship their own INT4" threat).

### NEXT-3 — FP4-aware PTQ calibration (BATQuant-style block-granular transforms)
- **Frontier basis:** BATQuant (arXiv **2603.16590**, 2026-03) — rotation-based PTQ (SpinQuant/Hadamard) **collapses on MXFP4**; block-granular learnable affine transforms + block-wise learnable clipping recover **96.43% of FP** at W4A4 ([arXiv](https://arxiv.org/abs/2603.16590)).
- **kolm gap:** kolm *exports* NVFP4/MXFP4 but has **no FP4-aware calibration**; the W921 quant-kernel-oracle even reuses rotation/`desc_act`/`sym` assumptions that BATQuant proves *fail* on FP4. A kolm FP4 export likely loses far more than 3.57%.
- **Implementation:** add a block-granular calibration pass (no global rotation) + block-wise learnable clipping in the quant worker feeding `export-nvfp4.js` / `export-fp8.js`; gate on `quant_kernel_oracle` selecting an FP4 target. Pairs with NEXT-2 (QAD recovers what calibration can't).
- **User impact:** kolm's Blackwell-class FP4 artifacts retain accuracy instead of silently degrading — required to credibly claim NVFP4 support against NVIDIA's own checkpoints.
- **Effort:** M · **10x**.

### NEXT-4 — MoE-aware distillation + quantization (LFM2.5, Gemma-4 26B-A4B, Qwen3.7 27B/35B-A3B)
- **Frontier basis:** the entire late-May wave is MoE/edge-MoE: LFM2.5-8B-A1B (2026-05-28), Gemma-4 26B-A4B + NVFP4 (2026-03), Ling-2.6-flash INT4 (MIT, 2026-04-21), and Qwen3.7 open 27B/35B-A3B expected **~June 2026** ([Qwen3.7-Max API-only, 2026-05-20](https://www.marktechpost.com/2026/05/21/qwen-introduces-qwen3-7-max-a-reasoning-agent-model-with-a-1m-token-context-window/)).
- **kolm gap:** kolm's distill + NF4 quantize paths are **dense-only proven**. MoE routing + hybrid (conv/linear-attention) backbones break the bitsandbytes path. kolm can't yet use these as student *or* teacher.
- **Implementation:** add MoE-aware quantize (per-expert grouping, shared-expert handling) in the quant worker; add MoE student support in `distill.py` (route-aware loss masking); pre-wire `src/distill-recipe-loader.js` to pick up Qwen3.7 open weights *on day one* (a `pin: 'qwen3.7-27b-a3b@latest'` recipe behind a feature flag). Validate on LFM2.5 (open, available now) so the path is proven before Qwen3.7 lands.
- **User impact:** keeps kolm's student/teacher catalog current with the actual SOTA tier instead of a generation behind; positions kolm to ship a Qwen3.7 recipe the week weights drop.
- **Effort:** L · **100x** (this is the catalog-relevance bet; without it kolm distills yesterday's models).

### NEXT-5 — Multi-signal + multimodal routing to match (and out-prove) vLLM Semantic Router
- **Frontier basis:** vLLM Semantic Router "From Text to Multimodal Routing" (**2026-05-28**) + "98x Faster LLM Routing Without a Dedicated GPU" (arXiv 2603.12646) — 8 neural classifiers (intent, jailbreak, PII, hallucination, fact-check) on CPU-cheap mmBERT, now multimodal ([vLLM blog](https://vllm.ai/blog), [arXiv](https://arxiv.org/abs/2603.12646)).
- **kolm gap:** kolm's `semantic-router.js` is cost/latency/quality-aware (good) but single-signal (no jailbreak/PII/hallucination *fused into the routing decision*) and text-only; no published routing-quality benchmark.
- **Implementation:** fuse the *already-shipped* guardrail + PII signals into the route score as additional terms in `scoreRoute`; add a `route_signals` block to the receipt; benchmark kolm's router against vLLM-SR on RouterEval/LLMRouterBench and publish the delta. kolm's *unique* edge: it can **stamp the multi-signal routing decision into a signed receipt** — out-prove, don't just match.
- **User impact:** defends the routing surface against a free first-party vLLM option by making kolm's the only *auditable* multi-signal router.
- **Effort:** M · **10x**.

### NEXT-6 — Persist the routing quality label + prompt text (unblock the router's quality term)
- **Frontier basis:** kolm's own router design (Avengers-Pro) needs a per-(cluster,model) win/loss signal; the open question in `KOLM_W921_RESEARCH.md` flags the lake stores **no quality label and no prompt text**.
- **kolm gap:** `semantic-router.js` ships as a cost+latency reorderer because the quality term has no data; `trainClustersFromLake` falls back to `accepted`/transport-ok as a weak win.
- **Implementation:** add a `prompt_redacted` + `judge_win` capture field to `src/lake.js` / `src/capture.js` (redacted, opt-in, retention-bounded); feed the K-Score judge result back as the win label; this lights up the quality term that's already coded.
- **User impact:** converts kolm's router from "cheapest" to "cheapest that *clears the measured bar*" — the actual pitch.
- **Effort:** M · **10x**.

---

# BET — architectural (weeks; reshapes the product)

### BET-1 — A proof-of-correct-inference tier above signed receipts (sampling-based PoI)
- **Frontier basis:** "Towards Verifiable AI with Lightweight Cryptographic Proofs of Inference" (SaTML 2026 / IACR **2026/541**, arXiv 2603.19025) — Merkle-committed execution trace, open a few sampled paths, *proves the right model ran the right compute* without full zkML cost ([eprint](https://eprint.iacr.org/2026/541)). Plus GPU-TEE attestation going mainstream (Phala/OpenRouter >1B tokens/day; NVIDIA CC on H100/B200 <5% overhead).
- **kolm gap:** kolm receipts **assert** (via signature) that a model produced an output, but a signature only proves *key custody*, not that the claimed compute ran. A key holder can sign output from a cheaper/different model — the exact "silent substitution" threat the sharif draft names. This is kolm's deepest technical gap: it is at "authenticated," not "verifiable compute."
- **Implementation:** two complementary tiers. (a) Software: implement the sampling-based PoI — commit the inference execution trace via Merkle (kolm already has `merkle.js`), open k sampled output→input paths, embed the proof in the receipt. (b) Hardware: let the self-hosted runtime embed an NVIDIA CC GPU-TEE attestation quote into the receipt, so "kolm signed this" becomes "this enclave provably ran exactly this model."
- **User impact:** moves kolm from "signed" to "*proven*" — the deepest moat in the product, directly answering enterprise/regulated buyers who increasingly expect TEE-grade attestation.
- **Effort:** L · **100x**.

### BET-2 — Distill *from* a self-hostable trillion-param MoE teacher (Ring-2.6-1T / DeepSeek V4 / Kimi K2.6)
- **Frontier basis:** Ring-2.6-1T (MIT, ~1T/63B-active, adaptive reasoning-effort, **2026-05-08**) ([codersera](https://codersera.com/blog/ring-2-6-1t-ant-group-trillion-parameter-reasoning-model-2026/)); Kimi K2.6 (1T/32B-active, native INT4, MIT-ish); DeepSeek V4 (MIT). Genuinely recent, fully open, highest-ceiling self-hostable teachers.
- **kolm gap:** kolm's proven local teacher is DeepSeek-R1-32B-INT4 on **one** 5090. It has no demonstrated path to host or distill *from* a 1T-MoE teacher (even 32B active needs multi-GPU or KTransformers/SGLang MoE-offload), and no MoE-aware trace capture.
- **Implementation:** wire KTransformers/SGLang MoE-offload teacher serving into the `distill-local` worker; add MoE-aware teacher-trace capture (works with ROPD/NEXT-1 since black-box text suffices for the 1T teacher even when full logits are infeasible). Pairs with NEXT-4 (MoE student) for a 1T→edge-MoE distill story.
- **User impact:** "distill the world's best open trillion-param reasoner into a file that runs on your laptop" — the most ambitious, on-brand demo kolm could ship.
- **Effort:** L · **100x**.

### BET-3 — Align the `.kolm` envelope with Sigstore (keyless) + in-toto/ITE-6 + OpenSSF Model Signing
- **Frontier basis:** OpenSSF Model Signing v1.0 + Sigstore model-transparency (keyless OIDC + Rekor transparency log), adopted by Cohere + Red Hat; in-toto ITE-6 is the common SLSA/Sigstore envelope ([sigstore/model-transparency](https://github.com/sigstore/model-transparency)). Plus RSP (`draft-reilly-sentinel-protocol`) — OpenTimestamps/Bitcoin public anchoring + triple-hash post-quantum.
- **kolm gap:** kolm uses self-managed Ed25519 keys, a proprietary receipt schema, and publishes to no public transparency log — so kolm artifacts are invisible to enterprise supply-chain tooling, and "who really signed this" is weaker than Sigstore's vendor-neutral keyless guarantee.
- **Implementation:** add a keyless Sigstore signing option (Fulcio cert + Rekor inclusion proof) for `.kolm` artifacts; emit an in-toto ITE-6 statement so SLSA pipelines can ingest; expose `kolm verify` against the Rekor log; optionally anchor the daily Merkle root via free OpenTimestamps (RSP-style) so a third party can verify a receipt existed at time T without trusting kolm.
- **User impact:** kolm artifacts become first-class citizens in the standardized ML supply-chain — the credibility win that turns "interesting" into "approved by security."
- **Effort:** M–L · **10x**.

### BET-4 — Governed MCP tool-gateway with *signed tool-call receipts*
- **Frontier basis:** MCP spec RC locked **2026-05-21** (mandatory PKCE, Client ID Metadata Documents, step-up auth); Bifrost MCP gateway (~11–50µs overhead, "Code Mode" −50% tokens); LiteLLM moving toward "signed usage receipts." The LLM gateway and MCP/tool gateway categories are fusing.
- **kolm gap:** kolm has *no* MCP tool-gateway layer. Buyers comparing kolm to Bifrost/Portkey/LiteLLM now expect OAuth-scoped, auditable tool access as part of the gateway.
- **Implementation:** add an MCP server registry with OAuth-scoped tool access (PKCE/CIMD/step-up per the RC) to the gateway; **extend kolm's receipt primitive to sign tool-calls** ("which agent, which delegation, which tool, what budget") — a clean extension of the thing kolm already does best, and a differentiator vs gateways whose receipts are nascent.
- **User impact:** extends kolm's unique receipt thesis into the fastest-growing part of the gateway market.
- **Effort:** L · **100x**.

---

## Prioritized one-screen sequencing

| # | Move | Group | Effort | Tag |
|---|---|---|---|---|
| NOW-1 | New edge/sub-2B students (MiniCPM5-1B, Gemma-4, LFM2.5) | NOW | S | 10x |
| NOW-2 | Fix EAGLE serve wire → EAGLE 3.1 (vLLM 0.22) | NOW | M | 10x |
| NOW-3 | Standards-conformant `X-Inference-Signature` + JWKS | NOW | M | 10x |
| NOW-4 | Promote autopilot sequential gate to gating | NOW | S | 10x |
| NOW-5 | `kolm verify`-gated WebGPU/MLX on-device runner | NOW | M | **100x** |
| NOW-6 | Wire multi-LoRA serving into serve path | NOW | M | 10x |
| NEXT-1 | ROPD black-box on-policy distillation | NEXT | L | **100x** |
| NEXT-2 | Quantization-Aware Distillation (fuse distill+quantize) | NEXT | L | **100x** |
| NEXT-3 | FP4-aware PTQ calibration (BATQuant) | NEXT | M | 10x |
| NEXT-4 | MoE-aware distill+quantize (Qwen3.7 day-one) | NEXT | L | **100x** |
| NEXT-5 | Multi-signal + multimodal auditable routing | NEXT | M | 10x |
| NEXT-6 | Persist routing quality label + prompt text | NEXT | M | 10x |
| BET-1 | Proof-of-correct-inference + GPU-TEE attestation | BET | L | **100x** |
| BET-2 | Distill from a 1T-MoE open teacher | BET | L | **100x** |
| BET-3 | Sigstore/in-toto/OpenTimestamps envelope alignment | BET | M–L | 10x |
| BET-4 | Governed MCP gateway with signed tool-call receipts | BET | L | **100x** |

## Two-week critical path (highest leverage, lowest risk first)
1. **NOW-2 + NOW-6** (serve wires — turn dead engines live; pure wiring, 5090-runnable).
2. **NOW-1 + NOW-5** (new student + on-device verified runner — the visceral demo).
3. **NOW-4 + NOW-3** (gating correctness + standards wire — GPU-free, credibility).
4. Kick off **NEXT-1 (ROPD)** and **NEXT-2 (QAD)** in parallel build lanes — these two are the durable 100x distillation moves that answer the two biggest frontier threats (black-box-teacher majority + vendor-native-INT4).

---

## Notes on sourcing / what I could NOT confirm
- All eight scan areas resolved to live, dated sources (URLs inline above). The freshest
  items (LFM2.5 2026-05-28, EAGLE 3.1 2026-05-26, vLLM multimodal router 2026-05-28,
  ROPD 2026-05-12) are all within the last 2–3 weeks and web-verified.
- **New find not in the scan:** `draft-tsyrulnikov-rats-attested-inference-receipt-01`
  (AIR — COSE/CWT profile for confidential AI inference) on the IETF datatracker — a
  *second* converging inference-receipt standard. Relevant to NOW-3 / BET-3; worth a
  read before locking the receipt wire format.
- Qwen3.7 open 27B/35B-A3B weights are **not yet released** as of 2026-05-29 (Max is
  API-only); NEXT-4's day-one recipe is a *pre-wire*, not a claim that weights exist.
