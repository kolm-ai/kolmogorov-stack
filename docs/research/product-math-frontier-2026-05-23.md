# Kolm Product Math Frontier - 2026-05-23

This is the W596 backend/product handoff. It converts frontier algorithm research into implementation-grade product programs for Kolm's compiler, distillation, quantization, runtime, evaluation, privacy, registry, device, cloud compute, and agent-tool surfaces.

Machine-readable source: `docs/product-math-frontier.json`

Verification:

```bash
npm run verify:math-frontier
```

## Scope

This document is not public marketing copy, benchmark proof, or certification evidence. It is the build map for making the backend structurally stronger than wrappers, fine-tuning dashboards, eval dashboards, and serving engines.

The verifier fails if the map does not cover:

- 12 product journeys from `public/product-graph.json`
- 8 customization dimensions from `public/product-graph.json`
- all currently open readiness gates from `docs/product-sota-readiness.json`
- all 9 product/valuation metrics from `docs/product-invention-portfolio.json`
- all 12 product-invention portfolio ids
- all 10 math categories
- every math primitive in the file

## Core Insight

Kolm should be the policy, proof, and compilation layer above model providers and runtimes.

OpenAI, Anthropic, Together, Bedrock, Fireworks, Predibase, OpenPipe, vLLM, SGLang, TensorRT-LLM, ONNX Runtime, IREE, ExecuTorch, LangSmith, Braintrust, Phoenix, Weave, Sigstore, and Cloudflare each own a serious piece of the stack. Kolm's durable position is not to mimic one of them. It is to make their choices safe, auditable, reversible, and portable through `.kolm` artifacts.

That means the product cannot ask users to choose "train" or "compile" blindly. It must first answer:

- Should this workload stay prompt-only, use RAG, route providers, cache, fine-tune, distill, quantize, compile, or run local?
- Which teacher provider is allowed by privacy policy and budget?
- Which runtime target is feasible for the user's hardware?
- What data is sufficient, insufficient, noisy, held out, or policy-blocked?
- What proof chain survives audit: row hashes, model hash, tokenizer hash, calibration hash, runtime target, K-score interval, and signature?

## Research Base

The W596 source set uses primary papers and official docs where possible:

- GPTQ: https://arxiv.org/abs/2210.17323
- AWQ: https://arxiv.org/abs/2306.00978
- SmoothQuant: https://arxiv.org/abs/2211.10438
- QuaRot: https://arxiv.org/abs/2404.00456
- QuIP#: https://arxiv.org/abs/2402.04396
- AQLM: https://arxiv.org/abs/2401.06118
- KIVI: https://arxiv.org/abs/2402.02750
- KVQuant: https://arxiv.org/abs/2401.18079
- FlashAttention: https://arxiv.org/abs/2205.14135
- FlashAttention-2: https://arxiv.org/abs/2307.08691
- PagedAttention / vLLM: https://arxiv.org/abs/2309.06180
- SGLang / RadixAttention: https://arxiv.org/abs/2312.07104
- SpecInfer: https://arxiv.org/abs/2305.09781
- Medusa: https://arxiv.org/abs/2401.10774
- EAGLE: https://arxiv.org/abs/2401.15077
- MLIR: https://arxiv.org/abs/2002.11054
- TVM: https://arxiv.org/abs/1802.04799
- IREE deployment configs: https://iree.dev/guides/deployment-configurations/
- ONNX Runtime execution providers: https://onnxruntime.ai/docs/execution-providers/
- MiniLLM: https://arxiv.org/abs/2306.08543
- Distilling Step-by-Step: https://arxiv.org/abs/2305.02301
- Generalized Knowledge Distillation: https://arxiv.org/abs/2306.06629
- DPO: https://arxiv.org/abs/2305.18290
- Constitutional AI / RLAIF: https://arxiv.org/abs/2212.08073
- conformal prediction: https://jmlr.csail.mit.edu/papers/v9/shafer08a.html
- doubly robust off-policy evaluation: https://arxiv.org/abs/1511.03722
- DP-SGD: https://arxiv.org/abs/1607.00133
- Opacus: https://opacus.ai/
- FedAvg: https://arxiv.org/abs/1602.05629
- secure aggregation: https://research.google/pubs/practical-secure-aggregation-for-federated-learning-on-user-held-data/
- Krum: https://papers.neurips.cc/paper_files/paper/2017/hash/f4b9ec30ad9f68f89b29639786cb62ef-Abstract.html
- Renyi DP accountant: https://arxiv.org/abs/1702.07476
- Sigstore Cosign: https://docs.sigstore.dev/quickstart/quickstart-cosign/
- OpenTelemetry GenAI spans: https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/

## Insights

### 1. Quantization Is a Constrained Optimization Problem

The product should not expose AWQ, GPTQ, SmoothQuant, QuaRot, QuIP, AQLM, FP8, INT4, or KV-cache quantization as a grab bag. It should expose a single decision: "fit this behavior to this target under this K-score floor."

Backend implication: quantization has to become a scored planner over model family, calibration rows, runtime target, memory ceiling, latency target, and held-out quality risk.

### 2. Runtime Performance Depends on Memory Flow, Not Just Model Size

FlashAttention, PagedAttention, SGLang/RadixAttention, KIVI, KVQuant, Medusa, EAGLE, and SpecInfer all point at the same product rule: reduce wasted memory traffic and decode steps before buying more GPU.

Backend implication: `.kolm` runtime receipts should record context policy, KV policy, speculative decoding policy, attention kernel constraints, and rejected runtime paths.

### 3. "AI Compiler" Requires IR, Lowering, and Unsupported-Feature Diagnostics

MLIR, TVM, IREE, ONNX Runtime, ExecuTorch, CoreML, QNN, OpenVINO, TensorRT-LLM, WASM, and GGUF show the shape of a real compiler product. A compiler is not just a zip file. It must know what each target can and cannot lower.

Backend implication: Kolm needs a feature-lowering matrix for recipe ops, model family, runtime backend, quantization method, modality, streaming, tool calls, and proof mode.

### 4. Distillation Should Be a Policy, Not a Button

MiniLLM, Distilling Step-by-Step, DPO, GKD, and RLAIF/Constitutional AI show that distillation strategy depends on task type, teacher availability, preference signal, rationale usefulness, and distribution shift.

Backend implication: the distill strategy engine should recommend prompt-only, collect-more-data, synthetic teacher labeling, SFT, preference tuning, reverse-KL distill, RAG, or no-train based on trace evidence.

### 5. K-Score Needs Confidence and Abstention

K-score cannot be a single magic number if it is meant to survive an enterprise audit. Conformal prediction gives the right product language: coverage, risk, calibration set hash, threshold, confidence interval, and abstain behavior.

Backend implication: K-score receipts should expose calibration hash, alpha, threshold, observed coverage, abstain rate, and which rows drove failure diagnostics.

### 6. Privacy and Federated Learning Need Receipts

DP-SGD, Opacus, Renyi accounting, FedAvg, secure aggregation, and Krum are not just "privacy features." They are evidence requirements. Buyers need to know who contributed, what budget was spent, which updates were rejected, and how aggregation remained robust.

Backend implication: federated compile needs per-round receipts with client commitments, clipping, epsilon/delta, secure aggregation proof, Byzantine rejection reasons, and final artifact lineage.

### 7. Agent Tools Are Supply-Chain Artifacts

MCP servers, tool schemas, signed binaries, policy limits, and runtime receipts should be governed like software supply chain. Sigstore and OpenTelemetry are the vocabulary buyers already understand.

Backend implication: `kolm compile --as-mcp` should produce a proof-carrying tool bundle with schema tests, allowed tools, rate/cost limits, signature, and trace fields.

### 8. Cloud Compute Is Part of the Product

Users without a GPU still need to capture, label, distill, fine-tune, quantize, benchmark, compile, and deploy. Compute is not an environment assumption. It is a product surface.

Backend implication: the cloud broker must plan local, SSH, BYOC, AWS, Cloudflare R2/S3, Supabase, managed GPU, hosted provider, and local runtime fallback as one typed job graph.

## W596 Programs

### 1. Kolm-Q Lagrangian Quantizer

Maps to `kolm-q-oracle`.

Build a single quantization planner whose objective combines held-out loss, byte size, target p95 latency, and K-score floor. It should consider GPTQ, AWQ, SmoothQuant, QuaRot, QuIP, AQLM, KV quantization, and no-quant fallback.

Acceptance bar:

- no quantized artifact promotes without held-out K-score
- calibration hash is recorded
- rejected candidates include reasons
- runtime-specific constraints are explicit

### 2. KV Context Compressor

Maps to `device-fit-autopilot`.

Build a long-context policy that uses KIVI/KVQuant-like compression only when the task and target can tolerate it.

Acceptance bar:

- records context length, cache method, precision, and memory budget
- refuses unsafe compression under quality floor
- exposes long-context memory savings and K-score delta

### 3. Lossless Speculative Runtime

Maps to `device-fit-autopilot`.

Use Medusa/EAGLE/SpecInfer-style proposals with deterministic verifier acceptance so speedups do not change accepted output semantics.

Acceptance bar:

- verifier path is always authoritative
- receipt records proposal method and acceptance rate
- fallback path is exact

### 4. IR Autotune Compiler

Maps to `kolm-ir-autotarget`.

Turn `.kolm` from packaged behavior into a lowering plan across MLIR/TVM/IREE/ONNX Runtime/ExecuTorch-like targets.

Acceptance bar:

- unsupported features produce precise diagnostics
- target selection records runtime, backend, binary hash, and model family
- compile output is reproducible enough for verifier comparison

### 5. Reverse-KL Distill Forge

Maps to `distill-forge`.

Use MiniLLM and related distillation research to choose teacher/student/loss strategy by task, examples, holdout, and teacher constraints.

Acceptance bar:

- never trains on holdout
- recommends no-train/collect-more-data when evidence is weak
- exposes strategy rationale and failure diagnostics

### 6. Conformal K-Score Calibrator

Maps to `adaptive-eval-lab`.

Wrap K-score in conformal risk calibration and logged-policy replay where possible.

Acceptance bar:

- K-score includes confidence/coverage metadata
- shadow evals expose uncertainty and missing propensity diagnostics
- release gate blocks stale calibration evidence

### 7. Private Federated Optimizer

Maps to `privacy-membrane-max`.

Combine DP-SGD, Renyi accounting, secure aggregation, and customer-managed policy into federated compile.

Acceptance bar:

- epsilon/delta budgets are enforced
- client data stays local
- rejected updates are recorded
- final artifact receipt includes privacy ledger

### 8. Byzantine Aggregation Receipts

Maps to `receipt-os`.

Use Krum-like robust aggregation checks plus signed commitments so federated contributions survive audit.

Acceptance bar:

- adversary budget is explicit
- malicious updates are rejected with reason
- aggregate is signed and verifiable

### 9. Device Energy Scheduler

Maps to `device-fit-autopilot`.

Choose device runtime and precision by battery, memory, NPU/GPU availability, latency, and offline requirement.

Acceptance bar:

- browser/mobile/server targets use separate constraints
- ONNX Runtime execution providers are treated as first-class
- energy and thermal limits are not hidden

### 10. Bandit Registry Ranker

Maps to `artifact-market-maker`.

Rank registry artifacts by expected utility, uncertainty, proof quality, license, and enterprise constraints.

Acceptance bar:

- search ranking is auditable
- verified publishers and signed artifacts get trust weight
- exploit/explore tradeoff is visible

### 11. Agent Proof-Carrying Tools

Maps to `agent-tool-compiler`.

Compile `.kolm` artifacts into MCP/tool bundles with policy, schema, signature, trace, and verifier metadata.

Acceptance bar:

- Claude/OpenAI-compatible tool probes exist
- schema tests are part of artifact promotion
- tool budgets and blocked operations are recorded

### 12. Cloud Cost-Latency Solver

Maps to `cloud-compute-broker`.

Plan training/distill/compile jobs across local, SSH, BYOC, managed GPU, AWS, Cloudflare R2/S3, Supabase, and provider-hosted jobs.

Acceptance bar:

- no-local-GPU users get a real route
- storage/env gaps are named before upload
- completed jobs feed actual cost/latency back into planner

### 13. Build Strategy Brain

Maps to `build-strategy-brain`.

Choose the right path across prompt-only, RAG, provider routing, fine-tune, distill, compile, quantize, local runtime, cloud GPU, or no-train.

Acceptance bar:

- CLI, TUI, account UI, and API expose the same ranked plan
- plan includes K-score interval, compute plan, privacy policy, and fallback
- low-data workloads are guided into capture/eval instead of failed training

### 14. Codegraph Risk Index

Maps to `codegraph-product-index`.

Use codegraph fanout, product-surface ownership, verification age, public exposure, and changed files to pick release gates.

Acceptance bar:

- stale evidence blocks release
- package changes require package checks
- router/OpenAPI changes require product-surface checks
- public page changes require UI/static checks

## What Frontend Should Reflect Later

These are backend truths the frontend should eventually expose without overclaiming:

- "Choose my path" should be a first-class workflow: prompt, capture, RAG, route, distill, compile, quantize, deploy.
- "No GPU" should not be a dead end; the UI should offer cloud/BYOC/hosted teacher options with storage diagnostics.
- Runtime choice should be visible: local CPU, NVIDIA, browser/WASM, mobile, edge, ONNX Runtime EP, OpenVINO/QNN/CoreML/ExecuTorch where supported.
- K-score should show confidence and calibration, not just a single badge.
- Enterprise pages should describe controls as product evidence packets, while live certifications remain external gates.

## Non-Code Gates That Remain Honest

W596 deliberately does not mark these external gates complete:

- neutral foundation or third-party `.kolm` standard adoption
- Hugging Face/Ollama/llama.cpp native support
- public benchmark leaderboard with independent data
- SOC 2 Type II / ISO / HIPAA BAA / FedRAMP certification
- package publication to every public registry

Those are business/external-state gates. The backend can prepare packets, verifiers, manifests, and local checks, but it cannot truthfully claim external adoption before it happens.
