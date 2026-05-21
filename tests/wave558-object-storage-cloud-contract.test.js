// Wave 558 - real object-storage contract for cloud/enterprise artifacts.
// @public-routes-only

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import express from 'express';

import {
  objectStorageProviders,
  objectStorageReadiness,
  resolveObjectStore,
  smokeObjectStore,
} from '../src/object-storage.js';
import { cloudReadinessSummary, detectCloudReadiness } from '../src/platform-capabilities.js';
import { buildRouter } from '../src/router.js';

const ROOT = path.resolve(import.meta.dirname, '..');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w558-'));
}

test('W558 #1 - object storage readiness covers local, R2 S3, R2 REST, AWS, generic S3, and Supabase without leaking secrets', () => {
  const env = {
    KOLM_DATA_DIR: 'C:/tmp/kolm-local',
    CLOUDFLARE_ACCOUNT_ID: 'acct123',
    CLOUDFLARE_API_TOKEN: 'cf-rest-secret',
    R2_ACCESS_KEY_ID: 'r2-access',
    R2_SECRET_ACCESS_KEY: 'r2-secret',
    R2_BUCKET: 'kolm-artifacts',
    KOLM_S3_ENDPOINT: 'https://minio.internal',
    KOLM_S3_BUCKET: 'kolm-minio',
    KOLM_S3_ACCESS_KEY_ID: 'minio-access',
    KOLM_S3_SECRET_ACCESS_KEY: 'minio-secret',
    AWS_REGION: 'us-east-2',
    AWS_ACCESS_KEY_ID: 'aws-access',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    AWS_S3_BUCKET: 'kolm-aws',
    SUPABASE_URL: 'https://project-ref.storage.supabase.co',
    SUPABASE_STORAGE_BUCKET: 'kolm-supa',
    SUPABASE_S3_ACCESS_KEY_ID: 'supa-access',
    SUPABASE_S3_SECRET_ACCESS_KEY: 'supa-secret',
  };
  const readiness = objectStorageReadiness(env);
  assert.equal(readiness.ok, true);
  assert.equal(readiness.cloud_ok, true);
  assert.equal(readiness.secret_values_included, false);
  const ids = new Set(readiness.providers.map((p) => p.id));
  for (const id of ['local-artifacts', 'cloudflare-r2-s3', 'cloudflare-r2-rest', 's3-compatible', 'aws-s3', 'supabase-s3']) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
  assert.equal(readiness.selected_provider, 'cloudflare-r2-s3');
  assert.doesNotMatch(JSON.stringify(readiness), /cf-rest-secret|r2-secret|minio-secret|aws-secret|supa-secret/);
});

test('W558 #2 - S3-compatible artifact store signs PUT/GET/HEAD/DELETE requests with AWS SigV4', async () => {
  const calls = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method, headers: { ...(init.headers || {}) }, body: init.body });
    if (init.method === 'GET') return new Response('artifact-bytes', { status: 200, headers: { 'content-type': 'application/octet-stream', etag: '"g"' } });
    if (init.method === 'HEAD') return new Response('', { status: 200, headers: { 'content-length': '14', etag: '"h"' } });
    return new Response('', { status: 200, headers: { etag: '"ok"' } });
  };
  try {
    const env = {
      CLOUDFLARE_ACCOUNT_ID: 'acct123',
      R2_ACCESS_KEY_ID: 'r2-access',
      R2_SECRET_ACCESS_KEY: 'r2-secret-value',
      R2_BUCKET: 'kolm-artifacts',
    };
    const store = resolveObjectStore({ env, provider: 'cloudflare-r2-s3' });
    const put = await store.putObject('tenant-a/artifacts/model.kolm', 'artifact-bytes', { contentType: 'application/zip' });
    const head = await store.headObject('tenant-a/artifacts/model.kolm');
    const got = await store.getObject('tenant-a/artifacts/model.kolm');
    const del = await store.deleteObject('tenant-a/artifacts/model.kolm');

    assert.equal(put.ok, true);
    assert.equal(head.size, 14);
    assert.equal(got.body.toString('utf8'), 'artifact-bytes');
    assert.equal(del.deleted, true);
    assert.deepEqual(calls.map((c) => c.method), ['PUT', 'HEAD', 'GET', 'DELETE']);
    assert.ok(calls.every((c) => c.url.startsWith('https://acct123.r2.cloudflarestorage.com/kolm-artifacts/tenant-a/artifacts/model.kolm')));
    assert.ok(calls.every((c) => /AWS4-HMAC-SHA256/.test(c.headers.authorization)));
    assert.ok(calls.every((c) => c.headers['x-amz-content-sha256']));
    assert.doesNotMatch(JSON.stringify(calls), /r2-secret-value/);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('W558 #3 - local object-store smoke writes, reads, verifies, and deletes bytes', async () => {
  const dir = tmpDir();
  try {
    const env = { KOLM_DATA_DIR: dir };
    const smoke = await smokeObjectStore({ env, provider: 'local-artifacts' });
    assert.equal(smoke.ok, true);
    assert.equal(smoke.provider, 'local-artifacts');
    const full = path.join(dir, 'artifacts', smoke.key);
    assert.equal(fs.existsSync(full), false, 'smoke object should be deleted after round trip');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('W558 #4 - platform cloud readiness understands S3-style R2 and Supabase storage as real artifact storage', () => {
  const env = {
    CLOUDFLARE_ACCOUNT_ID: 'acct123',
    R2_ACCESS_KEY_ID: 'r2-access',
    R2_SECRET_ACCESS_KEY: 'r2-secret-value',
    R2_BUCKET: 'kolm-artifacts',
    KOLM_RUNPOD_TOKEN: 'runpod-secret',
    SUPABASE_URL: 'https://project-ref.storage.supabase.co',
    SUPABASE_STORAGE_BUCKET: 'kolm-supa',
    SUPABASE_S3_ACCESS_KEY_ID: 'supa-access',
    SUPABASE_S3_SECRET_ACCESS_KEY: 'supa-secret',
  };
  const cloud = detectCloudReadiness(env);
  assert.equal(cloud.ok, true);
  assert.ok(cloud.providers.some((p) => p.id === 'cloudflare-r2' && p.configured));
  assert.ok(cloud.providers.some((p) => p.id === 'supabase-storage' && p.configured));
  const summary = cloudReadinessSummary(env);
  assert.equal(summary.object_storage.cloud_ok, true);
  assert.ok(summary.object_storage.configured_cloud_provider_ids.includes('cloudflare-r2-s3'));
  assert.doesNotMatch(JSON.stringify(summary), /r2-secret-value|runpod-secret|supa-secret/);
});

test('W558 #5 - hosted readiness route exposes object storage contract for account UI', async (t) => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const res = await fetch(base + '/v1/storage/object-readiness');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.storage.secret_values_included, false);
  assert.ok(body.storage.providers.some((p) => p.id === 'local-artifacts' && p.configured));
});

test('W558 #6 - CLI exposes object storage readiness and local round-trip smoke', () => {
  const dir = tmpDir();
  const env = { ...process.env, KOLM_DATA_DIR: dir };
  try {
    const ready = spawnSync(process.execPath, ['cli/kolm.js', 'cloud', 'storage', '--json'], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(ready.status, 0, ready.stderr || ready.stdout);
    const readyBody = JSON.parse(ready.stdout);
    assert.equal(readyBody.ok, true);
    assert.ok(readyBody.providers.some((p) => p.id === 'local-artifacts' && p.configured));
    assert.equal(readyBody.secret_values_included, false);

    const smoke = spawnSync(process.execPath, ['cli/kolm.js', 'cloud', 'storage', '--provider', 'local-artifacts', '--smoke', '--json'], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(smoke.status, 0, smoke.stderr || smoke.stdout);
    const smokeBody = JSON.parse(smoke.stdout);
    assert.equal(smokeBody.ok, true);
    assert.equal(smokeBody.provider, 'local-artifacts');
    assert.equal(smokeBody.round_trip, true);
    assert.equal(smokeBody.secret_values_included, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
