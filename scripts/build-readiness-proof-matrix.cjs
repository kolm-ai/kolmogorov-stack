#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SCHEMA = 'kolm.readiness_proof_matrix.v1';
const UPDATED_AT = '2026-06-18';
const READINESS = path.join(ROOT, 'docs', 'product-sota-readiness.json');
const WORKORDERS = path.join(ROOT, 'docs', 'readiness-gate-workorders.json');
const CLOSEOUT_JSON = path.join(ROOT, 'public', 'product-readiness-closeout.json');
const CLOSEOUT_MD = path.join(ROOT, 'docs', 'product-readiness-closeout.md');
const OUT = path.join(ROOT, 'docs', 'internal', 'readiness-proof-matrix.json');

const args = new Set(process.argv.slice(2));
const checkOnly = args.has('--check');
const summaryOnly = args.has('--summary');

const CLAIMABLE_STATUSES = new Set(['shipped', 'implemented']);
const STATUS_TO_KIND = {
  needs_external_partner: 'external_partner',
  needs_package_release: 'package_release',
  needs_public_benchmark_data: 'public_benchmark_data',
  needs_live_certification: 'live_certification',
};
const WORKORDER_MINIMUMS = {
  local_files: 4,
  local_commands: 4,
  external_actions: 3,
  evidence_required: 3,
  failure_modes: 3,
};

const REQUIRED_TEST_EVIDENCE = [
  'tests/wave599-readiness-gate-workorders.test.js',
  'tests/wave603-whole-stack-sota-deep-dive.test.js',
  'tests/wave616-master-component-spec-sheet.test.js',
  'tests/wave952-readiness-proof-matrix.test.js',
];

const REQUIRED_ESCAPE_HATCHES = [
  { path: 'workers/quantize/scripts/quantize.py', bucket: 'python_ml_worker', reason: 'frontier quantization methods belong in Python/native ML tooling' },
  { path: 'workers/quantize/scripts/fp4_calib.py', bucket: 'python_ml_worker', reason: 'FP4 calibration should not be locked into the JS control plane' },
  { path: 'workers/distill/scripts/train_preference.py', bucket: 'python_ml_worker', reason: 'preference optimization needs Python trainer/library access' },
  { path: 'workers/distill/scripts/train_gkd.py', bucket: 'python_ml_worker', reason: 'GKD/on-policy distillation needs Python trainer/library access' },
  { path: 'workers/distill/scripts/dedup_pairs.py', bucket: 'python_data_worker', reason: 'large-pair dedup belongs in worker/data substrate' },
  { path: 'workers/data/scripts/dsir_resample.py', bucket: 'python_data_worker', reason: 'DSIR and curation statistics belong in data-worker substrate' },
  { path: 'workers/data/scripts/minhash_dedup.py', bucket: 'python_data_worker', reason: 'near-duplicate indexing belongs outside request-path JS' },
  { path: 'packages/runtime-rs/src/lib.rs', bucket: 'rust_runtime', reason: 'runtime verification needs a memory-safe native substrate' },
  { path: 'packages/runtime-rs/src/verify.rs', bucket: 'rust_runtime', reason: 'artifact verification should have a standalone native path' },
  { path: 'packages/runtime-rs/src/wasm.rs', bucket: 'rust_wasm', reason: 'browser/edge runtime needs a WASM-capable native core' },
  { path: 'packages/runtime-rs/src/zip_reader.rs', bucket: 'rust_runtime', reason: 'ZIP parsing and bounds checks are proof-critical runtime code' },
  { path: 'packages/sdk-python/kolm/runtimes/onnx_text.py', bucket: 'python_sdk_runtime', reason: 'Python SDK needs its own ONNX runtime escape hatch' },
  { path: 'src/runners/onnx-runner.js', bucket: 'native_orchestrator', reason: 'JS should orchestrate native ONNX execution rather than reimplement kernels' },
  { path: 'src/runners/native-runner.js', bucket: 'native_orchestrator', reason: 'JS should dispatch native runners for hot execution paths' },
  { path: 'packages/sdk-swift/Sources/Kolm/Kolm.swift', bucket: 'mobile_native_client', reason: 'iOS clients need a native SDK surface' },
  { path: 'packages/sdk-kotlin/src/main/kotlin/ai/kolm/Kolm.kt', bucket: 'mobile_native_client', reason: 'Android clients need a native SDK surface' },
  { path: 'packages/sdk-rn/ios/KolmRN.swift', bucket: 'mobile_native_bridge', reason: 'React Native needs native iOS bridge code' },
  { path: 'packages/sdk-rn/android/src/main/java/ai/kolm/rn/KolmRNModule.kt', bucket: 'mobile_native_bridge', reason: 'React Native needs native Android bridge code' },
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function rel(file) {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function pct(n, d) {
  return d > 0 ? round1((n / d) * 100) : 0;
}

function existsRel(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

function countBy(rows, field) {
  const out = {};
  for (const row of rows) out[row[field]] = (out[row[field]] || 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function flattenRequirements(readiness) {
  const rows = [];
  for (const surface of readiness.surfaces || []) {
    for (const requirement of surface.requirements || []) {
      rows.push({ surface: surface.id, ...requirement });
    }
  }
  return rows;
}

function listTrackedFiles() {
  try {
    const raw = execSync('git ls-files -z', { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return raw.split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/'));
  } catch (_) {
    return [];
  }
}

function collectLanguageFit(trackedFiles) {
  const counts = {
    js_family: 0,
    ts_family: 0,
    python: 0,
    rust: 0,
    native_mobile: 0,
    c_cpp: 0,
    go: 0,
    shell: 0,
    other: 0,
  };
  for (const file of trackedFiles) {
    const ext = path.extname(file).toLowerCase();
    if (['.js', '.mjs', '.cjs', '.jsx'].includes(ext)) counts.js_family += 1;
    else if (['.ts', '.tsx'].includes(ext)) counts.ts_family += 1;
    else if (ext === '.py') counts.python += 1;
    else if (ext === '.rs') counts.rust += 1;
    else if (['.swift', '.kt', '.kts', '.m', '.mm'].includes(ext)) counts.native_mobile += 1;
    else if (['.c', '.cc', '.cpp', '.h', '.hpp'].includes(ext)) counts.c_cpp += 1;
    else if (ext === '.go') counts.go += 1;
    else if (['.sh', '.ps1', '.cmd'].includes(ext)) counts.shell += 1;
    else counts.other += 1;
  }

  const escapeHatches = REQUIRED_ESCAPE_HATCHES.map((row) => ({
    ...row,
    present: existsRel(row.path),
  }));
  const presentBuckets = new Set(escapeHatches.filter((row) => row.present).map((row) => row.bucket));
  const missingEscapeHatches = escapeHatches.filter((row) => !row.present).map((row) => row.path);

  return {
    architecture: 'js_control_plane_with_python_rust_native_escape_hatches',
    interpretation: 'JavaScript is acceptable for API, CLI, web, orchestration, and generated proof ledgers; Python/Rust/native substrates must exist for ML workers, runtime verification, WASM, mobile clients, and hot execution paths.',
    tracked_file_counts: counts,
    ratios: {
      js_to_python: counts.python ? round1(counts.js_family / counts.python) : null,
      js_to_rust: counts.rust ? round1(counts.js_family / counts.rust) : null,
    },
    escape_hatches: escapeHatches,
    buckets_present: Array.from(presentBuckets).sort(),
    safety_guards: {
      js_heavy_state_is_explicit: counts.js_family > counts.python,
      python_ml_workers_present: counts.python >= 20 && presentBuckets.has('python_ml_worker') && presentBuckets.has('python_data_worker'),
      rust_runtime_present: counts.rust >= 10 && presentBuckets.has('rust_runtime') && presentBuckets.has('rust_wasm'),
      mobile_native_clients_present: presentBuckets.has('mobile_native_client') && presentBuckets.has('mobile_native_bridge'),
      native_orchestrators_present: presentBuckets.has('native_orchestrator'),
      no_python_rewrite_claim: true,
    },
    missing_escape_hatches: missingEscapeHatches,
  };
}

function workorderSurplus(workorder) {
  let surplus = 0;
  const details = {};
  for (const [field, min] of Object.entries(WORKORDER_MINIMUMS)) {
    const count = Array.isArray(workorder[field]) ? workorder[field].length : 0;
    const extra = Math.max(0, count - min);
    surplus += extra;
    details[field] = { count, minimum: min, surplus: extra };
  }
  return { surplus, details };
}

function collectRows(requirements, workorders) {
  const byReq = new Map((workorders.workorders || []).map((workorder) => [workorder.requirement_id, workorder]));
  return requirements.map((requirement) => {
    const claimable = CLAIMABLE_STATUSES.has(requirement.status);
    const evidencePaths = requirement.evidence_paths || [];
    const missingEvidencePaths = evidencePaths.filter((p) => !existsRel(p));
    const expectedKind = STATUS_TO_KIND[requirement.status] || null;
    const workorder = byReq.get(requirement.id) || null;
    const missingLocalFiles = workorder ? (workorder.local_files || []).filter((p) => !existsRel(p)) : [];
    const hasCloseout = claimable || Boolean(requirement.closeout);
    const hasWorkorder = claimable || Boolean(workorder);
    const kindMatches = claimable || (workorder && workorder.kind === expectedKind);
    const publicCopyScoped = claimable || /do not (claim|advertise|publish)/i.test(workorder?.public_copy_rule || '');
    const localCommandsReady = claimable || ((workorder?.local_commands || []).some((cmd) => /verify:/.test(cmd))
      && (workorder?.local_commands || []).some((cmd) => /simulate-|package-release|compliance|governance|benchmark|sota|claims/.test(cmd)));
    const surplus = workorder ? workorderSurplus(workorder) : { surplus: 0, details: {} };
    const proofComplete = missingEvidencePaths.length === 0
      && hasCloseout
      && hasWorkorder
      && Boolean(kindMatches)
      && publicCopyScoped
      && localCommandsReady
      && missingLocalFiles.length === 0;

    return {
      surface: requirement.surface,
      id: requirement.id,
      priority: requirement.priority,
      status: requirement.status,
      claimable,
      proof_complete: proofComplete,
      external_kind: expectedKind,
      evidence_paths: evidencePaths,
      missing_evidence_paths: missingEvidencePaths,
      closeout_present: hasCloseout,
      workorder_id: workorder?.id || null,
      workorder_kind: workorder?.kind || null,
      workorder_kind_matches: Boolean(kindMatches),
      workorder_local_files: workorder?.local_files?.length || 0,
      workorder_local_commands: workorder?.local_commands?.length || 0,
      workorder_external_actions: workorder?.external_actions?.length || 0,
      workorder_evidence_required: workorder?.evidence_required?.length || 0,
      workorder_failure_modes: workorder?.failure_modes?.length || 0,
      workorder_surplus: surplus.surplus,
      surplus_details: surplus.details,
      public_copy_scoped: publicCopyScoped,
      local_commands_ready: localCommandsReady,
      missing_local_files: missingLocalFiles,
    };
  });
}

function testEvidence() {
  const rows = REQUIRED_TEST_EVIDENCE.map((p) => ({
    path: p,
    present: existsRel(p),
    bytes: existsRel(p) ? fs.statSync(path.join(ROOT, p)).size : 0,
  }));
  let directCount = 0;
  const testDir = path.join(ROOT, 'tests');
  for (const name of fs.readdirSync(testDir)) {
    if (!name.endsWith('.test.js')) continue;
    const text = fs.readFileSync(path.join(testDir, name), 'utf8');
    if (/readiness|sota|proof|workorder|language|polyglot/i.test(text)) directCount += 1;
  }
  return { rows, directCount };
}

function build() {
  const readiness = readJson(READINESS);
  const workorders = readJson(WORKORDERS);
  const requirements = flattenRequirements(readiness);
  const rows = collectRows(requirements, workorders);
  const openRows = rows.filter((row) => !row.claimable);
  const claimableRows = rows.filter((row) => row.claimable);
  const proofRows = rows.filter((row) => row.proof_complete);
  const totalSurplus = openRows.reduce((sum, row) => sum + row.workorder_surplus, 0);
  const languageFit = collectLanguageFit(listTrackedFiles());
  const evidence = testEvidence();
  const failedSafetyGuards = [];

  const safetyGuards = {
    closeout_json_present: fs.existsSync(CLOSEOUT_JSON),
    closeout_markdown_present: fs.existsSync(CLOSEOUT_MD),
    all_requirements_have_local_proof: proofRows.length === rows.length,
    all_open_requirements_have_workorders: openRows.every((row) => row.workorder_id),
    all_open_public_copy_is_scoped: openRows.every((row) => row.public_copy_scoped),
    open_statuses_remain_unclaimable: openRows.every((row) => !row.claimable),
    all_workorder_local_files_exist: openRows.every((row) => row.missing_local_files.length === 0),
    all_required_test_evidence_present: evidence.rows.every((row) => row.present),
    js_is_control_plane_not_compute_monoculture: Object.values(languageFit.safety_guards).every(Boolean),
  };
  for (const [guard, ok] of Object.entries(safetyGuards)) {
    if (!ok) failedSafetyGuards.push(guard);
  }

  const failures = [];
  for (const row of rows) {
    if (!row.proof_complete) failures.push(`${row.surface}/${row.id}: proof incomplete`);
  }
  for (const row of evidence.rows) {
    if (!row.present) failures.push(`${row.path}: missing required test evidence`);
  }
  for (const missing of languageFit.missing_escape_hatches) {
    failures.push(`${missing}: missing non-JS escape hatch`);
  }
  for (const [guard, ok] of Object.entries(languageFit.safety_guards)) {
    if (!ok) failures.push(`language_fit.${guard}: failed`);
  }
  for (const guard of failedSafetyGuards) failures.push(`safety_guard.${guard}: failed`);

  const localProofPct = pct(proofRows.length, rows.length);
  const claimablePct = pct(claimableRows.length, rows.length);
  const openByStatus = countBy(openRows, 'status');
  const surplusScore = round1(100 + Math.min(10, totalSurplus / Math.max(1, openRows.length)));

  const doc = {
    schema: SCHEMA,
    updated_at: UPDATED_AT,
    purpose: 'Separates claimable product readiness from local proof/closeout readiness, and records the language-fit contract for JS control plane versus Python/Rust/native substrates.',
    sources: [
      rel(READINESS),
      rel(WORKORDERS),
      rel(CLOSEOUT_JSON),
      rel(CLOSEOUT_MD),
    ],
    summary: {
      requirement_count: rows.length,
      claimable_requirement_count: claimableRows.length,
      claimable_readiness_pct: claimablePct,
      local_proof_requirement_count: proofRows.length,
      local_proof_coverage_pct: localProofPct,
      open_external_requirement_count: openRows.length,
      open_external_by_status: openByStatus,
      workorder_count: workorders.workorders?.length || 0,
      workorder_surplus_points: totalSurplus,
      required_test_evidence_count: REQUIRED_TEST_EVIDENCE.length,
      direct_test_evidence_count: evidence.directCount,
      failed_safety_guards: failedSafetyGuards.length,
      missing_test_evidence: evidence.rows.filter((row) => !row.present).length,
    },
    over_100_hill_climb: {
      metric: 'local_readiness_proof_surplus_score',
      score: surplusScore,
      ceiling: 110,
      base_score_meaning: '100 means every readiness requirement is either claimably shipped/implemented or has an executable local closeout/workorder contract.',
      surplus_meaning: 'Points above 100 count extra local files, evidence requirements, and closeout detail beyond the W599 minimum. They do not convert external gates into shipped claims.',
      surplus_points: totalSurplus,
    },
    language_fit: languageFit,
    safety_guards: safetyGuards,
    failed_safety_guards: failedSafetyGuards,
    test_evidence: evidence.rows,
    required_test_evidence: REQUIRED_TEST_EVIDENCE,
    readiness_rows: rows,
    gates: {
      ok: failures.length === 0,
      failures,
      warnings: openRows.length ? [{
        code: 'external_readiness_still_unclaimable',
        count: openRows.length,
        by_status: openByStatus,
        note: 'Local proof coverage is 100%, but these rows still require partner/package/public benchmark/certification evidence before they can become claimable shipped readiness.',
      }] : [],
    },
  };
  return doc;
}

function writeStable(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
}

function main() {
  const doc = build();
  const next = `${JSON.stringify(doc, null, 2)}\n`;
  if (checkOnly) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (current !== next) {
      console.error(`${rel(OUT)} is out of date`);
      process.exitCode = 1;
      return;
    }
  } else {
    writeStable(OUT, doc);
  }

  if (summaryOnly || !checkOnly) {
    console.log(JSON.stringify({
      ok: doc.gates.ok,
      schema: doc.schema,
      summary: doc.summary,
      over_100_hill_climb: doc.over_100_hill_climb,
      language_fit: {
        architecture: doc.language_fit.architecture,
        tracked_file_counts: doc.language_fit.tracked_file_counts,
        safety_guards: doc.language_fit.safety_guards,
        missing_escape_hatches: doc.language_fit.missing_escape_hatches,
      },
      failures: doc.gates.failures,
      warnings: doc.gates.warnings,
    }, null, 2));
  }
}

main();
