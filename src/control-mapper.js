// Agent Security-Review audit - control mapper.
//
// Translates analyzer Findings (from src/permission-analyzer.js and
// src/audit-trail-analyzer.js) into the frameworks an enterprise buyer's
// review group already cites. Every id here is kept identical to what the
// live site publishes on /checks and /research, so a finding in the signed
// report cross-references the same control the buyer reads on the site:
//
//   - ASR - kolm's CC0 Agent Security Readiness checklist
//                        (/research): ASR-1 ... ASR-8
//   - OWASP - OWASP LLM & Agentic Top 10 (LLM0x + named ASI01-ASI10 from
//                        the Agentic Security Initiative Top 10)
//   - MITRE ATLAS - AML.Txxxx techniques
//   - NIST AI RMF - GOVERN / MAP / MEASURE / MANAGE subcategories
//   - EU AI Act - Art.9 / Art.10 / Art.11 / Art.12 / Art.14 / Art.15
//   - SOC 2 TSC - CC6 (access) / CC7 (monitoring)
//   - ISO/IEC 42001 - Annex A control families
//   - ISO/IEC 27001:2022 - Annex A controls (access, logging, monitoring,
//                        cloud/AI service use)
//   - HIPAA Security Rule (mapping) - 164.312 technical safeguards
//   - NIST SP 800-53 - AC / AU / SC / SR control families
//   - CSA AICM - CSA AI Controls Matrix v1 (243 control objectives
//                        across 18 domains; ids like IAM-05 / LOG-02 / MDS-06)
//   - NIST COSAiS - SP 800-53 Control Overlays for Securing AI Systems;
//                        the overlays are still in development with no final
//                        control ids published, so each row cites the overlay
//                        use case by name and is marked a draft mapping
//
// Every framework here is a MAPPING the buyer's review group can cite, not a
// certification: a finding cross-references the control, it does not assert the
// subject is compliant with or certified against that framework.
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
  ISO27001: 'ISO/IEC 27001:2022',
  HIPAA: 'HIPAA Security Rule (mapping)',
  NIST80053: 'NIST SP 800-53',
  AICM: 'CSA AICM',
  COSAIS: 'NIST COSAiS',
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
  // OWASP LLM Top 10 (2025 numbering) + Agentic Security Initiative.
  llm01: c(FW.OWASP, 'LLM01', 'Prompt injection'),
  llm02: c(FW.OWASP, 'LLM02', 'Sensitive information disclosure'),
  llm03: c(FW.OWASP, 'LLM03', 'Supply chain - model, MCP and dependency provenance'),
  llm04: c(FW.OWASP, 'LLM04', 'Data & model poisoning (retrieval / memory integrity)'),
  llm06: c(FW.OWASP, 'LLM06', 'Excessive agency'),
  llm07: c(FW.OWASP, 'LLM07', 'System-prompt leakage'),
  llm08: c(FW.OWASP, 'LLM08', 'Vector and embedding weaknesses'),
  // OWASP Agentic Security Initiative - Top 10 for Agentic Applications
  // (named ASI01-ASI10). Each ASR control maps to the specific ASI threats it
  // evidences; never a blanket "ASI" reference.
  asi01: c(FW.OWASP, 'ASI01', 'Agent goal hijack'),
  asi02: c(FW.OWASP, 'ASI02', 'Tool misuse'),
  asi03: c(FW.OWASP, 'ASI03', 'Identity & privilege abuse'),
  asi04: c(FW.OWASP, 'ASI04', 'Agentic supply chain vulnerabilities'),
  asi05: c(FW.OWASP, 'ASI05', 'Unexpected code execution'),
  asi06: c(FW.OWASP, 'ASI06', 'Memory & context poisoning'),
  asi07: c(FW.OWASP, 'ASI07', 'Insecure inter-agent communication'),
  asi08: c(FW.OWASP, 'ASI08', 'Cascading failures'),
  asi09: c(FW.OWASP, 'ASI09', 'Human-agent trust exploitation'),
  asi10: c(FW.OWASP, 'ASI10', 'Rogue agents'),
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
  nist_measure2_7: c(FW.NIST, 'MEASURE-2.7', 'AI system security & resilience evaluation (adversarial testing)'),
  nist_manage1: c(FW.NIST, 'MANAGE-1', 'Least-privilege risk treatment'),
  nist_manage4: c(FW.NIST, 'MANAGE-4', 'Logging, monitoring & documentation'),
  // EU AI Act
  eu_art9: c(FW.EU, 'Art.9', 'Risk-management system'),
  eu_art10: c(FW.EU, 'Art.10', 'Data & data governance'),
  eu_art11: c(FW.EU, 'Art.11', 'Technical documentation'),
  eu_art12: c(FW.EU, 'Art.12', 'Record-keeping / automatic logging'),
  eu_art14: c(FW.EU, 'Art.14', 'Human oversight'),
  eu_art15: c(FW.EU, 'Art.15', 'Accuracy, robustness & cybersecurity'),
  // SOC 2 TSC
  soc2_cc6: c(FW.SOC2, 'CC6', 'Logical access controls / least privilege'),
  soc2_cc7: c(FW.SOC2, 'CC7', 'System operations & monitoring'),
  // ISO/IEC 42001 Annex A families
  iso_a6: c(FW.ISO, 'A.6', 'AI system lifecycle'),
  iso_a7: c(FW.ISO, 'A.7', 'Data for AI systems'),
  iso_a9: c(FW.ISO, 'A.9', 'Use & operation of AI systems'),
  iso_a10: c(FW.ISO, 'A.10', 'Third-party & customer relationships'),
  // ISO/IEC 27001:2022 Annex A controls (information-security management).
  iso27001_a8_2: c(FW.ISO27001, 'A.8.2', 'Privileged access rights'),
  iso27001_a8_15: c(FW.ISO27001, 'A.8.15', 'Logging'),
  iso27001_a8_16: c(FW.ISO27001, 'A.8.16', 'Monitoring activities'),
  iso27001_a8_30: c(FW.ISO27001, 'A.8.30', 'Outsourced development'),
  iso27001_a5_23: c(FW.ISO27001, 'A.5.23', 'Information security for use of cloud/AI services'),
  // HIPAA Security Rule technical safeguards (mapping, not certification).
  hipaa_access: c(FW.HIPAA, '164.312(a)(1)', 'Access control'),
  hipaa_audit: c(FW.HIPAA, '164.312(b)', 'Audit controls'),
  hipaa_transmission: c(FW.HIPAA, '164.312(e)(1)', 'Transmission security'),
  // NIST SP 800-53 (agent-relevant subset).
  nist80053_ac6: c(FW.NIST80053, 'AC-6', 'Least privilege'),
  nist80053_au2: c(FW.NIST80053, 'AU-2', 'Event logging'),
  nist80053_au10: c(FW.NIST80053, 'AU-10', 'Non-repudiation (signed, verifiable evidence)'),
  nist80053_sc7: c(FW.NIST80053, 'SC-7', 'Boundary protection'),
  nist80053_sc8: c(FW.NIST80053, 'SC-8', 'Transmission confidentiality & integrity'),
  nist80053_sr3: c(FW.NIST80053, 'SR-3', 'Supply chain controls & processes'),
  // CSA AI Controls Matrix v1 (AICM): 243 control objectives across 18
  // domains. Ids are the published domain-control tokens (always space-free).
  aicm_iam05: c(FW.AICM, 'IAM-05', 'Least privilege'),
  aicm_iam16: c(FW.AICM, 'IAM-16', 'Authorization mechanisms'),
  aicm_log02: c(FW.AICM, 'LOG-02', 'Audit logs protection'),
  aicm_dsp05: c(FW.AICM, 'DSP-05', 'Data flow documentation'),
  aicm_ais14: c(FW.AICM, 'AIS-14', 'AI cache protection (memory integrity)'),
  aicm_ais15: c(FW.AICM, 'AIS-15', 'Prompt differentiation'),
  aicm_mds06: c(FW.AICM, 'MDS-06', 'Adversarial attack analysis'),
  aicm_sta09: c(FW.AICM, 'STA-09', 'Supply chain risk management'),
  aicm_aa02: c(FW.AICM, 'A&A-02', 'Independent assessments'),
  // NIST COSAiS (SP 800-53 Control Overlays for Securing AI Systems). The
  // overlays are in development and publish no final control ids yet, so the
  // id is the overlay use case and every label is marked a draft mapping.
  cosais_genai: c(FW.COSAIS, 'GenAI-Overlay', 'Securing generative AI systems (draft mapping)'),
  cosais_single_agent: c(FW.COSAIS, 'Single-Agent-Overlay', 'Securing single-agent AI systems (draft mapping)'),
  cosais_multi_agent: c(FW.COSAIS, 'Multi-Agent-Overlay', 'Securing multi-agent AI systems (draft mapping)'),
};

// finding-id -> { asr, controls }
const CONTROL_MAP = {
  // --- permission analyzer ---
  // ASR-1 least privilege: OWASP ASI03 (identity & privilege abuse) is the
  // scoping threat; ASI02 (tool misuse) joins where a tool is actually driven
  // past its grant. Also maps to ISO/IEC 27001:2022 A.8.2 (privileged access),
  // HIPAA 164.312(a)(1) (access control), NIST SP 800-53 AC-6 and CSA AICM
  // IAM-05 (least privilege); runtime-authority findings carry the COSAiS
  // single-agent overlay (draft mapping).
  'wildcard-grant': { asr: 'ASR-1', controls: [C.asi02, C.asi03, C.llm06, C.nist_manage1, C.nist_map2, C.eu_art14, C.soc2_cc6, C.iso_a9, C.iso27001_a8_2, C.hipaa_access, C.nist80053_ac6, C.aicm_iam05, C.cosais_single_agent] },
  'over-permission': { asr: 'ASR-1', controls: [C.asi03, C.nist_manage1, C.soc2_cc6, C.iso_a9, C.iso27001_a8_2, C.hipaa_access, C.nist80053_ac6, C.aicm_iam05] },
  'no-declared-grants': { asr: 'ASR-1', controls: [C.asi03, C.nist_manage1, C.soc2_cc6, C.iso_a9, C.iso27001_a8_2, C.hipaa_access, C.nist80053_ac6, C.aicm_iam05] },
  'undeclared-tool-call': { asr: 'ASR-1', controls: [C.llm06, C.asi02, C.nist_map2, C.soc2_cc6, C.iso_a9, C.iso27001_a8_2, C.hipaa_access, C.nist80053_ac6, C.aicm_iam05, C.cosais_single_agent] },
  'high-privilege-action': { asr: 'ASR-1', controls: [C.llm06, C.asi02, C.nist_map2, C.eu_art14, C.iso_a9, C.iso27001_a8_2, C.hipaa_access, C.nist80053_ac6, C.aicm_iam05, C.cosais_single_agent] },
  // ASR-3 egress also maps to ISO/IEC 27001:2022 A.8.16 (monitoring), HIPAA
  // 164.312(e)(1) (transmission security), NIST SP 800-53 SC-7 / SC-8 and
  // CSA AICM DSP-05 (data flow documentation: egress destinations enumerated).
  'sensitive-egress': { asr: 'ASR-3', controls: [C.llm02, C.nist_measure2, C.eu_art10, C.soc2_cc6, C.iso_a7, C.iso27001_a8_16, C.hipaa_transmission, C.nist80053_sc7, C.nist80053_sc8, C.aicm_dsp05] },

  // --- egress analyzer (ASR-3, data egress) ---
  // Explicit rows (not pillar-fallback dependent): destinations enumerated and
  // vetted maps to NIST SP 800-53 SC-7 (boundary protection) + SC-8
  // (transmission), OWASP LLM02 (sensitive information disclosure), CSA AICM
  // DSP-05 (data flow documentation), ISO 27001 A.8.16 (monitoring), HIPAA
  // 164.312(e)(1) (transmission security). The untested sentinel routes to
  // ASR-3 with no framework controls, mirroring delegation-untested.
  'unapproved-egress-destination': { asr: 'ASR-3', controls: [C.llm02, C.nist_measure2, C.eu_art10, C.iso_a7, C.iso27001_a8_16, C.hipaa_transmission, C.nist80053_sc7, C.nist80053_sc8, C.aicm_dsp05] },
  'secret-egress': { asr: 'ASR-3', controls: [C.llm02, C.atlas_leak, C.nist_measure2, C.eu_art10, C.iso_a7, C.iso27001_a8_16, C.hipaa_transmission, C.nist80053_sc7, C.nist80053_sc8, C.aicm_dsp05] },
  'undeclared-egress-surface': { asr: 'ASR-3', controls: [C.llm02, C.nist_measure2, C.eu_art10, C.iso27001_a8_16, C.hipaa_transmission, C.nist80053_sc7, C.aicm_dsp05] },
  'egress-allowlisted-clean': { asr: 'ASR-3', controls: [C.nist_measure2, C.nist80053_sc7, C.aicm_dsp05] },
  'egress-untested': { asr: 'ASR-3', controls: [] },
  'shared-credential': { asr: 'ASR-1', controls: [C.llm02, C.asi03, C.atlas_accounts, C.nist_manage1, C.soc2_cc6, C.iso_a9, C.iso27001_a8_2, C.hipaa_access, C.nist80053_ac6, C.aicm_iam05] },
  'least-privilege-clean': { asr: 'ASR-1', controls: [C.asi03, C.nist_manage1, C.soc2_cc6, C.iso27001_a8_2, C.hipaa_access, C.nist80053_ac6, C.aicm_iam05] },

  // --- audit-trail analyzer ---
  // ASR-2 audit trail also maps to ISO/IEC 27001:2022 A.8.15 (logging) +
  // A.8.16 (monitoring), HIPAA 164.312(b) (audit controls), NIST SP 800-53
  // AU-2 (event logging) and CSA AICM LOG-02 (audit logs protection).
  'no-tamper-evidence': { asr: 'ASR-2', controls: [C.eu_art12, C.soc2_cc7, C.nist_manage4, C.iso_a6, C.iso27001_a8_15, C.iso27001_a8_16, C.hipaa_audit, C.nist80053_au2, C.aicm_log02] },
  'broken-hash-chain': { asr: 'ASR-2', controls: [C.eu_art12, C.soc2_cc7, C.nist_manage4, C.iso_a6, C.iso27001_a8_15, C.iso27001_a8_16, C.hipaa_audit, C.nist80053_au2, C.aicm_log02] },
  'partial-tamper-evidence': { asr: 'ASR-2', controls: [C.eu_art12, C.soc2_cc7, C.nist_manage4, C.iso27001_a8_15, C.hipaa_audit, C.nist80053_au2, C.aicm_log02] },
  'incomplete-timestamps': { asr: 'ASR-2', controls: [C.eu_art12, C.nist_manage4, C.soc2_cc7, C.iso27001_a8_15, C.hipaa_audit, C.nist80053_au2, C.aicm_log02] },
  'unattributed-events': { asr: 'ASR-2', controls: [C.eu_art12, C.soc2_cc7, C.nist_manage4, C.nist_govern3, C.iso27001_a8_15, C.hipaa_audit, C.nist80053_au2, C.aicm_log02] },
  'missing-action-detail': { asr: 'ASR-2', controls: [C.eu_art12, C.nist_manage4, C.iso27001_a8_15, C.hipaa_audit, C.nist80053_au2, C.aicm_log02] },
  'duplicate-event-ids': { asr: 'ASR-2', controls: [C.eu_art12, C.soc2_cc7, C.iso27001_a8_15, C.hipaa_audit, C.nist80053_au2, C.aicm_log02] },
  'retention-unverifiable': { asr: 'ASR-2', controls: [C.eu_art12, C.nist_manage4, C.iso27001_a8_15, C.hipaa_audit, C.nist80053_au2, C.aicm_log02] },
  'short-retention-window': { asr: 'ASR-2', controls: [C.eu_art12, C.nist_manage4, C.iso27001_a8_15, C.hipaa_audit, C.nist80053_au2, C.aicm_log02] },
  'audit-trail-complete': { asr: 'ASR-2', controls: [C.eu_art12, C.soc2_cc7, C.nist_manage4, C.iso27001_a8_15, C.hipaa_audit, C.nist80053_au2, C.aicm_log02] },

  // --- model-provenance analyzer (ASR-5, supply-chain) ---
  // model -> ASR-5: OWASP LLM03 supply chain + ASI04 (agentic supply chain
  // vulnerabilities), MITRE ATLAS AML.T0010, NIST MAP-4 (third-party
  // provenance), ISO A.6 lifecycle / A.10 third-party. Also: ISO/IEC
  // 27001:2022 A.5.23 (cloud/AI service use) + A.8.30 (outsourced
  // development), EU AI Act Art.11 (technical documentation, shared by ASR-6
  // evidence), NIST SP 800-53 SR-3 (supply-chain controls) and CSA AICM
  // STA-09 (supply chain risk management).
  'unpinned-model-version': { asr: 'ASR-5', controls: [C.llm03, C.asi04, C.atlas_supply, C.nist_map4, C.iso_a6, C.iso_a10, C.iso27001_a5_23, C.iso27001_a8_30, C.eu_art11, C.nist80053_sr3, C.aicm_sta09] },
  'opaque-model-routing': { asr: 'ASR-5', controls: [C.llm03, C.asi04, C.atlas_supply, C.nist_map4, C.iso_a10, C.iso27001_a5_23, C.iso27001_a8_30, C.eu_art11, C.nist80053_sr3, C.aicm_sta09] },
  'unpinned-mcp-server': { asr: 'ASR-5', controls: [C.llm03, C.asi04, C.atlas_supply, C.nist_map4, C.iso_a10, C.iso27001_a5_23, C.iso27001_a8_30, C.eu_art11, C.nist80053_sr3, C.aicm_sta09] },
  'model-egress-third-party': { asr: 'ASR-5', controls: [C.llm02, C.llm03, C.asi04, C.nist_measure2, C.eu_art10, C.soc2_cc6, C.iso_a10, C.iso27001_a5_23, C.eu_art11, C.nist80053_sr3, C.hipaa_transmission, C.nist80053_sc8, C.aicm_sta09] },
  // The untested / clean sentinels route to ASR-5 but carry no framework
  // controls (an untested or clean dimension implicates no specific control);
  // model-provenance-clean falls through to the supply-chain PILLAR_MAP below.
  'model-provenance-untested': { asr: 'ASR-5', controls: [] },

  // --- agent-identity analyzer (ASR-1, identity / least privilege) ---
  // identity attribution -> ASR-1: NIST GOVERN-3 (roles & accountability),
  // MITRE ATLAS AML.T0012 (credential reuse), OWASP ASI03 (identity &
  // privilege abuse), SOC 2 CC6, ISO A.9.
  'unattributed-agent-action': { asr: 'ASR-1', controls: [C.nist_govern3, C.atlas_accounts, C.asi03, C.eu_art12, C.soc2_cc6, C.iso_a9, C.iso27001_a8_2, C.hipaa_access, C.nist80053_ac6] },
  'ambiguous-agent-identity': { asr: 'ASR-1', controls: [C.nist_govern3, C.atlas_accounts, C.asi03, C.soc2_cc6, C.iso_a9, C.iso27001_a8_2, C.hipaa_access, C.nist80053_ac6] },
  'unverifiable-agent-scope': { asr: 'ASR-1', controls: [C.asi03, C.nist_manage1, C.soc2_cc6, C.iso_a9, C.iso27001_a8_2, C.hipaa_access, C.nist80053_ac6, C.aicm_iam05] },
  'agent-identity-attested': { asr: 'ASR-1', controls: [C.asi03, C.soc2_cc6, C.iso27001_a8_2, C.hipaa_access, C.nist80053_ac6] },

  // --- rag-memory analyzer (ASR-7, memory & retrieval integrity) ---
  // retrieval -> ASR-7: OWASP LLM01 (indirect injection) + LLM04 (poisoning)
  // + LLM08 (vector and embedding weaknesses) + ASI06 (memory & context
  // poisoning), MITRE ATLAS AML.T0051.001 (indirect injection) + AML.T0070
  // (RAG poisoning), NIST MEASURE-2 (data-flow measurement), EU Art.10 /
  // ISO A.7 (data governance), CSA AICM AIS-14 (AI cache protection) and the
  // COSAiS generative-AI overlay (draft mapping) for retrieval.
  'untrusted-retrieval-source': { asr: 'ASR-7', controls: [C.llm01, C.llm08, C.asi06, C.atlas_inj_ind, C.atlas_rag, C.nist_measure2, C.eu_art10, C.iso_a7, C.cosais_genai] },
  'unverified-memory-write': { asr: 'ASR-7', controls: [C.llm04, C.llm08, C.asi06, C.atlas_rag, C.nist_manage4, C.soc2_cc7, C.iso_a7, C.aicm_ais14] },
  'retrieval-sources-enumerated': { asr: 'ASR-7', controls: [C.nist_measure2, C.iso_a7] },
  'rag-memory-untested': { asr: 'ASR-7', controls: [] },

  // --- delegation analyzer (ASR-8, multi-agent delegation) ---
  // delegation -> ASR-8: OWASP LLM06 (excessive agency) + ASI03 (identity &
  // privilege abuse) + ASI07 (insecure inter-agent communication), MITRE
  // ATLAS AML.T0012 (credential reuse), NIST MAP-2 (tool-call authorization) /
  // MANAGE-1 (least-privilege treatment), SOC 2 CC6/CC7, ISO A.9, CSA AICM
  // IAM-16 (authorization mechanisms) and the COSAiS multi-agent overlay
  // (draft mapping).
  'delegation-privilege-escalation': { asr: 'ASR-8', controls: [C.llm06, C.asi03, C.asi07, C.atlas_accounts, C.nist_map2, C.nist_manage1, C.soc2_cc6, C.iso_a9, C.iso27001_a8_2, C.hipaa_access, C.nist80053_ac6, C.aicm_iam16, C.cosais_multi_agent] },
  'unattenuated-delegation': { asr: 'ASR-8', controls: [C.llm06, C.asi03, C.asi07, C.nist_manage1, C.soc2_cc6, C.iso_a9, C.iso27001_a8_2, C.hipaa_access, C.nist80053_ac6, C.aicm_iam16, C.cosais_multi_agent] },
  'opaque-delegation-hop': { asr: 'ASR-8', controls: [C.asi07, C.nist_govern3, C.nist_manage4, C.soc2_cc7, C.iso_a9, C.iso27001_a8_15, C.nist80053_au2, C.cosais_multi_agent] },
  'delegation-attenuated': { asr: 'ASR-8', controls: [C.asi03, C.nist_manage1] },
  'delegation-untested': { asr: 'ASR-8', controls: [] },
};

// pillar -> fallback mapping when a finding id is not in CONTROL_MAP.
const PILLAR_MAP = {
  permission: { asr: 'ASR-1', controls: [C.asi03, C.nist_manage1, C.soc2_cc6, C.iso27001_a8_2, C.hipaa_access, C.nist80053_ac6, C.aicm_iam05] },
  'tool-abuse': { asr: 'ASR-1', controls: [C.llm06, C.asi02, C.nist_map2, C.iso27001_a8_2, C.hipaa_access, C.nist80053_ac6] },
  'data-egress': { asr: 'ASR-3', controls: [C.llm02, C.nist_measure2, C.eu_art10, C.iso_a7, C.iso27001_a8_16, C.hipaa_transmission, C.nist80053_sc7, C.nist80053_sc8, C.aicm_dsp05] },
  'audit-trail': { asr: 'ASR-2', controls: [C.eu_art12, C.soc2_cc7, C.nist_manage4, C.iso27001_a8_15, C.hipaa_audit, C.nist80053_au2, C.aicm_log02] },
  'supply-chain': { asr: 'ASR-5', controls: [C.llm03, C.asi04, C.atlas_supply, C.nist_map4, C.iso_a10, C.iso27001_a5_23, C.iso27001_a8_30, C.eu_art11, C.nist80053_sr3, C.aicm_sta09] },
  // injection -> ASR-4: OWASP LLM01 + ASI01 (agent goal hijack: an injected
  // instruction redirects the agent's objective), MITRE ATLAS AML.T0051,
  // NIST AI RMF MEASURE-2.7 (security & resilience evaluation), EU AI Act
  // Art.9 (risk management) + Art.15 (accuracy, robustness & cybersecurity),
  // ISO 42001 A.6 (lifecycle verification & validation), CSA AICM AIS-15
  // (prompt differentiation) + MDS-06 (adversarial attack analysis) and the
  // COSAiS generative-AI overlay (draft mapping). The red-team battery is the
  // tested-injection evidence those controls require.
  injection: { asr: 'ASR-4', controls: [C.llm01, C.asi01, C.atlas_inj, C.nist_measure2_7, C.eu_art9, C.eu_art15, C.iso_a6, C.aicm_ais15, C.aicm_mds06, C.cosais_genai] },
  // evidence -> ASR-6: the signed report itself (input-evidence digest +
  // Ed25519 signature + offline verify). EU Art.11 (technical documentation)
  // + Art.12 (record-keeping), SOC 2 CC7, NIST MANAGE-4 (documentation),
  // ISO 42001 A.6, ISO 27001 A.8.15 (logging), CSA AICM A&A-02 (independent
  // assessments) and NIST SP 800-53 AU-10 (non-repudiation).
  evidence: { asr: 'ASR-6', controls: [C.eu_art11, C.eu_art12, C.soc2_cc7, C.nist_manage4, C.iso_a6, C.iso27001_a8_15, C.aicm_aa02, C.nist80053_au10] },
  // Wave-2 analyzers: identity -> ASR-1, retrieval/memory -> ASR-7, delegation -> ASR-8.
  'agent-identity': { asr: 'ASR-1', controls: [C.asi03, C.nist_govern3, C.nist_manage1, C.soc2_cc6, C.iso27001_a8_2, C.hipaa_access, C.nist80053_ac6] },
  'rag-memory': { asr: 'ASR-7', controls: [C.llm04, C.llm08, C.asi06, C.atlas_rag, C.nist_measure2, C.iso_a7, C.aicm_ais14] },
  delegation: { asr: 'ASR-8', controls: [C.llm06, C.asi03, C.asi07, C.nist_map2, C.nist_manage1, C.iso27001_a8_2, C.hipaa_access, C.nist80053_ac6, C.aicm_iam16, C.cosais_multi_agent] },
};

function asrFor(id) {
  return ASR_CONTROLS.find((a) => a.id === id) || null;
}

/**
 * asrCrosswalk - the run-independent ASR -> framework catalog baseline.
 *
 * The union of every CONTROL_MAP + PILLAR_MAP row per ASR control, deduped by
 * (framework, id). ASR-4 (injection: established by the red-team battery) and
 * ASR-6 (evidence: established by the signed report's input-evidence digest +
 * signature) produce no analyzer findings, so a findings-driven crosswalk
 * would render them blank; consumers fall back to this catalog mapping so all
 * eight ASR controls carry at least one framework row. Never throws.
 *
 * @returns {{ id: string, name: string, controls: {framework: string, id: string, label: string}[] }[]}
 */
export function asrCrosswalk() {
  const byAsr = new Map(ASR_CONTROLS.map((a) => [a.id, new Map()]));
  const add = (row) => {
    const m = row && byAsr.get(row.asr);
    if (!m) return;
    for (const ctrl of row.controls || []) {
      const key = ctrl.framework + ' ' + ctrl.id;
      if (!m.has(key)) m.set(key, { ...ctrl });
    }
  };
  for (const row of Object.values(CONTROL_MAP)) add(row);
  for (const row of Object.values(PILLAR_MAP)) add(row);
  return ASR_CONTROLS.map((a) => ({
    id: a.id,
    name: a.name,
    controls: [...byAsr.get(a.id).values()].sort((x, y) =>
      (x.framework + ' ' + x.id).localeCompare(y.framework + ' ' + y.id)),
  }));
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
