// Finalized C8 - Compute / Scheduler / Orchestration.
//
// Locks the durable scheduler invariants that the existing one-shot compute
// broker/adapters did not cover: idempotent submission, tenant fences, priority
// lanes, leases, heartbeats, stale recovery, retry/dead-letter, budget refusal,
// and linkage from broker/cloud-distill into the shared queue.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

import {
  COMPUTE_SCHEDULER_VERSION,
  SCHEDULER_PRIORITY_LANES,
  submitSchedulerJob,
  getSchedulerJob,
  listSchedulerJobs,
  claimNextSchedulerJob,
  heartbeatSchedulerJob,
  failSchedulerJob,
  sweepExpiredLeases,
  queueStats,
  _resetSchedulerForTests,
} from '../src/compute-scheduler.js';
import {
  scheduleCloudCompute,
  runCloudCompute,
} from '../src/cloud-compute-broker.js';
import {
  submitJob as submitCloudDistillJob,
  getJobStatus as getCloudDistillStatus,
  advanceJobState as advanceCloudDistillState,
  _resetForTests as resetCloudDistillForTests,
} from '../src/cloud-distill.js';

function freshEnv(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-c8-scheduler-'));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';
  process.env.KOLM_ENV = 'test';
  delete process.env.KOLM_COMPUTE_SCHEDULER_DIR;
  delete process.env.KOLM_CLOUD_DISTILL_ENDPOINT;
  delete process.env.KOLM_FORCE_LOCAL_CUDA;
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  _resetSchedulerForTests();
  resetCloudDistillForTests();
  t.after(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  });
  return tmp;
}

test('C8 scheduler exports durable version and priority lane vocabulary', () => {
  assert.equal(COMPUTE_SCHEDULER_VERSION, 'c8-compute-scheduler-v1');
  assert.deepEqual(SCHEDULER_PRIORITY_LANES, ['enterprise', 'team', 'pro', 'free']);
});

test('C8 scheduler submit is tenant-fenced, idempotent, and redacts secrets', (t) => {
  freshEnv(t);
  const first = submitSchedulerJob({
    tenant: 'tenant_a',
    family: 'compute',
    operation: 'train',
    idempotency_key: 'same-request',
    priority: 'pro',
    lane: 'local-cuda',
    estimated_cost_usd: 3,
    budget_usd: 5,
    payload: {
      command: ['kolm', 'train'],
      api_key: 'sk-should-not-persist',
      nested: { access_token: 'tok-secret', safe: 'kept' },
    },
  });
  assert.equal(first.ok, true);
  assert.equal(first.created, true);

  const replay = submitSchedulerJob({
    tenant: 'tenant_a',
    family: 'compute',
    operation: 'train',
    idempotency_key: 'same-request',
    priority: 'enterprise',
    lane: 'runpod-gpu',
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.created, false);
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.job_id, first.job_id);

  const ownRead = getSchedulerJob({ tenant: 'tenant_a', job_id: first.job_id });
  assert.equal(ownRead.ok, true);
  assert.equal(ownRead.job.payload.api_key, '[redacted]');
  assert.equal(ownRead.job.payload.nested.access_token, '[redacted]');
  assert.equal(ownRead.job.payload.nested.safe, 'kept');

  const foreignRead = getSchedulerJob({ tenant: 'tenant_b', job_id: first.job_id });
  assert.equal(foreignRead.ok, false);
  assert.equal(foreignRead.error, 'not_found');
});

test('C8 scheduler refuses jobs whose quote exceeds the declared budget', (t) => {
  freshEnv(t);
  const rejected = submitSchedulerJob({
    tenant: 'tenant_budget',
    family: 'compute',
    operation: 'train',
    estimated_cost_usd: 10.25,
    budget_usd: 2,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, 'budget_exceeded');

  const listed = listSchedulerJobs({ tenant: 'tenant_budget' });
  assert.equal(listed.count, 0, 'budget-refused jobs must not be persisted');
});

test('C8 scheduler claims by priority while respecting worker lane filters', (t) => {
  freshEnv(t);
  const free = submitSchedulerJob({
    tenant: 'tenant_claim',
    family: 'compute',
    operation: 'train',
    priority: 'free',
    lane: 'local-cuda',
    now_ms: 1000,
  });
  const enterpriseRemote = submitSchedulerJob({
    tenant: 'tenant_claim',
    family: 'compute',
    operation: 'train',
    priority: 'enterprise',
    lane: 'runpod-gpu',
    now_ms: 1001,
  });
  const enterpriseLocal = submitSchedulerJob({
    tenant: 'tenant_claim',
    family: 'compute',
    operation: 'train',
    priority: 'enterprise',
    lane: 'local-cuda',
    now_ms: 1002,
  });

  const localClaim = claimNextSchedulerJob({
    tenant: 'tenant_claim',
    worker_id: 'worker-local',
    worker_lanes: ['local-cuda'],
    now_ms: 2000,
  });
  assert.equal(localClaim.ok, true);
  assert.equal(localClaim.claimed, true);
  assert.equal(localClaim.job_id, enterpriseLocal.job_id);

  const anyClaim = claimNextSchedulerJob({
    tenant: 'tenant_claim',
    worker_id: 'worker-any',
    now_ms: 2001,
  });
  assert.equal(anyClaim.job_id, enterpriseRemote.job_id);
  assert.notEqual(anyClaim.job_id, free.job_id);
});

test('C8 scheduler heartbeat extends leases and stale leases requeue before DLQ', (t) => {
  freshEnv(t);
  const submitted = submitSchedulerJob({
    tenant: 'tenant_lease',
    family: 'compute',
    operation: 'quantize',
    max_attempts: 2,
    lease_ms: 1000,
    now_ms: 1000,
  });
  const claimed1 = claimNextSchedulerJob({
    tenant: 'tenant_lease',
    worker_id: 'worker-1',
    lease_ms: 1000,
    now_ms: 1100,
  });
  assert.equal(claimed1.job_id, submitted.job_id);
  assert.equal(claimed1.job.attempts, 1);

  const hb = heartbeatSchedulerJob({
    tenant: 'tenant_lease',
    job_id: submitted.job_id,
    lease_token: claimed1.lease_token,
    lease_ms: 5000,
    now_ms: 1500,
  });
  assert.equal(hb.ok, true);

  const earlySweep = sweepExpiredLeases({ tenant: 'tenant_lease', now_ms: 3000 });
  assert.deepEqual(earlySweep.recovered, []);

  const lateSweep = sweepExpiredLeases({ tenant: 'tenant_lease', now_ms: 7000 });
  assert.deepEqual(lateSweep.recovered, [submitted.job_id]);

  const claimed2 = claimNextSchedulerJob({
    tenant: 'tenant_lease',
    worker_id: 'worker-2',
    lease_ms: 1000,
    now_ms: 7100,
  });
  assert.equal(claimed2.job_id, submitted.job_id);
  assert.equal(claimed2.job.attempts, 2);

  const exhausted = failSchedulerJob({
    tenant: 'tenant_lease',
    job_id: submitted.job_id,
    lease_token: claimed2.lease_token,
    error: 'second attempt failed',
    retryable: true,
    now_ms: 7200,
  });
  assert.equal(exhausted.ok, true);
  assert.equal(exhausted.state, 'dead_letter');

  const stats = queueStats({ tenant: 'tenant_lease' });
  assert.equal(stats.by_state.dead_letter, 1);
});

test('C8 scheduler retry backoff blocks early reclaim then dead-letters after max attempts', (t) => {
  freshEnv(t);
  const submitted = submitSchedulerJob({
    tenant: 'tenant_retry',
    family: 'compute',
    operation: 'compile',
    max_attempts: 2,
    retry_base_ms: 100,
    now_ms: 1000,
  });
  const first = claimNextSchedulerJob({
    tenant: 'tenant_retry',
    worker_id: 'worker-retry',
    now_ms: 1100,
  });
  const retry = failSchedulerJob({
    tenant: 'tenant_retry',
    job_id: submitted.job_id,
    lease_token: first.lease_token,
    error: 'transient',
    retryable: true,
    now_ms: 1200,
  });
  assert.equal(retry.state, 'queued');
  assert.equal(retry.retry_scheduled, true);

  const tooEarly = claimNextSchedulerJob({
    tenant: 'tenant_retry',
    worker_id: 'worker-retry',
    now_ms: 1250,
  });
  assert.equal(tooEarly.claimed, false);

  const second = claimNextSchedulerJob({
    tenant: 'tenant_retry',
    worker_id: 'worker-retry',
    now_ms: 1300,
  });
  assert.equal(second.claimed, true);
  assert.equal(second.job.attempts, 2);

  const dlq = failSchedulerJob({
    tenant: 'tenant_retry',
    job_id: submitted.job_id,
    lease_token: second.lease_token,
    error: 'still failing',
    retryable: true,
    now_ms: 1400,
  });
  assert.equal(dlq.state, 'dead_letter');
});

test('C8 broker can enqueue a planned compute run instead of executing it', async (t) => {
  freshEnv(t);
  const env = { KOLM_FORCE_LOCAL_CUDA: '1' };
  const scheduled = scheduleCloudCompute({
    tenant: 'tenant_broker',
    workload: 'train',
    params_b: 7,
    rows: 100,
    base_model: 'Qwen/Qwen2.5-7B-Instruct',
    idempotency_key: 'broker-once',
  }, {
    env,
    tenant: 'tenant_broker',
    priority: 'team',
  });
  assert.equal(scheduled.ok, true, JSON.stringify(scheduled).slice(0, 500));
  assert.equal(scheduled.scheduled, true);
  assert.equal(scheduled.mode, 'scheduled');
  assert.equal(scheduled.backend, 'local-cuda');
  assert.equal(scheduled.estimated_cost_usd, 0);

  const job = getSchedulerJob({ tenant: 'tenant_broker', job_id: scheduled.scheduler_job_id });
  assert.equal(job.ok, true);
  assert.equal(job.job.family, 'compute');
  assert.equal(job.job.priority, 'team');
  assert.equal(job.job.payload.backend, 'local-cuda');
  assert.match(job.job.payload.command, /kolm train/);

  const replay = await runCloudCompute({
    tenant: 'tenant_broker',
    workload: 'train',
    params_b: 7,
    rows: 100,
    idempotency_key: 'broker-once',
  }, {
    env,
    tenant: 'tenant_broker',
    schedule: true,
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.scheduler_job_id, scheduled.scheduler_job_id);
  assert.equal(replay.scheduler.idempotent_replay, true);
});

test('C8 cloud-distill submissions carry durable scheduler linkage and idempotency', (t) => {
  freshEnv(t);
  const submitted = submitCloudDistillJob({
    tenant: 'tenant_cd',
    namespace: 'support',
    idempotency_key: 'cd-once',
    billing_token: 'billing-secret',
  });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.cloud_backend_status, 'no_pool_configured');
  assert.ok(submitted.scheduler_job_id);

  const schedulerJob = getSchedulerJob({
    tenant: 'tenant_cd',
    job_id: submitted.scheduler_job_id,
  });
  assert.equal(schedulerJob.ok, true);
  assert.equal(schedulerJob.job.family, 'cloud-distill');
  assert.equal(schedulerJob.job.lineage.cloud_distill_job_id, submitted.job_id);
  assert.equal(JSON.stringify(schedulerJob.job).includes('billing-secret'), false);

  const replay = submitCloudDistillJob({
    tenant: 'tenant_cd',
    namespace: 'support',
    idempotency_key: 'cd-once',
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.created, false);
  assert.equal(replay.job_id, submitted.job_id);
  assert.equal(replay.scheduler_job_id, submitted.scheduler_job_id);

  const running = advanceCloudDistillState({
    tenant: 'tenant_cd',
    job_id: submitted.job_id,
    state: 'running',
  });
  assert.equal(running.ok, true);
  assert.equal(getCloudDistillStatus({ tenant: 'tenant_cd', job_id: submitted.job_id }).scheduler_state, 'running');
  assert.equal(getSchedulerJob({ tenant: 'tenant_cd', job_id: submitted.scheduler_job_id }).job.state, 'running');

  const done = advanceCloudDistillState({
    tenant: 'tenant_cd',
    job_id: submitted.job_id,
    state: 'succeeded',
    artifact_url: 's3://bucket/out.kolm',
  });
  assert.equal(done.ok, true);
  assert.equal(getSchedulerJob({ tenant: 'tenant_cd', job_id: submitted.scheduler_job_id }).job.state, 'succeeded');
});

test('C8 scheduler HTTP routes support tenant-fenced claim/heartbeat/complete lifecycle', async (t) => {
  freshEnv(t);
  process.env.KOLM_FORCE_LOCAL_CUDA = '1';
  const { provisionTenant } = await import('../src/auth.js');
  const { buildRouter } = await import('../src/router.js');
  const owner = provisionTenant('c8-http-owner-' + Date.now(), { plan: 'enterprise' });
  const other = provisionTenant('c8-http-other-' + Date.now(), { plan: 'pro' });

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const authOwner = {
    authorization: `Bearer ${owner.api_key}`,
    'content-type': 'application/json',
  };
  const authOther = {
    authorization: `Bearer ${other.api_key}`,
    'content-type': 'application/json',
  };

  const scheduledResp = await fetch(base + '/v1/cloud/broker/schedule', {
    method: 'POST',
    headers: { ...authOwner, 'idempotency-key': 'route-broker-once' },
    body: JSON.stringify({
      workload: 'train',
      params_b: 7,
      rows: 50,
      base_model: 'Qwen/Qwen2.5-7B-Instruct',
    }),
  });
  assert.equal(scheduledResp.status, 200);
  const scheduled = await scheduledResp.json();
  assert.equal(scheduled.ok, true);
  assert.ok(scheduled.scheduler_job_id);

  const foreign = await fetch(base + '/v1/compute/scheduler/jobs/' + scheduled.scheduler_job_id, {
    headers: authOther,
  });
  assert.equal(foreign.status, 404, 'other tenant must not read owner scheduler job');

  const claimResp = await fetch(base + '/v1/compute/scheduler/claim', {
    method: 'POST',
    headers: authOwner,
    body: JSON.stringify({ worker_id: 'route-worker', worker_lanes: ['local-cuda'], lease_ms: 10_000 }),
  });
  assert.equal(claimResp.status, 200);
  const claim = await claimResp.json();
  assert.equal(claim.claimed, true);
  assert.equal(claim.job_id, scheduled.scheduler_job_id);
  assert.ok(claim.lease_token);

  const heartbeatResp = await fetch(base + `/v1/compute/scheduler/jobs/${claim.job_id}/heartbeat`, {
    method: 'POST',
    headers: authOwner,
    body: JSON.stringify({ lease_token: claim.lease_token, lease_ms: 10_000 }),
  });
  assert.equal(heartbeatResp.status, 200);
  const heartbeat = await heartbeatResp.json();
  assert.equal(heartbeat.ok, true);

  const completeResp = await fetch(base + `/v1/compute/scheduler/jobs/${claim.job_id}/complete`, {
    method: 'POST',
    headers: authOwner,
    body: JSON.stringify({ lease_token: claim.lease_token, result: { artifact_url: 'file:///tmp/out.kolm' } }),
  });
  assert.equal(completeResp.status, 200);
  const complete = await completeResp.json();
  assert.equal(complete.state, 'succeeded');

  const listResp = await fetch(base + '/v1/compute/scheduler/jobs?state=succeeded', {
    headers: authOwner,
  });
  assert.equal(listResp.status, 200);
  const listed = await listResp.json();
  assert.equal(listed.count, 1);
  assert.equal(listed.jobs[0].job_id, scheduled.scheduler_job_id);
});
