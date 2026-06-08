// Agent Security-Review audit - permission analyzer (least-privilege proof).
//
// Consumes normalized AuditEvents (src/audit-event.js, produced by
// src/audit-ingest.js) and answers the question an enterprise reviewer asks
// first: "is this agent over-permissioned, and can the vendor prove it isn't?"
//
// It compares what each credential / agent was GRANTED against what it
// actually EXERCISED, and surfaces the four posture problems the field data
// says stall deals: wildcard grants, over-permission (granted-but-unused),
// shared credentials (one key across many agents), and high-privilege
// (destructive / egress) actions. Output is a list of Findings the
// control-mapper translates into SOC 2 / ISO 42001 / NIST AI RMF / EU AI Act
// / OWASP controls.
//
// Never throws: malformed events are tolerated; an empty event set yields an
// empty-but-valid result.

import { classifyScopeTier, isWildcardScope } from './audit-event.js';

const ANALYZER = 'permission';

// A granted/used surface counts as "broadly over-permissioned" past this
// fraction of grants going unused.
const OVERPERM_HIGH = 0.5;

function uniq(list) {
  return Array.from(new Set(list));
}

function actorKey(e) {
  // Prefer the credential id (that is what a least-privilege grant attaches
  // to); fall back to the agent name, then namespace, then a sentinel.
  return (e.actor && (e.actor.key_id || e.actor.agent)) || e.namespace || 'unknown';
}

function actorLabel(e) {
  const a = e.actor || {};
  if (a.key_id && a.agent) return `${a.agent} (key ${a.key_id})`;
  if (a.key_id) return `key ${a.key_id}`;
  if (a.agent) return a.agent;
  return e.namespace || 'unknown';
}

function finding(f) {
  return {
    id: f.id,
    analyzer: ANALYZER,
    severity: f.severity,
    pillar: f.pillar,
    title: f.title,
    detail: f.detail,
    metric: f.metric || {},
    evidence: f.evidence || [],
    controls: f.controls || [],
  };
}

/**
 * analyzePermissions - least-privilege analysis over an AuditEvent list.
 *
 * @param {object[]} events  normalized AuditEvents
 * @param {{ }} [opts]
 * @returns {{ findings: object[], actors: object[], summary: object }}
 */
export function analyzePermissions(events, _opts = {}) {
  const list = Array.isArray(events) ? events.filter((e) => e && typeof e === 'object') : [];

  // Group by actor; accumulate granted vs used scopes and tool-call counts.
  const byActor = new Map();
  // key_id -> set of agent names (for shared-credential detection)
  const keyToAgents = new Map();

  for (const e of list) {
    const k = actorKey(e);
    let a = byActor.get(k);
    if (!a) {
      a = {
        key: k,
        label: actorLabel(e),
        key_id: (e.actor && e.actor.key_id) || null,
        agents: new Set(),
        granted: new Set(),
        grantedKnown: false, // did ANY event carry an explicit grant list?
        used: new Set(),
        usedTools: new Set(),
        toolCalls: 0,
        egress: 0,
        sensitiveEgress: 0,
        sampleEvents: [],
      };
      byActor.set(k, a);
    }
    if (e.actor && e.actor.agent) a.agents.add(e.actor.agent);

    const scopes = e.scopes || {};
    if (Array.isArray(scopes.granted)) {
      a.grantedKnown = true;
      for (const g of scopes.granted) a.granted.add(g);
    }
    for (const u of Array.isArray(scopes.used) ? scopes.used : []) a.used.add(u);

    // A tool call is identified by the ingest meta tag OR - for events built
    // through the documented canonical constructor normalizeEvent, which does
    // NOT set meta.kind (it is source-specific passthrough) - by the typed
    // action. Without this, a perfectly least-privilege agent whose events were
    // normalized rather than ingested is falsely reported 100% over-permissioned.
    const isTool = (e.meta && e.meta.kind === 'tool_call') || (e.action && e.action.type === 'tool');
    if (isTool && e.action && e.action.tool) {
      a.usedTools.add('tool:' + String(e.action.tool).toLowerCase());
      a.toolCalls++;
    }
    if (e.data && e.data.egress) {
      a.egress++;
      if (e.data.has_sensitive) a.sensitiveEgress++;
    }
    if (a.sampleEvents.length < 5) a.sampleEvents.push(e.id);

    // shared-credential bookkeeping
    if (e.actor && e.actor.key_id) {
      let s = keyToAgents.get(e.actor.key_id);
      if (!s) { s = new Set(); keyToAgents.set(e.actor.key_id, s); }
      if (e.actor.agent) s.add(e.actor.agent);
    }
  }

  const findings = [];
  const actors = [];

  for (const a of byActor.values()) {
    const granted = uniq([...a.granted]);
    // Used tools come from the tool-call accumulator AND from any tool: scope
    // recorded on scopes.used (the schema's documented exercised-scopes field),
    // so a canonically-constructed event with scopes.used but no meta.kind still
    // counts as exercised. host:verb scopes are excluded - they are derived, not
    // tool grants.
    const usedTools = uniq([...a.usedTools, ...[...a.used].filter((u) => u.startsWith('tool:'))]);
    const wildcards = granted.filter(isWildcardScope);

    // Over-permission: tool grants that were never exercised. Restrict the
    // comparison to tool: scopes - host:verb "scopes" are derived, not grants.
    const grantedTools = granted.filter((g) => g.startsWith('tool:'));
    const unusedTools = grantedTools.filter((g) => !usedTools.includes(g) && !isWildcardScope(g));

    // Undeclared calls: a tool was exercised that the declared grant set did
    // not include - escalation, or grant logging is incomplete. Only meaningful
    // when grants were actually declared and are not wildcard.
    const hasWildcard = wildcards.length > 0;
    const undeclared = a.grantedKnown && !hasWildcard
      ? usedTools.filter((t) => !grantedTools.includes(t))
      : [];

    // Privilege tiers exercised.
    const tierCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };
    for (const t of usedTools) tierCounts[classifyScopeTier(t)]++;
    const tier4 = usedTools.filter((t) => classifyScopeTier(t) === 4);

    actors.push({
      label: a.label,
      key_id: a.key_id,
      agents: [...a.agents],
      granted_tools: grantedTools.length,
      used_tools: usedTools.length,
      unused_tools: unusedTools.length,
      wildcard_grants: wildcards.length,
      tool_calls: a.toolCalls,
      egress_events: a.egress,
      sensitive_egress_events: a.sensitiveEgress,
      tier_counts: tierCounts,
    });

    // --- wildcard grant (critical) ---
    if (hasWildcard) {
      findings.push(finding({
        id: 'wildcard-grant',
        severity: 'critical',
        pillar: 'permission',
        title: `Wildcard permission grant on ${a.label}`,
        detail: `The credential holds a wildcard scope (${wildcards.join(', ')}), so it can invoke any tool or reach any resource regardless of need. A reviewer cannot bound the blast radius of a compromised key.`,
        metric: { wildcard_scopes: wildcards, agent: a.label },
        evidence: a.sampleEvents,
      }));
    }

    // --- over-permission (medium / high) ---
    if (grantedTools.length > 0 && unusedTools.length > 0) {
      const ratio = unusedTools.length / grantedTools.length;
      const broad = ratio >= OVERPERM_HIGH;
      findings.push(finding({
        id: 'over-permission',
        severity: broad ? 'high' : 'medium',
        pillar: 'permission',
        title: `Over-permissioned: ${a.label} grants ${grantedTools.length} tools, uses ${usedTools.length}`,
        detail: `${unusedTools.length} of ${grantedTools.length} granted tools (${Math.round(ratio * 100)}%) were never exercised in the observed window. Least privilege means scoping the credential down to the ${usedTools.length} actually used: ${unusedTools.slice(0, 12).join(', ')}${unusedTools.length > 12 ? ', …' : ''}.`,
        metric: { granted: grantedTools.length, used: usedTools.length, unused: unusedTools.length, unused_ratio: Number(ratio.toFixed(3)), unused_scopes: unusedTools },
        evidence: a.sampleEvents,
      }));
    }

    // --- grants never declared at all (cannot prove least privilege) ---
    if (!a.grantedKnown && a.toolCalls > 0) {
      findings.push(finding({
        id: 'no-declared-grants',
        severity: 'medium',
        pillar: 'permission',
        title: `No declared permission scope for ${a.label}`,
        detail: `The agent invoked ${usedTools.length} distinct tools (${a.toolCalls} calls) but the logs carry no declaration of what the credential was permitted to do, so least privilege cannot be evidenced. Declare an explicit allow-list per credential.`,
        metric: { used_tools: usedTools.length, tool_calls: a.toolCalls, tools: usedTools },
        evidence: a.sampleEvents,
      }));
    }

    // --- undeclared / escalation calls ---
    if (undeclared.length > 0) {
      findings.push(finding({
        id: 'undeclared-tool-call',
        severity: 'high',
        pillar: 'tool-abuse',
        title: `Undeclared tool use by ${a.label}`,
        detail: `${undeclared.length} tool(s) were invoked that the declared grant set did not include: ${undeclared.join(', ')}. This is either privilege escalation or a gap in how grants are recorded - both block a clean least-privilege attestation.`,
        metric: { undeclared_tools: undeclared },
        evidence: a.sampleEvents,
      }));
    }

    // --- high-privilege (tier-4) actions ---
    if (tier4.length > 0) {
      findings.push(finding({
        id: 'high-privilege-action',
        severity: 'high',
        pillar: 'tool-abuse',
        title: `High-privilege actions exercised by ${a.label}`,
        detail: `${tier4.length} exercised scope(s) are destructive or data-leaving-the-boundary (tier 4): ${tier4.join(', ')}. These should require step-up controls (approval, scoped short-lived credentials, or human-in-the-loop) rather than a standing grant.`,
        metric: { tier4_scopes: tier4, tier_counts: tierCounts },
        evidence: a.sampleEvents,
      }));
    }

    // --- sensitive data leaving the boundary ---
    if (a.sensitiveEgress > 0) {
      findings.push(finding({
        id: 'sensitive-egress',
        severity: 'high',
        pillar: 'data-egress',
        title: `Sensitive data left the boundary via ${a.label}`,
        detail: `${a.sensitiveEgress} call(s) carrying detected sensitive content reached an external host. Confirm these destinations are approved sub-processors and that redaction is applied before egress.`,
        metric: { sensitive_egress_events: a.sensitiveEgress, egress_events: a.egress },
        evidence: a.sampleEvents,
      }));
    }
  }

  // --- shared credential across agents (account-wide) ---
  for (const [keyId, agentSet] of keyToAgents) {
    if (agentSet.size > 1) {
      findings.push(finding({
        id: 'shared-credential',
        severity: 'high',
        pillar: 'permission',
        title: `Shared credential: key ${keyId} used by ${agentSet.size} agents`,
        detail: `One API key is shared across ${agentSet.size} distinct agents/services (${[...agentSet].slice(0, 8).join(', ')}${agentSet.size > 8 ? ', …' : ''}). A shared key cannot be revoked or scoped per agent and destroys per-agent attribution in the audit trail. Issue one least-privilege key per agent.`,
        metric: { key_id: keyId, agents: [...agentSet] },
        evidence: [],
      }));
    }
  }

  // --- positive finding: clean least privilege (signable) ---
  if (findings.length === 0 && list.length > 0) {
    findings.push(finding({
      id: 'least-privilege-clean',
      severity: 'info',
      pillar: 'permission',
      title: 'Least-privilege posture: no permission findings',
      detail: 'Every credential exercised only tools within its declared grant, with no wildcard grants, shared credentials, or undeclared escalations in the observed window.',
      metric: {},
      evidence: [],
    }));
  }

  return { findings, actors, summary: summarize(findings, actors, keyToAgents) };
}

function summarize(findings, actors, keyToAgents) {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  let sharedKeys = 0;
  for (const s of keyToAgents.values()) if (s.size > 1) sharedKeys++;
  return {
    analyzer: ANALYZER,
    actors: actors.length,
    findings: findings.length,
    by_severity: bySeverity,
    shared_keys: sharedKeys,
    wildcard_actors: actors.filter((a) => a.wildcard_grants > 0).length,
    over_permissioned_actors: actors.filter((a) => a.unused_tools > 0).length,
  };
}
