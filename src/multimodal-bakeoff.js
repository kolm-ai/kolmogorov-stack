// src/multimodal-bakeoff.js
//
// W466 - multimodal bake-off harness.
//
// Closes audit P1 Multimodal cluster open item ("multimodal bake-off harness
// - compare base vs compiled across image/audio/video tasks").
//
// Shape: takes a list of compiled .kolm artifact paths and a media_kind
// filter. Pulls the tenant's captured events with that media_kind, replays
// the input through each artifact, and scores the output against the
// captured base response by token-overlap (Jaccard). Returns a ranked
// contestants[] envelope identical in spirit to src/bakeoff.js but
// specialised for multimodal capture rows.
//
// Why a separate module from src/bakeoff.js: src/bakeoff.js compares
// hosted-model contestants across a DATASET (text-only). W466 compares
// *artifacts* across CAPTURES where media_kind is set, which is a
// fundamentally different input source (event-store rows, not dataset_id).
// Keeping them split makes the tenant-fence + media_kind filter obvious in
// the source instead of buried in another module's branches.
//
// Heavy ML stays OUT of this module per the standing constraint - scoring
// is pure string/token comparison. If the user wants embedding-similarity
// scoring (CLIP for images, etc.) that lives in workers/multimodal-bakeoff/
// and is invoked via env override (KOLM_MULTIMODAL_SCORE_CMD).

import { listEvents } from './event-store.js';
import { runArtifact, loadArtifact } from './artifact-runner.js';

const VALID_MODALITIES = ['image', 'audio', 'video', 'pdf'];

// Tokenize a string into lowercase word tokens. Stripping punctuation
// keeps the Jaccard score from being dominated by trailing periods or
// quote marks. Returns a Set so we can take cardinality.
function _tokens(s) {
  if (s == null) return new Set();
  const text = String(s).toLowerCase();
  const toks = text.match(/[a-z0-9_]+/g) || [];
  return new Set(toks);
}

// Jaccard similarity over token sets. Returns 0..1. Empty-vs-empty is 1
// (both agree on having no content); empty-vs-nonempty is 0.
function _jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1.0;
  if (a.size === 0 || b.size === 0) return 0.0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Pull a usable input string from a captured event. We prefer the
// redacted prompt (privacy-membrane was already applied) over raw.
function _extractInput(ev) {
  if (!ev) return '';
  return String(
    ev.prompt_redacted
    || ev.prompt_head
    || (typeof ev.input === 'string' ? ev.input : '')
    || ''
  );
}

// Pull the captured base-model response. Used as the comparison anchor
// - the artifact whose output most closely matches this string wins.
function _extractBase(ev) {
  if (!ev) return '';
  return String(
    ev.response_redacted
    || ev.response_head
    || (typeof ev.response === 'string' ? ev.response : '')
    || ''
  );
}

// Pull the artifact's runArtifact() result into a comparable string.
// runArtifact returns { output, recipe_id, ... } where output can be
// any JSON-shaped value; we stringify scalars and JSON.stringify objects.
function _resultText(ran) {
  if (ran == null) return '';
  if (typeof ran === 'string') return ran;
  const out = ran.output != null ? ran.output : ran;
  if (out == null) return '';
  if (typeof out === 'string') return out;
  try { return JSON.stringify(out); } catch { return String(out); }
}

// Validate the inputs to runMultimodalBakeoff. Throws { code, message }
// envelopes so the route layer can map straight to HTTP status codes.
function _validate({ tenant_id, artifacts, modality }) {
  if (!tenant_id) {
    const err = new Error('tenant_id required');
    err.code = 'tenant_id_required';
    throw err;
  }
  if (!Array.isArray(artifacts) || !artifacts.length) {
    const err = new Error('at least one artifact path required');
    err.code = 'artifacts_required';
    throw err;
  }
  if (modality && !VALID_MODALITIES.includes(modality)) {
    const err = new Error('modality must be one of: ' + VALID_MODALITIES.join(','));
    err.code = 'invalid_modality';
    throw err;
  }
}

// Run one artifact across all candidate rows. Returns the per-contestant
// summary entry. Errors during individual rows are recorded but do not
// abort the contestant (one bad input shouldn't disqualify an artifact).
async function _runContestant(artifactPath, rows, opts) {
  let manifestOk = true;
  let loadError = null;
  try { loadArtifact(artifactPath); } catch (e) {
    manifestOk = false;
    loadError = String(e.message || e);
  }
  if (!manifestOk) {
    return {
      artifact_path: artifactPath,
      samples: 0,
      mean_score: 0,
      median_score: 0,
      errors: rows.length,
      error: 'artifact_load_failed',
      message: loadError,
      rows: [],
    };
  }
  const perRow = [];
  for (const ev of rows) {
    const input = _extractInput(ev);
    if (!input) continue;
    const baseOutput = _extractBase(ev);
    const t0 = Date.now();
    let compiledOutput = '';
    let err = null;
    try {
      const ran = await runArtifact(artifactPath, input, { tenant_id: opts.tenant_id });
      compiledOutput = _resultText(ran);
    } catch (e) {
      err = String(e.message || e);
    }
    const score = err ? 0 : _jaccard(_tokens(baseOutput), _tokens(compiledOutput));
    perRow.push({
      event_id: ev.event_id,
      media_kind: ev.media_kind,
      input_head: input.slice(0, 120),
      base_head: baseOutput.slice(0, 120),
      compiled_head: compiledOutput.slice(0, 120),
      score,
      latency_ms: Date.now() - t0,
      error: err,
    });
  }
  const scored = perRow.filter(r => !r.error);
  const mean = scored.length ? scored.reduce((s, r) => s + r.score, 0) / scored.length : 0;
  const sortedScores = scored.map(r => r.score).sort((a, b) => a - b);
  const median = sortedScores.length
    ? sortedScores[Math.floor(sortedScores.length / 2)]
    : 0;
  return {
    artifact_path: artifactPath,
    samples: perRow.length,
    scored: scored.length,
    mean_score: mean,
    median_score: median,
    errors: perRow.filter(r => r.error).length,
    rows: perRow,
  };
}

// Public API.
//
// Returns:
//   {
//     ok, tenant_id, namespace, modality,
//     samples, contestants: [
//       { artifact_path, samples, scored, mean_score, median_score, errors, rows: [...] }
//     ],
//     winner,       // artifact_path with highest mean_score, or null if no contestant scored
//     created_at,
//   }
//
// If no captures match the filter, returns ok:true with samples:0 and
// `message: 'no_multimodal_captures'` so the caller can surface a "no
// data yet" panel instead of an error.
export async function runMultimodalBakeoff({
  tenant_id,
  namespace = null,
  modality = null,
  artifacts = [],
  limit = 20,
}) {
  _validate({ tenant_id, artifacts, modality });

  // Pull events: tenant-fenced + namespace-filtered + media_kind-filtered.
  // event-store.listEvents already supports tenant_id + namespace +
  // media_kind, so the filter is one SQL statement / one JSONL scan.
  const events = await listEvents({
    tenant_id,
    namespace: namespace || undefined,
    media_kind: modality || undefined,
    limit: limit > 0 ? limit : 100,
  });

  // Defense in depth - listEvents already filtered, but verify each row.
  const rows = events.filter(ev =>
    ev
    && ev.tenant_id === tenant_id
    && ev.media_kind
    && VALID_MODALITIES.includes(ev.media_kind)
    && (modality ? ev.media_kind === modality : true)
    && (namespace ? ev.namespace === namespace : true)
    && (_extractBase(ev).length > 0)
  );

  if (!rows.length) {
    return {
      ok: true,
      tenant_id,
      namespace: namespace || null,
      modality: modality || 'all',
      samples: 0,
      contestants: artifacts.map(p => ({
        artifact_path: p,
        samples: 0,
        scored: 0,
        mean_score: 0,
        median_score: 0,
        errors: 0,
        rows: [],
      })),
      winner: null,
      message: 'no_multimodal_captures',
      created_at: new Date().toISOString(),
    };
  }

  const contestants = [];
  for (const artifactPath of artifacts) {
    const c = await _runContestant(artifactPath, rows, { tenant_id });
    contestants.push(c);
  }

  // Rank by mean_score desc. Tie-break by samples desc (more data wins).
  contestants.sort((a, b) =>
    ((b.mean_score || 0) - (a.mean_score || 0))
    || ((b.samples || 0) - (a.samples || 0))
  );

  const scoredContestants = contestants.filter(c => c.scored > 0);
  const winner = scoredContestants.length ? scoredContestants[0].artifact_path : null;

  return {
    ok: true,
    tenant_id,
    namespace: namespace || null,
    modality: modality || 'all',
    samples: rows.length,
    contestants,
    winner,
    created_at: new Date().toISOString(),
  };
}

export default {
  runMultimodalBakeoff,
};
