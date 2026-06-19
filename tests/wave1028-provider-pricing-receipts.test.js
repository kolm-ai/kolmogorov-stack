// W1028 - provider pricing receipts.
//
// Cloud-distill must not hand-wave public provider pricing. A submitted
// managed-provider job can now carry a normalized, source-attributed pricing
// receipt with a stable hash for public display and hosted-capacity evidence.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildProviderPricingReceipt,
  normalizeProviderPricingSnapshot,
  verifyProviderPricingReceipt,
  PROVIDER_PRICING_RECEIPT_VERSION,
} from '../src/provider-pricing-receipts.js';
import {
  submitJob,
  getJobStatus,
  _resetForTests,
} from '../src/cloud-distill.js';
import {
  getSchedulerJob,
  _resetSchedulerForTests,
} from '../src/compute-scheduler.js';
import {
  assessHostedTrainServeCapacity,
} from '../src/compile-api-readiness.js';

const GOOD_SHA = 'b'.repeat(64);

function freshEnv(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w1028-pricing-'));
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';
  process.env.KOLM_ENV = 'test';
  for (const key of [
    'KOLM_COMPUTE_SCHEDULER_DIR',
    'KOLM_CLOUD_DISTILL_ENDPOINT',
    'KOLM_TRAINER_BRIDGE_URL',
    'KOLM_TRAINER_BRIDGE_TOKEN',
    'KOLM_MANAGED_DISTILL_PROVIDER',
    'KOLM_CLOUD_DISTILL_PROVIDER',
    'KOLM_RUNPOD_TOKEN',
    'RUNPOD_API_KEY',
    'KOLM_RUNPOD_DISTILL_ENDPOINT_ID',
    'KOLM_RUNPOD_ENDPOINT_ID',
    'RUNPOD_ENDPOINT_ID',
    'KOLM_REQUIRE_PROVIDER_PRICE_RECEIPT',
    'KOLM_REQUIRE_PROVIDER_PRICING_RECEIPT',
    'PUBLIC_BASE',
    'KOLM_PUBLIC_BASE',
  ]) {
    delete process.env[key];
  }
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  _resetSchedulerForTests();
  _resetForTests();
  t.after(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  });
}

function runpodPricingSnapshot() {
  return {
    provider: 'runpod',
    operation: 'training',
    model: 'Qwen/Qwen3-8B',
    source_url: 'https://docs.runpod.io/pricing',
    published_at: '2026-06-01',
    retrieved_at: '2026-06-19',
    rates: [
      { unit: 'gpu_hour', usd: 1.99, sku: 'H100-80GB', note: 'published GPU-hour training lane' },
    ],
  };
}

test('W1028 provider pricing receipt normalizes published rate snapshots and verifies its hash', () => {
  const receipt = buildProviderPricingReceipt({
    provider: 'together',
    operation: 'fine_tune',
    model: 'Qwen/Qwen3-8B',
    source_url: 'https://www.together.ai/pricing',
    published_at: '2026-06-01',
    retrieved_at: '2026-06-19',
    rates: [
      { unit: '1m_training_tokens', usd: 2.5 },
      { unit: '1m_input_tokens', usd: 0.1, operation: 'inference' },
      { unit: '1m_output_tokens', usd: 0.4, operation: 'inference' },
    ],
    usage: {
      training_tokens: 2_000_000,
      input_tokens: 1_000_000,
      output_tokens: 500_000,
    },
    kolm_job_id: 'cdj_price_1',
    launch_spec_hash: GOOD_SHA,
  });

  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.equal(receipt.version, PROVIDER_PRICING_RECEIPT_VERSION);
  assert.equal(receipt.scope, 'provider_published_rate_snapshot');
  assert.equal(receipt.estimated_cost_usd, 5.3);
  assert.match(receipt.receipt_hash, /^[a-f0-9]{64}$/);
  assert.equal(receipt.public_display.source_url, 'https://www.together.ai/pricing');
  assert.equal(receipt.public_display.rows.length, 3);
  assert.equal(JSON.stringify(receipt).includes('secret'), false);

  const verified = verifyProviderPricingReceipt(receipt);
  assert.equal(verified.ok, true, JSON.stringify(verified));
  assert.equal(verified.receipt_hash, receipt.receipt_hash);
});

test('W1028 pricing snapshots fail closed without source, date, rows, or with credentialed URLs', () => {
  assert.equal(normalizeProviderPricingSnapshot({ provider: 'runpod', published_at: '2026-06-01', rates: [{ unit: 'gpu_hour', usd: 1 }] }).error, 'source_url_required');
  assert.equal(normalizeProviderPricingSnapshot({ provider: 'runpod', source_url: 'https://docs.runpod.io/pricing', rates: [{ unit: 'gpu_hour', usd: 1 }] }).error, 'published_at_required');
  assert.equal(normalizeProviderPricingSnapshot({ provider: 'runpod', source_url: 'https://docs.runpod.io/pricing', published_at: '2026-06-01' }).error, 'price_rows_required');
  assert.equal(normalizeProviderPricingSnapshot({
    provider: 'runpod',
    source_url: 'https://docs.runpod.io/pricing?api_key=secret',
    published_at: '2026-06-01',
    rates: [{ unit: 'gpu_hour', usd: 1 }],
  }).error, 'source_url_must_not_embed_secrets');
});

test('W1028 cloud-distill persists provider price receipt hash/display and replays idempotently', async (t) => {
  freshEnv(t);
  process.env.KOLM_MANAGED_DISTILL_PROVIDER = 'runpod';
  process.env.KOLM_RUNPOD_TOKEN = 'runpod-secret';
  process.env.KOLM_RUNPOD_DISTILL_ENDPOINT_ID = 'rp-price';

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    assert.equal(JSON.stringify(init).includes('runpod-secret'), true);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 'rp-price-job', status: 'IN_QUEUE' }),
    };
  };

  const submitted = await submitJob({
    tenant: 'tenant_price',
    namespace: 'support',
    recipe_id: 'recipe-price',
    student: 'Qwen/Qwen3-8B',
    idempotency_key: 'price-once',
    gpu_sku: 'H100-80GB',
    estimated_gpu_hours: 2.5,
    provider_pricing_snapshot: runpodPricingSnapshot(),
    fetchImpl,
  });

  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  assert.equal(submitted.managed_provider, 'runpod');
  assert.match(submitted.provider_price_receipt_hash, /^[a-f0-9]{64}$/);
  assert.equal(submitted.estimated_provider_price_usd, 4.975);
  assert.equal(submitted.provider_price_receipt_public_display.source_url, 'https://docs.runpod.io/pricing');
  assert.equal(submitted.provider_price_receipt_public_display.rows[0].rate, '$1.99 / GPU-hour');
  assert.equal(JSON.stringify(submitted).includes('runpod-secret'), false);

  const status = getJobStatus({ tenant: 'tenant_price', job_id: submitted.job_id });
  assert.equal(status.ok, true);
  assert.equal(status.provider_price_receipt_hash, submitted.provider_price_receipt_hash);
  assert.equal(status.estimated_provider_price_usd, 4.975);

  const scheduler = getSchedulerJob({ tenant: 'tenant_price', job_id: submitted.scheduler_job_id });
  assert.equal(scheduler.ok, true);
  assert.equal(scheduler.job.payload.provider_price_receipt_hash, submitted.provider_price_receipt_hash);
  assert.equal(scheduler.job.lineage.provider_price_receipt_hash, submitted.provider_price_receipt_hash);
  assert.equal(scheduler.job.payload.estimated_provider_price_usd, 4.975);
  assert.equal(JSON.stringify(scheduler.job).includes('runpod-secret'), false);

  const replay = await submitJob({
    tenant: 'tenant_price',
    namespace: 'support',
    idempotency_key: 'price-once',
    fetchImpl: async () => {
      throw new Error('idempotent replay must not resubmit provider job');
    },
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.provider_price_receipt_hash, submitted.provider_price_receipt_hash);
  assert.equal(replay.estimated_provider_price_usd, 4.975);
  assert.equal(calls.length, 1);
});

test('W1028 requiring provider price receipts fails closed before scheduling or provider dispatch', async (t) => {
  freshEnv(t);
  process.env.KOLM_MANAGED_DISTILL_PROVIDER = 'runpod';
  process.env.KOLM_RUNPOD_TOKEN = 'runpod-secret';
  process.env.KOLM_RUNPOD_DISTILL_ENDPOINT_ID = 'rp-price';

  const submitted = await submitJob({
    tenant: 'tenant_required_price',
    namespace: 'support',
    require_provider_price_receipt: true,
    fetchImpl: async () => {
      throw new Error('missing price receipt must fail before provider dispatch');
    },
  });

  assert.equal(submitted.ok, false);
  assert.equal(submitted.error, 'provider_price_receipt_required');
  assert.equal(submitted.provider_pricing_receipt_version, PROVIDER_PRICING_RECEIPT_VERSION);
});

test('W1028 provider price receipt hash can satisfy the hosted-capacity price evidence gate', async (t) => {
  freshEnv(t);
  const receipt = buildProviderPricingReceipt({
    ...runpodPricingSnapshot(),
    usage: { gpu_hours: 1 },
    kolm_job_id: 'cdj_capacity_price',
  });
  assert.equal(receipt.ok, true);

  const hosted = assessHostedTrainServeCapacity({
    cloud_distill_endpoint: 'https://train.kolm.example',
    hosted_serve_endpoint: 'https://serve.kolm.example',
    artifact_bucket: 'r2://kolm-hosted-artifacts',
    price_receipt_hash: receipt.receipt_hash,
    operated_fleet_evidence_hash: GOOD_SHA,
    public_status_url: 'https://status.kolm.example',
  });
  assert.equal(hosted.default_hosted_train_serve_claimable, true);
  assert.deepEqual(hosted.blockers, []);
});
