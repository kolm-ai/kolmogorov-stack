export const meta = {
  name: 'kolm-sota-readiness-audit',
  description: 'Adversarial state-of-the-art readiness audit of the kolm codebase + site vs best-in-class, judged as elite security researchers + enterprise buyers would. Outputs a prioritized P0/P1/P2 punch-list.',
  phases: [
    { title: 'Bar', detail: 'define the state-of-the-art bar (codebase + site) vs best-in-class 2026' },
    { title: 'CodeAudit', detail: 'adversarial codebase review across security/architecture/tests/crypto/docs' },
    { title: 'SiteAudit', detail: 'site review: positioning, design, trust content, hygiene' },
    { title: 'Synthesize', detail: 'consolidate into a prioritized punch-list + sequence' },
  ],
};

const REPO = 'C:/Users/user/Desktop/kolmogorov-stack';
const SRC = REPO + '/src';
const PUB = REPO + '/public';
const GROK = 'node C:/Users/user/Desktop/kolmogorov-stack/scripts/grok-research.mjs';
const CTX = `CONTEXT: kolm is pivoting to an AI-AGENT SECURITY-REVIEW READINESS audit product (signed evidence reports that unblock enterprise deals), credibility delivered by a network of WORLD-CLASS security researchers who will co-sign — and who will JUDGE this codebase + site on sight. The founder's explicit bar: "state-of-the-art so I'm not embarrassed in front of the best auditors on earth." The attestation/signing stack (src/ed25519.js, src/intoto-receipt.js, src/auditor-attestation.js, src/transparency-log.js) is the product's credibility core and will be scrutinized hardest. NOTE: the live site currently positions as "AI control plane for teams" (a SUPERSEDED direction) — flag mismatch with the new agent-security-audit direction. Be ADVERSARIAL and specific; grade against BEST-IN-CLASS, not "good enough"; cite file paths / line numbers / URLs.`;

phase('Bar');
const BAR_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['domain', 'bar_criteria', 'red_flags'],
  properties: {
    domain: { type: 'string' },
    bar_criteria: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['criterion', 'best_in_class'], properties: { criterion: { type: 'string' }, best_in_class: { type: 'string' } } } },
    red_flags: { type: 'array', items: { type: 'string' } },
  },
};
const [codeBar, siteBar] = await parallel([
  () => agent(`${CTX}\n\nDefine the STATE-OF-THE-ART BAR for the CODEBASE of a credible AI-security / verifiable-evidence company in 2026, as elite security researchers would judge it: security hygiene, crypto/signing correctness, architecture, test coverage + CI, supply-chain/dependency hygiene, secrets handling, docs/DX, code consistency. Benchmark against best-in-class open-source security/infra projects (e.g., Sigstore, what top researchers respect). Run ${GROK} --sources x,web "<query>" to ground it. List criteria + what best-in-class looks like + the red flags that would make a top auditor lose respect instantly.`, { label: 'bar:code', phase: 'Bar', agentType: 'Explore', schema: BAR_SCHEMA }),
  () => agent(`${CTX}\n\nDefine the STATE-OF-THE-ART BAR for the WEBSITE of a credible AI-security company in 2026 selling to enterprise security buyers + respected by elite researchers: positioning clarity, design/polish, credibility/trust signals (security page, transparency, real proof), technical depth, performance, accessibility. Benchmark against best-in-class security/dev-infra company sites. Run ${GROK} --sources x,web "<query>" to ground it. List criteria + best-in-class + instant-credibility-killer red flags.`, { label: 'bar:site', phase: 'Bar', agentType: 'Explore', schema: BAR_SCHEMA }),
]);
const barStr = [codeBar, siteBar].filter(Boolean).map((b) => `## ${b.domain} BAR\n- ${b.bar_criteria.map((c) => `${c.criterion}: ${c.best_in_class}`).join('\n- ')}\nRED FLAGS: ${b.red_flags.join(' | ')}`).join('\n\n');

const AUDIT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['area', 'grade', 'summary', 'strengths', 'gaps'],
  properties: {
    area: { type: 'string' }, grade: { type: 'string' }, summary: { type: 'string' },
    strengths: { type: 'array', items: { type: 'string' } },
    gaps: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['issue', 'severity', 'evidence', 'fix', 'effort'], properties: { issue: { type: 'string' }, severity: { type: 'string', enum: ['P0', 'P1', 'P2'] }, evidence: { type: 'string' }, fix: { type: 'string' }, effort: { type: 'string' } } } },
  },
};

phase('CodeAudit');
const codeTasks = [
  { key: 'crypto-signing', p: `DEEP, adversarial review of the attestation/signing stack (the product's credibility core): Read ${SRC}/ed25519.js, ${SRC}/intoto-receipt.js, ${SRC}/auditor-attestation.js, ${SRC}/transparency-log.js, ${SRC}/transparency-anchor.js, ${SRC}/keys.js, ${SRC}/gateway-receipt.js, ${SRC}/ensure-signing-key.js. Judge as a cryptography-literate security researcher: key generation/storage/rotation, canonical serialization before signing, signature + verification correctness, replay/tamper resistance, transparency-log soundness (Merkle/append-only), DSSE/in-toto conformance, offline-verifiability, footguns. Is this the kind of code an elite auditor would trust their name on? Grade A-F.` },
  { key: 'security-hygiene', p: `Adversarial security-hygiene review. Use Glob/Grep across ${SRC}: secrets handling (any hardcoded keys/tokens, .env handling), auth (${SRC}/auth.js, router auth), input validation, injection surfaces, PII redaction correctness (${SRC}/pii-redactor.js), dangerous patterns (eval, child_process, unsanitized fs, SSRF in fetch/proxy, path traversal). Check package.json + lockfile for risky/outdated deps. Grade A-F; list the issues a pentester would file.` },
  { key: 'architecture-quality', p: `Architecture + code-quality review. Glob ${SRC} (how many files? cohesion?), assess modularity, consistency, dead/duplicated code, the src/ sprawl, naming, separation of concerns, and whether the new audit-product modules can live cleanly here. Read a representative sample incl. ${SRC}/router.js, ${SRC}/store.js, ${SRC}/capture-store.js. Grade A-F.` },
  { key: 'tests-ci', p: `Testing + reliability review. Look at the tests/ directory (Glob), CI config (.github or similar), ${REPO}/scripts/release-verify.cjs and gates. Assess coverage breadth, what's untested (esp. the signing/crypto + audit paths), flakiness, and whether a researcher would trust the green checkmark. Grade A-F.` },
  { key: 'docs-dx', p: `Docs + developer-experience review. Read ${REPO}/README* and any top-level docs, assess onboarding, architecture docs, API docs, and whether an elite researcher cloning the repo could understand + trust it in 10 minutes. Grade A-F.` },
];
const codeAudit = await parallel(codeTasks.map((t) => () =>
  agent(`${CTX}\n\nSTATE-OF-THE-ART BAR:\n${barStr}\n\nAUDIT TASK: ${t.p}\n\nReturn area, grade (A-F), summary, strengths, and gaps (each: issue, severity P0/P1/P2, evidence=file:line, fix, effort). P0 = would embarrass us in front of elite auditors / block enterprise trust.`,
    { label: `code:${t.key}`, phase: 'CodeAudit', agentType: 'Explore', schema: AUDIT_SCHEMA })
));

phase('SiteAudit');
const siteTasks = [
  { key: 'positioning', p: `Positioning + messaging review. Read ${PUB}/index.html, ${PUB}/product.html, ${PUB}/nav.js, and WebFetch https://kolm.ai. Does the site clearly tell the NEW story (agent security-review readiness / deal-unblocker / signed evidence / named auditors) or the SUPERSEDED "AI control plane for teams"? Assess clarity, credibility, and the gap to the new direction. Grade A-F.` },
  { key: 'design-polish', p: `Design + polish review. Read the CSS (${PUB}/design-tokens.css, ${PUB}/warm-paper.css, ${PUB}/styles.css, ${PUB}/frontier.css) and a few key pages; WebFetch https://kolm.ai. Judge visual quality, consistency, modernity vs best-in-class security/dev-infra sites — would it embarrass us in front of elite auditors? Flag what needs a visual pass. Grade A-F.` },
  { key: 'trust-content', p: `Trust + technical-depth review. Look for a security/trust page, real proof, docs depth, and the kind of substance a security researcher respects (vs marketing fluff). WebFetch https://kolm.ai and check ${PUB} for security.html / trust / docs. Is there a credible, verifiable proof story? Grade A-F.` },
  { key: 'hygiene', p: `Site hygiene review. Assess the public/ sprawl (Glob ${PUB} — how many HTML files?), dead/orphan pages, broken internal links, SEO/meta basics, performance (page weight, scripts), accessibility. Would a sprawling/inconsistent site undercut credibility? Grade A-F.` },
];
const siteAudit = await parallel(siteTasks.map((t) => () =>
  agent(`${CTX}\n\nSTATE-OF-THE-ART BAR:\n${barStr}\n\nAUDIT TASK: ${t.p}\n\nReturn area, grade (A-F), summary, strengths, and gaps (each: issue, severity P0/P1/P2, evidence=file/url, fix, effort). P0 = would embarrass us / undercut credibility immediately.`,
    { label: `site:${t.key}`, phase: 'SiteAudit', agentType: 'Explore', schema: AUDIT_SCHEMA })
));

phase('Synthesize');
const all = [...codeAudit, ...siteAudit].filter(Boolean);
const auditStr = all.map((a) => `### ${a.area} [${a.grade}]\n${a.summary}\nGAPS: ${a.gaps.map((g) => `(${g.severity}) ${g.issue} -> ${g.fix} [${g.effort}] @ ${g.evidence}`).join(' || ')}`).join('\n\n');
const PUNCH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['overall_grade', 'headline', 'p0', 'p1', 'p2', 'sequence', 'state_of_the_art_bar'],
  properties: {
    overall_grade: { type: 'string' }, headline: { type: 'string' },
    p0: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['item', 'why', 'files', 'fix', 'effort'], properties: { item: { type: 'string' }, why: { type: 'string' }, files: { type: 'string' }, fix: { type: 'string' }, effort: { type: 'string' } } } },
    p1: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['item', 'why', 'files', 'fix', 'effort'], properties: { item: { type: 'string' }, why: { type: 'string' }, files: { type: 'string' }, fix: { type: 'string' }, effort: { type: 'string' } } } },
    p2: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['item', 'fix'], properties: { item: { type: 'string' }, fix: { type: 'string' } } } },
    sequence: { type: 'array', items: { type: 'string' } },
    state_of_the_art_bar: { type: 'array', items: { type: 'string' } },
  },
};
const punchlist = await agent(
  `${CTX}\n\nSTATE-OF-THE-ART BAR:\n${barStr}\n\nALL AUDIT FINDINGS:\n${auditStr}\n\nConsolidate into ONE prioritized punch-list. overall_grade (A-F for current state). headline (the candid one-paragraph verdict). p0 = must-fix before showing elite auditors / enterprise buyers (each: item, why, files, fix, effort). p1 = important soon. p2 = polish. sequence = the recommended order of attack. state_of_the_art_bar = the crisp bar we are aiming for. Dedup across findings; be specific and actionable.`,
  { label: 'synth:punchlist', phase: 'Synthesize', schema: PUNCH_SCHEMA }
);

return { bar: { codeBar, siteBar }, code_audit: codeAudit.filter(Boolean), site_audit: siteAudit.filter(Boolean), punchlist };
