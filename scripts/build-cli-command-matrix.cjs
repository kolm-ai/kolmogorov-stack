#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'internal', 'cli-command-matrix.json');
const SCHEMA = 'kolm.cli_command_matrix.v1';
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

function mainSwitchBlock(src) {
  const start = src.indexOf('switch (cmd)');
  const tail = start >= 0 ? src.slice(start) : '';
  const defaultMatch = /^      default:/gm.exec(tail);
  const end = defaultMatch ? start + defaultMatch.index : -1;
  return start >= 0 && end > start ? { text: src.slice(start, end), start } : { text: '', start: -1 };
}

function familyFor(verb) {
  if (['login', 'logout', 'signup', 'whoami', 'keys', 'key', 'team', 'org', 'vault', 'billing'].includes(verb)) return 'identity_access';
  if (['compile', 'build', 'make', 'ship', 'verify', 'inspect', 'diff', 'eject', 'passport', 'assurance', 'procurement', 'export'].includes(verb)) return 'compile_artifact';
  if (['run', 'serve', 'runtime', 'gateway', 'wrapper', 'chat', 'chat-tui', 'instant', 'ask', 'assistant', 'tui', 'play'].includes(verb)) return 'runtime_serving';
  if (['capture', 'captures', 'dataset', 'label', 'labels', 'lake', 'privacy', 'media', 'redact', 'anonymize', 'tail', 'opportunities'].includes(verb)) return 'capture_data';
  if (['train', 'distill', 'quantize', 'models', 'gpu', 'bench', 'benchmark', 'score', 'eval', 'bakeoff', 'kolmbench', 'kb'].includes(verb)) return 'training_eval';
  if (['cloud', 'compute', 'remote', 'deploy', 'devices', 'device', 'fleet', 'tunnel', 'airgap', 'bundle', 'pack', 'unpack', 'install-device'].includes(verb)) return 'infra_device';
  if (['audit', 'auditor', 'audit-export', 'sigstore-attest', 'attest', 'receipts', 'receipt', 'evidence', 'compliance', 'cert', 'regulatory', 'reg', 'ai-act', 'aiact', 'sbom'].includes(verb)) return 'governance_security';
  if (['extension', 'ext', 'plugin', 'sdk', 'install', 'completion', 'version', 'update', 'upgrade', 'doctor', 'help', 'surfaces', 'packages', 'package', 'hf', 'huggingface'].includes(verb)) return 'developer_distribution';
  return 'platform_misc';
}

function extractDispatcherCases(src) {
  const block = mainSwitchBlock(src);
  const rows = [];
  for (const m of block.text.matchAll(/^      case ['"]([^'"]+)['"]:/gm)) {
    const verb = m[1];
    rows.push({
      verb,
      family: familyFor(verb),
      line: lineNumber(src, block.start + m.index),
    });
  }
  rows.sort((a, b) => a.verb.localeCompare(b.verb));
  return rows;
}

function extractCommandFunctions(src) {
  return [...src.matchAll(/^async function (cmd[A-Za-z0-9_]+)\s*\(/gm)]
    .map((m) => ({ name: m[1], line: lineNumber(src, m.index) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function extractCompletionVerbs(src) {
  const out = new Set();
  const literal = src.match(/const COMPLETION_VERBS = \[([\s\S]*?)\];/);
  if (literal) {
    for (const m of literal[1].matchAll(/['"]([^'"]+)['"]/g)) out.add(m[1]);
  }
  for (const push of src.matchAll(/COMPLETION_VERBS\.push\(([\s\S]*?)\);/g)) {
    for (const m of push[1].matchAll(/['"]([^'"]+)['"]/g)) out.add(m[1]);
  }
  for (const loop of src.matchAll(/for \(const verb of \[([\s\S]*?)\]\) \{\s*if \(!COMPLETION_VERBS\.includes\(verb\)\) COMPLETION_VERBS\.push\(verb\);/g)) {
    for (const m of loop[1].matchAll(/['"]([^'"]+)['"]/g)) out.add(m[1]);
  }
  return [...out].sort();
}

function commandVerb(command) {
  const m = String(command || '').trim().match(/^kolm\s+([^\s]+)/);
  return m ? m[1] : null;
}

function extractProductCli(graph) {
  const rows = [];
  for (const journey of graph.journeys || []) {
    for (const command of journey.cli || []) {
      rows.push({
        command,
        journey_id: journey.id,
        source_field: 'journey.cli',
        verb: commandVerb(command),
      });
    }
  }
  return rows.sort((a, b) => a.command.localeCompare(b.command) || a.journey_id.localeCompare(b.journey_id));
}

function extractProofCli(graph) {
  const rows = [];
  for (const journey of graph.journeys || []) {
    for (const command of journey.proof_commands || []) {
      const verb = commandVerb(command);
      if (!verb) continue;
      rows.push({
        command,
        journey_id: journey.id,
        source_field: 'journey.proof_commands',
        verb,
      });
    }
  }
  return rows.sort((a, b) => a.command.localeCompare(b.command) || a.journey_id.localeCompare(b.journey_id));
}

function safetyGuards(src) {
  const resolveIdx = src.indexOf('resolveExtension([cmd, ...rest]');
  const suggestIdx = src.indexOf('suggestVerb(cmd, COMPLETION_VERBS)');
  return {
    output_flags_mutually_exclusive: src.includes('--plain and --json are mutually exclusive'),
    no_assistant_stripped_before_dispatch: src.includes("filtered.includes('--no-assistant')") && src.includes("filtered.filter(a => a !== '--no-assistant')"),
    extension_shadow_guard: src.includes('collides_with_core') && src.includes('COMPLETION_VERBS.includes(name)'),
    extension_resolution_precedes_suggestion: resolveIdx >= 0 && suggestIdx > resolveIdx,
    with_error_context_wrapper: /async function withErrorContext\(verb, fn\)/.test(src),
    canonical_exit_codes: /const EXIT = \{[\s\S]*BAD_ARGS[\s\S]*MISSING_PREREQ[\s\S]*EXECUTION[\s\S]*NOT_FOUND/.test(src),
    unknown_command_suggests_known_verb: src.includes('unknown command:') && src.includes('did you mean: kolm '),
    root_help_and_noninteractive_fallback: src.includes("case undefined:") && src.includes('KOLM_NO_INTERACTIVE'),
  };
}

function testEvidence() {
  const required = [
    'tests/finalized-c11-cli-tui-dx-contract.test.js',
    'tests/wave921-cli-dx.test.js',
    'tests/sota-cli.test.js',
    'tests/wrapper-integration.test.js',
    'tests/wrapper-smoke.test.js',
  ];
  return required.map((rel) => ({ path: rel, present: fs.existsSync(path.join(ROOT, rel)) }));
}

function buildMatrix() {
  const cliSrc = read('cli/kolm.js');
  const packageJson = readJson('package.json');
  const graph = readJson('public/product-graph.json');
  const cases = extractDispatcherCases(cliSrc);
  const caseSet = new Set(cases.map((row) => row.verb));
  const commandFunctions = extractCommandFunctions(cliSrc);
  const completionVerbs = extractCompletionVerbs(cliSrc);
  const completionSet = new Set(completionVerbs);
  const productCli = extractProductCli(graph).map((row) => ({ ...row, dispatch_present: caseSet.has(row.verb) }));
  const proofCli = extractProofCli(graph).map((row) => ({ ...row, dispatch_present: caseSet.has(row.verb) }));
  const productVerbs = [...new Set(productCli.map((row) => row.verb).filter(Boolean))].sort();
  const proofVerbs = [...new Set(proofCli.map((row) => row.verb).filter(Boolean))].sort();
  const missingProductVerbs = productVerbs.filter((verb) => !caseSet.has(verb));
  const missingProofVerbs = proofVerbs.filter((verb) => !caseSet.has(verb));
  const completionWithoutDispatch = completionVerbs.filter((verb) => !caseSet.has(verb) && !['help'].includes(verb));
  const dispatchWithoutCompletion = cases.map((row) => row.verb).filter((verb) => !completionSet.has(verb) && !verb.startsWith('-'));
  const guards = safetyGuards(cliSrc);
  const failedGuards = Object.entries(guards).filter(([, ok]) => !ok).map(([name]) => name);
  const tests = testEvidence();
  const missingTests = tests.filter((row) => !row.present).map((row) => row.path);

  const dispatcherRows = cases.map((row) => ({
    ...row,
    in_completion_verbs: completionSet.has(row.verb),
    in_product_graph_cli: productVerbs.includes(row.verb),
    in_product_graph_proof: proofVerbs.includes(row.verb),
  }));

  const familyCounts = {};
  for (const row of dispatcherRows) familyCounts[row.family] = (familyCounts[row.family] || 0) + 1;

  const summary = {
    cli_bytes: Buffer.byteLength(cliSrc),
    cli_lines: cliSrc.split(/\r?\n/).length,
    dispatcher_case_count: cases.length,
    dispatcher_family_count: Object.keys(familyCounts).length,
    command_function_count: commandFunctions.length,
    completion_verb_count: completionVerbs.length,
    product_graph_cli_commands: productCli.length,
    product_graph_cli_verbs: productVerbs.length,
    product_graph_proof_cli_commands: proofCli.length,
    product_graph_proof_cli_verbs: proofVerbs.length,
    package_bin_ok: packageJson.bin && packageJson.bin.kolm === 'cli/kolm.js',
    missing_product_graph_verbs: missingProductVerbs.length,
    missing_product_graph_proof_verbs: missingProofVerbs.length,
    failed_safety_guards: failedGuards.length,
    missing_test_evidence: missingTests.length,
    completion_without_dispatch: completionWithoutDispatch.length,
    dispatch_without_completion: dispatchWithoutCompletion.length,
  };

  const failures = [];
  if (!summary.package_bin_ok) failures.push({ gate: 'package_bin', expected: 'cli/kolm.js', actual: packageJson.bin && packageJson.bin.kolm });
  if (summary.dispatcher_case_count < 100) failures.push({ gate: 'dispatcher_cases', count: summary.dispatcher_case_count });
  if (summary.command_function_count < 150) failures.push({ gate: 'command_functions', count: summary.command_function_count });
  if (graph.counts.cli_commands !== 64 || summary.product_graph_cli_commands !== graph.counts.cli_commands) {
    failures.push({ gate: 'product_graph_cli_count', expected: graph.counts.cli_commands, actual: summary.product_graph_cli_commands });
  }
  if (missingProductVerbs.length) failures.push({ gate: 'product_graph_cli_dispatch', missing: missingProductVerbs });
  if (missingProofVerbs.length) failures.push({ gate: 'product_graph_proof_dispatch', missing: missingProofVerbs });
  if (failedGuards.length) failures.push({ gate: 'cli_safety_guards', guards: failedGuards });
  if (missingTests.length) failures.push({ gate: 'cli_test_evidence', missing: missingTests });

  const warnings = [];
  if (completionWithoutDispatch.length) warnings.push({ gate: 'completion_without_dispatch', count: completionWithoutDispatch.length, sample: completionWithoutDispatch.slice(0, 20) });
  if (dispatchWithoutCompletion.length) warnings.push({ gate: 'dispatch_without_completion', count: dispatchWithoutCompletion.length, sample: dispatchWithoutCompletion.slice(0, 20) });
  if (!fs.existsSync(path.join(ROOT, 'public', 'docs', 'cli'))) warnings.push({ gate: 'public_cli_docs_directory_absent', note: 'CLI contract currently binds dispatcher/product-graph/tests, not per-verb public docs pages.' });

  return {
    schema: SCHEMA,
    updated_at: UPDATED_AT,
    sources: [
      'cli/kolm.js',
      'package.json',
      'public/product-graph.json',
      ...tests.map((row) => row.path),
    ],
    summary,
    gates: {
      ok: failures.length === 0,
      failures,
      warnings,
    },
    package_bin: {
      kolm: packageJson.bin && packageJson.bin.kolm,
    },
    dispatcher_family_counts: familyCounts,
    dispatcher_cases: dispatcherRows,
    command_functions: commandFunctions,
    completion_verbs: completionVerbs,
    product_graph_cli_commands: productCli,
    product_graph_proof_commands: proofCli,
    missing_product_graph_verbs: missingProductVerbs,
    missing_product_graph_proof_verbs: missingProofVerbs,
    safety_guards: guards,
    test_evidence: tests,
  };
}

function main() {
  const matrix = buildMatrix();
  const body = stableStringify(matrix);
  if (CHECK) {
    const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (existing !== body) {
      console.error('cli-command-matrix: docs/internal/cli-command-matrix.json is out of date');
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
    console.log(`cli-command-matrix: ${action} docs/internal/cli-command-matrix.json dispatcher=${matrix.summary.dispatcher_case_count} product_cli=${matrix.summary.product_graph_cli_commands} failures=${matrix.gates.failures.length}`);
  }
  if (!matrix.gates.ok) process.exit(1);
}

try {
  main();
} catch (err) {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
}
