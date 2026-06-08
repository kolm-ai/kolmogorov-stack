// Agent Security-Review audit - retrieval and memory integrity analyzer (ASR-7).
//
// The deterministic spine (src/audit-orchestrator.js runAudit) chains raw logs
// into normalized AuditEvents (src/audit-event.js, produced by
// src/audit-ingest.js); this analyzer reads those same events and answers the
// question a reviewer asks about a retrieval-augmented (RAG) or memory-backed
// agent: "where did the content the model acted on come from, and can a forged
// or poisoned entry be detected?"
//
// Two surfaces stall these deals:
//   1. Retrieval from an EXTERNAL / untrusted source. Retrieved text is fed back
//      into the model, so a poisoned or attacker-controlled document at that
//      source is an indirect prompt-injection / context-poisoning vector - the
//      model acts on content it did not author.
//   2. A memory WRITE with no integrity link and no recorded author. A forged or
//      poisoned memory entry cannot then be detected or attributed, and it steers
//      later turns the moment it is recalled (memory poisoning).
//
// Output is a list of Findings the control-mapper translates into ASR-7 and the
// buyer's frameworks, plus structured retrieval_sources[] and memory_ops[].
//
// No theater: when no retrieval or memory signal is present the surface is
// reported untested (info), never scored clean - mirroring how src/red-team.js
// marks a probe the logs never exercised. Never throws: malformed events are
// tolerated; an empty set yields an untested-but-valid result.

import { classifyScopeTier } from './audit-event.js';

const ANALYZER = 'rag-memory';
const PILLAR = 'rag-memory';

// Case-insensitive token match over action.tool / action.endpoint / action.server.
const RETRIEVAL_RE = /retriev|vector|embed|search|rag|knowledge|index|query_docs|lookup/;
const MEMORY_RE = /memory|remember|recall|store_fact|context_store|scratchpad|session_state/;

// Verb sets used to split a memory operation into read vs write without leaning
// on classifyScopeTier alone (which defaults an unknown verb like "recall" to
// tier 2 / write). A memory op is a WRITE unless it is purely a read verb - the
// conservative direction for a poisoning audit, mirroring the tier classifier's
// "assume write-capable until shown read-only" doctrine.
const MEM_WRITE_VERBS = new Set(['write', 'store', 'set', 'save', 'put', 'post', 'update', 'create', 'insert', 'append', 'add', 'remember', 'memorize', 'persist', 'record', 'upsert', 'cache', 'commit', 'patch', 'push']);
const MEM_READ_VERBS = new Set(['read', 'get', 'recall', 'retrieve', 'fetch', 'list', 'lookup', 'search', 'load', 'query', 'view', 'find']);

// Host suffixes that denote a first-party / internal surface. A retrieval source
// resolving inside these bounds is not a third-party poisoning surface.
const PRIVATE_HOST_SUFFIXES = ['.internal', '.local', '.localdomain', '.svc', '.cluster.local', '.corp', '.intranet', '.lan', '.home.arpa'];

const EVIDENCE_CAP = 8;

function lc(s) {
  return typeof s === 'string' ? s.toLowerCase() : '';
}

function tokensOf(name) {
  return lc(name).split(/[^a-z0-9]+/).filter(Boolean);
}

function pushSample(arr, id) {
  if (id && arr.length < EVIDENCE_CAP && !arr.includes(id)) arr.push(id);
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

// Strip a trailing :port and IPv6 brackets, lowercase. Idempotent.
function hostOnly(value) {
  let h = lc(value).trim();
  if (!h) return '';
  if (h.startsWith('[')) {
    const i = h.indexOf(']');
    if (i > 0) h = h.slice(1, i);
  } else if (/^[^:]+:\d+$/.test(h)) {
    h = h.slice(0, h.lastIndexOf(':'));
  }
  return h;
}

function isIpv4(h) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h);
}

function isPrivateIpv4(h) {
  if (!isIpv4(h)) return false;
  const o = h.split('.').map(Number);
  if (o.some((n) => n > 255)) return false;
  return (
    o[0] === 10 ||
    o[0] === 127 ||
    o[0] === 0 ||
    (o[0] === 192 && o[1] === 168) ||
    (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
    (o[0] === 169 && o[1] === 254)
  );
}

// Match a host/server token against an operator-supplied allow-list: an exact
// hit, or a subdomain of a listed domain (api.idx.acme.com endsWith .acme.com).
function matchesAllow(name, allow) {
  const n = lc(name);
  if (!n) return false;
  return allow.some((a) => n === a || n.endsWith('.' + a));
}

// First-party when: operator-allow-listed; loopback / private IP space; an
// internal DNS suffix; or a single-label (no dot) service hostname. Everything
// else is a third-party host - the untrusted-retrieval direction. The default
// is deliberately strict (an unknown public host is treated as external) so an
// absent allow-list never silently passes a poisoning surface.
function isFirstPartyHost(host, allow) {
  const h = hostOnly(host);
  if (!h) return false;
  if (matchesAllow(h, allow)) return true;
  if (h === 'localhost' || h === '0.0.0.0') return true;
  if (h.includes(':')) {
    // IPv6 loopback / unique-local (fc00::/7) / link-local (fe80::/10).
    if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  }
  if (isPrivateIpv4(h)) return true;
  if (PRIVATE_HOST_SUFFIXES.some((s) => h.endsWith(s))) return true;
  if (!h.includes('.') && !isIpv4(h)) return true; // single-label internal hostname
  return false;
}

// The SOURCE of a retrieval call is action.host, then action.server. A host is
// classified first-party vs external; a server with no host is a named vendor
// surface (enumerated, externality not resolvable from the log) unless the
// operator allow-lists it; neither host nor server means a local / in-process
// index that never left the boundary.
function classifySource(action, allow) {
  const host = hostOnly(action.host);
  if (host) {
    const fp = isFirstPartyHost(host, allow);
    return { source: host, kind: 'host', classification: fp ? 'first-party' : 'external', first_party: fp };
  }
  const server = lc(action.server);
  if (server) {
    const fp = matchesAllow(server, allow);
    return { source: server, kind: 'server', classification: fp ? 'first-party' : 'named', first_party: fp ? true : null };
  }
  return { source: 'in-process', kind: 'local', classification: 'first-party', first_party: true };
}

function buildAllow(options) {
  const out = new Set();
  for (const k of ['firstPartyHosts', 'firstPartyDomains', 'trustedHosts', 'trustedSources']) {
    const v = options[k];
    if (Array.isArray(v)) {
      for (const x of v) {
        const s = lc(x).trim();
        if (s) out.add(s);
      }
    }
  }
  return [...out];
}

/**
 * analyzeRagMemory - retrieval + memory integrity analysis over an AuditEvent list.
 *
 * @param {object[]} events  normalized AuditEvents
 * @param {object} [opts]
 * @param {string[]} [opts.firstPartyHosts]   hosts treated as first-party
 * @param {string[]} [opts.firstPartyDomains] domains whose subdomains are first-party
 * @param {string[]} [opts.trustedHosts]      alias for firstPartyHosts
 * @param {string[]} [opts.trustedSources]    alias for firstPartyHosts
 * @returns {{ findings: object[], retrieval_sources: object[], memory_ops: object[], summary: object }}
 */
export function analyzeRagMemory(events, opts = {}) {
  const list = Array.isArray(events) ? events.filter((e) => e && typeof e === 'object') : [];
  const options = opts && typeof opts === 'object' ? opts : {};
  const allow = buildAllow(options);

  const sourceMap = new Map(); // source key -> retrieval source accumulator
  const memoryMap = new Map(); // tool -> memory op accumulator
  let retrievalCalls = 0;
  let memoryCalls = 0;

  for (const e of list) {
    const action = e.action && typeof e.action === 'object' ? e.action : {};
    const tool = lc(action.tool);
    const endpoint = lc(action.endpoint);
    const server = lc(action.server);
    const method = lc(action.method);

    // Detect on the operation NAME (tool / endpoint / server) - never the host,
    // which is the source, not the operation.
    const name = [tool, endpoint, server].filter(Boolean).join(' ');
    if (!name) continue;
    const isRetrieval = RETRIEVAL_RE.test(name);
    const isMemory = MEMORY_RE.test(name);
    if (!isRetrieval && !isMemory) continue;

    if (isRetrieval) {
      retrievalCalls++;
      const src = classifySource(action, allow);
      const key = src.kind + '::' + src.source;
      let s = sourceMap.get(key);
      if (!s) {
        s = { source: src.source, kind: src.kind, classification: src.classification, first_party: src.first_party, tools: new Set(), calls: 0, evidence: [] };
        sourceMap.set(key, s);
      }
      s.calls++;
      if (tool) s.tools.add(tool);
      else if (endpoint) s.tools.add(endpoint);
      pushSample(s.evidence, e.id);
    }

    if (isMemory) {
      memoryCalls++;
      const opTool = tool || endpoint || server || 'memory';
      const verbTokens = [...tokensOf(tool), ...tokensOf(endpoint), ...tokensOf(method)];
      const hasWrite = verbTokens.some((t) => MEM_WRITE_VERBS.has(t));
      const hasRead = verbTokens.some((t) => MEM_READ_VERBS.has(t));
      const isWrite = hasWrite || !hasRead;
      const integrity = !!e.hash; // a tamper-evident chain link was logged
      const attribution = !!(e.actor && (e.actor.key_id || e.actor.agent));
      const tier = classifyScopeTier(tool ? 'tool:' + tool : (endpoint || method || opTool));

      let m = memoryMap.get(opTool);
      if (!m) {
        m = { tool: opTool, op: 'read', tier, writes: 0, reads: 0, calls: 0, integrity: true, attribution: true, unverified: false, evidence: [] };
        memoryMap.set(opTool, m);
      }
      m.calls++;
      if (tier > m.tier) m.tier = tier;
      if (isWrite) {
        m.writes++;
        m.op = 'write';
        if (!integrity) m.integrity = false;
        if (!attribution) m.attribution = false;
        if (!integrity || !attribution) {
          m.unverified = true;
          pushSample(m.evidence, e.id);
        }
      } else {
        m.reads++;
        if (m.op !== 'write') pushSample(m.evidence, e.id);
      }
    }
  }

  const retrieval_sources = [...sourceMap.values()]
    .map((s) => ({
      source: s.source,
      kind: s.kind,
      classification: s.classification,
      first_party: s.first_party,
      tools: [...s.tools],
      calls: s.calls,
      evidence: s.evidence.slice(0, EVIDENCE_CAP),
    }))
    .sort((a, b) => a.source.localeCompare(b.source));

  const memory_ops = [...memoryMap.values()]
    .map((m) => ({
      tool: m.tool,
      op: m.op,
      tier: m.tier,
      writes: m.writes,
      reads: m.reads,
      calls: m.calls,
      integrity: m.op === 'write' ? m.integrity : null,
      attribution: m.op === 'write' ? m.attribution : null,
      verified: m.op === 'write' ? !m.unverified : null,
      evidence: m.evidence.slice(0, EVIDENCE_CAP),
    }))
    .sort((a, b) => a.tool.localeCompare(b.tool));

  const findings = [];

  // --- untrusted retrieval source (high) - one per distinct external host ---
  const external = retrieval_sources.filter((s) => s.classification === 'external');
  for (const s of external) {
    findings.push(finding({
      id: 'untrusted-retrieval-source',
      severity: 'high',
      pillar: PILLAR,
      title: `Untrusted retrieval source: ${s.source}`,
      detail: `The agent retrieved content from ${s.source}, a third-party host outside the first-party trust boundary, across ${s.calls} call(s)${s.tools.length ? ` via ${s.tools.join(', ')}` : ''}. Retrieved text is fed back into the model, so a poisoned or attacker-controlled document at this source becomes an indirect prompt-injection / context-poisoning vector: the model acts on content it did not author. Confirm this source is an approved, integrity-checked corpus or route retrieval through a first-party index.`,
      metric: { source: s.source, kind: s.kind, tools: s.tools, calls: s.calls, first_party: false },
      evidence: s.evidence.slice(0, EVIDENCE_CAP),
    }));
  }

  // --- unverified memory write (medium) - one per distinct memory write tool ---
  const unverified = [...memoryMap.values()].filter((m) => m.op === 'write' && m.unverified);
  for (const m of unverified) {
    const gaps = [];
    if (!m.integrity) gaps.push('no tamper-evident integrity (hash-chain) link');
    if (!m.attribution) gaps.push('no recorded author (credential or agent)');
    findings.push(finding({
      id: 'unverified-memory-write',
      severity: 'medium',
      pillar: PILLAR,
      title: `Unverified memory write: ${m.tool}`,
      detail: `The agent wrote to durable agent memory via ${m.tool} (${m.writes} write call(s)) with ${gaps.join(' and ')}. A memory entry that carries no integrity link and no recorded author cannot be detected if it is forged or poisoned, and a poisoned entry steers later turns the moment it is recalled (memory poisoning). Attach a hash-chain link and a credential/agent attribution to every memory write so each entry is verifiable and traceable.`,
      metric: { tool: m.tool, op: 'write', tier: m.tier, writes: m.writes, integrity: m.integrity, attribution: m.attribution },
      evidence: m.evidence.slice(0, EVIDENCE_CAP),
    }));
  }

  // --- positive / untested - mirror the permission analyzer's clean-only rule ---
  const hasBlocking = findings.some((f) => f.severity === 'high' || f.severity === 'medium');
  const activity = retrievalCalls > 0 || memoryCalls > 0;
  const writes = memory_ops.reduce((n, m) => n + m.writes, 0);

  if (!activity) {
    // No retrieval or memory signal at all: untested, never scored clean.
    findings.push(finding({
      id: 'rag-memory-untested',
      severity: 'info',
      pillar: PILLAR,
      title: 'Retrieval and memory integrity untested',
      detail: 'No retrieval-augmented or memory operation was observed in the supplied logs, so retrieval and memory integrity (ASR-7) could not be exercised. Absence of a retrieval or memory signal is not evidence of a clean posture, so this control is reported untested rather than passed. Re-run the audit over logs that include the agent\'s retrieval and memory activity to assess it.',
      metric: { retrieval_calls: 0, memory_calls: 0 },
      evidence: [],
    }));
  } else if (!hasBlocking) {
    // Activity present and every source / write was within first-party bounds.
    const parts = [];
    if (retrievalCalls > 0) parts.push(`${retrievalCalls} retrieval call(s) across ${retrieval_sources.length} enumerated source(s), each resolving to a first-party or named surface`);
    if (memoryCalls > 0) parts.push(writes > 0 ? `${memoryCalls} memory operation(s) including ${writes} write(s), each carrying an integrity link and a recorded author` : `${memoryCalls} memory read operation(s)`);
    findings.push(finding({
      id: 'retrieval-sources-enumerated',
      severity: 'info',
      pillar: PILLAR,
      title: 'Retrieval and memory operations within first-party bounds',
      detail: `Observed ${parts.join(' and ')}. No untrusted retrieval source and no unverified memory write were found in the observed window, so the retrieval and memory integrity surface (ASR-7) is exercised and clean for these logs.`,
      metric: { retrieval_calls: retrievalCalls, memory_calls: memoryCalls, sources: retrieval_sources.length },
      evidence: [],
    }));
  }

  return { findings, retrieval_sources, memory_ops, summary: summarize(findings, retrieval_sources, memory_ops, retrievalCalls, memoryCalls, external.length, unverified.length) };
}

function summarize(findings, retrieval_sources, memory_ops, retrievalCalls, memoryCalls, untrustedSources, unverifiedWrites) {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  return {
    analyzer: ANALYZER,
    retrieval_calls: retrievalCalls,
    memory_calls: memoryCalls,
    distinct_sources: retrieval_sources.length,
    untrusted_sources: untrustedSources,
    memory_writes: memory_ops.reduce((n, m) => n + m.writes, 0),
    memory_reads: memory_ops.reduce((n, m) => n + m.reads, 0),
    unverified_writes: unverifiedWrites,
    findings: findings.length,
    by_severity: bySeverity,
  };
}

export default analyzeRagMemory;
