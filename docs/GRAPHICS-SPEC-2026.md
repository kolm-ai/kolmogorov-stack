# GRAPHICS SPEC 2026 - the kolm.ai diagram language (v2.1 cosmetics wave)

One shared SVG vocabulary so every technical page shows its mechanism instead of
describing it. All styles live in `public/kolm-2026.css` under "GRAPHICS LAYER v2.1"
(READ-ONLY for agents - never edit the CSS; only place markup).

## Rules (binding)

- Wrap every diagram in `<figure class="diag reveal" role="img" aria-label="...">` with a
  one-sentence aria-label describing the mechanism. Optional caption row:
  `<figcaption class="diag__cap"><b>Figure</b> caption text</figcaption>` (ASCII only, no
  em/en dashes, middot `&#183;` allowed).
- SVG text uses ONLY the spec classes below. Never inline fill/font on text. Never use
  unicode arrows in text; arrows are drawn geometry.
- NEVER add evidence-locked phrases inside diagrams ("eight controls", "Six frameworks",
  "fa562154f99c95f4", etc. - the x04 gate pins their placement). Use machine IDs instead
  (ASR-01, SHA-256, Ed25519, kolm-prod-2026).
- Forbidden substrings and the no-"honesty" rule apply inside SVG text too.
- One diagram per page maximum. Legal pages (privacy, terms, dpa, subprocessors,
  cookies, legal) get NO diagrams.
- Keep `viewBox` wide-format (~720 x 150..200) so diagrams scale to the column.
- The animated classes (`dg-flow`, `dg-dot`) are reduced-motion gated by the CSS; use
  `dg-flow` on at most ONE path per diagram (the proof-carrying path).

## Vocabulary (CSS classes on SVG nodes)

- `dg-box` plain node - `dg-box--ok` verified/green node - `dg-box--void` tamper/void node
  (use with `<rect rx="9">`)
- `dg-line` static connector - `dg-flow` THE animated proof path (one per diagram)
- `dg-label` small mono label - `dg-label--up` uppercase micro label
- `dg-t` node title (sans 12.5px) - `dg-mono` machine detail line
- `dg-ok` green fill (checks, arrowheads on the proof path) - `dg-void-t` clay text
- `dg-dot` pulsing green dot (live marker, max one)

## D1 - AUDIT PIPELINE (for: /product, /docs, /scan-style pages)

```html
<figure class="diag reveal" role="img" aria-label="Audit pipeline: agent logs go into the audit engine, controls ASR-01 to ASR-08 run, and a signed report comes out">
<svg viewBox="0 0 720 168" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path class="dg-flow" d="M158 68 H198 M380 68 H420 M602 68 H630"/>
  <rect class="dg-box" x="8" y="36" width="150" height="64" rx="9"/>
  <text class="dg-label dg-label--up" x="22" y="56">Input</text>
  <text class="dg-t" x="22" y="76">Agent logs</text>
  <text class="dg-mono" x="22" y="92">import or sidecar</text>
  <polygon class="dg-ok" points="198,68 190,63.5 190,72.5"/>
  <rect class="dg-box" x="200" y="36" width="180" height="64" rx="9"/>
  <text class="dg-label dg-label--up" x="214" y="56">Engine</text>
  <text class="dg-t" x="214" y="76">Audit run</text>
  <text class="dg-mono" x="214" y="92">ASR-01 .. ASR-08</text>
  <polygon class="dg-ok" points="420,68 412,63.5 412,72.5"/>
  <rect class="dg-box--ok" x="422" y="36" width="180" height="64" rx="9"/>
  <text class="dg-label dg-label--up" x="436" y="56">Output</text>
  <text class="dg-t" x="436" y="76">Signed report</text>
  <text class="dg-mono" x="436" y="92">Ed25519 envelope</text>
  <polygon class="dg-ok" points="630,68 622,63.5 622,72.5"/>
  <circle class="dg-dot" cx="646" cy="68" r="4"/>
  <text class="dg-label" x="658" y="72">verify</text>
  <path class="dg-line" d="M290 100 V128"/>
  <text class="dg-mono" x="208" y="146">permissions &#183; audit trail &#183; egress &#183; injection</text>
</svg>
<figcaption class="diag__cap"><b>Pipeline</b> same logs in, same signature out: the run is reproducible end to end</figcaption>
</figure>
```

## D2 - SIGNATURE CHAIN (for: /how-it-works, /report, /security) - PLACED on /how-it-works already

```html
<figure class="diag reveal" role="img" aria-label="Signature chain: canonical report bytes are hashed with SHA-256 and signed with Ed25519; altering any byte voids the seal">
<svg viewBox="0 0 720 176" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path class="dg-flow" d="M150 60 H186 M330 60 H366 M548 60 H584"/>
  <rect class="dg-box" x="8" y="28" width="142" height="64" rx="9"/>
  <text class="dg-label dg-label--up" x="22" y="48">Bytes</text>
  <text class="dg-t" x="22" y="68">Report JSON</text>
  <text class="dg-mono" x="22" y="84">canonicalized</text>
  <polygon class="dg-ok" points="186,60 178,55.5 178,64.5"/>
  <rect class="dg-box" x="188" y="28" width="142" height="64" rx="9"/>
  <text class="dg-label dg-label--up" x="202" y="48">Digest</text>
  <text class="dg-t" x="202" y="68">SHA-256</text>
  <text class="dg-mono" x="202" y="84">32-byte hash</text>
  <polygon class="dg-ok" points="366,60 358,55.5 358,64.5"/>
  <rect class="dg-box" x="368" y="28" width="180" height="64" rx="9"/>
  <text class="dg-label dg-label--up" x="382" y="48">Signature</text>
  <text class="dg-t" x="382" y="68">Ed25519 sign</text>
  <text class="dg-mono" x="382" y="84">kid kolm-prod-2026</text>
  <polygon class="dg-ok" points="584,60 576,55.5 576,64.5"/>
  <rect class="dg-box--ok" x="586" y="28" width="126" height="64" rx="9"/>
  <text class="dg-label dg-label--up" x="600" y="48">Seal</text>
  <text class="dg-t" x="600" y="68">SEALED</text>
  <path class="dg-ok" d="M600 78 l3.5 3.5 L611 74" fill="none" stroke="#3FE5A0" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
  <path class="dg-line" d="M79 92 V140 H520" stroke-dasharray="3 5"/>
  <polygon points="520,140 512,135.5 512,144.5" fill="#E0A89F"/>
  <rect class="dg-box--void" x="522" y="120" width="190" height="40" rx="9"/>
  <text class="dg-void-t dg-k" x="536" y="138">VOID</text>
  <text class="dg-mono" x="536" y="152">one changed byte breaks it</text>
</svg>
<figcaption class="diag__cap"><b>Why it holds</b> the signature covers the exact bytes, so the report cannot be quietly edited</figcaption>
</figure>
```

## D3 - INDEPENDENT VERIFY LOOP (for: /verify, /docs, /trust-center)

```html
<figure class="diag reveal" role="img" aria-label="Verification loop: the buyer's browser fetches the report and the public keyring, verifies with WebCrypto, and reaches VALID or VOID with no kolm server in the trust path">
<svg viewBox="0 0 720 168" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect class="dg-box" x="8" y="28" width="160" height="64" rx="9"/>
  <text class="dg-label dg-label--up" x="22" y="48">Artifact</text>
  <text class="dg-t" x="22" y="68">report.json</text>
  <text class="dg-mono" x="22" y="84">signed envelope</text>
  <rect class="dg-box" x="8" y="104" width="160" height="40" rx="9"/>
  <text class="dg-t" x="22" y="122">issuer keyring</text>
  <text class="dg-mono" x="22" y="137">public keys only</text>
  <path class="dg-flow" d="M168 60 H276 M168 124 H236 V78"/>
  <polygon class="dg-ok" points="276,60 268,55.5 268,64.5"/>
  <rect class="dg-box" x="278" y="28" width="190" height="64" rx="9"/>
  <text class="dg-label dg-label--up" x="292" y="48">Buyer's browser</text>
  <text class="dg-t" x="292" y="68">WebCrypto verify</text>
  <text class="dg-mono" x="292" y="84">offline &#183; no upload</text>
  <path class="dg-line" d="M468 48 H516 M468 76 H516"/>
  <polygon class="dg-ok" points="516,48 508,43.5 508,52.5"/>
  <polygon points="516,76 508,71.5 508,80.5" fill="#E0A89F"/>
  <rect class="dg-box--ok" x="518" y="30" width="194" height="34" rx="9"/>
  <text class="dg-t" x="532" y="51">VALID</text>
  <text class="dg-mono" x="590" y="51">seal intact</text>
  <rect class="dg-box--void" x="518" y="72" width="194" height="34" rx="9"/>
  <text class="dg-void-t dg-k" x="532" y="93">VOID</text>
  <text class="dg-mono" x="590" y="93">tampered bytes</text>
  <text class="dg-mono" x="292" y="140">no account &#183; no kolm server in the trust path</text>
</svg>
<figcaption class="diag__cap"><b>Trust path</b> verification runs in the buyer's own browser against pinned public keys</figcaption>
</figure>
```

## D4 - CONTINUOUS TIMELINE (for: /pricing, /how-it-works continuous sections, product pages)

```html
<figure class="diag reveal" role="img" aria-label="Continuous attestation timeline: scheduled re-audits re-sign the report each week and a deploy forces an immediate re-sign, so the trust link always serves current evidence">
<svg viewBox="0 0 720 150" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path class="dg-line" d="M16 76 H704"/>
  <path class="dg-flow" d="M16 76 H704"/>
  <g>
    <circle class="dg-ok" cx="80" cy="76" r="4"/><text class="dg-mono" x="62" y="102">week 1</text>
    <circle class="dg-ok" cx="240" cy="76" r="4"/><text class="dg-mono" x="222" y="102">week 2</text>
    <circle class="dg-ok" cx="400" cy="76" r="4"/><text class="dg-mono" x="382" y="102">week 3</text>
    <circle class="dg-dot" cx="640" cy="76" r="5"/><text class="dg-mono" x="618" y="102">current</text>
  </g>
  <path class="dg-line" d="M512 36 V70" stroke-dasharray="3 5"/>
  <polygon class="dg-ok" points="512,70 507.5,62 516.5,62"/>
  <text class="dg-label dg-label--up" x="478" y="28">Deploy</text>
  <text class="dg-mono" x="540" y="33">forces an immediate re-sign</text>
  <text class="dg-label dg-label--up" x="16" y="28">Re-attestation</text>
  <text class="dg-mono" x="16" y="44">each dot is a fresh signed report; the same trust link always serves the newest one</text>
  <text class="dg-mono" x="16" y="132">evidence that goes stale stops being evidence</text>
</svg>
<figcaption class="diag__cap"><b>Always current</b> one stable link, re-signed on schedule and on every deploy</figcaption>
</figure>
```

## v2.2 INSTRUMENT CHROME (binding, 2026-06-11)

The site's brand system is "verification instrument + engraved document". Rules:

- Radii are squared: --r-sm 3 / --r-md 6 / --r-lg 9 / --r-xl 12. Never reintroduce
  pill radii on chips, badges, pills or status tags (2-3px stamps only).
- NO green glow box-shadows anywhere. Elevation = hairline borders + neutral
  dark shadows. Green is reserved for verification semantics (chips, ticks,
  live dots, seal states, the one hero accent line).
- PRIMARY ACTIONS ARE PAPER: .btn--primary and .nav__cta are ivory (var(--sheet))
  with near-black text - the CTA is made of the same material as the signed
  artifact. Never restore green-filled buttons.
- .idx / .eyebrow / .kicker are EXHIBIT TAGS (bordered mono stamps). Keep them.
- The .rep artifact anatomy: uppercase instrument title bar + code strip
  (::after), security-laid paper, "SN"-punched serial (.rep__id), ruler-scale
  severity bar with graticule ticks, perforated tear into the dark signature
  strip (.rep__sig::before). .vw mirrors the paper + squared chrome.
- .diag figures carry crop-mark corners (::after). Do not add a 9th background
  layer to .diag::after.

## v2.3 RICHNESS LAYER (binding, 2026-06-11)

The v2.2 discipline alone read as bland. The corrective rule: chrome stays
disciplined, the ENVIRONMENT is visibly lit. Both halves are binding.

- Atmosphere is VISIBLE: body radial spotlights (phosphor 0.11 left, cool blue
  0.085 right) + the aurora conic at 0.085/0.065 with blur(32px). Never flatten
  these back to near-zero.
- hero::after is a color field at z-index -2 UNDER the grid (::before, z -1):
  the grid reads as lit, not drawn. Do not repurpose hero::after.
- Headlines are silver-struck: h1/h2/.metric__n carry a white-to-silver
  gradient via background-clip:text inside an @supports guard; .go spans need
  their OWN phosphor gradient + clip rule (children of clipped parents render
  the parent ink otherwise). No h1/h2 may sit on light sheet material.
- Glass top-lights: .card:not(.pc)::after, .step::after, .tier::after,
  .plate:not(.pc)::after are centered 1px top highlights. .pc keeps its
  severity line and .diag keeps its crop marks - both stay excluded.
- The artifact plinth (.artifact::before) is a real pool of light (white 0.15
  core, phosphor rim). The .rep carries a 2px phosphor filing edge on
  ::before (z 2) - the accent as MATERIAL, never as glow.
- Spotlights: .section--ink::before 0.09; .cta-final/.cta-band::before 0.13
  doorway + cool counterlight from above. .tier--feat carries an accent wash.
- The og renderer (tmp/render-og.mjs) inherits the gradient ink through the
  shared stylesheet's h1 rules - regenerate brand-hero.png after ink changes.

## Other graphic moves available (no new CSS needed)

- `.rule--ticks` - ruler divider `<hr class="rule--ticks">` to replace a plain `.rule`
  where a section break wants a forensic measurement feel (use sparingly, max 1-2/page).
- `data-count` on a `.metric__n` whose text is a PURE number (optionally with suffix,
  e.g. `115` or `48h`): scroll-triggered count-up. NEVER on evidence-locked strings,
  never on non-numeric metrics.
- Pointer-tracked card light and button sheen are automatic (no markup changes).
