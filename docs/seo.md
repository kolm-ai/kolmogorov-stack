# SEO and cutover plan

How kolm.ai earns and keeps organic reach, and how the Next.js app in `web/`
reaches full parity with the static `public/` site so we can cut over without
losing a single ranking signal or inbound link.

The product is one specific thing: **signed, offline-verifiable security
evidence for AI agents entering the enterprise** - the "SOC 2 for AI agents."
Every keyword, page, and schema below points back to that.

---

## 1. Keyword targets

Organized by buyer intent. Primary terms are the head we compete for; the
supporting cluster is the long tail that feeds the same pages.

### Cluster A - The agent vendor whose deal is stuck in security review
Primary page: `/` and `/solutions/ai-vendors`

| Keyword | Intent | Target page |
| --- | --- | --- |
| AI agent security review | commercial | `/` |
| pass enterprise security review AI | commercial | `/solutions/ai-vendors` |
| security questionnaire for AI agent | commercial | `/checks` |
| SOC 2 for AI agents | brand-defining | `/` |
| AI agent security evidence | commercial | `/report` |
| speed up enterprise security review | commercial | `/how-it-works` |
| vendor security assessment AI agent | informational | `/checks` |

### Cluster B - The enterprise buyer vetting an agent
Primary page: `/solutions/enterprise-buyers`

| Keyword | Intent | Target page |
| --- | --- | --- |
| how to evaluate AI agent security | informational | `/solutions/enterprise-buyers` |
| verify AI vendor security claims | commercial | `/verify` |
| AI agent risk assessment | informational | `/solutions/enterprise-buyers` |
| third party AI agent audit | commercial | `/report` |
| agent least privilege audit | informational | `/checks` |

### Cluster C - Standards and framework mapping
Primary page: `/trust` and `/security`

| Keyword | Intent | Target page |
| --- | --- | --- |
| ISO 42001 AI management | informational | `/trust` |
| NIST AI RMF agent controls | informational | `/trust` |
| EU AI Act agent compliance | informational | `/trust` |
| OWASP LLM Top 10 testing | informational | `/security` |
| MITRE ATLAS agent | informational | `/security` |
| prompt injection testing | informational | `/security` |

### Cluster D - Mechanism and proof
Primary page: `/how-it-works`, `/verify`, `/transparency-log`

| Keyword | Intent | Target page |
| --- | --- | --- |
| Ed25519 signed report | informational | `/verify` |
| offline verifiable attestation | informational | `/verify` |
| tamper evident audit log | informational | `/transparency-log` |
| reproducible security report | informational | `/how-it-works` |

### Cluster E - Vertical demand
Primary pages: `/solutions/finance`, `/solutions/healthcare`,
`/solutions/critical-infrastructure`

| Keyword | Intent | Target page |
| --- | --- | --- |
| AI agent security financial services | commercial | `/solutions/finance` |
| HIPAA AI agent | commercial | `/solutions/healthcare` |
| agent security critical infrastructure | commercial | `/solutions/critical-infrastructure` |

---

## 2. Structured data (JSON-LD)

Schema is how we win rich results and feed the knowledge graph. Markup must
always match content visible on the page (Google rejects mismatched FAQ/Offer
markup).

| Entity | Where | Status |
| --- | --- | --- |
| `Organization` | `/` (static + Next root layout `@graph`) | shipped |
| `WebSite` | `/` (static + Next root layout `@graph`) | shipped |
| `Service` + `Offer[]` | `/` and `/pricing` | shipped (static) |
| `FAQPage` | `/pricing` (8 real Q&A, matches visible cards) | shipped |
| `BreadcrumbList` | solutions + legal sub-pages | backlog |
| `TechArticle` | `/research`, `/docs` deep pages | backlog |

Implementation notes:
- The Next app emits `Organization` + `WebSite` once from `app/layout.tsx`, so
  the graph is present on every route. Per-page `Service`/`FAQPage` schema lives
  in the individual `page.tsx` `metadata` or an inline script.
- The static site carries the same `Organization` + `WebSite` graph in
  `public/index.html`, plus `Service`/`Offer` on `/` and `/pricing` and the
  `FAQPage` on `/pricing`.
- Keep `@id` anchors stable (`https://kolm.ai/#organization`,
  `https://kolm.ai/#website`) so cross-references resolve to one node.

---

## 3. Content-cluster (hub and spoke) plan

Each hub is a strong, linkable page; spokes are supporting pages and future
articles that link up to the hub and across to siblings.

```
HUB: / (signed security evidence for AI agents)
 |- /how-it-works   (audit -> sign -> verify mechanism)
 |- /checks         (what we test: ASR control families)
 |- /report         (the artifact)
 |- /verify         (prove it yourself, offline)
 |- /pricing        (flat fees + FAQPage)

HUB: /trust (standards and framework mapping)
 |- /security              (threat coverage, OWASP, ATLAS)
 |- /security/threat-model (the model)
 |- /transparency-log      (append-only issuance)
 |- /subprocessors, /dpa, /baa (data-handling proof)

HUB: /enterprise (procurement and large buyers)
 |- /solutions/ai-vendors
 |- /solutions/enterprise-buyers
 |- /solutions/finance
 |- /solutions/healthcare
 |- /solutions/critical-infrastructure
 |- /customers
```

Internal-linking rules:
- Every spoke links back to its hub and to at least one sibling.
- The hub links down to each spoke from body copy, not just the footer nav.
- Money pages (`/pricing`, `/contact`, `/solutions/*`) are reachable in <=2
  clicks from `/`.

Future content (spokes to publish): "How an enterprise vets an AI agent",
"OWASP LLM Top 10 for autonomous agents", "Why a questionnaire is not evidence",
"ISO 42001 vs SOC 2 for agents". Each maps to a cluster above and targets an
informational keyword.

---

## 4. Technical SEO and the static -> Next cutover

The Next app in `web/` must be at full parity before kolm.ai points at it.

### Sitemap, robots, manifest (Next, file-based metadata)
- `web/app/sitemap.ts` - dynamic sitemap covering every indexable route under
  `web/app` with tuned priority/changefreq. Noindex/utility surfaces (the
  not-found handler, dashboard, signup, report viewer) have no route here and
  are excluded by construction.
- `web/app/robots.ts` - allow all, disallow `/v1/`, point at
  `https://kolm.ai/sitemap.xml`.
- `web/app/manifest.ts` - PWA manifest, SVG icon, light "warm paper" theme.
- The static site keeps `public/sitemap.xml`, `public/robots.txt`, and
  `public/manifest.webmanifest`; `public/sitemap.xml` already lists all 27
  indexable static pages (audited - nothing missing).

### Redirects (the link-loss guard)
- `web/next.config.mjs` ports all permanent redirects from the static
  `vercel.json` (272 of the 273; `/customers` is dropped because it is now a
  first-class page in the Next app, and a redirect would shadow it). These are
  308s, matching the originals, so no inbound link 404s at cutover.
- The `/v1/*`, `/health`, and `/ready` rewrites to the Railway backend are kept
  unchanged - the browser verifier and audit endpoints keep working.

### Canonicals, titles, OG
- Next root layout sets `metadataBase`, the `%s · kolm.ai` title template, the
  default OG/Twitter image (`/brand-hero.png`, copied into `web/public/`), and
  `robots: index, follow`.
- Each `page.tsx` supplies its own `title`/`description`/canonical via
  `metadata`. Verify one-to-one with the static `<title>`/`<meta>`/`<link rel=
  canonical>` before cutover.

### Cutover checklist
1. `cd web && npm run build` is green.
2. Spot-check 5 legacy redirects resolve (e.g. `/wrapper`, `/soc2`,
   `/docs/anything`, `/security/threat-model.pdf`, `/threat-model`).
3. `/sitemap.xml`, `/robots.txt`, `/manifest.webmanifest` all 200 and parse.
4. Validate `Organization`, `WebSite`, `FAQPage` in the Rich Results Test.
5. Confirm `/v1/audit` + `/v1/verify` + `/health` still proxy to Railway.
6. Submit the new sitemap in Search Console; watch coverage + redirect reports
   for a week post-cutover.
