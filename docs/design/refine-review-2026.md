# Refine Review 2026 — Triage Backlog (post P0)

Source: six adversarial design/wiring reviews (grid-gone, contrast, nav-consistency,
bleed-energy, wiring-regress). This file tracks the **remaining** P1/P2 items after the
P0 fixes were applied. Date: 2026-06-14.

## P0 — APPLIED (not in this backlog, listed for context)

1. **15 site-test failures from `data-nav` regex** (wiring BREAK 1). Two hardcoded
   `/<header class="nav">/` matchers in `tests/site.test.js` (lines 250 and 562) failed
   because every rebuilt page now ships `<header class="nav" data-nav>`. Relaxed both to
   `/<header class="nav"[ >]/`. Result: `site.test.js` 12/27 → 27/27.
2. **`--sheet-accent` AA regression** (bleed-energy #1). The legacy compat `:root` block
   re-declared `--sheet-accent:#0B7A4C`, silently overriding the AA-corrected
   `#0A6E45` (5.4:1 on paper) at later specificity. Deleted the duplicate so the
   accessible value wins. This is the on-paper "In spec" verdict color on every artifact.
3. **Deleted `.nav__links a` / `.nav__icon` styling broke shared-stylesheet nav**
   (wiring BREAK 3 + BREAK 2). Audit-host pages (audit/verify/spec/checks/report/etc.)
   and `/docs/api.html` use bare `<a>` children of `.nav__links` and load the same
   `/kolm-2026.css`; the deleted rules left them unstyled (full-ink links, no tap target,
   no status-button box). Restored a scoped baseline: `.nav__links>a:not(.nav__top)...`
   plus `.nav__icon`, which does NOT touch the canonical main nav (it uses `.nav__top`).

> Note: dead `data-nav` attribute (31 files) was intentionally KEPT rather than stripped —
> it is harmless, no JS reads it, and relaxing the test regex is far lower-risk than
> editing 31 HTML files. Re-evaluate if a future nav-JS hook wants to consume it.

---

## P1 — High value, should be scheduled next

### P1-1 — `spec.html` / `verify.html` wear legacy audit chrome (nav-consistency)
The canonical main nav on all 30 main pages links to `/spec` (Platform dropdown) and
`/verify` (Developers dropdown). Both target pages use the OLD audit-style header
(`<header class="nav">` without `data-nav`, brand `kolm.ai`, link set
`How it works / What we test / Pricing / Trust / Docs`, CTAs "Verify a report" /
"Run the free scan", no mega-menus, no Operational pill).

**Why this is P1 not P0:** on the **main host**, `/spec` and `/verify` are in
`server.js` `AUDIT_HOST_ONLY_ROUTES` and **302-redirect to `audit.kolm.ai`** (server.js:213-217).
So a main-host user clicking Spec/Verify lands on the audit subdomain by design — the
audit chrome there is arguably the intended audit-subsite shell, not drift. The drift is
real but it is a *cross-domain handoff* question, not an unstyled-page break, and the P0
CSS baseline restore already keeps those audit-shell navs from rendering unstyled.

**Decision needed:** either (a) accept audit chrome on audit.kolm.ai/spec and
audit.kolm.ai/verify as intentional (then this is closed, not a defect), or (b) if these
pages should ever serve on the main host with canonical chrome, replace their
`<header class="nav">…</header>` with the canonical `data-nav` header from `pricing.html`
and set `aria-current="page"` appropriately.

Files: `public/spec.html` (header line 70), `public/verify.html` (header line 102).

### P1-2 — `/docs/api.html` generator still emits old nav markup (wiring BREAK 2)
`scripts/build-api-ref.cjs:738-746` emits `nav__links` bare-anchor links, `nav__icon`,
and `nav__cta is-solid`. The P0 CSS baseline restore now styles these so the page is no
longer unstyled, BUT the generated page still carries the OLD nav shape (no mega-menu,
no `data-nav`, stale `is-solid` toggle that nothing drives). For consistency, regenerate
`public/docs/api.html` from a template that emits the canonical `data-nav` mega-menu nav,
and update the api-ref nav assertion in `site.test.js` (~line 737) to match the new markup.
Currently that test is green only because api.html kept the stale markup.

### P1-3 — `.field` CSS redefinition vs audit WebGL field (wiring BREAK 4)
The redefined `.field` adds `overflow:hidden` + `mask-image` clip to `--field-fade:84%`
and phosphor `::before/::after` gradients. Audit pages mount `<div class="field"><canvas>`
driven by `kolm-field.js`. The WebGL canvas still paints (negative-z pseudos sit behind),
but it is now clipped/masked at 84% where it previously bled full-bleed, and the new CSS
gradients double up behind it. Decide: scope the new phosphor `.field` to main-site only
(e.g. `.t-marketing .field`) so audit WebGL fields keep full-bleed, OR confirm the masked
look is acceptable on audit pages. `kolm-2026.css:605` keeps a `.field canvas` rule
commented "legacy canvas slot, harmless" — verify it truly is on audit hosts.

### P1-4 — Duplicate Calibration Sweep on 9 pages (wiring BREAK 5)
The new JS sweep in `kolm-2026.js:46-65` (observes `[data-sweep] .artifact`) duplicates an
inline `<script>` still present on 9 pages (index, platform, how-it-works, capabilities,
compare, compiler-product, enterprise, integrations, runtimes), e.g. `index.html:437-463`.
Both toggle `.is-sealed` and animate `[data-val]` opacity on the same artifact with
overlapping timers — a redundant double-animation / flicker race. End-state converges
(self-healing), so not a hard break. Remove the inline `<script>` blocks (preferred, now
that the JS sweep is global) or remove the JS sweep.

### P1-5 — `.pill--idle` latent AA failure (contrast)
`kolm-2026.css:358` sets readable ~9.5px text to `--accent-idle` (#23493B, ~1.98:1 on the
dark surface) — a hard AA failure. It passes today ONLY because no page uses `.pill--idle`
(grep: 0 occurrences). If any future page adds `class="pill pill--idle"` it ships an
inaccessible label. Fix proactively: switch the `.pill--idle` text color to `--ink-3`,
mirroring the already-correct `.badge--idle` / `.chip--idle`.

---

## P2 — Low priority / cosmetic / robustness

### P2-1 — Enterprise readiness `.prow` middle span lacks `min-width:0` (bleed-energy #2)
`enterprise.html:292-295` middle text span relies on `.plate--rows{overflow:hidden}` to
avoid pushing `.prow__r` out. Belt-and-suspenders: add `min-width:0` (and `flex:1`) to that
middle span so a long string can never shove the right column.

### P2-2 — Pricing 6-tiers-in-4-col leaves two empty trailing tracks on wide screens (bleed-energy #3)
`pricing.html:141-221`, grid `repeat(4,1fr)`: tiers 5-6 sit left-aligned under 1-4 with
two empty trailing tracks (whitespace, not rendered cards — not broken). A 3-col or 6-col
desktop arrangement would read more deliberate. Cosmetic only.

### P2-3 — Grouped-active dropdown underline doesn't show (wiring, minor a11y note)
For pages grouped under a dropdown (e.g. platform), `aria-current="page"` is set on the
dropdown *item* `<a>`, not the parent `.nav__top` button, so
`.nav__top[aria-current]::after` underline never renders for them. Cosmetic; the active
state is still conveyed inside the open menu.

### P2-4 — No arrow-key roving in nav dropdowns (wiring, a11y note)
Dropdowns are operable via Tab (`:focus-within`) and Esc, with correct
`aria-haspopup/controls`, `role=menu/menuitem`. No arrow-key roving tabindex. Acceptable
per current bar, but full `role=menu` semantics imply arrow navigation — consider adding
if pursuing strict ARIA menu conformance.

---

## CLEAN — verified, no action (for the record)
- **grid-gone:** zero background dot/line/micro-grid rules survive; dynamic Phosphor Field
  present and correctly wired. Repeating-gradient survivors are bounded ≤11px decorative
  seam rules (`.seam`/`.dither-edge`/`.rule--ticks`/`.spark i`), not full-bleed grids.
- **contrast:** all readable text pairs meet/exceed WCAG AA; every `color:` resolves
  through the audited token ramp (zero raw-hex text colors). Sub-threshold tokens are all
  decorative/non-text. (Live P1-5 is the only latent risk, fixed-on-use recommendation.)
- **bleed-energy:** no color bleed past containers; no rendered empty rows/cells; motion
  system is real, restrained, reduced-motion-safe, JS-fail-open. Above the Series-C bar.
- **wiring CLEAN:** server endpoints `/v1/plans`, `/v1/signup`, `/docs/api` untouched;
  hero CTAs intact; zero SEO head deltas across all 34 modified HTML; all nav target routes
  resolve; reduced-motion sound; nav toggle + dropdown a11y wiring intact.
