#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runQualityCalibration } from '../src/quality-calibration.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function numFlag(name, fallback) {
  const i = args.indexOf(name);
  if (i >= 0 && args[i + 1] != null) {
    const n = Number(args[i + 1]);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

const minAgreement = numFlag('--min-agreement', 0.98);
const maxBrier = numFlag('--max-brier', numFlag('--max-mae', 0.18));
const maxFalseAccept = numFlag('--max-false-accept', 0);
const writePublic = args.includes('--write-public');
const stable = args.includes('--stable') || writePublic;

const report = runQualityCalibration({
  generatedAt: stable ? '2026-05-23T00:00:00.000Z' : new Date().toISOString(),
});

const failures = [];
const agreement = report.metrics?.agreement ?? 0;
const brier = report.metrics?.brier ?? 1;
const falseAccept = report.metrics?.confusion?.fp ?? report.counts?.false_accept ?? 0;
if (agreement < minAgreement) failures.push(`agreement ${agreement} < ${minAgreement}`);
if (brier > maxBrier) failures.push(`brier ${brier} > ${maxBrier}`);
if (falseAccept > maxFalseAccept) failures.push(`false_accept ${falseAccept} > ${maxFalseAccept}`);
report.ok = failures.length === 0 && report.ok;
report.thresholds = {
  min_agreement: minAgreement,
  max_brier: maxBrier,
  max_false_accept: maxFalseAccept,
  ...report.thresholds,
};
report.failures = failures;

if (writePublic) {
  const outPath = path.join(ROOT, 'public', 'benchmarks', 'quality-judge-calibration.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
