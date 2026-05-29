export const meta = {
  name: 'site-10x-fix',
  description: 'Fix the site-wide issue classes from the audit — template CSS (cascades to 100s of pages) + demo-live + marketing, disjoint owners',
  phases: [{ title: 'Fix' }, { title: 'Verify' }],
}
const ROOT = 'C:/Users/user/Desktop/kolmogorov-stack'
const R = { type:'object', additionalProperties:false, required:['owner','status','self_check'], properties:{ owner:{type:'string'}, status:{type:'string',enum:['complete','partial','failed']}, changes:{type:'array',items:{type:'string'}}, self_check:{type:'string'}, issues:{type:'string'} } }
const C = `Repo: ${ROOT}. You OWN only the file(s) named — edit ONLY those. MOBILE-FIRST is the bar (phones down to 360px). Make changes
ADDITIVE where possible (new @media blocks, not rewrites) so existing desktop layout + page-structure tests (W272 verticals, W374 docs,
W409i account, etc.) stay green. Keep cool-slate tokens (no warm/brown). After editing, verify (node --check for .js; for CSS, grep your
new rules + confirm balanced braces) AND run the most relevant test family if quick. Report exact changes + self-check. Return ONLY the object.`

const OWNERS = [
  { label: 'fix:verticals-css', prompt: `${C}
OWN: public/wave889-vertical.css (the shared template for ALL vertical microsites — healthcare/finance/legal/defense/eu-sovereign/insurance/
education/+v2). Audit findings: only 720px+880px breakpoints (no 480/360 phone coverage); 11px label text (.v-eyebrow/.v-card .ctag/.v-compl
.label) too small; .v-compare table has min-width:740px -> horizontal overflow on every phone; grids minmax(280-300px,1fr) break <320px.
FIX (additive @media): add (max-width:480px) + (max-width:360px) blocks that (1) collapse all multi-col grids to 1 column, (2) bump 11px
labels to >=12.5px, (3) wrap .v-compare table in overflow-x:auto OR set display:block;overflow-x:auto + nowrap cells + reduce min-width so it
scrolls cleanly, (4) shrink section padding. Don't touch desktop rules. One fix -> all ~10 verticals.` },

  { label: 'fix:docs-template', prompt: `${C}
OWN: public/docs-shell.css AND scripts/wave887-docs-generator.cjs (the generator's inline CSS template). Hundreds of docs pages share these.
Audit: (1) docs <pre> code blocks have overflow-x:auto but NO max-height -> a long JSON renders as a giant 'black brick'; add max-height
(e.g. 460px) + scroll + a touch of contrast so it reads as a code card not a wall; (2) tables (table{max-width:920px}) have no mobile @media
-> overflow on phones; add overflow-x:auto wrapping + responsive; (3) no mobile breakpoint below 880px for the content column -> add
(max-width:560px) tightening padding + font. Apply the SAME fixes to BOTH docs-shell.css AND the generator's embedded CSS template (so newly
generated docs inherit them). Additive @media only. Balanced braces.` },

  { label: 'fix:account-css', prompt: `${C}
OWN: the SHARED account/console CSS template. First GREP public/account/ for the shared style block / .acct-shell grid (it may be an inline
<style> repeated per page OR a linked CSS — find the single source; if it's inline-duplicated, fix the canonical generator/template if one
exists, else fix the most-included shared CSS file). Audit: .acct-shell is a 240px sidebar + 1fr grid with a breakpoint only at 880px;
hardcoded input min-widths (160-520px) overflow phones; .ktable font 10.5-12px too small; sticky sidebar lacks mobile padding. FIX (additive
@media max-width:560px): sidebar stacks above content (grid-template-columns:1fr), inputs/fields max-width:100%, .ktable font >=12.5px +
horizontal scroll wrapper, sane mobile padding. If account pages each carry their own inline <style>, identify the generator
(scripts/*account* or similar) and fix the template; report if there is no single source (then it's a known limitation to note).` },

  { label: 'fix:demo-live', prompt: `${C}
OWN: public/demo-live.html (+ you MAY read public/demo-90s.html / demo.html but only edit demo-live.html). The user said /demo-live renders
BADLY on mobile + the demo needs improving. Audit findings (all in demo-live.html): .stage rigid 3-col grid (~900px min) doesn't truly
collapse <1000px; .run-cmd code max-width:62vw overflows long commands (add word-break/overflow-wrap + smaller vw); .end-card .stats
repeat(4,1fr) unreadable <480px (-> 1col); .bchip beat buttons 10px font + min-width:64px overflow on 320px; .bench-grid 3-col cramped.
FIX: make the demo genuinely good MOBILE-FIRST — below 1000px use a single-column stacked flow (stage -> block/flex-column), wrap long
commands, stats -> 1 col <480px, bigger touch-target beat chips that fit, readable type throughout. Keep the desktop experience intact.
Verify the HTML parses (node -e to check tag balance) + that the demo's JS hooks (data-ks-* / ids) are untouched.` },

  { label: 'fix:marketing', prompt: `${C}
OWN: public/pricing.html, public/studio.html, public/compare.html, public/tui.html (ONLY these four). Fixes:
(1) Stale model version: replace 'claude-opus-4-7' -> 'claude-opus-4-8' wherever it appears in these files (current model is Opus 4.8).
(2) public/compare.html: .cmp-matrix has min-width:1080px -> horizontal scroll with no mobile rule; add @media (max-width:560px) making the
matrix scroll cleanly (overflow-x wrapper) or shrink font/padding so it's readable on a phone; bump any 11px heading to >=12px.
(3) public/tui.html: .grid6 is repeat(3,1fr) -> only drops to 2 at 760px, no 1-col fallback; add @media (max-width:560px){.grid6{grid-template-columns:1fr;}}.
Additive @media; don't change desktop. node --check is N/A (HTML) — verify tag balance + grep your edits. Run tests/wave226 or wave339 if relevant.` },
]
phase('Fix')
const fixed = await parallel(OWNERS.map((o)=>()=>agent(o.prompt,{label:o.label,phase:'Fix',schema:R})))
const ok = fixed.filter(Boolean)
log(`Site fix: ${ok.map(b=>`${(b.owner||'?').split('/').pop()}=${b.status}`).join(', ')}`)

phase('Verify')
const VS={type:'object',additionalProperties:false,required:['verdict','checks'],properties:{verdict:{type:'string',enum:['green','issues']},checks:{type:'array',items:{type:'object',additionalProperties:false,required:['name','pass','detail'],properties:{name:{type:'string'},pass:{type:'boolean'},detail:{type:'string'}}}},failures:{type:'string'}}}
const verify = await agent(`The site-10x fix just edited: public/wave889-vertical.css, public/docs-shell.css, scripts/wave887-docs-generator.cjs,
shared account CSS, public/demo-live.html, and public/{pricing,studio,compare,tui}.html. Verify:
(1) braces balanced in each edited .css (grep count { vs }); (2) node --check scripts/wave887-docs-generator.cjs; (3) no 'claude-opus-4-7'
remains in pricing/studio/compare.html (grep -> 0); (4) the new @media blocks exist (grep 'max-width: *480\\|max-width: *560\\|max-width: *360'
in the edited CSS); (5) run the page-structure test families that could regress: node --test tests/wave272-vertical-microsites.test.js
tests/wave374-docs.test.js tests/wave339-production-verdict.test.js — report pass/fail. Report each check + exact failures. Return ONLY the object.`, {label:'fix:verify',phase:'Verify',schema:VS})
return { fixed: ok, verify }
