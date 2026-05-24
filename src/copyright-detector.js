// W750-followup — Heuristic copyright detector for staged captures.
//
// W750 (copyright filter + capture quarantine) was MERGED into W808 in the
// 2026-05-24 dup-cleanup. The quarantine half (staged_captures table +
// /account/captures/review.html + cmdCapturesReview) shipped under W808.
// Only the copyright-classifier slice remained — promoted to this single
// W808-followup item: a regex pack for common copyrighted-content
// fingerprints that hooks into the W808 staged_captures pipeline as a
// post-quarantine classifier.
//
// SCOPE / HONESTY CONTRACT:
//   - This is a HEURISTIC. The arrays below are pattern packs, not legal
//     truth. A non-zero risk_score means "this looks like it MAY contain
//     copyrighted content" — not "this is a confirmed copyright violation."
//   - We never call out to any external service. Scans are 100% local.
//   - Lyric fingerprints are the TITLES (or short n-grams from titles) of
//     well-known copyrighted songs. We do NOT bundle the actual lyrics; the
//     presence of a famous song title alongside other content is the signal,
//     not reproduction of the protected work itself.
//   - Disney character names are public knowledge but their use as captured
//     model inputs/outputs may signal user-generated derivative content. A
//     hit here is informational, not blocking by itself.
//   - Code copyright headers (the SPDX line + the `Copyright (c) YEAR Name`
//     line) are high-signal: code with an explicit copyright statement very
//     often has a real license attached that the model may not be allowed to
//     reproduce verbatim.
//
// COMPLEMENTARY TO src/capture-copyright-filter.js (W708-4):
//   - W708-4 (capture-copyright-filter.js) flags PAYWALL boilerplate,
//     `[Verse 1]`-style lyrics-site scrapes, and prose with high comma
//     density. It targets ingester-side content shape.
//   - W750-followup (this file) flags FINGERPRINT-shaped content: named
//     characters, song-title n-grams, code-license headers. It targets the
//     post-quarantine classifier hook, where we can look at the row AFTER it
//     has already cleared the 3σ anomaly gate.
//
// W808 INTEGRATION:
//   - shouldQuarantineForCopyright(captureRow) is the helper the W808
//     post-quarantine classifier call site invokes. It returns a structured
//     verdict the caller can either honor (set flag_reason +
//     anomaly_flagged=true on the staged row) or ignore (env-gated off).
//   - The wiring lives in src/proxy.js next to the existing W808 staged-row
//     insert + anomaly call. The gate
//     `process.env.KOLM_W750_COPYRIGHT_DETECTOR !== 'off'` is a byte-stability
//     hatch — when set to 'off' the W808 happy path is unchanged.
//
// ANTI-BRITTLENESS (W604):
//   - COPYRIGHT_VERSION is `w750-followup-vN.M` and consumers MUST match
//     with a regex (/^w750-followup-/) NOT literal equality.
//   - DISNEY_NAMES + LYRIC_FINGERPRINTS are frozen so callers cannot
//     accidentally mutate the pattern pack.
//   - risk_score is min(1, hits.length * 0.25) — additive + capped so a
//     pathological input cannot drive the score out of [0, 1].

export const COPYRIGHT_VERSION = 'w750-followup-v1';

// ~30 well-known Disney character names. Lowercase + literal-substring match
// so case + word boundary is handled in scanText. Frozen so a downstream
// consumer cannot accidentally splice in junk that would break the pattern
// pack across all callers.
export const DISNEY_NAMES = Object.freeze([
  'mickey mouse',
  'minnie mouse',
  'donald duck',
  'daisy duck',
  'goofy',
  'pluto',
  'elsa',
  'anna',
  'olaf',
  'sven',
  'simba',
  'mufasa',
  'timon',
  'pumbaa',
  'ariel',
  'sebastian',
  'flounder',
  'aladdin',
  'jasmine',
  'genie',
  'snow white',
  'cinderella',
  'aurora',
  'belle',
  'beast',
  'tiana',
  'rapunzel',
  'flynn rider',
  'merida',
  'moana',
  'maui',
]);

// ~30 recognizable song titles / Top-100 n-grams. NOT the lyrics themselves
// — the presence of "Hey Jude" in a capture is the heuristic. Frozen.
//
// Origin: the LIST is curated heuristic content (titles + artist-name pairs
// in common use). We do not bundle protected works.
export const LYRIC_FINGERPRINTS = Object.freeze([
  'i will always love you',
  'hey jude',
  'imagine all the people',
  'let it be',
  'smells like teen spirit',
  'bohemian rhapsody',
  'sweet caroline',
  'dont stop believin',
  'livin on a prayer',
  'born to run',
  'thriller michael jackson',
  'billie jean',
  'beat it',
  'rolling in the deep',
  'someone like you',
  'shape of you',
  'blank space',
  'shake it off',
  'baby one more time',
  'toxic britney',
  'sorry justin bieber',
  'closer chainsmokers',
  'despacito luis',
  'dynamite bts',
  'butter bts',
  'old town road',
  'flowers miley',
  'as it was harry',
  'watermelon sugar',
  'levitating dua',
]);

// Code copyright header regex. Matches:
//   "Copyright (c) 2023 Acme"
//   "Copyright (C) 2023-2025 Foo"
//   "copyright © 2024 Bar"
//   "Copyright &copy; 2025 Baz"
// We require a year + at least one trailing letter so we do not flag bare
// "copyright 2024" boilerplate that appears in a sentence about the model's
// training cutoff.
export const CODE_COPYRIGHT_REGEX = /\bcopyright\s*(?:\([cC]\)|©|&copy;)?\s*\d{4}(?:-\d{4})?\s*[a-zA-Z]/i;

// SPDX license identifier comment. The convention is from
// spdx.org/licenses/ — `SPDX-License-Identifier: MIT` style lines. High
// signal: code with an SPDX line almost always has a real license attached.
export const SPDX_REGEX = /SPDX-License-Identifier:\s*[A-Za-z0-9.+-]+/;

// Cap risk_score contribution per hit. risk_score = min(1, hits.length *
// PER_HIT_RISK). 4 hits + reaches the cap; we never claim 1.0 risk from a
// single match.
const PER_HIT_RISK = 0.25;

// Cap how much of the input we scan to keep this O(text size) bounded. The
// detector is called from the proxy hot path; runaway input cannot stall the
// staging pipeline.
const MAX_SCAN_CHARS = 65536;

// -----------------------------------------------------------------------------
// Pure scanner — no I/O, deterministic given text.
// -----------------------------------------------------------------------------

function _coerceToString(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'number' || typeof input === 'boolean') return String(input);
  try { return JSON.stringify(input); } catch (_) { return ''; }
}

// Find the first index of `needle` (case-insensitive) in `text` (lower-cased
// once by caller). Returns -1 when not found. Avoids the cost of building a
// RegExp for every pattern.
function _firstIndexLower(lowerText, needle) {
  if (!needle) return -1;
  return lowerText.indexOf(needle);
}

// Scan raw text and return a structured envelope. Hits are deduped by
// (kind, matched) so the same Disney name appearing 4× counts as 1 hit.
//
// Returns:
//   {
//     ok: true,
//     hits: [{ kind, matched, index }, ...],
//     risk_score: 0..1,
//     scanned_chars: N,
//     version,
//   }
export function scanText(text, opts = {}) {
  const raw = _coerceToString(text);
  if (!raw) {
    return {
      ok: true,
      hits: [],
      risk_score: 0,
      scanned_chars: 0,
      version: COPYRIGHT_VERSION,
    };
  }
  const maxChars = Number.isFinite(opts.max_scan_chars) && opts.max_scan_chars > 0
    ? Math.min(opts.max_scan_chars, MAX_SCAN_CHARS)
    : MAX_SCAN_CHARS;
  const scan = raw.length > maxChars ? raw.slice(0, maxChars) : raw;
  const lower = scan.toLowerCase();

  const hits = [];
  const seen = new Set(); // dedupe key = kind + ':' + matched

  // Disney character substrings. We do a simple indexOf to keep this fast
  // and to avoid regex-injection from any character that might be in the
  // future-grown pattern pack.
  for (const name of DISNEY_NAMES) {
    const idx = _firstIndexLower(lower, name);
    if (idx < 0) continue;
    const key = 'disney_character:' + name;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ kind: 'disney_character', matched: name, index: idx });
  }

  // Song-title / lyric n-grams.
  for (const fp of LYRIC_FINGERPRINTS) {
    const idx = _firstIndexLower(lower, fp);
    if (idx < 0) continue;
    const key = 'lyric_fingerprint:' + fp;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ kind: 'lyric_fingerprint', matched: fp, index: idx });
  }

  // Code copyright header — exec against the original-case scan so the
  // match position is honest (case-sensitive offsets in lowered text would
  // be misleading for downstream highlighting).
  const codeMatch = CODE_COPYRIGHT_REGEX.exec(scan);
  if (codeMatch) {
    const matched = codeMatch[0];
    const key = 'code_copyright:' + matched.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      hits.push({ kind: 'code_copyright', matched, index: codeMatch.index });
    }
  }

  // SPDX license identifier. Same — run against the original-case scan.
  const spdxMatch = SPDX_REGEX.exec(scan);
  if (spdxMatch) {
    const matched = spdxMatch[0];
    const key = 'spdx:' + matched.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      hits.push({ kind: 'spdx', matched, index: spdxMatch.index });
    }
  }

  // Additive risk score, capped at 1.0.
  const risk_score = Math.min(1, hits.length * PER_HIT_RISK);

  return {
    ok: true,
    hits,
    risk_score,
    scanned_chars: scan.length,
    version: COPYRIGHT_VERSION,
  };
}

// Scan a capture row — runs scanText on input + output sides, combines hits,
// and preserves the capture_id for traceability. Accepts both
// {prompt, response} (capture-store shape) and {prompt_redacted,
// response_redacted} (event-store shape) so the helper works at either
// layer.
export function scanCapture(captureRow) {
  if (!captureRow || typeof captureRow !== 'object') {
    return {
      ok: false,
      error: 'missing_capture_row',
      hint: 'pass a capture row object as the first arg',
      version: COPYRIGHT_VERSION,
    };
  }
  const inputText = captureRow.prompt != null
    ? captureRow.prompt
    : (captureRow.prompt_redacted != null ? captureRow.prompt_redacted : captureRow.input);
  const outputText = captureRow.response != null
    ? captureRow.response
    : (captureRow.response_redacted != null ? captureRow.response_redacted : captureRow.output);

  const inScan = scanText(inputText);
  const outScan = scanText(outputText);

  // Combine — tag each hit with which side it came from so the UI can
  // highlight prompt-vs-response without re-scanning.
  const hits = [];
  for (const h of inScan.hits) hits.push({ ...h, side: 'input' });
  for (const h of outScan.hits) hits.push({ ...h, side: 'output' });

  const risk_score = Math.min(1, hits.length * PER_HIT_RISK);
  const capture_id = captureRow.capture_id
    || captureRow.staged_capture_id
    || captureRow.id
    || captureRow.event_id
    || null;

  return {
    ok: true,
    capture_id,
    hits,
    risk_score,
    input_risk: inScan.risk_score,
    output_risk: outScan.risk_score,
    scanned_input_chars: inScan.scanned_chars,
    scanned_output_chars: outScan.scanned_chars,
    version: COPYRIGHT_VERSION,
  };
}

// W808 integration hook — caller decides "should this staged_captures row
// be flagged for quarantine by the copyright heuristic?"
//
// Returns:
//   { should_quarantine: bool, reason: string|null, risk_score, hits, version }
//
// reason is a short tag of the form `copyright_heuristic:<categories>` so
// the staged_captures.flag_reason column has a consistent shape. categories
// is a comma-sorted list of the kinds that contributed (e.g.
// "disney_character,spdx"). null when not quarantined.
//
// threshold default 0.5 — requires at least 2 hits. The W808 caller can
// lower the threshold to 0.25 (single-hit sensitivity) via opts.
export function classifyForQuarantine(captureRow, opts = {}) {
  const threshold = Number.isFinite(opts.threshold) && opts.threshold >= 0 && opts.threshold <= 1
    ? opts.threshold
    : 0.5;
  const scan = scanCapture(captureRow);
  if (!scan.ok) {
    return {
      should_quarantine: false,
      reason: null,
      risk_score: 0,
      hits: [],
      error: scan.error,
      version: COPYRIGHT_VERSION,
    };
  }
  if (scan.risk_score < threshold) {
    return {
      should_quarantine: false,
      reason: null,
      risk_score: scan.risk_score,
      hits: scan.hits,
      version: COPYRIGHT_VERSION,
    };
  }
  // Build the reason tag from the deduped kinds that fired.
  const kinds = Array.from(new Set(scan.hits.map(h => h.kind))).sort();
  const reason = 'copyright_heuristic:' + kinds.join(',');
  return {
    should_quarantine: true,
    reason,
    risk_score: scan.risk_score,
    hits: scan.hits,
    threshold,
    version: COPYRIGHT_VERSION,
  };
}

// Convenience wrapper for the W808 staged_captures post-quarantine
// classifier call site. Returns a bool + reason — drops the heavy hits
// payload for the hot-path use case where the caller only wants the
// decision. The full scan envelope is still available via classifyForQuarantine.
export function shouldQuarantineForCopyright(captureRow, opts = {}) {
  const v = classifyForQuarantine(captureRow, opts);
  return {
    should_quarantine: v.should_quarantine === true,
    reason: v.reason,
    risk_score: v.risk_score,
    version: COPYRIGHT_VERSION,
  };
}

export default {
  COPYRIGHT_VERSION,
  DISNEY_NAMES,
  LYRIC_FINGERPRINTS,
  CODE_COPYRIGHT_REGEX,
  SPDX_REGEX,
  scanText,
  scanCapture,
  classifyForQuarantine,
  shouldQuarantineForCopyright,
};
