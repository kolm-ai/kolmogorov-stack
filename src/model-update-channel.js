// src/model-update-channel.js
//
// Employee model self-update + offline-verifiable signed models (P1/P2).
//
// This is the publish/subscribe layer that lets a deployed model artifact
// (running inside an employee's environment, an edge worker, or an airgapped
// box) discover that a newer signed version exists and verify that version's
// integrity WITHOUT trusting the server it downloaded from.
//
// Three primitives:
//
//   publishVersion({ tenant, model_id, artifact_path, notes })
//       Hash the artifact bytes, sign the hash with the tenant's Ed25519
//       signing key (same key machinery as src/ed25519.js / src/artifact.js),
//       allocate the next monotonic semver, and persist a versioned release
//       row. Returns the release row.
//
//   checkForUpdate({ tenant, model_id, current_version })
//       Look up the latest published release for (tenant, model_id) and decide
//       whether it supersedes current_version. Returns
//       { update_available, latest_version, signed_url, signature, ... }.
//
//   verifyLocal({ artifact_path, signature, pubkey })
//       PURE / OFFLINE. Re-hash the local artifact bytes and check the Ed25519
//       signature against the supplied public key. No disk-of-state, no
//       network, no event-store - the whole point of P2 is that a verifier with
//       only (bytes, signature, pubkey) can confirm provenance on a box that
//       has never talked to kolm.
//
// WHY Ed25519 over the artifact-hash (not over the raw bytes): the bytes can be
// gigabytes (GGUF weights). We sign a small canonical "signing statement" that
// pins the sha256 of the bytes plus the (tenant, model_id, version). Signing
// the statement is O(1); the statement binds the bytes via the hash. verifyLocal
// re-derives the exact same statement from (path, version, model_id, tenant)
// the caller supplies inside the signature envelope, so a tamperer who swaps the
// bytes breaks the hash, and a tamperer who swaps the statement breaks the
// signature.
//
// TENANT FENCING: every release row carries tenant_id = the OWNING org tenant.
// All reads filter on it, exactly like src/model-entitlements.js and
// src/groups.js. A model_id is otherwise global (a registry id or a tenant-
// private compiled-artifact id) - fencing applies to WHO published the version,
// not to which base model exists.
//
// Storage: durable rows in src/store.js (table 'model_versions'), the same
// store src/model-entitlements.js writes entitlement rows to. We ALSO mirror a
// lightweight audit event through src/event-store.js (provider
// 'kolm-model-update') so the publish shows up in the same event stream the
// chargeback / audit surfaces already read - additive, never load-bearing for
// correctness.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { id as storeId, insert, findOne, all } from './store.js';
import { appendEvent } from './event-store.js';
import {
  sign as edSign,
  verify as edVerify,
  keyFingerprint as edKeyFingerprint,
  loadOrCreateDefaultSigner,
} from './ed25519.js';

const TABLE = 'model_versions';

// Spec tag stamped on every signing statement + release row so a future schema
// bump can branch on shape without guessing.
export const MODEL_UPDATE_SPEC = 'kolm-model-update-v1';

// The Ed25519 signing statement is signed; this is its canonical string form.
// Sorted-key JSON so the bytes are reproducible across engines (same discipline
// as canonicalJson in src/artifact.js). Any field added here must be derivable
// by verifyLocal from public inputs, or the signature cannot be re-checked
// offline.
function _canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(_canonicalJson).join(',') + ']';
  const k = Object.keys(v).sort();
  return '{' + k.map((x) => JSON.stringify(x) + ':' + _canonicalJson(v[x])).join(',') + '}';
}

// Chunked sha256 of a file on disk - mirrors src/artifact.js sha256File so
// multi-GiB GGUF weights hash without tripping Node's 2 GiB readFileSync limit.
function _sha256File(absPath) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(absPath, 'r');
  try {
    const CHUNK = 1024 * 1024;
    const buf = Buffer.alloc(CHUNK);
    while (true) {
      const read = fs.readSync(fd, buf, 0, CHUNK, null);
      if (read <= 0) break;
      h.update(buf.subarray(0, read));
    }
    return h.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function _err(message, code, status) {
  const e = new Error(message);
  e.code = code;
  if (status) e.status = status;
  return e;
}

// ---------------------------------------------------------------------------
// Semver helpers. Versions are "MAJOR.MINOR.PATCH" with optional missing
// segments treated as 0 (so "2", "2.7", "2.7.0" all parse). Numeric compare,
// NOT lexical - the W545 trap (lexical "1" < "7") is avoided by comparing
// integer segments.
// ---------------------------------------------------------------------------
function _parseVersion(v) {
  if (v === null || v === undefined) return [0, 0, 0];
  const s = String(v).trim().replace(/^v/i, '');
  const parts = s.split('.').map((p) => {
    const n = parseInt(p, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
}

// Returns negative if a<b, 0 if equal, positive if a>b.
function _compareVersions(a, b) {
  const pa = _parseVersion(a);
  const pb = _parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

function _formatVersion(parts) {
  return `${parts[0]}.${parts[1]}.${parts[2]}`;
}

// Bump the patch segment of the highest released version, or 1.0.0 when this is
// the first release. An explicit `version` on the publish input always wins (it
// must still be strictly greater than the current latest - enforced in
// publishVersion).
function _nextVersion(latestVersion) {
  if (!latestVersion) return '1.0.0';
  const p = _parseVersion(latestVersion);
  p[2] += 1;
  return _formatVersion(p);
}

// ---------------------------------------------------------------------------
// Release-row queries. Tenant-fenced, soft-delete aware (mirrors the _deleted
// convention in src/model-entitlements.js / src/groups.js).
// ---------------------------------------------------------------------------
function _liveReleases(tenant, modelId) {
  const want = String(modelId);
  return all(TABLE).filter(
    (r) => r && !r._deleted && r.tenant_id === tenant && r.model_id === want,
  );
}

// Highest-version live release for (tenant, model_id), or null.
function _latestRelease(tenant, modelId) {
  const rows = _liveReleases(tenant, modelId);
  if (!rows.length) return null;
  let best = rows[0];
  for (const r of rows) {
    if (_compareVersions(r.version, best.version) > 0) best = r;
  }
  return best;
}

// Resolve the Ed25519 signer. Production injects KOLM_ED25519_PRIVATE_KEY;
// dev/CI falls back to the per-machine cached key (~/.kolm/signing-key.pem).
// Returns { privateKey, publicKey, key_fingerprint } or throws a 503 when
// signing is explicitly disabled (KOLM_ED25519_DISABLE=1) - publishing a
// version we cannot sign would defeat the offline-verifiability contract.
function _resolveSigner() {
  const signer = loadOrCreateDefaultSigner();
  if (!signer || !signer.privateKey || !signer.publicKey) {
    throw _err(
      'cannot sign model version: Ed25519 signing is disabled (unset KOLM_ED25519_DISABLE)',
      'signing_disabled',
      503,
    );
  }
  return signer;
}

// Build the canonical signing statement. This is the EXACT object whose
// canonical JSON is signed. verifyLocal re-derives it from the signature
// envelope so the check is self-contained.
function _signingStatement({ spec, tenant, model_id, version, artifact_sha256, artifact_bytes }) {
  return {
    spec,
    tenant,
    model_id: String(model_id),
    version: String(version),
    artifact_sha256,
    artifact_bytes,
  };
}

/**
 * Publish a new signed version of a model.
 *
 * Hashes the artifact at `artifact_path`, signs a canonical statement binding
 * (tenant, model_id, version, sha256, byte-length) with the tenant's Ed25519
 * key, allocates the next monotonic version, and persists a release row.
 *
 * @param {object} params
 * @param {string} params.tenant         OWNING org tenant id (required; fences storage)
 * @param {string} params.model_id       model id (registry id or tenant-private artifact id)
 * @param {string} params.artifact_path  absolute path to the artifact bytes (.kolm / .gguf / etc.)
 * @param {string} [params.notes]        free-text release notes
 * @param {string} [params.version]      explicit version (must be > current latest); else auto-bumped
 * @param {string} [params.signed_url]   download URL for the artifact (where checkForUpdate points clients)
 * @param {string} [params.published_by] principal id recording who published
 * @returns {Promise<object>} the persisted release row
 */
export async function publishVersion({
  tenant,
  model_id,
  artifact_path,
  notes,
  version,
  signed_url,
  published_by,
} = {}) {
  if (!tenant) throw _err('tenant required', 'bad_request', 400);
  if (!model_id) throw _err('model_id required', 'bad_request', 400);
  if (!artifact_path || typeof artifact_path !== 'string') {
    throw _err('artifact_path required', 'bad_request', 400);
  }
  if (!fs.existsSync(artifact_path)) {
    throw _err(`artifact_path not found: ${artifact_path}`, 'not_found', 404);
  }
  const stat = fs.statSync(artifact_path);
  if (!stat.isFile()) {
    throw _err(`artifact_path is not a file: ${artifact_path}`, 'bad_request', 400);
  }

  // Allocate the version. Auto-bump from the current latest, unless the caller
  // pinned one explicitly (which must strictly supersede the latest so the
  // monotonic-version invariant checkForUpdate relies on holds).
  const latest = _latestRelease(tenant, model_id);
  const latestVersion = latest ? latest.version : null;
  let nextVersion;
  if (version !== null && version !== undefined && String(version).trim() !== '') {
    nextVersion = String(version).trim().replace(/^v/i, '');
    if (latestVersion && _compareVersions(nextVersion, latestVersion) <= 0) {
      throw _err(
        `version ${nextVersion} does not supersede latest ${latestVersion}`,
        'version_conflict',
        409,
      );
    }
  } else {
    nextVersion = _nextVersion(latestVersion);
  }

  // Hash the bytes (chunked, so multi-GiB weights are fine).
  const artifact_sha256 = _sha256File(artifact_path);
  const artifact_bytes = stat.size;

  // Sign the canonical statement with the Ed25519 signing key.
  const signer = _resolveSigner();
  const statement = _signingStatement({
    spec: MODEL_UPDATE_SPEC,
    tenant,
    model_id,
    version: nextVersion,
    artifact_sha256,
    artifact_bytes,
  });
  const payloadCanonical = _canonicalJson(statement);
  const signature = edSign(signer.privateKey, payloadCanonical);
  const key_fingerprint = signer.key_fingerprint || edKeyFingerprint(signer.publicKey);

  const now = new Date().toISOString();
  const row = {
    id: storeId('mver'),
    spec: MODEL_UPDATE_SPEC,
    tenant_id: tenant,
    model_id: String(model_id),
    version: nextVersion,
    artifact_path,
    artifact_basename: path.basename(artifact_path),
    artifact_sha256,
    artifact_bytes,
    signature,
    signature_alg: 'ed25519',
    public_key: signer.publicKey,
    key_fingerprint,
    signed_url: signed_url ? String(signed_url) : null,
    notes: notes ? String(notes) : null,
    published_by: published_by ? String(published_by) : null,
    predecessor_version: latestVersion || null,
    created_at: now,
  };
  insert(TABLE, row);

  // Additive audit trail - mirrors src/model-entitlements.js attributeUsage.
  // Best-effort; a failure here must NOT void a successfully persisted release.
  try {
    await appendEvent({
      tenant_id: tenant,
      namespace: `model-update/${row.model_id}`,
      provider: 'kolm-model-update',
      model: row.model_id,
      status: 'ok',
      estimated_cost_usd: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      metadata: {
        kind: 'model_version_published',
        model_id: row.model_id,
        version: row.version,
        artifact_sha256: row.artifact_sha256,
        key_fingerprint: row.key_fingerprint,
        published_by: row.published_by,
      },
    });
  } catch {
    /* audit is non-load-bearing; the release row is the source of truth */
  }

  return _publicRelease(row);
}

// Strip internal-only fields from a release row before returning it to a
// caller. We keep `artifact_path` OUT of the public shape (it's a server-local
// filesystem path); clients get `signed_url` to download from.
function _publicRelease(row) {
  if (!row) return null;
  return {
    id: row.id,
    spec: row.spec,
    tenant_id: row.tenant_id,
    model_id: row.model_id,
    version: row.version,
    artifact_basename: row.artifact_basename,
    artifact_sha256: row.artifact_sha256,
    artifact_bytes: row.artifact_bytes,
    signature: row.signature,
    signature_alg: row.signature_alg,
    public_key: row.public_key,
    key_fingerprint: row.key_fingerprint,
    signed_url: row.signed_url,
    notes: row.notes,
    published_by: row.published_by,
    predecessor_version: row.predecessor_version,
    created_at: row.created_at,
  };
}

/**
 * List every published version for (tenant, model_id), newest first.
 * Tenant-fenced.
 *
 * @param {string} tenant
 * @param {string} model_id
 * @returns {object[]} public release rows, descending by version
 */
export function listVersions(tenant, model_id) {
  if (!tenant) throw _err('tenant required', 'bad_request', 400);
  if (!model_id) throw _err('model_id required', 'bad_request', 400);
  return _liveReleases(tenant, model_id)
    .map(_publicRelease)
    .sort((a, b) => _compareVersions(b.version, a.version));
}

/**
 * Check whether a newer signed version exists than `current_version`.
 *
 * The returned `signature` + `signed_url` + `artifact_sha256` + `public_key`
 * give a client everything it needs to (1) download the new artifact and
 * (2) call verifyLocal offline before trusting it.
 *
 * @param {object} params
 * @param {string} params.tenant            OWNING org tenant id
 * @param {string} params.model_id
 * @param {string} [params.current_version] the version the client is running ('0.0.0' if unknown)
 * @returns {{
 *   update_available: boolean,
 *   current_version: string,
 *   latest_version: string|null,
 *   signed_url: string|null,
 *   signature: string|null,
 *   artifact_sha256: string|null,
 *   public_key: string|null,
 *   key_fingerprint: string|null,
 *   spec: string,
 *   release: object|null
 * }}
 */
export function checkForUpdate({ tenant, model_id, current_version } = {}) {
  if (!tenant) throw _err('tenant required', 'bad_request', 400);
  if (!model_id) throw _err('model_id required', 'bad_request', 400);

  const current = (current_version === null || current_version === undefined || String(current_version).trim() === '')
    ? '0.0.0'
    : String(current_version).trim().replace(/^v/i, '');

  const latest = _latestRelease(tenant, model_id);
  if (!latest) {
    return {
      update_available: false,
      current_version: current,
      latest_version: null,
      signed_url: null,
      signature: null,
      artifact_sha256: null,
      public_key: null,
      key_fingerprint: null,
      spec: MODEL_UPDATE_SPEC,
      release: null,
    };
  }

  const update_available = _compareVersions(latest.version, current) > 0;
  return {
    update_available,
    current_version: current,
    latest_version: latest.version,
    signed_url: latest.signed_url || null,
    signature: latest.signature || null,
    artifact_sha256: latest.artifact_sha256 || null,
    public_key: latest.public_key || null,
    key_fingerprint: latest.key_fingerprint || null,
    spec: MODEL_UPDATE_SPEC,
    release: _publicRelease(latest),
  };
}

/**
 * OFFLINE signature verification. No network, no state, no event-store.
 *
 * Re-hashes the local artifact, reconstructs the canonical signing statement
 * from the supplied envelope fields, and checks the Ed25519 signature against
 * the supplied public key. A verifier with only (bytes, signature, pubkey,
 * declared {tenant, model_id, version, sha256}) can confirm provenance on a box
 * that has never talked to kolm.
 *
 * Accepts the signature either as a bare base64url string OR as the full
 * release object returned by checkForUpdate/publishVersion (in which case the
 * statement fields are read from it). The artifact_sha256 / version / model_id /
 * tenant can be supplied directly or read from a release object - but the
 * artifact bytes on disk are ALWAYS re-hashed; a declared sha256 that does not
 * match the bytes fails before the signature is even checked.
 *
 * @param {object} params
 * @param {string} params.artifact_path  absolute path to the local artifact bytes
 * @param {string|object} params.signature  base64url Ed25519 signature, or a release object carrying it
 * @param {string} params.pubkey         PEM-encoded Ed25519 public key
 * @param {object} [params.release]      optional release object to source statement fields from
 * @param {string} [params.tenant]
 * @param {string} [params.model_id]
 * @param {string} [params.version]
 * @param {string} [params.artifact_sha256]  declared expected sha256 (cross-checked against bytes)
 * @returns {{ ok: boolean, reason: string|null, artifact_sha256: string|null,
 *             key_fingerprint: string|null, version: string|null }}
 */
export function verifyLocal({
  artifact_path,
  signature,
  pubkey,
  release,
  tenant,
  model_id,
  version,
  artifact_sha256,
} = {}) {
  // Allow `signature` to be a release object (DX: pass the whole row back).
  let sigObj = null;
  let sigStr = null;
  if (signature && typeof signature === 'object') {
    sigObj = signature;
    sigStr = signature.signature || null;
  } else if (typeof signature === 'string') {
    sigStr = signature;
  }
  const src = release || sigObj || {};

  const _tenant = tenant != null ? tenant : src.tenant_id != null ? src.tenant_id : src.tenant;
  const _modelId = model_id != null ? model_id : src.model_id;
  const _version = version != null ? version : src.version;
  const _declaredSha = artifact_sha256 != null ? artifact_sha256 : src.artifact_sha256;
  const _pubkey = pubkey != null ? pubkey : src.public_key;
  const _spec = src.spec || MODEL_UPDATE_SPEC;
  const _bytesDeclared = src.artifact_bytes;

  if (!artifact_path || typeof artifact_path !== 'string') {
    return { ok: false, reason: 'artifact_path required', artifact_sha256: null, key_fingerprint: null, version: _version || null };
  }
  if (!fs.existsSync(artifact_path)) {
    return { ok: false, reason: `artifact_path not found: ${artifact_path}`, artifact_sha256: null, key_fingerprint: null, version: _version || null };
  }
  if (typeof sigStr !== 'string' || sigStr.length === 0) {
    return { ok: false, reason: 'signature required', artifact_sha256: null, key_fingerprint: null, version: _version || null };
  }
  if (typeof _pubkey !== 'string' || _pubkey.length === 0) {
    return { ok: false, reason: 'pubkey required (PEM-encoded Ed25519 public key)', artifact_sha256: null, key_fingerprint: null, version: _version || null };
  }
  if (!_tenant || !_modelId || !_version) {
    return {
      ok: false,
      reason: 'tenant, model_id, and version are required (supply them directly or via a release object) so the signing statement can be reconstructed',
      artifact_sha256: null,
      key_fingerprint: null,
      version: _version || null,
    };
  }

  // Re-hash the bytes ourselves - never trust a declared sha256 blindly.
  let actualSha;
  let actualBytes;
  try {
    actualSha = _sha256File(artifact_path);
    actualBytes = fs.statSync(artifact_path).size;
  } catch (e) {
    return { ok: false, reason: `cannot hash artifact: ${e.message}`, artifact_sha256: null, key_fingerprint: null, version: _version };
  }

  if (_declaredSha && _declaredSha !== actualSha) {
    return {
      ok: false,
      reason: `artifact sha256 mismatch: declared ${String(_declaredSha).slice(0, 16)}… but bytes hash to ${actualSha.slice(0, 16)}…`,
      artifact_sha256: actualSha,
      key_fingerprint: null,
      version: _version,
    };
  }

  // Reconstruct the EXACT statement publishVersion signed and verify against it.
  // artifact_bytes is part of the statement; prefer the declared byte-length
  // (from the release envelope) so the reconstructed statement is byte-identical
  // to what was signed, but fall back to the on-disk size when not supplied.
  const statement = _signingStatement({
    spec: _spec,
    tenant: _tenant,
    model_id: _modelId,
    version: _version,
    artifact_sha256: actualSha,
    artifact_bytes: (_bytesDeclared !== null && _bytesDeclared !== undefined) ? _bytesDeclared : actualBytes,
  });
  const payloadCanonical = _canonicalJson(statement);

  let key_fingerprint = null;
  try {
    key_fingerprint = edKeyFingerprint(_pubkey);
  } catch (e) {
    return { ok: false, reason: `invalid pubkey: ${e.message}`, artifact_sha256: actualSha, key_fingerprint: null, version: _version };
  }

  const ok = edVerify(_pubkey, payloadCanonical, sigStr);
  if (!ok) {
    return {
      ok: false,
      reason: 'Ed25519 signature does not verify against the artifact + statement',
      artifact_sha256: actualSha,
      key_fingerprint,
      version: _version,
    };
  }
  return { ok: true, reason: null, artifact_sha256: actualSha, key_fingerprint, version: _version };
}

export default {
  MODEL_UPDATE_SPEC,
  publishVersion,
  checkForUpdate,
  verifyLocal,
  listVersions,
};
