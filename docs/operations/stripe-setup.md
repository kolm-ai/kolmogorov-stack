# Stripe setup

Wave4 stripe-fix runbook. Five env vars and one optional provisioning script
get every paid tier (Indie / Pro / Team / Business) to a working self-serve
checkout, plus Enterprise (sales-led).

## Required environment variables

Set these on the production host (Vercel, Railway, Fly, your own box) before
the first paid signup goes through. Missing any single env => the matching
tier's `billing_link_configured` flag on `/v1/billing/tiers` flips to `false`
and the UI demotes that tier to "contact sales" without dropping the user.

| env var                         | purpose                                                      | required for                |
| ------------------------------- | ------------------------------------------------------------ | --------------------------- |
| `STRIPE_SECRET_KEY`             | `sk_live_...` — server-side Stripe API key                   | webhook + Checkout API path |
| `STRIPE_WEBHOOK_SECRET`         | `whsec_...` — signing secret for `/v1/stripe/webhook`         | webhook signature verify    |
| `STRIPE_PAYMENT_LINK_INDIE`     | Payment Link URL for the $29 Indie plan                       | `/v1/signup?plan=indie`      |
| `STRIPE_PAYMENT_LINK_PRO`       | Payment Link URL for the $49 Pro plan                         | `/v1/signup?plan=pro`        |
| `STRIPE_PAYMENT_LINK_TEAM`      | Payment Link URL for the $99 Team plan                        | `/v1/signup?plan=team`       |
| `STRIPE_PAYMENT_LINK_BUSINESS`  | Payment Link URL for the $499 Business plan                   | `/v1/signup?plan=business`   |

Optional:

| env var                          | purpose                                                     |
| -------------------------------- | ----------------------------------------------------------- |
| `STRIPE_PAYMENT_LINK_ENT`        | Payment Link URL for the $1,499 Enterprise plan (sales-led; usually distributed by hand after architecture review) |
| `STRIPE_PAYMENT_LINK_TEAMS`      | Legacy plural-spelled alias of `_TEAM`. Read as a fallback. |
| `KOLM_STRIPE_PRICE_INDIE`        | Stripe Price id (`price_...`) for on-the-fly Checkout Session creation when no Payment Link is set |
| `KOLM_STRIPE_PRICE_PRO`          | Same, for Pro                                               |
| `KOLM_STRIPE_PRICE_TEAM`         | Same, for Team                                              |
| `KOLM_STRIPE_PRICE_BUSINESS`     | Same, for Business                                          |
| `KOLM_STRIPE_PRICE_ENT`          | Same, for Enterprise                                        |
| `PUBLIC_BASE`                    | Defaults to `https://kolm.ai`. Used in success/cancel URLs. |

## Plan → cents → Payment Link mapping

`src/stripe.js` maps `amount_total` (cents) on a completed Checkout Session
back to a canonical plan id. Each Payment Link MUST charge the canonical
price exactly, otherwise the webhook will record the event and refuse to
flip the plan.

| plan        | cents (monthly) | Stripe env var                  |
| ----------- | --------------- | ------------------------------- |
| indie       |     2900        | `STRIPE_PAYMENT_LINK_INDIE`     |
| pro         |     4900        | `STRIPE_PAYMENT_LINK_PRO`       |
| teams       |     9900        | `STRIPE_PAYMENT_LINK_TEAM`      |
| business    |    49900        | `STRIPE_PAYMENT_LINK_BUSINESS`  |
| enterprise  |   149900        | `STRIPE_PAYMENT_LINK_ENT`       |

Legacy amounts (`900` starter, `14900` old-team, `299900` old-enterprise)
remain mapped so pre-wave4 Payment Links and historical webhook events
continue to resolve. The new $499 Business price (`49900`) supersedes the
pre-wave4 Team-at-$499 price; if you previously provisioned a `STRIPE_PAYMENT_LINK_TEAMS`
at $499 it now flips into `business` not `teams`.

## Provisioning the links automatically

`scripts/stripe-provision.mjs` (run once per Stripe account) creates fresh
Products, Prices, Payment Links, and a webhook endpoint under the calling
Stripe account. It is idempotent on the `metadata.kolm_tier` field — re-running
reuses the existing Product/Price/Link.

```sh
STRIPE_SECRET_KEY=sk_live_... \
KOLM_DOMAIN=https://kolm.ai \
  node scripts/stripe-provision.mjs > provision.json
```

The emitted `provision.json` contains the `payment_link_url` for each tier;
paste those into your host's environment as the `STRIPE_PAYMENT_LINK_*`
values above. The script also creates the `/v1/stripe/webhook` endpoint and
prints the webhook signing secret once (set it as `STRIPE_WEBHOOK_SECRET`).

Caveats / limitations:

- The script's current `TIERS` array still tracks the pre-wave4 prices
  (starter $9, pro $49, teams $149, business $1,499, enterprise $2,999).
  Edit that array to match the wave4 canonical prices before running, or
  create the Payment Links manually in the Stripe dashboard at the cents
  values in the mapping table above.
- Payment Links are not searchable via the Stripe API; the script lists
  the first 100 active links and filters by `metadata.kolm_tier`. If you
  have more than 100 active Payment Links you'll need to add pagination
  or delete unused ones.

## Verifying the wiring

```sh
curl https://kolm.ai/v1/billing/tiers | jq '.stripe'
# Expect: paid_links_configured == paid_links_total, webhook_secret_set true
```

If `paid_links_configured < paid_links_total`, the UI demotes the tiers with
missing envs to a "contact sales" CTA and `/v1/signup?plan=<tier>` returns
`503 billing_not_configured` for that tier specifically — the user stays on
free instead of getting a broken checkout link.

## Self-host / BYO Stripe account

The `STRIPE_PAYMENT_LINK_*` envs are read at request time, so flipping any
of them takes effect on the next request (no restart needed for Payment Link
swaps). `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are also read fresh
per request and can be rotated without a deploy.
