// W888-C — DeviceRegistry: single-file JSON registry for the device fleet.
//
// Complements (does NOT replace) the existing src/device-capabilities.js
// per-file profile store (~/.kolm/devices/<id>.json). The W888-C registry
// is the *operator-facing* view: one consolidated data/devices.json that
// gets shipped with the repo and read by the HTTP control plane + the
// new `kolm devices add/probe/remove` CLI verbs.
//
// Storage:
//   - default path: process.env.KOLM_DATA_DIR ? `${KOLM_DATA_DIR}/devices.json`
//                                              : `<repo>/data/devices.json`
//   - overridable via constructor opt {dataDir}
//   - atomic write: write to `<file>.tmp.<rand>` then rename, so a crash
//     in the middle never leaves a half-written devices.json.
//
// Record shape (mirrors the contract DeployPipeline + Fleet expect):
//   {
//     id, name, host, port, user, type,
//     keyPath, tags, hardware_hint,
//     created_at, last_seen, status,
//     // fields written by heartbeat():
//     observed_hardware, status, last_seen,
//     // tombstone:
//     removed_at?: string,
//   }
//
// Caveats / Constraints / Limitations:
//   - Soft delete is the default for remove(); operators run `remove --hard`
//     when they want the row physically gone. Soft-deleted rows are excluded
//     from list() by default (pass {includeRemoved:true} to see them).
//   - `register()` enforces id uniqueness against the live (non-removed) set.
//     Re-registering an id that was soft-removed clears the removed_at field.
//   - Concurrent writers are NOT supported. This is a single-process registry
//     mirroring how `kolm` runs today (one CLI / one server process per box).
//   - The registry holds connection metadata only. Hardware + alerts live in
//     the device-capabilities snapshot store + fleet-monitor tick journal.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const DEVICE_TYPES = new Set(['ssh', 'local', 'ollama', 'k8s', 'runpod', 'modal']);
const VALID_STATUSES = new Set(['unknown', 'online', 'offline', 'error']);

function _defaultDataDir() {
  if (process.env.KOLM_DATA_DIR) return path.resolve(process.env.KOLM_DATA_DIR);
  // Repo-local default: <cwd>/data — matches what src/store.js does in dev.
  return path.resolve('data');
}

const _fallbackPathMap = new Map();
function _fallbackFor(filePath) {
  if (_fallbackPathMap.has(filePath)) return _fallbackPathMap.get(filePath);
  const tag = crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 12);
  const fb = path.join(os.tmpdir(), 'kolm-device-registry-' + tag, path.basename(filePath));
  _fallbackPathMap.set(filePath, fb);
  return fb;
}

function _atomicWriteJson(filePath, value) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch (err) {
    if (err && (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS')) {
      const fb = _fallbackFor(filePath);
      fs.mkdirSync(path.dirname(fb), { recursive: true });
      const tmpFb = fb + '.tmp.' + crypto.randomBytes(6).toString('hex');
      fs.writeFileSync(tmpFb, JSON.stringify(value, null, 2));
      fs.renameSync(tmpFb, fb);
      return;
    }
    throw err;
  }
  const tmp = filePath + '.tmp.' + crypto.randomBytes(6).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, filePath);
}

function _readJsonOr(filePath, fallback) {
  let target = filePath;
  if (!fs.existsSync(target)) {
    const fb = _fallbackPathMap.get(filePath) || _fallbackFor(filePath);
    if (!fs.existsSync(fb)) return fallback;
    target = fb;
  }
  try { return JSON.parse(fs.readFileSync(target, 'utf8')); }
  catch { return fallback; }
}

function _validateId(id) {
  if (!id || typeof id !== 'string') {
    const e = new Error('device id required (string)'); e.code = 'KOLM_E_BAD_ID'; throw e;
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(id)) {
    const e = new Error(`device id "${id}" must match /^[a-z0-9][a-z0-9._-]{0,62}$/`);
    e.code = 'KOLM_E_BAD_ID'; throw e;
  }
}

function _validateType(type) {
  if (!DEVICE_TYPES.has(type)) {
    const e = new Error(`device type "${type}" not in {${Array.from(DEVICE_TYPES).join(',')}}`);
    e.code = 'KOLM_E_BAD_TYPE'; throw e;
  }
}

export class DeviceRegistry {
  // opts:
  //   - store    (optional)  — capture-store hook (unused by default; reserved
  //                            so future callers can mirror device events into
  //                            the capture lake without breaking the API).
  //   - dataDir  (optional)  — override the on-disk root (test isolation).
  //   - filePath (optional)  — override the entire path, NOT just dataDir.
  constructor({ store = null, dataDir = null, filePath = null } = {}) {
    this._store = store;
    this._dataDir = dataDir ? path.resolve(dataDir) : _defaultDataDir();
    this._filePath = filePath ? path.resolve(filePath) : path.join(this._dataDir, 'devices.json');
  }

  // Internal: read the entire registry file. Returns {devices: [...]}.
  _read() {
    return _readJsonOr(this._filePath, { devices: [] });
  }

  _write(payload) {
    _atomicWriteJson(this._filePath, payload);
  }

  // Public: the on-disk file path. Useful for tests + debugging.
  filePath() { return this._filePath; }

  // register(record) -> the canonical stored record.
  //   - id is required, must be unique among live (non-removed) records
  //   - type defaults to 'ssh'
  //   - host/port/user optional for type=local
  async register(input = {}) {
    const id = String(input.id || '').trim();
    _validateId(id);
    const type = input.type || 'ssh';
    _validateType(type);

    // For ssh + ollama + k8s, host is required at register time.
    if (['ssh', 'ollama', 'k8s'].includes(type)) {
      if (!input.host) {
        const e = new Error(`device ${id}: host required for type=${type}`);
        e.code = 'KOLM_E_NO_HOST'; throw e;
      }
    }

    const payload = this._read();
    const existing = payload.devices.find(d => d.id === id);
    if (existing && !existing.removed_at) {
      const e = new Error(`device id "${id}" already registered`);
      e.code = 'KOLM_E_DUPLICATE_ID'; throw e;
    }

    const now = new Date().toISOString();
    const record = {
      id,
      name: input.name || id,
      type,
      host: input.host || null,
      port: input.port != null ? Number(input.port) : (type === 'ssh' ? 22 : (type === 'ollama' ? 11434 : null)),
      user: input.user || (type === 'ssh' ? 'kolm' : null),
      keyPath: input.keyPath || input.key_path || null,
      tags: Array.isArray(input.tags) ? input.tags.slice() : [],
      hardware_hint: input.hardware_hint || null,
      created_at: now,
      last_seen: null,
      status: 'unknown',
      observed_hardware: null,
    };

    if (existing && existing.removed_at) {
      // Restore the soft-deleted slot in place.
      record.created_at = existing.created_at || now;
      const idx = payload.devices.findIndex(d => d.id === id);
      payload.devices[idx] = record;
    } else {
      payload.devices.push(record);
    }
    this._write(payload);

    if (this._store && typeof this._store.put === 'function') {
      try { await this._store.put('device_events', { id: crypto.randomBytes(8).toString('hex'), event: 'register', device_id: id, ts: now }); }
      catch { /* best-effort */ }
    }
    return record;
  }

  // list({tag, type, status, includeRemoved}) -> Array<record>
  // - tag is a single string (substring match against each record.tags entry)
  // - type filters by exact match
  // - status filters by exact match against record.status
  // - includeRemoved: include soft-deleted rows (default false)
  async list({ tag = null, type = null, status = null, includeRemoved = false } = {}) {
    const payload = this._read();
    return payload.devices.filter((d) => {
      if (!includeRemoved && d.removed_at) return false;
      if (type && d.type !== type) return false;
      if (status && d.status !== status) return false;
      if (tag && !(Array.isArray(d.tags) && d.tags.includes(tag))) return false;
      return true;
    });
  }

  // get(id) -> record OR null. Soft-removed records ARE returned (callers can
  // branch on removed_at), but they are excluded from list() by default.
  async get(id) {
    if (!id) return null;
    const payload = this._read();
    return payload.devices.find(d => d.id === id) || null;
  }

  // remove(id, {hard}) -> { ok, mode: 'soft'|'hard' }
  // Soft delete sets removed_at; hard delete physically splices the row out.
  async remove(id, { hard = false } = {}) {
    _validateId(id);
    const payload = this._read();
    const idx = payload.devices.findIndex(d => d.id === id);
    if (idx === -1) {
      return { ok: false, error: 'unknown_device', id };
    }
    if (hard) {
      payload.devices.splice(idx, 1);
      this._write(payload);
      return { ok: true, mode: 'hard', id };
    }
    if (payload.devices[idx].removed_at) {
      return { ok: true, mode: 'soft', id, already_removed: true };
    }
    payload.devices[idx].removed_at = new Date().toISOString();
    this._write(payload);
    return { ok: true, mode: 'soft', id };
  }

  // update(id, patch) — shallow merge a patch into the record. Ignores
  // attempts to overwrite id / created_at; allows nulling out fields by
  // passing null explicitly.
  async update(id, patch = {}) {
    _validateId(id);
    if (!patch || typeof patch !== 'object') {
      const e = new Error('patch must be an object'); e.code = 'KOLM_E_BAD_PATCH'; throw e;
    }
    const payload = this._read();
    const idx = payload.devices.findIndex(d => d.id === id);
    if (idx === -1) {
      const e = new Error(`unknown device: ${id}`); e.code = 'KOLM_E_UNKNOWN_DEVICE'; throw e;
    }
    const merged = { ...payload.devices[idx], ...patch, id: payload.devices[idx].id, created_at: payload.devices[idx].created_at };
    // If status is being patched, validate it.
    if (patch.status && !VALID_STATUSES.has(patch.status)) {
      const e = new Error(`status "${patch.status}" not in {${Array.from(VALID_STATUSES).join(',')}}`);
      e.code = 'KOLM_E_BAD_STATUS'; throw e;
    }
    payload.devices[idx] = merged;
    this._write(payload);
    return merged;
  }

  // heartbeat(id, {status, last_seen, observed_hardware}) — update fields
  // from a poll cycle. Used by the HTTP /v1/devices/:id/heartbeat handler
  // and by the local probe path.
  async heartbeat(id, { status = null, last_seen = null, observed_hardware = null } = {}) {
    _validateId(id);
    const payload = this._read();
    const idx = payload.devices.findIndex(d => d.id === id);
    if (idx === -1) {
      const e = new Error(`unknown device: ${id}`); e.code = 'KOLM_E_UNKNOWN_DEVICE'; throw e;
    }
    if (status && !VALID_STATUSES.has(status)) {
      const e = new Error(`status "${status}" not in {${Array.from(VALID_STATUSES).join(',')}}`);
      e.code = 'KOLM_E_BAD_STATUS'; throw e;
    }
    const record = payload.devices[idx];
    if (status) record.status = status;
    record.last_seen = last_seen || new Date().toISOString();
    if (observed_hardware && typeof observed_hardware === 'object') {
      record.observed_hardware = observed_hardware;
    }
    payload.devices[idx] = record;
    this._write(payload);
    return record;
  }
}

export const DEVICE_TYPES_LIST = Array.from(DEVICE_TYPES);
export const DEVICE_STATUSES = Array.from(VALID_STATUSES);

export default { DeviceRegistry, DEVICE_TYPES_LIST, DEVICE_STATUSES };
