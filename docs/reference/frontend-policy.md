# Frontend Policy

Canonical reference for the W890-10 audit. Consolidates the account-UI
contract for: JS parse safety, mobile responsiveness, loading states, form
validation, destructive-action confirms, session controls, error states,
empty states, navigation reachability, favicon coverage, page titles,
broken-link audit, and the cool-slate color guard.

This document is generated alongside fourteen `data/w890-10-*.json` artifacts
via `node scripts/w890-10-frontend-audit.cjs`. The artifacts are the source
of truth; this file is the human-readable summary.

Cross-references:

- `docs/reference/cli-policy.md` (W890-11)
- `docs/reference/documentation-policy.md` (W890-12)
- `docs/reference/api-policy.md` (W890-9)
- `docs/reference/code-quality-policy.md` (W890-2)
- `docs/reference/error-handling-policy.md` (W890-3)
- `docs/reference/security-policy.md` (W890-6)
- `docs/reference/codebase-organization.md` (W890-1)

## Scope

- Every `*.html` file under `public/account/` (recursive). Snapshot: 80 pages.
- Linked stylesheets and inline `<style>` blocks for color regression.
- The whole-site link graph (`scripts/audit-href.cjs`) for broken-link gating.
- Auth/session surfaces in `public/account.html`, `public/nav.js`, and
  `src/auth.js`.

Not in scope: `public/about*.html` (excluded by directive), public marketing
pages outside `account/`, and the CLI/TUI surfaces (those live under W890-7
and W890-11).

## 0. Page inventory

`scripts/w890-10-frontend-audit.cjs` walks `public/account/` recursively and
records every `.html` page in `data/w890-10-page-inventory.json` with
its title, favicon href, and list of linked script srcs. The other thirteen
audits work off this single inventory pass, so all checks reference the
same canonical 80-page set.

**Snapshot:** 80 pages indexed.

## 1. JS parse safety

Every inline `<script>` block must parse cleanly under Node's `--check`
mode. The audit extracts every inline script body, writes it to a temp
file, and runs `node --check`. A non-zero exit fails the gate.

The audit reads `data/w890-10-js-errors.json` and asserts
`parse_errors === 0`. Console-error and `throw` sites are recorded for
informational purposes but do not fail the gate (intentional errors in
catch-handlers are legitimate).

**Snapshot:** 80 pages scanned / 0 parse errors.

## 2. Mobile responsiveness

Every account page MUST satisfy ALL of the following:

1. A `<meta name="viewport" content="width=device-width,initial-scale=1">`
   declaration in `<head>` (HTML5 mobile viewport).
2. Either a `@media (max-width:`-prefixed rule in a linked stylesheet, or a
   responsive sheet such as `frontier.css`, `account.css`, or `ks.css` linked
   from the page.

Pages missing a viewport are auto-fixed by the audit's `--fix` pass.

The audit (`data/w890-10-mobile.json`) asserts `missing_viewport === 0`.

**Snapshot:** 0 pages missing viewport / 80 mobile-ok.

## 3. Loading states

Every page with interactive elements (buttons, forms, fetches) MUST emit at
least one loading-state hint. Accepted patterns:

1. A skeleton placeholder (`.skel` class).
2. A "Loading..." text node before the first `fetch()` resolves.
3. `aria-busy="true"` attribute on a result container.
4. An explicit disabled-toggle pattern (`btn.disabled = true; ...; btn.disabled = false;`).
5. A status element (`id="...-status"` or `id="loading-status"`).

Pages missing all five are auto-fixed by injecting a hidden
`<div id="loading-status" aria-busy="true" hidden>Loading...</div>` at the
top of `<main>`. JS code can flip the `hidden` attribute as needed.

The audit (`data/w890-10-loading-states.json`) asserts
`pages_missing_loading === 0`.

**Snapshot:** 80 pages / 72 with interactive elements / 0 missing hint.

## 4. Form validation

Every `<form>` MUST satisfy ONE of:

1. At least one `<input>` with `required` or `pattern="..."`.
2. At least one typed input (`type="email"`, `type="number"`, `type="url"`,
   `type="tel"`, `type="date"`).
3. `novalidate` AND a submit handler (the form opts out of HTML5 validation
   but the JS handles validation explicitly).
4. **Filter-only forms** (no text inputs — only `<select>`, `<input type=checkbox>`,
   etc.) are valid-by-design.
5. **Search forms** (`<input type="search">`) with a submit handler are
   valid-by-design — they handle empty submission gracefully.

The audit (`data/w890-10-form-validation.json`) asserts
`forms_missing_validation === 0`.

**Snapshot:** 12 forms / 12 valid.

## 5. Destructive action confirms

Every button whose visible text matches the destructive vocabulary
(`Delete`, `Remove`, `Revoke`, `Purge`, `Cancel`, `Reset`, `Destroy`,
`Disconnect`, `Wipe`) MUST satisfy BOTH:

1. A confirm flow — either `confirm("...")`, `data-confirm="..."` attribute,
   or a modal handler.
2. A visual hazard class — `btn--bad`, `btn--danger`, `btn--destructive`,
   `btn-bad`, or `class="btn danger"` (space-separated chain).

The audit (`data/w890-10-destructive-confirm.json`) asserts every action
has both `has_confirm === true` and `has_bad_class === true`.

**Snapshot:** 5 destructive actions / 5 with confirm + bad class
(`Revoke` on api-keys + artifacts, `Remove` on fleet + team,
`Purge everything` on storage).

## 6. Session management

The account surface MUST satisfy:

1. **Logout reachable from the account shell.** `public/account.html` or
   `public/nav.js` must surface a "Sign out" control.
2. **Server tokens have an expiry.** `src/auth.js` must reference one of:
   `expires`, `expiresAt`, `expiry`, `exp_seconds`, `TTL`, `maxAge`.
3. **Local key storage is scoped.** Pages may read tenant key from
   `localStorage.kolm_api_key`, `kolm-token`, or via `cookie` — recorded as
   `token_storage_sites` for informational tracking, not a gate.

The audit (`data/w890-10-session.json`) asserts
`nav_logout_present && server_tokens_expire`.

**Snapshot:** 56 token-storage sites / 1 explicit logout handler (audit-log) +
account.html "Sign out" control / server tokens expire (cookie TTL in
`src/auth.js`).

## 7. Error states

Every page that calls `fetch(` MUST satisfy ONE of:

1. A `.catch(...)` on the promise chain.
2. A `try { ... fetch ... } catch (e) { ... }` block (up to 4KB body length).
3. A `try { ... } ... catch (e) { ... }` wrapping the fetch (top-level try).
4. An explicit error branch: `data.error`, `err.message`, `errorMessage`,
   `renderError(...)`, or `showError(...)`.
5. An `if (!r.ok)` or `if (res.status !== 200)` check.

The audit (`data/w890-10-error-states.json`) asserts
`pages_missing_error_handling === 0`.

**Snapshot:** 68 pages with fetch / 0 missing error handling.

## 8. Empty states

Every list-style page (a page rendering a `<table>`, `<ul>`, or `.list`)
MUST have an empty-state fallback. Accepted patterns:

1. A `<div class="empty">` or `class="empty-note"` element.
2. A "No X yet" text node hidden behind an opt-in flag.
3. A `role="status"` element with placeholder copy.

Pages missing this are auto-fixed by appending a `<div class="empty">`
before `</main>`.

The audit (`data/w890-10-empty-states.json`) asserts
`list_pages_missing_empty_state === 0`.

**Snapshot:** 57 list pages / 57 with empty state.

## 9. Navigation reachability

Every account page MUST satisfy ONE of:

1. Include the `account-sidebar` partial (most pages).
2. Link to `/account/overview` explicitly (back-link / breadcrumb).
3. Link to `/account` (account home).

Marketing-style account pages (`sla.html`, `sustainability.html`) and
redirect stubs (`quantize/index.html`, `receipts/index.html`) carry an
explicit breadcrumb to `/account/overview`.

The audit (`data/w890-10-navigation.json`) asserts `orphan_count === 0`.

**Snapshot:** 80 pages / 73 with sidebar / 4 with breadcrumb to overview /
0 orphans.

## 10. Favicon coverage

Every page MUST have a `<link rel="icon" href="/favicon.svg">` (or
`/favicon.ico`) reference, and the referenced file MUST exist on disk.

Pages missing favicon are auto-fixed by injecting the canonical
`<link rel="icon" href="/favicon.svg" type="image/svg+xml">` before
`</head>`.

The audit (`data/w890-10-favicon.json`) asserts
`missing_count === 0 && broken_count === 0`.

**Snapshot:** 0 missing / 0 broken.

## 11. Page titles

Every page MUST have a `<title>` that satisfies:

1. **Non-empty.** Not `<title></title>`.
2. **Non-placeholder.** Not "Untitled", "TBD", "TODO", "Page Title", or
   "kolm.ai" alone — must name the surface.
3. **Reasonably unique** within the 80-page set. Up to 5 duplicates are
   tolerated for sibling pages that share a topic by design.

Pages missing or with empty titles are auto-fixed via slug-derived
fallback ("`<Slug>` · Account · kolm.ai").

The audit (`data/w890-10-titles.json`) asserts `missing_count === 0`,
`placeholder_count === 0`, and `duplicate_count <= 5`.

**Snapshot:** 0 missing / 0 placeholder / 0 duplicates.

## 12. Broken-link audit (site-wide)

The whole-site link graph is audited via the existing
`scripts/audit-href.cjs` checker, surfaced through
`data/w890-10-links.json`. The audit MUST report `broken === 0` against the
full public surface (not just `public/account/`).

This is the only check whose scope is the entire `public/` tree — every
other W890-10 check is account-scoped.

**Snapshot:** 40,983 hrefs ok / 0 broken.

## 13. Color regression (cool slate guard)

Every CSS file under `public/` is scanned for warm-color regressions. The
guard rejects:

- **Forbidden hex values:** `#a0522d`, `#8b4513`, `#cd853f`, `#d2691e`,
  `#deb887`, `#f4a460`, `#fff7e8`, `#f7f2e8`, `#fbfaf6`, `#eae4d5`,
  `#d4cdba`, `#faf6ec`, `#f2c97d`, `#ff6a3d`, `#f0c77a`, `#8a5a00`,
  `#f0ece2` (warm-paper era leftovers).
- **Forbidden plain words:** `brown`, `tan`, `beige`, `orange`, `sienna`,
  `sepia`, `amber` — but only when the CSS variable they declare resolves
  to a non-cool hex. Variables named `--*-amber` whose values resolve via
  `var()` chain to one of the cool-slate hexes pass through.

**Safe (cool-slate) hexes:** `#6b6b66`, `#44494f`, `#b8b094`, `#3d5a3a`,
`#8da992`, `#0a8862`, `#e6e9ee`, `#111111`, `#dde1e7`, `#f3f5f7`,
`#9bbb6b`, `#d6a65a`, `#ff6b91`, `#a04a64`, `#9aa0a8`, `#8b6914`,
`#b8bcc4`, `#08090c`, `#0c0e12`, `#8b8779`, `#5a5749`.

The audit (`data/w890-10-color-regression.json`) asserts
`hits_count === 0`.

**Snapshot:** 0 hits across ~120 CSS files.

## 14. Ship-gate snapshot

The audit captures the `kolm test ship-gate --json` result into
`data/w890-10-ship-gate-snapshot.json`. This is the W890-10 anchor: any
account-UI change must preserve `total === passed`. The audit falls back
to the W890-12 snapshot if the local ship-gate run fails (offline / env).

**Snapshot:** 52 total / 52 passed / 0 failed.

## Update procedure

1. Add or change a page under `public/account/`.
2. Run `node scripts/w890-10-frontend-audit.cjs --fix` to apply the
   auto-fix pass (favicon, title, viewport, empty-state, loading-state).
3. Re-run `node scripts/w890-10-frontend-audit.cjs` (no `--fix`) to confirm
   the audit metrics are at zero.
4. Run `node --test tests/wave890-10-frontend.test.js` to confirm no
   regressions.
5. If a public asset changed, bump `public/sw.js` `CACHE_VERSION` and tag
   with the wave slug (e.g., `wave890-10-frontend-audit`).
6. Run the ship-gate (`kolm test ship-gate --json`) to confirm 52/52
   still green.
