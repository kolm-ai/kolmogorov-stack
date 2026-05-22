# Kolm Launch Checklist

Internal pre-flight for the public site, product console, and launch narrative.
Last updated 2026-05-22.

## Positioning

- [x] Homepage states the three product jobs in the first viewport: route any model, distill specialists, run signed artifacts on any target.
- [x] Public copy avoids retired single-surface gateway framing.
- [x] Product pages separate gateway, distillation, runtime, proof, and enterprise deployment.
- [x] Pricing uses the current Free / Pro / Team / Enterprise model.
- [x] Enterprise CTAs route to architecture review or inquiry instead of fake self-serve checkout.

## Public Website

- [x] Dark mode and light mode render for every static route.
- [x] Desktop and mobile screenshots pass for all 510 public routes.
- [x] Navigation uses one active-state pattern with no underline fallback drift.
- [x] Buttons and menu targets meet touch-size rules.
- [x] Public text assets scan clean for stale hero, pricing, captured-event, and old-name strings.
- [x] Public inline scripts parse clean outside generated CLI docs.
- [x] Replacement-character mojibake scan returns zero.

## Product Proof

- [x] Homepage proof media renders in light and dark mode.
- [x] `/run` proof shell keeps readable contrast in light mode.
- [x] `/device` runtime page loads without console syntax errors.
- [x] `/dashboard` account probes use stored API-key aliases.
- [x] Localized docs gateway pages render cleanly.
- [x] Generated API reference and OpenAPI are rebuilt from current route comments.

## Account Console

- [x] Post-auth overview covers gateway, distillation, runtime, storage, devices, proof, billing, and readiness.
- [x] Account storage surfaces object-readiness without exposing secret values.
- [x] Account mobile navigation and product matrix fit without overflow.
- [x] Billing language matches Free / Pro / Team / Enterprise.

## Launch Gates

- [x] Local full-route UI audit passes in dark desktop/mobile.
- [x] Local full-route UI audit passes in light desktop.
- [x] Local full-route UI audit passes in light mobile.
- [x] `npm.cmd run lint:refs` passes locally.
- [x] Frontend fingerprint and service-worker cache key are bumped after public repairs.
- [ ] Deploy this workspace.
- [ ] Re-run live production screenshots against `https://kolm.ai`.
- [ ] Re-run authenticated production account checks with a real `ks_` key.
- [ ] Confirm backend/CLI owner has green release verification after concurrent changes.

## Launch Narrative

```
Show HN: Kolm turns AI work into signed models you own

Kolm is the evidence-to-artifact compiler for production AI.

Use it three ways:
- One gateway for OpenAI, Anthropic, Gemini, OpenRouter, and local providers.
- One path to distill reviewed AI work into specialist `.kolm` artifacts.
- One signed runtime format for browser, phone, server, VPC, and air gap.

The point is simple: keep model choice open, reduce repeat API cost, and prove what shipped.

Start:
https://kolm.ai/quickstart

Spec:
https://kolm.ai/spec

Benchmarks:
https://kolm.ai/benchmarks
```

No production-final claim is allowed until the deployed site and authenticated account console pass live verification.
