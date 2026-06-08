# kolm.ai web (Next.js migration)

This is the Next.js 14 (App Router) + TypeScript + Tailwind + shadcn/ui rebuild
of the kolm.ai marketing site. It is the clean foundation that will replace the
hand-written static site in `../public` once the remaining pages reach parity.

The live static site (`../public`, 27 pages on Vercel) stays up and authoritative
until this app reaches parity and is cut over. Nothing here changes the live
site; this directory is self-contained.

## Stack

- Next.js 14 App Router, React 18, TypeScript (strict)
- Tailwind CSS 3.4 with `tailwindcss-animate`
- shadcn/ui component primitives (`components/ui/*`: Button, Card, Badge),
  restyled onto the kolm design tokens
- Self-hosted fonts (the three voices): Cabinet Grotesk (display), Switzer
  (text), Spline Sans Mono (machine) - copied to `public/fonts`, CSP-safe, no CDN

## Develop

```bash
cd web
npm install
npm run dev      # http://localhost:3000
```

Other scripts:

```bash
npm run build      # production build (also the CI parity gate)
npm run start      # serve the production build
npm run lint       # next lint
npm run typecheck  # tsc --noEmit
```

## What is in this scaffold

| Route          | File                        | Status                                  |
| -------------- | --------------------------- | --------------------------------------- |
| `/`            | `app/page.tsx`              | Ported - new hero + verified-by strip   |
| `/pricing`     | `app/pricing/page.tsx`      | Ported - the full price ladder          |
| `/sample`      | `app/sample/page.tsx`       | Ported - live verifier + report viewer  |
| everything else| `../public/*.html`          | Still served by the live static site    |

Shared shell: `components/site-header.tsx`, `components/site-footer.tsx`.
Design tokens live in `app/globals.css` (ported verbatim from
`../public/kolm-2026.css`) and are surfaced to Tailwind in `tailwind.config.ts`.

## The design system

`app/globals.css` ports the kolm tokens one-to-one:

- warm-paper light surfaces (`--paper`, `--paper-2`, `--paper-sink`) for the
  editorial world, deep "ledger" dark (`--ink-deep*`) for the proof world
- one signal green (`--accent`) that means VERIFIED, and a desaturated `--void`
  for the tampered state (never alarm-red)
- the three type voices wired as `--font-display` / `--font-sans` / `--font-mono`

shadcn semantic tokens (`background`, `foreground`, `primary`, ...) are mapped
onto the same palette in `tailwind.config.ts`, so generated components inherit
the brand without a second source of truth.

## The verifier and the `/v1/*` API carry over unchanged

This is the load-bearing invariant of the whole product, and it survives the
migration without a code change:

- The browser verifier (`public/kolm-audit-verify.js`) is copied **byte-for-byte**
  from the static site. `components/verify-widget.tsx` loads it as a native
  dynamic import (`webpackIgnore`), so webpack never rebundles or rewrites it.
  The canonicalization stays identical to `src/attestation-report-builder.js`,
  the Python SDK and the Go SDK. We did not touch how any field is canonicalized
  or signed.
- The live API surface (`/v1/audit`, `/v1/verify`, `/health`) is proxied to the
  existing backend via `next.config.mjs` `rewrites()`. Set `KOLM_API_ORIGIN` to
  point at the backend (defaults to `https://kolm.ai`). The browser verifier
  needs **no** server, so it works offline regardless; the proxy is only for the
  audit/issuance endpoints the dashboard and signup flows call.
- The signed sample report and the issuer keyring are copied to `public/` so the
  verifier has real artifacts to check in local dev.

## Migration plan (port order for the remaining 26 pages)

Port in value order, shipping each page behind the parity gate (`npm run build`
green + a visual diff against the live static page). Group by template so the
shared components land once:

1. **Conversion core** - `/how-it-works`, `/checks` (what we test), `/contact`,
   `/signup`. These finish the primary funnel the home page points at.
2. **Trust surface** - `/verify` (mount the full `verify-widget.js` experience),
   `/trust`, `/security`, `/transparency-log`, `/status`. Reuse `VerifyWidget`.
3. **Product depth** - `/platform`, `/report`, `/docs`, `/research`,
   `/enterprise`, `/dashboard`.
4. **Legal + company** - `/privacy`, `/terms`, `/dpa`, `/baa`,
   `/subprocessors`, `/sla`, `/acceptable-use`, `/changelog`, `/careers`.
   These are mostly long-form prose; port as MDX or typed content for reuse.
5. **Edges** - `/404`, `robots`, `sitemap`, `manifest` (Next metadata + route
   handlers).

Each ported page deletes nothing from `../public` until cutover; the two run
side by side.

## Cutover (Vercel)

The live site is a static deploy of `../public`. To cut over with zero downtime:

1. Reach parity (all 28 routes ported, build green, visual diff clean).
2. Point the `kolm.ai` Vercel project's root/build at `web/` (Next build output)
   instead of the static `public/` directory, keeping the same domain alias.
3. Keep the `/v1/*` and `/health` rewrites pointed at the backend so the
   verifier, audit and signup flows keep working through the swap.
4. Promote to production. If anything regresses, roll back to the previous
   static deployment - the static site is untouched and still deployable.

Do not wire any deploy from this scaffold. Cutover is a deliberate, gated step.

## Conventions

- No em or en dashes in copy. Spaced hyphens only.
- The only contact address is `dev@kolm.ai`.
- Mono (`font-mono`) only where a machine speaks: hashes, control IDs, the
  verifier, verdict chips. Prose is Switzer; headlines are Cabinet Grotesk.
