#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'internal', 'wrapper-cli-matrix.json');
const SCHEMA = 'kolm.wrapper_cli_matrix.v1';
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
  return [...src.matchAll(/^export\s+(async\s+)?(function|const|class)\s+([A-Za-z_$][\w$]*)/gm)]
    .map((m) => ({
      name: m[3],
      kind: m[2],
      async: !!m[1],
      line: lineNumber(src, m.index),
    }))
    .sort((a, b) => a.line - b.line);
}

function extractFunctions(src) {
  return [...src.matchAll(/^(export\s+)?(async\s+)?function\s+([A-Za-z_$][\w$]*)\(/gm)]
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
    'WRAPPER_CLI_VERSION',
    'GATEWAY_VERBS',
    'CAPTURES_VERBS',
    'RECEIPTS_VERBS',
    'NAMESPACE_WRAPPER_VERBS',
    'gatewayStart',
    'gatewayHealth',
    'gatewayProviders',
    'gatewayRoutes',
    'gatewayStatus',
    'gatewayCall',
    'gatewaySimulateOverflow',
    'capturesList',
    'capturesInspect',
    'capturesApprove',
    'capturesReject',
    'capturesQuarantine',
    'capturesStats',
    'capturesExport',
    'capturesPurge',
    'capturesSeed',
    'receiptsVerify',
    'receiptsList',
    'receiptsExport',
    'receiptsStats',
    'receiptsRotateKey',
    'nsCreate',
    'nsConfig',
    'nsDeploy',
    'nsUndeploy',
    'nsRollback',
    'nsStatus',
    'gatewayHelp',
    'capturesHelp',
    'receiptsHelp',
    'namespaceWrapperHelp',
  ];
}

function tableRows(mod) {
  const tableDefs = [
    ['gateway', 'GATEWAY_VERBS', mod.GATEWAY_VERBS],
    ['captures', 'CAPTURES_VERBS', mod.CAPTURES_VERBS],
    ['receipts', 'RECEIPTS_VERBS', mod.RECEIPTS_VERBS],
    ['namespace', 'NAMESPACE_WRAPPER_VERBS', mod.NAMESPACE_WRAPPER_VERBS],
  ];
  const rows = [];
  for (const [family, table, obj] of tableDefs) {
    for (const [verb, spec] of Object.entries(obj || {})) {
      rows.push({
        family,
        table,
        verb,
        fn_name: spec && spec.fn && spec.fn.name ? spec.fn.name : null,
        help: spec && spec.help ? String(spec.help) : '',
      });
    }
  }
  return rows.sort((a, b) => a.family.localeCompare(b.family) || a.verb.localeCompare(b.verb));
}

function extractEndpoints(src) {
  const rows = [];
  const seen = new Set();
  for (const m of src.matchAll(/['"`](\/v1\/[^'"`]+)['"`]/g)) {
    const endpoint = m[1];
    if (seen.has(endpoint)) continue;
    seen.add(endpoint);
    rows.push({ endpoint, line: lineNumber(src, m.index) });
  }
  return rows.sort((a, b) => a.line - b.line);
}

function directTestEvidence() {
  const dir = path.join(ROOT, 'tests');
  const rows = [];
  const symbols = [
    'WRAPPER_CLI_VERSION',
    'GATEWAY_VERBS',
    'CAPTURES_VERBS',
    'RECEIPTS_VERBS',
    'NAMESPACE_WRAPPER_VERBS',
    'gatewayCall',
    'gatewayProviders',
    'gatewayRoutes',
    'gatewayStatus',
    'capturesList',
    'capturesExport',
    'capturesPurge',
    'capturesSeed',
    'receiptsVerify',
    'receiptsExport',
    'receiptsRotateKey',
    'nsCreate',
    'nsConfig',
    'nsDeploy',
    'nsStatus',
  ];
  for (const name of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
    const rel = `tests/${name}`;
    const body = read(rel);
    const sourceLock = body.includes('src/wrapper-cli.js') || body.includes('../src/wrapper-cli.js') || body.includes('wrapper-cli');
    const wrapperSuite = /^tests\/wrapper-/.test(rel);
    const cliWrapperRefs = (body.match(/\bkolm\s+(gateway|captures|receipts|namespace)\b/g) || []).length;
    const counts = {};
    for (const sym of symbols) counts[`${sym}_refs`] = (body.match(new RegExp(`\\b${sym}\\b`, 'g')) || []).length;
    const totalSymbolRefs = Object.values(counts).reduce((sum, n) => sum + n, 0);
    if (!sourceLock && !wrapperSuite && !cliWrapperRefs && !totalSymbolRefs) continue;
    rows.push({
      path: rel,
      source_lock: sourceLock,
      wrapper_suite: wrapperSuite,
      cli_wrapper_refs: cliWrapperRefs,
      total_symbol_refs: totalSymbolRefs,
      ...counts,
    });
  }
  return rows;
}

function requiredTestEvidence() {
  return [
    'tests/wrapper-smoke.test.js',
    'tests/wrapper-integration.test.js',
    'tests/wave683-capture-forget-contract.test.js',
    'tests/wave888L-blocker-9-fix.test.js',
    'tests/wave888L-blocker-10-fix.test.js',
    'tests/wave888i-capture-export-formats.test.js',
    'tests/wave888i-receipt-export.test.js',
    'tests/wave944-wrapper-cli-matrix.test.js',
  ];
}

function safetyGuards(src, cliSrc, mod, exports, commands) {
  const exportSet = new Set(exports.map((row) => row.name));
  const commandFnNames = commands.map((row) => row.fn_name).filter(Boolean);
  const uniqueCommands = new Set(commands.map((row) => `${row.family}:${row.verb}`));
  const rawParserIdx = src.indexOf('function _parseResponseText');
  const rawParserBlock = rawParserIdx >= 0 ? src.slice(rawParserIdx, src.indexOf('function _emit', rawParserIdx)) : '';
  return {
    wrapper_version_exported: mod.WRAPPER_CLI_VERSION === 'wrapper-f-v1' && src.includes("export const WRAPPER_CLI_VERSION = 'wrapper-f-v1'"),
    required_public_exports_present: requiredExports().every((name) => exportSet.has(name)),
    dispatcher_tables_frozen: ['GATEWAY_VERBS', 'CAPTURES_VERBS', 'RECEIPTS_VERBS', 'NAMESPACE_WRAPPER_VERBS'].every((name) => src.includes(`export const ${name} = Object.freeze({`)),
    dispatcher_tables_have_help_and_functions: commands.every((row) => row.fn_name && row.help && row.help.length >= 8),
    command_functions_exported: commandFnNames.every((name) => exportSet.has(name)),
    command_count_current: uniqueCommands.size === 27,
    taxonomy_header_current: src.includes('27 CLI sub-verbs') && src.includes('Verb taxonomy (27 sub-verbs)'),
    cli_gateway_delegates_to_wrapper_table: cliSrc.includes('mod.GATEWAY_VERBS[sub]') && cliSrc.includes('GATEWAY_VERBS[sub].fn'),
    cli_captures_delegates_to_wrapper_table: cliSrc.includes('mod.CAPTURES_VERBS[csub]') && cliSrc.includes('CAPTURES_VERBS[csub].fn'),
    cli_receipts_delegates_to_wrapper_table: cliSrc.includes('wmod.RECEIPTS_VERBS[rsub]') && cliSrc.includes('RECEIPTS_VERBS[rsub].fn'),
    cli_namespace_delegates_to_wrapper_table: cliSrc.includes('wmod.NAMESPACE_WRAPPER_VERBS[sub]') && cliSrc.includes('NAMESPACE_WRAPPER_VERBS[sub].fn'),
    local_namespace_state_machine_present: src.includes('function _nsRead') && src.includes('function _nsWrite') && src.includes('namespaces.json') && ['nsCreate', 'nsConfig', 'nsDeploy', 'nsUndeploy', 'nsRollback', 'nsStatus'].every((name) => exportSet.has(name)),
    local_provider_and_route_fallbacks_present: src.includes("source: 'local-registry'") && src.includes("source: 'local-default'") && src.includes('defaultRoutes'),
    missing_api_key_envelope_nonfatal: src.includes("error: 'missing_api_key'") && src.includes('process.exitCode = 2') && src.includes('return null'),
    bounded_raw_server_error_bodies: rawParserBlock.includes('body.slice(0, 4096)') && rawParserBlock.includes('_raw_truncated') && !/JSON\.parse\(text\)[\s\S]{0,80}_raw:\s*text/.test(src),
    stream_non_2xx_body_bounded: src.includes("error: 'stream_non_2xx'") && src.includes('body: text.slice(0, 4096)'),
    gateway_call_redaction_receipt_capture_pipeline: src.includes("pii.applyMode({ text: flags.message") && src.includes('buildAndSignReceipt') && src.includes('captures.jsonl') && src.includes('prev_chain_hash'),
    capture_purge_requires_confirm_for_namespace: src.includes('bulk_purge_requires_confirm') && src.includes('pass --confirm to acknowledge namespace-wide purge'),
    receipt_offline_verify_path_present: src.includes('--offline') && src.includes("mode: 'offline'") && src.includes('verifyReceipt(receipt)') && src.includes('verify: v'),
    receipt_rotate_key_local_audit_present: src.includes("receiptsRotateKey") && src.includes("rotate-key") && src.includes('overlap_days'),
    help_functions_derive_from_tables: ['gatewayHelp', 'capturesHelp', 'receiptsHelp', 'namespaceWrapperHelp'].every((name) => src.includes(`export function ${name}()`)) && src.includes('Object.entries(GATEWAY_VERBS)') && src.includes('Object.entries(CAPTURES_VERBS)') && src.includes('Object.entries(RECEIPTS_VERBS)') && src.includes('Object.entries(NAMESPACE_WRAPPER_VERBS)'),
  };
}

async function buildMatrix() {
  const src = read('src/wrapper-cli.js');
  const cliSrc = read('cli/kolm.js');
  const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'wrapper-cli.js')).href + `?matrix=${Date.now()}`);
  const exports = extractExports(src);
  const exportNames = new Set(exports.map((row) => row.name));
  const missingRequiredExports = requiredExports().filter((name) => !exportNames.has(name));
  const functions = extractFunctions(src);
  const commands = tableRows(mod);
  const endpoints = extractEndpoints(src);
  const tests = directTestEvidence();
  const requiredTests = requiredTestEvidence();
  const evidenceSet = new Set(tests.map((row) => row.path));
  const missingTests = requiredTests.filter((rel) => !evidenceSet.has(rel));
  const guards = safetyGuards(src, cliSrc, mod, exports, commands);
  const failedGuards = Object.entries(guards).filter(([, ok]) => !ok).map(([name]) => name);
  const familyCounts = {};
  for (const row of commands) familyCounts[row.family] = (familyCounts[row.family] || 0) + 1;
  const duplicateCommands = [];
  const seen = new Set();
  for (const row of commands) {
    const key = `${row.family}:${row.verb}`;
    if (seen.has(key)) duplicateCommands.push(key);
    seen.add(key);
  }

  const summary = {
    wrapper_bytes: Buffer.byteLength(src),
    wrapper_lines: src.split(/\r?\n/).length,
    export_count: exports.length,
    function_count: functions.length,
    command_family_count: Object.keys(familyCounts).length,
    command_count: commands.length,
    gateway_command_count: familyCounts.gateway || 0,
    captures_command_count: familyCounts.captures || 0,
    receipts_command_count: familyCounts.receipts || 0,
    namespace_command_count: familyCounts.namespace || 0,
    duplicate_command_count: duplicateCommands.length,
    endpoint_count: endpoints.length,
    required_test_evidence_count: requiredTests.length,
    direct_test_evidence_count: tests.length,
    missing_required_exports: missingRequiredExports.length,
    failed_safety_guards: failedGuards.length,
    missing_test_evidence: missingTests.length,
  };

  const failures = [];
  if (missingRequiredExports.length) failures.push({ gate: 'required_exports', missing: missingRequiredExports });
  if (summary.command_family_count !== 4) failures.push({ gate: 'command_families', count: summary.command_family_count });
  if (summary.command_count !== 27) failures.push({ gate: 'command_count', count: summary.command_count });
  if (summary.duplicate_command_count) failures.push({ gate: 'duplicate_commands', duplicates: duplicateCommands });
  if (summary.endpoint_count < 13) failures.push({ gate: 'endpoint_coverage', count: summary.endpoint_count });
  if (failedGuards.length) failures.push({ gate: 'wrapper_cli_safety_guards', guards: failedGuards });
  if (missingTests.length) failures.push({ gate: 'test_evidence', missing: missingTests });

  return {
    schema: SCHEMA,
    updated_at: UPDATED_AT,
    purpose: 'Generated contract matrix for the wrapper CLI boundary: gateway/captures/receipts/namespace command tables, CLI delegation, local-first namespace state, capture/receipt safety controls, bounded server-error envelopes, and direct test evidence.',
    sources: [
      'src/wrapper-cli.js',
      'cli/kolm.js',
      ...requiredTests,
    ],
    summary,
    exports,
    required_exports: requiredExports(),
    missing_required_exports: missingRequiredExports,
    functions,
    command_families: Object.entries(familyCounts).map(([family, count]) => ({ family, count })).sort((a, b) => a.family.localeCompare(b.family)),
    commands,
    duplicate_commands: duplicateCommands,
    endpoints,
    public_return_shapes: {
      wrapper_success_envelope: ['ok', 'version'],
      wrapper_error_envelope: ['ok', 'error', 'hint', 'version'],
      gateway_call_envelope: ['choices', 'route_decision', 'fallback_reason', 'capture_eligible', 'attempt', 'provider', 'elapsed_us', 'namespace', 'kolm_meta'],
      namespace_envelope: ['ok', 'action', 'slug', 'mode', 'config', 'server', 'version'],
      receipt_export_envelope: ['ok', 'written', 'out', 'format', 'namespace', 'route', 'version'],
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
      console.error('wrapper-cli-matrix: docs/internal/wrapper-cli-matrix.json is out of date');
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
    console.log(`wrapper-cli-matrix: ${action} docs/internal/wrapper-cli-matrix.json commands=${matrix.summary.command_count} failures=${matrix.gates.failures.length}`);
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
