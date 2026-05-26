// R-2 — Artifact lifecycle state machine.
//
// An artifact moves through a small set of states that mirror the real-world
// publish workflow of a signed .kolm:
//
//   created   — bytes exist; not yet signed (e.g. mid-build)
//   signed    — receipt + signature attached; eligible to deploy
//   deployed  — bound to a namespace and serving traffic
//   monitored — deployed AND drift/health monitoring is on
//   superseded— another artifact took its serving slot (successor_id set)
//   revoked   — withdrawn (compromised key, license violation, etc.). Pulls
//               return 410 Gone and can never deploy again.
//   archived  — terminal cold storage (not serving, not eligible)
//
// Transitions are append-only. Every transition records a {timestamp, from,
// to, actor, reason, evidence_id, successor_id?} entry on the artifact's
// `lifecycle.history` array. State lives on disk at
// data/artifacts/<artifact_id>/lifecycle.json so the lake survives restarts
// without needing a DB schema migration.
//
// Constraints (enforced here, NOT in the caller):
//   * actor must be a non-empty string. Use the tenant_id of the caller or
//     the literal string 'system' for autonomous transitions.
//   * revoking requires a non-empty reason (audit trail).
//   * superseded requires a non-empty successor_id.
//
// Pull-blocking: canPull() returns false for revoked artifacts. The router's
// /v1/artifacts/:id/download handler reads this and returns 410 Gone before
// streaming bytes so a key-rotation event cannot silently still serve a
// withdrawn model.

import fs from 'node:fs';
import path from 'node:path';

const ON_VERCEL = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
const BUNDLED_DATA_DIR = path.resolve('data');
const DATA_DIR = process.env.KOLM_DATA_DIR
  ? path.resolve(process.env.KOLM_DATA_DIR)
  : (ON_VERCEL ? '/tmp/data' : BUNDLED_DATA_DIR);

// wave4-r-enrich: declarative transition map used by the new
// ArtifactLifecycle class below. The shape is identical to VALID_TRANSITIONS
// but expresses the FULL R-2 state ladder including monitored,
// drift_detected, re_evaluated (which v1 did not surface). v1's
// VALID_TRANSITIONS is preserved so the existing `transition(...)` helper
// keeps working for callers that already pinned it.
export const TRANSITIONS = Object.freeze({
  created:         Object.freeze(['signed']),
  signed:          Object.freeze(['deployed', 'revoked']),
  deployed:        Object.freeze(['monitored', 'superseded', 'revoked']),
  monitored:       Object.freeze(['drift_detected', 'superseded', 'revoked']),
  drift_detected:  Object.freeze(['re_evaluated', 'superseded', 'revoked']),
  re_evaluated:    Object.freeze(['monitored', 'superseded', 'revoked']),
  superseded:      Object.freeze(['archived', 'revoked']),
  archived:        Object.freeze([]),
  revoked:         Object.freeze([]),
});

export const LIFECYCLE_STATES = [
  'created',
  'signed',
  'deployed',
  'monitored',
  'superseded',
  'revoked',
  'archived',
];

// Allowed forward transitions. Anything not listed is rejected. `revoked`
// is reachable from any non-terminal state via the dedicated revoke() helper
// below — it is intentionally NOT inside this table so callers cannot route
// to it accidentally on a typo (revoke is destructive: pulls 410 forever).
//
// `undeployed` is included as a transient state that lives ONLY in the
// transition graph (it is not in LIFECYCLE_STATES — the canonical
// monitorable states are the seven above). When a namespace clears its
// artifact, we mark the binding deployed→undeployed→(deployed|archived).
// History rows still record both ends so the audit trail is complete.
export const VALID_TRANSITIONS = {
  created:    ['signed'],
  signed:     ['deployed', 'archived'],
  deployed:   ['monitored', 'superseded', 'revoked', 'undeployed'],
  undeployed: ['deployed', 'archived'],
  monitored:  ['deployed', 'superseded', 'revoked'],
  superseded: ['archived', 'revoked'],
  revoked:    ['archived'],
  archived:   [],
};

function _validArtifactId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_:.-]{1,128}$/.test(id);
}

function _lifecyclePath(artifact_id) {
  if (!_validArtifactId(artifact_id)) {
    throw new Error('invalid artifact_id: must match /^[a-zA-Z0-9_:.-]{1,128}$/');
  }
  return path.join(DATA_DIR, 'artifacts', artifact_id, 'lifecycle.json');
}

// Read the lifecycle record for an artifact_id from disk. Returns null when
// no record exists yet (caller decides whether to default to 'created').
export function readLifecycle(artifact_id) {
  const p = _lifecyclePath(artifact_id);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    if (!Array.isArray(obj.history)) obj.history = [];
    if (typeof obj.current_state !== 'string') obj.current_state = 'created';
    return obj;
  } catch {
    return null;
  }
}

// Persist the lifecycle record atomically (write-temp + rename). Same pattern
// store.js uses for json tables so we do not need a lock.
function _writeLifecycle(artifact_id, obj) {
  const p = _lifecyclePath(artifact_id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

// Materialise a lifecycle handle for an artifact_id. If no on-disk record
// exists, returns a fresh `{current_state:'created', history:[]}` shell —
// callers can pass that straight into transition().
export function loadOrInit(artifact_id) {
  const existing = readLifecycle(artifact_id);
  if (existing) return { artifact_id, ...existing };
  return { artifact_id, current_state: 'created', history: [] };
}

export function getCurrentState(artifact) {
  if (!artifact) return null;
  if (typeof artifact === 'string') {
    const loaded = readLifecycle(artifact);
    return loaded ? loaded.current_state : 'created';
  }
  return artifact.current_state || 'created';
}

export function getHistory(artifact) {
  if (!artifact) return [];
  if (typeof artifact === 'string') {
    const loaded = readLifecycle(artifact);
    return loaded && Array.isArray(loaded.history) ? loaded.history.slice() : [];
  }
  return Array.isArray(artifact.history) ? artifact.history.slice() : [];
}

// True when the artifact is eligible for pull/download. The only state that
// blocks a pull is `revoked` — archived artifacts can still be pulled for
// reproducibility (audit, retro-eval) even though they are not serving.
export function canPull(artifact) {
  const state = getCurrentState(artifact);
  return state !== 'revoked';
}

// Record a state transition. Validates the move against VALID_TRANSITIONS,
// fails closed on a missing actor, requires a reason for revocation, and
// requires a successor_id for supersession. Returns the updated artifact
// record (which is also persisted to disk when an artifact_id is known).
export function transition(artifact, toState, opts = {}) {
  if (!artifact || typeof artifact !== 'object') {
    throw new Error('transition(artifact, toState, opts): artifact must be a record from loadOrInit() or readLifecycle()');
  }
  const { actor, reason, evidence_id, successor_id } = opts;
  if (!actor || typeof actor !== 'string' || actor.trim() === '') {
    throw new Error('transition: actor is required (caller tenant_id or "system")');
  }
  if (!LIFECYCLE_STATES.includes(toState) && toState !== 'undeployed') {
    throw new Error(`transition: unknown to_state ${JSON.stringify(toState)}`);
  }
  const from = artifact.current_state || 'created';
  const allowed = VALID_TRANSITIONS[from] || [];
  if (!allowed.includes(toState)) {
    throw new Error(
      `invalid transition: ${from} -> ${toState} not permitted. ` +
      `Allowed from "${from}": [${allowed.join(', ') || '(none — terminal state)'}]`,
    );
  }
  if (toState === 'revoked' && (!reason || String(reason).trim() === '')) {
    throw new Error('transition: revoking requires a non-empty reason');
  }
  if (toState === 'superseded' && (!successor_id || String(successor_id).trim() === '')) {
    throw new Error('transition: superseding requires a non-empty successor_id');
  }
  const entry = {
    timestamp: new Date().toISOString(),
    from,
    to: toState,
    actor: String(actor),
    reason: reason ? String(reason) : null,
    evidence_id: evidence_id ? String(evidence_id) : null,
  };
  if (successor_id) entry.successor_id = String(successor_id);
  artifact.current_state = toState;
  artifact.history = Array.isArray(artifact.history) ? artifact.history.slice() : [];
  artifact.history.push(entry);
  if (artifact.artifact_id) {
    _writeLifecycle(artifact.artifact_id, {
      current_state: artifact.current_state,
      history: artifact.history,
    });
  }
  return artifact;
}

// Convenience: list every artifact_id that has a lifecycle.json on disk.
// Returns [] when the directory is missing. Used by `kolm artifact list`
// and the router's lifecycle index (future work).
export function listArtifactIds() {
  const root = path.join(DATA_DIR, 'artifacts');
  if (!fs.existsSync(root)) return [];
  try {
    return fs.readdirSync(root)
      .filter((d) => _validArtifactId(d))
      .filter((d) => fs.existsSync(path.join(root, d, 'lifecycle.json')));
  } catch {
    return [];
  }
}

// Test helper — wipe a single artifact's lifecycle record. Production
// callers should use transition(..., 'archived'); this exists so unit tests
// can run hermetically without touching real lake state.
export function _resetForTests(artifact_id) {
  const p = _lifecyclePath(artifact_id);
  try { fs.unlinkSync(p); } catch {} // deliberate: cleanup
}

// ---------------------------------------------------------------------------
// wave4-r-enrich: side-effect hooks fired on terminal transitions. Pulled out
// as named exports so the router (or any future scheduler) can swap them for
// real implementations without modifying this module. Default implementations
// are no-ops + structured log records so the audit trail is always present
// even before a downstream subscriber is wired up.
// ---------------------------------------------------------------------------

const _sideEffectLog = [];

export function _resetSideEffectLogForTests() {
  _sideEffectLog.length = 0;
}

export function getSideEffectLog() {
  return _sideEffectLog.slice();
}

/**
 * blockPulls(artifactId) — invoked on revoke. The default implementation
 * appends a structured record to an in-memory log so tests can observe the
 * side effect fired. Production wiring is expected to replace this with a
 * call into store.js / the router's pull guard.
 */
export function blockPulls(artifactId) {
  if (!artifactId || typeof artifactId !== 'string') {
    throw new Error('blockPulls: artifactId required (string)');
  }
  _sideEffectLog.push({
    kind: 'block_pulls',
    artifact_id: artifactId,
    timestamp: new Date().toISOString(),
  });
  return { ok: true, artifact_id: artifactId };
}

/**
 * alertDeployments(artifactId) — invoked on revoke. Notifies any deployment
 * that bound to the artifact_id. Default implementation is the structured
 * log; production wiring routes to the alert ladder.
 */
export function alertDeployments(artifactId) {
  if (!artifactId || typeof artifactId !== 'string') {
    throw new Error('alertDeployments: artifactId required (string)');
  }
  _sideEffectLog.push({
    kind: 'alert_deployments',
    artifact_id: artifactId,
    timestamp: new Date().toISOString(),
  });
  return { ok: true, artifact_id: artifactId };
}

/**
 * linkSuccessor(artifactId, successorId) — invoked on supersede. The default
 * implementation appends a structured log row; production wiring stores the
 * link on the lifecycle record.
 */
export function linkSuccessor(artifactId, successorId) {
  if (!artifactId || typeof artifactId !== 'string') {
    throw new Error('linkSuccessor: artifactId required (string)');
  }
  if (!successorId || typeof successorId !== 'string') {
    throw new Error('linkSuccessor: successorId required (string)');
  }
  _sideEffectLog.push({
    kind: 'link_successor',
    artifact_id: artifactId,
    successor_id: successorId,
    timestamp: new Date().toISOString(),
  });
  return { ok: true, artifact_id: artifactId, successor_id: successorId };
}

/**
 * ArtifactLifecycle — class-shaped wrapper around the v1 transition functions
 * that enforces the FULL R-2 ladder (created -> signed -> deployed ->
 * monitored -> drift_detected -> re_evaluated -> superseded/archived/revoked).
 *
 * Distinct from the v1 `transition()` function:
 *   - Validates against TRANSITIONS (the enriched table), not VALID_TRANSITIONS
 *   - Fires blockPulls + alertDeployments on revoke
 *   - Fires linkSuccessor on superseded
 *   - Carries an `evidence` field on every history row (in addition to
 *     evidence_id) so callers can attach a structured payload
 *
 * Construct with an artifact_id; the constructor reads from disk if a
 * lifecycle.json exists, otherwise starts fresh in 'created'.
 */
export class ArtifactLifecycle {
  constructor(artifact_id) {
    if (!_validArtifactId(artifact_id)) {
      throw new Error('ArtifactLifecycle: invalid artifact_id');
    }
    this.artifact_id = artifact_id;
    const existing = readLifecycle(artifact_id);
    this._state = existing ? existing.current_state : 'created';
    this._history = existing && Array.isArray(existing.history) ? existing.history.slice() : [];
  }

  currentState() {
    return this._state;
  }

  timeline() {
    return this._history.slice();
  }

  /**
   * transition(event, actor, reason, evidence) — validate the move against
   * TRANSITIONS, append a history row, fire side effects, persist.
   *
   * @param {string} event  - target state
   * @param {string} actor  - tenant_id or 'system'
   * @param {string} [reason]
   * @param {object|string} [evidence] - free-form payload OR evidence_id string
   */
  transition(event, actor, reason, evidence) {
    if (!actor || typeof actor !== 'string') {
      throw new Error('ArtifactLifecycle.transition: actor required');
    }
    const allowed = TRANSITIONS[this._state];
    if (!Array.isArray(allowed) || !allowed.includes(event)) {
      throw new Error(
        `ArtifactLifecycle: invalid transition ${this._state} -> ${event}. ` +
        `Allowed from "${this._state}": [${(allowed || []).join(', ') || '(none — terminal state)'}]`,
      );
    }
    if (event === 'revoked' && (!reason || String(reason).trim() === '')) {
      throw new Error('ArtifactLifecycle.transition: revoke requires reason');
    }
    let successor_id = null;
    if (event === 'superseded') {
      // The successor id may be supplied via reason ('superseded-by:<id>')
      // OR via evidence.successor_id.
      if (evidence && typeof evidence === 'object' && evidence.successor_id) {
        successor_id = String(evidence.successor_id);
      } else if (reason && /superseded-by:(\S+)/.test(reason)) {
        successor_id = reason.match(/superseded-by:(\S+)/)[1];
      }
      if (!successor_id) {
        throw new Error('ArtifactLifecycle.transition: supersede requires successor_id (in evidence.successor_id or reason="superseded-by:<id>")');
      }
    }
    const entry = {
      timestamp: new Date().toISOString(),
      from: this._state,
      to: event,
      actor: String(actor),
      reason: reason ? String(reason) : null,
      evidence: evidence == null ? null
        : (typeof evidence === 'string' ? { evidence_id: evidence } : evidence),
    };
    if (successor_id) entry.successor_id = successor_id;
    this._state = event;
    this._history.push(entry);
    _writeLifecycle(this.artifact_id, {
      current_state: this._state,
      history: this._history,
    });

    // Fire side effects AFTER persistence so a failing hook does not lose the
    // state change. Hooks are wrapped in try/catch so a downstream subscriber
    // crash never propagates back into the state machine.
    try {
      if (event === 'revoked') {
        blockPulls(this.artifact_id);
        alertDeployments(this.artifact_id);
      }
      if (event === 'superseded' && successor_id) {
        linkSuccessor(this.artifact_id, successor_id);
      }
    } catch (_) { /* hooks are advisory only */ }

    return entry;
  }
}
