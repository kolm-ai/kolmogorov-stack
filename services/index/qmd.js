// qmd adapter - Recall backend powered by github.com/tobi/qmd.
//
// qmd does BM25 + vector + RRF + LLM reranking, all locally via GGUF.
// We wrap it so the kolm compile orchestrator can ground Distill calls
// in the user's own corpus without us having to implement, host, or
// pay for embedders + a vector DB. The user runs qmd locally; the cloud
// only ever sees the {recall_chunks} the user opted to send.
//
// Three surfaces:
//   add(namespace, paths)       - register a directory or files
//   embed(namespace?)           - generate embeddings (qmd embed)
//   query(namespace, q, k)      - hybrid query, returns chunks
//   status(namespace?)          - index health
//
// We shell out to the qmd CLI. If the user has the MCP HTTP transport
// running (`qmd mcp --http --daemon`) we prefer that for sub-second
// latency on warm models; otherwise stdio works fine.

import { spawn } from 'node:child_process';

export const QMD_ADAPTER_VERSION = 'w694-v1';

export const QMD_LIMITS = Object.freeze({
  CLI_TIMEOUT_MS: 120_000,
  HTTP_TIMEOUT_MS: 10_000,
  MAX_STDOUT_CHARS: 2_000_000,
  MAX_STDERR_CHARS: 8192,
  MAX_ERROR_CHARS: 2000,
  MAX_QUERY_CHARS: 8000,
  MAX_NAMESPACE_CHARS: 96,
  MAX_PATH_CHARS: 2048,
  MAX_PATHS: 64,
  MAX_K: 100,
  MAX_SNIPPET_CHARS: 4000,
  MAX_DOC_ID_CHARS: 256,
});

const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const CONTROL_TEST_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const SECRET_RE = /\b(?:ks|kao)_[A-Za-z0-9._~+/=-]{8,}\b|\bsk-[A-Za-z0-9._~+/=-]{8,}\b|\b(?:AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b|Bearer\s+[A-Za-z0-9._~+/=-]+/gi;

function cleanText(value) {
  return String(value == null ? '' : value).replace(CONTROL_RE, ' ');
}

function truncate(value, maxChars = QMD_LIMITS.MAX_ERROR_CHARS) {
  const text = cleanText(value);
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function safeError(value, maxChars = QMD_LIMITS.MAX_ERROR_CHARS) {
  return truncate(String(value == null ? '' : value).replace(SECRET_RE, '[redacted]'), maxChars);
}

function appendBounded(current, chunk, maxChars) {
  if (current.length >= maxChars) return { text: current, overflow: true };
  const next = current + Buffer.from(chunk).toString('utf8');
  if (next.length > maxChars) {
    return { text: next.slice(0, maxChars), overflow: true };
  }
  return { text: next, overflow: false };
}

function isLoopbackHost(hostname) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1' || /^127\./.test(host);
}

function normalizeBin(value) {
  const bin = String(value || 'qmd').trim();
  if (!bin || bin.length > QMD_LIMITS.MAX_PATH_CHARS || CONTROL_TEST_RE.test(bin)) {
    throw new Error('QMD_BIN contains invalid characters');
  }
  return bin;
}

export function qmdBin() {
  return normalizeBin(process.env.QMD_BIN || 'qmd');
}

export function normalizeMcpUrl(value, { allowRemote = process.env.QMD_MCP_ALLOW_REMOTE === '1' } = {}) {
  if (!value) return null;
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw new Error('QMD_MCP_URL must be a valid http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('QMD_MCP_URL must use http or https');
  }
  if (url.username || url.password) {
    throw new Error('QMD_MCP_URL must not include credentials');
  }
  if (!allowRemote && !isLoopbackHost(url.hostname)) {
    throw new Error('QMD_MCP_URL must be loopback unless QMD_MCP_ALLOW_REMOTE=1');
  }
  url.hash = '';
  url.search = '';
  url.pathname = (url.pathname || '/mcp').replace(/\/+$/, '') || '/mcp';
  return url.toString();
}

export function qmdHttp() {
  return normalizeMcpUrl(process.env.QMD_MCP_URL || null);
}

function healthUrl(mcpUrl) {
  const url = new URL(mcpUrl);
  const trimmed = url.pathname.replace(/\/+$/, '');
  url.pathname = trimmed.endsWith('/mcp') ? `${trimmed.slice(0, -4)}/health` : `${trimmed}/health`;
  return url.toString();
}

function normalizeNamespace(value, { optional = false } = {}) {
  if ((value == null || value === '') && optional) return null;
  const ns = String(value == null ? '' : value).trim();
  if (!ns) throw new Error('qmd namespace is required');
  if (ns.length > QMD_LIMITS.MAX_NAMESPACE_CHARS || !/^[A-Za-z0-9_.:-]+$/.test(ns)) {
    throw new Error('qmd namespace contains invalid characters');
  }
  return ns;
}

function normalizePathArg(value) {
  const p = String(value == null ? '' : value).trim();
  if (!p || p.length > QMD_LIMITS.MAX_PATH_CHARS || CONTROL_TEST_RE.test(p)) {
    throw new Error('qmd path contains invalid characters');
  }
  return p;
}

function normalizePaths(paths) {
  const list = [].concat(paths || []);
  if (list.length === 0) throw new Error('qmd paths must be a non-empty array');
  if (list.length > QMD_LIMITS.MAX_PATHS) throw new Error(`qmd paths exceed max ${QMD_LIMITS.MAX_PATHS}`);
  return [...new Set(list.map(normalizePathArg))];
}

function normalizeQuery(value) {
  const q = String(value == null ? '' : value);
  if (!q.trim()) throw new Error('qmd query is required');
  if (q.length > QMD_LIMITS.MAX_QUERY_CHARS || CONTROL_TEST_RE.test(q)) {
    throw new Error('qmd query contains invalid characters');
  }
  return q;
}

function normalizeK(value) {
  const n = Number(value == null ? 12 : value);
  if (!Number.isFinite(n) || n < 1) return 12;
  return Math.min(QMD_LIMITS.MAX_K, Math.floor(n));
}

function normalizeCliArg(value) {
  const arg = String(value == null ? '' : value);
  if (arg.length > QMD_LIMITS.MAX_PATH_CHARS || CONTROL_TEST_RE.test(arg)) {
    throw new Error('qmd cli argument contains invalid characters');
  }
  return arg;
}

function commandLabel(args) {
  const head = Array.isArray(args) && args.length ? String(args[0]) : 'command';
  return `qmd ${head}`;
}

function run(args, { input, timeoutMs = QMD_LIMITS.CLI_TIMEOUT_MS } = {}) {
  const checkedArgs = args.map(normalizeCliArg);
  return new Promise((resolve, reject) => {
    let settled = false;
    let killed = false;
    let out = '';
    let err = '';
    let outOverflow = false;
    let errOverflow = false;
    let proc;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      killed = true;
      try { proc?.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    try {
      proc = spawn(qmdBin(), checkedArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      finish(reject, new Error(`qmd spawn failed: ${safeError(e && e.message || e)}`));
      return;
    }
    proc.stdout.on('data', (d) => {
      const next = appendBounded(out, d, QMD_LIMITS.MAX_STDOUT_CHARS);
      out = next.text;
      outOverflow = outOverflow || next.overflow;
    });
    proc.stderr.on('data', (d) => {
      const next = appendBounded(err, d, QMD_LIMITS.MAX_STDERR_CHARS);
      err = next.text;
      errOverflow = errOverflow || next.overflow;
    });
    proc.on('error', (e) => finish(reject, new Error(`qmd spawn failed: ${safeError(e && e.message || e)}`)));
    proc.on('close', (code) => {
      if (killed) return finish(reject, new Error(`qmd ${checkedArgs[0] || 'command'} timeout after ${timeoutMs}ms`));
      if (outOverflow) return finish(reject, new Error(`${commandLabel(checkedArgs)} stdout exceeded ${QMD_LIMITS.MAX_STDOUT_CHARS} chars`));
      if (code !== 0) {
        const suffix = errOverflow ? '...' : '';
        return finish(reject, new Error(`${commandLabel(checkedArgs)} exited ${code}: ${safeError(err)}${suffix}`));
      }
      finish(resolve, out);
    });
    proc.stdin.on('error', (e) => finish(reject, new Error(`qmd stdin failed: ${safeError(e && e.message || e)}`)));
    if (input != null) proc.stdin.write(String(input));
    proc.stdin.end();
  });
}

async function fetchWithTimeout(url, opts, timeoutMs = QMD_LIMITS.HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...(opts || {}), signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonResponse(res) {
  const text = await res.text();
  if (text.length > QMD_LIMITS.MAX_STDOUT_CHARS) throw new Error('qmd mcp response too large');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error('qmd mcp returned invalid json');
  }
}

// HTTP MCP transport (preferred when the user runs `qmd mcp --http --daemon`).
async function mcpCall(method, params) {
  const url = qmdHttp();
  if (!url) return null;
  const r = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: method, arguments: params },
    }),
  });
  if (!r.ok) throw new Error(`qmd mcp http: ${r.status}`);
  const j = await readJsonResponse(r);
  if (j.error) throw new Error(`qmd mcp: ${safeError(j.error.message || j.error.code || 'error')}`);
  return j.result;
}

export async function isAvailable() {
  try {
    const http = qmdHttp();
    if (http) {
      const r = await fetchWithTimeout(healthUrl(http), { method: 'GET' });
      if (r.ok) return { available: true, transport: 'http', version: QMD_ADAPTER_VERSION };
    }
    await run(['--version']);
    return { available: true, transport: 'cli', version: QMD_ADAPTER_VERSION };
  } catch (e) {
    return { available: false, reason: safeError(e && e.message || e), version: QMD_ADAPTER_VERSION };
  }
}

// Add a directory or set of files to a named collection.
export async function addCollection({ name, paths }) {
  const collection = normalizeNamespace(name);
  const checkedPaths = normalizePaths(paths);
  for (const p of checkedPaths) {
    await run(['collection', 'add', p, '--name', collection]);
  }
  return { ok: true, added_paths: checkedPaths.length, collection, version: QMD_ADAPTER_VERSION };
}

// Generate embeddings for a collection (or all). Long-running; the caller
// should await and surface a "generating embeddings" UI state.
export async function embed({ name } = {}) {
  const args = ['embed'];
  const collection = normalizeNamespace(name, { optional: true });
  if (collection) args.push('-c', collection);
  await run(args);
  return { ok: true, collection, version: QMD_ADAPTER_VERSION };
}

// Hybrid query - returns the top-k chunks. Each chunk is the qmd-emitted
// JSON record: { docid, path, score, snippet, ... }.
export async function query({ namespace, query: q, k = 12 }) {
  const checkedQuery = normalizeQuery(q);
  const checkedK = normalizeK(k);
  const collection = normalizeNamespace(namespace, { optional: true });
  const http = qmdHttp();
  if (http) {
    try {
      const r = await mcpCall('query', { query: checkedQuery, collection, n: checkedK });
      if (Array.isArray(r?.content)) {
        return r.content.map(c => parseChunk(c)).filter(Boolean).slice(0, checkedK);
      }
    } catch {
      // Fall through to CLI. Direct callers that require HTTP-only behavior
      // should call mcpCall through their own policy gate.
    }
  }
  const args = ['query', checkedQuery, '--json', '-n', String(checkedK)];
  if (collection) args.push('-c', collection);
  const out = await run(args);
  let parsed;
  try { parsed = JSON.parse(out); } catch { parsed = []; }
  if (!Array.isArray(parsed)) parsed = parsed?.results || [];
  return parsed.slice(0, checkedK).map(normalizeChunk);
}

function parseChunk(c) {
  if (typeof c === 'string') return normalizeChunk({ snippet: c });
  return normalizeChunk(c);
}

function finiteScore(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function boundedField(value, maxChars) {
  const text = cleanText(value);
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function normalizeChunk(c) {
  const row = c && typeof c === 'object' ? c : {};
  return {
    docid: row.docid || row.id ? boundedField(row.docid || row.id, QMD_LIMITS.MAX_DOC_ID_CHARS) : null,
    path: row.path ? boundedField(row.path, QMD_LIMITS.MAX_PATH_CHARS) : null,
    score: finiteScore(row.score),
    snippet: boundedField(row.snippet || row.excerpt || row.text || '', QMD_LIMITS.MAX_SNIPPET_CHARS),
    collection: row.collection ? boundedField(row.collection, QMD_LIMITS.MAX_NAMESPACE_CHARS) : null,
  };
}

export async function status({ name } = {}) {
  const args = ['status'];
  const collection = normalizeNamespace(name, { optional: true });
  if (collection) args.push('-c', collection);
  try {
    const out = await run([...args, '--json']);
    const parsed = JSON.parse(out);
    return parsed && typeof parsed === 'object'
      ? { ...parsed, version: QMD_ADAPTER_VERSION }
      : { ok: false, error: 'qmd status returned invalid shape', version: QMD_ADAPTER_VERSION };
  } catch (e) {
    return { ok: false, error: safeError(e && e.message || e), version: QMD_ADAPTER_VERSION };
  }
}
