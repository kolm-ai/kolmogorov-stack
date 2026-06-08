export const meta = {
  name: 'kolm-editorial-pass',
  description: 'Remove eyebrow kickers and de-dash 27 secondary pages to match the Obsidian Foil flagship',
  phases: [
    { title: 'Edit', detail: 'one agent per page: eyebrows + dashes, targeted edits only' },
  ],
};

// The 27 secondary pages (flagship index.html is hand-authored and excluded).
const FILES = args && args.length ? args : [
  'public/404.html', 'public/acceptable-use.html', 'public/baa.html', 'public/careers.html',
  'public/changelog.html', 'public/checks.html', 'public/contact.html', 'public/docs.html',
  'public/dpa.html', 'public/enterprise.html', 'public/how-it-works.html', 'public/platform.html',
  'public/pricing.html', 'public/privacy.html', 'public/report.html', 'public/research.html',
  'public/security.html', 'public/security/threat-model.html', 'public/sla.html',
  'public/solutions/ai-vendors.html', 'public/solutions/enterprise-buyers.html', 'public/status.html',
  'public/subprocessors.html', 'public/terms.html', 'public/transparency-log.html',
  'public/trust.html', 'public/verify.html',
];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['file', 'eyebrowsRemoved', 'eyebrowsToStep', 'dashesRewritten', 'dashGlyphsRemaining', 'eyebrowClassRemaining', 'clean', 'notes'],
  properties: {
    file: { type: 'string' },
    eyebrowsRemoved: { type: 'integer', description: 'decorative kicker eyebrows deleted' },
    eyebrowsToStep: { type: 'integer', description: 'ordinal eyebrows converted to span.step__n' },
    dashesRewritten: { type: 'integer', description: 'sentences rewritten to remove a dash glyph' },
    dashGlyphsRemaining: { type: 'integer', description: 'count of em/en-dash glyphs left AFTER your edits (must be 0) — verify with Grep before answering' },
    eyebrowClassRemaining: { type: 'integer', description: 'count of class="eyebrow" left AFTER your edits' },
    clean: { type: 'boolean', description: 'true only if dashGlyphsRemaining===0 and no forbidden content introduced' },
    notes: { type: 'string', description: 'anything notable, or empty' },
  },
};

const RULES = (file) => `You are doing a precise editorial pass on ONE file: \`${file}\` (relative to the repo root C:\\Users\\user\\Desktop\\kolmogorov-stack).

This site is "Obsidian Foil": an austere, monochrome, mono-typeface "signed instrument" aesthetic. The flagship homepage (public/index.html) has ALREADY been redesigned. Your job is to bring THIS one page's copy into line with two hard rules the founder gave: (1) remove the generic-AI "eyebrow" kicker label pattern, and (2) remove every em/en dash. The flagship is your reference for what "done" looks like.

== WHAT THE FLAGSHIP DOES (match it) ==
- Section headers are just a heading. There is NO small kicker label above the <h2>. Example: \`<div class="section__head"><h2>Audit. Sign. Verify.</h2></div>\` — no <p class="eyebrow"> above it.
- Step ordinals use a span, not an eyebrow: \`<span class="step__n">01 · Audit</span>\` sits inside the step, above its <h3>.
- No em dashes or en dashes anywhere. Sentences are rewritten into natural prose using periods, colons, commas, or parentheses — NOT mechanical deletion and NOT an en-dash/hyphen swapped in for an em dash.

== TASK 1 — EYEBROWS ==
Find every \`<p class="eyebrow"...>TEXT</p>\` element in the file.
- If TEXT is an ORDINAL step label — i.e. it starts with a two-digit number then a middot ("01 · Audit", "02 · Sign") OR is "Pillar 01".."Pillar 04" — and it sits inside a step/card above an <h3>: convert the element to \`<span class="step__n">TEXT</span>\` (keep TEXT identical). Do NOT also delete it.
- OTHERWISE (every plain kicker label such as "Legal", "How it works", "The mechanism", "Why it's stuck", "Get unblocked", "Questions?", "Related", "Components", etc.): DELETE the entire \`<p class="eyebrow">…</p>\` element. The heading or context below it carries. If it shared a line with a heading (e.g. \`<div class="section__head"><p class="eyebrow">Keep it current</p><h2>…</h2></div>\`), remove only the <p>, leaving \`<div class="section__head"><h2>…</h2></div>\`.
- Do NOT touch <h4> footer column headers (Product/Solutions/Trust/Company) — those are not eyebrows and stay.

== TASK 2 — DASHES ==
Remove EVERY one of these glyphs from the file, wherever they appear (the <title>, <meta> description/og/twitter, JSON-LD string values, AND visible body copy): the em dash \`—\`, the en dash \`–\`, the entity \`&mdash;\`, the entity \`&ndash;\`.
- Rewrite the surrounding sentence so it reads naturally without any dash. Use a period (split into two sentences), a colon (when the second half explains the first), a comma, or parentheses (for a true aside). Choose by meaning.
- Do NOT substitute an en dash, a hyphen with spaces (" - "), a slash, or a semicolon-as-dash. The goal is dash-free, natural prose.
- Preserve the EXACT meaning and every factual/security claim. Do not soften, strengthen, invent, or drop any claim. If a sentence states what was or wasn't tested, keep that exact scope.
- In number ranges written with an en dash (e.g. "5–10 days", "$25k–50k", "Art.12–14"), rewrite to words: "5 to 10 days", "$25k to $50k", "Articles 12 and 14". Keep the numbers identical.

== DO NOT TOUCH (these hyphens are correct and must stay) ==
Hyphenated compound modifiers (least-privilege, tamper-evident, offline-verifiable, Ed25519-signed, append-only, two-tier, real-time, agent-security, deal-unblocker), URLs/paths (/how-it-works, /solutions/ai-vendors), file/key names, dates (2026-06-07), version numbers, control IDs (SOC 2 CC6, ISO 42001, NIST AI RMF, EU AI Act Art.12, OWASP LLM Top 10, MITRE ATLAS), and code. These ASCII hyphens are NOT dashes — leave them.

== ABSOLUTE CONSTRAINTS ==
- NEVER use the word "honest" or "honesty" in any form. (If you ever need that idea, use "candid", "plainly stated", "verifiable", "Caveats", "Limitations", or "Scope".)
- The ONLY contact address anywhere is dev@kolm.ai. Never introduce any other email.
- NEVER introduce any of these exact substrings (case-sensitive): "pip install kolm", ".kolm bundle", "3B INT4", "Arweave", "On-chain", "Air-gap mode", "WASM runtime", "kolm WASM", "EU AI Act compliant", "Type I evidence available now", "SOC 2 Type II evidence", "Your data never moves", "data never moves", "inside your VPC", "BAA boundary", "PHI never leaves", "HIPAA-ready", "Mobile SDK", "AIUC-1".
- Keep JSON-LD valid (don't break quotes/commas). Keep all attributes, nav, footer, scripts, the verify-widget element and its data-* attributes, every seal SVG, and every class (especially .reveal) byte-for-byte except where a rule above tells you to change it.

== HOW TO WORK ==
1. Read the file.
2. Make changes ONLY with targeted Edit operations (exact old -> new). NEVER rewrite or re-emit the whole file with Write. Touch only the eyebrow elements and the dash sentences. Everything else stays byte-for-byte.
3. When you think you're done, use Grep on this file for the pattern \`—|–|&mdash;|&ndash;\` to confirm ZERO matches remain. If any remain, fix them.
4. Also Grep for \`class="eyebrow"\` and confirm the only ones left (if any) are cases you deliberately judged must stay (there should normally be none).
5. Return the structured report. \`dashGlyphsRemaining\` must be the real post-edit Grep count (0 if you did the job).`;

phase('Edit');

const reports = await parallel(FILES.map((file) => () =>
  agent(RULES(file), { label: 'edit:' + file.replace(/^public\//, ''), phase: 'Edit', schema: SCHEMA })
));

const ok = reports.filter(Boolean);
return {
  totalFiles: FILES.length,
  reported: ok.length,
  notClean: ok.filter((r) => !r.clean || r.dashGlyphsRemaining !== 0).map((r) => ({ file: r.file, dashGlyphsRemaining: r.dashGlyphsRemaining, eyebrowClassRemaining: r.eyebrowClassRemaining, notes: r.notes })),
  eyebrowClassLeft: ok.filter((r) => r.eyebrowClassRemaining > 0).map((r) => ({ file: r.file, n: r.eyebrowClassRemaining })),
  totals: {
    eyebrowsRemoved: ok.reduce((s, r) => s + (r.eyebrowsRemoved || 0), 0),
    eyebrowsToStep: ok.reduce((s, r) => s + (r.eyebrowsToStep || 0), 0),
    dashesRewritten: ok.reduce((s, r) => s + (r.dashesRewritten || 0), 0),
  },
  perFile: ok.map((r) => ({ file: r.file, removed: r.eyebrowsRemoved, toStep: r.eyebrowsToStep, dashes: r.dashesRewritten, remaining: r.dashGlyphsRemaining })),
};
