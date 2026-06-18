import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIM = 256;
const PROVIDER_VERSION = 'w954-embedding-provider-v1';
const HASH_BACKENDS = new Set(['hash', 'hashbag', 'hash-bag', 'hashed-ngram', 'hashed_ngram', 'local', 'js']);
const PY_ST_BACKENDS = new Set(['st', 'sentence-transformers', 'sentence_transformers', 'python-st', 'python_sentence_transformers']);
const PY_HASH_BACKENDS = new Set(['python-hashbag', 'python_hashbag']);
const HTTP_BACKENDS = new Set(['http', 'local-http', 'openai-compatible', 'openai_compatible']);
const REGISTERED_PROVIDERS = new Map();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function ngrams(text, n) {
  const t = ' ' + text.toLowerCase().replace(/\s+/g, ' ').trim() + ' ';
  const out = [];
  for (let i = 0; i + n <= t.length; i++) out.push(t.slice(i, i + n));
  return out;
}

function tokens(text) {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function hashIndex(token, salt = '') {
  const h = crypto.createHash('sha1').update(salt + token).digest();
  return ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
}

function sign(token) {
  const h = crypto.createHash('sha1').update('sign:' + token).digest();
  return (h[0] & 1) ? 1 : -1;
}

function l2Normalize(v) {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

function normalizeVector(v) {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) {
    const n = Number(v[i]);
    out[i] = Number.isFinite(n) ? n : 0;
  }
  return l2Normalize(out);
}

function normalizeBackendName(value) {
  const raw = String(value || '').trim().toLowerCase();
  return raw || 'hashbag';
}

function selectBackend(opts = {}) {
  return normalizeBackendName(
    opts.backend
    || opts.embeddingBackend
    || opts.providerId
    || process.env.KOLM_EMBED_BACKEND
    || 'hashbag',
  );
}

function isHashBackend(name) {
  return HASH_BACKENDS.has(normalizeBackendName(name));
}

function vectorBatch(vectors, expected) {
  if (!Array.isArray(vectors) || vectors.length !== expected) {
    throw new Error('embedding_vector_count_mismatch');
  }
  const out = new Array(expected);
  let dim = 0;
  for (let i = 0; i < vectors.length; i++) {
    const v = normalizeVector(vectors[i]);
    if (!v) throw new Error('embedding_vector_invalid');
    if (dim === 0) dim = v.length;
    if (v.length !== dim) throw new Error('embedding_vector_dim_mismatch');
    out[i] = v;
  }
  return { vectors: out, dim };
}

function hashBatch(texts, fallbackFrom = null) {
  const rows = Array.isArray(texts) ? texts : [];
  const vectors = rows.map((t) => embed(t));
  return {
    ok: true,
    version: PROVIDER_VERSION,
    backend_requested: fallbackFrom || 'hashbag',
    backend_used: 'hashbag',
    backend_kind: 'lexical_hash',
    learned_semantic: false,
    configured: true,
    fallback: fallbackFrom ? 'hashbag' : null,
    dim: DIM,
    n_texts: rows.length,
    vectors,
  };
}

function safeError(e) {
  const s = String((e && e.message) || e || 'error');
  return s
    .replace(/sk-[A-Za-z0-9_\-]{12,}/g, 'sk-REDACTED')
    .replace(/Bearer\s+[A-Za-z0-9_\-.=]+/gi, 'Bearer REDACTED')
    .slice(0, 240);
}

function providerKind(backend, used, meta = {}) {
  if (meta && meta.learned_semantic === true) return 'learned_semantic';
  const s = normalizeBackendName(used || backend);
  if (PY_ST_BACKENDS.has(s) || s === 'st' || s.includes('sentence') || s.includes('openai') || s.includes('voyage')) {
    return 'learned_semantic';
  }
  if (isHashBackend(s)) return 'lexical_hash';
  if (s === 'hashbag') return 'lexical_hash';
  return meta.kind || 'provider';
}

function profileFor(backend, opts = {}) {
  const selected = normalizeBackendName(backend || selectBackend(opts));
  if (typeof opts.provider === 'function') {
    return {
      version: PROVIDER_VERSION,
      backend_requested: selected,
      provider: 'injected',
      configured: true,
      backend_kind: opts.learned_semantic === true ? 'learned_semantic' : 'provider',
      learned_semantic: opts.learned_semantic === true,
      default_safe: false,
    };
  }
  if (REGISTERED_PROVIDERS.has(selected)) {
    const row = REGISTERED_PROVIDERS.get(selected);
    const kind = providerKind(selected, selected, row.meta);
    return {
      version: PROVIDER_VERSION,
      backend_requested: selected,
      provider: row.id,
      configured: true,
      backend_kind: kind,
      learned_semantic: kind === 'learned_semantic',
      default_safe: false,
    };
  }
  if (isHashBackend(selected)) {
    return {
      version: PROVIDER_VERSION,
      backend_requested: selected,
      provider: 'builtin-hashbag',
      configured: true,
      backend_kind: 'lexical_hash',
      learned_semantic: false,
      default_safe: true,
    };
  }
  if (PY_ST_BACKENDS.has(selected) || PY_HASH_BACKENDS.has(selected)) {
    return {
      version: PROVIDER_VERSION,
      backend_requested: selected,
      provider: 'python-worker',
      configured: true,
      backend_kind: PY_ST_BACKENDS.has(selected) ? 'learned_semantic' : 'lexical_hash',
      learned_semantic: PY_ST_BACKENDS.has(selected),
      default_safe: false,
      worker: 'workers/data/scripts/_embed.py',
    };
  }
  if (HTTP_BACKENDS.has(selected)) {
    const url = opts.url || process.env.KOLM_EMBED_URL || '';
    return {
      version: PROVIDER_VERSION,
      backend_requested: selected,
      provider: 'openai-compatible-http',
      configured: Boolean(url),
      backend_kind: 'learned_semantic',
      learned_semantic: true,
      default_safe: false,
      url_configured: Boolean(url),
      remote_allowed: remoteAllowed(url, opts),
    };
  }
  return {
    version: PROVIDER_VERSION,
    backend_requested: selected,
    provider: 'unknown',
    configured: false,
    backend_kind: 'unknown',
    learned_semantic: false,
    default_safe: false,
  };
}

function resultFromProvider(texts, backend, payload, meta = {}) {
  const rawVectors = Array.isArray(payload) ? payload : payload && payload.vectors;
  const { vectors, dim } = vectorBatch(rawVectors, texts.length);
  const used = normalizeBackendName((payload && payload.backend_used) || meta.backend_used || backend);
  const kind = providerKind(backend, used, meta);
  return {
    ok: true,
    version: PROVIDER_VERSION,
    backend_requested: backend,
    backend_used: used,
    backend_kind: kind,
    learned_semantic: kind === 'learned_semantic',
    configured: true,
    fallback: null,
    dim,
    n_texts: texts.length,
    vectors,
  };
}

function coerceTexts(texts) {
  if (!Array.isArray(texts)) return [];
  return texts.map((t) => (typeof t === 'string' ? t : String(t ?? '')));
}

function workerBackend(backend) {
  if (PY_HASH_BACKENDS.has(backend)) return 'hashbag';
  return 'st';
}

function embedViaPython(texts, backend, opts = {}) {
  const script = opts.workerPath || path.resolve(__dirname, '..', 'workers', 'data', 'scripts', '_embed.py');
  if (!fs.existsSync(script)) throw new Error('python_embedding_worker_missing');
  const py = opts.python || process.env.KOLM_PYTHON || 'python';
  let tmpDir = null;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-embed-'));
    const inPath = path.join(tmpDir, 'texts.jsonl');
    fs.writeFileSync(inPath, texts.map((text) => JSON.stringify({ text })).join('\n') + '\n', 'utf8');
    const args = [script, '--texts', inPath, '--backend', workerBackend(backend)];
    const res = spawnSync(py, args, {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: Number.isFinite(Number(opts.timeoutMs)) ? Number(opts.timeoutMs) : 10 * 60 * 1000,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(py),
      env: Object.assign({}, process.env, {
        TOKENIZERS_PARALLELISM: process.env.TOKENIZERS_PARALLELISM || 'false',
      }),
    });
    if (res.error || res.status !== 0) {
      throw new Error(res.error ? res.error.message : 'python_embedding_worker_exit_' + res.status);
    }
    const lines = String(res.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    let parsed = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      try { parsed = JSON.parse(lines[i]); break; }
      catch (_) { /* scan older lines */ }
    }
    if (!parsed || parsed.ok !== true || !Array.isArray(parsed.vectors)) {
      throw new Error((parsed && parsed.error) || 'python_embedding_worker_no_vectors');
    }
    return resultFromProvider(texts, backend, parsed, {
      backend_used: parsed.backend_used,
      learned_semantic: parsed.backend_used === 'st',
    });
  } finally {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); }
      catch (_) { /* best-effort cleanup */ }
    }
  }
}

function isLoopbackUrl(raw) {
  try {
    const u = new URL(raw);
    const h = u.hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.startsWith('127.');
  } catch {
    return false;
  }
}

function remoteAllowed(raw, opts = {}) {
  if (!raw) return false;
  if (opts.allowRemote === true || process.env.KOLM_EMBED_ALLOW_REMOTE === '1') return true;
  return isLoopbackUrl(raw);
}

async function embedViaHttp(texts, backend, opts = {}) {
  const endpoint = opts.url || process.env.KOLM_EMBED_URL || '';
  if (!endpoint) throw new Error('embedding_url_missing');
  if (!remoteAllowed(endpoint, opts)) throw new Error('remote_embedding_url_refused');
  if (typeof fetch !== 'function') throw new Error('fetch_unavailable');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number.isFinite(Number(opts.timeoutMs)) ? Number(opts.timeoutMs) : 60_000);
  try {
    const headers = { 'content-type': 'application/json' };
    const key = opts.apiKey || process.env.KOLM_EMBED_API_KEY || '';
    if (key) headers.authorization = 'Bearer ' + key;
    const body = {
      model: opts.model || process.env.KOLM_EMBED_MODEL || 'text-embedding-3-small',
      input: texts,
    };
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error('embedding_http_' + res.status);
    const json = await res.json();
    let vectors = null;
    if (Array.isArray(json.vectors)) vectors = json.vectors;
    else if (Array.isArray(json.data)) vectors = json.data.map((row) => row && row.embedding);
    if (!vectors) throw new Error('embedding_http_no_vectors');
    return resultFromProvider(texts, backend, { vectors, backend_used: json.backend_used || backend }, { learned_semantic: true });
  } finally {
    clearTimeout(timeout);
  }
}

export function embed(text) {
  const v = new Array(DIM).fill(0);
  const toks = tokens(text);
  for (const t of toks) {
    const idx = hashIndex(t, 'unigram') % DIM;
    v[idx] += sign(t);
  }
  for (const g of ngrams(text, 3)) {
    const idx = hashIndex(g, 'tri') % DIM;
    v[idx] += sign(g) * 0.5;
  }
  for (const g of ngrams(text, 4)) {
    const idx = hashIndex(g, 'quad') % DIM;
    v[idx] += sign(g) * 0.3;
  }
  return l2Normalize(v);
}

export async function embedAsync(text, opts = {}) {
  const res = await embedBatchAsync([text], opts);
  return res.vectors[0];
}

export async function embedBatchAsync(texts, opts = {}) {
  const rows = coerceTexts(texts);
  const backend = selectBackend(opts);
  if (rows.length === 0) {
    return {
      ok: true,
      version: PROVIDER_VERSION,
      backend_requested: backend,
      backend_used: isHashBackend(backend) ? 'hashbag' : backend,
      backend_kind: isHashBackend(backend) ? 'lexical_hash' : profileFor(backend, opts).backend_kind,
      learned_semantic: false,
      configured: true,
      fallback: null,
      dim: DIM,
      n_texts: 0,
      vectors: [],
    };
  }
  if (isHashBackend(backend)) return hashBatch(rows);

  try {
    if (typeof opts.provider === 'function') {
      const payload = await opts.provider(rows, { backend, version: PROVIDER_VERSION });
      return resultFromProvider(rows, backend, payload, { learned_semantic: opts.learned_semantic === true, backend_used: backend });
    }
    if (REGISTERED_PROVIDERS.has(backend)) {
      const row = REGISTERED_PROVIDERS.get(backend);
      const payload = await row.provider(rows, { backend, version: PROVIDER_VERSION });
      return resultFromProvider(rows, backend, payload, row.meta || {});
    }
    if (PY_ST_BACKENDS.has(backend) || PY_HASH_BACKENDS.has(backend)) {
      return embedViaPython(rows, backend, opts);
    }
    if (HTTP_BACKENDS.has(backend)) {
      return await embedViaHttp(rows, backend, opts);
    }
    throw new Error('embedding_backend_unknown');
  } catch (e) {
    if (opts.strict === true) {
      return {
        ok: false,
        version: PROVIDER_VERSION,
        backend_requested: backend,
        backend_used: 'none',
        backend_kind: 'error',
        learned_semantic: false,
        configured: false,
        fallback: null,
        dim: 0,
        n_texts: rows.length,
        vectors: [],
        error: safeError(e),
      };
    }
    const out = hashBatch(rows, backend);
    out.error = safeError(e);
    out.configured = profileFor(backend, opts).configured;
    return out;
  }
}

export function registerEmbeddingProvider(id, provider, meta = {}) {
  const key = normalizeBackendName(id);
  if (!key || isHashBackend(key)) throw new Error('invalid_embedding_provider_id');
  if (typeof provider !== 'function') throw new Error('embedding_provider_must_be_function');
  REGISTERED_PROVIDERS.set(key, { id: String(id), provider, meta: { ...(meta || {}) } });
  return key;
}

export function unregisterEmbeddingProvider(id) {
  return REGISTERED_PROVIDERS.delete(normalizeBackendName(id));
}

export function clearEmbeddingProviders() {
  REGISTERED_PROVIDERS.clear();
}

export function listEmbeddingProviders() {
  return Array.from(REGISTERED_PROVIDERS.values()).map((row) => ({
    id: row.id,
    learned_semantic: row.meta && row.meta.learned_semantic === true,
    kind: providerKind(row.id, row.id, row.meta),
  })).sort((a, b) => a.id.localeCompare(b.id));
}

export function embeddingProviderProfile(opts = {}) {
  return profileFor(null, opts);
}

export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function topK(query, items, k = 10, getVec = it => it.vector) {
  const scored = items.map(it => ({ item: it, score: cosine(query, getVec(it)) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

export const DIMENSIONS = DIM;
export const EMBEDDING_PROVIDER_VERSION = PROVIDER_VERSION;
