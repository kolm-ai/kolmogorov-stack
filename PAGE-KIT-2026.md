# kolm.ai PAGE KIT (2026 rebuild)

You are rebuilding one page of kolm.ai to a state-of-the-art design bar with optimal copy.
The two reference exemplars are `public/index.html` (the homepage) and `public/pricing.html`.
Read both before you write. This kit gives you the exact shared chrome (paste it verbatim),
the class vocabulary, the copy source-of-truth, and the hard constraints. Do not invent new
CSS classes or load new stylesheets/fonts/CDNs. Everything you need is in `kolm-2026.css`.

## What "incredible" means here
- One design hand across all 28 pages: three-voice type, `idx` section markers, a light/dark
  `.section--ink` "ledger" rhythm, `.reveal` fail-open, varied radii, grain (all free from the cascade).
- Copy leads from the buyer's SITUATION (a six-figure enterprise deal stalled in security review),
  not from mechanism. No generic AI eyebrow kickers. Tight, concrete, no bloat.
- Every factual/security claim and the exact scope wording is preserved verbatim.
- No page reads as a generic template or "AI slop." Every section earns its place.

## Three-voice type (already wired in kolm-2026.css, do not restate in CSS)
- DISPLAY = Cabinet Grotesk: h1/h2 and big numbers/prices only.
- TEXT = Switzer: body, `.lede`, buttons, nav, footer.
- MACHINE = Spline Sans Mono: ONLY hashes, signatures, IDs, the register, the verify widget,
  verdict chips, `idx` markers, microprint. Never set prose in mono.

## The ledger rhythm (required)
Alternate warm-paper editorial `.section` blocks with deep `.section--ink` proof blocks.
Every page gets at least one `.section--ink` beat and ends on the dark `.cta-final`.
Open each major section with an `.idx` marker: `<span class="idx">01 / Short label</span>` inside
the `.section__head`. The CSS prepends a mono "§"; you write just `01 / Label`.

## Class vocabulary (use these; do not invent)
Layout: `.wrap` `.section` `.section--flush` `.section--band` `.section--ink` `.section__head` `.rule`
Markers/eyebrows: `.idx` (mono section marker) `.ctrlid` (framework chips) `.running-head`
Type helpers: `.lede` `.hero__claim` (small print under a block) `.mono` `.ok-text` `.sr-only`
Buttons: `.btn` + `.btn--primary` / `.btn--ghost` / `.btn--sm`
Hero: `.hero` `.hero__grid` `.hero__h1` `.hero__cta` `.hero__claim` `.trustline` (check-marked guarantees)
Bands: `.band` `.band__item` `.badge` `.badge--ok`
Cards/grids: `.grid` `.grid--2` `.grid--3` `.grid--4` `.card` `.card__k` (mono kicker) `.card__map` (mono control id) `.plate`
Lists: `.ledger` (green-check ul) `.steps` `.step` `.step__n`
Numbers: `.metrics` `.metric` `.metric__n` `.metric__l`
Pipeline: `.flow` `.flow__node` `.flow__ic` `.flow__n` `.flow__t` `.flow__d` `.flow__link`
The artifact: `.register` `.register__row` `.register__k` `.register__v` `.ann` (mono annotation) `.report`
Tables: `.tbl-wrap` `.tbl` `.mapped` (green cell) `.muted` (empty cell) `.split` (2-col 50/50)
Pricing: `.tiers` `.tier` `.tier--feat` `.tier__name` `.tier__price` `.tier__sub`
Seal/verify: `.seal` (`.is-sealed`/`.is-void`/`.is-pending`) `.vw` + `[data-verify-widget]` `.tryit`
Reveal: `.reveal` (fade-up; gets `.in` when scrolled into view) on content sections.
Footer: `.foot` `.foot__grid` `.foot__col` `.foot__bottom` `.microprint`

Tokens you may reference inline: `--ink-2` `--ink-3` `--line-2` `--accent` and spacing `--s1`..`--s10`.

## EXACT HEAD (paste; fill the {{...}} placeholders, keep everything else byte-for-byte)
The reveal inline script and font preloads are mandatory on every page.
Add `<script type="module" src="/verify-widget.js"></script>` ONLY on pages that embed a
`[data-verify-widget]` (verify.html and report.html). Do not add it elsewhere.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<script>/* Arm scroll-reveal before first paint (no FOUC). Fail open: if the reveal
 * observer never initializes (script 404/parse error), strip the class so nothing
 * stays hidden, so the page is never blank. Keys off the observer's own "armed"
 * marker, not on whether anything has scrolled into view yet. */
(function(h){h.classList.add('js-reveal');addEventListener('load',function(){
setTimeout(function(){if(!h.hasAttribute('data-reveal-armed'))h.classList.remove('js-reveal');},1400);});})(document.documentElement);</script>
<title>{{TITLE}} · kolm.ai</title>
<meta name="description" content="{{DESCRIPTION}}">
<meta name="theme-color" content="#F6F7F4">
<meta name="author" content="kolm.ai">
<meta name="robots" content="index,follow,max-snippet:-1,max-image-preview:large">
<meta property="og:site_name" content="kolm.ai">
<meta property="og:locale" content="en_US">
<meta property="og:title" content="{{OG_TITLE}}">
<meta property="og:description" content="{{OG_DESCRIPTION}}">
<meta property="og:type" content="website">
<meta property="og:url" content="https://kolm.ai{{CANONICAL_PATH}}">
<meta property="og:image" content="https://kolm.ai/brand-hero.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@kolm_ai">
<meta name="twitter:title" content="{{TWITTER_TITLE}}">
<meta name="twitter:image" content="https://kolm.ai/brand-hero.png">
<link rel="canonical" href="https://kolm.ai{{CANONICAL_PATH}}">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="preload" href="/fonts/CabinetGrotesk-Variable.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/Switzer-Variable.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/SplineSansMono-400.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/SplineSansMono-500.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/kolm-2026.css" as="style">
<link rel="stylesheet" href="/kolm-2026.css">
<script defer src="/kolm-2026.js"></script>
</head>
<body>

<hr class="foil-strip" aria-hidden="true">
```

## EXACT NAV (paste verbatim, identical on every page)
```html
<header class="nav">
  <div class="wrap nav__in">
    <a class="nav__brand" href="/" aria-label="kolm.ai home">
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <rect x="4" y="6" width="4.5" height="20" rx="0.4"/>
        <rect x="13" y="9" width="4.5" height="14" rx="0.4"/>
        <rect x="22" y="12" width="4.5" height="8" rx="0.4"/>
      </svg>
      <span>kolm<b>.ai</b></span>
    </a>
    <nav class="nav__links" id="navLinks" aria-label="Primary">
      <a href="/how-it-works">How it works</a>
      <a href="/checks">What we test</a>
      <a href="/pricing">Pricing</a>
      <a href="/trust">Trust</a>
      <a href="/docs">Docs</a>
    </nav>
    <div class="nav__actions">
      <a class="btn btn--ghost btn--sm" href="/verify">Verify a report</a>
      <a class="btn btn--ghost btn--sm nav__cta" href="/contact">Start an audit</a>
    </div>
    <button class="nav__toggle" type="button" aria-label="Menu" aria-expanded="false" aria-controls="navLinks">
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
    </button>
  </div>
</header>

<main>
```

## EXACT FOOTER (paste verbatim, identical on every page; closes <main> first)
```html
</main>

<hr class="foil-line" aria-hidden="true">
<footer class="foot">
  <div class="wrap">
    <div class="foot__grid">
      <div class="foot__col">
        <a class="nav__brand" href="/" aria-label="kolm.ai home" style="margin-bottom:12px">
          <svg viewBox="0 0 32 32" aria-hidden="true" style="width:22px;height:22px">
            <rect x="4" y="6" width="4.5" height="20" rx="0.4"/>
            <rect x="13" y="9" width="4.5" height="14" rx="0.4"/>
            <rect x="22" y="12" width="4.5" height="8" rx="0.4"/>
          </svg>
          <span>kolm<b>.ai</b></span>
        </a>
        <p style="color:var(--ink-3);font-size:13px;max-width:34ch">Signed security evidence for AI agents entering the enterprise.</p>
      </div>
      <div class="foot__col">
        <h4>Product</h4>
        <a href="/how-it-works">How it works</a>
        <a href="/platform">Platform</a>
        <a href="/checks">Checks</a>
        <a href="/report">Report</a>
        <a href="/docs">Docs</a>
        <a href="/pricing">Pricing</a>
      </div>
      <div class="foot__col">
        <h4>Trust</h4>
        <a href="/verify">Verify</a>
        <a href="/security">Security</a>
        <a href="/trust">Trust center</a>
        <a href="/status">Status</a>
        <a href="/transparency-log">Transparency log</a>
      </div>
      <div class="foot__col">
        <h4>Legal</h4>
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
        <a href="/dpa">DPA</a>
        <a href="/baa">BAA</a>
        <a href="/subprocessors">Subprocessors</a>
      </div>
      <div class="foot__col">
        <h4>Company</h4>
        <a href="/research">Research</a>
        <a href="/changelog">Changelog</a>
        <a href="/careers">Careers</a>
        <a href="/contact">Contact</a>
      </div>
    </div>
    <div class="microprint" style="margin-top:var(--s6)" aria-hidden="true">KOLM · AGENT SECURITY EVIDENCE · ED25519 · VERIFIED OFFLINE · SIGNED · SCOPED · OFFLINE-VERIFIABLE · KOLM · AGENT SECURITY EVIDENCE · ED25519 · VERIFIED OFFLINE · SIGNED · SCOPED · OFFLINE-VERIFIABLE · KOLM · AGENT SECURITY EVIDENCE · ED25519 · VERIFIED OFFLINE ·</div>
    <div class="foot__bottom">
      <span class="badge badge--ok">Ed25519-signed</span>
      <span class="badge">Offline-verifiable</span>
      <span class="badge"><a href="/kolm-audit-verify.js">Inspectable verifier</a></span>
      <span style="margin-left:auto;color:var(--ink-3);font-size:13px">© 2026 kolm.ai · <a href="mailto:dev@kolm.ai">dev@kolm.ai</a></span>
    </div>
  </div>
</footer>

</body>
</html>
```

## Section patterns you can lift (see index.html / pricing.html for full markup)
- Hero: `.section.section--flush` with `.section__head` (h1 + `.lede` + `.hero__cta` + optional `.trustline`).
- Section head: `.section__head` > `.idx` + h2 + `.lede`.
- Pipeline diagram: `.flow` with three `.flow__node` separated by `.flow__link` (use on the dark beat).
- The artifact: `.split` of a `.register` rail + a `.grid` of `.card`s, then a `.tbl` crosswalk.
- Proof beat: `.section--ink` with `.grid--3` of cards (Tier 1 / Tier 2 / Offline) OR the flow diagram.
- Final CTA: `.section.reveal.cta-final` with h2 + `.lede` + `.hero__cta`.
- Framework crosswalk table columns: Control | What it checks | Maps to (cells use `.mapped`).

## Copy source-of-truth (preserve these facts exactly)
- WHO: a Series-A AI-native startup selling an agentic product into the enterprise. ONE six-figure
  ($100k to $500k) deal STALLED (not lost) in security review; a one-week review stretched to four
  to eight weeks the moment a CISO had to vet an autonomous agent.
- WHAT: kolm runs an Agent Security-Review Readiness audit ending in a cryptographically signed
  (Ed25519) evidence report the founder hands the buyer's review group, who verify it offline,
  against the founder's own public key, with no account and no kolm server in the trust path.
  The four-to-eight-week review compresses back to days.
- THE TRIPLET: least-privilege permission audit + red-team / prompt-injection proof + a tamper-evident
  signed report mapped to the frameworks the buyer already cites (SOC 2 TSC, ISO 42001, NIST AI RMF,
  EU AI Act Art.12 and Art.14, OWASP Agentic / LLM Top 10, MITRE ATLAS).
- THE SIX CONTROLS: ASR-1 least privilege · ASR-2 audit trail · ASR-3 data egress · ASR-4 injection ·
  ASR-5 provenance · ASR-6 evidence. (See the crosswalk in index.html for the maps-to values.)
- TWO-TIER VERIFY: Tier 1 = Ed25519 signature integrity (edit a field, the seal breaks). Tier 2 =
  issuer provenance vs the buyer's keyring (a rogue key clears Tier 1 but fails Tier 2). Offline,
  in-browser WebCrypto, no server.
- SPEED, TWO CLOCKS: the automated audit (permission read, audit-trail and egress checks, the
  prompt-injection battery, control-mapping, signing) is compute, minutes to hours, no human in the
  loop. The named co-signer review is the only human step: days, bounded by an SLA, not weeks.
  State it as "minutes for the automated scan, days for a named-reviewed attestation."
- CONTINUOUS: a point-in-time report goes stale on the next deploy ("a permission granted in January
  can still fire in August"). Continuous re-attests weekly or on every deploy and exposes a live
  Trust link the founder hands any buyer. No human in the loop.
- URGENCY: the EU AI Act Art.12 logging obligation has an enforcement date of Aug 2 2026. State it
  as a date. Never say "compliant".
- EXACT SCOPE LINE (verbatim wherever scope is stated): "Scope is contractual. Permission posture,
  redaction and audit-trail integrity are assessed. Injection is tested and reported, not warranted."

## PRICING (LOCKED, flat, public, no "get a quote")
- Scan: Free (self-serve, watermarked snapshot, no human).
- Signed Readiness Report: $750 one-time (full automated audit, signed + offline-verifiable, no human).
- Continuous Starter: $299/mo (up to 3 agents, weekly re-attestation).
- Continuous Growth: $999/mo (up to 15 agents, on-every-deploy + injection regression).
- Reviewed Attestation: $25,000 flat (named co-signer, the deal-closer).
- + Deep Red-Team: +$10,000 add-on.
No percentage contingency anywhere on the site. Link pricing pages to /pricing; never gate with
"contact sales" / "get a quote" / "talk to sales".

## HARD CONSTRAINTS (violating any one fails the page)
- NEVER the word "honesty" or "honest". Use "candid", "accurate", "verifiable", "Caveats",
  "Constraints", "Limitations".
- dev@kolm.ai is the ONLY contact email. The name "rodneyyesep" and any personal email must never appear.
- Keep the kolm name and the three-bar logo. No named individuals or researchers. No "Halborn" as a
  person. No blockchain in the enterprise critical path (the transparency log is an Ed25519 / SHA-256
  Merkle append-only log, RFC 6962 style, NOT a chain). The framework is NOT "AIUC-1".
- NO em dashes and NO en dashes anywhere. Use commas, periods, parentheses, or the mono " · ".
  ASCII punctuation only (no smart quotes, no BOM). The middle dot ·, the check ✓, and © are allowed.
- No generic-AI eyebrow kickers (e.g. "Powered by AI", "The future of...").
- FORBIDDEN substrings (case-sensitive, must not appear): `pip install kolm`, `.kolm bundle`,
  `3B INT4`, `Arweave`, `On-chain`, `Air-gap mode`, `WASM runtime`, `kolm WASM`,
  `EU AI Act compliant`, `Type I evidence available now`, `SOC 2 Type II evidence`,
  `Your data never moves`, `data never moves`, `inside your VPC`, `BAA boundary`,
  `PHI never leaves`, `HIPAA-ready`, `Mobile SDK`, `AIUC-1`.
- Do not claim air-gapped / BYOC delivery or "data never leaves your boundary"; the product model is
  self-serve upload of redacted logs plus continuous re-attestation. Drop legacy air-gap/BYOC copy.

## Output
Write the rebuilt page directly to its file with the Write tool. Output must be a complete HTML
document using the exact head/nav/footer above. Before finishing, self-check: no dashes, no forbidden
substrings, no "honest", dev@kolm.ai only, scope line verbatim where used, `.reveal` on content
sections, at least one `.section--ink`, ends on `.cta-final`, all `idx` markers present.
