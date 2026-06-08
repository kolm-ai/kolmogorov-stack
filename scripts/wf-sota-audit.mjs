export const meta = {
  name: 'kolm-sota-audit',
  description: 'Exhaustive SOTA audit of the live Obsidian Foil site: per-page review (screenshots+HTML) + cross-page critics, every high-severity finding adversarially verified',
  phases: [
    { title: 'Review', detail: 'one agent per page: desktop+mobile screenshot + HTML vs Obsidian Foil SOTA rubric' },
    { title: 'Critics', detail: 'cross-page consistency: nav/footer parity, foil rationing, link graph, motif, flagship gap, voice' },
    { title: 'Verify', detail: 'adversarial skeptic confirms each blocker/major before it enters the punch list' },
  ],
};

const ROOT = 'C:\\Users\\user\\Desktop\\kolmogorov-stack';
const manifest = (args && Array.isArray(args)) ? args : [];
function abs(rel) { return ROOT + '\\' + String(rel).replace(/\//g, '\\'); }

const CONSTRAINTS = `== HARD CONSTRAINTS (a proposed fix that violates ANY of these is invalid) ==
- Identity is "Obsidian Foil": austere MONOCHROME canvas (#0C0D10 paper, #ECEEF2 text, platinum #C9CFDA seal). The ONLY colour/spectrum allowed is the holographic foil gradient, and it is RATIONED to the verified/seal state + the 3px top "foil-strip" security thread. Foil must NEVER leak into generic accents, buttons, links, eyebrows, or decoration. Flag any colour that is not greyscale-or-foil-on-verified.
- Typeface is MONO-FORWARD: the entire site is Spline Sans Mono. No other family should render.
- NO generic-AI "eyebrow" kicker labels above headings. NO em dashes or en dashes (— – &mdash; &ndash;) anywhere. Ordinals use <span class="step__n">; section dividers use the § idx marker.
- NEVER the word "honest"/"honesty" in any form (use "candid", "plainly stated", "verifiable", "Caveats", "Limitations", "Scope").
- The ONLY contact address is dev@kolm.ai. No other email may appear. The personal address rodneyyesep@... must NEVER appear.
- NEVER these exact substrings: "pip install kolm", ".kolm bundle", "3B INT4", "Arweave", "On-chain", "Air-gap mode", "WASM runtime", "kolm WASM", "EU AI Act compliant", "Type I evidence available now", "SOC 2 Type II evidence", "Your data never moves", "data never moves", "inside your VPC", "BAA boundary", "PHI never leaves", "HIPAA-ready", "Mobile SDK", "AIUC-1".
- Keep the kolm name + three-bar logo + brand. NO named researchers as real people. NO "Halborn". NO blockchain in the enterprise critical path. The framework is NOT named "AIUC-1".
- Preserve EVERY factual/security claim and its scope exactly (e.g. "injection tested and reported, not warranted"). The fail-open reveal mechanic (.reveal / js-reveal / data-reveal-armed) and the two-tier verify widget ([data-verify-widget]) must keep working. Hyphenated compounds, URLs, dates, version numbers, and control IDs (SOC 2 CC6, ISO 42001, NIST AI RMF, EU AI Act Art.12/14, OWASP LLM Top 10, MITRE ATLAS) are CORRECT and must stay.`;

const FINDING = {
  type: 'object', additionalProperties: false,
  required: ['severity', 'dimension', 'where', 'problem', 'fix'],
  properties: {
    severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'polish'] },
    dimension: { type: 'string', enum: ['aesthetic', 'layout', 'copy', 'a11y', 'links', 'consistency', 'brand'] },
    where: { type: 'string', description: 'exact CSS selector, line number, screenshot region, or href — be specific enough to act on' },
    problem: { type: 'string', description: 'what is wrong and why it falls short of a SOTA, elite-reviewer-grade bar' },
    fix: { type: 'string', description: 'the concrete, constraint-respecting change to make' },
  },
};

const PAGE_REVIEW = {
  type: 'object', additionalProperties: false,
  required: ['route', 'sotaScore', 'verdict', 'findings', 'strengths'],
  properties: {
    route: { type: 'string' },
    sotaScore: { type: 'integer', description: '0-100: how close this page is to the flagship index.html bar' },
    verdict: { type: 'string', enum: ['sota', 'solid', 'needs-work', 'below-bar'] },
    strengths: { type: 'string', description: 'what already works, briefly' },
    findings: { type: 'array', items: FINDING },
  },
};

const CRITIC_REVIEW = {
  type: 'object', additionalProperties: false,
  required: ['critic', 'findings', 'summary'],
  properties: {
    critic: { type: 'string' },
    summary: { type: 'string' },
    findings: { type: 'array', items: FINDING },
  },
};

const VERDICT = {
  type: 'object', additionalProperties: false,
  required: ['real', 'severityConfirmed', 'reason', 'fixSafe'],
  properties: {
    real: { type: 'boolean', description: 'true only if this is a genuine shortfall worth fixing on a SOTA site' },
    severityConfirmed: { type: 'string', enum: ['blocker', 'major', 'minor', 'polish', 'not-a-bug'] },
    reason: { type: 'string' },
    fixSafe: { type: 'boolean', description: 'true if the proposed fix respects every HARD CONSTRAINT and breaks no claim/mechanic' },
    fixNote: { type: 'string', description: 'corrected fix if the original is unsafe/wrong, else empty' },
  },
};

// ---- helpers ----------------------------------------------------------------
function reviewPrompt(p) {
  return `You are an elite product designer + front-end engineer auditing ONE page of kolm.ai, which sells cryptographically-signed AI-agent security-review evidence to enterprise buyers. The bar is brutal: this site will be judged by the best security researchers on earth, so "fine" is a failure. Your job is to find every gap between this page and a genuinely state-of-the-art "Obsidian Foil" signed-instrument aesthetic.

ROUTE: ${p.route}
HTML SOURCE: ${abs(p.html)}
DESKTOP SCREENSHOT (1440w, full page): ${abs(p.shots.desktop)}
MOBILE SCREENSHOT (390w, full page): ${abs(p.shots.mobile)}

STEPS:
1. Read BOTH screenshots (they show the fully-revealed design) and the HTML source.
2. The flagship reference is public/index.html (already SOTA): terse instrument voice, mono-forward type, monochrome plates + hairlines, foil rationed to the verified/seal state, generous vertical rhythm, § ledger markers, step__n ordinals, a holographic foil-strip at the very top.
3. Judge THIS page against that bar across: AESTHETIC (monochrome discipline, foil rationing, mono type, plate/hairline craft, no leftover ivory/oxblood "Signet" or warm artifacts), LAYOUT (spacing rhythm, alignment, hierarchy, no broken/overflowing/empty/cramped sections, MOBILE reflow at 390px — check the mobile shot specifically for overflow, tap-target size, table/grid collapse), COPY (matches the flagship's voice; no generic-AI filler; no eyebrow kickers; no dashes; no banned word; deal-unblocker positioning; claims intact), A11Y (text contrast — especially faint greys like #777E8B on #0C0D10; focus states; alt text; heading order; aria on interactive controls), LINKS/STRUCTURE (every internal href is one of the real routes; anchors exist; referenced assets exist).

${CONSTRAINTS}

Return PAGE_REVIEW. sotaScore is 0-100 vs the flagship. Only raise findings you would actually fix on an elite site; for each, give an EXACT location and a concrete, constraint-respecting fix. Be specific and skeptical, not generic. It is fine to return an empty findings array with a high score if the page is genuinely SOTA, but look hard at the mobile screenshot and the faint-grey contrast first.`;
}

const CRITICS = [
  { id: 'nav-footer-parity', prompt: `Audit NAV + FOOTER PARITY across all 28 pages of public/*.html (and public/security/*.html, public/solutions/*.html). Use Grep/Read. The site must feel like ONE instrument: identical primary nav (same links, same order, same three-bar brand mark, same "Verify a report" / "Start an audit" actions) and identical footer columns on every page. Find any page whose nav or footer drifts (extra/missing/renamed/reordered links, a dead link target, a stale brand mark, a missing foil-strip). Report each drift as a finding with the exact file + the corrected markup.` },
  { id: 'foil-rationing', prompt: `Audit FOIL/COLOUR RATIONING across public/kolm-2026.css and every public/*.html. Obsidian Foil is monochrome; the holographic foil gradient (--foil) and any non-greyscale colour are allowed ONLY on (a) the verified/seal state and (b) the 3px top foil-strip. Hunt for LEAKS: any hex that is not greyscale (not #0x0y0z-ish neutral) used on buttons, links, borders, eyebrows, badges, backgrounds, or decoration; any leftover oxblood #7A1F2B / claret / ivory #F4F4F1 / burnt-orange #c2410c "Signet"/"warm" artifacts; foil applied to non-verified UI. Report each leak with file:line and the greyscale/foil-correct replacement.` },
  { id: 'link-graph', prompt: `Audit the INTERNAL LINK GRAPH. The real routes are exactly: / /404 /acceptable-use /baa /careers /changelog /checks /contact /docs /dpa /enterprise /how-it-works /platform /pricing /privacy /report /research /security /security/threat-model /sla /solutions/ai-vendors /solutions/enterprise-buyers /status /subprocessors /terms /transparency-log /trust /verify . Grep every href/src in public/*.html. Flag: any internal link whose target is NOT one of those routes (and is not an on-page #anchor that exists, a mailto:dev@kolm.ai, or a real asset that exists on disk under public/); any referenced asset (css/js/woff2/svg/png) that does not exist on disk; any #anchor with no matching id. Report each broken target with the file it appears in and the correct destination.` },
  { id: 'motif-consistency', prompt: `Audit MOTIF + HEAD CONSISTENCY across all 28 pages. Every page must: load /kolm-2026.css + the Spline Sans Mono @font-face, preload SplineSansMono-400 + 600, set theme-color #0C0D10, carry the <hr class="foil-strip"> as first body child, and use the shared instrument vocabulary (§ idx markers, step__n ordinals, plate/hairline classes) consistently rather than ad-hoc inline styles. Find pages that diverge: inline <style> pitch-black/warm overrides, a different/missing font, missing foil-strip, missing/duplicate theme-color, ad-hoc decoration that breaks the system. Report each with file + fix.` },
  { id: 'flagship-gap', prompt: `You are the COMPLETENESS critic. Read public/index.html (the SOTA flagship) fully, then skim every other page in public/*.html. Identify the pages that fall MOST short of the flagship's bar — thin/placeholder content, weak or generic copy, missing the deal-unblocker framing, sparse layout that reads unfinished, or sections that feel like a template stub. For the 6-8 weakest pages, give a finding: what specifically makes it sub-flagship and the concrete upgrade (structure + copy direction) that would bring it to the bar. Prioritise pages an enterprise security reviewer would actually open: /security, /verify, /how-it-works, /trust, /enterprise, /report, /checks, /research, /pricing.` },
  { id: 'voice-banned', prompt: `Audit COPY VOICE + BANNED CONTENT across all public/*.html. (1) Voice: the flagship is terse, declarative, instrument-grade ("The deal isn't lost. It's in security review."). Flag any page with generic-AI marketing filler, hedging, hype, or voice drift, with the exact sentence and a tighter rewrite. (2) Banned (these are blockers if found): the word honest/honesty in any form; any email other than dev@kolm.ai; the personal address rodneyyesep; any em/en dash (— – &mdash; &ndash;); any class="eyebrow" element that renders; any of the forbidden substrings. Grep precisely and report each hit with file:line.` },
];

function verifyPrompt(f, ctx) {
  return `Adversarially verify ONE proposed finding on the kolm.ai SOTA audit. Default to skepticism: many "findings" are noise, taste-only nitpicks, or propose fixes that would violate a hard constraint or break a real claim. Confirm it only if a genuinely elite, SOTA site would fix it.

CONTEXT: ${ctx}
FINDING:
- severity: ${f.severity}
- dimension: ${f.dimension}
- where: ${f.where}
- problem: ${f.problem}
- proposed fix: ${f.fix}

Open the relevant file(s) under ${ROOT}\\public (Read/Grep) and check the claim against the ACTUAL current source — do not trust the finding's description. Decide: is this real and worth fixing? Is the severity right? Crucially, does the proposed fix respect EVERY hard constraint below and break no factual/security claim or mechanic? If the fix is unsafe or wrong, set fixSafe=false and put the corrected fix in fixNote.

${CONSTRAINTS}

Return VERDICT.`;
}

// ---- run --------------------------------------------------------------------
async function verifyFindings(findings, ctx, phaseName) {
  const toCheck = (findings || []).filter((f) => f.severity === 'blocker' || f.severity === 'major');
  const verified = await parallel(toCheck.map((f) => () =>
    agent(verifyPrompt(f, ctx), { label: 'verify:' + (f.where || '').slice(0, 40), phase: phaseName, schema: VERDICT })
      .then((v) => (v ? { ...f, verdict: v } : null))));
  // minor/polish pass through unverified but flagged lower priority
  const passthrough = (findings || []).filter((f) => f.severity === 'minor' || f.severity === 'polish').map((f) => ({ ...f, verdict: null }));
  return [...verified.filter(Boolean), ...passthrough];
}

phase('Review');
const pagesP = pipeline(
  manifest,
  (p) => agent(reviewPrompt(p), { label: 'review:' + p.slug, phase: 'Review', schema: PAGE_REVIEW }),
  (rev) => rev ? verifyFindings(rev.findings, `page ${rev.route} (sotaScore ${rev.sotaScore}, ${rev.verdict})`, 'Verify').then((vf) => ({ ...rev, findings: vf })) : null,
);

const criticsP = pipeline(
  CRITICS,
  (c) => agent(c.prompt, { label: 'critic:' + c.id, phase: 'Critics', schema: CRITIC_REVIEW }),
  (cr, orig) => cr ? verifyFindings(cr.findings, `cross-page critic ${orig.id}`, 'Verify').then((vf) => ({ ...cr, findings: vf })) : null,
);

const [pageResults, criticResults] = await Promise.all([pagesP, criticsP]);

// ---- synthesize -------------------------------------------------------------
const pages = pageResults.filter(Boolean);
const critics = criticResults.filter(Boolean);

function confirmed(f) {
  if (!f.verdict) return true; // minor/polish passthrough
  return f.verdict.real && f.verdict.severityConfirmed !== 'not-a-bug';
}
function effFix(f) { return (f.verdict && f.verdict.fixSafe === false && f.verdict.fixNote) ? f.verdict.fixNote : f.fix; }
function effSev(f) { return f.verdict ? f.verdict.severityConfirmed : f.severity; }

const allFindings = [];
for (const pr of pages) for (const f of (pr.findings || [])) if (confirmed(f)) allFindings.push({ source: pr.route, severity: effSev(f), dimension: f.dimension, where: f.where, problem: f.problem, fix: effFix(f) });
for (const cr of critics) for (const f of (cr.findings || [])) if (confirmed(f)) allFindings.push({ source: 'critic:' + cr.critic, severity: effSev(f), dimension: f.dimension, where: f.where, problem: f.problem, fix: effFix(f) });

const order = { blocker: 0, major: 1, minor: 2, polish: 3 };
allFindings.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));

log(`pages reviewed: ${pages.length}; critics: ${critics.length}; confirmed findings: ${allFindings.length}`);

return {
  pagesReviewed: pages.length,
  pageScores: pages.map((p) => ({ route: p.route, score: p.sotaScore, verdict: p.verdict })).sort((a, b) => a.score - b.score),
  counts: {
    blocker: allFindings.filter((f) => f.severity === 'blocker').length,
    major: allFindings.filter((f) => f.severity === 'major').length,
    minor: allFindings.filter((f) => f.severity === 'minor').length,
    polish: allFindings.filter((f) => f.severity === 'polish').length,
  },
  findings: allFindings,
  weakestPages: pages.filter((p) => p.sotaScore < 80).map((p) => ({ route: p.route, score: p.sotaScore, verdict: p.verdict })),
};
