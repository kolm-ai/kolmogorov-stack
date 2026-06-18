// Cloudflare R2 client - REST API first, S3-compatible object-store fallback.
//
// Env required for REST mode:
//   CLOUDFLARE_ACCOUNT_ID   (alias: cloudflare_account_id)
//   CLOUDFLARE_API_TOKEN    (alias: Cloudflare_api_token)
//
// S3 fallback uses the cloudflare-r2-s3 provider in src/object-storage.js.

import crypto from 'node:crypto';
import { objectStorageReadiness, resolveObjectStore } from './object-storage.js';

export const R2_CLIENT_VERSION = 'w705-r2-client-v1';
export const R2_CLIENT_CONTRACT_VERSION = 'w705-v1';

export const R2_CLIENT_LIMITS = Object.freeze({
  MAX_ACCOUNT_ID_CHARS: 64,
  MAX_BUCKET_CHARS: 63,
  MAX_KEY_CHARS: 1024,
  MAX_CONTENT_TYPE_CHARS: 128,
  MAX_PROVIDER_ERROR_CHARS: 500,
  MAX_PROVIDER_ERRORS: 5,
  DEFAULT_TIMEOUT_MS: 30_000,
  MAX_TIMEOUT_MS: 120_000,
  DEFAULT_MAX_PUT_BYTES: 300 * 1024 * 1024,
});

const FALLBACK_BUCKET = 'kolm-assets';

function envFirst(env, keys) {
  for (const key of keys) {
    const value = env?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function makeError(code, message, extras = {}) {
  const err = new Error(message || code);
  err.code = code;
  Object.assign(err, extras);
  return err;
}

function cleanText(value, max = R2_CLIENT_LIMITS.MAX_PROVIDER_ERROR_CHARS) {
  return String(value ?? '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function redactText(value, token = '') {
  let out = cleanText(value);
  if (token) out = out.split(token).join('[redacted-token]');
  return out
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/(api[_-]?token|secret|access[_-]?key)["'=:\s]+[A-Za-z0-9._~+/=-]+/gi, '$1=[redacted]');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function sanitizeAccountId(value) {
  const accountId = cleanText(value, R2_CLIENT_LIMITS.MAX_ACCOUNT_ID_CHARS + 1);
  if (
    !accountId
    || accountId.length > R2_CLIENT_LIMITS.MAX_ACCOUNT_ID_CHARS
    || !/^[A-Za-z0-9]+$/.test(accountId)
  ) {
    throw makeError('bad_account_id', 'Cloudflare account id must be an opaque account identifier');
  }
  return accountId;
}

export function sanitizeBucketName(value) {
  const bucket = cleanText(value, R2_CLIENT_LIMITS.MAX_BUCKET_CHARS + 1);
  if (
    bucket.length < 3
    || bucket.length > R2_CLIENT_LIMITS.MAX_BUCKET_CHARS
    || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket)
    || bucket.includes('..')
    || bucket.includes('-.')
    || bucket.includes('.-')
    || /^\d+\.\d+\.\d+\.\d+$/.test(bucket)
  ) {
    throw makeError('bad_bucket', 'bucket must be an S3-compatible bucket name');
  }
  return bucket;
}

function sanitizeApiToken(value) {
  const token = String(value ?? '').trim();
  if (!token || token.length > 4096 || /[\x00-\x1f\x7f]/.test(token)) {
    throw makeError('bad_api_token', 'Cloudflare API token is missing or malformed');
  }
  return token;
}

export function sanitizeObjectKey(value) {
  const key = String(value ?? '').replace(/\\/g, '/');
  const parts = key.split('/');
  if (
    !key
    || key.length > R2_CLIENT_LIMITS.MAX_KEY_CHARS
    || key.startsWith('/')
    || key.endsWith('/')
    || parts.some((part) => part === '' || part === '.' || part === '..')
    || /[\x00-\x1f\x7f]/.test(key)
    || !/^[A-Za-z0-9._~!$&'()+,;=@/-]+$/.test(key)
  ) {
    throw makeError('bad_object_key', 'object key must be a bounded relative key without traversal');
  }
  return key;
}

function encodePathPart(part) {
  return encodeURIComponent(part).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function encodeR2ObjectKey(value) {
  return sanitizeObjectKey(value).split('/').map(encodePathPart).join('/');
}

function sanitizeContentType(value) {
  const contentType = cleanText(value || 'application/octet-stream', R2_CLIENT_LIMITS.MAX_CONTENT_TYPE_CHARS + 1);
  if (
    !contentType
    || contentType.length > R2_CLIENT_LIMITS.MAX_CONTENT_TYPE_CHARS
    || /[\r\n]/.test(contentType)
    || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=[A-Za-z0-9!#$&^_.+-]+)*$/.test(contentType)
  ) {
    return 'application/octet-stream';
  }
  return contentType;
}

function safeDefaultBucket(value) {
  try {
    return sanitizeBucketName(value || FALLBACK_BUCKET);
  } catch {
    return FALLBACK_BUCKET;
  }
}

function parsePositiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

export function readR2Config(env = process.env, { strict = false } = {}) {
  const rawAccountId = envFirst(env, ['CLOUDFLARE_ACCOUNT_ID', 'cloudflare_account_id']);
  const rawApiToken = envFirst(env, ['CLOUDFLARE_API_TOKEN', 'Cloudflare_api_token']);
  const rawBucket = envFirst(env, ['R2_BUCKET', 'CLOUDFLARE_R2_BUCKET', 'KOLM_R2_BUCKET']) || FALLBACK_BUCKET;
  const invalid = [];

  let accountId = '';
  if (rawAccountId) {
    try { accountId = sanitizeAccountId(rawAccountId); } catch (err) { invalid.push(err.code || 'bad_account_id'); }
  }

  let apiToken = '';
  if (rawApiToken) {
    try { apiToken = sanitizeApiToken(rawApiToken); } catch (err) { invalid.push(err.code || 'bad_api_token'); }
  }

  let defaultBucket = FALLBACK_BUCKET;
  try { defaultBucket = sanitizeBucketName(rawBucket); } catch (err) { invalid.push(err.code || 'bad_bucket'); }

  if (strict && invalid.length) {
    throw makeError('bad_r2_config', `invalid R2 configuration: ${invalid.join(', ')}`, { invalid });
  }

  return {
    accountId,
    apiToken,
    defaultBucket,
    publicBase: envFirst(env, ['R2_PUBLIC_BASE', 'CLOUDFLARE_R2_PUBLIC_BASE']),
    timeoutMs: parsePositiveInt(
      envFirst(env, ['KOLM_R2_TIMEOUT_MS', 'CLOUDFLARE_R2_TIMEOUT_MS']),
      R2_CLIENT_LIMITS.DEFAULT_TIMEOUT_MS,
      R2_CLIENT_LIMITS.MAX_TIMEOUT_MS,
    ),
    maxPutBytes: parsePositiveInt(
      envFirst(env, ['KOLM_R2_MAX_PUT_BYTES', 'CLOUDFLARE_R2_MAX_PUT_BYTES']),
      R2_CLIENT_LIMITS.DEFAULT_MAX_PUT_BYTES,
      R2_CLIENT_LIMITS.DEFAULT_MAX_PUT_BYTES,
    ),
    configured: !!(accountId && apiToken && invalid.length === 0),
    invalid,
  };
}

const STARTUP_CONFIG = readR2Config(process.env);
export const ACCOUNT_ID = STARTUP_CONFIG.accountId;
export const DEFAULT_BUCKET = safeDefaultBucket(STARTUP_CONFIG.defaultBucket);

function assertRestConfig(env = process.env) {
  const config = readR2Config(env, { strict: true });
  if (!config.accountId) throw makeError('r2_account_id_missing', 'CLOUDFLARE_ACCOUNT_ID not set');
  if (!config.apiToken) throw makeError('r2_api_token_missing', 'CLOUDFLARE_API_TOKEN not set');
  return config;
}

export function r2AccountId(env = process.env) {
  return readR2Config(env).accountId;
}

function authHeaders(extra = {}, config = assertRestConfig()) {
  return { Authorization: `Bearer ${config.apiToken}`, ...extra };
}

function apiBase(config = assertRestConfig()) {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}`;
}

function objectUrl(config, bucket, key) {
  return `${apiBase(config)}/r2/buckets/${encodeURIComponent(sanitizeBucketName(bucket))}/objects/${encodeR2ObjectKey(key)}`;
}

function fetchInit(config, init = {}) {
  if (init.signal || typeof AbortSignal?.timeout !== 'function') return init;
  return { ...init, signal: AbortSignal.timeout(config.timeoutMs) };
}

async function cloudflareFetch(config, url, init = {}) {
  return fetch(url, fetchInit(config, init));
}

function configuredR2S3(env = process.env) {
  return objectStorageReadiness(env).providers
    .find((p) => p.id === 'cloudflare-r2-s3' && p.configured);
}

export function r2Configured(env = process.env) {
  const config = readR2Config(env);
  if (config.configured) return true;
  return !!configuredR2S3(env);
}

function formatProviderErrors(errors, token = '') {
  const rows = Array.isArray(errors) ? errors : [errors];
  return rows
    .slice(0, R2_CLIENT_LIMITS.MAX_PROVIDER_ERRORS)
    .map((row) => {
      if (row && typeof row === 'object') {
        return {
          code: cleanText(row.code || row.name || 'provider_error', 80),
          message: redactText(row.message || row.error || JSON.stringify(row), token),
        };
      }
      return { code: 'provider_error', message: redactText(row, token) };
    });
}

async function parseCloudflareJson(res, op, config) {
  const text = await res.text().catch(() => '');
  let body = {};
  if (text) {
    try { body = JSON.parse(text); } catch {
      throw makeError('r2_non_json_response', `${op} failed with non-JSON response: ${res.status}`, { status: res.status });
    }
  }
  if (!res.ok || body.success === false) {
    const errors = formatProviderErrors(body.errors || text || res.statusText, config.apiToken);
    throw makeError('r2_provider_error', `${op} failed: ${res.status} ${JSON.stringify(errors)}`, {
      status: res.status,
      provider_errors: errors,
    });
  }
  return body;
}

async function storageHttpError(prefix, res, config) {
  const text = await res.text().catch(() => '');
  const err = makeError('r2_http_error', `${prefix}: ${res.status} ${redactText(text, config.apiToken)}`, {
    status: res.status,
  });
  return err;
}

function assertKnownBodyPart(part) {
  if (part == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(part)) return part;
  if (typeof part === 'string') return Buffer.from(part);
  if (part instanceof ArrayBuffer) return Buffer.from(part);
  if (ArrayBuffer.isView(part)) return Buffer.from(part.buffer, part.byteOffset, part.byteLength);
  if (typeof Blob !== 'undefined' && part instanceof Blob) return null;
  if (part && typeof part === 'object' && typeof part[Symbol.asyncIterator] !== 'function' && typeof part[Symbol.iterator] !== 'function') {
    return Buffer.from(JSON.stringify(part));
  }
  return null;
}

async function bodyToBuffer(body, maxBytes) {
  const direct = assertKnownBodyPart(body);
  if (direct) {
    if (direct.length > maxBytes) {
      throw makeError('body_too_large', `object body exceeds ${maxBytes} bytes`, { max_bytes: maxBytes });
    }
    return direct;
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    if (body.size > maxBytes) throw makeError('body_too_large', `object body exceeds ${maxBytes} bytes`, { max_bytes: maxBytes });
    return Buffer.from(await body.arrayBuffer());
  }
  const chunks = [];
  let total = 0;
  const iterable = body?.[Symbol.asyncIterator] ? body : (body?.[Symbol.iterator] ? body : null);
  if (!iterable) throw makeError('bad_body', 'object body must be a string, buffer, blob, iterable, or JSON object');
  for await (const chunk of iterable) {
    const buf = assertKnownBodyPart(chunk);
    if (!buf) throw makeError('bad_body', 'object body stream yielded an unsupported chunk');
    total += buf.length;
    if (total > maxBytes) {
      throw makeError('body_too_large', `object body exceeds ${maxBytes} bytes`, { max_bytes: maxBytes });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function publicBaseUrl(raw) {
  if (!raw) return '';
  let url;
  try { url = new URL(String(raw)); } catch {
    throw makeError('bad_public_base', 'R2 public base must be a valid http(s) URL');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw makeError('bad_public_base', 'R2 public base must be a plain http(s) origin/path without credentials');
  }
  return url.toString().replace(/\/+$/, '');
}

export async function listBuckets() {
  const config = readR2Config(process.env);
  if (!config.configured) {
    const r2s3 = configuredR2S3(process.env);
    if (r2s3) return [{ name: r2s3.bucket || DEFAULT_BUCKET, source: 'cloudflare-r2-s3' }];
  }
  const rest = assertRestConfig();
  const res = await cloudflareFetch(rest, `${apiBase(rest)}/r2/buckets`, { headers: authHeaders({}, rest) });
  const body = await parseCloudflareJson(res, 'r2 listBuckets', rest);
  const buckets = Array.isArray(body.result?.buckets) ? body.result.buckets : [];
  return buckets
    .slice(0, 1000)
    .map((bucket) => (bucket && typeof bucket === 'object' ? { ...bucket, name: cleanText(bucket.name, 128) } : bucket));
}

export async function createBucket(name = DEFAULT_BUCKET) {
  const config = readR2Config(process.env);
  const bucket = sanitizeBucketName(name || config.defaultBucket);
  if (!config.configured) {
    return {
      name: bucket,
      skipped: true,
      reason: 'bucket management requires CLOUDFLARE_API_TOKEN; object reads/writes are available through cloudflare-r2-s3',
    };
  }
  const rest = assertRestConfig();
  const res = await cloudflareFetch(rest, `${apiBase(rest)}/r2/buckets`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }, rest),
    body: JSON.stringify({ name: bucket }),
  });
  const text = await res.text().catch(() => '');
  let body = {};
  if (text) {
    try { body = JSON.parse(text); } catch {
      throw makeError('r2_non_json_response', `r2 createBucket failed with non-JSON response: ${res.status}`, { status: res.status });
    }
  }
  const alreadyExists = formatProviderErrors(body.errors || [], rest.apiToken)
    .some((err) => /already|exists/i.test(err.message));
  if ((!res.ok || body.success === false) && !alreadyExists) {
    const errors = formatProviderErrors(body.errors || text || res.statusText, rest.apiToken);
    throw makeError('r2_provider_error', `r2 createBucket failed: ${res.status} ${JSON.stringify(errors)}`, {
      status: res.status,
      provider_errors: errors,
    });
  }
  return body.result || { name: bucket };
}

export async function putObject(key, body, opts = {}) {
  const safeKey = sanitizeObjectKey(key);
  const config = readR2Config(process.env);
  const contentType = sanitizeContentType(opts.contentType);
  const maxBytes = parsePositiveInt(opts.maxBytes ?? opts.max_bytes, config.maxPutBytes, R2_CLIENT_LIMITS.DEFAULT_MAX_PUT_BYTES);
  const payload = await bodyToBuffer(body, maxBytes);
  if (!config.configured) {
    const store = resolveObjectStore({ provider: 'cloudflare-r2-s3' });
    return store.putObject(safeKey, payload, { ...opts, contentType });
  }
  const rest = assertRestConfig();
  const bucket = sanitizeBucketName(opts.bucket || rest.defaultBucket);
  const res = await cloudflareFetch(rest, objectUrl(rest, bucket, safeKey), {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': contentType }, rest),
    body: payload,
  });
  if (!res.ok) throw await storageHttpError('r2 putObject failed', res, rest);
  return {
    ok: true,
    bucket,
    key: safeKey,
    size: payload.length,
    sha256: sha256Hex(payload),
    etag: res.headers.get('etag') || null,
  };
}

export async function getObject(key, opts = {}) {
  const safeKey = sanitizeObjectKey(key);
  const config = readR2Config(process.env);
  if (!config.configured) {
    const store = resolveObjectStore({ provider: 'cloudflare-r2-s3' });
    const got = await store.getObject(safeKey, opts);
    if (!got) return null;
    return new Response(got.body, {
      status: 200,
      headers: {
        'Content-Type': got.content_type || 'application/octet-stream',
        'Content-Length': String(got.size || got.body.length || 0),
        ...(got.etag ? { ETag: got.etag } : {}),
      },
    });
  }
  const rest = assertRestConfig();
  const bucket = sanitizeBucketName(opts.bucket || rest.defaultBucket);
  const res = await cloudflareFetch(rest, objectUrl(rest, bucket, safeKey), { headers: authHeaders({}, rest) });
  if (res.status === 404) return null;
  if (!res.ok) throw await storageHttpError('r2 getObject failed', res, rest);
  return res;
}

export async function deleteObject(key, opts = {}) {
  const safeKey = sanitizeObjectKey(key);
  const config = readR2Config(process.env);
  if (!config.configured) {
    const store = resolveObjectStore({ provider: 'cloudflare-r2-s3' });
    return store.deleteObject(safeKey, opts);
  }
  const rest = assertRestConfig();
  const bucket = sanitizeBucketName(opts.bucket || rest.defaultBucket);
  const res = await cloudflareFetch(rest, objectUrl(rest, bucket, safeKey), {
    method: 'DELETE',
    headers: authHeaders({}, rest),
  });
  if (!res.ok && res.status !== 404) throw await storageHttpError('r2 deleteObject failed', res, rest);
  return { ok: true, bucket, key: safeKey, deleted: true };
}

export function publicUrl(key, opts = {}) {
  const rawKey = sanitizeObjectKey(key);
  const safeKey = encodeR2ObjectKey(rawKey);
  const config = readR2Config(process.env);
  if (!config.configured) {
    const r2s3 = configuredR2S3(process.env);
    if (r2s3) return resolveObjectStore({ provider: 'cloudflare-r2-s3' }).publicUrl(rawKey);
  }
  const rest = assertRestConfig();
  const bucket = sanitizeBucketName(opts.bucket || rest.defaultBucket);
  const base = publicBaseUrl(rest.publicBase);
  if (base) return `${base}/${safeKey}`;
  return `https://${bucket}.${encodeURIComponent(rest.accountId)}.r2.cloudflarestorage.com/${safeKey}`;
}

export const _internal = Object.freeze({
  authHeaders,
  apiBase,
  bodyToBuffer,
  cleanText,
  configuredR2S3,
  encodePathPart,
  formatProviderErrors,
  objectUrl,
  publicBaseUrl,
  readR2Config,
  redactText,
  sanitizeApiToken,
  sanitizeBucketName,
  sanitizeContentType,
  sanitizeObjectKey,
});

export { ACCOUNT_ID as accountId, DEFAULT_BUCKET as defaultBucket };
