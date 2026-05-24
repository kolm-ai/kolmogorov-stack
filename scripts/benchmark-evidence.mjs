#!/usr/bin/env node
import fs from 'node:fs';
import {
  auditBenchmarkEvidence,
  benchmarkEvidenceCatalog,
  benchmarkEvidenceTemplate,
  validateBenchmarkProviderMatrix,
} from '../src/benchmark-evidence.js';

const args = process.argv.slice(2);
const summary = args.includes('--summary');
const catalog = args.includes('--catalog');
const template = args.includes('--template');
const validateIdx = args.indexOf('--validate');
const validatePath = validateIdx >= 0 ? args[validateIdx + 1] : null;
const json = args.includes('--json') || (!summary && !catalog && !template && validateIdx < 0);
const requireLocal = args.includes('--require-local-contract');
const requirePublic = args.includes('--require-public-claim');

function usage() {
  console.log(`kolm benchmark evidence readiness

USAGE
  node scripts/benchmark-evidence.mjs [--summary] [--json]
  node scripts/benchmark-evidence.mjs --catalog
  node scripts/benchmark-evidence.mjs --template
  node scripts/benchmark-evidence.mjs --validate reports/benchmarks/provider-matrix.json

FLAGS
  --require-local-contract   exit non-zero if local benchmark evidence files are missing
  --require-public-claim     exit non-zero until all public provider lanes are complete

SCOPE
  Local only. This never calls model providers, publishes claims, or prints secrets.`);
}

if (args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(0);
}

if (catalog) {
  console.log(JSON.stringify({ ok: true, ...benchmarkEvidenceCatalog() }, null, 2));
  process.exit(0);
}

if (template) {
  console.log(JSON.stringify({ ok: true, template: benchmarkEvidenceTemplate() }, null, 2));
  process.exit(0);
}

if (validateIdx >= 0) {
  if (!validatePath) {
    console.error('error: --validate requires a JSON file path');
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(validatePath, 'utf8'));
  } catch (e) {
    console.error(`error: cannot read benchmark matrix: ${String(e.message || e)}`);
    process.exit(2);
  }
  const validation = validateBenchmarkProviderMatrix(parsed);
  if (summary) {
    console.log(`ok=${validation.ok} lanes=${validation.counts.complete_lanes}/${validation.counts.required_lanes} failures=${validation.counts.failures}`);
    for (const failure of validation.failures) console.log(failure);
  } else {
    console.log(JSON.stringify(validation, null, 2));
  }
  if (!validation.ok) process.exit(1);
  process.exit(0);
}

const audit = auditBenchmarkEvidence();

if (summary) {
  console.log(`ok=${audit.ok} public_claim_ready=${audit.public_claim_ready} lanes=${audit.counts.complete_public_lanes}/${audit.counts.required_lanes} blockers=${audit.counts.blockers}`);
  for (const lane of audit.lanes) {
    console.log(`${lane.id}: ${lane.status}${lane.missing_fields.length ? ' missing=' + lane.missing_fields.join(',') : ''}`);
  }
} else if (json) {
  console.log(JSON.stringify(audit, null, 2));
}

if (requireLocal && !audit.ok) process.exit(1);
if (requirePublic && !audit.public_claim_ready) process.exit(1);
