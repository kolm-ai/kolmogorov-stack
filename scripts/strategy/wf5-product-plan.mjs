export const meta = {
  name: 'kolm-fastleg-product-plan',
  description: 'Deep product plan for the fast-leg: "pass-your-customers-security-review" attestation for AI-native startups. Discovery (web + codebase) -> synthesis -> design (architecture/methodology/ICP/GTM/framework/8wk).',
  phases: [
    { title: 'Discovery', detail: 'real user + security-review pain + competitors + standards + methodology + kolm codebase map' },
    { title: 'Synthesize', detail: 'consolidate into a discovery brief' },
    { title: 'Design', detail: 'architecture, methodology+report, ICP+pricing, GTM, framework, 8-week plan' },
  ],
};

const REPO = 'C:/Users/user/Desktop/kolmogorov-stack';
const RAW1 = REPO + '/research/strategy-2026/raw';
const WEB = 'Use WebSearch + WebFetch for live research; current to 2026; cite sources with URLs.';
const CTX = `PRODUCT: a fast, managed "Agent Security Review Readiness" AUDIT + cryptographically SIGNED ATTESTATION REPORT that a seed/Series-A AI-native startup buys to UNBLOCK an enterprise deal stuck in the buyer's security review (their agentic product is over-permissioned / has no audit trail / no SOC2 / no prompt-injection story). It is sales-enablement/deal-unblocking, NOT enterprise security tooling (Okta-for-AI-Agents, Vorlon own that). Founder assets to reuse: kolm's gateway traffic capture, Ed25519 signed receipts, capture/event store, replay/eval, distillation/quantization, scoped API keys, PII redaction. Founder = technical, network = AI-native startups, cold start, wants ~$25k/mo in 8 weeks via fixed-fee + contingency + retainer. This fast leg is the cash/learning engine that funds a later durable regulated-vertical bet.`;

const DISCO_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['area', 'key_findings', 'implications'],
  properties: {
    area: { type: 'string' },
    key_findings: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['point', 'evidence'], properties: { point: { type: 'string' }, evidence: { type: 'string' } } } },
    implications: { type: 'array', items: { type: 'string' } },
  },
};

phase('Discovery');
const discoTasks = [
  { key: 'user-icp', web: true, p: `Define the ACTUAL USER in depth. Who exactly is the buyer: seed/Series-A AI-native startups selling agentic products to enterprises and stalling in security review. Company stage/size, product type (coding agents, support agents, vertical agents), the economic buyer (founder/CTO/head of security), how many such companies exist, and their JTBD ("get our agent through the customer's security review to close the deal"). Also read ${RAW1}/t4-x-pain.json and ${RAW1}/t4-security.json (round-1 X-grounded demand) for verbatim pain signal. ${WEB}` },
  { key: 'security-review-process', web: true, p: `Map what enterprises ACTUALLY demand of AI/agent vendors in a security review in 2026: vendor security questionnaires (SIG, CAIQ, VSA), SOC2 Type II, pen-test reports, DPAs, and AI-specific addenda (model/data handling, prompt-injection, agent permissions/tool scopes, human oversight, EU AI Act). Find real questionnaire items/checklists. Identify exactly WHY AI vendors fail or stall. ${WEB}` },
  { key: 'buying-gtm', web: true, p: `Map the buying process + GTM reality: who signs, budget/WTP for unblocking an enterprise deal, sales-cycle length, contingency-pricing norms in security/compliance services, and the channels to reach seed/Series-A AI founders cold (accelerators, communities, Slacks, design-partner motions). ${WEB}` },
  { key: 'competitors-security', web: true, p: `Competitive precision on AI/agent security: Okta AI / Auth0, Vorlon, Wiz AI-SPM, Prompt Security, Lakera, PromptArmor, HiddenLayer, Robust Intelligence (Cisco), Lasso, Aim Security, Straiker, etc. For each: what it does, buyer, pricing, and whether it serves the "AI-vendor-passes-its-customer's-security-review attestation" job. Pinpoint the exact gap our product fills. ${WEB}` },
  { key: 'competitors-trust', web: true, p: `Competitive precision on compliance + trust layers: Vanta, Drata, Secureframe (and their AI modules), plus trust-center/questionnaire-automation (SafeBase, Whistic, Conveyor, Vanta Trust). Do any produce an AI-AGENT-specific, signed, deal-unblocking attestation? Where is the gap, and who could fast-follow? ${WEB}` },
  { key: 'standards', web: true, p: `Which frameworks should the attestation MAP TO so enterprise buyers accept it: SOC2 (Trust Services Criteria), ISO 42001, NIST AI RMF, EU AI Act (esp. Art.12 logging), OWASP LLM Top 10 (2025/26) + OWASP Agentic threats, MITRE ATLAS, MCP security, cloud-security-alliance AI controls. For each: the specific controls an agent-security attestation should assert. ${WEB}` },
  { key: 'methodology', web: true, p: `Define the ACTUAL technical audit methodology for an AI agent's security posture: least-privilege/permission analysis, OAuth/tool-scope review, prompt-injection + jailbreak resistance testing, data-egress/PII handling, secrets management, tool-call audit-trail completeness, sandbox/isolation, human-in-the-loop gates, supply-chain (MCP servers). What concrete checks, tools, and red-team techniques apply? ${WEB}` },
  { key: 'codebase-map', web: false, p: `Map kolm's reusable components for this product. Use Glob/Grep/Read on ${REPO}/src and ${REPO}/scripts. Find and cite file paths for: gateway/traffic capture (dispatch in src/router.js), Ed25519 signed receipts / verify, capture-store + event-store + event-schema, replay/eval, distillation/quantization (scripts), scoped API keys + auth (src/auth.js), PII redaction, secrets-vault. For each: what it does and how it maps to the attestation pipeline (capture agent traffic -> analyze posture -> emit signed attestation). Note what is REUSABLE vs must be BUILT NEW.` },
];
const discovery = await parallel(discoTasks.map((t) => () =>
  agent(`${CTX}\n\nTASK: ${t.p}\n\nReturn area, key_findings (point + evidence/source), and implications for our product.`,
    { label: `disc:${t.key}`, phase: 'Discovery', agentType: 'Explore', schema: DISCO_SCHEMA })
));
const discoOk = discovery.filter(Boolean);
const discoBrief = discoOk.map((d) => `### ${d.area}\nFINDINGS: ${d.key_findings.map((f) => f.point).join(' | ')}\nIMPLICATIONS: ${d.implications.join(' | ')}`).join('\n\n');
log(`Discovery: ${discoOk.length}/${discoTasks.length} areas`);

phase('Synthesize');
const BRIEF_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['the_user', 'the_pain', 'buyer_process', 'competitive_gap', 'standards_to_map', 'reusable_stack', 'positioning_hypothesis', 'biggest_risks'],
  properties: {
    the_user: { type: 'string' }, the_pain: { type: 'string' }, buyer_process: { type: 'string' },
    competitive_gap: { type: 'string' }, standards_to_map: { type: 'string' }, reusable_stack: { type: 'string' },
    positioning_hypothesis: { type: 'string' }, biggest_risks: { type: 'array', items: { type: 'string' } },
  },
};
const brief = await agent(`${CTX}\n\nConsolidate this discovery into a tight product brief.\n\nDISCOVERY:\n${discoBrief}`, { label: 'synth:brief', phase: 'Synthesize', schema: BRIEF_SCHEMA });
const briefStr = JSON.stringify(brief);

phase('Design');
const DESIGN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['component', 'summary', 'details', 'decisions', 'open_questions'],
  properties: {
    component: { type: 'string' }, summary: { type: 'string' },
    details: { type: 'array', items: { type: 'string' } }, decisions: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' } },
  },
};
const designTasks = [
  { key: 'architecture', p: `Design the ACTUAL system architecture end-to-end: how a customer connects their agent (gateway proxy / SDK / log import / MCP intercept), the analysis pipeline (capture -> least-privilege + OAuth-scope analysis + prompt-injection test harness + data-egress/secrets scan + audit-trail completeness), and the cryptographically SIGNED attestation output (Ed25519, offline-verifiable, mapped to controls). Specify the concrete TECH STACK, reusing kolm components by file path where possible and naming what's built new. Make it buildable in ~2-3 weeks for an MVP.` },
  { key: 'methodology-report', p: `Design the audit METHODOLOGY (the concrete checklist of controls we test, each mapped to SOC2/ISO42001/NIST-AI-RMF/EU-AI-Act/OWASP) AND the signed ATTESTATION REPORT spec (sections, what each control asserts, severity, evidence, the verifiable signature block, and what an enterprise buyer's security reviewer accepts). This is the deliverable the customer hands their prospect.` },
  { key: 'icp-pricing', p: `Sharpen the ICP + positioning + packaging + pricing. Exact target firmographics + trigger ("deal stuck in security review"); positioning vs Okta/Vorlon/Vanta (deal-unblocking, not tooling); packaging (one-time audit + signed report; continuous re-attestation retainer; optional remediation); concrete pricing ($ fixed-fee, contingency tie-to-deal-close, $/mo retainer) with rationale and the $25k/mo math.` },
  { key: 'gtm', p: `Design the cold-start GTM playbook: the exact hook/message ("unblock your stalled enterprise deal"), the channels to reach seed/Series-A AI founders, the free "agent exposure scan" lead magnet, the design-partner motion, referral loop, and a public artifact (teardown / the readiness framework) for inbound. Give the literal outbound sequence.` },
  { key: 'framework', p: `Design the durable wedge: an "AI Agent Security Review Readiness" FRAMEWORK / open standard the product authors and owns (a named control set + readiness levels + a public checklist enterprises can ask vendors to meet). Explain how owning the spec compounds into defensibility (becomes the thing buyers request by name) and how it bridges toward the durable regulated-vertical bet.` },
  { key: 'eightweek-bridge', p: `Produce the 8-week build+sell plan (week-by-week: build MVP from kolm stack, hand-sell to network, convert to paid + retainers, reach ~$25k/mo run-rate), the top risks + mitigations (esp. Okta/Vorlon fast-follow, attestation credibility/liability, commoditization), and the explicit BRIDGE: which reusable assets (signing/attestation infra, the framework, customer trust) carry into the durable regulated bet, and the trigger to start the co-founder search.` },
];
const design = await parallel(designTasks.map((t) => () =>
  agent(`${CTX}\n\nPRODUCT BRIEF:\n${briefStr}\n\nDESIGN TASK (${t.key}): ${t.p}\n\nBe concrete and decisive (this is "measure 1000x, cut 1x" — specify real choices, not options). ${t.key === 'architecture' ? 'You may Read kolm files to ground the stack.' : ''}`,
    { label: `design:${t.key}`, phase: 'Design', agentType: 'Explore', schema: DESIGN_SCHEMA })
));
const designOk = design.filter(Boolean);
log(`Design: ${designOk.length}/${designTasks.length} components`);

return { discovery: discoOk, brief, design: designOk };
