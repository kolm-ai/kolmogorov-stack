// src/vlm-bakeoff.js
//
// W771 - Vision-language bake-off harness.
//
// Replays captured vision turns through a single compiled .kolm artifact
// (the student VLM) and scores its output against the captured teacher
// response. Distinct from src/multimodal-bakeoff.js (W466) which compares
// *multiple* artifacts on multimodal CAPTURES by media_kind; this W771
// module compares ONE artifact across the vision-only subset of captures
// and groups results by image_kind (photo|screenshot|diagram|chart|other).
//
// Why a separate module from src/multimodal-bakeoff.js: the W466 harness
// pulls vision rows through listEvents (event-store with media_kind=
// 'image' filter); W771 pulls through the observations table's
// has_vision flag and the vision_capture row shape stamped by
// src/vision-capture.js. Different source = different fence + different
// rollup; collapsing them would force every vision turn to also write
// an event-store row, which the chokepoint deliberately doesn't do.
//
// HONESTY INVARIANTS (NEVER violate):
//
//   * No real API call inside this module. The judge + runOnArtifact
//     functions are DI seams. Tests inject pure-JS fakes; production
//     wires them to real adapters in src/router.js.
//
//   * Tenant fence is W411 defense-in-depth: per-row tenant_id filter
//     applied AFTER the storeMod.all('observations') read. Audit-export
//     uses the same pattern (see src/audit-export.js header comment).
//
//   * runVlmBakeoff returns an honest envelope when there are no vision
//     captures in the tenant + namespace, NEVER silent-passes with
//     count_vision_pairs_evaluated:0. Empty results are a real signal
//     ("you have no vision data to bake off") not a graceful nop.
//
//   * Image-kind classification uses _kindFromMime (best-effort heuristic
//     from MIME type). The bakeoff reports `judge_kind:'heuristic'` when
//     opts.judge is unset and `judge_kind:'callable'` when the caller
//     wires a real judge - the envelope never lies about which path ran.

import crypto from 'node:crypto';

export const VLM_BAKEOFF_VERSION = 'w771-v1';

// Image-kind bucket vocabulary. Frozen so the bakeoff envelope's
// `by_image_kind` shape is stable across calls and a schema sweep can
// rely on exactly these five buckets.
export const VLM_IMAGE_KINDS = Object.freeze([
  'photo',
  'screenshot',
  'diagram',
  'chart',
  'other',
]);

// =============================================================================
// Internal helpers.
// =============================================================================

// Tokenize a string into lowercase word tokens for the heuristic judge.
// Same lowering + punctuation strip as src/multimodal-bakeoff.js so the
// two bake-off modules score the same way when both run on the same row.
function _tokens(s) {
  if (s == null) return new Set();
  const text = String(s).toLowerCase();
  const toks = text.match(/[a-z0-9_]+/g) || [];
  return new Set(toks);
}

// Jaccard token-overlap. 0..1. Empty-vs-empty = 1, empty-vs-nonempty = 0.
function _jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1.0;
  if (a.size === 0 || b.size === 0) return 0.0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// The default heuristic judge: Jaccard token overlap between the
// captured base response and the artifact's reply. Used when the caller
// does not wire a real judge. Returns 0..1.
function _heuristicJudge(baseText, artifactText) {
  const a = _tokens(baseText);
  const b = _tokens(artifactText);
  return _jaccard(a, b);
}

// Resolve an image-kind bucket for a capture row. Prefers the explicit
// `image_kinds` array (stamped by captureVisionMessage) and falls back
// to MIME-derived heuristics. Multi-image turns are scored against the
// FIRST image's kind (single-bucket per row keeps the rollup honest).
function _imageKindFromRow(row) {
  if (!row || typeof row !== 'object') return 'other';
  if (Array.isArray(row.image_kinds) && row.image_kinds.length > 0) {
    const first = row.image_kinds[0];
    if (typeof first === 'string' && VLM_IMAGE_KINDS.includes(first)) {
      return first;
    }
  }
  // Best-effort: peek at the row's image_urls for a URL pattern that
  // hints at screenshot/diagram. Conservative - defaults to 'other'.
  const urls = Array.isArray(row.image_urls) ? row.image_urls : [];
  for (const u of urls) {
    if (typeof u !== 'string') continue;
    const lo = u.toLowerCase();
    if (lo.includes('screenshot') || lo.includes('screen-shot')) return 'screenshot';
    if (lo.includes('diagram') || lo.includes('.svg')) return 'diagram';
    if (lo.includes('chart') || lo.includes('plot')) return 'chart';
  }
  return 'other';
}

// =============================================================================
// runVlmBakeoff - replay vision captures through a single artifact, score.
// =============================================================================
//
// Inputs:
//   { tenant_id, namespace, artifact_path, max_n, opts:{ runOnArtifact, judge, storeMod } }
//
// Output:
//   {
//     ok: true,
//     version: 'w771-v1',
//     tenant_id, namespace, artifact_path,
//     count_total,                       // total vision rows in scope
//     count_vision_pairs_evaluated,      // rows that produced a score
//     by_image_kind: { photo, screenshot, diagram, chart, other }, // per-bucket avg
//     avg_score,                         // overall mean across all rows
//     judge_kind: 'heuristic' | 'callable',
//   }
//
// OR honest envelope:
//   { ok:false, error:'no_vision_captures_in_namespace' | 'tenant_id_required' | ... }
export async function runVlmBakeoff({
  tenant_id,
  namespace = null,
  artifact_path = null,
  max_n = 100,
  opts = {},
} = {}) {
  if (!tenant_id || typeof tenant_id !== 'string') {
    return {
      ok: false,
      error: 'tenant_id_required',
      hint: 'pass {tenant_id: "<id>"}. Vision bake-off is tenant-scoped.',
      version: VLM_BAKEOFF_VERSION,
    };
  }

  const storeMod = (opts && opts.storeMod) || null;
  const all = (storeMod && typeof storeMod.all === 'function') ? storeMod.all : null;
  if (!all) {
    return {
      ok: false,
      error: 'store_not_wired',
      hint: 'opts.storeMod must expose all(table). Tests inject a fake.',
      version: VLM_BAKEOFF_VERSION,
    };
  }

  // W411 defense-in-depth tenant fence: per-row filter AFTER all() read.
  const rawRows = all('observations') || [];
  const tenantRows = rawRows.filter((r) =>
    r && (r.tenant === tenant_id || r.tenant_id === tenant_id));
  const visionRows = tenantRows.filter((r) => r && r.has_vision === true);
  const nsScoped = namespace
    ? visionRows.filter((r) => r && r.corpus_namespace === namespace)
    : visionRows;

  if (nsScoped.length === 0) {
    return {
      ok: false,
      error: 'no_vision_captures_in_namespace',
      hint: namespace
        ? `no vision captures found for tenant ${tenant_id} in namespace ${namespace}`
        : `no vision captures found for tenant ${tenant_id}`,
      tenant_id,
      namespace,
      version: VLM_BAKEOFF_VERSION,
    };
  }

  // Cap rows at max_n; sensible upper bound to avoid surprise huge replays.
  const capped = nsScoped.slice(0, Math.max(1, Math.min(Number(max_n) || 100, 1000)));

  // Pick the runOnArtifact + judge functions. NEVER call any real network
  // path from inside this module - the DI seam is the contract.
  const runOnArtifact = (opts && typeof opts.runOnArtifact === 'function')
    ? opts.runOnArtifact
    : null;
  const judge = (opts && typeof opts.judge === 'function')
    ? opts.judge
    : _heuristicJudge;
  const judgeKind = (opts && typeof opts.judge === 'function')
    ? 'callable'
    : 'heuristic';

  // Per-bucket accumulators.
  const buckets = {};
  for (const k of VLM_IMAGE_KINDS) buckets[k] = { sum: 0, count: 0 };
  let overallSum = 0;
  let overallCount = 0;

  for (const row of capped) {
    // The captured base-model response is the comparison anchor.
    const baseText = String(row.response_text || row.response || '');

    let artifactText = '';
    if (runOnArtifact) {
      try {
        // The runOnArtifact DI seam receives the row + artifact_path; tests
        // return a deterministic string. Production code wires this to the
        // .kolm artifact runner (src/artifact-runner.js).
        const ran = await runOnArtifact({ row, artifact_path });
        // Tolerate both `{output:'...'}` envelopes and raw-string returns.
        if (ran && typeof ran === 'object' && typeof ran.output === 'string') {
          artifactText = ran.output;
        } else if (typeof ran === 'string') {
          artifactText = ran;
        }
      } catch (_) {
        // A run failure on a single row does not kill the bake-off; we
        // score it as zero and continue. Failing loud row-by-row would
        // be hostile to a long replay that hits one bad URL.
        artifactText = '';
      }
    }
    const score = Number(judge(baseText, artifactText)) || 0;
    const kind = _imageKindFromRow(row);
    const bucketKey = VLM_IMAGE_KINDS.includes(kind) ? kind : 'other';
    buckets[bucketKey].sum += score;
    buckets[bucketKey].count += 1;
    overallSum += score;
    overallCount += 1;
  }

  const by_image_kind = {};
  for (const k of VLM_IMAGE_KINDS) {
    const b = buckets[k];
    by_image_kind[k] = {
      count: b.count,
      avg_score: b.count > 0 ? b.sum / b.count : 0,
    };
  }
  const avg_score = overallCount > 0 ? overallSum / overallCount : 0;

  return {
    ok: true,
    version: VLM_BAKEOFF_VERSION,
    tenant_id,
    namespace,
    artifact_path,
    count_total: nsScoped.length,
    count_vision_pairs_evaluated: overallCount,
    by_image_kind,
    avg_score,
    judge_kind: judgeKind,
    bakeoff_id: 'vbk_' + crypto.randomBytes(6).toString('hex'),
    generated_at: new Date().toISOString(),
  };
}
