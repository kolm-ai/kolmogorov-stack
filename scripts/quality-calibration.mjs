#!/usr/bin/env node
import { qualityCalibrationCatalog, runQualityCalibration } from '../src/quality-calibration.js';

const args = process.argv.slice(2);
const summary = args.includes('--summary');
const catalog = args.includes('--catalog');
const json = args.includes('--json') || (!summary && !catalog);
const requireLocal = args.includes('--require-local-contract');
const requirePublic = args.includes('--require-public-claim');

function usage() {
  console.log(`kolm quality calibration

USAGE
  node scripts/quality-calibration.mjs [--summary] [--json]
  node scripts/quality-calibration.mjs --catalog

FLAGS
  --require-local-contract   exit non-zero if rubric calibration math fails
  --require-public-claim     exit non-zero until external public labels exist

SCOPE
  Local only. This runs a deterministic rubric fixture and never calls a judge model.`);
}

if (args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(0);
}

if (catalog) {
  console.log(JSON.stringify({ ok: true, ...qualityCalibrationCatalog() }, null, 2));
  process.exit(0);
}

const report = runQualityCalibration();

if (summary) {
  console.log(`ok=${report.ok} public_claim_ready=${report.public_claim_ready} cases=${report.counts.cases} agreement=${report.metrics.agreement} f1=${report.metrics.f1} brier=${report.metrics.brier}`);
  for (const [taskType, row] of Object.entries(report.metrics.by_task_type)) {
    console.log(`${taskType}: agreement=${row.agreement} n=${row.n}`);
  }
} else if (json) {
  console.log(JSON.stringify(report, null, 2));
}

if (requireLocal && !report.ok) process.exit(1);
if (requirePublic && !report.public_claim_ready) process.exit(1);
