# KOLM W707-W806 SYSTEM-WIDE UPGRADE PLAN
## Atomic Tracking of 114 External-Reviewer Recommendations

**Source:** 2026-05-24 user-shared external Claude review session (rating 7.5/10 → roadmap to 10/10 with full moat).
**Scope:** 114 atomic items across 13 categories.
**Wave range:** W707–W806 (100 waves max).
**Constraint:** Up to 100 parallel agents per wave. Local execution.
**Status legend:** ✅ shipped · 🟡 partial · ❌ not-implemented · 🚧 in-wave · 🔒 external-blocked
**Ship cadence:** Each wave with user-visible code lands explicit-paths on origin + public per W604 trap.

---

## 0. AUDIT GROUND-TRUTH (W707 pre-wave)

5 parallel Explore agents audited the codebase. Findings drive item status. Each item links to file:line proof where applicable.

### Already-implemented (no rework — surface/uplevel only)

| # | Item | Proof |
|---|------|-------|
| ✅ A1 | 12 quantization methods (int4/int8/gptq/awq/aqlm/quip/exl2/exl3/hqq/qat) | `workers/quantize/scripts/quantize.py:53-572` |
| ✅ A2 | NF4 + double-quant bitsandbytes 0.49.2 | `workers/quantize/scripts/quantize.py:126-151` |
| ✅ A3 | Speculative decoding (EAGLE-3, MEDUSA, lookahead) | `apps/runtime/eagle3.py:1-80`, `apps/runtime/medusa.py:1-80`, `apps/runtime/lookahead.py:1-80` |
| ✅ A4 | FP8 KV-cache + prefix caching | `apps/runtime/serve.py:88-115` |
| ✅ A5 | Ed25519 artifact signing | `src/ed25519.js:1-50` |
| ✅ A6 | PII redaction (text+image+audio+video) | `src/privacy-membrane.js:1-50`, W454/W462/W464 workers |
| ✅ A7 | Differential privacy (Laplace, ε=1.0) | `src/federated-approvals.js:46` |
| ✅ A8 | Immutable HMAC-SHA256 audit log chain | `src/audit.js:1-50` |
| ✅ A9 | Federated distillation (gradient aggregation, DP noise) | `apps/trainer/federated.py` |
| ✅ A10 | Model merging (TIES, DARE, SLERP, linear) | `apps/trainer/merge.py:24,69-70` |
| ✅ A11 | Long-context training (RoPE/YaRN/NTK scaling) | `apps/trainer/long_context.py` |
| ✅ A12 | RBAC namespace-granular | `src/team-capture-rbac.js:1-46` |
| ✅ A13 | Per-namespace billing breakdown | `src/billing-breakdown.js` (W465) |
| ✅ A14 | Federated approval rows opt-in | `src/federated-approvals.js`, W461 |
| ✅ A15 | OpenAI/Anthropic/vLLM/TGI/SGLang adapters | `src/compute/backends/*.js` |
| ✅ A16 | Multi-teacher fallback chain (sequential) | `src/distill-pipeline.js:_pickTeachers()` |
| ✅ A17 | Rate limiting + per-tenant quotas + 429 | `src/auth.js` |
| ✅ A18 | OpenTelemetry traces + metrics (OTLP) | `src/otel.js` |
| ✅ A19 | /health public route | `src/router.js:807` |
| ✅ A20 | /ready Kubernetes-style route | `src/router.js:873+` |
| ✅ A21 | Structured-output JSON Schema validation | `src/device-capabilities.js`, `src/binder.js` |
| ✅ A22 | All 4 pricing tiers (Free/Pro/Team/Ent) | `public/pricing.html:321-388` |
| ✅ A23 | Overage metering ($0.50/1k, $0.001/compile) | `public/pricing.html:394` |
| ✅ A24 | ROI calculator | `public/pricing.html:434-560` |
| ✅ A25 | .kolm format spec + 4 receipts | `apps/export/gguf.py`, `claims-redactor.kolm` etc. |
| ✅ A26 | .kolm → GGUF/ONNX/MLX/CoreML/ExecuTorch/TensorRT export | `apps/export/*.py` |
| ✅ A27 | Marketplace pages (8 products) | `public/marketplace/*.html` |
| ✅ A28 | Six SDKs (Node/Python/MCP/VSCode/C/Rust) | `sdk/*`, `packages/*` |
| ✅ A29 | K-Score v2 (A/S/L/C/V/R/F/E/Z axes) | `src/kscore.js:computeKScoreV2()` |
| ✅ A30 | K-Score methodology page | `public/docs/k-score-methodology.html` |
| ✅ A31 | KolmBench v1 (30 cases, 4 classes) | `src/kscore-bench.js:BENCH_CASES` |
| ✅ A32 | Drift-supersession (K-Score drift tracking) | `src/drift-supersession.js` |
| ✅ A33 | Air-gapped concept + local CPU/CUDA/MLX/MPS/ROCm | `public/docs/cli/airgap.html`, `apps/runtime/backends/local_*.py` |
| ✅ A34 | Multimodal bakeoff | `src/multimodal-bakeoff.js` (W466) |
| ✅ A35 | Trace compile → IR replay | `src/trace-compile.js` (W463) |
| ✅ A36 | Attestation embed (PCCS/SNP/Nitro/NRAS) | `src/spec-compile.js` (W460) |
| ✅ A37 | Distill resume + teacher_fallback | `src/distill-pipeline.js` (W459) |
| ✅ A38 | SSO/SAML/SCIM stubs gated enterprise | `src/router.js:~4376` (W560) |
| ✅ A39 | Confidential compute attestation block | `src/artifact.js:1494-1501` |
| ✅ A40 | Eval data embedded in .kolm | `eval.frozen.jsonl` per artifact |
| ✅ A41 | Reproducible builds + sha256 receipts | `docs/benchmark-results-v0.1.0.md`, RECIPE_RECEIPT_SECRET |
| ✅ A42 | Cookbook recipes | `public/cookbook/*.html` |
| ✅ A43 | Browser extension (MV3 verify .kolm) | `packages/browser-extension/` |
| ✅ A44 | TUI 20-view (W485) | `cli/kolm-tui.mjs` |
| ✅ A45 | Currency selector (USD/EUR/GBP/JPY) | `public/pricing.html:300-307` |

### Partial — needs uplevel

| # | Item | Current state | Gap |
|---|------|--------------|-----|
| 🟡 P1 | Reasoning-trace distillation | GRPO + PRM + TTC | No dedicated teacher-CoT capture/replay; W713 will close |
| 🟡 P2 | Contrastive distillation | InfoNCE (embeddings), DPO/SimPO/ORPO/KTO (preference) | Not integrated as response-level negative-example loss; W714 |
| 🟡 P3 | Hardware-specific kernel selection | FA3/FA2/SDPA per GPU label | No deeper kernel-variant pre-compilation in .kolm; W721 |
| 🟡 P4 | Bakeoff red-team prompts | Adversarial holdout exists | No red-team generator framework; W762 |
| 🟡 P5 | Capture dedup | row_hash_dedupe_count post-capture | No ingest-time dedup; W744 |
| 🟡 P6 | Multi-teacher blending | Sequential fallback only | No ensemble blending by task; W752 |
| 🟡 P7 | Compute credits per tier | 50/250 compiles | No teacher-API $ bundling; W793 |
| 🟡 P8 | Per-cluster K-Score breakdown | summarizeBench() by class | No viz dashboard; W745 |
| 🟡 P9 | Startup/non-profit tier | FAQ mention only | No formal product tier; W794 |
| 🟡 P10 | Teacher version per-capture | run-meta records teacher | Not stamped on each capture row; W746 |
| 🟡 P11 | VLM distill module | apps/trainer/vlm.py trains | No distill-specific path; W772 |
| 🟡 P12 | Audio distill module | apps/trainer/audio.py Whisper LoRA | No distill-specific path; W773 |
| 🟡 P13 | RAG-aware distillation | Context store via lake | Captures don't bind retrieved chunks; W734 |
| 🟡 P14 | Long-context degradation warnings | YaRN scaling exists | No runtime warning when input > 90pct of training; W781 |
| 🟡 P15 | SLA persistent dashboard | bench-report-md p50/p95/p99 | No always-on uptime/latency dash; W788 |

### Not implemented — needs building (the 70+ items below drive W707–W806)

See **PART II** for atomic wave assignments. Every item carries a wave + agent ID.

---

## PART I — WAVE STRUCTURE (W707–W806)

| Wave | Theme | Item count | Parallel agents |
|------|-------|-----------|----------------|
| W707 | Meta + audit + plan (this doc) | — | 5 audit agents |
| W708 | TOS/IP/legal foundation | 6 | 3 |
| W709 | Confidence-aware routing core | 5 | 4 |
| W710 | Active learning loop | 4 | 3 |
| W711 | Importance-weighted distillation | 4 | 3 |
| W712 | Progressive distill + cap gating | 4 | 3 |
| W713 | Reasoning-trace distillation | 4 | 3 |
| W714 | Contrastive distillation (response-level) | 4 | 3 |
| W715 | Cross-namespace transfer learning | 5 | 4 |
| W716 | Task-adaptive arch search (TAAS) | 4 | 3 |
| W717 | Curriculum distillation | 3 | 2 |
| W718 | Multi-teacher ensemble blending | 4 | 3 |
| W719 | Distillation-aware quantization | 4 | 3 |
| W720 | Distill self-improvement loop | 4 | 3 |
| W721 | Hardware kernel deep selection | 4 | 3 |
| W722 | KV-cache per-artifact optimization | 3 | 2 |
| W723 | Streaming compilation | 3 | 2 |
| W724 | Memory-aware scheduling tiers | 4 | 3 |
| W725 | Predictive preloading | 3 | 2 |
| W726 | Batch-vs-latency kernels | 3 | 2 |
| W727 | Speculative-decode with student-as-draft (consumer) | 3 | 2 |
| W728 | Inference-time compute scaling (best-of-N) | 3 | 2 |
| W729 | Graceful degradation under load | 4 | 3 |
| W730 | Prometheus + Grafana exporters | 3 | 2 |
| W731 | VS Code extension — capture monitoring | 5 | 3 |
| W732 | Git-integrated kolm.yaml + GHA | 4 | 3 |
| W733 | OpenTelemetry semantic-conventions | 3 | 2 |
| W734 | RAG-aware distillation | 5 | 3 |
| W735 | Agent/tool-use distillation | 5 | 3 |
| W736 | Guardrail compilation | 4 | 3 |
| W737 | Artifact marketplace expansion (rev-share, ratings) | 5 | 3 |
| W738 | Artifact composition (kolm.pipeline.yaml) | 4 | 3 |
| W739 | Artifact lineage + version diff | 4 | 3 |
| W740 | GGUF/safetensors/ONNX import | 4 | 3 |
| W741 | Diagnostic report post-distill | 3 | 2 |
| W742 | Local-only / mock-gateway mode | 3 | 2 |
| W743 | Migration wizard from Ollama/LM Studio | 3 | 2 |
| W744 | Smart capture filter + ingest dedup | 4 | 3 |
| W745 | Failure-mode viz dashboard | 4 | 3 |
| W746 | Capture staleness + teacher-version tagging | 4 | 3 |
| W747 | Distribution-shift alerts | 3 | 2 |
| W748 | Seasonal capture tagging | 3 | 2 |
| W749 | Synthetic augmentation + rare-case gen | 4 | 3 |
| W750 | Copyright filter + capture quarantine | 4 | 3 |
| W751 | Vertical foundation student — legal | 4 | 3 |
| W752 | Vertical foundation student — medical | 4 | 3 |
| W753 | Vertical foundation student — code | 4 | 3 |
| W754 | Vertical foundation student — finance | 4 | 3 |
| W755 | Vertical foundation student — support | 4 | 3 |
| W756 | KolmBench public publishing + leaderboard | 4 | 3 |
| W757 | Cross-namespace anon pattern lake | 5 | 3 |
| W758 | MMLU/HumanEval/MT-Bench integration | 4 | 3 |
| W759 | Numerical accuracy eval suite | 3 | 2 |
| W760 | Per-language K-Score breakdown | 3 | 2 |
| W761 | Model poisoning anomaly detection | 4 | 3 |
| W762 | Adversarial red-team framework | 4 | 3 |
| W763 | SBOM per artifact + supply-chain pinning | 4 | 3 |
| W764 | Membership inference test harness | 3 | 2 |
| W765 | Prompt extraction defense | 3 | 2 |
| W766 | EU AI Act compliance toolkit | 5 | 3 |
| W767 | SOC 2 Type II + ISO 27001 docs | 4 | 3 |
| W768 | Model card auto-gen per artifact | 3 | 2 |
| W769 | Data residency tagging + geo-fence | 4 | 3 |
| W770 | Audit export (CSV + SIEM) | 3 | 2 |
| W771 | Vision (VLM) distill module | 4 | 3 |
| W772 | Audio/speech distill module | 4 | 3 |
| W773 | Video distillation primitive | 4 | 3 |
| W774 | Cross-lingual distillation | 4 | 3 |
| W775 | Continuous background distill (THE KILLER FEATURE) | 6 | 4 |
| W776 | Synthetic capture self-improvement | 3 | 2 |
| W777 | A/B testing infrastructure | 4 | 3 |
| W778 | Statistical significance + auto-rollback | 4 | 3 |
| W779 | Air-gapped formal mode + sneakernet | 4 | 3 |
| W780 | Multi-region gateway endpoints | 4 | 3 |
| W781 | Long-context degradation warnings + runtime | 3 | 2 |
| W782 | Team approval workflow (manager sign-off) | 3 | 2 |
| W783 | Cost attribution / chargeback | 3 | 2 |
| W784 | Plugin architecture (third-party q/runtime) | 5 | 3 |
| W785 | kolm Cloud managed-distill expansion | 4 | 3 |
| W786 | Carbon footprint + CO2 estimate | 3 | 2 |
| W787 | Compute-efficiency optimizations | 3 | 2 |
| W788 | SLA persistent dashboard | 3 | 2 |
| W789 | Documentation cookbook expansion | 4 | 3 |
| W790 | Security posture page + threat model | 3 | 2 |
| W791 | Savings-based pricing tier | 3 | 2 |
| W792 | Regional/PPP-adjusted pricing | 3 | 2 |
| W793 | Compute credits bundled into tiers | 3 | 2 |
| W794 | Student/startup/non-profit formal tier | 3 | 2 |
| W795 | Free tier expansion (10k → 50k) | 2 | 2 |
| W796 | Currency localization (CNY/Alipay/WeChat) | 3 | 2 |
| W797 | Purchase order + net-30/60 enterprise | 2 | 2 |
| W798 | Hardware partnership landing pages | 3 | 2 |
| W799 | AWS Marketplace listing prep | 3 | 2 |
| W800 | Cloud-provider integration docs | 3 | 2 |
| W801 | Competitor positioning matrix page | 3 | 2 |
| W802 | Content strategy cadence framework | 3 | 2 |
| W803 | kolm University curriculum scaffold | 4 | 3 |
| W804 | kolm Labs research grant page | 2 | 2 |
| W805 | Branding polish + entity rename audit | 3 | 2 |
| W806 | Final 100% audit + ship + post-flight | 1 | 5 |

---

## PART II — ATOMIC ITEMS WITH WAVE/AGENT ASSIGNMENTS

Each item has the form: `[W<wave>-<seq>] <verbatim-or-condensed-quote> → status, agent role, files-to-touch`.

### W708 — TOS/IP/LEGAL FOUNDATION (the "before all else" blocker per source §10)

- **[W708-1]** "API provider TOS — if Anthropic/OpenAI say 'you can't distill from our outputs,' kolm's core business model dies overnight" → ❌ `public/legal/distillation-tos-clarity.html` + `public/legal/teacher-source-disclosure.html` (prominent table: open-weight teachers vs proprietary). Agent: `legal-docs-writer-1`.
- **[W708-2]** "Are they distilling from API outputs (potentially TOS-violating) or using captures as fine-tuning data for already-open-source models" → ❌ ship `KOLM_TEACHER_SOURCE` policy enum + per-distill manifest stamping in `src/distill-pipeline.js`. Agent: `policy-enum-1`.
- **[W708-3]** "Option to use ONLY open-weight teachers (Llama, Qwen, Mistral) should be prominently featured as a 'fully clear' path" → ❌ `/get-started?teacher=open-weights` deep-link + open-weights badge on /pricing + safe-by-default flag. Agent: `policy-enum-1`.
- **[W708-4]** "Copyright filter on captures" → ❌ `src/capture-copyright-filter.js` substring/n-gram match vs flagged-domain corpus + flag bit in event row. Agent: `capture-filter-1`.
- **[W708-5]** "Export control / sanctions geo-fencing" → ❌ `src/auth.js` country-code denylist envelope + signup-time check. Agent: `geo-fence-1`.
- **[W708-6]** "Liability framework in TOS + mandatory disclaimer injection for high-risk verticals" → ❌ `public/legal/liability.html` + `src/spec-compile.js` injects disclaimer when manifest.vertical in {medical,legal,financial}. Agent: `legal-docs-writer-1`.

### W709 — CONFIDENCE-AWARE ROUTING (the single highest-leverage item per source §1.1)

- **[W709-1]** "Every token the student generates has an associated confidence (derivable from logit distribution entropy)" → ❌ `src/runtime-confidence-router.js` token-level entropy hook for adapters. Agent: `runtime-router-1`.
- **[W709-2]** "When confidence is high, serve locally at zero cost. When confidence drops below threshold, route to the teacher API in real-time, mid-response" → ❌ runtime gateway `/v1/chat/completions` student-first → teacher-fallback wrapper. Agent: `runtime-router-1`.
- **[W709-3]** "Configurable threshold (aggressive = more local, conservative = more teacher)" → ❌ `KOLM_ROUTE_ENTROPY_THRESHOLD` + per-namespace override row. Agent: `runtime-router-2`.
- **[W709-4]** "Seamless splicing of local and remote generation" → ❌ token-bridge SSE merge (preserve `id`, `created`, `model` envelope; mark `kolm_routing.segments[]`). Agent: `runtime-router-2`.
- **[W709-5]** "Dashboard showing local-vs-teacher ratio over time" → ❌ `/account/routing.html` chart + new event-store row `routing_decision`. Agent: `routing-dash-1`.

### W710 — ACTIVE LEARNING LOOP

- **[W710-1]** "Track which queries the student handles poorly (via user feedback, fallback triggers, or automated eval)" → ❌ `src/active-learning-queue.js` ingests fallback rows (W709-5 dependency). Agent: `active-learn-1`.
- **[W710-2]** "Automatically queue those as high-value captures for the next distillation cycle" → ❌ `kolm distill --resume-from-active-queue`. Agent: `active-learn-1`.
- **[W710-3]** "Deploy → discover weaknesses → capture more teacher responses → re-distill → deploy better" → ❌ `kolm pipeline run --continuous` scaffold (works with W775). Agent: `active-learn-2`.
- **[W710-4]** Dashboard view of queued vs trained → ❌ `/account/active-learning.html`. Agent: `active-learn-2`.

### W711 — IMPORTANCE-WEIGHTED DISTILLATION

- **[W711-1]** "Build an importance scorer that weights each capture by its information density relative to the student's current capability" → ❌ `src/capture-importance.js` (tokens × entropy × novelty). Agent: `importance-1`.
- **[W711-2]** "Oversample high-importance captures and undersample low-importance ones" → ❌ wire into `apps/trainer/distill.py` sampler. Agent: `importance-2`.
- **[W711-3]** "The importance scorer itself is trainable and improves with every distillation run" → ❌ feedback bit in `run-meta.json`. Agent: `importance-2`.
- **[W711-4]** Diagnostic: top-N + bottom-N importance captures surfaced in W741 report → ❌ shared report block. Agent: `importance-1`.

### W712 — PROGRESSIVE DISTILL + CAPABILITY GATING

- **[W712-1]** "Pass 1: basic pattern matching (format, tone, structure)" → ❌ `apps/trainer/distill.py --pass=1 --gate=format` + K-Score format axis. Agent: `prog-distill-1`.
- **[W712-2]** "Pass 2: task-specific reasoning (only on captures with multi-step reasoning)" → ❌ `--pass=2 --gate=reasoning`. Agent: `prog-distill-1`.
- **[W712-3]** "Pass 3: edge-case handling (only on pass-2 failures)" → ❌ `--pass=3 --gate=edge`. Agent: `prog-distill-2`.
- **[W712-4]** "If the student passes the gate, advance. If not, more captures requested" → ❌ gate-fail returns structured "need-N-more-of-class-X" envelope. Agent: `prog-distill-2`.

### W713 — REASONING-TRACE DISTILLATION

- **[W713-1]** "When the teacher is a reasoning model (Claude, o1, DeepSeek-R1), capture the chain-of-thought" → ❌ `src/capture.js` thinking-block capture for Anthropic + reasoning_tokens for o1. Agent: `cot-capture-1`.
- **[W713-2]** "Distill the student to reproduce the reasoning process, not just the output" → ❌ training data formatter includes `<think>...</think>` blocks. Agent: `cot-distill-1`.
- **[W713-3]** "Include them as part of training data with a special 'thinking' token structure" → ❌ chat-template extension in `src/chat-templates.js`. Agent: `cot-distill-1`.
- **[W713-4]** Optional CoT off-switch for short-context targets → ❌ `--no-cot` distill flag. Agent: `cot-distill-1`.

### W714 — CONTRASTIVE DISTILLATION (response-level)

- **[W714-1]** "For each capture, generate 2-3 negative variants using a smaller/weaker model" → ❌ `src/negative-variant-gen.js` calls fast cheap teacher (claude-haiku/gpt-4o-mini) with "rewrite worse". Agent: `contrastive-1`.
- **[W714-2]** "Train with contrastive loss rewarding match to teacher + penalizing match to negatives" → ❌ `apps/trainer/contrastive_distill.py` (extends DPO). Agent: `contrastive-2`.
- **[W714-3]** Bakeoff hook: contrastive K-Score axis → ❌ new K-Score sub-axis. Agent: `contrastive-2`.
- **[W714-4]** CLI: `kolm distill --contrastive --negative-teacher claude-haiku-4-5`. Agent: `contrastive-1`.

### W715 — CROSS-NAMESPACE TRANSFER LEARNING

- **[W715-1]** "New user starts with zero captures → bootstrap from anonymized patterns of similar namespaces" → ❌ `src/namespace-fingerprint.js` (vertical/topic fingerprint). Agent: `xfer-1`.
- **[W715-2]** "Federated learning where gradient updates (not raw data) are aggregated" → ❌ reuse `apps/trainer/federated.py`; add `--warm-start-from-fingerprint`. Agent: `xfer-2`.
- **[W715-3]** "New users start 70% trained on their vertical's common patterns" → ❌ vertical-warm-start library (depends W751–W755 vertical models). Agent: `xfer-2`.
- **[W715-4]** Opt-in consent UI on namespace create → ❌ `/account/namespaces/new` consent checkbox + audit row. Agent: `xfer-1`.
- **[W715-5]** Privacy proof: only gradient hashes leave tenant → ❌ binder.js extension. Agent: `xfer-2`.

### W716 — TAAS (TASK-ADAPTIVE ARCH SEARCH)

- **[W716-1]** "Analyze capture distribution (task complexity, output length, vocabulary entropy, reasoning chain depth, tool-use freq)" → ❌ `src/capture-stats.js`. Agent: `taas-1`.
- **[W716-2]** "Recommend optimal student architecture" → ❌ `src/student-arch-recommender.js` (rule-based v1; meta-model v2). Agent: `taas-1`.
- **[W716-3]** "Maybe MoE where 3 of 8 experts specialize" → ❌ MoE recipe in `src/compile.js` (gated). Agent: `taas-2`.
- **[W716-4]** CLI `kolm distill --auto-arch` + report. Agent: `taas-2`.

### W717 — CURRICULUM DISTILLATION

- **[W717-1]** "Order training data simple to complex" → ❌ `src/curriculum-sort.js` (perplexity-based ordering). Agent: `curriculum-1`.
- **[W717-2]** Wire into `apps/trainer/distill.py` sampler. Agent: `curriculum-1`.
- **[W717-3]** `kolm distill --curriculum`. Agent: `curriculum-1`.

### W718 — MULTI-TEACHER ENSEMBLE BLENDING

- **[W718-1]** "Blending multiple teachers — Claude for reasoning, GPT-4 for code, Gemini for multimodal" → ❌ extend `_pickTeachers()` to per-task selector. Agent: `multi-teacher-1`.
- **[W718-2]** "Weight each teacher per-task based on bakeoff scores" → ❌ `src/teacher-weights.js` learned weights via mini-bakeoff. Agent: `multi-teacher-1`.
- **[W718-3]** Per-capture metadata stamps teacher choice for replay/audit. Agent: `multi-teacher-2`.
- **[W718-4]** `kolm distill --teachers claude-opus-4-7,gpt-4o,gemini-2-pro --weights auto`. Agent: `multi-teacher-2`.

### W719 — DISTILLATION-AWARE QUANTIZATION

- **[W719-1]** "Analyze which layers matter most for the student's specific task distribution" → ❌ layer importance via Hessian/Fisher proxy. Agent: `daq-1`.
- **[W719-2]** "Allocate more bits to those layers (mixed-precision per-layer)" → ❌ `workers/quantize/scripts/quantize.py --mixed-precision`. Agent: `daq-1`.
- **[W719-3]** Could push K-Score from 0.91 to 0.95+ without increasing size — bakeoff harness. Agent: `daq-2`.
- **[W719-4]** Manifest records per-layer bit budget. Agent: `daq-2`.

### W720 — DISTILL SELF-IMPROVEMENT LOOP

- **[W720-1]** "When fallback to teacher, save teacher's response as new training example" → ❌ depends on W709, adds `routing_decision.kept_for_training=true`. Agent: `selfimp-1`.
- **[W720-2]** "Periodically re-distill incorporating new examples" → ❌ cron-style `kolm scheduler` daemon spec + scaffold. Agent: `selfimp-1`.
- **[W720-3]** "Eventually fallback rate approaches zero" → ❌ telemetry chart. Agent: `selfimp-2`.
- **[W720-4]** Opt-in to avoid feedback loops on poisoned data (W761 dep). Agent: `selfimp-2`.

### W721 — HARDWARE KERNEL DEEP SELECTION

- **[W721-1]** "Detect exact GPU, CUDA version, driver, available VRAM" → ❌ `src/hw-probe.js` (already partial). Agent: `hw-kernel-1`.
- **[W721-2]** "Pre-compile multiple kernel variants and ship them in the .kolm artifact" → ❌ multi-variant pack in artifact + `kolm run` picks at boot. Agent: `hw-kernel-1`.
- **[W721-3]** "First-run-to-fast-inference under 5 seconds" → ❌ benchmark gate. Agent: `hw-kernel-2`.
- **[W721-4]** `kolm compile --multi-target rtx-5090,h100,a100,m3-ultra`. Agent: `hw-kernel-2`.

### W722 — KV-CACHE PER-ARTIFACT

- **[W722-1]** "kolm knows the task distribution at compile time → optimize KV layout for expected context lengths" → ❌ kv_layout block in manifest. Agent: `kv-1`.
- **[W722-2]** Wire runtime to read kv_layout. Agent: `kv-1`.
- **[W722-3]** Compare bench: layout-tuned vs default. Agent: `kv-2`.

### W723 — STREAMING COMPILATION

- **[W723-1]** "Stream weights and start processing as layers arrive" → ❌ `apps/runtime/streaming_load.py` per-layer load order. Agent: `streaming-1`.
- **[W723-2]** "For 17.9 GB artifact, could save 30+ seconds on first load" → ❌ bench. Agent: `streaming-1`.
- **[W723-3]** SDK `kolm.run(stream=True)`. Agent: `streaming-2`.

### W724 — MEMORY-AWARE SCHEDULING

- **[W724-1]** "VRAM → RAM → NVMe → network" tier detection → ❌ `src/memory-tier.js`. Agent: `mem-tier-1`.
- **[W724-2]** "Automatically determine optimal placement + tell user expected tok/s before loading" → ❌ pre-load dry-run estimator. Agent: `mem-tier-1`.
- **[W724-3]** "No manual configuration of GPU layers, offload ratios, mmap" → ❌ `kolm run --auto-place` (default). Agent: `mem-tier-2`.
- **[W724-4]** Doc: `/docs/runtime/memory-tiers.html`. Agent: `mem-tier-2`.

### W725 — PREDICTIVE PRELOADING

- **[W725-1]** "Coding queries at 9am, writing at 2pm → preload" → ❌ `src/preload-scheduler.js` time-bucket model. Agent: `preload-1`.
- **[W725-2]** "Multi-namespace setups → predict next namespace" → ❌ Markov chain over recent queries. Agent: `preload-1`.
- **[W725-3]** "Eliminate cold-start latency entirely" → ❌ bench (cold vs warm). Agent: `preload-2`.

### W726 — BATCH-VS-LATENCY KERNELS

- **[W726-1]** "Many concurrent (API serving) → batching-optimized kernels" → ❌ compile flag. Agent: `bvl-1`.
- **[W726-2]** "Single-user desktop → latency-optimized" → ❌ default selector. Agent: `bvl-1`.
- **[W726-3]** "Decision at `kolm run --target` time, not manual" → ❌ runtime probe. Agent: `bvl-2`.

### W727 — STUDENT-AS-DRAFT (consumer-facing)

- **[W727-1]** "When user wants teacher-quality, use student as draft for teacher (2-3× throughput)" → ❌ `/v1/chat/completions?accelerate=true` flag. Agent: `spec-decode-1`.
- **[W727-2]** Compose with W709 routing. Agent: `spec-decode-1`.
- **[W727-3]** Bench: acceptance rate per task class. Agent: `spec-decode-2`.

### W728 — INFERENCE-TIME COMPUTE SCALING

- **[W728-1]** "Best-of-N sampling with automatic selection" → ❌ `apps/runtime/best_of_n.py`. Agent: `itc-1`.
- **[W728-2]** "Chain-of-thought with self-verification" → ❌ `apps/runtime/self_verify.py`. Agent: `itc-1`.
- **[W728-3]** "Budget allocation: easy queries minimal, hard queries max" → ❌ entropy-gated budget. Agent: `itc-2`.

### W729 — GRACEFUL DEGRADATION UNDER LOAD

- **[W729-1]** "Queue management (FIFO, priority, timeout)" → ❌ `src/load-queue.js`. Agent: `degrade-1`.
- **[W729-2]** "Overflow to teacher API when local capacity exceeded" → ❌ uses W709 plumbing. Agent: `degrade-1`.
- **[W729-3]** "Load shedding (reject low-priority under extreme load)" → ❌ 429 with retry-after. Agent: `degrade-2`.
- **[W729-4]** "Horizontal scaling across multiple GPUs/machines" → ❌ doc + scaffold. Agent: `degrade-2`.

### W730 — PROMETHEUS / GRAFANA EXPORTERS

- **[W730-1]** "/metrics endpoint in Prometheus format" → ❌ `src/prometheus-exporter.js`. Agent: `prom-1`.
- **[W730-2]** Grafana dashboard JSON (committed to `dashboards/`). Agent: `prom-1`.
- **[W730-3]** Doc: `/docs/observability/prometheus.html`. Agent: `prom-2`.

### W731 — VS CODE EXTENSION CAPTURE MONITORING

- **[W731-1]** "Monitor your Copilot/Claude Code usage" → ❌ `sdk/vscode/` capture-watcher (existing extension expansion). Agent: `vsc-ext-1`.
- **[W731-2]** "Identifies repetitive patterns" → uses W744. Agent: `vsc-ext-1`.
- **[W731-3]** "'Distill my coding assistant' button". Agent: `vsc-ext-2`.
- **[W731-4]** "Seamlessly switches between local and cloud per-completion" → uses W709. Agent: `vsc-ext-2`.
- **[W731-5]** "Real-time cost savings in status bar". Agent: `vsc-ext-3`.

### W732 — GIT-INTEGRATED kolm.yaml + GHA

- **[W732-1]** "`kolm.yaml` in repo root defines namespaces, teachers, quality gates" → ❌ schema + parser. Agent: `git-int-1`.
- **[W732-2]** "GitHub Action: on push, re-evaluate K-Score; if below threshold, re-distill" → ❌ `.github/workflows/kolm-distill.yml` template. Agent: `git-int-1`.
- **[W732-3]** ".kolm artifacts stored in GitHub Releases or a registry" → ❌ release-publish step. Agent: `git-int-2`.
- **[W732-4]** "`kolm diff v1.2.kolm v1.3.kolm`" → uses W739. Agent: `git-int-2`.

### W733 — OPENTELEMETRY SEMANTIC CONVENTIONS

- **[W733-1]** "Token-level confidence scores, routing decision, K-Score drift" as OTel attributes → ❌ extend `src/otel.js`. Agent: `otel-1`.
- **[W733-2]** "Latency breakdown (queue → load → prefill → decode)" → ❌ span structure. Agent: `otel-1`.
- **[W733-3]** Doc: `/docs/observability/opentelemetry.html`. Agent: `otel-2`.

### W734 — RAG-AWARE DISTILLATION

- **[W734-1]** "Capture not just prompt + response, but retrieved context" → ❌ `kolm-retrieved-context` request header parse. Agent: `rag-1`.
- **[W734-2]** "Student learns to generate correct responses given specific context patterns" → ❌ training data formatter. Agent: `rag-2`.
- **[W734-3]** SDK helper `kolm.captureWithContext(prompt, retrieved, response)`. Agent: `rag-2`.
- **[W734-4]** Doc: `/docs/rag.html`. Agent: `rag-1`.
- **[W734-5]** Bakeoff axis: context-faithfulness. Agent: `rag-3`.

### W735 — AGENT / TOOL-USE DISTILLATION

- **[W735-1]** "Capture tool-use patterns during capture phase" → ❌ tool_calls capture. Agent: `agent-d-1`.
- **[W735-2]** "Teach student when and how to call external tools" → ❌ training format. Agent: `agent-d-2`.
- **[W735-3]** "Runtime execute tool calls against real APIs with appropriate auth" → ❌ tool-runtime adapter scaffold. Agent: `agent-d-2`.
- **[W735-4]** "Distilled agent handles 90% of tool-calling patterns locally". Agent: `agent-d-3`.
- **[W735-5]** Doc: `/docs/agents.html`. Agent: `agent-d-1`.

### W736 — GUARDRAIL COMPILATION

- **[W736-1]** "Users define safety rules at capture time ('never recommend competitor products')" → ❌ `kolm.yaml: guardrails: ...`. Agent: `guard-1`.
- **[W736-2]** "Bake into .kolm as hard constraints, not training signal" → ❌ guardrail block in manifest + runtime enforcement. Agent: `guard-2`.
- **[W736-3]** "Critical for enterprise where brand safety is non-negotiable" — verify-time check. Agent: `guard-2`.
- **[W736-4]** Doc: `/docs/guardrails.html`. Agent: `guard-1`.

### W737 — ARTIFACT MARKETPLACE EXPANSION

- **[W737-1]** "Browse by vertical, task type, K-Score, hardware target" → ❌ `/marketplace` faceted search. Agent: `mkt-1`.
- **[W737-2]** "Rate and review". Agent: `mkt-1`.
- **[W737-3]** "Publishers earn revenue (70/30 split)" → ❌ marketplace TOS + payout schema. Agent: `mkt-2`.
- **[W737-4]** "Fine-tune on their own captures (transfer learning)" → uses W715. Agent: `mkt-3`.
- **[W737-5]** Doc: `/docs/marketplace/publish.html`. Agent: `mkt-3`.

### W738 — ARTIFACT COMPOSITION

- **[W738-1]** "intake.kolm classifies → support.kolm or billing.kolm or escalation" → ❌ `kolm.pipeline.yaml` schema. Agent: `comp-1`.
- **[W738-2]** "Runtime handles routing between artifacts based on classifier output" → ❌ `src/pipeline-runner.js`. Agent: `comp-1`.
- **[W738-3]** "Each artifact independently versioned, re-distilled, evaluated". Agent: `comp-2`.
- **[W738-4]** Doc: `/docs/pipelines.html`. Agent: `comp-2`.

### W739 — ARTIFACT LINEAGE + VERSION DIFF

- **[W739-1]** "Each .kolm references parent artifact" → ❌ manifest `parent_cid`. Agent: `lineage-1`.
- **[W739-2]** "Diff performance between versions, roll back instantly" → ❌ `kolm diff <a.kolm> <b.kolm>`. Agent: `lineage-1`.
- **[W739-3]** "A/B test versions in production" — uses W777. Agent: `lineage-2`.
- **[W739-4]** "Model lineage tracking built into file format itself". Agent: `lineage-2`.

### W740 — GGUF / SAFETENSORS / ONNX IMPORT

- **[W740-1]** "`kolm import` from GGUF, safetensors, ONNX" → ❌ `apps/import/gguf.py` etc. Agent: `import-1`.
- **[W740-2]** Honest-by-default: imports declared `not_kolm_compiled`. Agent: `import-1`.
- **[W740-3]** `kolm export` to GGUF already shipped (A26); make symmetric in CLI. Agent: `import-2`.
- **[W740-4]** Doc: `/docs/import.html`. Agent: `import-2`.

### W741 — DIAGNOSTIC REPORT POST-DISTILL

- **[W741-1]** "K-Score 0.72: student consistently fails on multi-turn (samples 847, 1203, 1567). Add 100+ multi-turn captures." → ❌ structured diagnostic envelope. Agent: `diag-1`.
- **[W741-2]** "Per-category K-Score breakdown". Agent: `diag-1`.
- **[W741-3]** "Fix suggestions linked to actionable next steps". Agent: `diag-2`.

### W742 — LOCAL-ONLY / MOCK-GATEWAY MODE

- **[W742-1]** "Capture from local Ollama/vLLM instances (not cloud APIs)" → ❌ `KOLM_GATEWAY_MODE=local-ollama`. Agent: `local-1`.
- **[W742-2]** "Offline distillation using only local GPU". Agent: `local-1`.
- **[W742-3]** "Mock gateway for testing without API costs" → `KOLM_GATEWAY_MODE=mock`. Agent: `local-2`.

### W743 — MIGRATION WIZARD FROM OLLAMA/LM STUDIO

- **[W743-1]** `kolm migrate from-ollama` reads `~/.ollama/models/`. Agent: `migrate-1`.
- **[W743-2]** `kolm migrate from-lmstudio` reads LM Studio cache. Agent: `migrate-1`.
- **[W743-3]** Doc: `/docs/migrate.html`. Agent: `migrate-2`.

### W744 — SMART CAPTURE FILTER + INGEST DEDUP

- **[W744-1]** "Automatically identify high-information-density captures vs low-value" → ❌ ingest-time filter. Agent: `cap-filter-1`.
- **[W744-2]** "If 500 of 10k are near-identical, compress into weighted exemplars" → ❌ MinHash dedup. Agent: `cap-filter-1`.
- **[W744-3]** "Filter at capture time, not after". Agent: `cap-filter-2`.
- **[W744-4]** Stats surfaced in /account/captures dashboard. Agent: `cap-filter-2`.

### W745 — FAILURE-MODE VIZ DASHBOARD

- **[W745-1]** "Show dashboard of where student diverges most from teacher" → ❌ `/account/failure-modes.html`. Agent: `fm-viz-1`.
- **[W745-2]** "Cluster captures by topic/pattern, show per-cluster K-Scores" → ❌ uses W757 fingerprinting. Agent: `fm-viz-1`.
- **[W745-3]** "Your support bot scores 0.97 on refunds but 0.62 on billing disputes" — top regressions panel. Agent: `fm-viz-2`.
- **[W745-4]** Bridge to W741 diagnostic. Agent: `fm-viz-2`.

### W746 — CAPTURE STALENESS + TEACHER-VERSION TAGGING

- **[W746-1]** "Capture expiry / decay weighting (recent > older)" → ❌ recency weight in training sampler. Agent: `stale-1`.
- **[W746-2]** "Configurable retention policy (auto-expire >N days)" → ❌ per-namespace TTL. Agent: `stale-1`.
- **[W746-3]** "Visual timeline showing capture freshness distribution". Agent: `stale-2`.
- **[W746-4]** "Teacher version tagging on every capture" → ❌ extend event-store row. Agent: `stale-2`.

### W747 — DISTRIBUTION SHIFT ALERTS

- **[W747-1]** "Compare incoming query distribution to capture distribution (KL divergence)" → already partial via drift-supersession; add live alert. Agent: `shift-1`.
- **[W747-2]** "Alert when production distribution diverges beyond threshold" → ❌ webhooks + W709 routing-decision tie-in. Agent: `shift-1`.
- **[W747-3]** "Suggestion: 'Your student sees 15% more billing queries than trained. Capture 200 more.'" Agent: `shift-2`.

### W748 — SEASONAL CAPTURE TAGGING

- **[W748-1]** "Seasonal capture tagging" + time-series viz. Agent: `season-1`.
- **[W748-2]** "Option to distill seasonal variants" → ❌ namespace seasonal-variant. Agent: `season-1`.
- **[W748-3]** "Automatic seasonal variant selection based on calendar". Agent: `season-2`.

### W749 — SYNTHETIC AUGMENTATION + RARE-CASE GENERATION

- **[W749-1]** "Use teacher to generate synthetic variations covering gaps" → ❌ `src/synthetic-augment.js`. Agent: `synth-1`.
- **[W749-2]** "I see you have 200 refund queries but zero escalation — generate 50 escalation examples from teacher?" — UI prompt. Agent: `synth-1`.
- **[W749-3]** "Automated rare-case detection in capture analysis". Agent: `synth-2`.
- **[W749-4]** "Coverage report" + "importance upweighting of rare captures". Agent: `synth-2`.

### W750 — COPYRIGHT FILTER + CAPTURE QUARANTINE

- **[W750-1]** "Copyright filter on captures" → covered by W708-4; quarantine extension here. Agent: `quar-1`.
- **[W750-2]** "Capture quarantine: new captures held in staging area, validated before distillation pool" → ❌ `event-store` quarantine flag. Agent: `quar-1`.
- **[W750-3]** "User-configurable capture approval (manual review)" → ❌ `/account/captures/review.html`. Agent: `quar-2`.
- **[W750-4]** Defense-in-depth: tenant-fenced quarantine queue. Agent: `quar-2`.

### W751–W755 — VERTICAL FOUNDATION STUDENTS (5 verticals × 4 items each)

For each vertical V ∈ {legal, medical, code, finance, support}:
- **[W7Vx-1]** Fingerprint capture lake by vertical (anonymized). Agent: `vert-fp-V`.
- **[W7Vx-2]** Pre-train base student per vertical (W715 + W757 dep). Agent: `vert-train-V`.
- **[W7Vx-3]** Publish `kolm-V-7b` to marketplace. Agent: `vert-publish-V`.
- **[W7Vx-4]** Landing page `/verticals/V.html` with case study skeleton. Agent: `vert-page-V`.

### W756 — KOLMBENCH PUBLIC + LEADERBOARD

- **[W756-1]** Publish KolmBench v1 spec at `/bench/kolmbench-v1.html`. Agent: `kb-1`.
- **[W756-2]** Public leaderboard JSON (already partial). Agent: `kb-1`.
- **[W756-3]** Submission CI workflow `.github/workflows/kolmbench-submission.yml`. Agent: `kb-2`.
- **[W756-4]** "Curate most challenging captures across all users (anonymized, with consent)" → ❌ KolmBench v2 seed dataset. Agent: `kb-2`.

### W757 — CROSS-NAMESPACE ANON PATTERN LAKE

- **[W757-1]** "Capture lake as competitive advantage" — anonymized pattern aggregation. Agent: `lake-1`.
- **[W757-2]** Vertical fingerprint extraction (uses W751–W755). Agent: `lake-1`.
- **[W757-3]** "Identifying emerging use cases" → trend extraction CLI. Agent: `lake-2`.
- **[W757-4]** Privacy proof: differential-privacy aggregation (uses A7). Agent: `lake-2`.
- **[W757-5]** Doc: `/docs/data-network-effects.html`. Agent: `lake-3`.

### W758 — MMLU/HUMANEVAL/MT-BENCH INTEGRATION

- **[W758-1]** MMLU runner harness. Agent: `bench-1`.
- **[W758-2]** HumanEval runner. Agent: `bench-1`.
- **[W758-3]** MT-Bench runner. Agent: `bench-2`.
- **[W758-4]** Results table on `/benchmarks.html`. Agent: `bench-2`.

### W759 — NUMERICAL ACCURACY EVAL

- **[W759-1]** "Extract numbers from outputs and verify mathematical correctness" → ❌ `src/eval-numeric.js`. Agent: `num-1`.
- **[W759-2]** "Calculator tool integration in runtime". Agent: `num-1`.
- **[W759-3]** Warning flag on namespaces with high numerical content. Agent: `num-2`.

### W760 — PER-LANGUAGE K-SCORE

- **[W760-1]** "Per-language K-Score reporting" → ❌ language detect + axis split. Agent: `lang-1`.
- **[W760-2]** "Synthetic multilingual augmentation". Agent: `lang-1`.
- **[W760-3]** "Per-language confidence thresholds for fallback". Agent: `lang-2`.

### W761 — MODEL POISONING ANOMALY DETECTION

- **[W761-1]** "Anomaly detection on captures (flag responses deviating from teacher's typical distribution)" → ❌ `src/capture-anomaly.js`. Agent: `poison-1`.
- **[W761-2]** Capture quarantine integration (uses W750). Agent: `poison-1`.
- **[W761-3]** "Cryptographic binding of captures to verified teacher responses (prove no MITM)" → ❌ teacher-response HMAC. Agent: `poison-2`.
- **[W761-4]** Doc: `/security/model-poisoning.html`. Agent: `poison-2`.

### W762 — ADVERSARIAL RED-TEAM FRAMEWORK

- **[W762-1]** "Adversarial robustness testing as part of bakeoff" → ❌ `src/adversarial-bakeoff.js`. Agent: `redteam-1`.
- **[W762-2]** "Generate adversarial prompts and verify student handles correctly" → ❌ prompt corpus + generator. Agent: `redteam-1`.
- **[W762-3]** "Runtime input sanitization layer". Agent: `redteam-2`.
- **[W762-4]** "Fallback to teacher when input matches adversarial pattern". Agent: `redteam-2`.

### W763 — SBOM + SUPPLY-CHAIN

- **[W763-1]** "SBOM for every .kolm artifact and every kolm release" → ❌ `apps/export/sbom.py`. Agent: `sbom-1`.
- **[W763-2]** "Pin all dependency versions with hash verification" → ❌ `package-lock.json` strict + `requirements.txt` hash. Agent: `sbom-1`.
- **[W763-3]** "Snyk/Dependabot on every release" → ❌ `.github/workflows/sbom.yml`. Agent: `sbom-2`.
- **[W763-4]** `/security/sbom.html` published. Agent: `sbom-2`.

### W764 — MEMBERSHIP INFERENCE TEST

- **[W764-1]** "Verify individual captures can't be extracted" → ❌ `src/membership-inference-test.js`. Agent: `mit-1`.
- **[W764-2]** "PII scanning of model outputs during bakeoff". Agent: `mit-1`.
- **[W764-3]** "Configurable 'forget' mechanism to remove specific captures + re-distill" → ❌ `kolm forget --capture-id`. Agent: `mit-2`.

### W765 — PROMPT EXTRACTION DEFENSE

- **[W765-1]** "System prompt obfuscation during distillation (behavior not literal text)" → ❌ prompt-redactor in distill pipeline. Agent: `pextract-1`.
- **[W765-2]** "Runtime guardrails that detect/block extraction attempts" → ❌ pattern-match filter. Agent: `pextract-1`.
- **[W765-3]** "Documentation of risk on security posture page". Agent: `pextract-2`.

### W766 — EU AI ACT COMPLIANCE TOOLKIT

- **[W766-1]** "Auto-generate AI Act technical documentation from .kolm artifacts" → ❌ `apps/export/ai_act_docs.py`. Agent: `aiact-1`.
- **[W766-2]** "Risk scoring based on artifact's task category". Agent: `aiact-1`.
- **[W766-3]** "Human-in-the-loop configuration (confidence threshold for human review)" → uses W709. Agent: `aiact-2`.
- **[W766-4]** "Data governance reports". Agent: `aiact-2`.
- **[W766-5]** `/compliance/eu-ai-act.html` landing. Agent: `aiact-3`.

### W767 — SOC 2 TYPE II + ISO 27001 DOCS

- **[W767-1]** SOC 2 Type II prep checklist published `/security/soc2-type2.html`. Agent: `cert-1`.
- **[W767-2]** ISO 27001 Annex A controls map `/security/iso-27001.html`. Agent: `cert-1`.
- **[W767-3]** Audit-log retention extension to 12 months (Type II requirement). Agent: `cert-2`.
- **[W767-4]** Continuous-monitoring dashboard (depends W730). Agent: `cert-2`.

### W768 — MODEL CARD AUTO-GEN

- **[W768-1]** "Auto-generate model cards (per Hugging Face standard) for every .kolm" → ❌ `apps/export/model_card.py`. Agent: `card-1`.
- **[W768-2]** "Intended use, limitations, training data summary, eval results, ethical considerations, environmental impact". Agent: `card-1`.
- **[W768-3]** "Embeddable in OneTrust/ServiceNow AI Governance/IBM OpenPages" → schema doc. Agent: `card-2`.

### W769 — DATA RESIDENCY + GEO-FENCE

- **[W769-1]** "Data residency tagging on every capture (EU stays EU)" → ❌ event-store row + enforcement. Agent: `dr-1`.
- **[W769-2]** "Region-specific .kolm artifacts" → manifest region field. Agent: `dr-1`.
- **[W769-3]** "Region-aware distillation (only captures from target region)". Agent: `dr-2`.
- **[W769-4]** Geo-fencing already in W708-5; cross-ref doc. Agent: `dr-2`.

### W770 — AUDIT EXPORT (CSV + SIEM)

- **[W770-1]** `kolm audit export --format csv`. Agent: `aexport-1`.
- **[W770-2]** SIEM-compatible CEF/LEEF format. Agent: `aexport-1`.
- **[W770-3]** Doc: `/docs/audit-export.html`. Agent: `aexport-2`.

### W771 — VLM DISTILL MODULE

- **[W771-1]** `apps/trainer/vlm_distill.py` (vision-language distill, not just vlm.py train). Agent: `vlm-d-1`.
- **[W771-2]** Capture vision messages (image_url content blocks). Agent: `vlm-d-1`.
- **[W771-3]** Bakeoff vision pairs. Agent: `vlm-d-2`.
- **[W771-4]** Doc: `/docs/multimodal/vision.html`. Agent: `vlm-d-2`.

### W772 — AUDIO DISTILL

- **[W772-1]** `apps/trainer/audio_distill.py` (transcript + intent). Agent: `aud-d-1`.
- **[W772-2]** Capture audio inputs (whisper transcript → teacher response). Agent: `aud-d-1`.
- **[W772-3]** Bakeoff audio pairs. Agent: `aud-d-2`.
- **[W772-4]** Doc: `/docs/multimodal/audio.html`. Agent: `aud-d-2`.

### W773 — VIDEO DISTILL

- **[W773-1]** Frame sampling + caption pipeline. Agent: `vid-d-1`.
- **[W773-2]** Capture video URLs + teacher responses. Agent: `vid-d-1`.
- **[W773-3]** Bakeoff video pairs. Agent: `vid-d-2`.
- **[W773-4]** Doc: `/docs/multimodal/video.html`. Agent: `vid-d-2`.

### W774 — CROSS-LINGUAL DISTILL

- **[W774-1]** "Distill from English teacher → multilingual student handling 10+ languages" → ❌ language-balanced sampler. Agent: `xlang-1`.
- **[W774-2]** Per-language eval. Agent: `xlang-2`.
- **[W774-3]** Doc: `/docs/multilingual.html`. Agent: `xlang-2`.
- **[W774-4]** Bakeoff multi-lang pairs. Agent: `xlang-1`.

### W775 — CONTINUOUS BACKGROUND DISTILL (THE KILLER FEATURE)

- **[W775-1]** "Install kolm, point at API, forget about it. It captures every call." — daemon scaffold. Agent: `cont-1`.
- **[W775-2]** "Continuously evaluates whether it has enough data to distill" — readiness scorer. Agent: `cont-1`.
- **[W775-3]** "When critical mass, automatically distills/quantizes/deploys local model". Agent: `cont-2`.
- **[W775-4]** "Silently routes matching queries to local, only novel/uncertain to teacher" — uses W709. Agent: `cont-2`.
- **[W775-5]** "API bill drops gradually + automatically without manual intervention" — savings telemetry. Agent: `cont-3`.
- **[W775-6]** `/kolm-auto-pilot.html` landing + opt-in. Agent: `cont-4`.

### W776 — SYNTHETIC CAPTURE SELF-IMPROVEMENT

- **[W776-1]** Synthetic-gen on persistent failure modes (W745 dep). Agent: `synself-1`.
- **[W776-2]** Loop into next distillation cycle (W720 dep). Agent: `synself-1`.
- **[W776-3]** Telemetry: synthetic-vs-real capture ratio. Agent: `synself-2`.

### W777 — A/B TESTING INFRA

- **[W777-1]** "Traffic splitting (50% to v1.kolm, 50% to v2.kolm)" → ❌ `src/ab-router.js`. Agent: `ab-1`.
- **[W777-2]** Statistical-significance gate (uses W778). Agent: `ab-1`.
- **[W777-3]** Dashboard `/account/ab-tests.html`. Agent: `ab-2`.
- **[W777-4]** Auto-rollback hook (uses W778). Agent: `ab-2`.

### W778 — STAT SIG + AUTO-ROLLBACK

- **[W778-1]** "Statistical significance testing before promoting" → ❌ `src/stat-sig.js`. Agent: `sig-1`.
- **[W778-2]** "Automatic rollback if new version underperforms". Agent: `sig-1`.
- **[W778-3]** Wired into A/B router (W777). Agent: `sig-2`.
- **[W778-4]** Doc: `/docs/releasing.html`. Agent: `sig-2`.

### W779 — AIR-GAPPED FORMAL + SNEAKERNET

- **[W779-1]** Formal air-gap mode: `KOLM_AIRGAP=1` disables network. Agent: `air-1`.
- **[W779-2]** Capture from local-Ollama / kolm-local-teacher. Agent: `air-1`.
- **[W779-3]** "Sneakernet deployment: transfer .kolm via USB with sig verify" → ❌ `kolm pack --sneakernet`. Agent: `air-2`.
- **[W779-4]** Doc: `/docs/airgap.html` expansion. Agent: `air-2`.

### W780 — MULTI-REGION GATEWAY

- **[W780-1]** "Multi-region gateway deployment (EU/US/APAC)" → ❌ regional CDN config + DNS schema. Agent: `region-1`.
- **[W780-2]** "Region-aware capture routing" (uses W769). Agent: `region-1`.
- **[W780-3]** "Edge deployment support (Cloudflare Workers, Lambda@Edge)" → ❌ adapter. Agent: `region-2`.
- **[W780-4]** Doc: `/docs/multi-region.html`. Agent: `region-2`.

### W781 — LONG-CONTEXT DEGRADATION WARNINGS

- **[W781-1]** "Context length distribution analysis of captures". Agent: `lc-1`.
- **[W781-2]** "Automatic inclusion of synthetic long-context examples during distill" (uses W749). Agent: `lc-1`.
- **[W781-3]** "Runtime warning when input exceeds 90th percentile". Agent: `lc-2`.

### W782 — TEAM APPROVAL WORKFLOW

- **[W782-1]** "Distillation requires manager sign-off in regulated environments" → ❌ `src/distill-approval-queue.js`. Agent: `appr-1`.
- **[W782-2]** Webhook/email notify. Agent: `appr-1`.
- **[W782-3]** `/account/approvals.html`. Agent: `appr-2`.

### W783 — COST ATTRIBUTION / CHARGEBACK

- **[W783-1]** "Per-department, per-project, per-namespace cost tracking" — extends W465. Agent: `charge-1`.
- **[W783-2]** "Exportable reports for finance teams" (uses W770). Agent: `charge-1`.
- **[W783-3]** `/account/chargeback.html`. Agent: `charge-2`.

### W784 — PLUGIN ARCHITECTURE

- **[W784-1]** "Custom quantization methods plug into the forge" → ❌ plugin interface. Agent: `plugin-1`.
- **[W784-2]** "Custom runtime adapters plug into kolm run". Agent: `plugin-1`.
- **[W784-3]** "Custom capture processors plug into gateway". Agent: `plugin-2`.
- **[W784-4]** "Custom eval metrics plug into bakeoff". Agent: `plugin-2`.
- **[W784-5]** Plugin marketplace + doc `/docs/plugins.html`. Agent: `plugin-3`.

### W785 — KOLM CLOUD MANAGED-DISTILL EXPANSION

- **[W785-1]** "Upload captures → distill on their infra → download .kolm" → expansion. Agent: `cloud-1`.
- **[W785-2]** "Pay per distillation run, not per inference" — separate metering. Agent: `cloud-1`.
- **[W785-3]** "Useful for users with inference HW but not training HW" — landing. Agent: `cloud-2`.
- **[W785-4]** `/cloud.html`. Agent: `cloud-2`.

### W786 — CARBON FOOTPRINT + CO2

- **[W786-1]** "CO2 estimate per distillation run (GPU type, duration, grid carbon)" → ❌ `src/carbon-estimator.js`. Agent: `co2-1`.
- **[W786-2]** "CO2 savings report: 'Running .kolm locally saved X kg CO2'". Agent: `co2-1`.
- **[W786-3]** "Sustainability badge on .kolm artifacts". Agent: `co2-2`.

### W787 — COMPUTE EFFICIENCY OPTIMIZATIONS

- **[W787-1]** "Early stopping when K-Score plateaus". Agent: `eff-1`.
- **[W787-2]** "Mixed-precision training (FP16/BF16)". Agent: `eff-1`.
- **[W787-3]** "Gradient checkpointing for memory-efficient distill". Agent: `eff-2`.

### W788 — SLA PERSISTENT DASHBOARD

- **[W788-1]** Persistent latency p50/p95/p99 over time. Agent: `sla-1`.
- **[W788-2]** Uptime per surface. Agent: `sla-1`.
- **[W788-3]** `/account/sla.html`. Agent: `sla-2`.

### W789 — DOCUMENTATION COOKBOOK EXPANSION

- **[W789-1]** "Distill a coding assistant" recipe. Agent: `cb-1`.
- **[W789-2]** "Distill a support bot" recipe. Agent: `cb-1`.
- **[W789-3]** "Distill a document extractor" recipe. Agent: `cb-2`.
- **[W789-4]** Quickstart per SDK language (Node/Python/Rust/C/MCP). Agent: `cb-2`.

### W790 — SECURITY POSTURE + THREAT MODEL

- **[W790-1]** `/security/posture.html` (existing security.html expansion). Agent: `sec-pose-1`.
- **[W790-2]** Threat model doc `/security/threat-model.html`. Agent: `sec-pose-1`.
- **[W790-3]** Architecture diagram embedded. Agent: `sec-pose-2`.

### W791 — SAVINGS-BASED PRICING

- **[W791-1]** "Charge percentage of documented API savings (10%)" → ❌ new tier added to /pricing. Agent: `save-1`.
- **[W791-2]** Savings audit trail. Agent: `save-1`.
- **[W791-3]** Doc: `/pricing/savings-based.html`. Agent: `save-2`.

### W792 — REGIONAL / PPP PRICING

- **[W792-1]** "PPP-adjusted pricing for developing regions" → ❌ region detect + price table. Agent: `ppp-1`.
- **[W792-2]** "Non-profit pricing" (FAQ promotion to formal tier). Agent: `ppp-1`.
- **[W792-3]** Doc: `/pricing/regional.html`. Agent: `ppp-2`.

### W793 — COMPUTE CREDITS BUNDLED

- **[W793-1]** "Pro tier: includes $100 of teacher compute per month". Agent: `bundle-1`.
- **[W793-2]** "Team: includes $500 of teacher compute". Agent: `bundle-1`.
- **[W793-3]** Bulk-API negotiation doc (internal). Agent: `bundle-2`.

### W794 — STUDENT/STARTUP/NON-PROFIT FORMAL TIER

- **[W794-1]** "Student tier (free or heavily discounted)" → ❌ new tier card on /pricing. Agent: `edu-1`.
- **[W794-2]** "Startup program (free Pro for YC/Techstars/500 Startups)" — formal application. Agent: `edu-1`.
- **[W794-3]** "Non-profit pricing" — formal application form. Agent: `edu-2`.

### W795 — FREE TIER 10k → 50k

- **[W795-1]** "Increase free tier to 50k calls" → ❌ /pricing card update. Agent: `free-1`.
- **[W795-2]** Quota enforcement update. Agent: `free-1`.

### W796 — CURRENCY LOCALIZATION

- **[W796-1]** "Accept local currencies (not just USD)" — add CNY, INR, BRL. Agent: `curr-1`.
- **[W796-2]** "Alipay/WeChat Pay for Chinese market" — note in payment options. Agent: `curr-1`.
- **[W796-3]** "Crypto payments for privacy-conscious users" — opt-in. Agent: `curr-2`.

### W797 — PURCHASE ORDER ENTERPRISE

- **[W797-1]** "Support purchase orders (not just credit card)" — enterprise contact form. Agent: `po-1`.
- **[W797-2]** Net-30/net-60 terms note. Agent: `po-1`.

### W798 — HARDWARE PARTNERSHIP LANDING

- **[W798-1]** "Powered by kolm" hardware partner page `/partners/hardware.html`. Agent: `hw-part-1`.
- **[W798-2]** "Buy RTX 5090 → 1 year kolm Pro free" — partnership template. Agent: `hw-part-1`.
- **[W798-3]** NVIDIA/Intel/AMD partner badges (when partnerships exist; 🔒 external-blocked, but page ready). Agent: `hw-part-2`.

### W799 — AWS MARKETPLACE LISTING PREP

- **[W799-1]** AWS Marketplace product spec (CloudFormation template). Agent: `aws-1`.
- **[W799-2]** Listing copy + ToS adapted for AWS. Agent: `aws-1`.
- **[W799-3]** Azure + GCP equivalents 🔒. Agent: `aws-2`.

### W800 — CLOUD-PROVIDER INTEGRATION DOCS

- **[W800-1]** "SageMaker one-click deploy" guide. Agent: `cloud-int-1`.
- **[W800-2]** "Azure AI Studio integrated workflow" guide. Agent: `cloud-int-1`.
- **[W800-3]** "GCP Vertex AI managed .kolm serving" guide. Agent: `cloud-int-2`.

### W801 — COMPETITOR POSITIONING MATRIX

- **[W801-1]** `/vs/openai-api.html` "Same quality, zero marginal cost after compile". Agent: `vs-1`.
- **[W801-2]** `/vs/ollama.html`, `/vs/lm-studio.html`, `/vs/openrouter.html`, `/vs/together.html`. Agent: `vs-1`.
- **[W801-3]** `/vs/index.html` matrix landing. Agent: `vs-2`.

### W802 — CONTENT STRATEGY CADENCE

- **[W802-1]** `/blog/` weekly cadence scaffold (TBD: content team). Agent: `content-1`.
- **[W802-2]** "Monthly State of Distillation report" template. Agent: `content-1`.
- **[W802-3]** "Annual Cost of AI report" template. Agent: `content-2`.

### W803 — KOLM UNIVERSITY

- **[W803-1]** `/university/` landing. Agent: `uni-1`.
- **[W803-2]** "Distillation 101" first lesson. Agent: `uni-1`.
- **[W803-3]** Cert-program spec (TBD). Agent: `uni-2`.
- **[W803-4]** Connect to W789 cookbook. Agent: `uni-2`.

### W804 — KOLM LABS RESEARCH GRANTS

- **[W804-1]** `/labs/` landing page. Agent: `labs-1`.
- **[W804-2]** Grant application form scaffold. Agent: `labs-1`.

### W805 — BRANDING POLISH

- **[W805-1]** "Professional GitHub org name (kolm-ai or kolmogorov-ai)" — note + decision matrix (no rename yet). Agent: `brand-1`.
- **[W805-2]** "Clear company entity (Kolm Inc. or Kolm Labs)" — about-page polish. Agent: `brand-1`.
- **[W805-3]** "Published company values (transparency, reproducibility, user ownership)" — values section. Agent: `brand-2`.

### W806 — FINAL 100% AUDIT + SHIP + POST-FLIGHT

- **[W806-1]** Full audit-static-refs + audit-href --strict + tests sweep. Agent: `final-1`.
- **[W806-2]** sw.js bump + frontend-version.json. Agent: `final-2`.
- **[W806-3]** Mass-commit explicit paths. Agent: `final-3`.
- **[W806-4]** Push origin + public. Agent: `final-4`.
- **[W806-5]** Cross-reference all 114 items as ✅. Agent: `final-5`.

---

## PART III — EXTERNAL-BLOCKED ITEMS (TRACKED, NOT IMPLEMENTABLE AS CODE)

These items require legal/business/HR action outside the codebase. The plan implements **preparatory artifacts** so kolm is ready when external action lands.

| # | Item | Preparatory artifact | Wave |
|---|------|---------------------|------|
| 🔒 E1 | Anthropic/OpenAI distillation partner status | Outreach template + open-weights-default doc | W708 |
| 🔒 E2 | IP attorney legal opinion published | Liability framework page placeholder | W708 |
| 🔒 E3 | SOC 2 Type II audit | Prep checklist published | W767 |
| 🔒 E4 | ISO 27001 certificate | Annex A controls map | W767 |
| 🔒 E5 | FedRAMP authorization | Tracked; not on critical path | — |
| 🔒 E6 | Hardware vendor partnerships (NVIDIA/Intel/AMD) | Landing pages ready | W798 |
| 🔒 E7 | AWS/Azure/GCP marketplace listings | Spec ready | W799 |
| 🔒 E8 | Discord/Slack community | Skipped per directive |
| 🔒 E9 | Independent benchmark reviewers (Simon Willison, r/LocalLLaMA) | Send-list maintained internally |
| 🔒 E10 | Founders/about page | EXCLUDED per standing user directive |
| 🔒 E11 | Stars/traction marketing | EXCLUDED per standing user directive |
| 🔒 E12 | Patent filings (provisional) | Patent strategy doc internal-only |
| 🔒 E13 | Key hires (Head of Research, Sales, DevRel, Security, MLI) | Tracked separately |
| 🔒 E14 | Advisory board recruitment | Tracked separately |
| 🔒 E15 | VC fundraising | Tracked separately |

---

## PART IV — STANDING DIRECTIVES (binding through W806)

1. Never `git add -A`. Stage explicit paths per wave (W604 trap).
2. Never force-push to main/master EXCEPT public/main on kolmogorov-stack.
3. Bump `public/sw.js` cache key + `public/frontend-version.json` for every UI-affecting wave.
4. Run `node scripts/audit-static-refs.cjs` + `node scripts/audit-href.cjs --strict` before commit.
5. Push to BOTH origin (Vercel) AND public (mirror).
6. Preserve test anchors: W220 W260 W271 W335 W373 W404 W408 W410 W705 W706.
7. NEVER stage `.env*`, `*.pem`, `*.key`, `secrets/`, `%TEMP%tid.txt`.
8. NEVER create README/CHANGELOG/docs.md files unless explicitly user-requested (this plan is explicitly requested).
9. Founders/about page + stars/traction surface remain EXCLUDED.
10. Branding lock: Eyebrow "Open-source AI workbench"; H1 "Frontier AI on your own infrastructure."; contact rodneyyesep@gmail.com.

---

## PART V — EXECUTION CADENCE

Waves run **sequentially**. Within each wave, agents run **in parallel via single-message multi-Agent-tool-use blocks**. After each wave:
1. Verify deliverables (audits, tests where applicable).
2. Bump sw.js + frontend-version.json if UI-affecting.
3. Commit explicit paths.
4. Push origin + public.
5. Mark wave items ✅ in this doc.
6. Begin next wave.

**Wave 707 is THIS plan.** Wave 708 begins immediately after this commit lands.

---

## PART VI — EXTERNAL-REVIEW ADDITION 2026-05-24 (29 NEW WAVES, W807-W835)

Source: second external-review queue dated 2026-05-24, delivered verbatim by user with directive "do not miss any that you were already focused on these are purely additions — update the master doc now to survive compression … and also have atomic levels of execution like this."

**Priority override:** Tier 0 items (W807-W810) are "ship-blocking before launch." They JUMP the queue and execute IMMEDIATELY after the current W720-W722 batch lands, before W723 begins. Tier 1-4 retain numerical ordering W811-W835 and execute after W806 OR interleave based on dependency (e.g. W811 capture analytics is a natural follow-on to W720 self-improvement; flag at runtime).

**Tier legend:** `[T0]` ship-blocking · `[T1]` first 30 days · `[T2]` first 90 days · `[T3]` first 6 months · `[T4]` year 1+

---

### W807 — [T0] CONFIDENCE-AWARE ADAPTIVE ROUTING

Without this, every deployment is "trust the student blindly." With it, every fallback is a training signal feeding W720 self-improvement loop. Highest-impact T0 item.

- **[W807-1]** Token-level entropy monitoring during student generation. New `src/confidence-router.js` exports `tokenEntropy(logits)`, `streamingEntropyWindow(window=8)`, threshold table `{aggressive:0.85, balanced:0.7, conservative:0.55}`. Agent: `confidence-1`.
- **[W807-2]** Mid-response seamless splice: when entropy window exceeds threshold, request teacher to continue from current token state. New `src/teacher-splice.js` exports `spliceToTeacher({tokens_so_far, prompt, teacher_id, budget_ms})`. Honest envelope: teacher unreachable → finish-locally + stamp `fallback_failed:true` on response metadata. Agent: `confidence-2`.
- **[W807-3]** Response metadata schema: `{local_tokens, teacher_tokens, local_ratio, splice_events:[{at_token, reason, latency_ms}], threshold_used}`. Add to response envelope across all runtime backends. Agent: `confidence-3`.
- **[W807-4]** Dashboard `/account/confidence.html`: local-vs-teacher ratio over time, cost savings line, p50/p95/p99 splice latency, threshold-distribution histogram. Agent: `confidence-4`.
- **[W807-5]** Fallback latency budget: configurable per-tenant `max_splice_delay_ms`; exceeded → degrade-to-local with warning event. Agent: `confidence-4`.
- **[W807-6]** Wire-into-W720: every fallback span emits `{capture_candidate:true, weakness_signal:true}` event → W720 detectUnderperformingCaptures elevates these to top of re-distill queue. Agent: `confidence-5`.

### W808 — [T0] CAPTURE POISONING DETECTION

Before ANY production traffic flows, captures must be sanity-checked. Without this, malicious traffic poisons the next distillation.

- **[W808-1]** Statistical anomaly detector: per-tenant per-namespace running mean/stddev on output_length, vocab_entropy, response_time, token_overlap_to_teacher_typical. Flag if any axis exceeds 3σ. New `src/capture-anomaly.js`. Agent: `poison-1`.
- **[W808-2]** Capture staging/quarantine: new captures land in `staged_captures` table with `quarantine_until: now()+24h`. Promotion to `captures` table requires (a) no anomaly flag AND (b) no manual block. New table + migration in `src/store.js`. Agent: `poison-2`.
- **[W808-3]** Cryptographic origin binding: capture rows store `teacher_response_signature` (sha256 of teacher response headers + first 256 bytes of body); reject if signature does not chain to a known teacher fingerprint. Add to `src/proxy.js`. Agent: `poison-3`.
- **[W808-4]** Manual review queue UI `/account/captures/review.html` with allow/block/escalate actions. Per-row diff vs teacher baseline. Agent: `poison-4`.
- **[W808-5]** Post-distillation regression gate: bakeoff vs prior artifact on shared eval set; auto-rollback if K-Score drops > 0.02 OR critical_fail_rate increases > 1pp. Wire into `src/distill-pipeline.js` final step. Agent: `poison-5`.
- **[W808-6]** New CLI: `kolm captures review [--list-pending | --allow ID | --block ID --reason "..." | --auto-allow-since 24h]`. Agent: `poison-6`.

### W809 — [T0] STRUCTURED OUTPUT VALIDATION

The #1 production failure mode: teacher emits valid JSON, student emits broken JSON, downstream silently corrupts.

- **[W809-1]** Schema specification in `.kolm` manifest: `output_schema:{kind:'json'|'xml'|'grammar'|'regex'|null, schema:<inline-or-ref>, strict:bool}`. Extend `src/artifact.js` buildPayload — conditionally bind `output_schema_hash` into artifact_hash chain (W460 pattern). Agent: `schema-1`.
- **[W809-2]** Constrained decoding engine integration. Add `src/constrained-decode.js` wrapping `outlines` (Python) or `lm-format-enforcer` for JSON-Schema-guided sampling. Worker shell at `workers/constrained/`. Honest envelope: library not installed → exit 3 + `no_constrained_decoder` + install hint. Agent: `schema-2`.
- **[W809-3]** Bakeoff parse-validation track: every structured output is parsed; emit `parse_failure_rate` ALONGSIDE K-Score (never substituted for). Extend `src/bakeoff.js` summary. Agent: `schema-3`.
- **[W809-4]** Runtime auto-retry on parse failure: up to 3 retries with temperature decay (0.7 → 0.3 → 0.1); 4th attempt falls back to teacher via W807 splice. New retry harness in `src/runtime-wrap.js`. Agent: `schema-4`.
- **[W809-5]** CLI: `kolm compile --output-schema <file.json>` writes schema into artifact; `kolm verify --validate-schema` runs schema check post-load. Agent: `schema-5`.

### W810 — [T0] K-SCORE EXTERNAL CALIBRATION (move up from W745)

If K-Score 0.91 doesn't mean what users perceive, credibility dies on day one.

- **[W810-1]** Calibration pack data layer: new `src/kscore-calibration.js` reads `~/.kolm/calibration-pack-YYYY-MM.jsonl` (rows: `{pair_id, prompt, response_a, response_b, human_preference:'a'|'b'|'tie', task_category}`). Agent: `cal-1`.
- **[W810-2]** Bradley-Terry fitter: pure-JS solver (gradient descent on logistic likelihood) to estimate latent skill from pairwise prefs; emits per-task-category and pooled curves. `src/bradley-terry.js`. Agent: `cal-2`.
- **[W810-3]** Calibration mapping export: write `~/.kolm/kscore-calibration.json` `{by_category:{coding:{slope, intercept, ci95_low, ci95_high}, writing:{...}, analysis:{...}, support:{...}}, pooled:{...}, n_pairs, fitted_at}`. Agent: `cal-2`.
- **[W810-4]** Surface calibration in K-Score response envelope: `{kscore:0.91, human_preference_rate:{point:0.89, ci95:[0.86,0.92]}, calibration_pack_id:'2026-Q2'}`. Extend `src/kscore.js`. Agent: `cal-3`.
- **[W810-5]** Quarterly recalibration job: `scripts/recalibrate-kscore.cjs` ingests new pack, fits, writes mapping. Cron-friendly. Agent: `cal-4`.
- **[W810-6]** Public methodology page `/k-score-calibration.html`: explains Bradley-Terry, links to anonymized pack hash, shows current curves. Honest contract: never publish mapping without n>=500 pairs in category (display "insufficient_data" instead). Agent: `cal-5`.

---

### W811 — [T1] CAPTURE ANALYTICS DASHBOARD

Users must understand their data BEFORE distilling. Pairs with W716 TAAS recommender.

- **[W811-1]** Topic clustering pipeline: `src/capture-cluster.js` — embed captures (existing `src/embed.js`), HDBSCAN or k-means via pure-JS implementation OR `workers/cluster/` Python shell with sklearn. Agent: `analytics-1`.
- **[W811-2]** Per-cluster summary: volume, diversity (mean pairwise distance), avg/p95 length, language breakdown, temporal histogram. Agent: `analytics-2`.
- **[W811-3]** Pre-distill K-Score prediction: ML estimate using W832 kolm-meta inputs (capture stats → predicted K-Score). Initial v0: rule-based score = `0.65 + 0.001 * min(n_captures, 500) + 0.05 * cluster_diversity_norm`. Agent: `analytics-3`.
- **[W811-4]** Readiness score + recommendations: emit `{readiness:0..1, missing:[{cluster, current_n, recommended_n, projected_kscore_lift}]}`. Agent: `analytics-3`.
- **[W811-5]** Dashboard `/account/captures/analytics.html`: cluster bubbles, readiness gauge, recommendation list, "Distill now" CTA. Agent: `analytics-4`.
- **[W811-6]** Smart dedup: detect near-duplicates (cosine > 0.97 over embeddings), compress to weighted exemplar. Toggle via `--dedup-near` flag on `kolm captures stats`. Agent: `analytics-5`.

### W812 — [T1] FAILURE-MODE VISUALIZATION

After distillation, show WHERE the student fails.

- **[W812-1]** Per-cluster K-Score breakdown in `src/bakeoff.js` summary (already groups; surface in API). Agent: `failmode-1`.
- **[W812-2]** Worst-N examples surface: top-20 mismatches with teacher/student side-by-side, full diff. New route `/v1/bakeoff/:id/worst`. Agent: `failmode-2`.
- **[W812-3]** Failure categorization rubric: format / factual / reasoning / tone / hallucination — heuristic classifier in `src/failure-categorize.js` (regex + length-delta + entity-overlap + numeric-mismatch). Agent: `failmode-3`.
- **[W812-4]** Fix priority ranking: `priority = cluster_freq × kscore_delta × user_visibility_weight`; emit ranked list. Agent: `failmode-3`.
- **[W812-5]** Capture-recommendation link: every failure category gets actionable text "Capture 50 more examples like THIS to fix" with a query template. Agent: `failmode-4`.
- **[W812-6]** Dashboard `/account/artifacts/:id/failures.html`. Agent: `failmode-5`.

### W813 — [T1] DRIFT DETECTION AND ALERTING

Deployed students degrade as production traffic shifts.

- **[W813-1]** Embedding-distribution comparator: `src/drift-detect.js` — KL divergence between live-query embedding histogram and capture-training embedding histogram (binned). Already partial in `src/drift-supersession.js` — extend. Agent: `drift-1`.
- **[W813-2]** Configurable threshold + alert: default `kl_threshold:0.10`, `fallback_rate_lift:0.20`. Per-namespace override. Agent: `drift-1`.
- **[W813-3]** Webhook + email alerts: reuse existing `src/notifications.js` (W215). New `drift_detected` event type. Agent: `drift-2`.
- **[W813-4]** Suggested-action text with quantified shift: "your traffic shifted 23% more billing queries; re-distill recommended". Agent: `drift-3`.
- **[W813-5]** Auto-trigger W720 self-improvement when drift detected (opt-in via `auto_remediate_drift:true` namespace setting). Agent: `drift-4`.

### W814 — [T1] SPECULATIVE DECODING WITH STUDENT DRAFT

Student as draft for teacher — inverse of W807 fallback.

- **[W814-1]** Speculative wrapper: `src/speculative-teacher.js` — student generates N=8 candidate tokens; teacher verifies in one forward pass. Reuses EAGLE-3 infra already shipped (A3). Agent: `spec-1`.
- **[W814-2]** Acceptance-rate benchmarker: per-artifact `kolm bench speculative --against TEACHER` reports acceptance rate + effective speedup. Agent: `spec-2`.
- **[W814-3]** Runtime mode flag: `--speculative student` on `kolm serve` enables draft mode. Agent: `spec-3`.
- **[W814-4]** Per-task acceptance log: store `{task_cluster, accept_rate, avg_accepted_run}` in event-store; surface in dashboard. Agent: `spec-4`.

### W815 — [T1] ACTIVE LEARNING LOOP

Automatically identify what to capture next.

- **[W815-1]** Gap detector: `src/active-learning.js` — compare capture distribution (W811 clustering) to production-traffic distribution (W813 live histogram); rank gaps by `gap_size × prod_frequency × est_kscore_lift`. Agent: `active-1`.
- **[W815-2]** Recommendation surface: top-K gaps as actionable items "Your top 3 capture priorities: ..." in dashboard + CLI `kolm captures next`. Agent: `active-2`.
- **[W815-3]** Optional synthetic-capture generation: with user approval, teacher generates synthetic examples for gap clusters. Honest envelope: synthetic captures stamped `synthetic:true`; never silent. Agent: `active-3`.
- **[W815-4]** Wire-into-W720 self-improvement: active-learning queue is the seed for next orchestrateImprovement call. Agent: `active-4`.

### W816 — [T1] FAILURE-MODE → CAPTURE RECOMMENDATION FEEDBACK LOOP

(Implicit T1 from queue summary — failure-mode + active-learning + W720 form the loop.)

- **[W816-1]** Glue: failure rows from W812 → priority feed in W815. Agent: `loop-1`.
- **[W816-2]** Lock-in test: end-to-end fixture proving the failure→capture→re-distill→improvement cycle produces a K-Score lift on a synthetic regression. Agent: `loop-1`.

---

### W817 — [T2] .KOLM FORMAT FORMAL SPECIFICATION

Start the standard moat.

- **[W817-1]** Version-numbered spec doc `docs/spec/kolm-format-v1.0.md` (this IS user-requested — add to allowed-MD list). Agent: `spec-1`.
- **[W817-2]** kolmspec.org domain placeholder + redirect plan (no DNS purchase this wave — TODO note). Agent: `spec-2`.
- **[W817-3]** Reference implementations: `sdk/c/kolm-format.h` schema reader, `sdk/python/kolm/format.py`, `sdk/rust/src/format.rs`. Agent: `spec-3`, `spec-4`, `spec-5` (parallel).
- **[W817-4]** Test vectors: 5 known-good artifacts checked into `tests/fixtures/format-v1/*.kolm` with sha256 manifest. Agent: `spec-6`.
- **[W817-5]** RFC-style change process doc `docs/spec/CHANGE_PROCESS.md`. Agent: `spec-7`.

### W818 — [T2] .KOLM LOADERS FOR ECOSYSTEM TOOLS

- **[W818-1]** llama.cpp loader PR: prepare `tools/llama-cpp-kolm-loader/` patch series. Agent: `eco-1`.
- **[W818-2]** Ollama loader / plugin in `tools/ollama-kolm/`. Agent: `eco-2`.
- **[W818-3]** Hugging Face Hub format-option PR draft. Agent: `eco-3`.
- **[W818-4]** vLLM model loader in `tools/vllm-kolm/`. Agent: `eco-4`.
- **[W818-5]** LM Studio import-wizard spec doc. Agent: `eco-5`.

### W819 — [T2] VS CODE EXTENSION

(Partial: `packages/vscode-kolm-rag/` exists. Upgrade to full passive-monitor + distill workflow.)

- **[W819-1]** Passive monitor: hook Copilot/Cursor/Claude-Code suggestion-acceptance events. Agent: `vscode-1`.
- **[W819-2]** Pattern detection: surface "boilerplate", "tests", "docstrings" repetition clusters. Agent: `vscode-2`.
- **[W819-3]** Status bar: capture count + "ready to distill" CTA. Agent: `vscode-3`.
- **[W819-4]** Post-distill routing: route matching completions to local student via in-process runtime. Agent: `vscode-4`.
- **[W819-5]** Settings panel: threshold, teacher preference, namespace. Agent: `vscode-5`.

### W820 — [T2] GITHUB ACTIONS INTEGRATION

- **[W820-1]** `.github/workflows/kolm.yml` template + `kolm.yaml` schema. Agent: `gha-1`.
- **[W820-2]** Action: `kolm/distill-action@v1` evaluates K-Score on push; gates merge. Agent: `gha-2`.
- **[W820-3]** Auto re-distill when K-Score drops below gate. Agent: `gha-3`.
- **[W820-4]** Publish .kolm to GitHub Releases as artifact. Agent: `gha-4`.
- **[W820-5]** `kolm diff v1.2.kolm v1.3.kolm` quality-delta command. Agent: `gha-5`.

### W821 — [T2] ARTIFACT COMPOSITION / PIPELINE ORCHESTRATION

- **[W821-1]** `kolm.pipeline.yaml` schema + parser (`src/pipeline-orchestrator.js`). Agent: `pipe-1`.
- **[W821-2]** Runtime router using classifier-artifact + specialists. Agent: `pipe-2`.
- **[W821-3]** Pipeline-level K-Score (weighted by route frequency). Agent: `pipe-3`.
- **[W821-4]** Flow-diagram visualization on `/account/pipelines/:id.html`. Agent: `pipe-4`.

### W822 — [T2] A/B TESTING INFRASTRUCTURE

- **[W822-1]** Traffic splitter: per-tenant config `{version_a:ART, version_b:ART, split:0.5}`. Agent: `abtest-1`.
- **[W822-2]** Per-version metrics: K-Score, latency, fallback rate, user feedback aggregation. Agent: `abtest-2`.
- **[W822-3]** Significance: chi-squared OR bootstrap (pure-JS in `src/significance.js`). Agent: `abtest-3`.
- **[W822-4]** Auto-promote / auto-rollback based on significance + delta gates. Agent: `abtest-4`.
- **[W822-5]** Wire-into-W720: A/B comparison data feeds self-improvement. Agent: `abtest-5`.

### W823 — [T2] OPENTELEMETRY INTEGRATION (UPGRADE)

(A18 partial — existing OTLP. Add new attrs + dashboard template.)

- **[W823-1]** New span attrs: artifact_id, routing_decision, token_confidence_p50/p95, kscore_drift. Agent: `otel-1`.
- **[W823-2]** Grafana dashboard template `tools/grafana/kolm-dashboard.json`. Agent: `otel-2`.
- **[W823-3]** Alert templates for Datadog/Honeycomb/Grafana (K-Score drift, fallback spike, latency regression). Agent: `otel-3`.

### W824 — [T2] KUBERNETES-NATIVE DEPLOYMENT

- **[W824-1]** Helm chart `tools/helm/kolm/` with values.yaml. Agent: `k8s-1`.
- **[W824-2]** /ready endpoint upgrade: 200 only when artifact loaded + warmed. Agent: `k8s-2`.
- **[W824-3]** /metrics Prometheus exporter. Agent: `k8s-3`.
- **[W824-4]** HPA spec keyed on inference-queue depth (custom metric). Agent: `k8s-4`.
- **[W824-5]** Init container to pull .kolm from registry. Agent: `k8s-5`.
- **[W824-6]** Rolling-update support for zero-downtime model swaps. Agent: `k8s-6`.

---

### W825 — [T3] ARTIFACT MARKETPLACE MVP

(Existing pages at `public/marketplace/` are static. Upgrade to dynamic listings + downloads.)

- **[W825-1]** Browse + filter UI: vertical, task type, K-Score, hardware, teacher. Agent: `mkt-1`.
- **[W825-2]** Upload flow with metadata + signature verify. Agent: `mkt-2`.
- **[W825-3]** Download + run one-click via SDK. Agent: `mkt-3`.
- **[W825-4]** Transfer-learning fine-tune from marketplace artifact (wires W720 + W718). Agent: `mkt-4`.
- **[W825-5]** Rating + review system with anti-gaming (req. account history). Agent: `mkt-5`.
- **[W825-6]** Revenue share (70% publisher) on paid downloads. Agent: `mkt-6`.

### W826 — [T3] MEMORY-AWARE RUNTIME SCHEDULING

- **[W826-1]** Memory hierarchy detector: `src/runtime-placement.js` — probes GPU VRAM, system RAM, NVMe bandwidth. Agent: `mem-1`.
- **[W826-2]** Placement decision tree: VRAM-fit → full-GPU; VRAM+RAM → hybrid auto-split; overflow → NVMe-mmap. Agent: `mem-1`.
- **[W826-3]** Pre-load heuristic: analyze inference patterns → preload likely-next artifact. Agent: `mem-2`.
- **[W826-4]** Performance estimate before load: "~25 tok/s on your hardware". Agent: `mem-3`.

### W827 — [T3] CONTRASTIVE DISTILLATION (DPO-LITE)

(Partial P2 — DPO/SimPO/ORPO/KTO exist. Add response-level negative-example loss.)

- **[W827-1]** Negative-variant generator in `apps/trainer/contrastive.py` — weak model OR perturbation. Agent: `contrast-1`.
- **[W827-2]** DPO loss wired into distill loop with `--contrastive` flag. Agent: `contrast-2`.
- **[W827-3]** Benchmark suite: K-Score improvement contrastive vs SFT-only on shared eval. Agent: `contrast-3`.

### W828 — [T3] REASONING TRACE DISTILLATION

(Partial P1 — GRPO/PRM/TTC exist. Add dedicated teacher-CoT capture/replay.)

- **[W828-1]** Reasoning-model detector + extended-thinking API capture in `src/proxy.js`. Agent: `reason-1`.
- **[W828-2]** Trace format: `<think>...</think>` token structure in training rows. Agent: `reason-2`.
- **[W828-3]** Trainer extension in `apps/trainer/distill.py` for trace-aware loss. Agent: `reason-3`.
- **[W828-4]** Toggle: `--with-reasoning-traces` on `kolm distill`. Agent: `reason-4`.

### W829 — [T3] MULTIMODAL CAPTURE PIPELINE (UPGRADE)

(W454 transcript + W462 image + W464 audio redactors exist; integrate into capture lake.)

- **[W829-1]** Capture-lake extension: store image/audio/tool-use/multi-turn alongside text in `src/captures.js`. Agent: `mm-1`.
- **[W829-2]** .kolm format heterogeneous weights: text + vision-encoder + tool-use-head. Extend `src/artifact.js`. Agent: `mm-2`.
- **[W829-3]** VLM distillation support: GPT-4V → smaller VLM. Agent: `mm-3`.
- **[W829-4]** Multi-turn conversation history capture (not just single-turn). Agent: `mm-4`.

### W830 — [T3] FEDERATED DISTILLATION (INTEGRATE)

(A9 + W461 exist; integrate consortium management + verifiable DP claims.)

- **[W830-1]** Consortium management UI `/account/federated/consortium.html`: opt-in, privacy budget, members. Agent: `fed-1`.
- **[W830-2]** Membership-inference attack resistance verifier in `src/federated-mia.js`. Agent: `fed-2`.
- **[W830-3]** End-to-end consortium walkthrough doc (this IS user-requested — `docs/federated/CONSORTIUM_GUIDE.md`). Agent: `fed-3`.

### W831 — [T3] OFFLINE / AIR-GAPPED MODE (INTEGRATE)

(A33 partial — local backends exist; integrate full offline-distill + sneakernet.)

- **[W831-1]** Fully offline distillation: user-provided training data, no API captures. Agent: `airgap-1`.
- **[W831-2]** Local-only teacher via Ollama/vLLM with mandatory air-gap verification. Agent: `airgap-2`.
- **[W831-3]** Sneakernet deploy: USB transfer with Ed25519 signature verify. Agent: `airgap-3`.
- **[W831-4]** Air-gapped bakeoff harness (no-network mode). Agent: `airgap-4`.
- **[W831-5]** Deployment guide `docs/airgap/CLASSIFIED_DEPLOYMENT.md`. Agent: `airgap-5`.

---

### W832 — [T4] KOLM-META (THE META-DISTILLATION MODEL)

The data moat made real.

- **[W832-1]** Training-data spec: each distillation run emits `{capture_stats, chosen_arch, observed_kscore, compile_time, observed_failure_modes}` row to `~/.kolm/meta-training/*.jsonl`. Agent: `meta-1`.
- **[W832-2]** Trainer for kolm-meta itself: small XGBoost-style regression/classification model in `src/kolm-meta-trainer.js` (pure-JS gradient boosting OR worker shell to Python). Agent: `meta-2`.
- **[W832-3]** Weekly retrain cron. Agent: `meta-3`.
- **[W832-4]** Replace W716 TAAS rule ladder with kolm-meta inference when n>=1000 training rows; fall back to rules otherwise (honest envelope `meta_insufficient_data`). Agent: `meta-4`.

### W833 — [T4] CROSS-LINGUAL DISTILLATION

- **[W833-1]** Language distribution detector. Agent: `lingual-1`.
- **[W833-2]** Synthetic translation via teacher for underrepresented languages (stamped `synthetic_translation:true`). Agent: `lingual-2`.
- **[W833-3]** Multilingual mixture training. Agent: `lingual-3`.
- **[W833-4]** Per-language K-Score reporting in artifact manifest. Agent: `lingual-4`.

### W834 — [T4] REGULATORY COMPLIANCE TOOLKIT

- **[W834-1]** EU AI Act technical-docs auto-generator from artifact manifest. Agent: `reg-1`.
- **[W834-2]** Risk classification per task category (high-risk/limited-risk/minimal-risk). Agent: `reg-2`.
- **[W834-3]** Human-in-the-loop config: per-namespace `mandatory_human_review_threshold`. Agent: `reg-3`.
- **[W834-4]** Data governance reports: capture sources, PII handling, consent tracking. Agent: `reg-4`.
- **[W834-5]** Auto-generated model cards (HF standard). Agent: `reg-5`.
- **[W834-6]** GRC export connectors: OneTrust, ServiceNow, IBM OpenPages. Agent: `reg-6`.

### W835 — [T4] SAVINGS-BASED PRICING

- **[W835-1]** Teacher API spend baseline tracker (pre-kolm baseline period). Agent: `pricing-1`.
- **[W835-2]** Post-kolm spend tracker. Agent: `pricing-1`.
- **[W835-3]** Savings calc + 10-15% fee surface in `/account/billing`. Agent: `pricing-2`.
- **[W835-4]** Transparent dashboard "kolm saved you $X, fee is $Y". Agent: `pricing-3`.

---

## PART VI APPENDIX — DEPENDENCY GRAPH (CRITICAL EDGES)

- **W807 → W720**: confidence-router fallback events feed self-improvement queue
- **W808 → W720**: capture-poisoning quarantine gates self-improvement input
- **W809 → W821**: structured-output validation enables pipeline orchestration safely
- **W810 → W832**: external K-Score calibration is the ground truth kolm-meta predicts against
- **W811 → W815**: capture analytics clusters feed active-learning gap detection
- **W812 → W816 → W720**: failure visualization → capture recommendation → re-distill
- **W813 → W815**: drift detection feeds active-learning priority
- **W814 → W807**: speculative draft is the inverse mode of confidence routing
- **W817 → W818**: format spec must land BEFORE ecosystem-tool loaders
- **W819 → W820**: VS Code extension and GitHub Actions share `.kolm` artifact contract
- **W821 → W822**: pipeline orchestration enables per-route A/B
- **W825 → W830**: marketplace MVP needs federated trust primitives
- **W826 → W814**: memory-aware placement informs speculative-decode budget
- **W827 → W828 → W720**: contrastive + reasoning-trace distill feed quality back to self-improvement
- **W829 → W825**: marketplace must surface multimodal artifact metadata
- **W830 → W831**: consortium model overlaps with air-gapped sneakernet trust
- **W832 (kolm-meta)**: depends on W720, W810, W811, W812, W813, W815 ALL emitting training rows

## PART VI APPENDIX — REVISED EXECUTION ORDER (after W720-W722 ship)

1. **W807, W808, W809, W810** (Tier 0 — parallel where file-scope allows) — ship-blocking, JUMP queue.
2. Resume **W723-W754** with T1 items W811-W816 interleaved at natural dependency points.
3. **W755-W806** alongside T2 items W817-W824 (T2 ecosystem work parallel-friendly).
4. **W825-W831** Tier 3 (post-W806 ideally; can interleave if velocity allows).
5. **W832-W835** Tier 4 (kolm-meta requires accumulated W720/W811/W812/W813/W815 training rows — defer until pipeline running).

## PART VI APPENDIX — TOTAL QUEUE SUMMARY

| Tier | Waves | Count | Timeline |
|------|-------|-------|----------|
| In flight (W707 originals) | W720-W722 | 3 | now |
| Tier 0 (jumped) | W807-W810 | 4 | next |
| W707-original tail | W723-W806 | 84 | after T0 |
| Tier 1 | W811-W816 | 6 | interleave |
| Tier 2 | W817-W824 | 8 | interleave |
| Tier 3 | W825-W831 | 7 | post-W806 |
| Tier 4 | W832-W835 | 4 | year-1+ |
| **TOTAL REMAINING** | **W720-W835** | **116 waves** | |

(29 new waves added to the 87 originally tracked W720-W806 = 116 total remaining.)

---

*Part VI appended 2026-05-24 in response to user-shared second external-review queue. Atomic-decomposition format mirrors PART II per directive "and also have atomic levels of execution like this." Tier-0 priority-override mandate honored.*
