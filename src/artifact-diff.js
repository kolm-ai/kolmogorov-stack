// W820-5 — `kolm diff <a.kolm> <b.kolm>` quality-delta CLI command.
//
// Companion to src/kolm-diff.js (W739). The W739 envelope answers the
// "should I roll back?" question via lineage_relation + performance + a
// roll-back recommendation. W820 layers a SIDE-BY-SIDE FIELD DELTA on top
// so CI tooling can render a friendly "what changed?" table without having
// to interpret the W739 performance block.
//
// Fields surfaced (per W820 spec):
//   - k_score          (left vs right + signed delta)
//   - capture_count    (left vs right + signed delta)
//   - teacher          (same | changed)
//   - student_arch     (same | changed)
//   - param_count      (left vs right + signed delta)
//   - bench_pass_rate  (left vs right + signed delta)
//   - signed           (yes | no per side)
//
// Honest fallback: when a manifest does not carry a particular field
// (older artifacts, optional W820 fields not yet wired by the build), the
// per-row left/right value is `null` and the delta is `null`. We NEVER
// fabricate a zero delta from two nulls — that would silently claim "no
// regression" when in fact we have no signal.
//
// File IO + zip-read is delegated to src/kolm-diff.js so we never
// re-implement zip parsing. This module is pure-compute on parsed manifests.

import fs from 'node:fs';

export const ARTIFACT_DIFF_VERSION = 'w820-v1';

// ----------------------------------------------------------------------------
// _readManifest — duplicated thin wrapper around src/kolm-diff.js's private
// reader. We avoid importing the private function (it isn't exported) and
// instead reimplement the same minimal contract here so W820 stays
// independently testable + W739's internal can evolve without breaking us.
// ----------------------------------------------------------------------------
async function _readManifest(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { ok: false, error: 'file_path_required' };
  }
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: 'artifact_not_found', path: filePath };
  }
  let buf;
  try {
    buf = fs.readFileSync(filePath);
  } catch (e) {
    return { ok: false, error: 'file_read_failed', path: filePath, detail: (e && e.message) || String(e) };
  }
  let AdmZipMod;
  try {
    AdmZipMod = (await import('adm-zip')).default;
  } catch (e) {
    return { ok: false, error: 'adm_zip_unavailable', detail: (e && e.message) || String(e) };
  }
  let zip;
  try {
    zip = new AdmZipMod(buf);
  } catch (e) {
    return { ok: false, error: 'not_a_kolm_artifact', path: filePath, detail: (e && e.message) || String(e) };
  }
  const entry = zip.getEntry('manifest.json');
  if (!entry) {
    return { ok: false, error: 'not_a_kolm_artifact', path: filePath, hint: 'archive contained no manifest.json entry' };
  }
  let receipt = null;
  const receiptEntry = zip.getEntry('receipt.json');
  if (receiptEntry) {
    try { receipt = JSON.parse(receiptEntry.getData().toString('utf8')); } catch { receipt = null; }
  }
  let manifest;
  try {
    manifest = JSON.parse(entry.getData().toString('utf8'));
  } catch (e) {
    return { ok: false, error: 'manifest_unreadable', path: filePath, detail: (e && e.message) || String(e) };
  }
  return { ok: true, manifest, receipt };
}

// ----------------------------------------------------------------------------
// Extract a normalized per-axis snapshot from a manifest + receipt. Every
// field is OPTIONAL — when absent we return null so the diff can mark the
// row "no signal". The reader supports several historical key locations
// because the manifest schema has evolved across waves.
// ----------------------------------------------------------------------------
export function extractSnapshot(manifest, receipt) {
  if (!manifest || typeof manifest !== 'object') return null;
  const k = (manifest.k_score && typeof manifest.k_score === 'object') ? manifest.k_score : null;
  // k_score: prefer .composite, fall back to .point, fall back to a top-level
  // number (very old artifacts). Round to 6 decimal places to keep deltas
  // human-readable; the underlying number is preserved upstream.
  let kscore = null;
  if (k && typeof k.composite === 'number') kscore = k.composite;
  else if (k && typeof k.point === 'number') kscore = k.point;
  else if (typeof manifest.k_score === 'number') kscore = manifest.k_score;
  // capture_count — surfaced by spec-compile when present. Fallback to
  // recipes_count for older spec-only artifacts.
  const capture_count = _firstNumber([
    manifest.capture_count,
    manifest.training_stats && manifest.training_stats.capture_count,
    manifest.training_stats && manifest.training_stats.n_captures,
  ]);
  // teacher: model id used during distillation.
  const teacher = _firstString([
    manifest.teacher_id,
    manifest.teacher,
    manifest.teacher_model,
    manifest.training_stats && manifest.training_stats.teacher_id,
  ]);
  // student_arch: target student architecture.
  const student_arch = _firstString([
    manifest.student_arch,
    manifest.student,
    manifest.student_model,
    manifest.base_model,
    manifest.training_stats && manifest.training_stats.student_arch,
  ]);
  // param_count: total trainable parameters in the student (or the
  // base model when the student is just LoRA on top).
  const param_count = _firstNumber([
    manifest.param_count,
    manifest.training_stats && manifest.training_stats.param_count,
    manifest.training_stats && manifest.training_stats.n_params,
  ]);
  // bench_pass_rate: fraction of bench cases that passed (range [0, 1]).
  const bench_pass_rate = _firstNumber([
    manifest.bench_pass_rate,
    manifest.training_stats && manifest.training_stats.bench_pass_rate,
    manifest.evals && manifest.evals.pass_rate,
  ]);
  // signed: true when the artifact carries an Ed25519/HMAC signature; false
  // when explicitly unsigned; null when undeterminable. The receipt block
  // carries the signed_at timestamp; the manifest carries the policy flag.
  let signed = null;
  if (receipt && typeof receipt.signed_at === 'string' && receipt.signed_at.length > 0) {
    signed = true;
  } else if (manifest.policy && typeof manifest.policy.require_ed25519 === 'boolean') {
    // policy.require_ed25519 means "this artifact MUST be signed". An
    // unsigned artifact would not have been built when that flag was true,
    // so we treat the policy claim as the signed state in absence of a
    // receipt entry.
    signed = !!manifest.policy.require_ed25519;
  } else if (manifest.signature || (manifest.hashes && manifest.hashes.signature_sig)) {
    signed = true;
  }
  return {
    k_score: kscore,
    capture_count,
    teacher,
    student_arch,
    param_count,
    bench_pass_rate,
    signed,
  };
}

function _firstNumber(candidates) {
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c;
  }
  return null;
}

function _firstString(candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return null;
}

// ----------------------------------------------------------------------------
// Build a per-row delta record. Each row carries:
//   { field, left, right, delta, changed, kind }
// kind is one of:
//   'numeric'  — left + right + signed delta
//   'string'   — left + right + changed boolean (no numeric delta)
//   'boolean'  — left + right + changed boolean (signed_at / signed)
//
// When either side is null, delta is null. changed is set only when we
// have signal on BOTH sides; otherwise changed === null (= "no signal").
// ----------------------------------------------------------------------------
function _numericRow(field, a, b) {
  const left = (typeof a === 'number') ? a : null;
  const right = (typeof b === 'number') ? b : null;
  let delta = null;
  let changed = null;
  if (left !== null && right !== null) {
    delta = Number((right - left).toFixed(6));
    changed = delta !== 0;
  }
  return { field, left, right, delta, changed, kind: 'numeric' };
}

function _stringRow(field, a, b) {
  const left = (typeof a === 'string') ? a : null;
  const right = (typeof b === 'string') ? b : null;
  let changed = null;
  if (left !== null && right !== null) changed = left !== right;
  return { field, left, right, delta: null, changed, kind: 'string' };
}

function _boolRow(field, a, b) {
  const left = (typeof a === 'boolean') ? a : null;
  const right = (typeof b === 'boolean') ? b : null;
  let changed = null;
  if (left !== null && right !== null) changed = left !== right;
  return { field, left, right, delta: null, changed, kind: 'boolean' };
}

export function diffSnapshots(left_snap, right_snap) {
  if (!left_snap || !right_snap) {
    return { ok: false, error: 'snapshot_required' };
  }
  const rows = [
    _numericRow('k_score',         left_snap.k_score,         right_snap.k_score),
    _numericRow('capture_count',   left_snap.capture_count,   right_snap.capture_count),
    _stringRow ('teacher',         left_snap.teacher,         right_snap.teacher),
    _stringRow ('student_arch',    left_snap.student_arch,    right_snap.student_arch),
    _numericRow('param_count',     left_snap.param_count,     right_snap.param_count),
    _numericRow('bench_pass_rate', left_snap.bench_pass_rate, right_snap.bench_pass_rate),
    _boolRow   ('signed',          left_snap.signed,          right_snap.signed),
  ];
  const changed_count = rows.filter(r => r.changed === true).length;
  // Roll-up verdict — purely a hint, not a CI gate. The K-Score row is the
  // primary signal; an axis regression on bench_pass_rate is also flagged.
  const k_row = rows.find(r => r.field === 'k_score');
  const bench_row = rows.find(r => r.field === 'bench_pass_rate');
  let verdict = 'no_signal';
  if (k_row.changed === true && k_row.delta < 0) verdict = 'k_score_regression';
  else if (bench_row.changed === true && bench_row.delta < 0) verdict = 'bench_regression';
  else if (k_row.changed === true && k_row.delta > 0) verdict = 'k_score_improvement';
  else if (changed_count === 0) verdict = 'identical';
  else verdict = 'changed_no_regression';
  return {
    ok: true,
    rows,
    changed_count,
    verdict,
    version: ARTIFACT_DIFF_VERSION,
  };
}

// ----------------------------------------------------------------------------
// Public: diff two .kolm artifacts by path. Returns the structured envelope
// the CLI prints (with --json) or pretty-prints (without). Missing files
// surface as {ok:false, error:'artifact_not_found', path}; the caller
// branches on that to exit non-zero.
// ----------------------------------------------------------------------------
export async function diffArtifactPaths(a_path, b_path) {
  const a_read = await _readManifest(a_path);
  if (!a_read.ok) return { ok: false, error: a_read.error, side: 'left', path: a_read.path || a_path, detail: a_read.detail, version: ARTIFACT_DIFF_VERSION };
  const b_read = await _readManifest(b_path);
  if (!b_read.ok) return { ok: false, error: b_read.error, side: 'right', path: b_read.path || b_path, detail: b_read.detail, version: ARTIFACT_DIFF_VERSION };
  const left_snap = extractSnapshot(a_read.manifest, a_read.receipt);
  const right_snap = extractSnapshot(b_read.manifest, b_read.receipt);
  const diff = diffSnapshots(left_snap, right_snap);
  return {
    ok: true,
    left: { path: a_path, ...left_snap, cid: a_read.manifest.cid || null },
    right: { path: b_path, ...right_snap, cid: b_read.manifest.cid || null },
    diff,
    version: ARTIFACT_DIFF_VERSION,
  };
}

// ----------------------------------------------------------------------------
// Pretty-printer. Uses simple ANSI escapes when stdout is a TTY; falls back
// to plain text otherwise. Returns a string the CLI prints to stdout.
//
// Format:
//   field            left         right        delta
//   ---------------- ------------ ------------ ----------
//   k_score          0.8731       0.8612       -0.0119 ▼
//   capture_count    12450        12450         0
//   teacher          claude-...   claude-...   same
//   student_arch     qwen2.5-7b   qwen2.5-7b   same
//   param_count      7240000000   7240000000    0
//   bench_pass_rate  0.95         0.92         -0.03 ▼
//   signed           true         true         same
//
//   verdict: k_score_regression  (k_score dropped by 0.0119)
// ----------------------------------------------------------------------------
export function formatDiffText(envelope, opts = {}) {
  if (!envelope || envelope.ok !== true) {
    if (envelope && envelope.error) {
      return `kolm diff: ${envelope.error}${envelope.path ? ' (' + envelope.path + ')' : ''}`;
    }
    return 'kolm diff: unknown_error';
  }
  const useColor = opts.color !== false && (process.stdout && process.stdout.isTTY);
  const RED   = useColor ? '\x1b[31m' : '';
  const GREEN = useColor ? '\x1b[32m' : '';
  const DIM   = useColor ? '\x1b[2m'  : '';
  const RESET = useColor ? '\x1b[0m'  : '';
  const lines = [];
  lines.push('field            left            right           delta');
  lines.push('---------------- --------------- --------------- ----------');
  for (const row of envelope.diff.rows) {
    const lv = _formatCell(row.left);
    const rv = _formatCell(row.right);
    let dv = '';
    if (row.kind === 'numeric') {
      if (row.delta === null) dv = `${DIM}no_signal${RESET}`;
      else if (row.delta === 0) dv = '0';
      else if (row.delta > 0) dv = `${GREEN}+${row.delta} ${useColor ? '▲' : '^'}${RESET}`;
      else dv = `${RED}${row.delta} ${useColor ? '▼' : 'v'}${RESET}`;
    } else if (row.kind === 'string' || row.kind === 'boolean') {
      if (row.changed === null) dv = `${DIM}no_signal${RESET}`;
      else if (row.changed) dv = `${RED}changed${RESET}`;
      else dv = 'same';
    }
    lines.push(`${row.field.padEnd(16)} ${String(lv).padEnd(15)} ${String(rv).padEnd(15)} ${dv}`);
  }
  lines.push('');
  lines.push(`verdict: ${envelope.diff.verdict}  (changed_count=${envelope.diff.changed_count})`);
  return lines.join('\n');
}

function _formatCell(v) {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'number') {
    // Compact representation: integers as-is, floats trimmed to 4 places.
    if (Number.isInteger(v)) return String(v);
    return String(Number(v.toFixed(4)));
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = String(v);
  return s.length > 15 ? s.slice(0, 12) + '...' : s;
}

export default {
  ARTIFACT_DIFF_VERSION,
  extractSnapshot,
  diffSnapshots,
  diffArtifactPaths,
  formatDiffText,
};
