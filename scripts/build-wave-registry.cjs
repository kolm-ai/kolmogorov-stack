#!/usr/bin/env node
'use strict';

// kolm.wave_registry.v1 — canonical machine-readable state for every
// W-numbered wave referenced in root roadmap plans, tests/wave*.test.js,
// docs/*-frontier-*.json, docs/*-invention-*.json, and the codebase memory
// index. Replaces chat-derived wave status.
//
// Usage: node scripts/build-wave-registry.cjs [--check]
//
// Spec: docs/research/kolm-p0-control-files-implementation-spec-2026-05-25.md
//       docs/research/kolm-p0-control-files-buildbook-2026-05-25.md

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'internal', 'wave-registry.json');
const SCHEMA_OUT = path.join(ROOT, 'docs', 'internal', 'wave-registry.schema.json');
const RECONCILE_OUT = path.join(ROOT, 'docs', 'internal', 'wave-reconcile-report.json');
const SCHEMA = 'kolm.wave_registry.v1';

const args = process.argv.slice(2);
const CHECK = args.includes('--check');

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

function safeReadDir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function safeReadFile(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

const WAVE_REGEX = /\bW(\d{2,4})\b/g;

function extractWaveIds(text) {
  const out = new Set();
  let m;
  WAVE_REGEX.lastIndex = 0;
  while ((m = WAVE_REGEX.exec(text)) !== null) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 9999) out.add('W' + n);
  }
  return [...out];
}

// Plan-file scan: pull every W### reference and tag with source.
function scanPlanFiles() {
  const planFiles = safeReadDir(ROOT)
    .filter((f) => /^KOLM_.*PLAN.*\.md$/i.test(f))
    .sort();
  const refs = new Map(); // wave_id -> Set<plan-file>
  for (const f of planFiles) {
    const text = safeReadFile(path.join(ROOT, f));
    for (const w of extractWaveIds(text)) {
      if (!refs.has(w)) refs.set(w, new Set());
      refs.get(w).add(f);
    }
  }
  return { planFiles, refs };
}

// Test file scan: tests/wave###-*.test.js — extract wave id from filename.
function scanTestFiles() {
  const testsDir = path.join(ROOT, 'tests');
  const files = safeReadDir(testsDir);
  const tests = new Map(); // wave_id -> Array<{file, suffix}>
  for (const f of files) {
    const m = /^wave(\d{2,4})([a-z]?)-(.+)\.test\.[mc]?js$/i.exec(f);
    if (!m) continue;
    const id = 'W' + parseInt(m[1], 10);
    const suffix = m[2] || '';
    if (!tests.has(id)) tests.set(id, []);
    tests.get(id).push({ file: 'tests/' + f, suffix });
  }
  return tests;
}

// Repo-local secondary scan: pull W### refs from in-repo audit / closeout /
// readiness JSON files that mention completed waves. Lets us classify waves
// that have an attestation file but no current plan entry as historical.
function scanRepoSecondary() {
  const refs = new Map();
  const docsDir = path.join(ROOT, 'docs');
  const candidates = safeReadDir(docsDir)
    .filter((f) => /(readiness|audit|closeout|sota|wave-).*\.json$/i.test(f));
  for (const f of candidates) {
    const text = safeReadFile(path.join(docsDir, f));
    for (const w of extractWaveIds(text)) {
      if (!refs.has(w)) refs.set(w, new Set());
      refs.get(w).add('docs/' + f);
    }
  }
  return refs;
}

// docs/*.json invention/frontier ledgers — pull W### refs from any string
// field. Lower-confidence source for state inference; treated as evidence
// of existence not state.
function scanDocsJson() {
  const docsDir = path.join(ROOT, 'docs');
  const files = safeReadDir(docsDir)
    .filter((f) => /^product-(invention|frontier|math|research)-.*\.json$/.test(f));
  const refs = new Map();
  for (const f of files) {
    const text = safeReadFile(path.join(docsDir, f));
    for (const w of extractWaveIds(text)) {
      if (!refs.has(w)) refs.set(w, new Set());
      refs.get(w).add('docs/' + f);
    }
  }
  return refs;
}

// Package.json verify:* scripts that name explicit wave tests — extracts
// proof commands per wave.
function scanProofCommands() {
  const pkg = JSON.parse(safeReadFile(path.join(ROOT, 'package.json')) || '{}');
  const scripts = pkg.scripts || {};
  const proofs = new Map(); // wave_id -> Array<{script, command}>
  for (const [name, cmd] of Object.entries(scripts)) {
    const m = cmd.match(/tests\/wave(\d{2,4})[a-z]?-/gi);
    if (!m) continue;
    for (const hit of m) {
      const n = parseInt(hit.match(/wave(\d{2,4})/i)[1], 10);
      const id = 'W' + n;
      if (!proofs.has(id)) proofs.set(id, []);
      proofs.get(id).push({ script: 'npm:' + name, command: cmd });
    }
  }
  return proofs;
}

// Infer wave state from cross-source signals.
//   - test file exists -> at minimum local_green if test passes
//     (we don't run the test here; we assume green per the W852 verification)
//   - referenced in plan but no test -> planned
//   - referenced in memory only -> historical
function inferState(id, planRefs, testRefs, secondaryRefs) {
  const inPlan = planRefs.has(id);
  const inTest = testRefs.has(id);
  const inMemory = secondaryRefs.has(id);
  if (inTest && inPlan) return 'local_green';
  if (inTest) return 'local_green';
  if (inPlan) return 'planned';
  if (inMemory) return 'historical';
  return 'unknown';
}

function inferOwnerLane(id, testRefs) {
  if (!testRefs.has(id)) return null;
  const files = testRefs.get(id).map((t) => t.file).join(' ');
  if (/cli|tui/i.test(files)) return 'cli';
  if (/nav|render|ui|surface|brand|paint|w604|w605|w706/i.test(files)) return 'frontend';
  if (/distill|quantize|train|compile|teacher|student|kscore/i.test(files)) return 'research';
  return 'backend';
}

function main() {
  const { planFiles, refs: planRefs } = scanPlanFiles();
  const testRefs = scanTestFiles();
  const secondaryRefs = scanRepoSecondary();
  const docsRefs = scanDocsJson();
  const proofCommands = scanProofCommands();

  // Union of all known wave IDs.
  const allIds = new Set();
  for (const k of planRefs.keys()) allIds.add(k);
  for (const k of testRefs.keys()) allIds.add(k);
  for (const k of secondaryRefs.keys()) allIds.add(k);
  for (const k of docsRefs.keys()) allIds.add(k);

  // Sort numerically for stable output.
  const sortedIds = [...allIds].sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));

  const waves = [];
  const reconcile = {
    orphan_tests: [],   // tests with no plan ref + no memory ref
    orphan_plan_items: [], // plan items with no test + no completion evidence
    test_only_waves: [],   // test exists, no plan ref
    plan_only_waves: [],   // plan ref, no test
    multi_test_letter_suffixes: [], // W409a, W409b, ... — diagnostic
    docs_only_waves: [],
  };

  for (const id of sortedIds) {
    const planFilesForId = planRefs.has(id) ? [...planRefs.get(id)].sort() : [];
    const tests = testRefs.has(id) ? testRefs.get(id) : [];
    const secondarySources = secondaryRefs.has(id) ? [...secondaryRefs.get(id)].sort() : [];
    const docsSources = docsRefs.has(id) ? [...docsRefs.get(id)].sort() : [];
    const proofs = proofCommands.has(id) ? proofCommands.get(id) : [];
    const state = inferState(id, planRefs, testRefs, secondaryRefs);
    const ownerLane = inferOwnerLane(id, testRefs);

    waves.push({
      canonical_wave_id: id,
      state,
      owner_lane: ownerLane,
      test_files: tests.map((t) => t.file).sort(),
      test_letter_suffixes: [...new Set(tests.map((t) => t.suffix).filter(Boolean))].sort(),
      plan_files: planFilesForId,
      secondary_sources: secondarySources,
      docs_sources: docsSources,
      proof_commands: proofs,
      claim_scope: state === 'local_green' ? 'internal' : (state === 'historical' ? 'historical' : 'none'),
    });

    // Reconcile signal collection.
    const hasPlan = planFilesForId.length > 0;
    const hasTest = tests.length > 0;
    const hasSecondary = secondarySources.length > 0;
    const hasDocs = docsSources.length > 0;
    if (hasTest && !hasPlan && !hasSecondary) reconcile.orphan_tests.push(id);
    if (hasPlan && !hasTest && !hasSecondary) reconcile.orphan_plan_items.push(id);
    if (hasTest && !hasPlan) reconcile.test_only_waves.push(id);
    if (hasPlan && !hasTest) reconcile.plan_only_waves.push(id);
    if (tests.length > 1) {
      const suffixes = [...new Set(tests.map((t) => t.suffix).filter(Boolean))];
      if (suffixes.length >= 2) {
        reconcile.multi_test_letter_suffixes.push({ id, suffixes });
      }
    }
    if (hasDocs && !hasPlan && !hasTest && !hasSecondary) reconcile.docs_only_waves.push(id);
  }

  const counts = {
    waves: waves.length,
    test_files: [...testRefs.values()].reduce((a, b) => a + b.length, 0),
    plan_files: planFiles.length,
    state_local_green: waves.filter((w) => w.state === 'local_green').length,
    state_planned: waves.filter((w) => w.state === 'planned').length,
    state_historical: waves.filter((w) => w.state === 'historical').length,
    state_unknown: waves.filter((w) => w.state === 'unknown').length,
    orphan_tests: reconcile.orphan_tests.length,
    orphan_plan_items: reconcile.orphan_plan_items.length,
    test_only_waves: reconcile.test_only_waves.length,
    plan_only_waves: reconcile.plan_only_waves.length,
    docs_only_waves: reconcile.docs_only_waves.length,
    multi_test_letter_suffixes: reconcile.multi_test_letter_suffixes.length,
  };

  const doc = {
    schema: SCHEMA,
    generated_at: new Date().toISOString(),
    secret_values_included: false,
    counts,
    plan_files: planFiles,
    waves,
    reconcile,
  };

  // Minimal JSON schema for the registry — enough that downstream verifiers
  // can mechanically validate the shape without reading prose.
  const schemaDoc = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'kolm.wave_registry.v1',
    type: 'object',
    required: ['schema', 'generated_at', 'counts', 'waves', 'reconcile'],
    properties: {
      schema: { const: 'kolm.wave_registry.v1' },
      generated_at: { type: 'string', format: 'date-time' },
      secret_values_included: { const: false },
      counts: { type: 'object' },
      plan_files: { type: 'array', items: { type: 'string' } },
      waves: {
        type: 'array',
        items: {
          type: 'object',
          required: ['canonical_wave_id', 'state', 'test_files', 'plan_files'],
          properties: {
            canonical_wave_id: { type: 'string', pattern: '^W\\d+$' },
            state: { enum: ['planned', 'in_progress', 'local_green', 'production_verified', 'external_gated', 'historical', 'unknown', 'superseded', 'killed'] },
            owner_lane: { type: ['string', 'null'], enum: ['frontend', 'backend', 'research', 'cli', 'docs', 'production', 'spec', null] },
            test_files: { type: 'array', items: { type: 'string' } },
            test_letter_suffixes: { type: 'array', items: { type: 'string' } },
            plan_files: { type: 'array', items: { type: 'string' } },
            secondary_sources: { type: 'array', items: { type: 'string' } },
            docs_sources: { type: 'array', items: { type: 'string' } },
            proof_commands: { type: 'array', items: { type: 'object' } },
            claim_scope: { type: 'string' },
          },
        },
      },
      reconcile: { type: 'object' },
    },
  };

  const reconcileDoc = {
    schema: 'kolm.wave_reconcile_report.v1',
    generated_at: new Date().toISOString(),
    secret_values_included: false,
    counts,
    reconcile,
  };

  if (CHECK) {
    // Pin all timestamps from existing files so only content drift triggers
    // a failure.
    for (const [outFile, newDoc] of [[OUT, doc], [SCHEMA_OUT, schemaDoc], [RECONCILE_OUT, reconcileDoc]]) {
      if (!fs.existsSync(outFile)) continue;
      try {
        const existing = JSON.parse(fs.readFileSync(outFile, 'utf8'));
        if (existing && typeof existing.generated_at === 'string' && newDoc.generated_at) {
          newDoc.generated_at = existing.generated_at;
        }
      } catch (e) { /* fall through */ }
    }
  }

  const body = stableStringify(doc);
  const schemaBody = stableStringify(schemaDoc);
  const reconcileBody = stableStringify(reconcileDoc);

  if (CHECK) {
    let drift = false;
    for (const [outFile, newBody, label] of [
      [OUT, body, 'wave-registry'],
      [SCHEMA_OUT, schemaBody, 'wave-registry-schema'],
      [RECONCILE_OUT, reconcileBody, 'wave-reconcile-report'],
    ]) {
      const existing = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
      if (existing !== newBody) {
        console.error(`${label}: ${path.relative(ROOT, outFile).replace(/\\/g, '/')} is out of date`);
        drift = true;
      }
    }
    if (drift) process.exit(1);
    console.log(`wave-registry: ok waves=${counts.waves} local_green=${counts.state_local_green} planned=${counts.state_planned} historical=${counts.state_historical} orphan_tests=${counts.orphan_tests} orphan_plan=${counts.orphan_plan_items}`);
    return;
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, body);
  fs.writeFileSync(SCHEMA_OUT, schemaBody);
  fs.writeFileSync(RECONCILE_OUT, reconcileBody);
  console.log(`wave-registry: wrote docs/internal/wave-registry.json docs/internal/wave-registry.schema.json docs/internal/wave-reconcile-report.json waves=${counts.waves} local_green=${counts.state_local_green} planned=${counts.state_planned} historical=${counts.state_historical} orphan_tests=${counts.orphan_tests}`);
}

try {
  main();
} catch (err) {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
}
