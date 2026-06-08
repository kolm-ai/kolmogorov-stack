// Agent Security-Review audit - the normalized audit-event schema.
//
// Both architecture reviews flagged the same hole: the log importers
// (src/importers/{litellm,helicone,portkey,openrouter}.js) normalize a call
// down to flattened input/output TEXT for the distill/eval pipeline, throwing
// away exactly the dimension a security audit needs - which tool/API the agent
// invoked, which credential it used, and whether data left the boundary.
//
// This module defines the intermediate the analyzers consume: one AuditEvent
// per agent action. src/audit-ingest.js builds these from raw provider logs;
// src/permission-analyzer.js and src/audit-trail-analyzer.js read them.
//
// Canonical AuditEvent shape:
//   {
//     id:        string,            // stable, content-derived
//     ts:        string|null,       // ISO 8601 timestamp, or null if absent
//     namespace: string,            // agent / tenant namespace
//     actor: {
//       key_id: string|null,        // credential / API-key identifier
//       agent:  string|null,        // agent or service name
//     },
//     action: {
//       type:     'tool'|'api'|'model'|'unknown',
//       tool:     string|null,      // tool / function name invoked
//       server:   string|null,      // MCP server / vendor surface
//       host:     string|null,      // external host the call reached
//       method:   string|null,      // HTTP verb / action verb
//       endpoint: string|null,      // path / resource
//     },
//     scopes: {
//       granted: string[]|null,     // scopes the credential holds (null = unknown)
//       used:    string[],          // scopes THIS event exercised
//     },
//     data: {
//       has_sensitive: boolean,     // sensitive content detected in the call
//       redacted:      boolean,     // redaction was applied before egress
//       egress:        boolean,     // the call left the trust boundary
//     },
//     hash:      string|null,       // tamper-evident chain hash, if logged
//     prev_hash: string|null,       // previous link in the chain, if logged
//     meta:      object,            // source-specific passthrough
//   }
//
// Scopes follow kolm's own convention (src/auth.js): "resource:action"
// strings, with "*" meaning full access and "resource:*" meaning all actions
// on a resource. The analyzers reuse that grammar so an audited agent's grants
// and kolm's own scoped keys read the same way.

import crypto from 'node:crypto';

const ID_HEX_LEN = 16;

// Verb / scope keywords ranked into the four privilege tiers the plan and the
// site reference ("Scope 1-4"). Tier 4 is the most dangerous: destructive or
// data-leaving-the-boundary actions.
const TIER_KEYWORDS = [
  // tier 4 - destructive / irreversible / external egress. VERBS only: resource
  // nouns ('email', 'payment') were removed because a read verb naming a
  // sensitive resource ("list_payments", "read_emails") is a tier-1 read, not a
  // tier-4 action. classifyScopeTier ranks on the leading verb, so dual-use
  // tokens ('send', 'charge', 'wire', 'transfer') only escalate when they ARE
  // the action verb.
  { tier: 4, words: ['delete', 'drop', 'destroy', 'purge', 'wipe', 'remove', 'revoke', 'terminate', 'send', 'transfer', 'charge', 'wire', 'deploy', 'exfiltrate', 'export'] },
  // tier 3 - administrative / privilege-changing
  { tier: 3, words: ['admin', 'grant', 'role', 'policy', 'config', 'configure', 'manage', 'provision', 'rotate', 'impersonate', 'sudo', 'owner'] },
  // tier 2 - write / mutate
  { tier: 2, words: ['write', 'create', 'update', 'put', 'post', 'patch', 'insert', 'modify', 'edit', 'upload', 'set', 'append'] },
  // tier 1 - read-only
  { tier: 1, words: ['read', 'get', 'list', 'view', 'fetch', 'search', 'query', 'describe', 'head'] },
];

/** Stable, content-derived id for an event (first 16 hex of a sha256). */
export function eventId(parts) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(parts))
    .digest('hex')
    .slice(0, ID_HEX_LEN);
}

/** Coerce an arbitrary value into a clean string token (or null). */
function tokenOrNull(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/** Coerce a value into a normalized lowercase scope array, deduped. */
function scopeArray(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  const seen = new Set();
  for (const v of list) {
    const s = tokenOrNull(v);
    if (!s) continue;
    const lc = s.toLowerCase();
    if (seen.has(lc)) continue;
    seen.add(lc);
    out.push(lc);
  }
  return out;
}

/**
 * Derive the scope token an action exercised, in "resource:action" form.
 * A tool call "send_email" => "tool:send_email"; an HTTP GET to api.x.com
 * => "api.x.com:get". Used to compare exercised scopes against granted ones.
 */
export function scopeToken(action) {
  if (!action || typeof action !== 'object') return null;
  if (action.tool) {
    return 'tool:' + String(action.tool).toLowerCase();
  }
  if (action.host) {
    const verb = action.method ? String(action.method).toLowerCase() : 'access';
    return String(action.host).toLowerCase() + ':' + verb;
  }
  if (action.server) {
    return 'mcp:' + String(action.server).toLowerCase();
  }
  return null;
}

/**
 * Classify a scope or action token into a privilege tier 1-4.
 * Unknown tokens default to tier 2 (assume write-capable until shown read-only)
 * because under-counting privilege is the dangerous direction for an audit.
 */
export function classifyScopeTier(scope) {
  const s = tokenOrNull(scope);
  if (!s) return 2;
  const lc = s.toLowerCase();
  if (lc === '*' || lc.endsWith(':*') || lc.endsWith('/*')) return 4; // wildcard = full
  // Rank on whole TOKENS of the action part ("resource:action" → action), with
  // the leading verb winning - never loose substrings. "list_payments",
  // "get_charge", "read_emails", "get_sender" are reads (tier 1), not tier-4
  // egress, even though they name a sensitive resource. Only when the leading
  // token is not a known verb do later tokens escalate the tier (e.g.
  // "bulk_delete" → tier 4).
  const actionPart = lc.includes(':') ? lc.slice(lc.lastIndexOf(':') + 1) : lc;
  const tokens = actionPart.split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.length === 0) return 2;
  const tierOf = (tok) => {
    for (const { tier, words } of TIER_KEYWORDS) {
      if (words.includes(tok)) return tier;
    }
    return 0;
  };
  const verbTier = tierOf(tokens[0]);
  if (verbTier) return verbTier; // leading verb is decisive
  let best = 0;
  for (const tok of tokens) {
    const t = tierOf(tok);
    if (t > best) best = t;
  }
  return best || 2; // unknown tokens default to tier 2 (assume write-capable)
}

/** True when a scope string is a wildcard grant (`*`, `resource:*`, `resource/*`). */
export function isWildcardScope(scope) {
  const s = tokenOrNull(scope);
  if (!s) return false;
  const lc = s.toLowerCase();
  return lc === '*' || lc.endsWith(':*') || lc.endsWith('/*');
}

/**
 * Normalize a partial / loosely-shaped event into a canonical AuditEvent.
 * Never throws - missing fields become null/false/[]; this is the contract the
 * ingest layer and analyzers rely on.
 *
 * @param {object} partial
 * @returns {object} canonical AuditEvent
 */
export function normalizeEvent(partial = {}) {
  const p = partial && typeof partial === 'object' ? partial : {};
  const actor = p.actor && typeof p.actor === 'object' ? p.actor : {};
  const action = p.action && typeof p.action === 'object' ? p.action : {};
  const scopes = p.scopes && typeof p.scopes === 'object' ? p.scopes : {};
  const data = p.data && typeof p.data === 'object' ? p.data : {};

  const host = tokenOrNull(action.host);
  const normAction = {
    type: ['tool', 'api', 'model', 'unknown'].includes(action.type)
      ? action.type
      : (action.tool ? 'tool' : host ? 'api' : 'unknown'),
    tool: tokenOrNull(action.tool),
    server: tokenOrNull(action.server),
    host,
    method: tokenOrNull(action.method),
    endpoint: tokenOrNull(action.endpoint),
  };

  const used = scopeArray(scopes.used);
  // If no explicit used-scope was supplied, derive one from the action.
  if (used.length === 0) {
    const derived = scopeToken(normAction);
    if (derived) used.push(derived);
  }

  const event = {
    id: tokenOrNull(p.id),
    ts: tokenOrNull(p.ts),
    namespace: tokenOrNull(p.namespace) || 'default',
    actor: {
      key_id: tokenOrNull(actor.key_id),
      agent: tokenOrNull(actor.agent),
    },
    action: normAction,
    scopes: {
      granted: scopes.granted == null ? null : scopeArray(scopes.granted),
      used,
    },
    data: {
      has_sensitive: !!data.has_sensitive,
      redacted: !!data.redacted,
      egress: data.egress != null ? !!data.egress : !!host,
    },
    hash: tokenOrNull(p.hash),
    prev_hash: tokenOrNull(p.prev_hash),
    meta: p.meta && typeof p.meta === 'object' ? p.meta : {},
  };

  if (!event.id) {
    // Fold a caller-supplied discriminator into the id when present, so two
    // genuinely-distinct actions that share {ts, ns, key, action} - parallel
    // tool calls (different args) or two calls in the same one-second bucket - 
    // get distinct ids instead of colliding into a false "duplicate-event-ids"
    // finding. ingest passes the provider tool_call id / request_id / a content
    // hash. Absent disc, JSON.stringify omits the undefined key, so the id is
    // byte-identical to the legacy derivation (true byte-identical replays still
    // collapse, keeping replay detection meaningful).
    event.id = eventId({
      ts: event.ts,
      ns: event.namespace,
      key: event.actor.key_id,
      act: event.action,
      disc: tokenOrNull(p.disc) || undefined,
    });
  }
  return event;
}

/** Normalize an array of partial events; non-objects are dropped silently. */
export function normalizeEvents(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (item && typeof item === 'object') out.push(normalizeEvent(item));
  }
  return out;
}
