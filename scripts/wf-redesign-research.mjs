export const meta = {
  name: 'kolm-redesign-research',
  description: 'Research-driven design brief for the kolm.ai "Verified" redesign: parallel expert research -> one synthesized, executable BRIEF (tokens, type/spacing scale, components, backdrop, copy system, per-page structure, conversion model)',
  phases: [
    { title: 'Research', detail: 'parallel experts: SOTA aesthetics, mono-on-light craft, B2B-security conversion, copy minimalism, backdrop+green system, a11y+IA' },
    { title: 'Synthesize', detail: 'one architect folds all research into docs/redesign/BRIEF.md content' },
  ],
};

const LOCKED = `LOCKED INPUTS (do not question, design AROUND these):
- Product: kolm sells a fast fixed-fee "Agent Security-Review Readiness" audit that ends in a cryptographically-signed (Ed25519) evidence report a startup founder hands to an enterprise buyer's security-review group to unblock a stalled deal. Positioning = DEAL-UNBLOCKER, not a compliance vendor. Buyer = Series-A AI-startup founder/CTO with ONE $100-500k deal stuck 4-8 weeks in security review.
- Type is MONO-FORWARD: the ENTIRE site is set in Spline Sans Mono (one family, weights 400/500/600). This is fixed and loved. Design must make a light, all-monospace site feel premium and iconic, not like a code listing.
- Palette = "Verified" (light + signal green): paper #F7F8F6 near-white, ink #0F1411 near-black, accent #11875A signal green used ONLY for primary CTAs and the verified/pass state (green = pass/verified semantics), hairline #E2E5E0. No other colour. No holographic/foil/gradient identity.
- The founder's verdict that triggered this: the prior dark monochrome "isn't nice", and the site's structure + copy "drifted off state of the art, too wordy, not simplified". They want flawless spacing, design, aesthetics, BACKDROP, logic, and CONVERSION strategy; a genuinely incredible, iconic, launch-ready site. The bar is elite security researchers.`;

const RESEARCH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['topic', 'keyFindings', 'patterns', 'references', 'pitfalls', 'directives'],
  properties: {
    topic: { type: 'string' },
    keyFindings: { type: 'array', items: { type: 'string' }, description: '6-12 sharp, specific findings (not platitudes)' },
    patterns: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'whatItIs', 'howToApply'], properties: { name: { type: 'string' }, whatItIs: { type: 'string' }, howToApply: { type: 'string', description: 'concrete instruction for THIS kolm site' } } } },
    references: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'whyItMatters'], properties: { name: { type: 'string' }, url: { type: 'string' }, whyItMatters: { type: 'string' } } } },
    pitfalls: { type: 'array', items: { type: 'string' }, description: 'mistakes that would make this look amateur — what to avoid' },
    directives: { type: 'array', items: { type: 'string' }, description: 'final, numeric-where-possible, copy-pasteable design directives for the brief (e.g. exact px, ch, ratios, hex, timings)' },
  },
};

const TOPICS = [
  { id: 'sota-aesthetics', prompt: `You are a world-class product/brand designer. Research the current (2025-2026) state of the art in landing-page aesthetics for developer + security infrastructure companies. Look hard at how the best sites feel premium and iconic: Linear, Stripe, Vercel, Resend, Railway, Cursor, Clerk, Planetscale, Anthropic, Mintlify, Vanta, and any 2026 newcomers you know. If you have web tools, use WebSearch/WebFetch to ground and update your references. Extract WHAT specifically makes them SOTA: section rhythm, whitespace ratios, type scale + weight discipline, restraint, hairline/border craft, card/plate treatment, micro-interaction taste, hero composition, how they avoid looking like a template. Translate every finding into a concrete directive for a LIGHT, all-MONOSPACE security-evidence site.` },
  { id: 'mono-on-light', prompt: `You are a typographer. The whole kolm site is set in ONE monospace family (Spline Sans Mono) on a near-white canvas. Research and reason about how to make an all-monospace, light site feel expensive, editorial, and iconic rather than like a terminal or a code block. Cover: type scale (display vs body sizes in a mono), weight discipline (400/500/600 only), letter-spacing/tracking per size (mono needs negative tracking on big display, positive on small caps labels), line-height, measure (max ch per line for mono readability), tabular-nums for data, where mono shines (data, labels, code, seals) vs where it strains (long body prose) and how to mitigate, faux-hierarchy via size/weight/color not family. Reference sites/brands that use mono well. Give exact numbers (px/em/ch) as directives.` },
  { id: 'conversion-structure', prompt: `You are a B2B conversion strategist for technical/security products. The buyer is a Series-A AI-startup founder/CTO with one big enterprise deal STALLED in security review; kolm unblocks it with a signed evidence report. Research the highest-converting landing structures for this audience. Define the exact homepage section sequence (hero -> proof -> mechanism -> framework mapping -> social proof -> pricing teaser -> final CTA, or better), the single primary CTA strategy (what verb, where, how many CTAs, primary vs secondary), how to put PROOF above the fold (the interactive verify demo as the hero proof), objection handling (liability/scope, credibility gate, "is this theater"), trust signals that work without big logos, and the conversion logic for the key secondary pages (/pricing, /how-it-works, /verify, /security, /enterprise, /contact). Give concrete, page-level directives. Use web research on dev-tool/security conversion if available.` },
  { id: 'copy-minimalism', prompt: `You are an elite technical copywriter (think Stripe/Linear voice). The founder says the current copy is TOO WORDY and not simplified. Research and codify a COPY SYSTEM to cut it to the bone while keeping every factual/security claim. Cover: the voice (terse, declarative, instrument-grade, candid; example flagship line "The deal isn't lost. It's in security review."), headline patterns, how to cut a paragraph to one or two lines, banning hype/hedging/filler, scannability (lead with the noun/number), parallel structure, when a list beats prose, sentence length targets, and exact before/after rewrites of 4-6 typical wordy security-site sentences. HARD RULES the copy must obey: no em/en dashes; never the word honest/honesty; only contact dev@kolm.ai; no eyebrow kicker labels; preserve claim scope (e.g. "tested and reported, not warranted"). Deliver a tight set of copy directives + a voice rubric.` },
  { id: 'backdrop-green', prompt: `You are a visual systems designer. Two jobs. (1) BACKDROP: the founder explicitly wants a flawless, premium BACKDROP (not a flat white page) for a light near-white site. Research tasteful, performant, NON-gaudy background treatments used by SOTA sites on light: ultra-subtle dot/grid matrices, faint noise/grain, soft single-radial wash, hairline section framing, sticky gradient masks. Specify EXACTLY one or two layered, restrained treatments (with CSS approach, opacity, size, and a prefers-reduced-motion stance) that fit a "signed instrument / cryptographic ledger" brand without looking busy. (2) GREEN ACCENT SYSTEM: define how to ration a single signal-green (#11875A) on a light site so it reads as PASS/VERIFIED, never garish: where it appears (primary button, verified seal/state, focus ring, one hairline accent, links?), exact tints/shades needed (hover, pressed, soft bg fill, border, disabled), and AA contrast checks of #11875A on #F7F8F6 and white-on-#11875A. Give exact hex + usage directives.` },
  { id: 'a11y-ia', prompt: `You are an accessibility + information-architecture lead. Two jobs. (1) A11Y on light: verify/define contrast for ink greys on #F7F8F6 (specify the exact ink, ink-2, ink-3, ink-faint hex that pass AA for their use), focus-visible styling, hit-target sizing (>=44px) for mono buttons/nav, reduced-motion coverage, semantic heading order, and mobile reflow rules at 390px (tables, grids, nav). (2) INFORMATION ARCHITECTURE: for a 28-page security-evidence site, specify the MINIMUM right content + structure for each important page so none feels thin or wordy: / (flagship), /how-it-works, /verify, /security, /security/threat-model, /trust, /enterprise, /pricing, /report, /checks, /research, /contact, /platform, /docs, /changelog, /status, and the legal set (/privacy /terms /dpa /baa /sla /acceptable-use /subprocessors /transparency-log /careers /404 /solutions/*). Give a one-line structure spec per page (sections in order) tuned to be simple, scannable, and conversion-aware.` },
];

phase('Research');
const research = (await parallel(TOPICS.map((t) => () =>
  agent(`${t.prompt}\n\n${LOCKED}\n\nReturn the structured research object. Be specific and numeric. Every directive must be directly actionable in CSS/HTML/copy for THIS site.`,
    { label: 'research:' + t.id, phase: 'Research', schema: RESEARCH_SCHEMA })
))).filter(Boolean);

phase('Synthesize');
const synthPrompt = `You are the design architect for the kolm.ai "Verified" redesign. Below is parallel research from six experts (aesthetics, mono-on-light, conversion, copy, backdrop+green, a11y+IA). Fold ALL of it into a SINGLE, decisive, executable DESIGN BRIEF in GitHub-flavored Markdown that an engineer can build the entire site from with zero further questions. Do not hedge or present options; make the calls.

${LOCKED}

RESEARCH (JSON):
${JSON.stringify(research, null, 2)}

Produce the brief with EXACTLY these sections, each concrete and numeric where possible:
1. **North star** — one paragraph: the feeling + the one-line design thesis for a light, all-mono, signed-evidence site.
2. **Color tokens** — the full token set in hex, derived from the locked palette: paper, paper-2, ink, ink-2, ink-3, ink-faint, line, line-2, accent (#11875A), accent-deep, accent-soft (bg fill), accent-tint, accent-edge (border), plus a "void/attention" neutral for the tampered/not-verified state (a desaturated red-grey, NOT alarm-red, NOT green). Note AA pass/fail for each text use.
3. **Type scale** — exact sizes (clamp where useful), weights, letter-spacing, line-height for h1/h2/h3/lede/body/label/mono-data, and the max measure (ch). Rules for making mono feel editorial.
4. **Spacing & layout** — the spacing scale (px), max content width, section padding rhythm, grid rules, and the vertical-rhythm principle.
5. **Backdrop** — the exact 1-2 layered background treatments (CSS approach, opacity, sizes, reduced-motion stance).
6. **Components** — concrete styling rules for: nav, buttons (primary green / secondary ghost), cards/plates, hairline rules, the seal/verified state (now green, foil retired), tables, pricing tiers, the verify-widget shell, footer, the §/step ordinal markers. Specify the green-rationing law.
7. **Copy system** — the voice rubric + 6 hard directives + 5 before/after rewrites. Restate the banned-content rules.
8. **Conversion model** — the homepage section sequence (ordered), the primary-CTA strategy, proof-above-the-fold plan, objection handling, and the CTA/logic for each key secondary page.
9. **Per-page structure spec** — a one-line ordered-sections spec for every important page (use the IA research).
10. **Definition of done** — a crisp checklist that, if all true, means the site is SOTA + launch-ready.

Return ONLY the markdown brief (it will be written verbatim to docs/redesign/BRIEF.md). Make it tight, opinionated, and buildable. No em/en dashes in the brief itself.`;

const brief = await agent(synthPrompt, { label: 'synthesize-brief', phase: 'Synthesize' });

return { topics: research.length, research, brief };
