// W701 - MoE expert activation analysis + pruning recommendations.
//
// This module reads a local .kolm artifact or artifact directory, consumes the
// cached receipts/router.jsonl trace, and reports per-expert activation plus
// conservative prune candidates. It is advisory only: it never mutates model
// weights and never executes pruning.
//
// Security contract:
//   - CLI callers may analyze any local artifact path they can read.
//   - HTTP callers must pass an allowed artifact root; route responses use
//     safe error codes and never echo host filesystem paths.
//   - Router logs, paths, expert counts, per-row activations, bar widths, and
//     thresholds are bounded before parsing or rendering.
//   - Full analysis envelopes carry analysis_sha256 for audit snapshots.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectArtifact } from './forge-inspect.js';
import { runMoeResidualPrune } from './moe-to-dense.js';

export const EXPERTS_VERSION = 'forge-experts-v1';
export const EXPERTS_CONTRACT_VERSION = 'w701-v1';
export const DEFAULT_PRUNE_THRESHOLD = 0.01;

export const EXPERTS_LIMITS = Object.freeze({
  MAX_ARTIFACT_PATH_CHARS: 1024,
  MAX_ROUTER_LOG_BYTES: 2 * 1024 * 1024,
  MAX_ROUTER_LOG_LINES: 50000,
  MAX_ROUTER_LOG_LINE_BYTES: 64 * 1024,
  MAX_EXPERTS: 4096,
  MAX_EXPERT_ID: 1_000_000,
  MAX_EXPERTS_PER_ROW: 256,
  MAX_BAR_WIDTH: 80,
});

const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const HEX_RE = /^[a-f0-9]{64}$/;

const CLIENT_ERROR_CODES = new Set([
  'experts_artifact_path_required',
  'experts_artifact_path_too_long',
  'experts_artifact_path_control_chars',
  'experts_artifact_path_must_be_local',
  'experts_artifact_path_outside_allowed_root',
  'experts_artifact_not_found',
  'experts_artifact_path_invalid_kind',
  'experts_manifest_missing',
  'experts_manifest_too_large',
  'experts_manifest_invalid',
  'experts_requires_valid_artifact',
  'experts_num_experts_invalid',
  'experts_threshold_invalid',
  'experts_router_log_too_large',
  'experts_router_log_line_too_large',
  'experts_router_log_symlink_rejected',
  'experts_router_log_invalid_kind',
]);

function _error(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function _byteLen(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

function _boundedInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function _round2(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

function _round3(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1000) / 1000;
}

function _canonicalize(value) {
  if (Array.isArray(value)) return value.map((v) => _canonicalize(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = _canonicalize(value[key]);
    return out;
  }
  return value;
}

function _sha256Hex(value) {
  return crypto.createHash('sha256').update(JSON.stringify(_canonicalize(value))).digest('hex');
}

function _withAnalysisHash(envelope) {
  const body = { ...envelope };
  delete body.analysis_sha256;
  return { ...body, analysis_sha256: _sha256Hex(body) };
}

function _pathInside(child, root) {
  const normalizedChild = process.platform === 'win32' ? child.toLowerCase() : child;
  const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root;
  return normalizedChild === normalizedRoot
    || normalizedChild.startsWith(normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep);
}

function _realpathIfExists(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function _allowedRoots(opts = {}) {
  const raw = opts.allowed_roots ?? opts.allowed_root ?? [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .flatMap((entry) => String(entry || '').split(path.delimiter))
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => _realpathIfExists(path.resolve(entry)));
}

export function defaultAllowedArtifactRoots() {
  const roots = [];
  if (process.env.KOLM_EXPERTS_ARTIFACT_ROOT) roots.push(process.env.KOLM_EXPERTS_ARTIFACT_ROOT);
  if (process.env.KOLM_ARTIFACT_DIR) roots.push(process.env.KOLM_ARTIFACT_DIR);
  if (process.env.KOLM_DATA_DIR) roots.push(path.join(process.env.KOLM_DATA_DIR, 'artifacts'));
  roots.push(path.join(os.homedir(), '.kolm', 'artifacts'));
  roots.push(path.join(os.tmpdir(), 'kolm-artifacts'));
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

export function normalizeArtifactPath(artifactPath, opts = {}) {
  if (typeof artifactPath !== 'string') throw _error('experts_artifact_path_required');
  const raw = artifactPath.trim();
  if (!raw) throw _error('experts_artifact_path_required');
  if (raw.length > EXPERTS_LIMITS.MAX_ARTIFACT_PATH_CHARS) throw _error('experts_artifact_path_too_long');
  if (CONTROL_RE.test(raw)) throw _error('experts_artifact_path_control_chars');
  if (URL_SCHEME_RE.test(raw)) throw _error('experts_artifact_path_must_be_local');

  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved)) throw _error('experts_artifact_not_found');

  const real = _realpathIfExists(resolved);
  const roots = _allowedRoots(opts);
  if (roots.length > 0 && !roots.some((root) => _pathInside(real, root))) {
    throw _error('experts_artifact_path_outside_allowed_root');
  }

  const st = fs.statSync(real);
  if (!st.isDirectory() && !real.toLowerCase().endsWith('.kolm')) {
    throw _error('experts_artifact_path_invalid_kind');
  }
  return {
    path: real,
    artifact_dir: st.isDirectory() ? real : path.dirname(real),
    is_directory: st.isDirectory(),
  };
}

function _readJsonFileBounded(filePath, codePrefix) {
  if (!fs.existsSync(filePath)) throw _error(`${codePrefix}_missing`);
  const st = fs.statSync(filePath);
  if (!st.isFile()) throw _error(`${codePrefix}_invalid`);
  if (st.size > EXPERTS_LIMITS.MAX_ROUTER_LOG_BYTES) throw _error(`${codePrefix}_too_large`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw _error(`${codePrefix}_invalid`);
  }
}

function _inspectDirectoryManifest(artifactDir) {
  const manifest = _readJsonFileBounded(path.join(artifactDir, 'manifest.json'), 'experts_manifest');
  const moe = manifest && typeof manifest === 'object' ? manifest.moe : null;
  const experts = Array.isArray(moe && moe.experts) ? moe.experts : [];
  const numExperts = manifest.num_experts ?? manifest.n_routed_experts ?? experts.length;
  const topK = manifest.num_experts_per_tok
    ?? manifest.n_activated_experts
    ?? (moe && (moe.num_experts_per_tok ?? moe.top_k))
    ?? null;
  return {
    source: 'local_artifact_directory',
    job_id: manifest.job_id || null,
    artifact_class: manifest.artifact_class || null,
    is_moe: Boolean(manifest.is_moe || experts.length > 1 || Number(numExperts) > 1),
    num_experts: numExperts,
    num_experts_per_tok: topK,
    forge_inspect_version: 'forge-experts-directory-manifest-v1',
  };
}

async function _inspectArtifactProfile(safePath, opts = {}) {
  try {
    if (typeof opts.inspectArtifact === 'function') {
      return await opts.inspectArtifact(safePath.path, { artifact_dir: safePath.artifact_dir });
    }
    if (safePath.is_directory) return _inspectDirectoryManifest(safePath.path);
    return await inspectArtifact(safePath.path);
  } catch {
    throw _error('experts_requires_valid_artifact');
  }
}

function _normalizeThreshold(value) {
  const threshold = value == null ? DEFAULT_PRUNE_THRESHOLD : Number(value);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw _error('experts_threshold_invalid');
  }
  return threshold;
}

function _normalizeNumExperts(inspected) {
  const raw = inspected?.num_experts
    ?? inspected?.n_routed_experts
    ?? (Array.isArray(inspected?.moe?.experts) ? inspected.moe.experts.length : null);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 2 || n > EXPERTS_LIMITS.MAX_EXPERTS) {
    throw _error('experts_num_experts_invalid');
  }
  return n;
}

function _normalizeTopK(inspected) {
  const raw = inspected?.num_experts_per_tok
    ?? inspected?.n_activated_experts
    ?? inspected?.moe?.top_k
    ?? inspected?.moe?.num_experts_per_tok;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n <= EXPERTS_LIMITS.MAX_EXPERTS ? n : null;
}

function _normalizeExpertId(value) {
  if (typeof value === 'string' && /^\d{1,9}$/.test(value)) value = Number(value);
  if (!Number.isInteger(value) || value < 0 || value > EXPERTS_LIMITS.MAX_EXPERT_ID) return null;
  return value;
}

function _extractExpertIds(record) {
  if (!record || typeof record !== 'object') return [];
  if (Array.isArray(record.experts_activated)) return record.experts_activated;
  if (Array.isArray(record.experts)) return record.experts;
  if (Array.isArray(record.expert_ids)) return record.expert_ids;
  if (Array.isArray(record.activations)) {
    return record.activations.map((row) => {
      if (row && typeof row === 'object') return row.expert_id ?? row.id;
      return row;
    });
  }
  if (record.expert_id != null) return [record.expert_id];
  return [];
}

export function readCachedRouterDecisions(artifactDir, opts = {}) {
  const routerLog = path.join(path.resolve(artifactDir), 'receipts', 'router.jsonl');
  if (!fs.existsSync(routerLog)) return null;

  const lst = fs.lstatSync(routerLog);
  if (lst.isSymbolicLink()) throw _error('experts_router_log_symlink_rejected');
  if (!lst.isFile()) throw _error('experts_router_log_invalid_kind');

  const maxBytes = _boundedInt(
    opts.max_router_log_bytes,
    EXPERTS_LIMITS.MAX_ROUTER_LOG_BYTES,
    1,
    EXPERTS_LIMITS.MAX_ROUTER_LOG_BYTES,
  );
  if (lst.size > maxBytes) throw _error('experts_router_log_too_large');

  const text = fs.readFileSync(routerLog, 'utf8');
  const rawLines = text.split(/\r?\n/);
  const maxLines = _boundedInt(
    opts.max_router_log_lines,
    EXPERTS_LIMITS.MAX_ROUTER_LOG_LINES,
    1,
    EXPERTS_LIMITS.MAX_ROUTER_LOG_LINES,
  );
  const numExperts = opts.num_experts == null ? null : Number(opts.num_experts);
  const counts = new Map();
  const summary = {
    router_log_present: true,
    lines_seen: 0,
    lines_capped: rawLines.length > maxLines,
    malformed_lines: 0,
    skipped_invalid_ids: 0,
    skipped_out_of_range_ids: 0,
    skipped_duplicate_ids: 0,
    skipped_too_long_lines: 0,
    valid_activations: 0,
  };

  for (const line of rawLines.slice(0, maxLines)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    summary.lines_seen += 1;
    if (_byteLen(trimmed) > EXPERTS_LIMITS.MAX_ROUTER_LOG_LINE_BYTES) {
      summary.skipped_too_long_lines += 1;
      continue;
    }
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      summary.malformed_lines += 1;
      continue;
    }
    const ids = _extractExpertIds(record).slice(0, EXPERTS_LIMITS.MAX_EXPERTS_PER_ROW);
    const seenInRow = new Set();
    for (const rawId of ids) {
      const expertId = _normalizeExpertId(rawId);
      if (expertId == null) {
        summary.skipped_invalid_ids += 1;
        continue;
      }
      if (Number.isInteger(numExperts) && expertId >= numExperts) {
        summary.skipped_out_of_range_ids += 1;
        continue;
      }
      if (seenInRow.has(expertId)) {
        summary.skipped_duplicate_ids += 1;
        continue;
      }
      seenInRow.add(expertId);
      counts.set(expertId, (counts.get(expertId) || 0) + 1);
      summary.valid_activations += 1;
    }
  }

  return {
    counts: [...counts.entries()]
      .map(([expert_id, count]) => ({ expert_id, count }))
      .sort((a, b) => a.expert_id - b.expert_id),
    summary,
  };
}

export async function analyzeExperts(artifactPath, opts = {}) {
  const threshold = _normalizeThreshold(opts.threshold);
  const safePath = normalizeArtifactPath(artifactPath, opts);
  const inspected = await _inspectArtifactProfile(safePath, opts);

  if (!inspected.is_moe) {
    return _withAnalysisHash({
      is_moe: false,
      reason: 'artifact_is_dense_not_moe',
      hint: 'use kolm inspect to see architecture',
      forge_experts_version: EXPERTS_VERSION,
      contract_version: EXPERTS_CONTRACT_VERSION,
    });
  }

  const numExperts = _normalizeNumExperts(inspected);
  const numExpertsPerTok = _normalizeTopK(inspected);
  const cached = readCachedRouterDecisions(safePath.artifact_dir, {
    ...opts,
    num_experts: numExperts,
  });

  if (!cached) {
    return _withAnalysisHash({
      is_moe: true,
      num_experts: numExperts,
      num_experts_per_tok: numExpertsPerTok,
      reason: 'no_cached_router_decisions',
      hint: 'no receipts/router.jsonl in artifact dir. Re-run kolm verify with --capture-router to generate.',
      forge_experts_version: EXPERTS_VERSION,
      contract_version: EXPERTS_CONTRACT_VERSION,
    });
  }

  const totalDecisions = cached.counts.reduce((sum, row) => sum + row.count, 0);
  if (totalDecisions <= 0) {
    return _withAnalysisHash({
      is_moe: true,
      num_experts: numExperts,
      num_experts_per_tok: numExpertsPerTok,
      reason: 'no_valid_router_decisions',
      hint: 'receipts/router.jsonl was present but did not contain valid expert activation IDs.',
      router_decision_summary: cached.summary,
      forge_experts_version: EXPERTS_VERSION,
      contract_version: EXPERTS_CONTRACT_VERSION,
    });
  }

  const countsMap = new Map(cached.counts.map((row) => [row.expert_id, row.count]));
  const expert_activations = [];
  for (let expertId = 0; expertId < numExperts; expertId += 1) {
    const count = countsMap.get(expertId) || 0;
    expert_activations.push({
      expert_id: expertId,
      count,
      pct: _round2((count / totalDecisions) * 100),
    });
  }

  const prune_candidates = expert_activations.filter((row) => (row.pct / 100) < threshold);
  const pruned_size_pct_reduction = _round2((prune_candidates.length / numExperts) * 0.55 * 100);
  const prunedPctSum = prune_candidates.reduce((sum, row) => sum + row.pct, 0);
  const estimated_kscore_impact = Math.min(_round3((prunedPctSum / 100) * 1.5), 0.05);

  return _withAnalysisHash({
    is_moe: true,
    num_experts: numExperts,
    num_experts_per_tok: numExpertsPerTok,
    total_decisions: totalDecisions,
    expert_activations,
    prune_candidates,
    prune_threshold: threshold,
    pruned_size_pct_reduction,
    estimated_kscore_impact,
    source: 'cached_router_decisions',
    router_decision_summary: cached.summary,
    forge_experts_version: EXPERTS_VERSION,
    contract_version: EXPERTS_CONTRACT_VERSION,
  });
}

export async function executeExpertPrune(artifactPath, opts = {}) {
  const threshold = _normalizeThreshold(opts.threshold);
  const safePath = normalizeArtifactPath(artifactPath, opts);
  const analysis = opts.analysis || await analyzeExperts(safePath.path, { ...opts, threshold });
  if (!analysis.is_moe) {
    return _withAnalysisHash({
      ok: false,
      kind: 'expert_prune_execution',
      reason: analysis.reason || 'artifact_is_dense_not_moe',
      analysis,
      forge_experts_version: EXPERTS_VERSION,
      contract_version: EXPERTS_CONTRACT_VERSION,
    });
  }
  if (!Array.isArray(analysis.expert_activations)) {
    return _withAnalysisHash({
      ok: false,
      kind: 'expert_prune_execution',
      reason: analysis.reason || 'no_expert_activation_table',
      analysis,
      forge_experts_version: EXPERTS_VERSION,
      contract_version: EXPERTS_CONTRACT_VERSION,
    });
  }
  const pruneIds = new Set((analysis.prune_candidates || []).map((row) => Number(row.expert_id)));
  const keepExpertIds = analysis.expert_activations
    .map((row) => Number(row.expert_id))
    .filter((eid) => Number.isInteger(eid) && !pruneIds.has(eid));
  const checkpointPath = opts.checkpoint_path || opts.checkpointPath;
  const routerStatsPath = opts.router_stats_path || opts.routerStatsPath
    || path.join(safePath.artifact_dir, 'receipts', 'router.jsonl');
  const outDir = opts.out_dir || opts.outDir
    || path.join(os.tmpdir(), `kolm-pruned-moe-${Date.now()}`);
  const prune = runMoeResidualPrune({
    checkpointPath,
    routerStatsPath,
    outDir,
    keepExpertIds,
    pruneThreshold: threshold,
    minKeepExperts: opts.min_keep_experts || opts.minKeepExperts || 1,
    dryRun: Boolean(opts.dry_run || opts.dryRun),
    timeoutMs: opts.timeout_ms || opts.timeoutMs || 60 * 60 * 1000,
  });
  return _withAnalysisHash({
    ok: prune.ok === true,
    kind: 'expert_prune_execution',
    threshold,
    planned_keep_expert_ids: keepExpertIds,
    planned_prune_expert_ids: [...pruneIds].sort((a, b) => a - b),
    source_analysis_sha256: analysis.analysis_sha256,
    prune,
    forge_experts_version: EXPERTS_VERSION,
    contract_version: EXPERTS_CONTRACT_VERSION,
  });
}

export function renderActivationBars(analysis, opts = {}) {
  if (!analysis || !analysis.is_moe || !Array.isArray(analysis.expert_activations)) {
    return (analysis && analysis.hint) || 'no_moe_data';
  }
  const width = _boundedInt(opts.width, 20, 1, EXPERTS_LIMITS.MAX_BAR_WIDTH);
  const maxPct = Math.max(...analysis.expert_activations.map((row) => Number(row.pct) || 0), 1);
  const pruneIds = new Set(
    Array.isArray(analysis.prune_candidates)
      ? analysis.prune_candidates.map((row) => row.expert_id)
      : [],
  );
  const lines = [];
  for (const row of analysis.expert_activations) {
    const pct = Number(row.pct) || 0;
    const filled = Math.max(0, Math.min(width, Math.round((pct / maxPct) * width)));
    const bar = '#'.repeat(filled) + '-'.repeat(width - filled);
    const prune = pruneIds.has(row.expert_id) ? '  prune?' : '';
    lines.push(`  Expert ${String(row.expert_id).padStart(3)}  ${bar}  ${pct.toFixed(1)}%${prune}`);
  }
  return lines.join('\n');
}

export function safeExpertError(error) {
  const code = String(error && (error.code || error.message) || 'experts_analysis_failed');
  if (CLIENT_ERROR_CODES.has(code)) return code;
  const match = code.match(/\bexperts_[a-z0-9_]+\b/);
  if (match && CLIENT_ERROR_CODES.has(match[0])) return match[0];
  return 'experts_analysis_failed';
}

export function expertErrorStatus(error) {
  const code = safeExpertError(error);
  return CLIENT_ERROR_CODES.has(code) ? 400 : 500;
}

export const _internal = {
  CLIENT_ERROR_CODES,
  HEX_RE,
  _inspectDirectoryManifest,
  _normalizeExpertId,
  _normalizeThreshold,
  _pathInside,
};

export default {
  EXPERTS_VERSION,
  EXPERTS_CONTRACT_VERSION,
  DEFAULT_PRUNE_THRESHOLD,
  EXPERTS_LIMITS,
  analyzeExperts,
  executeExpertPrune,
  defaultAllowedArtifactRoots,
  expertErrorStatus,
  normalizeArtifactPath,
  readCachedRouterDecisions,
  renderActivationBars,
  safeExpertError,
};
