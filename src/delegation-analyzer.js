// Agent Security-Review audit - multi-agent delegation analyzer (ASR-8).
//
// Consumes normalized AuditEvents (src/audit-event.js, produced by
// src/audit-ingest.js) and answers the question an enterprise reviewer asks
// about agentic systems that fan work out to sub-agents: "when this agent hands
// off to another, does the sub-agent stay inside the delegating agent's
// authority, or does the handoff quietly widen the blast radius?"
//
// It detects delegation two ways:
//   (a) EXPLICIT - an agent invokes a spawn / delegate / handoff / dispatch /
//       orchestrate tool. The sub-agent target is read from the call's meta (or
//       endpoint) when the log records it.
//   (b) IMPLICIT - two or more distinct actor.agent values act under the SAME
//       credential (key_id) or namespace inside one session. The first agent to
//       act is treated as the delegating root; every later distinct agent is a
//       sub-agent of that root.
//
// For each delegation it compares the sub-agent's exercised privilege against
// the delegating agent's, using classifyScopeTier (src/audit-event.js) - the
// same tier grammar the permission analyzer and red-team battery use - and
// emits:
//   - delegation-privilege-escalation (high): the sub-agent exercised a higher
//     privilege tier than the parent ever used (confused-deputy / escalation).
//   - unattenuated-delegation (medium): the sub-agent inherited the parent's
//     authority with no narrowing (equal or lateral scope, no attenuation).
//   - opaque-delegation-hop (medium): a handoff whose sub-agent cannot be
//     attributed from the trail (target identity absent, or its actions never
//     recorded), so the hop cannot be reviewed.
//   - delegation-attenuated (info, positive): every delegation strictly narrowed
//     the sub-agent below the delegating agent. Signable.
//   - delegation-untested (info): no multi-agent delegation was observed. Marked
//     plainly rather than scored clean, mirroring how the red-team battery marks
//     a channel the logs never exercised as untested.
//
// Output also carries delegations[] (one row per handoff) and a small
// agent_graph (nodes = agents, edges = delegations) for the report passport.
//
// Never throws: malformed events are tolerated; an empty set yields an
// all-untested, empty-but-valid result.

import { classifyScopeTier } from './audit-event.js';

const ANALYZER = 'delegation';
const PILLAR = 'delegation';

// Verbs that mark an explicit handoff. A tool whose name carries one of these is
// an agent spawning, delegating to, or dispatching work to another agent.
const SPAWN_RE = /spawn|delegate|sub_?agent|handoff|hand_off|dispatch|orchestrat|invoke_agent|call_agent/;

// Where the sub-agent's identity is recorded on a spawn / delegate call. Checked
// in order; the first non-empty string wins. Specific keys lead so a generic
// 'target' / 'delegate' field is only a fallback.
const TARGET_KEYS = [
  'target_agent', 'child_agent', 'sub_agent', 'subagent', 'sub_agent_id',
  'delegate_to', 'delegateto', 'to_agent', 'assignee', 'worker',
  'spawned_agent', 'callee', 'agent_name', 'target', 'delegate',
];

const UNKNOWN = '(unknown)';
const SEV_ORDER = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

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

function lc(s) {
  return typeof s === 'string' ? s.toLowerCase() : '';
}

/** Highest privilege tier across a set of exercised scopes (0 when empty). */
function tierOfScopes(scopes) {
  let max = 0;
  for (const s of scopes) {
    const t = classifyScopeTier(s);
    if (t > max) max = t;
  }
  return max;
}

/** True when child is a strict subset of parent (every child scope is held by
 *  the parent AND the child exercised strictly fewer): genuine attenuation. */
function isStrictSubset(child, parent) {
  if (child.size >= parent.size) return false;
  for (const s of child) if (!parent.has(s)) return false;
  return true;
}

/** Read the sub-agent identity off a spawn / delegate call, or null if absent. */
function extractTarget(e) {
  const meta = e && e.meta && typeof e.meta === 'object' ? e.meta : {};
  const sources = [meta];
  if (meta.args && typeof meta.args === 'object') sources.push(meta.args);
  if (meta.arguments && typeof meta.arguments === 'object') sources.push(meta.arguments);
  for (const src of sources) {
    for (const k of TARGET_KEYS) {
      const v = src[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  // Endpoint, only when it reads as a bare agent token (not a path/url).
  const ep = e && e.action && e.action.endpoint;
  if (typeof ep === 'string' && ep.trim() && !ep.includes('/') && !ep.includes(':')) {
    return ep.trim();
  }
  return null;
}

function sample(arr, into, n = 6) {
  for (const id of arr) {
    if (!id) continue;
    if (into.length >= n) break;
    if (!into.includes(id)) into.push(id);
  }
  return into;
}

function tierLabel(t) {
  return t > 0 ? `tier ${t}` : 'no exercised scope';
}

/**
 * analyzeDelegation - multi-agent delegation analysis over an AuditEvent list.
 *
 * @param {object[]} events  normalized AuditEvents
 * @param {{ }} [opts]
 * @returns {{ findings: object[], delegations: object[], agent_graph: object, summary: object }}
 */
export function analyzeDelegation(events, opts = {}) {
  void opts; // reserved; signature kept stable for the orchestrator
  const list = Array.isArray(events) ? events.filter((e) => e && typeof e === 'object') : [];

  // --- Pass 1: group events into sessions, accumulate per-agent profiles. -----
  // Session boundary = credential (key_id) when present, else namespace. This
  // mirrors permission-analyzer's actorKey: the credential is the real isolation
  // boundary, so two agent names under one key are a delegation surface.
  const sessions = new Map();
  let order = 0;

  for (const e of list) {
    const actor = (e.actor && typeof e.actor === 'object') ? e.actor : {};
    const keyId = (typeof actor.key_id === 'string' && actor.key_id) ? actor.key_id : null;
    const namespace = (typeof e.namespace === 'string' && e.namespace) ? e.namespace : 'default';
    const sk = keyId ? `key::${keyId}` : `ns::${namespace}`;

    let session = sessions.get(sk);
    if (!session) {
      session = { key: sk, key_id: keyId, namespaces: new Set(), agents: new Map(), spawns: [] };
      sessions.set(sk, session);
    }
    session.namespaces.add(namespace);

    const agentName = (typeof actor.agent === 'string' && actor.agent.trim()) ? actor.agent.trim() : null;
    if (agentName) {
      let p = session.agents.get(agentName);
      if (!p) {
        p = { name: agentName, scopes: new Set(), eventIds: [], firstOrder: order, keyIds: new Set(), namespaces: new Set() };
        session.agents.set(agentName, p);
      }
      const used = (e.scopes && Array.isArray(e.scopes.used)) ? e.scopes.used : [];
      for (const u of used) { const t = lc(u); if (t) p.scopes.add(t); }
      if (p.eventIds.length < 6 && e.id) p.eventIds.push(e.id);
      if (keyId) p.keyIds.add(keyId);
      p.namespaces.add(namespace);
    }

    // Explicit spawn / delegate detection.
    const tool = e.action && e.action.tool ? lc(e.action.tool) : null;
    if (tool && SPAWN_RE.test(tool)) {
      session.spawns.push({ parent: agentName, target: extractTarget(e), via: tool, eventId: e.id });
    }

    order++;
  }

  // Finalize per-agent privilege tier.
  for (const session of sessions.values()) {
    for (const p of session.agents.values()) p.maxTier = tierOfScopes(p.scopes);
  }

  // --- Pass 2: build delegation edges per session. ----------------------------
  const delegations = [];
  const sessionsWithDelegation = new Set();

  function findAgent(session, name) {
    if (!name) return null;
    const target = name.toLowerCase();
    for (const p of session.agents.values()) if (p.name.toLowerCase() === target) return p;
    return null;
  }

  // Classify an evaluable edge from two observed agent profiles.
  function classify(parent, child) {
    if (child.maxTier > parent.maxTier) return 'privilege-escalation';
    if (isStrictSubset(child.scopes, parent.scopes)) return 'attenuated';
    return 'unattenuated';
  }

  function record(session, edge) {
    sessionsWithDelegation.add(session.key);
    delegations.push(edge);
  }

  for (const session of sessions.values()) {
    const seen = new Set(); // `${parent} ${child}` to dedupe explicit+implicit
    const explicitChildren = new Set(); // lowercased child names already linked explicitly

    // 2a. Explicit edges from spawn / delegate calls.
    for (const sp of session.spawns) {
      const parentProfile = sp.parent ? session.agents.get(sp.parent) : null;
      const childProfile = sp.target ? findAgent(session, sp.target) : null;
      const parentName = sp.parent || UNKNOWN;
      const childName = childProfile ? childProfile.name : (sp.target || UNKNOWN);

      const dedupeKey = `${parentName} ${lc(childName)} ${sp.via}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const evidence = sample([sp.eventId, ...(parentProfile ? parentProfile.eventIds : []), ...(childProfile ? childProfile.eventIds : [])], []);

      if (!parentProfile || !sp.target || !childProfile) {
        // Unattributable hop: delegating agent unknown, sub-agent identity not
        // recorded, or a named sub-agent whose actions never appear in the trail.
        const reason = !parentProfile
          ? 'the delegating agent is not attributable'
          : (!sp.target ? 'the sub-agent identity is not recorded on the handoff' : 'the named sub-agent took no attributable action in this trail');
        record(session, {
          session: session.key, type: 'explicit', via: sp.via, parent: parentName, child: childName,
          parent_tier: parentProfile ? parentProfile.maxTier : null,
          child_tier: childProfile ? childProfile.maxTier : null,
          parent_scopes: parentProfile ? [...parentProfile.scopes].sort() : [],
          child_scopes: childProfile ? [...childProfile.scopes].sort() : [],
          classification: 'opaque', observed_child: !!childProfile, reason, evidence,
        });
        continue;
      }

      explicitChildren.add(childProfile.name.toLowerCase());
      const classification = classify(parentProfile, childProfile);
      record(session, {
        session: session.key, type: 'explicit', via: sp.via, parent: parentName, child: childProfile.name,
        parent_tier: parentProfile.maxTier, child_tier: childProfile.maxTier,
        parent_scopes: [...parentProfile.scopes].sort(), child_scopes: [...childProfile.scopes].sort(),
        classification, observed_child: true, evidence,
      });
    }

    // 2b. Implicit edges: >= 2 distinct named agents under one session.
    const agents = [...session.agents.values()].sort((a, b) => a.firstOrder - b.firstOrder);
    if (agents.length >= 2) {
      const root = agents[0];
      for (let i = 1; i < agents.length; i++) {
        const child = agents[i];
        if (explicitChildren.has(child.name.toLowerCase())) continue; // already covered explicitly
        const dedupeKey = `${root.name} ${child.name.toLowerCase()} implicit`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const evidence = sample([...root.eventIds, ...child.eventIds], []);
        record(session, {
          session: session.key, type: 'implicit', via: 'implicit', parent: root.name, child: child.name,
          parent_tier: root.maxTier, child_tier: child.maxTier,
          parent_scopes: [...root.scopes].sort(), child_scopes: [...child.scopes].sort(),
          classification: classify(root, child), observed_child: true, evidence,
        });
      }
    }
  }

  // --- Findings from the edges. ----------------------------------------------
  const findings = [];
  const counts = { 'privilege-escalation': 0, unattenuated: 0, opaque: 0, attenuated: 0 };

  for (const d of delegations) {
    counts[d.classification] = (counts[d.classification] || 0) + 1;
    if (d.classification === 'privilege-escalation') {
      const escalating = d.child_scopes.filter((s) => classifyScopeTier(s) > (d.parent_tier || 0));
      findings.push(finding({
        id: 'delegation-privilege-escalation',
        severity: 'high',
        title: `Privilege escalation via delegation: ${d.parent} -> ${d.child}`,
        detail: `Sub-agent ${d.child} exercised ${tierLabel(d.child_tier)} scope(s) (${escalating.slice(0, 8).join(', ') || d.child_scopes.slice(0, 8).join(', ')}) that exceed the delegating agent ${d.parent}'s observed ${tierLabel(d.parent_tier)}. A lower-privilege agent handed off to a higher-privilege one (confused-deputy / privilege escalation via delegation): an attacker who drives the parent reaches the sub-agent's elevated authority with no step-up control recorded. Bound the sub-agent to a scoped, short-lived credential at or below the delegating agent's tier.`,
        metric: {
          parent: d.parent, child: d.child, parent_tier: d.parent_tier, child_tier: d.child_tier,
          escalating_scopes: escalating, via: d.via, type: d.type, session: d.session,
        },
        evidence: d.evidence,
      }));
    } else if (d.classification === 'unattenuated') {
      const extra = d.child_scopes.filter((s) => !d.parent_scopes.includes(s));
      findings.push(finding({
        id: 'unattenuated-delegation',
        severity: 'medium',
        title: `Unattenuated delegation: ${d.parent} -> ${d.child}`,
        detail: `Sub-agent ${d.child} inherited the delegating agent ${d.parent}'s authority with no narrowing (${tierLabel(d.child_tier)} vs ${tierLabel(d.parent_tier)}; ${extra.length ? `scopes not held by the parent: ${extra.slice(0, 8).join(', ')}` : 'identical scope set'}). Least privilege means each hop attenuates: the sub-agent should receive a strict subset of the parent's scopes, not the full grant. Issue the sub-agent a narrowed credential scoped to only the tools the handoff requires.`,
        metric: {
          parent: d.parent, child: d.child, parent_tier: d.parent_tier, child_tier: d.child_tier,
          child_scopes: d.child_scopes, parent_scopes: d.parent_scopes, scopes_not_in_parent: extra, via: d.via, type: d.type, session: d.session,
        },
        evidence: d.evidence,
      }));
    } else if (d.classification === 'opaque') {
      findings.push(finding({
        id: 'opaque-delegation-hop',
        severity: 'medium',
        title: `Opaque delegation hop: ${d.parent} -> ${d.child}`,
        detail: `A ${d.via} handoff from ${d.parent} cannot be reviewed because ${d.reason}. An unattributable hop breaks the chain of custody: the sub-agent's tools, scopes, and data access are invisible to the audit, so least privilege cannot be evidenced across the boundary. Record the sub-agent identity on every handoff and log the sub-agent's actions under its own attributable identity.`,
        metric: {
          parent: d.parent, child: d.child, reason: d.reason, observed_child: d.observed_child, via: d.via, type: d.type, session: d.session,
        },
        evidence: d.evidence,
      }));
    }
  }

  // Positive / untested rollup. A clean positive only emits when delegation was
  // observed AND nothing problematic was found; absence of delegation is marked
  // untested, never scored clean.
  if (delegations.length === 0) {
    findings.push(finding({
      id: 'delegation-untested',
      severity: 'info',
      title: 'Multi-agent delegation: not observed',
      detail: 'No explicit spawn / delegate handoff and no second agent acting under a shared credential or namespace were observed in the supplied logs, so multi-agent delegation (ASR-8) is untested for this export. This is marked as not-assessed rather than scored clean. To evidence safe delegation, supply logs from a window in which sub-agents are spawned.',
      metric: { delegations: 0 },
      evidence: [],
    }));
  } else {
    const hasProblem = counts['privilege-escalation'] + counts.unattenuated + counts.opaque > 0;
    if (!hasProblem) {
      findings.push(finding({
        id: 'delegation-attenuated',
        severity: 'info',
        title: 'Delegation posture: every handoff attenuated',
        detail: `Every observed delegation (${delegations.length}) narrowed the sub-agent to a strict subset of the delegating agent's exercised scopes, with no privilege escalation, unattenuated inheritance, or unattributable hop. Each sub-agent stayed at or below the parent's privilege tier.`,
        metric: { delegations: delegations.length, attenuated: counts.attenuated },
        evidence: [],
      }));
    }
  }

  findings.sort((a, b) => (SEV_ORDER[b.severity] - SEV_ORDER[a.severity]) || a.id.localeCompare(b.id));

  // --- Agent graph for the passport. ------------------------------------------
  const nodeMap = new Map();
  function node(name) {
    let n = nodeMap.get(name);
    if (!n) { n = { id: name, unknown: name === UNKNOWN, scopes_used: 0, max_tier: 0, event_count: 0, key_ids: new Set(), namespaces: new Set() }; nodeMap.set(name, n); }
    return n;
  }
  for (const session of sessions.values()) {
    for (const p of session.agents.values()) {
      const n = node(p.name);
      n.scopes_used = Math.max(n.scopes_used, p.scopes.size);
      n.max_tier = Math.max(n.max_tier, p.maxTier);
      n.event_count += p.eventIds.length;
      for (const k of p.keyIds) n.key_ids.add(k);
      for (const ns of p.namespaces) n.namespaces.add(ns);
    }
  }
  const graphEdges = [];
  for (const d of delegations) {
    node(d.parent); node(d.child);
    graphEdges.push({ from: d.parent, to: d.child, via: d.via, type: d.type, classification: d.classification });
  }
  const nodes = [...nodeMap.values()]
    .map((n) => ({ id: n.id, unknown: n.unknown, scopes_used: n.scopes_used, max_tier: n.max_tier, event_count: n.event_count, key_ids: [...n.key_ids].sort(), namespaces: [...n.namespaces].sort() }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const agent_graph = { nodes, edges: graphEdges };

  // --- Summary. ---------------------------------------------------------------
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;

  const namedAgents = new Set();
  for (const session of sessions.values()) for (const name of session.agents.keys()) namedAgents.add(name);

  const summary = {
    analyzer: ANALYZER,
    detected: delegations.length > 0,
    delegations: delegations.length,
    agents: namedAgents.size,
    sessions: sessions.size,
    sessions_with_delegation: sessionsWithDelegation.size,
    explicit: delegations.filter((d) => d.type === 'explicit').length,
    implicit: delegations.filter((d) => d.type === 'implicit').length,
    escalations: counts['privilege-escalation'],
    unattenuated: counts.unattenuated,
    opaque: counts.opaque,
    attenuated: counts.attenuated,
    findings: findings.length,
    by_severity: bySeverity,
    note: delegations.length === 0
      ? 'No multi-agent delegation was observed in the supplied logs; ASR-8 (multi-agent delegation) is untested for this export.'
      : undefined,
  };

  return { findings, delegations, agent_graph, summary };
}

export default analyzeDelegation;
