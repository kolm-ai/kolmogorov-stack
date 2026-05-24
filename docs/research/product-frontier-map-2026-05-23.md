# Kolm Product Frontier Map - 2026-05-23

This document is the implementation handoff for W595. It turns the current product truth spine into a competitor-aware, research-backed build map. It is intentionally backend/product owned: it does not redesign public pages, and it does not claim external proof that has not happened.

Machine-readable source: `docs/product-frontier-map.json`

Verification:

```bash
npm run verify:frontier-map
```

## What Changed

W593 documented deep invention specs. W595 adds the missing competitive frontier layer: what each serious competitor or infrastructure primitive already makes users expect, where Kolm must match it, and where Kolm can be structurally stronger.

The result is 14 executable programs across 12 capability axes:

- `provider-gateway`
- `teacher-training`
- `serving-engine`
- `compiler-runtime`
- `quantization`
- `eval-observability`
- `privacy-governance`
- `cloud-compute`
- `package-distribution`
- `registry-network`
- `device-edge`
- `agent-tools`

The simulator checks that these programs cover:

- 12 product journeys from `public/product-graph.json`
- 8 customization dimensions from `public/product-graph.json`
- all 8 currently open readiness gates from `docs/product-sota-readiness.json`
- all 9 tracked valuation/product metrics from the invention portfolio
- 14 direct competitor or infrastructure categories

## Research Inputs

The research set uses primary or official sources where possible:

- OpenAI SFT and distillation: https://platform.openai.com/docs/guides/distillation
- Anthropic MCP: https://docs.anthropic.com/en/docs/mcp
- Anthropic MCP connector: https://docs.anthropic.com/en/docs/agents-and-tools/mcp-connector
- Fireworks LoRA deployment: https://docs.fireworks.ai/fine-tuning/deploying-loras
- Fireworks serverless inference: https://docs.fireworks.ai/serverless/overview
- Together fine-tuning: https://docs.together.ai/docs/fine-tuning-overview
- Together inference/GPU surface: https://docs.together.ai/docs/inference-rest
- Predibase fine-tuning: https://docs.predibase.com/fine-tuning/overview
- LoRAX repo: https://github.com/predibase/lorax
- OpenPipe fine-tuning: https://docs.openpipe.ai/features/fine-tuning/quick-start
- Amazon Bedrock distillation: https://docs.aws.amazon.com/bedrock/latest/userguide/model-distillation.html
- Amazon Bedrock fine-tuning: https://docs.aws.amazon.com/en_us/bedrock/latest/userguide/custom-model-fine-tuning.html
- vLLM OpenAI-compatible server: https://docs.vllm.ai/en/stable/serving/openai_compatible_server/
- vLLM LoRA adapters: https://docs.vllm.ai/en/stable/features/lora/
- SGLang OpenAI-compatible API: https://docs.sglang.io/docs/basic_usage/openai_api
- SGLang LoRA serving: https://docs.sglang.io/docs/advanced_features/lora
- TensorRT-LLM quantization: https://nvidia.github.io/TensorRT-LLM/latest/features/quantization.html
- TensorRT-LLM IFB/paged attention: https://nvidia.github.io/TensorRT-LLM/features/paged-attention-ifb-scheduler.html
- Hugging Face TGI: https://huggingface.co/docs/text-generation-inference/index
- ONNX Runtime execution providers: https://onnxruntime.ai/docs/execution-providers/
- IREE deployment configurations: https://iree.dev/guides/deployment-configurations/
- ExecuTorch: https://docs.pytorch.org/executorch/stable/index.html
- MLIR paper: https://arxiv.org/abs/2002.11054
- LangSmith: https://docs.smith.langchain.com/
- Braintrust evals: https://www.braintrust.dev/docs/evaluate
- Arize Phoenix: https://arize.com/docs/phoenix
- W&B Weave evals: https://weave-docs.wandb.ai/guides/core-types/evaluations
- OpenTelemetry GenAI conventions: https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/
- Cloudflare R2 S3 API: https://developers.cloudflare.com/r2/api/s3/api/
- Cloudflare Workers AI: https://developers.cloudflare.com/workers-ai/
- Sigstore Cosign: https://docs.sigstore.dev/quickstart/quickstart-cosign/

## Core Insight

Kolm should not compete as "another fine-tuning UI" or "another serving engine." Those markets already have strong players:

- Fireworks and Together win hosted model access and GPU convenience.
- Predibase/LoRAX wins adapter serving density.
- OpenPipe wins simple fine-tuning UX.
- Bedrock wins hyperscaler procurement.
- vLLM, SGLang, TGI, TensorRT-LLM, ONNX Runtime, IREE, and ExecuTorch win runtime primitives.
- LangSmith, Braintrust, Phoenix, and Weave win eval/observability operator UX.
- Sigstore/SLSA/CycloneDX win supply-chain trust vocabulary.

Kolm's best structural lane is above them: the artifact, proof, compiler decision, and governance layer that can use all of them. The .kolm artifact should carry behavior, eval, runtime target, receipt, model lineage, privacy policy, and deployability across providers and engines.

## Programs

### 1. Provider Parity Router

Build one provider policy engine for OpenAI, Anthropic, Together, Bedrock, Cloudflare, local .kolm, and generic OpenAI-compatible targets. It should rank providers by task capability, privacy, cost, latency, retention, tool support, and fallback safety.

Why it matters: users asked why only OpenAI, not Claude. A finished product cannot make that a hidden backend choice. Provider selection must be visible and consistent across capture, teacher labeling, distillation, compile, runtime, CLI, TUI, account UI, and OpenAPI.

### 2. Teacher Training Orchestrator

Turn examples and evals into a training plan: prompt-only, collect more data, distill, LoRA, full fine-tune, preference tuning, RFT-style grader loop, managed Bedrock/Together/OpenAI job, or local/BYOC runner.

Why it matters: top AI researchers will not trust a tool that blindly trains. The product must explain when not to fine-tune, when to label, when to use synthetic teacher data, when to LoRA, and when to stay prompt/RAG.

### 3. Serving Engine Fabric

Generate runnable serving manifests for vLLM, SGLang, TGI, TensorRT-LLM, ONNX Runtime, llama.cpp/GGUF, MLX, CoreML, and ExecuTorch from a workload profile.

Why it matters: runtime is not one thing. Adapter-heavy workloads differ from edge workloads, NVIDIA low-latency workloads, and broad enterprise hardware workloads. The compiler must select and prove the target.

### 4. Kolm IR Lowering Matrix

Define which .kolm recipe features lower to which runtimes, with unsupported-feature diagnostics. This makes "AI compiler" defensible.

Why it matters: the line between marketing and compiler is the lowering matrix. If a target does not support a feature, the product should explain why and offer another target.

### 5. Quantization Runtime Oracle

Choose AWQ, GPTQ, FP8, FP4, KV-cache quantization, ONNX execution provider, mobile target, or no quantization based on task, model, context length, hardware, and K-score risk.

Why it matters: quantization is a quality-risk optimizer, not a compression toggle. The product needs calibration rows and runtime-specific constraints to avoid false wins.

### 6. Eval Observability Spine

Export OpenTelemetry GenAI spans and connect traces to datasets, replay, K-score drilldown, external eval tools, and production shadow evals.

Why it matters: proof is the product. K-score only becomes credible if a user can click from score to row-level evidence, replay, trace, and train/holdout provenance.

### 7. Privacy Governance Membrane

Compile retention, redaction, differential privacy, CMK/BYOK, tenant RBAC, storage residency, and compliance evidence into executable policy.

Why it matters: regulated buyers need controls, not claims. Certification remains external, but evidence generation and policy enforcement must be productized.

### 8. Cloud Compute Control Plane

Support users with no local GPU through local, SSH, managed GPU, AWS, Cloudflare, RunPod, Together, Modal, and BYOC worker plans with R2/S3/Supabase/local storage staging.

Why it matters: training, distillation, quantization, benchmarking, and compiling cannot assume local hardware. The product must plan compute and storage together.

### 9. Package Release Factory

Make package release status structural across npm, PyPI, crates, Homebrew, winget, apt, SwiftPM, Kotlin/Maven, React Native, WASM, MCP, and VS Code.

Why it matters: local source trees are not public install channels. The product must not advertise unpublished packages as shipped.

### 10. Registry Network Effects

Make .kolm artifacts searchable, diffable, signed, deployable, private-registry capable, and dependency-aware.

Why it matters: the artifact format becomes valuable only if developers can discover, pin, verify, deploy, and govern artifacts like real software packages.

### 11. Device Runtime Autopilot

Profile phone, laptop, browser, edge gateway, NPU, and air-gapped server targets and choose CoreML/MLX, ONNX EP, ExecuTorch, LiteRT, WASM/WebGPU, OpenVINO, QNN, GGUF, or cloud fallback.

Why it matters: on-device AI is not one runtime. Battery, memory, cold start, offline mode, and NPU availability decide whether an artifact is useful.

### 12. Agent Tool Supply Chain

Compile .kolm artifacts into MCP servers and tool bundles with schema tests, policy limits, signed dependencies, runtime receipts, and Claude/OpenAI-compatible probes.

Why it matters: agent tools are becoming distributed software artifacts. Kolm should be the signed artifact layer for agent behavior.

### 13. Format Governance Standard

Turn the .kolm spec into a neutral-governance-ready packet with conformance tests, verifier CLI, compatibility policy, optional Sigstore bundles, and external adoption ledger.

Why it matters: this is the format-winner path. Local docs are not enough; external adoption must remain a separately verified gate.

### 14. Benchmark Evidence Network

Publish signed benchmark packets for provider, distill, quantize, compile, and runtime comparisons with model, hardware, dataset, cost, latency, quality, and date.

Why it matters: benchmark claims drive credibility but are also easy to overclaim. The release system must reject stale or unverified public claims.

### 15. Data Lake Governance Loop

Turn capture lake rows into filtered, redacted, labeled, exportable, and recompile-ready datasets.

Why it matters: the capture lake is the data flywheel. Without label-next and compile-next loops, it is just logging.

### 16. Multimodal Tokenization Targets

Represent model family, tokenizer, processor, modality, schema, and runtime support for text, vision-language, audio, embedding, rerank, classifier, and tool-call artifacts.

Why it matters: frontier product depth means not silently assuming chat text. Unsupported multimodal targets must fail with precise alternatives.

## Acceptance Bar

The W595 simulator is deliberately conservative. It fails if:

- fewer than 25 primary sources are recorded
- fewer than 12 competitor/infrastructure rows are recorded
- fewer than 12 programs exist
- any program references an unknown journey, dimension, readiness requirement, metric, source, competitor, or portfolio invention
- any current open readiness gate is not mapped to at least one build program
- any capability axis is not covered
- any competitor row is not addressed
- the synthetic frontier score does not improve all tracked metrics

This is still a simulated product-planning smoke test, not a real benchmark. Public benchmark and external adoption claims remain blocked until external evidence exists.
