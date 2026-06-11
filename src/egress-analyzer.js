// Agent Security-Review audit - data-egress analyzer (ASR-3).
//
// Closes GAP-1 (docs/AUDIT-SURFACE-REVIEW-2026.md): ASR-3 is a CORE control in
// the readiness denominator, but until this module no analyzer owned it - the
// control passed by default whenever the regex PII scanner stayed quiet, with
// no destination inventory and no allowlist evaluation behind the pass.
//
// Consumes normalized AuditEvents (src/audit-ingest.js) and answers the first
// question an enterprise reviewer asks about egress: "which destinations did
// this system reach, were they vetted, and did anything sensitive ride along?"
//
//   - destinations[]: the per-host inventory (calls, tools, sensitivity,
//     allowlist verdict) - the seed of a Sub-Processor Inventory.
//   - unapproved-egress-destination (high): an operator allowlist was supplied
//     and a non-model destination fell outside it.
//   - secret-egress (critical): an egress call carried a secret-shaped token
//     (meta.secret_classes from ingest) - a credential left the boundary.
//   - undeclared-egress-surface (medium): NO allowlist was supplied and the
//     agent reached at least one external tool destination; the surface is
//     enumerated but unvetted. This is what kills the silent ASR-3 pass.
//   - egress-allowlisted-clean (info, positive): an allowlist was supplied and
//     every observed destination stayed inside it. Signable.
//   - egress-untested (info): no egress was observed; marked plainly rather
//     than scored clean, mirroring delegation-untested.
//
// Model-call hosts (api.openai.com etc.) are treated as DECLARED inference
// endpoints: they are inventoried but are not, by themselves, an unapproved
// destination - the inference provider is the product's declared dependency,
// assessed separately by the model-provenance analyzer (ASR-5).
//
// Allowlist semantics: opts.allowedHosts / opts.allowlist / opts.allowed_hosts
// (red-team.js normalizeAllowlist), with the suffix-wildcard matching of
// rag-memory-analyzer's matchesAllow: 'acme.com' (or '*.acme.com') admits
// acme.com and every subdomain.
//
// Never throws: malformed events are tolerated; an empty set yields an
// untested, empty-but-valid result.

const ANALYZER = 'egress';
const PILLAR = 'data-egress';

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

function pushSample(arr, id, n = 6) {
  if (id && arr.length < n && !arr.includes(id)) arr.push(id);
}

// Caller-supplied allowlist (opts.allowedHosts / opts.allowlist), lowercased,
// with a leading '*.' wildcard prefix folded into the bare suffix.
function normalizeAllowlist(options) {
  const raw = options && (options.allowedHosts || options.allowlist || options.allowed_hosts);
  const out = [];
  if (Array.isArray(raw)) {
    for (const h of raw) {
      if (typeof h !== 'string') continue;
      let v = h.trim().toLowerCase();
      if (v.startsWith('*.')) v = v.slice(2);
      if (v && !out.includes(v)) out.push(v);
    }
  }
  return out;
}

// Exact hit, or a subdomain of a listed domain (api.idx.acme.com matches
// acme.com) - the same semantics as rag-memory-analyzer's matchesAllow.
function matchesAllow(host, allow) {
  const n = lc(host);
  if (!n) return false;
  return allow.some((a) => n === a || n.endsWith('.' + a));
}

/**
 * analyzeEgress - data-egress analysis over an AuditEvent list.
 *
 * @param {object[]} events  normalized AuditEvents
 * @param {{ allowedHosts?: string[], allowlist?: string[] }} [opts]
 * @returns {{ findings: object[], destinations: object[], summary: object }}
 */
export function analyzeEgress(events, opts = {}) {
  const list = Array.isArray(events) ? events.filter((e) => e && typeof e === 'object') : [];
  const allow = normalizeAllowlist(opts && typeof opts === 'object' ? opts : {});
  const allowlistDeclared = allow.length > 0;

  // --- One pass: per-host accumulation. --------------------------------------
  const byHost = new Map();
  let egressEvents = 0;
  let secretEgressEvents = 0;
  const secretClasses = new Set();
  const secretEvidence = [];

  for (const e of list) {
    if (!e.data || e.data.egress !== true) continue;
    const meta = e.meta && typeof e.meta === 'object' ? e.meta : {};
    const action = e.action && typeof e.action === 'object' ? e.action : {};
    const host = lc(action.host) || lc(meta.args_host);
    if (!host) continue;
    egressEvents++;

    let row = byHost.get(host);
    if (!row) {
      row = {
        host,
        calls: 0,
        model_calls: 0,
        tool_calls: 0,
        tools: new Set(),
        sensitive_calls: 0,
        secret_calls: 0,
        allowlisted: matchesAllow(host, allow),
        evidence: [],
      };
      byHost.set(host, row);
    }
    row.calls++;
    const isModel = meta.kind === 'model_call' || action.type === 'model';
    if (isModel) row.model_calls++;
    else row.tool_calls++;
    if (action.tool) row.tools.add(lc(action.tool));
    if (e.data.has_sensitive === true) row.sensitive_calls++;
    const eventSecrets = Array.isArray(meta.secret_classes) ? meta.secret_classes.filter(Boolean) : [];
    if (eventSecrets.length > 0) {
      row.secret_calls++;
      secretEgressEvents++;
      for (const c of eventSecrets) secretClasses.add(String(c));
      pushSample(secretEvidence, e.id);
    }
    pushSample(row.evidence, e.id);
  }

  // The sorted inventory - the Sub-Processor Inventory seed.
  const destinations = [...byHost.values()]
    .map((r) => ({
      host: r.host,
      calls: r.calls,
      model_calls: r.model_calls,
      tool_calls: r.tool_calls,
      tools: [...r.tools].sort(),
      sensitive_calls: r.sensitive_calls,
      secret_calls: r.secret_calls,
      allowlisted: r.allowlisted,
      evidence: r.evidence,
    }))
    .sort((a, b) => a.host.localeCompare(b.host));

  // Model-call hosts are declared inference endpoints; the unapproved /
  // undeclared evaluations apply to the NON-model destinations the agent's
  // tools reached.
  const nonModelDests = destinations.filter((d) => d.tool_calls > 0);
  const unapproved = allowlistDeclared ? nonModelDests.filter((d) => !d.allowlisted) : [];

  // --- Findings. --------------------------------------------------------------
  const findings = [];
  const untested = egressEvents === 0;

  if (untested) {
    findings.push(finding({
      id: 'egress-untested',
      severity: 'info',
      title: 'Data egress: not observed',
      detail: 'No call carrying an egress destination was observed in the supplied logs, so data egress (ASR-3) is untested for this export. This is marked as not-assessed rather than scored clean. To evidence egress posture, supply logs from a window in which the agent reaches external destinations (model endpoints, webhooks, email recipients, HTTP tools).',
      metric: { egress_events: 0, destinations: 0 },
      evidence: [],
    }));
  } else {
    if (secretEgressEvents > 0) {
      findings.push(finding({
        id: 'secret-egress',
        severity: 'critical',
        title: 'Secret-shaped token left the boundary',
        detail: `${secretEgressEvents} egress call(s) carried a credential-shaped token (${[...secretClasses].sort().slice(0, 8).join(', ')}) in the message or argument body. A secret that leaves the trust boundary is immediately exploitable regardless of destination trust: rotate the exposed credential class(es) and add redaction before egress. The matched values are never echoed into this report - only the shape classes.`,
        metric: { secret_egress_events: secretEgressEvents, secret_classes: [...secretClasses].sort() },
        evidence: secretEvidence,
      }));
    }

    if (allowlistDeclared && unapproved.length > 0) {
      const ev = [];
      for (const d of unapproved) for (const id of d.evidence) pushSample(ev, id);
      findings.push(finding({
        id: 'unapproved-egress-destination',
        severity: 'high',
        title: `Egress to ${unapproved.length} destination(s) outside the approved allowlist`,
        detail: `The operator declared an egress allowlist (${allow.slice(0, 8).join(', ')}${allow.length > 8 ? ', ...' : ''}), and the agent's tools reached ${unapproved.length} destination(s) outside it: ${unapproved.map((d) => `${d.host} (${d.calls} call(s))`).slice(0, 8).join(', ')}. Every destination an agent can reach is a data-egress path; route these through an approved proxy, add them to the vetted sub-processor list, or remove the tool's ability to reach them.`,
        metric: {
          allowlist: allow,
          unapproved: unapproved.map((d) => ({ host: d.host, calls: d.calls, tools: d.tools, sensitive_calls: d.sensitive_calls })),
          unapproved_destinations: unapproved.length,
        },
        evidence: ev,
      }));
    }

    if (!allowlistDeclared && nonModelDests.length > 0) {
      const ev = [];
      for (const d of nonModelDests) for (const id of d.evidence) pushSample(ev, id);
      findings.push(finding({
        id: 'undeclared-egress-surface',
        severity: 'medium',
        title: `${nonModelDests.length} egress destination(s) reached with no declared allowlist`,
        detail: `The agent's tools reached ${nonModelDests.length} distinct destination(s) - ${nonModelDests.map((d) => `${d.host} (${d.calls} call(s)${d.sensitive_calls ? ', sensitive content' : ''})`).slice(0, 8).join('; ')} - and no egress allowlist was supplied, so none of them can be evaluated as approved or unapproved. ASR-3 requires egress destinations to be enumerated AND vetted: declare the approved destination list so the next audit can verify every host against it.`,
        metric: {
          destinations: nonModelDests.map((d) => ({ host: d.host, calls: d.calls, tools: d.tools, sensitive_calls: d.sensitive_calls })),
          destination_count: nonModelDests.length,
        },
        evidence: ev,
      }));
    }

    if (allowlistDeclared && unapproved.length === 0 && secretEgressEvents === 0) {
      findings.push(finding({
        id: 'egress-allowlisted-clean',
        severity: 'info',
        title: 'Egress posture: every destination inside the approved allowlist',
        detail: `${egressEvents} egress call(s) reached ${destinations.length} destination(s), and every tool destination fell inside the operator-declared allowlist (${allow.slice(0, 8).join(', ')}${allow.length > 8 ? ', ...' : ''}); no secret-shaped token left the boundary. The destination inventory is enumerated in this report.`,
        metric: { egress_events: egressEvents, destinations: destinations.length, allowlist: allow },
        evidence: [],
      }));
    }
  }

  findings.sort((a, b) => (SEV_ORDER[b.severity] - SEV_ORDER[a.severity]) || a.id.localeCompare(b.id));

  // --- Summary. ---------------------------------------------------------------
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;

  const summary = {
    analyzer: ANALYZER,
    untested,
    egress_events: egressEvents,
    destinations: destinations.length,
    unapproved: unapproved.length,
    allowlist_declared: allowlistDeclared,
    secret_egress: secretEgressEvents,
    findings: findings.length,
    by_severity: bySeverity,
    note: untested
      ? 'No egress destination was observed in the supplied logs; ASR-3 (data egress) is untested for this export.'
      : undefined,
  };

  return { findings, destinations, summary };
}

export default analyzeEgress;
