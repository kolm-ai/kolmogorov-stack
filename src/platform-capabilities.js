import { objectStorageReadiness } from './object-storage.js';

// Product capability matrix for launch-readiness checks.
//
// This module is intentionally pure: no network calls, no secrets printed, no
// SDK-specific dependencies. It answers two production questions:
//   1. Which model/framework/runtime surfaces does this checkout explicitly
//      know how to target or wrap?
//   2. Which cloud, enterprise, observability, and scale controls are wired by
//      configuration in the current environment?

export const MODEL_FRAMEWORK_TARGETS = Object.freeze([
  {
    id: 'openai-compatible',
    family: 'gateway-api',
    model_types: ['chat', 'responses', 'embeddings', 'tool-calling'],
    runtime_formats: ['json-http'],
    env: ['OPENAI_API_KEY', 'KOLM_OPENAI_BASE_URL'],
    evidence: ['src/completions-api.js', 'src/daemon-connector.js', 'src/router.js'],
    status: 'implemented',
  },
  {
    id: 'anthropic-messages',
    family: 'gateway-api',
    model_types: ['chat', 'vision', 'tool-use', 'teacher-eval'],
    runtime_formats: ['messages-http'],
    env: ['ANTHROPIC_API_KEY'],
    evidence: ['src/compute/backends/anthropic.js', 'src/daemon-connector.js', 'src/router.js'],
    status: 'implemented',
  },
  {
    id: 'gemini-openai-shim',
    family: 'gateway-api',
    model_types: ['chat', 'multimodal'],
    runtime_formats: ['openai-compatible-http'],
    env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    evidence: ['src/provider-registry.js', 'src/daemon-connector.js', 'src/completions-api.js'],
    status: 'implemented',
  },
  {
    id: 'openrouter-gateway',
    family: 'gateway-api',
    model_types: ['chat', 'multimodal', 'tool-calling', 'teacher-eval'],
    runtime_formats: ['openai-compatible-http'],
    env: ['OPENROUTER_API_KEY'],
    evidence: ['src/provider-registry.js', 'src/daemon-connector.js', 'src/completions-api.js'],
    status: 'implemented',
  },
  {
    id: 'gguf-llama-cpp',
    family: 'local-runtime',
    model_types: ['dense-llm', 'moe-llm', 'embedding'],
    runtime_formats: ['gguf'],
    env: ['KOLM_LLAMA_CPP_URL', 'OLLAMA_HOST'],
    evidence: ['src/model-weights-manifest.js', 'src/compute/registry.json', 'docs/kolm-format-v1.md'],
    status: 'manifest-supported',
  },
  {
    id: 'safetensors-peft',
    family: 'training-format',
    model_types: ['lora-adapter', 'qlora-adapter', 'embedding', 'dense-llm'],
    runtime_formats: ['safetensors', 'peft-lora'],
    env: ['KOLM_TRAIN_BACKEND'],
    evidence: ['src/distill-pipeline.js', 'src/export-provenance.js', 'src/remote-compute.js'],
    status: 'implemented',
  },
  {
    id: 'onnx-runtime',
    family: 'portable-runtime',
    model_types: ['classifier', 'extractor', 'embedding', 'vision', 'audio'],
    runtime_formats: ['onnx'],
    env: ['KOLM_ONNX_RUNTIME_URL'],
    evidence: ['docs/kolm-format-v1.md', 'src/export-provenance.js', 'services/embed/multimodal.js'],
    status: 'manifest-supported',
  },
  {
    id: 'coreml-ane',
    family: 'edge-runtime',
    model_types: ['classifier', 'extractor', 'vision', 'small-llm'],
    runtime_formats: ['mlpackage', 'coreml'],
    env: ['KOLM_COREML_TARGET'],
    evidence: ['src/compute/registry.json', 'src/device-capabilities.js', 'docs/product-surfaces.json'],
    status: 'target-declared',
  },
  {
    id: 'mlx-apple-silicon',
    family: 'local-runtime',
    model_types: ['dense-llm', 'lora-adapter', 'embedding'],
    runtime_formats: ['mlx', 'safetensors'],
    env: ['KOLM_MLX_URL'],
    evidence: ['src/compute/registry.json', 'src/device-capabilities.js'],
    status: 'implemented',
  },
  {
    id: 'executorch',
    family: 'edge-runtime',
    model_types: ['mobile-llm', 'classifier', 'vision'],
    runtime_formats: ['pte'],
    env: ['KOLM_EXECUTORCH_TARGET'],
    evidence: ['docs/kolm-format-v1.md', 'docs/product-surfaces.json'],
    status: 'target-declared',
  },
  {
    id: 'litert-android',
    family: 'edge-runtime',
    model_types: ['mobile-llm', 'vision', 'audio', 'classifier'],
    runtime_formats: ['tflite', 'litert'],
    env: ['KOLM_LITERT_TARGET'],
    evidence: ['docs/kolm-format-v1.md', 'docs/product-surfaces.json'],
    status: 'target-declared',
  },
  {
    id: 'wasm-webgpu',
    family: 'browser-runtime',
    model_types: ['recipe', 'classifier', 'small-llm', 'embedding'],
    runtime_formats: ['wasm', 'webgpu'],
    env: [],
    evidence: ['public/sdk.js', 'public/device/webgpu-runner.js', 'public/device/webgpu-runner.html', 'server.js', 'docs/kolm-format-v1.md'],
    // Honest status: the WASM wrapper SDK ships, and a minimal transformers.js
    // on-device runner (CDN ESM, WebGPU backend with WASM fallback) now exists
    // at public/device/webgpu-runner.{js,html}. It is a tiny-model demo path,
    // not a full Kolm-artifact WebGPU inference engine, so this is not yet a
    // production 'implemented' runtime for arbitrary recipes.
    status: 'in_progress',
    note: 'Minimal transformers.js WebGPU/WASM token-generation runner shipped (public/device/webgpu-runner.js); full Kolm-artifact in-browser inference is not yet implemented.',
  },
  {
    id: 'vllm',
    family: 'serving-engine',
    model_types: ['dense-llm', 'moe-llm', 'embedding'],
    runtime_formats: ['openai-compatible-http'],
    env: ['KOLM_VLLM_URL'],
    evidence: ['src/compute/registry.json', 'src/compute/index.js'],
    status: 'implemented',
  },
  {
    id: 'sglang',
    family: 'serving-engine',
    model_types: ['dense-llm', 'moe-llm', 'structured-output'],
    runtime_formats: ['openai-compatible-http'],
    env: ['KOLM_SGLANG_URL'],
    evidence: ['src/compute/registry.json', 'src/compute/index.js'],
    status: 'implemented',
  },
  {
    id: 'tgi',
    family: 'serving-engine',
    model_types: ['dense-llm', 'moe-llm'],
    runtime_formats: ['openai-compatible-http'],
    env: ['KOLM_TGI_URL'],
    evidence: ['src/compute/registry.json', 'src/compute/index.js'],
    status: 'implemented',
  },
  {
    id: 'tensorrt-llm',
    family: 'serving-engine',
    model_types: ['dense-llm', 'moe-llm', 'fp8'],
    runtime_formats: ['triton-http', 'openai-compatible-http'],
    env: ['KOLM_TRT_LLM_URL'],
    evidence: ['src/compute/registry.json', 'src/compute/index.js'],
    status: 'implemented',
  },
  {
    id: 'openvino',
    family: 'edge-runtime',
    model_types: ['classifier', 'extractor', 'embedding', 'small-llm'],
    runtime_formats: ['openvino-ir', 'openai-compatible-http'],
    env: ['KOLM_OPENVINO_URL', 'OPENVINO_HOME'],
    evidence: ['src/compute/backends/local-openvino.js', 'src/compute/registry.json'],
    status: 'implemented',
  },
  {
    id: 'qnn-hexagon',
    family: 'edge-runtime',
    model_types: ['classifier', 'extractor', 'vision', 'small-llm'],
    runtime_formats: ['qnn', 'openai-compatible-http'],
    env: ['KOLM_QNN_URL', 'QNN_SDK_ROOT'],
    evidence: ['src/compute/backends/local-qnn.js', 'src/compute/registry.json'],
    status: 'implemented',
  },
]);

export const MODEL_FAMILY_TARGETS = Object.freeze([
  { id: 'frontier-teacher-gpt', class: 'teacher', modalities: ['text', 'vision', 'tool-calling'], evidence: ['src/completions-api.js'], status: 'implemented' },
  { id: 'frontier-teacher-claude', class: 'teacher', modalities: ['text', 'vision', 'tool-use'], evidence: ['src/compute/backends/anthropic.js'], status: 'implemented' },
  { id: 'frontier-teacher-gemini', class: 'teacher', modalities: ['text', 'vision', 'audio'], evidence: ['src/provider-registry.js', 'src/completions-api.js'], status: 'implemented' },
  { id: 'open-weight-dense-llm', class: 'student', modalities: ['text', 'code'], evidence: ['src/model-registry.js', 'src/model-weights-manifest.js'], status: 'implemented' },
  { id: 'open-weight-moe-llm', class: 'student', modalities: ['text', 'code'], evidence: ['src/model-registry.js', 'src/moe.js'], status: 'implemented' },
  { id: 'small-language-model', class: 'student', modalities: ['text'], evidence: ['src/model-registry.js', 'src/distill-pipeline.js'], status: 'implemented' },
  { id: 'vision-language-model', class: 'student', modalities: ['text', 'vision'], evidence: ['src/model-registry.js', 'services/embed/multimodal.js'], status: 'implemented' },
  { id: 'embedding-model', class: 'retrieval', modalities: ['text', 'code'], evidence: ['src/embedding.js', 'src/rag.js'], status: 'implemented' },
  { id: 'reranker-model', class: 'retrieval', modalities: ['text'], evidence: ['src/rag.js', 'docs/RAG.md'], status: 'target-declared' },
  { id: 'speech-asr-model', class: 'media', modalities: ['audio'], evidence: ['services/embed/multimodal.js', 'cli/kolm.js'], status: 'dependency-gated' },
  { id: 'audio-voiceprint-model', class: 'media', modalities: ['audio'], evidence: ['cli/kolm.js', 'public/account/multimodal-bakeoff.html'], status: 'dependency-gated' },
  { id: 'image-redaction-model', class: 'media', modalities: ['image'], evidence: ['cli/kolm.js', 'services/embed/multimodal.js'], status: 'dependency-gated' },
  { id: 'pdf-document-model', class: 'document', modalities: ['pdf', 'text'], evidence: ['services/embed/multimodal.js', 'src/extract.js'], status: 'implemented' },
  { id: 'tabular-classifier', class: 'structured', modalities: ['json', 'csv'], evidence: ['src/dsl.js', 'src/extract.js'], status: 'implemented' },
  { id: 'time-series-detector', class: 'structured', modalities: ['numeric'], evidence: ['src/benchmarks.js', 'docs/product-sota-readiness.json'], status: 'target-declared' },
  { id: 'code-specialist', class: 'developer', modalities: ['code', 'text'], evidence: ['src/model-registry.js', 'docs/product-sota-readiness.json'], status: 'implemented' },
  { id: 'agent-tool-policy-model', class: 'agent', modalities: ['tool-calling', 'json'], evidence: ['services/mcp/server.js', 'cli/kolm.js'], status: 'implemented' },
  { id: 'rag-pipeline-artifact', class: 'retrieval-pipeline', modalities: ['text', 'code', 'pdf', 'image', 'audio', 'video'], evidence: ['src/rag.js', 'src/recall.js', 'services/embed/multimodal.js'], status: 'implemented' },
  { id: 'safety-guardrail-model', class: 'policy', modalities: ['text', 'json'], evidence: ['src/privacy-membrane.js', 'src/runtime-policy.js'], status: 'implemented' },
  { id: 'workflow-ir-model', class: 'workflow', modalities: ['json', 'tool-calling'], evidence: ['src/workflow-ir.js', 'src/simulation.js'], status: 'implemented' },
]);

export const DEVICE_TARGETS = Object.freeze([
  { id: 'cpu-only-laptop', class: 'local', runtimes: ['node', 'wasm', 'llama.cpp'], evidence: ['src/compute/registry.json', 'src/device-capabilities.js'], status: 'implemented' },
  { id: 'nvidia-cuda-workstation', class: 'local-gpu', runtimes: ['torch-cu12', 'unsloth', 'vllm', 'tensorrt-llm'], evidence: ['src/compute/registry.json', 'src/remote-compute.js'], status: 'implemented' },
  { id: 'amd-rocm-workstation', class: 'local-gpu', runtimes: ['torch-rocm6'], evidence: ['src/compute/registry.json'], status: 'implemented' },
  { id: 'apple-silicon-mac', class: 'local-npu', runtimes: ['mps', 'mlx', 'coreml'], evidence: ['src/compute/registry.json', 'src/device-capabilities.js'], status: 'implemented' },
  { id: 'windows-directml', class: 'local-gpu', runtimes: ['directml', 'openvino'], evidence: ['src/compute/registry.json'], status: 'implemented' },
  { id: 'intel-npu-openvino', class: 'edge-npu', runtimes: ['openvino'], evidence: ['src/compute/backends/local-openvino.js'], status: 'implemented' },
  { id: 'qualcomm-hexagon-qnn', class: 'edge-npu', runtimes: ['qnn'], evidence: ['src/compute/backends/local-qnn.js'], status: 'implemented' },
  { id: 'ios-coreml-ane', class: 'mobile', runtimes: ['coreml', 'ane'], evidence: ['docs/kolm-format-v1.md', 'docs/product-surfaces.json'], status: 'target-declared' },
  { id: 'android-litert-qnn', class: 'mobile', runtimes: ['litert', 'qnn'], evidence: ['docs/kolm-format-v1.md', 'docs/product-surfaces.json'], status: 'target-declared' },
  { id: 'browser-wasm', class: 'browser', runtimes: ['wasm'], evidence: ['public/sdk.js', 'server.js'], status: 'implemented' },
  { id: 'browser-webgpu', class: 'browser', runtimes: ['webgpu', 'wasm'], evidence: ['public/sdk.js', 'docs/product-surfaces.json'], status: 'target-declared' },
  { id: 'jetson-edge', class: 'edge-gpu', runtimes: ['tensorrt-llm', 'triton'], evidence: ['src/compute/registry.json', 'public/compute.html'], status: 'target-declared' },
  { id: 'cloudflare-workers', class: 'edge-cloud', runtimes: ['workers', 'wasm'], evidence: ['docs/cloud-product-readiness.md', 'docs/kolm-format-v1.md'], status: 'target-declared' },
  { id: 'vercel-edge', class: 'edge-cloud', runtimes: ['edge-runtime', 'wasm'], evidence: ['vercel.json', 'docs/cloud-product-readiness.md'], status: 'target-declared' },
  { id: 'aws-lambda', class: 'cloud', runtimes: ['node', 'container'], evidence: ['server.js', 'docs/cloud-product-readiness.md'], status: 'implemented' },
  { id: 'kubernetes-gpu', class: 'cloud-gpu', runtimes: ['vllm', 'sglang', 'tgi', 'triton'], evidence: ['src/compute/registry.json', 'src/remote-compute.js'], status: 'implemented' },
  { id: 'remote-ssh-gpu', class: 'self-hosted-gpu', runtimes: ['ssh', 'docker'], evidence: ['src/remote-compute.js', 'src/compute/registry.json'], status: 'implemented' },
  { id: 'airgapped-server', class: 'enterprise', runtimes: ['docker', 'offline-cli'], evidence: ['public/airgap.html', 'docs/kolm-format-v1.md'], status: 'implemented' },
]);

export const METHOD_TARGETS = Object.freeze([
  { id: 'capture-proxy', category: 'data-capture', evidence: ['src/daemon-connector.js', 'src/router.js'], status: 'implemented' },
  { id: 'zero-retention-capture', category: 'privacy', evidence: ['src/daemon-connector.js', 'src/router.js'], status: 'implemented' },
  { id: 'pii-phi-redaction', category: 'privacy', evidence: ['src/privacy-membrane.js', 'src/phi-redactor.js'], status: 'implemented' },
  { id: 'differential-privacy-stats', category: 'privacy', evidence: ['src/privacy-membrane.js', 'src/lake.js'], status: 'implemented' },
  { id: 'dataset-split-holdout', category: 'eval', evidence: ['src/dataset-workbench.js', 'tests/wave411-p0-train-holdout-and-metadata.test.js'], status: 'implemented' },
  { id: 'eval-gates-k-score', category: 'eval', evidence: ['src/kscore.js', 'src/production-ready.js'], status: 'implemented' },
  { id: 'teacher-student-distill', category: 'distill', evidence: ['src/distill-pipeline.js', 'src/distill-provenance.js'], status: 'implemented' },
  { id: 'distill-strategy-oracle', category: 'distill', evidence: ['src/distill-strategy.js', 'scripts/distill-strategy.mjs', 'docs/distill-strategy.md'], status: 'implemented' },
  { id: 'onpolicy-distill', category: 'distill', evidence: ['src/distill-onpolicy.js', 'cli/kolm.js'], status: 'implemented' },
  { id: 'preference-optimization', category: 'distill', evidence: ['src/distill-preference.js', 'cli/kolm.js'], status: 'implemented' },
  { id: 'speculative-decoding-train', category: 'distill', evidence: ['src/spec-decode.js', 'cli/kolm.js'], status: 'implemented' },
  { id: 'lora-qlora-train', category: 'train', evidence: ['src/remote-compute.js', 'src/distill-pipeline.js'], status: 'implemented' },
  { id: 'synthetic-seed-generation', category: 'data-generation', evidence: ['src/router.js', 'src/synthesis.js'], status: 'implemented' },
  { id: 'multimodal-tokenization', category: 'data-prep', evidence: ['services/embed/multimodal.js', 'tests/wave552-gemma-multimodal-account.test.js'], status: 'implemented' },
  { id: 'rag-index-recall', category: 'retrieval', evidence: ['src/rag.js', 'src/recall.js'], status: 'implemented' },
  { id: 'moe-composition', category: 'composition', evidence: ['src/moe.js', 'tests/wave144-moe-compose.test.js'], status: 'implemented' },
  { id: 'artifact-signing', category: 'artifact', evidence: ['src/artifact.js', 'src/ed25519.js'], status: 'implemented' },
  { id: 'offline-verification', category: 'artifact', evidence: ['src/artifact-runner.js', 'cli/kolm.js'], status: 'implemented' },
  { id: 'mcp-tool-export', category: 'agent', evidence: ['services/mcp/server.js', 'cli/kolm.js'], status: 'implemented' },
  { id: 'provider-fallback-chain', category: 'runtime', evidence: ['src/completions-api.js'], status: 'implemented' },
  { id: 'streaming-sse', category: 'runtime', evidence: ['src/completions-api.js', 'tests/wave144-completions-server.test.js'], status: 'implemented' },
  { id: 'quantize-awq-gptq-gguf-mlx', category: 'compression', evidence: ['workers/quantize/README.md', 'cli/kolm.js'], status: 'implemented' },
  { id: 'cloud-gpu-rental-plan', category: 'compute', evidence: ['src/remote-compute.js', 'docs/cloud-product-readiness.md'], status: 'implemented' },
  { id: 'cloud-compute-broker', category: 'compute', evidence: ['src/cloud-compute-broker.js', 'scripts/cloud-compute-broker.mjs', 'docs/cloud-compute-broker.md'], status: 'implemented' },
  { id: 'otel-export', category: 'observability', evidence: ['src/otel.js', 'server.js'], status: 'implemented' },
  { id: 'codegraph-impact-audit', category: 'developer-ops', evidence: ['src/repo-codegraph.js', 'scripts/build-codegraph.mjs'], status: 'implemented' },
]);

export const ENTERPRISE_CONTROLS = Object.freeze([
  { id: 'tenant-isolation', env: [], evidence: ['src/auth.js', 'src/router.js'], status: 'implemented' },
  { id: 'scoped-api-keys', env: ['KOLM_API_KEY'], evidence: ['src/auth.js', 'src/keys.js'], status: 'implemented' },
  { id: 'zero-retention', env: [], evidence: ['src/router.js', 'src/daemon-connector.js'], status: 'implemented' },
  { id: 'differential-privacy', env: [], evidence: ['src/privacy-membrane.js', 'src/lake.js'], status: 'implemented' },
  { id: 'audit-log-export', env: [], evidence: ['src/audit.js', 'public/account/audit-log.html'], status: 'implemented' },
  { id: 'rbac-team-workspaces', env: [], evidence: ['src/auth.js', 'src/router.js', 'public/teams.html'], status: 'implemented' },
  { id: 'saml-sso', env: ['KOLM_SAML_METADATA_URL', 'WORKOS_API_KEY', 'AUTH0_DOMAIN'], evidence: ['docs/product-sota-readiness.json'], status: 'integration-ready' },
  { id: 'scim-provisioning', env: ['KOLM_SCIM_TOKEN', 'WORKOS_API_KEY'], evidence: ['docs/product-sota-readiness.json'], status: 'integration-ready' },
  { id: 'customer-managed-keys', env: ['KOLM_KMS_KEY_ID', 'AWS_KMS_KEY_ID'], evidence: ['docs/product-sota-readiness.json'], status: 'config-ready' },
  { id: 'baa-compliance-pack', env: [], evidence: ['public/baa.html', 'public/compliance-packs.html'], status: 'claim-gated' },
]);

export const OBSERVABILITY_CONTROLS = Object.freeze([
  { id: 'otlp-http-export', env: ['KOLM_OTEL', 'OTEL_EXPORTER_OTLP_ENDPOINT'], evidence: ['src/otel.js', 'server.js'], status: 'implemented' },
  { id: 'capture-lake-stats', env: [], evidence: ['src/lake.js', 'src/router.js'], status: 'implemented' },
  { id: 'mcp-run-log', env: [], evidence: ['services/mcp/server.js'], status: 'implemented' },
  { id: 'receipt-verification', env: [], evidence: ['src/artifact-runner.js', 'cli/kolm.js'], status: 'implemented' },
  { id: 'fallback-path-metadata', env: [], evidence: ['src/completions-api.js'], status: 'implemented' },
  { id: 'siem-export', env: ['KOLM_SIEM_WEBHOOK_URL', 'SPLUNK_HEC_URL', 'DATADOG_API_KEY'], evidence: ['src/otel.js', 'docs/product-sota-readiness.json'], status: 'config-ready' },
]);

export const SCALE_CONTROLS = Object.freeze([
  { id: 'response-compression', env: [], evidence: ['server.js'], status: 'implemented' },
  { id: 'provider-fallbacks', env: [], evidence: ['src/completions-api.js'], status: 'implemented' },
  { id: 'compile-cache-keys', env: [], evidence: ['src/cache.js', 'src/runtime.js'], status: 'partial' },
  { id: 'r2-artifact-storage', env: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'R2_BUCKET'], evidence: ['src/r2.js', 'src/object-storage.js'], status: 'implemented' },
  { id: 's3-compatible-storage', env: ['KOLM_S3_ENDPOINT', 'KOLM_S3_BUCKET', 'KOLM_S3_ACCESS_KEY_ID', 'KOLM_S3_SECRET_ACCESS_KEY'], evidence: ['src/object-storage.js'], status: 'implemented' },
  { id: 'aws-s3-artifact-storage', env: ['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'KOLM_S3_BUCKET'], evidence: ['src/object-storage.js'], status: 'implemented' },
  { id: 'supabase-artifact-storage', env: ['SUPABASE_URL', 'SUPABASE_STORAGE_BUCKET'], evidence: ['src/object-storage.js'], status: 'implemented' },
  { id: 'hosted-gpu-train', env: ['KOLM_MODAL_TOKEN', 'KOLM_RUNPOD_TOKEN', 'KOLM_LAMBDA_TOKEN', 'KOLM_TOGETHER_TOKEN'], evidence: ['src/remote-compute.js', 'src/compute/registry.json'], status: 'implemented' },
  { id: 'self-hosted-gpu-ssh', env: ['KOLM_REMOTE_HOST', 'KOLM_REMOTE_USER'], evidence: ['src/remote-compute.js', 'src/compute/registry.json'], status: 'implemented' },
  { id: 'strict-readiness-gate', env: ['KOLM_REQUIRE_PRODUCTION_READY'], evidence: ['src/production-ready.js', 'server.js'], status: 'implemented' },
]);

const CLOUD_GROUPS = Object.freeze([
  {
    id: 'cloudflare-r2',
    label: 'Cloudflare R2 artifact storage',
    category: 'artifact-storage',
    required_any_sets: [
      ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'],
      ['cloudflare_account_id', 'Cloudflare_api_token'],
      ['CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'],
      ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_R2_ACCESS_KEY_ID', 'CLOUDFLARE_R2_SECRET_ACCESS_KEY'],
    ],
    optional: ['R2_BUCKET', 'R2_PUBLIC_BASE'],
    docs_url: 'https://developers.cloudflare.com/r2/api/s3/api/',
    setup_hint: 'Use the R2 S3-compatible endpoint for artifact bundles, receipts, eval splits, and export bundles.',
    caveats: ['R2 S3 compatibility is broad but not byte-for-byte identical to AWS S3; keep bucket region set to auto/us-east-1-compatible where clients require a region.'],
  },
  {
    id: 's3-compatible',
    label: 'Generic S3-compatible artifact storage',
    category: 'artifact-storage',
    required_any_sets: [
      ['KOLM_S3_ENDPOINT', 'KOLM_S3_BUCKET', 'KOLM_S3_ACCESS_KEY_ID', 'KOLM_S3_SECRET_ACCESS_KEY'],
      ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'],
    ],
    optional: ['KOLM_S3_REGION', 'KOLM_S3_FORCE_PATH_STYLE'],
    docs_url: 'https://docs.aws.amazon.com/AmazonS3/latest/API/Type_API_Reference.html',
    setup_hint: 'Use for MinIO, enterprise S3 gateways, R2 S3 endpoints, and other S3-compatible object stores.',
    caveats: ['Provider feature gaps vary; verify presigned URL, multipart, checksum, and lifecycle support before using it as an enterprise artifact source of truth.'],
  },
  {
    id: 'aws-s3',
    label: 'AWS S3 artifact storage',
    category: 'artifact-storage',
    required: ['AWS_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'KOLM_S3_BUCKET'],
    optional: ['AWS_KMS_KEY_ID'],
    docs_url: 'https://docs.aws.amazon.com/s3/',
    setup_hint: 'Use for AWS-native artifact storage, KMS wrapping, audit exports, and BYOC deployments.',
    caveats: ['For AWS S3, prefer virtual-hosted-style URLs and region-derived endpoints instead of force-path-style S3 settings.'],
  },
  {
    id: 'supabase-storage',
    label: 'Supabase Storage',
    category: 'artifact-storage',
    required_any_sets: [
      ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_STORAGE_BUCKET'],
      ['SUPABASE_URL', 'SUPABASE_STORAGE_BUCKET', 'SUPABASE_S3_ACCESS_KEY_ID', 'SUPABASE_S3_SECRET_ACCESS_KEY'],
      ['SUPABASE_URL', 'SUPABASE_STORAGE_BUCKET', 'S3_PROTOCOL_ACCESS_KEY_ID', 'S3_PROTOCOL_ACCESS_KEY_SECRET'],
    ],
    optional: ['SUPABASE_ANON_KEY', 'SUPABASE_S3_ENDPOINT'],
    docs_url: 'https://supabase.com/docs/guides/storage/s3/compatibility',
    setup_hint: 'Use when Supabase is the app substrate and Kolm artifacts/exports should live beside tenant data.',
    caveats: ['Supabase Storage exposes S3-compatible APIs for common object flows, but S3 bucket versioning is not supported; keep artifact versioning in Kolm manifests.'],
  },
  {
    id: 'modal-gpu',
    label: 'Modal GPU',
    category: 'hosted-gpu',
    required_any_sets: [['KOLM_MODAL_TOKEN'], ['MODAL_TOKEN_ID', 'MODAL_TOKEN_SECRET']],
    optional: ['KOLM_MODAL_APP'],
    docs_url: 'https://modal.com/docs',
    setup_hint: 'Use for managed GPU jobs when buyers do not own local accelerators.',
    caveats: ['Treat as rented compute; keep datasets, receipts, and artifacts in the configured storage plane.'],
  },
  { id: 'runpod-gpu', label: 'RunPod GPU', category: 'hosted-gpu', required: ['KOLM_RUNPOD_TOKEN'], optional: ['RUNPOD_ENDPOINT_ID'], docs_url: 'https://docs.runpod.io/', setup_hint: 'Use for rented GPU train/distill jobs with explicit cost quotes.', caveats: ['Verify data residency and GPU image availability per endpoint before regulated runs.'] },
  { id: 'lambda-gpu', label: 'Lambda GPU', category: 'hosted-gpu', required: ['KOLM_LAMBDA_TOKEN'], optional: ['LAMBDA_REGION'], docs_url: 'https://docs.lambda.ai/', setup_hint: 'Use for cloud GPU jobs where Lambda is the approved vendor.', caveats: ['Use region pinning and storage-side artifact receipts for reproducibility.'] },
  { id: 'vast-gpu', label: 'Vast GPU', category: 'hosted-gpu', required: ['KOLM_VAST_TOKEN'], optional: ['KOLM_REMOTE_SSH_KEY'], docs_url: 'https://docs.vast.ai/', setup_hint: 'Use for low-cost rented GPU experiments and non-regulated training.', caveats: ['Treat marketplace instances as lower-trust unless paired with attestation and encrypted storage.'] },
  { id: 'remote-ssh-gpu', label: 'Remote SSH GPU', category: 'self-hosted-compute', required: ['KOLM_REMOTE_HOST', 'KOLM_REMOTE_USER'], optional: ['KOLM_REMOTE_SSH_KEY', 'KOLM_REMOTE_PORT'], docs_url: 'https://www.openssh.com/manual.html', setup_hint: 'Use any workstation, lab server, or rented VM reachable by SSH as the training/distill target.', caveats: ['The user controls patching, CUDA/ROCm drivers, firewalling, and filesystem cleanup on the SSH host.'] },
  { id: 'together-managed-train', label: 'Together managed training', category: 'managed-train', required_any_sets: [['KOLM_TOGETHER_TOKEN'], ['TOGETHER_API_KEY']], optional: [], docs_url: 'https://docs.together.ai/', setup_hint: 'Use for managed fine-tuning or teacher/student workflows where Together is approved.', caveats: ['Provider-side model availability and job limits can change; keep compile receipts in Kolm.'] },
  { id: 'anthropic-teacher', label: 'Claude teacher/evaluator', category: 'teacher-provider', required: ['ANTHROPIC_API_KEY'], optional: ['ANTHROPIC_MODEL'], docs_url: 'https://docs.anthropic.com/en/api/overview', setup_hint: 'Use Claude as a teacher, judge, or fallback provider without forcing OpenAI-only flows.', caveats: ['Model/version pinning matters for reproducible evals.'] },
  { id: 'openai-teacher', label: 'OpenAI teacher/evaluator', category: 'teacher-provider', required: ['OPENAI_API_KEY'], optional: ['OPENAI_MODEL'], docs_url: 'https://platform.openai.com/docs', setup_hint: 'Use OpenAI as a teacher, judge, capture source, or OpenAI-compatible client target.', caveats: ['Record model ids and response hashes in receipts before promoting eval claims.'] },
  { id: 'openrouter-teacher', label: 'OpenRouter teacher/evaluator', category: 'teacher-provider', required: ['OPENROUTER_API_KEY'], optional: [], docs_url: 'https://openrouter.ai/docs', setup_hint: 'Use OpenRouter for provider breadth while preserving Kolm capture, cost, and fallback metadata.', caveats: ['Downstream provider behavior can vary; use K-score gates before promotion.'] },
  { id: 'otel-collector', label: 'OpenTelemetry collector', category: 'observability', required: ['KOLM_OTEL', 'OTEL_EXPORTER_OTLP_ENDPOINT'], optional: ['OTEL_EXPORTER_OTLP_HEADERS'], docs_url: 'https://opentelemetry.io/docs/', setup_hint: 'Send gateway/runtime spans and metrics to the customer monitoring stack.', caveats: ['Do not put secrets in OTEL attributes or headers shown in account UI.'] },
  { id: 'enterprise-sso', label: 'Enterprise SSO/SCIM', category: 'enterprise-identity', required_any_sets: [['KOLM_SAML_METADATA_URL'], ['WORKOS_API_KEY'], ['AUTH0_DOMAIN']], optional: ['KOLM_SCIM_TOKEN'], docs_url: 'https://workos.com/docs', setup_hint: 'Use for enterprise identity readiness, SAML/SCIM onboarding, and admin-controlled workspaces.', caveats: ['Live SSO/SCIM still requires customer IdP metadata exchange and tenant-specific validation.'] },
]);

const STORAGE_PROVIDER_IDS = Object.freeze(['cloudflare-r2', 's3-compatible', 'aws-s3', 'supabase-storage']);
const COMPUTE_PROVIDER_IDS = Object.freeze(['modal-gpu', 'runpod-gpu', 'lambda-gpu', 'vast-gpu', 'remote-ssh-gpu', 'together-managed-train']);
const TEACHER_PROVIDER_IDS = Object.freeze(['anthropic-teacher', 'openai-teacher', 'openrouter-teacher']);

export const DEPLOYMENT_PROFILES = Object.freeze([
  {
    id: 'local-private',
    label: 'Local private',
    summary: 'Run capture, compile, verify, and inference on the user machine with zero cloud dependency.',
    best_for: ['individual developers', 'air-gapped demos', 'regulated local-first evaluation'],
    required_any_provider_ids: [],
    optional_provider_ids: ['otel-collector'],
    account: ['/account/overview', '/account/storage', '/account/devices'],
    cli: ['kolm bootstrap', 'kolm compile --spec spec.json', 'kolm verify artifact.kolm', 'kolm run artifact.kolm "input"'],
    proof: ['artifact signature', 'local storage truth', 'holdout receipts'],
  },
  {
    id: 'hosted-gpu-train',
    label: 'Hosted GPU training',
    summary: 'Train or distill without owning a GPU, then persist signed artifacts and receipts in configured storage.',
    best_for: ['teams without accelerators', 'larger distillation jobs', 'frontier-teacher bakeoffs'],
    required_any_provider_ids: [STORAGE_PROVIDER_IDS, COMPUTE_PROVIDER_IDS],
    optional_provider_ids: TEACHER_PROVIDER_IDS,
    account: ['/account/storage', '/account/builds', '/account/artifacts'],
    cli: ['kolm cloud readiness --json', 'kolm cloud train <name> --seeds examples.jsonl', 'kolm remote recommend training'],
    proof: ['cost quote', 'K-score gate', 'artifact storage receipt'],
  },
  {
    id: 'r2-managed-edge',
    label: 'R2-backed cloud',
    summary: 'Use R2-compatible object storage with managed or rented compute and keep artifacts portable.',
    best_for: ['multi-cloud teams', 'low-egress artifact distribution', 'Cloudflare-heavy stacks'],
    required_any_provider_ids: [['cloudflare-r2'], COMPUTE_PROVIDER_IDS],
    optional_provider_ids: ['otel-collector', ...TEACHER_PROVIDER_IDS],
    account: ['/account/storage', '/byoc', '/compute'],
    cli: ['kolm cloud readiness --remote --json', 'kolm cloud deploy --target docker --artifact <id>'],
    proof: ['R2/S3-compatible storage readiness', 'deploy script receipt', 'runtime verification'],
  },
  {
    id: 'aws-enterprise-byoc',
    label: 'AWS enterprise BYOC',
    summary: 'Use AWS S3/KMS, BYOC deploy scripts, OTEL, and enterprise identity controls for AWS-native buyers.',
    best_for: ['financial services', 'healthcare enterprise', 'AWS security review'],
    required_any_provider_ids: [['aws-s3']],
    optional_provider_ids: ['remote-ssh-gpu', 'otel-collector', 'enterprise-sso', ...TEACHER_PROVIDER_IDS],
    account: ['/account/storage', '/account/audit-log', '/account/billing'],
    cli: ['kolm cloud deploy --target aws-nitro --artifact <id>', 'kolm audit --json', 'kolm billing usage --json'],
    proof: ['KMS-ready storage config', 'audit log export', 'BYOC attestation'],
  },
  {
    id: 'supabase-product-app',
    label: 'Supabase app storage',
    summary: 'Use Supabase as the app/data substrate while Kolm handles artifacts, capture, evals, and compile proof.',
    best_for: ['SaaS apps already on Supabase', 'team consoles', 'fast hosted product prototypes'],
    required_any_provider_ids: [['supabase-storage']],
    optional_provider_ids: ['enterprise-sso', 'otel-collector', ...COMPUTE_PROVIDER_IDS, ...TEACHER_PROVIDER_IDS],
    account: ['/account/storage', '/account/settings', '/account/api-keys'],
    cli: ['kolm cloud readiness --json', 'kolm dataset export --json', 'kolm publish artifact.kolm'],
    proof: ['Supabase storage readiness', 'tenant-scoped keys', 'artifact version receipt'],
  },
  {
    id: 's3-self-hosted-ssh',
    label: 'Self-hosted S3 + SSH GPU',
    summary: 'Run training on a customer SSH host while using S3-compatible storage for artifacts and exports.',
    best_for: ['labs with owned GPUs', 'on-prem enterprise', 'private cloud clusters'],
    required_any_provider_ids: [['s3-compatible'], ['remote-ssh-gpu']],
    optional_provider_ids: ['otel-collector', 'enterprise-sso', ...TEACHER_PROVIDER_IDS],
    account: ['/account/devices', '/account/storage', '/compute'],
    cli: ['kolm remote plan training --provider=ssh', 'kolm devices register <profile.json>', 'kolm install-device artifact.kolm --device <id>'],
    proof: ['SSH host profile', 'S3-compatible storage readiness', 'device install manifest'],
  },
  {
    id: 'airgapped-enterprise',
    label: 'Air-gapped enterprise',
    summary: 'Move signed artifacts, receipts, and compliance bundles through offline export/import flows.',
    best_for: ['defense', 'closed networks', 'customer-hosted regulated deployments'],
    required_any_provider_ids: [],
    optional_provider_ids: ['enterprise-sso'],
    account: ['/account/storage', '/account/audit-log', '/account/artifacts'],
    cli: ['kolm airgap export artifact.kolm', 'kolm airgap verify artifact.kolm', 'kolm compliance export'],
    proof: ['offline verifier', 'hash-chained audit export', 'compliance bundle'],
  },
]);

function present(env, key) {
  return typeof env[key] === 'string' && env[key].trim().length > 0;
}

function evaluateGroup(group, env) {
  const required = group.required || [];
  const missing = required.filter((k) => !present(env, k));
  let anySatisfied = true;
  let anyMissing = [];
  if (group.required_any_sets) {
    anySatisfied = group.required_any_sets.some((set) => set.every((k) => present(env, k)));
    if (!anySatisfied) {
      anyMissing = group.required_any_sets.map((set) => set.filter((k) => !present(env, k)));
    }
  }
  const configured = missing.length === 0 && anySatisfied;
  const optional_present = (group.optional || []).filter((k) => present(env, k));
  return {
    id: group.id,
    label: group.label || group.id,
    category: group.category,
    configured,
    missing,
    missing_any_sets: anySatisfied ? [] : anyMissing,
    optional_present,
    optional: group.optional || [],
    setup_hint: group.setup_hint || '',
    docs_url: group.docs_url || null,
    caveats: group.caveats || [],
  };
}

export function detectCloudReadiness(env = process.env) {
  const providers = CLOUD_GROUPS.map((group) => evaluateGroup(group, env));
  const categories = {};
  for (const provider of providers) {
    const bucket = categories[provider.category] || { configured: 0, total: 0, ids: [] };
    bucket.total += 1;
    if (provider.configured) {
      bucket.configured += 1;
      bucket.ids.push(provider.id);
    }
    categories[provider.category] = bucket;
  }
  return {
    ok: providers.some((p) => p.category === 'artifact-storage' && p.configured)
      && providers.some((p) => ['hosted-gpu', 'managed-train', 'self-hosted-compute'].includes(p.category) && p.configured),
    categories,
    providers,
  };
}

function flattenRequiredProviderSets(profile) {
  return (profile.required_any_provider_ids || []).map((set) => Array.isArray(set) ? set : [set]);
}

export function deploymentProfiles(env = process.env) {
  const cloud = detectCloudReadiness(env);
  const configured = new Set(cloud.providers.filter((p) => p.configured).map((p) => p.id));
  const providerById = new Map(cloud.providers.map((p) => [p.id, p]));
  return DEPLOYMENT_PROFILES.map((profile) => {
    const requiredSets = flattenRequiredProviderSets(profile);
    const missing_sets = requiredSets
      .filter((set) => !set.some((id) => configured.has(id)))
      .map((set) => set.map((id) => {
        const provider = providerById.get(id);
        return {
          id,
          category: provider?.category || 'unknown',
          missing: provider?.missing || [],
          missing_any_sets: provider?.missing_any_sets || [],
        };
      }));
    const optional_ready = (profile.optional_provider_ids || []).filter((id) => configured.has(id));
    return {
      id: profile.id,
      label: profile.label,
      summary: profile.summary,
      best_for: profile.best_for,
      configured: missing_sets.length === 0,
      missing_sets,
      optional_ready,
      required_any_provider_ids: requiredSets,
      optional_provider_ids: profile.optional_provider_ids || [],
      account: profile.account,
      cli: profile.cli,
      proof: profile.proof,
    };
  });
}

function ids(rows) {
  return new Set(rows.map((row) => row.id));
}

export function validatePlatformCapabilities() {
  const requiredFrameworks = [
    'openai-compatible',
    'anthropic-messages',
    'gguf-llama-cpp',
    'safetensors-peft',
    'onnx-runtime',
    'coreml-ane',
    'mlx-apple-silicon',
    'executorch',
    'litert-android',
    'wasm-webgpu',
    'vllm',
    'sglang',
    'tgi',
    'tensorrt-llm',
    'openvino',
    'qnn-hexagon',
  ];
  const requiredEnterprise = ['tenant-isolation', 'scoped-api-keys', 'zero-retention', 'differential-privacy', 'audit-log-export'];
  const requiredObservability = ['otlp-http-export', 'capture-lake-stats', 'mcp-run-log', 'receipt-verification', 'fallback-path-metadata'];
  const requiredScale = ['response-compression', 'provider-fallbacks', 'r2-artifact-storage', 'hosted-gpu-train', 'self-hosted-gpu-ssh'];
  const requiredModelFamilies = [
    'frontier-teacher-gpt',
    'frontier-teacher-claude',
    'frontier-teacher-gemini',
    'open-weight-dense-llm',
    'open-weight-moe-llm',
    'vision-language-model',
    'embedding-model',
    'speech-asr-model',
    'rag-pipeline-artifact',
    'agent-tool-policy-model',
  ];
  const requiredDevices = [
    'cpu-only-laptop',
    'nvidia-cuda-workstation',
    'amd-rocm-workstation',
    'apple-silicon-mac',
    'windows-directml',
    'intel-npu-openvino',
    'qualcomm-hexagon-qnn',
    'ios-coreml-ane',
    'android-litert-qnn',
    'browser-wasm',
    'browser-webgpu',
    'cloudflare-workers',
    'aws-lambda',
    'remote-ssh-gpu',
    'airgapped-server',
  ];
  const requiredMethods = [
    'capture-proxy',
    'zero-retention-capture',
    'pii-phi-redaction',
    'dataset-split-holdout',
    'eval-gates-k-score',
    'teacher-student-distill',
    'onpolicy-distill',
    'preference-optimization',
    'lora-qlora-train',
    'multimodal-tokenization',
    'rag-index-recall',
    'moe-composition',
    'artifact-signing',
    'offline-verification',
    'mcp-tool-export',
    'provider-fallback-chain',
    'quantize-awq-gptq-gguf-mlx',
    'otel-export',
    'codegraph-impact-audit',
  ];

  const frameworkIds = ids(MODEL_FRAMEWORK_TARGETS);
  const modelFamilyIds = ids(MODEL_FAMILY_TARGETS);
  const deviceIds = ids(DEVICE_TARGETS);
  const methodIds = ids(METHOD_TARGETS);
  const enterpriseIds = ids(ENTERPRISE_CONTROLS);
  const observabilityIds = ids(OBSERVABILITY_CONTROLS);
  const scaleIds = ids(SCALE_CONTROLS);
  const missing = [
    ...requiredFrameworks.filter((id) => !frameworkIds.has(id)).map((id) => 'framework:' + id),
    ...requiredModelFamilies.filter((id) => !modelFamilyIds.has(id)).map((id) => 'model_family:' + id),
    ...requiredDevices.filter((id) => !deviceIds.has(id)).map((id) => 'device:' + id),
    ...requiredMethods.filter((id) => !methodIds.has(id)).map((id) => 'method:' + id),
    ...requiredEnterprise.filter((id) => !enterpriseIds.has(id)).map((id) => 'enterprise:' + id),
    ...requiredObservability.filter((id) => !observabilityIds.has(id)).map((id) => 'observability:' + id),
    ...requiredScale.filter((id) => !scaleIds.has(id)).map((id) => 'scale:' + id),
  ];

  return {
    ok: missing.length === 0,
    missing,
    counts: {
      frameworks: MODEL_FRAMEWORK_TARGETS.length,
      model_families: MODEL_FAMILY_TARGETS.length,
      device_targets: DEVICE_TARGETS.length,
      methods: METHOD_TARGETS.length,
      enterprise_controls: ENTERPRISE_CONTROLS.length,
      observability_controls: OBSERVABILITY_CONTROLS.length,
      scale_controls: SCALE_CONTROLS.length,
    },
  };
}

export function listPlatformCapabilities() {
  return {
    model_framework_targets: MODEL_FRAMEWORK_TARGETS,
    model_family_targets: MODEL_FAMILY_TARGETS,
    device_targets: DEVICE_TARGETS,
    method_targets: METHOD_TARGETS,
    enterprise_controls: ENTERPRISE_CONTROLS,
    observability_controls: OBSERVABILITY_CONTROLS,
    scale_controls: SCALE_CONTROLS,
    deployment_profiles: DEPLOYMENT_PROFILES,
  };
}

export function cloudReadinessSummary(env = process.env) {
  const cloud = detectCloudReadiness(env);
  const object_storage = objectStorageReadiness(env);
  const platform = validatePlatformCapabilities();
  const profiles = deploymentProfiles(env);
  const blockers = [];
  if (!cloud.providers.some((p) => p.category === 'artifact-storage' && p.configured)) {
    blockers.push('no_artifact_storage_configured');
  }
  if (!cloud.providers.some((p) => ['hosted-gpu', 'managed-train', 'self-hosted-compute'].includes(p.category) && p.configured)) {
    blockers.push('no_hosted_gpu_or_managed_train_configured');
    blockers.push('no_cloud_or_remote_compute_configured');
  }
  return {
    ok: platform.ok && blockers.length === 0,
    platform_matrix: platform,
    cloud,
    object_storage,
    deployment_profiles: profiles,
    blockers,
  };
}
