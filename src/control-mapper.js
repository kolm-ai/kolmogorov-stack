// Agent Security-Review audit - control mapper.
//
// Translates analyzer Findings (from src/permission-analyzer.js and
// src/audit-trail-analyzer.js) into the frameworks an enterprise buyer's
// review group already cites. Every id here is kept identical to what the
// live site publishes on /checks and /research, so a finding in the signed
// report cross-references the same control the buyer reads on the site:
//
//   - ASR - kolm's CC0 Agent Security Readiness checklist
//                        (/research): ASR-1 … ASR-6
//   - OWASP - OWASP LLM & Agentic Top 10 (LLM0x, ASI)
//   - MITRE ATLAS - AML.Txxxx techniques
//   - NIST AI RMF - GOVERN / MAP / MEASURE / MANAGE subcategories
//   - EU AI Act - Art.10 / Art.12 / Art.14
//   - SOC 2 TSC - CC6 (access) / CC7 (monitoring)
//   - ISO/IEC 42001 - Annex A control families
//
// A control's `label` is kolm's statement of why the finding maps to that
// control; the `id` is the authoritative cross-reference. Mapping is
// finding-id first, with a pillar fallback so a new finding still lands in
// the right frameworks. Never throws.

const FW = {
  ASR: 'ASR',
  OWASP: 'OWASP LLM & Agentic Top 10',
  ATLAS: 'MITRE ATLAS',
  NIST: 'NIST AI RMF',
  EU: 'EU AI Act',
  SOC2: 'SOC 2 TSC',
  ISO: 'ISO/IEC 42001',
};

// kolm's published ASR checklist (research.html), the spine of the report.
export const ASR_CONTROLS = Object.freeze([
  { id: 'ASR-1', name: 'Least privilege', requires: 'Scopes held match scopes used; no shared keys across isolation boundaries.' },
  { id: 'ASR-2', name: 'Audit trail', requires: 'Append-only, tamper-evident activity log with a stated retention policy.' },
  { id: 'ASR-3', name: 'Data egress', requires: 'Egress destinations enumerated; sensitive fields redacted before they leave.' },
  { id: 'ASR-4', name: 'Injection', requires: 'Direct/indirect injection and jailbreaks tested and reported with reproductions.' },
  { id: 'ASR-5', name: 'Provenance', requires: 'Model and dependency provenance; MCP/vendor surface enumerated.' },
  { id: 'ASR-6', name: 'Evidence', requires: 'Findings signed, logged, and offline-verifiable.' },
  { id: 'ASR-7', name: 'Memory and retrieval integrity', requires: 'Retrieval sources enumerated and trusted; memory writes carry an integrity link and a recorded author.' },
  { id: 'ASR-8', name: 'Multi-agent delegation', requires: "Each handoff is attributable and attenuates the sub-agent to a subset of the delegating agent's authority." },
]);

function c(framework, id, label) {
  return { framework, id, label };
}

// Reusable control singletons (ids mirror /checks and /research verbatim).
const C = {
  // OWASP - labels follow the site's usage of each id, not a single OWASP year.
  llm01: c(FW.OWASP, 'LLM01', 'Prompt injection'),
  llm02: c(FW.OWASP, 'LLM02', 'Sensitive information disclosure'),
  llm03: c(FW.OWASP, 'LLM03', 'Supply chain - MCP / vendor surface'),
  llm04: c(FW.OWASP, 'LLM04', 'Data & model poisoning (retrieval / memory integrity)'),
  llm05: c(FW.OWASP, 'LLM05', 'Supply chain - model & dependency provenance'),
  llm06: c(FW.OWASP, 'LLM06', 'Sensitive disclosure / shared credential'),
  llm07: c(FW.OWASP, 'LLM07', 'System-prompt leakage'),
  llm08: c(FW.OWASP, 'LLM08', 'Excessive agency'),
  asi: c(FW.OWASP, 'ASI', 'Agentic Security Initiative · agent threats'),
  // MITRE ATLAS
  atlas_inj: c(FW.ATLAS, 'AML.T0051', 'LLM prompt injection'),
  atlas_inj_ind: c(FW.ATLAS, 'AML.T0051.001', 'Indirect prompt injection'),
  atlas_metaprompt: c(FW.ATLAS, 'AML.T0056', 'System-prompt / meta-prompt extraction'),
  atlas_leak: c(FW.ATLAS, 'AML.T0057', 'Sensitive-data leakage'),
  atlas_accounts: c(FW.ATLAS, 'AML.T0012', 'Valid accounts / credential reuse'),
  atlas_supply: c(FW.ATLAS, 'AML.T0010', 'ML supply-chain compromise'),
  atlas_rag: c(FW.ATLAS, 'AML.T0070', 'RAG poisoning'),
  // NIST AI RMF (tokens mirror the site)
  nist_govern3: c(FW.NIST, 'GOVERN-3', 'Roles, responsibilities & accountability'),
  nist_map2: c(FW.NIST, 'MAP-2', 'Tool-call authorization & system boundaries'),
  nist_map4: c(FW.NIST, 'MAP-4', 'Third-party / dependency provenance'),
  nist_measure2: c(FW.NIST, 'MEASURE-2', 'Egress & data-flow measurement'),
  nist_manage1: c(FW.NIST, 'MANAGE-1', 'Least-privilege risk treatment'),
  nist_manage4: c(FW.NIST, 'MANAGE-4', 'Logging, monitoring & documentation'),
  // EU AI Act
  eu_art10: c(FW.EU, 'Art.10', 'Data & data governance'),
  eu_art12: c(FW.EU, 'Art.12', 'Record-keeping / automatic logging'),
  eu_art14: c(FW.EU, 'Art.14', 'Human oversight'),
  // SOC 2 TSC
  soc2_cc6: c(FW.SOC2, 'CC6', 'Logical access controls / least privilege'),
  soc2_cc7: c(FW.SOC2, 'CC7', 'System operations & monitoring'),
  // ISO/IEC 42001 Annex A families
  iso_a6: c(FW.ISO, 'A.6', 'AI system lifecycle'),
  iso_a7: c(FW.ISO, 'A.7', 'Data for AI systems'),
  iso_a9: c(FW.ISO, 'A.9', 'Use & operation of AI systems'),
  iso_a10: c(FW.ISO, 'A.10', 'Third-party & customer relationships'),
};

// finding-id → { asr, controls }
const CONTROL_MAP = {
  // --- permission analyzer ---
  'wildcard-grant': { asr: 'ASR-1', controls: [C.asi, C.llm08, C.nist_manage1, C.nist_map2, C.eu_art14, C.soc2_cc6, C.iso_a9] },
  'over-permission': { asr: 'ASR-1', controls: [C.asi, C.nist_manage1, C.soc2_cc6, C.iso_a9] },
  'no-declared-grants': { asr: 'ASR-1', controls: [C.asi, C.nist_manage1, C.soc2_cc6, C.iso_a9] },
  'undeclared-tool-call': { asr: 'ASR-1', controls: [C.llm08, C.asi, C.nist_map2, C.soc2_cc6, C.iso_a9] },
  'high-privilege-action': { asr: 'ASR-1', controls: [C.llm08, C.asi, C.nist_map2, C.eu_art14, C.iso_a9] },
  'sensitive-egress': { asr: 'ASR-3', controls: [C.llm02, C.nist_measure2, C.eu_art10, C.soc2_cc6, C.iso_a7] },
  'shared-credential': { asr: 'ASR-1', controls: [C.llm06, C.atlas_accounts, C.nist_manage1, C.soc2_cc6, C.iso_a9] },
  'least-privilege-clean': { asr: 'ASR-1', controls: [C.asi, C.nist_manage1, C.soc2_cc6] },

  // --- audit-trail analyzer ---
  'no-tamper-evidence': { asr: 'ASR-2', controls: [C.eu_art12, C.soc2_cc7, C.nist_manage4, C.iso_a6] },
  'broken-hash-chain': { asr: 'ASR-2', controls: [C.eu_art12, C.soc2_cc7, C.nist_manage4, C.iso_a6] },
  'partial-tamper-evidence': { asr: 'ASR-2', controls: [C.eu_art12, C.soc2_cc7, C.nist_manage4] },
  'incomplete-timestamps': { asr: 'ASR-2', controls: [C.eu_art12, C.nist_manage4, C.soc2_cc7] },
  'unattributed-events': { asr: 'ASR-2', controls: [C.eu_art12, C.soc2_cc7, C.nist_manage4, C.nist_govern3] },
  'missing-action-detail': { asr: 'ASR-2', controls: [C.eu_art12, C.nist_manage4] },
  'duplicate-event-ids': { asr: 'ASR-2', controls: [C.eu_art12, C.soc2_cc7] },
  'retention-unverifiable': { asr: 'ASR-2', controls: [C.eu_art12, C.nist_manage4] },
  'short-retention-window': { asr: 'ASR-2', controls: [C.eu_art12, C.nist_manage4] },
  'audit-trail-complete': { asr: 'ASR-2', controls: [C.eu_art12, C.soc2_cc7, C.nist_manage4] },

  // --- model-provenance analyzer (ASR-5, supply-chain) ---
  // model -> ASR-5: OWASP LLM05/LLM03 supply chain, MITRE ATLAS AML.T0010,
  // NIST MAP-4 (third-party provenance), ISO A.6 lifecycle / A.10 third-party.
  'unpinned-model-version': { asr: 'ASR-5', controls: [C.llm05, C.llm03, C.atlas_supply, C.nist_map4, C.iso_a6, C.iso_a10] },
  'opaque-model-routing': { asr: 'ASR-5', controls: [C.llm05, C.llm03, C.atlas_supply, C.nist_map4, C.iso_a10] },
  'unpinned-mcp-server': { asr: 'ASR-5', controls: [C.llm03, C.atlas_supply, C.nist_map4, C.iso_a10] },
  'model-egress-third-party': { asr: 'ASR-5', controls: [C.llm02, C.llm05, C.nist_measure2, C.eu_art10, C.soc2_cc6, C.iso_a10] },
  // The untested / clean sentinels route to ASR-5 but carry no framework
  // controls (an untested or clean dimension implicates no specific control);
  // model-provenance-clean falls through to the supply-chain PILLAR_MAP below.
  'model-provenance-untested': { asr: 'ASR-5', controls: [] },

  // --- agent-identity analyzer (ASR-1, identity / least privilege) ---
  // identity attribution -> ASR-1: NIST GOVERN-3 (roles & accountability),
  // MITRE ATLAS AML.T0012 (credential reuse), OWASP ASI, SOC 2 CC6, ISO A.9.
  'unattributed-agent-action': { asr: 'ASR-1', controls: [C.nist_govern3, C.atlas_accounts, C.asi, C.eu_art12, C.soc2_cc6, C.iso_a9] },
  'ambiguous-agent-identity': { asr: 'ASR-1', controls: [C.nist_govern3, C.atlas_accounts, C.asi, C.soc2_cc6, C.iso_a9] },
  'unverifiable-agent-scope': { asr: 'ASR-1', controls: [C.asi, C.nist_manage1, C.soc2_cc6, C.iso_a9] },
  'agent-identity-attested': { asr: 'ASR-1', controls: [C.asi, C.soc2_cc6] },

  // --- rag-memory analyzer (ASR-7, memory & retrieval integrity) ---
  // retrieval -> ASR-7: OWASP LLM01 (indirect injection) + LLM04 (poisoning),
  // MITRE ATLAS AML.T0051.001 (indirect injection) + AML.T0070 (RAG poisoning),
  // NIST MEASURE-2 (data-flow measurement), EU Art.10 / ISO A.7 (data governance).
  'untrusted-retrieval-source': { asr: 'ASR-7', controls: [C.llm01, C.atlas_inj_ind, C.atlas_rag, C.nist_measure2, C.eu_art10, C.iso_a7] },
  'unverified-memory-write': { asr: 'ASR-7', controls: [C.llm04, C.atlas_rag, C.nist_manage4, C.soc2_cc7, C.iso_a7] },
  'retrieval-sources-enumerated': { asr: 'ASR-7', controls: [C.nist_measure2, C.iso_a7] },
  'rag-memory-untested': { asr: 'ASR-7', controls: [] },

  // --- delegation analyzer (ASR-8, multi-agent delegation) ---
  // delegation -> ASR-8: OWASP LLM08 (excessive agency) + ASI, MITRE ATLAS
  // AML.T0012 (credential reuse), NIST MAP-2 (tool-call authorization) /
  // MANAGE-1 (least-privilege treatment), SOC 2 CC6/CC7, ISO A.9.
  'delegation-privilege-escalation': { asr: 'ASR-8', controls: [C.llm08, C.asi, C.atlas_accounts, C.nist_map2, C.nist_manage1, C.soc2_cc6, C.iso_a9] },
  'unattenuated-delegation': { asr: 'ASR-8', controls: [C.llm08, C.asi, C.nist_manage1, C.soc2_cc6, C.iso_a9] },
  'opaque-delegation-hop': { asr: 'ASR-8', controls: [C.asi, C.nist_govern3, C.nist_manage4, C.soc2_cc7, C.iso_a9] },
  'delegation-attenuated': { asr: 'ASR-8', controls: [C.asi, C.nist_manage1] },
  'delegation-untested': { asr: 'ASR-8', controls: [] },
};

// pillar → fallback mapping when a finding id is not in CONTROL_MAP.
const PILLAR_MAP = {
  permission: { asr: 'ASR-1', controls: [C.asi, C.nist_manage1, C.soc2_cc6] },
  'tool-abuse': { asr: 'ASR-1', controls: [C.llm08, C.asi, C.nist_map2] },
  'data-egress': { asr: 'ASR-3', controls: [C.llm02, C.nist_measure2, C.eu_art10, C.iso_a7] },
  'audit-trail': { asr: 'ASR-2', controls: [C.eu_art12, C.soc2_cc7, C.nist_manage4] },
  'supply-chain': { asr: 'ASR-5', controls: [C.llm05, C.llm03, C.atlas_supply, C.nist_map4, C.iso_a10] },
  injection: { asr: 'ASR-4', controls: [C.llm01, C.atlas_inj] },
  // Wave-2 analyzers: identity -> ASR-1, retrieval/memory -> ASR-7, delegation -> ASR-8.
  'agent-identity': { asr: 'ASR-1', controls: [C.asi, C.nist_govern3, C.nist_manage1, C.soc2_cc6] },
  'rag-memory': { asr: 'ASR-7', controls: [C.llm04, C.atlas_rag, C.nist_measure2, C.iso_a7] },
  delegation: { asr: 'ASR-8', controls: [C.llm08, C.asi, C.nist_map2, C.nist_manage1] },
};

function asrFor(id) {
  return ASR_CONTROLS.find((a) => a.id === id) || null;
}

/**
 * mapFinding - attach ASR + framework controls to a single Finding.
 * @returns {object} the finding augmented with { asr, controls }
 */
export function mapFinding(finding) {
  if (!finding || typeof finding !== 'object') {
    return { ...(finding || {}), asr: null, controls: [] };
  }
  const byId = CONTROL_MAP[finding.id];
  const byPillar = PILLAR_MAP[finding.pillar];
  const chosen = byId || byPillar || { asr: null, controls: [] };
  const asr = asrFor(chosen.asr);
  return {
    ...finding,
    asr: asr ? { id: asr.id, name: asr.name } : null,
    controls: (chosen.controls || []).map((ctrl) => ({ ...ctrl })),
  };
}

/**
 * mapControls - map a list of Findings and roll up per-framework coverage.
 *
 * @param {object[]} findings  findings from any analyzer(s)
 * @returns {{ findings: object[], frameworks: object[], asr: object[], summary: object }}
 */
export function mapControls(findings) {
  const list = Array.isArray(findings) ? findings.filter((f) => f && typeof f === 'object') : [];
  const mapped = list.map(mapFinding);

  // Per-framework rollup: which control ids were implicated, and by how many
  // findings, weighted to the worst severity touching each control.
  const fwMap = new Map(); // framework -> Map(id -> { label, findings, max_severity })
  const asrMap = new Map(); // asr id -> { name, findings, by_severity }
  const SEV_ORDER = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

  for (const m of mapped) {
    const sev = m.severity || 'info';
    if (m.asr) {
      let a = asrMap.get(m.asr.id);
      if (!a) { a = { id: m.asr.id, name: m.asr.name, findings: 0, by_severity: {} }; asrMap.set(m.asr.id, a); }
      a.findings++;
      a.by_severity[sev] = (a.by_severity[sev] || 0) + 1;
    }
    for (const ctrl of m.controls) {
      let f = fwMap.get(ctrl.framework);
      if (!f) { f = new Map(); fwMap.set(ctrl.framework, f); }
      let entry = f.get(ctrl.id);
      if (!entry) { entry = { id: ctrl.id, label: ctrl.label, findings: 0, max_severity: 'info' }; f.set(ctrl.id, entry); }
      entry.findings++;
      if (SEV_ORDER[sev] > SEV_ORDER[entry.max_severity]) entry.max_severity = sev;
    }
  }

  const frameworks = [];
  for (const [framework, ctrlMap] of fwMap) {
    const controls = [...ctrlMap.values()].sort((a, b) => a.id.localeCompare(b.id));
    frameworks.push({
      framework,
      controls,
      controls_touched: controls.length,
      findings: controls.reduce((s, c2) => s + c2.findings, 0),
      worst_severity: controls.reduce((w, c2) => (SEV_ORDER[c2.max_severity] > SEV_ORDER[w] ? c2.max_severity : w), 'info'),
    });
  }
  frameworks.sort((a, b) => a.framework.localeCompare(b.framework));

  const asr = ASR_CONTROLS.map((a) => {
    const hit = asrMap.get(a.id);
    return {
      id: a.id,
      name: a.name,
      requires: a.requires,
      findings: hit ? hit.findings : 0,
      by_severity: hit ? hit.by_severity : {},
    };
  });

  return {
    findings: mapped,
    frameworks,
    asr,
    summary: {
      findings: mapped.length,
      frameworks_touched: frameworks.length,
      controls_touched: frameworks.reduce((s, f) => s + f.controls_touched, 0),
      asr_controls_with_findings: asr.filter((a) => a.findings > 0).length,
    },
  };
}
