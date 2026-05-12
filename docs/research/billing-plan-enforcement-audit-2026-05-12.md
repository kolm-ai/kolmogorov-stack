# Billing And Plan Enforcement Audit

Date: 2026-05-12

Scope: local review of plan catalog, signup, plan changes, Stripe webhook processing, quota middleware, billable routes, account cancel/delete semantics, public docs, account UI, and Stripe tests.

## Executive Findings

1. P0/P1: Stripe webhook can activate a pending paid tier even when `amount_total` does not match a known plan. A local signed webhook smoke upgraded a tenant with `pending_plan: enterprise` on `amount_total: 1234`.
2. P1: `/v1/compile` is not charged. A local `/v1/compile?sync=1` smoke completed an artifact with tenant `usedAfter: 0`, even though pricing research says compile/artifact governance is Kolm's strongest paid unit.
3. P1: plan enforcement is mostly quota-only. Seats, private artifact counts, SSO, SCIM, project scopes, audit logs, BAA, support levels, and enterprise controls are present in public pricing copy but not enforced as entitlements in the reviewed code.
4. P1: billing/account docs drift from code. Cancel copy says period-end downgrade, code downgrades immediately; delete UI says artifacts/tenants are permanently removed, code soft-deletes only the tenant.
5. P1/P2: quota accounting is simple and non-atomic. Usage is checked before work and incremented after work using the request's stale tenant object.

## What Is Working

`PLAN_CATALOG` gives the API one code-level catalog for plan ids, prices, quotas, seats, and Stripe Payment Link env names. `/v1/plans` exposes that catalog.

Stripe signature verification is implemented without the Stripe SDK and is unit-tested. `node --test tests/stripe.test.js` passed 10/10 when run outside the sandbox after the sandbox blocked the Node test-runner spawn with EPERM.

Paid signup does not immediately grant paid quota. It provisions free quota and records `pending_plan`; the webhook is supposed to flip the tenant only after checkout completion.

## Critical Webhook Gap

The checkout handler resolves a plan as:

```text
planFromAmount(s.amount_total) || tenant.pending_plan || null
```

That fallback is unsafe. Local smoke:

```json
{
  "status": 200,
  "webhook": {
    "received": true,
    "plan": "enterprise"
  },
  "amount_total": 1234,
  "planAfter": "enterprise",
  "quotaAfter": 10000000,
  "pendingAfter": null
}
```

The webhook signature proves Stripe sent the event. It does not prove the amount paid matches the pending plan. If any Checkout Session in the same Stripe account can carry the tenant id and a mismatched amount, the current fallback can activate a higher tier than was paid for.

Required fix: require a Stripe-side binding to the target plan. Accept activation only when one of these matches:

- expected `amount_total` for the pending plan,
- expected Stripe Price id,
- trusted Checkout Session metadata `plan`,
- trusted Payment Link id mapped to plan.

Do not use `tenant.pending_plan` as a standalone fallback.

## Compile Is Not Billed

The code charges usage for:

- synthesize
- synthesize stream
- synthesize batch
- publish
- run
- compose
- label-corpus
- label-corpus stream
- specialist run

It does not charge:

- compile
- verify
- recall
- embed
- capture proxy
- specialist training
- public run

Local compile smoke:

```json
{
  "status": 202,
  "compileStatus": "completed",
  "usedAfter": 0,
  "jobIdPresent": true
}
```

This conflicts with the pricing work: Kolm should monetize compile jobs, accepted artifacts, registry governance, receipt retention, and org controls. The current usage model mostly charges runtime/synthesis units and misses the artifact product's core paid moment.

## Quota Accounting Limits

`authMiddleware` blocks when `t.used >= t.quota` and returns 429. Public API docs say 402. More importantly, quota is checked before work and updated after work. `chargeUsage` writes:

```text
used: (tenant_record.used || 0) + units
```

Because `tenant_record` is the object captured during auth, concurrent requests can race and lose increments. Large requests can also pass preflight quota then push usage beyond quota. That may be acceptable for a prototype, but not for paid plans.

Recommended near-term model:

- reserve quota before expensive work,
- write immutable usage rows for audit,
- aggregate usage from rows or atomic counters,
- distinguish compile credits, runtime calls, capture pairs, storage, and receipt retention.

## Docs And UI Drift

Examples found in static pages:

- `public/account.html` says cancel drops to free at period end; code downgrades immediately.
- `public/account.html` says delete removes all artifacts and tenants; code only soft-deletes the tenant row.
- `public/api.html` shows Pro quota 100000 and seats 3 in examples; code uses Pro quota 200000 and seats 1.
- `public/api.html` shows Business seats 15; code uses 25.
- `public/api.html` documents 402 quota exhausted; code returns 429.
- `public/api.html` shows change-plan response as a `tenant` object; code returns `plan`, `pending_plan`, `billing_url`, and `billing_required`.

Docs should be generated from route fixtures or kept under tests. Billing drift is especially expensive because customers build automations against it.

## Immediate Backlog

1. Remove unsafe `tenant.pending_plan` webhook fallback or bind it to verified Stripe metadata/Price ids.
2. Add route-level billing tests for signup, change-plan, webhook success/failure, cancel, delete, quota status, and route charging.
3. Charge `/v1/compile` and decide units for verify, recall, embed, capture, and storage.
4. Make cancel semantics match either immediate downgrade or period-end access.
5. Make delete semantics match either deactivation or actual purge.
6. Generate plan docs and examples from `PLAN_CATALOG` fixtures.

See `billing-plan-enforcement-matrix-2026-05-12.csv` for row-level evidence and recommended actions.
