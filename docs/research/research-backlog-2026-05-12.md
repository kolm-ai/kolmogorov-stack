# Research Backlog

Opened: 2026-05-12

This backlog keeps the research loop alive. The goal is to convert broad "keep researching" into specific questions that can update `critical-insights.csv`.

## P0: Claim And Product Truth

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-001 | What exactly is inside a current `.kolm` produced from a clean compile? | Generate a sample artifact, unzip it, hash every member, verify receipt, run artifact. | Artifact evidence page and updated claim table. |
| RB-002 | Which live pages imply local weights, LoRA, phone runtime, or compliance status? | Crawl `public/*.html` and live `kolm.ai` pages for claim terms. | Claim audit CSV with exact page, phrase, allowed/revise/action. |
| RB-003 | Can a receipt be verified offline from a clean machine without secrets? | Try CLI/API verifier with a sample HMAC receipt; design Ed25519 sample. | Receipt mode spec and verifier acceptance test. |
| RB-004 | What is the minimum production deployment profile? | Exercise `/ready` under env matrices: JSON, SQLite, missing secret, production-like host. | Deployment truth table. |
| RB-008 | Does the signed manifest K-score size match the final zip size? | Fix or test the `buildAndZip` second-pass size mutation found in `artifact-truth-audit-2026-05-12.md`. | Artifact K-score size consistency test and implementation fix. |
| RB-009 | Which artifact member names mislead buyers? | Review `model.gguf`, `lora.bin`, and `index.sqlite-vec` naming against actual v0.1 contents. | Artifact naming/copy decision memo. |
| RB-015 | What is the first public-key receipt mode Kolm can ship? | Design Ed25519 receipt fields, public key identity, fixture vectors, CLI verifier, and migration from HMAC. | Receipt v0.2 public verification spec. |
| RB-016 | Should local artifact runs produce signed per-run receipts? | Compare current unsigned `rs-1-run` object with artifact receipt and API run HMAC receipt paths. | Local-run receipt design decision. |
| RB-017 | Should production readiness require durable artifact storage? | Resolve the mismatch between `runtimeReadiness()` temp artifact fallback and `tests/auth.test.js` expected `not_ready`. | Readiness semantics fix and test update. |
| RB-018 | What is the accepted v0 production profile? | Choose SQLite, JSON override, or future Postgres/queue; document limits and retention behavior. | Production deployment profile memo. |

## P0/P1: Auth Boundary And Tenant Security

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-019 | How should anon workspaces be claimed without account takeover risk? | Use the anon-claim smoke from `auth-boundary-audit-2026-05-12.md`, design email/OAuth proof, and add regression tests. | Fixed claim flow and tests denying existing-email merge without proof. |
| RB-023 | How should query-string API keys be removed without breaking CLI users? | Inventory SDK/CLI callers, add deprecation warnings, and test header/cookie alternatives. | Query-key deprecation plan and implementation. |
| RB-024 | Which routes are intentionally public, protected, admin-only, or webhook-public? | Generate route declarations from `src/router.js` plus OAuth mounts and compare to `auth-boundary-matrix-2026-05-12.csv`. | Checked-in route auth manifest and failing test for unexpected changes. |
| RB-025 | What abuse controls should govern unauthenticated public runs? | Measure `/v1/public/run` cost, input sizes, receipt overhead, and limiter behavior under load. | `publicRunLimiter`, input caps, and public-run abuse tests. |
| RB-026 | Should browser sessions use separate credentials from long-lived API keys? | Review OAuth key rotation, cookie/header precedence, CLI key UX, and account recovery flows. | Session-token/API-key separation design. |
| RB-027 | Should account deletion purge data or deactivate access? | Use `tenant-data-lifecycle-audit-2026-05-12.md`, privacy copy, and retention requirements to choose semantics. | Account deletion/deactivation policy and implementation plan. |
| RB-028 | Can recall source preview escape the tenant root on Windows and POSIX? | Turn the local prefix smoke into tests for sibling prefixes, `..`, encoded separators, and exact root access. | Shared path-inside helper and traversal regression tests. |
| RB-029 | What data root and retention policy should runtime cache use? | Inventory cache files, KOLM_DATA_DIR/KOLM_CACHE_DIR behavior, account deletion expectations, and public/private cache modes. | Cache root migration and cache-retention test plan. |
| RB-035 | Which aggregate telemetry is tenant-private versus global public usage? | Review lineage, specialist candidates, public runs, telemetry dashboards, and owner analytics. | Aggregate telemetry scoping policy and route fixes. |
| RB-036 | What capture retention and redaction controls are required for enterprise use? | Review prompt/response persistence, namespace lifecycle, export/delete controls, DPA claims, and subprocessor needs. | Capture data governance spec and implementation backlog. |

## P0/P1: Billing And Plan Enforcement

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-037 | How should Stripe plan activation be bound to actual payment? | Use the pending-plan mismatch smoke, Stripe Price ids, Payment Link ids, metadata, and amount checks. | Safe webhook activation logic and route tests. |
| RB-038 | What is the canonical paid unit: compile credits, runtime calls, artifact months, receipt retention, or all of these? | Compare `billing-plan-enforcement-audit-2026-05-12.md` with pricing research and current `chargeUsage` calls. | Route-to-billing unit matrix and implementation plan. |
| RB-039 | Which plan features are actually enforceable today? | Map public pricing rows to code gates for seats, private artifacts, SSO, SCIM, audit logs, support, BAA, and registry controls. | Entitlement matrix and copy cleanup. |
| RB-043 | Should cancellation be immediate downgrade or period-end access? | Compare Stripe subscription state, route behavior, account UI, API docs, and customer expectations. | Cancel semantics decision and route/docs fix. |
| RB-044 | How should quota accounting become auditable and race-resistant? | Review stale-object `chargeUsage`, concurrent requests, usage ledgers, and quota reservation before expensive work. | Atomic usage ledger design and tests. |
| RB-045 | How should billing docs stay in sync with code? | Generate examples from `PLAN_CATALOG`, route fixtures, and signed webhook fixtures. | Docs snapshot tests for account/pricing/API billing examples. |

## P0/P1: SDK, CLI, And Developer Entry Points

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-046 | What is the minimal launch-safe SDK surface? | Start from `sdk-cli-integration-audit-2026-05-12.md` and choose browser, Node, Python, MCP, or CLI-only launch scope. | SDK launch readiness checklist. |
| RB-047 | How should browser SDK assets be built and gated? | Fix syntax, run `node --check`, browser import smoke, worker run smoke, and SRI manifest verification. | Browser SDK build gate and regenerated assets. |
| RB-048 | Which public recipe helper contract should all SDKs share? | Align Node, Python, MCP, and browser helpers on `/v1/public/run` and curated recipe lookup. | Shared public helper fixture tests. |
| RB-049 | What are the canonical package names and install commands? | Decide npm/PyPI/MCP names, private/GitHub fallback, and migration from `recipe` terminology. | Package naming decision and docs cleanup. |
| RB-054 | How should Python SDKs map to the current API and CLI? | Update batch, verify, public run, compile fallback, CLI flags, and response parsing. | Python SDK contract fix and CI tests. |
| RB-055 | How should SDK tests run without a live server? | Build fetch/urllib mocks and optional live `KOLM_BASE_URL` contract tests. | Reliable SDK CI matrix. |

## P0/P1: CI, Tests, And Deployment Gates

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-056 | How should root tests become a required release gate? | Fix the current readiness test failure, add `npm test` to CI, and confirm branch protection uses it. | Required CI test workflow with green root suite. |
| RB-057 | How should browser SDK assets be validated before publish? | Add syntax checks, browser import smoke, worker execution smoke, versioned asset checks, and SRI manifest verification. | Browser SDK release gate and regenerated assets. |
| RB-058 | How should the GitHub compile action track the CLI contract? | Compare action flags/output with `cli/kolm.js`, add true JSON output or update parsing, and run an action contract smoke. | Working reusable compile action and fixture test. |
| RB-059 | What is the single production deploy topology? | Decide Vercel proxy versus direct app hosting, Railway backend role, Docker entrypoint, and strict readiness target. | Production deployment contract and config cleanup. |
| RB-060 | Which P0/P1 findings need route-level regression tests first? | Turn auth, billing, tenant lifecycle, recall path, and public-run findings into focused Node test files. | Security and billing regression test suite. |
| RB-061 | What CI matrix should cover SDKs and runtime versions? | Add Node SDK mocked tests, Python tests, MCP tests, Node version policy, and optional live contract jobs. | SDK/runtime CI matrix with clear required and optional jobs. |
| RB-062 | How should live/local parity be checked? | Generate route/API/docs contracts from source and run them locally plus against `kolm.ai`. | Dated parity report and failing deploy smoke for drift. |
| RB-063 | Which health endpoint should gate production promotion? | Resolve `/health` versus `/ready`, artifact storage expectations, secret requirements, and deploy platform behavior. | Strict readiness promotion policy and tests. |

## P0/P1: Compliance And Security Posture

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-064 | What is the real account deletion and tenant purge policy? | Compare privacy, BAA, tenant data stores, cache, artifacts, public registry, Stripe, and receipts. | Deletion policy plus purge/certification implementation plan. |
| RB-065 | How should capture data be retained, redacted, exported, and purged? | Use `observations` routes, capture proxy behavior, and privacy/audit-log claims. | Capture governance spec and route tests. |
| RB-066 | What is the minimum durable audit log that regulated buyers need? | Design tenant-scoped entries, opt-in state, JSON/CSV export, receipt chain, rotation, and migration. | Audit log implementation plan and fixtures. |
| RB-067 | Which legal/procurement artifacts actually exist? | Inventory BAA, DPA, MSA, SOC 2 letters, subprocessor list, security posture, and compliance binder templates. | Versioned compliance artifact pack. |
| RB-068 | What subprocessor and data-category map matches current deployment? | Map Vercel, Railway, Stripe, storage, capture, compile, logs, and regional options. | Dated subprocessor register and deploy data map. |
| RB-069 | What supply-chain evidence should be public at release? | Add SBOM, Cosign/Sigstore, provenance, release workflow, and verification instructions. | Release evidence workflow and public artifact links. |
| RB-070 | How should regulated vertical pages label shipped/manual/planned claims? | Review healthcare, legal, finance, defense, enterprise, security, privacy, terms, and BAA pages. | Claim-label policy and copy cleanup queue. |
| RB-071 | How should vulnerability disclosure be made fully operational? | Verify PGP key import, `.asc` publication, bounty scope, acknowledgments page, and security.txt expiry checks. | Disclosure operations checklist and tests. |
| RB-072 | What legal review matrix covers HIPAA, non-HIPAA health, GDPR, and sector-specific deployments? | Use official HHS, FTC, EUR-Lex, and customer deployment assumptions. | Legal review checklist for regulated pilots. |
| RB-073 | What should a quarterly compliance binder actually contain? | Define evidence sources for receipt-chain, K-score regression, subprocessors, incidents, retention, and deploy changes. | Sample generated binder and source manifest. |

## P0/P1: API Docs And Contract Governance

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-074 | What route manifest should be the API source of truth? | Extract method, path, auth status, maturity, request schema, response schema, examples, and owners from `src/router.js`. | Checked-in route manifest or OpenAPI spec. |
| RB-075 | How should `/api`, README, SDK fixtures, and docs examples be generated? | Compare current manual docs to route manifest and SDK tests. | Docs generation pipeline and snapshot tests. |
| RB-076 | What are the canonical account and billing response shapes? | Reconcile account, change-plan, cancel, delete, Stripe webhook, and account UI behavior. | Stable account/billing API contract with tests. |
| RB-077 | How should public and anonymous APIs be documented and abuse-gated? | Include anon bootstrap/claim, public concepts/run/featured, public submit, receipts, and spec endpoints. | Public API section with auth/abuse semantics. |
| RB-078 | What are the stable compile, artifact, registry, and receipt schemas? | Generate examples from successful compile, artifact download, registry export, and receipt verify fixtures. | Executable schema fixtures for core developer flows. |
| RB-079 | How should docs examples be tested continuously? | Parse `/api` and `/docs` examples, execute safe local examples, and compare expected response snapshots. | Docs contract CI job. |

## P0/P1: Benchmarks And Reproducibility

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-080 | What is the canonical artifact benchmark report set? | Generate one report JSON per public fixture with command, secret, Node version, device label, artifact hash, and runs count. | Checked-in fixture report bundle and generated `/benchmarks` table. |
| RB-081 | Which K-score schema is authoritative for v1? | Compare current `computeKScore`, legacy fixture manifests, public table values, and `k-score-1` docs. | K-score migration plan and fixture rebuild checklist. |
| RB-082 | Should `compile --spec` require evals? | Build no-eval local artifacts and test downstream benchmark, MCP, and score behavior. | Gate policy and validation tests. |
| RB-083 | Where should `k_score.ships` be enforced? | Trace `synthesis`, `compile`, `spec-compile`, `buildAndZip`, MCP serve, and tune promote paths. | Central gate enforcement patch plan. |
| RB-084 | What benchmark statistics belong in `kolm-benchmark-1`? | Decide if artifact-local reports need confidence intervals, repeated-run variance, warmup, hardware metadata, and sample size rules. | Benchmark schema v2 proposal. |
| RB-085 | Can the SWE-bench reproducer be fully self-contained? | Verify Docker image digest, local `bench/` completeness, external repo availability, p-value calculation, and report schema. | Reproducer release checklist and local smoke test. |
| RB-086 | What egress proof level is honest for each trust tier? | Test benign fixtures, malicious JS recipes, subprocess attempts, native binaries, and container isolation options. | Egress threat model and sandbox test suite. |
| RB-087 | What deterministic packaging work is required for byte-stable rebuilds? | Inspect zip timestamps, manifest timestamps, receipt IDs, order, compression, and signing payloads. | Deterministic artifact build design or copy limitation. |
| RB-088 | How should benchmark examples be generated in docs? | Render `/benchmarks`, `docs/benchmark-results`, and fixture JSON snippets from the same source files. | Docs generation script and stale-value tests. |
| RB-089 | Which benchmark claims need launch-blocking tests? | Map public claims to tests for no-eval rejection, gate enforcement, K-score schema, fixture reports, and egress monitor scope. | Benchmark release gate in CI. |

## P0/P1: Public Registry Governance

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-090 | How should public visibility become review-enforced? | Route `visibility: public` through concept/version review state for synthesize, stream, batch, and manual publish. | Public review gate design and route tests. |
| RB-091 | What evaluation evidence is required for public publish? | Define minimum positives, negatives, property tests, quality threshold, and empty-eval behavior. | Public publish policy plus verifier regression tests. |
| RB-092 | What is the canonical public registry schema? | Reconcile `/v1/public/concepts`, `/v1/public/concepts/:id`, `/v1/registry/public`, `/v1/registry/export`, Atlas, Leaderboard, SDK, and API docs. | Versioned public registry schema fixture. |
| RB-093 | What public detail and download surface should exist? | Design `/registry/{id}`, artifact download, source viewing, manifest, receipt, evals, and run affordances. | Public registry detail page and route contract. |
| RB-094 | What trust metadata belongs on concepts and versions? | Add review status, trust level, publisher identity, license, provenance, approved_by, approved_at, and revoked_at. | Registry trust schema and migration plan. |
| RB-095 | How should public run be abuse-gated? | Rate limits, quota class, sandbox tier, input caps, telemetry, and denial behavior for unauthenticated public runs. | Public run abuse-control test suite. |
| RB-096 | How should Atlas and Leaderboard avoid unsupported badges? | Fixture-test pages against actual response shapes and row-level signature/K-score evidence. | UI truth tests and copy cleanup queue. |
| RB-097 | Should registry export be signed, JSON, NDJSON, or both? | Decide export format, hash/signature semantics, registry versioning, and mirror compatibility. | Export schema v2 and docs generation. |
| RB-098 | How should seed entries be labeled and curated? | Distinguish boot demo examples from reviewed public artifacts; attach provenance and trust level. | Seed registry governance policy. |
| RB-099 | Which registry governance tests are launch-blocking? | Cover review bypass, empty eval publish, missing detail routes, export trust fields, public run limiter, and cache revocation. | Required public registry CI gate. |
| RB-100 | What admin workflow completes public submissions? | Build approve/reject/promote endpoints, audit trail, notifications, and owner-visible status. | Admin submission workflow spec and tests. |
| RB-101 | How should browser SDK caches handle revocation? | Add registry sequence, minimum accepted version, revocation list, and stale cache rejection semantics. | Offline cache revocation design and smoke tests. |

## P0/P1: Capture And Distillation Governance

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-102 | What is the canonical observation schema? | Reconcile `namespace`, `corpus_namespace`, template hash, status, kept/discarded, source, retention class, and provenance. | Observation schema migration plan and fixtures. |
| RB-103 | How should triage control training data? | Decide kept-only defaults, discarded exclusion, failed-status exclusion, and manual override semantics for labels and distill. | Triage-bound export/distill policy and route tests. |
| RB-104 | How should capture errors be stored? | Test missing/invalid upstream key, provider 4xx, provider 5xx, malformed JSON, and timeout behavior. | Error-capture storage policy and tests. |
| RB-105 | How should capture retention actually work? | Define raw-body retention, hash-only expiry, per-namespace settings, purge jobs, and export audit. | Retention implementation spec and public copy cleanup. |
| RB-106 | What should bridge auto-synthesis persist? | Decide draft-only source, private concept/version, review state, lineage, and UI handoff. | Auto-synthesize persistence contract and tests. |
| RB-107 | What is the minimum auto-distill completion contract? | Add callback/status route, specialist state, artifact or weights URL, receipt evidence, and failure handling. | Auto-distill job lifecycle design. |
| RB-108 | How should capture inbox namespaces match CLI labels? | Share one readiness helper across inbox, labels, CLI, and auto-distill. | Namespace/readiness fixture tests. |
| RB-109 | What public threshold table should explain 4, 200, and 1,000? | Map bridge auto-synthesis, local tune watch, auto-distill, and specialist candidates. | Threshold policy and docs update. |
| RB-110 | How should savings estimates be computed? | Replace ad hoc savings math with a documented model using observed cost, traffic cadence, and replacement rate. | Savings estimator unit tests and copy guardrails. |
| RB-111 | When can local tune claim adapter improvement? | Implement adapter-aware eval or narrow tune copy to local capture and revision plumbing. | Tune eval/promotion proof plan. |
| RB-112 | What SDK helpers should expose capture export? | Add explicit capture corpus helpers separate from concept label-corpus helpers. | SDK capture API contract and tests. |
| RB-113 | Which capture/distill tests block launch? | Cover proxy namespace, discard exclusion, error capture, labels export, auto-synthesize persistence, bridge unavailable, and tune promotion. | Required capture/distill CI gate. |
| RB-114 | How should hosted capture and local tune be separated in copy? | Review capture, evolve, glossary, competitor, CLI, and docs pages for hosted-vs-local data path wording. | Copy truth matrix and rewrite queue. |

## P0/P1: Audit Observability Evidence

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-115 | What is the canonical tenant audit event schema? | Define actor, tenant, op, resource, hashes, redactions, receipt, request id, source route, and retention class. | `audit_events` schema and event contract. |
| RB-116 | How should audit opt-in and export work? | Decide default-on/default-off by plan, JSON/CSV/JSONL response shape, pagination, and auth behavior. | Audit log route spec and tests. |
| RB-117 | Which operations must write launch-blocking audit events? | Map capture, label export, auto-distill, compile, publish, run, verify, account delete, key rotation, plan change, and admin diagnostics. | Required audit writer matrix. |
| RB-118 | How should receipt issuance and verification be counted? | Separate issued, opted-out, verification success, verification failure, unavailable-secret, and drive-by checks. | Receipt telemetry schema and dashboard copy. |
| RB-119 | What request-id and error envelope should every API route use? | Add middleware, route wrappers, webhook exceptions, and response-header behavior. | Standard error contract and generated docs. |
| RB-120 | What should back `/status` uptime windows? | Pick external monitor, internal probe table, status-page static generation, and freshness SLA. | Status evidence architecture. |
| RB-121 | How are incidents declared, edited, and closed? | Define owner, severity, start/end times, customer impact, retro link, and public/private fields. | Incident model and status-page workflow. |
| RB-122 | Which `/ready` schema should status consumers rely on? | Align route fields with `status.html` rendering for label, hint, version, uptime, and optional gates. | Readiness schema fixture tests. |
| RB-123 | How should audit metadata differ from captured training corpus data? | Separate hash-only audit rows from full prompt/output observations, retention, and purge controls. | Data classification policy for audit vs capture. |
| RB-124 | Should local audit callbacks include input previews by default? | Evaluate PII risk, sink responsibility, redaction hooks, and opt-in preview settings. | Local audit preview/redaction policy. |
| RB-125 | Should admin diagnostic access be audited? | Identify sensitive diagnostic fields, actor identity, and minimal event payload. | Admin access audit events. |
| RB-126 | Which observability tests block launch? | Cover audit log export, opt-in, operation writers, request ids, receipt metrics, `/ready` schema, and status evidence. | Audit/observability CI gate. |
| RB-127 | How should public audit/status copy be labeled until controls ship? | Review audit-log, trust, status, security, healthcare, finance, and enterprise pages. | Copy downgrade queue with shipped/beta/planned labels. |

## P0/P1: Recall RAG Memory Governance

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-128 | What are the canonical recall modes? | Separate hosted qmd bridge, local BM25 RAG, artifact-bound recall, and concept memory recall. | Recall mode taxonomy and docs labels. |
| RB-129 | How should compile actually use recall chunks? | Decide whether chunks feed synthesis, eval generation, priors, verifier prompts, or package metadata. | Compile grounding contract and tests. |
| RB-130 | What is the artifact-bound recall payload for v0.1? | Choose empty slot, KOLMIDX JSON, sqlite-vec roadmap, or external namespace marker semantics. | Artifact recall conformance matrix. |
| RB-131 | How should `kolm compile --data` work for hosted SaaS? | Compare upload/archive, self-hosted mounted paths, local spec compile, and failure behavior. | CLI data-path contract and user-facing errors. |
| RB-132 | How should local `kolm rag attach` integrate with runtime? | Wire `.rag.json` sidecar loading, `lib.rag.query`, signing implications, and missing-index errors. | Local RAG runtime integration plan. |
| RB-133 | How should `/v1/recall/sources` be hardened? | Test traversal, sibling-prefix paths, absolute path leakage, preview size, and audit events. | Source preview security patch plan. |
| RB-134 | What deletion and retention controls does recall need? | Define namespace delete, sidecar cleanup, qmd collection delete, local index remove, and retention policy. | Recall lifecycle controls. |
| RB-135 | How should qmd availability appear to users? | Distinguish unavailable backend, empty index, empty result, and degraded multimodal tokenization. | Recall health/error contract. |
| RB-136 | Which multimodal claims are actually shipped? | Inventory text, code, PDF, image, audio, video behavior with and without optional dependencies. | Recall capability table and copy queue. |
| RB-137 | Which tests block recall launch? | Cover `/v1/embed`, `/v1/recall`, status, qmd unavailable, compile grounding, local RAG index/query/attach, and artifact runner `lib.rag`. | Recall CI gate. |
| RB-138 | Should `/v1/memory/recall` be renamed? | Compare route name to behavior: registry search plus concept runs, not corpus recall. | Route naming/deprecation decision. |
| RB-139 | How should local RAG indexes protect sensitive paths and previews? | Evaluate absolute path storage, previews, permissions, redaction, and optional encrypted local storage. | Local RAG privacy policy and flags. |
| RB-140 | Which public pages need recall claim downgrades? | Review recall, API, docs, whitepaper, security, vs-rag, vs-openpipe, vs-predibase, and vs-ollama pages. | Recall claim cleanup queue. |

## P0/P1: Device Offline Browser Governance

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-154 | What is the minimum browser runtime contract for `/device`? | Decide whether launch proof is browser demo, local CLI artifact, native runtime, or all three. | Browser/runtime claim policy. |
| RB-155 | How did ternary corruption enter browser assets? | Diff generation/transformation steps for `sdk.js`, `recipe-worker.js`, and `device.html` around `? :` expressions. | Root-cause fix and regression test. |
| RB-156 | Which browser assets must syntax-check before deploy? | Add checks for `sdk.js`, `sdk-*.js`, `recipe-worker.js`, extracted module scripts, and generated current SDK manifests. | Browser asset CI gate. |
| RB-157 | What should `scripts/build-sdk-version.js` refuse to stamp? | Run syntax, import, and browser smoke checks before writing `sdk-current.json`. | Safe SDK versioning release step. |
| RB-158 | What is the exact offline cache contract? | Compare cache-first, network-first, stale-revalidate, manual sync, and signed registry snapshots. | Offline cache policy and service-worker tests. |
| RB-159 | Which dependencies must the `/device` PWA precache? | Enumerate `/device` HTML dependencies, worker scripts, CSS, manifest, icons, and registry payload. | Complete PWA precache manifest. |
| RB-160 | Should `/device` use a dedicated manifest? | Verify installed app start target, scope, icons, offline shell, and app-store-like title. | Device PWA manifest decision. |
| RB-161 | How should browser registry bundles be signed? | Compare source hash only, HMAC envelope, public-key signature, revocation list, and epoch root. | Browser registry trust-envelope spec. |
| RB-162 | What is the signed browser run receipt format? | Compare local SDK metadata, API `rs-1` receipts, artifact `receipt.json`, and offline verifier needs. | Browser receipt v0 spec and verifier. |
| RB-163 | Can the browser worker be a trusted sandbox tier? | Test malicious recipe attempts for fetch, indexedDB, caches, importScripts, globals, timing, and CPU loops. | Browser sandbox threat model and fixtures. |
| RB-164 | Should main-thread `new Function` fallback exist for public registry rows? | Test no-Worker browsers, unsafe mode, and source trust policy. | Public-source execution policy. |
| RB-165 | Which runtimes does the browser SDK actually support? | Smoke browser, Node, Deno, Bun, and Cloudflare Worker usage or split packages. | Runtime support matrix. |
| RB-166 | Which public pages need revised on-device/offline wording? | Review `/device`, security, healthcare article, whitepaper, docs, and homepage after browser proof is fixed or narrowed. | Copy rewrite queue tied to proof links. |

## P0/P1: Agent MCP Install Governance

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-141 | What is the canonical MCP transport contract? | Compare stdio, localhost HTTP JSON-RPC, claimed SSE, port defaults, and client config examples. | MCP transport spec and generated docs. |
| RB-142 | Should `kolm serve --mcp <artifact>` be implemented or removed from docs? | Test positional artifact args, global artifact discovery, project globs, and exposure blast radius. | Single-artifact serve decision and CLI/doc update. |
| RB-143 | How should MCP runtime egress be enforced? | Move or duplicate benchmark egress monitor into `runArtifact` or define a narrower artifact trust tier. | Runtime egress policy and malicious fixture tests. |
| RB-144 | What is the signed local-run receipt format? | Compare artifact receipt, API run receipt, current `rs-1-run`, and MCP `_kolm` trailer needs. | Local per-call receipt spec and verifier fixture. |
| RB-145 | How should K-score normalization gate MCP discovery? | Rebuild fixtures or migrate score schema, then test `k_min` with pass/fail artifacts. | Normalized K-score serve gate. |
| RB-146 | Which harness config paths are canonical? | Separate Claude Desktop, Claude Code, Cursor, Continue, and Cline targets and verify on current clients. | Harness install matrix and installer tests. |
| RB-147 | What should `kolm doctor` verify for agent wiring? | Inspect generated config files, command availability, MCP initialize/list smoke, and port listeners. | Doctor MCP checks and troubleshooting output. |
| RB-148 | How should generated skill sidecars name tools? | Compare global tools, project-prefixed tools, sidecar frontmatter, and harness indexing behavior. | Sidecar naming fixture test. |
| RB-149 | What happens to MCP run logs and audit events? | Add MCP call rows to local `runs.jsonl` and decide tenant-visible audit payload. | MCP log/audit contract and tests. |
| RB-150 | Should `sdk/mcp` remain a legacy cloud MCP package? | Compare `recipe_*` tools, package naming, public docs, and artifact MCP server. | MCP package consolidation or deprecation plan. |
| RB-151 | How should agent templates stay command-accurate? | Parse Claude/Cursor templates for CLI commands and test against `kolm help` dispatch. | Template command snapshot tests. |
| RB-152 | Which shipped integrations need proof before "shipped" labels? | Smoke GitHub Action, VS Code extension, package-manager installs, SDK MCP, and harness install. | Integration status matrix and label policy. |
| RB-153 | Which MCP/install tests block launch? | Cover stdio, HTTP, invalid artifacts, install snippets, doctor checks, logs, `k_min`, and public docs commands. | Required agent integration CI gate. |

## P0: Competitor Depth

## P0: Claim Governance Follow-Up

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-005 | Which public pages fail the current forbidden-claim policy? | Run `tests/site.test.js` after isolating unrelated dirty public edits, then map each failure to a claim-audit row. | Claim cleanup task list. |
| RB-006 | Do live pages match the local repo after deployment? | Fetch key `kolm.ai` URLs and run the forbidden-pattern set from `tests/site.test.js`. | Live claim smoke report. |
| RB-007 | Which artifact claims have direct proof links? | For every page saying model, LoRA, phone, VPC, offline, or public-key receipt, identify a reproducible artifact/benchmark or mark as roadmap. | Proof-link matrix. |

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-010 | Which competitors already offer trace-to-cheaper-model or trace-to-function replacement? | Deep review of OpenPipe, Predibase, Braintrust, Langfuse, Helicone, Portkey, LiteLLM. | Direct-wedge competitor memo. |
| RB-011 | Which gateways can accept a custom artifact-first route today? | Prototype or docs review for LiteLLM, Vercel AI SDK, Cloudflare Workers, Portkey. | Integration priority matrix with implementation steps. |
| RB-012 | Which eval platforms can export datasets/traces in a format Kolm can ingest? | LangSmith, Langfuse, Braintrust, Phoenix, Weave, Helicone export docs. | Importer spec and sample fixtures. |
| RB-013 | Which competitor evidence rows have a working Kolm import path? | Use `competitor-evidence-matrix-2026-05-12.csv` to pick one gateway, one eval platform, and one prompt registry, then build fixtures. | Importer proof matrix. |
| RB-014 | Which competitor claims directly conflict with Kolm public copy? | Compare competitor matrix against `claim-audit-2026-05-12.csv` and current local pages. | Copy-risk diff and rewrite queue. |

## P1: Benchmarks And Runtime Targets

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-020 | What is the real recipe-tier performance on laptop/server? | Local benchmarks with 5 workloads, p50/p95, artifact size, receipt overhead. | Benchmark report and `/benchmarks` update. |
| RB-021 | What is the simplest local runtime target for a real model-bearing artifact? | Evaluate ONNX Runtime, llama.cpp/GGUF, LiteRT, Core ML, ExecuTorch bridge paths. | Runtime target decision memo. |
| RB-022 | What does "phone support" actually mean for v1? | iOS, Android, PWA/web target matrix with unsupported cases. | Platform support table for docs/site. |

## P1: Trust, Security, And Compliance

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-030 | What is the strongest near-term recipe sandbox? | Compare isolated-vm, QuickJS, WASM/Wasmtime, Firecracker, worker isolation. | Sandbox decision and malicious test plan. |
| RB-031 | What receipt signing architecture should ship first? | Compare Ed25519 local keys, KMS/HSM, Sigstore/Rekor, tenant keys, key rotation. | Receipt v0.2 spec and migration plan. |
| RB-032 | What compliance evidence can Kolm honestly claim in Q2 2026? | DPA/BAA/subprocessor/security controls/current limitations. | Compliance posture page and sales one-pager. |
| RB-033 | What artifact trust levels should gate recipe execution? | Define trusted, curated, customer-private, and public-untrusted recipe policies. | Artifact trust-level schema and execution policy. |
| RB-034 | Can Kolm compile the current fixture recipes to a WASM-safe target? | Try a minimal WASM or DSL translation for sample/redactor/classifier recipes. | WASM recipe proof of concept. |

## P1: GTM And Buyer Proof

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-040 | Which first ICP has the fastest proof loop: AI-native SaaS, healthcare, fintech, defense, legal, or edge robotics? | Interview plan, buyer objections, pilot success metrics, willingness to pay. | ICP scorecard and design-partner list. |
| RB-041 | What pilot offer is clear enough to sell in one email? | Competitor pilot offers, Kolm proof assets, price/terms. | One-page design-partner offer. |
| RB-042 | What is the best public artifact pack for credibility? | Choose 8-12 tasks with evals, receipts, and live demos. | Seed registry plan. |

## P2: Pricing And Packaging

| ID | Question | Evidence Needed | Output |
| --- | --- | --- | --- |
| RB-050 | Which pricing model avoids charging for local runtime while monetizing governance? | Compare competitor pricing and Kolm value units: compile, registry, receipt retention, org controls. | Pricing model memo and site copy update. |
| RB-051 | How should public/private registry SKUs work? | Enterprise package managers, model registries, compliance retention analogs. | Registry SKU spec. |
| RB-052 | What is the first paid unit Kolm should test? | Price-sensitivity interviews around compile jobs, accepted artifacts, receipt retention, registry artifact-months, and org seats. | Pilot pricing scorecard. |
| RB-053 | What proof is required before savings claims are priced? | Capture-to-artifact benchmark that measures avoided model calls and retained receipt evidence. | Savings claim proof protocol. |

## Research Operating Cadence

| Cadence | Work |
| --- | --- |
| Daily during launch sprint | Update `critical-insights.csv` for any claim/product gap discovered. |
| Weekly | Refresh top 10 competitor changes, ship one source-backed memo, close or advance backlog rows. |
| Monthly | Re-score competitor matrix, pricing, benchmarks, and regulatory source notes. |
| Before public claims | Verify with live code, live page, source link, and reproducible command. |
