// W739 — `kolm diff <a.kolm> <b.kolm>`.
//
// Real implementation that replaces the W732 honest-placeholder stub. Reads
// two .kolm artifacts (zip archives) by file path, extracts both manifests,
// determines their lineage relationship via the parent_cid chain, computes
// the per-axis performance delta, and returns a single envelope that
// downstream tools (CLI, /v1/artifact/diff, dashboards) can pretty-print
// without re-walking the file.
//
// W739-2: `kolm diff` shows the performance delta + roll-back recommendation.
// The recommendation is one of:
//   * 'roll_back'    — at least one axis regressed by >0.02 between A → B
//   * 'promote'      — every axis improved or stayed unchanged
//   * 'inconclusive' — mixed-but-not-bad-enough-to-roll-back, OR insufficient
//                      data to decide (e.g. one side missing k_score axes)
//
// Honest envelopes:
//   * file_not_found        — either path does not exist on disk
//   * not_a_kolm_artifact   — file is not a valid zip / missing manifest.json
//   * manifest_unreadable   — manifest.json present but did not parse as JSON
//
// Pure file IO + zip read + JSON parse. The compare logic lives in
// src/artifact-lineage.js#compareArtifactPerformance so unit tests can call
// it without touching the disk; this module is the thin wrapper that does
// the file IO and assembles the final envelope.

import fs from 'node:fs';
import { compareArtifactPerformance, LINEAGE_VERSION } from './artifact-lineage.js';

export const KOLM_DIFF_VERSION = 'w739-v1';

// Lazy AdmZip import so a tree that doesn't `kolm diff` does not pay the
// require cost. Mirrors the marketplace.js / artifact-runner.js pattern.
function loadAdmZip() {
  try {
    // eslint-disable-next-line global-require
    return require('adm-zip');
  } catch {
    try {
      // ESM fallback — `await import` is impossible in a sync function, so
      // we use Node's createRequire trick. Callers go through the async
      // _readManifest path which uses `await import` directly.
      return null;
    } catch {
      return null;
    }
  }
}

// Read a manifest from a .kolm archive. Returns
//   { ok:true, manifest, manifest_json } on success
//   { ok:false, error:'...', detail?, path? } on a recoverable failure
async function _readManifest(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { ok: false, error: 'file_path_required', hint: 'pass an absolute path to a .kolm file' };
  }
  if (!fs.existsSync(filePath)) {
    return {
      ok: false,
      error: 'file_not_found',
      path: filePath,
      hint: 'check the path; .kolm artifacts live in ~/.kolm/artifacts by default',
    };
  }
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (e) {
    return {
      ok: false,
      error: 'file_read_failed',
      path: filePath,
      detail: (e && e.message) || String(e),
    };
  }
  // Dynamic import keeps this module ESM-clean.
  let AdmZipMod;
  try {
    AdmZipMod = (await import('adm-zip')).default;
  } catch (e) {
    return {
      ok: false,
      error: 'adm_zip_unavailable',
      detail: (e && e.message) || String(e),
      hint: 'npm install adm-zip',
    };
  }
  let zip;
  try {
    zip = new AdmZipMod(buf);
  } catch (e) {
    return {
      ok: false,
      error: 'not_a_kolm_artifact',
      path: filePath,
      detail: (e && e.message) || String(e),
      hint: 'file is not a valid zip archive (a real .kolm is a zip with manifest.json)',
    };
  }
  const entry = zip.getEntry('manifest.json');
  if (!entry) {
    return {
      ok: false,
      error: 'not_a_kolm_artifact',
      path: filePath,
      hint: 'archive opened but contained no manifest.json entry',
    };
  }
  let manifest_json;
  try {
    manifest_json = entry.getData().toString('utf8');
  } catch (e) {
    return {
      ok: false,
      error: 'manifest_unreadable',
      path: filePath,
      detail: (e && e.message) || String(e),
    };
  }
  let manifest;
  try {
    manifest = JSON.parse(manifest_json);
  } catch (e) {
    return {
      ok: false,
      error: 'manifest_unreadable',
      path: filePath,
      detail: (e && e.message) || String(e),
      hint: 'manifest.json failed to parse as JSON',
    };
  }
  return { ok: true, manifest, manifest_json };
}

// W739-2 — diff two .kolm artifacts by file path. Returns the full envelope
// described at the top of this file. Always exits with ok:true on a successful
// read; the recommendation field carries the operator-actionable verdict so
// CI / dashboards can branch on it without re-implementing the threshold.
export async function diffArtifacts(a_path, b_path) {
  const a_read = await _readManifest(a_path);
  if (!a_read.ok) {
    return { ...a_read, side: 'a', version: KOLM_DIFF_VERSION };
  }
  const b_read = await _readManifest(b_path);
  if (!b_read.ok) {
    return { ...b_read, side: 'b', version: KOLM_DIFF_VERSION };
  }
  return _assembleDiffEnvelope(a_read.manifest, b_read.manifest);
}

// W739-2 / W739-3 — diff two manifests already loaded into memory. The router
// route resolves CIDs → manifests through a tenant-fenced loader and then
// calls this function so the file-IO path stays in the CLI only.
export function diffManifests(a_manifest, b_manifest) {
  if (!a_manifest || typeof a_manifest !== 'object') {
    return { ok: false, error: 'a_manifest_required', side: 'a', version: KOLM_DIFF_VERSION };
  }
  if (!b_manifest || typeof b_manifest !== 'object') {
    return { ok: false, error: 'b_manifest_required', side: 'b', version: KOLM_DIFF_VERSION };
  }
  return _assembleDiffEnvelope(a_manifest, b_manifest);
}

function _assembleDiffEnvelope(a_manifest, b_manifest) {
  const a = _metaFromManifest(a_manifest);
  const b = _metaFromManifest(b_manifest);
  const lineage_relation = _lineageRelation(a_manifest, b_manifest);
  const performance = compareArtifactPerformance(a, b);
  const recommendation = (performance && performance.ok) ? performance.recommendation : 'inconclusive';
  // Roll-back hint — operator-facing, informational. Honest: explains the
  // exact command to pin the prior artifact when the recommendation is
  // roll_back; otherwise points to the kolm verify / kolm score flows.
  let roll_back_hint;
  if (recommendation === 'roll_back') {
    roll_back_hint = `regression detected; pin the prior artifact via \`kolm pin ${a.cid}\` to roll back`;
  } else if (recommendation === 'promote') {
    roll_back_hint = `no regression; safe to promote ${b.cid} as the new production artifact`;
  } else {
    roll_back_hint = `no clear winner; rerun \`kolm score\` against a larger holdout before deciding`;
  }
  return {
    ok: true,
    a: { cid: a.cid, k_score: a.k_score_composite, parent_cid: a.parent_cid },
    b: { cid: b.cid, k_score: b.k_score_composite, parent_cid: b.parent_cid },
    lineage_relation,
    performance,
    recommendation,
    roll_back_hint,
    lineage_version: LINEAGE_VERSION,
    version: KOLM_DIFF_VERSION,
  };
}

function _metaFromManifest(m) {
  const k = (m && m.k_score && typeof m.k_score === 'object') ? m.k_score : null;
  const composite = (k && typeof k.composite === 'number') ? k.composite : null;
  return {
    cid: (m && m.cid) || null,
    parent_cid: (m && typeof m.parent_cid === 'string') ? m.parent_cid : null,
    k_score: k || {},
    k_score_composite: composite,
  };
}

// Determine the relationship between A and B's lineage chains.
//   * descendant   — A.cid is on B's ancestor chain (B descended from A)
//   * ancestor     — B.cid is on A's ancestor chain (A descended from B)
//   * sibling      — A.parent_cid === B.parent_cid (both non-null + equal)
//   * unrelated    — otherwise (including either side missing parent_cid)
//
// We can only look one step up via parent_cid in each manifest — to detect
// deeper ancestor / descendant relations we'd need to walk the chain, which
// requires a loader (handled by walkLineage in artifact-lineage.js). For the
// file-IO diffArtifacts entry point we surface the one-step relation; for the
// router we surface the full chain via the /v1/artifact/lineage route.
function _lineageRelation(a_manifest, b_manifest) {
  const a_cid = a_manifest && a_manifest.cid;
  const b_cid = b_manifest && b_manifest.cid;
  const a_parent = a_manifest && a_manifest.parent_cid;
  const b_parent = b_manifest && b_manifest.parent_cid;
  if (a_cid && b_parent && a_cid === b_parent) return 'descendant';   // B descended from A
  if (b_cid && a_parent && b_cid === a_parent) return 'ancestor';     // A descended from B
  if (a_parent && b_parent && a_parent === b_parent) return 'sibling';
  return 'unrelated';
}

export default {
  KOLM_DIFF_VERSION,
  LINEAGE_VERSION,
  diffArtifacts,
  diffManifests,
};
