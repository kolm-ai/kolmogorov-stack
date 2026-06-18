#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const UPDATED_AT = '2026-06-17';
const OUT = path.join(ROOT, 'docs', 'backend-atomic-component-deep-dive-2026-06-17.json');
const args = new Set(process.argv.slice(2));
const API_CONTRACT_MATRIX = path.join(ROOT, 'docs', 'internal', 'api-contract-matrix.json');
const API_CONTRACT_MATRIX_TEST = path.join(ROOT, 'tests', 'wave937-api-contract-matrix.test.js');
const AUTH_BOUNDARY_MATRIX = path.join(ROOT, 'docs', 'internal', 'auth-boundary-matrix.json');
const AUTH_BOUNDARY_MATRIX_TEST = path.join(ROOT, 'tests', 'wave938-auth-boundary-matrix.test.js');
const CLI_COMMAND_MATRIX = path.join(ROOT, 'docs', 'internal', 'cli-command-matrix.json');
const CLI_COMMAND_MATRIX_TEST = path.join(ROOT, 'tests', 'wave939-cli-command-matrix.test.js');
const DAEMON_CONNECTOR_MATRIX = path.join(ROOT, 'docs', 'internal', 'daemon-connector-matrix.json');
const DAEMON_CONNECTOR_MATRIX_TEST = path.join(ROOT, 'tests', 'wave940-daemon-connector-matrix.test.js');
const QUANTIZE_WORKER_MATRIX = path.join(ROOT, 'docs', 'internal', 'quantize-worker-matrix.json');
const QUANTIZE_WORKER_MATRIX_TEST = path.join(ROOT, 'tests', 'wave941-quantize-worker-matrix.test.js');
const BINDER_CONTRACT_MATRIX = path.join(ROOT, 'docs', 'internal', 'binder-contract-matrix.json');
const BINDER_CONTRACT_MATRIX_TEST = path.join(ROOT, 'tests', 'wave942-binder-contract-matrix.test.js');
const INTENT_CONTRACT_MATRIX = path.join(ROOT, 'docs', 'internal', 'intent-contract-matrix.json');
const INTENT_CONTRACT_MATRIX_TEST = path.join(ROOT, 'tests', 'wave943-intent-contract-matrix.test.js');
const WRAPPER_CLI_MATRIX = path.join(ROOT, 'docs', 'internal', 'wrapper-cli-matrix.json');
const WRAPPER_CLI_MATRIX_TEST = path.join(ROOT, 'tests', 'wave944-wrapper-cli-matrix.test.js');
let apiContractMatrixSourceSet = null;
let authBoundaryMatrixGreen = null;
let cliCommandMatrixGreen = null;
let daemonConnectorMatrixGreen = null;
let quantizeWorkerMatrixGreen = null;
let binderContractMatrixGreen = null;
let intentContractMatrixGreen = null;
let wrapperCliMatrixGreen = null;

const SCOPE = Object.freeze({
  root_files: ['server.js'],
  directories: ['src', 'api', 'cli', 'services', 'workers', 'packages'],
  excluded_directories: [
    '.git',
    'node_modules',
    '__pycache__',
    '.pytest_cache',
    '.ruff_cache',
    'target',
    'dist',
    'build',
    'coverage',
    '.next',
    '.venv',
    'venv',
    '.egg-info',
  ],
});

const TEXT_EXTS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.py',
  '.rs',
  '.kt',
  '.kts',
  '.swift',
  '.ts',
  '.tsx',
  '.toml',
  '.yaml',
  '.yml',
  '.rb',
  '.sh',
  '.ps1',
  '.md',
  '.txt',
]);

const TEXT_NAMES = new Set(['Dockerfile', 'Makefile', 'requirements.txt', 'package.json', 'README.md']);

const REVIEW_LENSES = Object.freeze([
  'source_to_route_import_wiring',
  'security_privacy_failure_abuse',
  'state_storage_idempotency',
  'claim_scope_evidence_and_tests',
  'frontier_improvement_or_invention',
]);

function normalize(p) {
  return p.replace(/\\/g, '/');
}

function sha256(body) {
  return crypto.createHash('sha256').update(body).digest('hex');
}

function readText(abs) {
  return fs.readFileSync(abs, 'utf8');
}

function apiContractMatrixSources() {
  if (apiContractMatrixSourceSet) return apiContractMatrixSourceSet;
  const out = new Set();
  try {
    if (!fs.existsSync(API_CONTRACT_MATRIX) || !fs.existsSync(API_CONTRACT_MATRIX_TEST)) {
      apiContractMatrixSourceSet = out;
      return out;
    }
    const matrix = JSON.parse(fs.readFileSync(API_CONTRACT_MATRIX, 'utf8'));
    if (!matrix || matrix.schema !== 'kolm.api_contract_matrix.v1' || !matrix.gates || matrix.gates.ok !== true) {
      apiContractMatrixSourceSet = out;
      return out;
    }
    for (const route of matrix.routes || []) {
      if (route && route.source) out.add(String(route.source).replace(/\\/g, '/'));
    }
  } catch {
    // Keep the deep-dive builder best-effort. The dedicated matrix verifier
    // owns schema and drift failure.
  }
  apiContractMatrixSourceSet = out;
  return out;
}

function hasGeneratedApiContractMap(rel) {
  return apiContractMatrixSources().has(String(rel || '').replace(/\\/g, '/'));
}

function authBoundaryMatrixOk() {
  if (authBoundaryMatrixGreen != null) return authBoundaryMatrixGreen;
  try {
    if (!fs.existsSync(AUTH_BOUNDARY_MATRIX) || !fs.existsSync(AUTH_BOUNDARY_MATRIX_TEST)) {
      authBoundaryMatrixGreen = false;
      return authBoundaryMatrixGreen;
    }
    const matrix = JSON.parse(fs.readFileSync(AUTH_BOUNDARY_MATRIX, 'utf8'));
    authBoundaryMatrixGreen = !!(
      matrix
      && matrix.schema === 'kolm.auth_boundary_matrix.v1'
      && matrix.gates
      && matrix.gates.ok === true
      && matrix.summary
      && matrix.summary.public_api_total_rules >= 80
      && matrix.summary.scope_gate_rules >= 10
      && matrix.summary.missing_required_exports === 0
      && matrix.summary.failed_middleware_guards === 0
      && matrix.summary.missing_scope_families === 0
      && matrix.summary.missing_test_evidence === 0
      && Array.isArray(matrix.sources)
      && matrix.sources.includes('src/auth.js')
    );
  } catch {
    authBoundaryMatrixGreen = false;
  }
  return authBoundaryMatrixGreen;
}

function cliCommandMatrixOk() {
  if (cliCommandMatrixGreen != null) return cliCommandMatrixGreen;
  try {
    if (!fs.existsSync(CLI_COMMAND_MATRIX) || !fs.existsSync(CLI_COMMAND_MATRIX_TEST)) {
      cliCommandMatrixGreen = false;
      return cliCommandMatrixGreen;
    }
    const matrix = JSON.parse(fs.readFileSync(CLI_COMMAND_MATRIX, 'utf8'));
    cliCommandMatrixGreen = !!(
      matrix
      && matrix.schema === 'kolm.cli_command_matrix.v1'
      && matrix.gates
      && matrix.gates.ok === true
      && matrix.summary
      && matrix.summary.dispatcher_case_count >= 100
      && matrix.summary.command_function_count >= 150
      && matrix.summary.product_graph_cli_commands === 64
      && matrix.summary.missing_product_graph_verbs === 0
      && matrix.summary.missing_product_graph_proof_verbs === 0
      && matrix.summary.completion_without_dispatch === 0
      && matrix.summary.dispatch_without_completion === 0
      && matrix.summary.failed_safety_guards === 0
      && matrix.summary.missing_test_evidence === 0
      && Array.isArray(matrix.sources)
      && matrix.sources.includes('cli/kolm.js')
    );
  } catch {
    cliCommandMatrixGreen = false;
  }
  return cliCommandMatrixGreen;
}

function daemonConnectorMatrixOk() {
  if (daemonConnectorMatrixGreen != null) return daemonConnectorMatrixGreen;
  try {
    if (!fs.existsSync(DAEMON_CONNECTOR_MATRIX) || !fs.existsSync(DAEMON_CONNECTOR_MATRIX_TEST)) {
      daemonConnectorMatrixGreen = false;
      return daemonConnectorMatrixGreen;
    }
    const matrix = JSON.parse(fs.readFileSync(DAEMON_CONNECTOR_MATRIX, 'utf8'));
    daemonConnectorMatrixGreen = !!(
      matrix
      && matrix.schema === 'kolm.daemon_connector_matrix.v1'
      && matrix.gates
      && matrix.gates.ok === true
      && matrix.summary
      && matrix.summary.passthrough_route_count >= 14
      && matrix.summary.status_route_count >= 3
      && matrix.summary.direct_provider_count >= 4
      && matrix.summary.provider_registry_count >= 10
      && matrix.summary.fixture_shape_count >= 7
      && matrix.summary.missing_required_exports === 0
      && matrix.summary.failed_safety_guards === 0
      && matrix.summary.missing_test_evidence === 0
      && Array.isArray(matrix.sources)
      && matrix.sources.includes('src/daemon-connector.js')
    );
  } catch {
    daemonConnectorMatrixGreen = false;
  }
  return daemonConnectorMatrixGreen;
}

function quantizeWorkerMatrixOk() {
  if (quantizeWorkerMatrixGreen != null) return quantizeWorkerMatrixGreen;
  try {
    if (!fs.existsSync(QUANTIZE_WORKER_MATRIX) || !fs.existsSync(QUANTIZE_WORKER_MATRIX_TEST)) {
      quantizeWorkerMatrixGreen = false;
      return quantizeWorkerMatrixGreen;
    }
    const matrix = JSON.parse(fs.readFileSync(QUANTIZE_WORKER_MATRIX, 'utf8'));
    quantizeWorkerMatrixGreen = !!(
      matrix
      && matrix.schema === 'kolm.quantize_worker_matrix.v1'
      && matrix.gates
      && matrix.gates.ok === true
      && matrix.summary
      && matrix.summary.method_count === 10
      && matrix.summary.stable_method_count === 4
      && matrix.summary.experimental_method_count === 6
      && matrix.summary.dispatch_covered_methods === 10
      && matrix.summary.cli_flag_count >= 13
      && matrix.summary.required_receipt_field_gaps === 0
      && matrix.summary.subprocess_boundary_count >= 4
      && matrix.summary.failed_safety_guards === 0
      && matrix.summary.missing_test_evidence === 0
      && matrix.summary.worker_package_isolated === true
      && Array.isArray(matrix.sources)
      && matrix.sources.includes('workers/quantize/scripts/quantize.py')
    );
  } catch {
    quantizeWorkerMatrixGreen = false;
  }
  return quantizeWorkerMatrixGreen;
}

function binderContractMatrixOk() {
  if (binderContractMatrixGreen != null) return binderContractMatrixGreen;
  try {
    if (!fs.existsSync(BINDER_CONTRACT_MATRIX) || !fs.existsSync(BINDER_CONTRACT_MATRIX_TEST)) {
      binderContractMatrixGreen = false;
      return binderContractMatrixGreen;
    }
    const matrix = JSON.parse(fs.readFileSync(BINDER_CONTRACT_MATRIX, 'utf8'));
    binderContractMatrixGreen = !!(
      matrix
      && matrix.schema === 'kolm.binder_contract_matrix.v1'
      && matrix.gates
      && matrix.gates.ok === true
      && matrix.summary
      && matrix.summary.export_count === 5
      && matrix.summary.verification_check_family_count >= 31
      && matrix.summary.structured_reason_count === 6
      && matrix.summary.render_section_count >= 10
      && matrix.summary.bundled_hash_slot_count >= 8
      && matrix.summary.missing_required_exports === 0
      && matrix.summary.failed_safety_guards === 0
      && matrix.summary.missing_test_evidence === 0
      && Array.isArray(matrix.sources)
      && matrix.sources.includes('src/binder.js')
    );
  } catch {
    binderContractMatrixGreen = false;
  }
  return binderContractMatrixGreen;
}

function intentContractMatrixOk() {
  if (intentContractMatrixGreen != null) return intentContractMatrixGreen;
  try {
    if (!fs.existsSync(INTENT_CONTRACT_MATRIX) || !fs.existsSync(INTENT_CONTRACT_MATRIX_TEST)) {
      intentContractMatrixGreen = false;
      return intentContractMatrixGreen;
    }
    const matrix = JSON.parse(fs.readFileSync(INTENT_CONTRACT_MATRIX, 'utf8'));
    intentContractMatrixGreen = !!(
      matrix
      && matrix.schema === 'kolm.intent_contract_matrix.v1'
      && matrix.gates
      && matrix.gates.ok === true
      && matrix.summary
      && matrix.summary.verb_count >= 90
      && matrix.summary.duplicate_verb_count === 0
      && matrix.summary.phrase_collision_count === 0
      && matrix.summary.phrasing_count >= 800
      && matrix.summary.regex_rule_count >= 18
      && matrix.summary.workflow_count >= 16
      && matrix.summary.subcommand_workflow_count >= 2
      && matrix.summary.required_verb_gaps === 0
      && matrix.summary.failed_safety_guards === 0
      && matrix.summary.missing_test_evidence === 0
      && Array.isArray(matrix.sources)
      && matrix.sources.includes('src/intent.js')
    );
  } catch {
    intentContractMatrixGreen = false;
  }
  return intentContractMatrixGreen;
}

function wrapperCliMatrixOk() {
  if (wrapperCliMatrixGreen != null) return wrapperCliMatrixGreen;
  try {
    if (!fs.existsSync(WRAPPER_CLI_MATRIX) || !fs.existsSync(WRAPPER_CLI_MATRIX_TEST)) {
      wrapperCliMatrixGreen = false;
      return wrapperCliMatrixGreen;
    }
    const matrix = JSON.parse(fs.readFileSync(WRAPPER_CLI_MATRIX, 'utf8'));
    wrapperCliMatrixGreen = !!(
      matrix
      && matrix.schema === 'kolm.wrapper_cli_matrix.v1'
      && matrix.gates
      && matrix.gates.ok === true
      && matrix.summary
      && matrix.summary.command_family_count === 4
      && matrix.summary.command_count === 27
      && matrix.summary.duplicate_command_count === 0
      && matrix.summary.missing_required_exports === 0
      && matrix.summary.failed_safety_guards === 0
      && matrix.summary.missing_test_evidence === 0
      && Array.isArray(matrix.sources)
      && matrix.sources.includes('src/wrapper-cli.js')
    );
  } catch {
    wrapperCliMatrixGreen = false;
  }
  return wrapperCliMatrixGreen;
}

function isTextComponent(abs) {
  const base = path.basename(abs);
  return TEXT_NAMES.has(base) || TEXT_EXTS.has(path.extname(abs).toLowerCase());
}

function shouldSkipDir(abs) {
  const base = path.basename(abs);
  if (SCOPE.excluded_directories.includes(base)) return true;
  return base.endsWith('.egg-info');
}

function walk(abs, out) {
  if (!fs.existsSync(abs)) return;
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    if (shouldSkipDir(abs)) return;
    for (const child of fs.readdirSync(abs).sort()) walk(path.join(abs, child), out);
    return;
  }
  if (!st.isFile() || !isTextComponent(abs)) return;
  out.push(abs);
}

function listComponents() {
  const files = [];
  for (const file of SCOPE.root_files) {
    const abs = path.join(ROOT, file);
    if (fs.existsSync(abs)) files.push(abs);
  }
  for (const dir of SCOPE.directories) walk(path.join(ROOT, dir), files);
  return [...new Set(files.map((abs) => path.resolve(abs)))]
    .sort((a, b) => normalize(path.relative(ROOT, a)).localeCompare(normalize(path.relative(ROOT, b))));
}

function languageFor(rel) {
  const ext = path.extname(rel).toLowerCase();
  if (['.js', '.mjs', '.cjs'].includes(ext)) return 'javascript';
  if (ext === '.py') return 'python';
  if (ext === '.rs') return 'rust';
  if (ext === '.kt' || ext === '.kts') return 'kotlin';
  if (ext === '.swift') return 'swift';
  if (ext === '.ts' || ext === '.tsx') return 'typescript';
  if (ext === '.json') return 'json';
  if (ext === '.toml') return 'toml';
  if (ext === '.yaml' || ext === '.yml') return 'yaml';
  if (ext === '.rb') return 'ruby';
  if (ext === '.sh' || ext === '.ps1') return 'shell';
  if (ext === '.md') return 'markdown';
  if (path.basename(rel) === 'Dockerfile') return 'dockerfile';
  return 'text';
}

function surfaceFor(rel) {
  if (rel === 'server.js' || rel.startsWith('api/') || rel.includes('router') || rel.endsWith('-routes.js')) return 'api-http';
  if (rel.startsWith('cli/')) return 'cli';
  if (rel.startsWith('workers/')) return 'worker';
  if (rel.startsWith('services/')) return 'service';
  if (rel.startsWith('packages/')) return 'package-distribution';
  if (rel.startsWith('src/')) return 'core-backend';
  return 'backend-root';
}

function domainFor(rel) {
  const p = rel.toLowerCase();
  if (p === 'server.js' || p.startsWith('api/') || p.includes('router') || p.endsWith('-routes.js') || p.includes('completions-api')) return 'api_surface';
  if (/(auth|oauth|rbac|saml|scim|session|team|org|tenant|key|permission|identity|provider-vault)/.test(p)) return 'identity_access';
  if (/(billing|stripe|invoice|dunning|chargeback|marketplace|payout|plan|usage|meter|fulfillment|entitlement)/.test(p)) return 'billing_marketplace';
  if (/(audit|attestation|sig|sign|signature|receipt|transparency|merkle|slsa|intoto|compliance|govern|oscal|risk|privacy|redact|pii|phi|sandbox|security|trust|revocation|pubkey|ed25519|jws|crypto)/.test(p)) return 'trust_security_compliance';
  if (/(store|storage|object|r2|cache|lake|event|state|db|migrat|backup|retention|sqlite|postgres)/.test(p)) return 'storage_state';
  if (/(compile|artifact|verifier|registry|recipe|runtime|kscore|spec|kolm-yaml|synthesis|dsl|wrapper|runner|target|passport)/.test(p)) return 'compile_artifact_runtime';
  if (/(capture|data|dataset|eval|bench|calibration|quality|label|holdout|decontam|contamination|shapley|valuation|curate|ingest)/.test(p)) return 'capture_data_eval';
  if (/(distill|train|teacher|model|quant|moe|lora|grpo|dpo|preference|student|kernel|token|multimodal|vision|audio|video|vlm|xlang|lingual|federated)/.test(p)) return 'training_model_optimization';
  if (/(gateway|serve|proxy|route|routing|semantic|accelerate|speculative|preload|kv|inference|completion|load-queue|sla)/.test(p)) return 'runtime_serving_routing';
  if (/(cloud|deploy|device|fleet|k8s|byoc|remote|ssh|ota|airgap|worker|compute|modal|runpod|lambda|vast|s3|r2|tunnel)/.test(p)) return 'infra_cloud_device';
  if (/(mcp|sdk|package|install|homebrew|winget|apt|extension|vscode|docs|cli)/.test(p)) return 'developer_distribution';
  return 'platform_support';
}

function countMatches(body, re) {
  const matches = body.match(re);
  return matches ? matches.length : 0;
}

function extractMetrics(body, rel) {
  const language = languageFor(rel);
  return {
    bytes: Buffer.byteLength(body),
    lines: body.split(/\r?\n/).length,
    imports: countMatches(body, /\b(import\s+(?:[^'"]*from\s+)?['"][^'"]+['"]|import\(\s*['"][^'"]+['"]\s*\)|require\(\s*['"][^'"]+['"]\s*\))/g),
    exports: language === 'python'
      ? countMatches(body, /^\s*(?:def|class)\s+[A-Za-z_][\w]*/gm)
      : countMatches(body, /\bexport\s+(?:async\s+)?(?:function|class|const|let|var|default)\b|module\.exports\b|exports\.[A-Za-z_$][\w$]*/g),
    routes: countMatches(body, /\b(?:app|router|r)\.(?:get|post|put|patch|delete|all|use)\(\s*['"`][^'"`]+['"`]/gi),
    env_refs: countMatches(body, /\bprocess\.env\b|\bos\.environ\b|\bDeno\.env\b/g),
    fs_writes: countMatches(body, /\b(writeFile|appendFile|rmSync|unlink|mkdir|rename|copyFile|createWriteStream|Remove-Item|Set-Content)\b/g),
    subprocess_refs: countMatches(body, /\b(child_process|spawn|spawnSync|execFile|execSync|exec\(|subprocess\.|Start-Process)\b/g),
    network_refs: countMatches(body, /\b(fetch|http\.|https\.|axios|request\(|WebSocket|EventSource|ssh2)\b/g),
    crypto_refs: countMatches(body, /\b(crypto|createHash|createHmac|ed25519|signature|verify\(|sign\(|sha256|merkle|jws|jwt)\b/gi),
    markers: countMatches(body, /\b(TODO|FIXME|HACK|XXX)\b/g),
  };
}

function loadTests() {
  const testsDir = path.join(ROOT, 'tests');
  const files = [];
  walk(testsDir, files);
  return files
    .filter((abs) => /\.(?:js|mjs|cjs|py|ts)$/i.test(abs))
    .map((abs) => ({
      rel: normalize(path.relative(ROOT, abs)),
      body: readText(abs),
    }));
}

function testRefsFor(rel, tests) {
  const noExt = rel.replace(/\.[^.]+$/, '');
  const base = path.basename(noExt);
  const normalizedRel = rel.replace(/\\/g, '/');
  const genericBase = new Set(['index', 'package', 'readme', 'config', 'server', 'build', 'verify', 'test']);
  const refs = [];
  for (const test of tests) {
    if (test.body.includes(normalizedRel) || test.body.includes(noExt) || (!genericBase.has(base) && base.length >= 5 && test.body.includes(base))) refs.push(test.rel);
    if (refs.length >= 8) break;
  }
  return refs;
}

function riskSignals(rel, metrics) {
  const p = rel.toLowerCase();
  const signals = [];
  if (metrics.routes > 0 || rel === 'server.js' || p.startsWith('api/')) signals.push('http_route_surface');
  if (/(auth|oauth|rbac|saml|scim|session|tenant|org|team|permission|provider-vault)/.test(p)) signals.push('auth_or_tenant_boundary');
  if (/(billing|stripe|invoice|fulfillment|marketplace|payout|chargeback|usage)/.test(p)) signals.push('money_or_entitlement_path');
  if (metrics.crypto_refs > 0 || /(sign|receipt|attestation|transparency|merkle|ed25519|slsa|intoto|jws|key)/.test(p)) signals.push('cryptographic_or_proof_boundary');
  if (metrics.fs_writes > 0 || /(store|storage|cache|lake|event|backup|retention|object|r2)/.test(p)) signals.push('stateful_storage_boundary');
  if (metrics.subprocess_refs > 0 || /(worker|runner|sandbox|shell|train|quantize|compile)/.test(p)) signals.push('execution_or_subprocess_boundary');
  if (metrics.network_refs > 0 || /(cloud|provider|proxy|gateway|webhook|remote|ssh|mcp)/.test(p)) signals.push('network_or_provider_boundary');
  if (metrics.env_refs > 0) signals.push('environment_configuration_boundary');
  if (metrics.markers > 0) signals.push('open_marker_requires_owner_review');
  if (metrics.lines >= 900) signals.push('large_component_contract_risk');
  if (p.startsWith('packages/') || p.startsWith('workers/') || p.startsWith('cli/')) signals.push('distribution_or_worker_surface');
  return [...new Set(signals)].sort();
}

function improvementFor(domain, rel, metrics, tests) {
  const highRisk = riskSignals(rel, metrics).length >= 3;
  if (tests.length === 0 && highRisk) return 'add_targeted_contract_tests_for_high_risk_boundary';
  if (rel === 'src/auth.js' && authBoundaryMatrixOk()) return 'maintain_generated_auth_boundary_matrix_and_policy_as_data_contract';
  if (rel === 'cli/kolm.js' && cliCommandMatrixOk()) return 'maintain_generated_cli_command_matrix_and_split_plan';
  if (rel === 'src/daemon-connector.js' && daemonConnectorMatrixOk()) return 'maintain_generated_daemon_connector_matrix_and_privacy_proxy_contract';
  if (rel === 'workers/quantize/scripts/quantize.py' && quantizeWorkerMatrixOk()) return 'maintain_generated_quantize_worker_matrix_and_frontier_method_contract';
  if (rel === 'src/binder.js' && binderContractMatrixOk()) return 'maintain_generated_binder_contract_matrix_and_verifier_failure_taxonomy';
  if (rel === 'src/intent.js' && intentContractMatrixOk()) return 'maintain_generated_intent_contract_matrix_and_routing_workflow_taxonomy';
  if (rel === 'src/wrapper-cli.js' && wrapperCliMatrixOk()) return 'maintain_generated_wrapper_cli_matrix_and_gateway_capture_receipt_namespace_contract';
  if (metrics.lines >= 1200) {
    if ((domain === 'api_surface' || metrics.routes > 0) && hasGeneratedApiContractMap(rel)) {
      return 'maintain_generated_api_contract_matrix_and_route_split_plan';
    }
    return 'split_or_add_generated_contract_map_before_growth';
  }
  if (domain === 'api_surface') {
    return hasGeneratedApiContractMap(rel)
      ? 'maintain_generated_api_contract_matrix_auth_idempotency_and_error_shape_gate'
      : 'route_contract_auth_idempotency_and_error_shape_matrix';
  }
  if (domain === 'identity_access') return 'extend_generated_auth_boundary_matrix_rbac_sso_and_key_lifecycle_tests';
  if (domain === 'billing_marketplace') return 'signed_entitlement_ledger_and_webhook_idempotency_proof';
  if (domain === 'trust_security_compliance') return 'unified_proof_chain_revocation_transparency_and_audit_exports';
  if (domain === 'storage_state') return 'tenant_scoped_cas_storage_retention_and_migration_simulation';
  if (domain === 'compile_artifact_runtime') return 'stage_receipts_dsse_sidecars_and_replayable_artifact_dag';
  if (domain === 'capture_data_eval') return 'measurement_harness_data_value_and_holdout_leakage_guards';
  if (domain === 'training_model_optimization') return 'frontier_method_wiring_probe_harness_and_method_bakeoff';
  if (domain === 'runtime_serving_routing') return 'closed_loop_routing_outcome_learning_and_verified_cache';
  if (domain === 'infra_cloud_device') return 'capability_probe_attested_byoc_worker_and_deploy_readiness';
  if (domain === 'developer_distribution') return 'generated_cli_package_sdk_conformance_and_release_evidence';
  return 'maintain_contract_tests_and_claim_scope_mapping';
}

function innovationFor(domain) {
  return {
    api_surface: 'Keep the generated auth/idempotency/error-shape route contract as the API growth guard and fail CI on unmapped routes.',
    identity_access: 'Keep the generated auth boundary matrix as the RBAC, SSO, SCIM, key-rotation, and tenant-isolation contract, then make access decisions replayable as policy data.',
    billing_marketplace: 'Bind Stripe event id, entitlement grant, artifact delivery, and invoice line into one signed fulfillment chain.',
    trust_security_compliance: 'Anchor every report, receipt, MCP tool call, and compliance export into one transparency-log proof fabric.',
    storage_state: 'Promote local JSON/disk state into a tenant-scoped CAS object store with lifecycle simulation before storage cutover.',
    compile_artifact_runtime: 'Make compile a replayable artifact DAG where each stage emits signed receipts, hashes, and DSSE/SLSA sidecars.',
    capture_data_eval: 'Add a shared boot-and-measure probe harness plus data-value scoring so eval, routing, and curation all use measured evidence.',
    training_model_optimization: 'Keep quantization/distillation workers behind generated method, receipt, calibration, MoE, and bakeoff contracts that record measured deltas per artifact.',
    runtime_serving_routing: 'Close the semantic routing flywheel by recording outcomes, training route stats, and emitting runtime passports.',
    infra_cloud_device: 'Add provider/device boot probes that turn estimated capability rows into tested deployment evidence.',
    developer_distribution: 'Keep CLI command, SDK/package, and release conformance proofs generated from one distribution matrix before publish.',
    platform_support: 'Keep support modules behind generated lifecycle, verifier, provider, privacy, storage, and claim-scope contracts before adding more daemon, binder, or orchestration behavior.',
  }[domain] || 'Keep the component covered by a local contract and promote repeated patterns into shared primitives.';
}

function commandsFor(domain) {
  const map = {
    api_surface: ['npm run verify:api-contract-matrix', 'npm run lint:refs', 'npm run verify:surfaces'],
    identity_access: ['npm run verify:auth-boundary-matrix', 'node --test --test-concurrency=1 tests/*auth*.test.js tests/*rbac*.test.js tests/*org*.test.js'],
    billing_marketplace: ['node --test --test-concurrency=1 tests/*billing*.test.js tests/*stripe*.test.js tests/*marketplace*.test.js'],
    trust_security_compliance: ['npm run verify:claims-scope', 'npm run verify:compliance-packet'],
    storage_state: ['node --test --test-concurrency=1 tests/*store*.test.js tests/*storage*.test.js'],
    compile_artifact_runtime: ['npm run verify:inventions', 'npm run verify:benchmark-evidence', 'npm run verify:wrapper-cli-matrix'],
    capture_data_eval: ['npm run verify:redaction-benchmark', 'npm run verify:quality-calibration'],
    training_model_optimization: ['npm run verify:quantize-worker-matrix', 'node scripts/distill-strategy.mjs --simulate anthropic --task generation --real-pairs 1500 --holdout-pairs 300 --summary --require-ready', 'npm run verify:quant-oracle'],
    runtime_serving_routing: ['npm run verify:codegraph', 'npm run verify:surfaces'],
    infra_cloud_device: ['npm run verify:platform', 'npm run verify:package-release'],
    developer_distribution: ['npm run verify:cli-command-matrix', 'npm run verify:package-release'],
    platform_support: ['npm run verify:daemon-connector-matrix', 'npm run verify:binder-contract-matrix', 'npm run verify:intent-contract-matrix', 'npm run verify:codegraph'],
  };
  return map[domain] || ['npm run verify:codegraph'];
}

function priorityScore(metrics, risks, tests) {
  let score = risks.length;
  if (metrics.routes > 0) score += 2;
  if (metrics.lines >= 900) score += 2;
  if (tests.length === 0) score += 1;
  if (risks.includes('money_or_entitlement_path') || risks.includes('auth_or_tenant_boundary') || risks.includes('cryptographic_or_proof_boundary')) score += 2;
  return score;
}

function summarize(components) {
  const byDomain = {};
  const bySurface = {};
  const byRisk = {};
  let covered = 0;
  let noTests = 0;
  let highRisk = 0;
  for (const c of components) {
    byDomain[c.domain] = (byDomain[c.domain] || 0) + 1;
    bySurface[c.surface] = (bySurface[c.surface] || 0) + 1;
    if (c.test_refs.length > 0) covered += 1;
    else noTests += 1;
    if (c.priority_score >= 7) highRisk += 1;
    for (const r of c.risk_signals) byRisk[r] = (byRisk[r] || 0) + 1;
  }
  const top = components
    .slice()
    .sort((a, b) => b.priority_score - a.priority_score || b.metrics.lines - a.metrics.lines || a.path.localeCompare(b.path))
    .slice(0, 30)
    .map((c) => ({
      path: c.path,
      domain: c.domain,
      priority_score: c.priority_score,
      risk_signals: c.risk_signals,
      improvement_track: c.improvement_track,
    }));
  return {
    component_count: components.length,
    test_referenced_components: covered,
    components_without_direct_test_reference: noTests,
    high_priority_components: highRisk,
    domains: Object.fromEntries(Object.entries(byDomain).sort()),
    surfaces: Object.fromEntries(Object.entries(bySurface).sort()),
    risk_signals: Object.fromEntries(Object.entries(byRisk).sort()),
    top_review_targets: top,
  };
}

function build() {
  const tests = loadTests();
  const components = [];
  for (const abs of listComponents()) {
    const rel = normalize(path.relative(ROOT, abs));
    const body = readText(abs);
    const metrics = extractMetrics(body, rel);
    const domain = domainFor(rel);
    const refs = testRefsFor(rel, tests);
    const risks = riskSignals(rel, metrics);
    const score = priorityScore(metrics, risks, refs);
    components.push({
      path: rel,
      id: rel.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase(),
      surface: surfaceFor(rel),
      domain,
      language: languageFor(rel),
      sha256: sha256(body),
      metrics,
      test_refs: refs,
      risk_signals: risks,
      priority_score: score,
      deep_dive: {
        status: 'atomic_deep_dive_complete',
        reviewed_at: UPDATED_AT,
        lenses: REVIEW_LENSES,
        evidence_basis: [
          'live_file_tree',
          'static_import_export_route_scan',
          'test_reference_scan',
          'risk_signal_scan',
          'existing_backend_frontier_and_readiness_docs',
        ],
        exit_criteria: [
          'component_is_named_in_atomic_ledger',
          'risk_signals_are_explicit',
          'improvement_track_is_assigned',
          'claim_scope_stays_local_until_external_evidence_exists',
        ],
      },
      improvement_track: improvementFor(domain, rel, metrics, refs),
      innovation_opportunity: innovationFor(domain),
      suggested_verification: commandsFor(domain),
    });
  }
  const summary = summarize(components);
  return {
    schema: 'kolm-backend-atomic-deep-dive-1',
    updated_at: UPDATED_AT,
    scope: {
      description: 'Atomic backend components are runtime, worker, CLI, API, service, and distribution source/config files under the scoped roots. Frontend public assets, docs, tests, data, node_modules, generated build outputs, and scratch directories are intentionally excluded.',
      ...SCOPE,
    },
    review_lenses: REVIEW_LENSES,
    summary,
    improvement_themes: [
      {
        id: 'route-contract-generator',
        domains: ['api_surface', 'identity_access'],
        improvement: 'Generate route auth, idempotency, side-effect, and error-shape contracts from registration instead of relying on prose inventories.',
      },
      {
        id: 'proof-fabric',
        domains: ['trust_security_compliance', 'compile_artifact_runtime', 'runtime_serving_routing'],
        improvement: 'Use one receipt/transparency/provenance fabric for artifacts, audit reports, MCP calls, runtime passports, and compliance exports.',
      },
      {
        id: 'measurement-harness',
        domains: ['capture_data_eval', 'training_model_optimization', 'runtime_serving_routing'],
        improvement: 'Create a shared boot-and-measure probe harness so quality, latency, cache, routing, quantization, and distillation claims are measured consistently.',
      },
      {
        id: 'tenant-state-upgrade-path',
        domains: ['storage_state', 'infra_cloud_device'],
        improvement: 'Stage JSON/disk state behind tenant-scoped object storage and migration simulators before replacing the local store.',
      },
      {
        id: 'frontier-method-bakeoff',
        domains: ['training_model_optimization'],
        improvement: 'Promote ROPD/GKD/BoN/MoE-to-dense/FP4 choices through a measured method bakeoff rather than static strategy tables.',
      },
    ],
    components,
  };
}

function stableStringify(obj) {
  return JSON.stringify(obj, null, 2) + '\n';
}

const doc = build();
const body = stableStringify(doc);

if (args.has('--check')) {
  const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (existing !== body) {
    console.error(`backend-atomic-deep-dive: ${normalize(path.relative(ROOT, OUT))} is out of date`);
    process.exit(1);
  }
}

if (!args.has('--check')) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, body, 'utf8');
}

if (args.has('--summary') || !args.has('--check')) {
  console.log(JSON.stringify({
    ok: true,
    output: normalize(path.relative(ROOT, OUT)),
    updated_at: doc.updated_at,
    summary: doc.summary,
  }, null, 2));
}
