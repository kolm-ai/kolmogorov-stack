# kolm.ai Commercial Backend - MASTER WORKORDER

Date: 2026-06-15
Source: consolidated audit of 14 subsystem auditors + liveness probe + launch research.
Lead architect reconciliation. Contact email: dev@kolm.ai only.

Verification note: the lead architect independently re-checked the highest-stakes
disputed findings against live source before writing this order. Confirmed facts:
- src/asr-billing.js:58 full.amount_cents = 1500000 ($15,000). Should be $25,000.
- src/auth.js:734 uses `key === adminKey` (strict equality, NOT constant-time).
- src/audit-routes.js:1163 returns `report.envelope` (full signed data) with NO tier/payment gate.
- "honest"/"honesty" IS present in CUSTOMER-FACING surfaces: public/docs/api-routes.json,
  public/openapi.json, and the public GET /v1/changelog endpoint (src/changelog.js).
  This overrides the website-auditor "public is clean" claim and the cleanup-auditor
  "not a blocker" claim. It is a hard-constraint violation and a LAUNCH BLOCKER.
- 18 hits of forbidden contact emails (sales@/hello@/leaderboard@) in src/.

LAUNCH BLOCKER count: 12 (deduplicated; see launch-blockers.json).

------------------------------------------------------------------------
LEGEND
  Severity: BLOCKER > HIGH > MED > LOW
  Effort:   S (<2h) | M (half-day) | L (1-2 days)
  [LB] = LAUNCH BLOCKER (must clear before any customer-facing deploy)
------------------------------------------------------------------------


## TRACK A - BILLING / REVENUE-LOOP  (highest commercial risk)

### A1 [LB] BLOCKER - Free scan returns full paid report envelope (revenue leak)
- file: src/audit-routes.js:1063-1166 (return at :1163 `report: report.envelope`)
- detail: POST /v1/audit/scan authenticates the tenant then returns the COMPLETE
  signed envelope (findings, frameworks, evidence_tier, remediation, controls,
  asr_checklist). tier:'scan' watermark=true is cosmetic only; data is identical
  to tier:'report'. Any authenticated tenant gets the $750 product for free.
- fix: Gate before returning the envelope. If tenant has NOT paid (paid && tier=='report')
  AND has NO active Continuous subscription, return a summary stub only
  (readiness_pct + blocking_count + by_severity), zero findings/frameworks/evidence_tier.
  Force POST /v1/audit/report/checkout ($750) or Continuous subscription.
- effort: M

### A2 [LB] BLOCKER - GET /v1/audit/sessions/:id/report ungated (json/html/pdf)
- file: src/audit-routes.js:814-855
- detail: Retrieves stored envelope and renders in any format with no tier check.
  Tenant can scan (watermarked) then immediately fetch full JSON/HTML/PDF unpaid.
- fix: Apply the same tier/payment gate as A1. Unpaid -> 403 directing to checkout
  or Continuous subscription.
- effort: S

### A3 [LB] BLOCKER - GET /v1/audit/sessions/:id/export ungated (csv/xlsx/drata/vanta/exec/crosswalk)
- file: src/audit-routes.js:864-874 (_sendExport at :873)
- detail: Reshapes the same envelope into GRC/procurement artifacts (Drata/Vanta/Excel)
  with no tier check. Distributable professional artifact equivalent to paid tier.
- fix: Apply tier/payment gate before _sendExport. Enforce paid tier=='report' or active Continuous.
- effort: S

### A4 [LB] BLOCKER - Envelope content not differentiated by tier (design)
- file: src/attestation-report-builder.js:476-510 (builder); audit-routes.js:1163,822-854
- detail: buildAndSignReport builds an identical structure regardless of tier; only
  tier+watermark booleans differ. Watermark is signature-covered but is only a boolean,
  not proof of payment. The gate fix (A1-A3) is the enforcement point; the builder must
  be able to emit a redacted/summary variant for the scan tier.
- fix: When tier=='scan', emit summary-only envelope BEFORE signing: omit findings/
  evidence detail (keep readiness_pct, blocking_count, by_severity, severity+title stubs).
  Keep signature valid over the reduced payload. Paid path emits full envelope.
- effort: M

### A5 [LB] BLOCKER - Deep Red-Team ($10,000) product missing from catalog + fulfillment
- file: src/asr-billing.js:36-70 (catalog); src/router.js:13117-13192 (webhook)
- detail: active-redteam.js references the Deep Red-Team tier; pricing constraint requires
  +$10,000. No ASR_PRODUCTS entry and no webhook branch for asrKind=='asr_redteam'.
  Paid purchase would hit the webhook and return invalid_product, activated:false (silent fail).
- fix: Add redteam product {kind:'one_time', amount_cents:1000000, label:'Deep Red-Team',
  price_env:'KOLM_STRIPE_PRICE_ASR_DEEP_REDTEAM', kolm_product:'asr_redteam'}. Add webhook
  branch after the asr_report path to trigger Deep Red-Team probe execution + entitlement.
- effort: M

### A6 [LB] BLOCKER - Reviewed Attestation ($25,000) product missing from catalog + fulfillment
- file: src/asr-billing.js:36-70 (catalog); src/router.js:13117-13192 (webhook);
        src/attestation-report-builder.js:186,746 (S11 co-signer feature exists)
- detail: Co-signer (S11) feature exists but no billable product. Constraint:
  Reviewed Attestation $25,000 flat. No ASR_PRODUCTS entry, no webhook handler.
- fix: Add reviewed product {kind:'one_time', amount_cents:2500000, label:'Reviewed Attestation',
  price_env:'KOLM_STRIPE_PRICE_ASR_REVIEWED', kolm_product:'asr_reviewed'}. Add webhook
  branch for asrKind=='asr_reviewed' to activate co-signer entitlement.
- effort: M

### A7 [LB] BLOCKER - Full Readiness mispriced $15,000 vs locked $25,000
- file: src/asr-billing.js:58
- detail: full.amount_cents = 1500000. Reconciliation: the website ALREADY advertises BOTH
  "Full Readiness $15,000" AND "Reviewed Attestation $25,000" as distinct products (per
  website-readiness auditor). Therefore Full Readiness $15,000 is a legitimate SKU and
  must NOT simply be bumped to $25,000 (that would collide with A6). DECISION: keep
  Full Readiness at $15,000 AND add the separate Reviewed Attestation $25,000 (A6).
  The "mispriced" reading from 3 auditors is a MISREAD caused by them not having the
  separate Reviewed Attestation SKU. Action here is to add the missing $25k SKU (A6),
  not to change line 58. KEEP line 58 = 1500000.
- fix: NO CHANGE to amount on line 58. Confirm via website (audit-pricing.html shows both).
  Update the stale "Three products" comment to list all SKUs (see A9). Add the pricing
  validation test (G2) so the catalog is pinned to the locked list going forward.
- effort: S

### A8 BLOCKER->downgraded to HIGH - fulfillReportPurchase missing tenant ownership check
- file: src/asr-fulfillment.js:183-249 (findOne by audit_id only at :186); router.js:13148-13167
- detail: Audit looked up by id only; paying tenant not cross-checked against audit.tenant_id.
  Tenant A could pay for Tenant B's report if the audit_id is known. Requires collusion/knowledge
  so not strictly exploitable for free data, but is an authorization gap. Becomes reachable
  once A1-A3 gates exist.
- fix: In fulfillReportPurchase verify audit.tenant_id === stripe session tenant_id (metadata).
  Reject mismatch.
- effort: S

### A9 HIGH - asr-billing.js "Three products" comment stale (5+ SKUs)
- file: src/asr-billing.js (header comment)
- detail: Comment says three products; catalog has report/starter/growth/full/plus plus the
  two new SKUs (A5,A6). Risk of copy-paste error.
- fix: Update comment to enumerate all SKUs with amounts.
- effort: S

### A10 MED - Continuous-Plus ($3,500/mo) authorization unclear
- file: src/asr-billing.js:65-69
- detail: plus product ($3,500/mo) is in catalog but not in the originally locked spec
  (Report/Continuous 299|999/Full/Reviewed). RECONCILIATION: the website does not surface
  a $3,500 tier on the audited pricing pages. DECISION: keep the code SKU (it is functional
  and idempotent) but DO NOT advertise it; add it to the locked pricing list as an internal/
  enterprise upsell so it stops reading as "undocumented". This is a documentation action,
  not a code removal, unless product explicitly wants it gone.
- fix: Add Continuous-Plus to the locked pricing doc OR gate it behind enterprise contact.
  No code removal required for launch.
- effort: S

### A11 MED - Continuous-Plus routed through package/checkout not continuous/checkout
- file: src/audit-routes.js:1353-1397
- detail: continuous/checkout restricts to starter|growth; plus only reachable via
  package/checkout (semantically one-time). UX confusion for a recurring product.
- fix: Add 'plus' to continuous/checkout validation OR split into a dedicated recurring route.
- effort: S

### A12 MED - No tenant-facing subscription list/cancel endpoints
- file: src/audit-routes.js
- detail: activateSubscription exists but no GET /v1/audit/subscriptions (list) or DELETE (cancel).
  Customers must use the Stripe portal.
- fix: Add GET /v1/audit/subscriptions and DELETE /v1/audit/subscriptions/:id (auth-gated, tenant-fenced).
- effort: M

### A13 MED - Subscription idempotency race allows duplicate active subscriptions
- file: src/asr-fulfillment.js:339-415 (check at :349)
- detail: If webhook arrives before Stripe records subscription_id, a second purchase of the
  same product can bypass the (subscription_id, tenant)/(tenant, product) guard.
- fix: Query for ANY active subscription of same (tenant, product) BEFORE activation; reject if found.
- effort: S


## TRACK B - AUTH / CONSOLE

### B1 [LB] BLOCKER - Timing attack on admin key comparison
- file: src/auth.js:734  (`if (adminKey && key === adminKey)`)
- detail: Strict equality leaks the admin key via timing side-channel. constantTimeEqual is
  defined at :50 and exported at :57; router.js uses constantTimeEq at 3034/3070/3398. Only
  authMiddleware was missed.
- fix: Change to `if (adminKey && constantTimeEqual(key, adminKey))`.
- effort: S

### B2 [LB] BLOCKER - Missing GET /v1/audit/sessions (list) endpoint
- file: src/audit-routes.js, src/router.js (register ~:28459)
- detail: Only POST sessions / GET sessions/:id / GET sessions/:id/report exist. No list endpoint,
  so customers cannot see purchased audits in the console. Core dashboard use case is inaccessible.
- fix: Implement GET /v1/audit/sessions (auth-gated, tenant-fenced) returning sessions[] with
  {id, tenant_id, product_key, status, created_at, last_run_at, public_slug}. Register in router.js.
- effort: M

### B3 [LB] BLOCKER - Automations use in-memory Map in production (data loss on restart)
- file: src/account-ui-routes.js:223-225; src/router.js:28459 (registered with only {authMiddleware})
- detail: registerAccountUiRoutes is called without eventStore/runRecipe/cronSecret, so automations
  fall back to an in-process Map and are lost on every restart. Non-functional for production SaaS.
- fix: Pass deps: { authMiddleware, eventStore:{appendEvent,listEvents}, runRecipe, cronSecret:
  process.env.KOLM_CRON_SECRET } when registering.
- effort: M

### B4 HIGH - Manual "run again" automation returns recipe_run_not_wired
- file: src/account-ui-routes.js:353-354; router.js:28459
- detail: runRecipe not passed, so manual reruns always fail (auth/tenant-fence are correct).
- fix: Wire runRecipe (from src/runtime.js or src/compile.js) into the deps in B3.
- effort: S

### B5 MED - CSRF protection absent on session-changing endpoints
- file: src/auth.js / src/sessions.js (signin/signup/signout/session login-logout)
- detail: No CSRF tokens / double-submit pattern. sameSite=lax partially mitigates.
- fix: Add X-CSRF-Token (double-submit cookie) on POST session endpoints OR tighten sameSite to
  'strict' if no cross-site forms are required. Strict is the S option.
- effort: S

### B6 MED - Cron secret sourced from env fallback, not explicit dependency injection
- file: src/account-ui-routes.js:220; router.js:28459
- detail: Guard is correctly fail-closed but couples to process.env. Resolved by B3 wiring.
- fix: Pass cronSecret explicitly (covered by B3).
- effort: S

### B7 MED - Account pages lack deep links to specific audit reports
- file: public/account-billing.html, public/account/overview.html
- detail: Billing page lists subscriptions but offers no link to open the signed report.
- fix: Per subscription render "View latest report" -> /v1/audit/sessions/:id/report using
  latest_audit_id (depends on B2).
- effort: S

### B8 LOW - Session maxAge hardcoded 30 days, no idle logout
- file: src/sessions.js
- fix: Make configurable; add idle timeout. Post-launch acceptable.
- effort: S

### B9 LOW - Admin key has no secrets-manager integration
- file: src/auth.js (process.env.ADMIN_KEY)
- fix: Document rotation procedure; consider Vault/Secrets Manager later. Post-launch.
- effort: S


## TRACK C - SIGNING / ATTESTATION

State: COMPLETE and LAUNCH-READY per attestation auditor. No blockers, no defects.
- Ed25519 signing, 12-point offline verification, JWKS endpoint, revocation-aware,
  tier+watermark signature-covered, dev@kolm.ai contact, no forbidden substrings.
- Live: issuer-key source=env, fingerprint fa562154f99c95f48a45d04272943435 matches expected.
- ACTION: none for launch. NOTE: A4 (tier redaction before signing) touches the builder; the
  signing layer itself is unchanged - resignAsTier already preserves determinism. Coordinate
  A4 with this track so the reduced scan payload remains canonical/verifiable.


## TRACK D - STORAGE / PERSISTENCE

### D1 [LB] BLOCKER - storeEphemeral() not surfaced in /health (silent data-loss blind spot)
- file: src/router.js:26 (imports), :1583-1596 (/health); src/store.js:585-589
- detail: store.js exports storeEphemeral() with comment "Surfaced in /health" but router.js does
  not import or emit it. On Vercel/Railway, an operator cannot detect paid state landing on
  ephemeral /tmp. Fail-loudly contract broken for a PAID product.
- fix: Import storeEphemeral; add store_ephemeral field to /health body.
- effort: S
- NOTE: Live probe shows data_dir=/app/data, writable=true, volume mounted-correct, so the
  CURRENT deployment is NOT ephemeral. This is a SAFETY-NET blocker (prevents a future silent
  regression), not an active outage. Still required before launch per fail-loudly contract.

### D2 MED - backendInfo() not surfaced in /health
- file: src/router.js:26, :1583-1596; src/store.js:540-546
- fix: Import backendInfo; add `backend: store.backendInfo()` ({driver,data_dir,db_path}) to /health.
- effort: S

### D3 MED - No test coverage for /health persistence diagnostics
- file: tests/ (add health-diagnostics.test.js or extend wave890-8-storage.test.js)
- fix: Assert /health includes store_ephemeral + backend; assert storeEphemeral()===true reports
  correctly under /tmp.
- effort: S


## TRACK E - ENV / DEPLOY / INFRA  (lives mostly in http-dispatch-core + env-deploy)

### E1 [LB] BLOCKER - "honesty" terminology exposed via public /v1/changelog
- file: src/changelog.js (tags + summary text, lines 7,16,23,35-37 and others)
- detail: GET /v1/changelog (router.js ~:3657) is public and emits 'honesty' tags and an
  "honesty:" footer. Hard constraint forbids the word anywhere customer-facing.
- fix: Replace 'honesty' tag -> 'transparency'/'full-disclosure'; "honesty:" footer ->
  "constraints footer"/"caveats footer"; 'honesty contract' -> 'transparency contract'.
  Re-render any built changelog HTML.
- effort: S

### E2 [LB] BLOCKER - "honest"/"honesty" in customer-facing public/ docs
- file: public/docs/api-routes.json (14 hits), public/openapi.json (14 hits)
- detail: Independently confirmed by lead architect (contradicts website-auditor "public clean").
  These are served as static docs (api reference / OpenAPI), i.e. customer-facing.
- fix: Replace 'honest'/'honesty' in the SOURCE that generates these (src/router.js route
  comments + scripts/build-api-ref.cjs + build-openapi.cjs), then regenerate. Use
  'accurate'/'correct'/'candid'/'transparent'. Add a build-time BANNED check so it cannot recur.
- effort: M

### E3 HIGH - "honest" pervasive in src/ comments/logs (582+ occurrences, ~181 files)
- file: src/ (broad)
- detail: Internal comments/log messages/variable names. Not directly customer-facing EXCEPT
  where they surface in error messages or generated docs (E1/E2). DECISION: not a standalone
  launch blocker, BUT must be swept to remove compliance risk of leakage into customer surfaces.
  Treat as fast-follow within the launch window; E1/E2 (the customer-visible subset) ARE blockers.
- fix: Scripted replace across src/: 'honesty'->'Constraints/Caveats', 'honest'->'accurate/correct/
  transparent', 'honestly'->'clearly/frankly'. Spot-check 20 files for meaning preservation.
  Add pre-commit/CI grep gate banning the term.
- effort: M

### E4 [LB] BLOCKER - Personal email rodneyyesep@gmail.com in operator-visible config doc
- file: .agent/docs/cloudflare-waf-setup-2026-05-16.md:37
- detail: "<local>@kolm.ai -> rodneyyesep@gmail.com". Hard constraint: dev@kolm.ai is the ONLY
  contact email; no personal email anywhere customer/operator-facing.
- fix: Replace with dev@kolm.ai. Sweep repo for any other rodneyyesep occurrence.
- effort: S

### E5 HIGH - Railway domain hardcoded in vercel.json (no dynamic fallback)
- file: vercel.json:1374,1378,1382 (rewrites) + :1673 (CSP)
- detail: kolmogorov-stack-production.up.railway.app hardcoded; URL change breaks /health,/ready,/v1
  silently with 502/504. No env substitution available in Vercel rewrite config.
- fix: Document as a manual operator deploy step in KOLM_DEPLOY_ARCHITECTURE.md ("update vercel.json
  rewrites with the Railway URL from `railway status` before deploy"). Add a pre-deploy reachability
  check. Live deploy currently healthy so not an active outage.
- effort: S

### E6 HIGH - Server accepts requests before production env validation
- file: server.js (boot), src/router.js:1101 (logs error but boots)
- detail: If RECIPE_RECEIPT_SECRET unset in prod, server still boots; receipt/fulfillment routes
  return transient-looking 503 instead of a hard config failure.
- fix: After ensureSigningKey, call runtimeReadiness(); if production_like && status=='not_ready'
  log each failed check and process.exit(1) so the platform health check fails immediately.
- effort: S

### E7 MED - Stripe webhook leaks parser/structure detail in error responses
- file: src/router.js:13094,13099,13101
- detail: Plain-text "Webhook Error: <reason>"/"invalid JSON"/"malformed event" to an
  unauthenticated POST. 4xx is correct; messages should be generic.
- fix: Return generic 'invalid request' / 'Webhook signature verification failed'; log detail server-side.
- effort: S

### E8 MED - Rate limiters key on IP only, not tenant/api-key (authenticated routes)
- file: src/router.js:546-577
- detail: Shared NAT/CDN egress can rate-limit legitimate multi-tenant traffic.
- fix: For authenticated limiters (export/verified) add keyGenerator using tenant_record.id || ip.
  Keep IP for unauth (builder/signup) but log on limit-hit.
- effort: S

### E9 LOW - docker-entrypoint.sh falls back to running as current user if su-exec missing
- file: docker-entrypoint.sh:29-32
- fix: Fail-fast if su-exec absent (exit 1) rather than exec "$@" as root. Mitigated by Dockerfile install.
- effort: S

### E10 LOW - Webhook async side-effects use .catch(()=>{}) (swallow without log)
- file: src/router.js:13370-13484
- fix: Replace bare .catch(()=>{}) with .catch(e=>wclog.warn(...)) for observability. Pattern is safe
  (post-response, best-effort) so not a blocker.
- effort: S

### E11 LOW - No explicit CORS middleware
- file: server.js / src/router.js
- detail: Acceptable for single-domain monolith; will break if frontend moves cross-origin.
- fix: None for launch; note for future.
- effort: S

### E12 LOW - Graceful shutdown relies on globalThis.__kolmServer set post-listen
- file: server.js:407-430
- fix: Assign server reference before listen(). Timeout fallback already covers the microsecond window.
- effort: S


## TRACK F - SECURITY (cross-cut; most items map into A/B/E above)

### F1 [LB] BLOCKER - Forbidden contact emails returned in API responses
- file: src/router.js:11332,11351,11451,11640,11791 (sales@), :12717 (hello@), :2139 (leaderboard@)
- detail: Confirmed 18 hits across src/ for sales@/hello@/leaderboard@. Customer-facing endpoints
  return non-compliant contact emails. Hard constraint: dev@kolm.ai ONLY.
- fix: Replace all with dev@kolm.ai. Extract to a single CONFIG.SUPPORT_EMAIL constant and add a
  CI grep gate banning any other @kolm.ai local-part in customer-facing strings.
- effort: S

### F2 MED - Pricing catalog not validated against a locked spec at runtime
- file: src/asr-billing.js
- fix: Add a versioned locked-pricing config that /ready validates against, 503 on mismatch (innovation).
- effort: M

### F3 LOW - Contact emails scattered, no central constant
- file: src/router.js
- fix: Centralize to CONFIG.SUPPORT_EMAIL (covered by F1).
- effort: S


## TRACK G - TESTS

### G1 [LB-coupled] - Add integration test proving the revenue gate (A1-A3)
- file: tests/ (new asr-revenue-gate.test.js)
- detail: Verify unpaid tenant cannot see findings/frameworks via scan/report/export; paid tenant can;
  Continuous subscriber can export. This is the regression lock for the A-track blockers.
- effort: M

### G2 MED - Add test pinning ASR_PRODUCTS amounts to locked pricing
- file: tests/asr-paid-loop.test.js
- detail: Assert report=75000, starter=29900, growth=99900, full=1500000, reviewed=2500000,
  redteam=1000000, plus=350000 (cents). Wrong prices currently pass CI.
- effort: S

### G3 MED - Add test that webhook fulfills asr_redteam and asr_reviewed (A5/A6)
- file: tests/asr-money-loop-http.test.js
- effort: S

### G4 LOW - Add CI grep gate for forbidden terms (honest/honesty, sales@/hello@/leaderboard@, rodneyyesep)
- file: scripts/release-verify.cjs
- effort: S


## TRACK H - EMAIL / NOTIFICATIONS

### H1 [LB] BLOCKER - Setup-token reveal feature unwired; welcome emails ship raw API keys
- file: src/email.js:125-145 (mint/verify/consume defined, never called); no /v1/setup/reveal route
- detail: Security feature (one-shot key reveal, 30-min TTL) documented and tested but not wired.
  Signup welcome email embeds the raw API key in plaintext.
- fix: Implement /v1/setup/reveal (consume token -> raw key once) and /v1/forgot-key (mint fresh token).
  Change tEmailSignup to link /setup?token=<tok> instead of embedding the raw key.
- effort: M

### H2 MED - Invoice receipt + package activation emails inline in router.js (untestable)
- file: src/router.js:13429-13434, 13480-13483
- fix: Extract tEmailInvoiceReceipt + tEmailPackageReady into src/email.js (pure {subject,html,text}); test.
- effort: S

### H3 MED - Refund email inline in router.js
- file: src/router.js:12918-12919
- fix: Extract tEmailRefund template; test.
- effort: S

### H4 LOW - tEmailReportReady not in email template test loop
- file: tests/wrapper-email.test.js:9-10,75-97
- fix: Add to loop; add coverage for invoice/refund/package templates.
- effort: S


## TRACK I - CODEBASE CLEANUP  (no launch blockers)

### I1 MED - Corrupted Windows-path files/dirs at repo root (8+)
- file: repo root (e.g. C:Usersuser...* artifacts, ~3MB)
- fix: Delete; add .gitignore patterns.
- effort: S

### I2 MED - Root .log + sim-*.json/err test artifacts (~3MB)
- file: repo root (debug.log, *.log, sim-100*.json/err, release-verify-*.json/err)
- fix: Delete; add .gitignore (*.log, sim-*.json, sim-*.err, release-verify-*.{json,err}).
- effort: S

### I3 LOW - Orphan debug outputs (all_hrefs.txt, sitemap_urls.txt)
- fix: Delete.
- effort: S

### I4 LOW - undefined/ directory (4 JSONL dumps, no imports)
- fix: Delete.
- effort: S

### I5 LOW - Empty runtime/cache dirs (.kolm-state, .local-runtime, .tmp*, tmp-*, .shots, etc.)
- fix: Delete; .gitignore. KEEP .kolm-bundle (signed product artifacts) - BUT see note: cleanup auditor
  flagged forbidden substrings in .kolm-bundle/artifacts/*.md; sweep or mark INTERNAL before any external share.
- effort: S

### I6 LOW - Orphan minified zip.min.js at root (corrupted path name, 97KB)
- fix: Delete after confirming adm-zip / src/zip-large.js cover the need.
- effort: S


## TRACK J - WEBSITE / COMMERCIAL

State: COMPLETE per website auditor (51 pages, pricing locked, CTAs wired, dev@kolm.ai only).
CAVEAT (lead-architect correction): the "public is clean of forbidden words" claim is WRONG -
public/docs/api-routes.json and public/openapi.json carry 'honest' (see E2). HTML marketing pages
are clean; the generated docs JSON are not. No other website action for launch.


------------------------------------------------------------------------
SEQUENCING (recommended)
1. Clear quick blockers: B1, E1, E4, F1, D1 (all S).
2. Build the revenue gate: A1+A4 then A2,A3 (+G1 test). This is the commercial core.
3. Build missing SKUs + fulfillment: A5, A6 (+G3). Confirm A7 = no-op + G2.
4. Console: B2, B3 (+B4,B6 wiring).
5. Email security: H1.
6. Docs sweep: E2 (regenerate), E3 fast-follow, E6.
7. Cleanup I-track + tests G4 + infra E5,E7,E8.
------------------------------------------------------------------------
