// src/speculative-teacher.js
//
// W814 -- Speculative Decoding with Student Draft (T1).
//
// The inverse of W807 confidence routing: instead of the student picking up
// work that the teacher would otherwise do (W807), the STUDENT is used as a
// draft model whose proposals the TEACHER verifies in a single forward pass.
// This is the canonical Leviathan/Chen speculative-decoding setup, but framed
// from the compiled-artifact-as-draft side. The teacher then either accepts
// each draft token or supplies a correction, so the user-facing latency is
// student-speed for the accepted prefix and teacher-quality on rejection.
//
// Relationship to siblings (read before editing):
//
//   src/accelerate.js (W727)         -- the speculative-decoding kernel
//                                       primitive. W727 owns the in-process
//                                       backend.propose()/backend.verify()
//                                       bridge. W814 is the LAYER ABOVE that
//                                       binds the bridge to a real teacher
//                                       endpoint + an artifact-as-student +
//                                       the W814 per-task acceptance log.
//
//   src/confidence-router.js (W807)  -- mid-response splice the other
//                                       direction (teacher rescues a low-
//                                       confidence student). We DO NOT splice
//                                       here; we VERIFY. W807 reduces teacher
//                                       calls; W814 reduces teacher latency.
//
//   src/event-store.js               -- the per-task acceptance log lives in
//                                       the canonical event-store under
//                                       workflow_id='speculative_teacher:log'
//                                       so the same dashboard pipeline that
//                                       surfaces routing / failure-mode rows
//                                       picks up W814 rows for free.
//
//   src/failure-modes.js (W812)      -- sibling module pattern: tenant fence,
//                                       honest envelope, version constant
//                                       matched via regex.
//
// W604 anti-brittleness contract:
//
//   The version constant is `SPECULATIVE_TEACHER_VERSION = 'w814-v1'`.
//   Consumers MUST match via `/^w814-/` regex (NEVER === equality), so a
//   future W814b / w814-v2 ships without forcing a cascading test rewrite.
//
// W411 tenant fence contract:
//
//   All reads of historical observations / acceptance log rows go through
//   findByTenant('observations', tenant) AND re-check `r.tenant === tenant`
//   inside the loop (defense in depth, per the W411 trap).
//
// Honest-envelope contract (NEVER fabricate acceptance rates):
//
//   - missing teacher  -> {ok:false, error:'no_teacher_configured', hint,
//                          version}
//   - missing artifact -> {ok:false, error:'artifact_not_found', hint, version}
//   - no captures      -> {ok:false, error:'no_captures_to_bench', hint,
//                          version}
//
//   The honesty contract here is load-bearing: a dashboard that surfaces an
//   acceptance rate the bench couldn't actually measure would mislead the
//   operator into trusting a speedup number that isn't there.
//
// DI testing seam (mandatory):
//
//   Every test stubs the teacher via env override KOLM_W814_TEACHER_CMD which
//   points at a Node script (or any executable) that emits canned JSON on
//   stdout. The runtime NEVER hits a real teacher API in tests.
//
// Exports:
//
//   SPECULATIVE_TEACHER_VERSION   string, 'w814-v1'
//   N_DRAFT_DEFAULT               number, 8 (per W814-1 plan)
//   resolveTeacher(env?)          {ok, argv|null, source, hint?}
//   computeAcceptedRun(accepted)  number, longest consecutive-true prefix
//   computeAvgAcceptedRun(runs)   number, mean span of consecutive trues
//   classifyTask(prompt)          string, simple task_cluster heuristic
//   runSpeculative(opts)          student-draft + teacher-verify loop
//   benchSpeculative(opts)        artifact-vs-teacher bench loop, returns
//                                 per-task acceptance log
//   logAcceptance(opts)           appendEvent helper for the per-task log
//   getAcceptanceLog(opts)        tenant-fenced query over the log

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { appendEvent, listEvents } from './event-store.js';

export const SPECULATIVE_TEACHER_VERSION = 'w814-v1';

// W814-1 default. The Leviathan/Chen literature uses 4-8 tokens; 8 is the
// upper end because the marginal benefit per added draft token falls off
// once the student's per-token entropy compounds. Operators can override
// per-call via opts.n_drafts.
export const N_DRAFT_DEFAULT = 8;

// Workflow ID for the per-task acceptance log. Stable across the lifetime
// of W814 so the dashboard query (`workflow_id='speculative_teacher:log'`)
// is forward-compatible with future per-row schema additions.
export const ACCEPTANCE_LOG_WORKFLOW = 'speculative_teacher:log';

// Task-cluster heuristic. Same shape as src/accelerate.js TASK_CLASS_BASELINES
// + a generic 'general' bucket so unknown prompts still land somewhere
// rather than dropping out of the log. Heuristic, not load-bearing -- the
// operator can override via opts.task_cluster.
const TASK_CLUSTER_HINTS = Object.freeze({
  extraction: ['extract', 'parse', 'find', 'list', 'pull', 'identify', 'json'],
  generation: ['write', 'draft', 'compose', 'generate', 'produce', 'create'],
  reasoning:  ['why', 'explain', 'reason', 'plan', 'solve', 'derive', 'prove'],
});

// --------------------------------------------------------------------------
// Teacher resolution (PATH lookup + KOLM_W814_TEACHER_CMD override).
// --------------------------------------------------------------------------

function _whichSync(name) {
  if (!name) return null;
  if (name.includes('/') || name.includes('\\')) {
    try { if (fs.existsSync(name) && fs.statSync(name).isFile()) return name; } catch (_) {} // deliberate: cleanup
    return null;
  }
  const P = process.env.PATH || '';
  const SEP = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())
    : [''];
  for (const dir of P.split(SEP)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      try { if (fs.existsSync(full) && fs.statSync(full).isFile()) return full; } catch (_) {} // deliberate: cleanup
    }
  }
  return null;
}

/**
 * Resolve the teacher CLI.
 *
 * Precedence:
 *   1. env.KOLM_W814_TEACHER_CMD -- accepted either as a single string
 *      ("/abs/path/to/teacher.js") or as a JSON array (e.g.
 *      `["node", "/abs/script.js", "--mode=stub"]`). The array form is
 *      the canonical test seam because tests need to inject
 *      `[process.execPath, stubPath]` pairs (matches the W464
 *      VOICEPRINT_REDACT_CMD pattern).
 *   2. PATH lookup for `kolm-w814-teacher`.
 *
 * Returns {ok:true, argv:[...], source} OR honest envelope with hint.
 * NEVER throws.
 */
export function resolveTeacher(env = process.env) {
  const envCmd = env && env.KOLM_W814_TEACHER_CMD;
  if (envCmd) {
    // Try array form first.
    try {
      const parsed = JSON.parse(envCmd);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const head = _whichSync(String(parsed[0]));
        if (head) return { ok: true, argv: [head, ...parsed.slice(1).map(String)], source: 'env-array' };
      }
    } catch (_) {} // deliberate: cleanup
    // Fall back to single-string command.
    const resolved = _whichSync(String(envCmd));
    if (resolved) return { ok: true, argv: [resolved], source: 'env' };
    return {
      ok: false,
      error: 'no_teacher_configured',
      hint: 'KOLM_W814_TEACHER_CMD set but executable not found; pass a JSON array like ["node","/abs/script.js"] or an absolute path',
      version: SPECULATIVE_TEACHER_VERSION,
    };
  }
  const onPath = _whichSync('kolm-w814-teacher');
  if (onPath) return { ok: true, argv: [onPath], source: 'path' };
  return {
    ok: false,
    error: 'no_teacher_configured',
    hint: 'set KOLM_W814_TEACHER_CMD to a JSON array (e.g. ["node","/abs/teacher-stub.js"]) or install kolm-w814-teacher on PATH',
    version: SPECULATIVE_TEACHER_VERSION,
  };
}

// --------------------------------------------------------------------------
// Acceptance math (pure helpers).
// --------------------------------------------------------------------------

/**
 * Speculative-decoding accept rule: the accepted prefix is the LONGEST
 * RUN OF TRUES STARTING AT INDEX 0. The first false halts acceptance.
 * Returns the run length (number of accepted tokens).
 */
export function computeAcceptedRun(accepted) {
  if (!Array.isArray(accepted)) return 0;
  let n = 0;
  for (let i = 0; i < accepted.length; i += 1) {
    if (accepted[i] === true) n += 1;
    else break;
  }
  return n;
}

/**
 * Mean span of consecutive-true subsequences across an array of boolean
 * arrays. Each inner array is one draft round; we measure ALL runs (not
 * just the leading one), then average them. Used for the per-task
 * `avg_accepted_run` log column.
 *
 * Example:
 *   [[T,T,F,T,T,T,F], [T,F]]  -> runs=[2,3,1] -> mean=2.0
 *   [[F,F,F,F]]               -> runs=[]      -> mean=0.0
 */
export function computeAvgAcceptedRun(rounds) {
  if (!Array.isArray(rounds) || rounds.length === 0) return 0;
  const runs = [];
  for (const round of rounds) {
    if (!Array.isArray(round)) continue;
    let cur = 0;
    for (let i = 0; i < round.length; i += 1) {
      if (round[i] === true) cur += 1;
      else if (cur > 0) { runs.push(cur); cur = 0; }
    }
    if (cur > 0) runs.push(cur);
  }
  if (runs.length === 0) return 0;
  const sum = runs.reduce((a, b) => a + b, 0);
  return sum / runs.length;
}

/**
 * Cheap task-cluster heuristic. Picks the first matching bucket from
 * TASK_CLUSTER_HINTS; falls back to 'general'. Pure, no I/O.
 */
export function classifyTask(prompt) {
  if (prompt == null) return 'general';
  const lower = String(prompt).toLowerCase();
  for (const [cluster, hints] of Object.entries(TASK_CLUSTER_HINTS)) {
    for (const h of hints) {
      if (lower.includes(h)) return cluster;
    }
  }
  return 'general';
}

// --------------------------------------------------------------------------
// Teacher invocation (process boundary -- spawnSync).
// --------------------------------------------------------------------------

// Invoke the teacher with the draft tokens, expect canned JSON on stdout.
// Returns {ok, accepted:[bool,...], teacher_token:{text}|null, raw} or an
// honest envelope on failure.
function _invokeTeacher(argv, payload, env = process.env) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return { ok: false, error: 'no_teacher_configured', hint: 'argv missing', version: SPECULATIVE_TEACHER_VERSION };
  }
  let res;
  try {
    res = spawnSync(argv[0], argv.slice(1), {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 60_000,
      // Windows .cmd shim seam (matches the W470 trap note in MEMORY).
      shell: false,
      env: { ...env, KOLM_W814_PAYLOAD_KIND: 'verify' },
    });
  } catch (e) {
    return {
      ok: false,
      error: 'teacher_invoke_failed',
      detail: String(e && e.message || e),
      version: SPECULATIVE_TEACHER_VERSION,
    };
  }
  if (res.status !== 0) {
    return {
      ok: false,
      error: 'teacher_nonzero_exit',
      detail: 'exit=' + res.status + ' stderr=' + (res.stderr || '').slice(0, 240),
      version: SPECULATIVE_TEACHER_VERSION,
    };
  }
  let parsed;
  try { parsed = JSON.parse(String(res.stdout || '').trim() || '{}'); }
  catch (e) {
    return {
      ok: false,
      error: 'teacher_bad_json',
      detail: String(e && e.message || e) + ' stdout=' + (res.stdout || '').slice(0, 240),
      version: SPECULATIVE_TEACHER_VERSION,
    };
  }
  if (parsed && typeof parsed === 'object') {
    return {
      ok: true,
      accepted: Array.isArray(parsed.accepted) ? parsed.accepted : [],
      teacher_token: (parsed.teacher_token && typeof parsed.teacher_token === 'object') ? parsed.teacher_token : null,
      raw: parsed,
    };
  }
  return {
    ok: false,
    error: 'teacher_bad_shape',
    hint: 'teacher stdout did not parse to a JSON object',
    version: SPECULATIVE_TEACHER_VERSION,
  };
}

// --------------------------------------------------------------------------
// runSpeculative -- student draft, teacher verify, one round.
// --------------------------------------------------------------------------

/**
 * Run one speculative round.
 *
 * Required opts:
 *   prompt           string  user-facing input the artifact would otherwise
 *                            answer alone.
 *   tenant           string  W411 tenant fence (defense in depth; the value
 *                            is stamped on the envelope but reads happen
 *                            entirely through DI-supplied draft/teacher
 *                            bridges).
 *
 * Optional opts:
 *   namespace        string  default 'default'; passed through to the log.
 *   n_drafts         number  default N_DRAFT_DEFAULT (8). Clamped [1,64].
 *   draft            object  DI student bridge (test seam). Shape:
 *                            { propose: async ({prompt,n}) =>
 *                                ({tokens:[{text}, ...]}) }
 *                            When omitted, runSpeculative refuses with
 *                            honest envelope (we never invent tokens).
 *   teacher_argv     array   pre-resolved teacher argv (skips resolveTeacher).
 *                            When omitted, resolveTeacher(env) supplies it.
 *   env              object  process.env override (test seam).
 *
 * Returns:
 *   { ok:true, version, tokens, acceptance_rate, accepted_count, total_count,
 *     route, accepted_text, teacher_correction_text, task_cluster, run_id }
 *
 *   OR honest envelope:
 *   { ok:false, error, hint, version }
 */
export async function runSpeculative(opts = {}) {
  const {
    prompt = null,
    tenant = null,
    namespace = 'default',
    n_drafts = N_DRAFT_DEFAULT,
    draft = null,
    teacher_argv = null,
    env = process.env,
  } = opts || {};

  if (!tenant) {
    return {
      ok: false,
      error: 'missing_tenant',
      hint: 'tenant is required so the speculative run is tenant-fenced',
      version: SPECULATIVE_TEACHER_VERSION,
    };
  }
  if (!prompt || typeof prompt !== 'string') {
    return {
      ok: false,
      error: 'missing_prompt',
      hint: 'pass {prompt:"...", tenant:"..."}',
      version: SPECULATIVE_TEACHER_VERSION,
    };
  }
  if (!draft || typeof draft.propose !== 'function') {
    return {
      ok: false,
      error: 'missing_draft_bridge',
      hint: 'pass opts.draft = { propose: async ({prompt,n}) => ({tokens:[{text}]}) } -- the runtime never fabricates student tokens',
      version: SPECULATIVE_TEACHER_VERSION,
    };
  }

  let argv = teacher_argv;
  if (!Array.isArray(argv) || argv.length === 0) {
    const r = resolveTeacher(env);
    if (!r.ok) {
      return r; // honest envelope, version stamped.
    }
    argv = r.argv;
  }

  const n = Math.max(1, Math.min(64, Math.trunc(Number(n_drafts) || N_DRAFT_DEFAULT)));

  // STEP 1 -- student proposes n tokens.
  let proposal;
  try {
    proposal = await draft.propose({ prompt, n });
  } catch (e) {
    return {
      ok: false,
      error: 'draft_propose_failed',
      detail: String(e && e.message || e),
      version: SPECULATIVE_TEACHER_VERSION,
    };
  }
  const draftTokens = Array.isArray(proposal && proposal.tokens) ? proposal.tokens : [];
  if (draftTokens.length === 0) {
    return {
      ok: false,
      error: 'draft_empty',
      hint: 'student bridge returned zero tokens; verify the artifact loaded',
      version: SPECULATIVE_TEACHER_VERSION,
    };
  }

  // STEP 2 -- teacher verifies in one parallel forward pass.
  const verify = _invokeTeacher(argv, { prompt, draft: draftTokens }, env);
  if (!verify.ok) return verify;

  const accepted = verify.accepted;
  const acceptedCount = computeAcceptedRun(accepted);
  const totalCount = draftTokens.length;
  const acceptanceRate = totalCount > 0 ? (acceptedCount / totalCount) : 0;

  let acceptedText = draftTokens.slice(0, acceptedCount).map((t) => String((t && t.text) || '')).join('');
  let correction = null;
  if (acceptedCount < totalCount && verify.teacher_token && typeof verify.teacher_token.text === 'string') {
    correction = verify.teacher_token.text;
    acceptedText += correction;
  }

  const runId = 'specrun_' + crypto.randomBytes(6).toString('hex');
  return {
    ok: true,
    version: SPECULATIVE_TEACHER_VERSION,
    run_id: runId,
    route: acceptedCount === totalCount ? 'all_accepted' : 'partial',
    tokens: draftTokens,
    accepted, // raw boolean array, so tests can pin the verifier shape
    acceptance_rate: Number(acceptanceRate.toFixed(6)),
    accepted_count: acceptedCount,
    total_count: totalCount,
    accepted_text: acceptedText,
    teacher_correction_text: correction,
    task_cluster: classifyTask(prompt),
    tenant,
    namespace,
  };
}

// --------------------------------------------------------------------------
// benchSpeculative -- artifact-vs-teacher loop.
// --------------------------------------------------------------------------

/**
 * Replay N captures through the speculative-teacher loop, group results by
 * task_cluster, return per-cluster acceptance rate + avg accepted run.
 *
 * Required opts:
 *   tenant           string  W411 tenant fence.
 *   artifact_id      string  the student artifact id (only used for the
 *                            envelope + log columns; the draft bridge is
 *                            still DI'd via opts.draft so tests never need
 *                            an on-disk artifact).
 *
 * Optional opts:
 *   namespace        string  default 'default'.
 *   draft            object  DI student bridge (REQUIRED in tests).
 *   teacher_argv     array   pre-resolved teacher argv.
 *   captures         array   list of {prompt, task_cluster?} to replay. When
 *                            omitted, listEvents() pulls the last 50 events
 *                            scoped to {tenant, namespace} so the production
 *                            CLI path can run without an explicit corpus.
 *   n_drafts         number  forwarded to runSpeculative.
 *   limit            number  default 50; cap on replay size.
 *   log              boolean default true; when true, each per-task summary
 *                            is appended to the event-store via
 *                            logAcceptance().
 *   env              object  process.env override (test seam).
 *
 * Returns:
 *   { ok:true, version, bench_id, artifact_id, total_runs, by_cluster:{
 *       <task_cluster>: {n, accepted, total, acceptance_rate,
 *                        avg_accepted_run} } }
 *
 *   OR honest envelope on missing artifact / no captures / no teacher.
 */
export async function benchSpeculative(opts = {}) {
  const {
    tenant = null,
    artifact_id = null,
    namespace = 'default',
    draft = null,
    teacher_argv = null,
    captures = null,
    n_drafts = N_DRAFT_DEFAULT,
    limit = 50,
    log: shouldLog = true,
    env = process.env,
  } = opts || {};

  if (!tenant) {
    return {
      ok: false,
      error: 'missing_tenant',
      hint: 'tenant is required so the bench is tenant-fenced',
      version: SPECULATIVE_TEACHER_VERSION,
    };
  }
  if (!artifact_id || typeof artifact_id !== 'string') {
    return {
      ok: false,
      error: 'artifact_not_found',
      hint: 'pass {artifact_id:"art_<id>"} so the bench row binds to the student artifact',
      version: SPECULATIVE_TEACHER_VERSION,
    };
  }
  if (!draft || typeof draft.propose !== 'function') {
    return {
      ok: false,
      error: 'missing_draft_bridge',
      hint: 'pass opts.draft = { propose: async ({prompt,n}) => ({tokens:[{text}]}) } -- the bench refuses to fabricate student tokens',
      version: SPECULATIVE_TEACHER_VERSION,
    };
  }

  // Pre-resolve the teacher once so we surface the no-teacher envelope
  // before we waste time walking captures.
  let argv = teacher_argv;
  if (!Array.isArray(argv) || argv.length === 0) {
    const r = resolveTeacher(env);
    if (!r.ok) return r;
    argv = r.argv;
  }

  // Build the replay corpus.
  let corpus = Array.isArray(captures) ? captures.slice(0, Math.max(1, Math.trunc(limit) || 50)) : null;
  if (!corpus) {
    let events;
    try {
      events = await listEvents({ tenant_id: tenant, namespace, limit: Math.max(1, Math.trunc(limit) || 50), order: 'desc' });
    } catch (e) {
      return {
        ok: false,
        error: 'event_store_read_failed',
        detail: String(e && e.message || e),
        version: SPECULATIVE_TEACHER_VERSION,
      };
    }
    // W411 row-level defense in depth.
    const safe = (events || []).filter((ev) => ev && ev.tenant_id === tenant);
    corpus = safe
      .map((ev) => ({ prompt: ev.prompt_redacted || ev.prompt_redacted_text || ev.prompt || null, task_cluster: null }))
      .filter((c) => c.prompt && typeof c.prompt === 'string');
  }
  if (!corpus || corpus.length === 0) {
    return {
      ok: false,
      error: 'no_captures_to_bench',
      hint: 'no replayable captures under this tenant/namespace; capture some traffic first or pass opts.captures',
      version: SPECULATIVE_TEACHER_VERSION,
      tenant,
      namespace,
    };
  }

  const benchId = 'specbench_' + crypto.randomBytes(6).toString('hex');
  const byCluster = new Map();
  const roundsByCluster = new Map();
  let totalRuns = 0;
  let firstErr = null;

  for (const c of corpus) {
    const taskCluster = c.task_cluster || classifyTask(c.prompt);
    const r = await runSpeculative({
      prompt: c.prompt,
      tenant,
      namespace,
      n_drafts,
      draft,
      teacher_argv: argv,
      env,
    });
    if (!r.ok) {
      firstErr = firstErr || r;
      continue;
    }
    totalRuns += 1;
    let agg = byCluster.get(taskCluster);
    if (!agg) {
      agg = { n: 0, accepted: 0, total: 0 };
      byCluster.set(taskCluster, agg);
    }
    agg.n += 1;
    agg.accepted += r.accepted_count;
    agg.total += r.total_count;
    let rounds = roundsByCluster.get(taskCluster);
    if (!rounds) { rounds = []; roundsByCluster.set(taskCluster, rounds); }
    rounds.push(r.accepted);
  }

  if (totalRuns === 0) {
    return {
      ok: false,
      error: firstErr ? firstErr.error : 'all_runs_failed',
      hint: firstErr ? firstErr.hint : 'every replay run returned an error envelope',
      detail: firstErr ? firstErr.detail : null,
      version: SPECULATIVE_TEACHER_VERSION,
    };
  }

  const summary = {};
  for (const [cluster, agg] of byCluster.entries()) {
    const rate = agg.total > 0 ? agg.accepted / agg.total : 0;
    const avgRun = computeAvgAcceptedRun(roundsByCluster.get(cluster) || []);
    summary[cluster] = {
      n: agg.n,
      accepted: agg.accepted,
      total: agg.total,
      acceptance_rate: Number(rate.toFixed(6)),
      avg_accepted_run: Number(avgRun.toFixed(6)),
    };
    if (shouldLog) {
      try {
        await logAcceptance({
          tenant,
          namespace,
          artifact_id,
          task_cluster: cluster,
          accept_rate: summary[cluster].acceptance_rate,
          avg_accepted_run: summary[cluster].avg_accepted_run,
          bench_id: benchId,
        });
      } catch (_) { // deliberate: cleanup
        // event-store write is best-effort; bench result still returns.
      }
    }
  }

  return {
    ok: true,
    version: SPECULATIVE_TEACHER_VERSION,
    bench_id: benchId,
    artifact_id,
    tenant,
    namespace,
    total_runs: totalRuns,
    corpus_size: corpus.length,
    by_cluster: summary,
  };
}

// --------------------------------------------------------------------------
// Per-task acceptance log (event-store backed).
// --------------------------------------------------------------------------

/**
 * Append one row to the per-task acceptance log.
 *
 * Required:
 *   tenant            string
 *   task_cluster      string
 *   accept_rate       number in [0,1]
 *   avg_accepted_run  number >= 0
 *
 * Optional:
 *   namespace         string  default 'default'
 *   artifact_id       string  bound to the student artifact (for dashboard
 *                             grouping); stamped into feedback JSON.
 *   bench_id          string  groups rows produced by one benchSpeculative
 *                             call so the dashboard can collapse them.
 *
 * Returns the canonical event row (so callers can read back event_id).
 */
export async function logAcceptance(opts = {}) {
  const {
    tenant = null,
    namespace = 'default',
    artifact_id = null,
    task_cluster = 'general',
    accept_rate = 0,
    avg_accepted_run = 0,
    bench_id = null,
  } = opts || {};
  if (!tenant) {
    const err = new Error('logAcceptance requires {tenant}');
    err.code = 'MISSING_TENANT';
    throw err;
  }
  // Schema-preserved fields: feedback (JSON-encoded payload survives
  // canonicalize), request_hash (stable dedupe key for the dashboard).
  const payload = {
    kind: 'speculative_acceptance',
    artifact_id,
    task_cluster,
    accept_rate: Number(accept_rate),
    avg_accepted_run: Number(avg_accepted_run),
    bench_id,
    version: SPECULATIVE_TEACHER_VERSION,
  };
  const reqHash = 'w814-' + (artifact_id || 'noart') + '-' + task_cluster + '-' + (bench_id || crypto.randomBytes(3).toString('hex'));
  const ev = await appendEvent({
    tenant_id: tenant,
    namespace,
    provider: 'kolm-speculative-teacher',
    vendor: 'kolm',
    model: 'speculative-teacher/log',
    workflow_id: ACCEPTANCE_LOG_WORKFLOW,
    request_hash: reqHash,
    prompt_tokens: 0,
    completion_tokens: 0,
    tokens_in: 0,
    tokens_out: 0,
    status: 'ok',
    feedback: JSON.stringify(payload),
  });
  return ev;
}

/**
 * Read the per-task acceptance log for a tenant.
 *
 * Required:
 *   tenant            string  W411 fence.
 *
 * Optional:
 *   namespace         string  filter to one namespace.
 *   task_cluster      string  filter rows whose feedback.task_cluster matches.
 *   artifact_id       string  filter to one artifact.
 *   limit             number  default 100; cap on returned rows.
 *
 * Returns:
 *   { ok:true, rows:[{event_id, created_at, task_cluster, accept_rate,
 *     avg_accepted_run, artifact_id, bench_id}], total, version }
 *
 *   OR honest envelope on missing tenant.
 */
export async function getAcceptanceLog(opts = {}) {
  const {
    tenant = null,
    namespace = null,
    task_cluster = null,
    artifact_id = null,
    limit = 100,
  } = opts || {};
  if (!tenant) {
    return {
      ok: false,
      error: 'missing_tenant',
      hint: 'tenant is required so the log read is tenant-fenced',
      version: SPECULATIVE_TEACHER_VERSION,
    };
  }
  let events;
  try {
    const q = {
      tenant_id: tenant,
      workflow_id: ACCEPTANCE_LOG_WORKFLOW,
      limit: Math.max(1, Math.trunc(Number(limit) || 100)),
      order: 'desc',
    };
    if (namespace) q.namespace = namespace;
    events = await listEvents(q);
  } catch (e) {
    return {
      ok: false,
      error: 'event_store_read_failed',
      detail: String(e && e.message || e),
      version: SPECULATIVE_TEACHER_VERSION,
    };
  }
  const rows = [];
  for (const ev of (events || [])) {
    // W411 defense in depth.
    if (!ev || ev.tenant_id !== tenant) continue;
    if (namespace && ev.namespace !== namespace) continue;
    let payload = null;
    if (typeof ev.feedback === 'string' && ev.feedback.length > 1 && ev.feedback[0] === '{') {
      try { payload = JSON.parse(ev.feedback); } catch (_) { payload = null; }
    }
    if (!payload || payload.kind !== 'speculative_acceptance') continue;
    if (task_cluster && payload.task_cluster !== task_cluster) continue;
    if (artifact_id && payload.artifact_id !== artifact_id) continue;
    rows.push({
      event_id: ev.event_id,
      created_at: ev.created_at,
      namespace: ev.namespace,
      task_cluster: payload.task_cluster,
      accept_rate: Number(payload.accept_rate),
      avg_accepted_run: Number(payload.avg_accepted_run),
      artifact_id: payload.artifact_id || null,
      bench_id: payload.bench_id || null,
    });
  }
  return {
    ok: true,
    rows,
    total: rows.length,
    tenant,
    namespace,
    version: SPECULATIVE_TEACHER_VERSION,
  };
}

// Test seams -- exported pure helpers so tests can pin individual contracts
// without going through the public surface.
export const _whichSync_for_test = _whichSync;
export const _invokeTeacher_for_test = _invokeTeacher;

export default {
  SPECULATIVE_TEACHER_VERSION,
  N_DRAFT_DEFAULT,
  ACCEPTANCE_LOG_WORKFLOW,
  resolveTeacher,
  computeAcceptedRun,
  computeAvgAcceptedRun,
  classifyTask,
  runSpeculative,
  benchSpeculative,
  logAcceptance,
  getAcceptanceLog,
};
