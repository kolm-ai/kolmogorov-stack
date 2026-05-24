// WC06 — minimal structured-logging wrapper.
//
// Goal: a one-import drop-in replacement for console.{log,warn,error} that
//   (a) preserves the existing `[tag] msg` console style so tail-the-logs
//       operators see the exact same output they're used to, and
//   (b) optionally mirrors the emission to the canonical event-store (via
//       appendEvent) when KOLM_LOG_STRUCTURED=1, so SIEM / lake consumers
//       can ingest a single normalized stream without scraping stdout, and
//   (c) sanitises fields before they hit either sink, so a careless caller
//       cannot leak an email / API key / JWT through the structured payload.
//
// This module deliberately does not depend on src/audit.js — audit rows are
// HMAC-chained and load-bearing for tenant attestation, whereas log rows are
// operational telemetry. Loggers that need an audit row should call appendAudit
// directly; logger calls are best-effort and never throw.
//
// Public API:
//   log.info(tag, msg, fields?)
//   log.warn(tag, msg, fields?)
//   log.error(tag, msg, fields?)
//   getLogger(tag) -> { info(msg, fields?), warn(msg, fields?), error(msg, fields?) }
//   class Log     -> equivalent to getLogger but as a constructor
//   sanitizeFields(fields) -> redacted fields (for tests + advanced callers)
//
// Imports are lazy so a test that does not exercise the structured path never
// pays the event-store / privacy-membrane load cost.

const LEVELS = Object.freeze(['info', 'warn', 'error']);

// Lightweight sentinels — exposed for tests + callers that need to assert.
const REDACTED = '[REDACTED]';

// Regexes for the three high-risk leak shapes that show up in field values.
// These are intentionally narrow so we don't false-positive every short string;
// the privacy-membrane scan() path catches the rest when structured logging
// is enabled.
const EMAIL_RE = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i;
// API-key shape: `ks_<hex>`, `sk_<hex>`, plus generic long base64/hex tokens
// >= 32 chars composed of safe alphabet. We intentionally don't try to detect
// arbitrary opaque tokens — that's privacy-membrane's job.
const APIKEY_RE = /\b(?:ks|sk|pk|rk)_[A-Za-z0-9_-]{16,}\b/;
// JWT shape: three base64url segments separated by dots. The middle segment
// must be a JSON-object base64 so we require length >= 8 to avoid matching
// arbitrary triples.
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/;
// Bearer prefix — strip the token, leave the label.
const BEARER_RE = /Bearer\s+[A-Za-z0-9._\-+/=]{8,}/i;

function looksSensitive(s) {
  if (typeof s !== 'string') return false;
  if (s.length === 0) return false;
  return EMAIL_RE.test(s) || APIKEY_RE.test(s) || JWT_RE.test(s) || BEARER_RE.test(s);
}

// sanitizeFields(fields, opts?): walks the object, replaces string values that
// look like emails / api-keys / JWTs with '[REDACTED]'. Non-string values are
// passed through (with depth/cycle guards). Returns a fresh object — the
// caller's input is never mutated.
export function sanitizeFields(fields, _opts = {}) {
  if (fields == null) return {};
  if (typeof fields !== 'object') return { value: String(fields) };
  const seen = new WeakSet();
  const MAX_DEPTH = 4;
  const MAX_STR = 2048;
  function walk(v, depth) {
    if (v == null) return v;
    if (typeof v === 'string') {
      const trimmed = v.length > MAX_STR ? v.slice(0, MAX_STR) + `…(+${v.length - MAX_STR}b)` : v;
      if (looksSensitive(trimmed)) return REDACTED;
      return trimmed;
    }
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'bigint') return String(v);
    if (typeof v === 'function' || typeof v === 'symbol') return `[${typeof v}]`;
    if (depth >= MAX_DEPTH) return '[depth-cap]';
    if (typeof v === 'object') {
      if (seen.has(v)) return '[circular]';
      seen.add(v);
      if (Array.isArray(v)) return v.slice(0, 100).map((x) => walk(x, depth + 1));
      const out = {};
      for (const k of Object.keys(v)) {
        // Key-name based redaction: any key that mentions a secret-y noun has
        // its value blanket-redacted, regardless of shape.
        if (/^(api[_-]?key|secret|password|token|authorization|cookie|jwt|bearer)$/i.test(k)) {
          out[k] = REDACTED;
        } else {
          out[k] = walk(v[k], depth + 1);
        }
      }
      return out;
    }
    return String(v);
  }
  try {
    const result = walk(fields, 0);
    if (result && typeof result === 'object' && !Array.isArray(result)) return result;
    return { value: result };
  } catch (e) {
    // Last-ditch guard — never let a logging call throw.
    return { _sanitize_error: e && e.message ? String(e.message).slice(0, 200) : 'unknown' };
  }
}

// Lazily resolved appendEvent + scan, so this module stays load-cheap when
// structured logging is off (the default in dev + tests).
let _appendEvent = null;
async function _resolveAppendEvent() {
  if (_appendEvent !== null) return _appendEvent;
  try {
    const mod = await import('./event-store.js');
    _appendEvent = typeof mod.appendEvent === 'function' ? mod.appendEvent : false;
  } catch {
    _appendEvent = false;
  }
  return _appendEvent;
}

// emitStructured fires only when KOLM_LOG_STRUCTURED=1. It's fire-and-forget;
// failures never bubble back to the caller. The event-schema's `feedback`
// column is the closest fit for an operational log line (free-text under 4KB),
// and the `provider` column carries the tag so a lake query can group by it.
async function emitStructured(level, tag, msg, fields) {
  if (process.env.KOLM_LOG_STRUCTURED !== '1') return;
  try {
    const appendEvent = await _resolveAppendEvent();
    if (!appendEvent) return;
    const payload = {
      level,
      tag,
      msg,
      fields,
    };
    let feedback;
    try {
      feedback = JSON.stringify(payload);
    } catch {
      feedback = JSON.stringify({ level, tag, msg, fields_error: 'unstringifiable' });
    }
    // feedback column has a 4096-char cap in canonicalize(); pre-clamp so we
    // don't lose the message head to truncation.
    if (feedback.length > 4000) feedback = feedback.slice(0, 4000) + '…';
    await appendEvent({
      // Use the runtime tenant_id env if present, else literal 'log' so the
      // row is queryable but cannot be confused with real tenant data.
      tenant_id: process.env.KOLM_TENANT_ID || 'log',
      namespace: 'log_emission',
      provider: tag,
      status: level === 'error' ? 'error' : 'ok',
      feedback,
      source_type: 'simulated', // honest provenance — these aren't real LLM rows
    });
  } catch {
    // Best-effort: swallow.
  }
}

function _writeConsole(level, line) {
  const fn = level === 'error'
    ? console.error
    : level === 'warn'
      ? console.warn
      : console.log;
  fn(line);
}

function _format(tag, msg) {
  return `[${tag}] ${msg}`;
}

function _emit(level, tag, msg, fields) {
  const safeTag = tag == null ? 'log' : String(tag);
  const safeMsg = msg == null ? '' : String(msg);
  _writeConsole(level, _format(safeTag, safeMsg));
  // sanitize once + reuse for the structured sink
  const cleanFields = sanitizeFields(fields);
  // Don't await — best-effort fire-and-forget. Tests that need the row to
  // exist before they assert can await getLogger(...).<level>.flush() if we
  // ever add one; current scope keeps emission async to avoid blocking hot
  // paths.
  void emitStructured(level, safeTag, safeMsg, cleanFields);
  return cleanFields;
}

export const log = Object.freeze({
  info: (tag, msg, fields) => _emit('info', tag, msg, fields),
  warn: (tag, msg, fields) => _emit('warn', tag, msg, fields),
  error: (tag, msg, fields) => _emit('error', tag, msg, fields),
});

export class Log {
  constructor(tag) {
    this.tag = tag == null ? 'log' : String(tag);
  }
  info(msg, fields) { return _emit('info', this.tag, msg, fields); }
  warn(msg, fields) { return _emit('warn', this.tag, msg, fields); }
  error(msg, fields) { return _emit('error', this.tag, msg, fields); }
}

export function getLogger(tag) {
  return new Log(tag);
}

// Test-only: reset cached event-store reference so a test that flips the
// KOLM_LOG_STRUCTURED env at runtime can re-resolve the dependency.
export function _resetForTests() {
  _appendEvent = null;
}

// Re-export the level list so callers can iterate without re-declaring.
export const LOG_LEVELS = LEVELS;
