#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'internal', 'intent-contract-matrix.json');
const SCHEMA = 'kolm.intent_contract_matrix.v1';
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

function blockBetween(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) return { block: '', start: -1, end: -1 };
  const end = src.indexOf(endMarker, start + startMarker.length);
  if (end < 0) return { block: src.slice(start), start, end: src.length };
  return { block: src.slice(start, end + endMarker.length), start, end };
}

function quotedStrings(block) {
  const out = [];
  for (const m of block.matchAll(/'((?:\\'|[^'])*)'/g)) out.push(m[1]);
  return out;
}

function extractExports(src) {
  const rows = [...src.matchAll(/^export\s+(async\s+)?(function|const|class)\s+([A-Za-z_$][\w$]*)/gm)]
    .map((m) => ({
      name: m[3],
      kind: m[2],
      async: !!m[1],
      line: lineNumber(src, m.index),
    }));
  for (const m of src.matchAll(/^export\s+default\b/gm)) {
    rows.push({ name: 'default', kind: 'default', async: false, line: lineNumber(src, m.index) });
  }
  return rows.sort((a, b) => a.line - b.line);
}

function requiredExports() {
  return [
    'VERB_DESCRIPTIONS',
    'listVerbs',
    'classifyIntent',
    'snapshotContext',
    'recommendNext',
    'expandToWorkflow',
  ];
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

function extractVerbCatalog(src, runtimeCatalog) {
  const { block, start } = blockBetween(src, 'export const VERB_DESCRIPTIONS = [', '\n];');
  const starts = [...block.matchAll(/^  \{\s*verb:\s*'([^']+)'/gm)];
  const rows = [];
  const phraseOwners = new Map();
  const phraseCollisions = [];
  if (Array.isArray(runtimeCatalog) && runtimeCatalog.length) {
    for (let i = 0; i < runtimeCatalog.length; i += 1) {
      const entry = runtimeCatalog[i] || {};
      const verb = String(entry.verb || '');
      const phrasings = Array.isArray(entry.phrasings) ? entry.phrasings.map(String) : [];
      const examples = Array.isArray(entry.examples) ? entry.examples.map(String) : [];
      for (const phrase of phrasings) {
        const key = phrase.toLowerCase();
        const first = phraseOwners.get(key);
        if (first && first !== verb) {
          phraseCollisions.push({ phrase, first_verb: first, second_verb: verb });
        } else {
          phraseOwners.set(key, verb);
        }
      }
      rows.push({
        verb,
        line: starts[i] ? lineNumber(src, start + starts[i].index) : null,
        phrasing_count: phrasings.length,
        example_count: examples.length,
        has_when: typeof entry.when === 'string' && entry.when.length > 0,
        has_desc: typeof entry.desc === 'string' && entry.desc.length > 0,
      });
    }
  } else {
    for (let i = 0; i < starts.length; i += 1) {
    const m = starts[i];
    const next = starts[i + 1];
    const entryEnd = next ? next.index : block.length;
    const entry = block.slice(m.index, entryEnd);
    const verb = m[1];
    const body = entry;
    const phrasingsBlock = (body.match(/phrasings:\s*\[([\s\S]*?)\]\s*,\s*examples:/) || [null, ''])[1];
    const examplesBlock = (body.match(/examples:\s*\[([\s\S]*?)\]/) || [null, ''])[1];
    const phrasings = quotedStrings(phrasingsBlock);
    const examples = quotedStrings(examplesBlock);
    for (const phrase of phrasings) {
      const key = phrase.toLowerCase();
      const first = phraseOwners.get(key);
      if (first && first !== verb) {
        phraseCollisions.push({ phrase, first_verb: first, second_verb: verb });
      } else {
        phraseOwners.set(key, verb);
      }
    }
      rows.push({
        verb,
        line: lineNumber(src, start + m.index),
        phrasing_count: phrasings.length,
        example_count: examples.length,
        has_when: /when:\s*'/.test(body),
        has_desc: /desc:\s*'/.test(body),
      });
    }
  }
  const seen = new Map();
  const duplicates = [];
  for (const row of rows) {
    if (seen.has(row.verb)) duplicates.push({ verb: row.verb, first_line: seen.get(row.verb), duplicate_line: row.line });
    else seen.set(row.verb, row.line);
  }
  return {
    rows,
    duplicates,
    phrase_collisions: phraseCollisions,
    phrasing_count: rows.reduce((sum, row) => sum + row.phrasing_count, 0),
    unique_phrasing_count: phraseOwners.size,
    example_count: rows.reduce((sum, row) => sum + row.example_count, 0),
  };
}

function extractRegexRules(src) {
  const { block, start } = blockBetween(src, 'const REGEX_RULES = [', '\n];\n\nfunction regexMatch');
  const rows = [];
  for (const m of block.matchAll(/^\s*pattern:\s*(\/[\s\S]*?\/[a-z]*),[\s\S]*?verb:\s*'([^']+)'/gm)) {
    const chunkStart = m.index;
    const chunk = block.slice(chunkStart, block.indexOf('\n  },', chunkStart) > chunkStart ? block.indexOf('\n  },', chunkStart) : chunkStart + m[0].length);
    rows.push({
      verb: m[2],
      line: lineNumber(src, start + m.index),
      pattern: m[1].replace(/\s+/g, ' '),
      emits_args: /args:\s*\[/.test(chunk),
      matched_phrase: /matchedPhrase:/.test(chunk),
    });
  }
  return rows.sort((a, b) => a.line - b.line);
}

function extractConfidenceFloors(src) {
  const { block, start } = blockBetween(src, 'const VERB_CONFIDENCE_FLOORS = {', '\n};\n\nfunction verbFloor');
  return [...block.matchAll(/(?:'([^']+)'|([A-Za-z][\w-]*)):\s*([0-9.]+)/g)]
    .map((m) => ({
      verb: m[1] || m[2],
      floor: Number(m[3]),
      line: lineNumber(src, start + m.index),
      class: Number(m[3]) >= 0.65 ? 'destructive_or_paid' : Number(m[3]) <= 0.45 ? 'read_only_or_fallback' : 'medium',
    }))
    .sort((a, b) => a.line - b.line || a.verb.localeCompare(b.verb));
}

function extractWorkflows(src) {
  const { block, start } = blockBetween(src, 'const WORKFLOWS = {', '\n};\n\nconst VERB_NEEDS_ARGS');
  const rows = [];
  for (const m of block.matchAll(/^  ([A-Za-z0-9_]+):\s*\{/gm)) {
    const nextIdx = block.slice(m.index + 1).search(/\n  [A-Za-z0-9_]+:\s*\{/);
    const end = nextIdx >= 0 ? m.index + 1 + nextIdx : block.length;
    const chunk = block.slice(m.index, end);
    rows.push({
      workflow: m[1],
      line: lineNumber(src, start + m.index),
      step_count: (chunk.match(/\{\s*cmd:\s*'/g) || []).length,
      has_summary: /summary:\s*'/.test(chunk),
      namespace_hinted: /namespace_hint:/.test(chunk) || /<name>/.test(chunk),
    });
  }
  return rows.sort((a, b) => a.line - b.line);
}

function extractSubcommandWorkflows(src) {
  const { block, start } = blockBetween(src, 'const SUBCOMMAND_WORKFLOWS = {', '\n};\n\n// ---------------------------------------------------------------------------\n// W863');
  const rows = [];
  const top = [...block.matchAll(/^  ([A-Za-z0-9_-]+):\s*\{/gm)];
  for (const t of top) {
    const topStart = t.index;
    const topEndMatch = block.slice(topStart + 1).search(/\n  [A-Za-z0-9_-]+:\s*\{/);
    const topEnd = topEndMatch >= 0 ? topStart + 1 + topEndMatch : block.length;
    const chunk = block.slice(topStart, topEnd);
    for (const s of chunk.matchAll(/^    ([A-Za-z0-9_-]+):\s*\{/gm)) {
      const subStart = s.index;
      const subEndMatch = chunk.slice(subStart + 1).search(/\n    [A-Za-z0-9_-]+:\s*\{/);
      const subEnd = subEndMatch >= 0 ? subStart + 1 + subEndMatch : chunk.length;
      const subChunk = chunk.slice(subStart, subEnd);
      rows.push({
        verb: t[1],
        subcommand: s[1],
        line: lineNumber(src, start + topStart + s.index),
        step_count: (subChunk.match(/\{\s*cmd:\s*'/g) || []).length,
      });
    }
  }
  return rows.sort((a, b) => a.line - b.line);
}

function directTestEvidence() {
  const dir = path.join(ROOT, 'tests');
  const rows = [];
  for (const name of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
    const rel = `tests/${name}`;
    const body = read(rel);
    const sourceLock = body.includes('src/intent.js');
    const directImport = body.includes('../src/intent.js') || body.includes('"../src/intent.js"') || body.includes("'../src/intent.js'") || body.includes('INTENT_PATH');
    const counts = {
      classify_refs: (body.match(/\bclassifyIntent\b/g) || []).length,
      snapshot_refs: (body.match(/\bsnapshotContext\b/g) || []).length,
      recommend_refs: (body.match(/\brecommendNext\b/g) || []).length,
      workflow_refs: (body.match(/\bexpandToWorkflow\b/g) || []).length,
      list_verbs_refs: (body.match(/\blistVerbs\b/g) || []).length,
      catalog_refs: (body.match(/\bVERB_DESCRIPTIONS\b/g) || []).length,
      previous_workflow_refs: (body.match(/\bprevious_workflow\b/g) || []).length,
    };
    if (!sourceLock && !directImport && Object.values(counts).every((n) => n === 0)) continue;
    rows.push({ path: rel, direct_import: directImport, source_lock: sourceLock, ...counts });
  }
  return rows;
}

function requiredTestEvidence() {
  return [
    'tests/wave351-intent.test.js',
    'tests/wave352-do-what-next.test.js',
    'tests/wave353-agent-guide.test.js',
    'tests/wave389-production-ready-parity.test.js',
    'tests/wave412-nl-intent-w409-verbs.test.js',
    'tests/wave414-tui-next-view.test.js',
    'tests/wave417-definition-of-done.test.js',
    'tests/wave432-intent-tenant-scope.test.js',
    'tests/wave457-telemetry-reconciliation.test.js',
    'tests/wave943-intent-contract-matrix.test.js',
  ];
}

function safetyGuards(src, routerSrc, cliSrc, exports, catalog, regexRules, floors, workflows, subworkflows) {
  const exportSet = new Set(exports.map((row) => row.name));
  const floorMap = new Map(floors.map((row) => [row.verb, row.floor]));
  const workflowSet = new Set(workflows.map((row) => row.workflow));
  const subKeySet = new Set(subworkflows.map((row) => `${row.verb}:${row.subcommand}`));
  const requiredWorkflowKeys = ['compile', 'distill', 'multi_teacher_distill', 'run', 'bench', 'verify', 'replay', 'bakeoff', 'dataset', 'quantize', 'export', 'capture', 'lake', 'fix', 'serve', 'quickstart'];
  const layerOne = src.indexOf('// 1. KEYWORD FAST PATH');
  const layerTwo = src.indexOf('// 2. REGEX');
  const layerThree = src.indexOf('// 3. LLM FALLBACK');
  const llmConfigIdx = src.indexOf('function llmConfig()');
  const llmConfigBlock = llmConfigIdx >= 0 ? src.slice(llmConfigIdx, src.indexOf('async function llmClassify', llmConfigIdx)) : '';
  const llmParseIdx = src.indexOf('function parseLlmResponse');
  const llmParseBlock = llmParseIdx >= 0 ? src.slice(llmParseIdx, src.indexOf('function llmConfig', llmParseIdx)) : '';

  return {
    required_public_exports_present: requiredExports().every((name) => exportSet.has(name)),
    verb_catalog_unique: catalog.duplicates.length === 0,
    verb_phrase_collisions_absent: catalog.phrase_collisions.length === 0,
    verb_catalog_large_enough: catalog.rows.length >= 90,
    keyword_phrasing_density: catalog.phrasing_count >= 800,
    examples_present_for_every_verb: catalog.rows.every((row) => row.example_count > 0),
    regex_rules_present: regexRules.length >= 18,
    confidence_floors_cover_paid_verbs: ['compile', 'distill', 'publish', 'pull', 'cloud', 'quantize', 'export', 'fix'].every((verb) => (floorMap.get(verb) || 0) >= 0.65),
    classifier_layer_order_documented: layerOne >= 0 && layerTwo > layerOne && layerThree > layerTwo,
    llm_opt_in_env_gated: llmConfigBlock.includes('KOLM_LLM_PROVIDER') && llmConfigBlock.includes('KOLM_INTENT_LLM') && llmConfigBlock.includes('KOLM_LLM_KEY') && llmConfigBlock.includes('ANTHROPIC_API_KEY') && llmConfigBlock.includes('OPENAI_API_KEY') && llmConfigBlock.includes('if (!provider) return null') && llmConfigBlock.includes('if (!key) return null'),
    llm_response_known_verbs_only: llmParseBlock.includes('new Set(listVerbs())') && llmParseBlock.includes('known.has(obj.verb)') && llmParseBlock.includes('Math.max(0, Math.min(1'),
    low_confidence_destructive_floor: src.includes('VERB_CONFIDENCE_FLOORS') && src.includes('verbFloor(top.verb)') && src.includes("source: 'low_confidence'"),
    followup_affirm_previous_workflow: src.includes('FOLLOWUP_AFFIRM_RE') && src.includes('context.previous_workflow') && src.includes("source: 'followup'"),
    pronoun_resolution_context: src.includes('function resolvePronouns') && src.includes('last_artifact') && src.includes('last_namespace') && src.includes('last_dataset'),
    snapshot_tenant_scope: src.includes('tenant_id = null') && src.includes('const _explicitTenant = tenant_id || tenant || null') && src.includes('tenant_id: _explicitTenant') && src.includes('allCapturesForTenant(tenant, 50000)'),
    sandbox_home_skips_live_probes: src.includes('const SANDBOX_MODE = home != null') && src.includes('if (!SANDBOX_MODE)') && src.includes('eventStore.listEvents'),
    snapshot_api_keys_redacted: src.includes("c.api_key.slice(0, 6) + '...'") && src.includes('key_fingerprint: keyPrefix'),
    recommend_next_ranked_and_capped: src.includes('recs.sort((a, b) => b.rank - a.rank)') && src.includes('return recs.slice(0, 5)'),
    workflow_expansions_present: requiredWorkflowKeys.every((key) => workflowSet.has(key)) && src.includes('const VERB_NEEDS_ARGS = new Set'),
    multi_teacher_workflow_present: workflowSet.has('multi_teacher_distill') && src.includes("intent.args.includes('--teachers')") && src.includes("teacherList.slice(0, 4)") && src.includes('--weights auto'),
    quickstart_subcommand_workflows: subKeySet.has('quickstart:wrapper') && subKeySet.has('quickstart:studio') && src.includes('SUBCOMMAND_WORKFLOWS[verb][intent.subcommand]'),
    router_intent_routes_tenant_scoped: routerSrc.includes("intent.snapshotContext({ tenant_id: req.tenant_record.id })") && routerSrc.includes('previous_workflow') && routerSrc.includes('intent.expandToWorkflow'),
    cli_do_what_next_uses_intent: cliSrc.includes("await import('../src/intent.js')") && cliSrc.includes('snapshotContext({ cwd: process.cwd() })') && cliSrc.includes('recommendNext(snap)'),
  };
}

async function buildMatrix() {
  const src = read('src/intent.js');
  const routerSrc = read('src/router.js');
  const cliSrc = read('cli/kolm.js');
  const intentModule = await import(pathToFileURL(path.join(ROOT, 'src', 'intent.js')).href + `?matrix=${Date.now()}`);
  const exports = extractExports(src);
  const exportNames = new Set(exports.map((row) => row.name));
  const missingRequiredExports = requiredExports().filter((name) => !exportNames.has(name));
  const functions = extractFunctions(src);
  const catalog = extractVerbCatalog(src, intentModule.VERB_DESCRIPTIONS);
  const regexRules = extractRegexRules(src);
  const floors = extractConfidenceFloors(src);
  const workflows = extractWorkflows(src);
  const subworkflows = extractSubcommandWorkflows(src);
  const tests = directTestEvidence();
  const requiredTests = requiredTestEvidence();
  const evidenceSet = new Set(tests.map((row) => row.path));
  const missingTests = requiredTests.filter((rel) => !evidenceSet.has(rel));
  const guards = safetyGuards(src, routerSrc, cliSrc, exports, catalog, regexRules, floors, workflows, subworkflows);
  const failedGuards = Object.entries(guards).filter(([, ok]) => !ok).map(([name]) => name);
  const requiredVerbs = [
    'compile', 'run', 'eval', 'bench', 'verify', 'inspect', 'list', 'tail',
    'capture', 'distill', 'replay', 'serve', 'publish', 'pull', 'hub',
    'marketplace', 'login', 'signup', 'whoami', 'status', 'health', 'doctor',
    'quickstart', 'build', 'models', 'gpu', 'export', 'quantize', 'cloud',
    'ask', 'do', 'what', 'next', 'fix', 'lake', 'opportunities', 'dataset',
    'labels', 'bakeoff', 'gateway', 'route', 'pipeline', 'lineage', 'regulatory',
  ];
  const verbSet = new Set(catalog.rows.map((row) => row.verb));
  const missingRequiredVerbs = requiredVerbs.filter((verb) => !verbSet.has(verb));

  const summary = {
    intent_bytes: Buffer.byteLength(src),
    intent_lines: src.split(/\r?\n/).length,
    export_count: exports.length,
    function_count: functions.length,
    verb_count: catalog.rows.length,
    unique_verb_count: new Set(catalog.rows.map((row) => row.verb)).size,
    duplicate_verb_count: catalog.duplicates.length,
    phrasing_count: catalog.phrasing_count,
    unique_phrasing_count: catalog.unique_phrasing_count,
    phrase_collision_count: catalog.phrase_collisions.length,
    example_count: catalog.example_count,
    regex_rule_count: regexRules.length,
    confidence_floor_count: floors.length,
    workflow_count: workflows.length,
    subcommand_workflow_count: subworkflows.length,
    required_verb_gaps: missingRequiredVerbs.length,
    required_test_evidence_count: requiredTests.length,
    direct_test_evidence_count: tests.length,
    missing_required_exports: missingRequiredExports.length,
    failed_safety_guards: failedGuards.length,
    missing_test_evidence: missingTests.length,
  };

  const failures = [];
  if (missingRequiredExports.length) failures.push({ gate: 'required_exports', missing: missingRequiredExports });
  if (summary.function_count < 16) failures.push({ gate: 'functions', count: summary.function_count });
  if (summary.verb_count < 90) failures.push({ gate: 'verb_catalog_size', count: summary.verb_count });
  if (summary.duplicate_verb_count) failures.push({ gate: 'verb_catalog_uniqueness', duplicates: catalog.duplicates });
  if (summary.phrase_collision_count) failures.push({ gate: 'phrase_ownership_uniqueness', collisions: catalog.phrase_collisions });
  if (summary.phrasing_count < 800) failures.push({ gate: 'phrasing_density', count: summary.phrasing_count });
  if (summary.regex_rule_count < 18) failures.push({ gate: 'regex_rules', count: summary.regex_rule_count });
  if (summary.workflow_count < 16) failures.push({ gate: 'workflow_expansions', count: summary.workflow_count });
  if (summary.subcommand_workflow_count < 2) failures.push({ gate: 'subcommand_workflows', count: summary.subcommand_workflow_count });
  if (missingRequiredVerbs.length) failures.push({ gate: 'required_verbs', missing: missingRequiredVerbs });
  if (failedGuards.length) failures.push({ gate: 'intent_safety_guards', guards: failedGuards });
  if (missingTests.length) failures.push({ gate: 'test_evidence', missing: missingTests });

  return {
    schema: SCHEMA,
    updated_at: UPDATED_AT,
    purpose: 'Generated contract matrix for the natural-language intent dispatcher boundary: verb catalog, phrase ownership, regex extractors, LLM opt-in fallback, tenant-scoped snapshots, next-action ranking, workflow expansion, and CLI/router evidence.',
    sources: [
      'src/intent.js',
      'src/router.js',
      'cli/kolm.js',
      ...requiredTests,
    ],
    summary,
    exports,
    required_exports: requiredExports(),
    missing_required_exports: missingRequiredExports,
    functions,
    verb_catalog: catalog.rows,
    duplicate_verbs: catalog.duplicates,
    phrase_collisions: catalog.phrase_collisions,
    required_verbs: requiredVerbs,
    missing_required_verbs: missingRequiredVerbs,
    regex_rules: regexRules,
    confidence_floors: floors,
    workflows,
    subcommand_workflows: subworkflows,
    public_return_shapes: {
      classifyIntent: ['verb', 'args', 'confidence', 'alternatives', 'source', 'matchedPhrase', 'subcommand', 'original', 'normalized'],
      snapshotContext: ['cwd', 'home', 'artifacts', 'captures_summary', 'jobs', 'config', 'current_tenant', 'counts', 'lake', 'opportunities', 'datasets', 'generated_at'],
      recommendNext: ['action', 'command', 'why', 'rank'],
      expandToWorkflow: ['summary', 'namespace_hint', 'steps'],
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
      console.error('intent-contract-matrix: docs/internal/intent-contract-matrix.json is out of date');
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
    console.log(`intent-contract-matrix: ${action} docs/internal/intent-contract-matrix.json verbs=${matrix.summary.verb_count} workflows=${matrix.summary.workflow_count} failures=${matrix.gates.failures.length}`);
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
