# ECONOMICS AUDIT - kolm.ai Agent Security Evidence

Date: 2026-06-11
Status: internal decision document. Numbers below separate OBSERVED (probed live on 2026-06-11) from INFERRED (read from code, never exercised with real money).
Contact: dev@kolm.ai (the only contact address on every surface).

---

## 1. Purchasability verdict

VERDICT: A stranger can give kolm money on https://kolm.ai today. The funnel is ON end-to-end up to Stripe. The one segment never observed with real money is webhook fulfillment after a completed payment.

OBSERVED live on 2026-06-11 (probe transcript, nothing inferred):

1. GET /health -> 200, signing_key loaded, 49 tenants (50 after the probe).
2. POST /v1/signup -> 201. Tenant tenant_75b2748f5c38 provisioned instantly with a ks_* API key and session cookie. No email verification gate. Rate limit 10 signups/IP/24h.
3. POST /v1/audit/scan (5-line synthetic JSONL) -> 200 in ~1-2s. Full signed, watermarked envelope returned inline: report asrr_mq9cefpv, readiness 0%, 9 findings, key fingerprint fa562154f99c95f48a45d04272943435 (matches prod issuer kolm-prod-2026).
4. POST /v1/audit/report/checkout -> 200 with a live buy.stripe.com Payment Link carrying client_reference_id and prefilled email. The link itself returns HTTP 200.
5. All five self-serve products returned live Payment Links: Signed Readiness Report $750, Continuous Starter $299/mo, Continuous Growth $999/mo, Full Readiness $15,000, Continuous-Plus $3,500/mo.
6. GET /v1/audit/reports billing block: ready:true, webhook_secret:true, secret_key:false, all five products via payment_link, missing: none.
7. The ONLY 503 in the funnel: POST /v1/audit/continuous/tick (cron_not_configured). It is a backup path; the in-process sweep (every 30 min, server.js:374-414) already covers re-attestation while the container is up.

INFERRED (code-complete, never exercised with real money - the gap the operator checklist closes):

- That the Stripe webhook endpoint is registered in the Stripe dashboard and reaches POST /v1/stripe/webhook with an intact raw body.
- That each Payment Link preserves client_reference_id (the ONLY binding back to the audit/tenant) and redirects after payment to /dashboard.
- That fulfillment (paid:true, watermark removed, Trust link minted) fires on a real checkout.session.completed event.
- Sales-led tiers have NO checkout path by design: Reviewed Attestation $25,000 flat and Deep Red-Team +$10,000 are mailto:dev@kolm.ai, invoiced by hand.

Probe residue left intentionally for the operator's live test: tenant_75b2748f5c38 (email dev@kolm.ai), audit audses_5f268bc200c22ac27c75, watermarked report asrr_mq9cefpv. Nothing was deleted; no payment was completed.

---

## 2. Revenue wiring map

All paths converge: createAsrCheckout (src/asr-billing.js:195) -> Stripe -> POST /v1/stripe/webhook (src/router.js:12693) -> fulfillment (src/asr-fulfillment.js). Webhook hardening is in place: signature verification against STRIPE_WEBHOOK_SECRET, per-event idempotency rows (stripe_events table inside withTransaction, router.js:12724-12726), and retryable throws on unconfirmed writes so Stripe redelivers.

| # | Product (locked price) | Checkout route | Env gate (names only) | Webhook branch | Fulfillment | State |
|---|---|---|---|---|---|---|
| 1 | Signed Readiness Report $750 one-time | POST /v1/audit/report/checkout (audit-routes.js:1327) | STRIPE_PAYMENT_LINK_ASR_REPORT | asr_report, ref asrrep_ (router.js:12759) | fulfillReportPurchase: paid:true, re-sign tier report (watermark off), RFC 3161 timestamp, public Trust slug | CODE-COMPLETE + ENV-LIVE |
| 2 | Continuous $299/mo (Starter) and $999/mo (Growth) | POST /v1/audit/continuous/checkout (1353) | STRIPE_PAYMENT_LINK_ASR_CONTINUOUS_STARTER / _GROWTH | asr_continuous (12773) | activateSubscription: stable slug, weekly cadence (+deploy-hook on Growth), reattested by 30-min in-process sweep | CODE-COMPLETE + ENV-LIVE |
| 3 | Full Readiness $15,000 one-time | POST /v1/audit/package/checkout {product:"full"} (1381) | STRIPE_PAYMENT_LINK_ASR_FULL_READINESS | asr_package (12738) | fulfillPackagePurchase: durable tenant entitlement, GRC/OSCAL deliverables | CODE-COMPLETE + ENV-LIVE |
| 4 | Continuous-Plus $3,500/mo | same package route {product:"plus"} | STRIPE_PAYMENT_LINK_ASR_CONTINUOUS_PLUS | asr_continuous via asrsub_plus_ ref | activateSubscription product_key plus | CODE-COMPLETE + ENV-LIVE |
| 5 | Reviewed Attestation $25,000 flat | none (mailto:dev@kolm.ai, pricing.html:377) | n/a | n/a | co-signer machinery exists (attestation-report-builder.js:713) | MONEY PATH MANUAL |
| 6 | Deep Red-Team +$10,000 | none (mailto) | n/a | n/a | consent-gated battery exists (src/active-redteam.js) | MONEY PATH MANUAL |

Subscription lifecycle: updated (router.js:12824), deleted (12879), payment_failed -> dunning (12926). Legacy gateway plans ($29-$499) ride a separate path and are not part of the ASR ladder.

---

## 3. Cost structure and break-even

Fixed monthly burn (estimates; confirm against invoices):

| Item | $/mo |
|---|---|
| Railway: one always-on Node container + 1GB volume | 5 - 20 |
| Vercel (static + 2 small functions) | 0 (Hobby) or 20 (Pro) |
| Domain kolm.ai (.ai, ~$70-90/yr) | 6 - 8 |
| Resend email (free tier at current volume) | 0 |
| Anthropic API (usage-based, only if key set) | ~0 |
| TOTAL | ~12 - 50, midpoint ~30 |

Marginal cost per audit: VERIFIED deterministic. The runAudit path imports only local analyzers; no LLM or network calls. The live 5-line scan round-tripped in ~1-2s; a worst-case 24 MiB session is tens of CPU-seconds, under $0.001 of compute.

Per-sale variable cost is Stripe (2.9% + $0.30):

| Sale | Stripe fee | Net | Gross margin |
|---|---|---|---|
| $750 report | $22.05 | $727.95 | ~97% |
| $299/mo | $8.97 | $290.03 | ~97% |
| $999/mo | $29.27 | $969.73 | ~97% |
| $3,500/mo | $101.80 | $3,398.20 | ~97% |
| $15,000 | $435.30 | $14,564.70 | ~97% |

Break-even math, at ~$30/mo burn:

- ONE $750 report covers ~24 months of burn (0.04 reports/month to break even).
- ONE Continuous Starter at $299/mo covers burn roughly 10x over, every month.
- Every locked price sits 3 to 4 orders of magnitude above marginal cost. Price floors are set by positioning, not cost. No pricing action is needed or permitted (pricing is locked).
- Continuous adds 4-5 reattestation runs/month at under $0.001 each: negligible.

---

## 4. Funnel state

Tenants: 49 before the probe. What a tenant can do today, all observed: instant signup -> free scan returning the FULL signed (watermarked) envelope inline -> /dashboard with Buy full report ($750) and Continuous buttons -> live Stripe Payment Link on every checkout. The funnel does NOT dead-end at a 503.

Soft dead-ends (ranked by expected revenue leak):

1. Post-payment redirect depends on each Payment Link's Stripe-side after-payment setting (unverified). If wrong, the buyer pays and lands nowhere obvious; fulfillment still occurs via webhook.
2. The vendor is asked for $750 sight-unseen: the dashboard never shows the watermarked preview render. (Fixed in this wave: preview link per unpaid row.)
3. A Continuous buyer with no prior scan sees a generating page while the first run is scheduled +1 week out. (Fixed in this wave: first run scheduled immediately; pending copy corrected.)
4. Email loop (welcome, report-ready, receipts, dunning) silently no-ops to an outbox file if RESEND_API_KEY / EMAIL_FROM are unset; presence unverifiable from outside.

Instrumentation present: checkout_started audit ops, stripe_events rows per webhook delivery, signup metric, Trust-link view analytics with hashed IPs. Instrumentation absent: no checkout_completed op on any paid path, so started-vs-paid conversion is not countable in-product. (Fixed in this wave: completion ops appended at fulfillment.)

Cheapest highest-value action: one live $750 test purchase, then refund (~15 minutes). It is the only never-observed segment of the money loop. After that the binding constraint is distribution, not plumbing: 49 tenants, zero observed payments, and the entire model rests on conversions that have never happened.

---

## 5. Die-risks, ranked

1. ZERO DISTRIBUTION / ZERO OBSERVED REVENUE. 49 tenants, no evidence any has paid; no conversion surface exists. Mitigation: treat plumbing as done; spend operator time on outbound to AI-agent vendors entering procurement; the free scan (full findings, instant) is the wedge. Conversion counting ships this wave (checkout_completed ops).
2. UNVERIFIED PAYMENT LOOP. Webhook registration, client_reference_id round-trip, and after-payment redirect have never carried real money; the webhook logs missing_tenant and continues if the ref is absent (money taken, nothing fulfilled). Mitigation: checklist items 1-3; point the webhook at the Railway URL directly so raw-body signature verification never depends on the Vercel proxy.
3. SINGLE VOLUME HOLDS ALL REVENUE STATE. One Railway container, one 1GB volume at /app/data: tenants, paid flags, slugs, subscriptions, idempotency ledger, signed reports. Loss = paid Trust links 404. Mitigation: scheduled off-box backup + one tested restore (checklist item 7).
4. SIGNING-KEY BUS FACTOR. One live Ed25519 signer (fingerprint fa562154f99c95f48a45d04272943435) signs every paid deliverable. Key loss breaks continuity; key leak forces mass revocation. Mitigation: offline encrypted backup of the private key (never in repo or chat), current + prior issuers in public/keys/kolm-issuers.json, 10-line rotation runbook against the existing revoke route.
5. FREE TIER SATISFIES INSTEAD OF SELLING. The free scan returns the complete analysis; the $750 adds watermark removal, the trusted timestamp, and the public Trust slug. Pricing is locked, so the fix is presentation: this wave makes the paid render visibly worth $750 (verdict band, reviewer toolbar, one-click verify) and renders those affordances locked on the preview.
6. EMAIL LOOP MAY BE DARK. Every transactional send is fire-and-forget and silently skipped if RESEND_API_KEY / EMAIL_FROM are unset. Mitigation: checklist item 5 (5 minutes).
7. CONTINUOUS FIRST-CYCLE GAP. next_run_at was +1 week at activation while the page promised "shortly"; a $999/mo buyer staring at a spinner is a refund risk. Mitigation: code fix ships this wave (immediate first run + corrected copy); onboarding note to seed with one scan remains in the checklist.
8. KEY-PERSON CONCENTRATION. Stripe, Railway, Vercel, registrar, signing key, and the $25,000 manual tier are one person. Mitigation: 1-page ops runbook stored with the key backup; the system otherwise self-drives (idempotent webhook, in-process sweep).

---

## 6. Operator checklist (env NAMES only; never echo values; never run railway variables)

1. STRIPE WEBHOOK (10 min): confirm a Stripe dashboard webhook endpoint points at the Railway URL /v1/stripe/webhook (prefer the direct Railway URL over the kolm.ai proxy). Events: checkout.session.completed, customer.subscription.updated, customer.subscription.deleted, invoice.payment_succeeded, invoice.paid, invoice.payment_failed. Its signing secret must match the Railway variable STRIPE_WEBHOOK_SECRET (set; if unsure, roll in Stripe and paste the new value in the Railway dashboard).
2. PAYMENT LINKS (5 min): for each of the five live links confirm the after-payment redirect is https://kolm.ai/dashboard?asr=<product> and that client_reference_id is preserved (without it the webhook cannot fulfill).
3. LIVE TEST PURCHASE (10 min): using tenant_75b2748f5c38 / audit audses_5f268bc200c22ac27c75, buy the $750 report from /dashboard with your own card. Verify paid:true + trust_url appear and the UNPAID PREVIEW watermark is gone on the Trust link. Refund in the Stripe dashboard (API refunds need STRIPE_SECRET_KEY, currently unset).
4. CRON BACKUP (5 min): set KOLM_CRON_SECRET in the Railway dashboard, then point an external pinger (cron-job.org / GitHub Actions / UptimeRobot) at POST /v1/audit/continuous/tick every 30-60 min with header x-kolm-cron-secret. This is the restart-window backup to the in-process sweep.
5. EMAIL (5 min): confirm RESEND_API_KEY and EMAIL_FROM are present in Railway (names in the dashboard only). Trigger one scratch signup and confirm the welcome email arrives.
6. OPTIONAL HARDENING (later): set STRIPE_SECRET_KEY (Billing Portal, API refunds, Checkout-API path); optionally set KOLM_STRIPE_PRICE_ASR_REPORT, KOLM_STRIPE_PRICE_ASR_CONTINUOUS_STARTER, KOLM_STRIPE_PRICE_ASR_CONTINUOUS_GROWTH, KOLM_STRIPE_PRICE_ASR_FULL_READINESS, KOLM_STRIPE_PRICE_ASR_CONTINUOUS_PLUS to migrate off Payment Links with zero code changes.
7. BACKUP (15 min, separate sitting): schedule an off-box copy of the Railway volume /app/data and test one restore. It holds every tenant, paid flag, slug, subscription, and the stripe_events idempotency ledger.
8. CLEANUP: after the test purchase + refund, keep tenant_75b2748f5c38 as the standing smoke-test account or delete it. Nothing else was created; nothing was deleted.

---

## 7. Decision summary

- Revenue is ON. Five self-serve products return live Payment Links; margins ~97% after Stripe; burn ~$30/mo; break-even is 0.04 reports/month.
- The single unobserved link is webhook fulfillment with real money: 15 operator minutes close it (checklist 1-3).
- Engineering effort this wave goes where the survey found buyer-pull: make the paid artifact sell itself (verdict-first render, reviewer toolbar, drift rendered, one-click verify, dashboard preview). No pricing changes: pricing is locked.
- After the test purchase, every remaining risk is distribution. The plumbing is no longer the constraint.
