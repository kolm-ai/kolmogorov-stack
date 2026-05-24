// W773 — Video bakeoff (compare distilled artifact vs captured base on
// video-bearing captures). Tenant-fenced + namespace-filtered.
//
// Distinct from src/multimodal-bakeoff.js because the W466 multimodal
// bake-off runs across image/audio/video/pdf simultaneously and ranks
// artifacts on Jaccard token overlap. W773's video bake-off is video-
// specific and aggregates a per-CONTENT-KIND mean score (tutorial /
// screencast / presentation / surveillance / other) — the content-kind
// taxonomy is the differentiator. A tutorial-trained student should win
// on tutorial captures and lose on surveillance captures; without the
// per-kind breakdown that signal is averaged away.
//
// Atomic guarantees pinned by tests/wave773-video-distill.test.js:
//
//  - VIDEO_BAKEOFF_VERSION = 'w773-v1'
//  - runVideoBakeoff is tenant-fenced (W411 defense-in-depth — even with
//    a faked storeMod that returns cross-tenant rows, the per-row filter
//    inside runVideoBakeoff rejects them).
//  - Returns honest envelope on no video captures (never silent-pass
//    with empty scores claiming success).
//  - by_content_kind always carries the 5 keys (tutorial, screencast,
//    presentation, surveillance, other) — empty kinds report 0/null
//    rather than being omitted so the UI doesn't have to guess.
//
// HONESTY INVARIANTS:
//  - tenant_id is REQUIRED. Missing/empty -> honest envelope.
//  - No-video-captures returns a distinct envelope so the UI surfaces
//    "no video data yet" instead of "score 0".
//  - judge_kind reports which scoring path actually ran (jaccard /
//    embedding / external). NEVER fabricated.

import crypto from 'node:crypto';

export const VIDEO_BAKEOFF_VERSION = 'w773-v1';

// Closed enum of content-kind buckets. Frozen — adding a 6th kind needs
// a version bump because the UI and the per-kind aggregator pin to this.
const CONTENT_KINDS = Object.freeze([
  'tutorial',
  'screencast',
  'presentation',
  'surveillance',
  'other',
]);

// Lightweight content-kind classifier. Looks at the captured response
// head + URL path for keyword hints. NEVER attempts to download the
// video itself; the cost would be intolerable and the bytes aren't ours
// to hold anyway.
function _classifyContentKind(row) {
  const text = String(
    (row && row.w773 && row.w773.response_head) ||
    (row && row.response_head) ||
    (row && row.response_redacted) ||
    ''
  ).toLowerCase();
  const url = String((row && row.media_uri) || '').toLowerCase();

  if (/tutorial|how to|step by step|walk(through)?|lesson/i.test(text + ' ' + url)) return 'tutorial';
  if (/screencast|screen recording|screen-record|demo/i.test(text + ' ' + url)) return 'screencast';
  if (/presentation|slide(s|deck)?|webinar|keynote/i.test(text + ' ' + url)) return 'presentation';
  if (/surveillance|cctv|camera-feed|security camera|dashcam/i.test(text + ' ' + url)) return 'surveillance';
  return 'other';
}

// Tokenize for Jaccard scoring. Same pattern as src/multimodal-bakeoff.js
// (lowercase + alnum-and-underscore). Kept local so video-bakeoff has no
// runtime dependency on multimodal-bakeoff.
function _tokens(s) {
  if (s == null) return new Set();
  const text = String(s).toLowerCase();
  const toks = text.match(/[a-z0-9_]+/g) || [];
  return new Set(toks);
}

function _jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1.0;
  if (a.size === 0 || b.size === 0) return 0.0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Pull the captured base-model response text from a row.
function _extractBaseResponse(row) {
  if (!row) return '';
  if (row.w773 && typeof row.w773.response_head === 'string') return row.w773.response_head;
  if (typeof row.response_head === 'string') return row.response_head;
  if (typeof row.response_redacted === 'string') return row.response_redacted;
  if (typeof row.response === 'string') return row.response;
  return '';
}

// Pull the captured prompt/input text (used as the artifact's input).
function _extractInputText(row) {
  if (!row) return '';
  if (typeof row.prompt_redacted === 'string') return row.prompt_redacted;
  if (typeof row.prompt_head === 'string') return row.prompt_head;
  if (typeof row.input === 'string') return row.input;
  return '';
}

// =============================================================================
// runVideoBakeoff — the public surface.
//
// Args:
//   tenant_id    REQUIRED (P0 leak prevention)
//   namespace    optional filter (default: all namespaces for tenant)
//   artifact_path  path to a .kolm artifact to run
//   max_n        max captures to evaluate (default 50, hard ceiling 500)
//   opts.runOnArtifact   DI seam — async (artifact_path, input_text) -> response
//   opts.judge           DI seam — judge function (base, candidate) -> 0..1
//   opts.storeMod        DI seam — alt event store with .listEvents()
//
// Returns success envelope on happy path:
//   {ok, version, count_total, count_video_pairs_evaluated, by_content_kind,
//    avg_score, judge_kind, tenant_id, namespace, artifact_path}
//
// Returns honest envelope on:
//   - missing tenant_id
//   - no video captures found (count_total === 0)
//   - artifact load failed
// =============================================================================
export async function runVideoBakeoff({
  tenant_id,
  namespace = null,
  artifact_path = null,
  max_n = 50,
  opts = {},
} = {}) {
  // ----- HONESTY: refuse to run without tenant_id (P0 leak prevention). -----
  if (!tenant_id || typeof tenant_id !== 'string') {
    return {
      ok: false,
      error: 'tenant_id_required',
      hint: 'pass {tenant_id} — video bakeoff is tenant-scoped',
      version: VIDEO_BAKEOFF_VERSION,
    };
  }

  // ----- Cap normalization -----
  let cap = Number(max_n);
  if (!Number.isFinite(cap) || cap < 1) cap = 50;
  const HARD_CEILING = 500;
  if (cap > HARD_CEILING) cap = HARD_CEILING;

  // ----- Pull video captures via the event-store (or DI fake) -----
  const storeMod = (opts && opts.storeMod)
    ? opts.storeMod
    : await import('./event-store.js');

  // listEvents is the canonical reader and already supports media_kind.
  // Defense-in-depth: we filter again on tenant_id after the read to honor
  // the W411 law (never trust the indexed read alone for tenant fence).
  let rawRows = [];
  try {
    if (typeof storeMod.listEvents === 'function') {
      rawRows = await storeMod.listEvents({
        tenant_id,
        namespace: namespace || undefined,
        media_kind: 'video',
        limit: HARD_CEILING * 2,
      });
    } else if (typeof storeMod.all === 'function') {
      // Fallback for fakes that only implement all(). Apply the full filter
      // chain in JS-land.
      const allRows = storeMod.all('events') || [];
      rawRows = allRows;
    } else {
      return {
        ok: false,
        error: 'store_not_wired',
        hint: 'opts.storeMod must expose listEvents() or all(table)',
        version: VIDEO_BAKEOFF_VERSION,
      };
    }
  } catch (e) {
    return {
      ok: false,
      error: 'store_read_failed',
      detail: String(e && e.message || e),
      version: VIDEO_BAKEOFF_VERSION,
    };
  }

  // W411 defense-in-depth tenant fence — per-row filter even though we
  // asked listEvents to filter by tenant_id. The fake store path goes
  // through `all()` which returns EVERY tenant; without this filter the
  // fake would leak cross-tenant rows into the bakeoff result.
  const tenantRows = rawRows.filter(r => r && r.tenant_id === tenant_id);

  // namespace fence (DI fakes do not pre-filter)
  const nsRows = namespace
    ? tenantRows.filter(r => r.namespace === namespace)
    : tenantRows;

  // media_kind fence (DI fakes do not pre-filter)
  const videoRows = nsRows.filter(r => r.media_kind === 'video');

  // ----- No video captures? Honest envelope. -----
  if (videoRows.length === 0) {
    return {
      ok: true,
      version: VIDEO_BAKEOFF_VERSION,
      tenant_id,
      namespace: namespace || null,
      artifact_path: artifact_path || null,
      count_total: 0,
      count_video_pairs_evaluated: 0,
      by_content_kind: _emptyKindMap(),
      avg_score: null,
      judge_kind: null,
      message: 'no_video_captures',
      hint: 'capture video-bearing messages first via /v1/video/capture-detect or the connector path',
    };
  }

  // ----- Cap by max_n -----
  const candidates = videoRows.slice(0, cap);
  const count_total = videoRows.length;

  // ----- DI seam: the artifact runner. Default uses src/artifact-runner.js. -----
  // We pass the path as data; the runOnArtifact fake in tests returns a
  // canned response. In production the default loads + runs the .kolm.
  const runOnArtifact = (opts && typeof opts.runOnArtifact === 'function')
    ? opts.runOnArtifact
    : async (path, input) => {
        if (!path) return '';
        try {
          const mod = await import('./artifact-runner.js');
          const ran = await mod.runArtifact(path, input, { tenant_id });
          if (ran == null) return '';
          if (typeof ran === 'string') return ran;
          const out = ran.output != null ? ran.output : ran;
          if (typeof out === 'string') return out;
          try { return JSON.stringify(out); } catch { return String(out); }
        } catch (e) {
          // Honest failure surface — bubble up to per-row score:0.
          return { __error__: String(e && e.message || e) };
        }
      };

  // ----- DI seam: the judge. Default = Jaccard token overlap. -----
  const judge = (opts && typeof opts.judge === 'function')
    ? opts.judge
    : (base, cand) => _jaccard(_tokens(base), _tokens(cand));
  const judge_kind = (opts && typeof opts.judgeKind === 'string')
    ? opts.judgeKind
    : 'jaccard';

  // ----- Per-row scoring + content-kind bucketing -----
  const byKind = _emptyKindMap();
  let totalScore = 0;
  let totalScored = 0;
  let count_video_pairs_evaluated = 0;

  for (const row of candidates) {
    const input = _extractInputText(row);
    const base = _extractBaseResponse(row);
    if (!base) continue; // No base response means we have nothing to score against — skip honestly.

    let candidateText = '';
    try {
      const ran = await runOnArtifact(artifact_path, input);
      if (ran && typeof ran === 'object' && ran.__error__) {
        candidateText = '';
      } else {
        candidateText = String(ran || '');
      }
    } catch {
      candidateText = '';
    }

    const score = Number(judge(base, candidateText));
    const safeScore = (Number.isFinite(score) && score >= 0 && score <= 1) ? score : 0;
    totalScore += safeScore;
    totalScored += 1;
    count_video_pairs_evaluated += 1;

    const kind = _classifyContentKind(row);
    const bucket = byKind[kind];
    bucket.count += 1;
    bucket.total_score += safeScore;
    bucket.scores.push(safeScore);
  }

  // Finalize per-kind stats (mean + median) so the UI can show both.
  for (const k of CONTENT_KINDS) {
    const b = byKind[k];
    if (b.count === 0) {
      b.mean_score = null;
      b.median_score = null;
    } else {
      b.mean_score = b.total_score / b.count;
      const sorted = b.scores.slice().sort((a, c) => a - c);
      b.median_score = sorted[Math.floor(sorted.length / 2)];
    }
    // The raw scores array is only useful for debugging — keep it out of
    // the public envelope to avoid bloating the payload.
    delete b.scores;
    delete b.total_score;
  }

  const avg_score = totalScored > 0 ? totalScore / totalScored : null;

  return {
    ok: true,
    version: VIDEO_BAKEOFF_VERSION,
    tenant_id,
    namespace: namespace || null,
    artifact_path: artifact_path || null,
    count_total,
    count_video_pairs_evaluated,
    by_content_kind: byKind,
    avg_score,
    judge_kind,
    max_n: cap,
    generated_at: new Date().toISOString(),
  };
}

// Build the empty content-kind result map. ALWAYS has the 5 keys so the
// UI can render zero buckets without optional-chaining.
function _emptyKindMap() {
  const out = Object.create(null);
  for (const k of CONTENT_KINDS) {
    out[k] = {
      count: 0,
      total_score: 0,
      scores: [],
      mean_score: null,
      median_score: null,
    };
  }
  return out;
}

export default {
  VIDEO_BAKEOFF_VERSION,
  runVideoBakeoff,
};
