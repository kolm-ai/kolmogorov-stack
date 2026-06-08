// W708-4 - Copyright risk flagger for capture rows.
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
//   - Small + obvious. The denylist below is intentionally tiny (~25 entries)
//     and matches things that scream "I am copyrighted prose." A real
//     content-classifier belongs in a worker package; this is the lightweight
//     in-process scanner that gets called on every capture.
//   - Low-confidence reasons are flagged as such so downstream consumers can
//     decide whether to act on prose-shape heuristics (high comma density,
//     long lines) versus high-confidence matches (literal "Subscribe to read
//     more", "© 2024 NYT Co.").
//
// Returns a structured envelope; never throws on malformed input.

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
  const result = { flagged: false, reasons: [], matched_phrases: [] };
  const text = toFlaggableText(captureText);
  if (!text) return result;
  const maxScan = Number(opts && opts.max_scan_chars) || 32768;
  const scan = text.length > maxScan ? text.slice(0, maxScan) : text;
  const lower = scan.toLowerCase();

  // High-confidence substring matches against the hardcoded corpus.
  for (const phrase of FLAGGED_PHRASES) {
    if (lower.includes(phrase)) {
      result.matched_phrases.push(phrase);
    }
  }
  if (result.matched_phrases.length > 0) {
    result.flagged = true;
    result.reasons.push('flagged-phrase-match');
  }

  // Copyright header near the start of the text.
  const head = scan.slice(0, 500);
  if (COPYRIGHT_YEAR_RE.test(head)) {
    result.flagged = true;
    if (!result.reasons.includes('copyright-header')) {
      result.reasons.push('copyright-header');
    }
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
      result.flagged = true;
      if (!result.reasons.includes('possibly-copyrighted-prose:low-confidence')) {
        result.reasons.push('possibly-copyrighted-prose:low-confidence');
      }
      break; // one suspicious line is enough; don't spam reasons
    }
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
export function attachCopyrightFlag(eventRow) {
  if (!eventRow || typeof eventRow !== 'object') return eventRow;
  try {
    // Capture rows use { prompt, response } (capture-store), event-store rows
    // use { prompt_redacted, response_redacted }. Try both so this works at
    // either layer.
    const inputText = eventRow.prompt != null ? eventRow.prompt : eventRow.prompt_redacted;
    const outputText = eventRow.response != null ? eventRow.response : eventRow.response_redacted;

    const inFlag = flagCopyrightRisk(inputText);
    const outFlag = flagCopyrightRisk(outputText);

    const flagged = inFlag.flagged || outFlag.flagged;
    const reasons = Array.from(new Set([...inFlag.reasons, ...outFlag.reasons]));
    const matched = Array.from(new Set([...inFlag.matched_phrases, ...outFlag.matched_phrases])).slice(0, 16);

    eventRow.copyright_flagged = flagged;
    eventRow.copyright_reasons = reasons;
    eventRow.copyright_matched_phrases = matched;
  } catch (_) {
    // Honesty contract: if scanning fails for any reason, stamp the row with
    // a "scan failed" marker so downstream can tell apart "not flagged" from
    // "we don't know." Do NOT throw.
    try {
      eventRow.copyright_flagged = false;
      eventRow.copyright_reasons = ['scan-error'];
      eventRow.copyright_matched_phrases = [];
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
};
