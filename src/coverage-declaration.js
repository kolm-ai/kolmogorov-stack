// Agent Security-Review audit - vendor coverage declaration (GAP-3).
//
// Tiers B/C accept vendor-supplied exports, so the vendor controls WHICH window
// of activity the audit sees: a curated quiet week passes every analyzer while
// the busy weeks never reach the evidence. The declaration closes the
// claim-bounding half of that gap: the vendor states, on the record, what
// window the export covers, which systems feed it, and roughly how many calls
// per day the fleet makes - and that statement is bound INSIDE the signed
// envelope (src/attestation-report-builder.js), so it is exactly as
// tamper-evident as the findings. The volume-sanity finding
// (trail-volume-inconsistent in src/audit-trail-analyzer.js) is the detection
// half; this module is the accountability half.
//
// Exports:
//   normalizeCoverageDeclaration(raw) -> { ok, declaration?, error? }
//     Validates + normalizes the caller-supplied declaration. When the vendor
//     attached an Ed25519 signature_ed25519 block, it is verified over the
//     canonical form of the declaration (the builder's own canonicalize, so a
//     vendor SDK can reproduce the bytes) and passed through.
//   declarationCaveat(declaration) -> string
//     The one-line caveat the signed report carries next to the declaration.
//
// Never throws; never logs declaration contents.

import { verifySignatureBlock } from './ed25519.js';
import { canonicalize } from './attestation-report-builder.js';

export const COVERAGE_DECLARATION_VERSION = 'asr-coverage-declaration/0.1';

// Caps - a declaration is a short, human-authored statement, not a data dump.
const MAX_SYSTEMS = 20;
const MAX_SYSTEM_LEN = 120;
const MAX_NAME_LEN = 200;
const MAX_EMAIL_LEN = 320;
const MAX_STATEMENT_LEN = 500;

function _bad(error) {
  return { ok: false, error };
}

function _isoMs(v) {
  if (typeof v !== 'string' || v.trim() === '') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/**
 * normalizeCoverageDeclaration - validate + normalize a vendor coverage
 * declaration. Shape accepted:
 *   {
 *     window_start: ISO-8601 string,
 *     window_end:   ISO-8601 string (>= window_start),
 *     systems:      [string<=120] (1..20 entries),
 *     expected_calls_per_day?: number > 0 (or null = not declared),
 *     attestor:     { name: string<=200, email?: string<=320 },
 *     statement?:   string<=500,
 *     signature_ed25519?: kolm-ed25519-v1 block over canonicalize(declaration
 *                          minus the signature block itself)
 *   }
 * Returns { ok:true, declaration } or { ok:false, error }. Never throws.
 */
export function normalizeCoverageDeclaration(raw) {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return _bad('coverage_declaration must be an object');
    }

    const startMs = _isoMs(raw.window_start);
    if (startMs == null) return _bad('window_start must be an ISO-8601 timestamp');
    const endMs = _isoMs(raw.window_end);
    if (endMs == null) return _bad('window_end must be an ISO-8601 timestamp');
    if (endMs < startMs) return _bad('window_end must not precede window_start');

    if (!Array.isArray(raw.systems) || raw.systems.length === 0) {
      return _bad('systems must be a non-empty array of system names');
    }
    if (raw.systems.length > MAX_SYSTEMS) {
      return _bad(`systems holds at most ${MAX_SYSTEMS} entries`);
    }
    const systems = [];
    for (const s of raw.systems) {
      if (typeof s !== 'string' || s.trim() === '') return _bad('each system must be a non-empty string');
      if (s.length > MAX_SYSTEM_LEN) return _bad(`each system name is at most ${MAX_SYSTEM_LEN} characters`);
      systems.push(s.trim());
    }

    let expected = null;
    if (raw.expected_calls_per_day != null) {
      const n = Number(raw.expected_calls_per_day);
      if (!Number.isFinite(n) || n <= 0) return _bad('expected_calls_per_day must be a number > 0 (or omitted)');
      expected = n;
    }

    const att = raw.attestor;
    if (!att || typeof att !== 'object' || Array.isArray(att)) return _bad('attestor must be an object with a name');
    if (typeof att.name !== 'string' || att.name.trim() === '') return _bad('attestor.name is required');
    if (att.name.length > MAX_NAME_LEN) return _bad(`attestor.name is at most ${MAX_NAME_LEN} characters`);
    const attestor = { name: att.name.trim() };
    if (att.email != null) {
      if (typeof att.email !== 'string' || att.email.length > MAX_EMAIL_LEN || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(att.email.trim())) {
        return _bad('attestor.email must be a plausible email address');
      }
      attestor.email = att.email.trim();
    }

    const declaration = {
      version: COVERAGE_DECLARATION_VERSION,
      window_start: new Date(startMs).toISOString(),
      window_end: new Date(endMs).toISOString(),
      systems,
      expected_calls_per_day: expected,
      attestor,
    };
    if (raw.statement != null) {
      if (typeof raw.statement !== 'string') return _bad('statement must be a string');
      if (raw.statement.length > MAX_STATEMENT_LEN) return _bad(`statement is at most ${MAX_STATEMENT_LEN} characters`);
      declaration.statement = raw.statement.trim();
    }

    // Optional vendor signature: an Ed25519 block over the canonical form of
    // the normalized declaration (everything but the signature block itself).
    // A present-but-invalid signature is a hard reject - a forged attestation
    // is worse than none.
    if (raw.signature_ed25519 != null) {
      const block = raw.signature_ed25519;
      if (!block || typeof block !== 'object') return _bad('signature_ed25519 must be a signature block object');
      const v = verifySignatureBlock(block, canonicalize(declaration));
      if (!v.ok) return _bad('declaration signature does not verify: ' + (v.reason || 'invalid'));
      declaration.signature_ed25519 = {
        spec: block.spec,
        alg: block.alg,
        public_key: block.public_key,
        key_fingerprint: v.key_fingerprint || block.key_fingerprint || null,
        signature: block.signature,
        signed_at: block.signed_at || null,
      };
    }

    return { ok: true, declaration };
  } catch (e) {
    return _bad('coverage_declaration could not be processed: ' + (e && e.message));
  }
}

/**
 * declarationCaveat - the one-line caveat bound into the signed report next to
 * the declaration. Never throws; tolerates a malformed input.
 */
export function declarationCaveat(declaration) {
  try {
    const d = declaration && typeof declaration === 'object' ? declaration : {};
    const who = d.attestor && d.attestor.name ? String(d.attestor.name) : 'the vendor';
    const start = d.window_start ? String(d.window_start).slice(0, 10) : '?';
    const end = d.window_end ? String(d.window_end).slice(0, 10) : '?';
    const systems = Array.isArray(d.systems) && d.systems.length ? d.systems.join(', ') : 'unspecified systems';
    const vol = d.expected_calls_per_day != null
      ? `, ~${d.expected_calls_per_day} calls/day expected`
      : '';
    const signed = d.signature_ed25519 ? ' (vendor-signed)' : '';
    return `Coverage declared by ${who}${signed}: window ${start} to ${end}, covering ${systems}${vol}. The window selection remains the declarant's responsibility.`;
  } catch {
    return 'A coverage declaration was supplied with this report.';
  }
}

export default normalizeCoverageDeclaration;
