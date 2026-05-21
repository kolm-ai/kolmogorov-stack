# Kolm Cloud Product Readiness

This is the production contract for teams that do not have local GPUs or need
enterprise deployment controls. The product stays artifact-first: cloud compute
is a pluggable compile/train/serve substrate, while `.kolm` remains the signed
portable output.

## Required Launch Paths

| Path | Required Env | Purpose |
| --- | --- | --- |
| Cloudflare R2 artifact store | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `R2_BUCKET` | Durable `.kolm`, receipts, eval sets, and export bundles. |
| S3-compatible artifact store | `KOLM_S3_ENDPOINT`, `KOLM_S3_BUCKET`, `KOLM_S3_ACCESS_KEY_ID`, `KOLM_S3_SECRET_ACCESS_KEY` | Cloudflare S3 API, MinIO, AWS-compatible enterprise storage. |
| Supabase storage | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET` | Team file/export storage where Supabase is the app substrate. |
| Hosted GPU compile | `KOLM_MODAL_TOKEN`, `KOLM_RUNPOD_TOKEN`, `KOLM_LAMBDA_TOKEN`, or `KOLM_TOGETHER_TOKEN` | Train/distill when the buyer does not own a GPU. |
| Provider teachers | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENROUTER_API_KEY` | Teacher/evaluator calls for distillation and bakeoffs. |
| OTEL production monitoring | `KOLM_OTEL=1`, `OTEL_EXPORTER_OTLP_ENDPOINT` | Traces/metrics into Datadog, Honeycomb, Grafana, Tempo, or a collector. |

Run:

```bash
npm run verify:platform
kolm cloud readiness --json
kolm cloud readiness --remote --json
```

`--remote` checks the deployed Kolm process instead of the local shell. Use it
for Railway/Vercel/container variables because local PowerShell cannot see
hosting-provider secrets after deploy.

The readiness output includes deployment profiles, not just env buckets:

- `local-private` - local compile/verify/run with no cloud dependency.
- `hosted-gpu-train` - any artifact storage plus hosted, managed, or remote SSH compute.
- `r2-managed-edge` - R2-compatible storage plus managed/rented/SSH compute.
- `aws-enterprise-byoc` - AWS S3/KMS-friendly BYOC and audit workflows.
- `supabase-product-app` - Supabase-backed app/product storage.
- `s3-self-hosted-ssh` - generic S3-compatible storage plus remote SSH GPU.
- `airgapped-enterprise` - offline artifact, receipt, and compliance-bundle movement.

## Model And Runtime Coverage

`src/platform-capabilities.js` is the source of truth for product coverage.
It tracks four separate matrices:

- Model/framework targets: OpenAI-compatible APIs, Anthropic Messages,
  Gemini/OpenAI shim, GGUF/llama.cpp, Safetensors/PEFT, ONNX Runtime, CoreML,
  MLX, ExecuTorch, LiteRT, WASM/WebGPU, vLLM, SGLang, TGI, TensorRT-LLM,
  OpenVINO, and Qualcomm QNN/Hexagon.
- Model-family targets: frontier teachers, dense and MoE open weights, small
  language models, VLMs, embeddings/rerankers, speech/audio, image redaction,
  PDF/document, tabular/time-series, code, agent-tool policy, RAG pipelines,
  safety guardrails, and workflow IR.
- Device targets: CPU laptops, CUDA, ROCm, Apple Silicon, Windows DirectML,
  Intel NPU/OpenVINO, Qualcomm QNN, iOS/CoreML/ANE, Android/LiteRT/QNN,
  browser WASM/WebGPU, Jetson/TensorRT, Cloudflare Workers, Vercel Edge,
  AWS Lambda, Kubernetes GPU, remote SSH GPU, and air-gapped servers.
- Methods: capture proxy, zero retention, PII/PHI redaction, DP stats,
  dataset split/holdout, K-score eval gates, teacher/student distillation,
  on-policy and preference optimization, speculative decoding, LoRA/QLoRA,
  synthetic seeds, multimodal tokenization, RAG/recall, MoE composition,
  artifact signing, offline verification, MCP export, provider fallbacks,
  SSE streaming, quantization, hosted GPU rental, OTEL export, and codegraph
  impact audit.

## Hard Boundaries

Do not market a path as production-ready unless the readiness command reports
the relevant provider configured and the matching surface tests pass. External
certifications, public package releases, hardware partner support, and public
benchmarks remain external proof items even when the local code is wired.
