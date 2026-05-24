// W772 - audio bakeoff harness (intent classification + transcript fidelity).
//
// Closes W772-3 from KOLM_W707_SYSTEM_UPGRADE_PLAN.md (line 632):
//
//   W772-3: "Bakeoff audio pairs"
//
// Sister modules:
//   * src/multimodal-bakeoff.js  (W466 - generic image/audio/video/pdf bakeoff)
//   * src/audio-capture.js       (W772-2 - capture-side primitives)
//
// Why a separate module from src/multimodal-bakeoff.js: W466 compares
// HOSTED artifacts on a generic media_kind axis. W772 compares an
// artifact's response against the captured teacher response WITH
// transcript-fidelity + intent-bucketing as the scoring axes. The intent
// classification (question|command|conversation|dictation|other) is
// audio-specific; folding it into the generic harness would force every
// image/video bakeoff to carry an intent classifier they do not need.
//
// HONESTY INVARIANTS:
//   * Tenant-fenced via the tenant_id arg (W411 defense-in-depth: we
//     filter the rows returned by listEvents per-row even though
//     listEvents already filtered on tenant_id - the explicit row
//     filter is the defense against a future store-schema change).
//   * NEVER silent-passes when there are no audio captures. Returns
//     ok:true + count_total:0 + message:'no_audio_captures'.
//   * DI seam (opts.runOnArtifact + opts.judge + opts.storeMod) so the
//     test suite never hits a real Anthropic / OpenAI judge call.

import crypto from 'node:crypto';

export const AUDIO_BAKEOFF_VERSION = 'w772-v1';

// The intent buckets the W772 harness reports. The classifier is a thin
// regex pack (sister to the W759 numeric flag classifier) - it is NOT a
// model in itself, just a coarse heuristic so the operator can see the
// distribution of intents in their audio capture set without paying for
// a hosted intent classifier.
export const INTENT_KINDS = Object.freeze([
  'question',
  'command',
  'conversation',
  'dictation',
  'other',
]);

// Cap how many rows we will score per bakeoff. The W466 sibling caps at
// 500; W772 mirrors that ceiling so an operator pointing the harness at
// a 50k-row audio capture set does not melt the runtime.
const MAX_ROWS = 500;
const DEFAULT_MAX = 50;

// =============================================================================
// runAudioBakeoff
// =============================================================================

/**
 * Score an artifact against the tenant's captured audio rows.
 *
 * Args:
 *   tenant_id     - W411 fence column
 *   namespace     - optional corpus namespace filter
 *   artifact_path - path to the .kolm artifact under test (or 'none' for
 *                   a transcript-fidelity-only run)
 *   max_n         - cap on row count (default DEFAULT_MAX, hard ceiling MAX_ROWS)
 *   opts          - DI seam: { runOnArtifact, judge, storeMod }
 *
 * Returns:
 *
 *   {
 *     ok:                          Boolean,
 *     version:                     String,    // 'w772-v1'
 *     tenant_id:                   String,
 *     namespace:                   String|null,
 *     artifact_path:               String|null,
 *     count_total:                 Number,    // tenant-fenced audio capture count
 *     count_audio_pairs_evaluated: Number,    // rows actually scored
 *     by_intent_kind:              Object,    // {question:N, command:N, ...}
 *     avg_score:                   Number,    // mean Jaccard over evaluated rows
 *     judge_kind:                  String,    // 'transcript_jaccard' default
 *     transcript_coverage_pct:     Number,    // % of audio rows with transcript
 *     created_at:                  String,    // ISO-8601
 *     message?:                    String,    // 'no_audio_captures' etc.
 *   }
 *
 * HONESTY: when count_total === 0 (no audio captures yet) we return
 * ok:true with an explicit message so the dashboard renders an empty
 * state instead of a 500.
 */
export async function runAudioBakeoff(args) {
  const a = args || {};
  const tenant_id = a.tenant_id;
  const namespace = a.namespace || null;
  const artifact_path = a.artifact_path || null;
  const cap = _clampMax(a.max_n);
  const opts = a.opts || {};

  if (!tenant_id) {
    return {
      ok: false,
      version: AUDIO_BAKEOFF_VERSION,
      error: 'tenant_id_required',
      hint: 'pass {tenant_id: req.tenant_record.id, ...}',
      tenant_id: null,
      namespace,
      artifact_path,
      count_total: 0,
      count_audio_pairs_evaluated: 0,
      by_intent_kind: _zeroBuckets(),
      avg_score: 0,
      judge_kind: 'transcript_jaccard',
      transcript_coverage_pct: 0,
      created_at: new Date().toISOString(),
    };
  }

  // Pull events via DI store seam (defaults to canonical event-store).
  const storeMod = opts.storeMod || (await import('./event-store.js'));
  let events = [];
  try {
    events = await storeMod.listEvents({
      tenant_id,
      namespace: namespace || undefined,
      media_kind: 'audio',
      limit: cap,
    });
  } catch (e) {
    return {
      ok: false,
      version: AUDIO_BAKEOFF_VERSION,
      error: 'event_store_unavailable',
      detail: String(e && e.message || e),
      tenant_id,
      namespace,
      artifact_path,
      count_total: 0,
      count_audio_pairs_evaluated: 0,
      by_intent_kind: _zeroBuckets(),
      avg_score: 0,
      judge_kind: 'transcript_jaccard',
      transcript_coverage_pct: 0,
      created_at: new Date().toISOString(),
    };
  }

  // W411 defense-in-depth: per-row tenant_id check even though listEvents
  // already filtered. If the store schema flips one day from tenant_id to
  // tenant the filter still holds.
  const rows = events.filter((ev) =>
    ev
    && ev.tenant_id === tenant_id
    && (ev.media_kind === 'audio')
    && (namespace ? ev.namespace === namespace : true)
  );

  if (rows.length === 0) {
    return {
      ok: true,
      version: AUDIO_BAKEOFF_VERSION,
      tenant_id,
      namespace,
      artifact_path,
      count_total: 0,
      count_audio_pairs_evaluated: 0,
      by_intent_kind: _zeroBuckets(),
      avg_score: 0,
      judge_kind: opts.judge ? 'di_judge' : 'transcript_jaccard',
      transcript_coverage_pct: 0,
      message: 'no_audio_captures',
      hint: 'capture audio inputs first (POST /v1/audio/capture-detect + /v1/capture/log)',
      created_at: new Date().toISOString(),
    };
  }

  const buckets = _zeroBuckets();
  let total_score = 0;
  let evaluated = 0;
  let with_transcript = 0;

  for (const ev of rows) {
    const transcript = _pickTranscript(ev);
    if (transcript) with_transcript += 1;

    const intent = _classifyIntent(transcript);
    buckets[intent] = (buckets[intent] || 0) + 1;

    // Generate the candidate response. DI seam: opts.runOnArtifact lets
    // tests inject a synchronous stub without loading artifact-runner.
    let candidate = '';
    if (artifact_path) {
      try {
        if (typeof opts.runOnArtifact === 'function') {
          candidate = String(await opts.runOnArtifact(artifact_path, transcript || '', { tenant_id }));
        } else {
          const { runArtifact } = await import('./artifact-runner.js');
          const ran = await runArtifact(artifact_path, transcript || '', { tenant_id });
          candidate = _resultText(ran);
        }
      } catch (_) {
        candidate = '';
      }
    }

    const base = _extractBaseResponse(ev);
    const score = typeof opts.judge === 'function'
      ? Number(await opts.judge({ transcript, candidate, base, ev }) || 0)
      : _jaccard(_tokens(base), _tokens(candidate));

    total_score += score;
    evaluated += 1;
  }

  const avg_score = evaluated > 0 ? (total_score / evaluated) : 0;
  const coverage = rows.length > 0
    ? Math.round((with_transcript / rows.length) * 10000) / 100
    : 0;

  return {
    ok: true,
    version: AUDIO_BAKEOFF_VERSION,
    tenant_id,
    namespace,
    artifact_path,
    count_total: rows.length,
    count_audio_pairs_evaluated: evaluated,
    by_intent_kind: buckets,
    avg_score,
    judge_kind: typeof opts.judge === 'function' ? 'di_judge' : 'transcript_jaccard',
    transcript_coverage_pct: coverage,
    created_at: new Date().toISOString(),
  };
}

// =============================================================================
// Internal: tokenization + scoring + intent classification
// =============================================================================

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
  for (const t of a) if (b.has(t)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function _classifyIntent(text) {
  if (!text || typeof text !== 'string') return 'other';
  const t = text.trim().toLowerCase();
  if (!t) return 'other';

  // Question heuristic: trailing `?` or leading wh-word + auxiliary.
  if (/[?]$/.test(t)) return 'question';
  if (/^(who|what|where|when|why|how|which|whose)\b/.test(t)) return 'question';
  if (/^(is|are|was|were|do|does|did|can|could|will|would|should|may|might)\b/.test(t)) return 'question';

  // Command heuristic: imperative leading verb + lack of subject pronoun.
  if (/^(open|close|create|delete|run|start|stop|send|fetch|show|list|find|search|set|update|remove|kill|deploy|build|compile|train|distill)\b/.test(t)) return 'command';

  // Dictation heuristic: very long single sentence with no leading verb +
  // a lot of words. Operator dictation is typically a paragraph of
  // free-form narration.
  const word_count = t.split(/\s+/).length;
  if (word_count > 35 && !/[?]$/.test(t)) return 'dictation';

  // Conversation heuristic: short utterances with first-person pronoun
  // or greeting.
  if (/^(hi|hello|hey|thanks|thank you|sorry|please|i think|i feel|i need|i want|i'm|i am)\b/.test(t)) return 'conversation';
  if (word_count < 12) return 'conversation';

  return 'other';
}

function _zeroBuckets() {
  const obj = {};
  for (const k of INTENT_KINDS) obj[k] = 0;
  return obj;
}

function _pickTranscript(ev) {
  if (!ev || typeof ev !== 'object') return '';
  // Prefer explicit transcript field, then prompt_head (which the W772
  // captureAudioMessage chokepoint stamps with the first 400 chars of
  // the transcript).
  const t = ev.whisper_transcript
    || ev.transcript
    || ev.prompt_head
    || ev.prompt_redacted
    || (typeof ev.input === 'string' ? ev.input : '');
  return typeof t === 'string' ? t : '';
}

function _extractBaseResponse(ev) {
  if (!ev || typeof ev !== 'object') return '';
  return String(
    ev.response_redacted
    || ev.response_head
    || (typeof ev.response === 'string' ? ev.response : '')
    || '',
  );
}

function _resultText(ran) {
  if (ran == null) return '';
  if (typeof ran === 'string') return ran;
  const out = ran.output != null ? ran.output : ran;
  if (out == null) return '';
  if (typeof out === 'string') return out;
  try { return JSON.stringify(out); } catch { return String(out); }
}

function _clampMax(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_MAX;
  return Math.min(MAX_ROWS, Math.floor(v));
}

export default {
  AUDIO_BAKEOFF_VERSION,
  INTENT_KINDS,
  runAudioBakeoff,
};
