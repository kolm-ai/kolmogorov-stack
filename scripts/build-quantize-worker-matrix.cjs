#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'internal', 'quantize-worker-matrix.json');
const SCHEMA = 'kolm.quantize_worker_matrix.v1';
const UPDATED_AT = '2026-06-18';

const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const SUMMARY = args.has('--summary');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
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

function extractMethodChoices(src) {
  const m = src.match(/choices=\[([\s\S]*?)\]\)/);
  if (!m) return [];
  return [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]).sort();
}

function extractExperimentalMethods(src) {
  const m = src.match(/_EXPERIMENTAL_METHODS = frozenset\(\(([\s\S]*?)\)\)/);
  if (!m) return [];
  return [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]).sort();
}

function extractStableMethods(src) {
  const m = src.match(/"stable_methods": \[([\s\S]*?)\]/);
  if (!m) return [];
  return [...m[1].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]).sort();
}

function extractCliFlags(src) {
  const rows = [];
  for (const m of src.matchAll(/p\.add_argument\("([^"]+)"/g)) {
    rows.push({
      flag: m[1],
      line: lineNumber(src, m.index),
      opt_in: /trust-remote-code|calib-fp4|self-test-moe/.test(m[1]),
    });
  }
  return rows.sort((a, b) => a.flag.localeCompare(b.flag));
}

function extractRunFunctions(src) {
  return [...src.matchAll(/^def (run_[a-z0-9_]+|_run_exllamav2)\(/gm)]
    .map((m) => ({ name: m[1], line: lineNumber(src, m.index) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function methodDispatchCoverage(src, choices) {
  return choices.map((method) => {
    let dispatch = null;
    if (method === 'int4' || method === 'int8') dispatch = 'run_int_bnb';
    else {
      const re = new RegExp(`elif args\\.method == ["']${method}["']:\\s*\\n\\s*tool_info = (run_[a-z0-9_]+)\\(`);
      const m = src.match(re);
      dispatch = m ? m[1] : null;
    }
    return {
      method,
      dispatch_function: dispatch,
      dispatch_present: !!dispatch && (dispatch === 'run_int_bnb' || src.includes(`def ${dispatch}(`)),
    };
  }).sort((a, b) => a.method.localeCompare(b.method));
}

function extractReceiptFields(src) {
  const fields = new Set();
  const receiptStart = src.indexOf('receipt = {');
  const receiptEnd = src.indexOf('if fp4_calib_plan is not None:', receiptStart);
  if (receiptStart >= 0 && receiptEnd > receiptStart) {
    const block = src.slice(receiptStart, receiptEnd);
    for (const m of block.matchAll(/"([^"]+)":/g)) fields.add(m[1]);
  }
  for (const m of src.matchAll(/receipt\["([^"]+)"\]/g)) fields.add(m[1]);
  return [...fields].sort();
}

function extractSubprocessBoundaries(src) {
  const rows = [];
  const functionMatches = [...src.matchAll(/^def ([A-Za-z_][\w]*)\(/gm)];
  for (let i = 0; i < functionMatches.length; i++) {
    const m = functionMatches[i];
    const end = i + 1 < functionMatches.length ? functionMatches[i + 1].index : src.length;
    const block = src.slice(m.index, end);
    if (!block.includes('subprocess.run(')) continue;
    const envs = [...block.matchAll(/repo_env="([^"]+)"/g)].map((x) => x[1]);
    const modules = [...block.matchAll(/module_name="([^"]+)"/g)].map((x) => x[1]);
    const directModules = [...block.matchAll(/"-m",\s*"([^"]+)"/g)].map((x) => x[1]);
    rows.push({
      function: m[1],
      line: lineNumber(src, m.index),
      repo_envs: envs.sort(),
      module_names: [...modules, ...directModules].sort(),
      check_false: block.includes('subprocess.run(cmd, check=False)'),
      returncode_checked: block.includes('res.returncode != 0'),
    });
  }
  return rows.sort((a, b) => a.function.localeCompare(b.function));
}

function extractExitCodes(src) {
  const header = src.slice(0, src.indexOf('import argparse'));
  const rows = [];
  for (const m of header.matchAll(/^\s+(\d+)\s+([^\n]+)/gm)) {
    rows.push({ code: Number(m[1]), meaning: m[2].trim() });
  }
  return rows.sort((a, b) => a.code - b.code);
}

function workerPackageSummary() {
  const rootPkg = readJson('package.json');
  const workerPkg = readJson('workers/quantize/package.json');
  const req = read('workers/quantize/requirements.txt');
  const rootFlat = JSON.stringify(rootPkg.dependencies || {})
    + JSON.stringify(rootPkg.devDependencies || {})
    + JSON.stringify(rootPkg.optionalDependencies || {});
  const heavyDeps = ['torch', 'bitsandbytes', 'auto-gptq'];
  return {
    package_name: workerPkg.name,
    private: workerPkg.private === true,
    type: workerPkg.type,
    python_requires_count: Array.isArray(workerPkg.python && workerPkg.python.requires) ? workerPkg.python.requires.length : 0,
    requirements_include_heavy_deps: heavyDeps.every((dep) => req.includes(dep)),
    root_excludes_heavy_deps: heavyDeps.every((dep) => !rootFlat.includes(dep)),
  };
}

function safetyGuards(src) {
  const mainIdx = src.indexOf('def main():');
  const mainBlock = mainIdx >= 0 ? src.slice(mainIdx) : '';
  return {
    method_choices_argparse: src.includes('choices=["int4", "int8", "gptq", "awq"') && src.includes('"qat"'),
    experimental_methods_env_gated: src.includes('KOLM_ENABLE_EXPERIMENTAL_QUANTS') && src.includes('guard_experimental_method(args.method)'),
    stable_methods_fail_hint: src.includes('"stable_methods": ["int4", "int8", "gptq", "awq"]'),
    lazy_imports_per_method: src.includes('def run_int_bnb') && src.includes('except ImportError as e') && src.includes('missing python deps'),
    trust_remote_code_opt_in_and_receipted: src.includes('--trust-remote-code') && src.includes('action="store_true", default=False') && src.includes('"trust_remote_code": bool(args.trust_remote_code)'),
    input_path_and_config_required: mainBlock.includes('if not src.exists() or not src.is_dir()') && mainBlock.includes('no config.json'),
    receipt_hashes_input_and_output: src.includes('hash_input_tree') && src.includes('hash_output_tree') && src.includes('"input_tree_sha256"') && src.includes('"output_files_sha256"'),
    fp4_calibration_degrades_gracefully: src.includes('def run_fp4_calibration') && src.includes('calibration must never block quantize') && src.includes('return {"ok": False, "reason"'),
    mixed_precision_validates_and_warns: src.includes('load_mixed_precision_profile') && src.includes('compute_uniform_fallback_from_profile') && src.includes('mixed_precision_warnings'),
    moe_detection_gated_on_config: src.includes('moe_detection = detect_moe_config(str(src))') && src.includes('if moe_detection.get("is_moe")'),
    router_precision_sacred_fp16: src.includes('router_after_tag = "fp16"') && src.includes('SACRED'),
    self_test_moe_no_model_short_circuit: src.includes('--self-test-moe') && src.includes('before any --in/--out validation'),
    subprocess_returncodes_fail_loud: src.includes('subprocess.run(cmd, check=False)') && src.includes('res.returncode != 0') && src.includes('fail(4,'),
  };
}

function testEvidence() {
  const required = [
    'tests/wave195-quantize-worker.test.js',
    'tests/finalized-c5-turnkey-experimental-quant-runners.test.js',
    'tests/finalized-c5-real-layer-importance-mixed-precision.test.js',
    'tests/wave921-fp4-calib-trust-remote.test.js',
    'tests/wave921-moe-quantize.test.js',
    'tests/wave582-quantization-oracle.test.js',
    'tests/wave605-quantization-oracle-frontier.test.js',
    'tests/wave606-quant-accuracy-floor.test.js',
    'tests/wave613-fp4-calib-oracle.test.js',
    'tests/finalized-c5-accuracy-recovery-kscore-gate.test.js',
  ];
  return required.map((rel) => ({ path: rel, present: fs.existsSync(path.join(ROOT, rel)) }));
}

function buildMatrix() {
  const src = read('workers/quantize/scripts/quantize.py');
  const choices = extractMethodChoices(src);
  const experimental = extractExperimentalMethods(src);
  const stableMethods = extractStableMethods(src);
  const cliFlags = extractCliFlags(src);
  const runFunctions = extractRunFunctions(src);
  const dispatch = methodDispatchCoverage(src, choices);
  const receiptFields = extractReceiptFields(src);
  const subprocessBoundaries = extractSubprocessBoundaries(src);
  const exitCodes = extractExitCodes(src);
  const workerPackage = workerPackageSummary();
  const guards = safetyGuards(src);
  const failedGuards = Object.entries(guards).filter(([, ok]) => !ok).map(([name]) => name);
  const tests = testEvidence();
  const missingTests = tests.filter((row) => !row.present).map((row) => row.path);
  const missingDispatch = dispatch.filter((row) => !row.dispatch_present).map((row) => row.method);

  const requiredReceiptFields = [
    'ok',
    'method',
    'input_tree_sha256',
    'output_files_sha256',
    'duration_sec',
    'device',
    'python_version',
    'tool',
    'trust_remote_code',
    'finished_at',
    'fp4_calibration',
    'mixed_precision_profile',
    'mixed_precision_warnings',
    'mixed_precision_applied_bits',
    'mixed_precision_applied_group_size',
    'moe',
    'moe_detection',
  ];
  const missingReceiptFields = requiredReceiptFields.filter((field) => !receiptFields.includes(field));

  const summary = {
    quantize_bytes: Buffer.byteLength(src),
    quantize_lines: src.split(/\r?\n/).length,
    method_count: choices.length,
    stable_method_count: stableMethods.length,
    experimental_method_count: experimental.length,
    dispatch_covered_methods: dispatch.length - missingDispatch.length,
    run_function_count: runFunctions.length,
    cli_flag_count: cliFlags.length,
    receipt_field_count: receiptFields.length,
    required_receipt_field_gaps: missingReceiptFields.length,
    subprocess_boundary_count: subprocessBoundaries.length,
    exit_code_count: exitCodes.length,
    failed_safety_guards: failedGuards.length,
    missing_test_evidence: missingTests.length,
    worker_package_isolated: workerPackage.private && workerPackage.requirements_include_heavy_deps && workerPackage.root_excludes_heavy_deps,
  };

  const failures = [];
  if (summary.method_count !== 10) failures.push({ gate: 'method_count', expected: 10, actual: summary.method_count });
  if (summary.stable_method_count !== 4) failures.push({ gate: 'stable_methods', expected: 4, actual: summary.stable_method_count });
  if (summary.experimental_method_count !== 6) failures.push({ gate: 'experimental_methods', expected: 6, actual: summary.experimental_method_count });
  if (missingDispatch.length) failures.push({ gate: 'method_dispatch', missing: missingDispatch });
  if (summary.cli_flag_count < 13) failures.push({ gate: 'cli_flags', count: summary.cli_flag_count });
  if (missingReceiptFields.length) failures.push({ gate: 'receipt_fields', missing: missingReceiptFields });
  if (summary.subprocess_boundary_count < 4) failures.push({ gate: 'subprocess_boundaries', count: summary.subprocess_boundary_count });
  if (summary.exit_code_count < 4) failures.push({ gate: 'exit_codes', count: summary.exit_code_count });
  if (failedGuards.length) failures.push({ gate: 'quantize_safety_guards', guards: failedGuards });
  if (missingTests.length) failures.push({ gate: 'test_evidence', missing: missingTests });
  if (!summary.worker_package_isolated) failures.push({ gate: 'worker_package_isolation', worker_package: workerPackage });

  return {
    schema: SCHEMA,
    updated_at: UPDATED_AT,
    purpose: 'Generated contract matrix for the quantize worker boundary: method menu, CLI flags, reproducibility receipt, optimizer subprocesses, frontier quantization controls, worker isolation, and direct tests.',
    sources: [
      'workers/quantize/scripts/quantize.py',
      'workers/quantize/quantize.mjs',
      'workers/quantize/package.json',
      'workers/quantize/requirements.txt',
      'src/quantization-oracle.js',
      ...tests.map((row) => row.path),
    ],
    summary,
    methods: choices,
    stable_methods: stableMethods,
    experimental_methods: experimental,
    method_dispatch: dispatch,
    cli_flags: cliFlags,
    run_functions: runFunctions,
    receipt_fields: receiptFields,
    required_receipt_fields: requiredReceiptFields,
    missing_receipt_fields: missingReceiptFields,
    subprocess_boundaries: subprocessBoundaries,
    exit_codes: exitCodes,
    worker_package: workerPackage,
    safety_guards: guards,
    failed_safety_guards: failedGuards,
    test_evidence: tests,
    gates: {
      ok: failures.length === 0,
      failures,
      warnings: [],
    },
  };
}

function main() {
  const matrix = buildMatrix();
  const body = stableStringify(matrix);

  if (CHECK) {
    const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (existing !== body) {
      console.error('quantize-worker-matrix: docs/internal/quantize-worker-matrix.json is out of date');
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
    console.log(`quantize-worker-matrix: ${action} docs/internal/quantize-worker-matrix.json methods=${matrix.summary.method_count} flags=${matrix.summary.cli_flag_count} failures=${matrix.gates.failures.length}`);
  }

  if (!matrix.gates.ok) process.exit(1);
}

try {
  main();
} catch (err) {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
}
