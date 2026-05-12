# Kolm Research Knowledge Repository

Last updated: 2026-05-12

This directory is the living research base for Kolm / the Kolmogorov stack. It is meant to be updated continuously as code, live site claims, competitors, buyer feedback, benchmarks, and regulatory facts change.

## Current Artifacts

| Artifact | Purpose |
| --- | --- |
| `critical-insights.csv` | Living sheet of the highest-leverage findings, risks, actions, and follow-up research threads. |
| `competitor-landscape-2026-05-12.md` | Source-backed competitor and adjacent-market map. |
| `competitor-evidence-matrix-2026-05-12.csv` | Row-level official-source evidence matrix for competitors, standards, implications, gaps, and recommended action. |
| `competitor-positioning-gaps-2026-05-12.md` | Strategic synthesis from the competitor evidence matrix. |
| `codebase-and-live-site-gap-review-2026-05-12.md` | Evidence-based comparison of the local repo, the live `kolm.ai` positioning, and the current implementation. |
| `codebase-module-inventory-2026-05-12.md` | Module, route-group, test, SDK, and architecture inventory from local source evidence. |
| `api-surface-inventory-2026-05-12.csv` | Route-group sheet for auth boundaries, maturity, risks, and follow-up research. |
| `claim-governance-audit-2026-05-12.md` | Live/local public-claim audit for offline, mobile, LoRA, receipt, and compliance language. |
| `claim-audit-2026-05-12.csv` | Claim-level sheet with evidence, risk, code truth, and recommended action. |
| `artifact-truth-audit-2026-05-12.md` | Current `.kolm` artifact contents, fixture proof, and product-truth gaps. |
| `artifact-fixture-inventory-2026-05-12.csv` | Row-level inventory of generated and fixture artifacts, hashes, contents, receipt mode, and K-score size drift. |
| `receipt-verification-truth-2026-05-12.md` | HMAC receipt verification truth, unsafe public-verification wording, and public-key gaps. |
| `receipt-verification-matrix-2026-05-12.csv` | Receipt-mode matrix across artifact receipts, API receipts, local runs, drive-by verifier, and readiness. |
| `deployment-readiness-truth-2026-05-12.md` | `/ready` environment matrix, minimum production profiles, and test drift around artifact storage. |
| `deployment-readiness-matrix-2026-05-12.csv` | Scenario matrix for dev, production, SQLite, JSON override, missing secret, weak secret, and missing dirs. |
| `pricing-and-packaging-implications-2026-05-12.md` | Competitor pricing implications and recommended Kolm packaging units. |
| `pricing-competitor-matrix-2026-05-12.csv` | Source-backed pricing matrix for gateways, observability/evals, prompt ops, marketplaces, and fine-tuning providers. |
| `sandbox-hardening-decision-2026-05-12.md` | Recipe sandbox decision memo for `node:vm`, isolated-vm, SES, Wasmtime, Deno, gVisor, and Firecracker options. |
| `sandbox-option-matrix-2026-05-12.csv` | Source-backed sandbox option matrix and recommended use by trust level. |
| `auth-boundary-audit-2026-05-12.md` | Auth, OAuth, route-boundary, anon-claim, public-run, and query-key security audit. |
| `auth-boundary-matrix-2026-05-12.csv` | Row-level auth boundary matrix with public/protected status, risk, and recommended action. |
| `tenant-data-lifecycle-audit-2026-05-12.md` | Tenant data isolation, account deletion, recall path, cache, capture, and aggregate telemetry audit. |
| `tenant-data-isolation-matrix-2026-05-12.csv` | Row-level tenant data boundary and lifecycle matrix. |
| `billing-plan-enforcement-audit-2026-05-12.md` | Billing, Stripe webhook, quota, plan entitlement, cancel/delete semantics, and docs-drift audit. |
| `billing-plan-enforcement-matrix-2026-05-12.csv` | Row-level billing and plan enforcement matrix. |
| `sdk-cli-integration-audit-2026-05-12.md` | Browser SDK, Node SDK, Python SDK, MCP, CLI, package naming, and docs install-path audit. |
| `sdk-cli-integration-matrix-2026-05-12.csv` | Row-level SDK/CLI integration readiness matrix. |
| `ci-test-deploy-health-audit-2026-05-12.md` | CI workflow, root test, SDK test, GitHub Action, Vercel, Railway, Docker, and deploy-gate audit. |
| `ci-test-deploy-health-matrix-2026-05-12.csv` | Row-level CI, test coverage, and deployment health matrix. |
| `compliance-security-posture-audit-2026-05-12.md` | Security, privacy, terms, BAA/DPA, healthcare, legal, enterprise, audit-log, and supply-chain claim audit. |
| `compliance-security-posture-matrix-2026-05-12.csv` | Row-level compliance/security posture matrix with shipped/manual/planned gaps. |
| `api-docs-contract-drift-audit-2026-05-12.md` | Public API/docs/quickstart/README contract drift audit against router and compile code. |
| `api-docs-contract-matrix-2026-05-12.csv` | Row-level API documentation contract drift matrix. |
| `benchmark-reproducibility-audit-2026-05-12.md` | Artifact benchmark, K-score, no-eval/no-ship, SWE-bench reproducer, and egress-proof audit. |
| `benchmark-reproducibility-matrix-2026-05-12.csv` | Row-level benchmark and reproducibility claim matrix. |
| `registry-governance-audit-2026-05-12.md` | Public registry, submit/review, Atlas, leaderboard, export, public run, SDK cache, and governance audit. |
| `registry-governance-matrix-2026-05-12.csv` | Row-level public registry governance and artifact distribution matrix. |
| `capture-distillation-governance-audit-2026-05-12.md` | Capture proxy, observation inbox, label export, auto-synthesis, auto-distill, local tune, and Specialist governance audit. |
| `capture-distillation-governance-matrix-2026-05-12.csv` | Row-level capture-to-distillation pipeline governance matrix. |
| `audit-observability-evidence-audit-2026-05-12.md` | Audit log, telemetry, receipt metrics, status, readiness, error traceability, and operational evidence audit. |
| `audit-observability-evidence-matrix-2026-05-12.csv` | Row-level audit and observability evidence matrix. |
| `recall-rag-memory-governance-audit-2026-05-12.md` | Hosted Recall, qmd bridge, local RAG, artifact index slot, memory route, and recall claims audit. |
| `recall-rag-memory-governance-matrix-2026-05-12.csv` | Row-level recall/RAG/memory governance matrix. |
| `agent-mcp-install-governance-audit-2026-05-12.md` | Local artifact MCP server, harness installer, skill sidecar, hooks, and agent integration claim audit. |
| `agent-mcp-install-governance-matrix-2026-05-12.csv` | Row-level agent/MCP/install governance matrix. |
| `device-offline-browser-governance-audit-2026-05-12.md` | Browser SDK, `/device`, service worker, PWA, live device page, and offline-runtime claim audit. |
| `device-offline-browser-governance-matrix-2026-05-12.csv` | Row-level device/offline/browser governance matrix. |
| `release-distribution-governance-audit-2026-05-12.md` | Package publication, CLI install, GitHub Action, Docker, Homebrew, Windows package-manager, SDK release, and supply-chain proof audit. |
| `release-distribution-governance-matrix-2026-05-12.csv` | Row-level release/distribution governance matrix. |
| `source-register-2026-05-12.md` | Primary-source register for the first research pass. |
| `research-backlog-2026-05-12.md` | Open research threads to keep this repository moving. |

## Maintenance Rules

1. Treat `critical-insights.csv` as the canonical sheet. Add a row whenever a finding changes product direction, positioning, technical priority, customer targeting, or risk posture.
2. Prefer primary sources: official docs, official product pages, official policy pages, repo code, live pages, verified benchmark output, and customer evidence.
3. Separate facts from implications. A product page can prove what a competitor claims; it does not prove performance, adoption, or customer value.
4. Mark roadmap and preview features explicitly. Do not let live copy imply shipped local weights, LoRA training, mobile runtime support, or compliance certification unless real evidence exists.
5. Keep source dates. Competitor claims and AI regulation change quickly.

## Working Thesis

Kolm should not compete as another gateway, observability tool, memory layer, RAG framework, fine-tuning UI, or on-device runtime. The defensible lane is:

- a portable `.kolm` artifact format,
- a compiler that turns task evidence into executable behavior,
- a conformance and K-score gate,
- signed compile/run receipts,
- private/public registry and governance,
- runtime targets that wrap existing local/server runtimes rather than replacing them.

The most urgent work is making this claim true end to end: safe tenant/auth boundaries, real artifact contents, real receipt verification, durable storage/jobs, stronger sandboxing, governed public registry review and revocation, capture-to-distillation paths that respect triage and retention, artifact-bound recall that actually influences compile/run behavior, agent/MCP harnesses that match their public install and security contracts, a browser/offline runtime whose SDK, worker, PWA cache, and live device demo actually run before being used as proof, release/package channels whose public install labels match npm/PyPI/Homebrew/Windows/Docker/GitHub Action evidence, tenant-visible audit logs, accurate receipt metrics, status evidence backed by monitor history, seeded registry evidence, canonical benchmark reports, one K-score schema, CI/deploy gates that prevent regressions from shipping, compliance/security claims backed by implemented controls, and generated API/docs contracts that cannot drift silently.
