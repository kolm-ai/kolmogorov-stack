# Kolm Product Invention Lab

Date: 2026-05-23

Status: research-backed invention blueprint for implementation agents. This is
not a marketing claim, benchmark report, or claim that the inventions are
already shipped. It is the next product-depth map for making Kolm materially
better across quality, latency, cost, portability, proof, security, enterprise
readiness, developer experience, and conversion.

## 0. Source Of Truth

This document is grounded in the current repo state:

- `public/product-graph.json`: 7 route surfaces, 12 journeys, 57 readiness
  requirements, 116 route groups, 411 routes, 33 account links, 55 CLI commands,
  19 TUI views, 69 API routes, 8 customization dimensions.
- `docs/product-sota-readiness.json`: 14 shipped requirements, 35 implemented
  requirements, 8 open proof/release/partner gates.
- `src/product-kernel.js`: canonical readiness statuses, claim scopes, route
  classes, proof kinds, deployment modes, and failure codes.
- `docs/research/backend-product-surface-structural-edit-plan-2026-05-22.md`:
  prior structural plan. This document does not replace it; it adds invention
  depth and implementation mechanics.

The product spine remains:

```txt
evidence -> dataset -> eval -> build decision -> artifact -> runtime -> receipt -> governance export
```

The invention rule: an idea is only useful if it improves at least one tracked
metric and strengthens the spine without widening copy drift or fake readiness.

## 1. Tracked Metrics

Kolm should score every product change against this metric ledger.

| Metric | Primary user-facing question | Backend evidence |
| --- | --- | --- |
| Quality | Is the artifact/provider/model actually better for this task? | K-score axes, holdout pass, bakeoff delta, judge calibration, redaction F1, task-specific evals |
| Latency | Is it faster enough to matter in production? | TTFT, p50/p95/p99, prefill/decode split, cache hit rate, streaming delay, local device latency |
| Cost | Does it reduce tokens, GPU seconds, provider spend, storage, and support work? | Spend attribution, cost quote, token saved, avoided calls, GPU time, egress/storage cost |
| Portability | Does the same behavior survive provider/runtime/device changes? | runtime targets, conformance suite, target-specific receipts, device fit, artifact diff |
| Proof | Can a buyer or auditor verify the claim? | signed manifests, row hashes, split hashes, receipts, benchmark JSON, compliance binder |
| Security | Does it reduce data leakage, supply-chain, tenant, policy, and runtime risk? | tenant tests, policy receipts, secret refs, SBOM/SLSA/Sigstore, sandbox and tool permissions |
| Enterprise | Does it reduce procurement and deployment friction? | RBAC, SCIM/SSO, audit export, BYOC, object storage, private registry, support runbook |
| DX | Can a developer or agent complete the loop without guessing? | CLI steps, TUI state, account next actions, error classes, docs parity, code graph |
| Conversion | Does it make the product easier to understand and buy? | first artifact time, activation path, pricing entitlement clarity, surface-level readiness |

## 2. Research Baseline

The best external work says Kolm should not invent in isolation. The point is
to compose proven ideas into a product layer competitors do not own: portable,
signed, eval-gated AI artifacts.

### 2.1 Quantization And Compression

Relevant sources:

- GPTQ uses approximate second-order information for one-shot GPT
  quantization and reports 3-4 bit weight quantization at large scale:
  https://arxiv.org/abs/2210.17323
- SmoothQuant migrates activation outlier difficulty into weights to make
  W8A8 quantization practical: https://arxiv.org/abs/2211.10438
- AWQ preserves salient weights based on activation awareness:
  https://arxiv.org/abs/2306.00978
- QuaRot uses rotations to reduce outliers for 4-bit weights, activations, and
  KV cache: https://arxiv.org/abs/2404.00456
- KIVI targets asymmetric 2-bit KV cache quantization:
  https://arxiv.org/abs/2402.02750
- TurboQuant gives online vector quantization with near-optimal distortion and
  KV-cache-oriented results: https://arxiv.org/abs/2504.19874
- Block-Sphere Vector Quantization, submitted 2026-05-19, argues spherical
  block quantization can improve rotated vector preservation:
  https://arxiv.org/abs/2605.19972

Implication for Kolm: the best quantizer is not one algorithm. It is an
evidence-conditioned planner that chooses per-layer and per-runtime
quantization from task sensitivity, activation outliers, runtime kernel support,
KV-cache pressure, and artifact quality gates.

### 2.2 Compilation And Runtime Systems

Relevant sources:

- MLIR provides reusable multi-level compiler infrastructure:
  https://arxiv.org/abs/2002.11054
- IREE is an MLIR-based compiler/runtime that targets datacenter down to mobile
  and edge: https://github.com/iree-org/iree
- PyTorch `torch.compile` captures and optimizes dynamic PyTorch programs:
  https://docs.pytorch.org/docs/stable/generated/torch.compile.html
- Apache TVM is an open ML compiler framework:
  https://tvm.apache.org/docs/index.html
- TensorRT-LLM exposes optimized NVIDIA LLM build/runtime paths:
  https://docs.nvidia.com/tensorrt-llm/
- vLLM's PagedAttention improves serving throughput through KV-cache memory
  management: https://arxiv.org/abs/2309.06180
- SGLang uses RadixAttention and compressed finite state machines for
  structured language model programs: https://arxiv.org/abs/2312.07104

Implication for Kolm: Kolm should not replace those compilers and runtimes.
Kolm should compile product evidence into a target-specific, proof-preserving
bundle that can lower into those systems.

### 2.3 Distillation And Training

Relevant sources:

- OpenAI's fine-tuning docs stress evals before fine-tuning and describe
  distilling from a larger model into smaller training data:
  https://platform.openai.com/docs/guides/supervised-fine-tuning
- Distilling Step-by-Step adds rationale supervision to make smaller models
  competitive with far fewer examples: https://arxiv.org/abs/2305.02301
- MiniLLM studies distillation for generative LLMs:
  https://arxiv.org/abs/2306.08543
- ORPO folds preference optimization into SFT without a separate reference
  model: https://arxiv.org/abs/2403.07691
- KTO supports binary desirable/undesirable signals:
  https://arxiv.org/abs/2402.01306
- GRPO research is relevant for critic-light reasoning optimization:
  https://arxiv.org/abs/2603.01162
- Together, Fireworks, OpenPipe, and Predibase show that hosted LoRA, full
  fine-tuning, trace-to-train, and multi-LoRA serving are now table stakes:
  https://docs.together.ai/docs/fine-tuning-overview,
  https://docs.fireworks.ai/models/uploading-custom-models,
  https://docs.openpipe.ai/features/fine-tuning/quick-start,
  https://github.com/predibase/lorax

Implication for Kolm: training is not the moat. The moat is deciding when not
to train, selecting the cheapest teacher/student/compute path when training is
right, and binding the result to artifact proof.

### 2.4 Gateway, Caching, Observability, And Evals

Relevant sources:

- OpenAI prompt caching and Anthropic prompt caching both make repeated prompt
  structure a major cost/latency lever:
  https://platform.openai.com/docs/guides/prompt-caching and
  https://docs.claude.com/en/docs/build-with-claude/prompt-caching
- OpenTelemetry GenAI semantic conventions define shared trace vocabulary:
  https://opentelemetry.io/docs/specs/semconv/gen-ai/
- HELM argues for transparent, multi-metric model evaluation:
  https://arxiv.org/abs/2211.09110
- OpenAI Evals provides a custom eval framework:
  https://github.com/openai/evals
- CodeGraph shows that local pre-indexed code graphs can reduce agent
  discovery cost and tool calls in large repos:
  https://github.com/colbymchenry/codegraph

Implication for Kolm: observability and caching are not enough. Kolm should
turn traces, prompt-cache structure, evals, code structure, and repeated agent
work into compile opportunities.

### 2.5 Cloud, Storage, And Enterprise Deployment

Relevant sources:

- Cloudflare R2 supports S3-compatible object storage:
  https://developers.cloudflare.com/r2/api/s3/
- AWS SageMaker training jobs provide managed distributed training:
  https://docs.aws.amazon.com/sagemaker/latest/dg/distributed-training.html
- RunPod Serverless and Modal provide GPU/serverless job substrates:
  https://docs.runpod.io/serverless/overview and https://modal.com/docs
- OpenTelemetry, Sigstore, SLSA, CycloneDX, NIST AI RMF, ISO 42001, and OWASP
  LLM guidance define modern enterprise proof expectations:
  https://opentelemetry.io/docs/specs/semconv/gen-ai/,
  https://docs.sigstore.dev/, https://slsa.dev/,
  https://cyclonedx.org/specification/overview/,
  https://www.nist.gov/itl/ai-risk-management-framework,
  https://www.iso.org/standard/81230.html,
  https://owasp.org/www-project-top-10-for-large-language-model-applications/

Implication for Kolm: cloud support is not "we have a provider integration."
It is a broker that selects storage, compute, privacy boundary, job monitor,
result import, and receipt proof under user constraints.

## 3. Invention Portfolio

### 3.1 Kolm-Q Oracle Quantizer

Goal: become the best quantization tool for Kolm artifacts by optimizing
quality, latency, cost, portability, and proof together.

Invention: an evidence-conditioned mixed-precision planner. It chooses the
quantization recipe per layer, module, runtime, and KV-cache policy using task
holdout loss, activation samples, teacher/student deltas, device budget, and
available kernels. It does not ask the user to choose GPTQ vs AWQ vs
SmoothQuant vs rotation vs KV compression. The user chooses constraints:
quality floor, latency target, file size, device, and runtime.

Core algorithm:

1. Build calibration slices from train rows, holdout rows, synthetic stress
   rows, privacy-safe redacted rows, and runtime hot prompts.
2. Collect layer sensitivity:
   - weight Hessian proxy from GPTQ-style block updates
   - activation outlier score from SmoothQuant/AWQ-style statistics
   - rotation benefit estimate from QuaRot/BlockQuant-style transformed tails
   - KV pressure estimate from prompt length, concurrency, and cache reuse
3. Generate candidate quantization assignments:
   - W8A8 for latency-critical high-kernel-support paths
   - W4A16 or W4A8 for GPU/local memory savings
   - rotated W4A4KV4 for target runtimes that can support it
   - KV2/KV3.5 for long-context runtime paths
   - unquantized islands for high-sensitivity layers
4. Solve constrained optimization:
   - minimize `expected_quality_loss + lambda_latency * latency + lambda_size * size`
   - constraints: `K-score >= gate`, `device_memory <= budget`,
     `runtime_support == true`, `privacy_policy == allowed`
5. Run short holdout eval and adversarial eval for each finalist.
6. Emit `quantization_receipt.json`:
   - calibration hashes
   - layer bit map
   - skipped layers and reasons
   - runtime target
   - K-score delta
   - latency estimate and measured smoke
   - rollback target

Implementation agents should build:

| File | Edit |
| --- | --- |
| `src/quantization-planner.js` | New planner with sensitivity collection, candidate generation, constrained solver, and receipt model. |
| `src/quantization-receipt.js` | New receipt schema and verifier for quantized artifacts. |
| `workers/quantize/oracle-worker.cjs` | Worker entry that can run CPU-only simulation and delegate GPU work when configured. |
| `src/compile-pipeline.js` | Add `quantization_plan_id`, `quantization_receipt`, and K-score delta to artifact build manifests. |
| `src/model-registry.js` | Add `quantization_support` per model family/runtime. |
| `cli/kolm.js` | Add `kolm quantize plan`, `kolm quantize run`, `kolm quantize compare`, and `kolm quantize receipt`. |
| `public/account/builds.html` | Frontend should display target device, target runtime, size/latency/quality tradeoff, and rollback. |
| `tests/quantization-planner.test.js` | Lock candidate coverage, no holdout leakage, deterministic planning, and receipt verification. |

First smoke test:

```bash
node workers/quantize/oracle-worker.cjs --fixture tests/fixtures/quantize-small.json --target gguf:q4 --dry-run --json
node --test --test-concurrency=1 tests/quantization-planner.test.js
```

Metric impact:

- Quality: fewer blind quantization losses because sensitive layers can stay
  higher precision.
- Latency: target-specific kernels are selected instead of generic file size
  minimization.
- Cost: fewer hosted retries and smaller deploy bundles.
- Portability: runtime support is explicit.
- Proof: every quantization decision has a receipt.

### 3.2 KolmIR AutoTarget Compiler

Goal: make Kolm the best compilation tool by turning product evidence into a
target-independent build plan and lowering it into real runtimes.

Invention: KolmIR, a small product-level IR above model compiler IRs. It does
not represent tensor ops first. It represents task, evidence, evals, policy,
runtime target, sidecars, receipts, and fallback semantics. Lowering passes
then decide whether the target needs GGUF, ONNX, CoreML, MLX, ExecuTorch,
LiteRT, TensorRT-LLM, vLLM, SGLang, browser runtime, or pure rules.

Core IR nodes:

```txt
EvidenceSet -> DatasetSplit -> EvalSuite -> BuildStrategy -> RuntimeTarget
RuntimeTarget -> ModelBundle | RuleBundle | RagBundle | ToolBundle
Policy -> ProviderPolicy | PrivacyPolicy | TokenBudget | ToolPermission
Proof -> ManifestHash | SplitHash | EvalHash | Signature | ReceiptChain
Fallback -> LocalArtifact | ProviderRoute | HumanReview | Deny
```

Compiler passes:

1. `evidence-normalize`: canonicalize traces, labels, evals, and split hashes.
2. `strategy-select`: choose no-train, prompt cache, RAG, distill, quantize, or
   hosted training.
3. `target-fit`: evaluate runtime and device support.
4. `policy-bind`: attach privacy, provider, token, and tool policy.
5. `backend-lower`: emit backend-specific bundle metadata.
6. `receipt-bind`: attach build and runtime receipt schemas.
7. `conformance-pack`: emit executable verifier fixtures.

Implementation agents should build:

| File | Edit |
| --- | --- |
| `src/kolm-ir.js` | New IR schema, validator, and stable serialization. |
| `src/compiler-passes/*.js` | One pass per phase. Keep each pure and deterministic. |
| `src/compile-pipeline.js` | Move compile phases through KolmIR and phase manifests. |
| `src/export-provenance.js` | Add target lowering proof. |
| `docs/kolm-ir-v0.md` | Public developer spec for the IR. |
| `tests/kolm-ir.test.js` | Lock serialization, pass ordering, and no policy loss. |

First smoke test:

```bash
node cli/kolm.js compile --spec examples/demo-log-triage/spec.json --emit-ir --dry-run --json
node --test --test-concurrency=1 tests/kolm-ir.test.js
```

Metric impact:

- Portability: one IR lowers to many runtime targets.
- Proof: every phase can be signed and audited.
- DX: implementation agents get stable phase boundaries instead of editing one
  giant compile path.
- Enterprise: auditors can review build semantics without reading all runtime
  backends.

### 3.3 Distill Forge

Goal: make Kolm the best distillation tool by optimizing example selection,
teacher choice, reasoning supervision, and preference learning for K-score lift
per dollar.

Invention: an expected utility planner for distillation. It ranks possible
teacher calls, rationales, counterexamples, preference pairs, and student
backbones by expected improvement over cost and privacy risk.

Core algorithm:

1. Start from the event lake and current eval failures.
2. Cluster failures by output type, domain, entity class, model family, and
   policy reason.
3. For each cluster, propose data actions:
   - ask high-end teacher for rationale
   - ask cheap teacher for labels
   - generate contrastive negative
   - request human label
   - run preference comparison
   - do nothing because rule/RAG/cache is better
4. Estimate expected K-score lift:
   - uncertainty from bakeoff disagreement
   - coverage gap from failure cluster weight
   - label noise estimate
   - teacher confidence and cost
5. Choose training objective:
   - SFT for deterministic style/extraction
   - rationale distillation for reasoning/explanation tasks
   - ORPO/KTO/DPO for preference data
   - GRPO-like group sampling only for tasks with executable rewards
6. Enforce split integrity before every build.
7. Emit `distill_plan.json` and `distill_receipt.json`.

Implementation agents should build:

| File | Edit |
| --- | --- |
| `src/distill-forge.js` | New planning engine. |
| `src/training-planner.js` | Call Distill Forge before launch. |
| `src/distill-pipeline.js` | Accept objective-specific recipes and teacher provenance. |
| `src/provider-registry.js` | Add teacher capabilities: rationale, tool, vision, audio, cost, privacy. |
| `src/bakeoff.js` | Export disagreement clusters and failure taxonomy. |
| `cli/kolm.js` | Add `kolm distill plan --objective auto --budget <usd>`. |
| `tests/distill-forge.test.js` | Lock no train/eval leakage, budget compliance, objective selection, and teacher provenance. |

First smoke test:

```bash
node cli/kolm.js distill plan --namespace demo-log-triage --budget 5 --dry-run --json
node --test --test-concurrency=1 tests/distill-forge.test.js
```

Metric impact:

- Quality: data actions target observed failures instead of generic dataset
  growth.
- Cost: expensive teacher calls are used only where their expected lift wins.
- Proof: teacher outputs, rationales, and preference labels are source-hashed.
- DX: users see why the system wants more data or a different objective.

### 3.4 Build Strategy Brain

Goal: prevent the product from pushing users into training when a cheaper,
safer tactic is better.

Invention: a mandatory build preflight that compares no-train and train paths.
It chooses among rules, prompt compression, provider prompt cache, semantic
cache, RAG, local artifact, distillation, fine-tuning, quantization, and hosted
training.

Decision features:

- task type
- output determinism
- required freshness
- data volume and label quality
- privacy boundary
- provider cache potential
- retrieval need
- latency/cost target
- device target
- current failure clusters
- available compute

Implementation agents should build:

| File | Edit |
| --- | --- |
| `src/build-strategy-brain.js` | New strategy classifier and expected-value scorer. |
| `src/training-planner.js` | Require preflight before train/distill jobs. |
| `src/runtime-policy.js` | Accept no-train recommendations as executable policies. |
| `src/optimization.js` | Expose prompt compression/cache/RAG candidates with estimates. |
| `cli/kolm.js` | Add `kolm decide --task <task> --constraints constraints.json`. |
| `tests/build-strategy-brain.test.js` | Lock obvious decisions: redaction rules, RAG, cache, small model, hosted distill. |

First smoke test:

```bash
node cli/kolm.js decide --task "classify support tickets" --examples examples/demo-log-triage/spec.json --json
node --test --test-concurrency=1 tests/build-strategy-brain.test.js
```

Metric impact:

- Cost: avoids unnecessary training.
- Latency: pushes repeated prompt/cache opportunities into runtime policy.
- Security: blocks hosted training when privacy policy requires local/BYOC.
- Conversion: users understand the first useful next step.

### 3.5 ReceiptOS Evidence Fabric

Goal: make proof the product's operating system, not a post-build add-on.

Invention: a single signed receipt graph for capture, redaction, dataset split,
build, quantization, eval, deployment, runtime inference, fallback, and
governance export.

Receipt graph node types:

```txt
capture_event
privacy_decision
dataset_version
split_manifest
eval_run
build_plan
build_run
quantization_plan
artifact_manifest
deployment_manifest
inference_run
fallback_decision
governance_export
```

Every node has:

- tenant/workspace/namespace
- source hash
- parent receipt hashes
- policy hash
- actor/service account
- timestamp
- signature
- export scope

Implementation agents should build:

| File | Edit |
| --- | --- |
| `src/receipt-os.js` | Receipt graph append, verify, export, and parent linking. |
| `src/artifact.js` | Use ReceiptOS for build and artifact signatures. |
| `src/runtime.js` | Emit runtime/fallback receipts. |
| `src/privacy-membrane.js` | Emit privacy decision receipts. |
| `src/audit.js` | Bind audit rows to receipt hashes. |
| `src/router.js` | Add `/v1/receipts/graph`, `/v1/receipts/verify`, `/v1/receipts/export`. |
| `tests/receipt-os.test.js` | Lock tamper detection, parent hash checks, and tenant fencing. |

First smoke test:

```bash
node cli/kolm.js verify examples/demo-log-triage/demo.kolm --receipt-graph --json
node --test --test-concurrency=1 tests/receipt-os.test.js
```

Metric impact:

- Proof: every claim becomes linked evidence.
- Security: tampering shows up as broken parent hashes.
- Enterprise: compliance exports become generated from real state.

### 3.6 Privacy Membrane Max

Goal: make redaction and privacy controls measurable, fail-closed, and
enterprise-grade.

Invention: policy-driven privacy compiler. It compiles a workspace privacy
policy into deterministic detectors, ML detectors, provider allow/deny rules,
differential privacy budgets, retention actions, and evidence exports.

Pipeline:

1. Detect classes with deterministic regex/checksum detectors.
2. Detect contextual entities with local NER/model detectors where available.
3. Apply policy:
   - allow
   - redact
   - hash
   - local-only
   - human-review
   - deny
4. Emit class counts and confidence.
5. Track DP epsilon for aggregate outputs.
6. Run public benchmark fixtures and report per-class precision/recall/F1.

Implementation agents should build:

| File | Edit |
| --- | --- |
| `src/privacy-policy-compiler.js` | Policy-to-detector/action compiler. |
| `src/privacy-membrane.js` | Route all scan/redact decisions through compiled policy. |
| `src/redaction-bench.js` | Public fixture runner and report generator. |
| `docs/redaction-benchmark-v0.md` | Methodology and class definitions. |
| `tests/privacy-membrane-max.test.js` | Lock fail-closed handling, DP budget, and class counts. |

First smoke test:

```bash
node src/redaction-bench.js --fixture tests/fixtures/privacy-redaction.jsonl --json
node --test --test-concurrency=1 tests/privacy-membrane-max.test.js
```

Metric impact:

- Quality: redaction moves from binary pass/fail to class-level performance.
- Security: policy-deny and local-only become executable.
- Enterprise: buyers get evidence instead of vague HIPAA language.

### 3.7 Cloud Compute Broker

Goal: make Kolm usable for users without GPUs while preserving privacy, cost,
and artifact proof.

Invention: provider-neutral compute brokerage. The user describes constraints,
not infrastructure. The broker chooses local CPU/GPU, Apple Silicon, SSH GPU,
BYOC, AWS SageMaker, Modal, RunPod, Together, or another managed backend.

Input:

```json
{
  "task": "distill",
  "budget_usd": 50,
  "deadline_minutes": 30,
  "privacy": "redacted-hosted",
  "target_runtime": "gguf:q4",
  "storage": "r2-compatible",
  "preferred_regions": ["us-east"],
  "fallbacks": ["ssh", "local"]
}
```

Output:

```json
{
  "plan_id": "cp_...",
  "selected_backend": "modal-gpu",
  "storage_backend": "r2-compatible",
  "quoted_cost_usd": 12.40,
  "quoted_duration_minutes": 9,
  "privacy_boundary": "redacted-hosted",
  "artifact_import": "signed-object",
  "fallbacks": ["ssh", "local"],
  "receipt_required": true
}
```

Implementation agents should build:

| File | Edit |
| --- | --- |
| `src/compute-broker.js` | Constraint parser, provider scorer, quote model, launch/import contract. |
| `src/remote-compute.js` | Implement backend adapters behind one interface. |
| `src/object-storage.js` | Require durable output import for hosted jobs. |
| `src/router.js` | Add `/v1/compute/quote`, `/v1/compute/launch`, `/v1/compute/import`. |
| `cli/kolm.js` | Add `kolm compute quote`, `kolm compute launch`, `kolm compute import`. |
| `tests/compute-broker.test.js` | Lock no-secret output, fallback logic, storage requirement, and cost caps. |

First smoke test:

```bash
node cli/kolm.js compute quote --task distill --budget 10 --target gguf:q4 --json
node --test --test-concurrency=1 tests/compute-broker.test.js
```

Metric impact:

- DX: users without GPUs get an answer instead of a dead end.
- Cost: jobs are quoted before launch.
- Enterprise: BYOC/local constraints are first-class.
- Proof: remote results are imported with hashes and receipts.

### 3.8 Adaptive Eval Lab

Goal: make K-score a credible standard instead of a product-specific number.

Invention: task-typed, calibrated, attack-aware K-score. Each score must state
task type, axes, thresholds, dataset, holdout split, adversarial probes, judge
version, confidence interval, and known blind spots.

K-score axes:

- exactness
- semantic equivalence
- schema validity
- tool correctness
- safety/policy compliance
- hallucination/risk
- latency/cost under target
- privacy correctness
- runtime compatibility

Implementation agents should build:

| File | Edit |
| --- | --- |
| `src/k-score-calibration.js` | Axis definitions, weighting, confidence intervals, and task profiles. |
| `src/bakeoff.js` | Export calibrated win/loss and confidence. |
| `scripts/bench-k-score.cjs` | Public benchmark runner. |
| `public/benchmarks.html` | Link raw report JSON, command line, dataset, date, hardware. |
| `tests/k-score-calibration.test.js` | Lock confidence interval math and no unscoped score claims. |

First smoke test:

```bash
node scripts/bench-k-score.cjs --fixture tests/fixtures/k-score-calibration.json --json
node --test --test-concurrency=1 tests/k-score-calibration.test.js
```

Metric impact:

- Quality: K-score becomes task-specific and calibrated.
- Proof: claims can cite raw reports.
- Enterprise: buyers can reproduce acceptance criteria.

### 3.9 Artifact Market Maker

Goal: make the registry useful as a decision engine, not a gallery.

Invention: rank artifacts by verified utility for a specific buyer context.
Inputs include task, license, runtime target, device, data sensitivity,
evidence depth, K-score freshness, dependency risk, and deployment cost.

Ranking function:

```txt
utility = task_fit
        + evidence_depth
        + runtime_fit
        + license_fit
        + security_fit
        + freshness
        - cost
        - dependency_blast_radius
        - certification_gap
```

Implementation agents should build:

| File | Edit |
| --- | --- |
| `src/artifact-market-maker.js` | Utility scoring and buyer-context filters. |
| `src/marketplace.js` | Replace generic sort with utility ranking. |
| `src/artifact-dependency-graph.js` | Add blast-radius score. |
| `cli/kolm.js` | Add `kolm hub recommend --task ... --target ...`. |
| `tests/artifact-market-maker.test.js` | Lock ranking, license filters, stale evidence penalty, and private registry scope. |

First smoke test:

```bash
node cli/kolm.js hub recommend --task redaction --target local-cpu --privacy phi --json
node --test --test-concurrency=1 tests/artifact-market-maker.test.js
```

Metric impact:

- Conversion: users find the right artifact faster.
- Proof: downloads do not outrank verified fit.
- Enterprise: license and dependency risk become visible.

### 3.10 Agent Tool Compiler

Goal: make Kolm the way to ship signed, auditable agent tools.

Invention: compile repeated agent traces into signed MCP/A2A tools with explicit
tool permissions, runtime policy, test fixtures, and receipts.

Pipeline:

1. Capture repeated agent calls, tool usage, failures, and human corrections.
2. Cluster repeated workflows.
3. Generate a typed tool schema.
4. Compile deterministic parts into a local artifact or rule bundle.
5. Attach tool permissions and policy.
6. Emit MCP server config, A2A card, test fixture, and verifier.
7. Runtime emits tool-call receipts.

Implementation agents should build:

| File | Edit |
| --- | --- |
| `src/agent-tool-compiler.js` | Trace cluster to MCP/A2A tool bundle. |
| `services/mcp/server.js` | Load signed tool bundles and enforce permissions. |
| `src/agent-telemetry.js` | Emit tool-call receipts and failure clusters. |
| `cli/kolm.js` | Add `kolm agent compile --from-traces --as-mcp`. |
| `tests/agent-tool-compiler.test.js` | Lock permission enforcement, trace provenance, and local/offline execution. |

First smoke test:

```bash
node cli/kolm.js agent compile --from-traces tests/fixtures/agent-traces.jsonl --as-mcp --dry-run --json
node --test --test-concurrency=1 tests/agent-tool-compiler.test.js
```

Metric impact:

- Cost: repeated agent calls become local or smaller artifacts.
- Security: tool permissions are explicit.
- DX: agents get installable tools instead of long prompt recipes.

### 3.11 Device Fit Autopilot

Goal: make model/device/runtime choice automatic and honest.

Invention: a device-fit solver that maps task and artifact constraints to
hardware, memory, runtime, and fallback.

Inputs:

- detected CPU/GPU/NPU
- memory and storage
- OS and browser capabilities
- target runtime availability
- model size and modality
- quantization plan
- privacy boundary
- offline requirement

Output:

- recommended model or artifact
- quantization target
- runtime target
- estimated p95 latency
- expected memory
- fallback plan
- proof command

Implementation agents should build:

| File | Edit |
| --- | --- |
| `src/device-fit-autopilot.js` | Constraint solver and recommendation engine. |
| `src/device-capabilities.js` | Normalize local/browser/mobile/edge capabilities into one profile. |
| `src/models.js` | Add device-fit query support. |
| `cli/kolm.js` | Add `kolm devices fit --artifact file.kolm --json`. |
| `tests/device-fit-autopilot.test.js` | Lock memory calculations, unsupported runtime handling, and fallback recommendations. |

First smoke test:

```bash
node cli/kolm.js devices fit --profile tests/fixtures/device-profiles/m3-mac.json --artifact tests/fixtures/demo.kolm --json
node --test --test-concurrency=1 tests/device-fit-autopilot.test.js
```

Metric impact:

- Portability: runtime/device fit is measured before deploy.
- Latency: users get realistic expectations.
- DX: no more guessing which model fits which device.

### 3.12 CodeGraph Product Index

Goal: reduce implementation-agent search cost and prevent product-route-doc
drift.

Invention: a local semantic product graph inspired by CodeGraph, but scoped to
Kolm's product truth. It indexes source symbols, routes, route metadata, CLI
verbs, TUI views, docs pages, tests, readiness requirements, and product claims.

Unlike generic code search, this index answers product questions:

- Which routes implement `train-distill`?
- Which public pages mention a claim with no benchmark evidence?
- Which CLI command lacks an account UI equivalent?
- Which tests lock a readiness requirement?
- What files must change for `runtime-wasm`?

Implementation agents should build:

| File | Edit |
| --- | --- |
| `scripts/build-product-codegraph.cjs` | Generate graph nodes and edges from source/docs/tests/routes. |
| `public/product-codegraph.json` | Generated local graph artifact. |
| `scripts/query-product-codegraph.cjs` | Query utility for agents and CI. |
| `scripts/audit-product-codegraph.cjs` | Gate missing edges and stale claims. |
| `cli/kolm.js` | Add `kolm graph query`, `kolm graph impact`, `kolm graph requirement`. |
| `tests/product-codegraph.test.js` | Lock route-doc-test-readiness crosslinks. |

First smoke test:

```bash
node scripts/build-product-codegraph.cjs --check --json
node scripts/query-product-codegraph.cjs --requirement runtime-wasm --json
node --test --test-concurrency=1 tests/product-codegraph.test.js
```

Metric impact:

- DX: agents spend fewer calls rediscovering source structure.
- Proof: every claim can be traced to code, tests, docs, and readiness state.
- Security: impact analysis catches route/policy changes before deploy.

## 4. Cross-Invention Build Order

This is the order that creates the most leverage with the least drift.

| Wave | Build | Why first |
| --- | --- | --- |
| W580 | CodeGraph Product Index | Gives implementation agents and CI a product-aware map before touching deeper systems. |
| W581 | Adaptive Eval Lab | Prevents false quality claims before optimizer work. |
| W582 | Build Strategy Brain | Stops unnecessary training and routes users to cheaper tactics. |
| W583 | Kolm-Q Oracle Quantizer | Directly improves latency/cost/portability for artifacts. |
| W584 | Distill Forge | Improves model quality using evidence and calibrated evals. |
| W585 | KolmIR AutoTarget Compiler | Makes all artifact/runtime targets structurally consistent. |
| W586 | ReceiptOS Evidence Fabric | Unifies proof across capture/build/run/governance. |
| W587 | Privacy Membrane Max | Turns privacy into measurable control-plane evidence. |
| W588 | Cloud Compute Broker | Makes training/distill/quantize accessible without local GPU. |
| W589 | Device Fit Autopilot | Makes deployment practical across edge/mobile/local. |
| W590 | Agent Tool Compiler | Turns repeated agent workflows into signed tools. |
| W591 | Artifact Market Maker | Converts the registry into a decision engine after proof/data exist. |

## 5. Implementation Contracts

Every implementation wave must ship:

1. A pure planner module.
2. A route or CLI entry that exposes the planner.
3. A receipt/proof object when state changes.
4. A deterministic fixture smoke test.
5. A product graph edge to journeys, readiness requirements, and metrics.
6. A claim-scope update that prevents premature marketing.
7. A docs paragraph that distinguishes shipped, implemented, benchmark-gated,
   package-gated, partner-gated, and certification-gated status.

No wave is complete if it only updates copy.

## 6. Metric Smoke Test

I added a deterministic simulation harness at
`scripts/simulate-invention-portfolio.cjs`. It reads the current product graph
and readiness ledger, then checks:

- every journey is covered
- every journey has at least two inventions
- every customization dimension is covered
- every open proof/release/partner gate is addressed by at least one invention
- every tracked metric class has expected lift
- the weighted composite improves over the baseline

Command:

```bash
node scripts/simulate-invention-portfolio.cjs
```

Expected current result:

```txt
ok: true
inventions: 12
journeys: 12
dimensions: 8
readiness_requirements: 55
open_requirements: 11
baseline_composite: 0.682
simulated_composite: 0.886
composite_delta: 0.204
```

This is intentionally a synthetic design smoke, not a model benchmark. It proves
coverage and internal consistency. Real claims still require implementation,
fixtures, hardware runs, public benchmark JSON, and production proof.

## 7. Atomic Backlog For Implementation Agents

### P0

| ID | Build | Files |
| --- | --- | --- |
| INV-P0-001 | CodeGraph Product Index generator and query CLI | `scripts/build-product-codegraph.cjs`, `scripts/query-product-codegraph.cjs`, `cli/kolm.js`, `tests/product-codegraph.test.js` |
| INV-P0-002 | Adaptive K-score task profiles and calibration fixtures | `src/k-score-calibration.js`, `scripts/bench-k-score.cjs`, `tests/k-score-calibration.test.js` |
| INV-P0-003 | Build Strategy Brain preflight | `src/build-strategy-brain.js`, `src/training-planner.js`, `src/optimization.js`, `tests/build-strategy-brain.test.js` |
| INV-P0-004 | Kolm-Q planner dry-run and receipt schema | `src/quantization-planner.js`, `src/quantization-receipt.js`, `workers/quantize/oracle-worker.cjs`, `tests/quantization-planner.test.js` |
| INV-P0-005 | Distill Forge planner and no-leak teacher provenance | `src/distill-forge.js`, `src/distill-pipeline.js`, `src/provider-registry.js`, `tests/distill-forge.test.js` |
| INV-P0-006 | ReceiptOS append/verify/export graph | `src/receipt-os.js`, `src/artifact.js`, `src/runtime.js`, `src/audit.js`, `tests/receipt-os.test.js` |
| INV-P0-007 | Privacy policy compiler and redaction benchmark runner | `src/privacy-policy-compiler.js`, `src/redaction-bench.js`, `src/privacy-membrane.js`, `tests/privacy-membrane-max.test.js` |
| INV-P0-008 | Compute quote/launch/import broker dry-run | `src/compute-broker.js`, `src/remote-compute.js`, `src/object-storage.js`, `tests/compute-broker.test.js` |

### P1

| ID | Build | Files |
| --- | --- | --- |
| INV-P1-001 | KolmIR schema and first compile pass migration | `src/kolm-ir.js`, `src/compiler-passes/*.js`, `src/compile-pipeline.js`, `tests/kolm-ir.test.js` |
| INV-P1-002 | Device Fit Autopilot | `src/device-fit-autopilot.js`, `src/device-capabilities.js`, `src/models.js`, `tests/device-fit-autopilot.test.js` |
| INV-P1-003 | Agent Tool Compiler | `src/agent-tool-compiler.js`, `services/mcp/server.js`, `src/agent-telemetry.js`, `tests/agent-tool-compiler.test.js` |
| INV-P1-004 | Artifact Market Maker utility ranker | `src/artifact-market-maker.js`, `src/marketplace.js`, `src/artifact-dependency-graph.js`, `tests/artifact-market-maker.test.js` |

### External Proof Gates

| Gate | What proves it |
| --- | --- |
| Public K-score calibration | Raw public benchmark JSON, command lines, model versions, datasets, hardware, thresholds |
| Public redaction F1 | Per-class precision/recall/F1 reports and false positive/negative examples |
| Public leaderboard | Reproducible comparisons against provider and open-model baselines |
| Package releases | npm/PyPI/Homebrew/winget/SwiftPM/Maven/npm RN package artifacts or signed release archives |
| External runtime adoption | Linked PR/plugin/package from Hugging Face, Ollama, llama.cpp, ONNX/GGUF, or hardware/runtime partner |
| Neutral format governance | Public RFC/governance packet and accepted external process |
| Compliance certification | Dated auditor/certification evidence or continued scoped language |

## 8. The Main Insight

Kolm should stop thinking of optimization as "make a smaller model." The
correct abstraction is:

```txt
Given evidence, constraints, and a target runtime, choose the cheapest
verifiable behavior that satisfies the quality gate.
```

Sometimes that answer is a rule bundle. Sometimes it is prompt caching.
Sometimes it is a RAG sidecar. Sometimes it is a distilled model. Sometimes it
is an OpenAI or Claude fallback. Sometimes it is a 3.5-bit KV cache policy.
Sometimes it is a full hosted training job. The product should make that
decision, prove it, and emit a portable artifact or policy.

That is the invention: not one quantizer, compiler, distiller, or gateway, but a
proof-preserving optimizer that chooses among all of them.
