// kolm Evidence-Grade Logging Shim (Node ESM, zero dependencies).
//
// Drop this into any agent runtime to record each action as a tamper-evident,
// hash-chained AuditEvent. The output of .toJSONL() is ingested DIRECTLY by
// kolm's runAudit(): a vendor export carrying an intact hash chain lifts your
// evidence grade from tier C (asserted) to tier B (hash-verified). No network
// calls, no kolm account needed to produce the log - you self-lift.
//
// What tier B requires, and what this shim guarantees:
//   - every record carries a chain `hash`
//   - every record after the first carries a `prev_hash` referencing the
//     previous record's `hash` (genesis record has no prev_hash)
//   - identity (key_id + agent) and a usable timestamp on every record
// kolm's audit-trail analyzer verifies the chain order-independently: a link
// is intact when its prev_hash references a hash present in the trail. Keep the
// records together (any order) and the chain verifies.
//
// Caveats: this shim records what your code tells it. It does not intercept
// traffic, so it evidences the calls you log, not calls you forget to log.
// kolm maps these records to standards and reports what the chain shows; it
// does not certify behaviour the log never exercised.

import { createHash } from 'node:crypto';

// Field keys inside tool-call arguments that name an egress destination. kolm's
// ingest reads these to turn a generic "called a tool" into a data-egress
// signal, so naming the destination here makes the egress dimension testable.
const HOST_ARG_KEYS = ['url', 'endpoint', 'uri', 'host', 'hostname', 'base_url', 'to', 'recipient', 'webhook'];

/** Deterministic JSON: object keys sorted recursively, so the hash is stable. */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function sha256Hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

function isoTs(ts) {
  if (ts == null) return new Date().toISOString();
  if (ts instanceof Date) return ts.toISOString();
  if (typeof ts === 'number') return new Date(ts).toISOString();
  return String(ts);
}

function destFromArgs(args) {
  if (!args || typeof args !== 'object') return null;
  for (const k of HOST_ARG_KEYS) {
    const v = args[k];
    if (typeof v === 'string' && v.trim() !== '') {
      // Strip a scheme + path down to a bare host so egress reads cleanly.
      const m = v.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i);
      return (m ? m[1] : v).trim().toLowerCase();
    }
  }
  return null;
}

/**
 * Create a logger bound to one agent identity.
 *
 * @param {object} opts
 * @param {string} opts.keyId   per-agent credential / API-key id (required for
 *                              attribution; tier B needs identity on every event)
 * @param {string} [opts.agent] human-readable agent / service name
 * @param {string[]} [opts.grants] scopes this agent's credential holds, e.g.
 *                              ['tool:lookup_policy', 'tool:send_email']
 * @param {string} [opts.model] model slug recorded on each action (optional)
 */
export class KolmLogger {
  constructor(opts = {}) {
    const o = opts && typeof opts === 'object' ? opts : {};
    this.keyId = o.keyId != null ? String(o.keyId) : null;
    this.agent = o.agent != null ? String(o.agent) : null;
    this.grants = Array.isArray(o.grants) ? o.grants.map((g) => String(g)) : null;
    this.model = o.model != null ? String(o.model) : null;
    this._records = [];
    this._prevHash = null; // null on the genesis record
  }

  /**
   * Record one agent action. Returns the record's chain hash.
   *
   * @param {object} action
   * @param {string} action.tool        tool / function name invoked (required)
   * @param {object} [action.args]      tool arguments (scanned for an egress host)
   * @param {string} [action.host]      explicit egress host (overrides args)
   * @param {string|number|Date} [action.ts]  timestamp (defaults to now)
   * @param {string[]} [action.grants]  per-call grant override (defaults to ctor)
   * @param {boolean} [action.hasSensitive] sensitive content present in the call
   * @param {boolean} [action.redacted]     redaction applied before egress
   */
  record(action = {}) {
    const a = action && typeof action === 'object' ? action : {};
    const tool = a.tool != null ? String(a.tool) : null;
    const args = a.args && typeof a.args === 'object' ? a.args : (a.args != null ? { value: a.args } : {});
    const host = a.host != null ? String(a.host) : destFromArgs(args);
    const ts = isoTs(a.ts);
    const grants = Array.isArray(a.grants) ? a.grants.map((g) => String(g)) : this.grants;

    // The OpenAI-chat record shape kolm's ingest absorbs. Grants live on
    // request.tools (what the agent MAY call); the actual call lives on
    // response.choices[].message.tool_calls (what it DID). The args object
    // carries the destination so egress is evidenced, not asserted.
    const toolDef = grants && grants.length
      ? grants.map((g) => ({ type: 'function', function: { name: g.replace(/^tool:/i, '') } }))
      : (tool ? [{ type: 'function', function: { name: tool } }] : []);

    const record = {
      request_id: `kl_${this._records.length}_${sha256Hex(ts + '|' + (tool || '') + '|' + canonical(args)).slice(0, 12)}`,
      timestamp: ts,
      key_id: this.keyId,
      user: this.agent,
      model: this.model,
      request: { model: this.model, tools: toolDef, messages: [] },
      prev_hash: this._prevHash,
    };
    if (tool) {
      record.response = {
        model: this.model,
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: `call_${this._records.length}`,
              type: 'function',
              function: { name: tool, arguments: canonical(args) },
            }],
          },
        }],
      };
    }
    if (host != null && record.response) {
      // Surface the destination on the call args too, for ingest's argHost().
      record.response.choices[0].message.tool_calls[0].function.arguments =
        canonical({ ...args, host });
    }
    if (a.hasSensitive === true) record.has_sensitive = true;
    if (a.redacted === true) record.redacted = true;

    // The chain link: hash this record's stable content, point prev_hash at the
    // previous link. kolm verifies the link by presence in the trail.
    const hash = sha256Hex(canonical({
      request_id: record.request_id,
      timestamp: record.timestamp,
      key_id: record.key_id,
      user: record.user,
      tool,
      args,
      host,
      prev_hash: record.prev_hash,
    }));
    record.hash = hash;
    this._prevHash = hash;
    this._records.push(record);
    return hash;
  }

  /** All records captured so far (defensive copy). */
  records() {
    return this._records.map((r) => ({ ...r }));
  }

  /** Newline-delimited canonical records - feed DIRECTLY to runAudit(). */
  toJSONL() {
    return this._records.map((r) => JSON.stringify(r)).join('\n');
  }
}

/** Factory form: createLogger({ keyId, agent, grants }). */
export function createLogger(opts) {
  return new KolmLogger(opts);
}

export default KolmLogger;
