# KOLM UNICORN SYSTEM — the one authoritative design system + build plan

> Status: canonical. Supersedes every prior layer in `kolm-2026.css` and the entire
> `kolm-main.css` system. Last revised 2026-06-14.
>
> This document is the single source of truth. When code and this spec disagree, the
> spec wins and the code is wrong. It synthesizes all six research passes (Apple Liquid
> Glass playbook; Linear/Vercel/Railway/Supabase teardown; Clerk/Cursor/Raycast/Resend/
> Baseten teardown; competitor field teardown; IA/page-set audit; current-state CSS
> diagnosis) into one set of hard calls.

---

## 0. DIRECTION

kolm.ai is **the AI compiler**: capture model/API traffic → compile a signed `.kolm`
artifact → compose specialists → deploy to the smallest device that fits. The brand
metaphor is a **forensic instrument**: a calm, dark, near-black *room* (the canvas), with
**translucent glass instrument chrome floating over it** (nav, the product mock, cards,
toolbars, modals), and **one lit object** — the signed artifact — as the brightest thing
on the page. The single accent is phosphor green `#3FE5A0`, and it means *verified*.

The field (Together, Fireworks, Modal, Groq, Mistral, Baseten) converges on generic
gradient-blob darkness or safe light-enterprise. kolm already beats them on the two
hardest-to-fake things: a **signature object** (the signed artifact) and an **owned,
meaningful accent** (green = passed). It loses on the easiest thing to fix: **consistency**
— only 1 of 51 pages runs the new system; 20 still run the old `kolm-main.css` as a visibly
different company. The job is not "design a prettier homepage." It is: (1) get Liquid Glass
*correct* (foreground paneling over a distinct background, not a glass mesh background); (2)
collapse to ONE stylesheet, ONE nav, ONE footer, ONE component kit; (3) propagate that
system across all 51 pages so nothing reads as unfinished. The current `kolm-2026.css` is
nine stacked rewrites (5 `:root`, 4 `body`, 21 `!important`, `.btn--primary` defined 4×) and
must be deleted and reauthored as ONE layer.

---

## 1. THE LIQUID GLASS PANELING RULE — glass vs background vs solid

**The owner's correction, made into law.** Apple WWDC25: Liquid Glass is *"a distinct
functional layer for controls and navigation, floating above everything"* — it is the
**foreground material**, not the wallpaper. Glass only reads as glass when there is a
**distinct, slightly textured background bleeding/blurring through it**. The prior attempt
(the `RICH ATMOSPHERE` block, lines 1687–1741) did the exact inverse: it painted a 5-zone
colored aurora mesh as the whole-page background and dropped panels to ~40% transparent films
on top. That is glass-as-background. **It is deleted.**

### Three explicit layers

| Layer | What it is | Material | Glass? |
|---|---|---|---|
| **L1 — THE ROOM** (bottom) | Page canvas: near-black `#08090A` + ONE faint phosphor overhead glow + a masked dot/line grid behind the hero only. This is what refracts. | Solid + one restrained radial + faint grid | **NEVER glass** |
| **L2 — GLASS CHROME** (middle, floats) | Nav, the product-mock frame, modals, dropdowns, command palette (**real `backdrop-filter`**); plus below-fold feature cards/panels/tiers and the code-block chrome bar (**fake-glass `.glass--solid`, no `backdrop-filter`** — see §1 below-the-fold rule). | **Liquid Glass — real on nav/`.ui`/modals, fake-glass on bulk cards** | **YES — the only glass layer** |
| **L3 — CONTENT / THE LIT OBJECT** (on the glass / in the room) | Headlines, body, the code *text*, data tables, charts, AND the paper-white signed artifact (the SHEET). | Solid fills + vibrancy; the SHEET is opaque paper-white | **NEVER glass** |

### The five hard rules (memorize)

1. **Glass is foreground chrome, never the page background.** If you cannot point to the
   distinct thing *behind* a panel, do not spend a `backdrop-filter` on it — it would refract
   nothing. Real glass goes only where distinct content passes underneath (nav, `.ui`, modals);
   below-fold cards that sit on flat L1 use fake-glass instead (see the below-the-fold rule).
2. **Never glass-on-glass.** A card/chip/row *inside* a glass panel uses a **solid vibrant
   fill** (`rgba(255,255,255,.05–.07)`), never its own `backdrop-filter`. (Apple: stacking
   glass "makes the interface feel cluttered.")
3. **Content is not glass.** Tables, long copy, the actual code text, the SHEET artifact →
   solid fills in the content layer. Only the *frame/chrome around* them is glass.
4. **Regular everywhere; Clear almost never.** Use Regular glass site-wide. Clear (more
   transparent, needs a dimming scrim) only over bright media — effectively never on kolm.
5. **Legibility wins.** If text on a panel drops below 4.5:1 over the worst-case composited
   background, *raise the panel's base fill opacity*. Never thin glass for looks.

### Per-surface verdict (the lookup table every page obeys)

| Surface | Treatment |
|---|---|
| Top nav bar | **Glass (small/tight)** — sticky, floats over scrolling content |
| Product-mock frame (`.ui`), modals, command palette, dropdowns, toolbars | **Glass (Regular, large)** |
| Feature / pricing / spec cards (`.card`, `.panel`, `.plate`) below the hero | **Fake-glass (solid `--surface-1` base + specular rim + lift, NO `backdrop-filter`)** — there is no distinct L1 to refract below the fold. Use real Regular glass only when the card sits inside the hero (over the grid/glow). |
| Code block | Glass **chrome bar only** (filename, copy btn); the code well is a **solid** near-black fill |
| Buttons/chips/rows INSIDE a glass panel | **Solid vibrant fill** — no second blur |
| Primary CTA ("Get an API key") | **Solid `#3FE5A0`**, dark ink — opaque, loud, never glass |
| Page background (`body`) | **L1 room** — near-black + one phosphor glow. Never glass |
| Hero headline, body, code text | **Plain** content |
| Data tables, charts, long-form docs/legal | **Content layer**, solid low panels — not glass |
| **The signed artifact (SHEET, `.rep`/`.vw`)** | **Opaque paper-white** — the one lit object, the brightest thing in the room. Not glass |
| Footer | One large **solid** band — not glass (overuse kills the effect) |

### The layering recipe (what makes the blur visible)

The room must have something to refract. Behind every glass panel: the body's phosphor glow,
plus the hero's masked dot/line grid, plus (in product mocks) real code text. **Glass over
flat black = invisible glass** — the prior failure. So: keep the hero grid + glow bleeding
*under* the nav and panels. Depth = the panel refracting a *distinct* L1, plus a 1px white-
alpha rim (brighter at the top edge = specular), plus a soft contact shadow that lifts the
panel off the room. Borders are **translucent white**, never `#333` gray.

### The below-the-fold rule (real glass vs. fake glass — the law that saves the rest of the page)

The hero grid + glow exist **behind the hero only**. Below the hero, L1 is flat near-black
`#08090A` with no grid and no glow — so a glass `.card`/`.panel`/`.tier` placed down those
pages has *nothing distinct to refract*, and its `backdrop-filter` blur reads as a flat dark
rectangle. That re-creates a muted version of the original failure. **Do not "fix" this by
adding per-section glows** (the deleted code did exactly that — banned as overkill). Instead:

- **Below the hero, depth comes from the luminance ladder + hairline + lift, NOT from
  `backdrop-filter` refraction.** A below-fold panel sits on a slightly raised **solid** base —
  `--surface-1 #0E0F12` is a real **+1 luminance step** over the `#08090A` room — wears the 1px
  translucent-white top specular rim (`--line-top`), and casts the soft contact shadow
  (`--shadow-lift`). That trio reads as a lifted glass plate **without any blur**.
- **Reserve real `backdrop-filter` for the surfaces that actually overlap moving/lit content:
  the nav, the `.ui` product mock, and modals/command-palette/dropdowns.** Those genuinely have
  distinct, scrolling, or lit content passing under them, so the blur does real work.
- **Bulk cards may use a cheap static fill that merely *looks* like glass** — the
  `--surface-1` base + specular rim + lift above — with no `backdrop-filter` at all. This is
  cheaper to render and looks identical over flat L1, where real refraction would show nothing.

This matches the Source-3 teardown (real `backdrop-filter` reserved for nav/mock/modals; cheap
fake-glass for bulk cards) and resolves the contradiction with §5/§6, which place glass cards
far below the fold.

---

## 2. COLOR

ONE accent. Rationed to ~1 primary action / glow per viewport (Raycast rations red; Resend
rations white; Mistral owns orange — kolm owns green, and green *means verified*). Everything
structural is the neutral ramp + white-alpha hairlines. The accent appears as exactly:
primary CTA fill, the one hero glow, the "signed/verified" check on the artifact, and the
active nav/tab state. Never tint a whole large panel green — it stops reading as neutral glass.

### Surfaces (L1 — neutral near-black ladder, depth by luminance not shadow)

```css
--bg:          #08090A;   /* the room — page canvas (theme-color, single source) */
--surface-1:   #0E0F12;   /* card / panel floor */
--surface-2:   #16181C;   /* elevated / hover */
--surface-3:   #1C1E22;   /* reduced-transparency glass fallback */
--code-well:   #050608;   /* code area inside a code block */
```

> Hard call: there is exactly ONE page-surface token, `--bg` = `#08090A`. The current file's
> `--paper`/`--bg`/`--paper-2`/`--obsidian` duplication is collapsed; `--paper` becomes an
> alias of `--bg` for back-compat only.

### Foreground text ramp (vibrancy hierarchy — never flat pure white on glass)

```css
--ink:    #F7F8F8;            /* primary (~97%) — headlines, key values */
--ink-2:  #C3C8D0;            /* secondary — body, lede */
--ink-3:  #868B94;            /* tertiary — captions, mono micro-labels */
--ink-4:  #5A5E66;            /* quaternary — disabled, step numerals */
--ink-faint: #34373C;
```

### The one accent (phosphor green — verification semantic)

```css
--accent:      #3FE5A0;
--accent-hi:   #5CEBB1;       /* hover */
--accent-press:#33CC8C;       /* active */
--accent-text: #54E8AC;       /* accent as text (AA on dark) */
--on-accent:   #04130C;       /* dark ink ON the green button */
--accent-soft: rgba(63,229,160,.12);   /* active-state fill */
--accent-edge: rgba(63,229,160,.28);   /* active-state border / focus ring */
--accent-tint: rgba(63,229,160,.06);   /* faintest wash */
--accent-glow: rgba(63,229,160,.16);   /* the one hero glow behind the mock */
```

Stay **cool/mint phosphor + cool-grey neutrals** to avoid looking like Baseten
(`#19E76E` + warm sage + pink). No pink, no warm sage anywhere.

### Hairlines (translucent white — the single biggest premium upgrade on dark)

```css
--line:      rgba(255,255,255,.08);   /* standard divider / card border */
--line-2:    rgba(255,255,255,.13);   /* prominent / hover border */
--line-top:  rgba(255,255,255,.14);   /* top specular edge of glass */
--line-soft: rgba(255,255,255,.05);   /* micro divider (rows) */
```

### Status + severity (surgical, not decorative)

```css
--void:    #E0A89F;  --void-edge: rgba(224,168,159,.34);   /* error / void seal */
/* severity — audit/report FINDING ROWS only. Marketing pages must never use these. */
--sev-high:#FF8266; --sev-med:#E3C368; --sev-low:#8FB7E8; --sev-info:#7C867F;
```

### The SHEET (the lit signed artifact — paper-white, opaque, content layer)

```css
--sheet:#F3F5F2; --sheet-2:#EBEEE9;
--sheet-ink:#111613; --sheet-ink-2:#4C554F; --sheet-ink-3:#6B746E;
--sheet-line:rgba(17,22,19,.10); --sheet-line-2:rgba(17,22,19,.26);
--sheet-accent:#0B7A4C;  /* green that passes AA on paper-white */
--sheet-high:#B3401F; --sheet-void:#8A5A52;
```

---

## 3. TYPE

Three voices, each with a job. Fonts are all self-hosted (CSP-safe, already on disk in
`public/fonts/`).

| Voice | Family | Job |
|---|---|---|
| **DISPLAY + TEXT** | **Geist** (variable) | headlines, prose, buttons, nav, footer, UI |
| **MACHINE** | **Geist Mono** | code, hashes, IDs, signatures, the register, verdict chips, uppercase micro-labels |

> Hard call: **Geist + Geist Mono is the canonical pair** (both present on disk; Geist Mono
> is the dev-tool tell and is on-brand for a compiler). Switzer + Spline Sans Mono are kept
> only as fallbacks in the stack. **Cabinet Grotesk is dropped** — remove its preload from
> every `<head>` (it is dead weight). This kills the "two type systems" drift.

### Weights

Geist exposes **400 / 510 / 560**. `400` body, `510` UI/emphasis (the Linear "signature
weight" — emphasis without semibold heaviness), `560` display. Never `>600`.

```css
--weight-text: 400;  --weight-ui: 510;  --weight-display: 560;
```

### Scale (px, with negative tracking that scales with size — the unicorn tell)

```css
--fs-hero:   clamp(40px, 4.8vw, 64px);   /* hero h1 · 560 · -0.03em · lh 1.04 */
--fs-h1:     clamp(32px, 3.6vw, 50px);   /* 560 · -0.024em · lh 1.06 */
--fs-h2:     clamp(26px, 2.8vw, 38px);   /* 560 · -0.02em  · lh 1.10 */
--fs-h3:     19px;                        /* 510 · -0.013em · lh 1.30 */
--fs-lede:   clamp(17px, 1.4vw, 19px);    /* 400 · lh 1.55 · --ink-3 */
--fs-body:   16px;                        /* 400 · lh 1.6  · --ink-2 */
--fs-sm:     14px;                        /* nav / buttons / list · 510 */
--fs-mono-cap: 12px;                      /* uppercase mono micro-label · ~0.08em tracking */
--fs-metric: clamp(30px, 3.2vw, 44px);    /* 560 · tabular-nums */
```

Rules: `text-wrap: balance` on headings; `text-wrap: pretty` on lede; `font-variant-numeric:
tabular-nums` on all metrics/code/tables. The uppercase-mono micro-label (12px, ~0.08em,
`--ink-3`) is the cheap "technical credibility" device — use it for eyebrows and section
kickers. **No headline gradient** (the white→grey clip currently reads as "accidentally
grey"); headlines are solid `--ink`.

---

## 4. SPACING / GRID

```css
/* spacing scale (4px base) */
--s1:4; --s2:8; --s3:12; --s4:16; --s5:24; --s6:32; --s7:48; --s8:64; --s9:96; --s10:128; /* px */

/* vertical rhythm — three densities; pages alternate, never drum */
--section-y: clamp(96px, 10vw, 140px);   /* standard section band */
--rhy-1:     clamp(40px, 4.5vw, 64px);   /* dense */
--rhy-3:     clamp(112px, 12vw, 168px);  /* air (hero, closing CTA) */

/* width + grid */
--maxw:       1100px;   /* marketing/content max width */
--maxw-prose: 680px;    /* legal / long-form column */
--gutter:     24px;     /* 12-col grid gutter */
--nav-h:      56px;

/* radius ladder */
--r-sm: 6px;   /* chips, inline code */
--r-md: 8px;   /* buttons, inputs */
--r-lg: 12px;  /* cards, panels */
--r-xl: 16px;  /* product mock, modals */
--r-pill: 999px;  /* primary CTA pill, badges */

/* elevation — depth by luminance + hairline, NOT by drop shadow */
--ring-inset: inset 0 1px 0 0 rgba(255,255,255,.06);   /* top specular on solid cards */
--shadow-lift: 0 1px 1px rgba(0,0,0,.30), 0 8px 24px rgba(0,0,0,.36), 0 24px 64px rgba(0,0,0,.30);
--focus-ring: 0 0 0 2px rgba(63,229,160,.4), 0 0 0 4px rgba(63,229,160,.2);

/* motion */
--dur-fast:150ms; --dur-base:200ms; --dur-mod:320ms;
--ease: cubic-bezier(.25,.46,.45,.94);
--ease-enter: cubic-bezier(.165,.84,.44,1);   /* modal/card enter: opacity + scale .96→1 */
```

Layout: `.wrap` is `max-width:var(--maxw)` centered with 24px gutters. Sections are
`var(--section-y)` tall with a `--line-soft` top hairline. Anchors clear the sticky nav via
`scroll-margin-top: 80px`. Drop shadows are banned for elevation; allowed only for (a) glass
lift on the product mock / modal and (b) keycap insets.

---

## 5. COMPONENT LIBRARY (the canonical atoms every page composes from)

One declaration per component. No per-page `<style>` blocks redefining primitives. This is
the entire kit — ~16 atoms, the same count the peers ship.

### 5.1 `.glass` (real refraction) and `.glass--solid` (fake-glass) — two foreground primitives

There are **two** material primitives, picked by whether the surface overlaps distinct
content. `.glass` does real `backdrop-filter` and is reserved for surfaces that actually have
moving/lit content under them: **the nav, the `.ui` mock, and modals/palette/dropdowns.**
`.glass--solid` is the cheap fake-glass for **everything below the hero** — same rim, same
lift, identical look over flat L1, but **no `backdrop-filter`** (there is nothing distinct to
refract below the fold, so the blur would be wasted and would read as a flat rectangle — see §1
below-the-fold rule).

```css
/* REAL glass — nav, .ui mock, modals/palette/dropdowns ONLY (they overlap moving/lit content) */
.glass {
  background: var(--glass-tint);          /* rgba(16,18,20,.60) — dark fill keeps text legible */
  backdrop-filter: blur(20px) saturate(165%);
  -webkit-backdrop-filter: blur(20px) saturate(165%);
  border: 1px solid var(--line);
  border-top-color: var(--line-top);      /* brighter top edge = specular */
  border-radius: var(--r-lg);
  box-shadow: var(--ring-inset),          /* inner top highlight */
              inset 0 -1px 0 rgba(0,0,0,.30),  /* inner bottom = thickness */
              var(--shadow-lift);          /* lift off the room */
}
@media (prefers-reduced-transparency: reduce){ .glass{ backdrop-filter:none; background:var(--surface-3);} }

/* FAKE glass — bulk below-fold cards/panels/tiers. Depth from luminance ladder + rim + lift. */
.glass--solid {
  background: var(--surface-1);           /* #0E0F12 — a real +1 step over the #08090A room */
  /* NO backdrop-filter — nothing distinct sits behind it below the fold */
  border: 1px solid var(--line);
  border-top-color: var(--line-top);      /* same 1px translucent-white specular rim */
  border-radius: var(--r-lg);
  box-shadow: var(--ring-inset),          /* inner top highlight */
              inset 0 -1px 0 rgba(0,0,0,.30),
              var(--shadow-lift);          /* same contact shadow that lifts it off the room */
}
```

`.glass--solid` is also what the `prefers-reduced-transparency` fallback collapses to, so the
two paths converge. Items INSIDE either primitive use a solid fill — `rgba(255,255,255,.05)` +
`1px var(--line)`, **no backdrop-filter** (glass-on-glass rule). Chrome's optional
`feDisplacementMap` lensing (`#glass-refract`, scale ≤16) is progressive enhancement on `.ui`
only.

Atoms in the kit, each = `.glass` (real) or `.glass--solid` (fake) + role styling. **Real
`.glass` is used by exactly three atoms — `.nav`, `.ui`, and modal/palette/dropdown.** Every
other paneled atom (`.card`, `.plate`, `.panel`, `.tier`) is `.glass--solid`, because it lives
below the hero where there is nothing to refract:

- **`.nav`** — sticky, 56px, `rgba(8,9,10,.72)` tighter/darker glass, `blur(14px)`, bottom
  hairline only. Brand mark (3-bar glyph) + links + status dot + Sign in (ghost) + one solid
  green "Get an API key". Identical markup on every page.
- **`.hero`** — `.section--flush`, the room's lit grid (`::before` masked dot/line) + one
  phosphor glow (`::after`), eyebrow (mono micro-label) → h1 → lede → CTA pair → the `.ui`
  product mock. ONE per page, top.
- **`.ui`** — the product-mock showpiece: Regular glass frame (`--r-xl`), chrome title bar
  (`.ui__bar`: live dot + workspace path + `compiling…→signed` state), a step rail
  (`.ui__rail`: Capture/Compile/Compose/Deploy, numbered, one `is-on`), and a code well
  (`.ui__code`, solid `--code-well`). The hero centerpiece; the only "imagery."
- **`.card` / `.plate`** — `.glass--solid` (fake-glass, NO `backdrop-filter`), `--r-lg`, 24px
  pad; hover lifts surface one step (`--surface-1`→`--surface-2`) + brightens border, no green.
  The general below-fold content container.
- **`.panel`** — small data panel: `.glass--solid` frame + `.panel__head` (mono key + status) +
  `.panel__rows` of `.prow` (mono row, right-aligned value). Used in feature blocks below the
  hero. (When a `.panel` mock sits *inside* the hero over the grid, it may take real `.glass`.)
- **`.tier`** — pricing card; `.glass--solid` (lives far down `/pricing`), one `.tier--feat`
  (featured = `--surface-2` or accent-edge border). Header (name + price, `--fs-price`) +
  feature `.ledger` + CTA.
- **`.tbl`** — comparison/pricing table; solid content surface, `--line-soft` row dividers,
  sticky mono-cap header, tabular-nums.
- **`.code` / code well** — glass chrome bar (filename + copy) over a **solid** `--code-well`
  code area; mono 13px; `.kbd` keycap chips use the Raycast inset shadow.
- **`.btn`** — `.btn--primary` (solid green pill, `--on-accent` ink, one per viewport),
  `.btn--ghost` (transparent + `--line-2` border), `.btn--sm`.
- **`.eyebrow` / `.kicker`** — mono uppercase micro-label, `--ink-3`, with a 6px green dot.
- **`.badge` / `.chip`** — mono-cap pill; `.badge--ok` = accent-edge border + green dot.
- **`.ledger`** — feature list, each item one green check glyph.
- **`.metric` / `.proof__row`** — stat strip; number in display weight, tabular-nums,
  hairline top/bottom rule, 4-up → 2-up responsive.
- **`.steps` / `.step`** — numbered pipeline steps (mono ordinal + green underline tick),
  3-up → 1-up. Used by `/how-it-works`.
- **`.register`** — MACHINE-voice certificate metadata rail (key/value mono grid). Used in
  verify/trust/spec.
- **`.rep` / `.vw` (the SHEET)** — the signed artifact, paper-white opaque, content layer;
  `.vw` is the live verifier (hook-compatible with `verify-widget.js`). The brand's hero
  moment on `/verify`. **Not glass.**
- **`.foot`** — one solid band, 5-column grid (Product · Surfaces · Trust · Company · brand),
  `.foil-line` above it. Identical on every page.

### 5.2 What is forbidden

No `!important` (the whole point). No `kolm-main.css`. No `body::after` full-viewport grain.
No 5-zone aurora mesh background. No glass-on-glass. No headline gradient. No green large
panels. No per-page nav link variants. **No `backdrop-filter` on a below-fold bulk card**
(use `.glass--solid`). **No per-section glow added to "make glass visible" below the hero** —
depth there comes from the luminance ladder + hairline + lift, not refraction.

---

## 6. PAGE-BY-PAGE PLAN (so nothing is unfinished)

51 files → ~34 canonical routes. Five page templates; every page is exactly one of them.
Templates: **(M)** Marketing, **(D)** Docs, **(A)** App, **(L)** Legal/prose, **(E)**
Evidence/Trust.

### Marketing funnel (M)
- **`/` index** *(reference)* — hero + `.ui` mock over the room; **add the missing 4th
  "Compose" feat** (rail promises 4 stages, page shows 3); **add a logo/trust bar** under the
  hero; 4 `.feat` blocks (Capture/Compile/Compose/Deploy) → `.proof` strip → a comparison
  band → closing `.cta`. Today it ends too thin — extend it.
- **`/platform`** — hero + 4 anchored pipeline `.feat` sections (`#capture #compile #compose
  #deploy`), each with a glass `.panel` mock, a `.bento` capability grid, `.proof`, `.cta`.
  **Absorbs `compiler-product.html` and `capabilities.html`** (both redirect here).
- **`/how-it-works`** — conceptual: `.steps` (4 numbered) + a `.flow` diagram → CTA. Lighter
  than `/platform`.
- **`/pricing`** — `.tiers` (3, one `--feat`) + `.tbl` comparison + FAQ + enterprise CTA band.
  **Fold audit pricing in as a row**, not a separate tree (`audit-pricing.html` → here).
- **`/compare`** — positioning `.tbl` (kolm vs field) + narrative `.feat` rows.
- **`/enterprise`** — hero + value `.feat` (SSO, deployment, support) + `.proof` (SOC2/logos)
  + trust links + "Talk to sales" form.
- **`/runtimes`, `/integrations`, `/roi`, `/spec`, `/solutions/ai-vendors`,
  `/solutions/enterprise-buyers`, `/research`** — standard M template (hero → feat/bento →
  proof → cta). `roi` keeps its calculator; `spec` adds a `.register`.

### Docs / developer (D)
- **`/docs`** — `.docs-grid`: sticky `.docs-nav` rail + content blocks (Quickstart, Capture,
  Compile, Compose, Deploy, **Evidence/Verify**, API ref link). Glass chrome on code wells.
- **`/docs/api`** — generated API reference on the same `.docs-grid`.
- **`/changelog`** — release ledger (dated `.rep`-lite rows). **`/glossary`** — term grid.

### Account / app (A)
- **`/account/overview`, `/account/api-control-center`** *(canonical-app reference)* —
  `<main class="app">` shell, glass `.panel` workbenches, an **app nav** (workspace switcher,
  not the marketing mega-menu) shared across all app pages.
- **`/account/billing`** — move `account-billing.html` under the `/account/*` namespace.
- **`/signup`** — single centered glass `.panel` card (workspace, email, region), minimal nav
  (logo + Sign in), no marketing footer.
- **`dashboard.html`** — **DELETE**, 301 → `/account/overview` (44-line orphan stub).

### Legal / prose (L)
- **`/terms`, `/privacy`, `/dpa`, `/baa`, `/sla`, `/subprocessors`, `/acceptable-use`,
  `/careers`, `/contact`, `/404`** — `--maxw-prose` single column, `.running-head`
  (last-updated, mono), TOC rail, minimal nav, full footer. `404` gets a glass panel + links
  to home/status/docs. **`compiler-terms.html` → 301 `/terms`.**

### Evidence / Trust (E)
- **`/trust`** — *single* trust center: posture `.register`, certifications `.bento`, sub-links
  to security/threat-model/DPA/BAA/subprocessors/SLA/transparency-log/status. **Absorbs
  `trust-center.html`** (pick one; redirect the other).
- **`/verify`** — the public verifier: paste-artifact box + the `.vw` SHEET (lit paper-white
  against the dark room — the signature brand moment) + `.register`. Reachable from Product▾ →
  "Signed evidence" and from `/trust`.
All remaining E routes get explicit per-page content (no route ships as a bare "E template"
placeholder). **Reposition the whole audit subtree as the "Evidence surface" of the compiler**,
not a second product; `audit-docs.html` → `/docs#evidence`; `audit-pricing.html` → `/pricing`.

**Canonical pick inside the report/audit cluster:** `/report` is the **canonical** signed-report
surface (it renders the `.rep` SHEET — the lit object). `/report-viewer` is **not a second
page**: it is the *embedded/standalone* viewer mode of the same `.rep` artifact (the
`verify-widget.js`-hookable `.vw`), so it shares one template with `/report` and differs only by
chrome (no marketing nav/footer; just the SHEET + `.register`). `/audit` is the **landing/index**
for the Evidence surface that *links into* `/report`, `/verify`, `/checks`, and `/transparency-log`
— it is a navigation hub, never its own report renderer. One renderer (`.rep`/`.vw`), one hub
(`/audit`); no third copy of the SHEET.

- **`/security`** — posture narrative: `.register` (encryption, isolation, key custody) + a
  `.bento` of controls + sub-links to `/security/threat-model`, `/trust`, DPA/BAA. One CTA →
  `/trust`.
- **`/security/threat-model`** — prose (L-ish density) inside the E shell: assets → threats →
  mitigations table (`.tbl`), STRIDE-style `.register`, link back to `/security`.
- **`/status`** — live uptime board: component `.panel` rows (operational/degraded via
  `--sev-*`), 90-day incident `.ledger`, subscribe link. Severity colors allowed here (it's an
  evidence surface, not marketing).
- **`/badge`** — the embeddable "verified by kolm" badge: copy-paste snippet `.code` block +
  live `.badge--ok` preview + a one-line "how verification works" → `/verify`.
- **`/checks`** — the catalog of checks the compiler runs: filterable `.tbl` (check id ·
  category · severity · what-it-proves), each row mono-id, links each check to `/docs#evidence`.
- **`/transparency-log`** — append-only signed-event ledger: mono `.tbl` of timestamped hashes
  (tabular-nums), each entry verifiable, link to `/verify` to check one.
- **`/regulatory-clock`** — compliance-deadline tracker: `.register` of frameworks (SOC2,
  HIPAA, EU AI Act) with next-attestation dates, `--sev-*` proximity coding.
- **`/report`** *(canonical report renderer)* — renders one signed `.rep` SHEET (paper-white,
  the lit object) + finding rows (severity `--sev-*`) + a `.register` of artifact metadata +
  one-click "verify this report" → `/verify`. This is the page every other report-ish route
  reuses.
- **`/report-viewer`** — the **same renderer in viewer/embed chrome** (the `.vw` SHEET, no
  marketing nav/footer), for sharing/embedding a single report. Not a distinct design.
- **`/buyer`** — the buyer-facing evidence portfolio: a portfolio pane of a vendor's signed
  reports (`.rep`-lite rows) + filters + "request evidence" CTA. Aggregates `/report`s; does not
  re-render the SHEET itself.
- **`/audit`** *(Evidence-surface hub)* — the landing/index for Evidence: hero-lite + a `.bento`
  routing to `/report`, `/verify`, `/checks`, `/transparency-log`, `/buyer` + `.proof`. A
  navigation hub, never its own report renderer.

### Redirects (add to `vercel.json`)
`compiler-product→/platform`, `capabilities→/platform`, `trust-center→/trust`,
`compiler-terms→/terms`, `dashboard→/account/overview`, `account-billing→/account/billing`,
`audit-docs→/docs#evidence`, `audit-pricing→/pricing`. No merged link may 404.

---

## 6.1 PER-ROUTE DEFINITION OF DONE (a route is "finished" only when every box is checked)

"Finished" is otherwise unfalsifiable. Each route below is done only when ALL of its boxes
hold. **Every checklist ends in the same final box: "exactly ONE `.btn--primary` in the page
body" (the §1 one-action-per-viewport law made a pass/fail gate).** The shared shell adds a
second visual green button in the *nav* ("Get an API key"); that nav button is part of the
canonical header and does NOT count against the body's one-primary budget — but it is the only
exception, and no `<main>` may contain a second `.btn--primary`.

**Global DoD (applies to every route, in addition to its template list):**
- [ ] Passes the §7 consistency contract (one stylesheet, one nav, one footer, body class, no
      `!important`, real-glass only on nav/`.ui`/modals, `<head>` preloads = Geist + Geist Mono
      only).
- [ ] One `<h1>`; `.skip-link` first child; reduced-motion / reduced-transparency / contrast honored.
- [ ] No below-fold `backdrop-filter` on bulk cards; below-fold panels are `.glass--solid`.
- [ ] Every internal link resolves (no 404); merged routes 301 in `vercel.json`.
- [ ] **Exactly one `.btn--primary` in `<main>`** (the closing CTA). Nav green button excluded.

**Marketing (M) — `/`, `/platform`, `/how-it-works`, `/pricing`, `/compare`, `/enterprise`,
`/runtimes`, `/integrations`, `/roi`, `/spec`, `/solutions/*`, `/research`:**
- [ ] Hero: eyebrow (mono micro-label) → one `<h1>` → lede → CTA pair, over the lit room grid+glow.
- [ ] Body: ≥3 substantive sections from the §5 kit (`.feat`/`.bento`/`.proof`/`.tbl`), none thin.
- [ ] At least one real proof element (metrics, comparison table, or logo/trust bar) with real numbers.
- [ ] Section rhythm via `--section-y`/`--rhy-*`; width via `.wrap`.
- [ ] Route-specific: `/` has the 4th "Compose" feat + logo bar; `/pricing` has 3 `.tier` + `.tbl`
      + folded audit-pricing row; `/compare` has the kolm-vs-field `.tbl`; `/roi` has its calculator;
      `/spec` has a `.register`.
- [ ] Closing `.cta` band → **exactly one `.btn--primary`** ("Get an API key" / "Talk to sales").

**Docs (D) — `/docs`, `/docs/api`, `/changelog`, `/glossary`:**
- [ ] `.docs-grid`: sticky `.docs-nav` rail + content column; anchors `scroll-margin-top:80px`.
- [ ] Code wells: real glass **chrome bar only** over a solid `--code-well`; copy button works.
- [ ] `/docs` includes the Evidence/Verify block linking `/verify` + `/checks`; `/docs/api` is
      generated; `/changelog` is dated `.rep`-lite rows; `/glossary` is a term grid.
- [ ] No marketing mega-sections; D density.
- [ ] One persistent CTA (top of rail or footer-of-content) → **exactly one `.btn--primary`**
      ("Get an API key").

**App (A) — `/account/overview`, `/account/api-control-center`, `/account/billing`, `/signup`:**
- [ ] App shell `<main class="app">` + **app nav** (workspace switcher), not the marketing mega-menu.
- [ ] Workbenches are real `.glass--solid` `.panel`s; no marketing footer on app pages.
- [ ] `/signup` is a single centered card (workspace/email/region), minimal nav (logo + Sign in).
- [ ] State is honest (empty/loading/populated covered, not lorem).
- [ ] Primary in-app action → **exactly one `.btn--primary`** (`/signup`: "Create workspace";
      account pages: "Get an API key" / "Add payment method").

**Legal/prose (L) — `/terms`, `/privacy`, `/dpa`, `/baa`, `/sla`, `/subprocessors`,
`/acceptable-use`, `/careers`, `/contact`, `/404`:**
- [ ] `--maxw-prose` single column + `.running-head` (last-updated, mono) + TOC rail.
- [ ] Minimal nav + full footer; no glass mesh, no hero mock.
- [ ] `/contact` has a working form; `/404` has a glass panel + links to home/status/docs.
- [ ] Real, current legal copy (no placeholder lorem).
- [ ] One closing action → **exactly one `.btn--primary`** ("Contact us" / "Back to home" /
      "Talk to sales"); pure legal text pages whose only primary is "Back to home" still satisfy
      "exactly one."

**Evidence/Trust (E) — `/trust`, `/verify`, `/security`, `/security/threat-model`, `/status`,
`/badge`, `/checks`, `/transparency-log`, `/regulatory-clock`, `/report`, `/report-viewer`,
`/buyer`, `/audit`:**
- [ ] Matches its per-page content spec in the E list above (no bare "E template" placeholder).
- [ ] The SHEET (`.rep`/`.vw`) renders ONLY on `/report` + `/report-viewer` (one renderer); other
      E routes link to it, never re-render it. `/audit` is a hub, `/buyer` aggregates.
- [ ] Severity `--sev-*` colors appear ONLY in finding/status rows (`/report`, `/status`,
      `/checks`, `/regulatory-clock`), never as marketing decoration.
- [ ] `.register` present where the spec calls for it (`/trust`, `/verify`, `/security`, `/report`).
- [ ] Reachable from Product▾ → "Signed evidence" and/or `/trust`; no orphan E route.
- [ ] One closing action → **exactly one `.btn--primary`** (`/verify`: "Verify artifact";
      `/trust`: "Talk to sales"; `/report-viewer`: the single "Verify this report"). Viewer/embed
      chrome still carries exactly one primary, not zero.

---

## 7. CONSISTENCY CONTRACT (a page is "canonical" only if ALL hold)

1. **One stylesheet.** Loads `/kolm-2026.css` (reauthored) and nothing else for layout.
   `kolm-main.css` is deleted. No second `<link>`.
2. **One `<head>` boilerplate.** viewport `viewport-fit=cover`; `theme-color #08090A`; preload
   **`/fonts/Geist.woff2` and `/fonts/GeistMono.woff2` only** — these are the canonical
   display+text and machine faces from §3, so they must be the ones preloaded or every headline
   and all code FOUT. **Drop the Cabinet Grotesk preload AND the Spline Sans Mono preload**:
   Cabinet is dropped entirely (dead weight), and Spline Sans Mono stays only in the
   `font-family` fallback stack — a fallback is never preloaded. The canonical `<head>` font
   block is exactly these two links and nothing else:

   ```html
   <link rel="preload" href="/fonts/Geist.woff2"     as="font" type="font/woff2" crossorigin>
   <link rel="preload" href="/fonts/GeistMono.woff2" as="font" type="font/woff2" crossorigin>
   ```

   Plus the `js-reveal` guard and canonical/OG/twitter tags. No third font preload — not
   Switzer, not Spline, not Cabinet.
3. **One body class.** `home` | `marketing` | `app` | `legal` | `evidence`. Never
   `compiler-site` / `compiler-site--paper`.
4. **One nav.** The single header from §5/§6, identical markup and link set on every page:
   **Product▾ · Docs · Pricing · Enterprise · Trust** + status dot + Sign in + one solid
   "Get an API key". Kill the `Solutions/Developers/Pricing` legacy nav. No page invents links.
5. **One footer.** The 5-column solid footer, identical markup, `.foil-line` above it.
6. **Liquid Glass = foreground only, and real refraction is rationed.** Real `backdrop-filter`
   `.glass` on **`.nav`, `.ui`, and modals/palette/dropdowns only** — the surfaces that overlap
   moving/lit content. All below-fold panels (`.card/.panel/.plate/.tier`) use `.glass--solid`
   fake-glass (solid `--surface-1` base + specular rim + lift, NO `backdrop-filter`), because
   below the hero there is no distinct L1 to refract. The background is the near-black room +
   ONE phosphor glow + the hero grid (grid/glow **behind the hero only**) — **never glass**. The
   SHEET stays opaque paper-white. No page makes a glass mesh the page background, and no page
   puts real `backdrop-filter` on a bulk card.
7. **One accent.** `#3FE5A0`, ~one primary action/glow per viewport. Severity colors only in
   audit/report finding rows; marketing never uses them.
8. **Three type voices.** Geist (display/text), Geist Mono (machine). No other families. No
   headline gradient.
9. **Section rhythm + width.** Vertical spacing via `--section-y`/`--rhy-*`; width via `.wrap`
   (`--maxw`) or `--maxw-prose`; anchors `scroll-margin-top:80px`.
10. **Components from the §5 kit only.** No per-page `<style>` redefining `.btn/.card/.nav/etc.`
11. **A11y baseline.** `.skip-link` first child; one `<h1>`; nav `aria-label="Primary"`;
    `prefers-reduced-motion` + `prefers-reduced-transparency` + `prefers-contrast` honored.
    No page overrides these with `!important`.
12. **Zero `!important`** in the stylesheet. `:root` declared once; `body` declared once;
    every component declared once.
13. **Redirects.** Every deleted/merged route has a 301 in `vercel.json`.

---

## 8. CASCADE-SAFE BUILD PHASES

Ordered so each phase is independently shippable and never half-applies a system.

**Phase 0 — Reauthor the stylesheet (unblocks everything).** Delete `kolm-2026.css`; write
ONE new file from this spec: one `:root` (§2/§3/§4 tokens), one `body` (the §1 L1 room — one
phosphor glow, no aurora, no grain, no `!important`), then the §5 component kit, one
declaration each. Remove the dead EVIDENCE-ROOM CSS (the ~1,300 unused `.idx/.rep__sheet/
.seal/.flow` selectors that `index.html` never uses) unless a component reintroduces it. Update
`scripts/render-check-home.mjs` to assert the *current* homepage DOM (it tests `.artifact/
.rep__sheet/.idx` which no longer exist). Author the `@font-face` rules so the canonical pair
(`Geist`, `Geist Mono`) loads first and `Spline Sans Mono` is declared only as a fallback —
matching the §7-item-2 preload block (preload `/fonts/Geist.woff2` + `/fonts/GeistMono.woff2`
only; never preload the fallback).

**Phase 1 — Lock the shared shell.** Finalize the one nav + one footer snippet from
`index.html`; ideally render them server-side from one source in `server.js` (the repo already
has `scripts/` + `server.js`) so they cannot drift. Until then, a single canonical snippet every
page matches byte-for-byte. **Fix the `<head>` font preloads on every page to the §7-item-2
canonical block: preload `/fonts/Geist.woff2` and `/fonts/GeistMono.woff2` only; remove the
Cabinet Grotesk, Switzer, and Spline Sans Mono preload links** (Spline stays in the
`font-family` fallback stack but is never preloaded). Today `index.html` preloads
Cabinet + Switzer + Spline and preloads *neither* Geist nor Geist Mono — that ships a FOUT on
every headline and all code, so this swap is mandatory, not cosmetic.

**Phase 2 — Get the hero/glass right on `index.html`.** Rebuild the `.ui` mock as the
dimensional showpiece: Regular glass over the lit room grid + real code text behind the blur,
one phosphor glow, the `compiling…→signed` state, the `feDisplacementMap` lensing as
enhancement. Add the 4th "Compose" feat and the logo/trust bar. This is the reference every
other page copies.

**Phase 3 — Migrate the 20 legacy pages off `kolm-main.css`** (`platform, how-it-works,
compiler-product, capabilities, runtimes, integrations, compare, pricing, enterprise, research,
docs, changelog, security, status, trust, signup, contact, compiler-terms, 404, docs/api`),
template by template (M → D → E → L → app). Swap to the new shell + body class + canonical
nav/footer. **Then delete `kolm-main.css`.**

**Phase 4 — Dedupe + redirects.** Merge `compiler-product/capabilities→platform`,
`trust-center→trust`, `compiler-terms→terms`, `dashboard→account/overview`,
`account-billing→account/billing`, `audit-docs/audit-pricing→docs#evidence`/`pricing`. Add all
301s to `vercel.json`.

**Phase 5 — Collapse IA to one story.** Replace both old navs with the single **Product▾**
mega-menu; reframe the audit subtree as the **Evidence** surface of the compiler (not a second
product). Verify every page satisfies the §7 contract.

**Phase 6 — Finish marketing depth.** Bring every M page to unicorn fidelity: real metrics, a
transparent pricing table (Replicate/Fireworks bar), a model/runtime library with live data, a
comparison band, intentional accent moments. No page ends thin.

---

### Appendix — provenance of the hard calls

- **Liquid Glass = foreground over distinct background**, three-layer model, never glass-on-glass,
  Regular-by-default: Apple WWDC25 "Meet Liquid Glass" + the §1 playbook (Source 1, 4).
- **Depth by luminance ladder + white-alpha hairlines, accent rationed to ~1/viewport, semantic
  tokens for cross-page consistency**: Linear/Vercel/Supabase/Railway teardown (Source 2).
- **Real `backdrop-filter` reserved for nav/mock/modals; cheap fake-glass for bulk cards; product
  UI is the hero object; cool-phosphor to avoid Baseten**: Raycast/Cursor/Resend/Clerk/Baseten
  teardown (Source 3).
- **kolm already beats the field on signature object + owned accent + category verb; the gap is
  consistency**: competitor field teardown (Source 4).
- **51 files → ~34 routes, two navs/two stories to collapse, the redirect + dedupe map, the five
  page templates**: IA/page-set audit (Source 5).
- **The CSS is nine stacked layers (5 `:root`, 21 `!important`, `.btn--primary` ×4); RICH
  ATMOSPHERE is the glass-as-background failure; delete and reauthor as one layer**: current-state
  diagnosis (Source 6).
