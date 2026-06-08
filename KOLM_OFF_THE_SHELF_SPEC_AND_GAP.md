# kolm.ai — Off-the-shelf spec, gap analysis, and roadmap (2026-06-09)

Built from (a) a granular 9-agent subsystem audit of the live codebase and (b) a 12-query Grok SOTA research batch (`research/strategy-2026/raw5/`). Goal: sell off the shelf (self-serve, no sales touch, passes a buyer's security review).

## Overall verdict
**The cryptographic core is production-grade; the money loop is plausibly-correct-but-unverified; onboarding is not self-serve; a few durability + enterprise-readiness gaps remain.** Per-subsystem: **solid** = audit engine, auth/tenancy, deploy/infra, security posture. **minor_issues** = paid loop, storage, frontend, tests.

Note: the audit flagged "committed production secrets (.env.prod)" as CRITICAL — VERIFIED FALSE: `.env.prod` is gitignored and was never committed (only `.env.example` is tracked). The secrets are local-only. Rotating them is optional hygiene, not a leak.

## Current-state spec (condensed)
- **Product:** vendor uploads agent logs (JSONL) -> deterministic audit (ASR-1 Least Privilege / ASR-2 Audit Trail / ASR-3 Data Egress) -> Ed25519-signed, offline-verifiable evidence report mapped to SOC2/ISO42001/NIST AI RMF/EU AI Act/OWASP/MITRE. Tiers: free watermarked Scan; $750 one-time Signed Report; $299/$999 mo Continuous; $25k Reviewed Attestation (contact).
- **Audit engine:** orchestrator -> ingest (7+ provider shapes, dedupe, PII) -> permission + trail analyzers -> control-mapper -> attestation-report-builder (canonical key-sorted JSON envelope `kolm-audit-report-1`, Ed25519, watermark signature-covered) -> HTML/PDF. Graduated non-inflated readiness. RFC 6962 transparency log built but NOT embedded in envelopes. Determinism + tamper-evidence + offline browser verify all directly tested.
- **Paid loop:** asr-billing (Checkout API or Payment Links; binding via client_reference_id asrrep_/asrsub_) + asr-fulfillment (fulfillReportPurchase idempotent resign-to-report, activateSubscription, runDueReattestations claim-then-run, resolveTrust) + webhook branch + in-process re-attestation sweep. LIVE on prod (real Stripe payment links, billing.ready:true).
- **Auth:** API-key (SHA256, constant-time) + httpOnly cookie sessions; scoped multi-key; ADMIN_KEY bypass; 170+-entry PUBLIC_API allowlist; tenant fencing in every store predicate. SSO/SAML/SCIM = config storage only (not live federation).
- **Storage:** hybrid store.js — JSON driver (dev) / SQLite (prod, WAL) on Railway volume /app/data (confirmed persistent). withTransaction = BEGIN IMMEDIATE on sqlite, no-op on JSON.
- **Frontend:** static public/*.html on Vercel; dashboard.html (key-paste + cookie), verify.html (offline WebCrypto verify + issuer keyring). No signup PAGE (email-only contact).
- **Deploy:** Vercel CDN -> Railway Express :8787. Boot normalizeEnv -> ensureSigningKey -> routes -> scheduler. vercel.json proxies /v1/* to a hardcoded Railway URL. CRITICAL TRAP (now fixed by committing): env-change rebuilds from GitHub; uncommitted code reverted — fixed by committing source to origin/main.

## Gap vs SOTA (researched ideal for an off-the-shelf agent-security-evidence product)
SOTA off-the-shelf B2B security SaaS in 2026 expects: self-serve signup -> instant value with no sales touch; multiple low-friction ingestion paths (SDK/API/CI/connectors); table-stakes controls (SSO/SAML, SCIM, RBAC, audit-log export, API+OpenAPI, webhooks, status page, SLA, the vendor's OWN SOC2); a credible trust center; durable managed datastore (Postgres); typed SDKs + sandbox; and public security artifacts (SOC2/pen-test/threat-model/disclosure). kolm has the hardest part (signed verifiable evidence + framework mapping) but is missing several of the surrounding table-stakes.

## Top blockers to off-the-shelf sellability (re-ranked; false-alarm secret blocker removed)
1. **Revenue loop unverified end-to-end** — no HTTP/webhook integration tests for checkout/trust/tick/deploy-hook/Stripe events. FIX (this pass).
2. **Persistence durability edge** — silent /tmp fallback + JSON-mode races; no sqlite indexes; no post-write read-back. FIX (this pass): hard-fail on ephemeral fallback, add indexes, read-back confirmation.
3. **No self-serve onboarding** — email-only provisioning + sessionStorage-only auth. FIX (this pass): signup page + persistent cookie auth.
4. **Real money-path bugs** — tenant-fencing in activateSubscription, null-tenant guard, webhook signer (pay-but-watermarked window), resolveTrust null seed, dashboard null-check, cron header-only. FIX (this pass).
5. **Enterprise/compliance readiness** — live SSO/SCIM, admin-key rotation, key revocation/expiry, public trust artifacts (SOC2/status/disclosure). PARTIAL (this pass: status + disclosure + staleness; ROADMAP: live SSO/SCIM + SOC2).

## This-pass implementation (bounded, high-ROI)
- Bug fixes: activateSubscription tenant cross-check + null-tenant reject; webhook passes signer to fulfillReportPurchase (sign immediately); resolveTrust handles null/seed latest_audit_id (pending state, not 404); dashboard null-checks + retryable-vs-terminal error UX; cron secret header-only.
- Persistence: hard-fail (or /ready 503) on ephemeral /tmp fallback unless KOLM_ALLOW_EPHEMERAL=1; sqlite expression indexes on tenant_id / stripe_subscription_id / public_slug; post-write read-back in fulfillReportPurchase.
- Tests: spawn-server integration tests for the money loop (checkout, trust json/html/pdf/lapsed/404, tick cron-secret, deploy-hook, mocked Stripe webhook report+continuous + idempotency + tenant isolation). New release-verify assertion that paid routes are registered.
- Self-serve: public/signup.html (calls POST /v1/signup, shows key, sets cookie, links to dashboard); persistent dashboard auth via kolm_session cookie.
- Trust/compliance signals: Trust-link staleness indicator; /.well-known/security.txt + disclosure; status page live signals; previous_report_id + previous_readiness_pct deltas; embed transparency-log signed tree head in the envelope.

## Roadmap (multi-week, NOT this pass — flagged for the operator)
- Migrate paid tables to Railway Postgres (durability + backups/PITR) — near-term sqlite+volume+hardening is adequate.
- Live SAML 2.0 + SCIM federation (WorkOS) for enterprise — currently config-only.
- Acquire SOC 2 Type II (external auditor, months) — the single biggest enterprise trust unlock for the vendor itself.
- Typed Python/Go SDKs + sandbox/test mode; more ingestion connectors (LangSmith/Datadog/OTel/GitHub Action).
- Rotate the local .env.prod ADMIN_KEY / RECIPE_RECEIPT_SECRET (hygiene; not leaked).
