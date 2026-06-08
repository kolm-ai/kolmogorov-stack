export const meta = {
  name: 'kolm-flagship-critique',
  description: 'Multi-lens judge panel on the rebuilt kolm.ai flagship (desktop + mobile screenshots + HTML + BRIEF): five expert lenses score and find faults, findings are adversarially verified, and a single prioritized, deduped fix list is returned for the main loop to execute.',
  phases: [
    { title: 'Critique', detail: 'five lenses: senior visual designer, conversion strategist, enterprise security-buyer persona, a11y+perf, brand+voice' },
    { title: 'Verify', detail: 'adversarially verify each blocker/major finding before it reaches the fix list' },
    { title: 'Synthesize', detail: 'dedupe + prioritize into one executable punch list + a verdict' },
  ],
};

// args: { briefPath, htmlPath, shots: { desktop, mobile }, palette } (absolute paths)
const A = args || {};
const BRIEF_PATH = A.briefPath || 'C:\\Users\\user\\Desktop\\kolmogorov-stack\\docs\\redesign\\BRIEF.md';
const HTML_PATH = A.htmlPath || 'C:\\Users\\user\\Desktop\\kolmogorov-stack\\public\\index.html';
const SHOT_DESKTOP = (A.shots && A.shots.desktop) || 'C:\\Users\\user\\Desktop\\kolmogorov-stack\\tmp\\audit-shots\\home.desktop.png';
const SHOT_MOBILE = (A.shots && A.shots.mobile) || 'C:\\Users\\user\\Desktop\\kolmogorov-stack\\tmp\\audit-shots\\home.mobile.png';

const STANDARD = `THE STANDARD (the bar this flagship must clear):
- Audience: a Series-A AI-startup founder/CTO with ONE $100-500k enterprise deal STALLED 4-8 weeks in the buyer's security review. kolm sells a fast fixed-fee audit ending in a cryptographically-signed (Ed25519) evidence report that unblocks the deal. Positioning = DEAL-UNBLOCKER, not a compliance vendor.
- The deeper viewer is an ELITE security researcher (the named co-signers). The site cannot look amateur, templated, or like security theater for one second.
- Palette = "Verified": near-white paper #F7F8F6, near-black ink #0F1411, ONE signal green #11875A reserved for primary CTAs + the verified/pass state. No other colour. No holographic/foil/gradient identity.
- Type = mono-forward: the ENTIRE site is Spline Sans Mono (one family, weights 400/500/600). It must feel premium, editorial, and iconic, NOT like a code listing or terminal.
- The founder's explicit demands: flawless spacing, design, aesthetics, BACKDROP, logic, and CONVERSION strategy. Copy must be terse and simplified (the prior copy was "too wordy"). A genuinely incredible, iconic, launch-ready site.
HARD RULES (a violation is a finding): no em/en dashes anywhere; never the word honest/honesty; only contact dev@kolm.ai; no generic-AI "eyebrow" kicker labels; preserve every factual/security claim and its exact scope (e.g. "injection tested and reported, not warranted"). The fail-open reveal and the two-tier verify widget must stay intact.`;

const FINDINGS_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['lens', 'score', 'verdict', 'strengths', 'findings'],
  properties: {
    lens: { type: 'string' },
    score: { type: 'number', description: '0-100, how close to SOTA + launch-ready for THIS lens' },
    verdict: { type: 'string', description: 'one-sentence summary judgment' },
    strengths: { type: 'array', items: { type: 'string' }, description: 'what already works and must NOT be lost in fixes' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'severity', 'where', 'problem', 'fix'],
        properties: {
          id: { type: 'string', description: 'short stable slug, e.g. hero-lede-too-long' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor', 'polish'] },
          where: { type: 'string', description: 'exact location: section name + desktop/mobile' },
          problem: { type: 'string', description: 'what is wrong and why it falls short of the standard' },
          fix: { type: 'string', description: 'concrete, buildable instruction (exact px/copy/structure where possible)' },
        },
      },
    },
  },
};

const VERDICT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['id', 'isReal', 'severityConfirmed', 'reasoning', 'fix'],
  properties: {
    id: { type: 'string' },
    isReal: { type: 'boolean', description: 'true only if this is a genuine defect against the standard, not taste noise or a misread of the screenshot' },
    severityConfirmed: { type: 'string', enum: ['blocker', 'major', 'minor', 'polish', 'rejected'] },
    reasoning: { type: 'string', description: 'why it is real (or why it is rejected). Be skeptical; reject if uncertain or if it would harm a stated strength.' },
    fix: { type: 'string', description: 'the refined, buildable fix instruction' },
  },
};

const LENSES = [
  { id: 'visual-designer', prompt: `You are a world-class product/brand designer (Linear/Stripe/Vercel caliber). Judge this flagship purely on visual craft: section rhythm and whitespace ratios, type scale + weight discipline, hairline/border craft, card/plate treatment, the backdrop, alignment, optical balance, micro-interaction restraint, and whether a light all-mono page reads premium and iconic vs like a code block or a template. Be exacting and specific to what you SEE in the screenshots.` },
  { id: 'conversion-strategist', prompt: `You are a B2B conversion strategist for technical/security products. Judge the flagship on conversion logic: is the value proposition legible in 5 seconds, is proof above the fold, is there ONE clear primary CTA path, is the section sequence ordered for a stalled-deal founder, is the verify-demo positioned as the hero proof, are objections (liability/scope, credibility, "is this theater") handled, is anything redundant or wordy enough to lose the reader. Cite exact sections.` },
  { id: 'security-buyer', prompt: `You ARE a skeptical enterprise CISO / security-review lead AND, separately, an elite security researcher being asked to co-sign. React to the flagship as both. Does it earn trust or trip a "vendor theater" alarm? Are the cryptographic claims precise and credible? Is the scope language correct and not overclaiming? Does anything read as naive, marketing-fluffy, or technically wrong for an audience that does this for a living? Flag any claim that an expert would scoff at.` },
  { id: 'a11y-perf', prompt: `You are an accessibility + front-end performance lead. Judge contrast of every ink grey and the green on the near-white paper (call out anything that likely fails WCAG AA), focus-visible affordances, tap-target sizing on the 390px mobile shot, heading order, mobile reflow (overflow, cramped tables/grids), motion restraint, and any layout that breaks or crowds at mobile width. Use the mobile screenshot hard.` },
  { id: 'brand-voice', prompt: `You are an elite technical copy + brand editor (Stripe/Linear voice). Judge every line of copy visible: terse and declarative vs wordy and hedged, scannable, lead-with-the-noun, parallel structure, zero filler/hype. HARD-SCAN for rule violations: any em/en dash (- is fine, the long dash is not), the word honest/honesty, any eyebrow kicker label, any contact other than dev@kolm.ai, and any dropped or softened factual/security claim or scope statement. Quote the offending text.` },
];

phase('Critique');
const critiques = (await parallel(LENSES.map((l) => () =>
  agent(
    `${l.prompt}\n\n${STANDARD}\n\nYou are reviewing the rebuilt kolm.ai HOMEPAGE (flagship). Read the design BRIEF, the page HTML, and BOTH screenshots, then return your structured critique. Score honestly against the SOTA + launch-ready bar; do not be generous. Every finding must be specific and buildable.\n\nBRIEF: ${BRIEF_PATH}\nHTML: ${HTML_PATH}\nDESKTOP screenshot: ${SHOT_DESKTOP}\nMOBILE screenshot: ${SHOT_MOBILE}\n\nUse the Read tool on the BRIEF, the HTML, and BOTH image files (Read renders images visually). Base every visual finding on what you actually see in the screenshots.`,
    { label: 'critique:' + l.id, phase: 'Critique', schema: FINDINGS_SCHEMA },
  )
))).filter(Boolean);

// Pull every blocker/major finding for adversarial verification; minors/polish pass straight through.
const toVerify = [];
const passThrough = [];
for (const c of critiques) {
  for (const f of (c.findings || [])) {
    const row = { ...f, lens: c.lens };
    if (f.severity === 'blocker' || f.severity === 'major') toVerify.push(row);
    else passThrough.push(row);
  }
}

phase('Verify');
const verified = (await parallel(toVerify.map((f) => () =>
  agent(
    `You are an adversarial design-QA verifier. A reviewer (lens: ${f.lens}) raised this finding on the kolm.ai flagship. Your job is to REFUTE it unless it is genuinely real and correctly severed. Default to rejecting taste-only noise, misreads of the screenshot, or fixes that would damage a real strength. Confirm ONLY a true defect against the standard.\n\n${STANDARD}\n\nFINDING:\n- id: ${f.id}\n- severity claimed: ${f.severity}\n- where: ${f.where}\n- problem: ${f.problem}\n- proposed fix: ${f.fix}\n\nRead the HTML and BOTH screenshots to check it against reality, then return your verdict.\nHTML: ${HTML_PATH}\nDESKTOP: ${SHOT_DESKTOP}\nMOBILE: ${SHOT_MOBILE}\nUse the Read tool on the HTML and both image files before deciding.`,
    { label: 'verify:' + f.id, phase: 'Verify', schema: VERDICT_SCHEMA },
  ).then((v) => (v ? { ...v, lens: f.lens, where: f.where } : null))
))).filter(Boolean);

const confirmed = verified.filter((v) => v.isReal && v.severityConfirmed !== 'rejected');

phase('Synthesize');
const synth = await agent(
  `You are the design lead consolidating a critique of the kolm.ai flagship into ONE executable punch list. Below are: (a) the per-lens scores + strengths, (b) the adversarially CONFIRMED blocker/major findings, and (c) the minor/polish findings that passed through without verification. Dedupe overlapping items, resolve conflicts (favor the standard + protect stated strengths), and order by impact.\n\n${STANDARD}\n\nLENS SCORES + STRENGTHS:\n${JSON.stringify(critiques.map((c) => ({ lens: c.lens, score: c.score, verdict: c.verdict, strengths: c.strengths })), null, 2)}\n\nCONFIRMED blocker/major findings:\n${JSON.stringify(confirmed, null, 2)}\n\nMinor/polish findings (unverified):\n${JSON.stringify(passThrough, null, 2)}\n\nReturn GitHub-flavored markdown with exactly these parts:\n1. **Verdict** — is the flagship SOTA + launch-ready yet? one paragraph + the mean and per-lens scores.\n2. **Protect** — the strengths that must NOT regress while fixing.\n3. **Punch list** — a single ordered, deduped table/list of fixes: each row = [priority blocker/major/minor/polish] [where] [precise buildable fix]. Numeric/exact where possible. This is what an engineer will execute verbatim.\n4. **Stop test** — the crisp condition under which the next render is good enough to lock the flagship.\nNo em/en dashes in your output. Be decisive.`,
  { label: 'synthesize-punchlist', phase: 'Synthesize' },
);

const mean = critiques.length ? Math.round(critiques.reduce((s, c) => s + (c.score || 0), 0) / critiques.length) : 0;
return {
  meanScore: mean,
  perLens: critiques.map((c) => ({ lens: c.lens, score: c.score, verdict: c.verdict })),
  confirmedCount: confirmed.length,
  passThroughCount: passThrough.length,
  confirmed,
  passThrough,
  punchlist: synth,
};
