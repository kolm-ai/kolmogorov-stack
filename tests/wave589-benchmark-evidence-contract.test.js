// @public-routes-only
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

import {
  auditBenchmarkEvidence,
  BENCHMARK_EVIDENCE_SPEC,
  BENCHMARK_PROVIDER_MATRIX_SPEC,
  REQUIRED_BENCHMARK_LANES,
  benchmarkEvidenceTemplate,
  validateBenchmarkProviderMatrix,
} from '../src/benchmark-evidence.js';
import { buildRouter } from '../src/router.js';

const ROOT = path.resolve(import.meta.dirname, '..');

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
  const matrix = benchmarkEvidenceTemplate();
  matrix.generated_at = '2026-05-23T00:00:00.000Z';
  matrix.methodology.dataset_version = 'fixture-v1';
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
  const validation = validateBenchmarkProviderMatrix(matrix);
  assert.equal(validation.ok, true, validation.failures.join('\n'));
  assert.equal(validation.counts.complete_lanes, REQUIRED_BENCHMARK_LANES.length);
});

test('W589 #2 - local benchmark evidence is valid but comparative public claims stay gated', () => {
  const audit = auditBenchmarkEvidence({ root: ROOT });
  assert.equal(audit.spec, BENCHMARK_EVIDENCE_SPEC);
  assert.equal(audit.secret_values_included, false);
  assert.equal(audit.ok, true, audit.blockers.join('\n'));
  assert.equal(audit.local_contract_ok, true);
  assert.equal(audit.public_claim_ready, false);
  assert.ok(audit.required_artifacts.every((artifact) => artifact.exists), 'all local evidence artifacts should exist');
  assert.ok(audit.blockers.some((blocker) => blocker.startsWith('openai:')));
  assert.ok(audit.blockers.some((blocker) => blocker.startsWith('anthropic:')));
  assert.ok(audit.methodology_controls.some((control) => /raw prompt/i.test(control)));
  assert.doesNotMatch(JSON.stringify(audit), /ks_[a-z0-9_]+/i);
});

test('W589 #3 - API exposes benchmark evidence readiness as an honest envelope', async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  await withServer(app, async (base) => {
    const res = await fetch(base + '/v1/eval/benchmark-evidence');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-kolm-surface'), 'capture-data-eval-training');
    assert.equal(res.headers.get('x-kolm-readiness'), 'needs_public_benchmark_data');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.readiness.status, 'needs_public_benchmark_data');
    assert.ok(body.readiness.requirement_ids.includes('benchmarking-infra'));
    assert.equal(body.data.audit.public_claim_ready, false);
    assert.equal(body.data.secret_values_included, false);
    assert.ok(body.evidence.source_paths.includes('src/benchmark-evidence.js'));
    assert.ok(body.next_actions.some((a) => /verify:benchmark-evidence/.test(a.value)));

    const templateRes = await fetch(base + '/v1/eval/benchmark-evidence/template');
    assert.equal(templateRes.status, 200);
    assert.equal(templateRes.headers.get('x-kolm-readiness'), 'needs_public_benchmark_data');
    const templateBody = await templateRes.json();
    assert.equal(templateBody.data.template.spec, BENCHMARK_PROVIDER_MATRIX_SPEC);

    const invalidRes = await fetch(base + '/v1/eval/benchmark-evidence/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec: BENCHMARK_PROVIDER_MATRIX_SPEC, lanes: [] }),
    });
    assert.equal(invalidRes.status, 422);
    const invalidBody = await invalidRes.json();
    assert.equal(invalidBody.data.validation.ok, false);
    assert.equal(invalidBody.data.secret_values_included, false);
  });
});

test('W589 #4 - script and package gate expose benchmark evidence readiness', () => {
  const r = spawnSync(process.execPath, [
    'scripts/benchmark-evidence.mjs',
    '--summary',
    '--require-local-contract',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /ok=true public_claim_ready=false/);
  assert.match(r.stdout, /openai: missing_public_data/);
  const t = spawnSync(process.execPath, [
    'scripts/benchmark-evidence.mjs',
    '--template',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(t.status, 0, t.stderr || t.stdout);
  assert.match(t.stdout, /kolm-provider-benchmark-matrix-1/);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['verify:benchmark-evidence'], /benchmark-evidence\.mjs/);
  assert.match(pkg.scripts['verify:depth'], /verify:benchmark-evidence/);
});

test('W589 #5 - CLI exposes benchmark evidence readiness without provider calls', () => {
  const summary = spawnSync(process.execPath, [
    'cli/kolm.js',
    'bench',
    'evidence',
    '--summary',
    '--require-local-contract',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(summary.status, 0, summary.stderr || summary.stdout);
  assert.match(summary.stdout, /benchmark evidence: local=ok public_claim_ready=no/);
  assert.match(summary.stdout, /openai: missing_public_data/);
  assert.doesNotMatch(summary.stdout, /undefined/);

  const json = spawnSync(process.execPath, [
    'cli/kolm.js',
    'bench',
    'evidence',
    '--json',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(json.status, 0, json.stderr || json.stdout);
  const body = JSON.parse(json.stdout);
  assert.equal(body.spec, BENCHMARK_EVIDENCE_SPEC);
  assert.equal(body.secret_values_included, false);
  assert.equal(body.public_claim_ready, false);

  const template = spawnSync(process.execPath, [
    'cli/kolm.js',
    'bench',
    'evidence',
    '--template',
    '--json',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15000,
  });
  assert.equal(template.status, 0, template.stderr || template.stdout);
  assert.match(template.stdout, /kolm-provider-benchmark-matrix-1/);
});
