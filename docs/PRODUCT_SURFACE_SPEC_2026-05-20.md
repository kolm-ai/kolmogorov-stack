# Product Surface Spec - 2026-05-20

## Verdict

**NOT 100% FINAL.**

Kolm now has an enforceable product-surface contract, but the product is not final because production authenticated coverage is blocked. The current truth is:

- `docs/product-surfaces.json` is the canonical product surface registry.
- `scripts/verify-product-surfaces.cjs` is the gate that verifies the registry against the generated API inventory.
- `scripts/prod-surface-smoke.cjs` is the live production smoke runner for every declared surface.
- `scripts/local-surface-smoke.cjs` boots an isolated local backend, provisions an enterprise tenant, and runs the same surface probes without using `~/.kolm/config.json`.
- `npm run lint:refs` now includes the product-surface gate.
- The catalog maps `356` API routes across `108` route groups to `7` product surfaces with `20` primary competitor/research references.
- Local certification is green on this working tree: `npm.cmd test` passed `4382` tests with `0` failures, `local:surfaces` passed `49/49`, and `local:surfaces:deep` passed `58/58`.
- `node scripts/release-verify.cjs --json` still fails final certification because the `whoami` gate returns `logged_in:false` with `allow_logged_out:false`; its local gates, isolated tests, and SDK smoke pass.
- The catalog intentionally carries blockers. A blocked surface is a truthful surface, not a finished one.

No future claim of "100% final" is valid until production auth passes and every surface below has a passing production smoke path.

## Source Of Truth

| Artifact | Role |
| --- | --- |
| `docs/product-surfaces.json` | Machine-readable owner, route-group, code-path, doc-path, competitor, optimal-spec, certification, and blocker registry. |
| `scripts/verify-product-surfaces.cjs` | Contract gate. Fails when a route group is unowned, double-owned, points at missing code/docs, or references unknown research. |
| `scripts/prod-surface-smoke.cjs` | Live smoke runner. Executes each surface's structured `production_smoke` probes against `https://kolm.ai` or `--base=<url>`. |
| `scripts/local-surface-smoke.cjs` | Local end-to-end harness. Starts `server.js` on an isolated port/data directory, provisions a disposable enterprise tenant, and invokes the production smoke runner against localhost. |
| `public/docs/api-routes.json` | Generated backend route inventory. The surface registry must map this inventory exactly. |
| `FINAL_BACKEND_AUDIT_2026-05-20.md` | Backend evidence audit. Current verdict remains production-auth blocked. |

## Research Baseline

The registry uses primary docs and current competitor references, not vibes. Full URLs live in `docs/product-surfaces.json`; the high-signal baseline is:

| Market layer | State-of-art comparator | Product implication for Kolm |
| --- | --- | --- |
| Provider customization | OpenAI supervised fine-tuning; Together AI LoRA/full fine-tuning; Predibase/OpenPipe; Amazon Bedrock custom models | Kolm should not compete on generic fine-tune UX alone. It must win on portable artifacts, receipts, runtime targets, eval gates, and governance. |
| Runtime cost and routing | OpenAI and Anthropic prompt caching; OpenRouter-style routing | Kolm must preserve provider fallback and cache economics while proving avoided calls for stable repeated work. |
| Observability and evals | LangSmith, Arize Phoenix, W&B Weave | Trace, dataset, experiment, and online eval loops are table stakes. Kolm must bind them into signed artifact evidence. |
| Enterprise identity and billing | WorkOS, Auth0 Organizations, Stripe Billing and customer portal | SSO, SCIM, RBAC, audit logs, self-serve invoices, subscription portal, entitlements, quotas, and webhooks are required for enterprise-final. |
| Edge runtime substrate | Apple Core ML, Apple Foundation Models, Google LiteRT, ONNX Runtime Mobile, PyTorch ExecuTorch | Kolm should wrap and govern existing runtimes. It should not pretend to replace platform-native execution engines. |

## Product Surfaces

| Surface | Routes | Status | State-of-art bar | Missing for 100% |
| --- | ---: | --- | --- | --- |
| Identity, access, teams, billing | 60 | `blocked-prod-auth` | WorkOS/Auth0-grade org identity, scoped keys, RBAC, SSO/SCIM, audit logs, Stripe portal-backed billing and entitlements. | Valid production key; auth/account/key/team/billing prod smoke; SSO/SCIM final certification; webhook-backed entitlement proof. |
| Public site, docs, API reference, SDK | 27 | `needs-prod-smoke` | Generated docs from route inventory, OpenAPI with zero undocumented flags, content-addressed SDK assets, source-backed public claims. | Direct production fetch/hash smoke for docs, OpenAPI, SDK manifest, SDK asset, pricing, signup, and comparison pages. |
| Compile, artifacts, registry, receipts, verification | 38 | `blocked-prod-auth` | Signed portable artifact with source, evals, K-score, runtime target, CID, signature, registry state, and optional transparency-log proof. | Authenticated production compile/artifact/list/download/verify smoke; durable cloud compile/object storage proof; marketplace publish dry run. |
| Runtime, inference, connectors, multimodal APIs | 37 | `blocked-prod-auth` | OpenAI/Anthropic-compatible runtime, provider fallback, prompt-cache-aware routing, receipts, cost/latency metadata, and tenant-gated hot path. | Authenticated `/v1/models`, `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, `/v1/verified-inference`; production model-provider readiness. |
| Capture, datasets, evals, labels, training, improvement loop | 92 | `blocked-prod-auth` | LangSmith/Phoenix/Weave-class traces, datasets, labels, experiments, evals, distill runs, replay, drift, and governed training provenance. | Remote loop auth; dataset create/split; label next/submit; distill dry run; external trace importer fixtures; K-score update guardrails. |
| Governance, compliance, admin, audit, privacy, trace, notifications | 53 | `blocked-prod-auth` | Append-only signed audit logs, privacy policy enforcement, tenant fences, compliance exports, trace lineage, DSR/retention evidence. | Production compliance package export; trace append/export; audit export; privacy scan/redact; SOC2/HIPAA evidence beyond code. |
| Deployment, edge devices, BYOC, storage, sync, tunnel, federated learning | 49 | `blocked-prod-auth` | Runtime target matrix for Core ML/LiteRT/ONNX/ExecuTorch, graceful device probes, BYOC data-plane separation, sync/tunnel/federated evidence. | BYOC lifecycle dry run; storage/sync/tunnel prod smoke; federated contribution/aggregate prod smoke. |

## Codebase Organization Rule

Every feature must land in one of the seven surfaces before it is considered product. The ownership rule is:

1. Add or change the backend route.
2. Regenerate `public/docs/api-routes.json` and OpenAPI through the existing docs pipeline.
3. Assign the route group to exactly one surface in `docs/product-surfaces.json`.
4. Add the code path and human doc path that prove the feature is not just a route name.
5. Add competitor/research references when the public promise changes.
6. Add local and production certification gates.
7. Run `npm run verify:surfaces` or `npm run lint:refs`.

If a route group cannot be assigned, it is not ready to ship. If a surface has no production gate, it cannot be called final.

## Upgrade Backlog

### P0 - Blocks "100% Final"

| Area | Required code/product work |
| --- | --- |
| Production auth | Provision a valid production tenant/admin key, make `doctor`, `whoami`, `health --require-auth`, and remote loop pass without `--allow-logged-out`. |
| Surface smoke runner | Completed in code: production and local runners now execute declared safe/deep probes across every product surface. Production remains blocked by network/auth, not by missing runner code. |
| Device detect | Completed in code: GET/POST `/v1/devices/detect` now degrade to structured partial profiles instead of profile-dependent 500s. |
| Local hermeticity | Completed in code: `npm.cmd test` now avoids real-profile event-store/bootstrap leakage and passes with `0` failures. |
| Binder reproducibility | Completed in code: tampered artifacts now produce verifier failure rows for signature and deterministic rebuild drift instead of aborting before check #13. |
| Docs/SDK prod hash gate | Fetch `/docs/api`, `/openapi.json`, `/sdk-current.json`, and the current SDK asset from `https://kolm.ai`; verify status, parseability, bytes, hash, and SRI. |
| Authenticated compile/artifact gate | Compile, list, download, and verify a production artifact with the same tenant key that runs `whoami`. |
| Remote value loop | Make `doctor --loop --remote --json` pass against production capture, bridge, distill, replay, and lake routes. |

### P1 - Required For State-Of-Art Enterprise Launch

| Area | Required code/product work |
| --- | --- |
| Enterprise identity | Add or certify SSO, SCIM, RBAC, service accounts, key scopes, key rotation, org/workspace/tenant separation, and admin audit export. |
| Billing | Replace payment-link-only proof with customer portal session, webhook-backed entitlements, invoice state, usage quota, and plan-change audit rows. |
| Trace/eval imports | Build import/export adapters for LangSmith, Phoenix/OpenTelemetry/OpenInference, Weave, and OpenPipe-style trace-to-finetune loops. |
| Runtime receipts | Persist provider, model, prompt hash, cost, latency, cache metadata, privacy decision, and fallback path on every connector call. |
| Registry trust | Add yanked/deprecated/manual-review states, optional Sigstore/Rekor anchoring, and artifact transparency evidence in the public verifier. |
| Compliance package | Export receipts, manifests, audit rows, DSR state, subprocessors, retention policy, and admin actions as a tenant-scoped bundle. |

### P2 - Differentiators

| Area | Required code/product work |
| --- | --- |
| Runtime target matrix | Publish and enforce target manifests for Core ML, LiteRT, ONNX Runtime Mobile, ExecuTorch, llama.cpp, and browser/PWA execution. |
| Gateway integrations | Add LiteLLM, Vercel AI SDK, OpenRouter, and Cloudflare AI Gateway middleware paths that route repeated tasks to `.kolm` first. |
| Marketplace quality | Add verified/yanked/deprecated lifecycle, public receipt viewer, publisher trust, artifact signing tiers, and enterprise private registry. |
| Drift and rollback | Automatically compare production traces to K-score gates and require rollback or review when drift exceeds surface-specific policy. |

## Certification Commands

These commands are now the minimum local contract for product-surface integrity:

```powershell
node --check scripts/verify-product-surfaces.cjs
node --check scripts/prod-surface-smoke.cjs
node --check scripts/local-surface-smoke.cjs
npm.cmd run verify:surfaces
npm.cmd run local:surfaces
npm.cmd run local:surfaces:deep
npm.cmd run lint:refs
```

These are the minimum production commands before any final claim:

```powershell
node cli/kolm.js health --json --require-ready --require-auth
node cli/kolm.js doctor --json
node cli/kolm.js whoami --json
node cli/kolm.js doctor --loop --remote --json
node cli/kolm.js verify examples/claims-redactor/claims-redactor.kolm --json
node cli/kolm.js billing tiers --json
node scripts/prod-surface-smoke.cjs --json --require-auth
node scripts/prod-surface-smoke.cjs --json --deep --require-auth
node scripts/release-verify.cjs --json
```

The final command set must not use `--allow-logged-out`, skipped gates, or offline billing fallbacks.

## Maintenance Policy

This file is the human spec. `docs/product-surfaces.json` is the enforceable spec. When they disagree, update both and let `scripts/verify-product-surfaces.cjs` decide whether the repo is internally coherent.

Any future product surface must include:

- Product promise.
- Route groups.
- Primary public/API paths.
- Code paths.
- Human doc paths.
- Competitor/research references.
- Optimal technical spec.
- Local and production certification gates.
- Explicit blockers if it is not final.
