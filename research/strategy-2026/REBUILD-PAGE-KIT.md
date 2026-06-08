# Rebuild Page Kit — must-keep pages on the new dark design

You are rebuilding ONE existing kolm.ai page into the new "Agent Security Evidence"
design system. Output a single self-contained `.html` file. Follow this kit exactly.

## The meta (positioning the whole site now carries)
kolm audits AI agents for enterprise security review and issues a **cryptographically
signed (Ed25519), offline-verifiable evidence report** the vendor hands to the buyer's
security team — verified against kolm's public key, offline, no account, no trust in
kolm's servers. Category line: "The evidence layer for AI agents entering the enterprise."
Lead with rigor/verifiability; treat the skeptic evaluating the stamp as a first-class reader.

## Structural template (COPY EXACTLY)
Use `public/careers-2026.html` as the structural template. From it, copy **verbatim**:
- The entire `<head>` boilerplate — then change ONLY: `<title>`, `<meta name="description">`,
  the four `og:`/`twitter:` title+description+url values, and `<link rel="canonical">`.
  Keep the font preloads, `/kolm-2026.css`, the inline theme-bootstrap script, and
  `<script defer src="/kolm-2026.js"></script>` exactly as-is.
- The entire `<header class="nav"> … </header>` block — VERBATIM, byte-for-byte.
- The entire `<footer class="foot"> … </footer>` block — VERBATIM, byte-for-byte.
Build your own `<main> … </main>` between them using the components below.

## Component classes available in kolm-2026.css
`.wrap` (max-width container) · `.section` / `.section--flush` · `.section__head` ·
`.eyebrow` (small uppercase tracked) · `.lede` · `.btn .btn--primary` / `.btn--ghost` / `.btn--sm` ·
`.hero` `.hero__grid` `.hero__cta` `.hero__claim` · `.band` `.band__item` `.badge` `.badge--ok` ·
`.card` `.card__k` `.card__map` · `.grid` `.grid--2` `.grid--3` `.grid--4` ·
`.steps` `.step` `.step__n` · `.metrics` `.metric` `.metric__n` `.metric__l` ·
`.report` (with `.lbl` `.h` `.ann` for mono crypto fields) · `.split` · `.tbl-wrap` `.tbl` ·
`.tiers` `.tier` · `.cta-final` · `.reveal` (fade-in on scroll) · `.mono` · `.ok-text`.
The single semantic accent is verification green (`var(--ok)`) — use ONLY for verified/
signature/CTA emphasis; never decorative. Crypto facts (hashes, signatures, fields) in mono.
For legal/long-form prose, plain `<h2>/<h3>/<p>/<ul>` inside `<section class="section"><div class="wrap" style="max-width:78ch">…</div></section>` reads cleanly; lead each page with a `.section--flush` hero (eyebrow + h1 + lede).

## HARD CONSTRAINTS (violating any of these fails the build)
1. NEVER use the word "honesty" or "honest" anywhere (copy, comments, alt text). Use
   "accurate / verifiable / exact / candid / plainly stated" instead.
2. The ONLY contact email anywhere is `dev@kolm.ai`. Never any other address.
3. NO named individuals / researchers anywhere. Product- and firm-level credibility only
   (e.g. "an independent assessment by Halborn" — the firm, never a person).
4. NO blockchain framing in the enterprise path. The transparency log is an Ed25519/
   SHA-256 Merkle log (RFC 6962 style), NOT a chain. Do not imply tokens/wallets/on-chain.
5. FORBIDDEN exact substrings — must NOT appear anywhere in the output:
   `pip install kolm`, `.kolm bundle`, `3B INT4`, `Arweave`, `On-chain receipt anchoring`,
   `On-chain`, `Air-gap mode`, `WASM runtime`, `kolm WASM`, `EU AI Act compliant`,
   `Type I evidence available now`, `SOC 2 Type II evidence`, `Your data never moves`,
   `data never moves`, `inside your VPC`, `BAA boundary`, `inside the BAA boundary`,
   `PHI never leaves`, `HIPAA-ready`, `Mobile SDK`.
   Allowed alternatives: "in-browser WebCrypto verification" (not WASM); "maps to EU AI Act
   Art. 12/14" (not "compliant"); "SOC 2 Type I available; Type II in progress" (exact);
   "we don't retain your agent's data; BYOC / air-gapped review available" (not "data never moves").
6. Use only ASCII punctuation-safe characters; no mojibake, no private-use glyphs, no BOM.
7. Keep all legally-substantive content: parties, definitions, data categories, sub-processor
   roles (by role, not by inventing vendors you don't find in the source), retention, security
   measures, liability/limitation, governing law, term/termination, and the dev@kolm.ai contact.
   Reframe presentation + product language to the new meta; do not drop legal substance.

## Title/description rules (a polish test checks these)
`<title>` 12–78 chars. `<meta name="description">` 50–220 chars. Both specific to the page.

## Your task
1. READ the source page named in your prompt to harvest its substantive content.
2. READ `public/careers-2026.html` for the exact head/nav/footer to reuse.
3. WRITE the rebuilt page to the staged path named in your prompt (a `*-2026.html` name).
4. Self-check against every HARD CONSTRAINT before finishing. Report the path written and
   confirm "0 forbidden substrings, no named people, dev@kolm.ai only, no 'honest*'".
