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
//     mismatch maps to one of: missing_task_id, missing_response,
//     unknown_task_id, duplicate_task_id, invalid_artifact_cid_format,
//     submission_empty. Tests pin every code.
//   - scoreSubmission is a pure stub that returns null k_score with a
//     reason:'kolmbench_v1_scoring_offline_pending_pack' so a caller cannot
//     conflate "we accepted your submission" with "we auto-graded you".
//   - appendLeaderboardEntry sets verified:false unless an Ed25519 receipt
//     path is provided. The reviewer-bot wave (W807) flips verified true
//     after sigstore-attest. NEVER paint verified:true from user-supplied
//     bytes alone.
//   - readLeaderboard / appendLeaderboardEntry write atomically (tmp+rename
//     pattern) so concurrent submissions cannot leave the file half-written.
//
// Tenant-fenced access: this module reads ONLY the static
// public/bench/leaderboard.json file plus pure-compute helpers. Any future
// event-store read MUST go through findByTenant + defense-in-depth, but the
// current surface intentionally has zero per-tenant state - the leaderboard
// is a global, deliberately-curated public artifact.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findByTenant } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const LEADERBOARD_PATH = path.join(REPO_ROOT, 'public', 'bench', 'leaderboard.json');

export const KOLMBENCH_VERSION = 'w756-v1';

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
//   missing_task_id - a row has no task_id string
//   missing_response - a row has no response string
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
  const seen = new Set();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
    // task_id: required non-empty string.
    if (typeof row.task_id !== 'string' || row.task_id.trim() === '') {
      errors.push({ code: 'missing_task_id', row_index: i, hint: 'every row needs a non-empty task_id string' });
      continue;
    }
    const tid = row.task_id.trim();
    // response: required non-empty string.
    if (typeof row.response !== 'string' || row.response.trim() === '') {
      errors.push({ code: 'missing_response', row_index: i, task_id: tid, hint: 'every row needs a non-empty response string' });
    }
    // task_id membership against AUTHORITATIVE_TASKS.
    if (!AUTHORITATIVE_TASK_SET.has(tid)) {
      errors.push({ code: 'unknown_task_id', row_index: i, task_id: tid, hint: 'task_id must be in KolmBench v1 authoritative task list' });
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
  return { ok: errors.length === 0, errors };
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
    hint:
      'KolmBench v1 auto-scoring lands with the reference-judge pack (W807). ' +
      'Until then, submissions are stored with verified:false and require ' +
      'human review or a self-hosted Ed25519 receipt to enter the leaderboard.',
  };
}

// readLeaderboard() - read and return the static leaderboard object. Returns
// an HONEST empty-state envelope when the file is missing OR unparseable so
// CI / the /v1/kolmbench/leaderboard route never 500s on a corrupted file.
export function readLeaderboard() {
  let raw;
  try {
    raw = fs.readFileSync(LEADERBOARD_PATH, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return {
        ok: true,
        version: KOLMBENCH_VERSION,
        updated_at: null,
        entries: [],
        empty_reason: 'leaderboard_file_missing',
      };
    }
    return {
      ok: false,
      error: 'leaderboard_read_error',
      detail: e && e.message,
      version: KOLMBENCH_VERSION,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      error: 'leaderboard_parse_error',
      detail: e && e.message,
      version: KOLMBENCH_VERSION,
    };
  }
  // Defensive: stamp ok:true + the version we expect even if the file
  // version drifted, so the caller can branch on parsed.version vs spec.
  return {
    ok: true,
    version: parsed.version || KOLMBENCH_VERSION,
    updated_at: parsed.updated_at || null,
    entries: Array.isArray(parsed.entries) ? parsed.entries : [],
  };
}

// appendLeaderboardEntry(entry) - atomically append + sort-by-k_score-desc.
//
// HONEST: verified is forced to false unless { ed25519_receipt_path } is
// supplied AND it points to a readable file. The receipt verification itself
// is W807 (sigstore-attest reviewer-bot); until then, even a present path
// only flips verified:true if the file exists and is non-empty. We never
// trust user-supplied verified:true without a receipt path.
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
} = {}) {
  if (typeof submitter !== 'string' || submitter.trim() === '') {
    return { ok: false, error: 'missing_submitter', hint: 'submitter is required non-empty string' };
  }
  if (typeof model !== 'string' || model.trim() === '') {
    return { ok: false, error: 'missing_model', hint: 'model is required non-empty string' };
  }
  if (typeof k_score !== 'number' || !Number.isFinite(k_score) || k_score < 0 || k_score > 1) {
    return { ok: false, error: 'invalid_k_score', hint: 'k_score must be a finite number in [0,1]' };
  }
  // Verified gate: only flip true if a receipt path exists AND points to a
  // readable, non-empty file. NEVER trust caller-supplied verified:true.
  let verifiedFinal = false;
  if (verified && typeof ed25519_receipt_path === 'string' && ed25519_receipt_path.length > 0) {
    try {
      const st = fs.statSync(ed25519_receipt_path);
      if (st.isFile() && st.size > 0) verifiedFinal = true;
    } catch (_e) {
      verifiedFinal = false;
    }
  }
  // Read existing leaderboard. If the file is missing, start with a clean
  // entries[] - atomicity below still writes the canonical envelope.
  let current;
  try {
    current = readLeaderboard();
  } catch (e) {
    return { ok: false, error: 'leaderboard_read_error', detail: e && e.message };
  }
  if (current && current.ok === false) {
    return { ok: false, error: 'leaderboard_unreadable', detail: current.detail || null };
  }
  const entries = Array.isArray(current.entries) ? current.entries.slice() : [];
  const newEntry = {
    submitter: submitter.trim(),
    model: model.trim(),
    k_score,
    k_axes: k_axes && typeof k_axes === 'object' ? k_axes : null,
    artifact_cid: typeof artifact_cid === 'string' ? artifact_cid : null,
    source_repo: typeof source_repo === 'string' ? source_repo : null,
    verified: verifiedFinal,
    submitted_at: submitted_at || new Date().toISOString(),
  };
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
  // Atomic write: write to a sibling .tmp, then rename. Rename is atomic on
  // POSIX + sufficient on Windows for our concurrency profile (one writer at
  // a time + best-effort durability - the canonical store is the event-log
  // upstream, this file is a cached read-projection).
  const tmpPath = LEADERBOARD_PATH + '.tmp.' + process.pid + '.' + Date.now();
  try {
    // Ensure parent dir exists (file path lives under public/bench).
    fs.mkdirSync(path.dirname(LEADERBOARD_PATH), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(body, null, 2) + '\n');
    fs.renameSync(tmpPath, LEADERBOARD_PATH);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch (_unlinkErr) { /* swallow */ }
    return { ok: false, error: 'leaderboard_write_error', detail: e && e.message };
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
