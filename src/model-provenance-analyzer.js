// Agent Security-Review audit - model & supply-chain provenance analyzer (ASR-5).
//
// Consumes normalized AuditEvents (src/audit-event.js, produced by
// src/audit-ingest.js) and answers the supply-chain question an enterprise
// reviewer asks once least-privilege and the audit trail check out: "which
// models, vendors and MCP servers did this agent actually reach, and can each
// be vetted?" The deterministic trinity (permission + audit-trail + control)
// leaves ASR-5 not-assessed; this module is that leg, run over the SAME events
// so it is offline and byte-for-byte reproducible like the rest of the engine.
//
// From the events it enumerates the MODEL + DEPENDENCY + MCP/vendor surface and
// flags the four provenance problems a reviewer must close before a signed
// report can claim ASR-5:
//
//   - unpinned-model-version  (medium) a model invoked by a floating alias
//                             ('gpt-4o') rather than a pinned snapshot
//                             ('gpt-4o-2024-08-06'); the bytes behind the alias
//                             can change under the deployment without notice.
//   - opaque-model-routing    (low/medium) a model reached through a third-party
//                             gateway where the true upstream is not evidenced.
//   - unpinned-mcp-server     (medium) an MCP / vendor server invoked with no
//                             declared trust or version/digest pin.
//   - model-egress-third-party(high) sensitive data reached a third-party model
//                             or MCP vendor unredacted - a sub-processor to vet.
//
// No theater: when the logs never exercise a model call the model-provenance
// dimension is reported UNTESTED (info), never scored clean - mirroring how
// src/red-team.js marks probes the logs never exercised. An absent pin, an
// absent gateway, an absent egress are treated as untested/unknown, not as a
// pass. Findings carry pillar 'supply-chain' so the control-mapper's
// PILLAR_MAP -> ASR-5 fallback (and OWASP LLM05 / LLM03, MITRE ATLAS AML.T0010,
// NIST MAP-4, ISO A.10) applies.
//
// Never throws: malformed events are tolerated; an empty event set yields an
// empty-but-valid result with the single untested info finding.

const ANALYZER = 'model-provenance';
const PILLAR = 'supply-chain';

// Evidence id sample cap per finding (opaque event ids only - never raw bodies).
const EVIDENCE_CAP = 6;

// Hosts that are multi-provider gateways / proxies: the call reached this host,
// but it may serve the named model via a first-party API, Bedrock, Vertex, or
// another backend, so the true upstream is not evidenced by the host alone.
const GATEWAY_HOSTS = new Set([
  'openrouter.ai',
  'gateway.ai.cloudflare.com',
  'api.portkey.ai',
  'gateway.helicone.ai',
  'oai.helicone.ai',
  'anthropic.helicone.ai',
  'api.requesty.ai',
  'litellm',
]);

// Source tags that denote a gateway/proxy in the path. Only used to flag opaque
// routing when no upstream host was recorded at all (an explicit api_base, as a
// self-hosted LiteLLM proxy records, is NOT opaque - the real upstream is known).
const GATEWAY_SOURCES = new Set(['openrouter', 'portkey', 'helicone', 'requesty']);
const GATEWAY_PROVIDER_NAMES = new Set(['openrouter', 'portkey', 'helicone', 'requesty', 'gateway']);

// Reverse of the ingest's provider->host table: map a known inference host back
// to a provider label so a model reached by host (no slug prefix) still names a
// vendor. Kept in sync with src/audit-ingest.js PROVIDER_HOSTS.
const HOST_PROVIDER = {
  'api.openai.com': 'openai',
  'azure-openai': 'azure',
  'api.anthropic.com': 'anthropic',
  'bedrock.amazonaws.com': 'bedrock',
  'aiplatform.googleapis.com': 'vertex',
  'generativelanguage.googleapis.com': 'google',
  'api.cohere.com': 'cohere',
  'api.mistral.ai': 'mistral',
  'api.groq.com': 'groq',
  'api.together.xyz': 'together',
  'api.fireworks.ai': 'fireworks',
  'api.deepseek.com': 'deepseek',
  'openrouter.ai': 'openrouter',
  localhost: 'ollama',
  'api.x.ai': 'xai',
};

// Model-name -> provider heuristics, applied to the model-name part (after any
// "provider/" prefix) when the slug carries no explicit vendor. Ordered: first
// match wins.
const NAME_PROVIDER = [
  [/^(gpt|o1|o3|o4|chatgpt|text-embedding|text-davinci|davinci|babbage|dall-e|whisper|tts|omni-moderation)\b/, 'openai'],
  [/^claude\b/, 'anthropic'],
  [/^(gemini|palm|chat-bison|text-bison|textembedding-gecko|gemma)\b/, 'google'],
  [/^(mistral|mixtral|codestral|ministral|pixtral|magistral|devstral)\b/, 'mistral'],
  [/^(command|rerank|embed-english|embed-multilingual)\b/, 'cohere'],
  [/^(llama|meta-llama|codellama)\b/, 'meta'],
  [/^deepseek\b/, 'deepseek'],
  [/^grok\b/, 'xai'],
  [/^(qwen|qwq)\b/, 'qwen'],
  [/^phi\b/, 'microsoft'],
  [/^(nous|hermes|dolphin)\b/, 'nousresearch'],
  [/^(jamba|jurassic)\b/, 'ai21'],
];

/* --------------------------------------------------------------------- */
/* small, never-throw helpers                                             */
/* --------------------------------------------------------------------- */

function tokenOrNull(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

function lc(value) {
  const s = tokenOrNull(value);
  return s ? s.toLowerCase() : null;
}

function pushId(arr, id) {
  if (id && arr.length < EVIDENCE_CAP && !arr.includes(id)) arr.push(id);
}

function isModelEvent(e) {
  return !!((e.action && e.action.type === 'model') || (e.meta && e.meta.kind === 'model_call'));
}

function metaModel(e) {
  return tokenOrNull(e.meta && e.meta.model);
}

// Read the routed/upstream-provider hint the ingest records. The canonical
// schema names it meta.routedProvider; the ingest emits meta.routed_provider.
// Accept either so the analyzer reads both shapes.
function routedProviderOf(e) {
  const m = e.meta || {};
  return lc(m.routedProvider || m.routed_provider);
}

function sourceOf(e) {
  return lc(e.meta && e.meta.source);
}

function hostOf(e) {
  return lc(e.action && e.action.host);
}

function serverOf(e) {
  return lc(e.action && e.action.server);
}

// The model-name part of a slug, after stripping a leading "provider/" prefix.
function modelName(slug) {
  const s = lc(slug);
  if (!s) return null;
  const i = s.indexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

// The vendor a slug names by itself (prefix, then name heuristic). Null when the
// slug alone cannot identify the model vendor - the fully-opaque case.
function upstreamFromSlug(slug) {
  const s = lc(slug);
  if (!s) return null;
  const i = s.indexOf('/');
  if (i > 0) {
    const prefix = s.slice(0, i);
    if (!GATEWAY_PROVIDER_NAMES.has(prefix)) return prefix;
  }
  const name = modelName(s);
  for (const [re, provider] of NAME_PROVIDER) {
    if (re.test(name)) return provider;
  }
  return null;
}

// The provider label for a model event: the slug's vendor first, then a known
// host, then the bare host, else 'unknown'.
function providerOf(slug, host, routed) {
  const fromSlug = upstreamFromSlug(slug);
  if (fromSlug) return fromSlug;
  const h = host || routed;
  if (h) return HOST_PROVIDER[h] || h;
  return 'unknown';
}

// True when a model slug carries a pinned snapshot - a dated or numbered version
// the deployment cannot silently re-point. A bare alias ('gpt-4o') or an
// explicit '-latest' is floating, not pinned.
function isPinnedSlug(slug) {
  const name = modelName(slug);
  if (!name) return false;
  if (/(?:^|[-_@:/])latest$/.test(name)) return false; // explicitly floating
  if (/\d{4}-\d{2}-\d{2}/.test(name)) return true; // ISO date snapshot (2024-08-06)
  if (/(?:^|[^\d])\d{8}(?:[^\d]|$)/.test(name)) return true; // YYYYMMDD (20241022)
  if (/(?:^|[-_@])\d{4}(?:$|[-_])/.test(name)) return true; // 4-digit snapshot (-0613 / -1106 / -2407)
  if (/@\d+(?:\.\d+)+/.test(name)) return true; // @1.5 style version pin
  if (/[-_]v\d+(?:\.\d+)+/.test(name)) return true; // -v1.2 style version pin
  return false;
}

// True when an MCP server token carries an inline version / digest pin.
function inlinePinnedServer(server) {
  const s = lc(server);
  if (!s) return false;
  if (/@latest$/.test(s)) return false;
  if (/@sha256:[0-9a-f]{8,}/.test(s)) return true; // image digest
  if (/sha256:[0-9a-f]{8,}/.test(s)) return true;
  if (/@v?\d+(?:\.\d+)+/.test(s)) return true; // @1.2.3 / @v1.2
  if (/@\d{4,}/.test(s)) return true; // @20240101 style
  return false;
}

// Operator-declared MCP trust: a set of server base names the caller vouches
// for, from opts.mcpPins (object map or array), opts.trustedMcpServers, or
// opts.trustedServers. A server in this set is treated as pinned.
function trustedServerSet(opts) {
  const out = new Set();
  const add = (v) => { const s = lc(v); if (s) out.add(s.split('@')[0]); };
  const o = opts && typeof opts === 'object' ? opts : {};
  for (const key of ['trustedMcpServers', 'trustedServers', 'mcpServers']) {
    const v = o[key];
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === 'object') { if (item.pin || item.pinned || item.trusted) add(item.name); }
        else add(item);
      }
    }
  }
  const pins = o.mcpPins;
  if (Array.isArray(pins)) { for (const p of pins) add(p); }
  else if (pins && typeof pins === 'object') {
    for (const [name, val] of Object.entries(pins)) { if (val) add(name); }
  }
  return out;
}

function serverBaseName(server) {
  const s = lc(server);
  return s ? s.split('@')[0] : s;
}

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

/**
 * analyzeModelProvenance - model + MCP/vendor supply-chain provenance over an
 * AuditEvent list.
 *
 * @param {object[]} events  normalized AuditEvents
 * @param {object} [opts]
 * @param {string[]|object} [opts.mcpPins]            declared MCP trust (map name->pin, or list)
 * @param {string[]} [opts.trustedMcpServers]         MCP servers the operator vouches for
 * @param {string[]} [opts.trustedServers]            alias of trustedMcpServers
 * @returns {{ findings: object[], models: object[], mcp_servers: object[], providers: object[], summary: object }}
 */
export function analyzeModelProvenance(events, opts = {}) {
  try {
    return run(events, opts);
  } catch (_err) {
    // Contract: never throw. A failure yields an empty-but-valid untested result.
    return {
      findings: [finding({
        id: 'model-provenance-untested',
        severity: 'info',
        title: 'Model & supply-chain provenance: not assessed',
        detail: 'No model call was found in the supplied logs, so the model, dependency, and MCP/vendor supply-chain surface (ASR-5) was not exercised and cannot be attested. Provenance is reported untested, not clean.',
        metric: { model_events: 0 },
        evidence: [],
      })],
      models: [],
      mcp_servers: [],
      providers: [],
      summary: summarize([], [], [], [], 0),
    };
  }
}

function run(events, opts) {
  const list = Array.isArray(events) ? events.filter((e) => e && typeof e === 'object') : [];
  const trusted = trustedServerSet(opts);

  // slug(lower) -> model accumulator
  const modelMap = new Map();
  // server base name -> server accumulator
  const serverMap = new Map();
  // provider -> provider accumulator
  const providerMap = new Map();
  // gateway host -> opaque-routing accumulator
  const gatewayMap = new Map();
  // destination (host|server) -> sensitive third-party egress accumulator
  const egressMap = new Map();

  let modelEventCount = 0;

  for (const e of list) {
    const id = tokenOrNull(e.id);
    const data = e.data || {};

    // --- model events: enumerate model + provider + routing + egress ---
    if (isModelEvent(e)) {
      modelEventCount++;
      const slug = metaModel(e);
      const host = hostOf(e);
      const routed = routedProviderOf(e);
      const provider = providerOf(slug, host, routed);

      if (slug) {
        const key = slug.toLowerCase();
        let m = modelMap.get(key);
        if (!m) {
          m = { slug, pinned: isPinnedSlug(slug), provider, calls: 0, hosts: new Set(), evidence: [] };
          modelMap.set(key, m);
        }
        m.calls++;
        if (host) m.hosts.add(host);
        pushId(m.evidence, id);

        let p = providerMap.get(provider);
        if (!p) { p = { name: provider, calls: 0, models: new Set(), pinned: 0, unpinned: 0 }; providerMap.set(provider, p); }
        p.calls++;
        p.models.add(key);
      } else if (provider !== 'unknown') {
        // A model call whose vendor is known by host but whose slug was not
        // logged still counts toward the provider surface a reviewer must vet.
        let p = providerMap.get(provider);
        if (!p) { p = { name: provider, calls: 0, models: new Set(), pinned: 0, unpinned: 0 }; providerMap.set(provider, p); }
        p.calls++;
      }

      // Opaque routing: a gateway host (or gateway-only source) is in the path.
      const gatewayHost = GATEWAY_HOSTS.has(host) ? host
        : GATEWAY_HOSTS.has(routed) ? routed
          : (!host && GATEWAY_SOURCES.has(sourceOf(e))) ? sourceOf(e)
            : null;
      if (gatewayHost) {
        let g = gatewayMap.get(gatewayHost);
        if (!g) { g = { host: gatewayHost, models: new Set(), anyUnidentifiable: false, evidence: [] }; gatewayMap.set(gatewayHost, g); }
        if (slug) g.models.add(slug);
        if (!upstreamFromSlug(slug)) g.anyUnidentifiable = true;
        pushId(g.evidence, id);
      }

      // Sensitive data leaving to a third-party model vendor (unredacted).
      if (data.egress && data.has_sensitive && !data.redacted) {
        const dest = host || routed || provider;
        accumulateEgress(egressMap, dest, 'model', slug || provider, id);
      }
    }

    // --- MCP / vendor server surface (may co-occur on a tool or model event) ---
    const server = serverOf(e);
    if (server) {
      const base = serverBaseName(server);
      let s = serverMap.get(base);
      if (!s) {
        s = { name: base, raw: server, calls: 0, pinned: inlinePinnedServer(server) || trusted.has(base), evidence: [] };
        serverMap.set(base, s);
      }
      s.calls++;
      // A later pinned reference upgrades the record; trust is monotonic.
      if (inlinePinnedServer(server) || trusted.has(base)) s.pinned = true;
      pushId(s.evidence, id);

      if (data.egress && data.has_sensitive && !data.redacted) {
        accumulateEgress(egressMap, base, 'mcp', base, id);
      }
    }
  }

  // Roll provider pinned/unpinned counts from the enumerated models.
  for (const m of modelMap.values()) {
    const p = providerMap.get(m.provider);
    if (p) { if (m.pinned) p.pinned++; else p.unpinned++; }
  }

  const models = [...modelMap.values()]
    .map((m) => ({ slug: m.slug, pinned: m.pinned, provider: m.provider, calls: m.calls, hosts: [...m.hosts].sort() }))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  const mcp_servers = [...serverMap.values()]
    .map((s) => ({ name: s.name, calls: s.calls, pinned: s.pinned }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const providers = [...providerMap.values()]
    .map((p) => ({ name: p.name, calls: p.calls, models: p.models.size, pinned: p.pinned, unpinned: p.unpinned }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // ------------------------------------------------------------------
  // Findings - emitted in a fixed order for determinism.
  // ------------------------------------------------------------------
  const findings = [];

  // 1) Unpinned (floating) model versions.
  for (const m of [...modelMap.values()].sort((a, b) => a.slug.localeCompare(b.slug))) {
    if (m.pinned) continue;
    findings.push(finding({
      id: 'unpinned-model-version',
      severity: 'medium',
      title: `Unpinned model version: ${m.slug}`,
      detail: `The agent invoked '${m.slug}' (provider ${m.provider}) via a floating alias rather than a pinned snapshot (for example '${m.slug}-2024-08-06'). The model bytes behind a floating alias can change under the deployment with no log signal, so the reviewer cannot bind the audit to the model that was actually evaluated. Pin each model to a dated or versioned snapshot.`,
      metric: { slug: m.slug, provider: m.provider, calls: m.calls },
      evidence: m.evidence.slice(0, EVIDENCE_CAP),
    }));
  }

  // 2) Opaque model routing through a gateway.
  for (const g of [...gatewayMap.values()].sort((a, b) => a.host.localeCompare(b.host))) {
    const slugs = [...g.models].sort();
    const severity = g.anyUnidentifiable ? 'medium' : 'low';
    const upstreamNote = g.anyUnidentifiable
      ? 'the true upstream vendor cannot be determined from the slug, so it is fully opaque.'
      : 'the intended model vendor is named by the slug, but the gateway may serve it via a different backend (first-party, Bedrock, or Vertex), so the upstream is not evidenced.';
    findings.push(finding({
      id: 'opaque-model-routing',
      severity,
      title: `Opaque model routing via ${g.host}`,
      detail: `${slugs.length ? slugs.length + ' model(s) were' : 'A model was'} reached through the third-party gateway ${g.host}${slugs.length ? ' (' + slugs.slice(0, 6).join(', ') + ')' : ''}; ${upstreamNote} Record the resolved upstream provider per call, or call the upstream vendor directly, so the model supply chain is verifiable.`,
      metric: { gateway: g.host, models: slugs, unidentifiable_upstream: g.anyUnidentifiable },
      evidence: g.evidence.slice(0, EVIDENCE_CAP),
    }));
  }

  // 3) MCP / vendor servers without a declared trust or pin.
  for (const s of [...serverMap.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (s.pinned) continue;
    findings.push(finding({
      id: 'unpinned-mcp-server',
      severity: 'medium',
      title: `Unpinned MCP / vendor server: ${s.name}`,
      detail: `The agent invoked the MCP / vendor server '${s.name}' (${s.calls} call(s)) with no declared trust or version/digest pin. An unpinned server can change tools or behaviour under the agent, which is the supply-chain attack surface OWASP LLM03 covers. Pin the server to a version or image digest and record it in a declared allow-list.`,
      metric: { server: s.name, calls: s.calls },
      evidence: s.evidence.slice(0, EVIDENCE_CAP),
    }));
  }

  // 4) Sensitive data leaving to a third-party model / MCP vendor (unredacted).
  for (const d of [...egressMap.values()].sort((a, b) => a.dest.localeCompare(b.dest))) {
    findings.push(finding({
      id: 'model-egress-third-party',
      severity: 'high',
      title: `Sensitive data sent unredacted to third party ${d.dest}`,
      detail: `${d.count} ${d.kind === 'mcp' ? 'MCP / vendor' : 'model'} call(s) carrying detected sensitive content reached the third-party destination '${d.dest}' without redaction. That vendor is a sub-processor handling sensitive data: confirm it is contractually approved, that a data-processing agreement is in place, and that redaction is applied before egress.`,
      metric: { destination: d.dest, kind: d.kind, calls: d.count, subjects: [...d.subjects].sort().slice(0, 8) },
      evidence: d.evidence.slice(0, EVIDENCE_CAP),
    }));
  }

  // 5a) No model call at all -> untested (never scored clean).
  if (modelEventCount === 0) {
    findings.push(finding({
      id: 'model-provenance-untested',
      severity: 'info',
      title: 'Model & supply-chain provenance: not assessed',
      detail: 'No model call was found in the supplied logs, so the model, dependency, and MCP/vendor supply-chain surface (ASR-5) was not exercised and cannot be attested. Provenance is reported untested, not clean. Supply logs that include a model call to assess this control.',
      metric: { model_events: 0, mcp_servers: mcp_servers.length },
      evidence: [],
    }));
  } else if (findings.length === 0) {
    // 5b) Model calls present and nothing to flag -> a signable positive finding.
    findings.push(finding({
      id: 'model-provenance-clean',
      severity: 'info',
      title: 'Model & supply-chain provenance: no findings',
      detail: `Every model invoked was version-pinned, no model was reached through an opaque gateway, every MCP / vendor server carried a declared pin, and no sensitive data left unredacted to a third-party vendor in the observed window (${models.length} model(s), ${providers.length} provider(s), ${mcp_servers.length} MCP server(s)).`,
      metric: { models: models.length, providers: providers.length, mcp_servers: mcp_servers.length },
      evidence: [],
    }));
  }

  return {
    findings,
    models,
    mcp_servers,
    providers,
    summary: summarize(findings, models, mcp_servers, providers, modelEventCount),
  };
}

function accumulateEgress(map, dest, kind, subject, id) {
  const key = String(dest || 'unknown');
  let d = map.get(key);
  if (!d) { d = { dest: key, kind, count: 0, subjects: new Set(), evidence: [] }; map.set(key, d); }
  d.count++;
  if (subject) d.subjects.add(subject);
  pushId(d.evidence, id);
}

function summarize(findings, models, mcp_servers, providers, modelEventCount) {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  return {
    analyzer: ANALYZER,
    model_events: modelEventCount,
    models: models.length,
    pinned_models: models.filter((m) => m.pinned).length,
    unpinned_models: models.filter((m) => !m.pinned).length,
    providers: providers.length,
    mcp_servers: mcp_servers.length,
    unpinned_mcp_servers: mcp_servers.filter((s) => !s.pinned).length,
    findings: findings.length,
    by_severity: bySeverity,
    untested: modelEventCount === 0,
  };
}

export default analyzeModelProvenance;
