// W756 - KolmBench v1 public spec + leaderboard.
//
// Ships the four deliverables from KOLM_W707_SYSTEM_UPGRADE_PLAN.md
// lines 521-526:
//
//   [W756-1] Public KolmBench v1 spec (frozen object exported here, surfaced
//            at /bench/kolmbench-v1.html and GET /v1/kolmbench/spec)
//   [W756-2] Public leaderboard JSON (read/write helpers below; the file
//            itself lives at public/bench/leaderboard.json so it's served as a
//            static asset and CDN-cacheable for unauthenticated viewers)
//   [W756-3] Submission CI workflow (.github/workflows/kolmbench-submission.yml
//            calls validateSubmission() against rows in PR-added submissions/*)
//   [W756-4] Curated most-challenging-captures seed dataset placeholder. This
//            is HONEST: getV2SeedTaskCandidates returns an
//            ok:false/error:'kolmbench_v2_consent_pipeline_not_shipped'
//            envelope until W757 (cross-namespace lake) AND W766 (consent
//            toolkit) land. We never silently fake a v2 seed dataset.
//
// Honesty contract (W604/W460/W411 laws):
//   - validateSubmission returns stable snake_case error codes - every
//     mismatch maps to stable snake_case codes such as submission_empty,
//     too_many_rows, missing_task_id, missing_response, response_too_large,
//     unknown_task_id, duplicate_task_id, and invalid_artifact_cid_format.
//     Tests pin every code.
//   - scoreSubmission is a pure stub that returns null k_score with a
//     reason:'kolmbench_v1_scoring_offline_pending_pack' so a caller cannot
//     conflate "we accepted your submission" with "we auto-graded you".
//   - appendLeaderboardEntry sets verified:false unless an Ed25519 receipt
//     lives under the controlled receipt root AND an explicit verifier hook
//     accepts its hash. The reviewer-bot wave (W807) owns that verifier.
//     NEVER paint verified:true from user-supplied bytes or arbitrary paths.
//   - readLeaderboard / appendLeaderboardEntry write atomically (tmp+rename
//     pattern) so concurrent submissions cannot leave the file half-written.
//
// Tenant-fenced access: this module reads ONLY the static
// public/bench/leaderboard.json file plus pure-compute helpers. Any future
// event-store read MUST go through findByTenant + defense-in-depth, but the
// current surface intentionally has zero per-tenant state - the leaderboard
// is a global, deliberately-curated public artifact.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findByTenant } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const LEADERBOARD_PATH = path.join(REPO_ROOT, 'public', 'bench', 'leaderboard.json');
const RECEIPT_ROOT = path.join(REPO_ROOT, 'public', 'bench', 'receipts');

export const KOLMBENCH_VERSION = 'w756-v2';
export const KOLMBENCH_LEADERBOARD_PATH = LEADERBOARD_PATH;
export const KOLMBENCH_RECEIPT_ROOT = RECEIPT_ROOT;
export const KOLMBENCH_LIMITS = Object.freeze({
  MAX_ROWS: 64,
  MAX_RESPONSE_CHARS: 20000,
  MAX_MODEL_CHARS: 160,
  MAX_SUBMITTER_CHARS: 160,
  MAX_SOURCE_REPO_CHARS: 512,
  MAX_AXIS_KEYS: 32,
  MAX_AXIS_NAME_CHARS: 64,
  MAX_LEADERBOARD_ENTRIES: 500,
  MAX_LEADERBOARD_BYTES: 2 * 1024 * 1024,
  MAX_RECEIPT_BYTES: 256 * 1024,
  MAX_PATH_CHARS: 2048,
  MAX_ERROR_CHARS: 512,
});

const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

function _sha256Hex(value) {
  return crypto.createHash('sha256').update(value == null ? '' : value).digest('hex');
}

function _stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map((v) => _stableJson(v)).join(',') + ']';
  return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + _stableJson(value[k])).join(',') + '}';
}

function _cleanText(value, max = KOLMBENCH_LIMITS.MAX_ERROR_CHARS) {
  return String(value == null ? '' : value).replace(CONTROL_RE, ' ').trim().slice(0, max);
}

function _rawBoundedString(value, max) {
  return typeof value === 'string' && value.length <= max ? value : null;
}

function _resolveJsonPath(customPath, fallbackPath) {
  const raw = customPath || fallbackPath;
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: 'invalid_path', detail: 'path must be a non-empty string' };
  }
  if (raw.length > KOLMBENCH_LIMITS.MAX_PATH_CHARS || CONTROL_RE.test(raw)) {
    CONTROL_RE.lastIndex = 0;
    return { ok: false, error: 'invalid_path', detail: 'path contains control characters or is too long' };
  }
  if (!/\.json$/i.test(raw)) {
    return { ok: false, error: 'invalid_path', detail: 'leaderboard path must end in .json' };
  }
  return { ok: true, path: path.resolve(raw) };
}

function _taskSetSha() {
  return _sha256Hex(_stableJson(AUTHORITATIVE_TASKS));
}

function _normalizeSubmissionEvidence(rows) {
  const evidenceRows = [];
  if (!Array.isArray(rows)) return evidenceRows;
  for (let i = 0; i < Math.min(rows.length, KOLMBENCH_LIMITS.MAX_ROWS); i++) {
    const row = rows[i] || {};
    const taskId = typeof row.task_id === 'string' ? _cleanText(row.task_id, 128) : null;
    const response = typeof row.response === 'string' ? row.response.slice(0, KOLMBENCH_LIMITS.MAX_RESPONSE_CHARS) : '';
    evidenceRows.push({
      row_index: i,
      task_id: taskId,
      response_sha256: typeof row.response === 'string' ? _sha256Hex(response) : null,
      response_chars: typeof row.response === 'string' ? row.response.length : 0,
      model_sha256: typeof row.model === 'string' ? _sha256Hex(_cleanText(row.model, KOLMBENCH_LIMITS.MAX_MODEL_CHARS)) : null,
      artifact_cid_or_null: typeof row.artifact_cid_or_null === 'string' ? _cleanText(row.artifact_cid_or_null, 96) : null,
    });
  }
  return evidenceRows;
}

function _submissionSha(rows) {
  return _sha256Hex(_stableJson({
    version: KOLMBENCH_VERSION,
    task_set_sha256: _taskSetSha(),
    rows: _normalizeSubmissionEvidence(rows),
  }));
}

function _sanitizeAxes(kAxes) {
  if (kAxes == null) return { ok: true, value: null };
  if (!kAxes || typeof kAxes !== 'object' || Array.isArray(kAxes)) {
    return { ok: false, error: 'invalid_k_axes', hint: 'k_axes must be an object with numeric axis scores in [0,1]' };
  }
  const out = {};
  const entries = Object.entries(kAxes).slice(0, KOLMBENCH_LIMITS.MAX_AXIS_KEYS);
  for (const [rawKey, rawValue] of entries) {
    const key = _cleanText(rawKey, KOLMBENCH_LIMITS.MAX_AXIS_NAME_CHARS);
    if (!key) continue;
    const n = Number(rawValue);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      return { ok: false, error: 'invalid_k_axes', hint: 'k_axes values must be finite numbers in [0,1]' };
    }
    out[key] = Number(n.toFixed(6));
  }
  return { ok: true, value: Object.keys(out).length ? out : null };
}

function _receiptEvidence({ verified, ed25519_receipt_path, receipt_root = RECEIPT_ROOT, receipt_verifier = null } = {}) {
  if (verified !== true) return { verified: false, status: 'not_requested', receipt_sha256: null };
  if (typeof ed25519_receipt_path !== 'string' || !ed25519_receipt_path.trim()) {
    return { verified: false, status: 'receipt_path_missing', receipt_sha256: null };
  }
  if (ed25519_receipt_path.length > KOLMBENCH_LIMITS.MAX_PATH_CHARS || CONTROL_RE.test(ed25519_receipt_path)) {
    CONTROL_RE.lastIndex = 0;
    return { verified: false, status: 'receipt_path_invalid', receipt_sha256: null };
  }
  const root = path.resolve(receipt_root || RECEIPT_ROOT);
  const receiptPath = path.resolve(ed25519_receipt_path);
  if (!(receiptPath === root || receiptPath.startsWith(root + path.sep))) {
    return { verified: false, status: 'receipt_path_outside_allowed_root', receipt_sha256: null };
  }
  let buf;
  try {
    const st = fs.statSync(receiptPath);
    if (!st.isFile() || st.size <= 0) return { verified: false, status: 'receipt_file_missing_or_empty', receipt_sha256: null };
    if (st.size > KOLMBENCH_LIMITS.MAX_RECEIPT_BYTES) return { verified: false, status: 'receipt_too_large', receipt_sha256: null };
    buf = fs.readFileSync(receiptPath);
  } catch (_e) {
    return { verified: false, status: 'receipt_file_unreadable', receipt_sha256: null };
  }
  const receiptSha = _sha256Hex(buf);
  if (typeof receipt_verifier !== 'function') {
    return { verified: false, status: 'receipt_verifier_not_wired', receipt_sha256: receiptSha };
  }
  try {
    const verdict = receipt_verifier({ path: receiptPath, receipt_sha256: receiptSha, bytes: buf.length });
    const ok = verdict === true || !!(verdict && verdict.ok === true);
    return {
      verified: ok,
      status: ok ? 'verified_by_receipt_verifier' : 'receipt_verifier_rejected',
      receipt_sha256: receiptSha,
    };
  } catch (_e) {
    return { verified: false, status: 'receipt_verifier_error', receipt_sha256: receiptSha };
  }
}

function _entrySha(entry) {
  return _sha256Hex(_stableJson({
    submitter: entry.submitter,
    model: entry.model,
    k_score: entry.k_score,
    k_axes: entry.k_axes,
    artifact_cid: entry.artifact_cid,
    source_repo: entry.source_repo,
    verified: entry.verified,
    verification_status: entry.verification_status,
    receipt_sha256: entry.receipt_sha256,
    submitted_at: entry.submitted_at,
  }));
}

function _normalizeLeaderboardEntry(entry, index = 0) {
  const k = Number(entry && entry.k_score);
  const receiptSha = /^[a-f0-9]{64}$/.test(String(entry && entry.receipt_sha256 || '')) ? entry.receipt_sha256 : null;
  const verificationStatus = _cleanText(entry && entry.verification_status, 96) || 'legacy_entry';
  const normalized = {
    submitter: _cleanText(entry && entry.submitter, KOLMBENCH_LIMITS.MAX_SUBMITTER_CHARS) || 'unknown',
    model: _cleanText(entry && entry.model, KOLMBENCH_LIMITS.MAX_MODEL_CHARS) || 'unknown',
    k_score: Number.isFinite(k) ? Math.max(0, Math.min(1, Number(k.toFixed(6)))) : 0,
    k_axes: entry && entry.k_axes && typeof entry.k_axes === 'object' ? _sanitizeAxes(entry.k_axes).value : null,
    artifact_cid: typeof (entry && entry.artifact_cid) === 'string' ? _cleanText(entry.artifact_cid, 96) : null,
    source_repo: typeof (entry && entry.source_repo) === 'string' ? _cleanText(entry.source_repo, KOLMBENCH_LIMITS.MAX_SOURCE_REPO_CHARS) : null,
    verified: !!(entry && entry.verified === true && verificationStatus === 'verified_by_receipt_verifier' && receiptSha),
    verification_status: verificationStatus,
    receipt_sha256: receiptSha,
    submitted_at: _cleanText(entry && entry.submitted_at, 64) || new Date(0).toISOString(),
  };
  normalized.entry_sha256 = /^[a-f0-9]{64}$/.test(String(entry && entry.entry_sha256 || ''))
    ? entry.entry_sha256
    : _entrySha(normalized);
  normalized.entry_id = typeof (entry && entry.entry_id) === 'string' && /^kolmbench_[a-f0-9]{16}$/.test(entry.entry_id)
    ? entry.entry_id
    : 'kolmbench_' + normalized.entry_sha256.slice(0, 16);
  if (!/^kolmbench_[a-f0-9]{16}$/.test(normalized.entry_id)) {
    normalized.entry_id = 'kolmbench_' + normalized.entry_sha256.slice(0, 16);
  }
  return normalized;
}

// KOLMBENCH_V1_SPEC - frozen catalog of the v1 benchmark scope.
//
// task_count is the target task count for the v1 pack - the canonical pack
// is being curated (W756-4 dependency on W757 lake + W766 consent). Until the
// pack drops, submission rows are validated against the AUTHORITATIVE_TASKS
// list below (a deliberately small starter set so the contract is testable
// today). The spec.task_count is the AUTHORITATIVE_TASKS.length so a caller
// trying validate() can match it.
//
// Schema:
//   version - w756-v1
//   name - public display name
//   task_count - number of tasks in the AUTHORITATIVE_TASKS list
//   categories - frozen axis split. Tests pin this exactly.
//   scoring - high-level description of how K-Score composes
//   license - CC-BY-4.0 (open submission, attribution required)
//   submission_format - JSONL row schema
//   verification - receipt requirement for self-hosted runs
export const AUTHORITATIVE_TASKS = Object.freeze([
  // reasoning (8)
  'reason-001-arithmetic-word', 'reason-002-deduction-chain', 'reason-003-counterfactual',
  'reason-004-syllogism', 'reason-005-causal-graph', 'reason-006-temporal-order',
  'reason-007-spatial-pack', 'reason-008-logic-puzzle',
  // coding (8)
  'code-001-bug-fix-js', 'code-002-bug-fix-py', 'code-003-refactor-pure',
  'code-004-write-test', 'code-005-explain-stack', 'code-006-sql-query',
  'code-007-regex-write', 'code-008-api-design',
  // writing (6)
  'write-001-summarize', 'write-002-rewrite-tone', 'write-003-outline',
  'write-004-headline', 'write-005-email-reply', 'write-006-bullet-to-prose',
  // analysis (6)
  'analyze-001-extract-entities', 'analyze-002-table-from-text', 'analyze-003-classify-intent',
  'analyze-004-sentiment-nuance', 'analyze-005-anomaly-spot', 'analyze-006-key-claim',
  // support (6)
  'support-001-faq-match', 'support-002-deflect-with-empathy', 'support-003-clarifying-q',
  'support-004-status-update', 'support-005-escalation', 'support-006-tone-mirror',
  // math (8)
  'math-001-algebra-solve', 'math-002-geometry-area', 'math-003-probability',
  'math-004-statistics-mean', 'math-005-calc-derivative', 'math-006-linear-system',
  'math-007-combinatorics', 'math-008-number-theory',
  // tool_use (8)
  'tool-001-call-search', 'tool-002-call-calculator', 'tool-003-multi-step-plan',
  'tool-004-error-recover', 'tool-005-choose-tool', 'tool-006-arg-format',
  'tool-007-result-parse', 'tool-008-loop-terminate',
]);

const AUTHORITATIVE_TASK_SET = new Set(AUTHORITATIVE_TASKS);

export const KOLMBENCH_V1_SPEC = Object.freeze({
  version: 'w756-v1',
  name: 'KolmBench v1',
  task_count: AUTHORITATIVE_TASKS.length,
  categories: Object.freeze(['reasoning', 'coding', 'writing', 'analysis', 'support', 'math', 'tool_use']),
  scoring: 'K-Score per axis + composite',
  license: 'CC-BY-4.0',
  submission_format: 'jsonl rows with {task_id, response, model, artifact_cid_or_null}',
  verification: 'Ed25519 receipt required for self-hosted runs',
});

// CID format used by /v1/verify/:cid - sha256:<hex64>. Plus we accept the
// 'pending_<id>' placeholder string (matches the W751 vertical stub pattern)
// so an early-stage entry can reference a not-yet-compiled artifact without
// the validator rejecting the submission outright. Anything else fails the
// invalid_artifact_cid_format check.
const ARTIFACT_CID_RE = /^(sha256:[a-f0-9]{64}|pending_[a-z0-9_-]+)$/;

// validateSubmission(rows) - pure function. Returns { ok, errors[] } with
// snake_case error codes. NEVER throws on caller-supplied bytes.
//
// Error code list (stable, snake_case, tested per-code):
//   submission_empty - rows is missing / empty / not an array
//   too_many_rows - more than KOLMBENCH_LIMITS.MAX_ROWS were submitted
//   missing_task_id - a row has no task_id string
//   missing_response - a row has no response string
//   task_id_too_large - task_id exceeds the bounded envelope limit
//   response_too_large - response exceeds the bounded envelope limit
//   model_too_large - optional model field exceeds the bounded envelope limit
//   unknown_task_id - task_id is not in AUTHORITATIVE_TASKS
//   duplicate_task_id - same task_id appears in 2+ rows
//   invalid_artifact_cid_format - artifact_cid_or_null doesn't match CID regex
//                                    (null is allowed - that's the API-only path)
export function validateSubmission(rows) {
  const errors = [];
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      ok: false,
      errors: [{ code: 'submission_empty', hint: 'submit at least one row in the JSONL body' }],
    };
  }
  if (rows.length > KOLMBENCH_LIMITS.MAX_ROWS) {
    errors.push({
      code: 'too_many_rows',
      row_count: rows.length,
      max_rows: KOLMBENCH_LIMITS.MAX_ROWS,
      hint: 'split very large submissions and keep one row per KolmBench task',
    });
  }
  const seen = new Set();
  const covered = new Set();
  const maxLoop = Math.min(rows.length, KOLMBENCH_LIMITS.MAX_ROWS);
  for (let i = 0; i < maxLoop; i++) {
    const row = rows[i] || {};
    // task_id: required non-empty string.
    if (typeof row.task_id !== 'string' || row.task_id.trim() === '') {
      errors.push({ code: 'missing_task_id', row_index: i, hint: 'every row needs a non-empty task_id string' });
      continue;
    }
    if (row.task_id.length > 128) {
      errors.push({ code: 'task_id_too_large', row_index: i, hint: 'task_id is too long for the KolmBench envelope' });
      continue;
    }
    const tid = _cleanText(row.task_id, 128);
    // response: required non-empty string.
    if (typeof row.response !== 'string' || row.response.trim() === '') {
      errors.push({ code: 'missing_response', row_index: i, task_id: tid, hint: 'every row needs a non-empty response string' });
    } else if (row.response.length > KOLMBENCH_LIMITS.MAX_RESPONSE_CHARS) {
      errors.push({
        code: 'response_too_large',
        row_index: i,
        task_id: tid,
        max_response_chars: KOLMBENCH_LIMITS.MAX_RESPONSE_CHARS,
        hint: 'response exceeds the KolmBench v1 row size limit',
      });
    }
    if (typeof row.model === 'string' && row.model.length > KOLMBENCH_LIMITS.MAX_MODEL_CHARS) {
      errors.push({ code: 'model_too_large', row_index: i, task_id: tid, hint: 'model exceeds the KolmBench envelope limit' });
    }
    // task_id membership against AUTHORITATIVE_TASKS.
    if (!AUTHORITATIVE_TASK_SET.has(tid)) {
      errors.push({ code: 'unknown_task_id', row_index: i, task_id: tid, hint: 'task_id must be in KolmBench v1 authoritative task list' });
    } else {
      covered.add(tid);
    }
    // Duplicate task_id within this submission.
    if (seen.has(tid)) {
      errors.push({ code: 'duplicate_task_id', row_index: i, task_id: tid, hint: 'each task_id may appear at most once per submission' });
    } else {
      seen.add(tid);
    }
    // Optional artifact_cid_or_null: when present and non-null, must match CID regex.
    if (Object.prototype.hasOwnProperty.call(row, 'artifact_cid_or_null')) {
      const cid = row.artifact_cid_or_null;
      if (cid !== null && cid !== undefined) {
        if (typeof cid !== 'string' || !ARTIFACT_CID_RE.test(cid)) {
          errors.push({
            code: 'invalid_artifact_cid_format',
            row_index: i,
            task_id: tid,
            hint: 'artifact_cid_or_null must be sha256:<hex64> or pending_<id> or null',
          });
        }
      }
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    row_count: Array.isArray(rows) ? rows.length : 0,
    accepted_task_count: covered.size,
    task_set_sha256: _taskSetSha(),
    submission_sha256: _submissionSha(rows),
    limits: {
      max_rows: KOLMBENCH_LIMITS.MAX_ROWS,
      max_response_chars: KOLMBENCH_LIMITS.MAX_RESPONSE_CHARS,
    },
  };
}

// scoreSubmission(rows, expectedTasks) - HONEST stub. The auto-scoring pack
// is offline pending the v1 reference-judge corpus (which ships with the
// W757 lake + a separate W807 judge-bot wave). We never paint a synthetic
// k_score on an unscored submission.
//
// Returns { ok, k_score, axis_breakdown, reason } so callers can tell
// "submission accepted, no score yet" from "submission rejected".
//
// Tests pin the exact reason code so a downstream parser can branch on it.
export function scoreSubmission(rows, expectedTasks = AUTHORITATIVE_TASKS) {
  // Validate shape first so a caller that skipped validate() still gets a
  // useful error path. expectedTasks default keeps the API ergonomic.
  const v = validateSubmission(rows);
  if (!v.ok) {
    return {
      ok: false,
      k_score: null,
      axis_breakdown: null,
      reason: 'submission_failed_validation',
      validation_errors: v.errors,
      submission_sha256: v.submission_sha256,
      task_set_sha256: v.task_set_sha256,
    };
  }
  // Optional coverage hint - purely informational, NEVER a score.
  const expected = Array.isArray(expectedTasks) ? expectedTasks : AUTHORITATIVE_TASKS;
  const covered = rows.filter((r) => r && typeof r.task_id === 'string' && expected.includes(r.task_id)).length;
  return {
    ok: true,
    k_score: null,
    axis_breakdown: null,
    reason: 'kolmbench_v1_scoring_offline_pending_pack',
    coverage: { covered, expected: expected.length },
    submission_sha256: v.submission_sha256,
    task_set_sha256: v.task_set_sha256,
    hint:
      'KolmBench v1 auto-scoring lands with the reference-judge pack (W807). ' +
      'Until then, submissions are stored with verified:false and require ' +
      'human review or a self-hosted Ed25519 receipt to enter the leaderboard.',
  };
}

// readLeaderboard() - read and return the static leaderboard object. Returns
// an HONEST empty-state envelope when the file is missing OR unparseable so
// CI / the /v1/kolmbench/leaderboard route never 500s on a corrupted file.
export function readLeaderboard({ leaderboard_path = null } = {}) {
  const resolved = _resolveJsonPath(leaderboard_path, LEADERBOARD_PATH);
  if (!resolved.ok) {
    return {
      ok: false,
      error: 'leaderboard_invalid_path',
      detail: resolved.detail,
      version: KOLMBENCH_VERSION,
    };
  }
  let buf;
  try {
    const st = fs.statSync(resolved.path);
    if (!st.isFile()) {
      return {
        ok: false,
        error: 'leaderboard_not_regular_file',
        version: KOLMBENCH_VERSION,
      };
    }
    if (st.size > KOLMBENCH_LIMITS.MAX_LEADERBOARD_BYTES) {
      return {
        ok: false,
        error: 'leaderboard_too_large',
        max_bytes: KOLMBENCH_LIMITS.MAX_LEADERBOARD_BYTES,
        version: KOLMBENCH_VERSION,
      };
    }
    buf = fs.readFileSync(resolved.path);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return {
        ok: true,
        version: KOLMBENCH_VERSION,
        updated_at: null,
        entries: [],
        entry_count: 0,
        leaderboard_sha256: null,
        chain_head_sha256: _sha256Hex(_stableJson([])),
        empty_reason: 'leaderboard_file_missing',
      };
    }
    return {
      ok: false,
      error: 'leaderboard_read_error',
      detail: _cleanText(e && e.message),
      version: KOLMBENCH_VERSION,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    return {
      ok: false,
      error: 'leaderboard_parse_error',
      detail: _cleanText(e && e.message),
      version: KOLMBENCH_VERSION,
      leaderboard_sha256: _sha256Hex(buf),
    };
  }
  const entries = Array.isArray(parsed.entries)
    ? parsed.entries.slice(0, KOLMBENCH_LIMITS.MAX_LEADERBOARD_ENTRIES).map((e, i) => _normalizeLeaderboardEntry(e, i))
    : [];
  const chainHead = _sha256Hex(_stableJson(entries.map((e) => e.entry_sha256)));
  // Defensive: stamp ok:true + the version we expect even if the file
  // version drifted, so the caller can branch on parsed.version vs spec.
  return {
    ok: true,
    version: parsed.version || KOLMBENCH_VERSION,
    updated_at: parsed.updated_at || null,
    entries,
    entry_count: entries.length,
    leaderboard_sha256: _sha256Hex(buf),
    chain_head_sha256: chainHead,
    truncated: Array.isArray(parsed.entries) && parsed.entries.length > entries.length,
  };
}

// appendLeaderboardEntry(entry) - atomically append + sort-by-k_score-desc.
//
// HONEST: verified is forced to false unless { ed25519_receipt_path } is
// inside the controlled receipt root AND receipt_verifier accepts the receipt
// hash. The receipt verification implementation is W807 (sigstore-attest
// reviewer-bot). We never trust user-supplied verified:true or arbitrary
// readable paths.
//
// Returns { ok, entry_added, total_entries, sort_position } where sort_position
// is the 1-indexed rank of the new entry post-sort.
export function appendLeaderboardEntry({
  submitter,
  model,
  k_score,
  k_axes = null,
  artifact_cid = null,
  source_repo = null,
  verified = false,
  ed25519_receipt_path = null,
  submitted_at = null,
  leaderboard_path = null,
  receipt_root = RECEIPT_ROOT,
  receipt_verifier = null,
} = {}) {
  const resolved = _resolveJsonPath(leaderboard_path, LEADERBOARD_PATH);
  if (!resolved.ok) {
    return { ok: false, error: 'leaderboard_invalid_path', detail: resolved.detail };
  }
  if (!_rawBoundedString(submitter, KOLMBENCH_LIMITS.MAX_SUBMITTER_CHARS) || submitter.trim() === '') {
    return { ok: false, error: 'missing_submitter', hint: 'submitter is required non-empty string' };
  }
  if (!_rawBoundedString(model, KOLMBENCH_LIMITS.MAX_MODEL_CHARS) || model.trim() === '') {
    return { ok: false, error: 'missing_model', hint: 'model is required non-empty string' };
  }
  if (typeof k_score !== 'number' || !Number.isFinite(k_score) || k_score < 0 || k_score > 1) {
    return { ok: false, error: 'invalid_k_score', hint: 'k_score must be a finite number in [0,1]' };
  }
  const axes = _sanitizeAxes(k_axes);
  if (!axes.ok) return { ok: false, error: axes.error, hint: axes.hint };
  if (artifact_cid != null && (typeof artifact_cid !== 'string' || !ARTIFACT_CID_RE.test(artifact_cid))) {
    return { ok: false, error: 'invalid_artifact_cid_format', hint: 'artifact_cid must be sha256:<hex64> or pending_<id>' };
  }
  if (source_repo != null && !_rawBoundedString(source_repo, KOLMBENCH_LIMITS.MAX_SOURCE_REPO_CHARS)) {
    return { ok: false, error: 'source_repo_too_large', hint: 'source_repo exceeds the KolmBench envelope limit' };
  }
  const receipt = _receiptEvidence({ verified, ed25519_receipt_path, receipt_root, receipt_verifier });
  // Read existing leaderboard. If the file is missing, start with a clean
  // entries[] - atomicity below still writes the canonical envelope.
  let current;
  try {
    current = readLeaderboard({ leaderboard_path: resolved.path });
  } catch (e) {
    return { ok: false, error: 'leaderboard_read_error', detail: _cleanText(e && e.message) };
  }
  if (current && current.ok === false) {
    return { ok: false, error: 'leaderboard_unreadable', detail: current.detail || null };
  }
  const entries = Array.isArray(current.entries) ? current.entries.slice() : [];
  if (entries.length >= KOLMBENCH_LIMITS.MAX_LEADERBOARD_ENTRIES) {
    return { ok: false, error: 'leaderboard_full', max_entries: KOLMBENCH_LIMITS.MAX_LEADERBOARD_ENTRIES };
  }
  const newEntry = {
    submitter: _cleanText(submitter, KOLMBENCH_LIMITS.MAX_SUBMITTER_CHARS),
    model: _cleanText(model, KOLMBENCH_LIMITS.MAX_MODEL_CHARS),
    k_score: Number(k_score.toFixed(6)),
    k_axes: axes.value,
    artifact_cid: typeof artifact_cid === 'string' ? _cleanText(artifact_cid, 96) : null,
    source_repo: typeof source_repo === 'string' ? _cleanText(source_repo, KOLMBENCH_LIMITS.MAX_SOURCE_REPO_CHARS) : null,
    verified: receipt.verified,
    verification_status: receipt.status,
    receipt_sha256: receipt.receipt_sha256,
    submitted_at: submitted_at ? _cleanText(submitted_at, 64) : new Date().toISOString(),
  };
  newEntry.entry_sha256 = _entrySha(newEntry);
  newEntry.entry_id = 'kolmbench_' + newEntry.entry_sha256.slice(0, 16);
  entries.push(newEntry);
  // Sort by k_score descending; stable secondary by submitter alpha so ties
  // are deterministic for diff'ability.
  entries.sort((a, b) => {
    if (b.k_score !== a.k_score) return b.k_score - a.k_score;
    return String(a.submitter).localeCompare(String(b.submitter));
  });
  const body = {
    version: KOLMBENCH_VERSION,
    updated_at: new Date().toISOString(),
    entries,
  };
  body.chain_head_sha256 = _sha256Hex(_stableJson(entries.map((e) => e.entry_sha256)));
  body.leaderboard_sha256 = _sha256Hex(_stableJson({
    version: body.version,
    updated_at: body.updated_at,
    entries: body.entries,
    chain_head_sha256: body.chain_head_sha256,
  }));
  // Atomic write: write to a sibling .tmp, then rename. Rename is atomic on
  // POSIX + sufficient on Windows for our concurrency profile (one writer at
  // a time + best-effort durability - the canonical store is the event-log
  // upstream, this file is a cached read-projection).
  const tmpPath = resolved.path + '.tmp.' + process.pid + '.' + Date.now() + '.' + crypto.randomBytes(8).toString('hex');
  try {
    // Ensure parent dir exists (file path lives under public/bench).
    fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(body, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(tmpPath, resolved.path);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch (_unlinkErr) { /* swallow */ }
    return { ok: false, error: 'leaderboard_write_error', detail: _cleanText(e && e.message) };
  }
  const sortPos = entries.findIndex(
    (e) => e.submitter === newEntry.submitter
      && e.model === newEntry.model
      && e.submitted_at === newEntry.submitted_at,
  ) + 1;
  return {
    ok: true,
    entry_added: newEntry,
    total_entries: entries.length,
    sort_position: sortPos,
    chain_head_sha256: body.chain_head_sha256,
    leaderboard_sha256: body.leaderboard_sha256,
    version: KOLMBENCH_VERSION,
  };
}

// getV2SeedTaskCandidates(opts) - W756-4 placeholder. The "curated most-
// challenging captures, anonymized, with consent" dataset requires the
// W757 cross-namespace lake (so we can pull captures across tenants safely)
// AND the W766 consent toolkit (so callers can opt in to having their
// captures included). Both are still in the plan but not shipped.
//
// HONEST: returns ok:false with a stable error code and a hint pointing at
// the blocked-by waves. NEVER silently returns a synthetic seed set.
//
// opts is reserved for future filtering (vertical, difficulty, etc.).
export function getV2SeedTaskCandidates(_opts = {}) {
  return {
    ok: false,
    error: 'kolmbench_v2_consent_pipeline_not_shipped',
    blocked_by: ['W757', 'W766'],
    hint: 'Awaiting W757 cross-namespace lake + W766 consent toolkit. Until those ship, '
      + 'v2 seed candidates cannot be aggregated across tenants. Track /docs/k-score for status.',
    version: KOLMBENCH_VERSION,
  };
}

// Tenant-fenced lookup helper for future W756-N extensions that aggregate
// per-tenant KolmBench events (e.g. a private "your team's score" view). Not
// wired into a route today - the public leaderboard is global - but exported
// so the contract pattern is grep-able for the parallel-agent next-wave
// surface. Defense-in-depth: filter twice in case the store driver returns a
// permissive row.
export function _findTenantKolmbenchEvents(tenant_id, kind = 'kolmbench_submission') {
  if (!tenant_id) return [];
  try {
    const rows = findByTenant('events', tenant_id) || [];
    // Defense-in-depth: re-check tenant on every row.
    return rows.filter((r) => r && r.tenant === tenant_id && r.kind === kind);
  } catch (_e) {
    return [];
  }
}
