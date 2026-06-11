// Agent Security-Review audit - shared sensitive-data detection (GAP-2).
//
// Closes the detection half of GAP-2 (docs/AUDIT-SURFACE-REVIEW-2026.md):
// every has_sensitive bit in the event stream came from the regex PII scanner
// alone, so a secret-shaped token (an API key, a bearer token, a private-key
// block) sitting in a message or tool-call argument body was invisible to the
// red-team data-exfil probe and the permission analyzer's sensitive-egress
// finding. This module is the ONE place ingest scans text for sensitivity:
//
//   - SECRET_SHAPE_PATTERNS: the same 11 structure-anchored credential shapes
//     the red-team battery applies to machine-readable fields
//     (src/red-team.js SECRET_PATTERNS), copied verbatim so both layers agree
//     on what a secret looks like. Ordinary hosts and endpoints never match.
//   - scanSecretShapes(text): which shapes hit. The matched value itself is
//     NEVER echoed - only the stable shape id.
//   - scanSensitive(text): PII (src/pii-redactor.js scanPii) + secret shapes
//     in one never-throw call; has_sensitive is the OR of the two, and the
//     classes stay separate so a finding can distinguish PII from secrets.
//   - detectorCoverage(): the exact PII classes and secret shapes scanned,
//     so the signed report can carry a detector-coverage caveat that bounds
//     the no-exfil claim to what the detector actually sees.
//
// Never throws; never logs or echoes matched values.

import { scanPii, FULL_CLASSES } from './pii-redactor.js';

// Credential / secret shaped tokens. Structure-anchored so ordinary hosts and
// endpoints ('api.openai.com', '/chat/completions') never match - only real
// key shapes do. Regexes are byte-identical to src/red-team.js SECRET_PATTERNS
// (which keeps its own private copy for machine-readable fields).
export const SECRET_SHAPE_PATTERNS = Object.freeze([
  { id: 'openai-style-key', label: 'OpenAI-style secret key (sk-...)', re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { id: 'aws-akid', label: 'AWS access key id (AKIA...)', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'aws-sts-akid', label: 'AWS temporary access key id (ASIA...)', re: /\bASIA[0-9A-Z]{16}\b/ },
  { id: 'github-token', label: 'GitHub token (gho_/ghp_/...)', re: /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/ },
  { id: 'slack-token', label: 'Slack token (xox...)', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'gcp-api-key', label: 'Google API key (AIza...)', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'oauth-ya29', label: 'Google OAuth access token (ya29....)', re: /\bya29\.[A-Za-z0-9._-]{20,}\b/ },
  { id: 'jwt', label: 'JSON Web Token (eyJ...)', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/ },
  { id: 'pem-private-key', label: 'PEM private-key block', re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/ },
  { id: 'bearer', label: 'Bearer token in the clear', re: /\bBearer\s+[A-Za-z0-9._-]{16,}\b/ },
  { id: 'kv-secret', label: 'key=value secret assignment (api_key= / password= / ...)', re: /\b(?:api[_-]?key|apikey|access[_-]?token|client[_-]?secret|secret[_-]?key|auth[_-]?token|authorization|password|passwd)\b\s*[=:]\s*["']?[A-Za-z0-9._-]{12,}/i },
]);

/**
 * scanSecretShapes - which secret shapes appear in the text.
 * Mirrors red-team's hasSecret guard (no scan below 8 chars). The matched
 * value is never returned - only the stable shape ids.
 *
 * @param {string} text
 * @returns {{ hit: boolean, classes: string[] }}
 */
export function scanSecretShapes(text) {
  if (typeof text !== 'string' || text.length < 8) return { hit: false, classes: [] };
  const classes = [];
  for (const p of SECRET_SHAPE_PATTERNS) {
    try {
      if (p.re.test(text)) classes.push(p.id);
    } catch {
      // a pathological input degrades to "shape not detected", never a throw
    }
  }
  return { hit: classes.length > 0, classes };
}

/**
 * scanSensitive - the combined sensitivity scan ingest stamps onto events.
 * PII and secret classes are kept SEPARATE so findings can distinguish a
 * leaked SSN from a leaked credential; has_sensitive is the OR.
 *
 * @param {string} text
 * @returns {{ has_sensitive: boolean, pii_classes: string[], secret_classes: string[] }}
 */
export function scanSensitive(text) {
  if (typeof text !== 'string' || text === '') {
    return { has_sensitive: false, pii_classes: [], secret_classes: [] };
  }
  let piiClasses = [];
  try {
    const { classes_hit } = scanPii({ text });
    piiClasses = Array.isArray(classes_hit) ? classes_hit : [];
  } catch {
    piiClasses = []; // a detector edge case can't sink an audit ingest
  }
  const secrets = scanSecretShapes(text);
  return {
    has_sensitive: piiClasses.length > 0 || secrets.hit,
    pii_classes: piiClasses,
    secret_classes: secrets.classes,
  };
}

// The exact class vocabulary scanPii can emit: phi-redactor's CLASSES run
// through the same normalization scanPii applies (lowercase; fax folds into
// phone, geo into address).
function _piiVocabulary() {
  const out = new Set();
  const src = Array.isArray(FULL_CLASSES) ? FULL_CLASSES : [];
  for (const c of src) {
    let s = String(c || '').toLowerCase();
    if (s === 'fax') s = 'phone';
    if (s === 'geo') s = 'address';
    if (s) out.add(s);
  }
  return [...out].sort();
}

/**
 * detectorCoverage - the bounded claim for the signed report: exactly which
 * PII classes and secret shapes the ingest-time detector scans. Deterministic.
 *
 * @returns {{ pii_classes: string[], secret_shapes: string[] }}
 */
export function detectorCoverage() {
  return {
    pii_classes: _piiVocabulary(),
    secret_shapes: SECRET_SHAPE_PATTERNS.map((p) => p.id),
  };
}

export default scanSensitive;
