import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EMPTY_SHA256 = sha256Hex(Buffer.alloc(0));

function envFirst(env, keys) {
  for (const key of keys) {
    const v = env[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function boolEnv(env, key, fallback = false) {
  const v = env[key];
  if (v == null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v));
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(key, value, enc) {
  return crypto.createHmac('sha256', key).update(value).digest(enc);
}

function bodyBuffer(body) {
  if (body == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body);
  return Buffer.from(JSON.stringify(body));
}

function cleanKey(key) {
  const raw = String(key || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw || raw.includes('..')) {
    const err = new Error('object key must be a non-empty relative path');
    err.code = 'bad_object_key';
    throw err;
  }
  return raw;
}

function encodePathPart(part) {
  return encodeURIComponent(part).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function encodeS3Key(key) {
  return cleanKey(key).split('/').map(encodePathPart).join('/');
}

function localBase(env) {
  return path.resolve(
    env.KOLM_ARTIFACT_DIR ||
    (env.KOLM_DATA_DIR ? path.join(env.KOLM_DATA_DIR, 'artifacts') : path.join(os.homedir(), '.kolm', 'artifacts'))
  );
}

function missing(keys, env) {
  return keys.filter((k) => !envFirst(env, [k]));
}

function s3Provider({
  id,
  label,
  env,
  endpoint,
  bucket,
  region,
  accessKeyId,
  secretAccessKey,
  sessionToken = '',
  pathStyle = true,
  publicBase = '',
  docsUrl = null,
}) {
  const requiredMissing = [];
  if (!endpoint) requiredMissing.push('endpoint');
  if (!bucket) requiredMissing.push('bucket');
  if (!accessKeyId) requiredMissing.push('access_key_id');
  if (!secretAccessKey) requiredMissing.push('secret_access_key');
  return {
    id,
    label,
    kind: 's3-compatible',
    category: 'artifact-storage',
    configured: requiredMissing.length === 0,
    missing: requiredMissing,
    capabilities: ['put', 'get', 'head', 'delete', 'list', 'sha256-payload-signing'],
    bucket: bucket || null,
    endpoint: endpoint || null,
    region: region || 'us-east-1',
    path_style: !!pathStyle,
    public_base_configured: !!publicBase,
    max_single_object_bytes: 5 * 1024 * 1024 * 1024,
    docs_url: docsUrl,
    secret_values_included: false,
    _config: {
      env,
      endpoint,
      bucket,
      region: region || 'us-east-1',
      accessKeyId,
      secretAccessKey,
      sessionToken,
      pathStyle: !!pathStyle,
      publicBase,
    },
  };
}

function restR2Provider(env) {
  const accountId = envFirst(env, ['CLOUDFLARE_ACCOUNT_ID', 'cloudflare_account_id']);
  const apiToken = envFirst(env, ['CLOUDFLARE_API_TOKEN', 'Cloudflare_api_token']);
  const bucket = envFirst(env, ['R2_BUCKET', 'CLOUDFLARE_R2_BUCKET', 'KOLM_R2_BUCKET']) || 'kolm-artifacts';
  return {
    id: 'cloudflare-r2-rest',
    label: 'Cloudflare R2 REST API',
    kind: 'cloudflare-rest',
    category: 'artifact-storage',
    configured: !!(accountId && apiToken),
    missing: [
      ...(accountId ? [] : ['CLOUDFLARE_ACCOUNT_ID']),
      ...(apiToken ? [] : ['CLOUDFLARE_API_TOKEN']),
    ],
    capabilities: ['put', 'get', 'head', 'delete', 'list-buckets'],
    bucket,
    endpoint: accountId ? `https://api.cloudflare.com/client/v4/accounts/${accountId}` : null,
    max_single_object_bytes: 300 * 1024 * 1024,
    docs_url: 'https://developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/objects/methods/upload/',
    caveats: ['Cloudflare object REST upload is capped at 300 MB; use R2 S3 credentials for larger model artifacts.'],
    secret_values_included: false,
    _config: { env, accountId, apiToken, bucket, publicBase: envFirst(env, ['R2_PUBLIC_BASE', 'CLOUDFLARE_R2_PUBLIC_BASE']) },
  };
}

function providerConfigs(env = process.env) {
  const cloudflareAccount = envFirst(env, ['CLOUDFLARE_ACCOUNT_ID', 'cloudflare_account_id']);
  const r2Bucket = envFirst(env, ['R2_BUCKET', 'CLOUDFLARE_R2_BUCKET', 'KOLM_R2_BUCKET']) || 'kolm-artifacts';
  const r2Access = envFirst(env, ['R2_ACCESS_KEY_ID', 'CLOUDFLARE_R2_ACCESS_KEY_ID', 'KOLM_R2_ACCESS_KEY_ID']);
  const r2Secret = envFirst(env, ['R2_SECRET_ACCESS_KEY', 'CLOUDFLARE_R2_SECRET_ACCESS_KEY', 'KOLM_R2_SECRET_ACCESS_KEY']);
  const s3Endpoint = envFirst(env, ['KOLM_S3_ENDPOINT', 'S3_ENDPOINT']);
  const s3Bucket = envFirst(env, ['KOLM_S3_BUCKET', 'S3_BUCKET']);
  const s3Access = envFirst(env, ['KOLM_S3_ACCESS_KEY_ID', 'S3_ACCESS_KEY_ID']);
  const s3Secret = envFirst(env, ['KOLM_S3_SECRET_ACCESS_KEY', 'S3_SECRET_ACCESS_KEY']);
  const awsRegion = envFirst(env, ['AWS_REGION', 'AWS_DEFAULT_REGION']) || 'us-east-1';
  const awsBucket = envFirst(env, ['KOLM_S3_BUCKET', 'AWS_S3_BUCKET', 'S3_BUCKET']);
  const supabaseUrl = envFirst(env, ['SUPABASE_URL']);
  const supabaseEndpoint = envFirst(env, ['SUPABASE_S3_ENDPOINT']) || (supabaseUrl ? `${supabaseUrl.replace(/\/+$/, '')}/storage/v1/s3` : '');
  const supabaseBucket = envFirst(env, ['SUPABASE_STORAGE_BUCKET', 'SUPABASE_S3_BUCKET']);
  const supabaseAccess = envFirst(env, ['SUPABASE_S3_ACCESS_KEY_ID', 'S3_PROTOCOL_ACCESS_KEY_ID', 'STORAGE_TENANT_ID']);
  const supabaseSecret = envFirst(env, ['SUPABASE_S3_SECRET_ACCESS_KEY', 'S3_PROTOCOL_ACCESS_KEY_SECRET', 'SUPABASE_ANON_KEY']);

  return [
    {
      id: 'local-artifacts',
      label: 'Local artifact directory',
      kind: 'local',
      category: 'local',
      configured: true,
      missing: [],
      capabilities: ['put', 'get', 'head', 'delete', 'list'],
      bucket: null,
      endpoint: localBase(env),
      max_single_object_bytes: null,
      secret_values_included: false,
      _config: { env, root: localBase(env) },
    },
    s3Provider({
      id: 'cloudflare-r2-s3',
      label: 'Cloudflare R2 S3-compatible API',
      env,
      endpoint: cloudflareAccount ? `https://${cloudflareAccount}.r2.cloudflarestorage.com` : '',
      bucket: r2Bucket,
      region: 'auto',
      accessKeyId: r2Access,
      secretAccessKey: r2Secret,
      publicBase: envFirst(env, ['R2_PUBLIC_BASE', 'CLOUDFLARE_R2_PUBLIC_BASE']),
      pathStyle: true,
      docsUrl: 'https://developers.cloudflare.com/r2/api/s3/api/',
    }),
    restR2Provider(env),
    s3Provider({
      id: 's3-compatible',
      label: 'Generic S3-compatible storage',
      env,
      endpoint: s3Endpoint,
      bucket: s3Bucket,
      region: envFirst(env, ['KOLM_S3_REGION', 'S3_REGION']) || 'us-east-1',
      accessKeyId: s3Access,
      secretAccessKey: s3Secret,
      sessionToken: envFirst(env, ['KOLM_S3_SESSION_TOKEN', 'S3_SESSION_TOKEN']),
      pathStyle: boolEnv(env, 'KOLM_S3_FORCE_PATH_STYLE', true),
      publicBase: envFirst(env, ['KOLM_S3_PUBLIC_BASE', 'S3_PUBLIC_BASE']),
      docsUrl: 'https://docs.aws.amazon.com/AmazonS3/latest/API/Type_API_Reference.html',
    }),
    s3Provider({
      id: 'aws-s3',
      label: 'AWS S3',
      env,
      endpoint: awsBucket ? `https://${awsBucket}.s3.${awsRegion}.amazonaws.com` : '',
      bucket: awsBucket,
      region: awsRegion,
      accessKeyId: envFirst(env, ['AWS_ACCESS_KEY_ID']),
      secretAccessKey: envFirst(env, ['AWS_SECRET_ACCESS_KEY']),
      sessionToken: envFirst(env, ['AWS_SESSION_TOKEN']),
      pathStyle: false,
      publicBase: envFirst(env, ['KOLM_S3_PUBLIC_BASE', 'AWS_S3_PUBLIC_BASE']),
      docsUrl: 'https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html',
    }),
    s3Provider({
      id: 'supabase-s3',
      label: 'Supabase Storage S3-compatible API',
      env,
      endpoint: supabaseEndpoint,
      bucket: supabaseBucket,
      region: envFirst(env, ['SUPABASE_S3_REGION', 'REGION']) || 'us-east-1',
      accessKeyId: supabaseAccess,
      secretAccessKey: supabaseSecret,
      sessionToken: envFirst(env, ['SUPABASE_S3_SESSION_TOKEN']),
      pathStyle: true,
      publicBase: '',
      docsUrl: 'https://supabase.com/docs/guides/storage/s3/compatibility',
    }),
  ];
}

function publicProvider(provider) {
  const { _config, ...safe } = provider;
  return safe;
}

export function objectStorageProviders(env = process.env) {
  return providerConfigs(env).map(publicProvider);
}

export function objectStorageReadiness(env = process.env) {
  const providers = objectStorageProviders(env);
  const cloud = providers.filter((p) => p.category === 'artifact-storage');
  const configuredCloud = cloud.filter((p) => p.configured);
  const configured = providers.filter((p) => p.configured);
  const selected = selectProvider(providerConfigs(env), env);
  return {
    ok: configured.length > 0,
    cloud_ok: configuredCloud.length > 0,
    selected_provider: selected ? selected.id : null,
    configured_provider_ids: configured.map((p) => p.id),
    configured_cloud_provider_ids: configuredCloud.map((p) => p.id),
    providers,
    secret_values_included: false,
  };
}

function selectProvider(providers, env, requested = '') {
  const req = requested || envFirst(env, ['KOLM_OBJECT_STORAGE_PROVIDER', 'KOLM_STORAGE_PROVIDER']);
  if (req) return providers.find((p) => p.id === req) || null;
  const priority = ['cloudflare-r2-s3', 'cloudflare-r2-rest', 's3-compatible', 'aws-s3', 'supabase-s3', 'local-artifacts'];
  for (const id of priority) {
    const p = providers.find((row) => row.id === id && row.configured);
    if (p) return p;
  }
  return providers.find((p) => p.configured) || null;
}

export function resolveObjectStore({ env = process.env, provider = '' } = {}) {
  const row = selectProvider(providerConfigs(env), env, provider);
  if (!row || !row.configured) {
    const err = new Error(provider ? `object storage provider ${provider} is not configured` : 'no object storage provider configured');
    err.code = 'object_storage_not_configured';
    err.readiness = objectStorageReadiness(env);
    throw err;
  }
  return new ObjectStore(row);
}

export class ObjectStore {
  constructor(provider) {
    this.provider = provider.id;
    this.kind = provider.kind;
    this.bucket = provider.bucket || null;
    this._config = provider._config || {};
  }

  publicUrl(key) {
    const safeKey = encodeS3Key(key);
    if (this.kind === 'local') return path.join(this._config.root, cleanKey(key));
    if (this._config.publicBase) return `${this._config.publicBase.replace(/\/+$/, '')}/${safeKey}`;
    if (this.kind === 'cloudflare-rest') {
      return `https://${this.bucket}.${this._config.accountId}.r2.cloudflarestorage.com/${safeKey}`;
    }
    const endpoint = String(this._config.endpoint || '').replace(/\/+$/, '');
    if (!this._config.pathStyle) return `${endpoint}/${safeKey}`;
    return `${endpoint}/${encodeURIComponent(this.bucket)}/${safeKey}`;
  }

  async putObject(key, body, opts = {}) {
    if (this.kind === 'local') return this._localPut(key, body, opts);
    if (this.kind === 'cloudflare-rest') return this._r2RestPut(key, body, opts);
    return this._s3Put(key, body, opts);
  }

  async getObject(key, opts = {}) {
    if (this.kind === 'local') return this._localGet(key, opts);
    if (this.kind === 'cloudflare-rest') return this._r2RestGet(key, opts);
    return this._s3Get(key, opts);
  }

  async headObject(key, opts = {}) {
    if (this.kind === 'local') return this._localHead(key, opts);
    if (this.kind === 'cloudflare-rest') return this._r2RestHead(key, opts);
    return this._s3Head(key, opts);
  }

  async deleteObject(key, opts = {}) {
    if (this.kind === 'local') return this._localDelete(key, opts);
    if (this.kind === 'cloudflare-rest') return this._r2RestDelete(key, opts);
    return this._s3Delete(key, opts);
  }

  _localPath(key) {
    const root = path.resolve(this._config.root);
    const full = path.resolve(root, cleanKey(key));
    if (!full.startsWith(root + path.sep) && full !== root) {
      const err = new Error('object key escapes storage root');
      err.code = 'bad_object_key';
      throw err;
    }
    return full;
  }

  async _localPut(key, body, opts = {}) {
    const buf = bodyBuffer(body);
    const file = this._localPath(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    return {
      ok: true,
      provider: this.provider,
      bucket: null,
      key: cleanKey(key),
      size: buf.length,
      sha256: sha256Hex(buf),
      content_type: opts.contentType || 'application/octet-stream',
      public_url: this.publicUrl(key),
    };
  }

  async _localGet(key) {
    const file = this._localPath(key);
    if (!fs.existsSync(file)) return null;
    const body = fs.readFileSync(file);
    return { ok: true, provider: this.provider, bucket: null, key: cleanKey(key), body, size: body.length, sha256: sha256Hex(body) };
  }

  async _localHead(key) {
    const file = this._localPath(key);
    if (!fs.existsSync(file)) return null;
    const st = fs.statSync(file);
    return { ok: true, provider: this.provider, bucket: null, key: cleanKey(key), size: st.size, updated_at: st.mtime.toISOString() };
  }

  async _localDelete(key) {
    const file = this._localPath(key);
    try { fs.rmSync(file, { force: true }); } catch {}
    return { ok: true, provider: this.provider, bucket: null, key: cleanKey(key), deleted: true };
  }

  _r2RestUrl(key) {
    return `https://api.cloudflare.com/client/v4/accounts/${this._config.accountId}/r2/buckets/${encodeURIComponent(this.bucket)}/objects/${encodeS3Key(key)}`;
  }

  _r2Headers(extra = {}) {
    return { Authorization: `Bearer ${this._config.apiToken}`, ...extra };
  }

  async _r2RestPut(key, body, opts = {}) {
    const buf = bodyBuffer(body);
    const res = await fetch(this._r2RestUrl(key), {
      method: 'PUT',
      headers: this._r2Headers({ 'Content-Type': opts.contentType || 'application/octet-stream' }),
      body: buf,
    });
    if (!res.ok) throw await storageHttpError('r2 rest putObject failed', res);
    return { ok: true, provider: this.provider, bucket: this.bucket, key: cleanKey(key), size: buf.length, sha256: sha256Hex(buf), public_url: this.publicUrl(key) };
  }

  async _r2RestGet(key) {
    const res = await fetch(this._r2RestUrl(key), { headers: this._r2Headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw await storageHttpError('r2 rest getObject failed', res);
    const body = Buffer.from(await res.arrayBuffer());
    return { ok: true, provider: this.provider, bucket: this.bucket, key: cleanKey(key), body, size: body.length, sha256: sha256Hex(body), content_type: res.headers.get('content-type') || null };
  }

  async _r2RestHead(key) {
    const res = await fetch(this._r2RestUrl(key), { method: 'HEAD', headers: this._r2Headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw await storageHttpError('r2 rest headObject failed', res);
    return { ok: true, provider: this.provider, bucket: this.bucket, key: cleanKey(key), size: Number(res.headers.get('content-length') || 0), etag: res.headers.get('etag') || null };
  }

  async _r2RestDelete(key) {
    const res = await fetch(this._r2RestUrl(key), { method: 'DELETE', headers: this._r2Headers() });
    if (!res.ok && res.status !== 404) throw await storageHttpError('r2 rest deleteObject failed', res);
    return { ok: true, provider: this.provider, bucket: this.bucket, key: cleanKey(key), deleted: true };
  }

  async _s3Put(key, body, opts = {}) {
    const buf = bodyBuffer(body);
    const res = await signedS3Fetch(this._config, 'PUT', key, {
      body: buf,
      contentType: opts.contentType || 'application/octet-stream',
    });
    if (!res.ok) throw await storageHttpError('s3 putObject failed', res);
    return { ok: true, provider: this.provider, bucket: this.bucket, key: cleanKey(key), size: buf.length, sha256: sha256Hex(buf), etag: res.headers.get('etag') || null, public_url: this.publicUrl(key) };
  }

  async _s3Get(key) {
    const res = await signedS3Fetch(this._config, 'GET', key);
    if (res.status === 404) return null;
    if (!res.ok) throw await storageHttpError('s3 getObject failed', res);
    const body = Buffer.from(await res.arrayBuffer());
    return { ok: true, provider: this.provider, bucket: this.bucket, key: cleanKey(key), body, size: body.length, sha256: sha256Hex(body), etag: res.headers.get('etag') || null, content_type: res.headers.get('content-type') || null };
  }

  async _s3Head(key) {
    const res = await signedS3Fetch(this._config, 'HEAD', key);
    if (res.status === 404) return null;
    if (!res.ok) throw await storageHttpError('s3 headObject failed', res);
    return { ok: true, provider: this.provider, bucket: this.bucket, key: cleanKey(key), size: Number(res.headers.get('content-length') || 0), etag: res.headers.get('etag') || null };
  }

  async _s3Delete(key) {
    const res = await signedS3Fetch(this._config, 'DELETE', key);
    if (!res.ok && res.status !== 404) throw await storageHttpError('s3 deleteObject failed', res);
    return { ok: true, provider: this.provider, bucket: this.bucket, key: cleanKey(key), deleted: true };
  }
}

async function storageHttpError(prefix, res) {
  const text = await res.text().catch(() => '');
  const err = new Error(`${prefix}: ${res.status} ${String(text).slice(0, 500)}`);
  err.code = 'object_storage_http_error';
  err.status = res.status;
  return err;
}

function amzTimestamp(date = new Date()) {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function canonicalQuery(params) {
  const pairs = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (v == null) continue;
    pairs.push([encodeURIComponent(k), encodeURIComponent(String(v))]);
  }
  return pairs.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1])).map(([k, v]) => `${k}=${v}`).join('&');
}

function s3Url(config, key, query = {}) {
  const endpoint = new URL(String(config.endpoint || '').replace(/\/+$/, '') + '/');
  const encodedKey = encodeS3Key(key);
  const basePath = endpoint.pathname.replace(/\/+$/, '');
  const objectPath = config.pathStyle
    ? `/${encodeURIComponent(config.bucket)}/${encodedKey}`
    : `/${encodedKey}`;
  endpoint.pathname = `${basePath}${objectPath}`;
  const q = canonicalQuery(query);
  endpoint.search = q ? `?${q}` : '';
  return endpoint;
}

async function signedS3Fetch(config, method, key, opts = {}) {
  const body = bodyBuffer(opts.body);
  const payloadHash = method === 'GET' || method === 'HEAD' || method === 'DELETE' ? EMPTY_SHA256 : sha256Hex(body);
  const url = s3Url(config, key, opts.query || {});
  const { amzDate, dateStamp } = amzTimestamp(opts.date || new Date());
  const headers = {
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (opts.contentType) headers['content-type'] = opts.contentType;
  if (config.sessionToken) headers['x-amz-security-token'] = config.sessionToken;

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((k) => `${k}:${String(headers[k]).trim()}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');
  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQuery(opts.query || {}),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const region = config.region || 'us-east-1';
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(Buffer.from(canonicalRequest)),
  ].join('\n');
  const kDate = hmac('AWS4' + config.secretAccessKey, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign, 'hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return fetch(url, {
    method,
    headers,
    body: method === 'PUT' || method === 'POST' ? body : undefined,
  });
}

export async function smokeObjectStore({ env = process.env, provider = '', prefix = '_smoke' } = {}) {
  const store = resolveObjectStore({ env, provider });
  const key = `${prefix.replace(/\/+$/, '')}/kolm-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.txt`;
  const body = `kolm object storage smoke ${new Date().toISOString()}`;
  const put = await store.putObject(key, body, { contentType: 'text/plain' });
  const head = await store.headObject(key);
  const got = await store.getObject(key);
  await store.deleteObject(key);
  const roundTrip = !!got && Buffer.compare(Buffer.from(body), got.body) === 0;
  return {
    ok: !!put.ok && !!head && roundTrip,
    provider: store.provider,
    bucket: store.bucket,
    key,
    size: Buffer.byteLength(body),
    round_trip: roundTrip,
    secret_values_included: false,
  };
}

export default {
  objectStorageProviders,
  objectStorageReadiness,
  resolveObjectStore,
  smokeObjectStore,
};
