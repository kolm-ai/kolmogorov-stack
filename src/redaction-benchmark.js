import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactPhi } from './phi-redactor.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

export const DEFAULT_REDACTION_BENCHMARK_FIXTURE = path.join(ROOT, 'test', 'fixtures', 'redaction-public-benchmark.json');

export function hashRaw(raw) {
  return 'sha256:' + crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function blankStats() {
  return { tp: 0, fp: 0, fn: 0, precision: 0, recall: 0, f1: 0 };
}

function round(n, digits = 4) {
  return Number(Number(n).toFixed(digits));
}

function finalize(row) {
  row.precision = row.tp + row.fp > 0 ? round(row.tp / (row.tp + row.fp), 4) : (row.fn === 0 ? 1 : 0);
  row.recall = row.tp + row.fn > 0 ? round(row.tp / (row.tp + row.fn), 4) : 1;
  row.f1 = row.precision + row.recall > 0 ? round(2 * row.precision * row.recall / (row.precision + row.recall), 4) : 0;
  return row;
}

export function evaluateRedactionBenchmarkCase(testCase, { redact = redactPhi } = {}) {
  const expected = Array.isArray(testCase.expected) ? testCase.expected : [];
  const expectedKeys = new Set(expected.map((row) => `${row.type}:${hashRaw(row.raw)}`));
  const expectedByKey = new Map(expected.map((row) => [`${row.type}:${hashRaw(row.raw)}`, row]));
  const result = redact(testCase.text);
  const findings = result.findings || [];
  const findingKeys = new Set(findings.map((row) => `${row.type}:${row.raw_hash}`));
  const perType = {};
  const failures = [];

  function stat(type) {
    perType[type] ||= blankStats();
    return perType[type];
  }

  for (const exp of expected) {
    const key = `${exp.type}:${hashRaw(exp.raw)}`;
    const matched = findingKeys.has(key);
    const rawStillPresent = exp.must_redact !== false && result.redacted_text.includes(exp.raw);
    const finding = findings.find((row) => `${row.type}:${row.raw_hash}` === key);
    if (matched && !rawStillPresent) {
      stat(exp.type).tp += 1;
    } else {
      stat(exp.type).fn += 1;
      failures.push({
        case_id: testCase.id,
        type: exp.type,
        raw_hash: hashRaw(exp.raw),
        reason: matched ? 'raw_value_still_present_after_redaction' : 'expected_finding_missing',
      });
    }
    if (finding && exp.safe_to_send != null && finding.safe_to_send !== exp.safe_to_send) {
      failures.push({
        case_id: testCase.id,
        type: exp.type,
        raw_hash: hashRaw(exp.raw),
        reason: `safe_to_send_mismatch expected=${exp.safe_to_send} got=${finding.safe_to_send}`,
      });
    }
  }

  for (const finding of findings) {
    const key = `${finding.type}:${finding.raw_hash}`;
    if (!expectedKeys.has(key)) {
      stat(finding.type).fp += 1;
      failures.push({
        case_id: testCase.id,
        type: finding.type,
        raw_hash: finding.raw_hash,
        reason: 'unexpected_finding',
      });
    } else if (expectedByKey.has(key)) {
      const exp = expectedByKey.get(key);
      if (exp.must_redact !== false && result.redacted_text.includes(exp.raw)) {
        failures.push({
          case_id: testCase.id,
          type: finding.type,
          raw_hash: finding.raw_hash,
          reason: 'expected_raw_still_present',
        });
      }
    }
  }

  if (testCase.expected_safe_to_send != null && result.safe_to_send !== testCase.expected_safe_to_send) {
    failures.push({
      case_id: testCase.id,
      reason: `case_safe_to_send_mismatch expected=${testCase.expected_safe_to_send} got=${result.safe_to_send}`,
    });
  }

  for (const row of Object.values(perType)) finalize(row);
  return {
    id: testCase.id,
    expected: expected.length,
    findings: findings.length,
    safe_to_send: result.safe_to_send,
    per_type: perType,
    failures,
  };
}

export function runRedactionBenchmark({
  fixturePath = DEFAULT_REDACTION_BENCHMARK_FIXTURE,
  minF1 = 0.95,
  minRecall = 0.95,
  maxFalsePositives = 0,
  generatedAt = new Date().toISOString(),
  includeHost = true,
  redact = redactPhi,
} = {}) {
  const resolvedFixture = path.resolve(fixturePath);
  const fixture = JSON.parse(fs.readFileSync(resolvedFixture, 'utf8'));
  if (fixture.schema !== 'kolm-redaction-benchmark-fixture-1') {
    throw new Error(`unexpected fixture schema in ${resolvedFixture}`);
  }

  const cases = fixture.cases || [];
  const perCase = cases.map((testCase) => evaluateRedactionBenchmarkCase(testCase, { redact }));
  const perType = {};
  const failures = [];
  for (const c of perCase) {
    failures.push(...c.failures);
    for (const [type, row] of Object.entries(c.per_type || {})) {
      perType[type] ||= blankStats();
      perType[type].tp += row.tp;
      perType[type].fp += row.fp;
      perType[type].fn += row.fn;
    }
  }
  for (const row of Object.values(perType)) finalize(row);
  const totals = finalize(Object.values(perType).reduce((acc, row) => ({
    tp: acc.tp + row.tp,
    fp: acc.fp + row.fp,
    fn: acc.fn + row.fn,
    precision: 0,
    recall: 0,
    f1: 0,
  }), blankStats()));

  if (totals.f1 < minF1) failures.push({ reason: `micro_f1_below_min ${totals.f1} < ${minF1}` });
  if (totals.recall < minRecall) failures.push({ reason: `micro_recall_below_min ${totals.recall} < ${minRecall}` });
  if (totals.fp > maxFalsePositives) failures.push({ reason: `false_positives_above_max ${totals.fp} > ${maxFalsePositives}` });

  const report = {
    spec: 'kolm-redaction-benchmark-1',
    ok: failures.length === 0,
    fixture: path.relative(ROOT, resolvedFixture).replace(/\\/g, '/'),
    generated_at: generatedAt,
    thresholds: { min_f1: minF1, min_recall: minRecall, max_false_positives: maxFalsePositives },
    totals,
    per_type: perType,
    cases: perCase,
    failures,
    note: 'Synthetic public fixture benchmark only. It proves harness behavior and detector coverage on public examples; real-world or best-in-class claims require broader published benchmark data.',
  };
  if (includeHost) {
    report.host = { platform: process.platform, arch: process.arch, node: process.version, hostname: os.hostname() };
  }
  return report;
}
