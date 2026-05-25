# Kolm Design Cascade Ledger Seed

Date: 2026-05-25

Purpose: seed `docs/design-cascade-ledger.json`, the control file that should make Kolm's visual system, navigation, buttons, typography, colors, spacing, popovers, media, and account UI states enforceable across the entire product. The product-feature matrix says which features must be complete. This ledger says which visual and interaction rules those features must obey.

Related documents:

- `docs/research/kolm-master-spec-consolidated-review-2026-05-25.md`
- `docs/research/kolm-p0-control-files-implementation-spec-2026-05-25.md`
- `docs/research/kolm-p0-control-files-buildbook-2026-05-25.md`
- `docs/research/kolm-product-feature-completion-matrix-seed-2026-05-25.md`

## Why This Is P0

The current UI problem is not one bad hero, one bad button, or one bad nav underline. The codebase has many public pages, many account pages, many stylesheet generations, runtime visual guards, inline styles, hidden test anchors, and overlapping component conventions. A page can pass screenshot audit and still feel inconsistent because the cascade itself is not governed.

The design cascade ledger should answer:

- Which stylesheet is source of truth for each token and component?
- Which page family is allowed to own local CSS?
- Which inline styles are intentional versus leftover patches?
- Which runtime guards are temporary compatibility shims versus canonical behavior?
- Which nav, button, card, table, form, popover, and hero variants are allowed?
- Which exceptions are allowed, why, and when they expire?

Without that file, "make the site state of the art" keeps turning into more CSS layers instead of a coherent product system.

## Current Evidence Snapshot

PowerShell inspection of the current worktree found:

| evidence | current value |
|---|---:|
| public HTML files | 729 |
| public CSS files | 20 |
| public JS files | 16 |
| CSS/HTML raw hex matches | 11,359 |
| CSS/HTML `!important` matches | 4,498 |
| CSS/HTML inline `style=` matches | 3,216 |
| CSS/HTML fixed-width matches | 3,894 |
| CSS/HTML `border-radius` matches | 4,231 |
| CSS/HTML negative letter-spacing matches | 1,138 |
| CSS/HTML viewport/fluid font-size matches | 629 |
| CSS/HTML `box-shadow` matches | 338 |
| CSS/HTML `backdrop-filter` matches | 255 |

These counts are not all defects. They are risk indicators. The ledger should classify each class of usage as canonical, transitional, generated, page-local, or disallowed.

## Current CSS Layer Inventory

Large public CSS files observed:

| file | bytes | initial role | ledger action |
|---|---:|---|---|
| `public/brand-refresh.css` | 169,200 | finish-layer and visual override sheet | classify as migration or finish layer; require expiration rules for `!important` blocks |
| `public/surface-polish.css` | 126,141 | cross-surface polish sheet | classify ownership by component family; do not let it become an unbounded patch sink |
| `public/warm-paper.css` | 83,097 | theme layer | decide whether monochrome paper system remains canonical |
| `public/styles.css` | 76,894 | broad legacy/shared sheet | classify legacy versus canonical components |
| `public/frontier.css` | 55,666 | frontier/product visual layer | bind to page family or retire into components |
| `public/ks.css` | 49,262 | shared Kolm component sheet | likely canonical base component layer |
| `public/home-refresh.css` | 48,970 | homepage finish layer | constrain to homepage and remove product-wide leakage |
| `public/w605.css` | 41,070 | wave-specific sheet | classify as migration debt unless still canonical |
| `public/w604.css` | 20,752 | wave-specific redesign sheet | classify as migration debt unless still canonical |
| `public/w706.css` | 20,723 | wave-specific sheet | classify as migration debt unless still canonical |
| `public/wf01-components.css` | 19,639 | component layer | candidate canonical component source |
| `public/design-tokens.css` | 17,186 | token layer | canonical token source candidate |

Initial conclusion: `design-tokens.css`, `ks.css`, and `wf01-components.css` look like source-of-truth candidates. `brand-refresh.css`, `surface-polish.css`, `home-refresh.css`, and wave-numbered CSS should be treated as finish or migration layers until their rules are either promoted into canonical components or retired.

## Current Risk Hotspots

Representative page-level counts:

| page | bytes | style tags | inline styles | nav tokens | button tokens | h1 tags | hidden/aria-hidden tokens |
|---|---:|---:|---:|---:|---:|---:|---:|
| `public/index.html` | 214,568 | 4 | 46 | 9 | 27 | 2 | 75 |
| `public/product.html` | 48,051 | 1 | 8 | 8 | 62 | 2 | 28 |
| `public/distill.html` | 37,628 | 2 | 6 | 6 | 29 | 1 | 3 |
| `public/compile.html` | 63,532 | 1 | 9 | 6 | 23 | 1 | 6 |
| `public/run.html` | 10,849 | 0 | 0 | 10 | 7 | 1 | 2 |
| `public/pricing.html` | 103,817 | 1 | 107 | 8 | 24 | 1 | 241 |
| `public/account/overview.html` | 36,970 | 1 | 11 | 25 | 6 | 1 | 13 |
| `public/account/storage.html` | 33,320 | 1 | 28 | 25 | 11 | 1 | 7 |

Priority redlines:

1. Homepage and pricing have high hidden-anchor and inline-style counts. Some hidden anchors exist for legacy tests, but product truth should move into generated contracts and tests instead of invisible page payloads.
2. Account pages use many nav tokens and local styles. Post-auth UX should converge on one dense admin shell with explicit state components.
3. Product pages have multiple nav/header conventions: `ks-nav-wrap`, `ks-nav__*`, `sec-hero`, `prod-stickynav`, and runtime `nav.js` support for `site-header` and legacy `header.site`.
4. Runtime `nav.js` injects a surface guard with many `!important` declarations to repair touch targets, headline tracking, and mobile actions. This is useful compatibility work, but it should not be the permanent design system.

## Canonical Cascade Model

Target stylesheet order:

1. `design-tokens.css` - color, type, spacing, radius, z-index, motion, semantic state tokens.
2. `ks.css` - global reset, base layout, typography, links, buttons, forms, tables, code blocks.
3. `wf01-components.css` - reusable components that are not page-family-specific.
4. page-family stylesheet - homepage, docs, account, product, trust/legal, pricing, comparison, vertical, runtime/device.
5. page-local CSS - allowed only for unique demos or one-off layout needs, with an owner and expiration.
6. finish/migration sheet - allowed temporarily, must carry expiration or promotion plan.
7. runtime guard - allowed only for a11y/compat repair and must be represented in `design-cascade-exceptions.json`.

Target rule: if a selector affects more than one page family, it belongs in a component or token layer, not inside page HTML.

## Component Family Contracts

### Navigation

Allowed states:

- top-level active
- hover
- focus-visible
- expanded mega/popover
- mobile sheet open/closed
- auth visible/hidden
- disabled/unavailable

Required:

- one canonical nav data model
- one canonical top nav renderer or HTML partial strategy
- no duplicated underline/highlight logic across page-local CSS
- no hover-only mega menus
- 44px minimum touch targets
- visible focus ring
- dark/light parity
- mobile sheet with escape route and focus management

Current redline: `nav.js` supports multiple header conventions and injects repair CSS. The ledger should mark legacy conventions as `migration` and require a single canonical nav implementation.

### Buttons And CTAs

Allowed variants:

- primary
- secondary
- ghost
- link
- icon
- danger
- disabled
- loading

Required:

- 44px minimum height for touch surfaces unless inside dense data tables with explicit exception
- no page-local button radius, shadow, color, or text-transform overrides without exception
- one primary action per screen section
- icon-only buttons require accessible labels
- disabled/loading states must be visually distinct and semantically disabled

Current redline: `ks-btn`, `btn-primary`, `class="btn`, page-local `button`, and runtime guard patterns coexist. The ledger must classify each variant and block unowned variants.

### Typography

Required:

- base body text should be at least 16px on mobile
- line-height should support scanning and reading
- letter spacing should be zero unless explicitly justified for small uppercase labels
- no viewport-scaled body text
- hero scale reserved for true heroes only
- compact panels use compact headings, not hero-scale type

Current redline: static inspection found 1,138 negative letter-spacing matches and 629 viewport/fluid font-size matches. Some may be tokens or legacy rules, but all need ownership.

### Color And Theme

Required:

- semantic color tokens for text, surface, border, state, accent, focus, overlay
- dark and light designed together
- contrast at least WCAG AA for body text
- no raw hex outside token files except documented asset-specific exceptions
- no one-note color theme
- status cannot rely on color alone

Current redline: raw hex count is high enough that a color-token migration ledger is required. The monochrome direction in `design-tokens.css` may be viable, but it must be tested against brand clarity, hierarchy, and account density rather than assumed correct.

### Cards, Panels, And Surfaces

Required:

- cards only for repeated items, modals, and framed tools
- no cards inside cards
- page sections use full-width bands or unframed layouts
- 8px or less border radius unless design system grants exception
- elevation scale must be consistent
- no decorative blur/orb backgrounds

Current redline: 4,231 border-radius matches and 338 box-shadow matches need classification into token use, component use, or exception.

### Forms And Feedback

Required:

- visible labels or programmatic labels for every input
- errors near the field
- helper text where needed
- loading state on submit
- empty/error/partial/success states for account panels
- no placeholder-only labels

Current redline: `nav.js` repairs input labels at runtime. That is good defense-in-depth, but canonical forms should be correct before runtime repair.

### Tables And Account Data Views

Required:

- dense but readable rows
- stable row height
- sorting/filtering where useful
- visible bulk actions
- empty/loading/error/partial states
- keyboard navigation for critical admin work
- no marketing card grids for operational account workflows

Current redline: account pages are numerous and should converge on one admin shell, one table system, one status-token system, and one next-action pattern.

### Heroes And First Screens

Required:

- answer what this is, who it is for, and why now in under five seconds
- cover all three Kolm surfaces: route/capture, distill/compile, run/govern
- one primary action
- one proof surface
- no hidden payload as product truth
- no paragraph sprawl
- no jargon headline

Current redline: homepage still carries hidden anchors and long historical proof payloads. Some may be test contracts, but the ledger should drive migration from hidden anchors to explicit tests and generated product contracts.

### Popovers, Mega Menus, And Sheets

Required:

- click/tap support
- keyboard open/close
- escape closes
- focus return
- z-index from token scale
- no clipped or overlapping content
- light/dark parity
- mobile alternative

Current redline: the user specifically called out popout styles and nav underline/highlight issues. The ledger should treat these as component-contract failures, not page-by-page fixes.

### Product Media And Demo Embeds

Required:

- real product screen, artifact, video, generated bitmap, or faithful technical diagram
- dimensions or aspect ratio to prevent layout shift
- alt text or accessible label
- fallback if video/demo fails
- dark/light verification
- mobile verification
- transcript/caption for video

Current redline: product media proof is a separate P0 control file, but the design cascade ledger should define the component contract for media containers and states.

## Design Cascade Ledger Schema Seed

Each ledger row should include:

```json
{
  "id": "nav-primary",
  "kind": "component",
  "owner": "frontend",
  "source_files": ["public/ks.css", "public/nav.js"],
  "page_families": ["homepage", "product", "docs", "account"],
  "status": "migration",
  "canonical_layer": "component",
  "allowed_selectors": [".ks-nav-wrap", ".ks-nav__brand"],
  "legacy_selectors": ["header.site", ".site-header"],
  "blocked_patterns": ["hover-only menu"],
  "required_states": ["hover", "focus-visible", "active", "expanded", "mobile-open", "disabled"],
  "uiux_checks": ["keyboard", "touch-target", "dark-light", "mobile", "no-overlap"],
  "screenshot_scope": ["desktop-light", "desktop-dark", "mobile-light", "mobile-dark"],
  "exception_budget": {
    "important": 0,
    "inline_styles": 0,
    "raw_hex": 0
  },
  "promotion_plan": "Promote one nav implementation and retire runtime repair selectors.",
  "expires_after_wave": "W806"
}
```

Required `kind` values:

- `token`
- `base`
- `component`
- `page-family`
- `page-local`
- `runtime-guard`
- `generated-docs`
- `media`
- `exception`
- `migration`
- `deprecated`

Required `status` values:

- `canonical`
- `migration`
- `exception`
- `deprecated`
- `blocked`
- `needs-owner`

Required page families:

- `homepage`
- `product`
- `pricing-enterprise`
- `docs`
- `account`
- `trust-legal`
- `vertical`
- `comparison`
- `runtime-device`
- `demo-media`

## Verifier Requirements

Add `scripts/build-design-cascade-ledger.cjs` and `scripts/verify-design-cascade-ledger.cjs`.

Minimum verifier behavior:

1. Enumerate `public/**/*.css`, `public/**/*.html`, and `public/**/*.js`.
2. Extract stylesheet references per page.
3. Count style tags, inline styles, raw hex colors, `!important`, negative letter spacing, viewport font sizing, fixed widths, border radius, shadow, backdrop filter, focus-visible, and media queries.
4. Map selectors and component classes to ledger rows.
5. Fail when a public page has unowned style tags above the allowed page-family budget.
6. Fail when a canonical component has unowned variants.
7. Fail when raw hex appears outside token or documented asset layers.
8. Fail when `!important` appears outside exception or runtime-guard rows.
9. Fail when nav/header conventions are not classified.
10. Warn before failing on legacy anchors until tests are migrated.
11. Emit `docs/design-cascade-ledger.json`.
12. Emit `docs/design-cascade-exceptions.json`.
13. Add `verify:design-cascade-ledger` to `verify:depth` once warn mode is stable.

## Exception Budget Seed

Initial budgets should start permissive in warn mode and tighten after the ledger is generated.

| family | initial warn budget | eventual fail budget |
|---|---:|---:|
| raw hex outside tokens | current count baseline | 0 except documented assets |
| `!important` outside runtime guards | current count baseline | 0 except temporary migration rows |
| inline style attributes | current count baseline | only generated examples or measured demo coordinates |
| negative letter-spacing | current count baseline | 0 except tiny uppercase labels if explicitly allowed |
| fixed widths | current count baseline | 0 for responsive containers; allowed for icons and known media |
| page-local style tags | current count baseline | 0 for standardized page families, exceptions for demos |

## Redline Before "State Of The Art" UI Claims

Do not claim the site UI/UX is complete until:

1. The design cascade ledger exists and covers every public CSS file, public HTML file, and runtime visual JS file.
2. Every nav/header convention is classified as canonical, migration, or deprecated.
3. Every button variant is owned and state-complete.
4. Every account page uses the canonical shell, table, token, and state systems or carries an explicit exception.
5. Every raw color either comes from tokens or has a documented asset/component exception.
6. Every `!important` is either removed or attached to a runtime-guard/migration exception with an expiration.
7. Every page family has desktop/mobile and dark/light screenshot evidence after the latest edits.
8. Every product media component has dimensions, fallback, accessible labeling, and theme-safe verification.
9. Hidden test anchors are either moved into proper tests/contracts or explicitly quarantined with an expiration.
10. The final production evidence packet proves the live domain uses the same design cascade as the verified commit.

