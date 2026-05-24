#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_REDACTION_BENCHMARK_FIXTURE,
  runRedactionBenchmark,
} from '../src/redaction-benchmark.js';

const args = process.argv.slice(2);
const fixturePath = path.resolve(parseFlag('--fixture', DEFAULT_REDACTION_BENCHMARK_FIXTURE, String));
const outPath = parseFlag('--json', null, String);
const minF1 = parseFlag('--min-f1', 0.95, Number);
const minRecall = parseFlag('--min-recall', 0.95, Number);
const maxFalsePositives = parseFlag('--max-fp', 0, Number);
const stable = args.includes('--stable');

function parseFlag(name, fallback, coerce) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const value = args[i + 1];
  if (value == null) return fallback;
  return coerce(value);
}

function main() {
  const report = runRedactionBenchmark({
    fixturePath,
    minF1,
    minRecall,
    maxFalsePositives,
    generatedAt: stable ? '2026-05-23T00:00:00.000Z' : undefined,
    includeHost: !stable,
  });
  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(path.resolve(outPath), JSON.stringify(report, null, 2) + '\n', 'utf8');
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

main();
