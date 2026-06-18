#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'internal', 'spec-compile-matrix.json');
const SCHEMA = 'kolm.spec_compile_matrix.v1';
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
  const rows = [...src.matchAll(/^export\s+(async\s+)?(function\*?|function|const|class)\s+([A-Za-z_$][\w$]*)/gm)]
    .map((m) => ({
      name: m[3],
      kind: m[2],
      async: !!m[1],
      line: lineNumber(src, m.index),
    }));
  for (const m of src.matchAll(/^export\s+\{\s*([^}]+?)\s*\}\s+from\s+['"]([^'"]+)['"]/gm)) {
    for (const part of m[1].split(',')) {
      const token = part.trim();
      if (!token) continue;
      const alias = token.split(/\s+as\s+/i).pop().trim();
      rows.push({
        name: alias,
        kind: 're-export',
        async: false,
        line: lineNumber(src, m.index),
        from: m[2],
      });
    }
  }
  return rows.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
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
    'validateSpec',
    'compileSpec',
    'compilePipeline',
  ];
}

function requiredTestEvidence() {
  return [
    'tests/wave144-dsl-codegen.test.js',
    'tests/wave144-seeds-gate.test.js',
    'tests/wave144-tokenizer-artifact.test.js',
    'tests/wave282-compile-routing.test.js',
    'tests/wave345-eval-bench-parity.test.js',
    'tests/wave350-probe-cleanup.test.js',
    'tests/wave409q-c-rust-wasm-verify.test.js',
    'tests/wave457-build-honors-out.test.js',
    'tests/wave460-attestation-embed.test.js',
    'tests/wave470-native-target-completion.test.js',
    'tests/wave690-pipeline-runner-contract.test.js',
    'tests/wave708-vertical-disclaimer.test.js',
    'tests/wave726-bvl-kernels.test.js',
    'tests/finalized-c4-speculative-decoding-acceptance-eval-harness.test.js',
    'tests/wave946-spec-compile-matrix.test.js',
  ];
}

function extractCompileOptions(src) {
  return [...new Set([...src.matchAll(/\bopts\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))].sort();
}

function extractEnvRefs(src) {
  return [...new Set([...src.matchAll(/\bprocess\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
}

function extractBuildAndZipFields(src) {
  const call = src.indexOf('const built = await buildAndZip({');
  if (call < 0) return [];
  const start = src.indexOf('{', call);
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
  const body = src.slice(start + 1, end);
  const fields = [];
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^\s{4}([A-Za-z_$][\w$]*)(?::|,|\s*\/\/)/);
    if (m) fields.push(m[1]);
  }
  return [...new Set(fields)].sort();
}

function validationRules(src) {
  const defs = [
    ['spec_object', ['spec must be a JSON object', 'Array.isArray(spec)']],
    ['job_id_nonempty_and_regex', ['spec.job_id must be a non-empty string', '/^job_[a-z0-9_-]+$/i']],
    ['task_nonempty', ['spec.task must be a non-empty string']],
    ['recipes_nonempty_array', ['spec.recipes must be a non-empty array']],
    ['recipe_id_and_name_required', ['every recipe needs an id', 'name is required']],
    ['recipe_source_or_dsl_required', ['needs either source', 'or dsl']],
    ['compiled_rule_requires_dsl', ["artifact_class='compiled_rule' requires a dsl block"]],
    ['dsl_validated_for_native_targets', ['validateDsl(r.dsl', "targets: compiledRule ? ['c', 'rust'] : []"]],
    ['source_compiles_before_build', ['compileJs(r.source)', 'source failed to compile']],
    ['evals_shape_checked', ['spec.evals must be an object when present', 'spec.evals.cases must be an array']],
  ];
  return defs.map(([rule, evidence]) => ({
    rule,
    present: evidence.every((needle) => src.includes(needle)),
    evidence,
  }));
}

function phaseRows(src) {
  const defs = [
    ['spec_validation', 'validateSpec', ['validateSpec(spec)', 'KOLM_E_SPEC_INVALID']],
    ['workload_profile_validation', 'compileSpec', ['KOLM_WORKLOAD_PROFILE', "workload_profile must be one of 'latency' | 'batching' | 'auto'"]],
    ['receipt_secret_resolution', 'ensurePerUserSecret', ['ensurePerUserSecret()', 'chmodSync(cfg, 0o600)']],
    ['recipe_normalization', 'compileSpec', ['emitJs(r.dsl)', 'source_hash', 'version_id']],
    ['comparator_selection', 'compileSpec', ['SUPPORTED_COMPARATORS', 'comparatorName']],
    ['seed_gate', 'prepareSeedSplit', ['prepareSeedSplit({', 'allowEmptyEvals', 'no seeds provided']],
    ['measured_eval', 'verifyRecipe', ['verifyRecipe(generator', 'pass_rate_positive_measured', 'evals_report']],
    ['seed_provenance', 'computeSeedProductionReady', ['computeSeedProductionReady(seedSplit)', 'leakage_report_hash', 'synthesis_input_hash']],
    ['dsl_native_sources', 'emitCompiledTargets', ["artifactClass === 'compiled_rule'", 'emitCompiledTargets', 'getSourceFileEntries']],
    ['native_wasm_compile', 'compileNativeTargets', ['compileNativeTargets(compiled_targets', 'targetLc', 'compileWasm']],
    ['tokenizer_packaging', 'tokenizerPath', ['opts.tokenizerPath', 'tokenizer.json', 'extraFiles']],
    ['distill_lineage', 'loadDistillProvenance', ['loadDistillProvenance', 'teacher_holdout_accuracy', 'lineageBlock']],
    ['export_runtime_passports', 'loadExportProvenance', ['loadExportProvenance', 'estimatePassport', 'runtimePassports']],
    ['moe_pretokenize_provenance', 'loadMoeProvenance', ['loadMoeProvenance', 'loadPretokenizeProvenance', 'pretokenize_block']],
    ['external_holdouts', 'buildExternalHoldoutBlock', ['loadHoldouts', 'buildExternalHoldoutBlock', 'external_holdout_summary']],
    ['tenant_shadow_corpus', 'buildTenantShadowBlock', ['loadTenantCorpus', 'buildTenantShadowBlock', 'tenant_shadow_summary']],
    ['auditor_attestation', 'crossCheckAuditorAttestation', ['loadAuditorAttestationFile', 'crossCheckAuditorAttestation', 'auditor_attestation']],
    ['supersession_drift', 'buildSupersessionBlock', ['buildSupersessionBlock', 'loadDriftReport', 'validateDriftReport']],
    ['compiled_binary_honesty', 'buildBinariesArray', ['buildBinariesArray', 'compiled_binary', 'native_skip_reasons']],
    ['confidential_compute_attestation', 'attestation_report', ['attestation_report', 'attestation_kind', 'supplied without an attestation kind']],
    ['speculative_decoding_resolution', 'resolveSpeculative', ['KOLM_COMPILE_SPECULATIVE_DRAFT', 'resolveSpeculative', 'speculative_decoding']],
    ['speculative_decoding_eval', 'evalSpeculativeDecoding', ['KOLM_SPECEVAL_RUNTIME', 'evalSpeculativeDecoding', 'eval_skipped_reason']],
    ['inference_fingerprints', 'promptCacheBlock', ['KOLM_COMPILE_PROMPT_CACHE', 'KOLM_COMPILE_MAX_BATCH', 'continuous_batching']],
    ['build_and_zip', 'buildAndZip', ['buildAndZip({', 'allow_below_gate', 'runtime_passports']],
    ['post_build_cleanup', 'postBuildCleanup', ['postBuildCleanup', 'fs.unlinkSync(p)', 'postBuildOk']],
    ['vertical_disclaimer', 'disclaimer_injection', ['VERTICAL_DISCLAIMER_ADJECTIVE', 'disclaimer_injection', 'professional ${adj} advice']],
    ['workload_profile_zip_patch', 'AdmZip', ['AdmZip', 'workload_profile_hash', 'createHmac']],
    ['chunked_hash', 'fs.readSync', ['CHUNK = 1024 * 1024', 'fs.readSync', 'h.digest']],
    ['return_envelope', 'return {', ['outPath: final', 'evals_report', 'tenant_shadow_corpus_provenance']],
    ['pipeline_reexport', 'compilePipeline', ["export { compilePipeline } from './pipeline-runner.js'"]],
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
  const symbols = ['validateSpec', 'compileSpec', 'compilePipeline'];
  const rows = [];
  for (const name of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
    const rel = `tests/${name}`;
    const body = read(rel);
    const sourceLock = body.includes('src/spec-compile.js') || body.includes('../src/spec-compile.js') || body.includes('spec-compile');
    const counts = {};
    for (const sym of symbols) counts[`${sym}_refs`] = (body.match(new RegExp(`\\b${sym}\\b`, 'g')) || []).length;
    const totalSymbolRefs = Object.values(counts).reduce((sum, n) => sum + n, 0);
    const compileWorkflowRefs = (body.match(/\bcompiled_rule\b|\bseed_provenance\b|\bexternal_holdout\b|\btenant_shadow\b|\baudit(or)?_attestation\b|\battestation_report\b|\bworkload_profile\b|\bspeculative_decoding\b/g) || []).length;
    if (!sourceLock && !totalSymbolRefs && !compileWorkflowRefs) continue;
    rows.push({
      path: rel,
      source_lock: sourceLock,
      total_symbol_refs: totalSymbolRefs,
      compile_workflow_refs: compileWorkflowRefs,
      ...counts,
    });
  }
  return rows;
}

function safetyGuards(src, mod, exports, options, envRefs, buildFields, validations, phases, tests, requiredTests) {
  const exportSet = new Set(exports.map((row) => row.name));
  const optionSet = new Set(options);
  const envSet = new Set(envRefs);
  const fieldSet = new Set(buildFields);
  const validationOk = validations.every((row) => row.present);
  const phaseOk = phases.every((row) => row.present);
  const evidenceSet = new Set(tests.map((row) => row.path));
  const missingTests = requiredTests.filter((rel) => !evidenceSet.has(rel));
  const buildIdx = src.indexOf('const built = await buildAndZip({');
  const cleanupIdx = src.indexOf('const postBuildCleanup');
  const workloadIdx = src.indexOf('if (opts.workload_profile != null && opts.workload_profile !== \'auto\')');
  const signatureIdx = src.indexOf('sigObj.hmac = crypto.createHmac', workloadIdx);
  const specEvalIdx = src.indexOf('if (speculativeDecodingBlock && process.env.KOLM_SPECEVAL_RUNTIME)');
  const specEvalCatchIdx = src.indexOf('speculative-decoding eval skipped', specEvalIdx);
  return {
    required_public_exports_present: requiredExports().every((name) => exportSet.has(name) && typeof mod[name] === 'function'),
    validation_rules_are_complete: validationOk,
    invalid_specs_use_kolm_error_code: src.includes("e.code = 'KOLM_E_SPEC_INVALID'") && src.includes('throw err('),
    compile_options_cover_current_surface: options.length >= 35 && ['seedsPath', 'allowEmptyEvals', 'target', 'compileNative', 'compileWasm', 'exportProvenancePath', 'moeProvenancePath', 'pretokenizeProvenancePath', 'externalHoldouts', 'tenantShadowCorpora', 'auditorAttestations', 'attestation_report', 'workload_profile'].every((name) => optionSet.has(name)),
    env_fingerprints_cover_compile_runtime_knobs: ['RECIPE_RECEIPT_SECRET', 'KOLM_ARTIFACT_SECRET', 'KOLM_WORKLOAD_PROFILE', 'KOLM_COMPILE_NATIVE', 'KOLM_COMPILE_WASM', 'KOLM_COMPILE_SPECULATIVE_DRAFT', 'KOLM_SPECEVAL_RUNTIME', 'KOLM_COMPILE_PROMPT_CACHE', 'KOLM_COMPILE_MAX_BATCH'].every((name) => envSet.has(name)),
    no_empty_eval_default_ships_without_opt_in: src.includes('inlineCases.length === 0') && src.includes('opts.allowEmptyEvals !== true') && src.includes('no seeds provided'),
    seed_gate_scores_holdout_not_train: src.includes('seedSplit.holdout.map') && src.includes("source: 'seeds.jsonl holdout'") && src.includes("eval_split: seedSplit ? 'holdout' : 'inline'"),
    production_ready_uses_shared_gate: src.includes("from './production-ready.js'") && src.includes('computeSeedProductionReady(seedSplit)'),
    comparator_declared_and_measured: src.includes('SUPPORTED_COMPARATORS.includes(comparatorName)') && src.includes('scoreHoldout(') && src.includes('training_stats.pass_rate_positive = measured.pass_rate_positive'),
    compiled_rule_requires_dsl_before_codegen: src.indexOf("artifact_class='compiled_rule' requires a dsl block") < src.indexOf('const t = emitCompiledTargets'),
    native_target_truthful_binary_verdict: src.includes('buildBinariesArray') && fieldSet.has('binaries') && fieldSet.has('compiled_binary') && fieldSet.has('native_skip_reasons'),
    source_aliases_bound_into_extra_files: src.includes('getSourceFileEntries') && src.includes("extraFiles = [...(extraFiles || []), ...compiled_targets._src_entries]"),
    large_export_files_streamed_by_abs_path: src.includes('Pass absPath instead of buffering') && src.includes('exportFiles.push({ filename: f.filename, absPath: f.absPath })'),
    build_and_zip_receives_all_frontier_blocks: ['compiled_targets', 'binaries', 'extra_files', 'lineage', 'export', 'moe', 'pretokenize', 'external_holdout', 'tenant_shadow_corpus', 'auditor_attestation', 'supersession', 'drift_report', 'attestation_report', 'runtime_passports', 'speculative_decoding', 'prompt_cache', 'continuous_batching'].every((name) => fieldSet.has(name)),
    out_path_passed_to_build_and_zip_directly: buildIdx >= 0 && src.includes('outPath: opts.outPath || undefined') && src.includes('writing artifact to: ${opts.outPath}'),
    post_build_failures_cleanup_artifacts: cleanupIdx > buildIdx && src.includes('postBuildCleanup.push(final)') && src.includes('if (!postBuildOk)') && src.includes('fs.unlinkSync(p)'),
    auditor_attestation_cross_check_after_artifact_hash: cleanupIdx > buildIdx && src.includes('__artifact_hash: built.artifact_hash') && src.includes('crossCheckAuditorAttestation(auditorAttestationBlocks[i], crossManifest)'),
    confidential_attestation_requires_kind: src.includes('if (!attestationReportObj._kind && !attestationReportObj.kind)') && src.includes('supplied without an attestation kind'),
    workload_profile_invalid_rejected_early: src.indexOf('workload_profile must be one of') < src.indexOf('ensurePerUserSecret();'),
    workload_profile_patch_resigns_manifest: workloadIdx > buildIdx && signatureIdx > workloadIdx && src.includes('sigObj.manifest_hash = newManifestHash'),
    speculative_resolution_never_breaks_build: src.includes('Speculative is a speed optimization') && src.includes('speculative decoding resolution skipped'),
    speculative_eval_fail_loud_keeps_null_block: specEvalIdx >= 0 && specEvalCatchIdx > specEvalIdx && src.includes('eval_skipped_reason') && src.includes('speculative-decoding eval did not produce measured numbers'),
    prompt_cache_and_batching_are_env_fingerprints: src.includes('KOLM_COMPILE_PROMPT_CACHE') && src.includes('method: \'prompt_cache\'') && src.includes('KOLM_COMPILE_MAX_BATCH') && src.includes('method: \'continuous_batching\''),
    high_risk_vertical_disclaimer_is_in_memory_only: src.includes('built.manifest.disclaimer_injection') && src.includes('is not hash-bound into artifact_hash'),
    chunked_final_hash_handles_large_artifacts: src.includes("const CHUNK = 1024 * 1024") && src.includes('fs.readSync(fd, buf, 0, CHUNK, null)'),
    compile_pipeline_reexport_uses_runner_owner: src.includes("export { compilePipeline } from './pipeline-runner.js'") && typeof mod.compilePipeline === 'function',
    all_expected_phase_rows_present: phaseOk,
    direct_evidence_covers_required_tests: missingTests.length === 0,
  };
}

async function buildMatrix() {
  const src = read('src/spec-compile.js');
  const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'spec-compile.js')).href + `?matrix=${Date.now()}`);
  const exports = extractExports(src);
  const functions = extractFunctions(src);
  const exportNames = new Set(exports.map((row) => row.name));
  const missingRequiredExports = requiredExports().filter((name) => !exportNames.has(name));
  const options = extractCompileOptions(src);
  const envRefs = extractEnvRefs(src);
  const buildFields = extractBuildAndZipFields(src);
  const validations = validationRules(src);
  const phases = phaseRows(src);
  const tests = directTestEvidence();
  const requiredTests = requiredTestEvidence();
  const evidenceSet = new Set(tests.map((row) => row.path));
  const missingTests = requiredTests.filter((rel) => !evidenceSet.has(rel));
  const guards = safetyGuards(src, mod, exports, options, envRefs, buildFields, validations, phases, tests, requiredTests);
  const failedGuards = Object.entries(guards).filter(([, ok]) => !ok).map(([name]) => name);
  const validationFailures = validations.filter((row) => !row.present).map((row) => row.rule);

  const summary = {
    spec_compile_bytes: Buffer.byteLength(src),
    spec_compile_lines: src.split(/\r?\n/).length,
    export_count: exports.length,
    function_count: functions.length,
    compile_option_count: options.length,
    env_ref_count: envRefs.length,
    build_and_zip_field_count: buildFields.length,
    validation_rule_count: validations.length,
    present_validation_rule_count: validations.filter((row) => row.present).length,
    phase_count: phases.length,
    present_phase_count: phases.filter((row) => row.present).length,
    required_test_evidence_count: requiredTests.length,
    direct_test_evidence_count: tests.length,
    missing_required_exports: missingRequiredExports.length,
    failed_validation_rules: validationFailures.length,
    failed_safety_guards: failedGuards.length,
    missing_test_evidence: missingTests.length,
  };

  const failures = [];
  if (missingRequiredExports.length) failures.push({ gate: 'required_exports', missing: missingRequiredExports });
  if (summary.compile_option_count < 35) failures.push({ gate: 'compile_options', count: summary.compile_option_count });
  if (summary.env_ref_count < 10) failures.push({ gate: 'env_refs', count: summary.env_ref_count });
  if (summary.build_and_zip_field_count < 30) failures.push({ gate: 'build_and_zip_fields', count: summary.build_and_zip_field_count });
  if (validationFailures.length) failures.push({ gate: 'validation_rules', missing: validationFailures });
  if (summary.present_phase_count !== summary.phase_count) failures.push({ gate: 'compile_phases', missing: phases.filter((row) => !row.present).map((row) => row.phase) });
  if (failedGuards.length) failures.push({ gate: 'spec_compile_safety_guards', guards: failedGuards });
  if (missingTests.length) failures.push({ gate: 'test_evidence', missing: missingTests });

  return {
    schema: SCHEMA,
    updated_at: UPDATED_AT,
    purpose: 'Generated contract matrix for src/spec-compile.js: spec validation, seed and eval gating, signed artifact build inputs, provenance blocks, native/WASM honesty, attestation, workload-profile patching, speculative-decoding compile fingerprints, and compilePipeline re-export ownership.',
    sources: [
      'src/spec-compile.js',
      'src/artifact.js',
      'src/native-compile.js',
      'src/pipeline-runner.js',
      ...requiredTests,
    ],
    summary,
    exports,
    required_exports: requiredExports(),
    missing_required_exports: missingRequiredExports,
    functions,
    compile_options: options,
    env_refs: envRefs,
    build_and_zip_fields: buildFields,
    validation_rules: validations,
    compile_phases: phases,
    public_return_shapes: {
      validateSpec: ['true', 'throws KOLM_E_SPEC_INVALID'],
      compileSpec: ['outPath', 'manifest', 'k_score', 'sha256', 'bytes', 'evals_report', 'distill_provenance', 'export_provenance', 'moe_provenance', 'pretokenize_provenance', 'external_holdout_provenance', 'tenant_shadow_corpus_provenance', 'auditor_attestation_provenance'],
      compilePipeline: ['ok', 'sidecar', 'sidecar_hash', 'sidecar_content_sha256'],
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
      console.error('spec-compile-matrix: docs/internal/spec-compile-matrix.json is out of date');
      process.exit(1);
    }
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, body, 'utf8');
  }

  if (SUMMARY) {
    console.log(JSON.stringify({
      ok: matrix.gates.ok,
      schema: matrix.schema,
      summary: matrix.summary,
      failures: matrix.gates.failures,
      warnings: matrix.gates.warnings,
    }, null, 2));
  } else {
    const action = CHECK ? 'ok' : 'wrote';
    console.log(`spec-compile-matrix: ${action} docs/internal/spec-compile-matrix.json phases=${matrix.summary.present_phase_count}/${matrix.summary.phase_count} failures=${matrix.gates.failures.length}`);
  }

  if (!matrix.gates.ok) process.exit(1);
}

try {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
} catch (err) {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
}
