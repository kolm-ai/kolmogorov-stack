// Vercel serverless function for Cloudflare R2 admin ops.
// Runs where CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN are set.
// Admin operations are gated by ADMIN_KEY in the x-admin-key header.
//
// Routes (path determined by ?op= query):
//   GET    /api/r2?op=ping
//   POST   /api/r2?op=bootstrap
//   GET    /api/r2?op=list&bucket=X
//   POST   /api/r2?op=put&bucket=X&key=K
//   GET    /api/r2?op=get&bucket=X&key=K
//   DELETE /api/r2?op=del&bucket=X&key=K

import crypto from 'node:crypto';
import * as R2 from '../src/r2.js';

const PRIMARY_BUCKETS = ['kolm-assets', 'kolm-receipts', 'kolm-artifacts', 'kolm-reports'];
const PUBLIC_BUCKETS = new Set(['kolm-assets']);
const DEFAULT_MAX_PUT_BYTES = 25 * 1024 * 1024;

const OP_METHODS = {
  ping: new Set(['GET']),
  bootstrap: new Set(['POST']),
  list: new Set(['GET']),
  put: new Set(['POST']),
  get: new Set(['GET']),
  del: new Set(['DELETE']),
};

class HttpError extends Error {
  constructor(status, error, detail = null) {
    super(detail || error);
    this.status = status;
    this.error = error;
    this.detail = detail;
  }
}

function _header(req, name) {
  const headers = req.headers || {};
  return headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
}

function _sha256(s) {
  return crypto.createHash('sha256').update(String(s || '')).digest();
}

function _safeEqual(a, b) {
  return crypto.timingSafeEqual(_sha256(a), _sha256(b));
}

function _json(res, status, payload) {
  return res.status(status).json(payload);
}

function _maxPutBytes() {
  const n = Number(process.env.KOLM_R2_MAX_PUT_BYTES || DEFAULT_MAX_PUT_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_PUT_BYTES;
}

function _apiToken() {
  return process.env.CLOUDFLARE_API_TOKEN || process.env.Cloudflare_api_token || '';
}

function requireAdmin(req, res) {
  const expected = process.env.ADMIN_KEY || '';
  const supplied = _header(req, 'x-admin-key');
  if (!expected || !supplied || !_safeEqual(supplied, expected)) {
    _json(res, 403, { ok: false, error: expected ? 'admin_only' : 'admin_not_configured' });
    return false;
  }
  return true;
}

function _assertMethod(req, res, op) {
  const method = String(req.method || 'GET').toUpperCase();
  const allowed = OP_METHODS[op] || null;
  if (!allowed) return true;
  if (allowed.has(method)) return true;
  res.setHeader('Allow', Array.from(allowed).join(', '));
  _json(res, 405, { ok: false, error: 'method_not_allowed', op, allowed: Array.from(allowed) });
  return false;
}

function _bucket(value, fallback = R2.defaultBucket) {
  const bucket = String(value || fallback || '').trim();
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)
    || bucket.includes('..')
    || bucket.includes('-.')
    || bucket.includes('.-')
  ) {
    throw new HttpError(400, 'invalid_bucket', 'bucket must be an S3-compatible name');
  }
  return bucket;
}

function _key(value) {
  const key = String(value || '');
  const parts = key.split('/');
  if (
    !key
    || key.length > 1024
    || key.startsWith('/')
    || key.includes('\\')
    || parts.includes('..')
    || /[\x00-\x1f\x7f]/.test(key)
    || !/^[A-Za-z0-9._~!$&'()+,;=@/-]+$/.test(key)
  ) {
    throw new HttpError(400, 'invalid_key', 'key must be a relative object key without traversal');
  }
  return key;
}

function _contentType(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  const ct = String(raw || 'application/octet-stream').trim();
  if (!ct || ct.length > 128 || /[\r\n]/.test(ct)) return 'application/octet-stream';
  return ct;
}

async function _readBody(req) {
  const max = _maxPutBytes();
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
    total += b.length;
    if (total > max) {
      throw new HttpError(413, 'body_too_large', `request body exceeds ${max} bytes`);
    }
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

async function _sendObject(res, r, { publicCache = false } = {}) {
  res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
  if (publicCache) {
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  }
  const buf = Buffer.from(await r.arrayBuffer());
  return res.end(buf);
}

async function _listObjects(bucket) {
  if (!R2.accountId || !_apiToken()) {
    throw new HttpError(501, 'r2_rest_admin_unavailable', 'object listing requires Cloudflare R2 REST credentials');
  }
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${R2.accountId}/r2/buckets/${encodeURIComponent(bucket)}/objects?per_page=1000`,
    { headers: { Authorization: `Bearer ${_apiToken()}` } },
  );
  const j = await r.json().catch(() => ({}));
  return { status: r.ok ? 200 : r.status, body: { ok: !!j.success, objects: j.result || [], errors: j.errors || [] } };
}

export default async function handler(req, res) {
  try {
    if (!R2.r2Configured()) {
      return _json(res, 500, {
        ok: false,
        error: 'r2_not_configured',
        hint: 'set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN env vars',
        have_account: !!(process.env.CLOUDFLARE_ACCOUNT_ID || process.env.cloudflare_account_id),
        have_token: !!(process.env.CLOUDFLARE_API_TOKEN || process.env.Cloudflare_api_token),
      });
    }

    const op = String(req.query?.op || 'ping');
    if (!OP_METHODS[op]) {
      return _json(res, 400, { ok: false, error: 'unknown_op', op, ops: Object.keys(OP_METHODS) });
    }
    if (!_assertMethod(req, res, op)) return;

    if (op === 'ping') {
      const buckets = await R2.listBuckets();
      return res.json({
        ok: true,
        configured: true,
        account_prefix: R2.accountId ? `${R2.accountId.slice(0, 8)}...` : null,
        bucket_count: buckets.length,
      });
    }

    if (op === 'get' && PUBLIC_BUCKETS.has(String(req.query?.bucket || ''))) {
      const bucket = _bucket(req.query.bucket);
      const key = _key(req.query.key);
      const r = await R2.getObject(key, { bucket });
      if (!r) return _json(res, 404, { ok: false, error: 'not_found' });
      return _sendObject(res, r, { publicCache: true });
    }

    if (!requireAdmin(req, res)) return;

    if (op === 'bootstrap') {
      const existing = await R2.listBuckets();
      const existingNames = new Set(existing.map((b) => b.name));
      const created = [];
      for (const name of PRIMARY_BUCKETS) {
        if (existingNames.has(name)) continue;
        await R2.createBucket(name);
        created.push(name);
      }
      const key = `_smoke/${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
      const body = `kolm r2 bootstrap ${new Date().toISOString()}`;
      await R2.putObject(key, body, { bucket: 'kolm-assets', contentType: 'text/plain' });
      const r = await R2.getObject(key, { bucket: 'kolm-assets' });
      const echoed = r ? await r.text() : null;
      await R2.deleteObject(key, { bucket: 'kolm-assets' });
      return res.json({
        ok: true,
        buckets_existing: existing.map((b) => b.name),
        buckets_created: created,
        smoke: { key, round_trip: echoed === body },
      });
    }

    if (op === 'list') {
      const bucket = _bucket(req.query?.bucket);
      const out = await _listObjects(bucket);
      return _json(res, out.status, out.body);
    }

    if (op === 'put') {
      const bucket = _bucket(req.query?.bucket);
      const key = _key(req.query?.key);
      const body = await _readBody(req);
      const result = await R2.putObject(key, body, {
        bucket,
        contentType: _contentType(_header(req, 'content-type')),
      });
      return res.json({ ok: true, ...result });
    }

    if (op === 'get') {
      const bucket = _bucket(req.query?.bucket);
      const key = _key(req.query?.key);
      const r = await R2.getObject(key, { bucket });
      if (!r) return _json(res, 404, { ok: false, error: 'not_found' });
      return _sendObject(res, r);
    }

    if (op === 'del') {
      const bucket = _bucket(req.query?.bucket);
      const key = _key(req.query?.key);
      const result = await R2.deleteObject(key, { bucket });
      return res.json({ ok: true, ...result });
    }
  } catch (e) {
    if (e instanceof HttpError) {
      return _json(res, e.status, { ok: false, error: e.error, detail: e.detail });
    }
    return _json(res, 500, {
      ok: false,
      error: 'r2_api_error',
      detail: process.env.KOLM_DEBUG ? String(e.message || e) : 'operation failed',
    });
  }
}
