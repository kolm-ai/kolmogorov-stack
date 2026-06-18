#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'internal', 'tui-workbench-matrix.json');
const SCHEMA = 'kolm.tui_workbench_matrix.v1';
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

function extractImports(src) {
  return [...src.matchAll(/^import\s+(?:[\s\S]*?\s+from\s+)?'([^']+)'/gm)]
    .map((m) => ({
      specifier: m[1],
      line: lineNumber(src, m.index),
      builtin: m[1].startsWith('node:'),
    }))
    .sort((a, b) => a.line - b.line || a.specifier.localeCompare(b.specifier));
}

function extractEnvRefs(src) {
  return [...new Set([...src.matchAll(/\bprocess\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
}

function requiredExports() {
  return ['realInfer', 'runTui', '__test__'];
}

function requiredTestSurface() {
  return [
    'readZipEntries',
    'readZipEntry',
    'parseKolm',
    'parseKolmStreamed',
    'timingSafeEq',
    'mintSessionToken',
    'startServe',
    'tunePane',
    'evalPane',
    'curatePane',
    'distillPane',
  ];
}

function requiredTestEvidence() {
  return [
    'tests/finalized-c11-cli-tui-dx-contract.test.js',
    'tests/path-to-100-w1-tui-real-runner.test.js',
    'tests/sota-tui.test.js',
    'tests/wave949-tui-workbench-matrix.test.js',
  ];
}

function extractTestSurface(src) {
  const m = /export\s+const\s+__test__\s*=\s*{([\s\S]*?)^};/m.exec(src);
  if (!m) return [];
  return [...m[1].matchAll(/^\s*([A-Za-z_$][\w$]*)\s*,?\s*$/gm)]
    .map((x) => x[1])
    .sort();
}

function rowFromDef(src, [id, owner, evidence]) {
  return {
    id,
    owner,
    present: evidence.every((needle) => src.includes(needle)),
    line: lineNumber(src, src.indexOf(owner)),
    evidence,
  };
}

function commandRows(src) {
  const defs = [
    ['help', 'helpScreen', ["cmd === 'help'", 'helpScreen()']],
    ['exit', 'rl.close', ["cmd === 'exit'", 'rl.close()']],
    ['clear', 'clear', ["cmd === 'clear'", 'clear()']],
    ['drop', 'state.artifact = null', ["cmd === 'drop'", 'state.artifact = null']],
    ['recipe', 'state.artifact.recipes', ["cmd === 'recipe'", 'state.artifact.recipes']],
    ['receipt', 'state.artifact.receipt', ["cmd === 'receipt'", 'state.artifact.receipt']],
    ['eval', 'evalPane', ["cmd === 'eval'", 'await evalPane(state.artifact)']],
    ['serve', 'startServe', ["cmd === 'serve'", 'mintSessionToken()', 'startServe(state.artifact']],
    ['stop', 'state.server.close', ["cmd === 'stop'", 'state.server.close()']],
    ['run', 'runPrompt', ["cmd === 'run'", 'await runPrompt(state.artifact, arg)']],
    ['tune', 'tunePane', ["cmd === 'tune'", 'await tunePane(state.artifact']],
    ['distill', 'distillPane', ["cmd === 'distill'", 'await distillPane(state.artifact']],
    ['curate', 'curatePane', ["cmd === 'curate'", 'await curatePane(state.artifact']],
    ['drag_drop_path', 'looksLikeKolmPath', ['looksLikeKolmPath(raw)', 'parseKolm(dropped)']],
    ['bare_prompt_run', 'runPrompt', ['await runPrompt(state.artifact, raw)', 'drag a .kolm to load']],
  ];
  return defs.map((def) => rowFromDef(src, def));
}

function zipReaderPhases(src) {
  const defs = [
    ['classic_eocd_scan', 'readZipEntries', ['0x06054b50', 'not a zip (no EOCD)', 'cdSize', 'cdOff']],
    ['zip64_extra_resolution', 'parseZip64Extra', ['parseZip64Extra', '0x0001', 'uncompSize', 'localOff']],
    ['zip64_eocd_locator', 'readZipEntries', ['0x07064b50', '0x06064b50', 'readU64LE(buf, locOff + 8)']],
    ['local_entry_decode', 'readZipEntry', ['0x04034b50', 'zlib.inflateRawSync(data)', 'unsupported zip method']],
    ['json_entry_decode', 'readJSONFromZip', ['readJSONFromZip', "JSON.parse(raw.toString('utf8'))"]],
    ['streamed_tail_parse', 'parseKolmStreamed', ['TAIL_WINDOW', 'readJSONStreamed', 'CD outside tail window']],
    ['large_artifact_streaming_guard', 'parseKolm', ['if (sizeBytes > SMALL_FILE)', 'parseKolmStreamed(filePath, sizeBytes)', 'fs.readFileSync(filePath)']],
  ];
  return defs.map((def) => rowFromDef(src, def));
}

function serveGuardRows(src) {
  const defs = [
    ['loopback_bind', 'startServe', ["server.listen(port, '127.0.0.1'"]],
    ['bearer_required_by_default', 'authorized', ['const token = opts.token || null', 'if (unsafeOpen) return true', 'KOLM_E_UNAUTHORIZED']],
    ['constant_time_token_compare', 'timingSafeEq', ['crypto.timingSafeEqual', 'timingSafeEq(m[1].trim(), token)']],
    ['entropy_backed_session_token', 'mintSessionToken', ['crypto.randomBytes(24)', "toString('base64url')"]],
    ['cors_allowlist_only', 'allowOrigin', ['allowOrigin && reqOrigin === allowOrigin', 'Access-Control-Allow-Origin', 'Vary']],
    ['json_body_validation', 'JSON.parse', ["invalid json", 'input or messages required']],
    ['honest_runtime_error_envelope', 'realInfer', ['error_code: r.error_code', 'KOLM_E_RUN_FAILED', '_kolm']],
  ];
  return defs.map((def) => rowFromDef(src, def));
}

function moduleBridgeRows(src) {
  const defs = [
    ['artifact_runner_real_infer', 'realInfer', ["import('../src/artifact-runner.js')", 'runArtifact(art.filePath, prompt)', "source: 'runtime:'"]],
    ['artifact_runner_eval', 'evalPane', ['evalArtifact', 'embedded held-out set', 'p50_latency_us']],
    ['tune_lifecycle', 'tunePane', ['tune.initAdapter', 'tune.runTuneStep', 'tune.promoteRevision']],
    ['data_curate_default', 'curatePane', ["import('../src/data-curate.js')", 'curateDefault(pairs', 'captures.jsonl']],
    ['distill_from_captures', 'distillPane', ['await curatePane(art, rest)', 'tune.runTuneStep', 'tune.evalRevision']],
  ];
  return defs.map((def) => rowFromDef(src, def));
}

function entrypointGuardRows(src, cli) {
  const localDefs = [
    ['plain_help_no_alt_screen', 'workbenchUsage', ['workbenchUsage()', 'process.stdout.write(workbenchUsage())', 'process.exit(0)']],
    ['unknown_flag_rejected', 'unknownFlag', ['unknown flag for workbench TUI', 'process.exit(1)']],
    ['missing_path_rejected_before_tty', 'startPath', ['error: not found:', 'process.exit(5)']],
    ['non_tty_rejected_before_alt_screen', 'process.stdout.isTTY', ['!process.stdout.isTTY', 'requires a TTY', 'process.exit(3)']],
  ].map((def) => rowFromDef(src, def));
  const cliDefs = [
    {
      id: 'root_cli_advertises_dashboard_workbench_split',
      owner: 'cli/kolm.js',
      present: cli.includes('operator dashboard; use --workbench for artifact training')
        && cli.includes('artifact workbench TUI')
        && cli.includes('kolm-tui.mjs'),
      line: lineNumber(cli, cli.indexOf('operator dashboard; use --workbench for artifact training')),
      evidence: ['operator dashboard; use --workbench for artifact training', 'artifact workbench TUI', 'kolm-tui.mjs'],
    },
  ];
  return [...localDefs, ...cliDefs];
}

function directTestEvidence() {
  const dir = path.join(ROOT, 'tests');
  const symbols = [...requiredExports(), ...requiredTestSurface()];
  const rows = [];
  for (const name of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
    const rel = `tests/${name}`;
    const body = read(rel);
    const sourceLock = body.includes('cli/kolm-tui.mjs') || body.includes('../cli/kolm-tui.mjs') || body.includes('kolm-tui');
    const counts = {};
    for (const sym of symbols) counts[`${sym}_refs`] = (body.match(new RegExp(`\\b${sym}\\b`, 'g')) || []).length;
    const totalSymbolRefs = Object.values(counts).reduce((sum, n) => sum + n, 0);
    const workflowRefs = (body.match(/\bworkbench\b|\bZIP64\b|\bparseKolm\b|\bstartServe\b|\btimingSafeEq\b|\brealInfer\b|\btunePane\b|\bcuratePane\b|\bdistillPane\b|\bBearer\b|\bCORS\b/gi) || []).length;
    if (!sourceLock && !totalSymbolRefs && !workflowRefs) continue;
    rows.push({
      path: rel,
      source_lock: sourceLock,
      total_symbol_refs: totalSymbolRefs,
      workbench_workflow_refs: workflowRefs,
      ...counts,
    });
  }
  return rows;
}

function safetyGuards(src, cli, mod, exports, imports, envRefs, testSurface, commands, zipPhases, serveGuards, bridges, entrypointGuards, tests, requiredTests) {
  const exportSet = new Set(exports.map((row) => row.name));
  const testSurfaceSet = new Set(testSurface);
  const evidenceSet = new Set(tests.map((row) => row.path));
  const missingTests = requiredTests.filter((rel) => !evidenceSet.has(rel));
  const parseIdx = src.indexOf('async function parseKolm');
  const streamIdx = src.indexOf('if (sizeBytes > SMALL_FILE)', parseIdx);
  const bufferIdx = src.indexOf('fs.readFileSync(filePath)', parseIdx);
  const altInIdx = src.indexOf('process.stdout.write(ALT_BUFFER_IN)');
  const splashIdx = src.indexOf('await splash()');
  return {
    required_public_exports_present: requiredExports().every((name) => exportSet.has(name) && mod[name] != null),
    test_surface_exports_internal_primitives: requiredTestSurface().every((name) => testSurfaceSet.has(name)),
    static_imports_are_node_builtins: imports.every((row) => row.builtin),
    env_surface_is_empty: envRefs.length === 0,
    no_mock_inference_path: !/\bfunction\s+mockInfer\b|\bmockInfer\s*\(/.test(src) && src.includes('runArtifact(art.filePath, prompt)'),
    real_infer_fails_honestly: src.includes("source: 'error'") && src.includes("error_code: (e && e.code) || 'KOLM_E_RUN_FAILED'") && src.includes('never a fake success'),
    large_artifacts_stream_before_buffering: parseIdx >= 0 && streamIdx > parseIdx && bufferIdx > streamIdx,
    zip64_reader_handles_extra_and_locator: ['Z64_U32', 'Z64_U16', 'parseZip64Extra', '0x07064b50', '0x06064b50'].every((needle) => src.includes(needle)),
    serve_binds_loopback_and_auths_by_default: src.includes("server.listen(port, '127.0.0.1'") && src.includes('const unsafeOpen = !!opts.unsafeOpen') && src.includes('KOLM_E_UNAUTHORIZED'),
    cors_never_uses_wildcard_and_only_echoes_allowlist: src.includes('allowOrigin && reqOrigin === allowOrigin') && src.includes('Access-Control-Allow-Origin') && !src.includes("Access-Control-Allow-Origin', '*'"),
    session_tokens_are_random_and_constant_time_checked: src.includes('crypto.randomBytes(24)') && src.includes('crypto.timingSafeEqual') && src.includes('timingSafeEq(m[1].trim(), token)'),
    drag_drop_parser_strips_quotes_expands_home_and_requires_file: src.includes("v = v.slice(1, -1)") && src.includes('path.join(os.homedir()') && src.includes('fs.statSync(v).isFile()') && src.includes('/\\.kolm$/i.test(v)'),
    alt_screen_cleanup_registered_before_splash: altInIdx >= 0 && splashIdx > altInIdx && src.includes("process.on('exit'") && src.includes("process.on('SIGINT'") && src.includes('ALT_BUFFER_OUT + SHOW_CURSOR'),
    direct_entrypoint_refuses_automation_misuse: src.includes('unknown flag for workbench TUI') && src.includes('process.exit(5)') && src.includes('requires a TTY') && src.includes('process.exit(3)'),
    workbench_bridges_import_real_src_modules: ["import('../src/artifact-runner.js')", "import('../src/tune.js')", "import('../src/data-curate.js')"].every((needle) => src.includes(needle)),
    root_cli_keeps_play_workbench_split: cli.includes('operator dashboard; use --workbench for artifact training') && cli.includes('artifact workbench TUI'),
    all_expected_commands_present: commands.every((row) => row.present),
    all_expected_zip_phases_present: zipPhases.every((row) => row.present),
    all_expected_serve_guards_present: serveGuards.every((row) => row.present),
    all_expected_module_bridges_present: bridges.every((row) => row.present),
    all_expected_entrypoint_guards_present: entrypointGuards.every((row) => row.present),
    direct_evidence_covers_required_tests: missingTests.length === 0,
  };
}

async function buildMatrix() {
  const src = read('cli/kolm-tui.mjs');
  const cli = read('cli/kolm.js');
  const mod = await import(pathToFileURL(path.join(ROOT, 'cli', 'kolm-tui.mjs')).href + `?matrix=${Date.now()}`);
  const exports = extractExports(src);
  const functions = extractFunctions(src);
  const exportNames = new Set(exports.map((row) => row.name));
  const missingRequiredExports = requiredExports().filter((name) => !exportNames.has(name));
  const imports = extractImports(src);
  const envRefs = extractEnvRefs(src);
  const testSurface = extractTestSurface(src);
  const missingTestSurface = requiredTestSurface().filter((name) => !testSurface.includes(name));
  const commands = commandRows(src);
  const zipPhases = zipReaderPhases(src);
  const serveGuards = serveGuardRows(src);
  const bridges = moduleBridgeRows(src);
  const entrypointGuards = entrypointGuardRows(src, cli);
  const tests = directTestEvidence();
  const requiredTests = requiredTestEvidence();
  const evidenceSet = new Set(tests.map((row) => row.path));
  const missingTests = requiredTests.filter((rel) => !evidenceSet.has(rel));
  const guards = safetyGuards(src, cli, mod, exports, imports, envRefs, testSurface, commands, zipPhases, serveGuards, bridges, entrypointGuards, tests, requiredTests);
  const failedGuards = Object.entries(guards).filter(([, ok]) => !ok).map(([name]) => name);

  const summary = {
    tui_workbench_bytes: Buffer.byteLength(src),
    tui_workbench_lines: src.split(/\r?\n/).length,
    export_count: exports.length,
    function_count: functions.length,
    static_import_count: imports.length,
    env_ref_count: envRefs.length,
    test_surface_export_count: testSurface.length,
    command_count: commands.length,
    present_command_count: commands.filter((row) => row.present).length,
    zip_reader_phase_count: zipPhases.length,
    present_zip_reader_phase_count: zipPhases.filter((row) => row.present).length,
    serve_guard_count: serveGuards.length,
    present_serve_guard_count: serveGuards.filter((row) => row.present).length,
    module_bridge_count: bridges.length,
    present_module_bridge_count: bridges.filter((row) => row.present).length,
    direct_entrypoint_guard_count: entrypointGuards.length,
    present_direct_entrypoint_guard_count: entrypointGuards.filter((row) => row.present).length,
    required_test_evidence_count: requiredTests.length,
    direct_test_evidence_count: tests.length,
    missing_required_exports: missingRequiredExports.length,
    missing_test_surface_exports: missingTestSurface.length,
    failed_safety_guards: failedGuards.length,
    missing_test_evidence: missingTests.length,
  };

  const failures = [];
  if (missingRequiredExports.length) failures.push({ gate: 'required_exports', missing: missingRequiredExports });
  if (missingTestSurface.length) failures.push({ gate: 'test_surface_exports', missing: missingTestSurface });
  if (summary.present_command_count !== summary.command_count) failures.push({ gate: 'workbench_commands', missing: commands.filter((row) => !row.present).map((row) => row.id) });
  if (summary.present_zip_reader_phase_count !== summary.zip_reader_phase_count) failures.push({ gate: 'zip_reader_phases', missing: zipPhases.filter((row) => !row.present).map((row) => row.id) });
  if (summary.present_serve_guard_count !== summary.serve_guard_count) failures.push({ gate: 'serve_guards', missing: serveGuards.filter((row) => !row.present).map((row) => row.id) });
  if (summary.present_module_bridge_count !== summary.module_bridge_count) failures.push({ gate: 'module_bridges', missing: bridges.filter((row) => !row.present).map((row) => row.id) });
  if (summary.present_direct_entrypoint_guard_count !== summary.direct_entrypoint_guard_count) failures.push({ gate: 'direct_entrypoint_guards', missing: entrypointGuards.filter((row) => !row.present).map((row) => row.id) });
  if (summary.env_ref_count !== 0) failures.push({ gate: 'env_refs', refs: envRefs });
  if (failedGuards.length) failures.push({ gate: 'tui_workbench_safety_guards', guards: failedGuards });
  if (missingTests.length) failures.push({ gate: 'test_evidence', missing: missingTests });

  return {
    schema: SCHEMA,
    updated_at: UPDATED_AT,
    purpose: 'Generated contract matrix for cli/kolm-tui.mjs: .kolm workbench commands, pure ZIP/ZIP64 metadata parsing, large-artifact streaming, real signed-runtime inference, loopback REST safety, tune/eval/curate/distill bridges, direct entrypoint guards, and direct evidence coverage.',
    sources: [
      'cli/kolm-tui.mjs',
      'cli/kolm.js',
      'src/artifact-runner.js',
      'src/tune.js',
      'src/data-curate.js',
      ...requiredTests,
    ],
    summary,
    exports,
    required_exports: requiredExports(),
    missing_required_exports: missingRequiredExports,
    functions,
    static_imports: imports,
    env_refs: envRefs,
    test_surface_exports: testSurface,
    missing_test_surface_exports: missingTestSurface,
    workbench_commands: commands,
    zip_reader_phases: zipPhases,
    serve_guards: serveGuards,
    module_bridges: bridges,
    direct_entrypoint_guards: entrypointGuards,
    public_return_shapes: {
      realInfer: ['ok', 'text', 'source', 'latency_us', 'k_score', 'error_code'],
      parseKolm: ['filePath', 'fileName', 'sizeBytes', 'manifest', 'recipes', 'receipt', 'evals', 'entryCount', 'streamed'],
      startServe: ['http.Server bound to 127.0.0.1'],
      __test__: requiredTestSurface(),
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
      console.error('tui-workbench-matrix: docs/internal/tui-workbench-matrix.json is out of date');
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
    console.log(`tui-workbench-matrix: ${action} docs/internal/tui-workbench-matrix.json commands=${matrix.summary.present_command_count}/${matrix.summary.command_count} zip=${matrix.summary.present_zip_reader_phase_count}/${matrix.summary.zip_reader_phase_count} guards=${matrix.summary.failed_safety_guards}`);
  }

  if (!matrix.gates.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
