// Canonical product-experience contract.
//
// This is the shared spine between account UX, CLI/TUI affordances, API
// surface ownership, and launch-readiness audits. Keep it pure: no network
// calls, no secret reads, no filesystem reads.

export const USER_CONTROL_DIMENSIONS = Object.freeze([
  {
    id: 'model-provider',
    label: 'Model provider',
    options: ['OpenAI', 'Anthropic Claude', 'OpenRouter', 'Gemini/OpenAI-compatible', 'local .kolm', 'self-hosted OpenAI-compatible'],
    required_affordance: 'Every inference and teacher path must let the user choose or override the provider/model.',
  },
  {
    id: 'compute-target',
    label: 'Compute target',
    options: ['local CPU', 'local CUDA', 'Apple Silicon/MLX/CoreML', 'ROCm', 'OpenVINO', 'QNN/Hexagon', 'remote SSH GPU', 'managed GPU', 'BYOC cloud'],
    required_affordance: 'Training, distill, quantize, and runtime flows must expose local, remote, and hosted compute instead of assuming local hardware.',
  },
  {
    id: 'artifact-runtime',
    label: 'Artifact runtime',
    options: ['GGUF/llama.cpp', 'ONNX Runtime', 'CoreML', 'MLX', 'ExecuTorch', 'LiteRT', 'WASM/WebGPU', 'TensorRT-LLM', 'vLLM', 'SGLang', 'TGI'],
    required_affordance: 'Compiled artifacts must record target runtime, quantization, model hash, and verifier metadata.',
  },
  {
    id: 'storage-plane',
    label: 'Storage plane',
    options: ['local disk', 'R2-compatible object storage', 'S3-compatible', 'AWS S3/KMS', 'Supabase Storage', 'air-gapped export'],
    required_affordance: 'Artifacts, lake exports, and compliance bundles must be movable between local, cloud, and air-gapped storage.',
  },
  {
    id: 'privacy-mode',
    label: 'Privacy mode',
    options: ['capture for training', 'redacted capture', 'zero retention', 'differential privacy aggregates', 'customer-managed keys', 'air-gap'],
    required_affordance: 'Every capture and lake route must tell the user what is stored, what is redacted, and how to turn storage off.',
  },
  {
    id: 'deployment-mode',
    label: 'Deployment mode',
    options: ['hosted Kolm API', 'local daemon', 'Docker/self-host', 'BYOC deploy script', 'remote SSH install', 'device fleet install', 'MCP tool export'],
    required_affordance: 'The user must be able to run the same artifact in hosted, local, enterprise, and agent contexts.',
  },
  {
    id: 'governance-mode',
    label: 'Governance mode',
    options: ['single developer', 'team workspace', 'RBAC API keys', 'audit log', 'SSO/SCIM-ready', 'billing controls', 'SIEM/OTEL export'],
    required_affordance: 'Enterprise controls must be explicit account surfaces, not hidden configuration folklore.',
  },
  {
    id: 'proof-mode',
    label: 'Proof mode',
    options: ['K-score', 'holdout receipts', 'signature verification', 'artifact diff', 'eval replay', 'benchmark JSON', 'compliance binder'],
    required_affordance: 'Every shipped model claim must have a verifier, replay, or benchmark path the user can run themselves.',
  },
]);

export const PRODUCT_SURFACE_EXPERIENCE = Object.freeze([
  {
    id: 'gateway-capture',
    name: 'Gateway Capture',
    stage: 'capture',
    user_goal: 'Replace provider base URLs once, capture useful production calls, and keep OpenAI, Claude, OpenRouter, and OpenAI-compatible servers optional.',
    account: ['/account/connectors', '/account/captured', '/account/lake'],
    cli: ['kolm capture --provider openai --as local', 'kolm capture --provider anthropic --as local', 'kolm capture status', 'kolm tail captures'],
    tui: ['connectors', 'live-calls'],
    api: ['POST /v1/chat/completions', 'POST /v1/capture/openai', 'POST /v1/capture/anthropic', 'POST /v1/capture/openrouter', 'POST /v1/capture/log', 'GET /v1/capture/stream', 'GET /v1/capture/health', 'GET /v1/capture/rbac/policy'],
    customization: ['model-provider', 'privacy-mode', 'deployment-mode'],
    primary_action: 'Connect a provider or point an SDK at the Kolm base URL.',
    empty_state_action: 'Run `kolm capture --provider openai --as local --json` or open account connectors.',
    status_fields: ['configured_provider_count', 'capture_health', 'last_event_at', 'zero_retention_enabled'],
    evidence_paths: ['src/router.js', 'src/daemon-connector.js', 'src/completions-api.js', 'src/team-capture-rbac.js', 'public/account/connectors.html', 'public/account/captured.html'],
    ux_contract: ['no hover-only control', 'copyable base URL', 'provider-specific setup', 'explicit retention state', 'REST equivalent visible'],
  },
  {
    id: 'privacy-lake',
    name: 'Privacy Lake',
    stage: 'observe',
    user_goal: 'Inspect captured calls, filter noisy traffic, redact sensitive data, and export SQL/JSONL-ready rows without leaking secrets.',
    account: ['/account/lake', '/account/privacy-events', '/account/storage'],
    cli: ['kolm lake stats --json', 'kolm lake tail --limit 20', 'kolm privacy scan', 'kolm privacy report'],
    tui: ['privacy-events', 'storage-sync'],
    api: ['GET /v1/lake/stats', 'GET /v1/lake/tail', 'GET /v1/lake/export', 'GET /v1/lake/storage', 'POST /v1/privacy/scan', 'GET /v1/privacy/events', 'GET /v1/privacy/report'],
    customization: ['privacy-mode', 'storage-plane', 'proof-mode'],
    primary_action: 'Filter the lake by provider, model, status, namespace, and latency.',
    empty_state_action: 'Capture sample calls or import a JSONL corpus.',
    status_fields: ['events_24h', 'redaction_counts', 'dp_epsilon', 'storage_backend'],
    evidence_paths: ['src/lake.js', 'src/privacy-membrane.js', 'src/event-store.js', 'src/event-schema.js', 'public/account/lake.html', 'public/account/privacy-events.html'],
    ux_contract: ['filter chips for common slices', 'DP toggle for aggregates', 'export button', 'storage truth panel'],
  },
  {
    id: 'datasets-labeling',
    name: 'Datasets And Labeling',
    stage: 'prepare',
    user_goal: 'Promote reviewed capture rows into train/eval datasets with holdouts, labels, simulations, and bakeoffs.',
    account: ['/account/datasets', '/account/labeling', '/account/simulations', '/account/bakeoffs'],
    cli: ['kolm dataset candidates --json', 'kolm label next --json', 'kolm dataset split <id>', 'kolm sim generate-dataset <id>'],
    tui: ['opportunities', 'labeling-queue', 'datasets', 'bakeoffs'],
    api: ['GET /v1/datasets', 'POST /v1/datasets', 'POST /v1/datasets/:id/split', 'GET /v1/bakeoffs', 'POST /v1/bakeoffs'],
    customization: ['proof-mode', 'privacy-mode', 'model-provider'],
    primary_action: 'Approve the next highest-value example or create a dataset from repeated work.',
    empty_state_action: 'Run `kolm demo seed-log-triage` or connect a provider to create candidates.',
    status_fields: ['candidate_count', 'review_queue', 'holdout_count', 'bakeoff_delta'],
    evidence_paths: ['src/dataset-workbench.js', 'src/simulation.js', 'src/router.js', 'public/account/datasets.html', 'public/account/labeling.html', 'public/account/bakeoffs.html'],
    ux_contract: ['one-row review actions', 'holdout warning', 'source provenance shown', 'promote path visible'],
  },
  {
    id: 'train-distill',
    name: 'Train And Distill',
    stage: 'train',
    user_goal: 'Train, distill, preference-optimize, or synthesize smaller task models from owned data on local, rented, managed, or self-hosted compute.',
    account: ['/account/builds', '/account/distill-runs', '/account/multimodal-bakeoff'],
    cli: ['kolm train plan <dataset> --strategy', 'kolm distill strategy --json', 'kolm bench evidence --summary', 'kolm train --namespace <name>', 'kolm distill --namespace <name>', 'kolm cloud train <name> --seeds examples.jsonl', 'kolm pipeline full'],
    tui: ['builds', 'multimodal-bakeoff', 'compile'],
    api: ['GET /v1/builds', 'POST /v1/multimodal/bakeoff', 'GET /v1/multimodal/bakeoff'],
    customization: ['model-provider', 'compute-target', 'artifact-runtime', 'proof-mode'],
    primary_action: 'Choose teacher, student, compute backend, eval gate, and output target before starting a build.',
    empty_state_action: 'Create a dataset, run `kolm distill strategy --json`, or run `kolm bench evidence --summary` before making benchmark claims.',
    status_fields: ['build_state', 'teacher_model', 'student_model', 'compute_target', 'k_score_gate'],
    evidence_paths: ['src/distill-pipeline.js', 'src/distill-strategy.js', 'src/benchmark-evidence.js', 'src/distill-onpolicy.js', 'src/distill-preference.js', 'src/spec-decode.js', 'src/remote-compute.js', 'scripts/distill-strategy.mjs', 'scripts/benchmark-evidence.mjs', 'public/account/builds.html', 'public/account/distill-runs.html'],
    ux_contract: ['failure diagnostics', 'cost quote before cloud run', 'holdout gate visible', 'provider/model selector'],
  },
  {
    id: 'models-backbones',
    name: 'Models And Backbones',
    stage: 'choose',
    user_goal: 'Choose real teacher/student/backbone families by task, license, modality, memory budget, device fit, and runtime target, including Gemma 3, Gemma 3n, MedGemma, and EmbeddingGemma.',
    account: ['/models', '/account/builds', '/account/devices'],
    cli: ['kolm models list --json', 'kolm models recommend --json', 'kolm models devices --json', 'kolm models info google/gemma-3n-E2B-it'],
    tui: ['models', 'devices', 'compile'],
    api: ['GET /v1/models', 'GET /v1/models/manifest', 'GET /v1/models/cache', 'GET /v1/models/recommend', 'GET /v1/models/info/:id', 'GET /v1/devices/recommend'],
    customization: ['model-provider', 'compute-target', 'artifact-runtime', 'proof-mode'],
    primary_action: 'Pick the best backbone for the task and target device before starting a distill or compile.',
    empty_state_action: 'Run `kolm models recommend --json` or open the model catalog.',
    status_fields: ['recommended_model', 'family', 'modalities', 'license', 'vram_gb', 'device_fit'],
    evidence_paths: ['src/models.js', 'src/model-registry.js', 'src/model-weights-manifest.js', 'public/models.html', 'tests/wave552-gemma-multimodal-account.test.js'],
    ux_contract: ['Gemma rows explicit', 'license/device tradeoff visible', 'no fake model families', 'runtime target fit shown'],
  },
  {
    id: 'multimodal-tokenization',
    name: 'Multimodal Tokenization',
    stage: 'prepare',
    user_goal: 'Turn image, audio, video, PDF, text, and code files into searchable Markdown sidecars and compile-ready feature tokens with optional provider captions or transcripts.',
    account: ['/account/multimodal-bakeoff', '/account/lake', '/account/datasets'],
    cli: ['kolm media tokenize --path ./scan.png --json', 'kolm media tokenize --dir ./evidence --json', 'kolm media redact-job --path ./scan.pdf --json', 'kolm bakeoff multimodal --json'],
    tui: ['multimodal-tokenize', 'multimodal-bakeoff', 'datasets'],
    api: ['GET /v1/multimodal/tokenize/doctor', 'POST /v1/multimodal/tokenize', 'POST /v1/capture/media', 'POST /v1/multimodal/bakeoff'],
    customization: ['privacy-mode', 'model-provider', 'storage-plane', 'proof-mode'],
    primary_action: 'Tokenize media into sidecars, then review/bake off the generated examples before training.',
    empty_state_action: 'Run `kolm media tokenize --path <file> --json` on a local file.',
    status_fields: ['modality', 'sidecar_path', 'feature_tokenizer', 'captioner', 'transcriber', 'errors'],
    evidence_paths: ['services/embed/multimodal.js', 'src/router.js', 'cli/kolm.js', 'public/account/multimodal-bakeoff.html', 'tests/wave552-gemma-multimodal-account.test.js'],
    ux_contract: ['local fallback sidecars', 'optional provider captions', 'no placeholder sidecars', 'compile-ready provenance'],
  },
  {
    id: 'compile-verify',
    name: 'Compile And Verify',
    stage: 'compile',
    user_goal: 'Compile signed .kolm artifacts, verify them offline, compare versions, and export runtime-specific assets.',
    account: ['/account/artifacts'],
    cli: ['kolm compile --spec spec.json --out task.kolm', 'kolm quantize oracle --json', 'kolm verify task.kolm', 'kolm diff old.kolm new.kolm', 'kolm export task.kolm --target gguf --preview', 'kolm evidence format-governance --summary'],
    tui: ['artifacts', 'compile', 'audit-log'],
    api: ['GET /v1/artifacts', 'GET /v1/artifacts/:id', 'GET /v1/artifacts/:id/download', 'POST /v1/artifacts/dependency-graph'],
    customization: ['artifact-runtime', 'proof-mode', 'storage-plane'],
    primary_action: 'Compile, choose quantization/runtime strategy, verify, and export an artifact with receipts.',
    empty_state_action: 'Run `kolm build <name>` to create a first artifact.',
    status_fields: ['artifact_count', 'latest_k_score', 'signature_state', 'runtime_targets'],
    evidence_paths: ['src/compile-pipeline.js', 'src/quantization-oracle.js', 'src/artifact.js', 'src/artifact-runner.js', 'src/export-provenance.js', 'src/artifact-dependency-graph.js', 'src/format-governance-packet.js', 'scripts/quantization-oracle.mjs', 'scripts/format-governance-packet.mjs', 'docs/kolm-format-v1.md', 'public/account/artifacts.html'],
    ux_contract: ['download and verify are adjacent', 'manifest details expandable', 'version diff visible', 'no unverifiable marketing claim'],
  },
  {
    id: 'runtime-inference',
    name: 'Runtime Inference',
    stage: 'run',
    user_goal: 'Run artifacts locally, through hosted OpenAI-compatible endpoints, in browser/edge runtimes, or through fallback chains.',
    account: ['/account/devices', '/account/artifacts'],
    cli: ['kolm run task.kolm "input"', 'kolm serve --mcp --http', 'kolm chat-tui --model=kolm:task', 'kolm runtime targets', 'kolm packages release-readiness --summary', 'kolm evidence runtime-adoption --summary'],
    tui: ['live-calls', 'artifacts', 'devices'],
    api: ['POST /v1/chat/completions', 'GET /v1/devices', 'GET /v1/devices/recommend', 'GET /v1/streaming/capabilities'],
    customization: ['model-provider', 'artifact-runtime', 'deployment-mode', 'compute-target'],
    primary_action: 'Select artifact, fallback chain, runtime target, and device class.',
    empty_state_action: 'Open the artifact list or use `kolm chat-tui --model=openai:gpt-5` to compare hosted versus compiled output.',
    status_fields: ['runtime_target', 'fallback_used', 'latency_p95', 'device_fit'],
    evidence_paths: ['src/completions-api.js', 'src/runtime-policy.js', 'src/streaming-contract.js', 'src/package-release-readiness.js', 'src/runtime-adoption-packets.js', 'scripts/package-release-readiness.mjs', 'scripts/runtime-adoption-packets.mjs', 'public/sdk.js', 'public/tui.html', 'cli/kolm.js'],
    ux_contract: ['fallback chain visible', 'streaming supported', 'latency/cost shown', 'local/hybrid switch explicit'],
  },
  {
    id: 'compute-cloud',
    name: 'Compute And Cloud',
    stage: 'deploy',
    user_goal: 'Use Kolm even without a GPU by selecting R2-compatible object storage, S3-compatible storage, AWS, Supabase, Modal, RunPod, Lambda, Together, or remote SSH.',
    account: ['/account/devices', '/account/storage', '/account/settings'],
    cli: ['kolm cloud broker --json', 'kolm cloud readiness --remote --json', 'kolm cloud storage --json', 'kolm cloud storage --provider cloudflare-r2-s3 --smoke --json', 'kolm cloud targets --json', 'kolm cloud deploy-plan --target cloudflare-workers --artifact <id>', 'kolm compute pick --json', 'kolm remote recommend', 'kolm cloud deploy --target aws-nitro --artifact <id>'],
    tui: ['devices', 'storage-sync', 'settings'],
    api: ['GET /v1/cloud/readiness', 'GET /v1/storage/object-readiness', 'GET /v1/cloud/deploy-targets', 'POST /v1/cloud/deploy-plan', 'GET /v1/byoc/targets', 'POST /v1/byoc/deploy', 'GET /v1/byoc/deployments', 'GET /v1/sync/status', 'GET /v1/devices/detect'],
    customization: ['compute-target', 'storage-plane', 'deployment-mode', 'governance-mode'],
    primary_action: 'Run the cloud broker and readiness doctors to choose the cheapest compliant compute, storage, and deployment profile before launching work.',
    empty_state_action: 'Configure R2/S3/Supabase and a GPU provider env var, or add remote SSH.',
    status_fields: ['artifact_storage', 'hosted_gpu', 'managed_train', 'deployment_profile', 'byoc_target', 'remote_ssh'],
    evidence_paths: ['src/platform-capabilities.js', 'src/object-storage.js', 'src/cloud-compute-broker.js', 'src/deployment-plans.js', 'src/remote-compute.js', 'src/compute/registry.json', 'scripts/cloud-readiness.mjs', 'scripts/cloud-compute-broker.mjs', 'docs/cloud-product-readiness.md', 'public/account/storage.html'],
    ux_contract: ['no secrets displayed', 'missing vars grouped by provider', 'local fallback shown', 'cloud cost/capability surfaced before action'],
  },
  {
    id: 'devices-fleet',
    name: 'Devices And Fleet',
    stage: 'deploy',
    user_goal: 'Register laptops, phones, browsers, edge boxes, servers, and team-owned GPU hosts; test installability; push artifacts over local, SSH, HTTP, reverse tunnel, or air-gapped flows.',
    account: ['/account/devices'],
    cli: ['kolm devices detect --json', 'kolm devices recommend --json', 'kolm tunnel new --team <id>', 'kolm install-device artifact.kolm --device <id>', 'kolm airgap verify artifact.kolm'],
    tui: ['devices', 'storage-sync'],
    api: ['GET /v1/devices', 'GET /v1/devices/detect', 'POST /v1/devices/:id/register', 'POST /v1/devices/:id/test', 'POST /v1/devices/:id/install', 'GET /v1/devices/recommend', 'POST /v1/tunnel/register', 'GET /v1/tunnels'],
    customization: ['compute-target', 'artifact-runtime', 'deployment-mode'],
    primary_action: 'Detect hardware, recommend runtime targets, create team tunnels when needed, and install verified artifacts.',
    empty_state_action: 'Run `kolm devices detect --json` from the target machine.',
    status_fields: ['device_count', 'last_probe', 'supported_targets', 'install_state', 'team_tunnels'],
    evidence_paths: ['src/device-capabilities.js', 'src/router.js', 'public/account/devices.html', 'docs/kolm-format-v1.md'],
    ux_contract: ['device class labels', 'install test before deploy', 'offline path visible', 'runtime target warnings', 'team tunnel path visible'],
  },
  {
    id: 'enterprise-governance',
    name: 'Enterprise Governance',
    stage: 'govern',
    user_goal: 'Operate with tenants, scoped keys, team approvals, audit logs, billing controls, SSO/SCIM-ready identity, and compliance export.',
    account: ['/account/api-keys', '/account/audit-log', '/account/billing', '/account/settings', '/account/privacy-events'],
    cli: ['kolm whoami --json', 'kolm keys list', 'kolm audit --json', 'kolm billing usage --json', 'kolm team members', 'kolm evidence compliance-certification --summary'],
    tui: ['audit-log', 'billing', 'settings', 'privacy-events'],
    api: ['GET /v1/account', 'GET /v1/account/keys', 'POST /v1/account/keys', 'GET /v1/account/audit-log', 'GET /v1/billing/usage', 'GET /v1/account/settings', 'GET /v1/account/compliance-package', 'POST /v1/capture/rbac/evaluate'],
    customization: ['governance-mode', 'privacy-mode', 'storage-plane', 'proof-mode'],
    primary_action: 'Review access, cost, audit, and compliance state before scaling usage.',
    empty_state_action: 'Create scoped API keys and export the compliance package.',
    status_fields: ['tenant_id', 'plan', 'key_scopes', 'audit_rows', 'billing_usage'],
    evidence_paths: ['src/auth.js', 'src/keys.js', 'src/audit.js', 'src/team-capture-rbac.js', 'src/compliance-certification-packet.js', 'src/router.js', 'scripts/compliance-certification-packet.mjs', 'public/account/api-keys.html', 'public/account/audit-log.html', 'public/account/billing.html'],
    ux_contract: ['scoped key language', 'audit export', 'billing cap warnings', 'tenant isolation wording'],
  },
  {
    id: 'agents-registry',
    name: 'Agents And Registry',
    stage: 'integrate',
    user_goal: 'Expose verified artifacts as MCP tools, agent harness installs, public/private registry entries, and replayable run logs.',
    account: ['/account/agent-telemetry', '/account/artifacts'],
    cli: ['kolm compile --as-mcp --spec spec.json', 'kolm serve --mcp', 'kolm install claude-code --apply', 'kolm publish artifact.kolm', 'kolm hub list'],
    tui: ['agent-telemetry', 'artifacts', 'connectors'],
    api: ['GET /v1/artifacts', 'GET /v1/agents/stats', 'GET /v1/registry/verified-publishers/policy'],
    customization: ['deployment-mode', 'governance-mode', 'proof-mode'],
    primary_action: 'Install the verified artifact into the user agent harness or registry.',
    empty_state_action: 'Compile with `--as-mcp` or run `kolm serve --mcp` locally.',
    status_fields: ['mcp_tools', 'agent_sessions', 'run_log_count', 'published_artifacts'],
    evidence_paths: ['services/mcp/server.js', 'src/repo-codegraph.js', 'src/publisher-verification.js', 'cli/kolm.js', 'public/account/agent-telemetry.html'],
    ux_contract: ['tool name visible', 'hashed run logs', 'agent install proof', 'registry pinning'],
  },
]);

export function listProductExperience() {
  return PRODUCT_SURFACE_EXPERIENCE.map((row) => ({ ...row }));
}

export function productExperienceById(id) {
  return PRODUCT_SURFACE_EXPERIENCE.find((row) => row.id === id) || null;
}

export function accountSectionsBySurface() {
  return Object.fromEntries(PRODUCT_SURFACE_EXPERIENCE.map((row) => [row.id, row.account.slice()]));
}

export function tuiViews() {
  const rows = [];
  const seen = new Set();
  for (const surface of PRODUCT_SURFACE_EXPERIENCE) {
    for (const view of surface.tui || []) {
      if (seen.has(view)) continue;
      seen.add(view);
      rows.push({
        id: view,
        label: view.replace(/-/g, ' '),
        surfaces: PRODUCT_SURFACE_EXPERIENCE.filter((s) => (s.tui || []).includes(view)).map((s) => s.id),
      });
    }
  }
  return rows;
}

export function apiRoutesBySurface() {
  return Object.fromEntries(PRODUCT_SURFACE_EXPERIENCE.map((row) => [row.id, row.api.slice()]));
}

export function validateProductExperience() {
  const missing = [];
  const ids = new Set();
  for (const row of PRODUCT_SURFACE_EXPERIENCE) {
    if (!row.id || !/^[a-z0-9-]+$/.test(row.id)) missing.push(`bad_id:${row.id}`);
    if (ids.has(row.id)) missing.push(`duplicate_id:${row.id}`);
    ids.add(row.id);
    for (const field of ['name', 'user_goal', 'primary_action', 'empty_state_action']) {
      if (!row[field] || String(row[field]).trim().length < 8) missing.push(`${row.id}:missing_${field}`);
    }
    if (!row.stage || !/^[a-z-]{3,24}$/.test(row.stage)) missing.push(`${row.id}:missing_stage`);
    for (const field of ['account', 'cli', 'tui', 'api', 'customization', 'status_fields', 'evidence_paths', 'ux_contract']) {
      if (!Array.isArray(row[field]) || row[field].length === 0) missing.push(`${row.id}:missing_${field}`);
    }
  }

  const requiredSurfaces = [
    'gateway-capture',
    'privacy-lake',
    'datasets-labeling',
    'train-distill',
    'models-backbones',
    'multimodal-tokenization',
    'compile-verify',
    'runtime-inference',
    'compute-cloud',
    'devices-fleet',
    'enterprise-governance',
    'agents-registry',
  ];
  for (const id of requiredSurfaces) {
    if (!ids.has(id)) missing.push(`required_surface:${id}`);
  }

  const dimensionIds = new Set(USER_CONTROL_DIMENSIONS.map((row) => row.id));
  for (const row of PRODUCT_SURFACE_EXPERIENCE) {
    for (const dimension of row.customization || []) {
      if (!dimensionIds.has(dimension)) missing.push(`${row.id}:unknown_customization:${dimension}`);
    }
  }
  for (const id of ['model-provider', 'compute-target', 'artifact-runtime', 'storage-plane', 'privacy-mode', 'deployment-mode', 'governance-mode', 'proof-mode']) {
    if (!dimensionIds.has(id)) missing.push(`required_dimension:${id}`);
  }

  return {
    ok: missing.length === 0,
    missing,
    counts: {
      surfaces: PRODUCT_SURFACE_EXPERIENCE.length,
      account_links: PRODUCT_SURFACE_EXPERIENCE.reduce((n, row) => n + row.account.length, 0),
      cli_commands: PRODUCT_SURFACE_EXPERIENCE.reduce((n, row) => n + row.cli.length, 0),
      tui_views: tuiViews().length,
      api_routes: PRODUCT_SURFACE_EXPERIENCE.reduce((n, row) => n + row.api.length, 0),
      customization_dimensions: USER_CONTROL_DIMENSIONS.length,
    },
  };
}
