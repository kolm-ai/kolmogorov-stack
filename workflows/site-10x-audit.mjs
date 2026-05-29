export const meta = {
  name: 'site-10x-audit',
  description: 'Audit every page group for the issue classes the user flagged on the homepage; return a prioritized per-page fix list',
  phases: [{ title: 'Audit' }],
}
const ROOT = 'C:/Users/user/Desktop/kolmogorov-stack'
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['group', 'pages_reviewed', 'findings'],
  properties: {
    group: { type: 'string' },
    pages_reviewed: { type: 'number' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['page', 'issue_class', 'severity', 'detail', 'fix'],
        properties: {
          page: { type: 'string', description: 'file path' },
          issue_class: { type: 'string', enum: ['mobile', 'jargon', 'repetition', 'black-brick-code', 'button-bleed', 'broken-demo', 'broken-link', 'unprofessional', 'tiny-text', 'other'] },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          detail: { type: 'string', description: 'what is wrong, with a line/selector anchor' },
          fix: { type: 'string', description: 'the concrete fix' },
        },
      },
    },
    systemic: { type: 'string', description: 'template-level issues that affect many pages at once (fix the template = fix all)' },
  },
}
const COMMON = `Repo: ${ROOT}. READ-ONLY audit (Grep/Glob/Read). The user 10x'd the HOMEPAGE and flagged these recurring ISSUE CLASSES that
likely repeat across the site — audit YOUR page group for them, MOBILE-FIRST:
- mobile: content condensed/tiny/overflowing/wrapping badly on a phone (check inline styles, missing @media, fixed widths, tiny font-size, long unbroken rows)
- jargon: unexplained insider terms ("surface", etc.), copy that assumes context a visitor lacks
- repetition: the same content/spec shown twice, redundant sections
- black-brick-code: a raw JSON/code block rendered as a giant dark unstyled brick (no wrap, no max-height, overflows)
- button-bleed: button text overflowing its box / color bleed / unreadable contrast
- broken-demo: an interactive element / demo that is broken or renders poorly (esp. mobile)
- broken-link: hrefs to pages that 404 or were removed
- tiny-text: text too small to read (esp. labels, captions, mobile)
- unprofessional: placeholder/TBD copy, typos, stale model versions (e.g. opus-4-7 should be 4-8), broken layout
Report concrete findings with a file + line/selector anchor + the fix. Flag template-level issues in 'systemic' (one fix -> many pages).
Do NOT edit anything. Be specific + prioritized (high severity first). Return ONLY the structured object.`

const GROUPS = [
  { label: 'audit:marketing', prompt: `${COMMON}
GROUP: top marketing/product pages (NOT index.html — the user is handling that). Audit: public/pricing.html, public/wrapper.html,
public/studio.html, public/about.html, public/compare.html, public/foundations.html, public/tui.html, public/what-is-an-ai-compiler.html,
public/kolm-auto-pilot.html. These are the highest-traffic conversion pages — hold them to a professional, mobile-first bar.` },
  { label: 'audit:demo-live', prompt: `${COMMON}
GROUP: the live demo + interactive surfaces. Audit public/demo-live.html DEEPLY (the user said it renders poorly on mobile + the demo
needs improving) + any other interactive/demo pages (grep public/ for 'demo', canvas, playground, calculator widgets). Report exactly what
breaks on mobile + how to make the demo genuinely good. Also check the homepage's /demo-live entry points.` },
  { label: 'audit:verticals', prompt: `${COMMON}
GROUP: vertical microsites + their shared template. Audit public/healthcare.html, public/finance.html, public/legal.html, public/defense.html,
public/defense-v2.html, public/eu-sovereign.html, public/insurance.html, public/education.html, public/healthcare-v2.html + any wave889
vertical pages. These share a template — flag the systemic template issues (one fix -> all verticals).` },
  { label: 'audit:docs-template', prompt: `${COMMON}
GROUP: docs pages + their generator template (hundreds of pages share it). Read 4-6 representative public/docs/*.html + the docs template
in public/docs-shell.{css,js} + scripts that generate docs. The bulk of the site is docs — find the TEMPLATE-level mobile/code-block/jargon
issues so one fix cascades. Pay special attention to black-brick code blocks (docs are full of code) + mobile readability.` },
  { label: 'audit:account', prompt: `${COMMON}
GROUP: account/console pages + template. Read 4-6 representative public/account/*.html + their shared chrome. Flag systemic mobile +
button-bleed + tiny-text + broken-link issues. These are logged-in surfaces — they must be usable on a phone.` },
]
phase('Audit')
const res = await parallel(GROUPS.map((g) => () => agent(g.prompt, { label: g.label, phase: 'Audit', schema: SCHEMA, agentType: 'Explore' })))
const clean = res.filter(Boolean)
const high = []
for (const r of clean) for (const f of (r.findings || [])) if (f.severity === 'high') high.push({ group: r.group, ...f })
log(`Site audit: ${clean.length}/5 groups. ${high.length} high-severity findings.`)
return { groups: clean, high }
