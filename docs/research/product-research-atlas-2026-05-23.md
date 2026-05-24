# Kolm Product Research Atlas - 2026-05-23

Machine-readable source: `docs/product-research-atlas.json`

Verification:

```bash
npm run verify:research-atlas
```

## Scope

This is W600. W598 created an implementation buildbook. W599 created closure
contracts for external/package/benchmark/certification gates. W600 adds a
second research pass focused on newer frontier pressure that was still too
light:

- native low-bit model families rather than only post-training quantization
- FP4/NVFP4/MXFP4 recovery loops rather than generic INT4/FP8 selection
- vLLM/TensorRT/SGLang runtime policy fusion
- Ray/Kueue/SkyPilot/AWS serving and training schedulers
- GraphRAG/RAPTOR/ColBERT retrieval compilers
- DSPy-style prompt program optimization before training
- PEFT/LoRA/QLoRA/DoRA adapter strategy
- OWASP/garak red-team gates for agent and runtime surfaces
- OpenTelemetry/Sigstore/SLSA release and receipt rails

The verifier fails if this atlas does not cover:

- all 12 product journeys
- all 8 customization dimensions
- all 8 open readiness gates
- all 9 tracked metrics
- all 12 invention portfolio ids
- all research categories
- every source in at least one invention delta

## Main Insight

Kolm should not be "a distillation product", "a quantization product", "a RAG
product", or "a runtime product." The right shape is a compiler of decisions.

The product should choose the cheapest behavior-preserving path across:

1. prompt/program optimization
2. retrieval/index compilation
3. provider routing
4. PEFT/adapters
5. teacher distillation
6. native low-bit students
7. post-training quantization
8. quantization-aware recovery
9. runtime policy fusion
10. cloud/BYOC scheduling
11. verifiable receipts
12. package, benchmark, adoption, and certification evidence

The user-facing product should feel simple because this decision graph is doing
the hard work.

## Research Base

Primary and official sources in W600 include:

- BitNet 1.58-bit research: https://arxiv.org/abs/2402.17764
- bitnet.cpp: https://arxiv.org/abs/2502.11880
- BitNet b1.58 2B4T: https://arxiv.org/abs/2504.12285
- TensorRT-LLM quantization: https://nvidia.github.io/TensorRT-LLM/1.2.0rc4/features/quantization.html
- NVIDIA NVFP4 quantization-aware distillation: https://research.nvidia.com/labs/nemotron/files/NVFP4-QAD-Report.pdf
- TorchAO inference: https://docs.pytorch.org/ao/stable/workflows/inference.html
- TorchAO training: https://docs.pytorch.org/ao/stable/workflows/training.html
- Torch-TensorRT FP4/FP8/INT8 quantization: https://docs.pytorch.org/TensorRT/user_guide/shapes_precision/quantization.html
- vLLM speculative decoding: https://docs.vllm.ai/en/latest/features/spec_decode.html
- vLLM hidden-state extraction: https://vllm.ai/blog/extract-hidden-states
- Ray Serve LLM: https://docs.ray.io/en/latest/serve/llm
- Ray Serve autoscaling: https://docs.ray.io/en/latest/serve/autoscaling-guide.html
- SkyPilot managed jobs: https://docs.skypilot.co/en/latest/examples/managed-jobs.html
- Kubernetes Kueue jobs: https://kueue.sigs.k8s.io/docs/tasks/run/jobs/
- AWS Batch GPU jobs: https://docs.aws.amazon.com/batch/latest/userguide/gpu-jobs.html
- Cloudflare R2 presigned URLs: https://developers.cloudflare.com/r2/api/s3/presigned-urls/
- Microsoft GraphRAG: https://www.microsoft.com/en-us/research/project/graphrag/
- RAPTOR: https://arxiv.org/abs/2401.18059
- ColBERTv2: https://arxiv.org/abs/2112.01488
- DSPy MIPROv2: https://dspy.org.cn/api/optimizers/MIPROv2/
- Hugging Face PEFT LoRA guide: https://huggingface.co/docs/peft/v0.17.0/developer_guides/lora
- Predibase adapters: https://docs.predibase.com/fine-tuning/adapters
- OpenPipe: https://github.com/OpenPipe/OpenPipe
- Braintrust evals: https://www.braintrust.dev/docs/evaluate/run-evaluations
- LangSmith evals: https://docs.langchain.com/langsmith/evaluation
- Conformal LLM judge intervals: https://arxiv.org/abs/2509.18658
- Doubly robust LLM judge calibration: https://arxiv.org/abs/2512.11150
- OWASP LLM Top 10: https://owasp.org/www-project-top-10-for-large-language-model-applications/
- garak: https://docs.garak.ai/garak/overview/what-is-garak
- OpenTelemetry GenAI conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/
- Sigstore: https://docs.sigstore.dev/
- SLSA v1.0: https://slsa.dev/spec/v1.0/
- Model Context Protocol: https://modelcontextprotocol.io/specification

## Invention Deltas

### Native Ternary Student Target

Add a build-strategy branch that recommends native low-bit students when the
target is CPU, edge, browser, or cheap local inference. Treat BitNet-style
models as a separate model family, not an INT4 checkbox.

Acceptance bar:

- compares prompt-only, dense student, quantized dense student, and native
  low-bit student
- receipts CPU memory, energy class, runtime, and K-score interval
- blocks unsupported modalities and package-unreleased runtimes

### FP4 Distillation Recovery Loop

Fuse the quantization oracle and distill strategy. When FP4/NVFP4 is supported
but quality falls into the risk band, run a recovery distillation plan rather
than picking raw FP4 or falling back blindly.

Acceptance bar:

- records numeric format, QDQ graph or runtime format, recovery data hash, and
  teacher policy
- fails closed when the teacher is not policy-allowed
- keeps public benchmark claims scoped until public data exists

### Runtime Policy Fusion Planner

Compile speculative decoding, prefix reuse, KV-cache quantization, streaming,
hidden-state diagnostics, and telemetry into runtime policy fields.

Acceptance bar:

- rejected policies have reasons
- content capture is opt-in
- distribution-preservation checks gate speculative decoding

### SLO Serving Autoscaler

Translate artifact SLOs into serving topology: replicas, max ongoing requests,
queue policy, prefill/decode split, scale-to-zero, and fallback plan.

Acceptance bar:

- SLO inputs include p95/p99, cost ceiling, privacy, cold-start tolerance
- receipts autoscaler config and observed SLO metrics

### RAG Artifact Compiler

Compile retrieval systems as `.kolm` artifacts: dense, sparse, hybrid, ColBERT,
RAPTOR, GraphRAG, citation verification, index manifests, and source lineage.

Acceptance bar:

- RAG artifact has index build hash and source policy
- version diff includes index and source changes
- citation verifier can fail promotion

### Prompt Program Optimizer Before Training

Run DSPy-style instruction/demo optimization before model training when the task
can be solved with better prompts.

Acceptance bar:

- training is not recommended until prompt optimization plateaus
- prompt artifacts are signed and versioned
- K-score interval decides promotion

### Adapter Hypervisor

Choose LoRA, QLoRA, DoRA, full fine-tune, prompt optimization, RAG, or
distillation from the same strategy brain.

Acceptance bar:

- adapter strategy includes target runtime and merge state
- adapter overhead is measured in serving plan
- artifact receipt includes base model hash and adapter config

### Security Red-Team Compiler

Run OWASP/garak-style probes as compile and agent-tool promotion gates.

Acceptance bar:

- prompt injection, leakage, tool misuse, denial of service, and insecure output
  probes have manifests
- critical probe failure blocks deployment
- residual risk is receipted

### OTEL Receipt Bridge

Map Kolm receipts to safe OpenTelemetry GenAI spans and immutable eval
snapshots.

Acceptance bar:

- prompts/outputs are not captured by default
- trace IDs link to artifact receipts
- eval snapshots are immutable after promotion

### Signed Release Rail

Convert package-release blockers into signed artifacts, checksums, provenance,
clean-install logs, and docs generated from release manifests.

Acceptance bar:

- no placeholder checksums
- package docs match manifests
- readiness updates only after release evidence exists

### Cloud Scheduler Arbitrage

Choose local, SSH, RunPod, AWS Batch, Kubernetes/Kueue, spot/preemptible, or
provider execution based on deadline, budget, privacy, checkpointing, and data
residency.

Acceptance bar:

- every non-local job has object storage and checkpoint paths
- preemption/retry/cost deltas are receipted

### Public Benchmark Reproducer

Separate local fixture evidence from public benchmark data.

Acceptance bar:

- raw outputs, receipts, scorer logs, model/provider versions, hardware, and
  pricing assumptions are signed and published before public claims

### Standard Conformance Kit

Package spec grammar, verifier examples, runtime adoption fixtures, MCP checks,
OTEL mapping, and provenance examples.

Acceptance bar:

- conformance runs without hosted API credentials
- adoption remains external until merged/released

### Active Data Engine

Prioritize captured rows by uncertainty, cost impact, privacy state, redaction
risk, replay overlap, failed citations, and security failures.

Acceptance bar:

- row selection reason is receipted
- zero-retention uses metadata-only signals
- label queues obey tenant/RBAC policy

## Implementation Rule

Any implementation agent picking up this atlas should follow this order:

1. Add planner output first.
2. Add receipt fields second.
3. Add local simulator and focused unit tests third.
4. Wire product graph/readiness state fourth.
5. Update public copy only from evidence state.

That order prevents the product from becoming impressive-looking but
unprovable.
