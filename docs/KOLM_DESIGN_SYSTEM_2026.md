# KOLM DESIGN SYSTEM 2026 — "The Instrument"
**Authoritative, opinionated spec. Compiler-first. Cascade-first. 100% launch-safe.**

Owner: lead design-systems architect. Status: canonical. Supersedes the "Evidence Room" doctrine in `kolm-2026.css` and the "paper compiler" override in `kolm-main.css`.

This document makes the hard calls. It does not hedge. Where a research brief disagreed with another, the decision and its rationale are stated inline. An implementer should be able to apply the token values and component specs below directly.

---

## 0. The one decision everything else hangs on

**kolm.ai is ONE brand: a single, premium, DARK compiler-instrument system.** Near-black room, one phosphor-green accent, hairline (translucent-white) borders, three font weights, huge whitespace. `audit.kolm.ai` keeps a tasteful variant of the *same* token names (slightly cooler, severity ramp re-enabled) — never a second brand on the main domain.

**Why dark-canonical, not light (resolving the Source 1 vs Source 4 split):**

- Source 4 argued "go light, the pages already chose `.compiler-site--paper`." That counts sediment, not strategy. **Verified split (canonical, use these everywhere): 21 light pages carry `.compiler-site--paper` and load `kolm-main.css`; the other 30 pages are pure `kolm-2026.css` (dark). So the real ratio is 21 light / 30 dark of 51 total — not the "27 / 24" the earlier draft asserted.** Critically, **`kolm-main.css` is loaded only by those 21 light pages**, so every `kolm-main.css` deletion in §8/§9 affects only those 21; the other 30 dark pages are untouched by `kolm-main.css` changes. The light override is the *bolted-on* layer; its mint base (`#e4ece7`) reads cheap (Source 2 and Source 4 both flag the "muddy mint" as low-rent), and Source 4 itself proposes lifting it toward neutral white — i.e. the current light values are not the asset.
- kolm's single genuinely premium asset is the **lit-artifact contrast**: a paper-white signed `.kolm` exhibit glowing inside a near-black chamber. That trick only works on a dark room. Going light throws away the one thing the old system got right. **This is the brand's signature image — see §7.12, where it (and the runtime-shrink diagram, §7.13) is elevated from "preserved leftover" to first-class signature component.**
- The closest true peers are the **GPU/dev-infra trio (vast.ai, runpod.io, mecka.ai)** named by the owner — all dark near-black bases with one electric accent and glow-on-hover (Source 1). Linear (the gold-standard token spec we have verbatim) is also dark. Vercel/Modal light is a different category (general PaaS), not our peer set.
- **JS safety (corrected — see §10):** `kolm-field.js:67–75` resolves `--paper`/`--accent`/`--cool` through a **2D-canvas `fillStyle` probe** (`probe.fillStyle = v`), which accepts *any* valid CSS color syntax (`rgb()`, `hsl()`, `var()`-resolved, hex). The field shader does **not** require a literal hex. The *only* genuine literal-hex consumer is `kolm-2026.js:13`, which syncs `<meta theme-color>` from `--paper` and bails unless `paper.charAt(0) === '#'` — and that affects `--paper` only. Staying dark keeps these contracts native; keeping `--paper` a literal hex is recommended for that one theme-color path (and for simplicity), not because the field would break.

So we **migrate the dark `:root` from the muddy forensic green-black to a Linear-grade cool near-black ladder, keep the one phosphor accent, delete the second/third token worlds, and strip the decoration.** That is the cascade lever (Source 2's P0: the competing `:root` redefinitions — one body-class fork plus **four** per-page inline `:root` blocks, see §3.8 — must be eliminated before any `:root` edit can actually reach the 21 light pages).

> The premium formula (Source 1, verbatim and adopted): **Premium = (near-black palette) × (one accent, ≤2 uses per viewport) × (tight negative tracking on big type) × (96–128px whitespace) × (hairline borders, not shadows) × (max 3 font weights).** Our overhaul **deletes** decoration; it does not add any.

---

## 1. Design principles

1. **Reduction over decoration.** Every reference wins by removing. We delete grain, aurora, guilloche, dither, regmarks, ghost ordinals, microprint, terminal traffic-lights, and the 3-dot kicker glyph. Nothing decorative survives at the token/shared-component level.
2. **Absurd consistency on a narrow palette.** ONE accent. ONE radius scale. ONE type scale. THREE weights. Applied everywhere without exception. The moment a second decorative hue appears, the premium read collapses.
3. **Whitespace is the luxury good.** 96–128px between major sections; prose capped at ~68ch. Air does the work ornament used to.
4. **Type carries the voice.** Negative tracking that scales with size + a 510 UI weight do the job gradients/illustrations do on cheap sites.
5. **Hairlines, not boxes.** Borders are translucent white (`rgba(255,255,255,0.06–0.12)`), never solid gray lines. This single change reads a generation more premium.
6. **Color is functional, never festive.** Accent = action / live / verified / signed only.
7. **The artifact is the brightest object — and it is the brand.** The lit paper `.kolm` exhibit is the one place light pools. This is not a "keep the field canvas" leftover; it is the **signature, designed as the hero image** (see §7.12). The foundation (near-black + one green + hairlines + 510 weight) is, honestly, a *correct* dev-infra template — it is table stakes, shared with Linear / vast / runpod, and **not by itself distinctive**. The two things that are genuinely ours are (a) the lit signed `.kolm` sheet glowing in the dark chamber and (b) the runtime-shrink phone→edge progression (§7.13). Distinctiveness is bought by *designing those two as signatures*, not by claiming the template is original.
8. **Calm, fast, purposeful motion.** 150ms eased hovers; nothing loops, nothing parallaxes, everything respects `prefers-reduced-motion`.
9. **One source of truth.** A single `:root`. No body-class brand fork, **no per-page inline `:root` (four exist today — all four enumerated and deleted in §3.8 / §8.5 / Phase 2)**.

---

## 2. The positioning the visual story must carry

The compiler product: **capture → compile → compose → deploy.** "API behavior in. Device-fit models out." The visuals must read as a **precision instrument**, not a governance dashboard and not a forensic chamber.

What the design must communicate, in priority order:

1. **This is real dev infrastructure.** Real code on the homepage, mono hashes, `/v1/...` endpoints, signed artifacts. Developer-grade, not enterprise-deck.
2. **It is owned, portable, signed.** The phosphor-green "verified/signed" semantic maps perfectly to the `.kolm` artifact and the verify seal. Accent = "this is signed and real."
3. **It shrinks to the smallest place it can live.** The device/runtime targets (phone → laptop → server → edge → hosted) are a genuine differentiator vs the GPU trio; keep that visual.
4. **Restraint = confidence.** The brand is calm and certain. No alarm, no festival of colors, no governance-soup.

Audit (`audit.kolm.ai`) is the *secondary* product and must never out-shout the compiler on the main domain. The severity ramp and "evidence/proof/readiness-gated" vocabulary belong there, not here.

---

## 3. Color system (exact tokens)

**Canonical base ladder — migrate `--paper` family from forensic green-black to Linear-grade cool near-black.** These replace the current `:root` values in `kolm-2026.css:33–175`.

### 3.1 Surfaces (the room)
| Token | Value | Role |
|---|---|---|
| `--paper` | `#08090A` | page base (was `#090C0D`). Keep a literal `#hex` — `kolm-2026.js:13` theme-color sync bails unless `charAt(0)==='#'`. (`kolm-field.js` also reads it but tolerates any CSS color via its canvas probe — see §10.) |
| `--paper-2` | `#0F1011` | cards, plates, raised chrome (Linear "panel") |
| `--paper-sink` | `#0C0D0E` | recessed wells, table headers |
| `--raised` | `#191A1B` | level-3 surface (modals, hover-lifted panels) — new token |
| `--ink-deep` | `#0D0E10` | proof/instrument band (legacy name kept) |
| `--ink-deep-2` | `#141517` | |
| `--ink-deep-sink` | `#08090A` | |

### 3.2 Foreground ramp (light on dark)
| Token | Value | Role | Contrast on `--paper` |
|---|---|---|---|
| `--ink` | `#F7F8F8` | primary text + headings | 18.5:1 |
| `--ink-2` | `#D0D6E0` | secondary text, lede | 12.6:1 |
| `--ink-3` | `#8A8F98` | meta, labels (≥12px) — the documented dark-mode readable floor | 5.4:1 |
| `--ink-4` | `#62666D` | quaternary, disabled (new) | 3.4:1 — non-body only |
| `--ink-faint` | `#3A3D42` | NON-TEXT decorative only | — |

Keep `--on-ink* = --ink*` aliases (the page is the ledger). Keep the legacy alias block (`kolm-2026.css:136–148`) but **repoint every alias at these new values** — do not delete (audit/legacy pages read `--bg`, `--panel`, `--ok`, `--bad`, `--seal-*`, `--d-*`).

### 3.3 The one accent (phosphor green — verification semantic)
| Token | Value | Role |
|---|---|---|
| `--accent` | `#3FE5A0` | the brand. Primary CTA fill, live/signed/verified status. Read by `kolm-field.js` (canvas probe — any CSS color tolerated; hex kept for simplicity). |
| `--accent-hi` | `#6BF0B8` | hover (brighter, toward the light) |
| `--accent-press` | `#33CC8C` | active/press |
| `--accent-text` | `#5EE8AD` | accent-as-text on dark (lifted for 9:1+ legibility) |
| `--accent-soft` | `rgba(63,229,160,0.12)` | tint fills |
| `--accent-tint` | `rgba(63,229,160,0.06)` | faint wash |
| `--accent-edge` | `rgba(63,229,160,0.30)` | focus/active border |
| `--on-accent` | `#062A1D` | dark text on a phosphor fill |

**Discipline rule (enforced in review):** ≤2 accent elements per viewport; exactly ONE primary CTA per viewport.

### 3.4 Second light (cool counterlight — read by the field shader)
| Token | Value | Role |
|---|---|---|
| `--cool` | `#6FA6E8` | WebGL field counterlight + code keyword hue. Read by `kolm-field.js` (canvas probe — any CSS color tolerated; hex kept for simplicity). |
| `--cool-soft` | `rgba(111,166,232,0.10)` | |
| `--cool-edge` | `rgba(111,166,232,0.28)` | |

`--cool` is the ONLY secondary hue allowed in shared components, and only for: the field, code keywords, and at most one diagram route. It is never a CTA, never a fill on marketing cards.

### 3.5 Hairlines (translucent white — the biggest single upgrade)
| Token | Value | Role |
|---|---|---|
| `--line` | `rgba(255,255,255,0.07)` | standard hairline border |
| `--line-2` | `rgba(255,255,255,0.12)` | strong hairline / hover border |
| `--line-top` | `rgba(255,255,255,0.14)` | top-edge specular (catches the lamp) |
| `--line-micro` | `rgba(255,255,255,0.04)` | gridlines, chart axes (new) |

Replace **every** solid-gray border usage with these. Cards become "the base, very slightly lifted," not boxed.

### 3.6 Status (kept minimal)
| Token | Value | Role |
|---|---|---|
| `--void` | `#E0A89F` | tampered / not-verified (desaturated clay, NOT alarm-red). Keep. |
| `--void-soft` | `rgba(224,168,159,0.12)` | |
| `--void-edge` | `rgba(224,168,159,0.34)` | |

### 3.7 The lit SHEET (the signed artifact — preserved, this is the signature)
This is the **full `--sheet-*` family**, not a subset. The verifier/exhibit rules in `kolm-2026.css` (`.vw__status`, `.sev__row`, `.rep`, `.artifact`) consume `--sheet-high*`, `--sheet-line-2`, `--sheet-ink-3`, and `--sheet-accent-soft` via `var()`; all are retained here and in the Appendix superset.

| Token | Value | Role |
|---|---|---|
| `--sheet` | `#F3F5F2` | the paper-white artifact surface |
| `--sheet-2` | `#EBEEE9` | sheet chrome / recessed rows |
| `--sheet-high` | `#FBFCFA` | sheet specular high (used by `.vw__status`/`.sev__row`) |
| `--sheet-high-soft` | `rgba(251,252,250,0.6)` | softened specular |
| `--sheet-high-edge` | `rgba(17,22,19,0.06)` | specular hairline on sheet |
| `--sheet-ink` | `#111613` | primary sheet text |
| `--sheet-ink-2` | `#4C554F` | secondary sheet text |
| `--sheet-ink-3` | `#6E766F` | sheet meta/labels |
| `--sheet-line` | `rgba(17,22,19,0.10)` | sheet hairline |
| `--sheet-line-2` | `rgba(17,22,19,0.16)` | strong sheet hairline / row divider |
| `--sheet-accent` | `#0B7A4C` | green that reads on paper. **AA-corrected: was `#0E8A57` (4.0:1 on `--sheet` — sub-AA for normal body text). `#0B7A4C` clears 4.5:1 AA for body. Use `--sheet-accent` for status/labels; do not set 14px+ body copy in it unless it passes AA at the rendered size.** |
| `--sheet-accent-soft` | `rgba(11,122,76,0.12)` | accent tint on sheet |
| `--sheet-void` | `#8A5A52` | tampered/void on sheet |

### 3.8 DELETED color tokens (do not survive in the shared sheet)
- **All `.compiler-site--paper` overrides** (`kolm-main.css:27–67`) — the entire light *token* world. Gone. (NOTE: deleting these token rules is necessary but NOT sufficient — the ~230 `.compiler-site--paper`-scoped *component* rules must also be neutralized; see §8 step 7 and §10. Token deletion alone leaves the homepage hero painting light-on-dark.)
- **All `.compiler-site` reactor tokens** (`kolm-main.css:7–25`): `--reactor*`, `--acid`, `--acid-2`, `--compile-blue/amber/rose/violet*`, `--compile-panel*`. The 4-hue "compile" palette is the single worst "dashboard-demo, not brand" tell (Source 2 P1).
- **The severity ramp** `--sev-high/med/low/info/critical/medium`, `--attn-text` — move to the audit variant only, not shared.

#### 3.8.1 The FOUR per-page inline `:root` blocks (exhaustive — verified by `grep -rl ':root' public/**/*.html`)
These win the cascade on their own pages and are the #1 trap: editing the canonical `:root` reaches **nothing** on a page that carries its own. All four must be deleted (or, for `docs/api.html`, migrated) in Phase 2. Verified line ranges:

| Page | Inline `:root` | Mode / accent | Disposition |
|---|---|---|---|
| `account/api-control-center.html` | **lines 18–38** (one block) | dark, third green `--accent:#75ff9d` (+`--accent-deep:#3fe58f`, `--compile-blue*`) | **DELETE.** Page joins canonical dark system; loses the third green. Also delete `html{scroll-padding-top:86px}` at line 39 → inherit 62px (§5.4). |
| `account/overview.html` | **lines 18–34** (one block) | light, `color-scheme:light`, `--paper:#e4ece7`, green `--accent:#0a7b53` | **DELETE.** This is a LIGHT page today; after deletion it inherits the canonical dark `:root`. Verify it reads correctly dark (it does not have its own light component sheet beyond the inline block — confirm in Phase 2 test matrix). |
| `dashboard.html` | **line 18** (single-line block) | light, `color-scheme:light`, `--paper:#e4ece7`, green `--accent:#087a52` | **DELETE.** Also a LIGHT page today (the earlier draft mislabeled it "dark-ish"). Inherits canonical dark after deletion; verify in Phase 2. |
| `docs/api.html` | **line 26** (dark block) + **line 27** `[data-theme=light]` + **line 138** (light block) | **WORST CASE:** own token vocabulary (`--bg`, `--bg-elev`, `--ink-mute`), a **BLUE `--accent:#2563eb`** in the dark block (green `#087a52` in the light block), AND a `[data-theme=light]` toggle | **MIGRATE + RETIRE TOGGLE** (see 3.8.2). |

#### 3.8.2 `docs/api.html` — the foundational-assumption violation, resolved explicitly
`docs/api.html` directly contradicts two foundations: "dark is the only theme" (`kolm-2026.js:2` already declares the toggle dead weight) and "one accent, one green" (it ships a blue `#2563eb` accent and its own `--bg`/`--ink-mute`/`--bg-elev` token names). **Decision (canonical):**
1. **Kill the `[data-theme=light]` block (line 27) and the second light `:root` (line 138).** Dark is the only theme; the toggle is retired site-wide. Remove any `[data-theme]` toggle UI/JS on this page.
2. **Delete the page's bespoke token vocabulary.** Map its names onto the canonical tokens: `--bg → --paper`, `--bg-elev → --paper-2`, `--ink-mute → --ink-2`, `--ink-faint → --ink-3`. Either rename the consuming rules to the canonical tokens, or add a tiny *aliasing* shim **only if** the page can't be edited this phase: `--bg:var(--paper); --bg-elev:var(--paper-2); --ink-mute:var(--ink-2);` — but the shim is a temporary bridge, not a kept exception.
3. **Replace the blue accent.** `--accent:#2563eb → #3FE5A0` (the one green). Blue is not a brand accent; the only sanctioned secondary hue is `--cool` (§3.4), and only for the field/code-keywords/one diagram route — never a CTA or link accent. Any blue link/border on this page repoints to `--accent`/`--accent-text` or `--ink-2`.
4. Net: `docs/api.html` carries **zero** inline `:root` and **zero** `[data-theme]` after Phase 2.

#### 3.8.3 CI / phase-exit guard (enforced)
After Phase 2, **both** must hold and are gating:
```
grep -rl ':root'                 public/**/*.html   # → (empty). Zero per-page :root anywhere.
grep -rl '\[data-theme'          public/**/*.html   # → (empty). No theme toggle survives (dark-only).
```
Add these to CI so no new page-level `:root` or theme toggle reappears.

- Result: **ONE green** (`#3FE5A0`), one neutral ramp, one optional `--cool`. Down from three greens + a blue + four extra hues + a severity ramp + a light-mode toggle.

### 3.9 audit.kolm.ai variant (one body class, same token names)
A single `.surface--audit` (or `<body class="audit">`) override block, ≤20 lines, that only shifts:
- `--paper: #0A0C0F` (a half-step cooler/bluer), `--accent` unchanged or shifted to `--cool`-led,
- re-enables `--sev-*` for finding rows / verdict chips.
Same component classes, same geometry. Reads as the same company's forensic instrument.

---

## 4. Typography system (exact scale)

### 4.1 Families — drop to TWO faces + mono (delete Cabinet Grotesk)
The current three display/text faces is one too many (Source 1). Cabinet Grotesk's personality is what fights the premium read.

```
--display: "Switzer", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
--sans:    "Switzer", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
--mono:    "Spline Sans Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
```
- **Switzer for both display and text** (vary weight/size). It is a unicorn-grade grotesque; using one family for display+text is exactly the Linear/Vercel pattern.
- **Spline Sans Mono** for code, `.kolm` hashes, metrics/numbers, and eyebrow labels only.
- Keep the Cabinet Grotesk `@font-face` line for one release (back-compat) but stop referencing it; remove the woff2 from the critical path after the sweep. All faces remain self-hosted woff2 (CSP-safe, no CDN) — **do not introduce a CDN font.**
- **Account for the unused `/fonts/Geist.woff2` + `/fonts/GeistMono.woff2`** (present today, referenced by nothing in this plan): they are NOT part of this two-face system. Either (a) leave them out of every `@font-face`/preload and **remove them from the build in Phase 6** (dead weight on the critical path), or (b) if a future decision adopts Geist Mono in place of Spline Sans Mono, do it as an explicit token swap — not by leaving both mono faces shipping. Default: remove. Do not preload a face the design system does not reference.

### 4.2 Weights — exactly THREE (the 510 is the secret weapon)
Switzer is variable, so expose:
```
--weight-text: 400;   /* read */
--weight-ui:   510;   /* interact — labels, buttons, nav, emphasis. Linear's signature. */
--weight-display: 590; /* announce — headlines */
```
Audit `kolm-2026.css` + `kolm-main.css` for any `font-weight: 700/800` on body/label/heading text and pull them down. Nothing above 590 ships.

### 4.3 The scale (size / weight / line-height / tracking)
Negative tracking scales WITH size — the biggest "premium" tell and it costs nothing. Token: `--tracking-display: -0.022em` applied to every heading ≥ 32px (we adopt a value between Vercel's aggressive −0.04em and Linear's −0.022em@72; −0.022em reads premium without "squeezed").

| Role | Token | Size (clamp) | Weight | Line-height | Tracking |
|---|---|---|---|---|---|
| Display / hero | `--fs-hero` | `clamp(40px, 5vw, 64px)` | 590 | 1.04 | `-0.024em` |
| H1 | `--fs-h1` | `clamp(33px, 4vw, 52px)` | 590 | 1.08 | `-0.022em` |
| H2 | `--fs-h2` | `clamp(27px, 3vw, 38px)` | 590 | 1.12 | `-0.018em` |
| H3 | `--fs-h3` | `clamp(19px, 1.6vw, 22px)` | 510 | 1.25 | `-0.012em` |
| H4 / card title | `--fs-h4` | `18px` | 510 | 1.3 | `-0.008em` |
| Lede / subhead | `--fs-lede` | `clamp(17px, 1.5vw, 19px)` | 400 | 1.55 | `-0.006em` |
| Body | `--fs-body` | `16px` | 400 | 1.55 | `-0.006em` |
| Body emphasis | — | `16px` | 510 | 1.55 | `-0.006em` |
| Small / caption | `--fs-sm` | `14px` | 400 | 1.5 | `0` |
| Eyebrow / label | `--fs-eyebrow` | `12px` | 510 (mono) | 1.4 | `0.08em` UPPERCASE |
| Metric / big number | `--fs-metric` | `clamp(30px, 3.2vw, 44px)` | 510 (mono) | 1.0 | `-0.01em` |
| Price | `--fs-price` | `clamp(28px, 2.6vw, 36px)` | 510 (mono) | 1.0 | `-0.01em` |

Notes:
- **Hero cap drops from 66px → 64px**, and the 84px outlier in `account/api-control-center.html:64` is corrected to use `--fs-hero`. ONE heading render model site-wide (see 7.3).
- Body raised 15.5px → **16px** (current-gen infra runs 16–17px).
- **DELETE `--fs-ghost`** (the 96–200px outlined ordinal). No ghost ordinals.
- Prose blocks `max-width: 68ch` (~680px).

### 4.4 The single heading render model
Kill the metallic silver gradient-clip AND the paper "un-clip" repair (`kolm-main.css:82–91`) AND the per-page solid-force. Headings are **solid `--ink`**. One model, set once in the shared layer. This removes an entire class of cross-page fragility (Source 2 P3, Source 3).

**Critical — the `@supports` block at `kolm-2026.css:1037–1050` contains TWO clip rules; both must be removed in the SAME edit:**
- **Lines 1038–1042** — the parent silver clip on `h1, h2, .metric__n` (the `--ink-hot`/`--ink-silver`/`--ink-shadowed` gradient). Delete.
- **Lines 1045–1049** — the **`.go` accent-word phosphor clip** on `h1 .go, h2 .go, .hero__h1 .go`. **Delete this too.** `<span class="go">` is the per-headline emphasis word (the one green word in a hero/section headline) and is present on **19 verified pages**. If you delete only the parent clip and leave 1045–1049, then on clip-capable browsers `.go` keeps `-webkit-text-fill-color: transparent` with no inherited gradient and **renders invisible** — the exact cross-page text regression this model claims to eliminate. If you delete only the child, `.go` inherits the (now-removed) silver parent and renders as unstyled silver. Both rules go together; delete the whole `@supports` block 1037–1050.

**What `.go` renders as after the sweep — explicit:**
- The base rule at **`kolm-2026.css:466`** (`.hero__h1 .go, h1 .go { color: var(--accent); }`) is the ONLY `.go` styling that survives, and it must be broadened so `.go` is a **solid accent word** everywhere it appears inside a heading (not just `h1`):
```css
/* keep + broaden — the one surviving .go rule */
h1 .go, h2 .go, h3 .go, .hero__h1 .go {
  background: none;
  -webkit-text-fill-color: var(--accent-text);
          color: var(--accent-text);
}
```
- Using `--accent-text` (the lifted 9:1 accent, §3.3) rather than raw `--accent` keeps the green word legible at heading sizes on dark. The green-word emphasis device **survives the clip removal as a solid accent, not a deleted feature.**
- `.metric__n` (also in the deleted parent rule) becomes solid `--ink` like every other heading number.

**Markup-touch inventory for this change:** `.go` appears on 19 pages (audit, baa, badge, careers, glossary, et al.) and `[data-design-reference]`/clip-capable rendering is universal — so this is a *shared-layer CSS* fix (no per-page markup edits), but `.go` MUST be on the Phase 3 visual-regression checklist on at least one page that uses it in a heading (verify the green word is visible and solid, not transparent).

---

## 5. Spacing & grid

### 5.1 Spacing scale (8px base — already correct, keep)
```
--s1:4  --s2:8  --s3:12  --s4:16  --s5:24  --s6:32  --s7:48  --s8:64  --s9:96  --s10:128
```
(Bump `--s10` from 104 → 128 to hit the gallery-emptiness section gap.) Add nothing else; migrate inline `<style>` page values onto these.

### 5.2 Section rhythm — the #1 layout lever
```
--section-y: clamp(80px, 10vw, 128px);   /* between major sections */
--rhy-1: clamp(40px, 4.5vw, 64px);        /* dense */
--rhy-2: clamp(64px, 7.5vw, 104px);       /* default */
--rhy-3: var(--section-y);                /* air */
```

### 5.3 Grid & widths
| Token | Value | Role |
|---|---|---|
| `--maxw` | `1200px` | content max-width (up from 1148; the unicorn cluster) |
| `--maxw-prose` | `680px` | prose / lede column |
| grid | 12-col, 24px gutters | |
| `--gutter` | `24px` | |

Keep `.wrap`, `.grid--2/3/4`, `.hero__grid`, `.tiers`, `.flow`, `.steps`, `.metrics` grid *templates* (Source 4 MEDIUM risk: restyle, don't restructure). Only the max-width and gutter values change.

### 5.4 Anchor offset
`scroll-padding-top` and `[id]{scroll-margin-top}` must equal nav height. **Nav is `62px`** (verified: `kolm-2026.css:391` `.nav__in { … height: 62px; }` — the earlier "64px" was wrong). Set both to `62px` (or define `--nav-h:62px` and reference it). The offsets are currently **asymmetric and must be reconciled** to the same `62px`:
- `kolm-2026.css:186` `[id]{scroll-margin-top:80px}` → `62px` (this line was NOT in the earlier update list; add it).
- `kolm-main.css:4` and `:66` `scroll-padding-top:86px` → `62px`.
- `kolm-main.css:73` `scroll-margin-top:86px` → `62px`.
- `account/api-control-center.html:39` `html{scroll-padding-top:86px}` → deleted with that page's inline block (inherits `62px`).

---

## 6. Radius / elevation / border / motion

### 6.1 Radius — the unicorn consensus
```
--r-sm: 2px;    /* chips, inline code */
--r-md: 6px;    /* buttons, inputs (Linear/Vercel consensus) */
--r-lg: 8px;    /* cards */
--r-xl: 12px;   /* panels, modals, the artifact */
--r-pill: 999px;/* badges, eyebrows ONLY */
```
Buttons 6px, cards 8px, panels 12px, badges pill. No other radii.

### 6.2 Elevation — hairlines first, shadows sparingly
Dark UI leads with translucent borders and an inset top-light, not drop shadows.
```
--ring-inset: inset 0 1px 0 0 rgba(255,255,255,0.06);  /* top-edge light on every raised card */
--shadow-sm: 0 1px 2px rgba(0,0,0,0.40);
--shadow-md: 0 4px 16px -4px rgba(0,0,0,0.50);
--shadow-lg: 0 16px 48px -12px rgba(0,0,0,0.60);        /* modals/artifact only */
--glow-accent: 0 0 0 1px var(--accent-edge), 0 8px 40px -12px rgba(63,229,160,0.25); /* hover, sparingly */
```
- Default card = fill + hairline + `--ring-inset`. No drop shadow.
- Reserve `--shadow-lg` for modals and the lit artifact.
- Reserve `--glow-accent` for a single hover state (GPU-trio cyan-glow analogue) — opt-in, one element.

### 6.3 Border language
- Standard border: `1px solid var(--line)`.
- Hover/active: `1px solid var(--line-2)`.
- Focus (interactive): `2px solid var(--accent-edge)` + 2px outer offset ring (see inputs).
- The top-edge specular `--ring-inset` is what makes surfaces read "lit from within."

### 6.4 Motion
```
--dur-instant:100ms  --dur-fast:150ms  --dur-base:200ms  --dur-mod:320ms  --dur-slow:500ms
--ease: cubic-bezier(0.25,0.46,0.45,0.94);   /* default, easeOutQuad */
--ease-enter: cubic-bezier(0.165,0.84,0.44,1); /* entrances, easeOutQuart */
```
Route EVERY transition through these tokens. Animate only opacity / transform / background — never layout.
- Hover: ≤150ms bg/border lift.
- Scroll-reveal: single fade-up 8–16px, stagger ~60–80ms, **once** (keep the existing `.reveal`/`.in` machinery — JS-coupled, do not rename `.in`).
- **DELETE** the 36s aurora conic loop (`kolm-2026.css:210–220`), the global grain (`:223–226`), and any parallax / boot-cinema loop.
- Gate everything on `prefers-reduced-motion` (the CSS rule already exists — extend it).

---

## 7. Component specs (before → after)

For each: the current problem, then the rebuilt spec. All live in `kolm-2026.css` so changes cascade to all 51 pages. Geometry-bearing primitives are restyled, never restructured (Source 4 §6).

### 7.1 Nav
**Before:** dark glass `rgba(8,11,10,.78)`; three different primary navs across pages (compiler / audit / legal — Source 3); CTA logic branches on `.compiler-site--paper`.
**After:**
- Height **62px** (the existing `.nav__in` height — do not change geometry; restyle only), sticky, `background: rgba(8,9,10,0.85)`, `backdrop-filter: blur(12px) saturate(180%)`, bottom border `1px solid var(--line)`. Keep anchor offsets equal to this (§5.4).
- Logo left; links center/right at 14px/`--weight-ui`/`--ink-2`, hover `--ink`.
- ONE primary nav site-wide: `Product · Developers · Pricing · Enterprise` + right side `Status · Sign in · [Get an API key]`. (IA per Source 3; "Solutions → /#pipeline" fragment is replaced by real pages.)
- `.nav__cta` = ghost while hero in view, solid accent once scrolled past (keep `wireNavCta` machinery). Since we drop the `.compiler-site--paper` branch, **update `kolm-2026.js:74`**: remove the paper-class early-return so the IntersectionObserver path runs everywhere (or default to `is-solid` when no `.hero`). PRESERVE class names `.nav`, `.nav__toggle`, `.nav__links a`, `.is-open`, `.nav__cta`, `.is-solid` (JS contracts).
- DELETE: any per-page nav variant; standardize on this markup across all compiler-domain pages.

### 7.2 Buttons
**Before:** "paper button on dark" `--primary`; mixed `->` ASCII vs SVG arrows; sometimes two competing solid CTAs.
**After:**
- Radius **6px**, height 40px (`--btn-h: 40px`), padding `10px 16px`, `--weight-ui` (510), `--fs-sm`→16px, transition `background/border 150ms var(--ease)`.
- **Primary** (`.btn--primary`): `background: var(--accent)`, `color: var(--on-accent)`, no border. Hover `--accent-hi`. The "Get an API key / Compile" action.
- **Secondary / ghost** (`.btn--ghost`): transparent bg, `1px solid var(--line)`, `color: var(--ink)`; hover bg `rgba(255,255,255,0.05)` + border `--line-2`.
- Keep the tasteful specular sweep if it routes through `--ease`; otherwise drop it.
- One arrow treatment: a single inline SVG chevron component; remove literal `->`.
- **One primary CTA per viewport.**

### 7.3 Hero
**Before:** dark grid floor + spotlight + WebGL field built for dark (fine), BUT homepage leads with the console ("Kolm API Control Center" / "Open API Control Center" — Source 3) and headings use the silver-clip model.
**After:**
- Structure: eyebrow (mono, uppercase, 12px, `0.08em`) → H1 `--fs-hero` solid `--ink`, tracking `-0.024em` → one-line lede `--fs-lede` `--ink-2` → 1 primary + 1 ghost CTA → product visual (the `compiler-machine` capture/compile/compose/deploy lanes) on the right.
- Copy: eyebrow `THE AI COMPILER`; H1 **"API behavior in. Device-fit models out."**; primary **Get an API key** (`/signup`), ghost **Read the docs** (`/docs`).
- ONE low-opacity radial accent glow behind the H1 (8–12% alpha). Keep the `.field` WebGL canvas (reads `--paper`/`--accent`/`--cool`); cap intensity ≤0.34 as today.
- Single heading render model (solid `--ink`, §4.4). The one accent word in the H1 uses `<span class="go">` → renders solid `--accent-text` (NOT a clip; see §4.4). Hero grid columns kept (geometry); only the heading style and copy change.
- DELETE: grid floor double-up, the silver clip AND the `.go` phosphor clip (both rules in the `@supports` block, §4.4), the per-page 84px hero override.

### 7.4 Cards (the workhorse — one canonical card)
**Before:** TWO parallel card systems (`.card` dark-glass vs `.proof-card`/`.pricing-card` light) plus ≥4 bespoke "stat tile" treatments invented per page (Source 2 P5); lit-paper / dither / guilloche decoration.
**After — ONE `.card`:**
- `background: rgba(255,255,255,0.04)` over `--paper`, `border: 1px solid var(--line)`, `border-radius: var(--r-lg)` (8px), `padding: var(--s5)` (24px), `box-shadow: var(--ring-inset)`.
- Hover: `background: rgba(255,255,255,0.06)`, `border-color: var(--line-2)`, 150ms. Optional `--glow-accent` on one feature card only.
- Title `--fs-h4` (18px/510), body `--fs-body` `--ink-2`, label `--fs-eyebrow` `--ink-3`.
- Keep `.card`, `.step`, `.tier`, `.flow__node` class names (JS `wirePointerLight` feeds `--mx/--my`). Restyle freely.
- DELETE decorative variants: `.guilloche`, `.dither-edge`, `.seam`, `.regmark`, `.microprint`, `.num-ghost`, AND the lit-paper treatment **as applied to generic cards**. **Important distinction:** the lit paper-white sheet is NOT deleted — it is *promoted* to the signature `.artifact` component (§7.12). Strip it from ordinary `.card`s so it stops being a generic decoration; concentrate ALL of its light into the one signed `.kolm` exhibit, which is the brightest object on the page. The card system is dark-glass; the artifact is paper. That contrast is the whole brand.
- **Consolidate** the per-page families (`.infra-map`, `.control-radar`, `.control-tile`, `.proof-card`, `.pricing-card`, `.docs-panel`, `.control-system`, `.workbench`, …) onto this one `.card` + variants `.card--stat`, `.card--feature`, `.card--panel` — but `.artifact` and `.runtime-targets` are NOT folded into `.card`; they are the two standalone signature components (§7.12–7.13).

### 7.5 Sections
**Before:** light page interrupted by dark `.section--ink` bands mid-scroll (light→black→light→black, Source 2); no shared transition logic. `.section--ink` is used on **37 pages**, and its dark-band effect was produced by TWO nested `--paper:#101619` regimes that we are deleting: `kolm-main.css:1476` (`.compiler-code` / `.kolm-surface-media`) and `kolm-main.css:1558` (`.compiler-site--paper .section--ink`). Once the page is globally dark and those two regimes are gone, `.section--ink` would flatten into the page unless it is **re-specified in the shared layer**.

**After:** the whole page is dark, so `.section` is just vertical rhythm (`padding-block: var(--section-y)`), `--maxw` wrap, optional hairline top divider. **`.section--ink` is repurposed as the dark instrument panel** for terminals / the verifier / code — a *slightly* raised band, not a color flip. Provide this concrete, applyable rule in `kolm-2026.css` (it **replaces**, and must not coexist with, the deleted 1476/1558 regimes):

```css
/* raised instrument band — replaces the two deleted --paper:#101619 regimes */
.section--ink {
  background: var(--ink-deep);                 /* #0D0E10, one step off --paper */
  box-shadow: var(--ring-inset);               /* inset top-light: reads "lit from within" */
  border-block: 1px solid var(--line);         /* hairline top + bottom edge */
}
.section--ink::before {                        /* keep the existing overhead-lamp glow, retuned */
  background: radial-gradient(760px 340px at 50% 0%, rgba(63,229,160,0.06), transparent 70%);
}
```

**Code surfaces lose their `#101619` base too.** `.compiler-code` and `.kolm-surface-media` (formerly fed by the 1476 regime) must get an explicit base in the same edit, matching §7.7:
```css
.compiler-code, .kolm-surface-media {
  background: var(--ink-deep);                 /* or #0A0B0C for the darkest code well */
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
}
```
No more whiplash; every former dark band now derives from the one `:root` instead of a nested regime.

### 7.6 Pricing tiers
**Before:** bespoke 75-line inline `<style>` in `pricing.html`; blue + gold bar fills; per-page `pricing-card h3` at 25px.
**After:**
- Built from the canonical `.card` → `.tier`. 3 anchor tiers (Free / Pro / Enterprise) as a strip; featured tier gets `--accent-edge` ring + `--ring-inset`, never a different bg color.
- Comparison table: **hairline row dividers** (`--line`), row height 56px, **numbers in mono, right-aligned**, header row `--ink-3` uppercase 12px. **No zebra striping** (reads cheap), no blue/gold fills.
- Price in `--fs-price` mono. Migrate the inline `<style>` onto `--s*` tokens and the shared `.tier`.
- Tease 3 tiers on the homepage (Source 3 row 6).

### 7.7 Code blocks (core differentiator)
**Before:** code hidden behind `/docs`; fake-terminal macOS traffic-light dots (`api-control-center.html:154`) — a 2018-era cliché (Source 2 P6).
**After:**
- `background: var(--ink-deep)` / `#0A0B0C`, `border: 1px solid var(--line)`, radius 8px, padding 16–20px, mono, line-height 1.55.
- Syntax: near-monochrome — comment `--ink-3`, string `--accent-text`, keyword `--cool`. 2–3 low-saturation tints max. NO rainbow.
- **DELETE** the traffic-light dots. A code block needs no window chrome; at most a tiny mono filename label top-left in `--ink-3`.
- Surface real `curl`/CLI quickstart on the homepage (Source 3 row 3 — highest-impact addition).

### 7.8 Dashboard / control-center
**Before:** `account/api-control-center.html` forks a whole 4th system: inline `:root`, third green `#75ff9d`, 84px hero, ~230 bespoke lines, traffic-light dots.
**After:** joins the canonical system. Loads `kolm-2026.css` (+ shared compiler components), drops its inline `:root` and bespoke component block.
- Panels = `.card--panel` (`--paper-2`, hairline, 12px radius, `--ring-inset`).
- Data-viz: accent as the SINGLE data hue with low-opacity area fills; gridlines `--line-micro` (`rgba(255,255,255,0.04)`); no 3D, no drop shadows, no rainbow series, 1–2 hues max.
- Hero uses `--fs-hero` (no 84px). State classes for the seal/verifier (`.seal.is-sealed/.is-void/.is-pending`, `.field`, `.vw`, `.rep`) are PRESERVED (JS-driven) — restyle only.

### 7.9 Forms / inputs
**After (Linear pattern):** `background: rgba(255,255,255,0.02)`, `border: 1px solid var(--line)`, radius 6px, padding `12px 14px`, `--fs-body`. Focus → `border-color: var(--accent)` + composite ring `0 0 0 2px rgba(63,229,160,0.40), 0 0 0 4px rgba(63,229,160,0.18)`. Placeholder `--ink-3`.

### 7.10 Footer
**Before:** mismatched footers across compiler/legal/audit pages.
**After:** ONE compiler footer (the index/compiler-product base): columns Compiler · Surfaces · Trust · Company. `--paper` bg, top hairline `--line`, links `--ink-2`→`--ink` hover, 14px. Tiny mono build/version stamp in `--ink-3`. Applied to all 51 pages.

### 7.11 Eyebrow / kicker
**Before:** `§`-prefixed forensic mono tag; the 3-dot blue/green/amber `.compiler-kicker::before` glyph confetti.
**After:** mono, uppercase, 12px, `0.08em`, `--ink-3`. DROP the `§` glyph and the 3-dot mark (expose `--eyebrow-mark` as empty by default; audit variant may set it). No decorative confetti.

### 7.12 SIGNATURE — the lit `.kolm` artifact (the brand's hero image)
This is **the** differentiator and the homepage's defining visual. It is NOT a generic card and NOT a "kept field-canvas note" — it is the single brightest object on any page it appears on, designed so the eye lands on a paper-white signed exhibit floating in the near-black chamber. The contrast IS the brand (§0, §1.7). Class: `.artifact` (existing; restyle, don't restructure — `wirePointerLight` and the verifier state classes ride on it).

**Exact treatment (the brightest-object contract):**
- **Surface:** `background: var(--sheet)` (`#F3F5F2`) — the only large light fill in the dark system. Sheet text in `--sheet-ink`; meta in `--sheet-ink-2`/`--sheet-ink-3`; the signed-green checkmarks/labels in `--sheet-accent` (AA-corrected, §3.7).
- **Border / form:** `border-radius: var(--r-xl)` (12px), `border: 1px solid var(--sheet-line)`, with a `--sheet-high` top specular so the paper itself looks lit. No drop-shadow box; the elevation comes from the glow pool below, not a gray shadow.
- **The light pool (what makes it the brightest object):** keep `.artifact::before` as a real radial glow *behind* the sheet — warm-white core with a phosphor rim and a faint floor reflection:
```css
.artifact { position: relative; box-shadow: var(--shadow-lg); }     /* lg reserved for artifact + modals only */
.artifact::before {
  content: ""; position: absolute; inset: -56px -64px; z-index: -1; pointer-events: none;
  background:
    radial-gradient(58% 58% at 50% 42%, rgba(233,243,238,0.18), rgba(63,229,160,0.05) 54%, transparent 74%),
    radial-gradient(50% 22% at 50% 102%, rgba(233,243,238,0.06), transparent 70%);
}
```
- **The phosphor filing edge** (`.rep::before`): keep the 2px green strip down the bound side — the one place the accent touches the artifact as *material*, not glow. This is a deliberate signature detail; preserve it.
- **Contrast budget:** the artifact may be the ONE place the ≤2-accent-per-viewport rule is relaxed for the green-on-paper status marks, because they read as *content of the exhibit*, not as competing UI accents. Nothing else on the page may be as bright as the sheet.
- **Homepage role:** this is the right-column hero visual on `index.html` (§7.3, §11 row 0) — the defining image, paired with the `compiler-machine` lanes. The lit sheet is the thing a first-time visitor remembers.

### 7.13 SIGNATURE — the runtime-shrink diagram (phone → edge progression)
The second genuinely-ours asset (§0, §2.3): the product "shrinks to the smallest place it can live." Elevate the device/runtime-target grid from a passive grid into a **first-class progression diagram component** — a horizontal ladder that visibly *narrows* left→right. Class: `.runtime-targets` (new canonical component; consolidate the existing device grid onto it).

**Spec:**
- **Layout:** a single horizontal track, left→right: `hosted → server → laptop → edge → phone`, with each successive node rendered **smaller** (scale the node box and its label down ~12–16% per step) so the shrink is *visible*, not just labeled. On `max-width:760px` it stacks vertically, largest→smallest.
- **Connective tissue:** a hairline `--line` baseline runs through all nodes; the active/target node gets `--accent-edge` ring + `--ring-inset`. At most ONE node is accent-highlighted at a time (the "compiled-to-here" target). The `--cool` hue is permitted on the connector route (the one sanctioned diagram use of `--cool`, §3.4) — never on the nodes' fills.
- **Node:** `.card`-derived (fill `rgba(255,255,255,0.04)`, hairline, `--ring-inset`), mono device label in `--ink-3`, a single metric (e.g. artifact size / latency) in `--fs-metric` mono. No icons-as-decoration; if a glyph is used it is a single monoline form in `--ink-3`.
- **Honest-scope note** stays (the differentiator is credibility): a one-line `--fs-sm` `--ink-3` caption stating what actually runs where. Do not oversell.
- **Motion:** on reveal, a single left-to-right `.in` fade-up stagger (~60ms) that traces the shrink direction — once, reduced-motion-gated. No looping.
- This and the lit artifact are the two visuals the homepage is built around; everything else is restraint.

---

## 8. CSS unification plan (kolm-2026.css + kolm-main.css)

**The trap to avoid (Source 2 P0 / Source 4):** editing `:root` in `kolm-2026.css` changes NOTHING on the **21 light pages**, because `.compiler-site--paper` (`kolm-main.css:27–67`, loaded only by those 21) and the **four** per-page inline `:root` blocks (§3.8.1) win the cascade. So unification is the prerequisite, not an afterthought.

**Target end-state: ONE token world in `kolm-2026.css :root`, `kolm-main.css` reduced to net-new compiler *components* only (no token redefinitions, no light-tuned component rules), and zero per-page `:root`.**

Steps:
1. **Promote the canonical dark tokens (§3–§6) into `kolm-2026.css :root`.** This is the only place tokens live.
2. **Delete the entire `.compiler-site--paper` *token* block** (`kolm-main.css:27–67`) and its repair rules (`:82–91` heading un-clip, `:93–100` grid `::before`). The light token world is gone. **This is necessary but NOT sufficient — see step 7 for the ~230 light-tuned *component* rules that also live under `.compiler-site--paper*` and will keep painting unless handled.**
3. **Delete the `.compiler-site` reactor token block** (`kolm-main.css:7–25`). The 4-hue palette and `--acid*` are gone.
4. **Delete the nested dark regimes** `--paper:#101619` at `kolm-main.css:1476` (`.compiler-code`/`.kolm-surface-media`) and `:1558` (`.compiler-site--paper .section--ink`) — and **re-specify `.section--ink` and the code surfaces in the shared layer per §7.5** (they flatten otherwise; `.section--ink` is on 37 pages).
5. **Delete ALL FOUR per-page inline `:root` blocks (verified line ranges — see §3.8.1 and §8.5):** `account/api-control-center.html:18–38` (+ its `:39` `scroll-padding-top`), `account/overview.html:18–34`, `dashboard.html:18`, and `docs/api.html:26` + `:27` (`[data-theme=light]`) + `:138`. Migrate `docs/api.html`'s bespoke token names and blue accent per §3.8.2. These pages then inherit the canonical `:root`. **Phase-exit gate:** `grep -rl ':root' public/**/*.html` returns empty.
6. **Keep** in `kolm-main.css` only the genuinely net-new compiler *components* (`.compiler-hero` good parts, `.lane-step`, `.pipeline-card`, `.compiler-machine`, `/v1` contract list) — restyled to the new tokens, then folded into the canonical card/section vocabulary where they duplicate it.
7. **Body class + the ~230 light-tuned component rules (BLOCKER — the "inert no-op" recommendation is REMOVED as unsafe).** Deleting the `.compiler-site--paper` *token* block does **not** make the class inert: `kolm-main.css` contains **230 rules scoped to `.compiler-site--paper*`** (verified: `grep -c compiler-site--paper kolm-main.css` = 230), the vast majority of which are **light-tuned COMPONENT rules** — hero/kicker/CTA/code fills, borders, and text colors (e.g. `.compiler-site--paper-home .compiler-hero`/`.hero__h1`/`.compiler-kicker`/`.hero__cta--home .btn--primary` at lines ~318–526; `.compiler-site--paper-integrations` blocks). As long as the class stays in the markup, these descendant rules keep matching and keep painting **light-on-dark fills/borders/CTAs over the now-dark base — the homepage hero, kicker, and CTAs render broken.** Keeping the class "inert for one release" does NOT prevent this. **Do ONE of:**
   - **(a) PREFERRED — strip the class in the SAME phase you flip to dark.** Remove `compiler-site--paper` (and `-home`/`-integrations`) from all 21 pages' markup so the 230 rules stop matching. **Update `kolm-2026.js:74` FIRST** (remove the `.compiler-site--paper` early-return so the IntersectionObserver nav-CTA path runs everywhere — or default to `is-solid` when no `.hero`). For `index.html` specifically, the home hero MUST be rebuilt on the canonical `.hero/.hero__grid` BEFORE the class is stripped (see §8.7 / Phase 5) so the flagship hero geometry survives.
   - **(b) ALTERNATIVE — keep the class but delete/rewrite ALL 230 `.compiler-site--paper*` descendant component rules** (not just the four token blocks), porting any still-needed layout to unscoped canonical selectors. Only valid once **zero** light-tuned descendant rules remain.
   - **Phase-exit gate (gating, either path):** `grep -c compiler-site--paper kolm-main.css` == 0 AND `grep -rl 'compiler-site--paper' public/**/*.html` == empty (path a) — i.e. no light-tuned rule and no class reference survives.
8. **Keep the legacy alias block** (`kolm-2026.css:136–148`) repointed at new values — audit/legacy pages depend on it.
9. **Phase 6 (optional, post-stable):** inline the surviving `kolm-main.css` components into `kolm-2026.css` and drop the second `<link>`. Not required for launch.

Net: one `:root`, one accent, one heading model, one card, one nav, one footer. The cascade lever is unlocked.

### 8.5 Inline `:root` inventory (the four cascade-defeating pages — deletion targets)
Authoritative list with verified line ranges; mirrors §3.8.1. All four are deleted/migrated in Phase 2; the `grep -rl ':root' public/**/*.html → empty` gate enforces it.

| Page | Lines to delete | Notes |
|---|---|---|
| `account/api-control-center.html` | `18–38` (`:root`) + `39` (`html{scroll-padding-top:86px}`) | third green `#75ff9d`; joins canonical dark |
| `account/overview.html` | `18–34` | currently LIGHT (`--paper:#e4ece7`); inherits dark after deletion — verify renders clean |
| `dashboard.html` | `18` (single-line block) | currently LIGHT (`--paper:#e4ece7`); inherits dark — verify renders clean |
| `docs/api.html` | `26` (dark, blue accent) + `27` (`[data-theme=light]`) + `138` (light) | migrate `--bg/--bg-elev/--ink-mute` → canonical; blue `#2563eb` → `--accent`; retire toggle (§3.8.2) |

### 8.7 `index.html` body classes — `compiler-site--paper-home` (BLOCKER for the flagship page)
The homepage `<body>` is `class="compiler-site compiler-site--paper compiler-site--paper-home"`. The **third** class, `compiler-site--paper-home`, scopes the ENTIRE home hero across **82 references / ~25+ rules** in `kolm-main.css` (verified `grep -c compiler-site--paper-home kolm-main.css` = 82), including the hero geometry: `.compiler-hero .hero__grid` (`:318`), `.hero__h1` (`:323`), `.lede` (`:332`), the hero `::before`/`::after` glow scaffolding (`:349`), `.hero__copy` (`:438`), `.compiler-kicker` (`:459`), and the home CTAs `.hero__cta--home .btn--primary/--ghost` (`:495–526`).

**Why this is launch-unsafe if mishandled:** if the paper *tokens* are deleted while these `-home`-scoped *layout* rules remain (the rejected "inert no-op" path), OR if the class is stripped before the hero is rebuilt, the flagship hero loses its grid columns, H1 sizing, lede styling, CTA fills, and glow scaffolding — and `index.html` is the one page the owner most cares about converting. The "inert no-op for one release" path is therefore **explicitly disallowed for `index.html`** (it is also disallowed globally per step 7, but called out here because the home hero's geometry lives entirely under this class).

**Required sequence for `index.html` (re-sequences Phase 2/5 for this page):**
1. **Phase 5 first for the home hero:** rebuild the hero on the canonical unscoped `.hero` / `.hero__grid` (§7.3) — port the grid columns, H1/lede sizing, glow, and the two CTAs onto unscoped selectors using the new tokens — and adopt the lit-artifact signature visual (§7.12) in the right column.
2. **Only then** strip `compiler-site--paper compiler-site--paper-home` from `index.html`'s `<body>` (with `kolm-2026.js:74` already updated, step 7a).
3. Verify the home hero geometry against the Phase 0 baseline screenshot before/after the class strip.

"Inert no-op for one release" applies, at most, to **non-home** paper pages — and even there only if their light-tuned descendant rules are confirmed neutralized (step 7). For the home page it does not apply at all.

---

## 9. Cascade-first implementation phases (with risk)

Each phase is independently shippable; the site stays launch-ready throughout.

**Phase 0 — Decide + snapshot. RISK: low.** Lock dark-canonical. Capture before/after screenshots of all 51 pages (visual-regression baseline). Inventory the **verified 21 light (`.compiler-site--paper`, all load `kolm-main.css`) / 30 dark** split — NOT the earlier "27 / 24". Note that `kolm-main.css` deletions affect only those 21; the other 30 are untouched by them. Flag the four inline-`:root` pages (§8.5), the `compiler-site--paper-home` flagship (§8.7), and the 230 light-tuned component rules (§8 step 7) as the three highest-risk items for the baseline.

**Phase 1 — Tokens. RISK: low (highest leverage).** Edit `:root` color/type/spacing/radius/shadow/motion tokens in `kolm-2026.css` ONLY (§3–§6). Repoint legacy aliases (and retain the full superset, §3.7 / Appendix — do NOT drop `--ease-exp`, `--shadow-tint`, `--light-top`, `--dur-1/2/3`, `--graphite*`, `--ink-hot/silver/shadowed`, `--sheet-high*`, `--sheet-line-2`, `--sheet-ink-3`, `--sheet-accent-soft`, `--accent-deep`). Touch no component rule yet. Verify `--paper` resolves to a literal `#hex` for `kolm-2026.js:13` theme-color; `--accent`/`--cool` only need to be valid CSS colors for the `kolm-field.js` canvas probe (keep hex for simplicity).

**Phase 2 — Collapse the token worlds + neutralize light-tuned rules. RISK: medium→high (the real unlock and the riskiest step).** In one coordinated change:
- Delete `.compiler-site--paper` token block + `.compiler-site` reactor block + the two nested `--paper:#101619` regimes (`kolm-main.css:1476`/`:1558`) and re-specify `.section--ink` + code surfaces in the shared layer (§7.5).
- Delete/migrate ALL FOUR inline `:root` blocks (§8.5): `account/api-control-center.html:18–38`+`39`, `account/overview.html:18–34`, `dashboard.html:18`, `docs/api.html:26`+`27`+`138` (migrate its token names/blue accent, retire `[data-theme]`, §3.8.2).
- Neutralize the **230 `.compiler-site--paper*` light-tuned component rules** via §8 step 7 path (a) — strip the class from all 21 pages — having **updated `kolm-2026.js:74` first**. For `index.html`, the home hero must already be rebuilt on canonical `.hero` (Phase 5 sequenced before the class strip, §8.7).
- Now the one `:root` actually reaches every page. **Phase-exit gates (all gating):**
  - `grep -rl ':root' public/**/*.html` → empty
  - `grep -rl '\[data-theme' public/**/*.html` → empty
  - `grep -c compiler-site--paper kolm-main.css` → 0 (and `grep -rl 'compiler-site--paper' public/**/*.html` → empty if path a)
- **Test matrix (all four formerly-inline-`:root` pages + a former bare dark page):** `api-control-center`, `account/overview`, `dashboard`, `docs/api`, plus `index.html`. Check on each: nav CTA fill (`kolm-2026.js:74`), `<meta theme-color>` sync, field palette, and that the page now reads canonical dark (the two former LIGHT pages — `overview`, `dashboard` — must not render light-on-dark remnants).

**Phase 3 — Shared components. RISK: medium.** Rebuild nav, buttons, card (+ stat/feature/panel variants), section (incl. the concrete `.section--ink` rule, §7.5), tier, code block, inputs, footer, eyebrow in `kolm-2026.css` (§7). Build the two SIGNATURE components: the lit `.kolm` artifact (§7.12) and the `.runtime-targets` shrink diagram (§7.13). **Remove the heading `@supports` clip block (`kolm-2026.css:1037–1050`) — BOTH the parent silver clip AND the `.go` child clip in the same edit — and broaden the surviving solid `.go` rule per §4.4.** Retire decorative components (grain, aurora, guilloche, dither, seam, regmark, microprint, ghost ordinals, traffic-lights, 3-dot kicker). Restyle JS-coupled classes; never rename them. Cascades to all 51. **Visual-regression check `.go` on a page that uses it in a heading** (it must render solid green, not transparent/invisible).

**Phase 4 — Consolidate per-page families. RISK: medium.** Point the per-page bespoke component families (`pricing.html`, `docs.html`, `account/api-control-center.html`, homepage `infra-*`) at the canonical `.card`/`.tier`/`.section`. Migrate inline `<style>` values onto `--s*`. Per-page but bounded.

**Phase 5 — Flagship homepage. RISK: medium→high (must precede the `index.html` class strip).** Because the home hero geometry lives entirely under `compiler-site--paper-home` (§8.7), the hero rebuild here is a **prerequisite for stripping the paper classes from `index.html` in Phase 2** — sequence accordingly (rebuild the home hero on canonical `.hero/.hero__grid` with the lit-artifact signature, THEN strip the class). Reorder per the §11 blueprint: hero (product, not console) → the loop (restore *compose*) → problem → quickstart code → runtime targets (the §7.13 shrink diagram) → compress 6 governance modules → 1 → pricing tease → quiet audit card → final CTA. Fix hero copy + meta (compiler-first, not "control plane"). Standardize nav + footer.

**Phase 6 — Sweep + cleanup. RISK: low.** Walk all 51 pages for stragglers: outlier body classes (`rv`, `tc`, `api-reference-page`), subdir pages (`account/`, `docs/`, `security/`, `solutions/`), inline dark overrides, dead `data-design-reference`, legacy vault CSS, the abandoned 84px hero, ASCII arrows, and the now-unaccounted self-hosted `Geist.woff2`/`GeistMono.woff2` in `/fonts` (either adopt as a sanctioned face or remove from the build — do not leave dead woff2 in the critical path; either way stay self-hosted, no CDN). **Note:** the `compiler-site--paper*` class removal already happened in Phase 2 (step 7a); there is NO "inert class" left to remove here (that recommendation was withdrawn). Re-run the Phase 2 grep gates as a final guard. Optionally collapse to one stylesheet.

**Phase 7 (optional) — audit.kolm.ai variant. RISK: low.** Add the ≤20-line `.surface--audit` override (§3.9) and re-home audit pages on the subdomain with the compiler nav + an Audit entry point.

---

## 10. Functional do-not-break list

**HARD — JS reads these token names at runtime. Change values only; never rename:**
- `--paper` — **the ONLY token with a literal-`#hex` requirement, and only for `kolm-2026.js:13`** (theme-color sync: it bails unless `paper.charAt(0)==='#'`, so an `rgb()`/`var()` value silently skips the `<meta theme-color>` update for `--paper`). Keep `--paper` a literal hex.
- `--accent`, `--cool` (and `--paper`) — read by `kolm-field.js:67–75`, which resolves them through a **2D-canvas `fillStyle` probe** that tolerates ANY valid CSS color (hex, `rgb()`, `hsl()`, `var()`-resolved). The field does **NOT** require hex (the earlier "`kolm-field.js:75` requires a `#hex` / `rgb()` silently breaks the field" claim was wrong — corrected here and in §0). Keeping hex is recommended only for simplicity, not correctness.

**HARD — class-name contracts JS depends on (rename breaks behavior):**
- `.compiler-site--paper` — `kolm-2026.js:74` (`wireNavCta`) early-returns `is-solid` when the body carries it. **If you strip the class (§8 step 7a / Phase 2), update `kolm-2026.js:74` FIRST** (remove the early-return so the IntersectionObserver path runs, or default to `is-solid` when there is no `.hero`) — otherwise the nav-CTA fill regresses on every declassed page. **Do NOT keep the class as an "inert no-op": its ~230 light-tuned descendant rules in `kolm-main.css` keep matching and paint light-on-dark (BLOCKER, §8 step 7). `grep -c compiler-site--paper kolm-main.css` must reach 0.**
- `.compiler-site--paper-home` (index.html only) — scopes the entire home hero geometry (§8.7). Rebuild the home hero on canonical `.hero/.hero__grid` BEFORE stripping it.
- `.nav`, `.nav__toggle`, `.nav__links a`, `.is-open` (`wireNav`); `.nav__cta`, `.is-solid` (`wireNavCta`).
- `.hero` — observed by `wireNavCta` IntersectionObserver.
- `.reveal`, `.in`, `[data-art-reveal]`, `[data-enter]` — reveal-on-scroll; `.in` is added by JS, do not repurpose.
- `.card`, `.step`, `.tier`, `.flow__node` — `wirePointerLight` feeds `--mx/--my`. Restyle freely; keep the classes on those elements.
- `.seal.is-sealed/.is-void/.is-pending`, `.field`/`.field.ready`, `.vw`, `.rep` — `verify-widget.js`, `kolm-field.js`, `report-viewer.js`. Preserve state-class names. (These rules consume the `--sheet-high*` family — keep those tokens; see Appendix.)

**HARD — `.go` accent-word span (19 pages):** the heading `@supports` block (`kolm-2026.css:1037–1050`) clips BOTH the parent heading AND `.go`. Remove BOTH rules together (§4.4); leaving the `.go` clip after deleting the parent makes `.go` render **invisible** (transparent fill, no inherited gradient) on clip-capable browsers. After removal, the broadened base `.go { color/-webkit-text-fill-color: var(--accent-text) }` (from `kolm-2026.css:466`) is the only surviving `.go` styling — the green emphasis word stays, as a solid accent.

**HARD — Appendix `:root` is now a true SUPERSET (safe whole-block replacement); do NOT re-omit consumed tokens.** Every token below is consumed by live `var()` rules and is present in the Appendix with its retained original value (or an explicit alias). Verified still-consumed: `--ease-exp` (12 uses, incl. `.card` transition), `--shadow-tint` (6, incl. `.card` box-shadow), `--light-top` (4), `--sheet-high*` (13, the JS-preserved `.vw`/`.sev` verifier — note `--sheet-high` is a WARM specular `#B3401F`, not a white; keep as-is), `--sheet-line-2` (7), `--sheet-ink-3`, `--sheet-accent-soft`, `--graphite*`, `--ink-hot/silver/shadowed` (only removable once the `@supports` clip block is deleted, §4.4), `--dur-1/2/3`, `--accent-deep`. The Appendix keeps the ORIGINAL values so rendering is unchanged; only `--sheet-accent` is intentionally AA-corrected. A whole-block replacement that omits these degrades shadows, `.card` easing, and the lit-artifact/verifier rendering — so use the Appendix block verbatim, do not trim it.

**MEDIUM — layout primitives: restyle (color/border/shadow/font), do NOT restructure (display/grid-template/max-width) without full-site visual check:**
- `.wrap`, `.grid--2/3/4` + breakpoints, `.hero__grid` columns, `.tiers`/`.flow`/`.steps`/`.metrics` templates, `.section` rhythm.
- `.section--ink` (37 pages) — its dark-band look came from two now-deleted `--paper:#101619` regimes (`kolm-main.css:1476/1558`); it MUST be re-specified in the shared layer with the concrete rule in §7.5 or it flattens. Same for `.compiler-code`/`.kolm-surface-media` code surfaces.
- `[id]{scroll-margin-top}` + `scroll-padding-top` — keep equal to **nav height = 62px** (`kolm-2026.css:391`; the earlier "64px" was wrong). Reconcile the asymmetric offsets: `kolm-2026.css:186` (80px → 62px, **was missing from the update list**), `kolm-main.css:4,66` (86px → 62px), `kolm-main.css:73` (86px → 62px).
- Legacy alias block (`kolm-2026.css:136–148`) — keep, repoint; do not delete (dark/audit/legacy pages read them).

**MEDIUM — four per-page inline `:root` blocks defeat the cascade (§3.8.1 / §8.5):** `account/api-control-center.html`, `account/overview.html`, `dashboard.html`, `docs/api.html` — all four must be deleted/migrated in Phase 2, not just the one. `docs/api.html` additionally ships a `[data-theme=light]` toggle and a blue `--accent:#2563eb` that contradict "dark-only / one green" — retire the toggle and repoint the accent (§3.8.2). Gate: `grep -rl ':root' public/**/*.html` and `grep -rl '\[data-theme' public/**/*.html` both empty.

**LOW — safe to change anytime:** all decorative `::before/::after` washes, grain, aurora, regmarks, microprint, dither, ghost ordinals, shadow/radius/font-size values.

**Process guards:** keep the W921 fail-open reveal IIFE in `<head>`; do not introduce a CDN font (CSP); keep all faces self-hosted woff2 (and resolve the unaccounted `Geist.woff2`/`GeistMono.woff2` — adopt or remove, §Phase 6); respect `prefers-reduced-motion` on every animation; one full-site screenshot diff per phase; run the Phase 2 grep gates (`:root`, `[data-theme`, `compiler-site--paper`) in CI.

---

## 11. Homepage section blueprint

Spine = **problem → product → how (with code) → proof → pricing → CTA** (the vast/runpod/modal pacing). Today's homepage inverts this (console → governance×6 → loop). Mostly reorder/compress within `index.html`; components already exist in `compiler-product.html`, `docs.html`, `pricing.html`.

| # | Section | Job | Source / change |
|---|---|---|---|
| 0 | **Hero** | value + the loop + dual CTA | Adopt `compiler-product.html` hero. Eyebrow `THE AI COMPILER`. H1 **"API behavior in. Device-fit models out."** Lede = the collection-wrapper/compiler sentence. Primary **Get an API key** (`/signup`); ghost **Read the docs** (`/docs`). Right side: `compiler-machine` lanes (capture/compile/compose/deploy) + one low-alpha accent glow + `.field`. |
| 1 | **The loop** | capture → compile → compose → deploy in 4 cards | Reuse the 4-row surface list. **Restore the missing 4th C — compose (`/v1/compose`).** Today's `#pipeline` shows only 3. |
| 2 | **The problem** | the pull | "You're renting the same behavior on every call; compile it once, run it where it fits." Homepage has no problem statement today. |
| 3 | **Quickstart (code)** | 3 curl/CLI commands: route → compile → serve | Pull the `docs-code` block from `docs.html` onto the homepage. Real code on the homepage = highest-impact addition. Dark `.section--ink` instrument panel. |
| 4 | **Runtime targets** | "shrink to the smallest place it can live" | Keep the device grid (phone/laptop/server/edge/hosted) + honest scope note. Genuine differentiator vs the GPU trio. |
| 5 | **Proof / trust** | signed `.kolm`, receipts, `/v1` contract | **Compress today's 6 governance modules → 1 band.** Keep the live `/v1/...` endpoint list (`infra-contract`). Cut `control-radar`, `category-control-matrix`, `control-kernel`, `proof-ledger`, `infra-path` to `/platform`. |
| 6 | **Pricing tease** | 3 anchor tiers → `/pricing` | New on homepage. Free / Pro / Enterprise strip via the shared `.tier`. |
| 7 | **Audit (secondary)** | one quiet card → audit.kolm.ai | Shrink the current full two-CTA section to a single line + link. |
| 8 | **Final CTA** | "Route one namespace through Kolm" | Keep `cta-final`; strong as-is. Restyle to the new dark CTA band. |

**Meta fix:** `index.html` title/OG/Twitter currently say "behavior-to-artifact control plane / enforce policy / export governance evidence" (auditor language). Rewrite compiler-first: *"The AI compiler: capture API behavior, compile signed artifacts, deploy to devices."*

---

## Appendix — canonical `:root` (FULL SUPERSET — safe whole-block replacement)

**Read this first.** This block is a **true superset**: it carries every new token AND every legacy token that live `kolm-2026.css`/`kolm-main.css` rules still consume via `var()`. It is therefore safe to use as a whole-block replacement of the current `kolm-2026.css :root` **without dropping any consumed token**. (The earlier draft's Appendix omitted `--ease-exp`, `--shadow-tint`, `--light-top`, `--dur-1/2/3`, `--graphite*`, `--ink-hot/silver/shadowed`, `--sheet-high*`, `--sheet-line-2`, `--sheet-ink-3`, `--sheet-accent-soft`, `--accent-deep` — dropping those degrades `.card` shadow/easing, the lit-artifact, and the JS-preserved verifier. They are all present below, either with real values or aliased to a new token.) The `--ink-hot/silver/shadowed` trio is only safe to delete **after** the heading `@supports` clip block (`kolm-2026.css:1037–1050`) is removed per §4.4; until then it is retained here.

```css
:root{
  /* surfaces */
  --paper:#08090A; --paper-2:#0F1011; --paper-sink:#0C0D0E; --raised:#191A1B;
  --ink-deep:#0D0E10; --ink-deep-2:#141517; --ink-deep-sink:#08090A;
  /* foreground */
  --ink:#F7F8F8; --ink-2:#D0D6E0; --ink-3:#8A8F98; --ink-4:#62666D; --ink-faint:#3A3D42;
  --on-ink:var(--ink); --on-ink-2:var(--ink-2); --on-ink-3:var(--ink-3);
  /* accent (verification) */
  --accent:#3FE5A0; --accent-hi:#6BF0B8; --accent-press:#33CC8C; --accent-text:#5EE8AD;
  --accent-soft:rgba(63,229,160,.12); --accent-tint:rgba(63,229,160,.06); --accent-edge:rgba(63,229,160,.30);
  --on-accent:#062A1D;
  --accent-deep:#5FEDB1;  /* legacy original value, retained (consumed by the .go path) */
  /* second light */
  --cool:#6FA6E8; --cool-soft:rgba(111,166,232,.10); --cool-edge:rgba(111,166,232,.28);
  /* hairlines */
  --line:rgba(255,255,255,.07); --line-2:rgba(255,255,255,.12); --line-top:rgba(255,255,255,.14); --line-micro:rgba(255,255,255,.04);
  /* status */
  --void:#E0A89F; --void-soft:rgba(224,168,159,.12); --void-edge:rgba(224,168,159,.34);
  /* the lit sheet (FULL family — consumed by .artifact/.vw/.sev/.rep). Values are the
     RETAINED originals so rendering is unchanged; only --sheet-accent is AA-corrected. */
  --sheet:#F3F5F2; --sheet-2:#EBEEE9;
  --sheet-high:#B3401F; --sheet-high-soft:rgba(255,130,102,.14); --sheet-high-edge:rgba(255,130,102,.35);  /* warm specular tint — keep as-is */
  --sheet-ink:#111613; --sheet-ink-2:#4C554F; --sheet-ink-3:#6B746E;
  --sheet-line:rgba(17,22,19,.10); --sheet-line-2:rgba(17,22,19,.26);
  --sheet-accent:#0B7A4C; --sheet-accent-soft:rgba(14,138,87,.10);  /* --sheet-accent AA-corrected from #0E8A57 (§3.7); -soft retained */
  --sheet-void:#8A5A52;
  /* legacy metallic-heading trio — RETAINED ORIGINALS; KEEP until §4.4 clip block is deleted, then removable */
  --ink-hot:#FFFFFF; --ink-silver:#EAF0ED; --ink-shadowed:#A4B2AB;
  /* legacy neutrals still referenced by component rules — retained originals */
  --graphite:#1A2123; --graphite-2:#232B2D; --light-top:rgba(238,246,242,.30); --shadow-tint:rgba(4,8,9,.55);
  /* type */
  --display:"Switzer",system-ui,sans-serif; --sans:"Switzer",system-ui,sans-serif;
  --mono:"Spline Sans Mono",ui-monospace,Menlo,Consolas,monospace;
  --weight-text:400; --weight-ui:510; --weight-display:590; --tracking-display:-0.022em;
  --fs-hero:clamp(40px,5vw,64px); --fs-h1:clamp(33px,4vw,52px); --fs-h2:clamp(27px,3vw,38px);
  --fs-h3:clamp(19px,1.6vw,22px); --fs-h4:18px; --fs-lede:clamp(17px,1.5vw,19px);
  --fs-body:16px; --fs-sm:14px; --fs-eyebrow:12px; --fs-metric:clamp(30px,3.2vw,44px); --fs-price:clamp(28px,2.6vw,36px);
  /* spacing + grid */
  --s1:4px; --s2:8px; --s3:12px; --s4:16px; --s5:24px; --s6:32px; --s7:48px; --s8:64px; --s9:96px; --s10:128px;
  --section-y:clamp(80px,10vw,128px); --rhy-1:clamp(40px,4.5vw,64px); --rhy-2:clamp(64px,7.5vw,104px); --rhy-3:var(--section-y);
  --maxw:1200px; --maxw-prose:680px; --gutter:24px;
  --nav-h:62px;  /* nav height; anchor offsets equal this (§5.4) */
  /* radius + elevation */
  --r-sm:2px; --r-md:6px; --r-lg:8px; --r-xl:12px; --r-pill:999px;
  --ring-inset:inset 0 1px 0 0 rgba(255,255,255,.06);
  --shadow-sm:0 1px 2px rgba(0,0,0,.40); --shadow-md:0 4px 16px -4px rgba(0,0,0,.50); --shadow-lg:0 16px 48px -12px rgba(0,0,0,.60);
  --glow-accent:0 0 0 1px var(--accent-edge),0 8px 40px -12px rgba(63,229,160,.25);
  /* motion */
  --dur-instant:100ms; --dur-fast:150ms; --dur-base:200ms; --dur-mod:320ms; --dur-slow:500ms;
  --ease:cubic-bezier(0.25,0.46,0.45,0.94); --ease-enter:cubic-bezier(0.165,0.84,0.44,1);
  --ease-exp:cubic-bezier(0.23,1,0.32,1);  /* legacy original (.card transition + 11 uses, §10). Or alias to var(--ease-enter) if unifying easing. */
  --dur-1:160ms; --dur-2:320ms; --dur-3:560ms;  /* legacy originals (retained); may alias to --dur-fast/base/mod once verified */
  /* legacy aliases (keep, repointed) */
  --bg:var(--paper); --panel:var(--paper-2); --hair:var(--line);
  --ok:var(--accent-text); --ok-soft:var(--accent-soft); --ok-edge:var(--accent-edge);
  --bad:var(--void); --bad-soft:var(--void-soft); --bad-edge:var(--void-edge);
  --foil:var(--accent); --foil-edge:var(--accent-edge);
  --d-ink:var(--ink); --d-muted:var(--ink-2); --d-rule:var(--line); --d-panel:var(--paper-2); --d-paper:var(--paper); --d-accent:var(--accent);
}
```

> Verify before deleting any "legacy" token above: `grep -c '\-\-ease-exp' kolm-2026.css` (and likewise for each) must reach 0 before that token may be removed in a later sweep. Until then, the alias is load-bearing.
