// W760 - Synthetic multilingual augmentation.
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
//     injected (W749 lineage - teacher_caller pattern) so tests never
//     hit a real translation API.
//   - HONESTY: every translated row carries source_type:'synthetic' and
//     synthetic_kind:'translation' packed into the feedback JSON blob.
//     The source_type enum is W749's CANONICAL value - we don't invent
//     a new "translated" enum.
//   - SPEND PROTECTION: dry_run=true by default. Callers must explicitly
//     pass dry_run=false AND a dependency-injected teacher_caller before any
//     translation actually fires. This module intentionally does not spawn a
//     KOLM_TRANSLATOR_CMD subprocess; that would widen the execution boundary.
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
export const MULTI_AUGMENT_CONTRACT_VERSION = 'w711-v1';
export const MULTI_AUGMENT_LIMITS = Object.freeze({
  max_source_rows: 500,
  max_targets_per_row: 10,
  max_total_calls: 5000,
  max_text_chars: 12000,
  max_translator_output_chars: 24000,
  max_errors: 100,
  max_id_chars: 128,
});

const DEFAULT_MIN_PER_LANG = 50;
const COST_PER_CALL_USD = 0.002;

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
// caller explicitly passes `target_langs` - otherwise the report only
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
      : 'No underrepresented languages found - corpus is balanced',
    version: MULTI_AUGMENT_VERSION,
    contract_version: MULTI_AUGMENT_CONTRACT_VERSION,
  };
}

// =============================================================================
// requestMultilingualAugmentation
//
// For each source row, request translations into each target language.
// DI translator (teacher_caller) - exactly the W749 contract so tests can
// inject a stub. Honest envelope when no caller is configured AND
// dry_run=false.
//
// Inputs:
//   source_rows:    [{cid?, input, output, ...}]
//   target_langs:   ['es', 'fr', 'de']
//   teacher_caller: async ({input, output, target_lang, source_lang}) =>
//                      JSON string with {input, output} translated
//   dry_run:        default true - returns plan without calling
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
  const sourceInfo = _normalizeSourceRows(o.source_rows);
  const sourceRows = sourceInfo.rows;
  const targetInfo = _normalizeTargetLangs(o.target_langs);
  const targetLangs = targetInfo.target_langs;
  const teacherCaller = (typeof o.teacher_caller === 'function') ? o.teacher_caller : null;
  const dryRun = o.dry_run !== false; // default true

  if (sourceRows.length === 0) {
    return {
      ok: false,
      error: 'empty_source_rows',
      hint: 'pass {source_rows:[...]} with at least one row to augment',
      version: MULTI_AUGMENT_VERSION,
      contract_version: MULTI_AUGMENT_CONTRACT_VERSION,
    };
  }
  if (targetLangs.length === 0) {
    return {
      ok: false,
      error: 'empty_target_langs',
      hint: 'pass {target_langs:[...]} naming the ISO codes to translate into',
      version: MULTI_AUGMENT_VERSION,
      contract_version: MULTI_AUGMENT_CONTRACT_VERSION,
      invalid_target_langs: targetInfo.invalid_target_langs,
    };
  }

  // Build the plan up front (cost estimate, target count).
  const plan = _buildPlan(sourceInfo, targetInfo);

  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      plan,
      version: MULTI_AUGMENT_VERSION,
      contract_version: MULTI_AUGMENT_CONTRACT_VERSION,
    };
  }

  // Real run requires a translator. HONEST envelope when missing.
  if (!teacherCaller) {
    return {
      ok: false,
      error: 'no_translator_configured',
      hint: 'Pass a dependency-injected teacher_caller; multilingual augmentation requires an explicit translation backend',
      plan,
      version: MULTI_AUGMENT_VERSION,
      contract_version: MULTI_AUGMENT_CONTRACT_VERSION,
    };
  }

  // Fan out. Each (row, target) tuple is one translator call.
  const augmented = [];
  const errors = [];
  let nCalls = 0;
  let nSuccess = 0;
  let nFailed = 0;
  for (const row of sourceRows) {
    const input = row.input;
    const output = row.output;
    const sourceLang = row.source_lang;
    const sourceCid = row.source_cid;
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
        const generationId = _stableId([
          sourceCid || '',
          sourceLang,
          targetLang,
          input,
          output,
          parsed.input,
          parsed.output,
        ].join('|'));
        augmented.push({
          input: parsed.input,
          output: parsed.output,
          target_lang: targetLang,
          source_lang: sourceLang,
          source_cid: sourceCid,
          source_type: 'synthetic',          // W749 CANONICAL enum
          synthetic_kind: 'translation',     // packed into feedback
          generation_id: generationId,
          translation_truncated: Boolean(row.text_truncated || parsed.truncated),
          version: MULTI_AUGMENT_VERSION,
          contract_version: MULTI_AUGMENT_CONTRACT_VERSION,
        });
        nSuccess += 1;
      } catch (e) {
        nFailed += 1;
        if (errors.length < MULTI_AUGMENT_LIMITS.max_errors) {
          errors.push({
            source_cid: sourceCid,
            target_lang: targetLang,
            ..._safeTranslatorError(e),
          });
        }
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
    errors_truncated: nFailed > errors.length,
    plan,
    version: MULTI_AUGMENT_VERSION,
    contract_version: MULTI_AUGMENT_CONTRACT_VERSION,
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
// The feedback blob mirrors W749 + W411 - downstream consumers that read
// source_type can filter; consumers that need the detail parse feedback
// JSON. We do NOT mutate the original_rows array - return a NEW array.
// =============================================================================

export function mergeAugmentedRows(originalRows, augmentedRows) {
  const orig = Array.isArray(originalRows) ? originalRows : [];
  const aug = Array.isArray(augmentedRows) ? augmentedRows.slice(0, MULTI_AUGMENT_LIMITS.max_total_calls) : [];
  const out = orig.slice();
  for (const a of aug) {
    if (!a || typeof a !== 'object') continue;
    const targetLang = _safeLang(a.target_lang);
    const sourceLang = _safeLang(a.source_lang);
    const input = _boundedText(a.input).text;
    const output = _boundedText(a.output).text;
    if (input.length === 0 && output.length === 0) continue;
    const sourceCid = _safeId(a.source_cid);
    const generationId = _safeId(a.generation_id)
      || _stableId([sourceCid || '', sourceLang || '', targetLang || '', input, output].join('|'));
    const feedback = {
      synthetic_kind: a.synthetic_kind || 'translation',
      target_lang: targetLang,
      source_lang: sourceLang,
      source_cid: sourceCid,
      generation_id: generationId,
      translation_truncated: Boolean(a.translation_truncated),
      multi_augment_version: a.version || MULTI_AUGMENT_VERSION,
      contract_version: MULTI_AUGMENT_CONTRACT_VERSION,
    };
    out.push({
      input,
      output,
      namespace: _safeId(a.namespace) || null,
      lang: targetLang,
      source_type: 'synthetic',                   // W749 CANONICAL enum
      feedback: JSON.stringify(feedback),
      cid: 'mau_' + _stableId(generationId + '|' + targetLang),
    });
  }
  return out;
}

// =============================================================================
// helpers
// =============================================================================

function _parseTranslatorRow(raw) {
  if (raw == null) return { input: '', output: '' };
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const input = _boundedText(raw.input);
    const output = _boundedText(raw.output);
    return {
      input: input.text,
      output: output.text,
      truncated: input.truncated || output.truncated,
    };
  }
  const limited = _boundedText(String(raw), MULTI_AUGMENT_LIMITS.max_translator_output_chars);
  const s = limited.text;
  try {
    const obj = JSON.parse(s);
    if (obj && typeof obj === 'object' && (obj.input != null || obj.output != null)) {
      const input = _boundedText(obj.input);
      const output = _boundedText(obj.output);
      return {
        input: input.text,
        output: output.text,
        truncated: limited.truncated || input.truncated || output.truncated,
      };
    }
  } catch (_) { /* fall through */ }
  return { input: '', output: s, truncated: limited.truncated };
}

function _normalizeSourceRows(rawRows) {
  const raw = Array.isArray(rawRows) ? rawRows : [];
  const rows = [];
  let skipped_empty = 0;
  let skipped_invalid = 0;
  let text_truncated_rows = 0;
  for (const row of raw.slice(0, MULTI_AUGMENT_LIMITS.max_source_rows)) {
    if (!row || typeof row !== 'object') {
      skipped_invalid += 1;
      continue;
    }
    const inputBound = _boundedText(row.input);
    const outputBound = _boundedText(row.output);
    const input = inputBound.text;
    const output = outputBound.text;
    if (input.length === 0 && output.length === 0) {
      skipped_empty += 1;
      continue;
    }
    if (inputBound.truncated || outputBound.truncated) text_truncated_rows += 1;
    rows.push({
      input,
      output,
      source_lang: _safeLang((detectLang(input) || {}).lang) || 'unknown',
      source_cid: _safeId(row.cid || row.event_id),
      text_truncated: inputBound.truncated || outputBound.truncated,
    });
  }
  return {
    rows,
    source_rows_seen: raw.length,
    source_rows_used: rows.length,
    source_rows_truncated: raw.length > MULTI_AUGMENT_LIMITS.max_source_rows,
    skipped_empty,
    skipped_invalid,
    text_truncated_rows,
  };
}

function _normalizeTargetLangs(rawTargets) {
  const raw = Array.isArray(rawTargets) ? rawTargets : [];
  const target_langs = [];
  const invalid_target_langs = [];
  const seen = new Set();
  for (const item of raw) {
    const lang = String(item == null ? '' : item).trim().toLowerCase();
    if (!SUPPORTED_LANGS.includes(lang)) {
      if (invalid_target_langs.length < MULTI_AUGMENT_LIMITS.max_targets_per_row) invalid_target_langs.push(lang || null);
      continue;
    }
    if (seen.has(lang)) continue;
    seen.add(lang);
    if (target_langs.length < MULTI_AUGMENT_LIMITS.max_targets_per_row) target_langs.push(lang);
  }
  return {
    target_langs,
    invalid_target_langs,
    target_langs_truncated: seen.size > MULTI_AUGMENT_LIMITS.max_targets_per_row,
  };
}

function _buildPlan(sourceInfo, targetInfo) {
  let nEstimatedCalls = 0;
  let skippedSelfTranslations = 0;
  for (const row of sourceInfo.rows) {
    for (const targetLang of targetInfo.target_langs) {
      if (targetLang === row.source_lang) {
        skippedSelfTranslations += 1;
      } else {
        nEstimatedCalls += 1;
      }
    }
  }
  nEstimatedCalls = Math.min(nEstimatedCalls, MULTI_AUGMENT_LIMITS.max_total_calls);
  return {
    n_rows: sourceInfo.source_rows_used,
    n_source_rows_seen: sourceInfo.source_rows_seen,
    n_source_rows_used: sourceInfo.source_rows_used,
    source_rows_truncated: sourceInfo.source_rows_truncated,
    skipped_empty_rows: sourceInfo.skipped_empty,
    skipped_invalid_rows: sourceInfo.skipped_invalid,
    text_truncated_rows: sourceInfo.text_truncated_rows,
    n_targets: targetInfo.target_langs.length,
    n_estimated_calls: nEstimatedCalls,
    skipped_self_translations: skippedSelfTranslations,
    estimated_cost_usd: _round4(nEstimatedCalls * COST_PER_CALL_USD),
    targets: targetInfo.target_langs,
    invalid_target_langs: targetInfo.invalid_target_langs,
    target_langs_truncated: targetInfo.target_langs_truncated,
    cost_per_call_usd: COST_PER_CALL_USD,
    limits: { ...MULTI_AUGMENT_LIMITS },
    version: MULTI_AUGMENT_VERSION,
    contract_version: MULTI_AUGMENT_CONTRACT_VERSION,
  };
}

function _boundedText(value, maxChars = MULTI_AUGMENT_LIMITS.max_text_chars) {
  let text = String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const truncated = text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars);
  return { text, truncated };
}

function _safeId(value) {
  const s = String(value == null ? '' : value)
    .replace(/[^A-Za-z0-9_.:-]/g, '_')
    .slice(0, MULTI_AUGMENT_LIMITS.max_id_chars);
  return s.length > 0 ? s : null;
}

function _safeLang(value) {
  const lang = String(value == null ? '' : value).trim().toLowerCase();
  return SUPPORTED_LANGS.includes(lang) ? lang : null;
}

function _safeTranslatorError(e) {
  const codeRaw = e && (e.code || e.name);
  const code = /^[A-Za-z0-9_.:-]{1,64}$/.test(String(codeRaw || ''))
    ? String(codeRaw)
    : 'translator_error';
  const msg = String((e && e.message) || e || '');
  return {
    error: code,
    error_digest: crypto.createHash('sha256').update(msg).digest('hex').slice(0, 16),
  };
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
  MULTI_AUGMENT_CONTRACT_VERSION,
  MULTI_AUGMENT_LIMITS,
  identifyUnderrepresentedLangs,
  requestMultilingualAugmentation,
  mergeAugmentedRows,
};
