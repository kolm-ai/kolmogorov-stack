import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const RUNTIME_ADOPTION_SPEC = 'kolm-runtime-adoption-packets-1';
export const RUNTIME_ADOPTION_MANIFEST_SPEC = 'kolm-runtime-adoption-manifest-1';

const SECRET_VALUE_RE = /\b(?:ks_[a-z0-9_]{12,}|sk-[a-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/i;
const SHA256_RE = /^(?:sha256:)?[a-f0-9]{64}$/i;

export const RUNTIME_ADOPTION_TARGETS = [
  {
    id: 'huggingface-hub',
    label: 'Hugging Face Hub model card and artifact repo packet',
    url: 'https://huggingface.co/docs/hub/en/model-cards',
    required_fields: ['model_card_yaml', 'artifact_files', 'evaluation_metadata', 'license', 'base_model', 'dataset_refs'],
  },
  {
    id: 'ollama',
    label: 'Ollama Modelfile packet',
    url: 'https://docs.ollama.com/modelfile',
    required_fields: ['modelfile', 'from_gguf', 'adapter_mapping', 'license', 'template', 'minimum_version'],
  },
  {
    id: 'llama-cpp',
    label: 'llama.cpp launcher and GGUF sidecar packet',
    url: 'https://github.com/ggml-org/llama.cpp',
    required_fields: ['gguf_path', 'runtime_flags', 'metadata_sidecar', 'verification_command', 'backend_matrix'],
  },
  {
    id: 'onnx-gguf-tooling',
    label: 'ONNX/GGUF tooling packet',
    url: 'https://github.com/ggml-org/llama.cpp',
    required_fields: ['conversion_recipe', 'metadata_mapping', 'hash_manifest', 'conformance_fixture'],
  },
  {
    id: 'hardware-partner',
    label: 'Hardware partner runtime target packet',
    url: 'https://opentelemetry.io/docs/specs/semconv/gen-ai/',
    required_fields: ['device_profile', 'runtime_target', 'latency_fixture', 'energy_fixture', 'attestation_fields'],
  },
];

export const RUNTIME_ADOPTION_REQUIRED_FILES = [
  'docs/runtime-adoption-packets.md',
  'docs/kolm-format-v1.md',
  'src/compute/registry.json',
  'src/quantization-oracle.js',
  'src/artifact-runner.js',
];

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function fileEvidence(root, rel) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    return { path: rel.replace(/\\/g, '/'), exists: false, sha256: null, bytes: 0 };
  }
  const text = fs.readFileSync(full, 'utf8');
  return {
    path: rel.replace(/\\/g, '/'),
    exists: true,
    sha256: sha256(text),
    bytes: Buffer.byteLength(text),
  };
}

function nonEmpty(value, min = 1) {
  return typeof value === 'string' && value.trim().length >= min;
}

function isHttpsUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

function validIsoDate(value) {
  return nonEmpty(value) && !Number.isNaN(Date.parse(value));
}

function validSha(value) {
  return typeof value === 'string' && SHA256_RE.test(value) && !/^(?:sha256:)?0{64}$/i.test(value);
}

function parseJsonFile(root, rel) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) return null;
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

function templateFor(target) {
  switch (target.id) {
    case 'huggingface-hub':
      return {
        files: ['README.md', 'artifact.kolm', 'manifest.json', 'receipt.json', 'evals/model-index.json'],
        command: 'kolm verify artifact.kolm && kolm inspect artifact.kolm --json',
      };
    case 'ollama':
      return {
        files: ['Modelfile', 'model.gguf', 'artifact.kolm', 'kolm.sidecar.json'],
        command: 'ollama create kolm-task -f Modelfile && kolm verify artifact.kolm',
      };
    case 'llama-cpp':
      return {
        files: ['model.gguf', 'kolm.sidecar.json', 'receipt.json'],
        command: 'llama-cli -m model.gguf -p "<input>" && kolm verify artifact.kolm',
      };
    case 'onnx-gguf-tooling':
      return {
        files: ['model.onnx', 'model.gguf', 'metadata-map.json', 'conformance.json'],
        command: 'kolm verify artifact.kolm && kolm export artifact.kolm --target gguf --preview',
      };
    default:
      return {
        files: ['artifact.kolm', 'device-profile.json', 'latency-report.json', 'energy-report.json'],
        command: 'kolm runtime doctor --target <device> --json',
      };
  }
}

export function runtimeAdoptionCatalog() {
  return {
    spec: RUNTIME_ADOPTION_SPEC,
    secret_values_included: false,
    requirement_ids: ['ecosystem-runtime-adoption'],
    required_files: RUNTIME_ADOPTION_REQUIRED_FILES.slice(),
    targets: RUNTIME_ADOPTION_TARGETS.map((target) => ({
      ...target,
      required_fields: target.required_fields.slice(),
      template: templateFor(target),
    })),
  };
}

export function runtimeAdoptionManifestTemplate() {
  return {
    spec: RUNTIME_ADOPTION_MANIFEST_SPEC,
    secret_values_included: false,
    generated_at: 'REPLACE_WITH_ISO_TIMESTAMP',
    targets: RUNTIME_ADOPTION_TARGETS.map((target) => ({
      id: target.id,
      status: 'REPLACE_WITH_merged_or_published',
      external_url: target.url,
      integration_ref: 'REPLACE_WITH_PR_COMMIT_PACKAGE_OR_MARKETPLACE_REF',
      adopted_at: 'REPLACE_WITH_ISO_TIMESTAMP',
      evidence_sha256: null,
      conformance_report_sha256: null,
      supported_artifact_subset: 'REPLACE_WITH_SUPPORTED_KOLM_ARTIFACT_SUBSET',
      implemented_fields: target.required_fields.slice(),
      maintainer_or_owner: 'REPLACE_WITH_EXTERNAL_OWNER',
    })),
  };
}

export function validateRuntimeAdoptionManifest(manifest = {}) {
  const failures = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) failures.push('manifest:must_be_object');
  if (manifest.spec !== RUNTIME_ADOPTION_MANIFEST_SPEC) failures.push(`spec:expected_${RUNTIME_ADOPTION_MANIFEST_SPEC}`);
  if (manifest.secret_values_included !== false) failures.push('secret_values_included:must_be_false');
  if (SECRET_VALUE_RE.test(JSON.stringify(manifest))) failures.push('secret_value_detected');
  if (!validIsoDate(manifest.generated_at)) failures.push('generated_at:invalid');
  if (!Array.isArray(manifest.targets)) failures.push('targets:missing_array');
  const rows = Array.isArray(manifest.targets) ? manifest.targets : [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      failures.push('target:must_be_object');
      continue;
    }
    const target = RUNTIME_ADOPTION_TARGETS.find((item) => item.id === row.id);
    if (!target) {
      failures.push(`${row.id || 'unknown'}:unknown_target`);
      continue;
    }
    if (seen.has(target.id)) failures.push(`${target.id}:duplicate_target`);
    seen.add(target.id);
    if (!['merged', 'published', 'accepted'].includes(row.status)) failures.push(`${target.id}:status_not_external_adoption_grade`);
    if (!isHttpsUrl(row.external_url)) failures.push(`${target.id}:external_url_https_required`);
    if (!nonEmpty(row.integration_ref, 8)) failures.push(`${target.id}:integration_ref_missing`);
    if (!validIsoDate(row.adopted_at)) failures.push(`${target.id}:adopted_at_invalid`);
    if (!validSha(row.evidence_sha256)) failures.push(`${target.id}:evidence_sha256_invalid`);
    if (!validSha(row.conformance_report_sha256)) failures.push(`${target.id}:conformance_report_sha256_invalid`);
    if (!nonEmpty(row.supported_artifact_subset, 20)) failures.push(`${target.id}:supported_artifact_subset_too_short`);
    if (!nonEmpty(row.maintainer_or_owner, 2)) failures.push(`${target.id}:maintainer_or_owner_missing`);
    if (!Array.isArray(row.implemented_fields)) {
      failures.push(`${target.id}:implemented_fields_missing`);
    } else {
      for (const field of target.required_fields) {
        if (!row.implemented_fields.includes(field)) failures.push(`${target.id}:implemented_field_missing:${field}`);
      }
    }
  }
  for (const target of RUNTIME_ADOPTION_TARGETS) {
    if (!seen.has(target.id)) failures.push(`${target.id}:target_missing`);
  }
  return {
    spec: RUNTIME_ADOPTION_MANIFEST_SPEC,
    ok: failures.length === 0,
    external_adoption_verified: failures.length === 0,
    secret_values_included: false,
    counts: {
      targets: rows.length,
      required_targets: RUNTIME_ADOPTION_TARGETS.length,
      complete_targets: failures.length === 0 ? RUNTIME_ADOPTION_TARGETS.length : 0,
      failures: failures.length,
    },
    failures,
  };
}

export function auditRuntimeAdoptionPackets(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const files = RUNTIME_ADOPTION_REQUIRED_FILES.map((rel) => fileEvidence(root, rel));
  const missing = files.filter((file) => !file.exists).map((file) => `${file.path}:missing`);
  const local_contract_ok = missing.length === 0;
  let adoption_manifest = null;
  let adoption_validation = null;
  try {
    adoption_manifest = parseJsonFile(root, 'reports/runtime-adoption-manifest.json')
      || parseJsonFile(root, 'docs/runtime-adoption-external-prs.json');
    adoption_validation = adoption_manifest ? validateRuntimeAdoptionManifest(adoption_manifest) : null;
  } catch (e) {
    adoption_validation = {
      spec: RUNTIME_ADOPTION_MANIFEST_SPEC,
      ok: false,
      external_adoption_verified: false,
      secret_values_included: false,
      counts: { targets: 0, required_targets: RUNTIME_ADOPTION_TARGETS.length, complete_targets: 0, failures: 1 },
      failures: [`runtime_adoption_manifest:invalid_json:${String(e.message || e)}`],
    };
  }
  const external_adoption_verified = Boolean(adoption_validation && adoption_validation.ok);
  const targets = RUNTIME_ADOPTION_TARGETS.map((target) => ({
    id: target.id,
    label: target.label,
    url: target.url,
    status: external_adoption_verified ? 'external_record_present' : 'packet_ready_external_adoption_missing',
    required_fields: target.required_fields.slice(),
    template: templateFor(target),
  }));
  const blockers = [
    ...missing,
    ...(external_adoption_verified ? [] : [
      ...(adoption_validation ? adoption_validation.failures : ['reports/runtime-adoption-manifest.json:missing']),
      ...targets.map((target) => `${target.id}:external_merge_or_package_missing`),
    ]),
  ];

  return {
    spec: RUNTIME_ADOPTION_SPEC,
    ok: local_contract_ok,
    local_contract_ok,
    external_adoption_verified,
    secret_values_included: false,
    external_adoption_manifest_present: Boolean(adoption_manifest),
    external_adoption_manifest_validation: adoption_validation,
    generated_at: new Date().toISOString(),
    counts: {
      targets: targets.length,
      required_files: files.length,
      present_files: files.filter((file) => file.exists).length,
      blockers: blockers.length,
    },
    files,
    targets,
    blockers,
    note: 'This packet makes external runtime integration work executable locally. It does not claim native third-party runtime support until external PRs or packages exist.',
  };
}

export default auditRuntimeAdoptionPackets;
