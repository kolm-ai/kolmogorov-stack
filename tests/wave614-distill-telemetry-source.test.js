// Wave 614: distill telemetry source labels.
//
// The distill iterator historically emitted projected k/loss step curves even
// when no trainer had measured a loss. This pins the API/run-list contract so
// synthetic progress and measured final metrics are structurally distinct.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

async function withIsolatedKolm(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w614-'));
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    KOLM_DATA_DIR: process.env.KOLM_DATA_DIR,
    KOLM_DISTILL_TEACHER: process.env.KOLM_DISTILL_TEACHER,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    KOLM_DISTILL_FULL: process.env.KOLM_DISTILL_FULL,
  };
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_DATA_DIR = tmp;
  delete process.env.KOLM_DISTILL_TEACHER;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.KOLM_DISTILL_FULL;
  try {
    const mod = await import('../src/distill-pipeline.js?w614=' + Date.now() + Math.random());
    return await fn(mod, tmp);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {} // deliberate: cleanup
  }
}

async function drain(iter) {
  const events = [];
  let done = null;
  for await (const ev of iter) {
    events.push(ev);
    if (ev && ev.done) done = ev;
  }
  return { events, done };
}

test('1. synthetic stub progress and done envelope are explicitly labeled', async () => {
  await withIsolatedKolm(async ({ distill, listDistillRuns, readDistillRun }) => {
    const { events, done } = await drain(distill({
      student_base: 'phi-3-mini',
      pairs_override: [{ event_id: 'e1', prompt: 'hello', response: 'hi' }],
      max_steps: 2,
      tenant_id: 'tenant-w614',
    }));

    const progress = events.filter((ev) => ev && !ev.done && ev.step);
    assert.ok(progress.length > 0, 'stub run emits projected progress events');
    for (const ev of progress) {
      assert.equal(ev.telemetry_source, 'synthetic');
      assert.equal(ev.loss_source, 'synthetic');
      assert.equal(ev.k_source, 'projected');
    }
    assert.equal(done.telemetry_source, 'synthetic');
    assert.equal(done.progress_telemetry_source, 'synthetic');
    assert.equal(done.loss_source, 'synthetic_suppressed');
    assert.equal(done.k_source, 'projected');

    const runDir = path.dirname(done.artifact_path);
    const runId = path.basename(runDir);
    const meta = JSON.parse(fs.readFileSync(path.join(runDir, 'run-meta.json'), 'utf8'));
    assert.equal(meta.telemetry_source, 'synthetic');
    assert.equal(meta.progress_telemetry_source, 'synthetic');
    assert.equal(meta.loss_source, 'synthetic_suppressed');
    assert.equal(meta.k_source, 'projected');

    const listed = listDistillRuns({ tenant_id: 'tenant-w614' });
    assert.equal(listed[0].telemetry_source, 'synthetic');
    assert.equal(listed[0].progress_telemetry_source, 'synthetic');
    assert.equal(listed[0].loss_source, 'synthetic_suppressed');
    assert.equal(listed[0].k_source, 'projected');

    const detail = readDistillRun(runId, { tenant_id: 'tenant-w614' });
    assert.equal(detail.telemetry_source, 'synthetic');
    assert.equal(detail.progress[0].telemetry_source, 'synthetic');
  });
});

test('2. measured manifest metrics override synthetic progress at run level', async () => {
  await withIsolatedKolm(async ({ listDistillRuns, readDistillRun, summarizeDistillTelemetry }, tmp) => {
    const runId = 'run_measured_w614';
    const runDir = path.join(tmp, 'distill-runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'run-meta.json'), JSON.stringify({
      job_id: 'job-w614',
      tenant_id: 'tenant-measured',
      namespace: 'ns',
      student_base: 'phi-3-mini',
      pipeline_mode: 'kd_softmax',
      pair_count: 3,
      worker_mode: 'full',
      teacher: 'local:/models/qwen',
      created_at: new Date().toISOString(),
      progress_telemetry_source: 'synthetic',
    }, null, 2));
    fs.writeFileSync(path.join(runDir, 'progress.jsonl'), JSON.stringify({
      step: 1,
      loss: 0.9,
      k_score: 0.55,
      loss_source: 'synthetic',
      k_source: 'projected',
      telemetry_source: 'synthetic',
    }) + '\n');
    fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify({
      loss_final: 0.12,
      k_score_final: 0.91,
    }, null, 2));

    const summary = summarizeDistillTelemetry({
      workerMode: 'full',
      manifest: { loss_final: 0.12, k_score_final: 0.91 },
      lastStep: { loss: 0.9, k_score: 0.55, telemetry_source: 'synthetic' },
    });
    assert.equal(summary.telemetry_source, 'measured');
    assert.equal(summary.progress_telemetry_source, 'synthetic');
    assert.equal(summary.loss_source, 'measured');
    assert.equal(summary.k_source, 'measured');

    const listed = listDistillRuns({ tenant_id: 'tenant-measured' })[0];
    assert.equal(listed.telemetry_source, 'measured');
    assert.equal(listed.progress_telemetry_source, 'synthetic');
    assert.equal(listed.loss_final, 0.12);
    assert.equal(listed.loss_source, 'measured');
    assert.equal(listed.k_final, 0.91);
    assert.equal(listed.k_source, 'measured');

    const detail = readDistillRun(runId, { tenant_id: 'tenant-measured' });
    assert.equal(detail.telemetry_source, 'measured');
    assert.equal(detail.progress_telemetry_source, 'synthetic');
    assert.equal(detail.progress[0].telemetry_source, 'synthetic');
  });
});

test('3. backend spec records W614 closure while keeping real worker progress parsing separate', () => {
  const spec = fs.readFileSync(path.join(ROOT, 'docs', 'STACK-TECH-SPEC-2026-06-15.md'), 'utf8');

  assert.match(spec, /CLOSED W614/);
  assert.match(spec, /Label synthetic vs measured progress in distill telemetry/);
  assert.match(spec, /worker progress parsing/);
});
