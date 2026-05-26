# Stripe Payment Integration Audit  -  2026-05-26

Auditor: wave3-stripe-audit
Working tree: C:\Users\user\Desktop\kolmogorov-stack
Method: static read of code + config + HTML. No Stripe API calls. No real keys exercised.

## Files referencing Stripe

Source / runtime:
- src/stripe.js:1-76  -  HMAC-SHA256 webhook signature verifier (no SDK dependency), `planFromAmount(cents)` map, `appendCheckoutParams()` to glue `client_reference_id` + `prefilled_email` onto Payment Link URLs.
- src/billing-upgrade.js:1-159  -  4-step fallback chain (Payment Link -> Checkout Session via fetch -> KOLM_BILLING_URL -> log to `~/.kolm/upgrade-requests.jsonl`). `createStripeCheckoutSession()` is a plain `fetch` POST to `https://api.stripe.com/v1/checkout/sessions`.
- src/router.js:30 imports the helpers; defines `PLAN_CATALOG` (router.js:2132-2137) + `billingLinkFor()` (2164-2172) + `/v1/plans`, `/v1/billing/tiers`, `/v1/account/change-plan` (10286-10353), `/v1/stripe/webhook` (10488-10617). Handles `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`.
- src/auth.js:106-132  -  `provisionTenant()` does NOT mint a Stripe customer; `stripe_customer_id` / `stripe_subscription_id` are written ONLY by the webhook handler.
- server.js:31, 47, 52, 71-75, 449-471  -  CSP allow-list for `https://api.stripe.com` + `https://js.stripe.com`, `express.raw()` ahead of `express.json()` ONLY for `/v1/stripe/webhook` (raw body needed for HMAC), boot-time integration roll-call counting `STRIPE_PAYMENT_LINK_*` envs.
- scripts/stripe-provision.mjs:1-137  -  Operator one-shot. Idempotent on metadata `kolm_tier`. Creates 5 Products/Prices/Payment Links + 1 webhook endpoint. Tier cents: 900 / 4900 / 14900 / 149900 / 299900 (Starter / Pro / Teams / Business / Enterprise).
- tests/stripe.test.js, tests/wave363-billing-upgrade.test.js  -  Unit coverage for signature verify, amount->plan map, 4-path fallback resolver.
- cli/kolm.js  -  Stripe-related CLI surface (billing tiers / change-plan helpers).

Front-end:
- public/signup.html:169, 223-224, 243-244, 436-449  -  Renders `billing_url` from `/v1/signup` response and `window.location.assign()`s the user to Stripe.
- public/account.html:316, 443-468, 599-624  -  Self-serve upgrade / cancel flow. Posts to `/v1/account/change-plan`, follows `billing_url`.
- public/upgrade.html:248-261  -  Marketing page; text references "Team uses Stripe checkout".
- public/pricing.html  -  Tier cards link to `/signup?plan=pro|team|business`; "Enterprise" routes to `/enterprise/inquiry` (sales-led).
- public/index.html:1005-1067  -  Homepage tier strip with Free / Indie $29 / Team $99 / Business $499 / Enterprise $1,499  -  see CRITICAL #1 below.

## Env vars (declared)

In `.env` (lines 45-62) and `.env.example`, all currently empty:
- STRIPE_PAYMENT_LINK_STARTER, _PRO, _TEAMS, _BUSINESS, _ENT  -  per-tier Payment Link URLs.
- STRIPE_WEBHOOK_SECRET  -  signing secret for `/v1/stripe/webhook`.
- STRIPE_SECRET_KEY  -  used for direct subscription cancel on `/v1/account/delete` (router.js:10625, 10818) and as a fallback by `billing-upgrade.js` (line 112).

Also read at runtime (no `.env` entry shipped, must be added by operator):
- KOLM_STRIPE_KEY (alias for STRIPE_SECRET_KEY  -  billing-upgrade.js:112)
- KOLM_STRIPE_PRICE_PRO, _TEAM, _ENT, plus legacy aliases _STARTER, _TEAMS, _BUSINESS (billing-upgrade.js:26-36)  -  Price IDs for on-the-fly Checkout Sessions.
- KOLM_STRIPE_BASE_URL (override; defaults to https://api.stripe.com)
- KOLM_BILLING_URL (path 3 fallback)
- PUBLIC_BASE (success / cancel URL host)

## Wiring per tier

Catalog of record  -  src/router.js:2132-2137 `PLAN_CATALOG`:
- free  -  $0  -  no billing
- pro  -  $49  -  env `STRIPE_PAYMENT_LINK_PRO` (price env `KOLM_STRIPE_PRICE_PRO` / legacy `_STARTER`)
- teams  -  $499  -  env `STRIPE_PAYMENT_LINK_TEAM` (legacy `_TEAMS`; price env `KOLM_STRIPE_PRICE_TEAM`)
- enterprise  -  Custom, `self_serve:false`  -  env `STRIPE_PAYMENT_LINK_ENT`; absent => sales-led path

Amount -> plan map  -  src/stripe.js:51-58:
- 900 -> pro, 4900 -> pro, 14900 -> teams, 49900 -> teams, 149900 -> enterprise, 299900 -> enterprise.

Per-tier verdict (assuming env vars are populated in prod):
- Indie ($29)  -  NOT in `PLAN_CATALOG`. NO alias maps "indie" -> any tier. `/v1/signup?plan=indie` (homepage CTA) returns 400 `invalid plan` from `change-plan` path; for `/v1/signup`, `canonicalPlanId('indie')` returns `null`, falls through `requestedPlan = canonicalPlanId(rawPlan) || 'free'`  -  user gets a FREE tier silently with NO billing redirect. No Price ID, no webhook mapping, no checkout URL. BLOCKED.
- Team ($99 on homepage / $499 in catalog)  -  Homepage CTA `/signup?plan=team` canonicalizes to `teams`  -  matches catalog, payment link env present in `.env` but EMPTY; if operator populates `STRIPE_PAYMENT_LINK_TEAM`, signup returns a billing_url and webhook flips plan on `checkout.session.completed`. Price mismatch (homepage says $99/mo; webhook will only match 14900 or 49900). If operator wires a $99 link, `planFromAmount(9900)` returns `null` and the webhook falls back to `tenant.pending_plan`  -  works, but fragile.
- Business ($499 on homepage / $1,499 on pricing.html)  -  `canonicalPlanId('business')` ALIASES to `enterprise` (router.js:2143). Homepage "Start Business" therefore routes the user into the Enterprise path: `self_serve:false`, no billing link by default, response says "sales_required: true" -> sends them to `/enterprise/inquiry`. There is NO self-serve Business tier in code. `STRIPE_PAYMENT_LINK_BUSINESS` env exists in `.env` but is unused by `billingLinkFor()`  -  the catalog's enterprise row only reads `STRIPE_PAYMENT_LINK_ENT`. BLOCKED.
- Enterprise ($1,499 homepage / Custom pricing.html)  -  `self_serve:false`. Pricing page CTA routes to `/enterprise/inquiry` (correct  -  sales-led). Homepage CTA goes through `/signup?plan=enterprise` and surfaces `sales_required:true` to the user.

`stripe.ready` flag (router.js:2195-2201) returns `paidConfigured === paidTotal && webhook_secret_set`. With empty `.env`, this is `false` today.

## Signup -> first call flow

1. Browser hits `/signup?plan=<x>`; client posts to `POST /v1/signup` (router.js:2250) with `{email, plan}`.
2. Plan canonicalized via `PLAN_ALIASES`. Unknown ids (e.g. `indie`) drop to `free`.
3. Tenant provisioned on FREE quota immediately; `api_key` minted; `kolm_session` cookie set. NO Stripe customer is created here.
4. If `requestedPlan` is paid, server calls `billingLinkFor(plan)`  -  reads `STRIPE_PAYMENT_LINK_*` env. Returns `billing_url` in JSON response.
5. Client `window.location.assign(billing_url)` -> Stripe Hosted Checkout (or 404 if env is empty -> currently the case).
6. User pays -> Stripe POSTs `checkout.session.completed` to `/v1/stripe/webhook` -> HMAC verified -> `update('tenants', ..., { plan, quota, seats, stripe_customer_id, stripe_subscription_id, paid_at, billing_status:'active' })`.
7. Next gateway call (e.g. `POST /v1/chat`)  -  auth middleware reloads `req.tenant_record` from db (auth.js:557), W-2 gate computes `tierForPlan(t.plan)` per request (router.js:5524-5526). Updated plan takes effect immediately on the NEXT request post-webhook. CORRECT.

Verdict: BROKEN at step 4 in dev (env vars empty). In production it depends on whether the operator ran `scripts/stripe-provision.mjs` and set the 5 + 1 envs. Catalog mismatch breaks Indie and Business regardless of env config.

## CRITICAL findings

1. Tier catalog mismatch: homepage advertises Free / Indie $29 / Team $99 / Business $499 / Enterprise $1,499 (public/index.html:1005-1067). Server `PLAN_CATALOG` holds Free / Pro $49 / Teams $499 / Enterprise Custom (router.js:2132-2137). `pricing.html` shows a third schema with Business $1,499. "indie" is unknown; "business" silently aliases to Enterprise (sales path); "team" canonicalizes to the catalog's $499 row, contradicting the $99 homepage price.

2. `.env` ships with all Stripe envs empty. With nothing set, `billingLinkFor()` returns `null`; `/v1/account/change-plan` returns HTTP 503 `billing_not_configured`; `/v1/signup` for a paid plan still mints a free tenant but `billing_url:null`. Self-serve subscription is impossible in the as-shipped state. Operator MUST run `scripts/stripe-provision.mjs` AND populate `STRIPE_PAYMENT_LINK_PRO|TEAM|ENT` + `STRIPE_WEBHOOK_SECRET` before launch.

3. `AMOUNT_TO_PLAN` in src/stripe.js:51-58 only knows cents = 900 / 4900 / 14900 / 49900 / 149900 / 299900. There is no entry for 2900 (Indie $29), 9900 (Team $99 homepage), 149900 (Business $1,499). If the operator misconfigures a Payment Link to one of those amounts, webhooks fall back to `tenant.pending_plan` which is fragile; if `pending_plan` is unset (e.g. a fresh anonymous Payment Link with no `client_reference_id`), the webhook logs `no plan match` and the user is charged with NO plan upgrade applied. Silent payment failure.

4. No Stripe Customer is created at signup. Tenants only acquire `stripe_customer_id` on first successful `checkout.session.completed`. Cancellation via Stripe before any successful checkout (e.g. user disputes the $0 free tier) has no Stripe-side state to reconcile  -  acceptable but worth noting.

5. `STRIPE_PAYMENT_LINK_BUSINESS` is declared in `.env` but `PLAN_CATALOG` never reads it (only `_PRO`, `_TEAM`, `_ENT` are wired in `stripe_link_env`). Dead env var advertising a tier that does not exist server-side.

## Recommendations

- Decide ONE pricing model and propagate it to all three sources of truth: `PLAN_CATALOG` (router.js:2132-2137), `AMOUNT_TO_PLAN` (stripe.js:51-58), and homepage / pricing.html tier strips. If the launch plan is Indie / Team / Business / Enterprise at $29 / $99 / $499 / $1,499, the catalog needs 4 rows (not 3) plus matching cents (2900 / 9900 / 49900 / 149900).
- Add an `indie` row to `PLAN_CATALOG` (or alias `indie -> pro`) so the homepage CTA stops silently dropping the user to free.
- Add a `business` row distinct from `enterprise` (currently `business -> enterprise` alias forces Business buyers into sales-led flow). Wire `STRIPE_PAYMENT_LINK_BUSINESS` to that row.
- Pre-launch checklist: (a) run `scripts/stripe-provision.mjs` against the live Stripe account, capture the JSON it emits, (b) paste Payment Link URLs into the 5 `STRIPE_PAYMENT_LINK_*` envs in the Vercel / Railway env, (c) paste the `webhook.secret` into `STRIPE_WEBHOOK_SECRET`, (d) hit `/v1/billing/tiers` and assert `stripe.ready === true`.
- Add an integration test that POSTs `/v1/signup?plan=<each tier>` and asserts a non-null `billing_url` (gated behind `STRIPE_PAYMENT_LINK_*` env presence). Today only the unit test for the resolver exists.
- Audit the `9900` / `2900` / `149900` cents amounts and add them to `AMOUNT_TO_PLAN` before any Payment Link at those prices ships.

## Caveats

- Audit is static; no Stripe API was called, no live webhook was simulated end-to-end.
- Production env state was not inspected (only `.env` checked into the working tree).
- The `scripts/stripe-provision.mjs` tier cents (900 / 4900 / 14900 / 149900 / 299900) match `AMOUNT_TO_PLAN`, so operator-run provisioning is internally consistent  -  the inconsistency is between that lineup and the public marketing pages.
