// @public-routes-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import {
  auditBenchmarkEvidence,
  BENCHMARK_EVIDENCE_SPEC,
  BENCHMARK_PROVIDER_MATRIX_SPEC,
  REQUIRED_BENCHMARK_LANES,
  REQUIRED_PUBLICATION_FIELDS,
  benchmarkEvidenceTemplate,
  validateBenchmarkProviderMatrix,
} from '../src/benchmark-evidence.js';
import { buildRouter } from '../src/router.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function writeFile(root, rel, body) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

function completeProviderMatrix() {
  const matrix = benchmarkEvidenceTemplate();
  const command = 'node scripts/bench-compare.mjs --matrix reports/benchmarks/provider-matrix.json --public';
  matrix.generated_at = '2026-05-23T00:00:00.000Z';
  matrix.methodology.dataset_version = 'fixture-v1';
  matrix.publication = {
    leaderboard_url: 'https://kolm.ai/benchmarks/trinity-500',
    dataset_manifest_path: 'reports/benchmarks/dataset-manifest.json',
    signed_raw_output_bundle_path: 'reports/benchmarks/raw-output-bundle.json',
    hardware_provider_manifest_path: 'reports/benchmarks/hardware-providers.json',
    harness_config_manifest_path: 'reports/benchmarks/harness-configs.json',
    statistical_analysis_path: 'reports/benchmarks/statistical-analysis.json',
    contamination_report_path: 'reports/benchmarks/contamination-report.json',
    leaderboard_stability_path: 'reports/benchmarks/leaderboard-stability.json',
    reproducer_command: command,
    reproducer_command_sha256: `sha256:${sha256(command)}`,
    freshness_expires_at: '2026-08-23T00:00:00.000Z',
  };
  matrix.lanes = matrix.lanes.map((lane, idx) => {
    const row = { ...lane, public_report_path: `reports/benchmarks/${lane.id}.json` };
    for (const field of lane.required_fields) {
      if (/hash$/.test(field) || field === 'artifact_hash' || field === 'model_file_hash' || field === 'bundle_hash') row[field] = `sha256:${String(idx).padStart(2, '0')}${'a'.repeat(62)}`;
      else if (field === 'provider_model') row[field] = `${lane.id}/model-v1`;
      else if (field === 'pricing_snapshot') row[field] = '2026-05-23:public-pricing';
      else if (field === 'hardware_profile') row[field] = 'cpu-x86_64';
      else if (field === 'accelerator') row[field] = 'l4';
      else if (field === 'runtime_version') row[field] = 'llama.cpp-test';
      else if (field === 'browser_engine') row[field] = 'chromium';
      else if (field === 'device_profile') row[field] = 'desktop';
      else if (field === 'size_bytes') row[field] = 123456;
      else if (field === 'latency_p50_ms') row[field] = 42;
      else if (field === 'latency_p95_ms') row[field] = 64;
      else if (field === 'cost_usd_per_1k') row[field] = 0.01;
      else if (field === 'quality_score' || field === 'k_score') row[field] = 0.91;
      else if (field === 'joules_per_call') row[field] = 3.2;
      else row[field] = 'present';
    }
    return row;
  });
  return matrix;
}

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', async () => {
      try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const out = await fn(base);
        server.close(() => resolve(out));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
    server.on('error', reject);
  });
}

test('W589 #1 - benchmark evidence catalog covers every required provider/runtime lane', () => {
  const ids = new Set(REQUIRED_BENCHMARK_LANES.map((lane) => lane.id));
  for (const id of ['kolm-artifact', 'openai', 'anthropic', 'gemini', 'hosted-open-model', 'local-gguf', 'browser-worker']) {
    assert.ok(ids.has(id), `missing benchmark lane ${id}`);
  }
  for (const lane of REQUIRED_BENCHMARK_LANES) {
    assert.ok(lane.required_fields.length >= 5, `${lane.id} needs concrete required fields`);
  }
  const template = benchmarkEvidenceTemplate();
  assert.equal(template.spec, BENCHMARK_PROVIDER_MATRIX_SPEC);
  assert.equal(template.secret_values_included, false);
  assert.equal(template.lanes.length, REQUIRED_BENCHMARK_LANES.length);
  for (const field of REQUIRED_PUBLICATION_FIELDS) assert.ok(field in template.publication, `missing publication field ${field}`);
  assert.ok(template.methodology.raw_data_policy.includes('Do not include raw prompts'));
});

test('W589 #1b - benchmark provider matrix validator rejects raw values and secrets', () => {
  const template = benchmarkEvidenceTemplate();
  const incomplete = validateBenchmarkProviderMatrix(template);
  assert.equal(incomplete.ok, false);
  assert.ok(incomplete.failures.some((failure) => failure.includes('missing')));
  const withSecret = {
    ...template,
    lanes: template.lanes.map((lane) => ({ ...lane })),
  };
  withSecret.lanes[0].artifact_hash = 'ks_12345678901234567890';
  withSecret.lanes[0].raw_output = 'private text';
  const validation = validateBenchmarkProviderMatrix(withSecret);
  assert.equal(validation.ok, false);
  assert.ok(validation.failures.includes('secret_value_detected'));
  assert.ok(validation.failures.some((failure) => /raw_output.*raw_value_field_forbidden/.test(failure)));
});

test('W589 #1c - complete benchmark provider matrix validates without setting repo public claims', () => {
  const matrix = completeProviderMatrix();
  const validation = validateBenchmarkProviderMatrix(matrix);
  assert.equal(validation.ok, true, validation.failures.join('\n'));
  assert.equal(validation.counts.complete_lanes, REQUIRED_BENCHMARK_LANES.length);
});

test('W589 #1d - public benchmark claim requires referenced report and publication packet files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-bench-evidence-'));
  writeFile(root, 'public/benchmarks/trinity-500-benchmark.json', JSON.stringify({ spec: 'kolm-trinity-500-benchmark-1', rows: [{ id: 'fixture' }] }));
  writeFile(root, 'docs/benchmark-evidence.md', '# benchmark evidence\n');
  writeFile(root, 'tests/wave589-benchmark-evidence-contract.test.js', '// fixture\n');
  writeFile(root, 'scripts/bench-compare.mjs', '#!/usr/bin/env node\n');
  writeFile(root, 'src/benchmark-compare.js', 'export default {};\n');
  writeFile(root, 'reports/benchmarks/provider-matrix.json', JSON.stringify(completeProviderMatrix(), null, 2));

  const audit = auditBenchmarkEvidence({ root });
  assert.equal(audit.local_contract_ok, true, audit.blockers.join('\n'));
  assert.equal(audit.public_claim_ready, false);
  assert.ok(audit.public_claim_packet.blockers.some((blocker) => blocker.includes('public_report_missing')));
  assert.ok(audit.public_claim_packet.blockers.some((blocker) => blocker.includes('dataset_manifest_path:missing')));
  assert.ok(audit.public_claim_packet.blockers.some((blocker) => blocker.includes('statistical_analysis_path:missing')));
  assert.ok(audit.public_claim_packet.blockers.some((blocker) => blocker.includes('contamination_report_path:missing')));
  assert.ok(audit.public_claim_packet.blockers.some((blocker) => blocker.includes('leaderboard_stability_path:missing')));
});

test('W589 #1e - local benchmark evidence contract is current but public claim remains gated', () => {
  const audit = auditBenchmarkEvidence({ root: ROOT });
  assert.equal(audit.local_contract_ok, true, audit.blockers.join('\n'));
  assert.equal(audit.ok, true, audit.blockers.join('\n'));
  assert.equal(audit.public_claim_ready, false);
  assert.ok(audit.blockers.some((blocker) => blocker.includes('provider-matrix') || blocker.includes('provider_model') || blocker.includes('raw_output_hash')));

  const r = spawnSync(process.execPath, ['scripts/benchmark-evidence.mjs', '--summary', '--require-local-contract'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /ok=true public_claim_ready=false/);
});

test('W589 #1f - bench-compare evidence command is parseable and validates provider matrices', () => {
  const help = spawnSync(process.execPath, ['scripts/bench-compare.mjs', '--help'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(help.status, 0, help.stderr || help.stdout);
  assert.match(help.stdout, /--matrix/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-bench-compare-'));
  const matrixPath = path.join(root, 'provider-matrix.json');
  fs.writeFileSync(matrixPath, JSON.stringify(completeProviderMatrix(), null, 2));
  const validated = spawnSync(process.execPath, ['scripts/bench-compare.mjs', '--matrix', matrixPath, '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(validated.status, 0, validated.stderr || validated.stdout);
  const body = JSON.parse(validated.stdout);
  assert.equal(body.ok, true, JSON.stringify(body, null, 2));
  assert.equal(body.provider_matrix_validation.counts.complete_lanes, REQUIRED_BENCHMARK_LANES.length);
});
