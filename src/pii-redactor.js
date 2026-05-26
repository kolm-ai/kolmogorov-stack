// W-C / wrapper-completion — unified PII redactor for the gateway.
//
// The gateway runs PII scans TWICE per request (stage 3 on input, stage 7
// on output — see the 11-stage pipeline in the wrapper spec). The same
// 4-mode contract applies to both:
//
//   detect_only      — emit findings to receipt.redaction_applied,
//                      pass the text through unchanged
//   redact_captures  — pass the original through to the client,
//                      redact the text that goes into the capture row
//   redact_all       — redact both response-to-client AND capture row
//   block            — reject the request with 400 if PII found in input
//
// This module is a THIN UNIFIER around the existing redactor primitives:
//   - src/phi-redactor.js   — HIPAA 18 + 3 kolm extensions, regex detectors
//   - src/prompt-redactor.js — system-prompt strategies (placeholder /
//                              paraphrase / remove_literal_constraints /
//                              extract_behavior_only)
//
// We deliberately do NOT add new detectors here — that's the job of
// phi-redactor.js. Our job is to expose ONE function the gateway calls,
// regardless of which side of the pipeline we're on, and to return a
// shape the receipt builder can fold straight into redaction_applied.
//
// Public surface:
//   - MODES = ['detect_only','redact_captures','redact_all','block']
//   - DETECTOR_NAMES (subset of phi-redactor CLASSES, normalized to lower)
//   - scanPii({text, classes?}) -> { findings: [{class, count}],
//                                    classes_hit: ['email','phone'] }
//   - applyMode({text, mode, classes?, names?, addresses?, ids?})
//     -> { mode, action, output_text, capture_text, redaction_applied,
//          findings, map?, blocked? }
//   - shouldBlock(scan, mode) -> boolean

import * as phi from './phi-redactor.js';

export const MODES = Object.freeze([
  'detect_only',
  'redact_captures',
  'redact_all',
  'block',
]);

// The most-common detector classes, normalized to a snake_case-friendly
// surface the receipt + CLI can consume. The full HIPAA + provider
// classes are still available via phi.CLASSES if a caller wants them.
export const DETECTOR_NAMES = Object.freeze([
  'email',
  'phone',
  'ssn',
  'credit_card',
  'ip',
  'url',
  'name',
  'address',
  'mrn',
  'npi',
  'dea',
]);

// Map a phi.CLASSES entry to a DETECTOR_NAMES entry. Anything outside
// the friendly list falls back to lower-cased class name (so OTHER →
// "other", BIO → "bio", etc. — never undefined).
function _normalizeClass(c) {
  const s = String(c || '').toLowerCase();
  if (s === 'fax') return 'phone';
  if (s === 'geo') return 'address';
  return s;
}

/**
 * scanPii — run the phi-redactor over the text WITHOUT applying any
 * substitution. Returns a finding list the gateway uses for the
 * receipt.redaction_applied summary field, plus the raw set of classes
 * that were hit.
 */
export function scanPii({ text, classes, names, addresses, ids } = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    return { findings: [], classes_hit: [] };
  }
  const opts = {};
  if (Array.isArray(classes)) opts.classes = classes;
  if (Array.isArray(names)) opts.names = names;
  if (Array.isArray(addresses)) opts.addresses = addresses;
  if (ids && typeof ids === 'object') opts.ids = ids;

  const { map } = phi.redact(text, opts);
  const counts = new Map();
  for (const token of Object.keys(map || {})) {
    // tokens are [PHI_<CLASS>_<INDEX>] — parse CLASS out
    const m = /\[PHI_([A-Z]+)_\d+\]/.exec(token);
    if (!m) continue;
    const key = _normalizeClass(m[1]);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const findings = Array.from(counts, ([cls, count]) => ({ class: cls, count }));
  const classes_hit = findings.map((f) => f.class);
  return { findings, classes_hit };
}

/**
 * applyMode — the gateway's single entry point.
 *
 * - detect_only:    output = text, capture = text, redaction_applied populated.
 * - redact_captures: output = text, capture = REDACTED.
 * - redact_all:     output = REDACTED, capture = REDACTED.
 * - block:          output/capture = '' and blocked = true when findings > 0,
 *                   else passthrough.
 *
 * `action` is always one of: 'pass' | 'redact' | 'block'.
 * `map` (when present) lets the caller reinject originals via phi.reinject
 * if they later need to (e.g. teacher-in-the-middle distillation).
 */
export function applyMode({ text, mode, classes, names, addresses, ids } = {}) {
  const m = MODES.includes(mode) ? mode : 'detect_only';
  if (typeof text !== 'string') {
    return {
      mode: m, action: 'pass',
      output_text: '', capture_text: '',
      redaction_applied: [], findings: [],
      blocked: false,
    };
  }

  const opts = {};
  if (Array.isArray(classes)) opts.classes = classes;
  if (Array.isArray(names)) opts.names = names;
  if (Array.isArray(addresses)) opts.addresses = addresses;
  if (ids && typeof ids === 'object') opts.ids = ids;

  const { redacted, map } = phi.redact(text, opts);
  const counts = new Map();
  for (const token of Object.keys(map || {})) {
    const mm = /\[PHI_([A-Z]+)_\d+\]/.exec(token);
    if (!mm) continue;
    const key = _normalizeClass(mm[1]);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const findings = Array.from(counts, ([cls, count]) => ({ class: cls, count }));
  const redaction_applied = findings.map((f) => f.class);
  const had_findings = redaction_applied.length > 0;

  if (m === 'block') {
    if (had_findings) {
      return {
        mode: m, action: 'block',
        output_text: '', capture_text: '',
        redaction_applied, findings,
        blocked: true,
        block_reason: 'pii_detected_in_input',
        block_classes: redaction_applied,
      };
    }
    return {
      mode: m, action: 'pass',
      output_text: text, capture_text: text,
      redaction_applied: [], findings: [],
      blocked: false,
    };
  }

  if (m === 'detect_only') {
    return {
      mode: m, action: had_findings ? 'pass' : 'pass',
      output_text: text, capture_text: text,
      redaction_applied, findings,
      blocked: false,
      map,
    };
  }

  if (m === 'redact_captures') {
    return {
      mode: m, action: had_findings ? 'redact' : 'pass',
      output_text: text,
      capture_text: had_findings ? redacted : text,
      redaction_applied, findings,
      blocked: false,
      map,
    };
  }

  // redact_all
  return {
    mode: m, action: had_findings ? 'redact' : 'pass',
    output_text: had_findings ? redacted : text,
    capture_text: had_findings ? redacted : text,
    redaction_applied, findings,
    blocked: false,
    map,
  };
}

/**
 * shouldBlock — convenience predicate the gateway uses BEFORE forwarding
 * to upstream. Returns true if `mode === 'block'` and the scan found
 * any PII. The gateway then returns HTTP 400 with the block_reason.
 */
export function shouldBlock(scan, mode) {
  return mode === 'block' && Array.isArray(scan?.classes_hit) && scan.classes_hit.length > 0;
}

// Re-export the underlying CLASSES so callers that want the full
// HIPAA-grade taxonomy don't have to also import phi-redactor.
export const FULL_CLASSES = phi.CLASSES;
