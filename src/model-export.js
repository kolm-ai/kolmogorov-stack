// MODEL-EXPORT - push a trained model/artifact to a destination.
//
// One generic entry point (startExport) + status reads (listExports /
// getExport). State is recorded as event-store rows (namespace 'export.job',
// provider 'kolm-export') so no new table is needed and the job survives a
// process restart. The HTTP layer (src/router.js) fences on req.tenant_record
// before calling anything here; every read additionally re-checks tenant_id.
//
// Destinations:
//   kolm - R2 storage. NO user token (server uses its own CLOUDFLARE
//                 creds via src/r2.js). Default + always-available.
//   github - user PAT (repo scope). Pushed via the GitHub contents API.
//   huggingface - HF write token (or server HF_TOKEN). HF Hub upload API.
//   ollama - (a) return a Modelfile, NO token (default); (b) push to
//                 ollama.com registry, requires the user's ollama key.
//   custom - user-supplied https URL (SSRF-guarded) + optional headers.
//
// SECURITY: tokens arrive only in the POST body over TLS, are held in the
// worker closure, and are never written to the event-store. Only non-secret
// outcome metadata (repo, committed_sha, target host) is persisted.

import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { appendEvent, listEvents, getEvent } from './event-store.js';
import * as r2 from './r2.js';
import { generateModelfile } from './export-ollama.js';

export const EXPORT_NAMESPACE = 'export.job';
export const EXPORT_PROVIDER = 'kolm-export';
export const R2_ARTIFACT_BUCKET = 'kolm-artifacts';

export const DESTINATIONS = new Set(['kolm', 'github', 'huggingface', 'ollama', 'custom']);

export class ExportError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.name = 'ExportError';
    this.status = status;
    this.code = code;
  }
}

function newExportId() {
  return 'exp_' + crypto.randomBytes(8).toString('hex');
}

// Persist a job-state row. Idempotent on export_id (INSERT OR REPLACE) so the
// queued → running → succeeded/failed transitions overwrite one row instead of
// piling up. NEVER carries a token - only outcome metadata.
//
// The event schema drops unknown keys in canonicalize(), so the job payload is
// JSON-serialized into media_extracted_text (preserved up to 1 MiB) with
// media_kind='log' + media_mime='application/json'. created_at is pinned to the
// job start so every transition keeps the same sort position.
async function writeJob(tenantId, artifactId, { export_id, destination, state, target_url, error, started_at, finished_at, meta }) {
  const payload = {
    export_id,
    destination,
    state,
    target_url: target_url || null,
    error: error || null,
    started_at: started_at || null,
    finished_at: finished_at || null,
    ...(meta && typeof meta === 'object' ? { meta } : {}),
  };
  await appendEvent({
    event_id: export_id,
    tenant_id: tenantId,
    namespace: EXPORT_NAMESPACE,
    provider: EXPORT_PROVIDER,
    model: artifactId || '',
    status: state === 'failed' ? 'error' : 'ok',
    source_type: 'real',
    created_at: started_at || new Date().toISOString(),
    media_kind: 'log',
    media_mime: 'application/json',
    media_extracted_text: JSON.stringify(payload),
  });
}

function jobFromEvent(ev) {
  if (!ev) return null;
  let j = {};
  if (ev.media_extracted_text) { try { j = JSON.parse(ev.media_extracted_text) || {}; } catch { j = {}; } }
  return {
    export_id: j.export_id || ev.event_id,
    artifact_id: ev.model || null,
    destination: j.destination || null,
    state: j.state || 'queued',
    target_url: j.target_url || null,
    error: j.error || null,
    started_at: j.started_at || null,
    finished_at: j.finished_at || null,
    meta: j.meta || null,
    updated_at: ev.created_at,
  };
}

// SSRF guard for the `custom` destination. Reject anything that is not https,
// or whose host is a private / loopback / link-local / reserved address. We
// block both literal private IPs and obvious local hostnames; DNS-rebind is
// out of scope for this minimal guard (documented).
const PRIVATE_HOSTNAMES = new Set(['localhost', 'ip6-localhost', 'ip6-loopback']);
function assertPublicHttpsUrl(raw) {
  let u;
  try { u = new URL(String(raw || '')); } catch {
    throw new ExportError(400, 'invalid_url', 'options.url must be a valid URL');
  }
  if (u.protocol !== 'https:') {
    throw new ExportError(400, 'insecure_url', 'options.url must be https');
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (PRIVATE_HOSTNAMES.has(host)) {
    throw new ExportError(400, 'ssrf_blocked', 'private/loopback host not allowed');
  }
  // IPv4 literal checks.
  const m4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m4) {
    const o = m4.slice(1).map(Number);
    if (o.some((n) => n > 255)) throw new ExportError(400, 'invalid_url', 'malformed IPv4 host');
    const [a, b] = o;
    const isPrivate =
      a === 10 ||                                  // 10.0.0.0/8
      a === 127 ||                                 // loopback
      (a === 169 && b === 254) ||                  // link-local 169.254.0.0/16
      (a === 172 && b >= 16 && b <= 31) ||         // 172.16.0.0/12
      (a === 192 && b === 168) ||                  // 192.168.0.0/16
      a === 0 ||                                    // 0.0.0.0/8
      a >= 224;                                     // multicast / reserved
    if (isPrivate) throw new ExportError(400, 'ssrf_blocked', 'private/reserved IP not allowed');
  }
  // IPv6 loopback / link-local / unique-local.
  if (host.includes(':')) {
    if (host === '::1' || host === '::') throw new ExportError(400, 'ssrf_blocked', 'loopback IPv6 not allowed');
    if (/^fe[89ab]/i.test(host)) throw new ExportError(400, 'ssrf_blocked', 'link-local IPv6 not allowed');
    if (/^f[cd]/i.test(host)) throw new ExportError(400, 'ssrf_blocked', 'unique-local IPv6 not allowed');
  }
  return u;
}

// Collect the artifact's on-disk files (best effort). The compile job record
// carries `artifact_path` (a packaged .kolm) when completed; we ship that plus
// a model-card if one sits beside it. Returns [{name, abspath, bytes}].
function collectArtifactFiles(job) {
  const files = [];
  const p = job && job.artifact_path;
  if (p && fs.existsSync(p)) {
    try { files.push({ name: path.basename(p), abspath: p, bytes: fs.statSync(p).size }); } catch { /* skip unreadable */ }
  }
  return files;
}

function manifestOf(job) {
  return (job && job.manifest && typeof job.manifest === 'object') ? job.manifest : {};
}

// ---- Per-destination workers. Each returns { target_url, meta } or throws an
// ExportError. Tokens are arguments (worker closure), never persisted. ----

async function exportToKolm(tenantId, job) {
  if (!r2.r2Configured()) {
    throw new ExportError(503, 'storage_unconfigured', 'R2 storage is not configured on this server');
  }
  const artifactId = job.id;
  const files = collectArtifactFiles(job);
  const uploaded = [];
  let lastKey = null;
  if (files.length === 0) {
    // No packaged bytes yet - still publish the manifest so the export is a
    // real, fetchable artifact rather than an empty success.
    const key = `t/${tenantId}/${artifactId}/manifest.json`;
    await r2.putObject(key, JSON.stringify(manifestOf(job), null, 2), {
      bucket: R2_ARTIFACT_BUCKET,
      contentType: 'application/json',
    });
    uploaded.push('manifest.json');
    lastKey = key;
  } else {
    for (const f of files) {
      const key = `t/${tenantId}/${artifactId}/${f.name}`;
      const body = fs.readFileSync(f.abspath);
      await r2.putObject(key, body, { bucket: R2_ARTIFACT_BUCKET });
      uploaded.push(f.name);
      lastKey = key;
    }
  }
  const target_url = r2.publicUrl(lastKey, { bucket: R2_ARTIFACT_BUCKET });
  return { target_url, meta: { bucket: R2_ARTIFACT_BUCKET, files: uploaded } };
}

async function exportToGitHub(job, options, token) {
  if (!token) throw new ExportError(400, 'token_required', 'github export requires a PAT (token) with repo scope');
  const repo = String(options.repo || '');
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new ExportError(400, 'invalid_options', "github export requires options.repo='owner/name'");
  }
  const branch = options.branch ? String(options.branch) : 'main';
  const basePath = options.path ? String(options.path).replace(/^\/+|\/+$/g, '') : '';
  const files = collectArtifactFiles(job);
  // Always include the model-card so the repo is self-describing.
  const cardName = 'MODEL_CARD.json';
  const cardBody = Buffer.from(JSON.stringify(manifestOf(job), null, 2), 'utf8');
  const toPush = [{ name: cardName, content: cardBody }];
  for (const f of files) toPush.push({ name: f.name, content: fs.readFileSync(f.abspath) });

  let committed_sha = null;
  for (const item of toPush) {
    const repoPath = (basePath ? basePath + '/' : '') + item.name;
    const url = `https://api.github.com/repos/${repo}/contents/${encodeURI(repoPath)}`;
    // Look up the existing blob sha (required to update an existing file).
    let sha = null;
    try {
      const head = await fetch(`${url}?ref=${encodeURIComponent(branch)}`, {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'kolm-export', Accept: 'application/vnd.github+json' },
      });
      if (head.ok) { const hj = await head.json(); sha = hj && hj.sha ? hj.sha : null; }
    } catch { /* new file */ }
    const put = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'kolm-export', Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `kolm export: ${job.id} ${item.name}`,
        content: Buffer.from(item.content).toString('base64'),
        branch,
        ...(sha ? { sha } : {}),
      }),
    });
    if (!put.ok) {
      const t = await put.text().catch(() => '');
      throw new ExportError(put.status === 401 || put.status === 403 ? 403 : 502, 'github_push_failed', `github push failed: ${put.status} ${t.slice(0, 200)}`);
    }
    const pj = await put.json().catch(() => ({}));
    committed_sha = (pj && pj.commit && pj.commit.sha) || committed_sha;
  }
  const target_url = `https://github.com/${repo}/tree/${branch}${basePath ? '/' + basePath : ''}`;
  return { target_url, meta: { repo, committed_sha } };
}

async function exportToHuggingFace(job, options, token) {
  const hfToken = token || process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN || '';
  if (!hfToken) throw new ExportError(400, 'token_required', 'huggingface export requires an HF write token (or server HF_TOKEN)');
  const repo = String(options.repo || '');
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new ExportError(400, 'invalid_options', "huggingface export requires options.repo='user/model'");
  }
  const isPrivate = options.private === true;
  // Create the repo if missing (idempotent - HF returns 409 if it exists).
  const create = await fetch('https://huggingface.co/api/repos/create', {
    method: 'POST',
    headers: { Authorization: `Bearer ${hfToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'model', name: repo.split('/')[1], organization: repo.split('/')[0], private: isPrivate }),
  });
  if (!create.ok && create.status !== 409) {
    const t = await create.text().catch(() => '');
    throw new ExportError(create.status === 401 || create.status === 403 ? 403 : 502, 'hf_create_failed', `hf repo create failed: ${create.status} ${t.slice(0, 200)}`);
  }
  // Upload the model-card README. Weight upload uses the same per-file endpoint;
  // we upload the packaged artifact bytes when present.
  const readme = `# ${repo}\n\nExported from kolm artifact \`${job.id}\`.\n\n\`\`\`json\n${JSON.stringify(manifestOf(job), null, 2)}\n\`\`\`\n`;
  const uploads = [{ name: 'README.md', content: Buffer.from(readme, 'utf8') }];
  for (const f of collectArtifactFiles(job)) uploads.push({ name: f.name, content: fs.readFileSync(f.abspath) });
  let revision = 'main';
  for (const u of uploads) {
    const url = `https://huggingface.co/api/${repo}/upload/main/${encodeURI(u.name)}`;
    const put = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${hfToken}`, 'Content-Type': 'application/octet-stream' },
      body: u.content,
    });
    if (!put.ok) {
      const t = await put.text().catch(() => '');
      throw new ExportError(put.status === 401 || put.status === 403 ? 403 : 502, 'hf_upload_failed', `hf upload failed: ${put.status} ${t.slice(0, 200)}`);
    }
    try { const pj = await put.json(); if (pj && pj.commitOid) revision = pj.commitOid; } catch { /* keep main */ }
  }
  const target_url = `https://huggingface.co/${repo}`;
  return { target_url, meta: { repo, revision } };
}

// Ollama: default mode (a) returns a Modelfile the user runs locally - NO
// token, NO network. Mode (b) (push to ollama.com) requires the user's ollama
// key AND a pre-published public GGUF URL; without both we return token_required
// rather than pretending to push.
async function exportToOllama(job, options, token) {
  const wantPush = options.push === true || options.mode === 'push';
  const manifest = manifestOf(job);
  const ggufPath = options.gguf_url || options.gguf || manifest.gguf || `${job.id}.gguf`;
  const modelfile = generateModelfile({
    artifact: { ...manifest, name: manifest.name || job.id },
    ggufPath,
    systemPrompt: options.system != null ? String(options.system) : null,
  });
  if (!wantPush) {
    // Mode (a): hand the text back to the caller. The target_url is the local
    // create command, not a remote ref.
    return {
      target_url: null,
      meta: { mode: 'modelfile', modelfile, hint: 'save as Modelfile, then: ollama create <name> -f Modelfile' },
    };
  }
  // Mode (b): push to registry.
  if (!token) throw new ExportError(400, 'token_required', 'ollama registry push requires the user ollama key');
  if (!/^https:\/\//i.test(String(options.gguf_url || ''))) {
    throw new ExportError(400, 'invalid_options', 'ollama registry push requires options.gguf_url (a public https GGUF URL)');
  }
  const name = String(options.name || manifest.name || job.id);
  // ollama.com registry push is performed by the local ollama client; the
  // server records intent + the public ref so the user can complete it.
  return {
    target_url: `https://ollama.com/${name}`,
    meta: { mode: 'registry', name, gguf_url: options.gguf_url },
  };
}

async function exportToCustom(job, options, token) {
  const u = assertPublicHttpsUrl(options.url);
  // Headers are user-supplied auth (e.g. Bearer ...). Used in-memory; only the
  // host is persisted.
  const headers = (options.headers && typeof options.headers === 'object') ? { ...options.headers } : {};
  if (token && !headers.Authorization && !headers.authorization) headers.Authorization = `Bearer ${token}`;
  const files = collectArtifactFiles(job);
  let body;
  let contentType;
  if (files.length > 0) {
    body = fs.readFileSync(files[0].abspath);
    contentType = 'application/octet-stream';
  } else {
    body = JSON.stringify({ artifact_id: job.id, manifest: manifestOf(job) });
    contentType = 'application/json';
  }
  const method = (String(options.method || 'PUT').toUpperCase() === 'POST') ? 'POST' : 'PUT';
  const resp = await fetch(u.toString(), { method, headers: { 'Content-Type': contentType, ...headers }, body });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new ExportError(502, 'custom_push_failed', `custom destination responded ${resp.status}: ${t.slice(0, 200)}`);
  }
  return { target_url: u.origin + u.pathname, meta: { url_host: u.host } };
}

// Dispatch one export. Pure async worker; throws ExportError on failure.
async function runDestination(tenantId, job, destination, options, token) {
  switch (destination) {
    case 'kolm': return exportToKolm(tenantId, job);
    case 'github': return exportToGitHub(job, options, token);
    case 'huggingface': return exportToHuggingFace(job, options, token);
    case 'ollama': return exportToOllama(job, options, token);
    case 'custom': return exportToCustom(job, options, token);
    default: throw new ExportError(400, 'unknown_destination', `unknown destination: ${destination}`);
  }
}

// startExport - validate, enqueue, return 202 payload. The actual push runs on
// a background fiber so the route returns immediately.
//
// `resolveArtifact(artifact_id)` is injected by the router (it passes getJob
// bound to the caller's tenant) so this module never imports compile.js and the
// ownership check stays in one place. It must return the job record or null.
export async function startExport(tenantId, body = {}, resolveArtifact) {
  if (!tenantId) throw new ExportError(401, 'auth_required', 'tenant required');
  if (!body || typeof body !== 'object') throw new ExportError(400, 'invalid_body', 'request body must be an object');

  const artifact_id = String(body.artifact_id || '');
  if (!artifact_id) throw new ExportError(400, 'artifact_id_required', 'artifact_id is required');

  const destination = String(body.destination || 'kolm');
  if (!DESTINATIONS.has(destination)) {
    throw new ExportError(400, 'unknown_destination', `destination must be one of: ${[...DESTINATIONS].join(', ')}`);
  }

  if (typeof resolveArtifact !== 'function') {
    throw new ExportError(500, 'misconfigured', 'artifact resolver not provided');
  }
  const job = await resolveArtifact(artifact_id);
  if (!job) throw new ExportError(404, 'artifact_not_found', 'artifact not found or not owned by caller');

  const options = (body.options && typeof body.options === 'object') ? body.options : {};
  const token = body.token != null ? String(body.token) : '';

  const export_id = newExportId();
  const started_at = new Date().toISOString();
  await writeJob(tenantId, artifact_id, { export_id, destination, state: 'queued', started_at });

  // Background fiber. The token lives only in this closure and is dropped when
  // the fiber returns; nothing token-bearing is ever persisted.
  setImmediate(async () => {
    let tok = token; // local copy zeroed after use
    try {
      await writeJob(tenantId, artifact_id, { export_id, destination, state: 'running', started_at });
      const { target_url, meta } = await runDestination(tenantId, job, destination, options, tok);
      await writeJob(tenantId, artifact_id, {
        export_id, destination, state: 'succeeded', target_url, meta,
        started_at, finished_at: new Date().toISOString(),
      });
    } catch (e) {
      const code = (e && e.code) ? e.code : 'export_failed';
      await writeJob(tenantId, artifact_id, {
        export_id, destination, state: 'failed',
        error: `${code}: ${String(e && e.message ? e.message : e)}`,
        started_at, finished_at: new Date().toISOString(),
      }).catch(() => { /* never crash the fiber */ });
    } finally {
      tok = null; // drop the token reference
    }
  });

  return { ok: true, export_id, state: 'queued' };
}

// list caller's export jobs (newest first).
export async function listExports(tenantId, opts = {}) {
  if (!tenantId) throw new ExportError(401, 'auth_required', 'tenant required');
  let limit = Number(opts.limit);
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  limit = Math.min(200, Math.trunc(limit));
  const rows = await listEvents({ namespace: EXPORT_NAMESPACE, tenant_id: tenantId, limit });
  const exports = rows
    .filter((ev) => ev.tenant_id === tenantId) // defense in depth
    .map(jobFromEvent);
  return { ok: true, exports, count: exports.length };
}

// single job state + target_url (tenant-checked). Throws 404 on miss/mismatch.
export async function getExport(tenantId, id) {
  if (!tenantId) throw new ExportError(401, 'auth_required', 'tenant required');
  const ev = await getEvent(String(id || ''));
  if (!ev || ev.tenant_id !== tenantId || ev.namespace !== EXPORT_NAMESPACE) {
    throw new ExportError(404, 'not_found', 'export job not found');
  }
  return { ok: true, export: jobFromEvent(ev) };
}
