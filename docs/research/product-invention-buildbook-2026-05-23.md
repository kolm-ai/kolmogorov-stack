# Kolm Product Invention Buildbook - 2026-05-23

Machine-readable source: `docs/product-invention-buildbook.json`

Verification:

```bash
npm run verify:invention-buildbook
```

## Scope

This is the W598 backend/product buildbook. It is not public marketing copy and
not external proof. It is the implementation contract for the backend worker
lane: every product surface must route through typed strategy, proof, privacy,
compute, runtime, eval, and package gates instead of loose feature copy.

The verifier fails if the buildbook does not cover:

- all 12 product journeys from `public/product-graph.json`
- all 8 customization dimensions from `public/product-graph.json`
- all 8 currently open honest gates from `docs/product-sota-readiness.json`
- all 9 tracked product metrics from `docs/product-invention-portfolio.json`
- all 12 invention portfolio ids
- at least 12 backend categories
- implementation files, build steps, acceptance tests, failure modes, and smoke
  simulations for each invention

## Core Insight

Kolm should become the compiler, proof, and policy operating system above model
providers, cloud GPU pools, runtime engines, eval systems, observability tools,
and enterprise controls.

The biggest product failure mode is letting users choose isolated buttons:
capture, train, distill, compile, quantize, run, deploy, or verify. Those are
not separate products. They are decisions in one typed graph:

1. What is the task and proof requirement?
2. What data exists, and is it safe to use?
3. Is training justified, or should the user capture, label, retrieve, route,
   cache, or stay prompt-only?
4. Which teacher/provider/runtime/compute target is allowed by privacy,
   budget, latency, and deployment policy?
5. Which quantization/serving strategy preserves the K-score floor?
6. Which artifact, receipt, runtime, registry, package, and certification
   evidence can be truthfully shown?

If that graph is correct, the product feels simple. If that graph is missing,
the website can look polished while the actual product remains a set of
disconnected demos.

## Research Base

Primary and official sources used by the buildbook:

- SpinQuant: https://arxiv.org/abs/2405.16406
- QServe: https://proceedings.mlsys.org/paper_files/paper/2025/file/fbe2b2f74a2ece8070d8fb073717bda6-Paper-Conference.pdf
- TensorRT-LLM docs: https://nvidia.github.io/TensorRT-LLM/
- TensorRT-LLM speculative decoding: https://nvidia.github.io/TensorRT-LLM/1.2.0rc6/features/speculative-decoding.html
- SGLang speculative decoding: https://docs.sglang.ai/advanced_features/speculative_decoding.html
- NVIDIA SGLang overview: https://docs.nvidia.com/deeplearning/frameworks/sglang-release-notes/overview.html
- IREE deployment configs: https://iree.dev/guides/deployment-configurations/
- IREE source/docs: https://github.com/iree-org/iree
- ONNX Runtime execution providers: https://onnxruntime.ai/docs/execution-providers
- OpenTelemetry GenAI semantic conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/
- OpenTelemetry GenAI spans: https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/
- Sigstore docs: https://docs.sigstore.dev/
- SLSA provenance spec: https://slsa.dev/spec/v1.0/
- Cloudflare R2 presigned URLs: https://developers.cloudflare.com/r2/api/s3/presigned-urls/
- RunPod API docs: https://docs.runpod.io/api-reference/
- AWS Batch GPU jobs: https://docs.aws.amazon.com/batch/latest/userguide/gpu-jobs.html
- Kubernetes Kueue jobs: https://kueue.sigs.k8s.io/docs/tasks/run/jobs/
- Predibase adapters/Turbo LoRA docs: https://docs.predibase.com/fine-tuning/adapters
- OpenPipe repo: https://github.com/OpenPipe/OpenPipe
- Braintrust evaluation docs: https://www.braintrust.dev/docs/evaluate/run-evaluations
- LangSmith evaluation docs: https://docs.langchain.com/langsmith/evaluation
- Conformal LLM judge intervals: https://arxiv.org/abs/2509.18658
- Doubly robust LLM judge calibration: https://arxiv.org/abs/2512.11150
- Black-box on-policy distillation: https://huggingface.co/papers/2511.10643
- Generalized knowledge distillation: https://huggingface.co/papers/2306.13649
- Opacus: https://opacus.ai/
- Secure aggregation: https://research.google/pubs/practical-secure-aggregation-for-federated-learning-on-user-held-data/
- Model Context Protocol spec: https://modelcontextprotocol.io/specification

## Competitive Bar

Predibase owns a strong adapter-first story: LoRA, LoRAX, Turbo LoRA, private
deployments, and serverless fine-tuned inference. Kolm must not answer by being
"another fine-tuning UI." Kolm must answer with signed artifacts, offline
runtime portability, K-score receipts, compile diagnostics, and registry proof.

OpenPipe validates the expensive-prompt-to-cheap-model wedge. Kolm should keep
that loop, but add better strategy selection: sometimes the correct path is not
fine-tuning. Sometimes it is capture more rows, label harder rows, use RAG,
route to Anthropic/OpenAI-compatible/local, cache, quantize, or avoid training.

LangSmith and Braintrust set the UX expectation for evals and observability:
immutable experiments, comparison, CI hooks, traces, and prompt iteration. Kolm
must make those artifact-native, not separate dashboard evidence that can drift
from the thing being shipped.

vLLM, SGLang, TensorRT-LLM, ONNX Runtime, IREE, ExecuTorch, CoreML, OpenVINO,
QNN, WASM, and GGUF set the runtime bar. Kolm's compiler value is the target
decision, lowering matrix, unsupported-feature diagnostic, and verifiable
runtime receipt above them.

Cloudflare R2, RunPod, AWS Batch, Kubernetes/Kueue, SSH, BYOC, and local GPUs
set the compute bar. Kolm cannot assume local hardware. A user without a GPU
still needs a finished path to train, distill, quantize, compile, benchmark,
run, and deploy.

Sigstore, SLSA, OpenTelemetry, SOC2 evidence packs, SAML/SCIM/RBAC, audit logs,
and CMK/BYOK define enterprise seriousness. Kolm must preserve claim honesty:
certification and external adoption are gates, not adjectives.

## Insights

### 1. "Do Everything" Requires a Strategy Brain

The correct backend shape is not hundreds of independent routes. It is one
product graph with shared planners. Every account view, CLI command, TUI view,
API route, docs page, and smoke probe should ask the same strategy brain what
to do next.

Implementation rule: user intent becomes typed inputs. Typed inputs become a
single recommended next action, blocked alternatives, executable commands, and
evidence requirements.

### 2. Quantization Must Be Runtime-Aware

Low-bit quantization is not useful if the selected runtime does not have kernels
that avoid dequantization overhead. The product should expose "fit to this
target under this K-score floor," not a dropdown of AWQ/GPTQ/SpinQuant/QServe.

Implementation rule: every quantized artifact needs selected method, rejected
methods, target runtime, kernel support, calibration hash, held-out K-score
interval, byte size estimate, latency class, and rollback path.

### 3. The Compiler Needs Unsupported-Feature Diagnostics

A compiler that cannot say why it cannot lower a behavior is just a packaging
tool. Kolm should explain when a target cannot handle a modality, tool call,
streaming mode, quantization method, context policy, or proof requirement.

Implementation rule: every target record must declare capabilities and every
failed compile must emit machine-readable blockers.

### 4. Distillation Is Not the Default

Fine-tuning and distillation are expensive ways to be wrong if data is thin,
noisy, non-representative, or policy-blocked. The backend should often say
"capture more," "label these rows," "use RAG," "route providers," or "stay
prompt-only."

Implementation rule: no train/distill path promotes without data sufficiency,
holdout independence, teacher policy, compute policy, and eval confidence.

### 5. K-Score Needs Intervals and Abstention

A single K-score number will be attacked. The product needs calibration hash,
holdout hash, scorer version, alpha, interval, abstain rate, false-accept risk,
and off-policy overlap diagnostics.

Implementation rule: promotion gates should compare lower confidence bounds to
the required floor, not just point estimates.

### 6. Privacy Has To Be a Runtime Policy

Privacy cannot be a webpage promise. Capture, redaction, event lake persistence,
zero-retention, DP accounting, team RBAC, federated aggregation, and export
policy must all be executable.

Implementation rule: every captured row should have an eligibility reason,
redaction state, tenant boundary, storage mode, retention mode, and proof path.

### 7. Cloud Compute Is a First-Class Product Surface

If a user has no GPU, "install locally" is not a finished answer. Kolm needs a
typed cloud/BYOC broker that can create a safe path through R2/S3 artifact
transfer, managed GPU, AWS Batch, Kubernetes/Kueue, SSH, or hosted provider
execution.

Implementation rule: cloud jobs need input object, output object, compute
target, GPU class, queue state, cost ceiling, timeout, cancellation, webhook,
and redacted logs.

### 8. Agent Tools Are Supply Chain Artifacts

MCP tools should be signed, versioned, budgeted, tested, and traced. The agent
surface should not be an SDK afterthought.

Implementation rule: `kolm compile --as-mcp` should emit tool schema tests,
allowed tool policy, token/cost budgets, fallback chain, artifact signature,
and OTEL-compatible trace metadata.

### 9. The Registry Is the Standardization Wedge

The .kolm standard wins if external people can inspect, verify, diff, and run
artifacts without trusting Kolm's hosted app.

Implementation rule: registry entries need manifest, recipe, split hashes,
signature, license, runtime targets, dependency graph, K-score evidence, version
diff, publisher verification state, and private-registry support.

### 10. Claim Honesty Is an Engineering Feature

The product has external gates by design: package release, public benchmark
evidence, external runtime adoption, neutral foundation standardization, and
live certification. These must stay visible as gates until done.

Implementation rule: public copy, docs, API, OpenAPI, account UI, and CLI must
derive readiness wording from the same readiness artifact.

## W598 Build Programs

### Adaptive Lattice Quantization Oracle

Maps to `kolm-q-oracle`.

Build a constrained optimizer that chooses quantization by K-score floor,
runtime target, memory ceiling, p95 latency target, and rollback cost.

Acceptance bar:

- candidate methods include no-quant, FP8, AWQ, GPTQ, SmoothQuant, rotation,
  QServe-style W4A8KV4, KV-cache quantization, and GGUF fallback
- no candidate promotes without held-out K-score evidence
- selected and rejected methods are receipted
- smoke: `node scripts/simulate-product-invention-buildbook.cjs --invention=w598-adaptive-lattice-quantization-oracle --summary`

### Compiler Swarm Autotarget

Maps to `kolm-ir-autotarget`.

Build a feature-lowering matrix from recipe behavior to runtime backends:
ONNX Runtime EPs, IREE, TensorRT-LLM, GGUF, WASM, edge, mobile, and local.

Acceptance bar:

- every target declares modalities, quantization, context, streaming, and proof
  support
- unsupported features produce machine-readable diagnostics
- WASM/mobile/package paths remain honest until published
- smoke: `node scripts/simulate-product-invention-buildbook.cjs --category=compiler-autotarget --summary`

### Teacher Distillation Forge

Maps to `distill-forge`.

Build a distillation planner that chooses no-train, capture, label, RAG,
synthetic labels, SFT, preference tuning, reverse-KL, on-policy distillation,
or provider routing.

Acceptance bar:

- low-data, missing-holdout, and policy-blocked training fail closed
- Anthropic, OpenAI-compatible, local, hosted-open, and BYOC teachers are
  policy-filtered
- compile failure diagnostics say what to do next
- smoke: `node scripts/simulate-product-invention-buildbook.cjs --category=distillation-forge --summary`

### Build Strategy Operating System

Maps to `build-strategy-brain`.

Make CLI, TUI, account, API, docs, and product graph call the same planner.

Acceptance bar:

- every surface emits the same recommended next action
- no-local-GPU workloads get cloud/BYOC paths when configured
- secrets never print
- smoke: `npm run verify:build-strategy`

### ReceiptOS Verifiable Runtime

Maps to `receipt-os`.

Make receipts verify outside the hosted product and cover compile, runtime,
model, tokenizer, eval, calibration, quantization, provider, and registry
events.

Acceptance bar:

- standalone verifier works
- OTEL metadata is safe by default
- SLSA-style provenance is attached to artifact/package builds
- smoke: `node scripts/simulate-product-invention-buildbook.cjs --category=supply-chain-proof --summary`

### Privacy Membrane Governor

Maps to `privacy-membrane-max`.

Make capture safe enough for regulated buyers: zero-retention, redaction,
capture filtering, event lake schema, RBAC, audit export, and DP accounting.

Acceptance bar:

- row-level capture reason and redaction state exist
- zero-retention stores no content
- public benchmark/certification claims remain scoped
- smoke: `npm run verify:redaction-benchmark`

### Federated Trust Lab

Maps to `privacy-membrane-max`.

Build consortium learning where participants can contribute updates without
centralizing raw data.

Acceptance bar:

- per-round receipts contain commitments, clipping, privacy budget, aggregation
  mode, rejection reasons, and final artifact lineage
- no raw participant data is stored by the coordinator
- smoke: `npm run verify:federated`

### Cloud Compute Control Plane

Maps to `cloud-compute-broker`.

Make GPU absence a product flow, not a blocker: local, SSH, BYOC, RunPod, AWS
Batch, Kubernetes/Kueue, R2/S3, provider APIs, and edge runtimes.

Acceptance bar:

- cloud job plans include object transfer, compute target, queue state, budget,
  timeout, cancellation, webhook, and redacted logs
- R2/S3 object paths are signed and short lived
- no secrets print
- smoke: `npm run verify:cloud-broker`

### Adaptive Eval Lab

Maps to `adaptive-eval-lab`.

Make K-score and promotion decisions calibrated, inspectable, and CI-friendly.

Acceptance bar:

- deterministic evals, judge evals, human labels, replay, and shadow metrics
  are separated
- every promotion has interval and abstention metadata
- benchmark evidence remains a public-data gate
- smoke: `npm run verify:quality-calibration`

### Artifact Market Maker

Maps to `artifact-market-maker`.

Make registry entries searchable, diffable, deployable, private, license-tagged,
publisher-verified, dependency-aware, and receipt-backed.

Acceptance bar:

- version diffs include manifest, recipe, split hashes, runtime, quantization,
  eval set, and signature changes
- verified publisher status is not implied without verification
- smoke: `node scripts/simulate-product-invention-buildbook.cjs --category=registry-marketplace --summary`

### Agent Tool Compiler

Maps to `agent-tool-compiler`.

Compile proven behaviors into MCP-compatible tools with schema tests, budgets,
rate limits, fallback chains, receipts, and traces.

Acceptance bar:

- generated tool cannot call outside declared policy
- schema tests cover examples and failure modes
- install/package claims remain scoped to real package channels
- smoke: `node scripts/simulate-product-invention-buildbook.cjs --category=agent-tools --summary`

### Device Fit Autopilot

Maps to `device-fit-autopilot`.

Inspect device/runtime capability before telling the user to run locally,
browser, mobile, edge, server, or cloud.

Acceptance bar:

- runtime recommendation includes blockers and install/package gate status
- local execution is preferred when policy requires it and hardware fits
- cloud/BYOC is offered when local hardware cannot fit
- smoke: `node scripts/simulate-product-invention-buildbook.cjs --category=device-runtime --summary`

### Codegraph Product Indexer

Maps to `codegraph-product-index`.

Index every route, CLI command, TUI view, SDK package, account tab, readiness
item, public claim, and smoke probe so drift fails locally.

Acceptance bar:

- every indexed node has product owner, journey, dimension, and smoke status
- public claims cannot outrun evidence
- parallel-agent edits converge through product graph
- smoke: `npm run verify:codegraph`

### Serving Runtime Optimizer

Maps to `kolm-ir-autotarget`.

Plan high-volume inference by batching, prefix/KV reuse, semantic cache,
streaming, rate limits, quotas, fallback chains, and OTEL-safe telemetry.

Acceptance bar:

- cache cannot cross privacy boundaries
- fallback providers obey policy
- streaming output can be reconciled with receipts
- smoke: `node scripts/simulate-product-invention-buildbook.cjs --category=serving-runtime --summary`

## Implementation Agent Contract

For any requirement marked `partial`, `external`, `package`, `benchmark`, or
`certification`:

1. If it can be built locally, build it and add tests in the same wave.
2. If it requires external evidence, keep it as an honest gate and wire the
   gate into public copy, API, docs, CLI, account, and product graph.
3. If it requires package publication, prove local packaging and leave publish
   status explicit.
4. If it requires benchmark data, keep local synthetic/fixture proof separate
   from public benchmark proof.
5. If it requires certification, ship evidence packet generation but do not
   claim live certification before real evidence exists.

The backend definition of done for each program is:

- source-backed implementation plan
- product journey and dimension ownership
- readiness gate ownership
- local simulator coverage
- focused unit/contract tests
- smoke command
- product graph or readiness artifact updated when the surface changes
- public claim scope preserved

## Verification Summary

The W598 simulator currently reports:

- 28 research sources
- 14 source areas
- 13 categories
- 14 inventions
- 12/12 journeys covered
- 8/8 dimensions covered
- 8/8 open readiness gates covered
- 9/9 metrics covered
- 12/12 product invention portfolio ids covered
- synthetic composite delta: 0.273

This is still synthetic implementation evidence. It does not replace external
runtime adoption, package publication, public benchmark evidence, or live
certification.
