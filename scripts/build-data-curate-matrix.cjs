#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'internal', 'data-curate-matrix.json');
const SCHEMA = 'kolm.data_curate_matrix.v1';
const UPDATED_AT = '2026-06-19';

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
    'CURATE_VERSION',
    'EMBEDDING_NEAR_DUP_VERSION',
    'flagCot',
    'flagPii',
    'redactPii',
    'scoreCandidateLocal',
    'curatePairs',
    'curateDefault',
  ];
}

function requiredTestEvidence() {
  return [
    'tests/wave921-data-engine-modules.test.js',
    'tests/wave921-data-curate-modules.test.js',
    'tests/sota-capturedata.test.js',
    'tests/finalized-c3-real-dsir-hashed-ngram-importance-resampling.test.js',
    'tests/finalized-c3-semdedup-embedding-semantic-deduplication.test.js',
    'tests/finalized-c3-gradient-influence-valuation-tracin-ekfac-less.test.js',
    'tests/wave637-data-curate-neardup-fallback.test.js',
    'tests/wave954-learned-embedding-provider.test.js',
    'tests/wave947-data-curate-matrix.test.js',
  ];
}

function extractOptions(src) {
  const names = new Set();
  for (const m of src.matchAll(/\bo\.([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\bopts\.([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  return [...names].sort();
}

function extractEnvRefs(src) {
  return [...new Set([...src.matchAll(/\bprocess\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
}

function stageRows(src) {
  const defs = [
    ['quality_learned_classifier', 'qualityClassifier', ['_scoreQualityLearned', '_applyQualityThreshold', 'report.quality']],
    ['quality_heuristic_fallback', '_runHeuristicQuality', ['_runHeuristicQuality', 'scoreCandidateLocal', 'quality_filtered']],
    ['minhash_predup', 'minhashPredup', ['minhashPredup(work', 'minhashThreshold', 'report.minhash']],
    ['embedding_provider_precompute', 'embedBatchAsync', ['embedBatchAsync(texts', 'embedding_provider', 'embeddingBackend: null']],
    ['semdedup_semantic', 'semDedup', ['semDedup(work', 'semdedupKeep', 'report.semdedup']],
    ['python_semantic_dedup', '_dedupViaPython', ['spawnSync(py, args', 'timeout: 5 * 60 * 1000', "report.dedup = 'ok'"]],
    ['embedding_near_dup_fallback', '_embeddingNearDupFallback', ['_embeddingNearDupFallback(', 'embedding_near_dup', 'embedding-near-dup-js']],
    ['semantic_cluster_labels', '_clusterAndLabel', ['_clusterAndLabel({', 'report.topics', 'cluster_method']],
    ['fallback_cluster_buckets', '_bucketKeyFor', ['_bucketKeyFor(p)', "cluster_method = 'fallback:3gram'", 'report.coverage']],
    ['label_error_detection', '_detectLabelErrors', ['_detectLabelErrors({', 'report.label_errors', '_routeErrorsToReview']],
    ['cot_filter', 'flagCot', ['flagCot(_pairOutput(p))', 'cot_flagged', 'survivors.push(p)']],
    ['pii_redaction', 'redactPii', ['flagPii(out)', 'redactPii(out)', 'pii_redacted']],
    ['valuation_influence', 'valuePairsByInfluence', ['valuePairsByInfluence({', 'holdout_disjointness_unattested', "basis: 'influence'"]],
    ['valuation_shapley', 'valuePairsByShapley', ['valuePairsByShapley({', 'shapleyVal', "basis: 'shapley'"]],
    ['diversity_select', '_selectDiverse', ['_selectDiverse({', 'facility-location', "strategy: 'diversity-' + method"]],
    ['dsir_real_select', 'selectByDSIR', ['selectByDSIR({', '_dsirRealEnabled()', "strategy: 'dsir'"]],
    ['dsir_lite_or_default_select', 'selectInformativeSubset', ['selectInformativeSubset(work', 'dsir-lite', 'value_strategy']],
    ['jsonl_materialization', '_writeJsonl', ['_writeJsonl(outFile, work)', 'wrote = true', 'write_error']],
    ['provenance_persist', '_persist', ['CURATE_PROVENANCE_SUFFIX', 'eventStore.appendEvent', 'prompt_tokens: 0']],
    ['public_envelope', 'curatePairs', ['ok: true', 'version: CURATE_VERSION', 'n_removed']],
    ['curate_default_light_path', 'curateDefault', ['curateDefault NEVER spawns', 'dedup: false', 'target_size: 0']],
  ];
  return defs.map(([stage, owner, evidence]) => ({
    stage,
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
    const sourceLock = body.includes('src/data-curate.js') || body.includes('../src/data-curate.js') || body.includes('data-curate');
    const counts = {};
    for (const sym of symbols) counts[`${sym}_refs`] = (body.match(new RegExp(`\\b${sym}\\b`, 'g')) || []).length;
    const totalSymbolRefs = Object.values(counts).reduce((sum, n) => sum + n, 0);
    const curationWorkflowRefs = (body.match(/\bcurate\b|\bcuration\b|\bminhash\b|\bsemdedup\b|\bdsir\b|\bqualityClassifier\b|\bsemanticCluster\b|\bdetectErrors\b|\bembedding_near_dup\b|\bembeddingBackend\b|\btarget_size\b/gi) || []).length;
    if (!sourceLock && !totalSymbolRefs && !curationWorkflowRefs) continue;
    rows.push({
      path: rel,
      source_lock: sourceLock,
      total_symbol_refs: totalSymbolRefs,
      curation_workflow_refs: curationWorkflowRefs,
      ...counts,
    });
  }
  return rows;
}

function safetyGuards(src, mod, exports, options, envRefs, stages, tests, requiredTests) {
  const exportSet = new Set(exports.map((row) => row.name));
  const optionSet = new Set(options);
  const envSet = new Set(envRefs);
  const evidenceSet = new Set(tests.map((row) => row.path));
  const missingTests = requiredTests.filter((rel) => !evidenceSet.has(rel));
  const curatePairsIdx = src.indexOf('export async function curatePairs');
  const catchIdx = src.indexOf('return { ok: false', curatePairsIdx);
  const defaultIdx = src.indexOf('export async function curateDefault');
  const defaultCatchIdx = src.indexOf('degraded: true', defaultIdx);
  return {
    required_public_exports_present: requiredExports().every((name) => exportSet.has(name) && mod[name] != null),
    versions_are_current: mod.CURATE_VERSION === 'curate-v1' && mod.EMBEDDING_NEAR_DUP_VERSION === 'embedding-near-dup-v1',
    option_surface_covers_frontier_stages: options.length >= 45 && ['qualityClassifier', 'quality_mode', 'keep_fraction', 'minhash', 'semdedup', 'embeddingNearDup', 'semanticCluster', 'detectErrors', 'valueStrategy', 'shapleyVal', 'diversitySelect', 'select_strategy', 'target_items', 'target_size'].every((name) => optionSet.has(name)),
    env_surface_is_small_and_named: JSON.stringify(envRefs) === JSON.stringify(['KOLM_DATA_DIR', 'KOLM_DSIR_DISABLE', 'KOLM_PYTHON'].sort()),
    public_api_never_throws_curate_pairs: curatePairsIdx >= 0 && catchIdx > curatePairsIdx && src.includes('version: CURATE_VERSION'),
    public_api_never_throws_curate_default: defaultIdx >= 0 && defaultCatchIdx > defaultIdx && src.includes('degraded: true'),
    provenance_is_audit_namespace_not_training_namespace: src.includes('CURATE_PROVENANCE_SUFFIX') && src.includes("String(namespace || 'default') + CURATE_PROVENANCE_SUFFIX") && src.includes('prompt_tokens: 0') && src.includes('completion_tokens: 0'),
    ingest_raw_pairs_path_is_single_authority: src.includes("import { rawPairsPath as _ingestRawPairsPath } from './data-ingest.js'") && src.includes('const inFile = in_path || _ingestRawPairsPath(ns)'),
    python_dedup_is_bounded_and_degrades: src.includes('spawnSync(py, args') && src.includes('timeout: 5 * 60 * 1000') && src.includes("return { kept: pairs, note: 'skipped:' + why }"),
    python_shell_only_for_windows_cmd_shim: src.includes("shell: process.platform === 'win32' && /\\.(cmd|bat)$/i.test(py)"),
    python_tempdir_cleanup_is_best_effort: src.includes('fs.mkdtempSync') && src.includes('fs.rmSync(tmpDir, { recursive: true, force: true })'),
    quality_classifier_default_on_and_degrades: src.includes('qualityClassifier: true') && src.includes('degrade to the heuristic path') && src.includes('_runHeuristicQuality(work, o, report)'),
    minhash_and_semdedup_default_on: src.includes('minhash: true') && src.includes('semdedup: true') && src.includes('report.backend_used = _appendBackend(report.backend_used, semBackend)'),
    embedding_provider_is_optional_and_reported: src.includes('embeddingBackend: null') && src.includes('embedBatchAsync(texts') && src.includes('report.embedding_provider'),
    embedding_fallback_records_python_less_boundary: src.includes('embeddingNearDup: true') && src.includes('report.embedding_near_dup = near.report') && src.includes('embedding-near-dup-js'),
    pii_redaction_preserves_pair_schema: src.includes('function _setPairOutput') && src.includes('redactPii(out)') && src.includes('if (typeof p.teacher_output ==='),
    cot_filter_drops_not_redacts_reasoning: src.includes('flagCot(_pairOutput(p))') && src.includes('report.cot_flagged += 1') && src.includes('else survivors.push(p)'),
    label_error_review_is_default_not_drop: src.includes("errorAction: 'review'") && src.includes("errorAction:'filter' - drop") && src.includes('_routeErrorsToReview'),
    selection_is_opt_in_by_target_size: src.includes('target_size: 0') && src.includes('Number.isFinite(targetSize) && targetSize > 0'),
    real_dsir_is_default_and_disable_is_explicit: src.includes('KOLM_DSIR_DISABLE') && src.includes('_dsirRealEnabled()') && src.includes('selectByDSIR({'),
    influence_refusal_does_not_fabricate_scores: src.includes('fail-closed read') && src.includes("skipped: 'refused:'") && src.includes('keep pointwise path'),
    curate_default_keeps_heavy_stages_off: src.includes('dedup: false') && src.includes('target_size: 0') && src.includes('diversitySelect: false'),
    all_expected_stage_rows_present: stages.every((row) => row.present),
    direct_evidence_covers_required_tests: missingTests.length === 0,
  };
}

async function buildMatrix() {
  const src = read('src/data-curate.js');
  const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'data-curate.js')).href + `?matrix=${Date.now()}`);
  const exports = extractExports(src);
  const functions = extractFunctions(src);
  const exportNames = new Set(exports.map((row) => row.name));
  const missingRequiredExports = requiredExports().filter((name) => !exportNames.has(name));
  const options = extractOptions(src);
  const envRefs = extractEnvRefs(src);
  const stages = stageRows(src);
  const tests = directTestEvidence();
  const requiredTests = requiredTestEvidence();
  const evidenceSet = new Set(tests.map((row) => row.path));
  const missingTests = requiredTests.filter((rel) => !evidenceSet.has(rel));
  const guards = safetyGuards(src, mod, exports, options, envRefs, stages, tests, requiredTests);
  const failedGuards = Object.entries(guards).filter(([, ok]) => !ok).map(([name]) => name);

  const summary = {
    data_curate_bytes: Buffer.byteLength(src),
    data_curate_lines: src.split(/\r?\n/).length,
    export_count: exports.length,
    function_count: functions.length,
    option_count: options.length,
    env_ref_count: envRefs.length,
    stage_count: stages.length,
    present_stage_count: stages.filter((row) => row.present).length,
    required_test_evidence_count: requiredTests.length,
    direct_test_evidence_count: tests.length,
    missing_required_exports: missingRequiredExports.length,
    failed_safety_guards: failedGuards.length,
    missing_test_evidence: missingTests.length,
  };

  const failures = [];
  if (missingRequiredExports.length) failures.push({ gate: 'required_exports', missing: missingRequiredExports });
  if (summary.option_count < 45) failures.push({ gate: 'option_surface', count: summary.option_count });
  if (summary.env_ref_count !== 3) failures.push({ gate: 'env_refs', refs: envRefs });
  if (summary.present_stage_count !== summary.stage_count) failures.push({ gate: 'curation_stages', missing: stages.filter((row) => !row.present).map((row) => row.stage) });
  if (failedGuards.length) failures.push({ gate: 'data_curate_safety_guards', guards: failedGuards });
  if (missingTests.length) failures.push({ gate: 'test_evidence', missing: missingTests });

  return {
    schema: SCHEMA,
    updated_at: UPDATED_AT,
    purpose: 'Generated contract matrix for src/data-curate.js: default-on light curation, optional heavy curation, DSIR/value/selection frontiers, privacy filters, graceful degradation, provenance fencing, and direct evidence coverage.',
    sources: [
      'src/data-curate.js',
      'src/minhash-dedup.js',
      'src/data-semdedup.js',
      'src/data-dsir.js',
      'src/embedding.js',
      'src/data-select.js',
      'src/data-quality-classifier.js',
      'src/data-cluster-label.js',
      'src/data-label-errors.js',
      'workers/data/scripts/_embed.py',
      ...requiredTests,
    ],
    summary,
    exports,
    required_exports: requiredExports(),
    missing_required_exports: missingRequiredExports,
    functions,
    options,
    env_refs: envRefs,
    curation_stages: stages,
    public_return_shapes: {
      curatePairs: ['ok', 'version', 'n_in', 'n_kept', 'n_removed', 'in_path', 'out_path', 'wrote', 'write_error', 'report', 'persist'],
      curateDefault: ['ok', 'version', 'pairs', 'report', 'n_in', 'n_kept', 'n_removed', 'method', 'degraded'],
      scoreCandidateLocal: ['score', 'components'],
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
      console.error('data-curate-matrix: docs/internal/data-curate-matrix.json is out of date');
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
    console.log(`data-curate-matrix: ${action} docs/internal/data-curate-matrix.json stages=${matrix.summary.present_stage_count}/${matrix.summary.stage_count} failures=${matrix.gates.failures.length}`);
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
