// src/model-update-channel.js
//
// Employee/device model self-update channel with SIGNED versions + OFFLINE
// verification. Part of the P1/P2 "employee model access + updates" + "on-device
// DX" roadmap items.
//
// Responsibilities:
//   * publishVersion(tenant, {model_id, artifact_path, notes, version})
//       -> signs the artifact bytes (ed25519), records a versioned release row
//          in the event-store (namespace 'model.version'), returns the release.
//   * checkForUpdate(tenant, {model_id, current_version})
//       -> {update_available, latest_version, signed_url, signature, pubkey}
//   * listVersions(tenant, {model_id}) -> chronological release history.
//   * verifyLocal({artifact_path, signature, pubkey}) -> offline sig check,
//     NO network. The client/daemon calls this before applying an update.
//
// Tenant-fenced: every row carries tenant_id; reads filter by it.

import { appendEvent, listEvents } from './event-store.js';
import * as ed25519 from './ed25519.js';
import fs from 'node:fs';
import crypto from 'node:crypto';

export const MODEL_UPDATE_NAMESPACE = 'model.version';

// Resolve the active signing key (reuses ensure-signing-key's persistent store).
function _signer() {
  const s = ed25519.loadOrCreateDefaultSigner();
  if (!s) throw new Error('no signing key available');
  return s;
}

function _sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// publishVersion — sign + record a new model version.
export async function publishVersion(tenant, opts = {}) {
  const { model_id, artifact_path, notes = '', version } = opts;
  if (!tenant) throw new Error('tenant required');
  if (!model_id) throw new Error('model_id required');
  const ver = version || new Date().toISOString();
  let signature = null, sha = null, pubkey = null;
  if (artifact_path && fs.existsSync(artifact_path)) {
    const bytes = fs.readFileSync(artifact_path);
    sha = _sha256(bytes);
    const signer = _signer();
    signature = ed25519.sign(signer.privateKey, bytes);
    pubkey = signer.publicKey;
  }
  const release = {
    tenant_id: tenant, model_id, version: ver, notes,
    sha256: sha, signature, pubkey,
    created_at: new Date().toISOString(),
  };
  await appendEvent({
    event_id: `mv_${model_id}_${ver}`.replace(/[^A-Za-z0-9_.-]/g, '_'),
    tenant_id: tenant,
    namespace: MODEL_UPDATE_NAMESPACE,
    provider: 'kolm-model-update',
    model: model_id,
    status: 'ok',
    source_type: 'real',
    created_at: release.created_at,
    json: release,
  });
  return release;
}

// checkForUpdate — is there a newer signed version than the caller's?
export async function checkForUpdate(tenant, opts = {}) {
  const { model_id, current_version } = opts;
  if (!tenant || !model_id) throw new Error('tenant + model_id required');
  const rows = await listEvents({ namespace: MODEL_UPDATE_NAMESPACE, tenant_id: tenant, model: model_id });
  const versions = (rows || []).map(r => r.json).filter(Boolean).sort((a, b) => String(b.version).localeCompare(String(a.version)));
  const latest = versions[0] || null;
  const update_available = !!latest && latest.version !== current_version;
  return {
    update_available,
    latest_version: latest ? latest.version : null,
    signed_url: latest ? `/v1/models/${encodeURIComponent(model_id)}/versions/${encodeURIComponent(latest.version)}/download` : null,
    signature: latest ? latest.signature : null,
    pubkey: latest ? latest.pubkey : null,
    sha256: latest ? latest.sha256 : null,
  };
}

// listVersions — chronological release history for a model.
export async function listVersions(tenant, opts = {}) {
  const { model_id } = opts;
  if (!tenant) throw new Error('tenant required');
  const rows = await listEvents({ namespace: MODEL_UPDATE_NAMESPACE, tenant_id: tenant, model: model_id });
  return (rows || []).map(r => r.json).filter(Boolean).sort((a, b) => String(b.version).localeCompare(String(a.version)));
}

// verifyLocal — OFFLINE signature verification. No network, no store. The
// device/daemon calls this before applying a downloaded update.
export function verifyLocal(opts = {}) {
  const { artifact_path, signature, pubkey } = opts;
  if (!artifact_path || !signature || !pubkey) {
    return { ok: false, error: 'artifact_path, signature, pubkey all required' };
  }
  if (!fs.existsSync(artifact_path)) {
    return { ok: false, error: 'artifact not found: ' + artifact_path };
  }
  const bytes = fs.readFileSync(artifact_path);
  const ok = ed25519.verify(pubkey, bytes, signature);
  return { ok, verified: ok, artifact_path, sha256: _sha256(bytes) };
}

export default { MODEL_UPDATE_NAMESPACE, publishVersion, checkForUpdate, listVersions, verifyLocal };
