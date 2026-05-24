// W760 — Synthetic multilingual augmentation.
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 549-553):
//   [W760-2] Synthetic multilingual augmentation
//
// Why: a corpus that's 95% English will produce a student that fails on
// Spanish (W760 #2). We surface UNDER-REPRESENTED languages (W760-1's
// langStats), then optionally fan-out per row through a translation
// backend so the student sees parallel examples in every target language.
//
// Design contract:
//   - PURE shape utilities here. The translation backend is dependency-
//     injected (W749 lineage — teacher_caller pattern) so tests never
//     hit a real translation API.
//   - HONESTY: every translated row carries source_type:'synthetic' and
//     synthetic_kind:'translation' packed into the feedback JSON blob.
//     The source_type enum is W749's CANONICAL value — we don't invent
//     a new "translated" enum.
//   - SPEND PROTECTION: dry_run=true by default. Callers must explicitly
//     pass dry_run=false AND a teacher_caller (or KOLM_TRANSLATOR_CMD)
//     before any translation actually fires.
//
// Public surface:
//   - MULTI_AUGMENT_VERSION
//   - identifyUnderrepresentedLangs({rows, min_per_lang})
//   - requestMultilingualAugmentation({source_rows, target_langs,
//                                       teacher_caller, dry_run})
//   - mergeAugmentedRows(original_rows, augmented_rows)

import crypto from 'node:crypto';
import { langStats, detectLang, SUPPORTED_LANGS } from './lang-detect.js';

export const MULTI_AUGMENT_VERSION = 'w760-v1';

const DEFAULT_MIN_PER_LANG = 50;
const MAX_TARGETS_PER_ROW = 10;

// =============================================================================
// identifyUnderrepresentedLangs
//
// Walk the row set, compute per-language counts via langStats, return
// the languages that fall below `min_per_lang`.
//
// Returns:
//   { ok:true, underrepresented:[{lang, current_count, needed}],
//     total, by_lang_stats, version,
//     hint: 'Each underrepresented language needs <needed> more captures...' }
//
// Note: under-represented can include languages that are NOT YET in the
// corpus at all (current_count=0). For those we only surface them if the
// caller explicitly passes `target_langs` — otherwise the report only
// covers languages we already see traffic for.
// =============================================================================

export function identifyUnderrepresentedLangs(opts) {
  const o = opts || {};
  const rows = Array.isArray(o.rows) ? o.rows : [];
  const minPer = Number.isFinite(o.min_per_lang)
    ? Math.max(1, Math.trunc(o.min_per_lang))
    : DEFAULT_MIN_PER_LANG;
  const targetLangs = Array.isArray(o.target_langs)
    ? o.target_langs.filter((l) => SUPPORTED_LANGS.includes(l))
    : null;

  const stats = langStats(rows);
  const under = [];
  // For every language that has any rows, check the floor.
  for (const lang of SUPPORTED_LANGS) {
    const current = stats.by_lang[lang] || 0;
    // If targetLangs is supplied, ALWAYS surface those (even count=0).
    // Otherwise only surface langs the corpus already has, under the floor.
    const inTargets = targetLangs ? targetLangs.includes(lang) : false;
    if (current < minPer && (inTargets || current > 0)) {
      under.push({
        lang,
        current_count: current,
        needed: Math.max(0, minPer - current),
      });
    }
  }
  // Sort by needed desc (most-needed first), tiebreak by lang asc.
  under.sort((a, b) => {
    if (b.needed !== a.needed) return b.needed - a.needed;
    return a.lang < b.lang ? -1 : 1;
  });

  return {
    ok: true,
    underrepresented: under,
    total: rows.length,
    by_lang_stats: stats,
    min_per_lang: minPer,
    hint: under.length > 0
      ? 'Each underrepresented language needs the listed number of additional captures (or synthetic augmentation via W760-2)'
      : 'No underrepresented languages found — corpus is balanced',
    version: MULTI_AUGMENT_VERSION,
  };
}

// =============================================================================
// requestMultilingualAugmentation
//
// For each source row, request translations into each target language.
// DI translator (teacher_caller) — exactly the W749 contract so tests can
// inject a stub. Honest envelope when no caller is configured AND
// dry_run=false.
//
// Inputs:
//   source_rows:    [{cid?, input, output, ...}]
//   target_langs:   ['es', 'fr', 'de']
//   teacher_caller: async ({input, output, target_lang, source_lang}) =>
//                      JSON string with {input, output} translated
//   dry_run:        default true — returns plan without calling
//
// Output:
//   dry_run=true:
//     {ok:true, dry_run:true, plan:{n_rows, n_targets, n_estimated_calls,
//       estimated_cost_usd, targets, version}}
//   dry_run=false + caller:
//     {ok:true, augmented:[{input, output, target_lang, source_lang,
//       source_cid, source_type:'synthetic', synthetic_kind:'translation'}],
//       n_calls, n_success, n_failed, errors, version}
//   dry_run=false + NO caller:
//     {ok:false, error:'no_translator_configured', hint:'...', version}
// =============================================================================

export async function requestMultilingualAugmentation(opts) {
  const o = opts || {};
  const sourceRows = Array.isArray(o.source_rows) ? o.source_rows : [];
  const targetLangs = (Array.isArray(o.target_langs) ? o.target_langs : [])
    .filter((l) => SUPPORTED_LANGS.includes(l))
    .slice(0, MAX_TARGETS_PER_ROW);
  const teacherCaller = (typeof o.teacher_caller === 'function') ? o.teacher_caller : null;
  const dryRun = o.dry_run !== false; // default true

  if (sourceRows.length === 0) {
    return {
      ok: false,
      error: 'empty_source_rows',
      hint: 'pass {source_rows:[...]} with at least one row to augment',
      version: MULTI_AUGMENT_VERSION,
    };
  }
  if (targetLangs.length === 0) {
    return {
      ok: false,
      error: 'empty_target_langs',
      hint: 'pass {target_langs:[...]} naming the ISO codes to translate into',
      version: MULTI_AUGMENT_VERSION,
    };
  }

  // Build the plan up front (cost estimate, target count).
  const plan = {
    n_rows: sourceRows.length,
    n_targets: targetLangs.length,
    n_estimated_calls: sourceRows.length * targetLangs.length,
    estimated_cost_usd: _round4(sourceRows.length * targetLangs.length * 0.002),
    targets: targetLangs,
    cost_per_call_usd: 0.002,
    version: MULTI_AUGMENT_VERSION,
  };

  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      plan,
      version: MULTI_AUGMENT_VERSION,
    };
  }

  // Real run requires a translator. HONEST envelope when missing.
  if (!teacherCaller) {
    return {
      ok: false,
      error: 'no_translator_configured',
      hint: 'Set KOLM_TRANSLATOR_CMD or pass --translator; multilingual augmentation requires a translation backend',
      plan,
      version: MULTI_AUGMENT_VERSION,
    };
  }

  // Fan out. Each (row, target) tuple is one translator call.
  const augmented = [];
  const errors = [];
  let nCalls = 0;
  let nSuccess = 0;
  let nFailed = 0;
  for (const row of sourceRows) {
    if (!row || typeof row !== 'object') continue;
    const input = String(row.input == null ? '' : row.input);
    const output = String(row.output == null ? '' : row.output);
    if (input.length === 0 && output.length === 0) continue;
    const sourceLang = (detectLang(input) || {}).lang || 'unknown';
    const sourceCid = row.cid || row.event_id || null;
    for (const targetLang of targetLangs) {
      if (targetLang === sourceLang) continue; // don't translate to self
      nCalls += 1;
      try {
        const raw = await teacherCaller({
          input,
          output,
          target_lang: targetLang,
          source_lang: sourceLang,
        });
        const parsed = _parseTranslatorRow(raw);
        augmented.push({
          input: parsed.input,
          output: parsed.output,
          target_lang: targetLang,
          source_lang: sourceLang,
          source_cid: sourceCid,
          source_type: 'synthetic',          // W749 CANONICAL enum
          synthetic_kind: 'translation',     // packed into feedback
          generation_id: _stableId(input + '|' + targetLang),
          version: MULTI_AUGMENT_VERSION,
        });
        nSuccess += 1;
      } catch (e) {
        nFailed += 1;
        errors.push({
          source_cid: sourceCid,
          target_lang: targetLang,
          error: String(e && e.message || e),
        });
      }
    }
  }

  return {
    ok: true,
    dry_run: false,
    augmented,
    n_calls: nCalls,
    n_success: nSuccess,
    n_failed: nFailed,
    errors,
    plan,
    version: MULTI_AUGMENT_VERSION,
  };
}

// =============================================================================
// mergeAugmentedRows
//
// Merge augmented rows into the original capture set. Each augmented row
// is stamped with:
//   - source_type: 'synthetic'              (W749 CANONICAL enum)
//   - feedback:    JSON blob containing synthetic_kind, target_lang,
//                  source_lang, source_cid, generation_id
//
// The feedback blob mirrors W749 + W411 — downstream consumers that read
// source_type can filter; consumers that need the detail parse feedback
// JSON. We do NOT mutate the original_rows array — return a NEW array.
// =============================================================================

export function mergeAugmentedRows(originalRows, augmentedRows) {
  const orig = Array.isArray(originalRows) ? originalRows : [];
  const aug = Array.isArray(augmentedRows) ? augmentedRows : [];
  const out = orig.slice();
  for (const a of aug) {
    if (!a || typeof a !== 'object') continue;
    const feedback = {
      synthetic_kind: a.synthetic_kind || 'translation',
      target_lang: a.target_lang || null,
      source_lang: a.source_lang || null,
      source_cid: a.source_cid || null,
      generation_id: a.generation_id || null,
      multi_augment_version: a.version || MULTI_AUGMENT_VERSION,
    };
    out.push({
      input: a.input,
      output: a.output,
      namespace: a.namespace || null,
      lang: a.target_lang || null,
      source_type: 'synthetic',                   // W749 CANONICAL enum
      feedback: JSON.stringify(feedback),
      cid: 'mau_' + crypto.randomBytes(6).toString('hex'),
    });
  }
  return out;
}

// =============================================================================
// helpers
// =============================================================================

function _parseTranslatorRow(raw) {
  if (raw == null) return { input: '', output: '' };
  const s = String(raw);
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === 'object' && (obj.input != null || obj.output != null)) {
      return {
        input: String(obj.input == null ? '' : obj.input),
        output: String(obj.output == null ? '' : obj.output),
      };
    }
  } catch (_) { /* fall through */ }
  return { input: '', output: s };
}

function _stableId(seed) {
  return crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 16);
}

function _round4(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10000) / 10000;
}

export default {
  MULTI_AUGMENT_VERSION,
  identifyUnderrepresentedLangs,
  requestMultilingualAugmentation,
  mergeAugmentedRows,
};
