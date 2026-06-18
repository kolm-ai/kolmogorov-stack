// W953 - Air-gap distill queue consumer.
//
// These tests pin the architecture boundary: JS owns queue safety/status, and
// the worker command points at apps/trainer/airgap_distill_worker.py for the
// real KD execution path. The executor is injected so root tests never require
// torch/transformers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  offlineDistill,
  processOfflineDistillRun,
  processOfflineDistillQueue,
  getOfflineDistillStatus,
  _internal as distillInternal,
} from '../src/airgap-distill.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w953-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  delete process.env.KOLM_TEACHER_API_KEY;
  fs.mkdirSync(path.join(tmp, '.kolm', 'airgap-distill-runs'), { recursive: true });
  return tmp;
}

function airgappedFetch() {
  return async () => {
    const err = new Error('ENOTFOUND example.com');
    err.code = 'ENOTFOUND';
    throw err;
  };
}

function seedQueuedRun(tmp, rows = [{ prompt: 'email jane@example.com', response: 'ok' }], name = 'run') {
  const user = path.join(tmp, `${name}.jsonl`);
  const teacher = path.join(tmp, `${name}.teacher.bin`);
  const student = path.join(tmp, `${name}.student.bin`);
  const out = path.join(tmp, `${name}.out.kolm`);
  fs.writeFileSync(user, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(teacher, 'teacher-bytes');
  fs.writeFileSync(student, 'student-bytes');
  return offlineDistill({
    user_data_path: user,
    teacher_path_local: teacher,
    student_path_local: student,
    output_path: out,
    fetch: airgappedFetch(),
  });
}

test('W953 air-gap worker consumes a queued run through the Python execution boundary', async () => {
  const tmp = freshDir();
  process.env.OPENAI_API_KEY = 'must-not-reach-worker';
  try {
    const queued = await seedQueuedRun(tmp);
    assert.equal(queued.ok, true, JSON.stringify(queued));

    let called = 0;
    const processed = await processOfflineDistillRun({
      run_id: queued.run_id,
      fetch: airgappedFetch(),
      now: () => '2026-06-19T00:00:00.000Z',
      executor: async ({ spec, spec_path, env, worker_command }) => {
        called += 1;
        assert.equal(spec.status, 'running');
        assert.equal(spec_path, queued.spec_path);
        assert.equal(env.KOLM_AIRGAP, '1');
        assert.equal(env.TRANSFORMERS_OFFLINE, '1');
        assert.equal(env.HF_DATASETS_OFFLINE, '1');
        assert.equal(env.OPENAI_API_KEY, undefined);
        assert.match(worker_command.worker_path.replace(/\\/g, '/'), /apps\/trainer\/airgap_distill_worker\.py$/);
        assert.equal(worker_command.args.includes('--spec'), true);

        const redactedCorpus = fs.readFileSync(spec.user_data_path, 'utf8');
        assert.doesNotMatch(redactedCorpus, /jane@example\.com/);
        assert.match(redactedCorpus, /VAR_EMAIL_1/);
        fs.writeFileSync(spec.output_path, JSON.stringify({
          ok: true,
          mode: 'kd_trainer',
          airgap_worker_version: 'w953-v1',
        }) + '\n');
        return {
          ok: true,
          executor: 'python_airgap_distill_worker',
          mode: 'kd_trainer',
          metrics: { loss_final: 0.1 },
        };
      },
    });

    assert.equal(called, 1);
    assert.equal(processed.ok, true, JSON.stringify(processed));
    assert.equal(processed.status, 'completed');
    assert.equal(processed.started_at, '2026-06-19T00:00:00.000Z');
    assert.equal(processed.completed_at, '2026-06-19T00:00:00.000Z');
    assert.equal(processed.worker.kind, 'python_airgap_distill_worker');
    assert.equal(processed.worker_result.executor, 'python_airgap_distill_worker');
    assert.equal(processed.output_evidence.exists, true);
    assert.equal(processed.output_evidence.kind, 'file');
    assert.match(processed.output_evidence.sha256, /^[a-f0-9]{64}$/);

    const status = getOfflineDistillStatus({ run_id: queued.run_id });
    assert.equal(status.ok, true);
    assert.equal(status.status, 'completed');

    const again = await processOfflineDistillRun({
      run_id: queued.run_id,
      fetch: airgappedFetch(),
      executor: async () => {
        throw new Error('idempotent completed run must not execute twice');
      },
    });
    assert.equal(again.ok, true);
    assert.equal(again.already_completed, true);
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test('W953 air-gap worker fails closed on tampered redacted corpus evidence', async () => {
  const tmp = freshDir();
  const queued = await seedQueuedRun(tmp);
  assert.equal(queued.ok, true);

  const spec = JSON.parse(fs.readFileSync(queued.spec_path, 'utf8'));
  spec.redaction.redacted_sha256 = '0'.repeat(64);
  distillInternal.persistQueuedRun(queued.run_id, spec);

  let called = false;
  const processed = await processOfflineDistillRun({
    run_id: queued.run_id,
    fetch: airgappedFetch(),
    executor: async () => {
      called = true;
    },
  });

  assert.equal(called, false);
  assert.equal(processed.ok, false);
  assert.equal(processed.status, 'failed');
  assert.equal(processed.error, 'airgap_worker_spec_invalid');
  assert.equal(processed.error_reason, 'redacted_sha256_mismatch');

  const status = getOfflineDistillStatus({ run_id: queued.run_id });
  assert.equal(status.ok, true);
  assert.equal(status.status, 'failed');
  assert.equal(status.error_reason, 'redacted_sha256_mismatch');
});

test('W953 air-gap queue scanner processes only queued safe run specs', async () => {
  const tmp = freshDir();
  const first = await seedQueuedRun(tmp, [{ prompt: 'call 415-555-1212', response: 'ok' }], 'first');
  const second = await seedQueuedRun(tmp, [{ prompt: 'email ops@example.com', response: 'ok' }], 'second');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

  const before = distillInternal.SAFE_RUN_ID_RE.test(first.run_id);
  assert.equal(before, true);
  const queueResult = await processOfflineDistillQueue({
    limit: 1,
    fetch: airgappedFetch(),
    executor: async ({ spec }) => {
      fs.writeFileSync(spec.output_path, '{"ok":true}\n');
      return { ok: true, executor: 'python_airgap_distill_worker' };
    },
  });

  assert.equal(queueResult.ok, true);
  assert.equal(queueResult.processed, 1);
  assert.equal(queueResult.completed, 1);
  const statuses = [first, second].map((r) => getOfflineDistillStatus({ run_id: r.run_id }).status);
  assert.deepEqual(statuses.sort(), ['completed', 'queued']);
});

test('W953 CLI exposes the air-gap distill queue processor', () => {
  const cli = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'kolm.js'), 'utf8');
  assert.match(cli, /kolm airgap distill run/);
  assert.match(cli, /kolm airgap distill process/);
  assert.match(cli, /offlineDistill/);
  assert.match(cli, /processOfflineDistillRun/);
  assert.match(cli, /processOfflineDistillQueue/);
  assert.match(cli, /airgap_distill_worker\.py/);
});
