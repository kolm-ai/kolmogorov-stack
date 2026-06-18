#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'internal', 'artifact-matrix.json');
const SCHEMA = 'kolm.artifact_matrix.v1';
const UPDATED_AT = '2026-06-18';

const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const SUMMARY = args.has('--summary');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
  return out;
}

function stableStringify(value) {
  return JSON.stringify(stable(value), null, 2) + '\n';
}

function lineNumber(text, idx) {
  return text.slice(0, Math.max(0, idx)).split(/\r?\n/).length;
}

function extractExports(src) {
  return [...src.matchAll(/^export\s+(async\s+)?(function\*?|function|const|class)\s+([A-Za-z_$][\w$]*)/gm)]
    .map((m) => ({
      name: m[3],
      kind: m[2],
      async: !!m[1],
      line: lineNumber(src, m.index),
    }))
    .sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

function extractFunctions(src) {
  return [...src.matchAll(/^(export\s+)?(async\s+)?function\*?\s+([A-Za-z_$][\w$]*)\(/gm)]
    .map((m) => ({
      name: m[3],
      exported: !!m[1],
      async: !!m[2],
      line: lineNumber(src, m.index),
    }))
    .sort((a, b) => a.line - b.line);
}

function requiredExports() {
  return [
    'ARTIFACT_CLASSES',
    'decodePack',
    'decodeIndex',
    'buildRecipeBundleMjs',
    'computeKScore',
    'buildPayload',
    'packageArtifact',
    'buildAndZip',
    'verifyManifestSignature',
    'verifyDeviceFit',
    'HETEROGENEOUS_WEIGHTS_VERSION',
    'addHeterogeneousWeights',
  ];
}

function requiredTestEvidence() {
  return [
    'tests/cid.test.js',
    'tests/finalized-c1-provenance-receipt-transparency-chain.test.js',
    'tests/finalized-c5-fixes-regression.test.js',
    'tests/model-signing-sidecars.test.js',
    'tests/model-signing-build-sidecars.test.js',
    'tests/finalized-c7-artifact-provenance-repro.test.js',
    'tests/r5-evidence-dag.test.js',
    'tests/wave144-verifier-states.test.js',
    'tests/wave151-recipe-class.test.js',
    'tests/wave149-ed25519-default.test.js',
    'tests/wave150-sigstore.test.js',
    'tests/wave252-ml-fixes.test.js',
    'tests/wave367-recipe-bundle.test.js',
    'tests/wave457-artifact-runtime-consistency.test.js',
    'tests/wave721-tsac.test.js',
    'tests/wave722-itkv.test.js',
    'tests/wave726-bvl-kernels.test.js',
    'tests/wave829-multimodal-pipeline.test.js',
    'tests/wave948-artifact-matrix.test.js',
  ];
}

function extractEnvRefs(src) {
  return [...new Set([...src.matchAll(/\bprocess\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
}

function extractDestructuredFields(src, fnName) {
  const idx = src.indexOf(`function ${fnName}({`);
  if (idx < 0) return [];
  const start = src.indexOf('{', idx);
  let depth = 0;
  let end = -1;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return [];
  return src.slice(start + 1, end)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(':')[0].trim())
    .filter(Boolean)
    .sort();
}

function extractArtifactHashSlots(src) {
  const slots = new Set([
    'manifest_hash',
    'model_pointer_hash',
    'recipes_json_hash',
    'lora_bin_hash',
    'index_bin_hash',
    'evals_json_hash',
  ]);
  for (const m of src.matchAll(/\bartifact_hash_input\.([A-Za-z_$][\w$]*)\b/g)) {
    slots.add(m[1]);
  }
  return [...slots].sort();
}

function extractZipMembers(src) {
  const names = new Set();
  for (const m of src.matchAll(/filename:\s*'([^']+)'/g)) names.add(m[1]);
  for (const m of src.matchAll(/RESERVED_FILENAMES\s*=\s*new Set\(\[([^\]]+)\]/gm)) {
    for (const q of m[1].matchAll(/'([^']+)'/g)) names.add(q[1]);
  }
  return [...names].sort();
}

function phaseRows(src) {
  const defs = [
    ['sign_secret_resolution', 'requireSignSecret', ['effectiveReceiptSecret', 'requireSignSecret', 'RECIPE_RECEIPT_SECRET not set']],
    ['pack_index_container_codec', 'decodeContainer', ['PACK_MAGIC', 'INDEX_MAGIC', 'container magic mismatch', 'container length mismatch']],
    ['recipe_bundle_esm', 'buildRecipeBundleMjs', ['buildRecipeBundleMjs', 'export default async function run', 'RECIPES']],
    ['reproducible_build_context', 'reproducibleBuildContext', ['KOLM_SOURCE_DATE_EPOCH', 'SOURCE_DATE_EPOCH', 'source_date_epoch', 'zipDate']],
    ['deterministic_receipt_id', 'deterministicReceiptId', ['deterministicReceiptId', 'rcpt_', 'artifact_hash']],
    ['kscore_conformal_gate', 'conformalBoundedGate', ['KOLM_KSCORE_CONFORMAL', 'conformalBoundedGate', 'fail-closed']],
    ['contamination_impact_gate', 'contamination_impact_block', ['KOLM_KSCORE_CONTAM_IMPACT', 'contamination_impact_block', 'corrected_below_gate']],
    ['artifact_class_rollup', 'rollupArtifactClass', ['rollupArtifactClass', 'validateArtifactClass', 'artifact_class_breakdown']],
    ['capability_lineage_workflow_validation', 'validateCapability', ['validateCapability', 'validateLineage', 'workflow_ir hash mismatch']],
    ['export_moe_pretokenize_validation', 'validateExportBlock', ['validateExportBlock', 'validateMoeBlock', 'validatePretokenizeBlock']],
    ['runtime_passports', 'validateRuntimePassports', ['validateRuntimePassports', 'RUNTIME_PASSPORT_SCHEMA_VERSION', 'runtime_passports_spec_version']],
    ['evidence_dag', 'validateEvidenceDagInput', ['validateEvidenceDagInput', 'evidenceDagToJSON', 'EVIDENCE_DAG_SCHEMA_VERSION']],
    ['output_schema_guardrails', 'validateOutputSchemaSpec', ['validateOutputSchemaSpec', 'validateGuardrailRulesW736', 'guardrails_hash']],
    ['parent_region_sustainability', 'parent_cid', ['parent_cid', 'region_hash', 'sustainability_badge']],
    ['recipe_source_type_validation', 'validateRecipeSourceType', ['validateRecipeSourceType', 'inferSourceType', 'source_type']],
    ['model_weights_runtime_target', 'model_weights', ['model_weights.filename', 'runtime_target_config', 'requires model_weights']],
    ['seed_provenance_honesty', 'seed_provenance_block', ['seed_provenance_block', "eval_source: 'self_generated'", 'production_ready']],
    ['compiled_targets_manifest', 'compiled_targets_block', ['compiled_targets_block', 'compiled_target_files', 'target_toolchain_pin']],
    ['manifest_core_fields', 'const manifest =', ['const manifest =', 'runtime_target', 'artifact_class', 'hashes']],
    ['artifact_hash_chain_slots', 'artifact_hash_input', ['artifact_hash_input', 'manifest_hash', 'model_weights_hash', 'region_hash']],
    ['receipt_hmac_chain', 'stepSeal', ['stepSeal', "stepSeal('task'", "stepSeal('package'"]],
    ['receipt_auditor_fields', 'eventSourceHashes', ['event_source_hashes', 'dataset_hash', 'build_toolchain']],
    ['ed25519_sigstore_signing', 'loadEd25519DefaultSigner', ['loadEd25519DefaultSigner', 'signature_alg', 'buildSigstoreBundle']],
    ['legacy_signature_sig', 'signature.sig', ['signature.sig', 'HMAC-SHA256', 'verifyManifestSignature']],
    ['credential_sidecar', 'buildArtifactCredential', ['buildArtifactCredential', 'credential.json', 'artifact_hash']],
    ['file_layout_reserved_slots', 'RESERVED_FILENAMES', ['RESERVED_FILENAMES', 'manifest.json', 'recipe.bundle.mjs']],
    ['model_signing_sidecars', 'emitArtifactAttestation', ['provenance.intoto.dsse.json', 'model.sig.bundle', 'toOmsArtifactManifest']],
    ['zip_packaging_stream', 'packageArtifact', ['archiver', 'fs.createReadStream', 'z.finalize()']],
    ['two_pass_kscore_zip', 'buildAndZip', ['Pass 1', 'probeBytes', 'Pass 2']],
    ['outpath_preflight_cleanup', 'cleanupOnFail', ['fs.openSync(outPath, \'w\')', 'cleanupOnFail', 'fs.unlinkSync(p)']],
    ['rekor_pinning_policy', 'attestArtifactWithRekor', ['attestArtifactWithRekor', 'requiresRekor', 'rekor_log_entry']],
    ['manifest_signature_verify', 'verifyManifestSignature', ['verificationSecrets', 'constantTimeEqualHex', 'hmac mismatch']],
    ['device_fit', 'verifyDeviceFit', ['verifyDeviceFit', './devices.js', 'vram_gb']],
    ['heterogeneous_weights', 'addHeterogeneousWeights', ['addHeterogeneousWeights', 'HETEROGENEOUS_WEIGHTS_VERSION', 'present_modalities']],
    ['large_file_hashing', 'sha256File', ['sha256File', 'digestFilePair', 'CHUNK']],
  ];
  return defs.map(([phase, owner, evidence]) => ({
    phase,
    owner,
    present: evidence.every((needle) => src.includes(needle)),
    line: lineNumber(src, src.indexOf(owner)),
    evidence,
  }));
}

function directTestEvidence() {
  const dir = path.join(ROOT, 'tests');
  const symbols = requiredExports();
  const rows = [];
  for (const name of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
    const rel = `tests/${name}`;
    const body = read(rel);
    const sourceLock = body.includes('src/artifact.js') || body.includes('../src/artifact.js') || body.includes('artifact.js');
    const counts = {};
    for (const sym of symbols) counts[`${sym}_refs`] = (body.match(new RegExp(`\\b${sym}\\b`, 'g')) || []).length;
    const totalSymbolRefs = Object.values(counts).reduce((sum, n) => sum + n, 0);
    const artifactWorkflowRefs = (body.match(/\bbuildPayload\b|\bbuildAndZip\b|\bartifact_hash\b|\breceipt\.json\b|\bsignature\.sig\b|\bmodel\.sig\.bundle\b|\bprovenance\.intoto\.dsse\.json\b|\bruntime_target\b|\brecipe\.bundle\.mjs\b|\bsource_date_epoch\b|\bguardrails\b|\boutput_schema\b|\bkv_profile\b|\bsparsity_profile\b|\bmodel_weights\b|\bheterogeneous_weights\b/gi) || []).length;
    if (!sourceLock && !totalSymbolRefs && !artifactWorkflowRefs) continue;
    rows.push({
      path: rel,
      source_lock: sourceLock,
      total_symbol_refs: totalSymbolRefs,
      artifact_workflow_refs: artifactWorkflowRefs,
      ...counts,
    });
  }
  return rows;
}

function safetyGuards(src, mod, exports, envRefs, buildPayloadFields, buildAndZipFields, hashSlots, zipMembers, phases, tests, requiredTests) {
  const exportSet = new Set(exports.map((row) => row.name));
  const envSet = new Set(envRefs);
  const payloadSet = new Set(buildPayloadFields);
  const zipSet = new Set(zipMembers);
  const hashSet = new Set(hashSlots);
  const evidenceSet = new Set(tests.map((row) => row.path));
  const missingTests = requiredTests.filter((rel) => !evidenceSet.has(rel));
  const classIdx = src.indexOf('const classCheck = validateArtifactClass(manifest)');
  const manifestJsonIdx = src.indexOf('const manifest_json = JSON.stringify(manifest');
  const filesIdx = src.indexOf('const files = [');
  const sidecarIdx = src.indexOf('Model-signing sidecars', filesIdx);
  return {
    required_public_exports_present: requiredExports().every((name) => exportSet.has(name) && mod[name] != null),
    artifact_classes_match_recipe_classes: Array.isArray(mod.ARTIFACT_CLASSES) && ['rule', 'synthesized_rule', 'compiled_rule', 'distilled_model'].every((name) => mod.ARTIFACT_CLASSES.includes(name)),
    heterogeneous_weights_version_current: mod.HETEROGENEOUS_WEIGHTS_VERSION === 'w829-v1',
    env_surface_is_named: ['KOLM_SOURCE_DATE_EPOCH', 'SOURCE_DATE_EPOCH', 'KOLM_REPRODUCIBLE_BUILD', 'KOLM_KSCORE_CONFORMAL', 'KOLM_KSCORE_CONTAM_IMPACT', 'KOLM_JUDGE_ID', 'KOLM_ED25519_DISABLE', 'KOLM_POLICY_OPT_OUT', 'KOLM_REKOR_REQUIRE'].every((name) => envSet.has(name)),
    payload_field_surface_is_frontier_complete: buildPayloadFields.length >= 55 && ['runtime_passports', 'evidence_dag', 'speculative_decoding', 'prompt_cache', 'continuous_batching', 'model_weights', 'output_schema', 'guardrails', 'parent_cid', 'region'].every((name) => payloadSet.has(name)),
    build_and_zip_threads_frontier_blocks: buildAndZipFields.length >= 45 && ['runtime_passports', 'speculative_decoding', 'prompt_cache', 'continuous_batching', 'model_weights', 'guardrails', 'parent_cid', 'region'].every((name) => buildAndZipFields.includes(name)),
    pack_index_codecs_validate_magic_and_length: src.includes('PACK_MAGIC') && src.includes('INDEX_MAGIC') && src.includes('container magic mismatch') && src.includes('container length mismatch'),
    sign_secret_is_required_and_503s: src.includes('requireSignSecret') && src.includes("e.statusCode = 503") && src.includes('RECIPE_RECEIPT_SECRET not set'),
    reproducible_build_uses_source_date_epoch_and_sorted_zip_entries: src.includes('KOLM_SOURCE_DATE_EPOCH') && src.includes('SOURCE_DATE_EPOCH') && src.includes('payload.files.slice().sort') && src.includes('date: zipDate'),
    artifact_class_validated_before_signing: classIdx >= 0 && manifestJsonIdx > classIdx && src.includes('artifact class validation failed'),
    kscore_gate_is_fail_closed_with_explicit_override: src.includes('k_score below ship gate') && src.includes('allow_below_gate=true') && src.includes('ship_gate_overridden'),
    conformal_and_contamination_overlays_are_stricter_only: src.includes('conformalBoundedGate') && src.includes('harness_error') && src.includes('Math.min(reportedA, cleanA)') && src.includes('corrected_below_gate'),
    operational_fingerprints_do_not_gain_hash_authority: src.includes('runtime_passports') && src.includes('OPERATIONAL') && src.includes('NOT bound into artifact_hash_input') && src.includes('speculative_decoding') && src.includes('prompt_cache') && src.includes('continuous_batching'),
    runtime_weight_targets_fail_closed: src.includes('requires model_weights={filename,content:Buffer}') && src.includes('does not match declared path') && src.includes("['gguf', 'onnx', 'wasm', 'native']"),
    reserved_file_names_block_shadowing: src.includes('RESERVED_FILENAMES') && src.includes('filename') && src.includes('is reserved') && zipSet.has('manifest.json') && zipSet.has('receipt.json'),
    artifact_hash_binds_core_and_frontier_slots: ['manifest_hash', 'recipes_json_hash', 'export_hash', 'moe_hash', 'pretokenize_hash', 'external_holdout_hash', 'tenant_shadow_corpus_hash', 'auditor_attestation_hash', 'supersession_hash', 'drift_report_hash', 'contamination_impact_hash', 'workflow_ir_hash', 'confidential_compute_hash', 'mixed_precision_profile_hash', 'mixed_precision_proof_hash', 'importance_signal_hash', 'calibration_provenance_hash', 'sparsity_profile_hash', 'kv_profile_hash', 'output_schema_hash', 'guardrails_hash', 'region_hash', 'recipe_bundle_mjs_hash', 'model_weights_hash'].every((name) => hashSet.has(name)),
    receipt_chain_has_five_named_steps: ["stepSeal('task'", "stepSeal('seeds'", "stepSeal('recipes'", "stepSeal('evals'", "stepSeal('package'"].every((needle) => src.includes(needle)),
    receipt_auditor_fields_are_signed_inside_body: src.includes('event_source_hashes') && src.includes('dataset_hash') && src.includes('artifact_files') && src.includes('build_toolchain') && src.includes('signature_ed25519'),
    signature_stack_layers_hmac_ed25519_sigstore: src.includes('hmac-sha256') && src.includes('ed25519+hmac-sha256') && src.includes('sigstore+ed25519+hmac-sha256') && src.includes('buildSigstoreBundle'),
    model_signing_sidecars_seal_real_member_bytes: sidecarIdx > filesIdx && src.includes('SEAL_FILES') && src.includes('digestFilePair') && src.includes('subjectDigests: memberDigests') && src.includes('toOmsArtifactManifest(memberList'),
    zip_packaging_streams_abs_path_entries: src.includes('fs.createReadStream(f.absPath)') && src.includes('archiver(\'zip\'') && src.includes('z.finalize()'),
    build_cleanup_prevents_partial_artifacts: src.includes('cleanupOnFail.push(outPath)') && src.includes('if (!success)') && src.includes('fs.unlinkSync(p)'),
    rekor_required_policy_fails_closed: src.includes('policy.require_rekor=true') && src.includes('KOLM_SIGSTORE_REKOR_URL is unset') && src.includes('Rekor pinning failed'),
    verify_manifest_signature_uses_candidates_and_constant_time_compare: src.includes('verificationSecrets') && src.includes('constantTimeEqualHex') && src.includes('hmac mismatch'),
    heterogeneous_weight_helper_rejects_path_traversal_and_unknown_kinds: src.includes('VISION_ENCODER_KINDS') && src.includes('TOOL_USE_HEAD_KINDS') && src.includes('filename.includes(\'..\')'),
    all_expected_phase_rows_present: phases.every((row) => row.present),
    direct_evidence_covers_required_tests: missingTests.length === 0,
  };
}

async function buildMatrix() {
  const src = read('src/artifact.js');
  const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'artifact.js')).href + `?matrix=${Date.now()}`);
  const exports = extractExports(src);
  const functions = extractFunctions(src);
  const exportNames = new Set(exports.map((row) => row.name));
  const missingRequiredExports = requiredExports().filter((name) => !exportNames.has(name));
  const envRefs = extractEnvRefs(src);
  const buildPayloadFields = extractDestructuredFields(src, 'buildPayload');
  const buildAndZipFields = extractDestructuredFields(src, 'buildAndZip');
  const hashSlots = extractArtifactHashSlots(src);
  const zipMembers = extractZipMembers(src);
  const phases = phaseRows(src);
  const tests = directTestEvidence();
  const requiredTests = requiredTestEvidence();
  const evidenceSet = new Set(tests.map((row) => row.path));
  const missingTests = requiredTests.filter((rel) => !evidenceSet.has(rel));
  const guards = safetyGuards(src, mod, exports, envRefs, buildPayloadFields, buildAndZipFields, hashSlots, zipMembers, phases, tests, requiredTests);
  const failedGuards = Object.entries(guards).filter(([, ok]) => !ok).map(([name]) => name);

  const summary = {
    artifact_bytes: Buffer.byteLength(src),
    artifact_lines: src.split(/\r?\n/).length,
    export_count: exports.length,
    function_count: functions.length,
    env_ref_count: envRefs.length,
    build_payload_field_count: buildPayloadFields.length,
    build_and_zip_field_count: buildAndZipFields.length,
    artifact_hash_slot_count: hashSlots.length,
    zip_member_name_count: zipMembers.length,
    phase_count: phases.length,
    present_phase_count: phases.filter((row) => row.present).length,
    required_test_evidence_count: requiredTests.length,
    direct_test_evidence_count: tests.length,
    missing_required_exports: missingRequiredExports.length,
    failed_safety_guards: failedGuards.length,
    missing_test_evidence: missingTests.length,
  };

  const failures = [];
  if (missingRequiredExports.length) failures.push({ gate: 'required_exports', missing: missingRequiredExports });
  if (summary.build_payload_field_count < 55) failures.push({ gate: 'build_payload_fields', count: summary.build_payload_field_count });
  if (summary.build_and_zip_field_count < 45) failures.push({ gate: 'build_and_zip_fields', count: summary.build_and_zip_field_count });
  if (summary.artifact_hash_slot_count < 25) failures.push({ gate: 'artifact_hash_slots', count: summary.artifact_hash_slot_count });
  if (summary.present_phase_count !== summary.phase_count) failures.push({ gate: 'artifact_phases', missing: phases.filter((row) => !row.present).map((row) => row.phase) });
  if (failedGuards.length) failures.push({ gate: 'artifact_safety_guards', guards: failedGuards });
  if (missingTests.length) failures.push({ gate: 'test_evidence', missing: missingTests });

  return {
    schema: SCHEMA,
    updated_at: UPDATED_AT,
    purpose: 'Generated contract matrix for src/artifact.js: signed .kolm payloads, manifest/hash-chain slots, receipt/signature sidecars, ZIP packaging, runtime-target honesty, model weights, frontier provenance blocks, reproducible builds, and direct evidence coverage.',
    sources: [
      'src/artifact.js',
      'src/cid.js',
      'src/provenance.js',
      'src/artifact-lineage.js',
      'src/runtime-passport.js',
      'src/evidence-dag.js',
      'src/export-provenance.js',
      'src/moe-provenance.js',
      'src/pretokenize-provenance.js',
      'src/intoto-slsa.js',
      'src/intoto-receipt.js',
      'src/sigstore.js',
      'src/output-schema.js',
      'src/guardrails.js',
      ...requiredTests,
    ],
    summary,
    exports,
    required_exports: requiredExports(),
    missing_required_exports: missingRequiredExports,
    functions,
    env_refs: envRefs,
    build_payload_fields: buildPayloadFields,
    build_and_zip_fields: buildAndZipFields,
    artifact_hash_slots: hashSlots,
    zip_member_names: zipMembers,
    artifact_phases: phases,
    public_return_shapes: {
      buildPayload: ['manifest', 'receipt', 'credential', 'artifact_hash', 'cid', 'eval_set_hash', 'files'],
      buildAndZip: ['outPath', 'manifest', 'receipt', 'credential', 'artifact_hash', 'cid', 'eval_set_hash', 'bytes', 'k_score', 'rekor_attestation'],
      verifyManifestSignature: ['valid', 'reason'],
      verifyDeviceFit: ['ok', 'reason', 'soft'],
      addHeterogeneousWeights: ['files', 'manifest.heterogeneous_weights'],
    },
    safety_guards: guards,
    failed_safety_guards: failedGuards,
    required_test_evidence: requiredTests,
    test_evidence: tests,
    gates: {
      ok: failures.length === 0,
      failures,
      warnings: [],
    },
  };
}

async function main() {
  const matrix = await buildMatrix();
  const body = stableStringify(matrix);

  if (CHECK) {
    const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (existing !== body) {
      console.error('artifact-matrix: docs/internal/artifact-matrix.json is out of date');
      process.exit(1);
    }
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, body);
  }

  if (SUMMARY) {
    console.log(JSON.stringify({
      ok: matrix.gates.ok,
      schema: matrix.schema,
      summary: matrix.summary,
      failures: matrix.gates.failures,
      warnings: matrix.gates.warnings,
    }, null, 2));
  } else if (!CHECK) {
    console.log(`artifact-matrix: wrote ${path.relative(ROOT, OUT)} phases=${matrix.summary.present_phase_count}/${matrix.summary.phase_count} hash_slots=${matrix.summary.artifact_hash_slot_count}`);
  }

  if (!matrix.gates.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
