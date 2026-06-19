#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const UPDATED_AT = '2026-06-17';
const OUT = path.join(ROOT, 'docs', 'whole-stack-sota-deep-dive-2026-06-17.json');
const SPEC = path.join(ROOT, 'docs', 'STACK-TECH-SPEC-2026-06-15.md');
const ATOMIC = path.join(ROOT, 'docs', 'backend-atomic-component-deep-dive-2026-06-17.json');
const READINESS = path.join(ROOT, 'docs', 'product-sota-readiness.json');
const FRONTIER_MAP = path.join(ROOT, 'docs', 'product-frontier-map.json');
const MATH_FRONTIER = path.join(ROOT, 'docs', 'product-math-frontier.json');
const RESEARCH_ATLAS = path.join(ROOT, 'docs', 'product-research-atlas.json');
const BUILDBOOK = path.join(ROOT, 'docs', 'product-invention-buildbook.json');
const IMPLEMENTATION_SPEC = path.join(ROOT, 'docs', 'product-invention-implementation-spec.json');

const args = new Set(process.argv.slice(2));

const STACK_CATEGORIES = Object.freeze([
  {
    id: 'distillation',
    stack_area: 'training',
    domains: ['training_model_optimization', 'capture_data_eval'],
    readiness_surfaces: ['compile-train-distill', 'ai-ml-optimizer'],
    keywords: ['distill', 'teacher', 'preference', 'grpo', 'gkd', 'ropd', 'cot', 'onpolicy'],
    required_paths: ['src/distill-strategy.js', 'src/distill-pipeline.js', 'workers/distill/scripts/train_gkd.py'],
  },
  {
    id: 'moe-distill-quant',
    stack_area: 'training',
    domains: ['training_model_optimization', 'compile_artifact_runtime'],
    readiness_surfaces: ['compile-train-distill', 'ai-ml-optimizer'],
    keywords: ['moe', 'expert', 'forge', 'quant'],
    required_paths: ['src/moe-support.js', 'src/moe-registry.js', 'src/forge-experts.js', 'src/moe-to-dense.js', 'apps/trainer/moe_to_dense.py', 'workers/quantize/scripts/quantize.py'],
  },
  {
    id: 'quantization',
    stack_area: 'compiler-runtime',
    domains: ['training_model_optimization', 'compile_artifact_runtime', 'runtime_serving_routing'],
    readiness_surfaces: ['compile-train-distill', 'runtime-compute'],
    keywords: ['quant', 'fp4', 'nvfp4', 'gptq', 'awq', 'gguf', 'export'],
    required_paths: ['src/quantization-oracle.js', 'workers/quantize/scripts/quantize.py', 'src/export-nvfp4.js'],
  },
  {
    id: 'kv-cache',
    stack_area: 'runtime',
    domains: ['runtime_serving_routing', 'compile_artifact_runtime'],
    readiness_surfaces: ['runtime-compute', 'ai-ml-optimizer'],
    keywords: ['kv', 'cache', 'itkv', 'preload', 'runtime'],
    required_paths: ['src/kv-cache-policy.js', 'src/kv-cache-shard.js', 'src/itkv-profile.js'],
  },
  {
    id: 'speculative-decoding',
    stack_area: 'runtime',
    domains: ['runtime_serving_routing', 'training_model_optimization'],
    readiness_surfaces: ['runtime-compute', 'ai-ml-optimizer'],
    keywords: ['speculative', 'spec-decode', 'accelerate', 'draft', 'eagle'],
    required_paths: ['src/accelerate.js', 'src/speculative-decoding.js', 'src/spec-decode.js', 'apps/trainer/eagle3_train.py'],
  },
  {
    id: 'finetune-frameworks',
    stack_area: 'training',
    domains: ['training_model_optimization', 'infra_cloud_device'],
    readiness_surfaces: ['compile-train-distill', 'infrastructure-enterprise'],
    keywords: ['train', 'lora', 'finetune', 'peft', 'unsloth', 'runner'],
    required_paths: ['workers/distill/scripts/train_lora.py', 'workers/distill/scripts/train_lora_unsloth.py', 'src/distill-runners/index.js'],
  },
  {
    id: 'synthetic-data-curation',
    stack_area: 'data',
    domains: ['capture_data_eval', 'training_model_optimization'],
    readiness_surfaces: ['capture-gateway-lake', 'compile-train-distill'],
    keywords: ['data', 'curate', 'synthetic', 'quality', 'dedup', 'augment', 'label'],
    required_paths: ['src/data-curate.js', 'src/synthetic-data.js', 'src/data-quality-classifier.js'],
  },
  {
    id: 'small-llm-students',
    stack_area: 'model-registry',
    domains: ['training_model_optimization', 'compile_artifact_runtime'],
    readiness_surfaces: ['compile-train-distill', 'registry-marketplace'],
    keywords: ['student', 'model', 'registry', 'small', 'backbone', 'weights'],
    required_paths: ['src/models.js', 'src/student-arch-recommender.js', 'src/model-registry.js'],
  },
  {
    id: 'ondevice-inference',
    stack_area: 'cross-device',
    domains: ['infra_cloud_device', 'developer_distribution', 'compile_artifact_runtime'],
    readiness_surfaces: ['runtime-compute', 'developer-experience'],
    keywords: ['device', 'mobile', 'browser', 'wasm', 'webgpu', 'runtime', 'coreml', 'mlx'],
    required_paths: ['src/device-capabilities.js', 'src/platform-capabilities.js', 'packages/runtime-rs/src/wasm.rs'],
  },
  {
    id: 'llm-routing',
    stack_area: 'gateway',
    domains: ['runtime_serving_routing', 'capture_data_eval', 'platform_support'],
    readiness_surfaces: ['capture-gateway-lake', 'infrastructure-enterprise', 'ai-ml-optimizer'],
    keywords: ['route', 'router', 'routing', 'provider', 'gateway', 'semantic'],
    required_paths: ['src/gateway-router.js', 'src/semantic-router.js', 'src/route-quality-store.js'],
  },
  {
    id: 'mcp-tool-gateway-receipts',
    stack_area: 'agent-integrations',
    domains: ['developer_distribution', 'trust_security_compliance', 'runtime_serving_routing'],
    readiness_surfaces: ['developer-experience', 'infrastructure-enterprise'],
    keywords: ['mcp', 'tool', 'receipt', 'gateway', 'intoto'],
    required_paths: ['src/mcp-gateway.js', 'src/mcp-gateway-routes.js', 'src/intoto-receipt.js'],
  },
  {
    id: 'verifiable-inference',
    stack_area: 'trust',
    domains: ['trust_security_compliance', 'compile_artifact_runtime', 'runtime_serving_routing'],
    readiness_surfaces: ['format-standard', 'infrastructure-enterprise', 'runtime-compute'],
    keywords: ['verified', 'verify', 'receipt', 'inference', 'attestation', 'sigstore'],
    required_paths: ['src/verified.js', 'src/gateway-receipt.js', 'src/sigstore.js', 'packages/attestation/src/index.js', 'src/proven-compute-runtime.js'],
  },
  {
    id: 'model-signing-standards',
    stack_area: 'trust',
    domains: ['trust_security_compliance', 'compile_artifact_runtime', 'developer_distribution'],
    readiness_surfaces: ['format-standard', 'infrastructure-enterprise'],
    keywords: ['sign', 'slsa', 'intoto', 'sbom', 'artifact', 'provenance', 'ed25519'],
    required_paths: ['src/artifact.js', 'src/intoto-slsa.js', 'src/sbom-emit.js', 'src/ed25519.js'],
  },
  {
    id: 'confidential-compute',
    stack_area: 'enterprise',
    domains: ['infra_cloud_device', 'trust_security_compliance', 'training_model_optimization'],
    readiness_surfaces: ['infrastructure-enterprise', 'runtime-compute'],
    keywords: ['confidential', 'airgap', 'byoc', 'secure', 'attestation', 'nras', 'sandbox'],
    required_paths: ['src/confidential-compute.js', 'src/byoc.js', 'src/airgap-distill.js', 'src/secure-training.js'],
  },
  {
    id: 'agent-security-eval',
    stack_area: 'enterprise',
    domains: ['trust_security_compliance', 'capture_data_eval', 'api_surface'],
    readiness_surfaces: ['infrastructure-enterprise', 'capture-gateway-lake'],
    keywords: ['audit', 'agent', 'red-team', 'risk', 'control', 'eval'],
    required_paths: ['src/audit-orchestrator.js', 'src/red-team.js', 'src/attestation-report-builder.js'],
  },
  {
    id: 'compile-api-to-model-competitors',
    stack_area: 'compiler-platform',
    domains: ['compile_artifact_runtime', 'capture_data_eval', 'infra_cloud_device', 'developer_distribution'],
    readiness_surfaces: ['compile-train-distill', 'capture-gateway-lake', 'runtime-compute', 'developer-experience'],
    keywords: ['compile', 'pipeline', 'artifact', 'cloud', 'capture', 'runtime', 'registry'],
    required_paths: ['src/compile-pipeline.js', 'src/artifact.js', 'src/cloud-distill.js', 'cli/kolm.js'],
  },
]);

const REVIEW_LENSES = Object.freeze([
  'as_built_code_evidence',
  'frontier_delta_and_gap_trace',
  'atomic_component_mapping',
  'readiness_and_claim_scope',
  'improvement_or_invention_path',
  'verification_gate',
]);

const EXTERNAL_FRESHNESS_PROBE = Object.freeze([
  {
    id: 'gad-black-box-on-policy-distillation',
    category: 'distillation',
    source_type: 'paper',
    url: 'https://arxiv.org/abs/2511.10643',
    confirms: 'GAD remains a primary frontier reference for black-box on-policy distillation and supports the open GAD trainer/bakeoff gap.',
  },
  {
    id: 'moe-to-dense-arxiv',
    category: 'moe-distill-quant',
    source_type: 'paper',
    url: 'https://arxiv.org/abs/2605.28207',
    confirms: 'MoE-to-dense remains the current frontier path: score/select/group experts, concatenate into a dense FFN, then recover with forward-KL distillation.',
  },
  {
    id: 'nvidia-tensorrt-llm-quantization',
    category: 'quantization',
    source_type: 'official-docs',
    url: 'https://nvidia.github.io/TensorRT-LLM/latest/features/quantization.html',
    confirms: 'TensorRT-LLM documents FP4 quantization recipes, keeping NVFP4/FP4 execution and measured accuracy gates relevant.',
  },
  {
    id: 'nvidia-model-optimizer',
    category: 'quantization',
    source_type: 'official-repo',
    url: 'https://github.com/NVIDIA/Model-Optimizer',
    confirms: 'NVIDIA Model Optimizer remains the official optimization substrate for quantization, pruning, distillation, speculative decoding, and TensorRT/vLLM export.',
  },
  {
    id: 'vllm-speculative-decoding',
    category: 'speculative-decoding',
    source_type: 'official-docs',
    url: 'https://docs.vllm.ai/en/latest/features/speculative_decoding/',
    confirms: 'vLLM documents model-based speculation methods including EAGLE, draft models, MTP, PARD, and MLP, keeping draft-model wiring and acceptance metrics relevant.',
  },
  {
    id: 'category-aware-semantic-caching',
    category: 'llm-routing',
    source_type: 'paper',
    url: 'https://arxiv.org/abs/2510.26835',
    confirms: 'Category-aware semantic caching varies thresholds, TTLs, and quotas by workload category, supporting the W987 route-path cache hardening.',
  },
  {
    id: 'nvidia-attestation-suite',
    category: 'confidential-compute',
    source_type: 'official-docs',
    url: 'https://docs.nvidia.com/attestation/index.html',
    confirms: 'NVIDIA Attestation Suite documents NRAS/RIM/OCSP, supporting the open GPU attestation verification gap.',
  },
  {
    id: 'intel-trust-authority-gpu-attestation',
    category: 'confidential-compute',
    source_type: 'official-docs',
    url: 'https://docs.trustauthority.intel.com/main/articles/articles/ita/concept-gpu-attestation.html',
    confirms: 'Intel Trust Authority documents composite CVM and NVIDIA GPU TEE attestation, supporting the proven-compute integration path.',
  },
]);

function normalize(p) {
  return p.replace(/\\/g, '/');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}

function headingLineMap(markdown) {
  const lines = markdown.split(/\r?\n/);
  const out = new Map();
  lines.forEach((line, index) => {
    const match = line.match(/^###\s+([a-z0-9-]+)\s*$/i);
    if (match) out.set(match[1], index + 1);
  });
  return out;
}

function extractCategorySection(markdown, id) {
  const re = new RegExp(`^### ${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  const match = markdown.match(re);
  if (!match || match.index == null) return null;
  const start = match.index;
  const rest = markdown.slice(start + match[0].length);
  const next = rest.search(/\n###\s+/);
  const body = next >= 0 ? rest.slice(0, next) : rest;
  return body.trim();
}

function sliceBetween(section, startLabel, endLabel) {
  const start = section.indexOf(startLabel);
  if (start < 0) return '';
  const from = start + startLabel.length;
  const end = endLabel ? section.indexOf(endLabel, from) : -1;
  return (end >= 0 ? section.slice(from, end) : section.slice(from)).trim();
}

function bulletCount(text) {
  return (text.match(/^\s*-\s+/gm) || []).length;
}

function improvementCount(text) {
  return (text.match(/^\s*-\s+\((?:surgical-now|spec-followup)/gm) || []).length;
}

function severityCounts(text) {
  const counts = { critical: 0, major: 0, minor: 0 };
  for (const key of Object.keys(counts)) {
    const re = new RegExp(`\\[${key}\\]`, 'gi');
    counts[key] = (text.match(re) || []).length;
  }
  return counts;
}

function flattenRequirements(readiness) {
  const out = [];
  for (const surface of readiness.surfaces || []) {
    for (const requirement of surface.requirements || []) out.push({ surface: surface.id, ...requirement });
  }
  return out;
}

function componentMatches(component, category) {
  if (category.required_paths.includes(component.path)) return true;
  if (category.domains.includes(component.domain)) return true;
  const p = component.path.toLowerCase();
  return category.keywords.some((keyword) => p.includes(keyword.toLowerCase()));
}

function selectComponents(atomic, category) {
  const required = [];
  const optional = [];
  for (const component of atomic.components || []) {
    if (!componentMatches(component, category)) continue;
    const row = {
      path: component.path,
      domain: component.domain,
      priority_score: component.priority_score,
      risk_signals: component.risk_signals,
      test_refs: component.test_refs.slice(0, 3),
      improvement_track: component.improvement_track,
    };
    if (category.required_paths.includes(component.path)) required.push(row);
    else optional.push(row);
  }
  optional.sort((a, b) => b.priority_score - a.priority_score || a.path.localeCompare(b.path));
  return {
    required,
    sampled: optional.slice(0, 16),
    count: required.length + optional.length,
    missing_required_paths: category.required_paths.filter((p) => !(atomic.components || []).some((component) => component.path === p)),
  };
}

function readinessFor(readinessRows, category) {
  const rows = readinessRows.filter((row) => category.readiness_surfaces.includes(row.surface));
  const status_counts = {};
  for (const row of rows) status_counts[row.status] = (status_counts[row.status] || 0) + 1;
  const open = rows
    .filter((row) => !['shipped', 'implemented'].includes(row.status))
    .map((row) => ({ surface: row.surface, id: row.id, status: row.status, priority: row.priority }));
  return { count: rows.length, status_counts, open };
}

function idsFromField(rows, field, category) {
  return (rows || [])
    .filter((row) => category.keywords.some((keyword) => JSON.stringify(row).toLowerCase().includes(keyword.toLowerCase())))
    .map((row) => row.id)
    .filter(Boolean)
    .slice(0, 12);
}

function linkedResearch(category, docs) {
  return {
    frontier_programs: idsFromField(docs.frontier.programs, 'programs', category),
    math_inventions: idsFromField(docs.math.inventions, 'inventions', category),
    research_deltas: idsFromField(docs.atlas.invention_deltas, 'invention_deltas', category),
    buildbook_inventions: idsFromField(docs.buildbook.inventions, 'inventions', category),
    implementation_spec_inventions: idsFromField(docs.implementation.inventions, 'inventions', category),
  };
}

function verificationFor(category) {
  const base = ['npm run verify:stack-sota'];
  const map = {
    training: ['npm run verify:inventions', 'node scripts/distill-strategy.mjs --simulate anthropic --task generation --real-pairs 1500 --holdout-pairs 300 --summary --require-ready'],
    'compiler-runtime': ['npm run verify:quant-oracle', 'npm run verify:benchmark-evidence'],
    runtime: ['npm run verify:surfaces', 'npm run verify:codegraph'],
    data: ['npm run verify:redaction-benchmark', 'npm run verify:quality-calibration'],
    'model-registry': ['npm run verify:inventions', 'npm run verify:package-release'],
    'cross-device': ['npm run verify:platform', 'npm run verify:package-release'],
    gateway: ['npm run verify:surfaces', 'npm run verify:claims-scope'],
    'agent-integrations': ['npm run verify:governance-packets', 'npm run verify:claims-scope'],
    trust: ['npm run verify:compliance-packet', 'npm run verify:claims-scope'],
    enterprise: ['npm run verify:compliance-packet', 'npm run verify:readiness-workorders'],
    'compiler-platform': ['npm run verify:inventions', 'npm run verify:depth'],
  };
  return [...base, ...(map[category.stack_area] || ['npm run verify:depth'])];
}

function categoryStatus(sectionStats, readiness) {
  if (sectionStats.gaps.critical > 0) return 'sota_review_complete_critical_frontier_work_open';
  if (sectionStats.gaps.major > 0) return 'sota_review_complete_major_frontier_work_open';
  if (readiness.open.length > 0) return 'sota_review_complete_external_or_release_gate_open';
  return 'sota_review_complete_local_frontier_aligned';
}

function build() {
  const markdown = readText(SPEC);
  const atomic = readJson(ATOMIC);
  const readiness = readJson(READINESS);
  const readinessRows = flattenRequirements(readiness);
  const docs = {
    frontier: readJson(FRONTIER_MAP),
    math: readJson(MATH_FRONTIER),
    atlas: readJson(RESEARCH_ATLAS),
    buildbook: readJson(BUILDBOOK),
    implementation: readJson(IMPLEMENTATION_SPEC),
  };
  const headingLines = headingLineMap(markdown);
  const categories = [];
  const failures = [];

  for (const category of STACK_CATEGORIES) {
    const section = extractCategorySection(markdown, category.id);
    if (!section) failures.push(`${category.id}: missing stack spec section`);
    const asBuilt = section ? sliceBetween(section, '**As-built (our state).**', '**Frontier') : '';
    const frontier = section ? sliceBetween(section, '**Frontier', '**Already at frontier.**') : '';
    const already = section ? sliceBetween(section, '**Already at frontier.**', '**Gaps.**') : '';
    const gaps = section ? sliceBetween(section, '**Gaps.**', '**Improvements.**') : '';
    const improvements = section ? sliceBetween(section, '**Improvements.**', null) : '';
    const sectionStats = {
      line: headingLines.get(category.id) || null,
      has_as_built: asBuilt.length > 100,
      has_frontier_delta: frontier.length > 100,
      already_at_frontier_count: bulletCount(already),
      improvement_count: improvementCount(improvements),
      gaps: severityCounts(gaps),
    };
    if (!sectionStats.has_as_built) failures.push(`${category.id}: as-built section too thin`);
    if (!sectionStats.has_frontier_delta) failures.push(`${category.id}: frontier section too thin`);
    if (sectionStats.already_at_frontier_count < 1) failures.push(`${category.id}: no already-at-frontier evidence`);
    if (sectionStats.improvement_count < 1) failures.push(`${category.id}: no improvement path`);

    const components = selectComponents(atomic, category);
    if (components.count < 3) failures.push(`${category.id}: atomic component mapping too thin`);
    if (components.missing_required_paths.length) failures.push(`${category.id}: missing required paths ${components.missing_required_paths.join(', ')}`);
    const readinessSlice = readinessFor(readinessRows, category);
    const research = linkedResearch(category, docs);

    categories.push({
      id: category.id,
      stack_area: category.stack_area,
      status: categoryStatus(sectionStats, readinessSlice),
      source_stack_spec: {
        path: 'docs/STACK-TECH-SPEC-2026-06-15.md',
        line: sectionStats.line,
      },
      local_sota_review: sectionStats,
      atomic_components: components,
      readiness: readinessSlice,
      linked_research: research,
      deep_dive: {
        status: 'whole_stack_sota_deep_dive_complete',
        reviewed_at: UPDATED_AT,
        lenses: REVIEW_LENSES,
        evidence_basis: [
          'stack_frontier_spec',
          'backend_atomic_component_ledger',
          'product_sota_readiness',
          'frontier_map',
          'math_frontier',
          'research_atlas',
          'invention_buildbook',
          'invention_implementation_spec',
        ],
        exit_criteria: [
          'category_has_as_built_evidence',
          'category_has_frontier_delta',
          'category_has_atomic_component_mapping',
          'category_has_gap_or_alignment_status',
          'category_has_improvement_or_invention_path',
          'category_has_verification_commands',
        ],
      },
      improvement_track: improvements.includes('(surgical-now') ? 'surgical_now_plus_spec_followup' : 'spec_followup_required',
      suggested_verification: verificationFor(category),
    });
  }

  const status_counts = {};
  let critical_gap_categories = 0;
  let major_gap_categories = 0;
  let total_atomic_component_links = 0;
  for (const category of categories) {
    status_counts[category.status] = (status_counts[category.status] || 0) + 1;
    if (category.local_sota_review.gaps.critical > 0) critical_gap_categories += 1;
    if (category.local_sota_review.gaps.major > 0) major_gap_categories += 1;
    total_atomic_component_links += category.atomic_components.count;
  }

  const doc = {
    schema: 'kolm-whole-stack-sota-deep-dive-1',
    updated_at: UPDATED_AT,
    purpose: 'Whole-stack SOTA review ledger tying each frontier stack category to local code evidence, atomic component risks, readiness scope, and improvement or invention tracks.',
    scope: {
      stack_spec: 'docs/STACK-TECH-SPEC-2026-06-15.md',
      atomic_ledger: 'docs/backend-atomic-component-deep-dive-2026-06-17.json',
      categories_expected: STACK_CATEGORIES.map((category) => category.id),
      note: 'This ledger proves local review coverage and gap visibility. It does not convert external partner, public benchmark, package-release, or live certification gates into completed evidence.',
    },
    external_freshness_probe: {
      checked_at: UPDATED_AT,
      purpose: 'Primary-source spot check for the highest-volatility SOTA gaps before locking this local stack pass.',
      sources: EXTERNAL_FRESHNESS_PROBE,
    },
    review_lenses: REVIEW_LENSES,
    summary: {
      category_count: categories.length,
      categories_with_critical_frontier_work_open: critical_gap_categories,
      categories_with_major_frontier_work_open: major_gap_categories,
      total_atomic_component_links,
      status_counts,
      readiness_open_requirements: readinessRows.filter((row) => !['shipped', 'implemented'].includes(row.status)).map((row) => ({
        surface: row.surface,
        id: row.id,
        status: row.status,
        priority: row.priority,
      })),
    },
    cross_stack_invention_themes: [
      {
        id: 'boot-and-measure-harness',
        applies_to: ['quantization', 'kv-cache', 'speculative-decoding', 'distillation', 'agent-security-eval'],
        path: 'shared measured evidence for quality, latency, acceptance rate, cache retention, and regression gates',
      },
      {
        id: 'proof-fabric',
        applies_to: ['verifiable-inference', 'model-signing-standards', 'mcp-tool-gateway-receipts', 'confidential-compute'],
        path: 'one transparency/provenance receipt chain across artifacts, reports, MCP calls, runtime passports, and compliance exports',
      },
      {
        id: 'hosted-private-training-fleet',
        applies_to: ['compile-api-to-model-competitors', 'finetune-frameworks', 'confidential-compute', 'distillation'],
        path: 'managed or BYOC trainer queue with privacy gates, worker attestations, and artifact receipts',
      },
      {
        id: 'frontier-method-bakeoff',
        applies_to: ['distillation', 'moe-distill-quant', 'quantization', 'small-llm-students'],
        path: 'method selection from measured deltas rather than static strategy scoring',
      },
      {
        id: 'cross-device-verified-runtime',
        applies_to: ['ondevice-inference', 'model-signing-standards', 'verifiable-inference'],
        path: 'verify signed weights before WebGPU/WASM/mobile execution and attach runtime passports',
      },
    ],
    categories,
    failures,
  };

  if (doc.summary.category_count !== STACK_CATEGORIES.length) failures.push('category count mismatch');
  return doc;
}

function stableStringify(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

const doc = build();
const body = stableStringify(doc);

if (args.has('--check')) {
  const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (existing !== body) {
    console.error(`stack-sota-deep-dive: ${normalize(path.relative(ROOT, OUT))} is out of date`);
    process.exit(1);
  }
}

if (!args.has('--check')) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, body, 'utf8');
}

if (args.has('--summary') || !args.has('--check')) {
  console.log(JSON.stringify({
    ok: doc.failures.length === 0,
    output: normalize(path.relative(ROOT, OUT)),
    updated_at: doc.updated_at,
    summary: doc.summary,
    failures: doc.failures,
  }, null, 2));
}

if (doc.failures.length) process.exit(1);
