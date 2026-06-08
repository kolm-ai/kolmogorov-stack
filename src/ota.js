// W888-E - OTA (over-the-air update) policy engine.
//
// Per-namespace policy table persisted under <data_dir>/ota-policies.json:
//   {
//     "support": { "policy": "canary", "canary_observe_s": 60, "tag": "edge-canary" },
//     "billing": { "policy": "manual" },
//     ...
//   }
//
// Policies:
//   - manual    (default) - no-op. promote() just appends to ota-pending.json.
//   - notify - write the pending update to <data_dir>/ota-pending.json and
//                 return. No fleet action taken.
//   - canary - auto-deploy to the canary device first (filtered by the
//                 namespace policy's tag, default 'canary'), observe, promote.
//   - rolling - auto-deploy rolling to all tagged devices.
//   - immediate - deploy to all at once. Emits a warning that this skips the
//                 canary observation window - operators should only pick this
//                 for non-production tags.
//
// Public surface:
//   - VALID_POLICIES                 (set)
//   - setPolicy({ namespace, policy, options })
//   - getPolicy({ namespace })
//   - listPolicies()
//   - promote({ namespace, artifactPath, fleet })
//
// `fleet` is injectable so tests can pass a Fleet stub instead of bringing
// the live deploy pipeline along.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Fleet as RealFleet } from './fleet.js';

export const VALID_POLICIES = new Set(['manual', 'notify', 'canary', 'rolling', 'immediate']);

// Default observation window (seconds) when a canary policy doesn't specify
// canary_observe_s. Mirrors the deploy-pipeline canary default (60s).
const DEFAULT_CANARY_OBSERVE_S = 60;

function _dataDir() {
  if (process.env.KOLM_DATA_DIR) return path.resolve(process.env.KOLM_DATA_DIR);
  // The Run surface persists OTA state alongside the rest of the on-disk
  // fleet records. We prefer the per-user dir over the repo's `./data/`
  // directory so multiple checkouts don't share state.
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, '.kolm');
}

function _ensureDir(p) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {} // deliberate: cleanup
  return p;
}

function _policiesPath() {
  return path.join(_ensureDir(_dataDir()), 'ota-policies.json');
}

// The pending-update queue. CLI `kolm namespace updates pending` (a future
// W888-G verb) reads this for the operator. For now we only have the writer.
function _pendingPath() {
  // Per the W888-E directive: `data/ota-pending.json`. Honor both the data
  // dir AND the repo-root convention so unit tests that probe the repo path
  // also see the writer's output.
  const dir = _dataDir();
  return path.join(_ensureDir(dir), 'ota-pending.json');
}

// The W888-E directive specifically calls out `data/ota-pending.json` - keep
// a second writer for the repo-relative path so the file shows up where the
// directive promised. Best-effort: ignored if the cwd is not the repo.
function _repoPendingPath() {
  try {
    const repoData = path.resolve(process.cwd(), 'data');
    if (!fs.existsSync(repoData)) return null;
    return path.join(repoData, 'ota-pending.json');
  } catch { return null; }
}

function _readJson(p, fallback) {
  try { if (!fs.existsSync(p)) return fallback; return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return fallback; }
}

function _writeJson(p, value) {
  try { fs.writeFileSync(p, JSON.stringify(value, null, 2)); return true; }
  catch (e) { return { error: e && e.message || String(e) }; }
}

export function listPolicies() {
  return _readJson(_policiesPath(), {});
}

export function getPolicy({ namespace } = {}) {
  if (!namespace) return { policy: 'manual', namespace: null, default: true };
  const all = listPolicies();
  if (all[namespace]) return { namespace, ...all[namespace] };
  return { namespace, policy: 'manual', default: true };
}

export function setPolicy({ namespace, policy, options = {} } = {}) {
  if (!namespace || typeof namespace !== 'string') {
    return { ok: false, error: 'namespace required' };
  }
  if (!VALID_POLICIES.has(policy)) {
    return { ok: false, error: `policy must be one of: ${Array.from(VALID_POLICIES).join(', ')}` };
  }
  const all = listPolicies();
  const next = { policy, ...options, updated_at: new Date().toISOString() };
  all[namespace] = next;
  const write = _writeJson(_policiesPath(), all);
  if (write && write.error) return { ok: false, error: write.error };
  return { ok: true, namespace, ...next };
}

// promote({ namespace, artifactPath, fleet }) -> result envelope.
// `fleet` is optional; we instantiate a real Fleet if absent.
export async function promote({ namespace, artifactPath, fleet = null, deviceCaps = null } = {}) {
  if (!namespace) return { ok: false, error: 'namespace required' };
  if (!artifactPath) return { ok: false, error: 'artifactPath required' };

  const cfg = getPolicy({ namespace });
  const policy = cfg.policy || 'manual';

  // Branch table.
  if (policy === 'manual') {
    return { ok: true, namespace, policy, action: 'noop', message: 'manual policy: no automatic deploy' };
  }

  if (policy === 'notify') {
    const entry = {
      namespace,
      artifact_path: artifactPath,
      requested_at: new Date().toISOString(),
      policy,
    };
    const pending = _readJson(_pendingPath(), []);
    pending.push(entry);
    const w1 = _writeJson(_pendingPath(), pending);
    let repo_wrote = false;
    const rp = _repoPendingPath();
    if (rp) {
      // For the repo-relative file mirror the same queue.
      const repoPending = _readJson(rp, []);
      repoPending.push(entry);
      const w2 = _writeJson(rp, repoPending);
      repo_wrote = !(w2 && w2.error);
    }
    if (w1 && w1.error) return { ok: false, error: w1.error };
    return { ok: true, namespace, policy, action: 'pending_written', path: _pendingPath(), repo_pending_path: rp, repo_wrote };
  }

  // Modes that touch the fleet - instantiate it now (lazy so manual/notify
  // never need to know about the deploy pipeline).
  const f = fleet || new RealFleet({ deviceCaps });
  const tag = cfg.tag || null;
  const canaryObserveMs = (cfg.canary_observe_s || DEFAULT_CANARY_OBSERVE_S) * 1000;

  if (policy === 'canary') {
    const r = await f.deploy({ artifactPath, tag, namespace, mode: 'canary', canaryObserveMs });
    return { ok: !!r.ok, namespace, policy, action: 'canary_deploy', result: r };
  }
  if (policy === 'rolling') {
    const r = await f.deploy({ artifactPath, tag, namespace, mode: 'rolling' });
    return { ok: !!r.ok, namespace, policy, action: 'rolling_deploy', result: r };
  }
  if (policy === 'immediate') {
    const r = await f.deploy({ artifactPath, tag, namespace, mode: 'all' });
    return {
      ok: !!r.ok, namespace, policy, action: 'immediate_deploy',
      warning: 'immediate policy skips canary observation; only use for non-production tags',
      result: r,
    };
  }
  return { ok: false, error: `unhandled policy: ${policy}` };
}

// Test helper: clear policies + pending queue. Not exported in the default
// surface; tests import it directly.
export function _clearAll() {
  try { fs.rmSync(_policiesPath(), { force: true }); } catch {} // deliberate: cleanup
  try { fs.rmSync(_pendingPath(), { force: true }); } catch {} // deliberate: cleanup
  const rp = _repoPendingPath();
  if (rp) { try { fs.rmSync(rp, { force: true }); } catch {} } // deliberate: cleanup
}

export default { VALID_POLICIES, listPolicies, getPolicy, setPolicy, promote };
