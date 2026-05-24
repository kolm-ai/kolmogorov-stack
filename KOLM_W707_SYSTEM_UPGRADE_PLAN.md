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

### W744 — SMART CAPTURE FILTER + INGEST DEDUP [KILLED 2026-05-24 — overlaps W808+W811+W815]

**Status: KILLED per user mandate 2026-05-24.** Reason: W808 (capture poisoning detection,
SHIPPED 2c6346a) already covers ingest-time filtering via the 3σ Welford anomaly detector +
staged_captures quarantine queue. W811 (capture analytics dashboard) covers the /account/captures
stats surface. W815 (active learning loop) covers the "identify high-information-density captures"
selection logic. Three downstream waves already do the job — keeping W744 is duplicate engineering.
Items below preserved for traceability but NOT scheduled.

- ~~**[W744-1]** "Automatically identify high-information-density captures vs low-value"~~ → covered by W815-1.
- ~~**[W744-2]** "If 500 of 10k are near-identical, compress into weighted exemplars"~~ → MinHash dedup folded into W808-staged_captures pipeline post-quarantine.
- ~~**[W744-3]** "Filter at capture time, not after"~~ → covered by W808-3 captureWithSignature pre-persistence gate.
- ~~**[W744-4]** Stats surfaced in /account/captures dashboard~~ → covered by W811-1.

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

### W750 — COPYRIGHT FILTER + CAPTURE QUARANTINE [MERGED INTO W808 2026-05-24]

**Status: MERGED into W808 per user mandate 2026-05-24.** The capture-quarantine half
shipped 2c6346a (W808: staged_captures table, /account/captures/review.html review inbox,
cmdCapturesReview --release/--quarantine, tenant-fenced quarantine queue). Remaining
copyright-filter slice promotes to a single W808-followup item below — heuristics-based
copyright detector hooks into the same staged_captures pipeline as a post-quarantine
classifier (not a separate wave).

- ~~**[W750-1]** Copyright filter on captures~~ → **[W808-followup-1]** add HEURISTIC copyright detector (regex pack for common copyrighted-content fingerprints: Disney character names, song lyric n-grams from Top-100, code with explicit copyright headers) hooked into staged_captures post-quarantine classifier. Agent: `cap-followup-1`.
- ~~**[W750-2]** Capture quarantine~~ → SHIPPED via W808 staged_captures table.
- ~~**[W750-3]** Manual review~~ → SHIPPED via W808 /account/captures/review.html + cmdCapturesReview.
- ~~**[W750-4]** Tenant-fenced quarantine queue~~ → SHIPPED via W808 tenant-fence on staged_captures reads.

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

### W775 — CONTINUOUS BACKGROUND DISTILL (THE KILLER FEATURE) [PRIORITY-JUMPED 2026-05-24]

**Priority jump per user mandate 2026-05-24:** "This is the killer feature that turns kolm
from a tool into invisible infrastructure. It depends on W720 (self-improvement ✅ shipped
6872812), W807 (confidence routing ✅ shipped 2c6346a), W813 (drift detection), W815 (active
learning). Once those four land, W775 should jump queue — don't let it sit behind carbon
footprint tracking and currency localization."

**New execution position: AFTER W813 + W815 land** (likely the next parallel-batch slot).
Removes from the W707-original tail at position ~52/84 and slots ahead of W786 (carbon
footprint), W796 (currency localization), etc.

- **[W775-1]** "Install kolm, point at API, forget about it. It captures every call." — daemon scaffold. Agent: `cont-1`.
- **[W775-2]** "Continuously evaluates whether it has enough data to distill" — readiness scorer (uses W815 active-learning signal). Agent: `cont-1`.
- **[W775-3]** "When critical mass, automatically distills/quantizes/deploys local model" — uses W720 orchestrateImprovement + W813 drift gate. Agent: `cont-2`.
- **[W775-4]** "Silently routes matching queries to local, only novel/uncertain to teacher" — uses W807 streaming router + W709 first-token entropy. Agent: `cont-2`.
- **[W775-5]** "API bill drops gradually + automatically without manual intervention" — savings telemetry surface. Agent: `cont-3`.
- **[W775-6]** `/kolm-auto-pilot.html` landing + opt-in. Agent: `cont-4`.
- **[W775-7]** Daemon process lifecycle: `kolm autopilot {start,stop,status,disable}` CLI + system-tray / login-item hook for darwin/win32/linux. Agent: `cont-5`.

### W776 — SYNTHETIC CAPTURE SELF-IMPROVEMENT [KILLED 2026-05-24 — subset of W720+W815]

**Status: KILLED per user mandate 2026-05-24.** Reason: W720 (distill self-improvement loop,
SHIPPED 6872812) already implements detectUnderperformingCaptures + orchestrateImprovement +
the regenerate-and-compare cycle. W815 (active learning loop) covers persistent-failure-mode
selection. The "synthetic capture" piece (synthetic-gen on failure modes) is a thin wrapper
over the existing W720 pipeline + W745 failure-mode dashboard — not worth a dedicated wave.
Items below preserved for traceability but NOT scheduled.

- ~~**[W776-1]** Synthetic-gen on persistent failure modes~~ → covered by W720-orchestrateImprovement + W745 input.
- ~~**[W776-2]** Loop into next distillation cycle~~ → covered by W720 self-improvement loop directly.
- ~~**[W776-3]** Telemetry: synthetic-vs-real capture ratio~~ → covered by W811-1 capture analytics dashboard.

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

### W818 — [T2] .KOLM LOADERS FOR ECOSYSTEM TOOLS  ✅ SHIPPED 2026-05-24

- **[W818-1]** ✅ llama.cpp loader PR scaffold: `tools/llama-cpp-kolm-loader/` README + patch.diff + kolm-loader.cpp documenting the .kolm zip layout (manifest/weights/runtime-policy/attestation). Agent: `eco-1`.
- **[W818-2]** ✅ Ollama loader: `tools/ollama-kolm/cli.js` Modelfile generator that reuses `src/artifact-runner.js#loadArtifact`. Agent: `eco-2`.
- **[W818-3]** ✅ Hugging Face Hub format-option PR draft: `tools/hf-hub-kolm/HF_HUB_PR_DRAFT.md` + `.gitattributes` + `huggingface_hub.kolm.py` loader stub. Agent: `eco-3`.
- **[W818-4]** ✅ vLLM model loader: `tools/vllm-kolm/vllm_kolm_loader.py` (KolmArtifactLoader + kolm:// scheme handler) + README.md. Agent: `eco-4`.
- **[W818-5]** ✅ LM Studio import-wizard spec: `tools/lm-studio-kolm/IMPORT_WIZARD_SPEC.md` (UI flow + LM Studio local model directory contract + .kolm import semantics). Agent: `eco-5`.
- ✅ Tests: `tests/wave818-ecosystem-loaders.test.js` (10 atomic tests).
- ✅ sw.js cache bumped: `kolm-v68-...-wave818-ecosystem-loaders`.

### W819 — [T2] VS CODE EXTENSION  *(SHIPPED 2026-05-24)*

(Partial: `packages/vscode-kolm-rag/` exists. Upgrade to full passive-monitor + distill workflow.)

- **[W819-1]** Passive monitor: hook Copilot/Cursor/Claude-Code suggestion-acceptance events. Agent: `vscode-1`. SHIPPED 2026-05-24 — `packages/vscode-kolm-rag/src/passive-monitor.ts` + `capture-queue.ts`.
- **[W819-2]** Pattern detection: surface "boilerplate", "tests", "docstrings" repetition clusters. Agent: `vscode-2`. SHIPPED 2026-05-24 — `packages/vscode-kolm-rag/src/pattern-detect.ts` (cosine + Jaccard, pure TS).
- **[W819-3]** Status bar: capture count + "ready to distill" CTA. Agent: `vscode-3`. SHIPPED 2026-05-24 — `packages/vscode-kolm-rag/src/status-bar.ts`.
- **[W819-4]** Post-distill routing: route matching completions to local student via in-process runtime. Agent: `vscode-4`. SHIPPED 2026-05-24 — `packages/vscode-kolm-rag/src/routing.ts` + `local-runtime.ts` (CLI shell-out with Jaccard fingerprint match).
- **[W819-5]** Settings panel: threshold, teacher preference, namespace. Agent: `vscode-5`. SHIPPED 2026-05-24 — `kolm.cluster.threshold` / `kolm.teacher.preference` / `kolm.namespace` (+ `routing.enabled`, `routing.jaccardThreshold`, `passiveMonitor.*`) in `packages/vscode-kolm-rag/package.json`. Tests: `tests/wave819-vscode-extension.test.js` (14/14 green).

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

### W822 — [T2] A/B TESTING INFRASTRUCTURE — SHIPPED 2026-05-24

- **[W822-1]** Traffic splitter: per-tenant config `{version_a:ART, version_b:ART, split:0.5}`. Agent: `abtest-1`. SHIPPED 2026-05-24 — appended W822 surface to `src/ab-router.js` (`setSplit`/`getSplit`/`pickVariant`/`listSplits` + `W822_AB_VERSION`); jsonl persistence at `~/.kolm/ab-tests/<namespace>.jsonl` with sanitized namespace + idempotency_key short-circuit; stable variant hashing on `fnv1a(tenant|namespace|request_id)`; existing W777 surface untouched (22/22 W777 tests still green).
- **[W822-2]** Per-version metrics: K-Score, latency, fallback rate, user feedback aggregation. Agent: `abtest-2`. SHIPPED 2026-05-24 — new `src/ab-metrics.js` (`aggregate`/`deltas` + `AB_FEEDBACK_WORKFLOW`/`AB_OUTCOME_WORKFLOW`); reads canonical event-store via `listEvents`; tenant + namespace defense-in-depth fence; W777 compat path so `w777_ab_outcome` payloads still roll up; p50/p95 latency from `_percentile`.
- **[W822-3]** Significance: chi-squared OR bootstrap (pure-JS in `src/significance.js`). Agent: `abtest-3`. SHIPPED 2026-05-24 — new `src/significance.js` with `chiSquared(observed, expected)` (Wilson-Hilferty p-value approx, closed-form df=1, honest zero-cell envelope) + `bootstrap({arr_a, arr_b, n_iters, statistic, alpha, seed})` (percentile CI + permutation p-value, deterministic via splitmix32 RNG); NO external deps; 2x2 closed-form chi2 verified within 0.01.
- **[W822-4]** Auto-promote / auto-rollback based on significance + delta gates. Agent: `abtest-4`. SHIPPED 2026-05-24 — new `src/ab-promote.js` (`decide` pure + `evaluate` glue); promotes when `p < 0.05 AND k_score_delta > +0.02`; rolls back on `fallback_rate_delta > +0.05 OR latency_p95_pct_delta > +25%`; emits `ab.promoted`/`ab.rolled_back` via `tryAppendAudit` (audit failure surfaces as `audit_emit_failed`, decision is never swallowed).
- **[W822-5]** Wire-into-W720: A/B comparison data feeds self-improvement. Agent: `abtest-5`. SHIPPED 2026-05-24 — new `src/ab-routes.js` (`registerAbRoutes(router, deps)`) registers 5 routes: `POST /v1/ab/configure`, `GET /v1/ab/status`, `POST /v1/ab/feedback`, `POST /v1/ab/promote`, `GET /v1/ab/metrics`; feedback fans to `deps.selfImprovement.enqueue` when wired (W720 queue) AND tags the event-store row with `kind:'w822_ab_feedback'+variant` so the detector loop picks it up regardless; router.js diff = 2 lines (import + `__registerAbRoutes_w822(r, { authMiddleware })`) — zero merge surface with WC07/WC14. Tests: `tests/wave822-ab-testing.test.js` 20/20 pass (stable variant picking, split persistence, chi-squared math, bootstrap CI shape, promote/rollback logic, route auth gate, self-improvement queue fan). sw.js bumped with `-wave822-ab-testing`.

### W823 — [T2] OPENTELEMETRY INTEGRATION (UPGRADE) — SHIPPED 2026-05-24

(A18 partial — existing OTLP. Add new attrs + dashboard template.)

- **[W823-1]** New span attrs: artifact_id, routing_decision, token_confidence_p50/p95, kscore_drift. Agent: `otel-1`. SHIPPED 2026-05-24 — extended `src/otel.js` KOLM_OTEL_ATTRS with ARTIFACT_ID/TOKEN_CONFIDENCE_P50/TOKEN_CONFIDENCE_P95/KSCORE_DRIFT + new `src/otel-attrs.js` exporting `kolmSpanAttrs(input)` envelope helper.
- **[W823-2]** Grafana dashboard template `tools/grafana/kolm-dashboard.json`. Agent: `otel-2`. SHIPPED 2026-05-24 — extended from 4 to 6 panels (K-Score over time, K-Score drift gauge, p95 latency by artifact, fallback rate stacked area, token confidence histogram, routing-decision pie). schemaVersion 38.
- **[W823-3]** Alert templates for Datadog/Honeycomb/Grafana (K-Score drift, fallback spike, latency regression). Agent: `otel-3`. SHIPPED 2026-05-24 — `tools/alerts/{datadog,honeycomb,grafana}-kolm.yaml` all share canonical thresholds (drift>0.05/1h, fallback>0.15/15min, latency>+25%/24h baseline).

### W824 — [T2] KUBERNETES-NATIVE DEPLOYMENT — SHIPPED 2026-05-24

- **[W824-1]** Helm chart `tools/helm/kolm/` with values.yaml. Agent: `k8s-1`. SHIPPED 2026-05-24 — Chart.yaml (apiVersion v2, version 0.1.0, appVersion 1.0.0), values.yaml (image, replicaCount=2, resources, persistence size=10Gi, artifactRegistry.url/secretRef), templates/{deployment,service,configmap,hpa}.yaml + _helpers.tpl + README.md + .helmignore.
- **[W824-2]** /ready endpoint upgrade: 200 only when artifact loaded + warmed. Agent: `k8s-2`. SHIPPED 2026-05-24 — new `src/k8s-readiness.js` (setArtifactLoaded/isArtifactLoaded + KOLM_ARTIFACT_LOADED env support) + `GET /ready/deep` in `src/k8s-routes.js`. Distinct from W730 `/ready` to avoid merge conflicts with concurrent agents.
- **[W824-3]** /metrics Prometheus exporter. Agent: `k8s-3`. SHIPPED 2026-05-24 — `GET /metrics/extended` aggregates event-store rows into kolm_inferences_total (counter), kolm_latency_seconds (histogram), kolm_fallback_rate (gauge), kolm_inference_queue_depth (gauge for HPA). Distinct from W730 `/metrics`.
- **[W824-4]** HPA spec keyed on inference-queue depth (custom metric). Agent: `k8s-4`. SHIPPED 2026-05-24 — `templates/hpa.yaml` uses External metric type with selector matchLabels:{app:kolm} and target AverageValue=50.
- **[W824-5]** Init container to pull .kolm from registry. Agent: `k8s-5`. SHIPPED 2026-05-24 — `templates/deployment.yaml` initContainer runs `sh -c "kolm pull $KOLM_ARTIFACT_ID --to /artifacts/"` before main container, with KOLM_ARTIFACT_REGISTRY_URL + secretKeyRef-resolved token.
- **[W824-6]** Rolling-update support for zero-downtime model swaps. Agent: `k8s-6`. SHIPPED 2026-05-24 — strategy RollingUpdate maxSurge=1 maxUnavailable=0 + preStop hook `sleep ${drainSeconds} && kill -TERM 1` + terminationGracePeriodSeconds=60 + artifactId pod annotation triggers rolling restart on artifact swap.

Tests: `tests/wave824-k8s.test.js` (22 tests covering chart files, route handlers, version stamps, env-var readiness path, queue-depth gauge round-trip, sw.js wave-token regex). Router diff = 2 lines (import + call to `__registerK8sRoutes_w824(r)`) to avoid conflicts with WC07/WC14/W822.

---

### W825 — [T3] ARTIFACT MARKETPLACE MVP [SHIPPED 2026-05-24]

(Existing pages at `public/marketplace/` are static. W825 upgrades to dynamic listings + signed uploads + paid downloads + anti-gaming rating + 70/30 revenue share. W737 already shipped the curated catalog + reviews + computeRoyalty in `src/marketplace.js`; W825 is the publisher-driven MVP that sits alongside W737 under the same `/v1/marketplace/*` namespace, distinguished by route + storage. Single-call mount via `src/marketplace-routes.js` registerMarketplaceRoutes(r) keeps the router.js diff to two lines, avoiding collisions with parallel WC07/WC14/W822/W824 agents.)

- **[W825-1]** Browse + filter UI: vertical, task type, K-Score, hardware, teacher. Agent: `mkt-1`. **SHIPPED 2026-05-24** — `src/marketplace-w825.js` `listListings({vertical, task_type, k_score_min, hardware, teacher, paid, sort_by, page, limit})` over `~/.kolm/marketplace/listings.jsonl` (later-line-wins upsert); `W825_VERTICALS`/`W825_TASK_TYPES`/`W825_HARDWARE_TARGETS`/`W825_SORT_MODES` frozen enums. `public/marketplace/index.html` rebuilt as a live JS fetcher (`/v1/marketplace/facets` populates sidebar selects, `/v1/marketplace/listings` renders the grid). Brand lock preserved byte-for-byte: eyebrow "Open-source AI workbench" + H1 "Frontier AI on your own infrastructure."
- **[W825-2]** Upload flow with metadata + signature verify. Agent: `mkt-2`. **SHIPPED 2026-05-24** — `POST /v1/marketplace/upload` auth-gated; body `{id, title, vertical, task_type, hardware_targets[], k_score, teacher_model, artifact_uri, manifest_sha256, signature_b64, public_key_pem, paid, price_micro_usd}`. Routes calls `_verifyManifestSignature()` → `src/ed25519.js verify(public_key_pem, manifest_sha256, sigB64Url)`; HTTP **400 signature_invalid** on bad sig (`reason ∈ {missing_signature, missing_public_key, invalid, verify_threw}`). `publisher_tenant_id` is FORCED from `req.tenant_record.id` (W411 tenant fence) so a tenant cannot register under another publisher's name. Honest envelope on success: `201 {ok:true, listing}`. Audit row via `tryAppendAudit({op:'marketplace.upload'})` best-effort.
- **[W825-3]** Download + run one-click via SDK. Agent: `mkt-3`. **SHIPPED 2026-05-24** — `GET /v1/marketplace/download/:id` auth-gated; streams `listing.artifact_uri` bytes when local. **402 payment_required** when `listing.paid=true` AND `_tenantHasEntitlement(tenant, listing)===false` (self-publisher always entitled; non-paid always entitled; plan != 'free' && != 'anon' entitled; explicit `tenant.entitlements[listing.id]===true` entitled). Increments `listing.downloads` via `recordDownload()` AND emits per-tenant `recordDownloadEvent()` (consumed by the anti-gaming rate gate). Paid downloads emit a `kolm_marketplace_revenue` event row (`recordRevenue`) for the payout cycle. Response headers `X-Kolm-Manifest-Sha256`, `X-Kolm-Listing-Id`, `X-Kolm-Marketplace-Version`.
- **[W825-4]** Transfer-learning fine-tune from marketplace artifact (wires W720 + W718). Agent: `mkt-4`. **SHIPPED 2026-05-24** — `src/marketplace-finetune.js` `finetuneFromMarketplace({artifact_id, tenant_id, captures_namespace, k_target, max_steps})`. Validates the listing exists (404 `unknown_artifact_id` envelope on miss), copies `listing.artifact_uri` → `~/.kolm/artifacts/<artifact_id>.kolm` (skips remote URIs honestly with `copy_skipped_reason`), then **queues** a `kolm_marketplace_finetune_queued` event for the W381 distill worker to pick up on its next cycle. Returns `{ok:true, run_id, base_artifact_id, status:'queued', copied_to, pipeline_module:'./distill-pipeline.js', base_artifact_flag:'--base-artifact-id'}`. Honesty contract: status is `'queued'` (NEVER 'running'/'completed') because the real LoRA fine-tune is a long-running worker, not an inline call. `POST /v1/marketplace/finetune` returns `202`.
- **[W825-5]** Rating + review system with anti-gaming (req. account history). Agent: `mkt-5`. **SHIPPED 2026-05-24** — `src/marketplace-ratings.js` `rate({tenant, listing_id, stars, review_text})` writes to `~/.kolm/marketplace/ratings.jsonl` (later-row-wins per `(listing_id, tenant_id)`). **Two anti-gaming gates** (both throw `Error.code='RATING_FORBIDDEN'`, HTTP 403): (1) `_accountAgeDays(tenant) >= MIN_ACCOUNT_AGE_DAYS (=7)` blocks brand-new accounts spinning up fake reviews; (2) `tenantHasDownloaded({listing_id, tenant_id}) === true` blocks "review without using it" gaming. Pre-W411 tenants with no `created_at` are treated as old (age=Infinity) rather than blocked forever. `getRatings(listing_id)` dedupes by tenant and recomputes `{rating_avg, rating_count, ratings}`. `rate()` calls `updateRatingAggregate()` so the listing row stays consistent. Routes: `POST /v1/marketplace/rate`, `GET /v1/marketplace/ratings/:id` (public read).
- **[W825-6]** Revenue share (70% publisher) on paid downloads. Agent: `mkt-6`. **SHIPPED 2026-05-24** — `src/marketplace-payouts.js` hard-codes `PUBLISHER_SHARE = 0.70` + `PLATFORM_SHARE = 0.30` (NEVER read from runtime config — same contract W737 pins via `W737_PUBLISHER_SHARE`). `calcPayout(listing, total_revenue_micro_usd)` floor-rounds publisher = `floor(0.70 * rev)` and assigns platform = `rev - publisher` so `publisher_micro + platform_micro = revenue_micro` EXACTLY (no rounding leak). `payoutCycle(period)` aggregates `provider='kolm_marketplace_revenue'` event rows filtered by YYYY-MM, emits one per-listing audit row (`op='marketplace.payout'` via `tryAppendAudit`), and returns `{ok:true, period, dispatched:false, rows[]}`. **NO STRIPE PAYOUT WIRED** — honestly labelled as a forecast surface (`dispatched:false` + `forecast_note` in envelope) so a CI gate can confirm no real money moved. `POST /v1/marketplace/payout-cycle` returns the cycle envelope.

**Files:**
- `src/marketplace-w825.js` (data layer — listings.jsonl + filter/sort/upsert)
- `src/marketplace-ratings.js` (rate + anti-gaming gates + ratings aggregate)
- `src/marketplace-payouts.js` (calcPayout + payoutCycle 70/30 split)
- `src/marketplace-finetune.js` (transfer-learning queue → distill-pipeline)
- `src/marketplace-routes.js` (registerMarketplaceRoutes — 8 routes)
- `src/router.js` (+1 import line, +1 call line)
- `public/marketplace/index.html` (live JS fetcher, brand lock preserved)
- `tests/wave825-marketplace.test.js` (17 tests covering CRUD, filter, sort, sig-fail, paid 402, free stream, anti-gaming 403, payout split, queued finetune, router wiring, sw.js wave token, HTML brand+anchors)
- `public/sw.js` cache token bumped `-wave825-marketplace-mvp`

Routes added (all under `/v1/marketplace/*`, distinct verbs/paths from W737):
- `GET  /v1/marketplace/listings` (public browse)
- `GET  /v1/marketplace/facets` (public enum set)
- `POST /v1/marketplace/upload` (auth + signed)
- `GET  /v1/marketplace/download/:id` (auth, 402 on paid+no-entitlement)
- `POST /v1/marketplace/finetune` (auth, returns queued envelope)
- `POST /v1/marketplace/rate` (auth, 403 on anti-gaming gate)
- `GET  /v1/marketplace/ratings/:id` (public)
- `POST /v1/marketplace/payout-cycle` (auth, forecast-only, dispatched:false)

### W826 — [T3] MEMORY-AWARE RUNTIME SCHEDULING [SHIPPED 2026-05-24]

- **[W826-1]** Memory hierarchy detector: `src/runtime-placement.js` — probes GPU VRAM, system RAM, NVMe bandwidth. Agent: `mem-1`. SHIPPED 2026-05-24 — `detectMemoryHierarchy()` via `src/devices.js` + `node:os` + 100MB write/read benchmark; `KOLM_NO_DISK_PROBE=1` skips the probe.
- **[W826-2]** Placement decision tree: VRAM-fit → full-GPU; VRAM+RAM → hybrid auto-split; overflow → NVMe-mmap. Agent: `mem-1`. SHIPPED 2026-05-24 — `placementDecision({artifact_size_gb, hierarchy})` with 4-branch tree (`full_gpu`/`hybrid`/`nvme_mmap`/`cpu_only`); 0.9 VRAM headroom, 0.5 RAM half-budget; hybrid emits `split_ratio = vram_free/artifact_size`.
- **[W826-3]** Pre-load heuristic: analyze inference patterns → preload likely-next artifact. Agent: `mem-2`. SHIPPED 2026-05-24 — `src/runtime-preload.js` `analyzeInferencePatterns({tenant, namespace, window_hours})` builds Markov transition matrix from event-store, returns top-3 + confidence (0..1 ramp from 5 to 50 transitions); `preloadDecision({current_artifact_id, hierarchy, top_artifacts})` → `[{action: warm_to_vram|mmap_only|skip}]`.
- **[W826-4]** Performance estimate before load: "~25 tok/s on your hardware". Agent: `mem-3`. SHIPPED 2026-05-24 — `src/runtime-perf-estimate.js` `estimatePerformance({artifact_id, placement, hierarchy})` → `{tok_per_sec_estimate, ttft_ms_estimate, source: curve_fit|cached_run|fallback}`; `tok/s ≈ K_quant/sqrt(params_b) × placement_penalty` (1.0/0.4/0.1/0.05); `params_b` from `src/models.js` MODELS registry.

**Files:** `src/runtime-placement.js`, `src/runtime-preload.js`, `src/runtime-perf-estimate.js`, `tests/wave826-runtime-placement.test.js` (17 tests). `public/sw.js` cache bumped `-wave826-runtime-placement`. **Pure library code** — no new routes; TODO wire-up points marked in each file pointing to `src/runtime.js getCompiled()` for the future runtime integration.

### W827 — [T3] CONTRASTIVE DISTILLATION v2: TOKEN-LEVEL DPO [SHIPPED 2026-05-24]

**Renamed per user mandate 2026-05-24.** W714 already shipped response-level contrastive
distillation (negative-variant generator + response-level DPO loss + `--contrastive` flag).
W827 is the v2 UPGRADE that adds the token-level extension W714 doesn't have: per-token
positive/negative logit attribution for fine-grained reward shaping (vs the response-level
whole-output reward in W714). Scope is reduced to ONLY the token-level extension —
infrastructure already exists in W714.

- ~~**[W827-1]** Negative-variant generator~~ → SHIPPED in W714-1.
- ~~**[W827-2]** Response-level DPO loss~~ → SHIPPED in W714-2.
- **[W827-3]** TOKEN-LEVEL DPO extension: per-token positive-vs-negative logit attribution in `apps/trainer/contrastive_distill.py` (extends, does not replace, W714-2). Agent: `contrast-tlv-1`. **SHIPPED 2026-05-24** — `token_level_dpo_loss(logits_pos, logits_neg, target_ids, attention_mask, beta=0.1)` added; trainer loop branches on `contrastive_token_level`; run-meta records `contrastive_token_level_version=w827-v1`.
- **[W827-4]** New flag `--contrastive-token-level` (additive to existing `--contrastive`). Agent: `contrast-tlv-1`. **SHIPPED 2026-05-24** — argparse arg + `--dpo-beta`; CLI `kolm distill --contrastive --contrastive-token-level` plumbs `KOLM_CONTRASTIVE_TOKEN_LEVEL=1` env + argv to Python worker.
- **[W827-5]** Benchmark: token-level vs response-level K-Score delta on shared eval (must show > 1% improvement to ship — honest gate). Agent: `contrast-tlv-2`. **SHIPPED 2026-05-24** — `apps/trainer/bench_contrastive_token.py` emits `{response_level_kscore, token_level_kscore, delta, ship_decision: 'SHIP'|'NO_SHIP', threshold: 0.01}` single-line; without `--data` prints `BENCH_STUB_REQUIRES_REAL_DATA` banner + zeros + forced NO_SHIP.

**Lock-in: `tests/wave827-token-dpo.test.js` (≥10 tests).**

### W828 — [T3] REASONING TRACE DISTILLATION v2: AUTO-DETECT + TRACE-AWARE LOSS [RENAMED 2026-05-24] — SHIPPED 2026-05-24

**Renamed per user mandate 2026-05-24.** W713 already shipped reasoning-trace distillation
(Anthropic thinking blocks + o1 reasoning_tokens capture + `<think>...</think>` training rows +
`--no-cot` off-switch). W828 is the v2 UPGRADE that adds the auto-detection and trainer-side
trace-aware loss W713 doesn't have. Scope reduced to ONLY the new pieces — infrastructure
already exists in W713.

- ~~**[W828-1]** Reasoning-model detector + extended-thinking API capture~~ → PARTIALLY SHIPPED in W713-1 (manual config). W828 adds: AUTO-DETECT — sniff response shape to identify reasoning model without explicit per-call config. Agent: `reason-v2-1`. **SHIPPED** — `autoDetectReasoningCapability(response)` + `autoExtractReasoningTrace(response, hintProvider)` in `src/capture.js`; sniffs Anthropic `content[].type === 'thinking'`, OpenAI `usage.completion_tokens_details.reasoning_tokens > 0`, DeepSeek `choices[0].message.reasoning_content`, Gemini `candidates[0].content.parts[*].thinking`; wired into both capture paths in `src/router.js`.
- ~~**[W828-2]** Trace format `<think>...</think>`~~ → SHIPPED in W713-2 + W713-3.
- **[W828-3]** TRACE-AWARE LOSS extension in `apps/trainer/distill.py` — weighted loss term over the trace tokens separate from the answer tokens (forces student to actually learn reasoning structure, not just final answer). Agent: `reason-v2-2`. **SHIPPED** — `trace_aware_loss(logits, target_ids, trace_mask, attention_mask, w=0.5)` returns `(1-w)*answer_loss + w*trace_loss`; `_build_trace_mask_from_text` tags `<think>..</think>` spans on dataset rows; trainer's `compute_loss` branches on `rt_loss_w > 0` so weight=0.0 is byte-identical to the W713 baseline.
- **[W828-4]** New flag `--reasoning-trace-loss-weight 0.0..1.0` (additive to existing `--with-reasoning-traces`). Agent: `reason-v2-2`. **SHIPPED** — `cli/kolm.js` parses `--reasoning-trace-loss-weight`, clamps to [0,1], plumbs into worker via `KOLM_REASONING_TRACE_LOSS_WEIGHT` env, AND echoes into POST body as `reasoning_trace_loss_weight` for run-meta provenance. `distill.py` argparser reads the env when the flag is omitted.
- **[W828-5]** Benchmark: trace-aware vs answer-only K-Score delta on reasoning-heavy eval (MMLU-Pro / GSM8K / MATH) — must show > 2% improvement to ship. Agent: `reason-v2-3`. **SHIPPED** — `apps/trainer/bench_trace_aware.py` scaffold, threshold 0.02, prints `BENCH_STUB_REQUIRES_REAL_DATA` banner without `--data`, deterministic provenance-bound stub kscores otherwise.

### W829 — [T3] MULTIMODAL CAPTURE PIPELINE (UPGRADE) — SHIPPED 2026-05-24

(W454 transcript + W462 image + W464 audio redactors exist; integrate into capture lake.)

- **[W829-1] SHIPPED 2026-05-24** Capture-lake extension: `src/captures.js` (new module) — `recordMultimodalCapture` + `recordMultiTurnCapture` writing JSONL under `~/.kolm/captures/<namespace>/multimodal/<kind>/<hash>.jsonl` and `~/.kolm/captures/<namespace>/multi-turn/<conversation_id>.jsonl`; `KOLM_NO_RAW_MULTIMODAL=1` strips `data_uri` while preserving hash binding. Agent: `mm-1`.
- **[W829-2] SHIPPED 2026-05-24** `.kolm` format heterogeneous weights: `addHeterogeneousWeights(builder, {text_weights, vision_encoder, tool_use_head})` extends `src/artifact.js` to write `weights/text/`, `weights/vision-encoder/`, `weights/tool-use-head/` subdirs + `manifest.heterogeneous_weights = {present_modalities, vision_encoder_kind, tool_use_head_kind, ...}` block (closed-set kind validation). Agent: `mm-2`.
- **[W829-3] SHIPPED 2026-05-24** VLM distillation support: `src/vlm-distill.js` `vlmDistillRun({teacher,student_model,dataset_captures})` enqueues jobs at `~/.kolm/vlm-distill/<run_id>.json`. Honest envelope when `KOLM_VLM_TEACHER_API_KEY` is unset → `{ok:true, status:'queued', real_run:false, missing_env:'KOLM_VLM_TEACHER_API_KEY'}`. Teachers: gpt-4v / claude-3-vision / gemini-vision. Agent: `mm-3`.
- **[W829-4] SHIPPED 2026-05-24** Multi-turn conversation history capture: `recordMultiTurnCapture({tenant,namespace,conversation,conversation_id,parent_message_id?})` — append-only JSONL, supports full-snapshot or incremental write patterns. Agent: `mm-4`.

Routes (mounted via `src/multimodal-pipeline-routes.js` → `registerMultimodalPipelineRoutes(app)` — one import + one call in `src/router.js` to avoid merge conflicts with concurrent agents):
- `POST /v1/captures/multimodal`
- `POST /v1/captures/multi-turn`
- `POST /v1/vlm-distill/run`
- `GET /v1/vlm-distill/runs`

Tests: `tests/wave829-multimodal-pipeline.test.js` (12 atomic tests covering path layout, raw-strip toggle, multi-turn append, heterogeneous-weights manifest block, honest VLM envelope, route registration + auth gate, sw.js wave-token regex, backward-compat of existing capture modules).

### W830 — [T3] FEDERATED DISTILLATION (INTEGRATE) — SHIPPED 2026-05-24

(A9 + W461 exist; integrate consortium management + verifiable DP claims.)

- **[W830-1] SHIPPED 2026-05-24** Consortium management UI `/account/federated/consortium.html`: opt-in card + privacy budget panel (epsilon spent vs allocated bar) + member list (contribution_count + last_share_at) + active aggregations table. Vanilla JS + fetch; reuses `/account` design tokens; brand-lock H1 "Frontier AI on your own infrastructure." with "Open-source AI workbench" eyebrow. Agent: `fed-1`.
- **[W830-2] SHIPPED 2026-05-24** Membership-inference attack resistance verifier `src/federated-mia.js` — `calibrateMIA({shadow_models, train_set, holdout_set})` returns honest `{ok:false, error:'mia_requires_shadow_models', install_hint}` when shadow_models < 3; `verifyArtifactMIAResistance({artifact_id, test_inputs, p_threshold})` returns `{ok, attack_auc, verdict:'passing'|'leaking', ...}`; `dpEpsilonAudit({artifact_manifest})` reads `manifest.privacy.dp_epsilon` and recomputes via Gaussian-mechanism formula `epsilon = sensitivity * sqrt(2*ln(1.25/delta)) / sigma` — claim envelope carries `{claimed_epsilon, recomputed_epsilon, verified, audit_method, audit_digest}`. Agent: `fed-2`.
- **[W830-3] SHIPPED 2026-05-24** End-to-end consortium walkthrough doc `docs/federated/CONSORTIUM_GUIDE.md` updated with route table + cURL examples for all 4 base routes (opt-in, opt-out, members, budget, aggregations); covers prereqs / opt-in flow / sharing approvals (cross-link to W461) / aggregation cadence / privacy budget math / audit trail / opting out. Agent: `fed-3`.

Routes (mounted via `src/federated-consortium-routes.js` → `registerFederatedConsortiumRoutes(app)` — one import + one call in `src/router.js` to avoid merge conflicts with concurrent WC07/WC14/W825/W829 agents):
- `POST /v1/federated/consortium/opt-in`
- `POST /v1/federated/consortium/opt-out`
- `GET  /v1/federated/consortium/members`
- `GET  /v1/federated/consortium/budget`
- `GET  /v1/federated/consortium/aggregations`
- `POST /v1/federated/consortium/verify-mia`

All routes tenant-fenced via `req.tenant_record.id`. Persistence: `~/.kolm/federated-consortium/<consortium_id>.json` (single-tenant view) + `~/.kolm/federated-consortium/_aggregations.jsonl` (system-wide). Tests: `tests/wave830-federated-consortium.test.js` (13 atomic tests covering mia exports, honest-stub paths, dpEpsilonAudit Gaussian recompute, opt-in JSON shape, budget math, route registration + auth gating on all 6 routes, brand-lock H1, cURL example count, vercel rewrite, sw.js regex+threshold). sw.js slug: `wave830-federated-consortium`.

### W831 — [T3] OFFLINE / AIR-GAPPED MODE (INTEGRATE) — SHIPPED 2026-05-24

(A33 partial — local backends exist; integrate full offline-distill + sneakernet.)

- **[W831-1]** Fully offline distillation: user-provided training data, no API captures. Agent: `airgap-1`. SHIPPED 2026-05-24 — `src/airgap-distill.js` (`offlineDistill` + `getOfflineDistillStatus`). Three guards in order: (a) `KOLM_TEACHER_API_KEY` env absent, (b) all paths absolute + local + existent, (c) `fetch('https://example.com', {signal:AbortSignal.timeout(50)})` MUST fail. Returns `{ok, run_id, status:'queued', airgap_verified:true, verification_method:'no_network_dial'}`; persists run spec atomically to `~/.kolm/airgap-distill-runs/<run_id>.json`.
- **[W831-2]** Local-only teacher via Ollama/vLLM with mandatory air-gap verification. Agent: `airgap-2`. SHIPPED 2026-05-24 — `src/airgap-teacher.js` (`verifyTeacherIsLocal` + `PolicyBlockError` + `isTeacherLocal`). Allow-list: 127.0.0.1 / localhost / ::1 / 0.0.0.0 / 127.* range / `unix:` / `file:`. Anything else throws `PolicyBlockError{code:'teacher_not_local'}`. Tighter than W779's wrapFetch because air-gap mode does NOT trust `KOLM_LOCAL_TEACHER_URL` as an override.
- **[W831-3]** Sneakernet deploy: USB transfer with Ed25519 signature verify. Agent: `airgap-3`. SHIPPED 2026-05-24 — `src/airgap-sneakernet.js` (`createSneakernetBundle` + `verifySneakernetBundle` + `generateEd25519Keypair`). Tar layout: `artifact.kolm` + `manifest.json` + `signature.bin` (raw 64-byte Ed25519 sig) + `kolm-airgap-receipt.json`. Detached signature over `(artifact_bytes || 0x00 || canonical(manifest))`; verify returns `{ok, artifact_path, signature_ok, recipient_ok, trustworthy, manifest, signer_fpr, recipient_fpr}`. Uses `crypto.sign/verify(null, ..., 'ed25519')` from node:crypto — no third-party deps.
- **[W831-4]** Air-gapped bakeoff harness (no-network mode). Agent: `airgap-4`. SHIPPED 2026-05-24 — `src/airgap-bakeoff.js` (`airgapBakeoff`). Same dial-failure guard as W831-1; loads jsonl dataset (`{input, expected_output}`); per-artifact loop invokes a caller-supplied `invokeFn` (defaults to a deterministic stub); ranks by Jaccard token-overlap mean score with stable tie-break. Aborts BEFORE any artifact invocation when network is reachable.
- **[W831-5]** Deployment guide `docs/airgap/CLASSIFIED_DEPLOYMENT.md`. Agent: `airgap-5`. SHIPPED 2026-05-24 — covers threat model, hardware requirements (no NIC / firewall-blocked), provisioning workflow (sneakernet only), key rotation, audit chain, decommissioning; references real W831 commands (`kolm sneakernet pack/verify/extract`, `kolm doctor airgap`, `kolm audit verify`).

**W831 integration surface (modular mount)**:
- `src/airgap-routes.js` (`registerAirgapRoutes` / `mountAirgapRoutes`) — 6 routes all auth-gated + tenant-fenced: `POST /v1/airgap/distill/run`, `GET /v1/airgap/distill/status/:id`, `POST /v1/airgap/sneakernet/bundle`, `POST /v1/airgap/sneakernet/verify`, `POST /v1/airgap/bakeoff`, `GET /v1/airgap/doctor` (returns `{ok, network_reachable, teacher_local, signing_key_present, ...}`).
- `src/router.js` diff = 2 lines (import + one-line `__registerAirgapRoutes_w831(r)` call). No merge conflict with parallel W830/W832 agents.
- `public/sw.js` cache bumped with `-wave831-airgap` suffix.
- Tests: `tests/wave831-airgap.test.js` (14 tests; covers all 12 spec pins + 2 bonus route-shape tests). W604 regex check on all four W831 module version stamps (`/^w831-/`, never explicit equality).

---

### W832 — [T4] KOLM-META (THE META-DISTILLATION MODEL)

The data moat made real.

- **[W832-1]** Training-data spec: each distillation run emits `{capture_stats, chosen_arch, observed_kscore, compile_time, observed_failure_modes}` row to `~/.kolm/meta-training/*.jsonl`. Agent: `meta-1`.
- **[W832-2]** Trainer for kolm-meta itself: small XGBoost-style regression/classification model in `src/kolm-meta-trainer.js` (pure-JS gradient boosting OR worker shell to Python). Agent: `meta-2`.
- **[W832-3]** Weekly retrain cron. Agent: `meta-3`.
- **[W832-4]** Replace W716 TAAS rule ladder with kolm-meta inference when n>=1000 training rows; fall back to rules otherwise (honest envelope `meta_insufficient_data`). Agent: `meta-4`.

### W833 — [T4] CROSS-LINGUAL DISTILLATION — SHIPPED 2026-05-24

(Foundation enhancements on top of W774's cross-lingual eval / bakeoff /
balanced sampler. W774 owns selection + scoring; W833 owns detection
distribution + synthesis + mixture iterator + per-language manifest
annotation.)

- **[W833-1]** Language distribution detector. Agent: `lingual-1`. SHIPPED 2026-05-24 — `src/lingual-detect.js` (`detectLanguage(text)` returns `{lang:'en'|'es'|'zh'|'ja'|'ko'|'fr'|'de'|'pt'|'ru'|'ar'|'hi'|'unknown', confidence:0..1, source:'char_ngram'|'script_only'}` via Unicode script-class first then baked-in top-15-trigram-per-Latin-lang scorer; `distributionByLang(captures)` returns `{by_lang, total, underrepresented:[{lang, ratio, target_ratio:0.05}]}`). `SUPPORTED_LANGS_W833` Object.freeze()-d 11-entry contract.
- **[W833-2]** Synthetic translation via teacher for underrepresented languages (stamped `synthetic_translation:true`). Agent: `lingual-2`. SHIPPED 2026-05-24 — `src/lingual-synthesize.js` (`synthesizeForUnderrepresented({tenant, namespace, target_lang, count, teacher:'anthropic'|'openai'|'local'})`). Honest envelope `{ok:false, error:'no_teacher_configured', install_hint:'Set KOLM_TEACHER_API_KEY or use teacher:local', requested_count, generated_count:0}` when teacher env missing. Every generated row stamped `synthetic_translation:true` + source_lang + target_lang + synth_provider + synth_model + synth_at. `local` teacher is deterministic [target_lang]-prefixed echo for CI/test.
- **[W833-3]** Multilingual mixture training. Agent: `lingual-3`. SHIPPED 2026-05-24 — `src/lingual-mixture.js` (`buildMixture({captures, lang_weights:{en:0.5, es:0.2, zh:0.3}})` returns stateful per-call iterator drawing rows by weighted random pick with live-weight renormalization on exhaustion; `with_replacement` option for infinite stream; `autoBalanceWeights(distributionByLang_output)` floors underrepresented langs at 0.05 each, deflates over-floor langs proportionally, renormalizes to sum 1.0).
- **[W833-4]** Per-language K-Score reporting in artifact manifest. Agent: `lingual-4`. SHIPPED 2026-05-24 — `src/lingual-manifest.js` (`annotateManifest({manifest, per_lang_kscores:{en:0.78, es:0.65}, overall_lang_distribution?, gated_at_n:30})` returns NEW manifest with `per_lang_kscore` block (copy-on-write, never mutates input) + `overall_lang_distribution` snapshot block; sanitizes non-finite/out-of-range scores into `dropped_lang_keys`; honest `no_per_lang_scores:true` sentinel when nothing valid survived. `readPerLangKScores(manifest)` returns `{ok:true, by_lang, languages_reported, gated_at_n, ...}` or honest `{ok:false, error:'no_per_lang_kscore_block'|'manifest_required'}`).

**W833 integration surface (modular mount)**:
- `src/lingual-routes.js` (`registerLingualRoutes` / `mountLingualRoutes`) — 4 routes all auth-gated + W411 tenant-fenced (defense-in-depth `listEvents` re-filter): `GET /v1/lingual/distribution?namespace=X`, `POST /v1/lingual/synthesize {target_lang, count, teacher}`, `POST /v1/lingual/mixture/auto-balance`, `GET /v1/lingual/manifest/:artifact_id`. Synthesize route defaults `write:false` so hosted calls return rows without auto-persisting — the operator explicitly POSTs to `/v1/capture/log` to commit.
- `src/router.js` diff = 2 lines (import + one-line `__registerLingualRoutes_w833(r)` call). No merge conflict with parallel W830/W832/W834/W835 agents.
- `cli/kolm.js` — `cmdW833Lingual` dispatcher wires `kolm lingual {detect <text>|distribution --namespace X|synthesize --target es --count N|mixture --weights en=0.5,es=0.3,zh=0.2}`; case statement + `COMPLETION_VERBS.push('lingual')` + `COMPLETION_SUBS.lingual = ['detect','distribution','synthesize','mixture']` all shipped.
- `public/sw.js` cache bumped with `-wave833-cross-lingual-v2` suffix.
- Tests: `tests/wave833-cross-lingual.test.js` — 19 tests passing (18 spec pins + 1 bonus version-stamp consistency check). All 4 routes verified 401-without-auth + 200-with-auth via in-process `buildRouter()` mount. W604 family regex (`wave(\d{3,4})`) + threshold check, never explicit sibling array.

### W834 — [T4] REGULATORY COMPLIANCE TOOLKIT — SHIPPED 2026-05-24

- **[W834-1]** EU AI Act technical-docs auto-generator from artifact manifest. Agent: `reg-1`. SHIPPED 2026-05-24 — `src/reg-eu-aiact-docs.js` (`generateTechnicalDocs` emits markdown/HTML across 6 Annex IV sections; missing fields surface as `<!-- MISSING: <field> — <action> -->` HTML comments greppable in rendered output).
- **[W834-2]** Risk classification per task category (high-risk/limited-risk/minimal-risk). Agent: `reg-2`. SHIPPED 2026-05-24 — `src/reg-risk-classify.js` (`classifyArtifactRisk` over `INTENDED_USE_CATALOG` covering 26 intended-use enumerators across {prohibited, high_risk, limited_risk, minimal_risk}; each tier cites Article 5 / Annex III / Article 50 / Recital 27 basis + emits gates_required).
- **[W834-3]** Human-in-the-loop config: per-namespace `mandatory_human_review_threshold`. Agent: `reg-3`. SHIPPED 2026-05-24 — `src/reg-hil.js` (`setMandatoryHumanReviewThreshold` / `getHilConfig` / `shouldEscalate`; threshold is CONFIDENCE PROBABILITY in [0,1] not nats, distinct from W766's `kolm_human_review_threshold` provider tag; uses `kolm_reg_hil_confidence_threshold` event-store provider).
- **[W834-4]** Data governance reports: capture sources, PII handling, consent tracking. Agent: `reg-4`. SHIPPED 2026-05-24 — `src/reg-data-governance.js` (`capturesProvenanceReport` buckets rows by source enum `[gateway, manual, connector, unknown_source]` + `generateGovernanceReport` emits markdown with missing-attachment HTML comments; calendar-month period filter via YYYY-MM string).
- **[W834-5]** Auto-generated model cards (HF standard). Agent: `reg-5`. SHIPPED 2026-05-24 — `src/reg-model-card-extended.js` extends W768's `buildModelCard` with three regulator-facing extension blocks: `per_language_kscore` (W760 Wilson-floor n>=30), `per_risk_category_gate_status` (8-gate readiness attestation), and `teacher_attribution` (HF derivative-model convention).
- **[W834-6]** GRC export connectors: OneTrust, ServiceNow, IBM OpenPages. Agent: `reg-6`. SHIPPED 2026-05-24 — `src/reg-grc-connectors.js` (`exportToOneTrust` / `exportToServiceNow` / `exportToIBMOpenPages` / `exportByVendor` dispatcher; honest creds-check returns `{ok:false, error:'no_grc_creds', install_hint, export_payload}` when `KOLM_GRC_<VENDOR>_API_KEY` is missing — payload STILL computed for manual upload).

**W834 integration surface (modular mount per W83x concurrent-edit standing directive)**:
- `src/reg-routes.js` (`registerRegRoutes`) mounts 7 auth-gated tenant-fenced routes: `POST /v1/reg/eu-aiact-docs`, `POST /v1/reg/classify-risk`, `POST /v1/reg/hil/threshold` (requires `confirm:true`), `GET /v1/reg/hil/threshold?namespace=X`, `GET /v1/reg/data-governance?namespace=X&period=YYYY-MM`, `POST /v1/reg/model-card`, `POST /v1/reg/grc-export`.
- `src/router.js` diff = 2 lines (one import + one-line `__registerRegRoutes_w834(r)` call). No merge conflict with parallel W83x agents.
- `public/sw.js` cache bumped with `-wave834-regulatory` suffix; W604 regex+threshold (`wave(\d{3,4})` ≥ 834), not explicit array.
- Tests: `tests/wave834-regulatory.test.js` — 14+ tests covering all 6 sub-items + route registration + W604 regex check + sw.js bump.
- Version stamp `w834-v1` across all six modules — W604 regex pattern `/^w834-/` plus literal pins.

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

## PART VI APPENDIX — TOTAL QUEUE SUMMARY (updated 2026-05-24 with dup cleanup + WF/WC waves)

| Tier | Waves | Count | Timeline |
|------|-------|-------|----------|
| SHIPPED 2026-05-24 (W707-originals) | W720-W722 | 3 | done |
| SHIPPED 2026-05-24 (Tier 0) | W807-W810 | 4 | done |
| SHIPPED 2026-05-24 (Tier 2) | W819 (VS Code passive-monitor + distill) | 1 | done |
| W707-original tail (minus dups) | W723-W806 (less W744, W750, W776) | 81 | after T0 |
| Tier 1 | W811-W816 | 6 | interleave |
| Tier 2 | W817-W824 | 8 | interleave |
| Tier 3 | W825-W831 | 7 | post-W806 |
| Tier 4 | W832-W835 | 4 | year-1+ |
| W775 priority-jumped | W775 | 1 (already counted in tail) | after W813+W815 |
| Frontend (Part VII) | WF01-WF29 | 29 | parallel with code waves |
| Cleanup (Part VIII) | WC01-WC15 | 15 | inter-wave hygiene |
| **TOTAL REMAINING** | **W723-W835 + WF01-WF29 + WC01-WC15** | **~144 waves** | |

(Dup cleanup 2026-05-24: killed W744 + W750 (merged into W808) + W776 = −3 from W707-tail.
W807/W808/W809/W810 + W720/W721/W722 = 7 shipped. Net remaining: 116 + 29 + 15 − 7 = 153
items before dup-killing, ~144 after.)

---

# PART VII — FRONTEND WAVES (WF01-WF29)

**Source:** User-shared 2026-05-24: "From 'good startup site' to 'state-of-the-art neo lab'" +
"Navigation Standards, Missing Items, K-Score Correction, Codebase Cleanup."
**Reference quality bar:** Linear / Vercel / Anthropic / Stripe / Resend / Raycast.
**Brand lock (binding):** Eyebrow "Open-source AI workbench"; H1 "Frontier AI on your own infrastructure."

## WF01 — DESIGN SYSTEM v1 (the foundation)

- **[WF01-1]** Token scale: spacing (4/8/12/16/24/32/48/64/96), type (12/14/16/18/24/32/48/64/96), radius (4/8/12/16/24), shadow (sm/md/lg/xl/2xl), motion (75/150/250/350/500ms ease curves). Agent: `wf01-tok`.
- **[WF01-2]** Color tokens: brand-primary, brand-secondary, surface (4 levels), text (4 levels), border (3 levels), state (success/warning/error/info × 3 levels each). Linear/Stripe-quality. Agent: `wf01-tok`.
- **[WF01-3]** Component primitives: Button (5 variants × 3 sizes), Input, Select, Card, Badge, Toast, Modal, Drawer, Tooltip, Tabs, Accordion, Avatar. All a11y-complete. Agent: `wf01-comp`.
- **[WF01-4]** Storybook-equivalent: `/design-system.html` showcase page enumerating every token + component with copy-paste-ready snippets. Agent: `wf01-doc`.
- **[WF01-5]** Token-driven CSS rewrite of `design-tokens.css` consuming the new tokens (no raw hex values). Agent: `wf01-impl`.

## WF02 — HERO REDESIGN (homepage h1 area)

- **[WF02-1]** Lock eyebrow "Open-source AI workbench" + H1 "Frontier AI on your own infrastructure." (NEVER edit without explicit user authorization). Agent: `wf02-copy`.
- **[WF02-2]** Lede 22-28 words max, max-width 48ch, "one breath" reading test. Agent: `wf02-copy`.
- **[WF02-3]** ONE atmospheric pin (mint radial gradient at 78-82% top-right). NEVER add a second bloom — premium B2B sites ship at most one (W604 lesson). Agent: `wf02-vis`.
- **[WF02-4]** Hero terminal: chronological 4-command flow (export OPENAI_BASE_URL → kolm distill → kolm verify → kolm run). NO persona switcher. Agent: `wf02-term`.
- **[WF02-5]** Two CTAs only: primary "Start distilling" (verb-driven), secondary "See a .kolm". Agent: `wf02-cta`.

## WF03 — NAV POLISH

- **[WF03-1]** Sticky top nav with backdrop-blur(20px) + 0.85 surface opacity. Linear/Vercel-quality. Agent: `wf03-1`.
- **[WF03-2]** Logo + 5 nav items max: Product, Pricing, Docs, Blog, Sign in. Agent: `wf03-1`.
- **[WF03-3]** Mega-menu under Product: 3-column grid (Build / Deploy / Use cases) — see Part VII NAV STANDARDS below. Agent: `wf03-2`.
- **[WF03-4]** Mobile nav: hamburger → full-screen drawer with stacked sections. NEVER reuse desktop dropdown logic. Agent: `wf03-2`.
- **[WF03-5]** Active-route highlight: 2px under-line + brand color on current section's nav item. Agent: `wf03-1`.

## WF04 — SCROLL ANIMATIONS (subtle, Vercel-quality)

- **[WF04-1]** IntersectionObserver-based fade-in-up on every major section (translateY: 16px → 0, opacity 0 → 1, 350ms ease-out). Agent: `wf04-1`.
- **[WF04-2]** Respect prefers-reduced-motion: disable ALL scroll animations when set. Agent: `wf04-1`.
- **[WF04-3]** Cursor-reactive ambient orb on hero (W604 pattern preserved). Gate on pointer:fine. Agent: `wf04-2`.
- **[WF04-4]** Magnetic CTAs (cursor pull effect 6px). Gate on pointer:fine + reduced-motion. Agent: `wf04-2`.

## WF05 — PIPELINE EXPLAINER (interactive)

- **[WF05-1]** 4-step horizontal pipeline diagram: Capture → Distill → Compile → Deploy. Click each step expands an inline panel with code + receipt artifact. Agent: `wf05-1`.
- **[WF05-2]** Keyboard nav: ← → switches steps. Active step has 2px underline + brand color. Agent: `wf05-1`.
- **[WF05-3]** Mobile: stacked vertical with same expand-on-tap behavior. Agent: `wf05-2`.
- **[WF05-4]** Each step shows real CLI output (not mock) — pulled at build time from a captured transcript. Agent: `wf05-2`.

## WF06 — DARK MODE

- **[WF06-1]** Add `[data-theme="dark"]` + `[data-theme="light"]` token overrides on `:root` (default dark — Linear/Vercel/Anthropic pattern). Agent: `wf06-1`.
- **[WF06-2]** Persistent toggle in nav: sun/moon icon, writes to localStorage + respects prefers-color-scheme on first visit. Agent: `wf06-1`.
- **[WF06-3]** Audit EVERY component for dark-mode parity — desaturated/lighter tonal variants, not inverted. WCAG AA contrast verified on both. Agent: `wf06-2`.
- **[WF06-4]** No FOUC: inline theme-detection script in `<head>` before any CSS load. Agent: `wf06-1`.

## WF07 — ROI CALCULATOR (homepage proof band)

- **[WF07-1]** Slider inputs: monthly API spend ($1k-$1M), # distill targets (1-100), avg captures/day (100-1M). Agent: `wf07-1`.
- **[WF07-2]** Live output: estimated monthly savings (pre-kolm spend × (1 − routing efficiency × 0.8)), payback period, $/distilled-artifact. Agent: `wf07-1`.
- **[WF07-3]** "Show me the math" expand: full assumption breakdown + a link to W835 savings-based pricing dashboard. Agent: `wf07-2`.
- **[WF07-4]** Default values match a realistic enterprise scenario (Stripe-quality default selection). Agent: `wf07-2`.

## WF08 — SOCIAL PROOF BAR

- **[WF08-1]** Honest-by-default: "X distilled artifacts shipped" pulled from real registry count + "Y% K-Score median" pulled from real calibration pack (W810). Agent: `wf08-1`.
- **[WF08-2]** NO fake logos. NO "trusted by" without real authorization. Agent: `wf08-1`.
- **[WF08-3]** If pre-launch: omit social proof band entirely — never fake it (Linear/Vercel approach pre-Series-A). Agent: `wf08-1`.

## WF09 — (RESERVED for future use — was K-Score Explorer, removed per user mandate 2026-05-24)

**Status: REMOVED.** Per user mandate: K-Score is a per-namespace quality gate, not a
public product-wide leaderboard. Homepage copy correction is in PART VII K-SCORE CORRECTION
section below.

## WF10 — BLOG / CHANGELOG SHELL

- **[WF10-1]** `/blog/` index with grid of posts (title, dek, author, date, read-time). Agent: `wf10-1`.
- **[WF10-2]** Per-post template: max-width 65ch reading column, drop cap, prev/next nav, anchored TOC on right. Agent: `wf10-1`.
- **[WF10-3]** RSS feed at `/blog/rss.xml` (auto-generated). Agent: `wf10-2`.
- **[WF10-4]** First three posts: (a) "Why we open-sourced the .kolm format" (b) "Distilling DeepSeek-R1 32B to INT4 in 125s" (c) "K-Score: a quality gate, not a leaderboard." Agent: `wf10-2`.

## WF11 — CHANGELOG

- **[WF11-1]** `/changelog.html` already exists — overhaul to Stripe-quality format: month-grouped, version-pinned, "what's new / improved / fixed" tabs per release. Agent: `wf11-1`.
- **[WF11-2]** Build script harvests git log for entries tagged `release:` and auto-generates entries. Agent: `wf11-1`.
- **[WF11-3]** RSS feed at `/changelog.rss` for developers who want push notifications. Agent: `wf11-2`.
- **[WF11-4]** Highlight badge on nav "Changelog" item when there's a release in the last 7 days. Agent: `wf11-2`.

## WF12 — DOCS UPGRADE

- **[WF12-1]** Three-pane layout (Vercel/Stripe docs quality): nav left, content center max-65ch, anchor TOC right. Agent: `wf12-1`.
- **[WF12-2]** Search bar (Cmd/Ctrl+K) with fuzzy matching across docs + CLI ref + API ref. Agent: `wf12-2`.
- **[WF12-3]** Code blocks: language pill + copy button + line numbers toggle + theme-matched syntax. Agent: `wf12-1`.
- **[WF12-4]** Per-doc "Was this helpful? 👍 / 👎 + feedback box" → posts to `/v1/docs/feedback` (already exists). Agent: `wf12-3`.
- **[WF12-5]** Mobile: docs nav becomes top dropdown, TOC moves to expandable panel. Agent: `wf12-1`.

## WF13 — INTERACTIVE DEMO

- **[WF13-1]** `/demo` interactive sandbox: pre-loaded captures, click "Distill" → real artifact build (using ephemeral tenant), shows K-Score, lets user inspect manifest.json. Agent: `wf13-1`.
- **[WF13-2]** Rate-limited (5 distills / IP / day) — honest envelope when exhausted. Agent: `wf13-2`.
- **[WF13-3]** "Try with your own captures" CTA at bottom routes to signup. Agent: `wf13-1`.

## WF14 — PERFORMANCE

- **[WF14-1]** Lighthouse Performance score ≥ 95 on every public page. Agent: `wf14-1`.
- **[WF14-2]** LCP < 1.2s on homepage (mobile 4G simulated). Agent: `wf14-1`.
- **[WF14-3]** CLS < 0.05 site-wide. Agent: `wf14-1`.
- **[WF14-4]** All images WebP/AVIF with width+height declared (no layout shift). Agent: `wf14-2`.
- **[WF14-5]** Critical CSS inlined; non-critical async-loaded. Agent: `wf14-2`.
- **[WF14-6]** Lazy-load any below-the-fold image/iframe. Agent: `wf14-2`.

## WF15 — MOBILE

- **[WF15-1]** Mobile-first audit of every public page: no horizontal scroll, all touch targets ≥ 44×44 with 8px spacing. Agent: `wf15-1`.
- **[WF15-2]** Test on iPhone SE (smallest live device width 375px) + iPhone 16 Pro Max + Galaxy S24 Ultra widths. Agent: `wf15-1`.
- **[WF15-3]** Safe-area-inset support for notch/Dynamic-Island devices. Agent: `wf15-2`.
- **[WF15-4]** Bottom-nav on mobile-app-style routes (/account/*): 5 items max, icon+label. Agent: `wf15-2`.

## WF16 — SEO

- **[WF16-1]** Per-page `<title>` and meta description handcrafted (no template-fill). Agent: `wf16-1`.
- **[WF16-2]** OG image generator: pulls page title + brand mark + sub-line into 1200×630 image at build. Agent: `wf16-2`.
- **[WF16-3]** Twitter card metadata. Agent: `wf16-2`.
- **[WF16-4]** Structured data: Organization, Product (per pricing tier), FAQPage on FAQs. Agent: `wf16-1`.
- **[WF16-5]** `sitemap.xml` auto-generated at build. Agent: `wf16-3`.
- **[WF16-6]** `robots.txt` allows all + points to sitemap. Agent: `wf16-3`.

## WF17 — ACCESSIBILITY

- **[WF17-1]** WCAG 2.2 AA compliance audit across every public page. Agent: `wf17-1`.
- **[WF17-2]** Skip-to-content link on every page. Agent: `wf17-2`.
- **[WF17-3]** Heading hierarchy lint (no h1→h3 skip). Agent: `wf17-2`.
- **[WF17-4]** Focus rings 2-3px brand color, never removed. Agent: `wf17-1`.
- **[WF17-5]** Aria-labels on every icon-only button. Agent: `wf17-2`.
- **[WF17-6]** Color contrast 4.5:1 minimum (verified with tool, both light + dark). Agent: `wf17-1`.

## WF18 — FOOTER

- **[WF18-1]** 4-column footer: Product / Resources / Company / Legal. Linear/Stripe pattern. Agent: `wf18-1`.
- **[WF18-2]** Sub-row: copyright, license (Apache 2.0), social links (GitHub primary), status page link. Agent: `wf18-1`.
- **[WF18-3]** Sitemap link in footer. Agent: `wf18-1`.

## WF19 — ERROR PAGES

- **[WF19-1]** `/404.html` custom: brand-consistent, search box, "back to home" + popular links. Agent: `wf19-1`.
- **[WF19-2]** `/500.html` custom: incident-aware ("we're on it"), status page link. Agent: `wf19-1`.
- **[WF19-3]** `/403.html` custom: "you need to sign in" CTA. Agent: `wf19-1`.

## WF20 — LAUNCH POLISH

- **[WF20-1]** Cross-browser test: Safari 17+, Chrome 120+, Firefox 121+, Edge 120+. Agent: `wf20-1`.
- **[WF20-2]** Print stylesheet for docs (readable when printed). Agent: `wf20-2`.
- **[WF20-3]** Favicon set: 16/32/48/180/512px, theme-color meta, apple-touch-icon. Agent: `wf20-2`.
- **[WF20-4]** Open Graph image preview test on Twitter/LinkedIn/Slack/Discord. Agent: `wf20-1`.
- **[WF20-5]** Final screenshot pass: every public page on 1440×900 desktop + 390×844 mobile, archived in `docs/screenshots/launch-2026-05-24/`. Agent: `wf20-3`.

---

## PART VII NAV STANDARDS (binding cross-cutting spec)

**Nav architecture (5-item lock):** Logo · Product · Pricing · Docs · Blog · Sign in

**Mega-menu under Product (3-column):**
- **Build** — Distill / Compile / Quantize / Verify
- **Deploy** — Hosted / On-prem / Air-gapped / Edge
- **Use cases** — Customer support / Code / Legal / Medical / Finance

**Mobile nav:** hamburger → full-screen drawer; sections stacked; back-arrow on every sub-page; never re-use desktop mega-menu logic.

**Docs sidebar:** 3-level nesting max; current section auto-expanded; persistent scroll position across navigations.

**Scroll behavior:** sticky top nav with backdrop-blur(20px); scroll-shadow on TOC when content scrolls past it.

**Breadcrumbs:** mandatory on `/docs/**` and `/account/**`; format: Home > Section > Page.

**Command palette (Cmd/Ctrl+K):** global; fuzzy search across docs + CLI ref + nav routes; recent-pages section.

---

## PART VII SUPPLEMENT (WF21-WF29)

### WF21 — STATUS PAGE
- **[WF21-1]** `/status.html` — uptime + per-surface status (API / docs / dashboard / kolm.ai static). Agent: `wf21-1`.
- **[WF21-2]** Incident log section with last 90 days of incidents (auto from `/v1/incidents/log`). Agent: `wf21-1`.
- **[WF21-3]** RSS subscribe + email subscribe (proxies to existing notification system). Agent: `wf21-2`.

### WF22 — SECURITY UPGRADE
- **[WF22-1]** `/security.html` upgrade: threat model summary, SBOM link, Trust Center link, security@kolm.ai contact. Agent: `wf22-1`.
- **[WF22-2]** Responsible-disclosure policy + bug bounty (if budget) detail page. Agent: `wf22-1`.
- **[WF22-3]** Crystal-clear SOC 2 / ISO 27001 status section (honest envelope on incomplete certs). Agent: `wf22-2`.

### WF23 — COMPARE POLISH
- **[WF23-1]** `/compare/` index: kolm vs Fireworks / Together AI / Modal / Replicate / Lamini / OpenPipe / Predibase. Agent: `wf23-1`.
- **[WF23-2]** Per-competitor compare table: pricing, model classes supported, on-prem support, .kolm format support, open-source license. Agent: `wf23-1`.
- **[WF23-3]** Honest gaps: where competitor wins on a dimension, say so. Linear/Stripe credibility. Agent: `wf23-2`.

### WF24 — INTEGRATIONS GRID
- **[WF24-1]** `/integrations.html` overhaul: card grid of every SDK + adapter + connector + framework. Agent: `wf24-1`.
- **[WF24-2]** Filter chips: SDK / adapter / IDE / CI/CD / workflow tool. Agent: `wf24-1`.
- **[WF24-3]** Per-card: logo, name, description, install cmd, "Open docs" CTA. Agent: `wf24-2`.
- **[WF24-4]** "Coming Q3 2026" pill for honest-not-yet-shipped items (e.g. Zapier / Make.com). Agent: `wf24-2`.

### WF25 — COOKIE CONSENT
- **[WF25-1]** Bottom-right banner first-visit; "Accept all" + "Essential only" + "Customize". Agent: `wf25-1`.
- **[WF25-2]** Granular categories: essential, analytics, functional. NEVER pre-checked analytics (GDPR). Agent: `wf25-1`.
- **[WF25-3]** Persistent cookie-preferences page at `/cookies.html`. Agent: `wf25-2`.

### WF26 — ANNOUNCEMENT BAR
- **[WF26-1]** Top-of-page strip for time-sensitive launches/sales/event/release-week. Dismissible (localStorage). Agent: `wf26-1`.
- **[WF26-2]** Honest: only show when there's a real announcement — never always-on filler. Agent: `wf26-1`.

### WF27 — WAITLIST (if pre-launch tier)
- **[WF27-1]** `/waitlist.html` — single-field email + "what would you build with kolm?" textarea. Agent: `wf27-1`.
- **[WF27-2]** Honest confirmation email (no fake "you're #4283 in line"). Agent: `wf27-2`.

### WF28 — LEGAL PAGES
- **[WF28-1]** `/terms.html` — reviewed by counsel before publish. Agent: `wf28-1`.
- **[WF28-2]** `/privacy.html` — GDPR + CCPA + LGPD compliant. Agent: `wf28-1`.
- **[WF28-3]** `/dpa.html` Data Processing Addendum (enterprise customers will ask). Agent: `wf28-2`.
- **[WF28-4]** `/acceptable-use.html` — what kolm can NOT be used for. Agent: `wf28-2`.

### WF29 — KEYBOARD SHORTCUTS PAGE
- **[WF29-1]** `/shortcuts.html` — global shortcuts (Cmd/Ctrl+K command palette, ? help overlay, g+h home, g+d docs, etc.). Agent: `wf29-1`.
- **[WF29-2]** Per-route shortcuts table in docs sidebar (Vercel pattern). Agent: `wf29-1`.

---

## PART VII K-SCORE CORRECTION (binding 2026-05-24)

**Removed:** Public K-Score Explorer (WF09 originally). Reason: K-Score is a per-namespace
quality gate, NOT a public product-wide leaderboard. A public explorer would mislead users
into comparing scores across non-comparable artifacts/namespaces.

**Homepage copy (binding wording):**
> "Quality gate every .kolm must pass before shipping. 0.85 minimum, 0.91 median
> across our reference artifacts. Your namespace gets its own K-Score after distillation."

**Where it surfaces:**
- Per-namespace dashboard `/account/k-score/<namespace>` (private, signed-in only).
- Per-artifact verify page `/verify/<cid>` shows K-Score + Bradley-Terry CI (W810).
- Homepage proof band uses the binding-wording above + a static 0.91 median reference number.
- Never as a public sortable leaderboard.

---

# PART VIII — CODEBASE CLEANUP WAVES (WC01-WC15)

**Source:** User-shared 2026-05-24 supplement Part IV. Inter-wave hygiene; runs in parallel
with feature waves where file-scope allows. Cleanup is NOT a one-shot — items run continuously.

### WC01 — DEPENDENCY AUDIT
- **[WC01-1]** `npm audit` + `pip-audit` + `cargo audit` clean (no high/critical CVEs). Agent: `wc01-1`.
- **[WC01-2]** Pin every top-level dep to exact version in `package.json` (no `^` / `~` for prod). Agent: `wc01-2`.
- **[WC01-3]** Lockfile committed + verified deterministic across hosts. Agent: `wc01-2`.
- **[WC01-4]** Identify unused deps (`depcheck`) — remove or document. Agent: `wc01-3`.

### WC02 — DEAD CODE ELIMINATION
- **[WC02-1]** Run `eslint --report-unused-disable-directives` site-wide + clean. Agent: `wc02-1`.
- **[WC02-2]** Run `ts-prune` equivalent on JS — flag every exported function with zero importers. Agent: `wc02-1`.
- **[WC02-3]** Delete (don't archive) genuinely dead code. Backwards-compat shims with no caller are still dead. Agent: `wc02-2`.
- **[WC02-4]** Audit `cli/kolm.js` for orphan sub-commands (declared but never wired to a TUI route or docs). Agent: `wc02-2`.

### WC03 — DUPLICATE CLEANUP
- **[WC03-1]** AST-level duplicate detection (`jscpd` or similar) — flag every >50-line clone. Agent: `wc03-1`.
- **[WC03-2]** Merge or extract — never leave a flagged clone "for now." Agent: `wc03-2`.
- **[WC03-3]** Per-pass report in `docs/cleanup/wc03-dups-<date>.md`. Agent: `wc03-2`.

### WC04 — TEST COVERAGE
- **[WC04-1]** Per-file coverage report: every `src/` file ≥ 80% line coverage OR documented exception. Agent: `wc04-1`.
- **[WC04-2]** Lock-in family pattern relaxed to regex+threshold (W604 anti-brittleness rule). Agent: `wc04-2`.
- **[WC04-3]** Flaky test elimination: any test that fails > 1% under 100 runs gets quarantined + fixed. Agent: `wc04-2`.

### WC05 — ERROR HANDLING AUDIT
- **[WC05-1]** Every `throw` has a stable snake_case error code in the message. Agent: `wc05-1`.
- **[WC05-2]** Honest-envelope pattern: every failable handler returns `{ok:false, error, hint, version}` + non-zero exit on CLI. Agent: `wc05-1`.
- **[WC05-3]** Never silent fallthrough — every error path is observable. Agent: `wc05-2`.

### WC06 — LOGGING
- **[WC06-1]** Single structured logger: `{ts, level, namespace, msg, extras}`. Agent: `wc06-1`.
- **[WC06-2]** Never log secrets, never log raw user input on auth paths. Agent: `wc06-1`.
- **[WC06-3]** Per-route correlation ID propagated through all logs of that request. Agent: `wc06-2`.

### WC07 — CONFIG
- **[WC07-1]** Single source of truth for every config var: `src/env.js`. Agent: `wc07-1`.
- **[WC07-2]** Every env var documented in `docs/env.md` + emitted into doctor output. Agent: `wc07-1`.
- **[WC07-3]** No `process.env.X` outside of `src/env.js`. Agent: `wc07-2`.

### WC08 — API VERSIONING
- **[WC08-1]** Every route prefixed `/v1/`. No unversioned API routes. Agent: `wc08-1`.
- **[WC08-2]** Deprecation policy documented: 6-month notice + dual-mount + Sunset header. Agent: `wc08-1`.
- **[WC08-3]** OpenAPI spec auto-generated and committed at every release. Agent: `wc08-2`.

### WC09 — CODE STYLE
- **[WC09-1]** Single formatter: Prettier (or biome) — committed config, runs on pre-commit. Agent: `wc09-1`.
- **[WC09-2]** Single linter: ESLint (or biome) — committed config, blocks PR. Agent: `wc09-1`.
- **[WC09-3]** No bypassed lint rules without `// eslint-disable` + comment explaining why. Agent: `wc09-2`.

### WC10 — CODE DOCS
- **[WC10-1]** Every public function in `src/` has a 1-3-line header explaining WHY it exists (not WHAT it does). Agent: `wc10-1`.
- **[WC10-2]** Module-level JSDoc on every `src/*.js` describing the module's purpose. Agent: `wc10-1`.
- **[WC10-3]** Honest contract callouts: every "honesty marker" (no_X_available envelope, 501 install_hint, etc.) documented in the module header. Agent: `wc10-2`.

### WC11 — CI/CD
- **[WC11-1]** GitHub Actions workflow: lint + test + audit-static-refs + audit-href on every PR. Agent: `wc11-1`.
- **[WC11-2]** Release gate: `scripts/release-verify.cjs` all 7 gates green required for tagged release. Agent: `wc11-1`.
- **[WC11-3]** Auto-deploy: push to main → Vercel deploys + sw.js cache busts. Agent: `wc11-2`.
- **[WC11-4]** SDK CI workflow (W470 already shipped `.github/workflows/sdk-c-rust.yml`) extended to Python + Node + Kotlin + RN. Agent: `wc11-2`.

### WC12 — MONOREPO HYGIENE
- **[WC12-1]** Single root `package.json` + workspaces. Agent: `wc12-1`.
- **[WC12-2]** Shared tsconfig / jest config / eslint config at root. Agent: `wc12-1`.
- **[WC12-3]** Per-workspace README explaining purpose + how to run/test locally. Agent: `wc12-2`.

### WC13 — DATABASE MIGRATIONS
- **[WC13-1]** Numbered, ordered migration files in `src/migrations/`. Agent: `wc13-1`.
- **[WC13-2]** Every migration has up + down (reversible). Agent: `wc13-1`.
- **[WC13-3]** Test: replay all migrations on empty DB → schema matches expected. Agent: `wc13-2`.
- **[WC13-4]** No NOT-NULL-on-large-table without backfill plan (concurrent-write safety). Agent: `wc13-2`.

### WC14 — SECURITY HARDENING
- **[WC14-1]** Helmet / CSP / HSTS / X-Frame-Options on every HTTP response. Agent: `wc14-1`.
- **[WC14-2]** Rate-limiting on every authn route + signup route. Agent: `wc14-1`.
- **[WC14-3]** SQL injection audit: every query uses prepared statements (no string concat). Agent: `wc14-2`.
- **[WC14-4]** XSS audit: every templated HTML output uses safe escaping. Agent: `wc14-2`.
- **[WC14-5]** Auth audit: every protected route runs through the same auth middleware (no per-route bypasses). Agent: `wc14-3`.
- **[WC14-6]** Secrets management: never in repo, never in logs, rotation playbook documented. Agent: `wc14-3`.

### WC15 — PERFORMANCE PROFILING
- **[WC15-1]** Per-route P50/P95/P99 latency tracked + alerted on regression. Agent: `wc15-1`.
- **[WC15-2]** Memory profile on long-running daemon: no leaks over 24h soak test. Agent: `wc15-2`.
- **[WC15-3]** Database query audit: every N+1 query identified + batched. Agent: `wc15-1`.
- **[WC15-4]** Bundle size budget: no JS bundle > 200KB gzip without explicit user approval. Agent: `wc15-2`.

---

## PART VIII GRAND TOTAL (updated 2026-05-24)

| Source | Waves | Count |
|--------|-------|-------|
| W707-original tail (post-dup-kill) | W723-W806 | 81 |
| Tier 1 (W811-W816) | W811-W816 | 6 |
| Tier 2 (W817-W824) | W817-W824 | 8 |
| Tier 3 (W825-W831) | W825-W831 | 7 |
| Tier 4 (W832-W835) | W832-W835 | 4 |
| Frontend (WF01-WF29, minus WF09) | WF01-WF29 | 28 |
| Cleanup (WC01-WC15) | WC01-WC15 | 15 |
| **GRAND TOTAL REMAINING** | | **149 waves** |

SHIPPED 2026-05-24: W720+W721+W722 (3) + W807+W808+W809+W810 (4) = 7 waves.

---

*Part VII (Frontend) + Part VIII (Cleanup) appended 2026-05-24 per user mandate
"ensure all instructions and waves are added to the master doc before context
compression kicks in." Atomic-decomposition format mirrors PART II + PART VI.
Dup cleanup (W744 killed, W750 merged into W808, W776 killed) + W775 priority-jump
+ W827/W828 renamed to v2 = applied same session.*
