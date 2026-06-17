# Backend Audit 2026 — kolm

Scope: backend only (`src/`, `server.js`, `tests/`). The frontend wave owns `public/` and the SITE gates; nothing here touches them. No deploys, no live WRITE calls, no secret values. Signing/canonicalization format and pricing are frozen (changing either would orphan previously signed artifacts).

This audit maps the five load-bearing backend subsystems, inventories the HTTP API surface, ranks the findings, and calls out the wiring gaps that genuinely *tie the backend together* (the things that, when fixed, make independent modules behave as one system).

---

## 1. Subsystem map

| Subsystem | Core files | Role |
|---|---|---|
| **api-surface** | `server.js`, `src/router.js` (29K lines), 18 `*-routes.js` modules, `src/auth.js` | The HTTP API. `buildRouter()` mounts public routes before `authMiddleware` and gated routes after. `auth.js` `PUBLIC_API` allowlist (140+ regexes) partitions soft-auth from hard-auth. |
| **audit-engine** | `src/audit-orchestrator.js`, `src/attestation-report-builder.js`, `src/audit-routes.js`, `src/audit-ingest.js`, 8 analyzers | `runAudit()` → ingest → 8 analyzers → control-mapper → graduated readiness rollup → red-team block → evidence-tier. Deterministic, versioned (`asr-audit/0.1`). |
| **crypto-trust** | `src/ed25519.js`, `src/ensure-signing-key.js`, `src/key-revocation.js`, `src/transparency-log.js`, `src/gateway-receipt.js`, `src/rfc3161-timestamp.js` | Ed25519 sign/verify, key lifecycle (live/rotated/revoked), RFC 6962 Merkle transparency log, RFC 3161 timestamps, HTTP receipts. |
| **billing-fulfillment** | `src/asr-billing.js`, `src/asr-fulfillment.js`, `src/stripe.js`, webhook in `router.js` (~13073) | Stripe payment → SIGNED webhook → idempotent fulfillment ($750 report resign, $15k package entitlement, $299–$3500 continuous subscription + weekly re-attestation) → public Trust link. |
| **compiler-pipeline** | `src/compile-pipeline.js`, `src/spec-compile.js`, `src/artifact.js`, `src/artifact-runner.js`, `src/compile-ir.js` | capture → planner → tokenizer → distill → dataset → bundle → verdict → install → `.kolm` artifact. Every shipped artifact flows through this path. |

---

## 2. API surface inventory (selected, load-bearing)

Public (soft-auth, never reject): `/health`, `/ready`, `/v1/pricing`, `/v1/product-experience`, `/metrics`, `/v1/recipes/templates`, `/v1/audit/issuer-key`, `/v1/audit/issuer-key/:fp/status`, `POST /v1/audit/report/verify`, `POST /v1/audit/scan`, `POST /v1/lead/enterprise`, `/v1/trust/:slug`, `/v1/transparency-log/(size|entries|proof|checkpoints)`.

Auth-gated (hard 401/402/429): `/v1/compile`, `/v1/pipeline/full`, `/v1/ir/*`, `/v1/artifacts/*`, `/v1/captures/*`, `/v1/account/*`, `POST /v1/audit/sessions/:id/run`, continuous re-attestation routes.

Admin-gated (ADMIN_KEY / cron-secret): `POST /v1/audit/issuer-key/:fp/revoke`, `POST /v1/audit/continuous/tick`, deploy-hook re-attest.

**Surface defects found:** `/v1/transparency-log/*` is in `PUBLIC_API` but its handler module (`transparency-log-routes.js`) is never registered → permanent 404. `GET /v1/recipes/:id` and `/v1/recipes/templates` each have a dead duplicate handler shadowed by an earlier registration. Error response shape is split between `{error}` and `{ok:false,error}`.

---

## 3. Ranked findings

### Critical / High (money, signing, auth, broken wiring)

1. **`/v1/transparency-log/*` registered in allowlist but no handler mounted** (broken-wiring, tie-together). `auth.js:557` allows the paths; `transparency-log-routes.js` `register(r)` is never imported/called in `router.js`. Clients get 404 instead of the Merkle log. *Spec: transparency-log + router wiring.*

2. **Stripe webhook fulfills the $750 report without an explicit signer** (broken-wiring, tie-together). `router.js:13141` calls `fulfillReportPurchase({audit_id, stripe_session_id})` with no `signer`; relies on a dynamic `loadOrCreateDefaultSigner()` fallback deep inside `signReport`. The money path's signing dependency is implicit and untested under signer-absence. *Spec: webhook fulfillment wiring.*

3. **Continuous re-attestation routes invoke fulfillment without a signer** (broken-wiring, tie-together). `audit-routes.js:1561` `runDueReattestations({})` and `:1575` `forceReattest({tenant_id})` both omit `signer`; same fragile dynamic fallback as the webhook. *Spec: re-attestation signer wiring.*

4. **`verifyReceipt()` does not check key revocation** (broken-wiring, tie-together). `gateway-receipt.js:173` verifies the signature only. The HTTP `/v1/audit/report/verify` route checks revocation; the pure function does not. A receipt signed by a revoked key passes `ok:true` for offline/CLI verifiers. *Spec: receipt revocation parity.*

5. **`verifyReport()` does not check key revocation** (broken-wiring, tie-together). Same asymmetry in `attestation-report-builder.js`; the route adds the check, the pure verifier does not. *Spec: report revocation parity.*

6. **CLOSED: spec-version constants are now imported by orchestrator fallbacks** (broken-wiring, tie-together). The red-team fallback now imports `RED_TEAM_SPEC_VERSION` from `red-team.js` (`asr-redteam/0.4` after W618), and the memory-ledger fallback is covered by the same spec-version sync tests. A future version bump should keep these paths constant-backed, never hardcoded. *Spec: orchestrator spec-version sync.*

7. **Webhook accepts unvalidated `product_key` for continuous subscriptions** (auth-gap). `router.js:13154` resolves `product` from `metadata.product_key`/ref and passes it to `activateSubscription` (`asr-fulfillment.js:340`), which only checks `!product || !tenant_id`, never membership in `ASR_PRODUCTS`. A spoofed `product_key` creates a subscription row with an invalid product and can skip the cadence guard. *Spec: webhook fulfillment wiring (validate against `ASR_PRODUCTS`).*

8. **Package fulfillment idempotency is SELECT-before-INSERT** (broken-wiring). `asr-fulfillment.js:286` looks up an active `(tenant,product)` row before insert; a very fast double-click can insert two rows before the second read sees the first. `withTransaction` mitigates but the pattern is weaker than insert-then-verify. *Deferred — concurrency change, needs a uniqueness strategy decision.*

9. **`compile-pipeline.js` distill can train on the full corpus (eval-set leak)** (broken-wiring, tie-together). `compile-pipeline.js:681` `const distillPairs = (trainPairs?.length) ? trainPairs : corpusPairs;` — the false branch hands the full namespace (including holdout) to distillation, contradicting the W411 P0 contract that distill MUST see train-only. *Spec: distill train-only enforcement.*

### Medium

10. `verifyReport`/`verifyReceipt`/`pubkey-directory` not consulted for provenance; embedded key only.
11. No `/health` signal for transparency-log / witness / Rekor / key-revocation readiness — silent signing degradation. *Spec: deferred (touches `router.js` health block; folded into router spec only if disjoint — see deferred).*
12. `compile-pipeline.js` does not propagate `synthesis_input_hash` / `holdout_excluded_count` to the bundle manifest on the `compileFull` path (W283 audit-trail gap on a separate entry point).
13. `markLive()` force-revives a revoked key with no reason/timestamp/ceremony.
14. Soft-auth routes can leak tenant-scoped data if a handler forgets the ownership check; no lint enforces it.
15. Response-shape inconsistency across error responses.
16. `spec-compile.js` `compiled_rule` without `opts.target` yields no binary while the verifier expects one.
17. `ensureSigningKey()` returns `{ok:true}` before confirming the key file is readable/Ed25519.

### Low

18. `isRevoked()` exported but never called (dead code). 19. Duplicate dead handlers for `/v1/recipes/:id` and `/v1/recipes/templates`. 20. Hardcoded `KOLM_CAPTURE_SOURCE` fallback string in `attestation-report-builder.js:350`. 21. `DETACHED_FIELDS` not centralized. 22. No canonicalization-algorithm version field. 23. `readiness_pct=null` for zero events but `blocking_count` still 0. 24. Query-param `api_key` rejection lacks an explanatory comment.

---

## 4. Tie-together gaps (the heart of this wave)

The backend has strong *internal* cohesion per module but several *cross-module contracts* are honored in one place and silently dropped in another. These are the asymmetries that make the system behave differently depending on which door you enter:

- **Revocation is checked at the HTTP edge but not in the pure verifiers.** `/v1/audit/report/verify` checks revocation; `verifyReport()`/`verifyReceipt()` (the offline path, the CLI path, the browser path) do not. Same key, two verdicts. Fixing both pure functions makes "verified" mean the same thing everywhere.

- **The signer is implicit in the money path.** The webhook and the re-attestation scheduler both rely on a deep dynamic `loadOrCreateDefaultSigner()` fallback rather than threading an explicit signer. The tests that pass do so via that fallback; the dependency is invisible. Threading the signer explicitly ties checkout → fulfillment → signed deliverable into one auditable chain.

- **Spec-version constants are published in one module and hardcoded in another.** `red-team.js`/`memory-integrity-ledger.js` export the version; the orchestrator's exception-fallback hardcodes a stale one. The signed audit result is the integration point — its version fields must come from the modules that own them.

- **A public allowlist entry with no handler.** `auth.js` promises `/v1/transparency-log/*` is public; `router.js` never mounts it. The allowlist and the router are two halves of one contract; they drifted.

- **The W411 train/holdout boundary is enforced in `distill-pipeline` but bypassable in `compile-pipeline`.** The orchestrator's ternary fallback can re-introduce the exact leak the audit contract forbids.

---

## 5. What this wave fixes (build specs) vs. defers

Fixed (disjoint, surgical): transparency-log registration + webhook signer/product validation (router+auth, one owner), re-attestation signer (audit-routes), receipt revocation (gateway-receipt), report revocation (attestation-report-builder), orchestrator spec-version sync (audit-orchestrator), distill train-only enforcement (compile-pipeline). Each owns a disjoint file set so builders run in parallel.

Deferred (human decision): router monolith extraction; package-fulfillment idempotency concurrency model; `/health` witness/Rekor/revocation probes (collides with router ownership this wave); `markLive` force-revive ceremony; soft-auth ownership linter; canonicalization-algorithm version field (touches frozen format).
