// Agent Security-Review audit - Sub-Processor Inventory (Offer #8).
//
// A sub-processor inventory answers the one supply-chain question a buyer's
// privacy and vendor-risk team asks before an agent ships: "which third parties
// did this agent's data actually reach?" This module DERIVES that enumeration
// from the audit result the orchestrator already produced (src/audit-orchestrator.js
// runAudit) - every model, named provider, gateway / routed provider, distinct
// host, and MCP / vendor server the audited agents actually touched in the
// supplied window. It re-ingests nothing: it reads result.model_provenance
// (models / providers / mcp_servers), result.egress.destinations and
// result.ingest.stats, so it is offline and byte-for-byte reproducible like the
// rest of the engine.
//
// kolm MAPS, never certifies: this is an ENUMERATION of what the logs evidenced,
// not an attestation that the list is complete. An absent dimension is reported
// as an empty array with a bounding caveat ("enumerated from the supplied window
// only"), never silently treated as "no sub-processors". A control the logs
// never exercised is untested, not a clean pass.
//
// Determinism contract: every array is deduped case-insensitively and sorted by
// a stable key, so two builds over the same audit result are byte-identical -
// the inventory can be folded into the signed report envelope without perturbing
// the canonical form.
//
// Pure / never-throws: a missing or malformed sub-object degrades to an empty
// array for that dimension, never an exception.

const SPEC_VERSION = 'subproc-inventory/1';

// --- small helpers ----------------------------------------------------------

function lc(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Dedup a list of {key, ...} rows case-insensitively on `key`, summing call
// counts, then sort by the lowercased key. To stay byte-identical regardless of
// the INPUT order (so the signed inventory is reproducible), the display value
// of the keyed field is chosen deterministically: the lexicographically-smallest
// casing among the merged rows wins, not the first row seen. `displayKey` names
// the field whose casing must be normalized this way.
function dedupBy(rows, keyOf, displayKey, merge) {
  const byKey = new Map();
  for (const r of rows) {
    const k = lc(keyOf(r));
    if (!k) continue;
    const existing = byKey.get(k);
    if (existing) {
      merge(existing, r);
      // Deterministic display casing: keep the smallest string form.
      const cur = String(existing[displayKey]);
      const incoming = String(r[displayKey]);
      if (incoming < cur) existing[displayKey] = r[displayKey];
    } else {
      byKey.set(k, { _k: k, ...r });
    }
  }
  return [...byKey.values()].sort((a, b) => a._k.localeCompare(b._k)).map((r) => {
    const { _k, ...rest } = r;
    return rest;
  });
}

// ---------------------------------------------------------------------------
/**
 * Derive a signed-ready sub-processor inventory from a runAudit result.
 *
 * @param {object} result - the audit result object from runAudit.
 * @returns {{
 *   spec_version: string,
 *   generated_from: { spec_version: string|null, evidence_tier: string|null },
 *   models: Array<{ slug, provider, pinned, calls }>,
 *   providers: Array<{ name, calls, models, gateway }>,
 *   mcp_servers: Array<{ name, calls, pinned }>,
 *   hosts: Array<{ host, call_count, sensitivity_flag }>,
 *   counts: { models, providers, mcp_servers, hosts, sensitive_hosts },
 *   caveats: string[]
 * }}
 */
export function buildSubprocessorInventory(result) {
  const r = result && typeof result === 'object' ? result : {};
  const prov = r.model_provenance && typeof r.model_provenance === 'object' ? r.model_provenance : {};
  const egress = r.egress && typeof r.egress === 'object' ? r.egress : {};
  const ingest = r.ingest && typeof r.ingest === 'object' ? r.ingest : {};

  // --- Models ----------------------------------------------------------------
  // model_provenance.models: { slug, pinned, provider, calls, hosts[] }.
  const models = dedupBy(
    asArray(prov.models).map((m) => ({
      slug: String(m && m.slug != null ? m.slug : '').trim(),
      provider: lc(m && m.provider),
      pinned: !!(m && m.pinned),
      calls: num(m && m.calls),
    })),
    (m) => m.slug,
    'slug',
    (acc, m) => {
      acc.calls += num(m.calls);
      // pinned is monotonic-pessimistic: an unpinned reference downgrades.
      acc.pinned = acc.pinned && m.pinned;
      if (!acc.provider && m.provider) acc.provider = m.provider;
    },
  );

  // --- Providers (named vendors + gateways / routed providers) ---------------
  // model_provenance.providers: { name, calls, models, pinned, unpinned }.
  // A provider whose name is a known gateway/proxy is flagged so the buyer can
  // see routed sub-processors distinctly from first-party vendors.
  const providers = dedupBy(
    asArray(prov.providers).map((p) => ({
      name: String(p && p.name != null ? p.name : '').trim(),
      calls: num(p && p.calls),
      models: num(p && p.models),
      gateway: GATEWAY_PROVIDERS.has(lc(p && p.name)),
    })),
    (p) => p.name,
    'name',
    (acc, p) => {
      acc.calls += num(p.calls);
      acc.models += num(p.models);
      acc.gateway = acc.gateway || p.gateway;
    },
  );

  // --- MCP / vendor servers --------------------------------------------------
  // model_provenance.mcp_servers: { name, calls, pinned }.
  const mcp_servers = dedupBy(
    asArray(prov.mcp_servers).map((s) => ({
      name: String(s && s.name != null ? s.name : '').trim(),
      calls: num(s && s.calls),
      pinned: !!(s && s.pinned),
    })),
    (s) => s.name,
    'name',
    (acc, s) => {
      acc.calls += num(s.calls);
      acc.pinned = acc.pinned && s.pinned;
    },
  );

  // --- Hosts -----------------------------------------------------------------
  // egress.destinations: { host, calls, sensitive_calls, secret_calls, ... }.
  // Each host carries its observed call_count and a sensitivity flag set when
  // egress flagged sensitive- or secret-shaped content reaching that host.
  const hosts = dedupBy(
    asArray(egress.destinations).map((d) => ({
      host: String(d && d.host != null ? d.host : '').trim(),
      call_count: num(d && d.calls),
      sensitivity_flag: num(d && d.sensitive_calls) > 0 || num(d && d.secret_calls) > 0,
    })),
    (d) => d.host,
    'host',
    (acc, d) => {
      acc.call_count += num(d.call_count);
      acc.sensitivity_flag = acc.sensitivity_flag || d.sensitivity_flag;
    },
  );

  const sensitiveHosts = hosts.filter((h) => h.sensitivity_flag).length;

  const counts = {
    models: models.length,
    providers: providers.length,
    mcp_servers: mcp_servers.length,
    hosts: hosts.length,
    sensitive_hosts: sensitiveHosts,
  };

  // --- Caveats: bound the claim ----------------------------------------------
  const caveats = [];
  caveats.push(
    'This inventory is enumerated from the supplied audit window only; sub-processors the agent reaches outside this window are not represented.',
  );

  const total = counts.models + counts.providers + counts.mcp_servers + counts.hosts;
  if (total === 0) {
    // Untested-style caveat: nothing was observed, so the inventory is empty by
    // absence of evidence, NOT a claim that the agent uses no sub-processors.
    caveats.push(
      'No model, provider, MCP server or egress host was observed in the supplied logs; the sub-processor surface is untested for this export, not evidenced as empty.',
    );
  } else {
    // Reconcile the per-host enumeration against the ingest distinct-host count
    // so the buyer sees when egress observed fewer hosts than ingest counted
    // (e.g. hosts on non-egress events). distinct_hosts is a count, not a list.
    const distinctHosts = num(ingest.distinct_hosts);
    if (distinctHosts > counts.hosts) {
      caveats.push(
        `Ingest observed ${distinctHosts} distinct host(s); ${counts.hosts} carried an egress destination and are enumerated here. Hosts reached on non-egress events are counted but not individually listed.`,
      );
    }
  }

  return {
    spec_version: SPEC_VERSION,
    generated_from: {
      spec_version: r.spec_version != null ? r.spec_version : null,
      evidence_tier:
        r.evidence_tier && typeof r.evidence_tier === 'object' ? r.evidence_tier.grade || null : null,
    },
    models,
    providers,
    mcp_servers,
    hosts,
    counts,
    caveats,
  };
}

// Provider names that denote a multi-provider gateway / routed proxy rather than
// a first-party vendor. Mirrors the gateway set the model-provenance analyzer
// uses, so a routed sub-processor is surfaced distinctly in the inventory.
const GATEWAY_PROVIDERS = new Set([
  'openrouter',
  'portkey',
  'helicone',
  'requesty',
  'gateway',
  'litellm',
  'cloudflare',
]);

export default { buildSubprocessorInventory };
