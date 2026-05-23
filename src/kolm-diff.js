// W732-4 — `kolm diff <a.kolm> <b.kolm>` slot.
//
// This module is a HONEST PLACEHOLDER for the real diff that W739 will ship.
// The W707 plan splits artifact comparison out of W732 because a useful diff
// has to cross-walk:
//
//   - manifest fields (recipe_id, recipe_version, kscore_*, _ax bands, signer)
//   - the per-row eval grids inside `evaluation/`
//   - any embedded LoRA / merged-weights deltas (sizes, sha256, dtype)
//   - the spec.json schema (added/removed fields, type drift)
//
// W732 ships this stub so:
//
//   1. `kolm diff <a> <b>` has an honest envelope today (no silent fall-through
//      to a misleading default) — operators see `w739_not_shipped` + a hint
//      that points at the same-day workaround (manual manifest comparison).
//   2. W739 has a fixed override slot: when the real diff ships it replaces
//      `diffArtifacts` in this module; callers and tests stay stable.
//
// We DO NOT expose a fake diff or partial diff. The plan explicitly forbids
// "cheap diff that lies about coverage" — better to return ok:false than to
// pretend coverage we don't have.

export const KOLM_DIFF_VERSION = 'w732-v1-stub-awaiting-w739';

export function diffArtifacts(_aPath, _bPath) {
  return {
    ok: false,
    error: 'w739_not_shipped',
    version: KOLM_DIFF_VERSION,
    hint: 'W739 ships `kolm diff`; for now, compare manifest fields manually with `kolm inspect <a.kolm>` and `kolm inspect <b.kolm>`',
  };
}
