# KOLM W866+ FORGE / DISTILL / LAB FRONTIER SPRINT — 2026-05-25

**Status:** in flight. Owner: Forge core + CLI + Account UI parity team.
**Mandate:** "100% FINISHED PRODUCT SURFACE FOR LAB / FORGE / DISTILL ARM" (user verbatim, 2026-05-25).
**Bar:** match or exceed MiniMax M27 NVFP4 (Blackwell GB10), Gemma 4 26B-A4B Heretic (sparse-aware quant), Qwen 3.6 27B (40 tok/s @ 16GB), Qwopus 3.6 27B v2 (full GGUF ladder + merge), DeepSeek V4 Pro (400B+ GGUF).

## Reference projects (the bar to beat)

| # | Project | Capability we must match |
|---|---------|--------------------------|
| 1 | [MiniMax M27 NVFP4 GB10](https://github.com/r0b0tlab/minimax-m27-nvfp4-gb10-benchmark) | 456B/45B-active MoE, vLLM NVFP4 microscaling, Blackwell-native FP4 |
| 2 | [Gemma 4 26B-A4B Heretic](https://huggingface.co/coder3101/gemma-4-26B-A4B-it-heretic) | Architecture-aware quant of sparse-active MoE |
| 3 | [Qwen 3.6 27B 40tok/s 16GB](https://www.reddit.com/r/LocalLLaMA/comments/1tkzk9e/qwen36_27b_pure_quant_40_toks_on_16_gb_vram/) | Aggressive EXL2/IQ4 — consumer GPU perf bar |
| 4 | [Qwopus 3.6 27B v2 GGUF](https://huggingface.co/Jackrong/Qwopus3.6-27B-v2-GGUF) | Merge → GGUF full quant ladder (Q2_K..Q8_0) |
| 5 | [DeepSeek V4 Pro GGUF](https://huggingface.co/teamblobfish/DeepSeek-V4-Pro-GGUF) | 400-600B+ MoE GGUF, split-file, MoE-aware |

## 10 GAPS (the work)

### GAP 1 — MoE Architecture Awareness (W867)
- Detect MoE from config.json (`num_experts`, `num_experts_per_tok`, equivalents)
- MoE-aware LoRA: shared layers + top-K activated experts only
- MoE-aware quant: router @ FP16/FP8 floor, attention per-DAQ, expert MLPs per activation freq
- Expert pruning for narrow-task artifacts (<1% activation gated by K-Score)
- Runtime passport: `total_params` + `active_params`, mem=total, compute=active
- MoE-aware TAAS: active vs total vs expert count trade

### GAP 2 — Full Quantization Method Coverage (W868-W872)
- **W868 GGUF (highest prio):** full quant ladder Q2_K..Q8_0 + IQ ladder IQ1_S..IQ4_NL; imatrix from artifact eval (DAQ); chat template + tokenizer + metadata; split-file >50GB; verify in llama-cpp-python
- **W869 EXL2:** exllamav2, 2.0-8.0 bpw variable, calibrate on eval, optimal bpw given VRAM+ctx
- **W870 GPTQ+AWQ:** auto-gptq + autoawq; calibrate on eval; Marlin kernel for GPTQ
- **W871 NVFP4+FP8:** Blackwell-native FP4 (cc 10.0+) via TRT-LLM/vLLM; Hopper FP8 E4M3/E5M2
- **W872 HQQ:** calibration-free 2/3/4-bit quick-iter path

### GAP 3 — Hardware-Aware Target Selection (W873)
- `detect_gpu_capabilities()` matrix (Blackwell/Hopper/Ada/Ampere/Apple/CPU)
- Auto-select quant given (model, hw, quality, latency, ctx) — fits-in-VRAM → rank → pick → rationale
- `will_it_fit(params, quant, vram, ctx, batch)` — weights + KV cache + activations + overhead

### GAP 4 — Large Model Handling 100B+ (W874)
- Sharded weight loading (`model-NNNNN-of-MMMMM.safetensors`)
- Streaming/layer-by-layer quant (never full FP16 in RAM)
- Multi-GPU calibration distribution
- Split-file GGUF output >50GB
- Per-layer progress/ETA + resumable checkpoints + structured JSON logs

### GAP 5 — Model Merging Pipeline (W875)
- mergekit integration (linear / SLERP / TIES / DARE / passthrough)
- `kolm merge --models A B --method ties --weights 0.6 0.4 --output merged/`
- Post-merge eval → quantize → seal
- Artifact passport: merge lineage
- Merge-aware TAAS

### GAP 6 — Export Format Parity & Metadata (W876)
- GGUF metadata (general.* + kolm.* + tokenizer.chat_template + llm.context_length)
- HF model card auto-gen (name/desc/license/base/method/quant/K-Score/HW/usage/citation)
- Ollama Modelfile (FROM/TEMPLATE/PARAMETER/SYSTEM)
- vLLM serving config dict

### GAP 7 — `kolm serve` Production Serving (W877)
- Auto-detect format + hardware → pick runtime
- Sub-runtimes: vLLM, llama.cpp, Ollama, Docker
- OpenAI-compatible /v1/chat/completions
- Receipt log for continuous monitoring

### GAP 8 — Continuous Quality Verification (W878)
- `verify_export(artifact, eval, teacher, runtime)` → load, gen, compare, compute K-Score Δ + perplexity Δ + accuracy Δ + tok/s + VRAM + TTFT
- Reject below floor, recommend less aggressive
- Store in `runtime_passport` + `quantization_risk_report`
- RUN FOR EVERY EXPORT

### GAP 9 — CI Test Suite (W879)
20 tests minimum — see full list in memory + plan body below.

### GAP 10 — `kolm bench` Benchmark Reproduction (W880)
- Reproduce reference results (Qwen 27B → 40 tok/s 16GB, DeepSeek MoE on 5090, etc.)
- `kolm bench --artifact X --all-targets` → full perf+quality matrix
- Output: structured JSON in artifact passport

## 14-step execution order

1. **W868 GGUF export** — highest impact, unlocks local ecosystem
2. **W867 MoE detection + aware quant**
3. **W873 hardware capability detection + auto-method**
4. **W873 memory fit calculator + runtime passport entries**
5. **W869 EXL2 export + DAQ calibration**
6. **W870 GPTQ + AWQ exports**
7. **W874 large model sharded handling**
8. **W875 model merging pipeline**
9. **W877 `kolm serve` auto-detect**
10. **W871 NVFP4/FP8 native paths**
11. **W872 HQQ calibration-free**
12. **W879 CI test suite**
13. **W880 `kolm bench` reproduction tool**
14. **W876 HF model card + Ollama Modelfile generation**

## Surface parity required (the triangle, every wave)

Every wave touches ALL of these or the surface is incomplete:

1. **Forge core** — `src/forge/*`, `src/quantize/*`, `src/export/*`, `src/merge/*`, `src/serve/*`, `src/bench/*`
2. **CLI** — `cli/kolm.js` verbs `compile`/`distill`/`quantize`/`merge`/`serve`/`bench` with all flags
3. **Account tab** — `/account/forge/*`, `/account/distill/*`, `/account/quantize/*`, `/account/merge/*`, `/account/serve/*`, `/account/bench/*`
4. **TUI** — `TUI_VIEWS` entries
5. **HTTP routes** — `src/router.js` `/v1/forge/*`, `/v1/quantize/*`, `/v1/merge/*`, `/v1/serve/*`, `/v1/bench/*`
6. **Tests** — `tests/wave86X-*.test.js` for every wave

## Standards (binding)

- Production code, type hints + docstrings (params/returns/raises)
- Tests for every new function
- Update `ForgeTrainConfig` + `ForgeExportConfig` with new options
- Update CLI flags + Account UI
- Update runtime_passport schema for new targets
- Emit evidence in artifact passport for every quant decision
- Every new quant reports quality Δ in `quantization_risk_report.json`
- Every new export verifies: load → gen → measure → compare
- Principle: show outcomes, hide machinery — user runs `kolm compile`, Forge picks method

## Test in prod cadence

Per user mandate "test in prod continuously editing our tech": every wave ends with:
1. Run the wave's CI test on local
2. Push origin (auto-deploys to Vercel)
3. Hit prod endpoint with a real model (Qwen2.5-0.5B for fast iteration, larger for capability proofs)
4. Verify response + receipts + passport entries
5. Roll forward if green; if red, fix forward in next wave

## Ship-after-each-wave checkpoint

- Lock-in tests skipped this session (user directive)
- Commit + push public/main → origin/main after every wave passes its CI
- Bump sw.js CACHE slug `kolm-vNN-2026-05-25-...-waveXXX-<slug>` per wave
- Update this plan file with completion mark on each step

## Verification commands (per wave)

```sh
# W868 GGUF — local
node --test tests/wave868-gguf-export.test.js
node cli/kolm.js compile spec.toml --target gguf-q4km --verify
ls -la ~/.kolm/artifacts/*.gguf

# W868 GGUF — prod
curl -X POST https://kolm.ai/v1/forge/export \
  -H "Authorization: Bearer $KOLM_API_KEY" \
  -d '{"artifact":"qwen-0.5b-helper","target":"gguf-q4km"}'
```

## Open questions deferred to during execution

- Vendor the llama.cpp converter or shell-out? → Lean shell-out (lighter dep), fall back to vendor if Python env hostile
- mergekit license compat (Apache-2.0?) → Verify before W875
- TRT-LLM vs vLLM for NVFP4 → User's hardware is RTX 5090 (Blackwell cc 10.0); test both, pick the faster path
- Resumability storage — local filesystem checkpoints? → Yes, in `~/.kolm/quant-checkpoints/<job-id>/`

## Memory anchor

Master memory entry: `project_kolm_wave866_forge_distill_frontier_2026_05_25.md`. READ THAT FIRST on resume. This plan file is the operational checklist; the memory entry is the immutable contract.

---

## SURFACE INTEGRATION (user mandate, verbatim continuation 2026-05-25)

Every capability above must be exposed across all five product surfaces. Don't just build the engine — wire it into every touchpoint a user sees.

### SURFACE 1: CLI

Every new capability needs a CLI verb or flag. Follow existing `kolm` conventions.

**New commands:**

```bash
# Forge compile with format selection
kolm compile support.spec.toml                           # auto-selects best format for detected hardware
kolm compile support.spec.toml --target gguf-q4km        # specific GGUF quant
kolm compile support.spec.toml --target gguf-iq4xs       # imatrix quant (generates imatrix from eval set)
kolm compile support.spec.toml --target exl2-4.0bpw      # EXL2 at 4.0 bits per weight
kolm compile support.spec.toml --target gptq-4bit-g128   # GPTQ
kolm compile support.spec.toml --target awq-4bit         # AWQ
kolm compile support.spec.toml --target nvfp4            # Blackwell native (auto-detected)
kolm compile support.spec.toml --target fp8              # Hopper native (auto-detected)
kolm compile support.spec.toml --target mlx-4bit         # Apple Silicon
kolm compile support.spec.toml --target all              # every compatible format, runtime passport per each

# Hardware detection
kolm hardware                                            # detect GPU, VRAM, compute capability, supported methods
kolm hardware --json                                     # structured output for scripts
kolm hardware --fit support.kolm                         # will this artifact run on this hardware?

# Model inspection
kolm inspect Qwen/Qwen3-27B                              # dense or MoE, param count, active params, architecture
kolm inspect Qwen/Qwen3-235B-A22B                        # MoE, 235B total, 22B active, 128 experts, top-8 routing
kolm inspect support.kolm                                # passport, K-Score, targets, verification status

# Memory estimation
kolm fit --model Qwen/Qwen3-27B --vram 16 --context 8192          # will it fit? at what quant level?
kolm fit --model Qwen/Qwen3-27B --vram 16 --context 8192 --json   # structured output

# MoE-specific
kolm experts support.kolm                                # show expert activation distribution from eval set
kolm experts --prune --threshold 0.01 support.kolm       # prune experts activated <1%, report K-Score impact

# Model merging
kolm merge --models model-a model-b --method ties --weights 0.6 0.4 --output merged/
kolm merge --models model-a model-b model-c --method dare --output merged/
kolm merge --dry-run --models model-a model-b --method slerp

# Serving
kolm serve support.kolm                                  # auto-detect runtime + hardware
kolm serve support.kolm --runtime vllm --port 8080
kolm serve support.kolm --runtime llama.cpp
kolm serve support.kolm --runtime ollama                 # generate Modelfile, import, serve
kolm serve support.kolm --docker                         # emit docker-compose.yml
kolm serve support.kolm --k8s                            # emit Kubernetes manifests

# Benchmarking
kolm bench support.kolm
kolm bench support.kolm --all-targets                    # every supported format
kolm bench --model Qwen/Qwen3-27B --target gguf-q4km     # benchmark before compiling
kolm bench --compare v1.kolm v2.kolm                     # side-by-side

# Export helpers
kolm export support.kolm --format ollama-modelfile
kolm export support.kolm --format hf-model-card
kolm export support.kolm --format vllm-config
kolm export support.kolm --format docker-compose
```

**CLI conventions:**
- Every command supports `--json`
- Every decision is explained in human-readable output
- Progress bars for long ops (quant/merge/bench)
- Colored output: green ✓ pass / red ✗ fail / amber ⚠ warning
- Every command emits structured evidence into artifact passport

### SURFACE 2: TUI

Interactive selection for the same capabilities. Three canonical screens:

- **`compile-wizard`** — radio grid of formats with size/fits/recommendation column, Enter to compile, Tab to toggle
- **`experts`** — MoE activation distribution bar chart per expert, prune low-activation experts inline
- **`hardware`** — GPU model/VRAM/compute, native quant support matrix, fits-grid for 7B/14B/27B/32B/70B/123B at Q4

### SURFACE 3: ACCOUNT (post-auth dashboard)

Interactive workflows, not raw settings:

- **Compile page** — target format selector AFTER student selection (3-card grid: GGUF / EXL2 / NVFP4 with size + tok/s + K-Score per card, ★ on recommended)
- **MoE namespace** — expert activation summary + "Prune and recompile" CTA
- **Serving integration** — post-compile 6-card deploy grid (Local / Ollama / Docker / Kubernetes / vLLM / Air-gap)
- **Hardware profile** — registered devices table + auto-detect button
- **Merge workflow** — model picker + method radio (Linear/SLERP/TIES★/DARE) + weight inputs + preview/merge CTAs

UI principles: show tok/s + size + K-Score per option, ★ on recommended, compatibility chip ("Universal" vs "Blackwell only"), "Compile all" option, estimated compile time per format.

### SURFACE 4: DOCS

```
Docs/
├── Start/
│   ├── quickstart                 (update: mention format selection)
│   └── hardware-setup             (NEW)
│
├── Compile/
│   ├── overview                   (update)
│   ├── format-selection           (NEW)
│   ├── gguf                       (NEW: ladder + imatrix + metadata)
│   ├── exl2                       (NEW)
│   ├── gptq                       (NEW)
│   ├── awq                        (NEW)
│   ├── nvfp4                      (NEW: Blackwell)
│   ├── fp8                        (NEW: Hopper)
│   ├── mlx                        (NEW: Apple Silicon)
│   ├── moe-models                 (NEW)
│   └── large-models               (NEW)
│
├── Merge/                         (NEW section)
│   ├── overview
│   ├── methods                    (TIES/DARE/SLERP/Linear/passthrough)
│   └── merge-then-compile
│
├── Run/
│   ├── overview                   (update)
│   ├── vllm                       (update: FP8/NVFP4)
│   ├── llama-cpp                  (update)
│   ├── ollama                     (NEW)
│   ├── docker                     (NEW)
│   ├── kubernetes                 (NEW)
│   └── hardware                   (NEW)
│
├── Verify/
│   └── runtime-passport           (update: per-format)
│
└── Reference/
    ├── quant-methods              (NEW: 12-method table)
    ├── gguf-metadata              (NEW)
    └── moe-architectures          (NEW)
```

### SURFACE 5: WEBSITE COPY

**Homepage "Three surfaces" update:**

```
DISTILL & COMPILE
Teacher-to-student distillation with K-score gates.
Twelve quantization methods — from 1-bit edge to FP8
datacenter — automatically selected for your hardware.
Export to GGUF, EXL2, GPTQ, or native formats. Ship a
signed .kolm that any runtime can load.
```

**Receipts section — show format diversity:**

```
qwen2.5-7b-support.kolm    GGUF Q4_K_M · 3.8 GB · 45 tok/s on RTX 5090 · K 0.91
qwen2.5-7b-support.kolm    EXL2 4.0 bpw · 4.1 GB · 52 tok/s on RTX 5090 · K 0.91
deepseek-r1-32b-reasoner.kolm  GGUF Q4_K_M · 17.9 GB · 11.5 tok/s · K 0.91
```

**New /forge page** — "Twelve methods. One command. The right precision for your hardware." Three tiers (consumer / datacenter / edge), every method bullet, "every method calibrated on YOUR eval set, K-Score gate rejects bad quants automatically".

**New /merge page** — "Combine the strengths of multiple models into one specialist." TIES / DARE / SLERP / Linear. Pipeline: `kolm merge ... --method ties → kolm compile → signed .kolm with merge lineage`.

**New /hardware page** — "Kolm knows your GPU." `kolm hardware` terminal demo. Auto-selects best quant. Always overridable. Default is usually right.

### COPY RULES MATRIX

| Capability | Homepage | Product page | Docs depth |
|---|---|---|---|
| GGUF export | "Export to GGUF, EXL2, or native formats" | Full quant ladder table | Complete page |
| EXL2 | format list | Quality chart | bpw guide |
| MoE | "Works with dense and MoE architectures" | Expert visualization | Page with architectures |
| Expert pruning | — | "Prune rarely-used experts for 30-60% size reduction" | Workflow page |
| Hardware detection | "Auto-selects the best format for your GPU" | Compatibility matrix | GPU capabilities |
| Merging | — | Dedicated /merge page | Method comparison |
| kolm serve | "Deploy with one command" | Deployment grid | Page per runtime |
| Memory calc | — | "Check if it fits before compiling" | Hardware page |
| NVFP4/FP8 | Datacenter tier mention | Perf comparison | Technical page |
| imatrix | — (invisible engine win) | "Calibrated on YOUR data" | Technical page |

### THE 10-POINT CONSISTENCY CHECK

1. Every CLI command's `--help` matches the docs page
2. Every TUI screen has a corresponding account UI equivalent
3. Every quant method on /forge has a working CLI path + docs page + test
4. Every website claim is implemented (claim policy Class 1)
5. Artifact passport schema includes every new quant method + export format
6. Runtime passport includes verification results for every format
7. K-Score packet includes quality delta for every quantization applied
8. `kolm inspect` shows every field the account UI shows
9. `kolm hardware` and account hardware profile show the same capabilities
10. No dead links between docs pages

**Principle throughout:** CLI is the source of truth, TUI mirrors it interactively, account wraps it in a visual workflow, docs explain it exhaustively, website copy sells the outcome without exposing the mechanism.

---

## PRIOR-WAVE INTEGRATION (W144-W850 carry-forward)

The W866+ sprint INHERITS and INTEGRATES — not rebuilds — the following prior-wave deliverables. Thread them through the new surfaces.

### Multi-agent / agentic
- **W144 trace-capture** — multi-tool agentic traces; W867 MoE detector consumes them as routing evidence
- **W147 MoE composition** — manifest.moe {routing_strategy, top_k, experts[], router_hash}; W867+ extends per-expert quant
- **W463 trace-compile** — compileTraceToReplay seeds cache-hit replay; W877 `kolm serve` may serve these directly
- **W718 Teacher Council** — `kolm distill --teachers A,B,C --weights auto|equal|domain` already in CLI; surface in /account/distill/new + /account/merge/new (teacher-council merge is a merge variant)
- **W454/W462/W464 multimodal redactors** — voice transcript scrub / image PII / audio voiceprint — all flow into pre-distill capture pipeline

### Mixed-precision / efficiency stack (foundational for Forge)
- **W719 DAQ mixed_precision_profile** — per-layer bit budget; W868 GGUF imatrix MUST source from this when present (not generic Wikipedia calibration). This is the "imatrix from YOUR eval set" claim
- **W721 TSAC sparsity_profile** — per-head attention kernel dispatch; W869 EXL2 inherits
- **W722 ITKV kv_profile** — per-token KV precision tier; W871 NVFP4/FP8 KV cache integration
- **W723 streaming_load** — model-NNNNN-of-MMMMM.safetensors already supported; W874 100B+ handling extends with quantize-while-streaming
- **W728 self-verify chain-of-verification** — already in apps/runtime/self_verify.py; W878 verify_export wraps this for post-export check
- **W787 efficiency tests** — already exist; W880 `kolm bench --all-targets` calls into these

### Export + metadata + provenance
- **W146 export-provenance** — manifest.export {backend, targets[], hash}; W876 extends with vLLM serving config + Ollama Modelfile generation
- **W148 pretokenize** — pre-token receipt; W866+ artifact carries this through
- **W768 HF model card** — 10-section v0.3 model card (apps/export/model_card.py); W876 surfaces in /account/export/model-card form + `kolm export --format hf-model-card`
- **W786 sustainability_badge** — CO2 per artifact; surface in /account/builds/:id result page + W876 model card
- **W769 region** — geo gating; W875 merge UI filters source models by region

### Runtime + serving
- **W144 capture-stream** — SSE live tail; wire into /account/serve/:id/logs as receipt tail
- **W772 backend adapters** — vLLM, sglang, tgi, trt-llm, local-cuda, mlx, directml, openvino, transformers-js, llama-cpp; W877 `kolm serve` auto-detect lives ON these. Do NOT rebuild — dispatch
- **W849 cmdStudio CLI + TUI W (studio)** — /account/studio shows recent .kolm + sessions; W866+ artifacts surface here
- **W845 embedded CLI chat (kolm-chat.js + /v1/free/chat 20/IP/day)** — same component pre+post auth; W866+ /forge page may embed similar live demo

### Bakeoff + benchmarking
- **W466 multimodal bakeoff** — `kolm bakeoff multimodal` + POST/GET /v1/multimodal/bakeoff; W880 `kolm bench --compare A B` shares this infrastructure
- **src/benchmarks.js** — signed receipts (canonical JSON + attestation hash); W880 inherits

### Billing + namespace + SSO + enterprise
- **W465 billing-breakdown** — per-namespace cost attribution; ALL W866+ jobs (quantize/merge/serve/bench) emit cost ledger with corpus_namespace header
- **W560 SSO/SAML/SCIM** — 6 routes gated to enterprise+business tier; W866+ enterprise features (NVFP4, large-model 100B+, multi-GPU calibration) inherit the same tier gate
- **W845 business tier $1,499/mo** — pricing page; surface "Enterprise: NVFP4/FP8 + SAML" gate copy in /forge

### Visual / website (design tokens)
- **W836 Warm Paper / W849 warm-dark / W850 cool-slate anti-warm redline** — design token cascade; NEW W866 pages MUST use design-tokens.css (no inline pitch-black per scripts/strip-inline-pitch-black.cjs; anti-warm per W850 lock)
- **W844 fix-the-site / W845 buttoned-up / W864 homepage cleanup** — new /forge, /merge, /hardware pages adopt .fr-h1--hero typography, dark-mode toggle pre-baked, dedup pattern (NO duplicate moat strips)
- **W598-W604 visual system redesign** — design-tokens.css + kolm-svg.js + w604.css cursor-reactive ambient orb + magnetic CTAs + 3D-tilt cards (all gate on prefers-reduced-motion + pointer:fine)

### Reliability / observability / release-verify
- **W479 release-verify 7-gate green** — lint:refs / test / sdk-smoke / doctor / whoami / verify-claims / billing-tiers; W866+ adds gate #8 forge-quant-coverage (every method in METHOD_CATALOG has a passing wave86X test)
- **W490 openapi-sync gate** — new routes in src/router.js auto-flow into openapi.json via scripts/build-openapi.cjs
- **W545 local-surface-smoke + W470 setIsolatedHome chokepoint** — new wave86X tests use these chokepoints for fixture isolation
- **W729+ runtime passport** — extends artifact passport with quant decision rationale

### Captures / observability + agent telemetry
- **W144/W409w workflow-IR** — `kolm trace compile` + `kolm trace verify` already exist; W877 serve replays
- **TUI agent-telemetry view D** — already plumbed; W866+ jobs emit agent_id

### Standing operational locks (carry-forward)
- **W540 / W545 / W479 lock-in pattern** — never write explicit-array sw.js family tests; always regex `wave(\d{3,4})` + numeric threshold
- **W845 trap** — `.kolm bundle` substring is FORBIDDEN_PUBLIC_PATTERN; use `.kolm artifact`
- **W850 cool-slate redline** — reject any "warm paper" carry-over (browns/beiges/oranges) in new pages
- **Standing: ink-1 is TEXT not surface** — when fixing chat-box bleed use explicit hex not var(--ink-1)
- **Standing: NEVER commit unless user asks** — Phase I commit gated on explicit "push"
- **Standing: prefer `git add <specific-files>` not `-A`** — even at scale, stage by name
- **Standing: NEVER skip hooks (--no-verify)** — fix forward on hook failure
- **Standing: NEVER create .md files unless user asks** — but this plan + memory file ARE user-mandated docs (verbatim "DOCUMENT ALL THIS EXHAUSTIVELY")

---

## ATOMIC EXECUTION LADDER (this session)

### Phase A — Documentation (THIS section + memory mirror)
- A1. ✓ Plan file extended (this commit)
- A2. ✓ Memory file extended (parallel commit)

### Phase B — CLI verb additions (highest leverage; source of truth)
- B1. `kolm hardware` — src/forge/hardware.js + cli verb (detection + --json + --fit)
- B2. `kolm inspect` — src/forge/inspect.js + cli verb (config.json detection: dense vs MoE, num_experts, num_experts_per_tok, total/active params)
- B3. `kolm fit` — src/forge/fit.js + cli verb (will-it-fit calculator: weights + KV cache + activations + overhead)
- B4. `kolm experts` — src/forge/experts.js + cli verb (expert activation distribution + --prune --threshold)
- B5. `kolm compile --target` shortcut expansion (gguf-q4km, gguf-iq4xs, exl2-Nbpw, gptq-4bit, awq-4bit, nvfp4, fp8, mlx-4bit, all)
- B6. `kolm serve --runtime {vllm|llama.cpp|ollama|tgi} --docker --k8s`
- B7. `kolm bench --all-targets --compare A B`
- B8. `kolm export --format {ollama-modelfile|hf-model-card|vllm-config|docker-compose}`
- B9. `kolm merge --method {linear|slerp|ties|dare|passthrough} --dry-run`

### Phase C — HTTP route surface (server source of truth)
- C1-C2. POST/GET /v1/quantize
- C3-C4. POST/GET /v1/merge (already partially exists via cmdMerge)
- C5-C6. POST/GET /v1/serve
- C7. POST /v1/export
- C8. GET /v1/hardware
- C9. GET /v1/fit?model=X&vram=Y&context=Z
- C10. GET /v1/inspect?model=X
- C11. GET /v1/experts/:artifact_id

### Phase D — Account UI pages (visual workflow wrapper)
- D1. /account/forge (unified entry)
- D2. /account/quantize/new
- D3. /account/merge/new
- D4. /account/serve/new
- D5. /account/bench
- D6. /account/hardware
- D7. /account/experts/:artifact
- D8. /account/builds/new — extend with target_format selector
- D9. /account/artifacts/:id — extend with runtime_passport + quantization_risk_report

### Phase E — TUI view additions
- E1-E6. compile-wizard / experts / hardware / serve-pods / merge-jobs / export-jobs

### Phase F — Website copy pages
- F1. /forge (twelve methods × three tiers)
- F2. /merge (TIES/DARE/SLERP/Linear)
- F3. /hardware (auto-detect, override-able)
- F4. Homepage three-surfaces update
- F5. Homepage receipts format-diversity update

### Phase G — Docs pages (Diátaxis structure)
- G1-G11. Compile/* (format-selection, gguf, exl2, gptq, awq, nvfp4, fp8, mlx, moe-models, large-models)
- G12-G14. Merge/* (overview, methods, merge-then-compile)
- G15-G21. Run/* (overview, vllm, llama-cpp, ollama, docker, kubernetes, hardware)
- G22-G24. Reference/* (quant-methods, gguf-metadata, moe-architectures)

### Phase H — Tests (wave867-wave886)
- H1-H14. tests/wave867-wave880 (one per gap)
- H15. tests/wave886-surface-parity.test.js

### Phase I — Consistency sweep + ship
- I1-I10. 10-point check
- I11. sw.js bump v92 → v93 (wave866-forge-distill-frontier-surface-integration)
- I12. Commit + push (gated on explicit user "push")

---

## AUDIT BASELINE (4 parallel agents, 2026-05-25)

What already exists vs what needs building:

| Gap | Status | Existing | To build |
|---|---|---|---|
| 1. MoE awareness | PARTIAL | src/moe.js, apps/trainer/moe.py, wave144/147 tests | num_experts detection, MoE-aware LoRA, expert pruning |
| 2. Quant ladder | PARTIAL | GGUF (Q4_K_M/Q5_K_M/Q8_0), bitsandbytes (NF4/int8), GPTQ, AWQ, HQQ, EXL2 oracle entry | NVFP4 export, FP8 export, imatrix, full IQ ladder |
| 3. Hardware | PARTIAL | detectLocalDevice(), KNOWN_RUNTIMES enum | will_it_fit(), per-format sizing |
| 4. Large model | PARTIAL | streaming_load.py W723 | streaming-quant, multi-GPU calib, split-GGUF >50GB |
| 5. Merging | FULL | apps/trainer/merge.py (linear/SLERP/DARE/TIES) | CLI/account surface wrappers |
| 6. Metadata | PARTIAL | HF model card (W768), GGUF base | Ollama Modelfile, vLLM config, GGUF general.*/kolm.* fields |
| 7. kolm serve | PARTIAL | vLLM/transformers serve.py, 9 backend adapters | auto-detect, Docker, k8s |
| 8. verify_export | PARTIAL | self_verify.py (W728), K-Score delta | full verify_export() workflow |
| 9. Tests | NEW | 535 wave tests; 0 wave86X | wave867-wave880 + wave886 parity |
| 10. kolm bench | PARTIAL | mmlu/humaneval/mtbench + receipts | --all-targets, --compare, structured passport |

**Routes:** 14 distill+bench live; 0 routes for /v1/forge /v1/quantize /v1/merge /v1/serve /v1/export. **Account UI:** 51 HTML files; 0 forge/quantize/merge/serve/bench pages. **TUI:** 37 views; 0 forge-specific.

**Verdict:** core 70% built; W866+ is integration + polish + new surface wrappers, not greenfield.
