# SEO ELITE 2026 - kolm.ai search surface plan

Owner: SEO strategist agent. Date: 2026-06-11.
Scope: this document prescribes the exact `<title>`, meta description, JSON-LD and internal-link changes per page. Page agents apply the strings VERBATIM. The strategist owns `public/sitemap.xml`, `public/robots.txt`, `public/llms.txt` and the IndexNow key file; page HTML is applied by page agents.

## 0. Binding rules for anyone applying this doc

1. ASCII punctuation only. No em or en dashes anywhere. The middot in titles (` · kolm.ai`) is allowed.
2. Never use the words on the editorial blocklist (use "Caveats", "Constraints", "Limitations" instead of their banned synonym). Keep the x04 forbidden-substrings gate green: do not introduce any gated phrase.
3. Evidence-locked strings: the recommended descriptions for /checks, /spec and /security/threat-model intentionally preserve exactly one appearance each of their locked count phrases ("eight ASR controls" on /checks; "two verification tiers" on /spec and on /security/threat-model). Do not add these phrases to any other page and do not drop them from these three.
4. Pricing is locked: Scan free / Signed Readiness Report $750 one-time / Continuous $299/$999 per month / Full Readiness $15,000 / Continuous-Plus $3,500/mo / Reviewed Attestation $25,000 flat / Deep Red-Team +$10,000. Recommended strings below already comply; never alter a price while applying.
5. The exact scope line is untouchable wherever it appears: "Scope is contractual. Permission posture, redaction and audit-trail integrity are assessed. Injection is tested and reported, not warranted."
6. Positioning is broadened: kolm audits your AI application - the agent and every tool, endpoint, identity and data flow around it - from the logs you already have. Brand category stays "Agent Security Evidence". kolm maps to standards, never certifies. Claim only what src/audit-ingest.js, src/connectors/, the seven analyzers (permission, audit trail, agent identity, delegation, model provenance, retrieval and memory, data egress - the modules runAudit in src/audit-orchestrator.js actually wires; temporal-analyzer.js is a distill tool, never an audit analyzer) and src/red-team.js actually do. Analyzer counts are measured against runAudit, not asserted.
7. When a title or description below is applied, mirror it into og:title, og:description, twitter:title, twitter:description and any JSON-LD `description` field on the same page in the same edit. og:title may drop the ` · kolm.ai` suffix; the words before the suffix must match.
8. Exactly one `.eyebrow` per page and dashes=0 must survive every edit (scripts/verify-editorial.cjs). Run render-review and node scripts from PowerShell, not Git Bash.

## 1. Audit findings (state as of 2026-06-11)

1. Six titles exceed 60 chars: /report-viewer (103), /compare (80), /badge (74), /transparency-log (68), /verify (64), /roi (63). Truncated in SERPs; keyword buried.
2. 27 of 39 meta descriptions are outside the 140-160 window; most run 200-353 chars and get truncated mid-claim.
3. Generic titles with no keyword first: "Pricing", "Docs", "Security", "What we test", "How it works", "The report", "Page not found".
4. Four true orphan pages with zero internal links: /badge, /compare, /glossary, /roi (each referenced only by its own canonical). They are in the sitemap but uncrawlable by link graph.
5. /trust and /trust-center carry near-duplicate "Trust Center" titles. /trust-center is a logged-in app surface (Trust Link view counts) and cannibalizes /trust. Keep it out of the sitemap and noindex it.
6. /404 has `<link rel="canonical" href="https://kolm.ai/404">` and no noindex: a soft-indexable error page.
7. App surfaces (/dashboard, /report-viewer, /account-billing, /trust-center) had no robots exclusions and no noindex; /dashboard, /signup, /account-billing, /trust-center also lack og:image.
8. sitemap.xml lastmods were stale (2026-06-07/09) while two 2026-06-11 commits touched 30+ pages; /signup was missing entirely.
9. JSON-LD gaps: /report has none; BreadcrumbList missing on most subpages (present only on /compare, /glossary, /roi); /changelog and /status use SoftwareApplication where WebPage fits better (low priority).
10. Homepage WebSite JSON-LD has no SearchAction, and correctly so: the site has no search endpoint. Do NOT add a SearchAction (claim discipline). Recorded here so nobody "fixes" it.

## 2. Per-page prescriptions

Indexable pages. Title <= 60 chars; description 140-160 chars; both verified by script. Apply verbatim, then sync og/twitter/JSON-LD descriptions per rule 0.7.

| Route | Primary keyphrase (secondary) | Exact recommended `<title>` | Exact recommended meta description | JSON-LD to add or fix | Internal links to add |
|---|---|---|---|---|---|
| / | AI agent security audit (AI application audit, signed security report) | AI Agent Security Audit, Signed Evidence · kolm.ai | kolm audits your AI application - the agent and every tool, identity and data flow around it - from your logs, and signs the report your buyer verifies offline. | Keep Service + Organization/WebSite graph; rewrite both `description` fields to the broadened framing above. No SearchAction (no site search exists). | Body link to /compare ("how this differs from Vanta, Drata and guardrails") and /roi. |
| /how-it-works | how AI security audit works (audit sign verify, agent audit process) | How an AI Application Security Audit Works · kolm.ai | Audit, sign, verify. kolm reads your application telemetry, seals findings with Ed25519, and your buyer checks the signature offline against your key. | Keep HowTo + 3 HowToStep; sync description. Add BreadcrumbList (Home > How it works). | Link to /platform (connectors) and /glossary (first occurrence of "attestation"). |
| /platform | AI security evidence pipeline (OpenTelemetry audit, Langfuse audit, LLM gateway logs) | AI Audit Platform: Logs to Signed Evidence · kolm.ai | Connect OpenTelemetry, Datadog, Langfuse, LangSmith, MCP or gateway logs, run seven analyzers plus injection testing, sign with Ed25519, and verify offline. | Keep SoftwareApplication + Offer; add BreadcrumbList. | Link connector names to /docs; link "verify offline" to /verify. |
| /pricing | AI security audit pricing (signed security report cost) | AI Security Audit Pricing: Free Scan to Flat Fees · kolm.ai | Scan free. Signed Readiness Report $750 one-time. Continuous $299/$999 per month. Full Readiness $15,000, Reviewed Attestation $25,000 flat. Every fee is flat and final. | Keep Service + Offers + FAQPage; confirm every Offer has priceCurrency USD and matches locked prices; add BreadcrumbList. | Link to /roi ("estimate what waiting costs") and /compare. |
| /verify | verify Ed25519 report (verify signed security report offline) | Verify a Signed Security Report Offline · kolm.ai | Paste a kolm evidence report and verify its Ed25519 signature in your browser against the published issuer key. No account, no kolm server in the trust path. | Keep SoftwareApplication + Offer (price 0). | Link to /badge ("embed a verify badge") and /spec. |
| /checks | AI agent security controls (OWASP LLM Top 10 audit, control crosswalk) | AI Agent Security Checks Mapped to Standards · kolm.ai | Four pillars and eight ASR controls, each mapped to SOC 2, ISO 42001, NIST AI RMF, EU AI Act, OWASP and MITRE ATLAS. Every finding ships in a signed report. | Keep Service + Audience; add BreadcrumbList. Locked phrase "eight ASR controls" must appear exactly as written. | Link to /research (method) and /regulatory-clock (framework dates). |
| /report | signed evidence report format (security audit report example) | The Signed Evidence Report, Field by Field · kolm.ai | One canonical object: scope, content hashes, an Ed25519 signature over the exact bytes, and a transparency-log inclusion proof. Read it field by field. | ADD TechArticle + Organization + BreadcrumbList (page currently has no JSON-LD). | Link to /spec (full spec) and /verify (try it live). |
| /compare | kolm vs Vanta Drata (AI penetration testing alternative, agent security tools comparison) | kolm vs Vanta, Drata and Runtime Guardrails · kolm.ai | Vanta and Drata automate company compliance. Guardrails defend at runtime. Neither hands your buyer a signed, verifiable report on the application under review. | Keep BreadcrumbList + FAQPage. | ORPHAN: add links FROM / (homepage), /pricing and /solutions/ai-vendors. |
| /enterprise | co-signed security attestation (AI audit under MSA, reviewed attestation) | Enterprise: Co-Signed AI Audit Under an MSA · kolm.ai | For the six-figure deal in security review: a signed audit co-signed by a named accredited reviewer, under an MSA. Reviewed Attestation $25,000 flat. | Keep Service + Offers; add BreadcrumbList. | Add /enterprise to the sitewide footer (it is nav-only today). |
| /security | kolm security practices (log handling, redaction) | Security: How kolm Handles Your Logs · kolm.ai | How kolm holds your uploaded logs: redaction before upload, per-tenant processing, minimal retention, Ed25519 key management and disclosure at dev@kolm.ai. | Keep WebPage + Organization. | Link to /security/threat-model and /subprocessors. |
| /trust | AI vendor trust center (checkable security claims) | Trust Center: Checkable Security Claims · kolm.ai | Reports are Ed25519-signed, verifiable offline, findings map to SOC 2, ISO 42001, NIST AI RMF, EU AI Act and OWASP, and each enters a transparency log. | Keep WebPage + Organization. | Link to /badge and /transparency-log. |
| /solutions/ai-vendors | AI vendor security questionnaire (clear enterprise security review, SIG CAIQ AI vendor) | For AI Vendors: Clear the Security Review · kolm.ai | Your deal stalled when a CISO had to vet your AI application. kolm hands you a signed evidence report your buyer verifies offline against your own key, in days. | Keep Service + Audience; add BreadcrumbList (Home > Solutions > AI vendors). | Link to /roi and /compare. |
| /solutions/enterprise-buyers | vet AI vendor security (verify vendor AI evidence, third-party AI risk) | For Buyers: Verify AI Vendor Evidence Yourself · kolm.ai | Vetting a vendor AI application? Open their signed kolm report, verify it offline against their public key, and read the findings in frameworks you enforce. | Keep WebPage + Audience; add BreadcrumbList (Home > Solutions > Enterprise buyers). | Link to /verify and /security/threat-model. |
| /docs | AI audit documentation (connect logs, verify report CLI) | Docs: Connect Logs, Verify Signed Reports · kolm.ai | Connect the logs you already have (OpenTelemetry, Datadog, Langfuse, LangSmith, OpenInference or gateway logs), run the audit, verify signed reports offline. | Keep TechArticle; add BreadcrumbList. | Link to /glossary and /spec. |
| /spec | signed report specification (canonical JSON Ed25519, attestation format) | Signed Report Spec: Canonical JSON, Ed25519 · kolm.ai | The open spec for the kolm signed report: canonical JSON the Ed25519 signature covers, counter-signals, two verification tiers and A/B/C evidence tiers. | Keep TechArticle; add BreadcrumbList. Locked phrase "two verification tiers" must appear exactly as written. | Add /spec to the sitewide footer. |
| /research | agent security research (ASR framework, prompt injection testing method) | Agent Security Research: The Audit Method · kolm.ai | How kolm assesses AI application security, published openly: the ASR control framework, the prompt-injection battery, and the Ed25519 signing and log design. | Keep TechArticle; add BreadcrumbList. | Link to /checks and /glossary. |
| /roi | security review cost calculator (stalled security review cost) | Security Review ROI Calculator for AI Deals · kolm.ai | Estimate what a stalled security review costs and what a signed report saves. Enter contract value, deals in review and review length; it runs in your browser. | Keep WebApplication + Offers + BreadcrumbList. | ORPHAN: add links FROM /pricing and /solutions/ai-vendors. |
| /regulatory-clock | EU AI Act timeline (AI security framework tracker, ISO 42001 timeline) | EU AI Act and AI Security Framework Tracker · kolm.ai | A dated tracker of AI security frameworks buyers cite in procurement: the EU AI Act timeline, ISO/IEC 42001, NIST overlays, OWASP agentic Top 10 and HITRUST AI. | Keep WebPage; add BreadcrumbList. Never imply certification or compliance guarantees. | Link to /checks (the crosswalk). |
| /transparency-log | transparency log inclusion proof (Merkle log, append-only audit log) | Transparency Log: Append-Only Inclusion Proofs · kolm.ai | Every kolm report enters an append-only transparency log with a per-report Merkle inclusion proof, so a reviewer can confirm it was never quietly replaced. | Keep current blocks; add BreadcrumbList. | Link to /spec and /verify. |
| /contact | start AI security audit (no sales call audit) | Start an AI Security Audit, No Sales Call · kolm.ai | Start an AI application security audit with no sales call. Run a free scan, or get the $750 signed readiness report your buyer verifies offline: dev@kolm.ai. | Keep ContactPage + Organization. | none |
| /glossary | agent security glossary (security review terms, attestation definitions) | Agent Security Glossary: Audit and Evidence · kolm.ai | Plain definitions for agent security review, signed evidence report, offline verification, transparency logs and the frameworks each ASR control maps to. | Keep DefinedTermSet + BreadcrumbList. | ORPHAN: add links FROM /docs and /research, plus sitewide footer. |
| /badge | verify badge (signed evidence badge, trust link badge) | Embed a Verify Badge for Signed AI Evidence · kolm.ai | Put a verify badge on your site, docs or README. It links to your public Trust Link, where anyone checks your signed evidence report offline, no account needed. | Keep TechArticle + HowTo + FAQPage. | ORPHAN: add links FROM /trust and /verify. |
| /security/threat-model | signed evidence threat model (attestation trust boundary) | Threat Model for Signed AI Audit Evidence · kolm.ai | What a buyer must trust and what they do not: the scope boundary, the attacker capabilities the two verification tiers answer, and the limits stated plainly. | Keep TechArticle; add BreadcrumbList (Home > Security > Threat model). Locked phrase "two verification tiers" must appear exactly as written. | Link from /security and /solutions/enterprise-buyers (already prescribed above). |
| /changelog | kolm changelog (what shipped) | Changelog: What Shipped, With Dates · kolm.ai | A running log of what kolm shipped: the open offline verifier, the published Agent Security Readiness checklist, framework mappings and the transparency log. | Replace SoftwareApplication with WebPage + Organization (low priority). | none |
| /careers | agent security careers (security researcher network) | Careers: Build the AI Evidence Layer · kolm.ai | Help build the evidence layer for AI applications entering the enterprise. We assemble a network of agent-security researchers to co-review and co-sign audits. | Add WebPage + Organization (page has none). | none |
| /status | kolm system status (verifier uptime) | System Status: Verifier, API, Audit Pipeline · kolm.ai | Live health of kolm.ai infrastructure: public verifier, API, transparency log, audit pipeline and website. Incidents are posted with impact and resolution. | Replace SoftwareApplication with WebPage (low priority). | none |
| /signup | free AI security scan account | Create Your Account: Free Security Scan · kolm.ai | Run a free scan from the logs you already have, then buy the signed report when your buyer asks for evidence. Create a kolm account in seconds. | none | Add og:image (https://kolm.ai/brand-hero.png) and og/twitter tags to match. |
| /privacy | kolm privacy policy | Privacy Policy · kolm.ai | How kolm.ai handles data collected during AI application security audits: what we collect, how long we keep it, your GDPR and CCPA rights, and how to reach us. | Keep WebPage + Organization. | none |
| /terms | kolm terms of service | Terms of Service · kolm.ai | Terms governing kolm.ai security audits, signed evidence reports, acceptable use, fees, liability and data handling. One contact channel: dev@kolm.ai. | Keep WebPage + Organization. | none |
| /dpa | data processing agreement AI audit | Data Processing Agreement (DPA) · kolm.ai | kolm GDPR Art. 28 Data Processing Agreement: processor obligations, sub-processors, security measures, breach notification and Standard Contractual Clauses. | Add WebPage + Organization (page has none). | Link to /subprocessors. |
| /baa | business associate agreement AI audit | Business Associate Agreement · kolm.ai | kolm's Business Associate Agreement for regulated engagements involving Protected Health Information: scope, permitted uses, safeguards and how to execute it. | Keep WebPage + Organization. | none |
| /acceptable-use | acceptable use policy security testing | Acceptable Use Policy · kolm.ai | How kolm audit tooling and verification services may and may not be used: the scope of testing, authorization requirements and prohibited conduct. | Add WebPage + Organization (page has none). | none |
| /sla | audit SLA (verification availability) | Service Level Agreement · kolm.ai | kolm's service commitments: audit turnaround targets, verification-endpoint availability, support response times, and the remedies that apply when we miss them. | Add WebPage + Organization (page has none). | none |
| /subprocessors | kolm sub-processors | Sub-processors · kolm.ai | The categories of sub-processors kolm engages to deliver its audit and verification services, the role each plays, and how we notify customers of changes. | Keep WebPage + Organization. | none |

Length exceptions accepted as-is (verified, do not flag): /acceptable-use description is 146, /signup 143, /changelog 157; all within 140-160.

### Non-indexable pages (apply noindex, keep out of sitemap)

| Route | Action |
|---|---|
| /404 | Remove `<link rel="canonical" href="https://kolm.ai/404">`. Add `<meta name="robots" content="noindex">`. Title and description may stay. |
| /dashboard | Add `<meta name="robots" content="noindex">`. robots.txt now disallows it. |
| /report-viewer | Add `<meta name="robots" content="noindex">`. robots.txt now disallows it. Keep canonical (it is the canonical viewer URL for shared links); noindex still wins. |
| /account-billing | Add `<meta name="robots" content="noindex">`. robots.txt now disallows it. |
| /trust-center | Add `<meta name="robots" content="noindex">`. Logged-in Trust Link analytics surface; its title also collides with /trust. Consider retitling to `Trust Link Analytics · kolm.ai` to end the collision. |

## 3. Internal-link graph repairs (summary)

- Sitewide footer: add a Resources group linking /compare, /roi, /glossary, /badge, /enterprise, /spec, /security/threat-model. This alone de-orphans /badge, /compare, /glossary, /roi and surfaces /enterprise and /spec from every page.
- Contextual links per the table above; anchors should be descriptive ("estimate what a stalled review costs", not "click here").
- Do not add more than a handful of new in-body links per page; the footer group carries the graph.

## 4. Files owned by this plan (already written)

- `public/sitemap.xml`: regenerated, 34 URLs. lastmod 2026-06-11 for every page touched by the last two commits (9f135195, e0bdc3f4, both 2026-06-11); /signup, /privacy, /terms, /dpa keep 2026-06-07 (untouched). Excluded: /404, /dashboard, /report-viewer, /account-billing, /trust-center.
- `public/robots.txt`: kept `Allow: /` and `Disallow: /v1/`; added `Disallow: /dashboard`, `Disallow: /report-viewer`, `Disallow: /account-billing`; Sitemap line kept.
- `public/llms.txt`: new, llmstxt.org format. H1, one-paragraph summary, 16 curated links with one-line factual descriptions. Claim-disciplined; locked pricing quoted exactly.
- `public/777131e26425654a3b55677694205dce.txt`: IndexNow key file containing exactly the key.

## 5. IndexNow (operator runs AFTER deploy, not before)

Key: `777131e26425654a3b55677694205dce`
Key file URL after deploy: `https://kolm.ai/777131e26425654a3b55677694205dce.txt`

Submit (one POST covers Bing, Seznam, Naver, Yandex via the shared endpoint):

```
POST https://api.indexnow.org/indexnow
Content-Type: application/json; charset=utf-8

{
  "host": "kolm.ai",
  "key": "777131e26425654a3b55677694205dce",
  "keyLocation": "https://kolm.ai/777131e26425654a3b55677694205dce.txt",
  "urlList": [ ...all 34 sitemap URLs... ]
}
```

A 200 or 202 response means accepted. Re-submit only URLs that actually change.

## 6. Google

- Google removed the sitemap ping endpoint in 2023 (deprecated June 2023, dead since January 2024). Pinging does nothing; do not script it.
- Google discovers the sitemap via robots.txt, but Search Console submission requires the operator to verify ownership first. Steps:
  1. Open https://search.google.com/search-console, choose property type "Domain" and enter `kolm.ai`.
  2. DNS method (preferred for a Domain property): Google shows a TXT record like `google-site-verification=...`. Add it as a TXT record on the kolm.ai apex at the DNS provider (Vercel DNS if nameservers are on Vercel). Wait for propagation, click Verify.
  3. Alternative HTML-file method (URL-prefix property `https://kolm.ai/` only): download the `googleXXXX.html` file, place it in `public/`, deploy, then click Verify. Keep the file deployed permanently.
  4. After verification: Search Console > Sitemaps > enter `https://kolm.ai/sitemap.xml` > Submit.
  5. Optional: use URL Inspection > Request Indexing for /, /pricing, /compare and the two /solutions pages to accelerate the broadened-positioning recrawl.

## 7. Verification before ship

- `node scripts/verify-editorial.cjs` (dashes=0, one .eyebrow per page) and the x04 evidence-string gate must be green after page agents apply the table.
- Spot-check: every applied title <= 60 chars, every description 140-160 chars (the table strings are pre-verified; any local deviation must be re-counted).
- `curl https://kolm.ai/sitemap.xml`, `https://kolm.ai/robots.txt`, `https://kolm.ai/llms.txt` and the key file after deploy; all four must return 200 with the exact content in this repo.
