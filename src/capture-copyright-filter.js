// W708-4 + W1022 - Copyright risk flagger for capture rows.
//
// kolm.ai captures user inputs/outputs as training data. External reviewer
// flagged the risk that captures could contain copyrighted material (book
// excerpts, news articles, song lyrics, paywalled content). This module
// observes captures and stamps `copyright_flagged` + `copyright_reasons[]`
// onto the row so downstream code (distill-time, dataset workbench, label
// queue) can choose to filter or quarantine.
//
// Design intent:
//   - OBSERVABILITY ONLY. This module never blocks a capture write. The
//     wiring site (capture-store.js insertCapture) calls attachCopyrightFlag
//     inside a try/catch so any failure here is silent.
//   - Bounded + local. The scanner is dependency-free, caps bytes scanned, and
//     reuses the in-repo copyright fingerprint detector instead of calling an
//     external classifier from the capture hot path.
//   - Low-confidence reasons are flagged as such so downstream consumers can
//     decide whether to act on prose-shape heuristics (high comma density,
//     long lines) versus high-confidence matches (literal "Subscribe to read
//     more", "© 2024 NYT Co.").
//
// Returns a structured envelope; never throws on malformed input.

import { scanText as scanCopyrightFingerprints } from './copyright-detector.js';

export const CAPTURE_COPYRIGHT_FILTER_VERSION = 'w1022-license-aware-copyright-filter-v1';

// Hardcoded corpus of high-confidence copyright-risk markers. Keep small and
// obvious. Each entry is a literal lowercase substring matched against the
// lowercased capture text. If you grow this list past ~30 entries, refactor
// into a separate datafile and load lazily.
const FLAGGED_PHRASES = [
  // Paywall / subscription boilerplate (newspapers, magazines)
  'subscribe to read more',
  'subscribe to continue reading',
  'this article is for subscribers',
  'you have reached your free article limit',
  'sign in to read the full article',
  'become a member to access',
  // News-org footers
  'all rights reserved',
  'reproduction in whole or in part',
  'unauthorized reproduction or distribution',
  'this content is protected by copyright',
  // Song-lyrics markers (common in lyrics-site scrapes)
  '[verse 1]',
  '[chorus]',
  '[bridge]',
  '[outro]',
  'lyrics provided by',
  // Book excerpt markers
  'excerpted from',
  'reprinted by permission of',
  'from the book',
  'published by penguin',
  'published by random house',
  'published by harpercollins',
  // Academic / paywalled-journal boilerplate
  'this article is available to subscribers only',
  'institutional access required',
  'purchase this article',
  // DMCA / takedown language often present in scraped pages
  'dmca takedown',
  'copyrighted material owned by',
];

// Regex anchors for in-text copyright + year. We look near the start of the
// text (first 500 chars) to avoid flagging incidental "© 2024" in some tail
// boilerplate that the model itself added.
const COPYRIGHT_YEAR_RE = /(©|copyright\s*\(c\)|copyright\s+©|\(c\)\s*\d{4})\s*\d{4}/i;

// Heuristic threshold for the "single line of prose" detector: a line is
// suspected prose if it's >200 chars AND has high comma density (>= 1 comma
// per 80 chars). This is low confidence - it catches book paragraphs but
// also catches anyone explaining something in long sentences.
const PROSE_LINE_MIN_LEN = 200;
const PROSE_LINE_COMMA_DENSITY = 1 / 80;
const LONGFORM_SOURCE_MIN_CHARS = 300;
const FINGERPRINT_RISK_WEIGHT = 0.25;

const PERMISSIVE_LICENSES = new Set([
  'apache-2.0',
  'mit',
  'bsd-2-clause',
  'bsd-3-clause',
  'isc',
  'cc0-1.0',
  'cc-by-4.0',
  'public-domain',
  'unlicense',
]);

const RESTRICTED_LICENSES = new Set([
  'all-rights-reserved',
  'proprietary',
  'closed',
  'unknown',
  'cc-by-nc-4.0',
  'cc-by-nc-sa-4.0',
  'cc-by-nd-4.0',
  'cc-by-nc-nd-4.0',
]);

const SOURCE_TYPES_REQUIRING_LICENSE = new Set([
  'article',
  'book',
  'dataset',
  'pdf',
  'public_corpus',
  'scrape',
  'web',
  'webpage',
]);

function toFlaggableText(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'number' || typeof input === 'boolean') return String(input);
  try {
    return JSON.stringify(input);
  } catch (_) {
    return String(input);
  }
}

function normalizeLicense(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  if (!s) return null;
  return s
    .replace(/^spdx:/, '')
    .replace(/^license:/, '')
    .replace(/\s+/g, '-')
    .replace(/_/g, '-');
}

function pickSourceLicense(opts = {}) {
  return opts.source_license
    ?? opts.license
    ?? opts.content_license
    ?? opts.dataset_license
    ?? opts.metadata?.source_license
    ?? opts.metadata?.license
    ?? null;
}

function pickSourceType(opts = {}) {
  return opts.source_type
    ?? opts.source_kind
    ?? opts.capture_source
    ?? opts.metadata?.source_type
    ?? opts.metadata?.source_kind
    ?? null;
}

function licensePolicyFor(opts = {}, scanChars = 0) {
  const normalized = normalizeLicense(pickSourceLicense(opts));
  const sourceType = pickSourceType(opts);
  const normalizedSourceType = sourceType == null ? null : String(sourceType).trim().toLowerCase();
  const sourceRequiresLicense = SOURCE_TYPES_REQUIRING_LICENSE.has(normalizedSourceType || '');
  const requireLicense = opts.require_source_license === true
    || (sourceRequiresLicense && scanChars >= LONGFORM_SOURCE_MIN_CHARS);
  const permitted = normalized ? PERMISSIVE_LICENSES.has(normalized) : false;
  const restricted = normalized ? RESTRICTED_LICENSES.has(normalized) : false;
  return {
    source_type: normalizedSourceType,
    normalized_license: normalized,
    permitted,
    restricted,
    require_source_license: requireLicense,
    missing_required_license: requireLicense && !normalized,
    version: CAPTURE_COPYRIGHT_FILTER_VERSION,
  };
}

function pushReason(result, reason) {
  if (!result.reasons.includes(reason)) result.reasons.push(reason);
}

function addRisk(result, score) {
  result.risk_score = Math.min(1, Math.max(0, result.risk_score + score));
  if (result.risk_score > 0) result.flagged = true;
}

// Flag a single text blob for copyright risk. Returns:
//   { flagged: boolean, reasons: string[], matched_phrases: string[] }
//
// `reasons` are short tags (e.g. 'paywall-boilerplate', 'copyright-header',
// 'possibly-copyrighted-prose'). `matched_phrases` is the subset of
// FLAGGED_PHRASES literally found in the text - useful for human review.
//
// opts:
//   - max_scan_chars: cap how much of the text to scan (default 32K)
export function flagCopyrightRisk(captureText, opts = {}) {
  const result = {
    flagged: false,
    reasons: [],
    matched_phrases: [],
    fingerprint_hits: [],
    risk_score: 0,
    scanned_chars: 0,
    license_policy: null,
    version: CAPTURE_COPYRIGHT_FILTER_VERSION,
  };
  const text = toFlaggableText(captureText);
  if (!text) return result;
  const maxScan = Number(opts && opts.max_scan_chars) || 32768;
  const scan = text.length > maxScan ? text.slice(0, maxScan) : text;
  result.scanned_chars = scan.length;
  const lower = scan.toLowerCase();

  // High-confidence substring matches against the hardcoded corpus.
  for (const phrase of FLAGGED_PHRASES) {
    if (lower.includes(phrase)) {
      result.matched_phrases.push(phrase);
    }
  }
  if (result.matched_phrases.length > 0) {
    addRisk(result, 0.75);
    pushReason(result, 'flagged-phrase-match');
  }

  // Copyright header near the start of the text.
  const head = scan.slice(0, 500);
  if (COPYRIGHT_YEAR_RE.test(head)) {
    addRisk(result, 0.75);
    pushReason(result, 'copyright-header');
  }

  // W1022: reuse the richer local fingerprint pack so this hot-path filter is
  // not weaker than the staged-capture quarantine scanner.
  const fingerprint = scanCopyrightFingerprints(scan, { max_scan_chars: maxScan });
  if (fingerprint.ok && Array.isArray(fingerprint.hits) && fingerprint.hits.length > 0) {
    result.fingerprint_hits = fingerprint.hits.slice(0, 16).map((hit) => ({
      kind: hit.kind,
      matched: hit.matched,
      index: hit.index,
    }));
    addRisk(result, Math.min(1, fingerprint.risk_score || (result.fingerprint_hits.length * FINGERPRINT_RISK_WEIGHT)));
    pushReason(result, 'copyright-fingerprint-match');
  }

  // Low-confidence prose heuristic: any single line >200 chars with high
  // comma density. Mark explicitly as low-confidence so downstream consumers
  // can choose whether to treat it as actionable.
  const lines = scan.split(/\r?\n/);
  for (const line of lines) {
    if (line.length < PROSE_LINE_MIN_LEN) continue;
    const commaCount = (line.match(/,/g) || []).length;
    const density = commaCount / line.length;
    if (density >= PROSE_LINE_COMMA_DENSITY) {
      addRisk(result, 0.25);
      pushReason(result, 'possibly-copyrighted-prose:low-confidence');
      break; // one suspicious line is enough; don't spam reasons
    }
  }

  // W1022: license-aware local policy. This is still not a legal verdict; it
  // makes source provenance explicit and gives downstream filters a stable
  // reason when a web/public-corpus row lacks an allowed source license.
  const policy = licensePolicyFor(opts, scan.length);
  result.license_policy = policy;
  if (policy.restricted) {
    addRisk(result, 1);
    pushReason(result, 'source-license-disallowed');
  } else if (policy.missing_required_license) {
    addRisk(result, 0.5);
    pushReason(result, 'source-license-missing');
  }

  return result;
}

// Attach copyright_flagged + copyright_reasons to a capture/event row in
// place. Scans both the prompt and response sides. Pure mutation - returns
// the same row so it can be chained. Never throws (silently no-ops on
// malformed input so it can be wrapped in try/catch by the wiring site).
//
// Field names:
//   eventRow.copyright_flagged: boolean
//   eventRow.copyright_reasons: string[]      (combined, deduped)
//   eventRow.copyright_matched_phrases: string[]  (combined, deduped, capped)
//   eventRow.copyright_fingerprint_hits: string[] (combined, capped)
//   eventRow.copyright_risk_score: number 0..1
//   eventRow.copyright_policy: source-license policy envelope
export function attachCopyrightFlag(eventRow) {
  if (!eventRow || typeof eventRow !== 'object') return eventRow;
  try {
    // Capture rows use { prompt, response } (capture-store), event-store rows
    // use { prompt_redacted, response_redacted }. Try both so this works at
    // either layer.
    const inputText = eventRow.prompt != null ? eventRow.prompt : eventRow.prompt_redacted;
    const outputText = eventRow.response != null ? eventRow.response : eventRow.response_redacted;
    const meta = {
      source_type: eventRow.source_type || eventRow.capture_source || eventRow.content_source || null,
      source_license: eventRow.source_license || eventRow.content_license || eventRow.dataset_license || eventRow.license || null,
    };

    const inFlag = flagCopyrightRisk(inputText, meta);
    const outFlag = flagCopyrightRisk(outputText, meta);

    const flagged = inFlag.flagged || outFlag.flagged;
    const reasons = Array.from(new Set([...inFlag.reasons, ...outFlag.reasons]));
    const matched = Array.from(new Set([...inFlag.matched_phrases, ...outFlag.matched_phrases])).slice(0, 16);
    const fingerprints = [...inFlag.fingerprint_hits, ...outFlag.fingerprint_hits]
      .map((hit) => ({ kind: hit.kind, matched: hit.matched }))
      .slice(0, 16);

    eventRow.copyright_flagged = flagged;
    eventRow.copyright_reasons = reasons;
    eventRow.copyright_matched_phrases = matched;
    eventRow.copyright_fingerprint_hits = fingerprints;
    eventRow.copyright_risk_score = Math.max(inFlag.risk_score || 0, outFlag.risk_score || 0);
    eventRow.copyright_policy = {
      version: CAPTURE_COPYRIGHT_FILTER_VERSION,
      input: inFlag.license_policy,
      output: outFlag.license_policy,
    };
  } catch (_) {
    // Honesty contract: if scanning fails for any reason, stamp the row with
    // a "scan failed" marker so downstream can tell apart "not flagged" from
    // "we don't know." Do NOT throw.
    try {
      eventRow.copyright_flagged = false;
      eventRow.copyright_reasons = ['scan-error'];
      eventRow.copyright_matched_phrases = [];
      eventRow.copyright_fingerprint_hits = [];
      eventRow.copyright_risk_score = 0;
      eventRow.copyright_policy = { version: CAPTURE_COPYRIGHT_FILTER_VERSION, error: 'scan-error' };
    } catch (_) { /* row is frozen or otherwise unwritable - give up */ }
  }
  return eventRow;
}

// Exported for tests + introspection. Not part of the stable API contract.
export const _internals = {
  FLAGGED_PHRASES,
  COPYRIGHT_YEAR_RE,
  PROSE_LINE_MIN_LEN,
  PROSE_LINE_COMMA_DENSITY,
  LONGFORM_SOURCE_MIN_CHARS,
  PERMISSIVE_LICENSES,
  RESTRICTED_LICENSES,
  SOURCE_TYPES_REQUIRING_LICENSE,
  normalizeLicense,
  licensePolicyFor,
};
