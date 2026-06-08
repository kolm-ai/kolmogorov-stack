// W833-4 - Per-language K-Score reporting in artifact manifest.
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md line 1200):
//   [W833-4] Per-language K-Score reporting in artifact manifest.
//
// Why this exists:
//   W774's cross-lingual-eval.js scores an artifact per language at
//   eval-time. W833-4 PERSISTS those per-language scores into the
//   artifact manifest itself so anyone inspecting a .kolm later (auditor,
//   regulator, downstream operator) sees the language-by-language
//   performance ledger without having to rerun the eval. Pairs with the
//   overall_lang_distribution snapshot (from W833-1 distributionByLang)
//   so the manifest tells the full multilingual story:
//
//     "this artifact was trained on a corpus that is 62% English, 15%
//      Spanish, 23% Mandarin, and it scores en:0.78, es:0.65, zh:0.71."
//
// Honesty contract:
//   * NEVER fabricate per-language scores. If per_lang_kscores is empty
//     OR missing required fields, annotateManifest writes an honest
//     "no_per_lang_scores" sentinel into the block (NOT silent absence).
//   * readPerLangKScores returns null + honest reason when the manifest
//     lacks the block; never returns {} that looks like "evaluated but
//     scored 0 everywhere."
//   * Manifest mutation is COPY-ON-WRITE - we return a new manifest
//     object rather than mutating in place, so callers can compare
//     before/after and surface diffs cleanly.
//
// Public surface:
//   - LINGUAL_MANIFEST_VERSION
//   - annotateManifest({manifest, per_lang_kscores, overall_lang_distribution?})
//   - readPerLangKScores(manifest)

export const LINGUAL_MANIFEST_VERSION = 'w833-v1';

// Top-level key written into the manifest. Kept distinct from W774's
// xlang_eval block (which is a transient eval snapshot) so the two
// surfaces can co-exist on the same manifest without colliding.
export const PER_LANG_KSCORE_KEY = 'per_lang_kscore';
export const OVERALL_LANG_DIST_KEY = 'overall_lang_distribution';

// =============================================================================
// annotateManifest
//
// Add the per-language K-Score block + optional overall distribution to
// an artifact manifest. Returns a NEW manifest object (copy-on-write).
//
// Input:
//   args.manifest:                 object (artifact manifest, any shape)
//   args.per_lang_kscores:         {en:0.78, es:0.65, zh:0.71, ...}
//                                  Values clamped to 0..1; non-finite
//                                  values drop the lang (we never write
//                                  a fabricated score).
//   args.overall_lang_distribution: optional output of W833-1
//                                  distributionByLang() - folded into
//                                  the manifest under OVERALL_LANG_DIST_KEY.
//   args.gated_at_n:               optional integer; the n>=N floor used
//                                  for the per-lang Wilson CI (defaults
//                                  to 30, matching W774).
//
// Output:
//   { manifest:NEW, written:{...the block we wrote...}, version, ok }
//
// On invalid input (no manifest / no scores):
//   { ok:false, error, hint, manifest:ORIGINAL, version }
// =============================================================================

export function annotateManifest(args) {
  const a = args || {};
  const m = (a.manifest && typeof a.manifest === 'object') ? a.manifest : null;
  const scoresIn = (a.per_lang_kscores && typeof a.per_lang_kscores === 'object')
    ? a.per_lang_kscores : null;
  const distIn = (a.overall_lang_distribution && typeof a.overall_lang_distribution === 'object')
    ? a.overall_lang_distribution : null;
  const gatedAtN = Number.isFinite(a.gated_at_n) ? a.gated_at_n : 30;

  if (!m) {
    return {
      ok: false,
      error: 'manifest_required',
      hint: 'pass {manifest:<artifact manifest object>}',
      manifest: a.manifest || null,
      version: LINGUAL_MANIFEST_VERSION,
    };
  }
  if (!scoresIn) {
    return {
      ok: false,
      error: 'per_lang_kscores_required',
      hint: 'pass {per_lang_kscores:{en:0.78, es:0.65, ...}}',
      manifest: m,
      version: LINGUAL_MANIFEST_VERSION,
    };
  }

  // Sanitize scores - only finite 0..1 values land in the manifest.
  // Non-finite / out-of-range scores are dropped (we'd rather have a
  // smaller honest map than fabricate a clamped value).
  const cleanScores = {};
  const dropped = [];
  for (const [lang, raw] of Object.entries(scoresIn)) {
    if (typeof lang !== 'string' || lang.length === 0) { dropped.push(String(lang)); continue; }
    const n = Number(raw);
    if (!Number.isFinite(n)) { dropped.push(lang); continue; }
    if (n < 0 || n > 1) { dropped.push(lang); continue; }
    cleanScores[lang] = _round4(n);
  }

  const written = {};
  const langKeys = Object.keys(cleanScores).sort();
  if (langKeys.length === 0) {
    // Honest sentinel - we were asked to write the block but no valid
    // scores survived sanitization. Operators see "we tried" rather
    // than thinking the block is missing.
    written[PER_LANG_KSCORE_KEY] = {
      version: LINGUAL_MANIFEST_VERSION,
      by_lang: {},
      languages_reported: [],
      gated_at_n: gatedAtN,
      dropped_lang_keys: dropped.sort(),
      no_per_lang_scores: true,
      at: new Date().toISOString(),
    };
  } else {
    written[PER_LANG_KSCORE_KEY] = {
      version: LINGUAL_MANIFEST_VERSION,
      by_lang: cleanScores,
      languages_reported: langKeys,
      gated_at_n: gatedAtN,
      dropped_lang_keys: dropped.sort(),
      no_per_lang_scores: false,
      at: new Date().toISOString(),
    };
  }
  if (distIn) {
    // Pass through the distribution snapshot verbatim - we don't validate
    // its shape because W833-1 distributionByLang already emits a stable
    // {by_lang, total, underrepresented, version} envelope.
    written[OVERALL_LANG_DIST_KEY] = {
      version: LINGUAL_MANIFEST_VERSION,
      ...distIn,
    };
  }

  // Copy-on-write - caller can diff old vs new.
  const newManifest = { ...m, ...written };

  return {
    ok: true,
    version: LINGUAL_MANIFEST_VERSION,
    manifest: newManifest,
    written,
  };
}

// =============================================================================
// readPerLangKScores
//
// Read the per-language K-Score block from an artifact manifest. Returns
// null + honest reason when the block is missing - NEVER returns {} that
// looks like "evaluated everywhere and scored 0."
//
// Input:
//   manifest:   any object (or null/undefined)
//
// Output:
//   { ok:true, by_lang:{en:0.78, ...}, languages_reported, gated_at_n,
//     dropped_lang_keys, no_per_lang_scores, at, version }
//   OR
//   { ok:false, error:'no_per_lang_kscore_block'|'manifest_required', ... }
// =============================================================================

export function readPerLangKScores(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    return {
      ok: false,
      error: 'manifest_required',
      hint: 'pass an artifact manifest object',
      version: LINGUAL_MANIFEST_VERSION,
    };
  }
  const block = manifest[PER_LANG_KSCORE_KEY];
  if (!block || typeof block !== 'object') {
    return {
      ok: false,
      error: 'no_per_lang_kscore_block',
      hint: 'manifest lacks ' + PER_LANG_KSCORE_KEY + ' - call annotateManifest() first',
      version: LINGUAL_MANIFEST_VERSION,
    };
  }
  return {
    ok: true,
    version: LINGUAL_MANIFEST_VERSION,
    by_lang: (block.by_lang && typeof block.by_lang === 'object') ? { ...block.by_lang } : {},
    languages_reported: Array.isArray(block.languages_reported) ? block.languages_reported.slice() : [],
    gated_at_n: Number.isFinite(block.gated_at_n) ? block.gated_at_n : null,
    dropped_lang_keys: Array.isArray(block.dropped_lang_keys) ? block.dropped_lang_keys.slice() : [],
    no_per_lang_scores: block.no_per_lang_scores === true,
    at: typeof block.at === 'string' ? block.at : null,
    overall_lang_distribution: (manifest[OVERALL_LANG_DIST_KEY] && typeof manifest[OVERALL_LANG_DIST_KEY] === 'object')
      ? { ...manifest[OVERALL_LANG_DIST_KEY] }
      : null,
  };
}

// =============================================================================
// helpers
// =============================================================================

function _round4(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10000) / 10000;
}

export default {
  LINGUAL_MANIFEST_VERSION,
  PER_LANG_KSCORE_KEY,
  OVERALL_LANG_DIST_KEY,
  annotateManifest,
  readPerLangKScores,
};
