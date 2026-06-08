// src/k8s-readiness.js
//
// W824-2 - In-memory "artifact-loaded" flag consumed by /ready/deep.
//
// Tiny module by design: holds a single boolean (plus the timestamp at which
// it flipped to true) so the k8s readinessProbe can wait for the .kolm
// artifact to actually be loaded + warmed before allowing traffic to land.
//
// Set the flag from anywhere in the runtime once the artifact finishes
// loading (typically the bundle-runner / artifact loader). Tests + the
// runtime boot path both call setArtifactLoaded(true) - this module never
// reaches into the artifact loader itself, keeping the dependency graph
// one-way.
//
// Boot can also signal readiness via the KOLM_ARTIFACT_LOADED env var
// (set to "1" / "true" / "yes" by an external orchestrator that already
// knows the artifact is on disk). isArtifactLoaded() ORs the env var with
// the in-memory flag so either path works.
//
// Honest empty-state: before anyone calls setArtifactLoaded(true) AND the
// env var is unset, isArtifactLoaded() returns false. /ready/deep then
// returns 503 with a structured body explaining the gate.

export const K8S_READINESS_VERSION = 'w824-v1';

let _loaded = false;
let _loadedAtMs = null;
let _reason = null;

function _envFlag() {
  const raw = process.env.KOLM_ARTIFACT_LOADED;
  if (raw == null) return false;
  const s = String(raw).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * Flip the artifact-loaded flag. Idempotent - calling twice with true does
 * not move loaded_at_ms. Calling with false resets the flag (used by the
 * artifact loader on a graceful unload + by tests).
 *
 *   reason - optional short label for diagnostics ("warm_complete",
 *            "hot_swap", "manual"). Surfaced in the /ready/deep envelope.
 */
export function setArtifactLoaded(value, opts = {}) {
  const next = !!value;
  if (next && !_loaded) {
    _loaded = true;
    _loadedAtMs = Date.now();
    _reason = (opts && typeof opts.reason === 'string') ? opts.reason : null;
  } else if (!next) {
    _loaded = false;
    _loadedAtMs = null;
    _reason = (opts && typeof opts.reason === 'string') ? opts.reason : null;
  }
  return _loaded;
}

/**
 * Return true when the .kolm artifact is loaded (either via in-process
 * setArtifactLoaded(true) OR the KOLM_ARTIFACT_LOADED env var).
 */
export function isArtifactLoaded() {
  return _loaded || _envFlag();
}

/**
 * Return the structured snapshot used by /ready/deep - includes the source
 * (memory|env|none) so operators can debug why a probe is hot/cold.
 */
export function readinessSnapshot() {
  const memory = !!_loaded;
  const env = _envFlag();
  const ready = memory || env;
  return {
    version: K8S_READINESS_VERSION,
    artifact_loaded: ready,
    source: ready ? (memory ? 'memory' : 'env') : 'none',
    loaded_at_ms: _loadedAtMs,
    reason: _reason,
  };
}

/**
 * Reset to first-boot state. Tests only - production callers should not
 * use this. Mirrors the convention used by event-store / store / etc.
 */
export function _resetForTests() {
  _loaded = false;
  _loadedAtMs = null;
  _reason = null;
}
