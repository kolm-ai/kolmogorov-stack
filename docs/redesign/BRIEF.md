# kolm.ai "Verified" Redesign — Design Brief

Single source of truth. Build the entire site from this. No options, no hedging. Every call is made.

Locked: product is a fixed-fee Agent Security-Review Readiness audit that ends in an Ed25519-signed evidence report a Series-A founder hands to an enterprise buyer's security group to unblock one stalled $100k to $500k deal. Type is 100% Spline Sans Mono (400/500/600). Palette is light paper plus one signal green. Positioning is deal-unblocker, not a vendor of compliance.

---

## 1. North star

The site should feel like a **signed instrument** held up to the light: a passport data-page, a lab certificate, a financial statement. Calm, exact, expensive, still. Not a terminal, not a startup landing page, not a security dashboard. A skeptical security researcher should land and think "these people are precise" before reading a word.

**Design thesis:** *An all-monospace site reads premium only when it stops being text and becomes an instrument. Structure (ledger rows, register marks, tabular columns, a numbered section spine) carries the authority; one scarce green carries the single meaning that matters (verified). Everything else is ink, paper, and a hairline.*

The product's truth is the design's logic: **green present = verified, green absent = void.** That one rule runs the whole palette.

---

## 2. Color tokens

Locked anchors: paper `#F7F8F6`, ink `#0F1411`, accent `#11875A`, hairline `#E2E5E0`. All contrast ratios measured against paper `#F7F8F6` unless noted.

```css
:root{
  /* surfaces */
  --paper:      #F7F8F6;  /* page base */
  --paper-2:    #FFFFFF;  /* plates, cards, the evidence artifact (~5pt lift) */
  --paper-sink: #F1F2EF;  /* recessed wells, table headers, data rows only */

  /* ink ramp (role, not shade) */
  --ink:        #0F1411;  /* 17.5:1  AAA  body + headings */
  --ink-2:      #3A413D;  /*  9.8:1  AAA  secondary paragraphs, lede */
  --ink-3:      #565B57;  /*  6.5:1  AA   meta, labels, table th (>=12px only) */
  --ink-faint:  #8B918C;  /*  3.0:1  NON-TEXT ONLY: disabled, decorative numerals, control borders */

  /* lines */
  --line:       #E2E5E0;  /* 1.19:1 decorative dividers + card rest border */
  --line-2:     #8B918C;  /* 3.0:1  functional/interactive borders (inputs, ghost btn, framed widget) */

  /* accent (signal green) */
  --accent:      #11875A; /* 4.25:1 FAILS AA text. FILLS / UI / icons / text >=24px ONLY */
  --accent-deep: #0F7A50; /* hover fill;  white-on-this = 5.36:1 */
  --accent-press:#0C6B45; /* active fill; white-on-this = 6.55:1 */
  --accent-text: #0B6B45; /* 6.15:1 AA. the ONLY green allowed on text <=18px */
  --accent-soft: #E9F3EE; /* solid pass-pill / verified-row fill */
  --accent-tint: rgba(17,135,90,.07); /* verified-row wash over white */
  --accent-edge: #CFE3D8; /* 1px verified-pill / verified-card border */

  /* void / attention (tampered, not-verified). desaturated red-grey. NOT alarm-red, NOT green */
  --void:      #6E5854;  /* ~6.2:1 AA. the word VOID, the fracture strike */
  --void-soft: #F0EBEA;  /* void-row fill */
  --void-edge: #D9CFCD;  /* void-card border */

  --on-accent: #FFFFFF;  /* button labels; 4.53:1 on --accent, lock to >=15px/600 */
}
html{ color-scheme: light; }
```

AA verdicts, explicit:
- Text legal everywhere: `--ink`, `--ink-2`, `--ink-3` (down to 12px).
- `--ink-faint` NEVER carries copy. Non-text only.
- `--accent` NEVER carries text under 24px. Use `--accent-text` for inline "Verified", small green labels, the mapped-cell text.
- White on `--accent` button: legal at 15px/600 and up. Never 14px, never weight 400.
- `--void` is for the VOID word and strike only. No red anywhere on the site.
- `--line` (1.19:1) is decorative; any interactive boundary steps to `--line-2` (3.0:1) per WCAG 1.4.11.

---

## 3. Type scale

One family. Three weights. Hierarchy comes from **size + weight + ink-step + case + tracking**, never from a second family or a color.

| Token | Size | Weight | Tracking | Line-height | Max measure | Color |
|---|---|---|---|---|---|---|
| h1 | clamp(34px, 5vw, 56px) | 600 | -0.045em (>=48px), -0.035em base | 1.04 | 16ch | --ink |
| h2 | clamp(26px, 3.4vw, 36px) | 600 | -0.03em | 1.12 | 28ch | --ink |
| h3 | 19px | 500 | -0.018em | 1.30 | 40ch | --ink |
| lede | clamp(17px, 1.5vw, 19px) | 400 | -0.01em | 1.55 | 46ch | --ink-2 |
| body | 16px (15px <768px) | 400 | -0.006em | 1.60 | 62ch (cap 68) | --ink |
| label / caps | 11px | 500 | +0.18em UPPER | 1.0 | n/a | --ink-3 |
| mono-data value | 13.5px | 400 | 0 | 1.5 | n/a | --ink-2 |
| mono-data key | 11px | 500 | +0.14em UPPER | 1.0 | n/a | --ink-3 |
| metric / price | clamp(30px, 4vw, 44px) | 600 | -0.02em | 1.0 | n/a | --ink |

**Tracking ladder (size-scoped, never global):** >=48px `-0.045em` · 34 to 47px `-0.035em` · 26 to 33px `-0.03em` · 19 to 25px `-0.018em` · 16 to 18px `-0.008em` · 14 to 15px `-0.004em` · 13px `0` · 11 to 12px caps `+0.16 to +0.18em` · <=9px caps `+0.30em`.

**Rules that make mono editorial (enforce all):**
1. **Tracking inversion is the whole game.** Pull display tight, push tiny caps wide. A 56px headline at default spacing is the instant amateur tell.
2. **Remove `-webkit-font-smoothing: antialiased`.** That was a dark-theme trick; on near-white it thins weight 400 into something frail. Let smoothing default.
3. **`font-variant-numeric: tabular-nums` on every digit** (score, price, days, counts, hashes, dates). Keeps columns aligned during font-swap and on the SF Mono / Consolas fallback.
4. **Never justify, never center prose.** Left-aligned, ragged right. Mono justification makes rivers.
5. **Weight roles, hard:** 400 = body, lede, legal, data values, nav links. 500 = labels, sub-heads, h3, ghost buttons, in-text emphasis, table headers. 600 = h1, h2, metrics, price, wordmark, primary button. No 600 below 18px.
6. **Short measure.** Convert any paragraph past 4 lines into a register or ledger. Mono recognition collapses past ~68ch.
7. **Real optical jumps.** Adjacent sizes never within 2px; every step is a ~1.2 to 1.25 ratio.
8. Emphasis is by weight (500), never by green. Green on running text breaks the one semantic.

---

## 4. Spacing & layout

**Scale (8px base):** `4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96 · 112`.

- **Max content width:** 1100px. **Prose column:** 62ch (~600px).
- **Section padding:** 112px top and bottom desktop, 72px at <=720px.
- **Intra-section rhythm:** label to headline 16px · headline to lede 20px · lede to CTA 32px · paragraph margin-bottom 1em · space before a heading = 2 line-heights (~48px).
- **Card padding:** 24 to 28px.
- **Grid:** 1 column <=640px · 2 columns 641 to 960px · full >=961px. Grid gap 20px mobile, 28px desktop.
- **Vertical-rhythm principle:** a section that cannot meet the floor of (heading + 2 to 4 sentences) OR (a 3-tile row) gets merged upward. Nothing reads thin, nothing reads padded. Flagship <=9 sections, sub-pages 5 to 8.
- **Hairline is the structural divider:** every `<section>` gets `border-top: 1px solid var(--line)`, full-bleed. All borders are 1px. The only 2px element on the whole site is the green left-rule on a verified card.
- **Section banding:** alternate surfaces for boundary. Odd sections `--paper`, even sections `--paper-2` full-bleed white band. This replaces dark-mode contrast as the rhythm device.

---

## 5. Backdrop

Exactly two layers. Never a third. No gradient identity, no foil, no colored glow, no animation on scroll.

**Layer A (global, colorless tonal lift) on `body`:**
```css
body{
  background:
    radial-gradient(110% 70% at 50% -8%, #FFFFFF 0%, rgba(255,255,255,0) 55%),
    var(--paper);
}
```
Depth without a second color. Never tint this green.

**Layer B (masked dot-matrix, hero + final-CTA band only):**
```css
.hero::before, .cta-band::before{
  content:""; position:absolute; inset:0; z-index:-1; pointer-events:none;
  background-image: radial-gradient(circle at 1px 1px, rgba(15,20,17,.04) 1px, transparent 1.6px);
  background-size: 24px 24px;
  -webkit-mask-image: linear-gradient(180deg,#000 0%, rgba(0,0,0,.5) 45%, transparent 80%);
          mask-image: linear-gradient(180deg,#000 0%, rgba(0,0,0,.5) 45%, transparent 80%);
}
```
Dot alpha capped at 0.05. Pitch 24px (unrelated to the type baseline so it never beats glyph edges). The page **opens and closes on the same ledger texture; every mid-page section is pure paper + wash.** Dots not horizontal rules: ruled horizontal lines read as a code listing, the exact failure called out.

Hi-DPI: at `min-resolution: 2dppx` raise dot radius to 1.25px, keep alpha <=0.05.

**Reduced-motion stance:** backdrop is fully static by default. The single permitted motion is one 320ms opacity fade-in of `.hero::before`, gated inside `@media (prefers-reduced-motion: no-preference)`. Under reduce, the final opacity renders immediately. No parallax, no drifting gradient, ever.

Implement as pseudo-elements only (`pointer-events:none; z-index:-1`). Zero image requests. No `background-attachment: fixed`.

---

## 6. Components

### Green-rationing law (read first)
Allowed green surfaces, the complete list. Anything not here is monochrome:
1. Primary button fill (`--accent`).
2. The verified seal + soft pill (`--accent-soft` / `--accent-edge`, glyph `--accent-press`, label `--ink`).
3. The single focus ring (`--accent`).
4. Pass-state tick glyphs and the verified-row `.is-pass` (one 2px `--accent` left rule + `--accent-tint` fill).
5. The active "mapped" cell text in the crosswalk table (`--accent-text`).
6. The wordmark check-glyph (one per page).
7. The 1px green underline drawn on hover for verify-links only.

**Hard budget:** at most ONE green fill + ONE green seal per viewport. Two competing greens above the fold fails QA. Green is never on body links, nav links, headers, dividers, decorative icons, or the tonal wash.

### Nav
Sticky, height 64px. Background `color-mix(in srgb, var(--paper) 82%, transparent)` + `backdrop-filter: saturate(140%) blur(12px)`. `border-bottom: 1px solid var(--line)` on scroll.
- Wordmark: `kolm` mono 600 17px `-0.02em` in `--ink`, preceded by a small green check glyph (the brand seal; this is the one green seal in the nav viewport, the CTA is the one green fill).
- Links (<=5, mono 13.5px/400 `--ink-2`, hover `--ink`, 44px row height via padding): How it works · What we test · Pricing · Trust · Docs.
- Actions (2): ghost `Verify a report` + green `Start an audit`. Move Platform, Research, Changelog, Status to the footer.

### Buttons
**Primary (the only filled-green element):**
```css
.btn--primary{
  background:var(--accent); color:var(--on-accent);
  font-weight:600; font-size:15px; letter-spacing:0;
  padding:13px 22px; border-radius:6px; min-height:44px; border:0;
  transition:background .16s cubic-bezier(.2,.7,.2,1), box-shadow .16s, transform .06s;
}
.btn--primary:hover{ background:var(--accent-deep); box-shadow:0 8px 24px -12px rgba(17,135,90,.40); }
.btn--primary:active{ background:var(--accent-press); transform:translateY(1px); }
.btn--primary[disabled]{ background:#EDEFEC; color:var(--ink-faint); box-shadow:none; cursor:not-allowed; }
```
**Secondary / ghost:**
```css
.btn--ghost{
  background:transparent; color:var(--ink); font-weight:500; font-size:15px;
  padding:13px 22px; border:1px solid var(--line-2); border-radius:6px; min-height:44px;
}
.btn--ghost:hover{ border-color:var(--ink); background:rgba(15,20,17,.04); }
```
On the dark final band, ghost border is `rgba(255,255,255,.22)`, label paper.

### Cards / plates
```css
.plate{
  background:var(--paper-2); border:1px solid var(--line); border-radius:8px; padding:26px;
  box-shadow:0 1px 2px rgba(15,20,17,.04);
  transition:border-color .16s, box-shadow .16s, transform .16s cubic-bezier(.2,.7,.2,1);
}
.plate:hover{ border-color:#D2D6CF; transform:translateY(-1px); box-shadow:0 12px 32px -16px rgba(15,20,17,.10); }
```
Radii system: `--r-sm:4px · --r-md:6px · --r-lg:10px`. No pills on CTAs.

### Hairlines
All rules flat hex `--line` at 1px (never rgba-opacity, which goes fuzzy). Section dividers `border-top:1px solid var(--line)`. Functional control boundaries (inputs, the framed widget, ghost button) use `--line-2`.

### Seal / verified state (foil retired)
The verified pill is the brand asset and the only place green and ink combine into a badge.
```css
.seal{ display:inline-flex; align-items:center; gap:6px;
  background:var(--accent-soft); border:1px solid var(--accent-edge); border-radius:6px; padding:4px 10px; }
.seal__glyph{ color:var(--accent-press); }      /* check / seal mark */
.seal__label{ color:var(--ink); font-weight:600; font-size:11px; letter-spacing:+0.08em; text-transform:uppercase; }
```
State must carry glyph + label, never hue alone (WCAG 1.4.1). Verified row: `.is-pass{ background:var(--accent-tint); border-left:2px solid var(--accent); }`.

**Void / fail variant:** same plate, all green removed. Pill label `VOID` in `--void`, score gets a 1px `--void` strike (the fracture), ticks become minus-glyphs in `--ink-3`, card border `--void-edge`, optional `--void-soft` row fill. No red. The disappearance of green is the alarm.

### Tables (the crosswalk is a centerpiece, not filler)
```css
.tbl{ font-size:13.5px; width:100%; border-collapse:collapse; }
.tbl th{ font-size:11px; font-weight:500; letter-spacing:+0.12em; text-transform:uppercase;
  color:var(--ink-3); background:var(--paper-sink); text-align:left; padding:14px; }
.tbl td{ padding:14px; border-bottom:1px solid var(--line); vertical-align:top; }
.tbl td.num{ font-variant-numeric:tabular-nums; text-align:right; }
.tbl tr:hover td{ background:var(--paper-sink); }
.tbl .mapped{ color:var(--accent-text); }  /* control -> SOC2 CC6.x / ISO A.x / Q# */
```
Min-width 640px. At <=640px each row reflows to a key:value card (label `--ink-3` 11px uppercase +0.06em, value `--ink`). Never below 13px.

### Pricing (one plate, not a tier grid)
Kill the 4-tier grid. One fixed-fee plate:
- Big price `clamp(28px,3.4vw,40px)/600` tabular-nums, with the cost shape shown ("from $X").
- Sub-line: `fixed fee · one signed report · N-day turnaround`.
- 5 to 6 feature rows, each with a green tick.
- One green `Start an audit`.
- One muted line: `Multiple deals or BAA? Enterprise`.
- On `/pricing` only: add a DIY vs kolm vs consultancy compare table (time / cost / output) and add-on rows (re-audit, BAA, SAML). Still one emphasized plan.

### Verify-widget shell
Framed white card, `1px solid var(--line-2)` (interactive boundary), 4 corner registration crosshairs (`--ink-3`, 13px, 1px), 24px padding. Contains: green PASS seal · 4 register rows (subject / issuer / key fingerprint `word-break:break-all` / signature) · verdict line showing **two tiers** (`SIGNATURE VALID` + `ISSUER MATCHES`, `--accent-text`) · real `<button>` controls (`Load sample` / `Tamper a field` / `Forge with a rogue key` / `Clear`) · an offline `Drop your own report` upload · caption `--ink-3` 12px: "Real Ed25519 check, in your browser. No account, no upload." Pressing tamper runs real WebCrypto, fractures the seal, sets verdict `VOID` in `--void`. Verdict updates an `aria-live` region. Never use terminal chrome (no traffic-light dots, no blinking cursor, no syntax color).

### Footer
4 columns. Product (How it works · Platform · Checks · Report · Pricing) / Trust (Verify · Security · Trust · Status · Transparency log) / Legal (Privacy · Terms · DPA · BAA · SLA · Subprocessors · Acceptable use) / Company (Research · Changelog · Careers · Contact). One microprint legend line (`.microprint`: 8px, +0.30em, uppercase, `--ink-faint`, `aria-hidden`).

### Section ordinal markers (replace eyebrows)
```html
<span class="idx">§01 / HOW IT WORKS</span>
```
12px, +0.04em, `--ink-3`; the `§` glyph in `--ink-faint`; the title segment `--ink-2`/500. Numbered sequentially down the page. Step labels render `01 Audit · 02 Sign · 03 Verify`. No marketing eyebrow kicker anywhere; the `§`-marker is the only kicker.

### Focus + selection
```css
:focus-visible{ outline:2px solid var(--accent); outline-offset:2px; border-radius:inherit; }
/* on the dark final band: */
.cta-band :focus-visible{ outline:none; box-shadow:0 0 0 2px var(--paper),0 0 0 4px var(--ink); }
::selection{ background:var(--accent-soft); color:var(--ink); }
```
Never `outline:none` without a replacement. Suppress mouse `:focus`, keep `:focus-visible`.

### Motion
Keep the fail-open `.js-reveal` (visible by default, animate only as enhancement). Reveal = opacity 0 to 1 + translateY(14px to 0), 560ms `cubic-bezier(.2,.7,.2,1)`, 70ms stagger via nth-child up to 5. One hero seal moment: press-in `scale(1.06 to 1)` 600ms + pass-tick `stroke-dashoffset` draw, once. Everything gated behind `@media (prefers-reduced-motion: reduce)`, which also runs the global duration reset.

---

## 7. Copy system

**Voice rubric:** instrument-grade. Verb-led, noun-or-number first, one idea per sentence. Lead from the founder's situation, then the signed-evidence outcome, then the artifact. Scope qualifiers are load-bearing and protected. This is a subtraction job: the facts are right, the words are too many.

**6 hard directives:**
1. **Hero H1 <=8 words, <=2 lines.** Lede <=28 words and <=2 sentences. Section headline <=7 words. Body paragraph <=3 sentences and <=45 words; card body <=24 words.
2. **Lead token.** First 1 to 3 words of every line carry the noun or number (`10x`, `0 servers`, `4-8 weeks`, `Ed25519`, `Days`). In mono this aligns the left edge into a scan index.
3. **Cut the setup.** Delete the leading scene-setting clause and the trailing wave-away clause; state the result. Split on every `and` / `which` / `that` into separate sentences. Average sentence 12 to 16 words, hard cap 24.
4. **Emphasis by weight, never color.** 400 body / 500 the one key token / 600 headlines and crypto facts. Never font-weight a green word in running text.
5. **Ledger over prose.** Any sentence joining 3+ comma items or a parenthetical enumeration becomes a `<ul class="ledger">` with a 1ch green tick, each row a noun phrase <=6 words.
6. **No-wrap tokens.** Every hash, key fingerprint, signature, count gets `white-space:nowrap; font-weight:500` so `ed25519:7HHx...` never breaks mid-token.

**Protected strings (pass verbatim, never soften to sell):** "tested and reported, not warranted" · "assessed" · "is not proof" · "target" · "design property" · "covers the canonical bytes". A CI grep confirms "tested and reported, not warranted" survives on the homepage, /checks, and /how-it-works.

**Banned content (CI-enforced):** no em dash (U+2014), no en dash (U+2013), split clauses with a period or " · ". Never the words "honest" or "honesty" (use "limits", "constraints", "stated plainly"). Never "compliance vendor". Delete-on-sight: very, really, simply, just, basically, leverage, robust, seamless, powerful, cutting-edge, world-class, best-in-class, enterprise-grade, frictionless, delightful. Rewrite "in order to" to "to", "is able to" to "can", "allows you to / helps you" to the bare verb. Single contact `dev@kolm.ai` only (no sales@/hello@/support@); the /contact form routes there. Allowed CTA verbs: `Start an audit` (primary, verbatim at every placement), `Verify a report`, `See a signed report`, `Download the JSON`. Banned CTAs: Contact us, Get in touch, Learn more, Request a demo.

**Headline forms (pick one, <=8 words):** (A) correction couplet "X isn't Y. It's Z." · (B) imperative pair/triad "Audit. Sign. Verify." · (C) subject-collapse "The artifact is the proof." · (D) number-lead "Six controls, mapped to the frameworks reviewers cite."

**Hero copy (locked):**
- H1 (couplet, two lines): "The deal isn't lost." / "It's in security review."
- Lede: "kolm signs an evidence report your buyer verifies offline against your key. A four-to-eight-week review becomes days."
- CTAs: `Start an audit` (green) + `Verify a report` (ghost).
- Trust micro-line under CTAs (`--ink-3` 12px, green tick glyphs): "Ed25519-signed · Verifiable offline · Maps to SOC 2, ISO 27001, your buyer's questionnaire."

**5 before/after rewrites:**
1. Hero lede (42w to 17w): BEFORE "Your biggest enterprise contract stalls the moment a CISO has to vet an autonomous agent. kolm audits the agent and issues a cryptographically signed evidence report your buyer verifies offline, against your public key. A four-to-eight-week review goes back to days." AFTER "kolm signs an evidence report your buyer verifies offline against your key. A four-to-eight-week review becomes days."
2. Problem lede (39w to 26w): BEFORE "Nobody turns an autonomous agent loose on their customers' data because the vendor says it's safe. The review that used to take a week now runs four to eight, and a filled-in questionnaire no longer clears the bar." AFTER "No CISO trusts an autonomous agent on customer data on your say-so. The week-long review now runs four to eight. A questionnaire no longer clears it."
3. Card body (35w to 19w, number-lead): BEFORE "Most agents carry roughly ten times the privileges they actually use, and many share one API key across tools. It is the first thing a reviewer flags, and the hardest to wave away." AFTER "10x the privileges they actually use, often on one shared key. It is the first thing a reviewer flags."
4. Vault lede (62w to 33w): BEFORE "To the right is a real, signed audit of a deliberately over-permissioned demo agent, which is why it scores 0%. The check runs entirely in this browser. Press Inflate the score to raise the readiness number, the way a vendor under pressure might. The seal fractures and the report reads VOID, every time. That is the whole point." AFTER "This is a real signed audit of an over-permissioned demo agent. It scores 0%. The check runs in your browser. Press Tamper a field. The seal fractures and the report reads VOID. Every time."
5. Verify lede (48w to 26w + micro-line): BEFORE "Your buyer opens the report and the signature is checked in their browser, against the public key inside it. Because kolm is never in the path, there is no back end that could fake a green check. Pin the issuer key to also prove it's the key you expected." AFTER "Your buyer checks the signature in their browser, against the key inside the report. kolm is never in the path, so no server can fake a pass." + micro-line "Pin the issuer key to confirm it is yours."

---

## 8. Conversion model

**Homepage sequence (9 sections, in order):**
1. **Hero** — couplet H1 + lede + two CTAs + the live verify card in PASS state, above the fold (total hero height <=900px on a 1080px laptop).
2. **Proof strip** — full-bleed, 56 to 64px, hairline top and bottom: green `Ed25519-signed` badge · `Verified offline · 0 servers in trust path` · framework chips `SOC 2 · ISO 27001 · NIST AI RMF · EU AI Act · OWASP · MITRE ATLAS` · link `Append-only transparency log`.
3. **The stall** — "A CISO won't take your word for it." 3 hairline cards (Over-permissioned / No tamper-evidence / Say-so doesn't scale), each <=45 words, each tagged with its control id in `--ink-3`.
4. **How it works** — "Audit. Sign. Verify." 3 steps (`01/02/03`).
5. **The report** — anatomy block (the signed artifact, annotated) + the framework crosswalk table.
6. **Verify it yourself** — the full tamper/forge widget; "Press anything. A forged report fails. That is the whole point."
7. **Trust** — proof-stack (verify-it-yourself, named accredited co-signer, append-only transparency log, scope statement "tested and reported, not warranted") plus 3 objection cards inline: "Do you warrant our agent is secure?" / "Why should a CISO trust kolm?" / "Is this security theater?".
8. **Pricing** — one fixed-fee plate (cost shape, turnaround, green tick rows).
9. **Final CTA band** — the only dark surface (`--ink` background, paper text, 112px padding): "Clear the review. Close the deal." green `Start an audit` + ghost `See a signed report`.

**Primary-CTA strategy:** one verb site-wide, `Start an audit`, always green, ~4 instances on the homepage (nav · hero · post-how-it-works or pricing · final band). Exactly 2 CTAs in the hero (green primary + ghost secondary). One primary green button per viewport. Green is therefore trained as "the action."

**Proof above the fold:** the working WebCrypto verifier in PASS state sits next to the CTA in the hero. It is the pitch and the anti-theater objection-handler in one gesture. No logo wall (there are none; faking them disqualifies you with this audience). The logo-wall substitute is the property-based proof stack (verifiable math, named co-signer, transparency log, open verifier, framework fluency, one specific anonymized outcome only if truthful).

**Objection handling:** confident, on-page, never fine print. Scope honesty reads as maturity to a reviewer. State "we do not warrant your agent is secure" and "a finding's absence is not proof of safety" as a card, and the cost shape openly.

**Secondary-page CTA/logic:**
- `/how-it-works` — expand Audit/Sign/Verify with the real onramp (LiteLLM / Helicone / Portkey, or a sidecar proxy) and the canonical-bytes to Ed25519 mechanism; embed a compact verify widget; downloadable sample-report.json. End: dual CTA.
- `/verify` — the widget IS the page hero (Load sample / Tamper / Forge with a rogue key / Clear + offline upload), two-tier verdict labels, link to the actual browser verifier JS. End: `Start an audit`.
- `/security` — kolm's own posture (data touched, key custody + rotation, hosted vs BYOC vs air-gapped, subprocessors, retention, threat-model link). End: `Talk to us`.
- `/enterprise` — BYOC + air-gapped runs, named co-signer, DPA/BAA, custom scope, contingency pricing. CTA `Talk to sales` + ghost `See a signed report`.
- `/pricing` — one plan emphasized, cost shape per turnaround, DIY-vs-kolm-vs-consultancy compare, add-ons. End: dual CTA + `See a sample report`.
- `/contact` — replace mailto with a 4-field form (work email · one-line agent description · deal/target-date context · optional systems it can reach), green submit `Request a scoping call`, reassurance line "20-minute call · fixed quote upfront · we sign your NDA · no obligation", embedded scheduler as alt path, ghost `Verify a sample report`.

---

## 9. Per-page structure spec

One-line ordered sections. 28 pages.

- **/** : Hero (couplet + live PASS verifier + dual CTA) > Proof strip > The stall (3 cards) > How it works (3 steps) > The report (anatomy + crosswalk) > Verify it yourself (tamper/forge widget) > Trust (proof-stack + 3 objection cards) > Pricing (one plate) > Final dark CTA band.
- **/how-it-works** : Intro + timeline > Step 1 Scope (inputs, day 0) > Step 2 Audit (what runs, 2-3 days) > Step 3 Signed report (deliverable) > What's inside the report > Timeline/SLA > What it is not (scope limits) > CTA.
- **/verify** : H1 + client-side verifier (hero) > result states (valid / signed-by / VOID) > how verification works (Ed25519, offline) > public key + fingerprint (kid) > issuer trust chain > verify via CLI/API snippet > CTA.
- **/security** : H1 > posture at a glance > data handling (access, retention, deletion) > infrastructure (hosting, isolation, encryption) > access control + key mgmt > vulnerability mgmt + disclosure > subprocessors > status of controls stated plainly > threat model link > contact security.
- **/security/threat-model** : H1 > scope & assets > trust boundaries (diagram) > adversaries & assumptions > threats table (threat to mitigation, STRIDE) > key/signing custody (Ed25519) > out of scope > residual risk > report an issue.
- **/trust** : H1 Trust center > live status > report verification > security overview > subprocessors > legal & DPAs > transparency log > public key + fingerprint > contact.
- **/enterprise** : H1 > how review groups use it > what the report proves (mapped to their checklist) > verification (offline, no portal) > procurement docs (DPA/BAA/SLA) > pilot/onboarding > CTA Talk to sales.
- **/pricing** : H1 + one-line model > the plan (price, included, turnaround SLA) > what's checked > add-ons (re-audit, BAA, SAML) > compare (DIY vs kolm vs consultancy) > billing FAQ > CTA.
- **/report** : H1 > sample artifact (full) > anatomy (annotated header, checks, verdicts, signature block) > verdict semantics (pass/flag/n-a) > verification > how buyers read it > download sample (PDF/JSON) > CTA.
- **/checks** : H1 + coverage statement > category groups (Identity & secrets, Data handling, Model/agent safety, Infra, Logging) each collapsible (id + one line) > mapping (SOC2/ISO/OWASP) > what we don't check (scope limits) > CTA.
- **/platform** : H1 > overview (pipeline diagram scope>run>sign>verify) > capabilities (checks engine, signing, verifier) > inputs/integrations > platform security > for builders (API/CLI) > CTA.
- **/docs** : H1 + search > quickstart (verify a report in 60s) > concepts (report, verdict, signature, key) > verify (CLI/API/offline) > report schema (JSON) > checks reference > keys & rotation > changelog > support.
- **/research** : H1 > thesis (why agent security review is broken) > notes grouped into 2-3 pillars (date + title + 1 line) > method/benchmark callout > subscribe > CTA.
- **/changelog** : H1 > filter (product/checks/security) > reverse-chron entries (date, version tag, Added/Changed/Fixed/Security) > RSS/subscribe.
- **/status** : H1 + overall badge > component table (API, verifier, signing, site) > 90-day uptime > incident history > subscribe.
- **/contact** : H1 > primary path (calendar/form) > 4-field form (email, agent description, deal/deadline, optional systems) > response-time expectation > legal entity/address.
- **/solutions/ai-vendors** : H1 "Unblock the deal stuck in security review" > the stall (founder pain) > how kolm fixes it > what you hand the buyer > timeline/price > proof/quote > CTA Start an audit.
- **/solutions/enterprise-buyers** : H1 "Verify a vendor in minutes, not weeks" > the review backlog > how to verify a kolm report > coverage vs your checklist > trust/verification > CTA Request a vendor report.
- **/privacy** : Legal shell (H1 + last-updated + TL;DR box + sticky ToC + collapsible) > data collected > use > sharing/subprocessors > retention > rights > transfers > security > children > changes > contact/DPO.
- **/terms** : Legal shell > acceptance > service > fees > IP > warranties/disclaimer > liability cap > indemnity > term/termination > governing law > changes > contact.
- **/dpa** : Legal shell + Download/sign DPA CTA > roles > scope/duration > processing details > subprocessors link > security-measures annex > transfers/SCCs > audit rights > sub-breach > return/deletion.
- **/baa** : Legal shell + Request BAA CTA > HIPAA definitions > permitted uses > safeguards > breach notification > subcontractors > term/termination > return/destruction.
- **/sla** : Legal shell > summary (uptime % + turnaround) > definitions > availability target & measurement > credits table > support response targets > exclusions > claim process.
- **/acceptable-use** : Legal shell > prohibited uses > security/abuse > enforcement > reporting > changes.
- **/subprocessors** : Legal shell + Subscribe-to-changes > table (name, purpose, data, region) > vetting > notification policy > contact.
- **/transparency-log** : H1 + what this log is > append-only entries (date, event: key rotation, issuance counts, incidents, gov requests) > verify log integrity > subscribe.
- **/careers** : H1 + mission > why kolm (2-3 points) > open roles (or "no roles open, reach us here") > how we work > apply/contact.
- **/404** : One screen, H1 "Page not found" + one line + search > top destinations (Verify, How it works, Pricing, Docs, Status) > contact. Never a dead end.

---

## 10. Definition of done

Ship only when every line is true.

**Palette + green discipline**
- [ ] Tokens match section 2 exactly. No `--foil`, no holographic/gradient/radial-glow, no `color-scheme: dark`, no obsidian surface anywhere in the codebase.
- [ ] Automated contrast scan: zero green text under 4.5:1. Every green text instance uses `--accent-text` (<=18px) or `--accent` (>=24px / fills).
- [ ] No green on links, nav, headers, dividers, decorative icons, or the wash. Max one green fill + one green seal per viewport (checked above the fold on every page).
- [ ] Fail state is monochrome `--void` + the word VOID + a fracture strike. No red hex anywhere.
- [ ] Every pass/verified element carries a glyph + text label, not hue alone.

**Type + mono craft**
- [ ] Whole site in Spline Sans Mono, weights 400/500/600 only. No 600 below 18px.
- [ ] Every heading >=24px carries negative tracking; every <=12px caps label carries +0.16em or more.
- [ ] `-webkit-font-smoothing: antialiased` removed. `tabular-nums` on all data. No justified or centered prose. Prose columns <=62ch.

**Layout + backdrop**
- [ ] Exactly two backdrop layers (colorless wash global + masked dot-matrix on hero and final band only). Mid-page is pure paper. No backdrop animation beyond the single gated fade.
- [ ] All borders 1px (the only 2px is the green verified left-rule). Sections divided by full-bleed hairlines, banding alternates paper/white. Max width 1100px.
- [ ] 7 to 9 homepage sections; no section reads thin (meets the heading + 2-4 sentences or 3-tile floor).

**Components**
- [ ] One primary button style site-wide; `Start an audit` verbatim at all placements. Two CTAs in the hero, ~4 primary instances on the homepage.
- [ ] Hero shows the live WebCrypto verifier in PASS above the fold (<=900px hero on a 1080px laptop); tamper produces a real VOID.
- [ ] Pricing is one fixed-fee plate (cost shape shown), not a tier grid. No fake logos, no invented counts.
- [ ] Crosswalk table renders; mapped cells in `--accent-text`; reflows to key:value cards <=640px.

**Copy**
- [ ] CI grep passes: zero U+2014, zero U+2013, zero "honest"/"honesty", single contact `dev@kolm.ai`, no banned CTA strings.
- [ ] Protected strings present where required ("tested and reported, not warranted" on homepage, /checks, /how-it-works).
- [ ] Hero H1 <=8 words, lede <=28 words, every section headline <=7 words, every lede <=2 sentences. Average sentence under 16 words.

**Accessibility + IA**
- [ ] One h1 per page, sequential heading levels, visually-hidden h2 on Proof strip and FAQ.
- [ ] `:focus-visible` ring on every interactive element (double-ring on the dark band). 44x44px target floor, 8px min gap, 16px minimum body.
- [ ] Scroll-reveal fails open (content visible if JS or observer never arms). Global reduced-motion reset present.
- [ ] No horizontal scroll at 390px except opt-in tables. Interactive borders use `--line-2` (3:1), not the hairline.
- [ ] Legal pages use the shared shell (last-updated + TL;DR + sticky ToC + collapsible).

**Verdict:** a security researcher can verify a real report offline in the hero, read the scope limits without digging, and find one green button that always means go. If all boxes are checked, the site is iconic, launch-ready, and on the founder's bar.