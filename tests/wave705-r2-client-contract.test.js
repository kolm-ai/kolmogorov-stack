// W705 - direct contract for src/r2.js.
//
// Pins the R2 REST client wrapper: live env resolution, bounded key/bucket/body
// validation, query-safe object URL encoding, redacted provider errors, and S3
// fallback behavior without real Cloudflare calls.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const ENV_KEYS = [
  'CLOUDFLARE_ACCOUNT_ID',
  'cloudflare_account_id',
  'CLOUDFLARE_API_TOKEN',
  'Cloudflare_api_token',
  'R2_BUCKET',
  'CLOUDFLARE_R2_BUCKET',
  'KOLM_R2_BUCKET',
  'R2_ACCESS_KEY_ID',
  'CLOUDFLARE_R2_ACCESS_KEY_ID',
  'KOLM_R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
  'KOLM_R2_SECRET_ACCESS_KEY',
  'R2_PUBLIC_BASE',
  'CLOUDFLARE_R2_PUBLIC_BASE',
  'KOLM_R2_MAX_PUT_BYTES',
  'KOLM_R2_TIMEOUT_MS',
];

function installEnv(t, values = {}) {
  const old = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value != null) process.env[key] = String(value);
  }
  t.after(() => {
    for (const key of ENV_KEYS) {
      if (old[key] == null) delete process.env[key];
      else process.env[key] = old[key];
    }
  });
}

async function importR2() {
  return import(`../src/r2.js?wave705=${Date.now()}-${Math.random()}`);
}

function installFetch(t, handler) {
  const oldFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: String(init.method || 'GET'), headers: { ...(init.headers || {}) }, body: init.body });
    return handler(url, init, calls);
  };
  t.after(() => { globalThis.fetch = oldFetch; });
  return calls;
}

test('W705 source pins R2 client contract constants and package depth wiring', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/r2.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  assert.match(src, /R2_CLIENT_VERSION\s*=\s*'w705-r2-client-v1'/);
  assert.match(src, /R2_CLIENT_CONTRACT_VERSION\s*=\s*'w705-v1'/);
  assert.match(src, /MAX_KEY_CHARS:\s*1024/);
  assert.match(src, /encodeR2ObjectKey/);
  assert.match(src, /sanitizeBucketName/);
  assert.doesNotMatch(src, /encodeURI\(key\)/, 'object paths must not preserve query or fragment delimiters');
  assert.equal(
    pkg.scripts['verify:r2-client'],
    'node --test --test-concurrency=1 tests/wave705-r2-client-contract.test.js',
  );
  assert.match(pkg.scripts['verify:depth'], /verify:distill-dedup-worker && npm run verify:r2-client && npm run verify:r2-api/);
});

test('W705 REST client resolves env at call time and percent-encodes object keys', async (t) => {
  installEnv(t);
  const r2 = await importR2();
  process.env.CLOUDFLARE_ACCOUNT_ID = 'acct123456';
  process.env.CLOUDFLARE_API_TOKEN = 'cf-secret-token';
  process.env.R2_BUCKET = 'kolm-artifacts';

  const calls = installFetch(t, () => new Response('', { status: 200, headers: { etag: '"etag-1"' } }));
  const out = await r2.putObject('tenant-a/model+v1.txt', 'artifact-bytes', {
    bucket: 'kolm-artifacts',
    contentType: 'text/plain',
  });

  assert.equal(out.ok, true);
  assert.equal(out.bucket, 'kolm-artifacts');
  assert.equal(out.key, 'tenant-a/model+v1.txt');
  assert.equal(out.size, Buffer.byteLength('artifact-bytes'));
  assert.equal(out.sha256, crypto.createHash('sha256').update('artifact-bytes').digest('hex'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'PUT');
  assert.equal(calls[0].headers.Authorization, 'Bearer cf-secret-token');
  assert.ok(
    calls[0].url.endsWith('/accounts/acct123456/r2/buckets/kolm-artifacts/objects/tenant-a/model%2Bv1.txt'),
    calls[0].url,
  );
  assert.doesNotMatch(calls[0].url, /cf-secret-token/);
  assert.equal(
    r2.publicUrl('tenant-a/model+v1.txt', { bucket: 'kolm-artifacts' }),
    'https://kolm-artifacts.acct123456.r2.cloudflarestorage.com/tenant-a/model%2Bv1.txt',
  );
});

test('W705 client rejects hostile buckets, keys, and oversized bodies before fetch', async (t) => {
  installEnv(t, {
    CLOUDFLARE_ACCOUNT_ID: 'acct123456',
    CLOUDFLARE_API_TOKEN: 'cf-secret-token',
    R2_BUCKET: 'kolm-artifacts',
    KOLM_R2_MAX_PUT_BYTES: '4',
  });
  const r2 = await importR2();
  const calls = installFetch(t, () => new Response('', { status: 200 }));

  await assert.rejects(
    () => r2.putObject('tenant-a/model?x=1#frag', 'ok', { bucket: 'kolm-artifacts' }),
    { code: 'bad_object_key' },
  );
  await assert.rejects(
    () => r2.putObject('../secret.txt', 'ok', { bucket: 'kolm-artifacts' }),
    { code: 'bad_object_key' },
  );
  await assert.rejects(
    () => r2.putObject('tenant-a/model.txt', 'ok', { bucket: 'Bad/Bucket' }),
    { code: 'bad_bucket' },
  );
  await assert.rejects(
    () => r2.putObject('tenant-a/big.txt', '12345', { bucket: 'kolm-artifacts' }),
    { code: 'body_too_large' },
  );
  assert.equal(calls.length, 0, 'invalid requests must not reach upstream fetch');
});

test('W705 fallback mode uses configured R2 S3 storage without REST credentials', async (t) => {
  installEnv(t, {
    CLOUDFLARE_ACCOUNT_ID: 'acct123456',
    R2_ACCESS_KEY_ID: 'r2-access',
    R2_SECRET_ACCESS_KEY: 'r2-secret',
    R2_BUCKET: 'kolm-artifacts',
  });
  const r2 = await importR2();

  assert.equal(r2.r2Configured(), true);
  assert.deepEqual(await r2.listBuckets(), [{ name: 'kolm-artifacts', source: 'cloudflare-r2-s3' }]);
  assert.equal(
    r2.publicUrl('tenant-a/model+v1.kolm'),
    'https://acct123456.r2.cloudflarestorage.com/kolm-artifacts/tenant-a/model%2Bv1.kolm',
  );
  assert.throws(() => r2.publicUrl('../secret.txt'), { code: 'bad_object_key' });
});

test('W705 provider errors are bounded and redacted', async (t) => {
  installEnv(t, {
    CLOUDFLARE_ACCOUNT_ID: 'acct123456',
    CLOUDFLARE_API_TOKEN: 'cf-secret-token',
    R2_BUCKET: 'kolm-artifacts',
  });
  const r2 = await importR2();
  installFetch(t, () => new Response(JSON.stringify({
    success: false,
    errors: [{ code: 'bad', message: `Bearer cf-secret-token ${'x'.repeat(2000)}` }],
  }), { status: 403, headers: { 'content-type': 'application/json' } }));

  await assert.rejects(
    () => r2.listBuckets(),
    (err) => {
      assert.equal(err.code, 'r2_provider_error');
      assert.equal(err.status, 403);
      assert.doesNotMatch(err.message, /cf-secret-token/);
      assert.doesNotMatch(err.message, /Bearer cf-secret-token/);
      assert.ok(err.message.length < 800, err.message.length);
      assert.equal(err.provider_errors[0].code, 'bad');
      return true;
    },
  );
});

test('W705 internal sanitizers fail closed on unsafe inputs', async (t) => {
  installEnv(t);
  const r2 = await importR2();

  assert.equal(r2._internal.sanitizeContentType('text/plain\r\nx-secret: y'), 'application/octet-stream');
  assert.equal(r2._internal.sanitizeContentType('application/json; charset=utf-8'), 'application/json; charset=utf-8');
  assert.equal(r2._internal.publicBaseUrl('https://cdn.example.com/r2/'), 'https://cdn.example.com/r2');
  assert.throws(() => r2._internal.publicBaseUrl('https://user:pass@example.com'), { code: 'bad_public_base' });
  assert.equal(r2.encodeR2ObjectKey("tenant-a/a'b.txt"), 'tenant-a/a%27b.txt');
  assert.throws(() => r2.sanitizeBucketName('192.168.1.1'), { code: 'bad_bucket' });
});
