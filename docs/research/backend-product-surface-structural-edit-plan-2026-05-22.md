# Kolm Backend Product Surface Structural Edit Plan

Date: 2026-05-22

Status: research-backed structural edit plan. This is not a claim that the
edits are already shipped. It is the cut-once blueprint for making the backend,
spec logic, product surfaces, CLI, TUI, account UI, docs, runtime, training,
distillation, compile, verification, cloud, governance, and enterprise paths
feel like one finished infrastructure product.

## 0. Thesis

Kolm should not be structured as a collection of many impressive but separate
surfaces. The product should be structured as one evidence-to-artifact operating
system:

1. Capture real behavior.
2. Normalize it into governed evidence.
3. Convert evidence into datasets, labels, evals, and replay suites.
4. Train, distill, route, compress, or compile only when the evidence says that
   is the right move.
5. Emit a signed `.kolm` artifact with manifest, splits, evals, receipts,
   lineage, policy, runtime targets, and rollback metadata.
6. Run that artifact across local hardware, hosted GPU, BYOC, browser, edge,
   mobile, serverless, Kubernetes, and air-gapped environments.
7. Prove every decision to developers, admins, buyers, auditors, and future
   maintainers.

The structural problem to solve is not "add more features." The structural
problem is "make every surface speak the same contract." Every route, CLI verb,
TUI view, account panel, docs page, SDK method, job, artifact, benchmark, and
receipt should be explainable through the same spine:

`evidence -> dataset -> eval -> build decision -> artifact -> runtime -> receipt -> governance export`

Anything outside that spine should either be folded back into it, downgraded to
an integration, or removed from the primary path.

## 1. Local Evidence Read

This pass used the repo-local product specs and verification commands as the
source of truth.

### 1.1 Product surface catalog

`docs/product-surfaces.json` defines seven certified product surfaces:

| Surface | Route groups | Primary paths | Code path count | Local status |
| --- | ---: | ---: | ---: | --- |
| `identity-access-billing` | 14 | 7 | 6 | certified |
| `public-docs-sdk` | 11 | 7 | 6 | certified |
| `compile-artifact-verification` | 16 | 7 | 8 | certified |
| `runtime-inference-connectors` | 22 | 7 | 9 | certified |
| `capture-data-eval-training` | 25 | 8 | 11 | certified |
| `governance-compliance-security` | 12 | 7 | 7 | certified |
| `deployment-edge-federated` | 12 | 9 | 13 | certified |

The catalog is good. The next structural step is to make it executable enough
that it becomes the single product graph. Today it is a registry and verifier
input. It should become the generator for:

- account navigation
- CLI help groupings
- TUI view groupings
- OpenAPI tags
- docs IA
- production smoke probes
- route ownership
- billing entitlement gates
- support runbooks
- release notes

### 1.2 Product journey catalog

`docs/product-journeys.json` defines twelve user-facing journeys:

| Journey | Evidence paths |
| --- | --- |
| `gateway-capture` | `src/product-experience.js`, `src/router.js`, `src/daemon-connector.js`, `public/account/connectors.html` |
| `privacy-lake` | `src/lake.js`, `src/privacy-membrane.js`, `src/event-store.js`, `public/account/lake.html` |
| `datasets-labeling` | `src/dataset-workbench.js`, `src/simulation.js`, `public/account/datasets.html`, `public/account/labeling.html` |
| `train-distill` | `src/distill-pipeline.js`, `src/remote-compute.js`, `src/compute/registry.json`, `public/account/builds.html` |
| `models-backbones` | `src/models.js`, `src/model-registry.js`, `src/model-weights-manifest.js`, `public/models.html` |
| `multimodal-tokenization` | `services/embed/multimodal.js`, `public/account/multimodal-bakeoff.html`, `tests/wave552-gemma-multimodal-account.test.js` |
| `compile-verify` | `src/compile-pipeline.js`, `src/artifact.js`, `docs/kolm-format-v1.md`, `public/account/artifacts.html` |
| `runtime-inference` | `src/completions-api.js`, `src/runtime-policy.js`, `public/sdk.js`, `public/tui.html` |
| `compute-cloud` | `src/platform-capabilities.js`, `src/object-storage.js`, `src/remote-compute.js`, `docs/cloud-product-readiness.md`, `scripts/cloud-readiness.mjs` |
| `devices-fleet` | `src/device-capabilities.js`, `src/router.js`, `public/account/devices.html` |
| `enterprise-governance` | `src/auth.js`, `src/keys.js`, `src/audit.js`, `public/account/api-keys.html`, `public/account/audit-log.html` |
| `agents-registry` | `services/mcp/server.js`, `cli/kolm.js`, `public/account/agent-telemetry.html` |

The journey map is the better product shape than the seven-surface catalog for
user experience. The catalog should stay as route ownership. The journey map
should drive how the product is actually navigated.

### 1.3 Readiness ledger

`docs/product-sota-readiness.json` defines eight readiness groups and 55
requirements.

Current local readiness verifier output:

| Status | Count | Meaning |
| --- | ---: | --- |
| `shipped` | 14 | local code and tests exist |
| `implemented` | 30 | local implementation exists, but may need live config, package release, or deployment |
| `needs_external_partner` | 2 | requires external standards/runtime/vendor adoption |
| `needs_public_benchmark_data` | 4 | cannot be marketed as best-in-class without public benchmark data |
| `needs_package_release` | 4 | code exists locally, but public package/channel release is external |
| `needs_live_certification` | 1 | requires formal auditor/compliance certification |

This is the honest gap list. The biggest structural improvement is to stop
arguing whether the code is "100 percent" and instead make these statuses
visible in every product surface:

- account UI readiness badge
- CLI `kolm status`
- TUI status rail
- docs feature matrix
- OpenAPI `x-kolm-readiness`
- route response envelopes
- pricing/enterprise copy
- release verifier output

### 1.4 Codegraph and journey checks

Local verification commands reported:

| Check | Result |
| --- | --- |
| `npm run verify:journeys` | ok |
| Product journeys | 12 |
| Account links | 33 |
| CLI commands | 55 |
| TUI views | 19 |
| API routes in journey audit | 69 |
| `npm run verify:codegraph` | ok |
| Codegraph files | 1,497 |
| Imports | 4,640 |
| Symbols | 5,200 |
| Routes | 545 |
| Scripts | 28 |
| Readiness requirements | 55 |
| Missing readiness evidence | 0 |
| `npm run verify:sota` | ok with warning |

This says the repo is not sparse. The risk is not missing surface area. The risk
is too much surface area without one canonical operating model.

### 1.5 Implementation concentration

The largest code concentration is:

- `cli/kolm.js`: 25,786 lines
- `src/router.js`: 11,633 lines
- `src/model-registry.js`: 1,549 lines
- `src/platform-capabilities.js`: product capability matrix
- `src/compute/registry.json`: 21 compute backends

This does not mean the code is bad. It means Kolm has reached the point where
the next quality jump requires a stronger internal product kernel:

- route modules instead of one expanding router
- CLI command registry instead of one massive command file
- canonical product graph instead of duplicated copy in account/docs/CLI/TUI
- durable job and storage abstractions
- provider and compute contracts that are executable, not descriptive

## 2. External State Of The Art Baseline

The following external systems define buyer expectations. Kolm does not need to
copy each system. Kolm needs to make a clear promise above them.

### 2.1 Gateway and model access baseline

State of the art gateways now provide:

- unified model API
- usage analytics
- budgets
- rate limits
- logs
- caching
- retries
- fallback routing
- provider-level model routing
- enterprise controls

Reference products and docs:

- Cloudflare AI Gateway: https://developers.cloudflare.com/ai-gateway/
- Vercel AI Gateway: https://vercel.com/docs/ai-gateway/
- OpenRouter API: https://openrouter.ai/docs/api-reference/overview
- LiteLLM Gateway: https://docs.litellm.ai/docs/proxy/quick_start
- Portkey AI Gateway: https://portkey-docs.mintlify.dev/docs/product/ai-gateway

Kolm implication:

Gateway features are table stakes. Kolm wins only if gateway traffic becomes
compile-ready evidence and every captured call can graduate into datasets,
evals, artifacts, and receipts. Do not market gateway alone as the wedge.

### 2.2 Observability and eval baseline

State of the art LLM observability now provides:

- traces
- spans
- datasets
- experiments
- online evals
- offline evals
- regression testing
- human review
- prompt/version comparison
- production quality monitoring

Reference products and docs:

- LangSmith evaluation concepts: https://docs.langchain.com/langsmith/evaluation-concepts
- LangSmith observability: https://docs.langchain.com/langsmith/observability
- Langfuse observability: https://langfuse.com/docs/observability/overview
- Arize Phoenix: https://arize.com/docs/phoenix
- W&B Weave: https://docs.wandb.ai/weave/
- Braintrust evals: https://www.braintrust.dev/docs/evaluate
- Humanloop evals: https://humanloop.com/docs/guides/evals
- OpenTelemetry GenAI semantic conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/

Kolm implication:

Traces and evals are not the product moat. The moat is binding traces and evals
into an artifact that can run and be verified outside the observability vendor.

### 2.3 Training, distillation, and fine-tuning baseline

State of the art model customization provides:

- supervised fine-tuning
- distillation from stronger teachers
- LoRA and QLoRA
- hosted jobs
- model evaluation
- model deployment
- imported adapter serving
- trace-to-fine-tune loops

Reference products and docs:

- OpenAI model distillation: https://openai.com/index/api-model-distillation/
- OpenAI fine-tuning: https://platform.openai.com/docs/guides/supervised-fine-tuning
- Predibase fine-tuning: https://docs.predibase.com/fine-tuning/overview
- Together fine-tuning: https://docs.together.ai/docs/fine-tuning-overview
- Fireworks LoRA deployment: https://docs.fireworks.ai/fine-tuning/deploying-loras
- OpenPipe fine-tuning: https://docs.openpipe.ai/features/fine-tuning/quick-start
- Amazon Bedrock model customization: https://docs.aws.amazon.com/bedrock/latest/userguide/custom-models.html

Kolm implication:

Training itself is a commodity and capital-intensive surface. Kolm should own
the build decision, evidence contract, split integrity, eval gate, artifact
format, and deploy proof. Training providers should be pluggable compute.

### 2.4 Serving engine and runtime baseline

State of the art serving engines provide:

- OpenAI-compatible APIs
- batching
- KV cache optimization
- LoRA adapter serving
- structured outputs
- speculative decoding
- tensor parallelism
- quantization
- GPU scheduling

Reference products and docs:

- vLLM OpenAI-compatible server: https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html
- SGLang documentation: https://docs.sglang.ai/
- Hugging Face Text Generation Inference: https://huggingface.co/docs/text-generation-inference/index
- NVIDIA TensorRT-LLM: https://docs.nvidia.com/tensorrt-llm/
- NVIDIA NIM: https://docs.nvidia.com/nim/index.html

Kolm implication:

Kolm should not pretend to replace vLLM, SGLang, TGI, TensorRT-LLM, or NIM.
Kolm should compile, package, route, and verify work for those runtimes.

### 2.5 Edge, browser, mobile, and device baseline

State of the art edge AI provides:

- mobile runtimes
- browser runtimes
- OS-native foundation model APIs
- hardware-specific acceleration
- model conversion and optimization
- device capability detection

Reference products and docs:

- ONNX Runtime Mobile: https://onnxruntime.ai/docs/tutorials/mobile/
- PyTorch ExecuTorch: https://docs.pytorch.org/executorch/stable/intro-overview.html
- Google LiteRT: https://ai.google.dev/edge/litert/overview
- Apple Core ML: https://developer.apple.com/documentation/coreml
- Apple Foundation Models: https://developer.apple.com/documentation/foundationmodels
- Qualcomm AI Hub: https://app.aihub.qualcomm.com/docs/
- Edge Impulse deployment: https://docs.edgeimpulse.com/docs/edge-impulse-studio/deployment

Kolm implication:

The edge promise is not "Kolm runs everywhere" unless every artifact names a
target runtime, expected memory budget, capability profile, fallback, and local
verification result. The product needs device-fit proof, not device copy.

### 2.6 Cloud and hosted GPU baseline

State of the art cloud compute provides:

- serverless GPU jobs
- persistent volumes
- model endpoints
- job logs
- webhooks
- containers
- autoscaling
- managed training
- GPU marketplaces
- BYOC options

Reference products and docs:

- Modal docs: https://modal.com/docs
- RunPod serverless endpoints: https://docs.runpod.io/serverless/endpoints/overview
- Lambda Cloud API: https://docs.lambda.ai/public-cloud/lambda-inference-api/
- Baseten docs: https://docs.baseten.co/
- Replicate Cog deploy: https://cog.run/deploy/
- BentoCloud docs: https://docs.bentoml.com/en/latest/bentocloud/
- AWS SageMaker HyperPod: https://docs.aws.amazon.com/sagemaker/latest/dg/sagemaker-hyperpod.html
- Google Vertex AI: https://cloud.google.com/vertex-ai/docs
- Azure AI Foundry: https://learn.microsoft.com/en-us/azure/ai-foundry/

Kolm implication:

Users without GPUs need a compute broker. The broker should estimate, pick,
launch, monitor, and import results. It should not bury users in provider
choices. The user should select outcome constraints: cost cap, time cap,
privacy boundary, model class, runtime target.

### 2.7 Enterprise AI operating system baseline

State of the art enterprise AI platforms provide:

- data governance
- agent frameworks
- model governance
- catalogs
- lineage
- security
- vector search
- workflow orchestration
- enterprise identity
- cloud-native deployment

Reference products and docs:

- Palantir AIP documentation: https://www.palantir.com/docs/
- Databricks Mosaic AI: https://docs.databricks.com/en/machine-learning/index.html
- Databricks Agent Framework: https://docs.databricks.com/aws/en/generative-ai/agent-framework/
- Snowflake Cortex Agents: https://docs.snowflake.com/user-guide/snowflake-cortex/cortex-agents
- Dataiku LLM Mesh: https://www.dataiku.com/product/llm-mesh
- DataRobot Generative AI: https://docs.datarobot.com/11.0/en/docs/gen-ai/index.html
- H2O.ai Enterprise h2oGPTe: https://docs.h2o.ai/enterprise-h2ogpte/

Kolm implication:

Kolm cannot out-platform these companies inside their own accounts. Kolm can
win by making `.kolm` the portable proof object that those platforms can emit,
import, verify, and run.

### 2.8 Data development and labeling baseline

State of the art data development provides:

- labeling workflows
- human review
- weak supervision
- synthetic data
- model evaluation
- data governance
- provenance
- dataset versioning

Reference products and docs:

- Scale Data Foundry: https://scale.com/data-foundry
- Labelbox model evaluation: https://docs.labelbox.com/docs/model-evaluation-overview
- Snorkel documentation: https://docs.snorkel.ai/
- Gretel documentation: https://docs.gretel.ai/

Kolm implication:

Kolm should not claim "we have data" as the moat. The moat is data provenance
bound to deployable artifacts and eval receipts.

### 2.9 Security, compliance, and policy baseline

State of the art AI security now includes:

- prompt injection detection
- policy guardrails
- model scanning
- vulnerability scanning
- audit logs
- SBOMs
- attestations
- transparency logs
- AI risk management
- management systems

Reference products, standards, and docs:

- NIST AI RMF: https://www.nist.gov/itl/ai-risk-management-framework
- ISO/IEC 42001: https://www.iso.org/standard/81230.html
- OWASP Top 10 for LLM Applications: https://owasp.org/www-project-top-10-for-large-language-model-applications/
- Lakera Guard: https://docs.lakera.ai/guard
- Giskard scanning: https://docs.giskard.ai/hub/sdk/scan/index.html
- NVIDIA NeMo Guardrails: https://docs.nvidia.com/nemo-guardrails/index.html
- Open Policy Agent: https://www.openpolicyagent.org/docs/latest/
- Sigstore: https://docs.sigstore.dev/
- SLSA: https://slsa.dev/
- CycloneDX SBOM: https://cyclonedx.org/specification/overview/

Kolm implication:

Security cannot be a page. Security has to be a policy evaluation and evidence
fabric embedded into every artifact, route, job, and deployment.

### 2.10 Agent framework baseline

State of the art agent frameworks provide:

- tool calling
- durable graphs
- tracing
- handoffs
- MCP servers
- agent protocol integration
- typed outputs
- workflows

Reference products and docs:

- Model Context Protocol: https://modelcontextprotocol.io/
- MCP specification: https://github.com/modelcontextprotocol/modelcontextprotocol
- Google Agent2Agent specification: https://google-a2a.github.io/A2A/specification/
- OpenAI Agents SDK: https://platform.openai.com/docs/guides/agents-sdk/
- OpenAI Agents SDK tracing: https://openai.github.io/openai-agents-js/guides/tracing/
- LangGraph docs: https://langchain-ai.github.io/langgraph/
- LlamaIndex docs: https://docs.llamaindex.ai/
- Microsoft Semantic Kernel: https://learn.microsoft.com/en-us/semantic-kernel/
- Vercel AI SDK: https://ai-sdk.dev/docs
- Pydantic AI: https://pydantic.dev/docs/ai/overview/
- Haystack: https://docs.haystack.deepset.ai/docs/intro

Kolm implication:

Agent frameworks own orchestration. Kolm should own signed, portable,
auditable agent tools and receipts.

## 3. The Product Kernel Kolm Needs

### 3.1 Kernel object model

Add a product-kernel contract that every surface shares:

```txt
Tenant
  Org
    Workspace
      Namespace
        EvidenceSet
          CaptureEvent
          TraceSpan
          Label
          EvalCase
          DatasetSplit
        BuildPlan
          ProviderPolicy
          ComputePolicy
          PrivacyPolicy
          RuntimeTarget
          CostBudget
          QualityGate
        BuildRun
          Job
          Log
          Metrics
          ArtifactVersion
        Artifact
          Manifest
          Receipt
          RuntimeBundle
          Signature
          Attestation
          DependencyGraph
        Deployment
          Runtime
          Device
          Endpoint
          Rollback
          ReceiptStream
```

Suggested structural edit:

- Create `src/product-kernel.js`.
- Define plain schema objects for the model above.
- Export canonical IDs, status enums, and transition guards.
- Make `docs/product-surfaces.json`, `docs/product-journeys.json`, and
  `docs/product-sota-readiness.json` refer to these terms.
- Add `scripts/audit-product-kernel.cjs` to prove all surfaces use the same
  nouns.

Verification:

- `node scripts/audit-product-kernel.cjs`
- no route returns an envelope outside the canonical status enums
- no public page uses an unregistered product noun
- no CLI group exists without a product-kernel owner

### 3.2 Canonical response envelope

Every JSON route should return:

```json
{
  "ok": true,
  "surface": "compile-verify",
  "journey": "compile-verify",
  "readiness": {
    "status": "implemented",
    "claim_scope": "local",
    "external_requirements": []
  },
  "tenant": {
    "id": "tenant_x",
    "workspace_id": "ws_x"
  },
  "data": {},
  "evidence": {
    "source_paths": [],
    "artifact_ids": [],
    "receipt_ids": [],
    "trace_ids": [],
    "audit_event_ids": []
  },
  "next_actions": []
}
```

Why:

- Account UI can guide the user without guessing.
- CLI and TUI can render the same next actions.
- Support can debug faster.
- Docs can show exact readiness without copy drift.
- Product-surface smoke can assert semantic contracts, not just status 200.

Suggested structural edit:

- Add `src/envelope.js`.
- Add `okEnvelope`, `errorEnvelope`, `readinessEnvelope`,
  `actionEnvelope`, and `jobEnvelope`.
- Convert routes incrementally by surface.
- Teach `scripts/prod-surface-smoke.cjs` to assert `surface`, `journey`, and
  `readiness.status` where present.

### 3.3 Product graph as generator

The product graph should drive the public and private product surface:

```txt
docs/product-surfaces.json
docs/product-journeys.json
docs/product-sota-readiness.json
        |
        v
scripts/build-product-graph.cjs
        |
        +-> public/product-graph.json
        +-> public/account/nav.generated.json
        +-> public/docs/product-matrix.html
        +-> public/docs/api-routes.json tags
        +-> cli/generated/product-groups.json
        +-> tests/product-surface-contract.test.js fixtures
```

Suggested structural edit:

- Add `scripts/build-product-graph.cjs`.
- Add `public/product-graph.json`.
- Make nav, CLI grouping, docs grouping, and release verifier consume it.
- Ban hand-authored product-surface lists outside the source JSON.

Verification:

- `npm run verify:surfaces`
- `npm run verify:journeys`
- `node scripts/audit-product-graph-consumers.cjs`

## 4. Cut-Once Architecture Decisions

### 4.1 Split route ownership without losing one Express app

Current risk:

`src/router.js` is large enough that adding one more product surface increases
the chance of accidental auth ordering bugs, route drift, and copy/paste
contracts.

Suggested structure:

```txt
src/routes/
  account.js
  billing.js
  gateway.js
  capture.js
  lake.js
  datasets.js
  labels.js
  evals.js
  training.js
  distill.js
  compile.js
  artifacts.js
  runtime.js
  models.js
  compute.js
  devices.js
  governance.js
  privacy.js
  audit.js
  registry.js
  agents.js
  public.js
src/router.js
  import route modules
  apply common middleware
  mount modules from product graph
```

Rules:

- Every route module exports `routeGroup`, `surface`, `journey`, `requiresAuth`,
  `readinessRequirementIds`, and `mount(router, deps)`.
- Auth ordering is declarative.
- Public routes are explicitly marked.
- Smoke probes are generated from module metadata.

Atomic edits:

- SE-ROUTE-001: Create `src/routes/_contract.js`.
- SE-ROUTE-002: Move health/status/public docs routes first.
- SE-ROUTE-003: Move billing/account routes.
- SE-ROUTE-004: Move gateway/capture/lake routes.
- SE-ROUTE-005: Move compile/artifact/runtime routes.
- SE-ROUTE-006: Move governance/privacy/audit routes.
- SE-ROUTE-007: Move deployment/compute/device routes.
- SE-ROUTE-008: Delete route comments as source-index crutches once metadata
  is explicit.

Verification:

- route count unchanged
- OpenAPI operation IDs unchanged unless intentionally versioned
- production smoke unchanged
- auth/no-auth classification diff is empty

### 4.2 Break the CLI into a command registry

Current risk:

`cli/kolm.js` is a product OS hidden in one file. The CLI may work, but it is
too hard to make every command perfect across help text, JSON shape, errors,
auth, local/cloud modes, and TUI parity.

Suggested structure:

```txt
cli/
  kolm.js
  command-registry.js
  commands/
    auth.js
    billing.js
    gateway.js
    capture.js
    lake.js
    dataset.js
    label.js
    eval.js
    train.js
    distill.js
    compile.js
    artifact.js
    run.js
    serve.js
    models.js
    compute.js
    cloud.js
    devices.js
    privacy.js
    audit.js
    mcp.js
    doctor.js
    tui.js
```

Each command exports:

```js
{
  id,
  surface,
  journey,
  summary,
  argsSchema,
  envSchema,
  examples,
  jsonOutputSchema,
  handler,
  nextActions
}
```

Atomic edits:

- SE-CLI-001: Add command registry and route all help through it.
- SE-CLI-002: Add JSON schema for each command output.
- SE-CLI-003: Add `kolm status` as a product-wide readiness command.
- SE-CLI-004: Add `kolm next` to show the next best action from current state.
- SE-CLI-005: Add per-surface golden output tests.
- SE-CLI-006: Make TUI import the same registry.

Verification:

- no command without `surface`
- no command without `--json` path if it mutates or reads product state
- no command without at least one account UI or API equivalent

### 4.3 Durable jobs before adding more hosted work

Current risk:

Training, distillation, compile, import, benchmark, and deploy are job-shaped.
If they are not represented by a durable job system, the product will feel like
a demo whenever a long operation fails, restarts, or needs logs.

Suggested structure:

```txt
src/jobs/
  index.js
  store.js
  queue.js
  runner.js
  leases.js
  retry.js
  webhooks.js
  logs.js
  artifacts.js
```

Job schema:

```json
{
  "id": "job_x",
  "tenant_id": "tenant_x",
  "workspace_id": "ws_x",
  "surface": "train-distill",
  "journey": "train-distill",
  "kind": "distill",
  "status": "queued|running|succeeded|failed|cancelled|expired",
  "idempotency_key": "sha256:...",
  "input_hash": "sha256:...",
  "policy_hash": "sha256:...",
  "attempt": 1,
  "max_attempts": 3,
  "lease_expires_at": "...",
  "created_at": "...",
  "updated_at": "...",
  "started_at": "...",
  "finished_at": "...",
  "cost_estimate_usd": 0,
  "cost_actual_usd": 0,
  "logs_ref": "s3://...",
  "outputs": []
}
```

Atomic edits:

- SE-JOB-001: Make compile jobs durable.
- SE-JOB-002: Make distill jobs durable.
- SE-JOB-003: Make training jobs durable.
- SE-JOB-004: Make benchmark jobs durable.
- SE-JOB-005: Make deploy jobs durable.
- SE-JOB-006: Add job cancellation.
- SE-JOB-007: Add job retry and dead-letter states.
- SE-JOB-008: Add job webhooks with signed payloads.
- SE-JOB-009: Add per-job audit events.
- SE-JOB-010: Add job logs to account UI, CLI, and TUI.

Verification:

- kill process mid-job, restart, job is not lost
- duplicate idempotency key does not double-charge or double-train
- failed jobs preserve logs and input hashes
- job webhook signature verifies offline

### 4.4 Durable storage and content-addressable artifacts

Current risk:

The product claim depends on artifacts, receipts, captures, datasets, and logs
being durable. Local filesystem and JSON store can be acceptable for local mode,
but hosted mode needs object storage and a durable metadata store.

Suggested structure:

```txt
src/storage/
  object.js
  local.js
  s3.js
  r2.js
  supabase.js
  signed-url.js
  retention.js
  cas.js
```

Rules:

- All durable bytes have SHA-256.
- All tenant-owned durable bytes are tenant-prefixed.
- All public artifacts are immutable by version.
- All private artifact downloads use short-lived signed URLs.
- All receipts are append-only.
- All deletes create audit events.

Atomic edits:

- SE-STORAGE-001: Promote `src/object-storage.js` into a driver interface.
- SE-STORAGE-002: Add CAS blob layer.
- SE-STORAGE-003: Add metadata table abstraction for artifact versions.
- SE-STORAGE-004: Add signed URL API for artifact downloads.
- SE-STORAGE-005: Add lifecycle/retention policy execution.
- SE-STORAGE-006: Add object-storage integration smoke for R2/S3/Supabase.
- SE-STORAGE-007: Add `kolm storage doctor`.
- SE-STORAGE-008: Add storage cost attribution by tenant/workspace/artifact.

Verification:

- artifact survives server restart
- object-storage disabled path remains local-first
- private tenant cannot read another tenant prefix
- signed URL expires
- receipt hash remains stable after registry metadata changes

### 4.5 Provider and compute broker

Current risk:

`src/compute/registry.json` has 21 backends and `src/platform-capabilities.js`
tracks many model/device/method targets. This is valuable, but users should not
have to understand all of it.

Suggested structure:

```txt
src/provider-broker/
  providers.js
  capabilities.js
  policy.js
  planner.js
  estimator.js
  router.js
  health.js
  credentials.js
```

The broker should answer:

- Can I use OpenAI, Claude, Gemini, OpenRouter, local, or hosted open weights?
- Can I train this model?
- Can I distill from this teacher?
- Can I run this artifact on this device?
- What will it cost?
- What privacy boundary is crossed?
- Which provider is the fallback?
- Which provider is forbidden by policy?
- What exact env var or secret ref is missing?

Atomic edits:

- SE-COMPUTE-001: Normalize provider IDs across `remote-compute`,
  `provider-registry`, `compute/registry`, and `platform-capabilities`.
- SE-COMPUTE-002: Add provider capability schemas.
- SE-COMPUTE-003: Add provider health checks that do not leak secrets.
- SE-COMPUTE-004: Add cost/time estimator with confidence bounds.
- SE-COMPUTE-005: Add privacy boundary labels to every provider.
- SE-COMPUTE-006: Add policy constraints for regulated use cases.
- SE-COMPUTE-007: Add broker recommendations for every train/distill/compile
  flow.
- SE-COMPUTE-008: Add broker output to account UI, CLI, and TUI.

Verification:

- no train/distill UI asks the user to pick raw providers before showing a
  recommendation
- every provider option has docs URL, env schema, cost basis, privacy boundary,
  and fallback
- no route says "configured" without a live readiness check

## 5. Atomic Structural Backlog By Product Surface

Priority definitions:

- P0: required to claim production infrastructure quality.
- P1: required to claim best-in-class product quality.
- P2: required to scale ecosystem and platform value.
- PX: external proof item, partner item, package release, or live certification.

### 5.1 Identity, access, teams, and billing

Current repo evidence:

- Surface: `identity-access-billing`
- Code: `src/auth.js`, `src/oauth.js`, `src/stripe.js`, `src/teams.js`,
  `src/router.js`, `cli/kolm.js`
- External baselines: WorkOS, Auth0 Organizations, Stripe Billing, Stripe
  customer portal

Structural diagnosis:

The current system appears locally coherent, but enterprise identity needs a
clearer hierarchy: org, workspace, tenant, user, service account, API key,
role, permission, billing customer, and data boundary. If these remain loosely
coupled, every future compliance and enterprise feature will be fragile.

Atomic edits:

| ID | Priority | Edit | Files | Verification |
| --- | --- | --- | --- | --- |
| ID-001 | P0 | Define canonical identity entities: org, workspace, tenant, user, service account, API key, role, permission. | `src/auth.js`, `src/team.js`, `src/teams.js`, `src/keys.js`, `docs/product-surfaces.json` | unit tests prove no route uses tenant as a substitute for workspace or org |
| ID-002 | P0 | Add central `requirePermission(req, action, resource)` helper. | `src/auth.js`, route modules | route tests for read/write/admin actions |
| ID-003 | P0 | Add service-account keys distinct from human API keys. | `src/keys.js`, account API keys UI, CLI | service account cannot sign in interactively |
| ID-004 | P0 | Add key rotation state: active, grace, revoked, expired. | `src/keys.js`, `src/audit.js` | old key works only during grace window |
| ID-005 | P0 | Normalize entitlements around Free, Pro, Team, Enterprise with legacy aliases only at ingest boundary. | `src/stripe.js`, `src/billing-upgrade.js`, `src/auth.js` | no route branches on legacy plan names internally |
| ID-006 | P1 | Add SSO/SCIM provider adapters with explicit "not configured" readiness. | `src/oauth.js`, `src/platform-capabilities.js` | readiness says integration-ready, not shipped, until provider configured |
| ID-007 | P1 | Add admin audit trail for billing, role, key, and tenant changes. | `src/audit.js`, account audit UI | every admin mutation emits signed audit event |
| ID-008 | P1 | Add customer portal and invoice state to account UI, CLI, and TUI. | `src/stripe.js`, `cli/commands/billing.js`, account billing UI | self-serve billing route returns portal URL or exact missing config |
| ID-009 | P1 | Add entitlement simulator for support and QA. | `scripts/local-surface-smoke.cjs`, `src/billing-breakdown.js` | every plan can be smoke-tested without Stripe live calls |
| ID-010 | P2 | Add organization-level policy packs. | `src/runtime-policy.js`, `src/auth.js` | policy pack gates provider, retention, runtime, export, and deploy |

Best-in-class bar:

Enterprise admins should be able to answer in one screen: who can capture, who
can train, who can publish, who can deploy, who can export compliance, which
keys exist, what they can touch, and what changed recently.

### 5.2 Public site, docs, API reference, and SDK distribution

Current repo evidence:

- Surface: `public-docs-sdk`
- Code: `server.js`, `src/product-experience.js`,
  `scripts/build-api-ref.cjs`, `scripts/build-openapi.cjs`,
  `scripts/build-sdk-version.js`, `public/docs/api-routes.json`
- Current verification: static refs and route docs are covered by scripts.

Structural diagnosis:

The docs should not be a separate writing surface. They should be generated
from product graph, route metadata, readiness ledger, and examples. The website
can still be designed, but the product claims should be data-backed.

Atomic edits:

| ID | Priority | Edit | Files | Verification |
| --- | --- | --- | --- | --- |
| DOC-001 | P0 | Add route metadata fields for surface, journey, readiness, auth, side effects, idempotency, and examples. | route modules, `scripts/build-api-ref.cjs` | OpenAPI includes all metadata |
| DOC-002 | P0 | Generate feature matrix from readiness ledger. | `docs/product-sota-readiness.json`, `scripts/build-product-graph.cjs` | no hand-written feature table can drift |
| DOC-003 | P0 | Add "claim scope" to every public benchmark/performance/security claim. | public pages, docs generator | lint fails on unscoped "fastest", "best", "production-ready" |
| DOC-004 | P0 | Add API examples for every route group. | `public/docs/api-routes.json` | API docs checker rejects missing examples |
| DOC-005 | P1 | Add SDK parity matrix generated from SDK manifest. | `sdk/*`, `packages/*`, docs | every SDK method maps to route or local runtime |
| DOC-006 | P1 | Add changelog entries linked to product surface IDs. | `src/changelog.js`, public changelog | changelog can filter by surface |
| DOC-007 | P1 | Add "copy from product graph" for nav, docs, CLI help, and TUI labels. | `public/nav.js`, `cli/kolm.js`, `public/tui.html` | duplicate phrase scanner |
| DOC-008 | P2 | Add docs "runbook mode" for enterprise admin tasks. | docs | each admin task has CLI/API/UI path |

Best-in-class bar:

A developer should never wonder whether a claim is marketing, local code,
configured cloud, package release, public benchmark, partner adoption, or live
certification. The docs should say that directly.

### 5.3 Gateway capture

Current repo evidence:

- Journey: `gateway-capture`
- Code: `src/daemon-connector.js`, `src/completions-api.js`,
  `src/provider-registry.js`, `src/capture-store.js`, `src/router.js`
- Baseline competitors: Cloudflare AI Gateway, Vercel AI Gateway, OpenRouter,
  LiteLLM, Portkey

Structural diagnosis:

Gateway capture must be drop-in enough to win first use and evidence-rich
enough to power the compiler. Those are different requirements. The code should
separate upstream request compatibility from capture event normalization.

Atomic edits:

| ID | Priority | Edit | Files | Verification |
| --- | --- | --- | --- | --- |
| GW-001 | P0 | Define canonical provider request/response envelope for OpenAI, Anthropic, Gemini, OpenRouter, local OpenAI-compatible, and artifact runtime. | `src/completions-api.js`, `src/daemon-connector.js`, `src/provider-registry.js` | provider fixture parity tests |
| GW-002 | P0 | Add capture policy evaluator before persistence: store, no-store, redact, hash-only, sample, exclude. | `src/daemon-connector.js`, `src/privacy-membrane.js` | zero-retention tests prove no row written |
| GW-003 | P0 | Add provider-level cache/fallback/retry policy object. | `src/runtime-policy.js`, `src/provider-registry.js` | route returns chosen provider and fallback reason |
| GW-004 | P0 | Add tenant-scoped cost attribution for every gateway call. | `src/cost-estimator.js`, `src/lake.js`, `src/billing-breakdown.js` | billing usage matches captured calls |
| GW-005 | P1 | Add OpenTelemetry GenAI span export for every gateway call. | `src/otel.js`, `src/trace-capture.js` | OTEL fixture matches semconv attributes |
| GW-006 | P1 | Add provider health and model availability cache. | `src/provider-broker/*` | UI shows unavailable provider before user submits |
| GW-007 | P1 | Add payload size, token budget, and PII policy preflight. | `src/runtime-policy.js`, `src/privacy-membrane.js` | oversized or policy-violating request fails before upstream call |
| GW-008 | P2 | Add gateway importers for LangSmith, Langfuse, Phoenix, Weave, Braintrust, and Humanloop traces. | `src/trace-translator.js`, import routes | imported traces produce canonical EvidenceSet |

Best-in-class bar:

The gateway should feel like a better OpenAI/Claude/OpenRouter endpoint on day
one, but the durable value should be the evidence graph it creates.

### 5.4 Privacy lake

Current repo evidence:

- Journey: `privacy-lake`
- Code: `src/lake.js`, `src/privacy-membrane.js`, `src/event-store.js`,
  `public/account/lake.html`
- Readiness: redaction quality still needs public benchmark data.

Structural diagnosis:

Privacy cannot be a post-hoc redaction step. The lake needs an explicit privacy
state machine for every event.

Canonical event privacy state:

```txt
raw_received
  -> blocked
  -> redacted
  -> hashed_only
  -> zero_retention_forwarded
  -> retained
  -> exported
  -> purged
```

Atomic edits:

| ID | Priority | Edit | Files | Verification |
| --- | --- | --- | --- | --- |
| LAKE-001 | P0 | Add canonical lake event schema with privacy state, retention deadline, source, checksum, tenant, namespace, and policy hash. | `src/event-schema.js`, `src/event-store.js` | schema migration test |
| LAKE-002 | P0 | Add per-class redaction metrics: email, phone, SSN, MRN, DOB, address, name, key, token, license plate, face, voiceprint. | `src/privacy-membrane.js`, `src/phi-redactor.js` | metrics appear in privacy report |
| LAKE-003 | P0 | Add redaction benchmark harness and public fixture pack. | `bench/privacy`, `scripts/bench-privacy.cjs` | benchmark emits F1 by class |
| LAKE-004 | P0 | Add retention enforcement job. | `src/storage/retention.js`, `src/jobs/*` | expired rows purge or redact according to policy |
| LAKE-005 | P1 | Add lake query API with safe filters and pagination. | `src/lake.js`, routes | large lake does not full-scan response |
| LAKE-006 | P1 | Add Parquet/JSONL export with manifest and hashes. | `src/lake.js`, `src/object-storage.js` | export verifies with hash manifest |
| LAKE-007 | P1 | Add differential privacy budget ledger. | `src/privacy-membrane.js` | epsilon/delta never silently reused |
| LAKE-008 | P2 | Add data lineage graph from capture to dataset to artifact. | `src/artifact-lineage.js`, `src/event-store.js` | artifact page shows source evidence graph |

Best-in-class bar:

A healthcare buyer should be able to inspect a captured event and see exactly
what was detected, what was redacted, what was stored, what was not stored, when
it expires, and which artifact it influenced.

### 5.5 Datasets, labels, evals, and opportunities

Current repo evidence:

- Journey: `datasets-labeling`
- Code: `src/dataset-workbench.js`, `src/label-queue.js`,
  `src/opportunity-engine.js`, `src/simulation.js`, `src/bakeoff.js`
- Competitive baselines: LangSmith datasets/evals, Braintrust, Humanloop,
  Labelbox, Snorkel, Scale, Gretel.

Structural diagnosis:

Datasets are the hinge between "observability" and "compiler." If dataset
versioning, split integrity, label provenance, and eval semantics are not
first-class, K-score cannot become trusted.

Atomic edits:

| ID | Priority | Edit | Files | Verification |
| --- | --- | --- | --- | --- |
| DATA-001 | P0 | Introduce `EvidenceSet`, `DatasetVersion`, `LabelSet`, and `EvalSuite` IDs. | `src/dataset-workbench.js`, `src/event-schema.js` | dataset IDs are stable across exports |
| DATA-002 | P0 | Make train/holdout/test splits immutable and hash-addressed. | `src/dataset-workbench.js`, `src/tenant-holdout.js` | overlapping row hash test |
| DATA-003 | P0 | Add label provenance: human, synthetic, teacher, heuristic, imported, corrected. | `src/label-queue.js`, `src/synthetic-data.js` | K-score excludes unqualified labels by policy |
| DATA-004 | P0 | Add eval-as-code adapter with JS and Python command hooks. | `src/kscore.js`, `src/bakeoff.js`, CLI | eval cases can be deterministic code checks |
| DATA-005 | P1 | Add active learning priority score. | `src/opportunity-engine.js`, `src/label-queue.js` | queue ranks highest expected value |
| DATA-006 | P1 | Add dataset importers for LangSmith, Langfuse, Braintrust, Humanloop, OpenPipe, CSV, JSONL. | `src/trace-translator.js`, dataset routes | imported fixture round-trips |
| DATA-007 | P1 | Add synthetic data provenance and contamination checks. | `src/synthetic-data.js`, `src/seeds-*` | synthetic rows cannot enter holdout without label |
| DATA-008 | P2 | Add data quality score separate from K-score. | `src/dataset-workbench.js` | compile failure diagnostics explain data quality |

Best-in-class bar:

Every build failure should say whether the issue is data quantity, data
quality, split leakage, label noise, task ambiguity, model mismatch, compute
budget, or eval design.

### 5.6 Training and distillation

Current repo evidence:

- Journey: `train-distill`
- Code: `src/distill-pipeline.js`, `src/distill-onpolicy.js`,
  `src/distill-preference.js`, `src/training-planner.js`,
  `src/remote-compute.js`, `src/compute/registry.json`
- Readiness: K-score calibration needs public benchmark data.

Structural diagnosis:

The product should not ask users to choose "train vs distill vs compile" too
early. It should plan the best build strategy from constraints.

Build strategy planner:

```txt
Input:
  task_type
  dataset_size
  label_quality
  output_determinism
  latency_target
  cost_target
  privacy_boundary
  runtime_target
  available_compute
  provider_policy

Output:
  do_not_train
  recipe_compile
  prompt_compress
  semantic_cache
  RAG_artifact
  teacher_collect
  supervised_finetune
  LoRA
  QLoRA
  preference_optimization
  on_policy_distill
  speculative_decode
  hosted_fallback
```

Atomic edits:

| ID | Priority | Edit | Files | Verification |
| --- | --- | --- | --- | --- |
| TRAIN-001 | P0 | Add `BuildStrategyPlanner` before distill/train/compile. | `src/training-planner.js`, `src/compile-pipeline.js`, `src/distill-pipeline.js` | planner emits reasoned recommendation |
| TRAIN-002 | P0 | Add teacher-provider policy for OpenAI, Anthropic, Gemini, OpenRouter, local, and custom endpoints. | `src/provider-broker/*`, `src/distill-pipeline.js` | no OpenAI-only path |
| TRAIN-003 | P0 | Add real/stub/collect/full mode as explicit build states with marketing-safe labels. | `src/distill-pipeline.js`, account builds UI, CLI | stub mode cannot be confused with trained artifact |
| TRAIN-004 | P0 | Add hosted compute job lifecycle through durable jobs. | `src/jobs/*`, `src/remote-compute.js` | remote job can resume after restart |
| TRAIN-005 | P0 | Add cost cap and time cap enforcement. | `src/remote-compute.js`, `src/cost-estimator.js` | job refuses launch beyond cap |
| TRAIN-006 | P1 | Add multi-teacher bakeoff before data generation. | `src/bakeoff.js`, `src/distill-pipeline.js` | selected teacher has evidence |
| TRAIN-007 | P1 | Add model/student recommendation by task, license, memory, runtime, and target latency. | `src/model-registry.js`, `src/platform-capabilities.js` | UI shows why model was selected |
| TRAIN-008 | P1 | Add result import adapters for Modal, RunPod, Together, Lambda, Replicate, vLLM, SGLang, TGI. | `src/compute/backends/*` | each backend returns canonical TrainResult |
| TRAIN-009 | P1 | Add training run reproducibility manifest. | `src/distill-provenance.js`, `src/export-provenance.js` | rerun manifest has deterministic fields |
| TRAIN-010 | P2 | Add public benchmark harness for train/distill quality, latency, cost, and artifact size. | `bench/`, `scripts/bench-compare.mjs` | leaderboard can be reproduced |

Best-in-class bar:

A top AI researcher should be able to bring traces, constraints, a target
runtime, and a teacher policy, then see exactly why Kolm recommends RAG,
prompt compression, LoRA, distillation, or no training.

### 5.7 Models and backbones

Current repo evidence:

- Journey: `models-backbones`
- Code: `src/models.js`, `src/model-registry.js`,
  `src/model-weights-manifest.js`
- Current scan found several "not yet shipped" fallback notes in
  `src/model-weights-manifest.js`.

Structural diagnosis:

The model catalog should distinguish:

- advertised model family
- locally downloadable weights
- metadata-only listing
- supported teacher endpoint
- supported student training target
- supported runtime target
- license policy
- verified artifact output

Atomic edits:

| ID | Priority | Edit | Files | Verification |
| --- | --- | --- | --- | --- |
| MODEL-001 | P0 | Add model status enum: `available`, `metadata_only`, `provider_only`, `downloadable`, `trainable`, `exportable`, `deprecated`, `blocked_by_license`. | `src/model-registry.js`, `src/model-weights-manifest.js` | no "not yet shipped" text without status |
| MODEL-002 | P0 | Add license compatibility policy by use case. | `src/licensing-allowlist.js`, model registry | enterprise build refuses incompatible license |
| MODEL-003 | P0 | Add modality and runtime target matrix per model. | `src/model-registry.js`, `src/platform-capabilities.js` | model recommendation includes target fit |
| MODEL-004 | P1 | Add model card ingestion for Hugging Face and provider docs. | `src/model-registry.js` | model card hash stored |
| MODEL-005 | P1 | Add local weight verification and cache state. | `src/model-weights-puller.js` | pulled model verifies size/hash |
| MODEL-006 | P1 | Add "best current model" refresh workflow. | scripts | outdated candidate models flagged |
| MODEL-007 | P1 | Add user-facing compare table: quality, latency, memory, license, trainability, runtime. | account models UI, public models page | no model table without source date |
| MODEL-008 | P2 | Add artifact compatibility tests per model family. | tests | each model family has compile/run smoke or honest unsupported reason |

Best-in-class bar:

The product should never imply that a future, unavailable, or metadata-only
model is actually trainable or runnable. The best model page is a decision tool,
not a trophy list.

### 5.8 Multimodal tokenization

Current repo evidence:

- Journey: `multimodal-tokenization`
- Code: `services/embed/multimodal.js`,
  `public/account/multimodal-bakeoff.html`,
  `tests/wave552-gemma-multimodal-account.test.js`
- Platform matrix marks speech, voiceprint, image-redaction dependencies as
  dependency-gated in places.

Structural diagnosis:

Multimodal must be represented as evidence extraction, not a separate feature
branch. A PDF, image, video, audio file, log file, or codebase should become a
typed evidence object with provenance, extraction method, redaction state, and
eval eligibility.

Atomic edits:

| ID | Priority | Edit | Files | Verification |
| --- | --- | --- | --- | --- |
| MM-001 | P0 | Define `MediaEvidence` schema: media type, hash, extractor, redaction, sidecars, captions, OCR, transcript, embedding, eval eligibility. | `services/embed/multimodal.js`, `src/event-schema.js` | all media outputs validate schema |
| MM-002 | P0 | Add dependency readiness per extractor. | `src/platform-capabilities.js`, CLI doctor | missing OCR/ASR/model prints install hint |
| MM-003 | P0 | Add privacy preflight before extraction. | `src/privacy-membrane.js`, multimodal service | raw media can be blocked or local-only |
| MM-004 | P1 | Add multimodal eval cases with input media hashes. | `src/bakeoff.js`, `src/kscore.js` | K-score references media hashes |
| MM-005 | P1 | Add image/audio/video/PDF sidecar output manifest. | multimodal service | sidecar verifies against raw hash |
| MM-006 | P1 | Add local-first extractors and hosted fallback policy. | provider broker | UI shows local vs hosted privacy boundary |
| MM-007 | P2 | Add multimodal benchmark pack by class. | bench | public F1/quality results per media task |

Best-in-class bar:

Multimodal inputs should not feel like uploads. They should feel like governed
evidence that can become compile-ready data without losing privacy proof.

### 5.9 Compile and verify

Current repo evidence:

- Journey: `compile-verify`
- Code: `src/compile-pipeline.js`, `src/artifact.js`,
  `src/artifact-runner.js`, `src/production-ready.js`,
  `docs/kolm-format-v1.md`
- Readiness: format spec shipped; standalone verify implemented; ecosystem
  adoption still external.

Structural diagnosis:

Compile is the center of the company. The key structural standard is this:
compile must never be a black box and must never emit a production-ready claim
without evidence.

Atomic edits:

| ID | Priority | Edit | Files | Verification |
| --- | --- | --- | --- | --- |
| COMP-001 | P0 | Add `BuildReceipt` schema separate from artifact receipt. | `src/artifact.js`, `docs/receipt-v0.1.json` | build and inference receipts are distinct |
| COMP-002 | P0 | Add compile phase manifests: recall, split, synthesize, train, eval, package, sign, verify. | `src/compile-pipeline.js` | artifact contains phase refs |
| COMP-003 | P0 | Add deterministic build mode with explicit non-determinism warnings for teacher calls. | `src/compile-pipeline.js`, `src/distill-pipeline.js` | non-deterministic fields are labeled |
| COMP-004 | P0 | Add compile failure taxonomy. | `src/production-ready.js`, CLI | failures classify as data, eval, privacy, model, compute, runtime, policy |
| COMP-005 | P0 | Add artifact diff as first-class route/CLI/UI. | `src/artifact-dependency-graph.js`, registry | diff includes manifest, eval, runtime, policy |
| COMP-006 | P0 | Add offline verifier package target. | CLI, packages | verifier installs without hosted account |
| COMP-007 | P1 | Add transparency-log integration when policy requires it. | `src/sigstore.js`, `src/binder.js` | Rekor/Sigstore proof is real or marked dry-run |
| COMP-008 | P1 | Add `.kolm` conformance suite for third-party runtimes. | tests, docs | external implementer can validate parser |
| COMP-009 | P1 | Add semver and compatibility gates per artifact. | `docs/kolm-format-v1.md`, registry | breaking manifest change forces major version |
| COMP-010 | P2 | Add CNCF/Linux Foundation-style spec package. | docs/spec | spec can be submitted externally |

Best-in-class bar:

The artifact should be the product. Every artifact should answer: what trained
it, what did not train it, what evals it passed, what runtime it targets, who
signed it, what changed, where it can run, and how to roll it back.

### 5.10 Runtime inference

Current repo evidence:

- Journey: `runtime-inference`
- Code: `src/completions-api.js`, `src/runtime-policy.js`,
  `src/runtime.js`, `src/artifact-runner.js`, `public/sdk.js`,
  `public/tui.html`

Structural diagnosis:

Runtime must be policy-aware. Running a `.kolm` file is not enough. The runtime
must enforce input budget, output budget, tool access, privacy boundary,
fallback rules, cache policy, streaming behavior, and receipt emission.

Atomic edits:

| ID | Priority | Edit | Files | Verification |
| --- | --- | --- | --- | --- |
| RUN-001 | P0 | Define runtime policy schema. | `src/runtime-policy.js`, `docs/manifest-v0.1.json` | artifact run fails closed on invalid policy |
| RUN-002 | P0 | Add receipt for every runtime execution. | `src/artifact-runner.js`, `src/runtime.js` | run output includes receipt hash |
| RUN-003 | P0 | Add streaming normalization across artifact, OpenAI, Anthropic, local OpenAI-compatible providers. | `src/streaming-contract.js`, `src/completions-api.js` | SSE tests for all provider classes |
| RUN-004 | P0 | Add fallback-chain policy per artifact. | `src/runtime-policy.js`, `src/provider-broker/*` | fallback reason logged and receipted |
| RUN-005 | P1 | Add semantic/exact cache controls with privacy guardrails. | `src/cache.js`, `src/optimization.js` | no cache hit across tenant or privacy boundary |
| RUN-006 | P1 | Add runtime performance telemetry opt-in. | `src/otel.js`, runtime | telemetry off by default |
| RUN-007 | P1 | Add runtime conformance pack for Node, browser, edge, C, Rust, Swift, Kotlin. | SDKs/packages | same artifact behavior across runtimes |
| RUN-008 | P2 | Add local benchmark mode: p50/p95/p99 latency, memory, load, cold start. | CLI, bench | benchmark attaches to artifact metadata |

Best-in-class bar:

The runtime should be boring, strict, and inspectable. It should never surprise
an enterprise buyer with hidden network calls, hidden provider fallback, or
missing receipts.

### 5.11 Compute cloud

Current repo evidence:

- Journey: `compute-cloud`
- Code: `src/platform-capabilities.js`, `src/object-storage.js`,
  `src/remote-compute.js`, `docs/cloud-product-readiness.md`,
  `scripts/cloud-readiness.mjs`
- Compute registry: 21 backends across local, cloud-serverless, cloud-managed,
  cloud-marketplace, self-hosted, and serving-engine categories.

Structural diagnosis:

The product should let a user without a GPU train/distill/build. But cloud
compute must be presented as a managed build substrate with budgets, logs,
artifacts, and import verification. It should not be a loose list of provider
tokens.

Atomic edits:

| ID | Priority | Edit | Files | Verification |
| --- | --- | --- | --- | --- |
| CLOUD-001 | P0 | Add compute broker outcome API: recommend, estimate, launch, monitor, cancel, import. | `src/remote-compute.js`, `src/compute/index.js` | every backend supports same lifecycle or honest unsupported |
| CLOUD-002 | P0 | Add storage readiness as hard preflight for hosted builds. | `src/object-storage.js`, `scripts/cloud-readiness.mjs` | hosted build refuses ephemeral-only durable output |
| CLOUD-003 | P0 | Add cloud credential secret refs instead of raw env assumptions. | `src/secrets-vault.js`, compute broker | no secret printed in readiness |
| CLOUD-004 | P0 | Add provider adapters for Modal, RunPod, Together, Lambda, Replicate, Vast, remote SSH, vLLM, SGLang, TGI, TensorRT-LLM. | `src/compute/backends/*` | all adapters emit canonical lifecycle shape |
| CLOUD-005 | P1 | Add BYOC deployment profile for AWS, Cloudflare R2, Supabase, S3-compatible, Kubernetes, and SSH. | `docs/cloud-product-readiness.md`, deployment plans | readiness profile maps to exact env vars |
| CLOUD-006 | P1 | Add budget guardrails and job estimates to UI before launch. | account builds/storage UI, CLI | no hosted build starts without estimate |
| CLOUD-007 | P1 | Add result attestation and artifact import verification. | `src/export-provenance.js`, `src/auditor-attestation.js` | remote output hash verifies before registry write |
| CLOUD-008 | P2 | Add compute marketplace status dashboard. | account compute UI | users see capacity, config, last check, costs |

Best-in-class bar:

The user should say "I need a 7B extractor artifact under $20 by morning, HIPAA
safe, running on CPU and browser fallback" and Kolm should plan the build,
launch the right compute, and import a verified artifact.

### 5.12 Devices and fleet

Current repo evidence:

- Journey: `devices-fleet`
- Code: `src/device-capabilities.js`, `src/devices.js`,
  `src/device-install.js`, `src/tunnel.js`, `public/account/devices.html`
- Platform matrix includes CPU, CUDA, ROCm, Apple Silicon, DirectML, Intel
  OpenVINO, Qualcomm QNN, iOS/CoreML/ANE, Android/LiteRT/QNN, browser,
  Jetson/TensorRT, Cloudflare Workers, Vercel Edge, AWS Lambda, Kubernetes,
  remote SSH, and air-gapped servers.

Structural diagnosis:

Devices should be treated as deployment targets with capability proofs, not as
a separate inventory page.

Atomic edits:

| ID | Priority | Edit | Files | Verification |
| --- | --- | --- | --- | --- |
| DEV-001 | P0 | Add device capability profile schema. | `src/device-capabilities.js` | all detection outputs validate |
| DEV-002 | P0 | Add artifact-to-device compatibility check. | `src/device-install.js`, `src/compile-targets.js` | incompatible artifact cannot be pushed |
| DEV-003 | P0 | Add device install receipt. | `src/device-install.js`, `src/audit.js` | install emits signed event |
| DEV-004 | P1 | Add remote tunnel policy and audit. | `src/tunnel.js` | tunnel cannot bypass tenant policy |
| DEV-005 | P1 | Add fleet rollout plan: canary, staged, rollback. | deployment plans | device page supports safe rollout |
| DEV-006 | P1 | Add mobile runtime release proof for iOS/Android packages. | packages SDKs | package release status visible |
| DEV-007 | P2 | Add device benchmark suite for memory and latency. | CLI, bench | device recommendation backed by local measurement |

Best-in-class bar:

The device surface should answer "will this artifact run here, how fast, with
what memory, under what policy, and how do I roll it back?"

### 5.13 Enterprise governance, compliance, and security

Current repo evidence:

- Journey: `enterprise-governance`
- Surface: `governance-compliance-security`
- Code: `src/auth.js`, `src/keys.js`, `src/audit.js`,
  `src/privacy-membrane.js`, `src/trace-capture.js`,
  `src/auditor-attestation.js`, `src/sigstore.js`
- Readiness: formal certifications need live certification.

Structural diagnosis:

The product should have a governance plane that can export evidence without
engineering intervention. This is separate from having security copy.

Atomic edits:

| ID | Priority | Edit | Files | Verification |
| --- | --- | --- | --- | --- |
| GOV-001 | P0 | Define governance export package schema. | `src/audit.js`, `src/auditor-attestation.js` | package includes artifacts, receipts, policies, logs, subprocessors |
| GOV-002 | P0 | Add signed append-only audit chain. | `src/audit.js` | tamper test fails verification |
| GOV-003 | P0 | Add policy-as-code integration with OPA-style decisions. | `src/runtime-policy.js`, governance routes | policy decision included in receipt |
| GOV-004 | P0 | Add SBOM generation for artifacts and runtime bundles. | `src/artifact.js`, `src/binder.js` | SBOM hash in manifest |
| GOV-005 | P1 | Add SLSA/Sigstore transparency log real mode. | `src/sigstore.js` | dry-run cannot satisfy policy-required proof |
| GOV-006 | P1 | Add SIEM export adapters for Splunk, Datadog, OTEL collector, webhook. | `src/otel.js`, `src/audit.js` | audit event export fixture |
| GOV-007 | P1 | Add DSR/data deletion workflow by tenant and evidence set. | `src/privacy-membrane.js`, `src/storage/retention.js` | delete request redacts/purges according to policy |
| GOV-008 | PX | Complete SOC 2, ISO 27001, HIPAA BAA, GDPR, FedRAMP evidence externally. | compliance docs | readiness remains `needs_live_certification` until auditor proof |

Best-in-class bar:

An enterprise buyer should be able to export a package that proves what data
entered, what was redacted, what was trained, what evals passed, what artifact
ran, what policy allowed it, who approved it, and how to reproduce the proof.

### 5.14 Agents and registry

Current repo evidence:

- Journey: `agents-registry`
- Code: `services/mcp/server.js`, `cli/kolm.js`,
  `public/account/agent-telemetry.html`, `src/marketplace.js`,
  `src/registry.js`
- Baselines: MCP, A2A, OpenAI Agents SDK, LangGraph, Semantic Kernel,
  Vercel AI SDK, Pydantic AI.

Structural diagnosis:

Agent frameworks are not enemies if Kolm becomes the signed tool/artifact layer
inside them. The registry should focus on verified artifacts, not generic app
store sprawl.

Atomic edits:

| ID | Priority | Edit | Files | Verification |
| --- | --- | --- | --- | --- |
| AGENT-001 | P0 | Make `compile --as-mcp` emit a signed tool manifest. | `services/mcp/server.js`, CLI | MCP tool manifest verifies offline |
| AGENT-002 | P0 | Add per-tool permission policy. | `src/runtime-policy.js`, MCP server | tool call blocked if permission missing |
| AGENT-003 | P0 | Add agent run receipt and replay path. | `src/agent-telemetry.js`, `src/replay.js` | agent run can be replayed or explained |
| AGENT-004 | P1 | Add framework adapters: Claude Desktop, Cursor, Cline, Continue, LangGraph, Semantic Kernel, Vercel AI SDK, Pydantic AI. | `src/dev-agent-install.js`, docs | adapter install has smoke fixture |
| AGENT-005 | P1 | Add registry artifact dependency graph and blast radius. | `src/artifact-dependency-graph.js`, registry UI | changing artifact shows affected agents |
| AGENT-006 | P1 | Add verified publisher workflow. | `src/publisher-verification.js`, marketplace | publisher badge is evidence-backed |
| AGENT-007 | P2 | Add private registry deployment mode. | object storage, registry | private registry works air-gapped |

Best-in-class bar:

An agent platform should use Kolm when it needs a tool that can be verified,
versioned, permissioned, replayed, and run locally or privately.

## 6. Cross-Surface Backlog

These edits cut across all product surfaces.

### 6.1 Readiness truth everywhere

Atomic edits:

- X-READY-001: Add `readiness.status` to every product graph node.
- X-READY-002: Add readiness badges to account UI.
- X-READY-003: Add `kolm status --surface <id>`.
- X-READY-004: Add TUI readiness rail.
- X-READY-005: Add OpenAPI `x-kolm-readiness`.
- X-READY-006: Add public docs readiness matrix.
- X-READY-007: Add "claim allowed" linter for marketing copy.

Why:

This avoids the recurring argument about "done" by making done a machine
readable contract.

### 6.2 One state model for local, cloud, BYOC, and air-gap

Atomic edits:

- X-DEPLOY-001: Define deployment modes: local, hosted, BYOC, edge, browser,
  mobile, Kubernetes, SSH, air-gap.
- X-DEPLOY-002: Every route/job/artifact names deployment mode.
- X-DEPLOY-003: Every mode lists forbidden features and required config.
- X-DEPLOY-004: Every mode has a smoke test.
- X-DEPLOY-005: Every mode has docs generated from the same mode registry.

### 6.3 One provider model for OpenAI, Claude, Gemini, OpenRouter, local, and custom

Atomic edits:

- X-PROVIDER-001: Define provider capability schema.
- X-PROVIDER-002: Map every provider to chat, responses, embeddings, tools,
  vision, audio, streaming, JSON, eval, teacher, train, and fallback support.
- X-PROVIDER-003: Add provider conformance tests.
- X-PROVIDER-004: Add provider cost policy.
- X-PROVIDER-005: Add provider privacy policy.
- X-PROVIDER-006: Add provider availability checks.

### 6.4 One proof model for every operation

Atomic edits:

- X-PROOF-001: Define `ProofRef` as a universal object.
- X-PROOF-002: Every route that changes state returns audit event ID.
- X-PROOF-003: Every artifact returns manifest hash and receipt hash.
- X-PROOF-004: Every training/distill job returns dataset split hash.
- X-PROOF-005: Every runtime call returns or can emit inference receipt.
- X-PROOF-006: Every export returns export manifest hash.

### 6.5 One UI action model

Atomic edits:

- X-ACTION-001: Define `next_actions` array in response envelope.
- X-ACTION-002: Account UI renders next actions from API.
- X-ACTION-003: CLI renders next actions after command success/failure.
- X-ACTION-004: TUI renders same next actions.
- X-ACTION-005: Docs examples include next action.

This is how the product becomes "robot easy."

## 7. Product IA And UX Structure From Backend Logic

The account UI should not mirror org chart or implementation modules. It should
mirror the user's build loop.

Recommended account navigation:

1. Overview
   - readiness
   - next actions
   - connected providers
   - recent builds
   - blocked proof items
2. Capture
   - connectors
   - live traffic
   - zero-retention
   - filters
3. Lake
   - events
   - privacy
   - exports
   - retention
4. Datasets
   - opportunities
   - labels
   - splits
   - eval suites
5. Builds
   - planner
   - train/distill/compile jobs
   - logs
   - cost
   - failure diagnostics
6. Artifacts
   - versions
   - verify
   - diff
   - deploy
   - receipts
7. Runtime
   - run
   - serve
   - endpoints
   - fallback chains
   - caches
8. Compute
   - local devices
   - hosted GPU
   - BYOC
   - storage
   - tunnels
9. Governance
   - audit
   - policies
   - keys
   - compliance exports
   - team/RBAC
10. Registry and Agents
    - MCP tools
    - private/public artifacts
    - publishers
    - dependency graph

Primary product flows:

- "Connect traffic" starts in Capture.
- "Make it cheaper/faster" starts in Datasets or Builds.
- "Train/distill without GPU" starts in Builds but calls Compute preflight.
- "Run locally" starts in Artifacts or Runtime.
- "Pass security review" starts in Governance.
- "Ship to agent tools" starts in Registry and Agents.

The CLI and TUI should use the same groups.

## 8. Benchmark And Claim System

The readiness ledger already admits the biggest gap: public benchmark data.
This should become a product system, not a blog project.

Benchmark dimensions:

- quality
- latency p50/p95/p99
- cost
- artifact size
- memory
- cold start
- compile time
- train time
- redaction F1 by class
- data leakage / split integrity
- adversarial robustness
- policy compliance
- runtime compatibility
- reproducibility

Atomic edits:

| ID | Priority | Edit | Files | Verification |
| --- | --- | --- | --- | --- |
| BENCH-001 | P0 | Add benchmark schema and result manifest. | `src/benchmark.js`, `src/benchmarks.js` | result validates |
| BENCH-002 | P0 | Add benchmark source register. | docs, bench | every benchmark has source and version |
| BENCH-003 | P0 | Add public reproducibility command. | `scripts/bench-compare.mjs` | fresh machine can run subset |
| BENCH-004 | P0 | Add benchmark claim linter. | scripts | public claim must cite benchmark ID |
| BENCH-005 | P1 | Add hardware profile to every runtime benchmark. | `src/device-capabilities.js` | p95 without hardware profile invalid |
| BENCH-006 | P1 | Add provider/model version pinning. | provider broker | benchmark invalid if provider version unknown |
| BENCH-007 | P1 | Add regression gates. | CI | benchmark regression blocks release only for chosen tier |
| BENCH-008 | P2 | Add public leaderboard page. | public benchmarks page | leaderboard generated from signed results |

Public claim rule:

No homepage, docs, pricing, enterprise, or sales copy should say "faster",
"cheaper", "best", "production-ready", "HIPAA-safe", "accurate", "private", or
"runs everywhere" unless it references a current claim object:

```json
{
  "claim_id": "claim_latency_001",
  "text": "7x faster on task class X",
  "scope": "recipe-tier extractor, CPU x86_64, dataset Y",
  "benchmark_id": "bench_x",
  "valid_until": "2026-08-01",
  "owner": "product-engineering"
}
```

## 9. Data Model Upgrades

### 9.1 Suggested durable metadata tables

Even if the first implementation remains JSON/local for dev, the product
should be designed around durable relational metadata plus object storage.

Core tables:

- `orgs`
- `workspaces`
- `tenants`
- `users`
- `memberships`
- `roles`
- `permissions`
- `api_keys`
- `service_accounts`
- `billing_customers`
- `entitlements`
- `evidence_sets`
- `capture_events`
- `trace_spans`
- `media_evidence`
- `datasets`
- `dataset_versions`
- `dataset_rows`
- `labels`
- `eval_suites`
- `eval_cases`
- `build_plans`
- `jobs`
- `job_logs`
- `build_runs`
- `artifacts`
- `artifact_versions`
- `artifact_blobs`
- `artifact_lineage`
- `runtime_receipts`
- `deployments`
- `devices`
- `provider_credentials`
- `provider_health`
- `policies`
- `audit_events`
- `compliance_exports`
- `webhooks`

### 9.2 Suggested event envelope

```json
{
  "event_id": "evt_...",
  "tenant_id": "tenant_...",
  "workspace_id": "ws_...",
  "namespace": "default",
  "surface": "gateway-capture",
  "journey": "gateway-capture",
  "source_type": "openai_chat",
  "source_ref": "provider_request_id",
  "privacy_state": "redacted",
  "policy_hash": "sha256:...",
  "input_hash": "sha256:...",
  "output_hash": "sha256:...",
  "model": "gpt-4.1",
  "provider": "openai",
  "latency_ms": 0,
  "cost_usd": 0,
  "tokens_in": 0,
  "tokens_out": 0,
  "redaction": {
    "classes": [],
    "counts": {}
  },
  "retention": {
    "expires_at": null,
    "legal_hold": false
  },
  "created_at": "..."
}
```

### 9.3 Suggested artifact manifest additions

Add to `.kolm` manifest:

- `artifact_semver`
- `format_lts_until`
- `build_plan_hash`
- `dataset_version_ids`
- `split_hashes`
- `eval_suite_ids`
- `privacy_policy_hash`
- `runtime_policy_hash`
- `provider_policy_hash`
- `compute_policy_hash`
- `license_policy_hash`
- `target_matrix`
- `benchmark_refs`
- `dependency_graph_ref`
- `sbom_ref`
- `attestation_refs`
- `rollback_refs`

## 10. Testing And Verification Upgrades

The current test posture appears extensive. The next step is not just more
tests. It is more product-real tests.

### 10.1 Golden journey tests

Add one golden journey fixture per journey:

- gateway capture with OpenAI-compatible fixture
- gateway capture with Anthropic fixture
- zero-retention privacy path
- lake export path
- dataset create/split/label/eval path
- train planner path with no GPU
- remote compute launch dry-run
- compile with real holdout
- verify offline
- run artifact locally
- publish private registry
- compile as MCP and replay agent call
- governance export

Each journey test should assert:

- UI/API/CLI/TUI parity
- response envelope
- audit event
- readiness status
- next actions
- artifact/evidence refs where relevant

### 10.2 Destructive chaos tests

Add tests that kill or interrupt:

- compile job
- distill job
- remote compute job
- object storage upload
- webhook delivery
- artifact download
- provider fallback chain
- cache write
- audit append

Expected behavior:

- job resumes or fails cleanly
- no partial artifact marked production-ready
- no duplicate billing
- audit record exists
- next action is clear

### 10.3 Production smoke tests by claim

Add claim-backed smoke probes:

- auth and billing
- gateway no-store
- provider route
- capture event
- lake stats
- dataset split
- distill doctor
- compile job
- artifact verify
- runtime run
- cloud readiness
- object storage readiness
- device recommend
- audit export
- compliance export

Every public claim should map to one or more smoke probes.

## 11. Stop Doing These Things

These are structural anti-patterns to eliminate.

1. Do not add new product pages without adding product graph nodes.
2. Do not add new routes directly into a giant router without route metadata.
3. Do not add CLI commands without JSON schema, surface ID, and account/TUI/API
   equivalent.
4. Do not market target-declared runtime support as shipped runtime support.
5. Do not market integration-ready SSO/SCIM/KMS as live enterprise identity.
6. Do not market benchmark claims without source, fixture, command, and date.
7. Do not let "stub" and "production-ready" share a path unless the response
   envelope makes the distinction unmissable.
8. Do not add provider choices before adding provider recommendations.
9. Do not add model names unless status, license, runtime, trainability, and
   source date are explicit.
10. Do not add a new surface when it is really a step inside an existing
    journey.

## 12. Suggested Sequencing

### Phase 1: Product kernel and truth spine

Goal: make the existing product coherent without changing its ambition.

Ship:

1. `src/product-kernel.js`
2. canonical response envelope
3. product graph generator
4. route metadata contract
5. CLI command registry skeleton
6. readiness badges in account/CLI/TUI/docs
7. claim linter

Exit criteria:

- every route/command/view has surface and journey metadata
- every readiness warning appears in product UI
- no public claim lacks scope

### Phase 2: Durable operations

Goal: make long-running and cloud workflows reliable.

Ship:

1. durable jobs
2. object storage driver interface
3. CAS artifact storage
4. signed URLs
5. job logs
6. webhooks
7. retention worker
8. cloud storage readiness enforcement

Exit criteria:

- hosted compile/distill survives restart
- artifact survives process/container restart
- no hosted build starts without durable output path

### Phase 3: Build planner and compute broker

Goal: make the product easy for users without GPUs and credible for serious
model builders.

Ship:

1. BuildStrategyPlanner
2. provider capability schema
3. compute broker
4. cost/time estimates
5. train/distill/compile recommendation
6. remote compute canonical job lifecycle
7. OpenAI/Anthropic/Gemini/OpenRouter/local parity

Exit criteria:

- user can build without knowing provider internals
- all providers share one lifecycle contract
- no OpenAI-only path remains in product copy or UX

### Phase 4: Artifact proof and public benchmark system

Goal: make `.kolm` the trust object.

Ship:

1. phase manifests
2. build receipt schema
3. artifact diff
4. offline verifier package
5. conformance suite
6. benchmark schema
7. benchmark source register
8. public reproducible benchmarks

Exit criteria:

- `.kolm` can be verified by third parties
- K-score methodology is public enough to defend
- performance/cost/redaction claims have public benchmark data

### Phase 5: Enterprise governance and ecosystem

Goal: make large buyers and third-party runtimes comfortable adopting Kolm.

Ship:

1. governance export package
2. signed audit chain
3. OPA-style policy decisions
4. SBOM/SLSA/Sigstore real mode
5. SIEM exports
6. private registry
7. MCP signed tool manifests
8. external standards/runtime adoption work
9. SOC 2 / ISO / BAA process

Exit criteria:

- enterprise can pass security review without custom engineering answers
- `.kolm` has a path to external runtime adoption

## 13. Highest-Leverage Structural Edits

If only ten edits are made, make these:

1. Add product kernel and canonical response envelope.
2. Split router into metadata-bearing route modules.
3. Split CLI into command registry modules.
4. Add durable jobs.
5. Add object storage driver plus CAS artifact storage.
6. Add BuildStrategyPlanner before train/distill/compile.
7. Add provider/compute broker with cost, privacy, and runtime fit.
8. Add public benchmark and claim governance system.
9. Add artifact phase manifests, build receipts, diff, and conformance suite.
10. Add governance export package with signed audit chain and policy decisions.

These are not cosmetic. They make every surface easier to reason about and make
future features cheaper to add without more sprawl.

## 14. Red-Team Questions

### Why will users not just use Cloudflare/Vercel/OpenRouter/LiteLLM?

Because those systems route and observe calls. Kolm must prove it can turn
repeated calls into signed artifacts that reduce dependency on calls.

Required proof:

- captured trace -> dataset -> eval -> artifact -> local run -> receipt
- cost and latency before/after with reproducible benchmark

### Why will users not just use OpenAI/Anthropic fine-tuning?

Because provider fine-tunes remain provider-bound. Kolm must produce portable
artifact proof and runtime options.

Required proof:

- same evidence set can produce OpenAI/Anthropic teacher data and a `.kolm`
  artifact
- artifact can run or fail honestly without provider dependency

### Why will users not just use Databricks/Snowflake/Palantir/Dataiku?

Because those platforms own the enterprise environment. Kolm should integrate
with them and produce a portable proof object.

Required proof:

- imports/exports data and traces cleanly
- artifact manifest is useful outside Kolm
- governance export maps to enterprise controls

### Why will users not just use vLLM/SGLang/TGI/NIM?

Because those are serving engines. Kolm should target them, not compete with
them.

Required proof:

- runtime target manifest for each engine
- compatibility/conformance tests
- deployment docs and smoke tests

### Why will users trust K-score?

Only if K-score becomes a transparent, calibrated, reproducible methodology.

Required proof:

- public K-score method
- benchmark fixtures
- per-task calibration
- adversarial evals
- holdout integrity
- source code or enough spec for external critique

## 15. Atomic File Ownership Map

Primary structural files to add:

- `src/product-kernel.js`
- `src/envelope.js`
- `src/routes/_contract.js`
- `src/routes/*.js`
- `src/jobs/index.js`
- `src/jobs/store.js`
- `src/jobs/queue.js`
- `src/jobs/runner.js`
- `src/jobs/webhooks.js`
- `src/storage/object.js`
- `src/storage/local.js`
- `src/storage/s3.js`
- `src/storage/r2.js`
- `src/storage/supabase.js`
- `src/storage/cas.js`
- `src/provider-broker/providers.js`
- `src/provider-broker/capabilities.js`
- `src/provider-broker/policy.js`
- `src/provider-broker/planner.js`
- `src/provider-broker/estimator.js`
- `cli/command-registry.js`
- `cli/commands/*.js`
- `scripts/build-product-graph.cjs`
- `scripts/audit-product-kernel.cjs`
- `scripts/audit-claim-scope.cjs`
- `scripts/audit-product-graph-consumers.cjs`
- `bench/privacy/*`
- `bench/claims/*`
- `bench/runtime/*`

Primary existing files to refactor gradually:

- `src/router.js`
- `cli/kolm.js`
- `src/platform-capabilities.js`
- `src/remote-compute.js`
- `src/compute/registry.json`
- `src/provider-registry.js`
- `src/completions-api.js`
- `src/daemon-connector.js`
- `src/compile-pipeline.js`
- `src/distill-pipeline.js`
- `src/artifact.js`
- `src/artifact-runner.js`
- `src/runtime-policy.js`
- `src/lake.js`
- `src/event-store.js`
- `src/event-schema.js`
- `src/dataset-workbench.js`
- `src/label-queue.js`
- `src/privacy-membrane.js`
- `src/audit.js`
- `src/model-registry.js`
- `src/model-weights-manifest.js`
- `services/mcp/server.js`
- `public/account/*.html`
- `public/tui.html`
- `public/docs/api-routes.json`
- `docs/product-surfaces.json`
- `docs/product-journeys.json`
- `docs/product-sota-readiness.json`
- `docs/kolm-format-v1.md`
- `docs/cloud-product-readiness.md`

## 16. Final Definition Of Done

The product is structurally finished when all of this is true:

1. Every product surface has a route module, account view, CLI commands, TUI
   view, API docs, smoke probes, readiness status, and owner.
2. Every user journey can be completed from account UI, CLI, TUI, and API with
   the same response envelope and next-action model.
3. Every train/distill/compile path starts with a build planner and ends with
   artifact evidence or an explainable refusal.
4. Every long-running operation is a durable job with logs, retries, cancel,
   idempotency, audit, and webhooks.
5. Every durable byte is either local-dev scoped or stored through an explicit
   object-storage driver with hashes and retention.
6. Every provider and compute target has capability, cost, privacy, health, and
   fallback metadata.
7. Every `.kolm` artifact contains enough manifest, receipt, split, eval,
   policy, runtime, and lineage data to be useful outside Kolm.
8. Every benchmark claim has a reproducible benchmark ID, hardware/profile
   scope, source date, and expiration.
9. Every enterprise claim has audit, policy, export, and certification status.
10. Every external/package/certification/partner dependency is visible as such,
    not hidden behind "done" language.

The current repo has substantial surface area and strong local verification.
The next level is not breadth. The next level is a product kernel that makes the
breadth coherent, durable, explainable, and impossible to misrepresent.

## 17. Backend Invariants

These invariants should become executable tests. They are the rules that make
the whole system feel finished instead of feature-rich but fragile.

### 17.1 Tenant and workspace invariants

Every persisted object must carry:

- `tenant_id`
- `workspace_id` or explicit `workspace_scope: "none"`
- `namespace`
- `created_by` or explicit system actor
- `created_at`
- `source_surface`
- `source_journey`
- `policy_hash`

Atomic edits:

| ID | Priority | Invariant | Enforcement |
| --- | --- | --- | --- |
| INV-001 | P0 | No durable row without tenant boundary. | storage/store wrapper rejects missing tenant |
| INV-002 | P0 | No account read without workspace scope. | auth middleware attaches workspace |
| INV-003 | P0 | No cross-tenant list route without admin override. | route contract tests |
| INV-004 | P0 | No API key may imply admin unless key scope says admin. | permission tests |
| INV-005 | P1 | No CLI mutation without actor ID in audit event. | CLI integration tests |
| INV-006 | P1 | No webhook without tenant and signature. | webhook verifier |

Why it matters:

The fastest way to lose enterprise trust is a data-boundary ambiguity. The
product should be designed so cross-tenant mistakes are structurally hard, not
just reviewed out.

### 17.2 Evidence invariants

Every evidence object must carry:

- source type
- source hash
- privacy state
- label provenance
- eval eligibility
- retention state
- deletion state
- export state

Atomic edits:

| ID | Priority | Invariant | Enforcement |
| --- | --- | --- | --- |
| INV-007 | P0 | Holdout rows cannot be training rows. | row hash disjointness tests |
| INV-008 | P0 | Synthetic rows cannot silently become holdout truth. | eval eligibility gate |
| INV-009 | P0 | Redacted rows must record redaction classes. | privacy schema test |
| INV-010 | P0 | Zero-retention calls cannot create lake rows. | gateway no-store test |
| INV-011 | P1 | Imported traces must retain original source ID. | importer fixture tests |
| INV-012 | P1 | Purged evidence cannot influence future artifact builds. | lineage purge test |

### 17.3 Build invariants

Every build must be reconstructable as:

`input evidence + policy + planner decision + compute environment + output artifact`

Atomic edits:

| ID | Priority | Invariant | Enforcement |
| --- | --- | --- | --- |
| INV-013 | P0 | No build without build plan hash. | compile/distill/train preflight |
| INV-014 | P0 | No production-ready artifact without real eval provenance. | production-ready gate |
| INV-015 | P0 | No hosted build without durable output storage. | compute broker preflight |
| INV-016 | P0 | No provider teacher call without provider policy and trace. | provider broker |
| INV-017 | P1 | No build promotion without rollback target. | registry promotion route |
| INV-018 | P1 | No build cost over cap without explicit approval. | job runner |

### 17.4 Artifact invariants

Every artifact must answer:

- what is it?
- who built it?
- what data influenced it?
- what data did not influence it?
- what evals did it pass?
- what policy allowed it?
- what runtime can load it?
- what signature proves it?
- how do I diff it?
- how do I roll it back?

Atomic edits:

| ID | Priority | Invariant | Enforcement |
| --- | --- | --- | --- |
| INV-019 | P0 | Manifest hash must bind runtime policy. | verifier |
| INV-020 | P0 | Manifest hash must bind eval suite. | verifier |
| INV-021 | P0 | Manifest hash must bind split hashes. | verifier |
| INV-022 | P0 | Runtime receipt must bind artifact hash. | runner |
| INV-023 | P1 | Registry metadata cannot be required for offline verify. | conformance suite |
| INV-024 | P1 | Yank/deprecate cannot mutate artifact bytes. | registry tests |

### 17.5 Runtime invariants

Every runtime call must be explainable:

- artifact or provider used
- fallback used or not
- cache used or not
- policy decision
- input/output hashes
- latency
- cost if provider call happened
- receipt ID

Atomic edits:

| ID | Priority | Invariant | Enforcement |
| --- | --- | --- | --- |
| INV-025 | P0 | Runtime cannot make hidden network calls. | network boundary tests |
| INV-026 | P0 | Fallback provider must be receipted. | runtime receipt tests |
| INV-027 | P0 | Cache hit cannot cross tenant or privacy policy. | cache tests |
| INV-028 | P1 | Streaming chunks must preserve final receipt. | SSE tests |
| INV-029 | P1 | Tool calls must pass permission policy. | MCP/runtime tests |
| INV-030 | P2 | Runtime metrics must be opt-in for telemetry. | telemetry tests |

## 18. Per-Module Structural Contracts

This section translates the product requirements into module-level contracts.

### 18.1 `src/auth.js`, `src/keys.js`, `src/team.js`, `src/teams.js`

Role:

Own identity, authentication, authorization, plan entitlements, key scopes,
service accounts, tenant/workspace boundaries, and security-critical audit
context.

Required contracts:

- `resolveActor(req)` returns user, service account, key, tenant, workspace,
  plan, scopes, roles.
- `requireScope(actor, scope)` checks API-key permission.
- `requirePermission(actor, action, resource)` checks RBAC.
- `requireEntitlement(actor, feature)` checks billing/product entitlement.
- `auditContext(actor)` returns canonical fields for audit events.

Suggested structural edits:

| ID | Priority | Edit |
| --- | --- | --- |
| MOD-AUTH-001 | P0 | Separate authentication from authorization. |
| MOD-AUTH-002 | P0 | Make every route use permission helpers, not direct plan checks. |
| MOD-AUTH-003 | P0 | Canonicalize legacy plan names at ingestion only. |
| MOD-AUTH-004 | P0 | Add service-account actor type. |
| MOD-AUTH-005 | P1 | Add workspace membership cache with explicit invalidation. |
| MOD-AUTH-006 | P1 | Add audit context builder used by all mutating routes. |

### 18.2 `src/store.js`, `src/event-store.js`, `src/object-storage.js`

Role:

Own persistence semantics. The rest of the product should not know whether
state is local JSON, SQLite, Postgres, S3, R2, Supabase, or filesystem.

Required contracts:

- local dev remains easy
- hosted durable mode is explicit
- object bytes are hashed
- metadata rows are tenant-scoped
- retention is enforceable
- export is reproducible

Suggested structural edits:

| ID | Priority | Edit |
| --- | --- | --- |
| MOD-STORE-001 | P0 | Add `DataStore` interface with local and durable drivers. |
| MOD-STORE-002 | P0 | Add transaction-like append semantics for audit and jobs. |
| MOD-STORE-003 | P0 | Add object storage driver with CAS. |
| MOD-STORE-004 | P0 | Add migration/version metadata for local JSON schemas. |
| MOD-STORE-005 | P1 | Add retention worker. |
| MOD-STORE-006 | P1 | Add export manifest writer. |
| MOD-STORE-007 | P2 | Add encrypted object metadata for BYOK/CMK mode. |

### 18.3 `src/daemon-connector.js`, `src/completions-api.js`, `src/provider-registry.js`

Role:

Own provider compatibility, gateway capture, upstream calls, fallback chains,
streaming normalization, token/cost accounting, and provider health.

Required contracts:

- OpenAI-compatible path
- Anthropic-native path
- Gemini/OpenRouter/custom local path
- provider health and capabilities
- zero-retention capture
- streaming parity
- cost attribution

Suggested structural edits:

| ID | Priority | Edit |
| --- | --- | --- |
| MOD-GW-001 | P0 | Split request normalization from capture persistence. |
| MOD-GW-002 | P0 | Add provider capability registry as executable schema. |
| MOD-GW-003 | P0 | Add typed provider response normalizer. |
| MOD-GW-004 | P0 | Add streaming event normalizer. |
| MOD-GW-005 | P0 | Add provider fallback reason codes. |
| MOD-GW-006 | P1 | Add provider conformance fixtures. |
| MOD-GW-007 | P1 | Add token/cost accounting per provider. |
| MOD-GW-008 | P2 | Add provider marketplace import/update job. |

### 18.4 `src/lake.js`, `src/privacy-membrane.js`, `src/phi-redactor.js`

Role:

Own privacy state, sensitive data detection, redaction, lake query/export,
retention, and privacy reports.

Required contracts:

- fail-closed policy mode
- class-level findings
- deterministic placeholders
- reversible vault only when policy allows
- redaction F1 benchmarks
- deletion/retention state

Suggested structural edits:

| ID | Priority | Edit |
| --- | --- | --- |
| MOD-PRIV-001 | P0 | Make privacy policy a versioned object. |
| MOD-PRIV-002 | P0 | Make every redaction emit class-level findings. |
| MOD-PRIV-003 | P0 | Add benchmark fixtures and F1 reporting. |
| MOD-PRIV-004 | P0 | Add raw-to-redacted mapping vault with strict scope. |
| MOD-PRIV-005 | P1 | Add differential privacy budget ledger. |
| MOD-PRIV-006 | P1 | Add retention/deletion engine integration. |
| MOD-PRIV-007 | P2 | Add external redactor plug-in interface. |

### 18.5 `src/dataset-workbench.js`, `src/label-queue.js`, `src/bakeoff.js`

Role:

Own data development, split integrity, label review, eval suite construction,
and candidate comparison.

Required contracts:

- immutable dataset versions
- train/holdout disjointness
- eval-as-code
- label provenance
- source trace provenance
- active learning
- benchmark compatibility

Suggested structural edits:

| ID | Priority | Edit |
| --- | --- | --- |
| MOD-DATA-001 | P0 | Add dataset version object. |
| MOD-DATA-002 | P0 | Add row-level provenance and checksum. |
| MOD-DATA-003 | P0 | Add label provenance enum. |
| MOD-DATA-004 | P0 | Add eval suite object separate from dataset. |
| MOD-DATA-005 | P1 | Add active learning ranker. |
| MOD-DATA-006 | P1 | Add eval-as-code adapters. |
| MOD-DATA-007 | P1 | Add imported trace fixture pack. |
| MOD-DATA-008 | P2 | Add statistical significance reporting for bakeoffs. |

### 18.6 `src/training-planner.js`, `src/distill-pipeline.js`, `src/remote-compute.js`

Role:

Own build strategy, teacher/student/provider selection, compute selection,
training/distillation orchestration, and remote result import.

Required contracts:

- choose no-train when correct
- choose prompt compression/RAG/cache when better than fine-tuning
- choose teacher and student by evidence
- enforce compute/cost/privacy constraints
- preserve split and eval evidence
- import remote outputs with hashes

Suggested structural edits:

| ID | Priority | Edit |
| --- | --- | --- |
| MOD-TRAIN-001 | P0 | BuildStrategyPlanner becomes mandatory preflight. |
| MOD-TRAIN-002 | P0 | Teacher calls flow through provider broker. |
| MOD-TRAIN-003 | P0 | Remote compute returns canonical TrainResult. |
| MOD-TRAIN-004 | P0 | Hosted jobs require durable storage. |
| MOD-TRAIN-005 | P1 | Multi-teacher candidate generation. |
| MOD-TRAIN-006 | P1 | Student model recommender. |
| MOD-TRAIN-007 | P1 | Cost and time estimator confidence intervals. |
| MOD-TRAIN-008 | P2 | Build strategy benchmark suite. |

### 18.7 `src/compile-pipeline.js`, `src/artifact.js`, `src/production-ready.js`

Role:

Own compile phases, packaging, manifest/receipt/signature, production-readiness
decision, and artifact compatibility.

Required contracts:

- no fake evals
- no silent stubs
- no train/holdout leakage
- no unsigned production artifacts
- no unscoped runtime claims
- clear failure diagnostics

Suggested structural edits:

| ID | Priority | Edit |
| --- | --- | --- |
| MOD-COMP-001 | P0 | Add phase manifest for each compile step. |
| MOD-COMP-002 | P0 | Add build receipt separate from runtime receipt. |
| MOD-COMP-003 | P0 | Add production readiness failure taxonomy. |
| MOD-COMP-004 | P0 | Add artifact semver and compatibility policy. |
| MOD-COMP-005 | P1 | Add artifact diff API. |
| MOD-COMP-006 | P1 | Add conformance test package. |
| MOD-COMP-007 | P1 | Add transparency-log real mode. |
| MOD-COMP-008 | P2 | Add external runtime SDK acceptance suite. |

### 18.8 `src/runtime.js`, `src/artifact-runner.js`, `src/runtime-policy.js`

Role:

Own execution, policy enforcement, local/offline run, receipts, fallback,
cache, streaming, and tool permission enforcement.

Required contracts:

- explicit runtime target
- no hidden provider call
- policy-bound tool access
- cache privacy
- streaming receipt
- local/offline verification

Suggested structural edits:

| ID | Priority | Edit |
| --- | --- | --- |
| MOD-RUN-001 | P0 | Runtime policy schema is part of artifact manifest. |
| MOD-RUN-002 | P0 | Every run emits receipt or explicit disabled reason. |
| MOD-RUN-003 | P0 | Enforce tool permissions. |
| MOD-RUN-004 | P0 | Enforce token/input/output budgets. |
| MOD-RUN-005 | P1 | Add runtime conformance across SDKs. |
| MOD-RUN-006 | P1 | Add local benchmark mode. |
| MOD-RUN-007 | P2 | Add LTS runtime compatibility tests. |

### 18.9 `src/model-registry.js`, `src/model-weights-manifest.js`

Role:

Own model knowledge, availability, weights, metadata, license, modality,
trainability, runtime fit, and source currency.

Required contracts:

- no model row without status
- no model row without source date
- no train recommendation without trainability
- no edge recommendation without memory/runtime fit
- no enterprise recommendation without license policy

Suggested structural edits:

| ID | Priority | Edit |
| --- | --- | --- |
| MOD-MODEL-001 | P0 | Add model availability status enum. |
| MOD-MODEL-002 | P0 | Add license policy evaluator. |
| MOD-MODEL-003 | P0 | Add runtime fit matrix. |
| MOD-MODEL-004 | P1 | Add source freshness auditor. |
| MOD-MODEL-005 | P1 | Add model card hash ingestion. |
| MOD-MODEL-006 | P1 | Add weight cache verifier. |
| MOD-MODEL-007 | P2 | Add model benchmark imports. |

### 18.10 `services/mcp/server.js`, `src/agent-telemetry.js`, `src/registry.js`

Role:

Own agent tool serving, MCP export, agent telemetry, registry search, artifact
publication, publisher verification, private registry, dependency graph, and
rollback.

Required contracts:

- MCP tool manifest is signed
- tool permissions are explicit
- agent calls are receipted
- registry metadata never required for offline run
- private registry is tenant-scoped

Suggested structural edits:

| ID | Priority | Edit |
| --- | --- | --- |
| MOD-AGENT-001 | P0 | Signed MCP tool manifest. |
| MOD-AGENT-002 | P0 | Agent run receipt. |
| MOD-AGENT-003 | P0 | Tool permission policy. |
| MOD-AGENT-004 | P1 | Framework adapters with smoke fixtures. |
| MOD-AGENT-005 | P1 | Registry dependency graph. |
| MOD-AGENT-006 | P1 | Private registry durable storage. |
| MOD-AGENT-007 | P2 | Verified publisher workflow. |

## 19. Route Contract Matrix

Every backend route should be classified by side effect and proof burden.

### 19.1 Route classes

| Route class | Side effect | Auth | Idempotency | Required proof |
| --- | --- | --- | --- | --- |
| public metadata | none | none | safe | source version |
| account read | none | required | safe | tenant/workspace |
| account mutation | yes | required | required | audit event |
| capture proxy | maybe | optional or required by mode | request hash | capture/no-store receipt |
| lake query | none | required | safe | privacy policy hash |
| dataset mutation | yes | required | required | dataset version |
| build launch | yes | required | required | job ID and build plan hash |
| job action | yes | required | required | job audit event |
| artifact download | none | required or public artifact | safe | signed URL or artifact hash |
| runtime inference | yes | required unless local/offline | request hash | inference receipt |
| governance export | yes | admin | required | export manifest |
| webhook receive | yes | signed | event ID | signature verification |

### 19.2 Required route metadata

Every route should declare:

```js
{
  method: 'POST',
  path: '/v1/compile',
  operation_id: 'compileLaunch',
  surface: 'compile-artifact-verification',
  journey: 'compile-verify',
  route_class: 'build launch',
  auth: 'required',
  required_permissions: ['build:create'],
  required_entitlements: ['compile'],
  idempotency: 'required',
  side_effects: ['job.create', 'audit.append'],
  readiness_requirements: ['holdout-independence', 'async-compile-webhooks'],
  request_schema: 'CompileLaunchRequest',
  response_schema: 'JobEnvelope',
  smoke_probe: true
}
```

Atomic edits:

| ID | Priority | Edit |
| --- | --- | --- |
| ROUTE-META-001 | P0 | Add metadata declaration to every route. |
| ROUTE-META-002 | P0 | Generate OpenAPI tags and operation IDs from metadata. |
| ROUTE-META-003 | P0 | Generate smoke probes from metadata. |
| ROUTE-META-004 | P0 | Validate auth ordering from metadata. |
| ROUTE-META-005 | P1 | Generate account UI next actions from metadata. |
| ROUTE-META-006 | P1 | Generate CLI command docs from metadata. |

## 20. CLI, TUI, Account UI, And API Parity

Every product surface should expose the same core action in four places:

- API for automation
- CLI for developers
- TUI for local operator workflow
- Account UI for team/product workflow

### 20.1 Parity matrix

| Journey | API | CLI | TUI | Account UI |
| --- | --- | --- | --- | --- |
| gateway-capture | connect, proxy, health | `kolm capture`, `kolm connectors` | live traffic view | connectors page |
| privacy-lake | lake stats/query/export | `kolm lake`, `kolm privacy` | lake view | lake/privacy pages |
| datasets-labeling | datasets, labels, evals | `kolm dataset`, `kolm label`, `kolm eval` | dataset/label views | datasets/labeling pages |
| train-distill | plan, launch, jobs | `kolm train`, `kolm distill` | builds view | builds page |
| models-backbones | list, recommend, pull | `kolm models` | models view | models page |
| compile-verify | compile, verify, diff | `kolm compile`, `kolm verify`, `kolm diff` | artifacts view | artifacts page |
| runtime-inference | run, chat, responses | `kolm run`, `kolm serve` | run/chat view | runtime page |
| compute-cloud | readiness, launch | `kolm cloud`, `kolm compute` | compute view | compute/storage pages |
| devices-fleet | detect, recommend, deploy | `kolm devices`, `kolm tunnel` | devices view | devices page |
| enterprise-governance | audit, policy, export | `kolm audit`, `kolm keys` | governance view | governance pages |
| agents-registry | mcp, registry, publish | `kolm mcp`, `kolm hub` | agents view | agent telemetry/marketplace |

### 20.2 Parity tests

Atomic edits:

| ID | Priority | Edit |
| --- | --- | --- |
| PARITY-001 | P0 | Add `docs/product-journeys.json` parity checker for API/CLI/TUI/account. |
| PARITY-002 | P0 | Add account links for every CLI command group. |
| PARITY-003 | P0 | Add CLI command for every mutating account action. |
| PARITY-004 | P1 | Add TUI view for every repeated operator workflow. |
| PARITY-005 | P1 | Add "copy command" and "open in UI" cross-links. |
| PARITY-006 | P2 | Add guided state machine for each journey. |

### 20.3 UX from backend state

The backend should return enough state for UI to be guided:

- blocked reason
- missing env var
- missing permission
- missing entitlement
- missing evidence
- next command
- next route
- docs URL
- estimated time
- estimated cost
- privacy boundary
- risk tier

Atomic edits:

| ID | Priority | Edit |
| --- | --- | --- |
| UXSTATE-001 | P0 | Add `next_actions` to every route envelope. |
| UXSTATE-002 | P0 | Add `blocking_reasons` to readiness responses. |
| UXSTATE-003 | P1 | Add cost/time estimate fields to build routes. |
| UXSTATE-004 | P1 | Add docs URL to every blocked integration. |
| UXSTATE-005 | P1 | Add policy explanation to every denial. |

## 21. Failure Mode Library

The product should make failure states helpful. Each failure should classify,
explain, and guide.

### 21.1 Failure classes

| Failure class | Example | User-visible next action |
| --- | --- | --- |
| auth_missing | no key | sign in or set `KOLM_API_KEY` |
| permission_denied | key lacks `build:create` | ask admin or create scoped key |
| entitlement_missing | Free plan lacks hosted GPU | upgrade or use local compute |
| provider_missing | no `ANTHROPIC_API_KEY` | connect Claude or choose OpenAI/local |
| provider_unhealthy | provider timeout | retry, fallback, or switch provider |
| privacy_blocked | PHI cannot leave device | use local mode or redaction |
| data_insufficient | too few examples | capture more, label more, synthetic seed |
| data_leakage | train/eval overlap | regenerate split |
| eval_missing | no holdout/eval | create eval suite |
| quality_gate_failed | K-score under threshold | inspect failures, add labels, change model |
| compute_missing | no GPU and no hosted provider | configure Modal/RunPod/Together/SSH |
| storage_missing | hosted build lacks durable output | configure R2/S3/Supabase |
| artifact_invalid | signature/hash mismatch | reject artifact, rebuild |
| runtime_incompatible | target lacks runtime | export compatible target |
| policy_denied | org policy blocks provider | choose allowed provider |
| certification_scope | SOC2 not live | show certification status |

### 21.2 Failure contract

Every error envelope should include:

```json
{
  "ok": false,
  "error": {
    "code": "compute_missing",
    "message": "No GPU or hosted compute provider is configured.",
    "surface": "train-distill",
    "journey": "train-distill",
    "severity": "blocker",
    "retryable": false,
    "docs_url": "/docs/cloud",
    "next_actions": [
      {
        "kind": "command",
        "label": "Run cloud readiness",
        "value": "kolm cloud readiness --json"
      }
    ]
  }
}
```

Atomic edits:

| ID | Priority | Edit |
| --- | --- | --- |
| FAIL-001 | P0 | Add error code registry. |
| FAIL-002 | P0 | Convert build failures to failure classes. |
| FAIL-003 | P0 | Convert provider failures to failure classes. |
| FAIL-004 | P0 | Convert auth/billing failures to failure classes. |
| FAIL-005 | P1 | Add UI/CLI rendering for next actions. |
| FAIL-006 | P1 | Add failure analytics by surface. |

## 22. Security Architecture Deep Dive

### 22.1 Security goals

Kolm security goals:

1. Protect tenant data.
2. Prevent silent data exfiltration through providers or tools.
3. Preserve artifact integrity.
4. Preserve audit integrity.
5. Make policy decisions inspectable.
6. Make enterprise evidence exportable.
7. Make local/offline mode meaningfully local/offline.

### 22.2 Threat model

Threats to model:

- cross-tenant data read
- compromised API key
- malicious `.kolm` artifact
- artifact path traversal
- forged receipt
- forged audit event
- prompt injection leading to tool exfiltration
- provider fallback violating policy
- cache leakage across tenants
- poisoned training data
- holdout leakage
- malicious registry artifact
- stale model license metadata
- remote compute result tampering
- webhook replay
- SIEM/webhook secret exposure
- browser runtime supply-chain issue

Atomic edits:

| ID | Priority | Edit |
| --- | --- | --- |
| SEC-001 | P0 | Add threat model document tied to tests. |
| SEC-002 | P0 | Add artifact sandbox policy for executable bundles. |
| SEC-003 | P0 | Add path traversal tests for all ZIP readers. |
| SEC-004 | P0 | Add cache tenant-isolation tests. |
| SEC-005 | P0 | Add webhook replay protection. |
| SEC-006 | P0 | Add provider fallback policy enforcement. |
| SEC-007 | P1 | Add OPA-style policy engine. |
| SEC-008 | P1 | Add prompt-injection guardrail adapters. |
| SEC-009 | P1 | Add dependency/SBOM scanner. |
| SEC-010 | P1 | Add artifact malware/modelscan integration point. |
| SEC-011 | P2 | Add external pentest readiness pack. |

### 22.3 Policy decision model

Policy decisions should be returned and receipted:

```json
{
  "policy_id": "pol_enterprise_default",
  "policy_hash": "sha256:...",
  "decision": "allow|deny|redact|local_only|review_required",
  "reasons": [
    "provider anthropic allowed for workspace",
    "PHI detected: redaction required before upstream"
  ],
  "evidence_refs": []
}
```

This is how security becomes product logic instead of prose.

## 23. Compute And Model Deep Dive

### 23.1 Compute user stories

The product must support these users:

1. Developer with CPU laptop.
2. Developer with NVIDIA workstation.
3. Mac user with Apple Silicon.
4. Windows user with DirectML/OpenVINO.
5. Enterprise with Kubernetes GPUs.
6. Startup without GPU, willing to use hosted GPU.
7. Regulated buyer needing BYOC.
8. Air-gapped buyer.
9. Mobile/edge app developer.
10. Agent-platform team needing tool artifacts.

### 23.2 Compute decision matrix

| Constraint | Best default | Alternative | Avoid |
| --- | --- | --- | --- |
| no GPU, low budget | hosted short job or smaller artifact | prompt compression/RAG | pretending CPU can train large model |
| strict privacy | local/BYOC/air-gap | redacted hosted eval | raw hosted teacher calls |
| fast deploy | provider fallback or recipe compile | managed GPU | custom Kubernetes first |
| mobile target | CoreML/LiteRT/ExecuTorch target | server fallback | generic GGUF without mobile proof |
| browser target | WASM/WebGPU recipe or small model | serverless fallback | huge weight bundle |
| enterprise audit | BYOC + signed receipts | managed with BAA | unreceipted provider path |

### 23.3 Model decision matrix

| Task | Recommended first move | When to train/distill |
| --- | --- | --- |
| deterministic extraction | recipe compile plus evals | if rule coverage fails |
| classification | small model or recipe compile | if examples are numerous and stable |
| rewrite/summarize | prompt compression plus evals | if repeated style and cost is high |
| RAG QA | RAG artifact | if retrieval stable and generation pattern repeats |
| tool policy | compiled policy/tool artifact | if agent errors repeat |
| multimodal extraction | local extractor sidecar | if labels and target device exist |
| code task | specialist model or agent tool | if task repeats with evalable outputs |
| regulated redaction | deterministic plus ML redactor | train only with audited labels |

Atomic edits:

| ID | Priority | Edit |
| --- | --- | --- |
| DECIDE-001 | P0 | Add task classifier for build strategy. |
| DECIDE-002 | P0 | Add no-train recommendation path. |
| DECIDE-003 | P0 | Add model/runtime fit score. |
| DECIDE-004 | P1 | Add latency and cost simulator. |
| DECIDE-005 | P1 | Add target device simulator. |
| DECIDE-006 | P1 | Add policy-aware provider selector. |

## 24. Standards And Ecosystem Plan

The `$10B` move is not just having `.kolm`. It is making `.kolm` useful outside
Kolm.

### 24.1 Spec maturity stages

| Stage | Meaning | Required artifacts |
| --- | --- | --- |
| private spec | internal docs | `docs/kolm-format-v1.md` |
| public draft | versioned public docs | schema, examples, verifier |
| conformance | third-party can test parser | conformance suite |
| reference runtime | third-party can run artifacts | MIT/Apache runtime package |
| registry interoperability | third-party can publish/verify | registry API spec |
| foundation path | neutral governance | charter and contributor process |
| ecosystem adoption | external runtimes support it | Ollama/llama.cpp/HF/etc. adapters |

Atomic edits:

| ID | Priority | Edit |
| --- | --- | --- |
| STD-001 | P0 | Publish `.kolm` spec with examples and schemas. |
| STD-002 | P0 | Publish standalone verifier package. |
| STD-003 | P1 | Publish conformance suite. |
| STD-004 | P1 | Publish reference runtime package. |
| STD-005 | P1 | Publish registry API spec. |
| STD-006 | PX | Start neutral standards/foundation process. |
| STD-007 | PX | Build external runtime adapters. |

### 24.2 Integration targets

Priority external integration targets:

1. Hugging Face Hub metadata and artifacts.
2. Ollama model/runtime metadata.
3. llama.cpp/GGUF verification metadata.
4. ONNX Runtime execution provider metadata.
5. vLLM and SGLang deployment metadata.
6. Cloudflare Workers/browser runtime package.
7. LangSmith/Langfuse/Phoenix/Braintrust imports.
8. MCP tool registries.
9. Sigstore transparency log.
10. OPA policy bundles.

## 25. Final Research Synthesis

Kolm is already broad. The best next move is not to add yet another page,
provider, route, or demo. The best next move is to make the breadth inevitable:

- one product graph
- one response envelope
- one route metadata system
- one CLI command registry
- one durable job system
- one object storage and evidence system
- one provider/compute broker
- one artifact proof model
- one benchmark/claim governance system
- one enterprise export system

That is the difference between a large codebase and a finished infrastructure
product.
