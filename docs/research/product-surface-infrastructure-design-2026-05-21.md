# Kolm Product-Surface Infrastructure Design Research

Date: 2026-05-21
Status: research and infrastructure design memo only
Edit boundary: this document only; no code, generated site, manifest, route, or
test edits are implied by this file.

## 0. Purpose

The previous version of this memo was directionally correct but too shallow. It
named the right surfaces and cited the right class of competitors, but it did
not do enough engineering work. This revision is intended to be the artifact a
product, infra, ML, enterprise, and frontend team can build from.

It answers, for every Kolm product surface:

- What is the product line actually trying to become?
- Which competitors and open-source substrates define buyer expectations?
- Which academic and standards bodies constrain credible claims?
- What is the ideal infrastructure shape?
- What should Kolm copy, avoid, or outperform?
- What are the tactical build choices that would materially improve the line?
- What is the optimal launch, next, and strategic scope?
- What proof would be needed before marketing a claim as best-in-class?

Authoritative local inputs inspected:

- `docs/product-surfaces.json`
- `docs/product-journeys.json`
- `docs/product-sota-readiness.json`
- `docs/cloud-product-readiness.md`
- `docs/kolm-format-v1.md`
- `src/platform-capabilities.js`

External evidence uses official product docs, standards, and academic papers
where possible. Vendor marketing pages are treated as claims about buyer
expectations, not proof that those vendors perform perfectly.

## 1. Core Thesis

Kolm should not compete as a generic AI gateway, a generic evals dashboard, a
generic fine-tuning platform, a generic local model runner, or a generic
enterprise governance console. Those are now separate crowded categories.

Kolm's best category is:

> The artifact and evidence layer for private AI systems.

The winning product architecture is a trust pipeline:

1. Capture real production calls.
2. Normalize them into a tenant-fenced event lake.
3. Redact, retain, purge, or zero-store under policy.
4. Promote repeated workflows into governed datasets.
5. Split train/eval rows with verifiable disjointness.
6. Run evals, replay, bakeoffs, and K-score gates.
7. Train or distill through local, cloud, remote, or provider backends.
8. Compile the result into a signed `.kolm` artifact.
9. Verify the artifact offline.
10. Run it locally, in browser, on edge, in cloud, or behind fallback chains.
11. Publish, diff, roll back, or mirror it through a registry.
12. Export compliance, billing, trace, and audit evidence.

This creates a product that competitors are structurally unlikely to converge
on, because most monetize one substrate: hosted model calls, gateway routing,
observability, training jobs, model endpoints, or enterprise identity. Kolm can
monetize the portable evidence contract across all of them.

## 2. Source-Tier Rules

Use these proof tiers when making product and marketing claims:

Tier 1: normative specs, official docs, peer-reviewed or arXiv research,
standard bodies, legal/regulatory text.

Tier 2: official vendor docs and primary open-source docs.

Tier 3: vendor marketing pages, blogs, benchmark posts, case studies.

Tier 4: community reports and Reddit-style operational anecdotes.

Rule: Tier 3 and Tier 4 can motivate product decisions, but they cannot prove
Kolm is faster, safer, cheaper, compliant, or best-in-class. Those claims need
Tier 1 or reproducible internal benchmark evidence.

## 3. Product Surface Map

### 3.1 Certified Route Surfaces

1. `identity-access-billing`
2. `public-docs-sdk`
3. `compile-artifact-verification`
4. `runtime-inference-connectors`
5. `capture-data-eval-training`
6. `governance-compliance-security`
7. `deployment-edge-federated`

### 3.2 User Journeys

1. `gateway-capture`
2. `privacy-lake`
3. `datasets-labeling`
4. `train-distill`
5. `models-backbones`
6. `multimodal-tokenization`
7. `compile-verify`
8. `runtime-inference`
9. `compute-cloud`
10. `devices-fleet`
11. `enterprise-governance`
12. `agents-registry`

### 3.3 SOTA Readiness Groups

1. `format-standard`
2. `compile-train-distill`
3. `capture-gateway-lake`
4. `runtime-compute`
5. `registry-marketplace`
6. `infrastructure-enterprise`
7. `ai-ml-optimizer`
8. `developer-experience`

## 4. The Infrastructure Stack Kolm Should Converge On

### 4.1 Planes

Kolm needs four planes, each with a crisp trust boundary.

Data plane:

- provider proxy
- local daemon
- event lake
- dataset store
- artifact store
- local runtime
- device/runtime adapters

Control plane:

- auth
- org/workspace/team membership
- billing and quota
- cloud job dispatch
- registry publishing
- deployment plans
- policy configuration

Evidence plane:

- receipts
- artifact hashes
- split hashes
- eval results
- K-score axes
- audit log
- model/data cards
- SBOM/ML-BOM
- Sigstore/in-toto/SLSA attestations

Experience plane:

- public website and docs
- account console
- CLI
- TUI
- SDKs
- MCP/agent integrations
- OpenAPI
- local dashboard

### 4.2 Service Components

1. Gateway service
   - Native OpenAI-compatible ingress.
   - Native Anthropic Messages ingress.
   - OpenRouter, Gemini, local server, and artifact adapters.
   - Policy preflight.
   - Capture decisioning.
   - Zero-retention path.
   - Cost, latency, and token normalization.

2. Event lake service
   - Append-only event ingest.
   - Raw/redacted separation.
   - Tenant, workspace, namespace, source, and retention fields.
   - Privacy budget and DP aggregate support.
   - Export to JSONL, Parquet, OpenTelemetry, and SIEM destinations.

3. Dataset and eval service
   - Trace-to-dataset promotion.
   - Label queues.
   - Eval-as-code.
   - Holdout split manager.
   - Replay and bakeoff runner.
   - Online eval sampling.
   - K-score evidence builder.

4. Train/distill orchestrator
   - Local CPU/GPU executor.
   - Remote SSH GPU executor.
   - Managed GPU adapters: Modal, RunPod, Lambda GPU, Vast, Together, AWS,
     Azure, and GCP-compatible profiles.
   - Provider tuning/distillation adapters.
   - Job queue, checkpoint, resume, webhooks, cost quotes, and failure
     diagnostics.

5. Artifact builder
   - Deterministic `.kolm` assembly.
   - Manifest and receipt generation.
   - Runtime target export metadata.
   - Signature generation.
   - Dependency graph.
   - Version diff and rollback.

6. Verifier
   - Offline-first.
   - ZIP traversal safe.
   - Schema validation.
   - Hash validation.
   - Signature validation.
   - Train/eval overlap fail-closed.
   - K-score evidence validation.
   - Optional transparency-log and attestation validation.

7. Runtime broker
   - Local artifact run.
   - Browser/WASM/WebGPU run.
   - Edge/serverless run.
   - GPU serving engine route.
   - OpenAI-compatible fallback route.
   - Streaming and budget enforcement.
   - Runtime telemetry opt-in.

8. Registry
   - Public artifacts.
   - Private tenant artifacts.
   - Verified publisher metadata.
   - License and compliance tags.
   - Dependency graph and blast radius.
   - Usage/download stats.
   - Air-gap mirror bundles.

9. Enterprise control plane
   - SSO/SCIM.
   - RBAC and ABAC.
   - Scoped keys and service accounts.
   - Customer-managed keys.
   - Billing and usage.
   - Audit chain.
   - Compliance package export.
   - SIEM/webhook/OTEL export.

### 4.3 Canonical Data Objects

Kolm needs a small number of hard canonical objects:

- `Identity`: org, workspace, tenant, user, service account, API key.
- `ProviderCall`: request/response, provider, model, usage, cost, latency.
- `CaptureEvent`: normalized provider call plus privacy and provenance fields.
- `DatasetRow`: input, output, source, label state, checksum, policy.
- `EvalCase`: row or generated scenario with rubric, expected behavior, and
  grader.
- `TrainPlan`: teacher, student, method, compute, storage, budget, split.
- `CompileJob`: spec, dataset, evals, target, state, logs, cost, artifacts.
- `Artifact`: `.kolm` identity, manifest, receipt, targets, signatures.
- `RuntimeTarget`: hardware, format, quantization, memory, latency, fallback.
- `Deployment`: target, config, storage, attestation, rollout, rollback.
- `AuditEvent`: actor, action, target, evidence, hash chain.
- `ComplianceBundle`: artifact, logs, policy, SBOM/ML-BOM, DSR, subprocessors.

Every product UI should show these concepts rather than inventing one-off
labels per page.

## 5. Competitor Landscape By Layer

### 5.1 Gateway, Routing, Cost, And Provider Access

Competitors and substrates:

- Cloudflare AI Gateway: analytics, logging, caching, rate limiting, retries,
  fallback, provider control.
- Vercel AI Gateway: unified API, model/provider visibility, usage monitoring,
  request analytics, spend by project/API key.
- OpenRouter: provider routing, price/throughput/latency sorting, fallback.
- Portkey: gateway, cache, fallbacks, retries, load balancing, budget limits,
  guardrails, canary tests, MCP support.
- LiteLLM: proxy, spend tracking, budgets, virtual keys, model routing.
- Helicone: gateway, observability, caching, rate limits, session debugging,
  prompt management, cost tracking.
- Kong, Tyk, Apigee, Envoy, NGINX: generic API gateway primitives relevant to
  auth, rate limits, quotas, and observability.

What buyers expect now:

- One base URL.
- Bring-your-own provider keys.
- Key vault and virtual keys.
- Spend tracking.
- Per-project budgets.
- Rate limits.
- Retries and fallback.
- Caching.
- Provider health.
- Usage analytics.
- Request logging.
- Redaction controls.
- OpenAI-compatible API.
- Native Anthropic support.

What Kolm must copy:

- zero-friction provider setup
- per-provider route health
- per-namespace cost and latency
- fallback policies
- cache visibility
- custom provider/base URL support
- virtual keys and quotas

What Kolm must not copy:

- gateway-only positioning
- provider markup as the main margin driver
- storing customer payloads by default in regulated mode
- ambiguous "observability" without artifact promotion

Kolm differentiation:

- Gateway captures become datasets.
- Datasets become eval-gated artifacts.
- Artifacts run offline.
- Gateway spend reduction is proven by avoided calls, not only cached calls.

Tactical build choices:

- Add a per-namespace gateway policy object:
  `provider_order`, `fallbacks`, `cache_policy`, `capture_filter`,
  `privacy_mode`, `max_cost_usd`, `max_latency_ms`, `allowed_models`.
- Add provider health scoring from p50/p95/p99 latency, error rate, cost drift,
  model availability, and cache hit rate.
- Add capture-to-compile recommendations in the connector UI:
  "This namespace has 1,240 repeated calls; estimated artifact savings $X/mo;
  recommended student: Y; target runtime: Z."
- Add native Claude Messages examples everywhere OpenAI examples appear.
- Add self-hosted OpenAI-compatible endpoints as first-class: vLLM, SGLang,
  llama.cpp, Ollama, LM Studio, TGI, TensorRT-LLM.

### 5.2 Observability, Evals, Prompt Management, And Feedback Loops

Competitors and substrates:

- LangSmith: tracing, datasets, experiments, online evaluators, Studio.
- Langfuse: traces, datasets, dataset versions, experiments, annotations,
  online evals.
- Arize Phoenix/OpenInference: OpenTelemetry-based LLM traces and evals.
- W&B Weave: tracing, evaluation, datasets, model/prompt iteration.
- Braintrust: datasets, scorers, playgrounds, remote evals, production
  monitoring.
- Humanloop: prompts, tools, flows, datasets, evaluators, versioning by hash.
- Galileo: guardrail metrics, evals, observability.
- Promptfoo: CLI-first eval and red-team framework.
- OpenAI Evals/agent evals: datasets, graders, trace grading, eval runs.

What buyers expect now:

- Traces from dev and prod.
- Dataset creation from traces.
- Prompt/version hashes.
- Offline evals before deploy.
- Online sampled evals in production.
- Human annotation.
- LLM-as-judge and code graders.
- Regression dashboards.
- Side-by-side comparison.
- CI/CD integration.
- Agent trace grading.

Academic and frontier signal:

- HELM showed broad, scenario-based, multi-metric eval is more credible than
  one opaque leaderboard score.
- MMLU-style benchmarks are useful but not enough for product-specific quality.
- Prompt caching and trace replay create privacy and timing side channels if
  not modeled.
- Agent evals need workflow-level grading, not only final-message grading.

Kolm differentiation:

- Trace and eval evidence is not only dashboard state; it becomes artifact
  provenance.
- K-score should be portable and verifiable with the artifact.
- Eval splits should be protected by row hashes and explicit train/holdout
  separation.

Tactical build choices:

- Implement eval-as-code with deterministic graders and LLM judges:
  `kolm eval run --cases evals.ts --artifact task.kolm`.
- Add online eval sampling policies:
  sample by provider, namespace, artifact, risk score, or recent deploy.
- Add "promote trace to eval" with required privacy/provenance review.
- Add K-score axis details:
  exact-match, semantic similarity, schema validity, safety, latency, cost,
  robustness, distribution shift, privacy compliance.
- Add replay bundles:
  frozen inputs, expected behavior, grader versions, model versions, and
  target runtime.
- Add OpenTelemetry/OpenInference import/export so Kolm can sit beside
  LangSmith, Langfuse, Phoenix, Weave, Braintrust, and existing traces.

### 5.3 Training, Fine-Tuning, Distillation, And Adapter Serving

Competitors and substrates:

- OpenAI model distillation and fine-tuning: stored completions, evals, SFT.
- Amazon Bedrock: fine-tuning, continued pre-training, reinforcement
  fine-tuning, and distillation with teacher/student flow.
- Azure AI Foundry: model catalog, fine-tuning, serverless deployment.
- Google Vertex AI: managed tuning and Model Garden patterns.
- Predibase: LoRA/Turbo LoRA, adapter lifecycle.
- Together: fine-tuning, managed inference.
- Fireworks: LoRA deploy/live merge/multi-LoRA style serving.
- OpenPipe: trace-to-fine-tune workflow.
- Hugging Face TRL: SFT, DPO, GRPO, reward, and RL trainers.
- Unsloth: LoRA/QLoRA speed and VRAM optimization.
- Axolotl: full fine-tune, LoRA, QLoRA, GPTQ, preference tuning, RL variants.
- PEFT/bitsandbytes: adapter and quantization primitives.
- LoRAX/S-LoRA: multi-adapter serving concerns.

Academic signal:

- Distillation: large teacher behavior can be transferred into smaller student
  models.
- LoRA: adapt models through low-rank matrices rather than full weight updates.
- QLoRA: quantized fine-tuning dramatically lowers memory needs.
- DPO and preference optimization: direct preference training can avoid a
  separate reward-model phase.
- S-LoRA: many-adapter serving creates memory and scheduling problems that
  must be solved explicitly.
- Memorization and PII leakage research means provider fine-tunes and local
  fine-tunes must be tested for privacy leakage, not assumed safe.

Kolm differentiation:

- Kolm should not become another training cloud.
- The moat is choosing and proving the right method, then packaging the result
  into a portable artifact with eval and provenance evidence.

Tactical build choices:

- Add a TrainPlan decision engine:
  - If data < 50 rows: do not train; use recipe/eval expansion.
  - If repeated deterministic extraction/classification: compile recipe or
    small classifier first.
  - If 50-5,000 high-quality rows: LoRA/QLoRA candidate.
  - If tool-call behavior is stable: consider QLoRA to internalize tool schema.
  - If strict privacy: local/SSH/BYOC only.
  - If no GPU: Modal/RunPod/Together/AWS/Azure/GCP path.
- Add method recommendations:
  SFT, LoRA, QLoRA, DPO, preference optimization, synthetic distillation,
  on-policy distillation, prompt compression, RAG artifact, or no-train.
- Add cost and time estimates by compute target.
- Add failure diagnostics:
  too few examples, train/eval leakage, label noise, class imbalance, task
  ambiguity, unsafe PII, insufficient holdout, low schema validity.
- Add model/license compatibility checks before training.
- Add post-training privacy tests: memorization probes, canary extraction,
  PII emission checks.

### 5.4 Runtime, Serving, And Inference Optimization

Competitors and substrates:

- vLLM: OpenAI-compatible serving, PagedAttention, high throughput.
- SGLang: high-performance LLM/VLM serving, disaggregated prefill/decode,
  speculative decoding, optimized scheduling, OpenAI-compatible APIs.
- Ray Serve LLM: multi-node/multi-model deployment, OpenAI API compatibility,
  autoscaling, monitoring, multi-LoRA, engine-agnostic vLLM/SGLang style.
- TensorRT-LLM: NVIDIA optimized engines, in-flight batching, paged attention,
  quantization, streaming.
- Hugging Face TGI: token streaming, continuous batching, tensor parallelism,
  OpenTelemetry/Prometheus, safetensors, quantization.
- BentoML: unified inference platform, OpenAI-compatible vLLM endpoints, OCI
  images, cloud deployment.
- KServe: Kubernetes-native standardized AI inference, inference graphs,
  ModelMesh high-density serving.
- OpenVINO GenAI: Intel CPU/GPU/NPU inference.
- ONNX Runtime: execution providers for CUDA, TensorRT, DirectML, OpenVINO,
  CoreML, ROCm, NNAPI, and more.
- llama.cpp: GGUF/local inference and OpenAI-compatible server.
- Ollama: local runtime, model management, REST API.
- MLX: Apple Silicon local inference/training ecosystem.

Academic/frontier signal:

- PagedAttention/vLLM makes KV-cache memory management a first-order serving
  problem.
- Prompt caching can cut latency/cost, but cached-prefix semantics are
  provider-specific and can introduce privacy/timing concerns.
- Production serving needs workload-aware scheduling: prefill/decode split,
  batching, cache routing, and QoS policies.

Kolm differentiation:

- Kolm should not replace these engines.
- Kolm should target them, verify them, and keep one artifact identity across
  runtime targets.

Tactical build choices:

- Add runtime target contracts:
  `format`, `engine`, `hardware`, `quantization`, `max_context`,
  `expected_p95_ms`, `memory_mb`, `streaming`, `tool_calling`, `schema_output`,
  `fallback_policy`, `verification_state`.
- Add runtime conformance tests per engine:
  chat, JSON schema, tool call, streaming, embeddings, refusal/safety,
  deterministic seed if supported.
- Add prefix/cache-aware routing:
  stable system/tool context at beginning, dynamic context at end, provider
  cache hints preserved, local artifact hot path preferred when compiled.
- Add load-test profiles:
  burst, steady, long-context, short prompt, streaming, multi-tenant.
- Add per-runtime downgrade rules:
  if browser/WASM cannot meet memory target, recommend smaller student or
  serverless route instead of claiming support.

### 5.5 Edge, Mobile, Browser, And Device Fleet

Competitors and substrates:

- Apple Core ML: native optimized Apple on-device runtime.
- Apple Foundation Models framework: platform-native local model access.
- Google LiteRT: Android and edge runtime with hardware acceleration.
- ExecuTorch: PyTorch edge/mobile runtime.
- ONNX Runtime Mobile: cross-platform mobile/edge execution.
- OpenVINO: Intel CPU/GPU/NPU edge inference.
- Qualcomm QNN/Hexagon: mobile/edge NPU target.
- TensorRT-LLM/Triton: Jetson and NVIDIA edge GPU.
- WebLLM/Transformers.js/WASM/WebGPU patterns: browser inference.

What buyers expect:

- Device detection.
- Runtime recommendation.
- Install/test workflow.
- Memory and latency estimates.
- Mobile SDK packages.
- Rollback.
- Offline verification.
- Air-gap export.

Kolm differentiation:

- The native platforms provide inference; Kolm provides artifact identity,
  eval evidence, policy, rollout, and audit.

Tactical build choices:

- Add device profiles:
  iOS ANE/CoreML, Android QNN/LiteRT, Apple MLX, Intel OpenVINO, browser
  WebGPU/WASM, Jetson TensorRT, CPU-only, air-gapped server.
- Add `kolm device simulate --artifact task.kolm --target iphone-15-pro`.
- Add install manifests:
  target, binary/package, runtime adapter, checksum, rollback version,
  health test, expected latency.
- Add fleet channels:
  dev, staging, canary, prod, offline export.
- Add "proof of installability" receipts after artifact push and smoke run.

### 5.6 Cloud, Storage, BYOC, And Hosted Compute

Competitors and substrates:

- Cloudflare R2: S3-compatible storage with documented compatibility
  differences.
- AWS S3/KMS/Bedrock/SageMaker/EKS: enterprise default for storage, keys,
  managed model customization, and BYOC.
- Supabase Storage: S3-compatible object API for app-centric teams, but with
  differences such as no S3 bucket versioning.
- Modal: serverless containers and GPU jobs.
- RunPod: serverless GPU endpoints and pods.
- Lambda GPU, Vast, CoreWeave, Together, Fireworks, Replicate, fal: rented or
  managed compute substrates.
- Kubernetes, Ray, KServe, BentoML: customer-hosted serving and orchestration.

Infrastructure rule:

Storage and compute must be separate. Artifacts, receipts, eval splits, and
logs should live in durable storage; training and serving are replaceable
compute backends.

Tactical build choices:

- Add a StoragePlane abstraction:
  local, R2, S3, Supabase, MinIO, Azure Blob, GCS.
- Add a ComputePlane abstraction:
  local, SSH, Docker, Kubernetes, Modal, RunPod, Lambda, Together, Bedrock,
  Azure, Vertex, Fireworks, Replicate.
- Add storage smoke:
  put, get, head, list, delete, multipart, checksum, presigned URL, KMS/BYOK
  capability.
- Add compute smoke:
  dry-run, quote, upload dataset hash, run noop job, pull artifact receipt.
- Add BYOC deployment bundles:
  Terraform, Helm, Docker Compose, Railway/Vercel notes, Cloudflare Worker,
  AWS Lambda/container, Kubernetes GPU.
- Add a readiness UI that shows "configured", "unconfigured", "blocked by
  credential", "blocked by provider limitation", and "not marketed".

### 5.7 Artifact Format, Registry, And Verification

Comparable standards:

- OCI artifacts/Docker registries: content addressing, registries, tags,
  distribution, pull/push UX.
- ONNX: open interchange across frameworks/runtimes.
- GGUF: practical local model file with metadata for llama.cpp ecosystem.
- safetensors: safer tensor serialization.
- MLflow Model Registry: versions, aliases, tags, lineage, annotations.
- Hugging Face Hub: model/dataset cards, tags, discoverability, model repos.
- DVC/lakeFS: Git-like data versioning and pipeline/data reproducibility.
- Sigstore/Cosign: signing, verification, transparency log.
- in-toto/SLSA: supply-chain attestations and provenance.
- CycloneDX ML-BOM/SPDX: bill of materials patterns.

Kolm differentiation:

- `.kolm` should become the task artifact, not just a model artifact.
- It packages what to run, why it is trusted, how it was evaluated, what data
  it may touch, what runtime target it expects, and how to verify it.

Tactical build choices:

- Treat `.kolm` v1 as the normative contract, with:
  manifest, receipt, evals, train/eval split hashes, runtime target entries,
  model/recipe payload, license, permissions, SBOM/ML-BOM, attestations.
- Add standalone verifier distribution:
  npm, PyPI, Homebrew, winget, Docker image, single binary.
- Add registry countersigning:
  publisher signature first; registry adds countersignature and transparency
  bundle; offline artifact remains valid without registry.
- Add artifact diff:
  model, recipe, prompt, eval rows, K-score axes, runtime target, policy,
  dependencies.
- Add dependency graph:
  base model, adapter, tokenizer, datasets, eval set, runtime, SDK, compiler,
  signing key, storage backend.
- Add revocation and trust policy:
  bad signer, vulnerable dependency, expired model license, deprecated runtime.

### 5.8 Enterprise Governance, Security, Privacy, And Compliance

Competitors and standards:

- WorkOS: SSO, Directory Sync/SCIM, Admin Portal, Audit Logs, Fine-Grained
  Authorization, Vault.
- Auth0 Organizations: B2B org membership, organization login, M2M access.
- Stripe Billing: subscriptions, usage billing, portal, invoices, entitlements.
- Okta, Azure AD, Google Workspace: enterprise identity expectations.
- NIST AI RMF and NIST AI 600-1 Generative AI Profile.
- ISO/IEC 42001 AI management system.
- EU AI Act risk management, technical documentation, logging, transparency,
  post-market monitoring for high-risk use cases.
- OWASP LLM Top 10 and OWASP MCP Top 10.
- SOC 2, HIPAA BAA, ISO 27001, FedRAMP, GDPR, DPA/DSR processes.

Academic and standards signal:

- Governance for autonomous agents increasingly requires external action
  inventories, data-flow inventories, and behavioral drift monitoring.
- AI compliance is moving from static policy documents to continuous evidence
  pipelines.
- Agent systems need exact tool permissions, traceability, and human oversight
  because behavior can drift after prompt/model/tool changes.

Kolm differentiation:

- Kolm can sell compliance evidence for AI artifacts, not just "secure SaaS".
- The compliance bundle should prove data lineage, model lineage, eval gates,
  runtime policy, audit trail, and deployment state.

Tactical build choices:

- Add an enterprise evidence schema:
  AI system inventory, use-case risk class, affected persons, data categories,
  model/provider, artifact ID, evals, logs, human oversight, security controls.
- Add CMK/BYOK:
  KMS key refs for storage, capture lake, artifact signing, and audit exports.
- Add SIEM export:
  Splunk, Datadog, Elastic, Chronicle, Sentinel, generic webhook.
- Add DSR/purge workflows:
  raw event purge, redacted event retention, artifact retrain warning if row
  was used in training, compliance evidence update.
- Add risk classification:
  "minimal", "limited transparency", "high-risk candidate", "prohibited
  candidate", "requires legal review".
- Add admin approvals:
  publish artifact, train on sensitive data, enable hosted teacher, deploy to
  device fleet, export compliance bundle.

### 5.9 Models, Backbones, And Model Selection

Competitors and substrates:

- Hugging Face Hub: model cards, dataset cards, metadata, search, tags.
- OpenAI, Anthropic, Google, Mistral, Cohere, AWS, Azure, OpenRouter:
  hosted frontier and broad provider catalogs.
- Gemma/Gemma 3n/EmbeddingGemma/MedGemma: specialized open model families.
- Llama, Qwen, Mistral, Phi, DeepSeek, SmolLM, Mixtral, Granite, Falcon:
  common open-weight student/backbone choices.
- MLflow model registry and model aliases for lifecycle management.

Academic signal:

- Model cards exist because intended use, limitations, datasets, and evals are
  not captured by file names or leaderboard rank.
- Dataset cards and documentation audits show model/dataset documentation is
  often incomplete; product systems must enforce metadata at publish time.

Kolm differentiation:

- The model page should not be a catalog. It should be a decision engine.
- It should answer: for this task, data sensitivity, target runtime, budget,
  latency, modality, and license, what should I use?

Tactical build choices:

- Add model selectors:
  task type, modality, context, hardware, license, privacy, cost, latency,
  tool-use, structured output, multilingual, domain.
- Add model cards for Kolm artifacts:
  base model, training data summary, evals, intended use, limitations,
  risk class, runtime targets, license, dependencies.
- Add deprecation alerts:
  provider model retired, license change, benchmark regression, vulnerability.
- Add "do not train" recommendations:
  task can be compiled as rule/recipe/RAG, or data is too sparse/noisy.
- Add device-fit estimates:
  memory, expected p95 latency, package size, quantization loss, fallback.

### 5.10 Multimodal Tokenization, Media, RAG, And Workflow IR

Competitors and substrates:

- LlamaIndex, LangChain, Haystack: RAG and pipeline frameworks.
- Unstructured, Apache Tika, Docling, Marker: document parsing/OCR patterns.
- Whisper/faster-whisper, Vosk, local ASR: audio transcription.
- CLIP/SigLIP/BLIP/Gemma VLM families: image/video feature and captioning.
- pgvector, Qdrant, Milvus, Weaviate, Pinecone, LanceDB: vector storage.
- RAGAS, TruLens, DeepEval, Phoenix, LangSmith: RAG eval patterns.

Academic signal:

- RAG improves knowledge-grounded generation but introduces retrieval failure,
  stale index, injection, and citation/provenance issues.
- Multimodal eval is still much less mature than text eval; per-modality
  metrics and human review remain important.
- RAG systems need retrieval metrics and answer metrics separately.

Kolm differentiation:

- "RAG as artifact" is stronger than "RAG dashboard".
- A `.kolm` RAG artifact should include chunking policy, embedding model,
  index digest, retriever settings, reranker, prompt, eval cases, and runtime
  target.

Tactical build choices:

- Add media sidecar contract:
  original hash, extracted text, local features, caption source, transcript
  source, redaction state, storage URI, eval eligibility.
- Add RAG artifact manifest members:
  `retriever.json`, `index.digest`, `chunks.manifest.jsonl`,
  `embedding_model.json`, `reranker.json`, `citations.policy.json`.
- Add RAG eval axes:
  retrieval recall, groundedness, citation precision, answer correctness,
  refusal correctness, privacy leakage, latency.
- Add multimodal compile targets:
  image classifier, document extractor, audio triage, PDF redactor, video
  scene classifier, code/document hybrid RAG.

### 5.11 Agents, MCP, Tooling, And Registry

Competitors and standards:

- Model Context Protocol: open protocol for tools, resources, and prompts.
- Claude Code MCP and channels.
- Cursor MCP servers and install flows.
- OpenAI Agents SDK: tracing and evals around agent workflows.
- Promptfoo agent/red-team skills.
- MCP security research and OWASP MCP Top 10.

What buyers expect:

- one-click install
- tool discovery
- scoped permissions
- OAuth where needed
- tool-call tracing
- tool-use evals
- replay
- marketplace/review

Academic/security signal:

- MCP standardizes tool integration but does not solve all production security
  problems.
- Tool descriptions influence model behavior and should be linted/evaluated.
- Prompt injection, context over-sharing, token/secret exposure, and excessive
  agency are central risks.

Kolm differentiation:

- `.kolm` can become the signed auditable unit of agent capability.
- A compiled artifact as an MCP tool can have fixed permissions, evals, logs,
  replay, versioning, and rollback.

Tactical build choices:

- Add MCP artifact manifest fields:
  tools, permissions, OAuth scopes, data classes, dangerous actions, human
  confirmation requirements, replay logs.
- Add MCP tool-description linter:
  accuracy, completeness, ambiguity, hidden side effects, prompt-injection
  surface, excessive permissions.
- Add install receipts:
  client, server, tool set, version, hash, permissions, approval actor.
- Add agent evals:
  tool selection accuracy, tool argument validity, refusal correctness,
  rollback behavior, secret handling, multi-turn drift.
- Add registry trust policy:
  verified publisher, permission diff, vulnerable dependency, revoked tool,
  lookalike name detection.

### 5.12 Main Competitor Diligence The First Draft Underweighted

The first version of this memo named useful substrate tools, but it still missed
the actual buyer shortlist. Kolm will not be compared only against LiteLLM,
LangSmith, OpenAI fine-tuning, or open-source runtimes. Serious buyers will
compare it against the platforms they already trust for data gravity,
procurement, governance, GPU deployment, labeling, evals, security, and
developer workflow.

This is the corrected competitor map.

#### A. Enterprise AI Operating Systems

Main competitors:

- Databricks Mosaic AI
- Snowflake Cortex AI
- Palantir AIP
- AWS Bedrock plus SageMaker
- Google Vertex AI
- Azure AI Foundry
- DataRobot
- Dataiku
- Domino Data Lab

Why they matter:

- They sit next to enterprise data, IAM, audit logs, procurement, security
  review, and compliance workflows.
- They turn AI adoption into expansion of an existing platform budget.
- Their strongest selling point is not only model quality. It is governance,
  enterprise familiarity, deployment maturity, and proximity to data.

What they do well:

- Databricks Mosaic AI owns lakehouse data gravity, MLflow lineage, Unity
  Catalog governance, vector search, model serving, foundation-model APIs,
  agent serving, external models, and analytics workflows.
- Snowflake Cortex owns warehouse-native AI, SQL-driven fine-tuning, governed
  sharing, native access control, and the "keep data in Snowflake" narrative.
- Palantir AIP owns operational ontology, agent/eval infrastructure, Apollo
  deployment, edge/disconnected narratives, and C-suite trust in high-stakes
  operating environments.
- AWS, Azure, and Google own cloud-native training, hosted model catalogs,
  private networking, KMS, region controls, compliance inheritance, and large
  procurement channels.
- DataRobot, Dataiku, and Domino own classic MLOps buying centers:
  governance, notebooks/workspaces, model risk management, experiment tracking,
  regulated deployment, and non-engineer AI workflows.

How Kolm should counterposition:

- Do not compete as "another AI platform." That loses to data gravity and
  procurement gravity.
- Compete as the artifact and evidence layer those platforms do not cleanly
  provide:
  - portable `.kolm` artifact
  - verifiable compile receipt
  - eval-bound K-score
  - provider-independent trace-to-artifact lineage
  - local/offline runtime
  - reproducible train/holdout proof
  - registry plus verifier that can operate outside the originating cloud
- Treat Databricks, Snowflake, AWS, Azure, Google, and Palantir as data-plane
  and deployment targets. The enterprise story should be:
  "Keep your data and compute where they are. Kolm compiles, signs, verifies,
  routes, and proves the AI artifact across them."

Tactical implications:

1. Add first-class data-plane connectors for Snowflake tables, Databricks
   Unity Catalog/Volumes, S3, R2, Supabase Storage, Azure Blob, and GCS.
2. Add `kolm import-traces` for Databricks/MLflow, LangSmith, Langfuse,
   Braintrust, OpenTelemetry, and W&B Weave traces.
3. Add deployment recipes for Databricks Model Serving, Snowflake external
   functions or Cortex-adjacent SQL workflows, SageMaker endpoints, Bedrock
   custom/imported models where applicable, Vertex endpoints, Azure AI Foundry,
   and Kubernetes/KServe.
4. Add procurement-grade exports:
   AI inventory row, model card, dataset card, eval card, AI-BOM, SBOM, SLSA
   provenance, privacy lineage, and auditor package.
5. Add coexistence docs:
   `Kolm with Databricks`, `Kolm with Snowflake`,
   `Kolm with AWS Bedrock and SageMaker`, `Kolm with Azure AI Foundry`,
   `Kolm with Vertex AI`, and `Kolm with Palantir AIP`.

The enterprise-platform competitor set is the highest-risk omission because it
changes positioning. Kolm should not be framed as a replacement for enterprise
AI platforms at launch. It should be framed as the portable evidence, compile,
and artifact layer those platforms lack.

#### B. Fine-Tuning, Distillation, And Specialized Model Platforms

Main competitors:

- OpenAI fine-tuning and model distillation workflows
- Anthropic as a premium teacher/inference provider, even without symmetric
  public fine-tuning
- AWS Bedrock customization
- Google Vertex AI tuning
- Azure AI Foundry tuning and deployment
- Predibase
- Lamini
- Arcee
- OpenPipe
- Together AI
- Fireworks AI
- Hugging Face TRL
- Unsloth
- Axolotl
- PEFT and bitsandbytes
- LoRAX/S-LoRA style multi-adapter serving

Why they matter:

- This is the most direct overlap with Kolm's distill/train/compile story.
- Researchers are comfortable assembling Unsloth, Axolotl, TRL, PEFT, vLLM,
  and Hugging Face datasets themselves.
- Managed buyers want "fine-tune this model and deploy it" without caring
  about artifact format.
- The strongest competitors will own either the teacher model, GPU economics,
  adapter serving, or data workflow.

What they do well:

- OpenAI owns stored completions, evals, fine-tuning, and distillation into
  provider-hosted models.
- Predibase, Lamini, Together, Fireworks, and OpenPipe reduce adapter
  fine-tuning and hosted deployment pain.
- Unsloth and Axolotl are strong for practitioners because they turn local or
  rented GPU fine-tuning into repeatable recipes.
- Hugging Face TRL/PEFT/bitsandbytes are research-standard building blocks.
- LoRAX/S-LoRA style systems make multi-adapter serving economically attractive
  by sharing base weights across many adapters.

How Kolm should counterposition:

- Do not claim "we fine-tune better than every backend" without public
  benchmark proof. That claim is easy to attack.
- Own the end-to-end contract:
  captured production behavior -> curated dataset -> frozen holdout -> compile
  plan -> backend execution -> artifact -> receipt -> verifier -> runtime.
- The compiler should choose among backends. The moat is not one LoRA trainer.
  The moat is TrainPlan, K-score, lineage, artifact packaging, and runtime
  proof.
- "Distill frontier models" should mean:
  use frontier models as teachers when policy and credentials allow, freeze
  teacher outputs with provenance, run holdout gates, train the best feasible
  student on available compute, and emit a portable artifact with honest
  limitations.

Tactical implications:

1. Add a `TrainPlan` object that makes backend choice explicit:
   local CPU, local CUDA, local Apple MLX, remote SSH GPU, Modal, RunPod,
   Replicate, Baseten, Together, Fireworks, SageMaker, Vertex, Azure, Bedrock,
   or user-provided Kubernetes.
2. Add training method selection:
   SFT, preference tuning/DPO, LoRA, QLoRA, full fine-tune when practical,
   adapter merge, quantization-only, prompt compression-only, RAG artifact, and
   rule/classifier artifact.
3. Add model-family capability registry:
   context length, tokenizer hash, license, quantization targets, multimodal
   support, fine-tune method, serving runtime, memory estimate, and
   commercial-use status.
4. Add backend adapters instead of one monolithic trainer:
   `TrainerAdapter`, `TeacherAdapter`, `EvalAdapter`, `QuantizerAdapter`,
   `ServingAdapter`.
5. Add an honest "cannot train this here" path:
   if the user has no GPU, the UI/CLI should propose cloud compute, smaller
   student, adapter-only training, quantization-only, or capture-more-data.
6. Add researcher mode:
   export Hugging Face dataset, Axolotl config, Unsloth notebook, TRL script,
   vLLM deploy command, and `.kolm` wrapping manifest.

The product should let top AI researchers bring their own stack while still
giving Kolm credit for receipts, evals, K-score, portability, and registry
trust.

#### C. GPU Cloud, Serverless Inference, And Model Deployment

Main competitors:

- Baseten
- Replicate
- Modal
- RunPod
- Together AI dedicated endpoints
- Fireworks AI deployments
- Anyscale/Ray Serve
- BentoCloud/BentoML
- KServe on Kubernetes
- CoreWeave and other GPU infrastructure providers

Why they matter:

- They solve the "I do not have a GPU" problem more directly than Kolm.
- They expose hardware choice, autoscaling, warm pools, cold-start controls,
  logs, metrics, private endpoints, and deployment APIs.
- If Kolm forces users to install a toolchain before proving value, GPU cloud
  competitors will feel easier.

What they do well:

- Baseten turns Truss pushes into GPU deployments with autoscaling and stable
  endpoints.
- Replicate packages arbitrary model code with Cog, provides playgrounds,
  public/private models, deployments, hardware choice, metrics, and scaling.
- Modal offers Python-native serverless GPU execution and a strong developer
  workflow for training/inference jobs.
- RunPod exposes pods and serverless endpoints with configurable GPUs, worker
  scaling, sync/async modes, and model caching.
- Together and Fireworks combine high-throughput inference with fine-tuning and
  dedicated deployment options.

How Kolm should counterposition:

- Do not become a GPU cloud first. That is capital intensive and operationally
  distracting.
- Become the control layer that can dispatch compile/train/serve jobs to the
  best GPU substrate, collect receipts, and package the resulting artifact.
- The cloud product should initially be brokered compute:
  "Use Kolm-managed defaults or connect your own AWS, Modal, RunPod, Replicate,
  Baseten, Together, Fireworks, or Kubernetes account."

Tactical implications:

1. Add `ComputeProvider` integrations with a uniform contract:
   estimate, submit, stream logs, cancel, artifact output, cost report, region,
   GPU type, privacy mode, and retention policy.
2. Add compute recommendation UI:
   "Your compile needs about 48 GB VRAM. Cheapest reliable paths: Modal A100,
   RunPod A100, SageMaker g5.12xlarge, or smaller QLoRA plan."
3. Add cost and latency receipt:
   every remote job returns estimated cost, actual cost when available, wall
   time, hardware, image digest, environment hash, and output hash.
4. Add cloud failure fallback:
   if provider A has no GPU capacity or fails health checks, suggest provider B
   or a smaller student plan.
5. Add bring-your-own-bucket artifact storage:
   R2/S3/Supabase/Azure/GCS with signed URLs and KMS/BYOK where available.

The best launch scope is not "Kolm owns GPUs." It is "Kolm makes any GPU cloud
usable for verifiable compilation."

#### D. Observability, Evals, Prompt Management, And Feedback Loops

Main competitors:

- LangSmith
- Langfuse
- Braintrust
- Humanloop
- W&B Weave
- Arize Phoenix
- Galileo
- Patronus AI
- Arthur
- Fiddler
- Promptfoo
- DeepEval/RAGAS-style open-source eval harnesses

Why they matter:

- These are often the first tools teams buy before training anything.
- They own dashboards, trace browsing, prompt/version management, datasets,
  eval experiments, online monitoring, alerts, human review, and CI evals.
- They will be perceived as "enough" if Kolm only captures logs.

What they do well:

- LangSmith and Langfuse own tracing plus prompt/eval loops for developer
  teams, with strong integrations into existing app frameworks.
- Braintrust and Humanloop are strong for prompt experiments, datasets,
  evaluator workflows, and product-team-friendly iteration.
- W&B Weave appeals to ML teams already using W&B for experiments.
- Arize Phoenix and OpenInference align with OpenTelemetry-style tracing.
- Arthur, Fiddler, Patronus, and Galileo push toward enterprise monitoring,
  safety scoring, production alerts, and trust metrics.

How Kolm should counterposition:

- Ingest from these systems instead of forcing replacement.
- Export to OpenTelemetry/OpenInference and import traces from LangSmith,
  Langfuse, Braintrust, W&B, and Phoenix where APIs allow.
- Kolm's unique claim should be:
  "Observability tells you what happened. Kolm turns repeated, verified
  behavior into a signed artifact that can run cheaper, faster, locally, and
  with evidence."

Tactical implications:

1. Add trace import/export adapters:
   OpenTelemetry GenAI, OpenInference, Langfuse, LangSmith, Braintrust, W&B
   Weave, Phoenix.
2. Add experiment diff:
   prompt version, model, dataset slice, judge, cost, latency, K-score, and
   artifact output.
3. Add online-to-offline promotion:
   production traces become dataset candidates only after redaction, policy,
   dedupe, label/eval status, and tenant checks.
4. Add evaluator registry:
   deterministic validators, code evals, LLM judges, human labels, RAG
   faithfulness, security probes, schema validators, and policy checks.
5. Add monitoring-to-compile recommendation:
   repeated task, stable output distribution, high provider cost, and low
   variance should trigger a compile candidate.

Kolm should win by completing the loop these tools start.

#### E. Data Labeling, Synthetic Data, And Human Evaluation

Main competitors:

- Scale AI and SEAL
- Labelbox
- Snorkel Flow
- Surge AI
- Appen/TELUS style data workforces
- Gretel
- Tonic
- Mostly AI and synthetic-data vendors

Why they matter:

- High-quality training data is the bottleneck for specialized models.
- Expert-labeled evals are more credible than generic LLM judges.
- Synthetic data and redaction vendors can become the data layer before Kolm
  sees any signal.

What they do well:

- Scale and Surge sell expert human data and RLHF-style workflows.
- Labelbox provides labeling, model run metrics, multimodal chat evaluation,
  and preference data workflows.
- Snorkel Flow gives enterprises programmatic labeling, SME knowledge capture,
  weak supervision, guided error analysis, and model/eval iteration.
- Gretel, Tonic, and related vendors solve privacy-preserving synthetic data
  generation and test-data generation.

How Kolm should counterposition:

- Do not fake being a managed expert-labeling company.
- Provide the schema, queue, provenance, active-learning priority, and eval
  binding that lets internal SMEs or external label vendors contribute safely.
- The key product move is "evidence-grade labels":
  label author, policy, source row hash, redaction status, adjudication state,
  eval membership, train/holdout membership, and downstream artifacts affected.

Tactical implications:

1. Add LabelQueue as a first-class object:
   task, row, policy, priority, suggested label, human label, adjudication,
   reviewer, and provenance.
2. Add active learning:
   prioritize ambiguous, high-cost, high-frequency, high-regret, or
   distribution-shift examples.
3. Add vendor export/import:
   CSV/JSONL formats compatible with Labelbox, Scale-style labeling tasks, and
   generic review tools.
4. Add SME review UI:
   approve for train, approve for eval, redact, exclude, needs policy,
   ambiguous.
5. Add synthetic-data receipts:
   generator model, prompt, seed, source examples, privacy transform, filter
   results, and whether synthetic rows are allowed in holdout.

Without data and label workflow depth, the compile story becomes a demo instead
of a production improvement loop.

#### F. RAG, Knowledge Systems, And Enterprise Search

Main competitors:

- Pinecone Assistant
- Vectara
- Weaviate
- LlamaIndex
- LangChain/LangGraph
- Unstructured
- LlamaParse
- Qdrant/Milvus/pgvector
- Cohere Rerank/Embed style retrieval APIs

Why they matter:

- Many teams will ask whether they need Kolm at all if a RAG stack solves the
  use case.
- RAG vendors own "chat with your data", ingestion, chunking, hybrid search,
  reranking, retrieval evaluation, source grounding, and hallucination scoring.
- In practice, many enterprise AI apps are RAG plus workflow plus evals, not
  fine-tuned models.

What they do well:

- Pinecone Assistant abstracts RAG plumbing into a managed assistant API.
- Vectara exposes hallucination evaluation and correction around grounded
  generation.
- Weaviate provides hybrid search, explainable scores, multimodal search paths,
  and RAG integrations.
- Unstructured and LlamaParse focus on document extraction, chunking, OCR, and
  ingestion quality.
- LlamaIndex and LangChain/LangGraph own developer workflows for retrieval and
  agentic orchestration.

How Kolm should counterposition:

- Support RAG artifacts, not dismiss RAG as inferior to fine-tuning.
- A `.kolm` artifact can package:
  retrieval policy, embedding model hash, chunking strategy, index schema,
  source-document hashes, reranker, generation model, eval suite, fallback
  policy, and hallucination checks.
- The pitch should be:
  "Kolm turns a RAG pipeline into a signed, auditable, portable AI system."

Tactical implications:

1. Add `rag` artifact type with separate receipts for ingestion, retrieval,
   generation, and evaluation.
2. Add document extraction provenance:
   parser version, OCR engine, chunk IDs, source hashes, table/image handling,
   and rejected chunks.
3. Add retrieval evals:
   recall@k, MRR, answer faithfulness, source coverage, citation accuracy, and
   hallucination score.
4. Add vector-store adapters:
   Pinecone, Weaviate, Qdrant, Milvus, pgvector, LanceDB, local FAISS.
5. Add "RAG vs compile" recommendation:
   use RAG when knowledge changes often; compile when task behavior is stable,
   latency/cost/privacy matters, and source knowledge is not the main variable.

Kolm becomes more credible if it treats RAG as a first-class artifact rather
than a competing religion.

#### G. AI Security, Guardrails, And Model Supply Chain

Main competitors:

- Lakera Guard
- Giskard
- NVIDIA garak
- Protect AI ModelScan/Guardian
- HiddenLayer
- Robust Intelligence/Cisco AI security
- NVIDIA NeMo Guardrails
- Guardrails AI
- Microsoft Presidio for PII
- OWASP LLM and MCP guidance

Why they matter:

- Security review is a hard enterprise gate.
- A signed artifact without scanning, threat model, red-team evidence,
  prompt-injection controls, and model supply-chain checks is not enough.
- Competitors increasingly sell AI security posture management, runtime
  protection, scanning, guardrails, and red-team automation.

What they do well:

- Lakera Guard focuses on prompt attack detection and policy-based screening.
- Giskard and garak provide automated vulnerability probing/red-team workflows.
- Protect AI and HiddenLayer focus on model supply-chain security, model
  scanning, AI-BOM, runtime security, and model integrity.
- NeMo Guardrails and Guardrails AI provide programmable rails and schema/policy
  enforcement.

How Kolm should counterposition:

- Kolm's artifact format gives it a natural security advantage if the verifier
  is serious.
- The verifier should check more than signatures:
  manifest schema, forbidden file types, model file hashes, tokenizer hashes,
  license metadata, provenance, dependency graph, dangerous serialization
  formats, policy compatibility, and runtime permissions.
- Integrate with Giskard, garak, ModelScan, and similar tooling instead of
  building every scanner internally at launch.

Tactical implications:

1. Add AI-BOM to every artifact.
2. Add model-file scanner hook before registry publish.
3. Add prompt-injection and jailbreak eval packs as optional compile gates.
4. Add MCP permission manifest:
   tools, scopes, allowed hosts, filesystem access, network access, secrets,
   and human-approval requirements.
5. Add runtime policy enforcement:
   input guard, retrieved-context guard, tool-call guard, output guard, and
   audit event.
6. Add red-team receipts:
   scanner, version, probes, passed/failed categories, timestamps, and
   exceptions.

Security should become a product surface, not a checklist item.

#### H. Code Intelligence, Agent Harnesses, And MCP Context Systems

Main competitors and adjacent systems:

- OpenAI Codex
- Claude Code
- Cursor
- Windsurf
- Cline
- Sourcegraph Cody
- Devin-style software agents
- `colbymchenry/codegraph` and similar local code-index MCP systems
- Semgrep, CodeQL, and static-analysis systems

Why they matter:

- Developers are a core early audience.
- Agent harnesses already own terminals, IDEs, mobile control, file edits,
  tool permissions, MCP, codebase context, and PR workflows.
- If Kolm wants to be the artifact layer for agent tools, it must understand
  codebases and tool permissions better than generic docs.

What they do well:

- Codex and Claude Code own agent execution loops, shell/file access,
  permissions, session state, subagents, and developer trust.
- Cursor and Windsurf own IDE-native editing and codebase context.
- Sourcegraph Cody owns code search and code graph context at enterprise scale.
- codegraph-style tools show a practical pattern:
  local symbol/call/route graph indexing can reduce repeated file scans and
  give agents precise context.
- Semgrep and CodeQL own static-analysis rule execution and security findings.

How Kolm should counterposition:

- Do not become a general coding agent.
- Become a way to compile, sign, verify, and distribute agent tools and
  code-aware workflows.
- The codegraph lesson is directly useful:
  build or integrate a local code knowledge graph for Kolm projects so compile
  recipes, MCP tools, SDK examples, and route/API wrappers can be generated from
  actual code structure rather than raw grep scans.

Tactical implications:

1. Add optional local `CodeGraphAdapter`:
   symbols, routes, call edges, file ownership, API handlers, CLI commands,
   docs references, tests, and package manifests.
2. Use the graph for SDK wrapper generation, API surface audits, route-to-doc
   consistency, impact analysis before compile, and MCP tool manifests.
3. Add `kolm inspect codebase`:
   route inventory, public/private API map, command map, data-flow hints,
   security-sensitive callsites, and docs gaps.
4. Add MCP tool package output:
   `kolm compile --as-mcp` should emit signed tool manifest, permission diff,
   eval suite, and installation docs for Claude Desktop/Code, Cursor, Codex,
   and other MCP clients.
5. Add static-analysis integrations:
   Semgrep/CodeQL findings can be attached to artifact security receipts.

This surface matters because "AI artifact" will often mean "agent tool with
permissions," not only "small model file."

#### I. Local Runtime, Edge, Mobile, And Community Model Runners

Main competitors:

- Ollama
- llama.cpp
- LM Studio
- MLX
- Core ML
- LiteRT/TensorFlow Lite
- ExecuTorch
- ONNX Runtime Mobile
- OpenVINO
- Qualcomm QNN
- WebLLM/MLC
- Transformers.js/WebGPU

Why they matter:

- These systems already own the local-runner mental model.
- Developers trust GGUF, Ollama Modelfiles, llama.cpp, ONNX, Core ML, and MLX
  more than a new proprietary runtime.
- "Runs locally" is credible only when it works on laptops, phones, browsers,
  Jetsons, NPUs, and constrained edge devices.

What they do well:

- Ollama/LM Studio provide accessible local UX.
- llama.cpp/GGUF is the default open local LLM substrate for many users.
- MLX is the natural Apple Silicon research path.
- Core ML, LiteRT, ExecuTorch, ONNX Runtime Mobile, QNN, and OpenVINO cover
  device-native deployment.
- WebLLM/MLC and Transformers.js make browser inference possible when model
  size permits.

How Kolm should counterposition:

- Do not force a single runtime.
- `.kolm` should be a wrapper and contract that can reference GGUF, ONNX,
  Core ML, MLX, ExecuTorch, LiteRT, WebGPU/WASM, or hosted endpoints where
  needed.
- The runtime story should be:
  "same artifact contract, many runtime targets."

Tactical implications:

1. Add target matrix to the spec:
   `gguf`, `onnx`, `coreml`, `mlx`, `litert`, `executorch`, `openvino`, `qnn`,
   `wasm-webgpu`, `hosted`.
2. Add conformance tests per target:
   load, infer, stream, verify receipt, enforce policy, and report latency.
3. Add device recommender:
   estimate memory, quantization, p50/p95 latency, battery/thermal risk, and
   fallback target.
4. Add bridge export commands:
   `kolm export ollama`, `kolm export llama.cpp`, `kolm export onnx`,
   `kolm export coreml`, `kolm export mlx`.
5. Add browser/mobile examples that are real:
   small verified artifact, offline inference, receipt verification, and
   graceful unsupported-device fallback.

The local runtime strategy should borrow trust from the existing open runtime
ecosystem instead of asking users to trust Kolm alone.

#### J. Artifact Hubs, Registries, And Distribution

Main competitors:

- Hugging Face Hub
- MLflow Model Registry
- W&B Registry/Artifacts
- Docker Hub and OCI registries
- npm, PyPI, crates.io, Homebrew
- DVC and lakeFS for data/version lineage
- GitHub Releases/Packages

Why they matter:

- Distribution is not solved by uploading `.kolm` files.
- Hubs win by making artifacts discoverable, versioned, documented,
  installable, permissioned, and socially trusted.
- Enterprise registries win by being private, mirrored, policy-controlled, and
  auditable.

What they do well:

- Hugging Face Hub owns model cards, datasets, demos, downloads, discussions,
  and community trust.
- MLflow owns experiment-to-registry lineage for ML teams.
- W&B owns experiment/artifact lineage for ML teams already in that ecosystem.
- Docker/OCI owns content-addressed image distribution and learned DevOps UX.
- DVC/lakeFS own data versioning patterns.

How Kolm should counterposition:

- `.kolm Hub` should not be "Hugging Face but smaller."
- It should be an artifact trust registry:
  signed manifests, verifier, eval receipts, dataset cards, permission diffs,
  runtime compatibility, red-team receipts, license metadata, dependency graph,
  private mirrors, and deployment buttons.
- Public discovery matters, but enterprise private registry matters earlier for
  revenue.

Tactical implications:

1. Store artifacts content-addressed and sign registry manifests separately.
2. Add model card, dataset card, eval card, and risk card as required publish
   fields.
3. Add private registry and air-gap mirror as paid enterprise primitives.
4. Add artifact diff:
   behavior, model, tokenizer, dataset, eval, permissions, runtime targets, and
   dependencies.
5. Add one-click deploy:
   AWS, Azure, GCP, Vercel, Cloudflare, Kubernetes, Modal, RunPod, Replicate,
   Baseten.
6. Add verified publisher and permission review.

The registry can become the monetization surface if it is built as trust
infrastructure, not as a gallery.

#### K. The Most Dangerous Competitive Wedges

Ranked by risk:

1. Palantir AIP:
   wins high-stakes enterprise because it connects AI to ontology, operations,
   workflow, governance, deployment, and executive trust. Kolm should avoid
   pretending to be a whole operational OS and win as portable artifact/evidence
   infrastructure.
2. Databricks and Snowflake:
   win through data gravity. Kolm must connect to them and export evidence back
   into them while proving portability outside them.
3. OpenAI, Anthropic, Google, AWS, Azure:
   win through model access and cloud defaults. Kolm must be provider-native,
   not OpenAI-wrapper-only, and must preserve Anthropic/Gemini/Bedrock/Vertex
   semantics.
4. Predibase, Lamini, Arcee, OpenPipe, Together, Fireworks:
   win if the buyer only wants fine-tuning. Kolm must own the train/eval/
   artifact/receipt loop, not generic training.
5. Baseten, Replicate, Modal, RunPod:
   win the "no GPU" problem. Kolm must dispatch to them and make the output
   verifiable.
6. LangSmith, Langfuse, Braintrust, Humanloop:
   win workflow mindshare before training starts. Kolm must ingest their traces
   and complete the loop into artifacts.
7. Scale, Labelbox, Snorkel, Surge:
   win if the bottleneck is data quality. Kolm must make labels, holdouts, and
   human evals evidence-grade.
8. Lakera, Giskard, Protect AI, HiddenLayer, garak:
   win security review. Kolm must make security receipts and scanner
   integrations native.
9. Hugging Face, Ollama, llama.cpp, MLX:
   win community trust. Kolm must interoperate deeply instead of forcing a new
   runtime religion.
10. Codex, Claude Code, Cursor, Sourcegraph, codegraph:
    win developer workflow. Kolm must expose signed agent/tool artifacts and
    code-aware context, not compete as another IDE agent.

#### L. Corrected Product Positioning

Kolm should be positioned as:

> the verifiable AI artifact compiler and evidence layer for private,
> production AI systems.

Not:

- a generic AI gateway
- a generic fine-tuning UI
- a generic observability dashboard
- a generic RAG builder
- a generic GPU cloud
- a generic agent IDE
- a generic model hub

The deeper strategy is to sit between all of those:

- gateways provide calls; Kolm captures trainable evidence
- eval platforms measure behavior; Kolm binds behavior to artifacts
- fine-tuning platforms train models; Kolm proves splits, lineage, and runtime
  portability
- GPU clouds provide compute; Kolm dispatches jobs and signs outputs
- RAG stacks retrieve knowledge; Kolm packages RAG as an auditable artifact
- security tools scan systems; Kolm stores security results as artifact
  receipts
- enterprise platforms govern data; Kolm gives them portable AI evidence
- local runners execute models; Kolm gives them signed, policy-bound artifacts

This is a more defensible company shape than "compile your AI" alone.

### 5.13 Direct Competitor Map By Buyer Job

The cleanest way to think about competition is not by feature category. It is by
the buyer's immediate job. Every serious buyer will anchor on a simpler
substitution question:

> Why would I buy Kolm instead of the thing my team already knows how to use?

This section maps those actual substitution paths.

#### Job 1: "I need to make a model smaller, faster, and cheaper"

Direct competitors:

- Pruna AI
- Red Hat/Neural Magic LLM Compressor
- Hugging Face Optimum
- AutoGPTQ, GPTQ, AWQ, bitsandbytes, SmoothQuant, SparseGPT-style tooling
- NVIDIA TensorRT-LLM
- Intel OpenVINO
- Qualcomm AI Hub/QNN
- ONNX Runtime quantization tooling
- llama.cpp/GGUF quantization ecosystem
- Unsloth, Axolotl, LlamaFactory, Hugging Face AutoTrain

Why this is a main competitive lane:

- A compression buyer does not start with "artifact standard." They start with
  "can I reduce cost and latency without quality loss?"
- Existing tools already expose pruning, quantization, sparsity, adapter
  training, and runtime-specific export.
- These tools are used by practitioners who care about actual memory, latency,
  GPU utilization, and quality deltas.

Kolm's required wedge:

- Kolm should not claim generic compression superiority unless it can beat these
  tools on public tasks.
- Kolm should instead own the decision and proof layer:
  "given this task, data, holdout, target device, budget, and quality gate,
  choose the right combination of distillation, LoRA/QLoRA, quantization,
  pruning, prompt compression, RAG, routing, or no-op."
- Compression becomes one action inside a verifiable compile plan, not the whole
  company.

Product requirement:

- `kolm compile` must output:
  original model/task baseline, selected method, rejected methods, target
  hardware, estimated memory, measured memory, p50/p95 latency, quality delta,
  K-score delta, eval slices, and rollback target.

#### Job 2: "I need a real ML compiler or hardware lowering stack"

Direct competitors:

- Modular MAX and Mojo
- Apache TVM/Relax
- MLC LLM
- IREE/MLIR
- XLA
- torch.compile/Inductor
- NVIDIA TensorRT/TensorRT-LLM
- ONNX Runtime
- OpenVINO
- ExecuTorch
- Core ML Tools
- Qualcomm QNN
- AMD ROCm/MIGraphX

Why this is a main competitive lane:

- If Kolm says "AI compiler", compiler people will compare it to actual
  compiler stacks.
- Actual ML compilers lower graphs, generate kernels, target accelerators,
  optimize memory layout, fuse operators, and validate numerical behavior.
- A packaging/fine-tuning system that calls itself a compiler will be attacked
  unless it is precise about what kind of compiler it is.

Kolm's required wedge:

- Kolm is not yet a kernel compiler. It should be explicit:
  Kolm is an artifact compiler and evidence compiler, with optional export to
  hardware/compiler backends.
- The compiler claim becomes credible if the pipeline has:
  IR, target descriptions, optimization passes, reproducible artifacts, runtime
  conformance tests, and backend-specific receipts.

Product requirement:

- Define `KolmIR` or `CompilePlan` as a real intermediate representation:
  task contract, data contract, model contract, eval contract, runtime target,
  privacy policy, resource target, deployment policy, and artifact members.
- Add backend passes:
  `to_gguf`, `to_onnx`, `to_coreml`, `to_mlx`, `to_litert`,
  `to_executorch`, `to_openvino`, `to_qnn`, `to_wasm`.
- If a target is not supported, the UI must say so and recommend the next best
  target.

#### Job 3: "I do not have a GPU but I want to train, fine-tune, or distill"

Direct competitors:

- Modal
- RunPod
- Replicate
- Baseten
- Together AI
- Fireworks AI
- SageMaker
- Vertex AI
- Azure AI Foundry
- Bedrock customization
- Lambda Labs
- CoreWeave
- Vast.ai
- Hugging Face Spaces/Inference/AutoTrain

Why this is a main competitive lane:

- The user's problem is not "how do I compile?" The problem is "where does the
  compute run, how much will it cost, and will it finish?"
- GPU cloud products already expose hardware choice, logs, scaling, endpoints,
  and cost controls.

Kolm's required wedge:

- Kolm should broker compute rather than own all compute.
- The product should choose the cheapest reliable route that preserves privacy
  and quality:
  local, BYO GPU, remote SSH, cloud job, managed provider, or smaller plan.

Product requirement:

- Add `ComputePlan`:
  provider, region, GPU, expected VRAM, expected wall time, budget cap, privacy
  class, artifact output path, log stream, cancellation path, and fallback.
- Add "no GPU" UX everywhere:
  account UI, CLI, TUI, docs, and API should all converge on the same
  recommendation.

#### Job 4: "I need a local/offline runner"

Direct competitors:

- Ollama
- LM Studio
- Jan
- GPT4All
- llama.cpp
- llamafile
- LocalAI
- Open WebUI
- text-generation-webui
- MLC LLM
- MLX
- WebLLM
- Transformers.js

Why this is a main competitive lane:

- Local-AI users already have a mental model: pull model, run locally, expose
  OpenAI-compatible endpoint.
- These products win on simplicity and community trust.

Kolm's required wedge:

- Kolm should not replace local runners. It should make artifacts portable
  across them.
- `.kolm` should be able to carry or reference runner-specific payloads and
  include verification receipts.

Product requirement:

- Add exports:
  `kolm export ollama`, `kolm export llamacpp`, `kolm export localai`,
  `kolm export mlx`, `kolm export webllm`.
- Add import:
  `kolm wrap gguf`, `kolm wrap onnx`, `kolm wrap coreml`.
- Add runtime receipts:
  runner, version, model hash, prompt template, tokenizer hash, quantization,
  hardware, latency, and policy status.

#### Job 5: "I need enterprise search, RAG, and chat over internal knowledge"

Direct competitors:

- Glean
- Moveworks
- Coveo
- H2O.ai Enterprise h2oGPTe
- C3 Generative AI
- Pinecone Assistant
- Vectara
- Weaviate
- LlamaIndex
- LangChain/LangGraph
- deepset Haystack
- Dify
- Flowise
- Langflow
- Dust
- Hebbia

Why this is a main competitive lane:

- A lot of enterprise "private AI" demand is not fine-tuning. It is secure
  knowledge retrieval with permissions, connectors, citations, and workflows.
- Glean, Moveworks, Coveo, H2O, and C3 already speak the enterprise language:
  connectors, permissions, RBAC, audit, answer grounding, workplace systems,
  support workflows, and internal automation.

Kolm's required wedge:

- Kolm should not tell every RAG buyer to distill.
- Kolm should package RAG systems as signed artifacts:
  data connectors, chunking, index schema, embedding model, retrieval policy,
  reranker, prompt, model, source hashes, evals, citations, and permissions.
- The buying argument is:
  "Your RAG pipeline becomes verifiable, portable, diffable, and auditable."

Product requirement:

- Add `rag.kolm` as a first-class artifact type.
- Add permission-aware retrieval receipts.
- Add answer-grounding evals and hallucination/factuality gates.
- Add `Kolm with Glean`, `Kolm with Pinecone`, `Kolm with Weaviate`,
  `Kolm with Vectara`, `Kolm with LangChain`, and `Kolm with LlamaIndex`
  integration docs.

#### Job 6: "I need an LLM app builder or agent workflow platform"

Direct competitors:

- Dify
- Flowise
- Langflow
- LangGraph Platform
- LlamaIndex Workflows
- CrewAI
- AutoGen
- Semantic Kernel
- OpenAI Agents SDK
- Google Agent Development Kit
- Pydantic AI
- Mastra
- n8n
- Zapier Agents
- Make
- Relevance AI
- Gumloop
- Stack AI
- Dust
- Moveworks Agent Studio
- Glean Agents

Why this is a main competitive lane:

- Many users do not want a model artifact. They want a working AI workflow.
- Visual builders and agent frameworks win when the buyer values orchestration
  more than model economics.

Kolm's required wedge:

- Kolm should compile and verify agent tools/workflows instead of trying to be
  the visual builder.
- The artifact should include tool permissions, workflow graph, evals,
  rollback, trace schema, and deployment target.

Product requirement:

- Add `workflow.kolm`:
  nodes, tools, providers, policies, evals, permissions, secrets contract, and
  trace contract.
- Add import/export adapters for Dify, Langflow, Flowise, LangGraph, n8n,
  Zapier, and MCP.
- Add agent-specific K-score axes:
  tool selection, argument validity, policy compliance, cost, latency,
  retry/rollback behavior, and human escalation.

#### Job 7: "I need model routing, fallback, and gateway control"

Direct competitors:

- OpenRouter
- LiteLLM
- Portkey
- Helicone
- Cloudflare AI Gateway
- Vercel AI Gateway
- Requesty
- Not Diamond
- Martian-style model routers
- Unify-style model selection layers
- Braintrust AI Proxy

Why this is a main competitive lane:

- Gateways solve the first integration problem faster than Kolm.
- Intelligent routers like Not Diamond compete directly with "compile repeated
  tasks away" because routing can reduce cost without training.

Kolm's required wedge:

- Routing is the baseline. Kolm should capture evidence from routing and turn
  stable, repeated, expensive patterns into artifacts.
- A router chooses the best model per call. Kolm should decide when a call
  should stop being a remote model call at all.

Product requirement:

- Add a "route vs compile" decision report:
  keep routing, cache, prompt-compress, distill, fine-tune, RAG, or localize.
- Add provider truth receipts:
  selected provider, selected model, capability flags, native feature use,
  fallback path, cost, latency, and failure mode.

#### Job 8: "I need evals, LLM QA, monitoring, and regression tests"

Direct competitors:

- Braintrust
- LangSmith
- Langfuse
- Humanloop
- W&B Weave
- Arize Phoenix
- Galileo
- Patronus
- Arthur
- Fiddler
- DeepEval/Confident AI
- Comet Opik
- HoneyHive
- Parea
- Maxim AI
- Ragas
- TruLens
- Promptfoo

Why this is a main competitive lane:

- Evals are often the control point for AI engineering teams.
- If Kolm cannot ingest or produce eval evidence better than these systems, the
  artifact trust story weakens.

Kolm's required wedge:

- Do not replace eval platforms. Bind eval output to artifacts.
- Kolm should make evals portable, frozen, and verifier-readable.

Product requirement:

- Add `evalcard.json` as a required artifact member.
- Add importers for Braintrust, LangSmith, Langfuse, W&B Weave, Phoenix,
  DeepEval, Opik, Promptfoo, and Ragas outputs.
- Add evaluator reproducibility:
  judge model, prompt, version, seed if applicable, calibration set, and known
  failure modes.

#### Job 9: "I need AI governance, audit, and model risk management"

Direct competitors:

- IBM watsonx.governance
- Credo AI
- ModelOp
- Holistic AI
- Monitaur
- DataRobot governance
- Dataiku governance
- Arthur/Fiddler enterprise trust tooling
- CalypsoAI
- Fairly AI
- Saidot
- Trustible
- Bookbag-style runtime governance

Why this is a main competitive lane:

- Enterprise governance buyers care about inventory, accountability, approvals,
  risk tiering, audit evidence, EU AI Act/NIST/ISO mapping, and third-party AI
  risk.
- They may not care whether the underlying model was compiled unless the
  artifact gives them better evidence.

Kolm's required wedge:

- Kolm should be the evidence supplier to governance systems.
- A `.kolm` artifact should make governance cheaper by bundling inventory,
  lineage, risk, eval, security, and deployment evidence.

Product requirement:

- Add governance export bundles:
  NIST AI RMF, ISO 42001, EU AI Act, SOC 2, HIPAA, model card, dataset card,
  AI-BOM, risk tier, human oversight plan, incident log, and change history.
- Add integration targets:
  Credo, ModelOp, ServiceNow GRC, Jira, Confluence, Archer, AuditBoard, and
  generic CSV/JSON evidence export.

#### Job 10: "I need AI security, guardrails, and agent protection"

Direct competitors:

- Lakera
- Giskard
- garak
- Protect AI ModelScan/Guardian
- HiddenLayer
- Zenity
- Prompt Security
- Aim Security/AIMon
- Enkrypt AI
- Robust Intelligence/Cisco
- NVIDIA NeMo Guardrails
- Guardrails AI
- Llama Guard
- Microsoft Presidio

Why this is a main competitive lane:

- Security vendors win before product teams get to talk about artifact quality.
- Prompt injection, indirect injection, tool overreach, data exfiltration,
  model poisoning, model deserialization, and shadow AI inventory are now
  board-level concerns.

Kolm's required wedge:

- Kolm should make every artifact security-reviewable.
- The verifier must become a lightweight security scanner and policy checker,
  not only a signature checker.

Product requirement:

- Add security receipts:
  model scan, prompt-injection scan, jailbreak scan, RAG poisoning scan, tool
  permission scan, secret scan, license scan, and AI-BOM.
- Add runtime enforcement:
  input guard, retrieved-context guard, tool-call guard, output guard, and
  human-approval gate.
- Add security integration hooks for Lakera, Giskard, garak, ModelScan,
  HiddenLayer, NeMo Guardrails, Presidio, and generic webhook scanners.

#### Job 11: "I need an edge AI platform"

Direct competitors:

- Edge Impulse
- SensiML
- Nota AI NetsPresso
- Latent AI
- TensorFlow Lite/LiteRT
- ExecuTorch
- Core ML
- OpenVINO
- QNN
- ONNX Runtime Mobile
- NVIDIA Jetson/TensorRT
- Arm Ethos-U/CMSIS-NN ecosystem

Why this is a main competitive lane:

- Edge buyers care about device constraints, battery, latency, RAM, flash,
  sensor ingestion, OTA updates, and hardware compatibility.
- Edge Impulse and SensiML already package data collection, training,
  optimization, testing, deployment, and device SDKs.

Kolm's required wedge:

- Kolm should not try to out-Edge-Impulse Edge Impulse for sensor ML at launch.
- It should win where AI artifacts need privacy, auditability, signed updates,
  and cross-runtime portability.

Product requirement:

- Add device profile objects:
  CPU/NPU/GPU, RAM, flash, OS, runtime, battery class, thermal class, supported
  formats, and update channel.
- Add signed rollout receipts:
  device group, artifact hash, old/new version, approval actor, deployment
  time, verification status, and rollback status.
- Add edge benchmark harness:
  real target if available, simulator if not, plus honest "not verified on
  hardware" flags.

#### Job 12: "I need a model hub, artifact registry, or distribution network"

Direct competitors:

- Hugging Face Hub
- ModelScope
- Kaggle Models
- GitHub Models
- NVIDIA NGC
- MLflow Model Registry
- W&B Artifacts/Registry
- Comet model registry
- Docker/OCI registries
- npm/PyPI/crates/Homebrew
- DVC and lakeFS

Why this is a main competitive lane:

- Distribution, trust, discoverability, versioning, download stats, examples,
  and community matter.
- Hugging Face is the default place users expect to find models and datasets.

Kolm's required wedge:

- Do not build "Hugging Face but smaller."
- Build "OCI plus model card plus eval card plus receipt verifier for AI
  systems."

Product requirement:

- Required registry fields:
  manifest hash, artifact hash, publisher signature, model card, dataset card,
  eval card, risk card, security receipts, runtime targets, license, and
  deployment buttons.
- Private registry and air-gap mirror are more valuable near-term than a public
  social hub.

#### Job 13: "I need privacy, PII/PHI redaction, or synthetic data"

Direct competitors:

- Private AI
- Nightfall AI
- Tonic Textual
- Gretel
- Mostly AI
- Synthesized
- Skyflow
- Microsoft Presidio
- AWS Comprehend Medical
- Google Cloud DLP
- Encord/Labelbox/Scale data workflows where annotation overlaps privacy

Why this is a main competitive lane:

- Regulated buyers will not accept vague "privacy membrane" language.
- They need per-class redaction precision/recall, false-negative strategy,
  audit logs, BYOK/CMK, zero-retention, DSR/delete propagation, and contractual
  controls.

Kolm's required wedge:

- Kolm should bind privacy transformations to artifact lineage.
- The key question is:
  "If this captured row contained sensitive data, which artifacts did it
  influence, and can we prove redaction or deletion?"

Product requirement:

- Add privacy lineage graph:
  row -> redaction -> dataset -> train/holdout -> artifact -> deployment.
- Add per-class redaction metrics:
  PHI, PII, credentials, financial IDs, medical record numbers, addresses,
  dates, names, emails, phone numbers, and free-text leakage.
- Add deletion impact report:
  affected artifacts, affected evals, required recompile or no-op rationale.

#### Job 14: "I need a code-aware AI system"

Direct competitors:

- OpenAI Codex
- Claude Code
- Cursor
- Windsurf
- Cline
- Sourcegraph Cody
- GitHub Copilot
- Devin-style agents
- Semgrep
- CodeQL
- codegraph-style local MCP indexers

Why this is a main competitive lane:

- Developers will ask Kolm to inspect APIs, compile wrappers, generate SDKs,
  create MCP tools, verify route coverage, and reason over code.
- General coding agents already do this interactively.

Kolm's required wedge:

- Kolm should not become another coding agent. It should compile code-derived
  surfaces into signed, testable, auditable AI tools.
- A codegraph-style index is useful because it gives Kolm a structured map of
  routes, symbols, CLI commands, SDKs, tests, and docs.

Product requirement:

- Add `kolm inspect codebase`:
  route map, API wrappers, CLI verbs, SDK exports, public docs, test links,
  security-sensitive paths, and ownership.
- Add `code-context.kolm`:
  signed code graph, source hash, route graph, symbol graph, doc graph, and
  allowed agent tools.
- Add "MCP from code" packaging:
  tool schema, route handler, permission policy, examples, evals, and
  verifier-readable manifest.

#### The Correct Strategic Implication

Kolm's real enemy is not one vendor. It is buyer simplification:

- "I will just use Databricks/Snowflake/Palantir because my data is there."
- "I will just fine-tune with OpenAI/Together/Predibase."
- "I will just route with OpenRouter/Not Diamond/Requesty."
- "I will just run locally with Ollama/llama.cpp."
- "I will just build RAG with Glean/Pinecone/LlamaIndex."
- "I will just govern with Credo/ModelOp/watsonx.governance."
- "I will just secure it with Lakera/Zenity/Protect AI."
- "I will just build an agent in Dify/Flowise/LangGraph."

Kolm wins only if it makes those choices better together:

1. Capture evidence from the tools users already have.
2. Decide whether routing, RAG, fine-tuning, compression, distillation, or local
   runtime is the right move.
3. Produce a signed artifact or signed system contract.
4. Bind evals, privacy, security, cost, and runtime proof to the artifact.
5. Export back into the platforms buyers already use.

That is the more thoughtful scope:

- Be the artifact trust layer.
- Be the compile decision layer.
- Be the evidence bridge across platforms.
- Be the portability layer for private AI systems.
- Do not pretend every buyer starts by wanting a compiler.

### 5.14 Strategic Insights And Non-Obvious Conclusions

This is the missing synthesis layer. The competitor list is only useful if it
changes what Kolm builds, what it does not build, what it claims, and what it
ships first.

#### Insight 1: The category is not "AI compiler"; it is "AI system evidence"

The word "compiler" is powerful but dangerous.

Compiler is credible to founders and developers because it suggests
transformation, optimization, portability, and deterministic output. But real
compiler people will immediately ask about IR, lowering, passes, target
backends, numerical equivalence, kernel generation, and hardware-specific
optimization. If Kolm cannot answer those questions, "compiler" becomes a
liability.

The stronger category is:

> AI system evidence and artifact compilation.

That keeps the powerful parts of compiler language while making the product
truthful. Kolm compiles traces, evals, datasets, model choices, privacy policy,
runtime target, and deployment policy into a signed artifact or signed system
contract.

Implication:

- Use "AI compiler" in the headline only if the product immediately explains
  what gets compiled:
  behavior, evidence, data, evals, runtime target, and deployment proof.
- Avoid sounding like Modular, TVM, TensorRT, MLC, or IREE unless Kolm is
  actually lowering kernels.
- The technical spec should define a real intermediate representation:
  `KolmIR` or `CompilePlan`.

Build consequence:

- The `.kolm` spec should not just document ZIP members. It should document the
  compilation graph:
  source evidence -> transformations -> eval gates -> target runtime -> signed
  output -> verifier.

#### Insight 2: The artifact is not the moat by itself; the verifier is the moat

Most teams can invent a file extension. Docker did not win because `.tar` files
exist. OCI did not matter because manifests exist. The trust came from runtime
behavior, registry behavior, reproducible workflows, and broad verification.

For Kolm, `.kolm` becomes valuable only if a skeptical third party can verify it
without trusting Kolm's SaaS.

Implication:

- The standalone verifier is more strategically important than another UI page.
- The verifier should be free, open, embeddable, and boring.
- It should reject bad artifacts loudly and explain exactly why.

Verifier must eventually check:

- manifest schema
- artifact hash
- publisher signature
- model file hash
- tokenizer hash
- recipe hash
- train/holdout split proof
- eval card
- K-score calculation inputs
- privacy lineage
- license metadata
- runtime target compatibility
- dangerous serialization formats
- MCP/tool permissions
- security scan receipts
- revocation status

Build consequence:

- Create `kolm verify --offline --strict`.
- Create `verify.kolm.ai` for drag/drop verification.
- Create JS/Python/Rust/C verifier libraries before spending too much energy on
  marketplace polish.

#### Insight 3: Kolm should not be a platform replacement; it should be the
portable proof layer across platforms

Databricks, Snowflake, Palantir, AWS, Azure, Google, DataRobot, Dataiku, and
Domino are too entrenched to displace directly. They own data gravity,
compliance gravity, procurement gravity, and admin gravity.

Kolm's opening should be:

> Keep your AI platform. Kolm gives you portable proof and portable artifacts.

This is more believable than "move your AI lifecycle into Kolm."

Implication:

- Docs should be integration-first, not replacement-first.
- Account UI should show connected systems:
  Snowflake, Databricks, S3/R2, Langfuse, LangSmith, OpenTelemetry, Hugging
  Face, Ollama, Modal, RunPod, SageMaker, Vertex, Azure.
- Enterprise sales should say:
  "We reduce vendor lock-in and audit pain inside your existing stack."

Build consequence:

- Every product surface needs import/export.
- Kolm should emit artifacts and evidence bundles that Databricks/Snowflake/
  Palantir/AWS/Azure/GCP governance systems can store.

#### Insight 4: The fastest path to value is not training; it is capture ->
recommendation -> proof

Training is expensive, slow, and failure-prone. The user may not have enough
data, a clean task, GPU access, or a good holdout. If the first-run experience
requires successful training, many users will churn.

The first-run value should be:

1. connect provider
2. capture traffic safely
3. show cost/latency/task clusters
4. recommend route/cache/RAG/fine-tune/distill/localize/no-op
5. prove one narrow improvement

Implication:

- Capture lake and opportunity detection are the real activation surface.
- The product should say "here are three compile candidates" before it says
  "start training."
- Many users should get value even if they never compile.

Build consequence:

- Add compile-opportunity scoring:
  volume, cost, latency, privacy sensitivity, output stability, label
  availability, task complexity, holdout confidence, and expected ROI.
- Add "do not compile" recommendations. That honesty builds trust.

#### Insight 5: Routing, caching, RAG, fine-tuning, distillation, and local
runtime are not separate products; they are competing actions

Competitors sell these as separate categories. Buyers experience them as
choices for the same problem:

- route to a cheaper model
- cache repeated responses
- compress the prompt
- use RAG
- fine-tune
- distill
- quantize
- run locally
- keep using the frontier API

Kolm's unique opportunity is to make the decision instead of pushing one
religion.

Implication:

- The product should not be biased toward distillation every time.
- "Compile" should be a decision engine that can output:
  route policy, cache policy, prompt compression policy, RAG artifact, LoRA
  artifact, quantized local model, rule artifact, or no-op.

Build consequence:

- `kolm plan` may be more important than `kolm train`.
- Add `kolm plan --goal cost|latency|privacy|offline|quality`.
- The plan should include rejected options and why.

#### Insight 6: K-score is not a score; it is a litigation target unless it is
calibrated

Any proprietary quality score will be attacked as marketing unless the
methodology is scoped.

A single score across classifiers, extractors, chatbots, RAG systems, agents,
redactors, summarizers, and tool-calling workflows is too blunt. Different tasks
need different axes and thresholds.

Implication:

- K-score should be a composite with task-specific axes.
- Marketing should never imply "K-score means universally good."
- The score should expose confidence, sample size, holdout validity, evaluator
  type, and known blind spots.

Build consequence:

- Define K-score schemas by artifact kind:
  `classifier`, `extractor`, `redactor`, `summarizer`, `rag`, `agent_tool`,
  `workflow`, `runtime_policy`.
- Every K-score should link to:
  eval set hash, judge config, deterministic checks, human labels if any, and
  calibration notes.

#### Insight 7: Healthcare is a good wedge only if the privacy/audit machinery
is real

Healthcare sounds attractive because HIPAA, PHI, local AI, and redaction are
natural fits. But healthcare buyers punish vague claims. A PHI redactor with a
single aggregate score is not enough.

Implication:

- Healthcare should not be the wedge unless Kolm can show per-class PHI metrics,
  BAA path, audit exports, deletion lineage, and integration path.
- Legal and financial services may be easier initial regulated wedges if the
  artifact/audit story is stronger than the clinical workflow story.

Build consequence:

- Add vertical evidence packs:
  healthcare PHI, legal privilege, finance PII/PCI, insurance claims, support
  automation.
- Each pack needs:
  sample artifacts, evals, compliance mapping, buyer objection handling, and
  integration examples.

#### Insight 8: The strongest wedge may be "verified replacement for expensive
stable AI calls"

The most economically compelling use case is not broad "private AI." It is:

> You are paying frontier-model prices for a narrow repeated task whose behavior
> is stable enough to verify.

Examples:

- support classification
- ticket routing
- log triage
- claim field extraction
- PHI/PII redaction
- contract clause extraction
- alert summarization
- data normalization
- policy checks
- coding workflow linting

Implication:

- The product should hunt for repeated stable tasks.
- The copy should show "replace this expensive repeated call with this verified
  artifact", not abstract platform language.

Build consequence:

- Add an "AI spend conversion funnel":
  observed spend -> candidate task -> expected savings -> compile plan -> eval
  proof -> shadow deploy -> promotion -> savings receipt.

#### Insight 9: The enterprise buyer needs artifact diffs more than artifact
downloads

Downloading an artifact is easy. Approving a changed AI system is hard.

Enterprise buyers need to know:

- what changed
- why it changed
- which data influenced it
- what quality improved or regressed
- what permissions changed
- what model/runtime changed
- what security scans changed
- how to roll back

Implication:

- Artifact diff is a core product, not a registry nicety.
- Registry version pages should be built around diffs and approvals.

Build consequence:

- Add `kolm diff old.kolm new.kolm`.
- Diff sections:
  behavior, dataset, evals, K-score axes, runtime target, permissions, model,
  tokenizer, quantization, security receipts, privacy lineage, cost/latency.

#### Insight 10: Registry monetization is private-first, not marketplace-first

A public marketplace is strategically exciting, but the near-term buyer will
pay for private registry, verified publisher, access control, audit export, and
air-gap mirror.

Implication:

- Public `.kolm Hub` can be a credibility surface.
- Private registry is the revenue surface.
- Air-gap mirror is the enterprise expansion surface.

Build consequence:

- Build private registry features before ratings/comments:
  org-scoped artifacts, RBAC, approval workflows, signed publish, revocation,
  mirror bundle, provenance export, SIEM events.

#### Insight 11: The biggest UX failure mode is exposing the whole matrix at
once

Kolm touches routing, RAG, training, distillation, quantization, runtime,
registry, compliance, devices, cloud, and agents. If the UI exposes all of that
flatly, it will feel bloated and incoherent.

Implication:

- The UX should be goal-driven, not feature-driven.
- The user's first choice should not be a product module. It should be an
  outcome:
  reduce cost, reduce latency, run offline, prove compliance, create local
  artifact, package RAG, secure agent tool, deploy to device.

Build consequence:

- Account UI should have a primary "Plan" or "Advisor" surface.
- CLI should guide:
  `kolm plan`, then `kolm capture`, `kolm eval`, `kolm compile`,
  `kolm verify`, `kolm deploy`.
- TUI should be a cockpit:
  current namespace, captured evidence, opportunities, jobs, artifacts,
  deployments, compliance warnings.

#### Insight 12: The no-GPU path is existential

If a user cannot train because they lack compute, the product feels fake.

The no-GPU path must be visible everywhere:

- use a smaller student
- quantize only
- route/cache instead
- run remote SSH
- use Modal/RunPod/Replicate/Baseten
- use SageMaker/Vertex/Azure
- defer training and collect more data

Implication:

- "Cloud compute connected" is not a secondary enterprise feature.
- It is required for the product promise.

Build consequence:

- Add compute readiness to onboarding.
- Add `kolm compute doctor`.
- Add `kolm train --where auto`.
- Add cost caps and provider fallback before production launch.

#### Insight 13: Codegraph-style indexing is not a side quest; it is how Kolm
becomes useful for developer-owned systems

The codegraph pattern matters because agents waste time rediscovering code
structure. Kolm has a similar problem: to wrap APIs, SDKs, CLI verbs, MCP tools,
and docs, it needs a structured map of a codebase.

Implication:

- Code intelligence should be part of the developer product surface.
- Kolm can use code graphs to compile code-derived AI tools and wrappers.

Build consequence:

- Add optional local project graph:
  routes, handlers, CLI commands, SDK exports, tests, docs, config, secrets
  references, and ownership.
- Use it to generate:
  MCP manifests, API wrappers, docs gaps, route coverage audits, SDK examples,
  and security-sensitive evals.

#### Insight 14: "Open standard" only works if governance is credible

Publishing a spec is not enough. Standards fail when one company controls the
spec, verifier, registry, and runtime without neutral governance.

Implication:

- If `.kolm` is meant to become Docker/OCI/ONNX-like, the spec needs:
  versioning, compatibility policy, reference tests, independent verifier,
  governance process, and third-party implementation path.

Build consequence:

- Create a conformance suite.
- Create a public RFC process.
- Keep runtime/verifier open.
- Keep compiler orchestration and registry enterprise features commercial.

#### Insight 15: The product should generate evidence as a side effect of use

The best enterprise products do not ask users to fill out governance forms at
the end. They generate evidence while work happens.

Implication:

- Every capture, eval, compile, train, verify, deploy, and runtime call should
  append evidence.
- Compliance exports should be a view over evidence, not manually maintained
  documents.

Build consequence:

- Create an append-only evidence ledger:
  event, actor, tenant, artifact, source hashes, action, policy, result,
  signature, timestamp.
- Map evidence to:
  SOC 2, HIPAA, GDPR, EU AI Act, NIST AI RMF, ISO 42001, internal model risk.

#### Insight 16: Local-first and enterprise-cloud are not contradictory; they
are the same trust claim

Kolm should not pick "local" versus "cloud" as an identity. The trust claim is:

> you decide where data, compute, artifacts, and receipts live.

Implication:

- Local-first is the developer trust wedge.
- BYOC/VPC/air-gap is the enterprise trust wedge.
- Hosted Kolm is the convenience layer.

Build consequence:

- Every core surface needs a deployment-mode field:
  local, hosted, BYOC, VPC, air-gap.
- Docs should show the same workflow across modes.

#### Insight 17: The hard part of "all models" is not a long provider list; it
is capability normalization without lying

OpenAI, Anthropic, Gemini, Bedrock, Vertex, local vLLM, Ollama, and OpenRouter
do not expose identical semantics. Tool use, system prompts, JSON mode,
reasoning, vision, audio, cache, batch, files, safety filters, and streaming all
vary.

Implication:

- A universal wrapper that hides differences will break serious users.
- Kolm should expose capability truth and graceful degradation.

Build consequence:

- Add provider capability matrix:
  native messages, responses, tools, structured output, JSON schema, vision,
  audio, embeddings, batch, cache, file inputs, logprobs, reasoning controls,
  max context, data retention, region, fine-tune support.
- Every wrapper response should include provider semantics used and lost.

#### Insight 18: The "10B outcome" requires becoming a trust boundary, not a
tool

Tools are replaceable. Trust boundaries are sticky.

Kolm becomes infrastructure if other systems depend on it to answer:

- is this artifact authentic?
- what data trained it?
- what evals did it pass?
- what can it access?
- where can it run?
- what changed since last version?
- can we roll it back?
- can auditors verify this without asking engineering?

Implication:

- The highest-value product surfaces are verifier, evidence ledger, private
  registry, artifact diff, compliance export, runtime receipts, and integrations
  with existing platforms.

Build consequence:

- Prioritize trust-boundary features over broad demo surfaces.

#### Insight 19: The right wedge is probably not one vertical; it is one
repeatable operational pattern

Verticals matter for sales, but the reusable product motion is:

1. capture repeated AI calls
2. identify stable task
3. freeze eval/holdout
4. compile cheaper/private artifact
5. shadow deploy
6. compare production behavior
7. promote with receipt
8. audit/rollback

That motion applies to healthcare, legal, finance, support, DevOps, insurance,
and internal tools.

Implication:

- Build vertical examples, but keep the product architecture horizontal around
  this pattern.

Build consequence:

- Every vertical page should map to the same underlying workflow.
- Product UI should not fork into unrelated vertical mini-products.

#### Insight 20: Kolm should have a "truth mode" as a product principle

A lot of AI products overclaim. Kolm can differentiate by being brutally
specific:

- not enough data
- holdout too small
- synthetic rows excluded from holdout
- model license blocks commercial use
- target runtime unverified
- GPU unavailable
- redaction not certified for this PHI class
- provider semantics differ
- K-score not calibrated for this task type
- artifact can run locally but not on this device

Implication:

- Honesty should be visible in UI and CLI, not buried in docs.
- "Cannot prove yet" is better than a fake green check.

Build consequence:

- Add proof-status badges:
  proven, locally proven, simulated, configured, unverified, blocked,
  external dependency, requires credential.

#### Insight 21: The atomic product architecture should be evidence objects,
not pages

If Kolm is built around pages, it will sprawl. If it is built around evidence
objects, the surfaces stay coherent.

Core objects:

- `Trace`
- `CapturePolicy`
- `Dataset`
- `Label`
- `EvalCase`
- `EvalRun`
- `TrainPlan`
- `ComputePlan`
- `CompilePlan`
- `Artifact`
- `Receipt`
- `RuntimeTarget`
- `Deployment`
- `Policy`
- `SecurityScan`
- `EvidenceBundle`

Implication:

- Account UI, CLI, TUI, API, SDKs, and docs should all expose the same object
  model.

Build consequence:

- Create canonical object reference docs.
- Make every API route map to one object or object transition.

#### Insight 22: The highest-leverage docs are not broad docs; they are
decision docs

Docs should answer:

- Should I route or compile?
- Should I RAG or fine-tune?
- Should I quantize or distill?
- Should I run local or cloud?
- Which model can I legally use?
- Which runtime supports my device?
- What proof do I need for HIPAA/SOC2/EU AI Act?
- How do I verify an artifact I did not build?

Implication:

- Docs organized around product nouns are less effective than docs organized
  around buyer decisions.

Build consequence:

- Add decision guides:
  `Route vs Compile`, `RAG vs Fine-Tune`, `Quantize vs Distill`,
  `Local vs Hosted`, `OpenAI vs Anthropic vs Local`, `GPU Required?`,
  `What Does K-score Prove?`, `How To Pass Security Review`.

#### Insight 23: The public benchmark should benchmark decisions, not only
models

A normal benchmark says model A beats model B. Kolm needs to prove its decision
engine beats naive choices.

Benchmark rows should include:

- task
- data size
- holdout quality
- baseline frontier call
- best routed call
- RAG pipeline
- fine-tune
- distill
- quantize
- local runtime
- cost
- latency
- quality
- privacy mode
- artifact size
- proof completeness

Implication:

- A "Kolm-bench" should be a decision benchmark:
  did Kolm choose the right path under constraints?

Build consequence:

- Publish benchmark harness with recipes and reproducible tasks.
- Include failures and "do not compile" cases.

#### Insight 24: The valuation story depends on whether Kolm controls a
standard or only a workflow

Workflow companies can be valuable. Standards companies can be category
defining. The difference is third-party dependence.

Kolm controls a standard only when:

- third-party tools emit `.kolm`
- third-party runtimes verify `.kolm`
- enterprises require `.kolm` evidence for internal AI promotion
- security tools scan `.kolm`
- registries mirror `.kolm`
- agent platforms install `.kolm` tools

Implication:

- The roadmap should intentionally create third-party reasons to adopt the
  format.

Build consequence:

- Publish spec, verifier, conformance suite, sample artifacts, GitHub Action,
  MCP installer, registry API, and partner docs.

#### Insight 25: The near-term product should be narrow in workflow but broad
in compatibility

The product should not try to solve every AI workflow end to end immediately.
It should solve one workflow deeply:

> turn repeated private AI behavior into a verified portable artifact.

But it should be broad in compatibility:

- many providers
- many trace sources
- many storage backends
- many compute backends
- many runtime targets
- many governance exports

Implication:

- Narrow workflow, wide interoperability.
- This is how Kolm avoids both demo sprawl and platform irrelevance.

Build consequence:

- The first complete product loop should be:
  capture -> plan -> eval -> compile -> verify -> shadow -> promote -> audit.
- Everything else should plug into that loop.

### 5.15 Deep Competitor Dossiers And Product Implications

This section is intentionally more granular. The earlier competitor taxonomy
answers "who exists?" This section answers "what exactly do they teach us, what
can kill Kolm, and what must Kolm build differently?"

#### Dossier 1: Arcee, Lamini, Predibase, OpenPipe, Together, Fireworks

Buyer job:

- "I want a smaller or specialized model that beats a large frontier model on my
  task."

What these competitors teach:

- Arcee teaches that model merging, distillation, and SLM curation are their own
  craft. MergeKit, DistillKit, and SLM adaptation are direct conceptual overlap
  with Kolm's "compiled artifact" promise.
- Lamini teaches that "fine-tuning" is not the only mental model. Memory Tuning
  frames the job as factual recall inside small models, with many adapters and
  routing across memory experts.
- Predibase teaches that LoRA serving economics matter as much as training.
  Serverless fine-tuned endpoints and multi-adapter serving turn hundreds of
  customer/task adapters into one operational platform.
- Together and Fireworks teach that buyers want training and inference bundled.
  A fine-tuned model is not useful unless serving is cheap, scalable, and easy.
- OpenPipe teaches that OpenAI-compatible capture -> dataset -> fine-tune is a
  simple buyer narrative.

Threat to Kolm:

- They make Kolm look like an orchestration layer over training backends unless
  Kolm has stronger evidence, artifact, verifier, and portability primitives.
- If a buyer only wants "fine-tune a Llama/Mistral/Qwen model and deploy it,"
  these vendors are easier to understand.
- If Kolm cannot serve many artifacts cheaply, training output becomes shelfware.

Non-obvious insight:

- The direct moat is not "we can train." Training is increasingly available.
  The moat is:
  1. choosing the right optimization path
  2. proving data/eval integrity
  3. emitting a portable artifact
  4. verifying the artifact independently
  5. tracking downstream runtime behavior

Build implications:

- Kolm needs `TrainerAdapter` rather than one trainer.
- Kolm needs `AdapterServingPlan` for LoRA/multi-adapter outputs.
- Kolm needs `ArtifactServingPlan` for non-LoRA artifacts such as RAG, rules,
  prompt compression, routing policy, or quantized local model.
- Kolm needs to support "bring your own trained adapter" and wrap it into
  `.kolm` with evals, receipts, and target runtimes.

Proof gates:

- Given the same dataset, compare:
  OpenAI fine-tune, Predibase LoRA, Together fine-tune, Fireworks fine-tune,
  local Unsloth/Axolotl, and Kolm-selected plan.
- Show when Kolm chooses not to train.
- Show artifact diff and verifier output for all resulting candidates.

Strategic response:

- Position Kolm as the control/evidence layer above these training surfaces.
- Integrate with them before competing with all of them.
- Make the artifact and receipt more valuable than the training backend.

#### Dossier 2: Kiln, Argilla, Label Studio, Prodigy, Snorkel, Scale, Labelbox

Buyer job:

- "I need high-quality data, labels, eval sets, and human feedback."

What these competitors teach:

- Kiln teaches that the integrated task loop matters:
  specs, evals, synthetic data, fine-tuning, ratings, RAG, tools, MCP, team
  collaboration.
- Argilla and distilabel teach that data quality is the root lever. Synthetic
  data and AI feedback are useful only when reviewable, filterable, and tied to
  human preference workflows.
- Label Studio and Prodigy teach that annotation UX and extensibility matter:
  pre-labels, ML backends, custom recipes, review loops, active learning.
- Snorkel teaches that programmatic labeling and SME knowledge capture are more
  scalable than raw manual labeling.
- Scale/Labelbox teach enterprise buyers expect workforces, review quality,
  preference data, multimodal evaluation, and auditability.

Threat to Kolm:

- If Kolm does not own data quality, the compiler is downstream of garbage.
- If Kolm's label/review UX is shallow, serious teams will build datasets in
  Label Studio/Argilla/Scale and only use Kolm as a packaging step.
- If Kolm uses synthetic data without provenance and holdout restrictions, the
  trust story collapses.

Non-obvious insight:

- The "compiler" starts at data selection, not at model training.
- The highest-leverage product object may be `EvalCase`, not `Model`.
- Human feedback should produce reusable evidence, not just better examples.

Build implications:

- Add first-class `LabelQueue`.
- Add `ReviewPolicy`:
  required reviewers, adjudication rules, conflict handling, quality threshold.
- Add `SyntheticRowReceipt`:
  generator, prompt, seed, source examples, filter, policy, allowed split.
- Add active-learning priority:
  uncertainty, disagreement, high-cost call, high-frequency path, privacy risk,
  eval coverage gap.
- Add import/export:
  Argilla, Label Studio, Prodigy JSONL, Scale/Labelbox-compatible task formats,
  Hugging Face datasets.

Proof gates:

- Show train/holdout split excludes synthetic-only rows unless explicitly
  allowed and labeled as such.
- Show every eval item has provenance and no hidden leakage from train.
- Show human labels can override LLM judges and produce calibration deltas.

Strategic response:

- Kolm should not try to replace every labeling tool.
- Kolm should own evidence-grade dataset state and round-trip with the best
  labeling systems.

#### Dossier 3: Modular MAX, TVM, MLC LLM, IREE, TensorRT, OpenVINO, ONNX

Buyer job:

- "I need this model to run fast on real hardware."

What these competitors teach:

- Modular MAX teaches that compiler-performance claims must be backed by real
  kernels, hardware portability, serving, and benchmarks.
- TVM/Relax teaches that actual ML compilation has graph IR, transformation
  passes, dynamic shape handling, codegen, and cross-level optimization.
- MLC LLM teaches that "compile once, run on many devices" is a real local/edge
  deployment lane.
- IREE teaches that edge and datacenter can share compiler/runtime philosophy
  through MLIR-style lowering.
- TensorRT/OpenVINO/ONNX teach that enterprises already have acceleration
  standards and vendor-supported runtimes.

Threat to Kolm:

- "AI compiler" sounds naive unless Kolm clearly distinguishes artifact
  compilation from kernel/graph compilation.
- Hardware-aware buyers will ask for target-specific latency and memory proof,
  not brand language.

Non-obvious insight:

- Kolm should compile *to* compiler/runtime ecosystems, not pretend to replace
  them.
- The artifact format should include target-specific build outputs and target-
  specific receipts.

Build implications:

- Add backend target contract:
  `target`, `runtime`, `compiler`, `opset`, `quantization`, `hardware`,
  `memory_budget`, `latency_budget`, `compatibility_status`.
- Add compiler export receipts:
  command, version, input hashes, output hashes, hardware tested, numerical
  tolerance, unsupported ops.
- Add target conformance tests.

Proof gates:

- A `.kolm` artifact exported to ONNX/OpenVINO/CoreML/GGUF/MLX must be
  load-tested and inference-tested.
- If only conversion succeeded but hardware was not tested, mark it
  `converted_not_runtime_verified`.

Strategic response:

- Say "Kolm compiles AI behavior and evidence into portable artifacts; hardware
  targets are lowered through proven runtime/compiler backends."

#### Dossier 4: Baseten, Replicate, BentoML, Ray Serve, KServe, Triton, Modal,
RunPod

Buyer job:

- "I need this model/API/workflow deployed reliably."

What these competitors teach:

- Baseten/Replicate teach that packaging + endpoint + autoscaling + metrics is
  the buyer's definition of deployed.
- BentoML teaches that a deployment unit with CLI/API/cloud promotion is a
  successful developer abstraction.
- KServe teaches canary, rollback, inference service abstractions, and
  Kubernetes-native production patterns.
- Triton teaches model repositories, model versions, ensembles, and runtime
  backends.
- Ray Serve teaches autoscaling, multi-node serving, OpenAI compatibility, and
  app-level scaling.
- Modal/RunPod teach that developer-friendly GPU execution beats asking users
  to configure infrastructure.

Threat to Kolm:

- A `.kolm` artifact that cannot be deployed feels academic.
- If the user has to manually bridge artifacts to endpoints, competitors own
  production.

Non-obvious insight:

- "Compile" is incomplete until "shadow deploy and compare" is built.
- The deployment system must be evidence-generating.

Build implications:

- Add `DeploymentPlan`:
  target, endpoint, traffic policy, canary percent, rollback artifact,
  runtime, env, secrets references, storage, cost cap.
- Add `ShadowRun`:
  route production inputs to current provider and candidate artifact, compare
  outputs, measure cost/latency/quality, do not impact users.
- Add adapters:
  KServe, Ray Serve, BentoML, Triton model repository, Modal, RunPod,
  Replicate, Baseten, SageMaker.

Proof gates:

- A candidate artifact cannot be called production-ready until it has:
  verified artifact, deployment receipt, health check, shadow comparison, and
  rollback path.

Strategic response:

- Kolm should not be an inference platform first.
- It should be the artifact/evidence layer that can deploy into inference
  platforms and prove promotion safety.

#### Dossier 5: Glean, Moveworks, Coveo, H2O h2oGPTe, C3 AI, Palantir AIP

Buyer job:

- "I need enterprise AI that works over my company systems and permissions."

What these competitors teach:

- Glean teaches permission-aware enterprise knowledge graph is a massive moat.
- Moveworks teaches workflow completion matters more than chat quality.
- Coveo teaches retrieval, ranking, connectors, commerce/service/search
  context, and permissioned generative answers.
- H2O h2oGPTe teaches enterprise RAG buyers expect private cloud, air-gap,
  model routing, guardrails, PII redaction, and benchmarks.
- C3 and Palantir teach enterprise buyers value operational apps, ontology,
  workflow, and deployment machinery, not isolated model optimization.

Threat to Kolm:

- "Private AI" sounds like enterprise search/RAG to many buyers.
- If Kolm cannot explain how it complements permissioned enterprise knowledge
  systems, it will be perceived as an ML tool, not a business platform.

Non-obvious insight:

- Kolm's artifact can wrap enterprise RAG/workflow systems, but Kolm should not
  try to build the entire permission graph and connector ecosystem from zero.

Build implications:

- Add connector-aware artifact contracts:
  source system, permission model, index snapshot, connector version, chunk
  policy, retrieval policy.
- Add `PermissionReceipt`:
  user/group, source ACL hash, retrieval-time permission check, denied-source
  evidence.
- Add docs for "Kolm wraps Glean/Moveworks/Coveo/Pinecone/Weaviate workflows."

Proof gates:

- Show the artifact never surfaces a document the user could not access in the
  source system.
- Show index/chunk/source snapshots are versioned and diffable.

Strategic response:

- Position Kolm as verification and portability for enterprise AI systems, not
  a replacement for enterprise search.

#### Dossier 6: Dify, Flowise, Langflow, LangGraph, LlamaIndex, CrewAI,
AutoGen, Semantic Kernel

Buyer job:

- "I need to build an AI workflow or agent fast."

What these competitors teach:

- Visual builders win adoption because they make AI workflows tangible.
- Agent frameworks win developers because they provide tool abstractions,
  memory, orchestration, state, retries, and deployment.
- MCP is rapidly becoming a distribution surface for tools.

Threat to Kolm:

- If Kolm does not speak workflow/agent language, users will build in these
  tools and ignore artifact verification.
- If Kolm adds its own broad visual builder, it may drown in surface area.

Non-obvious insight:

- Kolm should become the artifact/evidence layer for workflows built elsewhere.
- `workflow.kolm` is more strategic than a no-code builder.

Build implications:

- Add import adapters:
  Dify workflow export, Flowise flows, Langflow flows, LangGraph graphs,
  LlamaIndex workflows, n8n workflows, MCP servers.
- Add `WorkflowReceipt`:
  graph hash, node versions, tool permissions, model providers, secrets
  references, evals, runtime policy.

Proof gates:

- Given a workflow export, Kolm should produce a permission diff, eval plan,
  runtime policy, and verification report.

Strategic response:

- Do not compete with every builder's UI.
- Make their outputs governable, verifiable, and portable.

#### Dossier 7: OpenRouter, LiteLLM, Requesty, Not Diamond, Portkey, Helicone,
Cloudflare, Vercel

Buyer job:

- "I want one API for all models with routing, cost control, fallback, and
  observability."

What these competitors teach:

- OpenRouter teaches model access and marketplace breadth.
- LiteLLM teaches OpenAI-compatible proxying and self-hostable breadth.
- Requesty teaches a productized gateway with real-time analytics, routing,
  budgets, guardrails, and many models.
- Not Diamond teaches intelligent routing can be trained and evaluated as a
  model-selection problem.
- Portkey/Helicone/Cloudflare/Vercel teach gateway, cache, log, budget,
  fallback, and observability are table stakes.

Threat to Kolm:

- Routing can solve enough cost/availability pain that buyers delay training or
  compilation.
- Gateway products own the call path, and the call path owns data.

Non-obvious insight:

- Gateway is customer acquisition. Compiler is conversion.
- If Kolm does not own or integrate into the gateway layer, it loses the data
  flywheel.

Build implications:

- Add gateway compatibility but expose native provider semantics.
- Add `RouteDecisionReceipt`:
  provider candidates, selected model, reason, cost/latency estimate, fallback,
  capabilities used/lost.
- Add `CompileCandidate` from gateway traces.

Proof gates:

- For each repeated task, compare:
  route-only, cache, prompt compression, RAG, fine-tune, distill, local
  artifact.
- Show why the selected path is better under constraints.

Strategic response:

- Never pitch gateway as the final product.
- Pitch gateway as the intake valve for the artifact/evidence loop.

#### Dossier 8: DeepEval, Braintrust, LangSmith, Langfuse, Opik, HoneyHive,
Parea, Patronus, Fiddler, Arthur

Buyer job:

- "I need to know whether my AI system is getting better or worse."

What these competitors teach:

- AI evals are now an engineering discipline, not a dashboard feature.
- Teams need datasets, experiments, traces, human review, online monitoring,
  eval metrics, regression tests, and prompt/model comparisons.
- Evals must operate at component level and end-to-end level.

Threat to Kolm:

- If Kolm's K-score is weaker than existing eval platforms, it will not be
  trusted.
- If Kolm cannot ingest their outputs, it creates duplicate work.

Non-obvious insight:

- K-score should be an evidence bundle summary, not a replacement for eval
  platforms.
- Evals become more valuable when attached to artifact versions and promotion
  decisions.

Build implications:

- Add eval importers:
  Braintrust, LangSmith, Langfuse, DeepEval, Opik, Promptfoo, Ragas, Phoenix.
- Add `EvalRunReceipt`:
  dataset hash, metric version, judge model, prompt, scorer code hash, human
  labels, pass/fail, confidence.
- Add evaluation lineage:
  eval -> artifact -> deployment -> shadow -> production drift.

Proof gates:

- Show the same eval suite can be run against provider API, local artifact,
  RAG artifact, and workflow artifact.

Strategic response:

- Make Kolm the promotion/evidence layer for eval results.

#### Dossier 9: Zenity, Lakera, Protect AI, HiddenLayer, Giskard, garak,
Enkrypt, Prompt Security, Aim Security

Buyer job:

- "I need to stop AI systems from leaking, hallucinating into actions, or
  importing malicious models."

What these competitors teach:

- Security is moving from prompt filters to agent behavior, tool permissions,
  runtime detection, model supply chain, and governance.
- Prompt injection is not just input text. It can come through RAG documents,
  tool outputs, browser content, MCP tools, and memory.
- Model files are executable supply-chain risk in many formats.

Threat to Kolm:

- If `.kolm` artifacts include models/tools/workflows, Kolm becomes part of the
  attack surface.
- A signed malicious artifact is still malicious.

Non-obvious insight:

- Verification must include security posture, not just authenticity.
- Tool permission diff may be more important than model diff for agentic
  artifacts.

Build implications:

- Add security pipeline before publish:
  model scan, dependency scan, license scan, prompt-injection probes,
  jailbreak probes, MCP/tool permission lint, secrets scan.
- Add runtime policy:
  guard inputs, retrieved context, tool calls, outputs, memory writes.
- Add integration hooks:
  Lakera, Giskard, garak, ModelScan, HiddenLayer, Presidio, NeMo Guardrails.

Proof gates:

- Registry publish fails or warns on unsafe serialization, missing license,
  excessive MCP permissions, failed red-team tests, or unscanned model payload.

Strategic response:

- Make Kolm artifacts easier to approve than raw model/workflow files.

#### Dossier 10: Edge Impulse, SensiML, NetsPresso, Latent AI, Core ML,
ExecuTorch, LiteRT

Buyer job:

- "I need AI on real devices under memory, latency, battery, and connectivity
  constraints."

What these competitors teach:

- Edge AI is an end-to-end lifecycle:
  collect data, train, optimize, estimate resources, deploy library/firmware/
  binary/container/browser package, test on device, update.
- Device-specific proof matters.
- Resource estimates are part of UX, not advanced settings.

Threat to Kolm:

- Local/offline claims will be dismissed without device-specific receipts.
- Edge teams need deployment and update strategy, not just artifact files.

Non-obvious insight:

- `.kolm` can be a signed model/workflow firmware-like unit for edge AI, but
  only if it includes target proof and rollout/rollback state.

Build implications:

- Add device profile registry.
- Add hardware verification levels:
  converted, simulated, locally tested, cloud-device tested, field verified.
- Add OTA/update receipts:
  artifact version, device group, rollout actor, rollback, runtime health.

Proof gates:

- Show device memory/latency/accuracy before launch.
- Refuse "edge-ready" label without real target proof or explicit simulation
  label.

Strategic response:

- Partner/integrate with edge toolchains and use Kolm to provide signed,
  auditable rollout evidence.

#### Dossier 11: IBM watsonx.governance, Credo, ModelOp, Monitaur, Holistic AI

Buyer job:

- "I need AI inventory, risk, controls, and regulatory evidence."

What these competitors teach:

- Governance is not a PDF. It is system inventory, risk tiering, approvals,
  controls, monitoring, accountability, vendor risk, change history, and export.
- Regulated organizations already have model risk workflows and GRC tools.

Threat to Kolm:

- If Kolm treats compliance as pages or checklists, governance platforms own
  the buyer.
- If Kolm cannot export evidence, auditors will ignore it.

Non-obvious insight:

- Kolm should feed governance tools with high-fidelity evidence.
- Artifact evidence can reduce governance toil if it is structured.

Build implications:

- Add `EvidenceBundle` export:
  model card, dataset card, eval card, security scans, risk tier, approval
  chain, deployment history, runtime receipts.
- Map evidence to NIST AI RMF, ISO 42001, EU AI Act, SOC 2, HIPAA, GDPR.
- Export to GRC systems through JSON/CSV/PDF and APIs later.

Proof gates:

- A compliance officer should be able to verify an artifact without asking an
  engineer to explain the codebase.

Strategic response:

- Do not become a full GRC platform first.
- Become the best evidence source for AI artifacts.

#### Dossier 12: Hugging Face, MLflow, Weights & Biases (W&B), Docker/OCI,
DVC, lakeFS, GitHub Models

Buyer job:

- "I need to find, version, distribute, and reproduce artifacts."

What these competitors teach:

- Hubs are not file stores. They are trust, community, metadata, docs, examples,
  versions, permissions, downloads, discussions, and automation.
- Registries work when they fit existing workflows.
- Data versioning is as important as model versioning.

Threat to Kolm:

- A proprietary registry with no ecosystem will feel lonely.
- Users will default to Hugging Face/GitHub/MLflow unless `.kolm` adds proof
  they cannot get elsewhere.

Non-obvious insight:

- Kolm registry should be trust-first, not community-first.
- Content-addressed artifacts plus verifier plus evidence cards is the wedge.

Build implications:

- Publish to Hugging Face/GitHub/OCI as optional mirrors.
- Store `.kolm` manifest and receipts in a way other registries can display.
- Add MLflow/W&B artifact links rather than forcing migration.

Proof gates:

- A `.kolm` artifact pulled from GitHub/HF/private registry should verify the
  same offline.

Strategic response:

- Win through artifact standard and verifier, not by out-social-networking
  Hugging Face.

### 5.16 Academic And Frontier Research Translation

This section translates research areas into specific product consequences.

#### Distillation And Small Models

Research signal:

- Knowledge distillation remains a broad family, not one method.
- Instruction distillation can create smaller models, but quality depends on
  teacher quality, task specificity, data quality, and eval design.
- Small models are most competitive when task scope is narrow and evals are
  representative.

Kolm implication:

- Do not market distillation as universally replacing frontier models.
- Market it as converting stable, narrow behavior into cheaper/private
  artifacts when evals prove it.

Build requirement:

- Add "distillation suitability" score:
  task stability, complexity, context dependence, output entropy, data volume,
  label quality, privacy sensitivity, and cost savings.

#### Fine-Tuning, LoRA, QLoRA, Adapter Serving

Research signal:

- LoRA/QLoRA lowered the barrier to adaptation.
- Multi-adapter serving changes economics because many fine-tuned behaviors can
  share base weights.
- Fine-tuning can hurt if data is noisy, task is ambiguous, or knowledge is
  dynamic.

Kolm implication:

- Treat adapters as one artifact payload type.
- Track adapter-base compatibility and serving economics.

Build requirement:

- Add `base_model_hash`, `adapter_hash`, `adapter_method`, `rank`,
  `merge_status`, `serving_mode`, `base_license`.

#### Quantization, Pruning, Sparsity, Compression

Research signal:

- Compression can reduce memory/cost/latency but may create task-specific
  regressions.
- Accuracy preservation is empirical, not guaranteed.
- Runtime and hardware determine whether theoretical compression yields real
  latency gains.

Kolm implication:

- Compression receipts need task eval deltas and target runtime measurements.
- File size alone is not a success metric.

Build requirement:

- Add compression receipt:
  method, calibration data, target runtime, measured memory, measured latency,
  quality delta, failure slices.

#### RAG And RAGOps

Research signal:

- RAG quality depends on ingestion, chunking, retrieval, reranking, generation,
  citation policy, and update strategy.
- RAG pipelines need lifecycle management, not just vector search.
- Hallucination evaluation is still imperfect and context-dependent.

Kolm implication:

- RAG should be a first-class artifact with its own evidence chain.
- Kolm can shine by making RAG reproducible and auditable.

Build requirement:

- Add `rag.kolm` manifest:
  source hashes, parser, chunker, embedding model, index schema, retriever,
  reranker, generator, citation policy, evals.

#### LLM-As-Judge And Evaluation Reliability

Research signal:

- LLM judges are useful but biased, prompt-sensitive, model-sensitive, and can
  disagree with humans.
- Evals need calibration, human baselines, deterministic checks, and regression
  stability.

Kolm implication:

- K-score cannot be a black-box LLM judge.
- It must combine deterministic, statistical, human, and LLM-evaluator evidence.

Build requirement:

- Add judge cards:
  judge model, prompt, rubric, calibration set, agreement with human labels,
  known blind spots, confidence interval.

#### Agent Security And Tool Use

Research signal:

- Tool-using agents create new risk because outputs become actions.
- Prompt injection defense cannot rely on prompts alone.
- Permissioning, tool gating, provenance, and execution-level controls matter.

Kolm implication:

- MCP/workflow artifacts need permission manifests and execution receipts.
- Tool-use evals must be part of artifact readiness.

Build requirement:

- Add `tool_permission_manifest.json`.
- Add tool-call replay/eval:
  selected tool, expected tool, args validity, permission check, human approval.

#### Federated Learning, Differential Privacy, And Data Sovereignty

Research signal:

- Federated learning can reduce raw data movement but does not automatically
  guarantee privacy.
- Differential privacy has utility tradeoffs and needs explicit epsilon/delta
  accounting.
- Secure aggregation and auditability matter.

Kolm implication:

- Federated compile should be marketed carefully.
- It should produce privacy receipts, not vague privacy claims.

Build requirement:

- Add federated receipts:
  peer, data schema hash, aggregation method, DP parameters, secure aggregation
  proof, contribution summary, output hash.

#### Reproducibility, Supply Chain, And Provenance

Research signal:

- ML reproducibility is hard because code, data, random seeds, hardware,
  kernels, and dependencies change.
- SLSA/in-toto/Sigstore patterns matter for trust.

Kolm implication:

- "Byte-identical" should not be claimed unless deterministic conditions are
  enforced and documented.
- "Reproducible enough to verify behavior and provenance" is often more honest.

Build requirement:

- Define reproducibility levels:
  source-identical, environment-identical, deterministic-output-identical,
  behavior-equivalent, provenance-verified.

### 5.17 Build, Buy, Integrate, Or Avoid Matrix

The product will fail if Kolm tries to build every layer. This matrix is the
recommended scope discipline.

Build first-party:

- `.kolm` spec
- verifier
- evidence ledger
- compile/decision plan
- K-score/eval-card binding
- train/holdout integrity
- artifact diff
- private registry
- runtime receipts
- governance evidence export
- CLI/TUI/account workflow over the same object model

Integrate deeply:

- OpenAI, Anthropic, Gemini, Bedrock, Vertex, Azure providers
- Ollama, vLLM, llama.cpp, MLX, ONNX Runtime, OpenVINO, Core ML
- Modal, RunPod, Replicate, Baseten, SageMaker, Vertex, Azure compute
- Langfuse, LangSmith, Braintrust, W&B, Phoenix, OpenTelemetry traces
- Argilla, Label Studio, Prodigy, Scale/Labelbox exports
- Giskard, garak, ModelScan, Lakera, Presidio security/privacy scanners
- Hugging Face, GitHub, OCI, MLflow, W&B artifact mirrors

Partner or defer:

- broad enterprise search connector ecosystem
- full visual workflow builder
- full human-labeling workforce
- owning GPU cloud capacity
- full GRC system of record
- kernel compiler development
- phone-native SDKs for every platform before web/local proof

Avoid at launch:

- fake "all models" wrapper that hides semantic differences
- broad marketplace with ratings/comments before private registry trust
- claiming HIPAA/FedRAMP/SOC2 before contracts and audits exist
- claiming hardware acceleration without target measurements
- claiming K-score as universal truth
- claiming deterministic reproducibility without levels
- inventing a proprietary runtime when existing runtimes already win trust

### 5.18 Roadmap Implied By The Research

This is not the whole company roadmap. It is the research-implied order of
operations if the goal is a finished, credible, world-class product.

#### Phase 1: Trust Core

Ship:

- public `.kolm` spec
- offline verifier
- manifest/eval/dataset/security card schemas
- artifact diff
- evidence ledger
- train/holdout proof
- K-score methodology by artifact kind
- local runtime receipt

Why:

- Without this, Kolm is a workflow tool with branding.

Gate:

- Third party can verify a sample artifact offline and understand exactly what
  passed, failed, or remains unverified.

#### Phase 2: Capture To Decision

Ship:

- OpenAI + Anthropic + local/vLLM/Ollama gateway capture
- provider capability matrix
- capture filters and zero retention
- opportunity detection
- `kolm plan`
- route/cache/RAG/fine-tune/distill/local/no-op recommendations

Why:

- This creates value before training and creates the data flywheel.

Gate:

- User connects one provider and gets a useful, honest recommendation without
  training anything.

#### Phase 3: Compute And Training Orchestration

Ship:

- TrainPlan
- ComputePlan
- local Unsloth/Axolotl/TRL path
- cloud adapters for Modal/RunPod/Replicate/Baseten/SageMaker
- teacher adapters for OpenAI/Anthropic/Gemini/provider outputs
- cost caps and fallback

Why:

- No-GPU users need a real path.

Gate:

- Same dataset can run local, remote, or managed with comparable receipts.

#### Phase 4: Runtime And Deployment Proof

Ship:

- target exports: GGUF, ONNX, MLX, Core ML/OpenVINO as feasible
- runtime conformance tests
- shadow deploy
- promotion receipt
- rollback
- KServe/Bento/Ray/Modal/RunPod deploy adapters

Why:

- Training without deployment is not a product.

Gate:

- Artifact can be shadowed against a production provider and promoted with
  proof.

#### Phase 5: Enterprise Evidence And Registry

Ship:

- private registry
- org RBAC
- approval workflow
- verified publisher
- audit export
- SIEM/OpenTelemetry
- AI-BOM/SBOM/SLSA/in-toto/Sigstore integration
- private mirror/air-gap bundle

Why:

- This is where enterprise ACV comes from.

Gate:

- Security/compliance reviewer can approve or reject an artifact from evidence
  without engineering handholding.

#### Phase 6: Ecosystem Standardization

Ship:

- conformance suite
- sample artifacts
- GitHub Action
- SDK verifier libraries
- MCP installer
- public registry API
- partner docs for runtimes and platforms

Why:

- This is the standards/platform path.

Gate:

- External project can emit or verify `.kolm` without Kolm SaaS.

### 5.19 What Would Make The Product Feel "Finished"

A finished Kolm product is not "many pages pass screenshots." It means a user
can complete the core loop with proof.

Finished developer loop:

1. Install CLI.
2. Connect provider or local model.
3. Capture traffic with a clear privacy mode.
4. See opportunities.
5. Run `kolm plan`.
6. Approve eval/holdout.
7. Compile with local or cloud compute.
8. Verify artifact offline.
9. Shadow it.
10. Promote or reject.
11. Export evidence.

Finished enterprise loop:

1. Create org.
2. Configure SSO/SCIM/RBAC/API keys.
3. Configure storage and compute boundaries.
4. Configure provider policies.
5. Capture with redaction/zero-retention rules.
6. Review compile candidates.
7. Approve training/evals.
8. Publish to private registry.
9. Export compliance package.
10. Monitor runtime receipts and drift.

Finished researcher loop:

1. Import dataset.
2. Define evals as code.
3. Compare route/RAG/fine-tune/distill/quantize options.
4. Export configs for TRL/Axolotl/Unsloth.
5. Import trained adapter/model.
6. Package as `.kolm`.
7. Verify and benchmark.

Finished edge loop:

1. Select target device profile.
2. Compile/export target.
3. Measure or simulate latency/memory.
4. Verify on hardware or mark unverified.
5. Sign rollout.
6. Track device receipts.
7. Roll back.

Finished governance loop:

1. Inventory AI system.
2. Attach artifact/evidence.
3. Map controls.
4. Review risk.
5. Approve promotion.
6. Export audit bundle.
7. Track changes and incidents.

If any of those loops has a "just trust us" step, the product is not finished.

### 5.20 Insight Bank From The Deep Research Pass

This section is the direct translation layer. The competitor dossiers name the
markets. The insights below turn that research into atomic product decisions.

#### Positioning Insights

1. Kolm cannot win by saying "fine-tuning platform." That lane is already
   occupied by Predibase, Together, Fireworks, OpenAI, Bedrock, SageMaker, and
   Azure. Kolm wins by owning verified transformation from live behavior into a
   portable artifact.
2. "AI compiler" is valuable only if the product explains what is being
   compiled: behavior, data splits, evals, target runtime, receipts, security
   posture, and deployment policy.
3. The homepage and docs should say "compile repeated AI behavior into signed
   artifacts" before saying "train models." Training is one possible compile
   backend, not the category.
4. The standard story is more valuable than the training story. The market has
   many ways to train; it does not have a trusted portable artifact that bundles
   evidence.
5. The valuation path depends on whether third parties can inspect, verify,
   mirror, and run `.kolm` without trusting Kolm's hosted app.
6. The best buyer narrative is not "replace OpenAI" or "replace Claude." It is
   "stop paying frontier-model prices for repeated private behavior once the
   behavior is proven."
7. The enterprise narrative is not "local AI." It is "promotion control for AI
   systems: capture, prove, compile, shadow, approve, deploy, audit."
8. The researcher narrative is not "easy UI." It is "reproducible artifacts
   with frozen data/eval/model/runtime state and falsifiable receipts."
9. The developer narrative is not "dashboard." It is "one command takes traces
   to an artifact, and every artifact can be verified offline."
10. The security narrative is not "we sign artifacts." It is "we scan and
    policy-check the thing before signing it, then preserve the evidence."

#### Product Architecture Insights

1. The core product object should be `Artifact`, but the core workflow object
   should be `Promotion`.
2. Every product surface should be able to answer:
   "what artifact is this, where did it come from, what was it tested against,
   where can it run, who approved it, and what changed?"
3. The capture lake is the highest-leverage data asset. Without capture, Kolm
   is a manual training tool. With capture, Kolm is a continuous optimization
   system.
4. The compiler should emit multiple candidate plans before emitting a final
   artifact:
   route-only, cache, prompt compression, RAG, rules, small fine-tune, local
   quantized model, remote hosted model, workflow wrapper.
5. A "compile" that always trains is a weak compiler. A strong compiler often
   refuses to train and chooses cheaper or safer transformations.
6. Provider adapters should preserve native capability semantics. OpenAI-
   compatible APIs are useful at the edge but too lossy for planning.
7. Model-provider support must be testable through conformance fixtures, not
   only listed in a marketing matrix.
8. Compute support must separate:
   local CPU/GPU, local external runtime, Kolm cloud, customer cloud, rented GPU,
   enterprise VPC, and air-gapped mode.
9. Artifact storage should use an S3-compatible abstraction from day one so
   Cloudflare R2, AWS S3, Supabase S3 compatibility, MinIO, and customer buckets
   are all first-class.
10. The control plane should be separable from the data plane. Enterprise
    buyers will accept hosted governance faster than hosted sensitive data.

#### Capture And Gateway Insights

1. Gateway breadth creates adoption, but evidence conversion creates retention.
2. The gateway should capture intent, prompt, model, provider, latency, cost,
   errors, tool calls, retrieval context, output hash, and user feedback.
3. Capture filters are mandatory. Serious teams need "capture only this model,"
   "exclude this project," "sample 5 percent," "capture failures," and "never
   store raw prompt."
4. Zero-retention mode is not optional for regulated customers. The system must
   support route/evaluate without persisting payloads.
5. Redaction cannot be a single regex pass. It needs hybrid detectors, per-class
   metrics, confidence, reversible vault options, and false-positive review.
6. OpenTelemetry export is table stakes because enterprises already have
   Datadog, Honeycomb, Grafana, Splunk, and SIEM workflows.
7. Provider routing should produce receipts, not silent decisions.
8. Capture-to-dataset conversion needs leakage controls. Train and holdout
   separation must happen before any synthetic augmentation.
9. Cost analytics are a wedge. Finance teams can champion Kolm before the model
   team believes in compilation.
10. The gateway should surface repeated high-cost paths as "compile
    opportunities" with expected savings and confidence.

#### Training, Distillation, And Optimization Insights

1. Support OpenAI and Anthropic as teachers, but do not hard-code the product to
   any one frontier provider.
2. Add provider families:
   OpenAI, Anthropic, Google, Bedrock, Azure, Together, Fireworks, Groq, Cerebras,
   Mistral, Cohere, Hugging Face, Ollama, vLLM, SGLang, LM Studio, OpenRouter,
   LiteLLM-compatible gateways.
3. Add training backends:
   OpenAI fine-tune, Together fine-tune, Fireworks LoRA, Predibase, local
   Axolotl/Unsloth/LlamaFactory, Hugging Face AutoTrain, SageMaker, Bedrock
   customization, Vertex/Azure where practical.
4. Distillation should support rationales, preference distillation, logits where
   available, synthetic expansion, rejection sampling, and self-consistency, but
   every method must preserve provenance.
5. LoRA and adapter serving are economically important. The product needs
   adapter packaging and multi-adapter serving plans.
6. Quantization is a first-class compile path. Support GGUF, ONNX, OpenVINO,
   Core ML, MLX, TensorRT-LLM, LiteRT, ExecuTorch, and WASM/WebGPU labels as
   target contracts.
7. Compression should be benchmark-driven. Smaller is a regression unless
   quality, latency, memory, and cost improve under the buyer's constraints.
8. The compiler should diagnose "not enough data," "ambiguous task," "noisy
   labels," "dynamic knowledge," "needs RAG not training," and "teacher
   disagreement."
9. Incremental compilation is retention. Users should be able to add a week of
   traces and get a diff, not restart the workflow.
10. The product needs "bring your own model or adapter" wrapping because serious
    ML teams already have artifacts they do not want to retrain.

#### Data, Labeling, And Eval Insights

1. The most important primitive is an eval case with provenance.
2. Synthetic rows should never silently become holdout rows.
3. Human review UX should prioritize high-disagreement, high-cost, high-volume,
   high-risk, and high-uncertainty samples.
4. Labeling integrations should be import/export first, replacement later.
5. Eval import should support Braintrust, LangSmith, Langfuse, DeepEval, Opik,
   Promptfoo, Ragas, Phoenix/OpenInference, W&B Weave, and plain JSONL.
6. K-score should decompose into task axes:
   exactness, semantic quality, safety, latency, cost, robustness, calibration,
   leakage risk, drift, and evaluator confidence.
7. LLM-as-judge outputs need judge model, prompt hash, rubric hash, temperature,
   seed where available, and calibration status.
8. Component evals and end-to-end evals must be separate. A good retriever with
   a bad generator should not produce one vague score.
9. Shadow eval is more persuasive than offline eval. Buyers trust comparisons
   against live traffic.
10. The UI should never say "ready" without a visible path to the evidence that
    made it ready.

#### Runtime, Deployment, And Cloud Insights

1. An artifact without a deployment path is not a product outcome.
2. Deployment targets should include:
   local process, Docker, serverless endpoint, KServe, Ray Serve, BentoML,
   Triton, Modal, RunPod, Replicate, Baseten, SageMaker, Cloudflare Workers,
   Vercel Edge, customer Kubernetes, and air-gapped bundle.
3. Every deployment should create a deployment receipt:
   artifact hash, runtime hash, environment, secrets references, health check,
   traffic policy, rollback pointer, and actor.
4. Shadow deploy should be the default promotion method for production users.
5. Rollback must be a first-class button and CLI verb.
6. Runtime telemetry should be opt-in, anonymized, and useful:
   p50/p95/p99 latency, memory, cold start, failure code, device/runtime.
7. The local runtime should work without Kolm cloud for artifact verification
   and basic execution.
8. Cloud training is required for users without GPUs. The product should expose
   rented GPU, customer cloud, and Kolm-managed compute as selectable compute
   targets.
9. Compute selection should be guided:
   "fastest," "cheapest," "regulated," "air-gapped," "local only," "best
   quality," "low-latency edge."
10. Production readiness requires load tests and failure injection, not only
    unit tests.

#### Edge, Local, And Device Insights

1. "Runs locally" is incomplete. State the tested hardware, OS, runtime, memory,
   latency, model size, and accuracy.
2. The device matrix should include Apple Silicon/ANE/Core ML/MLX, NVIDIA CUDA
   and Jetson, Qualcomm QNN/Hexagon, Intel OpenVINO/NPU, AMD ROCm where
   practical, browser WebGPU/WASM, Android LiteRT/ExecuTorch, and iOS Core ML.
3. Edge artifacts need update and rollback semantics.
4. Browser runtime has a different buyer than datacenter runtime. Browser
   buyers care about bundle size, cold start, privacy, and offline UX.
5. Embedded and IoT buyers need C/C++ examples, deterministic memory use, and
   hardware-specific build instructions.
6. Device verification levels should be explicit:
   converted, simulated, locally tested, cloud-device tested, field verified.
7. The UI should not call a target "supported" when it is only exportable.
8. Device constraints should be part of compile planning, not a post-export
   detail.
9. Edge Impulse, SensiML, and NetsPresso show that resource estimation is a UX
   primitive, not a hidden log.
10. A `.kolm` artifact can become a firmware-like signed AI unit if target proof
    and OTA evidence are part of the format.

#### Security, Privacy, And Governance Insights

1. Authenticity is weaker than safety. A signed artifact can still be unsafe.
2. Publish-time security checks should include model serialization scan,
   dependency scan, license scan, prompt-injection probes, jailbreak probes,
   secrets scan, and permission diff.
3. MCP/tool artifacts must expose tool permissions before installation.
4. RAG and agent systems require context-level guards because the attack often
   enters through retrieved text or tool output.
5. BYOK/CMK and customer-managed storage are enterprise unlocks.
6. SCIM, SAML/OIDC SSO, RBAC, audit logs, retention policy, and evidence export
   are not enterprise polish. They are procurement gates.
7. Governance exports should map to NIST AI RMF, ISO 42001, EU AI Act, SOC 2,
   HIPAA, GDPR, and internal model-risk workflows.
8. A trust center page is not enough. Product actions must generate evidence.
9. Air-gap install should be designed as a real packaging target, not a sales
   slide.
10. The artifact verifier should be standalone and open-source so security teams
    can approve artifacts without trusting the hosted product.

#### Registry And Standard Insights

1. `.kolm` should be an open spec before the ecosystem needs one.
2. The spec should define ZIP layout, manifest schema, signatures, receipts,
   artifact types, target contracts, eval cards, dataset cards, security cards,
   and compatibility policy.
3. The registry should be trust-first:
   verified publisher, scan status, evidence completeness, license, runtime
   support, dependency graph, version diff, and reproducibility badge.
4. Mirror support matters more than owning all distribution. Publish to OCI,
   Hugging Face, GitHub Releases, MLflow, and private S3-compatible storage.
5. A verifier plus conformance suite is how third parties start building tools.
6. Registry search should be structured by task, target runtime, model family,
   compliance status, license, hardware, and K-score axes.
7. Artifact diff should show data, prompt, eval, runtime, model, permission,
   and security changes.
8. The registry should support private enterprise instances and air-gapped
   mirrors.
9. Usage stats are useful, but evidence quality is the trust signal.
10. The long-term platform move is partner tooling that emits or consumes
    `.kolm` without Kolm's web app.

#### CLI, TUI, Account, And Website Insights

1. The CLI should be the canonical serious-user surface. It must expose every
   state transition clearly and scriptably.
2. The TUI should be a local cockpit:
   traces, datasets, evals, compile jobs, artifacts, deployments, logs, and
   doctor checks.
3. Account post-auth should split by user intent:
   gateway/capture, dataset/evals, compile/training, deploy/runtime, governance,
   billing/admin.
4. The website should not list every surface equally. It should walk one
   primary loop and then reveal compatibility depth.
5. Docs should be task-first:
   "capture OpenAI/Claude traffic," "compile a repeated task," "shadow deploy,"
   "verify artifact," "run locally," "export evidence."
6. API docs should have runnable examples for OpenAI and Anthropic traffic,
   async compile jobs, artifacts, evals, deployments, and receipts.
7. Copy should reduce buzzwords and increase proof:
   artifact hash, p95 latency, cost delta, eval set size, target runtime,
   verification command.
8. Pricing copy should align to buyer maturity:
   developer proof, team workflow, enterprise control, regulated deployment.
9. Every CTA should lead to one of three outcomes:
   run command, inspect proof, or talk to sales for controlled deployment.
10. "Finished" UX means the next best action is obvious after every command,
    UI state, and failed compile.

#### Commercial And Valuation Insights

1. The fastest enterprise wedge is cost and control over repeated high-volume
   AI calls.
2. The strongest regulated wedge is evidence and data boundary control, not
   cheaper tokens.
3. The most strategic developer wedge is a verifier/spec/runtime that can spread
   without procurement.
4. Cloud compute is required for adoption because many buyers do not have GPUs.
5. Customer-cloud and VPC compute are required for enterprise credibility.
6. Marketplace revenue is only credible after artifacts are trusted.
7. The standardization path requires external contributors, public examples,
   and third-party conformance badges.
8. The moat compounds when traces, evals, artifacts, deployments, and governance
   evidence all refer to the same content-addressed objects.
9. The product should be opinionated about the promotion loop, but permissive
   about providers, runtimes, storage, and compute.
10. The billion-dollar version of Kolm is not a better fine-tune dashboard. It
    is the evidence and artifact layer for private AI deployment.

### 5.21 Everything-Everywhere Coverage Matrix

This is the coverage map for "basically anything with basically any model on
basically any compute." It is intentionally broad. The point is not that Kolm
should build every third-party system. The point is that every real buyer path
should have a deliberate Kolm posture:

- `own`: Kolm must control this as core product IP.
- `adapter`: Kolm should integrate deeply but not replace the third-party tool.
- `import`: Kolm should ingest evidence, traces, datasets, or artifacts.
- `export`: Kolm should emit artifacts, configs, receipts, or deployments.
- `mirror`: Kolm should publish or sync metadata to the ecosystem location.
- `defer`: Kolm should document a boundary and avoid fake support.

#### Surface 1: `identity-access-billing`

What exists in the market:

- Auth providers: WorkOS, Auth0, Clerk, Stytch, Okta Customer Identity, Cognito.
- Enterprise identity primitives:
  SAML, OIDC, SCIM, JIT provisioning, domain capture, passkeys, MFA, session
  management, admin portal, audit logs.
- Authorization primitives:
  RBAC, ABAC, workspace roles, project roles, artifact roles, deployment roles,
  key scopes, service accounts, temporary credentials.
- Billing primitives:
  Stripe Billing, Stripe customer portal, usage metering, invoices, dunning,
  credits, trials, enterprise contracts, overage alerts, spend caps.
- Enterprise procurement:
  SOC 2 packet, DPA, BAA, subprocessors, security questionnaire, status page,
  vendor risk exports.

Kolm posture:

- Own org/workspace/project/artifact authorization semantics.
- Adapter to WorkOS/Auth0/Okta-style SSO and SCIM.
- Adapter to Stripe for self-serve billing and invoice state.
- Own usage metering by tokens, calls, compute seconds, artifact builds,
  artifact pulls, storage, seats, and enterprise policy events.
- Export audit logs to SIEM and GRC.

Finished-product requirements:

1. A user can sign up, create an org, invite a teammate, assign role, create key,
   revoke key, change plan, and see entitlement state without support.
2. Enterprise can configure SSO/SCIM/RBAC and get audit logs.
3. Every API key has scopes:
   gateway, capture, dataset, compile, deploy, registry, admin, billing,
   governance.
4. Every usage event is attributable to org, project, key, user, artifact,
   deployment, provider, and compute target.
5. Billing UI and API agree exactly.

Do not build:

- A custom identity provider.
- A custom payment processor.
- A separate procurement workflow that cannot export evidence.

#### Surface 2: `public-docs-sdk`

What exists in the market:

- API documentation standards:
  OpenAPI, SDK examples, Postman collections, MCP docs, llms.txt, changelog,
  status page, generated API refs, runnable snippets.
- Developer docs expectations:
  quickstart, local install, hosted API, auth, error codes, rate limits,
  examples, recipes, migration guides, troubleshooting, security model.
- SDK ecosystems:
  TypeScript, Python, Go, Rust, Java/JVM, C/C++, Swift, Kotlin, .NET, MCP,
  VS Code, GitHub Actions, Docker images.
- Website expectations:
  one clear category claim, proof above the fold, short path to demo, pricing,
  docs, trust, enterprise contact, changelog, real examples, no fake breadth.

Kolm posture:

- Own docs for the Kolm loop:
  capture -> plan -> eval -> compile -> verify -> shadow -> promote -> audit.
- Export OpenAPI and SDKs.
- Mirror installer and packages to developer-native channels:
  npm, PyPI, Homebrew, winget, Docker, GitHub Releases, crates.io where relevant.
- Publish llms.txt and ai-context for agent consumption.
- Adapter examples for OpenAI, Anthropic, Gemini, Bedrock, Azure, Vertex,
  Together, Fireworks, Ollama, vLLM, SGLang, LiteLLM, OpenRouter.

Finished-product requirements:

1. The first five minutes get a developer from API key to captured trace.
2. The first thirty minutes get a developer from trace to verified artifact.
3. Every docs claim links to command, API, artifact schema, or proof.
4. Every SDK has install, auth, errors, retries, pagination where applicable,
   streaming where applicable, and examples.
5. Docs include both "happy path" and "when not to compile."

Do not build:

- A giant marketing branch for every possible persona.
- Duplicative docs pages that obscure the canonical core loop.
- Claims that do not map to a command/API/page.

#### Surface 3: `compile-artifact-verification`

What exists in the market:

- Training products:
  OpenAI fine-tuning/distillation, Azure OpenAI fine-tuning, Bedrock
  customization/distillation/reinforcement fine-tuning, Vertex AI supervised
  tuning, Mistral fine-tuning, Cohere fine-tuning, Together, Fireworks,
  Predibase, Lamini, Arcee, OpenPipe.
- Open training stacks:
  Transformers, TRL, PEFT, Accelerate, DeepSpeed, FSDP, Megatron-LM, NeMo,
  torchtune, Axolotl, Unsloth, LlamaFactory, MLX, bitsandbytes, torchao.
- Distillation and optimization methods:
  supervised distillation, rationale distillation, preference distillation,
  rejection sampling, DPO, ORPO, GRPO, RLHF/RLAIF, LoRA, QLoRA, DoRA, adapters,
  model merging, pruning, sparsity, quantization, prompt compression, semantic
  caching.
- Artifact formats:
  safetensors, GGUF, ONNX, MLX, Core ML package, TensorRT engine, OpenVINO IR,
  ExecuTorch program, LiteRT/TFLite, Docker/OCI artifact, MLflow model, Hugging
  Face repo, custom ZIP.
- Verification systems:
  signatures, Sigstore/cosign, SLSA provenance, in-toto attestations, SBOM,
  ML-BOM, model cards, dataset cards, eval cards.

Kolm posture:

- Own `.kolm` as the evidence envelope.
- Own compiler planning:
  decide whether to route, cache, compress, RAG, rule, fine-tune, distill,
  quantize, or wrap workflow.
- Adapter to training backends and local training stacks.
- Export to runtime formats and include target receipts.
- Own standalone verifier and conformance suite.
- Mirror artifacts to OCI, Hugging Face, GitHub, S3-compatible storage, MLflow,
  and private registry.

Finished-product requirements:

1. `.kolm` spec is public, versioned, and stable.
2. Artifact contains manifest, recipes, split metadata, eval card, dataset card,
   runtime targets, signatures, receipts, security scan result, and verifier
   instructions.
3. Build is reproducible or explicitly marked non-reproducible with reason.
4. Train/holdout/synthetic provenance is impossible to confuse.
5. Artifact diff shows data, prompt, model, eval, runtime, permission, security,
   and deployment changes.
6. Offline `kolm verify artifact.kolm` works without SaaS.
7. Bring-your-own adapter/model can be wrapped with evidence.
8. Compile failure is diagnostic:
   insufficient data, ambiguous task, noisy labels, dynamic knowledge, missing
   evaluator, target too small, privacy constraint, backend unavailable.

Do not build:

- A from-scratch replacement for PyTorch, vLLM, TensorRT, or every trainer.
- A proprietary-only artifact that no one can inspect.
- A single K-score that hides the underlying eval evidence.

#### Surface 4: `runtime-inference-connectors`

What exists in the market:

- Frontier APIs:
  OpenAI Responses/Chat Completions, Anthropic Messages, Gemini API/Vertex,
  Mistral API, Cohere, AI21, xAI, Perplexity, DeepSeek API where available.
- Cloud provider surfaces:
  Bedrock, Azure AI Foundry/OpenAI, Vertex AI, SageMaker, Databricks Mosaic AI,
  Snowflake Cortex, Cloudflare Workers AI.
- Aggregators and gateways:
  OpenRouter, LiteLLM, Portkey, Helicone, Cloudflare AI Gateway, Vercel AI
  Gateway, Requesty, Not Diamond.
- Local runtimes:
  Ollama, LM Studio, llama.cpp, vLLM, SGLang, TGI, ExLlamaV2, MLX, Jan, LocalAI,
  Docker Model Runner.
- Modalities:
  text, code, embeddings, rerankers, vision, OCR, audio transcription, TTS,
  image generation, video generation, structured outputs, tool calls,
  function calling, computer use, browser use.
- RAG/connectors:
  Pinecone, Weaviate, Milvus, Qdrant, pgvector, Elasticsearch/OpenSearch,
  Vespa, Chroma, LanceDB, LlamaIndex, Haystack, Unstructured, Ragas.

Kolm posture:

- Own capability registry and conformance tests.
- Adapter to all major provider APIs.
- Preserve native provider features instead of flattening everything to
  OpenAI-compatible schema.
- Import traces from gateways and observability tools.
- Export OpenAI-compatible endpoint where useful.
- Own inference receipt:
  provider, model, capability, cache state, route decision, tool call, context
  sources, latency, cost, output hash, policy decisions.

Finished-product requirements:

1. Every provider/model has a capability record:
   streaming, tools, JSON schema, vision, audio, embeddings, batch, cache,
   fine-tune, distill, max context, data-retention policy, region, SLA.
2. Every connector has a smoke test and conformance fixture.
3. OpenAI and Anthropic both work as first-class options, not one as an afterthought.
4. Local runtimes are treated as compute targets and inference sources.
5. Provider-specific cache/tool semantics are preserved in planning.
6. RAG artifacts include retrieval receipts and permission receipts.
7. Multimodal pipelines record sidecar metadata for source media, derived text,
   OCR, embeddings, and redaction.

Do not build:

- A lowest-common-denominator wrapper that hides important provider differences.
- Fake multimodal support where the product only stores a file path.
- "Any model" claims without capability and conformance evidence.

#### Surface 5: `capture-data-eval-training`

What exists in the market:

- Capture/logging:
  Langfuse, LangSmith, Braintrust, Helicone, Portkey, Cloudflare AI Gateway,
  Vercel AI Gateway, OpenTelemetry, OpenInference, Arize Phoenix.
- Datasets and labeling:
  Kiln, Argilla, distilabel, Label Studio, Prodigy, Snorkel, Labelbox, Scale,
  Surge AI, Humanloop, Hugging Face datasets.
- Evals:
  Braintrust, LangSmith, Langfuse, DeepEval, Promptfoo, Ragas, OpenAI Evals,
  OpenAI graders, Humanloop, Opik, Parea, HoneyHive, Patronus, Arthur, Fiddler,
  Giskard.
- Evaluation types:
  exact match, classification F1, schema validation, unit tests, code tests,
  golden-set evals, pairwise preference, LLM-as-judge, rubric judge, RAG
  faithfulness, retrieval recall, hallucination, safety, jailbreak, toxicity,
  latency, cost, robustness, drift.
- Data risks:
  PII/PHI leakage, train/holdout leakage, synthetic contamination, label noise,
  stale knowledge, biased reviewer pool, prompt injection in source documents,
  overfitting to evals.

Kolm posture:

- Own capture-to-opportunity-to-promotion loop.
- Import traces/datasets/evals from existing tools.
- Export datasets/eval results back where useful.
- Own split integrity and provenance.
- Own K-score as a structured evidence summary.
- Adapter to labeling/eval ecosystems.

Finished-product requirements:

1. Capture modes:
   store raw, store redacted, hash only, zero-retention, sample, filter by
   provider/model/project/user/error/latency/cost.
2. Dataset builder:
   promote trace to row, add label, assign split, detect duplicates, detect
   leakage, mark synthetic, mark source, require review.
3. Eval builder:
   exact/schema/code/LLM judge/human/RAG/security/performance metrics.
4. Training loop:
   local and cloud compute, async jobs, webhooks, progress, logs, cost estimate,
   cancel, resume, retry, cache.
5. Opportunity engine:
   repeated pattern, high cost, low latency tolerance, stable output shape,
   high confidence, enough examples, privacy constraint, target recommendation.
6. K-score decomposition:
   quality, robustness, safety, data integrity, runtime fit, cost/latency,
   governance completeness.
7. Every eval result can be traced to data hashes and scorer versions.

Do not build:

- A labeling workforce business in the first product phase.
- A judge-only K-score with no calibration.
- Synthetic data generation that can silently poison holdout.

#### Surface 6: `governance-compliance-security`

What exists in the market:

- AI governance:
  IBM watsonx.governance, Credo AI, ModelOp, Holistic AI, Monitaur, DataRobot,
  Dataiku governance, Palantir AIP controls.
- Security:
  Lakera, Giskard, garak, Protect AI ModelScan, HiddenLayer, Zenity, Prompt
  Security, Aim Security/AIMon, Enkrypt, NeMo Guardrails, Presidio.
- Standards and frameworks:
  NIST AI RMF, ISO/IEC 42001, EU AI Act, OWASP LLM Top 10, OWASP MCP Top 10,
  SOC 2, ISO 27001, HIPAA, GDPR, FedRAMP, SLSA, in-toto, CycloneDX ML-BOM.
- Governance objects:
  AI inventory, risk tier, owner, approver, model card, dataset card, eval card,
  data lineage, vendor risk, change history, incident log, audit export,
  retention policy, access review.
- Security objects:
  prompt injection scan, jailbreak scan, model serialization scan, dependency
  scan, license scan, secrets scan, RAG source scan, tool permission diff,
  runtime guardrail decision, SIEM event.

Kolm posture:

- Own evidence bundle at artifact and deployment level.
- Export to GRC/SIEM tools.
- Adapter to security scanners.
- Own policy engine for artifact promotion.
- Own verification UX for compliance and security reviewers.

Finished-product requirements:

1. Every artifact has owner, risk tier, policy status, approval state, evidence
   completeness, and incident/change history.
2. Every deployment has runtime policy, guardrails, logs, drift status, and
   rollback pointer.
3. Security scan runs before registry publish and before enterprise promotion.
4. Audit export includes manifest, signatures, split proof, evals, scans,
   approvals, deployment receipts, and runtime receipts.
5. Enterprise can export evidence to PDF/JSON/CSV and SIEM.
6. MCP/tool artifacts show permission diffs before install.
7. BYOK/CMK, private storage, tenant isolation, and zero-retention modes are
   visible and testable.

Do not build:

- Full GRC replacement before artifact evidence is excellent.
- Security theater that signs unscanned or unreviewed artifacts.
- Compliance pages disconnected from product receipts.

#### Surface 7: `deployment-edge-federated`

What exists in the market:

- Inference deployment:
  Baseten, Replicate, BentoML, Ray Serve, KServe, Triton, Modal, RunPod,
  SageMaker, Vertex, Azure ML, Databricks Model Serving, Cloudflare Workers,
  Vercel Edge, Kubernetes, Docker Compose.
- Edge/device platforms:
  Core ML, MLX, LiteRT/TFLite, ExecuTorch, ONNX Runtime Mobile, OpenVINO,
  TensorRT-LLM, TensorRT, QNN/Hexagon, ROCm, WebGPU/WASM, Edge Impulse,
  SensiML, NetsPresso, Latent AI.
- Storage and registry:
  Cloudflare R2, AWS S3, Supabase Storage S3 compatibility, MinIO, GCS, Azure
  Blob, OCI registries, Hugging Face, GitHub Releases, MLflow, W&B Artifacts.
- Federated/privacy:
  Flower, TensorFlow Federated, PySyft/OpenMined, secure aggregation,
  differential privacy, local-only capture, customer-hosted bridge.
- Enterprise deployment models:
  hosted SaaS, customer cloud, hybrid control/data plane, VPC deployment,
  private registry, air-gapped appliance, offline verifier, offline license.

Kolm posture:

- Own deployment receipt and promotion workflow.
- Adapter/export to deployment platforms.
- Own storage abstraction and artifact addressing.
- Adapter to federated learning/privacy frameworks.
- Own cloud compute UX for users without GPUs.
- Export device-specific target packages with verification levels.

Finished-product requirements:

1. Compile jobs can run local, rented GPU, Kolm cloud, customer cloud, or
   enterprise VPC.
2. Storage backend is selectable:
   local filesystem, Cloudflare R2, AWS S3, Supabase S3, MinIO, customer bucket.
3. Deployment creates health check, shadow route, canary policy, rollback, logs,
   and receipt.
4. Edge export reports device memory, model size, p50/p95 latency, runtime,
   unsupported ops, and verification level.
5. Federated compile records participant policy, privacy budget where used,
   aggregation method, and data non-movement proof.
6. Air-gapped package includes installer, registry mirror, verifier, docs,
   license, examples, and no external network dependency.

Do not build:

- A cloud GPU platform from scratch before using Modal/RunPod/SageMaker-like
  adapters.
- Edge claims without device proof.
- Federated-learning marketing without concrete secure aggregation and audit
  story.

#### Cross-Surface Capability Universe

Model/provider families Kolm must account for:

- Closed frontier:
  OpenAI, Anthropic, Google Gemini, xAI, Mistral hosted, Cohere, AI21.
- Cloud marketplace:
  Bedrock, Azure AI Foundry/OpenAI, Vertex AI, SageMaker JumpStart, Databricks,
  Snowflake Cortex, Cloudflare Workers AI.
- Aggregated:
  OpenRouter, LiteLLM, Portkey, Requesty, Not Diamond, Helicone, Vercel AI
  Gateway.
- Open model families:
  Llama, Qwen, Mistral/Mixtral, Gemma, Phi, DeepSeek, Yi, Granite, Nemotron,
  Command R, Falcon, StarCoder, CodeLlama, Codestral, Devstral, embedding and
  reranker models.
- Local-serving:
  Ollama, LM Studio, llama.cpp/GGUF, vLLM, SGLang, TGI, MLX, ExLlamaV2,
  LocalAI, Jan, Docker Model Runner.

Task/modalities Kolm must account for:

- Chat, structured extraction, classification, routing, summarization,
  translation, code generation, code review, test generation, agent planning,
  tool calling, RAG, embeddings, reranking, OCR, vision QA, document extraction,
  audio transcription, TTS, image generation, video generation, computer use,
  browser use, time-series/sensor inference, tabular prediction.

Data sources Kolm must account for:

- API traces, chat logs, support tickets, Slack/Teams, email, CRM, EHR, legal
  docs, contracts, PDFs, CSVs, SQL, warehouses, object storage, vector stores,
  Git repos, issue trackers, browser sessions, call transcripts, telemetry,
  IoT/sensor streams, human labels, synthetic rows, eval failures, production
  incidents.

Transformation methods Kolm must account for:

- Prompt rewrite, prompt compression, cache, semantic cache, route, fallback,
  tool policy, RAG chunking/retrieval/reranking, rules engine, schema
  constrained output, SFT, LoRA/QLoRA, DPO/ORPO/GRPO/RLHF/RLAIF, distillation,
  model merge, pruning, quantization, ONNX export, Core ML export, GGUF export,
  workflow packaging, MCP tool packaging.

Compute targets Kolm must account for:

- User laptop CPU, Apple Silicon GPU/ANE, NVIDIA CUDA, AMD ROCm, Intel CPU/NPU,
  Qualcomm NPU/Hexagon, browser WebGPU/WASM, local Docker, customer Kubernetes,
  Modal, RunPod, Baseten, Replicate, SageMaker, Vertex, Azure ML, Databricks,
  Cloudflare Workers, Vercel Edge, on-prem GPU, air-gapped appliance.

Evidence types Kolm must account for:

- Manifest hash, model hash, dataset hash, train split hash, holdout hash,
  eval hash, scorer code hash, judge model/version, prompt hash, runtime hash,
  deployment hash, route decision receipt, redaction receipt, permission receipt,
  security scan, model card, dataset card, eval card, SBOM/ML-BOM, SLSA/in-toto
  provenance, signature, approval, incident, rollback.

Interfaces Kolm must account for:

- CLI, TUI, local web dashboard, hosted account dashboard, REST API, OpenAPI,
  SDKs, MCP server, VS Code extension, GitHub Action, Docker image, registry UI,
  verifier CLI, webhook events, SIEM export, docs/llms.txt.

#### What "Best In The World" Means In Practice

Kolm does not need to be the best trainer, best vector database, best gateway,
best GPU cloud, best labeling workforce, best GRC platform, and best edge IDE
at the same time. That is incoherent.

Kolm must be best at these narrower but more valuable jobs:

1. Best artifact evidence envelope for AI behavior.
2. Best trace-to-artifact promotion loop.
3. Best train/holdout/synthetic provenance guarantees.
4. Best offline verifier and artifact diff.
5. Best compiler planning across route/cache/RAG/train/distill/quantize.
6. Best interoperability with providers, local runtimes, storage, eval tools,
   deployment targets, and governance exports.
7. Best enterprise proof that a private AI system can be approved, deployed,
   monitored, rolled back, and audited.

Everything else should be integrated, imported, exported, mirrored, or deferred
with honesty.

### 5.22 Atomic Capability Ledger

This ledger is deliberately operational. Each category answers:

- what users will assume exists
- what competitors already train users to expect
- what Kolm must expose in CLI, TUI, account UI, API, and docs
- what proof makes the capability real
- what failure state must be explicit

#### Ledger 1: Provider Access And Routing

User expectation:

- "I can use my existing OpenAI, Anthropic, Gemini, Azure, Bedrock, Vertex,
  Mistral, Cohere, OpenRouter, LiteLLM, local Ollama, vLLM, or SGLang setup."

Required product objects:

- `ProviderConnection`
- `ProviderCapability`
- `ProviderPolicy`
- `RouteDecision`
- `FallbackChain`
- `ProviderConformanceRun`

Required fields:

- provider id
- auth mode:
  Kolm-managed key, BYOK, environment variable, customer vault, cloud IAM,
  local unauthenticated endpoint, mTLS
- endpoint URL
- region/data zone
- supported models
- supported modalities
- max context
- tool/function support
- JSON/schema support
- batch support
- prompt-cache support
- native cache semantics
- streaming support
- rate limits
- price schedule
- retention/data-use policy
- compliance notes
- test timestamp

CLI obligations:

- `kolm providers list`
- `kolm providers connect`
- `kolm providers test`
- `kolm providers inspect <provider>`
- `kolm route explain`
- `kolm route replay`

TUI/account obligations:

- Provider health table.
- Capability badges with "tested at" timestamp.
- Visible native feature differences.
- Policy editor for allowed providers by project/artifact.
- Failure detail when a provider is configured but unusable.

Proof gate:

- Each provider has a conformance fixture covering:
  auth, chat, streaming, structured output, tool call where supported, embedding
  where supported, batch where supported, retryable error, non-retryable error,
  rate-limit behavior, telemetry capture.

Failure state:

- `configured_not_tested`
- `tested_partial`
- `capability_mismatch`
- `provider_unavailable`
- `policy_blocked`
- `native_feature_not_supported`

Do not claim:

- "All models" unless the model appears in a tested capability registry.
- "OpenAI-compatible" as a synonym for feature-compatible.

#### Ledger 2: Capture, Privacy, And Data Boundary

User expectation:

- "I can capture production AI traffic without creating a privacy incident."

Required product objects:

- `CapturePolicy`
- `CaptureEvent`
- `RedactionReceipt`
- `RetentionPolicy`
- `DataBoundary`
- `ExportJob`
- `PrivacyReview`

Required capture modes:

- raw local
- raw cloud
- redacted local
- redacted cloud
- hash-only
- metadata-only
- zero-retention pass-through
- sampled capture
- error-only capture
- high-cost-only capture
- high-latency-only capture
- project/user/provider/model filter

Required redaction features:

- regex detectors
- ML/NER detectors
- structured PII classes:
  email, phone, SSN, MRN, DOB, address, name, account id, credit card, access
  token, API key, secret, patient id, financial account, legal matter id
- per-class precision/recall documentation where measured
- false-positive review
- vault/reversible-token option
- irreversible hash option
- redaction preview before enabling shared capture

CLI obligations:

- `kolm capture start`
- `kolm capture policy init`
- `kolm capture test-redaction`
- `kolm capture export`
- `kolm capture purge`
- `kolm capture doctor`

TUI/account obligations:

- Capture mode selector.
- Raw/redacted/hash-only indicator on every dataset row.
- Retention countdown.
- PII class histogram.
- "What leaves my machine?" explainer attached to settings, not marketing copy.

Proof gate:

- Capture event includes policy version and redaction receipt.
- Redaction test suite runs on seeded PII/PHI examples.
- Zero-retention mode demonstrably stores no raw payload.
- Export includes schema and checksum.

Failure state:

- `redaction_unavailable`
- `detector_missing`
- `policy_invalid`
- `retention_expired`
- `raw_payload_blocked`
- `export_contains_sensitive_fields`

Do not claim:

- HIPAA-safe or zero-retention unless raw payload storage is technically
  disabled, not just hidden.

#### Ledger 3: Opportunity Detection And Planning

User expectation:

- "Tell me what is worth compiling, why, and what it will save."

Required product objects:

- `Opportunity`
- `CompilePlan`
- `CandidatePlan`
- `ConstraintSet`
- `SavingsEstimate`
- `DoNotCompileReason`

Candidate paths:

- no-op keep provider
- route to cheaper model
- provider cache/prompt cache
- semantic cache
- prompt compression
- rules engine
- schema wrapper
- RAG
- reranker swap
- fine-tune
- distill
- quantize
- local runtime
- workflow wrapper
- MCP tool package
- hybrid:
  route + cache + RAG + small model fallback

Required planning constraints:

- max quality regression
- max latency
- max cost
- max model size
- max memory
- required locality
- allowed providers
- allowed compute
- data retention mode
- compliance tags
- modality
- streaming requirement
- tool-calling requirement
- structured-output requirement
- deployment target

CLI obligations:

- `kolm opportunities`
- `kolm plan`
- `kolm plan explain`
- `kolm plan compare`
- `kolm plan accept`
- `kolm plan reject`

TUI/account obligations:

- Opportunity ranking by savings, volume, confidence, risk, data readiness.
- Candidate comparison table.
- "Why not train?" panel.
- Expected cost/latency/quality envelope.
- Required data/eval gaps before compile can proceed.

Proof gate:

- Planner outputs at least two alternatives for non-trivial repeated workloads.
- Planner has explicit "do not compile" outputs.
- Savings estimate is traceable to usage data and provider pricing snapshot.
- Plan is reproducible from saved inputs.

Failure state:

- `insufficient_examples`
- `unstable_task`
- `dynamic_knowledge`
- `missing_eval`
- `privacy_policy_blocks_training`
- `target_runtime_too_small`
- `provider_feature_required`
- `no_candidate_beats_baseline`

Do not claim:

- "Compile any task" when the planner cannot reject bad tasks.

#### Ledger 4: Dataset, Labeling, And Split Integrity

User expectation:

- "My training and evaluation data are clean, representative, and not leaking."

Required product objects:

- `Dataset`
- `DatasetRow`
- `SplitAssignment`
- `EvalCase`
- `Label`
- `ReviewTask`
- `SyntheticRowReceipt`
- `DataQualityReport`
- `LeakageReport`

Required row metadata:

- source event id
- source provider/model
- source project/user where allowed
- timestamp
- redaction policy
- modality
- task type
- label source:
  human, imported, judge, synthetic, rule, SME, unknown
- split:
  train, holdout, eval, calibration, shadow, quarantine
- synthetic lineage
- dedupe hash
- semantic cluster id
- reviewer id where allowed
- approval state

Supported imports/exports:

- JSONL
- CSV
- Parquet
- Hugging Face datasets
- Argilla
- Label Studio
- Prodigy
- distilabel
- OpenAI fine-tune JSONL
- Anthropic batch-style JSONL where useful
- Together/Fireworks/Predibase formats
- Ragas/RAG eval schemas

CLI obligations:

- `kolm dataset import`
- `kolm dataset inspect`
- `kolm dataset split`
- `kolm dataset leak-check`
- `kolm labels queue`
- `kolm labels export`
- `kolm synthetic generate`
- `kolm synthetic quarantine`

TUI/account obligations:

- Row review UI.
- Split visualization.
- Leakage warnings.
- Synthetic provenance display.
- Reviewer conflict/adjudication queue.
- Quality histogram by labeler/source/task.

Proof gate:

- Holdout disjointness verified by row hash and semantic-near-duplicate check.
- Synthetic rows cannot enter holdout unless explicitly marked and allowed.
- Every eval case has provenance and scorer compatibility.
- Dataset export includes manifest hash.

Failure state:

- `split_leakage_detected`
- `semantic_duplicate_detected`
- `synthetic_holdout_blocked`
- `label_conflict`
- `insufficient_reviewer_agreement`
- `schema_invalid`

Do not claim:

- Honest K-score without split and provenance evidence.

#### Ledger 5: Evals, K-Score, And Regression Testing

User expectation:

- "I can prove whether the artifact is better, worse, safer, faster, or cheaper."

Required product objects:

- `EvalSuite`
- `EvalMetric`
- `EvalRun`
- `JudgeConfig`
- `CalibrationRun`
- `KScoreCard`
- `RegressionGate`
- `BenchmarkRun`

Metric families:

- deterministic exact match
- structured schema validation
- function/tool call correctness
- unit/integration test result
- classification precision/recall/F1
- extraction field-level accuracy
- retrieval recall/precision/MRR/nDCG
- RAG faithfulness/groundedness/context relevance
- pairwise preference
- LLM-as-judge rubric
- human preference
- safety/refusal
- jailbreak resistance
- PII leakage
- latency
- cost
- memory
- cold start
- throughput
- drift

K-score axes:

- task quality
- data integrity
- holdout honesty
- judge calibration
- robustness
- safety
- runtime fit
- cost/latency improvement
- governance completeness
- confidence interval

CLI obligations:

- `kolm eval run`
- `kolm eval compare`
- `kolm eval import`
- `kolm eval export`
- `kolm kscore explain`
- `kolm benchmark`
- `kolm regressions`

TUI/account obligations:

- Eval suite builder.
- Baseline versus candidate comparison.
- K-score decomposition, not only aggregate.
- Confidence and calibration display.
- Failed examples with reason.
- Regression gate editor.

Proof gate:

- Every K-score includes:
  eval dataset hash, scorer hash, judge model/version, calibration status,
  confidence interval or "not enough data," and failure examples.
- Eval can run against provider API, local runtime, artifact, RAG pipeline, and
  workflow artifact.

Failure state:

- `judge_uncalibrated`
- `eval_too_small`
- `metric_not_applicable`
- `baseline_missing`
- `candidate_failed`
- `regression_detected`
- `confidence_too_low`

Do not claim:

- "Best" or "production-ready" from a single opaque score.

#### Ledger 6: Training, Distillation, And Cloud Compute

User expectation:

- "I can train or distill even if I do not own a GPU, and I can choose where my
  data and compute run."

Required product objects:

- `TrainingJob`
- `TeacherRun`
- `StudentCandidate`
- `TrainerBackend`
- `ComputeTarget`
- `ComputeQuote`
- `TrainingReceipt`
- `AdapterArtifact`
- `ModelImport`

Training backends:

- OpenAI fine-tuning/distillation
- Azure OpenAI fine-tuning
- Bedrock customization/distillation/RFT
- Vertex tuning
- Mistral fine-tuning
- Cohere fine-tuning
- Together fine-tuning
- Fireworks fine-tuning/LoRA
- Predibase
- Lamini
- Arcee/DistillKit-compatible paths where available
- Hugging Face TRL/PEFT/Accelerate
- Axolotl
- Unsloth
- LlamaFactory
- torchtune
- NeMo
- custom Docker trainer

Compute targets:

- local CPU
- local GPU
- local Apple Silicon/MLX
- local Docker
- Kolm cloud GPU
- rented GPU:
  Modal, RunPod, Lambda-style provider, Baseten/Replicate where appropriate
- customer AWS/GCP/Azure
- customer Kubernetes
- SageMaker
- Vertex
- Azure ML
- Databricks/Mosaic
- air-gapped on-prem

CLI obligations:

- `kolm train quote`
- `kolm train start`
- `kolm train logs`
- `kolm train cancel`
- `kolm train resume`
- `kolm distill start`
- `kolm compute list`
- `kolm compute test`
- `kolm model import`

TUI/account obligations:

- Compute picker with cost, privacy, speed, and capability tradeoffs.
- Job progress with logs.
- Failure diagnostics.
- Backend comparison.
- Data movement warning.
- Cost ceiling and kill switch.

Proof gate:

- Training receipt includes:
  backend, base model hash/id, training data hash, validation data hash,
  method, hyperparameters, random seed where available, container/image hash,
  compute target, cost, logs, output hash, eval result.
- Cloud compute job proves where data moved.
- Imported model has hash, license, source, and scan status.

Failure state:

- `compute_unavailable`
- `quota_exceeded`
- `gpu_memory_insufficient`
- `backend_not_supported_for_model`
- `training_failed`
- `data_policy_blocks_compute`
- `cost_limit_exceeded`

Do not claim:

- "Train anything" when model license, backend support, memory, data policy, or
  provider terms block it.

#### Ledger 7: Compilation, Packaging, And Verification

User expectation:

- "The output is a real artifact I can inspect, run, verify, diff, and roll
  back."

Required product objects:

- `.kolm` artifact
- `Manifest`
- `Recipe`
- `RuntimeTarget`
- `ReceiptSet`
- `Signature`
- `VerifierReport`
- `ArtifactDiff`
- `ConformanceRun`

Artifact members:

- `manifest.json`
- `recipe.json`
- `evalcard.json`
- `datasetcard.json`
- `modelcard.json` where model payload exists
- `securitycard.json`
- `runtime-targets/*.json`
- `receipts/*.json`
- `splits/*.jsonl` or hashed references when payload cannot ship
- model or adapter payload where allowed
- workflow/MCP/tool spec where relevant
- signature

Target outputs:

- GGUF
- ONNX
- safetensors
- Core ML
- MLX
- TensorRT/TensorRT-LLM engine
- OpenVINO IR
- ExecuTorch
- LiteRT/TFLite
- WASM/WebGPU bundle
- Docker/OCI
- MCP server/tool package
- RAG/workflow package

CLI obligations:

- `kolm compile`
- `kolm verify`
- `kolm inspect`
- `kolm diff`
- `kolm run`
- `kolm push`
- `kolm pull`
- `kolm export`
- `kolm conformance`

TUI/account obligations:

- Artifact inspector.
- Manifest viewer.
- Receipt viewer.
- Diff viewer.
- Verification status.
- Target matrix.
- Download/publish controls.

Proof gate:

- Offline verifier validates signature, manifest hashes, payload hashes,
  receipt integrity, schema version, and declared target status.
- Target-specific smoke test exists for any "runtime verified" badge.
- Diff shows artifact changes before promotion.

Failure state:

- `signature_invalid`
- `manifest_hash_mismatch`
- `payload_missing`
- `target_converted_not_tested`
- `runtime_incompatible`
- `license_blocked`
- `schema_version_unsupported`

Do not claim:

- "Portable" unless the verifier and target runner prove portability.

#### Ledger 8: Runtime, Serving, Shadow, And Promotion

User expectation:

- "I can deploy safely and compare against production before switching traffic."

Required product objects:

- `DeploymentPlan`
- `Deployment`
- `ShadowRun`
- `CanaryPolicy`
- `RollbackPlan`
- `RuntimeHealth`
- `PromotionDecision`
- `RuntimeReceipt`

Deployment targets:

- local process
- Docker Compose
- Kubernetes
- KServe
- Ray Serve
- BentoML
- Triton
- vLLM/SGLang server
- Modal
- RunPod
- Baseten
- Replicate
- SageMaker endpoint
- Vertex endpoint
- Azure ML endpoint
- Databricks Model Serving
- Cloudflare Workers
- Vercel Edge
- air-gapped runtime

CLI obligations:

- `kolm deploy plan`
- `kolm deploy`
- `kolm shadow start`
- `kolm shadow report`
- `kolm promote`
- `kolm rollback`
- `kolm health`
- `kolm logs`

TUI/account obligations:

- Deployment target picker.
- Shadow comparison table.
- Canary controls.
- Rollback button.
- Health and drift charts.
- Runtime receipts.

Proof gate:

- Promotion requires:
  verified artifact, deployment health check, baseline comparison, shadow result
  or explicit override, rollback plan, approver, and audit record.

Failure state:

- `deployment_failed`
- `health_check_failed`
- `shadow_regression`
- `rollback_missing`
- `policy_approval_required`
- `runtime_drift_detected`

Do not claim:

- "Production-ready" if no rollback and shadow evidence exists.

#### Ledger 9: RAG, Connectors, And Enterprise Knowledge

User expectation:

- "It can work with my data systems without breaking permissions."

Required product objects:

- `Connector`
- `SourceSnapshot`
- `IndexSnapshot`
- `ChunkPolicy`
- `EmbeddingPolicy`
- `RetrievalPolicy`
- `PermissionReceipt`
- `RagArtifact`

Connector categories:

- object storage
- SQL warehouses
- Postgres
- Snowflake
- Databricks
- BigQuery
- Salesforce
- Zendesk
- Intercom
- Jira
- GitHub/GitLab
- Slack/Teams
- Google Drive
- SharePoint
- Confluence
- Notion
- EHR/healthcare systems through enterprise integration
- legal DMS
- vector stores:
  Pinecone, Weaviate, Milvus, Qdrant, pgvector, Elasticsearch/OpenSearch,
  Vespa, Chroma, LanceDB

CLI obligations:

- `kolm connectors list`
- `kolm connectors test`
- `kolm rag ingest`
- `kolm rag eval`
- `kolm rag package`
- `kolm permissions test`

TUI/account obligations:

- Connector setup.
- Index state.
- Chunk preview.
- Permission test.
- Retrieval eval.
- Source freshness.

Proof gate:

- RAG artifact includes:
  source snapshot, chunk policy, embedder version, vector store config,
  retrieval policy, reranker, eval results, permission proof, source freshness.

Failure state:

- `connector_auth_failed`
- `permission_model_unknown`
- `source_stale`
- `index_incomplete`
- `retrieval_eval_failed`
- `permission_leak_detected`

Do not claim:

- Enterprise RAG-ready if source ACLs are not represented and tested.

#### Ledger 10: Agents, Workflows, MCP, And Tool Safety

User expectation:

- "It can package AI workflows and agent tools without turning into a security
  problem."

Required product objects:

- `WorkflowArtifact`
- `ToolManifest`
- `McpServerSpec`
- `ToolPermission`
- `ToolCallReceipt`
- `WorkflowGraph`
- `HumanApprovalGate`
- `AgentTrace`

Frameworks/imports:

- LangGraph
- LlamaIndex workflows
- CrewAI
- AutoGen
- Semantic Kernel
- Pydantic AI
- Dify
- Flowise
- Langflow
- n8n
- MCP servers
- OpenAI Agents SDK traces
- Claude/Cursor/Continue/Cline MCP setups where importable

CLI obligations:

- `kolm workflow import`
- `kolm workflow inspect`
- `kolm workflow eval`
- `kolm workflow package`
- `kolm mcp compile`
- `kolm mcp scan`
- `kolm mcp install`

TUI/account obligations:

- Workflow graph view.
- Tool permission diff.
- Human approval gate editor.
- Agent trace viewer.
- MCP install warning.
- Security scan result.

Proof gate:

- Tool permissions, external domains, command execution, file access, secrets
  access, and network access are visible before install/promotion.
- Prompt-injection tests run against tool descriptions and retrieved context.

Failure state:

- `tool_permission_excessive`
- `mcp_scan_failed`
- `prompt_injection_risk`
- `human_approval_missing`
- `workflow_cycle_unbounded`
- `secret_exposure_risk`

Do not claim:

- Safe agents if tool permissions and prompt-injection paths are not modeled.

#### Ledger 11: Security, Supply Chain, And Trust

User expectation:

- "Security can approve this artifact without trusting the sales deck."

Required product objects:

- `SecurityScan`
- `LicenseScan`
- `DependencyScan`
- `ModelScan`
- `PromptInjectionScan`
- `SecretsScan`
- `PolicyViolation`
- `TrustEvidence`

Scanner categories:

- model serialization:
  Pickle, PyTorch, Keras/H5, safetensors metadata, ONNX metadata, GGUF metadata
- dependencies:
  npm, PyPI, cargo, container, OS packages
- prompt/tool:
  MCP tool descriptions, system prompts, RAG docs, browser content, workflow
  node prompts
- license:
  base model license, dataset license, code license, artifact license
- secrets:
  environment variables, config files, examples, prompt logs

CLI obligations:

- `kolm scan artifact`
- `kolm scan model`
- `kolm scan mcp`
- `kolm scan dataset`
- `kolm trust export`
- `kolm policy check`

TUI/account obligations:

- Security evidence tab.
- Policy exceptions.
- Approval workflow.
- License compatibility warning.
- Dependency graph.
- SIEM export.

Proof gate:

- Publish or promotion policy can block on scan results.
- Security card is included in the artifact.
- Exceptions are explicit, scoped, time-bounded, and auditable.

Failure state:

- `unsafe_serialization`
- `license_unknown`
- `license_incompatible`
- `secret_detected`
- `dependency_vulnerable`
- `scan_not_run`
- `policy_exception_expired`

Do not claim:

- "Secure artifact" when only authenticity has been checked.

#### Ledger 12: Governance, Compliance, And Enterprise Controls

User expectation:

- "I can pass an internal risk review and external audit."

Required product objects:

- `AISystemInventory`
- `RiskTier`
- `ControlMapping`
- `ApprovalWorkflow`
- `EvidenceBundle`
- `AuditExport`
- `IncidentRecord`
- `ChangeRecord`

Framework mappings:

- NIST AI RMF
- ISO/IEC 42001
- EU AI Act
- SOC 2
- ISO 27001
- HIPAA
- GDPR
- FedRAMP where relevant
- internal model risk management
- OWASP LLM Top 10
- OWASP MCP Top 10

CLI obligations:

- `kolm inventory`
- `kolm evidence export`
- `kolm controls map`
- `kolm approvals`
- `kolm audit export`

TUI/account obligations:

- AI system inventory.
- Risk tier editor.
- Evidence completeness.
- Approval queue.
- Control mapping.
- Audit export.
- Incident/change history.

Proof gate:

- Artifact, deployment, and runtime evidence map to named controls.
- Auditor can verify evidence without reading source code.

Failure state:

- `owner_missing`
- `risk_unclassified`
- `approval_missing`
- `control_unmapped`
- `evidence_incomplete`
- `audit_export_failed`

Do not claim:

- Compliance readiness if there is no structured evidence export.

#### Ledger 13: Edge, Local, Browser, And Device Deployment

User expectation:

- "If you say local, browser, mobile, or edge, you prove the exact target."

Required product objects:

- `DeviceProfile`
- `TargetBuild`
- `RuntimeProbe`
- `DeviceReceipt`
- `RolloutPolicy`
- `OtaUpdate`

Targets:

- Apple Silicon CPU/GPU/ANE/Core ML/MLX
- iOS Core ML
- Android LiteRT/ExecuTorch/QNN
- NVIDIA CUDA
- NVIDIA Jetson
- Intel CPU/NPU/OpenVINO
- AMD ROCm/DirectML where practical
- Qualcomm Hexagon/QNN
- browser WASM/WebGPU
- embedded Linux
- C/C++ SDK

CLI obligations:

- `kolm devices list`
- `kolm devices profile`
- `kolm export --target`
- `kolm runtime probe`
- `kolm edge verify`
- `kolm ota package`

TUI/account obligations:

- Device matrix.
- Memory/latency estimate.
- Unsupported op display.
- Verification level badge.
- Rollout status.
- Rollback status.

Proof gate:

- Each target states:
  converted, simulated, locally tested, cloud-device tested, or field verified.
- Real target measurements include p50/p95, memory, binary size, cold start,
  and accuracy delta.

Failure state:

- `target_not_supported`
- `converted_not_tested`
- `unsupported_ops`
- `memory_budget_exceeded`
- `latency_budget_exceeded`
- `accuracy_regression`

Do not claim:

- "Runs on device" if only a conversion file was produced.

#### Ledger 14: Registry, Marketplace, And Distribution

User expectation:

- "I can find, trust, pull, diff, publish, and mirror artifacts."

Required product objects:

- `RegistryEntry`
- `Publisher`
- `ArtifactVersion`
- `ArtifactDependency`
- `RegistryPolicy`
- `Mirror`
- `DownloadReceipt`

Distribution channels:

- Kolm registry
- private registry
- air-gapped registry mirror
- OCI registry
- Hugging Face
- GitHub Releases
- S3-compatible bucket
- MLflow
- W&B Artifacts
- npm/PyPI/crates/Homebrew for tools

CLI obligations:

- `kolm registry login`
- `kolm push`
- `kolm pull`
- `kolm search`
- `kolm publish`
- `kolm mirror`
- `kolm registry verify`

TUI/account obligations:

- Search/filter.
- Verified publisher.
- Version history.
- Diff view.
- Dependency graph.
- License.
- Security status.
- Runtime support.
- Evidence completeness.

Proof gate:

- Pulling from any mirror verifies to the same content hash.
- Registry listing displays scan/eval/target status without hiding missing
  evidence.

Failure state:

- `publisher_unverified`
- `artifact_tampered`
- `mirror_stale`
- `dependency_unverified`
- `license_missing`
- `evidence_missing`

Do not claim:

- Marketplace trust without verifier and publisher controls.

#### Ledger 15: Storage, Sync, And Data Plane Infrastructure

User expectation:

- "I can use my storage boundary and keep artifacts/data where I need them."

Required product objects:

- `StorageBackend`
- `ObjectRef`
- `ArtifactStore`
- `DatasetStore`
- `ReceiptStore`
- `SyncJob`
- `RetentionJob`

Backends:

- local filesystem
- SQLite for local metadata
- Postgres/Supabase for hosted metadata
- Cloudflare R2
- AWS S3
- Supabase S3 compatibility
- MinIO
- GCS
- Azure Blob
- customer S3-compatible bucket
- air-gapped object store

CLI obligations:

- `kolm storage configure`
- `kolm storage test`
- `kolm storage migrate`
- `kolm sync`
- `kolm retention run`

TUI/account obligations:

- Storage location visibility.
- Boundary policy.
- Sync status.
- Retention status.
- Object integrity status.

Proof gate:

- Every object has content hash, backend, encryption status, retention policy,
  and accessibility check.
- Storage migration verifies object counts and hashes.

Failure state:

- `storage_unavailable`
- `hash_mismatch`
- `encryption_unconfigured`
- `retention_policy_missing`
- `sync_partial`
- `object_missing`

Do not claim:

- Customer-managed data if control-plane code can silently copy payloads to
  Kolm-managed storage.

### 5.23 Atomic End-To-End Scenarios To Prove Finished Product

These are the non-demo workloads that should be used to validate the whole
product. Passing unit tests is not enough; each scenario should produce
artifacts, receipts, screenshots, CLI logs, API responses, and rollback proof.

#### Scenario A: Support Triage Cost Reduction

Inputs:

- 10,000 captured support-ticket classification calls.
- OpenAI and Anthropic baseline calls.
- Redaction policy enabled.
- Human-labeled holdout set.

Expected path:

1. Capture traffic.
2. Detect high-volume repeated classification.
3. Plan alternatives:
   route cheaper model, fine-tune small model, rules baseline, local artifact.
4. Build dataset with leakage check.
5. Run evals.
6. Compile artifact.
7. Verify offline.
8. Shadow against live provider.
9. Promote to 10 percent canary.
10. Roll back if F1 drops.

Required proof:

- Cost reduction.
- F1/precision/recall.
- Holdout disjointness.
- Redaction receipt.
- Route/candidate comparison.
- Deployment and rollback receipt.

#### Scenario B: Healthcare PHI Redaction And SOAP Note Extraction

Inputs:

- Synthetic and de-identified clinical notes.
- PHI classes:
  MRN, DOB, patient name, address, phone, insurance id, clinician name.
- Local-only or customer-cloud policy.

Expected path:

1. Capture with PHI redaction.
2. Build extraction evals.
3. Block raw cloud training unless policy allows.
4. Compile local artifact or customer-cloud target.
5. Export HIPAA-oriented evidence bundle.

Required proof:

- Per-class PHI redaction metrics.
- Zero-retention or local-only data boundary.
- Extraction schema accuracy.
- Artifact verification.
- Audit export.

#### Scenario C: Legal Contract Clause Extraction

Inputs:

- Contracts with privilege-sensitive clauses.
- Complex schema:
  parties, governing law, renewal, termination, indemnity, limitation,
  assignment, notice, data-processing terms.

Expected path:

1. Ingest documents.
2. Run schema evals and human review.
3. Compare RAG, frontier model, local model, fine-tuned model.
4. Compile best artifact.
5. Export evidence for counsel.

Required proof:

- Field-level extraction accuracy.
- Source document references.
- Privilege boundary.
- Human override trail.
- Artifact diff.

#### Scenario D: Enterprise RAG With Permissions

Inputs:

- Confluence, Slack, GitHub, Google Drive/SharePoint, vector DB.
- Users with different ACLs.

Expected path:

1. Connect sources.
2. Index with chunk policy.
3. Package RAG artifact.
4. Run permission tests.
5. Evaluate groundedness and retrieval recall.
6. Shadow deploy assistant.

Required proof:

- Permission receipt.
- Source snapshot.
- Chunk policy.
- Retrieval metrics.
- Denied-source evidence.

#### Scenario E: Agent Tool Package For MCP

Inputs:

- Workflow that calls GitHub, Slack, database, and internal API.
- MCP server export.

Expected path:

1. Import workflow.
2. Inspect tool permissions.
3. Run prompt-injection scan.
4. Add human approval for dangerous tools.
5. Compile as signed MCP package.
6. Verify and install in compatible client.

Required proof:

- Tool permission diff.
- MCP scan.
- Human approval gate.
- Tool call receipts.
- Install receipt.

#### Scenario F: Local Edge Artifact On Laptop And Browser

Inputs:

- Repeated extraction/classification task.
- Mac/Windows/Linux local runtime.
- Browser WebGPU/WASM target.

Expected path:

1. Compile to local GGUF/ONNX or rules/RAG hybrid.
2. Export browser bundle where feasible.
3. Verify offline.
4. Run benchmark on target machine.

Required proof:

- p50/p95 latency.
- memory footprint.
- bundle size.
- accuracy delta.
- target verification level.

#### Scenario G: No-GPU User Training In Cloud

Inputs:

- User has no local GPU.
- Dataset passes privacy policy for hosted compute.
- Compute budget cap.

Expected path:

1. Quote local impossible or slow path.
2. Quote cloud/rented GPU path.
3. Start async training.
4. Stream logs.
5. Enforce cost cap.
6. Import output artifact.
7. Verify/evaluate.

Required proof:

- Compute quote.
- Data movement receipt.
- Cost cap.
- Training receipt.
- Output artifact verification.

#### Scenario H: Air-Gapped Enterprise Install

Inputs:

- No internet access after install.
- Private registry mirror.
- Local verifier.
- Local/cluster compute.

Expected path:

1. Install offline package.
2. Configure local storage and identity.
3. Import provider/model artifacts from approved media.
4. Compile and verify without network.
5. Export audit bundle.

Required proof:

- No external network dependency.
- Offline verifier.
- Private registry.
- Local evidence export.
- License state.

#### Scenario I: Multimodal Document Pipeline

Inputs:

- PDFs, scans, images, audio notes.
- OCR, transcription, extraction, summarization.

Expected path:

1. Capture media.
2. Produce sidecars.
3. Redact sensitive text.
4. Evaluate OCR/transcription/extraction separately.
5. Compile workflow artifact.

Required proof:

- Media sidecar hashes.
- OCR/transcription accuracy.
- Extraction schema score.
- Redaction score.
- Workflow receipt.

#### Scenario J: Researcher Benchmark And Reproducibility

Inputs:

- Public dataset.
- Custom eval-as-code.
- Multiple candidate models/runtimes.

Expected path:

1. Import dataset.
2. Lock environment.
3. Run candidates.
4. Export benchmark report.
5. Package best artifact.
6. Publish reproducibility bundle.

Required proof:

- Seed/config/container hashes.
- Dataset hash.
- Eval code hash.
- Runtime versions.
- Reproduction command.

### 5.24 What To Build Deeply Versus What To Integrate

The product becomes incoherent if Kolm tries to own every market. The correct
depth is to own the compounding evidence objects and integrate the rest.

Own deeply:

1. `.kolm` spec and verifier.
2. Artifact manifest/schema/signature/receipt model.
3. Capture-to-opportunity-to-promotion loop.
4. Dataset split integrity and provenance.
5. K-score evidence decomposition.
6. Compile planner that chooses between route/cache/RAG/train/distill/quantize.
7. Artifact diff.
8. Shadow deployment comparison.
9. Promotion and rollback receipts.
10. Evidence bundle for governance/security.

Integrate deeply:

1. OpenAI, Anthropic, Gemini, Bedrock, Azure, Vertex, Mistral, Cohere.
2. OpenRouter, LiteLLM, Portkey, Cloudflare AI Gateway, Vercel AI Gateway.
3. vLLM, SGLang, Ollama, llama.cpp, TGI, LM Studio.
4. TRL/PEFT, Axolotl, Unsloth, LlamaFactory, torchtune, NeMo.
5. Predibase, Together, Fireworks, OpenPipe, Lamini, Arcee where APIs allow.
6. Langfuse, LangSmith, Braintrust, Phoenix/OpenInference, W&B Weave.
7. DeepEval, Promptfoo, Ragas, Opik, Parea, HoneyHive, Giskard.
8. Label Studio, Argilla, Prodigy, Scale/Labelbox export formats.
9. KServe, Ray Serve, BentoML, Triton, Modal, RunPod, Baseten, Replicate,
   SageMaker, Vertex, Azure ML, Databricks.
10. Pinecone, Weaviate, Milvus, Qdrant, pgvector, Elasticsearch/OpenSearch.
11. Lakera, garak, Giskard, ModelScan, HiddenLayer, Presidio.
12. WorkOS/Auth0/Okta and Stripe.
13. Cloudflare R2, AWS S3, Supabase S3, MinIO, GCS, Azure Blob.

Mirror/export:

1. OCI artifacts.
2. Hugging Face repos.
3. GitHub Releases.
4. MLflow model registry.
5. W&B Artifacts.
6. GRC/SIEM exports.
7. OpenTelemetry/OpenInference traces.
8. JSONL/Parquet/CSV datasets.
9. OpenAPI/SDK docs.
10. MCP server/tool packages.

Defer or avoid:

1. Building a general vector database.
2. Building a labeling workforce marketplace.
3. Building a GPU cloud from scratch.
4. Building a full identity provider.
5. Building a full GRC platform before evidence objects are excellent.
6. Building a broad no-code agent builder.
7. Building a kernel compiler from scratch.
8. Building bespoke edge firmware tooling for every board.
9. Building a social model hub before verifier trust is strong.
10. Building "any model" support without conformance tests.

### 5.25 Product UI Depth Requirements

This section is about making the product feel serious in every medium.

#### CLI

The CLI should be the highest-trust surface.

Required qualities:

- predictable flags
- machine-readable `--json`
- human-readable default
- explicit exit codes
- progress that does not hide failures
- resumable jobs
- `doctor` for every external dependency
- config profile support
- local/offline mode
- provider/compute/storage tests
- no hidden SaaS dependency for verify/run

Required command groups:

- `auth`
- `providers`
- `capture`
- `datasets`
- `labels`
- `eval`
- `plan`
- `compile`
- `train`
- `distill`
- `models`
- `artifacts`
- `verify`
- `run`
- `deploy`
- `shadow`
- `promote`
- `rollback`
- `registry`
- `mcp`
- `workflow`
- `rag`
- `scan`
- `evidence`
- `storage`
- `compute`
- `doctor`

#### TUI

The TUI should be the local operator cockpit.

Required views:

- provider health
- capture stream
- privacy/redaction mode
- opportunities
- dataset/splits
- label queue
- eval runs
- compile plan
- training jobs
- artifacts
- verifier
- deployments
- shadow comparisons
- registry
- security scans
- governance evidence
- logs/doctor

Required interactions:

- keyboard-first
- command palette
- inspect row/artifact/eval/deployment
- approve/reject
- pause/resume job
- export logs/evidence
- open docs for current failure

#### Account Post-Auth

The account UI should not be one generic dashboard.

Required areas:

- Overview:
  current opportunities, active jobs, failing gates, cost savings.
- Capture:
  provider connections, privacy mode, live events, filters, redaction.
- Data:
  datasets, labels, splits, synthetic rows, leakage reports.
- Evals:
  suites, runs, comparisons, K-score explanation.
- Compile:
  plans, candidates, training/distillation jobs, compute picker.
- Artifacts:
  registry, verifier, diff, runtime targets, downloads.
- Deploy:
  environments, shadow runs, canaries, rollback, health.
- Governance:
  inventory, risk tier, approvals, audit exports, security scans.
- Admin:
  org, users, SSO/SCIM, API keys, storage, billing, usage, policies.

Required UX rules:

- Every "ready" status links to evidence.
- Every blocked action says what exact gate is missing.
- Every enterprise-only action explains why it needs sales/security review.
- Every plan/cost decision shows source assumptions.
- Every external integration has a test button and last-tested timestamp.

#### Public Site And Docs

Required narrative:

- Above fold:
  Kolm compiles repeated AI behavior into signed, verifiable artifacts.
- Second section:
  one concrete core loop with proof.
- Third section:
  compatibility depth.
- Fourth section:
  enterprise trust and deployment modes.
- Fifth section:
  docs/CLI path.

Required docs structure:

- Quickstart:
  capture OpenAI and Anthropic traffic.
- Quickstart:
  compile from traces.
- Quickstart:
  verify and run locally.
- Guide:
  choose route/cache/RAG/train/distill/quantize.
- Guide:
  cloud compute without local GPU.
- Guide:
  enterprise storage and zero retention.
- Guide:
  RAG with permissions.
- Guide:
  MCP/workflow artifact safety.
- Reference:
  `.kolm` spec.
- Reference:
  verifier.
- Reference:
  provider capability registry.
- Reference:
  API/OpenAPI.
- Reference:
  CLI.
- Reference:
  SDKs.

### 5.26 Anti-Slop Rules For Claims, Surfaces, And Copy

These rules should govern every website/docs/account/CLI sentence.

1. If a capability is not wired, say "planned" or hide it.
2. If a capability is wired but not runtime-tested, say "exportable" not
   "supported."
3. If a route returns 501 by design, surface why and what unlocks it.
4. If a page mentions enterprise, it must include security/control evidence, not
   vague trust copy.
5. If a page mentions local, it must name actual local targets.
6. If a page mentions cloud, it must name compute/data boundary choices.
7. If a page mentions "any model," it must link to capability registry.
8. If a page mentions "faster/cheaper," it must link to benchmark methodology.
9. If a page mentions K-score, it must show decomposition.
10. If a page mentions compliance, it must show evidence exports and controls.
11. If a page mentions marketplace, it must show verification and publisher
    trust.
12. If a page mentions agents, it must show tool permissions and scans.
13. If a page mentions RAG, it must show source permissions and retrieval eval.
14. If a page mentions fine-tuning, it must explain when not to fine-tune.
15. If a page mentions edge, it must show verification level.

### 5.27 Exhaustive Competitor Category Checklist

Use this as a recurring audit checklist. Kolm does not need one-to-one feature
parity with every vendor, but every category must have a stance.

Model providers:

- OpenAI, Anthropic, Google/Gemini, Azure OpenAI, Bedrock, Vertex, Mistral,
  Cohere, xAI, AI21, Perplexity, DeepSeek, Groq, Cerebras.

Provider aggregators/gateways:

- OpenRouter, LiteLLM, Portkey, Helicone, Requesty, Not Diamond, Cloudflare AI
  Gateway, Vercel AI Gateway, Martian-style routers.

Fine-tuning/distillation platforms:

- OpenAI, Bedrock, Azure, Vertex, Snowflake Cortex, Databricks MosaicML,
  Predibase, Together, Fireworks, Lamini, Arcee, OpenPipe, Cohere, Mistral.

Open training stacks:

- Transformers, TRL, PEFT, Accelerate, DeepSpeed, FSDP, Megatron-LM, NeMo,
  torchtune, Axolotl, Unsloth, LlamaFactory, bitsandbytes, torchao, MLX.

Serving/runtimes:

- vLLM, SGLang, TGI, llama.cpp, Ollama, LM Studio, ExLlamaV2, LocalAI, Triton,
  TensorRT-LLM, OpenVINO, ONNX Runtime, Core ML, ExecuTorch, LiteRT, MLX,
  WASM/WebGPU.

Deployment platforms:

- Baseten, Replicate, BentoML, Ray Serve, KServe, Triton, Modal, RunPod,
  SageMaker, Vertex, Azure ML, Databricks Model Serving, Cloudflare Workers,
  Vercel Edge, Kubernetes, Docker.

GPU orchestration:

- Kubernetes, Kueue, Ray, Run:ai, Slurm, Volcano, Kubeflow, NVIDIA GPU Operator,
  DCGM, enterprise cluster schedulers.

Data/labeling:

- Kiln, Argilla, distilabel, Label Studio, Prodigy, Snorkel, Labelbox, Scale,
  Surge AI, Humanloop, Hugging Face datasets.

Evals/observability:

- Braintrust, LangSmith, Langfuse, DeepEval, Promptfoo, Ragas, Phoenix,
  OpenInference, W&B Weave, Opik, Parea, HoneyHive, Patronus, Arthur, Fiddler,
  Datadog, New Relic, Honeycomb, OpenTelemetry GenAI.

RAG/vector/document infrastructure:

- Pinecone, Weaviate, Milvus, Qdrant, pgvector, Elasticsearch, OpenSearch,
  Vespa, Chroma, LanceDB, LlamaIndex, Haystack, Unstructured, Vectara, Coveo.

Agent/workflow:

- LangGraph, LangChain, LlamaIndex, CrewAI, AutoGen, Semantic Kernel, Pydantic
  AI, OpenAI Agents SDK, Dify, Flowise, Langflow, n8n, Dust, Zapier, Make.

MCP/IDE/coding-agent ecosystem:

- Claude Code, OpenAI Codex, Cursor, Windsurf, Cline, Continue, GitHub Copilot,
  Gemini CLI, Roo Code, Aider, OpenCode, MCP servers, code graph tools.

Security:

- Lakera, Giskard, garak, Protect AI, HiddenLayer, Zenity, Prompt Security,
  Aim Security/AIMon, Enkrypt, NeMo Guardrails, Presidio, OWASP.

Governance:

- IBM watsonx.governance, Credo AI, ModelOp, Holistic AI, Monitaur, DataRobot,
  Dataiku, Palantir AIP governance patterns, enterprise GRC tools.

Registries/artifact systems:

- Hugging Face Hub, MLflow, W&B Artifacts, Docker/OCI, GitHub Releases, DVC,
  lakeFS, ModelDB, BentoCloud registries, private S3 registries.

Storage/data platforms:

- AWS S3, Cloudflare R2, Supabase Storage S3 compatibility, MinIO, GCS, Azure
  Blob, Snowflake, Databricks, BigQuery, Redshift, Postgres, DuckDB, ClickHouse.

Enterprise search/knowledge:

- Glean, Moveworks, Coveo, Elastic, Microsoft Copilot/Graph, Google Agentspace,
  Palantir AIP, C3 AI, H2O h2oGPTe.

Edge/TinyML:

- Edge Impulse, SensiML, NetsPresso, Latent AI, Apple Core ML, Google LiteRT,
  ExecuTorch, ONNX Runtime Mobile, Qualcomm QNN, OpenVINO, NVIDIA Jetson.

### 5.28 Final Definition Of "100 Percent" For This Strategy

100 percent does not mean Kolm has rebuilt the whole AI ecosystem. It means:

1. Every capability category has an explicit stance:
   own, adapter, import, export, mirror, defer.
2. Every public claim maps to a working product surface or is removed.
3. Every product surface has:
   API, CLI, UI, docs, tests, screenshots where applicable, and production
   smoke.
4. Every external integration has:
   config, health check, conformance test, docs, failure state.
5. Every AI artifact has:
   manifest, receipts, evals, security scan, verifier, diff, target status.
6. Every training/distillation path has:
   data boundary, compute quote, job logs, output verification, eval comparison.
7. Every deployment path has:
   health check, shadow/canary, rollback, runtime receipts.
8. Every enterprise path has:
   SSO/SCIM/RBAC, audit logs, storage boundary, evidence export, policy controls.
9. Every local/edge claim has:
   runtime target, device profile, measured or clearly simulated proof.
10. Every UX medium has:
    next action, failure explanation, evidence link, and no dead-end demo state.

If a category lacks those properties, the honest status is not "done." It is
`wired`, `exportable`, `tested`, `runtime_verified`, or `production_verified`.

### 5.29 Canonical Product State Machines

This section defines the product as state machines. State machines prevent
slop because every UI badge, CLI status, API response, and sales claim must map
to a state and transition.

#### Provider Connection State Machine

States:

1. `not_configured`
2. `configured_unverified`
3. `auth_verified`
4. `capability_probe_running`
5. `capability_verified`
6. `partially_verified`
7. `degraded`
8. `policy_blocked`
9. `revoked`
10. `retired`

Transitions:

- `connect`:
  `not_configured -> configured_unverified`
- `test_auth_ok`:
  `configured_unverified -> auth_verified`
- `test_auth_fail`:
  `configured_unverified -> not_configured` or `degraded`
- `probe_start`:
  `auth_verified -> capability_probe_running`
- `probe_full_pass`:
  `capability_probe_running -> capability_verified`
- `probe_partial_pass`:
  `capability_probe_running -> partially_verified`
- `probe_fail`:
  `capability_probe_running -> degraded`
- `policy_disable`:
  any active state -> `policy_blocked`
- `key_revoked`:
  any active state -> `revoked`
- `provider_deprecated`:
  any active state -> `retired`

Invariants:

- A provider cannot be used for compile planning unless auth is verified.
- A provider cannot receive a capability badge unless that capability probe
  passed within the configured freshness window.
- A provider cannot be selected by automatic routing if it is `policy_blocked`,
  `revoked`, or `retired`.
- Native capabilities are not inferred from OpenAI compatibility.

UI implication:

- Provider cards need two badges:
  auth status and capability freshness.
- A model row must show whether tool calls, JSON/schema, vision, audio, batch,
  cache, fine-tune, and streaming were actually tested.

#### Capture Event State Machine

States:

1. `received`
2. `policy_evaluating`
3. `redacting`
4. `stored_raw`
5. `stored_redacted`
6. `stored_metadata_only`
7. `hash_only`
8. `zero_retention_forwarded`
9. `quarantined`
10. `purged`
11. `exported`

Transitions:

- `ingress`:
  request enters `received`
- `policy_apply`:
  `received -> policy_evaluating`
- `needs_redaction`:
  `policy_evaluating -> redacting`
- `raw_allowed`:
  `policy_evaluating -> stored_raw`
- `redaction_success`:
  `redacting -> stored_redacted`
- `metadata_only_policy`:
  `policy_evaluating -> stored_metadata_only`
- `hash_only_policy`:
  `policy_evaluating -> hash_only`
- `zero_retention_policy`:
  `policy_evaluating -> zero_retention_forwarded`
- `detector_fail`:
  `redacting -> quarantined`
- `retention_expired`:
  stored state -> `purged`
- `export_job`:
  stored state -> `exported`

Invariants:

- Raw payload access must be impossible in `hash_only`,
  `stored_metadata_only`, and `zero_retention_forwarded`.
- Every stored event must include capture policy version.
- Every redacted event must include redaction receipt.
- Quarantined events cannot be promoted into datasets.

UI implication:

- Capture stream must show data boundary state per row.
- Dataset builder must block rows with missing or failed redaction receipts
  when a privacy policy requires them.

#### Dataset Row State Machine

States:

1. `candidate`
2. `dedupe_pending`
3. `split_pending`
4. `review_pending`
5. `labeled`
6. `synthetic`
7. `train_eligible`
8. `holdout_eligible`
9. `eval_eligible`
10. `quarantined`
11. `retired`

Transitions:

- `import_or_capture`:
  new row -> `candidate`
- `dedupe_start`:
  `candidate -> dedupe_pending`
- `dedupe_pass`:
  `dedupe_pending -> split_pending`
- `dedupe_fail`:
  `dedupe_pending -> quarantined`
- `assign_split`:
  `split_pending -> review_pending`
- `human_label`:
  `review_pending -> labeled`
- `synthetic_generate`:
  source rows -> `synthetic`
- `policy_train_ok`:
  `labeled` or allowed `synthetic` -> `train_eligible`
- `policy_holdout_ok`:
  `labeled -> holdout_eligible`
- `policy_eval_ok`:
  `labeled -> eval_eligible`
- `leakage_detected`:
  eligible state -> `quarantined`
- `row_superseded`:
  any eligible state -> `retired`

Invariants:

- A row cannot be both train and holdout for the same namespace.
- Synthetic rows cannot become holdout unless explicitly configured and visibly
  labeled as synthetic holdout.
- Rows with unresolved label conflicts cannot be used for final eval.
- Rows with source-policy mismatch cannot leave their allowed boundary.

UI implication:

- Split views must be first-class, not hidden metadata.
- Holdout warnings must be blocking gates, not passive alerts.

#### Eval Run State Machine

States:

1. `draft`
2. `dataset_bound`
3. `baseline_bound`
4. `candidate_bound`
5. `scorer_validating`
6. `running`
7. `completed`
8. `failed`
9. `calibrated`
10. `accepted_as_gate`
11. `retired`

Transitions:

- `create_suite`:
  -> `draft`
- `bind_dataset`:
  `draft -> dataset_bound`
- `bind_baseline`:
  `dataset_bound -> baseline_bound`
- `bind_candidate`:
  `baseline_bound -> candidate_bound`
- `validate_scorer`:
  `candidate_bound -> scorer_validating`
- `scorer_ok`:
  `scorer_validating -> running`
- `run_ok`:
  `running -> completed`
- `run_fail`:
  `running -> failed`
- `calibration_ok`:
  `completed -> calibrated`
- `approve_gate`:
  `calibrated -> accepted_as_gate`
- `supersede`:
  any non-running state -> `retired`

Invariants:

- LLM-judge metrics cannot become gates unless calibration status is present.
- Regression gates require a baseline and candidate.
- Eval runs must preserve scorer code hash and judge prompt hash.

UI implication:

- K-score must link to eval runs and calibration status.
- A failed eval must show whether the failure was candidate behavior, scorer
  error, provider error, or data issue.

#### Compile Job State Machine

States:

1. `requested`
2. `planning`
3. `awaiting_user_approval`
4. `awaiting_policy_approval`
5. `data_preparing`
6. `training_or_transforming`
7. `evaluating`
8. `packaging`
9. `signing`
10. `verifying`
11. `completed`
12. `failed`
13. `cancelled`
14. `superseded`

Transitions:

- `submit`:
  -> `requested`
- `planner_start`:
  `requested -> planning`
- `needs_user_decision`:
  `planning -> awaiting_user_approval`
- `needs_policy_decision`:
  `planning -> awaiting_policy_approval`
- `approved`:
  approval state -> `data_preparing`
- `data_ready`:
  `data_preparing -> training_or_transforming`
- `transform_done`:
  `training_or_transforming -> evaluating`
- `eval_pass`:
  `evaluating -> packaging`
- `eval_fail_retryable`:
  `evaluating -> planning`
- `eval_fail_final`:
  `evaluating -> failed`
- `package_done`:
  `packaging -> signing`
- `signed`:
  `signing -> verifying`
- `verify_pass`:
  `verifying -> completed`
- `verify_fail`:
  `verifying -> failed`
- `cancel`:
  cancellable state -> `cancelled`

Invariants:

- No artifact can be marked complete until verification passes.
- Policy approval must precede data movement to disallowed compute.
- Eval failure cannot be hidden behind a successful package.
- Compile jobs must be idempotent by request hash.

UI implication:

- A compile progress bar is not enough. It needs phase, current gate, logs,
  cost, compute target, and next action.

#### Artifact State Machine

States:

1. `draft`
2. `packaged`
3. `signed`
4. `verified`
5. `target_converted`
6. `target_runtime_verified`
7. `security_scanned`
8. `approved`
9. `published_private`
10. `published_public`
11. `deployed`
12. `retired`
13. `revoked`

Invariants:

- `published_public` requires license and security status.
- `deployed` requires verified artifact and deployment receipt.
- `target_runtime_verified` is target-specific, not global.
- Revocation must be visible in registry and verifier output.

UI implication:

- Artifact detail page must show per-target status, not one global green badge.

#### Deployment State Machine

States:

1. `planned`
2. `environment_validating`
3. `deploying`
4. `health_checking`
5. `shadowing`
6. `canary`
7. `production`
8. `degraded`
9. `rolling_back`
10. `rolled_back`
11. `failed`
12. `retired`

Invariants:

- `production` requires rollback pointer.
- `canary` requires traffic policy.
- `shadowing` must not affect user-visible output.
- Degraded deployment must create incident or health event.

UI implication:

- Promote button must show shadow result, canary policy, and rollback target.

#### Evidence Bundle State Machine

States:

1. `collecting`
2. `incomplete`
3. `complete_unreviewed`
4. `review_requested`
5. `approved`
6. `exported`
7. `expired`
8. `superseded`

Invariants:

- Exported evidence must reference immutable artifact and deployment hashes.
- Expired evidence cannot be reused for new deployment approval.
- Missing owner/risk tier/control mapping keeps bundle incomplete.

UI implication:

- Governance UI must show evidence completeness and missing controls before
  export.

### 5.30 Canonical Data Model Requirements

This is not final database design. It is the minimum conceptual data model the
product needs so all surfaces are consistent.

#### Identity And Tenancy Tables

`organizations`:

- `id`
- `slug`
- `name`
- `plan`
- `billing_customer_id`
- `data_region`
- `default_storage_backend_id`
- `created_at`
- `deleted_at`

`workspaces`:

- `id`
- `org_id`
- `name`
- `environment`
- `default_project_id`
- `policy_profile_id`

`memberships`:

- `id`
- `org_id`
- `user_id`
- `role`
- `status`
- `source`
- `scim_external_id`

`api_keys`:

- `id`
- `org_id`
- `workspace_id`
- `name`
- `hash`
- `scopes`
- `expires_at`
- `last_used_at`
- `revoked_at`

Required invariant:

- Every data-plane object has `org_id`.
- Shared objects have explicit workspace/project scoping.
- API key scopes must be checked at route boundary and job boundary.

#### Provider And Model Tables

`provider_connections`:

- `id`
- `org_id`
- `provider`
- `auth_mode`
- `endpoint`
- `region`
- `data_policy`
- `status`
- `last_auth_test_at`
- `last_capability_probe_at`

`provider_models`:

- `id`
- `provider_connection_id`
- `model_id`
- `model_family`
- `modalities`
- `capabilities`
- `context_window`
- `pricing_snapshot`
- `retention_policy`
- `verified_at`

`provider_conformance_runs`:

- `id`
- `provider_connection_id`
- `model_id`
- `fixture_version`
- `result`
- `failures`
- `started_at`
- `completed_at`

Required invariant:

- Planner can only select a provider capability that appears in verified model
  capabilities or has explicit manual override.

#### Capture And Trace Tables

`capture_policies`:

- `id`
- `org_id`
- `name`
- `mode`
- `filters`
- `redaction_profile_id`
- `retention_days`
- `storage_backend_id`
- `version`

`capture_events`:

- `id`
- `org_id`
- `workspace_id`
- `project_id`
- `provider`
- `model`
- `request_hash`
- `response_hash`
- `payload_ref`
- `redacted_payload_ref`
- `metadata`
- `cost`
- `latency_ms`
- `status_code`
- `capture_policy_id`
- `redaction_receipt_id`
- `created_at`

`redaction_receipts`:

- `id`
- `event_id`
- `profile_version`
- `detectors`
- `classes_detected`
- `confidence`
- `action`
- `payload_hash_before`
- `payload_hash_after`

Required invariant:

- Payload refs must be null when policy is hash-only or zero-retention.
- Event metadata must be sufficient for cost and route analysis even when
  payload is not stored.

#### Dataset And Eval Tables

`datasets`:

- `id`
- `org_id`
- `project_id`
- `name`
- `purpose`
- `version`
- `manifest_hash`

`dataset_rows`:

- `id`
- `dataset_id`
- `source_type`
- `source_id`
- `input_ref`
- `output_ref`
- `label_ref`
- `split`
- `synthetic`
- `provenance`
- `dedupe_hash`
- `semantic_hash`
- `status`

`eval_suites`:

- `id`
- `org_id`
- `project_id`
- `name`
- `task_type`
- `metrics`
- `gate_policy`

`eval_runs`:

- `id`
- `eval_suite_id`
- `baseline_ref`
- `candidate_ref`
- `dataset_hash`
- `scorer_hash`
- `judge_config_hash`
- `result`
- `confidence`
- `status`

Required invariant:

- Eval run must not mutate after completion.
- Dataset row split changes create new dataset version.

#### Compile, Artifact, And Registry Tables

`compile_plans`:

- `id`
- `org_id`
- `project_id`
- `constraints`
- `candidates`
- `selected_candidate`
- `why`
- `why_not`
- `status`

`compile_jobs`:

- `id`
- `plan_id`
- `request_hash`
- `compute_target_id`
- `status`
- `phase`
- `logs_ref`
- `cost_estimate`
- `cost_actual`

`artifacts`:

- `id`
- `org_id`
- `project_id`
- `name`
- `version`
- `kind`
- `manifest_hash`
- `artifact_ref`
- `signature_ref`
- `verifier_status`
- `security_status`
- `license_status`
- `created_at`

`artifact_targets`:

- `id`
- `artifact_id`
- `target`
- `runtime`
- `format`
- `status`
- `benchmark_result`
- `receipt_ref`

`registry_entries`:

- `id`
- `artifact_id`
- `visibility`
- `publisher_id`
- `version`
- `mirror_refs`
- `download_count`
- `revoked_at`

Required invariant:

- Registry entry must point to immutable artifact hash.
- Artifact target status is independent per target.

#### Deployment And Governance Tables

`deployments`:

- `id`
- `org_id`
- `project_id`
- `artifact_id`
- `environment`
- `target`
- `status`
- `endpoint`
- `traffic_policy`
- `rollback_artifact_id`
- `health_status`

`shadow_runs`:

- `id`
- `deployment_id`
- `baseline_ref`
- `candidate_ref`
- `traffic_sample`
- `result`
- `regressions`

`evidence_bundles`:

- `id`
- `org_id`
- `artifact_id`
- `deployment_id`
- `risk_tier`
- `control_mappings`
- `contents_hash`
- `status`
- `export_ref`

`audit_events`:

- `id`
- `org_id`
- `actor_type`
- `actor_id`
- `action`
- `object_type`
- `object_id`
- `request_id`
- `ip`
- `metadata`
- `created_at`

Required invariant:

- Promotion to production emits audit event and evidence snapshot.
- Audit events are append-only.

### 5.31 API Contract Depth

The API should expose the same product truth as CLI and account UI. The
following route families are the minimum contract for a finished product.

#### Provider APIs

- `GET /v1/providers`
- `POST /v1/providers`
- `GET /v1/providers/:id`
- `POST /v1/providers/:id/test`
- `POST /v1/providers/:id/probe`
- `GET /v1/providers/:id/models`
- `GET /v1/providers/:id/conformance-runs`
- `POST /v1/route/explain`
- `POST /v1/route/replay`

Required response behavior:

- Never return a generic "connected" if capability probe failed.
- Include `tested_at`, `capability_status`, and `failure_codes`.

#### Capture APIs

- `POST /v1/capture/events`
- `GET /v1/capture/events`
- `GET /v1/capture/events/:id`
- `POST /v1/capture/policies`
- `GET /v1/capture/policies`
- `POST /v1/capture/redaction/test`
- `POST /v1/capture/export`
- `POST /v1/capture/purge`

Required response behavior:

- Include capture mode and payload availability.
- Redaction test must return per-class detector result.

#### Dataset And Eval APIs

- `POST /v1/datasets`
- `POST /v1/datasets/:id/import`
- `GET /v1/datasets/:id/rows`
- `POST /v1/datasets/:id/split`
- `POST /v1/datasets/:id/leak-check`
- `POST /v1/labels/queue`
- `POST /v1/evals`
- `POST /v1/evals/:id/run`
- `GET /v1/eval-runs/:id`
- `POST /v1/eval-runs/:id/compare`
- `GET /v1/kscore/:artifact_id`

Required response behavior:

- Eval results must expose metric-level outputs, not just aggregate.
- Split/leak-check failures must be blocking and machine-readable.

#### Planning, Training, And Compile APIs

- `POST /v1/opportunities/query`
- `POST /v1/plans`
- `GET /v1/plans/:id`
- `POST /v1/plans/:id/accept`
- `POST /v1/training/quote`
- `POST /v1/training/jobs`
- `GET /v1/training/jobs/:id`
- `POST /v1/training/jobs/:id/cancel`
- `POST /v1/compile/jobs`
- `GET /v1/compile/jobs/:id`
- `POST /v1/compile/jobs/:id/cancel`

Required response behavior:

- Async jobs need idempotency keys.
- Every job response needs phase, cost estimate, compute target, and logs link.

#### Artifact, Registry, And Verification APIs

- `GET /v1/artifacts`
- `GET /v1/artifacts/:id`
- `POST /v1/artifacts/:id/verify`
- `POST /v1/artifacts/:id/diff`
- `POST /v1/artifacts/:id/export`
- `POST /v1/registry/publish`
- `POST /v1/registry/pull`
- `GET /v1/registry/search`
- `POST /v1/registry/mirror`

Required response behavior:

- Verification output must be deterministic and CLI-equivalent.
- Artifact diff must include semantic sections:
  data, prompt, model, eval, runtime, permissions, security, deployment.

#### Deployment, Governance, And Admin APIs

- `POST /v1/deployments/plan`
- `POST /v1/deployments`
- `GET /v1/deployments/:id`
- `POST /v1/deployments/:id/shadow`
- `POST /v1/deployments/:id/promote`
- `POST /v1/deployments/:id/rollback`
- `GET /v1/governance/inventory`
- `POST /v1/evidence/export`
- `GET /v1/audit/events`
- `POST /v1/security/scans`
- `GET /v1/security/scans/:id`

Required response behavior:

- Promote must return approval/evidence status.
- Rollback must return target artifact and traffic policy.

### 5.32 Production Operations, SLOs, And Reliability

This is the minimum operational depth for a production product.

#### Control Plane SLOs

Targets:

- Auth/session availability:
  99.9 percent minimum.
- Read APIs:
  p95 under 300 ms for cached/control metadata.
- Write APIs:
  p95 under 800 ms for normal metadata writes.
- Async job submission:
  p95 under 1 second after auth.
- Webhook delivery:
  first attempt within 30 seconds for job completion.

Required mechanisms:

- idempotency keys for job creation and mutating external calls
- request IDs on all responses
- structured errors
- audit event for sensitive actions
- retry-safe webhooks
- dead-letter queue for failed webhooks
- health endpoints:
  public, authenticated, dependency, worker, storage, provider probe

#### Data Plane SLOs

Targets:

- Gateway overhead:
  p95 under 50 ms excluding provider latency for simple pass-through.
- Capture persistence:
  p99 under 2 seconds for metadata capture.
- Zero-retention mode:
  no raw payload persistence.
- Capture loss:
  explicit loss counter if best-effort mode is used.

Required mechanisms:

- backpressure policy
- sampling policy
- queue durability option
- payload size limits
- PII detector timeout behavior
- raw-payload access logs
- retention sweeper
- purge job verification

#### Worker And Job SLOs

Targets:

- Job state update:
  at least every 30 seconds during active phases.
- Log availability:
  near-real-time for training/compile/deploy.
- Cancel request:
  acknowledged within 5 seconds, best-effort stop depending on backend.
- Stuck job detection:
  heartbeat timeout and recovery path.

Required mechanisms:

- worker heartbeat
- resumable job checkpoints
- external backend polling
- cost cap enforcement
- cancellation propagation
- job leases
- orphan cleanup
- idempotent finalization

#### Storage And Backup Requirements

Targets:

- Metadata backup:
  daily minimum for hosted control plane.
- Artifact integrity:
  content-hash verification on write and pull.
- Cross-region:
  enterprise configurable, not forced by default.
- Customer-managed storage:
  no silent copy into Kolm-managed storage.

Required mechanisms:

- object refs are content-addressed
- encryption status visible
- storage backend health check
- retention policy enforcement
- restore runbook
- migration hash verification

#### Tenant Isolation Requirements

Required:

- `org_id` enforced at database query layer and route layer.
- API keys scoped to org/workspace/project.
- Background jobs carry org context and verify it at every object fetch.
- Object storage paths include tenant boundary and content hash.
- Audit logs include actor, org, object, action, request id.
- Cross-tenant admin tools require break-glass audit.

Test gates:

- tenant A cannot read/list/update/delete tenant B objects
- job from tenant A cannot access tenant B storage refs
- provider key from tenant A cannot be used by tenant B route
- registry private artifact cannot be pulled cross-tenant

#### Incident And Status Requirements

Required:

- status page
- incident timeline
- customer-impact label
- root-cause template
- postmortem action items
- support export for affected org/job/artifact

AI-specific incidents:

- provider quality regression
- model deprecation
- prompt-cache behavior change
- K-score regression
- artifact verification bug
- security scan bypass
- redaction failure
- tenant isolation event
- cloud compute cost runaway

### 5.33 Benchmark Suites Required For Credibility

Benchmarks are not optional marketing assets. They are how reviewers decide
whether Kolm is real.

#### Benchmark 1: Gateway Capture Overhead

Measures:

- pass-through overhead
- streaming overhead
- capture write overhead
- redaction overhead
- zero-retention overhead
- high-concurrency behavior

Competitors/reference:

- direct provider call
- LiteLLM
- Portkey
- Helicone
- Cloudflare AI Gateway
- Vercel AI Gateway

Required output:

- p50/p95/p99 latency
- request/sec
- error rate
- CPU/memory
- payload size effect

#### Benchmark 2: Trace-To-Artifact Quality

Measures:

- repeated task detection precision
- plan selection quality
- training versus non-training candidate choice
- cost reduction
- quality delta
- time to verified artifact

Baselines:

- no optimization
- route-only
- prompt-cache only
- OpenAI fine-tune
- Together/Fireworks/Predibase where applicable
- local fine-tune

Required output:

- candidate table
- final choice
- why not compile/train where applicable
- artifact verifier result

#### Benchmark 3: K-Score Calibration

Measures:

- correlation with human labels
- judge agreement
- metric stability
- false pass rate
- false fail rate
- confidence interval calibration

Required output:

- per-task calibration:
  classification, extraction, generation, RAG, tool call, code
- judge prompt hash
- judge model version
- human label sample

#### Benchmark 4: Distillation And Fine-Tuning

Measures:

- quality retention versus teacher
- cost reduction
- latency reduction
- training cost
- data size sensitivity
- failure cases

Methods:

- SFT
- LoRA/QLoRA
- distillation
- rationale distillation
- preference tuning where practical
- prompt/RAG baseline

Required output:

- task-specific curves:
  examples count versus score
- "do not train" cases
- backend comparison

#### Benchmark 5: Runtime Target Verification

Measures:

- export success
- load success
- numerical/semantic parity
- latency
- memory
- file size
- cold start
- unsupported ops

Targets:

- GGUF/llama.cpp/Ollama
- ONNX Runtime CPU/CUDA/CoreML/OpenVINO
- Core ML
- MLX
- TensorRT-LLM
- OpenVINO
- ExecuTorch
- LiteRT
- WASM/WebGPU

Required output:

- `converted`
- `load_tested`
- `inference_tested`
- `benchmark_verified`
- `field_verified`

#### Benchmark 6: RAG With Permissions

Measures:

- retrieval recall
- answer groundedness
- permission leakage
- freshness handling
- chunking strategy impact
- vector store portability

Backends:

- Pinecone
- Weaviate
- Milvus
- Qdrant
- pgvector
- Elasticsearch/OpenSearch
- Vespa
- Chroma
- LanceDB

Required output:

- source snapshot hash
- chunk policy
- permission receipt
- retrieval metrics
- denied-source tests

#### Benchmark 7: Security And Prompt Injection

Measures:

- prompt-injection detection
- jailbreak detection
- RAG document injection
- MCP tool poisoning
- secrets leakage
- unsafe model serialization
- policy bypass attempts

Tools/reference:

- garak
- Giskard
- Lakera
- Protect AI ModelScan
- HiddenLayer-style model scanning where integrated
- OWASP LLM/MCP scenarios

Required output:

- pass/fail by attack family
- false positives
- blocked publish/promotion decisions

#### Benchmark 8: Enterprise Scale

Measures:

- tenants
- projects
- API keys
- capture events/day
- dataset rows
- eval runs
- artifacts
- registry pulls
- concurrent jobs
- webhook delivery
- audit export size

Required output:

- resource curve
- hot database tables
- queue depth
- p95/p99
- failure recovery

### 5.34 Vertical Workflow Depth

Kolm should not market verticals unless each vertical has concrete workflows,
data boundaries, evals, and evidence.

#### Healthcare

Workflows:

- PHI redaction
- SOAP note extraction
- ICD/CPT coding assist
- prior authorization summary
- patient-message triage
- clinical policy lookup
- call-center summarization

Required integrations:

- EHR export/import patterns
- healthcare document formats
- SFTP/object storage
- customer VPC/local mode
- BAA workflow

Required evals:

- PHI redaction per class
- extraction field accuracy
- refusal/safety for medical advice boundaries
- groundedness for policy lookup

Required evidence:

- HIPAA-oriented audit export
- redaction receipts
- access logs
- data boundary proof

#### Legal

Workflows:

- contract clause extraction
- privilege-preserving summarization
- discovery document triage
- deposition summarization
- legal hold classification
- playbook-based redline suggestions

Required integrations:

- DMS connectors
- PDF/OCR pipeline
- matter-level access control
- private storage

Required evals:

- field-level extraction accuracy
- citation/source grounding
- hallucination detection
- privilege boundary checks

Required evidence:

- matter id
- document hash
- citation receipts
- human reviewer trail

#### Financial Services

Workflows:

- compliance surveillance triage
- KYC document extraction
- lending document analysis
- risk memo drafting
- customer-support classification
- fraud investigation summaries

Required integrations:

- SIEM/GRC export
- data warehouse
- audit logs
- BYOK/CMK
- retention policy

Required evals:

- false positive/negative analysis
- policy-grounded answer checks
- PII leakage tests
- model drift monitoring

Required evidence:

- model risk package
- approval workflow
- immutable audit trail

#### Insurance

Workflows:

- claims intake classification
- policy document extraction
- coverage question answering
- subrogation triage
- adjuster note summarization

Required evals:

- coverage-source grounding
- extraction accuracy
- escalation accuracy
- sensitive data handling

#### Customer Support And Contact Center

Workflows:

- ticket routing
- response drafting
- sentiment/escalation
- call transcript summarization
- QA scoring
- knowledge-base answer generation

Required evals:

- classification F1
- customer-safety flags
- response helpfulness
- tone/policy compliance
- cost savings

This is the fastest wedge because repeated high-volume tasks create obvious
cost deltas.

#### Developer Tools And Code

Workflows:

- code review classification
- test generation for repeated patterns
- support-bot over codebase
- API wrapper generation
- repo policy enforcement
- MCP tool packaging

Required integrations:

- GitHub/GitLab
- Cursor/Continue/Cline/Codex/Claude Code context
- code graph tools
- CI

Required evals:

- unit test pass rate
- static analysis
- exact API contract match
- security scan
- hallucinated path detection

#### Public Sector And Defense

Workflows:

- air-gapped document QA
- policy extraction
- classified/unclassified boundary workflows
- offline model verification
- audit export

Required:

- air-gapped install
- offline verifier
- private registry
- FedRAMP path where applicable
- supply-chain evidence

#### Manufacturing And Edge

Workflows:

- sensor classification
- defect detection wrapper
- field-service assistant
- maintenance-log summarization
- offline plant-floor QA

Required:

- device profiles
- local runtime
- edge deployment
- OTA/rollback
- no-network mode

#### Ecommerce And Marketplace

Workflows:

- product classification
- listing quality checks
- fraud/risk triage
- support automation
- search/rerank evaluation

Required evals:

- precision/recall
- policy compliance
- ranking metrics
- latency under traffic

### 5.35 Capability Maturity Levels

Every capability in the site/docs/account must carry one of these maturity
levels. This prevents fake breadth.

`listed`:

- Mentioned as a planned or possible integration.
- No product claim beyond roadmap.

`wired`:

- Code path exists.
- Configuration exists.
- Basic request path or import/export path exists.
- No external conformance proof yet.

`smoke_tested`:

- Minimal live or local test passes.
- Failure handling exists.
- Docs include setup and known limitations.

`conformance_tested`:

- Full fixture suite passes.
- Capability matrix updated.
- CI or scheduled probe exists.

`runtime_verified`:

- Real workload ran end to end.
- Artifact/deployment/receipt produced.
- Metrics recorded.

`production_verified`:

- Authenticated production environment tested.
- Monitoring and rollback exist.
- Evidence retained.

`enterprise_verified`:

- SSO/RBAC/audit/storage boundary/evidence export tested.
- Customer-cloud or VPC/air-gap path proven where claimed.

UI rule:

- Do not show all maturity levels as green.
- `wired` and `exportable` should be gray/amber.
- Only `runtime_verified`, `production_verified`, and `enterprise_verified`
  should be called ready.

Docs rule:

- Every integration page begins with maturity level and last verified date.

API rule:

- Capability endpoints expose `maturity`, `last_verified_at`, `evidence_ref`.

### 5.36 Competitor Objections And Countermoves

#### Objection: "OpenAI already has distillation and evals."

Truth:

- OpenAI has a strong integrated provider-native loop.

Kolm countermove:

- Cross-provider, local, private, artifact-based verification.
- Use OpenAI as teacher/trainer when it is best.
- Export evidence and run artifacts outside OpenAI.

Required proof:

- Same workflow captured from OpenAI, distilled/fine-tuned through one or more
  backends, verified as `.kolm`, and run locally or in customer cloud.

#### Objection: "Bedrock/Azure/Vertex already solve enterprise AI."

Truth:

- Hyperscalers own procurement, IAM, regions, and native model deployment.

Kolm countermove:

- Be the portable evidence/control layer across hyperscalers.
- Support customer cloud and data-boundary receipts.
- Avoid forcing workload into one cloud.

Required proof:

- Same artifact/evidence model deploys or wraps workflows across AWS, Azure,
  GCP, local, and private storage.

#### Objection: "LiteLLM/OpenRouter/Portkey already route models."

Truth:

- Gateways solve routing and observability faster.

Kolm countermove:

- Gateway is intake; compiler is outcome.
- Turn traces into lower-cost artifacts with verifiable promotion.

Required proof:

- Captured traffic creates compile opportunities and verified artifacts, not
  just dashboards.

#### Objection: "LangSmith/Braintrust/Langfuse already do evals."

Truth:

- They are strong eval/observability systems.

Kolm countermove:

- Import their traces/evals and bind them to artifact promotion, verification,
  deployment, and governance.

Required proof:

- Braintrust/LangSmith/Langfuse eval import becomes artifact evidence and
  promotion gate.

#### Objection: "Predibase/Together/Fireworks already fine-tune and serve."

Truth:

- They provide strong managed training/serving paths.

Kolm countermove:

- Treat them as training backends and own evidence/portability.

Required proof:

- A LoRA/fine-tuned model from these platforms can be wrapped, verified,
  compared, exported, and governed as `.kolm`.

#### Objection: "Glean/Moveworks/Coveo already solve enterprise knowledge."

Truth:

- They own connectors, permissions, enterprise search, and workflow depth.

Kolm countermove:

- Wrap/verify/compile specific repeated behavior and provide evidence; do not
  try to rebuild the whole enterprise knowledge graph first.

Required proof:

- Permission-preserving RAG artifact with source snapshot and ACL receipts.

#### Objection: "Palantir/C3/Dataiku/Databricks solve enterprise AI platforms."

Truth:

- They sell broad enterprise platforms with deep data/workflow integration.

Kolm countermove:

- Be lighter, portable, and artifact-specific; integrate with their data and
  serving surfaces where customers already use them.

Required proof:

- Artifact/evidence export that complements their inventory/governance and can
  run outside them.

#### Objection: "Ollama/llama.cpp already runs local AI."

Truth:

- Local model runners own developer mindshare.

Kolm countermove:

- Use them as runtimes.
- Add capture, eval, artifact, receipt, and governance above the runner.

Required proof:

- `.kolm` pulls/exports a local runtime package and verifies target-specific
  behavior.

#### Objection: "Security vendors already scan AI."

Truth:

- AI security vendors are ahead on threat-specific detection.

Kolm countermove:

- Integrate scanners and bind scan output to artifact publish/promotion.

Required proof:

- Security failure blocks registry publish or production promotion.

### 5.37 Engineering Workstreams Implied By This Research

This is the implementation breakdown the research implies. These are not all
same-priority, but they are the coherent work packages.

#### Workstream A: Capability Registry

Build:

- provider/model capability schema
- conformance fixtures
- maturity levels
- scheduled probes
- UI/API/CLI capability views

Deliverables:

- `ProviderCapability`
- `ProviderConformanceRun`
- capability registry docs
- OpenAI/Anthropic/Gemini/Ollama/vLLM first-class proof

#### Workstream B: Evidence Kernel

Build:

- manifest schemas
- receipt schemas
- evidence bundle format
- verifier output format
- artifact diff model

Deliverables:

- public `.kolm` spec
- standalone verifier
- JSON schemas
- conformance suite

#### Workstream C: Capture And Privacy Kernel

Build:

- capture policies
- redaction receipts
- retention modes
- zero-retention enforcement
- export/purge

Deliverables:

- privacy mode tests
- PII/PHI redaction benchmark
- capture overhead benchmark

#### Workstream D: Planner

Build:

- opportunity detection
- candidate plan generation
- route/cache/RAG/train/distill/quantize decision logic
- savings estimate
- do-not-compile diagnostics

Deliverables:

- planner explanation API
- plan comparison UI
- plan lock-in tests

#### Workstream E: Dataset And Eval Integrity

Build:

- split integrity
- semantic duplicate detection
- synthetic row receipts
- eval suite import/export
- K-score decomposition

Deliverables:

- leakage tests
- eval calibration suite
- K-score evidence UI

#### Workstream F: Compute And Training

Build:

- compute target abstraction
- cloud/rented GPU adapters
- local trainer adapters
- hosted/provider fine-tune adapters
- training receipts

Deliverables:

- no-GPU cloud training path
- cost cap
- logs/progress/cancel

#### Workstream G: Runtime And Deployment

Build:

- deployment plan abstraction
- target adapters
- shadow mode
- canary
- rollback
- runtime receipts

Deliverables:

- local deploy
- Docker deploy
- one cloud deploy
- one Kubernetes deploy
- shadow report

#### Workstream H: RAG And Workflow Artifacts

Build:

- connector snapshot schema
- chunk/retrieval policy schema
- permission receipts
- workflow graph import
- MCP scan/package

Deliverables:

- permissioned RAG proof
- MCP tool permission diff

#### Workstream I: Enterprise Controls

Build:

- SSO/SCIM/RBAC
- audit logs
- BYOK/CMK
- storage boundaries
- evidence export
- SIEM/GRC exports

Deliverables:

- enterprise readiness checklist
- customer-cloud deployment pattern

#### Workstream J: UX Unification

Build:

- one product language across website/docs/CLI/TUI/account
- capability maturity badges
- evidence links
- next-action system
- failure explanations

Deliverables:

- public site IA cleanup
- docs quickstarts
- account post-auth split
- TUI operator views

### 5.38 No-GPU Cloud Product Architecture

This deserves its own section because it is a common real buyer blocker:
"I want to train/distill/compile, but I do not have a GPU."

#### Product Promise

The user can select a compute target by policy:

- cheapest
- fastest
- private/customer cloud
- local only
- regulated/VPC
- air-gapped
- low-carbon where relevant
- specific hardware

#### Compute Target Types

`local_cpu`:

- slow
- private
- good for tiny/rules/RAG/verifier

`local_gpu`:

- private
- user-managed drivers
- good for local fine-tune/quantization/inference

`apple_mlx`:

- local Apple Silicon path
- useful for MLX conversion/inference/fine-tune where supported

`kolm_managed_gpu`:

- simplest UX
- requires strong data boundary disclosure
- good for developers and teams

`rented_gpu_adapter`:

- Modal/RunPod/Lambda-style execution
- fast to ship
- needs provider abstraction and cost cap

`customer_cloud_gpu`:

- AWS/GCP/Azure account
- enterprise friendly
- needs IAM role, storage policy, logs

`customer_kubernetes`:

- enterprise/on-prem
- needs worker installer and queue bridge

`air_gapped_cluster`:

- no external network
- package jobs and artifacts offline

#### Required Compute Quote

Before training:

- method
- base model
- dataset size
- estimated VRAM
- estimated wall time
- estimated cost
- data movement
- storage location
- backend limitations
- cancellation behavior
- expected artifact outputs

#### Required Safety Gates

- cost cap
- max runtime
- data policy check
- model license check
- storage boundary check
- provider terms check
- output scan

#### Minimum Cloud MVP

1. User selects "cloud GPU."
2. Product generates quote.
3. User approves data movement.
4. Async job starts.
5. Logs stream.
6. Cost cap enforced.
7. Artifact imports automatically.
8. Eval runs.
9. Verifier passes.
10. User can deploy or download.

This is enough to remove the "I do not have a GPU" blocker without becoming a
GPU cloud company.

### 5.39 Cloudflare, AWS, Supabase, And Storage Architecture

Given available infrastructure options, the clean architecture is:

#### Control Plane

Use for:

- orgs
- users
- plans
- policies
- metadata
- jobs
- registry metadata
- evidence index

Candidates:

- existing app backend
- Postgres/Supabase for metadata
- Redis/queue where available

Do not store:

- raw sensitive payloads unless customer chose hosted raw mode.

#### Object/Data Plane

Use for:

- artifact blobs
- dataset payloads
- receipts
- exports
- logs
- model outputs

Candidates:

- Cloudflare R2 for S3-compatible global object storage
- AWS S3 for enterprise/customer cloud alignment
- Supabase Storage S3 compatibility for integrated app storage
- MinIO for local/on-prem/air-gap
- customer bucket for BYOC

Required abstraction:

- one `StorageBackend` interface
- signed upload/download
- content hash
- encryption metadata
- region
- retention
- boundary policy

#### Job Plane

Use for:

- compile
- train
- distill
- eval
- export
- verify
- deploy
- scan

Candidates:

- local worker
- Railway/Vercel-compatible worker where current stack allows
- Modal/RunPod adapter
- customer cloud worker
- Kubernetes worker

Required abstraction:

- `JobBackend`
- heartbeat
- logs
- cancel
- retries
- cost tracking
- artifact import

#### Edge/API Plane

Use for:

- public API
- gateway
- signed artifact downloads
- webhook callbacks
- status endpoints

Cloudflare use cases:

- R2 object storage
- Workers for lightweight edge routes
- cache/CDN for public artifacts/docs
- WAF/rate limiting where configured

AWS use cases:

- S3
- SageMaker/custom compute adapters
- Bedrock adapters
- customer cloud roles
- enterprise procurement

Supabase use cases:

- Postgres metadata
- auth/storage where already integrated
- S3 compatibility for object path

Required boundary rule:

- The user must be able to see where each object lives:
  local, Kolm cloud, R2, S3, Supabase, customer bucket, air-gap.

### 5.40 "Anything The User Wants" Support Model

The product should feel broad because it can classify any request into a
supported path, not because every possible path is hand-built.

When the user asks:

- "Can I use this model?"

Kolm should answer:

1. provider/model recognized?
2. API/local runtime available?
3. capabilities known?
4. license acceptable?
5. target task compatible?
6. conformance tested?
7. maturity level?
8. next command to connect or import?

When the user asks:

- "Can I train this?"

Kolm should answer:

1. base model trainable?
2. backend supports it?
3. data format valid?
4. compute target available?
5. privacy policy permits?
6. estimated cost/time?
7. eval gate ready?
8. fallback if training is wrong choice?

When the user asks:

- "Can I run this locally?"

Kolm should answer:

1. artifact payload compatible?
2. target runtime available?
3. hardware sufficient?
4. conversion needed?
5. runtime verified?
6. latency/memory estimate?
7. exact command?

When the user asks:

- "Can I deploy this?"

Kolm should answer:

1. artifact verified?
2. target configured?
3. health check available?
4. secrets configured?
5. rollback available?
6. shadow/canary plan?
7. policy approval needed?

When the user asks:

- "Can compliance approve this?"

Kolm should answer:

1. owner assigned?
2. risk tier set?
3. evidence complete?
4. security scan passed?
5. eval gate passed?
6. data boundary documented?
7. audit export available?

This support model should appear in product UX as guided paths, not as static
FAQ copy.

### 5.41 Research Backlog Still Worth Tracking

Even this document should be treated as a living research artifact. The
following areas change quickly and need periodic refresh:

1. OpenAI, Anthropic, Gemini, Mistral, Cohere, xAI, Groq, Cerebras, Perplexity
   provider features and pricing.
2. Bedrock, Azure, Vertex, Snowflake, Databricks fine-tuning and evaluation
   capabilities.
3. vLLM, SGLang, TensorRT-LLM, OpenVINO, ONNX Runtime, llama.cpp runtime target
   support.
4. Core ML, MLX, LiteRT, ExecuTorch, Qualcomm QNN, WebGPU edge/browser
   deployment maturity.
5. MCP security, agent tool permissions, and IDE/client behavior.
6. RAG evaluation and permission-preserving enterprise search patterns.
7. AI observability standards, especially OpenTelemetry GenAI conventions.
8. AI governance standards and procurement expectations.
9. GPU orchestration and rentable compute economics.
10. Model license changes and enterprise indemnity requirements.

Refresh cadence:

- provider/runtime capability registry:
  weekly or automated
- pricing:
  weekly
- security/MCP:
  weekly
- governance/regulatory:
  monthly
- competitor UX/site positioning:
  monthly
- academic benchmark methods:
  quarterly

### 5.42 `.kolm` Format Contract

The `.kolm` format is the strategic asset. It must be described like an
engineering standard, not a brand wrapper.

#### Format Goals

The artifact must be:

- content-addressed
- offline verifiable
- forward-compatible through explicit schema versions
- inspectable without executing model code
- runnable where a runtime target is present
- diffable across versions
- safe to mirror to third-party registries
- useful to governance/security reviewers
- able to wrap more than one kind of AI behavior

Artifact kinds:

- `model_adapter`
- `full_model`
- `rag_pipeline`
- `workflow`
- `mcp_tool`
- `route_policy`
- `semantic_cache`
- `prompt_compression`
- `ruleset`
- `hybrid`

#### Required ZIP Layout

Minimum layout:

```text
manifest.json
recipe.json
checksums.json
signatures/
  artifact.ed25519
  signer.json
cards/
  modelcard.json
  datasetcard.json
  evalcard.json
  securitycard.json
receipts/
  compile.json
  provider.json
  split.json
  eval.json
  verification.json
runtime-targets/
  targets.json
payload/
  README.txt
```

Conditional layout:

```text
splits/
  train.jsonl
  holdout.jsonl
  eval.jsonl
models/
  model.gguf
  model.onnx
  adapter.safetensors
  model.mlpackage/
  openvino/
  tensorrt/
workflow/
  graph.json
  tools.json
  prompts.json
rag/
  chunk_policy.json
  retrieval_policy.json
  source_snapshot.json
  permission_policy.json
mcp/
  server.json
  tools.json
  permissions.json
security/
  scans.json
  licenses.json
  sbom.cdx.json
  slsa.json
```

Rule:

- A `.kolm` file can reference external payloads only when each external
  payload has immutable URI, hash, size, media type, and access policy.

#### `manifest.json` Required Fields

```json
{
  "schema": "kolm.artifact.manifest.v1",
  "artifact_id": "kolm_art_...",
  "name": "support-triage",
  "version": "1.2.0",
  "kind": "hybrid",
  "created_at": "2026-05-21T00:00:00Z",
  "created_by": {
    "org_id": "org_...",
    "actor_type": "user|service",
    "actor_id_hash": "..."
  },
  "source": {
    "project_id": "proj_...",
    "compile_job_id": "job_...",
    "plan_id": "plan_..."
  },
  "hashes": {
    "artifact": "sha256:...",
    "manifest": "sha256:...",
    "recipe": "sha256:...",
    "payload": "sha256:..."
  },
  "compatibility": {
    "min_runtime": "1.0.0",
    "max_runtime_tested": "1.3.0",
    "format_version": "1"
  },
  "runtime_targets": [
    "openai-compatible-endpoint",
    "llama.cpp-gguf",
    "onnxruntime-cpu"
  ],
  "evidence": {
    "datasetcard": "cards/datasetcard.json",
    "evalcard": "cards/evalcard.json",
    "securitycard": "cards/securitycard.json"
  },
  "license": {
    "artifact": "Proprietary",
    "payload": "Apache-2.0|MIT|Llama-license|unknown",
    "data": "customer-owned|public|mixed|unknown"
  }
}
```

Required validation:

- `artifact_id` stable across mirrors for same artifact hash.
- `version` semver for publisher-visible versions.
- `kind` controls required conditional files.
- Hashes must cover every member and external payload reference.

#### `recipe.json` Required Fields

```json
{
  "schema": "kolm.artifact.recipe.v1",
  "task": {
    "type": "classification|extraction|rag|workflow|tool|generation|hybrid",
    "description_hash": "sha256:...",
    "modalities": ["text"]
  },
  "planner": {
    "version": "1.0.0",
    "constraints": {},
    "candidates_considered": [],
    "selected_candidate": "candidate_...",
    "rejected_candidates": []
  },
  "transforms": [
    {
      "type": "sft|distill|quantize|rag|rules|route|cache|workflow_wrap",
      "backend": "openai|anthropic|local|together|fireworks|custom",
      "config_hash": "sha256:..."
    }
  ],
  "inputs": {
    "dataset_manifest_hash": "sha256:...",
    "eval_suite_hash": "sha256:...",
    "provider_capability_hash": "sha256:..."
  },
  "outputs": {
    "payload_refs": [],
    "target_refs": []
  }
}
```

Required validation:

- Every transform has deterministic config hash.
- Every candidate rejected by planner has reason.
- Privacy and compute policy used by planner is included or referenced.

#### `datasetcard.json` Required Fields

Required:

- dataset id
- dataset version
- row count
- train count
- holdout count
- eval count
- synthetic count by split
- source distribution
- redaction policy version
- leakage check result
- semantic duplicate check result
- label source distribution
- reviewer agreement where applicable
- excluded/quarantined rows count and reasons

Blocking conditions:

- missing holdout for honest eval claims
- synthetic holdout without explicit policy
- train/holdout hash overlap
- unresolved label conflicts
- missing source provenance

#### `evalcard.json` Required Fields

Required:

- eval suite id
- task type
- baseline refs
- candidate refs
- metrics
- scorer hashes
- judge model/prompt hashes
- calibration status
- sample size
- confidence intervals where available
- failed examples summary
- pass/fail gates
- K-score decomposition

Blocking conditions:

- LLM judge without calibration for production gate
- too-small eval without warning
- missing baseline comparison
- metric/task mismatch

#### `securitycard.json` Required Fields

Required:

- model scan
- dependency scan
- license scan
- secrets scan
- prompt-injection scan where prompt/tool/RAG exists
- MCP/tool permission scan where tool exists
- SBOM/ML-BOM reference
- policy exceptions
- scan timestamps

Blocking conditions:

- unsafe serialization
- missing license
- leaked secret
- unscanned tool permission
- failed publish policy

#### Signature And Verification

Verifier must check:

1. ZIP structure is valid.
2. `manifest.json` schema is valid.
3. Every member hash matches `checksums.json`.
4. External payload refs include immutable hash.
5. Signature is valid against signer metadata.
6. Artifact is not revoked where revocation list is available.
7. Required cards exist for artifact kind.
8. Runtime target claims match target receipts.
9. Security card exists for publishable artifacts.
10. Schema version is supported or safely readable.

Verifier output must be stable JSON:

```json
{
  "ok": true,
  "artifact_hash": "sha256:...",
  "schema": "kolm.artifact.manifest.v1",
  "signature": {
    "valid": true,
    "signer": "..."
  },
  "targets": [
    {
      "target": "llama.cpp-gguf",
      "status": "runtime_verified"
    }
  ],
  "warnings": [],
  "errors": []
}
```

CLI requirement:

- `kolm verify artifact.kolm --json` must produce the same logical result as
  `POST /v1/artifacts/:id/verify`.

#### Artifact Diff Contract

Diff dimensions:

- manifest metadata
- task/recipe
- source data
- split composition
- synthetic rows
- prompts
- model/base/adapter
- runtime targets
- eval results
- K-score axes
- security scans
- tool permissions
- deployment policy
- governance approvals

Diff severity:

- `info`
- `review`
- `approval_required`
- `blocking`

Examples:

- prompt change:
  `review`
- holdout shrink:
  `approval_required`
- tool permission added:
  `approval_required`
- security scan failed:
  `blocking`
- artifact signature changed unexpectedly:
  `blocking`

### 5.43 Error Taxonomy And API Problem Details

Every surface needs a shared error language. Without this, the UI, CLI, TUI,
SDKs, and docs drift.

#### Error Envelope

All API errors should use a stable problem shape:

```json
{
  "error": {
    "code": "provider.capability_mismatch",
    "message": "Provider does not support JSON schema outputs for this model.",
    "category": "provider",
    "retryable": false,
    "request_id": "req_...",
    "docs_url": "https://kolm.ai/docs/errors/provider.capability_mismatch",
    "details": {
      "provider": "anthropic",
      "model": "claude-...",
      "required_capability": "json_schema"
    }
  }
}
```

Required fields:

- `code`
- `message`
- `category`
- `retryable`
- `request_id`
- `details`

Optional fields:

- `docs_url`
- `remediation`
- `support_ref`
- `evidence_ref`

#### Error Categories

`auth.*`:

- `auth.missing_key`
- `auth.invalid_key`
- `auth.scope_missing`
- `auth.org_inactive`
- `auth.session_expired`
- `auth.sso_required`

`tenant.*`:

- `tenant.object_not_found`
- `tenant.cross_tenant_access_blocked`
- `tenant.workspace_required`
- `tenant.project_required`

`provider.*`:

- `provider.not_configured`
- `provider.auth_failed`
- `provider.rate_limited`
- `provider.unavailable`
- `provider.model_not_found`
- `provider.capability_mismatch`
- `provider.native_feature_unsupported`
- `provider.policy_blocked`

`capture.*`:

- `capture.policy_invalid`
- `capture.redaction_failed`
- `capture.zero_retention_payload_unavailable`
- `capture.payload_too_large`
- `capture.retention_expired`

`dataset.*`:

- `dataset.schema_invalid`
- `dataset.split_overlap`
- `dataset.synthetic_holdout_blocked`
- `dataset.label_conflict`
- `dataset.leakage_detected`
- `dataset.row_quarantined`

`eval.*`:

- `eval.metric_not_applicable`
- `eval.judge_uncalibrated`
- `eval.baseline_missing`
- `eval.too_small`
- `eval.regression_detected`
- `eval.scorer_failed`

`compile.*`:

- `compile.insufficient_examples`
- `compile.ambiguous_task`
- `compile.no_candidate_beats_baseline`
- `compile.compute_unavailable`
- `compile.policy_approval_required`
- `compile.verification_failed`

`artifact.*`:

- `artifact.signature_invalid`
- `artifact.hash_mismatch`
- `artifact.schema_unsupported`
- `artifact.payload_missing`
- `artifact.target_not_verified`
- `artifact.revoked`

`deploy.*`:

- `deploy.target_unconfigured`
- `deploy.health_check_failed`
- `deploy.shadow_regression`
- `deploy.rollback_missing`
- `deploy.approval_required`

`security.*`:

- `security.scan_failed`
- `security.secret_detected`
- `security.unsafe_serialization`
- `security.license_blocked`
- `security.tool_permission_excessive`

`storage.*`:

- `storage.unavailable`
- `storage.hash_mismatch`
- `storage.encryption_required`
- `storage.boundary_violation`
- `storage.retention_policy_missing`

CLI rule:

- Human output explains what happened and next command.
- `--json` output returns the problem envelope.
- Exit codes map to broad categories:
  auth, config, validation, policy, external dependency, internal, interrupted.

TUI/account rule:

- Show remediation, not raw stack traces.
- Preserve request id and details for support.

### 5.44 Exact CLI Command Contract

The CLI is the product's trust anchor. A finished CLI is not just a wrapper
around HTTP routes.

#### Global Rules

Required global flags:

- `--profile`
- `--org`
- `--workspace`
- `--project`
- `--api-url`
- `--json`
- `--verbose`
- `--quiet`
- `--no-color`
- `--timeout`
- `--offline`

Required global behavior:

- Every command has `--help`.
- Every mutating command supports dry-run where practical.
- Every async command prints job id and next command.
- Every command that writes a file prints path and hash.
- Every command that uses network states endpoint and request id on failure.
- Every command that can run local-only must not require SaaS auth.

#### Command Group Specs

`kolm providers`:

- `list`
- `connect`
- `test`
- `probe`
- `models`
- `capabilities`
- `policy`

Acceptance:

- Can connect OpenAI and Anthropic separately.
- Can connect local Ollama/vLLM/SGLang endpoint.
- Can show native capability differences.

`kolm capture`:

- `start`
- `proxy`
- `policy init`
- `policy apply`
- `test-redaction`
- `events`
- `export`
- `purge`

Acceptance:

- Can run local capture without cloud storage.
- Can prove zero-retention mode does not persist raw payload.

`kolm dataset`:

- `import`
- `from-capture`
- `inspect`
- `split`
- `leak-check`
- `export`
- `quarantine`

Acceptance:

- Can produce train/holdout/eval split manifest.
- Can block overlap.

`kolm eval`:

- `create`
- `run`
- `compare`
- `import`
- `export`
- `calibrate`

Acceptance:

- Can compare provider baseline to artifact candidate.
- Can output metric-level JSON.

`kolm plan`:

- `from-capture`
- `explain`
- `compare`
- `accept`
- `reject`

Acceptance:

- Shows route/cache/RAG/train/distill/quantize candidates.
- Shows do-not-compile reason where appropriate.

`kolm train` and `kolm distill`:

- `quote`
- `start`
- `logs`
- `cancel`
- `resume`
- `import-output`

Acceptance:

- Can run no-GPU cloud path with cost cap.
- Can run local path when dependencies exist.
- Can fail clearly when dependencies do not exist.

`kolm compile`:

- `start`
- `status`
- `logs`
- `cancel`
- `resume`

Acceptance:

- Produces verified artifact or blocking failure.

`kolm artifact`:

- `inspect`
- `verify`
- `diff`
- `run`
- `export`
- `scan`

Acceptance:

- Works offline for local artifact verification.

`kolm deploy`:

- `plan`
- `start`
- `health`
- `shadow`
- `promote`
- `rollback`

Acceptance:

- Can produce rollback target before promotion.

`kolm evidence`:

- `status`
- `export`
- `controls`
- `audit`

Acceptance:

- Exports artifact/deployment evidence without web UI.

### 5.45 TUI Screen Contract

The TUI should be treated as an operator console, not a novelty terminal UI.

#### Screen: Home

Panels:

- active org/workspace/project
- provider health
- active jobs
- top compile opportunities
- blocked gates
- recent artifacts
- current usage/cost

Required actions:

- switch workspace
- open command palette
- jump to job
- jump to opportunity
- run doctor

#### Screen: Providers

Columns:

- provider
- auth
- models
- capabilities
- last probe
- failures
- policy

Actions:

- test
- probe
- inspect model
- edit policy
- copy config

#### Screen: Capture

Panels:

- proxy status
- capture mode
- live events
- redaction stats
- retention policy
- filters

Actions:

- start/stop
- change policy
- inspect event
- promote event to dataset
- export

#### Screen: Datasets

Panels:

- dataset list
- row table
- split chart
- leakage report
- label queue

Actions:

- import
- split
- leak-check
- review label
- quarantine
- export

#### Screen: Evals

Panels:

- eval suites
- active runs
- baseline/candidate comparison
- failed examples
- K-score axes

Actions:

- run
- compare
- calibrate
- accept as gate
- export

#### Screen: Planner

Panels:

- opportunities
- candidate plans
- constraints
- savings estimate
- reasons

Actions:

- accept plan
- reject plan
- edit constraints
- open docs for failure

#### Screen: Jobs

Panels:

- compile jobs
- train jobs
- eval jobs
- deploy jobs
- worker health
- logs

Actions:

- cancel
- resume
- tail logs
- open output artifact

#### Screen: Artifacts

Panels:

- artifact list
- manifest
- targets
- verifier
- diff
- security
- evidence

Actions:

- verify
- diff
- run
- export
- push/pull

#### Screen: Deployment

Panels:

- environments
- deployments
- health
- shadow runs
- canaries
- rollback targets

Actions:

- plan
- deploy
- shadow
- promote
- rollback

#### Screen: Governance

Panels:

- inventory
- risk tier
- controls
- approvals
- evidence completeness
- audit events

Actions:

- request approval
- approve/reject
- export evidence
- open audit trail

### 5.46 Account UI Screen Contract

Post-auth UI must be organized by the product loop, not by historical page
sprawl.

#### Required Navigation

Primary:

- Overview
- Capture
- Data
- Evals
- Compile
- Artifacts
- Deploy
- Governance
- Admin

Secondary under Admin:

- Team
- API keys
- Providers
- Storage
- Compute
- Billing
- Security
- Webhooks
- Audit logs

#### Overview

Must show:

- "next best action"
- active blockers
- current usage/cost
- active jobs
- latest artifact
- top opportunities
- deployment health
- evidence gaps

Anti-pattern:

- generic cards that do not lead to action.

#### Capture

Must show:

- provider connections
- capture mode
- what is stored
- redaction stats
- events
- filters
- opportunity generation

Must not hide:

- raw payload status
- retention policy
- zero-retention implications

#### Compile

Must show:

- candidate plans
- compute picker
- cost/time estimate
- privacy/data movement
- training/eval prerequisites
- job status
- output artifact

Must not:

- let user click "train" without eval/holdout warnings.

#### Artifacts

Must show:

- manifest
- verifier status
- target status
- eval status
- security status
- diff
- registry status
- deploy status

Must not:

- show one global "ready" badge for all targets.

#### Governance

Must show:

- owner
- risk tier
- controls
- evidence completeness
- approvals
- audit export
- incidents

Must not:

- be static trust-center copy.

### 5.47 Documentation And Website Information Architecture

The site should collapse around the core loop.

#### Public Nav

Recommended nav:

- Product
- Developers
- Enterprise
- Docs
- Pricing
- Trust

Product menu:

- Capture
- Compile
- Verify
- Deploy
- Govern
- Registry

Developers menu:

- CLI
- API
- SDKs
- `.kolm` spec
- Local runtime
- MCP/tools

Enterprise menu:

- Security
- Compliance
- BYOC/VPC
- Air-gap
- Storage boundaries
- Audit exports

Docs menu:

- Quickstart
- Guides
- Reference
- Integrations
- Examples
- Changelog

#### Required Quickstarts

1. Capture OpenAI calls.
2. Capture Anthropic calls.
3. Capture local Ollama/vLLM calls.
4. Build dataset from captures.
5. Run an eval.
6. Compile first artifact.
7. Verify artifact offline.
8. Run artifact locally.
9. Shadow deploy artifact.
10. Export evidence bundle.

#### Required Guides

- When not to fine-tune.
- Route versus cache versus RAG versus distill versus fine-tune.
- No-GPU cloud training.
- Customer-managed storage.
- Zero-retention capture.
- Permissioned RAG.
- MCP tool packaging.
- Runtime target verification.
- K-score methodology.
- Artifact diff and rollback.

#### Required Reference

- `.kolm` spec.
- Manifest schema.
- Recipe schema.
- Receipt schema.
- Error codes.
- API reference.
- CLI reference.
- SDK reference.
- Provider capability registry.
- Runtime target matrix.
- Webhooks.

### 5.48 Integration Acceptance Test Matrix

Every integration should have the same acceptance shape.

#### Provider Integration Acceptance

For each provider:

- auth test
- model list
- chat
- streaming
- structured output where supported
- tool calling where supported
- vision where supported
- embeddings where supported
- batch where supported
- prompt cache where supported
- rate-limit behavior
- provider error mapping
- telemetry capture

Initial provider priority:

1. OpenAI
2. Anthropic
3. Gemini/Vertex
4. Azure OpenAI/Foundry
5. Bedrock
6. Mistral
7. Cohere
8. Groq
9. Cerebras
10. OpenRouter
11. LiteLLM-compatible
12. Ollama
13. vLLM
14. SGLang
15. llama.cpp

#### Training Backend Acceptance

For each backend:

- dataset format validation
- job quote
- job submit
- progress/logs
- cancellation behavior
- output import
- eval against baseline
- artifact package
- failure mapping

Initial backend priority:

1. OpenAI fine-tune
2. Bedrock customization/distillation
3. Together
4. Fireworks
5. Predibase
6. local Unsloth/Axolotl/LlamaFactory
7. Hugging Face TRL/PEFT
8. Mistral
9. Cohere
10. Azure/Vertex

#### Runtime Target Acceptance

For each runtime:

- export/convert
- load
- single inference
- batch inference where supported
- streaming where supported
- memory measurement
- latency measurement
- output comparison
- error mapping

Initial runtime priority:

1. local rules/workflow artifact
2. OpenAI-compatible endpoint
3. Ollama
4. llama.cpp/GGUF
5. vLLM
6. SGLang
7. ONNX Runtime
8. Core ML/MLX
9. OpenVINO
10. TensorRT-LLM
11. browser WASM/WebGPU

#### Storage Acceptance

For each storage backend:

- write object
- read object
- verify hash
- signed URL where supported
- delete/purge
- retention metadata
- encryption metadata
- migration test

Priority:

1. local filesystem
2. Cloudflare R2
3. AWS S3
4. Supabase Storage S3 compatibility
5. MinIO
6. GCS
7. Azure Blob

#### Security Integration Acceptance

For each scanner:

- run scan
- parse result
- map severity
- create policy decision
- attach to security card
- block publish/promotion where configured

Priority:

1. secrets scan
2. license scan
3. dependency scan
4. model serialization scan
5. prompt injection scan
6. MCP/tool permission scan
7. PII/PHI scan

### 5.49 Security Threat Model

Security must be part of the architecture, not a post-launch hardening pass.

#### Threat Actors

- malicious user inside customer org
- compromised API key
- compromised provider key
- malicious artifact publisher
- malicious model payload
- malicious MCP server
- prompt-injection attacker through RAG source
- supply-chain attacker
- tenant trying to access another tenant
- runaway agent/tool call
- accidental admin misconfiguration

#### Assets

- provider keys
- customer prompts/responses
- datasets
- holdout sets
- artifacts
- model payloads
- registry entries
- evidence bundles
- audit logs
- billing/usage ledger
- deployment credentials
- storage credentials

#### STRIDE Mapping

Spoofing:

- forged artifact publisher
- fake provider endpoint
- stolen API key
- spoofed webhook

Controls:

- signatures
- mTLS where enterprise requires
- scoped API keys
- webhook signing
- provider endpoint allowlists

Tampering:

- modified artifact payload
- changed eval results
- altered dataset splits
- manipulated registry mirror

Controls:

- content hashes
- append-only receipts
- immutable eval runs
- artifact verification
- mirror hash checks

Repudiation:

- user denies promotion
- admin denies policy change
- worker denies data export

Controls:

- audit events
- signed approvals
- request IDs
- actor identity

Information disclosure:

- raw payload leaked
- cross-tenant read
- provider key leak
- RAG permission leak
- model memorization leak

Controls:

- tenant isolation
- redaction
- zero-retention
- scoped secrets
- permission receipts
- privacy evals

Denial of service:

- provider rate exhaustion
- runaway compile jobs
- webhook storm
- huge payloads
- vector index overload

Controls:

- rate limits
- quotas
- cost caps
- payload limits
- job cancellation
- backpressure

Elevation of privilege:

- MCP tool overreach
- service account scope misuse
- worker accesses admin routes
- deployment credential misuse

Controls:

- tool permission diffs
- RBAC/ABAC
- least privilege service accounts
- policy checks at job execution

#### AI-Specific Threats

Prompt injection:

- through user prompt
- through retrieved docs
- through tool output
- through web/browser content
- through MCP tool description

Model supply chain:

- unsafe serialization
- poisoned weights
- malicious tokenizer
- license trap
- backdoored adapter

Eval manipulation:

- holdout leakage
- synthetic contamination
- judge overfitting
- cherry-picked examples
- metric mismatch

Controls:

- context separation
- tool permission enforcement
- model scan
- tokenizer hash
- split receipts
- eval cards
- judge calibration
- artifact diff

### 5.50 Monetization, Metering, And Margin Model

The product needs accurate metering because cloud compute, provider calls, and
artifact storage can destroy margin.

#### Metered Units

Core:

- API calls
- input tokens
- output tokens
- cached tokens
- captured events
- stored payload bytes
- dataset rows
- eval runs
- judge tokens
- compile jobs
- training tokens
- GPU seconds
- artifact storage bytes
- artifact pulls
- registry publishes
- deployment runtime seconds
- seats
- workspaces/projects

Enterprise:

- SSO/SCIM seats
- audit export volume
- private registry storage
- customer-cloud control plane fee
- VPC/air-gap license
- compliance package
- support tier

#### Usage Ledger Requirements

Each usage event includes:

- org id
- workspace id
- project id
- actor/key
- surface
- action
- provider/model
- artifact/deployment/job id where relevant
- quantity
- unit
- cost basis
- billable amount
- margin class
- timestamp

Invariants:

- Billing should not depend on provider logs alone.
- Usage ledger is append-only.
- Adjustments are separate events.
- Enterprise contract overrides are explicit.

#### Margin Guardrails

Required:

- provider cost estimator
- cloud GPU quote
- max job cost
- budget alerts
- automatic stop at cap
- per-org margin report
- free-tier abuse detection
- expensive judge warning

#### Packaging Recommendations

Free:

- local verifier
- small local artifact runs
- limited capture
- docs/spec access

Pro:

- hosted capture
- basic compile
- cloud compute access with pass-through or marked-up cost
- private artifacts

Team:

- shared datasets/evals
- team registry
- more compute
- usage analytics
- role controls

Enterprise:

- SSO/SCIM/RBAC
- BYOK/CMK
- customer storage
- VPC/BYOC
- air-gap
- audit exports
- private registry
- SLA/support

### 5.51 Analytics And Product Feedback Loops

Kolm needs analytics that improve the compiler without violating privacy.

#### Product Analytics Events

Events:

- signup
- provider_connected
- provider_probe_failed
- capture_started
- first_capture_event
- opportunity_created
- plan_viewed
- plan_accepted
- dataset_created
- eval_run_completed
- compile_started
- compile_failed
- artifact_verified
- artifact_deployed
- shadow_completed
- promotion_completed
- evidence_exported
- user_blocked_by_policy
- user_blocked_by_compute

Properties:

- org/project
- surface
- maturity level
- error code
- time to next step
- artifact kind
- compute target
- provider family

Privacy rule:

- Product analytics must not include raw prompt/response payload unless the
  customer explicitly opted into sharing examples.

#### Compiler Improvement Signals

Signals:

- planner accepted/rejected
- compile failure reason
- eval regression category
- target runtime failure
- provider capability mismatch
- user override reason
- rollback reason
- manual label corrections

Use:

- improve candidate planning
- improve failure diagnostics
- improve docs
- prioritize integrations

### 5.52 Implementation Backlog With Priority

This is the backlog implied by the research, independent of what currently
exists in code.

#### P0: Truth And Trust Kernel

Must exist before stronger claims:

1. Public `.kolm` spec draft.
2. Offline verifier.
3. Artifact manifest/cards/receipts schema.
4. Provider capability registry.
5. Train/holdout/synthetic integrity checks.
6. K-score decomposition.
7. Security card.
8. Artifact diff.
9. Capture privacy modes.
10. Error taxonomy.

Why P0:

- These are the core trust primitives. Without them Kolm is another workflow
  tool.

#### P1: End-To-End Product Loop

Must exist for finished product:

1. Capture OpenAI and Anthropic.
2. Capture local runtime.
3. Build dataset.
4. Run eval.
5. Plan candidates.
6. Compile one or more artifact kinds.
7. Verify artifact.
8. Run locally.
9. Shadow deploy.
10. Export evidence.

Why P1:

- This is the usable product loop.

#### P2: Cloud Compute And Training Backends

Build:

1. Compute target abstraction.
2. No-GPU cloud training path.
3. Cost quote/cap.
4. Logs/cancel/resume.
5. OpenAI/Together/Fireworks/Predibase/local training adapters.
6. Import trained model/adapter.

Why P2:

- Removes the largest adoption blocker for non-ML-infra users.

#### P3: Enterprise Controls

Build:

1. SSO/SCIM/RBAC.
2. Audit logs.
3. BYOK/CMK.
4. Customer storage.
5. VPC/BYOC pattern.
6. Private registry.
7. Evidence exports.
8. SIEM/GRC export.

Why P3:

- Unlocks high ACV and regulated buyers.

#### P4: Ecosystem And Standardization

Build:

1. Conformance suite.
2. SDK verifier libraries.
3. GitHub Action.
4. Public sample artifacts.
5. OCI/HF/GitHub mirrors.
6. MCP installer.
7. Partner docs.
8. Registry API.

Why P4:

- This is the platform/standard path.

### 5.53 Field Readiness Checklist

Before any sales or launch claim, run this checklist.

#### Developer Readiness

- one-line install works
- CLI auth works
- provider connect works
- first capture works
- first artifact verifies offline
- docs quickstart works on clean machine
- errors include next action

#### ML/Research Readiness

- dataset import/export works
- eval-as-code works
- baseline/candidate comparison works
- K-score decomposes
- training backend receipts exist
- benchmark report generated
- reproducibility bundle exported

#### Enterprise Readiness

- SSO configured
- SCIM sync tested
- RBAC tested
- API key scopes tested
- audit export works
- customer storage configured
- evidence export works
- security scan blocks policy failure

#### Production Readiness

- health endpoints pass
- worker heartbeat works
- stuck job recovery works
- rollback works
- shadow mode works
- rate limits work
- tenant isolation tests pass
- usage ledger reconciles
- status page exists

#### Website/Docs Readiness

- every public claim maps to product proof
- no dead CTAs
- pricing consistent
- docs examples run
- spec visible
- maturity levels visible
- no "any model" without registry link
- no "production ready" without proof gate

### 5.54 Due Diligence Packet For Investors And Enterprise Buyers

Kolm should be able to hand over a diligence packet that makes the product feel
serious.

Required packet:

- product architecture diagram
- `.kolm` spec
- verifier docs
- benchmark report
- security model
- threat model
- SOC 2 roadmap/status
- data boundary architecture
- tenant isolation test evidence
- artifact sample
- evidence bundle sample
- API docs
- CLI docs
- customer deployment modes
- pricing/metering model
- competitor matrix
- roadmap with maturity levels

Investor-specific:

- market category thesis
- why artifact standard matters
- wedge use case
- expansion path
- margin model
- ecosystem strategy
- moat analysis

Enterprise-specific:

- SSO/SCIM/RBAC
- audit logs
- DPA/BAA where relevant
- subprocessors
- retention/deletion
- BYOK/CMK
- VPC/BYOC/air-gap
- incident process

### 5.55 What Not To Build Yet

Avoid these until the core loop is unquestionably excellent:

1. Full visual workflow builder.
2. General enterprise search replacement.
3. Broad model-hosting marketplace.
4. Labeling workforce operations.
5. GPU cloud company.
6. Full GRC suite.
7. Every mobile SDK before runtime target proof.
8. Social/community layer before artifact trust.
9. Custom vector database.
10. Custom identity provider.
11. Custom payment stack.
12. Proprietary-only artifact format.
13. Marketing pages for unsupported verticals.

Rationale:

- These add surface area without strengthening the trust/evidence moat.

### 5.56 Enterprise Agent Platform Competitor Dossiers

The previous competitor sections cover infra, evals, training, and governance.
This section covers the enterprise agent platforms that will shape buyer
expectations even when they are not direct compiler competitors.

#### Salesforce Agentforce

Buyer job:

- "Deploy governed AI agents inside CRM and customer workflows."

What Salesforce teaches:

- Enterprise agents win when they sit inside existing systems of record.
- Guardrails, visibility, lifecycle management, and business-object context are
  the buyer language.
- CRM metadata, permissions, workflows, and data cloud context are distribution
  advantages.
- Salesforce is pushing both low-code and pro-code paths, plus SDK/API access.

Threat to Kolm:

- Buyers may ask why they need Kolm if Agentforce can build agents over CRM
  workflows with built-in governance.
- Salesforce can own customer-service, sales, marketing, and service workflows
  before Kolm enters the account.

Kolm response:

- Do not compete as a CRM agent builder.
- Compile, verify, and package repeated AI behavior that can run alongside or
  outside Salesforce.
- Provide artifact evidence for agent actions and model behavior that
  Salesforce-native governance cannot port elsewhere.
- Add Salesforce connector/import pattern later:
  traces, cases, knowledge articles, workflow outputs, permissions.

Proof Kolm needs:

- A support classification artifact trained/evaluated on CRM case traces.
- Evidence bundle showing source provenance, PII redaction, evals, and
  deployment rollback.

#### Microsoft Copilot Studio / Microsoft Foundry Agent Service

Buyer job:

- "Build and operate agents across Microsoft 365, Teams, Azure, and enterprise
  data."

What Microsoft teaches:

- Enterprise buyers expect identity, RBAC, network isolation, content filters,
  agent evaluation, analytics, and integration with productivity tools.
- Agent builders are being tied to the developer stack and business-user stack
  simultaneously.
- Evaluation and compliance documentation are becoming first-class agent
  lifecycle features.

Threat to Kolm:

- Microsoft owns Entra identity, M365 data, Teams, Azure cloud, and developer
  tools.
- If Kolm only offers hosted workflows, Microsoft will look safer to
  enterprises.

Kolm response:

- Integrate with Azure/OpenAI/Foundry as provider and deployment targets.
- Export evidence that can live outside Azure.
- Make Kolm's value:
  artifact proof, cross-cloud portability, offline verifier, and model/runtime
  independence.

Proof Kolm needs:

- Azure provider capture.
- Azure/customer-storage boundary.
- Exportable evidence package.
- Artifact that can run outside Azure while preserving eval/security receipts.

#### Google Gemini Enterprise / Agentspace / Vertex

Buyer job:

- "Let employees use enterprise AI agents over company data with Google-scale
  search, Workspace, cloud, and agent tooling."

What Google teaches:

- Enterprise AI platforms are moving toward one central workbench for search,
  chat, agents, data connectors, and admin controls.
- Agent creation, orchestration, and business-data grounding are converging.
- Agent marketplace/gallery patterns are emerging.

Threat to Kolm:

- Google can own the workplace AI entry point for Workspace/GCP accounts.
- Gemini Enterprise can make "agent over enterprise data" feel solved.

Kolm response:

- Do not try to out-Google the workplace shell.
- Integrate with Gemini/Vertex where customers use it.
- Provide portable artifact proof, benchmark/eval comparison, and local/BYOC
  deployment choices.

Proof Kolm needs:

- Gemini provider conformance.
- Vertex/custom compute adapter path.
- Permissioned RAG evidence model that is independent of Google UI.

#### ServiceNow AI Agents

Buyer job:

- "Automate enterprise service, IT, HR, CRM, and workflow operations inside the
  ServiceNow platform."

What ServiceNow teaches:

- Enterprises want prebuilt agents tied to operational workflows.
- Value is measured in ticket deflection, resolution time, workflow automation,
  and service outcomes.
- Governance is positioned through lifecycle control and AI control tower
  language.

Threat to Kolm:

- ITSM/HR/service workflows are native to ServiceNow.
- Kolm could look abstract if it does not show operational workflow outcomes.

Kolm response:

- Sell into repeated AI behavior that is expensive, sensitive, or needs proof.
- Wrap/export evidence for AI decisions that influence IT/service workflows.
- Build connectors later for tickets, KB articles, workflows, and approvals.

Proof Kolm needs:

- Ticket triage artifact with live shadow comparison.
- Cost/latency/quality delta against provider baseline.
- Audit export for escalations and policy decisions.

#### Atlassian Rovo

Buyer job:

- "Use AI search, chat, and agents across Jira, Confluence, and team work."

What Atlassian teaches:

- Knowledge work agents are strongest when they know work items, pages, teams,
  and project history.
- Agent identity and permission boundaries matter.
- Developer/team workflows are a natural agent surface.

Threat to Kolm:

- Atlassian can own developer/team knowledge workflows.
- Rovo can become the default interface for Jira/Confluence AI tasks.

Kolm response:

- Treat Jira/Confluence as source systems and workflow surfaces.
- Emphasize permission receipts, artifact evidence, and portability beyond
  Atlassian.
- Offer repo/code/task-specific artifact compilation where repeated AI actions
  are measurable.

Proof Kolm needs:

- Permission-preserving Jira/Confluence RAG artifact.
- Code review / issue triage artifact with evals and source citations.

#### SAP Joule Agents

Buyer job:

- "Deploy agents grounded in SAP business processes and enterprise data."

What SAP teaches:

- Business-process grounding is a moat.
- Agent builder plus knowledge graph plus business data is enterprise language.
- Bring-your-own-agent patterns will matter.

Threat to Kolm:

- SAP can own ERP/procurement/finance workflows where data context is hard to
  reproduce.

Kolm response:

- Support BYOA-style packaging and evidence export.
- Make Kolm useful for proving and deploying specific AI behaviors across SAP
  and non-SAP systems.

Proof Kolm needs:

- Workflow artifact with external business-system connector receipts.
- Evidence bundle showing tool permissions, data boundary, and eval outcomes.

### 5.57 Capability Coverage Map By Product Promise

This section maps every broad product promise to concrete capabilities. If a
promise cannot point to one of these capabilities, the promise should be cut.

#### Promise: "Use Any Model"

Capabilities required:

- provider registry
- model registry
- local runtime registry
- capability probes
- model metadata import
- model license tracking
- provider pricing snapshots
- provider data-retention metadata
- conformance suite
- maturity badge

Proof:

- model appears in `/models` or provider capability registry
- last-tested timestamp
- successful smoke/conformance run
- supported task/modalities shown
- unsupported capabilities explicit

Failure:

- "unknown model" creates import/probe flow, not fake support.

#### Promise: "Train Anything"

Capabilities required:

- trainability check
- backend compatibility check
- dataset format conversion
- compute quote
- privacy policy gate
- model license gate
- training job logs
- output import
- eval comparison
- artifact package

Proof:

- training receipt
- data movement receipt
- cost receipt
- eval result
- verified output artifact

Failure:

- blocked with reason:
  model not trainable, backend unsupported, dataset invalid, compute
  insufficient, privacy disallowed, license unknown, budget exceeded.

#### Promise: "Distill Frontier Models"

Capabilities required:

- teacher provider integration
- student model selection
- prompt/task set generation
- response capture with consent/policy
- synthetic data provenance
- holdout protection
- distillation method selection
- eval against teacher and baseline
- cost/latency analysis

Proof:

- teacher run receipt
- synthetic row receipt
- student training receipt
- eval card
- cost/latency delta

Failure:

- teacher terms forbid usage
- task too broad
- student insufficient
- eval fails
- cost not justified

#### Promise: "Compile AI"

Capabilities required:

- planner
- candidate generation
- transform execution
- packaging
- target export
- verifier
- diff
- evidence cards

Proof:

- compile plan
- selected candidate and rejected candidates
- artifact hash
- verifier output
- target status

Failure:

- no candidate beats baseline
- missing eval
- target incompatible
- verification failed

#### Promise: "Run Locally"

Capabilities required:

- local runtime detection
- artifact target matching
- dependency doctor
- local verifier
- local run command
- benchmark
- offline docs

Proof:

- local run receipt
- latency/memory result
- no SaaS dependency for verification/run

Failure:

- dependency missing
- hardware insufficient
- target converted but not tested

#### Promise: "Deploy To Cloud"

Capabilities required:

- deployment plan
- target adapter
- storage refs
- secrets refs
- health check
- shadow route
- canary
- rollback
- logs

Proof:

- deployment receipt
- health status
- shadow report
- rollback pointer

Failure:

- target unconfigured
- health failed
- rollback missing
- approval required

#### Promise: "Enterprise-Ready"

Capabilities required:

- SSO
- SCIM
- RBAC/ABAC
- audit logs
- private storage
- BYOK/CMK
- tenant isolation
- evidence export
- security scans
- retention/deletion
- support/SLA

Proof:

- enterprise readiness test report
- audit export
- storage boundary proof
- policy test

Failure:

- mark as team/developer-ready, not enterprise-ready.

#### Promise: "Auditable AI"

Capabilities required:

- append-only audit events
- receipts
- evidence bundle
- artifact verifier
- eval cards
- data cards
- security cards
- deployment receipts
- runtime receipts

Proof:

- independent verifier output
- export package
- immutable hashes

Failure:

- missing owner/risk/eval/security scan blocks audit-ready status.

### 5.58 Full Test Catalog Needed For 100 Percent Claims

This is the concrete test universe. It should exist as automated tests, scripted
manual tests, or explicit unsupported cases.

#### Provider Tests

1. OpenAI auth success.
2. OpenAI auth failure.
3. OpenAI chat capture.
4. OpenAI streaming capture.
5. OpenAI structured output capture.
6. OpenAI tool call capture.
7. OpenAI fine-tune quote/create where credentials allow.
8. Anthropic auth success.
9. Anthropic auth failure.
10. Anthropic messages capture.
11. Anthropic streaming capture.
12. Anthropic tool-use capture.
13. Anthropic prompt-cache metadata capture where exposed.
14. Gemini auth success.
15. Gemini multimodal request capture.
16. Bedrock provider policy with region.
17. Azure OpenAI deployment-name model mapping.
18. Mistral chat and fine-tune metadata.
19. Cohere chat/rerank/fine-tune metadata.
20. Groq low-latency route with OpenAI-compatible endpoint.
21. Cerebras route with feature metadata.
22. OpenRouter provider order/fallback metadata.
23. LiteLLM-compatible local gateway.
24. Ollama local model list and chat.
25. vLLM OpenAI-compatible server.
26. SGLang OpenAI-compatible server.

#### Capture And Privacy Tests

1. Raw capture stores payload.
2. Redacted capture stores redacted payload.
3. Hash-only capture stores no payload.
4. Zero-retention stores no payload.
5. PII detector catches email/phone/SSN/API key.
6. PHI detector catches MRN/DOB/patient name in fixture.
7. Redaction failure quarantines event.
8. Retention sweeper purges expired payload.
9. Export excludes raw payload when policy forbids it.
10. Capture filter excludes configured provider/model/project.
11. High-latency-only capture works.
12. Error-only capture works.

#### Dataset And Split Tests

1. Import JSONL.
2. Import CSV.
3. Import provider trace.
4. Promote capture event to row.
5. Deduplicate exact duplicates.
6. Detect semantic near-duplicates.
7. Block train/holdout overlap.
8. Block synthetic holdout by default.
9. Permit synthetic holdout only with explicit policy.
10. Preserve source_type, tenant_id, holdout_only metadata.
11. Label conflict blocks eval gate.
12. Dataset version changes on split mutation.

#### Eval Tests

1. Exact match metric.
2. JSON schema metric.
3. Classification F1 metric.
4. Extraction field-level metric.
5. Tool-call correctness metric.
6. RAG groundedness metric.
7. Retrieval recall metric.
8. Human label import.
9. LLM judge with calibration.
10. LLM judge without calibration cannot become production gate.
11. Baseline/candidate comparison.
12. Regression detection.
13. Eval output imports into artifact eval card.

#### Planner Tests

1. Planner chooses no-op when baseline is best.
2. Planner chooses route when cheaper equivalent exists.
3. Planner chooses cache for repeated stable prompt.
4. Planner chooses RAG for dynamic knowledge.
5. Planner chooses fine-tune for stable task with examples.
6. Planner chooses distill for high-cost teacher path.
7. Planner chooses quantize/local for low-latency local target.
8. Planner rejects ambiguous task.
9. Planner rejects insufficient examples.
10. Planner respects privacy policy.
11. Planner respects provider allowlist.
12. Planner respects cost cap.

#### Compile And Artifact Tests

1. Compile ruleset artifact.
2. Compile route-policy artifact.
3. Compile RAG artifact.
4. Compile workflow artifact.
5. Compile model-adapter artifact where backend available.
6. Package manifest.
7. Package dataset card.
8. Package eval card.
9. Package security card.
10. Sign artifact.
11. Verify artifact offline.
12. Detect signature tamper.
13. Detect payload tamper.
14. Diff prompt change.
15. Diff data split change.
16. Diff tool permission change.

#### Runtime Tests

1. Run artifact as local rules/workflow.
2. Run artifact through OpenAI-compatible endpoint.
3. Export/load GGUF where available.
4. Export/load ONNX where available.
5. Export/load Core ML where available.
6. Export/load OpenVINO where available.
7. Browser/WASM target reports converted/tested status.
8. Runtime target without load test is not "runtime_verified."

#### Deployment Tests

1. Local deploy.
2. Docker deploy.
3. Hosted endpoint deploy.
4. Kubernetes deploy where configured.
5. Shadow mode does not affect output.
6. Canary routes configured percent.
7. Promote requires rollback target.
8. Rollback restores prior artifact.
9. Health failure blocks promotion.
10. Deployment logs are visible.

#### Security Tests

1. Secret in artifact blocks publish.
2. Unsafe model serialization blocks publish.
3. Missing license warns or blocks by policy.
4. MCP tool with filesystem write permission requires approval.
5. Prompt-injection fixture creates warning/failure.
6. RAG malicious document is flagged.
7. Cross-tenant artifact pull blocked.
8. API key scope blocks forbidden action.
9. Webhook signature verified.
10. Audit event emitted for promotion.

#### Enterprise Tests

1. SSO login.
2. SCIM provision.
3. RBAC role denies admin action.
4. API key scope enforced.
5. Customer storage write/read/hash.
6. Audit export.
7. Evidence export.
8. Private registry pull.
9. Retention/deletion request.
10. Break-glass admin audit.

### 5.59 API Wrapper And SDK Depth

Kolm's API wrapper must not only route calls. It must preserve enough semantic
detail to later compile behavior.

#### Required SDKs

Priority:

1. TypeScript/JavaScript
2. Python
3. Go
4. Rust
5. Java/JVM
6. C/C++ embedded/runtime verifier
7. Swift
8. Kotlin
9. .NET

Each SDK must include:

- auth
- provider proxy
- capture
- dataset upload
- eval run
- compile job
- artifact verify
- artifact run where practical
- deployment status
- errors as typed exceptions/results
- retries
- timeouts
- idempotency keys
- streaming helpers
- webhook verification

#### API Wrapper Semantics

Must preserve:

- provider name
- original endpoint
- model/deployment id
- native request shape hash
- normalized request shape
- tools/functions
- response format/schema
- cache controls
- batch id
- streaming chunks
- tool call ids
- retrieval/source context
- usage/cost
- error class
- retry attempts

Must avoid:

- flattening Anthropic/Gemini/OpenAI differences into a lossy generic object
- dropping tool-call and cache metadata
- treating all OpenAI-compatible servers as identical

#### SDK Acceptance Tests

For each first-class SDK:

- install from package manager
- create client
- authenticate
- run provider call
- capture event
- handle streaming
- handle typed error
- submit async compile job
- poll job
- verify artifact
- parse webhook

For embedded SDKs:

- compile on Linux
- compile on macOS
- compile on Windows where supported
- verify artifact
- run tiny local artifact
- no dynamic cloud dependency for verification

### 5.60 Codebase Graph And API Understanding Surface

The `codegraph` idea is useful only if it becomes a source of structure for
wrappers, SDKs, tests, and agent tools.

#### What Kolm Should Use Code Graphs For

Use cases:

- inspect customer API repos
- infer route schemas
- generate typed SDK wrappers
- detect auth boundaries
- map data flows
- find AI call sites
- extract repeated prompts
- identify tool/function definitions
- create eval fixtures from tests
- build MCP tools with permission manifest
- generate migration plans

Product object:

- `CodeGraphSnapshot`

Fields:

- repo id
- commit hash
- language
- file hashes
- symbol graph
- route graph
- call graph
- data-flow hints
- AI-call sites
- secrets findings
- generated wrapper candidates

CLI:

- `kolm codegraph scan`
- `kolm codegraph ai-calls`
- `kolm codegraph wrappers`
- `kolm codegraph mcp`
- `kolm codegraph eval-fixtures`

Proof gate:

- Generated wrapper must compile or typecheck.
- AI call-site detection must include file/line and provider.
- MCP tool generation must include permission diff.
- Secrets scan runs before graph export.

Do not build:

- A full IDE competitor.
- A generic code search product.

### 5.61 Observability And Monitoring Depth

Kolm should not replace Datadog, New Relic, Honeycomb, WhyLabs, Evidently, or
Phoenix. It should export and ingest enough to fit into those systems.

#### Runtime Metrics

Required:

- request count
- error count
- provider error class
- latency p50/p95/p99
- cost
- token usage
- cache hit/miss
- route decision
- fallback event
- artifact version
- eval drift signal
- guardrail block
- redaction block
- tool-call count
- deployment health

#### Trace Attributes

Required OpenTelemetry/OpenInference-compatible attributes:

- gen_ai.system
- gen_ai.request.model
- gen_ai.response.model
- gen_ai.usage.input_tokens
- gen_ai.usage.output_tokens
- provider
- artifact_id
- artifact_hash
- deployment_id
- route_decision_id
- eval_gate_id
- kscore
- policy_decision

#### Monitoring Integrations

Export:

- OpenTelemetry spans
- OpenInference traces
- Datadog-compatible logs/traces
- New Relic-compatible telemetry
- Honeycomb via OTel
- SIEM audit events

Import:

- Langfuse traces
- LangSmith runs
- Braintrust experiments
- Phoenix/OpenInference
- W&B Weave
- Evidently reports
- WhyLabs profile/alert references
- TruLens feedback results

Proof gate:

- Same request can be traced from gateway through provider/artifact to
  deployment result and audit event.

### 5.62 Product Design Quality Bar

State-of-the-art web design for Kolm is not decorative. It should communicate
technical trust quickly.

#### Visual Principles

- dense but calm
- proof-forward
- fewer pages, stronger hierarchy
- real product screenshots and terminal examples
- no vague AI gradients as core content
- minimal hero copy
- structured comparison tables
- interactive proof snippets
- capability matrices with maturity labels
- docs links beside claims

#### Homepage Above Fold

Must answer:

1. What is Kolm?
2. What artifact does it create?
3. Why is it different from fine-tuning/gateways?
4. What proof exists?
5. What can I do in five minutes?

Bad:

- "Transform AI workflows with next-generation intelligence."

Good:

- "Compile repeated AI behavior into signed `.kolm` artifacts you can verify,
  run, deploy, and audit."

#### Product Page Pattern

Each product page:

- one-sentence promise
- diagram of loop
- CLI command
- API call
- evidence produced
- integration targets
- maturity status
- failure states
- docs link

Remove:

- long generic paragraphs
- duplicate claims
- unsupported vertical claims
- pages that only exist to say "enterprise-grade"

#### Docs Aesthetic

Required:

- compact nav
- version selector
- copyable commands
- language tabs
- expected output blocks
- error examples
- next step after every guide
- warning boxes for data movement
- maturity badges on integrations

### 5.63 Sales Engineering Demo Scripts

The product should have real demo scripts that use the product, not staged
animations.

#### Demo 1: Developer Five-Minute Proof

Script:

1. Install CLI.
2. `kolm providers connect openai`
3. `kolm providers connect anthropic`
4. `kolm capture start --provider openai`
5. Send sample calls.
6. `kolm opportunities`
7. `kolm plan from-capture`
8. `kolm compile start`
9. `kolm artifact verify`

Artifacts shown:

- capture events
- plan
- eval
- `.kolm`
- verifier output

#### Demo 2: CTO Cost Reduction

Script:

1. Import 10k support traces.
2. Show opportunity ranking.
3. Compare route/cache/fine-tune/distill/local artifact.
4. Show savings estimate.
5. Show shadow result.
6. Show rollback.

Artifacts shown:

- candidate comparison
- K-score card
- deployment receipt
- cost chart

#### Demo 3: CISO Trust Review

Script:

1. Open artifact.
2. Show manifest hash.
3. Show split receipt.
4. Show eval card.
5. Show security card.
6. Show tool permission diff.
7. Run offline verifier.
8. Export evidence.

Artifacts shown:

- verifier JSON
- security scan
- audit export

#### Demo 4: No-GPU User

Script:

1. User selects dataset.
2. Product says local GPU absent.
3. Compute quote compares cloud options.
4. User approves.
5. Async job runs with cost cap.
6. Output artifact imported.
7. Eval and verify.

Artifacts shown:

- compute quote
- training receipt
- output artifact

### 5.64 Founder/Team Internal Operating Metrics

To know whether Kolm is getting better, track these weekly:

Product:

- time to first capture
- time to first verified artifact
- compile success rate
- planner acceptance rate
- percent compiles that choose not to train
- artifact verification failure rate
- shadow promotion success rate
- rollback rate

Data/evals:

- eval suite count
- median eval size
- K-score calibration coverage
- leakage detections
- synthetic row share
- label conflict rate

Infrastructure:

- provider probe pass rate
- gateway overhead p95
- worker stuck jobs
- storage hash mismatches
- webhook delivery success
- tenant isolation test pass

Business:

- captured tokens/events
- compile opportunities generated
- estimated savings
- realized savings after promotion
- cloud compute gross margin
- artifact pulls
- enterprise evidence exports

Trust:

- security scan failures caught
- audit exports
- policy blocks
- customer data boundary configurations
- zero-retention usage

### 5.65 Launch Claim Matrix

Use this to decide exactly what can be said publicly.

Claim:

- "Kolm captures AI traffic."

Allowed when:

- OpenAI and Anthropic capture pass.
- Local OpenAI-compatible capture passes.
- Privacy modes documented.

Claim:

- "Kolm compiles AI behavior."

Allowed when:

- Planner produces candidates.
- At least two artifact kinds compile.
- Offline verifier works.

Claim:

- "Kolm distills frontier models."

Allowed when:

- Teacher/student flow works with at least one provider/backend.
- Synthetic provenance and holdout controls pass.
- Eval shows quality/cost/latency deltas.

Claim:

- "Kolm runs locally."

Allowed when:

- Verified artifact runs without SaaS dependency on at least one local runtime.

Claim:

- "Kolm deploys to production."

Allowed when:

- Health, shadow, canary, rollback, logs, and receipt exist for at least one
  deployment target.

Claim:

- "Kolm is enterprise-ready."

Allowed when:

- SSO/SCIM/RBAC/audit/private storage/evidence export are production verified.

Claim:

- "Kolm is a standard."

Allowed when:

- public spec, verifier, conformance suite, and third-party implementation or
  integration exists.

### 5.66 Risk Register

#### Risk: Too Much Surface Area

Symptom:

- Many pages and routes, few end-to-end happy paths.

Mitigation:

- Collapse product narrative to one loop.
- Mark capability maturity.
- Cut unsupported pages.

#### Risk: Compiler Claim Outruns Technical Reality

Symptom:

- Hardware/compiler buyers dismiss "AI compiler" as packaging.

Mitigation:

- Define compiler as behavior/evidence compiler.
- Export to real compiler/runtime backends.
- Publish target receipts.

#### Risk: K-Score Perceived As Marketing

Symptom:

- Reviewers ask for methodology and calibration.

Mitigation:

- Decompose K-score.
- Publish methodology.
- Include failure examples and calibration status.

#### Risk: Gateway Products Own The Data

Symptom:

- Users adopt LiteLLM/OpenRouter/Portkey and never reach Kolm.

Mitigation:

- Drop-in gateway.
- Import from other gateways.
- Show compile opportunities and savings.

#### Risk: Training Backends Commoditize

Symptom:

- Fine-tuning becomes a commodity feature everywhere.

Mitigation:

- Own evidence, artifact, verification, deployment, governance.

#### Risk: Enterprise Platforms Box Kolm Out

Symptom:

- Salesforce/Microsoft/Google/ServiceNow own agent workflows.

Mitigation:

- Integrate with systems of record.
- Focus on portable evidence and artifact proof.

#### Risk: Security Incident

Symptom:

- Artifact executes malicious payload or leaks tenant data.

Mitigation:

- Offline inspection first.
- Model/security scans.
- strict tenant isolation.
- tool permission gates.
- signed receipts.

#### Risk: Cloud Compute Margin Leak

Symptom:

- No-GPU cloud training burns cash.

Mitigation:

- quote, cap, pass-through/markup, budget alerts, margin ledger.

#### Risk: Fake Local/Edge Claims

Symptom:

- Export works but runtime does not.

Mitigation:

- maturity states:
  converted, load_tested, runtime_verified, field_verified.

### 5.67 Final Product Proof Binder

When the product is genuinely finished, there should be a binder with these
artifacts generated by the product itself:

1. Provider conformance report.
2. Capture privacy report.
3. Dataset leakage report.
4. Eval calibration report.
5. Planner candidate report.
6. Compile job report.
7. `.kolm` verifier report.
8. Artifact diff report.
9. Security scan report.
10. Deployment shadow report.
11. Rollback receipt.
12. Evidence bundle.
13. Usage/margin report.
14. Tenant isolation report.
15. Screenshot/UI audit report.
16. Docs quickstart run log.
17. SDK smoke report.
18. Enterprise readiness checklist.

This binder is the real "done" proof. Without it, "100 percent" is an opinion.

### 5.68 100x Insight Addendum

This section compresses the full research pass into the product decisions that
matter. It exists because a shallow competitor list is not enough. The real
question is what Kolm must become structurally so that every surface reinforces
the same system.

#### Core Insight: Kolm Is Not A Model Product

Kolm should not be positioned as:

- a model provider,
- a training vendor,
- a local runtime,
- an eval tool,
- an agent platform,
- an API gateway,
- a registry,
- or a compliance dashboard.

Those are components. The higher-value category is:

> the evidence layer that turns AI traffic into verified, portable,
> deployable AI systems.

That category lets Kolm coexist with OpenAI, Anthropic, Google, Bedrock,
Together, Fireworks, Hugging Face, Ollama, llama.cpp, CoreML, ONNX Runtime,
ExecuTorch, MLX, OpenVINO, Cloudflare, AWS, Azure, Supabase, Vercel, and
private GPUs. It also lets Kolm be useful whether the customer trains nothing,
fine-tunes one model, distills many tasks, or only wants audit receipts.

#### Insight: "Use Any Model" Is A Contract, Not A Catalog

The mistake is treating model coverage as a long dropdown. The right product
contract is:

- provider adapter exists,
- provider auth works,
- request schema normalizes,
- streaming normalizes,
- tool calls normalize,
- errors normalize,
- token accounting normalizes,
- cost attribution normalizes,
- privacy policy applies before and after the call,
- capture receipts are generated,
- eval replay can compare outputs,
- fallback policy can route away,
- and docs show one complete working example.

If those are true, Kolm supports the model. If not, the model is only listed.

The product UI should therefore expose provider coverage as a maturity matrix:

- `listed`: metadata only.
- `callable`: API call succeeds.
- `capturable`: receipts and capture rows work.
- `replayable`: captured calls can be replayed in evals.
- `trainable`: calls can become examples.
- `distillable`: calls can produce a student candidate.
- `compilable`: output can become a verified `.kolm` artifact.
- `runtime_verified`: artifact has been loaded and executed on a target.
- `field_verified`: real production traffic has proven the target.

This avoids fake "supports everything" claims and makes breadth credible.

#### Insight: "Train Anything" Must Be A Ladder

Users use "train" to mean different things. Kolm should not force them to care
about the distinction upfront. The product should infer and guide:

- prompt optimization when the task only needs instruction repair,
- routing policy when the task only needs provider selection,
- RAG when missing knowledge is the issue,
- LoRA/fine-tune when behavior is stable and examples are enough,
- distillation when expensive teacher behavior should be compressed,
- quantization when size/latency is the blocker,
- compilation when the output needs a portable signed artifact,
- local runtime when privacy/offline is the blocker,
- hosted GPU when the user has no compute,
- and enterprise review when governance risk is the blocker.

The UI should ask for the user outcome first:

- "replace expensive API calls,"
- "run this offline,"
- "protect PHI/PII,"
- "make a smaller specialist,"
- "ship to mobile/edge,"
- "prove behavior to auditors,"
- "compare models before switching,"
- "capture enough examples from production."

Then Kolm maps the outcome to the right training path. Expert users can still
override everything from CLI/API.

#### Insight: "Distill Frontier Models" Requires Proof Discipline

Top AI researchers will not trust a distillation product because it says
"K-score." They need:

- teacher provenance,
- student architecture,
- tokenizer hash,
- data split hashes,
- holdout independence proof,
- judge model provenance,
- deterministic eval code,
- calibration curves,
- failure case clusters,
- adversarial evals,
- distribution-shift evals,
- latency/cost/quality Pareto frontier,
- and reproducible artifact hashes.

The distillation UX should end in a report, not just an artifact. The artifact
is the deployable object; the report is the adoption object.

#### Insight: The No-GPU Path Is Not Optional

If a user cannot train or distill because they lack local GPU capacity, the
product is not finished. The no-GPU path needs:

- provider-backed distillation using OpenAI/Anthropic/Gemini/etc. as teacher,
- managed GPU jobs for open-weight students,
- AWS/GCP/Azure/RunPod/Lambda/Modal/Replicate-style pluggable compute targets,
- customer-cloud BYOC mode,
- budget caps before launch,
- quote-before-run,
- resumable jobs,
- artifact streaming to object storage,
- and "download verified artifact" as the final step.

The key design rule: compute should feel like a target, not a separate product.
The same compile/distill workflow should run on local CPU, local GPU, rented
GPU, hosted Kolm, BYOC cloud, or enterprise air-gap with a target selector.

#### Insight: Enterprise Agent Platforms Are Distribution Competitors

Salesforce Agentforce, Microsoft Copilot Studio, Google Gemini Enterprise,
ServiceNow AI Agents, Atlassian Rovo, and SAP Joule are not just competitors;
they are where enterprise users will expect agents to live. Kolm should not
try to beat them as the employee-facing agent UI. Kolm should become:

- the artifact verifier for their agents,
- the eval/replay layer before agents are promoted,
- the privacy membrane for model calls,
- the local/offline runtime for regulated sub-tasks,
- the cost-reduction layer for repetitive agent skills,
- the receipt layer for agent actions,
- and the export/import bridge between agent ecosystems.

The product page should say this clearly: Kolm lets teams turn production AI
traffic and agent workflows into signed, smaller, cheaper, auditable artifacts
that can run inside or beside the platforms they already use.

#### Insight: The Registry Should Start Private

A public marketplace is exciting but not the first enterprise wedge. The
highest-value first registry is private:

- private artifact catalog,
- version history,
- diff viewer,
- approvals,
- rollback,
- policy gates,
- dependency graph,
- license and data lineage,
- deployment status,
- runtime compatibility,
- receipt history,
- and audit export.

Public marketplace can come later. Enterprise private registry is revenue now.

#### Insight: Docs Must Become Executable Proof

State-of-the-art docs should not read like marketing pages. Each important doc
should include:

- exact command,
- expected output shape,
- failure modes,
- required env vars,
- no-key/local fallback,
- proof artifact generated,
- how to inspect the proof,
- how to clean up,
- and a CI badge or run log proving the doc still works.

The docs should be organized by jobs:

- wrap an API,
- capture traffic,
- create a dataset,
- label examples,
- run evals,
- distill a specialist,
- compile an artifact,
- verify a receipt,
- run locally,
- deploy to cloud,
- run in an agent,
- export an audit packet.

Reference docs can exist, but job docs should be the default path.

#### Insight: Account UI Should Be A Guided Workbench, Not A Page List

The post-auth UI should not expose every surface as equal navigation. It should
start with a workbench:

- goal selector,
- readiness checklist,
- connected providers,
- latest captured traffic,
- next best action,
- active jobs,
- artifact inventory,
- risk warnings,
- cost summary,
- and proof binder status.

Deep pages still exist, but the default account route should answer:

1. What can I do right now?
2. What is blocked?
3. What will save me money?
4. What is safe to promote?
5. What evidence can I show a buyer/auditor/CTO?

#### Insight: CLI/TUI Should Be Progressive

The CLI must be powerful but not expose product complexity immediately.

Beginner path:

- `kolm doctor`
- `kolm wrap`
- `kolm capture`
- `kolm suggest`
- `kolm distill`
- `kolm compile`
- `kolm verify`
- `kolm run`

Expert path:

- explicit teacher/student/provider/runtime/quantization/eval/holdout/cache
  flags.
- JSON/YAML specs for reproducibility.
- `--explain`, `--dry-run`, `--max-cost`, `--target`, `--privacy`,
  `--receipt`, `--webhook`, `--emit-otel`.

The TUI should be the guided version of the CLI:

- left rail: providers, capture, datasets, evals, builds, artifacts, devices,
  deployments, audit.
- command palette for every action.
- inline proof panels.
- job timeline.
- cost and privacy warnings before destructive or expensive actions.

#### Insight: Website IA Should Sell The Loop, Not The Surface Area

The public site should be compressed around one loop:

1. Connect models.
2. Capture real usage.
3. Build evals and datasets.
4. Distill or optimize.
5. Compile `.kolm`.
6. Verify.
7. Run anywhere.
8. Monitor and improve.

Every product page should map to one step in this loop. If a page does not
advance the loop, it is probably clutter.

The homepage should not enumerate every integration. It should make the
category obvious in the first screen:

- AI compiler,
- signed `.kolm` artifact,
- model traffic to deployable specialist,
- cheaper/faster/local/private,
- proof and receipts,
- works with existing providers and runtimes.

#### Insight: "Finished" Means Each Claim Has A Proof Gate

Claim gates:

- "OpenAI-compatible" -> SDK smoke tests with OpenAI client.
- "Anthropic-supported" -> native Messages smoke tests and capture parity.
- "Use any model" -> provider maturity matrix, not dropdown count.
- "Train" -> examples to model-update path with eval report.
- "Distill" -> teacher/student/holdout/proof report.
- "Compile" -> deterministic artifact and verifier report.
- "Run locally" -> load/run receipt on at least one local runtime.
- "Run on edge/mobile" -> maturity states per target.
- "Enterprise-ready" -> SSO/RBAC/audit/export/security evidence.
- "Private" -> zero-retention, redaction, tenant isolation, key scope tests.
- "State of the art" -> benchmark harness and reproducible comparisons.

If a claim cannot point to a gate, remove or soften it.

### 5.69 Competitor Lesson Matrix

This matrix covers the major products that matter to Kolm. The goal is not to
copy their surfaces. The goal is to absorb the buyer expectation each product
creates.

| Category | Competitors | Buyer expectation they set | Kolm implication |
|---|---|---|---|
| Frontier APIs | OpenAI, Anthropic, Google Gemini, xAI, Perplexity | best models, streaming, tools, multimodal, prompt caching, enterprise controls | Kolm must wrap, capture, compare, cache, and replace expensive repeated calls without being model-tribal |
| Cloud AI suites | AWS Bedrock, Azure AI Foundry, Google Vertex/Gemini Enterprise | governance, managed compute, model catalogs, agent builders, private networking | Kolm must plug into clouds as control/evidence layer and provide BYOC deploy paths |
| Fine-tuning/distillation | Predibase, Together, Fireworks, OpenPipe, OpenAI fine-tuning | hosted training, model deployment, eval-assisted customization | Kolm must win on artifact portability, receipts, train/holdout proof, and local runtime |
| Model hubs | Hugging Face, Replicate, GitHub Models | discoverability, model metadata, quick starts, hosted inference | Kolm registry must expose compatibility, proof, license, risk, and deployment status |
| Local runtimes | Ollama, LM Studio, llama.cpp, vLLM, MLX | easy local model execution | Kolm should integrate rather than replace; `.kolm` should be runnable beside them |
| Edge runtimes | CoreML, LiteRT, ONNX Runtime, ExecuTorch, OpenVINO, TensorRT | device-specific acceleration and packaging | Kolm compiler must show target-specific maturity and not overclaim runtime coverage |
| AI gateways | LiteLLM, Portkey, OpenRouter, Cloudflare AI Gateway, Vercel AI Gateway | provider abstraction, rate limits, logs, routing | Kolm must differentiate with capture-to-artifact loop and audit receipts |
| Observability/evals | LangSmith, Langfuse, Phoenix, Weave, Helicone, Evidently, WhyLabs, TruLens | traces, evals, dashboards, regression checks | Kolm must make evals operational: every trace can become a dataset row, eval, distill candidate, or receipt |
| Agent frameworks | LangGraph, CrewAI, LlamaIndex, Semantic Kernel, AutoGen | orchestration and tool use | Kolm should compile, verify, and monitor agent skills rather than replace orchestration |
| Enterprise agents | Agentforce, Copilot Studio, Gemini Enterprise, ServiceNow AI Agents, Rovo, Joule | agents embedded in business systems | Kolm must become the verification/optimization layer for these agents |
| Data/RAG systems | Pinecone, Weaviate, Chroma, LanceDB, Elasticsearch, OpenSearch, pgvector, Vespa | retrieval and vector search | Kolm should package retrieval configs, embedding provenance, and RAG evals into artifacts |
| MLOps | MLflow, W&B, Databricks, SageMaker, Kubeflow, Ray, KServe, BentoML | experiment tracking, serving, pipelines | Kolm must interoperate and specialize in AI artifact proof and deployment receipts |
| Security/compliance | WorkOS, Auth0, Okta, OPA, Presidio, NeMo Guardrails, Bedrock Guardrails | identity, policy, redaction, guardrails, audit | Kolm needs policy-as-code, BYOK, tenant isolation, audit export, and redaction metrics |

### 5.70 Atomic Product Completion Definition

For Kolm, "100 percent done" should mean the following matrix is true:

| Axis | Required state |
|---|---|
| Model providers | OpenAI and Anthropic parity; Gemini/OpenRouter/local backends callable; provider matrix displays maturity, not hype |
| Capture | Works for wrapped calls; supports zero-retention; privacy scans; filters; lake export; receipts |
| Data | Captured rows can be promoted; datasets have train/holdout splits; lineage is visible; leakage is blocked |
| Evals | Deterministic evals, judge evals, adversarial cases, replay, bakeoffs, confidence intervals, failing examples |
| Training | At least prompt, routing, fine-tune, distill, quantize, compile paths are represented with clear maturity |
| Compute | Local CPU/GPU, hosted/no-GPU, BYOC, and object storage targets have readiness checks and budget gates |
| Compile | Artifacts include manifest, recipe, splits, signatures, hashes, runtime targets, compatibility metadata |
| Verify | Offline verifier, API verifier, receipt verifier, diff viewer, rollback path |
| Runtime | API, CLI, TUI, local, MCP, browser/edge/mobile maturity states and load tests where claimed |
| Registry | Private catalog, versions, diffs, policy, dependency graph, proof, deploy metadata |
| Enterprise | Auth, RBAC, API keys, tenant isolation, audit log, billing, usage, compliance export |
| UX | Account workbench guides next action; CLI/TUI support both novice and expert paths; docs are executable |
| Website | Each public page maps to the core loop and does not sprawl into unsupported claims |
| Proof | Final binder exists and is generated by product flows, not manually written afterward |

Any row without a proof artifact should be labeled as roadmap, beta, or
dependency-gated in the product and docs.

### 5.71 Deep Operator Blueprint By User Persona

Kolm has too many possible surfaces to market as one undifferentiated product.
The product should be internally broad but externally job-specific. Every page,
CLI command, TUI view, account module, API route, and doc should map to one of
these personas.

#### Persona: Solo Developer Replacing API Cost

Primary fear:

- "I am paying too much for repeated LLM calls and do not know what can be
  safely replaced."

Required journey:

1. Install.
2. Add provider key.
3. Wrap existing OpenAI/Anthropic client.
4. Capture traffic for one namespace.
5. See replacement opportunities ranked by spend, frequency, and stability.
6. Generate evals from real traffic.
7. Distill or compile a small specialist.
8. Run side-by-side replay.
9. Switch a percentage of traffic.
10. Roll back if quality drops.

Non-negotiable UI:

- "Start saving money" action.
- Cost before/after chart.
- Candidate replacement list.
- One-click shadow mode.
- "why this is safe" proof panel.
- "why this is not safe yet" reasons.

Proof gates:

- At least 50 captured calls or a clear "not enough data" warning.
- Eval split generated without leakage.
- Holdout score above threshold.
- Latency and cost measured on the same inputs.
- Rollback artifact exists before promote.

Do not expose first:

- quantization knobs,
- runtime internals,
- registry metadata,
- enterprise compliance exports.

#### Persona: ML Engineer Building A Specialist

Primary fear:

- "This hides too much and will produce an untrustworthy model."

Required journey:

1. Create project spec.
2. Choose task type.
3. Attach dataset or capture lake.
4. Choose teacher, student, and compute target.
5. Define eval gates as code.
6. Run dry-run diagnostics.
7. Launch async job.
8. Inspect selected/rejected rows.
9. Inspect architecture and quantization.
10. Inspect failure clusters.
11. Export artifact plus reproducibility bundle.

Non-negotiable UI:

- full spec editor,
- dataset lineage,
- split visualizer,
- eval code viewer,
- training event log,
- reproducibility hashes,
- artifact diff.

Proof gates:

- deterministic seed recorded,
- tokenizer hash recorded,
- teacher version recorded,
- student architecture recorded,
- train/holdout row hashes recorded,
- judge version recorded,
- hardware target recorded,
- code/data/config checksum recorded.

#### Persona: Enterprise Platform Engineer

Primary fear:

- "This will become another opaque AI platform that creates security and
  governance exceptions."

Required journey:

1. Connect identity provider or create org.
2. Configure workspaces and service accounts.
3. Set key scopes and tenant policy.
4. Configure storage plane.
5. Configure provider/BYOK secrets.
6. Configure capture retention and zero-store defaults.
7. Configure audit exports.
8. Configure policy gates.
9. Run readiness checks.
10. Export security review packet.

Non-negotiable UI:

- tenant isolation status,
- key scope inventory,
- retention policy,
- evidence export,
- audit log,
- compliance package,
- policy-as-code editor,
- endpoint allowlist.

Proof gates:

- cross-tenant tests pass,
- API key scopes enforced,
- audit logs append-only,
- secret values never appear in artifact,
- SSO/SCIM status visible when configured,
- BYOK/CMK state visible when configured,
- storage location visible.

#### Persona: Compliance / Security Reviewer

Primary fear:

- "AI behavior cannot be audited and the vendor is overclaiming."

Required journey:

1. Open trust center.
2. Review architecture.
3. Review data handling.
4. Review subprocessors.
5. Review security controls.
6. Review artifact verification.
7. Review sample receipt.
8. Download evidence packet.
9. Verify an artifact independently.
10. Verify an inference receipt independently.

Non-negotiable UI:

- no marketing-only trust claims,
- plain control mapping,
- dated evidence,
- contact path for BAA/DPA/security review,
- offline verifier,
- sample receipts.

Proof gates:

- SOC 2 status truthfully labeled,
- HIPAA BAA status truthfully labeled,
- ISO/FedRAMP status truthfully labeled,
- audit export works,
- receipt verifier works without Kolm account.

#### Persona: Agent Builder

Primary fear:

- "Agents are hard to debug, easy to over-permission, and impossible to prove."

Required journey:

1. Import or wrap an agent workflow.
2. Capture traces, tools, inputs, outputs, and cost.
3. Identify stable tool skills.
4. Compile one skill as `.kolm`.
5. Serve skill as MCP/A2A/tool endpoint.
6. Run adversarial tool-use evals.
7. Verify tool receipts.
8. Export agent proof packet.

Non-negotiable UI:

- trace tree,
- tool permission table,
- skill candidate ranking,
- prompt-injection warnings,
- tool-call receipt viewer,
- MCP/A2A export status,
- rollback.

Proof gates:

- tool allowlist enforced,
- prompt/tool boundary recorded,
- user context recorded without leaking secrets,
- timeouts and retries captured,
- unsafe tool calls blocked or flagged,
- trace is exportable via OpenTelemetry conventions.

### 5.72 Model Provider Compatibility Contract

"Supports a provider" must mean a specific technical contract. The minimum
contract should be versioned and published.

#### Provider Adapter Object

Every provider adapter should expose:

- `provider_id`
- `display_name`
- `api_family`
- `auth_methods`
- `base_url`
- `supported_modalities`
- `supported_operations`
- `streaming_support`
- `tool_call_support`
- `json_schema_support`
- `batch_support`
- `fine_tune_support`
- `embedding_support`
- `moderation_support`
- `prompt_cache_support`
- `rate_limit_headers`
- `token_accounting_mode`
- `cost_accounting_mode`
- `error_mapping`
- `retry_policy`
- `privacy_flags`
- `data_retention_notes`
- `capture_maturity`
- `replay_maturity`
- `distill_maturity`
- `last_verified_at`
- `verification_report_id`

#### Required Operations

For each provider:

- list models,
- chat/messages,
- responses/generation,
- streaming,
- embeddings where supported,
- tool/function calls where supported,
- JSON/schema mode where supported,
- image input where supported,
- audio input/output where supported,
- file input where supported,
- batch where supported,
- fine-tune where supported,
- eval where supported,
- usage/cost where available.

#### Conformance Tests

Every adapter needs tests for:

- missing key,
- invalid key,
- provider timeout,
- provider 429,
- provider 5xx,
- malformed provider response,
- stream interruption,
- tool-call serialization,
- JSON-schema invalid output,
- token/cost accounting,
- capture redaction,
- zero-retention bypass,
- replay determinism,
- fallback routing.

#### UI Presentation

The UI should never show a flat "supported" badge. It should show:

- callable,
- streaming,
- tools,
- multimodal,
- capture,
- replay,
- eval,
- distill,
- compile,
- runtime replacement,
- cost tracking,
- privacy notes.

Each badge links to a verification report.

### 5.73 Model Family And Modality Coverage Matrix

The product should support models by capability family, not by brand.

| Family | Examples | Kolm support expectation | Proof needed |
|---|---|---|---|
| text chat | GPT, Claude, Gemini, Mistral, Llama, Qwen, DeepSeek | gateway, capture, replay, eval, distill | provider conformance and replay report |
| reasoning | o-series, Claude reasoning, Gemini reasoning, DeepSeek-R1 style | capture reasoning metadata where allowed, evaluate final answer separately from hidden chain | policy docs and output evals |
| embeddings | OpenAI, Cohere, Voyage, BGE, E5, Jina | capture, compare, RAG eval, vector export | retrieval benchmark |
| rerankers | Cohere rerank, Jina rerank, BGE rerank | RAG pipeline packaging and eval | context relevance eval |
| vision-language | GPT/Gemini/Claude vision, Gemma/VLMs | multimodal capture, redaction, eval, edge target maturity | image eval and redaction report |
| audio | Whisper, GPT audio, Gemini/Claude audio where available | transcribe, redact, capture, compile transcript task | WER and PII report |
| speech output | TTS providers, local speech models | receipt, latency, voice policy | output safety and consent controls |
| code models | GPT/Claude/Gemini, CodeLlama, Qwen-Coder, StarCoder | code evals, repo context, patch proof | unit test and static analysis report |
| tabular/SQL | Cortex Analyst style, text-to-SQL models | schema grounding, SQL safety, query receipts | SQL eval and permission proof |
| agents/tools | OpenAI Agents, LangGraph, CrewAI, Copilot Studio, Agentforce | trace, tool boundary, MCP/A2A, skill compile | agent trace and tool-policy report |
| small local models | Gemma, Phi, Llama, Mistral, Qwen small variants | quantize, run, verify local latency | runtime compatibility report |

This matrix should become a visible `/models` and account UI object, not just
internal docs.

### 5.74 Training And Optimization Method Ladder

Kolm should present training as a ladder. Each rung has input conditions, output
artifact, and proof.

| Rung | Use when | Inputs | Output | Proof |
|---|---|---|---|---|
| prompt repair | task ambiguous but examples limited | prompt, bad outputs, desired style | versioned prompt | before/after eval |
| routing | different models win on different segments | captured traffic, model candidates | routing policy | segment quality and cost report |
| retrieval/RAG | failures come from missing knowledge | docs, embeddings, chunker, retriever | RAG recipe sidecar | context relevance and groundedness |
| response cache | repeated requests are stable | exact/semantic traffic clusters | cache policy | cache hit quality and freshness |
| prompt compression | context too expensive | long prompts, summaries | compression recipe | compression quality delta |
| fine-tune | behavior is learnable from examples | train/eval rows | tuned model or adapter | holdout and regression eval |
| LoRA adapter | open-weight model needs task behavior | examples, base model | adapter | adapter eval and base compatibility |
| distillation | expensive teacher behavior is stable | teacher calls, student candidate | student or artifact | teacher-student agreement and holdout |
| quantization | model is too large or slow | model weights, target runtime | quantized weights | size/latency/quality report |
| pruning/sparsity | inference target needs smaller compute | weights, eval suite | compressed model | quality loss report |
| compilation | deployable sealed behavior needed | recipe, runtime, model/data | `.kolm` artifact | verifier report |
| federated update | data cannot be centralized | client updates, DP policy | aggregated update | privacy and aggregation report |

The core UX implication: a user should not choose from this table first. Kolm
should recommend the rung based on observed failure/cost/latency/privacy
signals, then let experts override.

### 5.75 Distillation Research-Grade Completion Bar

To be credible with serious AI researchers, distillation must expose enough
internals to be attacked.

Required distillation report:

- objective,
- task taxonomy,
- teacher provider/model/version,
- teacher sampling settings,
- teacher prompt template,
- student base model,
- student architecture,
- tokenizer,
- data source,
- data licenses,
- data filters,
- synthetic data flags,
- train/eval/test split hashes,
- row overlap proof,
- deduplication method,
- label noise estimate,
- teacher confidence or self-consistency,
- training method,
- optimizer details where applicable,
- quantization method,
- hardware,
- seed,
- eval suite,
- judge model if any,
- deterministic metrics,
- LLM-judge metrics,
- human review sample if any,
- failure clusters,
- adversarial results,
- distribution-shift results,
- latency/cost/size comparison,
- recommended deployment target,
- non-goals and known failure modes.

Required failure diagnostics:

- not enough examples,
- class imbalance,
- label conflict,
- high teacher variance,
- prompt instability,
- multimodal unsupported target,
- student too small,
- context too long,
- privacy policy blocks rows,
- license policy blocks rows,
- eval too weak,
- holdout leakage risk,
- cost cap too low,
- compute unavailable.

Researchers will forgive limitations that are measured. They will not forgive a
black-box score.

### 5.76 Runtime And Export Target Contract

Kolm should separate four things that are often blurred:

1. artifact format,
2. model weight format,
3. runtime engine,
4. deployment environment.

#### Artifact Format

`.kolm` should carry:

- manifest,
- recipe,
- runtime contract,
- model payload pointer or embedded payload,
- split metadata,
- eval report,
- signature,
- receipt schema,
- dependency graph,
- target matrix.

#### Model Weight Formats

Supported/expected:

- GGUF for llama.cpp/Ollama-style local inference,
- ONNX for cross-platform runtime,
- Safetensors for open-weight interchange,
- CoreML package for Apple,
- MLX weights for Apple Silicon research/runtime,
- OpenVINO IR for Intel CPU/NPU,
- TensorRT/TensorRT-LLM engine for NVIDIA,
- ExecuTorch package for mobile/edge,
- LiteRT/TFLite for Android and embedded,
- adapter formats for LoRA/PEFT where applicable.

#### Runtime Engines

Supported/expected:

- Kolm native runtime,
- OpenAI-compatible hosted endpoint,
- llama.cpp,
- vLLM,
- SGLang,
- ONNX Runtime,
- CoreML,
- MLX,
- OpenVINO,
- TensorRT-LLM,
- ExecuTorch,
- browser WASM/WebGPU,
- Cloudflare/Vercel/Deno edge where feasible.

#### Deployment Environments

Supported/expected:

- local laptop,
- local workstation GPU,
- Docker,
- Kubernetes,
- KServe,
- Ray Serve,
- BentoML,
- serverless GPU,
- AWS/GCP/Azure BYOC,
- Cloudflare/R2/Workers style edge,
- Vercel,
- mobile app,
- browser app,
- air-gapped enterprise.

#### Runtime Maturity Labels

Every target should have one of:

- `not_applicable`
- `planned`
- `converted`
- `loads`
- `runs_smoke`
- `runs_eval`
- `performance_profiled`
- `production_supported`
- `field_verified`

The site should never imply `production_supported` unless load, eval,
observability, rollback, and docs exist.

### 5.77 No-GPU, Hosted Compute, And BYOC Product Design

The no-GPU user is a first-class buyer. The workflow must be:

1. User selects goal.
2. Kolm detects local hardware.
3. Kolm estimates whether local compile/distill is viable.
4. If not viable, Kolm offers compute targets:
   - hosted Kolm,
   - user AWS,
   - user GCP,
   - user Azure,
   - user Cloudflare/S3-compatible object storage for artifacts,
   - rented GPU provider,
   - local remote worker over SSH/tunnel.
5. User sees:
   - estimated cost,
   - estimated duration,
   - data movement,
   - privacy posture,
   - artifact storage location,
   - cancellation behavior,
   - retry behavior.
6. User runs job.
7. Product streams logs and checkpoints.
8. Product stores artifact and proof report.
9. Product offers deploy/run/verify next step.

Required compute target object:

- `target_id`
- `target_type`
- `region`
- `gpu_type`
- `cpu_memory`
- `gpu_memory`
- `storage_uri`
- `egress_policy`
- `secret_ref`
- `max_cost`
- `max_duration`
- `supports_training`
- `supports_distillation`
- `supports_quantization`
- `supports_runtime_benchmark`
- `supports_airgap`
- `last_readiness_check`
- `readiness_report`

Production guardrails:

- no job starts without cost cap,
- no sensitive dataset moves without privacy warning,
- no secret is written into artifact,
- no artifact is marked verified until downloaded and hash-checked,
- no BYOC target is marked ready until IAM/storage/network checks pass.

### 5.78 Agent Protocol And Tool Interoperability Strategy

MCP, A2A, OpenAI Agents SDK, LangGraph, CrewAI, LlamaIndex, Semantic Kernel,
AutoGen, enterprise agent products, and custom internal agents should be treated
as integration planes. Kolm's job is to turn agent behavior into verifiable
units.

#### MCP Product Contract

Kolm should support:

- compile artifact as MCP tool,
- serve verifier as MCP tool,
- serve artifact registry as MCP resource,
- expose compile jobs as MCP tools,
- expose trace query as MCP resource,
- generate Claude Desktop/Cursor/Cline/Continue config,
- run MCP security doctor,
- warn about local process execution,
- require allowlist for filesystem/network tools.

Proof:

- MCP server launches,
- tool schema validates,
- tool call produces receipt,
- failure is structured,
- secrets are redacted,
- permission prompt is visible.

#### A2A Product Contract

Kolm should support:

- agent card generation for compiled artifacts,
- task/status lifecycle,
- streaming status,
- artifact output metadata,
- auth scheme declaration,
- skill descriptions,
- receipt references.

Proof:

- A2A schema validates,
- task invocation works,
- receipt links back to `.kolm` artifact,
- task cancellation works,
- auth failure is explicit.

#### Agent Trace Contract

Every agent run should produce:

- run id,
- user/session id hash,
- agent id,
- model calls,
- tool calls,
- tool inputs/outputs redacted,
- retrieved context ids,
- policy decisions,
- cost,
- latency,
- errors,
- final output hash,
- receipt.

This should map to OpenTelemetry GenAI semantic conventions where possible.

### 5.79 RAG And Knowledge Product Requirements

Kolm should not become just another vector database. RAG should exist because
many "train this" requests are actually "give the model the right knowledge."

Required RAG objects:

- corpus,
- document,
- chunk,
- embedding model,
- embedding version,
- vector index,
- reranker,
- retriever config,
- citation policy,
- freshness policy,
- access control policy,
- eval set,
- query trace,
- groundedness score,
- context relevance score,
- answer relevance score.

Required RAG evals:

- retrieval recall,
- context precision,
- context relevance,
- answer groundedness,
- answer relevance,
- citation correctness,
- abstention correctness,
- stale-document detection,
- access-control leakage,
- prompt-injection in retrieved docs,
- chunk boundary failure,
- cross-document synthesis failure.

Artifact implication:

- A `.kolm` artifact may include a RAG sidecar, but the sidecar must disclose
  whether it embeds data, points to an external index, or requires a tenant
  data plane at runtime.

UI implication:

- If a user asks to "train on docs," the product should first ask whether the
  documents change often. If yes, recommend RAG or hybrid RAG plus distillation.
  If no, compile may be appropriate.

### 5.80 Observability, Monitoring, And Debugging Standard

Kolm observability should not be another generic chart page. It should explain
why behavior changed.

#### Metrics

Required:

- request count,
- token count,
- cost,
- latency p50/p95/p99,
- error rate,
- provider rate-limit rate,
- fallback rate,
- cache hit rate,
- redaction rate,
- policy block rate,
- eval pass rate,
- K-score drift,
- artifact version usage,
- runtime target usage,
- tenant/workspace/project attribution.

#### Traces

Required spans:

- gateway receive,
- privacy scan,
- provider request,
- provider stream,
- capture write,
- eval replay,
- dataset promotion,
- compile plan,
- training job,
- quantization,
- artifact packaging,
- signing,
- verify,
- runtime load,
- runtime inference,
- deploy,
- rollback.

#### Debug Views

Required UI:

- trace waterfall,
- raw request/response with redaction,
- cost breakdown,
- policy decisions,
- provider error normalization,
- replay button,
- compare against artifact,
- open eval failure cluster,
- generate dataset row from trace,
- export OTEL trace.

#### Alert Types

Required:

- cost spike,
- latency spike,
- quality regression,
- K-score drift,
- redaction failure,
- provider outage,
- fallback exhaustion,
- cache staleness,
- artifact version mismatch,
- tenant quota breach,
- suspicious tool call,
- eval gate failure.

### 5.81 Security Threat Model For Kolm

Kolm's threat model must cover AI-specific and platform-specific risks.

#### Threats

- prompt injection,
- indirect prompt injection from documents/tools,
- sensitive information disclosure,
- cross-tenant leakage,
- training data leakage,
- eval leakage,
- artifact tampering,
- malicious artifact upload,
- malicious MCP server,
- tool over-permission,
- provider key exfiltration,
- poisoned capture data,
- poisoned synthetic data,
- supply-chain compromise,
- vulnerable runtime dependency,
- stale model with known exploit,
- jailbreak-induced policy bypass,
- insecure BYOC IAM,
- unbounded hosted compute cost,
- insecure local tunnel,
- receipt forgery,
- verifier downgrade attack.

#### Controls

- tenant isolation tests,
- scoped API keys,
- secret references only,
- redaction before persistence,
- zero-retention mode,
- dataset provenance,
- split integrity,
- artifact signatures,
- offline verifier,
- Sigstore/SLSA/SBOM where applicable,
- policy-as-code,
- allowlisted tools,
- sandboxed tool execution,
- MCP doctor,
- dependency scanning,
- model/license scanning,
- cost caps,
- IAM readiness checks,
- audit append-only log,
- receipt hashes.

#### Security UI

Each workspace should show:

- key age,
- last key use,
- high-risk scopes,
- active provider secrets,
- active tunnels,
- active MCP servers,
- storage plane,
- retention policy,
- redaction policy,
- last privacy scan,
- last tenant isolation check,
- latest security evidence export.

### 5.82 Website Information Architecture Completion Spec

The site should have fewer top-level concepts and stronger product pages.

Recommended public IA:

- `/` - category and loop.
- `/capture` - wrap APIs, capture traffic, privacy membrane.
- `/evals` - evals, replay, K-score, proof.
- `/distill` - teacher/student, cost reduction, frontier replacement.
- `/compile` - `.kolm` artifact, verifier, runtime portability.
- `/run` - local, edge, cloud, BYOC runtime.
- `/registry` - private registry, artifact governance, versioning.
- `/enterprise` - security, governance, deployment, compliance.
- `/docs` - executable docs.
- `/pricing` - Free/Pro/Team/Enterprise.
- `/trust` - security/trust.

Pages to consolidate or demote:

- highly narrow feature pages that do not explain a journey,
- duplicate vertical pages with weak proof,
- pages that list integrations without verification status,
- pages that repeat the same hero copy,
- pages that use unsupported "coming soon" claims above the fold.

Every public page should answer:

1. What job does this page solve?
2. What input does the user bring?
3. What output does Kolm produce?
4. What proof does Kolm generate?
5. What can the user do next?

Every page should avoid:

- vague "AI infrastructure" claims,
- huge paragraph blocks,
- unsupported benchmark numbers,
- fake self-serve enterprise checkout,
- broad "all models" claims without maturity labels,
- feature sprawl grids that make the product look unfocused.

### 5.83 Account UI Completion Spec

The account UI should be organized by product state, not by the repo's route
history.

Recommended account structure:

- Overview
  - next best action,
  - blockers,
  - active jobs,
  - proof binder status,
  - cost summary.
- Connect
  - provider keys,
  - local runtimes,
  - cloud targets,
  - storage.
- Capture
  - live events,
  - filters,
  - privacy scan,
  - retention.
- Improve
  - opportunities,
  - datasets,
  - labeling,
  - evals,
  - bakeoffs.
- Build
  - distill,
  - train,
  - quantize,
  - compile,
  - jobs.
- Artifacts
  - registry,
  - versions,
  - diffs,
  - receipts,
  - deployments.
- Run
  - local,
  - API,
  - MCP,
  - cloud,
  - device fleet.
- Govern
  - keys,
  - users,
  - audit,
  - compliance,
  - policies,
  - billing.

Every route should include:

- breadcrumb,
- current workspace,
- empty state,
- loading state,
- error state,
- docs link,
- API equivalent,
- CLI equivalent,
- last updated timestamp,
- permission warning if relevant.

Every destructive or expensive action should include:

- cost estimate,
- privacy impact,
- data movement,
- rollback path,
- required permissions,
- expected output artifact.

### 5.84 CLI Completion Spec

CLI should be organized around verbs that match the product loop.

Recommended command families:

- `kolm doctor`
- `kolm auth`
- `kolm providers`
- `kolm wrap`
- `kolm capture`
- `kolm lake`
- `kolm privacy`
- `kolm datasets`
- `kolm labels`
- `kolm eval`
- `kolm replay`
- `kolm suggest`
- `kolm train`
- `kolm distill`
- `kolm quantize`
- `kolm compile`
- `kolm artifacts`
- `kolm verify`
- `kolm run`
- `kolm registry`
- `kolm deploy`
- `kolm devices`
- `kolm compute`
- `kolm mcp`
- `kolm a2a`
- `kolm audit`
- `kolm billing`
- `kolm tui`

Every command should support:

- `--help`,
- `--json`,
- `--dry-run` where meaningful,
- `--workspace`,
- `--namespace`,
- `--api-key` or env fallback,
- structured non-zero exit codes,
- clear install/config hints.

High-risk commands should support:

- `--max-cost`,
- `--max-duration`,
- `--privacy`,
- `--target`,
- `--yes`,
- `--receipt`,
- `--emit-otel`.

CLI quality gates:

- no command prints secrets,
- JSON output is stable,
- docs examples run,
- Windows/macOS/Linux paths work,
- shell completion works,
- errors include next action,
- TTY and non-TTY modes both work.

### 5.85 TUI Completion Spec

The TUI should not be a novelty. It should be the fast local cockpit.

Views:

- Home,
- Providers,
- Capture,
- Lake,
- Privacy,
- Opportunities,
- Datasets,
- Evals,
- Jobs,
- Artifacts,
- Runtime,
- Devices,
- Compute,
- MCP/A2A,
- Audit,
- Settings.

Required interactions:

- command palette,
- search/filter,
- keyboard navigation,
- job tail,
- trace open,
- artifact verify,
- run replay,
- promote dataset,
- launch compile dry-run,
- switch workspace,
- copy command,
- open docs URL.

Required status strips:

- active workspace,
- provider connectivity,
- local runtime status,
- storage plane,
- privacy mode,
- job count,
- current cost estimate.

TUI proof:

- snapshot tests,
- keyboard route tests,
- Windows terminal test,
- narrow terminal layout test,
- color/no-color mode,
- screen reader/plain text fallback where possible.

### 5.86 SDK And API Wrapper Completion Spec

SDKs are not complete because files exist. They are complete when each supports
the critical path for its audience.

#### TypeScript/Node

Required:

- OpenAI-compatible wrapper,
- Anthropic wrapper,
- capture log,
- datasets,
- compile jobs,
- artifact verify,
- runtime run,
- streaming,
- webhooks,
- typed errors,
- ESM/CJS compatibility,
- browser-safe subset.

#### Python

Required:

- provider wrapper,
- notebooks,
- pandas dataset import/export,
- eval runner,
- distill job,
- artifact verify,
- local run,
- MLflow/OpenTelemetry interop,
- async support.

#### Go

Required if enterprise/backend buyers are targeted:

- gateway client,
- verify client,
- registry client,
- webhook verifier,
- context cancellation,
- retry policy.

#### Rust

Required:

- verifier,
- runtime where feasible,
- artifact parser,
- CLI embedding,
- no unsafe critical path without tests,
- cargo check/test in CI.

#### C

Required:

- tiny verifier/runtime FFI surface,
- embedded use case,
- memory safety tests,
- compile CI on Linux,
- clear ownership rules.

#### Mobile SDKs

Required:

- iOS/Swift package,
- Android/Kotlin package,
- React Native bridge,
- artifact load/run status,
- receipt generation,
- privacy disclaimers,
- offline sample app.

### 5.87 Cloud Product Completion Spec

Kolm Cloud should not just be hosted UI. It should provide services local users
cannot easily self-host.

Cloud services:

- managed capture endpoint,
- managed event lake,
- managed eval runner,
- managed compile/distill jobs,
- hosted GPU target,
- artifact registry,
- receipt verifier,
- webhook/event bus,
- team/org management,
- billing/quotas,
- audit export,
- storage integrations,
- BYOC control plane,
- status and SLO reporting.

Cloudflare/S3-compatible object storage implication:

- artifacts should be stored in content-addressed paths,
- manifests should include object digests,
- signed URLs should be short-lived,
- private registry pulls should be logged,
- public artifacts should be CDN-cacheable,
- receipts should be immutable,
- deletion should support tombstones for audit.

AWS implication:

- S3 for artifacts,
- KMS for customer-managed keys,
- ECS/EKS/Batch/SageMaker/Bedrock targets,
- IAM readiness checks,
- PrivateLink/VPC option for enterprise.

Supabase implication:

- auth can support early product,
- Postgres can support event/catalog/control plane,
- row-level security can help but does not replace explicit tenant tests,
- object storage can support small artifacts or docs but large model payloads
  need cost/egress planning.

Vercel/Railway implication:

- good for control plane and marketing,
- not sufficient as primary GPU/large artifact compute plane,
- must not blur web app deploy with training infrastructure.

### 5.88 Benchmark And Public Proof Program

Kolm needs a benchmark program that buyers and researchers can reproduce.

Benchmark suites:

- API replacement tasks,
- classification,
- extraction,
- summarization,
- routing,
- RAG,
- tool/agent tasks,
- PHI/PII redaction,
- code tasks,
- multimodal tasks,
- local runtime latency,
- artifact size,
- compile time,
- cost.

Each benchmark row should include:

- dataset,
- task,
- license,
- teacher,
- student,
- baseline model,
- prompt,
- eval metric,
- judge if any,
- hardware,
- runtime,
- artifact size,
- latency,
- cost,
- quality,
- reproducibility command.

Public leaderboard rules:

- no cherry-picked private-only numbers,
- separate synthetic and real captured datasets,
- separate local and hosted results,
- separate quality and cost,
- disclose failed tasks,
- disclose unsupported targets,
- publish benchmark harness.

### 5.89 Compliance Mapping And Evidence Exports

Kolm should map product evidence to frameworks without pretending to be
certified where certification is not complete.

Controls to map:

- NIST AI RMF Govern/Map/Measure/Manage,
- NIST AI 600-1 generative AI profile,
- OWASP LLM Top 10,
- ISO/IEC 42001 management system controls,
- SOC 2 security/availability/confidentiality,
- HIPAA administrative/technical safeguards where applicable,
- GDPR data subject and processor obligations,
- SLSA/Sigstore/SBOM supply-chain controls,
- internal enterprise AI policy.

Evidence export should include:

- artifact manifest,
- model/data lineage,
- eval report,
- security scan,
- privacy scan,
- redaction report,
- access log,
- policy decisions,
- deployment targets,
- verifier output,
- receipt samples,
- incident/rollback history,
- subprocessors,
- retention settings.

The product must distinguish:

- "control implemented",
- "evidence generated",
- "auditor-certified",
- "customer-configured",
- "not applicable."

### 5.90 Anti-Slop Product Rulebook

This should govern website, docs, UI, CLI copy, and investor materials.

Rules:

- Never say "all models" without a maturity matrix.
- Never say "enterprise-ready" without named controls and evidence.
- Never say "private" without explaining storage/capture mode.
- Never say "local" if a hosted service is required for the claim.
- Never say "compile" if the result is only a wrapper.
- Never say "distill" if the flow only prompts a teacher.
- Never show pricing that does not match billing APIs.
- Never show Enterprise as self-serve if sales review is required.
- Never list integrations that do not have docs and smoke tests.
- Never use a benchmark number without methodology.
- Never hide limitations below the fold on technical pages.
- Never create one-off pages that do not belong to the core loop.

Copy pattern:

- "Bring X input."
- "Kolm does Y transformation."
- "You get Z artifact/proof."
- "Run it in A/B/C."
- "Verify it with D."

### 5.91 Atomic Launch Readiness Checklist

P0 launch readiness:

- homepage states category in first viewport,
- pricing matches backend,
- docs quickstart works,
- OpenAI wrapper works,
- Anthropic wrapper works,
- capture log works,
- zero-retention mode works,
- dataset promotion works,
- eval/replay works,
- distill dry-run works,
- compile sample works,
- verify sample works offline,
- run sample works locally,
- account UI has no dead primary buttons,
- CLI help and doctor work,
- TUI opens and navigates,
- `/v1/models` reflects maturity,
- `/v1/plans` reflects pricing,
- `/openapi.json` reflects routes,
- screenshots pass,
- static refs pass,
- secret scan passes,
- no corrupted generated docs,
- known limitations are visible.

P1 post-launch:

- public benchmark harness,
- managed GPU compute,
- private registry,
- BYOC wizard,
- MCP/A2A production docs,
- mobile SDK package release,
- Go SDK,
- SSO/SCIM,
- customer-managed keys,
- SIEM export,
- status page.

P2 platform:

- third-party `.kolm` runtime implementations,
- foundation/governance body,
- marketplace,
- hardware vendor partnerships,
- formal certification package,
- verified publisher program.

### 5.92 The Real Competitive Battlefield

The earlier sections list many competitors, but the strategic picture should be
cleaner. Kolm is not competing in one market. It is entering the overlap of
eight markets that already have serious companies with distribution:

1. frontier model APIs,
2. open-model clouds and inference providers,
3. fine-tuning/distillation platforms,
4. AI gateways and routing layers,
5. eval/observability platforms,
6. enterprise work/agent platforms,
7. vertical AI workbenches,
8. model/runtime/edge infrastructure.

The mistake would be to pick one category and say "Kolm is a better version of
that." That undersells the real opportunity and overstates the wrong fights.

The strongest cohesive positioning is:

> Kolm turns AI traffic, evals, and model behavior into signed, portable,
> auditable artifacts that can run across providers, local hardware, cloud
> targets, and enterprise agent platforms.

This means the competitive question is not "who also distills models?" The
competitive question is:

- who owns the traffic before Kolm sees it?
- who owns the eval before Kolm scores it?
- who owns the artifact before Kolm packages it?
- who owns the runtime before Kolm executes it?
- who owns the enterprise evidence before Kolm exports it?
- who owns the user's daily workflow before Kolm becomes habit?

Kolm wins only if it becomes the connective proof layer across those owners.

### 5.93 Main Competitors The Product Must Explicitly Account For

These are the competitors and adjacent platforms that must appear in internal
strategy, product copy, docs, and integration plans. They are not equal. Some
are direct competitors, some are distribution partners, some are existential
platform threats.

#### Frontier And Enterprise Model APIs

Major names:

- OpenAI,
- Anthropic,
- Google Gemini / Vertex / Gemini Enterprise,
- Microsoft Azure OpenAI / Foundry,
- AWS Bedrock,
- Cohere,
- Mistral,
- xAI,
- Perplexity,
- DeepSeek,
- AI21,
- Meta Llama API where exposed through partners.

What they own:

- developer mindshare,
- default model choice,
- fastest access to frontier quality,
- enterprise procurement paths,
- provider-native eval/fine-tune/agent features,
- and direct billing relationship.

Why they are dangerous:

- They can add cheaper smaller models.
- They can add distillation-like features.
- They can add evals and traces.
- They can add local/runtime SDKs.
- They can make Kolm look like an extra layer.

Kolm counterposition:

- do not claim better frontier intelligence;
- claim verified replacement for stable slices of frontier usage;
- support all major model APIs as inputs;
- convert expensive repeated behavior into portable artifacts;
- preserve evidence when the provider changes;
- provide cross-provider receipts that no single provider can neutrally own.

Product consequence:

- provider adapters must be first-class;
- the website must say "works with OpenAI, Anthropic, Gemini, Bedrock, Azure,
  Cohere, Mistral, OpenRouter, local models" only where verified;
- account UI must show provider maturity, not logo soup;
- docs must include OpenAI and Anthropic parity examples because buyers will
  test those first.

#### Open-Model AI Clouds And Inference Providers

Major names:

- Together AI,
- Fireworks AI,
- Groq,
- Cerebras,
- SambaNova,
- Baseten,
- Replicate,
- Modal,
- RunPod,
- Lambda Labs,
- CoreWeave,
- Crusoe,
- Nebius,
- fal,
- Hugging Face Inference Endpoints,
- Anyscale / Ray Serve ecosystem.

What they own:

- no-GPU path,
- hosted inference,
- dedicated endpoints,
- serverless GPU,
- high-throughput deployment,
- model serving expertise,
- and in some cases custom silicon latency.

Why they are dangerous:

- For many users "I need local/distilled/smaller" really means "I need cheaper
  hosted inference."
- Baseten/Replicate/Modal/RunPod can absorb the deployment story.
- Together/Fireworks can absorb the fine-tune plus serve story.
- Groq/Cerebras/SambaNova can make latency the headline and push portability to
  the background.

Kolm counterposition:

- do not compete as a GPU cloud at launch;
- dispatch jobs to these providers;
- make their outputs verifiable and portable;
- compare them empirically;
- let customers leave one provider without losing proof, evals, receipts, and
  artifact history.

Product consequence:

- `ComputeTarget` must include Baseten, Replicate, Modal, RunPod, Lambda,
  Together, Fireworks, SageMaker, Vertex, Azure, local SSH, Docker, and
  Kubernetes as target types over time;
- each target must have readiness checks, budget caps, data movement warnings,
  and artifact hash verification;
- docs should say "Kolm is not your GPU cloud; Kolm is the control/evidence
  plane that makes any GPU cloud usable safely."

#### Fine-Tuning, Distillation, And Model Optimization

Major names:

- Predibase,
- Lamini,
- Arcee,
- OpenPipe,
- Together fine-tuning,
- Fireworks fine-tuning and LoRA deployments,
- OpenAI fine-tuning/distillation,
- Hugging Face AutoTrain,
- Hugging Face TRL/PEFT,
- Unsloth,
- Axolotl,
- LlamaFactory,
- Ludwig,
- torchtune,
- bitsandbytes,
- Optimum,
- LoRAX / multi-LoRA serving systems.

What they own:

- practitioner trust for fine-tuning,
- open-source recipes,
- low-VRAM fine-tune workflows,
- managed adapter lifecycle,
- and academic/research familiarity.

Why they are dangerous:

- ML engineers can assemble their own stack.
- Managed fine-tune providers can hide complexity.
- Open-source recipes move faster than closed product roadmaps.
- If Kolm's output is not transparent, researchers will prefer tools they can
  inspect.

Kolm counterposition:

- do not hide the training stack;
- generate exportable configs for the tools researchers already use;
- make train/eval split, provenance, K-score, receipts, and artifact packaging
  the differentiator;
- turn fine-tune/distill outputs into signed portable `.kolm` artifacts;
- own the proof, not every optimizer.

Product consequence:

- docs need "bring your own Axolotl/Unsloth/TRL output into Kolm";
- CLI needs `kolm train plan --export axolotl`, `--export unsloth`,
  `--export trl`, and import paths where feasible;
- website should not imply Kolm invented fine-tuning;
- technical pages should say Kolm compiles, verifies, packages, and governs the
  result.

#### AI Gateways, Proxies, And Routing Layers

Major names:

- LiteLLM,
- OpenRouter,
- Portkey,
- Helicone,
- Cloudflare AI Gateway,
- Vercel AI Gateway,
- Braintrust AI Proxy,
- Langfuse Gateway patterns,
- provider-native OpenAI-compatible endpoints.

What they own:

- drop-in provider abstraction,
- routing,
- logs,
- rate limits,
- cost tracking,
- prompt management,
- and sometimes caching.

Why they are dangerous:

- Kolm's capture wrapper can look like another gateway.
- Gateways can add evals and caching.
- Users may not understand why they need Kolm after LiteLLM/OpenRouter.

Kolm counterposition:

- gateway is acquisition and data capture, not the category;
- Kolm's unique loop is gateway -> capture -> dataset -> eval -> distill ->
  compile -> verify -> run;
- the gateway should be explicitly compatible with existing gateway stacks,
  not positioned as a mandatory replacement.

Product consequence:

- integration docs: "Kolm behind LiteLLM", "Kolm in front of LiteLLM",
  "Kolm with OpenRouter", "Kolm with Cloudflare AI Gateway";
- API should preserve upstream provider metadata;
- account UI should show "captured via gateway" as first step in a larger loop.

#### Eval, Observability, And AI Quality Platforms

Major names:

- LangSmith,
- Langfuse,
- Braintrust,
- Humanloop,
- Arize Phoenix,
- W&B Weave,
- Galileo,
- Patronus AI,
- Fiddler,
- Arthur,
- TruLens,
- Ragas,
- DeepEval / Confident AI,
- Promptfoo,
- Opik / Comet,
- OpenTelemetry / OpenInference ecosystems.

What they own:

- traces,
- datasets,
- prompt experiments,
- human and LLM judges,
- RAG metrics,
- regression monitoring,
- and production debugging.

Why they are dangerous:

- If they own traces and evals, they own the improvement loop.
- Braintrust/LangSmith/Langfuse can expand into deployment.
- Patronus/Galileo/Fiddler can expand into guardrails and enterprise trust.
- OpenTelemetry/OpenInference can commoditize trace schemas.

Kolm counterposition:

- import their traces;
- export to their observability systems;
- make evals portable and artifact-bound;
- turn a trace/eval result into a verifiable deployable object;
- make each `.kolm` artifact carry or reference the eval evidence that created
  it.

Product consequence:

- `kolm import-traces` should target LangSmith, Langfuse, Braintrust, Phoenix,
  Weave, OpenTelemetry, OpenInference, and Helicone-style logs where APIs allow;
- `kolm export-evals` should produce JSONL/CSV/OpenTelemetry artifacts;
- product copy should say "Kolm does not replace your observability stack; it
  turns observed behavior into verified artifacts."

#### Enterprise Work AI And Knowledge-Agent Platforms

Major names:

- Glean,
- Cohere North,
- Writer AI Studio,
- Dust,
- Microsoft Copilot Studio / Microsoft 365 Copilot,
- Google Gemini Enterprise / Agentspace,
- Salesforce Agentforce,
- ServiceNow AI Agents,
- Atlassian Rovo,
- SAP Joule,
- IBM watsonx Orchestrate,
- Oracle AI Agent Studio / Fusion AI agents where relevant.

What they own:

- enterprise connectors,
- permissions,
- employee-facing agent UX,
- knowledge graph/search,
- daily workflow distribution,
- and procurement relationships.

Why they are dangerous:

- They own the place where enterprise employees will actually use agents.
- They can bundle into existing SaaS seats.
- They can become the default "AI workbench" before Kolm gets a chance to be
  seen.
- They can absorb evals, guardrails, and workflow deployment.

Kolm counterposition:

- do not build another enterprise chat/search app;
- become the verifier, optimizer, distiller, and receipt layer for agent skills
  and repeated workflows inside those platforms;
- provide portable artifact/receipt evidence that outlives any one work AI
  platform.

Product consequence:

- docs need "Kolm for Glean/Copilot/Agentforce/Rovo/Joule-style workflows";
- artifact should support "agent skill" packaging;
- integration strategy should emphasize MCP, A2A, webhook, API, and trace
  import/export rather than UI replacement.

#### Vertical AI Workbenches And Agent Apps

Major names:

- Sierra,
- Decagon,
- Intercom Fin,
- Zendesk AI Agents,
- Harvey,
- Hebbia,
- Cognition Devin,
- Cursor,
- Replit Agent,
- Devin/Codex-style coding agents,
- legal/accounting/finance-specific AI workbenches.

What they own:

- concrete ROI stories,
- vertical workflows,
- customer data,
- user habit,
- and domain-specific UX.

Why they are dangerous:

- They make generic infrastructure feel abstract.
- They can sell outcomes instead of components.
- They create buyer expectations for "AI that does the job," not "AI tooling."
- Their logs become high-value training/eval data.

Kolm counterposition:

- use vertical products as proof of what repeated AI work looks like;
- position Kolm as the infrastructure that lets any vertical product reduce
  cost, prove behavior, run offline, and audit actions;
- build vertical demo scripts, not vertical SaaS clones.

Product consequence:

- support-ticket reduction demo should explicitly compare to Fin/Zendesk/Sierra
  style workflows;
- legal document extraction demo should compare to Harvey/Hebbia expectations:
  citations, source trace, table extraction, multi-document workflows;
- coding-agent demo should show safe tool receipts and rollback rather than
  trying to be a full Devin/Cursor replacement.

#### Low-Code Agent And Workflow Builders

Major names:

- Dify,
- Flowise,
- Langflow,
- n8n,
- Zapier Agents,
- Make,
- Retool AI,
- Pipedream,
- Workato,
- UiPath,
- Microsoft Power Automate / Copilot Studio.

What they own:

- fast prototyping,
- connector breadth,
- workflow builders,
- non-engineer adoption,
- and visual authoring.

Why they are dangerous:

- They absorb "build an AI workflow" demand.
- They make users think orchestration is the product.
- They can call any model and expose many integrations quickly.

Kolm counterposition:

- do not rebuild low-code orchestration;
- verify, harden, compile, and monitor the stable parts of workflows;
- export `.kolm` skills as callable nodes/tools inside these systems;
- provide security review for agent/workflow nodes.

Product consequence:

- "Kolm node for n8n/Dify/Flowise/Zapier" is more valuable than "Kolm visual
  builder";
- integration docs should include workflow import/export and receipt callbacks;
- security docs must call out local process execution, custom code nodes, and
  tool over-permission.

#### RAG, Search, And Knowledge Infrastructure

Major names:

- Glean,
- Pinecone,
- Weaviate,
- Qdrant,
- Milvus/Zilliz,
- Chroma,
- LanceDB,
- pgvector,
- Elasticsearch,
- OpenSearch,
- MongoDB Atlas Vector Search,
- Redis,
- Vespa,
- LlamaIndex,
- LangChain,
- Unstructured,
- LlamaParse,
- Snowflake Cortex Search,
- Databricks Mosaic AI Vector Search.

What they own:

- document ingestion,
- vector indexes,
- connectors,
- RAG application primitives,
- and enterprise search workflows.

Why they are dangerous:

- Many "train a model" requests should be solved with retrieval.
- Glean owns enterprise context.
- Pinecone/Weaviate/Qdrant own developer RAG mindshare.
- LlamaIndex/LangChain own app-building patterns.

Kolm counterposition:

- detect when RAG is better than distillation;
- package RAG configuration, evals, and provenance into artifact sidecars;
- make retrieval decisions auditable;
- compile stable extracted behavior only when documents are stable enough.

Product consequence:

- account UI should recommend "RAG, not train" when documents are volatile;
- `.kolm` manifest should disclose embedded vs external knowledge;
- RAG evals need source/citation correctness, access-control leakage, stale
  document tests, and prompt-injection tests.

#### Governance, Risk, And Compliance Platforms

Major names:

- Credo AI,
- ModelOp,
- IBM watsonx.governance,
- Fiddler,
- Arthur,
- ServiceNow GRC,
- AuditBoard,
- Archer,
- OneTrust,
- Drata/Vanta for adjacent compliance workflows,
- OPA/Sigstore/SLSA/SBOM tooling for technical evidence.

What they own:

- executive AI inventory,
- policy workflows,
- evidence collection,
- regulatory mapping,
- and compliance buyer trust.

Why they are dangerous:

- Enterprise buyers may not want another governance dashboard.
- GRC tools can demand evidence from Kolm rather than yield workflow ownership.
- Formal compliance language is dangerous if Kolm overclaims certification.

Kolm counterposition:

- generate evidence, do not become the entire GRC platform;
- export machine-readable control evidence;
- map artifacts to NIST AI RMF, OWASP LLM Top 10, ISO/IEC 42001, SOC 2, HIPAA,
  GDPR, SLSA/Sigstore;
- integrate with existing GRC tools.

Product consequence:

- every artifact should have a compliance evidence export;
- trust pages must distinguish implemented controls from certified controls;
- API should support evidence export by artifact/workspace/time range.

### 5.94 Competitive Insight: Kolm's Direct Competitor Is "Doing Nothing New"

The most dangerous competitor is not Predibase, LangSmith, Glean, or Baseten.
The most dangerous competitor is the status quo:

- keep paying OpenAI/Anthropic bills,
- add LiteLLM/OpenRouter for routing,
- use Langfuse/LangSmith for traces,
- use Braintrust for evals,
- fine-tune with OpenAI/Together/Predibase when needed,
- deploy with Baseten/Modal/Replicate/RunPod,
- use Glean/Copilot/Agentforce for employee agents,
- and leave everything as disconnected systems.

This stack is messy but understandable. Kolm must justify itself by making the
whole loop obviously better:

- fewer duplicated evals,
- fewer untracked model migrations,
- less provider lock-in,
- lower cost for repeated tasks,
- stronger proof when behavior changes,
- easier local/offline deployment,
- and one artifact that carries the evidence.

The product should sell the pain of disconnected AI work:

- "Your traces are in one tool, evals in another, model outputs in a provider,
  deployments in a GPU cloud, and audit evidence in screenshots."
- "Kolm compiles the loop into a signed artifact and proof bundle."

### 5.95 Competitive Insight: Do Not Fight Workflow Distribution Head-On

Glean, Copilot, Agentforce, Rovo, Joule, ServiceNow, Sierra, Decagon, Intercom,
Zendesk, Harvey, Hebbia, Devin, Cursor, Dify, n8n, and Zapier all own surfaces
where users already work.

Kolm should not try to become the surface for all work. That would make the
product sprawl and lose.

The better wedge:

- Kolm sits behind or beside those surfaces.
- Kolm watches repeated AI/tool behavior.
- Kolm proposes a smaller verified artifact.
- Kolm serves the artifact back into the same workflow.
- Kolm provides receipts, evals, and rollback.

This is the "compiler" analogy in product form. Developers do not live inside a
compiler UI; they use compilers from IDEs, CI systems, package managers, build
tools, and deployment pipelines. Kolm should work the same way.

### 5.96 Competitive Insight: The Artifact Must Become The Procurement Object

Most competitors sell a service:

- model API call,
- hosted endpoint,
- trace dashboard,
- eval run,
- agent workflow,
- knowledge assistant,
- GPU job.

Kolm should sell a durable object:

- a signed `.kolm` artifact,
- a verifier,
- a receipt trail,
- a proof packet,
- a runtime target matrix,
- and a private registry entry.

This changes buyer psychology. The buyer is not buying "another AI platform."
They are buying a way to turn risky, expensive, moving AI behavior into a
portable governed asset.

Product consequence:

- every flow should end in an object:
  - capture receipt,
  - dataset,
  - eval report,
  - compile plan,
  - artifact,
  - verifier result,
  - deployment receipt,
  - rollback receipt.
- account UI should show these objects as the product's spine.
- docs should teach the object model before the route list.

### 5.97 Competitive Insight: The Trust Boundary Is The Moat

OpenAI, Anthropic, Google, AWS, Microsoft, and Cohere can all provide model
quality. Baseten, Modal, RunPod, CoreWeave, Lambda, Groq, Cerebras, SambaNova,
Together, and Fireworks can provide compute or inference. LangSmith, Langfuse,
Braintrust, Patronus, Galileo, Arize, Fiddler, and Weave can provide evals and
observability. Glean, Copilot, Agentforce, ServiceNow, Rovo, Joule, Writer,
Dust, Sierra, Decagon, Intercom, Zendesk, Harvey, and Hebbia can provide user
interfaces and workflows.

Kolm must own the boundary between:

- observed behavior and training data,
- training data and eval data,
- eval data and artifact,
- artifact and runtime,
- runtime and receipt,
- receipt and audit.

That boundary is hard for any one incumbent to own neutrally because each
incumbent benefits from keeping the buyer in its own stack.

### 5.98 Competitive Insight: The Website Should Stop Looking Like A Feature Map

The site should not say:

- gateway,
- capture,
- evals,
- distill,
- compile,
- registry,
- runtime,
- governance,
- cloud,
- devices,
- agents,
- SDKs,
- TUI,
- CLI,
- BYOC,
- privacy.

That is accurate but incoherent.

The site should say:

1. Capture real AI behavior.
2. Prove what behavior is worth keeping.
3. Compile it into a signed `.kolm` artifact.
4. Run it anywhere with receipts.

Everything else is supporting evidence.

Navigation implication:

- Product
  - Capture
  - Evaluate
  - Compile
  - Run
  - Govern
- Solutions
  - Reduce API cost
  - Run AI privately
  - Replace repeated agent skills
  - Audit AI workflows
  - Ship local/edge AI
- Developers
  - Docs
  - CLI
  - API
  - SDKs
  - Spec
- Enterprise
  - Security
  - BYOC
  - Compliance
  - Private registry

### 5.99 Battlecards For Sales, Site Copy, And Product Decisions

#### Against OpenAI / Anthropic / Gemini

Buyer says:

- "Why not just call the best model?"

Answer:

- Use the best model for frontier reasoning. Use Kolm when a slice of behavior
  is repeated, expensive, latency-sensitive, private, or needs audit evidence.
  Kolm can start from those frontier calls and compile the stable behavior into
  a smaller verified artifact.

Proof needed:

- side-by-side replay,
- cost delta,
- latency delta,
- holdout quality,
- receipt.

#### Against Predibase / Together / Fireworks / OpenPipe

Buyer says:

- "Why not just fine-tune?"

Answer:

- Fine-tuning is one step. Kolm captures the right data, proves the split,
  evaluates replacement safety, packages the result, signs it, verifies it, and
  runs it across targets. If those tools are the best training backend, Kolm
  should use or import from them.

Proof needed:

- training backend disclosure,
- artifact verifier,
- eval report,
- runtime target matrix.

#### Against LangSmith / Langfuse / Braintrust

Buyer says:

- "We already have traces and evals."

Answer:

- Keep them. Kolm imports traces and eval evidence, then compiles stable
  behavior into deployable artifacts. Observability tells you what happened;
  Kolm turns what happened into something cheaper, portable, and verifiable.

Proof needed:

- trace import,
- eval import/export,
- artifact linked back to source traces.

#### Against Baseten / Modal / Replicate / RunPod

Buyer says:

- "We can deploy models already."

Answer:

- Use those platforms for compute. Kolm decides what should be deployed,
  produces the artifact, verifies it, records evidence, and can redeploy across
  targets if cost, latency, or policy changes.

Proof needed:

- compute target readiness,
- budget cap,
- artifact hash after deployment,
- rollback receipt.

#### Against Glean / Copilot / Agentforce / ServiceNow / Rovo / Joule

Buyer says:

- "Our employees already use an enterprise AI agent platform."

Answer:

- Kolm should not replace that. Kolm optimizes and verifies repeated agent
  skills, produces receipts, and lets teams run sensitive or stable pieces
  locally, privately, or more cheaply.

Proof needed:

- agent trace import,
- compiled skill,
- MCP/A2A/tool export,
- tool-call receipt.

#### Against Sierra / Decagon / Intercom / Zendesk

Buyer says:

- "We need a customer support agent, not infrastructure."

Answer:

- If you want a full support platform, use one. Kolm is valuable when you need
  to reduce model cost, capture support traffic safely, prove quality, compile
  stable support skills, or keep private workflows under your control.

Proof needed:

- real support ticket replay,
- escalation/failure analysis,
- redaction report,
- artifact replacing high-frequency intents.

#### Against Harvey / Hebbia / Writer / Dust

Buyer says:

- "We need a knowledge-work product."

Answer:

- Those workbenches are excellent surfaces. Kolm should turn repeated
  extraction, review, summarization, and classification behavior from those
  workflows into portable verified artifacts with source-trace receipts.

Proof needed:

- citation/source trace,
- document eval,
- extraction accuracy,
- verifier report.

#### Against Dify / n8n / Flowise / Zapier / Make

Buyer says:

- "We can build the workflow visually."

Answer:

- Keep the visual workflow. Kolm hardens the stable AI steps, gives them
  receipts, evaluates tool behavior, and turns fragile model calls into
  versioned artifacts that can be rolled back.

Proof needed:

- workflow node integration,
- tool policy,
- receipt callback,
- adversarial tool eval.

### 5.100 Missing-Main-Competitor Product Requirements

The product should add explicit support concepts for the competitors above.

#### Provider And Inference Matrix

Add or verify maturity rows for:

- OpenAI,
- Anthropic,
- Gemini,
- Azure OpenAI,
- Bedrock,
- Cohere,
- Mistral,
- OpenRouter,
- Together,
- Fireworks,
- Groq,
- Cerebras,
- SambaNova,
- local OpenAI-compatible endpoints,
- vLLM,
- SGLang,
- Ollama,
- llama.cpp.

Each row must have:

- models listed,
- native API or compatibility API,
- streaming,
- tools,
- JSON/schema,
- multimodal,
- embeddings,
- cost,
- prompt caching,
- capture,
- replay,
- eval,
- distill,
- compile eligibility,
- last live probe.

#### Compute Target Matrix

Add or verify maturity rows for:

- local CPU,
- local CUDA,
- local ROCm,
- Apple MLX/MPS,
- Docker,
- Kubernetes,
- KServe,
- Ray Serve,
- BentoML,
- Baseten,
- Replicate,
- Modal,
- RunPod,
- Lambda,
- CoreWeave,
- Together clusters,
- Fireworks deployments,
- SageMaker,
- Vertex,
- Azure ML/Foundry,
- Cloudflare Workers/R2 where applicable.

Each row must have:

- launch method,
- artifact storage method,
- secret handling,
- budget cap,
- cancellation,
- logs,
- readiness check,
- runtime verification,
- rollback.

#### Trace/Eval Import Matrix

Add or verify maturity rows for:

- LangSmith,
- Langfuse,
- Braintrust,
- Humanloop,
- Phoenix/OpenInference,
- Weave,
- Galileo,
- Patronus,
- Fiddler,
- OpenTelemetry GenAI,
- Helicone,
- Portkey,
- LiteLLM logs,
- Cloudflare AI Gateway logs.

Each row must have:

- import format,
- export format,
- trace id mapping,
- dataset conversion,
- eval result conversion,
- privacy redaction,
- artifact backlink.

#### Agent And Workflow Integration Matrix

Add or verify maturity rows for:

- MCP,
- A2A,
- OpenAI Agents SDK,
- LangGraph,
- CrewAI,
- LlamaIndex,
- Semantic Kernel / Microsoft Agent Framework,
- Glean Agent API,
- Copilot Studio,
- Agentforce,
- ServiceNow,
- Rovo,
- Joule,
- Dify,
- Flowise,
- n8n,
- Zapier,
- Make.

Each row must have:

- import path,
- export path,
- auth model,
- tool permission model,
- trace support,
- receipt support,
- rollback/deactivation.

### 5.101 Cohesive Product Story After Competitive Reality

The product story should now be:

1. Companies are already using many AI systems:
   frontier APIs, enterprise agents, RAG tools, workflow builders, GPU clouds,
   eval dashboards, and local runtimes.
2. That creates fragmented behavior:
   no single artifact, no stable provenance, no portable eval, no runtime
   receipt, and no easy way to move a stable workflow from expensive cloud API
   to cheaper local or dedicated execution.
3. Kolm captures the evidence from those systems.
4. Kolm decides what can become a smaller verified specialist.
5. Kolm compiles that behavior into a signed `.kolm` artifact.
6. Kolm verifies and runs it across local, cloud, edge, and agent/tool
   surfaces.
7. Kolm exports proof back into the systems enterprises already trust.

This story is cohesive because it does not require Kolm to be:

- the best frontier model,
- the biggest GPU cloud,
- the only eval dashboard,
- the enterprise search UI,
- the workflow builder,
- the customer service agent,
- or the vertical legal workbench.

It requires Kolm to be the best evidence-to-artifact compiler.

### 5.102 What The Website Must Say Differently

Homepage headline direction:

- "Compile AI behavior into signed artifacts."
- "Turn expensive AI traffic into portable private specialists."
- "Capture, evaluate, compile, and run AI with receipts."

Subhead:

- "Kolm works with your existing models, agents, gateways, traces, GPU clouds,
  and local runtimes. It finds stable behavior, proves it with evals, packages
  it as a `.kolm` artifact, and runs it anywhere with verifiable receipts."

Product sections:

- Capture from OpenAI, Anthropic, Gemini, Bedrock, gateways, and agents.
- Evaluate with replay, holdout splits, adversarial cases, and imported traces.
- Compile into signed `.kolm` artifacts with manifests, signatures, and
  runtime targets.
- Run on local hardware, hosted compute, BYOC, edge, and agent/tool surfaces.
- Govern with private registry, receipts, audit exports, and policy gates.

Competitor-aware copy:

- Not "replace OpenAI."
  - "Replace stable repeated OpenAI calls when proof says it is safe."
- Not "replace LangSmith."
  - "Turn traces and evals into deployable artifacts."
- Not "replace Glean."
  - "Verify and optimize repeated skills inside enterprise AI work."
- Not "replace Modal/Baseten."
  - "Use compute clouds as targets; keep proof and portability in Kolm."
- Not "replace n8n/Dify."
  - "Harden repeated AI nodes into signed tools."

### 5.103 What The Product UI Must Say Differently

Account overview should not list pages. It should show:

- connected providers,
- captured traffic volume,
- top replacement opportunities,
- eval readiness,
- active compile jobs,
- artifacts ready to run,
- projected savings,
- blocked proof gates,
- integrations connected,
- proof binder status.

Every recommendation should be framed as:

- "We found a repeated behavior."
- "Here is the evidence."
- "Here is the cheaper/private/local target."
- "Here is the risk."
- "Here is the proof gate before promotion."

The model matrix should say:

- callable,
- capturable,
- replayable,
- distillable,
- compilable,
- runtime verified,
- field verified.

The compute matrix should say:

- local viable,
- remote required,
- estimated cost,
- data movement,
- privacy impact,
- readiness status.

The artifact page should be the center of the UI:

- what behavior it replaces,
- where the examples came from,
- how it scored,
- where it runs,
- who signed it,
- what receipts exist,
- what changed from previous version,
- what can roll back.

### 5.104 Main Competitor Research Backlog Still Worth Adding

Keep these on the live research radar:

- Glean's Agent API and AWARE security framework.
- Cohere North deployment modes, especially VPC/on-prem patterns.
- Writer AI Studio's agent builder and Python app framework.
- Dust enterprise agent deployment and permission model.
- Sierra's Agent OS and supervisor-agent posture.
- Decagon's customer support agent control/visibility model.
- Intercom Fin and Zendesk AI agent pay-per-resolution / automation lessons.
- Harvey's legal workflow agents and model disclosure posture.
- Hebbia Matrix's spreadsheet-like traceable workbench.
- Cognition Devin and Cursor's agent safety/rollback lessons.
- Groq/Cerebras/SambaNova latency and model-coverage tradeoffs.
- Baseten/Replicate/Modal/RunPod/Lambda reliability, cold start, and cost
  patterns.
- Patronus/Galileo/Fiddler/Arthur guardrail and monitoring metrics.
- Credo/ModelOp/IBM watsonx.governance evidence schemas.
- Dify/Flowise/n8n security lessons around arbitrary code/tool execution.

The point is not to clone any of these. The point is to know exactly what buyer
expectation each one creates.

### 5.105 Final Competitive Thesis

If Kolm tries to be:

- a better OpenAI,
- a cheaper GPU cloud,
- a nicer eval dashboard,
- a new workflow builder,
- a new enterprise search UI,
- or a generic agent platform,

it loses to companies with stronger distribution.

If Kolm becomes:

- the capture layer for AI behavior,
- the proof layer for evals,
- the compiler for stable AI work,
- the artifact standard for portable private specialists,
- the verifier for runtime receipts,
- and the registry for governed AI artifacts,

then it can sit underneath all of those markets and compound.

The $1B path is a product that saves money and proves behavior for repeated AI
work.

The $10B path is `.kolm` becoming the artifact and receipt format that other
platforms support because enterprise buyers demand portable proof.

### 5.106 The Missing Enterprise AI Operating-System Competitors

The prior competitive map still underweights the biggest strategic threat:
enterprise AI operating systems. These companies do not merely offer models,
gateways, evals, or agents. They sell an enterprise-wide control plane that
connects data, applications, identity, governance, deployment, and operational
workflows.

The main competitors in this layer:

- Palantir AIP / Foundry / Apollo,
- Databricks Mosaic AI / MLflow / Unity Catalog,
- Snowflake Cortex / Cortex Agents / Cortex Analyst / Cortex Search,
- Dataiku LLM Mesh,
- DataRobot GenAI and AI Platform,
- C3 Agentic AI Platform,
- H2O.ai Enterprise h2oGPTe,
- TrueFoundry LLMOps,
- IBM watsonx,
- Azure AI Foundry,
- Google Gemini Enterprise / Vertex lineage,
- AWS Bedrock / SageMaker,
- NVIDIA AI Enterprise / NIM / NeMo.

Why this layer matters:

- These platforms already sit where enterprise data lives.
- They already have identity, governance, audit, and procurement paths.
- They are already allowed inside regulated environments.
- They can frame Kolm as a feature, not a company.
- They can own the end-to-end loop from data to agent to deployment.

Kolm must therefore avoid looking like "another AI platform." The strategic
position should be narrower and sharper:

> Kolm is the portable proof and artifact layer across enterprise AI operating
> systems.

#### Palantir AIP

What Palantir owns:

- ontology-centered enterprise data model,
- operational workflows,
- agent/action orchestration,
- secure LLM integration,
- observability/evals,
- deployment through Apollo,
- deep government/defense/industrial credibility.

Why it is dangerous:

- Palantir sells the exact executive story Kolm wants: AI connected to
  operational reality with governance.
- AIP can make "compile an AI workflow into an operational app" feel native.
- Palantir buyers are not shopping for a small tool; they are buying an
  operating model.

Kolm wedge:

- become the artifact format that can move a verified specialist between AIP
  and non-AIP environments;
- export receipts/evals into AIP-style operational evidence;
- support on-prem/air-gap runtime with simpler adoption than a full Palantir
  deployment;
- win developers who need portable artifacts without buying the whole
  ontology/platform stack.

Product consequence:

- create `kolm export evidence --format ontology-neutral`;
- create docs for "Kolm with Palantir-style operational AI";
- avoid claiming to replace enterprise ontology/workflow systems;
- claim to verify and package stable AI behavior they produce.

#### Databricks Mosaic AI

What Databricks owns:

- lakehouse data gravity,
- MLflow experiment/eval/trace infrastructure,
- Unity Catalog governance,
- Vector Search,
- Agent Framework,
- model serving,
- enterprise ML teams.

Why it is dangerous:

- Databricks can make the AI lifecycle native to the data platform.
- MLflow can become the default record of experiments, traces, and evals.
- Unity Catalog can become the governance layer for models and artifacts.

Kolm wedge:

- import MLflow/Databricks traces and evals;
- package Databricks-trained or served behavior as `.kolm`;
- provide a runtime-verifiable artifact outside the lakehouse;
- make local/edge/private deployment easier than Databricks-native serving.

Product consequence:

- `kolm import mlflow`;
- `kolm export mlflow-eval`;
- Databricks/MLflow lineage fields in `.kolm` manifest;
- compatibility docs for Mosaic AI Vector Search and Agent Framework.

#### Snowflake Cortex

What Snowflake owns:

- warehouse-native structured data,
- Cortex Analyst for text-to-SQL,
- Cortex Search for unstructured retrieval,
- Cortex Agents for tool routing over structured/unstructured data,
- enterprise security around data access.

Why it is dangerous:

- For data-heavy enterprise questions, the natural place to run AI is inside
  Snowflake.
- Cortex can own SQL-grounded agent workflows.
- Snowflake can make data movement out to Kolm look risky.

Kolm wedge:

- do not move raw data unless needed;
- capture/evaluate Snowflake agent outputs;
- compile stable SQL/extraction/classification behaviors into artifacts;
- use receipts to prove which warehouse data/tool calls informed an answer.

Product consequence:

- Snowflake connector should support query/result hashing, not only raw export;
- artifact lineage should reference semantic views/tables without embedding
  sensitive rows by default;
- docs should include "Kolm for Snowflake Cortex replay and verified
  replacement."

#### Dataiku LLM Mesh

What Dataiku owns:

- governed LLM gateway,
- multi-model strategy,
- cost/performance routing,
- safety/moderation,
- enterprise data science workbench,
- business-user plus data-team collaboration.

Why it is dangerous:

- LLM Mesh sounds like a control plane for exactly the gateway/governance part
  of Kolm.
- Dataiku buyers already trust it for enterprise analytics workflows.

Kolm wedge:

- Dataiku routes and governs calls; Kolm turns stable call behavior into
  signed artifacts;
- Kolm can import Dataiku usage/eval outputs where APIs allow;
- Kolm can provide runtime portability outside Dataiku's app environment.

Product consequence:

- positioning: "Kolm after the mesh";
- docs: "capture from existing LLM gateway logs";
- product: gateway import formats must be as important as live proxying.

#### DataRobot, C3 AI, H2O.ai

What they own:

- enterprise AI lifecycle language,
- GUI plus code deployment,
- model governance,
- monitoring,
- predictive and generative AI crossover,
- industry-specific enterprise apps.

Why they are dangerous:

- They make Kolm's "finished enterprise stack" look incomplete if Kolm lacks
  governance and monitoring polish.
- They have mature enterprise sales motions and compliance language.

Kolm wedge:

- do not compete on generic enterprise AI suite breadth;
- compete on verified portable AI artifacts;
- export evidence into governance tools;
- make local/offline/on-device execution a real differentiator.

Product consequence:

- the trust/compliance pages need control mappings and evidence exports, not
  vague copy;
- the account UI needs artifact-centered governance, not generic model cards;
- enterprise docs must distinguish Kolm from end-to-end AI suites.

### 5.107 The Missing Data Development And Labeling Competitors

The previous document talks about capture, labels, datasets, and synthetic data
but underweights the companies that already own data quality and human feedback.

Main competitors:

- Scale AI,
- Labelbox,
- Snorkel AI,
- Gretel,
- Tonic.ai,
- Mostly AI,
- Humanloop/Braintrust as eval-data systems,
- Surge AI / Invisible / Toloka style human data operations,
- Hugging Face Datasets.

What they own:

- data labeling operations,
- human review workflows,
- model evaluation datasets,
- data curation,
- synthetic data,
- privacy-preserving data generation,
- human preference feedback,
- and enterprise data quality processes.

Why this is dangerous:

- Kolm's capture lake is only valuable if it produces high-quality training and
  eval data.
- Scale/Labelbox/Snorkel can say "bring your model, we will improve the data."
- Gretel can say "we will generate safe synthetic data."
- Hugging Face Datasets owns open dataset distribution.

Kolm counterposition:

- Kolm should not become a full labeling BPO.
- Kolm should make captured AI traffic labelable, deduplicated, privacy-scanned,
  split-safe, and artifact-bound.
- Kolm should integrate human review providers and export/import datasets.
- Kolm should treat synthetic data as provenance-tagged, never equal to real
  held-out eval data.

Product consequence:

- `DatasetRow.source_type` must always distinguish captured, synthetic, human,
  imported, generated, and holdout-only rows.
- Synthetic rows must never silently enter holdout.
- Label queues need reviewer identity, instructions, disagreement, and audit
  history.
- Dataset exports should support JSONL, Hugging Face Datasets, Labelbox-style
  annotations, Snorkel-style weak labels, and evaluation factsheets.
- UI should show "data health" before "train now."

The key insight:

> Kolm's moat is not data volume. It is data provenance bound to deployable
> artifacts.

### 5.108 The Missing AI Security Competitors

The security market is becoming a real category, not a feature. Kolm must be
clear where it competes and where it integrates.

Main competitors:

- Lakera Guard,
- Protect AI / ModelScan / LLM Guard,
- Giskard,
- NVIDIA NeMo Guardrails,
- Bedrock Guardrails,
- Azure AI Content Safety,
- Fiddler Protect,
- Patronus guardrail/evaluator models,
- Promptfoo red teaming,
- Garak,
- HiddenLayer,
- Robust Intelligence / Cisco AI Defense,
- CalypsoAI,
- Cranium,
- OPA for policy,
- Sigstore/SLSA/SBOM tools for supply chain.

What they own:

- prompt injection detection,
- jailbreak detection,
- PII leakage prevention,
- content safety,
- model scanning,
- red teaming,
- AI firewall language,
- policy enforcement,
- vulnerability scanning,
- security buyer trust.

Why this is dangerous:

- If Kolm ships artifacts without strong scanning, security teams will block it.
- If Kolm claims trust without red-team and model-supply-chain evidence, it will
  look naive.
- AI security vendors can own the "safe agent/tool boundary" before Kolm does.

Kolm counterposition:

- Kolm should not claim to be the universal AI firewall.
- Kolm should scan artifacts, manifests, model payloads, tool permissions, and
  receipts.
- Kolm should integrate with Lakera/NeMo/Giskard/Protect AI style checks.
- Kolm should make security findings part of artifact verification and
  promotion gates.

Product consequence:

- artifact verification must include security policy checks, not only
  cryptographic signature checks;
- MCP/A2A/tool exports require permission manifests;
- model payloads need serialization scan state;
- RAG sidecars need prompt-injection scan state;
- receipts need policy-decision fields;
- docs must include an AI threat model mapped to OWASP LLM Top 10 and agentic
  threats.

The key insight:

> Cryptographic trust says the artifact is unchanged. Security trust says the
> artifact is safe enough to run. Kolm needs both.

### 5.109 The Missing Developer Framework Competitors

Kolm also competes indirectly with developer frameworks that become the place
where teams define behavior.

Main competitors:

- LangGraph,
- LlamaIndex,
- Haystack,
- CrewAI,
- Microsoft Semantic Kernel / Microsoft Agent Framework,
- AutoGen,
- OpenAI Agents SDK,
- Vercel AI SDK,
- Pydantic AI,
- Pydantic Logfire,
- DSPy,
- Instructor / Outlines for structured generation,
- Promptfoo,
- Langflow,
- Flowise,
- Dify.

What they own:

- agent graphs,
- tool definitions,
- structured outputs,
- RAG pipelines,
- app code,
- developer habit,
- local iteration,
- and often the "source of truth" for AI behavior.

Why this is dangerous:

- If the agent graph is the source artifact, `.kolm` can look redundant.
- Frameworks can add evals, tracing, deployment, and registries.
- Developers prefer tools that fit their codebase over separate platforms.

Kolm counterposition:

- Kolm should compile from framework definitions instead of replacing them.
- Kolm should make behavior portable across framework and runtime boundaries.
- Kolm should generate receipts that frameworks do not standardize.

Product consequence:

- importers for LangGraph, LlamaIndex, Haystack, CrewAI, Semantic Kernel,
  OpenAI Agents SDK, Vercel AI SDK, and Pydantic AI specs where feasible;
- `kolm compile --from langgraph`, `--from pydantic-ai`, `--from openai-agent`
  should be long-term targets;
- docs should include "Kolm does not replace your framework; it freezes and
  verifies the stable behavior."

The key insight:

> Frameworks define behavior. Kolm should make behavior portable, verifiable,
> and cheaper to run.

### 5.110 The Missing Edge And On-Device Competitors

Kolm's local/on-device claim must account for companies that already own edge
deployment.

Main competitors and standards:

- Apple Foundation Models framework,
- Apple Core ML,
- Apple MLX,
- Google LiteRT / AI Edge,
- Qualcomm AI Hub,
- Qualcomm AI Engine Direct / QNN,
- ONNX Runtime Mobile,
- ExecuTorch,
- NVIDIA Jetson / TensorRT / TensorRT-LLM,
- Edge Impulse,
- Arm Ethos / CMSIS-NN ecosystem,
- WebGPU/WebNN/browser inference,
- MLC/WebLLM,
- llama.cpp/Ollama/LM Studio for local developer runtime.

What they own:

- hardware-specific optimization,
- mobile/edge developer paths,
- model conversion,
- physical device benchmarking,
- runtime packaging,
- and battery/latency/memory constraints.

Why this is dangerous:

- "Run locally" is not credible unless target-specific.
- Apple/Google/Qualcomm can make on-device models native OS primitives.
- Edge Impulse/Qualcomm AI Hub can make hardware-aware compilation look like
  their lane.

Kolm counterposition:

- Kolm should not be the lowest-level compiler for every chip.
- Kolm should package the task, evidence, and runtime target metadata, then
  invoke or integrate with hardware-specific toolchains.
- Kolm should report target maturity honestly: converted, loads, runs smoke,
  eval verified, performance profiled, field verified.

Product consequence:

- device matrix must include RAM, accelerator, OS, runtime, model format,
  quantization, expected latency, and proof report;
- runtime verifier must produce target-specific receipts;
- docs should separate "exported for CoreML/QNN/OpenVINO" from "verified on
  device";
- website must avoid generic "runs anywhere" claims unless maturity is visible.

The key insight:

> On-device is not one runtime. It is a target matrix plus proof.

### 5.111 The Missing MLOps And Deployment Competitors

Kolm's cloud product and enterprise product must account for the MLOps stacks
that already own deployment and governance.

Main competitors:

- MLflow,
- Kubeflow,
- KServe,
- Ray Serve,
- BentoML / BentoCloud,
- TrueFoundry,
- Anyscale,
- Modal,
- Baseten,
- SageMaker,
- Vertex AI,
- Azure ML / Foundry,
- Domino Data Lab,
- DataRobot,
- C3 AI,
- H2O.ai,
- Kaito,
- NVIDIA NIM / NeMo.

What they own:

- model registry,
- training jobs,
- batch inference,
- model serving,
- autoscaling,
- Kubernetes deployment,
- GPU scheduling,
- monitoring,
- governance,
- and enterprise operational muscle.

Why this is dangerous:

- If Kolm tries to become full MLOps, it will fight mature platforms.
- Enterprise teams already have deployment paths.
- Model serving is hard and capital-intensive.

Kolm counterposition:

- Kolm should be deployment-target agnostic.
- Kolm should produce the artifact, proof, target spec, and readiness check.
- Deployment platforms execute; Kolm verifies and records.

Product consequence:

- first-class deployment adapters for KServe, Ray Serve, BentoML, TrueFoundry,
  Modal, Baseten, RunPod, SageMaker, Vertex, Azure;
- deployment receipts must include target, artifact hash, runtime version,
  policy, rollback, and live probe;
- `kolm deploy` should be declarative and reversible.

The key insight:

> Kolm should not own all compute. Kolm should own compute-independent proof.

### 5.112 The Macro Market Map Kolm Should Use Internally

Kolm should maintain this map as the strategic source of truth:

| Layer | Buyer default | Main competitors | Kolm role |
|---|---|---|---|
| Frontier intelligence | call best model | OpenAI, Anthropic, Gemini, Bedrock, Azure, Cohere, Mistral | capture expensive behavior and replace stable slices |
| Enterprise AI OS | buy operating platform | Palantir AIP, Databricks, Snowflake, Dataiku, DataRobot, C3, H2O, IBM | portable artifact/proof layer across platforms |
| Data development | improve data | Scale, Labelbox, Snorkel, Gretel, Hugging Face Datasets | provenance-bound data-to-artifact loop |
| Fine-tuning | train/adapt model | Predibase, Together, Fireworks, Lamini, Arcee, OpenPipe, Unsloth, Axolotl | evidence, split proof, artifact packaging |
| Inference/cloud GPU | deploy model | Baseten, Modal, Replicate, RunPod, Lambda, CoreWeave, Groq, Cerebras | target-agnostic deploy proof and portability |
| Gateway/routing | abstract providers | LiteLLM, OpenRouter, Portkey, Helicone, Cloudflare, Vercel, Dataiku | gateway as capture, not final product |
| Evals/observability | monitor quality | LangSmith, Langfuse, Braintrust, Phoenix, Weave, Galileo, Patronus, Fiddler | turn evals/traces into artifacts |
| Agent frameworks | define behavior in code | LangGraph, LlamaIndex, Haystack, CrewAI, Semantic Kernel, OpenAI Agents, Pydantic AI, Vercel AI SDK | compile framework behavior into verified units |
| Work AI surfaces | employees use agents | Glean, Copilot, Agentforce, Rovo, Joule, ServiceNow, Writer, Dust | optimize and verify repeated skills |
| Vertical agents | buy outcome | Sierra, Decagon, Intercom, Zendesk, Harvey, Hebbia, Devin, Cursor | compile repeated vertical behaviors and receipts |
| RAG/search | retrieve knowledge | Glean, Pinecone, Weaviate, Qdrant, Milvus, Elastic, Snowflake, Databricks | package RAG provenance/evals; recommend RAG vs train |
| Security | block AI risk | Lakera, Protect AI, Giskard, NeMo, Bedrock Guardrails, Azure Safety, OPA | artifact security gates and policy receipts |
| Governance | prove compliance | Credo, ModelOp, IBM watsonx.governance, ServiceNow GRC, AuditBoard, Archer | evidence generation/export |
| Edge/on-device | optimize for hardware | Apple, Google LiteRT, Qualcomm AI Hub, Edge Impulse, ONNX, ExecuTorch | target matrix and verified runtime receipts |

This is the cohesive answer to "what market is Kolm in":

> Kolm is in the AI evidence-to-artifact market, spanning model behavior,
> data provenance, eval proof, runtime portability, and enterprise governance.

### 5.113 The Non-Obvious Strategic Insight

Most AI infrastructure companies are trying to own one of three things:

1. intelligence,
2. compute,
3. workflow.

Kolm should own a fourth thing:

4. proof.

Proof is weaker as a standalone dashboard, but powerful when bound to an
artifact. That is the reason `.kolm` matters. Without an artifact, proof is a
report. With an artifact, proof becomes a deployable control point.

This yields the core strategy:

- Let OpenAI/Anthropic/Google own frontier intelligence.
- Let Databricks/Snowflake/Palantir own enterprise data gravity.
- Let Baseten/Modal/RunPod/CoreWeave own compute.
- Let LangGraph/LlamaIndex/Pydantic AI own app behavior definitions.
- Let Glean/Copilot/Agentforce/Sierra/Harvey own user-facing workflows.
- Let Lakera/Protect AI/Giskard own specialized security scanning.
- Let Credo/ModelOp/GRC tools own executive governance.
- Kolm owns the portable proof object that crosses them.

The product should therefore be designed so that every integration increases
artifact value:

- provider integration gives behavior,
- trace integration gives evidence,
- data integration gives examples,
- eval integration gives proof,
- training integration gives candidate behavior,
- runtime integration gives portability,
- security integration gives promotion gates,
- governance integration gives enterprise adoption.

### 5.114 What This Means For Product Prioritization

The research implies a different priority order than a generic platform build.

#### P0: Proof-Bound Artifact Core

Build deepest:

- `.kolm` spec,
- manifest,
- recipe,
- lineage,
- eval bundle,
- signatures,
- verifier,
- receipts,
- artifact diff,
- runtime target matrix.

Reason:

- This is the only layer not already owned by a larger platform.

#### P0: Provider And Trace Capture

Build deep enough:

- OpenAI,
- Anthropic,
- Gemini,
- Bedrock/Azure/OpenRouter where feasible,
- LangSmith/Langfuse/Braintrust/OpenTelemetry trace import,
- zero-retention and redaction.

Reason:

- No evidence enters Kolm without traffic and traces.

#### P1: Training/Distillation As Orchestration

Integrate and expose:

- Unsloth/Axolotl/TRL export/import,
- Together/Fireworks/Predibase/OpenAI fine-tune import,
- hosted compute targets,
- train/holdout integrity.

Reason:

- Kolm should not pretend it invented training. It should make training outputs
  governable and portable.

#### P1: Enterprise And Governance Export

Build:

- evidence export,
- policy mapping,
- audit package,
- private registry,
- tenant isolation,
- key scopes.

Reason:

- This is how Kolm survives enterprise security review.

#### P2: Broad Workbench UI

Defer or compress:

- full workflow builder,
- enterprise search UI,
- vertical apps,
- marketplace,
- visual agent IDE.

Reason:

- Those markets are crowded and distribution-heavy.

### 5.115 Product Copy After The Missing Competitor Pass

The copy should explicitly avoid competing with the wrong defaults.

Bad:

- "One platform for all AI."
- "Use any model for anything."
- "Train and deploy AI everywhere."
- "Enterprise AI operating system."

Better:

- "Compile proven AI behavior into signed artifacts."
- "Turn traces, evals, and model calls into portable specialists."
- "Run stable AI work locally, in cloud, or inside agent tools with receipts."
- "Keep your models, gateways, GPU clouds, and agent platforms. Kolm gives them
  a portable proof layer."

Sharpest version:

> Kolm is the evidence-to-artifact compiler for production AI.

Supporting line:

> Capture AI behavior from your existing stack, prove what is safe to replace,
> compile it into a signed `.kolm` artifact, and run it anywhere with receipts.

This is more cohesive than a feature list and more defensible against the real
competitor set.

### 5.116 What To Add To The Website IA After This Pass

The website needs one "Ecosystem" page or section, not scattered integration
mentions.

Recommended structure:

- Works with your model providers:
  OpenAI, Anthropic, Gemini, Azure, Bedrock, OpenRouter, local OpenAI-compatible.
- Works with your traces and evals:
  LangSmith, Langfuse, Braintrust, OpenTelemetry, Phoenix, Weave.
- Works with your training stack:
  OpenAI fine-tuning, Together, Fireworks, Predibase, Unsloth, Axolotl, TRL.
- Works with your compute:
  local GPU, Docker, Kubernetes, Modal, RunPod, Baseten, Replicate, SageMaker,
  Vertex, Azure.
- Works with your agent tools:
  MCP, A2A, OpenAI Agents SDK, LangGraph, LlamaIndex, CrewAI, Semantic Kernel,
  Pydantic AI.
- Works with your enterprise systems:
  Databricks, Snowflake, Dataiku, Palantir-style operational platforms, GRC
  exports.

But every logo must carry a maturity badge:

- planned,
- docs,
- import,
- export,
- smoke-tested,
- production-supported.

This lets the site look serious instead of inflated.

### 5.117 What To Add To The Product Matrix

The product matrix should now include these axes:

- provider maturity,
- trace/eval import maturity,
- train/fine-tune backend maturity,
- compute target maturity,
- artifact runtime maturity,
- security scanner maturity,
- governance export maturity,
- edge target maturity,
- agent framework maturity,
- enterprise data platform maturity.

Each matrix row should have:

- owner,
- docs URL,
- smoke command,
- last verified date,
- supported auth,
- supported data movement mode,
- proof artifact,
- known gaps.

This turns "we support everything" into a credible operating system.

### 5.118 Investor Insight After The Missing Competitor Pass

The investor story should not be "AI compiler plus local models." That sounds
small and easy to copy.

The story should be:

- Enterprises are adopting many AI platforms at once.
- The result is fragmentation of traces, evals, artifacts, deployments, and
  audit evidence.
- Kolm creates a portable evidence object that can move across this fragmented
  stack.
- The more fragmented the AI market becomes, the more valuable a neutral
  evidence-to-artifact layer becomes.

Comparable mental models:

- Docker image for application packaging,
- OCI registry for distribution,
- Sigstore/SLSA for provenance,
- MLflow for experiment lineage,
- OpenTelemetry for observability,
- but specialized for AI behavior and runtime receipts.

The valuation wedge is not the first compiler implementation. The valuation
wedge is if `.kolm` becomes a format that other platforms can verify.

### 5.119 The Competitive Red-Team Question

A serious buyer or investor will ask:

> Why won't Databricks, Palantir, Snowflake, OpenAI, or Cloudflare just build
> this?

Answer:

- They can build parts of it.
- They cannot credibly be neutral across all competing providers, data clouds,
  GPU clouds, agent frameworks, and enterprise work platforms.
- Their incentive is to keep the artifact inside their platform.
- Kolm's incentive is portability.

This answer is only credible if:

- `.kolm` spec is public,
- verifier is open or at least standalone,
- runtime is open enough for third-party trust,
- import/export is real,
- and Kolm does not over-centralize the control plane.

If Kolm keeps the format opaque, the "neutral portability" story collapses.

### 5.120 Final Cohesive Product Definition

After adding the missing competitors, Kolm should be defined as:

> A production AI compiler that captures behavior from existing AI systems,
> turns it into provenance-safe datasets and evals, compiles stable behavior
> into signed `.kolm` artifacts, and verifies those artifacts across local,
> cloud, edge, and agent runtimes.

Short version:

> Evidence-to-artifact compiler for production AI.

Everything else is a surface:

- gateway = evidence intake,
- lake = evidence storage,
- labels = evidence improvement,
- evals = evidence scoring,
- distillation = behavior compression,
- compile = artifact creation,
- verify = trust boundary,
- runtime = deployment,
- registry = governance,
- receipts = audit.

This is the cohesive product spine. If a feature cannot map to this spine, it
should be cut, hidden, or integrated instead of foregrounded.

## 6. Per-Product-Line Infrastructure Blueprints

### 6.1 `identity-access-billing`

Product goal:

Let a buyer authenticate, create or join an org, manage keys, invite teammates,
control access, pay, track usage, and prove entitlement state without support.

Competitors:

- WorkOS for SSO, SCIM, Admin Portal, audit, authz, Vault.
- Auth0 Organizations for org-scoped B2B login.
- Okta and Azure AD for enterprise identity buyer expectations.
- Stripe Billing for subscriptions, usage, invoices, portal, entitlements.
- Clerk, Stytch, Supabase Auth for developer-first login patterns.

Best-in-class design:

- Separate `org`, `workspace`, `tenant`, `user`, `service_account`, `api_key`,
  and `billing_customer`.
- API keys are scoped, hash-stored, rotatable, last-used tracked, and
  environment-tagged.
- Entitlements are stored in Kolm and reconciled from Stripe, not merely
  inferred from checkout state.
- Usage ledger is append-only and can reconcile token, event, compile,
  storage, and compute usage.
- Admin changes produce audit events.
- Enterprise identity adapters are optional, not baked into core identity.

Tactical build choices:

- Create a canonical entitlement object:
  `plan`, `features`, `quotas`, `usage`, `overage_policy`, `billing_source`,
  `effective_at`, `expires_at`, `reconciliation_state`.
- Add key scopes:
  `gateway:write`, `capture:read`, `artifact:publish`, `billing:admin`,
  `compute:run`, `registry:pull`, `audit:read`.
- Add workspace-level provider credentials with BYOK/Vault references.
- Add billing explainability:
  per namespace, provider, model, artifact, compute job, storage object.
- Add dunning and graceful degradation:
  read-only access, no new hosted compute, artifact verify remains available.

Launch scope:

- signup/signin
- account
- API keys
- billing tiers
- usage
- teams
- quota

Next scope:

- Stripe portal
- SSO/SCIM
- scoped service accounts
- key rotation reminders
- usage alerts
- admin audit view

Strategic scope:

- WorkOS/Auth0-class enterprise onboarding
- customer-managed key vault
- contract billing
- legal entity hierarchy
- compliance evidence linked to entitlements

Proof gates:

- No authenticated route without tenant fence.
- No API key stored raw.
- Entitlements reconcile with billing webhooks.
- Billing UI agrees with `/v1/plans` and `/v1/billing/tiers`.
- Audit log captures key/plan/org changes.

### 6.2 `public-docs-sdk`

Product goal:

Make public pages, docs, APIs, SDKs, and onboarding credible enough that a
serious engineer can adopt without talking to sales.

Competitors:

- Stripe docs for clarity, API consistency, examples.
- Vercel docs for deploy-first DX.
- OpenAI/Anthropic docs for provider API conventions.
- Cloudflare docs for infrastructure breadth.
- Hugging Face docs for model/distribution ecosystem.
- Supabase docs for app substrate ergonomics.

Best-in-class design:

- Docs generated from route inventory and OpenAPI.
- Every public claim has an evidence link.
- Every SDK has install, auth, request, error, streaming, and retry examples.
- Every product path has local and hosted examples.
- Docs expose honest readiness state instead of burying missing config.
- SEO pages do not create fake product surface bloat.

Tactical build choices:

- Add "evidence badges" per docs page:
  shipped, implemented, requires env, requires external certification,
  requires benchmark, package unreleased.
- Add every example in four modes:
  CLI, curl/API, Node/Python SDK, account UI path.
- Add a route-to-doc coverage table.
- Add docs dead-claim lint:
  every named endpoint must exist; every named plan must match billing tiers;
  every "production-ready" claim must cite a gate.
- Add "copy-paste first run" recipes for:
  OpenAI capture, Claude capture, compile local, verify artifact, cloud
  readiness, no-GPU distill, MCP export.

Launch scope:

- stable homepage/pricing/docs
- OpenAPI current
- connector docs
- CLI docs
- SDK current manifest
- account docs

Next scope:

- SDK docs for TS/Python/Go/Rust/Swift/Kotlin/RN
- public spec
- benchmark methodology
- compliance mappings
- deploy guides

Strategic scope:

- docs as a machine-readable product contract
- self-updating examples from smoke tests
- developer education around private AI artifact design

Proof gates:

- route/doc sync
- all static links pass
- screenshots pass in dark/light/mobile/desktop
- examples run against fixture mode
- docs show no stale pricing or unsupported provider claim

### 6.3 `compile-artifact-verification`

Product goal:

Turn repeated AI work into a portable signed artifact that can be verified
offline and run across target environments.

Competitors and standards:

- Docker/OCI for artifact distribution mental model.
- ONNX for cross-runtime model exchange.
- GGUF for local model packaging.
- safetensors for safe tensor serialization.
- Sigstore/Cosign for signing and transparency.
- in-toto/SLSA for provenance and attestation.
- MLflow/Hugging Face Hub for model registry/version metadata.

Best-in-class design:

- `.kolm` is a deterministic ZIP with a normative spec.
- Runtime targets are explicit members/manifest entries.
- Every artifact contains or references eval evidence.
- Verifier is standalone and offline.
- Registry metadata is additive, never required for offline trust.
- Failure states are more important than happy path:
  invalid signature, bad hash, schema drift, missing evals, train/eval overlap,
  unsupported runtime, expired signer, revoked dependency.

Tactical build choices:

- Add `kolm verify --strict --offline --policy policy.json`.
- Add `kolm diff a.kolm b.kolm` with semantic diff:
  prompt/recipe, model, dataset, evals, K-score axes, policy, target runtime.
- Add `kolm inspect --graph` for dependency graph.
- Add `kolm attest` for Sigstore/in-toto bundles.
- Add `kolm migrate --from v1 --to v2 --dry-run` once v2 exists.
- Add reference verifier packages:
  Rust single binary first; JS/Python wrappers second.

Launch scope:

- deterministic assembly
- manifest/receipt/eval rows
- signature and offline verification
- production-ready gate
- train/eval fail-closed

Next scope:

- public RFC-style spec
- standalone verifier release
- registry countersign
- dependency graph
- artifact diff
- SBOM/ML-BOM

Strategic scope:

- neutral foundation or standards process
- third-party implementation suite
- compliance-recognized artifact evidence

Proof gates:

- byte hash stable for deterministic inputs
- verifier rejects tampering
- verifier rejects overlap
- artifact runs without hosted control plane
- public spec matches implementation

### 6.4 `runtime-inference-connectors`

Product goal:

Let developers call OpenAI, Claude, OpenRouter, Gemini, local engines, and
compiled artifacts through one governed runtime surface while preserving each
provider's real capabilities.

Competitors:

- OpenRouter, LiteLLM, Portkey, Helicone, Cloudflare AI Gateway, Vercel AI
  Gateway.
- vLLM, SGLang, llama.cpp, Ollama, TGI, TensorRT-LLM.
- OpenAI Responses/Chat, Anthropic Messages, Gemini OpenAI shim.

Best-in-class design:

- Native shapes where needed, compatibility shapes where useful.
- Provider adapters expose capability flags.
- The router knows not all OpenAI-compatible endpoints are equivalent.
- Fallback chains are policy-bound and audited.
- Streaming is normalized but does not hide provider-specific semantics.
- Runtime can prefer compiled artifacts for stable repeated tasks.

Tactical build choices:

- Add capability registry:
  `chat`, `responses`, `messages`, `tools`, `vision`, `audio`, `embeddings`,
  `json_schema`, `streaming`, `prompt_cache`, `batch`, `fine_tune`,
  `rate_limit_headers`.
- Add "compatibility confidence":
  exact native, OpenAI-compatible full, OpenAI-compatible partial, custom.
- Add provider drift tests:
  run fixture and live optional probes; warn when provider response shape
  changes.
- Add runtime fallback receipts:
  which provider failed, why fallback executed, final provider/artifact.
- Add per-provider privacy handling:
  zero-retention flags, no-log modes, cache controls, data residency.

Launch scope:

- OpenAI-compatible
- Anthropic-native
- OpenRouter
- Gemini
- local artifact
- streaming basics
- cost usage

Next scope:

- provider capability UI
- routing policies
- provider health
- semantic cache
- live optional conformance suite

Strategic scope:

- artifact-first runtime broker across provider, local, edge, GPU, browser

Proof gates:

- each advertised provider path returns valid shape
- no customer upstream key persisted
- zero-retention stores no event
- usage/cost parsed correctly
- fallback is auditable

### 6.5 `capture-data-eval-training`

Product goal:

Convert production usage into governed datasets, evals, labels, simulations,
training jobs, distillation jobs, and better artifacts.

Competitors:

- LangSmith, Langfuse, Phoenix, Weave, Braintrust, Humanloop, Galileo,
  Promptfoo.
- OpenAI distillation, OpenPipe, Predibase, Together, Bedrock customization.

Best-in-class design:

- Capture is not the same as consent to train.
- Promotion from event to dataset is a governed state transition.
- Eval rows are immutable/versioned once used for K-score.
- Training rows and held-out rows are provably disjoint.
- Label queues support human review and deterministic transformations.
- Simulations and synthetic data record generator provenance.

Tactical build choices:

- Add row lifecycle:
  captured -> redacted -> reviewed -> dataset_candidate -> train/eval ->
  frozen -> used_in_artifact -> purge_requested.
- Add label review states:
  unreviewed, accepted, corrected, rejected, unsafe, duplicate, holdout_only.
- Add dataset cards:
  source systems, data classes, consent, retention, row counts, class balance,
  labelers, eval split, known limitations.
- Add eval card:
  task, grader, threshold, calibration status, failure taxonomy.
- Add train plan dry-run:
  "will use X rows, exclude Y rows, cost estimate Z, compute target Q".
- Add drift loop:
  production failures -> candidate eval rows -> bakeoff -> artifact update.

Launch scope:

- capture health
- event/lake stats
- labels
- datasets
- distill preview
- training plan
- bakeoffs

Next scope:

- eval-as-code
- dataset cards
- synthetic data provenance
- online eval sampling
- drift monitors
- stronger label UI

Strategic scope:

- closed-loop improvement system where artifacts improve without losing
  compliance evidence

Proof gates:

- row provenance retained
- train/eval split proven
- K-score never trains on holdout
- purge workflow identifies affected artifacts
- sensitive data cannot silently enter training

### 6.6 `governance-compliance-security`

Product goal:

Give operators continuous proof of who did what, what data moved, what model or
artifact ran, what policy applied, what risks exist, and what evidence can be
exported.

Competitors and standards:

- WorkOS Audit Logs/FGA/Vault.
- Auth0/Okta enterprise identity.
- Vanta/Drata style evidence collection.
- NIST AI RMF and NIST AI 600-1.
- ISO/IEC 42001.
- EU AI Act.
- OWASP LLM Top 10 and MCP Top 10.
- SOC 2, HIPAA, ISO 27001, FedRAMP.
- CycloneDX ML-BOM, SPDX, SLSA, in-toto, Sigstore.

Best-in-class design:

- Audit chain is append-only and hash-linked.
- Privacy policy is executable, not just text.
- Compliance bundle is generated from real system evidence.
- Risk classification is a workflow.
- DSR/purge is connected to artifacts and training lineage.
- SIEM export is first-class.

Tactical build choices:

- Add AI system inventory:
  use case, owner, risk class, provider, artifact, data classes, users,
  affected persons, external actions.
- Add compliance bundle modes:
  SOC 2 evidence, HIPAA evidence, GDPR data lineage, EU AI Act high-risk
  candidate, NIST AI RMF, security review.
- Add policy simulation:
  show which events would be blocked/redacted/hash-only under a proposed
  policy.
- Add model/data BOM:
  base model, adapters, tokenizer, datasets, evals, tools, runtime,
  dependencies, license.
- Add incident timeline:
  provider outage, artifact rollback, privacy policy change, eval regression.

Launch scope:

- audit log
- privacy scan/report
- trace append/export
- compliance package skeleton
- notifications

Next scope:

- SIEM export
- CMK/BYOK
- DSR/purge lineage
- ML-BOM
- risk classification
- SSO/SCIM

Strategic scope:

- continuous AI assurance platform for regulated private AI artifacts

Proof gates:

- no cross-tenant audit leakage
- privacy policy is enforced at capture/runtime
- compliance bundle traces to immutable evidence
- risky actions require approval
- legal claims map to external certification status

### 6.7 `deployment-edge-federated`

Product goal:

Move artifacts across local, cloud, BYOC, edge, fleet, air-gap, tunnel, sync,
confidential-compute, and federated workflows without losing proof or tenant
boundaries.

Competitors and substrates:

- Cloudflare R2, AWS S3/KMS, Supabase Storage, MinIO, Azure Blob, GCS.
- Modal, RunPod, Lambda GPU, Vast, Together, Bedrock, Azure, Vertex.
- Kubernetes, KServe, Ray Serve, BentoML, Docker, Helm, Terraform.
- Core ML, LiteRT, ExecuTorch, ONNX Runtime, OpenVINO, QNN.
- Flower, TensorFlow Federated, NVIDIA FLARE, PySyft/OpenMined.

Best-in-class design:

- Storage readiness and compute readiness are separate.
- Every deployment has a target profile.
- Every device install has a receipt.
- Federated workflows exchange approvals, hashes, and aggregates, not raw
  tenant data.
- Air-gap is a first-class deployment mode.

Tactical build choices:

- Add deployment plan DSL:
  `artifact`, `target`, `storage`, `compute`, `network`, `secrets`,
  `rollback`, `attestation`, `smoke_test`.
- Add storage capability matrix:
  versioning, checksum, signed URL, lifecycle, encryption, KMS, multipart,
  region, path-style, object lock.
- Add compute capability matrix:
  GPU type, VRAM, image, startup latency, max job time, data residency,
  checkpoint, cost, attestation.
- Add device install smoke:
  copy artifact, verify hash, run test input, record p95 latency, rollback.
- Add federated approval object:
  peer, dataset hash, aggregate policy, DP epsilon, approval actor, output
  hash.

Launch scope:

- local deployment
- storage readiness
- devices
- BYOC targets
- sync
- tunnel
- federated peer primitives

Next scope:

- R2/S3/Supabase smoke tests
- Modal/RunPod/Together job dispatch
- remote SSH train
- device rollout receipts
- air-gap mirror bundle

Strategic scope:

- private AI deployment fabric spanning cloud, edge, and regulated networks

Proof gates:

- no secret values printed
- storage/compute configured state is truthful
- deployment smoke produces receipt
- artifact verification runs at target
- federated flow cannot access raw peer data by default

## 7. Tactical Build Choices That Improve Product Lines Substantially

This is the execution list. It is intentionally concrete.

### 7.1 P0: Evidence And Trust

1. Ship standalone verifier packages.
   - Why: makes `.kolm` credible outside Kolm SaaS.
   - Surfaces: compile, registry, enterprise, edge.
   - Proof: install verifier without Kolm account and reject tampered artifact.

2. Add artifact diff and dependency graph.
   - Why: procurement and rollback need to know what changed.
   - Surfaces: registry, account artifacts, compliance.
   - Proof: two artifacts produce semantic diff and blast-radius graph.

3. Add dataset/eval cards.
   - Why: K-score and model quality claims need provenance.
   - Surfaces: datasets, evals, compile.
   - Proof: every production artifact links to frozen dataset/eval cards.

4. Add K-score methodology page with calibration scope.
   - Why: without methodology, K-score reads as marketing.
   - Surfaces: docs, compile, benchmarks.
   - Proof: per-task axes, thresholds, calibration set, known limits.

5. Add privacy lineage from captured row to artifact.
   - Why: GDPR/HIPAA/enterprise DSR depends on it.
   - Surfaces: lake, datasets, compile, compliance.
   - Proof: given a row ID, list artifacts affected by it.

### 7.2 P0: Gateway And Capture

6. Add provider capability registry and UI.
   - Why: OpenAI-compatible does not mean equivalent.
   - Surfaces: connectors, docs, runtime.
   - Proof: each provider exposes exact capability flags.

7. Add namespace gateway policies.
   - Why: serious users need per-workflow controls.
   - Surfaces: gateway, account, CLI.
   - Proof: policy changes routing/capture/privacy behavior.

8. Add compile recommendations from capture analytics.
   - Why: converts gateway users into compiler users.
   - Surfaces: overview, opportunities, capture, train.
   - Proof: repeated pattern produces savings and artifact recommendation.

9. Add live optional provider conformance tests.
   - Why: production failures often come from provider shape drift.
   - Surfaces: connectors, doctor.
   - Proof: `kolm doctor providers --live` reports shape/capability drift.

### 7.3 P0: No-GPU Training And Cloud Product

10. Add TrainPlan decision engine.
    - Why: users should not guess SFT vs LoRA vs QLoRA vs RAG vs recipe.
    - Surfaces: train, distill, models, compute.
    - Proof: same dataset gets method, model, compute, and cost recommendation.

11. Add managed GPU job adapter interface.
    - Why: teams without GPUs must still train/distill.
    - Surfaces: compute-cloud, train-distill.
    - Proof: local fixture plus one real provider adapter can run noop job.

12. Add storage smoke for R2/S3/Supabase.
    - Why: artifact store is source of truth for cloud workflows.
    - Surfaces: storage, cloud, deployment.
    - Proof: put/get/head/delete/checksum without leaking secrets.

13. Add async compile/train webhooks.
    - Why: CI/CD and hosted jobs require non-blocking lifecycle.
    - Surfaces: compile, cloud, account builds.
    - Proof: job state transitions and webhook receipt.

### 7.4 P1: Runtime And Devices

14. Add runtime target conformance suite.
    - Why: "runs anywhere" needs proof per target.
    - Surfaces: runtime, devices, artifact.
    - Proof: target matrix passes standard inputs and records limitations.

15. Add device install receipts.
    - Why: edge buyers need proof artifact actually installed and ran.
    - Surfaces: devices, edge, compliance.
    - Proof: install receipt includes target, hash, test result, latency.

16. Add browser/edge package release.
    - Why: currently web runtime credibility needs installable package proof.
    - Surfaces: SDK, runtime, docs.
    - Proof: npm package with smoke in browser and edge runtime.

17. Add per-artifact fallback/cache policy.
    - Why: runtime behavior must be governed by artifact evidence.
    - Surfaces: runtime, gateway, compile.
    - Proof: artifact controls fallback/cache under policy.

### 7.5 P1: Enterprise And Governance

18. Add SSO/SCIM and scoped service accounts.
    - Why: enterprise deals above modest ACV expect this.
    - Surfaces: identity, enterprise.
    - Proof: org membership, groups, roles, deprovisioning.

19. Add CMK/BYOK and secret refs.
    - Why: regulated buyers need key control and no secret-in-artifact.
    - Surfaces: storage, governance, enterprise.
    - Proof: artifacts reference secret IDs, never secret values.

20. Add SIEM/OTEL exports.
    - Why: buyers do not want another isolated dashboard.
    - Surfaces: audit, traces, security.
    - Proof: Splunk/Datadog/generic webhook exports a signed audit event.

21. Add AI system inventory and risk classifier.
    - Why: NIST/ISO/EU AI Act operating model starts with inventory.
    - Surfaces: enterprise, compliance.
    - Proof: every artifact can be mapped to use case, risk, data classes.

### 7.6 P1: Registry And Ecosystem

22. Add verified publisher and permission diff.
    - Why: agent/tool marketplaces need trust before scale.
    - Surfaces: registry, agents.
    - Proof: publish shows publisher status and permission delta.

23. Add private registry and air-gap mirror.
    - Why: enterprise and defense will not pull from public SaaS at runtime.
    - Surfaces: registry, deployment, enterprise.
    - Proof: export/import mirror validates signatures offline.

24. Add MCP tool-description linter.
    - Why: tool descriptions are part of the agent attack and quality surface.
    - Surfaces: agents, MCP, registry.
    - Proof: risky/ambiguous/excessive tool descriptions fail review.

### 7.7 P2: Public Proof

25. Publish benchmark harness and reproducible results.
    - Why: speed/cost/quality claims need public data.
    - Surfaces: benchmarks, website, valuation.
    - Proof: users can reproduce claims locally or in CI.

26. Publish redaction benchmark methodology.
    - Why: PHI/PII quality is high-stakes.
    - Surfaces: privacy, healthcare, compliance.
    - Proof: per-class precision/recall/F1 and false-negative cases.

27. Start neutral `.kolm` standardization track.
    - Why: ecosystem adoption is the multi-billion-dollar lever.
    - Surfaces: format, registry, runtime.
    - Proof: public RFC, governance model, third-party implementer tests.

## 8. UX Implications Across Account, CLI, TUI, Docs

The product should be "robot easy": a capable user should always see the next
safe step.

### Account UI

Required structure:

- Overview: next actions, health, recent proof, cost, capture opportunities.
- Connectors: provider setup, capability flags, health, live probe, examples.
- Lake: events, privacy mode, filters, redaction, export, promote to dataset.
- Datasets: cards, splits, labels, eval candidates, provenance.
- Labels: review queue with accept/correct/reject/holdout-only.
- Builds: compile/train jobs, cost estimate, logs, failure reasons.
- Artifacts: verify, diff, runtime targets, install, rollback, publish.
- Storage: readiness, smoke, object counts, encryption/KMS state.
- Devices: detected targets, install receipts, fleet channels.
- Billing: entitlements, usage, quota, invoices, spend by namespace/model.
- Audit: who did what, export, verification state.
- Compliance: system inventory, bundles, risk state, DSR/purge.

### CLI

Required structure:

- `kolm doctor`: environment and product health.
- `kolm connect`: provider setup and live probes.
- `kolm capture`: gateway/capture lifecycle.
- `kolm lake`: event inspection/export.
- `kolm dataset`: create/split/card/export.
- `kolm eval`: run/replay/bakeoff.
- `kolm train`: plan/run/resume.
- `kolm distill`: teacher/student workflows.
- `kolm compile`: artifact build.
- `kolm verify`: offline strict verification.
- `kolm run`: local inference.
- `kolm serve`: HTTP/MCP runtime.
- `kolm artifact`: inspect/diff/graph/publish/pull.
- `kolm cloud`: readiness/storage/compute/jobs.
- `kolm device`: detect/recommend/install.
- `kolm enterprise`: audit/compliance/risk.

CLI design rule:

- Every risky command starts with dry-run/plan.
- Every cloud command shows missing env without secret values.
- Every build command prints next action when it fails.
- Every proof command has JSON output.

### TUI

Required views:

- health
- connectors
- capture stream
- lake
- opportunities
- labels
- datasets
- evals
- builds
- artifacts
- runtime
- devices
- storage
- billing
- audit
- compliance
- cloud jobs
- registry
- agent/MCP tools

TUI design rule:

- It should be an operator cockpit, not a marketing UI.
- Keyboard-first.
- No hover-only behavior.
- Every panel shows status, next action, and proof link.

### Docs

Required docs families:

- concept docs
- quickstarts
- API reference
- CLI reference
- SDK references
- provider setup
- cloud setup
- runtime targets
- artifact format
- security model
- compliance mappings
- benchmark methodology
- troubleshooting

Docs design rule:

- Every doc should answer:
  what it does, when to use it, local example, hosted example, security notes,
  expected output, failure modes, next step.

## 9. Optimal Scope Boundaries

### Launch: what can be claimed if proven

Kolm can claim:

- provider capture across OpenAI, Claude, OpenRouter, Gemini paths
- local compile/verify/run
- artifact receipts and offline verification
- train/eval split protection
- cloud readiness matrix
- account/CLI/docs product surface
- governed capture-to-dataset-to-artifact loop

Kolm should not yet claim without further evidence:

- "best redaction quality"
- "fastest runtime"
- "universal model support"
- "fully SOC 2/HIPAA/FedRAMP ready"
- ".kolm is an industry standard"
- "all devices supported"
- "all fine-tuning methods production-ready"

### Next: what materially raises product value

- standalone verifier packages
- public benchmark harness
- cloud job dispatch
- R2/S3/Supabase smoke
- TrainPlan decision engine
- dataset/eval/model cards
- OpenTelemetry/OpenInference export
- SSO/SCIM
- artifact diff/graph
- MCP linter and registry trust policy

### Strategic: what creates category ownership

- open `.kolm` standard and test suite
- third-party runtime adoption
- public registry and private registry
- artifact marketplace for agent tools
- K-score recognized as portable eval evidence
- BYOC/air-gap enterprise distribution
- compliance evidence as exportable AI system inventory
- cloud scheduler independent from provider lock-in

## 10. Architecture Decisions

### ADR-001: Kolm is artifact-first, not gateway-first

Decision:

Gateway exists to feed the artifact loop.

Reason:

Gateway-only competitors are numerous and already strong. Artifact trust is the
unique expansion point.

Consequence:

Every gateway page must point toward capture quality, opportunity detection,
dataset promotion, compile, verify, or savings evidence.

### ADR-002: Keep hosted control plane optional

Decision:

Artifact verification and local runtime must not require hosted Kolm.

Reason:

Regulated, edge, air-gap, and enterprise buyers need offline trust.

Consequence:

Registry metadata must be additive. Offline verifier must remain authoritative
for base artifact integrity.

### ADR-003: Storage and compute are separate planes

Decision:

Artifacts/evidence live in durable storage; train/serve jobs run on replaceable
compute backends.

Reason:

Cloud GPU vendors change prices, availability, and compliance posture. Evidence
must outlive compute.

Consequence:

Cloud readiness requires at least one storage plane and one compute plane for
hosted training claims.

### ADR-004: Native provider semantics beat fake compatibility

Decision:

Support OpenAI-compatible APIs, but keep Anthropic Messages, Gemini specifics,
and provider cache/tool semantics visible.

Reason:

OpenAI-compatible wrappers often hide capability differences and create broken
edge cases.

Consequence:

Provider capability flags and conformance tests are mandatory.

### ADR-005: K-score is evidence, not branding

Decision:

K-score must be decomposed into task-specific axes with calibration status.

Reason:

One opaque number will be attacked by technical buyers.

Consequence:

Public K-score claims require methodology, calibration data, and failure
examples.

### ADR-006: MCP tools require supply-chain controls

Decision:

Compiled MCP tools must carry permissions, provenance, and install receipts.

Reason:

MCP creates external action risk and prompt-injection surface.

Consequence:

Registry publish must lint tool descriptions and permission deltas.

## 11. Research Register

Gateway and provider routing:

- Cloudflare AI Gateway: https://developers.cloudflare.com/ai-gateway/
- Vercel AI Gateway observability:
  https://vercel.com/docs/ai-gateway/capabilities/observability
- OpenRouter provider routing:
  https://openrouter.ai/docs/features/provider-routing
- Portkey AI Gateway: https://portkey.ai/docs/product/ai-gateway
- LiteLLM docs: https://docs.litellm.ai/
- Helicone platform: https://docs.helicone.ai/getting-started/platform-overview
- OpenAI prompt caching:
  https://platform.openai.com/docs/guides/prompt-caching/prompt-caching
- Anthropic API overview: https://docs.anthropic.com/en/api/overview

Observability and evals:

- LangSmith observability:
  https://docs.langchain.com/langsmith/observability-studio
- Langfuse datasets:
  https://langfuse.com/docs/evaluation/features/datasets
- Langfuse concepts: https://langfuse.com/docs/evaluation/concepts
- Arize Phoenix: https://arize.com/docs/phoenix/
- OpenInference: https://arize-ai.github.io/openinference/
- Braintrust evals: https://www.braintrust.dev/docs/evaluate
- Humanloop evaluators: https://humanloop.com/docs/v4/evaluators
- Promptfoo intro: https://www.promptfoo.dev/docs/intro/
- Promptfoo red teaming:
  https://www.promptfoo.dev/docs/guides/llm-redteaming/
- OpenAI agent evals:
  https://platform.openai.com/docs/guides/agent-evals
- OpenAI Evals API: https://platform.openai.com/docs/api-reference/evals

Training, fine-tuning, and distillation:

- OpenAI model distillation:
  https://openai.com/index/api-model-distillation/
- OpenAI supervised fine-tuning:
  https://platform.openai.com/docs/guides/distillation
- Amazon Bedrock customization:
  https://docs.aws.amazon.com/en_us/bedrock/latest/userguide/custom-models.html
- Azure AI Foundry fine tuning:
  https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/fine-tuning
- Predibase fine-tuning:
  https://docs.predibase.com/fine-tuning/overview
- Together fine-tuning:
  https://docs.together.ai/docs/fine-tuning-python
- Fireworks LoRA deployment:
  https://docs.fireworks.ai/fine-tuning/deploying-loras
- Hugging Face TRL SFT:
  https://huggingface.co/docs/trl/main/sft_trainer
- Hugging Face TRL DPO:
  https://huggingface.co/docs/trl/main/dpo_trainer
- Unsloth docs: https://docs.unsloth.ai/
- Axolotl docs: https://docs.axolotl.ai/
- bitsandbytes:
  https://huggingface.co/docs/bitsandbytes/v0.43.0/en/index

Runtime and serving:

- vLLM OpenAI-compatible server:
  https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html
- SGLang: https://www.sglang.io/
- SGLang model gateway:
  https://docs.sglang.io/advanced_features/sgl_model_gateway.html
- TensorRT-LLM: https://docs.nvidia.com/tensorrt-llm/
- OpenVINO GenAI: https://docs.openvino.ai/genai_inference
- ONNX Runtime execution providers:
  https://onnxruntime.ai/docs/execution-providers
- Hugging Face TGI:
  https://huggingface.co/docs/text-generation-inference/index
- Ray Serve LLM: https://docs.ray.io/en/latest/serve/llm/index.html
- BentoML: https://docs.bentoml.org/en/latest/overview/guides/gpu-inference.html
- KServe: https://kserve.github.io/kserve/
- Ollama API: https://docs.ollama.com/api
- llama.cpp server:
  https://www.mintlify.com/ggml-org/llama.cpp/inference/server

Edge, mobile, and browser:

- Apple Core ML: https://developer.apple.com/machine-learning/core-ml/
- Apple Foundation Models news:
  https://www.apple.com/newsroom/2025/09/apples-foundation-models-framework-unlocks-new-intelligent-app-experiences/
- Google LiteRT: https://ai.google.dev/edge/litert/overview
- ExecuTorch: https://docs.pytorch.org/executorch/1.0/
- ONNX Runtime Mobile: https://onnxruntime.ai/docs/tutorials/mobile/

Cloud and storage:

- Cloudflare R2 S3 API:
  https://developers.cloudflare.com/r2/api/s3/api/
- Supabase Storage S3 compatibility:
  https://supabase.com/docs/guides/storage/s3/compatibility/
- Modal docs: https://modal.com/docs/guide
- RunPod serverless endpoints:
  https://docs.runpod.io/serverless/endpoints/overview
- AWS S3 API:
  https://docs.aws.amazon.com/AmazonS3/latest/API/Type_API_Reference.html

Artifact, registry, and supply chain:

- Docker OCI artifact:
  https://docs.docker.com/compose/how-tos/oci-artifact/
- ONNX export:
  https://docs.pytorch.org/docs/stable/onnx.html
- GGUF format:
  https://www.mintlify.com/ggml-org/llama.cpp/concepts/gguf-format
- safetensors: https://huggingface.co/docs/safetensors/index
- Hugging Face model cards: https://huggingface.co/docs/hub/en/model-cards
- MLflow Model Registry: https://www.mlflow.org/docs/2.9.2/model-registry.html
- DVC data/model versioning:
  https://dvc.org/doc/use-cases/versioning-data-and-models
- Sigstore verifying signatures:
  https://docs.sigstore.dev/cosign/verifying/verify/
- in-toto specs: https://in-toto.io/docs/specs/
- SLSA provenance: https://slsa.dev/spec/v1.0-rc1/provenance
- CycloneDX ML-BOM: https://cyclonedx.org/capabilities/mlbom/

Governance and compliance:

- WorkOS docs: https://workos.com/docs
- Auth0 Organizations: https://auth0.com/docs/organizations
- Stripe Billing: https://stripe.com/billing/features
- Stripe customer portal:
  https://docs.stripe.com/billing/subscriptions/customer-portal
- NIST AI RMF Generative AI Profile:
  https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence
- ISO/IEC 42001:
  https://www.iso.org/standard/81230.html?browse=ics
- EU AI Act official FAQ:
  https://digital-strategy.ec.europa.eu/en/faqs/navigating-ai-act
- OWASP LLM Top 10:
  https://owasp.org/www-project-top-10-for-large-language-model-applications/
- OWASP MCP Top 10: https://owasp.org/www-project-mcp-top-10/

Federated learning and privacy:

- TensorFlow Federated: https://www.tensorflow.org/federated
- Flower framework: https://flower.ai/docs/framework/index.html
- PySyft/OpenMined: https://openmined.org/pysyft/
- Federated learning paper:
  https://proceedings.mlr.press/v54/mcmahan17a
- Differential privacy survey:
  https://www.microsoft.com/en-us/research/publication/differential-privacy-a-survey-of-results/
- Deep learning with differential privacy:
  https://arxiv.org/abs/1607.00133

Academic ML and eval references:

- Distilling knowledge:
  https://arxiv.org/abs/1503.02531
- LoRA: https://arxiv.org/abs/2106.09685
- QLoRA: https://arxiv.org/abs/2305.14314
- S-LoRA: https://arxiv.org/abs/2311.03285
- RAG: https://arxiv.org/abs/2005.11401
- HELM: https://crfm.stanford.edu/helm/
- MMLU: https://huggingface.co/papers/2009.03300
- Prompt Cache:
  https://arxiv.org/abs/2311.04934
- Auditing prompt caching:
  https://arxiv.org/abs/2502.07776
- Model cards:
  https://colab.ws/articles/10.1145%2F3287560.3287596
- Model/dataset documentation practices:
  https://arxiv.org/abs/2312.15058
- Model hub documentation gaps:
  https://arxiv.org/abs/2503.15222

Agents and MCP:

- MCP specification: https://modelcontextprotocol.io/specification/
- Claude Code MCP: https://code.claude.com/docs/en/mcp
- Cursor MCP: https://docs.cursor.com/en/tools/mcp
- OpenAI Agents SDK tracing:
  https://openai.github.io/openai-agents-python/tracing/
- OpenAI agent evals:
  https://platform.openai.com/docs/guides/agent-evals
- MCP production patterns:
  https://arxiv.org/abs/2603.13417
- MCP security analysis:
  https://arxiv.org/abs/2601.17549

Additional main competitor evidence added after review:

- Databricks Mosaic AI Model Serving:
  https://docs.databricks.com/en/machine-learning/model-serving/index.html
- Databricks foundation model serving:
  https://docs.databricks.com/aws/en/machine-learning/model-serving/foundation-model-overview
- Snowflake Cortex fine-tuning:
  https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-finetuning
- Palantir AIP overview:
  https://www.palantir.com/docs/foundry/aip/overview/
- Palantir AIP architecture:
  https://www.palantir.com/docs/foundry/architecture-center/aip-architecture
- Palantir AIP capabilities:
  https://www.palantir.com/docs/foundry/platform-overview/aip-capabilities
- Dataiku LLM Mesh:
  https://www.dataiku.com/product/llm-mesh
- Dataiku Prompt Studio:
  https://doc.dataiku.com/dss/latest/generative-ai/prompt-studio.html
- Dataiku LLM evaluation:
  https://doc.dataiku.com/dss/latest/generative-ai/evaluation.html
- DataRobot LLM evaluation tools:
  https://docs.datarobot.com/latest/en/docs/gen-ai/playground-tools/playground-eval-metrics.html
- DataRobot AI observability:
  https://www.datarobot.com/product/ai-observability/
- Domino Data Lab docs:
  https://docs.dominodatalab.com/
- SageMaker JumpStart deployment:
  https://docs.aws.amazon.com/sagemaker/latest/dg/jumpstart-deploy.html
- SageMaker JumpStart fine-tuning:
  https://docs.aws.amazon.com/sagemaker/latest/dg/jumpstart-foundation-models-fine-tuning.html
- Hugging Face SageMaker JumpStart quickstart:
  https://huggingface.co/docs/sagemaker/main/tutorials/jumpstart/jumpstart-quickstart
- Baseten deployment concepts:
  https://docs.baseten.co/deployment
- Baseten autoscaling:
  https://docs.baseten.co/deployment/autoscaling/overview
- Baseten deployment lifecycle:
  https://docs.baseten.co/concepts/howbasetenworks
- Replicate models:
  https://replicate.com/docs/topics/models/
- Replicate custom model deployment:
  https://replicate.com/docs/get-started/deploy-a-custom-model
- Replicate deployments:
  https://replicate.com/docs/topics/deployments
- Modal GPU acceleration:
  https://modal.com/docs/reference/modal.gpu
- RunPod serverless endpoints:
  https://docs.runpod.io/serverless/endpoints/overview
- RunPod endpoint configuration:
  https://docs.runpod.io/serverless/endpoints/endpoint-configurations
- Together dedicated inference:
  https://www.together.ai/dedicated-endpoints
- Together fine-tuning:
  https://www.together.ai/fine-tuning
- Fireworks docs:
  https://docs.fireworks.ai/
- Snorkel Flow:
  https://snorkel.ai/snorkel-flow/
- Snorkel Flow docs:
  https://docs.snorkel.ai/docs/25.4/user-guide/intro/welcome-to-snorkel-flow
- Labelbox multimodal chat evaluation:
  https://docs.labelbox.com/docs/multimodal-chat-evaluation-editor
- Labelbox human preference:
  https://docs.labelbox.com/docs/llm-human-preference-editor
- Labelbox model metrics:
  https://docs.labelbox.com/docs/model-metrics
- Scale AI model developer evaluation:
  https://scale.com/evaluation/model-developers
- Scale documentation:
  https://scale.com/docs
- Surge AI RLHF/data labeling:
  https://www.surgehq.ai/rlhf
- Humanloop evals:
  https://humanloop.com/docs/guides/evals
- Humanloop evaluators:
  https://humanloop.com/docs/v4/evaluators
- Humanloop deployment/control overview:
  https://humanloop.com/docs/v5/explanation
- Braintrust evaluation:
  https://www.braintrust.dev/docs/evaluate
- Langfuse overview:
  https://langfuse.com/docs/
- Langfuse prompt-trace linking:
  https://langfuse.com/docs/prompt-management/features/link-to-traces
- Fiddler LLM monitoring:
  https://docs.fiddler.ai/observability/llm
- Arthur LLM evals:
  https://docs.arthur.ai/docs/get-started-with-llm-evals
- Patronus docs:
  https://docs.patronus.ai/docs
- Patronus guardrails:
  https://docs.patronus.ai/docs/guides/cookbooks/guardrails
- Giskard vulnerability scanning:
  https://docs.giskard.ai/hub/sdk/scan/index.html
- Giskard LLM Scan:
  https://docs.giskard.ai/en/stable/open_source/scan/scan_llm/index.html
- Lakera prompt defense:
  https://docs.lakera.ai/docs/prompt-defense
- Lakera policies:
  https://docs.lakera.ai/docs/policies
- HiddenLayer model scanner:
  https://www.hiddenlayer.com/model-scanner
- HiddenLayer console overview:
  https://docs.hiddenlayer.ai/docs/products/console/overview
- Protect AI ModelScan:
  https://github.com/protectai/modelscan
- Protect AI Guardian:
  https://protectai.com/guardian
- garak:
  https://garak.ai/
- garak GitHub:
  https://github.com/NVIDIA/garak
- Pinecone Assistant:
  https://docs.pinecone.io/guides/assistant
- Vectara hallucination evaluation:
  https://docs.vectara.com/docs/hallucination-and-evaluation/hallucination-evaluation
- Weaviate hybrid search:
  https://docs.weaviate.io/weaviate/search/hybrid
- Weaviate search:
  https://docs.weaviate.io/weaviate/search
- Unstructured chunking:
  https://docs.unstructured.io/concepts/chunking
- Sourcegraph Cody context:
  https://sourcegraph.com/docs/cody/core-concepts/context
- OpenAI Codex:
  https://openai.com/codex/
- OpenAI Codex CLI help:
  https://help.openai.com/en/articles/11096431-openai-codex-cli-getting-started
- Claude Code MCP:
  https://code.claude.com/docs/en/mcp
- Claude Code user FAQ:
  https://support.claude.com/en/articles/14554922-claude-code-user-faq
- Sourcegraph Cody:
  https://sourcegraph.com/docs/cody
- colbymchenry/codegraph:
  https://github.com/colbymchenry/codegraph
- Claude Code architecture analysis:
  https://arxiv.org/abs/2604.14228
- garak framework paper:
  https://arxiv.org/abs/2406.11036
- LLM vulnerability scanner comparison:
  https://arxiv.org/abs/2410.16527
- NeMo Guardrails paper:
  https://arxiv.org/abs/2310.10501
- RAG hallucination evaluator comparison:
  https://arxiv.org/abs/2503.21157
- Adaptive chunking:
  https://arxiv.org/abs/2603.25333
- Structure-aware chunking for tabular RAG:
  https://arxiv.org/abs/2605.00318
- Enterprise agentic AI evaluation framework:
  https://arxiv.org/abs/2511.14136
- OPERA verifiability-first agents:
  https://arxiv.org/abs/2512.17259
- CodeGraph graph reasoning paper:
  https://arxiv.org/abs/2408.13863

Second-pass direct competitor evidence:

- Pruna model compression:
  https://docs.pruna.ai/en/stable/index.html
- Pruna product:
  https://www.pruna.ai/product
- Red Hat LLM Compressor:
  https://docs.redhat.com/en/documentation/red_hat_ai_inference_server/3.1/html-single/llm_compressor/index
- Neural Magic LLM Compressor article:
  https://developers.redhat.com/articles/2024/08/14/llm-compressor-here-faster-inference-vllm
- Hugging Face AutoTrain LLM fine-tuning:
  https://huggingface.co/docs/autotrain/main/en/tasks/llm_finetuning
- LlamaFactory paper:
  https://arxiv.org/abs/2403.13372
- Modular MAX:
  https://www.modular.com/max
- Modular docs:
  https://docs.modular.com/
- Apache TVM docs:
  https://tvm.apache.org/docs/
- Apache TVM Relax:
  https://tvm.apache.org/docs/deep_dive/relax/index.html
- TVM paper:
  https://arxiv.org/abs/1802.04799
- MLC LLM intro:
  https://llm.mlc.ai/docs/get_started/introduction.html
- MLC LLM compile models:
  https://llm.mlc.ai/docs/compilation/compile_models.html
- IREE:
  https://github.com/iree-org/iree
- TinyIREE paper:
  https://arxiv.org/abs/2205.14479
- Edge Impulse deployment:
  https://docs.edgeimpulse.com/docs/edge-impulse-studio/deployment
- Edge Impulse overview:
  https://docs.edgeimpulse.com/docs/concepts/edge-ai/what-is-edge-impulse
- Edge Impulse TinyML paper:
  https://arxiv.org/abs/2212.03332
- SensiML docs:
  https://sensiml.com/documentation/
- NetsPresso docs:
  https://docs.netspresso.ai/docs/overview
- NetsPresso compression:
  https://docs.netspresso.ai/docs/gui_compress
- H2O Enterprise h2oGPTe docs:
  https://docs.h2o.ai/enterprise-h2ogpte/
- H2O Enterprise h2oGPTe FAQ:
  https://docs.h2o.ai/enterprise-h2ogpte/support/faqs
- C3 AI docs:
  https://docs.c3.ai/
- C3 AI platform overview:
  https://docs.c3.ai/docs/platform/8.9/topic/platform-overview
- IBM watsonx.governance:
  https://www.ibm.com/docs/en/watsonx/saas?topic=ai-managing-risk-compliance-governance-console
- Credo AI:
  https://www.credo.ai/product
- ModelOp:
  https://www.modelop.com/product
- ModelOp generative AI governance:
  https://www.modelop.com/ai-governance/generative-ai-governance
- Holistic AI governance:
  https://www.holisticai.com/ai-governance-platform
- Monitaur:
  https://www.monitaur.ai/platform
- Not Diamond:
  https://www.notdiamond.ai/
- Not Diamond router training:
  https://docs.notdiamond.ai/docs/router-training-quickstart
- Not Diamond concepts:
  https://docs.notdiamond.ai/docs/key-concepts
- Requesty:
  https://www.requesty.ai/
- Requesty docs:
  https://requesty.mintlify.app/
- DeepEval:
  https://deepeval.com/docs/introduction
- Confident AI API docs:
  https://www.confident-ai.com/docs/api-reference/introduction
- Comet Opik:
  https://www.comet.com/docs/opik/?from=llm
- Parea evaluation:
  https://docs.parea.ai/evaluation/overview
- HoneyHive:
  https://docs.honeyhive.ai/introduction
- HoneyHive eval concepts:
  https://docs.honeyhive.ai/v2/evaluation/concepts
- Zenity:
  https://zenity.io/
- Zenity docs:
  https://docs.zenity.io/
- Enkrypt AI docs:
  https://docs.enkryptai.com/libraries/python/introduction
- Enkrypt AI guardrails:
  https://www.enkryptai.com/product/agent-guardrails
- Prompt Security:
  https://www.prompt.security/about-us
- AIMon prompt injection:
  https://docs.aimon.ai/metrics/safety-metrics/prompt_injection
- OpenAI prompt injection safety:
  https://openai.com/safety/prompt-injections/
- Dify docs:
  https://docs.dify.ai/
- Flowise docs:
  https://docs.flowiseai.com/
- Langflow docs:
  https://docs.langflow.org/
- Langflow agents:
  https://docs.langflow.org/agents
- Dust docs:
  https://docs.dust.tt/docs
- Moveworks docs:
  https://docs.moveworks.com/ai-assistant/getting-started/welcome-to-moveworks
- Moveworks content ingestion:
  https://docs.moveworks.com/ai-assistant/enterprise-search/content-ingestion-platform
- Moveworks Agent Studio:
  https://docs.moveworks.com/agent-studio/overview
- Glean docs:
  https://docs.glean.com/
- Glean search:
  https://docs.glean.com/administration/search
- Glean code search:
  https://docs.glean.com/security/how-code-search-works
- Coveo generative answering:
  https://www.coveo.com/en/platform/generative-ai
- Coveo search agents:
  https://docs.coveo.com/en/q2pe0294/leverage-machine-learning/about-coveo-search-agents
- Authenticated workflows for agentic AI:
  https://arxiv.org/abs/2602.10465
- STRIDE modality selection:
  https://arxiv.org/abs/2512.02228
- EnterpriseLab agent platform:
  https://arxiv.org/abs/2603.21630
- Agent-first tool API:
  https://arxiv.org/abs/2605.10555
- RAGOps:
  https://arxiv.org/abs/2506.03401
- AI observability multi-layer analysis:
  https://arxiv.org/abs/2604.26152
- OpenGuardrails:
  https://arxiv.org/abs/2510.19169
- SoK jailbreak guardrails:
  https://arxiv.org/abs/2506.10597
- Enterprise guardrailing stack:
  https://arxiv.org/abs/2510.13351

Third-pass whole-market coverage evidence:

- Anthropic batch processing:
  https://docs.claude.com/en/docs/build-with-claude/batch-processing
- Google Gemini context caching:
  https://ai.google.dev/gemini-api/docs/caching
- Google Vertex AI Gemini supervised tuning:
  https://cloud.google.com/vertex-ai/generative-ai/docs/models/gemini-use-supervised-tuning
- Azure OpenAI fine-tuning:
  https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/fine-tuning
- Mistral text and vision fine-tuning:
  https://docs.mistral.ai/capabilities/finetuning/text_vision_finetuning/
- Cohere fine-tuning:
  https://docs.cohere.com/v1/docs/fine-tuning
- Hugging Face TRL CLI:
  https://huggingface.co/docs/trl/clis
- PyTorch torchtune:
  https://docs.pytorch.org/torchtune/stable/
- NVIDIA NeMo:
  https://www.nvidia.com/en-us/gpu-cloud/nemo-llm-service/
- Axolotl:
  https://docs.axolotl.ai/
- Unsloth:
  https://docs.unsloth.ai/
- vLLM OpenAI-compatible server:
  https://docs.vllm.ai/serving/openai_compatible_server.html
- SGLang:
  https://docs.sglang.io/
- SGLang router/model gateway:
  https://docs.sglang.ai/advanced_features/router.html
- Ollama API:
  https://docs.ollama.com/api
- ONNX Runtime execution providers:
  https://onnxruntime.ai/docs/execution-providers/
- TensorRT-LLM:
  https://docs.nvidia.com/tensorrt-llm/
- OpenVINO GenAI:
  https://docs.openvino.ai/2025/get-started/install-openvino/install-openvino-genai.html
- Apple Core ML overview:
  https://developer.apple.com/machine-learning/core-ml/
- LangGraph workflows and agents:
  https://docs.langchain.com/oss/python/langgraph/workflows-agents
- OpenAI Agents SDK:
  https://platform.openai.com/docs/guides/agents-sdk
- OpenAI Agents SDK tracing:
  https://openai.github.io/openai-agents-python/tracing/
- AutoGen multi-agent conversation framework:
  https://autogenhub.github.io/autogen/docs/Use-Cases/agent_chat/
- CrewAI docs:
  https://docs.crewai.com/en/introduction
- Pydantic AI agents:
  https://pydantic.dev/docs/ai/core-concepts/agent/
- n8n AI agents:
  https://docs.n8n.io/advanced-ai/examples/understand-agents/
- Dify agents:
  https://docs.dify.ai/en/use-dify/build/agent
- LlamaIndex agents:
  https://docs.llamaindex.ai/en/stable/use_cases/agents/
- Microsoft Semantic Kernel agents:
  https://learn.microsoft.com/semantic-kernel/frameworks/agent/
- Pinecone search overview:
  https://docs.pinecone.io/guides/search/search-overview
- Weaviate hybrid search:
  https://docs.weaviate.io/weaviate/search/hybrid
- Milvus documentation:
  https://milvus.io/docs
- Qdrant documentation:
  https://qdrant.tech/documentation/
- Ragas evaluate:
  https://docs.ragas.io/en/latest/references/evaluate/
- RAGAS paper:
  https://arxiv.org/abs/2309.15217
- WorkOS enterprise auth docs:
  https://workos.com/docs
- NIST AI Risk Management Framework:
  https://www.nist.gov/itl/ai-risk-management-framework
- ISO/IEC 42001:
  https://www.iso.org/standard/81230.html?browse=ics
- IBM watsonx.governance:
  https://www.ibm.com/docs/en/watsonx/saas?topic=governing-ai
- STRIDE-AI threat modeling:
  https://arxiv.org/abs/2605.17163
- MCP production patterns:
  https://arxiv.org/abs/2603.13417
- MCP security analysis:
  https://arxiv.org/abs/2601.17549

Fourth-pass infrastructure, UX, and production-depth evidence:

- Databricks Mosaic AI Model Serving:
  https://docs.databricks.com/en/machine-learning/model-serving/index.html
- MosaicML fine-tuning:
  https://docs.mosaicml.com/projects/mcli/en/latest/finetuning/finetuning.html
- Snowflake Cortex fine-tuning:
  https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-finetuning.html
- Snowflake Cortex AI overview:
  https://docs.snowflake.com/en/user-guide/snowflake-cortex/overview
- Vertex AI Model Garden:
  https://docs.cloud.google.com/vertex-ai/generative-ai/docs/model-garden/explore-models
- Azure AI Foundry model catalog:
  https://learn.microsoft.com/en-us/azure/machine-learning/concept-model-catalog
- Datadog LLM Observability:
  https://www.datadoghq.com/product/llm-observability/
- New Relic AI monitoring:
  https://docs.newrelic.com/docs/ai-monitoring/intro-to-ai-monitoring/
- OpenTelemetry GenAI semantic conventions:
  https://opentelemetry.io/docs/specs/semconv/gen-ai/
- Honeycomb OpenTelemetry:
  https://docs.honeycomb.io/send-data/opentelemetry/
- NVIDIA Run:ai:
  https://docs.nvidia.com/run-ai/index.html
- Kubernetes Kueue:
  https://kueue.sigs.k8s.io/docs/tasks/run/
- Ray Train:
  https://docs.ray.io/en/latest/train/train.html
- Cursor codebase indexing:
  https://docs.cursor.com/chat/codebase
- Cursor MCP:
  https://docs.cursor.com/context/model-context-protocol
- Continue custom providers:
  https://docs.continue.dev/customize/custom-providers
- Continue config reference:
  https://docs.continue.dev/reference
- AI coding agent documentation behavior:
  https://arxiv.org/abs/2604.02544
- MCP client prompt-injection analysis:
  https://arxiv.org/abs/2603.21642
- Codebase-Memory graph context:
  https://arxiv.org/abs/2603.27277
- AgentSight observability:
  https://arxiv.org/abs/2508.02736
- AI observability multi-layer analysis:
  https://arxiv.org/abs/2604.26152
- Model-internal observability:
  https://arxiv.org/abs/2605.11093
- Kubernetes GenAI inference performance:
  https://arxiv.org/abs/2602.04900

Fifth-pass provider, retrieval, and operational reference evidence:

- Groq API reference:
  https://console.groq.com/docs/api-reference
- Cerebras training and inference docs:
  https://docs.cerebras.ai/
- Cerebras public model API:
  https://inference-docs.cerebras.ai/api-reference/models/public-models
- xAI docs:
  https://docs.x.ai/
- Perplexity Sonar API:
  https://docs.perplexity.ai/docs/sonar/quickstart
- pgvector:
  https://github.com/pgvector/pgvector
- Elasticsearch dense vector search:
  https://www.elastic.co/docs/solutions/search/vector/dense-vector
- Vespa search and vector docs:
  https://docs.vespa.ai/search.html
- Vespa nearest neighbor search:
  https://docs.vespa.ai/en/querying/nearest-neighbor-search
- LanceDB:
  https://lancedb.co/
- OpenSearch neural search:
  https://docs.opensearch.org/2.13/search-plugins/neural-search/
- OpenSearch vector search API:
  https://docs.opensearch.org/docs/latest/vector-search/api/index/
- Chroma docs:
  https://docs.trychroma.com/docs/overview/introduction
- Unstructured chunking:
  https://docs.unstructured.io/open-source/core-functionality/chunking
- Unstructured partitioning:
  https://unstructured.readthedocs.io/en/latest/core/partition.html
- RAG-Stack quality/performance:
  https://arxiv.org/abs/2510.20296
- OpenSearch-VL multimodal search agents:
  https://arxiv.org/abs/2605.05185
- Document Haystacks benchmark:
  https://arxiv.org/abs/2411.16740
- Filter-agnostic vector search on PostgreSQL:
  https://arxiv.org/abs/2603.23710

Sixth-pass platform, guardrail, and field-readiness references:

- GitHub Models catalog API:
  https://docs.github.com/en/rest/models/catalog
- Cloudflare Vectorize introduction:
  https://developers.cloudflare.com/vectorize/get-started/intro/
- Cloudflare Vectorize reference:
  https://developers.cloudflare.com/vectorize/reference/
- Amazon Bedrock Guardrails use cases:
  https://docs.aws.amazon.com/en_us/bedrock/latest/userguide/guardrails-use.html
- Microsoft Foundry Agent Service:
  https://learn.microsoft.com/en-us/azure/ai-foundry/agents/overview
- Azure AI Foundry Agent Service:
  https://learn.microsoft.com/en-gb/azure/ai-services/agents/overview
- NVIDIA NIM:
  https://docs.nvidia.com/nim/
- NVIDIA NIM for LLMs:
  https://docs.nvidia.com/nim/large-language-models/1.8.0/introduction.html
- Amazon SageMaker HyperPod:
  https://docs.aws.amazon.com/sagemaker/latest/dg/sagemaker-hyperpod.html
- SageMaker HyperPod recipes:
  https://docs.aws.amazon.com/sagemaker/latest/dg/sagemaker-hyperpod-recipes.html
- NVIDIA NeMo Guardrails:
  https://docs.nvidia.com/nemo-guardrails/index.html
- NeMo Guardrails paper:
  https://arxiv.org/abs/2310.10501
- Microsoft Presidio:
  https://github.com/microsoft/presidio
- Open Policy Agent:
  https://www.openpolicyagent.org/docs/latest
- Open Policy Agent policy language:
  https://www.openpolicyagent.org/docs/policy-language
- AI agent security guardrail comparison:
  https://arxiv.org/abs/2604.24826
- Guardrail robustness evaluation:
  https://arxiv.org/abs/2511.22047

Seventh-pass enterprise-agent, monitoring, and proof-binder references:

- Salesforce Agentforce APIs and SDKs:
  https://developer.salesforce.com/docs/ai/agentforce/guide/get-started-agents.html
- Salesforce Agentforce enterprise architecture fundamentals:
  https://architect.salesforce.com/docs/architect/fundamentals/guide/get-started-agentforce.html
- Microsoft Copilot Studio documentation:
  https://learn.microsoft.com/en-us/microsoft-copilot-studio
- Microsoft agent developer platform:
  https://developer.microsoft.com/en-us/agents
- Google Gemini Enterprise agents overview:
  https://docs.cloud.google.com/gemini/enterprise/docs/agents-overview
- Google Gemini Enterprise agent product page:
  https://cloud.google.com/gemini-enterprise/agents
- Google Agentspace product page:
  https://cloud.google.com/products/agentspace
- ServiceNow AI Agents product page:
  https://www.servicenow.com/products/ai-agents.html
- ServiceNow AI Agents documentation:
  https://www.servicenow.com/docs/r/12FXWPUPJJNiwgjoPO9yFQ/pl17qI~Q_kKVhWAqLU9dhQ
- ServiceNow SDK guide for building AI agents:
  https://servicenow.github.io/sdk/guides/building-ai-agents-guide
- Atlassian Rovo Agents documentation:
  https://support.atlassian.com/rovo/docs/agents/
- Atlassian Rovo product page:
  https://www.atlassian.com/software/rovo
- Atlassian Forge Rovo Agent module:
  https://developer.atlassian.com/platform/forge/manifest-reference/modules/rovo-agent/
- SAP Joule Agents product page:
  https://www.sap.com/products/artificial-intelligence/ai-agents.html
- SAP Joule development guide:
  https://help.sap.com/doc/7e70b0a09517400f95c7cba8671e60ca/CLOUD/en-US/0cc0df731bc04171a339c682bcf7c39b.pdf
- Evidently AI monitoring overview:
  https://docs.evidentlyai.com/docs/platform/monitoring_overview
- Evidently AI library overview:
  https://docs.evidentlyai.com/docs/library/overview
- WhyLabs Observe documentation:
  https://docs.whylabs.ai/docs/category/observe
- WhyLabs Observe feature walkthrough:
  https://docs.whylabs.ai/docs/whylabs-overview-observe/
- Arize Phoenix documentation:
  https://arize.com/docs/phoenix
- OpenInference semantic conventions:
  https://arize-ai.github.io/openinference/
- TruLens instrumentation overview:
  https://www.trulens.org/component_guides/instrumentation/
- TruLens runtime evaluation:
  https://www.trulens.org/component_guides/runtime_evaluation/

Eighth-pass operator-depth, cloud, protocol, runtime, and compliance references:

- Amazon Bedrock Guardrails behavior:
  https://docs.aws.amazon.com/en_us/bedrock/latest/userguide/guardrails-how.html
- Amazon Bedrock documentation hub:
  https://docs.aws.amazon.com/bedrock/
- Databricks MLflow 3 for GenAI:
  https://docs.databricks.com/aws/en/mlflow3/genai/overview/how-mlflow-helps
- MLflow GenAI documentation:
  https://mlflow.org/docs/latest/index.html
- Snowflake Cortex Agents:
  https://docs.snowflake.com/user-guide/snowflake-cortex/cortex-agents
- CrewAI documentation:
  https://docs.crewai.com/
- LangGraph documentation:
  https://docs.langchain.com/oss/python/langgraph
- LlamaIndex documentation:
  https://docs.llamaindex.ai/
- LlamaIndex agents:
  https://docs.llamaindex.ai/en/stable/module_guides/deploying/agents/
- KServe documentation:
  https://kserve.github.io/kserve/
- KServe V2 inference protocol:
  https://kserve.github.io/website/docs/concepts/architecture/data-plane/v2-protocol
- BentoML documentation:
  https://docs.bentoml.com/en/latest/
- Ray Serve LLM documentation:
  https://docs.ray.io/en/latest/serve/llm/index.html
- Modal GPU documentation:
  https://modal.com/docs/reference/modal.gpu
- OWASP Top 10 for LLM Applications:
  https://owasp.org/www-project-top-10-for-large-language-model-applications/
- OWASP LLM Top 10 2025:
  https://genai.owasp.org/resource/owasp-top-10-for-llm-applications-2025
- NIST AI Risk Management Framework:
  https://www.nist.gov/itl/ai-risk-management-framework
- NIST Generative AI Profile PDF:
  https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf
- ISO/IEC 42001 AI management system:
  https://www.iso.org/standard/81230.html
- SLSA official framework:
  https://slsa.dev/spec/latest/
- Sigstore documentation:
  https://docs.sigstore.dev/
- CloudEvents specification:
  https://cloudevents.io/
- OpenTelemetry GenAI semantic conventions:
  https://opentelemetry.io/docs/specs/semconv/gen-ai/
- OpenTelemetry GenAI agent spans:
  https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/
- Anthropic Model Context Protocol documentation:
  https://docs.anthropic.com/en/docs/mcp
- Model Context Protocol specification repository:
  https://github.com/modelcontextprotocol/modelcontextprotocol
- Google Agent2Agent protocol specification:
  https://google-a2a.github.io/A2A/specification/
- OpenAI Agents SDK:
  https://platform.openai.com/docs/guides/agents-sdk/
- OpenAI Agents SDK tracing:
  https://openai.github.io/openai-agents-js/guides/tracing/
- NVIDIA TensorRT-LLM:
  https://docs.nvidia.com/tensorrt-llm/
- OpenVINO GenAI introduction:
  https://openvinotoolkit.github.io/openvino.genai/docs/getting-started/introduction/
- OpenVINO GenAI inference:
  https://docs.openvino.ai/genai_inference
- Apple MLX:
  https://opensource.apple.com/projects/mlx/
- Hugging Face GGUF with llama.cpp:
  https://huggingface.co/docs/hub/en/gguf-llamacpp
- GGUF format reference:
  https://www.mintlify.com/ggml-org/llama.cpp/concepts/gguf-format

Ninth-pass missing-major-competitor and cohesive-market references:

- Glean Agents documentation:
  https://docs.glean.com/agents
- Glean AI agents product page:
  https://www.glean.com/product/ai-agents
- Glean API and agent context page:
  https://www.glean.com/product/api
- Cohere North:
  https://cohere.com/north
- Cohere documentation:
  https://docs.cohere.com/
- Writer AI Studio documentation:
  https://dev.writer.com/home/introduction
- Writer AI Studio launch details:
  https://writer.com/engineering/ai-studio/
- Dust Enterprise:
  https://dust.tt/home/enterprise
- Sierra product overview:
  https://sierra.ai/product
- Intercom Fin AI Agent documentation:
  https://www.intercom.com/help/en/collections/6485365-fin-ai-agent
- Intercom Fin AI Agent FAQ:
  https://www.intercom.com/help/en/articles/7837535-fin-ai-agent-faqs
- Zendesk AI Agents developer docs:
  https://developer.zendesk.com/documentation/ai-agents/
- Zendesk AI agent resources:
  https://support.zendesk.com/hc/en-us/articles/4408834322842-AI-agent-resources
- Harvey getting started:
  https://help.harvey.ai/articles/getting-started-with-harvey
- Harvey model explanation:
  https://help.harvey.ai/articles/what-ai-models-does-harvey-use
- Hebbia product page:
  https://www.hebbia.com/product
- Hebbia multi-agent Matrix redesign:
  https://www.hebbia.com/blog/divide-and-conquer-hebbias-multi-agent-redesign
- Cognition product page:
  https://cognition.ai/
- Devin documentation:
  https://docs.devin.ai/
- Baseten product page:
  https://www.baseten.com/
- Baseten reference docs:
  https://docs.baseten.co/reference
- Baseten Truss overview:
  https://www.baseten.com/blog/why-we-open-sourced-truss/
- Replicate Cog deployment docs:
  https://cog.run/deploy/
- Replicate custom model push docs:
  https://replicate.com/docs/guides/build/push-a-model/
- RunPod serverless endpoints:
  https://docs.runpod.io/serverless/endpoints/overview
- RunPod serverless CLI:
  https://docs.runpod.io/runpodctl/reference/runpodctl-serverless
- Lambda Cloud inference and GPU docs:
  https://docs.lambda.ai/public-cloud/lambda-inference-api/
- Lambda Cloud API:
  https://docs-api.lambda.ai/
- Groq documentation:
  https://console.groq.com/docs
- Groq API reference:
  https://console.groq.com/docs/api-reference
- Cerebras developer documentation:
  https://docs.cerebras.ai/
- Cerebras inference product page:
  https://www.cerebras.ai/inference
- SambaNova API reference:
  https://docs.sambanova.ai/cloud/docs/api-reference/overview
- SambaNova quickstart:
  https://docs.sambanova.ai/cloud/docs/get-started/quickstart
- Dify product page:
  https://dify.ai/
- Dify agent node documentation:
  https://docs.dify.ai/en/guides/workflow/node/agent
- n8n AI agents explanation:
  https://docs.n8n.io/advanced-ai/examples/understand-agents/
- n8n AI Agent node:
  https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/
- Flowise documentation:
  https://docs.flowiseai.com/
- Fiddler LLM monitoring:
  https://docs.fiddler.ai/observability/llm
- Fiddler documentation:
  https://docs.fiddler.ai/
- Arthur LLM evals:
  https://docs.arthur.ai/docs/get-started-with-llm-evals
- Braintrust eval docs:
  https://www.braintrust.dev/docs/evaluate
- Humanloop eval docs:
  https://humanloop.com/docs/guides/evals
- Galileo documentation:
  https://docs.galileo.ai/
- Patronus documentation:
  https://docs.patronus.ai/docs
- Credo AI product page:
  https://www.credo.ai/product
- Credo governance status documentation:
  https://knowledge.credo.ai/governance-status-documentation
- ModelOp product page:
  https://www.modelop.com/
- ModelOp lifecycle automation:
  https://www.modelop.com/ai-lifecycle-automation

Tenth-pass enterprise-AI-OS, data-development, security, developer-framework,
edge, and MLOps references:

- Palantir Foundry and AIP documentation:
  https://www.palantir.com/docs/
- Palantir AIP overview:
  https://www.palantir.com/docs/foundry/aip/overview//
- Palantir AIP architecture:
  https://palantirfoundation.org/docs/foundry/architecture-center/aip-architecture
- Databricks Mosaic AI overview:
  https://docs.databricks.com/en/machine-learning/index.html
- Databricks Mosaic AI Agent Framework:
  https://docs.databricks.com/aws/en/generative-ai/agent-framework/
- Snowflake Cortex Agents:
  https://docs.snowflake.com/user-guide/snowflake-cortex/cortex-agents
- Dataiku LLM Mesh product page:
  https://www.dataiku.com/product/llm-mesh
- Dataiku Generative AI and LLM Mesh documentation:
  https://doc.dataiku.com/dss/latest/generative-ai/index.html
- DataRobot Generative AI documentation:
  https://docs.datarobot.com/11.0/en/docs/gen-ai/index.html
- C3 Agentic AI Platform overview:
  https://docs.c3.ai/docs/platform/8.9/topic/platform-overview
- H2O.ai Enterprise h2oGPTe documentation:
  https://docs.h2o.ai/enterprise-h2ogpte/
- TrueFoundry model deployment documentation:
  https://www.truefoundry.com/docs/model-deployment/overview
- NVIDIA NIM documentation:
  https://docs.nvidia.com/nim/index.html
- NVIDIA AI Enterprise documentation:
  https://docs.nvidia.com/ai-enterprise/latest/index.html
- NVIDIA NeMo Guardrails documentation:
  https://docs.nvidia.com/nemo-guardrails/index.html
- Scale AI Data Foundry:
  https://scale.com/data-foundry
- Labelbox model evaluation documentation:
  https://docs.labelbox.com/docs/model-evaluation-overview
- Snorkel AI documentation:
  https://docs.snorkel.ai/
- Gretel documentation:
  https://docs.gretel.ai/
- Gretel synthetics documentation:
  https://docs.gretel.ai/create-synthetic-data/safe-synthetics/synthetics
- Lakera Guard documentation:
  https://docs.lakera.ai/guard
- Giskard vulnerability scanning documentation:
  https://docs.giskard.ai/hub/sdk/scan/index.html
- Microsoft Semantic Kernel documentation:
  https://learn.microsoft.com/en-us/semantic-kernel/?view=semantic-kernel-python
- Vercel AI Agents guide:
  https://vercel.com/kb/guide/ai-agents
- Pydantic AI overview:
  https://pydantic.dev/docs/ai/overview/
- Pydantic AI agents documentation:
  https://pydantic.dev/docs/ai/core-concepts/agent/
- Haystack by deepset product page:
  https://www.deepset.ai/products-and-services/haystack
- Qualcomm AI Hub documentation:
  https://app.aihub.qualcomm.com/docs/
- Google LiteRT documentation:
  https://ai.google.dev/edge/litert/overview
- Edge Impulse deployment documentation:
  https://docs.edgeimpulse.com/docs/edge-impulse-studio/deployment
- Apple Foundation Models framework:
  https://developer.apple.com/documentation/FoundationModels
- BentoCloud documentation:
  https://docs.bentoml.com/en/latest/bentocloud/
- Kubernetes AI Toolchain Operator:
  https://kaito.sh/

## 12. Local Surface Coverage Appendix

This appendix intentionally names the repo-local product IDs verbatim so future audits can diff this research blueprint against `docs/product-surfaces.json`, `docs/product-journeys.json`, and `docs/product-sota-readiness.json` without relying on fuzzy product language.

### 12.1 Certified Product Surfaces

- `identity-access-billing` - Identity, Access, Teams, And Billing
  - Primary paths: `/signup`, `/signin`, `/account`, `/pricing`, `/teams`, `/v1/account`, `/v1/billing/tiers`
  - Route groups: `account`, `anon`, `oauth`, `signin`, `signout`, `signup`, `whoami`, `keys`, `billing`, `plans`, `pricing`, `stripe`, `team`, `teams`
  - Competitor refs: `workos-identity`, `auth0-organizations`, `stripe-billing`, `stripe-portal`
  - Certification: local_gates: 3 gates; prod_gates: 3 gates; slo: 99.9% auth and billing control-plane availability; blockers: 0 gates; certified_at: 2026-05-20T13:03:06+08:00; certified_by: local release gates: lint:refs, local:surfaces:deep, ui:audit:critical, focused backend tests
  - Production smoke: `billing-tiers-public` - GET - `/v1/billing/tiers`
  - Production smoke: `whoami-auth` - GET - `/v1/whoami`
  - Production smoke: `account-auth` - GET - `/v1/account`
  - Production smoke: `account-keys-auth` - GET - `/v1/account/keys`
  - Production smoke: `teams-auth` - GET - `/v1/teams`
  - Production smoke: `billing-usage-auth` - GET - `/v1/billing/usage`
- `public-docs-sdk` - Public Site, Docs, API Reference, And SDK Distribution
  - Primary paths: `/`, `/docs`, `/docs/api`, `/openapi.json`, `/sdk-current.json`, `/v1/product/experience`, `/v1/spec`
  - Route groups: `system`, `health`, `status`, `public`, `changelog`, `product`, `spec`, `spec-decode`, `library`, `recipes`, `registry`
  - Competitor refs: `openai-finetune`, `langsmith-evals`
  - Certification: local_gates: 4 gates; prod_gates: 3 gates; slo: 99.9% public docs and SDK asset availability; blockers: 0 gates; certified_at: 2026-05-20T13:03:06+08:00; certified_by: local release gates: lint:refs, local:surfaces:deep, ui:audit:critical, focused backend tests
  - Production smoke: `health` - GET - `/health`
  - Production smoke: `ready` - GET - `/ready`
  - Production smoke: `docs-api` - GET - `/docs/api`
  - Production smoke: `openapi` - GET - `/openapi.json`
  - Production smoke: `api-routes` - GET - `/docs/api-routes.json`
  - Production smoke: `sdk-current` - GET - `/sdk-current.json`
  - Production smoke: `spec-public` - GET - `/v1/spec`
- `compile-artifact-verification` - Compile, Artifact, Registry, Receipts, And Verification
  - Primary paths: `/build-your-own`, `/compile`, `/run`, `/registry`, `/v1/compile`, `/v1/artifacts`, `/v1/verify`
  - Route groups: `build`, `builds`, `builder`, `compile`, `jobs`, `synthesize`, `artifacts`, `artifact`, `cid`, `receipts`, `verify`, `sigstore`, `credential`, `publish`, `marketplace`, `hub`
  - Competitor refs: `openai-finetune`, `predibase-finetune`, `together-finetune`, `openpipe-finetune`, `aws-bedrock-custom-models`
  - Certification: local_gates: 3 gates; prod_gates: 3 gates; slo: 99% compile control-plane availability; artifact verification must be deterministic; blockers: 0 gates; certified_at: 2026-05-20T13:03:06+08:00; certified_by: local release gates: lint:refs, local:surfaces:deep, ui:audit:critical, focused backend tests
  - Production smoke: `compile-list-auth` - GET - `/v1/compile`
  - Production smoke: `artifact-list-auth` - GET - `/v1/artifacts`
  - Production smoke: `registry-public` - GET - `/v1/registry/public`
  - Production smoke: `marketplace-catalog` - GET - `/v1/marketplace/catalog.json`
  - Production smoke: `hub-public` - GET - `/v1/hub`
  - Production smoke: `sigstore-health` - GET - `/v1/sigstore/health`
  - Production smoke: `compile-deep-auth` - POST - `/v1/compile`
- `runtime-inference-connectors` - Runtime, Inference, Connectors, And Multimodal APIs
  - Primary paths: `/run`, `/models`, `/integrations/openai-sdk`, `/integrations/anthropic-sdk`, `/v1/chat/completions`, `/v1/responses`, `/v1/models`
  - Route groups: `run`, `runtime`, `chat`, `responses`, `messages`, `embeddings`, `embed`, `moderations`, `models`, `connectors`, `openrouter`, `gemini`, `wrap`, `verified-inference`, `assistant`, `compose`, `audio`, `media`, `multimodal`, `search`, `streaming`, `redact`
  - Competitor refs: `openai-prompt-caching`, `anthropic-prompt-caching`, `langsmith-observability`, `arize-phoenix`
  - Certification: local_gates: 3 gates; prod_gates: 5 gates; slo: p99 runtime control-plane latency under 500 ms for metadata routes; blockers: 0 gates; certified_at: 2026-05-20T13:03:06+08:00; certified_by: local release gates: lint:refs, local:surfaces:deep, ui:audit:critical, focused backend tests
  - Production smoke: `models-auth` - GET - `/v1/models`
  - Production smoke: `connectors-auth` - GET - `/v1/connectors`
  - Production smoke: `runtime-policy-auth` - GET - `/v1/runtime/policy`
  - Production smoke: `runtime-stats-auth` - GET - `/v1/runtime/replacement-stats`
  - Production smoke: `media-redact-doctor` - GET - `/v1/media/redact-job/doctor`
  - Production smoke: `multimodal-audio-doctor` - GET - `/v1/multimodal/redact-audio/doctor`
  - Production smoke: `runtime-decide-deep-auth` - POST - `/v1/runtime/decide`
  - Production smoke: `chat-wrapper-deep-auth` - POST - `/v1/chat/completions`
  - Production smoke: `responses-wrapper-deep-auth` - POST - `/v1/responses`
- `capture-data-eval-training` - Capture, Datasets, Evals, Labels, Training, And Improvement Loop
  - Primary paths: `/capture`, `/training`, `/distill`, `/account/datasets`, `/account/lake`, `/v1/capture/log`, `/v1/datasets`, `/v1/distill/from-captures`
  - Route groups: `capture`, `bridges`, `datasets`, `eval`, `label-queue`, `labels`, `lake`, `distill`, `training`, `opportunities`, `sim`, `simulations`, `bakeoff`, `bakeoffs`, `workflows`, `seeds`, `replay`, `recall`, `memory`, `pipeline`, `specialists`, `drift`, `nl`, `intent`, `ir`
  - Competitor refs: `langsmith-evals`, `arize-phoenix`, `wandb-weave`, `openpipe-finetune`, `predibase-finetune`
  - Certification: local_gates: 3 gates; prod_gates: 4 gates; slo: 99% capture ingest availability; zero cross-tenant dataset leakage; blockers: 0 gates; certified_at: 2026-05-20T13:03:06+08:00; certified_by: local release gates: lint:refs, local:surfaces:deep, ui:audit:critical, focused backend tests
  - Production smoke: `capture-health-auth` - GET - `/v1/capture/health`
  - Production smoke: `bridges-observations-auth` - GET - `/v1/bridges/observations?limit=5`
  - Production smoke: `datasets-auth` - GET - `/v1/datasets`
  - Production smoke: `lake-stats-auth` - GET - `/v1/lake/stats`
  - Production smoke: `label-queue-stats-auth` - GET - `/v1/label-queue/stats`
  - Production smoke: `distill-preview-auth` - GET - `/v1/distill/from-captures/preview`
  - Production smoke: `distill-onpolicy-doctor` - GET - `/v1/distill/onpolicy/doctor`
  - Production smoke: `distill-preference-doctor` - GET - `/v1/distill/preference/doctor`
  - Production smoke: `capture-log-deep-auth` - POST - `/v1/capture/log`
  - Production smoke: `training-plan-deep-auth` - POST - `/v1/training/plan`
- `governance-compliance-security` - Governance, Compliance, Admin, Audit, Privacy, Trace, And Notifications
  - Primary paths: `/security`, `/privacy`, `/enterprise`, `/account/audit-log`, `/v1/audit/log`, `/v1/privacy/scan`, `/v1/trace/append`
  - Route groups: `admin`, `audit`, `privacy`, `notifications`, `trace`, `telemetry`, `lineage`, `concepts`, `agents`, `session`, `lead`, `loop`
  - Competitor refs: `langsmith-observability`, `arize-phoenix`, `wandb-weave`, `workos-identity`
  - Certification: local_gates: 4 gates; prod_gates: 4 gates; slo: audit export and privacy policy routes must never expose cross-tenant data; blockers: 0 gates; certified_at: 2026-05-20T13:03:06+08:00; certified_by: local release gates: lint:refs, local:surfaces:deep, ui:audit:critical, focused backend tests
  - Production smoke: `audit-log-auth` - GET - `/v1/audit/log`
  - Production smoke: `audit-verify-auth` - GET - `/v1/audit/verify`
  - Production smoke: `privacy-policy` - GET - `/v1/privacy/policy`
  - Production smoke: `privacy-report-auth` - GET - `/v1/privacy/report`
  - Production smoke: `notifications-state-auth` - GET - `/v1/notifications/state`
  - Production smoke: `trace-providers-auth` - GET - `/v1/trace/translate/providers`
  - Production smoke: `account-compliance-package-auth` - GET - `/v1/account/compliance-package`
  - Production smoke: `privacy-scan-deep` - POST - `/v1/privacy/scan`
  - Production smoke: `trace-append-deep-auth` - POST - `/v1/trace/append`
- `deployment-edge-federated` - Deployment, Edge Devices, BYOC, Storage, Sync, Tunnel, And Federated Learning
  - Primary paths: `/device`, `/byoc`, `/self-host`, `/tunnels`, `/v1/devices`, `/v1/cloud/readiness`, `/v1/byoc/deployments`, `/v1/storage/object-readiness`, `/v1/storage/config`
  - Route groups: `device`, `devices`, `capability`, `cc`, `fl`, `federated`, `byoc`, `cloud`, `storage`, `sync`, `tunnel`, `tunnels`
  - Competitor refs: `apple-coreml`, `apple-foundation-models`, `google-litert`, `onnx-runtime-mobile`, `executorch`, `aws-bedrock-custom-models`
  - Certification: local_gates: 5 gates; prod_gates: 4 gates; slo: device and deployment control-plane routes must degrade gracefully and never leak cross-tenant state; blockers: 0 gates; certified_at: 2026-05-20T13:03:06+08:00; certified_by: local release gates: lint:refs, local:surfaces:deep, ui:audit:critical, focused backend tests
  - Production smoke: `devices-auth` - GET - `/v1/devices`
  - Production smoke: `devices-detect` - GET - `/v1/devices/detect`
  - Production smoke: `storage-config` - GET - `/v1/storage/config`
  - Production smoke: `byoc-targets` - GET - `/v1/byoc/targets`
  - Production smoke: `sync-status-auth` - GET - `/v1/sync/status`
  - Production smoke: `tunnels-auth` - GET - `/v1/tunnels`
  - Production smoke: `federated-peers-auth` - GET - `/v1/federated/peers`
  - Production smoke: `fl-strategies` - GET - `/v1/fl/strategies`
  - Production smoke: `cc-kinds` - GET - `/v1/cc/kinds`
  - Production smoke: `device-recommend-deep` - POST - `/v1/devices/recommend`

### 12.2 Product Journey Contracts

- `gateway-capture` on surface `gateway-capture`
  - Happy path: connect provider -> send request -> capture receipt -> filter or zero-store -> promote useful rows
  - Customization dimensions: `model-provider`, `privacy-mode`, `deployment-mode`
  - Evidence paths: `src/product-experience.js`, `src/router.js`, `src/daemon-connector.js`, `public/account/connectors.html`
- `privacy-lake` on surface `privacy-lake`
  - Happy path: view lake -> filter events -> scan privacy -> export evidence -> configure retention
  - Customization dimensions: `privacy-mode`, `storage-plane`, `proof-mode`
  - Evidence paths: `src/lake.js`, `src/privacy-membrane.js`, `src/event-store.js`, `public/account/lake.html`
- `datasets-labeling` on surface `datasets-labeling`
  - Happy path: rank opportunities -> review labels -> create dataset -> split holdout -> run bakeoff
  - Customization dimensions: `proof-mode`, `privacy-mode`, `model-provider`
  - Evidence paths: `src/dataset-workbench.js`, `src/simulation.js`, `public/account/datasets.html`, `public/account/labeling.html`
- `train-distill` on surface `train-distill`
  - Happy path: choose dataset -> choose teacher -> choose student -> choose compute -> run eval-gated build
  - Customization dimensions: `model-provider`, `compute-target`, `artifact-runtime`, `proof-mode`
  - Evidence paths: `src/distill-pipeline.js`, `src/remote-compute.js`, `src/compute/registry.json`, `public/account/builds.html`
- `models-backbones` on surface `models-backbones`
  - Happy path: inspect model catalog -> recommend by task/device -> check license and modality -> bind to compile or distill spec -> verify runtime target fit
  - Customization dimensions: `model-provider`, `compute-target`, `artifact-runtime`, `proof-mode`
  - Evidence paths: `src/models.js`, `src/model-registry.js`, `src/model-weights-manifest.js`, `public/models.html`
- `multimodal-tokenization` on surface `multimodal-tokenization`
  - Happy path: detect modality -> emit local feature sidecar -> capture media event -> review generated rows -> run multimodal bakeoff
  - Customization dimensions: `privacy-mode`, `model-provider`, `storage-plane`, `proof-mode`
  - Evidence paths: `services/embed/multimodal.js`, `public/account/multimodal-bakeoff.html`, `tests/wave552-gemma-multimodal-account.test.js`
- `compile-verify` on surface `compile-verify`
  - Happy path: compile -> verify -> inspect -> diff -> export target
  - Customization dimensions: `artifact-runtime`, `proof-mode`, `storage-plane`
  - Evidence paths: `src/compile-pipeline.js`, `src/artifact.js`, `docs/kolm-format-v1.md`, `public/account/artifacts.html`
- `runtime-inference` on surface `runtime-inference`
  - Happy path: select model -> select runtime -> run request -> stream result -> log receipt
  - Customization dimensions: `model-provider`, `artifact-runtime`, `deployment-mode`, `compute-target`
  - Evidence paths: `src/completions-api.js`, `src/runtime-policy.js`, `public/sdk.js`, `public/tui.html`
- `compute-cloud` on surface `compute-cloud`
  - Happy path: run readiness -> pick storage -> pick GPU/train backend -> deploy BYOC -> verify attestation
  - Customization dimensions: `compute-target`, `storage-plane`, `deployment-mode`, `governance-mode`
  - Evidence paths: `src/platform-capabilities.js`, `src/object-storage.js`, `src/remote-compute.js`, `docs/cloud-product-readiness.md`, `scripts/cloud-readiness.mjs`
- `devices-fleet` on surface `devices-fleet`
  - Happy path: detect device -> recommend target -> open team tunnel if needed -> install artifact -> test run -> audit install
  - Customization dimensions: `compute-target`, `artifact-runtime`, `deployment-mode`
  - Evidence paths: `src/device-capabilities.js`, `src/router.js`, `public/account/devices.html`
- `enterprise-governance` on surface `enterprise-governance`
  - Happy path: verify tenant -> scope keys -> review audit -> set billing plan -> export compliance pack
  - Customization dimensions: `governance-mode`, `privacy-mode`, `storage-plane`, `proof-mode`
  - Evidence paths: `src/auth.js`, `src/keys.js`, `src/audit.js`, `public/account/api-keys.html`, `public/account/audit-log.html`
- `agents-registry` on surface `agents-registry`
  - Happy path: compile as MCP -> serve tools -> install harness -> run agent -> inspect logs
  - Customization dimensions: `deployment-mode`, `governance-mode`, `proof-mode`
  - Evidence paths: `services/mcp/server.js`, `cli/kolm.js`, `public/account/agent-telemetry.html`

### 12.3 SOTA Readiness Ledger

- Readiness group `format-standard`
  - P0 `kolm-format-spec` status `shipped`: Publish version-pinned .kolm v1/RS-1 format specification with ZIP members and compatibility rules.
  - P0 `standalone-verify` status `implemented`: Offline verifier can validate artifact signatures without hosted Kolm.
  - P1 `foundation-standardization` status `needs_external_partner`: Submit or steward the .kolm format through a neutral standards/foundation process.
  - P1 `ecosystem-runtime-adoption` status `needs_external_partner`: Get third-party runtime support from Hugging Face, Ollama, llama.cpp, ONNX/GGUF tooling, and hardware vendors.
- Readiness group `compile-train-distill`
  - P0 `k-score-calibration` status `needs_public_benchmark_data`: K-score is computed per artifact, gates composite and axes, and needs public calibration methodology before broad claims.
  - P0 `holdout-independence` status `shipped`: Train/eval split integrity is locked by row hashes, holdout gates, and production-ready checks.
  - P1 `incremental-compile` status `implemented`: Recompile against new captured data without rebuilding the whole namespace.
  - P0 `compile-failure-diagnostics` status `shipped`: When K-score or gates fail, CLI/API prints failing cases, gate reasons, and next actions.
  - P0 `async-compile-webhooks` status `implemented`: Hosted compile is async, returns job ids, and supports deploy/webhook notification hooks.
  - P1 `compile-cache` status `implemented`: Repeated compile/runtime work uses deterministic cache keys where safe.
  - P1 `export-quantize-targets` status `implemented`: Compiler binds exported GGUF/ONNX/Safetensors/CoreML/MLX/ExecuTorch/TensorRT targets with provenance.
- Readiness group `capture-gateway-lake`
  - P0 `openai-anthropic-gateway` status `shipped`: OpenAI-compatible and Anthropic-native gateway/capture paths both exist and are not OpenAI-only.
  - P0 `zero-retention-mode` status `shipped`: Per-request zero-retention/no-store mode forwards calls without persisting capture/event rows.
  - P1 `capture-filtering` status `shipped`: Operators can reduce lake noise by filtering captured events by provider/model/status/latency/namespace.
  - P0 `event-lake-schema` status `implemented`: Local event lake has canonical schema, spend, latency, redaction, provider, and exportable rows.
  - P0 `redaction-quality` status `needs_public_benchmark_data`: PII/PHI redaction is fail-closed and class-counted; public F1 methodology still needs published benchmark data.
  - P1 `differential-privacy` status `shipped`: Lake aggregates can be returned with deterministic Laplace differential privacy noise.
  - P1 `opentelemetry` status `implemented`: OTLP/OpenTelemetry hooks exist for request/artifact telemetry.
  - P0 `team-capture-rbac` status `implemented`: Team capture, tenant fencing, and role/key scope controls are represented across auth, account, and audit surfaces.
- Readiness group `runtime-compute`
  - P0 `runtime-local-artifact` status `shipped`: Signed .kolm artifacts run locally and expose receipts through CLI/API/MCP.
  - P1 `runtime-wasm` status `needs_package_release`: Browser/WASM runtime is packaged for web embedding.
  - P1 `runtime-edge` status `implemented`: Edge/serverless runtime story exists for Cloudflare/Vercel/Deno-style deployments.
  - P1 `ios-android-sdk` status `needs_package_release`: Mobile SDK source exists for iOS/Android/React Native; package publication remains external.
  - P1 `compute-openvino-qnn` status `shipped`: Local compute matrix covers OpenVINO and Qualcomm QNN/Hexagon in addition to CPU/CUDA/MPS/ROCm/DirectML.
  - P1 `runtime-telemetry-opt-in` status `implemented`: Runtime telemetry can be emitted through local logs and OTEL when explicitly enabled.
  - P2 `runtime-lts` status `implemented`: Runtime compatibility and LTS policy is documented for v1 artifacts.
- Readiness group `registry-marketplace`
  - P1 `registry-search` status `implemented`: Registry/marketplace exposes artifact search/discovery by category, license, verified state, and K-score.
  - P1 `version-diff` status `implemented`: Artifact/version diff and rollback surfaces exist for governance.
  - P2 `deploy-buttons` status `implemented`: One-click deploy plans and button metadata exist for BYOC, edge, SSH, GPU, and managed training targets.
  - P1 `verified-publishers` status `implemented`: Registry supports publisher badge policy, verification evaluation, and artifact-level readiness metadata.
  - P0 `private-registry` status `implemented`: Private tenant registry/account artifact inventory exists; air-gapped/private registry productization needs deployment proof.
  - P2 `dependency-graphs` status `implemented`: Artifact dependency graph and blast-radius inspection are generated from manifest/provenance metadata.
- Readiness group `infrastructure-enterprise`
  - P0 `artifact-signing-pipeline` status `shipped`: Artifact signing, receipts, verification, rotation, auditor attestations, and Sigstore hooks exist.
  - P1 `model-routing` status `implemented`: Provider/model routing exists across OpenAI, Anthropic, OpenRouter, Gemini, local, and compute backends.
  - P0 `benchmarking-infra` status `needs_public_benchmark_data`: Benchmark harness and hardware/model catalog exist; public reproducible leaderboard data needs publication.
  - P1 `shadow-mode` status `implemented`: Replay, bakeoff, trace, and eval surfaces can compare candidates before promotion.
  - P0 `cost-attribution` status `implemented`: Spend attribution by tenant/namespace/provider/model/billing period exists.
  - P0 `rate-limits-quotas` status `shipped`: Per-tenant rate limiting and quota enforcement are in the auth middleware.
  - P1 `webhooks-events` status `implemented`: Compile/deploy hooks, billing webhook handling, and event/audit surfaces exist.
  - P1 `sdk-depth` status `needs_package_release`: Node, Python, MCP, VS Code, C, Rust, TypeScript package, Swift, Kotlin, and React Native SDK surfaces exist locally.
  - P0 `secrets-management` status `implemented`: API keys are scoped/hashed, local BYOK secrets are encrypted, and external Vault/1Password/AWS/GCP/Azure refs stay out of artifacts.
  - P0 `compliance-certifications` status `needs_live_certification`: SOC 2, ISO 27001, HIPAA BAA, GDPR, FedRAMP, and formal SLSA/SBOM evidence require live certification/auditor process.
- Readiness group `ai-ml-optimizer`
  - P2 `prompt-compression` status `implemented`: Deterministic prompt compression is wired into runtime policy while public performance claims remain benchmark-scoped.
  - P1 `semantic-cache` status `implemented`: Exact and semantic runtime caches are wired into gateway decisions with TTL, threshold, and policy controls.
  - P1 `fallback-chains` status `implemented`: Fallback/provider chains exist in connectors, model routing, and runtime copy; explicit per-artifact policy needs tighter enforcement.
  - P0 `quality-scoring` status `needs_public_benchmark_data`: K-score, bakeoff, eval, and production-ready verdicts score artifact quality; per-call judge quality needs calibration data.
  - P1 `rag-artifact` status `implemented`: RAG/index sidecars are available to artifact recipes through the runtime; dense/rerank variants remain dependency-gated.
  - P1 `streaming` status `implemented`: Streaming/SSE support has a provider parity contract, normalizer, capture live tail, and route-level capability endpoint.
  - P0 `token-budget` status `implemented`: Runtime policy and artifact execution enforce explicit token/input budgets before model calls or recipe execution.
  - P0 `evals-ab` status `implemented`: A/B bakeoff, replay, trace verification, evals, and statistical comparison surfaces exist.
- Readiness group `developer-experience`
  - P0 `cli-world-class` status `shipped`: CLI exposes the full product loop with compile, train, distill, verify, run, TUI, doctor, cache, models, compute, MCP, billing, and deploy paths.
  - P0 `compile-as-mcp` status `shipped`: `kolm compile --as-mcp` creates project-local MCP config and skill sidecars for agents.
  - P0 `local-account-ui` status `implemented`: Account UI covers the gateway, capture, lake, privacy, repeated workflows, opportunities, labels, datasets, simulations, bakeoffs, builds, artifacts, devices, storage, billing, and settings surfaces.
  - P0 `doctor-diagnostics` status `shipped`: `kolm doctor` diagnoses environment, keys, toolchain, project, and K-score issues.
  - P1 `one-line-install` status `needs_package_release`: Install scripts exist; public package-manager channels need release-backed publication.

### 12.4 Local Research Reference IDs

Product-surface research refs:
- `openai-finetune` (provider-model-customization): OpenAI supervised fine-tuning - https://platform.openai.com/docs/guides/supervised-fine-tuning
- `openai-prompt-caching` (gateway-runtime-optimization): OpenAI prompt caching - https://platform.openai.com/docs/guides/prompt-caching
- `anthropic-prompt-caching` (gateway-runtime-optimization): Anthropic prompt caching - https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
- `langsmith-evals` (observability-evaluation): LangSmith evaluation concepts - https://docs.langchain.com/langsmith/evaluation-concepts
- `langsmith-observability` (observability-evaluation): LangSmith observability - https://docs.langchain.com/langsmith/observability
- `arize-phoenix` (observability-evaluation): Arize Phoenix - https://arize.com/docs/phoenix
- `wandb-weave` (observability-evaluation): W&B Weave - https://docs.wandb.ai/weave/
- `predibase-finetune` (model-customization): Predibase fine-tuning overview - https://docs.predibase.com/fine-tuning/overview
- `together-finetune` (model-customization): Together AI fine-tuning - https://docs.together.ai/docs/fine-tuning-overview
- `openpipe-finetune` (model-customization): OpenPipe fine-tuning quick start - https://docs.openpipe.ai/features/fine-tuning/quick-start
- `openrouter-gateway` (gateway-runtime-optimization): OpenRouter API and model routing docs - https://openrouter.ai/docs/api-reference/overview
- `litellm-gateway` (gateway-runtime-optimization): LiteLLM Gateway - https://www.litellm.ai/
- `portkey-gateway` (gateway-runtime-optimization): Portkey AI Gateway - https://portkey-docs.mintlify.dev/docs/product/ai-gateway
- `langfuse-observability` (observability-evaluation): Langfuse observability overview - https://langfuse.com/docs/observability/overview
- `helicone-observability` (observability-evaluation): Helicone AI gateway and observability - https://github.com/Helicone/helicone
- `lorax-serving` (model-serving): Predibase LoRAX multi-LoRA server - https://github.com/predibase/lorax
- `fireworks-lora-serving` (model-serving): Fireworks LoRA deployment docs - https://docs.fireworks.ai/fine-tuning/deploying-loras
- `arcee-distillation-slm` (model-customization): Arcee Small Language Models - https://docs.arcee.ai/arcee-conductor/arcee-small-language-models
- `google-gemma-3n` (edge-runtime): Gemma 3n model overview - https://ai.google.dev/gemma/docs/gemma-3n
- `aws-bedrock-custom-models` (model-customization): Amazon Bedrock model customization - https://docs.aws.amazon.com/bedrock/latest/userguide/custom-models.html
- `workos-identity` (identity-access): WorkOS docs - https://workos.com/docs
- `auth0-organizations` (identity-access): Auth0 Organizations - https://auth0.com/docs/organizations
- `stripe-billing` (billing): Stripe Billing - https://stripe.com/billing/features
- `stripe-portal` (billing): Stripe customer portal - https://docs.stripe.com/billing/subscriptions/customer-portal
- `apple-coreml` (edge-runtime): Apple Core ML - https://developer.apple.com/documentation/CoreML
- `apple-foundation-models` (edge-runtime): Apple Foundation Models - https://developer.apple.com/documentation/FoundationModels
- `google-litert` (edge-runtime): Google LiteRT - https://ai.google.dev/edge/litert/overview
- `onnx-runtime-mobile` (edge-runtime): ONNX Runtime Mobile - https://onnxruntime.ai/docs/tutorials/mobile/
- `executorch` (edge-runtime): PyTorch ExecuTorch - https://docs.pytorch.org/executorch/stable/intro-overview.html

Product-journey research refs:
- `openai-distillation-evals`: https://openai.com/index/api-model-distillation/
- `anthropic-messages-api`: https://docs.anthropic.com/en/api/overview
- `cloudflare-ai-gateway`: https://developers.cloudflare.com/ai-gateway/
- `vercel-ai-gateway`: https://vercel.com/docs/ai-gateway/
- `opentelemetry-genai`: https://opentelemetry.io/docs/specs/semconv/gen-ai/
- `vllm-openai-compatible`: https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html
- `onnx-runtime`: https://onnxruntime.ai/docs
- `executorch-edge`: https://docs.pytorch.org/get-started/executorch/
- `workos-enterprise`: https://workos.com/docs


## 13. Final Operating Model

The most valuable Kolm operating model is:

- Capture is acquisition.
- Evals are trust.
- Compile is conversion.
- Artifact verification is the moat.
- Runtime portability is expansion.
- Registry is ecosystem.
- Enterprise evidence is monetization.

Every product surface should be judged by whether it increases one of these:

1. More high-quality captured evidence.
2. Stronger proof that evidence is safe and representative.
3. Faster path from evidence to artifact.
4. More places artifacts can run.
5. More confidence artifacts can be audited.
6. More third parties who can verify and distribute artifacts.

If a feature does not improve one of those six loops, it is probably surface
area, not product depth.
