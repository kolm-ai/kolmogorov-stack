// Agent Security-Review audit - agent identity analyzer (the WEDGE data spine).
//
// Consumes normalized AuditEvents (src/audit-event.js, produced by
// src/audit-ingest.js) and answers the question the Agent Identity Passport is
// built on: WHO acted, and can the vendor prove each agent's credential is
// attributable, scoped, and bound to a single identity?
//
// This is M6 plus the core of S1 (Agent Identity Passport). It enumerates the
// distinct agent identities present in a log export - one per unique
// (actor.agent, actor.key_id) pair - and records, for each, the facts a signed
// passport block asserts: the scopes the credential was granted, the scopes it
// exercised, how many tool actions it took, when it was first and last seen,
// and which namespaces it operated in. The integration wave assembles the
// SIGNED passport envelope from these identity facts plus model-provenance and
// delegation; this module produces the identity facts only - it does not sign,
// and it does not build the report envelope.
//
// Findings surface the attestation gaps a reviewer cannot sign over:
//   - unattributed-agent-action (high)  : an action with no key_id AND no agent
//   - ambiguous-agent-identity (medium) : one credential asserts many agent names
//   - unverifiable-agent-scope (medium) : a credential with no declared grant
//   - agent-identity-attested  (info)   : a clean, fully attributed, scoped set
// Plus two graceful-degradation notes that MARK an absent signal rather than
// score it as clean (mirroring how src/red-team.js marks untested probes - no
// theater):
//   - agent-identity-partial   (info)   : attributable, but attribution partial
//   - agent-identity-untested  (info)   : no agent action supplied to assess
//
// Every finding carries pillar 'agent-identity', which the control-mapper
// routes to ASR-1 (least privilege / identity). It is distinct from the
// permission analyzer's shared-credential finding: that one is about least
// privilege (a key that cannot be scoped or revoked per agent); this one is
// about identity attestation (a credential whose asserted subject is ambiguous).
//
// Never throws: malformed events are tolerated; an empty event set yields a
// valid, info-level untested result rather than a fabricated clean posture.

const ANALYZER = 'agent-identity';
const PILLAR = 'agent-identity';

// Composite-key separator that cannot occur inside a trimmed AuditEvent token
// (a NUL byte), so two identities never collide when their agent/key tokens
// abut (e.g. ('svc a','b') vs ('svc','a b')).
const SEP = '\u0000';

function finding(f) {
  return {
    id: f.id,
    analyzer: ANALYZER,
    severity: f.severity,
    pillar: f.pillar || PILLAR,
    title: f.title,
    detail: f.detail,
    metric: f.metric || {},
    evidence: f.evidence || [],
    controls: f.controls || [],
  };
}

// Parse a timestamp into a comparable number of milliseconds, or null. Epoch
// integers (logged as seconds or ms) and ISO strings are both accepted; this
// mirrors how the ingest layer preserves numeric timestamps as strings.
function tsValue(ts) {
  if (ts == null) return null;
  const s = String(ts).trim();
  if (s === '') return null;
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return n < 1e12 ? n * 1000 : n; // seconds vs milliseconds
  }
  const d = Date.parse(s);
  return Number.isNaN(d) ? null : d;
}

// A tool-call event, whether tagged by ingest (meta.kind) or built through the
// canonical constructor (typed action). Mirrors permission-analyzer exactly so
// a normalized-but-not-ingested event still counts its tool actions.
function isToolEvent(e) {
  return !!((e.meta && e.meta.kind === 'tool_call') || (e.action && e.action.type === 'tool'));
}

/**
 * analyzeAgentIdentity - enumerate agent identities and attest each one.
 *
 * @param {object[]} events  normalized AuditEvents
 * @param {object} [opts]    reserved for future options (unused today)
 * @returns {{ findings: object[], identities: object[], summary: object }}
 */
export function analyzeAgentIdentity(events, opts = {}) {
  // Tolerate a non-object opts without throwing (contract: never throw).
  void (opts && typeof opts === 'object');

  const list = Array.isArray(events) ? events.filter((e) => e && typeof e === 'object') : [];

  // No agent action at all: report untested. An absent signal is marked, not
  // scored as a clean identity posture.
  if (list.length === 0) {
    return {
      findings: [finding({
        id: 'agent-identity-untested',
        severity: 'info',
        title: 'Agent identity not assessed: no agent actions supplied',
        detail: 'The supplied logs carried no agent actions, so no agent identity could be enumerated or attested. Absence of activity is reported as untested, not as a clean identity posture.',
        metric: { events: 0, identities: 0 },
        evidence: [],
      })],
      identities: [],
      summary: summarize([], [], { unattributedActions: 0, ambiguousKeys: 0 }),
    };
  }

  // Group by the distinct (agent, key_id) pair - the unit a passport attests.
  const byIdentity = new Map();      // agent\0key_id -> accumulator
  const keyToAgents = new Map();     // key_id -> Set(agent name)
  const keyToNamespaces = new Map(); // key_id -> Set(namespace)
  let unattributedActions = 0;
  const unattributedEvidence = [];

  for (const e of list) {
    const actor = e.actor || {};
    const agent = actor.agent || null;
    const keyId = actor.key_id || null;
    const ns = e.namespace || null;

    // No key_id AND no agent: nobody to attribute the action to.
    if (!agent && !keyId) {
      unattributedActions++;
      if (unattributedEvidence.length < 5 && e.id) unattributedEvidence.push(e.id);
      continue;
    }

    const k = String(agent) + SEP + String(keyId);
    let acc = byIdentity.get(k);
    if (!acc) {
      acc = {
        agent,
        key_id: keyId,
        granted: new Set(),
        grantedKnown: false,
        used: new Set(),
        toolCalls: 0,
        events: 0,
        firstVal: null,
        firstTs: null,
        lastVal: null,
        lastTs: null,
        namespaces: new Set(),
        evidence: [],
      };
      byIdentity.set(k, acc);
    }
    acc.events++;
    if (ns) acc.namespaces.add(ns);

    const scopes = e.scopes || {};
    if (Array.isArray(scopes.granted)) {
      acc.grantedKnown = true;
      for (const g of scopes.granted) acc.granted.add(g);
    }
    for (const u of Array.isArray(scopes.used) ? scopes.used : []) acc.used.add(u);

    if (isToolEvent(e) && e.action && e.action.tool) acc.toolCalls++;

    const tv = tsValue(e.ts);
    if (tv != null) {
      if (acc.firstVal == null || tv < acc.firstVal) { acc.firstVal = tv; acc.firstTs = e.ts; }
      if (acc.lastVal == null || tv > acc.lastVal) { acc.lastVal = tv; acc.lastTs = e.ts; }
    }
    if (acc.evidence.length < 5 && e.id) acc.evidence.push(e.id);

    // Ambiguity bookkeeping: which agent names and namespaces a credential
    // presented under. Only events that carry a key_id participate.
    if (keyId) {
      let s = keyToAgents.get(keyId);
      if (!s) { s = new Set(); keyToAgents.set(keyId, s); }
      if (agent) s.add(agent);
      let nss = keyToNamespaces.get(keyId);
      if (!nss) { nss = new Set(); keyToNamespaces.set(keyId, nss); }
      if (ns) nss.add(ns);
    }
  }

  // Identity records for the passport (deterministically ordered).
  const identities = [...byIdentity.values()]
    .map((a) => ({
      agent: a.agent,
      key_id: a.key_id,
      attribution: a.agent && a.key_id ? 'full' : (a.key_id ? 'key-only' : 'agent-only'),
      scopes_granted: [...a.granted].sort(),
      scopes_granted_known: a.grantedKnown,
      scopes_used: [...a.used].sort(),
      tool_count: a.toolCalls,
      events: a.events,
      first_ts: a.firstTs,
      last_ts: a.lastTs,
      namespaces: [...a.namespaces].sort(),
      evidence: a.evidence,
    }))
    .sort((x, y) =>
      (String(x.key_id) + SEP + String(x.agent)).localeCompare(String(y.key_id) + SEP + String(y.agent)));

  const findings = [];

  // --- unattributed agent action (high) ---
  if (unattributedActions > 0) {
    findings.push(finding({
      id: 'unattributed-agent-action',
      severity: 'high',
      title: `Unattributed agent action: ${unattributedActions} event(s) carry no identity`,
      detail: `${unattributedActions} action(s) were recorded with neither a credential id nor an agent name, so a reviewer cannot attest who acted. Every agent action must carry an attributable identity (a key id and/or an agent name) for the activity to be signed over.`,
      metric: { unattributed_actions: unattributedActions, total_events: list.length },
      evidence: unattributedEvidence,
    }));
  }

  // --- ambiguous agent identity (medium): one credential, many agent names ---
  const ambiguousKeys = [];
  for (const [keyId, agentSet] of [...keyToAgents.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
    if (agentSet.size > 1) {
      ambiguousKeys.push(keyId);
      const agentsArr = [...agentSet].sort();
      const nss = [...(keyToNamespaces.get(keyId) || new Set())].sort();
      findings.push(finding({
        id: 'ambiguous-agent-identity',
        severity: 'medium',
        title: `Ambiguous agent identity: credential ${keyId} asserts ${agentsArr.length} agent names`,
        detail: `One credential (${keyId}) was presented under ${agentsArr.length} distinct agent names (${agentsArr.slice(0, 8).join(', ')}${agentsArr.length > 8 ? ', …' : ''})${nss.length > 1 ? ` across ${nss.length} namespaces` : ''}. A passport binds a credential to a single agent identity, so a verifier cannot tell which named agent this key actually is. Issue one credential per agent identity so each action attests to a single subject.`,
        metric: { key_id: keyId, agents: agentsArr, namespaces: nss },
        evidence: [],
      }));
    }
  }

  // --- unverifiable agent scope (medium): no declared grant anywhere ---
  for (const id of identities) {
    if (id.scopes_granted_known) continue;
    const subject = id.key_id ? `credential ${id.key_id}` : `agent ${id.agent}`;
    findings.push(finding({
      id: 'unverifiable-agent-scope',
      severity: 'medium',
      title: `Unverifiable scope for ${subject}`,
      detail: `${id.key_id ? `Credential ${id.key_id}` : `Agent ${id.agent}`}${id.agent && id.key_id ? ` (agent ${id.agent})` : ''} took ${id.events} action(s) but no event declared a scope grant, so its authority cannot be bounded or attested. Declare an explicit scope grant per credential so the passport can prove least privilege.`,
      metric: { agent: id.agent, key_id: id.key_id, events: id.events, tool_count: id.tool_count, scopes_used: id.scopes_used },
      evidence: id.evidence,
    }));
  }

  // --- positive / graceful-degradation note (only when no gap was found) ---
  if (findings.length === 0) {
    const partial = identities.filter((i) => i.attribution !== 'full');
    if (partial.length === 0) {
      findings.push(finding({
        id: 'agent-identity-attested',
        severity: 'info',
        title: `Agent identity attested: ${identities.length} fully attributed, scoped identit${identities.length === 1 ? 'y' : 'ies'}`,
        detail: `Every observed action carried a credential id and an agent name, each credential was bound to a single agent identity, and every credential declared its scope grant. The ${identities.length} identit${identities.length === 1 ? 'y is' : 'ies are'} attributable and scoped, so a signed identity passport can be issued over them.`,
        metric: { identities: identities.length, agents: identities.map((i) => i.agent) },
        evidence: identities.flatMap((i) => i.evidence).slice(0, 5),
      }));
    } else {
      // Attributable, but at least one identity is missing its agent name or its
      // credential id. Reported as a gap to close (info), NOT scored as a clean
      // attestation, because a passport asserts both a credential and a subject.
      findings.push(finding({
        id: 'agent-identity-partial',
        severity: 'info',
        title: `Agent identity partially attributed: ${partial.length} of ${identities.length} identit${identities.length === 1 ? 'y' : 'ies'} missing a field`,
        detail: `No blocking attribution gap was found, but ${partial.length} identit${partial.length === 1 ? 'y is' : 'ies are'} only partially attributed: ${partial.slice(0, 6).map((i) => (i.key_id ? `credential ${i.key_id} has no agent name` : `agent ${i.agent} has no credential id`)).join('; ')}${partial.length > 6 ? '; …' : ''}. This is marked as a gap to close, not scored as a clean attestation, because a passport asserts both a credential id and an agent name.`,
        metric: {
          identities: identities.length,
          partial: partial.length,
          partial_subjects: partial.map((i) => ({ agent: i.agent, key_id: i.key_id, attribution: i.attribution })),
        },
        evidence: partial.flatMap((i) => i.evidence).slice(0, 5),
      }));
    }
  }

  return {
    findings,
    identities,
    summary: summarize(findings, identities, { unattributedActions, ambiguousKeys: ambiguousKeys.length }),
  };
}

function summarize(findings, identities, extra) {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  const attributed = identities.filter((i) => i.attribution === 'full').length;
  const scoped = identities.filter((i) => i.scopes_granted_known).length;
  return {
    analyzer: ANALYZER,
    identities: identities.length,
    attributed,
    partial: identities.length - attributed,
    scoped,
    unscoped_identities: identities.length - scoped,
    unattributed_actions: extra.unattributedActions || 0,
    ambiguous_keys: extra.ambiguousKeys || 0,
    findings: findings.length,
    by_severity: bySeverity,
    attested: findings.some((f) => f.id === 'agent-identity-attested'),
  };
}

export default analyzeAgentIdentity;
