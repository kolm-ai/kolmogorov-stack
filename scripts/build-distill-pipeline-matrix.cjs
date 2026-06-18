#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'internal', 'distill-pipeline-matrix.json');
const SCHEMA = 'kolm.distill_pipeline_matrix.v1';
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
    .sort((a, b) => a.line - b.line);
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
    'MODES',
    'TEACHER_SOURCE_CLASSIFICATION',
    'classifyTeacher',
    'selectStudentBackbone',
    'prepareDistillCorpus',
    '_pickTeachers',
    '_pickTeachersForCapture',
    '_resolveOrderingPolicy',
    '_resolveDistillTenant',
    'distill',
    'resolveDistillFinalLoss',
    'resolveDistillFinalK',
    'summarizeDistillTelemetry',
    'listDistillRuns',
    'readDistillRun',
    'W808_REGRESSION_GATE_VERSION',
    'W808_KSCORE_DROP_THRESHOLD',
    'W808_CRITICAL_FAIL_RATE_INCREASE_THRESHOLD',
    '_w808RegressionGate',
  ];
}

function requiredTestEvidence() {
  return [
    'tests/wc04-distill-pipeline.test.js',
    'tests/wave411-p0-train-holdout-and-metadata.test.js',
    'tests/wave411-dedupe-and-holdout.test.js',
    'tests/wave411-worker-input-spy.test.js',
    'tests/wave422-distill-tenant-fallback.test.js',
    'tests/wave459-distill-reliability.test.js',
    'tests/wave614-distill-telemetry-source.test.js',
    'tests/wave708-teacher-source-policy.test.js',
    'tests/finalized-c4-rejection-sampling-wiring.test.js',
    'tests/wave808-capture-poisoning.test.js',
    'tests/wave945-distill-pipeline-matrix.test.js',
  ];
}

function extractDistillOptions(src) {
  const start = src.indexOf('export async function* distill({');
  if (start < 0) return [];
  const bodyStart = src.indexOf('{', start) + 1;
  const end = src.indexOf('} = {})', bodyStart);
  if (end < 0) return [];
  const raw = src.slice(bodyStart, end);
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const stripped = line.replace(/\/\/.*$/, '').trim();
    if (!stripped) continue;
    for (const part of stripped.split(',')) {
      const token = part.trim();
      if (!token) continue;
      const name = token.split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.push(name);
    }
  }
  return [...new Set(out)].sort();
}

function extractWorkerFlags(src) {
  const seen = new Set();
  const rows = [];
  for (const m of src.matchAll(/--[a-z0-9][a-z0-9-]*/g)) {
    const flag = m[0];
    if (seen.has(flag)) continue;
    seen.add(flag);
    rows.push({ flag, line: lineNumber(src, m.index) });
  }
  return rows.sort((a, b) => a.flag.localeCompare(b.flag));
}

function extractStatsKeys(src) {
  const marker = 'stats: {';
  const idx = src.indexOf(marker, src.indexOf('export async function prepareDistillCorpus'));
  if (idx < 0) return [];
  const end = src.indexOf('},', idx);
  if (end < 0) return [];
  const body = src.slice(idx + marker.length, end);
  const keys = [];
  for (const line of body.split(/\r?\n/)) {
    const m = line.trim().match(/^([A-Za-z_$][\w$]*):?/);
    if (m) keys.push(m[1]);
  }
  return [...new Set(keys)].sort();
}

function directTestEvidence() {
  const dir = path.join(ROOT, 'tests');
  const rows = [];
  const symbols = [
    'MODES',
    'TEACHER_SOURCE_CLASSIFICATION',
    'classifyTeacher',
    'selectStudentBackbone',
    'prepareDistillCorpus',
    '_pickTeachers',
    '_pickTeachersForCapture',
    '_resolveOrderingPolicy',
    '_resolveDistillTenant',
    'distill',
    'resolveDistillFinalLoss',
    'resolveDistillFinalK',
    'summarizeDistillTelemetry',
    'listDistillRuns',
    'readDistillRun',
    '_w808RegressionGate',
    'W808_REGRESSION_GATE_VERSION',
  ];
  for (const name of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
    const rel = `tests/${name}`;
    const body = read(rel);
    const sourceLock = body.includes('src/distill-pipeline.js') || body.includes('../src/distill-pipeline.js') || body.includes('distill-pipeline');
    const counts = {};
    for (const sym of symbols) counts[`${sym}_refs`] = (body.match(new RegExp(`\\b${sym}\\b`, 'g')) || []).length;
    const totalSymbolRefs = Object.values(counts).reduce((sum, n) => sum + n, 0);
    const distillWorkflowRefs = (body.match(/\bdistill\b|\bdistillation\b|\bteacher_source\b|\bw808_regression_gate\b/g) || []).length;
    if (!sourceLock && !totalSymbolRefs && !distillWorkflowRefs) continue;
    rows.push({
      path: rel,
      source_lock: sourceLock,
      total_symbol_refs: totalSymbolRefs,
      distill_workflow_refs: distillWorkflowRefs,
      ...counts,
    });
  }
  return rows;
}

function stageRows(src) {
  const defs = [
    ['corpus_preparation', 'prepareDistillCorpus', ['listEvents({ namespace', 'holdout_excluded_from_train', 'curateDefault']],
    ['teacher_policy', '_pickTeachers', ['KOLM_TEACHER_SOURCE', 'no_open_weight_teacher_configured', 'classifyTeacher']],
    ['teacher_council', '_pickTeachersForCapture', ['selectTeacherForCapture', 'TeacherReliabilityTable', 'teacher_council_weights']],
    ['worker_input_staging', '_writeWorkerInputs', ['spec.json', 'seeds.jsonl', 'importance-weights.jsonl']],
    ['distill_iterator', 'distill', ['export async function* distill', 'pipeline_mode', 'pairs_override']],
    ['worker_spawn', 'spawn', ['spawn(process.execPath', 'windowsHide: true', 'KOLM_DISTILL_ATTEMPT']],
    ['rejection_sampling_forwarding', 'distill', ['--distillation-method', '--rs-n', '--rs-reward']],
    ['privacy_budget', 'distill', ['buildPrivacyBudgetBlock', 'buildDpTrainerEnv', 'privacy_budget']],
    ['efficiency_env', 'distill', ['normalizeEfficiencyOptions', 'buildEfficiencyEnv', 'KOLM_PRECISION']],
    ['telemetry_summary', 'summarizeDistillTelemetry', ['telemetry_source', 'synthetic_suppressed', 'measured']],
    ['run_listing', 'listDistillRuns', ['tenant_id = \'local\'', 'manifest_present', 'runs.slice']],
    ['run_detail', 'readDistillRun', ['log_tail', '_safeTail', 'tenant_id = \'local\'']],
    ['regression_gate', '_w808RegressionGate', ['W808_KSCORE_DROP_THRESHOLD', 'critical_fail_rate', 'rollback']],
  ];
  return defs.map(([stage, owner, needles]) => ({
    stage,
    owner,
    present: needles.every((needle) => src.includes(needle)),
    line: lineNumber(src, src.indexOf(owner)),
    evidence: needles,
  }));
}

function safetyGuards(src, mod, exports, options, flags, statsKeys, stages) {
  const exportSet = new Set(exports.map((row) => row.name));
  const distillIdx = src.indexOf('export async function* distill');
  const spawnIdx = src.indexOf('spawn(process.execPath');
  const tenantIdx = src.indexOf('const resolvedTenant = _resolveDistillTenant');
  const corpusIdx = src.indexOf('prepareDistillCorpus({ namespace: teacher_namespace');
  const holdoutIdx = src.indexOf('pairs = pairs.filter((p) => !(p && p.holdout_only))');
  const stagingIdx = src.indexOf('_writeWorkerInputs({', holdoutIdx >= 0 ? holdoutIdx : 0);
  const runListIdx = src.indexOf('export function listDistillRuns');
  const runReadIdx = src.indexOf('export function readDistillRun');
  const w808Idx = src.indexOf('export function _w808RegressionGate');
  const modeValues = Array.isArray(mod.MODES) ? mod.MODES.slice().sort() : [];
  const teacherValues = Object.values(mod.TEACHER_SOURCE_CLASSIFICATION || {});
  const flagSet = new Set(flags.map((row) => row.flag));
  const statsSet = new Set(statsKeys);
  return {
    required_public_exports_present: requiredExports().every((name) => exportSet.has(name)),
    modes_are_current_and_exact: JSON.stringify(modeValues) === JSON.stringify(['kd_softmax', 'kd_top_k', 'rejection_sampling'].sort()),
    teacher_classification_frozen_and_safe_deny: Object.isFrozen(mod.TEACHER_SOURCE_CLASSIFICATION) && teacherValues.includes('open-weights') && teacherValues.includes('proprietary') && mod.classifyTeacher('unknown-model-x') === 'unknown',
    open_weights_policy_fails_closed: src.includes('KOLM_TEACHER_SOURCE') && src.includes('no_open_weight_teacher_configured') && src.includes('throw err'),
    distill_options_current: options.length >= 27 && ['teacher_namespace', 'student_base', 'pipeline_mode', 'pairs_override', 'tenant_id', 'teacher_fallback', 'resume_from', 'precision_mode', 'dp_path', 'rs'].every((name) => options.includes(name)),
    invalid_mode_and_missing_student_fail_before_spawn: distillIdx >= 0 && spawnIdx > distillIdx && src.indexOf('if (!MODES.includes(pipeline_mode))', distillIdx) < spawnIdx && src.indexOf('if (!student_base)', distillIdx) < spawnIdx,
    tenant_scope_resolved_before_corpus_read: tenantIdx >= 0 && corpusIdx > tenantIdx && src.includes('tenant_id: resolvedTenant'),
    holdout_filter_runs_before_worker_staging: holdoutIdx >= 0 && stagingIdx > holdoutIdx && src.includes('holdout_excluded_count'),
    corpus_stats_have_drop_and_curate_keys: ['events_scanned', 'pairs_kept', 'dropped_no_prompt', 'dropped_no_response', 'dropped_status', 'dropped_unapproved', 'dropped_since', 'holdout_excluded_from_train', 'curate', 'curriculum', 'since'].every((name) => statsSet.has(name)),
    worker_spawn_is_node_argv_array_not_shell: src.includes('spawn(process.execPath, args') && src.includes('windowsHide: true') && !src.includes('shell: true'),
    rejection_sampling_flags_forwarded_only_for_mode: src.includes("pipeline_mode === 'rejection_sampling'") && ['--rs-n', '--rs-temperature', '--rs-threshold', '--rs-threshold-mode', '--rs-reward'].every((flag) => flagSet.has(flag)),
    efficiency_env_forwarded_to_worker: src.includes('normalizeEfficiencyOptions') && src.includes('buildEfficiencyEnv') && src.includes('..._efficiencyEnv'),
    dp_budget_and_env_fail_loud_before_spawn: src.includes('buildPrivacyBudgetBlock') && src.includes('buildDpTrainerEnv') && src.indexOf('buildDpTrainerEnv') < spawnIdx && src.includes('DP_ZERO_NOISE'),
    ordering_policy_stages_curriculum_and_importance: src.includes('function _writeWorkerInputs') && flagSet.has('--curriculum') && flagSet.has('--importance-weights') && src.includes('ordering_meta'),
    resume_is_tenant_fenced: src.includes('resume_from') && src.includes('tenant mismatch') && src.includes('resumePriorSteps'),
    teacher_fallback_attempts_are_manifest_fenced: src.includes('teacher_attempts') && src.includes('teacher_error') && src.includes('attemptManifest') && src.includes('KOLM_DISTILL_ATTEMPT'),
    telemetry_never_promotes_synthetic_loss_to_final: src.includes('synthetic_suppressed') && src.includes('resolveDistillFinalLoss') && src.includes('telemetry_source: resultSource'),
    list_runs_and_read_run_are_tenant_scoped: runListIdx >= 0 && runReadIdx > runListIdx && src.includes('if (String(runTenant) !== String(tenant_id)) continue') && src.includes('if (String(runTenant) !== String(tenant_id)) return null'),
    log_tail_is_bounded: src.includes('_safeTail(path.join(runDir, \'distill.log\'), 4096)') && src.includes('const start = Math.max(0, sz - bytes)'),
    w808_gate_is_versioned_and_thresholded: w808Idx >= 0 && mod.W808_REGRESSION_GATE_VERSION === 'w808-v1' && mod.W808_KSCORE_DROP_THRESHOLD === 0.02 && mod.W808_CRITICAL_FAIL_RATE_INCREASE_THRESHOLD === 0.01 && src.includes("verdict = 'rollback'"),
    done_envelope_stamps_policy_privacy_telemetry_and_w808: src.includes('done: true') && src.includes('teacher_source: teacher_source_final') && src.includes('privacy_budget: _dpBudget') && src.includes('w808_regression_gate: _w808_gate') && src.includes('..._telemetry'),
    all_expected_stage_rows_present: stages.every((row) => row.present),
  };
}

async function buildMatrix() {
  const src = read('src/distill-pipeline.js');
  const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'distill-pipeline.js')).href + `?matrix=${Date.now()}`);
  const exports = extractExports(src);
  const functions = extractFunctions(src);
  const exportNames = new Set(exports.map((row) => row.name));
  const missingRequiredExports = requiredExports().filter((name) => !exportNames.has(name));
  const options = extractDistillOptions(src);
  const flags = extractWorkerFlags(src);
  const statsKeys = extractStatsKeys(src);
  const stages = stageRows(src);
  const tests = directTestEvidence();
  const requiredTests = requiredTestEvidence();
  const evidenceSet = new Set(tests.map((row) => row.path));
  const missingTests = requiredTests.filter((rel) => !evidenceSet.has(rel));
  const guards = safetyGuards(src, mod, exports, options, flags, statsKeys, stages);
  const failedGuards = Object.entries(guards).filter(([, ok]) => !ok).map(([name]) => name);
  const teacherClassification = Object.entries(mod.TEACHER_SOURCE_CLASSIFICATION || {})
    .map(([slug, source]) => ({ slug, source }))
    .sort((a, b) => a.slug.localeCompare(b.slug));
  const teacherSourceCounts = teacherClassification.reduce((acc, row) => {
    acc[row.source] = (acc[row.source] || 0) + 1;
    return acc;
  }, {});

  const summary = {
    distill_bytes: Buffer.byteLength(src),
    distill_lines: src.split(/\r?\n/).length,
    export_count: exports.length,
    function_count: functions.length,
    mode_count: Array.isArray(mod.MODES) ? mod.MODES.length : 0,
    teacher_classification_count: teacherClassification.length,
    open_weight_teacher_count: teacherSourceCounts['open-weights'] || 0,
    proprietary_teacher_count: teacherSourceCounts.proprietary || 0,
    distill_option_count: options.length,
    worker_flag_count: flags.length,
    corpus_stats_key_count: statsKeys.length,
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
  if (summary.mode_count !== 3) failures.push({ gate: 'mode_count', count: summary.mode_count });
  if (summary.teacher_classification_count < 8) failures.push({ gate: 'teacher_classification_count', count: summary.teacher_classification_count });
  if (summary.distill_option_count < 27) failures.push({ gate: 'distill_options', count: summary.distill_option_count });
  if (summary.worker_flag_count < 15) failures.push({ gate: 'worker_flags', count: summary.worker_flag_count });
  if (summary.corpus_stats_key_count < 11) failures.push({ gate: 'corpus_stats_keys', count: summary.corpus_stats_key_count });
  if (summary.present_stage_count !== summary.stage_count) failures.push({ gate: 'pipeline_stages', missing: stages.filter((row) => !row.present).map((row) => row.stage) });
  if (failedGuards.length) failures.push({ gate: 'distill_pipeline_safety_guards', guards: failedGuards });
  if (missingTests.length) failures.push({ gate: 'test_evidence', missing: missingTests });

  return {
    schema: SCHEMA,
    updated_at: UPDATED_AT,
    purpose: 'Generated contract matrix for src/distill-pipeline.js: corpus filtering, teacher-source policy, teacher fallback/council, worker spawn and argv boundaries, DP/efficiency/order controls, synthetic-vs-measured telemetry, run read APIs, and W808 regression gating.',
    sources: [
      'src/distill-pipeline.js',
      'workers/distill/distill.mjs',
      ...requiredTests,
    ],
    summary,
    exports,
    required_exports: requiredExports(),
    missing_required_exports: missingRequiredExports,
    functions,
    modes: Array.isArray(mod.MODES) ? mod.MODES.slice().sort() : [],
    teacher_classification: teacherClassification,
    teacher_source_counts: teacherSourceCounts,
    distill_options: options,
    worker_flags: flags,
    corpus_stats_keys: statsKeys,
    pipeline_stages: stages,
    public_return_shapes: {
      prepareDistillCorpus: ['pairs', 'stats'],
      distill_progress_event: ['step', 'loss', 'k_score', 'loss_source', 'k_source', 'telemetry_source'],
      distill_done_event: ['done', 'artifact_path', 'student_path', 'worker_mode', 'pipeline_mode', 'teacher_source', 'privacy_budget', 'telemetry_source', 'w808_regression_gate'],
      listDistillRuns: ['id', 'tenant_id', 'namespace', 'pipeline_mode', 'telemetry_source', 'manifest_present'],
      readDistillRun: ['id', 'meta', 'progress', 'manifest', 'telemetry_source', 'log_tail'],
      w808RegressionGate: ['ok', 'verdict', 'candidate_kscore', 'prior_kscore', 'version'],
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
      console.error('distill-pipeline-matrix: docs/internal/distill-pipeline-matrix.json is out of date');
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
    console.log(`distill-pipeline-matrix: ${action} docs/internal/distill-pipeline-matrix.json stages=${matrix.summary.present_stage_count}/${matrix.summary.stage_count} failures=${matrix.gates.failures.length}`);
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
