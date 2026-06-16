# kolm.ai Commercial Launch Decision Memo

Date: 2026-06-15
Author: Lead architect (audit consolidation)
Scope: commercial backend (audit product money-loop, auth/console, signing, storage,
deploy, security, email, website). Contact: dev@kolm.ai only.

------------------------------------------------------------------------
## GO / NO-GO SUMMARY

VERDICT: NO-GO until the 12 launch blockers are cleared. Recommended cutover after a
single focused build wave (estimated ~2.5-3.5 engineer-days of disjoint work).

Why NO-GO despite a healthy live deployment:
- The platform is LIVE and the infrastructure layer is sound (health 200, signing key from
  env with matching fingerprint, durable volume mounted, 560 money-path tests green).
- BUT the revenue model is not enforced: the free scan endpoint hands out the complete
  $750 paid report (findings, frameworks, evidence tier, exports) to any authenticated
  tenant. Launching in this state means paid product data is free. This alone is a NO-GO.
- Two advertised premium SKUs ($10k Deep Red-Team, $25k Reviewed Attestation) have no
  catalog entry and no webhook fulfillment, so those purchases would silently fail to
  activate after the customer is charged.
- Hard product/compliance constraints are violated in customer-facing surfaces: forbidden
  word in public docs and the /v1/changelog API, forbidden contact emails in API
  responses, a personal email in an operator-facing config doc.
- A timing-attack on the admin key and signup emails shipping raw API keys are real
  security defects.

None of the blockers are architectural. They are gates, missing SKUs, wiring, and
content compliance. The signing/attestation moat and the website marketing surface are
launch-ready as-is.

Blocker count: 12 (see launch-blockers.json). Note G1 (the revenue-gate test) is listed
as a 13th item in the JSON because it is the regression lock that must ship WITH A1-A3;
the distinct customer-impacting defects number 12.

------------------------------------------------------------------------
## DECISION TABLE (research + audit findings -> decisions)

Finding | Confidence | Implication | Decision | Owner-track
------- | ---------- | ----------- | -------- | -----------
Free scan returns full paid envelope ungated (audit-routes.js:1163, re-verified live source) | HIGH | Entire $750 product + GRC exports given away free; paid loop is dead code | BUILD revenue gate (summary stub for unpaid; full only for paid/Continuous) | billing-revenue-loop
$10k Deep Red-Team and $25k Reviewed Attestation absent from ASR_PRODUCTS + webhook | HIGH | Charged purchases silently fail to activate; material revenue loss and support incidents | BUILD both SKUs + webhook fulfillment branches | billing-revenue-loop
3 auditors report "Full Readiness $15k must be $25k" | MED | Looks like a pricing bug | DO NOT bump line 58. Website ships BOTH $15k Full Readiness AND $25k Reviewed Attestation as distinct SKUs; the misread is from auditors lacking the separate $25k SKU. Keep $15k, ADD the $25k SKU (A6). Pin with a pricing test | billing-revenue-loop / tests
Continuous-Plus $3,500/mo in code, not on audited pricing pages | MED | Reads as undocumented/unauthorized | KEEP the functional SKU; add it to the locked pricing doc as enterprise upsell OR gate behind contact. No code removal needed for launch | billing-revenue-loop
"honest"/"honesty" 582+ in src/, plus public docs + /v1/changelog | HIGH (re-verified: public docs + changelog ARE customer-facing) | Hard-constraint violation in customer surfaces; website-auditor "public clean" claim is incorrect | BLOCK on the customer-visible subset (changelog API E1, public docs E2). Sweep src/ comments as fast-follow (E3) with a CI ban gate | env-deploy-infra / website / tests
Contact emails sales@/hello@/leaderboard@ in API responses; rodneyyesep@gmail.com in config doc | HIGH (18 hits confirmed) | Hard-constraint violation; brand/compliance failure visible to customers and operators | REPLACE all with dev@kolm.ai; centralize to one constant + CI grep gate | security
Admin key compared with === (auth.js:734, re-verified) | HIGH | Timing side-channel can leak admin key | FIX to constantTimeEqual (one-line) | auth-console
Signup welcome email embeds raw API key; setup-token reveal defined but unwired | HIGH | Long-lived secret in plaintext email/inbox | WIRE /v1/setup/reveal + /forgot-key; link instead of embedding key | email-notifications
Console missing GET /v1/audit/sessions; automations on in-memory Map in prod | HIGH | Customers cannot see purchased audits; automations lost on every restart | BUILD list endpoint; wire eventStore/runRecipe/cronSecret deps | auth-console
storeEphemeral()/backendInfo() not in /health | HIGH (but live deploy is durable) | Operator cannot detect future silent data loss on ephemeral storage | SURFACE in /health (fail-loudly safety net). Not an active outage today | storage-persistence
Railway domain hardcoded in vercel.json | MED | URL change breaks proxy silently (502/504) | DOCUMENT as manual deploy step + pre-deploy reachability check. Not an active outage | env-deploy-infra
Server boots before prod env validation | MED | Misconfigured prod returns transient-looking 503s instead of failing fast | ADD runtimeReadiness() fail-fast (exit 1) at boot in production | env-deploy-infra
Attestation/signing subsystem | HIGH | None - complete, SOTA, offline-verifiable, live fingerprint matches | SHIP as-is; coordinate A4 tier-redaction so reduced scan payload stays canonical | signing-attestation
Website marketing pages (51 HTML) | HIGH | Coherent, pricing locked, CTAs wired, dev@kolm.ai only | SHIP as-is (one correction: generated docs JSON need the honest-word sweep, E2) | website-commercial
560 money-path tests green; release-verify 13-check gate | HIGH | Strong infra coverage but no test pins pricing amounts or the revenue gate | ADD pricing-amount test (G2) + revenue-gate integration test (G1) + forbidden-term grep gate (G4) | tests
Repo cruft (~6MB: corrupted-path files, logs, sim artifacts, undefined/) | HIGH | Cosmetic; zero functional impact | CLEAN + .gitignore post-blocker; not launch-gating | codebase-cleanup

------------------------------------------------------------------------
## PERSISTENCE / VOLUME VERDICT  (from liveness probe)

VERDICT: DURABLE AND CORRECT. Persistence is NOT a launch blocker on the live deployment.

Evidence from the live probe:
- GET https://kolm.ai/health -> 200; ok=true, status=ok, signing_key=loaded.
- storage.data_dir = /app/data; data_dir_writable=true; events_dir_writable=true; uid=1000.
- Railway volume kolmogorov-stack-volume attached to service kolmogorov-stack, mount path
  /app/data (EXACT match to live data_dir), 1086MB/50000MB used.
- Signing source = env (not ephemeral/generated); fingerprint fa562154f99c95f48a45d04272943435
  matches expected; alg ed25519.
- No blockers reported by the liveness check; secrets were not printed (public key + fingerprint
  are public by design; `railway variables` was not run).

Caveat (why D1 is still a blocker despite this): the durable state is correct TODAY, but the
/health endpoint does NOT surface storeEphemeral()/backendInfo(). If a future deploy lands on
ephemeral /tmp (e.g. volume detach, region/config change), paid billing + audit state would be
silently lost with no operator signal. Surfacing the diagnostic is a one-import fail-loudly fix
and is required to honor the fail-loudly contract for a paid product. It does not indicate any
current data-loss condition.

------------------------------------------------------------------------
## CONFIDENCE NOTES / AUDITOR DISAGREEMENTS RESOLVED

1. "honest" word as blocker: cleanup-auditor said NOT a blocker (claimed public/ clean);
   website-auditor said public clean. Lead architect re-checked and found 14 hits each in
   public/docs/api-routes.json and public/openapi.json, plus the public /v1/changelog API.
   RESOLUTION: the customer-facing subset (E1, E2) IS a blocker; broad src/ sweep (E3) is
   fast-follow with a CI gate.
2. "Full Readiness $15k vs $25k": 3 auditors flagged as a pricing bug. Reconciled against the
   website which advertises both SKUs. RESOLUTION: keep $15k, add the missing $25k Reviewed
   Attestation SKU. Do not change line 58.
3. Billing "broken" vs everything-else "partial": the billing auditor is correct that the
   revenue gate is the single most important defect; it is the commercial core of this wave.

------------------------------------------------------------------------
## RECOMMENDED LAUNCH GATE

Ship to customers only after ALL of:
- A1, A2, A3, A4 + G1 (revenue gate enforced and tested)
- A5, A6 + G3 (premium SKUs purchasable and fulfilled) + G2 (pricing pinned)
- B1 (admin key), B2, B3 (console list + automations durability)
- D1 (health ephemeral diagnostic)
- E1, E2, E4, F1 (compliance: words + emails), E6 (fail-fast boot)
- H1 (no raw key in email)

Fast-follow within the launch window (not gating but high priority): E3 broad word sweep,
E5/E7/E8 infra hardening, B4/B5, H2-H4, A8/A9/A12/A13, I-track cleanup, G4 CI gate.
